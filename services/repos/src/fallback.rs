//! The cold fallback for the git store. CONTRIBUTING.md ("Operating
//! g1t.sh") says when to switch to it; scripts/ops/restore-to-gitstore.mjs
//! has every step.
//!
//! When Artifacts is down for a namespace, the repos service can serve that
//! namespace from a self-hosted git store instead
//! (`deploy/self-host/gitstore`), rebuilt from the nightly backups
//! (`scripts/ops/restore-to-gitstore.mjs`). It is switched by
//! configuration, not code:
//!
//! - `GIT_FALLBACK_URL`: where the git store answers, `https://...`.
//! - `GIT_FALLBACK_SECRET` (a secret): the store's API secret.
//! - `GIT_FALLBACK_NAMESPACES`: the namespaces served from it, comma
//!   separated, or `*` for all. Unset or empty: none, and nothing changes.
//! - `GIT_FALLBACK_WRITES`: `refuse` (the default) or `allow`. While
//!   refused, a switched namespace is read-only: clones, fetches and pages
//!   work; pushes, merges and new repositories wait, told so in words.
//!
//! The store keeps each namespace's repositories under its own directory,
//! so the key `g1t-us-1/acme--rocket` is `g1t-us-1/acme--rocket` there and
//! `acme--rocket` (the default namespace) is `g1t/acme--rocket`. Its remotes
//! read `<url>/git/<namespace>/<name>.git`, the shape Artifacts uses.
//!
//! This module is the plain part: the settings, and how each call the
//! service makes on an Artifacts binding becomes a request to the store's
//! API and back. store.rs makes the requests.

use serde_json::{Value, json};

/// The fallback store's settings, when it is configured at all.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    /// Where the store answers, without a trailing slash.
    pub url: String,
    pub secret: String,
    pub switched: Switched,
    /// Whether a switched namespace takes writes.
    pub writes: bool,
}

/// Which namespaces are served from the fallback store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Switched {
    All,
    Some(Vec<String>),
}

impl Settings {
    /// The settings from the variables, or `None` when there is no store
    /// to fall back to (no address, or no secret).
    pub fn from_vars(url: Option<&str>, secret: Option<&str>, namespaces: Option<&str>, writes: Option<&str>) -> Option<Self> {
        let url = url.map(str::trim).filter(|url| url.starts_with("https://") || url.starts_with("http://"))?;
        let secret = secret.map(str::trim).filter(|secret| secret.len() >= 16)?;
        let namespaces = namespaces.unwrap_or_default().trim();
        let switched = if namespaces == "*" {
            Switched::All
        } else {
            Switched::Some(
                namespaces
                    .split(',')
                    .map(str::trim)
                    .filter(|name| crate::shards::valid_namespace(name))
                    .map(str::to_owned)
                    .collect(),
            )
        };
        Some(Settings {
            url: url.trim_end_matches('/').to_owned(),
            secret: secret.to_owned(),
            switched,
            writes: writes.is_some_and(|value| value.trim().eq_ignore_ascii_case("allow")),
        })
    }

    /// Whether `namespace` is served from the fallback store now.
    pub fn serves(&self, namespace: &str) -> bool {
        match &self.switched {
            Switched::All => true,
            Switched::Some(names) => names.iter().any(|name| name == namespace),
        }
    }

    /// The remote git uses for `name` in `namespace`.
    pub fn remote(&self, namespace: &str, name: &str) -> String {
        format!("{}/git/{}.git", self.url, store_key(namespace, name))
    }
}

/// A repository's key in the fallback store: always with its namespace.
pub fn store_key(namespace: &str, name: &str) -> String {
    format!("{namespace}/{name}")
}

