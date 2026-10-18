//! What sessions touched, and the work items and pull requests they worked
//! on.
//!
//! A session is tied to a work item or pull request in as many ways as it
//! was (`LinkVia`): attached when it started or updated, a claim it made,
//! a pull request it opened or a branch or commit of one, a
//! `G1t-Session:` trailer on a commit pushed to one, and `#N` in its
//! prompt, its task or a subagent's. Each way is a row of
//! `session_links`; reading a session gathers its whole tree's
//! (`gather_links`). Files two sessions touched make them overlap
//! (`overlap.detected`, once per pair).

use std::collections::{HashMap, HashSet};

use g1t_contracts::Outcome;
use g1t_contracts::repos::{Commit, LogArgs, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use super::updates::push_delivery;
use super::{SESSION_COLUMNS, SessionRow};
use crate::items::{self, Named};
use crate::Work;

/// The start (`?2` characters) of the first prompt each session in `?1`
/// (a JSON list of ids) recorded, by the session's own numbering.
pub(crate) const FIRST_PROMPTS: &str = "SELECT session_id, text FROM (
   SELECT ids.value AS session_id,
     (SELECT substr(e.text, 1, ?2) FROM session_entries e
      WHERE e.session_id = ids.value AND e.kind = 'prompt' ORDER BY e.session_seq LIMIT 1) AS text
   FROM json_each(?1) AS ids)
 WHERE text IS NOT NULL";

/// The most `#N` of one text looked up.
const MAX_REFS: usize = 10;
/// The most work items and pull requests a session's links name.
const MAX_LINKED: usize = 40;
/// The most commits of one push read for trailers.
const MAX_TRAILER_COMMITS: u32 = 20;
/// The most subagents a tree shows.
pub(crate) const MAX_TREE: u32 = 200;

/// Ties session `?1` of repository `?2` to pull request `?4` (`?3` `pull`,
/// `?7` empty) or work item `?7` (`?3` `item`, `?4` 0) by way of `?5`, at
/// `?6`; nothing when it is tied that way already.
pub(crate) const INSERT_LINK: &str = "INSERT INTO session_links (session_id, repo_id, kind, number, via, at, item_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO NOTHING";

/// Records that session `?1` of repository `?2` touched (`?3`) `?4`, at
/// `?5`; returns it only the first time.
pub(crate) const INSERT_TOUCH: &str = "INSERT INTO session_touches (session_id, repo_id, kind, value, at)
     VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING RETURNING kind, value";

/// Session `?1`'s subagents, and theirs, in the order they started.
pub(crate) fn tree_sql() -> String {
    format!(
        "WITH RECURSIVE tree(id) AS (
           SELECT id FROM sessions WHERE parent_id = ?1
           UNION SELECT s.id FROM sessions s JOIN tree ON s.parent_id = tree.id)
         SELECT {SESSION_COLUMNS} FROM sessions WHERE id IN (SELECT id FROM tree)
         ORDER BY started_at, id LIMIT {MAX_TREE}"
    )
}

/// Ends session `?1`'s subagents still going, and theirs, at `?2` for
/// `?3`: only once `?1` itself ended at `?2`, so in the batch that ends it,
/// a call that lost the race to end it ends nothing.
pub(crate) fn end_tree_sql() -> String {
    format!(
        "WITH RECURSIVE tree(id) AS (
           SELECT id FROM sessions WHERE parent_id = ?1
           UNION SELECT s.id FROM sessions s JOIN tree ON s.parent_id = tree.id)
         UPDATE sessions SET state = 'ended', ended_at = ?2, end_reason = ?3, last_seen_at = ?2
         WHERE id IN (SELECT id FROM tree) AND state = 'active'
           AND EXISTS (SELECT 1 FROM sessions WHERE id = ?1 AND state = 'ended' AND ended_at = ?2)
         RETURNING {SESSION_COLUMNS}"
    )
}

