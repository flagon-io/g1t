//! `github.event`: the webhook-shaped payload GitHub gives a workflow,
//! built from g1t's own records so `github.event.pull_request.number`,
//! `github.event.pull_request.labels.*.name` and the like read as they do
//! there. g1t's `work_item` and `work_item_comment` events give
//! `github.event.work_item`, shaped as GitHub's `issue` is, with the
//! workspace and the repositories it is linked to.
//!
//! Ids are as GitHub's are: `id` a whole number, the same for an object
//! wherever it appears ([`github_id`] of its g1t id, [`account_id`] of a
//! person's or workspace's name), and `node_id` g1t's own id. What g1t's
//! API addresses by its own id keeps that id as `id`, so a payload's id
//! can be passed straight back to the API: a comment (`PATCH
//! /workspaces/{workspace}/work/comments/{comment_id}`), a release, a
//! deployment and its statuses, and a workflow run.

use g1t_actions::events::{account_id, github_id};
use g1t_contracts::{PrincipalKind, User};
use g1t_contracts::repos::{Commit, Repo, RepoPath};
use g1t_contracts::repos::FileStatus;
use g1t_contracts::work::{Comment, DEFAULT_LABELS, Label, MilestoneRef, Pull, PullStatus, State, WorkItem, label_color_for};
use serde_json::{Value, json};

use crate::{API, SITE};

/// The commit hash GitHub gives for no commit: a branch made or deleted.
pub const ZERO: &str = "0000000000000000000000000000000000000000";

/// A repository's owner, as a workspace (an `Organization`). A personal
/// workspace's repositories are owned by a `User` instead: see
/// [`owned_by_person`].
fn owner(login: &str) -> Value {
    json!({
        "login": login,
        "id": account_id(login),
        "type": "Organization",
        "html_url": format!("{SITE}/{login}"),
        "url": format!("{API}/users/{login}"),
    })
}

pub fn repository(repo: &Repo) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let mut repository = json!({
        "id": github_id(&repo.id),
        "node_id": repo.id,
        "name": repo.name,
        "full_name": full_name,
        "private": repo.is_private,
        "owner": owner(&repo.namespace),
        "html_url": format!("{SITE}/{full_name}"),
        "url": format!("{API}/repos/{full_name}"),
        "clone_url": format!("{SITE}/{full_name}.git"),
        // GitHub's field: a repository has no description of its own (its
        // project does), so it is always null.
        "description": Value::Null,
        "homepage": repo.website,
        "topics": repo.topics,
        "default_branch": repo.default_branch,
        // A repository someone forked into their workspace; a pull
        // request's own working copy is never a run's repository.
        "fork": repo.parent_id.is_some(),
        "archived": repo.archived(),
        "created_at": repo.created_at,
        "visibility": if repo.is_private { "private" } else { "public" },
    });
    // Where a fork came from, when its reader may see it.
    if let Some(parent) = &repo.parent {
        let full_name = format!("{}/{}", parent.namespace, parent.name);
        repository["parent"] = json!({
            "id": repo.parent_id.as_deref().map(github_id),
            "node_id": repo.parent_id,
            "name": parent.name,
            "full_name": full_name,
            "owner": owner(&parent.namespace),
            "html_url": format!("{SITE}/{full_name}"),
            "url": format!("{API}/repos/{full_name}"),
            "clone_url": format!("{SITE}/{full_name}.git"),
        });
    }
    repository
}

/// A pull request's fork, from what the pull request knows of it.
fn fork_repository(fork: &RepoPath, id: Option<&str>) -> Value {
    let full_name = format!("{}/{}", fork.namespace, fork.name);
    json!({
        "id": id.map(github_id),
        "node_id": id,
        "name": fork.name,
        "full_name": full_name,
        "owner": owner(&fork.namespace),
        "html_url": format!("{SITE}/{full_name}"),
        "url": format!("{API}/repos/{full_name}"),
        "clone_url": format!("{SITE}/{full_name}.git"),
        "fork": true,
    })
}

/// Marks the owner of `namespace`'s repositories as a `User` everywhere
/// in a payload: for a personal workspace, whose name is its person's.
pub fn owned_by_person(payload: &mut Value, namespace: &str) {
    match payload {
        Value::Object(map) => {
            if map.get("login").and_then(Value::as_str).is_some_and(|login| login.eq_ignore_ascii_case(namespace))
                && map.get("type").and_then(Value::as_str) == Some("Organization")
            {
                map.insert("type".into(), json!("User"));
            }
            map.values_mut().for_each(|value| owned_by_person(value, namespace));
        }
        Value::Array(items) => items.iter_mut().for_each(|value| owned_by_person(value, namespace)),
        _ => {}
    }
}

pub fn user(login: &str) -> Value {
    json!({
        "login": login,
        "id": account_id(login),
        "type": "User",
        "html_url": format!("{SITE}/{login}"),
        "url": format!("{API}/users/{login}"),
    })
}

/// Someone as GitHub names them. g1t, the author of what it makes and
/// files, is a `Bot`, as an app is there.
fn person(user: &User) -> Value {
    let mut named = self::user(&user.username);
    named["node_id"] = json!(user.id);
    if matches!(user.kind, PrincipalKind::Agent | PrincipalKind::System) {
        named["type"] = json!("Bot");
    }
    named
}

fn people(logins: &[String]) -> Vec<Value> {
    logins.iter().map(|login| user(login)).collect()
}

fn labels(repo: &Repo, names: &[String]) -> Value {
    Value::Array(names.iter().map(|name| label(repo, name, None)).collect())
}

/// A label, by its name in `repo`'s workspace, which keeps the labels of
/// all its repositories. Its `color` is the one g1t gives a label of that
/// name until [`color_labels`] sets the workspace's own; `default` is
/// whether it is one of the labels a workspace starts with.
fn label(repo: &Repo, name: &str, color: Option<&Value>) -> Value {
    json!({
        "id": github_id(&format!("{}:label:{name}", repo.owner_id)),
        "node_id": format!("{}:label:{name}", repo.owner_id),
        "name": name,
        "color": color.filter(|c| c.is_string()).cloned().unwrap_or_else(|| json!(label_color_for(name))),
        "description": DEFAULT_LABELS.iter().find(|(known, _, _)| *known == name).map(|(_, _, about)| *about),
        "default": DEFAULT_LABELS.iter().any(|(known, _, _)| *known == name),
    })
}

/// Gives every label in a payload (`labels[]` and `label`) the color and
/// description the workspace has for it (work's `list_labels`).
pub fn color_labels(payload: &mut Value, known: &[Label]) {
    fn set(label: &mut Value, known: &[Label]) {
        let Some(found) = label["name"].as_str().and_then(|name| known.iter().find(|k| k.name == name)) else { return };
        label["color"] = json!(found.color);
        label["description"] = if found.description.is_empty() { Value::Null } else { json!(found.description) };
    }
    if let Value::Object(map) = payload {
        for (key, value) in map.iter_mut() {
            match (key.as_str(), value) {
                ("labels", Value::Array(labels)) => labels.iter_mut().for_each(|label| set(label, known)),
                ("label", label @ Value::Object(_)) => set(label, known),
                (_, value) => color_labels(value, known),
            }
        }
    }
}

