//! `get_work`: everything about an issue an agent needs to pick it up, in
//! one call. What it is for and what done means, who is on it, the pull
//! requests already made for it and where each stands, what it waits on
//! and what waits on it, the decisions made about it, and its latest
//! coordination events.

use futures_util::future::{try_join, try_join_all, try_join3};
use g1t_contracts::events::{Event, ListArgs as ListEventsArgs};
use g1t_contracts::repos::Repo;
use g1t_contracts::decisions::{Decision, DecisionKind, ListDecisionsArgs};
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use super::{SESSION_COLUMNS, SessionRow, unwrap_or_fail};
use crate::Work;
use crate::rows::{PULL_COLUMNS, PullRow};

/// How many sessions, decisions and events `get_work` gives at most.
const SESSIONS: u32 = 50;
const DECISIONS: u32 = 20;
const EVENTS: u32 = 20;

#[derive(Deserialize)]
struct PlaceRow {
    state: QueueState,
    position: u32,
}

impl Work {
    pub(crate) async fn get_work(&self, a: GetWorkArgs) -> Result<Outcome<WorkContext>> {
        let repo = unwrap_or_fail!(self.coordination_repo(&a.repo, &a.viewer).await?);
        let Some(issue) = self.issue(&repo.id, a.number).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Issue not found."));
        };
        let pulls: Vec<Pull> = self
            .db
            .prepare(format!("SELECT {PULL_COLUMNS} FROM pulls WHERE issue_id = ? ORDER BY number"))
            .bind(&[issue.id.as_str().into()])?
            .all()
            .await?
            .results::<PullRow>()?
            .into_iter()
            .map(Pull::from)
            .collect();
        let pull_numbers: Vec<u32> = pulls.iter().map(|pull| pull.number).collect();
        let mut numbers = vec![issue.number];
        numbers.extend(&pull_numbers);

