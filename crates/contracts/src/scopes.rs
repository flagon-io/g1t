//! Scopes: what an access token may do on its owner's behalf.
//!
//! A personal access token, a workspace's token and an application signed
//! in with OAuth each carry a set of scopes. A token reaches whatever the
//! one it acts as can reach: a person's token, that person's workspaces and
//! repositories; a workspace's token, that workspace. What a request may do
//! is the intersection of two things: the role of whoever the token acts as
//! (see [`crate::access`]) and the token's scopes.
//!
//! Each scope is a resource and a level, written `resource:level`, such as
//! `issues:write`. A higher level of a resource includes the lower ones:
//! `repo:admin` includes `repo:write`, which includes `repo:read`.
//!
//! This module is the one source of truth: the API (REST and MCP) and git
//! enforce it, and identity stores it. `packages/contracts/src/scopes.ts`
//! mirrors the table for the site; a test keeps the two the same.

use serde::{Deserialize, Serialize};

use crate::credentials::Decision;

/// Something a token can be given access to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Resource {
    Account,
    Notifications,
    Workspace,
    Billing,
    Repo,
    Code,
    Security,
    Packages,
    Issues,
    PullRequests,
    Agents,
    Workflows,
    Checks,
    Deployments,
    Memory,
    Access,
    Webhooks,
    Secrets,
    Runners,
    Models,
}

impl Resource {
    pub const ALL: [Resource; 20] = [
        Resource::Repo,
        Resource::Code,
        Resource::Security,
        Resource::Packages,
        Resource::Issues,
        Resource::PullRequests,
        Resource::Agents,
        Resource::Workflows,
        Resource::Checks,
        Resource::Deployments,
        Resource::Memory,
        Resource::Account,
        Resource::Notifications,
        Resource::Workspace,
        Resource::Billing,
        Resource::Access,
        Resource::Webhooks,
        Resource::Secrets,
        Resource::Runners,
        Resource::Models,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Resource::Account => "account",
            Resource::Notifications => "notifications",
            Resource::Workspace => "workspace",
            Resource::Billing => "billing",
            Resource::Repo => "repo",
            Resource::Code => "code",
            Resource::Security => "security",
            Resource::Packages => "packages",
            Resource::Issues => "issues",
            Resource::PullRequests => "pull_requests",
            Resource::Agents => "agents",
            Resource::Workflows => "workflows",
            Resource::Checks => "checks",
            Resource::Deployments => "deployments",
            Resource::Memory => "memory",
            Resource::Access => "access",
            Resource::Webhooks => "webhooks",
            Resource::Secrets => "secrets",
            Resource::Runners => "runners",
            Resource::Models => "models",
        }
    }

    /// Its name, for people.
    pub fn label(self) -> &'static str {
        match self {
            Resource::Account => "Your account",
            Resource::Notifications => "Notifications",
            Resource::Workspace => "Workspaces",
            Resource::Billing => "Billing",
            Resource::Repo => "Repositories",
            Resource::Code => "Code",
            Resource::Security => "Security",
            Resource::Packages => "Packages",
            Resource::Issues => "Issues",
            Resource::PullRequests => "Pull requests",
            Resource::Agents => "g1t agents",
            Resource::Workflows => "Workflows",
            Resource::Checks => "Checks and statuses",
            Resource::Deployments => "Deployments",
            Resource::Memory => "Memory and context",
            Resource::Access => "Who has access",
            Resource::Webhooks => "Webhooks",
            Resource::Secrets => "Secrets and variables",
            Resource::Runners => "Self-hosted runners",
            Resource::Models => "AI Gateway",
        }
    }
}

/// How much of a resource.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Level {
    Read,
    Write,
    /// Starting g1t's agents, which spends the workspace's money.
    Run,
    /// Deleting what cannot be brought back, such as a package's versions.
    Delete,
    Admin,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Read => "read",
            Level::Write => "write",
            Level::Run => "run",
            Level::Delete => "delete",
            Level::Admin => "admin",
        }
    }
}

/// One scope. Its text form, `resource:level`, is what tokens store, OAuth
/// clients ask for, and errors name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Scope {
    RepoRead,
    RepoWrite,
    RepoAdmin,
    CodeRead,
    CodeWrite,
    SecurityRead,
    SecurityWrite,
    PackagesRead,
    PackagesWrite,
    PackagesDelete,
    IssuesRead,
    IssuesWrite,
    PullRequestsRead,
    PullRequestsWrite,
    AgentsRun,
    WorkflowsRead,
    WorkflowsWrite,
    ChecksRead,
    ChecksWrite,
    DeploymentsRead,
    DeploymentsWrite,
    MemoryRead,
    MemoryWrite,
    AccountRead,
    AccountWrite,
    NotificationsRead,
    NotificationsWrite,
    WorkspaceRead,
    WorkspaceAdmin,
    BillingRead,
    BillingWrite,
    AccessRead,
    AccessAdmin,
    WebhooksRead,
    WebhooksAdmin,
    SecretsRead,
    SecretsAdmin,
    RunnersRead,
    RunnersAdmin,
    ModelsRead,
    ModelsWrite,
}

