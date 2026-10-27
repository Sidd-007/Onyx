//! Logical SQL debugging (PostgreSQL, a documented subset): F19 stage counts, F01 "why is this
//! row missing", F05 "which rows made this aggregate". One analysis of the query feeds all
//! three, and every diagnostic runs in one REPEATABLE READ READ ONLY transaction, so the
//! stages see the same snapshot and nothing can be written.
//!
//! Supported: one SELECT over a table with INNER / LEFT joins (ON), WHERE, GROUP BY, HAVING,
//! ORDER BY, LIMIT / OFFSET. Anything else is reported as a specific limitation.

use serde::Serialize;
use sqlparser::ast::{
    BinaryOperator, DuplicateTreatment, Expr, FunctionArg, FunctionArgExpr, FunctionArguments, GroupByExpr, JoinConstraint, JoinOperator, LimitClause, OrderByKind, SelectItem, SetExpr, Statement,
    TableFactor,
};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;

use crate::connections::Engine;
use crate::db::Session;
use crate::dialect::{ident, literal};
use crate::error::{AppError, Result};
use crate::journal::collect;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub alias: String,
    pub schema: Option<String>,
    pub table: String,
    /// Primary key columns (filled from the catalog).
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinInfo {
    pub left: bool,
    pub source: Source,
    pub on: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agg {
    /// The output column's name.
    pub output: String,
    pub func: String,
    pub arg: Option<String>,
    pub distinct: bool,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub base: Source,
    pub joins: Vec<JoinInfo>,
    pub filters: Vec<String>,
    pub group_by: Vec<String>,
    pub having: Option<String>,
    /// (output name, expression).
    pub projection: Vec<(String, String)>,
    pub aggregates: Vec<Agg>,
    pub order_by: Vec<String>,
    pub limit: Option<String>,
    pub offset: Option<String>,
    /// The query without ORDER BY / LIMIT / OFFSET (for counting every output row).
    pub unlimited: String,
    pub notes: Vec<String>,
}

fn source(f: &TableFactor) -> std::result::Result<Source, String> {
    match f {
        TableFactor::Table { name, alias, args: None, .. } => {
            let parts: Vec<String> = name.0.iter().filter_map(|p| p.as_ident()).map(|i| i.value.clone()).collect();
            let (schema, table) = match parts.as_slice() {
                [t] => (None, t.clone()),
                [s, t] => (Some(s.clone()), t.clone()),
                _ => return Err(format!("table name {name}")),
            };
            Ok(Source { alias: alias.as_ref().map(|a| a.name.value.clone()).unwrap_or_else(|| table.clone()), schema, table, keys: vec![] })
        }
        TableFactor::Table { .. } => Err("a function in FROM".into()),
        TableFactor::Derived { .. } => Err("a subquery in FROM".into()),
        other => Err(format!("{} in FROM", other.to_string().split_whitespace().next().unwrap_or("this"))),
    }
}

fn conjuncts(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::BinaryOp { left, op: BinaryOperator::And, right } => {
            conjuncts(left, out);
            conjuncts(right, out);
        }
        Expr::Nested(inner) if matches!(**inner, Expr::BinaryOp { op: BinaryOperator::And, .. }) => conjuncts(inner, out),
        other => out.push(other.to_string()),
    }
}

fn output_name(e: &Expr) -> String {
    match e {
        Expr::Identifier(i) => i.value.clone(),
        Expr::CompoundIdentifier(parts) => parts.last().map(|i| i.value.clone()).unwrap_or_default(),
        Expr::Function(f) => f.name.0.last().and_then(|p| p.as_ident()).map(|i| i.value.to_lowercase()).unwrap_or_default(),
        _ => "?column?".into(),
    }
}

const AGGS: [&str; 5] = ["count", "sum", "avg", "min", "max"];

fn aggregate(output: &str, e: &Expr) -> Option<Agg> {
    let Expr::Function(f) = e else { return None };
    let func = f.name.0.last()?.as_ident()?.value.to_lowercase();
    if !AGGS.contains(&func.as_str()) || f.over.is_some() || f.filter.is_some() {
        return None;
    }
    let FunctionArguments::List(list) = &f.args else { return None };
    let distinct = matches!(list.duplicate_treatment, Some(DuplicateTreatment::Distinct));
    let arg = match list.args.first() {
        Some(FunctionArg::Unnamed(FunctionArgExpr::Expr(a))) => Some(a.to_string()),
        Some(FunctionArg::Unnamed(FunctionArgExpr::Wildcard)) | None => None,
        _ => return None,
    };
    Some(Agg { output: output.to_owned(), func, arg, distinct, text: e.to_string() })
}

