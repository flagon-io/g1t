//! The work service: intents, attempts and sessions.
//!
//! Other services reach it over `POST /rpc/<method>`; see
//! `g1t_contracts::work` for the methods and their arguments. It also
//! consumes its queue of events from the bus.

mod rows;

use g1t_contracts::events::{
    AttemptEvent, Delivered, IntentClosed, IntentOpened, NewEvent, SessionAppended,
};
use g1t_contracts::repos::{ForkArgs, GetArgs, GetByIdArgs, LandArgs, Landed, Repo};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, Viewer, new_id};
use g1t_kit::{args, js, now_ms, reply, rpc_method};
use serde::Serialize;
use worker::wasm_bindgen::JsValue;
use worker::{
    Context, D1Database, Env, Fetcher, MessageBatch, MessageExt, Request, Response, Result, event,
};

use rows::{AttemptRow, IntentRow, SessionRow};

const SOURCE: &str = "work";
const MAX_ENTRY_BATCH: usize = 200;
const MAX_ENTRY_CHARS: usize = 64_000;
const SESSION_PAGE: u32 = 500;
const UNVERIFIED: &str = "Confirm your email address first. Check your inbox, or resend the link from the banner on g1t.sh.";

const INTENT_COLUMNS: &str = "intents.*,
  (SELECT count(*) FROM attempts WHERE attempts.intent_id = intents.id) AS attempt_count";

fn no_intent<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Intent not found.")
}

fn no_attempt<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Attempt not found.")
}

fn optional(value: &Option<String>) -> JsValue {
    value.as_deref().map_or(JsValue::NULL, JsValue::from)
}

struct Work {
    db: D1Database,
    repos: Fetcher,
    /// The events service, an RPC stub.
    events: JsValue,
}

impl Work {
    async fn publish<T: Serialize>(&self, event: NewEvent<T>) -> Result<()> {
        js::call(&self.events, "publish", &[js::to_js(&[event])?]).await?;
        Ok(())
    }

    async fn repo_by_path(
        &self,
        path: &g1t_contracts::repos::RepoPath,
        viewer: &Viewer,
    ) -> Result<Outcome<Repo>> {
        g1t_kit::call(
            &self.repos,
            "get",
            &GetArgs {
                path: path.clone(),
                viewer: viewer.clone(),
            },
        )
        .await
    }

