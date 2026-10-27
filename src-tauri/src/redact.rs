//! Logging that never prints secrets: credentials in URLs, password settings and API keys
//! are masked before anything reaches stderr.

/// `message` with secrets replaced by `***`.
pub fn redact(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    // scheme://user:secret@host → scheme://user:***@host
    while let Some(start) = rest.find("://") {
        let (head, tail) = rest.split_at(start + 3);
        out.push_str(head);
        let end = tail.find(|c: char| c.is_whitespace() || c == '/' || c == '"' || c == '\'').unwrap_or(tail.len());
        let authority = &tail[..end];
        match (authority.rfind('@'), authority.find(':')) {
            (Some(at), Some(colon)) if colon < at => {
                out.push_str(&authority[..=colon]);
                out.push_str("***");
                out.push_str(&authority[at..]);
            }
            _ => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);

    // key=value / key: value pairs whose key names a secret.
    let mut masked = String::with_capacity(out.len());
    let lower = out.to_ascii_lowercase();
    let mut i = 0;
    while i < out.len() {
        let hit = ["password", "passwd", "pwd", "pgpassword", "mysql_pwd", "secret", "api_key", "apikey", "x-api-key"]
            .iter()
            .filter_map(|k| lower[i..].starts_with(k).then_some(k.len()))
            .max();
        if let Some(len) = hit {
            let after = &out[i + len..];
            let sep = after.len() - after.trim_start_matches([' ', '=', ':', '"', '\'']).len();
            if sep > 0 && after[..sep].contains(['=', ':']) {
                masked.push_str(&out[i..i + len + sep]);
                let value = &after[sep..];
                let end = value.find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == ';' || c == '&').unwrap_or(value.len());
                masked.push_str("***");
                i += len + sep + end;
                continue;
            }
        }
        let ch = out[i..].chars().next().unwrap();
        masked.push(ch);
        i += ch.len_utf8();
    }
    // Anthropic keys anywhere.
    let mut result = String::with_capacity(masked.len());
    let mut rest = masked.as_str();
    while let Some(start) = rest.find("sk-ant-") {
        result.push_str(&rest[..start]);
        result.push_str("sk-ant-***");
        let key = &rest[start..];
        let end = key.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')).unwrap_or(key.len());
        rest = &key[end..];
    }
    result.push_str(rest);
    result
}

/// Writes a redacted line to stderr (the terminal running the app).
pub fn log(message: impl AsRef<str>) {
    eprintln!("{}", redact(message.as_ref()));
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn masks_secrets() {
        assert_eq!(redact("postgres://app:hunter2@db.example.com:5432/x"), "postgres://app:***@db.example.com:5432/x");
        assert_eq!(redact("mysql://root@localhost/db"), "mysql://root@localhost/db");
        assert_eq!(redact("host=db password=s3cr3t user=me"), "host=db password=*** user=me");
        assert_eq!(redact(r#"{"password": "abc", "x": 1}"#), r#"{"password": "***", "x": 1}"#);
        assert_eq!(redact("PGPASSWORD=xyz pg_dump"), "PGPASSWORD=*** pg_dump");
        assert_eq!(redact("key sk-ant-api03-AbC_123 rejected"), "key sk-ant-*** rejected");
        assert_eq!(redact("sk-ant-a and sk-ant-b"), "sk-ant-*** and sk-ant-***");
        assert_eq!(redact("the password is required"), "the password is required");
        assert_eq!(redact("no secrets here: SELECT 1"), "no secrets here: SELECT 1");
    }
}
