//! The answers that list a repository's refs, kept for a moment: the ref
//! advertisement git asks for first on every clone and fetch
//! (`info/refs?service=git-upload-pack`), and protocol v2's `ls-refs`.
//! Asking the git store for one takes hundreds of milliseconds; a kept one
//! is a few.
//!
//! An answer is kept under the repository's id and the version of its refs
//! (`refs_version`, see registry.rs), which goes up after everything g1t
//! does that changes them, so a change leaves the old answer behind rather
//! than having to find and remove it. The key also holds the default branch
//! (the answer's `HEAD` is rewritten to it, see `git_http::with_head`), the
//! protocol version, and for `ls-refs` the whole request. Answers are kept
//! in this colo's cache and, sealed, in the cache isolates share
//! (shared.rs), each for [`TTL_SECONDS`] at most, which bounds how stale
//! one can be should a change ever fail to move the version.
//!
//! Only ever served after the request was authorized, like any answer
//! from the store: a private repository's answers are kept like any
//! other's, and read only by whoever may read it.

use crate::git_http::GitRequest;
use crate::registry::RefsState;
use crate::shared::Shared;
use g1t_contracts::repos::GitService;
use worker::{Headers, Response, Result};

/// How long an answer is kept, at most.
pub const TTL_SECONDS: u64 = 60;
/// Larger answers (repositories with tens of thousands of refs) are not kept.
const MAX_KEPT_BYTES: usize = 1024 * 1024;
/// An `ls-refs` request larger than this (a great many ref prefixes) is
/// passed through.
const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// Where answers live in this colo's cache. Not reachable from outside.
const COLO_CACHE: &str = "https://refs.g1t.internal/";

/// What a request asks for that can be kept.
#[derive(Debug, PartialEq, Eq)]
pub enum Kind {
    /// `GET info/refs?service=git-upload-pack`: the ref advertisement, or
    /// for protocol v2 the capabilities.
    Advertisement,
    /// A protocol v2 `ls-refs` command, by the SHA-256 of the whole request,
    /// so only the same question gets the same answer.
    LsRefs { request: String },
}

/// What `git` asks that can be kept, if anything: only fetches, and of
/// those only the answers that list refs. `body` is a POST's.
pub fn kind(git: &GitRequest, get: bool, protocol: u8, body: Option<&[u8]>) -> Option<Kind> {
    if git.service != GitService::UploadPack {
        return None;
    }
    match (get, git.endpoint, body) {
        (true, "info/refs", _) => Some(Kind::Advertisement),
        (false, "git-upload-pack", Some(body)) if protocol == 2 && is_ls_refs(body) => Some(Kind::LsRefs {
            request: g1t_secrets::sha256_hex_bytes(body),
        }),
        _ => None,
    }
}

/// Whether `body` is a whole protocol v2 request whose command is `ls-refs`.
fn is_ls_refs(body: &[u8]) -> bool {
    if body.len() > MAX_REQUEST_BYTES {
        return false;
    }
    let (lines, end) = crate::land::read_pkt_lines(body);
    end == body.len()
        && lines
            .first()
            .is_some_and(|line| line.strip_suffix(b"\n").unwrap_or(line) == b"command=ls-refs")
}

/// The protocol version a `Git-Protocol` header asks for: `version=2`
/// among its colon-separated parameters. 0 without one.
pub fn protocol(header: Option<&str>) -> u8 {
    header
        .into_iter()
        .flat_map(|value| value.split(':'))
        .filter_map(|parameter| parameter.trim().strip_prefix("version="))
        .filter_map(|version| version.parse().ok())
        .next_back()
        .unwrap_or(0)
}

/// The version to keep answers under, if they may be kept now: not before
/// the version is known, nor while a credential that could push is out of
/// g1t's hands.
pub fn usable(state: Option<RefsState>, now: u64) -> Option<u64> {
    state.filter(|state| now >= state.open_until).map(|state| state.version)
}

/// Where one answer is kept.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Key {
    repo_id: String,
    hash: String,
}

impl Key {
    /// `head` is the default branch `HEAD` is rewritten to, if it is.
    pub fn new(repo_id: &str, version: u64, head: Option<&str>, protocol: u8, kind: &Kind) -> Key {
        let what = match kind {
            Kind::Advertisement => "advertisement".to_owned(),
            Kind::LsRefs { request } => format!("ls-refs {request}"),
        };
        // Branch names can hold characters a URL cannot, and git forbids
        // newlines in them.
        let head = head.map_or_else(|| "-".to_owned(), |branch| format!("refs/heads/{branch}"));
        Key {
            repo_id: repo_id.to_owned(),
            hash: g1t_secrets::sha256_hex(&format!("{version}\nv{protocol}\n{what}\n{head}")),
        }
    }