    async fn repo_by_id(&self, id: &str, viewer: &Viewer) -> Result<Outcome<Repo>> {
        g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: id.to_owned(),
                viewer: viewer.clone(),
            },
        )
        .await
    }

    async fn intent_by_id(&self, id: &str) -> Result<Option<Intent>> {
        Ok(self
            .db
            .prepare(format!("SELECT {INTENT_COLUMNS} FROM intents WHERE id = ?"))
            .bind(&[id.into()])?
            .first::<IntentRow>(None)
            .await?
            .map(Intent::from))
    }

    async fn attempt_by_id(&self, id: &str) -> Result<Option<Attempt>> {
        Ok(self
            .db
            .prepare("SELECT * FROM attempts WHERE id = ?")
            .bind(&[id.into()])?
            .first::<AttemptRow>(None)
            .await?
            .map(Attempt::from))
    }

    /// The attempt, if `actor` is the one running it.
    async fn own_attempt(&self, actor: &User, id: &str) -> Result<Outcome<Attempt>> {
        let Some(attempt) = self.attempt_by_id(id).await? else {
            return Ok(no_attempt());
        };
        // Reading it must be allowed before "forbidden" may reveal it exists.
        let viewer = Some(actor.clone());
        if let Outcome::Fail(_) = self.repo_by_id(&attempt.repo_id, &viewer).await? {
            return Ok(no_attempt());
        }
        if attempt.started_by.id != actor.id {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only the person who started an attempt can change it.",
            ));
        }
        Ok(Outcome::Ok(attempt))
    }

    fn attempt_event(attempt: &Attempt) -> AttemptEvent {
        AttemptEvent {
            attempt_id: attempt.id.clone(),
            intent_id: attempt.intent_id.clone(),
            repo_id: attempt.repo_id.clone(),
            ..AttemptEvent::default()
        }
    }

    async fn open_intent(&self, a: OpenIntentArgs) -> Result<Outcome<Intent>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let title = a.title.trim();
        if title.is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "An intent needs a title.",
            ));
        }
        let repo = match self.repo_by_path(&a.repo, &Some(a.actor.clone())).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let checks: Vec<&str> = a
            .checks
            .iter()
            .map(|check| check.trim())
            .filter(|check| !check.is_empty())
            .collect();

        let now = now_ms();
        let id = new_id("int", now);
        // Numbering and insert are one statement, so concurrent opens on the
        // same repo cannot take the same number.
        self.db
            .prepare(
                "INSERT INTO intents
                   (id, repo_id, number, title, brief, checks, author_id, author_name, created_at)
                 SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?
                 FROM intents WHERE repo_id = ?",
            )
            .bind(&[
                id.as_str().into(),
                repo.id.as_str().into(),
                title.into(),
                a.brief.trim().into(),
                serde_json::to_string(&checks)?.into(),
                a.actor.id.as_str().into(),
                a.actor.username.as_str().into(),
                rfc3339(now).into(),
                repo.id.as_str().into(),
            ])?
            .run()
            .await?;
        let Some(intent) = self.intent_by_id(&id).await? else {
            return Ok(no_intent());
        };
        self.publish(NewEvent {
            kind: "intent.opened",
            source: SOURCE,
            repo_id: Some(intent.repo_id.clone()),
            actor: Some(a.actor.id),
            data: IntentOpened {
                intent_id: intent.id.clone(),
                repo_id: intent.repo_id.clone(),
                number: intent.number,
                title: intent.title.clone(),
            },
        })
        .await?;
        Ok(Outcome::Ok(intent))
    }

    async fn list_intents(&self, a: ListIntentsArgs) -> Result<Outcome<Vec<Intent>>> {
        let repo = match self.repo_by_path(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let status = a
            .status
            .and_then(|status| serde_json::to_value(status).ok())
            .and_then(|value| value.as_str().map(str::to_owned));
        let rows = self
            .db
            .prepare(format!(
                "SELECT {INTENT_COLUMNS} FROM intents
                 WHERE repo_id = ? AND (? IS NULL OR status = ?)
                 ORDER BY number DESC LIMIT 100"
            ))
            .bind(&[repo.id.into(), optional(&status), optional(&status)])?
            .all()
            .await?
            .results::<IntentRow>()?;
        Ok(Outcome::Ok(rows.into_iter().map(Intent::from).collect()))
    }

    async fn get_intent(&self, a: GetIntentArgs) -> Result<Outcome<IntentDetail>> {
        let repo = match self.repo_by_path(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let row = self
            .db
            .prepare(format!(
                "SELECT {INTENT_COLUMNS} FROM intents WHERE repo_id = ? AND number = ?"
            ))
            .bind(&[repo.id.into(), a.number.into()])?
            .first::<IntentRow>(None)
            .await?;
        let Some(intent) = row.map(Intent::from) else {
            return Ok(no_intent());
        };
        let attempts = self
            .db
            .prepare("SELECT * FROM attempts WHERE intent_id = ? ORDER BY number")
            .bind(&[intent.id.as_str().into()])?
            .all()
            .await?
            .results::<AttemptRow>()?;
        Ok(Outcome::Ok(IntentDetail {
            intent,
            attempts: attempts.into_iter().map(Attempt::from).collect(),
        }))
    }

    async fn withdraw_intent(&self, a: IntentActionArgs) -> Result<Outcome<Intent>> {
        let Some(mut intent) = self.intent_by_id(&a.intent_id).await? else {
            return Ok(no_intent());
        };
        let repo = match self
            .repo_by_id(&intent.repo_id, &Some(a.actor.clone()))
            .await?
        {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(_) => return Ok(no_intent()),
        };
        if intent.author.id != a.actor.id && repo.owner_id != a.actor.id {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only the author or the repo owner can withdraw an intent.",
            ));
        }
        if intent.status != IntentStatus::Open {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This intent is already closed.",
            ));
        }
        self.db
            .prepare("UPDATE intents SET status = 'withdrawn' WHERE id = ?")
            .bind(&[intent.id.as_str().into()])?
            .run()
            .await?;
        self.publish(NewEvent {
            kind: "intent.closed",
            source: SOURCE,
            repo_id: Some(intent.repo_id.clone()),
            actor: Some(a.actor.id),
            data: IntentClosed {
                intent_id: intent.id.clone(),
                repo_id: intent.repo_id.clone(),
                reason: "withdrawn",
            },
        })
        .await?;
        intent.status = IntentStatus::Withdrawn;
        Ok(Outcome::Ok(intent))
    }

    async fn start_attempt(&self, a: StartAttemptArgs) -> Result<Outcome<Attempt>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let Some(intent) = self.intent_by_id(&a.intent_id).await? else {
            return Ok(no_intent());
        };
        if intent.status != IntentStatus::Open {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This intent is already closed.",
            ));
        }
        let agent = match a.agent.trim() {
            "" => "agent",
            agent => agent,
        };
        let runtime = match a.runtime {
            AttemptRuntime::Hosted => "hosted",
            AttemptRuntime::External => "external",
        };

        let now = now_ms();
        let id = new_id("att", now);
        let fork: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "fork_for_attempt",
            &ForkArgs {
                source_id: intent.repo_id.clone(),
                attempt_id: id.clone(),
                actor: a.actor.clone(),
            },
        )
        .await?;
        let fork = match fork {
            Outcome::Ok(fork) => fork,
            // The repo is not visible to this actor, so neither is the intent.
            Outcome::Fail(failure) if failure.code == FailureCode::NotFound => {
                return Ok(no_intent());
            }
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };

        let timestamp = rfc3339(now);
        self.db
            .prepare(
                "INSERT INTO attempts
                   (id, intent_id, repo_id, number, agent, runtime, fork_repo_id,
                    fork_namespace, fork_name, started_by_id, started_by_name,
                    created_at, updated_at)
                 SELECT ?, ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?
                 FROM attempts WHERE intent_id = ?",
            )
            .bind(&[
                id.as_str().into(),
                intent.id.as_str().into(),
                intent.repo_id.as_str().into(),
                agent.into(),
                runtime.into(),
                fork.id.into(),
                fork.namespace.into(),
                fork.name.into(),
                a.actor.id.as_str().into(),
                a.actor.username.as_str().into(),
                timestamp.as_str().into(),
                timestamp.as_str().into(),
                intent.id.as_str().into(),
            ])?
            .run()
            .await?;
        let Some(attempt) = self.attempt_by_id(&id).await? else {
            return Ok(no_attempt());
        };
        self.publish(NewEvent {
            kind: "attempt.started",
            source: SOURCE,
            repo_id: Some(attempt.repo_id.clone()),
            actor: Some(a.actor.id),
            data: AttemptEvent {
                agent: Some(attempt.agent.clone()),
                ..Self::attempt_event(&attempt)
            },
        })
        .await?;
        Ok(Outcome::Ok(attempt))
    }

    async fn get_attempt(&self, a: AttemptViewArgs) -> Result<Outcome<AttemptDetail>> {
        let Some(attempt) = self.attempt_by_id(&a.attempt_id).await? else {
            return Ok(no_attempt());
        };
        if let Outcome::Fail(_) = self.repo_by_id(&attempt.repo_id, &a.viewer).await? {
            return Ok(no_attempt());
        }
        let Some(intent) = self.intent_by_id(&attempt.intent_id).await? else {
            return Ok(no_attempt());
        };
        Ok(Outcome::Ok(AttemptDetail { attempt, intent }))
    }

    /// Submits or abandons an attempt on behalf of the one running it.
    async fn close_attempt(
        &self,
        a: AttemptActionArgs,
        status: AttemptStatus,
    ) -> Result<Outcome<Attempt>> {
        let mut attempt = match self.own_attempt(&a.actor, &a.attempt_id).await? {
            Outcome::Ok(attempt) => attempt,
            failed => return Ok(failed),
        };
        if !attempt.status.is_active() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("This attempt is already {}.", attempt.status.as_str()),
            ));
        }
        let summary = Some(a.summary.trim().to_owned()).filter(|summary| !summary.is_empty());
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "UPDATE attempts SET status = ?, summary = COALESCE(?, summary), updated_at = ?
                 WHERE id = ?",
            )
            .bind(&[
                status.as_str().into(),
                optional(&summary),
                now.as_str().into(),
                attempt.id.as_str().into(),
            ])?
            .run()
            .await?;
        let submitted = status == AttemptStatus::Submitted;
        self.publish(NewEvent {
            kind: if submitted {
                "attempt.submitted"
            } else {
                "attempt.updated"
            },
            source: SOURCE,
            repo_id: Some(attempt.repo_id.clone()),
            actor: Some(a.actor.id),
            data: AttemptEvent {
                status: (!submitted).then_some(status.as_str()),
                ..Self::attempt_event(&attempt)
            },
        })
        .await?;
        attempt.status = status;
        attempt.summary = summary.or(attempt.summary);
        attempt.updated_at = now;
        Ok(Outcome::Ok(attempt))
    }

    async fn ship_attempt(&self, a: AttemptActionArgs) -> Result<Outcome<Attempt>> {
        let Some(mut attempt) = self.attempt_by_id(&a.attempt_id).await? else {
            return Ok(no_attempt());
        };
        // Whether the actor may see and write the repo is decided by repos.
        let viewer = Some(a.actor.clone());
        if let Outcome::Fail(_) = self.repo_by_id(&attempt.repo_id, &viewer).await? {
            return Ok(no_attempt());
        }
        if !attempt.status.is_active() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("This attempt is already {}.", attempt.status.as_str()),
            ));
        }
        let Some(intent) = self.intent_by_id(&attempt.intent_id).await? else {
            return Ok(no_intent());
        };
        if intent.status != IntentStatus::Open {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This intent is already closed.",
            ));
        }

        let landed: Outcome<Landed> = g1t_kit::call(
            &self.repos,
            "land",
            &LandArgs {
                fork_id: attempt.fork_repo_id.clone(),
                actor: a.actor.clone(),
            },
        )
        .await?;
        let landed = match landed {
            Outcome::Ok(landed) => landed,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };

        let now = rfc3339(now_ms());
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "UPDATE attempts
                         SET status = 'shipped', head_commit = ?, landed_base = ?, updated_at = ?
                         WHERE id = ?",
                    )
                    .bind(&[
                        landed.commit.as_str().into(),
                        optional(&landed.previous),
                        now.as_str().into(),
                        attempt.id.as_str().into(),
                    ])?,
                self.db
                    .prepare("UPDATE intents SET status = 'shipped' WHERE id = ?")
                    .bind(&[intent.id.as_str().into()])?,
            ])
            .await?;
        self.publish(NewEvent {
            kind: "attempt.shipped",
            source: SOURCE,
            repo_id: Some(attempt.repo_id.clone()),
            actor: Some(a.actor.id.clone()),
            data: AttemptEvent {
                commit: Some(landed.commit.clone()),
                ..Self::attempt_event(&attempt)
            },
        })
        .await?;
        self.publish(NewEvent {
            kind: "intent.closed",
            source: SOURCE,
            repo_id: Some(attempt.repo_id.clone()),
            actor: Some(a.actor.id),
            data: IntentClosed {
                intent_id: intent.id,
                repo_id: attempt.repo_id.clone(),
                reason: "shipped",
            },
        })
        .await?;

        attempt.status = AttemptStatus::Shipped;
        attempt.head_commit = Some(landed.commit);
        attempt.landed_base = landed.previous;
        attempt.updated_at = now;
        Ok(Outcome::Ok(attempt))
    }

    async fn list_active_attempts(&self, a: ViewerArgs) -> Result<Vec<AttemptDetail>> {
        let Some(viewer) = a.viewer else {
            return Ok(Vec::new());
        };
        let rows = self
            .db
            .prepare(
                "SELECT * FROM attempts
                 WHERE started_by_id = ? AND status IN ('working', 'submitted')
                 ORDER BY updated_at DESC LIMIT 50",
            )
            .bind(&[viewer.id.into()])?
            .all()
            .await?
            .results::<AttemptRow>()?;
        let mut active = Vec::with_capacity(rows.len());
        for attempt in rows.into_iter().map(Attempt::from) {
            if let Some(intent) = self.intent_by_id(&attempt.intent_id).await? {
                active.push(AttemptDetail { attempt, intent });
            }
        }
        Ok(active)
    }

    async fn append_session(&self, a: AppendSessionArgs) -> Result<Outcome<Appended>> {
        if a.entries.is_empty() {
            return Ok(Outcome::Ok(Appended { count: 0 }));
        }
        if a.entries.len() > MAX_ENTRY_BATCH {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("Send at most {MAX_ENTRY_BATCH} entries at a time."),
            ));
        }
        let attempt = match self.own_attempt(&a.actor, &a.attempt_id).await? {
            Outcome::Ok(attempt) => attempt,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };

        let now = rfc3339(now_ms());
        let count = a.entries.len() as u32;
        let mut statements = Vec::with_capacity(a.entries.len() + 1);
        for entry in a.entries {
            let kind = serde_json::to_value(entry.kind)?;
            let text: String = entry.text.chars().take(MAX_ENTRY_CHARS).collect();
            // Each insert takes the next sequence number itself, so two
            // writers appending at once cannot collide.
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO session_entries (attempt_id, seq, kind, text, tool, \"commit\", at)
                         SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?
                         FROM session_entries WHERE attempt_id = ?",
                    )
                    .bind(&[
                        attempt.id.as_str().into(),
                        kind.as_str().unwrap_or("note").into(),
                        text.into(),
                        optional(&entry.tool),
                        optional(&entry.commit.or_else(|| attempt.head_commit.clone())),
                        now.as_str().into(),
                        attempt.id.as_str().into(),
                    ])?,
            );
        }
        statements.push(
            self.db
                .prepare("UPDATE attempts SET updated_at = ? WHERE id = ?")
                .bind(&[now.as_str().into(), attempt.id.as_str().into()])?,
        );
        self.db.batch(statements).await?;
        self.publish(NewEvent {
            kind: "session.appended",
            source: SOURCE,
            repo_id: Some(attempt.repo_id.clone()),
            actor: Some(a.actor.id),
            data: SessionAppended {
                attempt_id: attempt.id.clone(),
                session_id: attempt.id,
                count,
            },
        })
        .await?;
        Ok(Outcome::Ok(Appended { count }))
    }

    async fn read_session(&self, a: AttemptViewArgs) -> Result<Outcome<Vec<SessionEntry>>> {
        let after_seq = a.after_seq;
        let attempt_id = a.attempt_id.clone();
        if let Outcome::Fail(failure) = self.get_attempt(a).await? {
            return Ok(Outcome::Fail(failure));
        }
        let rows = self
            .db
            .prepare(
                "SELECT seq, kind, text, tool, \"commit\", at FROM session_entries
                 WHERE attempt_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            )
            .bind(&[attempt_id.into(), after_seq.into(), SESSION_PAGE.into()])?
            .all()
            .await?
            .results::<SessionRow>()?;
        Ok(Outcome::Ok(
            rows.into_iter().map(SessionEntry::from).collect(),
        ))
    }

    /// A push to an attempt's fork moves that attempt's head.
    async fn on_event(&self, event: &Delivered) -> Result<()> {
        if event.kind != "git.push" {
            return Ok(());
        }
        let (Some(repo_id), Some(after)) = (event.repo_id.as_deref(), event.data["after"].as_str())
        else {
            return Ok(());
        };
        self.db
            .prepare("UPDATE attempts SET head_commit = ?, updated_at = ? WHERE fork_repo_id = ?")
            .bind(&[after.into(), rfc3339(now_ms()).into(), repo_id.into()])?
            .run()
            .await?;
        Ok(())
    }
}

