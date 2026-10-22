//! Coding agents' own telemetry (`record_agent_telemetry`): the usage and
//! cost the API's OTLP receiver read from a harness's OpenTelemetry, given
//! to the session it belongs to.
//!
//! Each export adds to what the session's earlier ones said, per signal,
//! model and tier (`agent_telemetry`): a delta adds, a running total
//! replaces a smaller one. The session then takes the whole: from its logs
//! when any arrived, else from its metrics, so no request is counted twice.
//! The cost is what the harness reported where it did, else its tokens at
//! list price ([`g1t_contracts::model_prices`]).
//!
//! A session is found by its person, harness and the harness's own id for
//! it, in any repository: one a plugin or hook started. Telemetry names no
//! repository unless it is told one (`g1t.repository`, or Claude Code's
//! `vcs.repository.*`), so a session nobody started begins there, as its
//! person, if they may work in it; otherwise its usage waits for 30 days
//! for a session to start. A session whose plugin reported usage of its
//! own, or one of whose subagents did, keeps the plugin's (a report from a
//! transcript, which counts every subagent once): telemetry never adds to
//! it, and gives up what it had set when the plugin reports.

use g1t_contracts::model_prices::{MAX_USAGE_MODELS, MAX_USAGE_TOKENS, ModelUsage};
use g1t_contracts::repos::RepoPath;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::tidy;
use crate::Work;

/// Adds one model's usage in one export to a session's (`?1`–`?6` the
/// key, `?7`–`?11` the counts, `?12` the cost reported, `?13` the
/// repository named, `?14` and `?15` when). `?16` is 1 for running
/// totals, which replace smaller ones, and 0 for deltas, which add.
pub(crate) const ADD_TELEMETRY: &str = "INSERT INTO agent_telemetry
       (actor_id, harness, harness_session_id, signal, model, tier,
        input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens,
        cost_usd, repo, first_at, last_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     ON CONFLICT (actor_id, harness, harness_session_id, signal, model, tier) DO UPDATE SET
       input_tokens = CASE WHEN ?16 THEN MAX(input_tokens, excluded.input_tokens) ELSE input_tokens + excluded.input_tokens END,
       output_tokens = CASE WHEN ?16 THEN MAX(output_tokens, excluded.output_tokens) ELSE output_tokens + excluded.output_tokens END,
       cache_write_5m_tokens = CASE WHEN ?16 THEN MAX(cache_write_5m_tokens, excluded.cache_write_5m_tokens)
         ELSE cache_write_5m_tokens + excluded.cache_write_5m_tokens END,
       cache_write_1h_tokens = CASE WHEN ?16 THEN MAX(cache_write_1h_tokens, excluded.cache_write_1h_tokens)
         ELSE cache_write_1h_tokens + excluded.cache_write_1h_tokens END,
       cache_read_tokens = CASE WHEN ?16 THEN MAX(cache_read_tokens, excluded.cache_read_tokens) ELSE cache_read_tokens + excluded.cache_read_tokens END,
       cost_usd = CASE WHEN excluded.cost_usd IS NULL THEN cost_usd
         WHEN ?16 THEN MAX(COALESCE(cost_usd, 0), excluded.cost_usd)
         ELSE COALESCE(cost_usd, 0) + excluded.cost_usd END,
       repo = COALESCE(excluded.repo, repo),
       first_at = MIN(first_at, excluded.first_at),
       last_at = MAX(last_at, excluded.last_at)";

/// A session's telemetry so far, by person `?1`, harness `?2` and id `?3`.
pub(crate) const TELEMETRY_OF: &str = "SELECT signal, model, tier, input_tokens, output_tokens, cache_write_5m_tokens,
       cache_write_1h_tokens, cache_read_tokens, cost_usd, repo, last_at
     FROM agent_telemetry WHERE actor_id = ?1 AND harness = ?2 AND harness_session_id = ?3";

/// A person's (`?2`) sessions with harness `?3` and the harness's id `?1`,
/// in any repository, oldest first, and whether its plugin reported usage
/// of its own for it or one of its subagents.
pub(crate) const SESSIONS_OF_HARNESS_ID: &str = "SELECT s.id,
       (s.usage IS NOT NULL AND s.usage_source IS NULL)
         OR EXISTS (SELECT 1 FROM sessions c WHERE c.parent_id = s.id AND c.usage IS NOT NULL AND c.usage_source IS NULL)
         AS reported
     FROM sessions s
     WHERE s.harness_session_id = ?1 AND s.actor_id = ?2 AND s.harness = ?3
     ORDER BY s.started_at, s.id";

/// Session `?5`'s usage (`?1`) and cost (`?2`) from telemetry, its model
/// (`?3`) if it had none, and seen at `?4` if it is active and was seen
/// before: unless its plugin has reported usage since it was read.
pub(crate) const SET_TELEMETRY_USAGE: &str = "UPDATE sessions
     SET usage = ?1, cost_usd = ?2, usage_source = 'otel', model = COALESCE(model, ?3),
         last_seen_at = CASE WHEN state = 'active' AND last_seen_at < ?4 THEN ?4 ELSE last_seen_at END
     WHERE id = ?5 AND (usage IS NULL OR usage_source IS NOT NULL)";

/// What telemetry gave session `?1`, taken back: its plugin reports.
pub(crate) const CLEAR_TELEMETRY_USAGE: &str = "UPDATE sessions SET usage = NULL, cost_usd = NULL WHERE id = ?1 AND usage_source = 'otel'";

/// Telemetry last added to before `?1`, a batch at a time.
pub(crate) const PRUNE_TELEMETRY: &str = "DELETE FROM agent_telemetry
     WHERE rowid IN (SELECT rowid FROM agent_telemetry WHERE last_at < ?1 LIMIT 200)";

/// One row of [`TELEMETRY_OF`].
#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct TelemetryRow {
    pub(crate) signal: String,
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) tier: String,
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) cache_write_5m_tokens: u64,
    pub(crate) cache_write_1h_tokens: u64,
    pub(crate) cache_read_tokens: u64,
    #[serde(default)]
    pub(crate) cost_usd: Option<f64>,
    #[serde(default)]
    pub(crate) repo: Option<String>,
    #[serde(default)]
    pub(crate) last_at: String,
}

