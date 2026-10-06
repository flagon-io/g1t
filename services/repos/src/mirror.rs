//! Copying every branch and tag from one git server to another: importing a
//! repository with a credential, keeping a mirror in step with the host it
//! mirrors, and pushing a repository's refs out to a host it is mirrored to.
//!
//! Like landing (see `land.rs`), this speaks git's smart HTTP protocol and
//! relays the pack it receives unchanged. Both sides are asked for their
//! refs; the source is asked for one pack holding what the target lacks;
//! the target is sent one push that moves every ref that differs.

use std::collections::{BTreeMap, HashSet};

use futures_util::StreamExt;
use worker::js_sys::Uint8Array;
use worker::{Fetch, Headers, Method, Request, RequestInit, Result};

use g1t_contracts::repos::{MirrorArgs, MirrorDirection, Mirrored};
use g1t_contracts::{FailureCode, Outcome};

use crate::land::{read_pkt_lines, unpack_sideband};
use crate::registry::store_key;
use crate::store::{GitRepo, GitStore, Scope};
use crate::{Repos, import, not_found};

const ZERO_ID: &str = "0000000000000000000000000000000000000000";
/// The most a pack may hold. A Worker holds it in memory while relaying it.
pub const MAX_PACK_BYTES: usize = 40 * 1024 * 1024;
/// How many of the target's commits are named to the source as already
/// had, so a sync only carries what is new.
const MAX_HAVES: usize = 256;
const USER_AGENT: &str = "git/2.45.0 (g1t mirror)";
/// A pack with no objects: for a push whose refs all name objects the
/// target already holds. The last 20 bytes are the SHA-1 of the first 12.
const EMPTY_PACK: [u8; 32] = [
    b'P', b'A', b'C', b'K', 0, 0, 0, 2, 0, 0, 0, 0, 0x02, 0x9d, 0x08, 0x82, 0x3b, 0xd8, 0xa8, 0xea,
    0xb5, 0x10, 0xad, 0x6a, 0xc7, 0x5c, 0x82, 0x3c, 0xfd, 0x3e, 0xd3, 0x1e,
];

/// One side of a copy: a repository's smart HTTP address and the
/// `authorization` header that opens it. The header is never logged.
pub struct Endpoint {
    pub url: String,
    pub authorization: String,
}

impl Endpoint {
    /// A g1t repository, with a credential from the git store.
    pub fn bearer(url: &str, token: &str) -> Self {
        Endpoint {
            url: url.trim_end_matches('/').to_owned(),
            authorization: format!("Bearer {token}"),
        }
    }

    /// A GitHub repository, with an installation access token. GitHub takes
    /// one as the password of the user `x-access-token`. The token is used
    /// as given: its length and shape are GitHub's to change.
    pub fn github(url: &str, token: &str) -> Self {
        Endpoint {
            url: url.trim_end_matches('/').to_owned(),
            authorization: format!("Basic {}", base64(&format!("x-access-token:{token}"))),
        }
    }
}

/// What a copy changed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Copied {
    /// Refs created or moved, each with where it was and where it is now.
    pub updated: Vec<(String, Option<String>, String)>,
    pub deleted: Vec<String>,
    /// The branch the source's HEAD names, when it said.
    pub head: Option<String>,
}

/// Which refs a copy moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Prune {
    /// Refs the source no longer has are deleted from the target: the
    /// target is a mirror of the source.
    Yes,
    /// Refs only the target has are left alone: pushing out to a host that
    /// may have branches of its own.
    No,
}

fn base64(text: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> shift) as usize & 63] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn pkt_line(payload: &str) -> Vec<u8> {
    format!("{:04x}{payload}", payload.len() + 4).into_bytes()
}

/// A ref advertisement: branch and tag refs by name, and the branch HEAD
/// points to when the server said.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Advertised {
    pub refs: BTreeMap<String, String>,
    pub head: Option<String>,
}

impl Advertised {
    /// The branch to make a copy's default: the one HEAD names, else
    /// `main`, else the first branch. `None` for a repository with none.
    pub fn default_branch(&self) -> Option<String> {
        let branches: Vec<&str> = self.refs.keys().filter_map(|name| name.strip_prefix("refs/heads/")).collect();
        self.head
            .clone()
            .filter(|head| branches.contains(&head.as_str()))
            .or_else(|| branches.iter().find(|name| **name == "main").map(|name| name.to_string()))
            .or_else(|| branches.first().map(|name| name.to_string()))
    }
}

