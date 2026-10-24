//! g1t's events as GitHub's: which event and activity type each one is,
//! and the `github` context and `GITHUB_*` variables a run sees.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// The GitHub event and activity type for a g1t event, if it has one.
/// A g1t event can be more than one GitHub event: a pull request opening
/// is `pull_request` and `pull_request_target`. A new branch or tag is
/// `push` and `create`; services/actions adds `create` for a `git.push`
/// with no `before`.
pub fn github_events(kind: &str) -> Vec<(&'static str, Option<&'static str>)> {
    let pull = |action| vec![("pull_request", Some(action)), ("pull_request_target", Some(action))];
    match kind {
        "git.push" => vec![("push", None)],
        "git.deleted" => vec![("delete", None)],
        "pull.opened" => pull("opened"),
        "pull.updated" => pull("synchronize"),
        "pull.ready" => pull("ready_for_review"),
        "pull.reopened" => pull("reopened"),
        "pull.converted_to_draft" => pull("converted_to_draft"),
        "pull.closed" | "pull.merged" => pull("closed"),
        "pull.assigned" => pull("assigned"),
        "pull.review_requested" => pull("review_requested"),
        "pull.review_request_removed" => pull("review_request_removed"),
        "pull.labeled" => pull("labeled"),
        "pull.unlabeled" => pull("unlabeled"),
        "pull.milestoned" => pull("milestoned"),
        "pull.demilestoned" => pull("demilestoned"),
        "pull.base_changed" | "pull.edited" => pull("edited"),
        "work_item.opened" => vec![("work_item", Some("opened"))],
        "work_item.updated" => vec![("work_item", Some("edited"))],
        "work_item.closed" => vec![("work_item", Some("closed"))],
        "work_item.reopened" => vec![("work_item", Some("reopened"))],
        "work_item.assigned" => vec![("work_item", Some("assigned"))],
        "work_item.labeled" => vec![("work_item", Some("labeled"))],
        "work_item.unlabeled" => vec![("work_item", Some("unlabeled"))],
        "work_item.milestoned" => vec![("work_item", Some("milestoned"))],
        "work_item.demilestoned" => vec![("work_item", Some("demilestoned"))],
        "work_item.planned" => vec![("work_item", Some("planned"))],
        "work_item.linked" => vec![("work_item", Some("linked"))],
        "work_item.unlinked" => vec![("work_item", Some("unlinked"))],
        "work_item.landed" => vec![("work_item", Some("landed"))],
        "comment.created" => vec![("work_item_comment", Some("created"))],
        "comment.edited" => vec![("work_item_comment", Some("edited"))],
        "comment.deleted" => vec![("work_item_comment", Some("deleted"))],
        "release.created" => vec![("release", Some("created"))],
        "release.published" => vec![("release", Some("published"))],
        "release.released" => vec![("release", Some("released"))],
        "release.prereleased" => vec![("release", Some("prereleased"))],
        "release.edited" => vec![("release", Some("edited"))],
        "release.unpublished" => vec![("release", Some("unpublished"))],
        "release.deleted" => vec![("release", Some("deleted"))],
        "deployment.created" => vec![("deployment", None)],
        "deployment_status.created" => vec![("deployment_status", Some("created"))],
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

    /// The owner's id, as the event's `repository.owner.id` gives it, or
    /// else the number for the owner's name ([`account_id`]).
    fn owner_id(&self) -> String {
        owner_id(&self.event).unwrap_or_else(|| match self.owner() {
            "" => String::new(),
            owner => account_id(owner).to_string(),
        })
    }

    /// `github.repository_id`: the repository's number ([`github_id`]).
    fn repository_number(&self) -> String {
        id_text(&self.repository_id)
    }

    /// `github.actor_id`: the actor's number, as the event's `sender.id`
    /// gives it ([`account_id`]).
    fn actor_number(&self) -> String {
        match self.actor.as_str() {
            "" => id_text(&self.actor_id),
            actor => account_id(actor).to_string(),
        }
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
            "actor_id": self.actor_number(),
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
            "repository_id": self.repository_number(),
            "repository_owner": self.owner(),
            "repository_owner_id": self.owner_id(),
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
        set("GITHUB_ACTOR_ID", self.actor_number());
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
        set("GITHUB_REPOSITORY_ID", self.repository_number());
        set("GITHUB_REPOSITORY_OWNER", self.owner().to_owned());
        set("GITHUB_REPOSITORY_OWNER_ID", self.owner_id());
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
        set("RUNNER_WORKSPACE", RUNNER_WORKSPACE.into());
        vars
    }
}

/// The whole number GitHub gives an object as its `id`, for a g1t id
/// (`rep_01kpw0…`, `pr_01…`): the same number every time, positive, and
/// below 2^53 so JavaScript reads it exactly. g1t's own id stays the
/// object's `node_id`.
pub fn github_id(id: &str) -> u64 {
    // FNV-1a, 64 bits, cut to 53.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in id.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (hash & ((1 << 53) - 1)).max(1)
}

/// The number of a person or workspace, by their name: usernames and
/// workspaces share one namespace, so `sender.id`, `user.id`,
/// `repository.owner.id`, `github.actor_id` and
/// `github.repository_owner_id` agree wherever the same name appears, and
/// a personal workspace's repositories are owned by its person's number,
/// as on GitHub. Case does not matter.
pub fn account_id(login: &str) -> u64 {
    github_id(&format!("account:{}", login.to_ascii_lowercase()))
}

/// An id as text of a number: one that is already a number as it is,
/// a g1t id as its [`github_id`], nothing as nothing.
fn id_text(id: &str) -> String {
    if id.is_empty() || id.bytes().all(|b| b.is_ascii_digit()) { id.to_owned() } else { github_id(id).to_string() }
}

/// The owner's id in a webhook-shaped payload, `repository.owner.id`, a
/// number or a string.
pub fn owner_id(event: &Value) -> Option<String> {
    match &event["repository"]["owner"]["id"] {
        Value::String(id) => Some(id.clone()),
        Value::Number(id) => Some(id.to_string()),
        _ => None,
    }
}

/// Where a job's repository is checked out, as on GitHub's runners.
pub const WORKSPACE: &str = "/home/runner/work/repo";

/// The folder the workspace is in, as GitHub's `RUNNER_WORKSPACE` is.
pub const RUNNER_WORKSPACE: &str = "/home/runner/work";

/// The `runner` context.
/// Whether a head commit's `message` asks, as GitHub lets it, that the
/// `push` and `pull_request` workflows it would start don't run: `[skip ci]`,
/// `[ci skip]`, `[no ci]`, `[skip actions]` or `[actions skip]` anywhere in
/// it, or a `skip-checks: true` trailer.
pub fn skips_ci(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    if ["[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]"].iter().any(|marker| lower.contains(marker)) {
        return true;
    }
    // Trailers are the last paragraph, after a blank line.
    let trimmed = lower.trim_end();
    let Some((_, trailers)) = trimmed.rsplit_once("\n\n") else { return false };
    trailers.lines().any(|line| line.split_once(':').is_some_and(|(key, value)| key.trim() == "skip-checks" && value.trim() == "true"))
}

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
        assert_eq!(github_events("git.deleted"), [("delete", None)]);
        assert_eq!(github_events("pull.labeled")[1], ("pull_request_target", Some("labeled")));
        assert_eq!(github_events("pull.assigned")[0], ("pull_request", Some("assigned")));
        assert_eq!(github_events("work_item.unlabeled"), [("work_item", Some("unlabeled"))]);
        assert_eq!(github_events("work_item.assigned"), [("work_item", Some("assigned"))]);
        assert_eq!(github_events("work_item.updated"), [("work_item", Some("edited"))]);
        assert_eq!(github_events("work_item.linked"), [("work_item", Some("linked"))]);
        assert_eq!(github_events("work_item.landed"), [("work_item", Some("landed"))]);
        assert_eq!(github_events("work_item.planned"), [("work_item", Some("planned"))]);
        assert!(github_events("issue.opened").is_empty());
        assert_eq!(github_events("pull.updated")[0], ("pull_request", Some("synchronize")));
        assert_eq!(github_events("pull.merged")[1], ("pull_request_target", Some("closed")));
        assert_eq!(github_events("comment.created"), [("work_item_comment", Some("created"))]);
        assert_eq!(github_events("work_item.labeled"), [("work_item", Some("labeled"))]);
        assert_eq!(github_events("pull.unlabeled")[0], ("pull_request", Some("unlabeled")));
        assert_eq!(github_events("pull.milestoned")[1], ("pull_request_target", Some("milestoned")));
        assert_eq!(github_events("pull.base_changed")[0], ("pull_request", Some("edited")));
        assert_eq!(github_events("pull.edited")[0], ("pull_request", Some("edited")));
        assert_eq!(github_events("pull.reopened")[0], ("pull_request", Some("reopened")));
        assert_eq!(github_events("pull.converted_to_draft")[1], ("pull_request_target", Some("converted_to_draft")));
        assert_eq!(github_events("comment.edited"), [("work_item_comment", Some("edited"))]);
        assert_eq!(github_events("comment.deleted"), [("work_item_comment", Some("deleted"))]);
        assert_eq!(github_events("release.published"), [("release", Some("published"))]);
        assert_eq!(github_events("release.prereleased"), [("release", Some("prereleased"))]);
        assert_eq!(github_events("deployment_status.created"), [("deployment_status", Some("created"))]);
        assert_eq!(github_events("deployment.created"), [("deployment", None)]);
        // g1t.page's own deployment outcomes are the inbox's, not a GitHub event.
        assert!(github_events("deployment.succeeded").is_empty());
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
        assert_eq!(vars["RUNNER_WORKSPACE"], "/home/runner/work");
        assert_eq!(vars["GITHUB_REPOSITORY_OWNER_ID"], account_id("acme").to_string());
    }

    #[test]
    fn ids_are_whole_numbers_as_on_github() {
        let id = github_id("rep_01kpw0abcdefghjkmnpqrstvwx");
        assert_eq!(id, github_id("rep_01kpw0abcdefghjkmnpqrstvwx"), "the same every time");
        assert!(id > 0 && id < 1 << 53, "a safe integer in JavaScript");
        assert_ne!(id, github_id("rep_01kpw0abcdefghjkmnpqrstvwy"));
        assert_eq!(account_id("Ada"), account_id("ada"));
        assert_ne!(account_id("ada"), github_id("ada"));
        let info = RunInfo {
            repository: "acme/web".into(),
            repository_id: "rep_1".into(),
            actor: "ada".into(),
            actor_id: "usr_1".into(),
            ..RunInfo::default()
        };
        let github = info.context("build", "", None);
        assert_eq!(github["repository_id"], github_id("rep_1").to_string());
        assert_eq!(github["actor_id"], account_id("ada").to_string());
        assert_eq!(github["repository_owner_id"], account_id("acme").to_string());
        let vars = info.variables("build");
        assert_eq!(vars["GITHUB_REPOSITORY_ID"], github["repository_id"]);
        assert_eq!(vars["GITHUB_ACTOR_ID"], github["actor_id"]);
        assert!(vars["GITHUB_REPOSITORY_ID"].as_str().unwrap().bytes().all(|b| b.is_ascii_digit()));
        // A number already is one.
        assert_eq!(RunInfo { repository_id: "42".into(), ..RunInfo::default() }.context("", "", None)["repository_id"], "42");
    }

    #[test]
    fn the_owners_id_comes_from_the_event() {
        let info =
            RunInfo { repository: "acme/web".into(), event: json!({ "repository": { "owner": { "id": 42 } } }), ..RunInfo::default() };
        assert_eq!(info.variables("build")["GITHUB_REPOSITORY_OWNER_ID"], "42");
        assert_eq!(info.context("build", "", None)["repository_owner_id"], "42");
        assert_eq!(owner_id(&json!({ "repository": { "owner": { "id": "ws_1" } } })).as_deref(), Some("ws_1"));
        assert_eq!(owner_id(&json!({})), None);
    }
}

#[cfg(test)]
mod skip_tests {
    use super::skips_ci;

    #[test]
    fn a_commit_can_skip_its_runs_as_on_github() {
        for message in [
            "Fix typo [skip ci]",
            "[ci skip] docs",
            "Notes [no ci]",
            "x [skip actions]",
            "[Actions Skip]",
            "Tidy\n\nskip-checks: true",
            "Tidy\n\nSigned-off-by: A <a@b>\nskip-checks:true\n",
        ] {
            assert!(skips_ci(message), "{message:?}");
        }
        for message in
            ["Fix the skip ci flag", "skip-checks: true", "Tidy\n\nskip-checks: false", "[skip-ci]", "Tidy\n\nskip-checks: true\n\nMore"]
        {
            assert!(!skips_ci(message), "{message:?}");
        }
    }
}
