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
//! `repo:admin` includes `repo:write`, which includes `repo:create`, which
//! includes `repo:read`.
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
    /// Chat: the conversations a person is in (channels, direct messages,
    /// threads), read and answered as them on the site's chat routes and
    /// live sockets. A person's own; no preset gives it.
    Chat,
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
    WorkflowFiles,
    Checks,
    Deployments,
    /// Observability: what a project's running software did, as requests,
    /// logs, traces, errors and metrics, and how they are collected.
    Observability,
    /// Retired with project and workspace memory ([`Resource::retired`]).
    Memory,
    Access,
    Webhooks,
    Secrets,
    Runners,
    Models,
    /// Artifacts mode's docs, slides, designs and dashboards (folios in
    /// code): the `artifact` MCP tool and `/workspaces/{ws}/artifacts`.
    /// Not workflow runs' artifacts, which are `workflows:*`.
    Artifacts,
}

impl Resource {
    pub const ALL: [Resource; 24] = [
        Resource::Repo,
        Resource::Code,
        Resource::Security,
        Resource::Packages,
        Resource::Issues,
        Resource::PullRequests,
        Resource::Agents,
        Resource::Workflows,
        Resource::WorkflowFiles,
        Resource::Checks,
        Resource::Deployments,
        Resource::Observability,
        Resource::Memory,
        Resource::Account,
        Resource::Notifications,
        Resource::Chat,
        Resource::Workspace,
        Resource::Billing,
        Resource::Access,
        Resource::Webhooks,
        Resource::Secrets,
        Resource::Runners,
        Resource::Models,
        Resource::Artifacts,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Resource::Account => "account",
            Resource::Notifications => "notifications",
            Resource::Chat => "chat",
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
            Resource::WorkflowFiles => "workflow_files",
            Resource::Checks => "checks",
            Resource::Deployments => "deployments",
            Resource::Observability => "observability",
            Resource::Memory => "memory",
            Resource::Access => "access",
            Resource::Webhooks => "webhooks",
            Resource::Secrets => "secrets",
            Resource::Runners => "runners",
            Resource::Models => "models",
            Resource::Artifacts => "artifacts",
        }
    }

    /// Its name, for people.
    pub fn label(self) -> &'static str {
        match self {
            Resource::Account => "Your account",
            Resource::Notifications => "Notifications",
            Resource::Chat => "Chat",
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
            Resource::WorkflowFiles => "Workflow files",
            Resource::Checks => "Checks and statuses",
            Resource::Deployments => "Deployments",
            Resource::Observability => "Observability",
            Resource::Memory => "Memory",
            Resource::Access => "Who has access",
            Resource::Webhooks => "Webhooks",
            Resource::Secrets => "Secrets and variables",
            Resource::Runners => "Self-hosted runners",
            Resource::Models => "AI Gateway",
            Resource::Artifacts => "Artifacts",
        }
    }

    /// Whether tokens are offered it. A resource being built can be in
    /// the table before its API ships (so its scopes parse, and the
    /// TypeScript mirror lists it under `UPCOMING_RESOURCES`) while nothing
    /// hands it out: presets, full access, OAuth and the token form leave
    /// it out, and no operation needs it. A [`Resource::retired`] one is
    /// never offered again.
    pub fn offered(self) -> bool {
        !self.retired()
    }

    /// Whether it belonged to something g1t no longer has: `agents` (g1t's
    /// own agents), `memory` (project and workspace memory) and `models`
    /// (its model proxy and AI Gateway). Their
    /// scopes still parse, so tokens and OAuth grants that stored them read
    /// as before, but [`parse_scopes`] leaves them out, nothing hands them
    /// out and no operation needs them: they grant nothing. The TypeScript
    /// mirror lists them under `RETIRED_RESOURCES` and `RETIRED_SCOPES`.
    pub fn retired(self) -> bool {
        matches!(self, Resource::Agents | Resource::Memory | Resource::Models)
    }
}

/// How much of a resource.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Level {
    Read,
    /// Making something new without changing what is there: only
    /// `repo:create`, which creates repositories and nothing more.
    Create,
    Write,
    /// Starting g1t's own agents: only `agents:run`, which is retired.
    Run,
    /// Deleting what cannot be brought back, such as a package's versions.
    Delete,
    Admin,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Read => "read",
            Level::Create => "create",
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
    /// Creating repositories, and nothing that changes or deletes one: what
    /// the Agent preset gives, so an agent can start a repository.
    RepoCreate,
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
    /// Retired with g1t's own agents ([`Resource::retired`]): parses, so
    /// stored tokens still read, but is never granted and gates nothing.
    AgentsRun,
    WorkflowsRead,
    WorkflowsWrite,
    WorkflowFilesWrite,
    ChecksRead,
    ChecksWrite,
    DeploymentsRead,
    DeploymentsWrite,
    ObservabilityRead,
    ObservabilityWrite,
    /// Retired with memory ([`Resource::retired`]): parses, so stored
    /// tokens still read, but is never granted and gates nothing.
    MemoryRead,
    MemoryWrite,
    AccountRead,
    AccountWrite,
    NotificationsRead,
    NotificationsWrite,
    ChatRead,
    ChatWrite,
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
    /// Retired with the AI Gateway ([`Resource::retired`]): parses, so
    /// stored tokens still read, but is never granted and gates nothing.
    ModelsRead,
    ModelsWrite,
    ArtifactsRead,
    ArtifactsWrite,
    ArtifactsAdmin,
}

