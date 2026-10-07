//! The events service: the bus every state change in g1t is published on,
//! and its durable log.
//!
//! Publishing puts events on a queue and returns. The queue consumer writes
//! them to the log and passes each batch on to every subscriber's own
//! queue, so a slow or failing subscriber holds up nobody else.
//!
//! It keeps two more things beside the log: the audit log (audit.rs) and
//! each person's inbox (inbox.rs), written as events arrive.
//!
//! Other services reach it over `POST /rpc/<method>`; see
//! `g1t_contracts::events`, `audit` and `inbox` for the methods and their
//! arguments.

mod audit;
mod inbox;

use g1t_contracts::events::{Event, ListArgs, PublishArgs};
use g1t_contracts::new_id;
use g1t_contracts::time::rfc3339;
use g1t_kit::{args, js, now_ms, reply, rpc_method};
use serde::Deserialize;
use worker::js_sys::{Array, Object};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::{Context, D1Database, Env, MessageBatch, Request, Response, Result, event};

const DEFAULT_PAGE: u32 = 50;
const MAX_PAGE: u32 = 200;
/// Every binding whose name starts with this is a queue that receives all
/// events: one per subscribing service.
const SUBSCRIBER_PREFIX: &str = "SUBSCRIBER_";

#[derive(Deserialize)]
struct EventRow {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    source: String,
    time: String,
    repo_id: Option<String>,
    actor: Option<String>,
    /// JSON.
    data: String,
}

impl From<EventRow> for Event {
    fn from(row: EventRow) -> Self {
        Event {
            id: row.id,
            kind: row.kind,
            source: row.source,
            time: row.time,
            repo_id: row.repo_id,
            actor: row.actor,
            data: serde_json::from_str(&row.data).unwrap_or_default(),
        }
    }
}

fn optional(value: &Option<String>) -> JsValue {
    value.as_deref().map_or(JsValue::NULL, JsValue::from)
}

/// Sends `events` to a queue binding, one message each.
async fn send(queue: &JsValue, events: &[Event]) -> Result<()> {
    let messages = Array::new();
    for event in events {
        let message = Object::new();
        js::set(&message, "body", &js::to_js(event)?);
        messages.push(&message);
    }
    js::call(queue, "sendBatch", &[messages.into()]).await?;
    Ok(())
}

struct Events {
    db: D1Database,
    env: Env,
}

impl Events {
    /// Assigns each event its id and time and puts it on the bus.
    async fn publish(&self, a: PublishArgs) -> Result<()> {
        if a.events.is_empty() {
            return Ok(());
        }
        let now = now_ms();
        let events: Vec<Event> = a
            .events
            .into_iter()
            .map(|event| Event {
                id: new_id("evt", now),
                kind: event.kind,
                source: event.source,
                time: rfc3339(now),
                repo_id: event.repo_id,
                actor: event.actor,
                data: event.data,
            })
            .collect();
        send(&js::binding(&self.env, "BUS")?, &events).await
    }

