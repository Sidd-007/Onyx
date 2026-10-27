//! SSH tunnels: a local port forwarded through a bastion host to the database.
//!
//! Host keys are checked against ~/.ssh/known_hosts and Onyx's own known_hosts file.
//! An unknown key stops the connection until the user trusts its fingerprint (saved to
//! Onyx's file only); a changed key always stops it.

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use serde::Serialize;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use zeroize::Zeroizing;

use crate::connections::{SshAuth, SshConfig};
use crate::error::{AppError, Result};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

static ONYX_KNOWN_HOSTS: OnceLock<PathBuf> = OnceLock::new();

/// Where trusted host keys are saved (the app config directory). Set once at startup.
pub fn set_known_hosts_path(path: PathBuf) {
    let _ = ONYX_KNOWN_HOSTS.set(path);
}

fn known_hosts_files() -> Vec<PathBuf> {
    let onyx = ONYX_KNOWN_HOSTS.get().cloned().unwrap_or_else(|| std::env::temp_dir().join("onyx_known_hosts"));
    let user = std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".ssh/known_hosts"));
    std::iter::once(onyx).chain(user).collect()
}

/// A host key that isn't trusted yet (or no longer matches).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyIssue {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    /// The key in OpenSSH format, passed back to `trust_host_key`.
    pub key: String,
    /// True when a different key is on record: possibly an attack.
    pub changed: bool,
}

impl std::fmt::Display for HostKeyIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.changed {
            write!(
                f,
                "The SSH host key for {}:{} has CHANGED ({}). Someone could be intercepting the connection. \
                 If the server was rebuilt, remove its old entry from ~/.ssh/known_hosts.",
                self.host, self.port, self.fingerprint
            )
        } else {
            write!(f, "Unknown SSH host {}:{}. Its key fingerprint is {}.", self.host, self.port, self.fingerprint)
        }
    }
}

pub fn trust_host_key(host: &str, port: u16, key: &str) -> Result<()> {
    let key = PublicKey::from_openssh(key).map_err(|e| AppError::Ssh(format!("invalid host key: {e}")))?;
    let path = known_hosts_files().remove(0);
    russh::keys::known_hosts::learn_known_hosts_path(host, port, &key, path)
        .map_err(|e| AppError::Ssh(format!("could not save host key: {e}")))
}

/// Forwards 127.0.0.1:`local_port` to the target while alive.
pub struct Tunnel {
    pub local_port: u16,
    task: JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// `secret`: the SSH password, or the key's passphrase.
pub async fn open(ssh: &SshConfig, secret: Option<Zeroizing<String>>, target: (&str, u16)) -> Result<Tunnel> {
    let host = ssh.host.trim().to_owned();
    let issue = Arc::new(Mutex::new(None));
    let verifier = Verifier { host: host.clone(), port: ssh.port, issue: issue.clone() };
    let config = Arc::new(client::Config { keepalive_interval: Some(Duration::from_secs(30)), ..Default::default() });

    let connected = tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, (host.as_str(), ssh.port), verifier))
        .await
        .map_err(|_| AppError::Ssh(format!("Timed out connecting to {host}:{}", ssh.port)))?;
    let mut handle = match connected {
        Ok(handle) => handle,
        Err(e) => {
            return Err(match issue.lock().unwrap().take() {
                Some(issue) => AppError::HostKey(issue),
                None => AppError::Ssh(format!("{host}:{}: {e}", ssh.port)),
            })
        }
    };
    authenticate(&mut handle, ssh, secret.as_ref().map(|s| s.as_str())).await?;

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let local_port = listener.local_addr()?.port();
    let (target_host, target_port) = (target.0.trim().to_owned(), target.1);
    let handle = Arc::new(handle);
    let task = tokio::spawn(async move {
        while let Ok((mut socket, peer)) = listener.accept().await {
            let handle = handle.clone();
            let target_host = target_host.clone();
            tokio::spawn(async move {
                let channel = handle
                    .channel_open_direct_tcpip(target_host, target_port as u32, "127.0.0.1", peer.port() as u32)
                    .await;
                match channel {
                    Ok(channel) => {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                    }
                    Err(e) => crate::redact::log(format!("ssh tunnel: could not open channel: {e}")),
                }
            });
        }
    });
    Ok(Tunnel { local_port, task })
}

