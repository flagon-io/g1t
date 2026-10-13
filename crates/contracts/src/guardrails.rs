//! Guardrails: how long a workspace's runs may take. Kept by the work
//! service.
//!
//! A workspace sets defaults and each project may override them: a time
//! cap for each kind of run, after which g1t stops it. Sandboxes reach the
//! internet as any CI machine does; guardrails say nothing about the
//! network.
//!
//! Levels saved when guardrails also had network rules (restricting the
//! network, package registries, allowed domains and workflow-only
//! domains), command rules, deny patterns and a cost cap still read: those
//! fields are ignored, and dropped when the level is saved again.
//!
//! Each `*Args` struct is the argument of the method of the same name,
//! served at `POST /rpc/<method>`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::agents::RunKind;
use crate::repos::RepoPath;
use crate::{User, Viewer};

/// The longest any run may be allowed to take, in minutes.
pub const MAX_MINUTES: u32 = 240;

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
/// defaults.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GuardrailSettings {
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
    /// Every kind of run.
    pub minutes: BTreeMap<String, u32>,
}

impl Guardrails {
    /// g1t's defaults: a time cap for each kind of run.
    pub fn defaults() -> Self {
        Guardrails {
            minutes: RunKind::ALL
                .into_iter()
                .map(|kind| (kind.as_str().to_owned(), default_minutes(kind)))
                .collect(),
        }
    }

    /// One level laid over what it inherits.
    pub fn apply(mut self, level: &GuardrailSettings) -> Self {
        for (kind, minutes) in &level.minutes {
            if let Some(cap) = self.minutes.get_mut(kind) {
                *cap = *minutes;
            }
        }
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

    /// The time cap of a kind of run, in minutes.
    pub fn minutes_for(&self, kind: RunKind) -> u32 {
        self.minutes
            .get(kind.as_str())
            .copied()
            .unwrap_or_else(|| default_minutes(kind))
    }
}

/// A host name as it is kept: lower case, no scheme, path or port,
/// optionally `*.` for its subdomains. Refused if it is not a host name.
/// The hosts a brokered secret is for are kept this way.
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

/// One level's settings, checked and tidied before they are kept.
pub fn validate(settings: GuardrailSettings) -> Result<GuardrailSettings, String> {
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
    Ok(GuardrailSettings {
        minutes,
        updated_by: settings.updated_by,
        updated_at: settings.updated_at,
    })
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
    fn defaults_cap_every_kind_of_run() {
        let defaults = Guardrails::defaults();
        assert_eq!(defaults.minutes_for(RunKind::Implement), 90);
        assert_eq!(defaults.minutes.len(), RunKind::ALL.len());
    }

    #[test]
    fn nothing_set_inherits_everything() {
        assert_eq!(Guardrails::merge(&level(), Some(&level())), Guardrails::defaults());
    }

    #[test]
    fn a_project_overrides_its_workspace() {
        let workspace = GuardrailSettings {
            minutes: BTreeMap::from([("implement".to_owned(), 30), ("review".to_owned(), 20)]),
            ..level()
        };
        let project = GuardrailSettings {
            minutes: BTreeMap::from([("review".to_owned(), 15)]),
            ..level()
        };
        let inherited = Guardrails::merge(&workspace, None);
        assert_eq!(inherited.minutes_for(RunKind::Review), 20);
        let effective = Guardrails::merge(&workspace, Some(&project));
        // Inherited where the project says nothing.
        assert_eq!(effective.minutes_for(RunKind::Implement), 30);
        assert_eq!(effective.minutes_for(RunKind::Review), 15);
    }

    #[test]
    fn levels_saved_with_network_rules_still_read_and_drop_them() {
        // Network rules, command rules, deny patterns and a cost cap, from
        // before, are ignored, and gone once the level is saved again.
        let old: GuardrailSettings = serde_json::from_str(
            r#"{"restrictNetwork":true,"registries":["npm"],"domains":["example.com"],
                "workflowDomains":[{"domain":"api.cloudflare.com","workflows":["deploy.yml"],"environments":[]}],
                "rules":{"sudo":false},"deny":["Bash(rm:*)"],"budgetUsd":2.5,"minutes":{"implement":45}}"#,
        )
        .unwrap();
        assert_eq!(old.minutes, BTreeMap::from([("implement".to_owned(), 45)]));
        let saved = serde_json::to_value(validate(old).unwrap()).unwrap();
        assert_eq!(saved, serde_json::json!({ "minutes": { "implement": 45 }, "updatedBy": null, "updatedAt": null }));
        // What a run got before reads as its time caps.
        let old: Guardrails = serde_json::from_value(serde_json::json!({
            "restrictNetwork": true, "registries": [], "domains": [], "hosts": ["g1t.sh"], "workflowDomains": [], "minutes": { "implement": 90 }
        }))
        .unwrap();
        assert_eq!(old.minutes_for(RunKind::Implement), 90);
        let sent = serde_json::to_value(Guardrails::defaults()).unwrap();
        assert!(sent.get("restrictNetwork").is_none() && sent.get("hosts").is_none());
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
    fn validation_refuses_bad_caps() {
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
        assert!(
            validate(GuardrailSettings {
                minutes: BTreeMap::from([("implement".to_owned(), MAX_MINUTES)]),
                ..level()
            })
            .is_ok()
        );
    }
}
