//! `actions/checkout`, done by the runner itself on g1t's machines, as the
//! artifact actions are: the same inputs and outputs as versions 4 and 5
//! of the action, fetching what it fetches and ending where it ends, but
//! from the repository's git edge over g1t's internal path (`G1T_GIT_INTERNAL`,
//! services/runner internal-git.ts) rather than from g1t.sh over the
//! internet, and without downloading the action and starting Node for it.
//!
//! The repository is left as the action leaves it: `origin` is
//! `<server>/<owner>/<repo>`, and with `persist-credentials` the job's
//! token is `http.<server>/.extraheader` in its `.git/config`, so a later
//! step's `git fetch` and `git push` are signed in, until the post step
//! removes it. The internal path is only ever given to the checkout's own
//! git commands (`url.<internal>/.insteadOf`), never written down; when it
//! fails, the checkout fetches from the server as the action would.
//!
//! What it does not do runs the action itself (`fallback`): another
//! version, `ssh-key`, `lfs`, another `github-server-url`, a `path` outside
//! the workspace or one that is already a repository, a
//! `pull_request_target` or `workflow_run` run (whose fork checkouts the
//! action guards), a job container, a self-hosted runner, or a machine
//! without git.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use super::process::{self, Commands, Ended};
use super::{Job, Post, PostRun};

/// The action, lowercased, as `uses` names it.
pub(crate) const ACTION: &str = "actions/checkout";

/// The inputs of versions 4 and 5, for GitHub's warning about others.
pub(crate) const INPUTS: [&str; 21] = [
    "repository",
    "ref",
    "token",
    "ssh-key",
    "ssh-known-hosts",
    "ssh-strict",
    "ssh-user",
    "persist-credentials",
    "path",
    "clean",
    "filter",
    "sparse-checkout",
    "sparse-checkout-cone-mode",
    "fetch-depth",
    "fetch-tags",
    "show-progress",
    "lfs",
    "submodules",
    "set-safe-directory",
    "github-server-url",
    // Version 5's guard on a fork's pull request in a trusted run, which
    // the action itself decides (`checkout_guarded_event`).
    "allow-unsafe-pr-checkout",
];

/// Inputs whose value decides whether the action itself runs: one given
/// as an expression is only known when the step runs.
const DECIDING: [&str; 3] = ["ssh-key", "lfs", "github-server-url"];

/// Every branch, as a checkout with all history fetches them.
const BRANCHES_REFSPEC: &str = "+refs/heads/*:refs/remotes/origin/*";
/// Every tag, likewise.
const TAGS_REFSPEC: &str = "+refs/tags/*:refs/tags/*";

/// The waits before each try of a fetch from the server, as the action
/// tries three times.
const RETRY_WAITS: [u64; 3] = [0, 2, 5];

/// A step's input, by name without regard to case, trimmed; None when empty.
fn input<'a>(with: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    with.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.trim()).filter(|value| !value.is_empty())
}

/// A boolean input as the action reads it: `true` in any case is true;
/// anything else given is false; nothing given is `default`.
fn flag(with: &BTreeMap<String, String>, name: &str, default: bool) -> bool {
    input(with, name).map_or(default, |value| value.eq_ignore_ascii_case("true"))
}

fn is_sha(text: &str) -> bool {
    text.len() == 40 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// The major version a ref names (`v5`, `v4.2.2`), if it names one.
fn major(version: &str) -> Option<u32> {
    let digits: String = version.trim().strip_prefix(['v', 'V'])?.chars().take_while(char::is_ascii_digit).collect();
    let rest = &version.trim()[1 + digits.len()..];
    (!digits.is_empty() && (rest.is_empty() || rest.starts_with('.'))).then(|| digits.parse().ok()).flatten()
}

/// Why a step's `with` needs the action itself, at `version`, on a server
/// at `server`; None when the runner checks out in its place.
pub(crate) fn unsupported(version: &str, with: &BTreeMap<String, String>, server: &str) -> Option<String> {
    if !matches!(major(version), Some(4 | 5)) {
        return Some(format!("version {version} is not one the runner checks out itself (4 and 5)"));
    }
    if input(with, "ssh-key").is_some() {
        return Some("it fetches with an SSH key".into());
    }
    if flag(with, "lfs", false) {
        return Some("it fetches Git LFS files".into());
    }
    if let Some(other) = input(with, "github-server-url")
        && !other.trim_end_matches('/').eq_ignore_ascii_case(server.trim_end_matches('/'))
    {
        return Some(format!("it fetches from {other}"));
    }
    None
}

/// Whether a step's `with`, as written, may need the action itself once
/// its expressions are read: then it is downloaded with the job's other
/// actions, before the first step.
pub(crate) fn may_need_action(version: &str, raw: &BTreeMap<String, String>, server: &str) -> bool {
    unsupported(version, raw, server).is_some() || raw.iter().any(|(key, value)| value.contains("${{") && DECIDING.iter().any(|d| key.eq_ignore_ascii_case(d)))
}

/// The ref and commit a checkout is after, as the action reads its inputs:
/// a commit given as `ref` is the commit alone; no `ref` is the run's own
/// ref and commit for the workflow's repository (a branch an event names
/// without `refs/heads/` is qualified), and nothing for another, whose
/// default branch is then asked for.
pub(crate) fn wanted(input_ref: Option<&str>, same: bool, run_ref: &str, run_sha: &str) -> (String, String) {
    match input_ref {
        Some(given) if is_sha(given) => (String::new(), given.to_owned()),
        Some(given) => (given.to_owned(), String::new()),
        None if same => {
            let qualified = if !run_sha.is_empty() && !run_ref.is_empty() && !run_ref.starts_with("refs/") { format!("refs/heads/{run_ref}") } else { run_ref.to_owned() };
            (qualified, run_sha.to_owned())
        }
        None => (String::new(), String::new()),
    }
}

fn after<'a>(text: &'a str, prefix: &str) -> &'a str {
    &text[prefix.len()..]
}