impl Scope {
    /// Every scope, grouped by resource, least first.
    pub const ALL: [Scope; 50] = [
        Scope::RepoRead,
        Scope::RepoCreate,
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
        Scope::WorkflowFilesWrite,
        Scope::ChecksRead,
        Scope::ChecksWrite,
        Scope::DeploymentsRead,
        Scope::DeploymentsWrite,
        Scope::ObservabilityRead,
        Scope::ObservabilityWrite,
        Scope::MemoryRead,
        Scope::MemoryWrite,
        Scope::AccountRead,
        Scope::AccountWrite,
        Scope::NotificationsRead,
        Scope::NotificationsWrite,
        Scope::ChatRead,
        Scope::ChatWrite,
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
        Scope::ArtifactsRead,
        Scope::ArtifactsWrite,
        Scope::ArtifactsAdmin,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Scope::RepoRead => "repo:read",
            Scope::RepoCreate => "repo:create",
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
            Scope::WorkflowFilesWrite => "workflow_files:write",
            Scope::ChecksRead => "checks:read",
            Scope::ChecksWrite => "checks:write",
            Scope::DeploymentsRead => "deployments:read",
            Scope::DeploymentsWrite => "deployments:write",
            Scope::ObservabilityRead => "observability:read",
            Scope::ObservabilityWrite => "observability:write",
            Scope::MemoryRead => "memory:read",
            Scope::MemoryWrite => "memory:write",
            Scope::AccountRead => "account:read",
            Scope::AccountWrite => "account:write",
            Scope::NotificationsRead => "notifications:read",
            Scope::NotificationsWrite => "notifications:write",
            Scope::ChatRead => "chat:read",
            Scope::ChatWrite => "chat:write",
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
            Scope::ArtifactsRead => "artifacts:read",
            Scope::ArtifactsWrite => "artifacts:write",
            Scope::ArtifactsAdmin => "artifacts:admin",
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
            "create" => Level::Create,
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
            Scope::RepoCreate => "Create repositories, and nothing that changes or deletes one",
            Scope::RepoWrite => "Create repositories, create, rename and delete branches, change how pull requests merge and publish releases",
            Scope::RepoAdmin => "Rename, archive, transfer, delete or change who can see a repository, change its rulesets, and dismiss security alerts",
            Scope::CodeRead => "Clone and fetch private repositories with git",
            Scope::CodeWrite => "Push commits with git",
            Scope::SecurityRead => "See secret scanning, code scanning and vulnerability alerts, custom patterns, the dependency graph and SBOM, and security settings",
            Scope::SecurityWrite => "Dismiss and reopen alerts, bypass push protection, review bypass requests, manage custom patterns, upload SARIF and change security settings",
            Scope::PackagesRead => "Pull container images and install private packages",
            Scope::PackagesWrite => "Push container images and publish packages",
            Scope::PackagesDelete => "Delete and restore packages and their versions",
            Scope::IssuesRead => "Read issues and comments",
            Scope::IssuesWrite => "Open, edit, close and comment on issues",
            Scope::PullRequestsRead => "Read pull requests, their changes, sessions and merge queues",
            Scope::PullRequestsWrite => "Open, review, close and merge pull requests",
            Scope::AgentsRun => "Retired: put g1t's own agents to work. Grants nothing now",
            Scope::WorkflowsRead => "Read workflows, runs and logs",
            Scope::WorkflowsWrite => "Run, cancel, rerun and turn workflows on or off",
            Scope::WorkflowFilesWrite => "Add, change and delete workflow files under .g1t/workflows and .github/workflows, with git or the API",
            Scope::ChecksRead => "Read commits' statuses, check runs, check suites and annotations",
            Scope::ChecksWrite => "Report statuses and check runs on commits, and ask for checks to run again",
            Scope::DeploymentsRead => "See deployments, their statuses and environments",
            Scope::DeploymentsWrite => "Report deployments and their statuses, from any CI",
            Scope::ObservabilityRead => "See projects' requests, logs, traces, errors and metrics, and their observability settings, ingest tokens and exports",
            Scope::ObservabilityWrite => "Resolve and ignore errors, and change projects' observability settings, ingest tokens and exports",
            Scope::MemoryRead => "Retired: recall project and workspace memory. Grants nothing now",
            Scope::MemoryWrite => "Retired: save project and workspace memory. Grants nothing now",
            Scope::AccountRead => "Read your email addresses, invites, invitations, pinned projects and stars",
            Scope::AccountWrite => "Change your email addresses, make invites, answer invitations, pin projects and star repositories",
            Scope::NotificationsRead => "See your inbox, its threads, and what you subscribe to and watch",
            Scope::NotificationsWrite => "Mark notifications read, done, saved or snoozed, subscribe to threads and watch repositories",
            Scope::ChatRead => "Read the conversations you are in: channels, direct messages, threads and reactions, live",
            Scope::ChatWrite => "Send, edit and delete your messages, react, mark conversations read, and answer cards in chat",
            Scope::WorkspaceRead => "Read workspace settings, invites, integrations, AI providers, teams and rulesets",
            Scope::WorkspaceAdmin => "Create and delete workspaces, invite members, connect integrations, add AI providers and choose what Ask answers with, create, change and delete teams, and change the workspace's rulesets",
            Scope::BillingRead => "See a workspace's usage, budget and invoices",
            Scope::BillingWrite => "Change a workspace's budget",
            Scope::AccessRead => "See who has access to repositories",
            Scope::AccessAdmin => "Give and take away access to repositories, a team's included",
            Scope::WebhooksRead => "See webhooks and their deliveries",
            Scope::WebhooksAdmin => "Create, change and delete webhooks",
            Scope::SecretsRead => "List secrets (never their values) and read variables",
            Scope::SecretsAdmin => "Set and delete secrets and variables",
            Scope::RunnersRead => "See self-hosted runners and their groups",
            Scope::RunnersAdmin => "Register and remove self-hosted runners, change their groups and settings",
            Scope::ModelsRead => "Retired: see the AI Gateway's requests. Grants nothing now",
            Scope::ModelsWrite => "Retired: send requests through the AI Gateway. Grants nothing now",
            Scope::ArtifactsRead => "List, read and search artifacts you can see, their versions, and the numbers their dashboards show",
            Scope::ArtifactsWrite => "Create, rename, move, edit, trash and restore artifacts, and propose changes to them",
            Scope::ArtifactsAdmin => "Share artifacts, change who can open them, and delete them for good",
        }
    }

    /// Whether tokens are offered it yet: its resource's [`Resource::offered`].
    pub fn offered(self) -> bool {
        self.resource().offered()
    }
}

/// Every scope tokens are offered, in table order: what OAuth advertises.
pub fn offered_scopes() -> Vec<Scope> {
    Scope::ALL.into_iter().filter(|scope| scope.offered()).collect()
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
        .filter(|scope| scope.offered())
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

/// Where a resource sits on the token form, and which tokens may hold it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceGroup {
    /// About repositories: what they hold and how they are run.
    Repository,
    /// About a workspace itself.
    Workspace,
    /// About the person: only a personal token may hold these.
    Account,
}

impl ResourceGroup {
    pub const ALL: [ResourceGroup; 3] = [ResourceGroup::Repository, ResourceGroup::Workspace, ResourceGroup::Account];

    pub fn as_str(self) -> &'static str {
        match self {
            ResourceGroup::Repository => "repository",
            ResourceGroup::Workspace => "workspace",
            ResourceGroup::Account => "account",
        }
    }
}

impl Resource {
    pub fn group(self) -> ResourceGroup {
        match self {
            Resource::Account | Resource::Notifications | Resource::Chat => ResourceGroup::Account,
            Resource::Workspace | Resource::Billing | Resource::Runners | Resource::Models | Resource::Artifacts => ResourceGroup::Workspace,
            _ => ResourceGroup::Repository,
        }
    }

    pub fn parse(text: &str) -> Option<Resource> {
        let text = text.trim().to_ascii_lowercase();
        Resource::ALL.into_iter().find(|resource| resource.as_str() == text)
    }

    /// Its scopes, least first.
    pub fn scopes(self) -> Vec<Scope> {
        Scope::ALL.into_iter().filter(|scope| scope.resource() == self).collect()
    }
}

// --- Permissions --------------------------------------------------------------
//
// A token's permissions are its scopes read per resource: each resource
// at none or one level (`{"issues": "write", "repo": "read"}`). A level
// includes the ones below it, so the highest scope held of each resource
// says everything; that is what a token stores. Personal tokens and a
// workspace's own tokens are made, shown and checked this way alike.

/// The highest scope of each resource held, in table order: the fewest
/// scopes that give the same access, as tokens store them.
pub fn top_scopes(scopes: &[Scope]) -> Vec<Scope> {
    let mut top: Vec<Scope> = Vec::new();
    for resource in Resource::ALL {
        if let Some(best) = scopes.iter().filter(|scope| scope.resource() == resource).max_by_key(|scope| scope.level()) {
            top.push(*best);
        }
    }
    normalize(&mut top);
    top
}

/// Every resource at its highest level: all a token can be given.
pub fn everything() -> Vec<Scope> {
    top_scopes(&offered_scopes())
}

/// Scopes as permissions: each resource held, by name, at its highest
/// level held.
pub fn permissions_of(scopes: &[Scope]) -> std::collections::BTreeMap<String, String> {
    top_scopes(scopes)
        .into_iter()
        .map(|scope| (scope.resource().as_str().to_owned(), scope.level().as_str().to_owned()))
        .collect()
}

