//! Managed workflows (`g1t_actions::managed`): workflows installed into a
//! repository without committing them. g1t's services install them in one
//! repository (`managed_workflows`, such as a project's deploy workflow);
//! a workspace's owners add them to many (`workspace_managed_workflows`),
//! each with a target and a mode. Both are read beside the repository's own
//! files wherever its workflows are read (`sync.rs` `read_for`, and a fork's
//! pull request in trigger.rs), and so listed, started, run and re-run as
//! any other workflow is, as the repository's own, with its token and its
//! secrets.
//!
//! A workspace's workflow runs from a copy of its source file taken when an
//! owner saves it, not from the file as it is at each run: whoever can push
//! to the source repository cannot change what runs with every targeted
//! repository's secrets. An owner copies it again to take up a change.

use g1t_actions::managed::{self, Arranged, Mode, Target, VISIBILITIES};
use g1t_actions::workflow;
use g1t_contracts::actions::{
    ManagedBy, RemoveManagedWorkflowArgs, RemoveWorkspaceManagedWorkflowArgs, SetManagedDeployArgs, SetManagedWorkflowArgs,
    SetWorkspaceManagedWorkflowArgs, WorkspaceManagedWorkflow, WorkspaceManagedWorkflowsArgs,
};
use g1t_contracts::repos::{BlobArgs, BlobView, ListArgs, Repo, RepoPath, TreeArgs, TreeView};
use g1t_contracts::audit::{AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, Surface};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::reach::{UsesRef, is_workflow_path, parse_uses};
use crate::sync::WorkflowFile;
use crate::{Actions, fail};

/// Repositories synced at once when a workspace's workflow changes; the
/// rest are synced when their workflows are next listed or their default
/// branch is pushed to. Their runs read the workflows as they are anyway.
const SYNCED_AT_ONCE: usize = 20;

/// The most repositories the repos service's `list` answers with.
const LISTED: usize = 50;

/// Repositories [`Actions::catch_up_syncs`] syncs each minute.
const CAUGHT_UP_PER_MINUTE: u32 = 5;

/// The most repository names and patterns a target takes.
const MAX_PATTERNS: usize = 100;

#[derive(Deserialize)]
struct Row {
    name: String,
    source: String,
}

/// One row of `workspace_managed_workflows`.
#[derive(Clone, Deserialize)]
struct WorkspaceRow {
    name: String,
    source_ref: String,
    source_repo_id: String,
    source_sha: Option<String>,
    source_private: u32,
    source: String,
    workflow_name: String,
    mode: String,
    repositories: String,
    visibility: String,
    created_at: String,
    updated_at: String,
    updated_by: String,
}

impl WorkspaceRow {
    fn mode(&self) -> Mode {
        Mode::parse(&self.mode).unwrap_or(Mode::Default)
    }

    fn target(&self) -> Target {
        Target {
            repositories: serde_json::from_str(&self.repositories).unwrap_or_default(),
            visibility: self.visibility.clone(),
        }
    }

    /// Whether it runs in `repo`.
    fn targets(&self, repo: &Repo) -> bool {
        self.target().includes(&repo.name, repo.is_private, self.source_private != 0)
    }

    fn view(&self) -> WorkspaceManagedWorkflow {
        WorkspaceManagedWorkflow {
            name: self.name.clone(),
            path: managed::path(&self.name),
            workflow_name: self.workflow_name.clone(),
            source: self.source_ref.clone(),
            source_sha: self.source_sha.clone(),
            source_private: self.source_private != 0,
            mode: self.mode().as_str().to_owned(),
            repositories: self.target().repositories,
            visibility: self.visibility.clone(),
            content: self.source.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            updated_by: self.updated_by.clone(),
        }
    }
}

