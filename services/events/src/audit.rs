//! The audit log, kept beside the event log. See `g1t_contracts::audit`.
//!
//! Rows are only ever appended. The one exception is a workspace rename,
//! which moves the workspace's rows to its new slug, as every service does
//! with what it keeps under a slug.

use g1t_contracts::audit::{
    AuditEntry, AuditPage, AuditVisibility, ListAuditArgs, MAX_AUDIT_PAGE, NewAuditEntry,
    RecordAuditArgs,
};
use g1t_contracts::events::{Event, WorkspaceRenamed};
use g1t_contracts::new_id;
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, Result};

const DEFAULT_PAGE: u32 = 100;
/// More than one request ever records.
const MAX_BATCH: usize = 50;
const MAX_TEXT: usize = 500;

fn text(value: &Option<String>) -> JsValue {
    value
        .as_deref()
        .map_or(JsValue::NULL, |value| JsValue::from(clip(value)))
}

fn clip(value: &str) -> String {
    value.chars().take(MAX_TEXT).collect()
}

#[derive(Deserialize)]
struct Row {
    id: String,
    time: String,
    workspace: String,
    actor_kind: String,
    actor: String,
    actor_id: String,
    agent: Option<String>,
    on_behalf_of: Option<String>,
    run_id: Option<String>,
    run_kind: Option<String>,
    credential_id: Option<String>,
    action: String,
    surface: String,
    repo: Option<String>,
    number: Option<f64>,
    git_ref: Option<String>,
    path: Option<String>,
    outcome: String,
    rule: String,
    result: Option<String>,
    message: Option<String>,
    request_id: String,
}

impl Row {
    /// Read back through the contract's own names, so the two cannot drift.
    fn into_entry(self) -> Option<AuditEntry> {
        let entry: NewAuditEntry = serde_json::from_value(serde_json::json!({
            "actorKind": self.actor_kind,
            "actor": self.actor,
            "actorId": self.actor_id,
            "agent": self.agent,
            "onBehalfOf": self.on_behalf_of,
            "runId": self.run_id,
            "runKind": self.run_kind,
            "credentialId": self.credential_id,
            "action": self.action,
            "surface": self.surface,
            "workspace": self.workspace,
            "repo": self.repo,
            "number": self.number.map(|n| n as u32),
            "gitRef": self.git_ref,
            "path": self.path,
            "outcome": self.outcome,
            "rule": self.rule,
            "result": self.result,
            "message": self.message,
            "requestId": self.request_id,
        }))
        .ok()?;
        Some(AuditEntry {
            id: self.id,
            time: self.time,
            entry,
        })
    }
}

/// Appends entries. Returns how many were kept: one without a workspace
/// or an actor belongs to nobody's log and is dropped.
pub async fn record(db: &D1Database, a: RecordAuditArgs) -> Result<u32> {
    let now = now_ms();
    let time = rfc3339(now);
    let mut statements = Vec::new();
    for entry in a.entries.into_iter().take(MAX_BATCH) {
        let Some(kind) = entry.actor.actor_kind else {
            continue;
        };
        if entry.target.workspace.is_empty() || entry.actor.actor.is_empty() {
            continue;
        }
        statements.push(
            db.prepare(
                "INSERT INTO audit_entries (id, time, workspace, actor_kind, actor, actor_id,
                   agent, on_behalf_of, run_id, run_kind, credential_id, action, surface, repo,
                   number, git_ref, path, outcome, rule, result, message, request_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                new_id("aud", now).into(),
                time.as_str().into(),
                entry.target.workspace.to_lowercase().into(),
                kind.as_str().into(),
                clip(&entry.actor.actor).into(),
                clip(&entry.actor.actor_id).into(),
                text(&entry.actor.agent),
                text(&entry.actor.on_behalf_of),
                text(&entry.actor.run_id),
                text(&entry.actor.run_kind),
                text(&entry.actor.credential_id),
                clip(&entry.action).into(),
                serde_json::to_value(entry.surface)?
                    .as_str()
                    .unwrap_or("rest")
                    .into(),
                text(&entry.target.repo),
                entry.target.number.map_or(JsValue::NULL, JsValue::from),
                text(&entry.target.git_ref),
                text(&entry.target.path),
                entry.outcome.as_str().into(),
                clip(&entry.rule).into(),
                text(&entry.result),
                text(&entry.message),
                clip(&entry.request_id).into(),
            ])?,
        );
    }
    let kept = statements.len() as u32;
    if kept > 0 {
        db.batch(statements).await?;
    }
    Ok(kept)
}

