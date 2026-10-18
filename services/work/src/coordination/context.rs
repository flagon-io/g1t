//! `get_work`: everything about a work item an agent needs to pick it up,
//! in one call. What it is for and what done means, the repositories it is
//! linked to with their pull requests for it and what landed where, what
//! is still missing, where else it may belong (suggested targets), who is
//! on it, what it waits on and what waits on it, the decisions made about
//! it, and its latest coordination events.

use std::collections::HashMap;

use futures_util::future::{try_join, try_join_all, try_join3};
use g1t_contracts::access::Capability;
use g1t_contracts::decisions::{Decision, DecisionKind, ListDecisionsArgs};
use g1t_contracts::events::{Event, ListArgs as ListEventsArgs};
use g1t_contracts::repos::{ReadableArgs, Repo};
use g1t_contracts::work::*;
use g1t_contracts::{Outcome, Viewer};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use super::{SESSION_COLUMNS, SessionRow, unwrap_or_fail};
use crate::Work;
use crate::items::{self, Held, PastLanding};
use crate::rows::{PULL_COLUMNS, PullRow};

/// How many sessions, decisions, events and suggestions `get_work` gives
/// at most.
const SESSIONS: u32 = 50;
const DECISIONS: u32 = 20;
const EVENTS: u32 = 20;
const SUGGESTIONS: usize = 5;
/// How many earlier landings suggestions are drawn from.
const LANDINGS: u32 = 200;

#[derive(Deserialize)]
struct PlaceRow {
    state: QueueState,
    position: u32,
}

/// A repository of the workspace, and how many files sessions on the work
/// item touched in it.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TouchedRow {
    pub repo_id: String,
    pub files: u32,
}

/// The repositories where sessions on work item `?1` touched files.
const TOUCHED_FOR: &str = "SELECT s.repo_id AS repo_id, count(*) AS files
     FROM session_touches t JOIN sessions s ON s.id = t.session_id
     WHERE t.kind = 'file'
       AND (s.item_id = ?1 OR s.id IN (SELECT session_id FROM session_links WHERE kind = 'item' AND item_id = ?1))
     GROUP BY s.repo_id";

/// The words of `text` that say something: lowercase, four letters or
/// more.
fn words(text: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for word in text.split(|c: char| !c.is_alphanumeric()).map(str::to_lowercase) {
        if word.chars().count() >= 4 && !found.contains(&word) {
            found.push(word);
        }
    }
    found
}

/// Where a work item may belong besides where it is meant to land already:
/// the workspace's repositories (`candidates`, by id and path), ranked by
/// where work items sharing its labels or title words landed before, by a
/// repository's name in its title or description, and by where sessions on
/// it touched files. Each says why; the likeliest come first.
pub(crate) fn suggest_targets(
    item: &WorkItem,
    candidates: &[(String, String)],
    landed: &[PastLanding],
    touched: &[TouchedRow],
) -> Vec<SuggestedTarget> {
    // A closed work item needs nowhere else to land.
    if item.state == State::Closed {
        return Vec::new();
    }
    let title_words = words(&item.title);
    let text = format!("{}\n{}", item.title, item.body).to_lowercase();
    let mut suggested: Vec<SuggestedTarget> = Vec::new();
    let counted = |n: u32| if n == 1 { "1 work item".to_owned() } else { format!("{n} work items") };
    for (repo_id, path) in candidates {
        // Linked already, as its origin, a target or touched.
        if item.repos.iter().any(|repo| repo.repo_id == *repo_id) {
            continue;
        }
        let mut score = 0;
        let mut why: Vec<String> = Vec::new();
        let landings: Vec<&PastLanding> = landed.iter().filter(|landing| landing.repo_id == *repo_id).collect();
        let labelled = landings
            .iter()
            .filter(|landing| {
                let labels: Vec<String> = serde_json::from_str(&landing.labels).unwrap_or_default();
                labels.iter().any(|label| item.labels.contains(label))
            })
            .count() as u32;
        if labelled > 0 {
            score += 3 * labelled;
            why.push(format!("{} with the same labels landed there", counted(labelled)));
        }
        let alike = landings.iter().filter(|landing| words(&landing.title).iter().any(|word| title_words.contains(word))).count() as u32;
        if alike > 0 {
            score += 2 * alike;
            why.push(format!("{} with like titles landed there", counted(alike)));
        }
        let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
        let names_it = text.split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_' || c == '.')).any(|word| word == name);
        if names_it || text.contains(&path.to_lowercase()) {
            score += 5;
            why.push(format!("it names {name}"));
        }
        if let Some(found) = touched.iter().find(|found| found.repo_id == *repo_id) {
            score += 4;
            why.push(format!("sessions on it touched {} files there", found.files));
        }
        if score > 0 {
            let mut why = why.join("; ");
            if let Some(first) = why.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            suggested.push(SuggestedTarget { repo_id: repo_id.clone(), path: path.clone(), why: format!("{why}."), score });
        }
    }
    suggested.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    suggested.truncate(SUGGESTIONS);
    suggested
}

