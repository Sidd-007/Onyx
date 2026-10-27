//! TLS settings per SSL mode, for both engines.
//!
//! `verify-full` trusts the macOS trust store (Postgres) or Mozilla's roots (MySQL),
//! plus Amazon RDS's certificate authorities, which no default store includes.
//! `prefer` / `require` encrypt without verifying, matching libpq's semantics.

use std::sync::Arc;

use mysql_async::SslOpts;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::connections::{ConnectionConfig, SslMode};
use crate::error::{AppError, Result};

/// From https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
pub(crate) static RDS_CA_BUNDLE: &[u8] = include_bytes!("../../certs/rds-global-bundle.pem");

fn rds_roots() -> Vec<CertificateDer<'static>> {
    CertificateDer::pem_slice_iter(RDS_CA_BUNDLE).filter_map(|c| c.ok()).collect()
}

/// Makes ring the process's TLS crypto provider. Some drivers enable a second one (aws-lc via
/// tiberius), and rustls then refuses to pick one itself. Call before any TLS setup.
pub fn ensure_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// A connection's own TLS files (PEM): a CA to trust and a client certificate with its key.
#[derive(Default, Clone, Copy)]
pub struct TlsFiles<'a> {
    pub ca: Option<&'a str>,
    pub cert: Option<&'a str>,
    pub key: Option<&'a str>,
}

impl<'a> TlsFiles<'a> {
    pub fn of(config: &'a ConnectionConfig) -> Self {
        let pick = |p: &'a Option<String>| p.as_deref().map(str::trim).filter(|p| !p.is_empty());
        Self { ca: pick(&config.ssl_ca), cert: pick(&config.ssl_cert), key: pick(&config.ssl_key) }
    }
}

/// `~/x` → `$HOME/x`.
pub fn expand(path: &str) -> std::path::PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => std::path::Path::new(&std::env::var("HOME").unwrap_or_default()).join(rest),
        None => path.into(),
    }
}

fn pem_certs(path: &str) -> Result<Vec<CertificateDer<'static>>> {
    let certs: Vec<_> = CertificateDer::pem_file_iter(expand(path))
        .map_err(|e| AppError::Tls(format!("{path}: {e}")))?
        .filter_map(|c| c.ok())
        .collect();
    if certs.is_empty() {
        return Err(AppError::Tls(format!("{path} has no PEM certificates")));
    }
    Ok(certs)
}

pub fn postgres_connector(config: &ConnectionConfig) -> Result<MakeRustlsConnect> {
    Ok(MakeRustlsConnect::new(client_config_with(config.ssl_mode, TlsFiles::of(config))?))
}

/// rustls settings for an SSL mode: `verify-full` checks the certificate (system roots plus
/// Amazon RDS's); the other modes encrypt without checking it.
pub fn client_config(mode: SslMode) -> Result<ClientConfig> {
    client_config_with(mode, TlsFiles::default())
}

/// As `client_config`, also trusting the connection's CA file and presenting its client certificate.
pub fn client_config_with(mode: SslMode, files: TlsFiles<'_>) -> Result<ClientConfig> {
    ensure_provider();
    let builder = ClientConfig::builder();
    let builder = match mode {
        SslMode::VerifyFull => {
            let provider = builder.crypto_provider().clone();
            let mut roots = rds_roots();
            if let Some(ca) = files.ca {
                roots.extend(pem_certs(ca)?);
            }
            let verifier = rustls_platform_verifier::Verifier::new_with_extra_roots(roots, provider).map_err(|e| AppError::Tls(e.to_string()))?;
            builder.dangerous().with_custom_certificate_verifier(Arc::new(verifier))
        }
        SslMode::Disable | SslMode::Prefer | SslMode::Require => {
            builder.dangerous().with_custom_certificate_verifier(Arc::new(NoCertificateVerification::new()))
        }
    };
    match (files.cert, files.key) {
        (Some(cert), Some(key)) => {
            let key = PrivateKeyDer::from_pem_file(expand(key)).map_err(|e| AppError::Tls(format!("{key}: {e}")))?;
            builder.with_client_auth_cert(pem_certs(cert)?, key).map_err(|e| AppError::Tls(e.to_string()))
        }
        (Some(_), None) | (None, Some(_)) => Err(AppError::Tls("A client certificate needs both the certificate and its key".into())),
        (None, None) => Ok(builder.with_no_client_auth()),
    }
}

pub fn mysql_ssl_opts(mode: SslMode, files: TlsFiles<'_>) -> Option<SslOpts> {
    let opts = match mode {
        SslMode::Disable => return None,
        SslMode::Prefer | SslMode::Require => SslOpts::default().with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true),
        SslMode::VerifyFull => {
            let mut roots = vec![RDS_CA_BUNDLE.into()];
            if let Some(ca) = files.ca {
                roots.push(expand(ca).into());
            }
            SslOpts::default().with_root_certs(roots)
        }
    };
    Some(match (files.cert, files.key) {
        (Some(cert), Some(key)) => opts.with_client_identity(Some(mysql_async::ClientIdentity::new(expand(cert).into(), expand(key).into()))),
        _ => opts,
    })
}

/// Accepts any certificate but still checks handshake signatures.
#[derive(Debug)]
struct NoCertificateVerification(WebPkiSupportedAlgorithms);

impl NoCertificateVerification {
    fn new() -> Self {
        Self(rustls::crypto::ring::default_provider().signature_verification_algorithms)
    }
}

impl ServerCertVerifier for NoCertificateVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.0)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.0)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn rds_bundle_parses_and_covers_mumbai() {
        let roots = super::rds_roots();
        assert!(roots.len() > 100, "got {} roots", roots.len());
        let pem = String::from_utf8_lossy(super::RDS_CA_BUNDLE);
        assert_eq!(pem.matches("BEGIN CERTIFICATE").count(), roots.len());
    }
}
