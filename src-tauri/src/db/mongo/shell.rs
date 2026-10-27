//! The mongosh-style query language of Mongo query tabs: `db.users.find({ plan: "pro" }).limit(10)`,
//! `show collections`, `use shop`. Arguments are JavaScript literals (unquoted keys, single
//! quotes, trailing commas, `ObjectId("…")`, `ISODate("…")`, `/regex/i`), parsed into BSON.

use std::str::FromStr;

use bson::oid::ObjectId;
use bson::{Bson, Decimal128, Document, Regex, Timestamp};

use crate::error::{AppError, Result};

#[derive(Debug, Clone, PartialEq)]
pub enum Statement {
    ShowDatabases,
    ShowCollections,
    Use(String),
    /// `db.runCommand({...})`, `db.getCollectionNames()`, …
    Db { method: String, args: Vec<Bson> },
    /// `db.<collection>.<method>(args).<chained>(args)…`
    Collection { name: String, method: String, args: Vec<Bson>, chain: Vec<(String, Vec<Bson>)> },
}

/// Every statement in the text, in order.
pub fn parse(text: &str) -> Result<Vec<Statement>> {
    let mut p = Parser { chars: text.chars().collect(), i: 0 };
    let mut statements = Vec::new();
    loop {
        p.skip_space();
        while p.eat(';') {
            p.skip_space();
        }
        if p.done() {
            return Ok(statements);
        }
        statements.push(p.statement()?);
    }
}

struct Parser {
    chars: Vec<char>,
    i: usize,
}

