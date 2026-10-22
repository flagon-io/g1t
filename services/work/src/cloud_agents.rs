//! Cloud agents' work, counted as the work of whoever started it.
//!
//! A coding agent g1t did not start leaves its mark on the commits it
//! makes: GitHub's cloud agent (Copilot) commits as itself with an
//! `Agent-Logs-Url` trailer and the person who gave it the task as
//! co-author; Cursor's cloud agents commit with Cursor's address beside
//! the person's; Devin commits as itself, as the person, or both; Claude
//! Code writes its address as co-author, and a `Claude-Session` trailer
//! from the cloud. `coding_agents::agent_mark` reads those conventions,
//! strongest rule first, and names the address of the person the work
//! counts for.
//!
//! Here g1t keeps what they say:
//! - a pull request whose commits a rule matched records the rule, the
//!   agent and the member it counts for (`pulls.agent_rule`, ...), read
//!   when a pull request opens and when a push moves its head;
//! - a commit a push brings straight to a default branch, outside any pull
//!   request, is recorded in `agent_commits`.
//!
//! Signals (signals/base.sql) count both as agents' work: the pull request
//! as an agent's merge whose owner is the person who started the agent
//! (unless someone asked for it), the commit as an agent's direct commit.
//! A harness session g1t records stays the stronger tie: a pull request a
//! session is tied to says `session`, and a commit a session recorded, or
//! one whose `G1t-Session` trailer names a session, counts once, as the
//! session's.
//!
//! The person is matched only through an address a member of the
//! repository's workspace has verified (identity `members_by_email`),
//! never by a name. A GitHub noreply address
//! (`123+login@users.noreply.github.com`) is nobody's until identity can
//! match it to the GitHub account a member linked. Unmatched, the work
//! still counts as an agent's, for nobody in particular.

use std::collections::HashMap;

use g1t_contracts::Outcome;
use g1t_contracts::coding_agents::{AgentMark, agent_mark};
use g1t_contracts::identity::{MemberEmail, MembersByEmailArgs};
use g1t_contracts::repos::PushedCommit;
use g1t_contracts::rules::{InspectCommitsArgs, InspectedCommits};
use g1t_contracts::work::{Pull, session_trailers};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;

/// How many of a pull request's commits are read for an agent's mark.
const PULL_COMMITS: u32 = 250;

/// Records a pull request's agent's mark, unless it has one.
const MARK_PULL: &str =
    "UPDATE pulls SET agent_rule = ?2, agent_name = ?3, agent_by_id = ?4, agent_by_name = ?5
     WHERE id = ?1 AND agent_rule IS NULL";

/// Records a coding agent's commit pushed straight to a default branch,
/// once.
const RECORD_COMMIT: &str =
    "INSERT INTO agent_commits (repo_id, sha, agent, rule, person_id, person_name, at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (repo_id, sha) DO NOTHING";

/// How strong a rule is: lower is stronger. A cloud agent's own trailer
/// says the most, its address as author more than as co-author, and a
/// line anyone can type the least.
fn strength(rule: &str) -> u8 {
    match rule.split_once(':').map_or(rule, |(kind, _)| kind) {
        "trailer" if rule == "trailer:made-with-cursor" => 4,
        "trailer" => 0,
        "author" => 1,
        "coauthor" => 2,
        _ => 5,
    }
}

/// The mark a pull request's commits (oldest first, merge commits left
/// out by the caller), as `(message, author address)`, leave: the
/// strongest rule any of them matched, the oldest commit of those.
pub(crate) fn pull_mark<'a>(
    commits: impl IntoIterator<Item = (&'a str, Option<&'a str>)>,
) -> Option<AgentMark> {
    let mut best: Option<AgentMark> = None;
    for (message, author) in commits {
        let Some(mark) = agent_mark(message, author) else {
            continue;
        };
        if best
            .as_ref()
            .is_none_or(|best| strength(&mark.rule) < strength(&best.rule))
        {
            best = Some(mark);
        }
    }
    best
}

/// The commits a push brought that a coding agent made, each with its
/// mark: not those whose `G1t-Session` trailer names a session, which
/// count as that session's.
pub(crate) fn pushed_marks(commits: &[PushedCommit]) -> Vec<(&str, AgentMark)> {
    commits
        .iter()
        .filter(|commit| session_trailers(&commit.message).is_empty())
        .filter_map(|commit| {
            Some((
                commit.hash.as_str(),
                agent_mark(&commit.message, commit.author_email.as_deref())?,
            ))
        })
        .collect()
}

