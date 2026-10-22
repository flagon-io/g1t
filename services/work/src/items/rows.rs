//! A work item as stored and as read: its row, its links and who may see
//! it ([`Held`]).

use g1t_contracts::access::{self, Capability, Denied, RepoRef};
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use serde::{Deserialize, Serialize};

use crate::rows::{milestone_ref, requester, user};

/// A work item's columns, with what it is read with: its counts, agent,
/// milestone's title, project (projects.rs), blockers by number, parent by number, how many of
/// its sub-items are closed of how many, and links.
pub(crate) const ITEM_COLUMNS: &str = "work_items.*,
  (SELECT count(*) FROM pulls WHERE pulls.item_id = work_items.id) AS pull_count,
  (SELECT agent FROM pulls
   WHERE pulls.item_id = work_items.id AND pulls.status IN ('draft', 'open')
     AND pulls.fork_repo_id IS NOT NULL
   ORDER BY pulls.created_at DESC LIMIT 1) AS agent,
  (SELECT count(*) FROM comments
   WHERE comments.item_id = work_items.id AND comments.kind = 'comment') AS comment_count,
  (SELECT title FROM milestones
   WHERE milestones.workspace = work_items.workspace AND milestones.number = work_items.milestone) AS milestone_title,
  (SELECT json_object('id', pj.id, 'slug', pj.slug, 'name', pj.name, 'color', pj.color, 'icon', pj.icon)
   FROM projects pj WHERE pj.id = work_items.project_id) AS project_json,
  (SELECT json_group_array(number) FROM
     (SELECT b.number AS number FROM json_each(work_items.blocked_by) j JOIN work_items b ON b.id = j.value
      WHERE b.number IS NOT NULL ORDER BY j.key)) AS blocked_numbers,
  (SELECT p.number FROM work_items p WHERE p.id = work_items.parent_id) AS parent_number,
  (SELECT count(*) FROM work_items s WHERE s.parent_id = work_items.id) AS sub_total,
  (SELECT count(*) FROM work_items s WHERE s.parent_id = work_items.id AND s.state = 'closed') AS sub_done,
  (SELECT json_group_array(json_object('repo_id', l.repo_id, 'path', COALESCE(rw.path, l.path, ''), 'role', l.role,
      'legacy_number', l.legacy_number, 'landed', l.landed_at IS NOT NULL, 'workspace', rw.workspace,
      'private', rw.private, 'deleted', rw.deleted_at IS NOT NULL))
   FROM work_item_repos l LEFT JOIN repo_workspaces rw ON rw.repo_id = l.repo_id
   WHERE l.item_id = work_items.id) AS links";

#[derive(Deserialize)]
pub(crate) struct ItemRow {
    pub id: String,
    pub workspace: Option<String>,
    pub number: Option<u32>,
    pub title: String,
    pub body: String,
    /// JSON array of label names.
    pub labels: String,
    pub state: State,
    pub reason: Option<CloseReason>,
    /// JSON array of `{ repo_id, pull, commit, pushed_by }`.
    #[serde(default)]
    pub resolutions: Option<String>,
    pub author_id: String,
    pub author_name: String,
    #[serde(default)]
    pub requested_by_id: Option<String>,
    #[serde(default)]
    pub requested_by_name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    /// JSON array of usernames.
    pub assignees: String,
    #[serde(default)]
    pub milestone: Option<u32>,
    #[serde(default)]
    pub milestone_title: Option<String>,
    /// JSON [`ProjectRef`] of the project it is in.
    #[serde(default)]
    pub project_json: Option<String>,
    #[serde(default)]
    pub pull_count: u32,
    #[serde(default)]
    pub comment_count: u32,
    #[serde(default)]
    pub agent: Option<String>,
    /// JSON array of the numbers of the work items it is blocked by.
    #[serde(default)]
    pub blocked_numbers: Option<String>,
    /// The number of the work item it is a sub-item of.
    #[serde(default)]
    pub parent_number: Option<u32>,
    #[serde(default)]
    pub sub_total: u32,
    /// Of its sub-items, those closed.
    #[serde(default)]
    pub sub_done: u32,
    /// JSON array of [`LinkRow`].
    #[serde(default)]
    pub links: Option<String>,
    /// NULL for Triage (plan.rs).
    #[serde(default)]
    pub horizon: Option<Horizon>,
    #[serde(default)]
    pub appetite: Option<Appetite>,
    #[serde(default)]
    pub budget_usd: Option<f64>,
    #[serde(default)]
    pub urgent: u8,
    #[serde(default)]
    pub planned_at: Option<String>,
    /// JSON [`PlanSuggestion`] (plan_settle.rs).
    #[serde(default)]
    pub suggestion: Option<String>,
    /// The cycle it is in (cycles.rs).
    #[serde(default)]
    pub cycle_number: Option<u32>,
}