/// Session `?1`'s line: its parents up to the top, and its subagents and
/// theirs. Never told of overlapping with each other.
pub(crate) const FAMILY: &str = "WITH RECURSIVE
       up(id, parent) AS (
         SELECT id, parent_id FROM sessions WHERE id = ?1
         UNION SELECT s.id, s.parent_id FROM sessions s JOIN up ON s.id = up.parent),
       down(id) AS (
         SELECT id FROM sessions WHERE parent_id = ?1
         UNION SELECT s.id FROM sessions s JOIN down ON s.parent_id = down.id)
     SELECT id FROM up UNION SELECT id FROM down";

/// The files of `?2` (JSON) that active sessions of repository `?1` other
/// than `?3` touched.
pub(crate) const TOUCHED_BY_OTHERS: &str = "SELECT t.session_id AS session_id, t.value AS value
     FROM session_touches t JOIN sessions s ON s.id = t.session_id
     WHERE t.repo_id = ?1 AND t.kind = 'file' AND t.value IN (SELECT value FROM json_each(?2))
       AND t.session_id <> ?3 AND s.state = 'active'";

/// The sessions of repository `?1` that pushed the branch of one of the
/// pull requests `?2` (JSON numbers).
pub(crate) const BRANCH_SESSIONS: &str = "SELECT DISTINCT t.session_id AS id FROM session_touches t
     JOIN pulls p ON p.repo_id = t.repo_id AND p.source_branch = t.value
       AND p.fork_repo_id IS NULL AND p.head_repo_id IS NULL
     WHERE t.repo_id = ?1 AND t.kind = 'branch' AND p.number IN (SELECT value FROM json_each(?2)) LIMIT 200";

/// The sessions tied to repository `?1`'s pull requests numbered in `?2`
/// (JSON): by a link, by saying so when they started, or by pushing the
/// branch. A subagent is named with the session that started it.
pub(crate) const PULL_SESSIONS: &str = "WITH asked(n) AS (SELECT value FROM json_each(?2)),
   tied(number, session_id) AS (
     SELECT l.number, l.session_id FROM session_links l WHERE l.repo_id = ?1 AND l.kind = 'pull' AND l.number IN asked
     UNION SELECT s.pull, s.id FROM sessions s WHERE s.repo_id = ?1 AND s.pull IN asked
     UNION SELECT p.number, t.session_id FROM session_touches t
       JOIN pulls p ON p.repo_id = t.repo_id AND p.source_branch = t.value AND p.fork_repo_id IS NULL AND p.head_repo_id IS NULL
       WHERE t.repo_id = ?1 AND t.kind = 'branch' AND p.number IN asked)
 SELECT tied.number AS number, s.id AS id, s.harness AS harness, s.parent_id AS parent_id, s.started_at AS started_at,
   (SELECT p.harness FROM sessions p WHERE p.id = s.parent_id) AS parent_harness
 FROM tied JOIN sessions s ON s.id = tied.session_id
 ORDER BY tied.number, s.started_at LIMIT 1000";

/// A row of [`PULL_SESSIONS`].
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct PullSessionRow {
    pub number: u32,
    pub id: String,
    pub harness: String,
    pub parent_id: Option<String>,
    pub parent_harness: Option<String>,
}

/// Each pull request's sessions, a subagent's as the session that started
/// it, each once, oldest first.
pub(crate) fn pull_sessions_of(rows: Vec<PullSessionRow>) -> Vec<PullSessions> {
    let mut out: Vec<PullSessions> = Vec::new();
    for row in rows {
        let (id, harness) = match (row.parent_id, row.parent_harness) {
            (Some(parent), Some(harness)) => (parent, harness),
            _ => (row.id, row.harness),
        };
        let session = SessionRef { id, harness: Harness::parse(&harness).unwrap_or(Harness::Other) };
        match out.iter_mut().find(|entry| entry.number == row.number) {
            Some(entry) if entry.sessions.iter().any(|known| known.id == session.id) => {}
            Some(entry) => entry.sessions.push(session),
            None => out.push(PullSessions { number: row.number, sessions: vec![session] }),
        }
    }
    out
}

