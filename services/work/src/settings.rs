//! A repository's settings for how g1t's agents handle its pull requests,
//! and the branch protection settings that are now its "Default branch
//! protection" ruleset (rulesets.rs).
//!
//! What a merge needs is decided by the rules of the branch it merges into
//! (`Work::merge_gate`); `approvals_gap` asks them for what people must
//! still do, as g1t sees it when it merges by itself.

use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;

const MAX_REQUIRED_APPROVALS: u32 = 6;
const MAX_REVISIONS: u32 = 5;

#[derive(Deserialize)]
struct SettingsRow {
    auto_merge: u8,
    require_up_to_date: u8,
    required_approvals: u32,
    count_agent_approvals: u8,
    allow_ignoring_checks: u8,
    agent_review: u8,
    max_revisions: u32,
    #[serde(default)]
    merge_queue: u8,
    /// JSON array of names.
    #[serde(default)]
    required_checks: Option<String>,
    #[serde(default)]
    require_code_owner_review: u8,
    updated_by: String,
    updated_at: String,
}

impl From<SettingsRow> for RepoSettings {
    fn from(row: SettingsRow) -> Self {
        RepoSettings {
            auto_merge: row.auto_merge != 0,
            required_checks: row
                .required_checks
                .as_deref()
                .and_then(|names| serde_json::from_str(names).ok())
                .unwrap_or_default(),
            require_up_to_date: row.require_up_to_date != 0,
            required_approvals: row.required_approvals,
            count_agent_approvals: row.count_agent_approvals != 0,
            allow_ignoring_checks: row.allow_ignoring_checks != 0,
            agent_review: row.agent_review != 0,
            max_revisions: row.max_revisions,
            merge_queue: row.merge_queue != 0,
            // Kept in its own table (confidence.rs), read beside this row.
            hold_low_confidence: true,
            require_code_owner_review: row.require_code_owner_review != 0,
            updated_by: Some(row.updated_by),
            updated_at: Some(row.updated_at),
        }
    }
}

impl Work {
    /// A repository's stored settings, by its id: how g1t's agents handle
    /// its pull requests. Defaults if none were set. Branch protection is
    /// its rules': see `settings_on`.
    pub(crate) async fn settings(&self, repo_id: &str) -> Result<RepoSettings> {
        if let Some(found) = self.prefetched_repo(repo_id) {
            let row = found.first::<SettingsRow>(crate::prefetch::Slot::Settings)?;
            let hold = found
                .first::<crate::rows::NumberRow>(crate::prefetch::Slot::Hold)?
                .is_none_or(|row| row.n != 0);
            return Ok(RepoSettings {
                hold_low_confidence: hold,
                ..row.map_or_else(RepoSettings::default, RepoSettings::from)
            });
        }
        let row = async {
            self.db
                .prepare("SELECT * FROM repo_settings WHERE repo_id = ?")
                .bind(&[repo_id.into()])?
                .first::<SettingsRow>(None)
                .await
        };
        let (row, hold) = futures_util::future::try_join(row, self.holds_low_confidence(repo_id)).await?;
        Ok(RepoSettings {
            hold_low_confidence: hold,
            ..row.map_or_else(RepoSettings::default, RepoSettings::from)
        })
    }

    /// The default branch's settings: the stored ones, with branch
    /// protection as its rules stack.
    pub(crate) async fn get_settings(&self, a: ViewArgs) -> Result<Outcome<RepoSettings>> {
        let repo = match self.repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        Ok(Outcome::Ok(self.timing.db(3, self.default_branch_settings(&repo)).await?))
    }

