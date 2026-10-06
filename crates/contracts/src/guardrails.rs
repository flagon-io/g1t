//! Guardrails: what a workspace lets its agents do in a sandbox. Kept by
//! the work service.
//!
//! A workspace sets defaults and each project may override them. Three
//! kinds of rule come out of the two:
//!
//! - **Network**: which hosts a sandbox may reach. g1t's own hosts always,
//!   the package registries the project needs, and any domains listed.
//!   Everything else is refused at the sandbox's edge.
//! - **Commands**: what the agent's harness refuses to run: built-in rules
//!   that can be turned off, and the workspace's own deny patterns.
//! - **Caps**: the most one run may cost, and how long each kind of run
//!   may take, before g1t stops it.
//!
//! Each `*Args` struct is the argument of the method of the same name,
//! served at `POST /rpc/<method>`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::agents::RunKind;
use crate::repos::RepoPath;
use crate::{User, Viewer};

/// g1t's own hosts. Always reachable: without them a sandbox could not
/// clone, push, report or reach its model.
pub const G1T_HOSTS: &[&str] = &["g1t.sh", "api.g1t.sh", "models.g1t.sh", "mcp.g1t.sh"];

/// A package registry, which a project turns on or off as one.
#[derive(Clone, Copy, Debug)]
pub struct Registry {
    pub id: &'static str,
    pub name: &'static str,
    pub hosts: &'static [&'static str],
}

/// The registries a sandbox can be given, all on by default.
pub const REGISTRIES: &[Registry] = &[
    Registry {
        id: "npm",
        name: "npm and Yarn",
        hosts: &["registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com"],
    },
    Registry {
        id: "pypi",
        name: "PyPI",
        hosts: &["pypi.org", "files.pythonhosted.org"],
    },
    Registry {
        id: "crates",
        name: "crates.io and Rust toolchains",
        hosts: &["crates.io", "index.crates.io", "static.crates.io", "static.rust-lang.org"],
    },
    Registry {
        id: "go",
        name: "Go module proxy",
        hosts: &["proxy.golang.org", "sum.golang.org"],
    },
    Registry {
        id: "github",
        name: "GitHub downloads",
        hosts: &[
            "codeload.github.com",
            "raw.githubusercontent.com",
            "objects.githubusercontent.com",
        ],
    },
];

/// A command rule the harness enforces, which can be turned off.
#[derive(Clone, Copy, Debug)]
pub struct CommandRule {
    pub id: &'static str,
    pub title: &'static str,
    pub about: &'static str,
}

/// The built-in command rules, all on by default.
pub const COMMAND_RULES: &[CommandRule] = &[
    CommandRule {
        id: "force_push",
        title: "No force-pushing",
        about: "git push with --force, --force-with-lease, --mirror, a + refspec, or deleting a branch.",
    },
    CommandRule {
        id: "rewrite_default_branch",
        title: "No rewriting the default branch",
        about: "Pushing to the default branch, moving or deleting it with git branch or git update-ref, and git filter-branch, filter-repo or replace.",
    },
    CommandRule {
        id: "outside_workspace",
        title: "No reading files outside the project",
        about: "File tools may use the checked-out project, /tmp and package caches only. Shell commands may not touch g1t's own files or other processes' environments.",
    },
    CommandRule {
        id: "print_env",
        title: "No printing the environment",
        about: "env, printenv, export -p, set, /proc/*/environ, and echoing variables that look like keys or tokens.",
    },
    CommandRule {
        id: "sudo",
        title: "No sudo",
        about: "sudo, su and doas are refused, and the sandbox gives up root before the agent starts.",
    },
];

/// The most deny patterns or domains one level keeps.
pub const MAX_PATTERNS: usize = 50;
pub const MAX_DOMAINS: usize = 100;
const MAX_PATTERN_CHARS: usize = 200;
/// The most a run may be allowed to cost, in US dollars.
pub const MAX_BUDGET_USD: f64 = 100.0;
/// The longest any run may be allowed to take, in minutes.
pub const MAX_MINUTES: u32 = 240;