    fn colo_url(&self) -> String {
        format!("{COLO_CACHE}{}/{}", self.repo_id, self.hash)
    }

    fn shared_key(&self) -> String {
        format!("refs:{}:{}", self.repo_id, self.hash)
    }
}

/// A kept answer.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Entry {
    pub content_type: String,
    pub body: Vec<u8>,
}

impl Entry {
    /// Whether it is small enough to keep.
    pub fn keepable(&self) -> bool {
        // Every answer that lists refs ends with a flush packet; one that
        // does not (an error the store sent as a 200) is not kept.
        self.body.len() <= MAX_KEPT_BYTES && self.body.ends_with(b"0000") && !self.content_type.contains('\n')
    }

    fn encode(&self) -> Vec<u8> {
        let mut out = self.content_type.as_bytes().to_vec();
        out.push(b'\n');
        out.extend_from_slice(&self.body);
        out
    }

    fn decode(bytes: &[u8]) -> Option<Entry> {
        let at = bytes.iter().position(|byte| *byte == b'\n')?;
        Some(Entry {
            content_type: String::from_utf8(bytes[..at].to_vec()).ok()?,
            body: bytes[at + 1..].to_vec(),
        })
    }

    /// The answer, as the git store gives it.
    pub fn response(&self) -> Result<Response> {
        let headers = Headers::new();
        headers.set("content-type", &self.content_type)?;
        headers.set("cache-control", "no-cache")?;
        Ok(Response::from_bytes(self.body.clone())?.with_headers(headers))
    }
}

/// Where a kept answer was found, for `Server-Timing`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Found {
    Colo,
    Shared,
}

impl Found {
    pub fn as_str(self) -> &'static str {
        match self {
            Found::Colo => "hit-colo",
            Found::Shared => "hit-shared",
        }
    }
}

/// The answer kept under `key`: this colo's first, then the shared one.
pub async fn get(shared: Option<&Shared>, key: &Key) -> Option<(Entry, Found)> {
    if let Ok(Some(mut response)) = worker::Cache::default().get(key.colo_url(), false).await {
        let content_type = response.headers().get("content-type").ok().flatten();
        if let (Some(content_type), Ok(body)) = (content_type, response.bytes().await) {
            return Some((Entry { content_type, body }, Found::Colo));
        }
    }
    let bytes = shared?.get(&key.shared_key()).await?;
    Some((Entry::decode(&bytes)?, Found::Shared))
}

/// Keeps `entry` in this colo's cache. A failure only costs a later miss.
pub async fn keep_in_colo(key: &Key, entry: &Entry) {
    let headers = Headers::new();
    let _ = headers.set("content-type", &entry.content_type);
    let _ = headers.set("cache-control", &format!("public, max-age={TTL_SECONDS}"));
    let Ok(response) = Response::from_bytes(entry.body.clone()) else {
        return;
    };
    let _ = worker::Cache::default()
        .put(key.colo_url(), response.with_headers(headers))
        .await;
}

