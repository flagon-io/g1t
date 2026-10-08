//! Just enough HTTP/1.1 to stand between the Docker CLI and the Engine:
//! message heads, and bodies framed by `Content-Length`, chunked, or the
//! end of the connection. Bodies pass through as they come (a chunk at a
//! time, so `docker logs -f` and a pull's progress keep streaming), unless
//! the proxy reads one whole to change it.

use std::io::{self, BufRead, Read, Write};

/// The most a message head may be. The Engine's and the CLI's are a few
/// hundred bytes.
const MAX_HEAD: usize = 64 * 1024;
/// The most a body read whole may be: a container's config or inspection
/// is a few kilobytes.
pub(crate) const MAX_BODY: u64 = 16 * 1024 * 1024;

/// A request's or a response's start line and headers.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Head {
    pub(crate) start: String,
    pub(crate) headers: Vec<(String, String)>,
}

impl Head {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    pub(crate) fn remove_header(&mut self, name: &str) {
        self.headers.retain(|(key, _)| !key.eq_ignore_ascii_case(name));
    }

    pub(crate) fn set_header(&mut self, name: &str, value: &str) {
        self.remove_header(name);
        self.headers.push((name.to_owned(), value.to_owned()));
    }

    /// A request's method.
    pub(crate) fn method(&self) -> &str {
        self.start.split(' ').next().unwrap_or_default()
    }

    /// A request's target: its path and query.
    pub(crate) fn target(&self) -> &str {
        self.start.split(' ').nth(1).unwrap_or_default()
    }

    pub(crate) fn set_target(&mut self, target: &str) {
        let mut parts: Vec<&str> = self.start.splitn(3, ' ').collect();
        if parts.len() == 3 {
            parts[1] = target;
            self.start = parts.join(" ");
        }
    }

    /// A response's status code.
    pub(crate) fn status(&self) -> u16 {
        self.start.split(' ').nth(1).and_then(|code| code.parse().ok()).unwrap_or(0)
    }

    /// Whether the request asks to leave HTTP (`docker attach`, `exec`,
    /// BuildKit's `/grpc` and `/session`).
    pub(crate) fn upgrades(&self) -> bool {
        self.header("upgrade").is_some() || self.header("connection").is_some_and(|value| value.to_ascii_lowercase().contains("upgrade"))
    }

    pub(crate) fn to_bytes(&self) -> Vec<u8> {
        let mut out = String::with_capacity(256);
        out.push_str(&self.start);
        out.push_str("\r\n");
        for (name, value) in &self.headers {
            out.push_str(name);
            out.push_str(": ");
            out.push_str(value);
            out.push_str("\r\n");
        }
        out.push_str("\r\n");
        out.into_bytes()
    }
}

/// Reads a message head. `None` when the connection ends before one starts.
pub(crate) fn read_head<R: BufRead>(reader: &mut R) -> io::Result<Option<Head>> {
    let mut lines: Vec<String> = Vec::new();
    let mut size = 0;
    loop {
        let mut line = Vec::new();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 {
            if lines.is_empty() {
                return Ok(None);
            }
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the connection ended inside a message head"));
        }
        size += read;
        if size > MAX_HEAD {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "a message head too large"));
        }
        let text = String::from_utf8_lossy(&line).trim_end_matches(['\r', '\n']).to_owned();
        if text.is_empty() {
            // Blank lines before a request are allowed, and skipped.
            if lines.is_empty() {
                continue;
            }
            break;
        }
        lines.push(text);
    }
    let start = lines.remove(0);
    let headers = lines
        .into_iter()
        .filter_map(|line| line.split_once(':').map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned())))
        .collect();
    Ok(Some(Head { start, headers }))
}

/// How a message's body ends.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Body {
    None,
    Length(u64),
    Chunked,
    /// Until the connection closes: a response with no length.
    UntilClose,
}

fn chunked(head: &Head) -> bool {
    head.header("transfer-encoding").is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
}

