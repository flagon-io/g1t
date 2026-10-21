//! The git edge: clones and fetches answered by real git (#237).
//!
//! Artifacts, the git store, answers a clone with packs it barely
//! deltifies: flagon-io/g1t cloned whole from g1t.sh was 134 MB and took
//! 38 s, and from GitHub 34 MB and 3 s, for the same 42.8k objects. g1t has
//! no say in how Artifacts packs. So for the repositories `GIT_EDGE` names,
//! a read of the git store (`info/refs` for upload-pack, and
//! `git-upload-pack`) is first asked of the repository's git edge: a
//! container of the runner's (services/runner/src/gitedge.ts) that keeps a
//! well-packed mirror of the repository and answers with git's own
//! upload-pack (crates/runner gitedge.rs).
//!
//! The edge is only ever faster, never the source of truth: pushes go to
//! Artifacts as before, and the edge answers only for the version of the
//! repository's refs it was asked about (`x-g1t-edge-version`, the refs
//! version registry.rs keeps), so it never shows refs older than the ones
//! g1t has recorded. Cold, behind or failing, it answers anything but 200,
//! and the request goes to Artifacts as it always did; the edge is then
//! told to catch up ([`Edge::sync`]), as it is after every push.
//!
//! `GIT_EDGE`: `off` or unset (nothing changes), `*` (every repository), or
//! `owner/name` entries separated by commas. It needs the `RUNNER` binding.

use std::collections::HashSet;

use g1t_contracts::repos::{GitAccess, GitService};
use worker::{Env, Fetcher, Headers, Method, Request, RequestInit, Response};

use crate::git_http::GitRequest;

/// The meters (meters.rs): a read the edge answered, and one it did not
/// (cold, behind or failing), which Artifacts answered instead.
pub const HIT: &str = "git_edge.hit";
pub const MISS: &str = "git_edge.miss";

/// The headers of a read that the edge needs to answer it as Artifacts
/// would (git_http.rs passes the same to the store).
const FORWARDED_HEADERS: [&str; 4] = ["accept", "content-encoding", "content-type", "git-protocol"];

/// Which repositories the edge answers for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Repositories {
    All,
    Named(HashSet<String>),
}

impl Repositories {
    /// `GIT_EDGE`'s value: `None` when the edge is off.
    pub fn parse(value: Option<&str>) -> Option<Repositories> {
        let value = value.map(str::trim).unwrap_or_default();
        if value.is_empty() || value.eq_ignore_ascii_case("off") {
            return None;
        }
        if value == "*" {
            return Some(Repositories::All);
        }
        let named: HashSet<String> = value
            .split(',')
            .map(|name| name.trim().to_ascii_lowercase())
            .filter(|name| name.split_once('/').is_some_and(|(owner, repo)| !owner.is_empty() && !repo.is_empty()))
            .collect();
        (!named.is_empty()).then_some(Repositories::Named(named))
    }

    /// Whether the edge answers for `owner/name`.
    pub fn include(&self, owner: &str, name: &str) -> bool {
        match self {
            Repositories::All => true,
            Repositories::Named(named) => named.contains(&format!("{owner}/{name}").to_ascii_lowercase()),
        }
    }
}

/// Whether a request is a read the edge can answer: the ref advertisement
/// for a fetch (GET `info/refs?service=git-upload-pack`), or an
/// upload-pack POST (protocol v2's `ls-refs` and `fetch`, or v0's fetch).
pub fn answers(git: &GitRequest, get: bool) -> bool {
    git.service == GitService::UploadPack
        && match git.endpoint {
            "info/refs" => get,
            "git-upload-pack" => !get,
            _ => false,
        }
}

/// The runner's git edges, for the repositories `GIT_EDGE` names.
pub struct Edge {
    runner: Fetcher,
    repositories: Repositories,
}

impl Edge {
    /// The edge, when `GIT_EDGE` turns it on and the `RUNNER` binding is there.
    pub fn from_env(env: &Env) -> Option<Edge> {
        let repositories = Repositories::parse(env.var("GIT_EDGE").ok().map(|value| value.to_string()).as_deref())?;
        let runner = env.service("RUNNER").ok()?;
        Some(Edge { runner, repositories })
    }

