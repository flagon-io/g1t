//! What g1t adds around a pull request for many agents working at once:
//! which files it changes, which other pull requests are changing the same
//! files, and whether it has fallen behind.

use std::collections::HashSet;

use g1t_contracts::repos::{BehindArgs, Comparison, GetByIdArgs, Repo, RepoPath};
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome};
use serde::Deserialize;
use worker::Result;

use crate::Work;
use crate::rows::{PULL_COLUMNS, PullRow};

/// Beyond this a change is too large for per-file bookkeeping to be useful.
const MAX_FILES: usize = 300;
/// g1t's agent, which wrote reviews and pull requests before g1t stopped
/// hosting agents: shown as `g1t`, which nobody can register or sign in as.
pub(crate) use g1t_contracts::identity::{AGENT_ID, AGENT_NAME};

#[derive(Deserialize)]
struct OtherRow {
    number: u32,
    title: String,
    #[serde(default)]
    item_number: Option<u32>,
    files: Option<String>,
}

impl Work {
    pub(crate) async fn pull_by_id(&self, id: &str) -> Result<Option<Pull>> {
        Ok(self
            .db
            .prepare(format!("SELECT {PULL_COLUMNS} FROM pulls WHERE id = ?"))
            .bind(&[id.into()])?
            .first::<PullRow>(None)
            .await?
            .map(Pull::from))
    }

    /// Works out which files a pull request changes and records them, so
    /// that overlaps between pull requests can be found without comparing
    /// every one of them each time.
    pub(crate) async fn refresh_files(&self, pull: &Pull) -> Result<Vec<ChangedFile>> {
        // Its owner (whoever asked g1t for it, or its author) can read both
        // the repository and the pull request's source.
        let viewer = self.owner_viewer(pull).await?;
        let compared: Outcome<Comparison> =
            g1t_kit::call(&self.repos, "compare", &pull.comparison(&viewer)).await?;
        let files: Vec<ChangedFile> = match compared {
            Outcome::Ok(comparison) => comparison
                .files
                .into_iter()
                .take(MAX_FILES)
                .map(|file| ChangedFile {
                    path: file.path,
                    additions: file.additions,
                    deletions: file.deletions,
                })
                .collect(),
            // Nothing pushed yet, or nothing to compare against.
            Outcome::Fail(_) => Vec::new(),
        };
        self.db
            .prepare("UPDATE pulls SET files = ? WHERE id = ?")
            .bind(&[
                serde_json::to_string(&files)?.into(),
                pull.id.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(files)
    }

    /// Other pull requests in progress that change files this one changes.
    pub(crate) async fn overlaps(&self, pull: &Pull) -> Result<Vec<Overlap>> {
        if pull.files.is_empty() {
            return Ok(Vec::new());
        }
        let mine: HashSet<&str> = pull.files.iter().map(|file| file.path.as_str()).collect();
        let others = match self.prefetched_pull(&pull.id) {
            Some(found) => found.rows::<OtherRow>(crate::prefetch::Slot::Others)?,
            None => self.other_pulls(pull).await?,
        };
        Ok(others
            .into_iter()
            .filter_map(|other| {
                let files: Vec<ChangedFile> =
                    serde_json::from_str(other.files.as_deref().unwrap_or("[]")).ok()?;
                let paths: Vec<String> = files
                    .into_iter()
                    .map(|file| file.path)
                    .filter(|path| mine.contains(path.as_str()))
                    .collect();
                (!paths.is_empty()).then_some(Overlap {
                    number: other.number,
                    title: other.title,
                    item: other.item_number,
                    paths,
                })
            })
            .collect())
    }

    /// The other pull requests in progress in its repository.
    async fn other_pulls(&self, pull: &Pull) -> Result<Vec<OtherRow>> {
        self
            .db
            .prepare(concat!(
                "SELECT number, title, ",
                crate::items::sql::item_number!("pulls.item_id"),
                " AS item_number,
                   files FROM pulls
                 WHERE repo_id = ? AND id != ? AND status IN ('draft', 'open')
                 ORDER BY number LIMIT 200",
            ))
            .bind(&[pull.repo_id.as_str().into(), pull.id.as_str().into()])?
            .all()
            .await?
            .results::<OtherRow>()
    }

    /// Whether the branch a pull request would merge into has commits the
    /// pull request does not, so that it must catch up before it can merge.
    pub(crate) async fn is_behind(&self, pull: &Pull) -> Result<bool> {
        if !pull.status.is_active() || pull.head_commit.is_none() {
            return Ok(false);
        }
        let asked = BehindArgs {
            source_id: pull.source_id().to_owned(),
            branch: pull.branch.clone(),
            target_branch: pull.base.clone().filter(|base| !base.is_empty()),
            target_id: pull.target_id(),
        };
        self.timing.rpc(g1t_kit::call(&self.repos, "behind", &asked)).await
    }

    /// Whether a pull request is behind, as stored with its mergeability
    /// when that was worked out for its head as it is now (the last push
    /// to either side); otherwise asked of the repos service.
    pub(crate) async fn behind_now(&self, pull: &Pull) -> Result<bool> {
        if !pull.status.is_active() || pull.head_commit.is_none() {
            return Ok(false);
        }
        let stored = self
            .timing
            .db(
                1,
                self.db
                    .prepare("SELECT behind, mergeable_key FROM pulls WHERE id = ?")
                    .bind(&[pull.id.as_str().into()])?
                    .first::<crate::StoredBehind>(None),
            )
            .await?;
        match stored.and_then(|stored| stored.for_head(pull.head_commit.as_deref())) {
            Some(behind) => Ok(behind),
            None => self.is_behind(pull).await,
        }
    }

    /// Where a pull request lives, for a tool that knows only its id (its
    /// fork is named after it).
    pub(crate) async fn locate_pull(&self, a: LocatePullArgs) -> Result<Outcome<LocatedPull>> {
        let missing = || Outcome::fail(FailureCode::NotFound, "Pull request not found.");
        let Some(pull) = self.pull_by_id(&a.id).await? else {
            return Ok(missing());
        };
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: pull.repo_id.clone(),
                viewer: a.viewer,
            },
        )
        .await?;
        let Outcome::Ok(repo) = repo else {
            return Ok(missing());
        };
        Ok(Outcome::Ok(LocatedPull {
            repo: RepoPath {
                namespace: repo.namespace,
                name: repo.name,
            },
            number: pull.number,
            title: pull.title,
            status: pull.status,
        }))
    }
}
