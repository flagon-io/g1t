//! Deleting a workspace.
//!
//! Only an owner can, only a person, typing the slug to confirm, and only
//! once billing can settle it (`close_workspace`: nothing owed that cannot
//! be charged now, no failed invoice, no prepaid credit left). Some
//! workspaces can never be deleted, by anyone: those in
//! `PROTECTED_WORKSPACES`, Flagon's whatever that says
//! (`g1t_contracts::identity::protected_names`), and any whose row is
//! marked protected, which a rename of a protected workspace sets so the
//! protection follows it.
//!
//! Everything in it goes in that one step, softly. The row gets
//! `deleted_at`, `deleted_by` and `purge_after` ([`WORKSPACE_RESTORE_DAYS`]
//! on), and every read that resolves a workspace leaves it out: nobody's
//! memberships list it, its tokens are refused, its pages are not found.
//! Its members and tokens are kept as they were, and its slug stays held by
//! its row. `workspace.deleting` tells every service to put away what it
//! keeps for it: repos deletes its repositories softly, marked as gone with
//! it, deployments pauses its apps, projects and search hide it.
//!
//! Until `purge_after`, g1t's staff can restore it from sudo: the columns
//! are cleared, `workspace.restored` undoes exactly what the deletion did,
//! and it is back with its members and tokens. A malicious or mistaken
//! deletion is undone this way, through support.
//!
//! The purge, by the scheduled sweep once `purge_after` passes or by staff
//! from sudo, is what deleting used to do at once: the row, memberships,
//! tokens and old-slug redirects go, the slug is kept in
//! `deleted_workspaces` so it is never given to another workspace or
//! account, and `workspace.deleted` tells services to drop what they keep.
//! Billing's ledger and invoices, and the audit log, keep its history under
//! its slug. The one exception to the slug is the person whose username it
//! is: usernames and workspaces share one namespace, so the name is theirs
//! anyway, and they may make a workspace of it again (it starts empty).
//!
//! A person keeps their account whatever workspaces they lose: an account
//! with no workspace, or with only other people's, works as any other.
//!
//! g1t's staff delete a workspace only together with the account that is
//! its only owner (account_deletion.rs, `with_sole_workspaces`), through
//! [`Identity::staff_delete_workspace`]: the same steps, the same refusals
//! (protected, billing that cannot settle), with the staff member as
//! `deleted_by` and a line in sudo's audit log with the reason.