fn error(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

impl Parser {
    fn done(&self) -> bool {
        self.i >= self.chars.len()
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.i).copied()
    }

    fn eat(&mut self, c: char) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, c: char) -> Result<()> {
        self.skip_space();
        if self.eat(c) {
            Ok(())
        } else {
            Err(error(format!("Expected `{c}` {}", self.at())))
        }
    }

    /// "at line 3: …" for error messages.
    fn at(&self) -> String {
        let line = self.chars[..self.i.min(self.chars.len())].iter().filter(|&&c| c == '\n').count() + 1;
        let rest: String = self.chars[self.i.min(self.chars.len())..].iter().take(24).collect();
        if rest.is_empty() {
            format!("at the end (line {line})")
        } else {
            format!("at line {line}, near `{}`", rest.trim_end())
        }
    }

    /// Whitespace and comments.
    fn skip_space(&mut self) {
        loop {
            match self.peek() {
                Some(c) if c.is_whitespace() => self.i += 1,
                Some('/') if self.chars.get(self.i + 1) == Some(&'/') => {
                    while self.peek().is_some_and(|c| c != '\n') {
                        self.i += 1;
                    }
                }
                Some('#') => {
                    while self.peek().is_some_and(|c| c != '\n') {
                        self.i += 1;
                    }
                }
                Some('/') if self.chars.get(self.i + 1) == Some(&'*') => {
                    self.i += 2;
                    while !self.done() && !(self.peek() == Some('*') && self.chars.get(self.i + 1) == Some(&'/')) {
                        self.i += 1;
                    }
                    self.i += 2;
                }
                _ => return,
            }
        }
    }

    fn ident(&mut self) -> Option<String> {
        let start = self.i;
        if !self.peek().is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$') {
            return None;
        }
        while self.peek().is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$') {
            self.i += 1;
        }
        Some(self.chars[start..self.i].iter().collect())
    }

    fn statement(&mut self) -> Result<Statement> {
        let start = self.i;
        let word = self.ident().ok_or_else(|| error(format!("Expected a statement like db.users.find() {}", self.at())))?;
        match word.as_str() {
            "show" => {
                self.skip_inline_space();
                return match self.ident().as_deref() {
                    Some("dbs" | "databases") => Ok(Statement::ShowDatabases),
                    Some("collections" | "tables") => Ok(Statement::ShowCollections),
                    _ => Err(error("Use `show dbs` or `show collections`")),
                };
            }
            "use" => {
                self.skip_inline_space();
                let start = self.i;
                while self.peek().is_some_and(|c| !c.is_whitespace() && c != ';') {
                    self.i += 1;
                }
                let name: String = self.chars[start..self.i].iter().collect();
                return if name.is_empty() { Err(error("`use` needs a database name")) } else { Ok(Statement::Use(name)) };
            }
            "db" => {}
            _ => {
                self.i = start;
                return Err(error(format!("Statements start with db., show or use {}", self.at())));
            }
        }

        // Members up to the first call: db.<collection…>.<method>( or db.<method>(
        let mut members: Vec<String> = Vec::new();
        let mut collection: Option<String> = None;
        loop {
            self.skip_space();
            if self.eat('.') {
                self.skip_space();
                members.push(self.ident().ok_or_else(|| error(format!("Expected a name after `.` {}", self.at())))?);
            } else if self.eat('[') {
                self.skip_space();
                let Bson::String(name) = self.value()? else { return Err(error("db[…] takes a collection name in quotes")) };
                self.expect(']')?;
                collection = Some(name);
            } else if self.peek() == Some('(') {
                break;
            } else {
                return Err(error(format!("Expected a method call like .find() {}", self.at())));
            }
        }
        let method = members.pop().ok_or_else(|| error(format!("Expected a method {}", self.at())))?;
        let args = self.call_args()?;

        let (name, method, args) = match (collection, members.is_empty()) {
            (Some(name), true) => (name, method, args),
            (Some(_), false) => return Err(error("Use db[\"collection\"].method()")),
            (None, false) => (members.join("."), method, args),
            (None, true) if method == "getCollection" => {
                let Some(Bson::String(name)) = args.into_iter().next() else { return Err(error("getCollection takes a name in quotes")) };
                self.expect('.')?;
                self.skip_space();
                let method = self.ident().ok_or_else(|| error(format!("Expected a method {}", self.at())))?;
                let args = self.call_args()?;
                (name, method, args)
            }
            (None, true) => return Ok(Statement::Db { method, args }),
        };

        let mut chain = Vec::new();
        loop {
            let save = self.i;
            self.skip_space();
            if !self.eat('.') {
                self.i = save;
                break;
            }
            self.skip_space();
            let name = self.ident().ok_or_else(|| error(format!("Expected a method after `.` {}", self.at())))?;
            chain.push((name, self.call_args()?));
        }
        Ok(Statement::Collection { name, method, args, chain })
    }

    fn skip_inline_space(&mut self) {
        while self.peek().is_some_and(|c| c == ' ' || c == '\t') {
            self.i += 1;
        }
    }

    fn call_args(&mut self) -> Result<Vec<Bson>> {
        self.expect('(')?;
        self.list(')')
    }

    /// Comma-separated values up to `close` (trailing comma allowed).
    fn list(&mut self, close: char) -> Result<Vec<Bson>> {
        let mut values = Vec::new();
        loop {
            self.skip_space();
            if self.eat(close) {
                return Ok(values);
            }
            values.push(self.value()?);
            self.skip_space();
            if !self.eat(',') {
                self.expect(close)?;
                return Ok(values);
            }
        }
    }

    pub fn value(&mut self) -> Result<Bson> {
        self.skip_space();
        match self.peek() {
            None => Err(error("Expected a value at the end")),
            Some('{') => {
                self.i += 1;
                self.document().map(extended_json)
            }
            Some('[') => {
                self.i += 1;
                self.list(']').map(Bson::Array)
            }
            Some('"' | '\'' | '`') => self.string().map(Bson::String),
            Some('/') => self.regex(),
            Some(c) if c.is_ascii_digit() || c == '-' || c == '+' || c == '.' => self.number(),
            Some(_) => {
                let start = self.i;
                let Some(mut word) = self.ident() else { return Err(error(format!("Unexpected `{}` {}", self.peek().unwrap(), self.at()))) };
                if word == "new" {
                    self.skip_space();
                    word = self.ident().ok_or_else(|| error(format!("Expected a type after `new` {}", self.at())))?;
                }
                match word.as_str() {
                    "true" => Ok(Bson::Boolean(true)),
                    "false" => Ok(Bson::Boolean(false)),
                    "null" | "undefined" => Ok(Bson::Null),
                    "Infinity" => Ok(Bson::Double(f64::INFINITY)),
                    "NaN" => Ok(Bson::Double(f64::NAN)),
                    "MinKey" | "MaxKey" => {
                        self.optional_call()?;
                        Ok(if word == "MinKey" { Bson::MinKey } else { Bson::MaxKey })
                    }
                    _ => {
                        self.skip_space();
                        if self.peek() != Some('(') {
                            self.i = start;
                            return Err(error(format!("Unknown name `{word}` {} (quote strings)", self.at())));
                        }
                        let args = self.call_args()?;
                        constructor(&word, args)
                    }
                }
            }
        }
    }

    fn optional_call(&mut self) -> Result<()> {
        self.skip_space();
        if self.peek() == Some('(') {
            self.call_args()?;
        }
        Ok(())
    }

    fn document(&mut self) -> Result<Document> {
        let mut doc = Document::new();
        loop {
            self.skip_space();
            if self.eat('}') {
                return Ok(doc);
            }
            let key = match self.peek() {
                Some('"' | '\'' | '`') => self.string()?,
                Some(c) if c.is_ascii_digit() => {
                    let start = self.i;
                    while self.peek().is_some_and(|c| c.is_ascii_alphanumeric() || c == '.') {
                        self.i += 1;
                    }
                    self.chars[start..self.i].iter().collect()
                }
                _ => {
                    // Unquoted keys, dotted paths included (`address.city: "Pune"` isn't JS, but is handy).
                    let mut key = self.ident().ok_or_else(|| error(format!("Expected a key {}", self.at())))?;
                    while self.peek() == Some('.') {
                        self.i += 1;
                        key.push('.');
                        key += &self.ident().ok_or_else(|| error(format!("Expected a key {}", self.at())))?;
                    }
                    key
                }
            };
            self.expect(':')?;
            let value = self.value()?;
            doc.insert(key, value);
            self.skip_space();
            if !self.eat(',') {
                self.expect('}')?;
                return Ok(doc);
            }
        }
    }

    fn string(&mut self) -> Result<String> {
        let quote = self.peek().unwrap();
        self.i += 1;
        let mut out = String::new();
        loop {
            let Some(c) = self.peek() else { return Err(error("Unterminated string")) };
            self.i += 1;
            match c {
                c if c == quote => return Ok(out),
                '\\' => {
                    let Some(e) = self.peek() else { return Err(error("Unterminated string")) };
                    self.i += 1;
                    match e {
                        'n' => out.push('\n'),
                        't' => out.push('\t'),
                        'r' => out.push('\r'),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        '0' => out.push('\0'),
                        'u' => {
                            let hex: String = self.chars.get(self.i..self.i + 4).unwrap_or_default().iter().collect();
                            let code = u32::from_str_radix(&hex, 16).map_err(|_| error("Bad \\u escape"))?;
                            self.i += 4;
                            out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                        }
                        '\n' => {}
                        other => out.push(other),
                    }
                }
                c => out.push(c),
            }
        }
    }

    fn regex(&mut self) -> Result<Bson> {
        self.i += 1;
        let mut pattern = String::new();
        let mut in_class = false;
        loop {
            let Some(c) = self.peek() else { return Err(error("Unterminated /regex/")) };
            self.i += 1;
            match c {
                '\\' => {
                    pattern.push(c);
                    if let Some(next) = self.peek() {
                        pattern.push(next);
                        self.i += 1;
                    }
                }
                '[' => {
                    in_class = true;
                    pattern.push(c);
                }
                ']' => {
                    in_class = false;
                    pattern.push(c);
                }
                '/' if !in_class => break,
                c => pattern.push(c),
            }
        }
        let start = self.i;
        while self.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
            self.i += 1;
        }
        let flags: String = self.chars[start..self.i].iter().collect();
        regex(&pattern, &flags)
    }

    fn number(&mut self) -> Result<Bson> {
        let start = self.i;
        if matches!(self.peek(), Some('-' | '+')) {
            self.i += 1;
        }
        while self.peek().is_some_and(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_') {
            // An exponent's sign.
            if matches!(self.peek(), Some('e' | 'E')) && matches!(self.chars.get(self.i + 1), Some('-' | '+')) {
                self.i += 1;
            }
            self.i += 1;
        }
        let text: String = self.chars[start..self.i].iter().filter(|&&c| c != '_').collect();
        number(&text).ok_or_else(|| error(format!("`{text}` isn't a number")))
    }
}

