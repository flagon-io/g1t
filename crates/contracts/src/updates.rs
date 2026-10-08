//! Dependency updates: the file that asks for them, written in
//! `dependabot.yml` (version 2) syntax, and the pull requests g1t opens
//! from it. Version updates keep dependencies current on a schedule;
//! security updates (see [`crate::security`]) raise a vulnerable one to its
//! fix, and follow the same file. Mirrors `packages/contracts/src/updates.ts`.

use serde::{Deserialize, Serialize};

use crate::User;
use crate::repos::RepoPath;

/// Where the dependency update file may be, in the order it is looked
/// for. A repository brought to g1t keeps its `.github/dependabot.yml` as
/// it is. A file under `.g1t/` is read in place of one under `.github/`,
/// which is then reported as ignored.
pub const DEPENDABOT_PATHS: [&str; 4] =
    [".g1t/dependabot.yml", ".g1t/dependabot.yaml", ".github/dependabot.yml", ".github/dependabot.yaml"];

/// The status a pull request that changes the dependency update file gets
/// on its head: whether the file is valid.
pub const DEPENDABOT_CHECK: &str = "g1t / dependabot.yml";

/// One thing wrong with the dependency update file, and where.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigProblem {
    /// 1-based; 0 when the problem is with the file as a whole.
    pub line: u32,
    pub column: u32,
    /// The key it is about, as a path: `updates[0].schedule.interval`.
    pub key: String,
    pub message: String,
}

impl ConfigProblem {
    /// `line 4, updates[0].schedule.interval: …`, as one line of text.
    pub fn sentence(&self) -> String {
        let at = if self.key.is_empty() { String::new() } else { format!("{}: ", self.key) };
        if self.line == 0 { format!("{at}{}", self.message) } else { format!("line {}, {at}{}", self.line, self.message) }
    }
}

/// What the dependency update file asks for, as last read from the
/// default branch, and where each entry's version updates stand.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionUpdatesState {
    /// Whether a file was found on the default branch.
    pub found: bool,
    /// The file read: one of [`DEPENDABOT_PATHS`].
    #[serde(default)]
    pub path: Option<String>,
    /// Other dependency update files on the branch, not read because
    /// `path` comes first.
    #[serde(default)]
    pub ignored_paths: Vec<String>,
    /// The first problem, as a sentence; none when the file is valid.
    pub error: Option<String>,
    /// Every problem, with its line. A file with problems is not acted on.
    #[serde(default)]
    pub problems: Vec<ConfigProblem>,
    /// Each entry under `updates`, as read.
    pub updates: Vec<VersionUpdateEntry>,
    /// The private registries under `registries`, without their secrets.
    #[serde(default)]
    pub registries: Vec<UpdateRegistry>,
    /// When it was last read, RFC 3339.
    pub read_at: Option<String>,
    /// The commit it was read at.
    #[serde(default)]
    pub commit: Option<String>,
    /// Version and security update pull requests g1t has open or is
    /// making, newest first.
    #[serde(default)]
    pub pulls: Vec<UpdatePull>,
    /// Ignore conditions people set with `@g1t ignore …` comments. Those
    /// in the file are on each entry.
    #[serde(default)]
    pub ignores: Vec<IgnoreCondition>,
}

