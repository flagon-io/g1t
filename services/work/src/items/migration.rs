//! Moving repositories' issues into their workspaces as work items: the
//! part of migrations/0049_work_items.sql that needs to know which
//! workspace each repository is in, which only repos does.
//!
//! The job pages through repos' repositories (`repo_creators`, then
//! `visibility`), recording each in `repo_workspaces`, a few pages a run,
//! resuming where it stopped (`work_jobs.cursor`). Once every page is in,
//! one batch ([`finish_sql`]) gives every moved issue its workspace and a
//! number above every number its workspace's repositories used, in the
//! order the issues were opened; starts each workspace's sequence after
//! them; merges the repositories' labels into the workspace's by name
//! (the first made keeps its color and description); renumbers their
//! milestones in the workspace and moves what was in each; and empties the
//! per-repository counters. Then it announces where each issue went as
//! `work.migrated`, a page at a time, for the services that kept issue
//! numbers. It runs from the cron trigger and from `migrate_work_items`,
//! and does nothing once done.
//!
//! After it, `repo_workspaces` is kept by events: repo.created,
//! repo.renamed and repo.transferred ([`TRANSFERRED`]),
//! repo.visibility_changed, and workspace.renamed and workspace.deleted
//! ([`RENAMED`], [`DELETED`]).

use g1t_contracts::events::WorkMigrated;
use g1t_contracts::repos::{AllIdsArgs, CreatorPage, DeletedRepoPage, RepoVisibility, VisibilityArgs};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::optional;
use crate::rows::NumberRow;

/// Repositories asked for at a time, and pages read in one run.
const PAGE: u32 = 100;
const PAGES_PER_RUN: u32 = 10;
/// Moved issues announced in one `work.migrated` event: well under a
/// queue message's size limit.
const ANNOUNCED_PER_EVENT: u32 = 250;

/// Records a repository (`?1`) as in workspace `?2` at path `?3`,
/// private (`?4`) or not, and names its links by that path.
pub(crate) const RECORD_REPO: [&str; 2] =
    [super::links::REMEMBER_REPO, "UPDATE work_item_repos SET path = ?3 WHERE repo_id = ?1 AND path IS NOT ?3"];

/// The workspace an issue whose repository repos no longer knows was in,
/// from what else this database kept about that repository (`o.repo_id`).
const FALLBACK_WORKSPACE: &str = "COALESCE(
       (SELECT a.workspace FROM agent_runs a WHERE a.repo_id = o.repo_id ORDER BY a.created_at DESC LIMIT 1),
       (SELECT e.workspace FROM rule_evaluations e WHERE e.repo_id = o.repo_id ORDER BY e.id DESC LIMIT 1),
       (SELECT s.workspace FROM rulesets s WHERE s.repo_id = o.repo_id LIMIT 1))";

/// What finishing does, in one batch, `?1` the time (see the module's
/// notes): [`place_sql`], each workspace's floor, and the job done.
pub(crate) fn finish_sql() -> Vec<String> {
    let mut statements = place_sql();
    statements.push("UPDATE work_jobs SET done_at = ?1, cursor = NULL WHERE name = 'work_items' AND done_at IS NULL".to_owned());
    statements
}