/// The cost cap on one run unless the workspace sets another, in US dollars.
pub const DEFAULT_BUDGET_USD: f64 = 5.0;

/// How long each kind of run may take unless the workspace says otherwise.
pub fn default_minutes(kind: RunKind) -> u32 {
    match kind {
        RunKind::Implement => 90,
        RunKind::Revise => 60,
        RunKind::Review => 30,
        RunKind::Answer => 20,
        RunKind::Update => 45,
        RunKind::Plan => 30,
        RunKind::Checks => 45,
        RunKind::Queue => 45,
        RunKind::Mergecheck => 10,
    }
}

/// What one level, the workspace or a project, sets. Anything left unset
/// is inherited: a project from its workspace, a workspace from g1t's
/// defaults. Domains and deny patterns add up across the two levels.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GuardrailSettings {
    /// Whether sandboxes may reach only the allowed hosts.
    pub restrict_network: Option<bool>,
    /// The registries that are on, by id. Replaces the inherited list.
    pub registries: Option<Vec<String>>,
    /// More hosts to allow: `example.com`, or `*.example.com` for its
    /// subdomains.
    pub domains: Vec<String>,
    /// Built-in command rules turned on or off, by id.
    pub rules: BTreeMap<String, bool>,
    /// Commands and tools to refuse, as permission rules:
    /// `Bash(terraform apply:*)`, `Read(/etc/**)`, `WebFetch`.
    pub deny: Vec<String>,
    /// The most a run may cost, in US dollars. Zero means no cap.
    pub budget_usd: Option<f64>,
    /// How long a run may take, in minutes, by kind of run.
    pub minutes: BTreeMap<String, u32>,
    /// Username of whoever last changed this level.
    pub updated_by: Option<String>,
    /// RFC 3339.
    pub updated_at: Option<String>,
}

/// The guardrails a run actually gets: g1t's defaults, then the
/// workspace's, then the project's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Guardrails {
    pub restrict_network: bool,
    pub registries: Vec<String>,
    /// The domains listed at either level, workspace first.
    pub domains: Vec<String>,
    /// Every host a sandbox may reach: g1t's, the registries', the domains.
    pub hosts: Vec<String>,
    /// Every built-in rule, on or off.
    pub rules: BTreeMap<String, bool>,
    /// The deny patterns of both levels, workspace first.
    pub deny: Vec<String>,
    /// None: no cap.
    pub budget_usd: Option<f64>,
    /// Every kind of run.
    pub minutes: BTreeMap<String, u32>,
}

impl Guardrails {
    /// g1t's defaults: network restricted to g1t and every registry, every
    /// command rule on, a cost cap and a time cap for each kind of run.
    pub fn defaults() -> Self {
        let mut defaults = Guardrails {
            restrict_network: true,
            registries: REGISTRIES.iter().map(|registry| registry.id.to_owned()).collect(),
            domains: Vec::new(),
            hosts: Vec::new(),
            rules: COMMAND_RULES.iter().map(|rule| (rule.id.to_owned(), true)).collect(),
            deny: Vec::new(),
            budget_usd: Some(DEFAULT_BUDGET_USD),
            minutes: RunKind::ALL
                .into_iter()
                .map(|kind| (kind.as_str().to_owned(), default_minutes(kind)))
                .collect(),
        };
        defaults.hosts = defaults.allowed_hosts();
        defaults
    }

    /// One level laid over what it inherits.
    pub fn apply(mut self, level: &GuardrailSettings) -> Self {
        if let Some(restrict) = level.restrict_network {
            self.restrict_network = restrict;
        }
        if let Some(registries) = &level.registries {
            self.registries = REGISTRIES
                .iter()
                .filter(|registry| registries.iter().any(|id| id == registry.id))
                .map(|registry| registry.id.to_owned())
                .collect();
        }
        for domain in &level.domains {
            if !self.domains.contains(domain) {
                self.domains.push(domain.clone());
            }
        }
        for (id, on) in &level.rules {
            if let Some(rule) = self.rules.get_mut(id) {
                *rule = *on;
            }
        }
        for pattern in &level.deny {
            if !self.deny.contains(pattern) {
                self.deny.push(pattern.clone());
            }
        }
        if let Some(budget) = level.budget_usd {
            self.budget_usd = (budget > 0.0).then_some(budget);
        }
        for (kind, minutes) in &level.minutes {
            if let Some(cap) = self.minutes.get_mut(kind) {
                *cap = *minutes;
            }
        }
        self.hosts = self.allowed_hosts();
        self
    }

