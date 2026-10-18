//! Each session's inbox of coordination updates: what other sessions and
//! the merge queue did that concerns it, kept until the session says it
//! considered each one (reading never clears them).
//!
//! An update is written in the same D1 batch (one transaction) as the
//! change it announces, guarded by an SQL condition that holds only once
//! that change is made: a change is never kept without its updates, and
//! updates never announce a change that was not made. Its id is derived
//! from the change (an entity and its transition), so a retried or
//! concurrent request that makes the same change delivers it once.

use super::*;
use crate::rows::NumberRow;
use sha2::{Digest, Sha256};
use worker::wasm_bindgen::JsValue;
use worker::D1PreparedStatement;

/// How long an acknowledged update is kept as a receipt, in days.
pub(crate) const RECEIPT_DAYS: u64 = 30;

/// Puts a `?2` event (data `?3`, at `?4`) of the repositories `?5` (a JSON
/// list) in the inbox of each active session there it concerns. `?6` is a
/// JSON list of the work item and pull request numbers it is about (one
/// sequence of numbers in a workspace): a session attached or tied to one
/// of them hears of it, and so does a session not on anything yet, which
/// is still finding its way; an event about nothing in particular reaches
/// every session. An overlap between two sessions names its sole
/// recipient. A session is not told what it did itself (its own start or
/// end, or the claims it made, released or handed off), only what others
/// did and what happened to it. `guard`, numbered from `?7`, holds only
/// once the change announced is made.
pub(crate) fn deliver_sql(guard: &str) -> String {
    format!(
        "INSERT OR IGNORE INTO session_updates (id, session_id, kind, data, at)
 SELECT ?1, s.id, ?2, ?3, ?4 FROM sessions s WHERE s.repo_id IN (SELECT value FROM json_each(?5)) AND s.state = 'active'
 AND (CASE WHEN ?2 = 'overlap.detected' AND json_extract(?3, '$.sessionId') IS NOT NULL
        THEN s.id = json_extract(?3, '$.sessionId')
      ELSE json_array_length(?6) = 0
        OR (s.item_id IS NULL AND s.pull IS NULL AND NOT EXISTS (SELECT 1 FROM session_links l WHERE l.session_id = s.id))
        OR s.pull IN (SELECT value FROM json_each(?6))
        OR s.item_id IN (SELECT w.id FROM work_items w
             WHERE w.workspace = (SELECT rw.workspace FROM repo_workspaces rw WHERE rw.repo_id = s.repo_id)
               AND w.number IN (SELECT value FROM json_each(?6)))
        OR EXISTS (SELECT 1 FROM session_links l
             WHERE l.session_id = s.id AND l.kind = 'pull' AND l.number IN (SELECT value FROM json_each(?6)))
        OR EXISTS (SELECT 1 FROM session_links l JOIN work_items w ON w.id = l.item_id
             WHERE l.session_id = s.id AND l.kind = 'item' AND w.number IN (SELECT value FROM json_each(?6)))
      END)
 AND (?2 NOT IN ('session.started', 'session.ended') OR s.id != COALESCE(json_extract(?3, '$.session.id'), ''))
 AND (?2 NOT IN ('work.claimed', 'work.released', 'work.handoff_requested') OR s.id != COALESCE(json_extract(?3, '$.claim.sessionId'), ''))
 AND ({guard})"
    )
}
pub(super) const PENDING: &str = "SELECT id, kind, data, at FROM session_updates
 WHERE session_id = ? AND acknowledged_at IS NULL ORDER BY at, id LIMIT 100";
pub(super) const ACK: &str = "UPDATE session_updates SET acknowledged_at = COALESCE(acknowledged_at, ?)
 WHERE session_id = ? AND id = ?";
/// How many of the IDs (`?2`, a JSON list) name an update of session `?1`.
pub(super) const KNOWN: &str = "SELECT COUNT(*) AS n FROM session_updates
 WHERE session_id = ?1 AND id IN (SELECT value FROM json_each(?2))";
