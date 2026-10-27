//! A minimal HTTP(S) client on the rustls stack Onyx already ships: one JSON POST (the
//! Claude API), and streamed responses (ClickHouse results).

use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use crate::error::{AppError, Result};

pub struct Response {
    pub status: u16,
    pub body: String,
}

fn connector() -> Result<TlsConnector> {
    crate::db::tls::ensure_provider();
    let builder = rustls::ClientConfig::builder();
    let provider = builder.crypto_provider().clone();
    let verifier = rustls_platform_verifier::Verifier::new_with_extra_roots(vec![], provider)
        .map_err(|e| AppError::Tls(e.to_string()))?;
    let mut config = builder.dangerous().with_custom_certificate_verifier(Arc::new(verifier)).with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(TlsConnector::from(Arc::new(config)))
}

/// POSTs `body` as JSON to `https://{host}{path}` and returns the response.
pub async fn post_json(host: &str, path: &str, headers: &[(&str, &str)], body: &str, timeout: Duration) -> Result<Response> {
    let request = async {
        let tcp = TcpStream::connect((host, 443)).await?;
        let name = ServerName::try_from(host.to_owned()).map_err(|e| AppError::Tls(e.to_string()))?;
        let mut tls = connector()?.connect(name, tcp).await?;
        let mut head = format!(
            "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nUser-Agent: Onyx\r\n",
            body.len()
        );
        for (k, v) in headers {
            head += &format!("{k}: {v}\r\n");
        }
        head += "\r\n";
        tls.write_all(head.as_bytes()).await?;
        tls.write_all(body.as_bytes()).await?;
        tls.flush().await?;
        let mut raw = Vec::new();
        // Some servers close without TLS close_notify; keep what arrived.
        if let Err(e) = tls.read_to_end(&mut raw).await
            && raw.is_empty()
        {
            return Err(e.into());
        }
        parse(&raw)
    };
    tokio::time::timeout(timeout, request)
        .await
        .map_err(|_| AppError::Invalid(format!("{host} didn't answer within {} s", timeout.as_secs())))?
}

fn parse(raw: &[u8]) -> Result<Response> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| AppError::Invalid("Malformed HTTP response".into()))?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| AppError::Invalid("Malformed HTTP status line".into()))?;
    let chunked = lines.any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    let rest = &raw[split + 4..];
    let body = if chunked { dechunk(rest)? } else { rest.to_vec() };
    Ok(Response { status, body: String::from_utf8_lossy(&body).into_owned() })
}

