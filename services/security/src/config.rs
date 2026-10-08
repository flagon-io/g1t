//! The dependency update file, `dependabot.yml` (version 2): every option
//! of its format read and checked, each problem reported with its line and
//! key. A file with problems is shown but not acted on, so a mistake never
//! opens pull requests nobody asked for.
//!
//! Every `package-ecosystem` the format names is accepted; those g1t does
//! not update yet are read, checked and listed as such (see [`SUPPORTED`]).
//! Unknown keys are problems, as the format has it.

use g1t_contracts::updates::{ConfigProblem, UpdateRegistry, UpdateAllow, UpdateGroup, UpdateIgnore};

use crate::schedule::{self, Interval, Schedule, WEEKDAYS};
use crate::timezones;
use crate::yaml::{self, Node, Value};

/// Every `package-ecosystem` value.
pub const ECOSYSTEMS: [&str; 33] = [
    "bazel",
    "bun",
    "bundler",
    "cargo",
    "composer",
    "conda",
    "deno",
    "devcontainers",
    "docker",
    "docker-compose",
    "dotnet-sdk",
    "elm",
    "github-actions",
    "gitsubmodule",
    "gomod",
    "gradle",
    "helm",
    "julia",
    "maven",
    "mix",
    "nix",
    "npm",
    "nuget",
    "opentofu",
    "pip",
    "pre-commit",
    "pub",
    "rust-toolchain",
    "sbt",
    "swift",
    "terraform",
    "uv",
    "vcpkg",
];

/// The ecosystems g1t opens version update pull requests for: those whose
/// lockfiles it reads and its update sandbox can change.
pub const SUPPORTED: [&str; 4] = ["npm", "cargo", "gomod", "pip"];

const ROOT_KEYS: [&str; 5] = ["version", "updates", "registries", "enable-beta-ecosystems", "multi-ecosystem-groups"];
const ENTRY_KEYS: [&str; 26] = [
    "package-ecosystem",
    "directory",
    "directories",
    "schedule",
    "allow",
    "ignore",
    "groups",
    "cooldown",
    "assignees",
    "reviewers",
    "labels",
    "milestone",
    "commit-message",
    "open-pull-requests-limit",
    "pull-request-branch-name",
    "rebase-strategy",
    "target-branch",
    "vendor",
    "versioning-strategy",
    "insecure-external-code-execution",
    "exclude-paths",
    "registries",
    "patterns",
    "multi-ecosystem-group",
    "name",
    "enable-beta-ecosystems",
];
const SCHEDULE_KEYS: [&str; 5] = ["interval", "day", "time", "timezone", "cronjob"];
const GROUP_KEYS: [&str; 6] = ["applies-to", "dependency-type", "patterns", "exclude-patterns", "update-types", "group-by"];
const COOLDOWN_KEYS: [&str; 6] = ["default-days", "semver-major-days", "semver-minor-days", "semver-patch-days", "include", "exclude"];
const BRANCH_KEYS: [&str; 6] = ["separator", "prefix", "max-length", "word-separator", "branch-name-case", "template"];
const MULTI_GROUP_KEYS: [&str; 11] = [
    "schedule",
    "labels",
    "assignees",
    "milestone",
    "target-branch",
    "commit-message",
    "pull-request-branch-name",
    "open-pull-requests-limit",
    "update-types",
    "dependency-type",
    "exclude-patterns",
];
const REGISTRY_TYPES: [&str; 15] = [
    "cargo-registry",
    "composer-repository",
    "docker-registry",
    "git",
    "goproxy-server",
    "helm-registry",
    "hex-organization",
    "hex-repository",
    "maven-repository",
    "npm-registry",
    "nuget-feed",
    "pub-repository",
    "python-index",
    "rubygems-server",
    "terraform-registry",
];
const REGISTRY_KEYS: [&str; 21] = [
    "type",
    "url",
    "username",
    "password",
    "key",
    "token",
    "replaces-base",
    "scope",
    "organization",
    "repo",
    "auth-key",
    "public-key-fingerprint",
    "registry",
    "tenant-id",
    "client-id",
    "jfrog-oidc-provider-name",
    "identity-mapping-name",
    "audience",
    "aws-region",
    "account-id",
    "role-name",
];
/// Keys of a registry that also take AWS CodeArtifact's settings.
const REGISTRY_MORE_KEYS: [&str; 2] = ["domain", "domain-owner"];
const SEMVER_UPDATE_TYPES: [&str; 3] = ["version-update:semver-major", "version-update:semver-minor", "version-update:semver-patch"];
const LEVELS: [&str; 3] = ["major", "minor", "patch"];
const DEPENDENCY_TYPES: [&str; 5] = ["direct", "indirect", "all", "production", "development"];
const STRATEGIES: [&str; 5] = ["auto", "increase", "increase-if-necessary", "lockfile-only", "widen"];
const TEMPLATE_PLACEHOLDERS: [&str; 8] =
    ["prefix", "package_manager", "directory", "target_branch", "dependency", "version", "group_name", "name"];
/// The most entries one file may hold.
const MAX_ENTRIES: usize = 200;
const MAX_REGISTRIES: usize = 100;

/// `commit-message`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommitMessage {
    pub prefix: Option<String>,
    pub prefix_development: Option<String>,
    /// `include: scope`.
    pub scope: bool,
}

/// `pull-request-branch-name`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BranchName {
    pub separator: String,
    pub prefix: Option<String>,
    pub max_length: Option<u32>,
    pub word_separator: Option<String>,
    /// `lowercase` or `uppercase`.
    pub case: Option<String>,
    pub template: Option<String>,
}

impl Default for BranchName {
    fn default() -> Self {
        BranchName { separator: "/".to_owned(), prefix: None, max_length: None, word_separator: None, case: None, template: None }
    }
}

/// `cooldown`, in days.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cooldown {
    pub default_days: Option<u32>,
    pub major_days: Option<u32>,
    pub minor_days: Option<u32>,
    pub patch_days: Option<u32>,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}

/// A top-level `registries` entry. Credentials are kept as written, with
/// `${{secrets.NAME}}` unresolved until an update needs them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Registry {
    pub name: String,
    pub kind: String,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub token: Option<String>,
    pub key: Option<String>,
    pub replaces_base: bool,
    pub scopes: Vec<String>,
    /// Whether it signs in with OIDC (`tenant-id`, `jfrog-oidc-provider-name`,
    /// `aws-region`…), which g1t has no identity for.
    pub oidc: bool,
}

/// The names `${{secrets.NAME}}` refers to in `text`.
pub fn secret_names(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("${{") {
        let after = &rest[start + 3..];
        let Some(end) = after.find("}}") else { break };
        let inner = after[..end].trim();
        if let Some(name) = inner.strip_prefix("secrets.") {
            names.push(name.trim().to_owned());
        }
        rest = &after[end + 2..];
    }
    names
}

impl Registry {
    pub fn info(&self) -> UpdateRegistry {
        let mut secrets: Vec<String> = [&self.username, &self.password, &self.token, &self.key]
            .into_iter()
            .flatten()
            .flat_map(|text| secret_names(text))
            .collect();
        secrets.sort();
        secrets.dedup();
        UpdateRegistry { name: self.name.clone(), kind: self.kind.clone(), url: self.url.clone(), secrets }
    }
}

/// A `multi-ecosystem-groups` entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MultiGroup {
    pub name: String,
    pub schedule: Option<Schedule>,
    pub labels: Option<Vec<String>>,
    pub assignees: Vec<String>,
    pub milestone: Option<u32>,
    pub target_branch: Option<String>,
    pub commit_message: Option<CommitMessage>,
    pub branch_name: Option<BranchName>,
    pub open_pull_requests_limit: Option<u32>,
}