/// Who is on a work item of `workspace`, as `viewer` is shown it: the
/// claims and sessions in repositories they may read (`readable`), each
/// session as `shown` lets them see it.
fn shown_people(claims: Vec<Claim>, mut sessions: Vec<Session>, readable: &[String], viewer: &Viewer, workspace: &str) -> (Vec<Claim>, Vec<Session>) {
    let may_read = |repo_id: &str| readable.iter().any(|id| id == repo_id);
    let claims = claims.into_iter().filter(|claim| claim.repo_id.as_deref().is_none_or(may_read)).collect();
    sessions.retain(|session| may_read(&session.repo_id));
    super::shown::sessions(&mut sessions, viewer, workspace);
    (claims, sessions)
}

impl Work {
    pub(crate) async fn get_work(&self, a: WorkItemViewArgs) -> Result<Outcome<WorkContext>> {
        let held = unwrap_or_fail!(items::for_viewer(self, &a.viewer, &a.workspace, a.number, Capability::Read).await?);
        // What went quiet in its repositories is read as it is now.
        for repo_id in held.repo_ids().iter().take(10) {
            self.sweep(repo_id).await?;
        }
        let pulls: Vec<Pull> = self
            .db
            .prepare(format!("SELECT {PULL_COLUMNS} FROM pulls WHERE item_id = ? ORDER BY created_at"))
            .bind(&[held.item.id.as_str().into()])?
            .all()
            .await?
            .results::<PullRow>()?
            .into_iter()
            .map(Pull::from)
            .collect();
        // The repositories it is linked to and has pull requests in, as far
        // as the viewer may read them.
        let mut ids = held.repo_ids();
        for pull in &pulls {
            if !ids.contains(&pull.repo_id) {
                ids.push(pull.repo_id.clone());
            }
        }
        let readable: Vec<Repo> = g1t_kit::call(&self.repos, "readable", &ReadableArgs { ids, viewer: a.viewer.clone() }).await?;
        let pulls: Vec<Pull> = pulls.into_iter().filter(|pull| readable.iter().any(|repo| repo.id == pull.repo_id)).collect();
        let mut numbers = vec![held.item.number];
        numbers.extend(pulls.iter().map(|pull| pull.number));
        let viewer = a.viewer.as_ref();
        let may_read = |repo_id: &str| readable.iter().any(|repo| repo.id == repo_id);

        let people = try_join3(
            self.active_claims(&held.item.id),
            self.work_sessions(&held, &pulls),
            self.suggestions(&held, viewer),
        );
        let dependencies = try_join(self.blockers(viewer, &held.item.workspace, &held.item.blocked_by), items::blocked_items(self, &held, viewer));
        // Only the repositories the viewer may read: the events service
        // takes the ids it is given as checked.
        let linked: Vec<String> = held.repo_ids().into_iter().filter(|id| may_read(id)).collect();
        let history = try_join(
            self.coordination_events(&linked, &numbers, COORDINATION_EVENTS.to_vec(), EVENTS),
            self.decisions_on(&held, &a.viewer),
        );
        let repos = try_join_all(held.item.repos.iter().filter_map(|link| {
            let repo = readable.iter().find(|repo| repo.id == link.repo_id)?;
            let mine: Vec<&Pull> = pulls.iter().filter(|pull| pull.repo_id == repo.id).collect();
            Some(self.work_repo(link.clone(), repo, mine))
        }));
        let (((claims, sessions, suggested_targets), (blocked_by, blocks)), ((recent, decisions), repos)) =
            try_join(try_join(people, dependencies), try_join(history, repos)).await?;
        let readable_ids: Vec<String> = readable.iter().map(|repo| repo.id.clone()).collect();
        let (claims, sessions) = shown_people(claims, sessions, &readable_ids, &a.viewer, &held.item.workspace);
        let item = held.shown(viewer);
        Ok(Outcome::Ok(WorkContext {
            definition_of_done: definition_of_done(&item.body),
            missing: item.missing(),
            item,
            repos,
            suggested_targets,
            claims,
            sessions,
            blocked_by,
            blocks,
            last_integration_failure: decisions.iter().find(|decision| decision.kind == DecisionKind::IntegrationFailure).cloned(),
            decisions,
            recent,
        }))
    }

