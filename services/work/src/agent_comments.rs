//! A workspace's own agents (Margo, @margo) commenting on issues and pull
//! requests, and reviewing pull requests, as themselves, on behalf of a
//! person whose access caps them. The agents service calls these; nothing
//! reaches them with a person's token.
//!
//! What an agent writes is stored with the agent as its author and the
//! person it acted for beside it (migrations/0033_agent_comments.sql). Its
//! review is advisory: the verdict is kept in `agent_verdict`, never in
//! `verdict`, which every rule about approvals reads (required approvals
//! in mergeability.rs and rulesets.rs through the `Verdicts` prefetch,
//! a person's request for changes in lifecycle.rs `person_request`,
//! confidence.rs, contributions.rs), and code owners skip it by name
//! (codeowners.rs `latest_verdicts`). So it never satisfies a required
//! approval or a code owner, and never blocks a merge.

use g1t_contracts::credentials::Principal;
use g1t_contracts::events::CommentCreated;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::retired::writable;
use crate::{MAX_ENTRY_CHARS, UNVERIFIED, Work};

/// What an agent may write where, before anything is read: why not, or none.
fn refusal(agent: &AgentRef, body: &str, verdict: Option<AgentVerdict>) -> Option<&'static str> {
    if agent.id.trim().is_empty() || agent.handle.trim().is_empty() {
        return Some("Name the agent: its id and handle.");
    }
    // An approval speaks for itself; anything else has to say something.
    if body.is_empty() && verdict != Some(AgentVerdict::Approve) {
        return Some("A comment cannot be empty.");
    }
    if body.chars().count() > MAX_ENTRY_CHARS {
        return Some("That comment is too long.");
    }
    None
}

/// Why an agent may not review a pull request as it stands, or none.
fn review_refusal(status: PullStatus) -> Option<&'static str> {
    match status {
        PullStatus::Open => None,
        PullStatus::Draft => Some("A draft is still being worked on; an agent reviews it once it is ready for review."),
        PullStatus::Merged | PullStatus::Closed => Some("Only an open pull request can be reviewed."),
    }
}

/// Whether an agent that wrote `written` times on one issue or pull request
/// in the last hour may write again.
fn within_limit(written: u32) -> bool {
    written < AGENT_COMMENTS_PER_WINDOW
}

#[derive(Deserialize)]
struct Count {
    n: u32,
}

impl Work {
    /// `workspace_agent_comment`.
    pub(crate) async fn workspace_agent_comment(&self, a: WorkspaceAgentCommentArgs) -> Result<Outcome<Comment>> {
        self.agent_writes(a.repo, a.number, a.agent, a.acting_for, a.body, None).await
    }

    /// `workspace_agent_review`.
    pub(crate) async fn workspace_agent_review(&self, a: WorkspaceAgentReviewArgs) -> Result<Outcome<Comment>> {
        self.agent_writes(a.repo, a.number, a.agent, a.acting_for, a.body, Some(a.verdict)).await
    }

    /// A comment, or with `verdict` a review, by `agent` as itself on
    /// behalf of `acting_for`, with the checks a person's comment has.
    async fn agent_writes(
        &self,
        path: g1t_contracts::repos::RepoPath,
        number: u32,
        agent: AgentRef,
        acting_for: User,
        body: String,
        verdict: Option<AgentVerdict>,
    ) -> Result<Outcome<Comment>> {
        let body = body.trim();
        if let Some(refused) = refusal(&agent, body, verdict) {
            return Ok(Outcome::fail(FailureCode::Invalid, refused));
        }
        // The person it acts for, as if they wrote it themselves.
        if !acting_for.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let repo = match self.repo(&path, &Some(acting_for.clone())).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if let Outcome::Fail(failure) = writable(&repo) {
            return Ok(Outcome::Fail(failure));
        }
        let mut pull_id = None;
        let table = if self.issue(&repo.id, number).await?.is_some() {
            if verdict.is_some() {
                return Ok(Outcome::fail(FailureCode::Invalid, "Only a pull request can be reviewed."));
            }
            "issues"
        } else if let Some(pull) = self.pull(&repo.id, number).await? {
            if verdict.is_some()
                && let Some(refused) = review_refusal(pull.status)
            {
                return Ok(Outcome::fail(FailureCode::Conflict, refused));
            }
            // A command to g1t on a dependency update it opened is a
            // person's to give, never an agent's.
            if pull.author.is_system() && g1t_contracts::updates::update_command(body).is_some() {
                return Ok(Outcome::fail(
                    FailureCode::Forbidden,
                    "An agent cannot give commands on g1t's dependency updates; ask a person with the Write role.",
                ));
            }
            pull_id = Some(pull.id.clone());
            "pulls"
        } else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No issue or pull request has that number."));
        };