/// Extended JSON wrappers (`{"$oid": "…"}`, `{"$date": …}`, `{"$numberLong": "…"}`…), as the document
/// view shows values, become the BSON values they stand for, so an edited document saves back as it was.
fn extended_json(doc: Document) -> Bson {
    const WRAPPERS: [&str; 12] = [
        "$oid", "$date", "$numberLong", "$numberInt", "$numberDouble", "$numberDecimal", "$binary", "$uuid", "$regularExpression", "$timestamp",
        "$minKey", "$maxKey",
    ];
    let wrapper = doc.len() <= 2 && doc.keys().next().is_some_and(|k| WRAPPERS.contains(&k.as_str()));
    if !wrapper {
        return Bson::Document(doc);
    }
    let json = Bson::Document(doc.clone()).into_relaxed_extjson();
    Bson::try_from(json).unwrap_or(Bson::Document(doc))
}

/// Integers in the 32-bit range are Int32 (as mongosh stores them), larger ones Int64, the rest Double.
fn number(text: &str) -> Option<Bson> {
    let unsigned = text.trim_start_matches(['-', '+']);
    if let Some(hex) = unsigned.strip_prefix("0x").or_else(|| unsigned.strip_prefix("0X")) {
        let n = i64::from_str_radix(hex, 16).ok()?;
        return Some(int(if text.starts_with('-') { -n } else { n }));
    }
    if let Ok(n) = text.parse::<i64>() {
        return Some(int(n));
    }
    text.parse::<f64>().ok().map(Bson::Double)
}

