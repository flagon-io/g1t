//! Deleting a workspace.
//!
//! Only an owner can, only a person, and only once the workspace is empty
//! and settled: no repositories (transfer them first), no projects of its
//! own, and billing able to close it (`close_workspace`: nothing owed that
//! cannot be charged now, no failed invoice, no prepaid credit left).
//!
//! The workspace's row, its memberships, its access tokens and its
//! old-slug redirects go. Billing's ledger and invoices, and the audit log,
//! keep its history under its slug. The slug itself is kept in
//! `deleted_workspaces`, so it is never given to another workspace or
//! account: old links keep meaning what they meant, and nobody can squat
//! the name. The one exception is the person whose username the slug is:
//! usernames and workspaces share one namespace, so the name is theirs
//! anyway, and they may make a workspace of it again (it starts empty).
//!
//! A person keeps their account whatever workspaces they lose: an account
//! with no workspace, or with only other people's, works as any other.
//!
//! The deletion publishes `workspace.deleted`; services drop what they
//! keep for the workspace alone.

use g1t_contracts::audit::{
    AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface,
};
use g1t_contracts::billing::CloseWorkspaceArgs;
use g1t_contracts::events::WorkspaceDeleted;
use g1t_contracts::identity::*;
use g1t_contracts::repos::NamespaceCountArgs;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::json;
use worker::Result;

use crate::Identity;

/// Who may delete, decided from the request alone: `Ok`, or why not.
pub fn may_delete(
    person: bool,
    verified: bool,
    role: Option<Role>,
    slug: &str,
    confirm: Option<&str>,
) -> std::result::Result<(), (FailureCode, String)> {
    if !person || role != Some(Role::Owner) {
        return Err((
            FailureCode::Forbidden,
            "Only an owner can delete a workspace.".into(),
        ));
    }
    if !verified {
        return Err((
            FailureCode::Forbidden,
            "Confirm your email address before deleting a workspace.".into(),
        ));
    }
    if let Some(typed) = confirm
        && typed.trim().to_lowercase() != slug
    {
        return Err((
            FailureCode::Invalid,
            format!("Type {slug} to confirm."),
        ));
    }
    Ok(())
}

/// Whether `slug`, once a deleted workspace's, may be taken by the person
/// whose username is `username`: only when it is that very name.
pub fn may_reclaim(slug: &str, username: &str) -> bool {
    slug.eq_ignore_ascii_case(username)
}

#[derive(Deserialize)]
struct Target {
    id: String,
    name: String,
}

