//! Makes a security update: raises one package to a fixed version in the
//! lockfiles that resolve a vulnerable one, with the ecosystem's own tool,
//! commits that as g1t and pushes it to a branch of its own. The push is
//! what tells the security service to open the pull request; this opens
//! nothing itself.
//!
//! What each lockfile is updated with (the lockfiles `g1t_scan::lockfiles`
//! reads):
//!
//! | Lockfile | A direct dependency | Any other |
//! | --- | --- | --- |
//! | `package-lock.json` | `npm install --package-lock-only <pkg>@<range>` | `npm update --package-lock-only <pkg>`, then an `overrides` entry |
//! | `pnpm-lock.yaml` | `pnpm update <pkg>@<range> --lockfile-only` | `pnpm update <pkg> --depth Infinity --lockfile-only`, then `pnpm.overrides` |
//! | `yarn.lock` (2 and later) | `yarn up <pkg>@<range> --mode=update-lockfile` | `yarn up --recursive <pkg>`, then `resolutions` |
//! | `yarn.lock` (1) | `yarn upgrade <pkg>@<range>` | `resolutions` |
//! | `Cargo.lock` | `cargo update -p <pkg>@<old> --precise <version>`, else `cargo update -p <pkg>@<old>` | the same |
//! | `go.mod`, `go.sum` | `go get <module>@v<version>`, then `go mod tidy` | the same |
//! | `poetry.lock` | `poetry add <pkg>@^<version> --lock` | `poetry update --lock <pkg>` |
//! | `requirements.txt` | its `==` pins rewritten | the same |
//!
//! A direct dependency keeps its range's style (`^`, `~` or exact). No
//! install script runs. pnpm and yarn run through corepack, so the
//! version a project names in `packageManager` is the one used. Poetry is
//! installed into a virtual environment if the sandbox has none.
//!
//! Afterwards every lockfile is read again, and the update counts only if
//! none of them resolves the package below the version any more. When the
//! tool cannot get there (another package holds it back), the job fails
//! saying it needs code changes, with the tool's last lines.
//!
//! Configuration:
//!
//! - `GIT_REMOTE`, `GIT_BRANCH_BASE`: the repository and its default branch.
//! - `GIT_BRANCH`: the branch to push, under `g1t/security/`.
//! - `BUMP_ECOSYSTEM` (OSV's name: `npm`, `crates.io`, `Go`, `PyPI`),
//!   `BUMP_PACKAGE`, `BUMP_VERSION`: what to raise, to what.
//! - `BUMP_LOCKFILES`: the lockfiles' paths from the root, one per line or
//!   as a JSON array.
//! - `COMMIT_MESSAGE`: the commit's message.
//! - `G1T_USER`, `G1T_TOKEN`: to clone and push; passed per command, never
//!   written to the clone's config or remote.
//!
//! It prints one line of JSON on stdout saying what happened, and exits 0
//! once the branch is pushed; otherwise non-zero, with why on stderr:
//! `NEEDS_CHANGES_EXIT` when the update needs code changes,
//! `UNSUPPORTED_EXIT` for a lockfile or tool it cannot update.

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, anyhow, bail};
use g1t_scan::lockfiles::{Ecosystem, Lockfile};
use g1t_scan::version;
use serde_json::{Value, json};

use crate::{WORKDIR, auth_option, env, git};

use crate::{AUTHOR_EMAIL, AUTHOR_NAME};
/// Every security update's branch starts with this:
/// `g1t_contracts::security::UPDATE_BRANCH_PREFIX`.
const BRANCH_PREFIX: &str = "g1t/security/";

/// The exit code when the update needs code changes, not just a lockfile.
pub const NEEDS_CHANGES_EXIT: i32 = 3;
/// The exit code for a lockfile or ecosystem this cannot update.
pub const UNSUPPORTED_EXIT: i32 = 4;

/// Why a bump stopped, when that is not just an error.
#[derive(Debug)]
enum Stop {
    /// The tool could not raise it: something else holds it back.
    NeedsChanges(String),
    /// Not something this can update.
    Unsupported(String),
}

impl std::fmt::Display for Stop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Stop::NeedsChanges(why) => write!(f, "needs code changes: {why}"),
            Stop::Unsupported(why) => write!(f, "unsupported: {why}"),
        }
    }
}

impl std::error::Error for Stop {}

fn needs_changes(why: impl Into<String>) -> anyhow::Error {
    anyhow!(Stop::NeedsChanges(why.into()))
}

fn unsupported(why: impl Into<String>) -> anyhow::Error {
    anyhow!(Stop::Unsupported(why.into()))
}

/// What to raise, to what, where.
#[derive(Debug)]
struct Bump {
    ecosystem: Ecosystem,
    package: String,
    /// The fixed version, as the ecosystem's tools write it (Go's with `v`).
    version: String,
    jobs: Vec<Job>,
}

/// One directory's lockfiles of one kind, updated by one tool run.
#[derive(Debug, PartialEq, Eq)]
struct Job {
    /// From the repository's root; empty for the root.
    dir: String,
    lockfile: Lockfile,
    /// The lockfiles' paths from the root, each read again afterwards.
    paths: Vec<String>,
}

impl Job {
    fn file(&self, name: &str) -> String {
        if self.dir.is_empty() { name.to_owned() } else { format!("{}/{name}", self.dir) }
    }