impl Work {
    /// Reads a pull request's commits for a coding agent's mark, and
    /// records the first it finds. `merge_base`, when known, saves reading
    /// both histories again. Never fails what called it: a problem is
    /// logged.
    pub(crate) async fn mark_agent_pull(&self, pull: &Pull, merge_base: Option<String>) {
        if pull.agent_work.is_some() || !pull.status.is_active() {
            return;
        }
        let Some(head) = pull.head_commit.clone() else {
            return;
        };
        let marked = async {
            let found: Outcome<InspectedCommits> = g1t_kit::call(
                &self.repos,
                "inspect_commits",
                &InspectCommitsArgs {
                    source_id: pull.source_id().to_owned(),
                    head,
                    target_id: pull.repo_id.clone(),
                    base_branch: pull.base.clone().unwrap_or_default(),
                    limit: Some(PULL_COMMITS),
                    merge_base,
                    messages_only: true,
                },
            )
            .await?;
            let Outcome::Ok(inspected) = found else {
                return Ok(());
            };
            // Newest first as read; the oldest that says the most wins.
            let Some(mark) = pull_mark(
                inspected
                    .commits
                    .iter()
                    .rev()
                    .filter(|commit| commit.parents <= 1)
                    .map(|commit| (commit.message.as_str(), commit.author_email.as_deref())),
            ) else {
                return Ok(());
            };
            let people = self
                .starters(&pull.repo_id, mark.starter.iter().cloned().collect())
                .await?;
            let person = mark
                .starter
                .as_ref()
                .and_then(|address| people.get(address));
            self.db
                .prepare(MARK_PULL)
                .bind(&[
                    pull.id.as_str().into(),
                    mark.rule.as_str().into(),
                    mark.agent.into(),
                    person.map_or(JsValue::NULL, |member| member.user_id.as_str().into()),
                    person.map_or(JsValue::NULL, |member| member.username.as_str().into()),
                ])?
                .run()
                .await?;
            Ok::<(), worker::Error>(())
        };
        if let Err(error) = marked.await {
            worker::console_warn!("agent's mark on {}: {error}", pull.id);
        }
    }

    /// Records the commits a push brought straight to a default branch,
    /// outside any pull request, that a coding agent made, at `at`.
    pub(crate) async fn record_agent_commits(
        &self,
        repo_id: &str,
        commits: &[PushedCommit],
        at: &str,
    ) -> Result<()> {
        let marks = pushed_marks(commits);
        if marks.is_empty() {
            return Ok(());
        }
        let mut addresses: Vec<String> = Vec::new();
        for (_, mark) in &marks {
            if let Some(address) = &mark.starter
                && !addresses.contains(address)
            {
                addresses.push(address.clone());
            }
        }
        let people = self.starters(repo_id, addresses).await?;
        let mut statements = Vec::new();
        for (sha, mark) in &marks {
            let person = mark
                .starter
                .as_ref()
                .and_then(|address| people.get(address));
            statements.push(self.db.prepare(RECORD_COMMIT).bind(&[
                repo_id.into(),
                (*sha).into(),
                mark.agent.into(),
                mark.rule.as_str().into(),
                person.map_or(JsValue::NULL, |member| member.user_id.as_str().into()),
                person.map_or(JsValue::NULL, |member| member.username.as_str().into()),
                at.into(),
            ])?);
        }
        self.db.batch(statements).await?;
        Ok(())
    }

