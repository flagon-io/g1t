//! The git edge: clones and fetches answered by real git (#237).
//!
//! Artifacts, the git store, answers a clone with packs it barely
//! deltifies: flagon-io/g1t cloned whole from g1t.sh was 134 MB and took
//! 38 s, and from GitHub 34 MB and 3 s, for the same 42.8k objects. g1t has
//! no say in how Artifacts packs. So a read of the git store (`info/refs`
//! for upload-pack, and `git-upload-pack`) of any repository is first asked
//! of the repository's git edge: a container of the runner's
//! (services/runner/src/gitedge.ts) that keeps a well-packed mirror of the
//! repository and answers with git's own upload-pack (crates/runner
//! gitedge.rs). It is asked only once the read is authorized, as any read
//! of the store is: the runner is reached only through the `RUNNER`
//! binding, and its edge answers whatever g1t sends it.
//!
//! The edge is only ever faster, never the source of truth: pushes go to
//! Artifacts as before, and the edge answers only for the version of the
//! repository's refs it was asked about (`x-g1t-edge-version`, the refs
//! version registry.rs keeps), so it never shows refs older than the ones
//! g1t has recorded. Cold, behind or failing, it answers anything but 200,
//! and the request goes to Artifacts as it always did; the edge is then
//! told to catch up ([`Edge::sync`]), as it is after every push. A cold
//! edge answers at once and starts in the background, so the first read of
//! a repository nobody has read lately costs one short request more than
//! the store alone; the reads after it in the next [`COLD_REST_MS`] go
//! straight to the store ([`resting`]) while the edge starts.
//!
//! `GIT_EDGE`: unset, empty or `on`, every repository is served by its
//! edge. `off` turns the edge off everywhere, for an incident: every read
//! goes to Artifacts, as before the edge. `-owner/name` entries, separated
//! by commas (`on, -acme/rocket`), leave those repositories out. It needs
//! the `RUNNER` binding.
//!
//! The off switch without a deploy is the platform pause's `git_edge`
//! level (billing's platform.rs), which staff pull in sudo (Costs &
//! margin, Platform pause, beside the edges running and what they cost)
//! and billing's usage watcher may pull on a severe breach. While it is
//! on, every read goes to Artifacts and no edge is asked, started or
//! synced, exactly as with `GIT_EDGE=off`. It is read through the `BILLING`
//! binding and kept 30 seconds in the isolate (`g1t_kit::pause`); when it
//! cannot be read, the edge is not paused: a pause is pulled on purpose,
//! and a billing outage changes nothing here. `GIT_EDGE=off` still turns
//! the edge off whatever the pause says.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use g1t_contracts::billing::{PauseLevel, PlatformPause};
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

/// Which repositories the edge answers for: every one but those
/// `GIT_EDGE` leaves out.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Repositories {
    left_out: HashSet<String>,
}

impl Repositories {
    /// `GIT_EDGE`'s value: `None` when it turns the edge off. Entries it
    /// does not know (a name without `-`, as the allow-list of before had)
    /// change nothing.
    pub fn parse(value: Option<&str>) -> Option<Repositories> {
        let entries: Vec<&str> = value.unwrap_or_default().split(',').map(str::trim).filter(|entry| !entry.is_empty()).collect();
        if entries.iter().any(|entry| entry.eq_ignore_ascii_case("off")) {
            return None;
        }
        let left_out = entries
            .iter()
            .filter_map(|entry| entry.strip_prefix('-'))
            .map(|name| name.trim().to_ascii_lowercase())
            .filter(|name| name.split_once('/').is_some_and(|(owner, repo)| !owner.is_empty() && !repo.is_empty()))
            .collect();
        Some(Repositories { left_out })
    }

    /// Whether the edge answers for `owner/name`.
    pub fn include(&self, owner: &str, name: &str) -> bool {
        !self.left_out.contains(&format!("{owner}/{name}").to_ascii_lowercase())
    }
}

/// How long the reads of a repository whose edge was cold go straight to
/// the store: about as long as an edge takes to start and catch up. One
/// read finds it cold and starts it; the ones that follow do not each ask.
pub const COLD_REST_MS: u64 = 30_000;
/// How long they do when the runner has no edge deployed at all.
pub const OFF_REST_MS: u64 = 10 * 60_000;

/// How long the edge's reads of a repository rest after it answered
/// `status` with `x-g1t-edge: why` (`None`: it was not reached at all),
/// when they do. A cold, failing or unreachable edge is left alone while it
/// starts; one that is behind is asked again at once, since it catches up
/// in moments.
pub fn rest_after(status: Option<u16>, why: Option<&str>) -> Option<u64> {
    match (status, why) {
        (Some(503), Some("off")) => Some(OFF_REST_MS),
        (Some(status), _) if status >= 500 => Some(COLD_REST_MS),
        (None, _) => Some(COLD_REST_MS),
        _ => None,
    }
}