    /// What the tool may change: the lockfiles and their manifest. Only
    /// these are committed, whatever else a tool leaves behind.
    fn touched(&self) -> Vec<String> {
        let mut files: Vec<String> = self.paths.clone();
        let manifests: &[&str] = match self.lockfile {
            Lockfile::PackageLock | Lockfile::PnpmLock | Lockfile::YarnLock => &["package.json"],
            Lockfile::GoMod | Lockfile::GoSum => &["go.mod", "go.sum"],
            Lockfile::PoetryLock => &["pyproject.toml"],
            Lockfile::CargoLock | Lockfile::Requirements => &[],
        };
        files.extend(manifests.iter().map(|name| self.file(name)));
        files.sort();
        files.dedup();
        files
    }
}

/// `BUMP_LOCKFILES`: a JSON array, or one path per line.
fn lockfile_list(text: &str) -> Result<Vec<String>> {
    let text = text.trim();
    let paths: Vec<String> = if text.starts_with('[') {
        serde_json::from_str(text).context("BUMP_LOCKFILES is not a JSON array of paths")?
    } else {
        text.lines().map(str::to_owned).collect()
    };
    Ok(paths.into_iter().map(|path| path.trim().trim_start_matches("./").to_owned()).filter(|path| !path.is_empty()).collect())
}

/// The lockfiles grouped into what one tool run updates: `go.mod` and
/// `go.sum` in one directory are one module. Each must be a lockfile of
/// `ecosystem`, inside the repository.
fn jobs(ecosystem: Ecosystem, paths: &[String]) -> Result<Vec<Job>> {
    let mut jobs: Vec<Job> = Vec::new();
    for path in paths {
        if path.starts_with('/') || path.contains('\\') || path.split('/').any(|part| part == ".." || part.is_empty()) {
            bail!("{path} is not a path inside the repository");
        }
        let lockfile = Lockfile::for_path(path).ok_or_else(|| unsupported(format!("{path} is not a lockfile g1t can update")))?;
        if lockfile.ecosystem() != ecosystem {
            bail!("{path} is not a {} lockfile", ecosystem.osv());
        }
        let dir = path.rsplit_once('/').map(|(dir, _)| dir.to_owned()).unwrap_or_default();
        let lockfile = if lockfile == Lockfile::GoSum { Lockfile::GoMod } else { lockfile };
        match jobs.iter_mut().find(|job| job.dir == dir && job.lockfile == lockfile) {
            Some(job) => {
                if !job.paths.contains(path) {
                    job.paths.push(path.clone());
                }
            }
            None => jobs.push(Job { dir, lockfile, paths: vec![path.clone()] }),
        }
    }
    if jobs.is_empty() {
        bail!("BUMP_LOCKFILES names no lockfile");
    }
    Ok(jobs)
}

/// A version as the ecosystem's tools take it: Go's with a leading `v`,
/// everyone else's without.
fn tool_version(ecosystem: Ecosystem, version: &str) -> String {
    let version = version.trim();
    let bare = match version.strip_prefix(['v', 'V']) {
        Some(rest) if rest.starts_with(|c: char| c.is_ascii_digit()) => rest,
        _ => version,
    };
    match ecosystem {
        Ecosystem::Go => format!("v{bare}"),
        _ => bare.to_owned(),
    }
}

/// A package name or version is passed to tools as one argument: it must
/// not read as an option, and holds only what names and versions do.
fn safe_argument(what: &str, text: &str) -> Result<()> {
    let allowed = |c: char| c.is_ascii_alphanumeric() || "@/._-+~".contains(c);
    if text.is_empty() || text.starts_with('-') || !text.chars().all(allowed) || text.len() > 214 {
        bail!("{what} {text:?} is not a package name or version g1t can pass to a tool");
    }
    Ok(())
}

/// The range to ask for a direct dependency now at `current`: the same
/// style (`^1.2.3`, `~1.2.3`, exact), and `^` for any other.
fn raised_range(current: &str, version: &str) -> String {
    let current = current.trim();
    if current.starts_with('~') {
        format!("~{version}")
    } else if current.starts_with(|c: char| c.is_ascii_digit()) || current.starts_with('=') {
        version.to_owned()
    } else {
        format!("^{version}")
    }
}

/// The range `package.json` asks for `package` with, if it is a direct
/// dependency from the registry (not a workspace, link, alias or URL).
fn direct_range(manifest: &Value, package: &str) -> Option<String> {
    ["dependencies", "devDependencies", "optionalDependencies"].iter().find_map(|section| {
        let range = manifest.get(section)?.get(package)?.as_str()?;
        let registry = !range.contains(':') && !range.contains('/');
        registry.then(|| range.to_owned())
    })
}

/// Which JavaScript package manager wrote a lockfile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Node {
    Npm,
    Pnpm,
    /// Yarn 1.
    YarnClassic,
    /// Yarn 2 and later, whose lockfile has `__metadata`.
    YarnBerry,
}

impl Node {
    fn of(lockfile: Lockfile, text: &str) -> Option<Node> {
        Some(match lockfile {
            Lockfile::PackageLock => Node::Npm,
            Lockfile::PnpmLock => Node::Pnpm,
            Lockfile::YarnLock if text.lines().any(|line| line.starts_with("__metadata:")) => Node::YarnBerry,
            Lockfile::YarnLock => Node::YarnClassic,
            _ => return None,
        })
    }