/// Session `?1`'s receipts acknowledged before `?2`.
pub(super) const PRUNE: &str = "DELETE FROM session_updates
 WHERE session_id = ?1 AND acknowledged_at IS NOT NULL AND acknowledged_at < ?2";
/// The payload of update `?1` as the change was finally made (`?2`), where
/// it was delivered as predicted (`?3`).
const CORRECT: &str = "UPDATE session_updates SET data = ?2 WHERE id = ?1 AND data = ?3";

/// The id of the update announcing `kind` for the change `key` names.
pub(crate) fn update_id(kind: &str, key: &str) -> String {
    let digest = Sha256::digest(format!("{kind}\n{key}").as_bytes());
    format!("upd_{}", &hex::encode(digest)[..26])
}

/// The work item and pull request numbers an event's `data` is about: its
/// `number` and `item`, the work items a dependency change newly waits on,
/// and the pull requests an integration failure names as suspects.
pub(crate) fn subjects(data: &serde_json::Value) -> Vec<u32> {
    let mut numbers: Vec<u32> = Vec::new();
    for key in ["number", "item", "pull"] {
        if let Some(n) = data.get(key).and_then(serde_json::Value::as_u64) {
            numbers.push(n as u32);
        }
    }
    for key in ["added", "suspects"] {
        if let Some(list) = data.get(key).and_then(serde_json::Value::as_array) {
            numbers.extend(list.iter().filter_map(serde_json::Value::as_u64).map(|n| n as u32));
        }
    }
    numbers.retain(|n| *n > 0);
    numbers.sort_unstable();
    numbers.dedup();
    numbers
}

/// An update written with the change it announces: which, and the payload
/// it was written with.
pub(crate) struct Sent {
    id: String,
    data: serde_json::Value,
}

#[derive(Deserialize)]
struct UpdateRow { id: String, kind: String, data: String, at: String }

impl Work {
    /// The update announcing `kind` (`data`, as the change is expected to
    /// leave things) for the change `key` names, to run in the same batch
    /// as that change, after it. `guard` (with `binds` from `?7`) holds
    /// only once the change is made. None for an event no session hears.
    pub(crate) fn delivery(
        &self,
        kind: &'static str,
        repo: &str,
        data: serde_json::Value,
        key: &str,
        guard: &str,
        binds: Vec<JsValue>,
    ) -> Result<Option<(D1PreparedStatement, Sent)>> {
        self.delivery_to(kind, &[repo.to_owned()], data, key, guard, binds)
    }

    /// [`delivery`](Work::delivery), to the sessions of every one of
    /// `repos`: a work item's are all those it is linked to.
    pub(crate) fn delivery_to(
        &self,
        kind: &'static str,
        repos: &[String],
        data: serde_json::Value,
        key: &str,
        guard: &str,
        binds: Vec<JsValue>,
    ) -> Result<Option<(D1PreparedStatement, Sent)>> {
        if !COORDINATION_EVENTS.contains(&kind) {
            return Ok(None);
        }
        let id = update_id(kind, key);
        let mut all: Vec<JsValue> = vec![
            id.as_str().into(),
            kind.into(),
            serde_json::to_string(&data)?.into(),
            rfc3339(now_ms()).into(),
            serde_json::to_string(repos)?.into(),
            serde_json::to_string(&subjects(&data))?.into(),
        ];
        all.extend(binds);
        let statement = self.db.prepare(deliver_sql(guard)).bind(&all)?;
        Ok(Some((statement, Sent { id, data })))
    }

    /// After the batch that made the change: its event as it was finally
    /// made (`actual`), published, and the inbox copy corrected where the
    /// change turned out other than expected.
    pub(crate) async fn delivered(
        &self,
        sent: Option<Sent>,
        kind: &'static str,
        repo: &str,
        actor: Option<String>,
        actual: serde_json::Value,
    ) -> Result<()> {
        if let Some(sent) = sent
            && sent.data != actual
        {
            self.db
                .prepare(CORRECT)
                .bind(&[
                    sent.id.as_str().into(),
                    serde_json::to_string(&actual)?.into(),
                    serde_json::to_string(&sent.data)?.into(),
                ])?
                .run()
                .await?;
        }
        self.publish_value(kind, repo, actor, actual).await
    }

