//! What the queues gave up on: every consumer of the bus and of the
//! subscribers' queues sends a message it failed to handle through all its
//! retries to `g1t-events-dlq` (each wrangler.jsonc), which this service
//! consumes.
//!
//! Each is recorded, and logged as an error, so that a dropped push or
//! comment leaves a trace, and `delivery_health` counts them for the status
//! page. They are not sent again: the queue does not say which consumer
//! gave up, and sending one to every subscriber would repeat it to those
//! that handled it. What a lost event leaves undone is caught up where it
//! matters by its owner (a pull request's missed push: work's heads.rs).

use g1t_contracts::events::{DELIVERY_HEALTH_MINUTES, DeadType, DeliveryHealth, DeliveryHealthArgs, MAX_DELIVERY_HEALTH_MINUTES};
use g1t_contracts::time::rfc3339;
use serde::Deserialize;
use serde_json::Value;
use worker::{D1Database, Result};

/// The queue whose messages are dead letters.
pub const QUEUE: &str = "g1t-events-dlq";

/// How long a dead letter is kept.
const KEEP_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// How much of a message's body is kept.
const MAX_BODY: usize = 16 * 1024;

const RECORD: &str = "INSERT OR IGNORE INTO dead_letters (id, event_id, type, repo_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)";

const COUNT: &str = "SELECT COALESCE(type, 'unknown') AS type, COUNT(*) AS count FROM dead_letters
     WHERE created_at >= ? GROUP BY 1 ORDER BY 2 DESC, 1";

const PURGE: &str = "DELETE FROM dead_letters WHERE created_at < ?";

/// One message the dead-letter queue received.
pub struct DeadLetter {
    /// The queue's id for the message.
    pub id: String,
    pub body: Value,
}

/// What is recorded of a dead letter: its event's id, type and repository
/// when it was an event, and its body as JSON, shortened.
#[derive(Debug, PartialEq)]
pub struct Recorded {
    pub event_id: Option<String>,
    pub kind: Option<String>,
    pub repo_id: Option<String>,
    pub body: String,
}

pub fn recorded(body: &Value) -> Recorded {
    let text = |key: &str| body[key].as_str().map(str::to_owned);
    let mut json = body.to_string();
    if json.len() > MAX_BODY {
        let end = (0..=MAX_BODY).rev().find(|end| json.is_char_boundary(*end)).unwrap_or(0);
        json.truncate(end);
    }
    Recorded { event_id: text("id"), kind: text("type"), repo_id: text("repoId").or_else(|| text("repo_id")), body: json }
}

fn optional(value: &Option<String>) -> worker::wasm_bindgen::JsValue {
    value.as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into)
}

/// Records a batch from the dead-letter queue, and says what each was.
pub async fn record(db: &D1Database, letters: &[DeadLetter], now: u64) -> Result<()> {
    let at = rfc3339(now);
    let mut statements = Vec::with_capacity(letters.len());
    for letter in letters {
        let kept = recorded(&letter.body);
        worker::console_error!(
            "events: a queue gave up on {} {} (repo {}); recorded as dead letter {}",
            kept.kind.as_deref().unwrap_or("a message"),
            kept.event_id.as_deref().unwrap_or("without an id"),
            kept.repo_id.as_deref().unwrap_or("none"),
            letter.id
        );
        statements.push(db.prepare(RECORD).bind(&[
            letter.id.as_str().into(),
            optional(&kept.event_id),
            optional(&kept.kind),
            optional(&kept.repo_id),
            kept.body.into(),
            at.as_str().into(),
        ])?);
    }
    if !statements.is_empty() {
        db.batch(statements).await?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct CountRow {
    #[serde(rename = "type")]
    kind: String,
    count: u32,
}

/// The dead letters of the last `minutes`, by type.
pub async fn health(db: &D1Database, a: DeliveryHealthArgs, now: u64) -> Result<DeliveryHealth> {
    let minutes = a.minutes.unwrap_or(DELIVERY_HEALTH_MINUTES).clamp(1, MAX_DELIVERY_HEALTH_MINUTES);
    let since = rfc3339(now.saturating_sub(u64::from(minutes) * 60 * 1000));
    let rows = db.prepare(COUNT).bind(&[since.into()])?.all().await?.results::<CountRow>()?;
    let types: Vec<DeadType> = rows.into_iter().map(|row| DeadType { kind: row.kind, count: row.count }).collect();
    Ok(DeliveryHealth { minutes, dead: types.iter().map(|kind| kind.count).sum(), types })
}

/// Removes the dead letters older than are kept; how many.
pub async fn purge(db: &D1Database, now: u64) -> Result<usize> {
    let cutoff = rfc3339(now.saturating_sub(KEEP_MS));
    let result = db.prepare(PURGE).bind(&[cutoff.into()])?.run().await?;
    Ok(result.meta()?.and_then(|meta| meta.changes).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::database_before;
    use serde_json::json;

    #[test]
    fn an_event_is_recorded_by_its_id_type_and_repository() {
        let push = json!({ "id": "evt_1", "type": "git.push", "source": "repos", "repoId": "rep_1", "data": { "after": "abc" } });
        let kept = recorded(&push);
        assert_eq!(kept.event_id.as_deref(), Some("evt_1"));
        assert_eq!(kept.kind.as_deref(), Some("git.push"));
        assert_eq!(kept.repo_id.as_deref(), Some("rep_1"));
        assert_eq!(serde_json::from_str::<Value>(&kept.body).unwrap(), push);
        // Something else (a search job) is kept as it came.
        let job = recorded(&json!({ "job": "reindex" }));
        assert_eq!((job.event_id, job.kind), (None, None));
        let long = recorded(&json!({ "id": "evt_2", "text": "é".repeat(20_000) }));
        assert!(long.body.len() <= MAX_BODY);
    }

    #[test]
    fn dead_letters_are_counted_by_type_within_the_span_once_each() {
        let db = database_before("9999");
        let insert = |id: &str, kind: Option<&str>, at: &str| {
            db.execute(RECORD, rusqlite::params![id, None::<String>, kind, None::<String>, "{}", at]).unwrap();
        };
        insert("m1", Some("git.push"), "2026-10-22T22:30:00.000Z");
        insert("m1", Some("git.push"), "2026-10-22T22:31:00.000Z");
        insert("m2", Some("git.push"), "2026-10-22T22:36:00.000Z");
        insert("m3", Some("comment.created"), "2026-10-22T22:37:00.000Z");
        insert("m4", None, "2026-10-22T22:38:00.000Z");
        insert("m5", Some("git.push"), "2026-10-22T20:00:00.000Z");
        let mut statement = db.prepare(COUNT).unwrap();
        let counted: Vec<(String, u32)> = statement
            .query_map(["2026-10-22T22:00:00.000Z"], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(counted, [("git.push".to_owned(), 2), ("comment.created".to_owned(), 1), ("unknown".to_owned(), 1)]);
        assert_eq!(db.execute(PURGE, ["2026-10-22T21:00:00.000Z"]).unwrap(), 1);
    }
}