        let now = now_ms();
        let written = self
            .db
            .prepare(
                "SELECT count(*) AS n FROM comments
                 WHERE agent_id = ? AND repo_id = ? AND number = ? AND created_at >= ?",
            )
            .bind(&[
                agent.id.as_str().into(),
                repo.id.as_str().into(),
                number.into(),
                rfc3339(now.saturating_sub(AGENT_COMMENT_WINDOW_MS)).into(),
            ])?
            .first::<Count>(None)
            .await?
            .map_or(0, |count| count.n);
        if !within_limit(written) {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!(
                    "@{} has written {AGENT_COMMENTS_PER_WINDOW} times on #{number} in the last hour; it can write again later.",
                    agent.handle
                ),
            ));
        }

        let comment = Comment {
            id: new_id("cmt", now),
            kind: CommentKind::Comment,
            author: User {
                id: agent.id.clone(),
                username: agent.handle.clone(),
                kind: PrincipalKind::Agent,
                ..User::default()
            },
            body: body.to_owned(),
            path: None,
            line: None,
            verdict: verdict.and_then(AgentVerdict::verdict),
            created_at: rfc3339(now),
            edited_at: None,
            acting_for: Some(User {
                id: acting_for.id.clone(),
                username: acting_for.username.clone(),
                ..User::default()
            }),
            advisory: verdict.is_some(),
            agent: Some(agent.clone()),
        };
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO comments
                           (id, repo_id, number, author_id, author_name, body, created_at,
                            agent_id, agent_handle, agent_name, agent_avatar_seed,
                            acting_for_id, acting_for_name, agent_verdict)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        comment.id.as_str().into(),
                        repo.id.as_str().into(),
                        number.into(),
                        agent.id.as_str().into(),
                        agent.handle.as_str().into(),
                        body.into(),
                        comment.created_at.as_str().into(),
                        agent.id.as_str().into(),
                        agent.handle.as_str().into(),
                        agent.display_name.as_str().into(),
                        agent.avatar_seed.as_str().into(),
                        acting_for.id.as_str().into(),
                        acting_for.username.as_str().into(),
                        verdict.map_or(JsValue::NULL, |verdict| verdict.as_str().into()),
                    ])?,
                self.db
                    .prepare(format!("UPDATE {table} SET updated_at = ? WHERE repo_id = ? AND number = ?"))
                    .bind(&[comment.created_at.as_str().into(), repo.id.as_str().into(), number.into()])?,
            ])
            .await?;
        // What an agent says never summons g1t (mentions.rs `may_summon`),
        // so no mention is recorded. The event is the person's doing, as
        // their own comment's would be, with the agent named on it.
        self.publish(
            "comment.created",
            &repo.id,
            &acting_for,
            CommentCreated {
                comment_id: comment.id.clone(),
                repo_id: repo.id.clone(),
                number,
                pull_id,
                verdict: comment.verdict,
                agent: Some(agent),
                acting_for: Some(Principal::from(&acting_for)),
                advisory: comment.advisory,
            },
        )
        .await?;
        Ok(Outcome::Ok(comment))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn margo() -> AgentRef {
        AgentRef {
            id: "agt_1".into(),
            handle: "margo".into(),
            display_name: "Margo".into(),
            avatar_seed: "margo".into(),
        }
    }

    #[test]
    fn an_agent_says_something_unless_it_approves() {
        assert_eq!(refusal(&margo(), "", None), Some("A comment cannot be empty."));
        assert_eq!(refusal(&margo(), "", Some(AgentVerdict::Comment)), Some("A comment cannot be empty."));
        assert_eq!(refusal(&margo(), "", Some(AgentVerdict::RequestChanges)), Some("A comment cannot be empty."));
        assert_eq!(refusal(&margo(), "", Some(AgentVerdict::Approve)), None);
        assert_eq!(refusal(&margo(), "Looks right.", None), None);
        let nobody = AgentRef { handle: String::new(), ..margo() };
        assert!(refusal(&nobody, "hi", None).is_some());
    }

    #[test]
    fn an_agent_reviews_only_what_is_ready() {
        assert_eq!(review_refusal(PullStatus::Open), None);
        assert!(review_refusal(PullStatus::Draft).is_some());
        assert!(review_refusal(PullStatus::Merged).is_some());
        assert!(review_refusal(PullStatus::Closed).is_some());
    }

    #[test]
    fn five_an_hour_on_one_pull_request() {
        assert!(within_limit(0));
        assert!(within_limit(4));
        assert!(!within_limit(5));
    }

    #[test]
    fn the_wire_reads_snake_case_and_comments_read_camel_case() {
        let asked: WorkspaceAgentReviewArgs = serde_json::from_value(serde_json::json!({
            "repo": { "namespace": "acme", "name": "web" },
            "number": 7,
            "agent": { "id": "agt_1", "handle": "margo", "display_name": "Margo", "avatar_seed": "margo" },
            "acting_for": { "id": "usr_1", "username": "ana" },
            "verdict": "request_changes",
            "body": "Trim the name."
        }))
        .unwrap();
        assert_eq!(asked.verdict, AgentVerdict::RequestChanges);
        assert_eq!(asked.agent, margo());
        let shown = serde_json::to_value(&asked.agent).unwrap();
        assert_eq!(shown["displayName"], "Margo");
        assert_eq!(shown["avatarSeed"], "margo");
    }

    #[test]
    fn an_agent_review_shows_its_verdict_but_is_advisory() {
        let row: crate::rows::CommentRow = serde_json::from_value(serde_json::json!({
            "id": "cmt_1", "kind": "comment", "author_id": "agt_1", "author_name": "margo",
            "body": "Ship it.", "path": null, "line": null, "verdict": null, "created_at": "2026-10-09T00:00:00Z",
            "agent_id": "agt_1", "agent_handle": "margo", "agent_name": "Margo", "agent_avatar_seed": "m",
            "acting_for_id": "usr_1", "acting_for_name": "ana", "agent_verdict": "approve"
        }))
        .unwrap();
        assert_eq!(row.answerable_id(), "usr_1");
        assert!(row.has_verdict());
        let comment = Comment::from(row);
        assert_eq!(comment.verdict, Some(Verdict::Approve));
        assert!(comment.advisory);
        assert_eq!(comment.author.kind, PrincipalKind::Agent);
        assert_eq!(comment.answerable().username, "ana");
        assert_eq!(comment.agent.unwrap().display_name, "Margo");
    }
}
