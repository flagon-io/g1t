//! Fine-grained personal access tokens: what each permission is, and the
//! scopes it gives.
//!
//! A fine-grained token names one resource owner (the person's own
//! account, or one workspace), which of that workspace's repositories it
//! reaches (all, selected, or public ones only), and a level for each
//! permission: none, read or write (admin for the few that have it). The
//! permission names are the ones GitHub's fine-grained tokens use, so a
//! token's settings read the same there and here; g1t-only ones (agents,
//! memory) sit beside them.
//!
//! Each level maps onto g1t's own scopes ([`crate::scopes`]), and the token
//! stores them: every check that reads a classic token's scopes reads a
//! fine-grained token's the same way. Where g1t has one scope for what
//! GitHub splits in two (checks and statuses, secrets and variables), both
//! permissions give the same scopes, and each says so.
//!
//! `packages/contracts/src/fine-grained.ts` mirrors the table; a test here
//! keeps the two the same.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::scopes::{Scope, normalize};

/// Where a permission is shown, and which resource owner it needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionGroup {
    /// About repositories: needs a workspace as the resource owner.
    Repository,
    /// About the workspace itself: needs a workspace as the resource owner.
    Workspace,
    /// About the person: needs their own account as the resource owner.
    Account,
}

impl PermissionGroup {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionGroup::Repository => "repository",
            PermissionGroup::Workspace => "workspace",
            PermissionGroup::Account => "account",
        }
    }
}

/// How much of one permission.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    #[default]
    None,
    Read,
    Write,
    Admin,
}

impl Access {
    pub fn as_str(self) -> &'static str {
        match self {
            Access::None => "none",
            Access::Read => "read",
            Access::Write => "write",
            Access::Admin => "admin",
        }
    }

    pub fn parse(text: &str) -> Option<Access> {
        match text.trim().to_ascii_lowercase().as_str() {
            "none" | "no_access" | "" => Some(Access::None),
            "read" | "read_only" => Some(Access::Read),
            "write" | "read_write" | "read_and_write" => Some(Access::Write),
            "admin" => Some(Access::Admin),
            _ => None,
        }
    }
}

/// One permission a fine-grained token can be given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Permission {
    /// As the API and the form name it, such as `pull_requests`.
    pub name: &'static str,
    pub label: &'static str,
    pub group: PermissionGroup,
    /// What it covers, in plain words.
    pub about: &'static str,
    /// The scopes reading gives; empty when it has no read level (written
    /// to only, such as workflows).
    pub read: &'static [Scope],
    /// The scopes writing gives, besides reading's.
    pub write: &'static [Scope],
    /// The scopes admin gives, besides writing's; empty when it has none.
    pub admin: &'static [Scope],
}

impl Permission {
    /// The levels it can be set to, least first, none excluded.
    pub fn levels(&self) -> Vec<Access> {
        let mut levels = Vec::new();
        if !self.read.is_empty() {
            levels.push(Access::Read);
        }
        if !self.write.is_empty() {
            levels.push(Access::Write);
        }
        if !self.admin.is_empty() {
            levels.push(Access::Admin);
        }
        levels
    }

    /// The scopes `access` gives, lower levels' included.
    pub fn scopes(&self, access: Access) -> Vec<Scope> {
        let mut scopes = Vec::new();
        if access >= Access::Read {
            scopes.extend_from_slice(self.read);
        }
        if access >= Access::Write {
            scopes.extend_from_slice(self.write);
        }
        if access >= Access::Admin {
            scopes.extend_from_slice(self.admin);
        }
        scopes
    }
}

use PermissionGroup::{Account as A, Repository as R, Workspace as W};

