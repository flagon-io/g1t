//! Steering: people send the agent at work on a pull request a message,
//! and the agent receives it at its next step. The sandbox asks for
//! undelivered messages after each of the agent's tool calls.

use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;

/// The longest message an agent is sent.
const MAX_MESSAGE_CHARS: usize = 4000;

#[derive(Deserialize)]
struct MessageRow {
    id: String,
    author_name: String,
    body: String,
    created_at: String,
    delivered_at: Option<String>,
}

impl From<MessageRow> for AgentMessage {
    fn from(row: MessageRow) -> Self {
        AgentMessage {
            id: row.id,
            author: row.author_name,
            body: row.body,
            created_at: row.created_at,
            delivered_at: row.delivered_at,
        }
    }
}

impl Work {
    /// Every message sent to the agent on a pull request, oldest first.
    pub(crate) async fn messages(&self, pull_id: &str) -> Result<Vec<AgentMessage>> {
        Ok(self
            .db
            .prepare("SELECT * FROM agent_messages WHERE pull_id = ? ORDER BY created_at, id")
            .bind(&[pull_id.into()])?
            .all()
            .await?
            .results::<MessageRow>()?
            .into_iter()
            .map(AgentMessage::from)
            .collect())
    }

    pub(crate) async fn message_agent(&self, a: MessageAgentArgs) -> Result<Outcome<AgentMessage>> {
        let viewer = Some(a.actor.clone());
        let (repo, pull) = match self.pull_at(&a.repo, a.number, &viewer).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified
            || (pull.author.id != a.actor.id && !a.actor.is_member(&repo.namespace))
        {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only the pull request's author and members of the workspace can message its agent.",
            ));
        }
        if !pull.status.is_active() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This pull request is no longer being worked on.",
            ));
        }
        let body = a.body.trim();
        if body.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Write a message."));
        }
        let body: String = body.chars().take(MAX_MESSAGE_CHARS).collect();
        let now = now_ms();
        let message = AgentMessage {
            id: new_id("msg", now),
            author: a.actor.username.clone(),
            body,
            created_at: rfc3339(now),
            delivered_at: None,
        };
        self.db
            .prepare(
                "INSERT INTO agent_messages (id, pull_id, author_id, author_name, body, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                message.id.as_str().into(),
                pull.id.as_str().into(),
                a.actor.id.as_str().into(),
                message.author.as_str().into(),
                message.body.as_str().into(),
                message.created_at.as_str().into(),
            ])?
            .run()
            .await?;
        self.note(
            &repo.id,
            pull.number,
            (a.actor.id.as_str(), a.actor.username.as_str()),
            "sent the agent a message",
        )
        .await?;
        Ok(Outcome::Ok(message))
    }

    /// The undelivered messages, marked delivered and recorded in the
    /// session, for the agent's sandbox.
    pub(crate) async fn take_messages(&self, a: TakeMessagesArgs) -> Result<Outcome<Vec<AgentMessage>>> {
        if a.actor.kind != PrincipalKind::Agent {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only g1t's agents take messages.",
            ));
        }
        let viewer = Some(a.actor.clone());
        let (_, pull) = match self.pull_at(&a.repo, a.number, &viewer).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let now = rfc3339(now_ms());
        let taken: Vec<AgentMessage> = self
            .db
            .prepare(
                "UPDATE agent_messages SET delivered_at = ?
                 WHERE pull_id = ? AND delivered_at IS NULL
                 RETURNING *",
            )
            .bind(&[now.as_str().into(), pull.id.as_str().into()])?
            .all()
            .await?
            .results::<MessageRow>()?
            .into_iter()
            .map(AgentMessage::from)
            .collect();
        if !taken.is_empty() {
            let entries: Vec<NewSessionEntry> = taken
                .iter()
                .map(|message| NewSessionEntry {
                    kind: SessionEntryKind::Prompt,
                    text: format!("Message from {}: {}", message.author, message.body),
                    tool: None,
                    commit: None,
                })
                .collect();
            self.append_entries(&pull, &entries).await?;
        }
        Ok(Outcome::Ok(taken))
    }
}
