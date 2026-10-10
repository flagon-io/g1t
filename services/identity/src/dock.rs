//! Dock pins: the apps each person pins to their dock, per workspace, kept
//! with their account so the dock is the same on every device.
//!
//! A row per person and workspace (migration 0044), keyed by the
//! workspace's id so a rename keeps it. Only the person reads or sets
//! their own, and only in a workspace they belong to. The keys are checked
//! for shape here; which apps exist is the web app's list (apps/web's
//! app/lib/apps.ts), so a new app needs no change to this service.

use g1t_contracts::identity::*;
use g1t_contracts::time::SQL_NOW;
use g1t_contracts::{FailureCode, Outcome};
use serde::Deserialize;
use worker::Result;

use crate::Identity;
use crate::security::is_person;

/// The pins as they are kept: each key checked, repeats dropped, in the
/// order given. Refused whole when a key is malformed or there are too many.
pub fn check_pins(apps: &[String]) -> std::result::Result<Vec<String>, String> {
    let mut kept: Vec<String> = Vec::with_capacity(apps.len());
    for app in apps {
        let key = app.trim();
        let well_formed = !key.is_empty()
            && key.len() <= MAX_DOCK_APP_KEY
            && key.starts_with(|c: char| c.is_ascii_lowercase())
            && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !well_formed {
            return Err("That is not an app you can pin.".to_owned());
        }
        if !kept.iter().any(|seen| seen == key) {
            kept.push(key.to_owned());
        }
    }
    if kept.len() > MAX_DOCK_PINS {
        return Err(format!("Pin at most {MAX_DOCK_PINS} apps."));
    }
    Ok(kept)
}

/// The pins in a row, or none when the row cannot be read: a bad row is
/// treated as never saved rather than failing the page.
fn parse_pins(apps: &str) -> Option<Vec<String>> {
    let keys: Vec<String> = serde_json::from_str(apps).ok()?;
    check_pins(&keys).ok()
}

#[derive(Deserialize)]
struct Row {
    apps: String,
}

impl Identity {
    pub async fn dock_pins(&self, a: DockPinsArgs) -> Result<Option<Vec<String>>> {
        let slug = a.workspace.trim().to_lowercase();
        if !is_person(&a.user) || !a.user.is_member(&slug) {
            return Ok(None);
        }
        // One query: the workspace by slug, and only while they belong to it.
        let row = self
            .db
            .prepare(
                "SELECT d.apps FROM dock_pins d
                 JOIN workspaces w ON w.id = d.workspace_id AND w.deleted_at IS NULL
                 JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = d.user_id
                 WHERE d.user_id = ? AND w.slug = ?",
            )
            .bind(&[a.user.id.as_str().into(), slug.into()])?
            .first::<Row>(None)
            .await?;
        Ok(row.and_then(|row| parse_pins(&row.apps)))
    }

    pub async fn set_dock_pins(&self, a: SetDockPinsArgs) -> Result<Outcome<Vec<String>>> {
        let slug = a.workspace.trim().to_lowercase();
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a person has a dock."));
        }
        if !a.user.is_member(&slug) {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        }
        let apps = match check_pins(&a.apps) {
            Ok(apps) => apps,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let json = serde_json::to_string(&apps)?;
        // Written only where they are still a member, in one statement.
        let row = self
            .db
            .prepare(format!(
                "INSERT INTO dock_pins (user_id, workspace_id, apps, updated_at)
                 SELECT ?1, w.id, ?2, {SQL_NOW} FROM workspaces w
                 JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?1
                 WHERE w.slug = ?3 AND w.deleted_at IS NULL
                 ON CONFLICT (user_id, workspace_id) DO UPDATE SET apps = excluded.apps, updated_at = excluded.updated_at
                 RETURNING apps"
            ))
            .bind(&[a.user.id.as_str().into(), json.as_str().into(), slug.into()])?
            .first::<Row>(None)
            .await?;
        Ok(match row {
            Some(_) => Outcome::Ok(apps),
            None => Outcome::fail(FailureCode::NotFound, "Workspace not found."),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(list: &[&str]) -> Vec<String> {
        list.iter().map(|key| (*key).to_owned()).collect()
    }

    #[test]
    fn pins_keep_their_order_without_repeats() {
        assert_eq!(check_pins(&keys(&["usage", "projects", "usage", " teams "])).unwrap(), keys(&["usage", "projects", "teams"]));
        assert_eq!(check_pins(&[]).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn a_malformed_key_is_refused() {
        for bad in ["", "Projects", "1st", "a b", "../x", "pro_jects", "<script>", &"a".repeat(MAX_DOCK_APP_KEY + 1)] {
            assert!(check_pins(&keys(&["projects", bad])).is_err(), "{bad}");
        }
        assert!(check_pins(&keys(&["ai-gateway", "v2"])).is_ok());
    }

    #[test]
    fn at_most_the_limit() {
        let many: Vec<String> = (0..MAX_DOCK_PINS).map(|n| format!("app-{n}")).collect();
        assert_eq!(check_pins(&many).unwrap().len(), MAX_DOCK_PINS);
        let too_many: Vec<String> = (0..=MAX_DOCK_PINS).map(|n| format!("app-{n}")).collect();
        assert!(check_pins(&too_many).is_err());
        // Repeats do not count against it.
        let repeated: Vec<String> = many.iter().chain(many.iter()).cloned().collect();
        assert_eq!(check_pins(&repeated).unwrap(), many);
    }

    #[test]
    fn a_bad_row_reads_as_never_saved() {
        assert_eq!(parse_pins(r#"["projects","usage"]"#), Some(keys(&["projects", "usage"])));
        assert_eq!(parse_pins("[]"), Some(Vec::new()));
        assert_eq!(parse_pins("not json"), None);
        assert_eq!(parse_pins(r#"["BAD"]"#), None);
    }
}
