//! Renaming a workspace: changing its slug, the first segment of its URLs,
//! the way GitHub renames an organization.
//!
//! The workspace keeps its id, members, tokens and display name. Its old
//! slug is recorded in `workspace_redirects`, pointing at the workspace's
//! id, so that old addresses resolve to whatever the slug is now: renaming
//! twice chains, because every old slug points at the same id. An old slug
//! stays reserved for the workspace that had it for [`SLUG_HOLD_DAYS`], so
//! nobody else can take it while links to it still redirect; the workspace
//! itself can rename back to it. Renames are limited to one per
//! [`RENAME_COOLDOWN_HOURS`] to stop churn.
//!
//! The rename publishes `workspace.renamed`; every other service moves the
//! rows it keeps under the slug when it hears it.

use g1t_contracts::events::{NewEvent, Publish, WorkspaceRenamed};
use g1t_contracts::identity::*;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, is_valid_namespace};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Identity;

const HOUR_MS: u64 = 60 * 60 * 1000;
const DAY_MS: u64 = 24 * HOUR_MS;
const SOURCE: &str = "identity";
const TAKEN: &str = "That workspace name is taken.";
/// How many times publishing the event is tried before giving up.
const PUBLISH_ATTEMPTS: u32 = 3;

/// The earliest `created_at` of a redirect that still holds its slug.
pub fn hold_cutoff(now_ms: u64) -> String {
    rfc3339(now_ms.saturating_sub(SLUG_HOLD_DAYS * DAY_MS))
}

/// Everything about a wanted slug that decides whether a workspace may
/// take it, as read from the database.
#[derive(Debug, Default)]
pub struct Facts<'a> {
    /// The workspace's id and its slug now.
    pub workspace_id: &'a str,
    pub current: &'a str,
    /// The slug asked for, lowercased and trimmed.
    pub wanted: &'a str,
    /// Another person's username is `wanted`. The actor's own is theirs
    /// to use, as when creating a workspace.
    pub someone_elses_username: bool,
    /// Another workspace's slug is `wanted`.
    pub another_workspace: bool,
    /// A redirect holds `wanted`: the workspace it points at, and when it
    /// was made.
    pub redirect: Option<(&'a str, &'a str)>,
    /// When the workspace was last renamed, if ever.
    pub last_renamed_at: Option<&'a str>,
    /// A deleted workspace had `wanted`; it is never given to another.
    pub deleted: bool,
    /// Staff made `wanted` an alias (aliases.rs); it stays theirs.
    pub aliased: bool,
    pub now_ms: u64,
}

/// Whether the rename `facts` describe is allowed: `Ok`, or why not, in
/// words for the owner.
pub fn check(facts: &Facts) -> std::result::Result<(), (FailureCode, String)> {
    let refuse = |code, message: &str| Err((code, message.to_owned()));
    if !is_valid_namespace(facts.wanted) {
        return refuse(
            FailureCode::Invalid,
            "Workspace names use lowercase letters, digits and single hyphens, up to 39 characters, and cannot be a reserved word.",
        );
    }
    if facts.wanted == facts.current {
        return refuse(FailureCode::Invalid, "That is already this workspace's name.");
    }
    if let Some(last) = facts.last_renamed_at {
        let cooldown_from = rfc3339(facts.now_ms.saturating_sub(RENAME_COOLDOWN_HOURS * HOUR_MS));
        if last > cooldown_from.as_str() {
            return refuse(
                FailureCode::Conflict,
                "A workspace can be renamed once a day. Try again tomorrow.",
            );
        }
    }
    if facts.someone_elses_username || facts.another_workspace || facts.deleted || facts.aliased {
        return refuse(FailureCode::Conflict, TAKEN);
    }
    if let Some((holder, created_at)) = facts.redirect
        && holder != facts.workspace_id
        && created_at >= hold_cutoff(facts.now_ms).as_str()
    {
        return refuse(FailureCode::Conflict, TAKEN);
    }
    Ok(())
}

/// A redirect as read with the slug its workspace has now.
#[derive(Debug, Deserialize)]
pub struct RedirectRow {
    pub workspace_id: String,
    /// The workspace's slug now.
    pub slug: String,
    pub created_at: String,
}

/// Where an old slug leads: the workspace's current slug, while the
/// redirect still holds.
pub fn resolve(row: Option<RedirectRow>, now_ms: u64) -> Option<String> {
    row.filter(|row| row.created_at >= hold_cutoff(now_ms))
        .map(|row| row.slug)
}

#[derive(Deserialize)]
struct Target {
    id: String,
}