    /// The members of a repository's workspace behind these addresses, by
    /// address: only an address a member verified is anyone's.
    async fn starters(
        &self,
        repo_id: &str,
        emails: Vec<String>,
    ) -> Result<HashMap<String, MemberEmail>> {
        if emails.is_empty() {
            return Ok(HashMap::new());
        }
        let Some(workspace) = crate::items::repo_workspace(self, repo_id).await? else {
            return Ok(HashMap::new());
        };
        let members: Vec<MemberEmail> = g1t_kit::call(
            &self.identity,
            "members_by_email",
            &MembersByEmailArgs { workspace, emails },
        )
        .await?;
        Ok(members
            .into_iter()
            .map(|member| (member.email.clone(), member))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{OptionalExtension, params};

    use super::*;

    fn commit(hash: &str, message: &str, author: &str) -> PushedCommit {
        PushedCommit {
            hash: hash.into(),
            message: message.into(),
            author_email: Some(author.into()),
        }
    }

    const COPILOT: &str = "198982749+Copilot@users.noreply.github.com";

    #[test]
    fn a_pull_request_takes_the_strongest_mark_of_its_commits() {
        let commits = [
            (
                "Start\n\nCo-authored-by: Cursor <cursoragent@cursor.com>",
                Some("bo@example.com"),
            ),
            ("Plain", Some("ada@example.com")),
            (
                "Retry\n\nCo-authored-by: Ada <ada@example.com>\nAgent-Logs-Url: https://github.com/a/b/sessions/1",
                Some(COPILOT),
            ),
            (
                "Again\n\nCo-authored-by: Cy <cy@example.com>\nAgent-Logs-Url: https://github.com/a/b/sessions/2",
                Some(COPILOT),
            ),
        ];
        let mark = pull_mark(commits).unwrap();
        // Copilot's trailer says more than Cursor as co-author; of its two
        // commits, the oldest names whose it is.
        assert_eq!(
            (mark.agent, mark.rule.as_str(), mark.starter.as_deref()),
            ("copilot", "trailer:agent-logs-url", Some("ada@example.com"))
        );
        assert_eq!(pull_mark([("Plain", Some("ada@example.com"))]), None);
        let typed = pull_mark([
            ("A\n\nMade with Cursor", Some("ada@example.com")),
            (
                "B\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
                Some("bo@example.com"),
            ),
        ]);
        assert_eq!(
            typed.map(|mark| mark.rule),
            Some("coauthor:claude".to_owned())
        );
    }

    #[test]
    fn a_session_s_commits_are_left_to_the_session() {
        let commits = [
            commit(
                "a",
                "Fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nG1t-Session: ses_01abc",
                "ada@example.com",
            ),
            commit(
                "b",
                "Fix more\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
                "ada@example.com",
            ),
            commit("c", "By hand", "ada@example.com"),
        ];
        let marks = pushed_marks(&commits);
        assert_eq!(marks.len(), 1);
        assert_eq!(
            (marks[0].0, marks[0].1.rule.as_str()),
            ("b", "coauthor:claude")
        );
    }

    #[test]
    fn a_pull_request_keeps_its_first_mark_and_a_commit_is_recorded_once() {
        let db = crate::migrated::database();
        db.execute(
            "INSERT INTO pulls (id, repo_id, number, title, agent, runtime, author_id, author_name, status, created_at, updated_at)
             VALUES ('pr_1', 'repo', 1, 'Change', 'person', 'external', 'usr_bot', 'bot', 'open', 'now', 'now')",
            [],
        )
        .unwrap();
        db.execute(
            MARK_PULL,
            params![
                "pr_1",
                "trailer:agent-logs-url",
                "copilot",
                "usr_ada",
                "ada"
            ],
        )
        .unwrap();
        db.execute(
            MARK_PULL,
            params!["pr_1", "coauthor:cursor", "cursor", "usr_bo", "bo"],
        )
        .unwrap();
        let kept: (String, String, String) = db
            .query_row(
                "SELECT agent_rule, agent_name, agent_by_name FROM pulls WHERE id = 'pr_1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            kept,
            (
                "trailer:agent-logs-url".into(),
                "copilot".into(),
                "ada".into()
            )
        );

        db.execute(
            RECORD_COMMIT,
            params![
                "repo",
                "c1",
                "cursor",
                "author:cursor",
                "usr_ada",
                "ada",
                "2026-10-20T10:00:00Z"
            ],
        )
        .unwrap();
        db.execute(
            RECORD_COMMIT,
            params![
                "repo",
                "c1",
                "claude",
                "coauthor:claude",
                None::<String>,
                None::<String>,
                "later"
            ],
        )
        .unwrap();
        let recorded: Option<(String, String)> = db
            .query_row(
                "SELECT rule, at FROM agent_commits WHERE repo_id = 'repo' AND sha = 'c1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .unwrap();
        assert_eq!(
            recorded,
            Some(("author:cursor".into(), "2026-10-20T10:00:00Z".into()))
        );
    }
}