/// The most repositories an isolate remembers resting: past it, the ones
/// whose rest has ended are forgotten, and if that is not enough, all.
const RESTING_HELD: usize = 4096;

thread_local! {
    /// Repositories whose edge is not asked until a time (ms), by id.
    static RESTING: RefCell<HashMap<String, u64>> = RefCell::new(HashMap::new());
}

/// Whether reads of `repo_id` skip its edge at `now`, after it was cold.
pub fn resting(repo_id: &str, now: u64) -> bool {
    RESTING.with(|resting| resting.borrow().get(repo_id).is_some_and(|&until| now < until))
}

fn rest(repo_id: &str, until: u64, now: u64) {
    RESTING.with(|resting| {
        let mut resting = resting.borrow_mut();
        if resting.len() >= RESTING_HELD {
            resting.retain(|_, kept| now < *kept);
            if resting.len() >= RESTING_HELD {
                resting.clear();
            }
        }
        resting.insert(repo_id.to_owned(), until);
    });
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

/// Whether the platform pause turns the edge off. A pause billing could
/// not say (`g1t_kit::pause` answers nothing paused) never does.
pub fn paused_by(pause: &PlatformPause) -> bool {
    pause.is(PauseLevel::GitEdge)
}

/// The runner's git edges, one per repository.
pub struct Edge {
    runner: Fetcher,
    repositories: Repositories,
    /// Where the platform pause is read; without it, never paused.
    billing: Option<Fetcher>,
}

impl Edge {
    /// The edge, unless `GIT_EDGE` turns it off, when the `RUNNER` binding is there.
    pub fn from_env(env: &Env) -> Option<Edge> {
        let repositories = Repositories::parse(env.var("GIT_EDGE").ok().map(|value| value.to_string()).as_deref())?;
        let runner = env.service("RUNNER").ok()?;
        Some(Edge { runner, repositories, billing: env.service("BILLING").ok() })
    }

    /// Whether staff (or billing's usage watcher) paused the edge across
    /// g1t: the `git_edge` level, kept 30 seconds in the isolate.
    pub async fn paused(&self) -> bool {
        match &self.billing {
            Some(billing) => paused_by(&g1t_kit::pause::current(billing).await),
            None => false,
        }
    }

    /// Whether the edge serves `owner/name` at all (`GIT_EDGE`).
    pub fn serves(&self, owner: &str, name: &str) -> bool {
        self.repositories.include(owner, name)
    }

    /// Whether a read of `repo_id` (`owner/name`) is asked of its edge now:
    /// it is served, and its edge was not just found cold.
    pub fn asks(&self, repo_id: &str, owner: &str, name: &str) -> bool {
        self.serves(owner, name) && !resting(repo_id, g1t_kit::now_ms())
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
        let asked = asked.await;
        let rested = match &asked {
            Ok(response) => rest_after(Some(response.status_code()), response.headers().get("x-g1t-edge").ok().flatten().as_deref()),
            Err(_) => rest_after(None, None),
        };
        if let Some(rested) = rested {
            let now = g1t_kit::now_ms();
            rest(repo_id, now + rested, now);
        }
        let response = match asked {
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
        let length = response.headers().get("content-length").ok().flatten();
        match sound(response).await {
            Ok(Ok(response)) => Some(response),
            Ok(Err(head)) => {
                // What it sent, so the log says why (the edge's own log is not kept).
                let shown: String = head.iter().take(160).map(|&byte| if byte.is_ascii_graphic() || byte == b' ' { byte as char } else { '.' }).collect();
                worker::console_warn!(
                    "git edge for {repo_id} answered a fetch with nothing it could use: {} bytes before it ended or went wrong (content-length {}): {shown}",
                    head.len(),
                    length.as_deref().unwrap_or("none")
                );
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
    /// behind, and reads go to the store until it catches up. After a push
    /// (`pushed`), an edge that is asleep is started only when its
    /// repository was read lately (gitedge.ts): a push to a repository
    /// nobody clones starts no container.
    pub async fn sync(&self, repo_id: &str, version: u64, access: &GitAccess, head: &str, pushed: bool) {
        let asked = async {
            let body = serde_json::json!({
                "remote": access.remote,
                "token": access.token,
                "version": version,
                "head": format!("refs/heads/{head}"),
                "push": pushed,
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
    // With `sideband-all` every line is on a band: an error is on band 3.
    Some(!payload.starts_with(b"ERR ") && !payload.starts_with(b"\x03"))
}

/// The edge's answer to a fetch, when it starts as one (`starts_soundly`):
/// only its first bytes are read, and the rest streams on behind them.
/// What was read of it, when it is empty or starts otherwise. An upload-pack
/// that died after `git http-backend` had sent its headers leaves a 200
/// with nothing in it, which git takes for `expected 'packfile'`; the
/// store answers.
async fn sound(mut response: Response) -> worker::Result<std::result::Result<Response, Vec<u8>>> {
    let headers = response.headers().clone();
    headers.delete("content-length")?;
    let mut stream = response.stream()?;
    let mut head = Vec::new();
    loop {
        match starts_soundly(&head) {
            Some(true) => break,
            Some(false) => return Ok(Err(head)),
            None => match futures_util::StreamExt::next(&mut stream).await {
                Some(chunk) => head.extend_from_slice(&chunk?),
                // All of it has come: it is sound or not as it stands.
                None => {
                    return Ok(match starts_soundly(&head) {
                        Some(true) => Ok(Response::from_bytes(head)?.with_headers(headers)),
                        _ => Err(head),
                    });
                }
            },
        }
    }
    let rest = futures_util::StreamExt::chain(futures_util::stream::once(async move { Ok::<Vec<u8>, worker::Error>(head) }), stream);
    Ok(Ok(Response::from_stream(rest)?.with_headers(headers)))
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
        // With sideband-all (#260): data on band 1 is sound, an error on band 3 is not.
        assert_eq!(starts_soundly(b"000e\x01packfile\n0027\x02Enumerating"), Some(true));
        assert_eq!(starts_soundly(b"0015\x01acknowledgments\n"), Some(true));
        assert_eq!(starts_soundly(b"001e\x03upload-pack: not our ref\n"), Some(false));
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
    fn git_edge_serves_every_repository_unless_it_is_off_or_left_out() {
        // Nothing to configure: every repository.
        for value in [None, Some(""), Some(" "), Some("on"), Some("*")] {
            let every = Repositories::parse(value).unwrap();
            assert!(every.include("flagon-io", "g1t"), "{value:?}");
            assert!(every.include("anyone", "anything"), "{value:?}");
        }
        // The allow-list of before is no longer one: it changes nothing.
        assert!(Repositories::parse(Some("flagon-io/g1t")).unwrap().include("acme", "rocket"));
        // The incident switch.
        assert_eq!(Repositories::parse(Some("off")), None);
        assert_eq!(Repositories::parse(Some(" OFF ")), None);
        assert_eq!(Repositories::parse(Some("-acme/rocket, off")), None);
        // Some left out.
        let some = Repositories::parse(Some("on, -Acme/Rocket, - flagon-io/huge")).unwrap();
        assert!(!some.include("acme", "rocket"));
        assert!(!some.include("ACME", "rocket"));
        assert!(!some.include("flagon-io", "huge"));
        assert!(some.include("acme", "launchpad"));
        assert!(some.include("flagon-io", "g1t"));
        // Names without an owner or a name leave nothing out.
        assert_eq!(Repositories::parse(Some("-rocket, -/x, -acme/")), Some(Repositories::default()));
    }

    #[test]
    fn the_git_edge_pause_turns_it_off_and_an_unread_pause_does_not() {
        // What g1t_kit::pause answers when billing cannot say: not paused.
        assert!(!paused_by(&PlatformPause::default()));
        assert!(paused_by(&PlatformPause { git_edge: true, ..PlatformPause::default() }));
        // The other levels leave the edge alone.
        let others = PlatformPause { compute: true, schedules: true, indexing: true, renders: true, git_edge: false };
        assert!(!paused_by(&others));
        // An older billing that does not know the level: not paused.
        let old: PlatformPause = serde_json::from_str(r#"{"compute":false,"schedules":true,"indexing":false,"renders":false}"#).unwrap();
        assert!(!paused_by(&old));
    }

    #[test]
    fn a_cold_edge_is_left_alone_while_it_starts() {
        // Answered, or behind (it catches up in moments): asked again at once.
        assert_eq!(rest_after(Some(200), None), None);
        assert_eq!(rest_after(Some(409), Some("behind")), None);
        assert_eq!(rest_after(Some(404), None), None);
        // Cold, failing, unreachable: the store answers while it starts.
        assert_eq!(rest_after(Some(503), Some("cold")), Some(COLD_REST_MS));
        assert_eq!(rest_after(Some(502), Some("error")), Some(COLD_REST_MS));
        assert_eq!(rest_after(Some(503), None), Some(COLD_REST_MS));
        assert_eq!(rest_after(None, None), Some(COLD_REST_MS));
        // No edge deployed in the runner: asked again much later.
        assert_eq!(rest_after(Some(503), Some("off")), Some(OFF_REST_MS));

        let now = 1_000_000;
        assert!(!resting("rep_cold", now));
        rest("rep_cold", now + COLD_REST_MS, now);
        assert!(resting("rep_cold", now));
        assert!(resting("rep_cold", now + COLD_REST_MS - 1));
        assert!(!resting("rep_cold", now + COLD_REST_MS));
        assert!(!resting("rep_other", now));
        // Never more than it may hold: ended rests are forgotten first.
        for n in 0..RESTING_HELD {
            rest(&format!("rep_{n}"), now + 1, now);
        }
        rest("rep_last", now + 10 + COLD_REST_MS, now + 10);
        assert!(resting("rep_last", now + 10));
        assert!(!resting("rep_0", now + 10));
        RESTING.with(|resting| assert!(resting.borrow().len() <= RESTING_HELD));
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