/// One entry of the file's `updates`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionUpdateEntry {
    /// Stable while the entry's ecosystem, directories and target branch
    /// stay the same: what "Check for updates" names.
    pub id: String,
    /// `package-ecosystem`, as written: `npm`, `cargo`, `gomod`, `pip`, …
    pub ecosystem: String,
    /// `directory`, or each of `directories`, from the repository's root.
    pub directories: Vec<String>,
    /// Whether g1t opens version update pull requests for this ecosystem.
    /// One it does not is still read and checked.
    pub supported: bool,
    /// `schedule.interval`: `daily`, `weekly`, … or `cron`.
    pub interval: String,
    /// The schedule in words: "Weekdays at 05:00 (UTC)".
    pub schedule: String,
    pub open_pull_requests_limit: u32,
    #[serde(default)]
    pub target_branch: Option<String>,
    #[serde(default)]
    pub multi_ecosystem_group: Option<String>,
    pub groups: Vec<UpdateGroup>,
    pub ignore: Vec<UpdateIgnore>,
    #[serde(default)]
    pub allow: Vec<UpdateAllow>,
    /// None for the default labels; empty for none.
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    #[serde(default)]
    pub assignees: Vec<String>,
    #[serde(default)]
    pub reviewers: Vec<String>,
    #[serde(default)]
    pub milestone: Option<u32>,
    #[serde(default)]
    pub versioning_strategy: Option<String>,
    /// The entry as read, with the file's own key names, to show in full.
    #[serde(default)]
    pub options: serde_json::Value,
    /// Options the entry sets that g1t reads but does not act on, each
    /// with why.
    #[serde(default)]
    pub notes: Vec<String>,
    /// When it is next checked, RFC 3339. None for an ecosystem g1t does
    /// not update, or with `open-pull-requests-limit: 0`.
    #[serde(default)]
    pub next_run_at: Option<String>,
    #[serde(default)]
    pub last_checked_at: Option<String>,
    /// What the last check found, in a sentence.
    #[serde(default)]
    pub last_result: Option<String>,
    /// Why the last check failed, if it did.
    #[serde(default)]
    pub last_error: Option<String>,
}

/// A `groups` rule.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGroup {
    pub name: String,
    /// `version-updates` or `security-updates`.
    pub applies_to: String,
    /// Package names, with `*` for any run of characters; every package
    /// when empty.
    pub patterns: Vec<String>,
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
    /// `major`, `minor`, `patch`; every one when empty.
    #[serde(default)]
    pub update_types: Vec<String>,
    /// `production` or `development`.
    #[serde(default)]
    pub dependency_type: Option<String>,
    /// `dependency-name`: one pull request per dependency across every
    /// directory.
    #[serde(default)]
    pub group_by: Option<String>,
}

/// An `ignore` rule.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateIgnore {
    /// A package name, with `*` for any run of characters; `*` when the
    /// rule names none.
    pub dependency: String,
    /// Version requirements to skip, such as `>=5`; all when empty.
    pub versions: Vec<String>,
    /// `version-update:semver-major`, `…-minor`, `…-patch`.
    #[serde(default)]
    pub update_types: Vec<String>,
}

/// An `allow` rule.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAllow {
    #[serde(default)]
    pub dependency: Option<String>,
    /// `direct`, `indirect`, `all`, `production` or `development`.
    #[serde(default)]
    pub dependency_type: Option<String>,
    #[serde(default)]
    pub update_types: Vec<String>,
}

/// A private registry from the file's top-level `registries`. Credentials
/// are never kept or shown: only the secrets they name.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRegistry {
    pub name: String,
    /// `npm-registry`, `cargo-registry`, `python-index`, …
    pub kind: String,
    pub url: String,
    /// The secrets its credentials name: `${{secrets.NAME}}`.
    #[serde(default)]
    pub secrets: Vec<String>,
}

/// One dependency an update pull request raises.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedDependency {
    pub name: String,
    pub from: String,
    pub to: String,
    /// From the repository's root: `/`, `/web`.
    #[serde(default)]
    pub directory: String,
    /// `direct:production`, `direct:development` or `indirect`.
    #[serde(default)]
    pub dependency_type: String,
    /// `version-update:semver-major`, `…-minor` or `…-patch`.
    #[serde(default)]
    pub update_type: String,
}

