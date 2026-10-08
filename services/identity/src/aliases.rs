//! Workspace aliases: a name g1t's staff point at a workspace, so that its
//! addresses lead to the workspace under its own name. `g1t` is the
//! product Flagon, Inc. builds, and leads to `flagon-io`, the organization
//! (migration 0029), so nobody is confused by the trading name.
//!
//! Staff set and remove them from sudo; there is no way for a workspace to
//! make one. An alias is a reserved or unclaimed name, never a person's or
//! a workspace's, and points at the workspace's id, so it follows the
//! workspace through renames. While it exists nobody can register or
//! rename a workspace to it.
//!
//! An alias is resolved wherever an old slug is (`resolve_slug`): the site
//! and the API redirect or run again under the workspace's slug. Git over
//! HTTPS resolves it in place (`resolve_alias`), as pushes do not follow
//! redirects.

use g1t_contracts::identity::*;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, aliasable_name};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Identity;

/// The longest note or reason staff may give.
pub const MAX_NOTE_LENGTH: usize = 500;

/// Everything about a wanted alias that decides whether staff may set it,
/// as read from the database.
#[derive(Debug, Default)]
pub struct Facts<'a> {
    /// The workspace it would lead to, if there is one by that slug: its id.
    pub target: Option<&'a str>,
    /// A person has the name as their username.
    pub username: bool,
    /// A workspace has it as its slug, deleted or not.
    pub workspace: bool,
    /// A renamed workspace's old slug still held: the workspace it is held for.
    pub held_for: Option<&'a str>,
    /// A purged workspace had it; it is never given to anyone else.
    pub purged: bool,
    /// It is already an alias: of which workspace's slug.
    pub alias_of: Option<&'a str>,
}

/// The alias and note to store, or why not, in words for staff.
pub fn check(alias: &str, note: &str, facts: &Facts) -> std::result::Result<(String, String), (FailureCode, String)> {
    let refuse = |code, message: String| Err((code, message));
    let Some(alias) = aliasable_name(alias) else {
        return refuse(
            FailureCode::Invalid,
            "An alias uses lowercase letters, digits and single hyphens, up to 39 characters, and cannot be one of the site's routes.".into(),
        );
    };
    let note = note.trim();
    if note.is_empty() {
        return refuse(FailureCode::Invalid, "Say why the alias exists.".into());
    }
    if note.chars().count() > MAX_NOTE_LENGTH {
        return refuse(FailureCode::Invalid, format!("Keep the note to {MAX_NOTE_LENGTH} characters."));
    }
    let Some(target) = facts.target else {
        return refuse(FailureCode::NotFound, "There is no workspace with that slug.".into());
    };
    if let Some(slug) = facts.alias_of {
        return refuse(FailureCode::Conflict, format!("{alias} is already an alias of {slug}."));
    }
    if facts.username {
        return refuse(FailureCode::Conflict, format!("{alias} is someone's username."));
    }
    if facts.workspace {
        return refuse(FailureCode::Conflict, format!("{alias} is a workspace's slug."));
    }
    if facts.purged {
        return refuse(FailureCode::Conflict, format!("{alias} belonged to a deleted workspace."));
    }
    // A workspace's own old slug can become its alias for good.
    if facts.held_for.is_some_and(|holder| holder != target) {
        return refuse(FailureCode::Conflict, format!("{alias} is held for a renamed workspace."));
    }
    Ok((alias, note.to_owned()))
}

/// Where a first path segment leads, in the order `resolve_slug` asks: a
/// workspace that has it leads nowhere else; then an alias, which is for
/// good; then a renamed workspace's old slug, while it is held.
pub fn resolve(in_use: bool, alias: Option<String>, renamed: impl FnOnce() -> Option<String>) -> Option<String> {
    if in_use {
        return None;
    }
    alias.or_else(renamed)
}

#[derive(Deserialize)]
struct AliasRow {
    alias: String,
    workspace_id: String,
    slug: String,
    name: String,
    note: String,
    created_by: String,
    created_at: String,
}

impl From<AliasRow> for WorkspaceAlias {
    fn from(row: AliasRow) -> Self {
        WorkspaceAlias {
            alias: row.alias,
            workspace_id: row.workspace_id,
            workspace: row.slug,
            workspace_name: row.name,
            note: row.note,
            created_by: row.created_by,
            created_at: row.created_at,
        }
    }
}

/// Aliases with their workspace as it is now. Never a deleted one's.
const ALIAS_ROWS: &str = "SELECT a.alias, a.workspace_id, w.slug, w.name, a.note, a.created_by, a.created_at
     FROM workspace_aliases a JOIN workspaces w ON w.id = a.workspace_id AND w.deleted_at IS NULL";

#[derive(Deserialize)]
struct Id {
    id: String,
}