/// A link as [`ITEM_COLUMNS`] reads it.
#[derive(Deserialize)]
struct LinkRow {
    repo_id: String,
    path: String,
    role: LinkRole,
    #[serde(default)]
    legacy_number: Option<u32>,
    #[serde(default)]
    landed: u8,
    /// Where the repository is, when known.
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    private: Option<u8>,
    /// The repository is deleted, not yet purged (`repo_workspaces.deleted_at`).
    #[serde(default)]
    deleted: u8,
}

/// A resolution as stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StoredResolution {
    pub repo_id: String,
    #[serde(default)]
    pub pull: Option<u32>,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub pushed_by: Option<String>,
}

/// A work item, with what deciding who may see it needs: its origin's
/// workspace and whether it is private.
#[derive(Clone, Debug)]
pub(crate) struct Held {
    pub item: WorkItem,
    /// The origin's id, workspace and privacy, while the repository is
    /// known: one deleted for good no longer makes it public.
    origin: Option<(String, String, bool)>,
    /// Each linked repository's id with its workspace and privacy, while
    /// known: what deciding who may see that it is linked needs.
    known: Vec<(String, String, bool)>,
    /// The repository of each of `item.resolutions`, by id, in order.
    resolved_in: Vec<String>,
}

impl Held {
    /// Whether `viewer` may read linked repository `repo_id`: one whose
    /// workspace and privacy are not known is not shown.
    pub(crate) fn may_read_repo(&self, viewer: Option<&User>, repo_id: &str) -> bool {
        self.known
            .iter()
            .find(|(id, _, _)| id == repo_id)
            .is_some_and(|(id, namespace, private)| repo_readable(viewer, id, Some(namespace), Some(u8::from(*private))))
    }

    /// The work item as `viewer` is shown it: only the linked repositories
    /// and the resolutions in repositories they may read. Who may see a
    /// work item is its workspace's and its origin's business; that it is
    /// linked to a private repository is that repository's.
    pub(crate) fn shown(self, viewer: Option<&User>) -> WorkItem {
        let readable = |repo_id: &str| self.may_read_repo(viewer, repo_id);
        let repos: Vec<ItemRepo> = self.item.repos.iter().filter(|repo| readable(&repo.repo_id)).cloned().collect();
        let resolutions: Vec<Resolution> = self
            .item
            .resolutions
            .iter()
            .zip(&self.resolved_in)
            .filter(|(_, repo_id)| readable(repo_id))
            .map(|(resolution, _)| resolution.clone())
            .collect();
        WorkItem { repos, resolutions, ..self.item }
    }

    pub(crate) fn origin(&self) -> Option<RepoRef<'_>> {
        self.origin.as_ref().map(|(id, namespace, private)| RepoRef { id, namespace, private: *private })
    }

    /// Every repository it is linked to, its origin first.
    pub(crate) fn repo_ids(&self) -> Vec<String> {
        self.item.repos.iter().map(|repo| repo.repo_id.clone()).collect()
    }

    /// The repository its events are filed under: its origin, or none for
    /// one filed in the workspace. Never another linked repository: its
    /// readers may not see a members-only work item, and events filed
    /// under a repository are shown to whoever reads it. The others hear
    /// of it through the event's `repoIds`.
    pub(crate) fn event_repo(&self) -> Option<&str> {
        self.item.repos.iter().find(|repo| repo.role == LinkRole::Origin).map(|repo| repo.repo_id.as_str())
    }

    pub(crate) fn may(&self, viewer: Option<&User>, capability: Capability) -> bool {
        access::can_item(viewer, &self.item.workspace, self.origin(), capability)
    }

    /// `Ok` when `viewer` may do `capability` on it; not found when they
    /// may not see it.
    pub(crate) fn allowed(&self, viewer: Option<&User>, capability: Capability) -> Outcome<()> {
        match access::check_item(viewer, &self.item.workspace, self.origin(), capability) {
            Ok(()) => Outcome::Ok(()),
            Err(Denied::NotFound) => no_item(),
            Err(Denied::Forbidden) => Outcome::fail(FailureCode::Forbidden, access::needs_on_item(capability, &self.item.workspace)),
        }
    }
}