/// A pull request g1t opened, or is making, to update dependencies.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePull {
    /// `version` or `security`.
    pub kind: String,
    /// The `updates` entry it is for ([`VersionUpdateEntry::id`]).
    pub entry: String,
    /// `package-ecosystem`.
    pub ecosystem: String,
    /// The `groups` rule it is for, if any.
    #[serde(default)]
    pub group: Option<String>,
    pub branch: String,
    pub title: String,
    /// `requested`, `open`, `merged`, `closed`, `superseded`,
    /// `needs_code` or `failed`.
    pub state: String,
    pub pull: Option<u32>,
    pub dependencies: Vec<UpdatedDependency>,
    /// Who asked for it to merge once its checks pass (`@g1t merge`).
    #[serde(default)]
    pub merge_requested_by: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// RFC 3339.
    pub updated_at: String,
}

/// A dependency, or some of its versions, that updates skip because
/// someone said so in a comment (`@g1t ignore this major version`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreCondition {
    /// `package-ecosystem`.
    pub ecosystem: String,
    pub dependency: String,
    /// A version requirement such as `>= 5.a, < 6`; every version when absent.
    #[serde(default)]
    pub versions: Option<String>,
    /// `version-update:semver-major`, … when the condition is an update type.
    #[serde(default)]
    pub update_type: Option<String>,
    /// Who said so.
    pub by: String,
    /// The pull request it was said on.
    #[serde(default)]
    pub pull: Option<u32>,
    /// RFC 3339.
    pub at: String,
}

/// `check_updates`: checks one `updates` entry for new versions now,
/// rather than at its next scheduled time. Write and up. Returns
/// `Outcome<VersionUpdatesState>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CheckUpdatesArgs {
    pub actor: User,
    pub repo: RepoPath,
    /// [`VersionUpdateEntry::id`].
    pub entry: String,
}

/// One package of a grouped `bump` (see `security::BumpArgs`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BumpPackage {
    pub package: String,
    pub version: String,
}

/// A private registry a `bump` sandbox's tools may read: a `registries`
/// entry of the dependency update file with its secrets filled in.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BumpRegistry {
    /// `npm-registry`, `cargo-registry`, `python-index` or `goproxy-server`.
    #[serde(rename = "type")]
    pub kind: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// Used in place of the ecosystem's public registry.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub replaces_base: bool,
    /// npm scopes it serves: `@acme`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scopes: Vec<String>,
}

/// What a comment on a version or security update pull request asks g1t
/// to do, read by [`update_command`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "command")]
pub enum UpdateCommand {
    /// Bring it up to date with its base, unless someone else pushed to it.
    Rebase,
    /// Make it again from scratch, dropping anything pushed to it.
    Recreate,
    /// Merge it once its required checks pass.
    Merge,
    /// The same; g1t merges every pull request one way.
    SquashAndMerge,
    /// Forget an earlier `merge`.
    CancelMerge,
    /// Close it, and do not open one for these versions again.
    Close,
    /// Open it again.
    Reopen,
    /// Close it and stop updating its dependency.
    IgnoreDependency,
    /// Close it and skip this `major`, `minor` or `patch` version.
    IgnoreVersion { level: String },
    /// On a grouped pull request: skip one dependency, or one level of it.
    IgnoreNamed { dependency: String, level: Option<String> },
    /// Undo the ignores of one dependency (`*` for every one), or one
    /// level of it.
    Unignore { dependency: String, level: Option<String> },
    /// Say which ignore conditions apply to a dependency (the pull
    /// request's own when absent).
    ShowIgnores { dependency: Option<String> },
}