/// Asks a source for its refs before anything is made from it, so an
/// address or credential that does not work leaves nothing behind.
pub async fn probe(source: &Endpoint) -> Result<std::result::Result<Advertised, String>> {
    advertise(source, "git-upload-pack").await
}

/// Reads `info/refs`. Peeled tags (`^{}`) and the placeholder an empty
/// repository sends are skipped; only branches and tags are kept.
pub fn parse_advertisement(bytes: &[u8]) -> Advertised {
    let (lines, _) = read_pkt_lines(bytes);
    let mut advertised = Advertised::default();
    for line in lines {
        let mut parts = line.splitn(2, |byte| *byte == 0);
        let Some(reference) = parts.next().and_then(|bytes| std::str::from_utf8(bytes).ok()) else {
            continue;
        };
        if let Some(capabilities) = parts.next().and_then(|bytes| std::str::from_utf8(bytes).ok()) {
            advertised.head = capabilities
                .split(' ')
                .find_map(|capability| capability.trim().strip_prefix("symref=HEAD:refs/heads/"))
                .map(str::to_owned)
                .or(advertised.head);
        }
        let Some((hash, name)) = reference.trim_end().split_once(' ') else {
            continue;
        };
        let kept = (name.starts_with("refs/heads/") || name.starts_with("refs/tags/")) && !name.ends_with("^{}");
        if kept && hash.len() == 40 && hash != ZERO_ID {
            advertised.refs.insert(name.to_owned(), hash.to_owned());
        }
    }
    advertised
}

/// One ref command for a push: `(name, old, new)`, `new` the zero id to
/// delete.
pub type Command = (String, Option<String>, String);

/// What has to change on `target` so its refs match `source`'s.
pub fn plan(source: &Advertised, target: &Advertised, prune: Prune) -> Vec<Command> {
    let mut commands = Vec::new();
    for (name, hash) in &source.refs {
        let old = target.refs.get(name);
        if old != Some(hash) {
            commands.push((name.clone(), old.cloned(), hash.clone()));
        }
    }
    if prune == Prune::Yes {
        for (name, hash) in &target.refs {
            if !source.refs.contains_key(name) {
                commands.push((name.clone(), Some(hash.clone()), ZERO_ID.to_owned()));
            }
        }
    }
    commands
}

/// The body of an upload-pack request for `wants`, naming `haves`.
pub fn upload_request(wants: &[String], haves: &[String]) -> Vec<u8> {
    let mut body = Vec::new();
    for (index, want) in wants.iter().enumerate() {
        // Capabilities ride on the first want only.
        let line = if index == 0 { format!("want {want} side-band-64k\n") } else { format!("want {want}\n") };
        body.extend(pkt_line(&line));
    }
    body.extend_from_slice(b"0000");
    for have in haves.iter().take(MAX_HAVES) {
        body.extend(pkt_line(&format!("have {have}\n")));
    }
    body.extend(pkt_line("done\n"));
    body
}

/// The body of a receive-pack request: the commands, then the pack when
/// anything but deletions is sent.
pub fn receive_request(commands: &[Command], pack: Option<Vec<u8>>) -> Vec<u8> {
    let deletes = commands.iter().any(|(_, _, new)| new == ZERO_ID);
    let capabilities = if deletes { "report-status delete-refs" } else { "report-status" };
    let mut body = Vec::new();
    for (index, (name, old, new)) in commands.iter().enumerate() {
        let old = old.as_deref().unwrap_or(ZERO_ID);
        let line = if index == 0 { format!("{old} {new} {name}\0 {capabilities}\n") } else { format!("{old} {new} {name}\n") };
        body.extend(pkt_line(&line));
    }
    body.extend_from_slice(b"0000");
    if commands.iter().any(|(_, _, new)| new != ZERO_ID) {
        body.extend(pack.unwrap_or_else(|| EMPTY_PACK.to_vec()));
    }
    body
}

