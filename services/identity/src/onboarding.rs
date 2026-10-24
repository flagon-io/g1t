//! Getting started: each person's own state of a workspace's setup guide,
//! the dialog that opens on its Home for its owners until they finish or
//! dismiss it.
//!
//! A row per person and workspace (migration 0050), keyed by the
//! workspace's id so a rename keeps it: when they dismissed it, and the
//! steps they skipped. A person with no row has never dismissed it. Whether
//! a step is done is the workspace's own state (its AI providers,
//! repositories, members, runners), which the web app reads; nothing here
//! says a step is done. Only the person reads or changes their own, and
//! only in a workspace they belong to.

use g1t_contracts::identity::*;
use g1t_contracts::time::SQL_NOW;
use g1t_contracts::{FailureCode, Outcome};
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Identity;
use crate::security::is_person;

/// `skipped` as it is kept: each a step the guide has, in the guide's
/// order, without repeats. Refused whole when one is not a step.
pub fn check_skipped(steps: &[String]) -> std::result::Result<Vec<String>, String> {
    for step in steps {
        if !ONBOARDING_STEPS.contains(&step.trim()) {
            return Err(format!("{} is not a step of Getting started. The steps are {}.", step.trim(), ONBOARDING_STEPS.join(", ")));
        }
    }
    Ok(ONBOARDING_STEPS.iter().filter(|step| steps.iter().any(|given| given.trim() == **step)).map(|step| (*step).to_owned()).collect())
}

/// What a change does to `dismissed_at`, as the statement in
/// `set_onboarding` reads it: 0 leaves it as it is, 1 dismisses the guide
/// now (a second dismissal keeps the first time), 2 brings it back to
/// opening by itself.
pub fn dismiss_mode(dismissed: Option<bool>) -> i32 {
    match dismissed {
        None => 0,
        Some(true) => 1,
        Some(false) => 2,
    }
}

#[derive(Deserialize)]
struct Row {
    dismissed_at: Option<String>,
    skipped: String,
    updated_at: Option<String>,
}

/// A row as the guide's state. A `skipped` that cannot be read is nothing
/// skipped, and a step the guide no longer has is dropped, rather than
/// failing the page.
fn onboarding_from(row: Row) -> Onboarding {
    let saved: Vec<String> = serde_json::from_str(&row.skipped).unwrap_or_default();
    let skipped = ONBOARDING_STEPS.iter().filter(|step| saved.iter().any(|s| s == *step)).map(|step| (*step).to_owned()).collect();
    Onboarding { dismissed_at: row.dismissed_at, skipped, updated_at: row.updated_at }
}

impl Identity {
    async fn read_onboarding(&self, user_id: &str, slug: &str) -> Result<Option<Onboarding>> {
        // One query: the workspace by slug, and only while they belong to it.
        let row = self
            .db
            .prepare(
                "SELECT o.dismissed_at, o.skipped, o.updated_at FROM onboarding o
                 JOIN workspaces w ON w.id = o.workspace_id AND w.deleted_at IS NULL
                 JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = o.user_id
                 WHERE o.user_id = ? AND w.slug = ?",
            )
            .bind(&[user_id.into(), slug.into()])?
            .first::<Row>(None)
            .await?;
        Ok(row.map(onboarding_from))
    }

    pub async fn onboarding(&self, a: OnboardingArgs) -> Result<Outcome<Onboarding>> {
        let slug = a.workspace.trim().to_lowercase();
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a person has Getting started."));
        }
        if !a.user.is_member(&slug) {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        }
        Ok(Outcome::Ok(self.read_onboarding(&a.user.id, &slug).await?.unwrap_or_default()))
    }

    pub async fn set_onboarding(&self, a: SetOnboardingArgs) -> Result<Outcome<Onboarding>> {
        let slug = a.workspace.trim().to_lowercase();
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a person has Getting started."));
        }
        if !a.user.is_member(&slug) {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        }
        let skipped = match &a.change.skipped {
            None => None,
            Some(steps) => match check_skipped(steps) {
                Ok(steps) => Some(steps),
                Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            },
        };
        let skipped = skipped.map(|steps| serde_json::to_string(&steps)).transpose()?;
        // Written only where they are still a member, in one statement: a
        // first dismissal is now and a second keeps the first time, and
        // skipped steps left out of the change stay as they were.
        let row = self
            .db
            .prepare(format!(
                "INSERT INTO onboarding (user_id, workspace_id, dismissed_at, skipped, updated_at)
                 SELECT ?1, w.id, CASE ?2 WHEN 1 THEN {SQL_NOW} ELSE NULL END, COALESCE(?3, '[]'), {SQL_NOW} FROM workspaces w
                 JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?1
                 WHERE w.slug = ?4 AND w.deleted_at IS NULL
                 ON CONFLICT (user_id, workspace_id) DO UPDATE SET
                   dismissed_at = CASE ?2 WHEN 0 THEN onboarding.dismissed_at WHEN 1 THEN COALESCE(onboarding.dismissed_at, {SQL_NOW}) ELSE NULL END,
                   skipped = COALESCE(?3, onboarding.skipped), updated_at = excluded.updated_at
                 RETURNING dismissed_at, skipped, updated_at"
            ))
            .bind(&[
                a.user.id.as_str().into(),
                dismiss_mode(a.change.dismissed).into(),
                skipped.as_deref().map_or(JsValue::NULL, Into::into),
                slug.into(),
            ])?
            .first::<Row>(None)
            .await?;
        Ok(match row {
            Some(row) => Outcome::Ok(onboarding_from(row)),
            None => Outcome::fail(FailureCode::NotFound, "Workspace not found."),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steps(list: &[&str]) -> Vec<String> {
        list.iter().map(|step| (*step).to_owned()).collect()
    }

    #[test]
    fn skipped_steps_keep_the_guides_order_without_repeats() {
        assert_eq!(check_skipped(&steps(&["runner", " people ", "runner"])).unwrap(), steps(&["people", "runner"]));
        assert_eq!(check_skipped(&[]).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn a_step_the_guide_lacks_is_refused() {
        let refused = check_skipped(&steps(&["ai", "billing"])).unwrap_err();
        assert!(refused.contains("billing") && refused.contains("ai, ask, code"), "{refused}");
        assert!(check_skipped(&steps(&[""])).is_err());
    }

    #[test]
    fn a_change_says_what_happens_to_the_dismissal() {
        assert_eq!(dismiss_mode(None), 0);
        assert_eq!(dismiss_mode(Some(true)), 1);
        assert_eq!(dismiss_mode(Some(false)), 2);
    }

    #[test]
    fn a_row_reads_with_only_the_steps_the_guide_has() {
        let row = |skipped: &str| Row { dismissed_at: None, skipped: skipped.to_owned(), updated_at: None };
        assert_eq!(onboarding_from(row(r#"["runner","ask","gone"]"#)).skipped, steps(&["ask", "runner"]));
        assert_eq!(onboarding_from(row("not json")).skipped, Vec::<String>::new());
    }

    #[test]
    fn a_person_who_never_chose_has_the_guide_open() {
        let fresh = Onboarding::default();
        assert!(fresh.dismissed_at.is_none() && fresh.skipped.is_empty());
        let wire = serde_json::to_value(&fresh).unwrap();
        assert_eq!(wire, serde_json::json!({ "dismissed_at": null, "skipped": [], "updated_at": null }));
    }
}
