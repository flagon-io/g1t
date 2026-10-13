//! Live repository pages: what the notify service is told when something
//! happens in a repository, so the pages open on it refresh themselves.
//!
//! The events service tells it of every event a repository page shows
//! (`repo_changed`, with [`change_of`] for each), and the actions service
//! of a run's jobs starting and finishing, which are not events. Notify
//! passes each change to the people watching that repository's pages: a
//! tab on one asks to (`watch_repo`, through the site, which checks they
//! may read it first). See docs.g1t.sh/guides/notifications/, "Pages that
//! update live".
//!
//! A change says only what kind of thing moved and where: never a title, a
//! body, a name or anything else written in the repository.

use serde::{Deserialize, Serialize};

use crate::events::Event;

/// The notify service's method that takes [`RepoChangedArgs`].
pub const REPO_CHANGED: &str = "repo_changed";

/// What a run's job starting or finishing is told as: not an event, as
/// nothing else hears of it.
pub const RUN_UPDATED: &str = "run.updated";

/// The most changes one call carries; a busier batch sends the rest in more.
pub const MAX_CHANGES: usize = 200;

/// Something that happened in a repository, as live pages hear of it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoChange {
    pub repo_id: String,
    /// The event's type (`git.push`, `pull.updated`, `checks.completed`, …),
    /// or [`RUN_UPDATED`].
    pub kind: String,
    /// The full ref a push or deletion moved (`refs/heads/main`), or a run's.
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    /// The issue or pull request it is on, or the pull request a run ran for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    /// The commit: where a push left its ref, the one checked or reported on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    /// A workflow run's id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    /// How many commits a push brought to its branch, when it was counted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commits: Option<u32>,
    /// RFC 3339.
    pub at: String,
}

/// `repo_changed`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RepoChangedArgs {
    pub changes: Vec<RepoChange>,
}

/// The events a repository page shows: exact types, and families ending
/// in a dot. Anything else (reads, fetches, settings, audit) changes no
/// page anyone is looking at.
const LIVE: [&str; 28] = [
    "git.push",
    "git.deleted",
    "branch.renamed",
    "repo.default_branch_changed",
    "pull.",
    "issue.",
    "comment.",
    "review.",
    "checks.",
    "check_run.",
    "check_suite.",
    "status.created",
    "workflow.",
    "release.",
    "queue.changed",
    "deployment.",
    "deployment_status.",
    "secret_scanning_alert.",
    "code_scanning_alert.",
    "vulnerability_alert.",
    // Coordinating work: the issue, pull request and Work pages show them.
    "work.",
    "session.started",
    "session.ended",
    // A session recorded more: at most every few seconds each, for the
    // pages showing it (not every entry, which `session.appended` is).
    "session.progressed",
    "dependency.changed",
    "overlap.detected",
    "integration.",
    "decision.recorded",
];

/// Whether an event of type `kind` changes a repository page.
pub fn is_live(kind: &str) -> bool {
    LIVE.iter().any(|live| if live.ends_with('.') { kind.starts_with(live) } else { kind == *live })
}

fn text(value: &serde_json::Value) -> Option<String> {
    value.as_str().filter(|text| !text.is_empty()).map(|text| text.chars().take(200).collect())
}

fn number(value: &serde_json::Value) -> Option<u32> {
    value.as_u64().and_then(|n| u32::try_from(n).ok())
}

/// What live pages hear of an event, or None when it is not about a
/// repository or changes no page.
pub fn change_of(event: &Event) -> Option<RepoChange> {
    if !is_live(&event.kind) {
        return None;
    }
    let data = &event.data;
    let repo_id = event.repo_id.clone().filter(|id| !id.is_empty()).or_else(|| text(&data["repoId"]))?;
    let family = event.kind.split('.').next().unwrap_or_default();
    let mut change = RepoChange { repo_id, kind: event.kind.clone(), at: event.time.clone(), ..RepoChange::default() };
    match family {
        "git" => {
            change.git_ref = text(&data["ref"]);
            change.sha = text(&data["after"]);
            change.commits = number(&data["commits"]);
        }
        "workflow" => {
            change.git_ref = text(&data["ref"]);
            change.sha = text(&data["sha"]);
            change.run = text(&data["runId"]);
            change.number = number(&data["pull"]);
        }
        "checks" => {
            change.number = number(&data["number"]);
            change.sha = text(&data["commit"]);
        }
        "status" => change.sha = text(&data["sha"]),
        "check_run" => change.sha = text(&data["checkRun"]["headSha"]),
        "check_suite" => change.sha = text(&data["checkSuite"]["headSha"]),
        "code_scanning_alert" => change.number = number(&data["alertNumber"]),
        "secret_scanning_alert" | "vulnerability_alert" | "release" | "queue" | "deployment" | "deployment_status" | "repo" | "branch" => {}
        // Issues, pull requests, comments and reviews name their number.
        _ => change.number = number(&data["number"]),
    }
    Some(change)
}