/// Announces the pair `?2`, `?3` of repository `?1` as overlapping on
/// `?4` (JSON) at `?5`: returns it the first time, and again whenever a
/// file it was not announced for joins, so a pair that first met on a
/// trivial file still hears when it starts changing the same code.
pub(crate) const INSERT_OVERLAP: &str = "INSERT INTO session_overlaps (repo_id, low, high, files, noticed_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (repo_id, low, high) DO UPDATE SET
       files = (SELECT json_group_array(value) FROM (
                  SELECT value FROM json_each(session_overlaps.files)
                  UNION SELECT value FROM json_each(excluded.files))),
       noticed_at = excluded.noticed_at
     WHERE EXISTS (SELECT 1 FROM json_each(excluded.files) AS added
                   WHERE added.value NOT IN (SELECT value FROM json_each(session_overlaps.files)))
     RETURNING low";

#[derive(Deserialize)]
struct IdRow {
    id: String,
}

#[derive(Deserialize)]
struct NumberOnly {
    number: u32,
}

#[derive(Deserialize)]
pub(crate) struct LinkRow {
    session_id: String,
    kind: String,
    /// A pull request's number, or a work item's in its workspace.
    #[serde(default)]
    number: Option<u32>,
    via: String,
}

#[derive(Deserialize)]
pub(crate) struct TouchRow {
    session_id: String,
    kind: String,
    value: String,
    at: String,
}

#[derive(Deserialize)]
struct PairRow {
    session_id: String,
    value: String,
}

#[derive(Deserialize)]
struct SkillRow {
    session_id: String,
    name: String,
    uses: u32,
}

impl Work {
    /// Ties `session_id` to a pull request or a work item one way. Never
    /// fails what it follows: a problem is logged.
    async fn link(&self, session_id: &str, repo_id: &str, kind: LinkKind, number: u32, item_id: &str, via: LinkVia) {
        let at = rfc3339(now_ms());
        let linked = async {
            let new = self
                .db
                .prepare(format!("{INSERT_LINK} RETURNING via"))
                .bind(&[
                    session_id.into(),
                    repo_id.into(),
                    kind.as_str().into(),
                    number.into(),
                    via.as_str().into(),
                    at.as_str().into(),
                    item_id.into(),
                ])?
                .all()
                .await?
                .results::<serde_json::Value>()?;
            // Tied to what it works on for the first time: its title is due (titles.rs).
            if !new.is_empty() && via != LinkVia::Ref {
                self.db.prepare(super::titles::linked_sql()).bind(&[session_id.into(), at.as_str().into()])?.run().await?;
            }
            Ok::<(), worker::Error>(())
        };
        if let Err(error) = linked.await {
            worker::console_error!("session {session_id}: not tied to {} #{number}{item_id}: {error}", kind.as_str());
        }
    }

    /// Ties `session_id` to pull request `number` of `repo_id` one way.
    pub(crate) async fn link_pull(&self, session_id: &str, repo_id: &str, number: u32, via: LinkVia) {
        self.link(session_id, repo_id, LinkKind::Pull, number, "", via).await;
    }

    /// Ties `session_id`, of `repo_id`, to work item `item_id` one way.
    pub(crate) async fn link_item(&self, session_id: &str, repo_id: &str, item_id: &str, via: LinkVia) {
        self.link(session_id, repo_id, LinkKind::Item, 0, item_id, via).await;
    }