/// Whether a payload has any label, so its colors are worth reading.
pub fn has_labels(payload: &Value) -> bool {
    match payload {
        Value::Object(map) => map.iter().any(|(key, value)| match (key.as_str(), value) {
            ("labels", Value::Array(labels)) => !labels.is_empty(),
            ("label", Value::Object(_)) => true,
            (_, value) => has_labels(value),
        }),
        _ => false,
    }
}

/// A milestone as a work item or a pull request names it: one of the
/// workspace's.
fn milestone(repo: &Repo, milestone: Option<&MilestoneRef>) -> Value {
    milestone.map_or(Value::Null, |milestone| milestone_of(repo, milestone.number, &json!(milestone.title)))
}

fn milestone_of(repo: &Repo, number: u32, title: &Value) -> Value {
    json!({
        "id": github_id(&format!("{}:milestone:{number}", repo.owner_id)),
        "number": number,
        "title": title,
        "html_url": format!("{SITE}/{}/-/work/milestones/{number}", repo.namespace),
    })
}

pub fn commit(repo: &Repo, commit: &Commit) -> Value {
    json!({
        "id": commit.hash,
        "tree_id": commit.tree_hash,
        "message": commit.message,
        "timestamp": commit.authored_at,
        "url": format!("{SITE}/{}/{}/commit/{}", repo.namespace, repo.name, commit.hash),
        "author": { "name": commit.author.name, "email": commit.author.email },
        "committer": { "name": commit.author.name, "email": commit.author.email },
        "distinct": true,
        "added": [],
        "removed": [],
        "modified": [],
    })
}

/// Sets a one-commit push's `added`, `removed` and `modified` (on its
/// commit and `head_commit`) from what the push changed, compared as its
/// `paths` filters are. A push of several commits keeps them empty: the
/// comparison is of the whole push, not of each commit.
pub fn push_changes(payload: &mut Value, changes: &[(String, FileStatus)]) {
    if payload["commits"].as_array().map(Vec::len) != Some(1) {
        return;
    }
    let of = |status: FileStatus| -> Value {
        changes.iter().filter(|(_, s)| *s == status).map(|(path, _)| json!(path)).collect::<Vec<_>>().into()
    };
    for commit in ["commits", "head_commit"] {
        let commit = if commit == "commits" { &mut payload["commits"][0] } else { &mut payload["head_commit"] };
        commit["added"] = of(FileStatus::Added);
        commit["removed"] = of(FileStatus::Deleted);
        commit["modified"] = of(FileStatus::Modified);
    }
}

/// A push. `forced` is whether `before` is not in `after`'s history, when
/// that is known; a push whose history is too long to read says `false`.
/// `pusher_email` is the pusher's noreply address, when the push was a
/// person's.
#[allow(clippy::too_many_arguments)]
pub fn push(
    repo: &Repo,
    git_ref: &str,
    before: Option<&str>,
    after: &str,
    commits: &[Commit],
    pusher: &str,
    pusher_email: Option<&str>,
    forced: bool,
) -> Value {
    let before = before.unwrap_or(ZERO);
    let created = before == ZERO;
    let deleted = after == ZERO;
    let commits: Vec<Value> = commits.iter().map(|c| commit(repo, c)).collect();
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let compare = if created {
        format!("{SITE}/{full_name}/commit/{after}")
    } else {
        format!("{SITE}/{full_name}/compare/{before}...{after}")
    };
    json!({
        "ref": git_ref,
        "before": before,
        "after": after,
        "created": created,
        "deleted": deleted,
        "forced": forced && !created && !deleted,
        "base_ref": null,
        "compare": compare,
        // GitHub's head commit is the one pushed: the last.
        "head_commit": commits.last().cloned().unwrap_or(Value::Null),
        "commits": commits,
        "pusher": { "name": pusher, "email": pusher_email },
        "repository": repository(repo),
        "sender": user(pusher),
    })
}

/// Where a work item is on g1t.sh, and in the API.
fn work_item_urls(workspace: &str, number: u32) -> (String, String) {
    (format!("{SITE}/{workspace}/-/work/{number}"), format!("{API}/workspaces/{workspace}/work/{number}"))
}

/// A work item, as `github.event.work_item`: GitHub's `issue`, with g1t's
/// own fields beside it: its `workspace`, the `repos` it is linked to (each
/// with its role and whether the work landed there), what resolved it,
/// and what it is blocked by. `repo` is the run's repository, which is one
/// of them.
pub fn work_item(repo: &Repo, item: &WorkItem) -> Value {
    let (html_url, url) = work_item_urls(&item.workspace, item.number);
    let repos: Vec<Value> = item
        .repos
        .iter()
        .map(|linked| {
            json!({
                "id": github_id(&linked.repo_id),
                "node_id": linked.repo_id,
                "full_name": linked.path,
                "role": linked.role.as_str(),
                "legacy_number": linked.legacy_number,
                "landed": linked.landed,
            })
        })
        .collect();
    let resolutions: Vec<Value> = item.resolutions.iter().map(resolution).collect();
    json!({
        "id": github_id(&item.id),
        "node_id": item.id,
        "number": item.number,
        "title": item.title,
        "body": item.body,
        "state": if item.state == State::Open { "open" } else { "closed" },
        "state_reason": item.reason,
        "locked": false,
        "labels": labels(repo, &item.labels),
        "milestone": milestone(repo, item.milestone.as_ref()),
        "user": person(&item.author),
        // g1t's own field: for one its agent filed, who it worked for.
        "requested_by": item.requested_by.as_ref().map(person),
        "assignee": item.assignees.first().map(|a| user(a)),
        "assignees": people(&item.assignees),
        "comments": item.comment_count,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
        "closed_at": item.closed_at,
        "html_url": html_url,
        "url": url,
        "workspace": item.workspace,
        "workspace_url": format!("{API}/workspaces/{}", item.workspace),
        "repos": repos,
        "resolutions": resolutions,
        "blocked_by": item.blocked_by,
        "pull_count": item.pull_count,
    })
}

/// What resolved a work item in one repository, as the payload names it.
fn resolution(resolution: &g1t_contracts::work::Resolution) -> Value {
    json!({
        "repository": resolution.repo,
        "pull": resolution.pull,
        "commit": resolution.commit,
        "pushed_by": resolution.pushed_by.as_deref().map(user),
    })
}

/// What a `work_item` event says besides the item: on `linked` and
/// `unlinked`, the repository and its role (`link`); on `landed` and on a
/// close a landing caused, what landed (`resolution`) and the targets it
/// has still to land in (`missing`).
pub fn work_item_changed(payload: &mut Value, data: &Value) {
    if let Some(path) = data["repo"].as_str() {
        payload["link"] = json!({ "repository": path, "role": data["role"] });
    }
    if let Ok(landed) = serde_json::from_value::<g1t_contracts::work::Resolution>(data["resolution"].clone()) {
        payload["resolution"] = resolution(&landed);
    }
    if let Some(missing) = data.get("missing").filter(|missing| missing.is_array()) {
        payload["missing"] = missing.clone();
    }
}