    /// The workspace's defaults with a project's overrides on top.
    pub fn merge(workspace: &GuardrailSettings, project: Option<&GuardrailSettings>) -> Self {
        let inherited = Guardrails::defaults().apply(workspace);
        match project {
            Some(project) => inherited.apply(project),
            None => inherited,
        }
    }

    fn allowed_hosts(&self) -> Vec<String> {
        let mut hosts: Vec<String> = G1T_HOSTS.iter().map(|host| (*host).to_owned()).collect();
        for registry in REGISTRIES {
            if self.registries.iter().any(|id| id == registry.id) {
                hosts.extend(registry.hosts.iter().map(|host| (*host).to_owned()));
            }
        }
        for domain in &self.domains {
            if !hosts.contains(domain) {
                hosts.push(domain.clone());
            }
        }
        hosts
    }

    /// The time cap of a kind of run, in minutes.
    pub fn minutes_for(&self, kind: RunKind) -> u32 {
        self.minutes
            .get(kind.as_str())
            .copied()
            .unwrap_or_else(|| default_minutes(kind))
    }
}

/// A domain as it is kept: lower case, no scheme, path or port, optionally
/// `*.` for its subdomains. Refused if it is not a host name.
pub fn normalize_domain(input: &str) -> Result<String, String> {
    let mut domain = input.trim().to_lowercase();
    for scheme in ["https://", "http://"] {
        if let Some(rest) = domain.strip_prefix(scheme) {
            domain = rest.to_owned();
        }
    }
    if let Some(at) = domain.find(['/', ':']) {
        domain.truncate(at);
    }
    let domain = domain.trim_end_matches('.').to_owned();
    let bare = domain.strip_prefix("*.").unwrap_or(&domain);
    let labels: Vec<&str> = bare.split('.').collect();
    let valid = labels.len() >= 2
        && bare.len() <= 253
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    if valid {
        Ok(domain)
    } else {
        Err(format!("{} is not a domain. Use a host name such as example.com, or *.example.com for its subdomains.", input.trim()))
    }
}

/// A deny pattern as it is kept: a permission rule such as
/// `Bash(terraform apply:*)`. Plain text is taken as the start of a shell
/// command: `rm -rf` becomes `Bash(rm -rf:*)`.
pub fn normalize_pattern(input: &str) -> Result<String, String> {
    let pattern = input.trim();
    if pattern.is_empty() || pattern.chars().count() > MAX_PATTERN_CHARS || pattern.contains('\n') {
        return Err(format!("A deny pattern is one line of at most {MAX_PATTERN_CHARS} characters."));
    }
    let tool_end = pattern.find('(').unwrap_or(pattern.len());
    let tool = &pattern[..tool_end];
    let is_rule = !tool.is_empty()
        && tool.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && tool.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && (tool_end == pattern.len() || (pattern.ends_with(')') && pattern.len() > tool_end + 2));
    if is_rule {
        return Ok(pattern.to_owned());
    }
    if pattern.contains(['(', ')']) {
        return Err(format!(
            "{pattern} is not a rule. Write a tool and what to refuse, such as Bash(terraform apply:*), or just the start of a command."
        ));
    }
    Ok(format!("Bash({pattern}:*)"))
}