/// One `updates` entry, read and checked.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    /// Where it starts in the file.
    pub line: u32,
    pub ecosystem: String,
    /// From the repository's root, each starting with `/`. May hold globs
    /// when written as `directories`.
    pub directories: Vec<String>,
    /// Its own schedule, or its multi-ecosystem group's.
    pub schedule: Option<Schedule>,
    pub allow: Vec<UpdateAllow>,
    pub ignore: Vec<UpdateIgnore>,
    pub groups: Vec<UpdateGroup>,
    pub cooldown: Option<Cooldown>,
    pub assignees: Vec<String>,
    pub reviewers: Vec<String>,
    /// None for the default labels.
    pub labels: Option<Vec<String>>,
    pub milestone: Option<u32>,
    pub commit_message: Option<CommitMessage>,
    pub open_pull_requests_limit: u32,
    pub branch_name: BranchName,
    /// `auto` or `disabled`.
    pub rebase_strategy: String,
    pub target_branch: Option<String>,
    pub vendor: bool,
    pub versioning_strategy: Option<String>,
    pub insecure_external_code_execution: Option<String>,
    pub exclude_paths: Vec<String>,
    /// The registries it may use, by name (`*` already expanded).
    pub registries: Vec<String>,
    pub patterns: Vec<String>,
    pub multi_ecosystem_group: Option<String>,
    pub name: Option<String>,
    /// As written, for showing.
    pub options: serde_json::Value,
}

impl Entry {
    /// [`g1t_contracts::updates::VersionUpdateEntry::id`].
    pub fn id(&self) -> String {
        let target = self.target_branch.as_deref().map(|branch| format!("@{branch}")).unwrap_or_default();
        format!("{}:{}{target}", self.ecosystem, self.directories.join(","))
    }

    pub fn supported(&self) -> bool {
        SUPPORTED.contains(&self.ecosystem.as_str())
    }
}

/// The whole file.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Config {
    pub updates: Vec<Entry>,
    pub registries: Vec<Registry>,
    pub multi_groups: Vec<MultiGroup>,
    pub beta: bool,
}

/// What reading the file found: what it says, as far as it could be read,
/// and every problem. Only a file without problems is acted on.
#[derive(Debug, Default)]
pub struct Read {
    pub config: Config,
    pub problems: Vec<ConfigProblem>,
}

struct Reader {
    problems: Vec<ConfigProblem>,
}

fn quote(list: &[&str]) -> String {
    match list {
        [] => String::new(),
        [one] => format!("`{one}`"),
        [rest @ .., last] => format!("{} or `{last}`", rest.iter().map(|item| format!("`{item}`")).collect::<Vec<_>>().join(", ")),
    }
}

impl Reader {
    fn problem(&mut self, node: &Node, key: &str, message: impl Into<String>) {
        self.problems.push(ConfigProblem { line: node.line, column: node.column, key: key.to_owned(), message: message.into() });
    }

    /// Each key of `node` must be one of `allowed`.
    fn keys(&mut self, node: &Node, path: &str, allowed: &[&str], what: &str) {
        for (key, _) in node.as_map().unwrap_or_default() {
            let name = key.scalar().unwrap_or_default();
            if !allowed.contains(&name.as_str()) {
                self.problem(key, path, format!("`{name}` is not an option of {what}."));
            }
        }
    }