    /// Replaces a repository's settings: how g1t's agents work, kept here,
    /// and the branch protection ones, written to its "Default branch
    /// protection" ruleset (made when it has none and they protect
    /// anything). Rules that only rulesets have stay as they are.
    pub(crate) async fn update_settings(
        &self,
        a: UpdateSettingsArgs,
    ) -> Result<Outcome<RepoSettings>> {
        let repo = match self.repo(&a.repo, &Some(a.actor.clone())).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if let Outcome::Fail(failure) = crate::retired::writable(&repo) {
            return Ok(Outcome::Fail(failure));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
        }
        if let Outcome::Fail(failure) =
            crate::allowed(Some(&a.actor), &repo, g1t_contracts::access::Capability::ManageSettings)
        {
            return Ok(Outcome::Fail(failure));
        }
        let before = self.default_branch_settings(&repo).await?;
        let settings = RepoSettings {
            required_approvals: a.settings.required_approvals.min(MAX_REQUIRED_APPROVALS),
            max_revisions: a.settings.max_revisions.min(MAX_REVISIONS),
            required_checks: tidy_required(&a.settings.required_checks),
            updated_by: Some(a.actor.username.clone()),
            updated_at: Some(rfc3339(now_ms())),
            ..a.settings
        };
        // Branch protection changes need the role that changes it.
        if protection_changed(&before, &settings)
            && let Outcome::Fail(failure) =
                crate::allowed(Some(&a.actor), &repo, g1t_contracts::access::Capability::ManageProtection)
        {
            return Ok(Outcome::Fail(failure));
        }
        self.db
            .prepare(
                "INSERT INTO repo_settings
                   (repo_id, auto_merge, require_up_to_date, required_approvals,
                    count_agent_approvals, allow_ignoring_checks, agent_review, max_revisions,
                    merge_queue, required_checks, require_code_owner_review, updated_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (repo_id) DO UPDATE SET
                   auto_merge = excluded.auto_merge,
                   require_up_to_date = excluded.require_up_to_date,
                   required_approvals = excluded.required_approvals,
                   count_agent_approvals = excluded.count_agent_approvals,
                   allow_ignoring_checks = excluded.allow_ignoring_checks,
                   agent_review = excluded.agent_review,
                   max_revisions = excluded.max_revisions,
                   merge_queue = excluded.merge_queue,
                   required_checks = excluded.required_checks,
                   require_code_owner_review = excluded.require_code_owner_review,
                   updated_by = excluded.updated_by,
                   updated_at = excluded.updated_at",
            )
            .bind(&[
                repo.id.as_str().into(),
                u32::from(settings.auto_merge).into(),
                u32::from(settings.require_up_to_date).into(),
                settings.required_approvals.into(),
                u32::from(settings.count_agent_approvals).into(),
                u32::from(settings.allow_ignoring_checks).into(),
                u32::from(settings.agent_review).into(),
                settings.max_revisions.into(),
                u32::from(settings.merge_queue).into(),
                serde_json::to_string(&settings.required_checks)?.into(),
                u32::from(settings.require_code_owner_review).into(),
                settings.updated_by.as_deref().unwrap_or_default().into(),
                settings.updated_at.as_deref().unwrap_or_default().into(),
            ])?
            .run()
            .await?;
        self.set_hold_low_confidence(
            &repo.id,
            settings.hold_low_confidence,
            settings.updated_by.as_deref().unwrap_or_default(),
            settings.updated_at.as_deref().unwrap_or_default(),
        )
        .await?;
        if protection_changed(&before, &settings) {
            self.write_branch_protection(&repo, &settings, &a.actor).await?;
        }
        Ok(Outcome::Ok(self.default_branch_settings(&repo).await?))
    }
}

/// Whether the branch protection part of the settings differs.
fn protection_changed(before: &RepoSettings, after: &RepoSettings) -> bool {
    let names = |settings: &RepoSettings| -> Vec<String> {
        let mut names: Vec<String> = settings.required_checks.iter().map(|name| name.to_lowercase()).collect();
        names.sort();
        names
    };
    names(before) != names(after)
        || before.require_up_to_date != after.require_up_to_date
        || before.required_approvals != after.required_approvals
        || before.count_agent_approvals != after.count_agent_approvals
        || before.allow_ignoring_checks != after.allow_ignoring_checks
        || before.merge_queue != after.merge_queue
        || before.require_code_owner_review != after.require_code_owner_review
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_protection_changes_count_as_protection_changes() {
        let before = RepoSettings::default();
        let agents = RepoSettings { auto_merge: true, agent_review: false, max_revisions: 4, ..RepoSettings::default() };
        assert!(!protection_changed(&before, &agents));
        let checks = RepoSettings { required_checks: vec!["CI".into()], ..RepoSettings::default() };
        assert!(protection_changed(&before, &checks));
        let same = RepoSettings { required_checks: vec!["ci".into()], ..RepoSettings::default() };
        assert!(!protection_changed(&checks, &same), "names compare without case");
        let approvals = RepoSettings { required_approvals: 1, ..RepoSettings::default() };
        assert!(protection_changed(&before, &approvals));
    }
}
