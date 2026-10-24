//! Runs: every sandbox g1t starts for checks, the merge queue and finding
//! out whether a pull request merges cleanly, as a record people can watch
//! and look back on. Runs of g1t's former agents are kept and listed too.
//!
//! The runner service opens a run as it starts a sandbox (`open_run`) and
//! the sandbox reports its steps through the API with the run's one-time
//! token (`report_run`), as checks do. The runner closes it when the
//! sandbox stops.
//!
//! Sessions are the read side of what coding agents record on a pull
//! request (`append_session`): `list_sessions` and `get_session`.

use g1t_contracts::agents::*;
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{PullStatus, SessionEntry, SessionEntryKind};
use g1t_contracts::{FailureCode, Membership, Outcome, User, Viewer, new_id};
use g1t_kit::now_ms;
use g1t_scan::redact::soften;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::checks::{hash, new_token};
use crate::coordination::shown::{self, Sight};
use crate::rows::SessionRow;
use crate::{Work, optional};

/// How the runner starts a step that notes something about the sandbox
/// rather than what the run is doing: a host it was refused (the runner's
/// egress.ts `blockedStep`).
/// A workspace renamed: its runs move to the slug it has now. `?1` is the
/// current slug, `?2` a stale one (see `g1t_kit::rename`).
pub(crate) const RENAMED: &[&str] = &[
    "UPDATE agent_runs SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE agent_runs SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
];

/// A repository transferred (see `g1t_kit::transfer`): its runs go with
/// it, as its pull requests do by id. `?1`/`?2` the path now
/// and before, `?3`/`?4` the workspaces, `?5` the repository's id.
pub(crate) const TRANSFERRED: &[&str] = &["UPDATE agent_runs SET workspace = ?3, repo = ?1 WHERE repo_id = ?5 AND repo = ?2"];

const NOTE_PREFIXES: [&str; 1] = ["Blocked: "];

/// Where a report leaves the run: its newest step that says what the run
/// is doing. A note (a refused host) stays in the steps but never stands
/// for the run, which carries on past it. `None` when there is only notes.
fn current_step(steps: &[String]) -> Option<String> {
    steps.iter().rev().find(|step| !NOTE_PREFIXES.iter().any(|prefix| step.starts_with(prefix))).cloned()
}

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
///
/// A run g1t's agent started on an issue (no pull request; only these
/// kinds) kept the issue's number in its repository, which the move to
/// work items (g1t #57) never rewrote: `on_item` says the number is not a
/// pull request's, and `item` is the work item's number in its workspace,
/// found through the issue's old number.
const COLUMNS: &str = "id, workspace, repo_id, repo, number, pull_id, kind, agent, model, status,
  step, step_count, cost_usd, turns, sandbox, token_hash, started_by, error, created_at,
  started_at, finished_at, updated_at, budget_usd, time_cap_minutes, halted,
  COALESCE((SELECT title FROM pulls WHERE pulls.id = agent_runs.pull_id), agent_runs.title) AS title,
  (agent_runs.pull_id IS NULL AND agent_runs.kind IN ('implement', 'answer')) AS on_item,
  (SELECT i.number FROM work_item_repos r JOIN work_items i ON i.id = r.item_id
   WHERE agent_runs.pull_id IS NULL AND agent_runs.kind IN ('implement', 'answer')
     AND r.repo_id = agent_runs.repo_id AND r.legacy_number = agent_runs.number) AS item";

/// The pull requests of the repositories in `?1` (a JSON array of ids)
/// with entries recorded on them directly (not by a session moved onto
/// it), most recently recorded first, at most `?2`.
pub(crate) const RECORDED_IN: &str = "SELECT p.id AS pull_id, p.repo_id, p.number, p.title, p.status, p.agent, p.author_name,
   (SELECT number FROM work_items WHERE work_items.id = p.item_id) AS item,
   min(e.at) AS started_at, max(e.at) AS last_at,
   EXISTS (SELECT 1 FROM agent_runs r WHERE r.pull_id = p.id) AS has_runs
 FROM pulls p JOIN session_entries e ON e.pull_id = p.id
 WHERE p.repo_id IN (SELECT value FROM json_each(?1)) AND e.session_id IS NULL
 GROUP BY p.id ORDER BY last_at DESC LIMIT ?2";