/// Placing what the repositories recorded in `repo_workspaces` kept for
/// themselves, in one batch, `?1` the time: their moved issues' workspaces
/// and numbers, labels, milestones and numbers become their workspaces'.
/// Only what is still theirs is moved, and then dropped, so run again it
/// changes nothing; a repository recorded later (one deleted while the job
/// ran, then restored, or the job for those, [`DELETED_REPOS_JOB`]) has
/// its own moved then, and nothing of anyone else's twice.
pub(crate) fn place_sql() -> Vec<String> {
    let recorded = "SELECT repo_id FROM repo_workspaces";
    // A repository's milestones are still its own: not moved yet.
    let unmoved = "SELECT repo_id FROM repo_milestones WHERE repo_id IN (SELECT repo_id FROM repo_workspaces)";
    vec![
        // Each moved issue's workspace: its repository's.
        format!(
            "UPDATE work_items SET workspace = (
               SELECT lower(COALESCE(rw.workspace, {FALLBACK_WORKSPACE}))
               FROM work_item_repos o LEFT JOIN repo_workspaces rw ON rw.repo_id = o.repo_id
               WHERE o.item_id = work_items.id AND o.role = 'origin')
             WHERE workspace IS NULL AND number IS NULL"
        ),
        // Numbered above every number its workspace used, oldest first.
        "UPDATE work_items SET number = n.number
         FROM (
           SELECT i.id AS id, f.floor + ROW_NUMBER() OVER (PARTITION BY i.workspace ORDER BY i.created_at, i.id) AS number
           FROM work_items i JOIN (
             SELECT w.workspace AS workspace, MAX(
               COALESCE((SELECT MAX(c.last) FROM counters c JOIN repo_workspaces rw ON rw.repo_id = c.repo_id
                         WHERE rw.workspace = w.workspace), 0),
               COALESCE((SELECT wc.last FROM work_counters wc WHERE wc.workspace = w.workspace), 0),
               COALESCE((SELECT MAX(x.number) FROM work_items x WHERE x.workspace = w.workspace), 0),
               COALESCE((SELECT MAX(p.number) FROM pulls p JOIN repo_workspaces rw ON rw.repo_id = p.repo_id
                         WHERE rw.workspace = w.workspace), 0)) AS floor
             FROM (SELECT DISTINCT workspace FROM work_items WHERE number IS NULL AND workspace IS NOT NULL) w
           ) f ON f.workspace = i.workspace
           WHERE i.number IS NULL AND i.workspace IS NOT NULL
         ) n
         WHERE work_items.id = n.id"
            .to_owned(),
        // Each workspace's sequence goes on after everything it used.
        "INSERT INTO work_counters (workspace, last)
         SELECT rw.workspace, MAX(c.last) FROM counters c JOIN repo_workspaces rw ON rw.repo_id = c.repo_id
         GROUP BY rw.workspace
         ON CONFLICT (workspace) DO UPDATE SET last = MAX(work_counters.last, excluded.last)"
            .to_owned(),
        "INSERT INTO work_counters (workspace, last)
         SELECT workspace, MAX(number) FROM work_items WHERE workspace IS NOT NULL AND number IS NOT NULL
         GROUP BY workspace
         ON CONFLICT (workspace) DO UPDATE SET last = MAX(work_counters.last, excluded.last)"
            .to_owned(),
        // Labels merge by name, whatever its case (names are lowercase as
        // work items carry them); the first made keeps its color and words.
        "INSERT INTO labels (workspace, name, color, description, created_at)
         SELECT rw.workspace, lower(l.name), l.color, l.description, l.created_at
         FROM repo_labels l JOIN repo_workspaces rw ON rw.repo_id = l.repo_id
         WHERE true ORDER BY l.created_at, l.repo_id
         ON CONFLICT (workspace, name) DO UPDATE
           SET color = excluded.color, description = excluded.description, created_at = excluded.created_at
           WHERE excluded.created_at < labels.created_at"
            .to_owned(),
        // Milestones are numbered on after the workspace's own, oldest
        // first, and what was in each moves with it.
        "INSERT INTO milestone_moves (repo_id, old_number, workspace, number)
         SELECT m.repo_id, m.number, rw.workspace,
           COALESCE((SELECT MAX(x.number) FROM milestones x WHERE x.workspace = rw.workspace), 0)
             + ROW_NUMBER() OVER (PARTITION BY rw.workspace ORDER BY m.created_at, m.repo_id, m.number)
         FROM repo_milestones m JOIN repo_workspaces rw ON rw.repo_id = m.repo_id
         WHERE NOT EXISTS (SELECT 1 FROM milestone_moves mm WHERE mm.repo_id = m.repo_id AND mm.old_number = m.number)"
            .to_owned(),
        "INSERT INTO milestones (workspace, number, origin_repo_id, title, description, due_on, state, created_at, updated_at, closed_at)
         SELECT mm.workspace, mm.number, m.repo_id, m.title, m.description, m.due_on, m.state, m.created_at, m.updated_at, m.closed_at
         FROM milestone_moves mm JOIN repo_milestones m ON m.repo_id = mm.repo_id AND m.number = mm.old_number
         WHERE true
         ON CONFLICT DO NOTHING"
            .to_owned(),
        // Only what was in a milestone of a repository moving now: a
        // repository with none keeps what its work items say.
        format!(
            "UPDATE work_items SET milestone = (
               SELECT mm.number FROM milestone_moves mm JOIN work_item_repos o ON o.repo_id = mm.repo_id
               WHERE o.item_id = work_items.id AND o.role = 'origin' AND mm.old_number = work_items.milestone)
             WHERE milestone IS NOT NULL
               AND id IN (SELECT item_id FROM work_item_repos WHERE legacy_number IS NOT NULL AND role = 'origin'
                          AND repo_id IN ({unmoved}))"
        ),
        format!(
            "UPDATE pulls SET milestone = (
               SELECT mm.number FROM milestone_moves mm WHERE mm.repo_id = pulls.repo_id AND mm.old_number = pulls.milestone)
             WHERE milestone IS NOT NULL AND repo_id IN ({unmoved})"
        ),
        // Every number they used is below the workspace's floor, and its
        // sequence goes on above it.
        "UPDATE work_counters SET floor = MAX(floor,
           COALESCE((SELECT MAX(c.last) FROM counters c JOIN repo_workspaces rw ON rw.repo_id = c.repo_id
                     WHERE rw.workspace = work_counters.workspace), 0))
         WHERE true"
            .to_owned(),
        RAISE_FLOORS.to_owned(),
        "UPDATE work_counters SET last = floor WHERE last < floor".to_owned(),
        // What the repositories kept for themselves is the workspace's now.
        format!("DELETE FROM counters WHERE repo_id IN ({recorded})"),
        format!("DELETE FROM repo_labels WHERE repo_id IN ({recorded})"),
        format!("DELETE FROM repo_milestones WHERE repo_id IN ({recorded})"),
    ]
}