    pub fn serves(&self, owner: &str, name: &str) -> bool {
        self.repositories.include(owner, name)
    }

    /// The edge's answer to a read, when it has one for refs at `version`:
    /// `None` for anything but a 200 (cold, behind, failing, unreachable),
    /// for the caller to ask Artifacts. `body` is the POST's, already read.
    pub async fn answer(&self, repo_id: &str, version: u64, git: &GitRequest, request: &Request, body: Option<&[u8]>) -> Option<Response> {
        let asked = async {
            let headers = Headers::new();
            for name in FORWARDED_HEADERS {
                if let Some(value) = request.headers().get(name)? {
                    headers.set(name, &value)?;
                }
            }
            headers.set("x-g1t-edge-version", &version.to_string())?;
            let query = request.url()?.query().map(|query| format!("?{query}")).unwrap_or_default();
            let mut init = RequestInit::new();
            init.with_method(request.method()).with_headers(headers);
            if let Some(body) = body {
                init.with_body(Some(worker::js_sys::Uint8Array::from(body).into()));
            }
            let url = format!("https://runner/gitedge/{repo_id}/{}{query}", git.endpoint);
            self.runner.fetch_request(Request::new_with_init(&url, &init)?).await
        };
        let response = match asked.await {
            Ok(response) if response.status_code() == 200 => response,
            Ok(_) => return None,
            Err(error) => {
                worker::console_warn!("git edge for {repo_id} not asked: {error}");
                return None;
            }
        };
        // A fetch's answer is looked at before it is given: one that is
        // empty or starts as no fetch's answer does goes to the store too.
        if git.endpoint != "git-upload-pack" || body.is_some_and(lists_refs) {
            return Some(response);
        }
        match sound(response).await {
            Ok(Some(response)) => Some(response),
            Ok(None) => {
                worker::console_warn!("git edge for {repo_id} answered a fetch with nothing it could use");
                None
            }
            Err(error) => {
                worker::console_warn!("git edge for {repo_id} answer not read: {error}");
                None
            }
        }
    }

    /// Tells the edge to catch up with the repository's refs at `version`,
    /// fetching from the store with `access` (a credential that may read
    /// it), and to name `head` (the default branch) as its HEAD. It answers
    /// at once and catches up on its own; a failure only leaves the edge
    /// behind, and reads go to the store until it catches up.
    pub async fn sync(&self, repo_id: &str, version: u64, access: &GitAccess, head: &str) {
        let asked = async {
            let body = serde_json::json!({
                "remote": access.remote,
                "token": access.token,
                "version": version,
                "head": format!("refs/heads/{head}"),
            });
            let headers = Headers::new();
            headers.set("content-type", "application/json")?;
            let mut init = RequestInit::new();
            init.with_method(Method::Post).with_headers(headers).with_body(Some(body.to_string().into()));
            let url = format!("https://runner/gitedge/{repo_id}/sync");
            self.runner.fetch_request(Request::new_with_init(&url, &init)?).await
        };
        match asked.await {
            Ok(response) if response.status_code() < 300 => {}
            Ok(response) => worker::console_warn!("git edge for {repo_id} not synced: {}", response.status_code()),
            Err(error) => worker::console_warn!("git edge for {repo_id} not synced: {error}"),
        }
    }
}

/// Whether an upload-pack request is protocol v2's `ls-refs`, whose answer
/// may be a lone flush (a repository with no refs).
fn lists_refs(body: &[u8]) -> bool {
    body.windows(b"command=ls-refs".len()).any(|window| window == b"command=ls-refs")
}

/// Whether the start of a fetch's answer is one: its first pkt-line carries
/// data (a section, `NAK`, an `ACK`, `shallow`), not an error, and is not a
/// flush, a delimiter or the end of the response. `None` until enough of
/// it has come to tell.
pub(crate) fn starts_soundly(head: &[u8]) -> Option<bool> {
    let length = usize::from_str_radix(std::str::from_utf8(head.get(..4)?).ok()?, 16).ok();
    let Some(length) = length else { return Some(false) };
    if length < 4 {
        return Some(false);
    }
    let payload = &head[4..head.len().min(length)];
    if payload.len() < 4.min(length - 4) {
        return None;
    }
    Some(!payload.starts_with(b"ERR "))
}