/// A pull request, with its own labels. `base.sha` is the pull request's
/// merge base until the trigger sets the base branch's tip, as GitHub
/// gives it (trigger.rs).
pub fn pull(repo: &Repo, pull: &Pull) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let head_ref = head_ref(pull);
    let base_ref = pull.base_branch(&repo.default_branch);
    // A working copy, or the fork its branch is in, or the repository.
    let elsewhere = match (&pull.fork, &pull.head_repo) {
        (Some(fork), _) => Some((fork, pull.fork_repo_id.as_deref())),
        (None, Some(fork)) => Some((fork, pull.head_repo_id.as_deref())),
        (None, None) => None,
    };
    let (head_repo, head_owner) = match elsewhere {
        Some((fork, id)) => (fork_repository(fork, id), fork.namespace.as_str()),
        None => (repository(repo), repo.namespace.as_str()),
    };
    let merged = pull.status == PullStatus::Merged;
    let closed_at = match pull.status {
        PullStatus::Merged => pull.merged_at.clone(),
        PullStatus::Closed => Some(pull.updated_at.clone()),
        _ => None,
    };
    json!({
        "id": github_id(&pull.id),
        "node_id": pull.id,
        "number": pull.number,
        "title": pull.title,
        "body": pull.body,
        "state": if pull.status.is_active() { "open" } else { "closed" },
        "locked": false,
        "draft": pull.status == PullStatus::Draft,
        "merged": merged,
        "merged_at": pull.merged_at,
        "merged_by": pull.merged_by.as_deref().map(user),
        // Only once merged, as on GitHub; the trigger sets the commit it
        // landed as when the event says.
        "merge_commit_sha": if merged { pull.head_commit.clone() } else { None },
        "labels": labels(repo, &pull.labels),
        "milestone": milestone(repo, pull.milestone.as_ref()),
        "user": person(&pull.author),
        // g1t's own field: for a change g1t made, who asked for it.
        "requested_by": pull.requested_by.as_ref().map(person),
        "assignee": pull.assignees.first().map(|a| user(a)),
        "assignees": people(&pull.assignees),
        "requested_reviewers": people(&pull.reviewers),
        "head": {
            "ref": head_ref,
            "sha": pull.head_commit,
            "label": format!("{head_owner}:{head_ref}"),
            "user": owner(head_owner),
            "repo": head_repo,
        },
        "base": {
            "ref": base_ref,
            "sha": pull.merge_base,
            "label": format!("{}:{base_ref}", repo.namespace),
            "user": owner(&repo.namespace),
            "repo": repository(repo),
        },
        "changed_files": pull.files.len(),
        "additions": pull.files.iter().map(|f| u64::from(f.additions)).sum::<u64>(),
        "deletions": pull.files.iter().map(|f| u64::from(f.deletions)).sum::<u64>(),
        "created_at": pull.created_at,
        "updated_at": pull.updated_at,
        "closed_at": closed_at,
        "html_url": format!("{SITE}/{full_name}/pull/{}", pull.number),
        "url": format!("{API}/repos/{full_name}/pulls/{}", pull.number),
        // g1t's own: the work item it is for, by its number in the
        // repository's workspace, and those it closes and is part of.
        "item": pull.item,
        "item_url": pull.item.map(|number| work_item_urls(&repo.namespace, number).1),
        "closes": pull.closes,
        "parts": pull.parts,
    })
}

/// What a `labeled`, `unlabeled`, `milestoned`, `demilestoned`,
/// `assigned` or base change was about, from the g1t event: `label`,
/// `milestone`, `assignee` (the first of those newly assigned; g1t sends
/// one event for them all, GitHub one each), and for a new base,
/// `changes.base.ref.from` is not known, so only the new base is in
/// `pull_request.base`.
pub fn changed(repo: &Repo, payload: &mut Value, data: &Value) {
    if let Some(first) = data["added"].as_array().and_then(|added| added.first()).and_then(Value::as_str) {
        payload["assignee"] = user(first);
    }
    if let Some(found) = data.get("label").filter(|label| label.is_object()) {
        payload["label"] = label(repo, found["name"].as_str().unwrap_or_default(), Some(&found["color"]));
    }
    if let Some(found) = data.get("milestone").filter(|milestone| milestone.is_object()) {
        payload["milestone"] = match found["number"].as_u64() {
            Some(number) => milestone_of(repo, number as u32, &found["title"]),
            None => json!({ "number": found["number"], "title": found["title"] }),
        };
    }
    // `edited`: what its title or description was before.
    if let Some(changes) = data.get("changes").filter(|changes| changes.is_object()) {
        payload["changes"] = changes.clone();
    }
}

/// The branch a pull request comes from, or a name for its fork.
pub fn head_ref(pull: &Pull) -> String {
    pull.branch.clone().unwrap_or_else(|| format!("pull/{}", pull.number))
}

/// What a comment is on: a work item of a workspace, or a pull request of
/// the run's repository.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Thread<'a> {
    Item { workspace: &'a str },
    Pull,
}

impl Thread<'_> {
    /// Where the thread numbered `number` is on g1t.sh, and in the API.
    fn urls(self, repo: &Repo, number: u32) -> (String, String) {
        match self {
            Thread::Item { workspace } => work_item_urls(workspace, number),
            Thread::Pull => {
                let full_name = format!("{}/{}", repo.namespace, repo.name);
                (format!("{SITE}/{full_name}/pull/{number}"), format!("{API}/repos/{full_name}/pulls/{number}"))
            }
        }
    }

    /// Where the API edits and deletes a comment on it, by its id.
    fn comment_url(self, repo: &Repo, id: &str) -> String {
        let workspace = match self {
            Thread::Item { workspace } => workspace,
            Thread::Pull => &repo.namespace,
        };
        format!("{API}/workspaces/{workspace}/work/comments/{id}")
    }
}

/// A comment. Its `id` is g1t's (`cmt_…`), as the API takes it back to
/// edit or delete it.
pub fn comment(repo: &Repo, number: u32, comment: &Comment, on: Thread) -> Value {
    let (html_url, item_url) = on.urls(repo, number);
    json!({
        "id": comment.id,
        "node_id": comment.id,
        "body": comment.body,
        "user": person(&comment.author),
        "created_at": comment.created_at,
        "updated_at": comment.edited_at.as_deref().unwrap_or(&comment.created_at),
        "path": comment.path,
        "line": comment.line,
        "html_url": format!("{html_url}#{}", comment.id),
        "url": on.comment_url(repo, &comment.id),
        "item_url": item_url,
    })
}

/// A review, for `pull_request_review`: g1t keeps a review as a comment
/// with a verdict, and its id is that comment's.
pub fn review(repo: &Repo, pull: &Pull, review: Option<&Comment>) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let Some(review) = review else {
        return json!({ "state": null, "body": null, "user": null });
    };
    json!({
        "id": github_id(&review.id),
        "node_id": review.id,
        "state": review.verdict.map(review_state),
        "body": review.body,
        "user": person(&review.author),
        "commit_id": pull.head_commit,
        "submitted_at": review.created_at,
        "html_url": format!("{SITE}/{full_name}/pull/{}#{}", pull.number, review.id),
        "pull_request_url": format!("{API}/repos/{full_name}/pulls/{}", pull.number),
    })
}

