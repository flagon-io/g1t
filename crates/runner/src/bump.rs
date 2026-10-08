//! Makes a security or version update: raises one or more packages to a
//! version in the lockfiles named, with the ecosystem's own tool, commits
//! that as g1t and pushes it to a branch of its own. The push is what tells
//! the security service to open the pull request; this opens nothing
//! itself.
//!
//! A security update raises one package to a fixed version, on a branch
//! under `g1t/security/`. A version update (`BUMP_KIND=version`) raises one
//! package or a group of them in one commit, on the branch its dependency
//! update file names (any but the default one), and changes manifests as
//! its versioning strategy says.
//!
//! What each lockfile is updated with (the lockfiles `g1t_scan::lockfiles`
//! reads), for a security update and a version update with the `increase`
//! strategy:
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
//! A version update never adds an override or a resolution: a package
//! nothing in `package.json` names is moved only as far as the ranges that
//! ask for it allow. Its strategy (`BUMP_STRATEGY`) decides how a direct
//! dependency's requirement changes:
//!
//! | Strategy | npm, pnpm, yarn | Cargo | Poetry |
//! | --- | --- | --- | --- |
//! | `increase` | the range raised, as above | `--precise`; if the requirement does not allow it, the requirement raised in `Cargo.toml` | as above |
//! | `increase-if-necessary` | the update the range allows (`npm update`, `pnpm update`, `yarn up -R`, `yarn upgrade <pkg>`); if that is not enough, the range raised | as `increase` | as above |
//! | `widen` | the update the range allows; if that is not enough, the range widened: `^1.2.0 \|\| ^2.0.0` | as `increase` | as above |
//! | `lockfile-only` | the update the range allows, and `package.json` left alone | `--precise`, else as far as the requirement allows | `poetry update --lock <pkg>` |
//!
//! Go modules and `requirements.txt` are updated the same way whatever the
//! strategy. A requirement raised in `Cargo.toml` keeps its operator (`^`,
//! `~`, `=`, `>=` or none) and is found in the lockfile's directory and in
//! the workspace members it lists by path or by a trailing `/*`: in
//! `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`, their
//! `[target.*]` forms and `[workspace.dependencies]`, written as
//! `name = "1.2"`, `name = { version = "1.2", … }` on one line, or a
//! `[dependencies.name]` table. A requirement with more than one part
//! (`>=1, <2`) is left alone.
//!
//! Private registries (`BUMP_REGISTRIES`) are written where the tools read
//! them, outside the clone, so they are never committed; credentials are
//! never printed:
//!
//! - `npm-registry`: a user npmrc (`NPM_CONFIG_USERCONFIG`, read by npm and
//!   pnpm) with the registry's `_authToken` or `_auth`, `registry=` when it
//!   replaces npm's and `@scope:registry=` for each scope. Yarn 2 and later
//!   is given only a registry that replaces npm's
//!   (`YARN_NPM_REGISTRY_SERVER` and its token or identity); its scopes are
//!   not configured.
//! - `cargo-registry`: a token (`token`, else `password`) as
//!   `CARGO_REGISTRIES_<NAME>_TOKEN` for each registry the project's
//!   `.cargo/config.toml` names with the same index; one that replaces
//!   crates.io is also given to every cargo run as source replacement
//!   (`cargo --config <file>`). A registry the project does not name and
//!   that replaces nothing is not reachable.
//! - `python-index`: `PIP_INDEX_URL` when it replaces PyPI, otherwise
//!   `PIP_EXTRA_INDEX_URL`, with the credentials in the URL; and
//!   `POETRY_HTTP_BASIC_<NAME>_USERNAME`/`_PASSWORD` for each source in
//!   `pyproject.toml` with the same URL.
//! - `goproxy-server`: `GOPROXY=<url>,https://proxy.golang.org,direct`
//!   (`<url>,direct` when it replaces the public proxy) and a netrc entry
//!   (`NETRC`) for its host. The checksum database is not changed, so a
//!   private module it does not know still fails to verify.
//!
//! Afterwards every lockfile is read again, and the update counts only if
//! none of them resolves a package below its version any more. When the
//! tool cannot get there (another package holds it back, or the strategy
//! does not allow the change it needs), the job fails saying it needs code
//! changes, with the tool's last lines.
//!
//! Configuration:
//!
//! - `GIT_REMOTE`, `GIT_BRANCH_BASE`: the repository and its default branch.
//! - `GIT_BRANCH`: the branch to push: under `g1t/security/` for a security
//!   update; for a version update, any name git takes but the default
//!   branch.
//! - `BUMP_KIND`: `security` (the default) or `version`.
//! - `BUMP_ECOSYSTEM` (OSV's name: `npm`, `crates.io`, `Go`, `PyPI`),
//!   `BUMP_PACKAGE`, `BUMP_VERSION`: what to raise, to what.
//! - `BUMP_PACKAGES`: several packages raised in one commit, as a JSON
//!   array of `{"package", "version"}`; `BUMP_PACKAGE` and `BUMP_VERSION`
//!   when absent or empty.
//! - `BUMP_STRATEGY`: a version update's versioning strategy, `increase`
//!   by default. A security update always updates as the first table says.
//! - `BUMP_FORCE`: `1` to replace the branch if it is there already.
//! - `BUMP_REGISTRIES`: private registries, as a JSON array of
//!   `{"type", "url", "username", "password", "token", "replacesBase",
//!   "scopes"}`.
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
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use g1t_scan::lockfiles::{Ecosystem, Lockfile};
use g1t_scan::version;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{WORKDIR, auth_option, env, git};

use crate::{AUTHOR_EMAIL, AUTHOR_NAME};
/// Every security update's branch starts with this:
/// `g1t_contracts::security::UPDATE_BRANCH_PREFIX`.
const BRANCH_PREFIX: &str = "g1t/security/";

/// Where the private registries' configuration is written: outside the
/// clone, so it is never committed.
const REGISTRY_DIR: &str = "/tmp/g1t-registries";

/// The most packages one update raises.
const MAX_PACKAGES: usize = 50;

/// Why a version update with the `lockfile-only` strategy stopped short.
const LOCKFILE_ONLY: &str = "needs a manifest change, which lockfile-only does not make";

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

/// A security update or a version update.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Security,
    Version,
}

impl Kind {
    fn parse(text: &str) -> Result<Kind> {
        match text.trim() {
            "" | "security" => Ok(Kind::Security),
            "version" => Ok(Kind::Version),
            other => bail!("g1t cannot make a {other} update"),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Kind::Security => "security",
            Kind::Version => "version",
        }
    }
}

/// How a version update changes a direct dependency's requirement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Strategy {
    /// Raise the requirement to the version.
    Increase,
    /// Only when what it allows is not enough.
    IncreaseIfNecessary,
    /// Allow the version as well as what it allowed.
    Widen,
    /// Never: only the lockfile changes.
    LockfileOnly,
}

impl Strategy {
    fn parse(text: &str) -> Result<Strategy> {
        Ok(match text.trim() {
            "" | "increase" => Strategy::Increase,
            "increase-if-necessary" => Strategy::IncreaseIfNecessary,
            "widen" => Strategy::Widen,
            "lockfile-only" => Strategy::LockfileOnly,
            other => bail!("{other} is not a versioning strategy"),
        })
    }
}

/// A package and the version to raise it to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Target {
    package: String,
    /// As the ecosystem's tools write it (Go's with `v`).
    version: String,
}

/// A private registry the tools may read: a `BUMP_REGISTRIES` entry.
#[derive(Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    /// `npm-registry`, `cargo-registry`, `python-index` or `goproxy-server`.
    #[serde(rename = "type")]
    kind: String,
    url: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    token: Option<String>,
    /// Used in place of the ecosystem's public registry.
    #[serde(default, alias = "replaces_base")]
    replaces_base: bool,
    /// npm scopes it serves: `@acme`.
    #[serde(default)]
    scopes: Vec<String>,
}

/// Never shows the credentials.
impl std::fmt::Debug for Registry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registry")
            .field("kind", &self.kind)
            .field("url", &self.url)
            .field("replaces_base", &self.replaces_base)
            .field("scopes", &self.scopes)
            .finish_non_exhaustive()
    }
}

impl Registry {
    /// The token, else the password: what a registry that takes one
    /// secret is given.
    fn secret(&self) -> Option<&str> {
        self.token.as_deref().or(self.password.as_deref()).filter(|secret| !secret.is_empty())
    }
}