impl Scope {
    /// Every scope, grouped by resource, least first.
    pub const ALL: [Scope; 41] = [
        Scope::RepoRead,
        Scope::RepoWrite,
        Scope::RepoAdmin,
        Scope::CodeRead,
        Scope::CodeWrite,
        Scope::SecurityRead,
        Scope::SecurityWrite,
        Scope::PackagesRead,
        Scope::PackagesWrite,
        Scope::PackagesDelete,
        Scope::IssuesRead,
        Scope::IssuesWrite,
        Scope::PullRequestsRead,
        Scope::PullRequestsWrite,
        Scope::AgentsRun,
        Scope::WorkflowsRead,
        Scope::WorkflowsWrite,
        Scope::ChecksRead,
        Scope::ChecksWrite,
        Scope::DeploymentsRead,
        Scope::DeploymentsWrite,
        Scope::MemoryRead,
        Scope::MemoryWrite,
        Scope::AccountRead,
        Scope::AccountWrite,
        Scope::NotificationsRead,
        Scope::NotificationsWrite,
        Scope::WorkspaceRead,
        Scope::WorkspaceAdmin,
        Scope::BillingRead,
        Scope::BillingWrite,
        Scope::AccessRead,
        Scope::AccessAdmin,
        Scope::WebhooksRead,
        Scope::WebhooksAdmin,
        Scope::SecretsRead,
        Scope::SecretsAdmin,
        Scope::RunnersRead,
        Scope::RunnersAdmin,
        Scope::ModelsRead,
        Scope::ModelsWrite,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Scope::RepoRead => "repo:read",
            Scope::RepoWrite => "repo:write",
            Scope::RepoAdmin => "repo:admin",
            Scope::CodeRead => "code:read",
            Scope::CodeWrite => "code:write",
            Scope::SecurityRead => "security:read",
            Scope::SecurityWrite => "security:write",
            Scope::PackagesRead => "packages:read",
            Scope::PackagesWrite => "packages:write",
            Scope::PackagesDelete => "packages:delete",
            Scope::IssuesRead => "issues:read",
            Scope::IssuesWrite => "issues:write",
            Scope::PullRequestsRead => "pull_requests:read",
            Scope::PullRequestsWrite => "pull_requests:write",
            Scope::AgentsRun => "agents:run",
            Scope::WorkflowsRead => "workflows:read",
            Scope::WorkflowsWrite => "workflows:write",
            Scope::ChecksRead => "checks:read",
            Scope::ChecksWrite => "checks:write",
            Scope::DeploymentsRead => "deployments:read",
            Scope::DeploymentsWrite => "deployments:write",
            Scope::MemoryRead => "memory:read",
            Scope::MemoryWrite => "memory:write",
            Scope::AccountRead => "account:read",
            Scope::AccountWrite => "account:write",
            Scope::NotificationsRead => "notifications:read",
            Scope::NotificationsWrite => "notifications:write",
            Scope::WorkspaceRead => "workspace:read",
            Scope::WorkspaceAdmin => "workspace:admin",
            Scope::BillingRead => "billing:read",
            Scope::BillingWrite => "billing:write",
            Scope::AccessRead => "access:read",
            Scope::AccessAdmin => "access:admin",
            Scope::WebhooksRead => "webhooks:read",
            Scope::WebhooksAdmin => "webhooks:admin",
            Scope::SecretsRead => "secrets:read",
            Scope::SecretsAdmin => "secrets:admin",
            Scope::RunnersRead => "runners:read",
            Scope::RunnersAdmin => "runners:admin",
            Scope::ModelsRead => "models:read",
            Scope::ModelsWrite => "models:write",
        }
    }

    pub fn parse(text: &str) -> Option<Scope> {
        let text = text.trim().to_ascii_lowercase();
        Scope::ALL.into_iter().find(|scope| scope.as_str() == text)
    }

    pub fn resource(self) -> Resource {
        let name = self.as_str().split_once(':').map_or("", |(resource, _)| resource);
        Resource::ALL
            .into_iter()
            .find(|resource| resource.as_str() == name)
            .unwrap_or(Resource::Account)
    }

    pub fn level(self) -> Level {
        match self.as_str().rsplit_once(':').map_or("", |(_, level)| level) {
            "write" => Level::Write,
            "run" => Level::Run,
            "delete" => Level::Delete,
            "admin" => Level::Admin,
            _ => Level::Read,
        }
    }

    /// Whether holding `self` gives `other`: the same resource, at the same
    /// level or a lower one.
    pub fn includes(self, other: Scope) -> bool {
        self.resource() == other.resource() && self.level() >= other.level()
    }

    /// Changes that are hard or impossible to undo, or that decide who can
    /// reach what. Shown behind a warning wherever scopes are chosen.
    pub fn dangerous(self) -> bool {
        matches!(self.level(), Level::Admin | Level::Delete)
    }

    /// What it lets a token do, in plain words.
    pub fn describe(self) -> &'static str {
        match self {
            Scope::RepoRead => "See repositories, their settings, labels, timelines, releases, languages, contributors and security alerts, and search",
            Scope::RepoWrite => "Create repositories, rename branches, change how pull requests merge and publish releases",
            Scope::RepoAdmin => "Rename, archive, transfer, delete or change who can see a repository, change its rulesets, and dismiss security alerts",
            Scope::CodeRead => "Clone and fetch private repositories with git",
            Scope::CodeWrite => "Push commits with git",
            Scope::SecurityRead => "See secret scanning, code scanning and vulnerability alerts, custom patterns, the dependency graph and SBOM, and security settings",
            Scope::SecurityWrite => "Dismiss and reopen alerts, bypass push protection, review bypass requests, manage custom patterns, upload SARIF and change security settings",
            Scope::PackagesRead => "Pull container images and install private packages",
            Scope::PackagesWrite => "Push container images and publish packages",
            Scope::PackagesDelete => "Delete packages and their versions",
            Scope::IssuesRead => "Read issues, comments and plans",
            Scope::IssuesWrite => "Open, edit, close and comment on issues",
            Scope::PullRequestsRead => "Read pull requests, their changes, sessions and merge queues",
            Scope::PullRequestsWrite => "Open, review, close and merge pull requests",
            Scope::AgentsRun => "Put g1t agents to work and message them, which uses the workspace's money",
            Scope::WorkflowsRead => "Read workflows, runs and logs",
            Scope::WorkflowsWrite => "Run, cancel, rerun and turn workflows on or off",
            Scope::ChecksRead => "Read commits' statuses, check runs, check suites and annotations",
            Scope::ChecksWrite => "Report statuses and check runs on commits, and ask for checks to run again",
            Scope::DeploymentsRead => "See deployments, their statuses and environments",
            Scope::DeploymentsWrite => "Report deployments and their statuses, from any CI",
            Scope::MemoryRead => "Recall memory and search the workspace's context",
            Scope::MemoryWrite => "Save memory for the next agent",
            Scope::AccountRead => "Read your email addresses, invites, invitations, pinned projects and stars",
            Scope::AccountWrite => "Change your email addresses, make invites, answer invitations, pin projects and star repositories",
            Scope::NotificationsRead => "See your inbox, its threads, and what you subscribe to and watch",
            Scope::NotificationsWrite => "Mark notifications read, done, saved or snoozed, subscribe to threads and watch repositories",
            Scope::WorkspaceRead => "Read workspace settings, invites, integrations, model routes, teams and rulesets",
            Scope::WorkspaceAdmin => "Create and delete workspaces, invite members, connect integrations, create, change and delete teams, and change the workspace's rulesets",
            Scope::BillingRead => "See a workspace's usage, budget, AI credit and invoices",
            Scope::BillingWrite => "Change a workspace's budget and buy AI credit",
            Scope::AccessRead => "See who has access to repositories",
            Scope::AccessAdmin => "Give and take away access to repositories, a team's included",
            Scope::WebhooksRead => "See webhooks and their deliveries",
            Scope::WebhooksAdmin => "Create, change and delete webhooks",
            Scope::SecretsRead => "List secrets (never their values) and read variables",
            Scope::SecretsAdmin => "Set and delete secrets and variables",
            Scope::RunnersRead => "See self-hosted runners, their groups and where agents run",
            Scope::RunnersAdmin => "Register and remove self-hosted runners, change their groups and settings",
            Scope::ModelsRead => "See the workspace's AI Gateway requests: their models, tokens, cost and status",
            Scope::ModelsWrite => "Send model requests through the AI Gateway, which uses the workspace's AI credit",
        }
    }
}

impl Serialize for Scope {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Scope {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Scope::parse(&text).ok_or_else(|| serde::de::Error::custom(format!("unknown scope {text}")))
    }
}

/// Scopes as written in a token's row or an OAuth request: separated by
/// spaces or commas. Unknown names are left out, so a client asking for a
/// scope from a newer version gets the rest.
pub fn parse_scopes(text: &str) -> Vec<Scope> {
    let mut scopes: Vec<Scope> = text
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter_map(Scope::parse)
        .collect();
    normalize(&mut scopes);
    scopes
}