    fn map<'a>(&mut self, node: &'a Node, path: &str) -> Option<&'a [(Node, Node)]> {
        let entries = node.as_map();
        if entries.is_none() {
            self.problem(node, path, format!("This must be a mapping of keys to values, not {}.", node.kind()));
        }
        entries
    }

    fn text(&mut self, node: &Node, path: &str) -> Option<String> {
        match &node.value {
            Value::Text { text, .. } => Some(text.clone()),
            Value::Int(_) | Value::Float(_) => node.scalar(),
            _ => {
                self.problem(node, path, format!("This must be text, not {}.", node.kind()));
                None
            }
        }
    }

    fn nonempty(&mut self, node: &Node, path: &str) -> Option<String> {
        let text = self.text(node, path)?;
        if text.trim().is_empty() {
            self.problem(node, path, "This must not be empty.");
            return None;
        }
        Some(text)
    }

    fn one_of(&mut self, node: &Node, path: &str, allowed: &[&str], what: &str) -> Option<String> {
        let text = self.text(node, path)?;
        if !allowed.contains(&text.as_str()) {
            self.problem(node, path, format!("`{text}` is not {what}. Use {}.", quote(allowed)));
            return None;
        }
        Some(text)
    }

    fn boolean(&mut self, node: &Node, path: &str) -> Option<bool> {
        match node.value {
            Value::Bool(value) => Some(value),
            _ => {
                self.problem(node, path, format!("This must be true or false, not {}.", node.kind()));
                None
            }
        }
    }

    fn integer(&mut self, node: &Node, path: &str, low: i64, high: Option<i64>) -> Option<u32> {
        let range = match high {
            Some(high) => format!("from {low} to {high}"),
            None => format!("of {low} or more"),
        };
        match node.value {
            Value::Int(n) if n >= low && high.is_none_or(|high| n <= high) && n <= i64::from(u32::MAX) => Some(n as u32),
            _ => {
                self.problem(node, path, format!("This must be a whole number {range}."));
                None
            }
        }
    }

    /// A list of distinct, non-empty strings. `min` items at least.
    fn strings(&mut self, node: &Node, path: &str, min: usize) -> Option<Vec<String>> {
        let Value::Seq(items) = &node.value else {
            self.problem(node, path, format!("This must be a list, not {}.", node.kind()));
            return None;
        };
        let mut out: Vec<String> = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let at = format!("{path}[{index}]");
            let Some(text) = self.nonempty(item, &at) else { continue };
            if out.contains(&text) {
                self.problem(item, &at, format!("`{text}` is listed twice."));
                continue;
            }
            out.push(text);
        }
        if out.len() < min {
            self.problem(node, path, if min == 1 { "This list must not be empty.".to_owned() } else { format!("This list needs at least {min} items.") });
        }
        Some(out)
    }

    fn update_types(&mut self, node: &Node, path: &str, allowed: &[&str]) -> Vec<String> {
        let found = self.strings(node, path, 1).unwrap_or_default();
        let Value::Seq(items) = &node.value else { return Vec::new() };
        let mut out = Vec::new();
        for (item, text) in items.iter().zip(&found) {
            if allowed.contains(&text.as_str()) {
                out.push(text.clone());
            } else {
                self.problem(item, path, format!("`{text}` is not an update type. Use {}.", quote(allowed)));
            }
        }
        out
    }

    fn schedule(&mut self, node: &Node, path: &str) -> Option<Schedule> {
        self.map(node, path)?;
        self.keys(node, path, &SCHEDULE_KEYS, "`schedule`");
        let Some(interval_node) = node.get("interval") else {
            self.problem(node, path, "`interval` is required: daily, weekly, monthly, quarterly, semiannually, yearly or cron.");
            return None;
        };
        let names: Vec<&str> = Interval::ALL.iter().map(|interval| interval.as_str()).collect();
        let interval = self.one_of(interval_node, &format!("{path}.interval"), &names, "an interval");
        let interval = interval.and_then(|text| Interval::parse(&text));
        let day = node.get("day").and_then(|day| {
            let text = self.one_of(day, &format!("{path}.day"), &WEEKDAYS, "a day of the week")?;
            WEEKDAYS.iter().position(|name| *name == text).map(|at| at as u32)
        });
        let time = node.get("time").and_then(|time| {
            let text = self.text(time, &format!("{path}.time"))?;
            let parsed = schedule::parse_time(&text);
            if parsed.is_none() {
                self.problem(time, &format!("{path}.time"), format!("`{text}` is not a time. Write it as hh:mm, such as \"09:00\"."));
            }
            parsed
        });
        let timezone = node.get("timezone").and_then(|zone| {
            let text = self.text(zone, &format!("{path}.timezone"))?;
            if !timezones::known(&text) {
                self.problem(zone, &format!("{path}.timezone"), format!("`{text}` is not a time zone. Use a name from the IANA database, such as \"America/New_York\"."));
                return None;
            }
            Some(text)
        });
        let cron = match (interval, node.get("cronjob")) {
            (Some(Interval::Cron), Some(job)) => {
                let text = self.text(job, &format!("{path}.cronjob"))?;
                match schedule::cronjob(&text) {
                    Ok(cron) => Some(cron),
                    Err(message) => {
                        self.problem(job, &format!("{path}.cronjob"), message);
                        None
                    }
                }
            }
            (Some(Interval::Cron), None) => {
                self.problem(node, path, "`cronjob` is required when the interval is cron, such as cronjob: \"0 9 * * 1\".");
                None
            }
            // Only read for cron; another interval leaves it unread.
            _ => None,
        };
        Some(Schedule { interval: interval?, day, time, timezone, cron })
    }

    fn commit_message(&mut self, node: &Node, path: &str) -> Option<CommitMessage> {
        self.map(node, path)?;
        self.keys(node, path, &["prefix", "prefix-development", "include"], "`commit-message`");
        let mut message = CommitMessage::default();
        let prefix = |reader: &mut Reader, key: &str| -> Option<String> {
            let found = node.get(key)?;
            let text = reader.text(found, &format!("{path}.{key}"))?;
            if text.chars().count() > 50 {
                reader.problem(found, &format!("{path}.{key}"), "A prefix is at most 50 characters.");
                return None;
            }
            Some(text)
        };
        message.prefix = prefix(self, "prefix");
        message.prefix_development = prefix(self, "prefix-development");
        if let Some(include) = node.get("include") {
            message.scope = self.one_of(include, &format!("{path}.include"), &["scope"], "something `include` takes").is_some();
        }
        if node.as_map().is_some_and(<[_]>::is_empty) {
            self.problem(node, path, "`commit-message` needs prefix, prefix-development or include.");
        }
        Some(message)
    }

    fn branch_name(&mut self, node: &Node, path: &str) -> Option<BranchName> {
        self.map(node, path)?;
        self.keys(node, path, &BRANCH_KEYS, "`pull-request-branch-name`");
        let mut name = BranchName::default();
        if let Some(separator) = node.get("separator") {
            name.separator = self.one_of(separator, &format!("{path}.separator"), &["-", "_", "/"], "a separator").unwrap_or(name.separator);
        }
        if let Some(prefix) = node.get("prefix") {
            name.prefix = self.nonempty(prefix, &format!("{path}.prefix")).filter(|text| {
                let ok = text.chars().count() <= 50 && valid_ref_part(text);
                if !ok {
                    self.problem(prefix, &format!("{path}.prefix"), "A prefix is at most 50 characters and must be usable in a branch name.");
                }
                ok
            });
        }
        if let Some(length) = node.get("max-length") {
            name.max_length = self.integer(length, &format!("{path}.max-length"), 20, Some(244));
        }
        if let Some(separator) = node.get("word-separator") {
            name.word_separator = self.one_of(separator, &format!("{path}.word-separator"), &["-", "_", "/", "."], "a word separator");
        }
        if let Some(case) = node.get("branch-name-case") {
            name.case = self.one_of(case, &format!("{path}.branch-name-case"), &["lowercase", "uppercase"], "a case");
        }
        if let Some(template) = node.get("template") {
            name.template = self.text(template, &format!("{path}.template")).filter(|text| {
                match template_problem(text) {
                    Some(message) => {
                        self.problem(template, &format!("{path}.template"), message);
                        false
                    }
                    None => true,
                }
            });
        }
        if node.as_map().is_some_and(<[_]>::is_empty) {
            self.problem(node, path, "`pull-request-branch-name` needs at least one option, such as separator.");
        }
        Some(name)
    }

    fn directory(&mut self, node: &Node, path: &str, globs: bool) -> Option<String> {
        let raw = self.nonempty(node, path)?;
        let trimmed = raw.trim().trim_end_matches('/');
        if trimmed.split('/').any(|part| part == "..") {
            self.problem(node, path, format!("`{raw}` must stay inside the repository."));
            return None;
        }
        if !globs && (trimmed.contains('*') || trimmed.contains('?')) {
            self.problem(node, path, format!("`{raw}` has a wildcard; use `directories` for globs."));
            return None;
        }
        Some(if trimmed.is_empty() || trimmed == "." {
            "/".to_owned()
        } else if trimmed.starts_with('/') {
            trimmed.to_owned()
        } else {
            format!("/{}", trimmed.trim_start_matches("./"))
        })
    }

    fn groups(&mut self, node: &Node, path: &str) -> Vec<UpdateGroup> {
        let Some(entries) = self.map(node, path) else { return Vec::new() };
        if entries.is_empty() {
            self.problem(node, path, "`groups` must name at least one group.");
        }
        let mut groups = Vec::new();
        for (key, group) in entries {
            let name = key.scalar().unwrap_or_default();
            let at = format!("{path}.{name}");
            if !valid_group_name(&name) {
                self.problem(key, &at, "A group's name starts and ends with a letter or digit, and holds only letters, digits, `|`, `_` and `-`.");
            }
            if self.map(group, &at).is_none() {
                continue;
            }
            self.keys(group, &at, &GROUP_KEYS, "a group");
            let applies_to = group
                .get("applies-to")
                .and_then(|value| self.one_of(value, &format!("{at}.applies-to"), &["version-updates", "security-updates"], "what a group applies to"))
                .unwrap_or_else(|| "version-updates".to_owned());
            let dependency_type = group
                .get("dependency-type")
                .and_then(|value| self.one_of(value, &format!("{at}.dependency-type"), &["development", "production"], "a dependency type"));
            let patterns = group.get("patterns").and_then(|value| self.strings(value, &format!("{at}.patterns"), 1)).unwrap_or_default();
            let exclude_patterns =
                group.get("exclude-patterns").and_then(|value| self.strings(value, &format!("{at}.exclude-patterns"), 1)).unwrap_or_default();
            let update_types = group.get("update-types").map(|value| self.update_types(value, &format!("{at}.update-types"), &LEVELS)).unwrap_or_default();
            let group_by = group
                .get("group-by")
                .and_then(|value| self.one_of(value, &format!("{at}.group-by"), &["dependency-name"], "something `group-by` takes"));
            if group_by.is_some() && applies_to == "security-updates" {
                self.problem(group, &at, "`group-by` applies to version updates only.");
            }
            groups.push(UpdateGroup { name, applies_to, patterns, exclude_patterns, update_types, dependency_type, group_by });
        }
        groups
    }

    fn cooldown(&mut self, node: &Node, path: &str) -> Option<Cooldown> {
        self.map(node, path)?;
        self.keys(node, path, &COOLDOWN_KEYS, "`cooldown`");
        let days = |reader: &mut Reader, key: &str, low: i64| node.get(key).and_then(|value| reader.integer(value, &format!("{path}.{key}"), low, Some(90)));
        let list = |reader: &mut Reader, key: &str| -> Vec<String> {
            let Some(value) = node.get(key) else { return Vec::new() };
            let found = reader.strings(value, &format!("{path}.{key}"), 0).unwrap_or_default();
            if found.len() > 150 {
                reader.problem(value, &format!("{path}.{key}"), "This list holds at most 150 names.");
            }
            found
        };
        Some(Cooldown {
            default_days: days(self, "default-days", 1),
            major_days: days(self, "semver-major-days", 1),
            minor_days: days(self, "semver-minor-days", 1),
            patch_days: days(self, "semver-patch-days", 0),
            include: list(self, "include"),
            exclude: list(self, "exclude"),
        })
    }

    fn allow(&mut self, node: &Node, path: &str) -> Vec<UpdateAllow> {
        let Value::Seq(items) = &node.value else {
            self.problem(node, path, format!("This must be a list of rules, not {}.", node.kind()));
            return Vec::new();
        };
        let mut rules = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let at = format!("{path}[{index}]");
            if self.map(item, &at).is_none() {
                continue;
            }
            self.keys(item, &at, &["dependency-name", "dependency-type", "update-types"], "an `allow` rule");
            let dependency = item.get("dependency-name").and_then(|value| self.nonempty(value, &format!("{at}.dependency-name")));
            let dependency_type =
                item.get("dependency-type").and_then(|value| self.one_of(value, &format!("{at}.dependency-type"), &DEPENDENCY_TYPES, "a dependency type"));
            let update_types =
                item.get("update-types").map(|value| self.update_types(value, &format!("{at}.update-types"), &SEMVER_UPDATE_TYPES)).unwrap_or_default();
            if item.get("dependency-name").is_none() && item.get("dependency-type").is_none() {
                self.problem(item, &at, "An `allow` rule needs dependency-name or dependency-type.");
            }
            rules.push(UpdateAllow { dependency, dependency_type, update_types });
        }
        rules
    }

    fn ignore(&mut self, node: &Node, path: &str) -> Vec<UpdateIgnore> {
        let Value::Seq(items) = &node.value else {
            self.problem(node, path, format!("This must be a list of rules, not {}.", node.kind()));
            return Vec::new();
        };
        let mut rules = Vec::new();
        for (index, item) in items.iter().enumerate() {
            let at = format!("{path}[{index}]");
            if self.map(item, &at).is_none() {
                continue;
            }
            self.keys(item, &at, &["dependency-name", "versions", "update-types"], "an `ignore` rule");
            let dependency = item
                .get("dependency-name")
                .and_then(|value| self.nonempty(value, &format!("{at}.dependency-name")))
                .unwrap_or_else(|| "*".to_owned());
            let versions = match item.get("versions") {
                None => Vec::new(),
                Some(value) if matches!(value.value, Value::Seq(_)) => self.strings(value, &format!("{at}.versions"), 1).unwrap_or_default(),
                Some(value) => self.nonempty(value, &format!("{at}.versions")).into_iter().collect(),
            };
            let update_types =
                item.get("update-types").map(|value| self.update_types(value, &format!("{at}.update-types"), &SEMVER_UPDATE_TYPES)).unwrap_or_default();
            if item.as_map().is_some_and(<[_]>::is_empty) {
                self.problem(item, &at, "An `ignore` rule needs dependency-name, versions or update-types.");
            }
            rules.push(UpdateIgnore { dependency, versions, update_types });
        }
        rules
    }

    fn registry(&mut self, name: &str, node: &Node, path: &str) -> Option<Registry> {
        self.map(node, path)?;
        let allowed: Vec<&str> = REGISTRY_KEYS.iter().chain(REGISTRY_MORE_KEYS.iter()).copied().collect();
        self.keys(node, path, &allowed, "a registry");
        let Some(kind_node) = node.get("type") else {
            self.problem(node, path, format!("`type` is required: {}.", quote(&REGISTRY_TYPES)));
            return None;
        };
        let kind = self.one_of(kind_node, &format!("{path}.type"), &REGISTRY_TYPES, "a registry type")?;
        let url = match node.get("url") {
            Some(url) => {
                let text = self.nonempty(url, &format!("{path}.url"))?;
                if text.starts_with("http://") {
                    self.problem(url, &format!("{path}.url"), "A registry is reached over https.");
                }
                text
            }
            None if kind == "hex-organization" => String::new(),
            None => {
                self.problem(node, path, "`url` is required.");
                return None;
            }
        };
        let field = |reader: &mut Reader, key: &str| node.get(key).and_then(|value| reader.text(value, &format!("{path}.{key}")));
        let scopes = match node.get("scope") {
            None => Vec::new(),
            Some(value) if matches!(value.value, Value::Seq(_)) => self.strings(value, &format!("{path}.scope"), 1).unwrap_or_default(),
            Some(value) => self.nonempty(value, &format!("{path}.scope")).into_iter().collect(),
        };
        if let Some(scope) = scopes.iter().find(|scope| !scope.starts_with('@')) {
            let at = node.get("scope").unwrap_or(node);
            self.problem(at, &format!("{path}.scope"), format!("`{scope}` is not an npm scope; a scope starts with @."));
        }
        let replaces_base = node.get("replaces-base").and_then(|value| self.boolean(value, &format!("{path}.replaces-base"))).unwrap_or(false);
        let oidc = ["tenant-id", "client-id", "jfrog-oidc-provider-name", "aws-region", "role-name"].iter().any(|key| node.get(key).is_some());
        Some(Registry {
            name: name.to_owned(),
            kind,
            url,
            username: field(self, "username"),
            password: field(self, "password"),
            token: field(self, "token"),
            key: field(self, "key").or_else(|| field(self, "auth-key")),
            replaces_base,
            scopes,
            oidc,
        })
    }

    fn multi_group(&mut self, name: &str, node: &Node, path: &str) -> Option<MultiGroup> {
        self.map(node, path)?;
        self.keys(node, path, &MULTI_GROUP_KEYS, "a multi-ecosystem group");
        let schedule = match node.get("schedule") {
            Some(value) => self.schedule(value, &format!("{path}.schedule")),
            None => {
                self.problem(node, path, "`schedule` is required.");
                None
            }
        };
        if let Some(value) = node.get("update-types") {
            self.update_types(value, &format!("{path}.update-types"), &LEVELS);
        }
        if let Some(value) = node.get("dependency-type") {
            self.one_of(value, &format!("{path}.dependency-type"), &["development", "production"], "a dependency type");
        }
        if let Some(value) = node.get("exclude-patterns") {
            self.strings(value, &format!("{path}.exclude-patterns"), 1);
        }
        Some(MultiGroup {
            name: name.to_owned(),
            schedule,
            labels: node.get("labels").and_then(|value| self.strings(value, &format!("{path}.labels"), 0)),
            assignees: node.get("assignees").and_then(|value| self.strings(value, &format!("{path}.assignees"), 1)).unwrap_or_default(),
            milestone: node.get("milestone").and_then(|value| self.integer(value, &format!("{path}.milestone"), 1, None)),
            target_branch: node.get("target-branch").and_then(|value| self.nonempty(value, &format!("{path}.target-branch"))),
            commit_message: node.get("commit-message").and_then(|value| self.commit_message(value, &format!("{path}.commit-message"))),
            branch_name: node.get("pull-request-branch-name").and_then(|value| self.branch_name(value, &format!("{path}.pull-request-branch-name"))),
            open_pull_requests_limit: node
                .get("open-pull-requests-limit")
                .and_then(|value| self.integer(value, &format!("{path}.open-pull-requests-limit"), 0, None)),
        })
    }

    fn entry(&mut self, index: usize, node: &Node, config: &Config) -> Option<Entry> {
        let path = format!("updates[{index}]");
        self.map(node, &path)?;
        self.keys(node, &path, &ENTRY_KEYS[..ENTRY_KEYS.len() - 1], "an `updates` entry");
        let ecosystem = match node.get("package-ecosystem") {
            None => {
                self.problem(node, &path, "`package-ecosystem` is required, such as npm, cargo, gomod or pip.");
                None
            }
            Some(value) => {
                let text = self.nonempty(value, &format!("{path}.package-ecosystem"));
                match text {
                    Some(text) if ECOSYSTEMS.contains(&text.as_str()) || config.beta => Some(text),
                    Some(text) => {
                        self.problem(value, &format!("{path}.package-ecosystem"), format!("`{text}` is not a package ecosystem. Use one of {}.", ECOSYSTEMS.join(", ")));
                        None
                    }
                    None => None,
                }
            }
        };
        let directories = match (node.get("directory"), node.get("directories")) {
            (Some(_), Some(both)) => {
                self.problem(both, &path, "Give `directory` or `directories`, not both.");
                Vec::new()
            }
            (Some(one), None) => self.directory(one, &format!("{path}.directory"), false).into_iter().collect(),
            (None, Some(many)) => {
                let listed = self.strings(many, &format!("{path}.directories"), 1).unwrap_or_default();
                let Value::Seq(items) = &many.value else { return None };
                let mut out = Vec::new();
                for ((offset, item), _) in items.iter().enumerate().zip(&listed) {
                    if let Some(directory) = self.directory(item, &format!("{path}.directories[{offset}]"), true)
                        && !out.contains(&directory)
                    {
                        out.push(directory);
                    }
                }
                out
            }
            (None, None) => {
                self.problem(node, &path, "`directory` (or `directories`) is required: where the manifest is, such as \"/\".");
                Vec::new()
            }
        };
        let multi_ecosystem_group = node.get("multi-ecosystem-group").and_then(|value| {
            let name = self.nonempty(value, &format!("{path}.multi-ecosystem-group"))?;
            if !config.multi_groups.iter().any(|group| group.name == name) {
                self.problem(value, &format!("{path}.multi-ecosystem-group"), format!("`{name}` is not one of the groups under multi-ecosystem-groups."));
            }
            Some(name)
        });
        let schedule = match node.get("schedule") {
            Some(value) => self.schedule(value, &format!("{path}.schedule")),
            None if multi_ecosystem_group.is_some() => None,
            None => {
                self.problem(node, &path, "`schedule` is required, such as schedule: { interval: weekly }.");
                None
            }
        };
        let schedule = schedule.or_else(|| {
            let group = multi_ecosystem_group.as_deref()?;
            config.multi_groups.iter().find(|found| found.name == group)?.schedule.clone()
        });
        let patterns = node.get("patterns").and_then(|value| self.strings(value, &format!("{path}.patterns"), 1)).unwrap_or_default();
        if multi_ecosystem_group.is_some() && node.get("patterns").is_none() {
            self.problem(node, &path, "An entry in a multi-ecosystem group needs `patterns`; use [\"*\"] for every dependency.");
        }
        let registries = match node.get("registries") {
            None => Vec::new(),
            Some(value) if value.scalar().as_deref() == Some("*") => config.registries.iter().map(|registry| registry.name.clone()).collect(),
            Some(value) => {
                let names = self.strings(value, &format!("{path}.registries"), 1).unwrap_or_default();
                for name in &names {
                    if !config.registries.iter().any(|registry| &registry.name == name) {
                        self.problem(value, &format!("{path}.registries"), format!("`{name}` is not one of the registries under the top-level registries."));
                    }
                }
                if names.len() > 100 {
                    self.problem(value, &format!("{path}.registries"), "An entry uses at most 100 registries.");
                }
                names
            }
        };
        let name = node.get("name").and_then(|value| {
            let text = self.text(value, &format!("{path}.name"))?;
            if !(3..=100).contains(&text.chars().count()) {
                self.problem(value, &format!("{path}.name"), "A name is from 3 to 100 characters.");
            }
            Some(text)
        });
        let versioning_strategy = node
            .get("versioning-strategy")
            .and_then(|value| self.one_of(value, &format!("{path}.versioning-strategy"), &STRATEGIES, "a versioning strategy"));
        Some(Entry {
            line: node.line,
            ecosystem: ecosystem?,
            directories,
            schedule,
            allow: node.get("allow").map(|value| self.allow(value, &format!("{path}.allow"))).unwrap_or_default(),
            ignore: node.get("ignore").map(|value| self.ignore(value, &format!("{path}.ignore"))).unwrap_or_default(),
            groups: node.get("groups").map(|value| self.groups(value, &format!("{path}.groups"))).unwrap_or_default(),
            cooldown: node.get("cooldown").and_then(|value| self.cooldown(value, &format!("{path}.cooldown"))),
            assignees: node.get("assignees").and_then(|value| self.strings(value, &format!("{path}.assignees"), 1)).unwrap_or_default(),
            reviewers: node.get("reviewers").and_then(|value| self.strings(value, &format!("{path}.reviewers"), 1)).unwrap_or_default(),
            labels: node.get("labels").and_then(|value| self.strings(value, &format!("{path}.labels"), 0)),
            milestone: node.get("milestone").and_then(|value| self.integer(value, &format!("{path}.milestone"), 1, None)),
            commit_message: node.get("commit-message").and_then(|value| self.commit_message(value, &format!("{path}.commit-message"))),
            open_pull_requests_limit: node
                .get("open-pull-requests-limit")
                .and_then(|value| self.integer(value, &format!("{path}.open-pull-requests-limit"), 0, None))
                .unwrap_or(5),
            branch_name: node
                .get("pull-request-branch-name")
                .and_then(|value| self.branch_name(value, &format!("{path}.pull-request-branch-name")))
                .unwrap_or_default(),
            rebase_strategy: node
                .get("rebase-strategy")
                .and_then(|value| self.one_of(value, &format!("{path}.rebase-strategy"), &["auto", "disabled"], "a rebase strategy"))
                .unwrap_or_else(|| "auto".to_owned()),
            target_branch: node.get("target-branch").and_then(|value| {
                let text = self.nonempty(value, &format!("{path}.target-branch"))?;
                if !valid_ref_part(&text) {
                    self.problem(value, &format!("{path}.target-branch"), format!("`{text}` is not a branch name."));
                    return None;
                }
                Some(text)
            }),
            vendor: node.get("vendor").and_then(|value| self.boolean(value, &format!("{path}.vendor"))).unwrap_or(false),
            versioning_strategy,
            insecure_external_code_execution: node.get("insecure-external-code-execution").and_then(|value| {
                self.one_of(value, &format!("{path}.insecure-external-code-execution"), &["allow", "deny"], "something this option takes")
            }),
            exclude_paths: node.get("exclude-paths").and_then(|value| self.strings(value, &format!("{path}.exclude-paths"), 0)).unwrap_or_default(),
            registries,
            patterns,
            multi_ecosystem_group,
            name,
            options: node.to_json(),
        })
    }
}

