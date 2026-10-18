//! A work item's repositories (`work_item_repos`): its origin, its targets
//! and those it touched, and where each repository is (`repo_workspaces`).

use g1t_contracts::access::Capability;
use g1t_contracts::events::WorkItemEvent;
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_kit::now_ms;
use worker::Result;

use super::rows::{Held, no_item, path_of};
use crate::rows::ValueRow;
use crate::{UNVERIFIED, Work};

/// Records where repository `?1` is: workspace `?2`, path `?3`, and
/// whether it is private (`?4`). It is there, so not deleted.
pub(crate) const REMEMBER_REPO: &str = "INSERT INTO repo_workspaces (repo_id, workspace, path, private)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (repo_id) DO UPDATE SET workspace = excluded.workspace, path = excluded.path, private = excluded.private,
       deleted_at = NULL";

/// `repo.deleted` (`?1` its id, at `?2`): its links say it is deleted
/// until `repo.restored` records it again ([`REMEMBER_REPO`]) or
/// `repo.purged` drops its row.
pub(crate) const MARK_DELETED: &str = "UPDATE repo_workspaces SET deleted_at = COALESCE(deleted_at, ?2) WHERE repo_id = ?1";

/// Linking a work item (`?1`) that a change in repository `?2` is part of,
/// at `?3`, by `?4`, unless it is linked already.
pub(crate) const PART_SQL: &str = "INSERT INTO work_item_repos (item_id, repo_id, role, added_at, added_by)
     VALUES (?1, ?2, 'touched', ?3, ?4) ON CONFLICT (item_id, repo_id) DO NOTHING RETURNING item_id AS value";

/// Closes work item `?1` at `?2` once what landed for it is all it waits
/// for: open, landed somewhere, and no target left to land in (one was
/// just unlinked or made something else). One that never landed stays
/// open: it has not been done anywhere.
pub(crate) const CLOSE_IF_LANDED: &str = "UPDATE work_items SET state = 'closed', reason = 'completed', closed_at = ?2, updated_at = ?2
     WHERE id = ?1 AND state = 'open' AND resolutions <> '[]'
       AND NOT EXISTS (SELECT 1 FROM work_item_repos WHERE item_id = ?1 AND role = 'target' AND landed_at IS NULL)
     RETURNING id AS value";