    /// The command, through corepack for pnpm and yarn, so the version the
    /// project's `packageManager` names is the one that runs.
    fn command(self, args: &[&str]) -> Vec<String> {
        let mut command: Vec<&str> = match self {
            Node::Npm => vec!["npm"],
            Node::Pnpm => vec!["corepack", "pnpm"],
            Node::YarnClassic | Node::YarnBerry => vec!["corepack", "yarn"],
        };
        command.extend(args);
        command.into_iter().map(str::to_owned).collect()
    }

    /// Raises a direct dependency to `range`.
    fn direct(self, package: &str, range: &str) -> Vec<String> {
        let spec = format!("{package}@{range}");
        match self {
            Node::Npm => self.command(&["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", &spec]),
            Node::Pnpm => self.command(&["update", &spec, "--lockfile-only", "--ignore-scripts"]),
            Node::YarnBerry => self.command(&["up", &spec, "--mode=update-lockfile"]),
            Node::YarnClassic => self.command(&["upgrade", &spec, "--ignore-scripts", "--non-interactive"]),
        }
    }

    /// Moves a package something else depends on as far as the ranges
    /// that ask for it allow. Yarn 1 has no such command.
    fn transitive(self, package: &str) -> Option<Vec<String>> {
        Some(match self {
            Node::Npm => self.command(&["update", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", package]),
            Node::Pnpm => self.command(&["update", package, "--depth", "Infinity", "--lockfile-only", "--ignore-scripts"]),
            Node::YarnBerry => self.command(&["up", "--recursive", package, "--mode=update-lockfile"]),
            Node::YarnClassic => return None,
        })
    }

    /// Where `package.json` forces a version on everything that asks for
    /// a package.
    fn override_path(self) -> &'static [&'static str] {
        match self {
            Node::Npm => &["overrides"],
            Node::Pnpm => &["pnpm", "overrides"],
            Node::YarnClassic | Node::YarnBerry => &["resolutions"],
        }
    }

    /// Writes the lockfile again from `package.json`.
    fn relock(self) -> Vec<String> {
        match self {
            Node::Npm => self.command(&["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]),
            Node::Pnpm => self.command(&["install", "--lockfile-only", "--ignore-scripts"]),
            Node::YarnBerry => self.command(&["install", "--mode=update-lockfile"]),
            Node::YarnClassic => self.command(&["install", "--ignore-scripts", "--non-interactive"]),
        }
    }
}

/// Adds `package: version` to the overrides at `path` in `package.json`,
/// creating the objects on the way. Returns false when it is already there.
fn add_override(manifest: &mut Value, path: &[&str], package: &str, version: &str) -> Result<bool> {
    let mut at = manifest;
    for key in path {
        let object = at.as_object_mut().ok_or_else(|| anyhow!("package.json is not an object"))?;
        at = object.entry(key.to_string()).or_insert_with(|| json!({}));
    }
    let object = at.as_object_mut().ok_or_else(|| anyhow!("package.json's {} is not an object", path.join(".")))?;
    if object.get(package).and_then(Value::as_str) == Some(version) {
        return Ok(false);
    }
    object.insert(package.to_owned(), Value::String(version.to_owned()));
    Ok(true)
}

/// What Cargo runs for each locked version of `package` below `version`:
/// straight to it, or, when that is past what a dependent's requirement
/// allows, as far as the requirement does.
fn cargo_commands(package: &str, old: &str, version: &str) -> [Vec<String>; 2] {
    let spec = format!("{package}@{old}");
    [
        ["cargo", "update", "-p", &spec, "--precise", version].map(str::to_owned).to_vec(),
        ["cargo", "update", "-p", &spec].map(str::to_owned).to_vec(),
    ]
}

fn go_commands(module: &str, version: &str) -> [Vec<String>; 2] {
    [
        vec!["go".into(), "get".into(), format!("{module}@{version}")],
        ["go", "mod", "tidy"].map(str::to_owned).to_vec(),
    ]
}

/// Which dependency group of `pyproject.toml` names `package`: `Some(None)`
/// for the main one, `Some(Some(group))` for another, `None` when it is not
/// a direct dependency.
fn poetry_group(pyproject: &toml::Value, package: &str) -> Option<Option<String>> {
    let wanted = Ecosystem::PyPI.normalize(package);
    let names = |table: Option<&toml::Value>| -> bool {
        table
            .and_then(toml::Value::as_table)
            .is_some_and(|table| table.keys().any(|key| Ecosystem::PyPI.normalize(key) == wanted))
    };
    let poetry = pyproject.get("tool").and_then(|tool| tool.get("poetry"));
    if names(poetry.and_then(|poetry| poetry.get("dependencies"))) {
        return Some(None);
    }
    let pep621 = pyproject
        .get("project")
        .and_then(|project| project.get("dependencies"))
        .and_then(toml::Value::as_array)
        .is_some_and(|list| {
            list.iter().filter_map(toml::Value::as_str).any(|requirement| {
                let name: String = requirement.chars().take_while(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).collect();
                Ecosystem::PyPI.normalize(&name) == wanted
            })
        });
    if pep621 {
        return Some(None);
    }
    if names(poetry.and_then(|poetry| poetry.get("dev-dependencies"))) {
        return Some(Some("dev".to_owned()));
    }
    let groups = poetry.and_then(|poetry| poetry.get("group")).and_then(toml::Value::as_table)?;
    groups
        .iter()
        .find(|(_, group)| names(group.get("dependencies")))
        .map(|(name, _)| Some(name.clone()))
}

fn poetry_commands(poetry: &[String], package: &str, version: &str, group: Option<Option<String>>) -> Vec<String> {
    let mut command = poetry.to_vec();
    match group {
        Some(group) => {
            command.extend(["add".to_owned(), format!("{package}@^{version}"), "--lock".to_owned()]);
            if let Some(group) = group {
                command.extend(["--group".to_owned(), group]);
            }
        }
        None => command.extend(["update".to_owned(), "--lock".to_owned(), package.to_owned()]),
    }
    command
}

/// `requirements.txt` with every `==` (or `===`) pin of `package` below
/// `version` raised to it, and nothing else changed. Returns the text and
/// how many pins moved.
fn rewrite_pins(text: &str, package: &str, version: &str) -> (String, usize) {
    let wanted = Ecosystem::PyPI.normalize(package);
    let mut moved = 0;
    let mut out = String::with_capacity(text.len() + 8);
    for line in text.split_inclusive('\n') {
        let rewritten = (|| {
            let code = line.split('#').next().unwrap_or_default();
            let trimmed = code.trim_start();
            if trimmed.starts_with('-') || code.contains("://") {
                return None;
            }
            let operator = code.find("===").map(|at| (at, 3)).or_else(|| code.find("==").map(|at| (at, 2)))?;
            let name = code[..operator.0].split('[').next().unwrap_or_default().trim();
            if Ecosystem::PyPI.normalize(name) != wanted {
                return None;
            }
            let start = operator.0 + operator.1;
            let rest = &code[start..];
            let leading = rest.len() - rest.trim_start().len();
            let from = start + leading;
            let end = code[from..]
                .find(|c: char| c.is_whitespace() || ",;\\".contains(c))
                .map_or(code.len(), |at| from + at);
            let old = &line[from..end];
            if old.is_empty() || old.contains('*') || version::compare(old, version).is_ge() {
                return None;
            }
            Some(format!("{}{version}{}", &line[..from], &line[end..]))
        })();
        match rewritten {
            Some(line) => {
                moved += 1;
                out.push_str(&line);
            }
            None => out.push_str(line),
        }
    }
    (out, moved)
}

/// The versions of `package` a lockfile still resolves below `version`.
fn below(lockfile: Lockfile, text: &str, ecosystem: Ecosystem, package: &str, version: &str) -> Vec<String> {
    let name = ecosystem.normalize(package);
    let found: BTreeSet<String> = lockfile
        .parse(text)
        .into_iter()
        .filter(|found| found.name == name && version::compare(&found.version, version).is_lt())
        .map(|found| found.version)
        .collect();
    found.into_iter().collect()
}

/// The last lines of what a tool said, for the reason it failed.
fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// Runs a tool in `dir` and returns what it said, failing with the last
/// lines of its output. A tool that is not installed is unsupported.
fn run(dir: &Path, command: &[String]) -> Result<String> {
    let (program, args) = command.split_first().ok_or_else(|| anyhow!("no command"))?;
    eprintln!("g1t-runner: {} (in {})", command.join(" "), dir.display());
    let output = Command::new(program)
        .current_dir(dir)
        .args(args)
        // Lockfiles only: nothing installs, prompts, audits or runs scripts.
        .env("CI", "true")
        .env("npm_config_audit", "false")
        .env("npm_config_fund", "false")
        .env("npm_config_update_notifier", "false")
        .env("npm_config_ignore_scripts", "true")
        .env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
        .env("YARN_ENABLE_IMMUTABLE_INSTALLS", "false")
        .env("YARN_ENABLE_SCRIPTS", "false")
        .env("YARN_ENABLE_TELEMETRY", "0")
        .env("POETRY_NO_INTERACTION", "1")
        .env("POETRY_VIRTUALENVS_CREATE", "false")
        .env("GOFLAGS", "-mod=mod")
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                unsupported(format!("{program} is not installed in this sandbox"))
            } else {
                anyhow!("could not run {program}: {error}")
            }
        })?;
    let said = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    if !output.status.success() {
        bail!("{} failed:\n{}", command.join(" "), tail(&said, 20));
    }
    Ok(said)
}

