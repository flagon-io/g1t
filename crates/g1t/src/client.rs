//! Calls to the g1t API.

use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::time::Duration;

use crate::auth::Host;
use crate::error::{Error, Result};
use crate::ops::{self, Operation};
use crate::repo::Repo;

pub struct Client {
    pub host: Host,
    token: Option<String>,
    agent: ureq::Agent,
    debug: bool,
}

/// What came back from a raw request, for `g1t api`.
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub text: String,
}

impl Reply {
    pub fn json(&self) -> Option<Value> {
        if self.text.trim().is_empty() {
            return Some(Value::Null);
        }
        serde_json::from_str(&self.text).ok()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Encodes one segment of a path: a branch's `/` stays inside the segment.
pub fn encode_segment(segment: &str) -> String {
    let mut out = String::new();
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

impl Client {
    pub fn new(host: Host, token: Option<String>) -> Client {
        let agent = crate::http::builder()
            .timeout_connect(Duration::from_secs(15))
            .timeout_read(Duration::from_secs(120))
            .user_agent(&format!("g1t-cli/{}", env!("CARGO_PKG_VERSION")))
            .redirects(5)
            .build();
        let debug = std::env::var("G1T_DEBUG").is_ok_and(|v| !v.is_empty() && v != "0");
        Client {
            host,
            token,
            agent,
            debug,
        }
    }

    /// The same client, giving up sooner: for commands an agent's hooks run
    /// in the background, which must not hang on a slow network.
    pub fn with_timeouts(mut self, connect: Duration, read: Duration) -> Client {
        self.agent = crate::http::builder()
            .timeout_connect(connect)
            .timeout_read(read)
            .timeout_write(read)
            .user_agent(&format!("g1t-cli/{}", env!("CARGO_PKG_VERSION")))
            .redirects(5)
            .build();
        self
    }

    pub fn has_token(&self) -> bool {
        self.token.is_some()
    }

    /// Starts a call to the operation `id`.
    pub fn op(&self, id: &str) -> Call<'_> {
        Call {
            client: self,
            op: ops::get(id),
            path: BTreeMap::new(),
            query: Vec::new(),
            body: None,
        }
    }

    /// A request to `path` (under the API), answered with whatever status.
    pub fn raw(
        &self,
        method: &str,
        path_or_url: &str,
        query: &[(String, String)],
        headers: &[(String, String)],
        body: Option<Vec<u8>>,
    ) -> Result<Reply> {
        let url = if path_or_url.starts_with("http://") || path_or_url.starts_with("https://") {
            path_or_url.to_owned()
        } else {
            format!("{}/{}", self.host.api, path_or_url.trim_start_matches('/'))
        };
        let mut request = self
            .agent
            .request(method, &url)
            .set("accept", "application/json");
        if let Some(token) = &self.token {
            request = request.set("authorization", &format!("Bearer {token}"));
        }
        for (k, v) in query {
            request = request.query(k, v);
        }
        let has_type = headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("content-type"));
        for (k, v) in headers {
            request = request.set(k, v);
        }
        if self.debug {
            eprintln!("* {method} {}", request.url());
        }
        let result = match body {
            Some(bytes) => {
                if !has_type {
                    request = request.set("content-type", "application/json");
                }
                request.send_bytes(&bytes)
            }
            None => request.call(),
        };
        let response = match result {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(ureq::Error::Transport(t)) => {
                return Err(Error::failed(format!(
                    "Could not reach {}: {t}",
                    self.host.api
                )));
            }
        };
        let status = response.status();
        let headers = response
            .headers_names()
            .into_iter()
            .filter_map(|name| response.header(&name).map(|v| (name.clone(), v.to_owned())))
            .collect();
        let mut text = String::new();
        response
            .into_reader()
            .take(256 * 1024 * 1024)
            .read_to_string(&mut text)
            .map_err(|e| {
                Error::failed(format!(
                    "Could not read the answer from {}: {e}",
                    self.host.api
                ))
            })?;
        if self.debug {
            eprintln!("* {status}");
        }
        Ok(Reply {
            status,
            headers,
            text,
        })
    }

    /// A request whose answer must be a success, as JSON.
    pub fn send(
        &self,
        method: &str,
        path: &str,
        query: &[(String, String)],
        body: Option<&Value>,
    ) -> Result<Value> {
        let bytes = body.map(|b| serde_json::to_vec(b).expect("json"));
        let reply = self.raw(method, path, query, &[], bytes)?;
        if older_server(&reply) {
            return Err(Error::failed(format!(
                "{} has no {method} {path}: the g1t server is older than this CLI ({}), and cannot do this yet.",
                self.host.api,
                env!("CARGO_PKG_VERSION")
            )));
        }
        if !(200..300).contains(&reply.status) {
            return Err(self.api_error(&reply));
        }
        Ok(reply.json().unwrap_or(Value::String(reply.text)))
    }

    /// One line saying why the API refused.
    pub fn api_error(&self, reply: &Reply) -> Error {
        let body = reply.json().unwrap_or(Value::Null);
        let message = body["error"]["message"]
            .as_str()
            .or_else(|| body["message"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let text = reply.text.trim();
                if text.is_empty() || text.starts_with('<') {
                    format!("{} answered HTTP {}", self.host.api, reply.status)
                } else {
                    text.lines().next().unwrap_or_default().to_owned()
                }
            });
        let message = message.trim_end_matches('.').to_owned();
        match reply.status {
            401 if self.token.is_none() => Error::auth(format!(
                "{message}. Sign in with `g1t auth login{}`, or set G1T_TOKEN.",
                self.hostname_flag()
            )),
            401 => Error::auth(format!(
                "{message}. The token for {} was refused: sign in again with `g1t auth login{}`.",
                self.host.name,
                self.hostname_flag()
            )),
            403 => match body["error"]["needed_scope"].as_str() {
                Some(scope) => Error::failed(format!(
                    "{message}. The token needs the `{scope}` scope: make one with it at {}/settings/tokens.",
                    self.host.site
                )),
                None => Error::failed(format!("{message}.")),
            },
            404 if self.token.is_none() => Error::failed(format!(
                "{message}. If it is private, sign in first: `g1t auth login{}`.",
                self.hostname_flag()
            )),
            _ => Error::failed(format!("{message}.")),
        }
    }

    fn hostname_flag(&self) -> String {
        if self.host.name == crate::config::DEFAULT_HOST {
            String::new()
        } else {
            format!(" --hostname {}", self.host.name)
        }
    }
}

/// Whether the API answered that it has no such route at all, as a server
/// older than the CLI does for an operation it does not have, rather than
/// that the thing asked about was not found.
pub fn older_server(reply: &Reply) -> bool {
    reply.status == 404
        && reply
            .json()
            .is_some_and(|body| body["error"]["message"].as_str() == Some("No such endpoint."))
}

/// One call to an operation, its path filled in as it is built.
pub struct Call<'a> {
    client: &'a Client,
    op: &'static Operation,
    path: BTreeMap<&'static str, String>,
    query: Vec<(String, String)>,
    body: Option<Map<String, Value>>,
}