/// Whether `text` can be part of a branch name.
pub fn valid_ref_part(text: &str) -> bool {
    !text.is_empty()
        && !text.starts_with(['-', '/', '.'])
        && !text.ends_with(['/', '.'])
        && !text.ends_with(".lock")
        && !text.contains("..")
        && !text.contains("@{")
        && !text.contains("//")
        && !text.chars().any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c))
}

fn valid_group_name(name: &str) -> bool {
    let edge = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric());
    edge(name.chars().next()) && edge(name.chars().last()) && name.chars().all(|c| c.is_ascii_alphanumeric() || "|_-".contains(c))
}

/// What is wrong with a `pull-request-branch-name.template`, if anything.
fn template_problem(template: &str) -> Option<String> {
    if template.chars().count() > 200 {
        return Some("A template is at most 200 characters.".to_owned());
    }
    let mut rest = template;
    while let Some(open) = rest.find(['{', '}']) {
        if rest[open..].starts_with('}') {
            return Some("The template has a `}` with no `{` before it.".to_owned());
        }
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            return Some("The template has a `{` that is never closed.".to_owned());
        };
        let name = &after[..close];
        if !TEMPLATE_PLACEHOLDERS.contains(&name) {
            return Some(format!("`{{{name}}}` is not a placeholder. Use {}.", TEMPLATE_PLACEHOLDERS.map(|p| format!("{{{p}}}")).join(", ")));
        }
        rest = &after[close + 1..];
    }
    None
}