impl TelemetryRow {
    fn usage(&self) -> ModelUsage {
        ModelUsage {
            model: self.model.clone(),
            tier: (!self.tier.is_empty()).then(|| self.tier.clone()),
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_write_5m_tokens: self.cache_write_5m_tokens,
            cache_write_1h_tokens: self.cache_write_1h_tokens,
            cache_read_tokens: self.cache_read_tokens,
        }
    }

    fn tokens(&self) -> u64 {
        [self.input_tokens, self.output_tokens, self.cache_write_5m_tokens, self.cache_write_1h_tokens, self.cache_read_tokens]
            .into_iter()
            .fold(0u64, u64::saturating_add)
    }
}

/// A session's usage from its telemetry: its logs' when any arrived, else
/// its metrics', one entry per model and tier (the [`MAX_USAGE_MODELS`]
/// most used); the cost, each model's as its harness reported it or else at
/// list price (none when nothing could be priced); and the model it used
/// most.
pub(crate) fn session_usage(rows: &[TelemetryRow]) -> (Vec<ModelUsage>, Option<f64>, Option<String>) {
    let from_logs = rows.iter().any(|row| row.signal == TelemetrySignal::Logs.as_str());
    let wanted = if from_logs { TelemetrySignal::Logs } else { TelemetrySignal::Metrics };
    let mut chosen: Vec<&TelemetryRow> = rows.iter().filter(|row| row.signal == wanted.as_str()).collect();
    chosen.sort_by(|a, b| b.tokens().cmp(&a.tokens()).then_with(|| a.model.cmp(&b.model)));
    chosen.truncate(MAX_USAGE_MODELS);
    let mut cost: Option<f64> = None;
    for row in &chosen {
        let priced = row.cost_usd.or_else(|| (row.tokens() > 0).then(|| row.usage().cost_usd()).flatten());
        if let Some(priced) = priced {
            cost = Some(cost.unwrap_or(0.0) + priced);
        }
    }
    let model = chosen.iter().find(|row| row.tokens() > 0 && row.model != UNKNOWN_MODEL).map(|row| row.model.clone());
    let usage = chosen.iter().filter(|row| row.tokens() > 0).map(|row| row.usage()).collect();
    (usage, cost, model)
}

/// What a usage with no model is kept under: a cost a harness reported
/// for no model in particular.
pub const UNKNOWN_MODEL: &str = "unknown";

/// A repository named as `owner/name`.
pub(crate) fn repo_path(named: &str) -> Option<RepoPath> {
    let (namespace, name) = named.trim().split_once('/')?;
    let valid = |part: &str| !part.is_empty() && !part.contains('/') && part.len() <= 100;
    (valid(namespace) && valid(name)).then(|| RepoPath { namespace: namespace.to_owned(), name: name.trim_end_matches(".git").to_owned() })
}