/// The job, after the first, that records repositories deleted but still
/// restorable ([`Work::migrate_deleted_repos`]): the first job's paging
/// left them out, and their work items with no path, private, and their
/// labels and old numbers unmerged.
pub(crate) const DELETED_REPOS_JOB: &str = "deleted_repos";

/// The job after that ([`Work::mark_deleted_repos`]): marks each
/// repository deleted but not purged as deleted in `repo_workspaces`
/// ([`super::links::MARK_DELETED`]), for those deleted before that was
/// kept. Run again, it changes nothing.
pub(crate) const DELETED_MARKS_JOB: &str = "deleted_marks";

/// Every label a workspace's work items or pull requests carry that the
/// workspace does not have, as a label (gray, no description) made at
/// `?1`: one a repository had that was never merged. Run again, it adds
/// nothing.
pub(crate) const CARRIED_LABELS: [&str; 2] = [
    "INSERT INTO labels (workspace, name, color, description, created_at)
     SELECT DISTINCT i.workspace, j.value, 'ededed', '', ?1 FROM work_items i, json_each(i.labels) j
     WHERE i.workspace IS NOT NULL AND j.value <> ''
     ON CONFLICT DO NOTHING",
    "INSERT INTO labels (workspace, name, color, description, created_at)
     SELECT DISTINCT rw.workspace, j.value, 'ededed', '', ?1 FROM pulls p JOIN repo_workspaces rw ON rw.repo_id = p.repo_id, json_each(p.labels) j
     WHERE j.value <> ''
     ON CONFLICT DO NOTHING",
];

