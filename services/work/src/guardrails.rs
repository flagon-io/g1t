//! Guardrails: what a workspace lets its agents do in a sandbox, as its
//! defaults and each project's overrides. The runner service reads what a
//! run gets (`run_guardrails`) and enforces it; this service keeps the
//! settings and ends a run that reached a cap (`halt_run`, from
//! `report_run`).
//!
//! See `g1t_contracts::guardrails` for the rules and how levels merge.

use g1t_contracts::agents::RunStatus;
use g1t_contracts::guardrails::*;
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::StallArgs;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, Viewer};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::reviews::{AGENT_ID, AGENT_NAME};
use crate::runs::member_of;

/// Statements that move a renamed workspace's guardrails to its new slug.
/// Run with the new slug as `?1` and the old as `?2`.
pub(crate) const RENAMED: &[&str] = &[
    "UPDATE guardrails SET scope_key = ?1 WHERE scope = 'workspace' AND scope_key = ?2",
    "UPDATE guardrails SET workspace = ?1 WHERE workspace = ?2",
];

#[derive(Deserialize)]
struct SettingsRow {
    settings: String,
    updated_by: String,
    updated_at: String,
}

impl From<SettingsRow> for GuardrailSettings {
    fn from(row: SettingsRow) -> Self {
        let mut settings: GuardrailSettings = serde_json::from_str(&row.settings).unwrap_or_default();
        settings.updated_by = Some(row.updated_by);
        settings.updated_at = Some(row.updated_at);
        settings
    }
}

/// Whether `actor` is a verified person, not a token or an agent.
fn is_person(actor: &User) -> bool {
    actor.verified && actor.kind == PrincipalKind::User
}

/// What a halted run is told, and what its pull request says.
fn halt_message(halt: Halt) -> &'static str {
    match halt {
        Halt::Budget => "Stopped: it reached its cost cap.",
        Halt::Time => "Stopped: it reached its time cap.",
    }
}

impl Work {
    async fn guardrail_level(&self, scope: &str, key: &str) -> Result<GuardrailSettings> {
        Ok(self
            .db
            .prepare("SELECT settings, updated_by, updated_at FROM guardrails WHERE scope = ? AND scope_key = ?")
            .bind(&[scope.into(), key.into()])?
            .first::<SettingsRow>(None)
            .await?
            .map(GuardrailSettings::from)
            .unwrap_or_default())
    }