    /// One repository a work item is linked to: its required checks, and
    /// its pull requests for the item.
    async fn work_repo(&self, link: ItemRepo, repo: &Repo, pulls: Vec<&Pull>) -> Result<WorkRepo> {
        let settings = self.default_branch_settings(repo).await?;
        let pulls = try_join_all(pulls.into_iter().map(|pull| self.work_pull(repo, pull))).await?;
        Ok(WorkRepo { link, required_checks: settings.required_checks, pulls })
    }

    /// Where else a work item may belong ([`suggest_targets`]), among the
    /// repositories `viewer` may read.
    async fn suggestions(&self, held: &Held, viewer: Option<&g1t_contracts::User>) -> Result<Vec<SuggestedTarget>> {
        #[derive(Deserialize)]
        struct Candidate {
            repo_id: String,
            path: String,
            workspace: String,
            private: u8,
        }
        if held.item.state == State::Closed {
            return Ok(Vec::new());
        }
        let results = self
            .db
            .batch(vec![
                self.db
                    .prepare("SELECT repo_id, path, workspace, private FROM repo_workspaces WHERE workspace = ? ORDER BY path LIMIT 500")
                    .bind(&[held.item.workspace.as_str().into()])?,
                self.db.prepare(TOUCHED_FOR).bind(&[held.item.id.as_str().into()])?,
            ])
            .await?;
        let mut results = results.into_iter();
        let candidates: Vec<(String, String)> = match results.next() {
            Some(result) => result
                .results::<Candidate>()?
                .into_iter()
                .filter(|row| items::repo_readable(viewer, &row.repo_id, Some(&row.workspace), Some(row.private)))
                .map(|row| (row.repo_id, row.path))
                .collect(),
            None => Vec::new(),
        };
        let landed = items::landed_before(self, held, LANDINGS).await?;
        let touched: Vec<TouchedRow> = match results.next() {
            Some(result) => result.results()?,
            None => Vec::new(),
        };
        Ok(suggest_targets(&held.item, &candidates, &landed, &touched))
    }

    /// Sessions on a work item or its pull requests, in any of their
    /// repositories, most recently heard from first. Subagents are listed
    /// beside the sessions that started them, so sibling agents on one
    /// work item see each other; so are sessions tied to it any other way
    /// (a claim, a branch, a trailer, `#N`).
    async fn work_sessions(&self, held: &Held, pulls: &[Pull]) -> Result<Vec<Session>> {
        let now = now_ms();
        let mut pushed: Vec<String> = Vec::new();
        let mut by_repo: HashMap<&str, Vec<u32>> = HashMap::new();
        for pull in pulls {
            by_repo.entry(pull.repo_id.as_str()).or_default().push(pull.number);
        }
        for (repo_id, numbers) in &by_repo {
            pushed.extend(self.branch_sessions(repo_id, numbers).await?);
        }
        let pull_ids: Vec<&str> = pulls.iter().map(|pull| pull.id.as_str()).collect();
        let mut sessions: Vec<Session> = self
            .db
            .prepare(format!(
                "SELECT {SESSION_COLUMNS} FROM sessions
                 WHERE item_id = ?1
                   OR id IN (SELECT value FROM json_each(?3))
                   OR EXISTS (SELECT 1 FROM pulls p WHERE p.id IN (SELECT value FROM json_each(?2))
                     AND p.repo_id = sessions.repo_id AND p.number = sessions.pull)
                   OR id IN (SELECT session_id FROM session_links WHERE kind = 'item' AND item_id = ?1)
                   OR id IN (SELECT l.session_id FROM session_links l JOIN pulls p ON p.repo_id = l.repo_id AND p.number = l.number
                     WHERE l.kind = 'pull' AND p.id IN (SELECT value FROM json_each(?2)))
                 ORDER BY state = 'ended', last_seen_at DESC LIMIT ?4"
            ))
            .bind(&[
                held.item.id.as_str().into(),
                serde_json::to_string(&pull_ids)?.into(),
                serde_json::to_string(&pushed)?.into(),
                SESSIONS.into(),
            ])?
            .all()
            .await?
            .results::<SessionRow>()?
            .into_iter()
            .map(|row| row.at(now))
            .collect();
        self.fill_subagents(&mut sessions).await?;
        Ok(sessions)
    }

    /// The latest events of `types` about `numbers` in `repos`, newest
    /// first.
    async fn coordination_events(&self, repos: &[String], numbers: &[u32], types: Vec<&str>, limit: u32) -> Result<Vec<Event>> {
        if repos.is_empty() {
            return Ok(Vec::new());
        }
        g1t_kit::call(
            &self.events,
            "list",
            &ListEventsArgs {
                repo_ids: repos.to_vec(),
                types: types.into_iter().map(str::to_owned).collect(),
                numbers: numbers.to_vec(),
                limit: Some(limit),
                ..ListEventsArgs::default()
            },
        )
        .await
    }