fn length(head: &Head) -> Option<u64> {
    head.header("content-length").and_then(|value| value.trim().parse().ok())
}

/// A request's body: chunked, a length, or none.
pub(crate) fn request_body(head: &Head) -> Body {
    if chunked(head) {
        Body::Chunked
    } else {
        match length(head) {
            Some(0) | None => Body::None,
            Some(n) => Body::Length(n),
        }
    }
}

/// A response's body, which also depends on what was asked.
pub(crate) fn response_body(head: &Head, method: &str) -> Body {
    let status = head.status();
    if method.eq_ignore_ascii_case("HEAD") || (100..200).contains(&status) || status == 204 || status == 304 {
        return Body::None;
    }
    if chunked(head) {
        return Body::Chunked;
    }
    match length(head) {
        Some(0) => Body::None,
        Some(n) => Body::Length(n),
        None => Body::UntilClose,
    }
}

/// Copies a body as it is framed, flushing as each piece arrives.
pub(crate) fn copy_body<R: BufRead, W: Write>(reader: &mut R, writer: &mut W, body: Body) -> io::Result<()> {
    match body {
        Body::None => Ok(()),
        Body::Length(n) => {
            let copied = io::copy(&mut reader.take(n), writer)?;
            writer.flush()?;
            if copied < n {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the body ended early"));
            }
            Ok(())
        }
        Body::UntilClose => {
            io::copy(reader, writer)?;
            writer.flush()
        }
        Body::Chunked => loop {
            let mut line = Vec::new();
            if reader.read_until(b'\n', &mut line)? == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "a chunked body ended early"));
            }
            writer.write_all(&line)?;
            let size = chunk_size(&line)?;
            if size == 0 {
                // Trailers, then a blank line.
                loop {
                    let mut trailer = Vec::new();
                    if reader.read_until(b'\n', &mut trailer)? == 0 {
                        break;
                    }
                    writer.write_all(&trailer)?;
                    if trailer == b"\r\n" || trailer == b"\n" {
                        break;
                    }
                }
                writer.flush()?;
                return Ok(());
            }
            // The chunk and its CRLF.
            let copied = io::copy(&mut reader.take(size + 2), writer)?;
            writer.flush()?;
            if copied < size + 2 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "a chunk ended early"));
            }
        },
    }
}

fn chunk_size(line: &[u8]) -> io::Result<u64> {
    let text = String::from_utf8_lossy(line);
    let hex = text.trim().split(';').next().unwrap_or_default().trim();
    u64::from_str_radix(hex, 16).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, format!("not a chunk size: {hex:?}")))
}

/// Reads a whole body, unframed.
pub(crate) fn read_body<R: BufRead>(reader: &mut R, body: Body) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    match body {
        Body::None => {}
        Body::Length(n) => {
            if n > MAX_BODY {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "a body too large to read"));
            }
            reader.take(n).read_to_end(&mut out)?;
            if (out.len() as u64) < n {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the body ended early"));
            }
        }
        Body::UntilClose => {
            reader.take(MAX_BODY).read_to_end(&mut out)?;
        }
        Body::Chunked => loop {
            let mut line = Vec::new();
            if reader.read_until(b'\n', &mut line)? == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "a chunked body ended early"));
            }
            let size = chunk_size(&line)?;
            if size == 0 {
                loop {
                    let mut trailer = Vec::new();
                    if reader.read_until(b'\n', &mut trailer)? == 0 || trailer == b"\r\n" || trailer == b"\n" {
                        break;
                    }
                }
                break;
            }
            if out.len() as u64 + size > MAX_BODY {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "a body too large to read"));
            }
            let mut chunk = Vec::new();
            reader.take(size).read_to_end(&mut chunk)?;
            out.extend_from_slice(&chunk);
            let mut crlf = Vec::new();
            reader.read_until(b'\n', &mut crlf)?;
        },
    }
    Ok(out)
}