/// Decodes `Transfer-Encoding: chunked`.
fn dechunk(mut data: &[u8]) -> Result<Vec<u8>> {
    let bad = || AppError::Invalid("Malformed chunked HTTP body".into());
    let mut out = Vec::new();
    loop {
        let line_end = data.windows(2).position(|w| w == b"\r\n").ok_or_else(bad)?;
        let size_text = String::from_utf8_lossy(&data[..line_end]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16).map_err(|_| bad())?;
        data = &data[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if data.len() < size {
            return Err(bad());
        }
        out.extend_from_slice(&data[..size]);
        data = data.get(size + 2..).unwrap_or_default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_chunked_responses() {
        let plain = parse(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi").unwrap();
        assert_eq!((plain.status, plain.body.as_str()), (200, "hi"));
        let chunked = parse(b"HTTP/1.1 400 Bad Request\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n3;x=1\r\n:1}\r\n0\r\n\r\n").unwrap();
        assert_eq!((chunked.status, chunked.body.as_str()), (400, "{\"a\":1}"));
        assert!(parse(b"garbage").is_err());
    }
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// Where to send requests: plain HTTP or HTTPS, and how to check the certificate.
#[derive(Clone)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    /// `None`: plain HTTP. `Some`: TLS with this rustls config.
    pub tls: Option<Arc<rustls::ClientConfig>>,
    /// The name the certificate must carry (the real host when tunnelling).
    pub server_name: String,
}

/// A response whose body is read as it arrives.
pub struct Streamed {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    io: Box<dyn Io>,
    buffer: Vec<u8>,
    body: Body,
}

enum Body {
    Chunked { remaining: usize, done: bool },
    Length(usize),
    UntilClose,
}

/// Reads more of the response into `buffer`; false at the end of the stream.
async fn fill(io: &mut Box<dyn Io>, buffer: &mut Vec<u8>) -> Result<bool> {
    // Straight into the buffer: an array here would sit inside every future that awaits this.
    buffer.reserve(64 * 1024);
    let n = match io.read_buf(buffer).await {
        Ok(n) => n,
        // Servers that close without TLS close_notify: treat as the end.
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => 0,
        Err(e) => return Err(e.into()),
    };
    Ok(n > 0)
}

impl Streamed {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }


    /// The next piece of the body, or `None` at the end.
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>> {
        let bad = || AppError::Invalid("Malformed chunked HTTP body".into());
        loop {
            match &mut self.body {
                Body::Length(0) | Body::Chunked { done: true, .. } => return Ok(None),
                Body::Length(left) => {
                    if self.buffer.is_empty() && !fill(&mut self.io, &mut self.buffer).await? {
                        return Ok(None);
                    }
                    let take = (*left).min(self.buffer.len());
                    *left -= take;
                    return Ok(Some(self.buffer.drain(..take).collect()));
                }
                Body::UntilClose => {
                    if self.buffer.is_empty() && !fill(&mut self.io, &mut self.buffer).await? {
                        return Ok(None);
                    }
                    return Ok(Some(std::mem::take(&mut self.buffer)));
                }
                Body::Chunked { remaining, done } => {
                    if *remaining > 0 {
                        if self.buffer.is_empty() && !fill(&mut self.io, &mut self.buffer).await? {
                            return Err(bad());
                        }
                        let take = (*remaining).min(self.buffer.len());
                        *remaining -= take;
                        let out: Vec<u8> = self.buffer.drain(..take).collect();
                        return Ok(Some(out));
                    }
                    // A size line (after the previous chunk's CRLF).
                    loop {
                        let start = if self.buffer.starts_with(b"\r\n") { 2 } else { 0 };
                        if let Some(end) = self.buffer[start..].windows(2).position(|w| w == b"\r\n") {
                            let line = String::from_utf8_lossy(&self.buffer[start..start + end]).to_string();
                            let size = usize::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16).map_err(|_| bad())?;
                            self.buffer.drain(..start + end + 2);
                            if size == 0 {
                                *done = true;
                            } else {
                                *remaining = size;
                            }
                            break;
                        }
                        if !fill(&mut self.io, &mut self.buffer).await? {
                            return Err(bad());
                        }
                    }
                }
            }
        }
    }

    /// The whole (rest of the) body as text.
    pub async fn text(mut self) -> Result<String> {
        let mut out = Vec::new();
        while let Some(c) = self.chunk().await? {
            out.extend(c);
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

/// Sends a request and returns once the response headers are in; the body streams.
pub async fn request(
    endpoint: &Endpoint,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    timeout: Duration,
) -> Result<Streamed> {
    let connect = async {
        let tcp = TcpStream::connect((endpoint.host.as_str(), endpoint.port)).await?;
        tcp.set_nodelay(true)?;
        let mut io: Box<dyn Io> = match &endpoint.tls {
            None => Box::new(tcp),
            Some(config) => {
                let name = ServerName::try_from(endpoint.server_name.clone()).map_err(|e| AppError::Tls(e.to_string()))?;
                Box::new(TlsConnector::from(config.clone()).connect(name, tcp).await?)
            }
        };
        let mut head = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nContent-Length: {}\r\nConnection: close\r\nUser-Agent: Onyx\r\n",
            endpoint.server_name,
            body.len()
        );
        for (k, v) in headers {
            head += &format!("{k}: {v}\r\n");
        }
        head += "\r\n";
        io.write_all(head.as_bytes()).await?;
        io.write_all(body).await?;
        io.flush().await?;
        // Read up to the end of the headers.
        let mut buffer = Vec::new();
        let split = loop {
            if let Some(p) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                break p;
            }
            buffer.reserve(16 * 1024);
            if io.read_buf(&mut buffer).await? == 0 {
                return Err(AppError::Invalid(format!("{} closed the connection", endpoint.host)));
            }
        };
        let head = String::from_utf8_lossy(&buffer[..split]).to_string();
        let rest = buffer[split + 4..].to_vec();
        let mut lines = head.lines();
        let status = lines
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| AppError::Invalid("Malformed HTTP status line".into()))?;
        let headers: Vec<(String, String)> = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
            .collect();
        let find = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.to_ascii_lowercase());
        let body = if find("transfer-encoding").is_some_and(|v| v.contains("chunked")) {
            Body::Chunked { remaining: 0, done: false }
        } else if let Some(n) = find("content-length").and_then(|v| v.parse().ok()) {
            Body::Length(n)
        } else {
            Body::UntilClose
        };
        Ok::<_, AppError>(Streamed { status, headers, io, buffer: rest, body })
    };
    tokio::time::timeout(timeout, connect)
        .await
        .map_err(|_| AppError::Invalid(format!("{}:{} didn't answer within {} s", endpoint.host, endpoint.port, timeout.as_secs())))?
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    use tokio::net::TcpListener;

    async fn serve_once(response: &'static [u8]) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await;
            // Dribble the response out in small pieces.
            for piece in response.chunks(7) {
                socket.write_all(piece).await.unwrap();
                socket.flush().await.unwrap();
            }
        });
        port
    }

    fn local(port: u16) -> Endpoint {
        Endpoint { host: "127.0.0.1".into(), port, tls: None, server_name: "localhost".into() }
    }

    #[tokio::test]
    async fn streams_chunked_and_sized_bodies() {
        let port = serve_once(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nX-Test: yes\r\n\r\n5\r\nhello\r\n7\r\n, world\r\n0\r\n\r\n").await;
        let r = request(&local(port), "POST", "/", &[], b"q", Duration::from_secs(5)).await.unwrap();
        assert_eq!((r.status, r.header("x-test")), (200, Some("yes")));
        assert_eq!(r.text().await.unwrap(), "hello, world");

        let port = serve_once(b"HTTP/1.1 500 Oops\r\nContent-Length: 4\r\n\r\nboom").await;
        let r = request(&local(port), "GET", "/", &[], b"", Duration::from_secs(5)).await.unwrap();
        assert_eq!(r.status, 500);
        assert_eq!(r.text().await.unwrap(), "boom");
    }
}