/// The conditions and values of a query, built together so they stay in
/// step.
#[derive(Default)]
struct Filter {
    conditions: Vec<String>,
    values: Vec<Param>,
}

/// A bound value, kept apart from `JsValue` so filters can be tested.
#[derive(Debug, PartialEq)]
enum Param {
    Text(String),
    Number(u32),
}

impl From<&str> for Param {
    fn from(value: &str) -> Self {
        Param::Text(value.to_owned())
    }
}

impl From<String> for Param {
    fn from(value: String) -> Self {
        Param::Text(value)
    }
}

impl From<u32> for Param {
    fn from(value: u32) -> Self {
        Param::Number(value)
    }
}

impl From<&Param> for JsValue {
    fn from(param: &Param) -> Self {
        match param {
            Param::Text(text) => JsValue::from(text.as_str()),
            Param::Number(number) => JsValue::from(*number),
        }
    }
}

impl Filter {
    fn add(&mut self, condition: &str, values: impl IntoIterator<Item = Param>) {
        self.conditions.push(condition.to_owned());
        self.values.extend(values);
    }
}

fn filter(a: &ListAuditArgs) -> Filter {
    let mut f = Filter::default();
    f.add("workspace = ?", [a.workspace.to_lowercase().into()]);
    if let AuditVisibility::Projects { username } = &a.visibility {
        f.add(
            "(repo IS NOT NULL OR actor = ? OR on_behalf_of = ?)",
            [username.as_str().into(), username.as_str().into()],
        );
    }
    if let Some(actor) = a.actor.as_deref().filter(|v| !v.is_empty()) {
        f.add(
            "(actor = ? OR on_behalf_of = ?)",
            [actor.into(), actor.into()],
        );
    }
    if let Some(agent) = a.agent.as_deref().filter(|v| !v.is_empty()) {
        f.add("agent = ?", [agent.into()]);
    }
    if let Some(action) = a.action.as_deref().filter(|v| !v.is_empty()) {
        f.add("action = ?", [action.into()]);
    }
    if let Some(repo) = a.repo.as_deref().filter(|v| !v.is_empty()) {
        f.add("repo = ? COLLATE NOCASE", [repo.into()]);
    }
    if let Some(number) = a.number {
        f.add("number = ?", [number.into()]);
    }
    if let Some(outcome) = a.outcome {
        f.add("outcome = ?", [outcome.as_str().into()]);
    }
    if let Some(kind) = a.actor_kind {
        f.add("actor_kind = ?", [kind.as_str().into()]);
    }
    if !a.run_ids.is_empty() {
        let ids: Vec<&String> = a.run_ids.iter().take(50).collect();
        let marks = vec!["?"; ids.len()].join(", ");
        f.add(
            &format!("run_id IN ({marks})"),
            ids.into_iter().map(|id| Param::from(id.as_str())),
        );
    }
    if let Some(since) = a.since.as_deref().filter(|v| !v.is_empty()) {
        f.add("time >= ?", [since.into()]);
    }
    if let Some(until) = a.until.as_deref().filter(|v| !v.is_empty()) {
        f.add("time < ?", [until.into()]);
    }
    if let Some(before) = a.before.as_deref().filter(|v| !v.is_empty()) {
        f.add("id < ?", [before.into()]);
    }
    f
}