/// A workspace renamed (`g1t_kit::rename`, `?1` its slug now, `?2` before):
/// its work items, labels, milestones, numbers and repositories follow.
pub(crate) const RENAMED: &[&str] = &[
    "UPDATE OR IGNORE work_items SET workspace = ?1 WHERE workspace = ?2",
    "INSERT INTO labels (workspace, name, color, description, created_at)
     SELECT ?1, name, color, description, created_at FROM labels WHERE workspace = ?2
     ON CONFLICT DO NOTHING",
    "DELETE FROM labels WHERE workspace = ?2",
    "UPDATE OR IGNORE milestones SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE milestone_moves SET workspace = ?1 WHERE workspace = ?2",
    "INSERT INTO work_counters (workspace, last) SELECT ?1, last FROM work_counters WHERE workspace = ?2
     ON CONFLICT (workspace) DO UPDATE SET last = MAX(work_counters.last, excluded.last)",
    "DELETE FROM work_counters WHERE workspace = ?2",
    "UPDATE repo_workspaces SET workspace = ?1, path = ?1 || substr(path, length(?2) + 1)
     WHERE workspace = ?2 AND substr(path, 1, length(?2) + 1) = ?2 || '/'",
    "UPDATE work_item_repos SET path = ?1 || substr(path, length(?2) + 1) WHERE substr(path, 1, length(?2) + 1) = ?2 || '/'",
];

/// A repository renamed or transferred (`g1t_kit::transfer`: `?1` its path
/// now, `?3` its workspace now, `?5` its id): where it is now, and in the
/// workspace it moved to, numbers go on after its pull requests' and its
/// old issues', so a new one never takes a number it has. Those numbers
/// were never that workspace's, so its floor rises above them too: `#N`
/// read in the workspace's other repositories names none of them
/// (refs.rs). A rename (`?4`, its workspace before, the same) changes no
/// numbers. Its work items stay in their own workspace, linked to it.
pub(crate) const TRANSFERRED: &[&str] = &[
    "INSERT INTO repo_workspaces (repo_id, workspace, path, private) VALUES (?5, lower(?3), ?1, 1)
     ON CONFLICT (repo_id) DO UPDATE SET workspace = lower(?3), path = ?1",
    "UPDATE work_item_repos SET path = ?1 WHERE repo_id = ?5",
    "INSERT INTO work_counters (workspace, last, floor)
     SELECT lower(?3), MAX(n), MAX(n) FROM (
       SELECT MAX(number) AS n FROM pulls WHERE repo_id = ?5
       UNION ALL SELECT MAX(legacy_number) FROM work_item_repos WHERE repo_id = ?5)
     WHERE lower(?3) <> lower(?4)
     HAVING MAX(n) IS NOT NULL
     ON CONFLICT (workspace) DO UPDATE SET last = MAX(work_counters.last, excluded.last), floor = MAX(work_counters.floor, excluded.floor)",
];

/// Raises each workspace's floor (`work_counters.floor`) to the highest
/// number any of its repositories used on its own: a pull request opened
/// before work items moved (by when the job finished, or `?1`, now, while
/// it finishes) or an old issue's number. Run again, it changes nothing.
/// migrations/0052_work_floors.sql does the same.
pub(crate) const RAISE_FLOORS: &str = "UPDATE work_counters SET floor = MAX(floor,
       COALESCE((SELECT MAX(p.number) FROM pulls p JOIN repo_workspaces rw ON rw.repo_id = p.repo_id
                 WHERE rw.workspace = work_counters.workspace
                   AND p.created_at <= COALESCE((SELECT done_at FROM work_jobs WHERE name = 'work_items'), ?1)), 0),
       COALESCE((SELECT MAX(l.legacy_number) FROM work_item_repos l JOIN repo_workspaces rw ON rw.repo_id = l.repo_id
                 WHERE rw.workspace = work_counters.workspace), 0))
     WHERE true";