fn service(env: &Env) -> Result<Work> {
    Ok(Work {
        db: env.d1("DB")?,
        repos: env.service("REPOS")?,
        events: js::binding(env, "EVENTS")?,
    })
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    let body: serde_json::Value = request.json().await?;
    let work = service(&env)?;

    match method.as_str() {
        "open_intent" => reply(&work.open_intent(args(body)?).await?),
        "list_intents" => reply(&work.list_intents(args(body)?).await?),
        "get_intent" => reply(&work.get_intent(args(body)?).await?),
        "withdraw_intent" => reply(&work.withdraw_intent(args(body)?).await?),
        "start_attempt" => reply(&work.start_attempt(args(body)?).await?),
        "get_attempt" => reply(&work.get_attempt(args(body)?).await?),
        "submit_attempt" => reply(
            &work
                .close_attempt(args(body)?, AttemptStatus::Submitted)
                .await?,
        ),
        "abandon_attempt" => reply(
            &work
                .close_attempt(args(body)?, AttemptStatus::Abandoned)
                .await?,
        ),
        "ship_attempt" => reply(&work.ship_attempt(args(body)?).await?),
        "list_active_attempts" => reply(&work.list_active_attempts(args(body)?).await?),
        "append_session" => reply(&work.append_session(args(body)?).await?),
        "read_session" => reply(&work.read_session(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}

/// Events from the bus, delivered on this service's own queue.
#[event(queue)]
async fn queue(batch: MessageBatch<Delivered>, env: Env, _ctx: Context) -> Result<()> {
    let work = service(&env)?;
    for message in batch.messages()? {
        work.on_event(message.body()).await?;
        message.ack();
    }
    Ok(())
}
