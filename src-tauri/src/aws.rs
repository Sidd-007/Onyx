//! Amazon RDS IAM sign-in: a short-lived auth token (a SigV4-presigned `connect` request)
//! used as the password. Credentials come from ~/.aws/credentials (a profile) or the AWS_*
//! environment variables; no AWS SDK.

use std::collections::BTreeMap;

use ring::{digest, hmac};
use zeroize::Zeroizing;

use crate::connections::AwsIam;
use crate::error::{AppError, Result};

pub struct Credentials {
    pub access_key: String,
    pub secret_key: Zeroizing<String>,
    pub session_token: Option<String>,
}

/// RFC 3986 encoding, as SigV4 wants it.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(digest::digest(&digest::SHA256, data))
}

fn hmac_sha256(key: &[u8], data: &str) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data.as_bytes()).as_ref().to_vec()
}

/// A SigV4 query-string-signed (presigned) GET. `params` are the request's own query parameters.
#[allow(clippy::too_many_arguments)]
pub fn presign(
    creds: &Credentials,
    host: &str,
    path: &str,
    params: &[(&str, &str)],
    service: &str,
    region: &str,
    datetime: &str,
    expires: u32,
    payload_hash: &str,
) -> String {
    let date = &datetime[..8];
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let mut query: BTreeMap<String, String> = params.iter().map(|(k, v)| (encode(k), encode(v))).collect();
    query.insert("X-Amz-Algorithm".into(), "AWS4-HMAC-SHA256".into());
    query.insert("X-Amz-Credential".into(), encode(&format!("{}/{scope}", creds.access_key)));
    query.insert("X-Amz-Date".into(), datetime.into());
    query.insert("X-Amz-Expires".into(), expires.to_string());
    if let Some(token) = &creds.session_token {
        query.insert("X-Amz-Security-Token".into(), encode(token));
    }
    query.insert("X-Amz-SignedHeaders".into(), "host".into());
    let canonical_query = query.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    let canonical_request = format!("GET\n{path}\n{canonical_query}\nhost:{host}\n\nhost\n{payload_hash}");
    let to_sign = format!("AWS4-HMAC-SHA256\n{datetime}\n{scope}\n{}", sha256_hex(canonical_request.as_bytes()));
    let mut key = hmac_sha256(format!("AWS4{}", creds.secret_key.as_str()).as_bytes(), date);
    for part in [region, service, "aws4_request"] {
        key = hmac_sha256(&key, part);
    }
    let signature = hex::encode(hmac_sha256(&key, &to_sign));
    format!("{canonical_query}&X-Amz-Signature={signature}")
}

/// `YYYYMMDDTHHMMSSZ` for now (UTC).
fn amz_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z", rem / 3600, (rem / 60) % 60, rem % 60)
}

/// The region in an RDS host name: `db.abc.eu-west-1.rds.amazonaws.com` → `eu-west-1`.
pub fn region_of(host: &str) -> Option<String> {
    let parts: Vec<&str> = host.split('.').collect();
    let at = parts.iter().position(|p| *p == "rds")?;
    (at >= 1).then(|| parts[at - 1].to_owned())
}

/// `[name]` sections of an INI file (~/.aws/credentials, ~/.aws/config).
fn ini_section(text: &str, names: &[String]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut inside = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') && line.ends_with(']') {
            inside = names.iter().any(|n| n == line[1..line.len() - 1].trim());
        } else if inside && let Some((k, v)) = line.split_once('=') {
            out.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
        }
    }
    out
}

/// Credentials for a profile (or `default`), else the AWS_* environment variables.
pub fn credentials(profile: Option<&str>) -> Result<Credentials> {
    let home = std::env::var("HOME").unwrap_or_default();
    let profile = profile.filter(|p| !p.trim().is_empty()).map(str::trim).unwrap_or("default").to_owned();
    if let Ok(text) = std::fs::read_to_string(format!("{home}/.aws/credentials")) {
        let s = ini_section(&text, std::slice::from_ref(&profile));
        if let (Some(id), Some(secret)) = (s.get("aws_access_key_id"), s.get("aws_secret_access_key")) {
            return Ok(Credentials { access_key: id.clone(), secret_key: Zeroizing::new(secret.clone()), session_token: s.get("aws_session_token").cloned() });
        }
    }
    match (std::env::var("AWS_ACCESS_KEY_ID"), std::env::var("AWS_SECRET_ACCESS_KEY")) {
        (Ok(id), Ok(secret)) => Ok(Credentials { access_key: id, secret_key: Zeroizing::new(secret), session_token: std::env::var("AWS_SESSION_TOKEN").ok() }),
        _ => Err(AppError::Invalid(format!(
            "No AWS credentials for profile \"{profile}\" in ~/.aws/credentials (SSO profiles: run `aws configure export-credentials` into that file first)"
        ))),
    }
}