/// In table order, without repeats.
pub fn normalize(scopes: &mut Vec<Scope>) {
    let given = std::mem::take(scopes);
    scopes.extend(Scope::ALL.into_iter().filter(|scope| given.contains(scope)));
}

/// Space-separated, as stored and as OAuth writes them.
pub fn scopes_text(scopes: &[Scope]) -> String {
    scopes.iter().map(|scope| scope.as_str()).collect::<Vec<_>>().join(" ")
}

/// What a token stores for full access, which is not a scope a client can
/// ask for by name.
pub const FULL_ACCESS: &str = "*";

/// Starting points for choosing scopes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    ReadOnly,
    Agent,
    Ci,
    Full,
}

impl Preset {
    pub const ALL: [Preset; 4] = [Preset::ReadOnly, Preset::Agent, Preset::Ci, Preset::Full];

    pub fn as_str(self) -> &'static str {
        match self {
            Preset::ReadOnly => "read_only",
            Preset::Agent => "agent",
            Preset::Ci => "ci",
            Preset::Full => "full",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Preset::ReadOnly => "Read only",
            Preset::Agent => "Agent",
            Preset::Ci => "CI",
            Preset::Full => "Full access",
        }
    }

    /// Its scopes; `None` for full access.
    pub fn scopes(self) -> Option<Vec<Scope>> {
        let reads = || Scope::ALL.into_iter().filter(|scope| scope.level() == Level::Read);
        match self {
            Preset::ReadOnly => Some(reads().collect()),
            Preset::Agent => {
                // Not the machines work runs on: an agent has no business
                // knowing a workspace's own runners.
                let mut scopes: Vec<Scope> = reads().filter(|scope| scope.resource() != Resource::Runners).collect();
                // And answering what needs the person it works for: marking
                // it done, subscribing, watching.
                scopes.extend([
                    Scope::CodeWrite,
                    Scope::IssuesWrite,
                    Scope::PullRequestsWrite,
                    Scope::AgentsRun,
                    Scope::MemoryWrite,
                    Scope::NotificationsWrite,
                ]);
                normalize(&mut scopes);
                Some(scopes)
            }
            Preset::Ci => Some(vec![
                Scope::RepoRead,
                Scope::CodeRead,
                Scope::CodeWrite,
                Scope::PackagesRead,
                Scope::PackagesWrite,
                Scope::WorkflowsRead,
                Scope::WorkflowsWrite,
                Scope::ChecksRead,
                Scope::ChecksWrite,
                Scope::DeploymentsRead,
                Scope::DeploymentsWrite,
            ]),
            Preset::Full => None,
        }
    }
}

/// What an OAuth client gets when it asks for nothing in particular: the
/// agent preset. Never an admin scope.
pub fn oauth_default() -> Vec<Scope> {
    Preset::Agent.scopes().unwrap_or_default()
}

/// Set on a [`crate::User`] resolved from an access token: what the token
/// may do. Absent on a signed-in session, which may do whatever its person
/// can.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenAccess {
    /// The token's id, as audit entries and errors name it.
    #[serde(default)]
    pub token_id: String,
    /// Its scopes, as `resource:level`. Absent: full access, everything the
    /// person (or workspace) can do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
    /// Made before tokens had scopes: full access until someone narrows it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub legacy: bool,
    /// Set on a workflow job's token (`G1T_TOKEN`): the one repository it
    /// reaches, as `owner/name`. Every other is refused, whatever its owner
    /// could reach.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// Set on a workflow job's token: the run and job it was made for. The
    /// audit log records its changes as that job's, and what it changes
    /// starts no workflows (only `workflow_dispatch` and
    /// `repository_dispatch` do), so a workflow cannot set itself off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job: Option<JobToken>,
    /// The token's name, as its owner gave it, so a log can say which
    /// token made a request. Absent where whoever resolved it did not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// The workflow job a token was made for.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobToken {
    /// The run, `run_…`.
    pub run_id: String,
    /// The job, `job_…`.
    pub job_id: String,
}

impl TokenAccess {
    /// Full access to everything: the access tokens made before scopes had.
    pub fn full() -> Self {
        TokenAccess::default()
    }

    /// Whether it may reach the repository `owner/name`: every token but a
    /// workflow job's, which reaches its own repository only.
    pub fn reaches(&self, repo: &str) -> bool {
        self.repo.as_deref().is_none_or(|only| only.eq_ignore_ascii_case(repo))
    }

    pub fn is_full(&self) -> bool {
        self.scopes.is_none()
    }

    /// The scopes it holds, or `None` for full access.
    pub fn granted(&self) -> Option<Vec<Scope>> {
        self.scopes
            .as_ref()
            .map(|scopes| scopes.iter().filter_map(|scope| Scope::parse(scope)).collect())
    }

    pub fn allows(&self, needed: Scope) -> bool {
        match self.granted() {
            None => true,
            Some(granted) => granted.iter().any(|held| held.includes(needed)),
        }
    }
}

