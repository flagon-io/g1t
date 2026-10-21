//! `MODE=gitedge` as a GitEdge Container runs it: the server on a port of
//! its own, syncing a mirror from a "remote" (here a bare repository on
//! disk, by a file:// URL) and answering the real git client's clones and
//! fetches through `git http-backend`.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// The token every sync is given: it must never show in the server's output.
const TOKEN: &str = "artifacts-token-5ec2e7-never-logged";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("g1t-gitedge-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Runs git in `dir` and returns its trimmed output, failing the test on a
/// non-zero exit.
fn git(dir: &Path, args: &[&str]) -> String {
    let output = try_git(dir, args, &[]);
    assert!(output.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn try_git(dir: &Path, args: &[&str], env: &[(&str, &str)]) -> std::process::Output {
    Command::new("git")
        .current_dir(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"])
        .args(args)
        .envs(env.iter().copied())
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap()
}

fn commit(dir: &Path, file: &str, text: &str) {
    std::fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", "--all"]);
    git(dir, &["commit", "--quiet", "-m", text]);
}

fn file_url(path: &Path) -> String {
    let path = path.to_str().unwrap().replace('\\', "/");
    if path.starts_with('/') { format!("file://{path}") } else { format!("file:///{path}") }
}

/// Every ref of a repository and the object it names.
fn refs(dir: &Path) -> String {
    git(dir, &["for-each-ref", "--format=%(objectname) %(refname)"])
}

/// Every object every ref of a repository reaches.
fn objects(dir: &Path) -> Vec<String> {
    let mut objects: Vec<String> = git(dir, &["rev-list", "--all", "--objects"]).lines().map(|line| line[..40].to_owned()).collect();
    objects.sort();
    objects
}

/// The server, killed when dropped.
struct Edge {
    child: Child,
    port: u16,
    log: Arc<Mutex<String>>,
}

impl Edge {
    fn start(dir: &Path) -> Edge {
        let mut child = Command::new(env!("CARGO_BIN_EXE_g1t-runner"))
            .env("MODE", "gitedge")
            .env("GITEDGE_PORT", "0")
            .env("GITEDGE_DIR", dir)
            .env("G1T_ABUSE", "off")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let log = Arc::new(Mutex::new(String::new()));
        let (send_port, port) = mpsc::channel();
        let stderr = child.stderr.take().unwrap();
        let kept = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Some(listening) = line.split("listening on ").nth(1) {
                    let address = listening.split(',').next().unwrap();
                    let _ = send_port.send(address.rsplit(':').next().unwrap().parse::<u16>().unwrap());
                }
                let mut log = kept.lock().unwrap();
                log.push_str(&line);
                log.push('\n');
            }
        });
        let port = port.recv_timeout(Duration::from_secs(30)).expect("the server says where it listens");
        Edge { child, port, log }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn log(&self) -> String {
        self.log.lock().unwrap().clone()
    }

    fn sync(&self, remote: &str, version: u64) {
        let body = json!({ "remote": remote, "token": TOKEN, "version": version, "head": "refs/heads/main" });
        let response = ureq::post(&self.url("/sync")).send_json(body).unwrap();
        assert_eq!(response.status(), 202);
    }

    fn state(&self) -> Value {
        ureq::get(&self.url("/state")).call().unwrap().into_json().unwrap()
    }

    /// Waits for every sync asked for to end, and returns the version.
    fn settled(&self) -> Value {
        let started = Instant::now();
        loop {
            let state = self.state();
            if state["syncing"] == json!(false) {
                return state["version"].clone();
            }
            assert!(started.elapsed() < Duration::from_secs(120), "the sync never ended:\n{}", self.log());
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// A git request's status, and its `x-g1t-edge` header.
    fn status(&self, request: ureq::Request) -> (u16, Option<String>) {
        let response = match request.call() {
            Ok(response) => response,
            Err(ureq::Error::Status(_, response)) => response,
            Err(error) => panic!("{error}"),
        };
        (response.status(), response.header("x-g1t-edge").map(str::to_owned))
    }
}

impl Drop for Edge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `git` against the edge, expecting `version`.
fn edge_git(dir: &Path, version: u64, args: &[&str]) -> std::process::Output {
    let header = format!("http.extraHeader=x-g1t-edge-version: {version}");
    let mut all = vec!["-c", header.as_str()];
    all.extend_from_slice(args);
    try_git(dir, &all, &[])
}

fn assert_ok(output: &std::process::Output, what: &str) {
    assert!(output.status.success(), "{what} failed: {}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn the_edge_mirrors_a_repository_and_serves_it_to_git() {
    let root = scratch("serve");
    // The "remote": a bare repository with branches, tags and some history.
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "--quiet", "--initial-branch=main"]);
    for n in 0..5 {
        commit(&work, &format!("file{n}.txt"), &format!("change {n}\n").repeat(200));
    }
    git(&work, &["tag", "-a", "v1", "-m", "v1"]);
    git(&work, &["branch", "feature", "HEAD~2"]);
    git(&work, &["tag", "light", "HEAD~1"]);
    let origin = root.join("origin.git");
    git(&root, &["clone", "--bare", "--quiet", work.to_str().unwrap(), origin.to_str().unwrap()]);
    git(&work, &["remote", "add", "origin", origin.to_str().unwrap()]);
    let remote = file_url(&origin);

    let edge = Edge::start(&root.join("edge"));
    assert_eq!(edge.state(), json!({ "version": null, "syncing": false }));

    // Before any sync, nothing is served.
    let info_refs = edge.url("/git/info/refs?service=git-upload-pack");
    assert_eq!(edge.status(ureq::get(&info_refs).set("x-g1t-edge-version", "1")), (409, Some("behind".to_owned())));

    // The first sync: fetched, and repacked in full with a bitmap.
    edge.sync(&remote, 1);
    assert_eq!(edge.settled(), json!(1));
    let pack_dir = root.join("edge/repo.git/objects/pack");
    let files: Vec<String> = std::fs::read_dir(&pack_dir).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(files.iter().filter(|name| name.ends_with(".pack")).count(), 1, "{files:?}");
    assert!(files.iter().any(|name| name.ends_with(".bitmap")), "{files:?}");
    assert_eq!(git(&root.join("edge/repo.git"), &["symbolic-ref", "HEAD"]), "refs/heads/main");

    // Full clones, protocol v2 and v0: every ref and object of the source.
    let git_url = edge.url("/git");
    let mut clones = Vec::new();
    for protocol in ["2", "0"] {
        let clone = root.join(format!("clone-v{protocol}.git"));
        let option = format!("protocol.version={protocol}");
        let output = edge_git(&root, 1, &["-c", &option, "clone", "--mirror", "--quiet", &git_url, clone.to_str().unwrap()]);
        assert_ok(&output, &format!("a protocol v{protocol} clone"));
        assert_eq!(refs(&clone), refs(&origin));
        assert_eq!(objects(&clone), objects(&origin));
        git(&clone, &["fsck", "--no-progress"]);
        clones.push(clone);
    }

    // A shallow clone: the tip alone.
    let shallow = root.join("shallow.git");
    assert_ok(&edge_git(&root, 1, &["clone", "--bare", "--quiet", "--depth", "1", &git_url, shallow.to_str().unwrap()]), "a shallow clone");
    assert_eq!(git(&shallow, &["rev-parse", "--is-shallow-repository"]), "true");
    assert_eq!(git(&shallow, &["rev-parse", "HEAD"]), git(&origin, &["rev-parse", "refs/heads/main"]));
    assert_eq!(git(&shallow, &["rev-list", "--count", "HEAD"]), "1");

    // A blobless clone: commits and trees, no blobs.
    let blobless = root.join("blobless.git");
    assert_ok(&edge_git(&root, 1, &["clone", "--bare", "--quiet", "--filter=blob:none", &git_url, blobless.to_str().unwrap()]), "a blobless clone");
    let listing = git(&blobless, &["rev-list", "--all", "--objects", "--missing=print"]);
    assert!(listing.lines().any(|line| line.starts_with('?')), "no blob was left out:\n{listing}");
    assert_eq!(git(&blobless, &["rev-parse", "HEAD"]), git(&origin, &["rev-parse", "refs/heads/main"]));

    // A wrong version, or none, is refused as behind.
    assert_eq!(edge.status(ureq::get(&info_refs).set("x-g1t-edge-version", "7")), (409, Some("behind".to_owned())));
    assert_eq!(edge.status(ureq::get(&info_refs)), (409, Some("behind".to_owned())));
    let upload_pack = edge.url("/git/git-upload-pack");
    assert_eq!(edge.status(ureq::post(&upload_pack).set("x-g1t-edge-version", "7")), (409, Some("behind".to_owned())));

    // receive-pack, and anything else, is forbidden.
    let receive = edge.url("/git/info/refs?service=git-receive-pack");
    assert_eq!(edge.status(ureq::get(&receive).set("x-g1t-edge-version", "1")).0, 403);
    assert_eq!(edge.status(ureq::post(&edge.url("/git/git-receive-pack")).set("x-g1t-edge-version", "1")).0, 403);
    assert_eq!(edge.status(ureq::get(&edge.url("/git/HEAD")).set("x-g1t-edge-version", "1")).0, 403);
    let push = edge_git(&clones[0], 1, &["push", &git_url, "HEAD:refs/heads/pushed"]);
    assert!(!push.status.success());

    // New work at the source, a second sync, and an incremental fetch.
    commit(&work, "file5.txt", "after the first sync\n");
    git(&work, &["branch", "next"]);
    git(&work, &["push", "--quiet", "origin", "main", "next"]);
    git(&work, &["push", "--quiet", "origin", ":refs/tags/light"]);
    edge.sync(&remote, 2);
    assert_eq!(edge.settled(), json!(2));
    assert!(edge.log().contains("synced to version 2"), "{}", edge.log());
    // The old version is behind now: git is refused.
    assert!(!edge_git(&clones[0], 1, &["fetch", "--quiet", "origin"]).status.success());
    let trace = root.join("trace.txt");
    let header = "http.extraHeader=x-g1t-edge-version: 2";
    let fetched = try_git(&clones[0], &["-c", header, "fetch", "--quiet", "--prune", "origin"], &[("GIT_TRACE_PACKET", trace.to_str().unwrap())]);
    assert_ok(&fetched, "an incremental fetch");
    assert_eq!(refs(&clones[0]), refs(&origin));
    assert_eq!(objects(&clones[0]), objects(&origin));
    let traced = std::fs::read_to_string(&trace).unwrap();
    assert!(traced.contains("have "), "the fetch sent no haves");

    // A failed sync leaves the version, and the mirror still serves it.
    edge.sync(&file_url(&root.join("missing.git")), 3);
    assert_eq!(edge.settled(), json!(2));
    assert!(edge.log().contains("the sync to version 3 failed"), "{}", edge.log());
    assert_ok(&edge_git(&root, 2, &["ls-remote", &git_url]), "ls-remote after a failed sync");

    // Syncs asked for together: the latest is where the mirror ends up.
    edge.sync(&file_url(&root.join("missing.git")), 10);
    edge.sync(&remote, 4);
    assert_eq!(edge.settled(), json!(4));

    // Each sync and git request is logged; the token never is.
    let log = edge.log();
    assert!(log.contains("GET info/refs 200"), "{log}");
    assert!(log.contains("POST git-upload-pack 200"), "{log}");
    assert!(log.contains("synced to version 1") && log.contains("repacked in full"), "{log}");
    assert!(!log.contains(TOKEN), "the token was logged:\n{log}");
    drop(edge);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_bad_sync_request_is_refused() {
    let root = scratch("refuse");
    let edge = Edge::start(&root.join("edge"));
    let sync = edge.url("/sync");
    let status = |body: Value| match ureq::post(&sync).send_json(body) {
        Ok(response) => response.status(),
        Err(ureq::Error::Status(status, _)) => status,
        Err(error) => panic!("{error}"),
    };
    assert_eq!(status(json!({ "remote": "--upload-pack=touch /tmp/x", "token": TOKEN, "version": 1, "head": "refs/heads/main" })), 400);
    assert_eq!(status(json!({ "remote": "https://example.com/r.git", "token": TOKEN, "version": 1, "head": "main" })), 400);
    assert_eq!(status(json!({ "remote": "https://example.com/r.git", "token": TOKEN, "version": "one", "head": "refs/heads/main" })), 400);
    assert_eq!(edge.state(), json!({ "version": null, "syncing": false }));
    assert!(!edge.log().contains(TOKEN));
    drop(edge);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_snapshot_restores_an_empty_edge_to_its_version() {
    let root = scratch("snapshot");
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "--quiet", "--initial-branch=main"]);
    for n in 0..3 {
        commit(&work, &format!("file{n}.txt"), &format!("change {n}\n").repeat(100));
    }
    let origin = root.join("origin.git");
    git(&root, &["clone", "--bare", "--quiet", work.to_str().unwrap(), origin.to_str().unwrap()]);
    git(&work, &["remote", "add", "origin", origin.to_str().unwrap()]);
    let remote = file_url(&origin);

    // Nothing to snapshot before a sync.
    let first = Edge::start(&root.join("first"));
    assert_eq!(first.status(ureq::get(&first.url("/snapshot"))).0, 409);
    first.sync(&remote, 3);
    assert_eq!(first.settled(), json!(3));
    let response = ureq::get(&first.url("/snapshot")).call().unwrap();
    assert_eq!(response.header("x-g1t-edge-version"), Some("3"));
    let length: usize = response.header("content-length").unwrap().parse().unwrap();
    let mut snapshot = Vec::new();
    std::io::Read::read_to_end(&mut response.into_reader(), &mut snapshot).unwrap();
    assert_eq!(snapshot.len(), length);

    // A cold edge restored from it is at its version, and serves it.
    let second = Edge::start(&root.join("second"));
    let put = |edge: &Edge, version: &str, body: &[u8]| match ureq::put(&edge.url("/snapshot")).set("x-g1t-edge-version", version).send_bytes(body) {
        Ok(response) => response.status(),
        Err(ureq::Error::Status(status, _)) => status,
        Err(error) => panic!("{error}"),
    };
    assert_eq!(put(&second, "3", &snapshot), 204);
    assert_eq!(second.state()["version"], json!(3));
    let clone = root.join("clone.git");
    let url = second.url("/git");
    assert_ok(&edge_git(&root, 3, &["clone", "--bare", "--quiet", &url, clone.to_str().unwrap()]), "a clone of the restored edge");
    assert_eq!(objects(&clone), objects(&origin));
    // Only ever into an empty edge.
    assert_eq!(put(&second, "3", &snapshot), 409);

    // A sync after the restore fetches only what is new.
    commit(&work, "file3.txt", "more\n");
    git(&work, &["push", "--quiet", "origin", "main"]);
    second.sync(&remote, 4);
    assert_eq!(second.settled(), json!(4));
    assert_eq!(refs(&root.join("second/repo.git")), refs(&origin));

    // What is not a snapshot leaves nothing behind, and no version.
    let third = Edge::start(&root.join("third"));
    assert_eq!(put(&third, "3", b"not a tar"), 422);
    assert_eq!(third.state()["version"], Value::Null);
    assert!(!root.join("third/repo.git").exists());
    assert_eq!(put(&third, "x", &snapshot), 400);
    assert!(!first.log().contains(TOKEN) && !second.log().contains(TOKEN));
}

/// A protocol v2 fetch of `want` at depth 1, as raw pkt-lines.
fn fetch_body(want: &str) -> Vec<u8> {
    let pkt = |line: &str| format!("{:04x}{line}", line.len() + 4);
    [pkt("command=fetch\n"), pkt("object-format=sha1\n"), "0001".to_owned(), pkt("deepen 1\n"), pkt(&format!("want {want}\n")), pkt("done\n"), "0000".to_owned()]
        .concat()
        .into_bytes()
}

#[test]
fn a_fetch_for_what_the_mirror_lacks_is_behind() {
    let root = scratch("wants");
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "--quiet", "--initial-branch=main"]);
    commit(&work, "a.txt", "one\n");
    let origin = root.join("origin.git");
    git(&root, &["clone", "--bare", "--quiet", work.to_str().unwrap(), origin.to_str().unwrap()]);
    git(&work, &["remote", "add", "origin", origin.to_str().unwrap()]);
    let edge = Edge::start(&root.join("edge"));
    edge.sync(&file_url(&origin), 1);
    assert_eq!(edge.settled(), json!(1));
    let had = git(&work, &["rev-parse", "HEAD"]);
    // A commit the store has and the mirror does not, as right after a
    // merge when the version asked for trails the repository's.
    commit(&work, "b.txt", "two\n");
    git(&work, &["push", "--quiet", "origin", "main"]);
    let new = git(&work, &["rev-parse", "HEAD"]);
    let fetch = |want: &str| {
        match ureq::post(&edge.url("/git/git-upload-pack"))
            .set("x-g1t-edge-version", "1")
            .set("git-protocol", "version=2")
            .set("content-type", "application/x-git-upload-pack-request")
            .send_bytes(&fetch_body(want))
        {
            Ok(response) => (response.status(), response.header("x-g1t-edge").map(str::to_owned)),
            Err(ureq::Error::Status(status, response)) => (status, response.header("x-g1t-edge").map(str::to_owned)),
            Err(error) => panic!("{error}"),
        }
    };
    assert_eq!(fetch(&had), (200, None));
    assert_eq!(fetch(&new), (409, Some("behind".to_owned())));
    assert!(edge.log().contains(&format!("the mirror has no {new}")), "{}", edge.log());
    // Once it has caught up, it answers.
    edge.sync(&file_url(&origin), 2);
    assert_eq!(edge.settled(), json!(2));
    let clone = root.join("clone");
    assert_ok(&edge_git(&root, 2, &["clone", "--quiet", "--depth", "1", &edge.url("/git"), clone.to_str().unwrap()]), "a clone after the sync");
    assert_eq!(git(&clone, &["rev-parse", "HEAD"]), new);
}

/// A clone's fetch whose capabilities came from Artifacts, which offers
/// `sideband-all`, answered by the edge: a clone is several requests, and
/// the repos service asks the edge or Artifacts each one on its own, so
/// right after a ref change the capabilities come from Artifacts (the edge
/// is behind) and the fetch from the edge (it has caught up). Upload-pack
/// died on the line it was not allowed (`unexpected line:
/// 'sideband-all'`) after `git http-backend` had sent its headers: a `200`
/// with nothing in it (#260).
#[test]
fn a_fetch_with_the_stores_capabilities_is_answered() {
    let root = scratch("sideband");
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "--quiet", "--initial-branch=main"]);
    commit(&work, "a.txt", "one\n");
    let origin = root.join("origin.git");
    git(&root, &["clone", "--bare", "--quiet", work.to_str().unwrap(), origin.to_str().unwrap()]);
    let edge = Edge::start(&root.join("edge"));
    edge.sync(&file_url(&origin), 1);
    assert_eq!(edge.settled(), json!(1));
    let want = git(&work, &["rev-parse", "HEAD"]);

    // As git 2.39 sends a blobless clone's fetch after Artifacts' `fetch=shallow filter sideband-all`.
    let pkt = |line: &str| format!("{:04x}{line}", line.len() + 4);
    let body = [
        pkt("command=fetch\n"),
        pkt("agent=git/2.39.5\n"),
        pkt("object-format=sha1\n"),
        "0001".to_owned(),
        pkt("thin-pack\n"),
        pkt("sideband-all\n"),
        pkt("filter blob:none\n"),
        pkt("ofs-delta\n"),
        pkt(&format!("want {want}\n")),
        pkt("done\n"),
        "0000".to_owned(),
    ]
    .concat();
    let response = ureq::post(&edge.url("/git/git-upload-pack"))
        .set("x-g1t-edge-version", "1")
        .set("git-protocol", "version=2")
        .set("content-type", "application/x-git-upload-pack-request")
        .send_string(&body)
        .unwrap();
    assert_eq!(response.status(), 200);
    let mut answer = Vec::new();
    std::io::Read::read_to_end(&mut response.into_reader(), &mut answer).unwrap();
    // The packfile section, on band 1 as sideband-all has it.
    assert!(answer.starts_with(b"000e\x01packfile\n"), "the answer starts {:?}\n{}", String::from_utf8_lossy(&answer[..answer.len().min(64)]), edge.log());
    assert!(!edge.log().contains("unexpected line"), "{}", edge.log());

    // And the real client, which now has `sideband-all` from the edge itself.
    let trace = root.join("trace.txt");
    let clone = root.join("clone.git");
    let header = "http.extraHeader=x-g1t-edge-version: 1";
    let url = edge.url("/git");
    let cloned = try_git(
        &root,
        &["-c", header, "-c", "protocol.version=2", "clone", "--bare", "--quiet", "--filter=blob:none", &url, clone.to_str().unwrap()],
        &[("GIT_TRACE_PACKET", trace.to_str().unwrap())],
    );
    assert_ok(&cloned, "a blobless clone");
    assert!(std::fs::read_to_string(&trace).unwrap().contains("> sideband-all"), "the clone did not send sideband-all");
    assert_eq!(git(&clone, &["rev-parse", "HEAD"]), want);
    drop(edge);
    let _ = std::fs::remove_dir_all(&root);
}