/// Which commands a receive-pack report says were refused, with why.
pub fn refused(report: &[u8], commands: &[Command]) -> Vec<String> {
    let (lines, _) = read_pkt_lines(report);
    let lines: Vec<String> = lines
        .into_iter()
        .map(|line| {
            // A report may come inside side-band channel 1.
            let line = if line.first() == Some(&1) { &line[1..] } else { line };
            String::from_utf8_lossy(line).trim_end().to_owned()
        })
        .collect();
    let mut problems: Vec<String> = lines
        .iter()
        .filter(|line| line.starts_with("unpack ") && *line != "unpack ok")
        .cloned()
        .collect();
    for (name, _, _) in commands {
        if !lines.iter().any(|line| *line == format!("ok {name}")) {
            let reason = lines
                .iter()
                .find_map(|line| line.strip_prefix(&format!("ng {name} ")))
                .unwrap_or("not reported");
            problems.push(format!("{name}: {reason}"));
        }
    }
    problems
}

fn request(method: Method, url: &str, endpoint: &Endpoint, body: Option<(&str, Vec<u8>)>) -> Result<Request> {
    let headers = Headers::new();
    headers.set("user-agent", USER_AGENT)?;
    headers.set("authorization", &endpoint.authorization)?;
    let mut init = RequestInit::new();
    if let Some((service, body)) = body {
        headers.set("content-type", &format!("application/x-{service}-request"))?;
        headers.set("accept", &format!("application/x-{service}-result"))?;
        init.with_body(Some(Uint8Array::from(body.as_slice()).into()));
    }
    init.with_method(method).with_headers(headers);
    Request::new_with_init(url, &init)
}

/// Asks a server for its refs, as the given service would see them.
async fn advertise(endpoint: &Endpoint, service: &str) -> Result<std::result::Result<Advertised, String>> {
    let url = format!("{}/info/refs?service={service}", endpoint.url);
    let mut response = match Fetch::Request(request(Method::Get, &url, endpoint, None)?).send().await {
        Ok(response) => response,
        Err(_) => return Ok(Err("The repository could not be reached.".to_owned())),
    };
    match response.status_code() {
        200 => Ok(Ok(parse_advertisement(&response.bytes().await?))),
        401 | 403 => Ok(Err("The repository refused g1t's credential.".to_owned())),
        404 => Ok(Err("The repository was not found, or g1t may not read it.".to_owned())),
        status => Ok(Err(format!("The repository answered {status}."))),
    }
}

/// Fetches one pack holding `wants`, reading in pieces so that one too
/// large is noticed before it is all held.
async fn fetch_pack(source: &Endpoint, wants: &[String], haves: &[String]) -> Result<std::result::Result<Vec<u8>, String>> {
    let body = upload_request(wants, haves);
    let url = format!("{}/git-upload-pack", source.url);
    let mut response = Fetch::Request(request(Method::Post, &url, source, Some(("git-upload-pack", body)))?)
        .send()
        .await?;
    if response.status_code() != 200 {
        return Ok(Err(format!("The source refused to send the repository ({}).", response.status_code())));
    }
    let mut received = Vec::new();
    let mut stream = response.stream()?;
    while let Some(chunk) = stream.next().await {
        received.extend_from_slice(&chunk?);
        if received.len() > MAX_PACK_BYTES {
            return Ok(Err(format!(
                "The repository is larger than {} MB, the most g1t copies at once. Push it with git instead.",
                MAX_PACK_BYTES / 1024 / 1024
            )));
        }
    }
    Ok(unpack_sideband(&received).map_err(|_| "The source did not send a usable pack.".to_owned()))
}

