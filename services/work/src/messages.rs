//! Messages to agents at work. People steer the agent on a pull request;
//! agents ask each other questions and hand each other work, and answer.
//! Each reaches its agent at the agent's next step: the sandbox asks for
//! undelivered messages after each tool call and before it stops.

use g1t_contracts::access::Capability;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;

/// The longest message an agent is sent.
const MAX_MESSAGE_CHARS: usize = 4000;

/// Kinds an agent may send another.
const ASKS: [&str; 2] = ["question", "handoff"];

/// How long an agent woken to answer holds its pull request: nothing else
/// starts on it meanwhile. Answering everything lets go sooner.
const ANSWER_MINUTES: u64 = 20;

#[derive(Deserialize)]
struct MessageRow {
    id: String,
    #[allow(dead_code)]
    pull_id: String,
    author_name: String,
    body: String,
    created_at: String,
    delivered_at: Option<String>,
    kind: String,
    from_number: Option<u32>,
    to_number: Option<u32>,
    answer: Option<String>,
    declined: u32,
}

impl From<MessageRow> for AgentMessage {
    fn from(row: MessageRow) -> Self {
        AgentMessage {
            id: row.id,
            author: row.author_name,
            body: row.body,
            created_at: row.created_at,
            delivered_at: row.delivered_at,
            kind: row.kind,
            from_number: row.from_number,
            to_number: row.to_number.unwrap_or_default(),
            answer: row.answer,
            declined: row.declined != 0,
            hint: None,
        }
    }
}

/// Who sent a message, in a sentence's words.
fn sender(message: &AgentMessage) -> String {
    match message.from_number {
        Some(number) => format!("the agent on #{number}"),
        None => message.author.clone(),
    }
}

