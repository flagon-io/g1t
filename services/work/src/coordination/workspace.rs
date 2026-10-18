//! Sessions across a workspace (`g1t_contracts::work::workspace_sessions`):
//! every kind of session in every repository of it the viewer may read,
//! in one list, with the merge queues waiting and what just landed.
//!
//! Harness and hosted sessions are the `sessions` table's; g1t's agent is
//! `agent_runs`; a recorded one is a pull request with session entries
//! and nothing else behind it. Who may see what inside a session is the
//! repository's rule (shown.rs), applied to each as it is in its own list.

use std::collections::{HashMap, HashSet};

use g1t_contracts::agents::AgentRun;
use g1t_contracts::repos::{ReadableArgs, Repo, RepoPath};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, Viewer};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::links::count_subagents;
use super::{SESSION_COLUMNS, SessionRow, shown};
use crate::Work;
use crate::rows::{PULL_COLUMNS, PullRow};
use crate::runs::RecordedRow;

/// The most repositories of a workspace looked in.
const MAX_REPOS: u32 = 500;
/// The most pull requests Just landed gives.
const LANDED: u32 = 8;
/// The most merge queues given.
const QUEUES: usize = 12;
/// The most trees given whole with `subagents`.
const TREES: usize = 30;

/// The workspace's sessions in the repositories `?1` (a JSON array of
/// ids): `?2` is the time before which a quiet one reads as ended, `?3`
/// whether subagents are listed, `?4` a harness, `?5` a username, `?6` a
/// work item's id, `?7` how many, `?8` a kind (`harness` or `hosted`).
pub(crate) fn workspace_sessions_sql(shown: SessionsShown) -> String {
    let state = match shown {
        SessionsShown::Live => "AND state = 'active' AND last_seen_at > ?2",
        SessionsShown::Recent => "AND ?2 IS NOT NULL",
        SessionsShown::Ended => "AND (state = 'ended' OR last_seen_at <= ?2)",
    };
    format!(
        "SELECT {SESSION_COLUMNS} FROM sessions
         WHERE repo_id IN (SELECT value FROM json_each(?1)) {state}
           AND (?3 = 1 OR parent_id IS NULL)
           AND (?4 IS NULL OR harness = ?4)
           AND (?5 IS NULL OR lower(actor_name) = lower(?5))
           AND (?6 IS NULL OR item_id = ?6
             OR id IN (SELECT session_id FROM session_links WHERE kind = 'item' AND item_id = ?6))
           AND (?8 IS NULL OR (?8 = 'hosted') = (harness = 'claude_managed_agents'))
         ORDER BY last_seen_at DESC LIMIT ?7"
    )
}

/// The titles and states of some pull requests, by `{r, n}` pairs in `?1`.
pub(crate) const PULL_FACTS: &str = "SELECT p.repo_id, p.number, p.title, p.status,
   (SELECT number FROM work_items WHERE work_items.id = p.item_id) AS item
 FROM json_each(?1) j JOIN pulls p ON p.repo_id = json_extract(j.value, '$.r') AND p.number = json_extract(j.value, '$.n')";

/// The repositories of `?1` (a JSON array of ids) with something waiting
/// in their merge queue, the busiest first.
pub(crate) const QUEUED_REPOS: &str = "SELECT repo_id AS value FROM queue_entries
 WHERE repo_id IN (SELECT value FROM json_each(?1)) AND state IN ('waiting', 'testing', 'passed')
 GROUP BY repo_id ORDER BY COUNT(*) DESC, MIN(created_at) LIMIT ?2";

#[derive(Debug, Deserialize)]
pub(crate) struct PullFact {
    pub(crate) repo_id: String,
    pub(crate) number: u32,
    pub(crate) title: String,
    pub(crate) status: PullStatus,
    #[serde(default)]
    pub(crate) item: Option<u32>,
}

#[derive(Deserialize)]
struct Value {
    value: String,
}

#[derive(Deserialize)]
struct Titled {
    number: u32,
    title: String,
}

#[derive(Deserialize)]
struct Placed {
    repo_id: String,
    path: String,
}

/// A harness or hosted session, as one of the workspace's.
pub(crate) fn from_session(mut session: Session, path: &str, now: u64) -> WorkspaceSession {
    let last = parse_rfc3339(&session.last_seen_at).unwrap_or(now);
    session.state = settled_state(session.state, last, now);
    if session.state == SessionState::Ended && session.ended_at.is_none() {
        session.end_reason.get_or_insert_with(|| "timed_out".to_owned());
    }
    WorkspaceSession {
        kind: SessionKind::of(session.harness),
        id: session.id.clone(),
        repo: path.to_owned(),
        repo_id: session.repo_id.clone(),
        title: session.title.clone(),
        actor: Some(session.actor.username.clone()),
        harness: Some(session.harness),
        agent: None,
        branch: session.branch.clone(),
        item: session.item,
        item_title: None,
        pull: session.pull,
        pull_title: None,
        pull_status: None,
        state: session.state,
        started_at: session.started_at.clone(),
        last_activity_at: session.last_seen_at.clone(),
        subagents: session.subagents,
        step: None,
        session: Some(session),
        children: Vec::new(),
    }
}