/// Every operation of the API and MCP server, with the scope it needs. An
/// operation in [`NO_SCOPE`] needs none. The API checks that every one of
/// its operations is in exactly one of the two.
pub const OPERATIONS: &[(&str, Scope)] = &[
    // Your account.
    ("list_emails", Scope::AccountRead),
    ("add_email", Scope::AccountWrite),
    ("remove_email", Scope::AccountWrite),
    ("update_email_settings", Scope::AccountWrite),
    ("list_invites", Scope::AccountRead),
    ("create_invite", Scope::AccountWrite),
    ("revoke_invite", Scope::AccountWrite),
    ("list_my_repo_invitations", Scope::AccountRead),
    ("accept_repo_invitation", Scope::AccountWrite),
    ("decline_repo_invitation", Scope::AccountWrite),
    // Your pinned projects: a preference of your account.
    ("list_pinned_projects", Scope::AccountRead),
    ("pin_project", Scope::AccountWrite),
    // Your stars: a preference of your account.
    ("list_starred", Scope::AccountRead),
    ("check_starred", Scope::AccountRead),
    ("star_repo", Scope::AccountWrite),
    ("unstar_repo", Scope::AccountWrite),
    ("unpin_project", Scope::AccountWrite),
    ("reorder_pinned_projects", Scope::AccountWrite),
    // Your inbox: notifications, subscriptions and watching.
    ("list_notifications", Scope::NotificationsRead),
    ("get_notification_thread", Scope::NotificationsRead),
    ("get_thread_subscription", Scope::NotificationsRead),
    ("get_repo_subscription", Scope::NotificationsRead),
    ("list_watched_repos", Scope::NotificationsRead),
    ("mark_notifications_read", Scope::NotificationsWrite),
    ("mark_thread_read", Scope::NotificationsWrite),
    ("mark_thread_done", Scope::NotificationsWrite),
    ("save_thread", Scope::NotificationsWrite),
    ("snooze_thread", Scope::NotificationsWrite),
    ("set_thread_subscription", Scope::NotificationsWrite),
    ("delete_thread_subscription", Scope::NotificationsWrite),
    ("set_repo_subscription", Scope::NotificationsWrite),
    ("delete_repo_subscription", Scope::NotificationsWrite),
    // Workspaces, their invites and integrations.
    ("create_workspace", Scope::WorkspaceAdmin),
    ("delete_workspace", Scope::WorkspaceAdmin),
    ("get_workspace", Scope::WorkspaceRead),
    ("update_workspace", Scope::WorkspaceAdmin),
    ("list_workspace_invites", Scope::WorkspaceRead),
    ("invite_member", Scope::WorkspaceAdmin),
    ("revoke_workspace_invite", Scope::WorkspaceAdmin),
    ("list_integrations", Scope::WorkspaceRead),
    ("connect_integration", Scope::WorkspaceAdmin),
    ("update_integration", Scope::WorkspaceAdmin),
    ("disconnect_integration", Scope::WorkspaceAdmin),
    ("test_integration", Scope::WorkspaceAdmin),
    ("get_model_routes", Scope::WorkspaceRead),
    ("set_model_routes", Scope::WorkspaceAdmin),
    // Teams: reading them, and managing them. A team's role on a
    // repository is who has access.
    ("list_teams", Scope::WorkspaceRead),
    ("get_team", Scope::WorkspaceRead),
    ("list_team_members", Scope::WorkspaceRead),
    ("list_child_teams", Scope::WorkspaceRead),
    ("list_team_repos", Scope::WorkspaceRead),
    ("list_user_teams", Scope::WorkspaceRead),
    ("create_team", Scope::WorkspaceAdmin),
    ("list_workspace_rulesets", Scope::WorkspaceRead),
    ("get_workspace_ruleset", Scope::WorkspaceRead),
    ("list_workspace_rule_evaluations", Scope::WorkspaceRead),
    ("create_workspace_ruleset", Scope::WorkspaceAdmin),
    ("update_workspace_ruleset", Scope::WorkspaceAdmin),
    ("delete_workspace_ruleset", Scope::WorkspaceAdmin),
    ("update_team", Scope::WorkspaceAdmin),
    ("delete_team", Scope::WorkspaceAdmin),
    ("set_team_member", Scope::WorkspaceAdmin),
    ("remove_team_member", Scope::WorkspaceAdmin),
    ("set_team_review_assignment", Scope::WorkspaceAdmin),
    // A workspace's billing: usage, budget, AI credit and invoices.
    ("get_usage", Scope::BillingRead),
    ("get_budget", Scope::BillingRead),
    ("get_ai_credit", Scope::BillingRead),
    ("list_invoices", Scope::BillingRead),
    ("get_billing_details", Scope::BillingRead),
    ("set_budget", Scope::BillingWrite),
    ("buy_ai_credit", Scope::BillingWrite),
    // Repositories.
    ("list_repos", Scope::RepoRead),
    ("get_repo", Scope::RepoRead),
    // Projects follow their repositories.
    ("list_projects", Scope::RepoRead),
    ("get_project", Scope::RepoRead),
    ("search", Scope::RepoRead),
    ("list_events", Scope::RepoRead),
    // What the default branch says about a repository, who starred it, and
    // its releases.
    ("get_languages", Scope::RepoRead),
    ("list_contributors", Scope::RepoRead),
    ("get_license", Scope::RepoRead),
    ("list_stargazers", Scope::RepoRead),
    ("list_releases", Scope::RepoRead),
    ("get_latest_release", Scope::RepoRead),
    ("get_release_by_tag", Scope::RepoRead),
    ("get_release", Scope::RepoRead),
    ("create_release", Scope::RepoWrite),
    ("update_release", Scope::RepoWrite),
    ("delete_release", Scope::RepoWrite),
    ("list_labels", Scope::RepoRead),
    ("list_milestones", Scope::RepoRead),
    ("get_milestone", Scope::RepoRead),
    ("create_label", Scope::IssuesWrite),
    ("update_label", Scope::IssuesWrite),
    ("delete_label", Scope::IssuesWrite),
    ("add_default_labels", Scope::IssuesWrite),
    ("create_milestone", Scope::IssuesWrite),
    ("update_milestone", Scope::IssuesWrite),
    ("delete_milestone", Scope::IssuesWrite),
    ("get_repo_settings", Scope::RepoRead),
    ("list_check_names", Scope::RepoRead),
    ("list_deleted_repos", Scope::RepoRead),
    ("list_security_alerts", Scope::RepoRead),
    ("get_codeowners_errors", Scope::RepoRead),
    ("create_repo", Scope::RepoWrite),
    ("update_repo", Scope::RepoWrite),
    ("update_project", Scope::RepoWrite),
    ("update_repo_settings", Scope::RepoWrite),
    // Rulesets: reading them is reading the repository; changing them
    // changes what everyone, agents included, may do, so it is admin.
    ("list_repo_rulesets", Scope::RepoRead),
    ("get_repo_ruleset", Scope::RepoRead),
    ("get_branch_rules", Scope::RepoRead),
    ("list_rule_evaluations", Scope::RepoRead),
    ("create_repo_ruleset", Scope::RepoAdmin),
    ("update_repo_ruleset", Scope::RepoAdmin),
    ("delete_repo_ruleset", Scope::RepoAdmin),
    ("rename_branch", Scope::RepoWrite),
    ("rename_repo", Scope::RepoAdmin),
    ("transfer_repo", Scope::RepoAdmin),
    ("archive_repo", Scope::RepoAdmin),
    ("unarchive_repo", Scope::RepoAdmin),
    ("set_repo_visibility", Scope::RepoAdmin),
    ("delete_repo", Scope::RepoAdmin),
    ("restore_repo", Scope::RepoAdmin),
    ("purge_repo", Scope::RepoAdmin),
    // A dismissed secret is let through push protection.
    ("dismiss_security_alert", Scope::RepoAdmin),
    ("reopen_security_alert", Scope::RepoAdmin),
    // The security suite: alerts, push protection, patterns, code
    // scanning, the supply chain and settings.
    ("list_secret_scanning_alerts", Scope::SecurityRead),
    ("get_secret_scanning_alert", Scope::SecurityRead),
    ("list_secret_scanning_locations", Scope::SecurityRead),
    ("list_bypass_requests", Scope::SecurityRead),
    ("list_custom_patterns", Scope::SecurityRead),
    ("list_code_scanning_alerts", Scope::SecurityRead),
    ("get_code_scanning_alert", Scope::SecurityRead),
    ("list_code_scanning_analyses", Scope::SecurityRead),
    ("get_sarif_upload", Scope::SecurityRead),
    ("list_vulnerability_alerts", Scope::SecurityRead),
    ("get_vulnerability_alert", Scope::SecurityRead),
    ("get_dependency_graph", Scope::SecurityRead),
    ("get_sbom", Scope::SecurityRead),
    ("compare_dependencies", Scope::SecurityRead),
    ("get_security_settings", Scope::SecurityRead),
    ("get_workspace_security_settings", Scope::SecurityRead),
    ("get_security_overview", Scope::SecurityRead),
    ("update_secret_scanning_alert", Scope::SecurityWrite),
    ("bypass_push_protection", Scope::SecurityWrite),
    ("check_secret_validity", Scope::SecurityWrite),
    ("review_bypass_request", Scope::SecurityWrite),
    ("create_custom_pattern", Scope::SecurityWrite),
    ("update_custom_pattern", Scope::SecurityWrite),
    ("delete_custom_pattern", Scope::SecurityWrite),
    ("dry_run_custom_pattern", Scope::SecurityWrite),
    ("update_code_scanning_alert", Scope::SecurityWrite),
    ("upload_sarif", Scope::SecurityWrite),
    ("update_vulnerability_alert", Scope::SecurityWrite),
    ("fix_security_alert", Scope::SecurityWrite),
    ("update_security_settings", Scope::SecurityWrite),
    ("update_workspace_security_settings", Scope::SecurityWrite),
    // Issues and plans.
    ("list_issues", Scope::IssuesRead),
    ("get_issue", Scope::IssuesRead),
    ("get_plan", Scope::IssuesRead),
    ("create_issue", Scope::IssuesWrite),
    ("update_issue", Scope::IssuesWrite),
    ("list_issue_labels", Scope::IssuesRead),
    ("add_issue_labels", Scope::IssuesWrite),
    ("set_issue_labels", Scope::IssuesWrite),
    ("remove_issue_labels", Scope::IssuesWrite),
    ("close_issue", Scope::IssuesWrite),
    ("reopen_issue", Scope::IssuesWrite),
    ("add_comment", Scope::IssuesWrite),
    ("import_issue", Scope::IssuesWrite),
    ("apply_plan", Scope::IssuesWrite),
    // Pull requests.
    ("list_pull_requests", Scope::PullRequestsRead),
    ("get_pull_request", Scope::PullRequestsRead),
    ("get_pull_request_changes", Scope::PullRequestsRead),
    ("read_session", Scope::PullRequestsRead),
    ("get_merge_queue", Scope::PullRequestsRead),
    ("create_pull_request", Scope::PullRequestsWrite),
    ("update_pull_request", Scope::PullRequestsWrite),
    ("record_session", Scope::PullRequestsWrite),
    ("mark_pull_request_ready", Scope::PullRequestsWrite),
    ("close_pull_request", Scope::PullRequestsWrite),
    ("review_pull_request", Scope::PullRequestsWrite),
    ("merge_pull_request", Scope::PullRequestsWrite),
    ("request_reviewers", Scope::PullRequestsWrite),
    ("remove_requested_reviewers", Scope::PullRequestsWrite),
    // g1t's agents.
    ("assign_issue", Scope::AgentsRun),
    ("delegate", Scope::AgentsRun),
    ("plan_work", Scope::AgentsRun),
    ("message_agent", Scope::AgentsRun),
    ("answer_message", Scope::AgentsRun),
    ("take_messages", Scope::AgentsRun),
    // Workflows.
    ("list_workflows", Scope::WorkflowsRead),
    ("list_workflow_runs", Scope::WorkflowsRead),
    ("get_workflow_run", Scope::WorkflowsRead),
    ("get_job_logs", Scope::WorkflowsRead),
    ("dispatch_workflow", Scope::WorkflowsWrite),
    ("cancel_workflow_run", Scope::WorkflowsWrite),
    ("rerun_workflow_run", Scope::WorkflowsWrite),
    ("update_workflow", Scope::WorkflowsWrite),
    // Checks: statuses, check runs and check suites on commits.
    ("list_commit_statuses", Scope::ChecksRead),
    ("get_combined_status", Scope::ChecksRead),
    ("list_check_runs_for_ref", Scope::ChecksRead),
    ("get_check_run", Scope::ChecksRead),
    ("list_check_run_annotations", Scope::ChecksRead),
    ("list_check_suites_for_ref", Scope::ChecksRead),
    ("get_check_suite", Scope::ChecksRead),
    ("create_commit_status", Scope::ChecksWrite),
    ("create_check_run", Scope::ChecksWrite),
    ("update_check_run", Scope::ChecksWrite),
    ("rerequest_check_run", Scope::ChecksWrite),
    ("rerequest_check_suite", Scope::ChecksWrite),
    // Deployments, wherever they run: reading them, and reporting them.
    ("list_deployments", Scope::DeploymentsRead),
    ("get_deployment", Scope::DeploymentsRead),
    ("list_deployment_statuses", Scope::DeploymentsRead),
    ("list_environments", Scope::DeploymentsRead),
    ("get_environment", Scope::DeploymentsRead),
    ("create_deployment", Scope::DeploymentsWrite),
    ("create_deployment_status", Scope::DeploymentsWrite),
    // What keeps runs safe: the runs environments hold and reviewing them,
    // approving a pull request's run, and a repository's own rules for
    // its environments and tokens, which are an admin's.
    ("get_pending_deployments", Scope::WorkflowsRead),
    ("review_pending_deployments", Scope::WorkflowsWrite),
    ("approve_workflow_run", Scope::WorkflowsWrite),
    ("get_workflow_permissions", Scope::RepoRead),
    ("get_fork_pr_approval", Scope::RepoRead),
    ("update_environment", Scope::RepoAdmin),
    ("delete_environment", Scope::RepoAdmin),
    ("set_workflow_permissions", Scope::RepoAdmin),
    ("set_fork_pr_approval", Scope::RepoAdmin),
    // Starting workflows from outside, as a push would.
    ("create_repository_dispatch", Scope::CodeWrite),
    // Memory and the context hub.
    ("recall", Scope::MemoryRead),
    ("search_context", Scope::MemoryRead),
    ("get_entity", Scope::MemoryRead),
    ("get_context", Scope::MemoryRead),
    ("remember", Scope::MemoryWrite),
    // Who has access.
    ("list_collaborators", Scope::AccessRead),
    ("get_collaborator_permission", Scope::AccessRead),
    ("list_repo_invitations", Scope::AccessRead),
    ("list_outside_collaborators", Scope::AccessRead),
    ("add_collaborator", Scope::AccessAdmin),
    ("update_collaborator", Scope::AccessAdmin),
    ("remove_collaborator", Scope::AccessAdmin),
    ("revoke_repo_invitation", Scope::AccessAdmin),
    ("set_base_permission", Scope::AccessAdmin),
    ("set_team_repo", Scope::AccessAdmin),
    ("remove_team_repo", Scope::AccessAdmin),
    // Webhooks.
    ("list_webhooks", Scope::WebhooksRead),
    ("list_webhook_deliveries", Scope::WebhooksRead),
    ("create_webhook", Scope::WebhooksAdmin),
    ("update_webhook", Scope::WebhooksAdmin),
    ("delete_webhook", Scope::WebhooksAdmin),
    ("ping_webhook", Scope::WebhooksAdmin),
    ("redeliver_webhook", Scope::WebhooksAdmin),
    // Secrets and variables.
    ("list_actions_secrets", Scope::SecretsRead),
    ("list_actions_variables", Scope::SecretsRead),
    ("set_actions_secret", Scope::SecretsAdmin),
    ("delete_actions_secret", Scope::SecretsAdmin),
    ("set_actions_variable", Scope::SecretsAdmin),
    ("delete_actions_variable", Scope::SecretsAdmin),
    // Self-hosted runners.
    ("list_runners", Scope::RunnersRead),
    ("list_runner_groups", Scope::RunnersRead),
    ("get_runner_settings", Scope::RunnersRead),
    ("create_runner_registration_token", Scope::RunnersAdmin),
    ("remove_runner", Scope::RunnersAdmin),
    ("create_runner_group", Scope::RunnersAdmin),
    ("update_runner_group", Scope::RunnersAdmin),
    ("delete_runner_group", Scope::RunnersAdmin),
    ("update_runner_settings", Scope::RunnersAdmin),
    // The AI Gateway. Sending a request to a model needs `models:write`,
    // checked by the model proxy at models.g1t.sh, not here.
    ("list_gateway_requests", Scope::ModelsRead),
];