/// A pull request as `work_item_comment` gives it in `work_item`, as
/// GitHub's `issue_comment` gives one in `issue`: the pull request's
/// number and title, with `pull_request` set. Its id is not the pull
/// request's, as on GitHub, where the two are different objects.
pub fn pull_as_item(repo: &Repo, pull: &Pull) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    json!({
        "id": github_id(&format!("item:{}", pull.id)),
        "node_id": pull.id,
        "number": pull.number,
        "title": pull.title,
        "body": pull.body,
        "state": if pull.status.is_active() { "open" } else { "closed" },
        "locked": false,
        "draft": pull.status == PullStatus::Draft,
        "labels": labels(repo, &pull.labels),
        "milestone": milestone(repo, pull.milestone.as_ref()),
        "user": person(&pull.author),
        "requested_by": pull.requested_by.as_ref().map(person),
        "assignee": pull.assignees.first().map(|a| user(a)),
        "assignees": people(&pull.assignees),
        "created_at": pull.created_at,
        "updated_at": pull.updated_at,
        "html_url": format!("{SITE}/{full_name}/pull/{}", pull.number),
        "url": format!("{API}/repos/{full_name}/pulls/{}", pull.number),
        "repository_url": format!("{API}/repos/{full_name}"),
        "workspace": repo.namespace,
        "pull_request": {
            "url": format!("{API}/repos/{full_name}/pulls/{}", pull.number),
            "html_url": format!("{SITE}/{full_name}/pull/{}", pull.number),
            "merged_at": pull.merged_at,
        },
    })
}

/// A comment as the event that deleted it kept it (`comment.deleted`'s
/// `comment`), since it can no longer be read.
pub fn deleted_comment(repo: &Repo, number: u32, kept: &Value, on: Thread) -> Value {
    let (html_url, item_url) = on.urls(repo, number);
    let id = kept["id"].as_str().unwrap_or_default();
    let login = kept["author"]["username"].as_str().unwrap_or_default();
    json!({
        "id": id,
        "node_id": id,
        "body": kept["body"],
        "user": user(login),
        "created_at": kept["createdAt"],
        "updated_at": kept["editedAt"].as_str().map_or(kept["createdAt"].clone(), |at| json!(at)),
        "path": kept["path"],
        "line": kept["line"],
        "html_url": format!("{html_url}#{id}"),
        "url": on.comment_url(repo, id),
        "item_url": item_url,
    })
}

/// What `workflow_run` is told of the run it follows: the
/// `workflow.completed` event's data, and the run's row when it is still
/// there. Its `id` and `workflow_id` are g1t's (`run_…`, `wfl_…`), which
/// `GITHUB_RUN_ID` and the API use too, so `actions/download-artifact`
/// with `run-id: ${{ github.event.workflow_run.id }}` finds its artifacts.
pub struct FollowedRun<'a> {
    pub data: &'a Value,
    pub workflow_id: Option<&'a str>,
    pub attempt: Option<u64>,
    pub created_at: Option<&'a str>,
    pub started_at: Option<&'a str>,
    pub updated_at: Option<&'a str>,
    pub actor: Option<&'a str>,
    pub triggering_actor: Option<&'a str>,
    pub title: Option<&'a str>,
    pub head_commit: Option<&'a Commit>,
    /// The pull request the run was for (`data.pull`), when it can be
    /// read, and its base branch's latest commit.
    pub pull: Option<&'a Pull>,
    pub base_sha: Option<&'a str>,
}

/// The run's pull request as `workflow_run.pull_requests[]` gives it. One
/// from a fork is left out, as on GitHub, where only pull requests whose
/// head is in the repository are listed.
fn run_pulls(repo: &Repo, run: &FollowedRun) -> Vec<Value> {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let Some(number) = run.data["pull"].as_u64() else { return Vec::new() };
    let url = format!("{API}/repos/{full_name}/pulls/{number}");
    let Some(pull) = run.pull else {
        return vec![json!({ "number": number, "url": url })];
    };
    if pull.fork.is_some() || pull.head_repo.is_some() {
        return Vec::new();
    }
    let short = json!({ "id": github_id(&repo.id), "url": format!("{API}/repos/{full_name}"), "name": repo.name });
    vec![json!({
        "id": github_id(&pull.id),
        "number": number,
        "url": url,
        "head": { "ref": head_ref(pull), "sha": pull.head_commit, "repo": short },
        "base": {
            "ref": pull.base_branch(&repo.default_branch),
            "sha": run.base_sha.map(str::to_owned).or_else(|| pull.merge_base.clone()),
            "repo": short,
        },
    })]
}

pub fn workflow_run(repo: &Repo, run: &FollowedRun) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let data = run.data;
    let id = data["runId"].as_str().unwrap_or_default();
    let name = data["workflow"].as_str().unwrap_or_default();
    let head_branch = data["ref"].as_str().unwrap_or_default().trim_start_matches("refs/heads/").to_owned();
    let url = format!("{API}/repos/{full_name}/actions/runs/{id}");
    let actor = run.actor.map(user);
    json!({
        "id": id,
        "node_id": id,
        "name": name,
        "display_title": run.title.unwrap_or(name),
        "path": data["path"],
        "event": data["event"],
        "status": "completed",
        "conclusion": data["conclusion"],
        "workflow_id": run.workflow_id,
        "head_sha": data["sha"],
        "head_branch": head_branch,
        "head_commit": run.head_commit.map(|c| json!({
            "id": c.hash,
            "tree_id": c.tree_hash,
            "message": c.message,
            "timestamp": c.authored_at,
            "author": { "name": c.author.name, "email": c.author.email },
            "committer": { "name": c.author.name, "email": c.author.email },
        })),
        "run_number": data["number"],
        "run_attempt": run.attempt.unwrap_or(1),
        "created_at": run.created_at,
        "run_started_at": run.started_at.or(run.created_at),
        "updated_at": run.updated_at.or(run.created_at),
        "actor": actor,
        "triggering_actor": run.triggering_actor.map(user).or_else(|| run.actor.map(user)),
        "html_url": format!("{SITE}/{full_name}/actions/runs/{id}"),
        "url": url,
        "jobs_url": format!("{url}/jobs"),
        "logs_url": format!("{url}/logs"),
        "artifacts_url": format!("{url}/artifacts"),
        "workflow_url": run.workflow_id.map(|w| format!("{API}/repos/{full_name}/actions/workflows/{w}")),
        "pull_requests": run_pulls(repo, run),
        "repository": repository(repo),
        "head_repository": repository(repo),
    })
}