fn read(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).with_context(|| format!("could not read {}", path.display()))
}

/// Poetry, installed into a virtual environment from PyPI when the
/// sandbox has none.
fn poetry() -> Result<Vec<String>> {
    if Command::new("poetry").arg("--version").output().is_ok_and(|output| output.status.success()) {
        return Ok(vec!["poetry".to_owned()]);
    }
    let venv = "/tmp/g1t-poetry";
    let here = Path::new("/");
    run(here, &["python3", "-m", "venv", venv].map(str::to_owned))?;
    run(here, &[format!("{venv}/bin/pip"), "install".into(), "--quiet".into(), "poetry".into()])?;
    Ok(vec![format!("{venv}/bin/poetry")])
}

impl Bump {
    fn from_env() -> Result<Bump> {
        let ecosystem_name = env("BUMP_ECOSYSTEM")?;
        let ecosystem = Ecosystem::parse(ecosystem_name.trim())
            .ok_or_else(|| unsupported(format!("g1t cannot update {ecosystem_name} dependencies")))?;
        let package = env("BUMP_PACKAGE")?.trim().to_owned();
        let version = tool_version(ecosystem, &env("BUMP_VERSION")?);
        safe_argument("package", &package)?;
        safe_argument("version", &version)?;
        let jobs = jobs(ecosystem, &lockfile_list(&env("BUMP_LOCKFILES")?)?)?;
        Ok(Bump { ecosystem, package, version, jobs })
    }