/// What a fetch of `git_ref` at `commit` asks for (the action's `getRefSpec`).
pub(crate) fn ref_spec(git_ref: &str, commit: &str) -> Vec<String> {
    let upper = git_ref.to_ascii_uppercase();
    if !commit.is_empty() {
        return vec![if upper.starts_with("REFS/HEADS/") {
            format!("+{commit}:refs/remotes/origin/{}", after(git_ref, "refs/heads/"))
        } else if upper.starts_with("REFS/PULL/") {
            format!("+{commit}:refs/remotes/pull/{}", after(git_ref, "refs/pull/"))
        } else if upper.starts_with("REFS/TAGS/") {
            format!("+{commit}:{git_ref}")
        } else {
            commit.to_owned()
        }];
    }
    if !upper.starts_with("REFS/") {
        vec![format!("+refs/heads/{git_ref}*:refs/remotes/origin/{git_ref}*"), format!("+refs/tags/{git_ref}*:refs/tags/{git_ref}*")]
    } else if upper.starts_with("REFS/HEADS/") {
        vec![format!("+{git_ref}:refs/remotes/origin/{}", after(git_ref, "refs/heads/"))]
    } else if upper.starts_with("REFS/PULL/") {
        vec![format!("+{git_ref}:refs/remotes/pull/{}", after(git_ref, "refs/pull/"))]
    } else {
        vec![format!("+{git_ref}:{git_ref}")]
    }
}

/// What a fetch of all history asks for (`getRefSpecForAllHistory`):
/// every branch and tag, and a pull request's commit beside them.
pub(crate) fn ref_spec_all_history(git_ref: &str, commit: &str) -> Vec<String> {
    let mut specs = vec![BRANCHES_REFSPEC.to_owned(), TAGS_REFSPEC.to_owned()];
    if git_ref.to_ascii_uppercase().starts_with("REFS/PULL/") {
        let target = if commit.is_empty() { git_ref } else { commit };
        specs.push(format!("+{target}:refs/remotes/pull/{}", after(git_ref, "refs/pull/")));
    }
    specs
}

/// The arguments of one fetch, as the action's `git.fetch` makes them.
/// `depth` 0 fetches all of it, unshallowing a shallow repository.
pub(crate) fn fetch_args(refspecs: &[String], fetch_tags: bool, filter: Option<&str>, depth: u32, shallow: bool) -> Vec<String> {
    let mut args: Vec<String> = ["-c", "protocol.version=2", "fetch"].map(String::from).into();
    if !fetch_tags && !refspecs.iter().any(|spec| spec == TAGS_REFSPEC) {
        args.push("--no-tags".into());
    }
    args.extend(["--prune".into(), "--no-recurse-submodules".into()]);
    if let Some(filter) = filter {
        args.push(format!("--filter={filter}"));
    }
    if depth > 0 {
        args.push(format!("--depth={depth}"));
    } else if shallow {
        args.push("--unshallow".into());
    }
    args.push("origin".into());
    args.extend(refspecs.iter().cloned());
    args
}

/// Where a checkout ends (`getCheckoutInfo`): `name`, made a branch at
/// `start` when there is one, else checked out as it is (detached).
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) name: String,
    pub(crate) start: Option<String>,
}

/// `branch` and `tag` say whether `origin/<name>` and the tag `<name>`
/// exist, for a name that may be either.
pub(crate) fn target(git_ref: &str, commit: &str, branch: impl Fn(&str) -> bool, tag: impl Fn(&str) -> bool) -> Result<Target, String> {
    let upper = git_ref.to_ascii_uppercase();
    if git_ref.is_empty() {
        return Ok(Target { name: commit.to_owned(), start: None });
    }
    if upper.starts_with("REFS/HEADS/") {
        let name = after(git_ref, "refs/heads/");
        return Ok(Target { name: name.to_owned(), start: Some(format!("refs/remotes/origin/{name}")) });
    }
    if upper.starts_with("REFS/PULL/") {
        return Ok(Target { name: format!("refs/remotes/pull/{}", after(git_ref, "refs/pull/")), start: None });
    }
    if upper.starts_with("REFS/") {
        return Ok(Target { name: git_ref.to_owned(), start: None });
    }
    if branch(git_ref) {
        return Ok(Target { name: git_ref.to_owned(), start: Some(format!("refs/remotes/origin/{git_ref}")) });
    }
    if tag(git_ref) {
        return Ok(Target { name: format!("refs/tags/{git_ref}"), start: None });
    }
    Err(format!("A branch or tag with the name '{git_ref}' could not be found"))
}

/// How the checkout's own git reaches the server: through the internal
/// path while it works, else the server itself. The token goes only to
/// whichever it is.
struct Transport {
    server: String,
    host: String,
    internal: Option<String>,
    header: Option<String>,
}

impl Transport {
    /// The `-c` settings of a git command: the internal path standing in
    /// for the server (and for its SSH addresses, which the action fetches
    /// over HTTPS), and the token for where the request goes.
    fn config(&self) -> Vec<String> {
        let mut config = Vec::new();
        let base = self.internal.as_deref().unwrap_or(&self.server);
        if let Some(internal) = &self.internal {
            config.push(format!("url.{internal}/.insteadOf={}/", self.server));
        }
        if !self.host.is_empty() {
            config.push(format!("url.{base}/.insteadOf=git@{}:", self.host));
        }
        if let Some(header) = &self.header {
            config.push(format!("http.{base}/.extraheader={header}"));
        }
        config
    }
}