async fn authenticate(handle: &mut Handle<Verifier>, ssh: &SshConfig, secret: Option<&str>) -> Result<()> {
    let user = ssh.user.trim();
    let ssh_err = |e: russh::Error| AppError::Ssh(e.to_string());
    let rsa_hash = || async { handle.best_supported_rsa_hash().await.ok().flatten().flatten() };
    let ok = match ssh.auth {
        SshAuth::Password => handle.authenticate_password(user, secret.unwrap_or("")).await.map_err(ssh_err)?.success(),
        SshAuth::Key => {
            let path = expand_home(ssh.key_path.as_deref().unwrap_or("~/.ssh/id_ed25519"));
            let key = russh::keys::load_secret_key(&path, secret)
                .map_err(|e| AppError::Ssh(format!("Can't use key {}: {e}", path.display())))?;
            let hash = rsa_hash().await;
            handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(ssh_err)?
                .success()
        }
        SshAuth::Agent => {
            let mut agent = AgentClient::connect_env()
                .await
                .map_err(|e| AppError::Ssh(format!("Can't reach ssh-agent (is SSH_AUTH_SOCK set?): {e}")))?;
            let identities = agent.request_identities().await.map_err(|e| AppError::Ssh(e.to_string()))?;
            let hash = rsa_hash().await;
            let mut ok = false;
            for identity in identities {
                if let AgentIdentity::PublicKey { key, .. } = identity {
                    let result = handle.authenticate_publickey_with(user, key, hash, &mut agent).await;
                    if result.is_ok_and(|r| r.success()) {
                        ok = true;
                        break;
                    }
                }
            }
            ok
        }
    };
    if ok {
        Ok(())
    } else {
        Err(AppError::Ssh(format!("SSH authentication failed for {user}@{}", ssh.host.trim())))
    }
}

fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(path),
    }
}

#[derive(PartialEq)]
enum KeyStatus {
    Known,
    Unknown,
    Changed,
}

fn key_status(host: &str, port: u16, key: &PublicKey) -> KeyStatus {
    let mut status = KeyStatus::Unknown;
    for path in known_hosts_files().into_iter().filter(|p| p.exists()) {
        match russh::keys::check_known_hosts_path(host, port, key, &path) {
            Ok(true) => return KeyStatus::Known,
            Err(russh::keys::Error::KeyChanged { .. }) => status = KeyStatus::Changed,
            _ => {}
        }
    }
    status
}

struct Verifier {
    host: String,
    port: u16,
    issue: Arc<Mutex<Option<HostKeyIssue>>>,
}

impl client::Handler for Verifier {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> std::result::Result<bool, Self::Error> {
        let key = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::from(cert.public_key().clone()),
        };
        let status = key_status(&self.host, self.port, &key);
        if status == KeyStatus::Known {
            return Ok(true);
        }
        *self.issue.lock().unwrap() = Some(HostKeyIssue {
            host: self.host.clone(),
            port: self.port,
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            key: key.to_openssh().unwrap_or_default(),
            changed: status == KeyStatus::Changed,
        });
        Ok(false)
    }
}

/// A real SSH server (russh) that forwards to the dev databases.
/// Run with `ONYX_TEST_PG=1 cargo test` (and `ONYX_TEST_MYSQL=1` for the MySQL test).
/// A `Host` entry of ~/.ssh/config, to fill in a connection's tunnel.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHost {
    pub alias: String,
    pub host_name: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