/// Every permission, in the order the form shows them.
pub const PERMISSIONS: [Permission; 29] = [
    // Repository permissions.
    Permission { name: "actions", label: "Actions", group: R, about: "Workflow runs, jobs, logs and artifacts: reading them, and running, cancelling and rerunning workflows", read: &[Scope::WorkflowsRead], write: &[Scope::WorkflowsWrite], admin: &[] },
    Permission { name: "administration", label: "Administration", group: R, about: "Repository settings, rulesets, who has access and deploy keys; renaming, archiving, transferring and deleting", read: &[Scope::RepoRead, Scope::AccessRead], write: &[Scope::RepoAdmin, Scope::AccessAdmin], admin: &[] },
    Permission { name: "agents", label: "g1t agents", group: R, about: "Putting g1t's agents to work and messaging them, which uses the workspace's money", read: &[], write: &[Scope::AgentsRun], admin: &[] },
    Permission { name: "checks", label: "Checks", group: R, about: "Check runs and check suites on commits. Shares its scopes with Commit statuses", read: &[Scope::ChecksRead], write: &[Scope::ChecksWrite], admin: &[] },
    Permission { name: "contents", label: "Contents", group: R, about: "Code, branches, commits and releases: cloning and fetching, pushing, and publishing releases", read: &[Scope::CodeRead], write: &[Scope::CodeWrite, Scope::RepoWrite], admin: &[] },
    Permission { name: "deployments", label: "Deployments", group: R, about: "Deployments and their statuses", read: &[Scope::DeploymentsRead], write: &[Scope::DeploymentsWrite], admin: &[] },
    Permission { name: "environments", label: "Environments", group: R, about: "Environments, and their secrets and variables", read: &[Scope::DeploymentsRead, Scope::SecretsRead], write: &[Scope::SecretsAdmin], admin: &[] },
    Permission { name: "issues", label: "Issues", group: R, about: "Issues, their comments, labels and milestones, and plans", read: &[Scope::IssuesRead], write: &[Scope::IssuesWrite], admin: &[] },
    Permission { name: "memory", label: "Memory and context", group: R, about: "Recalling memory and searching the workspace's context, and saving memory for the next agent", read: &[Scope::MemoryRead], write: &[Scope::MemoryWrite], admin: &[] },
    Permission { name: "metadata", label: "Metadata", group: R, about: "Seeing repositories and searching them. Always read", read: &[Scope::RepoRead], write: &[], admin: &[] },
    Permission { name: "packages", label: "Packages", group: R, about: "Pulling private packages, publishing them, and (admin) deleting packages and versions", read: &[Scope::PackagesRead], write: &[Scope::PackagesWrite], admin: &[Scope::PackagesDelete] },
    Permission { name: "pages", label: "Pages", group: R, about: "Deployments on g1t.page. Shares its scopes with Deployments", read: &[Scope::DeploymentsRead], write: &[Scope::DeploymentsWrite], admin: &[] },
    Permission { name: "pull_requests", label: "Pull requests", group: R, about: "Pull requests, their reviews, changes, sessions and merge queues", read: &[Scope::PullRequestsRead], write: &[Scope::PullRequestsWrite], admin: &[] },
    Permission { name: "secrets", label: "Secrets", group: R, about: "Actions secrets: listing them (never their values), setting and deleting them. Shares its scopes with Variables", read: &[Scope::SecretsRead], write: &[Scope::SecretsAdmin], admin: &[] },
    Permission { name: "security_events", label: "Security events and alerts", group: R, about: "Code scanning, secret scanning and vulnerability alerts, SARIF uploads and security settings", read: &[Scope::SecurityRead], write: &[Scope::SecurityWrite], admin: &[] },
    Permission { name: "statuses", label: "Commit statuses", group: R, about: "Statuses on commits. Shares its scopes with Checks", read: &[Scope::ChecksRead], write: &[Scope::ChecksWrite], admin: &[] },
    Permission { name: "variables", label: "Variables", group: R, about: "Actions variables: reading, setting and deleting them. Shares its scopes with Secrets", read: &[Scope::SecretsRead], write: &[Scope::SecretsAdmin], admin: &[] },
    Permission { name: "webhooks", label: "Webhooks", group: R, about: "Webhooks and their deliveries", read: &[Scope::WebhooksRead], write: &[Scope::WebhooksAdmin], admin: &[] },
    Permission { name: "workflows", label: "Workflows", group: R, about: "Adding, changing and deleting workflow files under .g1t/workflows and .github/workflows. Write only", read: &[], write: &[Scope::WorkflowFilesWrite], admin: &[] },
    // Workspace permissions.
    Permission { name: "members", label: "Members", group: W, about: "The workspace's people, invitations and teams", read: &[Scope::WorkspaceRead], write: &[Scope::WorkspaceAdmin], admin: &[] },
    Permission { name: "workspace_administration", label: "Administration", group: W, about: "The workspace's settings, integrations, rulesets and base permission", read: &[Scope::WorkspaceRead, Scope::AccessRead], write: &[Scope::WorkspaceAdmin, Scope::AccessAdmin], admin: &[] },
    Permission { name: "workspace_billing", label: "Billing", group: W, about: "Usage, budget, AI credit and invoices, and (write) changing the budget and buying credit", read: &[Scope::BillingRead], write: &[Scope::BillingWrite], admin: &[] },
    Permission { name: "models", label: "AI Gateway", group: W, about: "AI Gateway requests: seeing them, and sending requests, which uses the workspace's AI credit", read: &[Scope::ModelsRead], write: &[Scope::ModelsWrite], admin: &[] },
    Permission { name: "self_hosted_runners", label: "Self-hosted runners", group: W, about: "Runners, their groups and settings", read: &[Scope::RunnersRead], write: &[Scope::RunnersAdmin], admin: &[] },
    Permission { name: "workspace_secrets", label: "Secrets", group: W, about: "The workspace's Actions secrets. Shares its scopes with the repository Secrets permission", read: &[Scope::SecretsRead], write: &[Scope::SecretsAdmin], admin: &[] },
    Permission { name: "workspace_webhooks", label: "Webhooks", group: W, about: "The workspace's webhooks. Shares its scopes with the repository Webhooks permission", read: &[Scope::WebhooksRead], write: &[Scope::WebhooksAdmin], admin: &[] },
    // Account permissions.
    Permission { name: "email_addresses", label: "Email addresses", group: A, about: "Your email addresses and email settings, invites and invitations", read: &[Scope::AccountRead], write: &[Scope::AccountWrite], admin: &[] },
    Permission { name: "starring", label: "Starring", group: A, about: "Stars and pinned projects. Shares its scopes with Email addresses", read: &[Scope::AccountRead], write: &[Scope::AccountWrite], admin: &[] },
    Permission { name: "notifications", label: "Notifications", group: A, about: "Your inbox, subscriptions and watched repositories", read: &[Scope::NotificationsRead], write: &[Scope::NotificationsWrite], admin: &[] },
];