/// One level's settings, checked and tidied before they are kept.
pub fn validate(settings: GuardrailSettings) -> Result<GuardrailSettings, String> {
    let mut domains = Vec::new();
    for domain in &settings.domains {
        if domain.trim().is_empty() {
            continue;
        }
        let domain = normalize_domain(domain)?;
        if !domains.contains(&domain) {
            domains.push(domain);
        }
    }
    if domains.len() > MAX_DOMAINS {
        return Err(format!("At most {MAX_DOMAINS} domains can be listed."));
    }
    let mut deny = Vec::new();
    for pattern in &settings.deny {
        if pattern.trim().is_empty() {
            continue;
        }
        let pattern = normalize_pattern(pattern)?;
        if !deny.contains(&pattern) {
            deny.push(pattern);
        }
    }
    if deny.len() > MAX_PATTERNS {
        return Err(format!("At most {MAX_PATTERNS} deny patterns can be listed."));
    }
    if let Some(budget) = settings.budget_usd
        && (!budget.is_finite() || !(0.0..=MAX_BUDGET_USD).contains(&budget))
    {
        return Err(format!("A run's cost cap is between $0 (no cap) and ${MAX_BUDGET_USD:.0}."));
    }
    let mut minutes = BTreeMap::new();
    for (kind, cap) in settings.minutes {
        if RunKind::parse(&kind).is_none() {
            return Err(format!("{kind} is not a kind of run."));
        }
        if !(1..=MAX_MINUTES).contains(&cap) {
            return Err(format!("A run's time cap is between 1 and {MAX_MINUTES} minutes."));
        }
        minutes.insert(kind, cap);
    }
    let rules = settings
        .rules
        .into_iter()
        .filter(|(id, _)| COMMAND_RULES.iter().any(|rule| rule.id == id))
        .collect();
    let registries = settings.registries.map(|ids| {
        REGISTRIES
            .iter()
            .filter(|registry| ids.iter().any(|id| id == registry.id))
            .map(|registry| registry.id.to_owned())
            .collect()
    });
    Ok(GuardrailSettings {
        restrict_network: settings.restrict_network,
        registries,
        domains,
        rules,
        deny,
        budget_usd: settings.budget_usd,
        minutes,
        updated_by: settings.updated_by,
        updated_at: settings.updated_at,
    })
}

/// A registry as the settings page shows it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RegistryInfo {
    pub id: String,
    pub name: String,
    pub hosts: Vec<String>,
}

/// A command rule as the settings page shows it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuleInfo {
    pub id: String,
    pub title: String,
    pub about: String,
}

/// Everything the settings pages show: each level as it was set, what
/// each inherits, and what is in force.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardrailsView {
    pub workspace: GuardrailSettings,
    /// None when no project was asked about.
    pub project: Option<GuardrailSettings>,
    pub defaults: Guardrails,
    /// g1t's defaults with the workspace's: what a project inherits.
    pub inherited: Guardrails,
    /// What runs get: the project's, or with no project, the workspace's.
    pub effective: Guardrails,
    pub g1t_hosts: Vec<String>,
    pub registries: Vec<RegistryInfo>,
    pub rules: Vec<RuleInfo>,
}

impl GuardrailsView {
    pub fn new(workspace: GuardrailSettings, project: Option<GuardrailSettings>) -> Self {
        let inherited = Guardrails::merge(&workspace, None);
        let effective = Guardrails::merge(&workspace, project.as_ref());
        GuardrailsView {
            workspace,
            project,
            defaults: Guardrails::defaults(),
            inherited,
            effective,
            g1t_hosts: G1T_HOSTS.iter().map(|host| (*host).to_owned()).collect(),
            registries: REGISTRIES
                .iter()
                .map(|registry| RegistryInfo {
                    id: registry.id.to_owned(),
                    name: registry.name.to_owned(),
                    hosts: registry.hosts.iter().map(|host| (*host).to_owned()).collect(),
                })
                .collect(),
            rules: COMMAND_RULES
                .iter()
                .map(|rule| RuleInfo {
                    id: rule.id.to_owned(),
                    title: rule.title.to_owned(),
                    about: rule.about.to_owned(),
                })
                .collect(),
        }
    }
}

/// `get_guardrails`: a workspace's guardrails, and with `repo`, that
/// project's too. Members only. Returns `Outcome<GuardrailsView>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetGuardrailsArgs {
    pub viewer: Viewer,
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
}