impl Identity {
    /// The redirect holding `slug`, if any, with its workspace's slug now.
    async fn redirect(&self, slug: &str) -> Result<Option<RedirectRow>> {
        self.db
            .prepare(
                "SELECT workspace_redirects.workspace_id, workspaces.slug,
                   workspace_redirects.created_at
                 FROM workspace_redirects
                 JOIN workspaces ON workspaces.id = workspace_redirects.workspace_id
                 WHERE workspace_redirects.old_slug = ?",
            )
            .bind(&[slug.into()])?
            .first::<RedirectRow>(None)
            .await
    }

    /// Whether `slug` is an old slug still reserved for the workspace that
    /// had it, or an alias staff set, so nobody else may register or create
    /// it.
    pub async fn slug_held(&self, slug: &str) -> Result<bool> {
        Ok(resolve(self.redirect(slug).await?, now_ms()).is_some() || self.is_alias(slug).await?)
    }

    /// `resolve_slug`: the current slug for an old one still redirecting,
    /// or for an alias (aliases.rs).
    pub async fn resolve_slug(&self, a: SlugArgs) -> Result<Option<String>> {
        let slug = a.slug.trim().to_lowercase();
        let in_use = self.get_workspace(SlugArgs { slug: slug.clone() }).await?.is_some();
        if in_use {
            return Ok(None);
        }
        let alias = self.resolve_alias(SlugArgs { slug: slug.clone() }).await?;
        let redirect = match alias {
            Some(_) => None,
            None => self.redirect(&slug).await?,
        };
        Ok(crate::aliases::resolve(in_use, alias, || resolve(redirect, now_ms())))
    }