/// Newest first. The caller has checked that the viewer may see the
/// workspace's log, and says how much of it in `visibility`.
pub async fn list(db: &D1Database, a: ListAuditArgs) -> Result<AuditPage> {
    let limit = a.limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_AUDIT_PAGE);
    let Filter { conditions, values } = filter(&a);
    let mut values: Vec<JsValue> = values.iter().map(JsValue::from).collect();
    values.push((limit + 1).into());
    let rows = db
        .prepare(format!(
            "SELECT * FROM audit_entries WHERE {} ORDER BY id DESC LIMIT ?",
            conditions.join(" AND ")
        ))
        .bind(&values)?
        .all()
        .await?
        .results::<Row>()?;
    let more = rows.len() > limit as usize;
    let entries: Vec<AuditEntry> = rows
        .into_iter()
        .take(limit as usize)
        .filter_map(Row::into_entry)
        .collect();
    let next = more
        .then(|| entries.last().map(|entry| entry.id.clone()))
        .flatten();
    Ok(AuditPage { entries, next })
}

/// Moves a renamed workspace's rows to its new slug.
pub async fn follow_renames(db: &D1Database, events: &[Event]) -> Result<()> {
    for event in events
        .iter()
        .filter(|event| event.kind == "workspace.renamed")
    {
        let Ok(renamed) = serde_json::from_value::<WorkspaceRenamed>(event.data.clone()) else {
            continue;
        };
        let (from, to) = (renamed.from.to_lowercase(), renamed.to.to_lowercase());
        if from == to {
            continue;
        }
        db.batch(vec![
            db.prepare(
                "UPDATE audit_entries SET repo = ? || substr(repo, length(?) + 1)
                 WHERE workspace = ? AND repo LIKE ? || '/%'",
            )
            .bind(&[
                to.as_str().into(),
                from.as_str().into(),
                from.as_str().into(),
                from.as_str().into(),
            ])?,
            db.prepare("UPDATE audit_entries SET workspace = ? WHERE workspace = ?")
                .bind(&[to.as_str().into(), from.as_str().into()])?,
        ])
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::audit::{ActorKind, AuditOutcome};

    fn args() -> ListAuditArgs {
        ListAuditArgs {
            workspace: "Acme".to_owned(),
            visibility: AuditVisibility::All,
            actor: None,
            agent: None,
            action: None,
            repo: None,
            number: None,
            outcome: None,
            actor_kind: None,
            run_ids: vec![],
            since: None,
            until: None,
            before: None,
            limit: None,
        }
    }

    #[test]
    fn an_owner_sees_the_whole_workspace() {
        let f = filter(&args());
        assert_eq!(f.conditions, ["workspace = ?"]);
        assert_eq!(f.values.len(), 1);
    }

    #[test]
    fn a_member_sees_projects_and_their_own() {
        let mut a = args();
        a.visibility = AuditVisibility::Projects {
            username: "ana".to_owned(),
        };
        let f = filter(&a);
        assert!(f.conditions[1].contains("repo IS NOT NULL"));
        assert_eq!(f.values.len(), 3);
    }

    #[test]
    fn every_filter_binds_its_values() {
        let mut a = args();
        a.actor = Some("syntaqx".to_owned());
        a.agent = Some("g1t-agent".to_owned());
        a.action = Some("git.push".to_owned());
        a.repo = Some("acme/rocket".to_owned());
        a.number = Some(4);
        a.outcome = Some(AuditOutcome::Denied);
        a.actor_kind = Some(ActorKind::Agent);
        a.run_ids = vec!["run_1".to_owned(), "run_2".to_owned()];
        a.since = Some("2026-10-01T00:00:00Z".to_owned());
        a.until = Some("2026-10-05T00:00:00Z".to_owned());
        a.before = Some("aud_9".to_owned());
        let f = filter(&a);
        let marks: usize = f.conditions.iter().map(|c| c.matches('?').count()).sum();
        assert_eq!(marks, f.values.len());
        assert!(f.conditions.iter().any(|c| c == "run_id IN (?, ?)"));
    }
}