/// Reads the dependency update file.
pub fn read(source: &str) -> Read {
    let mut reader = Reader { problems: Vec::new() };
    let root = match yaml::parse(source) {
        Ok(root) => root,
        Err(error) => {
            return Read {
                config: Config::default(),
                problems: vec![ConfigProblem { line: error.line, column: error.column, key: String::new(), message: error.message }],
            };
        }
    };
    let mut config = Config::default();
    if root.as_map().is_none() {
        reader.problem(&root, "", "The file must be a mapping with `version: 2` and `updates`.");
        return Read { config, problems: reader.problems };
    }
    reader.keys(&root, "", &ROOT_KEYS, "the file");
    match root.get("version") {
        None => reader.problem(&root, "version", "`version: 2` is required."),
        Some(version) => {
            let two = matches!(&version.value, Value::Int(2)) || matches!(&version.value, Value::Text { text, .. } if text.trim() == "2");
            if !two {
                reader.problem(version, "version", format!("The version must be 2, not {}.", version.scalar().unwrap_or_else(|| version.kind().to_owned())));
            }
        }
    }
    if let Some(beta) = root.get("enable-beta-ecosystems") {
        config.beta = reader.boolean(beta, "enable-beta-ecosystems").unwrap_or(false);
    }
    if let Some(registries) = root.get("registries")
        && let Some(entries) = reader.map(registries, "registries")
    {
        if entries.len() > MAX_REGISTRIES {
            reader.problem(registries, "registries", format!("The file defines at most {MAX_REGISTRIES} registries."));
        }
        for (key, value) in entries {
            let name = key.scalar().unwrap_or_default();
            if let Some(registry) = reader.registry(&name, value, &format!("registries.{name}")) {
                config.registries.push(registry);
            }
        }
    }
    if let Some(groups) = root.get("multi-ecosystem-groups")
        && let Some(entries) = reader.map(groups, "multi-ecosystem-groups")
    {
        if entries.is_empty() {
            reader.problem(groups, "multi-ecosystem-groups", "This must name at least one group.");
        }
        for (key, value) in entries {
            let name = key.scalar().unwrap_or_default();
            if let Some(group) = reader.multi_group(&name, value, &format!("multi-ecosystem-groups.{name}")) {
                config.multi_groups.push(group);
            }
        }
    }
    match root.get("updates") {
        None => reader.problem(&root, "updates", "`updates` is required: a list of entries, one per package ecosystem and directory."),
        Some(updates) => match &updates.value {
            Value::Seq(items) => {
                if items.len() > MAX_ENTRIES {
                    reader.problem(updates, "updates", format!("The file has {} entries; it may have at most {MAX_ENTRIES}.", items.len()));
                }
                for (index, item) in items.iter().enumerate() {
                    let Some(entry) = reader.entry(index, item, &config) else { continue };
                    let overlap = config.updates.iter().find(|other| {
                        other.ecosystem == entry.ecosystem
                            && other.target_branch == entry.target_branch
                            && other.directories.iter().any(|directory| entry.directories.contains(directory))
                    });
                    if let Some(other) = overlap {
                        reader.problem(
                            item,
                            &format!("updates[{index}]"),
                            format!(
                                "{} in {} is already covered by the entry on line {}; each ecosystem, directory and target branch is listed once.",
                                entry.ecosystem,
                                entry.directories.join(", "),
                                other.line
                            ),
                        );
                    }
                    config.updates.push(entry);
                }
            }
            _ => reader.problem(updates, "updates", format!("`updates` must be a list of entries, not {}.", updates.kind())),
        },
    }
    reader.problems.sort_by_key(|problem| (problem.line, problem.column));
    Read { config, problems: reader.problems }
}