    /// The versions every lockfile of `job` still resolves below the target.
    fn still_below(&self, workdir: &Path, job: &Job) -> Result<Vec<String>> {
        let mut found = BTreeSet::new();
        for path in &job.paths {
            let lockfile = Lockfile::for_path(path).unwrap_or(job.lockfile);
            let file = workdir.join(path);
            if !file.exists() {
                bail!("{path} is not in the repository's default branch");
            }
            found.extend(below(lockfile, &read(&file)?, self.ecosystem, &self.package, &self.version));
        }
        Ok(found.into_iter().collect())
    }

    /// Runs the tool for one job. Errors from the tool are kept for the
    /// reason, should the lockfile still be behind afterwards.
    fn update(&self, workdir: &Path, job: &Job) -> Result<Vec<String>> {
        let dir = workdir.join(&job.dir);
        let mut said = Vec::new();
        let attempt = |command: Vec<String>, said: &mut Vec<String>| -> Result<bool> {
            match run(&dir, &command) {
                Ok(_) => Ok(true),
                Err(error) if error.downcast_ref::<Stop>().is_some() => Err(error),
                Err(error) => {
                    said.push(format!("{error:#}"));
                    Ok(false)
                }
            }
        };
        match job.lockfile {
            Lockfile::PackageLock | Lockfile::PnpmLock | Lockfile::YarnLock => {
                let lock = read(&workdir.join(&job.paths[0]))?;
                let node = Node::of(job.lockfile, &lock).ok_or_else(|| anyhow!("not a JavaScript lockfile"))?;
                let manifest_path = dir.join("package.json");
                let mut manifest: Value = serde_json::from_str(&read(&manifest_path)?).context("package.json is not JSON")?;
                match direct_range(&manifest, &self.package) {
                    Some(range) => {
                        attempt(node.direct(&self.package, &raised_range(&range, &self.version)), &mut said)?;
                    }
                    None => {
                        if let Some(command) = node.transitive(&self.package) {
                            attempt(command, &mut said)?;
                        }
                        // Held back by what asks for it: force the version.
                        if !self.still_below(workdir, job)?.is_empty() {
                            manifest = serde_json::from_str(&read(&manifest_path)?).context("package.json is not JSON")?;
                            if add_override(&mut manifest, node.override_path(), &self.package, &self.version)? {
                                let indent = if read(&manifest_path)?.contains("\n    \"") { "    " } else { "  " };
                                write_json(&manifest_path, &manifest, indent)?;
                            }
                            attempt(node.relock(), &mut said)?;
                        }
                    }
                }
            }
            Lockfile::CargoLock => {
                for old in self.still_below(workdir, job)? {
                    let [precise, compatible] = cargo_commands(&self.package, &old, &self.version);
                    if !attempt(precise, &mut said)? {
                        attempt(compatible, &mut said)?;
                    }
                }
            }
            Lockfile::GoMod | Lockfile::GoSum => {
                for command in go_commands(&self.package, &self.version) {
                    if !attempt(command, &mut said)? {
                        break;
                    }
                }
            }
            Lockfile::PoetryLock => {
                let pyproject_path = dir.join("pyproject.toml");
                let pyproject: toml::Value = toml::from_str(&read(&pyproject_path)?).context("pyproject.toml is not TOML")?;
                let command = poetry_commands(&poetry()?, &self.package, &self.version, poetry_group(&pyproject, &self.package));
                attempt(command, &mut said)?;
            }
            Lockfile::Requirements => {
                for path in &job.paths {
                    let file = workdir.join(path);
                    let text = read(&file)?;
                    if text.contains("--hash") {
                        return Err(unsupported(format!("{path} pins hashes, which need its compiler to update")));
                    }
                    let (rewritten, moved) = rewrite_pins(&text, &self.package, &self.version);
                    if moved > 0 {
                        std::fs::write(&file, rewritten).with_context(|| format!("could not write {path}"))?;
                    }
                }
            }
        }
        Ok(said)
    }
}

/// Writes JSON as package managers do: indented, with a final newline.
fn write_json(path: &Path, value: &Value, indent: &str) -> Result<()> {
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(indent.as_bytes());
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    serde::Serialize::serialize(value, &mut serializer)?;
    out.push(b'\n');
    std::fs::write(path, out).with_context(|| format!("could not write {}", path.display()))
}

/// What was pushed.
struct Pushed {
    commit: String,
    /// The branch was there already, with the same files.
    existed: bool,
}