    /// Newest first. Callers must have checked that the viewer may see the
    /// repository asked about.
    async fn list(&self, a: ListArgs) -> Result<Vec<Event>> {
        let mut conditions = Vec::new();
        let mut values: Vec<JsValue> = Vec::new();
        if let Some(repo_id) = &a.repo_id {
            conditions.push("repo_id = ?".to_owned());
            values.push(repo_id.as_str().into());
        }
        if !a.types.is_empty() {
            let marks = vec!["?"; a.types.len()].join(", ");
            conditions.push(format!("type IN ({marks})"));
            values.extend(a.types.iter().map(|kind| JsValue::from(kind.as_str())));
        }
        if let Some(before) = &a.before {
            conditions.push("id < ?".to_owned());
            values.push(before.as_str().into());
        }
        let filter = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        values.push(a.limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE).into());
        let rows = self
            .db
            .prepare(format!(
                "SELECT * FROM events {filter} ORDER BY id DESC LIMIT ?"
            ))
            .bind(&values)?
            .all()
            .await?
            .results::<EventRow>()?;
        Ok(rows.into_iter().map(Event::from).collect())
    }

    /// Writes a batch from the bus to the log, hands it to every
    /// subscriber, then tells the people it concerns (inbox.rs).
    async fn deliver(&self, events: &[Event]) -> Result<()> {
        let mut statements = Vec::with_capacity(events.len());
        for event in events {
            statements.push(
                self.db
                    .prepare(
                        // Redelivered batches must not duplicate log rows.
                        "INSERT OR IGNORE INTO events (id, type, source, time, repo_id, actor, data)
                         VALUES (?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        event.id.as_str().into(),
                        event.kind.as_str().into(),
                        event.source.as_str().into(),
                        event.time.as_str().into(),
                        optional(&event.repo_id),
                        optional(&event.actor),
                        serde_json::to_string(&event.data)?.into(),
                    ])?,
            );
        }
        self.db.batch(statements).await?;
        audit::follow_renames(&self.db, events).await?;

        let bindings: &JsValue = self.env.as_ref();
        for name in Object::keys(bindings.unchecked_ref::<Object>()).iter() {
            let Some(name) = name
                .as_string()
                .filter(|name| name.starts_with(SUBSCRIBER_PREFIX))
            else {
                continue;
            };
            send(&js::binding(&self.env, &name)?, events).await?;
        }
        inbox::follow(&self.db, events).await?;
        let (work, repos, identity) = (
            self.env.service("WORK")?,
            self.env.service("REPOS")?,
            self.env.service("IDENTITY")?,
        );
        let sources = inbox::Sources {
            work: &work,
            repos: &repos,
            identity: &identity,
        };
        inbox::deliver(&self.db, &sources, events).await;
        Ok(())
    }
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    let body: serde_json::Value = request.json().await?;
    let events = Events {
        db: env.d1("DB")?,
        env,
    };
    match method.as_str() {
        "publish" => reply(&events.publish(args(body)?).await?),
        "list" => reply(&events.list(args(body)?).await?),
        "audit_record" => reply(&audit::record(&events.db, args(body)?).await?),
        "audit_list" => reply(&audit::list(&events.db, args(body)?).await?),
        "inbox_list" => {
            let repos = events.env.service("REPOS")?;
            reply(&inbox::list(&events.db, &repos, args(body)?).await?)
        }
        "inbox_counts" => reply(&inbox::counts(&events.db, args(body)?).await?),
        "inbox_mark" => reply(&inbox::mark(&events.db, args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}

/// Events from the bus. A batch that fails is retried whole, which is safe
/// because both the log and subscribers ignore an event they have seen.
#[event(queue)]
async fn queue(batch: MessageBatch<Event>, env: Env, _ctx: Context) -> Result<()> {
    let events = Events {
        db: env.d1("DB")?,
        env,
    };
    let delivered: Vec<Event> = batch
        .messages()?
        .into_iter()
        .map(|message| message.into_body())
        .collect();
    events.deliver(&delivered).await?;
    batch.ack_all();
    Ok(())
}

/// Once a day, old audit entries are removed: first everything older than
/// any workspace keeps (`AUDIT_MAX_DAYS`, 400 days), then each workspace's
/// entries older than its own plan keeps, as billing says (7 days free, 90
/// on the plan, or what staff set). Workspaces with nothing older than the
/// shortest (`AUDIT_MIN_DAYS`, 7) are left alone.
#[event(scheduled)]
async fn scheduled(_event: worker::ScheduledEvent, env: Env, _ctx: worker::ScheduleContext) {
    let days = |name: &str, default: u32| {
        env.var(name)
            .ok()
            .and_then(|v| v.to_string().trim().parse::<u32>().ok())
            .filter(|days| *days > 0)
            .unwrap_or(default)
    };
    let max_days = days("AUDIT_MAX_DAYS", audit::DEFAULT_MAX_DAYS);
    let min_days = days("AUDIT_MIN_DAYS", audit::DEFAULT_MIN_DAYS).min(max_days);
    let Ok(db) = env.d1("DB") else { return };
    let now = now_ms();
    match inbox::purge(&db, now).await {
        Ok(removed) if removed > 0 => worker::console_log!("removed {removed} old inbox items"),
        Ok(_) => {}
        Err(error) => worker::console_error!("could not remove old inbox items: {error}"),
    }
    match audit::purge(&db, &audit::keep_from(now, max_days), 20).await {
        Ok(removed) if removed > 0 => {
            worker::console_log!("removed {removed} audit entries older than {max_days} days")
        }
        Ok(_) => {}
        Err(error) => worker::console_error!("could not remove old audit entries: {error}"),
    }
    // Without billing nobody's plan is known, so nothing younger than the
    // ceiling is removed.
    let billing = match env.service("BILLING") {
        Ok(billing) => billing,
        Err(error) => {
            worker::console_error!(
                "audit entries kept past their plan's days: no billing: {error}"
            );
            return;
        }
    };
    match audit::purge_by_plan(&db, &billing, now, min_days, max_days).await {
        Ok(removed) if removed > 0 => {
            worker::console_log!("removed {removed} audit entries older than their plan keeps")
        }
        Ok(_) => {}
        Err(error) => worker::console_error!("audit entries kept past their plan's days: {error}"),
    }
}