/// A pull request's recorded session, for a workspace's sessions.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct RecordedRow {
    pub(crate) pull_id: String,
    pub(crate) repo_id: String,
    pub(crate) number: u32,
    pub(crate) title: String,
    pub(crate) status: g1t_contracts::work::PullStatus,
    pub(crate) agent: String,
    pub(crate) author_name: String,
    #[serde(default)]
    pub(crate) item: Option<u32>,
    pub(crate) started_at: String,
    pub(crate) last_at: String,
    pub(crate) has_runs: u32,
}

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
    /// 1 when `number` is an issue's, not a pull request's (see [`COLUMNS`]).
    #[serde(default)]
    on_item: Option<u32>,
    /// The work item that issue became, by number in its workspace.
    #[serde(default)]
    item: Option<u32>,
}

impl RunRow {
    fn on_item(&self) -> bool {
        self.on_item.is_some_and(|flag| flag != 0)
    }

    /// The work item it worked on, for a run started on an issue.
    pub(crate) fn item(&self) -> Option<u32> {
        self.item.filter(|_| self.on_item())
    }

    fn status(&self) -> RunStatus {
        RunStatus::parse(&self.status).unwrap_or(RunStatus::Failed)
    }

    /// The run as `member` (or not) may see it: model and cost are the
    /// workspace's business.
    fn into_run(self, member: bool) -> AgentRun {
        let on_item = self.on_item();
        let (namespace, name) = self.repo.split_once('/').unwrap_or((&self.repo, ""));
        AgentRun {
            repo: RepoPath { namespace: namespace.to_owned(), name: name.to_owned() },
            status: self.status(),
            kind: RunKind::parse(&self.kind).unwrap_or(RunKind::Implement),
            steps: self.steps.as_deref().and_then(|steps| serde_json::from_str(steps).ok()).unwrap_or_default(),
            id: self.id,
            // An issue's old number is no pull request's.
            number: self.number.filter(|number| *number > 0 && !on_item),
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
        viewer
            .workspaces
            .push(Membership { base_permission: Some(g1t_contracts::access::BasePermission::Read), ..Membership::member(slug) });
    }
    Some(viewer)
}

/// Whether the viewer belongs to the workspace: what a run spent, its model
/// and its budget are the workspace's business, not every reader's (an
/// outside collaborator sees the work, not the bill).
fn is_member(viewer: &Viewer, namespace: &str) -> bool {
    viewer.as_ref().is_some_and(|viewer| viewer.is_member(&namespace.to_lowercase()))
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
        self.db.prepare(format!("SELECT {COLUMNS}, steps FROM agent_runs WHERE id = ?")).bind(&[id.into()])?.first::<RunRow>(None).await
    }