/// A head with its body framed by length, for a body the proxy rewrote.
pub(crate) fn with_length(mut head: Head, body: &[u8]) -> Vec<u8> {
    head.remove_header("transfer-encoding");
    head.set_header("Content-Length", &body.len().to_string());
    let mut out = head.to_bytes();
    out.extend_from_slice(body);
    out
}

/// A whole JSON response, as the Engine words its errors.
pub(crate) fn json_response(status: u16, reason: &str, body: &serde_json::Value) -> Vec<u8> {
    let text = body.to_string();
    let head = Head {
        start: format!("HTTP/1.1 {status} {reason}"),
        headers: vec![("Content-Type".into(), "application/json".into())],
    };
    with_length(head, text.as_bytes())
}

/// An empty `200 OK`.
pub(crate) fn empty_ok() -> Vec<u8> {
    with_length(Head { start: "HTTP/1.1 200 OK".into(), headers: Vec::new() }, b"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    #[test]
    fn heads_are_read_and_written_back() {
        let raw = b"POST /v1.47/containers/create?name=db HTTP/1.1\r\nHost: api.moby.localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
        let mut reader = BufReader::new(&raw[..]);
        let head = read_head(&mut reader).unwrap().unwrap();
        assert_eq!(head.method(), "POST");
        assert_eq!(head.target(), "/v1.47/containers/create?name=db");
        assert_eq!(head.header("content-length"), Some("2"));
        assert_eq!(request_body(&head), Body::Length(2));
        assert_eq!(read_body(&mut reader, Body::Length(2)).unwrap(), b"{}");
        assert!(read_head(&mut reader).unwrap().is_none());
        let mut again = head.clone();
        again.set_target("/v1.47/containers/create");
        assert!(String::from_utf8(again.to_bytes()).unwrap().starts_with("POST /v1.47/containers/create HTTP/1.1\r\n"));
    }

    #[test]
    fn chunked_bodies_copy_verbatim_and_read_unframed() {
        let raw = b"5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\n\r\nNEXT";
        let mut copied = Vec::new();
        let mut reader = BufReader::new(&raw[..]);
        copy_body(&mut reader, &mut copied, Body::Chunked).unwrap();
        assert_eq!(copied, &raw[..raw.len() - 4]);
        let mut rest = String::new();
        reader.read_to_string(&mut rest).unwrap();
        assert_eq!(rest, "NEXT");
        let mut reader = BufReader::new(&raw[..]);
        assert_eq!(read_body(&mut reader, Body::Chunked).unwrap(), b"hello world");
    }

    #[test]
    fn response_bodies_follow_the_request_and_the_status() {
        let head = |start: &str, headers: &[(&str, &str)]| Head {
            start: start.into(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        };
        assert_eq!(response_body(&head("HTTP/1.1 200 OK", &[("Content-Length", "10")]), "HEAD"), Body::None);
        assert_eq!(response_body(&head("HTTP/1.1 204 No Content", &[]), "POST"), Body::None);
        assert_eq!(response_body(&head("HTTP/1.1 101 UPGRADED", &[]), "POST"), Body::None);
        assert_eq!(response_body(&head("HTTP/1.1 200 OK", &[("Transfer-Encoding", "chunked")]), "GET"), Body::Chunked);
        assert_eq!(response_body(&head("HTTP/1.1 200 OK", &[]), "GET"), Body::UntilClose);
        assert!(head("POST /grpc HTTP/1.1", &[("Connection", "Upgrade"), ("Upgrade", "h2c")]).upgrades());
    }

    #[test]
    fn a_rewritten_body_gets_its_length() {
        let head = Head { start: "HTTP/1.1 200 OK".into(), headers: vec![("Transfer-Encoding".into(), "chunked".into())] };
        let out = String::from_utf8(with_length(head, b"{\"a\":1}")).unwrap();
        assert!(out.contains("Content-Length: 7\r\n"));
        assert!(!out.to_ascii_lowercase().contains("chunked"));
        assert!(out.ends_with("\r\n\r\n{\"a\":1}"));
    }
}