impl Identity {
    /// Whether `slug` belonged to a workspace that was deleted.
    pub async fn slug_deleted(&self, slug: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT 1 AS held FROM deleted_workspaces WHERE slug = ?")
            .bind(&[slug.to_lowercase().into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some())
    }

    /// A workspace made again under a deleted slug is a workspace again.
    pub async fn forget_deleted(&self, slug: &str) -> Result<()> {
        self.db
            .prepare("DELETE FROM deleted_workspaces WHERE slug = ?")
            .bind(&[slug.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// What stands in the way: repositories, projects of its own, billing.
    async fn blockers(&self, a: &DeleteWorkspaceArgs, slug: &str) -> Result<WorkspaceDeletion> {
        let repositories: u32 = g1t_kit::call(
            &self.env.service("REPOS")?,
            "namespace_count",
            &NamespaceCountArgs {
                namespace: slug.to_owned(),
            },
        )
        .await?;
        let projects: u32 = g1t_kit::call(
            &self.env.service("PROJECTS")?,
            "held",
            &json!({ "workspace": slug }),
        )
        .await?;
        let closing: Outcome<bool> = g1t_kit::call(
            &self.env.service("BILLING")?,
            "close_workspace",
            &CloseWorkspaceArgs {
                actor: a.actor.clone(),
                workspace: slug.to_owned(),
                dry_run: true,
            },
        )
        .await?;
        Ok(WorkspaceDeletion {
            repositories,
            projects,
            billing: match closing {
                Outcome::Ok(_) => None,
                Outcome::Fail(failure) => Some(failure.message),
            },
        })
    }

    /// The workspace, if the actor may delete it.
    async fn deletable(&self, a: &DeleteWorkspaceArgs, confirm: bool) -> Result<Outcome<Target>> {
        let slug = a.slug.trim().to_lowercase();
        if let Err((code, message)) = may_delete(
            a.actor.kind == PrincipalKind::User,
            a.actor.verified,
            a.actor.role_in(&slug),
            &slug,
            confirm.then_some(a.confirm.as_str()),
        ) {
            return Ok(Outcome::fail(code, message));
        }
        Ok(
            match self
                .db
                .prepare("SELECT id, name FROM workspaces WHERE slug = ?")
                .bind(&[slug.as_str().into()])?
                .first::<Target>(None)
                .await?
            {
                Some(target) => Outcome::Ok(target),
                None => Outcome::fail(FailureCode::NotFound, "Workspace not found."),
            },
        )
    }

    pub async fn check_workspace_deletion(&self, a: DeleteWorkspaceArgs) -> Result<Outcome<WorkspaceDeletion>> {
        if let Outcome::Fail(failure) = self.deletable(&a, false).await? {
            return Ok(Outcome::Fail(failure));
        }
        let slug = a.slug.trim().to_lowercase();
        Ok(Outcome::Ok(self.blockers(&a, &slug).await?))
    }

    pub async fn delete_workspace(&self, a: DeleteWorkspaceArgs) -> Result<Outcome<bool>> {
        let workspace = match self.deletable(&a, true).await? {
            Outcome::Ok(workspace) => workspace,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let slug = a.slug.trim().to_lowercase();
        let blockers = self.blockers(&a, &slug).await?;
        if let Some(reason) = blockers.reason(&slug) {
            return Ok(Outcome::fail(FailureCode::Conflict, reason));
        }
        // Money first: if billing cannot settle it after all (a card
        // declined a moment ago), nothing is deleted.
        let closed: Outcome<bool> = g1t_kit::call(
            &self.env.service("BILLING")?,
            "close_workspace",
            &CloseWorkspaceArgs {
                actor: a.actor.clone(),
                workspace: slug.clone(),
                dry_run: false,
            },
        )
        .await?;
        if let Outcome::Fail(failure) = closed {
            return Ok(Outcome::Fail(failure));
        }
        let now = rfc3339(now_ms());
        let id = workspace.id.as_str();
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT OR REPLACE INTO deleted_workspaces (slug, workspace_id, name, deleted_by, deleted_at)
                         VALUES (?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        slug.as_str().into(),
                        id.into(),
                        workspace.name.as_str().into(),
                        a.actor.id.as_str().into(),
                        now.as_str().into(),
                    ])?,
                // Slugs it was renamed from, still redirecting, are kept
                // the same way.
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO deleted_workspaces (slug, workspace_id, name, deleted_by, deleted_at)
                         SELECT old_slug, workspace_id, ?, ?, ? FROM workspace_redirects WHERE workspace_id = ?",
                    )
                    .bind(&[
                        workspace.name.as_str().into(),
                        a.actor.id.as_str().into(),
                        now.as_str().into(),
                        id.into(),
                    ])?,
                self.db
                    .prepare("DELETE FROM access_tokens WHERE workspace_id = ?")
                    .bind(&[id.into()])?,
                self.db
                    .prepare("DELETE FROM workspace_members WHERE workspace_id = ?")
                    .bind(&[id.into()])?,
                self.db
                    .prepare("DELETE FROM workspace_redirects WHERE workspace_id = ?")
                    .bind(&[id.into()])?,
                self.db
                    .prepare("DELETE FROM workspaces WHERE id = ?")
                    .bind(&[id.into()])?,
            ])
            .await?;
        self.record_deletion(&a, &slug).await;
        self.announce(
            "workspace.deleted",
            Some(&a.actor.id),
            WorkspaceDeleted {
                workspace_id: workspace.id,
                slug,
            },
        )
        .await;
        Ok(Outcome::Ok(true))
    }

    /// The last entry in the workspace's audit log, which outlives it.
    async fn record_deletion(&self, a: &DeleteWorkspaceArgs, slug: &str) {
        let Ok(events) = self.env.service("EVENTS") else {
            return;
        };
        let entry = NewAuditEntry {
            actor: AuditActor::of(&a.actor),
            action: "workspace.deleted".to_owned(),
            surface: a.surface.unwrap_or(Surface::Web),
            target: AuditTarget {
                workspace: slug.to_owned(),
                ..AuditTarget::default()
            },
            outcome: AuditOutcome::Allowed,
            rule: "owner".to_owned(),
            result: Some("ok".to_owned()),
            message: Some(format!("Deleted {slug}")),
            request_id: new_id("req", now_ms()),
        };
        let recorded: Result<u32> = g1t_kit::call(
            &events,
            "audit_record",
            &RecordAuditArgs {
                entries: vec![entry],
            },
        )
        .await;
        if let Err(error) = recorded {
            worker::console_error!("deletion of {slug} not recorded: {error}");
        }
    }

    /// `transfer_repo_scopes`: agents at work on a transferred repository
    /// keep their scope, which names it by path.
    pub async fn transfer_repo_scopes(&self, a: TransferRepoScopesArgs) -> Result<bool> {
        self.db
            .prepare(
                "UPDATE access_tokens
                 SET agent_scope = json_set(agent_scope, '$.repo.namespace', ?1, '$.repo.name', ?2)
                 WHERE agent_scope IS NOT NULL
                   AND json_extract(agent_scope, '$.repo.namespace') = ?3
                   AND json_extract(agent_scope, '$.repo.name') = ?4",
            )
            .bind(&[
                a.to.namespace.as_str().into(),
                a.to.name.as_str().into(),
                a.from.namespace.as_str().into(),
                a.from.name.as_str().into(),
            ])?
            .run()
            .await?;
        // Who has access to it follows it too (access.rs).
        self.move_repo_access(&a.from, &a.to).await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_verified_owner_who_types_the_name() {
        assert!(may_delete(true, true, Some(Role::Owner), "acme", Some(" Acme ")).is_ok());
        assert!(may_delete(true, true, Some(Role::Owner), "acme", None).is_ok());
        assert_eq!(
            may_delete(true, true, Some(Role::Member), "acme", Some("acme")).unwrap_err().0,
            FailureCode::Forbidden
        );
        assert_eq!(
            may_delete(false, true, Some(Role::Owner), "acme", Some("acme")).unwrap_err().0,
            FailureCode::Forbidden
        );
        assert_eq!(
            may_delete(true, false, Some(Role::Owner), "acme", Some("acme")).unwrap_err().0,
            FailureCode::Forbidden
        );
        assert_eq!(
            may_delete(true, true, Some(Role::Owner), "acme", Some("acme-inc")).unwrap_err().0,
            FailureCode::Invalid
        );
    }

    #[test]
    fn a_deleted_slug_is_reclaimed_only_by_its_namesake() {
        assert!(may_reclaim("syntaqx", "syntaqx"));
        assert!(may_reclaim("syntaqx", "Syntaqx"));
        assert!(!may_reclaim("flagon-io", "syntaqx"));
    }
}
