//! The automations service: rules in a repository's `.g1t/automations/`
//! that act when something happens, in the way GitHub Actions' workflows
//! do, but on g1t's events and with g1t's own steps.
//!
//! An automation says *on* which event (or a schedule, or by hand), *if*
//! which conditions hold, *do* which steps: comment, label, put an agent
//! on it, message the agent working on it, open, close or reopen an issue,
//! post to a URL. Files on the default branch are the source of truth; each
//! push reloads them. Every run is kept, step by step.
//!
//! Mirrors `packages/contracts/src/automations.ts`.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
use crate::{User, Viewer};

/// One automation, as read from its file.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    /// `owner/name`.
    pub repo: String,
    /// The file it comes from, such as `.g1t/automations/bugs.yml`.
    pub path: String,
    pub name: String,
    /// What starts it, in words: `issue.opened`, `every Monday at 09:00`.
    pub trigger: String,
    /// Its conditions and steps, in words, one each.
    pub conditions: Vec<String>,
    pub steps: Vec<String>,
    /// Whether it runs. Members can turn one off without changing its file.
    pub enabled: bool,
    /// Why the file could not be used, if it could not.
    pub error: Option<String>,
    /// Whether it can be run by hand.
    pub manual: bool,
    pub last_run: Option<AutomationRun>,
}

/// One step of a run, and how it went.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub step: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub name: String,
    /// What started it: an event type, `schedule` or `manual`.
    pub event: String,
    /// The issue or pull request it acted on.
    pub number: Option<u32>,
    /// `succeeded`, `failed` (a step failed) or `skipped` (and why, in
    /// `reason`).
    pub status: String,
    pub reason: Option<String>,
    pub steps: Vec<StepResult>,
    /// Who started it by hand, or who caused the event.
    pub actor: Option<String>,
    /// RFC 3339.
    pub started_at: String,
}

/// `list`: a repository's automations. Returns `Outcome<Vec<Automation>>`.
/// Anyone who can see the repository.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
}

/// `runs`: a repository's latest runs, newest first, of one automation or
/// all. Returns `Outcome<Vec<AutomationRun>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct RunsArgs {
    pub repo: RepoPath,
    pub viewer: Viewer,
    #[serde(default)]
    pub automation: Option<String>,
}

/// `run`: runs an automation now, on an issue or pull request if given.
/// Returns `Outcome<AutomationRun>`. Members only.
#[derive(Debug, Serialize, Deserialize)]
pub struct RunArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    #[serde(default)]
    pub number: Option<u32>,
}

/// `set_enabled`: turns an automation on or off. Returns
/// `Outcome<Automation>`. Members only.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetEnabledArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    pub enabled: bool,
}