/// The region for an RDS connection: the setting, the profile's region in ~/.aws/config, or the host name's.
pub fn region(iam: &AwsIam, host: &str) -> Result<String> {
    if let Some(r) = iam.region.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        return Ok(r.to_owned());
    }
    if let Some(r) = region_of(host) {
        return Ok(r);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let profile = iam.profile.clone().unwrap_or_else(|| "default".into());
    let text = std::fs::read_to_string(format!("{home}/.aws/config")).unwrap_or_default();
    ini_section(&text, &[format!("profile {profile}"), profile])
        .get("region")
        .cloned()
        .ok_or_else(|| AppError::Invalid("Set the AWS region for IAM sign-in".into()))
}

/// An RDS auth token (valid 15 minutes) for `user` on `host:port`; used as the password.
pub fn rds_token(iam: &AwsIam, host: &str, port: u16, user: &str) -> Result<Zeroizing<String>> {
    let creds = credentials(iam.profile.as_deref())?;
    let region = region(iam, host)?;
    let endpoint = format!("{host}:{port}");
    let empty = sha256_hex(b"");
    let query = presign(&creds, &endpoint, "/", &[("Action", "connect"), ("DBUser", user)], "rds-db", &region, &amz_now(), 900, &empty);
    Ok(Zeroizing::new(format!("{endpoint}/?{query}")))
}

/// What a connection needs to mint its IAM tokens: each new server connection gets a fresh one.
#[derive(Clone)]
pub struct IamTarget {
    iam: AwsIam,
    host: String,
    port: u16,
    user: String,
}

impl IamTarget {
    /// Some when the connection signs in with IAM. Needs TLS (RDS refuses tokens without it).
    pub fn of(config: &crate::connections::ConnectionConfig) -> Result<Option<Self>> {
        let Some(iam) = config.aws_iam.clone() else { return Ok(None) };
        if config.ssl_mode == crate::connections::SslMode::Disable {
            return Err(AppError::Invalid("IAM sign-in needs SSL: pick Require or Verify full".into()));
        }
        Ok(Some(Self { iam, host: config.host.trim().to_owned(), port: config.port, user: config.user.trim().to_owned() }))
    }

    pub fn token(&self) -> Result<Zeroizing<String>> {
        rds_token(&self.iam, &self.host, self.port, &self.user)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AWS's published S3 presigned-URL example (docs: "Authenticating Requests: Using Query Parameters").
    #[test]
    fn matches_the_aws_signing_example() {
        let creds = Credentials {
            access_key: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_key: Zeroizing::new("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into()),
            session_token: None,
        };
        let q = presign(&creds, "examplebucket.s3.amazonaws.com", "/test.txt", &[], "s3", "us-east-1", "20130524T000000Z", 86400, "UNSIGNED-PAYLOAD");
        assert!(q.ends_with("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"), "{q}");
        assert!(q.contains("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request"));
    }

    #[test]
    fn finds_regions_and_profiles() {
        assert_eq!(region_of("db.abc123.eu-west-1.rds.amazonaws.com").as_deref(), Some("eu-west-1"));
        assert_eq!(region_of("localhost"), None);
        let ini = "[default]\naws_access_key_id = A\n[work]\naws_access_key_id=B\naws_secret_access_key = S\n";
        let s = ini_section(ini, &["work".into()]);
        assert_eq!((s["aws_access_key_id"].as_str(), s["aws_secret_access_key"].as_str()), ("B", "S"));
        assert!(amz_now().len() == 16 && amz_now().ends_with('Z'));
    }
}