/// Parses `sql` into the supported shape, or lists what's outside it.
pub fn analyze(sql: &str) -> std::result::Result<Analysis, Vec<String>> {
    let statements = Parser::parse_sql(&PostgreSqlDialect {}, sql).map_err(|e| vec![format!("Couldn't parse: {e}")])?;
    let [Statement::Query(query)] = statements.as_slice() else { return Err(vec!["Exactly one SELECT statement".into()]) };
    let mut limits = Vec::new();
    if query.with.is_some() {
        limits.push("WITH (common table expressions)".into());
    }
    let SetExpr::Select(select) = query.body.as_ref() else { return Err(vec!["UNION / INTERSECT / EXCEPT or a parenthesized query".into()]) };
    if select.distinct.is_some() {
        limits.push("SELECT DISTINCT".into());
    }
    if select.from.len() != 1 {
        limits.push("several FROM items (comma joins)".into());
    }
    let text = sql.to_lowercase();
    if text.contains(" over (") || text.contains(" over(") || text.contains(" over w") {
        limits.push("window functions (OVER)".into());
    }
    for v in ["random(", "nextval(", "clock_timestamp(", "setval("] {
        if text.contains(v) {
            limits.push(format!("a volatile function ({}…)", v.trim_end_matches('(')));
        }
    }
    let mut base = None;
    let mut joins = Vec::new();
    if let Some(from) = select.from.first() {
        match source(&from.relation) {
            Ok(s) => base = Some(s),
            Err(e) => limits.push(e),
        }
        for j in &from.joins {
            let (left, constraint) = match &j.join_operator {
                JoinOperator::Join(c) | JoinOperator::Inner(c) => (false, c),
                JoinOperator::Left(c) | JoinOperator::LeftOuter(c) => (true, c),
                other => {
                    limits.push(format!("{} joins", format!("{other:?}").split('(').next().unwrap_or("this kind of")));
                    continue;
                }
            };
            let on = match constraint {
                JoinConstraint::On(e) => e.to_string(),
                _ => {
                    limits.push("JOIN … USING / NATURAL (write the ON condition)".into());
                    continue;
                }
            };
            match source(&j.relation) {
                Ok(s) => joins.push(JoinInfo { left, source: s, on }),
                Err(e) => limits.push(e),
            }
        }
    }
    let mut filters = Vec::new();
    if let Some(w) = &select.selection {
        conjuncts(w, &mut filters);
    }
    let group_by = match &select.group_by {
        GroupByExpr::Expressions(e, m) if m.is_empty() => e.iter().map(|x| x.to_string()).collect(),
        GroupByExpr::Expressions(..) => {
            limits.push("GROUP BY with ROLLUP / CUBE / GROUPING SETS".into());
            vec![]
        }
        GroupByExpr::All(_) => {
            limits.push("GROUP BY ALL".into());
            vec![]
        }
    };
    if text.contains("grouping sets") || text.contains("rollup(") || text.contains("cube(") {
        limits.push("grouping sets".into());
    }
    let mut projection = Vec::new();
    let mut aggregates = Vec::new();
    for item in &select.projection {
        match item {
            SelectItem::UnnamedExpr(e) => {
                let name = output_name(e);
                aggregates.extend(aggregate(&name, e));
                projection.push((name, e.to_string()));
            }
            SelectItem::ExprWithAlias { expr, alias } => {
                aggregates.extend(aggregate(&alias.value, expr));
                projection.push((alias.value.clone(), expr.to_string()));
            }
            other => projection.push((other.to_string(), other.to_string())),
        }
    }
    let order_by = match &query.order_by {
        Some(o) => match &o.kind {
            OrderByKind::Expressions(list) => list.iter().map(|e| e.to_string()).collect(),
            OrderByKind::All(_) => {
                limits.push("ORDER BY ALL".into());
                vec![]
            }
        },
        None => vec![],
    };
    let (limit, offset) = match &query.limit_clause {
        Some(LimitClause::LimitOffset { limit, offset, .. }) => (limit.as_ref().map(|l| l.to_string()), offset.as_ref().map(|o| o.value.to_string())),
        Some(_) => {
            limits.push("LIMIT offset, count".into());
            (None, None)
        }
        None => (None, None),
    };
    if query.fetch.is_some() {
        limits.push("FETCH FIRST".into());
    }
    let mut unlimited = (**query).clone();
    unlimited.order_by = None;
    unlimited.limit_clause = None;
    let Some(base) = base else { limits.push("no FROM table".into()); return Err(limits) };
    if !limits.is_empty() {
        return Err(limits);
    }
    let mut notes = Vec::new();
    if filters.iter().any(|f| f.to_lowercase().contains("select ")) {
        notes.push("A WHERE condition contains a subquery: it's evaluated as one condition".into());
    }
    if aggregates.len() < projection.iter().filter(|p| AGGS.iter().any(|a| p.1.to_lowercase().contains(&format!("{a}(")))).count() {
        notes.push("Some aggregates are inside larger expressions: drill-down works on plain COUNT / SUM / AVG / MIN / MAX columns".into());
    }
    Ok(Analysis { base, joins, filters, group_by, having: select.having.as_ref().map(|h| h.to_string()), projection, aggregates, order_by, limit, offset, unlimited: unlimited.to_string(), notes })
}

impl Analysis {
    fn sources(&self) -> impl Iterator<Item = &Source> {
        std::iter::once(&self.base).chain(self.joins.iter().map(|j| &j.source))
    }