use g1t_contracts::audit::{
    AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface,
};
use g1t_contracts::billing::CloseWorkspaceArgs;
use g1t_contracts::events::{WorkspaceDeleted, WorkspaceDeleting, WorkspaceRestored};
use g1t_contracts::identity::*;
use g1t_contracts::repos::NamespaceCountArgs;
use g1t_contracts::time::rfc3339;
use g1t_contracts::account_deletion::WorkspaceDeletedWith;
use g1t_contracts::{FailureCode, Membership, Outcome, PrincipalKind, Role, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use serde_json::json;
use worker::Result;

use crate::Identity;

type Refusal = (FailureCode, String);

/// How many workspaces one sweep purges.
const PURGES_PER_SWEEP: u32 = 25;

/// Who may delete, decided from the request and whether the workspace is
/// protected: `Ok`, or why not. A protected workspace is refused to
/// everyone, owners included.
pub fn may_delete(
    protected: bool,
    person: bool,
    verified: bool,
    role: Option<Role>,
    slug: &str,
    confirm: Option<&str>,
) -> std::result::Result<(), Refusal> {
    if protected {
        return Err((FailureCode::Forbidden, protected_refusal(slug)));
    }
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

/// When a workspace deleted at `now_ms` is purged.
pub fn purge_after(now_ms: u64) -> String {
    rfc3339(now_ms + WORKSPACE_RESTORE_DAYS * 86_400_000)
}

/// Whether a workspace to be purged at `purge_after` can still be restored
/// at `now` (both RFC 3339, which compare as text). Once it cannot, the
/// next sweep purges it.
pub fn restorable(purge_after: &str, now: &str) -> bool {
    now < purge_after
}

/// Whether the workspace `id`, now at `slug`, is protected: its row says
/// so (`flagged`), or `names` (from [`protected_names`]) holds its id, its
/// slug or a slug it was renamed from (`old_slugs`).
pub fn is_protected(names: &[String], id: &str, slug: &str, flagged: bool, old_slugs: &[String]) -> bool {
    let named = |name: &str| names.iter().any(|protected| protected.eq_ignore_ascii_case(name));
    flagged || named(id) || named(slug) || old_slugs.iter().any(|old| named(old))
}

/// Whether staff may restore a deleted workspace, now `now`.
pub fn may_restore(slug: &str, purge_after: &str, now: &str) -> std::result::Result<(), Refusal> {
    if !restorable(purge_after, now) {
        return Err((
            FailureCode::Conflict,
            format!("{slug} is being purged and can no longer be restored."),
        ));
    }
    Ok(())
}

/// Whether a deleted workspace may be purged, by staff (`confirm` is what
/// they typed) or by the sweep (`None`). Never a protected one.
pub fn may_purge(protected: bool, slug: &str, confirm: Option<&str>) -> std::result::Result<(), Refusal> {
    if protected {
        return Err((FailureCode::Forbidden, protected_refusal(slug)));
    }
    if let Some(typed) = confirm
        && typed.trim().to_lowercase() != slug
    {
        return Err((FailureCode::Invalid, format!("Type {slug} to confirm.")));
    }
    Ok(())
}

/// Who billing's `close_workspace` sees when staff delete a workspace with
/// the account that is its only owner: the account, as owner of `slug`
/// (billing closes only for an owner), named by the staff member so
/// billing's record says who closed it.
pub fn staff_billing_actor(owner_id: &str, staff: &str, slug: &str) -> User {
    User {
        id: owner_id.to_owned(),
        username: staff.to_owned(),
        kind: PrincipalKind::User,
        verified: true,
        workspaces: vec![Membership { role: Role::Owner, ..Membership::member(slug) }],
        ..User::default()
    }
}

/// Who deletes a workspace, for its row, its audit log and the event.
struct Deleter<'a> {
    /// Who billing closes it for: an owner.
    billing: &'a User,
    /// `deleted_by` on its row: the owner's id, or the staff member.
    deleted_by: &'a str,
    /// `by` on `workspace.deleting`: the owner's username, or the staff
    /// member.
    by: &'a str,
    audit: AuditActor,
    surface: Surface,
    /// The audit log's rule: `owner` or `staff`.
    rule: &'static str,
    /// What the audit log says, given when it can be restored until.
    message: Box<dyn Fn(&str) -> String + 'a>,
    /// The event's actor.
    actor_id: Option<&'a str>,
}

/// What `deleted_went` holds: what went with the workspace.
fn went_json(went: &WorkspaceDeletion) -> String {
    json!({
        "repositories": went.repositories,
        "projects": went.projects,
        "members": went.members,
    })
    .to_string()
}

fn went_of(stored: Option<&str>) -> WorkspaceDeletion {
    stored
        .and_then(|text| serde_json::from_str::<WorkspaceDeletion>(text).ok())
        .unwrap_or_default()
}

#[derive(Deserialize)]
struct Target {
    id: String,
    #[serde(default)]
    protected: u8,
}

/// A deleted workspace's row.
#[derive(Deserialize)]
struct DeletedRow {
    id: String,
    slug: String,
    name: String,
    deleted_at: String,
    #[serde(default)]
    deleted_by: Option<String>,
    purge_after: String,
    #[serde(default)]
    deleted_went: Option<String>,
    #[serde(default)]
    protected: u8,
    /// The deleter's username, when their account is still there.
    #[serde(default)]
    deleter: Option<String>,
}

const DELETED_COLUMNS: &str = "w.id, w.slug, w.name, w.deleted_at, w.deleted_by, w.purge_after,
  w.deleted_went, w.protected, u.username AS deleter
  FROM workspaces w LEFT JOIN users u ON u.id = w.deleted_by
  WHERE w.deleted_at IS NOT NULL";

impl Identity {
    /// Whether `slug` belonged to a workspace that was deleted and purged,
    /// or is the username of an account that was (account_deletion.rs):
    /// neither is ever given to anyone again.
    pub async fn slug_deleted(&self, slug: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare(
                "SELECT 1 AS held FROM deleted_workspaces WHERE slug = ?1
                 UNION ALL SELECT 1 FROM deleted_users WHERE username = ?1",
            )
            .bind(&[slug.to_lowercase().into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some())
    }

    /// Whether a workspace holds `slug`, deleted or not: one deleted and
    /// not yet purged keeps it for a restore.
    pub async fn slug_in_use(&self, slug: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT 1 AS held FROM workspaces WHERE slug = ?")
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

    /// `PROTECTED_WORKSPACES`, with Flagon's whatever it says.
    fn protected_names(&self) -> Vec<String> {
        let configured = self.env.var("PROTECTED_WORKSPACES").ok().map(|v| v.to_string());
        protected_names(configured.as_deref())
    }

    /// Whether the workspace `id`, now at `slug`, can never be deleted.
    /// Asked each time, of its row, the variable and the slugs it was
    /// renamed from, so a rename cannot take the protection away.
    pub(crate) async fn is_protected(&self, id: &str, slug: &str, flagged: bool) -> Result<bool> {
        let names = self.protected_names();
        if is_protected(&names, id, slug, flagged, &[]) {
            return Ok(true);
        }
        #[derive(Deserialize)]
        struct Old {
            old_slug: String,
        }
        let old: Vec<String> = self
            .db
            .prepare("SELECT old_slug FROM workspace_redirects WHERE workspace_id = ?")
            .bind(&[id.into()])?
            .all()
            .await?
            .results::<Old>()?
            .into_iter()
            .map(|row| row.old_slug)
            .collect();
        Ok(is_protected(&names, id, slug, flagged, &old))
    }

    /// Why billing could not close `slug` now for `actor` (an owner), or
    /// `None` when it could. Changes nothing.
    pub(crate) async fn billing_refusal(&self, actor: &User, slug: &str) -> Result<Option<String>> {
        let closing: Outcome<bool> = g1t_kit::call(
            &self.env.service("BILLING")?,
            "close_workspace",
            &CloseWorkspaceArgs {
                actor: actor.clone(),
                workspace: slug.to_owned(),
                dry_run: true,
            },
        )
        .await?;
        Ok(match closing {
            Outcome::Ok(_) => None,
            Outcome::Fail(failure) => Some(failure.message),
        })
    }

    /// What would go with the workspace, and whether billing can close it
    /// for `actor`.
    async fn deletion_facts(&self, actor: &User, slug: &str, target: &Target) -> Result<WorkspaceDeletion> {
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
            "count",
            &json!({ "workspace": slug }),
        )
        .await?;
        #[derive(Deserialize)]
        struct Count {
            n: u32,
        }
        let members = self
            .db
            .prepare("SELECT count(*) AS n FROM workspace_members WHERE workspace_id = ?")
            .bind(&[target.id.as_str().into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |count| count.n);
        Ok(WorkspaceDeletion {
            repositories,
            projects,
            members,
            billing: self.billing_refusal(actor, slug).await?,
            protected: self.is_protected(&target.id, slug, target.protected != 0).await?,
        })
    }

    /// The workspace, if the actor may delete it.
    async fn deletable(&self, a: &DeleteWorkspaceArgs, confirm: bool) -> Result<Outcome<(Target, bool)>> {
        let slug = a.slug.trim().to_lowercase();
        let Some(target) = self
            .db
            .prepare("SELECT id, protected FROM workspaces WHERE slug = ? AND deleted_at IS NULL")
            .bind(&[slug.as_str().into()])?
            .first::<Target>(None)
            .await?
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        let protected = self.is_protected(&target.id, &slug, target.protected != 0).await?;
        if let Err((code, message)) = may_delete(
            // Only the actual deletion is refused for it; the check says
            // so in `protected`, for the page to show.
            protected && confirm,
            a.actor.kind == PrincipalKind::User,
            a.actor.verified,
            a.actor.role_in(&slug),
            &slug,
            confirm.then_some(a.confirm.as_str()),
        ) {
            return Ok(Outcome::fail(code, message));
        }
        Ok(Outcome::Ok((target, protected)))
    }

    pub async fn check_workspace_deletion(&self, a: DeleteWorkspaceArgs) -> Result<Outcome<WorkspaceDeletion>> {
        let target = match self.deletable(&a, false).await? {
            Outcome::Ok((target, _)) => target,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let slug = a.slug.trim().to_lowercase();
        Ok(Outcome::Ok(self.deletion_facts(&a.actor, &slug, &target).await?))
    }

    pub async fn delete_workspace(&self, a: DeleteWorkspaceArgs) -> Result<Outcome<bool>> {
        let workspace = match self.deletable(&a, true).await? {
            Outcome::Ok((workspace, _)) => workspace,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let slug = a.slug.trim().to_lowercase();
        let deleter = Deleter {
            billing: &a.actor,
            deleted_by: &a.actor.id,
            by: &a.actor.username,
            audit: AuditActor::of(&a.actor),
            surface: a.surface.unwrap_or(Surface::Web),
            rule: "owner",
            message: Box::new(|purge| format!("Deleted {slug}; restorable by g1t's staff until {purge}")),
            actor_id: Some(&a.actor.id),
        };
        self.soft_delete_workspace(&workspace, &slug, &deleter).await
    }

    /// g1t's staff delete a live workspace that `owner_id` (`owner`) is the
    /// only owner of, as part of deleting that account (account_deletion.rs):
    /// exactly as its owner would, refused the same way, with the staff
    /// member as `deleted_by` and in sudo's audit log with `reason`.
    pub(crate) async fn staff_delete_workspace(
        &self,
        slug: &str,
        owner_id: &str,
        owner: &str,
        staff: &str,
        reason: &str,
    ) -> Result<Outcome<WorkspaceDeletedWith>> {
        let slug = slug.trim().to_lowercase();
        let Some(workspace) = self
            .db
            .prepare("SELECT id, protected FROM workspaces WHERE slug = ? AND deleted_at IS NULL")
            .bind(&[slug.as_str().into()])?
            .first::<Target>(None)
            .await?
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("{slug} is not a live workspace any more.")));
        };
        let billing = staff_billing_actor(owner_id, staff, &slug);
        let deleter = Deleter {
            billing: &billing,
            deleted_by: staff,
            by: staff,
            // The workspace's members read its audit log: it says g1t's
            // staff did it, and sudo's log says who and why.
            audit: AuditActor::system(),
            surface: Surface::Web,
            rule: "staff",
            message: Box::new(|purge| {
                format!("Deleted {slug} by g1t's staff, with the account {owner} that was its only owner; restorable by g1t's staff until {purge}")
            }),
            actor_id: None,
        };
        let id = workspace.id.clone();
        match self.soft_delete_workspace(&workspace, &slug, &deleter).await? {
            Outcome::Ok(_) => {}
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
        self.record_for_staff(
            &slug,
            "workspace_deleted",
            &format!("Deleted {slug} with the account {owner}, its only owner: {reason}"),
            staff,
        )
        .await;
        Ok(Outcome::Ok(WorkspaceDeletedWith { workspace_id: id, slug: slug.clone() }))
    }

    /// Deletes a live workspace softly, as every deletion does: refused if
    /// it is protected or billing cannot settle it; billing closes it for
    /// real first; then its row is marked, its audit log says so and
    /// `workspace.deleting` tells every service.
    async fn soft_delete_workspace(&self, workspace: &Target, slug: &str, deleter: &Deleter<'_>) -> Result<Outcome<bool>> {
        let went = self.deletion_facts(deleter.billing, slug, workspace).await?;
        if let Some(reason) = went.reason(slug) {
            let code = if went.protected { FailureCode::Forbidden } else { FailureCode::PaymentRequired };
            return Ok(Outcome::fail(code, reason));
        }
        // Money first: if billing cannot settle it after all (a card
        // declined a moment ago), nothing is deleted. Its plan ends now, so
        // nothing more is charged while it waits to be purged.
        let closed: Outcome<bool> = g1t_kit::call(
            &self.env.service("BILLING")?,
            "close_workspace",
            &CloseWorkspaceArgs {
                actor: deleter.billing.clone(),
                workspace: slug.to_owned(),
                dry_run: false,
            },
        )
        .await?;
        if let Outcome::Fail(failure) = closed {
            return Ok(Outcome::Fail(failure));
        }
        let now = now_ms();
        let purge = purge_after(now);
        self.db
            .prepare(
                "UPDATE workspaces SET deleted_at = ?, deleted_by = ?, purge_after = ?, deleted_went = ?
                 WHERE id = ? AND deleted_at IS NULL",
            )
            .bind(&[
                rfc3339(now).into(),
                deleter.deleted_by.into(),
                purge.as_str().into(),
                went_json(&went).into(),
                workspace.id.as_str().into(),
            ])?
            .run()
            .await?;
        self.record_on_workspace(
            slug,
            deleter.audit.clone(),
            deleter.surface,
            "workspace.deleted",
            deleter.rule,
            (deleter.message)(&purge),
        )
        .await;
        self.announce(
            "workspace.deleting",
            deleter.actor_id,
            WorkspaceDeleting {
                workspace_id: workspace.id.clone(),
                slug: slug.to_owned(),
                by: deleter.by.to_owned(),
                purge_after: purge,
            },
        )
        .await;
        Ok(Outcome::Ok(true))
    }

    /// Deleted workspaces not purged yet, newest first. Staff only.
    pub async fn admin_deleted_workspaces(&self) -> Result<Vec<DeletedWorkspace>> {
        let rows = self
            .db
            .prepare(format!("SELECT {DELETED_COLUMNS} ORDER BY w.deleted_at DESC LIMIT 500"))
            .all()
            .await?
            .results::<DeletedRow>()?;
        let now = rfc3339(now_ms());
        let mut listed = Vec::with_capacity(rows.len());
        for row in rows {
            let mut went = went_of(row.deleted_went.as_deref());
            went.protected = self.is_protected(&row.id, &row.slug, row.protected != 0).await?;
            listed.push(DeletedWorkspace {
                restorable: restorable(&row.purge_after, &now),
                workspace_id: row.id,
                slug: row.slug,
                name: row.name,
                deleted_at: row.deleted_at,
                deleted_by: row.deleter.or(row.deleted_by).unwrap_or_default(),
                purge_after: row.purge_after,
                went,
            });
        }
        Ok(listed)
    }

    async fn deleted_row(&self, id: &str) -> Result<Option<DeletedRow>> {
        self.db
            .prepare(format!("SELECT {DELETED_COLUMNS} AND w.id = ?"))
            .bind(&[id.into()])?
            .first::<DeletedRow>(None)
            .await
    }

    /// Staff bring a deleted workspace back within its window, with its
    /// members and tokens; `workspace.restored` brings back what went with
    /// it. Staff only.
    pub async fn admin_restore_workspace(&self, a: AdminDeletedWorkspaceArgs) -> Result<Outcome<bool>> {
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member is restoring it."));
        }
        let Some(row) = self.deleted_row(&a.workspace_id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no deleted workspace with that id."));
        };
        if let Err((code, message)) = may_restore(&row.slug, &row.purge_after, &rfc3339(now_ms())) {
            return Ok(Outcome::fail(code, message));
        }
        self.db
            .prepare(
                "UPDATE workspaces SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL, deleted_went = NULL
                 WHERE id = ? AND deleted_at IS NOT NULL",
            )
            .bind(&[row.id.as_str().into()])?
            .run()
            .await?;
        let message = format!(
            "Restored by g1t's staff; deleted by {} at {}",
            row.deleter.as_deref().or(row.deleted_by.as_deref()).unwrap_or("an owner"),
            row.deleted_at
        );
        self.record_on_workspace(&row.slug, AuditActor::system(), Surface::Web, "workspace.restored", "staff", message)
            .await;
        self.record_for_staff(&row.slug, "workspace_restored", &format!("Restored {}", row.slug), staff)
            .await;
        self.announce(
            "workspace.restored",
            None,
            WorkspaceRestored {
                workspace_id: row.id,
                slug: row.slug,
            },
        )
        .await;
        Ok(Outcome::Ok(true))
    }

    /// Staff purge a deleted workspace now rather than at `purge_after`.
    /// Staff only.
    pub async fn admin_purge_workspace(&self, a: AdminDeletedWorkspaceArgs) -> Result<Outcome<bool>> {
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member is purging it."));
        }
        let Some(row) = self.deleted_row(&a.workspace_id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no deleted workspace with that id."));
        };
        let protected = self.is_protected(&row.id, &row.slug, row.protected != 0).await?;
        if let Err((code, message)) = may_purge(protected, &row.slug, Some(&a.confirm)) {
            return Ok(Outcome::fail(code, message));
        }
        self.purge(&row).await?;
        self.record_on_workspace(
            &row.slug,
            AuditActor::system(),
            Surface::Web,
            "workspace.purged",
            "staff",
            "Purged by g1t's staff before its restore window ended".to_owned(),
        )
        .await;
        self.record_for_staff(&row.slug, "workspace_purged", &format!("Purged {} now", row.slug), staff)
            .await;
        Ok(Outcome::Ok(true))
    }

    /// The sweep: purges deleted workspaces whose restore window has
    /// passed. A protected one is never purged, however it came to be
    /// deleted.
    pub async fn purge_due_workspaces(&self) -> Result<u32> {
        let due = self
            .db
            .prepare(format!(
                "SELECT {DELETED_COLUMNS} AND w.purge_after <= ? ORDER BY w.purge_after LIMIT {PURGES_PER_SWEEP}"
            ))
            .bind(&[rfc3339(now_ms()).into()])?
            .all()
            .await?
            .results::<DeletedRow>()?;
        let mut purged = 0;
        for row in due {
            let protected = self.is_protected(&row.id, &row.slug, row.protected != 0).await?;
            if let Err((_, why)) = may_purge(protected, &row.slug, None) {
                worker::console_error!("{} not purged: {why}", row.slug);
                continue;
            }
            match self.purge(&row).await {
                Ok(()) => {
                    purged += 1;
                    self.record_on_workspace(
                        &row.slug,
                        AuditActor::system(),
                        Surface::Web,
                        "workspace.purged",
                        "schedule",
                        format!("Purged {WORKSPACE_RESTORE_DAYS} days after it was deleted"),
                    )
                    .await;
                }
                Err(error) => worker::console_error!("{} not purged: {error}", row.slug),
            }
        }
        Ok(purged)
    }

    /// Removes a deleted workspace for good, as deleting one always did:
    /// its row, memberships, tokens and redirects go, its slugs are kept in
    /// `deleted_workspaces`, and `workspace.deleted` tells services to drop
    /// what they keep for it.
    async fn purge(&self, row: &DeletedRow) -> Result<()> {
        let id = row.id.as_str();
        let by = row.deleted_by.as_deref().unwrap_or_default();
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT OR REPLACE INTO deleted_workspaces (slug, workspace_id, name, deleted_by, deleted_at)
                         VALUES (?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        row.slug.as_str().into(),
                        id.into(),
                        row.name.as_str().into(),
                        by.into(),
                        row.deleted_at.as_str().into(),
                    ])?,
                // Slugs it was renamed from, still redirecting, are kept
                // the same way.
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO deleted_workspaces (slug, workspace_id, name, deleted_by, deleted_at)
                         SELECT old_slug, workspace_id, ?, ?, ? FROM workspace_redirects WHERE workspace_id = ?",
                    )
                    .bind(&[
                        row.name.as_str().into(),
                        by.into(),
                        row.deleted_at.as_str().into(),
                        id.into(),
                    ])?,
                self.db
                    .prepare("DELETE FROM access_tokens WHERE workspace_id = ?")
                    .bind(&[id.into()])?,
                self.db
                    .prepare("DELETE FROM workspace_members WHERE workspace_id = ?")
                    .bind(&[id.into()])?,
                // Each member's dock pins in it (dock.rs).
                self.db
                    .prepare("DELETE FROM dock_pins WHERE workspace_id = ?")
                    .bind(&[id.into()])?,
                // Its teams, their people and the roles they gave (teams.rs).
                self.db
                    .prepare("DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE workspace_id = ?)")
                    .bind(&[id.into()])?,
                self.db
                    .prepare("DELETE FROM repo_grants WHERE principal_kind = 'team' AND principal_id IN (SELECT id FROM teams WHERE workspace_id = ?)")
                    .bind(&[id.into()])?,
                self.db
                    .prepare("DELETE FROM teams WHERE workspace_id = ?")
                    .bind(&[id.into()])?,
                self.db
                    .prepare("DELETE FROM workspace_redirects WHERE workspace_id = ?")
                    .bind(&[id.into()])?,
                // Aliases staff pointed at it lead nowhere now (aliases.rs).
                self.db
                    .prepare("DELETE FROM workspace_aliases WHERE workspace_id = ?")
                    .bind(&[id.into()])?,
                // Only while it is still deleted: a restore a moment ago wins.
                self.db
                    .prepare("DELETE FROM workspaces WHERE id = ? AND deleted_at IS NOT NULL")
                    .bind(&[id.into()])?,
            ])
            .await?;
        self.announce(
            "workspace.deleted",
            None,
            WorkspaceDeleted {
                workspace_id: row.id.clone(),
                slug: row.slug.clone(),
            },
        )
        .await;
        Ok(())
    }

    /// An entry in the workspace's audit log, which outlives it.
    pub(crate) async fn record_on_workspace(
        &self,
        slug: &str,
        actor: AuditActor,
        surface: Surface,
        action: &str,
        rule: &str,
        message: String,
    ) {
        let Ok(events) = self.env.service("EVENTS") else {
            return;
        };
        let entry = NewAuditEntry {
            actor,
            action: action.to_owned(),
            surface,
            target: AuditTarget {
                workspace: slug.to_owned(),
                ..AuditTarget::default()
            },
            outcome: AuditOutcome::Allowed,
            rule: rule.to_owned(),
            result: Some("ok".to_owned()),
            message: Some(message),
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
            worker::console_error!("{action} of {slug} not recorded: {error}");
        }
    }

    /// A line in sudo's audit log (billing keeps it), naming the staff
    /// member.
    pub(crate) async fn record_for_staff(&self, slug: &str, action: &str, detail: &str, staff: &str) {
        let Ok(billing) = self.env.service("BILLING") else {
            return;
        };
        let recorded: Result<bool> = g1t_kit::call(
            &billing,
            "admin_log",
            &json!({ "workspace": slug, "action": action, "detail": detail, "by": staff }),
        )
        .await;
        if let Err(error) = recorded {
            worker::console_error!("{action} of {slug} by {staff} not recorded for sudo: {error}");
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
        assert!(may_delete(false, true, true, Some(Role::Owner), "acme", Some(" Acme ")).is_ok());
        assert!(may_delete(false, true, true, Some(Role::Owner), "acme", None).is_ok());
        assert_eq!(
            may_delete(false, true, true, Some(Role::Member), "acme", Some("acme")).unwrap_err().0,
            FailureCode::Forbidden
        );
        assert_eq!(
            may_delete(false, false, true, Some(Role::Owner), "acme", Some("acme")).unwrap_err().0,
            FailureCode::Forbidden
        );
        assert_eq!(
            may_delete(false, true, false, Some(Role::Owner), "acme", Some("acme")).unwrap_err().0,
            FailureCode::Forbidden
        );
        assert_eq!(
            may_delete(false, true, true, Some(Role::Owner), "acme", Some("acme-inc")).unwrap_err().0,
            FailureCode::Invalid
        );
        // Nothing typed is no confirmation.
        assert_eq!(
            may_delete(false, true, true, Some(Role::Owner), "acme", Some("")).unwrap_err().0,
            FailureCode::Invalid
        );
    }

    #[test]
    fn a_protected_workspace_is_refused_to_every_caller() {
        let refused = |person: bool, verified: bool, role: Option<Role>| {
            may_delete(true, person, verified, role, "flagon-io", Some("flagon-io")).unwrap_err()
        };
        // An owner who types the name, a workspace's token, a member, anyone.
        for (person, verified, role) in [
            (true, true, Some(Role::Owner)),
            (false, true, Some(Role::Owner)),
            (true, true, Some(Role::Member)),
            (true, false, None),
        ] {
            let (code, message) = refused(person, verified, role);
            assert_eq!(code, FailureCode::Forbidden);
            assert_eq!(message, "flagon-io is protected and can never be deleted.");
        }
        // Neither the sweep nor staff purge it, typed or not.
        assert_eq!(may_purge(true, "flagon-io", None).unwrap_err().0, FailureCode::Forbidden);
        assert_eq!(may_purge(true, "flagon-io", Some("flagon-io")).unwrap_err().0, FailureCode::Forbidden);
    }

    #[test]
    fn protection_follows_the_workspace_through_a_rename() {
        let names = protected_names(Some(""));
        assert!(is_protected(&names, "wsp_1", "flagon-io", false, &[]));
        assert!(is_protected(&names, "wsp_1", "FLAGON-IO", false, &[]));
        // Renamed away: its old slug, or the mark on its row, still holds.
        assert!(is_protected(&names, "wsp_1", "flagon", false, &["flagon-io".into()]));
        assert!(is_protected(&names, "wsp_1", "flagon", true, &[]));
        // Named by id in the variable.
        assert!(is_protected(&protected_names(Some("wsp_9")), "wsp_9", "anything", false, &[]));
        assert!(!is_protected(&names, "wsp_2", "acme", false, &["acme-old".into()]));
    }

    #[test]
    fn staff_purge_only_with_the_name_typed() {
        assert!(may_purge(false, "acme", None).is_ok());
        assert!(may_purge(false, "acme", Some(" ACME ")).is_ok());
        assert_eq!(may_purge(false, "acme", Some("")).unwrap_err().0, FailureCode::Invalid);
        assert_eq!(may_purge(false, "acme", Some("acme-inc")).unwrap_err().0, FailureCode::Invalid);
    }

    #[test]
    fn a_deleted_workspace_is_restorable_for_thirty_days_then_due() {
        let deleted = 1_790_000_000_000;
        let purge = purge_after(deleted);
        assert_eq!(purge, rfc3339(deleted + 30 * 86_400_000));
        assert!(restorable(&purge, &rfc3339(deleted)));
        assert!(restorable(&purge, &rfc3339(deleted + 29 * 86_400_000)));
        assert!(!restorable(&purge, &purge));
        assert!(!restorable(&purge, &rfc3339(deleted + 31 * 86_400_000)));
        assert!(may_restore("acme", &purge, &rfc3339(deleted + 86_400_000)).is_ok());
        assert_eq!(
            may_restore("acme", &purge, &rfc3339(deleted + 30 * 86_400_000)).unwrap_err(),
            (FailureCode::Conflict, "acme is being purged and can no longer be restored.".to_owned())
        );
    }

    #[test]
    fn what_went_is_kept_and_read_back() {
        let went = WorkspaceDeletion {
            repositories: 4,
            projects: 2,
            members: 3,
            billing: None,
            protected: false,
        };
        assert_eq!(went_of(Some(&went_json(&went))), went);
        assert_eq!(went_of(None), WorkspaceDeletion::default());
        assert_eq!(went_of(Some("not json")), WorkspaceDeletion::default());
    }

    #[test]
    fn billing_sees_staff_as_the_owner_closing_it_named_by_the_staff_member() {
        let actor = staff_billing_actor("usr_ada", "staff@g1t.sh", "ada");
        assert_eq!(actor.role_in("ada"), Some(Role::Owner));
        assert_eq!(actor.role_in("globex"), None);
        assert_eq!(actor.username, "staff@g1t.sh");
        assert_eq!(actor.id, "usr_ada");
        assert_eq!(actor.kind, PrincipalKind::User);
    }

    #[test]
    fn a_deleted_slug_is_reclaimed_only_by_its_namesake() {
        assert!(may_reclaim("syntaqx", "syntaqx"));
        assert!(may_reclaim("syntaqx", "Syntaqx"));
        assert!(!may_reclaim("flagon-io", "syntaqx"));
    }
}