    /// The project at `path`, which must be in `workspace`.
    async fn guarded_repo(&self, path: &RepoPath, viewer: &Viewer, workspace: &str) -> Result<Outcome<Repo>> {
        Ok(match self.repo(path, viewer).await? {
            Outcome::Ok(repo) if repo.namespace.to_lowercase() == workspace => Outcome::Ok(repo),
            Outcome::Ok(_) => Outcome::fail(FailureCode::Invalid, "That project is in another workspace."),
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    }

    async fn guardrails_view(&self, workspace: &str, repo: Option<&Repo>) -> Result<GuardrailsView> {
        let level = self.guardrail_level("workspace", workspace).await?;
        let project = match repo {
            Some(repo) => Some(self.guardrail_level("project", &repo.id).await?),
            None => None,
        };
        Ok(GuardrailsView::new(level, project))
    }

    pub(crate) async fn get_guardrails(&self, a: GetGuardrailsArgs) -> Result<Outcome<GuardrailsView>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.as_ref().is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Guardrails are for members of the workspace.",
            ));
        }
        let repo = match &a.repo {
            Some(path) => match self.guarded_repo(path, &a.viewer, &workspace).await? {
                Outcome::Ok(repo) => Some(repo),
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            },
            None => None,
        };
        Ok(Outcome::Ok(self.guardrails_view(&workspace, repo.as_ref()).await?))
    }

    pub(crate) async fn update_guardrails(&self, a: UpdateGuardrailsArgs) -> Result<Outcome<GuardrailsView>> {
        let workspace = a.workspace.to_lowercase();
        let viewer = Some(a.actor.clone());
        let repo = match &a.repo {
            Some(path) => match self.guarded_repo(path, &viewer, &workspace).await? {
                Outcome::Ok(repo) => Some(repo),
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            },
            None => None,
        };
        // A project's guardrails are its members' to set, as its other
        // settings are; the defaults every project inherits are the owners'.
        let allowed = is_person(&a.actor)
            && match repo {
                Some(_) => a.actor.is_member(&workspace),
                None => a.actor.role_in(&workspace) == Some(Role::Owner),
            };
        if !allowed {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                if repo.is_some() {
                    "Only members of the workspace can change a project's guardrails."
                } else {
                    "Only owners of the workspace can change its guardrails."
                },
            ));
        }
        let mut settings = match validate(a.settings) {
            Ok(settings) => settings,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        settings.updated_by = None;
        settings.updated_at = None;
        let (scope, key) = match &repo {
            Some(repo) => ("project", repo.id.clone()),
            None => ("workspace", workspace.clone()),
        };
        self.db
            .prepare(
                "INSERT INTO guardrails (scope, scope_key, workspace, settings, updated_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (scope, scope_key) DO UPDATE SET
                   settings = excluded.settings,
                   updated_by = excluded.updated_by,
                   updated_at = excluded.updated_at",
            )
            .bind(&[
                scope.into(),
                key.into(),
                workspace.as_str().into(),
                serde_json::to_string(&settings)?.into(),
                a.actor.username.as_str().into(),
                rfc3339(now_ms()).into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(self.guardrails_view(&workspace, repo.as_ref()).await?))
    }

    /// What a run in `repo` gets. The runner is trusted: it names the
    /// repository it is starting a sandbox in.
    pub(crate) async fn run_guardrails(&self, a: RunGuardrailsArgs) -> Result<Outcome<Guardrails>> {
        let workspace = a.repo.namespace.to_lowercase();
        let repo = match self.repo(&a.repo, &member_of_service(&workspace)).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let level = self.guardrail_level("workspace", &workspace).await?;
        let project = self.guardrail_level("project", &repo.id).await?;
        Ok(Outcome::Ok(Guardrails::merge(&level, Some(&project))))
    }

    /// Ends a run that reached a cap of its guardrails, as stopped, and
    /// leaves a pull request it was working on for a person, as a stop by
    /// a person does. Called from `report_run` once its token is checked.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn halt_run(
        &self,
        run_id: &str,
        repo_id: &str,
        pull_id: Option<&str>,
        number: Option<u32>,
        kind: &str,
        halt: Halt,
        detail: Option<String>,
        cost_usd: Option<f64>,
    ) -> Result<Outcome<RunStatus>> {
        let said = detail
            .map(|detail| crate::runs::one_line(&detail, 1000))
            .filter(|detail| !detail.is_empty())
            .unwrap_or_else(|| halt_message(halt).to_owned());
        let now = rfc3339(now_ms());
        let claimed = self
            .db
            .prepare(
                "UPDATE agent_runs SET status = 'stopped', halted = ?1, step = ?2, error = ?2,
                   cost_usd = COALESCE(?3, cost_usd), started_at = COALESCE(started_at, ?4),
                   finished_at = ?4, updated_at = ?4
                 WHERE id = ?5 AND finished_at IS NULL RETURNING id AS value",
            )
            .bind(&[
                halt.as_str().into(),
                said.as_str().into(),
                cost_usd
                    .filter(|cost| cost.is_finite() && *cost >= 0.0)
                    .map_or(JsValue::NULL, JsValue::from),
                now.as_str().into(),
                run_id.into(),
            ])?
            .first::<String>(Some("value"))
            .await?;
        if claimed.is_none() {
            return Ok(Outcome::Ok(RunStatus::Stopped));
        }
        self.add_step(run_id, &now, &said)?.run().await?;
        if let (Some(pull_id), Some(number)) = (pull_id, number) {
            let cap = match halt {
                Halt::Budget => "cost cap",
                Halt::Time => "time cap",
            };
            self.stall(StallArgs {
                pull_id: pull_id.to_owned(),
                reason: format!(
                    "g1t stopped the agent's {kind} run when it reached its {cap}. Raise the cap under Settings, Guardrails, then ask for a review, a revision or a catch-up to start again."
                ),
            })
            .await?;
            self.note(
                repo_id,
                number,
                (AGENT_ID, AGENT_NAME),
                &format!("stopped its {kind} run at its {cap}"),
            )
            .await?;
        }
        Ok(Outcome::Ok(RunStatus::Stopped))
    }
}

/// A principal that can read any repository of `workspace`, for the
/// runner's lookups.
fn member_of_service(workspace: &str) -> Viewer {
    member_of(
        &User {
            id: "svc_runner".to_owned(),
            username: "g1t".to_owned(),
            ..User::default()
        },
        workspace,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_take_two_parameters() {
        for sql in RENAMED {
            assert!(sql.contains("?1") && sql.contains("?2"), "{sql}");
        }
    }

    #[test]
    fn a_level_reads_back_with_who_changed_it() {
        let row = SettingsRow {
            settings: r#"{"budgetUsd":2.5,"domains":["example.com"]}"#.to_owned(),
            updated_by: "ada".to_owned(),
            updated_at: "2026-10-04T00:00:00Z".to_owned(),
        };
        let settings = GuardrailSettings::from(row);
        assert_eq!(settings.budget_usd, Some(2.5));
        assert_eq!(settings.domains, vec!["example.com"]);
        assert_eq!(settings.updated_by.as_deref(), Some("ada"));
    }

    #[test]
    fn a_corrupt_level_reads_as_inheriting_everything() {
        let row = SettingsRow {
            settings: "not json".to_owned(),
            updated_by: "ada".to_owned(),
            updated_at: "2026-10-04T00:00:00Z".to_owned(),
        };
        assert_eq!(GuardrailSettings::from(row).budget_usd, None);
    }
}