/// The edge's answer to a fetch, when it starts as one (`starts_soundly`):
/// only its first bytes are read, and the rest streams on behind them.
/// `None` when it is empty or starts otherwise. An upload-pack that died
/// after `git http-backend` had sent its headers leaves a 200 with nothing
/// in it, which git takes for `expected 'packfile'`; the store answers.
async fn sound(mut response: Response) -> worker::Result<Option<Response>> {
    let headers = response.headers().clone();
    headers.delete("content-length")?;
    let mut stream = response.stream()?;
    let mut head = Vec::new();
    loop {
        match starts_soundly(&head) {
            Some(true) => break,
            Some(false) => return Ok(None),
            None => match futures_util::StreamExt::next(&mut stream).await {
                Some(chunk) => head.extend_from_slice(&chunk?),
                // All of it has come: it is sound or not as it stands.
                None => {
                    return Ok(match starts_soundly(&head) {
                        Some(true) => Some(Response::from_bytes(head)?.with_headers(headers)),
                        _ => None,
                    });
                }
            },
        }
    }
    let rest = futures_util::StreamExt::chain(futures_util::stream::once(async move { Ok::<Vec<u8>, worker::Error>(head) }), stream);
    Ok(Some(Response::from_stream(rest)?.with_headers(headers)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fetchs_answer_starts_with_data() {
        // A section, an acknowledgment, NAK, a shallow line: sound.
        assert_eq!(starts_soundly(b"000dpackfile\n0027\x02Enumerating"), Some(true));
        assert_eq!(starts_soundly(b"0011shallow-info\n"), Some(true));
        assert_eq!(starts_soundly(b"0008NAK\n"), Some(true));
        assert_eq!(starts_soundly(b"0014acknowledgments\n"), Some(true));
        // Nothing, the end of the response, a flush, an error: not.
        assert_eq!(starts_soundly(b"0002"), Some(false));
        assert_eq!(starts_soundly(b"0000"), Some(false));
        assert_eq!(starts_soundly(b"0001"), Some(false));
        assert_eq!(starts_soundly(b"0021ERR upload-pack: not our ref\n"), Some(false));
        assert_eq!(starts_soundly(b"zzzzpackfile"), Some(false));
        // Too little yet to tell.
        assert_eq!(starts_soundly(b""), None);
        assert_eq!(starts_soundly(b"000d"), None);
        assert_eq!(starts_soundly(b"000dpa"), None);
        assert!(lists_refs(b"0014command=ls-refs\n0000"));
        assert!(!lists_refs(b"0011command=fetch\n0000"));
    }

    fn git(endpoint: &'static str, service: GitService) -> GitRequest {
        GitRequest {
            path: g1t_contracts::repos::RepoPath { namespace: "acme".into(), name: "rocket".into() },
            endpoint,
            service,
        }
    }

    #[test]
    fn git_edge_names_the_repositories_it_answers_for() {
        assert_eq!(Repositories::parse(None), None);
        assert_eq!(Repositories::parse(Some("")), None);
        assert_eq!(Repositories::parse(Some(" off ")), None);
        assert_eq!(Repositories::parse(Some("OFF")), None);
        assert_eq!(Repositories::parse(Some("*")), Some(Repositories::All));
        // Names without an owner are not names.
        assert_eq!(Repositories::parse(Some("rocket, /x, acme/")), None);
        let named = Repositories::parse(Some("flagon-io/g1t, Acme/Rocket")).unwrap();
        assert!(named.include("flagon-io", "g1t"));
        assert!(named.include("acme", "rocket"));
        assert!(named.include("ACME", "Rocket"));
        assert!(!named.include("acme", "launchpad"));
        assert!(Repositories::All.include("anyone", "anything"));
    }

    #[test]
    fn the_edge_answers_reads_of_upload_pack_only() {
        assert!(answers(&git("info/refs", GitService::UploadPack), true));
        assert!(answers(&git("git-upload-pack", GitService::UploadPack), false));
        assert!(!answers(&git("git-upload-pack", GitService::UploadPack), true));
        assert!(!answers(&git("info/refs", GitService::UploadPack), false));
        assert!(!answers(&git("info/refs", GitService::ReceivePack), true));
        assert!(!answers(&git("git-receive-pack", GitService::ReceivePack), false));
    }
}