/// Operations any token may use: saying who it is.
pub const NO_SCOPE: &[&str] = &["whoami"];

/// The scope `operation` needs. `None` for one in [`NO_SCOPE`]; an
/// operation in neither list needs full access.
pub fn scope_for(operation: &str) -> Option<Scope> {
    OPERATIONS
        .iter()
        .find(|(name, _)| *name == operation)
        .map(|(_, scope)| *scope)
}

/// What a token needs for `operation` with this input beyond its own
/// scope: starting agents from an operation that can, and making a
/// repository public or private.
pub fn extra_scopes(operation: &str, input: &serde_json::Value) -> Vec<Scope> {
    let mut extra = Vec::new();
    let assigns = input["assign"].as_bool() == Some(true)
        || input["agent"].as_bool() == Some(true)
        || input["assign_agent"].as_bool() == Some(true);
    if assigns && matches!(operation, "apply_plan" | "import_issue" | "create_issue") {
        extra.push(Scope::AgentsRun);
    }
    // Fixing an alert opens an issue and puts g1t on it.
    if operation == "fix_security_alert" {
        extra.extend([Scope::IssuesWrite, Scope::AgentsRun]);
    }
    // Opening the issue an agent is put on.
    if operation == "delegate" {
        extra.push(Scope::IssuesWrite);
    }
    // A workspace's base permission is who has access.
    if operation == "update_workspace" && input.get("base_permission").is_some_and(|v| !v.is_null()) {
        extra.push(Scope::AccessAdmin);
    }
    // Asking a g1t Actions job or run to run again reruns its workflow.
    if matches!(operation, "rerequest_check_run" | "rerequest_check_suite")
        && input["id"].as_str().is_some_and(|id| id.starts_with("job_") || id.starts_with("run_"))
    {
        extra.push(Scope::WorkflowsWrite);
    }
    if operation == "update_repo" && (input.get("private").is_some_and(|v| !v.is_null()) || input.get("default_branch").is_some_and(|v| !v.is_null())) {
        extra.push(Scope::RepoAdmin);
    }
    extra
}