impl Work {
    pub(crate) async fn locate_pull(&self, a: LocatePullArgs) -> Result<Outcome<LocatedPull>> {
        let missing = || Outcome::fail(FailureCode::NotFound, "Pull request not found.");
        let Some(pull) = self.pull_by_id(&a.id).await? else {
            return Ok(missing());
        };
        let repo: Outcome<g1t_contracts::repos::Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &g1t_contracts::repos::GetByIdArgs {
                id: pull.repo_id.clone(),
                viewer: a.viewer,
            },
        )
        .await?;
        let Outcome::Ok(repo) = repo else {
            return Ok(missing());
        };
        Ok(Outcome::Ok(LocatedPull {
            repo: g1t_contracts::repos::RepoPath {
                namespace: repo.namespace,
                name: repo.name,
            },
            number: pull.number,
            title: pull.title,
            status: pull.status,
        }))
    }

    /// Every message sent to the agent on a pull request, oldest first.
    pub(crate) async fn messages(&self, pull_id: &str) -> Result<Vec<AgentMessage>> {
        if let Some(found) = self.prefetched_pull(pull_id) {
            return Ok(found
                .rows::<MessageRow>(crate::prefetch::Slot::Messages)?
                .into_iter()
                .map(AgentMessage::from)
                .collect());
        }
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
        if let Outcome::Fail(failure) = crate::retired::writable(&repo) {
            return Ok(Outcome::Fail(failure));
        }
        let from_agent = a.actor.kind == PrincipalKind::Agent;
        let kind = match (&a.kind, from_agent) {
            (Some(kind), true) if ASKS.contains(&kind.as_str()) => kind.clone(),
            (None, true) => "question".to_owned(),
            (_, true) => {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    "An agent sends a question or a handoff.",
                ));
            }
            (_, false) => "message".to_owned(),
        };
        if from_agent && a.from_number.is_none() {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Say which pull request you are working on, as from_number; it is where the answer goes.",
            ));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
        }
        // Its author may always steer it; anyone else puts compute to work.
        if pull.author.id != a.actor.id
            && let Outcome::Fail(failure) = crate::allowed(Some(&a.actor), &repo, Capability::Run)
        {
            return Ok(Outcome::Fail(failure));
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
        // An agent may name its issue rather than its pull request: the
        // answer goes to the issue's pull request that is still open.
        let from_number = match (from_agent, a.from_number) {
            (true, Some(from)) => match self.pull(&repo.id, from).await? {
                Some(_) => Some(from),
                None => self.db
                    .prepare(
                        "SELECT number AS value FROM pulls
                         WHERE repo_id = ? AND issue_number = ? AND status IN ('draft', 'open')
                         ORDER BY number DESC LIMIT 1",
                    )
                    .bind(&[repo.id.as_str().into(), from.into()])?
                    .first::<u32>(Some("value"))
                    .await?
                    .or(Some(from)),
            },
            _ => None,
        };
        if from_agent && from_number == Some(pull.number) {
            return Ok(Outcome::fail(FailureCode::Invalid, "That is your own pull request."));
        }
        // Whether the agent asked is at work now, to read it soon.
        let at_work = pull.status == PullStatus::Draft
            || self
                .db
                .prepare(
                    "SELECT 1 AS value FROM pulls
                     WHERE id = ? AND working_on = 'revision' AND working_until > ?",
                )
                .bind(&[pull.id.as_str().into(), rfc3339(now_ms()).into()])?
                .first::<u32>(Some("value"))
                .await?
                .is_some();
        let now = now_ms();
        let message = AgentMessage {
            id: new_id("msg", now),
            author: a.actor.username.clone(),
            body,
            created_at: rfc3339(now),
            delivered_at: None,
            kind,
            from_number,
            to_number: pull.number,
            answer: None,
            declined: false,
            hint: None,
        };
        self.insert_message(&repo.id, &pull.id, &a.actor.id, &message).await?;
        let mut message = message;
        if from_agent && !at_work {
            // An open pull request that g1t has not stopped on: its agent is
            // woken to answer (see `wake_for_messages`).
            let wakeable = pull.status == PullStatus::Open
                && self
                    .db
                    .prepare("SELECT 1 AS value FROM pulls WHERE id = ? AND stalled IS NULL")
                    .bind(&[pull.id.as_str().into()])?
                    .first::<u32>(Some("value"))
                    .await?
                    .is_some();
            message.hint = Some(if wakeable {
                self.publish("agent.asked", &repo.id, &a.actor, Self::pull_event(&pull)).await?;
                format!(
                    "The agent on #{} was not at work, so g1t is waking it to answer; the answer reaches you at a later step. Its change is there to read meanwhile: get_pull_request and get_pull_request_changes on #{}.",
                    pull.number, pull.number
                )
            } else {
                format!(
                    "The agent on #{} is not at work right now, so it will not answer soon. Its change is there to read: use get_pull_request and get_pull_request_changes on #{}, and decide from that.",
                    pull.number, pull.number
                )
            });
        }
        let said = match (message.kind.as_str(), message.from_number) {
            ("question", Some(from)) => format!("was asked a question by the agent on #{from}"),
            ("handoff", Some(from)) => format!("was handed work by the agent on #{from}"),
            _ => "sent the agent a message".to_owned(),
        };
        self.note(&repo.id, pull.number, (a.actor.id.as_str(), a.actor.username.as_str()), &said)
            .await?;
        Ok(Outcome::Ok(message))
    }

    async fn insert_message(
        &self,
        repo_id: &str,
        pull_id: &str,
        author_id: &str,
        message: &AgentMessage,
    ) -> Result<()> {
        self.db
            .prepare(
                "INSERT INTO agent_messages
                   (id, pull_id, repo_id, author_id, author_name, body, created_at, kind,
                    from_number, to_number)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                message.id.as_str().into(),
                pull_id.into(),
                repo_id.into(),
                author_id.into(),
                message.author.as_str().into(),
                message.body.as_str().into(),
                message.created_at.as_str().into(),
                message.kind.as_str().into(),
                message
                    .from_number
                    .map_or(worker::wasm_bindgen::JsValue::NULL, |n| n.into()),
                message.to_number.into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// The agent asked answers: the reply is recorded on the question and
    /// sent back to the asking agent as a message of its own.
    pub(crate) async fn answer_message(&self, a: AnswerMessageArgs) -> Result<Outcome<AgentMessage>> {
        let viewer = Some(a.actor.clone());
        let repo = match self.repo(&a.repo, &viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if let Outcome::Fail(failure) = crate::retired::writable(&repo) {
            return Ok(Outcome::Fail(failure));
        }
        if let Outcome::Fail(failure) = crate::allowed(Some(&a.actor), &repo, Capability::Run) {
            return Ok(Outcome::Fail(failure));
        }
        let row = self
            .db
            .prepare("SELECT * FROM agent_messages WHERE id = ? AND repo_id = ?")
            .bind(&[a.id.as_str().into(), repo.id.as_str().into()])?
            .first::<MessageRow>(None)
            .await?;
        let Some(row) = row else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such message."));
        };
        let mut asked = AgentMessage::from(row);
        if !ASKS.contains(&asked.kind.as_str()) {
            return Ok(Outcome::fail(FailureCode::Invalid, "Only a question or a handoff is answered."));
        }
        if asked.answer.is_some() {
            return Ok(Outcome::fail(FailureCode::Conflict, "It has been answered already."));
        }
        let body: String = a.body.trim().chars().take(MAX_MESSAGE_CHARS).collect();
        if body.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Write an answer."));
        }
        let now = now_ms();
        self.db
            .prepare("UPDATE agent_messages SET answer = ?, answered_at = ?, declined = ? WHERE id = ?")
            .bind(&[
                body.as_str().into(),
                rfc3339(now).into(),
                u32::from(a.decline).into(),
                asked.id.as_str().into(),
            ])?
            .run()
            .await?;
        asked.answer = Some(body.clone());
        asked.declined = a.decline;
        // An agent woken to answer lets go of its pull request once nothing
        // it was asked is left unanswered.
        self.db
            .prepare(
                "UPDATE pulls SET working_on = NULL, working_until = NULL
                 WHERE id = (SELECT pull_id FROM agent_messages WHERE id = ?1)
                   AND working_on = 'answer'
                   AND NOT EXISTS (
                     SELECT 1 FROM agent_messages
                     WHERE pull_id = pulls.id AND kind IN ('question', 'handoff') AND answer IS NULL)",
            )
            .bind(&[asked.id.as_str().into()])?
            .run()
            .await?;
        // Back to whoever asked: the agent on the other pull request.
        if let Some(from) = asked.from_number {
            if let Some(back) = self.pull(&repo.id, from).await?.filter(|pull| pull.status.is_active()) {
                let reply = AgentMessage {
                    id: new_id("msg", now),
                    author: a.actor.username.clone(),
                    body: if a.decline { format!("Declined: {body}") } else { body },
                    created_at: rfc3339(now),
                    delivered_at: None,
                    kind: "answer".to_owned(),
                    from_number: Some(asked.to_number),
                    to_number: from,
                    answer: None,
                    declined: a.decline,
                    hint: None,
                };
                self.insert_message(&repo.id, &back.id, &a.actor.id, &reply).await?;
            }
            let said = if asked.kind == "handoff" {
                if a.decline { "declined the handoff from" } else { "took on the handoff from" }
            } else {
                "answered the question from"
            };
            self.note(
                &repo.id,
                asked.to_number,
                (a.actor.id.as_str(), a.actor.username.as_str()),
                &format!("{said} the agent on #{from}"),
            )
            .await?;
        }
        Ok(Outcome::Ok(asked))
    }

    /// Questions, handoffs and answers between the agents on these pull
    /// requests, newest first.
    pub(crate) async fn exchanges(&self, repo_id: &str, numbers: &[u32]) -> Result<Vec<AgentMessage>> {
        if numbers.is_empty() {
            return Ok(Vec::new());
        }
        let rows = self
            .db
            .prepare(
                "SELECT * FROM agent_messages
                 WHERE repo_id = ? AND kind IN ('question', 'handoff')
                 ORDER BY created_at DESC LIMIT 50",
            )
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<MessageRow>()?;
        Ok(rows
            .into_iter()
            .map(AgentMessage::from)
            .filter(|message| {
                numbers.contains(&message.to_number)
                    || message.from_number.is_some_and(|from| numbers.contains(&from))
            })
            .collect())
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
        Ok(Outcome::Ok(self.deliver(&pull).await?))
    }

    /// Wakes the agent on a pull request to answer what it was asked while
    /// it was not at work: claims a short step, and hands over its messages.
    pub(crate) async fn wake_for_messages(&self, a: WakeForMessagesArgs) -> Result<Option<Wake>> {
        let Some(pull) = self.pull_by_id(&a.pull_id).await? else {
            return Ok(None);
        };
        // Only another agent's question or handoff wakes it; what people
        // say waits for its next step.
        let waiting = self
            .db
            .prepare(
                "SELECT 1 AS value FROM agent_messages
                 WHERE pull_id = ? AND delivered_at IS NULL AND kind IN ('question', 'handoff')
                 LIMIT 1",
            )
            .bind(&[pull.id.as_str().into()])?
            .first::<u32>(Some("value"))
            .await?
            .is_some();
        if !waiting || !self.claim(&pull.id, "answer", ANSWER_MINUTES, false).await? {
            return Ok(None);
        }
        let repo: Outcome<g1t_contracts::repos::Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &g1t_contracts::repos::GetByIdArgs {
                id: pull.repo_id.clone(),
                viewer: self.author_viewer(&pull).await?,
            },
        )
        .await?;
        let Outcome::Ok(repo) = crate::retired::unless_archived(repo) else {
            return Ok(None);
        };
        let path = g1t_contracts::repos::RepoPath {
            namespace: repo.namespace,
            name: repo.name,
        };
        let issue = match pull.issue {
            Some(number) => self.issue(&pull.repo_id, number).await?,
            None => None,
        };
        let messages = self.deliver(&pull).await?;
        let asking: Vec<String> = messages
            .iter()
            .filter_map(|message| message.from_number.map(|from| format!("#{from}")))
            .collect();
        self.note(
            &pull.repo_id,
            pull.number,
            (crate::lifecycle::POLICY_ACTOR_ID, crate::lifecycle::POLICY_ACTOR_NAME),
            &format!("woke g1t to answer the agent on {}", asking.join(", ")),
        )
        .await?;
        Ok(Some(Wake {
            job: LifecycleJob {
                pull_id: pull.id,
                source: pull.fork.unwrap_or_else(|| path.clone()),
                repo: path,
                number: pull.number,
                author: pull.author,
                branch: pull.branch,
                default_branch: repo.default_branch,
                title: pull.title,
                description: pull.body.unwrap_or_default(),
                issue,
                feedback: String::new(),
                round: 0,
            },
            messages,
        }))
    }

    /// Marks a pull request's undelivered messages delivered, records them
    /// in its session, and returns them, oldest first.
    async fn deliver(&self, pull: &Pull) -> Result<Vec<AgentMessage>> {
        let now = rfc3339(now_ms());
        let mut taken: Vec<AgentMessage> = self
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
        taken.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        if !taken.is_empty() {
            let entries: Vec<NewSessionEntry> = taken
                .iter()
                .map(|message| NewSessionEntry {
                    kind: SessionEntryKind::Prompt,
                    text: match message.kind.as_str() {
                        "question" => format!("Question from {} ({}): {}", sender(message), message.id, message.body),
                        "handoff" => format!("Work handed over by {} ({}): {}", sender(message), message.id, message.body),
                        "answer" => format!("Answer from {}: {}", sender(message), message.body),
                        _ => format!("Message from {}: {}", message.author, message.body),
                    },
                    tool: None,
                    commit: None,
                })
                .collect();
            self.append_entries(pull, &entries).await?;
        }
        Ok(taken)
    }
}