    fn table_sql(s: &Source) -> String {
        let t = match &s.schema {
            Some(schema) => format!("{}.{}", ident(Engine::Postgres, schema), ident(Engine::Postgres, &s.table)),
            None => ident(Engine::Postgres, &s.table),
        };
        format!("{t} AS {}", ident(Engine::Postgres, &s.alias))
    }

    /// FROM with the first `n` joins.
    pub fn joined_from(&self, n: usize) -> String {
        let mut out = format!("FROM {}", Self::table_sql(&self.base));
        for j in self.joins.iter().take(n) {
            out.push_str(&format!(" {} JOIN {} ON {}", if j.left { "LEFT" } else { "INNER" }, Self::table_sql(&j.source), j.on));
        }
        out
    }

    pub fn where_sql(&self) -> String {
        if self.filters.is_empty() { "TRUE".into() } else { self.filters.iter().map(|f| format!("({f})")).collect::<Vec<_>>().join(" AND ") }
    }

    /// The entity (a source's primary key) as one value: `a.id` or `ROW(a.k1, a.k2)`.
    fn entity(s: &Source) -> Option<String> {
        let cols: Vec<String> = s.keys.iter().map(|k| format!("{}.{}", ident(Engine::Postgres, &s.alias), ident(Engine::Postgres, k))).collect();
        match cols.len() {
            0 => None,
            1 => Some(cols[0].clone()),
            _ => Some(format!("ROW({})", cols.join(", "))),
        }
    }

    fn grouped(&self) -> bool {
        !self.group_by.is_empty() || !self.aggregates.is_empty()
    }

    /// An ORDER BY item with output aliases and positions replaced by their expressions.
    fn order_expr(&self, item: &str) -> String {
        let (expr, dir) = match item.rsplit_once(' ') {
            Some((e, d)) if ["ASC", "DESC"].contains(&d.to_uppercase().as_str()) => (e, format!(" {d}")),
            _ => (item, String::new()),
        };
        if let Ok(n) = expr.trim().parse::<usize>()
            && let Some((_, e)) = self.projection.get(n.wrapping_sub(1))
        {
            return format!("{e}{dir}");
        }
        match self.projection.iter().find(|(name, _)| name == expr.trim() || ident(Engine::Postgres, name) == expr.trim()) {
            Some((_, e)) => format!("{e}{dir}"),
            None => item.to_owned(),
        }
    }
}

// ---- Running diagnostics ----

struct Diag<'a> {
    session: &'a Session,
    tab: String,
}

impl Diag<'_> {
    async fn rows(&self, sql: &str) -> Result<(Vec<String>, Vec<Vec<Option<String>>>)> {
        collect(self.session, sql, Some(&self.tab), Some(1001)).await.map_err(|e| AppError::Invalid(format!("{e}\n(while running: {sql})")))
    }

    async fn one(&self, sql: &str) -> Result<Vec<Option<String>>> {
        Ok(self.rows(sql).await?.1.into_iter().next().unwrap_or_default())
    }

    fn num(v: &Option<String>) -> i64 {
        v.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0)
    }
}