/// Permissions as asked for (`{"issues": "write"}`, `none` or empty left
/// out) into the scopes a token stores, or why they cannot be. `personal`
/// is whether the token is a person's: only theirs may hold account ones.
pub fn resolve_permissions(asked: &std::collections::BTreeMap<String, String>, personal: bool) -> Result<Vec<Scope>, String> {
    let mut scopes = Vec::new();
    for (name, level) in asked {
        let Some(resource) = Resource::parse(name).filter(|resource| resource.offered()) else {
            return Err(format!("There is no permission called {name}."));
        };
        let level = level.trim().to_ascii_lowercase();
        if level.is_empty() || level == "none" {
            continue;
        }
        let Some(scope) = Scope::parse(&format!("{}:{level}", resource.as_str())) else {
            let levels: Vec<&str> = resource.scopes().iter().map(|scope| scope.level().as_str()).collect();
            return Err(format!("{} is none or {}, not {level}.", resource.as_str(), levels.join(", ")));
        };
        if resource.group() == ResourceGroup::Account && !personal {
            return Err(format!("{} is about a person's account: a workspace's token cannot hold it.", resource.as_str()));
        }
        scopes.push(scope);
    }
    Ok(top_scopes(&scopes))
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
        // Chat is not in any: a person's conversations go to an application
        // only when it asks for them by name.
        let reads = || {
            Scope::ALL
                .into_iter()
                .filter(|scope| scope.level() == Level::Read && scope.offered() && scope.resource() != Resource::Chat)
        };
        match self {
            Preset::ReadOnly => Some(reads().collect()),
            Preset::Agent => {
                // Not the machines work runs on: an agent has no business
                // knowing a workspace's own runners.
                let mut scopes: Vec<Scope> = reads().filter(|scope| scope.resource() != Resource::Runners).collect();
                // And answering what needs the person it works for: marking
                // it done, subscribing, watching.
                // And starting a repository for what it builds, which changes
                // nothing already there: `repo:write` would let it change
                // merge settings and delete branches and releases.
                scopes.extend([
                    Scope::RepoCreate,
                    Scope::CodeWrite,
                    Scope::IssuesWrite,
                    Scope::PullRequestsWrite,
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
    /// Set on a token narrowed to less than its owner can reach: one
    /// workspace (all, selected or none of its private repositories), or
    /// none at all (its owner's account and public repositories). Absent
    /// on a token that reaches every workspace its owner can.
    ///
    /// The wire key is `fine_grained`, kept from before tokens were one
    /// kind, so services deployed at different moments agree on it.
    #[serde(rename = "fine_grained", default, skip_serializing_if = "Option::is_none")]
    pub reach: Option<TokenReach>,
    /// Set on a workspace's own token that an owner gave Admin when making
    /// it. Without it a workspace's token has Write on the workspace's
    /// repositories, as a member would (see [`crate::access`]).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub admin: bool,
    /// Set on what a repository's deploy key resolves to: the key's id. Its
    /// `repo` is the one repository it reaches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deploy_key: Option<String>,
    /// Set on a person's token whose owner let it use the website (g1t.sh)
    /// as them, sent as `Authorization: Bearer`. Not a scope: no preset,
    /// full access or OAuth grant includes it, and git, the API and MCP
    /// ignore it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub website: bool,
}

/// Which repositories a token reaches in the workspace it is made for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepositorySelection {
    /// Every repository of the workspace, ones made later included.
    #[default]
    All,
    /// The repositories chosen, by id.
    Selected,
    /// None of the workspace's private repositories: public repositories,
    /// read-only, and the workspace's own settings its permissions allow.
    /// With no workspace: the owner's account and public repositories only.
    Public,
}

impl RepositorySelection {
    pub fn as_str(self) -> &'static str {
        match self {
            RepositorySelection::All => "all",
            RepositorySelection::Selected => "selected",
            RepositorySelection::Public => "public",
        }
    }

    pub fn parse(text: &str) -> Option<RepositorySelection> {
        match text.trim().to_ascii_lowercase().as_str() {
            "all" => Some(RepositorySelection::All),
            "selected" => Some(RepositorySelection::Selected),
            "public" | "public_only" | "none" => Some(RepositorySelection::Public),
            _ => None,
        }
    }
}

/// What a narrowed token reaches, as identity resolves it on each use.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenReach {
    /// The workspace whose repositories and settings it reaches, by slug as
    /// it is now. Absent: its owner's account only, with public
    /// repositories read-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default)]
    pub repositories: RepositorySelection,
    /// With [`RepositorySelection::Selected`]: the repositories' ids.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub repo_ids: Vec<String>,
}

impl TokenReach {
    /// Whether it reaches the repository with this id in the workspace
    /// `namespace` for more than what anyone may do with a public one.
    pub fn covers(&self, repo_id: &str, namespace: &str) -> bool {
        let Some(workspace) = self.workspace.as_deref() else {
            return false;
        };
        if !workspace.eq_ignore_ascii_case(namespace) {
            return false;
        }
        match self.repositories {
            RepositorySelection::All => true,
            RepositorySelection::Selected => self.repo_ids.iter().any(|id| id == repo_id),
            RepositorySelection::Public => false,
        }
    }

    /// Whether it is made for the workspace `slug`.
    pub fn owned_by(&self, slug: &str) -> bool {
        self.workspace.as_deref().is_some_and(|workspace| workspace.eq_ignore_ascii_case(slug))
    }
}

/// Where workflow files live. Adding, changing or deleting a file under
/// one, with git or through g1t, needs [`Scope::WorkflowFilesWrite`] from a
/// token: what GitHub's `workflow` scope and `workflows` permission do.
pub const WORKFLOW_DIRS: [&str; 2] = [".g1t/workflows/", ".github/workflows/"];

/// Whether `path` is a workflow file, or a file in one's directory.
pub fn is_workflow_file(path: &str) -> bool {
    let path = path.trim_start_matches('/');
    WORKFLOW_DIRS.iter().any(|dir| {
        path.len() >= dir.len() && path.is_char_boundary(dir.len()) && path[..dir.len()].eq_ignore_ascii_case(dir)
    }) || WORKFLOW_DIRS.iter().any(|dir| path.eq_ignore_ascii_case(dir.trim_end_matches('/')))
}

/// Whether a token may add, change or delete the files at `paths`: a
/// refusal naming the first workflow file it may not touch, else `None`.
/// A signed-in person (no token) is never refused here; their role decides.
pub fn decide_workflow_files<'a>(access: Option<&TokenAccess>, paths: impl IntoIterator<Item = &'a str>) -> Option<Decision> {
    let access = access?;
    if access.allows(Scope::WorkflowFilesWrite) && access.job.is_none() {
        return None;
    }
    let path = paths.into_iter().find(|path| is_workflow_file(path))?;
    let why = if access.job.is_some() {
        "a workflow job's token can never add or change workflow files".to_owned()
    } else {
        format!("it needs the {} scope", Scope::WorkflowFilesWrite.as_str())
    };
    Some(Decision::deny(
        "token:workflows",
        format!("This access token cannot change the workflow file {path}: {why}."),
    ))
}

/// The workflow job a token was made for.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobToken {
    /// The run, `run_…`.
    pub run_id: String,
    /// The job, `job_…`.
    pub job_id: String,
    /// Whether it may open pull requests and approve them, by its
    /// repository's and workspace's choice ("Allow g1t Actions to create and
    /// approve pull requests"). Off unless chosen.
    #[serde(default)]
    pub pull_requests: bool,
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

    /// Whether it reaches the repository with this id in `namespace` for
    /// more than reading a public one: every token but a narrowed one
    /// outside its workspace or repository selection. Its owner's role
    /// still decides; see [`crate::access`].
    pub fn covers_repo(&self, repo_id: &str, namespace: &str) -> bool {
        self.reach.as_ref().is_none_or(|reach| reach.covers(repo_id, namespace))
    }
}