/// The scopes a call needs, its own first.
pub fn needed(operation: &str, input: &serde_json::Value) -> Vec<Scope> {
    scope_for(operation)
        .into_iter()
        .chain(extra_scopes(operation, input))
        .collect()
}

/// Whether `access` may use `operation` with `input`. The person's (or
/// workspace's) role is checked after this, by the service that owns what
/// was asked about.
pub fn decide(access: &TokenAccess, operation: &str, input: &serde_json::Value) -> Decision {
    let rule = if access.legacy { "token:legacy" } else { "token:scope" };
    if let Some(only) = access.repo.as_deref()
        && !NO_SCOPE.contains(&operation)
    {
        match input["repo"].as_str() {
            Some(repo) if access.reaches(repo) => {}
            Some(repo) => {
                return Decision::deny("token:repository", format!("This token is a workflow job's in {only}: it cannot reach {repo}."));
            }
            None => {
                return Decision::deny("token:repository", format!("This token is a workflow job's: it reaches only {only}, and {operation} is not about one repository."));
            }
        }
    }
    if access.scopes.is_some() {
        let known = NO_SCOPE.contains(&operation) || scope_for(operation).is_some();
        if !known {
            return Decision::deny("token:scope", format!("This access token cannot use {operation}: it needs full access."));
        }
        if let Some(missing) = needed(operation, input).into_iter().find(|scope| !access.allows(*scope)) {
            return Decision::deny(
                "token:scope",
                format!("This access token needs the {} scope to use {operation}.", missing.as_str()),
            );
        }
    }
    Decision::allow(rule)
}

/// Whether a token may use the repository `owner/name` at all: a refusal
/// for a workflow job's token in another repository, else `None`. Git and
/// the package registries ask this before [`decide_git`] and
/// [`decide_packages`].
pub fn decide_repo(access: &TokenAccess, repo: &str) -> Option<Decision> {
    let only = access.repo.as_deref()?;
    (!access.reaches(repo)).then(|| Decision::deny("token:repository", format!("This token is a workflow job's in {only}: it cannot reach {repo}.")))
}

/// Whether a token may clone or fetch (`write` false), or push to (`write`
/// true), a repository with git. `public` is whether anyone may read it,
/// which needs no scope.
pub fn decide_git(access: &TokenAccess, write: bool, public: bool) -> Decision {
    let needed = if write { Scope::CodeWrite } else { Scope::CodeRead };
    if !access.allows(needed) && (write || !public) {
        return Decision::deny(
            "token:scope",
            format!("This access token needs the {} scope to {} with git.", needed.as_str(), if write { "push" } else { "clone or fetch a private repository" }),
        );
    }
    Decision::allow(if access.legacy { "token:legacy" } else { "token:scope" })
}