impl<'a> Call<'a> {
    pub fn arg(mut self, name: &str, value: impl ToString) -> Self {
        let param = self
            .op
            .path_params()
            .find(|p| p.name == name)
            .unwrap_or_else(|| panic!("{} has no path parameter {name}", self.op.id));
        self.path.insert(param.name, value.to_string());
        self
    }

    /// The repository's owner and name.
    pub fn repo(self, repo: &Repo) -> Self {
        self.arg("owner", &repo.owner).arg("name", &repo.name)
    }

    pub fn query(mut self, name: &str, value: impl ToString) -> Self {
        self.query.push((name.to_owned(), value.to_string()));
        self
    }

    pub fn query_opt<T: ToString>(self, name: &str, value: Option<T>) -> Self {
        match value {
            Some(v) => self.query(name, v),
            None => self,
        }
    }

    pub fn field(mut self, name: &str, value: impl Into<Value>) -> Self {
        self.body
            .get_or_insert_with(Map::new)
            .insert(name.to_owned(), value.into());
        self
    }

    pub fn field_opt<T: Into<Value>>(self, name: &str, value: Option<T>) -> Self {
        match value {
            Some(v) => self.field(name, v),
            None => self,
        }
    }

    pub fn path(&self) -> String {
        let mut path = self.op.path.to_owned();
        for p in self.op.path_params() {
            let value = self
                .path
                .get(p.name)
                .unwrap_or_else(|| panic!("{} needs {}", self.op.id, p.name));
            path = path.replace(&format!("{{{}}}", p.name), &encode_segment(value));
        }
        path
    }

    pub fn send(self) -> Result<Value> {
        let path = self.path();
        let body = match (self.body, self.op.method) {
            (Some(map), _) => Some(Value::Object(map)),
            (None, "POST" | "PUT" | "PATCH") => Some(Value::Object(Map::new())),
            (None, _) => None,
        };
        self.client
            .send(self.op.method, &path, &self.query, body.as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_are_encoded() {
        assert_eq!(encode_segment("feature/x y"), "feature%2Fx%20y");
        assert_eq!(encode_segment("NPM_TOKEN"), "NPM_TOKEN");
    }

    #[test]
    fn calls_fill_their_path() {
        let client = Client::new(Host::hosted(), None);
        let repo = Repo {
            host: "g1t.sh".into(),
            owner: "acme".into(),
            name: "web".into(),
        };
        let call = client.op("get_pull_request").repo(&repo).arg("number", 12);
        assert_eq!(call.path(), "/repos/acme/web/pulls/12");
        let call = client.op("get_work_item").arg("workspace", "acme").arg("number", 12);
        assert_eq!(call.path(), "/workspaces/acme/work/12");
    }
}
