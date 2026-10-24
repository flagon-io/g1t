//! How often a client may call the API and the MCP server.
//!
//! A request with a token counts against API_TOKEN_LIMIT under a hash of
//! the token (never the token itself); one without counts against
//! API_ANONYMOUS_LIMIT under the client's address (`CF-Connecting-IP`), as
//! does one whose token turns out wrong, so guessing is limited by address.
//! REST and MCP count apart. The limits are in `RATE_LIMITS`
//! (packages/contracts/src/rate-limits.ts) and the docs' rate limits page.
//!
//! Not counted: what sandboxes, runners and outside systems send with
//! credentials of their own (Stripe, connections' hooks, job tokens,
//! report routes), which are answered before this or listed in
//! [`counts`]. Without the bindings (self-hosted) nothing is limited, and
//! a binding that fails lets the request through.

use g1t_kit::limits::{self, PERIOD_SECONDS};
use serde_json::json;
use sha2::{Digest, Sha256};
use worker::{Env, Request, Response, Result};

pub const ANONYMOUS: &str = "API_ANONYMOUS_LIMIT";
pub const TOKEN: &str = "API_TOKEN_LIMIT";

#[derive(Clone, Copy)]
pub struct Policy {
    signed_in: bool,
    limited: bool,
}

impl Policy {
    fn name(self) -> &'static str {
        if self.signed_in { "token" } else { "anonymous" }
    }
    fn header(self) -> String {
        format!("\"{}\";q={};w={PERIOD_SECONDS}", self.name(), if self.signed_in { 1000 } else { 60 })
    }
    fn remaining(self) -> Option<String> {
        self.limited.then(|| format!("\"{}\";r=0;t={PERIOD_SECONDS}", self.name()))
    }
    pub fn apply(self, response: &mut Response) -> Result<()> {
        response.headers_mut().set("ratelimit-policy", &self.header())?;
        // The binding exposes a verdict, not remaining quota or a reset clock.
        // Only advertise remaining/reset information when actually limited.
        if let Some(remaining) = self.remaining() {
            response.headers_mut().set("ratelimit", &remaining)?;
        }
        Ok(())
    }
}

fn policy(verdict: limits::Verdict, signed_in: bool) -> Option<Policy> {
    match verdict {
        limits::Verdict::Unavailable => None,
        _ => Some(Policy { signed_in, limited: verdict.limited() }),
    }
}

/// Paths a sandbox or runner reports to with its own token in the body:
/// many sandboxes share an address, and none of them is a person.
const REPORTS: &[&str] =
    &["/mergechecks/", "/backups/", "/queue/", "/actions/jobs/", "/agent-runs/", "/checks/", "/runs/", "/plans/", "/reviews/", "/runners/"];

/// Whether a request counts against a limit at all.
pub fn counts(method: &str, path: &str, has_token: bool) -> bool {
    has_token || method != "POST" || !REPORTS.iter().any(|prefix| path.starts_with(prefix))
}

/// The binding a request counts against and its key there.
pub fn key(token: Option<&str>, address: Option<&str>, on_mcp: bool) -> (&'static str, String) {
    let surface = if on_mcp { "mcp" } else { "rest" };
    match token.filter(|token| !token.is_empty()) {
        Some(token) => (TOKEN, format!("{surface}:tok:{}", token_hash(token))),
        None => (ANONYMOUS, format!("{surface}:{}", limits::address_key(address))),
    }
}

/// The first 16 hex digits of the token's SHA-256.
fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The access token of an `Authorization` header, if it has one: `Bearer
/// <token>`, or `token <token>`, the form GitHub also takes and Octokit
/// (`@actions/github`, so `actions/checkout` and `actions/github-script`)
/// sends.
pub fn bearer(header: &str) -> Option<&str> {
    match header.split_once(' ') {
        Some((scheme, token)) if scheme.eq_ignore_ascii_case("bearer") || scheme.eq_ignore_ascii_case("token") => {
            Some(token.trim()).filter(|t| !t.is_empty())
        }
        _ => None,
    }
}

/// The 429 every limit answers, in the shape every error takes.
pub fn too_many(signed_in: bool) -> Result<Response> {
    let message = if signed_in {
        "Too many requests with this token. Wait a minute and try again: https://docs.g1t.sh/reference/rate-limits/"
    } else {
        "Too many requests from this address. Wait a minute, or use an access token for a higher limit: https://docs.g1t.sh/reference/rate-limits/"
    };
    let mut response = Response::from_json(&json!({ "error": { "code": "rate_limited", "message": message } }))?.with_status(429);
    response.headers_mut().set("retry-after", &PERIOD_SECONDS.to_string())?;
    Ok(response)
}