/// A run of g1t's agent, as one of the workspace's sessions: `item`, the
/// work item one started on an issue worked on.
pub(crate) fn from_run(run: AgentRun, repo_id: &str, item: Option<u32>) -> WorkspaceSession {
    let state = if run.status.is_active() { SessionState::Active } else { SessionState::Ended };
    WorkspaceSession {
        kind: SessionKind::Agent,
        id: run.id,
        repo: format!("{}/{}", run.repo.namespace, run.repo.name),
        repo_id: repo_id.to_owned(),
        title: run.title,
        actor: Some(run.started_by.unwrap_or_else(|| "g1t".to_owned())),
        harness: None,
        agent: Some(run.agent),
        branch: None,
        item,
        item_title: None,
        pull: run.number,
        pull_title: None,
        pull_status: None,
        state,
        started_at: run.started_at.unwrap_or_else(|| run.created_at.clone()),
        last_activity_at: run.updated_at,
        subagents: 0,
        step: run.step,
        session: None,
        children: Vec::new(),
    }
}

/// A pull request's recorded session, as one of the workspace's.
pub(crate) fn from_recorded(row: RecordedRow, path: &str, now: u64) -> WorkspaceSession {
    let last = parse_rfc3339(&row.last_at).unwrap_or(0);
    WorkspaceSession {
        kind: SessionKind::Recorded,
        id: row.pull_id,
        repo: path.to_owned(),
        repo_id: row.repo_id,
        title: Some(row.title.clone()),
        actor: Some(row.author_name),
        harness: None,
        agent: Some(row.agent),
        branch: None,
        item: row.item,
        item_title: None,
        pull: Some(row.number),
        pull_title: Some(row.title),
        pull_status: Some(row.status),
        state: quiet_state(false, last, now),
        started_at: row.started_at,
        last_activity_at: row.last_at,
        subagents: 0,
        step: None,
        session: None,
        children: Vec::new(),
    }
}

/// Filters for the kinds that are not in the `sessions` table.
pub(crate) struct Wanted<'a> {
    pub(crate) shown: SessionsShown,
    pub(crate) kind: Option<SessionKind>,
    pub(crate) harness: Option<Harness>,
    pub(crate) person: Option<&'a str>,
    pub(crate) item: Option<u32>,
}

impl Wanted<'_> {
    fn admits(&self, session: &WorkspaceSession) -> bool {
        self.admits_listed(session) && self.item.is_none_or(|item| session.item == Some(item))
    }

    /// For a row of the `sessions` table, which its query already chose by
    /// work item, the session's own or one it is linked to
    /// ([`workspace_sessions_sql`]): all but that.
    fn admits_listed(&self, session: &WorkspaceSession) -> bool {
        self.shown.admits(session.state)
            && self.kind.is_none_or(|kind| kind == session.kind)
            && self.harness.is_none_or(|harness| session.harness == Some(harness))
            && self.person.is_none_or(|person| session.actor.as_deref().is_some_and(|actor| actor.eq_ignore_ascii_case(person)))
    }
}

/// One list of every kind: a recorded session of a pull request that a
/// harness session or a run of g1t's agent is already on is that one,
/// and is left out. Filtered, most recently heard from first, at most
/// `limit`.
pub(crate) fn merged(
    sessions: Vec<WorkspaceSession>,
    runs: Vec<WorkspaceSession>,
    recorded: Vec<(WorkspaceSession, bool)>,
    wanted: &Wanted,
    limit: usize,
) -> Vec<WorkspaceSession> {
    let covered: HashSet<(String, u32)> =
        sessions.iter().chain(&runs).filter_map(|session| session.pull.map(|pull| (session.repo_id.clone(), pull))).collect();
    let mut all: Vec<WorkspaceSession> = sessions.into_iter().filter(|session| wanted.admits_listed(session)).collect();
    all.extend(runs.into_iter().filter(|run| wanted.admits(run)));
    all.extend(
        recorded
            .into_iter()
            .filter(|(session, has_runs)| !has_runs && !session.pull.is_some_and(|pull| covered.contains(&(session.repo_id.clone(), pull))))
            .map(|(session, _)| session)
            .filter(|session| wanted.admits(session)),
    );
    all.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at).then_with(|| a.id.cmp(&b.id)));
    all.truncate(limit);
    all
}