    /// Ties a session to what `#N` in `text` names, read in its repository
    /// (`refs`): one of its pull requests, or a work item of its workspace.
    pub(crate) async fn link_refs(&self, session_id: &str, repo_id: &str, text: &str) -> Result<()> {
        let Some(workspace) = items::repo_workspace(self, repo_id).await? else {
            return Ok(());
        };
        for number in refs_in(text).into_iter().take(MAX_REFS) {
            match items::resolve(self, repo_id, &workspace, number).await? {
                Some(Named::PullHere) => self.link_pull(session_id, repo_id, number, LinkVia::Ref).await,
                Some(Named::Item(id)) => self.link_item(session_id, repo_id, &id, LinkVia::Ref).await,
                _ => {}
            }
        }
        Ok(())
    }

    /// Ties a session to the pull requests of `branch`.
    pub(crate) async fn link_branch(&self, session_id: &str, repo_id: &str, branch: &str) -> Result<()> {
        let pulls = self
            .db
            .prepare(
                "SELECT number FROM pulls WHERE repo_id = ? AND source_branch = ?
                   AND fork_repo_id IS NULL AND head_repo_id IS NULL",
            )
            .bind(&[repo_id.into(), branch.into()])?
            .all()
            .await?
            .results::<NumberOnly>()?;
        for pull in pulls {
            self.link_pull(session_id, repo_id, pull.number, LinkVia::Branch).await;
        }
        Ok(())
    }

    /// Ties a session to the pull requests whose head is `commit` (a full
    /// or abbreviated hash).
    pub(crate) async fn link_commit(&self, session_id: &str, repo_id: &str, commit: &str) -> Result<()> {
        let pulls = self
            .db
            .prepare("SELECT number FROM pulls WHERE repo_id = ? AND head_commit IS NOT NULL AND substr(head_commit, 1, length(?2)) = ?2")
            .bind(&[repo_id.into(), commit.into()])?
            .all()
            .await?
            .results::<NumberOnly>()?;
        for pull in pulls {
            self.link_pull(session_id, repo_id, pull.number, LinkVia::Commit).await;
        }
        Ok(())
    }

    /// Records what a session touched, ties it to what that names, and
    /// tells it and the other sessions on the same files that they
    /// overlap. Returns how many were new.
    pub(crate) async fn record_touches(&self, session: &Session, touches: &[NewTouch]) -> Result<u32> {
        let mut touches = tidy_touches(touches);
        if touches.is_empty() {
            return Ok(0);
        }
        // A work item is kept by its id: named by its number in the
        // repository's workspace, one that is none is left out.
        if touches.iter().any(|touch| touch.kind == TouchKind::Item) {
            let workspace = items::repo_workspace(self, &session.repo_id).await?.unwrap_or_default();
            let mut kept = Vec::with_capacity(touches.len());
            for mut touch in touches {
                if touch.kind == TouchKind::Item {
                    let Some(held) = items::by_number(self, &workspace, touch.value.parse().unwrap_or_default()).await? else { continue };
                    touch.value = held.item.id;
                }
                kept.push(touch);
            }
            touches = kept;
        }
        let at = rfc3339(now_ms());
        let mut statements = Vec::with_capacity(touches.len());
        for touch in &touches {
            statements.push(self.db.prepare(INSERT_TOUCH).bind(&[
                session.id.as_str().into(),
                session.repo_id.as_str().into(),
                touch.kind.as_str().into(),
                touch.value.as_str().into(),
                at.as_str().into(),
            ])?);
        }
        let mut new: Vec<NewTouch> = Vec::new();
        for result in self.db.batch(statements).await? {
            for row in result.results::<serde_json::Value>()? {
                if let (Some(kind), Some(value)) = (row["kind"].as_str().and_then(TouchKind::parse), row["value"].as_str()) {
                    new.push(NewTouch { kind, value: value.to_owned() });
                }
            }
        }
        let mut files = Vec::new();
        for touch in &new {
            let number = touch.value.parse::<u32>().ok();
            match (touch.kind, number) {
                (TouchKind::Pull, Some(number)) => self.link_pull(&session.id, &session.repo_id, number, LinkVia::Opened).await,
                (TouchKind::Item, _) => self.link_item(&session.id, &session.repo_id, &touch.value, LinkVia::Ref).await,
                (TouchKind::Branch, _) => self.link_branch(&session.id, &session.repo_id, &touch.value).await?,
                (TouchKind::Commit, _) => self.link_commit(&session.id, &session.repo_id, &touch.value).await?,
                (TouchKind::File, _) => files.push(touch.value.clone()),
                _ => {}
            }
        }
        if !files.is_empty() {
            self.announce_session_overlaps(session, &files).await?;
        }
        Ok(new.len() as u32)
    }