/// The label an update for `ecosystem` carries beside `dependencies` when
/// its entry names none: the language or tool it is for.
pub fn ecosystem_label(ecosystem: &str) -> Option<&'static str> {
    Some(match ecosystem {
        "npm" | "bun" => "javascript",
        "cargo" => "rust",
        "pip" | "uv" | "poetry" | "pipenv" | "pip-compile" => "python",
        "gomod" => "go",
        "bundler" => "ruby",
        "maven" | "gradle" => "java",
        "composer" => "php",
        "nuget" | "dotnet-sdk" => ".NET",
        "docker" | "docker-compose" => "docker",
        "github-actions" => "github_actions",
        "mix" => "elixir",
        "pub" => "dart",
        "swift" => "swift",
        "terraform" => "terraform",
        "elm" => "elm",
        "gitsubmodule" => "submodules",
        "helm" => "helm",
        "devcontainers" => "devcontainers",
        _ => return None,
    })
}

/// The labels an update pull request carries: the entry's `labels`, none
/// for an empty list, and without the option `dependencies` and the
/// ecosystem's label. Labels the repository lacks are created.
pub fn update_labels(labels: Option<&[String]>, ecosystem: &str) -> Vec<String> {
    match labels {
        Some(labels) => labels.to_vec(),
        None => std::iter::once("dependencies")
            .chain(ecosystem_label(ecosystem))
            .map(|label| label.to_lowercase())
            .collect(),
    }
}

/// Which options of `entry` g1t reads but does not act on, each with why,
/// for the Security page and the docs' promise that nothing is silently
/// ignored.
/// `labels`, `milestone` and `target-branch` are acted on: see
/// [`update_labels`] and the pull request's base.
pub fn notes(entry: &Entry, _default_branch: Option<&str>) -> Vec<String> {
    let mut notes = Vec::new();
    if !entry.supported() {
        notes.push(format!(
            "g1t does not open version update pull requests for {} yet; it opens them for {}. The entry is read and checked.",
            entry.ecosystem,
            SUPPORTED.join(", ")
        ));
    }
    if entry.vendor {
        notes.push("vendor: vendored copies of dependencies are not updated.".to_owned());
    }
    if entry.multi_ecosystem_group.is_some() {
        notes.push(
            "multi-ecosystem-group: the group's schedule is used, and its updates open one pull request per ecosystem rather than one for the group."
                .to_owned(),
        );
    }
    if entry.insecure_external_code_execution.as_deref() == Some("allow") {
        notes.push("insecure-external-code-execution: g1t never runs a manifest's code while updating it.".to_owned());
    }
    if !entry.patterns.is_empty() && entry.multi_ecosystem_group.is_none() {
        notes.push("patterns: only read for an entry in a multi-ecosystem group.".to_owned());
    }
    notes
}

/// Package names matched as the file's patterns are: `*` stands for any
/// run of characters, and case is ignored.
pub fn matches(pattern: &str, name: &str) -> bool {
    let pattern = pattern.to_lowercase();
    let name = name.to_lowercase();
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == name;
    }
    let mut rest = name.as_str();
    for (index, part) in parts.iter().enumerate() {
        if index == 0 {
            let Some(after) = rest.strip_prefix(part) else { return false };
            rest = after;
        } else if index == parts.len() - 1 {
            return rest.ends_with(part);
        } else {
            let Some(at) = rest.find(part) else { return false };
            rest = &rest[at + part.len()..];
        }
    }
    true
}