/// What to raise, to what, where, and how.
#[derive(Debug)]
struct Bump {
    ecosystem: Ecosystem,
    kind: Kind,
    packages: Vec<Target>,
    /// A version update's strategy; none for a security update, which
    /// always updates as it did before strategies.
    strategy: Option<Strategy>,
    /// Replace the branch if it is there already.
    force: bool,
    registries: Vec<Registry>,
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
    /// these, and the `Cargo.toml` files a version update raises a
    /// requirement in, are committed, whatever else a tool leaves behind.
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

/// The packages to raise: `BUMP_PACKAGES`, or `BUMP_PACKAGE` and
/// `BUMP_VERSION` when it is absent or empty. Each is checked as a tool
/// argument, its version written as the tools take it, and a package named
/// twice is raised once.
fn targets(ecosystem: Ecosystem, listed: Option<&str>, package: Option<&str>, version: Option<&str>) -> Result<Vec<Target>> {
    let listed: Vec<Target> = match listed.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => serde_json::from_str(text).context("BUMP_PACKAGES is not a JSON array of packages and versions")?,
        None => Vec::new(),
    };
    let listed = if listed.is_empty() {
        vec![Target {
            package: package.ok_or_else(|| anyhow!("BUMP_PACKAGE is not set"))?.to_owned(),
            version: version.ok_or_else(|| anyhow!("BUMP_VERSION is not set"))?.to_owned(),
        }]
    } else {
        listed
    };
    if listed.len() > MAX_PACKAGES {
        bail!("an update raises at most {MAX_PACKAGES} packages");
    }
    let mut out: Vec<Target> = Vec::new();
    for target in listed {
        let target = Target { package: target.package.trim().to_owned(), version: tool_version(ecosystem, &target.version) };
        safe_argument("package", &target.package)?;
        safe_argument("version", &target.version)?;
        if !out.iter().any(|seen| ecosystem.normalize(&seen.package) == ecosystem.normalize(&target.package)) {
            out.push(target);
        }
    }
    Ok(out)
}

/// Whether git takes `branch` as a branch's name, short of a full ref.
/// Mirrors `isBranchName` in services/runner bump.ts.
fn branch_name_ok(branch: &str) -> bool {
    let bad = |c: char| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c);
    !branch.trim().is_empty()
        && branch.len() <= 200
        && !branch.chars().any(bad)
        && !branch.contains("..")
        && !branch.contains("@{")
        && !branch.starts_with('-')
        && !branch.starts_with('/')
        && !branch.starts_with("refs/")
        && !branch.ends_with('/')
        && !branch.ends_with(".lock")
}