        let people = try_join3(
            self.active_claims(&repo.id, issue.number),
            self.work_sessions(&repo.id, issue.number, &pull_numbers),
            self.default_branch_settings(&repo),
        );
        let dependencies = try_join(self.blockers(&repo.id, &issue.blocked_by), self.blocked_issues(&repo.id, issue.number));
        let history = try_join(
            self.coordination_events(&repo.id, &numbers, COORDINATION_EVENTS.to_vec(), EVENTS),
            self.decisions_on(&a.repo, &a.viewer, issue.number),
        );
        let work_pulls = try_join_all(pulls.iter().map(|pull| self.work_pull(&repo, pull)));
        let (((claims, sessions, settings), (blocked_by, blocks)), ((recent, decisions), pulls)) =
            try_join(try_join(people, dependencies), try_join(history, work_pulls)).await?;
        Ok(Outcome::Ok(WorkContext {
            definition_of_done: definition_of_done(&issue.body),
            required_checks: settings.required_checks,
            issue,
            claims,
            sessions,
            pulls,
            blocked_by,
            blocks,
            last_integration_failure: decisions.iter().find(|decision| decision.kind == DecisionKind::IntegrationFailure).cloned(),
            decisions,
            recent,
        }))
    }

    /// Sessions on an issue or its pull requests, most recently heard from
    /// first.
    /// Subagents are listed beside the sessions that started them, so
    /// sibling agents on one issue see each other; so are sessions tied to
    /// it any other way (a claim, a branch, a trailer, `#N`).
    async fn work_sessions(&self, repo_id: &str, issue: u32, pulls: &[u32]) -> Result<Vec<Session>> {
        let now = now_ms();
        let pushed = self.branch_sessions(repo_id, pulls).await?;
        let mut sessions: Vec<Session> = self
            .db
            .prepare(format!(
                "SELECT {SESSION_COLUMNS} FROM sessions
                 WHERE repo_id = ?1 AND (issue = ?2 OR pull IN (SELECT value FROM json_each(?3))
                   OR id IN (SELECT value FROM json_each(?5))
                   OR id IN (SELECT session_id FROM session_links WHERE repo_id = ?1
                     AND ((kind = 'issue' AND number = ?2) OR (kind = 'pull' AND number IN (SELECT value FROM json_each(?3))))))
                 ORDER BY state = 'ended', last_seen_at DESC LIMIT ?4"
            ))
            .bind(&[repo_id.into(), issue.into(), serde_json::to_string(pulls)?.into(), SESSIONS.into(), serde_json::to_string(&pushed)?.into()])?
            .all()
            .await?
            .results::<SessionRow>()?
            .into_iter()
            .map(|row| row.at(now))
            .collect();
        self.fill_subagents(&mut sessions).await?;
        Ok(sessions)
    }

    /// The latest events of `types` about `numbers`, newest first.
    async fn coordination_events(&self, repo_id: &str, numbers: &[u32], types: Vec<&str>, limit: u32) -> Result<Vec<Event>> {
        g1t_kit::call(
            &self.events,
            "list",
            &ListEventsArgs {
                repo_id: Some(repo_id.to_owned()),
                types: types.into_iter().map(str::to_owned).collect(),
                numbers: numbers.to_vec(),
                limit: Some(limit),
                ..ListEventsArgs::default()
            },
        )
        .await
    }

    /// Decision records on an issue and its pull requests, newest first,
    /// up to [`DECISIONS`].
    async fn decisions_on(&self, repo: &g1t_contracts::repos::RepoPath, viewer: &g1t_contracts::Viewer, number: u32) -> Result<Vec<Decision>> {
        let args = ListDecisionsArgs { repo: repo.clone(), viewer: viewer.clone(), number };
        let mut decisions = match self.list_decisions(args).await? {
            Outcome::Ok(decisions) => decisions,
            Outcome::Fail(_) => Vec::new(),
        };
        decisions.reverse();
        decisions.truncate(DECISIONS as usize);
        Ok(decisions)
    }

    /// One of the issue's pull requests and where it stands: its required
    /// checks, whether it merges, what it overlaps and its place in the
    /// merge queue, for those still in progress.
    async fn work_pull(&self, repo: &Repo, pull: &Pull) -> Result<WorkPull> {
        let mut pull = pull.clone();
        crate::fill_base(&mut pull, repo);
        let brief = |pull: &Pull| WorkPull {
            number: pull.number,
            title: pull.title.clone(),
            status: pull.status,
            branch: pull.branch.clone(),
            head_commit: pull.head_commit.clone(),
            author: pull.owner().into(),
            check_status: pull.check_status,
            required_checks: Vec::new(),
            mergeable: Mergeable::Unknown,
            overlaps: Vec::new(),
            queue: None,
        };
        if !pull.status.is_active() {
            return Ok(brief(&pull));
        }
        let required = async {
            let settings = self.settings_on(repo, &pull).await?;
            if settings.required_checks.is_empty() {
                return Ok(Vec::new());
            }
            let statuses = self.statuses(&repo.id, pull.head_commit.as_deref()).await?;
            let checked = self.with_job_checks(&repo.id, pull.head_commit.as_deref(), statuses).await?;
            Ok::<_, worker::Error>(required_checks(&settings.required_checks, &checked))
        };
        let place_query = self
            .db
            .prepare(
                "SELECT mine.state AS state,
                   (SELECT count(*) FROM queue_entries ahead
                    WHERE ahead.repo_id = mine.repo_id AND ahead.state IN ('waiting', 'testing', 'passed')
                      AND (ahead.created_at < mine.created_at
                           OR (ahead.created_at = mine.created_at AND ahead.id < mine.id))) + 1 AS position
                 FROM queue_entries mine
                 WHERE mine.pull_id = ? AND mine.state IN ('waiting', 'testing', 'passed') LIMIT 1",
            )
            .bind(&[pull.id.as_str().into()])?;
        let place = place_query.first::<PlaceRow>(None);
        let ((required_checks, (mergeable, _)), (overlaps, place)) =
            try_join(try_join(required, self.mergeability(&pull)), try_join(self.overlaps(&pull), place)).await?;
        Ok(WorkPull {
            required_checks,
            mergeable,
            overlaps,
            queue: place.map(|place| QueuePlace { state: place.state, position: place.position }),
            ..brief(&pull)
        })
    }
}