/// Whether `viewer` may read repository `repo_id`, as `repo_workspaces`
/// records it (its `workspace` and `private`): one not recorded is not.
pub(crate) fn repo_readable(viewer: Option<&User>, repo_id: &str, workspace: Option<&str>, private: Option<u8>) -> bool {
    workspace.is_some_and(|namespace| {
        access::can(viewer, RepoRef { id: repo_id, namespace, private: private != Some(0) }, Capability::Read)
    })
}

pub(crate) fn no_item<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::NotFound, "Work item not found.")
}

/// A workspace's slug as given, or `repo`'s, lowercase.
pub(crate) fn workspace_of(workspace: &str, repo: Option<&RepoPath>) -> String {
    let given = workspace.trim();
    match (given.is_empty(), repo) {
        (true, Some(repo)) => repo.namespace.to_lowercase(),
        _ => given.to_lowercase(),
    }
}

/// `owner/name` of a repository.
pub(crate) fn path_of(repo: &Repo) -> String {
    format!("{}/{}", repo.namespace, repo.name)
}

impl ItemRow {
    /// The work item, once it has a workspace and a number: one moved from
    /// a repository's issues has neither until the migration job runs.
    pub(crate) fn held(self) -> Option<Held> {
        let workspace = self.workspace?;
        let number = self.number?;
        let links: Vec<LinkRow> = self.links.as_deref().and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default();
        let origin = links.iter().find(|link| link.role == LinkRole::Origin).and_then(|link| {
            let namespace = link.workspace.clone()?;
            Some((link.repo_id.clone(), namespace, link.private != Some(0)))
        });
        let known: Vec<(String, String, bool)> = links
            .iter()
            .filter_map(|link| Some((link.repo_id.clone(), link.workspace.clone()?, link.private != Some(0))))
            .collect();
        let mut repos: Vec<ItemRepo> = links
            .into_iter()
            .map(|link| ItemRepo {
                repo_id: link.repo_id,
                path: link.path,
                role: link.role,
                legacy_number: link.legacy_number,
                landed: link.landed != 0,
                deleted: link.deleted != 0,
            })
            .collect();
        sort_repos(&mut repos);
        let stored: Vec<StoredResolution> =
            self.resolutions.as_deref().and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default();
        let resolved_in: Vec<String> = stored.iter().map(|resolution| resolution.repo_id.clone()).collect();
        let resolutions = stored
            .into_iter()
            .map(|resolution| Resolution {
                repo: repos
                    .iter()
                    .find(|repo| repo.repo_id == resolution.repo_id)
                    .map_or_else(|| resolution.repo_id.clone(), |repo| repo.path.clone()),
                pull: resolution.pull,
                commit: resolution.commit,
                pushed_by: resolution.pushed_by,
            })
            .collect();
        Some(Held {
            item: WorkItem {
                id: self.id,
                workspace,
                number,
                title: self.title,
                body: self.body,
                labels: serde_json::from_str(&self.labels).unwrap_or_default(),
                state: self.state,
                reason: self.reason,
                resolutions,
                author: user(self.author_id, self.author_name),
                requested_by: requester(self.requested_by_id, self.requested_by_name),
                created_at: self.created_at,
                updated_at: self.updated_at,
                closed_at: self.closed_at,
                pull_count: self.pull_count,
                comment_count: self.comment_count,
                assignees: serde_json::from_str(&self.assignees).unwrap_or_default(),
                blocked_by: self.blocked_numbers.as_deref().and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default(),
                parent: self.parent_number,
                sub_item_progress: (self.sub_total > 0).then_some(SubItemProgress { done: self.sub_done, total: self.sub_total }),
                agent: self.agent,
                milestone: milestone_ref(self.milestone, self.milestone_title),
                project: self.project_json.as_deref().and_then(|json| serde_json::from_str(json).ok()),
                cycle: self.cycle_number,
                repos,
                horizon: self.horizon.unwrap_or_default(),
                appetite: self.appetite,
                budget_usd: self.budget_usd,
                urgent: self.urgent != 0,
                planned_at: self.planned_at,
                // Only while it waits to be placed.
                suggestion: self
                    .suggestion
                    .as_deref()
                    .filter(|_| self.horizon.unwrap_or_default() == Horizon::Triage && self.state == State::Open)
                    .and_then(|json| serde_json::from_str(json).ok()),
            },
            origin,
            known,
            resolved_in,
        })
    }
}