    /// Publishes `kind` for a change already made elsewhere (a merge queue
    /// attempt's result, a blocker that closed), its updates written under
    /// `key`, which names that change: telling of the same change again,
    /// as a retried report would, reaches each session once.
    pub(crate) async fn publish_keyed(
        &self,
        kind: &'static str,
        repo: &str,
        actor: Option<String>,
        data: serde_json::Value,
        key: &str,
    ) -> Result<()> {
        if let Some((statement, _)) = self.delivery(kind, repo, data.clone(), key, "1", Vec::new())? {
            statement.run().await?;
        }
        self.publish_value(kind, repo, actor, data).await
    }

    /// [`publish_keyed`](Work::publish_keyed) for the sessions of every one
    /// of `repos`, the event filed under the first.
    pub(crate) async fn publish_keyed_to(
        &self,
        kind: &'static str,
        repos: &[String],
        actor: Option<String>,
        data: serde_json::Value,
        key: &str,
    ) -> Result<()> {
        if let Some((statement, _)) = self.delivery_to(kind, repos, data.clone(), key, "1", Vec::new())? {
            statement.run().await?;
        }
        self.publish_on(kind, repos.first().map(String::as_str), actor, data).await
    }

    /// An update for a change already made, written on its own: for the
    /// changes whose updates are not yet written with them.
    pub(crate) async fn deliver_update(&self, kind: &'static str, repo: &str, data: &serde_json::Value) -> Result<()> {
        let key = g1t_contracts::new_id("upd", now_ms());
        if let Some((statement, _)) = self.delivery(kind, repo, data.clone(), &key, "1", Vec::new())? {
            statement.run().await?;
        }
        Ok(())
    }

    pub(super) async fn pending_updates(&self, session: &str) -> Result<Vec<SessionUpdate>> {
        self.db.prepare(PENDING).bind(&[session.into()])?.all().await?.results::<UpdateRow>()?
            .into_iter().map(|row| Ok(SessionUpdate {
                id: row.id, kind: row.kind, data: serde_json::from_str(&row.data)?, at: row.at,
            })).collect()
    }

    /// Acknowledges `ids` for `session` and returns how many of them name
    /// one of its updates, so a caller can tell a mistyped ID from a
    /// receipt. Receipts older than [`RECEIPT_DAYS`] go then.
    pub(super) async fn acknowledge_updates(&self, session: &str, ids: &[String]) -> Result<u32> {
        if ids.is_empty() { return Ok(0); }
        let now = now_ms();
        let at = rfc3339(now);
        let mut statements = ids.iter().map(|id| self.db.prepare(ACK)
            .bind(&[at.as_str().into(), session.into(), id.as_str().into()])).collect::<Result<Vec<_>>>()?;
        let old = rfc3339(now.saturating_sub(RECEIPT_DAYS * 24 * 60 * 60 * 1000));
        statements.push(self.db.prepare(PRUNE).bind(&[session.into(), old.into()])?);
        self.db.batch(statements).await?;
        let mut unique = ids.to_vec();
        unique.sort();
        unique.dedup();
        let known = self.db.prepare(KNOWN).bind(&[session.into(), serde_json::to_string(&unique)?.into()])?
            .first::<NumberRow>(None).await?;
        Ok(known.map_or(0, |row| row.n))
    }
}

/// Adds a delivery's statement to `statements`, the batch of the change it
/// announces, and returns what was sent.
pub(crate) fn push_delivery(statements: &mut Vec<D1PreparedStatement>, delivery: Option<(D1PreparedStatement, Sent)>) -> Option<Sent> {
    delivery.map(|(statement, sent)| {
        statements.push(statement);
        sent
    })
}