/// A workspace deleted (`g1t_kit::deleted`, `?1` its slug): its work
/// items go, with everything kept for them, and its labels, milestones
/// and numbers.
pub(crate) const DELETED: &[&str] = &[
    "UPDATE pulls SET item_id = NULL WHERE item_id IN (SELECT id FROM work_items WHERE workspace = ?1)",
    "DELETE FROM comments WHERE item_id IN (SELECT id FROM work_items WHERE workspace = ?1)",
    "DELETE FROM reactions WHERE item_id IN (SELECT id FROM work_items WHERE workspace = ?1)",
    "DELETE FROM claims WHERE item_id IN (SELECT id FROM work_items WHERE workspace = ?1)",
    "DELETE FROM decisions WHERE item_id IN (SELECT id FROM work_items WHERE workspace = ?1)",
    "UPDATE sessions SET item_id = NULL WHERE item_id IN (SELECT id FROM work_items WHERE workspace = ?1)",
    "DELETE FROM session_links WHERE item_id IN (SELECT id FROM work_items WHERE workspace = ?1)",
    "DELETE FROM work_item_repos WHERE item_id IN (SELECT id FROM work_items WHERE workspace = ?1)",
    "DELETE FROM work_items WHERE workspace = ?1",
    "DELETE FROM labels WHERE workspace = ?1",
    "DELETE FROM milestones WHERE workspace = ?1",
    "DELETE FROM work_counters WHERE workspace = ?1",
    "DELETE FROM repo_workspaces WHERE workspace = ?1",
];

/// The default labels for workspace `?1` (name `?2`, color `?3`,
/// description `?4`, at `?5`), unless it has labels already.
const SEED_LABEL: &str = "INSERT OR IGNORE INTO labels (workspace, name, color, description, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM labels WHERE workspace = ?1 AND created_at < ?5)";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Created {
    repo_id: String,
    namespace: String,
    name: String,
    #[serde(default = "private")]
    is_private: bool,
}

fn private() -> bool {
    true
}

#[derive(Deserialize)]
struct JobRow {
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    done_at: Option<String>,
}

impl Work {
    /// `migrate_work_items`, and the cron trigger: see the module's notes.
    pub(crate) async fn migrate_work_items(&self) -> Result<WorkMigration> {
        let job = self.db.prepare("SELECT cursor, done_at FROM work_jobs WHERE name = 'work_items'").first::<JobRow>(None).await?;
        let Some(job) = job else {
            return Ok(WorkMigration { done: true, ..WorkMigration::default() });
        };
        if job.done_at.is_some() {
            let deleted = self.migrate_deleted_repos().await?;
            if !deleted.done {
                return Ok(deleted);
            }
            return self.mark_deleted_repos().await;
        }
        let mut cursor = job.cursor;
        let mut recorded = 0;
        for _ in 0..PAGES_PER_RUN {
            let page: CreatorPage = g1t_kit::call(&self.repos, "repo_creators", &AllIdsArgs { after: cursor.clone(), limit: PAGE }).await?;
            recorded += self.record_page(&page).await?;
            match page.next {
                Some(next) => {
                    self.db
                        .prepare("UPDATE work_jobs SET cursor = ? WHERE name = 'work_items'")
                        .bind(&[next.as_str().into()])?
                        .run()
                        .await?;
                    cursor = Some(next);
                }
                None => return self.finish(recorded).await,
            }
        }
        Ok(WorkMigration { done: false, repos: recorded, ..WorkMigration::default() })
    }