fn bump() -> Result<(Bump, String, Pushed)> {
    let bump = Bump::from_env()?;
    let remote = env("GIT_REMOTE")?;
    let base = env("GIT_BRANCH_BASE")?;
    let branch = env("GIT_BRANCH")?;
    if !branch.starts_with(BRANCH_PREFIX) || branch.contains("..") || branch.chars().any(char::is_whitespace) {
        bail!("{branch} is not a security update's branch");
    }
    let message = env("COMMIT_MESSAGE").unwrap_or_else(|_| format!("Update {} to {}", bump.package, bump.version));
    let auth = auth_option(&env("G1T_USER")?, &env("G1T_TOKEN")?);
    let workdir = Path::new(WORKDIR);

    std::fs::create_dir_all("/work")?;
    crate::clone::clone(Path::new("/work"), &auth, &["--branch", &base], &remote, WORKDIR)
        .with_context(|| format!("could not clone {base}"))?;
    git(workdir, &["checkout", "--quiet", "-b", &branch])?;
    git(workdir, &["config", "user.name", AUTHOR_NAME])?;
    git(workdir, &["config", "user.email", AUTHOR_EMAIL])?;

    let mut behind = Vec::new();
    for job in &bump.jobs {
        if bump.still_below(workdir, job)?.is_empty() {
            continue; // Already at the version or later here.
        }
        let said = bump.update(workdir, job)?;
        let left = bump.still_below(workdir, job)?;
        if !left.is_empty() {
            let why = said.last().map(|said| format!("\n{said}")).unwrap_or_default();
            behind.push(format!(
                "{} still resolves {} {} (wanted {} or later){why}",
                job.paths.join(", "),
                bump.package,
                left.join(", "),
                bump.version
            ));
        }
    }
    if !behind.is_empty() {
        return Err(needs_changes(behind.join("\n\n")));
    }

    let touched: Vec<String> = bump
        .jobs
        .iter()
        .flat_map(Job::touched)
        .filter(|path| workdir.join(path).exists())
        .collect();
    let mut add = vec!["add", "--"];
    add.extend(touched.iter().map(String::as_str));
    git(workdir, &add)?;
    if git(workdir, &["diff", "--cached", "--name-only"])?.is_empty() {
        bail!(
            "nothing to change: {} already resolves {} {} or later",
            bump.jobs.iter().flat_map(|job| job.paths.iter().map(String::as_str)).collect::<Vec<_>>().join(", "),
            bump.package,
            bump.version
        );
    }
    git(workdir, &["commit", "--quiet", "--message", &message])?;
    let commit = git(workdir, &["rev-parse", "HEAD"])?;
    let refspec = format!("HEAD:refs/heads/{branch}");
    let pushed = git(workdir, &["-c", &auth, "push", "--quiet", "origin", &refspec]);
    if let Err(error) = pushed {
        // Pushed before (a retried job): the same files there is success.
        let theirs = git(workdir, &["-c", &auth, "ls-remote", "origin", &format!("refs/heads/{branch}")]).unwrap_or_default();
        if theirs.is_empty() {
            return Err(error.context("could not push the update"));
        }
        crate::clone::fetch(workdir, &auth, "origin", &format!("refs/heads/{branch}")).context("could not read the branch already pushed")?;
        let same = git(workdir, &["rev-parse", "FETCH_HEAD^{tree}"])? == git(workdir, &["rev-parse", "HEAD^{tree}"])?;
        if !same {
            return Err(error.context(format!("{branch} already exists with other changes")));
        }
        let commit = git(workdir, &["rev-parse", "FETCH_HEAD"])?;
        return Ok((bump, branch, Pushed { commit, existed: true }));
    }
    Ok((bump, branch, Pushed { commit, existed: false }))
}