/// Keeps `entry` in this colo's cache and the shared one.
pub async fn keep(shared: Option<&Shared>, key: &Key, entry: &Entry) {
    if !entry.keepable() {
        return;
    }
    let shared_put = async {
        if let Some(shared) = shared {
            shared.put(&key.shared_key(), &entry.encode(), TTL_SECONDS).await;
        }
    };
    futures_util::future::join(keep_in_colo(key, entry), shared_put).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::repos::RepoPath;

    fn git(endpoint: &'static str, service: GitService) -> GitRequest {
        GitRequest {
            path: RepoPath {
                namespace: "acme".into(),
                name: "rocket".into(),
            },
            endpoint,
            service,
        }
    }

    fn pkt(payload: &str) -> Vec<u8> {
        format!("{:04x}{payload}", payload.len() + 4).into_bytes()
    }

    fn ls_refs(prefix: &str) -> Vec<u8> {
        [
            pkt("command=ls-refs\n"),
            pkt("agent=git/2.45.0\n"),
            pkt("object-format=sha1\n"),
            b"0001".to_vec(),
            pkt("peel\n"),
            pkt("symrefs\n"),
            pkt(&format!("ref-prefix {prefix}\n")),
            b"0000".to_vec(),
        ]
        .concat()
    }

    #[test]
    fn only_the_answers_that_list_refs_are_kept() {
        let refs = git("info/refs", GitService::UploadPack);
        assert_eq!(kind(&refs, true, 0, None), Some(Kind::Advertisement));
        assert_eq!(kind(&refs, true, 2, None), Some(Kind::Advertisement));
        // A push's advertisement is never kept: a push needs the refs as
        // they are.
        assert_eq!(kind(&git("info/refs", GitService::ReceivePack), true, 0, None), None);
        let pack = git("git-upload-pack", GitService::UploadPack);
        let listing = ls_refs("refs/heads/");
        assert!(matches!(kind(&pack, false, 2, Some(&listing)), Some(Kind::LsRefs { .. })));
        // Only under protocol v2, and never a fetch of objects.
        assert_eq!(kind(&pack, false, 0, Some(&listing)), None);
        let fetch = [pkt("command=fetch\n"), b"0001".to_vec(), pkt("want 1111111111111111111111111111111111111111\n"), pkt("done\n"), b"0000".to_vec()].concat();
        assert_eq!(kind(&pack, false, 2, Some(&fetch)), None);
        let v0 = [pkt("want 1111111111111111111111111111111111111111 side-band-64k\n"), b"0000".to_vec(), pkt("done\n")].concat();
        assert_eq!(kind(&pack, false, 0, Some(&v0)), None);
        // Not a whole request, or one too large: passed through.
        assert_eq!(kind(&pack, false, 2, Some(&listing[..listing.len() - 2])), None);
        let huge = [pkt("command=ls-refs\n"), b"0001".to_vec(), (0..3000).flat_map(|n| pkt(&format!("ref-prefix refs/heads/branch-{n}\n"))).collect(), b"0000".to_vec()].concat();
        assert_eq!(kind(&pack, false, 2, Some(&huge)), None);
        assert_eq!(kind(&pack, false, 2, None), None);
    }

    #[test]
    fn the_protocol_version_is_read_from_the_header() {
        assert_eq!(protocol(None), 0);
        assert_eq!(protocol(Some("version=2")), 2);
        assert_eq!(protocol(Some("version=1")), 1);
        assert_eq!(protocol(Some("other=x:version=2")), 2);
        assert_eq!(protocol(Some("version=banana")), 0);
    }

    #[test]
    fn nothing_is_kept_without_a_version_or_while_a_push_credential_is_out() {
        assert_eq!(usable(None, 1_000), None);
        assert_eq!(usable(Some(RefsState { version: 4, open_until: 0 }), 1_000), Some(4));
        assert_eq!(usable(Some(RefsState { version: 4, open_until: 2_000 }), 1_000), None);
        assert_eq!(usable(Some(RefsState { version: 4, open_until: 2_000 }), 2_000), Some(4));
    }

    #[test]
    fn every_part_of_the_question_is_in_the_key() {
        let base = Key::new("rep_1", 3, Some("main"), 0, &Kind::Advertisement);
        assert_eq!(base, Key::new("rep_1", 3, Some("main"), 0, &Kind::Advertisement));
        // A change to the refs moves the version and leaves the answer behind.
        assert_ne!(base, Key::new("rep_1", 4, Some("main"), 0, &Kind::Advertisement));
        // So does a new default branch, which HEAD is rewritten to.
        assert_ne!(base, Key::new("rep_1", 3, Some("trunk"), 0, &Kind::Advertisement));
        assert_ne!(base, Key::new("rep_1", 3, None, 0, &Kind::Advertisement));
        // v0 and v2 answer differently.
        assert_ne!(base, Key::new("rep_1", 3, Some("main"), 2, &Kind::Advertisement));
        assert_ne!(base, Key::new("rep_2", 3, Some("main"), 0, &Kind::Advertisement));
        let heads = Kind::LsRefs { request: g1t_secrets::sha256_hex_bytes(&ls_refs("refs/heads/")) };
        let tags = Kind::LsRefs { request: g1t_secrets::sha256_hex_bytes(&ls_refs("refs/tags/")) };
        assert_ne!(Key::new("rep_1", 3, Some("main"), 2, &heads), Key::new("rep_1", 3, Some("main"), 2, &tags));
        assert_ne!(Key::new("rep_1", 3, Some("main"), 2, &heads), Key::new("rep_1", 3, Some("main"), 2, &Kind::Advertisement));
        // Odd branch names still make a usable address.
        let odd = Key::new("rep_1", 3, Some("fix/#12 %20"), 0, &Kind::Advertisement);
        assert!(odd.colo_url().starts_with("https://refs.g1t.internal/rep_1/"));
        assert!(!odd.colo_url().contains('#') && !odd.colo_url().contains('%'));
        assert!(odd.shared_key().starts_with("refs:rep_1:"));
    }

    /// The functions in `source` (outside its tests) that call any of
    /// `writes`, each with whether it also records the change.
    fn writers(source: &str, writes: &[&str]) -> Vec<(String, bool)> {
        let code = source.split("#[cfg(test)]").next().unwrap_or_default();
        let lines: Vec<&str> = code.lines().collect();
        let starts: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| {
                let indent = line.len() - line.trim_start().len();
                let rest = line.trim_start();
                indent <= 4
                    && ["fn ", "async fn ", "pub fn ", "pub async fn ", "pub(crate) fn ", "pub(crate) async fn "]
                        .iter()
                        .any(|prefix| rest.starts_with(prefix))
            })
            .map(|(at, _)| at)
            .collect();
        let mut found = Vec::new();
        for (n, start) in starts.iter().enumerate() {
            let end = starts.get(n + 1).copied().unwrap_or(lines.len());
            let body = lines[*start..end].join("\n");
            if writes.iter().any(|write| body.contains(write)) {
                found.push((lines[*start].trim().to_owned(), body.contains("refs_moved(")));
            }
        }
        found
    }

    /// Everything that changes a repository's refs moves its version, or a
    /// kept answer would list them as they were. A new way of writing refs
    /// belongs in this list, and its caller must call `refs_moved`.
    #[test]
    fn every_ref_writer_records_the_change() {
        let writes = [
            "land::push_pack(",
            "land::delete_ref(",
            "land::fast_forward(",
            "land::push_ref(",
            "mirror::copy(",
            "copy(&theirs, &ours",
        ];
        let sources = [
            ("lib.rs", include_str!("lib.rs")),
            ("catch_up.rs", include_str!("catch_up.rs")),
            ("lifecycle.rs", include_str!("lifecycle.rs")),
            ("mirror.rs", include_str!("mirror.rs")),
            ("import.rs", include_str!("import.rs")),
            ("transfer.rs", include_str!("transfer.rs")),
            ("secret_scan.rs", include_str!("secret_scan.rs")),
            ("run_access.rs", include_str!("run_access.rs")),
            ("git_http.rs", include_str!("git_http.rs")),
            ("forks.rs", include_str!("forks.rs")),
        ];
        let mut all = Vec::new();
        for (file, source) in sources {
            for (function, records) in writers(source, &writes) {
                assert!(records, "{file}: `{function}` changes refs without calling refs_moved");
                all.push(function);
            }
        }
        // The writers known today, so that the check is seen to find them.
        for expected in ["create", "delete_branch", "land", "update_pull_branch", "mirror", "rename_branch", "forks_follow", "keep_head", "revive"] {
            assert!(
                all.iter().any(|function| function.contains(&format!("fn {expected}("))),
                "{expected} not found among {all:?}"
            );
        }
        // A push through git over HTTPS, and the default branch, which HEAD follows.
        let forwards = writers(include_str!("lib.rs"), &["git_http::forward("]);
        assert!(forwards.iter().any(|(function, _)| function.contains("fn answer_git(")));
        assert!(forwards.iter().all(|(_, records)| *records));
        let defaults = writers(include_str!("lifecycle.rs"), &["registry.set_default_branch("]);
        assert_eq!(defaults.len(), 3);
        assert!(defaults.iter().all(|(_, records)| *records));
    }

    #[test]
    fn an_entry_survives_being_kept() {
        let entry = Entry {
            content_type: "application/x-git-upload-pack-advertisement".into(),
            body: b"001e# service=git-upload-pack\n0000".to_vec(),
        };
        assert_eq!(Entry::decode(&entry.encode()), Some(entry.clone()));
        assert!(entry.keepable());
        let large = Entry { body: vec![b'0'; MAX_KEPT_BYTES + 1], ..entry };
        assert!(!large.keepable());
        assert_eq!(Entry::decode(b"no newline"), None);
    }
}