    /// The job after the first ([`DELETED_REPOS_JOB`]): records each
    /// repository deleted but not purged, a few pages a run, then places
    /// what it kept ([`place_sql`]) and gives its work items' labels to
    /// the workspace ([`CARRIED_LABELS`]). Done once; run again, it
    /// changes nothing.
    async fn migrate_deleted_repos(&self) -> Result<WorkMigration> {
        let job = self
            .db
            .prepare("SELECT cursor, done_at FROM work_jobs WHERE name = ?")
            .bind(&[DELETED_REPOS_JOB.into()])?
            .first::<JobRow>(None)
            .await?;
        let Some(job) = job.filter(|job| job.done_at.is_none()) else {
            return Ok(WorkMigration { done: true, ..WorkMigration::default() });
        };
        let mut cursor = job.cursor;
        let mut recorded = 0;
        for _ in 0..PAGES_PER_RUN {
            let page: DeletedRepoPage =
                g1t_kit::call(&self.repos, "deleted_repos", &AllIdsArgs { after: cursor.clone(), limit: PAGE }).await?;
            let repos: Vec<(String, String, String, bool)> =
                page.repos.iter().map(|repo| (repo.id.clone(), repo.namespace.clone(), repo.name.clone(), repo.is_private)).collect();
            recorded += self.record_repos(&repos).await?;
            // Recording one says it is there; these are deleted.
            self.mark_deleted(&page).await?;
            match page.next {
                Some(next) => {
                    self.db
                        .prepare("UPDATE work_jobs SET cursor = ? WHERE name = ?")
                        .bind(&[next.as_str().into(), DELETED_REPOS_JOB.into()])?
                        .run()
                        .await?;
                    cursor = Some(next);
                }
                None => {
                    self.place(true).await?;
                    self.db
                        .prepare("UPDATE work_jobs SET done_at = ?, cursor = NULL WHERE name = ? AND done_at IS NULL")
                        .bind(&[rfc3339(now_ms()).into(), DELETED_REPOS_JOB.into()])?
                        .run()
                        .await?;
                    return Ok(WorkMigration { done: true, repos: recorded, ..WorkMigration::default() });
                }
            }
        }
        Ok(WorkMigration { done: false, repos: recorded, ..WorkMigration::default() })
    }

    /// The job after [`Self::migrate_deleted_repos`] ([`DELETED_MARKS_JOB`]):
    /// marks each repository deleted but not purged as deleted, a few
    /// pages a run. Done once; run again, it changes nothing.
    async fn mark_deleted_repos(&self) -> Result<WorkMigration> {
        let job = self
            .db
            .prepare("SELECT cursor, done_at FROM work_jobs WHERE name = ?")
            .bind(&[DELETED_MARKS_JOB.into()])?
            .first::<JobRow>(None)
            .await?;
        let Some(job) = job.filter(|job| job.done_at.is_none()) else {
            return Ok(WorkMigration { done: true, ..WorkMigration::default() });
        };
        let mut cursor = job.cursor;
        let mut marked = 0;
        for _ in 0..PAGES_PER_RUN {
            let page: DeletedRepoPage =
                g1t_kit::call(&self.repos, "deleted_repos", &AllIdsArgs { after: cursor.clone(), limit: PAGE }).await?;
            marked += self.mark_deleted(&page).await?;
            let done = page.next.is_none();
            self.db
                .prepare("UPDATE work_jobs SET cursor = ?, done_at = ? WHERE name = ? AND done_at IS NULL")
                .bind(&[optional(&page.next), if done { rfc3339(now_ms()).into() } else { JsValue::NULL }, DELETED_MARKS_JOB.into()])?
                .run()
                .await?;
            if done {
                return Ok(WorkMigration { done: true, repos: marked, ..WorkMigration::default() });
            }
            cursor = page.next;
        }
        Ok(WorkMigration { done: false, repos: marked, ..WorkMigration::default() })
    }

    /// Marks a page of deleted repositories as deleted where they are recorded.
    async fn mark_deleted(&self, page: &DeletedRepoPage) -> Result<u32> {
        if page.repos.is_empty() {
            return Ok(0);
        }
        let now = rfc3339(now_ms());
        let statements = page
            .repos
            .iter()
            .map(|repo| self.db.prepare(super::links::MARK_DELETED).bind(&[repo.id.as_str().into(), now.as_str().into()]))
            .collect::<Result<Vec<_>>>()?;
        self.db.batch(statements).await?;
        Ok(page.repos.len() as u32)
    }