    pub(crate) async fn open_run(&self, a: OpenRunArgs) -> Result<Outcome<AgentRunTicket>> {
        // Only sandboxes that are not agents are started now; earlier
        // kinds stay readable on the runs already recorded.
        if !matches!(a.kind, RunKind::Checks | RunKind::Queue | RunKind::Mergecheck) {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("A {} run is no longer started.", a.kind.as_str())));
        }
        // The runner is trusted: it names the repository it is starting a
        // sandbox in, whoever the sandbox acts as. The run records where
        // the repository is now, looked up by its id, not the path it was
        // named by, which may be from before a transfer or a rename.
        let (repo_id, path) = match &a.pull_id {
            Some(pull_id) => match self.pull_by_id(pull_id).await? {
                Some(pull) => {
                    let now: Option<RepoPath> =
                        g1t_kit::call(&self.repos, "path_by_id", &g1t_contracts::repos::PathByIdArgs { id: pull.repo_id.clone() }).await?;
                    (pull.repo_id, now.unwrap_or_else(|| a.repo.clone()))
                }
                None => return Ok(Outcome::fail(FailureCode::NotFound, "Pull request not found.")),
            },
            None => match self.repo(&a.repo, &member_of(&a.actor, &a.repo.namespace)).await? {
                Outcome::Ok(repo) => (repo.id, RepoPath { namespace: repo.namespace, name: repo.name }),
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            },
        };
        let namespace = path.namespace.to_lowercase();
        // Nothing new starts on an archived or deleted repository.
        if !self.repo_active(&repo_id).await? {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!("{}/{} is archived or deleted, so nothing new starts on it.", path.namespace, path.name),
            ));
        }
        let now = now_ms();
        let id = new_id("arn", now);
        let token = new_token();
        let timestamp = rfc3339(now);
        let agent = a.agent.clone().unwrap_or_else(|| g1t_contracts::identity::AGENT_NAME.to_owned());
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
                format!("{}/{}", path.namespace, path.name).into(),
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
        let Some(run) = self.run_row(&a.run_id).await?.filter(|run| run.token_hash == hash(&a.token)) else {
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
            return self.halt_run(&run.id, &run.repo_id, pull_id, run.number, &run.kind, halt, a.error, a.cost_usd).await;
        }
        let now = rfc3339(now_ms());
        let steps: Vec<String> = a.steps.iter().map(|step| one_line(step, MAX_STEP_CHARS)).filter(|step| !step.is_empty()).collect();
        // A burst keeps its end: that is where the run is now.
        let skip = steps.len().saturating_sub(MAX_STEPS_PER_REPORT);
        let mut statements = Vec::new();
        for step in &steps[skip..] {
            statements.push(self.add_step(&run.id, &now, step)?);
        }
        let current =
            a.step.as_deref().map(|step| one_line(step, MAX_STEP_CHARS)).filter(|step| !step.is_empty()).or_else(|| current_step(&steps));
        let outcome = a.outcome.filter(|outcome| matches!(outcome, RunStatus::Succeeded | RunStatus::Failed));
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
                return Ok(Outcome::fail(FailureCode::Forbidden, "Only members of the workspace can see its fleet."));
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

    /// The runs of g1t's own agent in some repositories of a workspace
    /// (sandboxes for checks, the queue and merge checks are not agents),
    /// newest first, with each one's repository id. Only `live` ones: those
    /// queued or running.
    /// Each with its repository's id, and the work item it worked on, by
    /// number, for one started on an issue.
    pub(crate) async fn agent_runs_in(
        &self,
        workspace: &str,
        repo_ids: &[String],
        live: bool,
        member: bool,
        limit: u32,
    ) -> Result<Vec<(String, AgentRun, Option<u32>)>> {
        if repo_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = self
            .db
            .prepare(format!(
                "SELECT {COLUMNS} FROM agent_runs
                 WHERE workspace = ?1 AND repo_id IN (SELECT value FROM json_each(?2))
                   AND kind IN ('implement', 'revise', 'review', 'answer', 'update', 'plan')
                   AND (?3 = 0 OR status IN ('queued', 'running'))
                 ORDER BY updated_at DESC LIMIT ?4"
            ))
            .bind(&[workspace.to_lowercase().into(), serde_json::to_string(repo_ids)?.into(), u32::from(live).into(), limit.into()])?
            .all()
            .await?
            .results::<RunRow>()?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let item = row.item();
                (row.repo_id.clone(), row.into_run(member), item)
            })
            .collect())
    }

    /// The pull requests of some repositories with a recorded session,
    /// most recently recorded first: each one's id, number, title, status,
    /// agent label, author, first and last entry.
    pub(crate) async fn recorded_in(&self, repo_ids: &[String], limit: u32) -> Result<Vec<RecordedRow>> {
        if repo_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.db.prepare(RECORDED_IN).bind(&[serde_json::to_string(repo_ids)?.into(), limit.into()])?.all().await?.results::<RecordedRow>()
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
                        // Someone's words to their agent: not for outsiders,
                        // and to members without credentials or swearing.
                        prompt: row
                            .prompt
                            .filter(|_| member)
                            .map(|prompt| soften(&one_line(&prompt, 200)))
                            .filter(|prompt| !prompt.is_empty()),
                        runs: mine.len() as u32,
                        cost_usd: (member && mine.iter().any(|run| run.cost_usd.is_some())).then_some(spent),
                        active: mine.iter().any(|run| RunStatus::parse(&run.status).is_some_and(RunStatus::is_active)),
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
        // Each entry as the viewer may see it: a prompt or a tool's output
        // only by whoever's session recorded it, nothing to an outsider
        // but g1t's own notes (coordination/shown.rs).
        let entries: Vec<SessionEntry> = self
            .db
            .prepare(
                "SELECT e.seq, e.kind, e.text, e.tool, e.\"commit\", e.at, s.actor_id FROM session_entries e
                 LEFT JOIN sessions s ON s.id = e.session_id
                 WHERE e.pull_id = ? ORDER BY e.seq LIMIT ?",
            )
            .bind(&[pull.id.as_str().into(), SESSION_ENTRIES.into()])?
            .all()
            .await?
            .results::<SessionRow>()?
            .into_iter()
            .filter_map(|row| {
                let note = row.kind == SessionEntryKind::Note && row.actor_id.is_none();
                let sight = match &row.actor_id {
                    Some(actor) => Sight::of(&a.viewer, &repo.namespace, actor),
                    None if member => Sight::Member,
                    None => Sight::Outside,
                };
                let entry = SessionEntry::from(row);
                if note && sight == Sight::Outside {
                    return Some(SessionEntry { text: shown::clean(&entry.text), ..entry });
                }
                shown::entry(entry, sight)
            })
            .collect();
        let runs: Vec<AgentRun> = self
            .db
            .prepare(format!("SELECT {COLUMNS}, steps FROM agent_runs WHERE pull_id = ? ORDER BY created_at DESC LIMIT 50"))
            .bind(&[pull.id.as_str().into()])?
            .all()
            .await?
            .results::<RunRow>()?
            .into_iter()
            .map(|row| row.into_run(member))
            .collect();
        let cost_usd = (member && runs.iter().any(|run| run.cost_usd.is_some())).then(|| runs.iter().filter_map(|run| run.cost_usd).sum());
        Ok(Outcome::Ok(SessionView { pull, entries, runs, cost_usd }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_and_deletion_statements_take_what_they_name() {
        for sql in TRANSFERRED.iter().chain(crate::guardrails::TRANSFERRED) {
            let n = g1t_kit::transfer::parameters(sql);
            assert!((1..=5).contains(&n), "{sql}");
        }
        for sql in crate::guardrails::DELETED {
            assert_eq!(g1t_kit::rename::parameters(sql), 1, "{sql}");
        }
    }

    #[test]
    fn rename_statements_take_the_two_slugs() {
        for sql in RENAMED.iter().chain(crate::guardrails::RENAMED) {
            assert_eq!(g1t_kit::rename::parameters(sql), 2, "{sql}");
        }
    }

    #[test]
    fn a_refused_host_is_noted_but_never_where_the_run_is() {
        let steps = |list: &[&str]| list.iter().map(|step| (*step).to_owned()).collect::<Vec<String>>();
        assert_eq!(
            current_step(&steps(&["Running npm ci", "Blocked: sparrow.cloudflare.com (not an allowed domain)"])).as_deref(),
            Some("Running npm ci")
        );
        assert_eq!(current_step(&steps(&["Blocked: a.com (not an allowed domain)"])), None);
        assert_eq!(current_step(&steps(&["Blocked: a.com (not an allowed domain)", "Typecheck"])).as_deref(), Some("Typecheck"));
        assert_eq!(current_step(&[]), None);
    }

    #[test]
    fn a_run_on_an_issue_names_its_work_item_not_a_pull_request() {
        let db = crate::migrated::database();
        db.execute_batch(
            "INSERT INTO work_items (id, workspace, number, title, body, author_id, author_name, created_at, updated_at)
             VALUES ('iss_7', 'acme', 57, 'Passkeys', '', 'usr_1', 'ana', '', '');
             INSERT INTO work_item_repos (item_id, repo_id, role, legacy_number, added_at) VALUES ('iss_7', 'rep_web', 'origin', 7, '');
             INSERT INTO agent_runs (id, workspace, repo_id, repo, number, pull_id, kind, agent, status, sandbox, token_hash, created_at, updated_at)
             VALUES ('arn_issue', 'acme', 'rep_web', 'acme/web', 7, NULL, 'implement', 'g1t', 'succeeded', 's', 't', '', ''),
                    ('arn_pull', 'acme', 'rep_web', 'acme/web', 7, 'pul_7', 'review', 'g1t', 'succeeded', 's', 't', '', ''),
                    ('arn_queue', 'acme', 'rep_web', 'acme/web', 7, NULL, 'queue', 'g1t', 'succeeded', 's', 't', '', '');",
        )
        .unwrap();
        let run = |id: &str| {
            db.query_row(&format!("SELECT on_item, item FROM (SELECT {COLUMNS} FROM agent_runs WHERE id = ?1)"), [id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?))
            })
            .unwrap()
        };
        // Issue #7 of web is work item #57 of acme; pull request #7 is not it.
        assert_eq!(run("arn_issue"), (1, Some(57)));
        assert_eq!(run("arn_pull"), (0, None));
        // The merge queue names a pull request by number alone.
        assert_eq!(run("arn_queue"), (0, None));
    }

    #[test]
    fn steps_are_one_short_line() {
        assert_eq!(one_line("  Read\n  src/lib.rs  ", 40), "Read src/lib.rs");
        let long = one_line(&"x".repeat(300), 10);
        assert_eq!(long.chars().count(), 10);
        assert!(long.ends_with('…'));
    }
}