    /// The ids of a session's line: its parents and its subagents.
    pub(crate) async fn family(&self, session_id: &str) -> Result<HashSet<String>> {
        Ok(self
            .db
            .prepare(FAMILY)
            .bind(&[session_id.into()])?
            .all()
            .await?
            .results::<IdRow>()?
            .into_iter()
            .map(|row| row.id)
            .collect())
    }

    /// Tells `session` and each other active session that touched one of
    /// `files` (outside its own line) that they overlap, once per pair.
    async fn announce_session_overlaps(&self, session: &Session, files: &[String]) -> Result<()> {
        let touched: Vec<(String, String)> = self
            .db
            .prepare(TOUCHED_BY_OTHERS)
            .bind(&[session.repo_id.as_str().into(), serde_json::to_string(files)?.into(), session.id.as_str().into()])?
            .all()
            .await?
            .results::<PairRow>()?
            .into_iter()
            .map(|row| (row.session_id, row.value))
            .collect();
        if touched.is_empty() {
            return Ok(());
        }
        let family = self.family(&session.id).await?;
        let at = rfc3339(now_ms());
        for (other_id, files) in session_overlaps(&session.id, &family, &touched) {
            let (low, high) = session_pair(&session.id, &other_id);
            let Some(other) = self.session_row(&session.repo_id, &other_id).await? else {
                continue;
            };
            let other = other.at(now_ms());
            let ours = SessionOverlapDetected {
                repo_id: session.repo_id.clone(),
                number: session.pull.or(session.item),
                session_id: session.id.clone(),
                other_session_id: other.id.clone(),
                other_actor: other.actor.username.clone(),
                files: files.clone(),
                item: session.item,
                other_item: other.item,
            };
            let theirs = SessionOverlapDetected {
                number: other.pull.or(other.item),
                session_id: other.id.clone(),
                other_session_id: session.id.clone(),
                other_actor: session.actor.username.clone(),
                item: other.item,
                other_item: session.item,
                ..ours.clone()
            };
            // The pair is noticed once, and each side told, in one change.
            let mut statements = vec![self
                .db
                .prepare(INSERT_OVERLAP)
                .bind(&[session.repo_id.as_str().into(), low.as_str().into(), high.as_str().into(), serde_json::to_string(&files)?.into(), at.as_str().into()])?];
            let guard = "EXISTS (SELECT 1 FROM session_overlaps WHERE repo_id = ?7 AND low = ?8 AND high = ?9 AND noticed_at = ?10)";
            let mut sent = Vec::new();
            for event in [&ours, &theirs] {
                let delivery = self.delivery(
                    "overlap.detected",
                    &session.repo_id,
                    serde_json::to_value(event)?,
                    &format!("{low}:{high}:{at}:{}", event.session_id),
                    guard,
                    vec![session.repo_id.as_str().into(), low.as_str().into(), high.as_str().into(), at.as_str().into()],
                )?;
                sent.push(push_delivery(&mut statements, delivery));
            }
            let new = match self.db.batch(statements).await?.into_iter().next() {
                Some(result) => !result.results::<serde_json::Value>()?.is_empty(),
                None => false,
            };
            if !new {
                continue;
            }
            let actor = Some(session.actor.id.clone());
            for (event, sent) in [ours, theirs].into_iter().zip(sent) {
                self.delivered(sent, "overlap.detected", &session.repo_id, actor.clone(), serde_json::to_value(event)?).await?;
            }
        }
        Ok(())
    }