fn int(n: i64) -> Bson {
    i32::try_from(n).map(Bson::Int32).unwrap_or(Bson::Int64(n))
}

fn regex(pattern: &str, flags: &str) -> Result<Bson> {
    let mut options: Vec<char> = flags.chars().filter(|c| "imsux".contains(*c)).collect();
    options.sort_unstable();
    Ok(Bson::RegularExpression(Regex {
        pattern: pattern.to_owned().try_into().map_err(|_| error("Regex can't contain a NUL character"))?,
        options: options.into_iter().collect::<String>().try_into().map_err(|_| error("Bad regex flags"))?,
    }))
}

fn string_arg(name: &str, args: &[Bson]) -> Result<String> {
    match args.first() {
        Some(Bson::String(s)) => Ok(s.clone()),
        Some(other) => Ok(other.to_string()),
        None => Err(error(format!("{name}() needs a value"))),
    }
}

/// ObjectId("…"), ISODate("…"), NumberLong(…) and the other shell constructors.
fn constructor(name: &str, args: Vec<Bson>) -> Result<Bson> {
    Ok(match name {
        "ObjectId" | "ObjectID" => match args.first() {
            None => Bson::ObjectId(ObjectId::new()),
            Some(_) => Bson::ObjectId(ObjectId::parse_str(string_arg(name, &args)?).map_err(|e| error(format!("ObjectId: {e}")))?),
        },
        "ISODate" | "Date" => match args.first() {
            None => Bson::DateTime(bson::DateTime::now()),
            Some(Bson::String(s)) => Bson::DateTime(parse_date(s)?),
            Some(Bson::Int32(n)) => Bson::DateTime(bson::DateTime::from_millis(*n as i64)),
            Some(Bson::Int64(n)) => Bson::DateTime(bson::DateTime::from_millis(*n)),
            Some(Bson::Double(n)) => Bson::DateTime(bson::DateTime::from_millis(*n as i64)),
            Some(other) => return Err(error(format!("{name}({other}) isn't a date"))),
        },
        "NumberLong" | "Long" => {
            let s = string_arg(name, &args)?;
            let s = s.trim();
            // Exact digits first: a float would round past 2^53.
            Bson::Int64(s.parse().ok().or_else(|| s.parse::<f64>().ok().filter(|f| f.fract() == 0.0).map(|f| f as i64)).ok_or_else(|| error(format!("NumberLong({s})")))?)
        }
        "NumberInt" | "Int32" => {
            let s = string_arg(name, &args)?;
            Bson::Int32(s.trim().parse::<f64>().map(|f| f as i32).map_err(|_| error(format!("NumberInt({s})")))?)
        }
        "Double" => Bson::Double(string_arg(name, &args)?.trim().parse().map_err(|_| error("Double() needs a number"))?),
        "NumberDecimal" | "Decimal128" => {
            let s = string_arg(name, &args)?;
            Bson::Decimal128(Decimal128::from_str(s.trim()).map_err(|_| error(format!("NumberDecimal({s})")))?)
        }
        "UUID" => {
            let s = string_arg(name, &args)?;
            Bson::from(bson::Uuid::parse_str(s.trim()).map_err(|e| error(format!("UUID: {e}")))?)
        }
        "Timestamp" => {
            let n = |i: usize| match args.get(i) {
                Some(Bson::Int32(n)) => *n as u32,
                Some(Bson::Int64(n)) => *n as u32,
                Some(Bson::Double(n)) => *n as u32,
                _ => 0,
            };
            Bson::Timestamp(Timestamp { time: n(0), increment: n(1) })
        }
        "RegExp" => {
            let pattern = string_arg(name, &args)?;
            let flags = match args.get(1) {
                Some(Bson::String(f)) => f.clone(),
                _ => String::new(),
            };
            regex(&pattern, &flags)?
        }
        _ => return Err(error(format!("Unknown constructor {name}()"))),
    })
}