pub fn main() -> i32 {
    match bump() {
        Ok((bump, branch, pushed)) => {
            println!(
                "{}",
                json!({
                    "bump": if pushed.existed { "exists" } else { "pushed" },
                    "branch": branch,
                    "commit": pushed.commit,
                    "ecosystem": bump.ecosystem.osv(),
                    "package": bump.package,
                    "version": bump.version,
                    "lockfiles": bump.jobs.iter().flat_map(|job| job.paths.clone()).collect::<Vec<_>>(),
                })
            );
            0
        }
        Err(error) => {
            let (reason, code) = match error.downcast_ref::<Stop>() {
                Some(Stop::NeedsChanges(_)) => ("needs_code_changes", NEEDS_CHANGES_EXIT),
                Some(Stop::Unsupported(_)) => ("unsupported", UNSUPPORTED_EXIT),
                None => ("failed", 1),
            };
            println!("{}", json!({ "bump": "failed", "reason": reason, "message": format!("{error:#}") }));
            eprintln!("g1t-runner: {error:#}");
            code
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn lockfiles_come_as_lines_or_json() {
        assert_eq!(lockfile_list("Cargo.lock\n web/package-lock.json \n\n").unwrap(), ["Cargo.lock", "web/package-lock.json"]);
        assert_eq!(lockfile_list(r#"["./go.mod","go.sum"]"#).unwrap(), ["go.mod", "go.sum"]);
        assert!(lockfile_list("[not json").is_err());
    }

    #[test]
    fn lockfiles_group_by_directory_and_tool() {
        let found = jobs(Ecosystem::Go, &strings(&["go.mod", "go.sum", "tools/go.sum"])).unwrap();
        assert_eq!(
            found,
            [
                Job { dir: String::new(), lockfile: Lockfile::GoMod, paths: strings(&["go.mod", "go.sum"]) },
                Job { dir: "tools".into(), lockfile: Lockfile::GoMod, paths: strings(&["tools/go.sum"]) },
            ]
        );
        assert_eq!(found[0].touched(), ["go.mod", "go.sum"]);
        let web = jobs(Ecosystem::Npm, &strings(&["web/package-lock.json"])).unwrap();
        assert_eq!(web[0].touched(), ["web/package-lock.json", "web/package.json"]);
    }

    #[test]
    fn lockfiles_must_be_the_ecosystems_and_inside_the_repository() {
        assert!(jobs(Ecosystem::Npm, &strings(&["Cargo.lock"])).is_err());
        assert!(jobs(Ecosystem::Npm, &strings(&["../package-lock.json"])).is_err());
        assert!(jobs(Ecosystem::Npm, &strings(&["/etc/package-lock.json"])).is_err());
        assert!(jobs(Ecosystem::Npm, &[]).is_err());
        let error = jobs(Ecosystem::PyPI, &strings(&["uv.lock"])).unwrap_err();
        assert!(matches!(error.downcast_ref::<Stop>(), Some(Stop::Unsupported(_))));
    }

    #[test]
    fn versions_as_each_tool_takes_them() {
        assert_eq!(tool_version(Ecosystem::Go, "0.17.0"), "v0.17.0");
        assert_eq!(tool_version(Ecosystem::Go, "v0.17.0"), "v0.17.0");
        assert_eq!(tool_version(Ecosystem::Npm, "v4.17.21"), "4.17.21");
        assert_eq!(tool_version(Ecosystem::Cargo, " 1.6.1 "), "1.6.1");
        assert_eq!(tool_version(Ecosystem::PyPI, "2.31.0"), "2.31.0");
    }

    #[test]
    fn names_and_versions_cannot_be_options() {
        assert!(safe_argument("package", "@babel/core").is_ok());
        assert!(safe_argument("package", "golang.org/x/net").is_ok());
        assert!(safe_argument("version", "1.2.3-rc.1+build").is_ok());
        assert!(safe_argument("package", "--registry=evil").is_err());
        assert!(safe_argument("package", "a b").is_err());
        assert!(safe_argument("version", "1.0;rm").is_err());
        assert!(safe_argument("version", "").is_err());
    }

    #[test]
    fn a_direct_dependency_keeps_its_range_style() {
        assert_eq!(raised_range("^4.17.0", "4.17.21"), "^4.17.21");
        assert_eq!(raised_range("~1.2.0", "1.2.5"), "~1.2.5");
        assert_eq!(raised_range("1.2.0", "1.2.5"), "1.2.5");
        assert_eq!(raised_range("=1.2.0", "1.2.5"), "1.2.5");
        assert_eq!(raised_range(">=1 <2", "1.2.5"), "^1.2.5");
        assert_eq!(raised_range("*", "1.2.5"), "^1.2.5");
    }

    #[test]
    fn direct_dependencies_from_the_registry_only() {
        let manifest = json!({
            "dependencies": { "lodash": "^4.17.0", "local": "file:../local", "shared": "workspace:*" },
            "devDependencies": { "vitest": "~1.0.0", "fork": "github:me/fork" },
        });
        assert_eq!(direct_range(&manifest, "lodash").as_deref(), Some("^4.17.0"));
        assert_eq!(direct_range(&manifest, "vitest").as_deref(), Some("~1.0.0"));
        assert_eq!(direct_range(&manifest, "local"), None);
        assert_eq!(direct_range(&manifest, "shared"), None);
        assert_eq!(direct_range(&manifest, "fork"), None);
        assert_eq!(direct_range(&manifest, "minimist"), None);
    }

    #[test]
    fn javascript_commands_by_lockfile() {
        let npm = Node::of(Lockfile::PackageLock, "{}").unwrap();
        assert_eq!(
            npm.direct("lodash", "^4.17.21"),
            strings(&["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "lodash@^4.17.21"])
        );
        assert_eq!(
            npm.transitive("minimist").unwrap(),
            strings(&["npm", "update", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "minimist"])
        );
        assert_eq!(npm.override_path(), ["overrides"]);

        let pnpm = Node::of(Lockfile::PnpmLock, "lockfileVersion: '9.0'").unwrap();
        assert_eq!(pnpm.direct("lodash", "^4.17.21"), strings(&["corepack", "pnpm", "update", "lodash@^4.17.21", "--lockfile-only", "--ignore-scripts"]));
        assert_eq!(pnpm.override_path(), ["pnpm", "overrides"]);

        let berry = Node::of(Lockfile::YarnLock, "__metadata:\n  version: 6\n").unwrap();
        assert_eq!(berry, Node::YarnBerry);
        assert_eq!(berry.direct("lodash", "^4.17.21"), strings(&["corepack", "yarn", "up", "lodash@^4.17.21", "--mode=update-lockfile"]));
        assert_eq!(berry.transitive("minimist").unwrap(), strings(&["corepack", "yarn", "up", "--recursive", "minimist", "--mode=update-lockfile"]));

        let classic = Node::of(Lockfile::YarnLock, "# yarn lockfile v1\n").unwrap();
        assert_eq!(classic, Node::YarnClassic);
        assert_eq!(classic.transitive("minimist"), None);
        assert_eq!(classic.override_path(), ["resolutions"]);
        assert_eq!(Node::of(Lockfile::CargoLock, ""), None);
    }

    #[test]
    fn overrides_are_added_once() {
        let mut manifest = json!({ "name": "app" });
        assert!(add_override(&mut manifest, &["pnpm", "overrides"], "minimist", "1.2.6").unwrap());
        assert_eq!(manifest["pnpm"]["overrides"]["minimist"], "1.2.6");
        assert!(!add_override(&mut manifest, &["pnpm", "overrides"], "minimist", "1.2.6").unwrap());
        assert!(add_override(&mut manifest, &["pnpm", "overrides"], "minimist", "1.2.8").unwrap());
        assert_eq!(manifest["pnpm"]["overrides"]["minimist"], "1.2.8");
    }

    #[test]
    fn cargo_and_go_commands() {
        let [precise, compatible] = cargo_commands("time", "0.1.43", "0.1.45");
        assert_eq!(precise, strings(&["cargo", "update", "-p", "time@0.1.43", "--precise", "0.1.45"]));
        assert_eq!(compatible, strings(&["cargo", "update", "-p", "time@0.1.43"]));
        let [get, tidy] = go_commands("golang.org/x/net", "v0.23.0");
        assert_eq!(get, strings(&["go", "get", "golang.org/x/net@v0.23.0"]));
        assert_eq!(tidy, strings(&["go", "mod", "tidy"]));
    }

    #[test]
    fn poetry_adds_a_direct_dependency_and_updates_any_other() {
        let pyproject: toml::Value = toml::from_str(
            "[tool.poetry.dependencies]\npython = \"^3.11\"\nRequests = \"^2.0\"\n\n[tool.poetry.group.test.dependencies]\npytest = \"^7\"\n",
        )
        .unwrap();
        assert_eq!(poetry_group(&pyproject, "requests"), Some(None));
        assert_eq!(poetry_group(&pyproject, "pytest"), Some(Some("test".to_owned())));
        assert_eq!(poetry_group(&pyproject, "urllib3"), None);
        let pep621: toml::Value = toml::from_str("[project]\ndependencies = [\"jinja2>=3.0\", \"Flask_Cors\"]\n").unwrap();
        assert_eq!(poetry_group(&pep621, "Jinja2"), Some(None));
        assert_eq!(poetry_group(&pep621, "flask-cors"), Some(None));

        let poetry = strings(&["poetry"]);
        assert_eq!(poetry_commands(&poetry, "requests", "2.31.0", Some(None)), strings(&["poetry", "add", "requests@^2.31.0", "--lock"]));
        assert_eq!(
            poetry_commands(&poetry, "pytest", "7.4.0", Some(Some("test".into()))),
            strings(&["poetry", "add", "pytest@^7.4.0", "--lock", "--group", "test"])
        );
        assert_eq!(poetry_commands(&poetry, "urllib3", "2.0.7", None), strings(&["poetry", "update", "--lock", "urllib3"]));
    }

    #[test]
    fn requirements_pins_are_rewritten_in_place() {
        let text = "# pinned\nrequests==2.25.0  # http\nDjango[argon2]===3.2.0 ; python_version >= \"3.8\"\nurllib3==1.26.18\nrequests_toolbelt==0.9.1\n-r base.txt\nflask>=2.0\n";
        let (out, moved) = rewrite_pins(text, "requests", "2.31.0");
        assert_eq!(moved, 1);
        assert!(out.contains("requests==2.31.0  # http\n"));
        assert!(out.contains("requests_toolbelt==0.9.1\n"));
        let (out, moved) = rewrite_pins(&out, "django", "3.2.25");
        assert_eq!(moved, 1);
        assert!(out.contains("Django[argon2]===3.2.25 ; python_version >= \"3.8\"\n"));
        // Already at or past the version: left alone.
        let (same, moved) = rewrite_pins(text, "urllib3", "1.26.18");
        assert_eq!((same.as_str(), moved), (text, 0));
        // A line without a final newline keeps it that way.
        assert_eq!(rewrite_pins("Requests==2.0", "requests", "2.31.0").0, "Requests==2.31.0");
        assert_eq!(rewrite_pins("requests == 2.0,<3\n", "requests", "2.31.0").0, "requests == 2.31.0,<3\n");
    }

    #[test]
    fn lockfiles_are_read_again_for_what_is_still_below() {
        let lock = r#"{"lockfileVersion":3,"packages":{"":{},"node_modules/lodash":{"version":"4.17.21"},"node_modules/a/node_modules/lodash":{"version":"4.17.4"}}}"#;
        assert_eq!(below(Lockfile::PackageLock, lock, Ecosystem::Npm, "lodash", "4.17.21"), ["4.17.4"]);
        let sum = "golang.org/x/net v0.17.0 h1:x=\ngolang.org/x/net v0.23.0 h1:y=\n";
        assert!(below(Lockfile::GoSum, sum, Ecosystem::Go, "golang.org/x/net", "v0.23.0").is_empty());
        assert_eq!(below(Lockfile::Requirements, "Requests==2.0\n", Ecosystem::PyPI, "requests", "2.31.0"), ["2.0"]);
    }

    #[test]
    fn a_failure_says_its_last_lines() {
        assert_eq!(tail("a\n\nb\nc\n", 2), "b\nc");
        assert_eq!(tail("only", 5), "only");
    }
}