/// The command a comment gives, if it is one: its first line, `@g1t`
/// followed by a command, in any case. Anything else is an ordinary
/// mention.
pub fn update_command(body: &str) -> Option<UpdateCommand> {
    let line = body.trim().lines().next()?.trim();
    let handle = line.get(..4)?;
    let rest = &line[4..];
    if !handle.eq_ignore_ascii_case("@g1t") || !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let words: Vec<&str> = rest.split_whitespace().collect();
    let lower: Vec<String> = words.iter().map(|word| word.to_lowercase()).collect();
    let lower: Vec<&str> = lower.iter().map(String::as_str).collect();
    let level = |word: &str| matches!(word, "major" | "minor" | "patch").then(|| word.to_owned());
    let named = || words[1].to_owned();
    Some(match lower.as_slice() {
        ["rebase"] => UpdateCommand::Rebase,
        ["recreate"] => UpdateCommand::Recreate,
        ["merge"] => UpdateCommand::Merge,
        ["squash", "and", "merge"] => UpdateCommand::SquashAndMerge,
        ["cancel", "merge"] => UpdateCommand::CancelMerge,
        ["close"] => UpdateCommand::Close,
        ["reopen"] => UpdateCommand::Reopen,
        ["ignore", "this", "dependency"] => UpdateCommand::IgnoreDependency,
        ["ignore", "this", which, "version"] if level(which).is_some() => {
            UpdateCommand::IgnoreVersion { level: (*which).to_owned() }
        }
        ["show", "ignore", "conditions"] => UpdateCommand::ShowIgnores { dependency: None },
        ["show", _, "ignore", "conditions"] => UpdateCommand::ShowIgnores { dependency: Some(named()) },
        ["ignore", _] => UpdateCommand::IgnoreNamed { dependency: named(), level: None },
        ["ignore", _, which, "version"] if level(which).is_some() => {
            UpdateCommand::IgnoreNamed { dependency: named(), level: level(which) }
        }
        ["unignore", _] => UpdateCommand::Unignore { dependency: named(), level: None },
        ["unignore", _, which, "version"] if level(which).is_some() => {
            UpdateCommand::Unignore { dependency: named(), level: level(which) }
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_read_from_the_first_line() {
        for (body, expected) in [
            ("@g1t rebase", Some(UpdateCommand::Rebase)),
            ("@G1T Recreate\n\nplease", Some(UpdateCommand::Recreate)),
            ("@g1t merge", Some(UpdateCommand::Merge)),
            ("@g1t squash and merge", Some(UpdateCommand::SquashAndMerge)),
            ("@g1t cancel merge", Some(UpdateCommand::CancelMerge)),
            ("@g1t close", Some(UpdateCommand::Close)),
            ("@g1t reopen", Some(UpdateCommand::Reopen)),
            ("@g1t ignore this dependency", Some(UpdateCommand::IgnoreDependency)),
            ("@g1t ignore this major version", Some(UpdateCommand::IgnoreVersion { level: "major".into() })),
            ("@g1t ignore this patch version", Some(UpdateCommand::IgnoreVersion { level: "patch".into() })),
            ("@g1t show ignore conditions", Some(UpdateCommand::ShowIgnores { dependency: None })),
            ("@g1t show @babel/core ignore conditions", Some(UpdateCommand::ShowIgnores { dependency: Some("@babel/core".into()) })),
            ("@g1t ignore eslint", Some(UpdateCommand::IgnoreNamed { dependency: "eslint".into(), level: None })),
            ("@g1t ignore eslint minor version", Some(UpdateCommand::IgnoreNamed { dependency: "eslint".into(), level: Some("minor".into()) })),
            ("@g1t unignore *", Some(UpdateCommand::Unignore { dependency: "*".into(), level: None })),
            ("@g1t unignore Eslint major version", Some(UpdateCommand::Unignore { dependency: "Eslint".into(), level: Some("major".into()) })),
            ("@g1t can you rebase this?", None),
            ("@g1tbot rebase", None),
            ("please @g1t rebase", None),
            ("@g1t ignore this huge version", None),
            ("", None),
        ] {
            assert_eq!(update_command(body), expected, "{body:?}");
        }
    }

    #[test]
    fn a_problem_reads_as_one_line() {
        let problem = ConfigProblem { line: 4, column: 7, key: "updates[0].schedule.interval".into(), message: "hourly is not an interval.".into() };
        assert_eq!(problem.sentence(), "line 4, updates[0].schedule.interval: hourly is not an interval.");
        assert_eq!(ConfigProblem { message: "Not YAML.".into(), ..ConfigProblem::default() }.sentence(), "Not YAML.");
    }
}