/// The concrete hosts in an ssh_config (patterns with * or ? are skipped).
pub fn parse_config(text: &str) -> Vec<ConfigHost> {
    let mut hosts: Vec<ConfigHost> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_ascii_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_owned()),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                current.clear();
                for alias in value.split_whitespace().filter(|a| !a.contains(['*', '?', '!'])) {
                    current.push(hosts.len());
                    hosts.push(ConfigHost { alias: alias.into(), host_name: alias.into(), user: None, port: None, identity_file: None });
                }
            }
            "match" => current.clear(),
            "hostname" => current.iter().for_each(|&i| hosts[i].host_name = value.clone()),
            "user" => current.iter().for_each(|&i| hosts[i].user = Some(value.clone())),
            "port" => current.iter().for_each(|&i| hosts[i].port = value.parse().ok()),
            "identityfile" => current.iter().for_each(|&i| {
                if hosts[i].identity_file.is_none() {
                    hosts[i].identity_file = Some(value.clone());
                }
            }),
            _ => {}
        }
    }
    hosts
}

/// ~/.ssh/config's hosts (read only).
pub fn config_hosts() -> Vec<ConfigHost> {
    let home = std::env::var("HOME").unwrap_or_default();
    std::fs::read_to_string(format!("{home}/.ssh/config")).map(|t| parse_config(&t)).unwrap_or_default()
}

#[cfg(test)]
mod config_tests {
    use super::{parse_config, ConfigHost};

    #[test]
    fn reads_ssh_config_hosts() {
        let hosts = parse_config("Host *\n  ServerAliveInterval 30\nHost bastion prod-jump\n  HostName 10.0.0.5\n  User ec2-user\n  Port 2222\n  IdentityFile ~/.ssh/work.pem\n\nHost=dev\n HostName=dev.example.com\n");
        assert_eq!(hosts.len(), 3);
        assert_eq!(
            hosts[0],
            ConfigHost { alias: "bastion".into(), host_name: "10.0.0.5".into(), user: Some("ec2-user".into()), port: Some(2222), identity_file: Some("~/.ssh/work.pem".into()) }
        );
        assert_eq!(hosts[1].alias, "prod-jump");
        assert_eq!((hosts[2].alias.as_str(), hosts[2].host_name.as_str(), hosts[2].port), ("dev", "dev.example.com", None));
    }
}

#[cfg(test)]
mod tests {
    use russh::keys::{Algorithm, PrivateKey};
    use russh::server::{self, Auth, ChannelOpenHandle, Msg, Session};
    use russh::Channel;
    use tokio::net::TcpStream;
    use uuid::Uuid;

    use super::*;
    use crate::connections::{ConnectionConfig, Engine, Environment, SslMode};
    use crate::db::stream::testing::{event_types, recorder};
    use crate::db::Session as DbSession;

    #[derive(Clone)]
    struct TestServer {
        client_key: PublicKey,
    }

    impl server::Handler for TestServer {
        type Error = russh::Error;

        async fn auth_publickey(&mut self, _: &str, key: &PublicKey) -> std::result::Result<Auth, Self::Error> {
            Ok(if *key == self.client_key { Auth::Accept } else { Auth::reject() })
        }

        async fn auth_password(&mut self, _: &str, password: &str) -> std::result::Result<Auth, Self::Error> {
            Ok(if password == "tunnel-pass" { Auth::Accept } else { Auth::reject() })
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: Channel<Msg>,
            host: &str,
            port: u32,
            _: &str,
            _: u32,
            reply: ChannelOpenHandle,
            _: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            let target = format!("{host}:{port}");
            reply.accept().await;
            tokio::spawn(async move {
                if let Ok(mut tcp) = TcpStream::connect(target).await {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                }
            });
            Ok(())
        }
    }

    struct Fixture {
        port: u16,
        host_key: PublicKey,
        key_path: PathBuf,
    }

