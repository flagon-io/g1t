//! Reading a service's D1 database near the caller, with D1's Sessions API,
//! and saying how long an RPC took.
//!
//! The caller chooses, per request, with the `x-d1-bookmark` header:
//!
//! | Header | Session | Reads go to |
//! | --- | --- | --- |
//! | absent | none (the plain binding) | the primary, as always |
//! | `first-primary` | started on the primary | the primary, then any copy at least as new |
//! | `first-unconstrained` | started anywhere | the nearest copy |
//! | a bookmark | started at that bookmark | any copy at least as new as the bookmark |
//!
//! Writes always go to the primary. A session is sequentially consistent:
//! what it wrote, it reads back. Its latest bookmark comes back in the
//! response's `x-d1-bookmark` header, so the caller can start the next
//! request where this one left off. Without the header nothing changes,
//! so service-to-service calls ([`crate::call`]), queues and crons read the
//! primary as before. docs/PERFORMANCE.md explains who sends what.
//!
//! Every response that goes through [`Served::finish`] also carries
//! `server-timing: svc;dur=<ms>;desc="<how D1 was read>"`, which the site
//! adds up per service for its own `Server-Timing` header.

use worker::wasm_bindgen::JsCast;
use worker::{D1Database, D1DatabaseSession, Env, Request, Response, Result};

/// The header that carries a session's constraint or bookmark, both ways.
pub const BOOKMARK: &str = "x-d1-bookmark";

/// Longest bookmark accepted; D1's are about 70 characters.
const MAX_BOOKMARK: usize = 256;

/// What a request's `x-d1-bookmark` header asks for: `None` for no session
/// (the primary, as without the header), otherwise what `withSession` is
/// given. Anything that is not a constraint or a well-formed bookmark
/// starts on the primary: never staler than asked.
pub fn constraint(header: Option<&str>) -> Option<String> {
    let value = header?.trim();
    if value.is_empty() {
        return None;
    }
    if value == "first-primary" || value == "first-unconstrained" {
        return Some(value.to_owned());
    }
    let well_formed = value.len() <= MAX_BOOKMARK
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    Some(if well_formed { value.to_owned() } else { "first-primary".to_owned() })
}

/// How one RPC read its database, for its response.
pub struct Served {
    session: Option<D1DatabaseSession>,
    started: u64,
}

/// The database `binding` for an RPC `request`: a D1 session when the
/// caller asked for one, the plain binding otherwise. The session is
/// handed back as a [`D1Database`] so a service's code is the same either
/// way; it answers `prepare` and `batch` (all a request path uses), not
/// `exec`, `dump` or `withSession`.
pub fn open(env: &Env, binding: &str, request: &Request) -> Result<(D1Database, Served)> {
    let started = crate::now_ms();
    let db = env.d1(binding)?;
    let asked = constraint(request.headers().get(BOOKMARK)?.as_deref());
    let Some(asked) = asked else {
        return Ok((db, Served { session: None, started }));
    };
    let session = db.with_session(Some(&asked))?;
    // The same JavaScript object, seen as a database: D1Database's methods
    // are structural, so `prepare` and `batch` call the session's own.
    let as_database = D1Database::unchecked_from_js(AsRef::<worker::wasm_bindgen::JsValue>::as_ref(&session).clone());
    Ok((as_database, Served { session: Some(session), started }))
}

impl Served {
    /// For a request that touches no database: only its timing.
    pub fn timing_only() -> Self {
        Served { session: None, started: crate::now_ms() }
    }

    /// Adds the session's bookmark and the time taken to `response`.
    /// Errors pass through untouched.
    pub fn finish(&self, response: Result<Response>) -> Result<Response> {
        let mut response = response?;
        let took = crate::now_ms().saturating_sub(self.started);
        let how = if self.session.is_some() { "session" } else { "primary" };
        let headers = response.headers_mut();
        headers.append("server-timing", &format!("svc;dur={took};desc=\"{how}\""))?;
        if let Some(session) = &self.session
            && let Ok(Some(bookmark)) = session.get_bookmark()
        {
            headers.set(BOOKMARK, &bookmark)?;
        }
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::constraint;

    #[test]
    fn no_header_means_the_primary_without_a_session() {
        assert_eq!(constraint(None), None);
        assert_eq!(constraint(Some("")), None);
        assert_eq!(constraint(Some("  ")), None);
    }

    #[test]
    fn constraints_and_bookmarks_pass_through() {
        assert_eq!(constraint(Some("first-primary")).as_deref(), Some("first-primary"));
        assert_eq!(constraint(Some("first-unconstrained")).as_deref(), Some("first-unconstrained"));
        let bookmark = "0000002c-00000004-00004f95-c7f4a9b2e8d1f0c3b6a5d4e3f2a1b0c9";
        assert_eq!(constraint(Some(bookmark)).as_deref(), Some(bookmark));
    }

    #[test]
    fn anything_else_starts_on_the_primary() {
        assert_eq!(constraint(Some("x; DROP")).as_deref(), Some("first-primary"));
        assert_eq!(constraint(Some(&"a".repeat(300))).as_deref(), Some("first-primary"));
        assert_eq!(constraint(Some("first primary")).as_deref(), Some("first-primary"));
    }
}
