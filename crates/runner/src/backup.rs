//! Cuts one repository's nightly backup: a `git bundle` of everything it
//! has, or of what is new since the last one, sent to g1t in parts
//! (`g1t_contracts::backups` has the flow; services/repos/src/backups.rs
//! keeps the chain).
//!
//! Nothing here is an agent and nothing is pushed. The sandbox holds the
//! job's token and nothing else: it asks for the job, which comes with a
//! read-only credential for the repository in the git store that lasts
//! minutes, clones every ref (`--mirror`, never shallow), and bundles
//! `--all` but the commits the last bundle ended at, and everything they
//! reach. Those are written as refs of their own first, so a repository
//! with thousands of refs never makes a command line too long.
//!
//! Configuration comes from the environment:
//!
//! - `G1T_API`: where to report.
//! - `BACKUP_JOB`, `BACKUP_TOKEN`: the job, and the token that does it.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::checks::redact;
use crate::env;

/// The header the job's token goes in (`g1t_contracts::backups::TOKEN_HEADER`).
const TOKEN_HEADER: &str = "x-g1t-backup-token";
/// Where the prerequisites are written as refs while the bundle is cut.
const PREREQ_REFS: &str = "refs/g1t-backup-prerequisites";
/// A transfer slower than this many bytes a second for `LOW_SPEED_SECONDS`
/// is given up, so a stalled clone does not hold the sandbox for hours.
const LOW_SPEED_BYTES: &str = "1000";
const LOW_SPEED_SECONDS: &str = "120";
const PART_TRIES: u32 = 3;

/// The job, as the API gives it (`BackupSpec`).
#[derive(Debug, Deserialize)]
struct Spec {
    kind: String,
    remote: String,
    git_token: String,
    #[serde(default)]
    prerequisites: Vec<String>,
    #[serde(default)]
    previous_refs: BTreeMap<String, String>,
    part_bytes: u64,
}

/// What was cut.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Cut {
    /// Every ref the clone has, and `HEAD`.
    pub refs: BTreeMap<String, String>,
    /// The bundle, or None when there was nothing new to put in one.
    pub bundle: Option<PathBuf>,
}

