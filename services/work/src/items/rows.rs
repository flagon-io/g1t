//! A work item as stored and as read: its row, its links and who may see
//! it ([`Held`]).

use g1t_contracts::access::{self, Capability, Denied, RepoRef};
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use serde::{Deserialize, Serialize};

use crate::rows::{milestone_ref, requester, user};

/// A work item's columns, with what it is read with: its counts, agent,
/// milestone's title, blockers by number and links.
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
  (SELECT json_group_array(number) FROM
     (SELECT b.number AS number FROM json_each(work_items.blocked_by) j JOIN work_items b ON b.id = j.value
      WHERE b.number IS NOT NULL ORDER BY j.key)) AS blocked_numbers,
  (SELECT json_group_array(json_object('repo_id', l.repo_id, 'path', COALESCE(rw.path, l.path, ''), 'role', l.role,
      'legacy_number', l.legacy_number, 'landed', l.landed_at IS NOT NULL, 'workspace', rw.workspace,
      'private', rw.private))
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
    #[serde(default)]
    pub pull_count: u32,
    #[serde(default)]
    pub comment_count: u32,
    #[serde(default)]
    pub agent: Option<String>,
    /// JSON array of the numbers of the work items it is blocked by.
    #[serde(default)]
    pub blocked_numbers: Option<String>,
    /// JSON array of [`LinkRow`].
    #[serde(default)]
    pub links: Option<String>,
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
}

impl Held {
    pub(crate) fn origin(&self) -> Option<RepoRef<'_>> {
        self.origin.as_ref().map(|(id, namespace, private)| RepoRef { id, namespace, private: *private })
    }

    /// Every repository it is linked to, its origin first.
    pub(crate) fn repo_ids(&self) -> Vec<String> {
        self.item.repos.iter().map(|repo| repo.repo_id.clone()).collect()
    }

    /// The repository its events are filed under: its origin, else the
    /// first it is linked to.
    pub(crate) fn event_repo(&self) -> Option<&str> {
        self.item.repos.first().map(|repo| repo.repo_id.as_str())
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
        let mut repos: Vec<ItemRepo> = links
            .into_iter()
            .map(|link| ItemRepo {
                repo_id: link.repo_id,
                path: link.path,
                role: link.role,
                legacy_number: link.legacy_number,
                landed: link.landed != 0,
            })
            .collect();
        sort_repos(&mut repos);
        let stored: Vec<StoredResolution> =
            self.resolutions.as_deref().and_then(|json| serde_json::from_str(json).ok()).unwrap_or_default();
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
                agent: self.agent,
                milestone: milestone_ref(self.milestone, self.milestone_title),
                repos,
            },
            origin,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_is_the_one_given_or_its_repositorys() {
        assert_eq!(workspace_of(" ", Some(&RepoPath { namespace: "Acme".into(), name: "web".into() })), "acme");
        assert_eq!(workspace_of("Globex", None), "globex");
    }
}