/// A work item of `acme` linked as `links` (`[repo_id, role, workspace,
/// private]`, a workspace of "" for a repository not known) and resolved
/// in `resolved` (repository ids), for tests.
#[cfg(test)]
pub(crate) fn held_for_test(number: u32, links: &[(&str, &str, &str, bool)], resolved: &[&str]) -> Held {
    let links: Vec<serde_json::Value> = links
        .iter()
        .map(|(id, role, workspace, private)| {
            serde_json::json!({
                "repo_id": id, "path": format!("{workspace}/{id}"), "role": role, "landed": 0,
                "workspace": if workspace.is_empty() { serde_json::Value::Null } else { (*workspace).into() },
                "private": u8::from(*private),
            })
        })
        .collect();
    let resolutions: Vec<serde_json::Value> = resolved.iter().map(|id| serde_json::json!({ "repo_id": id, "pull": 1 })).collect();
    let row: ItemRow = serde_json::from_value(serde_json::json!({
        "id": format!("wki_{number}"), "workspace": "acme", "number": number, "title": format!("Item {number}"), "body": "",
        "labels": "[]", "state": "open", "reason": null, "resolutions": serde_json::to_string(&resolutions).unwrap(),
        "author_id": "usr_1", "author_name": "ana", "created_at": "", "updated_at": "", "closed_at": null, "assignees": "[]",
        "links": serde_json::to_string(&links).unwrap(),
    }))
    .unwrap();
    row.held().unwrap()
}

/// A verified person, a member (with the default Write) of `member_of`
/// if given, for tests.
#[cfg(test)]
pub(crate) fn person_for_test(id: &str, member_of: Option<&str>) -> User {
    User {
        id: id.to_owned(),
        username: id.trim_start_matches("usr_").to_owned(),
        verified: true,
        workspaces: member_of.map(g1t_contracts::Membership::member).into_iter().collect(),
        ..User::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_filed_under_the_origin_only() {
        let filed = held_for_test(1, &[("rep_web", "origin", "acme", false), ("rep_api", "target", "acme", false)], &[]);
        assert_eq!(filed.event_repo(), Some("rep_web"));
        // Filed in the workspace: none, not the public repository it targets.
        let members_only = held_for_test(2, &[("rep_public", "target", "acme", false)], &[]);
        assert_eq!(members_only.event_repo(), None);
        assert_eq!(members_only.repo_ids(), vec!["rep_public".to_owned()]);
    }

    #[test]
    fn a_viewer_is_shown_only_the_repositories_they_may_read() {
        let held = held_for_test(
            3,
            &[("rep_web", "origin", "acme", false), ("rep_secret", "target", "acme", true), ("rep_gone", "touched", "", false)],
            &["rep_web", "rep_secret"],
        );
        let shown = held.clone().shown(None);
        assert_eq!(shown.repos.iter().map(|repo| repo.repo_id.as_str()).collect::<Vec<_>>(), vec!["rep_web"]);
        assert_eq!(shown.resolutions.len(), 1);
        assert_eq!(shown.resolutions[0].repo, "acme/rep_web");
        // A member who reads every repository sees them all, but for one
        // that is not known.
        let member = person_for_test("usr_2", Some("acme"));
        let shown = held.shown(Some(&member));
        assert_eq!(shown.repos.len(), 2);
        assert_eq!(shown.resolutions.len(), 2);
    }

    #[test]
    fn a_workspace_is_the_one_given_or_its_repositorys() {
        assert_eq!(workspace_of(" ", Some(&RepoPath { namespace: "Acme".into(), name: "web".into() })), "acme");
        assert_eq!(workspace_of("Globex", None), "globex");
    }
}