    async fn start_server() -> Fixture {
        set_known_hosts_path(std::env::temp_dir().join(format!("onyx-known-hosts-{}", Uuid::new_v4())));
        let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let client_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let key_path = std::env::temp_dir().join(format!("onyx-test-key-{}", Uuid::new_v4()));
        std::fs::write(&key_path, client_key.to_openssh(russh::keys::ssh_key::LineEnding::LF).unwrap()).unwrap();

        let config = Arc::new(server::Config {
            keys: vec![host_key.clone()],
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handler = TestServer { client_key: client_key.public_key().clone() };
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let (config, handler) = (config.clone(), handler.clone());
                tokio::spawn(async move {
                    if let Ok(session) = server::run_stream(config, socket, handler).await {
                        let _ = session.await;
                    }
                });
            }
        });
        Fixture { port, host_key: host_key.public_key().clone(), key_path }
    }

    fn ssh(f: &Fixture, auth: SshAuth) -> SshConfig {
        SshConfig {
            host: "127.0.0.1".into(),
            port: f.port,
            user: "tester".into(),
            auth,
            key_path: Some(f.key_path.to_string_lossy().into_owned()),
        }
    }

    fn db_config(engine: Engine, port: u16, user: &str, ssh: SshConfig) -> ConnectionConfig {
        ConnectionConfig {
            id: Uuid::new_v4(),
            engine,
            name: "tunnel".into(),
            host: "127.0.0.1".into(),
            port,
            user: user.into(),
            database: "onyx_dev".into(),
            ssl_mode: SslMode::Disable,
            environment: Environment::Local,
            color: "#000".into(),
            read_only: false,
            ssh: Some(ssh),
            folder: None,
            ai_enabled: false,
            ssl_ca: None,
            ssl_cert: None,
            ssl_key: None,
            aws_iam: None,
        }
    }

    async fn select_one(session: &DbSession) -> Vec<String> {
        let (channel, log) = recorder();
        session.run("SELECT 1", &channel).await.unwrap();
        let log = log.lock().unwrap();
        event_types(&log)
    }

    #[tokio::test]
    async fn unknown_host_needs_trust_then_tunnels_to_postgres() {
        if std::env::var("ONYX_TEST_PG").is_err() {
            return;
        }
        let f = start_server().await;
        let config = db_config(Engine::Postgres, 54329, "postgres", ssh(&f, SshAuth::Key));

        let Err(AppError::HostKey(issue)) = DbSession::connect(&config, None, None).await else {
            panic!("an unknown host must not be accepted");
        };
        assert!(!issue.changed);
        assert_eq!(issue.fingerprint, f.host_key.fingerprint(HashAlg::Sha256).to_string());

        trust_host_key(&issue.host, issue.port, &issue.key).unwrap();
        let session = DbSession::connect(&config, None, None).await.unwrap();
        assert_eq!(select_one(&session).await, ["resultStart", "resultEnd", "done"]);
    }

    #[tokio::test]
    async fn changed_host_key_is_refused() {
        if std::env::var("ONYX_TEST_PG").is_err() {
            return;
        }
        let f = start_server().await;
        let impostor = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        trust_host_key("127.0.0.1", f.port, &impostor.public_key().to_openssh().unwrap()).unwrap();

        let config = db_config(Engine::Postgres, 54329, "postgres", ssh(&f, SshAuth::Key));
        let Err(AppError::HostKey(issue)) = DbSession::connect(&config, None, None).await else {
            panic!("a changed host key must be refused");
        };
        assert!(issue.changed);
    }

    #[tokio::test]
    async fn password_auth_and_mysql_through_the_tunnel() {
        if std::env::var("ONYX_TEST_MYSQL").is_err() {
            return;
        }
        let f = start_server().await;
        trust_host_key("127.0.0.1", f.port, &f.host_key.to_openssh().unwrap()).unwrap();

        let config = db_config(Engine::Mysql, 33069, "root", ssh(&f, SshAuth::Password));
        let wrong = DbSession::connect(&config, None, Some(Zeroizing::new("nope".into()))).await;
        assert!(matches!(wrong, Err(AppError::Ssh(m)) if m.contains("authentication failed")));

        let session = DbSession::connect(&config, None, Some(Zeroizing::new("tunnel-pass".into()))).await.unwrap();
        assert_eq!(select_one(&session).await, ["resultStart", "resultEnd", "done"]);
    }
}