/// A release, from what a `release.*` event carries
/// (`g1t_contracts::about::Release`). Its `id` is g1t's, as
/// `/repos/{owner}/{repo}/releases/{id}` takes it.
pub fn release(repo: &Repo, release: &Value) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let tag = release["tagName"].as_str().unwrap_or_default();
    let id = release["id"].as_str().unwrap_or_default();
    json!({
        "id": id,
        "node_id": id,
        "tag_name": tag,
        "target_commitish": release["target"],
        "name": release["name"].as_str().unwrap_or(tag),
        "body": release["body"],
        "draft": release["draft"].as_bool().unwrap_or(false),
        "prerelease": release["prerelease"].as_bool().unwrap_or(false),
        "created_at": release["createdAt"],
        "published_at": release["publishedAt"],
        "author": user(release["author"].as_str().unwrap_or(&repo.namespace)),
        "assets": [],
        "html_url": format!("{SITE}/{full_name}/releases/tag/{tag}"),
        "url": format!("{API}/repos/{full_name}/releases/{id}"),
        "zipball_url": format!("{SITE}/{full_name}/archive/{tag}.zip"),
    })
}

/// A deployment, from what `deployment.created` and
/// `deployment_status.created` carry (`RepoDeployment`, already in GitHub's
/// spelling).
pub fn deployment(repo: &Repo, deployment: &Value) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let id = deployment["id"].as_str().unwrap_or_default();
    json!({
        "id": id,
        "node_id": id,
        "sha": deployment["sha"],
        "ref": deployment["ref"],
        "task": deployment["task"].as_str().unwrap_or("deploy"),
        "payload": deployment.get("payload").filter(|p| p.is_object()).cloned().unwrap_or_else(|| json!({})),
        "environment": deployment["environment"],
        "original_environment": deployment["environment"],
        "description": deployment["description"],
        "creator": user(deployment["creator"].as_str().unwrap_or("g1t")),
        "transient_environment": deployment["transient_environment"].as_bool().unwrap_or(false),
        "production_environment": deployment["production_environment"].as_bool().unwrap_or(false),
        "created_at": deployment["created_at"],
        "updated_at": deployment["updated_at"],
        "url": format!("{API}/repos/{full_name}/deployments/{id}"),
        "statuses_url": format!("{API}/repos/{full_name}/deployments/{id}/statuses"),
    })
}

/// A deployment's status (`DeploymentStatus`), for `deployment_status`.
pub fn deployment_status(repo: &Repo, status: &Value, deployment: &Value) -> Value {
    let full_name = format!("{}/{}", repo.namespace, repo.name);
    let deployment_id = deployment["id"].as_str().unwrap_or_default();
    let id = status["id"].as_str().unwrap_or_default();
    json!({
        "id": id,
        "node_id": id,
        "state": status["state"],
        "description": status["description"].as_str().unwrap_or_default(),
        "environment": deployment["environment"],
        "environment_url": status["environment_url"].as_str().unwrap_or_default(),
        "log_url": status["log_url"].as_str().unwrap_or_default(),
        "target_url": status["log_url"].as_str().unwrap_or_default(),
        "creator": user(status["creator"].as_str().unwrap_or("g1t")),
        "created_at": status["created_at"],
        "updated_at": status["created_at"],
        "deployment_url": format!("{API}/repos/{full_name}/deployments/{deployment_id}"),
        "url": format!("{API}/repos/{full_name}/deployments/{deployment_id}/statuses/{id}"),
    })
}


/// A review's `state` as GitHub's `pull_request_review` event spells it.
pub(crate) fn review_state(verdict: g1t_contracts::work::Verdict) -> &'static str {
    match verdict {
        g1t_contracts::work::Verdict::Approve => "approved",
        g1t_contracts::work::Verdict::RequestChanges => "changes_requested",
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;

    #[test]
    fn review_states_are_spelled_as_githubs() {
        assert_eq!(review_state(g1t_contracts::work::Verdict::Approve), "approved");
        assert_eq!(review_state(g1t_contracts::work::Verdict::RequestChanges), "changes_requested");
    }
}

/// g1t's payloads against GitHub's: each fixture in `tests/fixtures` is a
/// trimmed webhook payload in GitHub's documented shape, and every key it
/// has must be in g1t's payload for the same event with the same JSON type
/// (a whole number where GitHub's is one). `null` in a fixture takes any
/// type. Where g1t differs on purpose, `KNOWN` says how and why.
#[cfg(test)]
mod github_shapes {
    use super::*;
    use g1t_contracts::work::Verdict;

    /// Paths where g1t's payload differs from GitHub's on purpose, and
    /// what g1t has there: a JSON type, or `absent`.
    const KNOWN: &[(&str, &str, &str)] = &[
        // The API addresses these by g1t's own id, so the payload gives
        // that id, to be passed straight back.
        ("work_item_comment", "comment.id", "string"),
        // A work item belongs to a workspace, not to one repository: it
        // has `workspace_url` and `repos`, and its comments `item_url`.
        // A pull request has `item_url` for its work item.
        ("work_item", "work_item.repository_url", "absent"),
        ("work_item_comment", "comment.issue_url", "absent"),
        ("pull_request", "pull_request.issue_url", "absent"),
        ("release", "release.id", "string"),
        ("workflow_run", "workflow_run.id", "string"),
        ("workflow_run", "workflow_run.workflow_id", "string"),
        ("workflow_run", "workflow.id", "string"),
    ];

    fn kind(value: &Value) -> &'static str {
        match value {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }

    fn compare(event: &str, github: &Value, ours: Option<&Value>, path: &str, problems: &mut Vec<String>) {
        if let Some((_, _, known)) = KNOWN.iter().find(|(e, p, _)| *e == event && *p == path) {
            let had = ours.map_or("absent", kind);
            if had != *known {
                problems.push(format!("{path}: g1t is known to have {known} here, but has {had}"));
            }
            return;
        }
        let Some(ours) = ours else {
            problems.push(format!("{path}: missing"));
            return;
        };
        if github.is_null() {
            return;
        }
        if kind(github) != kind(ours) {
            problems.push(format!("{path}: GitHub's is {}, g1t's {}", kind(github), kind(ours)));
            return;
        }
        match github {
            Value::Number(n) if n.is_u64() => {
                if !ours.as_u64().is_some_and(|n| n < 1 << 53) {
                    problems.push(format!("{path}: GitHub's is a whole number, g1t's {ours}"));
                }
            }
            Value::Object(map) => {
                for (key, inner) in map {
                    let at = if path.is_empty() { key.clone() } else { format!("{path}.{key}") };
                    compare(event, inner, ours.get(key), &at, problems);
                }
            }
            Value::Array(items) => {
                if let (Some(first), Some(our_first)) = (items.first(), ours.as_array().and_then(|o| o.first())) {
                    compare(event, first, Some(our_first), &format!("{path}[]"), problems);
                }
            }
            _ => {}
        }
    }

    fn repo() -> Repo {
        serde_json::from_value(json!({
            "id": "rep_01kpw0aaaaaaaaaaaaaaaaaaaa", "namespace": "acme", "name": "web", "isPrivate": false,
            "ownerId": "wsp_1", "defaultBranch": "main", "forkOf": null, "createdAt": "2026-05-15T15:19:25Z"
        }))
        .unwrap()
    }

    fn someone(id: &str, username: &str) -> User {
        User { id: id.into(), username: username.into(), kind: PrincipalKind::User, ..User::default() }
    }

