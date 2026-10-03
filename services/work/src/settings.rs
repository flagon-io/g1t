//! A repository's settings for how its pull requests are handled, and the
//! rule about approvals that merging enforces.

use std::collections::HashMap;

use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;
use crate::reviews::AGENT_ID;

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
    updated_by: String,
    updated_at: String,
}

impl From<SettingsRow> for RepoSettings {
    fn from(row: SettingsRow) -> Self {
        RepoSettings {
            auto_merge: row.auto_merge != 0,
            require_up_to_date: row.require_up_to_date != 0,
            required_approvals: row.required_approvals,
            count_agent_approvals: row.count_agent_approvals != 0,
            allow_ignoring_checks: row.allow_ignoring_checks != 0,
            agent_review: row.agent_review != 0,
            max_revisions: row.max_revisions,
            merge_queue: row.merge_queue != 0,
            updated_by: Some(row.updated_by),
            updated_at: Some(row.updated_at),
        }
    }
}

/// What is missing before a pull request has the approvals its repository
/// asks for, or `None` if nothing is. `verdicts` is each reviewer's id and
/// their most recent verdict; the author's own does not count.
pub(crate) fn approvals_missing(
    settings: &RepoSettings,
    author_id: &str,
    verdicts: &[(String, Verdict)],
) -> Option<String> {
    if settings.required_approvals == 0 {
        return None;
    }
    let others = || {
        verdicts
            .iter()
            .filter(|(reviewer, _)| reviewer != author_id)
    };
    if others().any(|(_, verdict)| *verdict == Verdict::RequestChanges) {
        return Some("A reviewer has asked for changes.".to_owned());
    }
    let approvals = others()
        .filter(|(reviewer, _)| settings.count_agent_approvals || reviewer != AGENT_ID)
        .count() as u32;
    if approvals >= settings.required_approvals {
        return None;
    }
    let needed = settings.required_approvals;
    let from = if settings.count_agent_approvals {
        ""
    } else {
        " from people"
    };
    Some(format!(
        "This repository requires {needed} approving {}{from} before a pull request merges; this one has {approvals}.",
        if needed == 1 { "review" } else { "reviews" },
    ))
}

#[derive(Deserialize)]
struct VerdictRow {
    author_id: String,
    verdict: Verdict,
}

impl Work {
    /// The settings of a repository, by its id. Defaults if none were set.
    pub(crate) async fn settings(&self, repo_id: &str) -> Result<RepoSettings> {
        Ok(self
            .db
            .prepare("SELECT * FROM repo_settings WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<SettingsRow>(None)
            .await?
            .map_or_else(RepoSettings::default, RepoSettings::from))
    }

    /// What is missing before a pull request has the approvals its
    /// repository asks for, or `None` if nothing is.
    pub(crate) async fn approvals_gap(
        &self,
        settings: &RepoSettings,
        pull: &Pull,
    ) -> Result<Option<String>> {
        if settings.required_approvals == 0 {
            return Ok(None);
        }
        let rows = self
            .db
            .prepare(
                "SELECT author_id, verdict FROM comments
                 WHERE repo_id = ? AND number = ? AND verdict IS NOT NULL ORDER BY id",
            )
            .bind(&[pull.repo_id.as_str().into(), pull.number.into()])?
            .all()
            .await?
            .results::<VerdictRow>()?;
        // Each reviewer's latest verdict is the one that stands.
        let mut latest: HashMap<String, Verdict> = HashMap::new();
        for row in rows {
            latest.insert(row.author_id, row.verdict);
        }
        let verdicts: Vec<(String, Verdict)> = latest.into_iter().collect();
        Ok(approvals_missing(settings, &pull.author.id, &verdicts))
    }

    pub(crate) async fn get_settings(&self, a: ViewArgs) -> Result<Outcome<RepoSettings>> {
        let repo = match self.repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        Ok(Outcome::Ok(self.settings(&repo.id).await?))
    }

    pub(crate) async fn update_settings(
        &self,
        a: UpdateSettingsArgs,
    ) -> Result<Outcome<RepoSettings>> {
        let repo = match self.repo(&a.repo, &Some(a.actor.clone())).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified || !a.actor.is_member(&repo.namespace) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only members of the workspace can change a repository's settings.",
            ));
        }
        let settings = RepoSettings {
            required_approvals: a.settings.required_approvals.min(MAX_REQUIRED_APPROVALS),
            max_revisions: a.settings.max_revisions.min(MAX_REVISIONS),
            updated_by: Some(a.actor.username),
            updated_at: Some(rfc3339(now_ms())),
            ..a.settings
        };
        self.db
            .prepare(
                "INSERT INTO repo_settings
                   (repo_id, auto_merge, require_up_to_date, required_approvals,
                    count_agent_approvals, allow_ignoring_checks, agent_review, max_revisions,
                    merge_queue, updated_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (repo_id) DO UPDATE SET
                   auto_merge = excluded.auto_merge,
                   require_up_to_date = excluded.require_up_to_date,
                   required_approvals = excluded.required_approvals,
                   count_agent_approvals = excluded.count_agent_approvals,
                   allow_ignoring_checks = excluded.allow_ignoring_checks,
                   agent_review = excluded.agent_review,
                   max_revisions = excluded.max_revisions,
                   merge_queue = excluded.merge_queue,
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
                settings.updated_by.as_deref().unwrap_or_default().into(),
                settings.updated_at.as_deref().unwrap_or_default().into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(settings))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verdicts(list: &[(&str, Verdict)]) -> Vec<(String, Verdict)> {
        list.iter()
            .map(|(reviewer, verdict)| ((*reviewer).to_owned(), *verdict))
            .collect()
    }

    fn requiring(approvals: u32) -> RepoSettings {
        RepoSettings {
            required_approvals: approvals,
            ..RepoSettings::default()
        }
    }

    #[test]
    fn nothing_is_required_by_default() {
        assert_eq!(
            approvals_missing(&RepoSettings::default(), "usr_a", &[]),
            None
        );
    }

    #[test]
    fn approvals_are_counted_per_reviewer_and_not_from_the_author() {
        let one = requiring(1);
        assert!(approvals_missing(&one, "usr_a", &[]).is_some());
        let own = verdicts(&[("usr_a", Verdict::Approve)]);
        assert!(approvals_missing(&one, "usr_a", &own).is_some());
        let other = verdicts(&[("usr_b", Verdict::Approve)]);
        assert_eq!(approvals_missing(&one, "usr_a", &other), None);
        assert!(approvals_missing(&requiring(2), "usr_a", &other).is_some());
    }

    #[test]
    fn a_request_for_changes_blocks_whatever_else_was_approved() {
        let mixed = verdicts(&[
            ("usr_b", Verdict::Approve),
            ("usr_c", Verdict::RequestChanges),
        ]);
        assert_eq!(
            approvals_missing(&requiring(1), "usr_a", &mixed).as_deref(),
            Some("A reviewer has asked for changes.")
        );
    }

    #[test]
    fn an_agents_approval_counts_only_where_the_repository_lets_it() {
        let agent = verdicts(&[(AGENT_ID, Verdict::Approve)]);
        assert_eq!(approvals_missing(&requiring(1), "usr_a", &agent), None);
        let people_only = RepoSettings {
            count_agent_approvals: false,
            ..requiring(1)
        };
        assert!(approvals_missing(&people_only, "usr_a", &agent).is_some());
    }
}