/// `update_guardrails`: replaces one level's settings: the workspace's
/// (owners only) or, with `repo`, that project's (members). Returns
/// `Outcome<GuardrailsView>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateGuardrailsArgs {
    pub actor: User,
    pub workspace: String,
    #[serde(default)]
    pub repo: Option<RepoPath>,
    pub settings: GuardrailSettings,
}

/// `run_guardrails`: what a run in `repo` gets. For the runner service,
/// which is trusted. Returns `Outcome<Guardrails>`.
///
/// A run's guardrails are always its project's: `repo_id`, when given,
/// names that repository however it has moved since, and a pull
/// request's working copy (`pulls/<pull id>`) stands for the repository
/// the pull request is to.
#[derive(Debug, Serialize, Deserialize)]
pub struct RunGuardrailsArgs {
    pub repo: RepoPath,
    #[serde(default)]
    pub repo_id: Option<String>,
}

/// Why g1t stopped a run by itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Halt {
    /// It reached its cost cap.
    Budget,
    /// It reached its time cap.
    Time,
    /// Its sandbox looked like it was mining cryptocurrency: CPU pinned for
    /// a long time with little I/O and no progress. Held for review.
    Abuse,
}

impl Halt {
    pub fn as_str(self) -> &'static str {
        match self {
            Halt::Budget => "budget",
            Halt::Time => "time",
            Halt::Abuse => "abuse",
        }
    }

    pub fn parse(value: &str) -> Option<Halt> {
        [Halt::Budget, Halt::Time, Halt::Abuse].into_iter().find(|halt| halt.as_str() == value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level() -> GuardrailSettings {
        GuardrailSettings::default()
    }

    #[test]
    fn defaults_restrict_to_g1t_and_every_registry() {
        let defaults = Guardrails::defaults();
        assert!(defaults.restrict_network);
        assert!(defaults.hosts.iter().any(|host| host == "api.g1t.sh"));
        assert!(defaults.hosts.iter().any(|host| host == "registry.npmjs.org"));
        assert!(defaults.hosts.iter().any(|host| host == "codeload.github.com"));
        assert!(!defaults.hosts.iter().any(|host| host == "github.com"));
        assert!(defaults.rules.values().all(|on| *on));
        assert_eq!(defaults.budget_usd, Some(DEFAULT_BUDGET_USD));
        assert_eq!(defaults.minutes_for(RunKind::Implement), 90);
    }

    #[test]
    fn nothing_set_inherits_everything() {
        assert_eq!(Guardrails::merge(&level(), Some(&level())), Guardrails::defaults());
    }

    #[test]
    fn a_project_overrides_its_workspace() {
        let workspace = GuardrailSettings {
            registries: Some(vec!["npm".into(), "pypi".into()]),
            budget_usd: Some(2.0),
            rules: BTreeMap::from([("sudo".to_owned(), false)]),
            minutes: BTreeMap::from([("implement".to_owned(), 30)]),
            ..level()
        };
        let project = GuardrailSettings {
            registries: Some(vec!["crates".into()]),
            budget_usd: Some(8.0),
            rules: BTreeMap::from([("sudo".to_owned(), true), ("print_env".to_owned(), false)]),
            ..level()
        };
        let inherited = Guardrails::merge(&workspace, None);
        assert_eq!(inherited.registries, vec!["npm", "pypi"]);
        assert_eq!(inherited.budget_usd, Some(2.0));
        assert!(!inherited.rules["sudo"]);
        assert!(inherited.hosts.iter().any(|host| host == "pypi.org"));
        assert!(!inherited.hosts.iter().any(|host| host == "crates.io"));

        let effective = Guardrails::merge(&workspace, Some(&project));
        assert_eq!(effective.registries, vec!["crates"]);
        assert!(effective.hosts.iter().any(|host| host == "crates.io"));
        assert!(!effective.hosts.iter().any(|host| host == "pypi.org"));
        assert_eq!(effective.budget_usd, Some(8.0));
        assert!(effective.rules["sudo"]);
        assert!(!effective.rules["print_env"]);
        // Inherited where the project says nothing.
        assert_eq!(effective.minutes_for(RunKind::Implement), 30);
        assert_eq!(effective.minutes_for(RunKind::Review), 30);
        // g1t's own hosts can never be turned off.
        assert!(effective.hosts.iter().any(|host| host == "g1t.sh"));
    }

    #[test]
    fn domains_and_deny_patterns_add_up() {
        let workspace = GuardrailSettings {
            domains: vec!["api.stripe.com".into()],
            deny: vec!["Bash(terraform apply:*)".into()],
            ..level()
        };
        let project = GuardrailSettings {
            domains: vec!["*.example.com".into(), "api.stripe.com".into()],
            deny: vec!["Bash(kubectl:*)".into()],
            ..level()
        };
        let effective = Guardrails::merge(&workspace, Some(&project));
        assert_eq!(effective.domains, vec!["api.stripe.com", "*.example.com"]);
        assert_eq!(effective.deny, vec!["Bash(terraform apply:*)", "Bash(kubectl:*)"]);
        assert!(effective.hosts.iter().any(|host| host == "*.example.com"));
    }

    #[test]
    fn a_zero_budget_means_no_cap_and_unrestricted_is_kept() {
        let project = GuardrailSettings {
            budget_usd: Some(0.0),
            restrict_network: Some(false),
            ..level()
        };
        let effective = Guardrails::merge(&level(), Some(&project));
        assert_eq!(effective.budget_usd, None);
        assert!(!effective.restrict_network);
    }

    #[test]
    fn domains_are_tidied_or_refused() {
        assert_eq!(normalize_domain(" HTTPS://Api.Stripe.com/v1 ").unwrap(), "api.stripe.com");
        assert_eq!(normalize_domain("*.example.com").unwrap(), "*.example.com");
        assert_eq!(normalize_domain("example.com:8443").unwrap(), "example.com");
        assert!(normalize_domain("localhost").is_err());
        assert!(normalize_domain("*.*.com").is_err());
        assert!(normalize_domain("exa mple.com").is_err());
        assert!(normalize_domain("*").is_err());
    }

    #[test]
    fn plain_text_patterns_become_shell_rules() {
        assert_eq!(normalize_pattern("rm -rf").unwrap(), "Bash(rm -rf:*)");
        assert_eq!(normalize_pattern("Bash(git push --force:*)").unwrap(), "Bash(git push --force:*)");
        assert_eq!(normalize_pattern("WebFetch").unwrap(), "WebFetch");
        assert_eq!(normalize_pattern("Read(/etc/**)").unwrap(), "Read(/etc/**)");
        assert!(normalize_pattern("Bash()").is_err());
        assert!(normalize_pattern("echo (x").is_err());
        assert!(normalize_pattern("").is_err());
    }

    #[test]
    fn validation_clamps_and_drops_unknowns() {
        let settings = validate(GuardrailSettings {
            registries: Some(vec!["npm".into(), "nonsense".into()]),
            rules: BTreeMap::from([("force_push".to_owned(), false), ("made_up".to_owned(), true)]),
            domains: vec!["Example.com".into(), "example.com".into(), " ".into()],
            ..level()
        })
        .unwrap();
        assert_eq!(settings.registries, Some(vec!["npm".to_owned()]));
        assert_eq!(settings.rules.len(), 1);
        assert_eq!(settings.domains, vec!["example.com"]);
        assert!(validate(GuardrailSettings { budget_usd: Some(1000.0), ..level() }).is_err());
        assert!(validate(GuardrailSettings { budget_usd: Some(f64::NAN), ..level() }).is_err());
        assert!(
            validate(GuardrailSettings {
                minutes: BTreeMap::from([("implement".to_owned(), 0)]),
                ..level()
            })
            .is_err()
        );
        assert!(
            validate(GuardrailSettings {
                minutes: BTreeMap::from([("lunch".to_owned(), 10)]),
                ..level()
            })
            .is_err()
        );
    }
}