    /// Decision records on a work item and its pull requests, newest
    /// first, up to [`DECISIONS`].
    async fn decisions_on(&self, held: &Held, viewer: &Viewer) -> Result<Vec<Decision>> {
        let args = ListDecisionsArgs {
            repo: None,
            workspace: held.item.workspace.clone(),
            viewer: viewer.clone(),
            number: held.item.number,
        };
        let mut decisions = match self.list_decisions(args).await? {
            Outcome::Ok(decisions) => decisions,
            Outcome::Fail(_) => Vec::new(),
        };
        decisions.reverse();
        decisions.truncate(DECISIONS as usize);
        Ok(decisions)
    }

    /// One of the work item's pull requests and where it stands: its
    /// required checks, whether it merges, what it overlaps and its place
    /// in the merge queue, for those still in progress.
    async fn work_pull(&self, repo: &Repo, pull: &Pull) -> Result<WorkPull> {
        let mut pull = pull.clone();
        crate::fill_base(&mut pull, repo);
        let brief = |pull: &Pull| WorkPull {
            repo: items::path_of(repo),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn item(title: &str, body: &str, labels: &[&str], repos: Vec<ItemRepo>) -> WorkItem {
        serde_json::from_value(serde_json::json!({
            "id": "wki_1", "workspace": "acme", "number": 7, "title": title, "body": body,
            "labels": labels, "state": "open", "reason": null, "author": { "id": "usr_1", "username": "ana" },
            "createdAt": "", "updatedAt": "", "closedAt": null, "pullCount": 0, "commentCount": 0,
            "repos": repos
        }))
        .unwrap()
    }

    fn landing(repo: &str, title: &str, labels: &str) -> PastLanding {
        PastLanding { repo_id: repo.into(), title: title.into(), labels: labels.into() }
    }

    #[test]
    fn suggestions_say_why_and_come_likeliest_first() {
        let candidates = vec![
            ("rep_api".to_owned(), "acme/api".to_owned()),
            ("rep_web".to_owned(), "acme/web".to_owned()),
            ("rep_docs".to_owned(), "acme/docs".to_owned()),
        ];
        let item = item("Login page shows a stale avatar", "The web client caches it.", &["bug"], Vec::new());
        let landed = vec![
            landing("rep_api", "Avatar upload fails", r#"["bug"]"#),
            landing("rep_api", "Rate limits", r#"["enhancement"]"#),
            landing("rep_docs", "Typo", "[]"),
        ];
        let touched = vec![TouchedRow { repo_id: "rep_web".into(), files: 3 }];
        let suggested = suggest_targets(&item, &candidates, &landed, &touched);
        let paths: Vec<&str> = suggested.iter().map(|s| s.path.as_str()).collect();
        assert_eq!(paths, ["acme/web", "acme/api"]);
        assert_eq!(suggested[0].why, "It names web; sessions on it touched 3 files there.");
        assert_eq!(suggested[1].why, "1 work item with the same labels landed there; 1 work item with like titles landed there.");
        assert!(suggested[0].score > suggested[1].score);
    }

    #[test]
    fn a_repository_already_linked_is_not_suggested() {
        let candidates = vec![("rep_web".to_owned(), "acme/web".to_owned())];
        for role in LinkRole::ALL {
            let linked = ItemRepo { repo_id: "rep_web".into(), path: "acme/web".into(), role, legacy_number: None, landed: false };
            let item = item("Fix web", "", &[], vec![linked]);
            assert!(suggest_targets(&item, &candidates, &[], &[]).is_empty(), "{role:?}");
        }
    }

    #[test]
    fn sessions_and_claims_are_shown_as_the_viewer_may_see_them() {
        let public = super::super::shown::tests::a_session();
        let private = Session { id: "ses_2".into(), repo_id: "rep_secret".into(), ..public.clone() };
        let (_, sessions) = shown_people(Vec::new(), vec![public, private], &["rep_1".to_owned()], &None, "acme");
        // Only the one in a repository they may read, and not what is inside it.
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "ses_1");
        assert_eq!(sessions[0].branch, None);
        assert_eq!(sessions[0].title, None);
    }

    #[test]
    fn a_closed_work_item_gets_no_suggestions() {
        let candidates = vec![("rep_web".to_owned(), "acme/web".to_owned())];
        let mut closed = item("Fix web", "", &[], Vec::new());
        assert_eq!(suggest_targets(&closed, &candidates, &[], &[]).len(), 1);
        closed.state = State::Closed;
        assert!(suggest_targets(&closed, &candidates, &[], &[]).is_empty());
    }
}