/// ISO dates with or without a time or zone: "2026-10-01", "2026-10-01T10:00:00", "…Z", "…+05:30".
fn parse_date(s: &str) -> Result<bson::DateTime> {
    let s = s.trim();
    let candidates = [
        s.to_owned(),
        format!("{s}Z"),
        format!("{s}T00:00:00Z"),
        format!("{}Z", s.replacen(' ', "T", 1)),
        s.replacen(' ', "T", 1),
    ];
    candidates
        .iter()
        .find_map(|c| bson::DateTime::parse_rfc3339_str(c).ok())
        .ok_or_else(|| error(format!("ISODate(\"{s}\") isn't an ISO date")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    fn one(text: &str) -> Statement {
        let mut all = parse(text).unwrap();
        assert_eq!(all.len(), 1, "{all:?}");
        all.remove(0)
    }

    #[test]
    fn parses_shell_literals() {
        let Statement::Collection { name, method, args, chain } = one(
            "db.users.find({ plan: 'pro', \"age\": { $gte: 21, $lt: 3000000000 }, score: 1.5, tags: ['a', \"b\",], ok: true, gone: null,
               _id: ObjectId(\"65f1a2b3c4d5e6f708192a3b\"), at: ISODate('2026-10-01'), re: /^ann/i, n: NumberLong(\"9007199254740993\"),
               d: NumberDecimal('1.10'), // a comment
               'address.city': 'Pune', nested: { deep: { x: -2 } } }, { name: 1 })
             .sort({ age: -1 })
             .limit(10)",
        ) else {
            panic!()
        };
        assert_eq!((name.as_str(), method.as_str()), ("users", "find"));
        let filter = args[0].as_document().unwrap();
        assert_eq!(filter.get("plan"), Some(&Bson::String("pro".into())));
        assert_eq!(filter.get_document("age").unwrap(), &doc! { "$gte": 21, "$lt": 3_000_000_000_i64 });
        assert_eq!(filter.get("score"), Some(&Bson::Double(1.5)));
        assert_eq!(filter.get("tags"), Some(&Bson::Array(vec!["a".into(), "b".into()])));
        assert_eq!(filter.get("gone"), Some(&Bson::Null));
        assert!(matches!(filter.get("_id"), Some(Bson::ObjectId(_))));
        assert_eq!(filter.get("at").unwrap().as_datetime().unwrap().timestamp_millis(), 1_790_812_800_000);
        assert_eq!(filter.get("re").unwrap().to_string(), "/^ann/i");
        assert_eq!(filter.get("n"), Some(&Bson::Int64(9_007_199_254_740_993)));
        assert_eq!(filter.get("d").unwrap().to_string(), "1.10");
        assert_eq!(filter.get("address.city"), Some(&Bson::String("Pune".into())));
        assert_eq!(filter.get_document("nested").unwrap(), &doc! { "deep": { "x": -2 } });
        assert_eq!(args[1], Bson::Document(doc! { "name": 1 }));
        assert_eq!(chain, [("sort".into(), vec![Bson::Document(doc! { "age": -1 })]), ("limit".into(), vec![Bson::Int32(10)])]);
    }

    #[test]
    fn parses_statement_forms() {
        let all = parse("show dbs\nuse shop;\nshow collections\ndb.getCollection('weird name').countDocuments({})\ndb['a-b'].drop()\ndb.system.profile.find()\ndb.runCommand({ ping: 1 })").unwrap();
        assert_eq!(all[0], Statement::ShowDatabases);
        assert_eq!(all[1], Statement::Use("shop".into()));
        assert_eq!(all[2], Statement::ShowCollections);
        assert!(matches!(&all[3], Statement::Collection { name, method, .. } if name == "weird name" && method == "countDocuments"));
        assert!(matches!(&all[4], Statement::Collection { name, method, .. } if name == "a-b" && method == "drop"));
        assert!(matches!(&all[5], Statement::Collection { name, method, .. } if name == "system.profile" && method == "find"));
        assert!(matches!(&all[6], Statement::Db { method, args } if method == "runCommand" && args[0] == Bson::Document(doc! { "ping": 1 })));
        // Two statements on one line, a pipeline across lines.
        assert_eq!(parse("db.a.find(); db.b.find()").unwrap().len(), 2);
        let pipeline = one("db.orders.aggregate([\n  { $match: { status: 'paid' } },\n  { $group: { _id: '$user', total: { $sum: '$amount' } } },\n])");
        assert!(matches!(pipeline, Statement::Collection { args, .. } if args[0].as_array().unwrap().len() == 2));
    }

    #[test]
    fn reads_extended_json() {
        let Statement::Collection { args, .. } = one(r#"db.users.replaceOne({ "_id": { "$oid": "65f1a2b3c4d5e6f708192a3b" } }, { "n": { "$numberLong": "9007199254740993" }, "at": { "$date": "2026-10-01T00:00:00Z" }, "plain": { "a": 1 } })"#) else {
            panic!()
        };
        assert!(matches!(args[0].as_document().unwrap().get("_id"), Some(Bson::ObjectId(_))));
        let d = args[1].as_document().unwrap();
        assert_eq!(d.get("n"), Some(&Bson::Int64(9_007_199_254_740_993)));
        assert!(matches!(d.get("at"), Some(Bson::DateTime(_))));
        assert_eq!(d.get_document("plain").unwrap(), &doc! { "a": 1 });
    }

    #[test]
    fn explains_mistakes() {
        assert!(parse("SELECT * FROM users").unwrap_err().to_string().contains("db."));
        assert!(parse("db.users.find({ plan: pro })").unwrap_err().to_string().contains("pro"));
        assert!(parse("db.users.find({ a: 1 ").is_err());
        assert!(parse("db.users.find({ a: 'x })").is_err());
    }
}
