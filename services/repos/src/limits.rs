//! What an anonymous clone can cost a repository's owner.
//!
//! Anyone may clone a public repository, and each clone or fetch the git
//! store answers is an operation counted for the repository's workspace
//! (git_ops.rs). The site limits git requests per address (apps/web's
//! front-door-limits.ts); here, per repository:
//!
//! - ANONYMOUS_FETCH_LIMIT: anonymous fetches that reach the store. Clones
//!   answered from the pack cache or kept refs never count, so the same
//!   commit cloned by many costs nothing; a flood of different requests
//!   from many addresses is answered 429 once past it. Signed-in clones
//!   are never limited here.
//! - PACK_FILL_LIMIT: packs written to the pack cache (pack_cache.rs). Past
//!   it the pack still goes to git, only not kept, so a flood of distinct
//!   clones cannot turn into a flood of writes to the bucket.
//!
//! Both are Workers Rate Limiting bindings keyed by the repository's id;
//! their limits are in `RATE_LIMITS` (packages/contracts). Without them
//! (self-hosted) nothing is limited, and one that fails lets the request
//! through (g1t_kit::limits).

use g1t_kit::limits::PERIOD_SECONDS;
use worker::{Response, Result};

use crate::git_ops::GitCall;

pub const ANONYMOUS_FETCH: &str = "ANONYMOUS_FETCH_LIMIT";
pub const PACK_FILL: &str = "PACK_FILL_LIMIT";

/// Whether a request counts against ANONYMOUS_FETCH_LIMIT: a fetch of
/// objects, by no one, that the store is about to be asked for.
pub fn counts_as_anonymous_fetch(call: GitCall, anonymous: bool) -> bool {
    anonymous && call == GitCall::Fetch
}

/// What git is told past the limit: a plain-text answer, which git shows.
pub fn too_many_anonymous_fetches(path: &str) -> Result<Response> {
    let message = format!(
        "Too many anonymous clones of {path} right now. Wait a minute and try again, or clone with credentials: https://docs.g1t.sh/reference/rate-limits/\n"
    );
    let response = Response::error(message, 429)?;
    response.headers().set("retry-after", &PERIOD_SECONDS.to_string())?;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_anonymous_fetches_of_objects_count() {
        assert!(counts_as_anonymous_fetch(GitCall::Fetch, true));
        assert!(!counts_as_anonymous_fetch(GitCall::Fetch, false), "signed-in clones are not limited here");
        assert!(!counts_as_anonymous_fetch(GitCall::RefAdvertisement, true));
        assert!(!counts_as_anonymous_fetch(GitCall::LsRefs, true));
        assert!(!counts_as_anonymous_fetch(GitCall::ReceivePack, true));
    }
}