/// Every operation of the API and MCP server, with the scope it needs. An
/// operation in [`NO_SCOPE`] needs none. The API checks that every one of
/// its operations is in exactly one of the two.
pub const OPERATIONS: &[(&str, Scope)] = &[
    // Your account.
    ("list_emails", Scope::AccountRead),
    ("add_email", Scope::AccountWrite),
    ("confirm_email", Scope::AccountWrite),
    ("remove_email", Scope::AccountWrite),
    ("update_email_settings", Scope::AccountWrite),
    ("list_invites", Scope::AccountRead),
    ("create_invite", Scope::AccountWrite),
    ("revoke_invite", Scope::AccountWrite),
    ("resend_invite", Scope::AccountWrite),
    ("list_invitations", Scope::AccountRead),
    ("accept_invitation", Scope::AccountWrite),
    ("decline_invitation", Scope::AccountWrite),
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
    // Its members, and who owns it.
    ("list_members", Scope::WorkspaceRead),
    ("update_member", Scope::WorkspaceAdmin),
    ("remove_member", Scope::WorkspaceAdmin),
    ("transfer_ownership", Scope::WorkspaceAdmin),
    ("leave_workspace", Scope::AccountWrite),
    ("list_workspace_invites", Scope::WorkspaceRead),
    ("invite_member", Scope::WorkspaceAdmin),
    ("revoke_workspace_invite", Scope::WorkspaceAdmin),
    ("list_integrations", Scope::WorkspaceRead),
    ("connect_integration", Scope::WorkspaceAdmin),
    ("update_integration", Scope::WorkspaceAdmin),
    ("disconnect_integration", Scope::WorkspaceAdmin),
    ("test_integration", Scope::WorkspaceAdmin),
    // Its AI: the AI providers it keeps keys for, and what Ask answers with.
    ("list_ai_providers", Scope::WorkspaceRead),
    ("add_ai_provider", Scope::WorkspaceAdmin),
    ("update_ai_provider", Scope::WorkspaceAdmin),
    ("remove_ai_provider", Scope::WorkspaceAdmin),
    ("test_ai_provider", Scope::WorkspaceAdmin),
    ("get_ask_settings", Scope::WorkspaceRead),
    ("set_ask_settings", Scope::WorkspaceAdmin),
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
    // A workspace's billing: usage, budget and invoices.
    ("get_usage", Scope::BillingRead),
    ("get_budget", Scope::BillingRead),
    ("list_invoices", Scope::BillingRead),
    ("get_billing_details", Scope::BillingRead),
    ("set_budget", Scope::BillingWrite),
    // Repositories.
    ("list_repos", Scope::RepoRead),
    ("get_repo", Scope::RepoRead),
    ("list_forks", Scope::RepoRead),
    // Comments on commits are read with the repository, and written as
    // comments on issues are.
    ("list_repo_commit_comments", Scope::RepoRead),
    ("list_commit_comments", Scope::RepoRead),
    // A repository's files, as clone and fetch need.
    // A file or directory of a repository, as clone and fetch would give it.
    ("get_contents", Scope::CodeRead),
    ("list_commits", Scope::CodeRead),
    ("download_tarball_archive", Scope::CodeRead),
    ("download_zipball_archive", Scope::CodeRead),
    ("why", Scope::CodeRead),
    // Projects follow their repositories.
    ("list_projects", Scope::RepoRead),
    ("get_project", Scope::RepoRead),
    ("search", Scope::RepoRead),
    ("list_events", Scope::RepoRead),
    // A workspace's activity: the events of its repositories the caller can read.
    ("get_workspace_activity", Scope::RepoRead),
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
    // Creating one changes nothing already there: `repo:create`, which
    // `repo:write` includes.
    ("create_repo", Scope::RepoCreate),
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
    ("create_branch", Scope::RepoWrite),
    ("delete_branch", Scope::RepoWrite),
    ("rename_repo", Scope::RepoAdmin),
    ("transfer_repo", Scope::RepoAdmin),
    // Forking makes a repository, as create_repo does; syncing moves a
    // fork's branch; detaching changes what the fork is.
    ("fork_repo", Scope::RepoWrite),
    ("sync_fork", Scope::RepoWrite),
    ("detach_fork", Scope::RepoAdmin),
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
    ("rerun_dependency_review", Scope::SecurityWrite),
    ("get_security_settings", Scope::SecurityRead),
    ("get_workspace_security_settings", Scope::SecurityRead),
    ("get_security_overview", Scope::SecurityRead),
    ("list_security_advisories", Scope::SecurityRead),
    ("get_security_advisory", Scope::SecurityRead),
    ("list_vulnerability_reports", Scope::SecurityRead),
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
    ("update_security_settings", Scope::SecurityWrite),
    ("update_workspace_security_settings", Scope::SecurityWrite),
    ("create_security_advisory", Scope::SecurityWrite),
    ("update_security_advisory", Scope::SecurityWrite),
    ("set_security_advisory_state", Scope::SecurityWrite),
    ("report_vulnerability", Scope::SecurityWrite),
    ("review_vulnerability_report", Scope::SecurityWrite),
    // Issues.
    ("list_issues", Scope::IssuesRead),
    ("get_issue", Scope::IssuesRead),
    ("create_issue", Scope::IssuesWrite),
    ("update_issue", Scope::IssuesWrite),
    ("list_issue_labels", Scope::IssuesRead),
    ("add_issue_labels", Scope::IssuesWrite),
    ("set_issue_labels", Scope::IssuesWrite),
    ("remove_issue_labels", Scope::IssuesWrite),
    ("close_issue", Scope::IssuesWrite),
    ("reopen_issue", Scope::IssuesWrite),
    ("add_comment", Scope::IssuesWrite),
    ("edit_comment", Scope::IssuesWrite),
    ("delete_comment", Scope::IssuesWrite),
    ("react", Scope::IssuesWrite),
    ("create_commit_comment", Scope::IssuesWrite),
    ("update_commit_comment", Scope::IssuesWrite),
    ("delete_commit_comment", Scope::IssuesWrite),
    // Looking up a ticket the work refers to, through the workspace's
    // integrations, and bringing one in as an issue.
    ("get_context", Scope::IssuesRead),
    ("import_issue", Scope::IssuesWrite),
    // Coordinating work on issues: claims, and the context to pick one up.
    ("list_claims", Scope::IssuesRead),
    ("get_work", Scope::IssuesRead),
    ("claim_issue", Scope::IssuesWrite),
    ("release_claim", Scope::IssuesWrite),
    ("hand_off_issue", Scope::IssuesWrite),
    // Pull requests.
    ("list_pull_requests", Scope::PullRequestsRead),
    ("get_pull_request", Scope::PullRequestsRead),
    ("get_pull_request_changes", Scope::PullRequestsRead),
    ("read_session", Scope::PullRequestsRead),
    ("get_merge_queue", Scope::PullRequestsRead),
    ("get_pull_request_merge_options", Scope::PullRequestsRead),
    ("list_decisions", Scope::PullRequestsRead),
    ("create_pull_request", Scope::PullRequestsWrite),
    ("update_pull_request", Scope::PullRequestsWrite),
    ("record_session", Scope::PullRequestsWrite),
    ("record_decision", Scope::PullRequestsWrite),
    ("mark_pull_request_ready", Scope::PullRequestsWrite),
    ("close_pull_request", Scope::PullRequestsWrite),
    ("reopen_pull_request", Scope::PullRequestsWrite),
    ("convert_pull_request_to_draft", Scope::PullRequestsWrite),
    ("review_pull_request", Scope::PullRequestsWrite),
    ("merge_pull_request", Scope::PullRequestsWrite),
    ("update_pull_request_branch", Scope::PullRequestsWrite),
    ("enable_pull_request_auto_merge", Scope::PullRequestsWrite),
    ("disable_pull_request_auto_merge", Scope::PullRequestsWrite),
    ("delete_pull_request_head_branch", Scope::PullRequestsWrite),
    ("restore_pull_request_head_branch", Scope::PullRequestsWrite),
    ("request_reviewers", Scope::PullRequestsWrite),
    ("remove_requested_reviewers", Scope::PullRequestsWrite),
    // Harness sessions, which record how pull requests are made.
    ("get_session", Scope::PullRequestsRead),
    ("list_sessions", Scope::PullRequestsRead),
    ("start_session", Scope::PullRequestsWrite),
    ("update_session", Scope::PullRequestsWrite),
    ("end_session", Scope::PullRequestsWrite),
    ("record_session_entries", Scope::PullRequestsWrite),
    ("start_agent_session", Scope::PullRequestsWrite),
    // Workflows.
    ("list_workflows", Scope::WorkflowsRead),
    ("get_workflow", Scope::WorkflowsRead),
    ("list_workflow_runs", Scope::WorkflowsRead),
    ("get_workflow_run", Scope::WorkflowsRead),
    ("get_job_logs", Scope::WorkflowsRead),
    ("dispatch_workflow", Scope::WorkflowsWrite),
    ("cancel_workflow_run", Scope::WorkflowsWrite),
    ("rerun_workflow_run", Scope::WorkflowsWrite),
    ("update_workflow", Scope::WorkflowsWrite),
    ("list_artifacts", Scope::WorkflowsRead),
    ("list_workflow_run_artifacts", Scope::WorkflowsRead),
    ("get_artifact", Scope::WorkflowsRead),
    ("download_artifact", Scope::WorkflowsRead),
    ("get_artifact_retention", Scope::WorkflowsRead),
    ("delete_artifact", Scope::WorkflowsWrite),
    ("set_artifact_retention", Scope::WorkflowsWrite),
    ("list_caches", Scope::WorkflowsRead),
    ("get_cache_usage", Scope::WorkflowsRead),
    ("delete_caches_by_key", Scope::WorkflowsWrite),
    ("delete_cache", Scope::WorkflowsWrite),
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
    ("start_deployment_build", Scope::DeploymentsWrite),
    // Observability: what a project's software did, and how it is collected.
    ("get_observability_overview", Scope::ObservabilityRead),
    ("list_requests", Scope::ObservabilityRead),
    ("get_request", Scope::ObservabilityRead),
    ("list_logs", Scope::ObservabilityRead),
    ("list_traces", Scope::ObservabilityRead),
    ("get_trace", Scope::ObservabilityRead),
    ("list_errors", Scope::ObservabilityRead),
    ("list_metrics", Scope::ObservabilityRead),
    ("get_metric", Scope::ObservabilityRead),
    ("get_observability_settings", Scope::ObservabilityRead),
    ("list_ingest_tokens", Scope::ObservabilityRead),
    ("list_telemetry_exports", Scope::ObservabilityRead),
    ("get_observability_usage", Scope::ObservabilityRead),
    ("update_error", Scope::ObservabilityWrite),
    ("update_observability_settings", Scope::ObservabilityWrite),
    ("create_ingest_token", Scope::ObservabilityWrite),
    ("delete_ingest_token", Scope::ObservabilityWrite),
    ("create_telemetry_export", Scope::ObservabilityWrite),
    ("update_telemetry_export", Scope::ObservabilityWrite),
    ("delete_telemetry_export", Scope::ObservabilityWrite),
    // What keeps runs safe: the runs environments hold and reviewing them,
    // approving a pull request's run, and a repository's own rules for
    // its environments and tokens, which are an admin's.
    ("get_pending_deployments", Scope::WorkflowsRead),
    ("review_pending_deployments", Scope::WorkflowsWrite),
    ("approve_workflow_run", Scope::WorkflowsWrite),
    ("get_workflow_permissions", Scope::RepoRead),
    ("get_fork_pr_approval", Scope::RepoRead),
    ("get_actions_access", Scope::RepoRead),
    ("get_actions_permissions", Scope::RepoRead),
    ("update_environment", Scope::RepoAdmin),
    ("delete_environment", Scope::RepoAdmin),
    ("set_workflow_permissions", Scope::RepoAdmin),
    ("set_fork_pr_approval", Scope::RepoAdmin),
    ("set_actions_access", Scope::RepoAdmin),
    ("set_actions_permissions", Scope::RepoAdmin),
    // Starting workflows from outside, as a push would.
    ("create_repository_dispatch", Scope::CodeWrite),
    // A workspace's policy for its repositories' tokens.
    ("get_workspace_workflow_permissions", Scope::WorkspaceRead),
    ("set_workspace_workflow_permissions", Scope::WorkspaceAdmin),
    // The workflows a workspace runs in its repositories: its owners'.
    ("list_workspace_managed_workflows", Scope::WorkspaceRead),
    ("create_workspace_managed_workflow", Scope::WorkspaceAdmin),
    ("update_workspace_managed_workflow", Scope::WorkspaceAdmin),
    ("delete_workspace_managed_workflow", Scope::WorkspaceAdmin),
    // A person's own Getting started in a workspace: reading it is reading
    // the workspace; dismissing it changes only their own account.
    ("get_onboarding", Scope::WorkspaceRead),
    ("update_onboarding", Scope::AccountWrite),
    // A workspace's rules for personal access tokens, and the members'
    // tokens that reach it: who has access.
    ("get_token_policy", Scope::WorkspaceRead),
    ("set_token_policy", Scope::WorkspaceAdmin),
    ("list_member_tokens", Scope::AccessRead),
    ("list_token_requests", Scope::AccessRead),
    ("review_token_request", Scope::AccessAdmin),
    ("revoke_member_token", Scope::AccessAdmin),
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
    // Deploy keys: each lets a machine reach one repository, so they
    // are part of who has access.
    ("list_deploy_keys", Scope::AccessRead),
    ("get_deploy_key", Scope::AccessRead),
    ("create_deploy_key", Scope::AccessAdmin),
    ("delete_deploy_key", Scope::AccessAdmin),
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
    // Packages: reading them, their versions and who may use them needs
    // `packages:read`; changing their settings, access and Manage Actions
    // access `packages:write` (and the Admin role on the package, which the
    // packages service checks); deleting and restoring packages and
    // versions `packages:delete`, as the registries' own deletes do.
    ("list_packages", Scope::PackagesRead),
    ("get_package", Scope::PackagesRead),
    ("list_package_versions", Scope::PackagesRead),
    ("get_package_version", Scope::PackagesRead),
    ("list_package_access", Scope::PackagesRead),
    ("list_package_actions_access", Scope::PackagesRead),
    ("update_package", Scope::PackagesWrite),
    ("link_package", Scope::PackagesWrite),
    ("unlink_package", Scope::PackagesWrite),
    ("set_package_access", Scope::PackagesWrite),
    ("remove_package_access", Scope::PackagesWrite),
    ("set_package_actions_access", Scope::PackagesWrite),
    ("remove_package_actions_access", Scope::PackagesWrite),
    ("delete_package", Scope::PackagesDelete),
    ("restore_package", Scope::PackagesDelete),
    ("delete_package_version", Scope::PackagesDelete),
    ("restore_package_version", Scope::PackagesDelete),
    // Artifacts mode's docs, slides, designs and dashboards (the `artifact`
    // MCP tool). Reading takes artifacts:read, making and changing them
    // artifacts:write, and sharing them or deleting them for good
    // artifacts:admin. The artifacts service then checks the person's own role
    // on each one.
    ("list_workspace_artifacts", Scope::ArtifactsRead),
    ("search_workspace_artifacts", Scope::ArtifactsRead),
    ("get_workspace_artifact", Scope::ArtifactsRead),
    ("get_workspace_artifact_content", Scope::ArtifactsRead),
    ("list_workspace_artifact_versions", Scope::ArtifactsRead),
    ("get_workspace_artifact_access", Scope::ArtifactsRead),
    ("list_workspace_artifact_templates", Scope::ArtifactsRead),
    ("list_workspace_artifact_spaces", Scope::ArtifactsRead),
    ("query_workspace_dataset", Scope::ArtifactsRead),
    ("create_workspace_artifact", Scope::ArtifactsWrite),
    ("update_workspace_artifact", Scope::ArtifactsWrite),
    ("edit_workspace_artifact", Scope::ArtifactsWrite),
    ("trash_workspace_artifact", Scope::ArtifactsWrite),
    ("restore_workspace_artifact", Scope::ArtifactsWrite),
    ("restore_workspace_artifact_version", Scope::ArtifactsWrite),
    ("set_workspace_artifact_access", Scope::ArtifactsAdmin),
    ("purge_workspace_artifact", Scope::ArtifactsAdmin),
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
/// scope: changing who has access, rerunning a workflow, and making a
/// repository public or private.
pub fn extra_scopes(operation: &str, input: &serde_json::Value) -> Vec<Scope> {
    let mut extra = Vec::new();
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
    if operation == "update_repo" && ["private", "default_branch", "allow_forking", "max_ref_updates"].iter().any(|key| input.get(*key).is_some_and(|v| !v.is_null())) {
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
    // A workflow job may open or approve pull requests only where its
    // repository and workspace let it, as on GitHub.
    if let Some(job) = &access.job
        && !job.pull_requests
        && (operation == "create_pull_request" || (operation == "review_pull_request" && input["verdict"].as_str() == Some("approve")))
    {
        return Decision::deny(
            "token:pull-requests",
            "A workflow job cannot open or approve pull requests here: an admin can allow it under Settings, Actions.",
        );
    }
    if let Some(only) = access.repo.as_deref()
        && !NO_SCOPE.contains(&operation)
    {
        match input["repo"].as_str() {
            Some(repo) if access.reaches(repo) => {}
            Some(repo) => {
                return Decision::deny("token:repository", format!("{} {only}: it cannot reach {repo}.", one_repository(access)));
            }
            None => {
                return Decision::deny("token:repository", format!("{} {only}, and {operation} is not about one repository.", one_repository(access)));
            }
        }
    }
    // Making a repository (forking makes one) needs a token that reaches
    // every repository of the workspace it goes in, ones made later
    // included: a token for chosen repositories would otherwise make one
    // outside its choice and then administer it.
    if let Some(reach) = &access.reach
        && matches!(operation, "fork_repo" | "create_repo")
    {
        let destination = input["workspace"].as_str().map(str::trim).filter(|slug| !slug.is_empty());
        let elsewhere = match (&reach.workspace, destination) {
            (Some(workspace), Some(destination)) => !workspace.eq_ignore_ascii_case(destination),
            // Its owner's own workspace, which a workspace's token is not.
            (Some(_), None) => true,
            (None, _) => false,
        };
        if reach.repositories != RepositorySelection::All || elsewhere {
            return Decision::deny(
                "token:resource-owner",
                "This access token cannot create repositories there: that needs a token that reaches every repository of the workspace it goes in.",
            );
        }
    }
    // A token made for one workspace (or none) only reads outside it:
    // public repositories, as anyone may. Inside it, its repository
    // selection is checked with its owner's role (`access::granted`).
    if let Some(reach) = &access.reach
        && let Some(repo) = input["repo"].as_str()
        && !NO_SCOPE.contains(&operation)
    {
        let namespace = repo.split('/').next().unwrap_or_default();
        // Forking only reads its source; where the fork goes is judged above.
        let changes = operation != "fork_repo" && needed(operation, input).iter().any(|scope| scope.level() != Level::Read);
        if changes && !reach.owned_by(namespace) {
            let made_for = reach.workspace.as_deref().map_or_else(|| "your account only".to_owned(), |workspace| format!("the workspace {workspace}"));
            return Decision::deny(
                "token:resource-owner",
                format!("This access token is made for {made_for}: elsewhere it can only read public repositories, and {repo} is not in its reach."),
            );
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

/// What a token held to one repository is, for saying why it was refused.
fn one_repository(access: &TokenAccess) -> &'static str {
    if access.job.is_some() { "This token is a workflow job's in" } else { "This token reaches only" }
}

/// Whether a token may use the repository `owner/name` at all: a refusal
/// for a workflow job's token or a deploy key in another repository,
/// else `None`. Git and
/// the package registries ask this before [`decide_git`] and
/// [`decide_packages`].
pub fn decide_repo(access: &TokenAccess, repo: &str) -> Option<Decision> {
    let only = access.repo.as_deref()?;
    let why = if access.deploy_key.is_some() {
        format!("This deploy key is for {only}: it cannot reach {repo}.")
    } else {
        format!("{} {only}: it cannot reach {repo}.", one_repository(access))
    };
    (!access.reaches(repo)).then(|| Decision::deny("token:repository", why))
}

/// Whether a token may clone or fetch (`write` false), or push to (`write`
/// true), a repository with git. `public` is whether anyone may read it,
/// which needs no scope.
pub fn decide_git(access: &TokenAccess, write: bool, public: bool) -> Decision {
    let needed = if write { Scope::CodeWrite } else { Scope::CodeRead };
    if !access.allows(needed) && (write || !public) {
        if access.deploy_key.is_some() {
            return Decision::deny(
                "token:scope",
                "This deploy key is read-only. An admin of the repository can add it again with write access to push with it.",
            );
        }
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
        Level::Create | Level::Write | Level::Run => (Scope::PackagesWrite, "push or publish packages"),
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
        assert!(Scope::RepoWrite.includes(Scope::RepoCreate));
        assert!(Scope::RepoCreate.includes(Scope::RepoRead));
        assert!(!Scope::RepoCreate.includes(Scope::RepoWrite));
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
        assert!(!scopes.contains(&Scope::AgentsRun));
        assert!(scopes.iter().all(|scope| !scope.dangerous()), "{scopes:?}");
        for read in Scope::ALL.into_iter().filter(|scope| scope.level() == Level::Read && scope.offered()) {
            // Every read offered but the machines work runs on, and chat.
            assert_eq!(scopes.contains(&read), read != Scope::RunnersRead && read != Scope::ChatRead, "{read:?}");
        }
        assert!(Preset::ReadOnly.scopes().unwrap().iter().all(|scope| scope.level() == Level::Read));
        assert_eq!(Preset::Full.scopes(), None);
    }

    #[test]
    fn retired_scopes_parse_but_are_never_granted() {
        // Stored tokens and OAuth grants that hold them still read.
        for text in ["agents:run", "memory:read", "memory:write", "models:read", "models:write"] {
            let scope = Scope::parse(text).unwrap();
            assert!(scope.resource().retired() && !scope.offered(), "{text}");
            let back: Scope = serde_json::from_value(json!(text)).unwrap();
            assert_eq!(back, scope);
        }
        // But nothing hands them out, and asking for them gets the rest.
        assert_eq!(parse_scopes("agents:run issues:read memory:write models:write"), vec![Scope::IssuesRead]);
        assert!(!offered_scopes().iter().any(|scope| scope.resource().retired()));
        assert!(!everything().iter().any(|scope| scope.resource().retired()));
        for preset in Preset::ALL {
            let scopes = preset.scopes().unwrap_or_default();
            assert!(!scopes.iter().any(|scope| scope.resource().retired()), "{}", preset.as_str());
        }
        // And no operation needs them.
        assert!(!OPERATIONS.iter().any(|(_, scope)| scope.resource().retired()));
    }

    #[test]
    fn billing_is_read_by_presets_and_changed_by_none_but_full_access() {
        assert!(Preset::ReadOnly.scopes().unwrap().contains(&Scope::BillingRead));
        for preset in [Preset::ReadOnly, Preset::Agent, Preset::Ci] {
            assert!(!preset.scopes().unwrap().contains(&Scope::BillingWrite), "{}", preset.as_str());
        }
        assert_eq!(scope_for("set_budget"), Some(Scope::BillingWrite));
        assert_eq!(scope_for("get_usage"), Some(Scope::BillingRead));
        let reader = token(&[Scope::BillingRead]);
        assert!(decide(&reader, "list_invoices", &json!({})).allowed);
        assert!(decide(&reader, "set_budget", &json!({})).reason.unwrap().contains("billing:write"));
    }

    #[test]
    fn artifacts_are_offered_read_by_presets_and_shared_only_with_admin() {
        for scope in [Scope::ArtifactsRead, Scope::ArtifactsWrite, Scope::ArtifactsAdmin] {
            assert_eq!(scope.resource(), Resource::Artifacts);
            assert!(scope.offered());
            assert!(offered_scopes().contains(&scope));
            assert_eq!(parse_scopes(scope.as_str()), vec![scope]);
            assert!(OPERATIONS.iter().any(|(_, needed)| *needed == scope), "{scope:?} gates nothing");
        }
        // Reading them is a read like any other; changing them is chosen.
        for preset in [Preset::ReadOnly, Preset::Agent] {
            let scopes = preset.scopes().unwrap();
            assert!(scopes.contains(&Scope::ArtifactsRead), "{}", preset.as_str());
            assert!(!scopes.contains(&Scope::ArtifactsWrite) && !scopes.contains(&Scope::ArtifactsAdmin), "{}", preset.as_str());
        }
        assert!(!Preset::Ci.scopes().unwrap().contains(&Scope::ArtifactsRead));
        assert!(everything().contains(&Scope::ArtifactsAdmin));
        assert!(Scope::ArtifactsAdmin.includes(Scope::ArtifactsWrite));
        assert!(Scope::ArtifactsAdmin.dangerous());
        assert!(!Scope::ArtifactsWrite.dangerous());
        assert_eq!(Resource::Artifacts.group(), ResourceGroup::Workspace);
        let asked = std::collections::BTreeMap::from([("artifacts".to_owned(), "write".to_owned())]);
        assert_eq!(resolve_permissions(&asked, true), Ok(vec![Scope::ArtifactsWrite]));
        assert!(offered_scopes().contains(&Scope::ArtifactsAdmin));
        // Sharing and deleting for good need admin; editing needs write.
        assert_eq!(scope_for("set_workspace_artifact_access"), Some(Scope::ArtifactsAdmin));
        assert_eq!(scope_for("purge_workspace_artifact"), Some(Scope::ArtifactsAdmin));
        assert_eq!(scope_for("edit_workspace_artifact"), Some(Scope::ArtifactsWrite));
        assert_eq!(scope_for("get_workspace_artifact_content"), Some(Scope::ArtifactsRead));
        let writer = token(&[Scope::ArtifactsWrite]);
        assert!(decide(&writer, "edit_workspace_artifact", &json!({})).allowed);
        assert!(decide(&writer, "list_workspace_artifacts", &json!({})).allowed, "write includes read");
        assert!(decide(&writer, "set_workspace_artifact_access", &json!({})).reason.unwrap().contains("artifacts:admin"));
        // Workflow runs' artifacts are another thing, with their own scope.
        let reader = token(&[Scope::ArtifactsRead]);
        assert!(!decide(&reader, "list_artifacts", &json!({ "repo": "acme/web" })).allowed);
        assert!(!decide(&token(&[Scope::WorkflowsRead]), "list_workspace_artifacts", &json!({})).allowed);
    }

    #[test]
    fn chat_is_a_persons_own_and_given_only_when_asked_for() {
        for scope in [Scope::ChatRead, Scope::ChatWrite] {
            assert_eq!(scope.resource(), Resource::Chat);
            assert!(!scope.dangerous());
            assert_eq!(Scope::parse(scope.as_str()), Some(scope));
        }
        assert_eq!(Resource::Chat.label(), "Chat");
        assert_eq!(Resource::Chat.group(), ResourceGroup::Account);
        assert!(Scope::ChatWrite.includes(Scope::ChatRead));
        assert!(!Scope::ChatRead.includes(Scope::ChatWrite));
        // No preset, and so no OAuth default, gives it.
        for preset in Preset::ALL {
            let scopes = preset.scopes().unwrap_or_default();
            assert!(!scopes.iter().any(|scope| scope.resource() == Resource::Chat), "{}", preset.as_str());
        }
        assert!(!oauth_default().iter().any(|scope| scope.resource() == Resource::Chat));
        // An application that asks for it by name gets it; full access holds it.
        assert_eq!(parse_scopes("chat:read chat:write"), vec![Scope::ChatRead, Scope::ChatWrite]);
        assert!(offered_scopes().contains(&Scope::ChatWrite));
        assert!(everything().contains(&Scope::ChatWrite));
        assert!(TokenAccess::full().allows(Scope::ChatWrite));
        // Only a person's token may hold it.
        let asked = std::collections::BTreeMap::from([("chat".to_owned(), "write".to_owned())]);
        assert_eq!(resolve_permissions(&asked, true), Ok(vec![Scope::ChatWrite]));
        assert!(resolve_permissions(&asked, false).is_err());
    }

    #[test]
    fn the_agent_preset_creates_repositories_and_changes_none() {
        let agent = Preset::Agent.scopes().unwrap();
        assert!(agent.contains(&Scope::RepoCreate));
        assert!(!agent.contains(&Scope::RepoWrite) && !agent.contains(&Scope::RepoAdmin));
        assert!(oauth_default().contains(&Scope::RepoCreate));
        assert_eq!(Scope::parse("repo:create"), Some(Scope::RepoCreate));
        assert_eq!(Scope::RepoCreate.level(), Level::Create);
        assert!(!Scope::RepoCreate.dangerous());
        // Creating needs repo:create, which repo:write still gives.
        assert_eq!(scope_for("create_repo"), Some(Scope::RepoCreate));
        let creator = token(&agent);
        assert!(decide(&creator, "create_repo", &json!({ "name": "web" })).allowed);
        assert!(decide(&token(&[Scope::RepoWrite]), "create_repo", &json!({ "name": "web" })).allowed);
        assert!(!decide(&token(&[Scope::RepoRead]), "create_repo", &json!({ "name": "web" })).allowed);
        // And nothing that changes or deletes what is there.
        for op in [
            "update_repo",
            "update_repo_settings",
            "delete_branch",
            "rename_branch",
            "delete_release",
            "fork_repo",
            "set_repo_visibility",
            "delete_repo",
            "transfer_repo",
        ] {
            assert!(!decide(&creator, op, &json!({ "repo": "acme/web" })).allowed, "{op}");
        }
        // As a permission it is one level of repositories.
        let asked = std::collections::BTreeMap::from([("repo".to_owned(), "create".to_owned())]);
        assert_eq!(resolve_permissions(&asked, true), Ok(vec![Scope::RepoCreate]));
        assert_eq!(top_scopes(&[Scope::RepoRead, Scope::RepoCreate]), vec![Scope::RepoCreate]);
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
            job: Some(JobToken { run_id: "run_1".into(), job_id: "job_1".into(), pull_requests: false }),
            ..token(&[Scope::RepoRead, Scope::IssuesWrite, Scope::IssuesRead, Scope::PullRequestsWrite])
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
        // Opening and approving pull requests is off unless allowed.
        assert_eq!(decide(&job, "create_pull_request", &json!({ "repo": "acme/web" })).rule, "token:pull-requests");
        assert!(!decide(&job, "review_pull_request", &json!({ "repo": "acme/web", "verdict": "approve" })).allowed);
        assert!(decide(&job, "review_pull_request", &json!({ "repo": "acme/web", "verdict": "request_changes" })).allowed);
        let allowed = TokenAccess { job: Some(JobToken { pull_requests: true, ..job.job.clone().unwrap() }), ..job.clone() };
        assert!(decide(&allowed, "create_pull_request", &json!({ "repo": "acme/web" })).allowed);
    }

    #[test]
    fn workflow_files_need_their_own_scope() {
        for path in [".g1t/workflows/ci.yml", ".github/workflows/deploy.yaml", "/.github/workflows/x.yml", ".GitHub/Workflows/ci.yml", ".github/workflows"] {
            assert!(is_workflow_file(path), "{path}");
        }
        for path in ["README.md", ".github/CODEOWNERS", ".github/workflowsx/ci.yml", "docs/.github/workflows/ci.yml", ".g1t/actions/ci.yml"] {
            assert!(!is_workflow_file(path), "{path}");
        }
        let code = token(&[Scope::CodeWrite]);
        let refused = decide_workflow_files(Some(&code), ["README.md", ".github/workflows/ci.yml"]).unwrap();
        assert_eq!(refused.rule, "token:workflows");
        assert!(refused.reason.as_deref().unwrap().contains(".github/workflows/ci.yml"));
        assert!(refused.reason.as_deref().unwrap().contains("workflow_files:write"));
        assert!(decide_workflow_files(Some(&code), ["README.md"]).is_none());
        assert!(decide_workflow_files(Some(&token(&[Scope::CodeWrite, Scope::WorkflowFilesWrite])), [".g1t/workflows/ci.yml"]).is_none());
        assert!(decide_workflow_files(Some(&TokenAccess::full()), [".g1t/workflows/ci.yml"]).is_none(), "full access");
        assert!(decide_workflow_files(None, [".g1t/workflows/ci.yml"]).is_none(), "a signed-in person");
        // A job's token never may, as GITHUB_TOKEN never may.
        let job = TokenAccess { job: Some(JobToken::default()), ..TokenAccess::full() };
        assert!(decide_workflow_files(Some(&job), [".g1t/workflows/ci.yml"]).unwrap().reason.unwrap().contains("job"));
        // Nothing in a preset changes workflow files but full access.
        for preset in [Preset::ReadOnly, Preset::Agent, Preset::Ci] {
            assert!(!preset.scopes().unwrap().contains(&Scope::WorkflowFilesWrite), "{}", preset.as_str());
        }
        assert!(!Scope::WorkflowFilesWrite.includes(Scope::WorkflowsWrite) && !Scope::WorkflowsWrite.includes(Scope::WorkflowFilesWrite));
    }

    #[test]
    fn a_narrowed_token_only_reads_outside_its_workspace() {
        let reach = TokenReach { workspace: Some("acme".into()), repositories: RepositorySelection::All, repo_ids: Vec::new() };
        let fine = TokenAccess { reach: Some(reach), ..token(&[Scope::RepoRead, Scope::IssuesRead, Scope::IssuesWrite]) };
        assert!(decide(&fine, "create_issue", &json!({ "repo": "acme/web" })).allowed);
        assert!(decide(&fine, "create_issue", &json!({ "repo": "Acme/web" })).allowed);
        let elsewhere = decide(&fine, "create_issue", &json!({ "repo": "globex/site" }));
        assert_eq!(elsewhere.rule, "token:resource-owner");
        assert!(elsewhere.reason.unwrap().contains("acme"));
        assert!(decide(&fine, "get_issue", &json!({ "repo": "globex/site" })).allowed, "public repositories elsewhere read");
        assert!(!decide(&fine, "create_pull_request", &json!({ "repo": "acme/web" })).allowed, "its scopes still hold");
        let mine = TokenAccess { reach: Some(TokenReach::default()), ..token(&[Scope::IssuesWrite]) };
        assert!(decide(&mine, "create_issue", &json!({ "repo": "acme/web" })).reason.unwrap().contains("your account"));
        assert!(fine.covers_repo("rep_1", "acme") && !fine.covers_repo("rep_1", "globex"));
        let selected = TokenReach { workspace: Some("acme".into()), repositories: RepositorySelection::Selected, repo_ids: vec!["rep_1".into()] };
        assert!(selected.covers("rep_1", "ACME") && !selected.covers("rep_2", "acme"));
        let public = TokenReach { repositories: RepositorySelection::Public, ..selected.clone() };
        assert!(!public.covers("rep_1", "acme") && public.owned_by("acme"));
        assert!(token(&[]).covers_repo("rep_1", "anything"), "a token for every workspace reaches what its owner can");
        assert_eq!(RepositorySelection::parse("public_only"), Some(RepositorySelection::Public));
    }

    #[test]
    fn only_a_token_for_all_of_a_workspace_makes_repositories_there() {
        let all = TokenReach { workspace: Some("acme".into()), repositories: RepositorySelection::All, repo_ids: Vec::new() };
        let writes = |reach: TokenReach| TokenAccess { reach: Some(reach), ..token(&[Scope::RepoRead, Scope::RepoWrite]) };
        let fork = |workspace: Option<&str>| json!({ "repo": "acme/lib", "workspace": workspace });
        assert!(decide(&writes(all.clone()), "fork_repo", &fork(Some("acme"))).allowed);
        assert!(decide(&writes(all.clone()), "create_repo", &json!({ "workspace": "Acme" })).allowed);
        // Its chosen repositories, or public ones only: never a new one.
        let selected = TokenReach { repositories: RepositorySelection::Selected, repo_ids: vec!["rep_1".into()], ..all.clone() };
        let refused = decide(&writes(selected), "fork_repo", &fork(Some("acme")));
        assert_eq!(refused.rule, "token:resource-owner");
        assert!(refused.reason.unwrap().contains("every repository"));
        let public = TokenReach { repositories: RepositorySelection::Public, ..all.clone() };
        assert!(!decide(&writes(public), "create_repo", &json!({ "workspace": "acme" })).allowed);
        // Another workspace, or its maker's own, which is not the token's.
        assert!(!decide(&writes(all.clone()), "fork_repo", &fork(Some("globex"))).allowed);
        assert!(!decide(&writes(all), "fork_repo", &fork(None)).allowed);
        // A token for its owner's account forks into their own workspace.
        assert!(decide(&writes(TokenReach::default()), "fork_repo", &fork(None)).allowed);
        // Forking only reads its source, wherever that is.
        let elsewhere = json!({ "repo": "globex/site", "workspace": "acme" });
        assert!(decide(&writes(TokenReach { workspace: Some("acme".into()), ..TokenReach::default() }), "fork_repo", &elsewhere).allowed);
    }

    #[test]
    fn permissions_are_scopes_read_per_resource() {
        let asked: std::collections::BTreeMap<String, String> =
            [("issues", "write"), ("repo", "read"), ("code", "none"), ("packages", "delete")].iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect();
        let scopes = resolve_permissions(&asked, true).unwrap();
        assert_eq!(scopes, vec![Scope::RepoRead, Scope::PackagesDelete, Scope::IssuesWrite]);
        let back = permissions_of(&scopes);
        assert_eq!(back.get("issues").map(String::as_str), Some("write"));
        assert_eq!(back.get("packages").map(String::as_str), Some("delete"));
        assert!(!back.contains_key("code"));
        // Lower levels held beside a higher one say nothing more.
        assert_eq!(top_scopes(&[Scope::RepoRead, Scope::RepoAdmin, Scope::RepoWrite]), vec![Scope::RepoAdmin]);
        // Every offered resource's top, and nothing a level can lose.
        let all = everything();
        assert_eq!(all.len(), Resource::ALL.into_iter().filter(|resource| resource.offered()).count());
        for scope in offered_scopes() {
            assert!(all.iter().any(|held| held.includes(scope)), "{scope:?}");
        }
    }

    #[test]
    fn permissions_are_checked_by_name_level_and_owner() {
        let one = |name: &str, level: &str| -> std::collections::BTreeMap<String, String> { [(name.to_owned(), level.to_owned())].into() };
        assert!(resolve_permissions(&one("wiki", "read"), true).unwrap_err().contains("wiki"));
        assert!(resolve_permissions(&one("issues", "admin"), true).unwrap_err().contains("read, write"));
        assert!(resolve_permissions(&one("workflow_files", "read"), true).is_err(), "workflow files are written only");
        assert!(resolve_permissions(&one("notifications", "read"), false).unwrap_err().contains("account"));
        assert_eq!(resolve_permissions(&one("notifications", "read"), true).unwrap(), vec![Scope::NotificationsRead]);
        assert!(resolve_permissions(&one("agents", "run"), false).unwrap_err().contains("agents"), "retired");
        assert!(resolve_permissions(&one("models", "read"), false).is_err(), "retired");
        for resource in Resource::ALL {
            assert_eq!(Resource::parse(resource.as_str()), Some(resource));
            assert!(!resource.scopes().is_empty());
        }
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
    fn making_a_repository_public_or_private_needs_repo_admin() {
        let maintainer = token(&[Scope::RepoWrite]);
        assert!(decide(&maintainer, "update_repo", &json!({ "website": "https://x.dev" })).allowed);
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
        // Using the website is off unless set, and said only when on.
        assert!(!access.website);
        assert!(wire_of(&access).get("website").is_none());
        let website = TokenAccess { website: true, ..access };
        assert_eq!(wire_of(&website)["website"], json!(true));
        // Never part of full access.
        assert!(!TokenAccess::full().website);
    }

    fn wire_of(access: &TokenAccess) -> serde_json::Value {
        serde_json::to_value(access).unwrap()
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
        let names = |table: &str| -> Vec<String> {
            section(table)
                .lines()
                .filter_map(|line| line.split_once("scope: \"").and_then(|(_, rest)| rest.split_once('"')).map(|(scope, _)| scope.to_owned()))
                .collect()
        };
        // Offered scopes in `SCOPES`, retired ones in `RETIRED_SCOPES`, the
        // rest in `UPCOMING_SCOPES`.
        let listed = |keep: fn(&Scope) -> bool| -> Vec<String> { Scope::ALL.iter().filter(|scope| keep(scope)).map(|scope| scope.as_str().to_owned()).collect() };
        assert_eq!(names("export const SCOPES = ["), listed(|scope| scope.offered()));
        assert_eq!(names("export const UPCOMING_SCOPES"), listed(|scope| !scope.offered() && !scope.resource().retired()));
        assert_eq!(names("export const RETIRED_SCOPES"), listed(|scope| scope.resource().retired()));
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
        // Each resource with its group, in the same order: offered ones in
        // `SCOPE_RESOURCES`, retired ones in `RETIRED_RESOURCES`, the rest in
        // `UPCOMING_RESOURCES`.
        let tables: [(&str, fn(Resource) -> bool); 3] = [
            ("export const SCOPE_RESOURCES", |resource| resource.offered()),
            ("export const UPCOMING_RESOURCES", |resource| !resource.offered() && !resource.retired()),
            ("export const RETIRED_RESOURCES", |resource| resource.retired()),
        ];
        for (table, keep) in tables {
            let resources = ts
                .split_once(table)
                .and_then(|(_, rest)| rest.split_once("
];"))
                .map(|(table, _)| table)
                .unwrap_or_else(|| panic!("{table} in scopes.ts"));
            let rows: Vec<&str> = resources.lines().filter(|line| line.trim_start().starts_with("{ resource:")).collect();
            let expected: Vec<Resource> = Resource::ALL.into_iter().filter(|resource| keep(*resource)).collect();
            assert_eq!(rows.len(), expected.len(), "{table}");
            for (row, resource) in rows.iter().zip(expected) {
                assert!(row.contains(&format!("resource: \"{}\"", resource.as_str())), "{row}");
                assert!(row.contains(&format!("group: \"{}\"", resource.group().as_str())), "{row}");
            }
        }
    }
}
