//! Agent runs: every sandbox g1t starts for an agent, and for checks and
//! the merge queue, as a record people can watch, stop and look back on.
//!
//! The runner service opens a run as it starts a sandbox (`open_run`) and
//! the sandbox reports its steps through the API with the run's one-time
//! token (`report_run`), as checks do. The runner closes it when the
//! sandbox stops. Members stop a run with `stop_run`; the runner then
//! destroys its sandbox.
//!
//! Sessions are the read side of what agents record on a pull request:
//! `list_sessions` and `get_session`.

use g1t_contracts::agents::*;
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{PullStatus, SessionEntry, StallArgs};
use g1t_contracts::{FailureCode, Membership, Outcome, User, Viewer, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::checks::{hash, new_token};
use crate::rows::SessionRow;
use crate::{Work, optional};

/// The most steps a run keeps; older ones fall off the start.
const MAX_STEPS: u32 = 200;
/// The most steps taken from one report.
const MAX_STEPS_PER_REPORT: usize = 20;
/// The longest a step is kept.
const MAX_STEP_CHARS: usize = 240;
/// A run that has said nothing for this long is taken to have died.
const SILENT_HOURS: u64 = 3;
const DEFAULT_LIST: u32 = 50;
const MAX_LIST: u32 = 200;
/// The most session entries one view returns.
const SESSION_ENTRIES: u32 = 2000;

/// Every column but the steps, which only a run's own page needs.
const COLUMNS: &str = "id, workspace, repo_id, repo, number, pull_id, kind, agent, model, status,
  step, step_count, cost_usd, turns, sandbox, token_hash, started_by, error, created_at,
  started_at, finished_at, updated_at, budget_usd, time_cap_minutes, halted,
  COALESCE((SELECT title FROM pulls WHERE pulls.id = agent_runs.pull_id), agent_runs.title) AS title,
  (SELECT detail FROM run_confidence WHERE run_confidence.run_id = agent_runs.id) AS confidence";

#[derive(Deserialize)]
pub(crate) struct RunRow {
    id: String,
    #[allow(dead_code)]
    workspace: String,
    #[allow(dead_code)]
    repo_id: String,
    repo: String,
    number: Option<u32>,
    pub(crate) pull_id: Option<String>,
    kind: String,
    agent: String,
    model: Option<String>,
    status: String,
    step: Option<String>,
    #[serde(default)]
    steps: Option<String>,
    step_count: u32,
    cost_usd: Option<f64>,
    turns: Option<u32>,
    sandbox: String,
    token_hash: String,
    started_by: Option<String>,
    error: Option<String>,
    created_at: String,
    started_at: Option<String>,
    finished_at: Option<String>,
    updated_at: String,
    title: Option<String>,
    #[serde(default)]
    budget_usd: Option<f64>,
    #[serde(default)]
    time_cap_minutes: Option<u32>,
    #[serde(default)]
    halted: Option<String>,
    /// JSON of how sure g1t was of the change as the run left it.
    #[serde(default)]
    confidence: Option<String>,
}

impl RunRow {
    fn status(&self) -> RunStatus {
        RunStatus::parse(&self.status).unwrap_or(RunStatus::Failed)
    }

    /// The run as `member` (or not) may see it: model and cost are the
    /// workspace's business.
    fn into_run(self, member: bool) -> AgentRun {
        let (namespace, name) = self.repo.split_once('/').unwrap_or((&self.repo, ""));
        AgentRun {
            repo: RepoPath {
                namespace: namespace.to_owned(),
                name: name.to_owned(),
            },
            status: self.status(),
            kind: RunKind::parse(&self.kind).unwrap_or(RunKind::Implement),
            steps: self
                .steps
                .as_deref()
                .and_then(|steps| serde_json::from_str(steps).ok())
                .unwrap_or_default(),
            id: self.id,
            number: self.number.filter(|number| *number > 0),
            title: self.title,
            agent: self.agent,
            model: self.model.filter(|_| member),
            step: self.step,
            step_count: self.step_count,
            started_by: self.started_by,
            error: self.error,
            cost_usd: self.cost_usd.filter(|_| member),
            turns: self.turns,
            budget_usd: self.budget_usd.filter(|_| member),
            time_cap_minutes: self.time_cap_minutes,
            halted: self.halted,
            confidence: self
                .confidence
                .as_deref()
                .and_then(|detail| serde_json::from_str(detail).ok()),
            created_at: self.created_at,
            started_at: self.started_at,
            finished_at: self.finished_at,
            updated_at: self.updated_at,
        }
    }
}

/// One line, short enough to read at a glance.
pub(crate) fn one_line(text: &str, limit: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= limit {
        return line;
    }
    let mut short: String = line.chars().take(limit.saturating_sub(1)).collect();
    short.push('…');
    short
}

/// A principal that can read any repository of `namespace`, for lookups a
/// trusted service asks for. What it is given reads and nothing more.
pub(crate) fn member_of(actor: &User, namespace: &str) -> Viewer {
    let mut viewer = actor.clone();
    let slug = namespace.to_lowercase();
    if !viewer.is_member(&slug) {
        viewer.workspaces.push(Membership {
            base_permission: Some(g1t_contracts::access::BasePermission::Read),
            ..Membership::member(slug)
        });
    }
    Some(viewer)
}

/// Whether the viewer belongs to the workspace: what a run spent, its model
/// and its budget are the workspace's business, not every reader's (an
/// outside collaborator sees the work, not the bill).
fn is_member(viewer: &Viewer, namespace: &str) -> bool {
    viewer
        .as_ref()
        .is_some_and(|viewer| viewer.is_member(&namespace.to_lowercase()))
}

#[derive(Deserialize)]
struct SessionListRow {
    pull_id: String,
    number: u32,
    title: String,
    status: PullStatus,
    agent: String,
    entries: u32,
    tools: u32,
    started_at: String,
    last_at: String,
    prompt: Option<String>,
}

#[derive(Deserialize)]
struct RunSumRow {
    pull_id: String,
    kind: String,
    status: String,
    cost_usd: Option<f64>,
}

impl Work {
    /// The repository at `path`, if `viewer` may see it, and whether they
    /// are a member of its workspace (which shows what runs cost).
    async fn visible_repo(&self, path: &RepoPath, viewer: &Viewer) -> Result<Outcome<(Repo, bool)>> {
        Ok(match self.repo(path, viewer).await? {
            Outcome::Ok(repo) => {
                let member = is_member(viewer, &repo.namespace);
                Outcome::Ok((repo, member))
            }
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    }

    async fn run_row(&self, id: &str) -> Result<Option<RunRow>> {
        self.db
            .prepare(format!("SELECT {COLUMNS}, steps FROM agent_runs WHERE id = ?"))
            .bind(&[id.into()])?
            .first::<RunRow>(None)
            .await
    }

    /// The run on pull request `number` that is at work now, if one is.
    pub(crate) async fn active_run_on(&self, repo_id: &str, number: u32) -> Result<Option<String>> {
        self.db
            .prepare(
                "SELECT id AS value FROM agent_runs
                 WHERE repo_id = ? AND number = ? AND status IN ('queued', 'running')
                 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(&[repo_id.into(), number.into()])?
            .first::<String>(Some("value"))
            .await
    }

    pub(crate) async fn open_run(&self, a: OpenRunArgs) -> Result<Outcome<AgentRunTicket>> {
        // The runner is trusted: it names the repository it is starting a
        // sandbox in, whoever the sandbox acts as.
        let (repo_id, namespace) = match &a.pull_id {
            Some(pull_id) => match self.pull_by_id(pull_id).await? {
                Some(pull) => (pull.repo_id, a.repo.namespace.to_lowercase()),
                None => return Ok(Outcome::fail(FailureCode::NotFound, "Pull request not found.")),
            },
            None => match self.repo(&a.repo, &member_of(&a.actor, &a.repo.namespace)).await? {
                Outcome::Ok(repo) => (repo.id, repo.namespace.to_lowercase()),
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            },
        };
        // Nothing new starts on an archived or deleted repository.
        if !self.repo_active(&repo_id).await? {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!("{}/{} is archived or deleted, so nothing new starts on it.", a.repo.namespace, a.repo.name),
            ));
        }
        let now = now_ms();
        let id = new_id("arn", now);
        let token = new_token();
        let timestamp = rfc3339(now);
        let agent = a
            .agent
            .clone()
            .unwrap_or_else(|| if a.kind.is_agent() { "g1t-agent" } else { "g1t" }.to_owned());
        self.db
            .prepare(
                "INSERT INTO agent_runs
                   (id, workspace, repo_id, repo, number, pull_id, title, kind, agent, model, status,
                    sandbox, token_hash, started_by, created_at, updated_at, budget_usd, time_cap_minutes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                namespace.into(),
                repo_id.into(),
                format!("{}/{}", a.repo.namespace, a.repo.name).into(),
                a.number.filter(|n| *n > 0).map_or(JsValue::NULL, JsValue::from),
                optional(&a.pull_id),
                optional(&a.title.map(|title| one_line(&title, 200))),
                a.kind.as_str().into(),
                agent.into(),
                optional(&a.model),
                a.sandbox.into(),
                hash(&token).into(),
                optional(&a.started_by),
                timestamp.as_str().into(),
                timestamp.as_str().into(),
                a.budget_usd.filter(|usd| usd.is_finite() && *usd > 0.0).map_or(JsValue::NULL, JsValue::from),
                a.time_cap_minutes.map_or(JsValue::NULL, JsValue::from),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(AgentRunTicket { run_id: id, token }))
    }

    /// Adds `text` to a run's steps, keeping the latest `MAX_STEPS`.
    pub(crate) fn add_step(&self, run_id: &str, at: &str, text: &str) -> Result<worker::D1PreparedStatement> {
        self.db
            .prepare(
                "UPDATE agent_runs SET
                   steps = CASE WHEN json_array_length(steps) >= ?4
                     THEN json_insert(json_remove(steps, '$[0]'), '$[#]', json_object('at', ?1, 'text', ?2))
                     ELSE json_insert(steps, '$[#]', json_object('at', ?1, 'text', ?2)) END,
                   step_count = step_count + 1
                 WHERE id = ?3",
            )
            .bind(&[at.into(), text.into(), run_id.into(), MAX_STEPS.into()])
    }

    pub(crate) async fn report_run(&self, a: ReportRunArgs) -> Result<Outcome<RunStatus>> {
        let Some(run) = self
            .run_row(&a.run_id)
            .await?
            .filter(|run| run.token_hash == hash(&a.token))
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Run not found."));
        };
        // Finished, or stopped by a person: nothing more is taken, and the
        // sandbox learns why.
        if run.finished_at.is_some() {
            return Ok(Outcome::Ok(run.status()));
        }
        // It reached a cap of its guardrails (guardrails.rs).
        if let Some(halt) = a.halt {
            let pull_id = run.pull_id.as_deref();
            return self
                .halt_run(&run.id, &run.repo_id, pull_id, run.number, &run.kind, halt, a.error, a.cost_usd)
                .await;
        }
        let now = rfc3339(now_ms());
        let steps: Vec<String> = a
            .steps
            .iter()
            .map(|step| one_line(step, MAX_STEP_CHARS))
            .filter(|step| !step.is_empty())
            .collect();
        // A burst keeps its end: that is where the run is now.
        let skip = steps.len().saturating_sub(MAX_STEPS_PER_REPORT);
        let mut statements = Vec::new();
        for step in &steps[skip..] {
            statements.push(self.add_step(&run.id, &now, step)?);
        }
        let current = a
            .step
            .as_deref()
            .map(|step| one_line(step, MAX_STEP_CHARS))
            .filter(|step| !step.is_empty())
            .or_else(|| steps.last().cloned());
        let outcome = a
            .outcome
            .filter(|outcome| matches!(outcome, RunStatus::Succeeded | RunStatus::Failed));
        let cost = a.cost_usd.filter(|cost| cost.is_finite() && *cost >= 0.0);
        statements.push(
            self.db
                .prepare(
                    "UPDATE agent_runs SET
                       status = COALESCE(?1, CASE WHEN status = 'queued' THEN 'running' ELSE status END),
                       started_at = COALESCE(started_at, ?2),
                       step = COALESCE(?3, step),
                       cost_usd = COALESCE(?4, cost_usd),
                       turns = COALESCE(?5, turns),
                       error = COALESCE(?6, error),
                       finished_at = CASE WHEN ?1 IS NULL THEN finished_at ELSE ?2 END,
                       updated_at = ?2
                     WHERE id = ?7 AND finished_at IS NULL",
                )
                .bind(&[
                    outcome.map_or(JsValue::NULL, |outcome| outcome.as_str().into()),
                    now.as_str().into(),
                    optional(&current),
                    cost.map_or(JsValue::NULL, JsValue::from),
                    a.turns.map_or(JsValue::NULL, JsValue::from),
                    optional(&a.error.map(|error| one_line(&error, 1000))),
                    run.id.as_str().into(),
                ])?,
        );
        self.db.batch(statements).await?;
        Ok(Outcome::Ok(outcome.unwrap_or(RunStatus::Running)))
    }

    pub(crate) async fn stop_run(&self, a: StopRunArgs) -> Result<Outcome<StoppedRun>> {
        let viewer = Some(a.actor.clone());
        let (repo, _) = match self.visible_repo(&a.repo, &viewer).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
        }
        if let Outcome::Fail(failure) =
            crate::allowed(Some(&a.actor), &repo, g1t_contracts::access::Capability::Run)
        {
            return Ok(Outcome::Fail(failure));
        }
        let Some(run) = self
            .run_row(&a.id)
            .await?
            .filter(|run| run.repo_id == repo.id)
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Run not found."));
        };
        if !run.status().is_active() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("This run has already {}.", match run.status() {
                    RunStatus::Stopped => "been stopped",
                    RunStatus::Succeeded => "finished",
                    _ => "ended",
                }),
            ));
        }
        let now = rfc3339(now_ms());
        let said = format!("Stopped by {}.", a.actor.username);
        let claimed = self
            .db
            .prepare(
                "UPDATE agent_runs SET status = 'stopped', step = ?, finished_at = ?, updated_at = ?
                 WHERE id = ? AND status IN ('queued', 'running') RETURNING id AS value",
            )
            .bind(&[
                said.as_str().into(),
                now.as_str().into(),
                now.as_str().into(),
                run.id.as_str().into(),
            ])?
            .first::<String>(Some("value"))
            .await?;
        if claimed.is_none() {
            return Ok(Outcome::fail(FailureCode::Conflict, "This run has already ended."));
        }
        self.add_step(&run.id, &now, &said)?.run().await?;
        // g1t stops seeing the pull request through, so it does not start
        // the same work again; a person decides what happens next.
        if let (Some(pull_id), Some(number)) = (&run.pull_id, run.number) {
            self.stall(StallArgs {
                pull_id: pull_id.clone(),
                reason: format!(
                    "{} stopped the agent's {} run. Ask for a review, a revision or a catch-up to start again.",
                    a.actor.username, run.kind
                ),
            })
            .await?;
            self.note(
                &repo.id,
                number,
                (a.actor.id.as_str(), a.actor.username.as_str()),
                &format!("stopped {}'s {} run", run.agent, run.kind),
            )
            .await?;
        }
        let sandbox = run.sandbox.clone();
        let Some(row) = self.run_row(&run.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Run not found."));
        };
        Ok(Outcome::Ok(StoppedRun {
            run: row.into_run(true),
            sandbox,
        }))
    }

    /// Runs whose sandbox died without anyone noticing, marked failed.
    pub(crate) async fn sweep_silent(&self) -> Result<()> {
        let now = now_ms();
        let cutoff = rfc3339(now.saturating_sub(SILENT_HOURS * 3_600_000));
        self.db
            .prepare(
                "UPDATE agent_runs
                 SET status = 'failed', error = COALESCE(error, 'It stopped reporting.'),
                     finished_at = ?, updated_at = ?
                 WHERE status IN ('queued', 'running') AND updated_at < ?",
            )
            .bind(&[rfc3339(now).into(), rfc3339(now).into(), cutoff.into()])?
            .run()
            .await?;
        Ok(())
    }

    pub(crate) async fn list_runs(&self, a: ListRunsArgs) -> Result<Outcome<Vec<AgentRun>>> {
        let (column, key, member) = if let Some(workspace) = &a.workspace {
            let slug = workspace.to_lowercase();
            if !is_member(&a.viewer, &slug) {
                return Ok(Outcome::fail(
                    FailureCode::Forbidden,
                    "Only members of the workspace can see its fleet.",
                ));
            }
            ("workspace", slug, true)
        } else if let Some(path) = &a.repo {
            match self.visible_repo(path, &a.viewer).await? {
                Outcome::Ok((repo, member)) => ("repo_id", repo.id, member),
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            }
        } else {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name a repository or a workspace."));
        };
        self.sweep_silent().await?;
        let limit = a.limit.unwrap_or(DEFAULT_LIST).clamp(1, MAX_LIST);
        let rows = self
            .db
            .prepare(format!(
                "SELECT {COLUMNS} FROM agent_runs
                 WHERE {column} = ?1
                   AND (?2 = 0 OR status IN ('queued', 'running'))
                   AND (?3 IS NULL OR kind = ?3)
                   AND (?4 IS NULL OR status = ?4)
                   AND (?5 IS NULL OR number = ?5)
                 ORDER BY created_at DESC LIMIT ?6"
            ))
            .bind(&[
                key.into(),
                u32::from(a.active).into(),
                a.kind.map_or(JsValue::NULL, |kind| kind.as_str().into()),
                a.status.map_or(JsValue::NULL, |status| status.as_str().into()),
                a.number.map_or(JsValue::NULL, JsValue::from),
                limit.into(),
            ])?
            .all()
            .await?
            .results::<RunRow>()?;
        Ok(Outcome::Ok(rows.into_iter().map(|row| row.into_run(member)).collect()))
    }

    pub(crate) async fn get_run(&self, a: GetRunArgs) -> Result<Outcome<AgentRun>> {
        let (repo, member) = match self.visible_repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        Ok(match self.run_row(&a.id).await?.filter(|run| run.repo_id == repo.id) {
            Some(row) => Outcome::Ok(row.into_run(member)),
            None => Outcome::fail(FailureCode::NotFound, "Run not found."),
        })
    }

    // --- Sessions ----------------------------------------------------------

    pub(crate) async fn list_sessions(&self, a: ListSessionsArgs) -> Result<Outcome<Vec<SessionSummary>>> {
        let Some(path) = &a.repo else {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name a repository."));
        };
        let (repo, member) = match self.visible_repo(path, &a.viewer).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let rows = self
            .db
            .prepare(
                "SELECT p.id AS pull_id, p.number, p.title, p.status, p.agent,
                   count(*) AS entries,
                   sum(CASE WHEN e.kind = 'tool_call' THEN 1 ELSE 0 END) AS tools,
                   min(e.at) AS started_at, max(e.at) AS last_at,
                   (SELECT substr(f.text, 1, 300) FROM session_entries f
                    WHERE f.pull_id = p.id AND f.kind = 'prompt' ORDER BY f.seq LIMIT 1) AS prompt
                 FROM pulls p JOIN session_entries e ON e.pull_id = p.id
                 WHERE p.repo_id = ?1
                   AND (?2 IS NULL OR p.status = ?2)
                   AND (?3 IS NULL OR p.number = ?3)
                   AND (?4 IS NULL OR EXISTS
                     (SELECT 1 FROM agent_runs r WHERE r.pull_id = p.id AND r.kind = ?4))
                 GROUP BY p.id ORDER BY last_at DESC LIMIT 100",
            )
            .bind(&[
                repo.id.as_str().into(),
                a.outcome.map_or(JsValue::NULL, |status| status.as_str().into()),
                a.number.map_or(JsValue::NULL, JsValue::from),
                a.kind.map_or(JsValue::NULL, |kind| kind.as_str().into()),
            ])?
            .all()
            .await?
            .results::<SessionListRow>()?;
        let ids: Vec<&str> = rows.iter().map(|row| row.pull_id.as_str()).collect();
        let runs = if ids.is_empty() {
            Vec::new()
        } else {
            self.db
                .prepare(
                    "SELECT pull_id, kind, status, cost_usd FROM agent_runs
                     WHERE repo_id = ? AND pull_id IN (SELECT value FROM json_each(?))",
                )
                .bind(&[repo.id.as_str().into(), serde_json::to_string(&ids)?.into()])?
                .all()
                .await?
                .results::<RunSumRow>()?
        };
        Ok(Outcome::Ok(
            rows.into_iter()
                .map(|row| {
                    let mine: Vec<&RunSumRow> = runs.iter().filter(|run| run.pull_id == row.pull_id).collect();
                    let mut kinds: Vec<RunKind> = Vec::new();
                    for run in &mine {
                        if let Some(kind) = RunKind::parse(&run.kind)
                            && !kinds.contains(&kind)
                        {
                            kinds.push(kind);
                        }
                    }
                    let spent: f64 = mine.iter().filter_map(|run| run.cost_usd).sum();
                    SessionSummary {
                        number: row.number,
                        title: row.title,
                        status: row.status,
                        agent: row.agent,
                        entries: row.entries,
                        tools: row.tools,
                        prompt: row.prompt.map(|prompt| one_line(&prompt, 200)),
                        runs: mine.len() as u32,
                        cost_usd: (member && mine.iter().any(|run| run.cost_usd.is_some())).then_some(spent),
                        active: mine
                            .iter()
                            .any(|run| RunStatus::parse(&run.status).is_some_and(RunStatus::is_active)),
                        kinds,
                        started_at: row.started_at,
                        last_at: row.last_at,
                    }
                })
                .collect(),
        ))
    }

    pub(crate) async fn get_session(&self, a: GetSessionArgs) -> Result<Outcome<SessionView>> {
        let (repo, pull) = match self.pull_at(&a.repo, a.number, &a.viewer).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let member = is_member(&a.viewer, &repo.namespace);
        let entries: Vec<SessionEntry> = self
            .db
            .prepare(
                "SELECT seq, kind, text, tool, \"commit\", at FROM session_entries
                 WHERE pull_id = ? ORDER BY seq LIMIT ?",
            )
            .bind(&[pull.id.as_str().into(), SESSION_ENTRIES.into()])?
            .all()
            .await?
            .results::<SessionRow>()?
            .into_iter()
            .map(SessionEntry::from)
            .collect();
        let runs: Vec<AgentRun> = self
            .db
            .prepare(format!(
                "SELECT {COLUMNS}, steps FROM agent_runs WHERE pull_id = ? ORDER BY created_at DESC LIMIT 50"
            ))
            .bind(&[pull.id.as_str().into()])?
            .all()
            .await?
            .results::<RunRow>()?
            .into_iter()
            .map(|row| row.into_run(member))
            .collect();
        let cost_usd = (member && runs.iter().any(|run| run.cost_usd.is_some()))
            .then(|| runs.iter().filter_map(|run| run.cost_usd).sum());
        Ok(Outcome::Ok(SessionView {
            pull,
            entries,
            runs,
            cost_usd,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_are_one_short_line() {
        assert_eq!(one_line("  Read\n  src/lib.rs  ", 40), "Read src/lib.rs");
        let long = one_line(&"x".repeat(300), 10);
        assert_eq!(long.chars().count(), 10);
        assert!(long.ends_with('…'));
    }
}