    /// Checks a rename, returning the workspace's id when it is allowed.
    async fn rename_allowed(&self, a: &RenameWorkspaceArgs) -> Result<Outcome<(String, String)>> {
        let current = a.slug.trim().to_lowercase();
        let wanted = a.new_slug.trim().to_lowercase();
        if a.actor.kind != PrincipalKind::User || a.actor.role_in(&current) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can rename a workspace.",
            ));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Confirm your email address before renaming a workspace.",
            ));
        }
        let Some(workspace) = self
            .db
            .prepare("SELECT id FROM workspaces WHERE slug = ?")
            .bind(&[current.as_str().into()])?
            .first::<Target>(None)
            .await?
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        let someone_elses_username = self
            .db
            .prepare("SELECT id FROM users WHERE username = ? AND id != ?")
            .bind(&[wanted.as_str().into(), a.actor.id.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some();
        let another_workspace = self
            .db
            .prepare("SELECT id FROM workspaces WHERE slug = ? AND id != ?")
            .bind(&[wanted.as_str().into(), workspace.id.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some();
        let redirect = self.redirect(&wanted).await?;
        let last_renamed_at = self
            .db
            .prepare("SELECT max(created_at) AS at FROM workspace_redirects WHERE workspace_id = ?")
            .bind(&[workspace.id.as_str().into()])?
            .first::<Option<String>>(Some("at"))
            .await?
            .flatten();
        let facts = Facts {
            workspace_id: &workspace.id,
            current: &current,
            wanted: &wanted,
            someone_elses_username,
            another_workspace,
            redirect: redirect
                .as_ref()
                .map(|row| (row.workspace_id.as_str(), row.created_at.as_str())),
            last_renamed_at: last_renamed_at.as_deref(),
            deleted: self.slug_deleted(&wanted).await?,
            aliased: self.is_alias(&wanted).await?,
            now_ms: now_ms(),
        };
        Ok(match check(&facts) {
            Ok(()) => Outcome::Ok((workspace.id, wanted)),
            Err((code, message)) => Outcome::fail(code, message),
        })
    }

    pub async fn check_workspace_rename(&self, a: RenameWorkspaceArgs) -> Result<Outcome<bool>> {
        Ok(match self.rename_allowed(&a).await? {
            Outcome::Ok(_) => Outcome::Ok(true),
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    }

    pub async fn rename_workspace(&self, a: RenameWorkspaceArgs) -> Result<Outcome<Workspace>> {
        let (workspace_id, wanted) = match self.rename_allowed(&a).await? {
            Outcome::Ok(allowed) => allowed,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let from = a.slug.trim().to_lowercase();
        let now = rfc3339(now_ms());
        // A workspace protected by its slug stays protected under the new
        // one: the protection goes on its row (deletion.rs).
        let protected = self.is_protected(&workspace_id, &from, false).await?;
        self.db
            .batch(vec![
                self.db
                    .prepare("UPDATE workspaces SET protected = 1 WHERE id = ? AND ? = 1")
                    .bind(&[workspace_id.as_str().into(), u8::from(protected).into()])?,
                // A redirect the workspace is renaming back to, or one whose
                // hold has ended, gives way to the slug in use.
                self.db
                    .prepare("DELETE FROM workspace_redirects WHERE old_slug = ?")
                    .bind(&[wanted.as_str().into()])?,
                self.db
                    .prepare("UPDATE workspaces SET slug = ? WHERE id = ? AND slug = ?")
                    .bind(&[
                        wanted.as_str().into(),
                        workspace_id.as_str().into(),
                        from.as_str().into(),
                    ])?,
                self.db
                    .prepare(
                        "INSERT OR REPLACE INTO workspace_redirects (old_slug, workspace_id, created_at)
                         VALUES (?, ?, ?)",
                    )
                    .bind(&[
                        from.as_str().into(),
                        workspace_id.as_str().into(),
                        now.as_str().into(),
                    ])?,
                // Agents at work keep their scope: it names the repository
                // by its path.
                self.db
                    .prepare(
                        "UPDATE access_tokens SET agent_scope = json_set(agent_scope, '$.repo.namespace', ?)
                         WHERE agent_scope IS NOT NULL
                           AND json_extract(agent_scope, '$.repo.namespace') = ?",
                    )
                    .bind(&[wanted.as_str().into(), from.as_str().into()])?,
            ])
            .await?;
        self.publish_renamed(WorkspaceRenamed {
            workspace_id,
            from,
            to: wanted.clone(),
        }, &a.actor.id)
        .await;
        Ok(match self.get_workspace(SlugArgs { slug: wanted }).await? {
            Some(workspace) => Outcome::Ok(workspace),
            None => Outcome::fail(FailureCode::NotFound, "Workspace not found."),
        })
    }

    /// Tells every other service. The rename has happened by now, so a
    /// failure is logged rather than undoing it.
    async fn publish_renamed(&self, renamed: WorkspaceRenamed, actor: &str) {
        let events = match self.env.service("EVENTS") {
            Ok(events) => events,
            Err(error) => {
                worker::console_error!("workspace.renamed not published: {error}");
                return;
            }
        };
        let publish = Publish {
            events: vec![NewEvent {
                kind: "workspace.renamed",
                source: SOURCE,
                repo_id: None,
                actor: Some(actor.to_owned()),
                data: renamed,
            }],
        };
        for attempt in 1..=PUBLISH_ATTEMPTS {
            match g1t_kit::call::<_, serde_json::Value>(&events, "publish", &publish).await {
                Ok(_) => return,
                Err(error) => worker::console_error!(
                    "workspace.renamed publish attempt {attempt} failed: {error}"
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const NOW: u64 = 1_790_918_179_123;

    fn facts<'a>(current: &'a str, wanted: &'a str) -> Facts<'a> {
        Facts {
            workspace_id: "wsp_a",
            current,
            wanted,
            now_ms: NOW,
            ..Facts::default()
        }
    }

    fn refused(facts: &Facts) -> FailureCode {
        check(facts).unwrap_err().0
    }

    #[test]
    fn validates_like_creation() {
        assert!(check(&facts("acme", "acme-inc")).is_ok());
        for bad in ["", "-acme", "acme-", "ac--me", "Acme", "acme_inc", "api", "settings", "pulls"] {
            assert_eq!(refused(&facts("acme", bad)), FailureCode::Invalid, "{bad}");
        }
        assert_eq!(refused(&facts("acme", &"a".repeat(40))), FailureCode::Invalid);
        assert_eq!(refused(&facts("acme", "acme")), FailureCode::Invalid);
    }

    #[test]
    fn no_workspace_is_renamed_to_g1ts_names() {
        for name in ["g1t", "g1t-agent", "G1T", "G1T-Agent"] {
            assert_eq!(refused(&facts("acme", name)), FailureCode::Invalid, "{name}");
        }
        assert!(check(&facts("acme", "g1t-fans")).is_ok());
    }

    #[test]
    fn refuses_names_in_use() {
        let taken = Facts {
            someone_elses_username: true,
            ..facts("acme", "bob")
        };
        assert_eq!(refused(&taken), FailureCode::Conflict);
        let taken = Facts {
            another_workspace: true,
            ..facts("acme", "globex")
        };
        assert_eq!(refused(&taken), FailureCode::Conflict);
        let deleted = Facts {
            deleted: true,
            ..facts("acme", "initech")
        };
        assert_eq!(refused(&deleted), FailureCode::Conflict);
        let aliased = Facts {
            aliased: true,
            ..facts("acme", "flagon")
        };
        assert_eq!(refused(&aliased), FailureCode::Conflict);
    }

    #[test]
    fn an_old_slug_is_held_for_its_workspace_until_the_hold_ends() {
        let recently = rfc3339(NOW - 10 * DAY_MS);
        let long_ago = rfc3339(NOW - (SLUG_HOLD_DAYS + 1) * DAY_MS);
        let held_by_other = Facts {
            redirect: Some(("wsp_b", recently.as_str())),
            ..facts("acme", "globex")
        };
        assert_eq!(refused(&held_by_other), FailureCode::Conflict);
        let held_by_self = Facts {
            redirect: Some(("wsp_a", recently.as_str())),
            last_renamed_at: Some(recently.as_str()),
            ..facts("acme-inc", "acme")
        };
        assert!(check(&held_by_self).is_ok(), "a workspace can rename back");
        let expired = Facts {
            redirect: Some(("wsp_b", long_ago.as_str())),
            ..facts("acme", "globex")
        };
        assert!(check(&expired).is_ok(), "after the hold anyone can take it");
    }

    #[test]
    fn renames_are_limited_to_one_a_day() {
        let an_hour_ago = rfc3339(NOW - HOUR_MS);
        let two_days_ago = rfc3339(NOW - 2 * DAY_MS);
        let soon = Facts {
            last_renamed_at: Some(an_hour_ago.as_str()),
            ..facts("acme", "acme-inc")
        };
        assert_eq!(refused(&soon), FailureCode::Conflict);
        let later = Facts {
            last_renamed_at: Some(two_days_ago.as_str()),
            ..facts("acme", "acme-inc")
        };
        assert!(check(&later).is_ok());
    }

    #[test]
    fn hold_ends_after_the_hold_period() {
        assert_eq!(hold_cutoff(NOW), rfc3339(NOW - SLUG_HOLD_DAYS * DAY_MS));
    }

    /// The tables, as `rename_workspace` changes them: slug by workspace
    /// id, and old slug → (workspace id, when).
    #[derive(Default)]
    struct Tables {
        workspaces: HashMap<&'static str, String>,
        redirects: HashMap<String, (&'static str, String)>,
    }

    impl Tables {
        /// The same steps, in the same order, as the batch.
        fn rename(&mut self, id: &'static str, to: &str, at: u64) {
            self.redirects.remove(to);
            let from = self.workspaces.insert(id, to.to_owned()).unwrap();
            self.redirects.insert(from, (id, rfc3339(at)));
        }

        /// As `redirect` + `resolve`.
        fn resolve(&self, slug: &str, now: u64) -> Option<String> {
            let row = self.redirects.get(slug).map(|(id, created_at)| RedirectRow {
                workspace_id: (*id).to_owned(),
                slug: self.workspaces[id].clone(),
                created_at: created_at.clone(),
            });
            resolve(row, now)
        }
    }

    #[test]
    fn renames_chain_to_the_current_slug() {
        let mut tables = Tables::default();
        tables.workspaces.insert("wsp_a", "acme".into());
        tables.rename("wsp_a", "acme-inc", NOW);
        tables.rename("wsp_a", "acme-corp", NOW + 2 * DAY_MS);
        let later = NOW + 3 * DAY_MS;
        assert_eq!(tables.resolve("acme", later).as_deref(), Some("acme-corp"));
        assert_eq!(tables.resolve("acme-inc", later).as_deref(), Some("acme-corp"));
        assert_eq!(tables.resolve("unknown", later), None);
        // Past the hold, the first old slug stops redirecting.
        let much_later = NOW + (SLUG_HOLD_DAYS + 1) * DAY_MS;
        assert_eq!(tables.resolve("acme", much_later), None);
        assert_eq!(tables.resolve("acme-inc", much_later).as_deref(), Some("acme-corp"));
    }

    #[test]
    fn renaming_back_drops_the_redirect_for_the_slug_in_use() {
        let mut tables = Tables::default();
        tables.workspaces.insert("wsp_a", "acme".into());
        tables.rename("wsp_a", "acme-inc", NOW);
        tables.rename("wsp_a", "acme", NOW + 2 * DAY_MS);
        assert!(!tables.redirects.contains_key("acme"));
        let later = NOW + 3 * DAY_MS;
        assert_eq!(tables.resolve("acme-inc", later).as_deref(), Some("acme"));
    }
}