/// Runs `work` inside one read-only snapshot on a session of its own, then rolls back and closes it.
async fn in_snapshot<T>(session: &Session, work: impl AsyncFnOnce(&Diag<'_>) -> Result<T>) -> Result<T> {
    if session.engine() != Engine::Postgres {
        return Err(AppError::Invalid("The query debugger works on PostgreSQL".into()));
    }
    let diag = Diag { session, tab: format!("logic:{}", uuid::Uuid::new_v4().simple()) };
    let begin = async {
        session.execute_script("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", &diag.tab).await?;
        session.execute_script("SET LOCAL statement_timeout = '20s'", &diag.tab).await
    };
    let result = match begin.await {
        Ok(()) => work(&diag).await,
        Err(e) => Err(e),
    };
    let _ = session.execute_script("ROLLBACK", &diag.tab).await;
    session.close_tab(&diag.tab).await;
    result
}

async fn with_keys(session: &Session, mut a: Analysis) -> Result<Analysis> {
    let default_schema = collect(session, "SELECT current_schema()", None, Some(1)).await?.1.first().and_then(|r| r[0].clone()).unwrap_or_else(|| "public".into());
    let fill = async |s: &mut Source| -> Result<()> {
        let schema = s.schema.clone().unwrap_or_else(|| default_schema.clone());
        s.keys = session.columns(&schema, &s.table).await?.into_iter().filter(|c| c.primary_key).map(|c| c.name).collect();
        Ok(())
    };
    fill(&mut a.base).await?;
    for j in &mut a.joins {
        fill(&mut j.source).await?;
    }
    Ok(a)
}

pub async fn prepare(session: &Session, sql: &str) -> Result<Analysis> {
    let a = analyze(sql).map_err(|limits| AppError::Invalid(format!("Outside what the query debugger supports:\n• {}", limits.join("\n• "))))?;
    with_keys(session, a).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub label: String,
    pub detail: String,
    pub rows: i64,
    /// Distinct base entities (by primary key); None without a key.
    pub entities: Option<i64>,
    /// Most rows any one base entity has here (shows join fan-out).
    pub max_per_entity: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Predicate {
    pub text: String,
    pub true_rows: i64,
    pub false_rows: i64,
    /// NULL: neither true nor false (SQL's third value), so the row is filtered out too.
    pub unknown_rows: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageReport {
    pub analysis: Analysis,
    pub stages: Vec<Stage>,
    pub predicates: Vec<Predicate>,
    pub observations: Vec<String>,
}

/// F19: how many rows (and distinct base entities) each logical step produces.
pub async fn stages(session: &Session, sql: &str) -> Result<StageReport> {
    let a = prepare(session, sql).await?;
    in_snapshot(session, async |d| {
        let ent = Analysis::entity(&a.base);
        let count = |from: &str, extra: &str| match &ent {
            Some(e) => format!("SELECT count(*), count(DISTINCT {e}), (SELECT max(c) FROM (SELECT count(*) c {from} {extra} GROUP BY {e}) m) {from} {extra}"),
            None => format!("SELECT count(*), NULL, NULL {from} {extra}"),
        };
        let mut stages = Vec::new();
        for i in 0..=a.joins.len() {
            let r = d.one(&count(&a.joined_from(i), "")).await?;
            let (label, detail) = if i == 0 {
                (format!("{} ({})", a.base.table, a.base.alias), "every row of the first table".to_owned())
            } else {
                let j = &a.joins[i - 1];
                (format!("{} JOIN {} ({})", if j.left { "LEFT" } else { "INNER" }, j.source.table, j.source.alias), format!("ON {}", j.on))
            };
            stages.push(Stage { label, detail, rows: Diag::num(&r[0]), entities: ent.as_ref().map(|_| Diag::num(&r[1])), max_per_entity: ent.as_ref().map(|_| Diag::num(&r[2])) });
        }
        let all = a.joined_from(a.joins.len());
        let mut predicates = Vec::new();
        for p in &a.filters {
            let r = d.one(&format!("SELECT count(*) FILTER (WHERE ({p}) IS TRUE), count(*) FILTER (WHERE ({p}) IS FALSE), count(*) FILTER (WHERE ({p}) IS NULL) {all}")).await?;
            predicates.push(Predicate { text: p.clone(), true_rows: Diag::num(&r[0]), false_rows: Diag::num(&r[1]), unknown_rows: Diag::num(&r[2]) });
        }
        if !a.filters.is_empty() {
            let r = d.one(&count(&all, &format!("WHERE {}", a.where_sql()))).await?;
            stages.push(Stage { label: "WHERE".into(), detail: format!("{} condition{}", a.filters.len(), if a.filters.len() == 1 { "" } else { "s" }), rows: Diag::num(&r[0]), entities: ent.as_ref().map(|_| Diag::num(&r[1])), max_per_entity: ent.as_ref().map(|_| Diag::num(&r[2])) });
        }
        if a.grouped() {
            let g = if a.group_by.is_empty() { String::new() } else { format!("GROUP BY {}", a.group_by.join(", ")) };
            let groups = d.one(&format!("SELECT count(*) FROM (SELECT 1 {all} WHERE {} {g}) x", a.where_sql())).await?;
            stages.push(Stage { label: "GROUP BY".into(), detail: if a.group_by.is_empty() { "one group (aggregates over every row)".into() } else { a.group_by.join(", ") }, rows: Diag::num(&groups[0]), entities: None, max_per_entity: None });
            if let Some(h) = &a.having {
                let r = d.one(&format!("SELECT count(*) FROM (SELECT 1 {all} WHERE {} {g} HAVING {h}) x", a.where_sql())).await?;
                stages.push(Stage { label: "HAVING".into(), detail: h.clone(), rows: Diag::num(&r[0]), entities: None, max_per_entity: None });
            }
        }
        let total = d.one(&format!("SELECT count(*) FROM ({}) x", a.unlimited)).await?;
        let total = Diag::num(&total[0]);
        let shown = match (&a.limit, &a.offset) {
            (Some(l), o) => {
                let l: i64 = l.parse().unwrap_or(total);
                let o: i64 = o.as_deref().and_then(|o| o.parse().ok()).unwrap_or(0);
                (total - o).clamp(0, l)
            }
            (None, Some(o)) => (total - o.parse::<i64>().unwrap_or(0)).max(0),
            _ => total,
        };
        stages.push(Stage { label: "Result".into(), detail: match &a.limit { Some(l) => format!("LIMIT {l} of {total}"), None => "every output row".into() }, rows: shown, entities: None, max_per_entity: None });

        let mut observations = Vec::new();
        for (i, j) in a.joins.iter().enumerate() {
            let (before, after) = (&stages[i], &stages[i + 1]);
            if after.rows > before.rows && after.max_per_entity.unwrap_or(0) > 1 {
                observations.push(format!("JOIN {} raises rows from {} to {}: one {} row can appear up to {} times after it.", j.source.table, before.rows, after.rows, a.base.table, after.max_per_entity.unwrap_or(0)));
            }
            if !j.left && after.entities < before.entities {
                observations.push(format!("INNER JOIN {} drops {} {} rows that have no match.", j.source.table, before.entities.unwrap_or(0) - after.entities.unwrap_or(0), a.base.table));
            }
        }
        let fanned = stages.iter().filter_map(|s| s.max_per_entity).max().unwrap_or(1) > 1;
        if fanned && a.aggregates.iter().any(|g| matches!(g.func.as_str(), "count" | "sum" | "avg") && !g.distinct) {
            observations.push(format!("Aggregates run after the joins, where a {} row can repeat: {} count it once per joined row. Fine if intended, wrong if you meant once per {}.", a.base.table, a.aggregates.iter().filter(|g| g.func != "min" && g.func != "max").map(|g| g.text.clone()).collect::<Vec<_>>().join(", "), a.base.table));
        }
        for p in &predicates {
            if p.unknown_rows > 0 {
                observations.push(format!("`{}` is NULL (unknown) for {} rows: those are filtered out just like false ones.", p.text, p.unknown_rows));
            }
        }
        if a.limit.is_some() && a.order_by.is_empty() {
            observations.push("LIMIT without ORDER BY: which rows are kept is up to the database and can change between runs.".into());
        }
        if ent.is_none() {
            observations.push(format!("{} has no primary key: distinct-entity counts aren't available.", a.base.table));
        }
        Ok(StageReport { analysis: a.clone(), stages, predicates, observations })
    })
    .await
}

/// Columns and the values a condition saw.
pub type Values = (Vec<String>, Vec<Vec<Option<String>>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingStep {
    pub stage: String,
    /// "kept", "removed", "not-found", "beyond-limit", "unknown"
    pub status: String,
    pub detail: String,
    pub values: Option<Values>,
}

/// Identifier pairs `alias.column` in an expression, for showing the values a condition saw.
fn referenced(expr: &str, aliases: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for a in aliases {
        let re = format!("{a}.");
        let mut rest = expr;
        while let Some(i) = rest.find(&re) {
            let before_ok = i == 0 || !rest[..i].ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '.');
            let tail = &rest[i + re.len()..];
            let col: String = tail.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            if before_ok && !col.is_empty() {
                let full = format!("{a}.{col}");
                if !out.contains(&full) {
                    out.push(full);
                }
            }
            rest = &rest[i + re.len()..];
        }
    }
    out
}

/// F01: why an expected row isn't in the result. `alias`: which table the row belongs to; `key`: its primary key values.
pub async fn missing(session: &Session, sql: &str, alias: &str, key: &[(String, String)]) -> Result<Vec<MissingStep>> {
    let a = prepare(session, sql).await?;
    let (start, src) = std::iter::once((0usize, &a.base))
        .chain(a.joins.iter().enumerate().map(|(i, j)| (i + 1, &j.source)))
        .find(|(_, s)| s.alias == alias)
        .ok_or_else(|| AppError::Invalid(format!("No table with alias {alias} in the query")))?;
    let src = src.clone();
    let lit = |v: &str| literal(Engine::Postgres, v);
    let entity = key.iter().map(|(c, v)| format!("{}.{} = {}", ident(Engine::Postgres, &src.alias), ident(Engine::Postgres, c), lit(v))).collect::<Vec<_>>().join(" AND ");
    let plain = key.iter().map(|(c, v)| format!("{} = {}", ident(Engine::Postgres, c), lit(v))).collect::<Vec<_>>().join(" AND ");
    let aliases: Vec<String> = a.sources().map(|s| s.alias.clone()).collect();
    in_snapshot(session, async |d| {
        let mut steps = Vec::new();
        let table = Analysis::table_sql(&src);
        let exists = d.one(&format!("SELECT count(*) FROM {} WHERE {plain}", table.rsplit_once(" AS ").map(|x| x.0).unwrap_or(&table))).await?;
        if Diag::num(&exists[0]) == 0 {
            steps.push(MissingStep { stage: src.table.clone(), status: "not-found".into(), detail: format!("No {} row with {plain} exists, or this role can't see it (check permissions and row-level security).", src.table), values: None });
            return Ok(steps);
        }
        steps.push(MissingStep { stage: src.table.clone(), status: "kept".into(), detail: format!("The row exists in {}.", src.table), values: None });
        for i in start.max(1)..=a.joins.len() {
            let j = &a.joins[i - 1];
            let n = Diag::num(&d.one(&format!("SELECT count(*) {} WHERE {entity}", a.joined_from(i))).await?[0]);
            if n == 0 {
                let side = if j.source.alias == alias { format!("no row it pairs with on the other side of ON {}", j.on) } else { format!("no {} row matches ON {}", j.source.table, j.on) };
                steps.push(MissingStep { stage: format!("{} JOIN {}", if j.left { "LEFT" } else { "INNER" }, j.source.table), status: "removed".into(), detail: format!("Removed here: {side}."), values: None });
                return Ok(steps);
            }
            steps.push(MissingStep { stage: format!("{} JOIN {}", if j.left { "LEFT" } else { "INNER" }, j.source.table), status: "kept".into(), detail: format!("{n} joined row{} for it.", if n == 1 { "" } else { "s" }), values: None });
        }
        let all = a.joined_from(a.joins.len());
        let mut excluded_by_one = false;
        for p in &a.filters {
            let r = d.one(&format!("SELECT count(*) FILTER (WHERE ({p}) IS TRUE), count(*) FILTER (WHERE ({p}) IS FALSE), count(*) FILTER (WHERE ({p}) IS NULL) {all} WHERE {entity}")).await?;
            let (t, f, u) = (Diag::num(&r[0]), Diag::num(&r[1]), Diag::num(&r[2]));
            let cols = referenced(p, &aliases);
            let values = if cols.is_empty() { None } else { Some(d.rows(&format!("SELECT {} {all} WHERE {entity} LIMIT 5", cols.join(", "))).await?).map(|(_, rows)| (cols.clone(), rows)) };
            let status = if t > 0 { "kept" } else { excluded_by_one = true; "removed" };
            let detail = if t > 0 { format!("True for {t} of its rows.") } else if u > 0 && f == 0 { format!("NULL (unknown) for all {u} of its rows: SQL drops rows where a condition is unknown, not only false.") } else if u > 0 { format!("False for {f} and NULL (unknown) for {u} of its rows.") } else { format!("False for all {f} of its rows.") };
            steps.push(MissingStep { stage: format!("WHERE {p}"), status: status.into(), detail, values });
        }
        if excluded_by_one {
            return Ok(steps);
        }
        if a.filters.len() > 1 {
            let n = Diag::num(&d.one(&format!("SELECT count(*) {all} WHERE {entity} AND {}", a.where_sql())).await?[0]);
            if n == 0 {
                steps.push(MissingStep { stage: "WHERE (all together)".into(), status: "removed".into(), detail: "Each condition is true for some of its joined rows, but no single row satisfies all of them at once.".into(), values: None });
                return Ok(steps);
            }
        }
        let g = if a.group_by.is_empty() { String::new() } else { format!("GROUP BY {}", a.group_by.join(", ")) };
        if a.grouped() {
            if let Some(h) = &a.having {
                let r = d.rows(&format!("SELECT ({h}) IS TRUE, ({h}) IS NULL {all} WHERE {} {g} HAVING bool_or({entity})", a.where_sql())).await?;
                if !r.1.iter().any(|row| row[0].as_deref() == Some("t")) {
                    let unknown = r.1.iter().any(|row| row[1].as_deref() == Some("t"));
                    steps.push(MissingStep { stage: format!("HAVING {h}"), status: "removed".into(), detail: if unknown { "Its group's HAVING condition is NULL (unknown), so the group is dropped.".into() } else { "Its group fails the HAVING condition.".into() }, values: None });
                    return Ok(steps);
                }
                steps.push(MissingStep { stage: format!("HAVING {h}"), status: "kept".into(), detail: "Its group passes HAVING.".into(), values: None });
            } else {
                steps.push(MissingStep { stage: "GROUP BY".into(), status: "kept".into(), detail: "It contributes to an output group (it isn't an output row of its own).".into(), values: None });
            }
        }
        if a.limit.is_some() || a.offset.is_some() {
            let order = if a.order_by.is_empty() { "(SELECT NULL)".into() } else { a.order_by.iter().map(|o| a.order_expr(o)).collect::<Vec<_>>().join(", ") };
            let sql = if a.grouped() {
                format!("SELECT rn FROM (SELECT bool_or({entity}) AS hit, row_number() OVER (ORDER BY {order}) rn {all} WHERE {} {g} {}) x WHERE hit ORDER BY rn LIMIT 1", a.where_sql(), a.having.as_ref().map(|h| format!("HAVING {h}")).unwrap_or_default())
            } else {
                format!("SELECT rn FROM (SELECT ({entity}) AS hit, row_number() OVER (ORDER BY {order}) rn {all} WHERE {}) x WHERE hit ORDER BY rn LIMIT 1", a.where_sql())
            };
            let pos = Diag::num(&d.one(&sql).await?.first().cloned().flatten());
            let offset: i64 = a.offset.as_deref().and_then(|o| o.parse().ok()).unwrap_or(0);
            let limit: Option<i64> = a.limit.as_deref().and_then(|l| l.parse().ok());
            let tie = if a.order_by.is_empty() { " There's no ORDER BY, so which rows the LIMIT keeps is arbitrary and can change." } else { " Rows tied on the ORDER BY can come in any order, so positions near the cut can change." };
            if pos <= offset || limit.is_some_and(|l| pos > offset + l) {
                steps.push(MissingStep { stage: "ORDER BY / LIMIT".into(), status: "beyond-limit".into(), detail: format!("It's in the result, at position {pos}, outside the rows kept ({} to {}).{tie}", offset + 1, limit.map(|l| (offset + l).to_string()).unwrap_or_else(|| "the end".into())), values: None });
                return Ok(steps);
            }
            steps.push(MissingStep { stage: "ORDER BY / LIMIT".into(), status: "kept".into(), detail: format!("At position {pos}, inside the rows kept."), values: None });
        }
        steps.push(MissingStep { stage: "Result".into(), status: "kept".into(), detail: "It is in the result now (under this snapshot). If you didn't see it, the data may have changed since, or a display cap hid it.".into(), values: None });
        Ok(steps)
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drill {
    pub aggregate: Agg,
    pub group: Vec<(String, Option<String>)>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// More than the 1,000 rows shown.
    pub capped: bool,
    pub total_rows: i64,
    /// Rows whose argument is NULL (not counted by COUNT(x), SUM, AVG).
    pub null_rows: i64,
    pub distinct_entities: Option<i64>,
    /// Recomputed now, under this snapshot.
    pub recomputed: Option<String>,
    pub avg_parts: Option<(Option<String>, i64)>,
    /// Base rows that contribute more than once (join fan-out).
    pub repeated: Vec<(Option<String>, i64)>,
}

/// F05: the rows behind one aggregate cell. `row`: the clicked output row, by column name.
pub async fn drill(session: &Session, sql: &str, row: &std::collections::HashMap<String, Option<String>>, column: &str) -> Result<Drill> {
    let a = prepare(session, sql).await?;
    let agg = a.aggregates.iter().find(|g| g.output == column).cloned().ok_or_else(|| AppError::Invalid(format!("{column} isn't a plain COUNT / SUM / AVG / MIN / MAX column")))?;
    let mut group = Vec::new();
    let mut conds = Vec::new();
    for g in &a.group_by {
        let (name, _) = a
            .projection
            .iter()
            .find(|(name, e)| e == g || name == g || g.parse::<usize>().ok().is_some_and(|n| a.projection.get(n.wrapping_sub(1)).is_some_and(|p| &p.0 == name)))
            .ok_or_else(|| AppError::Invalid(format!("GROUP BY {g} isn't one of the output columns, so the clicked row can't identify its group")))?;
        let value = row.get(name).cloned().flatten();
        let expr = g.parse::<usize>().ok().and_then(|n| a.projection.get(n - 1)).map(|p| p.1.clone()).unwrap_or_else(|| g.clone());
        conds.push(match &value {
            None => format!("({expr}) IS NULL"),
            Some(v) => format!("({expr}) = {}", literal(Engine::Postgres, v)),
        });
        group.push((name.clone(), value));
    }
    let all = a.joined_from(a.joins.len());
    let filter = format!("{} AND {}", a.where_sql(), if conds.is_empty() { "TRUE".into() } else { conds.join(" AND ") });
    let ent = Analysis::entity(&a.base);
    let arg = agg.arg.clone().unwrap_or_else(|| "1".into());
    in_snapshot(session, async |d| {
        let keys: Vec<String> = a.sources().flat_map(|s| s.keys.iter().map(move |k| format!("{}.{} AS \"{}.{}\"", ident(Engine::Postgres, &s.alias), ident(Engine::Postgres, k), s.alias, k))).collect();
        let (columns, rows) = d.rows(&format!("SELECT {}{}({arg}) AS contribution {all} WHERE {filter} LIMIT 1001", keys.join(", "), if keys.is_empty() { "" } else { ", " })).await?;
        let capped = rows.len() > 1000;
        let stats = d
            .one(&format!(
                "SELECT count(*), count(*) FILTER (WHERE ({arg}) IS NULL), {}, ({})::text, {} {all} WHERE {filter}",
                ent.as_ref().map(|e| format!("count(DISTINCT {e})")).unwrap_or_else(|| "NULL".into()),
                agg.text,
                if agg.func == "avg" { format!("sum({arg})::text, count({arg})") } else { "NULL, NULL".into() }
            ))
            .await?;
        let repeated = match &ent {
            Some(e) => d.rows(&format!("SELECT ({e})::text, count(*) {all} WHERE {filter} GROUP BY {e} HAVING count(*) > 1 ORDER BY 2 DESC LIMIT 20")).await?.1.into_iter().map(|r| (r[0].clone(), Diag::num(&r[1]))).collect(),
            None => vec![],
        };
        Ok(Drill {
            aggregate: agg.clone(),
            group: group.clone(),
            columns,
            rows: rows.into_iter().take(1000).collect(),
            capped,
            total_rows: Diag::num(&stats[0]),
            null_rows: if agg.arg.is_some() { Diag::num(&stats[1]) } else { 0 },
            distinct_entities: ent.as_ref().map(|_| Diag::num(&stats[2])),
            recomputed: stats[3].clone(),
            avg_parts: (agg.func == "avg").then(|| (stats[4].clone(), Diag::num(&stats[5]))),
            repeated,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyzes_the_supported_subset() {
        let a = analyze("SELECT c.name, count(*) AS orders, sum(o.total) FROM customers c JOIN orders o ON o.customer_id = c.id LEFT JOIN items i ON i.order_id = o.id WHERE o.status = 'paid' AND (c.region = 'eu' OR c.region IS NULL) GROUP BY c.name HAVING count(*) > 1 ORDER BY orders DESC LIMIT 10").unwrap();
        assert_eq!((a.base.alias.as_str(), a.joins.len(), a.joins[1].left), ("c", 2, true));
        assert_eq!(a.filters, ["o.status = 'paid'", "(c.region = 'eu' OR c.region IS NULL)"]);
        assert_eq!(a.aggregates.iter().map(|g| (g.output.as_str(), g.func.as_str(), g.arg.clone())).collect::<Vec<_>>(), [("orders", "count", None), ("sum", "sum", Some("o.total".into()))]);
        assert_eq!((a.limit.as_deref(), a.order_expr("orders DESC")), (Some("10"), "count(*) DESC".to_owned()));
        assert!(!a.unlimited.contains("LIMIT"));
    }

    #[test]
    fn names_what_it_cant_do() {
        let err = analyze("WITH x AS (SELECT 1) SELECT DISTINCT a, row_number() OVER (ORDER BY a) FROM t FULL JOIN u ON true").unwrap_err();
        assert!(err.iter().any(|e| e.contains("WITH")) && err.iter().any(|e| e.contains("DISTINCT")) && err.iter().any(|e| e.contains("window")) && err.iter().any(|e| e.contains("FullOuter")), "{err:?}");
        assert!(analyze("SELECT 1 UNION SELECT 2").is_err());
        assert!(analyze("SELECT * FROM t WHERE random() > 0.5").unwrap_err()[0].contains("volatile"));
    }

    /// `ONYX_TEST_PG=1 cargo test sqllogic`: the PRD fixtures. 100 orders become 342 rows after
    /// the items join; a row excluded by a NULL predicate is "unknown", not "false"; an inner
    /// join removal names the missing side; a drilled SUM reconciles and shows fan-out.
    #[tokio::test]
    async fn explains_stages_missing_rows_and_aggregates() {
        let Some(config) = crate::db::edit_integration::config(Engine::Postgres) else { return };
        let session = Session::connect(&config, None, None).await.unwrap();
        let s = format!("onyx_logic_{}", uuid::Uuid::new_v4().simple());
        session
            .execute_meta(&format!(
                "CREATE SCHEMA {s};
                 CREATE TABLE {s}.orders (id int PRIMARY KEY, customer text, status text, total numeric(10,2), coupon text);
                 CREATE TABLE {s}.items (id int PRIMARY KEY, order_id int, sku text);
                 INSERT INTO {s}.orders SELECT g, 'c' || (g % 5), CASE WHEN g % 10 = 0 THEN NULL ELSE 'paid' END, g, NULL FROM generate_series(1, 100) g;
                 INSERT INTO {s}.items SELECT g, 1 + (g % 98), 'sku' || g FROM generate_series(1, 342) g;"
            ))
            .await
            .unwrap();
        let sql = format!("SELECT o.customer, sum(o.total) AS revenue FROM {s}.orders o JOIN {s}.items i ON i.order_id = o.id WHERE o.status = 'paid' GROUP BY o.customer ORDER BY revenue DESC LIMIT 2");
        let report = stages(&session, &sql).await.unwrap();
        assert_eq!((report.stages[0].rows, report.stages[1].rows), (100, 342), "{:?}", report.stages);
        assert!(report.observations.iter().any(|o| o.contains("raises rows from 100 to 342")), "{:?}", report.observations);
        assert!(report.observations.iter().any(|o| o.contains("sum(o.total)")));
        assert!(report.predicates[0].unknown_rows > 0);

        // Order 10: status NULL → the WHERE condition is unknown, not false.
        let steps = missing(&session, &sql, "o", &[("id".into(), "10".into())]).await.unwrap();
        let w = steps.iter().find(|x| x.stage.starts_with("WHERE")).unwrap();
        assert_eq!(w.status, "removed");
        assert!(w.detail.contains("NULL (unknown)"), "{}", w.detail);
        // Order 99 and 100 have no items (order_id is 1..98): the inner join removes them.
        let steps = missing(&session, &sql, "o", &[("id".into(), "99".into())]).await.unwrap();
        assert!(steps.iter().any(|x| x.status == "removed" && x.stage.contains("JOIN items")), "{steps:?}");
        // Order 1 is in, but its customer's group is beyond LIMIT 2 or kept.
        let steps = missing(&session, &sql, "o", &[("id".into(), "1".into())]).await.unwrap();
        assert!(steps.iter().any(|x| x.stage == "ORDER BY / LIMIT"));

        // Drill into one customer's revenue: reconciles, and orders repeat once per item.
        let (_, out) = collect(&session, &sql, None, None).await.unwrap();
        let row: std::collections::HashMap<String, Option<String>> = [("customer".to_owned(), out[0][0].clone()), ("revenue".to_owned(), out[0][1].clone())].into();
        let d = drill(&session, &sql, &row, "revenue").await.unwrap();
        assert_eq!(d.recomputed, out[0][1], "the recomputed total matches the result");
        assert!(!d.repeated.is_empty(), "orders with several items contribute more than once");
        assert!(d.total_rows > d.distinct_entities.unwrap());
        session.execute_meta(&format!("DROP SCHEMA {s} CASCADE")).await.unwrap();
    }
}