impl Work {
    /// Records which workspace `repo` is in, its path and whether it is
    /// private, as repos just said.
    pub(super) async fn remember_repo(&self, repo: &Repo) -> Result<()> {
        self.db
            .prepare(REMEMBER_REPO)
            .bind(&[
                repo.id.as_str().into(),
                repo.namespace.to_lowercase().into(),
                path_of(repo).into(),
                u32::from(repo.is_private).into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// The workspace repository `repo_id` is in: as recorded, or as repos
    /// says when it is not yet.
    pub(super) async fn repo_workspace(&self, repo_id: &str) -> Result<Option<String>> {
        let recorded = self
            .db
            .prepare("SELECT workspace AS value FROM repo_workspaces WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<ValueRow>(None)
            .await?;
        if let Some(row) = recorded {
            return Ok(Some(row.value));
        }
        let path: Option<RepoPath> =
            g1t_kit::call(&self.repos, "path_by_id", &g1t_contracts::repos::PathByIdArgs { id: repo_id.to_owned() }).await?;
        Ok(path.map(|path| path.namespace.to_lowercase()))
    }

    /// Links `repo` to a work item it now has a pull request for, as
    /// touched, unless it is linked already, and says so.
    pub(super) async fn touch_item(&self, held: &Held, repo: &Repo, actor: &User) -> Result<()> {
        let linked = self
            .db
            .prepare(PART_SQL)
            .bind(&[held.item.id.as_str().into(), repo.id.as_str().into(), rfc3339(now_ms()).into(), actor.id.as_str().into()])?
            .first::<ValueRow>(None)
            .await?;
        if linked.is_none() {
            return Ok(());
        }
        let Some(after) = self.item_by_id(&held.item.id).await? else {
            return Ok(());
        };
        self.publish_item(
            "work_item.linked",
            &after,
            Some(actor),
            WorkItemEvent { repo: Some(path_of(repo)), role: Some(LinkRole::Touched), ..Self::item_event(&after) },
        )
        .await
    }

    pub(crate) async fn link_work_item(&self, a: LinkWorkItemArgs) -> Result<Outcome<WorkItem>> {
        self.relink(a, false).await
    }

    pub(crate) async fn unlink_work_item(&self, a: LinkWorkItemArgs) -> Result<Outcome<WorkItem>> {
        self.relink(a, true).await
    }

    async fn relink(&self, a: LinkWorkItemArgs, unlink: bool) -> Result<Outcome<WorkItem>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let held = check!(self.item_for(&Some(a.actor.clone()), &a.workspace, a.number, Capability::Triage).await?);
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
        let path = path_of(&repo);
        if !repo.namespace.eq_ignore_ascii_case(&held.item.workspace) {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("{path} is not a repository of {}.", held.item.workspace)));
        }
        self.remember_repo(&repo).await?;
        let current = held.item.link(&repo.id).cloned();
        if current.as_ref().is_some_and(|link| link.role == LinkRole::Origin) {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{path} is where this work item was filed; that link stays as it is."),
            ));
        }
        let now = rfc3339(now_ms());
        let (kind, role, text) = if unlink {
            let Some(link) = current else {
                return Ok(Outcome::fail(FailureCode::NotFound, format!("This work item is not linked to {path}.")));
            };
            self.db
                .prepare("DELETE FROM work_item_repos WHERE item_id = ? AND repo_id = ? AND role <> 'origin'")
                .bind(&[held.item.id.as_str().into(), repo.id.as_str().into()])?
                .run()
                .await?;
            ("work_item.unlinked", link.role, format!("unlinked {path}"))
        } else {
            if a.role == LinkRole::Origin {
                return Ok(Outcome::fail(FailureCode::Invalid, "A work item's origin is where it was filed; link a target instead."));
            }
            if current.as_ref().is_some_and(|link| link.role == a.role) {
                return Ok(Outcome::Ok(held.shown(Some(&a.actor))));
            }
            self.db
                .prepare(
                    "INSERT INTO work_item_repos (item_id, repo_id, role, path, added_at, added_by)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT (item_id, repo_id) DO UPDATE SET role = excluded.role WHERE work_item_repos.role <> 'origin'",
                )
                .bind(&[
                    held.item.id.as_str().into(),
                    repo.id.as_str().into(),
                    a.role.as_str().into(),
                    path.as_str().into(),
                    now.as_str().into(),
                    a.actor.id.as_str().into(),
                ])?
                .run()
                .await?;
            let text = match a.role {
                LinkRole::Target => format!("added {path} as a target"),
                _ => format!("linked {path}"),
            };
            ("work_item.linked", a.role, text)
        };
        self.db
            .prepare("UPDATE work_items SET updated_at = ? WHERE id = ?")
            .bind(&[now.as_str().into(), held.item.id.as_str().into()])?
            .run()
            .await?;
        // A target no longer one: what landed may be all it waited for.
        let closed = if role == LinkRole::Target && (unlink || a.role != LinkRole::Target) {
            self.db
                .prepare(CLOSE_IF_LANDED)
                .bind(&[held.item.id.as_str().into(), now.as_str().into()])?
                .first::<ValueRow>(None)
                .await?
                .is_some()
        } else {
            false
        };
        let Some(after) = self.item_by_id(&held.item.id).await? else {
            return Ok(no_item());
        };
        // An unlinked repository still hears that it was.
        let mut event = Self::item_event(&after);
        if unlink {
            event.repo_ids.push(repo.id.clone());
        }
        self.publish_item(kind, &after, Some(&a.actor), WorkItemEvent { repo: Some(path), role: Some(role), ..event }).await?;
        self.note_item(&after.item.id, &a.actor, &text).await?;
        if closed {
            self.publish_item(
                "work_item.closed",
                &after,
                Some(&a.actor),
                WorkItemEvent { reason: Some(CloseReason::Completed.as_str()), missing: Some(Vec::new()), ..Self::item_event(&after) },
            )
            .await?;
            self.note_item(&after.item.id, &a.actor, "closed this: it has landed in every target it has").await?;
            self.item_resolved(&after, &a.actor, true, None).await;
        }
        Ok(Outcome::Ok(after.shown(Some(&a.actor))))
    }
}