    /// A session's subagents, and theirs, in the order they started, each
    /// with how many it started.
    pub(crate) async fn subagents_of(&self, session_id: &str, now: u64) -> Result<Vec<Session>> {
        let rows = self.db.prepare(tree_sql()).bind(&[session_id.into()])?.all().await?.results::<SessionRow>()?;
        let mut children: Vec<Session> = rows.into_iter().map(|row| row.at(now)).collect();
        count_subagents(&mut children);
        Ok(children)
    }

    /// How many subagents each of `sessions` started, filled in.
    pub(crate) async fn fill_subagents(&self, sessions: &mut [Session]) -> Result<()> {
        if sessions.is_empty() {
            return Ok(());
        }
        let ids: Vec<&str> = sessions.iter().map(|session| session.id.as_str()).collect();
        #[derive(Deserialize)]
        struct Count {
            parent_id: String,
            n: u32,
        }
        let counts = self
            .db
            .prepare("SELECT parent_id, COUNT(*) AS n FROM sessions WHERE parent_id IN (SELECT value FROM json_each(?)) GROUP BY parent_id")
            .bind(&[serde_json::to_string(&ids)?.into()])?
            .all()
            .await?
            .results::<Count>()?;
        let counts: HashMap<String, u32> = counts.into_iter().map(|count| (count.parent_id, count.n)).collect();
        for session in sessions {
            session.subagents = counts.get(&session.id).copied().unwrap_or_default();
        }
        Ok(())
    }

    /// Gives each session with no title the start of the first prompt it
    /// recorded, as `first_prompt`, for saying what it is for.
    pub(crate) async fn fill_first_prompts(&self, sessions: &mut [Session]) -> Result<()> {
        let ids: Vec<&str> = sessions.iter().filter(|session| session.title.is_none()).map(|session| session.id.as_str()).collect();
        if ids.is_empty() {
            return Ok(());
        }
        #[derive(Deserialize)]
        struct First {
            session_id: String,
            text: String,
        }
        let found = self
            .db
            .prepare(FIRST_PROMPTS)
            .bind(&[serde_json::to_string(&ids)?.into(), (MAX_FIRST_PROMPT_CHARS as u32).into()])?
            .all()
            .await?
            .results::<First>()?;
        let found: HashMap<String, String> = found.into_iter().map(|first| (first.session_id, first.text)).collect();
        for session in sessions.iter_mut().filter(|session| session.title.is_none()) {
            session.first_prompt = found.get(&session.id).map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
        }
        Ok(())
    }