    /// Records repositories (id, workspace, name, private) where they are.
    async fn record_repos(&self, repos: &[(String, String, String, bool)]) -> Result<u32> {
        if repos.is_empty() {
            return Ok(0);
        }
        let mut statements = Vec::new();
        for (id, namespace, name, private) in repos {
            let path = format!("{namespace}/{name}");
            let binds = [id.as_str().into(), namespace.to_lowercase().into(), path.as_str().into(), u32::from(*private).into()];
            for sql in RECORD_REPO {
                statements.push(self.db.prepare(sql).bind(&binds[..g1t_kit::rename::parameters(sql)])?);
            }
        }
        self.db.batch(statements).await?;
        Ok(repos.len() as u32)
    }

    /// [`place_sql`], and with `carried`, [`CARRIED_LABELS`], in one batch.
    async fn place(&self, carried: bool) -> Result<()> {
        let now = rfc3339(now_ms());
        let mut sql = place_sql();
        if carried {
            sql.extend(CARRIED_LABELS.iter().map(|sql| (*sql).to_owned()));
        }
        let statements = sql
            .iter()
            .map(|sql| {
                let binds = [now.as_str().into()];
                self.db.prepare(sql).bind(&binds[..g1t_kit::rename::parameters(sql)])
            })
            .collect::<Result<Vec<_>>>()?;
        self.db.batch(statements).await?;
        Ok(())
    }

    /// `repo.restored`: where the repository is again, and, once work items
    /// have moved, whatever of its own is still to place (a repository
    /// deleted while the job ran).
    pub(super) async fn repo_restored(&self, data: &serde_json::Value) -> Result<()> {
        let Ok(restored) = serde_json::from_value::<Created>(data.clone()) else {
            return Ok(());
        };
        self.record_repos(&[(restored.repo_id, restored.namespace, restored.name, restored.is_private)]).await?;
        if self.items_moved().await? {
            self.place(false).await?;
        }
        Ok(())
    }

    /// Records one page of repositories: where each is, and whether it is
    /// private.
    async fn record_page(&self, page: &CreatorPage) -> Result<u32> {
        if page.repos.is_empty() {
            return Ok(0);
        }
        let paths: Vec<String> = page.repos.iter().map(|repo| format!("{}/{}", repo.namespace, repo.name)).collect();
        let seen: Vec<RepoVisibility> = g1t_kit::call(&self.repos, "visibility", &VisibilityArgs { paths: paths.clone() }).await?;
        let mut statements = Vec::new();
        for (repo, path) in page.repos.iter().zip(&paths) {
            let private = seen.iter().find(|known| known.path.eq_ignore_ascii_case(path)).is_none_or(|known| known.is_private);
            let binds = [repo.id.as_str().into(), repo.namespace.to_lowercase().into(), path.as_str().into(), u32::from(private).into()];
            for sql in RECORD_REPO {
                statements.push(self.db.prepare(sql).bind(&binds[..g1t_kit::rename::parameters(sql)])?);
            }
        }
        self.db.batch(statements).await?;
        Ok(page.repos.len() as u32)
    }

    /// Numbers every moved issue in its workspace and moves labels and
    /// milestones, in one batch, then announces where each issue went.
    async fn finish(&self, recorded: u32) -> Result<WorkMigration> {
        let now = rfc3339(now_ms());
        let before = self.unnumbered().await?;
        let statements = finish_sql()
            .iter()
            .map(|sql| {
                let binds = [now.as_str().into()];
                self.db.prepare(sql).bind(&binds[..g1t_kit::rename::parameters(sql)])
            })
            .collect::<Result<Vec<_>>>()?;
        self.db.batch(statements).await?;
        let unplaced = self.unnumbered().await?;
        if unplaced > 0 {
            worker::console_warn!("{unplaced} issues were not moved: their repositories are gone, and nothing says where they were");
        }
        self.announce_moves().await?;
        Ok(WorkMigration { done: true, repos: recorded, numbered: before.saturating_sub(unplaced), unplaced })
    }