    fn a_pull() -> Pull {
        serde_json::from_value(json!({
            "id": "pr_01kq000000000000000000000a", "repoId": "rep_1", "number": 2, "item": null,
            "title": "Update the README with new information.", "body": "A simple change.",
            "agent": "", "runtime": "external", "status": "open",
            "fork": null, "forkRepoId": null, "branch": "changes",
            "headCommit": "ec26c3e57ca3a959ca5aad62de7213c562f8c821", "mergeBase": "f95f852bd8fca8fcc58a9a2d6c842781e32a215e",
            "mergedBy": null, "mergedAt": null, "supersededBy": null, "checkStatus": null,
            "files": [{ "path": "README.md", "additions": 1, "deletions": 1 }],
            "assignees": ["bo"], "reviewers": ["cy"], "labels": ["bug"], "milestone": { "number": 1, "title": "v1.0" },
            "author": someone("usr_1", "ada"), "requestedBy": null,
            "createdAt": "2026-05-15T15:20:33Z", "updatedAt": "2026-05-15T15:20:33Z"
        }))
        .unwrap()
    }

    fn an_item() -> WorkItem {
        serde_json::from_value(json!({
            "id": "wki_01kq000000000000000000000a", "workspace": "acme", "number": 1,
            "title": "Spelling error in the README file", "body": "Two t's.", "labels": ["bug"], "state": "open",
            "reason": null, "author": someone("usr_1", "ada"), "requestedBy": null,
            "createdAt": "2026-05-15T15:20:18Z", "updatedAt": "2026-05-15T15:20:18Z", "closedAt": null,
            "pullCount": 0, "commentCount": 0, "assignees": ["bo"], "milestone": { "number": 1, "title": "v1.0" },
            "repos": [
                { "repoId": "rep_01kpw0aaaaaaaaaaaaaaaaaaaa", "path": "acme/web", "role": "origin", "legacyNumber": 7 },
                { "repoId": "rep_2", "path": "acme/api", "role": "target", "landed": true }
            ],
            "resolutions": [{ "repo": "acme/api", "pull": 3, "pushedBy": "bo" }]
        }))
        .unwrap()
    }

    fn a_comment(verdict: Option<Verdict>) -> Comment {
        serde_json::from_value(json!({
            "id": "cmt_01kq000000000000000000000a", "author": someone("usr_3", "cy"), "body": "Looks good.",
            "path": null, "line": null, "verdict": verdict, "createdAt": "2026-05-15T15:20:38Z"
        }))
        .unwrap()
    }

    fn a_commit() -> Commit {
        serde_json::from_value(json!({
            "hash": "0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c", "treeHash": "f9d2a07e9488b91af2641b26b9407fe22a451433",
            "message": "Update README.md", "author": { "name": "Ada", "email": "ada@example.com" },
            "parents": ["6113728f27ae82c7b1a177c8d03f9e96e0adf246"], "authoredAt": "2026-05-15T15:20:30Z"
        }))
        .unwrap()
    }

    /// g1t's payload for each event, put together as trigger.rs does.
    fn payloads() -> Vec<(&'static str, Value)> {
        let repo = repo();
        let pull = a_pull();
        let mut push = push(&repo, "refs/heads/main", Some("6113728f27ae82c7b1a177c8d03f9e96e0adf246"), &a_commit().hash, &[a_commit()], "ada", Some("0d0efg+ada@users.noreply.g1t.sh"), false);
        push_changes(&mut push, &[("README.md".into(), FileStatus::Modified)]);
        let known = [Label { name: "bug".into(), color: "d73a4a".into(), description: "Something isn't working".into(), items: 1, pulls: 1 }];
        let mut pull_request = json!({
            "action": "opened", "number": 2, "pull_request": self::pull(&repo, &pull),
            "repository": repository(&repo), "sender": user("ada"),
        });
        color_labels(&mut pull_request, &known);
        let review = json!({
            "action": "submitted", "review": self::review(&repo, &pull, Some(&a_comment(Some(Verdict::Approve)))),
            "pull_request": self::pull(&repo, &pull), "repository": repository(&repo), "sender": user("cy"),
        });
        let mut items = json!({ "action": "labeled", "work_item": work_item(&repo, &an_item()), "repository": repository(&repo), "sender": user("ada") });
        changed(&repo, &mut items, &json!({ "label": { "name": "bug", "color": "d73a4a" } }));
        color_labels(&mut items, &known);
        let mut on_pull = pull.clone();
        on_pull.labels.clear();
        on_pull.assignees.clear();
        on_pull.milestone = None;
        let mut comment = a_comment(None);
        comment.author = someone("usr_1", "ada");
        let item_comment = json!({
            "action": "created", "work_item": pull_as_item(&repo, &on_pull), "comment": self::comment(&repo, 2, &comment, Thread::Pull),
            "repository": repository(&repo), "sender": user("ada"),
        });
        let data = json!({
            "runId": "run_01kq000000000000000000000a", "workflow": "Build", "path": ".g1t/workflows/build.yml", "number": 562,
            "event": "push", "conclusion": "success", "ref": "refs/heads/main", "sha": "acb5820ced9479c074f688cc328bf03f341a511d", "pull": 2,
        });
        let head = Commit { hash: "acb5820ced9479c074f688cc328bf03f341a511d".into(), ..a_commit() };
        let followed = FollowedRun {
            data: &data,
            workflow_id: Some("wfl_1"),
            attempt: Some(1),
            created_at: Some("2026-05-15T15:20:35Z"),
            started_at: Some("2026-05-15T15:20:35Z"),
            updated_at: Some("2026-05-15T15:21:10Z"),
            actor: Some("ada"),
            triggering_actor: None,
            title: Some("Update README.md"),
            head_commit: Some(&head),
            pull: Some(&pull),
            base_sha: Some("f95f852bd8fca8fcc58a9a2d6c842781e32a215e"),
        };
        // As trigger.rs gives it.
        let workflow_run = json!({
            "action": "completed",
            "workflow_run": self::workflow_run(&repo, &followed),
            "workflow": { "id": "wfl_1", "node_id": "wfl_1", "name": "Build", "path": data["path"], "state": "active", "html_url": "https://g1t.sh/acme/web/actions" },
            "repository": repository(&repo),
            "sender": user("ada"),
        });
        let release = json!({
            "action": "published",
            "release": self::release(&repo, &json!({ "id": "rel_1", "tagName": "v1.2.0", "target": "main", "name": "v1.2.0", "body": "Notes",
                "draft": false, "prerelease": false, "author": "ada", "createdAt": "2026-05-15T15:19:53Z", "publishedAt": "2026-05-15T15:20:05Z" })),
            "repository": repository(&repo),
            "sender": user("ada"),
        });
        vec![
            ("push", push),
            ("pull_request", pull_request),
            ("pull_request_review", review),
            ("work_item", items),
            ("work_item_comment", item_comment),
            ("workflow_run", workflow_run),
            ("release", release),
        ]
    }