/// A cost as kept: a finite, non-negative number of dollars below a
/// million, or none.
fn kept_cost(cost: Option<f64>) -> Option<f64> {
    cost.filter(|cost| cost.is_finite() && *cost >= 0.0 && *cost < 1_000_000.0)
}

#[derive(Deserialize)]
struct FoundRow {
    id: String,
    #[serde(default)]
    reported: i64,
}

/// One session the telemetry is about, gathered from the sessions given.
struct Wanted {
    actor_id: String,
    harness: Harness,
    harness_session_id: String,
    repo: Option<String>,
    model: Option<String>,
    seen_at: String,
}

impl Work {
    pub(crate) async fn record_agent_telemetry(&self, a: RecordTelemetryArgs) -> Result<Outcome<TelemetryRecorded>> {
        if a.sessions.len() > MAX_TELEMETRY_SESSIONS || a.people.len() > MAX_TELEMETRY_PEOPLE {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("Give at most {MAX_TELEMETRY_SESSIONS} sessions of at most {MAX_TELEMETRY_PEOPLE} people."),
            ));
        }
        let now = now_ms();
        let at = rfc3339(now);
        let mut statements = Vec::new();
        let mut wanted: Vec<Wanted> = Vec::new();
        for session in &a.sessions {
            if !a.people.iter().any(|person| person.id == session.actor_id) {
                continue;
            }
            let Some(harness_id) = tidy(Some(&session.harness_session_id), MAX_TELEMETRY_ID_CHARS) else {
                continue;
            };
            // Never later than now: a clock ahead keeps nothing alive.
            let seen = if session.seen_at.is_empty() || session.seen_at > at { at.clone() } else { session.seen_at.clone() };
            let repo = session.repo.as_deref().and_then(repo_path).map(|path| format!("{}/{}", path.namespace, path.name));
            for one in &session.usage {
                let model = tidy(Some(&one.usage.model), 100).unwrap_or_else(|| UNKNOWN_MODEL.to_owned());
                let tier = tidy(one.usage.tier.as_deref(), 20).unwrap_or_default();
                let count = |n: u64| JsValue::from(n.min(MAX_USAGE_TOKENS) as f64);
                statements.push(self.db.prepare(ADD_TELEMETRY).bind(&[
                    session.actor_id.as_str().into(),
                    session.harness.as_str().into(),
                    harness_id.as_str().into(),
                    session.signal.as_str().into(),
                    model.as_str().into(),
                    tier.as_str().into(),
                    count(one.usage.input_tokens),
                    count(one.usage.output_tokens),
                    count(one.usage.cache_write_5m_tokens),
                    count(one.usage.cache_write_1h_tokens),
                    count(one.usage.cache_read_tokens),
                    kept_cost(one.cost_usd).map_or(JsValue::NULL, JsValue::from),
                    repo.as_deref().map_or(JsValue::NULL, JsValue::from),
                    seen.as_str().into(),
                    seen.as_str().into(),
                    JsValue::from(u8::from(session.cumulative)),
                ])?);
            }
            match wanted.iter_mut().find(|known| {
                known.actor_id == session.actor_id && known.harness == session.harness && known.harness_session_id == harness_id
            }) {
                Some(known) => {
                    known.repo = repo.or(known.repo.take());
                    known.model = session.model.clone().or(known.model.take());
                    if seen > known.seen_at {
                        known.seen_at = seen;
                    }
                }
                None => wanted.push(Wanted {
                    actor_id: session.actor_id.clone(),
                    harness: session.harness,
                    harness_session_id: harness_id,
                    repo,
                    model: session.model.clone(),
                    seen_at: seen,
                }),
            }
        }
        let kept_since = rfc3339(now.saturating_sub(TELEMETRY_KEEP_DAYS * 24 * 60 * 60 * 1000));
        statements.push(self.db.prepare(PRUNE_TELEMETRY).bind(&[kept_since.into()])?);
        // D1 takes a batch of up to a few hundred statements.
        for chunk in statements.chunks(100) {
            self.db.batch(chunk.to_vec()).await?;
        }

        let mut recorded = TelemetryRecorded::default();
        for one in wanted {
            let key = [one.actor_id.as_str().into(), one.harness.as_str().into(), one.harness_session_id.as_str().into()];
            let rows: Vec<TelemetryRow> = self.db.prepare(TELEMETRY_OF).bind(&key)?.all().await?.results()?;
            let mut found: Vec<FoundRow> = self
                .db
                .prepare(SESSIONS_OF_HARNESS_ID)
                .bind(&[one.harness_session_id.as_str().into(), one.actor_id.as_str().into(), one.harness.as_str().into()])?
                .all()
                .await?
                .results()?;
            if found.is_empty()
                && let Some(person) = a.people.iter().find(|person| person.id == one.actor_id)
                && let Some(id) = self.start_from_telemetry(person, a.workspace.as_deref(), &one, &rows, now).await?
            {
                found.push(FoundRow { id, reported: 0 });
            }
            if found.is_empty() {
                recorded.waiting += 1;
                continue;
            }
            if found.iter().any(|row| row.reported != 0) {
                let clear: Vec<_> = found
                    .iter()
                    .filter(|row| row.reported == 0)
                    .map(|row| self.db.prepare(CLEAR_TELEMETRY_USAGE).bind(&[row.id.as_str().into()]))
                    .collect::<Result<_>>()?;
                if !clear.is_empty() {
                    self.db.batch(clear).await?;
                }
                recorded.reported_by_plugin += 1;
                continue;
            }
            let (usage, cost, model) = session_usage(&rows);
            let json = serde_json::to_string(&usage).unwrap_or_else(|_| "[]".to_owned());
            self.db
                .prepare(SET_TELEMETRY_USAGE)
                .bind(&[
                    json.into(),
                    cost.map_or(JsValue::NULL, JsValue::from),
                    model.or(one.model).as_deref().map_or(JsValue::NULL, JsValue::from),
                    one.seen_at.as_str().into(),
                    found[0].id.as_str().into(),
                ])?
                .run()
                .await?;
            recorded.recorded += 1;
        }
        Ok(Outcome::Ok(recorded))
    }

    /// Starts the session telemetry is about, as its person, in the
    /// repository it names (or named in an earlier export): only while it is
    /// live, in a repository the person may work in, and for a workspace
    /// token, one of its workspace's. Its id, or none.
    async fn start_from_telemetry(
        &self,
        person: &User,
        workspace: Option<&str>,
        one: &Wanted,
        rows: &[TelemetryRow],
        now: u64,
    ) -> Result<Option<String>> {
        let quiet_since = rfc3339(now.saturating_sub(SESSION_TIMEOUT_MS));
        if one.seen_at < quiet_since {
            return Ok(None);
        }
        let named = one.repo.clone().or_else(|| {
            let mut named: Vec<&TelemetryRow> = rows.iter().filter(|row| row.repo.is_some()).collect();
            named.sort_by(|a, b| b.last_at.cmp(&a.last_at));
            named.first().and_then(|row| row.repo.clone())
        });
        let Some(repo) = named.as_deref().and_then(repo_path) else {
            return Ok(None);
        };
        if workspace.is_some_and(|workspace| !workspace.eq_ignore_ascii_case(&repo.namespace)) {
            return Ok(None);
        }
        let started = self
            .start_session(StartSessionArgs {
                actor: person.clone(),
                repo,
                harness: one.harness,
                harness_session_id: Some(one.harness_session_id.clone()),
                item: None,
                pull: None,
                branch: None,
                title: None,
                head_commit: None,
                parent_id: None,
                agent_type: None,
                task: None,
                prompt: None,
                model: one.model.clone(),
            })
            .await?;
        Ok(match started {
            Outcome::Ok(session) => Some(session.id),
            Outcome::Fail(_) => None,
        })
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, OptionalExtension, params};

    use super::*;
    use crate::coordination::sessions::{SET_USAGE, insert_session_sql};

    const AT: &str = "2026-10-22T18:00:00.000Z";

    fn database() -> Connection {
        let db = crate::migrated::database_at(":memory:");
        db.execute_batch(
            "INSERT INTO repo_workspaces (repo_id, workspace, path, private) VALUES ('rep_1', 'acme', 'acme/web', 1);",
        )
        .unwrap();
        db
    }

    /// Starts a session the way `start_session` does.
    fn start(db: &Connection, id: &str, harness_id: &str, parent: Option<&str>) {
        db.query_row(
            &insert_session_sql(),
            params![
                id, "rep_1", None::<String>, None::<u32>, "main", "usr_1", "ana", "claude_code", harness_id, None::<String>,
                None::<String>, AT, AT, parent, None::<String>, None::<String>, None::<String>, None::<String>
            ],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    }

    /// One export of one model's usage, as `record_agent_telemetry` adds it.
    #[allow(clippy::too_many_arguments)]
    fn add(db: &Connection, signal: &str, model: &str, input: u64, output: u64, cache_read: u64, cost: Option<f64>, cumulative: bool) {
        db.execute(
            ADD_TELEMETRY,
            params![
                "usr_1", "claude_code", "abc", signal, model, "", input, output, 0, 0, cache_read, cost, None::<String>, AT, AT,
                u8::from(cumulative)
            ],
        )
        .unwrap();
    }

    fn rows(db: &Connection) -> Vec<TelemetryRow> {
        let mut statement = db.prepare(TELEMETRY_OF).unwrap();
        statement
            .query_map(params!["usr_1", "claude_code", "abc"], |row| {
                Ok(TelemetryRow {
                    signal: row.get(0)?,
                    model: row.get(1)?,
                    tier: row.get(2)?,
                    input_tokens: row.get(3)?,
                    output_tokens: row.get(4)?,
                    cache_write_5m_tokens: row.get(5)?,
                    cache_write_1h_tokens: row.get(6)?,
                    cache_read_tokens: row.get(7)?,
                    cost_usd: row.get(8)?,
                    repo: row.get(9)?,
                    last_at: row.get(10)?,
                })
            })
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn reported(db: &Connection) -> Vec<(String, bool)> {
        let mut statement = db.prepare(SESSIONS_OF_HARNESS_ID).unwrap();
        statement
            .query_map(params!["abc", "usr_1", "claude_code"], |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn deltas_add_up_and_running_totals_keep_the_largest() {
        let db = database();
        add(&db, "logs", "claude-opus-5-5", 100, 10, 1000, Some(0.5), false);
        add(&db, "logs", "claude-opus-5-5", 50, 5, 0, Some(0.25), false);
        add(&db, "metrics", "claude-opus-5-5", 120, 12, 0, None, true);
        add(&db, "metrics", "claude-opus-5-5", 90, 9, 0, Some(0.1), true);
        let rows = rows(&db);
        let logs = rows.iter().find(|row| row.signal == "logs").unwrap();
        assert_eq!((logs.input_tokens, logs.output_tokens, logs.cache_read_tokens), (150, 15, 1000));
        assert!(close(logs.cost_usd.unwrap(), 0.75));
        let metrics = rows.iter().find(|row| row.signal == "metrics").unwrap();
        assert_eq!((metrics.input_tokens, metrics.output_tokens), (120, 12));
        assert!(close(metrics.cost_usd.unwrap(), 0.1));
    }

    #[test]
    fn a_session_counts_its_logs_or_else_its_metrics_never_both() {
        let db = database();
        add(&db, "metrics", "claude-opus-5-5", 1_000_000, 0, 0, None, false);
        let (usage, cost, model) = session_usage(&rows(&db));
        // Metrics alone: Opus 5.5's list price, $4 a million input tokens.
        assert_eq!(usage.len(), 1);
        assert!(close(cost.unwrap(), 4.0));
        assert_eq!(model.as_deref(), Some("claude-opus-5-5"));
        add(&db, "logs", "claude-opus-5-5", 10, 0, 0, Some(0.02), false);
        let (usage, cost, _) = session_usage(&rows(&db));
        assert_eq!(usage[0].input_tokens, 10, "logs arrived: metrics no longer count");
        assert!(close(cost.unwrap(), 0.02), "the cost the harness reported, not list price");
    }

    #[test]
    fn a_cost_reported_for_no_model_counts_and_unknown_models_are_not_priced() {
        let rows = vec![
            TelemetryRow { signal: "logs".into(), model: "gpt-5.3-codex".into(), input_tokens: 1_000_000, ..Default::default() },
            TelemetryRow { signal: "logs".into(), model: "mystery-1".into(), output_tokens: 7, ..Default::default() },
            TelemetryRow { signal: "logs".into(), model: UNKNOWN_MODEL.into(), cost_usd: Some(0.5), ..Default::default() },
        ];
        let (usage, cost, model) = session_usage(&rows);
        assert!(close(cost.unwrap(), 1.75 + 0.5));
        assert_eq!(usage.len(), 2, "a cost alone adds no usage");
        assert_eq!(model.as_deref(), Some("gpt-5.3-codex"));
        let (_, cost, _) = session_usage(&[TelemetryRow { signal: "logs".into(), model: "mystery-1".into(), output_tokens: 7, ..Default::default() }]);
        assert_eq!(cost, None);
    }

    #[test]
    fn a_plugins_own_usage_wins_over_telemetry() {
        let db = database();
        start(&db, "ses_1", "abc", None);
        start(&db, "ses_2", "abc/agent/x", Some("ses_1"));
        assert_eq!(reported(&db), vec![("ses_1".to_owned(), false)]);
        // Telemetry gives the session its usage.
        let changed = db.execute(SET_TELEMETRY_USAGE, params!["[]", 1.5, "claude-opus-5-5", "2026-10-22T18:05:00.000Z", "ses_1"]).unwrap();
        assert_eq!(changed, 1);
        let source: Option<String> = db.query_row("SELECT usage_source FROM sessions WHERE id = 'ses_1'", [], |row| row.get(0)).unwrap();
        assert_eq!(source.as_deref(), Some("otel"));
        assert_eq!(reported(&db), vec![("ses_1".to_owned(), false)], "telemetry's usage is not the plugin's");
        // A subagent's plugin report: the whole tree is the plugin's now.
        db.execute(SET_USAGE, params!["[]", 0.2, "ses_2"]).unwrap();
        assert_eq!(reported(&db), vec![("ses_1".to_owned(), true)]);
        db.execute(CLEAR_TELEMETRY_USAGE, params!["ses_1"]).unwrap();
        let cost: Option<f64> = db.query_row("SELECT cost_usd FROM sessions WHERE id = 'ses_1'", [], |row| row.get(0)).unwrap();
        assert_eq!(cost, None, "what telemetry set is taken back");
        // The plugin reports the session itself: telemetry never replaces it.
        db.execute(SET_USAGE, params!["[]", 3.0, "ses_1"]).unwrap();
        let changed = db.execute(SET_TELEMETRY_USAGE, params!["[]", 9.0, None::<String>, AT, "ses_1"]).unwrap();
        assert_eq!(changed, 0);
        let (cost, source): (f64, Option<String>) =
            db.query_row("SELECT cost_usd, usage_source FROM sessions WHERE id = 'ses_1'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!((cost, source), (3.0, None));
    }

    #[test]
    fn telemetry_keeps_an_ended_session_ended_and_a_live_one_seen() {
        let db = database();
        start(&db, "ses_1", "abc", None);
        db.execute(SET_TELEMETRY_USAGE, params!["[]", 1.0, None::<String>, "2026-10-22T18:09:00.000Z", "ses_1"]).unwrap();
        let seen: String = db.query_row("SELECT last_seen_at FROM sessions WHERE id = 'ses_1'", [], |row| row.get(0)).unwrap();
        assert_eq!(seen, "2026-10-22T18:09:00.000Z");
        db.execute("UPDATE sessions SET state = 'ended' WHERE id = 'ses_1'", []).unwrap();
        db.execute(SET_TELEMETRY_USAGE, params!["[]", 2.0, None::<String>, "2026-10-22T18:30:00.000Z", "ses_1"]).unwrap();
        let (seen, state, cost): (String, String, f64) = db
            .query_row("SELECT last_seen_at, state, cost_usd FROM sessions WHERE id = 'ses_1'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap();
        assert_eq!((seen.as_str(), state.as_str(), cost), ("2026-10-22T18:09:00.000Z", "ended", 2.0));
    }

    #[test]
    fn old_telemetry_is_pruned() {
        let db = database();
        add(&db, "logs", "claude-opus-5-5", 1, 0, 0, None, false);
        db.execute(PRUNE_TELEMETRY, params!["2026-10-01T00:00:00.000Z"]).unwrap();
        assert_eq!(rows(&db).len(), 1);
        db.execute(PRUNE_TELEMETRY, params!["2026-11-01T00:00:00.000Z"]).unwrap();
        assert!(rows(&db).is_empty());
        let none: Option<i64> = db.query_row("SELECT 1 FROM agent_telemetry", [], |row| row.get(0)).optional().unwrap();
        assert_eq!(none, None);
    }

    #[test]
    fn a_repository_is_named_owner_slash_name() {
        assert_eq!(repo_path("acme/web"), Some(RepoPath { namespace: "acme".into(), name: "web".into() }));
        assert_eq!(repo_path(" acme/web.git "), Some(RepoPath { namespace: "acme".into(), name: "web".into() }));
        for bad in ["", "acme", "acme/", "/web", "a/b/c"] {
            assert_eq!(repo_path(bad), None, "{bad}");
        }
    }
}