    /// What a tree of sessions touched, its links, and the skills it used.
    pub(crate) async fn tree_facts(&self, repo_id: &str, ids: &[String]) -> Result<(Vec<SessionTouch>, Vec<SessionLink>, Vec<SessionSkill>)> {
        let ids_json = serde_json::to_string(ids)?;
        // A work item touched is shown by its number.
        let touches = self
            .db
            .prepare(concat!(
                "SELECT session_id, kind,
                   CASE WHEN kind = 'item'
                     THEN COALESCE(CAST(",
                items::sql::item_number!("session_touches.value"),
                " AS TEXT), value)
                     ELSE value END AS value,
                   at FROM session_touches
                 WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY at, rowid LIMIT 1000",
            ))
            .bind(&[ids_json.as_str().into()])?
            .all()
            .await?
            .results::<TouchRow>()?;
        // A pull request opened on a branch after the session pushed it.
        let branches: HashSet<(String, String)> = touches
            .iter()
            .filter(|touch| touch.kind == "branch")
            .map(|touch| (touch.session_id.clone(), touch.value.clone()))
            .collect();
        for (session_id, branch) in branches.iter().take(20) {
            self.link_branch(session_id, repo_id, branch).await?;
        }
        let records: Vec<LinkRecord> = self
            .db
            .prepare(concat!(
                "SELECT session_id, kind,
                   CASE WHEN kind = 'item' THEN ",
                items::sql::item_number!("session_links.item_id"),
                "
                     ELSE number END AS number,
                   via FROM session_links
                 WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY at",
            ))
            .bind(&[ids_json.as_str().into()])?
            .all()
            .await?
            .results::<LinkRow>()?
            .into_iter()
            .filter_map(|row| {
                let kind = match row.kind.as_str() {
                    "item" => LinkKind::Item,
                    "pull" => LinkKind::Pull,
                    _ => return None,
                };
                Some(LinkRecord { session_id: row.session_id, kind, number: row.number?, via: LinkVia::parse(&row.via)? })
            })
            .collect();
        let workspace = items::repo_workspace(self, repo_id).await?.unwrap_or_default();
        let mut known = HashMap::new();
        let mut wanted: Vec<(LinkKind, u32)> = Vec::new();
        for record in &records {
            if !wanted.contains(&(record.kind, record.number)) {
                wanted.push((record.kind, record.number));
            }
        }
        for (kind, number) in wanted.into_iter().take(MAX_LINKED) {
            let found = match kind {
                LinkKind::Item => items::by_number(self, &workspace, number).await?.map(|held| (held.item.title, state_name(&held.item.state))),
                LinkKind::Pull => self.pull(repo_id, number).await?.map(|pull| (pull.title, state_name(&pull.status))),
            };
            if let Some(found) = found {
                known.insert((kind, number), found);
            }
        }
        let links = gather_links(&records, &known);
        let skills = self
            .db
            .prepare(
                "SELECT session_id, text AS name, COUNT(*) AS uses FROM session_entries
                 WHERE session_id IN (SELECT value FROM json_each(?)) AND kind = 'skill'
                 GROUP BY session_id, text ORDER BY MIN(session_seq)",
            )
            .bind(&[ids_json.as_str().into()])?
            .all()
            .await?
            .results::<SkillRow>()?
            .into_iter()
            .map(|row| SessionSkill { session_id: row.session_id, name: row.name, uses: row.uses })
            .collect();
        let touched = touches
            .into_iter()
            .filter_map(|row| {
                Some(SessionTouch { session_id: row.session_id, kind: TouchKind::parse(&row.kind)?, value: row.value, at: row.at })
            })
            .collect();
        Ok((touched, links, skills))
    }

    /// After a push moved `pulls` on `branch` to `after`: the sessions that
    /// pushed that branch, and those its new commits name in
    /// `G1t-Session:` trailers, are tied to them. Never fails the push's
    /// handling: a problem is logged.
    pub(crate) async fn link_push(&self, repo_id: &str, branch: &str, after: &str, commits: Option<u32>, pulls: &[Pull]) {
        if pulls.is_empty() {
            return;
        }
        let linked = async {
            let pushed_by = self
                .db
                .prepare("SELECT DISTINCT session_id AS id FROM session_touches WHERE repo_id = ? AND kind = 'branch' AND value = ?")
                .bind(&[repo_id.into(), branch.into()])?
                .all()
                .await?
                .results::<IdRow>()?;
            for session in &pushed_by {
                for pull in pulls {
                    self.link_pull(&session.id, repo_id, pull.number, LinkVia::Branch).await;
                }
            }
            // Trailers are read only while someone records sessions here.
            let recording = self
                .db
                .prepare("SELECT id FROM sessions WHERE repo_id = ? AND state = 'active' LIMIT 1")
                .bind(&[repo_id.into()])?
                .first::<IdRow>(None)
                .await?;
            if recording.is_none() {
                return Ok::<(), worker::Error>(());
            }
            let Some(pull) = pulls.first() else { return Ok(()) };
            let path: Option<RepoPath> =
                g1t_kit::call(&self.repos, "path_by_id", &g1t_contracts::repos::PathByIdArgs { id: repo_id.to_owned() }).await?;
            let Some(path) = path else { return Ok(()) };
            let log = LogArgs {
                path,
                viewer: self.owner_viewer(pull).await?,
                git_ref: Some(after.to_owned()),
                limit: commits.unwrap_or(MAX_TRAILER_COMMITS).clamp(1, MAX_TRAILER_COMMITS),
            };
            let Outcome::Ok(history) = g1t_kit::call::<_, Outcome<Vec<Commit>>>(&self.repos, "log", &log).await? else {
                return Ok(());
            };
            let mut named: Vec<String> = Vec::new();
            for commit in &history {
                for id in session_trailers(&commit.message) {
                    if !named.contains(&id) {
                        named.push(id);
                    }
                }
            }
            for id in named {
                if self.session_row(repo_id, &id).await?.is_none() {
                    continue;
                }
                for pull in pulls {
                    self.link_pull(&id, repo_id, pull.number, LinkVia::Trailer).await;
                }
            }
            Ok(())
        };
        if let Err(error) = linked.await {
            worker::console_error!("push to {branch}: sessions not tied to its pull requests: {error}");
        }
    }

    /// Sessions tied to a repository's pull request by a link, by id.
    pub(crate) async fn linked_sessions(&self, repo_id: &str, number: u32) -> Result<Vec<String>> {
        Ok(self
            .db
            .prepare("SELECT DISTINCT session_id AS id FROM session_links WHERE repo_id = ? AND kind = 'pull' AND number = ? LIMIT 200")
            .bind(&[repo_id.into(), number.into()])?
            .all()
            .await?
            .results::<IdRow>()?
            .into_iter()
            .map(|row| row.id)
            .collect())
    }

    /// A repository's sessions tied to a work item by a link, by id.
    pub(crate) async fn item_sessions(&self, repo_id: &str, item_id: &str) -> Result<Vec<String>> {
        Ok(self
            .db
            .prepare("SELECT DISTINCT session_id AS id FROM session_links WHERE repo_id = ? AND kind = 'item' AND item_id = ? LIMIT 200")
            .bind(&[repo_id.into(), item_id.into()])?
            .all()
            .await?
            .results::<IdRow>()?
            .into_iter()
            .map(|row| row.id)
            .collect())
    }

    /// Sessions that pushed one of `pulls`' branches, by id: tied to them
    /// even when the pull request was opened after the push.
    pub(crate) async fn branch_sessions(&self, repo_id: &str, pulls: &[u32]) -> Result<Vec<String>> {
        if pulls.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self
            .db
            .prepare(BRANCH_SESSIONS)
            .bind(&[repo_id.into(), serde_json::to_string(pulls)?.into()])?
            .all()
            .await?
            .results::<IdRow>()?
            .into_iter()
            .map(|row| row.id)
            .collect())
    }

    /// Sessions by id, as they read now.
    pub(crate) async fn sessions_by_id(&self, repo_id: &str, ids: &[String]) -> Result<Vec<Session>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let now = now_ms();
        Ok(self
            .db
            .prepare(format!(
                "SELECT {SESSION_COLUMNS} FROM sessions WHERE repo_id = ? AND id IN (SELECT value FROM json_each(?))"
            ))
            .bind(&[repo_id.into(), serde_json::to_string(ids)?.into()])?
            .all()
            .await?
            .results::<SessionRow>()?
            .into_iter()
            .map(|row| row.at(now))
            .collect())
    }
}

/// A work item's state or a pull request's status, as its JSON name.
fn state_name<T: serde::Serialize>(state: &T) -> String {
    serde_json::to_value(state).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}

/// Fills in how many subagents each session of a tree started, from the
/// tree itself.
pub(crate) fn count_subagents(sessions: &mut [Session]) {
    let mut counts: HashMap<String, u32> = HashMap::new();
    for session in sessions.iter() {
        if let Some(parent) = &session.parent_id {
            *counts.entry(parent.clone()).or_default() += 1;
        }
    }
    for session in sessions.iter_mut() {
        session.subagents = counts.get(&session.id).copied().unwrap_or_default();
    }
}