/// The workspace's managed workflow's source as given:
/// `owner/repo/.g1t/workflows/file.yml@ref`, a workflow file in a
/// repository of `workspace`.
fn parse_source(text: &str, workspace: &str) -> std::result::Result<UsesRef, String> {
    let shape = "Give the source as owner/repo/.g1t/workflows/file.yml@ref, a workflow file in one of the workspace's repositories.";
    let source = parse_uses(text).ok_or_else(|| shape.to_owned())?;
    if !is_workflow_path(&source.path) {
        return Err(shape.to_owned());
    }
    if !source.owner.eq_ignore_ascii_case(workspace) {
        return Err(format!("The source must be in one of {workspace}'s own repositories."));
    }
    Ok(source)
}

/// Whether a workflow copied from a repository (private or not) may target
/// repositories of `visibility`: a private repository's workflow never runs
/// in a public one, whose workflow page and logs anyone can read, as a
/// public repository's workflows may not use a private one's (reach.rs).
fn may_reach(source: &str, source_private: bool, visibility: &str) -> std::result::Result<(), String> {
    if source_private && visibility != "private" {
        return Err(format!(
            "{source} is in a private repository, so it can run in private repositories only: choose Private repositories, or a source in a public repository."
        ));
    }
    Ok(())
}

/// Names and patterns as given: trimmed, without empties or repeats.
fn clean_patterns(given: &[String]) -> std::result::Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for pattern in given.iter().map(|pattern| pattern.trim()).filter(|pattern| !pattern.is_empty()) {
        if pattern.len() > 100 || pattern.contains('/') {
            return Err(format!("\"{pattern}\" is not a repository name or pattern."));
        }
        if !out.iter().any(|kept| kept.eq_ignore_ascii_case(pattern)) {
            out.push(pattern.to_owned());
        }
    }
    if out.len() > MAX_PATTERNS {
        return Err(format!("A workflow targets at most {MAX_PATTERNS} repository names and patterns."));
    }
    Ok(out)
}

/// An entry for the workspace's audit log: who changed which of its
/// managed workflows, and how.
fn audit_entry(actor: &User, action: &str, workspace: &str, name: &str, message: String) -> NewAuditEntry {
    NewAuditEntry {
        actor: AuditActor::of(actor),
        action: action.to_owned(),
        surface: Surface::Rest,
        target: AuditTarget { workspace: workspace.to_owned(), path: Some(managed::path(name)), ..AuditTarget::default() },
        outcome: AuditOutcome::Allowed,
        rule: "managed_workflow".to_owned(),
        result: Some("ok".to_owned()),
        message: Some(message),
        request_id: new_id("req", now_ms()),
    }
}

/// Owners only: Err is the refusal.
fn owner_of<T>(actor: &User, workspace: &str) -> std::result::Result<(), Outcome<T>> {
    if actor.token.as_ref().is_some_and(|token| token.job.is_some()) {
        return Err(fail(FailureCode::Forbidden, "A workflow job's token cannot change the workspace's workflows."));
    }
    if actor.kind != PrincipalKind::User || actor.role_in(workspace) != Some(Role::Owner) {
        return Err(fail(FailureCode::Forbidden, format!("Only an owner of {workspace} can change the workflows it manages.")));
    }
    Ok(())
}

