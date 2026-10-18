//! The events service: the bus every state change in g1t is published on,
//! and its durable log.
//!
//! Publishing puts events on a queue and returns. The queue consumer writes
//! them to the log and passes each batch on to each subscriber's own
//! queue, so a slow or failing subscriber holds up nobody else. Each
//! subscriber is sent only the types it acts on
//! (`g1t_contracts::subscribers`), in batches the queues take (fanout.rs).
//!
//! It keeps two more things beside the log: the audit log (audit.rs) and
//! each person's inbox (inbox.rs), written as events arrive, with who
//! follows what (subscriptions.rs).
//!
//! Other services reach it over `POST /rpc/<method>`; see
//! `g1t_contracts::events`, `audit` and `inbox` for the methods and their
//! arguments. `activity_digest` (digest.rs) counts a span of the log for
//! Home. Security alerts that are not urgent wait for each person's
//! security digest (security_digest.rs), sent by a cron of its own.
//!
//! Repository pages open in someone's browser refresh themselves: each
//! batch's events that such a page shows are passed to the notify service
//! (live.rs), which tells those watching the repository.

mod audit;
mod digest;
mod fanout;
mod inbox;
mod live;
#[cfg(test)]
mod schema;
mod security_digest;
mod subscriptions;
mod work_items;

use g1t_contracts::events::{Event, ListArgs, MAX_LIST_REPOS, PublishArgs};
use g1t_contracts::new_id;
use g1t_contracts::time::rfc3339;
use g1t_kit::{args, js, now_ms, reply, rpc_method};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use worker::js_sys::{Array, Object};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::{Context, D1Database, Env, MessageBatch, Request, Response, Result, event};

const DEFAULT_PAGE: u32 = 50;
const MAX_PAGE: u32 = 200;
/// Statuses and check runs reported on commits: delivered to webhooks, and
/// left out of a timeline unless asked for by type.
const REPORTING: [&str; 7] = [
    "status.created",
    "check_run.created",
    "check_run.completed",
    "check_run.rerequested",
    "check_run.requested_action",
    "check_suite.completed",
    "check_suite.rerequested",
];
/// Every binding whose name starts with this is a queue that receives
/// events: one per subscribing service, sent the types it routes.
const SUBSCRIBER_PREFIX: &str = "SUBSCRIBER_";
/// How long a record of which queues a batch reached is kept for its retries.
const FANOUT_KEEP_MS: u64 = 24 * 60 * 60 * 1000;

/// An event as the log's table holds it.
#[derive(Deserialize)]
pub(crate) struct EventRow {
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

#[derive(Deserialize)]
struct FanoutRow {
    event_id: String,
    /// JSON array of binding names.
    bindings: String,
}

/// Sends `events` to a queue binding, one message each, in as many
/// `sendBatch` calls as the queue's limits need (fanout.rs). Events are
/// expected to have been fit to a message.
async fn send(queue: &JsValue, events: &[&Event]) -> Result<()> {
    for chunk in fanout::chunks(events) {
        let messages = Array::new();
        for event in chunk {
            let message = Object::new();
            js::set(&message, "body", &js::to_js(event)?);
            messages.push(&message);
        }
        js::call(queue, "sendBatch", &[messages.into()]).await?;
    }
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
            .map(|event| {
                let mut event = Event {
                    id: new_id("evt", now),
                    kind: event.kind,
                    source: event.source,
                    time: rfc3339(now),
                    repo_id: event.repo_id,
                    actor: event.actor,
                    data: event.data,
                };
                // Too large for one message: its long text is shortened.
                fanout::fit(&mut event);
                event
            })
            .collect();
        let events: Vec<&Event> = events.iter().collect();
        send(&js::binding(&self.env, "BUS")?, &events).await
    }

