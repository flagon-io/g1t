//! g1t's events as GitHub's: which event and activity type each one is,
//! and the `github` context and `GITHUB_*` variables a run sees.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// The GitHub event and activity type for a g1t event, if it has one.
/// A g1t event can be more than one GitHub event: a pull request opening
/// is `pull_request` and `pull_request_target`.
pub fn github_events(kind: &str) -> Vec<(&'static str, Option<&'static str>)> {
    let pull = |action| vec![("pull_request", Some(action)), ("pull_request_target", Some(action))];
    match kind {
        "git.push" => vec![("push", None)],
        "pull.opened" => pull("opened"),
        "pull.updated" => pull("synchronize"),
        "pull.ready" => pull("ready_for_review"),
        "pull.closed" | "pull.merged" => pull("closed"),
        "pull.assigned" => pull("assigned"),
        "pull.review_requested" => pull("review_requested"),
        "pull.review_request_removed" => pull("review_request_removed"),
        "issue.opened" => vec![("issues", Some("opened"))],
        "issue.updated" => vec![("issues", Some("edited"))],
        "issue.closed" => vec![("issues", Some("closed"))],
        "issue.reopened" => vec![("issues", Some("reopened"))],
        "issue.assigned" => vec![("issues", Some("assigned"))],
        "comment.created" => vec![("issue_comment", Some("created"))],
        "review.completed" => vec![("pull_request_review", Some("submitted"))],
        "workflow.completed" => vec![("workflow_run", Some("completed"))],
        _ => Vec::new(),
    }
}

/// What a run is about: enough to fill the `github` context.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    /// `acme/web`.
    pub repository: String,
    pub repository_id: String,
    pub default_branch: String,
    pub event_name: String,
    /// The webhook-shaped payload, `github.event`.
    pub event: Value,
    /// `refs/heads/main`, `refs/tags/v1`, `refs/pull/3/merge`.
    pub git_ref: String,
    pub sha: String,
    /// For pull requests: the head and base branches.
    pub head_ref: Option<String>,
    pub base_ref: Option<String>,
    pub actor: String,
    pub actor_id: String,
    pub triggering_actor: String,
    pub run_id: String,
    pub run_number: u64,
    pub run_attempt: u64,
    /// The workflow's name.
    pub workflow: String,
    /// `.g1t/workflows/ci.yml`.
    pub workflow_path: String,
    pub server_url: String,
    pub api_url: String,
}

impl RunInfo {
    pub fn ref_name(&self) -> String {
        self.git_ref
            .strip_prefix("refs/heads/")
            .or_else(|| self.git_ref.strip_prefix("refs/tags/"))
            .or_else(|| self.git_ref.strip_prefix("refs/"))
            .unwrap_or(&self.git_ref)
            .to_owned()
    }