/// The 429 for a request past its limit, or `None` to go on.
pub async fn limited(
    request: &Request,
    env: &Env,
    method: &str,
    path: &str,
    on_mcp: bool,
    advertised: &mut Option<Policy>,
) -> Result<Option<Response>> {
    let header = request.headers().get("authorization")?.unwrap_or_default();
    let token = bearer(&header);
    if !counts(method, path, token.is_some()) {
        return Ok(None);
    }
    let address = request.headers().get("cf-connecting-ip")?;
    let (binding, key) = key(token, address.as_deref(), on_mcp);
    let verdict = limits::check(env, binding, key).await;
    *advertised = policy(verdict, token.is_some());
    if verdict.limited() {
        return too_many(token.is_some()).map(Some);
    }
    Ok(None)
}

/// A request whose token was wrong also counts against its address.
pub async fn wrong_token(request: &Request, env: &Env, on_mcp: bool, advertised: &mut Option<Policy>) -> Result<Option<Response>> {
    let address = request.headers().get("cf-connecting-ip")?;
    let (binding, key) = key(None, address.as_deref(), on_mcp);
    let verdict = limits::check(env, binding, key).await;
    *advertised = policy(verdict, false);
    if verdict.limited() {
        return too_many(false).map(Some);
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertised_limits_match_bindings_without_inventing_remaining_counts() {
        let config: String = include_str!("../wrangler.jsonc").chars().filter(|c| !c.is_whitespace()).collect();
        for (signed_in, binding, quota) in [(false, ANONYMOUS, 60), (true, TOKEN, 1000)] {
            let configured = config.split(&format!("\"name\":\"{binding}\"")).nth(1).unwrap().split('}').next().unwrap();
            assert!(configured.contains(&format!("\"limit\":{quota},\"period\":{PERIOD_SECONDS}")));
            let allowed = policy(limits::Verdict::Allowed, signed_in).unwrap();
            assert!(allowed.header().ends_with(&format!(";q={quota};w=60")));
            assert_eq!(allowed.remaining(), None);
            assert!(policy(limits::Verdict::Limited, signed_in).unwrap().remaining().unwrap().ends_with(";r=0;t=60"));
        }
        assert!(policy(limits::Verdict::Unavailable, false).is_none());
    }

    #[test]
    fn tokens_are_counted_by_their_hash_and_others_by_address() {
        let (binding, tok) = key(Some("g1t_secret"), Some("203.0.113.9"), false);
        assert_eq!(binding, TOKEN);
        assert!(tok.starts_with("rest:tok:") && tok.len() == "rest:tok:".len() + 16);
        assert!(!tok.contains("g1t_secret"), "the token never reaches the limiter");
        assert_eq!(key(Some("g1t_secret"), None, false).1, tok, "the same token, the same key");
        assert_ne!(key(Some("g1t_other"), None, false).1, tok);
        assert_eq!(key(None, Some("203.0.113.9"), false), (ANONYMOUS, "rest:ip:203.0.113.9".to_owned()));
        assert_eq!(key(Some(""), None, false), (ANONYMOUS, "rest:ip:unknown".to_owned()));
    }

    #[test]
    fn rest_and_mcp_count_apart() {
        assert_eq!(key(None, Some("203.0.113.9"), true).1, "mcp:ip:203.0.113.9");
        assert!(key(Some("g1t_secret"), None, true).1.starts_with("mcp:tok:"));
    }

    #[test]
    fn sandbox_reports_are_not_counted_but_everything_else_is() {
        assert!(!counts("POST", "/checks/run_1", false));
        assert!(!counts("POST", "/agent-runs/run_1/report", false));
        assert!(!counts("POST", "/runs/run_1/usage", false));
        assert!(counts("GET", "/repos/acme/rocket", false));
        assert!(counts("POST", "/device/code", false));
        assert!(counts("POST", "/checks/run_1", true), "with a bearer token it counts as that token");
    }

    #[test]
    fn bearer_and_token_schemes_are_read() {
        assert_eq!(bearer("Bearer g1t_abc "), Some("g1t_abc"));
        assert_eq!(bearer("bearer g1t_abc"), Some("g1t_abc"));
        // Octokit's form, as `actions/checkout` sends it for a default branch.
        assert_eq!(bearer("token g1t_abc"), Some("g1t_abc"));
        assert_eq!(bearer("Token g1t_abc"), Some("g1t_abc"));
        assert_eq!(bearer("token "), None);
        assert_eq!(bearer("Basic dXNlcjpwYXNz"), None);
        assert_eq!(bearer("Bearer "), None);
        assert_eq!(bearer(""), None);
    }
}