/// Whether this kind of update may push to `branch`: a security update's
/// is under `g1t/security/`; a version update's is any name git takes but
/// `base`, the default branch.
fn check_branch(kind: Kind, branch: &str, base: &str) -> Result<()> {
    match kind {
        Kind::Security => {
            if !branch.starts_with(BRANCH_PREFIX) || branch.contains("..") || branch.chars().any(char::is_whitespace) {
                bail!("{branch} is not a security update's branch");
            }
        }
        Kind::Version => {
            if !branch_name_ok(branch) {
                bail!("{branch:?} is not a branch name git takes");
            }
            if branch == base.trim() {
                bail!("a version update cannot push to {base}, the default branch");
            }
        }
    }
    Ok(())
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

/// The range `widen` asks for: what `current` allowed, or the raised range.
fn widened_range(current: &str, version: &str) -> String {
    format!("{} || {}", current.trim(), raised_range(current, version))
}

/// How a direct JavaScript dependency is raised: first the update its
/// range allows, or not, then the range to ask for if still below, if any.
#[derive(Debug, PartialEq, Eq)]
struct DirectPlan {
    in_range_first: bool,
    range: Option<String>,
}

fn direct_plan(strategy: Option<Strategy>, current: &str, version: &str) -> DirectPlan {
    match strategy {
        None | Some(Strategy::Increase) => DirectPlan { in_range_first: false, range: Some(raised_range(current, version)) },
        Some(Strategy::IncreaseIfNecessary) => DirectPlan { in_range_first: true, range: Some(raised_range(current, version)) },
        Some(Strategy::Widen) => DirectPlan { in_range_first: true, range: Some(widened_range(current, version)) },
        Some(Strategy::LockfileOnly) => DirectPlan { in_range_first: true, range: None },
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

    /// Moves a direct dependency as far as its range allows, leaving the
    /// range in `package.json` as it is.
    fn in_range(self, package: &str) -> Vec<String> {
        match self {
            Node::Npm => self.command(&["update", "--package-lock-only", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", package]),
            Node::Pnpm => self.command(&["update", package, "--lockfile-only", "--no-save", "--ignore-scripts"]),
            Node::YarnBerry => self.command(&["up", "--recursive", package, "--mode=update-lockfile"]),
            Node::YarnClassic => self.command(&["upgrade", package, "--ignore-scripts", "--non-interactive"]),
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
/// allows, as far as the requirement does. `config` is a configuration
/// file every cargo run is given (a private registry's source replacement).
fn cargo_commands(package: &str, old: &str, version: &str, config: Option<&str>) -> [Vec<String>; 2] {
    let spec = format!("{package}@{old}");
    let cargo = || -> Vec<String> {
        let mut command = vec!["cargo".to_owned()];
        if let Some(config) = config {
            command.extend(["--config".to_owned(), config.to_owned()]);
        }
        command
    };
    let mut precise = cargo();
    precise.extend(["update", "-p", &spec, "--precise", version].map(str::to_owned));
    let mut compatible = cargo();
    compatible.extend(["update", "-p", &spec].map(str::to_owned));
    [precise, compatible]
}

/// A Cargo requirement raised to `version`, keeping its operator (`^`, `~`,
/// `=`, `>=` or none), or `None` when it is not a single requirement below
/// `version`.
fn raised_requirement(requirement: &str, version: &str) -> Option<String> {
    let requirement = requirement.trim();
    let (operator, rest) = [">=", "^", "~", "="]
        .iter()
        .find_map(|operator| requirement.strip_prefix(operator).map(|rest| (*operator, rest)))
        .unwrap_or(("", requirement));
    let rest = rest.trim();
    let plain = !rest.is_empty() && rest.starts_with(|c: char| c.is_ascii_digit()) && rest.chars().all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c));
    (plain && version::compare(rest, version).is_lt()).then(|| format!("{operator}{version}"))
}

/// The dotted keys of a TOML table header (`[target.'cfg(unix)'.dependencies]`),
/// unquoted; `None` for an array of tables or a line that is not a header.
fn header_keys(line: &str) -> Option<Vec<String>> {
    let code = line.trim_start();
    if code.starts_with("[[") || !code.starts_with('[') {
        return None;
    }
    let mut keys = Vec::new();
    let mut key = String::new();
    let mut quote: Option<char> = None;
    for c in code[1..].chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => key.push(c),
            (None, '"' | '\'') => quote = Some(c),
            (None, '.') => keys.push(std::mem::take(&mut key).trim().to_owned()),
            (None, ']') => {
                keys.push(key.trim().to_owned());
                return Some(keys);
            }
            (None, c) => key.push(c),
        }
    }
    None
}

/// What a table header is to dependencies: `Some(None)` for a table of
/// them (`[dependencies]`, `[workspace.dependencies]`,
/// `[target.<cfg>.dev-dependencies]` …), `Some(Some(name))` for one
/// dependency's own table (`[dependencies.serde]`), `None` for anything else.
fn dependency_table(keys: &[String]) -> Option<Option<String>> {
    let tables = ["dependencies", "dev-dependencies", "build-dependencies"];
    let rest = match keys {
        [first, rest @ ..] if tables.contains(&first.as_str()) => rest,
        [workspace, dependencies, rest @ ..] if workspace == "workspace" && dependencies == "dependencies" => rest,
        [target, _, table, rest @ ..] if target == "target" && tables.contains(&table.as_str()) => rest,
        _ => return None,
    };
    match rest {
        [] => Some(None),
        [name] => Some(Some(name.clone())),
        _ => None,
    }
}

/// Where the value of `key` starts in a one-line TOML `line`: just after
/// its `=`, if `key` is a bare key there (first, or after `{` or `,`).
fn value_after(line: &str, key: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(at) = line[from..].find(key).map(|at| from + at) {
        let before = line[..at].trim_end();
        let after = line[at + key.len()..].trim_start();
        let bare_key = before.is_empty() || before.ends_with('{') || before.ends_with(',');
        if bare_key && after.starts_with('=') {
            let equals = line.len() - after.len();
            return Some(equals + 1);
        }
        from = at + key.len();
    }
    None
}

/// `line` with the first quoted `old` from `from` on replaced by `new`.
fn replace_quoted(line: &str, from: usize, old: &str, new: &str) -> Option<String> {
    ['"', '\''].iter().find_map(|quote| {
        let quoted = format!("{quote}{old}{quote}");
        let at = from + line[from..].find(&quoted)?;
        Some(format!("{}{quote}{new}{quote}{}", &line[..at], &line[at + quoted.len()..]))
    })
}

/// One `key = value` line of a dependency table, rewritten when it asks
/// for `package` with a requirement below `version`.
fn rewrite_dependency_line(line: &str, package: &str, version: &str) -> Option<String> {
    let table: toml::Table = toml::from_str(line).ok()?;
    let (key, value) = table.iter().next()?;
    let (name, requirement, anchor) = match value {
        toml::Value::String(requirement) => (key.as_str(), requirement.as_str(), line.find('=')? + 1),
        toml::Value::Table(inline) => {
            let name = inline.get("package").and_then(toml::Value::as_str).unwrap_or(key);
            let requirement = inline.get("version").and_then(toml::Value::as_str)?;
            (name, requirement, value_after(line, "version")?)
        }
        _ => return None,
    };
    if name != package {
        return None;
    }
    replace_quoted(line, anchor, requirement, &raised_requirement(requirement, version)?)
}

/// A `Cargo.toml` with every requirement on `package` below `version`
/// raised to it, keeping its operator, and nothing else changed. Returns
/// the text and how many requirements moved.
fn rewrite_cargo_requirements(text: &str, package: &str, version: &str) -> (String, usize) {
    // Each section: its header's meaning to dependencies, and its lines.
    let mut sections: Vec<(Option<Option<String>>, Vec<String>)> = vec![(None, Vec::new())];
    for line in text.split_inclusive('\n') {
        if let Some(keys) = header_keys(line) {
            sections.push((dependency_table(&keys), Vec::new()));
        } else if line.trim_start().starts_with("[[") {
            sections.push((None, Vec::new()));
        }
        sections.last_mut().expect("a section").1.push(line.to_owned());
    }
    let mut moved = 0;
    let mut out = String::with_capacity(text.len() + 8);
    for (table, mut lines) in sections {
        match table {
            Some(None) => {
                for line in lines.iter_mut().skip(1) {
                    if let Some(rewritten) = rewrite_dependency_line(line, package, version) {
                        *line = rewritten;
                        moved += 1;
                    }
                }
            }
            Some(Some(key)) => {
                let field = |name: &str| {
                    lines.iter().enumerate().skip(1).find_map(|(at, line)| {
                        let table: toml::Table = toml::from_str(line).ok()?;
                        Some((at, table.get(name)?.as_str()?.to_owned()))
                    })
                };
                let name = field("package").map_or(key, |(_, name)| name);
                if let (true, Some((at, requirement))) = (name == package, field("version")) {
                    let rewritten = raised_requirement(&requirement, version).and_then(|raised| {
                        let line = &lines[at];
                        replace_quoted(line, line.find('=')? + 1, &requirement, &raised)
                    });
                    if let Some(rewritten) = rewritten {
                        lines[at] = rewritten;
                        moved += 1;
                    }
                }
            }
            None => {}
        }
        lines.iter().for_each(|line| out.push_str(line));
    }
    (out, moved)
}

/// The workspace members a root `Cargo.toml` lists, as written: paths, and
/// paths ending in `/*`. Other globs and paths outside it are left out.
fn workspace_members(root: &toml::Value) -> Vec<String> {
    let Some(members) = root.get("workspace").and_then(|workspace| workspace.get("members")).and_then(toml::Value::as_array) else {
        return Vec::new();
    };
    members
        .iter()
        .filter_map(toml::Value::as_str)
        .map(|member| member.trim().trim_start_matches("./").trim_end_matches('/').to_owned())
        .filter(|member| {
            let globbed = member.strip_suffix("/*").unwrap_or(member);
            !member.is_empty() && !globbed.contains(['*', '?', '[']) && !member.starts_with('/') && !member.split('/').any(|part| part == "..")
        })
        .collect()
}

/// The `Cargo.toml` files of a Cargo job, from the repository's root: its
/// directory's and its workspace members'.
fn cargo_manifests(workdir: &Path, job: &Job) -> Vec<String> {
    let root = job.file("Cargo.toml");
    let mut found = vec![root.clone()];
    let Ok(text) = std::fs::read_to_string(workdir.join(&root)) else {
        return found;
    };
    let Ok(parsed) = toml::from_str::<toml::Value>(&text) else {
        return found;
    };
    for member in workspace_members(&parsed) {
        let dirs: Vec<String> = match member.strip_suffix("/*") {
            Some(parent) => {
                let parent = job.file(parent);
                let mut names: Vec<String> = std::fs::read_dir(workdir.join(&parent))
                    .map(|entries| {
                        entries
                            .filter_map(|entry| entry.ok())
                            .filter(|entry| entry.path().is_dir())
                            .filter_map(|entry| entry.file_name().into_string().ok())
                            .map(|name| format!("{parent}/{name}"))
                            .collect()
                    })
                    .unwrap_or_default();
                names.sort();
                names
            }
            None => vec![job.file(&member)],
        };
        for dir in dirs {
            let manifest = format!("{dir}/Cargo.toml");
            if workdir.join(&manifest).is_file() && !found.contains(&manifest) {
                found.push(manifest);
            }
        }
    }
    found
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

/// The registries a project names itself, so their credentials can be
/// given under its names: Cargo's `[registries.<name>] index` and Poetry's
/// `[[tool.poetry.source]]`, each as (name, URL).
#[derive(Debug, Default, PartialEq, Eq)]
struct Named {
    cargo: Vec<(String, String)>,
    poetry: Vec<(String, String)>,
}

/// `[registries.<name>] index = "…"` in a `.cargo/config.toml`.
fn cargo_registries(config: &str) -> Vec<(String, String)> {
    let Ok(config) = toml::from_str::<toml::Value>(config) else {
        return Vec::new();
    };
    let Some(registries) = config.get("registries").and_then(toml::Value::as_table) else {
        return Vec::new();
    };
    registries
        .iter()
        .filter_map(|(name, registry)| Some((name.clone(), registry.get("index")?.as_str()?.to_owned())))
        .collect()
}

/// `[[tool.poetry.source]]` names and URLs in a `pyproject.toml`.
fn poetry_sources(pyproject: &str) -> Vec<(String, String)> {
    let Ok(pyproject) = toml::from_str::<toml::Value>(pyproject) else {
        return Vec::new();
    };
    let Some(sources) = pyproject.get("tool").and_then(|tool| tool.get("poetry")).and_then(|poetry| poetry.get("source")).and_then(toml::Value::as_array) else {
        return Vec::new();
    };
    sources
        .iter()
        .filter_map(|source| Some((source.get("name")?.as_str()?.to_owned(), source.get("url")?.as_str()?.to_owned())))
        .collect()
}

/// A registry URL as compared with another: no index protocol, scheme or
/// host case, or trailing slashes.
fn same_registry(a: &str, b: &str) -> bool {
    let plain = |url: &str| -> String {
        let url = url.trim();
        let url = url.strip_prefix("sparse+").or_else(|| url.strip_prefix("registry+")).unwrap_or(url);
        url.trim_end_matches('/').trim_end_matches(".git").to_ascii_lowercase()
    };
    plain(a) == plain(b)
}

/// A name as an environment variable's part: upper case, with `-` and `.`
/// as `_`.
fn env_part(name: &str) -> String {
    name.to_ascii_uppercase().replace(['-', '.'], "_")
}

/// Percent-encodes a URL's user or password.
fn percent_encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// `https://host/path` as npm keys its credentials: `//host/path/`.
fn npm_nerf_dart(url: &str) -> String {
    let rest = url.trim().strip_prefix("https://").unwrap_or(url);
    let rest = rest.trim_end_matches('/');
    format!("//{rest}/")
}

/// A registry URL's host, for a netrc entry.
fn url_host(url: &str) -> &str {
    let rest = url.trim().strip_prefix("https://").unwrap_or(url);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    host.rsplit('@').next().unwrap_or(host).split(':').next().unwrap_or(host)
}

/// Checks one registry before anything is written: a kind this can
/// configure, an `https://` URL and text that cannot break out of a
/// configuration line.
fn check_registry(registry: &Registry) -> Result<()> {
    let kinds = ["npm-registry", "cargo-registry", "python-index", "goproxy-server"];
    if !kinds.contains(&registry.kind.as_str()) {
        bail!("g1t cannot read a {} registry", registry.kind);
    }
    let url = registry.url.trim();
    if !url.starts_with("https://") || url_host(url).is_empty() || url.chars().any(|c| c.is_whitespace() || c.is_control() || c == ',') {
        bail!("a private registry's URL must start with https://, without spaces or commas");
    }
    let secrets = [&registry.username, &registry.password, &registry.token];
    if secrets.iter().filter_map(|secret| secret.as_deref()).any(|secret| secret.chars().any(|c| c.is_control())) {
        bail!("a private registry's credentials must not hold control characters ({url})");
    }
    if registry.kind == "goproxy-server" && secrets.iter().filter_map(|secret| secret.as_deref()).any(|secret| secret.chars().any(char::is_whitespace)) {
        bail!("a Go proxy's credentials must not hold spaces ({url})");
    }
    if let Some(scope) = registry.scopes.iter().find(|scope| !scope.starts_with('@') || scope.len() < 2 || !scope[1..].chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))) {
        bail!("{scope:?} is not an npm scope");
    }
    Ok(())
}

/// What the tools are given to read private registries: variables for
/// every run, files written outside the clone, and a configuration file
/// every cargo run is given.
#[derive(Default)]
struct Tools {
    env: Vec<(String, String)>,
    files: Vec<(PathBuf, String)>,
    cargo_config: Option<String>,
}

impl Tools {
    fn set(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.env.push((name.into(), value.into()));
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.env.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    /// Writes the files, readable by their owner only.
    fn write(&self) -> Result<()> {
        for (path, text) in &self.files {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).with_context(|| format!("could not create {}", parent.display()))?;
            }
            std::fs::write(path, text).with_context(|| format!("could not write {}", path.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            }
        }
        Ok(())
    }
}

/// The configuration that lets the tools read `registries`, with files
/// under `dir`. `named` are the registries the project names itself.
fn registry_tools(registries: &[Registry], named: &Named, dir: &Path) -> Result<Tools> {
    let mut tools = Tools::default();
    let mut npmrc = String::new();
    let mut extra_indexes: Vec<String> = Vec::new();
    let mut proxies: Vec<String> = Vec::new();
    let mut proxy_replaced = false;
    let mut netrc = String::new();
    let mut cargo_config: Option<toml::Table> = None;
    for registry in registries {
        check_registry(registry)?;
        let url = registry.url.trim();
        match registry.kind.as_str() {
            "npm-registry" => {
                let nerf = npm_nerf_dart(url);
                let auth = match (registry.token.as_deref(), registry.username.as_deref(), registry.password.as_deref()) {
                    (Some(token), _, _) if !token.is_empty() => Some(("_authToken", token.to_owned(), "YARN_NPM_AUTH_TOKEN", token.to_owned())),
                    (_, Some(user), Some(password)) => {
                        let ident = format!("{user}:{password}");
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&ident);
                        Some(("_auth", encoded, "YARN_NPM_AUTH_IDENT", ident))
                    }
                    _ => None,
                };
                if let Some((key, value, _, _)) = &auth {
                    npmrc.push_str(&format!("{nerf}:{key}={value}\n"));
                }
                if registry.replaces_base {
                    npmrc.push_str(&format!("registry={url}\n"));
                    if tools.get("YARN_NPM_REGISTRY_SERVER").is_none() {
                        tools.set("YARN_NPM_REGISTRY_SERVER", url);
                        if let Some((_, _, name, value)) = auth {
                            tools.set(name, value);
                            tools.set("YARN_NPM_ALWAYS_AUTH", "true");
                        }
                    }
                }
                for scope in &registry.scopes {
                    npmrc.push_str(&format!("{scope}:registry={url}\n"));
                }
            }
            "cargo-registry" => {
                let secret = registry.secret();
                for (name, _) in named.cargo.iter().filter(|(_, index)| same_registry(index, url)) {
                    if let Some(secret) = secret {
                        tools.set(format!("CARGO_REGISTRIES_{}_TOKEN", env_part(name)), secret);
                    }
                }
                if registry.replaces_base && cargo_config.is_none() {
                    let index = if url.ends_with(".git") { url.to_owned() } else { format!("sparse+{}/", url.trim_end_matches('/')) };
                    let table = |pairs: &[(&str, toml::Value)]| -> toml::Value {
                        toml::Value::Table(pairs.iter().map(|(key, value)| (key.to_string(), value.clone())).collect())
                    };
                    let text = |text: &str| toml::Value::String(text.to_owned());
                    let mut config = toml::Table::new();
                    config.insert(
                        "source".into(),
                        table(&[
                            ("crates-io", table(&[("replace-with", text("g1t-private"))])),
                            ("g1t-private", table(&[("registry", text(&index))])),
                        ]),
                    );
                    config.insert("registries".into(), table(&[("g1t-private", table(&[("index", text(&index))]))]));
                    cargo_config = Some(config);
                    if let Some(secret) = secret {
                        tools.set("CARGO_REGISTRIES_G1T_PRIVATE_TOKEN", secret);
                    }
                }
            }
            "python-index" => {
                let user = registry.username.as_deref().filter(|user| !user.is_empty());
                let password = registry.password.as_deref().or(registry.token.as_deref()).filter(|password| !password.is_empty());
                let with_auth = match (user, password) {
                    (user, Some(password)) => {
                        let rest = url.strip_prefix("https://").unwrap_or(url);
                        format!("https://{}:{}@{rest}", percent_encode(user.unwrap_or("__token__")), percent_encode(password))
                    }
                    (Some(user), None) => format!("https://{}@{}", percent_encode(user), url.strip_prefix("https://").unwrap_or(url)),
                    (None, None) => url.to_owned(),
                };
                if registry.replaces_base && tools.get("PIP_INDEX_URL").is_none() {
                    tools.set("PIP_INDEX_URL", with_auth);
                } else {
                    extra_indexes.push(with_auth);
                }
                for (name, _) in named.poetry.iter().filter(|(_, source)| same_registry(source, url)) {
                    if let Some(password) = password {
                        tools.set(format!("POETRY_HTTP_BASIC_{}_USERNAME", env_part(name)), user.unwrap_or("__token__"));
                        tools.set(format!("POETRY_HTTP_BASIC_{}_PASSWORD", env_part(name)), password);
                    }
                }
            }
            "goproxy-server" => {
                proxies.push(url.to_owned());
                proxy_replaced |= registry.replaces_base;
                if let Some(secret) = registry.secret() {
                    let login = registry.username.as_deref().filter(|user| !user.is_empty()).unwrap_or("g1t");
                    netrc.push_str(&format!("machine {}\nlogin {login}\npassword {secret}\n", url_host(url)));
                }
            }
            _ => unreachable!("checked above"),
        }
    }
    if !npmrc.is_empty() {
        let path = dir.join("npmrc");
        tools.set("NPM_CONFIG_USERCONFIG", path.display().to_string());
        tools.files.push((path, npmrc));
    }
    if !extra_indexes.is_empty() {
        tools.set("PIP_EXTRA_INDEX_URL", extra_indexes.join(" "));
    }
    if !proxies.is_empty() {
        let tail = if proxy_replaced { "direct" } else { "https://proxy.golang.org,direct" };
        tools.set("GOPROXY", format!("{},{tail}", proxies.join(",")));
    }
    if !netrc.is_empty() {
        let path = dir.join("netrc");
        tools.set("NETRC", path.display().to_string());
        tools.files.push((path, netrc));
    }
    if let Some(config) = cargo_config {
        let path = dir.join("cargo.toml");
        tools.cargo_config = Some(path.display().to_string());
        tools.files.push((path, toml::to_string(&config)?));
    }
    Ok(tools)
}

/// The registries the clone names itself: Cargo's in `.cargo/config.toml`
/// at the root and in each job's directory, Poetry's in each
/// `pyproject.toml` updated.
fn named_registries(workdir: &Path, jobs: &[Job]) -> Named {
    let mut named = Named::default();
    let mut dirs: Vec<&str> = vec![""];
    dirs.extend(jobs.iter().map(|job| job.dir.as_str()));
    dirs.dedup();
    for dir in dirs {
        for name in [".cargo/config.toml", ".cargo/config"] {
            if let Ok(text) = std::fs::read_to_string(workdir.join(dir).join(name)) {
                named.cargo.extend(cargo_registries(&text));
            }
        }
    }
    for job in jobs.iter().filter(|job| job.lockfile == Lockfile::PoetryLock) {
        if let Ok(text) = std::fs::read_to_string(workdir.join(job.file("pyproject.toml"))) {
            named.poetry.extend(poetry_sources(&text));
        }
    }
    named
}

/// Runs a tool in `dir` with `extra` variables and returns what it said,
/// failing with the last lines of its output. A tool that is not installed
/// is unsupported. The variables are never printed.
fn run(dir: &Path, command: &[String], extra: &[(String, String)]) -> Result<String> {
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
        .envs(extra.iter().map(|(name, value)| (name, value)))
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

/// Poetry, installed into a virtual environment from PyPI (or the index
/// that replaces it) when the sandbox has none.
fn poetry(extra: &[(String, String)]) -> Result<Vec<String>> {
    if Command::new("poetry").arg("--version").output().is_ok_and(|output| output.status.success()) {
        return Ok(vec!["poetry".to_owned()]);
    }
    let venv = "/tmp/g1t-poetry";
    let here = Path::new("/");
    run(here, &["python3", "-m", "venv", venv].map(str::to_owned), extra)?;
    run(here, &[format!("{venv}/bin/pip"), "install".into(), "--quiet".into(), "poetry".into()], extra)?;
    Ok(vec![format!("{venv}/bin/poetry")])
}

/// What one update of one job did: what the tools said when they failed,
/// and the files other than the job's own it changed.
#[derive(Default)]
struct Outcome {
    said: Vec<String>,
    files: Vec<String>,
}

impl Bump {
    fn from_env() -> Result<Bump> {
        let optional = |name: &str| std::env::var(name).ok();
        let ecosystem_name = env("BUMP_ECOSYSTEM")?;
        let ecosystem = Ecosystem::parse(ecosystem_name.trim())
            .ok_or_else(|| unsupported(format!("g1t cannot update {ecosystem_name} dependencies")))?;
        let kind = Kind::parse(&optional("BUMP_KIND").unwrap_or_default())?;
        let packages = targets(
            ecosystem,
            optional("BUMP_PACKAGES").as_deref(),
            optional("BUMP_PACKAGE").as_deref(),
            optional("BUMP_VERSION").as_deref(),
        )?;
        let strategy = Strategy::parse(&optional("BUMP_STRATEGY").unwrap_or_default())?;
        let force = matches!(optional("BUMP_FORCE").as_deref().map(str::trim), Some("1" | "true"));
        let registries: Vec<Registry> = match optional("BUMP_REGISTRIES").as_deref().map(str::trim).filter(|text| !text.is_empty()) {
            Some(text) => serde_json::from_str(text).context("BUMP_REGISTRIES is not a JSON array of registries")?,
            None => Vec::new(),
        };
        registries.iter().try_for_each(check_registry)?;
        let jobs = jobs(ecosystem, &lockfile_list(&env("BUMP_LOCKFILES")?)?)?;
        Ok(Bump {
            ecosystem,
            kind,
            packages,
            strategy: (kind == Kind::Version).then_some(strategy),
            force,
            registries,
            jobs,
        })
    }

    /// The versions every lockfile of `job` still resolves below the target.
    fn still_below(&self, workdir: &Path, job: &Job, target: &Target) -> Result<Vec<String>> {
        let mut found = BTreeSet::new();
        for path in &job.paths {
            let lockfile = Lockfile::for_path(path).unwrap_or(job.lockfile);
            let file = workdir.join(path);
            if !file.exists() {
                bail!("{path} is not in the repository's default branch");
            }
            found.extend(below(lockfile, &read(&file)?, self.ecosystem, &target.package, &target.version));
        }
        Ok(found.into_iter().collect())
    }

    /// Runs the tool for one job and one package. Errors from the tool are
    /// kept for the reason, should the lockfile still be behind afterwards.
    fn update(&self, workdir: &Path, job: &Job, target: &Target, tools: &Tools) -> Result<Outcome> {
        let dir = workdir.join(&job.dir);
        let (package, version) = (target.package.as_str(), target.version.as_str());
        let mut outcome = Outcome::default();
        let attempt = |command: Vec<String>, said: &mut Vec<String>| -> Result<bool> {
            match run(&dir, &command, &tools.env) {
                Ok(_) => Ok(true),
                Err(error) if error.downcast_ref::<Stop>().is_some() => Err(error),
                Err(error) => {
                    said.push(format!("{error:#}"));
                    Ok(false)
                }
            }
        };
        let said = &mut outcome.said;
        match job.lockfile {
            Lockfile::PackageLock | Lockfile::PnpmLock | Lockfile::YarnLock => {
                let lock = read(&workdir.join(&job.paths[0]))?;
                let node = Node::of(job.lockfile, &lock).ok_or_else(|| anyhow!("not a JavaScript lockfile"))?;
                let manifest_path = dir.join("package.json");
                let mut manifest: Value = serde_json::from_str(&read(&manifest_path)?).context("package.json is not JSON")?;
                match direct_range(&manifest, package) {
                    Some(range) => {
                        let plan = direct_plan(self.strategy, &range, version);
                        if plan.in_range_first {
                            attempt(node.in_range(package), said)?;
                        }
                        if !plan.in_range_first || !self.still_below(workdir, job, target)?.is_empty() {
                            match plan.range {
                                Some(range) => {
                                    attempt(node.direct(package, &range), said)?;
                                }
                                None => said.push(format!("{package} {LOCKFILE_ONLY}")),
                            }
                        }
                    }
                    None => {
                        if let Some(command) = node.transitive(package) {
                            attempt(command, said)?;
                        }
                        // Held back by what asks for it: a security update
                        // forces the version; a version update never does.
                        if self.kind == Kind::Security && !self.still_below(workdir, job, target)?.is_empty() {
                            manifest = serde_json::from_str(&read(&manifest_path)?).context("package.json is not JSON")?;
                            if add_override(&mut manifest, node.override_path(), package, version)? {
                                let indent = if read(&manifest_path)?.contains("\n    \"") { "    " } else { "  " };
                                write_json(&manifest_path, &manifest, indent)?;
                            }
                            attempt(node.relock(), said)?;
                        }
                    }
                }
            }
            Lockfile::CargoLock => {
                let config = tools.cargo_config.as_deref();
                let raise = matches!(self.strategy, Some(Strategy::Increase | Strategy::IncreaseIfNecessary | Strategy::Widen));
                for old in self.still_below(workdir, job, target)? {
                    let [precise, compatible] = cargo_commands(package, &old, version, config);
                    if attempt(precise.clone(), said)? {
                        continue;
                    }
                    // The requirement does not allow it: raise it, then try again.
                    if raise {
                        let mut raised = 0;
                        for manifest in cargo_manifests(workdir, job) {
                            let file = workdir.join(&manifest);
                            let (text, moved) = rewrite_cargo_requirements(&read(&file)?, package, version);
                            if moved > 0 {
                                std::fs::write(&file, text).with_context(|| format!("could not write {manifest}"))?;
                                outcome.files.push(manifest);
                                raised += moved;
                            }
                        }
                        if raised > 0 && attempt(precise, said)? {
                            continue;
                        }
                    }
                    attempt(compatible, said)?;
                }
            }
            Lockfile::GoMod | Lockfile::GoSum => {
                for command in go_commands(package, version) {
                    if !attempt(command, said)? {
                        break;
                    }
                }
            }
            Lockfile::PoetryLock => {
                let group = if self.strategy == Some(Strategy::LockfileOnly) {
                    None
                } else {
                    let pyproject: toml::Value = toml::from_str(&read(&dir.join("pyproject.toml"))?).context("pyproject.toml is not TOML")?;
                    poetry_group(&pyproject, package)
                };
                attempt(poetry_commands(&poetry(&tools.env)?, package, version, group), said)?;
            }
            Lockfile::Requirements => {
                for path in &job.paths {
                    let file = workdir.join(path);
                    let text = read(&file)?;
                    if text.contains("--hash") {
                        return Err(unsupported(format!("{path} pins hashes, which need its compiler to update")));
                    }
                    let (rewritten, moved) = rewrite_pins(&text, package, version);
                    if moved > 0 {
                        std::fs::write(&file, rewritten).with_context(|| format!("could not write {path}"))?;
                    }
                }
            }
        }
        Ok(outcome)
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

/// The packages as a reason names them: `lodash 4.17.21, vitest 1.6.0`.
fn package_list(packages: &[Target]) -> String {
    packages.iter().map(|target| format!("{} {}", target.package, target.version)).collect::<Vec<_>>().join(", ")
}

fn bump() -> Result<(Bump, String, Pushed)> {
    let bump = Bump::from_env()?;
    let remote = env("GIT_REMOTE")?;
    let base = env("GIT_BRANCH_BASE")?;
    let branch = env("GIT_BRANCH")?;
    check_branch(bump.kind, &branch, &base)?;
    let message = env("COMMIT_MESSAGE").unwrap_or_else(|_| match bump.packages.as_slice() {
        [only] => format!("Update {} to {}", only.package, only.version),
        [first, rest @ ..] => format!("Update {} and {} more", first.package, rest.len()),
        [] => "Update dependencies".to_owned(),
    });
    let auth = auth_option(&env("G1T_USER")?, &env("G1T_TOKEN")?);
    let workdir = Path::new(WORKDIR);

    std::fs::create_dir_all("/work")?;
    crate::clone::clone(Path::new("/work"), &auth, &["--branch", &base], &remote, WORKDIR)
        .with_context(|| format!("could not clone {base}"))?;
    git(workdir, &["checkout", "--quiet", "-b", &branch])?;
    git(workdir, &["config", "user.name", AUTHOR_NAME])?;
    git(workdir, &["config", "user.email", AUTHOR_EMAIL])?;

    let tools = registry_tools(&bump.registries, &named_registries(workdir, &bump.jobs), Path::new(REGISTRY_DIR))?;
    tools.write()?;

    let mut behind = Vec::new();
    let mut changed: Vec<String> = Vec::new();
    for target in &bump.packages {
        for job in &bump.jobs {
            if bump.still_below(workdir, job, target)?.is_empty() {
                continue; // Already at the version or later here.
            }
            let outcome = bump.update(workdir, job, target, &tools)?;
            changed.extend(outcome.files);
            let left = bump.still_below(workdir, job, target)?;
            if !left.is_empty() {
                let why = outcome.said.last().map(|said| format!("\n{said}")).unwrap_or_default();
                behind.push(format!(
                    "{} still resolves {} {} (wanted {} or later){why}",
                    job.paths.join(", "),
                    target.package,
                    left.join(", "),
                    target.version
                ));
            }
        }
    }
    if !behind.is_empty() {
        return Err(needs_changes(behind.join("\n\n")));
    }

    let mut touched: Vec<String> = bump.jobs.iter().flat_map(Job::touched).chain(changed).collect();
    touched.sort();
    touched.dedup();
    touched.retain(|path| workdir.join(path).exists());
    let mut add = vec!["add", "--"];
    add.extend(touched.iter().map(String::as_str));
    git(workdir, &add)?;
    if git(workdir, &["diff", "--cached", "--name-only"])?.is_empty() {
        bail!(
            "nothing to change: {} already resolves {} or later",
            bump.jobs.iter().flat_map(|job| job.paths.iter().map(String::as_str)).collect::<Vec<_>>().join(", "),
            package_list(&bump.packages)
        );
    }
    git(workdir, &["commit", "--quiet", "--message", &message])?;
    let commit = git(workdir, &["rev-parse", "HEAD"])?;
    let refspec = format!("{}HEAD:refs/heads/{branch}", if bump.force { "+" } else { "" });
    let pushed = git(workdir, &["-c", &auth, "push", "--quiet", "origin", &refspec]);
    if let Err(error) = pushed {
        if bump.force {
            return Err(error.context("could not push the update"));
        }
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
            let first = &bump.packages[0];
            println!(
                "{}",
                json!({
                    "bump": if pushed.existed { "exists" } else { "pushed" },
                    "kind": bump.kind.name(),
                    "branch": branch,
                    "commit": pushed.commit,
                    "ecosystem": bump.ecosystem.osv(),
                    "package": first.package,
                    "version": first.version,
                    "packages": bump.packages,
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

    fn target(package: &str, version: &str) -> Target {
        Target { package: package.into(), version: version.into() }
    }

    #[test]
    fn lockfiles_come_as_lines_or_json() {
        assert_eq!(lockfile_list("Cargo.lock\n web/package-lock.json \n\n").unwrap(), ["Cargo.lock", "web/package-lock.json"]);
        assert_eq!(lockfile_list(r#"["./go.mod","go.sum"]"#).unwrap(), ["go.mod", "go.sum"]);
        assert!(lockfile_list("[not json").is_err());
    }

    #[test]
    fn packages_come_as_a_list_or_one() {
        // A security update's one package, as before.
        assert_eq!(targets(Ecosystem::Npm, None, Some(" lodash "), Some("v4.17.21")).unwrap(), [target("lodash", "4.17.21")]);
        assert_eq!(targets(Ecosystem::Npm, Some("[]"), Some("lodash"), Some("4.17.21")).unwrap(), [target("lodash", "4.17.21")]);
        assert!(targets(Ecosystem::Npm, None, None, Some("1.0.0")).is_err());
        // A group, each version as the tool takes it, a package once.
        let listed = r#"[{"package":"golang.org/x/net","version":"0.23.0"},{"package":"golang.org/x/text","version":"v0.14.0"},{"package":"golang.org/x/net","version":"0.24.0"}]"#;
        assert_eq!(
            targets(Ecosystem::Go, Some(listed), Some("ignored"), Some("1")).unwrap(),
            [target("golang.org/x/net", "v0.23.0"), target("golang.org/x/text", "v0.14.0")]
        );
        assert!(targets(Ecosystem::Npm, Some(r#"[{"package":"--registry=evil","version":"1"}]"#), None, None).is_err());
        assert!(targets(Ecosystem::Npm, Some(r#"[{"package":"a","version":"1;rm"}]"#), None, None).is_err());
        assert!(targets(Ecosystem::Npm, Some("{"), None, None).is_err());
        let many = format!("[{}]", (0..51).map(|i| format!(r#"{{"package":"p{i}","version":"1.0.0"}}"#)).collect::<Vec<_>>().join(","));
        assert!(targets(Ecosystem::Npm, Some(&many), None, None).is_err());
    }

    #[test]
    fn kinds_and_strategies_by_name() {
        assert_eq!(Kind::parse("").unwrap(), Kind::Security);
        assert_eq!(Kind::parse("security").unwrap(), Kind::Security);
        assert_eq!(Kind::parse("version").unwrap(), Kind::Version);
        assert!(Kind::parse("major").is_err());
        assert_eq!(Strategy::parse("").unwrap(), Strategy::Increase);
        assert_eq!(Strategy::parse("increase-if-necessary").unwrap(), Strategy::IncreaseIfNecessary);
        assert_eq!(Strategy::parse("widen").unwrap(), Strategy::Widen);
        assert_eq!(Strategy::parse("lockfile-only").unwrap(), Strategy::LockfileOnly);
        assert!(Strategy::parse("auto").is_err());
    }

    #[test]
    fn branches_by_kind() {
        assert!(check_branch(Kind::Security, "g1t/security/lodash-4.17.21", "main").is_ok());
        for branch in ["main", "deps/lodash", "g1t/security/a..b", "g1t/security/a b"] {
            assert!(check_branch(Kind::Security, branch, "main").is_err(), "{branch}");
        }
        for branch in ["deps/npm/lodash", "dependabot/cargo/serde-1.0.200", "g1t/security/x", "develop"] {
            assert!(check_branch(Kind::Version, branch, "main").is_ok(), "{branch}");
        }
        assert!(check_branch(Kind::Version, "main", "main").is_err());
        let long = "x".repeat(201);
        for branch in ["", " ", "a b", "a..b", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "a@{1}", "-x", "/x", "refs/heads/x", "x/", "x.lock", "a\u{7}", long.as_str()] {
            assert!(check_branch(Kind::Version, branch, "main").is_err(), "{branch:?}");
        }
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
    fn widen_keeps_what_was_allowed() {
        assert_eq!(widened_range("^1.2.0", "2.0.0"), "^1.2.0 || ^2.0.0");
        assert_eq!(widened_range(" ~1.2.0 ", "1.3.0"), "~1.2.0 || ~1.3.0");
        assert_eq!(widened_range("1.2.0", "2.0.0"), "1.2.0 || 2.0.0");
        assert_eq!(widened_range("^1.0.0 || ^2.0.0", "3.1.0"), "^1.0.0 || ^2.0.0 || ^3.1.0");
    }

    #[test]
    fn strategies_plan_a_direct_javascript_dependency() {
        let raised = |in_range_first, range: &str| DirectPlan { in_range_first, range: Some(range.to_owned()) };
        // A security update, and increase: the range raised, at once.
        assert_eq!(direct_plan(None, "^1.2.0", "2.0.0"), raised(false, "^2.0.0"));
        assert_eq!(direct_plan(Some(Strategy::Increase), "~1.2.0", "1.3.0"), raised(false, "~1.3.0"));
        // The others first take what the range allows.
        assert_eq!(direct_plan(Some(Strategy::IncreaseIfNecessary), "^1.2.0", "2.0.0"), raised(true, "^2.0.0"));
        assert_eq!(direct_plan(Some(Strategy::Widen), "^1.2.0", "2.0.0"), raised(true, "^1.2.0 || ^2.0.0"));
        assert_eq!(direct_plan(Some(Strategy::LockfileOnly), "^1.2.0", "2.0.0"), DirectPlan { in_range_first: true, range: None });
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
        assert_eq!(
            npm.in_range("lodash"),
            strings(&["npm", "update", "--package-lock-only", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "lodash"])
        );
        assert_eq!(npm.override_path(), ["overrides"]);

        let pnpm = Node::of(Lockfile::PnpmLock, "lockfileVersion: '9.0'").unwrap();
        assert_eq!(pnpm.direct("lodash", "^4.17.21"), strings(&["corepack", "pnpm", "update", "lodash@^4.17.21", "--lockfile-only", "--ignore-scripts"]));
        assert_eq!(pnpm.in_range("lodash"), strings(&["corepack", "pnpm", "update", "lodash", "--lockfile-only", "--no-save", "--ignore-scripts"]));
        assert_eq!(pnpm.override_path(), ["pnpm", "overrides"]);

        let berry = Node::of(Lockfile::YarnLock, "__metadata:\n  version: 6\n").unwrap();
        assert_eq!(berry, Node::YarnBerry);
        assert_eq!(berry.direct("lodash", "^4.17.21"), strings(&["corepack", "yarn", "up", "lodash@^4.17.21", "--mode=update-lockfile"]));
        assert_eq!(berry.transitive("minimist").unwrap(), strings(&["corepack", "yarn", "up", "--recursive", "minimist", "--mode=update-lockfile"]));
        assert_eq!(berry.in_range("lodash"), strings(&["corepack", "yarn", "up", "--recursive", "lodash", "--mode=update-lockfile"]));

        let classic = Node::of(Lockfile::YarnLock, "# yarn lockfile v1\n").unwrap();
        assert_eq!(classic, Node::YarnClassic);
        assert_eq!(classic.transitive("minimist"), None);
        assert_eq!(classic.in_range("lodash"), strings(&["corepack", "yarn", "upgrade", "lodash", "--ignore-scripts", "--non-interactive"]));
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
        let [precise, compatible] = cargo_commands("time", "0.1.43", "0.1.45", None);
        assert_eq!(precise, strings(&["cargo", "update", "-p", "time@0.1.43", "--precise", "0.1.45"]));
        assert_eq!(compatible, strings(&["cargo", "update", "-p", "time@0.1.43"]));
        let [precise, _] = cargo_commands("time", "0.1.43", "0.1.45", Some("/tmp/g1t-registries/cargo.toml"));
        assert_eq!(precise, strings(&["cargo", "--config", "/tmp/g1t-registries/cargo.toml", "update", "-p", "time@0.1.43", "--precise", "0.1.45"]));
        let [get, tidy] = go_commands("golang.org/x/net", "v0.23.0");
        assert_eq!(get, strings(&["go", "get", "golang.org/x/net@v0.23.0"]));
        assert_eq!(tidy, strings(&["go", "mod", "tidy"]));
    }

    #[test]
    fn cargo_requirements_keep_their_operator() {
        assert_eq!(raised_requirement("1.2", "2.0.3").as_deref(), Some("2.0.3"));
        assert_eq!(raised_requirement("^1.2.0", "2.0.3").as_deref(), Some("^2.0.3"));
        assert_eq!(raised_requirement("~0.4", "0.5.1").as_deref(), Some("~0.5.1"));
        assert_eq!(raised_requirement("=1.0.0", "1.1.0").as_deref(), Some("=1.1.0"));
        assert_eq!(raised_requirement(">= 1.0", "2.0.0").as_deref(), Some(">=2.0.0"));
        // Not a single requirement below the version: left alone.
        assert_eq!(raised_requirement(">=1, <2", "2.0.0"), None);
        assert_eq!(raised_requirement("1.*", "2.0.0"), None);
        assert_eq!(raised_requirement("*", "2.0.0"), None);
        assert_eq!(raised_requirement("2.1", "2.0.0"), None);
    }

    #[test]
    fn cargo_toml_requirements_are_raised_in_every_form() {
        let text = r#"[package]
name = "app"
version = "0.1.0"

[dependencies]
serde = "1.0"   # data
tokio = { version = "~1.20", features = ["full"] }
"serde_json" = { version = "=1.0.100" }
other = { version = "0.1", package = "serde" }
shared = { workspace = true }
time = "0.1"

[dev-dependencies.serde]
features = ["derive"]
version = "^1.0.150"

[target.'cfg(unix)'.build-dependencies]
serde = { path = "../serde", version = ">=1.0" }

[workspace.dependencies]
serde = '1'

[[bin]]
name = "serde"
version = "0.1"

[features]
serde = []
"#;
        let (out, moved) = rewrite_cargo_requirements(text, "serde", "1.0.200");
        assert_eq!(moved, 5);
        assert!(out.contains("serde = \"1.0.200\"   # data\n"));
        assert!(out.contains("other = { version = \"1.0.200\", package = \"serde\" }\n"));
        assert!(out.contains("[dev-dependencies.serde]\nfeatures = [\"derive\"]\nversion = \"^1.0.200\"\n"));
        assert!(out.contains("serde = { path = \"../serde\", version = \">=1.0.200\" }\n"));
        assert!(out.contains("serde = '1.0.200'\n"));
        // The package's own version, a binary and a feature are not dependencies.
        assert!(out.contains("[package]\nname = \"app\"\nversion = \"0.1.0\"\n"));
        assert!(out.contains("[[bin]]\nname = \"serde\"\nversion = \"0.1\"\n"));
        assert!(out.contains("time = \"0.1\"\n"));

        let (out, moved) = rewrite_cargo_requirements(text, "tokio", "1.37.0");
        assert_eq!(moved, 1);
        assert!(out.contains("tokio = { version = \"~1.37.0\", features = [\"full\"] }\n"));
        let (out, moved) = rewrite_cargo_requirements(text, "serde_json", "1.0.117");
        assert_eq!(moved, 1);
        assert!(out.contains("\"serde_json\" = { version = \"=1.0.117\" }\n"));
        // Already allowed, or not named: nothing changes.
        let (same, moved) = rewrite_cargo_requirements(text, "serde", "0.0.5");
        assert_eq!((same.as_str(), moved), (text, 0));
        assert_eq!(rewrite_cargo_requirements(text, "rand", "0.9.0").1, 0);
        // A renamed table section names its package.
        let renamed = "[dependencies.json]\npackage = \"serde_json\"\nversion = \"1.0.0\"\n";
        assert_eq!(rewrite_cargo_requirements(renamed, "serde_json", "1.0.117").0, "[dependencies.json]\npackage = \"serde_json\"\nversion = \"1.0.117\"\n");
        assert_eq!(rewrite_cargo_requirements(renamed, "json", "1.0.117").1, 0);
    }

    #[test]
    fn workspace_members_by_path_or_trailing_star() {
        let root: toml::Value = toml::from_str("[workspace]\nmembers = [\"crates/*\", \"./tools/xtask/\", \"apps/**\", \"../outside\", \"a?b\"]\n").unwrap();
        assert_eq!(workspace_members(&root), ["crates/*", "tools/xtask"]);
        assert!(workspace_members(&toml::from_str::<toml::Value>("[package]\nname = \"x\"\n").unwrap()).is_empty());
        assert_eq!(header_keys("[target.'cfg(target_os = \"linux\")'.dependencies]"), Some(strings(&["target", "cfg(target_os = \"linux\")", "dependencies"])));
        assert_eq!(header_keys("[[bin]]"), None);
        assert_eq!(dependency_table(&strings(&["workspace", "dependencies"])), Some(None));
        assert_eq!(dependency_table(&strings(&["dependencies", "serde"])), Some(Some("serde".into())));
        assert_eq!(dependency_table(&strings(&["package"])), None);
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

    fn registry(kind: &str, url: &str) -> Registry {
        Registry { kind: kind.into(), url: url.into(), ..Registry::default() }
    }

    fn env_of(tools: &Tools) -> Vec<(&str, &str)> {
        tools.env.iter().map(|(name, value)| (name.as_str(), value.as_str())).collect()
    }

    #[test]
    fn registries_arrive_as_the_contract_writes_them() {
        let text = r#"[{"type":"npm-registry","url":"https://npm.acme.dev","token":"t0k","replacesBase":true,"scopes":["@acme"]}]"#;
        let registries: Vec<Registry> = serde_json::from_str(text).unwrap();
        assert_eq!(registries[0].kind, "npm-registry");
        assert!(registries[0].replaces_base);
        assert_eq!(registries[0].scopes, ["@acme"]);
        // Its debug form never holds the token.
        assert!(!format!("{:?}", registries[0]).contains("t0k"));
    }

    #[test]
    fn npm_registries_become_a_user_npmrc() {
        let dir = Path::new("/tmp/g1t-registries");
        let mut replacing = registry("npm-registry", "https://npm.acme.dev/");
        replacing.token = Some("t0k".into());
        replacing.replaces_base = true;
        let mut scoped = registry("npm-registry", "https://pkgs.acme.dev/npm/");
        scoped.username = Some("ada".into());
        scoped.password = Some("p:w".into());
        scoped.scopes = strings(&["@acme", "@tools"]);
        let tools = registry_tools(&[replacing, scoped], &Named::default(), dir).unwrap();
        assert_eq!(tools.files.len(), 1);
        assert_eq!(tools.files[0].0, dir.join("npmrc"));
        assert_eq!(
            tools.files[0].1,
            "//npm.acme.dev/:_authToken=t0k\nregistry=https://npm.acme.dev/\n//pkgs.acme.dev/npm/:_auth=YWRhOnA6dw==\n@acme:registry=https://pkgs.acme.dev/npm/\n@tools:registry=https://pkgs.acme.dev/npm/\n"
        );
        assert_eq!(
            env_of(&tools),
            [
                ("YARN_NPM_REGISTRY_SERVER", "https://npm.acme.dev/"),
                ("YARN_NPM_AUTH_TOKEN", "t0k"),
                ("YARN_NPM_ALWAYS_AUTH", "true"),
                ("NPM_CONFIG_USERCONFIG", dir.join("npmrc").display().to_string().as_str()),
            ]
        );
        assert!(registry_tools(&[], &Named::default(), dir).unwrap().env.is_empty());
    }

    #[test]
    fn cargo_registries_by_the_projects_names_or_as_crates_io() {
        let dir = Path::new("/tmp/g1t-registries");
        let config = "[registries.acme]\nindex = \"sparse+https://cargo.acme.dev/index/\"\n[registries.other]\nindex = \"https://elsewhere.dev/git\"\n";
        let named = Named { cargo: cargo_registries(config), poetry: Vec::new() };
        assert_eq!(named.cargo.len(), 2);
        let mut acme = registry("cargo-registry", "https://cargo.acme.dev/index");
        acme.token = Some("ct".into());
        let tools = registry_tools(std::slice::from_ref(&acme), &named, dir).unwrap();
        assert_eq!(env_of(&tools), [("CARGO_REGISTRIES_ACME_TOKEN", "ct")]);
        assert!(tools.cargo_config.is_none());

        acme.replaces_base = true;
        let tools = registry_tools(&[acme], &Named::default(), dir).unwrap();
        assert_eq!(env_of(&tools), [("CARGO_REGISTRIES_G1T_PRIVATE_TOKEN", "ct")]);
        assert_eq!(tools.cargo_config.as_deref(), Some(dir.join("cargo.toml").display().to_string().as_str()));
        let written: toml::Value = toml::from_str(&tools.files[0].1).unwrap();
        assert_eq!(written["source"]["crates-io"]["replace-with"].as_str(), Some("g1t-private"));
        assert_eq!(written["source"]["g1t-private"]["registry"].as_str(), Some("sparse+https://cargo.acme.dev/index/"));
        assert_eq!(written["registries"]["g1t-private"]["index"].as_str(), Some("sparse+https://cargo.acme.dev/index/"));
    }

    #[test]
    fn python_indexes_carry_their_credentials_in_the_url() {
        let dir = Path::new("/tmp/g1t-registries");
        let mut base = registry("python-index", "https://pypi.acme.dev/simple/");
        base.username = Some("ada@acme".into());
        base.password = Some("p w/1".into());
        base.replaces_base = true;
        let mut extra = registry("python-index", "https://extra.acme.dev/simple");
        extra.token = Some("tok".into());
        let named = Named { cargo: Vec::new(), poetry: poetry_sources("[[tool.poetry.source]]\nname = \"acme-extra\"\nurl = \"https://extra.acme.dev/simple/\"\n") };
        let tools = registry_tools(&[base, extra, registry("python-index", "https://open.acme.dev/simple")], &named, dir).unwrap();
        assert_eq!(
            env_of(&tools),
            [
                ("PIP_INDEX_URL", "https://ada%40acme:p%20w%2F1@pypi.acme.dev/simple/"),
                ("POETRY_HTTP_BASIC_ACME_EXTRA_USERNAME", "__token__"),
                ("POETRY_HTTP_BASIC_ACME_EXTRA_PASSWORD", "tok"),
                ("PIP_EXTRA_INDEX_URL", "https://__token__:tok@extra.acme.dev/simple https://open.acme.dev/simple"),
            ]
        );
        assert!(tools.files.is_empty());
    }

    #[test]
    fn go_proxies_come_first_with_a_netrc() {
        let dir = Path::new("/tmp/g1t-registries");
        let mut proxy = registry("goproxy-server", "https://goproxy.acme.dev/mod");
        proxy.username = Some("ada".into());
        proxy.password = Some("pw".into());
        let tools = registry_tools(std::slice::from_ref(&proxy), &Named::default(), dir).unwrap();
        assert_eq!(
            env_of(&tools),
            [("GOPROXY", "https://goproxy.acme.dev/mod,https://proxy.golang.org,direct"), ("NETRC", dir.join("netrc").display().to_string().as_str())]
        );
        assert_eq!(tools.files, [(dir.join("netrc"), "machine goproxy.acme.dev\nlogin ada\npassword pw\n".to_owned())]);
        proxy.replaces_base = true;
        let tools = registry_tools(&[proxy], &Named::default(), dir).unwrap();
        assert_eq!(tools.get("GOPROXY"), Some("https://goproxy.acme.dev/mod,direct"));
    }

    #[test]
    fn registries_are_checked_before_anything_is_written() {
        let dir = Path::new("/tmp/g1t-registries");
        let check = |registry: Registry| registry_tools(&[registry], &Named::default(), dir).map(|_| ());
        assert!(check(registry("maven-repository", "https://m.acme.dev")).is_err());
        assert!(check(registry("npm-registry", "http://npm.acme.dev")).is_err());
        assert!(check(registry("npm-registry", "https://")).is_err());
        assert!(check(registry("goproxy-server", "https://a.dev,https://evil.dev")).is_err());
        let mut newline = registry("npm-registry", "https://npm.acme.dev");
        newline.token = Some("t\nregistry=https://evil.dev".into());
        assert!(check(newline).is_err());
        let mut spaced = registry("goproxy-server", "https://goproxy.acme.dev");
        spaced.password = Some("a b".into());
        assert!(check(spaced).is_err());
        let mut scope = registry("npm-registry", "https://npm.acme.dev");
        scope.scopes = strings(&["acme"]);
        assert!(check(scope).is_err());
    }

    #[test]
    fn registry_urls_compare_without_protocol_or_slash() {
        assert!(same_registry("sparse+https://cargo.acme.dev/index/", "https://Cargo.acme.dev/index"));
        assert!(same_registry("https://git.acme.dev/index.git", "https://git.acme.dev/index"));
        assert!(!same_registry("https://a.dev/x", "https://a.dev/y"));
        assert_eq!(npm_nerf_dart("https://npm.acme.dev"), "//npm.acme.dev/");
        assert_eq!(url_host("https://goproxy.acme.dev:8443/mod"), "goproxy.acme.dev");
        assert_eq!(env_part("acme-extra.v2"), "ACME_EXTRA_V2");
        assert_eq!(percent_encode("a@b:c/d e"), "a%40b%3Ac%2Fd%20e");
    }
}