/// Percent-encodes one path segment.
fn segment(text: &str) -> String {
    text.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// Percent-encodes a query value.
fn query(pairs: &[(&str, String)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{key}={}", segment(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// How a call on the binding is asked of the store's API.
#[derive(Debug, PartialEq)]
pub struct Route {
    pub method: &'static str,
    /// Below the store's address: `/api/repos/...`.
    pub path: String,
    pub body: Option<Value>,
    /// What the answer is: JSON, or bytes (a blob or a file).
    pub bytes: bool,
}

/// A call the fallback cannot make, as the binding would have thrown it.
#[derive(Debug, PartialEq)]
pub struct Refused {
    pub code: &'static str,
    pub message: String,
}

fn arg<'a>(args: &'a [Value], at: usize) -> &'a Value {
    args.get(at).unwrap_or(&Value::Null)
}

fn text(args: &[Value], at: usize) -> Result<String, Refused> {
    arg(args, at).as_str().map(str::to_owned).ok_or_else(|| Refused {
        code: "INVALID_ARGUMENT",
        message: format!("argument {at} should be text"),
    })
}

/// The request for `method(args)`: on the namespace when `repo` is `None`
/// (`create`, `get`, `delete`), else on the repository named `repo` there.
pub fn route(namespace: &str, repo: Option<&str>, method: &str, args: &[Value]) -> Result<Route, Refused> {
    let json_route = |method: &'static str, path: String, body: Option<Value>| Route { method, path, body, bytes: false };
    let Some(repo) = repo else {
        let name = text(args, 0)?;
        let key = store_key(namespace, &name);
        return match method {
            "create" => {
                let options = arg(args, 1);
                Ok(json_route(
                    "POST",
                    "/api/repos".to_owned(),
                    Some(json!({
                        "name": key,
                        "description": options.get("description").cloned().unwrap_or(Value::Null),
                        "defaultBranch": options.get("setDefaultBranch").cloned().unwrap_or(Value::Null),
                    })),
                ))
            }
            "get" => Ok(json_route("GET", format!("/api/repos/{}", segment(&key)), None)),
            "delete" => Ok(json_route("DELETE", format!("/api/repos/{}", segment(&key)), None)),
            other => Err(Refused { code: "NOT_SUPPORTED", message: format!("{other} is not offered by the fallback store") }),
        };
    };
    let base = format!("/api/repos/{}", segment(&store_key(namespace, repo)));
    match method {
        "info" => Ok(json_route("GET", base, None)),
        "createToken" => Ok(json_route(
            "POST",
            format!("{base}/tokens"),
            Some(json!({ "scope": arg(args, 0).as_str().unwrap_or("write"), "ttl": arg(args, 1).as_u64().unwrap_or(3_600) })),
        )),
        "log" => {
            let options = arg(args, 0);
            let mut pairs = Vec::new();
            for name in ["ref", "limit", "offset"] {
                match options.get(name) {
                    Some(Value::String(value)) => pairs.push((name, value.clone())),
                    Some(Value::Number(value)) => pairs.push((name, value.to_string())),
                    _ => {}
                }
            }
            Ok(json_route("GET", format!("{base}/log?{}", query(&pairs)), None))
        }
        "readCommit" => Ok(json_route("GET", format!("{base}/commits/{}", segment(&text(args, 0)?)), None)),
        "readTree" => Ok(json_route("GET", format!("{base}/trees/{}", segment(&text(args, 0)?)), None)),
        "readBlob" => Ok(Route { method: "GET", path: format!("{base}/blobs/{}", segment(&text(args, 0)?)), body: None, bytes: true }),
        "readFile" => {
            let options = arg(args, 0);
            let field = |name: &str| options.get(name).and_then(Value::as_str).unwrap_or_default().to_owned();
            Ok(Route {
                method: "GET",
                path: format!("{base}/file?{}", query(&[("ref", field("ref")), ("path", field("path"))])),
                body: None,
                bytes: true,
            })
        }
        "fork" => {
            let target = text(args, 0)?;
            let options = arg(args, 1);
            Ok(json_route(
                "POST",
                format!("{base}/fork"),
                Some(json!({
                    "name": store_key(namespace, &target),
                    "defaultBranchOnly": options.get("defaultBranchOnly").and_then(Value::as_bool).unwrap_or(true),
                })),
            ))
        }
        other => Err(Refused { code: "NOT_SUPPORTED", message: format!("{other} is not offered by the fallback store") }),
    }
}

/// What an answer from the store means for the call that asked.
#[derive(Debug, PartialEq)]
pub enum Answer {
    /// JSON, as the binding would have returned it.
    Json(Value),
    /// A blob or a file's bytes.
    Bytes(Vec<u8>),
    /// Nothing there: a blob or file not found, as the binding's `null`.
    Null,
    /// An error, with the binding's code; `None` for one that may pass.
    Error { code: Option<String>, message: String },
}

/// Reads an answer: `status` and `body` from the store, for `route`.
pub fn answer(route: &Route, status: u16, body: Vec<u8>) -> Answer {
    if (200..300).contains(&status) {
        if route.bytes {
            return Answer::Bytes(body);
        }
        return match serde_json::from_slice::<Value>(&body) {
            Ok(Value::Null) => Answer::Null,
            Ok(value) => Answer::Json(value),
            Err(_) => Answer::Error { code: None, message: "the fallback store sent something that is not JSON".to_owned() },
        };
    }
    if status == 404 && route.bytes {
        return Answer::Null;
    }
    let said: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let message = said.get("message").and_then(Value::as_str).map_or_else(|| format!("the fallback store answered {status}"), str::to_owned);
    // 5xx may pass: like the binding's INTERNAL_ERROR.
    let code = if status >= 500 {
        Some("INTERNAL_ERROR".to_owned())
    } else {
        Some(said.get("code").and_then(Value::as_str).unwrap_or(if status == 404 { "NOT_FOUND" } else { "INVALID_ARGUMENT" }).to_owned())
    };
    Answer::Error { code, message }
}

/// Whether a call writes: refused while a switched namespace is read-only.
pub fn writes(repo: Option<&str>, method: &str, args: &[Value]) -> bool {
    match (repo, method) {
        (None, "create" | "delete") => true,
        (Some(_), "fork") => true,
        (Some(_), "createToken") => arg(args, 0).as_str().unwrap_or("write") == "write",
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(namespaces: &str) -> Settings {
        Settings::from_vars(Some("https://gitstore.example/"), Some("0123456789abcdef"), Some(namespaces), None).unwrap()
    }

    #[test]
    fn nothing_is_switched_unless_the_store_and_namespaces_are_named() {
        assert_eq!(Settings::from_vars(None, Some("0123456789abcdef"), Some("*"), None), None);
        assert_eq!(Settings::from_vars(Some("https://x"), None, Some("*"), None), None);
        // A secret too short to be one.
        assert_eq!(Settings::from_vars(Some("https://x"), Some("short"), Some("*"), None), None);
        assert_eq!(Settings::from_vars(Some("ftp://x"), Some("0123456789abcdef"), Some("*"), None), None);
        let none = settings("");
        assert!(!none.serves("g1t"));
        let some = settings("g1t, g1t-us-1,bad name");
        assert!(some.serves("g1t") && some.serves("g1t-us-1") && !some.serves("g1t-eu"));
        assert!(settings("*").serves("anything"));
        // Read-only unless told otherwise.
        assert!(!some.writes);
        let writable = Settings::from_vars(Some("https://x"), Some("0123456789abcdef"), Some("*"), Some("Allow")).unwrap();
        assert!(writable.writes);
        assert_eq!(some.url, "https://gitstore.example");
        assert_eq!(some.remote("g1t", "acme--rocket"), "https://gitstore.example/git/g1t/acme--rocket.git");
    }

    #[test]
    fn a_remote_names_its_key_as_an_artifacts_remote_does() {
        let remote = settings("*").remote("g1t-us-1", "acme--rocket");
        // store.rs reads keys back from remotes by their last two segments.
        assert!(remote.ends_with("/g1t-us-1/acme--rocket.git"));
    }

    #[test]
    fn calls_on_the_namespace_become_requests_for_its_key() {
        let create = route("g1t", None, "create", &[json!("acme--rocket"), json!({ "description": "d", "setDefaultBranch": "trunk" })]).unwrap();
        assert_eq!(create.method, "POST");
        assert_eq!(create.path, "/api/repos");
        assert_eq!(create.body.unwrap(), json!({ "name": "g1t/acme--rocket", "description": "d", "defaultBranch": "trunk" }));
        let get = route("g1t", None, "get", &[json!("acme--rocket")]).unwrap();
        assert_eq!((get.method, get.path.as_str()), ("GET", "/api/repos/g1t%2Facme--rocket"));
        assert_eq!(route("g1t", None, "delete", &[json!("x1")]).unwrap().method, "DELETE");
        assert_eq!(route("g1t", None, "list", &[json!("x1")]).unwrap_err().code, "NOT_SUPPORTED");
        assert_eq!(route("g1t", None, "get", &[]).unwrap_err().code, "INVALID_ARGUMENT");
    }

    #[test]
    fn calls_on_a_repository_become_requests_below_it() {
        let base = "/api/repos/g1t-us-1%2Fpulls--pul_1";
        let at = |method: &str, args: &[Value]| route("g1t-us-1", Some("pulls--pul_1"), method, args).unwrap();
        assert_eq!(at("info", &[]).path, base);
        let token = at("createToken", &[json!("read"), json!(300)]);
        assert_eq!(token.body.unwrap(), json!({ "scope": "read", "ttl": 300 }));
        assert_eq!(at("log", &[json!({ "ref": "fix/#1", "limit": 20 })]).path, format!("{base}/log?ref=fix%2F%231&limit=20"));
        assert_eq!(at("readCommit", &[json!("abc")]).path, format!("{base}/commits/abc"));
        assert_eq!(at("readTree", &[json!("abc")]).path, format!("{base}/trees/abc"));
        let blob = at("readBlob", &[json!("abc")]);
        assert!(blob.bytes);
        let file = at("readFile", &[json!({ "ref": "main", "path": "src/a b.rs" })]);
        assert_eq!(file.path, format!("{base}/file?ref=main&path=src%2Fa%20b.rs"));
        assert!(file.bytes);
        let fork = at("fork", &[json!("pulls--pul_2"), json!({ "defaultBranchOnly": true })]);
        assert_eq!(fork.body.unwrap(), json!({ "name": "g1t-us-1/pulls--pul_2", "defaultBranchOnly": true }));
    }

    #[test]
    fn answers_read_as_the_binding_would_have_returned_them() {
        let json_route = route("g1t", Some("r"), "readTree", &[json!("a")]).unwrap();
        let blob = route("g1t", Some("r"), "readBlob", &[json!("a")]).unwrap();
        assert_eq!(answer(&json_route, 200, b"[]".to_vec()), Answer::Json(json!([])));
        assert_eq!(answer(&json_route, 200, b"null".to_vec()), Answer::Null);
        assert_eq!(answer(&blob, 200, b"hi".to_vec()), Answer::Bytes(b"hi".to_vec()));
        assert_eq!(answer(&blob, 404, b"{}".to_vec()), Answer::Null);
        assert_eq!(
            answer(&json_route, 404, br#"{"code":"NOT_FOUND","message":"no repository g1t/r"}"#.to_vec()),
            Answer::Error { code: Some("NOT_FOUND".into()), message: "no repository g1t/r".into() }
        );
        assert_eq!(
            answer(&json_route, 409, br#"{"code":"ALREADY_EXISTS","message":"x"}"#.to_vec()),
            Answer::Error { code: Some("ALREADY_EXISTS".into()), message: "x".into() }
        );
        // A 5xx may pass, as the binding's INTERNAL_ERROR.
        assert!(matches!(answer(&json_route, 502, Vec::new()), Answer::Error { code: Some(code), .. } if code == "INTERNAL_ERROR"));
        assert!(matches!(answer(&json_route, 200, b"<html>".to_vec()), Answer::Error { code: None, .. }));
    }

    #[test]
    fn writes_are_told_apart_from_reads() {
        assert!(writes(None, "create", &[json!("x")]));
        assert!(writes(None, "delete", &[json!("x")]));
        assert!(!writes(None, "get", &[json!("x")]));
        assert!(writes(Some("r"), "fork", &[json!("y")]));
        assert!(writes(Some("r"), "createToken", &[json!("write"), json!(60)]));
        assert!(!writes(Some("r"), "createToken", &[json!("read"), json!(60)]));
        assert!(!writes(Some("r"), "readBlob", &[json!("a")]));
    }
}