/// Makes `target`'s branches and tags match `source`'s. With
/// `Prune::No`, refs only the target has are kept. `Err` in the inner
/// result is a reason to show a person.
pub async fn copy(source: &Endpoint, target: &Endpoint, prune: Prune) -> Result<std::result::Result<Copied, String>> {
    let theirs = match advertise(source, "git-upload-pack").await? {
        Ok(refs) => refs,
        Err(reason) => return Ok(Err(reason)),
    };
    let ours = match advertise(target, "git-receive-pack").await? {
        Ok(refs) => refs,
        Err(reason) => return Ok(Err(format!("Writing the copy failed: {reason}"))),
    };
    let commands = plan(&theirs, &ours, prune);
    let mut copied = Copied {
        head: theirs.head.clone(),
        ..Copied::default()
    };
    if commands.is_empty() {
        return Ok(Ok(copied));
    }
    let held: HashSet<&String> = ours.refs.values().collect();
    let mut wants: Vec<String> = commands
        .iter()
        .map(|(_, _, new)| new)
        .filter(|new| *new != ZERO_ID && !held.contains(new))
        .cloned()
        .collect();
    wants.sort();
    wants.dedup();
    let pack = if wants.is_empty() {
        None
    } else {
        let haves: Vec<String> = ours.refs.values().cloned().collect::<HashSet<_>>().into_iter().collect();
        match fetch_pack(source, &wants, &haves).await? {
            Ok(pack) => Some(pack),
            Err(reason) => return Ok(Err(reason)),
        }
    };
    let body = receive_request(&commands, pack);
    let url = format!("{}/git-receive-pack", target.url);
    let mut response = Fetch::Request(request(Method::Post, &url, target, Some(("git-receive-pack", body)))?)
        .send()
        .await?;
    let report = response.bytes().await?;
    if response.status_code() != 200 {
        return Ok(Err(format!("The push was refused ({}).", response.status_code())));
    }
    let problems = refused(&report, &commands);
    if !problems.is_empty() {
        return Ok(Err(format!("Some refs were not updated: {}", problems.join("; "))));
    }
    for (name, old, new) in commands {
        if new == ZERO_ID {
            copied.deleted.push(name);
        } else {
            copied.updated.push((name, old, new));
        }
    }
    Ok(Ok(copied))
}

