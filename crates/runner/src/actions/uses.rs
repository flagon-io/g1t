//! `uses:` steps: `actions/checkout` done natively against g1t, actions
//! fetched from another repository on g1t (or else GitHub, at the commit
//! g1t resolved its ref to, from the archive g1t keeps of it when it has
//! one) and run as they are (JavaScript, composite and Docker),
//! `docker://` images, and a few of GitHub's own whose services g1t does
//! not have yet. Every action a job's steps name is downloaded before the
//! first step runs, as GitHub's runner does.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use g1t_actions::expr;
use g1t_actions::workflow::yaml_to_json;
use serde_json::{Map, Value, json};

use super::containers::{self, DockerRun};
use super::files::StepFiles;
use super::process::{self, Commands, Ended};
use super::{Frame, Job, Post, PostRun};

const ACTIONS_DIR: &str = "/home/runner/_actions";
/// How often a wait on g1t for an action says it is still waiting, as
/// transfers say how far they have got.
const WAITING_EVERY: Duration = Duration::from_secs(5);

/// Where an action comes from.
enum Source {
    Local(PathBuf),
    /// Another repository: on g1t when g1t has it and this one may use
    /// it, otherwise on GitHub.
    GitHub { owner: String, repo: String, path: String, git_ref: String },
}

fn safe(part: &str) -> bool {
    !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/')) && !part.contains("..")
}

