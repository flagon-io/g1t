//! Reading workflow files: at any commit for a run, and from the default
//! branch into the `workflows` table, which lists them, holds their
//! schedules and remembers which are turned off.

use g1t_actions::workflow::{self, FOLDER};
use g1t_contracts::new_id;
use g1t_contracts::repos::{BlobArgs, BlobView, EntryKind, Repo, RepoPath, TreeArgs, TreeView};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{Outcome, User};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::{Actions, Count, MAX_WORKFLOWS, optional};

/// One workflow file as read at a commit.
pub struct WorkflowFile {
    pub path: String,
    pub source: String,
}

/// The files at a commit, and the commit the ref resolved to.
pub struct Read {
    pub files: Vec<WorkflowFile>,
    pub head: Option<String>,
}

#[derive(Deserialize)]
pub struct WorkflowRow {
    pub id: String,
    pub repo_id: String,
    pub repo: String,
    pub path: String,
    pub name: String,
    pub source: String,
    pub events: String,
    pub crons: String,
    pub error: Option<String>,
    pub state: String,
    pub updated_at: String,
}

impl Actions {
    /// The workflow files of `path` as of `git_ref` (the default branch
    /// when absent).
    pub async fn read_workflows(&self, path: &RepoPath, actor: &User, git_ref: Option<&str>) -> Result<Read> {
        let viewer = Some(actor.clone());
        let tree: Outcome<TreeView> = g1t_kit::call(
            &self.repos,
            "tree",
            &TreeArgs {
                path: path.clone(),
                viewer: viewer.clone(),
                git_ref: git_ref.map(str::to_owned),
                tree_path: FOLDER.to_owned(),
            },
        )
        .await?;
        let (entries, head, resolved) = match tree {
            Outcome::Ok(tree) => (tree.entries, tree.head.map(|commit| commit.hash), tree.git_ref),
            // No folder: no workflows.
            Outcome::Fail(_) => return Ok(Read { files: Vec::new(), head: None }),
        };
        let at = head.clone().unwrap_or(resolved);
        let mut files = Vec::new();
        for entry in entries
            .into_iter()
            .filter(|entry| matches!(entry.kind, EntryKind::Blob | EntryKind::Exec))
            .filter(|entry| entry.name.ends_with(".yml") || entry.name.ends_with(".yaml"))
            .take(MAX_WORKFLOWS)
        {
            let file_path = format!("{FOLDER}/{}", entry.name);
            let blob: Outcome<BlobView> = g1t_kit::call(
                &self.repos,
                "blob",
                &BlobArgs {
                    path: path.clone(),
                    viewer: viewer.clone(),
                    git_ref: at.clone(),
                    file_path: file_path.clone(),
                },
            )
            .await?;
            if let Outcome::Ok(BlobView { text: Some(source), .. }) = blob {
                files.push(WorkflowFile { path: file_path, source });
            }
        }
        Ok(Read { files, head })
    }

    /// Keeps the `workflows` table in step with the default branch.
    pub async fn sync(&self, repo: &Repo, actor: &User) -> Result<()> {
        let path = RepoPath {
            namespace: repo.namespace.clone(),
            name: repo.name.clone(),
        };
        let read = self.read_workflows(&path, actor, None).await?;
        let full_name = format!("{}/{}", repo.namespace, repo.name);
        let now = rfc3339(now_ms());
        let mut statements = Vec::new();
        for file in &read.files {
            let parsed = workflow::parse(&file.source);
            let (name, error, events, crons) = match &parsed {
                Ok(parsed) => (
                    parsed.display_name(&file.path),
                    None,
                    parsed.triggers.iter().map(|t| t.event.clone()).collect::<Vec<_>>(),
                    parsed.trigger("schedule").map(|t| t.crons.clone()).unwrap_or_default(),
                ),
                Err(problem) => (file.path.clone(), Some(problem.clone()), Vec::new(), Vec::new()),
            };
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO workflows (id, repo_id, repo, path, name, source, events, crons, error, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT (repo_id, path) DO UPDATE SET
                           repo = excluded.repo, name = excluded.name, source = excluded.source,
                           events = excluded.events, crons = excluded.crons, error = excluded.error,
                           updated_at = excluded.updated_at",
                    )
                    .bind(&[
                        new_id("wfl", now_ms()).into(),
                        repo.id.as_str().into(),
                        full_name.as_str().into(),
                        file.path.as_str().into(),
                        name.into(),
                        file.source.as_str().into(),
                        serde_json::to_string(&events)?.into(),
                        serde_json::to_string(&crons)?.into(),
                        optional(error.as_deref()),
                        now.as_str().into(),
                    ])?,
            );
        }
        // A workflow whose file is gone keeps its runs, but no longer runs
        // on schedule or by hand: it is listed only while it has runs.
        let kept: Vec<String> = read.files.iter().map(|file| file.path.clone()).collect();
        let existing = self
            .db
            .prepare("SELECT * FROM workflows WHERE repo_id = ?")
            .bind(&[repo.id.as_str().into()])?
            .all()
            .await?
            .results::<WorkflowRow>()?;
        for row in existing.iter().filter(|row| !kept.contains(&row.path)) {
            statements.push(
                self.db
                    .prepare("UPDATE workflows SET crons = '[]', error = 'Its file is no longer on the default branch.' WHERE id = ?")
                    .bind(&[row.id.as_str().into()])?,
            );
        }
        statements.push(
            self.db
                .prepare("INSERT OR REPLACE INTO synced (repo_id, at) VALUES (?, ?)")
                .bind(&[repo.id.as_str().into(), now.into()])?,
        );
        self.db.batch(statements).await?;
        Ok(())
    }

    pub async fn synced(&self, repo_id: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT COUNT(*) AS n FROM synced WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<Count>(None)
            .await?
            .is_some_and(|count| count.n > 0))
    }

    /// The row for a workflow file, made if it is new (a file that exists
    /// only on a branch still gets its runs counted and listed).
    pub async fn workflow_row(&self, repo: &Repo, path: &str, name: &str, source: &str) -> Result<WorkflowRow> {
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "INSERT INTO workflows (id, repo_id, repo, path, name, source, events, error, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, '[]', 'Its file is not on the default branch.', ?)
                 ON CONFLICT (repo_id, path) DO NOTHING",
            )
            .bind(&[
                new_id("wfl", now_ms()).into(),
                repo.id.as_str().into(),
                format!("{}/{}", repo.namespace, repo.name).into(),
                path.into(),
                name.into(),
                source.into(),
                now.into(),
            ])?
            .run()
            .await?;
        self.db
            .prepare("SELECT * FROM workflows WHERE repo_id = ? AND path = ?")
            .bind(&[repo.id.as_str().into(), path.into()])?
            .first::<WorkflowRow>(None)
            .await?
            .ok_or_else(|| worker::Error::RustError("the workflow was not recorded".into()))
    }
}