impl Actions {
    /// `set_managed_workflow`.
    pub async fn set_managed_workflow(&self, a: SetManagedWorkflowArgs) -> Result<Outcome<bool>> {
        if !managed::valid_name(&a.name) {
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

    /// `set_managed_deploy`.
    pub async fn set_managed_deploy(&self, a: SetManagedDeployArgs) -> Result<Outcome<bool>> {
        let name = format!("deploy-{}", a.project);
        let settings = managed::DeploySettings {
            project: a.project,
            production_branch: a.production_branch,
            root_dir: a.root_dir,
            build_command: a.build_command,
            output_dir: a.output_dir,
            previews: a.previews,
            production: a.production,
        };
        match managed::deploy_workflow(&settings) {
            Some(source) => self.set_managed_workflow(SetManagedWorkflowArgs { repo_id: a.repo_id, name, source, origin: "deployments".to_owned() }).await,
            None => {
                self.remove_managed_workflow(RemoveManagedWorkflowArgs { repo_id: a.repo_id, name }).await?;
                Ok(Outcome::Ok(false))
            }
        }
    }

    // --- A workspace's ------------------------------------------------------------

    async fn workspace_rows(&self, workspace: &str) -> Result<Vec<WorkspaceRow>> {
        self.db
            .prepare("SELECT * FROM workspace_managed_workflows WHERE namespace = ? ORDER BY name")
            .bind(&[workspace.to_lowercase().into()])?
            .all()
            .await?
            .results::<WorkspaceRow>()
    }

    async fn workspace_row(&self, workspace: &str, name: &str) -> Result<Option<WorkspaceRow>> {
        self.db
            .prepare("SELECT * FROM workspace_managed_workflows WHERE namespace = ? AND name = ?")
            .bind(&[workspace.to_lowercase().into(), name.into()])?
            .first::<WorkspaceRow>(None)
            .await
    }

    /// `workspace_managed_workflows`.
    pub async fn workspace_managed_workflows(&self, a: WorkspaceManagedWorkflowsArgs) -> Result<Outcome<Vec<WorkspaceManagedWorkflow>>> {
        let workspace = a.workspace.trim().to_lowercase();
        let Some(viewer) = a.viewer.as_ref().filter(|viewer| viewer.is_member(&workspace)) else {
            return Ok(fail(FailureCode::NotFound, "There is no such workspace."));
        };
        if viewer.role_in(&workspace) != Some(Role::Owner) {
            return Ok(fail(FailureCode::Forbidden, format!("Only an owner of {workspace} can see the workflows it manages.")));
        }
        Ok(Outcome::Ok(self.workspace_rows(&workspace).await?.iter().map(WorkspaceRow::view).collect()))
    }

    /// Copies a workspace's managed workflow's source, as `actor` reads it:
    /// the file at the commit its ref names. Err is the refusal.
    async fn copy_source(&self, actor: &User, workspace: &str, given: &str) -> Result<std::result::Result<(Repo, String, Option<String>), String>> {
        let source = match parse_source(given, workspace) {
            Ok(source) => source,
            Err(problem) => return Ok(Err(problem)),
        };
        let path = RepoPath { namespace: source.owner.clone(), name: source.repo.clone() };
        let Some(repo) = self.visible_repo(&path, &Some(actor.clone())).await? else {
            return Ok(Err(format!("There is no repository {} in {workspace}.", source.full_name())));
        };
        let folder = source.path.rsplit_once('/').map_or("", |(folder, _)| folder).to_owned();
        let tree: Outcome<TreeView> = g1t_kit::call(
            &self.repos,
            "tree",
            &TreeArgs { path: path.clone(), viewer: Some(actor.clone()), git_ref: Some(source.git_ref.clone()), tree_path: folder },
        )
        .await?;
        let Outcome::Ok(tree) = tree else {
            return Ok(Err(format!("{} has no {} at {}.", source.full_name(), source.path, source.git_ref)));
        };
        let sha = tree.head.map(|commit| commit.hash);
        let blob: Outcome<BlobView> = g1t_kit::call(
            &self.repos,
            "blob",
            &BlobArgs {
                path,
                viewer: Some(actor.clone()),
                git_ref: sha.clone().unwrap_or_else(|| source.git_ref.clone()),
                file_path: source.path.clone(),
            },
        )
        .await?;
        let Outcome::Ok(BlobView { text: Some(text), .. }) = blob else {
            return Ok(Err(format!("{} has no {} at {}.", source.full_name(), source.path, source.git_ref)));
        };
        if let Err(problem) = workflow::parse(&text) {
            return Ok(Err(format!("{} does not read as a workflow: {problem}", source.path)));
        }
        Ok(Ok((repo, text, sha)))
    }

    /// `set_workspace_managed_workflow`.
    pub async fn set_workspace_managed_workflow(&self, a: SetWorkspaceManagedWorkflowArgs) -> Result<Outcome<WorkspaceManagedWorkflow>> {
        let workspace = a.workspace.trim().to_lowercase();
        if let Err(refused) = owner_of(&a.actor, &workspace) {
            return Ok(refused);
        }
        let name = a.name.trim().to_owned();
        if !managed::valid_name(&name) {
            return Ok(fail(FailureCode::Invalid, "A managed workflow's name is lowercase letters, digits and hyphens, at most 64."));
        }
        let before = self.workspace_row(&workspace, &name).await?;
        match (&before, a.create) {
            (Some(_), true) => return Ok(fail(FailureCode::Conflict, format!("{workspace} already manages a workflow called {name}."))),
            (None, false) => return Ok(fail(FailureCode::NotFound, format!("{workspace} manages no workflow called {name}."))),
            _ => {}
        }
        let mode = match a.mode.as_deref().map(Mode::parse) {
            Some(Some(mode)) => mode,
            Some(None) => return Ok(fail(FailureCode::Invalid, "mode is required or default.")),
            None => match &before {
                Some(row) => row.mode(),
                None => return Ok(fail(FailureCode::Invalid, "Choose a mode: required or default.")),
            },
        };
        let visibility = match a.visibility.as_deref().map(|text| text.trim().to_ascii_lowercase()) {
            Some(text) if VISIBILITIES.contains(&text.as_str()) => text,
            Some(_) => return Ok(fail(FailureCode::Invalid, "visibility is all, public or private.")),
            None => before.as_ref().map_or_else(|| "all".to_owned(), |row| row.visibility.clone()),
        };
        let repositories = match &a.repositories {
            Some(given) => match clean_patterns(given) {
                Ok(patterns) => patterns,
                Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
            },
            None => before.as_ref().map(|row| row.target().repositories).unwrap_or_default(),
        };
        let given_source = a.source.as_deref().map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned);
        let mut row = match (&before, given_source) {
            (Some(row), None) if !a.refresh => row.clone(),
            (before, given) => {
                let Some(given) = given.or_else(|| before.as_ref().map(|row| row.source_ref.clone())) else {
                    return Ok(fail(FailureCode::Invalid, "Give the source as owner/repo/.g1t/workflows/file.yml@ref."));
                };
                let (source_repo, text, sha) = match self.copy_source(&a.actor, &workspace, &given).await? {
                    Ok(copied) => copied,
                    Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
                };
                let workflow_name = workflow::parse(&text).map(|parsed| parsed.display_name(&managed::path(&name))).unwrap_or_default();
                WorkspaceRow {
                    name: name.clone(),
                    source_ref: given,
                    source_repo_id: source_repo.id,
                    source_sha: sha,
                    source_private: u32::from(source_repo.is_private),
                    source: text,
                    workflow_name,
                    mode: String::new(),
                    repositories: String::new(),
                    visibility: String::new(),
                    created_at: before.as_ref().map_or_else(|| rfc3339(now_ms()), |row| row.created_at.clone()),
                    updated_at: String::new(),
                    updated_by: String::new(),
                }
            }
        };
        if let Err(problem) = may_reach(&row.source_ref, row.source_private != 0, &visibility) {
            return Ok(fail(FailureCode::Invalid, problem));
        }
        row.mode = mode.as_str().to_owned();
        row.repositories = serde_json::to_string(&repositories)?;
        row.visibility = visibility;
        row.updated_at = rfc3339(now_ms());
        row.updated_by = a.actor.username.clone();
        self.db
            .prepare(
                "INSERT INTO workspace_managed_workflows
                   (namespace, name, source_ref, source_repo_id, source_sha, source_private, source, workflow_name, mode, repositories, visibility, created_at, updated_at, updated_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT (namespace, name) DO UPDATE SET
                   source_ref = ?3, source_repo_id = ?4, source_sha = ?5, source_private = ?6, source = ?7, workflow_name = ?8,
                   mode = ?9, repositories = ?10, visibility = ?11, updated_at = ?13, updated_by = ?14",
            )
            .bind(&[
                workspace.as_str().into(),
                row.name.as_str().into(),
                row.source_ref.as_str().into(),
                row.source_repo_id.as_str().into(),
                crate::optional(row.source_sha.as_deref()),
                row.source_private.into(),
                row.source.as_str().into(),
                row.workflow_name.as_str().into(),
                row.mode.as_str().into(),
                row.repositories.as_str().into(),
                row.visibility.as_str().into(),
                row.created_at.as_str().into(),
                row.updated_at.as_str().into(),
                row.updated_by.as_str().into(),
            ])?
            .run()
            .await?;
        let message = format!(
            "{} the {} workflow {} from {}{}.",
            if before.is_some() { "Changed" } else { "Added" },
            row.mode,
            row.name,
            row.source_ref,
            row.source_sha.as_deref().map(|sha| format!(" at {}", &sha[..sha.len().min(12)])).unwrap_or_default(),
        );
        let action = if before.is_some() { "update_workspace_managed_workflow" } else { "create_workspace_managed_workflow" };
        self.audit(vec![audit_entry(&a.actor, action, &workspace, &row.name, message)]).await;
        self.resync_workspace(&workspace, before.as_ref(), Some(&row)).await?;
        Ok(Outcome::Ok(row.view()))
    }

    /// `remove_workspace_managed_workflow`.
    pub async fn remove_workspace_managed_workflow(&self, a: RemoveWorkspaceManagedWorkflowArgs) -> Result<Outcome<bool>> {
        let workspace = a.workspace.trim().to_lowercase();
        if let Err(refused) = owner_of(&a.actor, &workspace) {
            return Ok(refused);
        }
        let removed = self
            .db
            .prepare("DELETE FROM workspace_managed_workflows WHERE namespace = ? AND name = ? RETURNING *")
            .bind(&[workspace.as_str().into(), a.name.trim().into()])?
            .first::<WorkspaceRow>(None)
            .await?;
        if let Some(removed) = &removed {
            let message = format!("Removed the {} workflow {}.", removed.mode, removed.name);
            self.audit(vec![audit_entry(&a.actor, "delete_workspace_managed_workflow", &workspace, &removed.name, message)]).await;
            self.resync_workspace(&workspace, Some(removed), None).await?;
        }
        Ok(Outcome::Ok(removed.is_some()))
    }

    /// Brings the workflows of the repositories a change reached (those the
    /// workflow targeted `before`, or does `after`) up to date. Up to
    /// [`SYNCED_AT_ONCE`] are synced now. In a larger workspace every other
    /// repository's `synced` row goes, so it is synced when its workflows
    /// are next listed, or by the minute's sweep ([`Self::catch_up_syncs`]);
    /// until then its runs still read the workflows as they are, and its
    /// managed workflows' schedules wait.
    async fn resync_workspace(&self, workspace: &str, before: Option<&WorkspaceRow>, after: Option<&WorkspaceRow>) -> Result<()> {
        let Some(ws) = self.workspace_actor(workspace).await? else { return Ok(()) };
        // The workspace's newest repositories (the listing's first page).
        let repos: Vec<Repo> = g1t_kit::call(
            &self.repos,
            "list",
            &ListArgs { viewer: Some(ws.clone()), query: None, namespace: Some(workspace.to_owned()), member_only: false },
        )
        .await?;
        let listed_all = repos.len() < LISTED;
        let reached: Vec<Repo> = repos
            .into_iter()
            .filter(|repo| repo.fork_of.is_none() && repo.namespace.eq_ignore_ascii_case(workspace))
            .filter(|repo| before.is_some_and(|row| row.targets(repo)) || after.is_some_and(|row| row.targets(repo)))
            .collect();
        let now = &reached[..reached.len().min(SYNCED_AT_ONCE)];
        for repo in now {
            self.sync(repo, &ws).await?;
        }
        if !listed_all || reached.len() > now.len() {
            let done: Vec<&str> = now.iter().map(|repo| repo.id.as_str()).collect();
            self.db
                .prepare(
                    "DELETE FROM synced WHERE repo_id IN (SELECT DISTINCT repo_id FROM workflows WHERE substr(repo, 1, length(?1) + 1) = ?1 || '/')
                       AND repo_id NOT IN (SELECT value FROM json_each(?2))",
                )
                .bind(&[workspace.into(), serde_json::to_string(&done)?.into()])?
                .run()
                .await?;
        }
        Ok(())
    }

    /// Every minute: syncs a few repositories whose workflows are listed
    /// but not synced since a workspace's managed workflows changed.
    pub(crate) async fn catch_up_syncs(&self) -> Result<()> {
        #[derive(Deserialize)]
        struct Id {
            repo_id: String,
        }
        let ids = self
            .db
            .prepare("SELECT DISTINCT repo_id FROM workflows WHERE repo_id NOT IN (SELECT repo_id FROM synced) LIMIT ?")
            .bind(&[CAUGHT_UP_PER_MINUTE.into()])?
            .all()
            .await?
            .results::<Id>()?;
        for Id { repo_id } in ids {
            match self.repo_by_id(&repo_id).await? {
                Some((repo, ws)) => self.sync(&repo, &ws).await?,
                // Gone: nothing to sync, so it is not looked for again.
                None => {
                    self.db
                        .prepare("INSERT OR REPLACE INTO synced (repo_id, at) VALUES (?, ?)")
                        .bind(&[repo_id.as_str().into(), rfc3339(now_ms()).into()])?
                        .run()
                        .await?;
                }
            }
        }
        Ok(())
    }

    /// The workflows `repo` runs: its own `files` and the managed workflows
    /// installed in it or its workspace's that target it, as
    /// `g1t_actions::managed::arrange` puts them together. A required
    /// workflow of the workspace's sets aside a file of its name.
    pub(crate) async fn with_managed(&self, repo: &Repo, files: Vec<WorkflowFile>) -> Result<Vec<WorkflowFile>> {
        let installed = self
            .db
            .prepare("SELECT name, source FROM managed_workflows WHERE repo_id = ? ORDER BY name")
            .bind(&[repo.id.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;
        let workspace: Vec<WorkspaceRow> = self.workspace_rows(&repo.namespace).await?.into_iter().filter(|row| row.targets(repo)).collect();
        if installed.is_empty() && workspace.is_empty() {
            return Ok(files);
        }
        Ok(managed::arrange(
            files.into_iter().map(|file| (file.path, file.source)).collect(),
            installed.into_iter().map(|row| (managed::path(&row.name), row.source)).collect(),
            workspace.into_iter().map(|row| (managed::path(&row.name), row.source.clone(), row.mode())).collect(),
        )
        .into_iter()
        .map(|Arranged { path, source, required }| WorkflowFile { path, source, required })
        .collect())
    }

    /// Whether `path` in `repo` is a required workflow of its workspace's,
    /// which no one in the repository can turn off.
    pub(crate) async fn required_here(&self, repo: &Repo, path: &str) -> Result<bool> {
        let Some(name) = path.strip_prefix("managed/").and_then(|rest| rest.strip_suffix(".yml")) else {
            return Ok(false);
        };
        Ok(self.workspace_row(&repo.namespace, name).await?.is_some_and(|row| row.mode() == Mode::Required && row.targets(repo)))
    }

    /// What installed the managed workflow at `path` in a repository of
    /// `workspace`, whose synced copy is `source`: the workspace, when the
    /// copy is its; else g1t.
    pub(crate) async fn managed_by(&self, workspace: &str, path: &str, source: &str) -> Result<Option<ManagedBy>> {
        let Some(name) = path.strip_prefix("managed/").and_then(|rest| rest.strip_suffix(".yml")) else {
            return Ok(None);
        };
        Ok(Some(match self.workspace_row(workspace, name).await?.filter(|row| row.source == source) {
            Some(row) => ManagedBy { origin: workspace.to_lowercase(), mode: row.mode().as_str().to_owned(), source: Some(row.source_ref) },
            None => ManagedBy { origin: "g1t".to_owned(), mode: String::new(), source: None },
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_is_a_workflow_file_in_the_workspace() {
        let source = parse_source("acme/policies/.g1t/workflows/scan.yml@main", "acme").unwrap();
        assert_eq!((source.repo.as_str(), source.path.as_str(), source.git_ref.as_str()), ("policies", ".g1t/workflows/scan.yml", "main"));
        assert!(parse_source("ACME/policies/.github/workflows/scan.yaml@v1", "acme").is_ok());
        assert!(parse_source("other/policies/.g1t/workflows/scan.yml@main", "acme").unwrap_err().contains("acme's own"));
        for bad in ["acme/policies@main", "acme/policies/README.md@main", "acme/policies/.g1t/workflows/scan.yml", "./.g1t/workflows/scan.yml"] {
            assert!(parse_source(bad, "acme").is_err(), "{bad}");
        }
    }

    #[test]
    fn a_private_source_runs_in_private_repositories_only() {
        assert!(may_reach("acme/p/.g1t/workflows/a.yml@main", false, "all").is_ok());
        assert!(may_reach("acme/p/.g1t/workflows/a.yml@main", true, "private").is_ok());
        assert!(may_reach("acme/p/.g1t/workflows/a.yml@main", true, "all").is_err());
        assert!(may_reach("acme/p/.g1t/workflows/a.yml@main", true, "public").is_err());
    }

    #[test]
    fn patterns_are_names_without_repeats() {
        assert_eq!(clean_patterns(&[" web ".into(), "".into(), "WEB".into(), "api-*".into()]).unwrap(), ["web", "api-*"]);
        assert!(clean_patterns(&["acme/web".into()]).is_err());
        assert!(clean_patterns(&(0..=MAX_PATTERNS).map(|n| format!("r{n}")).collect::<Vec<_>>()).is_err());
    }

    fn row(mode: &str, repositories: &str, visibility: &str, private: bool) -> WorkspaceRow {
        WorkspaceRow {
            name: "scan".into(),
            source_ref: "acme/policies/.g1t/workflows/scan.yml@main".into(),
            source_repo_id: "rep_1".into(),
            source_sha: None,
            source_private: u32::from(private),
            source: String::new(),
            workflow_name: "Scan".into(),
            mode: mode.into(),
            repositories: repositories.into(),
            visibility: visibility.into(),
            created_at: String::new(),
            updated_at: String::new(),
            updated_by: String::new(),
        }
    }

    fn repo(name: &str, private: bool) -> Repo {
        Repo {
            id: "rep_2".into(),
            namespace: "acme".into(),
            name: name.into(),
            description: None,
            is_private: private,
            owner_id: String::new(),
            default_branch: "main".into(),
            fork_of: None,
            parent_id: None,
            forked_from: None,
            parent: None,
            allow_forking: false,
            max_ref_updates: None,
            protected: false,
            created_at: String::new(),
            topics: Vec::new(),
            website: None,
            archived_at: None,
        }
    }

    #[test]
    fn a_row_targets_by_its_patterns_and_visibility() {
        let all = row("required", "[]", "all", false);
        assert!(all.targets(&repo("web", false)) && all.targets(&repo("api", true)));
        assert_eq!(all.mode(), Mode::Required);
        let some = row("default", r#"["web","api-*"]"#, "all", false);
        assert!(some.targets(&repo("api-1", false)) && !some.targets(&repo("docs", false)));
        assert_eq!(some.view().repositories, ["web", "api-*"]);
        // From a private repository: never a public one.
        let private = row("required", "[]", "all", true);
        assert!(private.targets(&repo("web", true)) && !private.targets(&repo("site", false)));
        assert_eq!(row("whatever", "[]", "all", false).mode(), Mode::Default);
    }
}
