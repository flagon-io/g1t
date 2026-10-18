//! A workspace's sequence of numbers (`work_counters`), which its work
//! items and its repositories' new pull requests share.

use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::rows::{NumberRow, ValueRow};

/// The next number of workspace `?1`'s sequence, taken in one statement so
/// two openings never get the same one. A pull request of repository `?2`
/// never takes a number one of that repository's has, a pull request's or
/// an old issue's (a repository moved in from another workspace, or
/// restored, brings its own), and a workspace's first number comes after
/// every number its repositories used before work items moved to the
/// workspace. While the job that moves them runs, which repositories are
/// the workspace's is not known yet: a number then comes after every
/// number any repository used, so it is above the floor the job finds.
pub(crate) const NEXT_NUMBER: &str = "INSERT INTO work_counters (workspace, last)
     SELECT ?1, MAX(COALESCE(MAX(c.last), 0), COALESCE((SELECT MAX(number) FROM pulls WHERE repo_id = ?2), 0),
                    COALESCE((SELECT MAX(legacy_number) FROM work_item_repos WHERE repo_id = ?2), 0)) + 1
     FROM counters c
     WHERE c.repo_id = ?2 OR c.repo_id IN (SELECT repo_id FROM repo_workspaces WHERE workspace = ?1)
        OR EXISTS (SELECT 1 FROM work_jobs WHERE name = 'work_items' AND done_at IS NULL)
     ON CONFLICT (workspace) DO UPDATE SET last = MAX(work_counters.last + 1, excluded.last)
     RETURNING last AS n";

impl Work {
    /// The next number of `workspace`'s sequence, for a work item, or for
    /// a pull request of `repo_id` ([`NEXT_NUMBER`]).
    pub(super) async fn next_number(&self, workspace: &str, repo_id: Option<&str>) -> Result<u32> {
        let row = self
            .db
            .prepare(NEXT_NUMBER)
            .bind(&[workspace.to_lowercase().into(), repo_id.map_or(JsValue::NULL, JsValue::from)])?
            .first::<NumberRow>(None)
            .await?;
        row.map(|row| row.n).ok_or_else(|| worker::Error::RustError("no number was assigned".into()))
    }

    /// Whether the job that moved issues into work items is done.
    pub(super) async fn items_moved(&self) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT done_at AS value FROM work_jobs WHERE name = 'work_items' AND done_at IS NOT NULL")
            .first::<ValueRow>(None)
            .await?
            .is_some())
    }
}
