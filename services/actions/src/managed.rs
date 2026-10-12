//! Managed workflows (`g1t_actions::managed`): workflows g1t's services
//! install into a repository without committing them. They are kept here,
//! read beside the repository's own files wherever its workflows are read
//! (`sync.rs` `read_for`), and so listed, started, run and re-run as any
//! other workflow is.

use g1t_actions::managed;
use g1t_actions::workflow;
use g1t_contracts::actions::{RemoveManagedWorkflowArgs, SetManagedWorkflowArgs};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::sync::WorkflowFile;
use crate::{Actions, fail};

/// Whether `name` can end a managed workflow's path.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[derive(Deserialize)]
struct Row {
    name: String,
    source: String,
}

impl Actions {
    /// `set_managed_workflow`.
    pub async fn set_managed_workflow(&self, a: SetManagedWorkflowArgs) -> Result<Outcome<bool>> {
        if !valid_name(&a.name) {
            return Ok(fail(FailureCode::Invalid, "A managed workflow's name is lowercase letters, digits and hyphens."));
        }
        if let Err(problem) = workflow::parse(&a.source) {
            return Ok(fail(FailureCode::Invalid, format!("The managed workflow does not read as a workflow: {problem}")));
        }
        let Some((repo, ws)) = self.repo_by_id(&a.repo_id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such repository."));
        };
        self.db
            .prepare(
                "INSERT INTO managed_workflows (repo_id, name, source, origin, updated_at) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (repo_id, name) DO UPDATE SET source = excluded.source, origin = excluded.origin, updated_at = excluded.updated_at",
            )
            .bind(&[a.repo_id.as_str().into(), a.name.as_str().into(), a.source.as_str().into(), a.origin.as_str().into(), rfc3339(now_ms()).into()])?
            .run()
            .await?;
        // Listed, and on schedule, at once.
        self.sync(&repo, &ws).await?;
        Ok(Outcome::Ok(true))
    }

    /// `remove_managed_workflow`.
    pub async fn remove_managed_workflow(&self, a: RemoveManagedWorkflowArgs) -> Result<Outcome<bool>> {
        let removed = self
            .db
            .prepare("DELETE FROM managed_workflows WHERE repo_id = ? AND name = ? RETURNING name")
            .bind(&[a.repo_id.as_str().into(), a.name.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some();
        if removed && let Some((repo, ws)) = self.repo_by_id(&a.repo_id).await? {
            self.sync(&repo, &ws).await?;
        }
        Ok(Outcome::Ok(removed))
    }

    /// The managed workflows that run beside `files`, a repository's own:
    /// each one no file of the same `name:` takes the place of.
    pub(crate) async fn managed_beside(&self, repo_id: &str, files: &[WorkflowFile]) -> Result<Vec<WorkflowFile>> {
        let rows = self
            .db
            .prepare("SELECT name, source FROM managed_workflows WHERE repo_id = ? ORDER BY name")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<Row>()?;
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let installed = rows.into_iter().map(|row| (managed::path(&row.name), row.source)).collect();
        Ok(managed::prefer_repository(files.iter().map(|file| (file.path.as_str(), file.source.as_str())), installed)
            .into_iter()
            .map(|(path, source)| WorkflowFile { path, source })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_workflows_are_named_as_files() {
        assert!(valid_name("deploy") && valid_name("code-scanning-2"));
        for bad in ["", "Deploy", "a/b", "a.yml", "../x", &"a".repeat(65)] {
            assert!(!valid_name(bad), "{bad}");
        }
    }
}