/// The changes a batch of events makes, in order, in calls of at most
/// [`MAX_CHANGES`].
pub fn changes_of(events: &[Event]) -> Vec<Vec<RepoChange>> {
    let changes: Vec<RepoChange> = events.iter().filter_map(change_of).collect();
    changes.chunks(MAX_CHANGES).map(<[RepoChange]>::to_vec).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(kind: &str, repo_id: Option<&str>, data: serde_json::Value) -> Event {
        Event {
            id: "evt_1".into(),
            kind: kind.into(),
            source: "test".into(),
            time: "2026-10-11T10:00:00Z".into(),
            repo_id: repo_id.map(Into::into),
            actor: Some("usr_1".into()),
            data,
        }
    }

    #[test]
    fn a_push_says_its_ref_where_it_went_and_how_many_commits() {
        let push = event(
            "git.push",
            Some("rep_1"),
            json!({ "repoId": "rep_1", "ref": "refs/heads/main", "before": "a", "after": "b", "defaultBranch": true, "commits": 3 }),
        );
        assert_eq!(
            change_of(&push),
            Some(RepoChange {
                repo_id: "rep_1".into(),
                kind: "git.push".into(),
                git_ref: Some("refs/heads/main".into()),
                sha: Some("b".into()),
                commits: Some(3),
                at: "2026-10-11T10:00:00Z".into(),
                ..RepoChange::default()
            })
        );
    }

    #[test]
    fn pull_requests_issues_comments_and_checks_name_their_number() {
        for kind in ["pull.updated", "pull.merged", "issue.closed", "comment.created", "review.completed"] {
            let change = change_of(&event(kind, Some("rep_1"), json!({ "number": 7, "title": "secret plans" }))).unwrap();
            assert_eq!(change.number, Some(7), "{kind}");
        }
        let checks = change_of(&event("checks.completed", Some("rep_1"), json!({ "number": 4, "commit": "abc", "status": "passed" }))).unwrap();
        assert_eq!((checks.number, checks.sha.as_deref()), (Some(4), Some("abc")));
    }

    #[test]
    fn runs_name_their_id_commit_and_pull_request() {
        let run = change_of(&event(
            "workflow.completed",
            Some("rep_1"),
            json!({ "runId": "run_9", "number": 12, "ref": "refs/heads/x", "sha": "def", "pull": 5, "conclusion": "success" }),
        ))
        .unwrap();
        assert_eq!(run.run.as_deref(), Some("run_9"));
        assert_eq!(run.number, Some(5), "the pull request, not the run's own number");
        assert_eq!(run.sha.as_deref(), Some("def"));
        let status = change_of(&event("status.created", Some("rep_1"), json!({ "sha": "def", "context": "ci", "state": "pending" }))).unwrap();
        assert_eq!(status.sha.as_deref(), Some("def"));
        let check = change_of(&event("check_run.completed", Some("rep_1"), json!({ "checkRun": { "headSha": "fff" } }))).unwrap();
        assert_eq!(check.sha.as_deref(), Some("fff"));
    }

    #[test]
    fn nothing_written_in_the_repository_goes_along() {
        let change = change_of(&event("issue.opened", Some("rep_1"), json!({ "number": 1, "title": "Leaked title", "body": "Leaked body" }))).unwrap();
        let sent = serde_json::to_string(&change).unwrap();
        assert!(!sent.contains("Leaked"));
        assert_eq!(sent, r#"{"repo_id":"rep_1","kind":"issue.opened","number":1,"at":"2026-10-11T10:00:00Z"}"#);
    }

    #[test]
    fn only_what_a_page_shows_and_only_with_a_repository() {
        assert!(change_of(&event("git.fetch", Some("rep_1"), json!({}))).is_none());
        assert!(change_of(&event("repo.collaborator_added", Some("rep_1"), json!({}))).is_none());
        assert!(change_of(&event("pull.opened", None, json!({ "number": 1 }))).is_none());
        // The repository from the data when the event has none.
        assert_eq!(change_of(&event("pull.opened", None, json!({ "repoId": "rep_2", "number": 1 }))).unwrap().repo_id, "rep_2");
        for kind in ["git.push", "git.deleted", "release.published", "secret_scanning_alert.created", "queue.changed", "deployment_status.created"] {
            assert!(is_live(kind), "{kind}");
        }
        for kind in ["git.pushed", "repo.created", "user.deleted", "workspace.renamed"] {
            assert!(!is_live(kind), "{kind}");
        }
    }

    #[test]
    fn coordination_names_the_issue_or_pull_request_it_is_about() {
        for kind in ["work.claimed", "work.claim_expired", "session.started", "dependency.changed", "overlap.detected", "integration.failed", "integration.passed", "decision.recorded"] {
            let change = change_of(&event(kind, None, json!({ "repoId": "rep_1", "number": 12, "issue": 4 }))).unwrap();
            assert_eq!((change.repo_id.as_str(), change.number), ("rep_1", Some(12)), "{kind}");
        }
        // Each recorded step of a session changes no page anyone is watching live.
        assert!(change_of(&event("session.appended", Some("rep_1"), json!({ "number": 12 }))).is_none());
        // Its progress, at most every few seconds, does: the session's page follows it.
        let progressed = change_of(&event("session.progressed", None, json!({ "repoId": "rep_1", "number": 12, "sessionId": "ses_1" }))).unwrap();
        assert_eq!((progressed.kind.as_str(), progressed.number), ("session.progressed", Some(12)));
    }

    #[test]
    fn a_busy_batch_goes_in_several_calls() {
        let events: Vec<Event> = (0..450).map(|n| event("pull.updated", Some("rep_1"), json!({ "number": n }))).collect();
        let calls = changes_of(&events);
        assert_eq!(calls.iter().map(Vec::len).collect::<Vec<_>>(), vec![200, 200, 50]);
        assert!(changes_of(&[event("git.fetch", Some("rep_1"), json!({}))]).is_empty());
    }
}