    /// GitHub's payload for an event, as g1t names it: `work_item` is
    /// shaped as GitHub's `issues`, with `work_item` in place of `issue`,
    /// and `work_item_comment` as its `issue_comment`.
    fn fixture(event: &str) -> Value {
        let text = match event {
            "push" => include_str!("../tests/fixtures/push.json"),
            "pull_request" => include_str!("../tests/fixtures/pull_request.json"),
            "pull_request_review" => include_str!("../tests/fixtures/pull_request_review.json"),
            "work_item" => include_str!("../tests/fixtures/issues.json"),
            "work_item_comment" => include_str!("../tests/fixtures/issue_comment.json"),
            "workflow_run" => include_str!("../tests/fixtures/workflow_run.json"),
            "release" => include_str!("../tests/fixtures/release.json"),
            other => panic!("no fixture for {other}"),
        };
        let mut payload: Value = serde_json::from_str(text).unwrap();
        if let Some(issue) = payload.as_object_mut().and_then(|map| map.remove("issue")) {
            payload["work_item"] = issue;
        }
        payload
    }

    #[test]
    fn payloads_have_githubs_keys_and_types() {
        let mut problems = Vec::new();
        for (event, ours) in payloads() {
            let mut found = Vec::new();
            compare(event, &fixture(event), Some(&ours), "", &mut found);
            problems.extend(found.into_iter().map(|problem| format!("{event}: {problem}")));
        }
        assert!(problems.is_empty(), "g1t's payloads differ from GitHub's:\n{}", problems.join("\n"));
    }

    #[test]
    fn the_comparison_finds_what_differs() {
        let mut found = Vec::new();
        let github = json!({ "id": 1, "user": { "login": "a" }, "labels": [{ "name": "x" }], "body": null });
        compare("x", &github, Some(&json!({ "id": "pr_1", "labels": [{}], "body": 3 })), "", &mut found);
        assert_eq!(found, ["id: GitHub's is number, g1t's string", "user: missing", "labels[].name: missing"]);
        found.clear();
        compare("x", &json!({ "id": 1 }), Some(&json!({ "id": 1.5 })), "", &mut found);
        assert_eq!(found, ["id: GitHub's is a whole number, g1t's 1.5"]);
    }

    #[test]
    fn the_same_object_has_the_same_number_everywhere() {
        let all = payloads();
        let by = |event: &str| all.iter().find(|(e, _)| *e == event).map(|(_, v)| v.clone()).unwrap();
        let (pr, items, run) = (by("pull_request"), by("work_item"), by("workflow_run"));
        let repo_id = &pr["repository"]["id"];
        assert_eq!(repo_id, &json!(github_id(&repo().id)), "github.repository_id is the same number");
        assert_eq!(&pr["pull_request"]["base"]["repo"]["id"], repo_id);
        assert_eq!(&run["workflow_run"]["repository"]["id"], repo_id);
        // ada as sender, author and run actor; acme as owner and head user.
        assert_eq!(pr["sender"]["id"], pr["pull_request"]["user"]["id"]);
        assert_eq!(pr["sender"]["id"], run["workflow_run"]["actor"]["id"]);
        assert_eq!(pr["sender"]["id"], json!(account_id("ada")), "github.actor_id is the same number");
        assert_eq!(pr["repository"]["owner"]["id"], pr["pull_request"]["head"]["user"]["id"]);
        assert_eq!(pr["repository"]["owner"]["id"], json!(account_id("acme")));
        assert_eq!(pr["pull_request"]["labels"][0]["id"], items["label"]["id"]);
        // A pull request's own id and its id as a thread are different objects.
        assert_ne!(pull_as_item(&repo(), &a_pull())["id"], pr["pull_request"]["id"]);
        assert_eq!(pr["pull_request"]["node_id"], a_pull().id);
    }

    #[test]
    fn a_personal_workspaces_repositories_are_a_users() {
        let mut event = json!({ "pull_request": pull(&repo(), &a_pull()), "repository": repository(&repo()), "sender": user("ada") });
        assert_eq!(event["repository"]["owner"]["type"], "Organization");
        owned_by_person(&mut event, "Acme");
        assert_eq!(event["repository"]["owner"]["type"], "User");
        assert_eq!(event["pull_request"]["base"]["repo"]["owner"]["type"], "User");
        assert_eq!(event["pull_request"]["head"]["user"]["type"], "User");
        // Nobody else changes, a bot least of all.
        assert_eq!(event["sender"]["type"], "User");
        let mut bot = json!({ "user": { "login": "acme", "type": "Bot" } });
        owned_by_person(&mut bot, "acme");
        assert_eq!(bot["user"]["type"], "Bot");
    }

    #[test]
    fn a_push_says_whether_it_made_deleted_or_forced_its_ref() {
        let repo = repo();
        let after = "0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c";
        let made = push(&repo, "refs/heads/new", None, after, &[a_commit()], "ada", None, false);
        assert_eq!((made["created"].clone(), made["deleted"].clone(), made["forced"].clone()), (json!(true), json!(false), json!(false)));
        assert_eq!(made["before"], ZERO);
        let forced = push(&repo, "refs/heads/main", Some("6113728f27ae82c7b1a177c8d03f9e96e0adf246"), after, &[a_commit()], "ada", None, true);
        assert_eq!(forced["forced"], true);
        assert_eq!(forced["compare"], format!("https://g1t.sh/acme/web/compare/6113728f27ae82c7b1a177c8d03f9e96e0adf246...{after}"));
        assert_eq!(forced["head_commit"]["id"], after);
        let gone = push(&repo, "refs/heads/old", Some("6113728f27ae82c7b1a177c8d03f9e96e0adf246"), ZERO, &[], "ada", None, true);
        assert_eq!((gone["deleted"].clone(), gone["forced"].clone()), (json!(true), json!(false)));
    }

    #[test]
    fn a_one_commit_push_lists_what_it_changed() {
        let repo = repo();
        let changes = [
            ("new.txt".to_owned(), FileStatus::Added),
            ("README.md".to_owned(), FileStatus::Modified),
            ("old.txt".to_owned(), FileStatus::Deleted),
        ];
        let mut one = push(&repo, "refs/heads/main", None, &a_commit().hash, &[a_commit()], "ada", None, false);
        push_changes(&mut one, &changes);
        for commit in [&one["commits"][0], &one["head_commit"]] {
            assert_eq!(commit["added"], json!(["new.txt"]));
            assert_eq!(commit["modified"], json!(["README.md"]));
            assert_eq!(commit["removed"], json!(["old.txt"]));
        }
        // Several commits: the comparison is not any one commit's.
        let mut two = push(&repo, "refs/heads/main", None, &a_commit().hash, &[a_commit(), a_commit()], "ada", None, false);
        push_changes(&mut two, &changes);
        assert_eq!(two["head_commit"]["modified"], json!([]));
    }