    /// Newest first, or with `after` oldest first in the order the log
    /// wrote them. Callers must have checked that the viewer may see the
    /// repository asked about.
    async fn list(&self, a: ListArgs) -> Result<Vec<Event>> {
        let (filter, binds) = list_filter(&a);
        let mut values: Vec<JsValue> = binds
            .into_iter()
            .map(|bind| match bind {
                Bind::Text(text) => JsValue::from(text),
                Bind::Number(number) => JsValue::from(number),
            })
            .collect();
        values.push(a.limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE).into());
        let order = if a.after.is_some() { "seq ASC" } else { "id DESC" };
        let rows = self
            .db
            .prepare(format!(
                "SELECT * FROM events {filter} ORDER BY {order} LIMIT ?"
            ))
            .bind(&values)?
            .all()
            .await?
            .results::<EventRow>()?;
        Ok(rows.into_iter().map(Event::from).collect())
    }

    /// Writes a batch from the bus to the log, notes who now follows what
    /// (inbox.rs), hands each subscriber the events it routes, then tells
    /// the people it concerns.
    ///
    /// Everything before the hand-off is safe to repeat. A retried batch
    /// skips the queues that already have it: when a hand-off fails part
    /// way, which queues each event reached is written down first.
    async fn deliver(&self, events: &[Event]) -> Result<()> {
        let mut statements = Vec::with_capacity(events.len() + 1);
        for event in events {
            statements.push(
                self.db
                    .prepare(
                        // Redelivered batches must not duplicate log rows.
                        // `seq` is the order of writing, which `after` follows
                        // (0010_events_seq.sql): the log has one writer.
                        "INSERT OR IGNORE INTO events (id, type, source, time, repo_id, actor, data, seq)
                         VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM events))",
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
        let ids: Vec<&str> = events.iter().map(|event| event.id.as_str()).collect();
        // Read in the same round trip: nearly always nothing.
        statements.push(
            self.db
                .prepare("SELECT event_id, bindings FROM fanout_sent WHERE event_id IN (SELECT value FROM json_each(?))")
                .bind(&[serde_json::to_string(&ids)?.into()])?,
        );
        let results = self.db.batch(statements).await?;
        let mut sent: HashMap<String, HashSet<String>> = HashMap::new();
        if let Some(rows) = results.last() {
            for row in rows.results::<FanoutRow>()? {
                let bindings: Vec<String> = serde_json::from_str(&row.bindings).unwrap_or_default();
                sent.insert(row.event_id, bindings.into_iter().collect());
            }
        }
        audit::follow_renames(&self.db, events).await?;
        // Before the hand-off, so its failing does not send the batch to
        // every queue again.
        inbox::follow(&self.db, events).await?;

        let bindings: &JsValue = self.env.as_ref();
        let mut reached: Vec<String> = Vec::new();
        let mut failed = None;
        for name in Object::keys(bindings.unchecked_ref::<Object>()).iter() {
            let Some(name) = name
                .as_string()
                .filter(|name| name.starts_with(SUBSCRIBER_PREFIX))
            else {
                continue;
            };
            let routed: Vec<&Event> = events
                .iter()
                .filter(|event| g1t_contracts::subscribers::routed(&name, &event.kind))
                .filter(|event| !sent.get(&event.id).is_some_and(|reached| reached.contains(&name)))
                .collect();
            if routed.is_empty() {
                continue;
            }
            match send(&js::binding(&self.env, &name)?, &routed).await {
                Ok(()) => reached.push(name),
                Err(error) => {
                    worker::console_error!("events: passing {} events to {name} failed: {error}", routed.len());
                    failed = Some(error);
                }
            }
        }
        if let Some(error) = failed {
            self.note_reached(events, &sent, &reached).await?;
            return Err(error);
        }
        let (work, repos, identity) = (
            self.env.service("WORK")?,
            self.env.service("REPOS")?,
            self.env.service("IDENTITY")?,
        );
        // Optional: without it the inbox still fills, nobody is told live.
        let notify = self.env.service("NOTIFY").ok();
        // Pages open on the repositories: told first, as nobody waits longer.
        if let Some(notify) = notify.as_ref() {
            live::tell(notify, events).await;
        }
        let sources = inbox::Sources {
            work: &work,
            repos: &repos,
            identity: &identity,
            notify: notify.as_ref(),
        };
        inbox::deliver(&self.db, &sources, events).await;
        Ok(())
    }

    /// Writes down which queues each event of a batch has reached, with
    /// those it had reached before, for the batch's retry.
    async fn note_reached(
        &self,
        events: &[Event],
        sent: &HashMap<String, HashSet<String>>,
        reached: &[String],
    ) -> Result<()> {
        let now = rfc3339(now_ms());
        let mut statements = Vec::with_capacity(events.len());
        for event in events {
            let mut bindings: Vec<&str> = reached.iter().map(String::as_str).collect();
            if let Some(before) = sent.get(&event.id) {
                bindings.extend(before.iter().map(String::as_str));
            }
            bindings.sort_unstable();
            bindings.dedup();
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO fanout_sent (event_id, bindings, created_at) VALUES (?, ?, ?)
                         ON CONFLICT (event_id) DO UPDATE SET bindings = excluded.bindings",
                    )
                    .bind(&[event.id.as_str().into(), serde_json::to_string(&bindings)?.into(), now.as_str().into()])?,
            );
        }
        self.db.batch(statements).await?;
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
        // Home's digest of a span: counted, by who did it (digest.rs).
        "activity_digest" => reply(&digest::activity_digest(&events.db, args(body)?).await?),
        "audit_record" => reply(&audit::record(&events.db, args(body)?).await?),
        "audit_list" => reply(&audit::list(&events.db, args(body)?).await?),
        "inbox_list" => {
            let repos = events.env.service("REPOS")?;
            reply(&inbox::list(&events.db, &repos, args(body)?).await?)
        }
        "inbox_counts" => reply(&inbox::counts(&events.db, args(body)?).await?),
        "inbox_mark" => {
            let marked: g1t_contracts::inbox::MarkInboxArgs = args(body)?;
            let username = marked.username.clone();
            let changed = inbox::mark(&events.db, marked).await?;
            // Notify: the new count in every open tab, whoever marked (the site, the API, MCP).
            if changed > 0
                && let Ok(notify) = events.env.service("NOTIFY")
            {
                inbox::tell_inbox_count(&events.db, &notify, &username).await;
            }
            reply(&changed)
        }
        "inbox_thread" => {
            let (repos, work) = (events.env.service("REPOS")?, events.env.service("WORK")?);
            reply(&inbox::thread(&events.db, &repos, &work, args(body)?).await?)
        }
        "inbox_subscription" => {
            let work = events.env.service("WORK")?;
            reply(&subscriptions::subscription(&events.db, &work, args(body)?).await?)
        }
        "inbox_subscribe" => {
            let work = events.env.service("WORK")?;
            reply(&subscriptions::subscribe(&events.db, &work, args(body)?).await?)
        }
        "inbox_watching" => reply(&subscriptions::watching(&events.db, args(body)?).await?),
        "inbox_watch" => reply(&subscriptions::watch(&events.db, args(body)?).await?),
        "inbox_watchers" => reply(&subscriptions::watchers_count(&events.db, args(body)?).await?),
        "inbox_watched" => reply(&subscriptions::watched(&events.db, args(body)?).await?),
        "inbox_settings" => reply(&subscriptions::settings(&events.db, args(body)?).await?),
        "inbox_update_settings" => reply(&subscriptions::update_settings(&events.db, args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}

/// Events from the bus. A batch that fails is retried whole, which is safe
/// because the log ignores an event it has seen, and queues that already
/// have it are skipped (`deliver`). After its retries it goes to the
/// dead-letter queue (wrangler.jsonc).
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
async fn scheduled(event: worker::ScheduledEvent, env: Env, _ctx: worker::ScheduleContext) {
    // The morning cron sends the security digests that are due, and nothing else.
    if event.cron() == security_digest::DIGEST_CRON {
        let (Ok(db), Ok(identity)) = (env.d1("DB"), env.service("IDENTITY")) else { return };
        let notify = env.service("NOTIFY").ok();
        match security_digest::send_due(&db, &identity, notify.as_ref(), now_ms()).await {
            Ok(sent) if sent > 0 => worker::console_log!("sent {sent} security digests"),
            Ok(_) => {}
            Err(error) => worker::console_error!("security digests not sent: {error}"),
        }
        return;
    }
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
    let cutoff = rfc3339(now.saturating_sub(FANOUT_KEEP_MS));
    let purged = match db.prepare("DELETE FROM fanout_sent WHERE created_at < ?").bind(&[cutoff.into()]) {
        Ok(statement) => statement.run().await.map(|_| ()),
        Err(error) => Err(error),
    };
    if let Err(error) = purged {
        worker::console_error!("could not remove old fan-out records: {error}");
    }
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

/// The condition of an `after` cursor, binding its id twice.
const AFTER: &str = concat!(
    "seq > COALESCE(",
    "(SELECT seq FROM events WHERE id = ?), ",
    "(SELECT seq FROM events WHERE id > ? AND seq IS NOT NULL ORDER BY id LIMIT 1) - 1, ",
    "(SELECT MAX(seq) FROM events), 0)"
);

/// A value bound to a `?` in [`list_filter`]'s clause.
#[derive(Debug, PartialEq)]
enum Bind {
    Text(String),
    Number(f64),
}

/// The `WHERE` clause `list` reads with, and what it binds, in order.
fn list_filter(a: &ListArgs) -> (String, Vec<Bind>) {
    let mut conditions = Vec::new();
    let mut values = Vec::new();
    if let Some(repo_id) = &a.repo_id {
        conditions.push("repo_id = ?".to_owned());
        values.push(Bind::Text(repo_id.clone()));
    }
    if !a.repo_ids.is_empty() {
        // A workspace's activity across its repositories: one list, bound
        // as JSON so the statement stays small however many there are.
        let ids: Vec<&String> = a.repo_ids.iter().take(MAX_LIST_REPOS).collect();
        conditions.push("repo_id IN (SELECT value FROM json_each(?))".to_owned());
        values.push(Bind::Text(serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_owned())));
    }
    if !a.types.is_empty() {
        let marks = vec!["?"; a.types.len()].join(", ");
        conditions.push(format!("type IN ({marks})"));
        values.extend(a.types.iter().map(|kind| Bind::Text(kind.clone())));
    } else {
        // What CI and integrations report on commits goes to webhooks,
        // and is read from each commit's checks; a timeline asked for
        // everything would be little else on a busy repository.
        let marks = vec!["?"; REPORTING.len()].join(", ");
        conditions.push(format!("type NOT IN ({marks})"));
        values.extend(REPORTING.iter().map(|kind| Bind::Text((*kind).to_owned())));
    }
    if let Some(actor) = &a.actor {
        conditions.push("actor = ?".to_owned());
        values.push(Bind::Text(actor.clone()));
    }
    if !a.numbers.is_empty() {
        // A work item's or pull request's own events name it as `number`; a
        // comment, review or link on it names it as `item`.
        let marks = vec!["?"; a.numbers.len()].join(", ");
        conditions.push(format!(
            "(json_extract(data, '$.number') IN ({marks}) OR json_extract(data, '$.item') IN ({marks}))"
        ));
        for _ in 0..2 {
            values.extend(a.numbers.iter().map(|number| Bind::Number(f64::from(*number))));
        }
    }
    if let Some(since) = &a.since {
        conditions.push("time >= ?".to_owned());
        values.push(Bind::Text(since.clone()));
    }
    if let Some(before) = &a.before {
        conditions.push("id < ?".to_owned());
        values.push(Bind::Text(before.clone()));
    }
    if let Some(after) = &a.after {
        // What the log wrote after the cursor's event. A cursor the log
        // does not have (yet: an id from a webhook can arrive before its
        // row is written) starts at the first event with a later id, and
        // one past them all at the end of the log.
        conditions.push(AFTER.to_owned());
        values.push(Bind::Text(after.clone()));
        values.push(Bind::Text(after.clone()));
    }
    let filter = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    (filter, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_list_leaves_out_what_is_reported_on_commits() {
        let (filter, binds) = list_filter(&ListArgs { repo_id: Some("rep_1".into()), ..ListArgs::default() });
        assert!(filter.starts_with("WHERE repo_id = ? AND type NOT IN ("));
        assert_eq!(binds[0], Bind::Text("rep_1".into()));
        assert_eq!(binds.len(), 1 + REPORTING.len());
    }

    #[test]
    fn a_workspaces_repositories_are_read_as_one_list() {
        let many: Vec<String> = (0..150).map(|n| format!("rep_{n}")).collect();
        let (filter, binds) = list_filter(&ListArgs {
            repo_ids: many,
            types: vec!["pull.merged".into(), "release.published".into()],
            since: Some("2026-10-12T00:00:00Z".into()),
            ..ListArgs::default()
        });
        assert_eq!(filter, "WHERE repo_id IN (SELECT value FROM json_each(?)) AND type IN (?, ?) AND time >= ?");
        let Bind::Text(ids) = &binds[0] else { panic!("the ids are one JSON text") };
        let ids: Vec<String> = serde_json::from_str(ids).unwrap();
        assert_eq!(ids.len(), MAX_LIST_REPOS);
        assert_eq!(ids[0], "rep_0");
    }

    #[test]
    fn numbers_match_an_item_or_what_is_said_on_it_since_a_time() {
        let (filter, binds) = list_filter(&ListArgs {
            repo_id: Some("rep_1".into()),
            types: vec!["work_item.opened".into()],
            numbers: vec![4, 9],
            since: Some("2026-10-01T00:00:00Z".into()),
            actor: Some("usr_g1t_agent".into()),
            ..ListArgs::default()
        });
        assert_eq!(
            filter,
            "WHERE repo_id = ? AND type IN (?) AND actor = ? AND \
             (json_extract(data, '$.number') IN (?, ?) OR json_extract(data, '$.item') IN (?, ?)) AND time >= ?"
        );
        assert_eq!(
            binds,
            vec![
                Bind::Text("rep_1".into()),
                Bind::Text("work_item.opened".into()),
                Bind::Text("usr_g1t_agent".into()),
                Bind::Number(4.0),
                Bind::Number(9.0),
                Bind::Number(4.0),
                Bind::Number(9.0),
                Bind::Text("2026-10-01T00:00:00Z".into()),
            ]
        );
    }

    #[test]
    fn an_after_cursor_reads_what_the_log_wrote_later_with_every_other_filter() {
        let (filter, binds) = list_filter(&ListArgs {
            repo_id: Some("rep_1".into()),
            types: vec!["work.claimed".into(), "integration.failed".into()],
            numbers: vec![7],
            since: Some("2026-10-12T00:00:00Z".into()),
            after: Some("evt_9".into()),
            ..ListArgs::default()
        });
        assert_eq!(
            filter,
            format!(
                "WHERE repo_id = ? AND type IN (?, ?) AND \
                 (json_extract(data, '$.number') IN (?) OR json_extract(data, '$.item') IN (?)) AND time >= ? AND {AFTER}"
            )
        );
        // The cursor's id is bound once to find its place, and once for a
        // cursor the log does not have.
        assert_eq!(&binds[binds.len() - 2..], &[Bind::Text("evt_9".into()), Bind::Text("evt_9".into())]);
        assert_eq!(binds.len(), 8);
        assert_eq!(AFTER.matches('?').count(), 2);
    }
}