    pub fn ref_type(&self) -> &'static str {
        if self.git_ref.starts_with("refs/tags/") { "tag" } else { "branch" }
    }

    fn owner(&self) -> &str {
        self.repository.split('/').next().unwrap_or_default()
    }

    /// The `github` context for a job. `token` is `github.token` (and
    /// `secrets.GITHUB_TOKEN`); `job` is the job's id.
    pub fn context(&self, job: &str, token: &str, action: Option<&str>) -> Value {
        json!({
            "action": action.unwrap_or_default(),
            "action_path": "",
            "action_ref": "",
            "action_repository": "",
            "actor": self.actor,
            "actor_id": self.actor_id,
            "api_url": self.api_url,
            "base_ref": self.base_ref.clone().unwrap_or_default(),
            "env": "",
            "event": self.event,
            "event_name": self.event_name,
            "event_path": "/home/runner/_temp/event.json",
            "graphql_url": "",
            "head_ref": self.head_ref.clone().unwrap_or_default(),
            "job": job,
            "path": "",
            "ref": self.git_ref,
            "ref_name": self.ref_name(),
            "ref_protected": self.ref_name() == self.default_branch,
            "ref_type": self.ref_type(),
            "repository": self.repository,
            "repository_id": self.repository_id,
            "repository_owner": self.owner(),
            "repository_owner_id": "",
            "repositoryUrl": format!("{}/{}.git", self.server_url, self.repository),
            "retention_days": 14,
            "run_attempt": self.run_attempt.to_string(),
            "run_id": self.run_id,
            "run_number": self.run_number.to_string(),
            "secret_source": "Actions",
            "server_url": self.server_url,
            "sha": self.sha,
            "token": token,
            "triggering_actor": self.triggering_actor,
            "workflow": self.workflow,
            "workflow_ref": format!("{}/{}@{}", self.repository, self.workflow_path, self.git_ref),
            "workflow_sha": self.sha,
            "workspace": WORKSPACE,
        })
    }

    /// The `GITHUB_*` and `RUNNER_*` variables every step gets.
    pub fn variables(&self, job: &str) -> Map<String, Value> {
        let mut vars = Map::new();
        let mut set = |key: &str, value: String| {
            vars.insert(key.to_owned(), Value::String(value));
        };
        set("CI", "true".into());
        set("GITHUB_ACTIONS", "true".into());
        set("G1T", "true".into());
        set("GITHUB_ACTOR", self.actor.clone());
        set("GITHUB_ACTOR_ID", self.actor_id.clone());
        set("GITHUB_API_URL", self.api_url.clone());
        set("GITHUB_BASE_REF", self.base_ref.clone().unwrap_or_default());
        set("GITHUB_EVENT_NAME", self.event_name.clone());
        set("GITHUB_EVENT_PATH", "/home/runner/_temp/event.json".into());
        set("GITHUB_GRAPHQL_URL", String::new());
        set("GITHUB_HEAD_REF", self.head_ref.clone().unwrap_or_default());
        set("GITHUB_JOB", job.to_owned());
        set("GITHUB_REF", self.git_ref.clone());
        set("GITHUB_REF_NAME", self.ref_name());
        set("GITHUB_REF_PROTECTED", (self.ref_name() == self.default_branch).to_string());
        set("GITHUB_REF_TYPE", self.ref_type().into());
        set("GITHUB_REPOSITORY", self.repository.clone());
        set("GITHUB_REPOSITORY_ID", self.repository_id.clone());
        set("GITHUB_REPOSITORY_OWNER", self.owner().to_owned());
        set("GITHUB_RETENTION_DAYS", "14".into());
        set("GITHUB_RUN_ATTEMPT", self.run_attempt.to_string());
        set("GITHUB_RUN_ID", self.run_id.clone());
        set("GITHUB_RUN_NUMBER", self.run_number.to_string());
        set("GITHUB_SERVER_URL", self.server_url.clone());
        set("GITHUB_SHA", self.sha.clone());
        set("GITHUB_TRIGGERING_ACTOR", self.triggering_actor.clone());
        set("GITHUB_WORKFLOW", self.workflow.clone());
        set("GITHUB_WORKFLOW_REF", format!("{}/{}@{}", self.repository, self.workflow_path, self.git_ref));
        set("GITHUB_WORKFLOW_SHA", self.sha.clone());
        set("GITHUB_WORKSPACE", WORKSPACE.into());
        set("RUNNER_ARCH", "X64".into());
        set("RUNNER_NAME", "g1t".into());
        set("RUNNER_OS", "Linux".into());
        set("RUNNER_TEMP", "/home/runner/_temp".into());
        set("RUNNER_TOOL_CACHE", "/home/runner/_tool".into());
        set("RUNNER_ENVIRONMENT", "github-hosted".into());
        vars
    }
}

/// Where a job's repository is checked out, as on GitHub's runners.
pub const WORKSPACE: &str = "/home/runner/work/repo";

/// The `runner` context.
pub fn runner_context() -> Value {
    json!({
        "name": "g1t",
        "os": "Linux",
        "arch": "X64",
        "temp": "/home/runner/_temp",
        "tool_cache": "/home/runner/_tool",
        "environment": "github-hosted",
        "debug": "",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn g1t_events_are_github_events() {
        assert_eq!(github_events("git.push"), [("push", None)]);
        assert_eq!(github_events("pull.updated")[0], ("pull_request", Some("synchronize")));
        assert_eq!(github_events("pull.merged")[1], ("pull_request_target", Some("closed")));
        assert_eq!(github_events("comment.created"), [("issue_comment", Some("created"))]);
        assert!(github_events("session.appended").is_empty());
    }

    #[test]
    fn contexts_and_variables_agree() {
        let info = RunInfo {
            repository: "acme/web".into(),
            default_branch: "main".into(),
            event_name: "push".into(),
            git_ref: "refs/tags/v1.2.0".into(),
            sha: "abc".into(),
            run_number: 7,
            run_attempt: 1,
            server_url: "https://g1t.sh".into(),
            ..RunInfo::default()
        };
        let github = info.context("build", "tok", None);
        assert_eq!(github["ref_name"], "v1.2.0");
        assert_eq!(github["ref_type"], "tag");
        assert_eq!(github["repository_owner"], "acme");
        assert_eq!(github["run_number"], "7");
        let vars = info.variables("build");
        assert_eq!(vars["GITHUB_REF_NAME"], "v1.2.0");
        assert_eq!(vars["GITHUB_JOB"], "build");
        assert_eq!(vars["RUNNER_OS"], "Linux");
    }
}