fn is_sha(text: &str) -> bool {
    text.len() == 40 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// Whether the runner does `name` (lowercased, without its ref) itself
/// rather than fetching it.
fn native(name: &str, docker_hosted: bool) -> bool {
    matches!(
        name,
        "actions/checkout"
            | "actions/upload-artifact"
            | "actions/upload-artifact/merge"
            | "actions/download-artifact"
    ) || (docker_hosted && name == "docker/setup-buildx-action")
}

/// The repository and ref of an action `uses` fetches from another
/// repository: (owner, repo, ref). None for one that is local, a Docker
/// image, done natively, or not a name at all.
fn remote_action(uses: &str, docker_hosted: bool) -> Option<(String, String, String)> {
    let uses = uses.trim();
    if uses.starts_with("./") || uses.starts_with("docker://") {
        return None;
    }
    let (name, git_ref) = uses.split_once('@')?;
    if git_ref.is_empty() || native(&name.to_ascii_lowercase(), docker_hosted) {
        return None;
    }
    let mut parts = name.splitn(3, '/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    (!owner.is_empty() && !repo.is_empty()).then(|| (owner.to_owned(), repo.to_owned(), git_ref.to_owned()))
}

/// Every branch, as a checkout with all history fetches them.
const HEADS_REFSPEC: &str = "+refs/heads/*:refs/remotes/origin/*";
/// Every tag, likewise.
const TAGS_REFSPEC: &str = "+refs/tags/*:refs/tags/*";

/// What a checkout fetches and where it ends, as `actions/checkout`
/// decides it (its `getRefSpec`, `getRefSpecForAllHistory` and
/// `getCheckoutInfo`).
#[derive(Debug, PartialEq, Eq)]
struct CheckoutPlan {
    refspecs: Vec<String>,
    /// The commit to end on, when it is known before the fetch.
    sha: Option<String>,
    /// The branch made there (or at its remote-tracking branch).
    branch: Option<String>,
    /// Where to end with neither: a tag, or another ref.
    start: Option<String>,
    /// A name that may be a branch or a tag; the fetch tells which.
    unqualified: Option<String>,
    /// The step's `ref` output.
    output_ref: String,
}

/// `wanted` is the step's `ref` (or another repository's default branch);
/// without one, the run's own ref and commit for its own repository.
fn checkout_plan(wanted: Option<&str>, same: bool, run_ref: &str, run_sha: &str) -> CheckoutPlan {
    let (git_ref, commit) = match wanted {
        Some(r) if is_sha(r) => (String::new(), r.to_owned()),
        Some(r) => (r.to_owned(), String::new()),
        // Some events name a branch without `refs/heads/`.
        None if same && !run_sha.is_empty() && !run_ref.is_empty() && !run_ref.starts_with("refs/") => (format!("refs/heads/{run_ref}"), run_sha.to_owned()),
        None if same => (run_ref.to_owned(), run_sha.to_owned()),
        None => (String::new(), String::new()),
    };
    let upper = git_ref.to_ascii_uppercase();
    let rest = |prefix: &str| git_ref[prefix.len()..].to_owned();
    let mut plan = CheckoutPlan { refspecs: Vec::new(), sha: None, branch: None, start: None, unqualified: None, output_ref: git_ref.clone() };
    if !commit.is_empty() {
        plan.refspecs.push(if upper.starts_with("REFS/HEADS/") {
            plan.branch = Some(rest("refs/heads/"));
            format!("+{commit}:refs/remotes/origin/{}", rest("refs/heads/"))
        } else if upper.starts_with("REFS/PULL/") {
            format!("+{commit}:refs/remotes/pull/{}", rest("refs/pull/"))
        } else if upper.starts_with("REFS/TAGS/") {
            format!("+{commit}:{git_ref}")
        } else {
            commit.clone()
        });
        plan.sha = Some(commit);
    } else if git_ref.is_empty() {
        plan.refspecs.push("HEAD".into());
    } else if !upper.starts_with("REFS/") {
        plan.refspecs.push(format!("+refs/heads/{git_ref}*:refs/remotes/origin/{git_ref}*"));
        plan.refspecs.push(format!("+refs/tags/{git_ref}*:refs/tags/{git_ref}*"));
        plan.unqualified = Some(git_ref.clone());
    } else if upper.starts_with("REFS/HEADS/") {
        plan.branch = Some(rest("refs/heads/"));
        plan.refspecs.push(format!("+{git_ref}:refs/remotes/origin/{}", rest("refs/heads/")));
    } else if upper.starts_with("REFS/PULL/") {
        let local = format!("refs/remotes/pull/{}", rest("refs/pull/"));
        plan.refspecs.push(format!("+{git_ref}:{local}"));
        plan.start = Some(local);
    } else {
        plan.refspecs.push(format!("+{git_ref}:{git_ref}"));
        plan.start = Some(git_ref.clone());
    }
    plan
}

impl Job {
    /// Runs a git command, logging it; the credential header is never logged.
    fn git(&mut self, dir: &Path, args: &[&str], auth: Option<&str>) -> bool {
        let shown: Vec<&str> = args.to_vec();
        self.log.line(&format!("[command]git {}", shown.join(" ")));
        let mut command = Command::new("git");
        command.current_dir(dir);
        if let Some(header) = auth {
            command.args(["-c", &format!("http.extraheader={header}")]);
        }
        command.args(args).env("GIT_TERMINAL_PROMPT", "0");
        let mut commands = Commands::default();
        matches!(process::run(command, Duration::from_secs(600).min(self.remaining_time()), &mut self.log, &mut commands), Ok(Ended::Exited(0)))
    }

    /// A fetch, tried again after a short wait when it fails: a transfer
    /// cut short on the way ("transfer closed with N bytes remaining") is
    /// over by the next try. Three tries in all, as actions/checkout does.
    fn fetch_retrying(&mut self, dir: &Path, args: &[&str], auth: Option<&str>) -> bool {
        for (attempt, wait) in [0u64, 2, 5].into_iter().enumerate() {
            if attempt > 0 {
                self.log.line(&format!("The fetch failed; trying again in {wait} s ({} of 3).", attempt + 1));
                std::thread::sleep(Duration::from_secs(wait));
            }
            if self.git(dir, args, auth) {
                return true;
            }
        }
        false
    }

    /// A git command with `header` sent only to `server` (`http.<server>/.extraheader`),
    /// so a submodule on another host never sees the job's token. Logged
    /// without the header.
    fn git_scoped(&mut self, dir: &Path, args: &[&str], server: &str, header: Option<&str>) -> bool {
        self.log.line(&format!("[command]git {}", args.join(" ")));
        let mut command = Command::new("git");
        command.current_dir(dir);
        if let Some(header) = header {
            command.args(["-c", &format!("http.{server}/.extraheader={header}")]);
        }
        command.args(args).env("GIT_TERMINAL_PROMPT", "0");
        let mut commands = Commands::default();
        matches!(process::run(command, Duration::from_secs(600).min(self.remaining_time()), &mut self.log, &mut commands), Ok(Ended::Exited(0)))
    }

    /// `actions/checkout`, against g1t: the inputs of its version 4 and 5
    /// but `ssh-key`, `lfs` and `clean: false`, fetching what it fetches
    /// and ending on the same branch or commit.
    fn checkout(&mut self, with: &BTreeMap<String, String>) -> (bool, BTreeMap<String, String>) {
        let checkout = self.spec["checkout"].clone();
        let own = checkout["repository"].as_str().unwrap_or_default().to_owned();
        let server = self.contexts["github"]["server_url"].as_str().unwrap_or("https://g1t.sh").trim_end_matches('/').to_owned();
        let input = |name: &str| with.get(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let yes = |name: &str, default: bool| input(name).map_or(default, |v| v.eq_ignore_ascii_case("true"));
        let repository = input("repository").unwrap_or(own.clone());
        let same = repository.eq_ignore_ascii_case(&own);
        let token = input("token").or_else(|| checkout["token"].as_str().map(str::to_owned)).unwrap_or_default();
        let url = if same { checkout["url"].as_str().unwrap_or_default().to_owned() } else { format!("{server}/{repository}.git") };
        let path = input("path").map_or(self.workspace.clone(), |p| self.workspace.join(p));
        // As the action reads it: not a number, or below zero, is all history.
        let depth: u32 = input("fetch-depth").map_or(1, |d| d.parse::<f64>().ok().filter(|d| *d >= 0.0).map_or(0, |d| d as u32));
        let wanted_ref = input("ref");
        let filter = input("filter");
        let sparse: Vec<String> = with.get("sparse-checkout").map(|s| s.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect()).unwrap_or_default();
        let auth = (!token.is_empty()).then(|| format!("AUTHORIZATION: basic {}", STANDARD.encode(format!("x-access-token:{token}"))));
        let header = auth.as_deref();

        self.log.line(&format!("Syncing repository: {repository}"));
        if path.exists() {
            let _ = std::fs::remove_dir_all(&path);
        }
        if let Err(error) = std::fs::create_dir_all(&path) {
            self.log.line(&format!("##[error]Could not make {}: {error}", path.display()));
            return (false, BTreeMap::new());
        }
        // So git works on it in a container run as another user.
        if yes("set-safe-directory", true) {
            let _ = Command::new("git").args(["config", "--global", "--add", "safe.directory", "*"]).status();
        }
        if !self.git(&path, &["init", "--quiet"], None) || !self.git(&path, &["remote", "add", "origin", &url], None) {
            return (false, BTreeMap::new());
        }
        let _ = Command::new("git").current_dir(&path).args(["config", "--local", "gc.auto", "0"]).status();

        // Another repository with no ref: its default branch, as the
        // action asks the API for it.
        let default_branch = match (&wanted_ref, same) {
            (None, false) => self.default_branch(&path, &server, header),
            _ => None,
        };
        let plan = checkout_plan(
            wanted_ref.as_deref().or(default_branch.as_deref()),
            same,
            checkout["ref"].as_str().unwrap_or_default(),
            checkout["sha"].as_str().unwrap_or_default(),
        );
        let depth_arg = format!("--depth={depth}");
        let filter_arg = filter.clone().or_else(|| (!sparse.is_empty()).then(|| "blob:none".to_owned())).map(|f| format!("--filter={f}"));
        let fetch_args = |refspecs: &[String], tags: bool| {
            let mut args: Vec<String> = ["-c", "protocol.version=2", "fetch", "--prune", "--no-recurse-submodules", "--quiet"].map(String::from).into();
            if !tags {
                args.push("--no-tags".into());
            }
            args.extend(filter_arg.clone());
            if depth > 0 {
                args.push(depth_arg.clone());
            }
            args.push("origin".into());
            args.extend(refspecs.iter().cloned());
            args
        };
        // All history: every branch and tag, then what the run names, which
        // may be a commit its branch has since moved on from.
        let everything = fetch_args(&[HEADS_REFSPEC.into(), TAGS_REFSPEC.into()], true);
        let everything: Vec<&str> = everything.iter().map(String::as_str).collect();
        let named = fetch_args(&plan.refspecs, yes("fetch-tags", false));
        let named: Vec<&str> = named.iter().map(String::as_str).collect();
        let fetched = (depth > 0 || self.fetch_retrying(&path, &everything, header)) && self.fetch_retrying(&path, &named, header);
        let has = |target: &str| Command::new("git").current_dir(&path).args(["cat-file", "-e", &format!("{target}^{{commit}}")]).status().is_ok_and(|s| s.success());
        // The commit may be further back than a shallow fetch reaches (the
        // branch moved on after the run began), or not one the server
        // gives by itself: then the whole history.
        if let Some(sha) = plan.sha.as_deref().filter(|sha| !has(sha)) {
            let shallow = path.join(".git").join("shallow").exists();
            let mut deepen = vec!["-c", "protocol.version=2", "fetch", "--no-tags", "--quiet"];
            if shallow {
                deepen.push("--unshallow");
            }
            deepen.extend(["origin", HEADS_REFSPEC]);
            if !self.fetch_retrying(&path, &deepen, header) || !has(sha) {
                self.log.line(&format!("##[error]Could not fetch {sha} from {repository}."));
                return (false, BTreeMap::new());
            }
        } else if !fetched {
            self.log.line(&format!("##[error]Could not fetch {} from {repository}.", plan.refspecs.join(" ")));
            return (false, BTreeMap::new());
        }

        // Where to end up: a branch made at its start point, or detached.
        let ref_exists = |name: &str| Command::new("git").current_dir(&path).args(["rev-parse", "--verify", "--quiet", name]).output().is_ok_and(|o| o.status.success());
        let (branch, target) = match (&plan.sha, &plan.branch, &plan.unqualified) {
            (Some(sha), branch, _) => (branch.clone(), sha.clone()),
            (None, Some(branch), _) => (Some(branch.clone()), format!("refs/remotes/origin/{branch}")),
            (None, None, Some(name)) if ref_exists(&format!("refs/remotes/origin/{name}")) => (Some(name.clone()), format!("refs/remotes/origin/{name}")),
            (None, None, Some(name)) if ref_exists(&format!("refs/tags/{name}")) => (None, format!("refs/tags/{name}")),
            (None, None, Some(name)) => {
                self.log.line(&format!("##[error]A branch or tag with the name '{name}' could not be found"));
                return (false, BTreeMap::new());
            }
            (None, None, None) => (None, plan.start.clone().unwrap_or_else(|| "FETCH_HEAD".into())),
        };
        if !sparse.is_empty() {
            let mut args = vec!["sparse-checkout", "set"];
            args.push(if yes("sparse-checkout-cone-mode", true) { "--cone" } else { "--no-cone" });
            args.extend(sparse.iter().map(String::as_str));
            if !self.git(&path, &args, None) {
                return (false, BTreeMap::new());
            }
        }
        let checked_out = match &branch {
            Some(branch) => self.git(&path, &["checkout", "--quiet", "--force", "-B", branch, &target], None),
            None => self.git(&path, &["checkout", "--quiet", "--force", "--detach", &target], None),
        };
        if !checked_out {
            return (false, BTreeMap::new());
        }
        let persist = yes("persist-credentials", true);
        let key = format!("http.{server}/.extraheader");
        if persist && let Some(header) = header {
            let _ = Command::new("git").current_dir(&path).args(["config", "--local", &key, header]).status();
        }
        if let Some(submodules) = input("submodules").map(|s| s.to_ascii_lowercase()).filter(|s| s == "true" || s == "recursive") {
            let recursive = submodules == "recursive";
            // A submodule on g1t named by its SSH address is fetched over
            // HTTPS with the token, as the action does.
            let host = server.split_once("://").map_or(server.as_str(), |(_, host)| host).to_owned();
            let instead = format!("url.{server}/.insteadOf=git@{host}:");
            let mut sync = vec!["submodule", "sync", "--quiet"];
            let mut update = vec!["-c", &instead, "-c", "protocol.version=2", "submodule", "update", "--init", "--force", "--quiet"];
            if depth > 0 {
                update.push(&depth_arg);
            }
            if recursive {
                sync.push("--recursive");
                update.push("--recursive");
            }
            if !self.git(&path, &sync, None) || !self.git_scoped(&path, &update, &server, header) {
                self.log.line("##[error]The submodules could not all be checked out.");
                return (false, BTreeMap::new());
            }
            if persist && let Some(header) = header {
                let mut foreach = vec!["submodule", "foreach", "--quiet"];
                if recursive {
                    foreach.push("--recursive");
                }
                foreach.push(r#"git config --local "$G1T_KEY" "$G1T_HEADER" && git config --local gc.auto 0"#);
                let _ = Command::new("git").current_dir(&path).args(&foreach).env("G1T_KEY", &key).env("G1T_HEADER", header).status();
            }
        }
        if yes("lfs", false) {
            self.log.line("##[warning]Git LFS files are not fetched on g1t: g1t does not keep LFS objects yet.");
        }
        let commit = Command::new("git").current_dir(&path).args(["rev-parse", "HEAD"]).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned()).unwrap_or_default();
        self.log.line(&format!("Checked out {commit}"));
        let mut outputs = BTreeMap::new();
        outputs.insert("ref".into(), plan.output_ref);
        outputs.insert("commit".into(), commit);
        (true, outputs)
    }

    /// Another repository's default branch, from what its remote says
    /// `HEAD` is. None when it says nothing: the fetch then takes `HEAD`.
    fn default_branch(&mut self, dir: &Path, server: &str, header: Option<&str>) -> Option<String> {
        let mut command = Command::new("git");
        command.current_dir(dir);
        if let Some(header) = header {
            command.args(["-c", &format!("http.{server}/.extraheader={header}")]);
        }
        let output = command.args(["ls-remote", "--quiet", "--symref", "origin", "HEAD"]).env("GIT_TERMINAL_PROMPT", "0").output().ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let branch = text.lines().find_map(|line| line.strip_prefix("ref: ")?.split_once('\t')?.0.strip_prefix("refs/heads/").map(str::to_owned))?;
        self.log.line(&format!("Default branch '{branch}'"));
        Some(format!("refs/heads/{branch}"))
    }

    /// Fetches another repository's action, once per job: from g1t when
    /// g1t has the repository and this one may use it, otherwise from
    /// GitHub. A private repository on g1t that may not be used here fails
    /// the step, saying why, rather than fetching something else by its
    /// name.
    fn fetch_remote_action(&mut self, owner: &str, repo: &str, git_ref: &str) -> Option<PathBuf> {
        let on_g1t = super::paths::under_home(ACTIONS_DIR).join("_g1t").join(owner).join(repo).join(git_ref);
        let on_github = super::paths::under_home(ACTIONS_DIR).join(owner).join(repo).join(git_ref);
        for dir in [&on_g1t, &on_github] {
            if dir.join(".g1t-fetched").exists() {
                return Some(dir.clone());
            }
        }
        if !(safe(owner) && safe(repo) && safe(git_ref)) {
            self.log.line(&format!("##[error]`{owner}/{repo}@{git_ref}` is not a name g1t can fetch."));
            return None;
        }
        // The first job to use an action at a commit waits while g1t
        // fetches its archive from GitHub, up to two minutes: the log says
        // what it is waiting for, and that it still is, as GitHub's does.
        self.log.line(&format!("Getting action download info for '{owner}/{repo}@{git_ref}'"));
        let repository = format!("{owner}/{repo}");
        let asked = (repository.clone(), git_ref.to_owned());
        let found = self.log.waiting(
            WAITING_EVERY,
            move |api| api.action(&asked.0, &asked.1),
            |seconds| format!("Waiting for g1t to fetch '{repository}@{git_ref}' ({seconds}s)"),
        );
        match found {
            Ok(found) if found["source"] == "g1t" => self.fetch_g1t_action(&on_g1t, owner, repo, git_ref, &found),
            Ok(found) => {
                if let Some(note) = found["note"].as_str() {
                    self.log.line(&format!("##[warning]{note}"));
                }
                let sha = found["sha"].as_str().filter(|sha| is_sha(sha)).map(str::to_owned);
                if let Some(sha) = &sha
                    && found["archive"] == true
                    && let Some(dir) = self.fetch_archived_action(owner, repo, git_ref, sha)
                {
                    return Some(dir);
                }
                self.fetch_action(owner, repo, git_ref, sha.as_deref())
            }
            Err((true, why)) => {
                self.log.line(&format!("##[error]{why}"));
                None
            }
            Err((false, why)) => {
                self.log.line(&format!("##[warning]g1t could not say where {owner}/{repo} is ({why}); fetching it from GitHub."));
                self.fetch_action(owner, repo, git_ref, None)
            }
        }
    }

    /// Fetches an action from a repository on g1t, at its ref, with the
    /// read-only token g1t gave for it when it is private.
    fn fetch_g1t_action(&mut self, dir: &Path, owner: &str, repo: &str, git_ref: &str, found: &Value) -> Option<PathBuf> {
        let url = found["url"].as_str().unwrap_or_default().to_owned();
        let token = found["token"].as_str().filter(|token| !token.is_empty()).map(str::to_owned);
        if let Some(token) = &token {
            self.log.add_mask(token);
        }
        let auth = token.map(|token| format!("AUTHORIZATION: basic {}", STANDARD.encode(format!("x-access-token:{token}"))));
        self.log.line(&format!("Download action repository '{owner}/{repo}@{git_ref}' from g1t"));
        let _ = std::fs::remove_dir_all(dir);
        if std::fs::create_dir_all(dir).is_err() || !self.git(dir, &["init", "--quiet"], None) || !self.git(dir, &["remote", "add", "origin", &url], None) {
            return None;
        }
        // A branch or tag at its tip; a commit may need the history.
        let shallow = self.fetch_retrying(dir, &["fetch", "--depth=1", "--no-tags", "--quiet", "origin", git_ref], auth.as_deref());
        let checked_out = if shallow {
            self.git(dir, &["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], None)
        } else {
            self.fetch_retrying(dir, &["fetch", "--quiet", "--tags", "origin", "+refs/heads/*:refs/remotes/origin/*"], auth.as_deref())
                && self.git(dir, &["checkout", "--quiet", "--force", "--detach", git_ref], None)
        };
        if !checked_out {
            self.log.line(&format!("##[error]Could not fetch {owner}/{repo}@{git_ref} from g1t: is {git_ref} a branch, tag or commit there?"));
            let _ = std::fs::remove_dir_all(dir);
            return None;
        }
        let _ = std::fs::write(dir.join(".g1t-fetched"), "");
        Some(dir.to_path_buf())
    }

    /// Downloads a GitHub action's archive that g1t keeps, at the commit
    /// g1t resolved its ref to. None when it could not, and the job fetches
    /// it from GitHub instead.
    fn fetch_archived_action(&mut self, owner: &str, repo: &str, git_ref: &str, sha: &str) -> Option<PathBuf> {
        let dir = super::paths::under_home(ACTIONS_DIR).join(owner).join(repo).join(git_ref);
        self.log.line(&format!("Download action repository '{owner}/{repo}@{git_ref}' (SHA:{sha}) from g1t"));
        let archive = self.temp.join(format!("action{}.tar.gz", super::rand_id()));
        let asked = (format!("{owner}/{repo}"), sha.to_owned(), archive.clone());
        let downloaded = self.log.waiting(
            WAITING_EVERY,
            move |api| api.action_archive(&asked.0, &asked.1, &asked.2),
            |seconds| format!("Downloading '{owner}/{repo}@{git_ref}' from g1t ({seconds}s)"),
        );
        let unpacked = match downloaded {
            Ok(_) => {
                let _ = std::fs::remove_dir_all(&dir);
                let _ = std::fs::create_dir_all(&dir);
                let mut command = Command::new("tar");
                command.arg("-xzf").arg(&archive).arg("-C").arg(&dir).arg("--strip-components=1");
                if cfg!(windows) {
                    // GNU tar on Windows reads `C:...` as a host and a file.
                    command.arg("--force-local");
                }
                let mut commands = Commands::default();
                matches!(process::run(command, Duration::from_secs(300).min(self.remaining_time()), &mut self.log, &mut commands), Ok(Ended::Exited(0)))
            }
            Err(why) => {
                self.log.line(&format!("g1t could not send it ({why}); fetching it from GitHub."));
                false
            }
        };
        let _ = std::fs::remove_file(&archive);
        if !unpacked {
            let _ = std::fs::remove_dir_all(&dir);
            return None;
        }
        let _ = std::fs::write(dir.join(".g1t-fetched"), "");
        Some(dir)
    }

    /// Fetches an action from GitHub, once per job: at `sha` when g1t
    /// resolved its ref to one, so it is the commit g1t named.
    fn fetch_action(&mut self, owner: &str, repo: &str, git_ref: &str, sha: Option<&str>) -> Option<PathBuf> {
        let dir = super::paths::under_home(ACTIONS_DIR).join(owner).join(repo).join(git_ref);
        if dir.join(".g1t-fetched").exists() {
            return Some(dir);
        }
        if !(safe(owner) && safe(repo) && safe(git_ref)) {
            self.log.line(&format!("##[error]`{owner}/{repo}@{git_ref}` is not a name g1t can fetch."));
            return None;
        }
        match sha {
            Some(sha) => self.log.line(&format!("Download action repository '{owner}/{repo}@{git_ref}' (SHA:{sha})")),
            None => self.log.line(&format!("Download action repository '{owner}/{repo}@{git_ref}'")),
        }
        let _ = std::fs::create_dir_all(&dir);
        let url = format!("https://codeload.github.com/{owner}/{repo}/tar.gz/{}", sha.unwrap_or(git_ref));
        let script = format!("set -o pipefail; curl -fsSL --retry 3 '{url}' | tar{} -xz -C '{}' --strip-components=1", super::blobs::tar_local(), dir.display());
        let mut command = Command::new("bash");
        command.args(["-c", &script]);
        let mut commands = Commands::default();
        match process::run(command, Duration::from_secs(300).min(self.remaining_time()), &mut self.log, &mut commands) {
            Ok(Ended::Exited(0)) => {
                let _ = std::fs::write(dir.join(".g1t-fetched"), "");
                Some(dir)
            }
            _ => {
                self.log.line(&format!("##[error]Could not download {owner}/{repo}@{git_ref} from GitHub."));
                let _ = std::fs::remove_dir_all(&dir);
                None
            }
        }
    }

    /// Downloads every action the job's steps fetch from other
    /// repositories, before the first step runs, as GitHub's runner does in
    /// "Set up job". False when one could not be: the job fails before
    /// anything runs. Actions a composite action uses are fetched as it
    /// runs.
    pub(crate) fn prepare_actions(&mut self, steps: &[Map<String, Value>]) -> bool {
        let mut wanted: Vec<(String, String, String)> = Vec::new();
        for step in steps {
            if let Some(found) = step.get("uses").and_then(Value::as_str).and_then(|uses| remote_action(uses, self.docker_hosted))
                && !wanted.contains(&found)
            {
                wanted.push(found);
            }
        }
        if wanted.is_empty() {
            return true;
        }
        self.log.line("Prepare all required actions");
        self.log.line("Getting action download info");
        let mut ready = true;
        for (owner, repo, git_ref) in &wanted {
            if self.fetch_remote_action(owner, repo, git_ref).is_none() {
                ready = false;
            }
        }
        if !ready {
            self.log.line("##[error]Not every action this job uses could be downloaded, so no step was run.");
        }
        ready
    }

    /// Runs a JavaScript file of an action with Node: the one its
    /// `runs.using` names where the machine has it (`node_program`).
    pub(crate) fn run_node(&mut self, action_dir: &Path, script: &str, env: &BTreeMap<String, String>, using: &str) -> bool {
        let id = format!("node{}", super::rand_id());
        let Ok(files) = StepFiles::new(&self.temp, &id) else { return false };
        let full = self.process_env(env, &files);
        let script_path = action_dir.join(script);
        // In a job container whose image runs the runner's Node, the action
        // runs there, as on GitHub.
        let in_container = self.container.as_ref().filter(|c| c.node).map(|c| c.path.clone()).and_then(|image_path| {
            let inside = self.container_env(env, full.clone(), &image_path);
            self.in_container(containers::CONTAINER_NODE, &[script_path.display().to_string()], &self.workspace, inside)
        });
        let command = match in_container {
            Some(command) => command,
            None => {
                let node = node_program(using, |name| std::env::var(name).ok(), |path| path.is_file());
                let mut command = Command::new(node);
                command.arg(&script_path).current_dir(&self.workspace).env_clear().envs(full);
                command
            }
        };
        let mut commands = Commands {
            debug: self.debug,
            ..Commands::default()
        };
        let ended = process::run(command, Duration::from_secs(6 * 3600).min(self.deadline_left()), &mut self.log, &mut commands);
        let ok = matches!(ended, Ok(Ended::Exited(0)));
        match ended {
            Ok(Ended::Exited(code)) if code != 0 => self.log.line(&format!("##[error]The action exited with code {code}.")),
            Ok(Ended::TimedOut) => self.log.line("##[error]The action ran past its time limit and was stopped."),
            _ => {}
        }
        let (outputs, state) = self.absorb(&files, &commands);
        self.last_node_outputs = outputs;
        self.last_node_state = state;
        ok
    }

    fn log_header(&mut self, uses: &str, with: &BTreeMap<String, String>, env: &BTreeMap<String, String>) {
        for line in super::uses_header(uses, with, env) {
            self.log.line(&line);
        }
    }

    fn deadline_left(&self) -> Duration {
        self.remaining_time()
    }

    /// Runs a `uses:` step. Returns whether it succeeded, and its outputs.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn uses(
        &mut self,
        uses: &str,
        with: &BTreeMap<String, String>,
        env: &BTreeMap<String, String>,
        frame: &Frame,
        title: &str,
        action_name: &str,
        _timeout: Duration,
    ) -> (bool, BTreeMap<String, String>) {
        let uses = uses.trim();
        let (name, git_ref) = uses.split_once('@').unwrap_or((uses, ""));
        let lower = name.to_ascii_lowercase();
        // The step opens as GitHub's do: `Run` and the action, its inputs
        // and variables, folded. An action fetched from a repository lists
        // its inputs as they are read, its defaults among them.
        let fetched = !uses.starts_with("docker://") && !native(&lower, self.docker_hosted);
        if !fetched {
            self.log_header(uses, with, env);
        }
        if let Some(image) = uses.strip_prefix("docker://") {
            // `with.args` and `with.entrypoint` are the container's; every
            // input is also an `INPUT_` variable, as on GitHub.
            let mut step_env = env.clone();
            step_env.insert("GITHUB_ACTION".into(), action_name.to_owned());
            for (input, value) in with {
                step_env.insert(format!("INPUT_{}", input.replace(' ', "_").to_ascii_uppercase()), value.clone());
            }
            let run = DockerRun {
                image: image.to_owned(),
                entrypoint: with.get("entrypoint").filter(|e| !e.is_empty()).cloned(),
                args: with.get("args").map(|a| containers::split_words(a)).unwrap_or_default(),
                env: step_env,
            };
            let (ok, outputs, _) = self.run_docker(&run);
            return (ok, outputs);
        }
        if lower == "docker/setup-buildx-action" && native(&lower, self.docker_hosted) {
            return self.setup_buildx(with);
        }
        match lower.as_str() {
            "actions/checkout" => return self.checkout(with),
            "actions/upload-artifact" => return self.upload_artifact(with),
            "actions/upload-artifact/merge" => return self.merge_artifacts(with),
            "actions/download-artifact" => return self.download_artifact(with),
            _ => {}
        }
        let Some(found) = self.resolve_action(uses) else {
            self.log_header(uses, with, env);
            return (false, BTreeMap::new());
        };
        let Action { dir, local, manifest: action, .. } = &found;

        // Inputs: what the step gives, else the action's defaults.
        let env_context = env.clone();
        let contexts = self.contexts_for(frame, &env_context);
        let inputs = self.action_inputs(action, with, &contexts, true);
        self.log_header(uses, &inputs, env);

        let runs = action.get("runs").cloned().unwrap_or(Value::Null);
        let using = runs.get("using").map(expr::to_text).unwrap_or_default().to_ascii_lowercase();
        let mut step_env = action_env(env, action_name, &found, git_ref);

        if using.starts_with("node") {
            for (input, value) in &inputs {
                step_env.insert(format!("INPUT_{}", input.replace(' ', "_").to_ascii_uppercase()), value.clone());
            }
            let condition_of = |key: &str| runs.get(key).map(expr::to_text).unwrap_or_else(|| "always()".into());
            // State an action saves, `STATE_<name>` for its later stages.
            let mut state = BTreeMap::new();
            if let Some(pre) = runs.get("pre").map(expr::to_text) {
                if frame.action_path.is_some() {
                    // An action inside a composite action: its `pre` right
                    // before its `main`.
                    let run_pre = self.with_scope(&contexts, |scope| expr::condition(&condition_of("pre-if"), scope)).unwrap_or(true);
                    if run_pre {
                        if !self.run_node(dir, &pre, &step_env, &using) {
                            return (false, BTreeMap::new());
                        }
                        state = std::mem::take(&mut self.last_node_state);
                    }
                } else if *local {
                    self.log.line(&format!("##[warning]`pre` execution is not supported for local action from '{uses}'"));
                } else {
                    // Run before the job's first step (`pre_steps`).
                    state = self.pre_state.remove(action_name).unwrap_or_default();
                }
            }
            let Some(main) = runs.get("main").map(expr::to_text) else {
                self.log.line(&format!("##[error]`{uses}` has no `runs.main`."));
                return (false, BTreeMap::new());
            };
            let mut main_env = step_env.clone();
            for (name, value) in &state {
                main_env.insert(format!("STATE_{name}"), value.clone());
            }
            let ok = self.run_node(dir, &main, &main_env, &using);
            let outputs = std::mem::take(&mut self.last_node_outputs);
            state.extend(std::mem::take(&mut self.last_node_state));
            if let Some(post) = runs.get("post").map(expr::to_text) {
                let mut post_env = step_env.clone();
                for (name, value) in state {
                    post_env.insert(format!("STATE_{name}"), value);
                }
                self.posts.push(Post {
                    name: format!("Post {title}"),
                    condition: condition_of("post-if"),
                    env: post_env,
                    run: PostRun::Node { action_dir: dir.clone(), script: post, using: using.clone() },
                });
            }
            return (ok, outputs);
        }
        if using == "composite" {
            let mut inner = Frame {
                steps: Map::new(),
                inputs: Some(Value::Object(inputs.iter().map(|(k, v)| (k.clone(), json!(v))).collect())),
                action_path: Some(dir.display().to_string()),
                env: env.clone(),
            };
            let mut steps: Vec<Map<String, Value>> = runs.get("steps").and_then(Value::as_array).map(|s| s.iter().filter_map(|s| s.as_object().cloned()).collect()).unwrap_or_default();
            super::name_steps(&mut steps);
            let was_failed = self.failed;
            // A composite's steps see their own success, not the job's.
            self.failed = false;
            let mut ok = true;
            for step in &steps {
                if !self.step(&mut inner, step, 0, false, &Map::new()) {
                    ok = false;
                }
            }
            let contexts = self.contexts_for(&inner, &inner.env.clone());
            let mut outputs = BTreeMap::new();
            if let Some(Value::Object(declared)) = action.get("outputs") {
                for (name, spec) in declared {
                    if let Some(value) = spec.get("value") {
                        let value = self.with_scope(&contexts, |scope| expr::interpolate_value(value, scope)).unwrap_or(Value::Null);
                        outputs.insert(name.clone(), expr::to_text(&value));
                    }
                }
            }
            self.failed = was_failed;
            return (ok, outputs);
        }
        if using == "docker" {
            return self.docker_action(uses, dir, &runs, &inputs, &step_env, frame, title);
        }
        self.log.line(&format!("##[error]`{uses}` runs with `{using}`, which g1t does not know."));
        (false, BTreeMap::new())
    }

    /// A Docker action: its image built from its Dockerfile (or pulled,
    /// for `docker://`), then run with its `args`, `entrypoint` and `env`,
    /// its inputs as `INPUT_` variables, and `pre-entrypoint` and
    /// `post-entrypoint` around it.
    #[allow(clippy::too_many_arguments)]
    fn docker_action(
        &mut self,
        uses: &str,
        dir: &Path,
        runs: &Value,
        inputs: &BTreeMap<String, String>,
        step_env: &BTreeMap<String, String>,
        frame: &Frame,
        title: &str,
    ) -> (bool, BTreeMap<String, String>) {
        let image = runs.get("image").map(expr::to_text).unwrap_or_default();
        let image = if let Some(pulled) = image.strip_prefix("docker://") {
            pulled.to_owned()
        } else if image.is_empty() {
            self.log.line(&format!("##[error]`{uses}` has no `runs.image`."));
            return (false, BTreeMap::new());
        } else {
            match self.build_action_image(dir, &image, uses) {
                Some(tag) => tag,
                None => return (false, BTreeMap::new()),
            }
        };
        // `args` and `env` read with the action's own inputs.
        let mut env = step_env.clone();
        for (input, value) in inputs {
            env.insert(format!("INPUT_{}", input.replace(' ', "_").to_ascii_uppercase()), value.clone());
        }
        let mut scope_frame = frame.clone();
        scope_frame.inputs = Some(Value::Object(inputs.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
        let contexts = self.contexts_for(&scope_frame, &env);
        if let Some(Value::Object(own)) = runs.get("env") {
            for (name, value) in own {
                let value = self.with_scope(&contexts, |scope| expr::interpolate_value(value, scope)).unwrap_or(Value::Null);
                env.insert(name.clone(), expr::to_text(&value));
            }
        }
        let args: Vec<String> = match runs.get("args") {
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| {
                    let value = self.with_scope(&contexts, |scope| expr::interpolate_value(item, scope)).unwrap_or(Value::Null);
                    expr::to_text(&value)
                })
                .collect(),
            _ => Vec::new(),
        };
        let entry = |key: &str| runs.get(key).map(expr::to_text).filter(|e| !e.is_empty());
        if let Some(pre) = entry("pre-entrypoint") {
            let run = DockerRun { image: image.clone(), entrypoint: Some(pre), args: Vec::new(), env: env.clone() };
            if !self.run_docker(&run).0 {
                return (false, BTreeMap::new());
            }
        }
        let run = DockerRun { image: image.clone(), entrypoint: entry("entrypoint"), args, env: env.clone() };
        let (ok, outputs, state) = self.run_docker(&run);
        if let Some(post) = entry("post-entrypoint") {
            let mut post_env = env;
            for (name, value) in state {
                post_env.insert(format!("STATE_{name}"), value);
            }
            self.posts.push(Post {
                name: format!("Post {title}"),
                condition: runs.get("post-if").map(expr::to_text).unwrap_or_else(|| "always()".into()),
                env: BTreeMap::new(),
                run: PostRun::Docker(DockerRun { image, entrypoint: Some(post), args: Vec::new(), env: post_env }),
            });
        }
        (ok, outputs)
    }
}

/// An action, read from its action.yml.
pub(crate) struct Action {
    pub(crate) dir: PathBuf,
    /// `owner/repo`, or empty for one in the repository.
    pub(crate) repository: String,
    pub(crate) local: bool,
    pub(crate) manifest: Value,
}

/// An action's `pre`, run before the job's first step.
pub(crate) struct PreStep {
    /// Its step's `GITHUB_ACTION`, by which the step finds the state it saved.
    pub(crate) key: String,
    /// `pre-if`, `always()` when it has none.
    pub(crate) condition: String,
    pub(crate) action_dir: PathBuf,
    pub(crate) script: String,
    pub(crate) using: String,
    /// The `env` context its condition reads.
    pub(crate) context_env: BTreeMap<String, String>,
    /// What its process is given: the step's variables and inputs.
    pub(crate) env: BTreeMap<String, String>,
}

impl Job {
    /// Finds `uses` (fetching it when it is another repository's) and reads
    /// its action.yml. A problem is told in the log.
    fn resolve_action(&mut self, uses: &str) -> Option<Action> {
        let (name, git_ref) = uses.split_once('@').unwrap_or((uses, ""));
        let source = if let Some(local) = name.strip_prefix("./") {
            // A repository moved from GitHub renamed `.github` to `.g1t`, but
            // its workflows still say `./.github/actions/…`.
            let mut dir = self.workspace.join(local);
            if let Some(rest) = local.strip_prefix(".github/")
                && !dir.exists()
            {
                dir = self.workspace.join(".g1t").join(rest);
            }
            Source::Local(dir)
        } else {
            let mut parts = name.splitn(3, '/');
            let (Some(owner), Some(repo)) = (parts.next(), parts.next()) else {
                self.log.line(&format!("##[error]`{uses}` is not an action: use owner/repo@ref, owner/repo/path@ref, or ./path."));
                return None;
            };
            if git_ref.is_empty() {
                self.log.line(&format!("##[error]`{uses}` needs a version, such as @v4."));
                return None;
            }
            Source::GitHub {
                owner: owner.to_owned(),
                repo: repo.to_owned(),
                path: parts.next().unwrap_or_default().to_owned(),
                git_ref: git_ref.to_owned(),
            }
        };
        let (dir, repository) = match &source {
            Source::Local(dir) => (dir.clone(), String::new()),
            Source::GitHub { owner, repo, path, git_ref } => {
                let root = self.fetch_remote_action(owner, repo, git_ref)?;
                (if path.is_empty() { root } else { root.join(path) }, format!("{owner}/{repo}"))
            }
        };
        let Some(manifest) = ["action.yml", "action.yaml"].iter().map(|f| dir.join(f)).find(|p| p.exists()) else {
            self.log.line(&format!("##[error]`{uses}` has no action.yml."));
            return None;
        };
        let Some(yaml) = std::fs::read_to_string(&manifest).ok().and_then(|text| serde_yaml::from_str::<serde_yaml::Value>(&text).ok()) else {
            self.log.line(&format!("##[error]`{uses}`: its action.yml does not read."));
            return None;
        };
        Some(Action { dir, repository, local: matches!(source, Source::Local(_)), manifest: yaml_to_json(&yaml) })
    }

    /// An action's inputs: what the step gives, else the action's defaults,
    /// read with `contexts`. With `warn`, inputs the action does not declare
    /// are warned of, as GitHub's runner does.
    fn action_inputs(&mut self, action: &Value, with: &BTreeMap<String, String>, contexts: &Map<String, Value>, warn: bool) -> BTreeMap<String, String> {
        let mut inputs: BTreeMap<String, String> = BTreeMap::new();
        let mut declared_names = Vec::new();
        if let Some(Value::Object(declared)) = action.get("inputs") {
            for (input, spec) in declared {
                declared_names.push(input.clone());
                let given = with.iter().find(|(k, _)| k.eq_ignore_ascii_case(input)).map(|(_, v)| v.clone());
                let value = match given {
                    Some(value) => value,
                    None => match spec.get("default") {
                        Some(default) => {
                            let default = self.with_scope(contexts, |scope| expr::interpolate_value(default, scope)).unwrap_or(Value::Null);
                            expr::to_text(&default)
                        }
                        None => String::new(),
                    },
                };
                inputs.insert(input.clone(), value);
            }
        }
        for (key, value) in with {
            if !inputs.keys().any(|k| k.eq_ignore_ascii_case(key)) {
                inputs.insert(key.clone(), value.clone());
            }
        }
        let docker = action["runs"]["using"].as_str().is_some_and(|u| u.eq_ignore_ascii_case("docker"));
        if warn && let Some(warning) = unexpected_inputs(&declared_names, &with.keys().cloned().collect::<Vec<_>>(), docker) {
            self.log.line(&format!("##[warning]{warning}"));
        }
        inputs
    }

    /// The `pre`s of the job's steps, in step order, each with its step's
    /// index: those of JavaScript actions from other repositories, fetched
    /// now, as GitHub's runner fetches every action while it sets up the
    /// job. An action in the repository is not there yet, so its `pre` is
    /// not run, as on GitHub.
    pub(crate) fn pre_steps(&mut self, steps: &[Map<String, Value>]) -> Vec<(usize, PreStep)> {
        let frame = Frame::default();
        let mut pres = Vec::new();
        for (index, step) in steps.iter().enumerate() {
            let Some(uses) = step.get("uses").map(|u| expr::to_text(u).trim().to_owned()) else { continue };
            // Only another repository's action, which `prepare_actions` has
            // already downloaded.
            if remote_action(&uses, self.docker_hosted).is_none() {
                continue;
            }
            let Some(found) = self.resolve_action(&uses) else { continue };
            let runs = found.manifest.get("runs").cloned().unwrap_or(Value::Null);
            let using = runs.get("using").map(expr::to_text).unwrap_or_default().to_ascii_lowercase();
            let Some(script) = runs.get("pre").map(expr::to_text).filter(|_| using.starts_with("node")) else { continue };
            let env_before = self.env_context(&frame);
            let contexts = self.contexts_for(&frame, &env_before);
            let with = self.step_with(step, &contexts);
            let context_env = self.step_env(step, &contexts, env_before);
            let contexts = self.contexts_for(&frame, &context_env);
            let inputs = self.action_inputs(&found.manifest, &with, &contexts, false);
            let key = step.get(super::ACTION_NAME).map(expr::to_text).unwrap_or_default();
            let git_ref = uses.split_once('@').map_or("", |(_, r)| r);
            let mut env = action_env(&context_env, &key, &found, git_ref);
            for (input, value) in &inputs {
                env.insert(format!("INPUT_{}", input.replace(' ', "_").to_ascii_uppercase()), value.clone());
            }
            let condition = runs.get("pre-if").map(expr::to_text).unwrap_or_else(|| "always()".into());
            pres.push((index, PreStep { key, condition, action_dir: found.dir, script, using, context_env, env }));
        }
        pres
    }

    /// Whether a `pre`'s `pre-if` holds, read against the job's status.
    pub(crate) fn pre_runs(&self, pre: &PreStep) -> bool {
        let contexts = self.contexts_for(&Frame::default(), &pre.context_env);
        self.with_scope(&contexts, |scope| expr::condition(&pre.condition, scope)).unwrap_or(true)
    }

    /// Runs a `pre`, keeping the state it saves for its step's main and post.
    pub(crate) fn run_pre(&mut self, pre: &PreStep) -> bool {
        let ok = self.run_node(&pre.action_dir, &pre.script, &pre.env, &pre.using);
        let state = std::mem::take(&mut self.last_node_state);
        self.last_node_outputs.clear();
        self.pre_state.insert(pre.key.clone(), state);
        ok
    }
}

/// The variables a step running an action gets over its own: which
/// action it is and where.
fn action_env(env: &BTreeMap<String, String>, action_name: &str, action: &Action, git_ref: &str) -> BTreeMap<String, String> {
    let mut step_env = env.clone();
    step_env.insert("GITHUB_ACTION".into(), action_name.to_owned());
    step_env.insert("GITHUB_ACTION_REPOSITORY".into(), action.repository.clone());
    step_env.insert("GITHUB_ACTION_REF".into(), git_ref.to_owned());
    step_env.insert("GITHUB_ACTION_PATH".into(), action.dir.display().to_string());
    step_env
}

/// GitHub's warning for inputs a step gives that its action does not
/// declare (a Docker action also takes `entryPoint` and `args`), if any.
fn unexpected_inputs(declared: &[String], given: &[String], docker: bool) -> Option<String> {
    let mut valid: Vec<String> = declared.to_vec();
    if docker {
        valid.extend(["entryPoint".to_owned(), "args".to_owned()]);
    }
    let unexpected: Vec<&str> = given.iter().filter(|g| !valid.iter().any(|v| v.eq_ignore_ascii_case(g))).map(String::as_str).collect();
    if unexpected.is_empty() {
        return None;
    }
    Some(format!("Unexpected input(s) '{}', valid inputs are ['{}']", unexpected.join("', '"), valid.join("', '")))
}

/// The Node an action's `runs.using` asks for: for `node20` (or any
/// `nodeNN`), the binary `G1T_NODE20` names or `/opt/node20/bin/node`,
/// when there is one; otherwise, and for anything else, the `node` on
/// `PATH`, the runner's own (Node 24). Nothing is logged either way.
pub(crate) fn node_program(using: &str, var: impl Fn(&str) -> Option<String>, exists: impl Fn(&Path) -> bool) -> String {
    let using = using.trim().to_ascii_lowercase();
    let versioned = using.strip_prefix("node").is_some_and(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()));
    if versioned {
        let named = var(&format!("G1T_{}", using.to_ascii_uppercase())).filter(|p| !p.is_empty() && exists(Path::new(p)));
        if let Some(path) = named {
            return path;
        }
        let standard = format!("/opt/{using}/bin/node");
        if exists(Path::new(&standard)) {
            return standard;
        }
    }
    "node".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_actions_fetched_before_the_first_step_are_other_repositories() {
        let found = |uses: &str| remote_action(uses, true);
        assert_eq!(found("actions/setup-node@v4"), Some(("actions".into(), "setup-node".into(), "v4".into())));
        assert_eq!(found(" github/codeql-action/init@v3 "), Some(("github".into(), "codeql-action".into(), "v3".into())));
        // Done by the runner itself, local, an image, or no version.
        assert_eq!(found("actions/checkout@v4"), None);
        // actions/cache is the real action, fetched like any other.
        assert_eq!(found("Actions/Cache/Restore@v4"), Some(("Actions".into(), "Cache".into(), "v4".into())));
        assert_eq!(found("docker/setup-buildx-action@v3"), None);
        assert!(remote_action("docker/setup-buildx-action@v3", false).is_some());
        assert_eq!(found("./.g1t/actions/setup"), None);
        assert_eq!(found("docker://alpine:3"), None);
        assert_eq!(found("actions/setup-node"), None);
        assert_eq!(found("setup-node@v4"), None);
    }

    #[test]
    fn a_checkout_fetches_what_actions_checkout_fetches() {
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let specs = |plan: &CheckoutPlan| plan.refspecs.clone();
        // A push: the run's commit, as its branch.
        let push = checkout_plan(None, true, "refs/heads/main", sha);
        assert_eq!(specs(&push), [format!("+{sha}:refs/remotes/origin/main")]);
        assert_eq!((push.sha.as_deref(), push.branch.as_deref(), push.output_ref.as_str()), (Some(sha), Some("main"), "refs/heads/main"));
        // An unqualified branch from the event is qualified first.
        assert_eq!(checkout_plan(None, true, "main", sha).output_ref, "refs/heads/main");
        // A pull request: its commit under refs/remotes/pull, detached.
        let pull = checkout_plan(None, true, "refs/pull/7/merge", sha);
        assert_eq!(specs(&pull), [format!("+{sha}:refs/remotes/pull/7/merge")]);
        assert_eq!(pull.branch, None);
        // A tag push, and a deployment of a bare commit.
        assert_eq!(specs(&checkout_plan(None, true, "refs/tags/v1", sha)), [format!("+{sha}:refs/tags/v1")]);
        assert_eq!(specs(&checkout_plan(None, true, "", sha)), [sha]);
        // `ref:` a commit, a branch, a tag or a name that may be either.
        let by_sha = checkout_plan(Some(sha), true, "refs/heads/main", "ffff");
        assert_eq!((specs(&by_sha), by_sha.sha.as_deref(), by_sha.output_ref.as_str()), (vec![sha.to_owned()], Some(sha), ""));
        let branch = checkout_plan(Some("refs/heads/dev"), true, "refs/heads/main", sha);
        assert_eq!((specs(&branch), branch.sha, branch.branch.as_deref()), (vec!["+refs/heads/dev:refs/remotes/origin/dev".to_owned()], None, Some("dev")));
        let tag = checkout_plan(Some("refs/tags/v2"), true, "", "");
        assert_eq!((specs(&tag), tag.start.as_deref()), (vec!["+refs/tags/v2:refs/tags/v2".to_owned()], Some("refs/tags/v2")));
        let name = checkout_plan(Some("v2"), false, "", "");
        assert_eq!(specs(&name), ["+refs/heads/v2*:refs/remotes/origin/v2*", "+refs/tags/v2*:refs/tags/v2*"]);
        assert_eq!(name.unqualified.as_deref(), Some("v2"));
        // Another repository whose default branch is not known: its HEAD.
        assert_eq!(specs(&checkout_plan(None, false, "refs/heads/main", sha)), ["HEAD"]);
    }

    /// Checks out repositories of its own over `file://`, where git is
    /// installed: the run's commit behind its branch's tip, all history,
    /// a tag and a branch by name, a sparse checkout, and another
    /// repository's default branch.
    #[test]
    fn a_checkout_ends_where_actions_checkout_ends() {
        let git = |dir: &Path, args: &[&str]| {
            let out = Command::new("git").current_dir(dir).args(args).output().expect("git");
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_owned()
        };
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let root = std::env::temp_dir().join(format!("g1t-checkout-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let make = |name: &str, branch: &str| {
            let dir = root.join("src").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            git(&dir, &["init", "--quiet", "-b", branch]);
            for (key, value) in [("user.name", "t"), ("user.email", "t@example.com"), ("commit.gpgsign", "false"), ("tag.gpgsign", "false")] {
                git(&dir, &["config", key, value]);
            }
            dir
        };
        let commit = |dir: &Path, file: &str, message: &str| {
            std::fs::create_dir_all(dir.join(file).parent().unwrap()).unwrap();
            std::fs::write(dir.join(file), message).unwrap();
            git(dir, &["add", "."]);
            git(dir, &["commit", "--quiet", "-m", message]);
        };
        let app = make("app", "main");
        commit(&app, "docs/a.md", "one");
        commit(&app, "src/main.rs", "two");
        git(&app, &["tag", "v1"]);
        git(&app, &["checkout", "--quiet", "-b", "feature"]);
        commit(&app, "feature.txt", "feature");
        git(&app, &["checkout", "--quiet", "main"]);
        commit(&app, "README.md", "three");
        let other = make("other", "trunk");
        commit(&other, "o.txt", "o");
        let served = root.join("srv").join("acme");
        std::fs::create_dir_all(&served).unwrap();
        for name in ["app", "other"] {
            let src = root.join("src").join(name);
            git(&served, &["clone", "--quiet", "--bare", &src.display().to_string(), &format!("{name}.git")]);
            git(&served.join(format!("{name}.git")), &["config", "uploadpack.allowFilter", "true"]);
        }
        let server = format!("file://{}", root.join("srv").display());
        let behind = git(&app, &["rev-parse", "main~1"]);
        let spec = json!({
            "checkout": { "repository": "acme/app", "url": format!("{server}/acme/app.git"), "ref": "refs/heads/main", "sha": behind, "token": "" },
            "github": { "server_url": server },
            "variables": {},
            "contexts": {},
        });
        let workspace = root.join("work");
        let mut job = super::super::setup_in(spec, super::super::report::Api::offline(), workspace.clone(), root.join("temp")).unwrap();
        let mut run = |inputs: &[(&str, &str)]| {
            let mut with: BTreeMap<String, String> = inputs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            with.insert("set-safe-directory".into(), "false".into());
            job.checkout(&with)
        };

        // A push whose branch moved on: the run's commit, on its branch.
        let (ok, outputs) = run(&[]);
        assert!(ok);
        assert_eq!((git(&workspace, &["rev-parse", "HEAD"]), git(&workspace, &["branch", "--show-current"])), (behind.clone(), "main".to_owned()));
        assert_eq!((outputs["ref"].as_str(), outputs["commit"].as_str()), ("refs/heads/main", behind.as_str()));
        // All history: every branch and tag.
        assert!(run(&[("fetch-depth", "0")]).0);
        assert!(!workspace.join(".git/shallow").exists());
        assert_eq!(git(&workspace, &["branch", "-r"]).split_whitespace().collect::<Vec<_>>(), ["origin/feature", "origin/main"]);
        assert_eq!(git(&workspace, &["tag"]), "v1");
        // A tag by name, detached; a branch by name, as the branch.
        assert!(run(&[("ref", "v1")]).0);
        assert_eq!((git(&workspace, &["describe", "--tags"]), git(&workspace, &["branch", "--show-current"])), ("v1".to_owned(), String::new()));
        assert!(run(&[("ref", "feature")]).0);
        assert_eq!(git(&workspace, &["branch", "--show-current"]), "feature");
        // Sparse: only the folders named, from a blobless fetch.
        assert!(run(&[("sparse-checkout", "docs\n")]).0);
        assert!(workspace.join("docs/a.md").exists() && !workspace.join("src").exists());
        assert_eq!(git(&workspace, &["config", "remote.origin.partialclonefilter"]), "blob:none");
        // Another repository without a ref: its default branch.
        let (ok, outputs) = run(&[("repository", "acme/other"), ("path", "other")]);
        assert!(ok);
        assert_eq!(git(&workspace.join("other"), &["branch", "--show-current"]), "trunk");
        assert_eq!(outputs["ref"], "refs/heads/trunk");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unexpected_inputs_are_named_with_the_valid_ones() {
        let declared = vec!["token".to_owned(), "path".to_owned()];
        assert_eq!(unexpected_inputs(&declared, &["Token".into()], false), None);
        assert_eq!(
            unexpected_inputs(&declared, &["token".into(), "foo".into(), "bar".into()], false).as_deref(),
            Some("Unexpected input(s) 'foo', 'bar', valid inputs are ['token', 'path']")
        );
        assert_eq!(unexpected_inputs(&[], &["x".into()], false).as_deref(), Some("Unexpected input(s) 'x', valid inputs are ['']"));
        // A Docker action takes `entrypoint` and `args` too.
        assert_eq!(unexpected_inputs(&declared, &["entrypoint".into(), "args".into()], true), None);
        assert!(unexpected_inputs(&declared, &["args".into()], false).is_some());
    }

    #[test]
    fn node20_runs_with_a_node20_where_there_is_one() {
        let none = |_: &str| None;
        assert_eq!(node_program("node20", none, |_| false), "node");
        assert_eq!(node_program("node20", none, |p| p == Path::new("/opt/node20/bin/node")), "/opt/node20/bin/node");
        let named = |name: &str| (name == "G1T_NODE20").then(|| "/usr/local/n20/bin/node".to_owned());
        assert_eq!(node_program("Node20", named, |_| true), "/usr/local/n20/bin/node");
        // A named Node that is not there is passed over.
        assert_eq!(node_program("node20", named, |p| p == Path::new("/opt/node20/bin/node")), "/opt/node20/bin/node");
        assert_eq!(node_program("node24", none, |_| false), "node");
        assert_eq!(node_program("composite", none, |_| true), "node");
        assert_eq!(node_program("node", none, |_| true), "node");
    }
}