/// Paths matched as `directories` and `exclude-paths` globs: `*` within one
/// segment, `**` across any number, `?` for one character.
pub fn glob(pattern: &str, path: &str) -> bool {
    fn segments(pattern: &[&str], path: &[&str]) -> bool {
        match (pattern.first(), path.first()) {
            (None, None) => true,
            (Some(&"**"), _) => segments(&pattern[1..], path) || (!path.is_empty() && segments(pattern, &path[1..])),
            (Some(part), Some(name)) => segment(part, name) && segments(&pattern[1..], &path[1..]),
            _ => false,
        }
    }
    fn segment(pattern: &str, name: &str) -> bool {
        let (p, n): (Vec<char>, Vec<char>) = (pattern.chars().collect(), name.chars().collect());
        fn go(p: &[char], n: &[char]) -> bool {
            match (p.first(), n.first()) {
                (None, None) => true,
                (Some('*'), _) => go(&p[1..], n) || (!n.is_empty() && go(p, &n[1..])),
                (Some('?'), Some(_)) => go(&p[1..], &n[1..]),
                (Some(a), Some(b)) => a == b && go(&p[1..], &n[1..]),
                _ => false,
            }
        }
        go(&p, &n)
    }
    let split = |text: &str| -> Vec<String> { text.trim_matches('/').split('/').filter(|part| !part.is_empty()).map(str::to_owned).collect() };
    let (pattern, path) = (split(pattern), split(path));
    let pattern: Vec<&str> = pattern.iter().map(String::as_str).collect();
    let path: Vec<&str> = path.iter().map(String::as_str).collect();
    segments(&pattern, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn problems(source: &str) -> Vec<String> {
        read(source).problems.iter().map(ConfigProblem::sentence).collect()
    }

    fn only(source: &str) -> Entry {
        let found = read(source);
        assert!(found.problems.is_empty(), "{:?}", found.problems);
        found.config.updates.into_iter().next().unwrap()
    }

    #[test]
    fn every_option_is_read() {
        let source = r#"
version: 2
enable-beta-ecosystems: false
registries:
  npm-acme:
    type: npm-registry
    url: https://npm.acme.dev
    token: ${{secrets.ACME_NPM_TOKEN}}
    replaces-base: true
    scope: "@acme"
  pypi:
    type: python-index
    url: https://pypi.acme.dev/simple
    username: ci
    password: ${{ secrets.PYPI_PASSWORD }}
multi-ecosystem-groups:
  infrastructure:
    schedule:
      interval: weekly
    assignees: ["ana"]
updates:
  - package-ecosystem: npm
    directories: ["/", "/packages/*"]
    schedule:
      interval: weekly
      day: tuesday
      time: "09:30"
      timezone: Europe/Berlin
    allow:
      - dependency-type: production
      - dependency-name: "@acme/*"
        update-types: ["version-update:semver-minor"]
    ignore:
      - dependency-name: react
        versions: [">=19"]
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]
      - dependency-name: left-pad
        versions: "1.x"
    groups:
      lint:
        patterns: ["eslint*", "@typescript-eslint/*"]
        exclude-patterns: ["eslint-plugin-legacy"]
        update-types: [minor, patch]
        dependency-type: development
      fixes:
        applies-to: security-updates
        patterns: ["*"]
      everything:
        group-by: dependency-name
    cooldown:
      default-days: 5
      semver-major-days: 30
      semver-minor-days: 7
      semver-patch-days: 0
      include: ["*"]
      exclude: ["@acme/*"]
    assignees: [ana]
    reviewers: [ben]
    labels: [deps, javascript]
    milestone: 4
    commit-message:
      prefix: "build"
      prefix-development: chore
      include: scope
    open-pull-requests-limit: 10
    pull-request-branch-name:
      separator: "-"
      prefix: deps
      max-length: 80
      word-separator: "-"
      branch-name-case: lowercase
      template: "{prefix}/{package_manager}/{name}"
    rebase-strategy: disabled
    target-branch: develop
    versioning-strategy: increase-if-necessary
    insecure-external-code-execution: deny
    exclude-paths: ["vendor/**", "src/test/assets"]
    registries: ["npm-acme"]
    name: Web dependencies
  - package-ecosystem: pip
    directory: /
    registries: "*"
    vendor: false
    schedule:
      interval: cron
      cronjob: "every weekday at 6am"
  - package-ecosystem: docker
    directory: /
    patterns: ["nginx"]
    multi-ecosystem-group: infrastructure
"#;
        let found = read(source);
        assert!(found.problems.is_empty(), "{:?}", found.problems);
        let config = found.config;
        assert_eq!(config.registries.len(), 2);
        assert_eq!(config.registries[0].info().secrets, ["ACME_NPM_TOKEN"]);
        assert_eq!(config.registries[1].info().secrets, ["PYPI_PASSWORD"]);
        assert_eq!(config.registries[0].scopes, ["@acme"]);
        let npm = &config.updates[0];
        assert_eq!(npm.directories, ["/", "/packages/*"]);
        let schedule = npm.schedule.as_ref().unwrap();
        assert_eq!((schedule.interval, schedule.day, schedule.time), (Interval::Weekly, Some(2), Some((9, 30))));
        assert_eq!(schedule.timezone.as_deref(), Some("Europe/Berlin"));
        assert_eq!(npm.allow.len(), 2);
        assert_eq!(npm.ignore[1], UpdateIgnore { dependency: "*".into(), versions: vec![], update_types: vec!["version-update:semver-major".into()] });
        assert_eq!(npm.ignore[2].versions, ["1.x"]);
        assert_eq!(npm.groups.len(), 3);
        assert_eq!(npm.groups[0].update_types, ["minor", "patch"]);
        assert_eq!(npm.groups[0].dependency_type.as_deref(), Some("development"));
        assert_eq!(npm.groups[1].applies_to, "security-updates");
        assert_eq!(npm.groups[2].group_by.as_deref(), Some("dependency-name"));
        assert_eq!(npm.cooldown.as_ref().unwrap().patch_days, Some(0));
        assert_eq!(npm.commit_message, Some(CommitMessage { prefix: Some("build".into()), prefix_development: Some("chore".into()), scope: true }));
        assert_eq!(npm.open_pull_requests_limit, 10);
        assert_eq!(npm.branch_name.separator, "-");
        assert_eq!(npm.branch_name.template.as_deref(), Some("{prefix}/{package_manager}/{name}"));
        assert_eq!(npm.rebase_strategy, "disabled");
        assert_eq!(npm.target_branch.as_deref(), Some("develop"));
        assert_eq!(npm.versioning_strategy.as_deref(), Some("increase-if-necessary"));
        assert_eq!(npm.milestone, Some(4));
        assert_eq!(npm.labels.as_deref(), Some(&["deps".to_owned(), "javascript".to_owned()][..]));
        assert_eq!(npm.id(), "npm:/,/packages/*@develop");
        assert_eq!(npm.options["commit-message"]["prefix"], "build");
        let pip = &config.updates[1];
        assert_eq!(pip.registries, ["npm-acme", "pypi"]);
        assert_eq!(pip.schedule.as_ref().unwrap().cron.as_deref(), Some("0 6 * * 1-5"));
        let docker = &config.updates[2];
        assert!(!docker.supported());
        assert_eq!(docker.schedule.as_ref().unwrap().interval, Interval::Weekly);
        assert!(notes(docker, Some("main")).iter().any(|note| note.contains("does not open version update pull requests for docker")));
        // labels, milestone and target-branch are acted on, so nothing is said of them.
        assert!(!notes(npm, Some("main")).iter().any(|note| {
            note.starts_with("target-branch") || note.starts_with("labels") || note.starts_with("milestone")
        }));
        assert_eq!(update_labels(npm.labels.as_deref(), &npm.ecosystem), ["deps", "javascript"]);
        assert_eq!(update_labels(None, "cargo"), ["dependencies", "rust"]);
        assert_eq!(update_labels(None, "github-actions"), ["dependencies", "github_actions"]);
        assert_eq!(update_labels(None, "nuget"), ["dependencies", ".net"]);
        assert_eq!(update_labels(Some(&[]), "npm"), Vec::<String>::new());
    }

    #[test]
    fn defaults() {
        let entry = only("version: 2\nupdates:\n  - package-ecosystem: cargo\n    directory: \"/\"\n    schedule:\n      interval: daily\n");
        assert_eq!(entry.directories, ["/"]);
        assert_eq!(entry.open_pull_requests_limit, 5);
        assert_eq!(entry.rebase_strategy, "auto");
        assert_eq!(entry.branch_name, BranchName::default());
        assert_eq!(entry.labels, None);
        assert!(entry.supported());
        // The version may be written as text.
        assert!(read("version: \"2\"\nupdates: []\n").problems.is_empty());
        // A directory is written with or without its slashes.
        assert_eq!(only("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: web/app/\n    schedule: {interval: weekly}\n").directories, ["/web/app"]);
    }

    #[test]
    fn problems_name_their_line_and_key() {
        for (source, said) in [
            ("updates: []", "version: `version: 2` is required."),
            ("version: 1\nupdates: []", "line 1, version: The version must be 2, not 1."),
            ("version: 2", "updates: `updates` is required"),
            ("version: 2\nupdates: []\nextra: 1", "line 3, `extra` is not an option of the file."),
            ("version: 2\nupdates: {}", "line 2, updates: `updates` must be a list of entries, not a mapping."),
            ("version: 2\nupdates:\n  - directory: /\n    schedule: {interval: daily}", "line 3, updates[0]: `package-ecosystem` is required"),
            ("version: 2\nupdates:\n  - package-ecosystem: npmx\n    directory: /\n    schedule: {interval: daily}", "line 3, updates[0].package-ecosystem: `npmx` is not a package ecosystem"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    schedule: {interval: daily}", "`directory` (or `directories`) is required"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    directories: [/]\n    schedule: {interval: daily}", "not both"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n", "`schedule` is required"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: hourly\n", "line 6, updates[0].schedule.interval: `hourly` is not an interval. Use `daily`, `weekly`, `monthly`, `quarterly`, `semiannually`, `yearly` or `cron`."),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n      day: someday\n", "`someday` is not a day of the week"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n      time: \"9am\"\n", "`9am` is not a time"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n      timezone: Mars/Base\n", "`Mars/Base` is not a time zone"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: cron\n", "`cronjob` is required"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: cron\n      cronjob: \"whenever\"\n", "neither a cron expression"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    open-pull-requests-limit: -1\n", "whole number of 0 or more"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    labels: deps\n", "This must be a list, not text."),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    assignees: []\n", "This list must not be empty."),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    reviewers: [a, a]\n", "`a` is listed twice."),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    groups:\n      lint:\n        pattern: [x]\n", "`pattern` is not an option of a group."),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    groups:\n      \"-bad\":\n        patterns: [x]\n", "A group's name starts and ends"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    groups:\n      a:\n        update-types: [huge]\n", "`huge` is not an update type"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    ignore:\n      - {}\n", "An `ignore` rule needs"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    ignore:\n      - dependency-name: x\n        update-types: [major]\n", "`major` is not an update type. Use `version-update:semver-major`"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    allow:\n      - update-types: [\"version-update:semver-patch\"]\n", "An `allow` rule needs dependency-name or dependency-type."),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    allow:\n      - dependency-type: dev\n", "`dev` is not a dependency type"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    cooldown:\n      default-days: 91\n", "from 1 to 90"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    commit-message:\n      prefix: \"012345678901234567890123456789012345678901234567890\"\n", "at most 50 characters"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    commit-message:\n      include: everything\n", "`everything` is not something `include` takes"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    pull-request-branch-name:\n      separator: \"+\"\n", "`+` is not a separator"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    pull-request-branch-name:\n      template: \"{prefix}/{nope}\"\n", "`{nope}` is not a placeholder"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    rebase-strategy: squashed\n", "`squashed` is not a rebase strategy"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    versioning-strategy: newest\n", "`newest` is not a versioning strategy"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    registries: [nope]\n", "`nope` is not one of the registries"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    vendor: yes\n", "This must be true or false"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    milestone: 0\n", "whole number of 1 or more"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    target-branch: \"a b\"\n", "is not a branch name"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n    multi-ecosystem-group: nope\n    patterns: [\"*\"]\n", "`nope` is not one of the groups"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: ../x\n    schedule: {interval: daily}\n", "must stay inside the repository"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /packages/*\n    schedule: {interval: daily}\n", "use `directories` for globs"),
            ("version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: daily}\n  - package-ecosystem: npm\n    directories: [/, /web]\n    schedule: {interval: daily}\n", "already covered by the entry on line 3"),
            ("version: 2\nregistries:\n  r:\n    type: npm\n    url: https://x\nupdates: []\n", "`npm` is not a registry type"),
            ("version: 2\nregistries:\n  r:\n    type: npm-registry\nupdates: []\n", "`url` is required."),
            ("version: 2\nregistries:\n  r:\n    type: npm-registry\n    url: https://x\n    scope: acme\nupdates: []\n", "`acme` is not an npm scope"),
            ("version: 2\nregistries:\n  r:\n    type: npm-registry\n    url: https://x\n    secret: y\nupdates: []\n", "`secret` is not an option of a registry."),
            ("version: 2\nmulti-ecosystem-groups:\n  infra: {}\nupdates: []\n", "`schedule` is required."),
            ("version: 2\nupdates: [\n", "This is not valid YAML"),
            ("[1, 2]", "The file must be a mapping"),
        ] {
            let found = problems(source);
            assert!(found.iter().any(|problem| problem.contains(said)), "{source:?}\nexpected {said:?}\ngot {found:?}");
        }
    }

    /// Real projects' files, as published, and one with every option: each
    /// is read without a problem.
    #[test]
    fn real_world_files_are_read() {
        let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/dependabot");
        let mut read_files = 0;
        for file in std::fs::read_dir(&folder).unwrap() {
            let path = file.unwrap().path();
            let text = std::fs::read_to_string(&path).unwrap();
            let found = read(&text);
            assert!(found.problems.is_empty(), "{}: {:?}", path.display(), found.problems);
            assert!(!found.config.updates.is_empty(), "{}", path.display());
            read_files += 1;
        }
        assert!(read_files >= 20, "{read_files} fixtures");
        let every = read(&std::fs::read_to_string(folder.join("every-option.yml")).unwrap()).config;
        assert_eq!(every.registries.len(), 7);
        assert!(every.registries.iter().find(|registry| registry.name == "artifactory").unwrap().oidc);
        assert_eq!(every.multi_groups[0].open_pull_requests_limit, Some(3));
        assert_eq!(every.updates.len(), 9);
        assert_eq!(every.updates[0].directories, ["/", "/apps/*", "/packages/**"]);
        assert_eq!(every.updates[1].open_pull_requests_limit, 0);
        assert_eq!(every.updates[3].registries.len(), 7);
        assert_eq!(every.updates[4].schedule.as_ref().unwrap().day, Some(3));
        assert_eq!(every.updates.iter().filter(|entry| entry.supported()).count(), 4);
    }

    #[test]
    fn beta_ecosystems_are_accepted_when_enabled() {
        let source = "version: 2\nenable-beta-ecosystems: true\nupdates:\n  - package-ecosystem: fortran\n    directory: /\n    schedule: {interval: daily}\n";
        let entry = only(source);
        assert!(!entry.supported());
    }

    #[test]
    fn every_problem_is_reported_not_just_the_first() {
        let source = "version: 3\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: {interval: hourly}\n    labelz: []\n";
        let found = read(source).problems;
        assert_eq!(found.len(), 3, "{found:?}");
        assert_eq!(found.iter().map(|problem| problem.line).collect::<Vec<_>>(), [1, 5, 6]);
    }

    #[test]
    fn patterns_and_globs() {
        assert!(matches("eslint*", "eslint-plugin-react"));
        assert!(matches("@types/*", "@types/node"));
        assert!(matches("*", "anything"));
        assert!(matches("*react*", "preact-render"));
        assert!(matches("React", "react"));
        assert!(!matches("eslint*", "typescript-eslint"));
        assert!(glob("/packages/*", "/packages/web"));
        assert!(!glob("/packages/*", "/packages/web/sub"));
        assert!(glob("/apps/**", "/apps/web/sub"));
        assert!(glob("**/*.md", "docs/guide.md"));
        assert!(glob("vendor/**", "vendor/a/b/package.json"));
        assert!(glob("src/*.js", "src/app.js"));
        assert!(!glob("src/*", "src/utils/helper.rb"));
    }

    #[test]
    fn branch_name_parts() {
        assert!(valid_ref_part("deps"));
        assert!(valid_ref_part("release/1.x"));
        for bad in ["", "a b", "-x", "a..b", "x.lock", "a:b", "a~1", "x/"] {
            assert!(!valid_ref_part(bad), "{bad}");
        }
        assert!(template_problem("{prefix}/{package_manager}/{dependency}-{version}").is_none());
        assert!(template_problem("{prefix").unwrap().contains("never closed"));
    }
}