    async fn unnumbered(&self) -> Result<u32> {
        Ok(self
            .db
            .prepare("SELECT count(*) AS n FROM work_items WHERE number IS NULL")
            .first::<NumberRow>(None)
            .await?
            .map_or(0, |row| row.n))
    }

    /// `work.migrated`, a page at a time.
    async fn announce_moves(&self) -> Result<()> {
        let mut after = None;
        let mut page = 0;
        loop {
            let found = self.legacy_item_map(LegacyItemMapArgs { after: after.clone(), limit: ANNOUNCED_PER_EVENT }).await?;
            page += 1;
            let done = found.next.is_none();
            let data = serde_json::to_value(WorkMigrated { page, items: found.items, done })?;
            self.publish_on("work.migrated", None, None, data).await?;
            match found.next {
                Some(next) => after = Some(next),
                None => return Ok(()),
            }
        }
    }

    /// `repo.created`: where the repository is, and for a workspace's
    /// first, the default labels.
    pub(super) async fn repo_created(&self, data: &serde_json::Value) -> Result<()> {
        let Ok(created) = serde_json::from_value::<Created>(data.clone()) else {
            return Ok(());
        };
        let workspace = created.namespace.to_lowercase();
        let path = format!("{}/{}", created.namespace, created.name);
        let binds =
            [created.repo_id.as_str().into(), workspace.as_str().into(), path.as_str().into(), u32::from(created.is_private).into()];
        let mut statements = RECORD_REPO
            .iter()
            .map(|sql| self.db.prepare(*sql).bind(&binds[..g1t_kit::rename::parameters(sql)]))
            .collect::<Result<Vec<_>>>()?;
        let now = rfc3339(now_ms());
        for (name, color, description) in DEFAULT_LABELS {
            statements.push(self.db.prepare(SEED_LABEL).bind(&[
                workspace.as_str().into(),
                name.into(),
                color.into(),
                description.into(),
                now.as_str().into(),
            ])?);
        }
        self.db.batch(statements).await?;
        Ok(())
    }

    /// `repo.visibility_changed`: whether its work items are public.
    pub(super) async fn repo_visibility(&self, data: &serde_json::Value) -> Result<()> {
        let (Some(repo_id), Some(private)) = (data["repoId"].as_str(), data["isPrivate"].as_bool()) else {
            return Ok(());
        };
        self.db
            .prepare("UPDATE repo_workspaces SET private = ? WHERE repo_id = ?")
            .bind(&[u32::from(private).into(), repo_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// `legacy_item_map`: a page of where repositories' old issues went.
    pub(crate) async fn legacy_item_map(&self, a: LegacyItemMapArgs) -> Result<LegacyItemPage> {
        let limit = a.limit.clamp(1, 500);
        let items = self
            .db
            .prepare(
                "SELECT r.repo_id, r.legacy_number, i.workspace, i.number, i.id AS item_id
                 FROM work_item_repos r JOIN work_items i ON i.id = r.item_id
                 WHERE r.legacy_number IS NOT NULL AND i.number IS NOT NULL AND (?1 IS NULL OR i.id > ?1)
                 ORDER BY i.id LIMIT ?2",
            )
            .bind(&[optional(&a.after), limit.into()])?
            .all()
            .await?
            .results::<MigratedItem>()?;
        let next = (items.len() as u32 == limit).then(|| items.last().map(|item| item.item_id.clone())).flatten();
        Ok(LegacyItemPage { items, next, moved: self.items_moved().await? })
    }
}