impl Work {
    /// The repositories of `workspace` the viewer may read, or of them the
    /// one named `only`.
    async fn readable_in(&self, workspace: &str, viewer: &Viewer, only: Option<&str>) -> Result<Vec<Repo>> {
        let placed = self
            .db
            .prepare("SELECT repo_id, path FROM repo_workspaces WHERE workspace = ?1 AND (?2 IS NULL OR lower(path) = lower(?1 || '/' || ?2)) ORDER BY path LIMIT ?3")
            .bind(&[workspace.into(), only.map_or(JsValue::NULL, JsValue::from), MAX_REPOS.into()])?
            .all()
            .await?
            .results::<Placed>()?;
        if placed.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<String> = placed.iter().map(|row| row.repo_id.clone()).collect();
        let mut readable: Vec<Repo> = g1t_kit::call(&self.repos, "readable", &ReadableArgs { ids, viewer: viewer.clone() }).await?;
        readable.retain(|repo| repo.namespace.eq_ignore_ascii_case(workspace));
        readable.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(readable)
    }

    pub(crate) async fn list_workspace_sessions(&self, a: ListWorkspaceSessionsArgs) -> Result<Outcome<WorkspaceSessions>> {
        let workspace = a.workspace.trim().to_lowercase();
        if workspace.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Name the workspace by its slug."));
        }
        let only = a.repo.as_deref().map(str::trim).filter(|name| !name.is_empty()).map(|name| name.rsplit('/').next().unwrap_or(name).to_owned());
        let repos = self.readable_in(&workspace, &a.viewer, only.as_deref()).await?;
        if repos.is_empty() && only.is_some() {
            return Ok(Outcome::fail(FailureCode::NotFound, "Repository not found."));
        }
        let ids: Vec<String> = repos.iter().map(|repo| repo.id.clone()).collect();
        let path_of: HashMap<&str, String> = repos.iter().map(|repo| (repo.id.as_str(), format!("{}/{}", repo.namespace, repo.name))).collect();
        let member = a.viewer.as_ref().is_some_and(|viewer| viewer.is_member(&workspace));
        let limit = a.limit.unwrap_or(DEFAULT_WORKSPACE_SESSIONS).clamp(1, MAX_WORKSPACE_SESSIONS);
        let now = now_ms();
        let person = a.person.as_deref().map(|person| person.trim().trim_start_matches('@')).filter(|person| !person.is_empty());
        // A work item by number, in this workspace.
        let item_id = match a.item {
            Some(number) => match crate::items::by_number(self, &workspace, number).await? {
                Some(held) => Some(held.item.id),
                None => return Ok(Outcome::Ok(WorkspaceSessions { repos: sessions_repos(&repos), ..WorkspaceSessions::default() })),
            },
            None => None,
        };

        // Harness and hosted sessions.
        let from_table = !matches!(a.kind, Some(SessionKind::Agent | SessionKind::Recorded));
        let mut sessions: Vec<Session> = if from_table && !ids.is_empty() {
            self.db
                .prepare(workspace_sessions_sql(a.shown))
                .bind(&[
                    serde_json::to_string(&ids)?.into(),
                    rfc3339(now.saturating_sub(SESSION_TIMEOUT_MS)).into(),
                    u32::from(false).into(),
                    a.harness.map_or(JsValue::NULL, |harness| harness.as_str().into()),
                    person.map_or(JsValue::NULL, JsValue::from),
                    item_id.as_deref().map_or(JsValue::NULL, JsValue::from),
                    limit.into(),
                    a.kind.map_or(JsValue::NULL, |kind| kind.as_str().into()),
                ])?
                .all()
                .await?
                .results::<SessionRow>()?
                .into_iter()
                .map(|row| row.at(now))
                .collect()
        } else {
            Vec::new()
        };
        self.fill_subagents(&mut sessions).await?;
        self.fill_first_prompts(&mut sessions).await?;
        shown::sessions(&mut sessions, &a.viewer, &workspace);
        let mut trees: HashMap<String, Vec<Session>> = HashMap::new();
        if a.subagents {
            for session in sessions.iter().filter(|session| session.subagents > 0).take(TREES) {
                let mut children = self.subagents_of(&session.id, now).await?;
                count_subagents(&mut children);
                shown::sessions(&mut children, &a.viewer, &workspace);
                trees.insert(session.id.clone(), children);
            }
        }
        let table: Vec<WorkspaceSession> = sessions
            .into_iter()
            .filter_map(|session| {
                let path = path_of.get(session.repo_id.as_str())?.clone();
                let mut listed = from_session(session, &path, now);
                listed.children = trees.remove(&listed.id).unwrap_or_default();
                Some(listed)
            })
            .collect();