/// Whether a token may pull (`Level::Read`), push or publish
/// (`Level::Write`), or delete (`Level::Delete`) packages. `public` is
/// whether anyone may pull the package, which needs no scope.
pub fn decide_packages(access: &TokenAccess, level: Level, public: bool) -> Decision {
    let (needed, doing) = match level {
        Level::Read => (Scope::PackagesRead, "pull a private package"),
        Level::Delete | Level::Admin => (Scope::PackagesDelete, "delete packages"),
        Level::Write | Level::Run => (Scope::PackagesWrite, "push or publish packages"),
    };
    if !access.allows(needed) && !(level == Level::Read && public) {
        return Decision::deny(
            "token:scope",
            format!("This access token needs the {} scope to {doing}.", needed.as_str()),
        );
    }
    Decision::allow(if access.legacy { "token:legacy" } else { "token:scope" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn token(scopes: &[Scope]) -> TokenAccess {
        TokenAccess {
            token_id: "tok_1".to_owned(),
            scopes: Some(scopes.iter().map(|scope| scope.as_str().to_owned()).collect()),
            legacy: false,
            name: None,
            ..TokenAccess::default()
        }
    }

    #[test]
    fn every_scope_reads_back_and_belongs_to_a_resource() {
        for scope in Scope::ALL {
            assert_eq!(Scope::parse(scope.as_str()), Some(scope));
            assert!(scope.as_str().starts_with(scope.resource().as_str()));
            assert!(scope.includes(scope));
        }
        assert_eq!(Scope::parse(" Issues:Write "), Some(Scope::IssuesWrite));
        assert_eq!(Scope::parse("issues"), None);
    }

    #[test]
    fn a_higher_level_includes_the_lower_ones_of_its_resource_only() {
        assert!(Scope::RepoAdmin.includes(Scope::RepoRead));
        assert!(Scope::RepoAdmin.includes(Scope::RepoWrite));
        assert!(Scope::IssuesWrite.includes(Scope::IssuesRead));
        assert!(!Scope::IssuesRead.includes(Scope::IssuesWrite));
        assert!(!Scope::RepoAdmin.includes(Scope::CodeWrite));
        assert!(!Scope::PullRequestsWrite.includes(Scope::IssuesWrite));
    }

    #[test]
    fn operations_are_listed_once_and_never_also_free() {
        let mut seen = std::collections::HashSet::new();
        for (name, _) in OPERATIONS {
            assert!(seen.insert(*name), "{name} twice");
            assert!(!NO_SCOPE.contains(name), "{name}");
        }
    }

    #[test]
    fn scopes_are_parsed_from_oauth_text_leaving_out_unknown_ones() {
        assert_eq!(
            parse_scopes("issues:write repo:read,bogus:thing issues:write"),
            vec![Scope::RepoRead, Scope::IssuesWrite]
        );
        assert_eq!(scopes_text(&[Scope::RepoRead, Scope::IssuesWrite]), "repo:read issues:write");
    }

    #[test]
    fn the_oauth_default_is_the_agent_preset_and_never_admin() {
        let scopes = oauth_default();
        assert!(scopes.contains(&Scope::IssuesWrite));
        assert!(scopes.contains(&Scope::PullRequestsWrite));
        assert!(scopes.contains(&Scope::AgentsRun));
        assert!(scopes.iter().all(|scope| !scope.dangerous()), "{scopes:?}");
        for read in Scope::ALL.into_iter().filter(|scope| scope.level() == Level::Read) {
            // Every read but the machines work runs on.
            assert_eq!(scopes.contains(&read), read != Scope::RunnersRead, "{read:?}");
        }
        assert!(Preset::ReadOnly.scopes().unwrap().iter().all(|scope| scope.level() == Level::Read));
        assert_eq!(Preset::Full.scopes(), None);
    }

    #[test]
    fn billing_is_read_by_presets_and_changed_by_none_but_full_access() {
        assert!(Preset::ReadOnly.scopes().unwrap().contains(&Scope::BillingRead));
        for preset in [Preset::ReadOnly, Preset::Agent, Preset::Ci] {
            assert!(!preset.scopes().unwrap().contains(&Scope::BillingWrite), "{}", preset.as_str());
        }
        assert_eq!(scope_for("set_budget"), Some(Scope::BillingWrite));
        assert_eq!(scope_for("buy_ai_credit"), Some(Scope::BillingWrite));
        assert_eq!(scope_for("get_usage"), Some(Scope::BillingRead));
        let reader = token(&[Scope::BillingRead]);
        assert!(decide(&reader, "list_invoices", &json!({})).allowed);
        assert!(decide(&reader, "set_budget", &json!({})).reason.unwrap().contains("billing:write"));
    }

    #[test]
    fn the_ai_gateway_spends_only_with_models_write_which_no_preset_gives() {
        // Reading the log is a read like any other.
        assert_eq!(scope_for("list_gateway_requests"), Some(Scope::ModelsRead));
        assert!(Preset::ReadOnly.scopes().unwrap().contains(&Scope::ModelsRead));
        // Sending requests spends the workspace's AI credit: chosen on purpose.
        for preset in [Preset::ReadOnly, Preset::Agent, Preset::Ci] {
            assert!(!preset.scopes().unwrap().contains(&Scope::ModelsWrite), "{}", preset.as_str());
        }
        assert!(Scope::ModelsWrite.includes(Scope::ModelsRead));
        assert!(!Scope::ModelsWrite.dangerous());
        assert!(token(&[Scope::ModelsWrite]).allows(Scope::ModelsWrite));
        assert!(!token(&[Scope::BillingWrite]).allows(Scope::ModelsWrite));
        assert!(TokenAccess::full().allows(Scope::ModelsWrite));
    }

    #[test]
    fn checks_are_reported_with_checks_write_which_ci_gets() {
        assert_eq!(scope_for("create_check_run"), Some(Scope::ChecksWrite));
        assert_eq!(scope_for("create_commit_status"), Some(Scope::ChecksWrite));
        assert_eq!(scope_for("list_check_runs_for_ref"), Some(Scope::ChecksRead));
        let ci = Preset::Ci.scopes().unwrap();
        assert!(ci.contains(&Scope::ChecksWrite));
        assert!(!Preset::Agent.scopes().unwrap().contains(&Scope::ChecksWrite));
        let reporter = token(&[Scope::ChecksWrite]);
        assert!(decide(&reporter, "update_check_run", &json!({ "id": "cr_1" })).allowed);
        assert!(decide(&reporter, "rerequest_check_run", &json!({ "id": "cr_1" })).allowed);
        // A g1t Actions job runs again as its workflow does.
        let refused = decide(&reporter, "rerequest_check_run", &json!({ "id": "job_1" }));
        assert!(refused.reason.unwrap().contains("workflows:write"));
    }

    #[test]
    fn a_job_token_reaches_its_repository_only() {
        let job = TokenAccess {
            repo: Some("acme/web".into()),
            job: Some(JobToken { run_id: "run_1".into(), job_id: "job_1".into() }),
            ..token(&[Scope::RepoRead, Scope::IssuesWrite, Scope::IssuesRead])
        };
        assert!(decide(&job, "create_issue", &json!({ "repo": "acme/web" })).allowed);
        assert!(decide(&job, "create_issue", &json!({ "repo": "Acme/Web" })).allowed, "names compare without case");
        let elsewhere = decide(&job, "create_issue", &json!({ "repo": "acme/api" }));
        assert!(!elsewhere.allowed);
        assert_eq!(elsewhere.rule, "token:repository");
        // Nothing beyond the one repository, a workspace's listing included.
        assert!(!decide(&job, "list_repos", &json!({})).allowed);
        assert!(decide(&job, "whoami", &json!({})).allowed);
        // Its scopes still hold inside it.
        assert!(!decide(&job, "create_pull_request", &json!({ "repo": "acme/web" })).allowed);
        assert!(decide_repo(&job, "acme/web").is_none());
        assert!(!decide_repo(&job, "acme/api").unwrap().allowed);
        assert!(decide_repo(&token(&[Scope::CodeRead]), "acme/api").is_none(), "other tokens reach what their owner can");
    }

    #[test]
    fn a_legacy_token_can_do_everything() {
        let legacy = TokenAccess { legacy: true, ..TokenAccess::full() };
        for (operation, _) in OPERATIONS {
            assert!(decide(&legacy, operation, &json!({})).allowed, "{operation}");
        }
        assert_eq!(decide(&legacy, "delete_repo", &json!({})).rule, "token:legacy");
    }

    #[test]
    fn a_missing_scope_is_named() {
        let read = token(&[Scope::IssuesRead]);
        assert!(decide(&read, "get_issue", &json!({})).allowed);
        assert!(decide(&read, "whoami", &json!({})).allowed);
        let refused = decide(&read, "create_issue", &json!({}));
        assert!(!refused.allowed);
        assert_eq!(refused.reason.as_deref(), Some("This access token needs the issues:write scope to use create_issue."));
        // An operation the table does not know needs full access.
        assert!(!decide(&read, "something_new", &json!({})).allowed);
    }

    #[test]
    fn starting_agents_from_another_operation_needs_agents_run() {
        let writer = token(&[Scope::IssuesWrite]);
        assert!(decide(&writer, "apply_plan", &json!({})).allowed);
        let refused = decide(&writer, "apply_plan", &json!({ "assign": true }));
        assert!(refused.reason.unwrap().contains("agents:run"));
        let maintainer = token(&[Scope::RepoWrite]);
        assert!(decide(&maintainer, "update_repo", &json!({ "description": "x" })).allowed);
        assert!(!decide(&maintainer, "update_repo", &json!({ "private": true })).allowed);
    }

    #[test]
    fn a_workspaces_base_permission_needs_access_admin_too() {
        let admin = token(&[Scope::WorkspaceAdmin]);
        assert!(decide(&admin, "update_workspace", &json!({ "name": "Acme" })).allowed);
        let refused = decide(&admin, "update_workspace", &json!({ "name": "Acme", "base_permission": "read" }));
        assert!(refused.reason.unwrap().contains("access:admin"));
        let both = token(&[Scope::WorkspaceAdmin, Scope::AccessAdmin]);
        assert!(decide(&both, "update_workspace", &json!({ "base_permission": "read" })).allowed);
        assert!(!decide(&token(&[Scope::WorkspaceRead]), "update_workspace", &json!({ "name": "Acme" })).allowed);
    }

    #[test]
    fn delegating_needs_both_agents_and_issues() {
        let agents = token(&[Scope::AgentsRun]);
        assert!(decide(&agents, "delegate", &json!({})).reason.unwrap().contains("issues:write"));
        let both = token(&[Scope::AgentsRun, Scope::IssuesWrite]);
        assert!(decide(&both, "delegate", &json!({})).allowed);
    }

    #[test]
    fn git_push_needs_code_write_and_private_reads_need_code_read() {
        let reader = token(&[Scope::CodeRead]);
        assert!(decide_git(&reader, false, false).allowed);
        let refused = decide_git(&reader, true, false);
        assert!(!refused.allowed);
        assert!(refused.reason.unwrap().contains("code:write"));
        let issues = token(&[Scope::IssuesWrite]);
        assert!(!decide_git(&issues, false, false).allowed);
        assert!(decide_git(&issues, false, true).allowed, "public code needs no scope");
        assert!(!decide_git(&issues, true, true).allowed, "pushing to public code still needs code:write");
        let writer = token(&[Scope::CodeWrite]);
        assert!(decide_git(&writer, true, false).allowed);
        assert!(decide_git(&writer, false, false).allowed, "code:write includes code:read");
        assert!(decide_git(&TokenAccess::full(), true, false).allowed);
    }

    #[test]
    fn packages_need_their_own_scopes_and_public_pulls_none() {
        let reader = token(&[Scope::PackagesRead]);
        assert!(decide_packages(&reader, Level::Read, false).allowed);
        assert!(!decide_packages(&reader, Level::Write, false).allowed);
        let code = token(&[Scope::CodeWrite]);
        assert!(!decide_packages(&code, Level::Read, false).allowed, "code scopes are not package scopes");
        assert!(decide_packages(&code, Level::Read, true).allowed, "public packages pull with any token");
        let writer = token(&[Scope::PackagesWrite]);
        assert!(decide_packages(&writer, Level::Write, false).allowed);
        assert!(decide_packages(&writer, Level::Read, false).allowed, "packages:write includes packages:read");
        let refused = decide_packages(&writer, Level::Delete, false);
        assert!(refused.reason.unwrap().contains("packages:delete"));
        assert!(decide_packages(&token(&[Scope::PackagesDelete]), Level::Write, false).allowed);
        assert!(Scope::PackagesDelete.dangerous());
        // Tokens made before these scopes, and full-access ones, keep working.
        let legacy = TokenAccess { legacy: true, ..TokenAccess::full() };
        assert!(decide_packages(&legacy, Level::Delete, false).allowed);
        assert!(decide_packages(&TokenAccess::full(), Level::Write, false).allowed);
    }

    #[test]
    fn token_access_travels_as_json() {
        let access = token(&[Scope::IssuesRead]);
        let wire = serde_json::to_value(&access).unwrap();
        assert_eq!(wire["scopes"], json!(["issues:read"]));
        assert!(wire.get("resources").is_none());
        let back: TokenAccess = serde_json::from_value(wire).unwrap();
        assert_eq!(back, access);
        let full: TokenAccess = serde_json::from_value(json!({})).unwrap();
        assert!(full.is_full());
        // A reach written by an older version is ignored: a token reaches
        // whatever its owner can.
        let older: TokenAccess = serde_json::from_value(json!({
            "token_id": "tok_1",
            "scopes": ["issues:read"],
            "resources": { "kind": "repositories", "repositories": ["acme/rocket"] },
        }))
        .unwrap();
        assert_eq!(older, access);
    }

    /// The site's copy of the table, `packages/contracts/src/scopes.ts`,
    /// lists the same scopes in the same order, the same operations with
    /// the same scopes, and the same presets.
    #[test]
    fn the_typescript_mirror_has_the_same_table() {
        let ts = include_str!("../../../packages/contracts/src/scopes.ts");
        let section = |start: &str| {
            ts.split_once(start)
                .and_then(|(_, rest)| rest.split_once("] as const"))
                .map(|(table, _)| table)
                .unwrap_or_else(|| panic!("{start} in scopes.ts"))
        };
        let scopes: Vec<&str> = section("export const SCOPES = [")
            .lines()
            .filter_map(|line| line.split_once("scope: \"").and_then(|(_, rest)| rest.split_once('"')).map(|(scope, _)| scope))
            .collect();
        let expected: Vec<&str> = Scope::ALL.iter().map(|scope| scope.as_str()).collect();
        assert_eq!(scopes, expected);
        let operations: Vec<(String, String)> = section("export const OPERATION_SCOPES = [")
            .lines()
            .filter_map(|line| {
                let mut quoted = line.split('"').skip(1).step_by(2);
                Some((quoted.next()?.to_owned(), quoted.next()?.to_owned()))
            })
            .collect();
        let expected: Vec<(String, String)> = OPERATIONS
            .iter()
            .map(|(name, scope)| ((*name).to_owned(), scope.as_str().to_owned()))
            .collect();
        assert_eq!(operations, expected);
        for preset in Preset::ALL {
            let list = section(&format!("{}: [", preset.as_str()));
            let mirrored: Vec<&str> = list
                .split(',')
                .map(|item| item.trim().trim_matches('"'))
                .filter(|item| !item.is_empty())
                .collect();
            let expected: Vec<&str> = preset
                .scopes()
                .map(|scopes| scopes.iter().map(|scope| scope.as_str()).collect())
                .unwrap_or_else(|| vec!["*"]);
            assert_eq!(mirrored, expected, "{}", preset.as_str());
        }
    }
}