    #[test]
    fn a_work_item_names_its_workspace_and_repositories() {
        let repo = repo();
        let item = work_item(&repo, &an_item());
        assert_eq!(item["html_url"], "https://g1t.sh/acme/-/work/1");
        assert_eq!(item["url"], format!("{API}/workspaces/acme/work/1"));
        assert_eq!(item["workspace"], "acme");
        assert_eq!(item["number"], 1);
        assert_eq!(item["node_id"], "wki_01kq000000000000000000000a");
        assert_eq!(item["repos"][0]["full_name"], "acme/web");
        assert_eq!(item["repos"][0]["role"], "origin");
        assert_eq!(item["repos"][0]["legacy_number"], 7);
        assert_eq!(item["repos"][0]["id"], json!(github_id(&repo.id)), "the same number as the repository's");
        assert_eq!(item["repos"][1]["role"], "target");
        assert_eq!(item["repos"][1]["landed"], true);
        assert_eq!(item["resolutions"][0]["repository"], "acme/api");
        assert_eq!(item["resolutions"][0]["pull"], 3);
        assert_eq!(item["resolutions"][0]["pushed_by"]["login"], "bo");
        assert_eq!(item["milestone"]["html_url"], "https://g1t.sh/acme/-/work/milestones/1");
        // A label is the workspace's: the same object on a pull request.
        assert_eq!(item["labels"][0]["id"], pull(&repo, &a_pull())["labels"][0]["id"]);
        // What a link, a landing and a close say.
        let mut linked = json!({ "action": "linked" });
        work_item_changed(&mut linked, &json!({ "repo": "acme/api", "role": "target" }));
        assert_eq!(linked["link"], json!({ "repository": "acme/api", "role": "target" }));
        let mut landed = json!({ "action": "landed" });
        work_item_changed(&mut landed, &json!({ "resolution": { "repo": "acme/api", "commit": "abc" }, "missing": ["acme/web"] }));
        assert_eq!(landed["resolution"]["commit"], "abc");
        assert_eq!(landed["missing"], json!(["acme/web"]));
        assert!(landed.get("link").is_none());
        // A comment on it is addressed in its workspace.
        let on_item = comment(&repo, 1, &a_comment(None), Thread::Item { workspace: "acme" });
        assert_eq!(on_item["html_url"], "https://g1t.sh/acme/-/work/1#cmt_01kq000000000000000000000a");
        assert_eq!(on_item["item_url"], format!("{API}/workspaces/acme/work/1"));
    }

    #[test]
    fn labels_have_the_workspaces_colors() {
        let repo = repo();
        let mut event = json!({ "work_item": work_item(&repo, &an_item()), "label": label(&repo, "bug", None) });
        // Before the repository's are known, g1t's default for the name.
        assert_eq!(event["work_item"]["labels"][0]["color"], "d73a4a");
        assert_eq!(event["work_item"]["labels"][0]["default"], true);
        assert!(has_labels(&event));
        let known = [Label { name: "bug".into(), color: "123456".into(), description: String::new(), items: 1, pulls: 0 }];
        color_labels(&mut event, &known);
        assert_eq!(event["work_item"]["labels"][0]["color"], "123456");
        assert_eq!(event["work_item"]["labels"][0]["description"], Value::Null);
        assert_eq!(event["label"]["color"], "123456");
        assert!(!has_labels(&json!({ "work_item": { "labels": [] } })));
    }

    #[test]
    fn a_run_names_its_pull_request_unless_it_is_from_a_fork() {
        let repo = repo();
        let data = json!({ "runId": "run_1", "pull": 2 });
        let pull = a_pull();
        let run = |pull: Option<&Pull>| {
            workflow_run(&repo, &FollowedRun {
                data: &data, workflow_id: None, attempt: None, created_at: None, started_at: None, updated_at: None,
                actor: None, triggering_actor: None, title: None, head_commit: None, pull, base_sha: Some("b4se"),
            })
        };
        let named = run(Some(&pull));
        let first = &named["pull_requests"][0];
        assert_eq!(first["number"], 2);
        assert_eq!(first["id"], json!(github_id(&pull.id)));
        assert_eq!(first["head"]["ref"], "changes");
        assert_eq!(first["head"]["sha"], "ec26c3e57ca3a959ca5aad62de7213c562f8c821");
        assert_eq!(first["base"]["ref"], "main");
        assert_eq!(first["base"]["sha"], "b4se");
        assert_eq!(first["base"]["repo"]["id"], json!(github_id(&repo.id)));
        let mut forked = a_pull();
        forked.fork = Some(RepoPath { namespace: "ana".into(), name: "web".into() });
        assert_eq!(run(Some(&forked))["pull_requests"], json!([]));
        assert_eq!(run(None)["pull_requests"][0]["number"], 2, "unread, still numbered");
    }

    #[test]
    fn a_fork_says_it_is_one_and_names_its_parent() {
        assert_eq!(repository(&repo())["fork"], false);
        assert!(repository(&repo()).get("parent").is_none());
        let mut fork = repo();
        fork.parent_id = Some("rep_p".into());
        assert_eq!(repository(&fork)["fork"], true);
        assert!(repository(&fork).get("parent").is_none(), "only where the parent is known");
        fork.parent = Some(RepoPath { namespace: "acme".into(), name: "web".into() });
        let event = repository(&fork);
        assert_eq!(event["parent"]["full_name"], "acme/web");
        assert_eq!(event["parent"]["id"], json!(github_id("rep_p")));
        assert_eq!(event["parent"]["owner"]["login"], "acme");
    }

    #[test]
    fn a_pull_request_from_a_fork_names_the_fork() {
        let mut pull = a_pull();
        pull.fork = Some(RepoPath { namespace: "ana".into(), name: "web".into() });
        pull.fork_repo_id = Some("rep_f".into());
        pull.branch = None;
        let event = self::pull(&repo(), &pull);
        assert_eq!(event["head"]["repo"]["full_name"], "ana/web");
        assert_eq!(event["head"]["repo"]["fork"], true);
        assert_eq!(event["head"]["repo"]["id"], json!(github_id("rep_f")));
        assert_eq!(event["head"]["label"], "ana:pull/2");
        assert_eq!(event["head"]["user"]["login"], "ana");
        assert_eq!(event["merge_commit_sha"], Value::Null, "only once merged");
    }

    #[test]
    fn a_pull_request_from_a_forks_branch_names_the_fork_and_branch() {
        let mut pull = a_pull();
        pull.head_repo = Some(RepoPath { namespace: "ana".into(), name: "web".into() });
        pull.head_repo_id = Some("rep_f".into());
        let event = self::pull(&repo(), &pull);
        assert_eq!(event["head"]["repo"]["full_name"], "ana/web");
        assert_eq!(event["head"]["repo"]["fork"], true);
        assert_eq!(event["head"]["repo"]["id"], json!(github_id("rep_f")));
        assert_eq!(event["head"]["ref"], "changes");
        assert_eq!(event["head"]["label"], "ana:changes");
        assert_eq!(event["base"]["repo"]["id"], json!(github_id(&repo().id)));
    }

    #[test]
    fn an_edited_pull_request_says_what_its_title_was() {
        let mut edited = json!({ "action": "edited", "number": 2 });
        changed(&repo(), &mut edited, &json!({ "changes": { "title": { "from": "Tidy" } } }));
        assert_eq!(edited["changes"], json!({ "title": { "from": "Tidy" } }));
        let mut other = json!({ "action": "labeled" });
        changed(&repo(), &mut other, &json!({ "label": { "name": "bug", "color": "d73a4a" } }));
        assert!(other.get("changes").is_none());
    }
}