/// Runs git in `dir`, with `stdin` given to it, and returns its trimmed
/// output, failing on a non-zero exit with what it said.
fn git_in(dir: &Path, args: &[&str], stdin: Option<&str>) -> Result<String> {
    let mut child = Command::new("git")
        .current_dir(dir)
        .args(args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("could not run git")?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(input.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!(
            "git {} failed: {}",
            args.iter().find(|arg| !arg.starts_with('-') && !arg.contains('=')).unwrap_or(&""),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// `git for-each-ref` output, `<hash> <name>` a line, as a map.
pub(crate) fn parse_refs(listing: &str) -> BTreeMap<String, String> {
    listing
        .lines()
        .filter_map(|line| line.trim().split_once(' '))
        .filter(|(_, name)| !name.starts_with(PREREQ_REFS))
        .map(|(hash, name)| (name.trim().to_owned(), hash.trim().to_owned()))
        .collect()
}

/// Of `git cat-file --batch-check` output, the objects it found.
pub(crate) fn present(check: &str) -> Vec<String> {
    check
        .lines()
        .filter(|line| !line.ends_with(" missing"))
        .filter_map(|line| line.split(' ').next())
        .filter(|hash| !hash.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Whether git refused because the bundle would hold no objects: every
/// ref still points where the last bundle left it, or at what it reaches.
pub(crate) fn is_empty_bundle(error: &str) -> bool {
    error.contains("empty bundle")
}

/// Every ref of the clone in `dir`, and `HEAD` when it points somewhere.
pub(crate) fn refs_of(dir: &Path) -> Result<BTreeMap<String, String>> {
    let mut refs = parse_refs(&git_in(dir, &["for-each-ref", "--format=%(objectname) %(refname)"], None)?);
    if let Ok(head) = git_in(dir, &["rev-parse", "--verify", "--quiet", "HEAD"], None)
        && !head.is_empty()
    {
        refs.insert("HEAD".to_owned(), head);
    }
    Ok(refs)
}

/// Cuts the bundle of the clone in `dir` into `out`: every ref, leaving
/// out `prerequisites` (those the clone still has) and all they reach.
/// Nothing is cut when the refs are `previous` exactly, or there are none,
/// or nothing new is there.
pub(crate) fn cut(dir: &Path, prerequisites: &[String], previous: &BTreeMap<String, String>, out: &Path) -> Result<Cut> {
    let refs = refs_of(dir)?;
    if refs.is_empty() || (&refs == previous && !previous.is_empty() && !prerequisites.is_empty()) {
        return Ok(Cut { refs, bundle: None });
    }
    // Only those the clone has: a commit force-pushed away is no longer
    // there to leave out, and the bundle then carries a little more.
    let kept = if prerequisites.is_empty() {
        Vec::new()
    } else {
        present(&git_in(dir, &["cat-file", "--batch-check=%(objectname) %(objecttype)"], Some(&format!("{}\n", prerequisites.join("\n"))))?)
    };
    if !kept.is_empty() {
        let updates: String = kept.iter().map(|hash| format!("create {PREREQ_REFS}/{hash} {hash}\n")).collect();
        git_in(dir, &["update-ref", "--stdin"], Some(&updates))?;
    }
    let out_text = out.to_str().context("the bundle's path is not text")?;
    let glob = format!("--glob={PREREQ_REFS}/*");
    let exclude = format!("--exclude={PREREQ_REFS}/*");
    let mut args = vec!["bundle", "create", "--quiet", out_text, exclude.as_str(), "--all"];
    if !kept.is_empty() {
        args.extend(["--not", glob.as_str()]);
    }
    let made = git_in(dir, &args, None);
    if !kept.is_empty() {
        let deletes: String = kept.iter().map(|hash| format!("delete {PREREQ_REFS}/{hash}\n")).collect();
        git_in(dir, &["update-ref", "--stdin"], Some(&deletes))?;
    }
    match made {
        Ok(_) => {
            git_in(dir, &["bundle", "verify", "--quiet", out_text], None).context("the bundle does not verify")?;
            Ok(Cut { refs, bundle: Some(out.to_owned()) })
        }
        Err(error) if is_empty_bundle(&error.to_string()) => Ok(Cut { refs, bundle: None }),
        Err(error) => Err(error),
    }
}

/// The bytes of the clone's packs, which is what it read from the store.
fn pack_bytes(dir: &Path) -> u64 {
    std::fs::read_dir(dir.join("objects/pack"))
        .map(|entries| entries.filter_map(|entry| entry.ok()?.metadata().ok()).map(|meta| meta.len()).sum())
        .unwrap_or(0)
}

/// Talks to the API about one job.
struct Job {
    api: String,
    id: String,
    token: String,
    agent: ureq::Agent,
}

impl Job {
    fn url(&self, action: &str) -> String {
        format!("{}/backups/{}/{action}", self.api, self.id)
    }

    fn answer(result: std::result::Result<ureq::Response, ureq::Error>) -> Result<Value> {
        match result {
            Ok(response) => Ok(response.into_json()?),
            Err(ureq::Error::Status(status, response)) => {
                let body: Value = response.into_json().unwrap_or(Value::Null);
                let said = body["error"]["message"].as_str().unwrap_or("no reason given").to_owned();
                bail!("g1t answered {status}: {said}")
            }
            Err(error) => Err(error.into()),
        }
    }

    fn post(&self, action: &str, body: Value) -> Result<Value> {
        Job::answer(self.agent.post(&self.url(action)).set(TOKEN_HEADER, &self.token).send_json(body))
    }

    fn put_part(&self, number: u16, bytes: &[u8]) -> Result<Value> {
        let mut last = None;
        for _ in 0..PART_TRIES {
            let sent = self
                .agent
                .put(&self.url(&format!("parts/{number}")))
                .set(TOKEN_HEADER, &self.token)
                .set("content-type", "application/octet-stream")
                .send_bytes(bytes);
            match Job::answer(sent) {
                Ok(part) => return Ok(part),
                Err(error) => last = Some(error),
            }
        }
        Err(last.unwrap_or_else(|| anyhow::anyhow!("the part was not sent")))
    }
}

/// Sends the bundle in parts of `part_bytes`, hashing it on the way, and
/// returns its size, SHA-256 and the parts as g1t kept them.
fn send(job: &Job, bundle: &Path, part_bytes: u64) -> Result<(u64, String, Vec<Value>)> {
    let mut file = File::open(bundle)?;
    let mut hasher = Sha256::new();
    let mut parts = Vec::new();
    let mut size = 0u64;
    let mut buffer = vec![0u8; part_bytes as usize];
    loop {
        let mut filled = 0;
        while filled < buffer.len() {
            let read = file.read(&mut buffer[filled..])?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        if filled == 0 {
            break;
        }
        hasher.update(&buffer[..filled]);
        size += filled as u64;
        let number = u16::try_from(parts.len() + 1).context("the bundle has too many parts")?;
        parts.push(job.put_part(number, &buffer[..filled]).with_context(|| format!("could not send part {number}"))?);
        crate::abuse::touch();
        if filled < buffer.len() {
            break;
        }
    }
    Ok((size, hex::encode(hasher.finalize()), parts))
}

fn back_up(job: &Job, fetched: &mut u64) -> Result<String> {
    let spec: Spec = serde_json::from_value(job.post("spec", json!({}))?).context("the job's spec could not be read")?;
    let work = Path::new("/work");
    std::fs::create_dir_all(work)?;
    let mirror = work.join("backup.git");
    let auth = format!("http.extraHeader=Authorization: Bearer {}", spec.git_token);
    let mirror_text = mirror.to_str().context("the clone's path is not text")?;
    git_in(
        work,
        &[
            "-c",
            &auth,
            "-c",
            &format!("http.lowSpeedLimit={LOW_SPEED_BYTES}"),
            "-c",
            &format!("http.lowSpeedTime={LOW_SPEED_SECONDS}"),
            "clone",
            "--mirror",
            "--quiet",
            &spec.remote,
            mirror_text,
        ],
        None,
    )
    .context("could not clone the repository")?;
    *fetched = pack_bytes(&mirror).max(1);
    let cut = cut(&mirror, &spec.prerequisites, &spec.previous_refs, &work.join("backup.bundle"))?;
    let (size, sha256, parts) = match &cut.bundle {
        Some(bundle) => {
            let (size, sha256, parts) = send(job, bundle, spec.part_bytes)?;
            (size, Some(sha256), parts)
        }
        None => (0, None, Vec::new()),
    };
    job.post(
        "complete",
        json!({ "refs": cut.refs, "size": size, "sha256": sha256, "parts": parts, "fetched_bytes": *fetched }),
    )
    .context("could not report the backup")?;
    Ok(match cut.bundle {
        Some(_) => format!("{} bundle of {} refs, {size} bytes", spec.kind, cut.refs.len()),
        None => format!("nothing new to bundle in {} refs", cut.refs.len()),
    })
}

pub fn main() -> i32 {
    let (api, id, token) = match (env("G1T_API"), env("BACKUP_JOB"), env("BACKUP_TOKEN")) {
        (Ok(api), Ok(id), Ok(token)) => (api, id, token),
        _ => {
            eprintln!("g1t-runner: G1T_API, BACKUP_JOB and BACKUP_TOKEN must be set");
            return 2;
        }
    };
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(30)).timeout(Duration::from_secs(600)).build();
    let job = Job { api, id, token: token.clone(), agent };
    let mut fetched = 0;
    match back_up(&job, &mut fetched) {
        Ok(said) => {
            println!("g1t-runner: backed up: {said}");
            0
        }
        Err(error) => {
            let said = redact(&format!("{error:#}"), &[token]);
            eprintln!("g1t-runner: the backup failed: {said}");
            if let Err(error) = job.post("fail", json!({ "error": said, "fetched_bytes": fetched })) {
                eprintln!("g1t-runner: could not report the failure: {error:#}");
            }
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs_are_read_and_the_prerequisites_own_left_out() {
        let listing = "c71546fcd893ef8b0f57388b65e620d759705dda refs/heads/main\n\
                       4807077b296e6edbf410d55e72749d3e1170c291 refs/pull/pr_1/head\n\
                       4807077b296e6edbf410d55e72749d3e1170c291 refs/g1t-backup-prerequisites/4807077b296e6edbf410d55e72749d3e1170c291\n";
        let refs = parse_refs(listing);
        assert_eq!(refs.len(), 2);
        assert_eq!(refs["refs/heads/main"], "c71546fcd893ef8b0f57388b65e620d759705dda");
        assert!(parse_refs("").is_empty());
    }

    #[test]
    fn missing_prerequisites_are_dropped() {
        let check = "c71546fcd893ef8b0f57388b65e620d759705dda commit\n4807077b296e6edbf410d55e72749d3e1170c291 missing\n";
        assert_eq!(present(check), ["c71546fcd893ef8b0f57388b65e620d759705dda"]);
    }

    #[test]
    fn an_empty_bundle_is_told_apart_from_a_failure() {
        assert!(is_empty_bundle("git bundle failed: fatal: Refusing to create empty bundle."));
        assert!(!is_empty_bundle("git bundle failed: fatal: bad revision"));
    }

    // With git itself: a repository backed up full, then incrementally,
    // then restored from the chain the way the restore drill does it.

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("g1t-backup-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn commit(dir: &Path, file: &str, text: &str) {
        std::fs::write(dir.join(file), text).unwrap();
        git_in(dir, &["add", "--all"], None).unwrap();
        git_in(dir, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", text], None).unwrap();
    }

    fn mirror_of(origin: &Path, into: &Path) {
        let _ = std::fs::remove_dir_all(into);
        let parent = into.parent().unwrap();
        git_in(parent, &["clone", "--mirror", "--quiet", origin.to_str().unwrap(), into.to_str().unwrap()], None).unwrap();
    }

    fn prerequisites(refs: &BTreeMap<String, String>) -> Vec<String> {
        let unique: std::collections::BTreeSet<&String> = refs.values().collect();
        unique.into_iter().cloned().collect()
    }

    #[test]
    fn a_chain_of_bundles_restores_every_ref() {
        let root = scratch("chain");
        let origin = root.join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        git_in(&origin, &["init", "--quiet", "--initial-branch=main"], None).unwrap();
        commit(&origin, "a.txt", "one");
        git_in(&origin, &["tag", "-a", "v1", "-m", "v1"], None).unwrap();
        let mirror = root.join("mirror.git");

        // Full.
        mirror_of(&origin, &mirror);
        let full = cut(&mirror, &[], &BTreeMap::new(), &root.join("0-full.bundle")).unwrap();
        assert!(full.bundle.is_some());
        assert!(full.refs.contains_key("refs/tags/v1") && full.refs.contains_key("HEAD"));

        // Nothing changed: nothing is cut.
        mirror_of(&origin, &mirror);
        let same = cut(&mirror, &prerequisites(&full.refs), &full.refs, &root.join("x.bundle")).unwrap();
        assert_eq!(same.bundle, None);

        // New work, a new branch and a deleted tag: incremental.
        commit(&origin, "b.txt", "two");
        git_in(&origin, &["branch", "feature"], None).unwrap();
        git_in(&origin, &["tag", "-d", "v1"], None).unwrap();
        mirror_of(&origin, &mirror);
        let incr = cut(&mirror, &prerequisites(&full.refs), &full.refs, &root.join("1-incr.bundle")).unwrap();
        let incremental = incr.bundle.clone().expect("new commits make a bundle");
        assert!(!incr.refs.contains_key("refs/tags/v1"));
        // It needs the full one: alone, it does not verify.
        let lone = root.join("lone");
        git_in(&root, &["init", "--quiet", "--bare", lone.to_str().unwrap()], None).unwrap();
        assert!(git_in(&lone, &["bundle", "verify", incremental.to_str().unwrap()], None).is_err());

        // Only a ref moved to a commit already kept: no objects, no bundle.
        git_in(&origin, &["branch", "-f", "feature", "HEAD~1"], None).unwrap();
        mirror_of(&origin, &mirror);
        let moved = cut(&mirror, &prerequisites(&incr.refs), &incr.refs, &root.join("2-incr.bundle")).unwrap();
        assert_eq!(moved.bundle, None);
        assert_ne!(moved.refs, incr.refs);

        // Restored: each bundle in order, then the refs the last entry says.
        let restored = root.join("restored.git");
        git_in(&root, &["init", "--quiet", "--bare", restored.to_str().unwrap()], None).unwrap();
        for bundle in [full.bundle.unwrap(), incremental] {
            git_in(&restored, &["bundle", "verify", "--quiet", bundle.to_str().unwrap()], None).unwrap();
            git_in(&restored, &["fetch", "--quiet", "--no-tags", bundle.to_str().unwrap(), "+refs/*:refs/backup-staging/*"], None).unwrap();
        }
        let updates: String = moved
            .refs
            .iter()
            .filter(|(name, _)| name.as_str() != "HEAD")
            .map(|(name, hash)| format!("update {name} {hash}\n"))
            .collect();
        git_in(&restored, &["update-ref", "--stdin"], Some(&updates)).unwrap();
        let staging: String = git_in(&restored, &["for-each-ref", "--format=delete %(refname)", "refs/backup-staging/"], None).unwrap();
        git_in(&restored, &["update-ref", "--stdin"], Some(&format!("{staging}\n"))).unwrap();
        git_in(&restored, &["symbolic-ref", "HEAD", "refs/heads/main"], None).unwrap();
        assert_eq!(refs_of(&restored).unwrap(), moved.refs);
        git_in(&restored, &["fsck", "--no-progress", "--connectivity-only"], None).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }
}