/// The permission named `name`.
pub fn permission(name: &str) -> Option<&'static Permission> {
    PERMISSIONS.iter().find(|permission| permission.name == name)
}

/// The longest a fine-grained token may last, in days, whatever a
/// workspace allows.
pub const MAX_LIFETIME_DAYS: u32 = 366;

/// A token's permissions: each name's level, the ones left out none.
pub type Permissions = BTreeMap<String, Access>;

/// Checks permissions as asked for, for a token whose resource owner is a
/// workspace (`workspace` true) or the person's own account: the tidied
/// permissions (`metadata` always read, nothing at none) and the scopes
/// they give, or why they cannot be.
pub fn resolve(asked: &BTreeMap<String, String>, workspace: bool) -> Result<(Permissions, Vec<Scope>), String> {
    let mut permissions = Permissions::new();
    for (name, level) in asked {
        let Some(found) = permission(name) else {
            return Err(format!("There is no permission called {name}."));
        };
        let Some(access) = Access::parse(level) else {
            return Err(format!("{name} is none, read, write or admin."));
        };
        if access == Access::None {
            continue;
        }
        if !found.levels().contains(&access) {
            let levels: Vec<&str> = found.levels().iter().map(|level| level.as_str()).collect();
            return Err(format!("{name} can be {}, not {}.", levels.join(" or "), access.as_str()));
        }
        let fits = match found.group {
            PermissionGroup::Account => !workspace,
            PermissionGroup::Repository | PermissionGroup::Workspace => workspace,
        };
        if !fits {
            return Err(if workspace {
                format!("{name} is about your own account: choose yourself as the resource owner to give it.")
            } else {
                format!("{name} is about a workspace: choose a workspace as the resource owner to give it.")
            });
        }
        permissions.insert(found.name.to_owned(), access);
    }
    if workspace {
        let metadata = permissions.entry("metadata".to_owned()).or_insert(Access::Read);
        *metadata = (*metadata).max(Access::Read);
    }
    let mut scopes: Vec<Scope> = permissions
        .iter()
        .filter_map(|(name, access)| permission(name).map(|found| found.scopes(*access)))
        .flatten()
        .collect();
    normalize(&mut scopes);
    Ok((permissions, scopes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asked(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(name, level)| ((*name).to_owned(), (*level).to_owned())).collect()
    }

    #[test]
    fn names_are_unique_and_every_permission_has_a_level() {
        let mut seen = std::collections::HashSet::new();
        for permission in PERMISSIONS {
            assert!(seen.insert(permission.name), "{} twice", permission.name);
            assert!(!permission.levels().is_empty(), "{}", permission.name);
            assert!(permission.name.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{}", permission.name);
        }
    }

    #[test]
    fn github_permissions_map_onto_g1t_scopes() {
        let (permissions, scopes) = resolve(&asked(&[("contents", "write"), ("pull_requests", "read")]), true).unwrap();
        assert_eq!(permissions.get("metadata"), Some(&Access::Read), "metadata is always read");
        assert_eq!(scopes, vec![Scope::RepoRead, Scope::RepoWrite, Scope::CodeRead, Scope::CodeWrite, Scope::PullRequestsRead]);
        // Actions is runs; Workflows is the files, write only.
        let (_, actions) = resolve(&asked(&[("actions", "write")]), true).unwrap();
        assert!(actions.contains(&Scope::WorkflowsWrite) && !actions.contains(&Scope::WorkflowFilesWrite));
        let (_, files) = resolve(&asked(&[("workflows", "write")]), true).unwrap();
        assert!(files.contains(&Scope::WorkflowFilesWrite) && !files.contains(&Scope::WorkflowsWrite));
        assert!(resolve(&asked(&[("workflows", "read")]), true).unwrap_err().contains("write"));
        // Pages are deployments; statuses are checks.
        let (_, pages) = resolve(&asked(&[("pages", "write")]), true).unwrap();
        assert!(pages.contains(&Scope::DeploymentsWrite));
        let (_, statuses) = resolve(&asked(&[("statuses", "write")]), true).unwrap();
        assert!(statuses.contains(&Scope::ChecksWrite));
        // Packages have admin, which deletes.
        let (_, packages) = resolve(&asked(&[("packages", "admin")]), true).unwrap();
        assert!(packages.contains(&Scope::PackagesDelete) && packages.contains(&Scope::PackagesWrite));
        assert!(resolve(&asked(&[("issues", "admin")]), true).is_err());
    }

    #[test]
    fn permissions_fit_their_resource_owner() {
        assert!(resolve(&asked(&[("email_addresses", "read")]), true).unwrap_err().contains("your own account"));
        assert!(resolve(&asked(&[("contents", "read")]), false).unwrap_err().contains("workspace"));
        let (permissions, scopes) = resolve(&asked(&[("notifications", "write")]), false).unwrap();
        assert!(!permissions.contains_key("metadata"), "no repositories, no metadata");
        assert_eq!(scopes, vec![Scope::NotificationsRead, Scope::NotificationsWrite]);
        assert!(resolve(&asked(&[("wiki", "read")]), true).unwrap_err().contains("wiki"));
        // None is left out.
        let (permissions, _) = resolve(&asked(&[("issues", "none")]), true).unwrap();
        assert!(!permissions.contains_key("issues"));
    }

    /// `packages/contracts/src/fine-grained.ts` lists the same permissions,
    /// in the same order, with the same scopes.
    #[test]
    fn the_typescript_mirror_has_the_same_table() {
        let ts = include_str!("../../../packages/contracts/src/fine-grained.ts");
        let table = ts
            .split_once("export const PERMISSIONS = [")
            .and_then(|(_, rest)| rest.split_once("] as const"))
            .map(|(table, _)| table)
            .expect("PERMISSIONS in fine-grained.ts");
        let rows: Vec<&str> = table.lines().filter(|line| line.trim_start().starts_with("{ name:")).collect();
        assert_eq!(rows.len(), PERMISSIONS.len());
        for (row, permission) in rows.iter().zip(PERMISSIONS) {
            assert!(row.contains(&format!("name: \"{}\"", permission.name)), "{row}");
            assert!(row.contains(&format!("group: \"{}\"", permission.group.as_str())), "{row}");
            let list = |scopes: &[Scope]| format!("[{}]", scopes.iter().map(|scope| format!("\"{}\"", scope.as_str())).collect::<Vec<_>>().join(", "));
            assert!(row.contains(&format!("read: {}", list(permission.read))), "{row}");
            assert!(row.contains(&format!("write: {}", list(permission.write))), "{row}");
            assert!(row.contains(&format!("admin: {}", list(permission.admin))), "{row}");
        }
    }
}