        // g1t's agent: the workspace's business, as its fleet is.
        let wants = |kind: SessionKind| a.kind.is_none_or(|wanted| wanted == kind) && a.harness.is_none();
        let runs: Vec<WorkspaceSession> = if member && wants(SessionKind::Agent) {
            self.agent_runs_in(&workspace, &ids, a.shown == SessionsShown::Live, member, limit)
                .await?
                .into_iter()
                .map(|(repo_id, run, item)| from_run(run, &repo_id, item))
                .collect()
        } else {
            Vec::new()
        };
        let recorded: Vec<(WorkspaceSession, bool)> = if wants(SessionKind::Recorded) {
            self.recorded_in(&ids, limit)
                .await?
                .into_iter()
                .filter_map(|row| {
                    let path = path_of.get(row.repo_id.as_str())?.clone();
                    let has_runs = row.has_runs != 0;
                    Some((from_recorded(row, &path, now), has_runs))
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut runs = runs;
        self.fill_pulls(&mut runs).await?;
        let wanted = Wanted { shown: a.shown, kind: a.kind, harness: a.harness, person, item: a.item };
        let mut listed = merged(table, runs, recorded, &wanted, limit as usize);
        self.fill_pulls(&mut listed).await?;
        if member {
            self.fill_item_titles(&workspace, &mut listed).await?;
        }

        let (queue, landed) = if a.sessions_only { (Vec::new(), Vec::new()) } else { (self.queues_in(&repos, &a.viewer).await?, self.landed_in(&repos).await?) };
        Ok(Outcome::Ok(WorkspaceSessions { sessions: listed, queue, landed, repos: sessions_repos(&repos) }))
    }

    /// Each session's pull request's title and status, and, for one with
    /// no work item of its own, the pull request's.
    async fn fill_pulls(&self, sessions: &mut [WorkspaceSession]) -> Result<()> {
        let pairs: Vec<serde_json::Value> = sessions
            .iter()
            .filter(|session| session.pull_title.is_none() || session.item.is_none())
            .filter_map(|session| session.pull.map(|number| serde_json::json!({ "r": session.repo_id, "n": number })))
            .collect();
        if pairs.is_empty() {
            return Ok(());
        }
        let facts = self.db.prepare(PULL_FACTS).bind(&[serde_json::to_string(&pairs)?.into()])?.all().await?.results::<PullFact>()?;
        for session in sessions.iter_mut() {
            let Some(fact) = session.pull.and_then(|number| facts.iter().find(|fact| fact.repo_id == session.repo_id && fact.number == number)) else {
                continue;
            };
            session.pull_title.get_or_insert_with(|| fact.title.clone());
            session.pull_status.get_or_insert(fact.status);
            if session.item.is_none() {
                session.item = fact.item;
            }
            if session.title.is_none() && session.kind == SessionKind::Agent {
                session.title = Some(fact.title.clone());
            }
        }
        Ok(())
    }

    /// Each session's work item's title, for a member of the workspace.
    async fn fill_item_titles(&self, workspace: &str, sessions: &mut [WorkspaceSession]) -> Result<()> {
        let mut numbers: Vec<u32> = sessions.iter().filter_map(|session| session.item).collect();
        numbers.sort_unstable();
        numbers.dedup();
        if numbers.is_empty() {
            return Ok(());
        }
        let titles: HashMap<u32, String> = self
            .db
            .prepare("SELECT number, title FROM work_items WHERE workspace = ?1 AND number IN (SELECT value FROM json_each(?2))")
            .bind(&[workspace.into(), serde_json::to_string(&numbers)?.into()])?
            .all()
            .await?
            .results::<Titled>()?
            .into_iter()
            .map(|row| (row.number, row.title))
            .collect();
        for session in sessions {
            session.item_title = session.item.and_then(|number| titles.get(&number).cloned());
        }
        Ok(())
    }

    /// The merge queues of `repos` with something waiting, busiest first.
    async fn queues_in(&self, repos: &[Repo], viewer: &Viewer) -> Result<Vec<RepoQueue>> {
        if repos.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<&str> = repos.iter().map(|repo| repo.id.as_str()).collect();
        let busy = self
            .db
            .prepare(QUEUED_REPOS)
            .bind(&[serde_json::to_string(&ids)?.into(), (QUEUES as u32).into()])?
            .all()
            .await?
            .results::<Value>()?;
        let mut queues = Vec::new();
        for id in busy {
            let Some(repo) = repos.iter().find(|repo| repo.id == id.value) else { continue };
            let path = RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() };
            if let Outcome::Ok(queue) = self.queue(QueueArgs { repo: path, viewer: viewer.clone() }).await? {
                queues.push(RepoQueue { repo: format!("{}/{}", repo.namespace, repo.name), default_branch: repo.default_branch.clone(), queue });
            }
        }
        Ok(queues)
    }

    /// The pull requests of `repos` merged most recently.
    async fn landed_in(&self, repos: &[Repo]) -> Result<Vec<RepoPull>> {
        if repos.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<&str> = repos.iter().map(|repo| repo.id.as_str()).collect();
        let pulls = self
            .db
            .prepare(format!(
                "SELECT {PULL_COLUMNS} FROM pulls WHERE repo_id IN (SELECT value FROM json_each(?1)) AND status = 'merged' AND merged_at IS NOT NULL
                 ORDER BY merged_at DESC LIMIT ?2"
            ))
            .bind(&[serde_json::to_string(&ids)?.into(), LANDED.into()])?
            .all()
            .await?
            .results::<PullRow>()?;
        Ok(pulls
            .into_iter()
            .map(Pull::from)
            .filter_map(|mut pull| {
                let repo = repos.iter().find(|repo| repo.id == pull.repo_id)?;
                crate::fill_base(&mut pull, repo);
                Some(RepoPull { repo: format!("{}/{}", repo.namespace, repo.name), pull })
            })
            .collect())
    }

    /// One harness or hosted session of a workspace by its id, read as its
    /// repository's own list reads it.
    pub(crate) async fn get_workspace_session(&self, a: GetWorkspaceSessionArgs) -> Result<Outcome<WorkspaceSessionDetail>> {
        let workspace = a.workspace.trim().to_lowercase();
        let placed = self
            .db
            .prepare(
                "SELECT s.repo_id, rw.path FROM sessions s JOIN repo_workspaces rw ON rw.repo_id = s.repo_id
                 WHERE s.id = ?1 AND rw.workspace = ?2",
            )
            .bind(&[a.id.trim().into(), workspace.as_str().into()])?
            .first::<Placed>(None)
            .await?;
        let Some(placed) = placed else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Session not found."));
        };
        let Some((namespace, name)) = placed.path.split_once('/') else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Session not found."));
        };
        let repo = RepoPath { namespace: namespace.to_owned(), name: name.to_owned() };
        let args = WorkSessionArgs { viewer: a.viewer, repo, id: a.id.trim().to_owned(), after_seq: a.after_seq };
        Ok(match self.get_work_session(args).await? {
            Outcome::Ok(detail) => Outcome::Ok(WorkspaceSessionDetail { repo: placed.path, detail }),
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    }
}

fn sessions_repos(repos: &[Repo]) -> Vec<SessionsRepo> {
    repos
        .iter()
        .map(|repo| SessionsRepo { id: repo.id.clone(), path: format!("{}/{}", repo.namespace, repo.name), default_branch: repo.default_branch.clone() })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runs::RECORDED_IN;
    use rusqlite::{Connection, params};

    const NOW: u64 = 1_791_800_000_000;
    const MINUTE: u64 = 60_000;

    fn at(ago_minutes: u64) -> String {
        rfc3339(NOW - ago_minutes * MINUTE)
    }

    /// Two repositories of acme and one of another workspace, a work item,
    /// and pull requests in each.
    fn database() -> Connection {
        let db = crate::migrated::database();
        db.execute_batch(
            "INSERT INTO repo_workspaces (repo_id, workspace, path, private) VALUES
               ('rep_web', 'acme', 'acme/web', 1), ('rep_api', 'acme', 'acme/api', 1), ('rep_x', 'other', 'other/x', 0);
             INSERT INTO work_items (id, workspace, number, title, body, author_id, author_name, created_at, updated_at)
             VALUES ('wki_4', 'acme', 4, 'Greet people', '', 'usr_1', 'ana', '', '');
             INSERT INTO pulls (id, repo_id, number, title, agent, runtime, author_id, author_name, created_at, updated_at, item_id) VALUES
               ('pr_web_9', 'rep_web', 9, 'Say hello', 'claude-code', 'external', 'usr_1', 'ana', '', '', 'wki_4'),
               ('pr_api_7', 'rep_api', 7, 'Recorded only', 'cursor', 'external', 'usr_2', 'bo', '', '', NULL),
               ('pr_api_8', 'rep_api', 8, 'By g1t', 'g1t', 'external', 'usr_2', 'bo', '', '', NULL),
               ('pr_x_1', 'rep_x', 1, 'Elsewhere', 'codex', 'external', 'usr_3', 'cy', '', '', NULL);",
        )
        .unwrap();
        db
    }

    #[allow(clippy::too_many_arguments)]
    fn session(db: &Connection, id: &str, repo: &str, item: Option<&str>, pull: Option<u32>, actor: &str, harness: &str, state: &str, last: u64, parent: Option<&str>) {
        db.execute(
            "INSERT INTO sessions (id, repo_id, item_id, pull, branch, actor_id, actor_name, harness, harness_session_id,
               title, state, head_commit, started_at, last_seen_at, parent_id)
             VALUES (?1, ?2, ?3, ?4, 'main', ?5, ?5, ?6, ?1, NULL, ?7, NULL, ?8, ?8, ?9)",
            params![id, repo, item, pull, actor, harness, state, at(last), parent],
        )
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    fn listed(db: &Connection, shown: SessionsShown, repos: &[&str], harness: Option<&str>, person: Option<&str>, item: Option<&str>, kind: Option<&str>) -> Vec<String> {
        let sql = workspace_sessions_sql(shown);
        let mut statement = db.prepare(&sql).unwrap();
        statement
            .query_map(
                params![serde_json::to_string(repos).unwrap(), rfc3339(NOW - SESSION_TIMEOUT_MS), 0, harness, person, item, 100, kind],
                |row| row.get::<_, String>("id"),
            )
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn seeded() -> Connection {
        let db = database();
        session(&db, "ses_cc", "rep_web", Some("wki_4"), Some(9), "ana", "claude_code", "active", 1, None);
        session(&db, "ses_sub", "rep_web", Some("wki_4"), None, "ana", "claude_code", "active", 1, Some("ses_cc"));
        session(&db, "ses_codex", "rep_api", None, None, "bo", "codex", "active", 20, None);
        session(&db, "ses_cursor", "rep_api", None, None, "bo", "cursor", "active", 45, None);
        session(&db, "ses_hosted", "rep_api", None, None, "ana", "claude_managed_agents", "active", 3, None);
        session(&db, "ses_done", "rep_web", None, None, "cy", "other", "ended", 90, None);
        session(&db, "ses_x", "rep_x", None, None, "cy", "codex", "active", 1, None);
        db
    }

    #[test]
    fn only_the_repositories_looked_in_are_listed_and_subagents_stay_under_their_parent() {
        let db = seeded();
        let all = listed(&db, SessionsShown::Recent, &["rep_web", "rep_api"], None, None, None, None);
        assert_eq!(all, ["ses_cc", "ses_hosted", "ses_codex", "ses_cursor", "ses_done"]);
        // A repository the viewer may not read is never looked in.
        let web = listed(&db, SessionsShown::Recent, &["rep_web"], None, None, None, None);
        assert_eq!(web, ["ses_cc", "ses_done"]);
        assert!(!all.contains(&"ses_x".to_owned()));
    }

    #[test]
    fn live_is_what_is_going_and_ended_takes_those_gone_quiet_too() {
        let db = seeded();
        let repos = ["rep_web", "rep_api"];
        // Idle (20 minutes) is still live; quiet past the timeout (45) is not.
        assert_eq!(listed(&db, SessionsShown::Live, &repos, None, None, None, None), ["ses_cc", "ses_hosted", "ses_codex"]);
        assert_eq!(listed(&db, SessionsShown::Ended, &repos, None, None, None, None), ["ses_cursor", "ses_done"]);
    }

    #[test]
    fn sessions_filter_by_harness_person_kind_and_work_item() {
        let db = seeded();
        let repos = ["rep_web", "rep_api"];
        assert_eq!(listed(&db, SessionsShown::Recent, &repos, Some("codex"), None, None, None), ["ses_codex"]);
        assert_eq!(listed(&db, SessionsShown::Recent, &repos, None, Some("BO"), None, None), ["ses_codex", "ses_cursor"]);
        assert_eq!(listed(&db, SessionsShown::Recent, &repos, None, None, None, Some("hosted")), ["ses_hosted"]);
        assert_eq!(listed(&db, SessionsShown::Recent, &repos, None, None, None, Some("harness")), ["ses_cc", "ses_codex", "ses_cursor", "ses_done"]);
        assert_eq!(listed(&db, SessionsShown::Recent, &repos, None, None, Some("wki_4"), None), ["ses_cc"]);
        // Tied to the work item another way: a link.
        db.execute(super::super::links::INSERT_LINK, params!["ses_codex", "rep_api", "item", 0, "ref", at(1), "wki_4"]).unwrap();
        assert_eq!(listed(&db, SessionsShown::Recent, &repos, None, None, Some("wki_4"), None), ["ses_cc", "ses_codex"]);
    }

    fn recorded(db: &Connection, repos: &[&str]) -> Vec<RecordedRow> {
        let mut statement = db.prepare(RECORDED_IN).unwrap();
        let rows = statement
            .query_map(params![serde_json::to_string(repos).unwrap(), 50], |row| {
                Ok(RecordedRow {
                    pull_id: row.get("pull_id")?,
                    repo_id: row.get("repo_id")?,
                    number: row.get("number")?,
                    title: row.get("title")?,
                    status: PullStatus::Open,
                    agent: row.get("agent")?,
                    author_name: row.get("author_name")?,
                    item: row.get("item")?,
                    started_at: row.get("started_at")?,
                    last_at: row.get("last_at")?,
                    has_runs: row.get("has_runs")?,
                })
            })
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    fn run(number: u32, status: &str) -> AgentRun {
        serde_json::from_value(serde_json::json!({
            "id": "run_1", "repo": { "namespace": "acme", "name": "api" }, "number": number, "title": null, "kind": "implement",
            "agent": "g1t", "model": null, "status": status, "step": "Running tests", "stepCount": 3, "startedBy": null,
            "error": null, "costUsd": null, "turns": null, "createdAt": at(10), "startedAt": at(10), "finishedAt": null, "updatedAt": at(1)
        }))
        .unwrap()
    }

    #[test]
    fn a_pull_request_recorded_directly_is_a_session_and_one_moved_from_a_harness_is_not() {
        let db = seeded();
        db.execute_batch(&format!(
            "INSERT INTO session_entries (pull_id, seq, kind, text, at) VALUES ('pr_api_7', 1, 'prompt', 'Fix it', '{a}'), ('pr_api_7', 2, 'message', 'Done', '{b}');
             INSERT INTO session_entries (pull_id, seq, kind, text, at, session_id, session_seq) VALUES ('pr_web_9', 1, 'message', 'Moved', '{b}', 'ses_cc', 1);
             INSERT INTO session_entries (pull_id, seq, kind, text, at) VALUES ('pr_x_1', 1, 'message', 'Elsewhere', '{b}');
             INSERT INTO session_entries (pull_id, seq, kind, text, at) VALUES ('pr_api_8', 1, 'message', 'g1t', '{c}');
             INSERT INTO agent_runs (id, workspace, repo_id, repo, number, pull_id, kind, agent, status, sandbox, token_hash, created_at, updated_at)
             VALUES ('run_1', 'acme', 'rep_api', 'acme/api', 8, 'pr_api_8', 'implement', 'g1t', 'running', 'sb', 'h', '{a}', '{b}');",
            a = at(10),
            b = at(2),
            c = at(5)
        ))
        .unwrap();
        let rows = recorded(&db, &["rep_web", "rep_api"]);
        let numbers: Vec<u32> = rows.iter().map(|row| row.number).collect();
        assert_eq!(numbers, [7, 8]);
        assert_eq!(rows[0].started_at, at(10));
        assert_eq!(rows[0].has_runs, 0);
        assert_eq!(rows[1].has_runs, 1);
        // Together: the run of g1t's agent stands for its pull request, and
        // the recorded one with nothing behind it is a session of its own.
        let recorded: Vec<(WorkspaceSession, bool)> = rows
            .into_iter()
            .map(|row| {
                let runs = row.has_runs != 0;
                (from_recorded(row, "acme/api", NOW), runs)
            })
            .collect();
        let wanted = Wanted { shown: SessionsShown::Recent, kind: None, harness: None, person: None, item: None };
        let all = merged(Vec::new(), vec![from_run(run(8, "running"), "rep_api", None)], recorded, &wanted, 10);
        let kinds: Vec<(SessionKind, &str)> = all.iter().map(|session| (session.kind, session.id.as_str())).collect();
        assert_eq!(kinds, [(SessionKind::Agent, "run_1"), (SessionKind::Recorded, "pr_api_7")]);
        assert_eq!(all[0].actor.as_deref(), Some("g1t"));
        assert_eq!(all[0].state, SessionState::Active);
        assert_eq!(all[1].state, SessionState::Active);
        let live_by_bo = Wanted { shown: SessionsShown::Live, kind: Some(SessionKind::Recorded), harness: None, person: Some("bo"), item: None };
        assert_eq!(merged(Vec::new(), Vec::new(), vec![(all[1].clone(), false)], &live_by_bo, 10).len(), 1);
        let by_harness = Wanted { shown: SessionsShown::Recent, kind: None, harness: Some(Harness::Codex), person: None, item: None };
        assert!(merged(Vec::new(), Vec::new(), vec![(all[1].clone(), false)], &by_harness, 10).is_empty());
        // A finished run is not live.
        let live = Wanted { shown: SessionsShown::Live, kind: None, harness: None, person: None, item: None };
        assert!(merged(Vec::new(), vec![from_run(run(8, "succeeded"), "rep_api", None)], Vec::new(), &live, 10).is_empty());
    }

    #[test]
    fn every_kind_reads_as_one_shape_and_a_quiet_session_reads_as_ended() {
        let session: Session = serde_json::from_value(serde_json::json!({
            "id": "ses_q", "repoId": "rep_api", "item": null, "pull": 7, "branch": "fix", "actor": { "id": "usr_2", "username": "bo" },
            "harness": "claude_managed_agents", "harnessSessionId": null, "title": "Fix it", "state": "idle", "headCommit": null,
            "startedAt": at(60), "lastSeenAt": at(40), "endedAt": null, "endReason": null, "subagents": 2
        }))
        .unwrap();
        let listed = from_session(session, "acme/api", NOW);
        assert_eq!(listed.kind, SessionKind::Hosted);
        assert_eq!(listed.state, SessionState::Ended);
        assert_eq!(listed.session.as_ref().unwrap().end_reason.as_deref(), Some("timed_out"));
        assert_eq!(listed.subagents, 2);
        assert_eq!(listed.repo, "acme/api");
        // A recorded one on the pull request this session is on is this session.
        let recorded = RecordedRow {
            pull_id: "pr_api_7".into(),
            repo_id: "rep_api".into(),
            number: 7,
            title: "Fix it".into(),
            status: PullStatus::Open,
            agent: "cursor".into(),
            author_name: "bo".into(),
            item: None,
            started_at: at(60),
            last_at: at(50),
            has_runs: 0,
        };
        let wanted = Wanted { shown: SessionsShown::Recent, kind: None, harness: None, person: None, item: None };
        let all = merged(vec![listed], Vec::new(), vec![(from_recorded(recorded, "acme/api", NOW), false)], &wanted, 10);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "ses_q");
    }

    #[test]
    fn a_session_linked_to_a_work_item_is_listed_for_it() {
        // On no work item of its own, but linked to #12 (a claim, a trailer).
        let session: Session = serde_json::from_value(serde_json::json!({
            "id": "ses_l", "repoId": "rep_api", "item": null, "pull": null, "branch": null, "actor": { "id": "usr_2", "username": "bo" },
            "harness": "codex", "harnessSessionId": null, "title": null, "state": "active", "headCommit": null,
            "startedAt": at(5), "lastSeenAt": at(1), "endedAt": null, "endReason": null, "subagents": 0
        }))
        .unwrap();
        let listed = from_session(session, "acme/api", NOW);
        let for_item = Wanted { shown: SessionsShown::Recent, kind: None, harness: None, person: None, item: Some(12) };
        assert_eq!(merged(vec![listed], Vec::new(), Vec::new(), &for_item, 10).len(), 1);
    }

    #[test]
    fn pull_facts_and_busy_queues_are_read_across_repositories() {
        let db = seeded();
        let pairs = serde_json::json!([{ "r": "rep_web", "n": 9 }, { "r": "rep_api", "n": 7 }, { "r": "rep_api", "n": 99 }]).to_string();
        let mut statement = db.prepare(PULL_FACTS).unwrap();
        let mut facts: Vec<(String, u32, String, Option<u32>)> = statement
            .query_map(params![pairs], |row| Ok((row.get("repo_id")?, row.get("number")?, row.get("title")?, row.get("item")?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        facts.sort();
        assert_eq!(facts, [("rep_api".into(), 7, "Recorded only".into(), None), ("rep_web".into(), 9, "Say hello".into(), Some(4))]);
        db.execute_batch(
            "INSERT INTO queue_entries (id, repo_id, pull_id, number, state, enqueued_by, created_at) VALUES
               ('q1', 'rep_api', 'pr_api_7', 7, 'waiting', '{}', '1'), ('q2', 'rep_api', 'pr_api_8', 8, 'testing', '{}', '2'),
               ('q3', 'rep_web', 'pr_web_9', 9, 'landed', '{}', '3'), ('q4', 'rep_x', 'pr_x_1', 1, 'waiting', '{}', '4');",
        )
        .unwrap();
        let mut statement = db.prepare(QUEUED_REPOS).unwrap();
        let busy: Vec<String> =
            statement.query_map(params![r#"["rep_web","rep_api"]"#, 12], |row| row.get::<_, String>("value")).unwrap().map(Result::unwrap).collect();
        assert_eq!(busy, ["rep_api"]);
    }
}