impl<S: GitStore> Repos<S> {
    /// `mirror`: a mirror catching up with the host it mirrors, or a
    /// repository pushing its refs out to one. Each branch moved on g1t is
    /// announced as a push, so deployments and checks follow it.
    pub(crate) async fn mirror(&self, a: MirrorArgs) -> Result<Outcome<Mirrored>> {
        let Some(repo) = self.registry.by_id(&a.repo_id).await? else {
            return Ok(not_found());
        };
        let Some(url) = import::clean_url(&a.url) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "That is not an https repository address."));
        };
        let scope = match a.direction {
            MirrorDirection::Pull => Scope::Write,
            MirrorDirection::Push => Scope::Read,
        };
        let access = self.store.open(&store_key(&repo)).await?.access(scope).await?;
        let ours = Endpoint::bearer(&access.remote, &access.token);
        let theirs = Endpoint::github(&url, &a.token);
        let copied = match a.direction {
            MirrorDirection::Pull => {
                let copied = copy(&theirs, &ours, Prune::Yes).await?;
                self.refs_moved(&repo.id).await;
                copied
            }
            MirrorDirection::Push => copy(&ours, &theirs, Prune::No).await?,
        };
        let copied = match copied {
            Ok(copied) => copied,
            Err(reason) => return Ok(Outcome::fail(FailureCode::Conflict, reason)),
        };
        if a.direction == MirrorDirection::Pull {
            for (name, old, new) in &copied.updated {
                if name.starts_with("refs/heads/") {
                    self.publish_push(&repo, name, old.as_deref(), new, None).await?;
                }
            }
        }
        Ok(Outcome::Ok(Mirrored {
            updated: copied.updated.into_iter().map(|(name, _, _)| name).collect(),
            deleted: copied.deleted,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "c71546fcd893ef8b0f57388b65e620d759705dda";
    const B: &str = "4807077b296e6edbf410d55e72749d3e1170c291";
    const C: &str = "1111111111111111111111111111111111111111";

    fn advertised(refs: &[(&str, &str)]) -> Advertised {
        Advertised {
            refs: refs.iter().map(|(name, hash)| (name.to_string(), hash.to_string())).collect(),
            head: None,
        }
    }

    #[test]
    fn the_basic_header_carries_the_token_whole() {
        assert_eq!(base64("x-access-token:abc"), "eC1hY2Nlc3MtdG9rZW46YWJj");
        assert_eq!(base64("a"), "YQ==");
        assert_eq!(base64("ab"), "YWI=");
        // GitHub's stateless installation tokens run to hundreds of
        // characters; nothing here assumes a length.
        let token = format!("ghs_{}", "x".repeat(516));
        assert_eq!(token.len(), 520);
        let endpoint = Endpoint::github("https://github.com/o/r.git/", &token);
        assert_eq!(endpoint.url, "https://github.com/o/r.git");
        let encoded = endpoint.authorization.strip_prefix("Basic ").unwrap();
        assert_eq!(encoded, base64(&format!("x-access-token:{token}")));
        assert_eq!(encoded.len(), (15 + 520usize).div_ceil(3) * 4);
    }

    #[test]
    fn the_advertisement_keeps_branches_and_tags() {
        let bytes = [
            pkt_line("# service=git-upload-pack\n"),
            b"0000".to_vec(),
            pkt_line(&format!("{A} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/trunk agent=git/x\n")),
            pkt_line(&format!("{A} refs/heads/trunk\n")),
            pkt_line(&format!("{B} refs/tags/v1\n")),
            pkt_line(&format!("{A} refs/tags/v1^{{}}\n")),
            pkt_line(&format!("{C} refs/pull/1/head\n")),
            b"0000".to_vec(),
        ]
        .concat();
        let parsed = parse_advertisement(&bytes);
        assert_eq!(parsed.head.as_deref(), Some("trunk"));
        assert_eq!(parsed, Advertised {
            refs: advertised(&[("refs/heads/trunk", A), ("refs/tags/v1", B)]).refs,
            head: Some("trunk".to_owned()),
        });
        assert_eq!(parsed.default_branch().as_deref(), Some("trunk"));
        assert_eq!(advertised(&[("refs/heads/a", A), ("refs/heads/main", A)]).default_branch().as_deref(), Some("main"));
        assert_eq!(advertised(&[("refs/tags/v1", A)]).default_branch(), None);
        let empty = [pkt_line(&format!("{ZERO_ID} capabilities^{{}}\0report-status\n")), b"0000".to_vec()].concat();
        assert!(parse_advertisement(&empty).refs.is_empty());
    }

    #[test]
    fn a_mirror_prunes_and_a_push_out_does_not() {
        let source = advertised(&[("refs/heads/main", A), ("refs/tags/v1", B)]);
        let target = advertised(&[("refs/heads/main", B), ("refs/heads/old", C)]);
        assert_eq!(plan(&source, &target, Prune::Yes), vec![
            ("refs/heads/main".to_owned(), Some(B.to_owned()), A.to_owned()),
            ("refs/tags/v1".to_owned(), None, B.to_owned()),
            ("refs/heads/old".to_owned(), Some(C.to_owned()), ZERO_ID.to_owned()),
        ]);
        assert_eq!(plan(&source, &target, Prune::No).len(), 2);
        assert!(plan(&source, &source, Prune::Yes).is_empty());
    }

    #[test]
    fn a_push_of_known_objects_sends_an_empty_pack() {
        let commands = vec![("refs/tags/v1".to_owned(), None, A.to_owned())];
        let body = receive_request(&commands, None);
        assert!(body.ends_with(&EMPTY_PACK));
        let deletes = vec![("refs/heads/x".to_owned(), Some(A.to_owned()), ZERO_ID.to_owned())];
        let body = receive_request(&deletes, None);
        assert!(body.ends_with(b"0000"));
        assert!(String::from_utf8_lossy(&body).contains("delete-refs"));
    }

    #[test]
    fn wants_carry_capabilities_once() {
        let body = String::from_utf8(upload_request(&[A.to_owned(), B.to_owned()], &[C.to_owned()])).unwrap();
        assert_eq!(body.matches("side-band-64k").count(), 1);
        assert!(body.contains(&format!("want {B}\n")));
        assert!(body.contains(&format!("have {C}\n")));
        assert!(body.ends_with("0009done\n"));
    }

    #[test]
    fn refusals_are_reported_by_ref() {
        let commands = vec![
            ("refs/heads/main".to_owned(), None, A.to_owned()),
            ("refs/heads/x".to_owned(), None, B.to_owned()),
        ];
        let report = [
            pkt_line("unpack ok\n"),
            pkt_line("ok refs/heads/main\n"),
            pkt_line("ng refs/heads/x protected branch\n"),
            b"0000".to_vec(),
        ]
        .concat();
        assert_eq!(refused(&report, &commands), vec!["refs/heads/x: protected branch".to_owned()]);
        let fine = [pkt_line("unpack ok\n"), pkt_line("ok refs/heads/main\n"), pkt_line("ok refs/heads/x\n")].concat();
        assert!(refused(&fine, &commands).is_empty());
    }
}