/// The host of a server's URL, without its port: what its SSH addresses name.
fn host_of(server: &str) -> String {
    let Some((_, rest)) = server.split_once("://") else { return String::new() };
    let host = rest.split('/').next().unwrap_or_default();
    host.rsplit_once(':').map_or(host, |(name, _)| name).to_owned()
}

impl Job {
    /// Why a checkout runs the action itself on this machine, whatever its
    /// inputs say; None when the runner can check out here.
    fn checkout_elsewhere(&self) -> Option<&'static str> {
        if self.spec["variables"]["RUNNER_ENVIRONMENT"].as_str() == Some("self-hosted") {
            return Some("a self-hosted runner");
        }
        if self.spec["spec"].get("container").is_some_and(|c| !c.is_null()) {
            return Some("a job container");
        }
        if !Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success()) {
            return Some("a machine without git");
        }
        None
    }

    fn server_url(&self) -> String {
        self.contexts["github"]["server_url"].as_str().filter(|s| !s.is_empty()).unwrap_or("https://g1t.sh").trim_end_matches('/').to_owned()
    }

    /// Whether the run's event is one whose checkouts the action guards
    /// (`allow-unsafe-pr-checkout`: a fork's pull request checked out in
    /// the base repository's trusted context). The action decides those.
    fn checkout_guarded_event(&self) -> bool {
        matches!(self.contexts["github"]["event_name"].as_str(), Some("pull_request_target" | "workflow_run"))
    }

    /// Whether a checkout step, as written, is downloaded before the first
    /// step: when it may need the action itself.
    pub(crate) fn checkout_needs_action(&self, version: &str, raw: &BTreeMap<String, String>) -> bool {
        self.checkout_elsewhere().is_some() || self.checkout_guarded_event() || may_need_action(version, raw, &self.server_url())
    }

    /// Why this step runs the action itself, its inputs read; None when
    /// the runner checks out in its place. The log says why, unless it is
    /// a self-hosted runner's (empty), where the action always runs.
    pub(crate) fn checkout_fallback(&self, version: &str, with: &BTreeMap<String, String>) -> Option<String> {
        match self.checkout_elsewhere() {
            Some("a self-hosted runner") => return Some(String::new()),
            Some(why) => return Some(format!("it runs on {why}")),
            None => {}
        }
        if self.checkout_guarded_event() {
            return Some("the action guards checkouts in a pull_request_target or workflow_run run".into());
        }
        if let Some(why) = unsupported(version, with, &self.server_url()) {
            return Some(why);
        }
        let Some(path) = self.checkout_path(with) else {
            return Some("its path is not under the workspace".into());
        };
        if path.join(".git").exists() {
            return Some(format!("{} is already a repository", path.display()));
        }
        None
    }

    /// Where a checkout goes: `path` under the workspace. None when it
    /// is not under it, which the action refuses itself.
    fn checkout_path(&self, with: &BTreeMap<String, String>) -> Option<PathBuf> {
        let given = input(with, "path").unwrap_or(".");
        let relative = Path::new(given);
        if relative.is_absolute() || relative.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::Prefix(_))) {
            return None;
        }
        Some(self.workspace.join(relative))
    }

    /// Runs git with `config` given as `-c` settings, which are never
    /// logged (they carry the token).
    fn checkout_git(&mut self, dir: &Path, config: &[String], args: &[&str]) -> bool {
        self.log.line(&format!("[command]git {}", args.join(" ")));
        let mut command = Command::new("git");
        command.current_dir(dir);
        for setting in config {
            command.args(["-c", setting]);
        }
        command.args(args).env("GIT_TERMINAL_PROMPT", "0");
        let mut commands = Commands::default();
        matches!(process::run(command, Duration::from_secs(600).min(self.remaining_time()), &mut self.log, &mut commands), Ok(Ended::Exited(0)))
    }

    /// A fetch: once over the internal path, then from the server, tried
    /// three times. A failure on the internal path sends the rest of the
    /// checkout to the server too.
    fn checkout_fetch(&mut self, dir: &Path, transport: &mut Transport, args: &[String]) -> bool {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        if transport.internal.is_some() {
            if self.checkout_git(dir, &transport.config(), &args) {
                return true;
            }
            self.log.line(&format!("The fetch over g1t's internal path failed; fetching from {} instead.", transport.server));
            transport.internal = None;
        }
        for (attempt, wait) in RETRY_WAITS.into_iter().enumerate() {
            if attempt > 0 {
                self.log.line(&format!("The fetch failed; trying again in {wait} s ({} of 3).", attempt + 1));
                std::thread::sleep(Duration::from_secs(wait));
            }
            if self.checkout_git(dir, &transport.config(), &args) {
                return true;
            }
        }
        false
    }

    /// Another repository's default branch, from what its remote says
    /// `HEAD` is, as the action asks the API.
    fn checkout_default_branch(&mut self, dir: &Path, transport: &mut Transport) -> Option<String> {
        let ask = |transport: &Transport| {
            let mut command = Command::new("git");
            command.current_dir(dir);
            for setting in transport.config() {
                command.args(["-c", &setting]);
            }
            let output = command.args(["ls-remote", "--quiet", "--symref", "origin", "HEAD"]).env("GIT_TERMINAL_PROMPT", "0").output().ok()?;
            let text = String::from_utf8_lossy(&output.stdout);
            text.lines().find_map(|line| line.strip_prefix("ref: ")?.split_once('\t')?.0.strip_prefix("refs/heads/").map(str::to_owned))
        };
        let mut found = ask(transport);
        if found.is_none() && transport.internal.is_some() {
            transport.internal = None;
            found = ask(transport);
        }
        let branch = found?;
        self.log.line(&format!("Default branch '{branch}'"));
        Some(format!("refs/heads/{branch}"))
    }

    /// `actions/checkout` at version 4 or 5, by the runner (see the
    /// module's notes). `internal` is the internal path's base, when the
    /// machine has one. Its post step removes the credential it leaves.
    pub(crate) fn checkout(&mut self, with: &BTreeMap<String, String>, title: &str, internal: Option<String>) -> (bool, BTreeMap<String, String>) {
        let server = self.server_url();
        let own = self.contexts["github"]["repository"].as_str().or_else(|| self.spec["checkout"]["repository"].as_str()).unwrap_or_default().to_owned();
        let repository = input(with, "repository").unwrap_or(&own).to_owned();
        let parts: Vec<&str> = repository.split('/').collect();
        if parts.len() != 2 || parts.iter().any(|part| part.is_empty()) {
            self.log.line(&format!("##[error]Invalid repository '{repository}'. Expected format {{owner}}/{{repo}}."));
            return (false, BTreeMap::new());
        }
        let same = repository.eq_ignore_ascii_case(&own);
        let token = input(with, "token")
            .map(str::to_owned)
            .or_else(|| self.contexts["github"]["token"].as_str().filter(|t| !t.is_empty()).map(str::to_owned))
            .or_else(|| self.spec["checkout"]["token"].as_str().map(str::to_owned))
            .unwrap_or_default();
        let Some(path) = self.checkout_path(with) else {
            self.log.line(&format!("##[error]Repository path '{}' is not under '{}'", input(with, "path").unwrap_or_default(), self.workspace.display()));
            return (false, BTreeMap::new());
        };
        // As the action reads it: not a number, or below zero, is all history.
        let depth: u32 = input(with, "fetch-depth").map_or(1, |d| d.parse::<f64>().ok().filter(|d| *d >= 0.0).map_or(0, |d| d.floor() as u32));
        let fetch_tags = flag(with, "fetch-tags", false);
        let sparse: Vec<String> = with
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("sparse-checkout"))
            .map(|(_, v)| v.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
            .unwrap_or_default();
        let filter = input(with, "filter").map(str::to_owned).or_else(|| (!sparse.is_empty()).then(|| "blob:none".to_owned()));
        let persist = flag(with, "persist-credentials", true);
        let submodules = input(with, "submodules").map(str::to_ascii_lowercase);
        let (submodules, nested) = match submodules.as_deref() {
            Some("recursive") => (true, true),
            Some("true") => (true, false),
            _ => (false, false),
        };
        let header = (!token.is_empty()).then(|| {
            let credential = STANDARD.encode(format!("x-access-token:{token}"));
            self.log.add_mask(&credential);
            format!("AUTHORIZATION: basic {credential}")
        });
        let mut transport = Transport { server: server.clone(), host: host_of(&server), internal: internal.filter(|_| header.is_some()), header: header.clone() };
        // Removed by the post step, however the checkout goes.
        self.posts.push(Post {
            name: format!("Post {title}"),
            condition: "always()".into(),
            env: BTreeMap::new(),
            run: PostRun::Checkout { path: path.clone(), server: server.clone() },
        });

        self.log.line(&format!("Syncing repository: {repository}"));
        if transport.internal.is_some() {
            self.log.line(&format!("Fetching from {server} over g1t's internal path"));
        }
        if path.exists() {
            self.log.line(&format!("Deleting the contents of '{}'", path.display()));
            if let Ok(entries) = std::fs::read_dir(&path) {
                for entry in entries.flatten() {
                    let entry = entry.path();
                    let _ = if entry.is_dir() && !entry.is_symlink() { std::fs::remove_dir_all(&entry) } else { std::fs::remove_file(&entry) };
                }
            }
        }
        if let Err(error) = std::fs::create_dir_all(&path) {
            self.log.line(&format!("##[error]Could not make {}: {error}", path.display()));
            return (false, BTreeMap::new());
        }
        let url = format!("{server}/{repository}");
        if !self.checkout_git(&path, &[], &["init", "--quiet"]) || !self.checkout_git(&path, &[], &["remote", "add", "origin", &url]) || !self.checkout_git(&path, &[], &["config", "--local", "gc.auto", "0"]) {
            return (false, BTreeMap::new());
        }

        let run_ref = self.contexts["github"]["ref"].as_str().unwrap_or_default().to_owned();
        let run_sha = self.contexts["github"]["sha"].as_str().unwrap_or_default().to_owned();
        let (mut git_ref, commit) = wanted(input(with, "ref"), same, &run_ref, &run_sha);
        if git_ref.is_empty() && commit.is_empty() {
            match self.checkout_default_branch(&path, &mut transport) {
                Some(branch) => git_ref = branch,
                None => {
                    self.log.line(&format!("##[error]Could not find the default branch of {repository}."));
                    return (false, BTreeMap::new());
                }
            }
        }

        let rev = |name: &str| {
            Command::new("git").current_dir(&path).args(["rev-parse", "--verify", "--quiet", name]).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        };
        let shallow = |path: &Path| path.join(".git").join("shallow").exists();
        let fetched = if depth == 0 {
            // All of it; then what the run names again when its branch or
            // tag has moved on since (`testRef`).
            let all = fetch_args(&ref_spec_all_history(&git_ref, &commit), false, filter.as_deref(), 0, shallow(&path));
            self.checkout_fetch(&path, &mut transport, &all) && {
                let upper = git_ref.to_ascii_uppercase();
                let found = if git_ref.is_empty() || upper.starts_with("REFS/PULL/") || !upper.starts_with("REFS/") {
                    true
                } else if upper.starts_with("REFS/HEADS/") {
                    rev(&format!("refs/remotes/origin/{}", after(&git_ref, "refs/heads/"))).is_some_and(|sha| commit.is_empty() || sha == commit)
                } else {
                    rev(&format!("{git_ref}^{{commit}}")).is_some_and(|sha| commit.is_empty() || sha == commit)
                };
                found || {
                    let named = fetch_args(&ref_spec(&git_ref, &commit), false, filter.as_deref(), 0, shallow(&path));
                    self.checkout_fetch(&path, &mut transport, &named)
                }
            }
        } else {
            let named = fetch_args(&ref_spec(&git_ref, &commit), fetch_tags, filter.as_deref(), depth, false);
            self.checkout_fetch(&path, &mut transport, &named)
        };
        if !fetched {
            self.log.line(&format!("##[error]Could not fetch {} from {repository}.", ref_spec(&git_ref, &commit).join(" ")));
            return (false, BTreeMap::new());
        }

        let exists = |name: String| rev(&name).is_some();
        let found = match target(&git_ref, &commit, |name| exists(format!("refs/remotes/origin/{name}")), |name| exists(format!("refs/tags/{name}"))) {
            Ok(found) => found,
            Err(why) => {
                self.log.line(&format!("##[error]{why}"));
                return (false, BTreeMap::new());
            }
        };
        if !sparse.is_empty() {
            let ok = if flag(with, "sparse-checkout-cone-mode", true) {
                let mut args = vec!["sparse-checkout", "set"];
                args.extend(sparse.iter().map(String::as_str));
                self.checkout_git(&path, &[], &args)
            } else {
                self.checkout_git(&path, &[], &["config", "core.sparseCheckout", "true"]) && {
                    let file = path.join(".git").join("info").join("sparse-checkout");
                    let _ = std::fs::create_dir_all(file.parent().unwrap_or(&path));
                    let mut text = std::fs::read_to_string(&file).unwrap_or_default();
                    for line in &sparse {
                        text.push('\n');
                        text.push_str(line);
                    }
                    text.push('\n');
                    std::fs::write(&file, text).is_ok()
                }
            };
            if !ok {
                return (false, BTreeMap::new());
            }
        }
        let checked_out = match &found.start {
            Some(start) => self.checkout_git(&path, &[], &["checkout", "--quiet", "--force", "-B", &found.name, start]),
            None => self.checkout_git(&path, &[], &["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", &found.name]),
        };
        if !checked_out {
            return (false, BTreeMap::new());
        }

        let key = format!("http.{server}/.extraheader");
        if submodules {
            let mut sync = vec!["submodule", "sync"];
            let depth_arg = format!("--depth={depth}");
            let mut update = vec!["-c", "protocol.version=2", "submodule", "update", "--init", "--force"];
            if depth > 0 {
                update.push(&depth_arg);
            }
            let mut foreach = vec!["submodule", "foreach"];
            if nested {
                sync.push("--recursive");
                update.push("--recursive");
                foreach.push("--recursive");
            }
            let mut updated = self.checkout_git(&path, &[], &sync) && self.checkout_git(&path, &transport.config(), &update);
            if !updated && transport.internal.is_some() {
                self.log.line(&format!("The submodules could not be fetched over g1t's internal path; fetching from {server} instead."));
                transport.internal = None;
                updated = self.checkout_git(&path, &transport.config(), &update);
            }
            if !updated {
                self.log.line("##[error]The submodules could not all be checked out.");
                return (false, BTreeMap::new());
            }
            let mut gc = foreach.clone();
            gc.push("git config --local gc.auto 0");
            let _ = self.checkout_git(&path, &[], &gc);
            if persist && let Some(header) = &header {
                // In each submodule as in the repository, the header passed
                // in a variable so it is not in any command line or log.
                let mut sign_in = foreach.clone();
                sign_in.push(r#"git config --local "$G1T_KEY" "$G1T_HEADER" && git config --local "$G1T_INSTEAD_KEY" "$G1T_INSTEAD""#);
                let _ = Command::new("git")
                    .current_dir(&path)
                    .args(&sign_in)
                    .env("G1T_KEY", &key)
                    .env("G1T_HEADER", header)
                    .env("G1T_INSTEAD_KEY", format!("url.{server}/.insteadOf"))
                    .env("G1T_INSTEAD", format!("git@{}:", host_of(&server)))
                    .status();
            }
        }
        if persist && let Some(header) = &header {
            let _ = Command::new("git").current_dir(&path).args(["config", "--local", &key, header]).status();
        }
        let commit_now = rev("HEAD").unwrap_or_default();
        self.log.line(&format!("[command]git log -1 --format=%H\n{commit_now}"));
        let mut outputs = BTreeMap::new();
        outputs.insert("ref".into(), git_ref);
        outputs.insert("commit".into(), commit_now);
        (true, outputs)
    }

    /// The post step: the credential `persist-credentials` left in the
    /// repository and its submodules removed, as the action's post does.
    pub(crate) fn checkout_post(&mut self, path: &Path, server: &str) -> bool {
        if !path.join(".git").exists() {
            return true;
        }
        let key = format!("http.{server}/.extraheader");
        self.log.line("Removing auth");
        let _ = self.checkout_git(path, &[], &["config", "--local", "--unset-all", &key]);
        if path.join(".gitmodules").exists() {
            self.log.line("[command]git submodule foreach --recursive git config --local --unset-all <header> || :");
            let _ = Command::new("git")
                .current_dir(path)
                .args(["submodule", "foreach", "--quiet", "--recursive", r#"git config --local --unset-all "$G1T_KEY" || :"#])
                .env("G1T_KEY", &key)
                .status();
        }
        true
    }
}

/// What a step's `with` is as written, for deciding before the job runs.
pub(crate) fn raw_with(step: &serde_json::Map<String, Value>) -> BTreeMap<String, String> {
    match step.get("with") {
        Some(Value::Object(with)) => with.iter().map(|(k, v)| (k.clone(), g1t_actions::expr::to_text(v))).collect(),
        _ => BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn with(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn versions_four_and_five_are_checked_out_by_the_runner_unless_an_input_needs_the_action() {
        let server = "https://g1t.sh";
        assert_eq!(unsupported("v5", &with(&[]), server), None);
        assert_eq!(unsupported("v4.2.2", &with(&[("fetch-depth", "0"), ("submodules", "recursive")]), server), None);
        assert!(unsupported("v6", &with(&[]), server).is_some());
        assert!(unsupported("v3", &with(&[]), server).is_some());
        assert!(unsupported("main", &with(&[]), server).is_some());
        assert!(unsupported("11bd71901bbe5b1630ceea73d27597364c9af683", &with(&[]), server).is_some());
        assert!(unsupported("v45", &with(&[]), server).is_some());
        assert!(unsupported("v5", &with(&[("ssh-key", "-----BEGIN")]), server).is_some());
        assert!(unsupported("v5", &with(&[("LFS", "True")]), server).is_some());
        assert_eq!(unsupported("v5", &with(&[("lfs", "false"), ("ssh-key", "")]), server), None);
        assert!(unsupported("v5", &with(&[("github-server-url", "https://github.com")]), server).is_some());
        assert_eq!(unsupported("v5", &with(&[("github-server-url", "https://G1T.sh/")]), server), None);
        // An input only known when the step runs: the action is downloaded too.
        assert!(may_need_action("v5", &with(&[("lfs", "${{ inputs.lfs }}")]), server));
        assert!(!may_need_action("v5", &with(&[("ref", "${{ inputs.ref }}")]), server));
    }

    #[test]
    fn the_ref_and_commit_are_read_as_the_action_reads_them() {
        let sha = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(wanted(None, true, "refs/heads/main", sha), ("refs/heads/main".into(), sha.into()));
        // An event that names its branch without `refs/heads/`.
        assert_eq!(wanted(None, true, "main", sha), ("refs/heads/main".into(), sha.into()));
        assert_eq!(wanted(Some(sha), true, "refs/heads/main", "ffff"), (String::new(), sha.into()));
        assert_eq!(wanted(Some("dev"), true, "refs/heads/main", sha), ("dev".into(), String::new()));
        // Another repository without a ref: its default branch, asked for.
        assert_eq!(wanted(None, false, "refs/heads/main", sha), (String::new(), String::new()));
    }

    #[test]
    fn a_checkout_fetches_what_actions_checkout_fetches() {
        let sha = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(ref_spec("refs/heads/main", sha), [format!("+{sha}:refs/remotes/origin/main")]);
        assert_eq!(ref_spec("refs/pull/7/merge", sha), [format!("+{sha}:refs/remotes/pull/7/merge")]);
        assert_eq!(ref_spec("refs/tags/v1", sha), [format!("+{sha}:refs/tags/v1")]);
        assert_eq!(ref_spec("", sha), [sha]);
        assert_eq!(ref_spec("refs/heads/dev", ""), ["+refs/heads/dev:refs/remotes/origin/dev"]);
        assert_eq!(ref_spec("refs/tags/v2", ""), ["+refs/tags/v2:refs/tags/v2"]);
        assert_eq!(ref_spec("v2", ""), ["+refs/heads/v2*:refs/remotes/origin/v2*", "+refs/tags/v2*:refs/tags/v2*"]);
        assert_eq!(ref_spec_all_history("refs/heads/main", sha), [BRANCHES_REFSPEC, TAGS_REFSPEC]);
        assert_eq!(ref_spec_all_history("refs/pull/7/merge", sha), [BRANCHES_REFSPEC.to_owned(), TAGS_REFSPEC.to_owned(), format!("+{sha}:refs/remotes/pull/7/merge")]);

        let specs = ref_spec("refs/heads/main", sha);
        assert_eq!(
            fetch_args(&specs, false, None, 1, false),
            ["-c", "protocol.version=2", "fetch", "--no-tags", "--prune", "--no-recurse-submodules", "--depth=1", "origin", specs[0].as_str()]
        );
        assert_eq!(fetch_args(&specs, true, Some("blob:none"), 0, true)[3..6], ["--prune", "--no-recurse-submodules", "--filter=blob:none"]);
        assert!(fetch_args(&specs, true, None, 0, true).contains(&"--unshallow".to_owned()));
        // Every tag is asked for by name: no `--no-tags`.
        assert!(!fetch_args(&ref_spec_all_history("", sha), false, None, 0, false).contains(&"--no-tags".to_owned()));
    }

    #[test]
    fn a_checkout_ends_on_a_branch_or_detached_as_the_action_does() {
        let none = |_: &str| false;
        let sha = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(target("refs/heads/main", sha, none, none), Ok(Target { name: "main".into(), start: Some("refs/remotes/origin/main".into()) }));
        assert_eq!(target("", sha, none, none), Ok(Target { name: sha.into(), start: None }));
        assert_eq!(target("refs/pull/7/merge", sha, none, none), Ok(Target { name: "refs/remotes/pull/7/merge".into(), start: None }));
        assert_eq!(target("refs/tags/v1", "", none, none), Ok(Target { name: "refs/tags/v1".into(), start: None }));
        assert_eq!(target("dev", "", |b| b == "dev", none), Ok(Target { name: "dev".into(), start: Some("refs/remotes/origin/dev".into()) }));
        assert_eq!(target("v1", "", none, |t| t == "v1"), Ok(Target { name: "refs/tags/v1".into(), start: None }));
        assert_eq!(target("gone", "", none, none), Err("A branch or tag with the name 'gone' could not be found".into()));
    }

    #[test]
    fn the_token_goes_only_where_the_checkout_fetches_from() {
        let mut transport = Transport { server: "https://g1t.sh".into(), host: host_of("https://g1t.sh"), internal: Some("http://git.g1t.internal".into()), header: Some("AUTHORIZATION: basic eA==".into()) };
        assert_eq!(
            transport.config(),
            [
                "url.http://git.g1t.internal/.insteadOf=https://g1t.sh/",
                "url.http://git.g1t.internal/.insteadOf=git@g1t.sh:",
                "http.http://git.g1t.internal/.extraheader=AUTHORIZATION: basic eA==",
            ]
        );
        transport.internal = None;
        assert_eq!(transport.config(), ["url.https://g1t.sh/.insteadOf=git@g1t.sh:", "http.https://g1t.sh/.extraheader=AUTHORIZATION: basic eA=="]);
        assert_eq!(host_of("http://localhost:8787"), "localhost");
        assert_eq!(host_of("file:///srv"), "");
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").current_dir(dir).args(args).output().expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    /// Repositories of its own served over `file://`, as `<srv>/acme/<name>.git`.
    struct Served {
        root: PathBuf,
        app: PathBuf,
    }

    fn served(name: &str) -> Option<Served> {
        if Command::new("git").arg("--version").output().is_err() {
            return None;
        }
        let root = std::env::temp_dir().join(format!("g1t-checkout-{name}-{}", std::process::id()));
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
        let srv = root.join("srv").join("acme");
        std::fs::create_dir_all(&srv).unwrap();
        for name in ["app", "other"] {
            let src = root.join("src").join(name);
            git(&srv, &["clone", "--quiet", "--bare", &src.display().to_string(), &format!("{name}.git")]);
            git(&srv.join(format!("{name}.git")), &["config", "uploadpack.allowFilter", "true"]);
            git(&srv.join(format!("{name}.git")), &["config", "uploadpack.allowAnySHA1InWant", "true"]);
        }
        Some(Served { root, app })
    }

    fn url(path: &Path) -> String {
        format!("file:///{}", path.display().to_string().replace('\\', "/").trim_start_matches('/'))
    }

    fn job(served: &Served, server: &str, sha: &str) -> Job {
        let spec = json!({
            "checkout": { "repository": "acme/app", "url": "", "ref": "refs/heads/main", "sha": sha, "token": "" },
            "github": { "server_url": server, "repository": "acme/app", "ref": "refs/heads/main", "sha": sha, "token": "g1t_job" },
            "variables": {},
            "contexts": {},
        });
        super::super::setup_in(spec, super::super::report::Api::offline(), served.root.join("work"), served.root.join("temp")).unwrap()
    }

    /// Checks out over `file://`, as the action would: the run's commit
    /// behind its branch's tip, all history, a tag and a branch by name, a
    /// sparse checkout, and another repository's default branch; then the
    /// credential it persists, and the post step that removes it.
    #[test]
    fn a_checkout_ends_where_actions_checkout_ends() {
        let Some(served) = served("ends") else { return };
        let server = url(&served.root.join("srv"));
        let behind = git(&served.app, &["rev-parse", "main~1"]);
        let mut job = job(&served, &server, &behind);
        let workspace = served.root.join("work");
        let run = |job: &mut Job, inputs: &[(&str, &str)]| {
            let _ = std::fs::remove_dir_all(workspace.join(".git"));
            job.checkout(&with(inputs), "Run actions/checkout@v5", None)
        };

        // A push whose branch moved on: the run's commit, on its branch.
        let (ok, outputs) = run(&mut job, &[]);
        assert!(ok);
        assert_eq!((git(&workspace, &["rev-parse", "HEAD"]), git(&workspace, &["branch", "--show-current"])), (behind.clone(), "main".to_owned()));
        assert_eq!((outputs["ref"].as_str(), outputs["commit"].as_str()), ("refs/heads/main", behind.as_str()));
        assert_eq!(git(&workspace, &["config", "remote.origin.url"]), format!("{server}/acme/app"));
        assert_eq!(git(&workspace, &["rev-parse", "--is-shallow-repository"]), "true");
        // The token is left for later steps, for the server only, and the
        // post step takes it away.
        let key = format!("http.{server}/.extraheader");
        let header = format!("AUTHORIZATION: basic {}", STANDARD.encode("x-access-token:g1t_job"));
        assert_eq!(git(&workspace, &["config", "--local", &key]), header);
        assert!(matches!(&job.posts.last().unwrap().run, PostRun::Checkout { path, .. } if path == &workspace));
        assert!(job.checkout_post(&workspace, &server));
        assert!(!Command::new("git").current_dir(&workspace).args(["config", "--local", &key]).status().unwrap().success());
        // Not persisted: nothing left.
        assert!(run(&mut job, &[("persist-credentials", "false")]).0);
        assert!(!Command::new("git").current_dir(&workspace).args(["config", "--local", &key]).status().unwrap().success());
        // All history: every branch and tag.
        assert!(run(&mut job, &[("fetch-depth", "0")]).0);
        assert_eq!(git(&workspace, &["rev-parse", "--is-shallow-repository"]), "false");
        assert_eq!(git(&workspace, &["branch", "-r"]).split_whitespace().collect::<Vec<_>>(), ["origin/feature", "origin/main"]);
        assert_eq!(git(&workspace, &["tag"]), "v1");
        assert_eq!(git(&workspace, &["rev-parse", "HEAD"]), behind);
        // A tag by name, detached; a branch by name, as the branch.
        assert!(run(&mut job, &[("ref", "v1")]).0);
        assert_eq!((git(&workspace, &["describe", "--tags"]), git(&workspace, &["branch", "--show-current"])), ("v1".to_owned(), String::new()));
        assert!(run(&mut job, &[("ref", "feature")]).0);
        assert_eq!(git(&workspace, &["branch", "--show-current"]), "feature");
        assert!(!run(&mut job, &[("ref", "gone")]).0);
        // Sparse: only the folders named, from a blobless fetch.
        assert!(run(&mut job, &[("sparse-checkout", "docs\n")]).0);
        assert!(workspace.join("docs/a.md").exists() && !workspace.join("src").exists());
        assert_eq!(git(&workspace, &["config", "remote.origin.partialclonefilter"]), "blob:none");
        // Another repository without a ref, under `path`: its default branch.
        let (ok, outputs) = run(&mut job, &[("repository", "acme/other"), ("path", "other")]);
        assert!(ok);
        assert_eq!(git(&workspace.join("other"), &["branch", "--show-current"]), "trunk");
        assert_eq!(outputs["ref"], "refs/heads/trunk");
        let _ = std::fs::remove_dir_all(&served.root);
    }

    /// The internal path stands in for the server in the checkout's own
    /// fetches, and is never written down; when it fails, the server is
    /// fetched from instead.
    #[test]
    fn a_checkout_fetches_over_the_internal_path_and_falls_back_to_the_server() {
        let Some(served) = served("internal") else { return };
        let real = url(&served.root.join("srv"));
        let sha = git(&served.app, &["rev-parse", "main"]);
        let workspace = served.root.join("work");

        // The server cannot be reached; the internal path can.
        let public = url(&served.root.join("nowhere"));
        let mut job = job(&served, &public, &sha);
        let (ok, outputs) = job.checkout(&with(&[]), "Run actions/checkout@v5", Some(real.clone()));
        assert!(ok);
        assert_eq!(outputs["commit"], sha);
        assert_eq!(git(&workspace, &["config", "remote.origin.url"]), format!("{public}/acme/app"));
        let config = std::fs::read_to_string(workspace.join(".git/config")).unwrap();
        assert!(!config.contains("insteadOf") && !config.contains("insteadof") && !config.contains(&real), "{config}");

        // The internal path fails: the server answers.
        let _ = std::fs::remove_dir_all(&workspace);
        let mut job = super::super::setup_in(
            json!({
                "checkout": { "repository": "acme/app" },
                "github": { "server_url": real, "repository": "acme/app", "ref": "refs/heads/main", "sha": sha, "token": "g1t_job" },
                "variables": {},
                "contexts": {},
            }),
            super::super::report::Api::offline(),
            workspace.clone(),
            served.root.join("temp"),
        )
        .unwrap();
        let (ok, _) = job.checkout(&with(&[]), "Run actions/checkout@v5", Some(url(&served.root.join("nowhere"))));
        assert!(ok);
        assert_eq!(git(&workspace, &["rev-parse", "HEAD"]), sha);
        // Without a token, nothing goes over the internal path.
        let _ = std::fs::remove_dir_all(&workspace);
        job.contexts.insert("github".into(), json!({ "server_url": real, "repository": "acme/app", "ref": "refs/heads/main", "sha": sha }));
        let (ok, _) = job.checkout(&with(&[]), "Run actions/checkout@v5", Some(url(&served.root.join("nowhere"))));
        assert!(ok);
        let _ = std::fs::remove_dir_all(&served.root);
    }

    #[test]
    fn a_path_outside_the_workspace_or_already_a_repository_runs_the_action() {
        let Some(served) = served("fallback") else { return };
        let mut job = job(&served, "https://g1t.sh", "");
        assert_eq!(job.checkout_fallback("v5", &with(&[])), None);
        assert!(job.checkout_fallback("v5", &with(&[("path", "../elsewhere")])).is_some());
        std::fs::create_dir_all(served.root.join("work/.git")).unwrap();
        assert!(job.checkout_fallback("v5", &with(&[])).is_some());
        assert_eq!(job.checkout_fallback("v5", &with(&[("path", "sub")])), None);
        job.spec["spec"] = json!({ "container": "node:22" });
        assert!(job.checkout_fallback("v5", &with(&[("path", "sub")])).is_some());
        job.spec["spec"] = json!({});
        // A run whose fork checkouts the action guards.
        job.contexts.insert("github".into(), json!({ "server_url": "https://g1t.sh", "event_name": "pull_request_target" }));
        assert!(job.checkout_fallback("v5", &with(&[("path", "sub")])).is_some());
        assert!(job.checkout_needs_action("v5", &with(&[])));
        job.contexts.insert("github".into(), json!({ "server_url": "https://g1t.sh", "event_name": "pull_request" }));
        assert_eq!(job.checkout_fallback("v5", &with(&[("path", "sub")])), None);
        job.spec["variables"]["RUNNER_ENVIRONMENT"] = json!("self-hosted");
        assert!(job.checkout_fallback("v5", &with(&[("path", "sub")])).is_some());
        assert!(job.checkout_needs_action("v5", &with(&[])));
        let _ = std::fs::remove_dir_all(&served.root);
    }
}