impl Identity {
    async fn alias_row(&self, alias: &str) -> Result<Option<AliasRow>> {
        self.db
            .prepare(format!("{ALIAS_ROWS} WHERE a.alias = ?"))
            .bind(&[alias.into()])?
            .first::<AliasRow>(None)
            .await
    }

    /// `resolve_alias`: the slug now of the workspace `slug` is an alias of.
    pub async fn resolve_alias(&self, a: SlugArgs) -> Result<Option<String>> {
        let slug = a.slug.trim().to_lowercase();
        Ok(self.alias_row(&slug).await?.map(|row| row.slug))
    }

    /// Whether `slug` is an alias, of a workspace deleted or not, so nobody
    /// may register or rename a workspace to it.
    pub async fn is_alias(&self, slug: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT 1 AS held FROM workspace_aliases WHERE alias = ?")
            .bind(&[slug.trim().to_lowercase().into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some())
    }

    /// `admin_aliases`: every alias, by name. Staff only.
    pub async fn admin_aliases(&self) -> Result<Vec<WorkspaceAlias>> {
        Ok(self
            .db
            .prepare(format!("{ALIAS_ROWS} ORDER BY a.alias"))
            .all()
            .await?
            .results::<AliasRow>()?
            .into_iter()
            .map(WorkspaceAlias::from)
            .collect())
    }

    /// `admin_set_alias`: staff only. Recorded in sudo's audit log.
    pub async fn admin_set_alias(&self, a: AdminSetAliasArgs) -> Result<Outcome<WorkspaceAlias>> {
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member is setting it."));
        }
        let alias = a.alias.trim().to_lowercase();
        let workspace = a.workspace.trim().to_lowercase();
        let target = self
            .db
            .prepare("SELECT id FROM workspaces WHERE slug = ? AND deleted_at IS NULL")
            .bind(&[workspace.as_str().into()])?
            .first::<Id>(None)
            .await?;
        let username = self
            .db
            .prepare("SELECT 1 AS taken FROM users WHERE username = ?")
            .bind(&[alias.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some();
        #[derive(Deserialize)]
        struct Held {
            workspace_id: String,
            created_at: String,
        }
        let held = self
            .db
            .prepare("SELECT workspace_id, created_at FROM workspace_redirects WHERE old_slug = ?")
            .bind(&[alias.as_str().into()])?
            .first::<Held>(None)
            .await?
            .filter(|row| row.created_at >= crate::rename::hold_cutoff(now_ms()));
        let existing = self.alias_row(&alias).await?;
        // An alias of a deleted workspace is not listed, but still holds.
        let alias_of = match &existing {
            Some(row) => Some(row.slug.clone()),
            None => self.is_alias(&alias).await?.then(|| "a deleted workspace".to_owned()),
        };
        let facts = Facts {
            target: target.as_ref().map(|row| row.id.as_str()),
            username,
            workspace: self.slug_in_use(&alias).await?,
            held_for: held.as_ref().map(|row| row.workspace_id.as_str()),
            purged: self.slug_deleted(&alias).await?,
            alias_of: alias_of.as_deref(),
        };
        let (alias, note) = match check(&alias, &a.note, &facts) {
            Ok(checked) => checked,
            Err((code, message)) => return Ok(Outcome::fail(code, message)),
        };
        let Some(target) = target else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no workspace with that slug."));
        };
        self.db
            .batch(vec![
                // Its own old slug, made its alias: the redirect gives way.
                self.db
                    .prepare("DELETE FROM workspace_redirects WHERE old_slug = ? AND workspace_id = ?")
                    .bind(&[alias.as_str().into(), target.id.as_str().into()])?,
                self.db
                    .prepare(
                        "INSERT INTO workspace_aliases (alias, workspace_id, created_by, created_at, note)
                         VALUES (?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        alias.as_str().into(),
                        target.id.as_str().into(),
                        staff.into(),
                        rfc3339(now_ms()).into(),
                        note.as_str().into(),
                    ])?,
            ])
            .await?;
        self.record_for_staff(&workspace, "alias_added", &format!("Alias {alias} leads to {workspace}: {note}"), staff)
            .await;
        Ok(match self.alias_row(&alias).await? {
            Some(row) => Outcome::Ok(row.into()),
            None => Outcome::fail(FailureCode::NotFound, "There is no workspace with that slug."),
        })
    }

    /// `admin_remove_alias`: staff only. Recorded in sudo's audit log.
    pub async fn admin_remove_alias(&self, a: AdminRemoveAliasArgs) -> Result<Outcome<bool>> {
        let staff = a.staff.trim();
        if staff.is_empty() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Say which staff member is removing it."));
        }
        let reason = a.reason.trim();
        if reason.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say why the alias is being removed."));
        }
        if reason.chars().count() > MAX_NOTE_LENGTH {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("Keep the reason to {MAX_NOTE_LENGTH} characters."),
            ));
        }
        let alias = a.alias.trim().to_lowercase();
        let Some(row) = self.alias_row(&alias).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no alias by that name."));
        };
        self.db
            .prepare("DELETE FROM workspace_aliases WHERE alias = ?")
            .bind(&[alias.as_str().into()])?
            .run()
            .await?;
        self.record_for_staff(
            &row.slug,
            "alias_removed",
            &format!("Alias {alias} no longer leads to {}: {reason}", row.slug),
            staff,
        )
        .await;
        Ok(Outcome::Ok(true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn facts<'a>() -> Facts<'a> {
        Facts {
            target: Some("wsp_flagon"),
            ..Facts::default()
        }
    }

    fn refused(alias: &str, facts: &Facts) -> FailureCode {
        check(alias, "The product's name", facts).unwrap_err().0
    }

    #[test]
    fn a_reserved_or_unclaimed_name_can_be_an_alias() {
        assert_eq!(
            check(" G1T ", " The product's name, for Flagon, Inc. ", &facts()).unwrap(),
            ("g1t".to_owned(), "The product's name, for Flagon, Inc.".to_owned())
        );
        assert!(check("flagon", "Short name", &facts()).is_ok());
    }

    #[test]
    fn routes_and_malformed_names_are_never_aliases() {
        for bad in ["settings", "api", "login", "-g1t", "g1t-", "g--1t", "g1t_inc", "", "a.b"] {
            assert_eq!(refused(bad, &facts()), FailureCode::Invalid, "{bad}");
        }
    }

    #[test]
    fn a_reason_is_required_and_bounded() {
        assert_eq!(check("g1t", "  ", &facts()).unwrap_err().0, FailureCode::Invalid);
        let long = "x".repeat(MAX_NOTE_LENGTH + 1);
        assert_eq!(check("g1t", &long, &facts()).unwrap_err().0, FailureCode::Invalid);
    }

    #[test]
    fn a_persons_or_workspaces_name_is_never_an_alias() {
        let missing = Facts { target: None, ..facts() };
        assert_eq!(refused("g1t", &missing), FailureCode::NotFound);
        let person = Facts { username: true, ..facts() };
        assert_eq!(refused("ana", &person), FailureCode::Conflict);
        let workspace = Facts { workspace: true, ..facts() };
        assert_eq!(refused("acme", &workspace), FailureCode::Conflict);
        let purged = Facts { purged: true, ..facts() };
        assert_eq!(refused("initech", &purged), FailureCode::Conflict);
        let aliased = Facts {
            alias_of: Some("globex"),
            ..facts()
        };
        let (code, message) = check("g1t", "x", &aliased).unwrap_err();
        assert_eq!(code, FailureCode::Conflict);
        assert_eq!(message, "g1t is already an alias of globex.");
    }

    #[test]
    fn only_its_own_old_slug_can_become_a_workspaces_alias() {
        let others = Facts {
            held_for: Some("wsp_other"),
            ..facts()
        };
        assert_eq!(refused("acme", &others), FailureCode::Conflict);
        let own = Facts {
            held_for: Some("wsp_flagon"),
            ..facts()
        };
        assert!(check("flagon", "Its old name, for good", &own).is_ok());
    }

    #[test]
    fn a_workspace_in_use_is_never_resolved_elsewhere() {
        let alias = || Some("flagon-io".to_owned());
        assert_eq!(resolve(true, alias(), || Some("x".into())), None);
        assert_eq!(resolve(false, alias(), || Some("x".into())).as_deref(), Some("flagon-io"));
        assert_eq!(resolve(false, None, || Some("acme-inc".into())).as_deref(), Some("acme-inc"));
        assert_eq!(resolve(false, None, || None), None);
    }

    /// Aliases point at ids, as the table does; renames change the slug.
    #[test]
    fn an_alias_follows_its_workspace_through_renames() {
        let mut slugs: HashMap<&str, &str> = HashMap::from([("wsp_flagon", "flagon-io")]);
        let aliases: HashMap<&str, &str> = HashMap::from([("g1t", "wsp_flagon")]);
        let lookup = |slugs: &HashMap<&str, &str>, alias: &str| {
            aliases.get(alias).and_then(|id| slugs.get(id)).map(|slug| (*slug).to_owned())
        };
        assert_eq!(lookup(&slugs, "g1t").as_deref(), Some("flagon-io"));
        slugs.insert("wsp_flagon", "flagon");
        assert_eq!(lookup(&slugs, "g1t").as_deref(), Some("flagon"));
        slugs.insert("wsp_flagon", "flagon-inc");
        assert_eq!(lookup(&slugs, "g1t").as_deref(), Some("flagon-inc"));
        assert_eq!(lookup(&slugs, "acme"), None);
    }
}
