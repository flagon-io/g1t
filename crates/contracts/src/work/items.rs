//! Work items: any tracked work (a feature, a bug, a chore) of a workspace,
//! linked to the repositories it concerns.
//!
//! A work item belongs to a workspace and is numbered in the workspace's
//! sequence, which new pull requests share. It links repositories, each
//! with a [`LinkRole`]: where it was filed (`origin`), where the work is
//! meant to land (`target`), and where a pull request or commit for it
//! landed or is under way (`touched`). It closes once it has landed in
//! every target, or, with no targets, once anything that closes it lands.

use serde::{Deserialize, Serialize};

use super::{Comment, MilestoneRef, Pull, ReactionGroup, State};
use crate::repos::RepoPath;
use crate::{User, Viewer};

/// How a work item is linked to a repository.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkRole {
    /// Where it was filed. A work item moved from a repository's issues
    /// has one, which keeps the issue's old number.
    Origin,
    /// Where the work is meant to land.
    Target,
    /// Where a pull request or commit for it landed or is in progress,
    /// linked by itself.
    Touched,
}

impl LinkRole {
    pub const ALL: [LinkRole; 3] = [LinkRole::Origin, LinkRole::Target, LinkRole::Touched];

    pub fn as_str(self) -> &'static str {
        match self {
            LinkRole::Origin => "origin",
            LinkRole::Target => "target",
            LinkRole::Touched => "touched",
        }
    }

    pub fn parse(name: &str) -> Option<LinkRole> {
        LinkRole::ALL.into_iter().find(|role| role.as_str() == name.trim().to_ascii_lowercase())
    }
}

/// A repository a work item is linked to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRepo {
    pub repo_id: String,
    /// `owner/name`, as it is now, or as it was when the repository was
    /// deleted.
    pub path: String,
    pub role: LinkRole,
    /// For the origin of a work item moved from a repository's issues: the
    /// number the issue had there, which `#N` in that repository's old
    /// text still names.
    #[serde(default)]
    pub legacy_number: Option<u32>,
    /// A pull request or commit that closes it landed in this repository.
    #[serde(default)]
    pub landed: bool,
    /// The repository is deleted, and can still be restored until it is
    /// purged: `path` is where it was. It has nothing to open or read.
    #[serde(default)]
    pub deleted: bool,
}

/// What resolved a work item in one repository: a pull request merged, or
/// a commit pushed to its default branch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    /// The repository, `owner/name`.
    pub repo: String,
    /// The pull request whose merge did it.
    #[serde(default)]
    pub pull: Option<u32>,
    /// The commit pushed to the default branch whose message did it
    /// (`Closes #12`).
    #[serde(default)]
    pub commit: Option<String>,
    /// Who pushed that commit, by username.
    #[serde(default)]
    pub pushed_by: Option<String>,
}

/// Why a work item was closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    /// The work was done. What did it is in `resolutions`.
    Completed,
    NotPlanned,
}

impl CloseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CloseReason::Completed => "completed",
            CloseReason::NotPlanned => "not_planned",
        }
    }
}

/// Any tracked work of a workspace: a feature, a bug, a chore. Opened by a
/// person, an agent or an integration. Pull requests in its repositories
/// are made for it; it closes once what closes it has landed everywhere it
/// should.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItem {
    /// `wki_…`; one moved from a repository's issues keeps its `iss_…`.
    pub id: String,
    /// The workspace's slug.
    pub workspace: String,
    /// Shown as `#12`, numbered in the workspace with its pull requests.
    pub number: u32,
    pub title: String,
    /// Markdown. Also what an agent is given to work from.
    pub body: String,
    pub labels: Vec<String>,
    pub state: State,
    /// Set when closed.
    pub reason: Option<CloseReason>,
    /// What resolved it, in each repository it landed in, oldest first.
    #[serde(default)]
    pub resolutions: Vec<Resolution>,
    /// Who opened it: a person, an integration, or g1t (`kind` `agent`)
    /// for one its agent filed while at work.
    pub author: User,
    /// For one g1t's agent filed: the person it was working for. They may
    /// manage it as its author could. See [`owner`](WorkItem::owner).
    #[serde(default)]
    pub requested_by: Option<User>,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub updated_at: String,
    /// RFC 3339.
    pub closed_at: Option<String>,
    /// Pull requests made for it, in any state and repository.
    pub pull_count: u32,
    pub comment_count: u32,
    /// Usernames of the people it is assigned to.
    #[serde(default)]
    pub assignees: Vec<String>,
    /// The numbers of the work items of the workspace that have to land
    /// before this one is worked on.
    #[serde(default)]
    pub blocked_by: Vec<u32>,
    /// The number of the work item of the workspace it is a sub-item of,
    /// if any.
    #[serde(default)]
    pub parent: Option<u32>,
    /// With sub-items: how many of them are closed, of how many.
    #[serde(default)]
    pub sub_item_progress: Option<super::SubItemProgress>,
    /// The agent working on it now: the one behind its newest pull request
    /// that is still in progress in a fork, such as `g1t`.
    #[serde(default)]
    pub agent: Option<String>,
    /// The workspace milestone it is in, if any.
    #[serde(default)]
    pub milestone: Option<MilestoneRef>,
    /// The project it is in, if any.
    #[serde(default)]
    pub project: Option<super::ProjectRef>,
    /// The number of the cycle it is in, while its workspace has cycles
    /// on: in Now, the current cycle; in Next, the coming one it is planned
    /// into. A closed one keeps the cycle it closed in.
    #[serde(default)]
    pub cycle: Option<u32>,
    /// The repositories it is linked to: its origin first, then targets,
    /// then those it touched.
    #[serde(default)]
    pub repos: Vec<ItemRepo>,
    /// Where it stands in the workspace's plan. A closed one keeps where
    /// it was, for if it is reopened.
    #[serde(default)]
    pub horizon: super::Horizon,
    /// How much the work is worth, if someone has said.
    #[serde(default)]
    pub appetite: Option<super::Appetite>,
    /// In dollars, what an agent working on it may spend.
    #[serde(default)]
    pub budget_usd: Option<f64>,
    /// First in Now until it closes.
    #[serde(default)]
    pub urgent: bool,
    /// RFC 3339: when it was last moved in the plan; none for one never
    /// placed.
    #[serde(default)]
    pub planned_at: Option<String>,
    /// While it is in Triage: where g1t suggests it goes.
    #[serde(default)]
    pub suggestion: Option<super::PlanSuggestion>,
}

impl WorkItem {
    /// Who it is theirs to manage: the person g1t's agent filed it for, or
    /// its author. They may edit, close and reopen it without the Triage
    /// role.
    pub fn owner(&self) -> &User {
        self.requested_by.as_ref().unwrap_or(&self.author)
    }

    /// The repository it was filed in, if it was filed in one.
    pub fn origin(&self) -> Option<&ItemRepo> {
        self.repos.iter().find(|repo| repo.role == LinkRole::Origin)
    }

    /// Its link to the repository with this id, if it has one.
    pub fn link(&self, repo_id: &str) -> Option<&ItemRepo> {
        self.repos.iter().find(|repo| repo.repo_id == repo_id)
    }

    /// The targets it has not landed in yet, by path.
    pub fn missing(&self) -> Vec<String> {
        missing_targets(&self.repos)
    }
}

/// The targets among `repos` that have not landed, by path.
pub fn missing_targets(repos: &[ItemRepo]) -> Vec<String> {
    repos
        .iter()
        .filter(|repo| repo.role == LinkRole::Target && !repo.landed)
        .map(|repo| repo.path.clone())
        .collect()
}

/// Whether a work item linked to `repos` is done landing: it has no
/// targets, or every target has landed. What closes it closes it then.
pub fn landed_everywhere(repos: &[ItemRepo]) -> bool {
    repos.iter().filter(|repo| repo.role == LinkRole::Target).all(|repo| repo.landed)
}

/// The order a work item's repositories are listed in: origin, targets,
/// touched, each by path.
pub fn sort_repos(repos: &mut [ItemRepo]) {
    repos.sort_by(|a, b| (a.role, &a.path).cmp(&(b.role, &b.path)));
}

/// A work item and everything on it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemDetail {
    pub item: WorkItem,
    /// Every pull request made for it, in any repository, oldest first.
    pub pulls: Vec<Pull>,
    pub comments: Vec<Comment>,
    /// How people (and g1t) reacted to its description.
    #[serde(default)]
    pub reactions: Vec<ReactionGroup>,
    /// The work item it is a sub-item of, when the viewer may see it.
    #[serde(default)]
    pub parent: Option<super::ItemBrief>,
    /// Its sub-items the viewer may see, by number.
    #[serde(default)]
    pub sub_items: Vec<super::ItemBrief>,
}

// --- Arguments --------------------------------------------------------------

/// `open_work_item`: files a work item in a workspace. With `repo`, it is
/// filed from that repository, its origin: anyone who may participate in
/// it may then file one (on a public repository, anyone signed in), and
/// `workspace` may be left empty to mean the repository's. Without, only a
/// member of the workspace may. `targets` are linked as where the work is
/// meant to land, each a repository of the workspace. Publishes
/// `work_item.opened`. Returns `Outcome<WorkItem>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct OpenWorkItemArgs {
    pub actor: User,
    #[serde(default)]
    pub workspace: String,
    /// The repository it is filed from.
    #[serde(default)]
    pub repo: Option<RepoPath>,
    /// Repositories of the workspace where the work is meant to land.
    #[serde(default)]
    pub targets: Vec<RepoPath>,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub labels: Vec<String>,
    /// The number of the workspace milestone to put it in. Needs the
    /// Triage role.
    #[serde(default)]
    pub milestone: Option<u32>,
    /// The number of the work item of the workspace to file it as a
    /// sub-item of. Publishes `work_item.sub_items_changed` on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<u32>,
    /// The project to file it in, by slug or id. Needs the Triage role.
    /// Without `targets`, the project's default targets are linked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

/// `list_work_items`, newest first, at most 100 (`before` pages on): a
/// workspace's work items the viewer may see. With `repo` (then `workspace` may be empty, meaning the
/// repository's), only those linked to it, in any role or in `role`.
/// Returns `Outcome<Vec<WorkItem>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListWorkItemsArgs {
    #[serde(default)]
    pub workspace: String,
    pub viewer: Viewer,
    #[serde(default)]
    pub repo: Option<RepoPath>,
    /// With `repo`: only those linked to it this way.
    #[serde(default)]
    pub role: Option<LinkRole>,
    #[serde(default)]
    pub state: Option<State>,
    /// Only those carrying this label.
    #[serde(default)]
    pub label: Option<String>,
    /// Only those in the workspace milestone of this number.
    #[serde(default)]
    pub milestone: Option<u32>,
    /// Only those assigned to this username.
    #[serde(default)]
    pub assignee: Option<String>,
    /// Only the sub-items of the work item of this number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<u32>,
    /// Only those in the project of this slug or id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Only those in the cycle of this number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cycle: Option<u32>,
    /// Only those closed at or after this time (RFC 3339), the most
    /// recently closed first instead of the newest.
    #[serde(default)]
    pub closed_since: Option<String>,
    /// Only open ones on this horizon of the plan, in the plan's order
    /// (urgent first, then by rank; Triage newest first) instead of the
    /// newest first. `before` does not page these; `limit` does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub horizon: Option<super::Horizon>,
    /// At most this many (1 to 100, 100 if left out).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Only those numbered below this: the next page, after one whose
    /// lowest number this is.
    #[serde(default)]
    pub before: Option<u32>,
}

/// `get_work_item` (`Outcome<WorkItemDetail>`), `get_work`
/// (`Outcome<WorkContext>`), and `get_milestone`, whose `number` is the
/// milestone's (`Outcome<MilestoneDetail>`).
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkItemViewArgs {
    pub workspace: String,
    pub number: u32,
    pub viewer: Viewer,
}

/// `update_work_item`: changes whichever fields are given. Its owner, or
/// someone with the Triage role on it, may. Returns `Outcome<WorkItem>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateWorkItemArgs {
    pub actor: User,
    pub workspace: String,
    pub number: u32,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    /// Usernames of the people it is assigned to; replaces the whole set.
    #[serde(default)]
    pub assignees: Option<Vec<String>>,
    /// The number of the workspace milestone to put it in; 0 takes it out
    /// of its milestone. Needs the Triage role.
    #[serde(default)]
    pub milestone: Option<u32>,
    /// The numbers of the work items of the workspace that have to land
    /// first; replaces the whole set. Refused when one is not a work item,
    /// is the item itself, or would make a cycle.
    #[serde(default)]
    pub blocked_by: Option<Vec<u32>>,
    /// The number of the work item to make it a sub-item of; 0 takes it
    /// out of its parent. As `set_work_item_parent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<u32>,
    /// The project to put it in, by slug or id; an empty string takes it
    /// out of its project. Needs the Triage role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

/// `close_work_item` and `reopen_work_item`. Each returns
/// `Outcome<WorkItem>`. `close_work_item` takes [`CloseWorkItemArgs`],
/// which these are a part of.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkItemActionArgs {
    pub actor: User,
    pub workspace: String,
    pub number: u32,
    /// For `close_work_item`; `completed` if left out.
    #[serde(default)]
    pub reason: Option<CloseReason>,
}

/// `close_work_item`: a [`WorkItemActionArgs`], and the commit that did
/// it, if one did. With `commit` (and `repo`, the repository it is in), a
/// commit on that repository's default branch: any commit there for
/// someone with the Write role, else one whose message names the work item
/// after a closing keyword (`Fixes #12`) or the commit a pull request
/// naming it merged as. It lands there as the push of that commit would
/// have, and closes when nothing else is left to land; a commit not on the
/// default branch is refused. Returns `Outcome<WorkItem>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CloseWorkItemArgs {
    #[serde(flatten)]
    pub item: WorkItemActionArgs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<RepoPath>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// What to do with its sub-items that are still open. Closing one
    /// that has some is refused without it; a commit landing leaves them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_items: Option<super::OpenSubItems>,
    /// With `sub_items` `move`: the number of the work item they move to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub move_to: Option<u32>,
}

/// `link_work_item`: links a repository to a work item as a target (or as
/// touched), or changes how it is linked; `unlink_work_item` removes the
/// link (never the origin's), and ignores `role`. The repository must be
/// one of the workspace's, and the actor needs the Triage role on the work
/// item. Publishes `work_item.linked` or `work_item.unlinked`, and closes
/// or reopens nothing by itself: a work item closes when what closes it
/// lands. Returns `Outcome<WorkItem>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct LinkWorkItemArgs {
    pub actor: User,
    pub workspace: String,
    pub number: u32,
    pub repo: RepoPath,
    /// `target` when absent. `origin` is refused: a work item's origin is
    /// where it was filed.
    #[serde(default = "target")]
    pub role: LinkRole,
}

fn target() -> LinkRole {
    LinkRole::Target
}

/// `resolve_ref`: what `#number` names, read in the context of `repo` (in
/// its workspace) or of `workspace` alone; see [`super::refs`] for the
/// order. Only what the viewer may see is found. Returns `RefTarget`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ResolveRefArgs {
    pub viewer: Viewer,
    #[serde(default)]
    pub repo: Option<RepoPath>,
    /// The workspace, when there is no `repo`; with one, ignored.
    #[serde(default)]
    pub workspace: String,
    pub number: u32,
}

/// What a reference names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RefTarget {
    /// A work item: `/<workspace>/-/work/<number>` on the site.
    #[serde(rename_all = "camelCase")]
    WorkItem { workspace: String, number: u32, item_id: String },
    /// A pull request of `repo` (`owner/name`).
    Pull { repo: String, number: u32 },
    /// Nothing the viewer may see.
    None,
}

/// `migrate_work_items`: moves on the job that moves repositories' issues
/// into their workspaces as work items (the cron trigger runs it too). It
/// is resumable and changes nothing once done. Returns `WorkMigration`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct MigrateWorkItemsArgs {}

/// Where the move of issues into work items stands.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkMigration {
    /// Every work item is numbered in its workspace.
    pub done: bool,
    /// Repositories recorded with their workspaces in this call.
    pub repos: u32,
    /// Work items numbered in this call.
    pub numbered: u32,
    /// Work items left without a workspace, whose repository is gone.
    pub unplaced: u32,
}

/// `legacy_item_map`: for services that stored issue numbers, where each
/// repository's old issue went: a page of the mapping `work.migrated`
/// announces, ordered by item id. Returns `LegacyItemPage`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct LegacyItemMapArgs {
    /// Item ids after this one.
    #[serde(default)]
    pub after: Option<String>,
    /// At most 500.
    pub limit: u32,
}

/// One issue moved into a work item.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigratedItem {
    pub repo_id: String,
    pub legacy_number: u32,
    pub workspace: String,
    pub number: u32,
    pub item_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LegacyItemPage {
    pub items: Vec<MigratedItem>,
    /// Where the next page starts; null on the last.
    pub next: Option<String>,
    /// Whether every issue has its work item's number: until then the map
    /// is not whole, and a service catching up on it waits.
    #[serde(default)]
    pub moved: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(path: &str, role: LinkRole, landed: bool) -> ItemRepo {
        ItemRepo { repo_id: format!("rep_{path}"), path: path.into(), role, legacy_number: None, landed, deleted: false }
    }

    #[test]
    fn an_item_has_landed_once_every_target_has() {
        // No targets: whatever closes it closes it.
        assert!(landed_everywhere(&[link("acme/web", LinkRole::Origin, false)]));
        let both = [
            link("acme/web", LinkRole::Origin, false),
            link("acme/api", LinkRole::Target, true),
            link("acme/docs", LinkRole::Target, false),
            link("acme/cli", LinkRole::Touched, false),
        ];
        assert!(!landed_everywhere(&both));
        assert_eq!(missing_targets(&both), vec!["acme/docs".to_owned()]);
        let mut landed = both.clone();
        landed[2].landed = true;
        assert!(landed_everywhere(&landed));
    }

    #[test]
    fn repos_list_origin_then_targets_then_touched() {
        let mut repos = vec![
            link("acme/z", LinkRole::Touched, false),
            link("acme/b", LinkRole::Target, false),
            link("acme/a", LinkRole::Target, false),
            link("acme/web", LinkRole::Origin, false),
        ];
        sort_repos(&mut repos);
        let paths: Vec<&str> = repos.iter().map(|repo| repo.path.as_str()).collect();
        assert_eq!(paths, ["acme/web", "acme/a", "acme/b", "acme/z"]);
        assert_eq!(LinkRole::parse(" Target "), Some(LinkRole::Target));
        assert_eq!(serde_json::to_value(LinkRole::Touched).unwrap(), "touched");
    }

    #[test]
    fn a_reference_target_says_what_it_is() {
        let item = RefTarget::WorkItem { workspace: "acme".into(), number: 12, item_id: "wki_1".into() };
        assert_eq!(
            serde_json::to_value(&item).unwrap(),
            serde_json::json!({ "kind": "work_item", "workspace": "acme", "number": 12, "itemId": "wki_1" })
        );
        assert_eq!(serde_json::to_value(RefTarget::None).unwrap(), serde_json::json!({ "kind": "none" }));
        let link: LinkWorkItemArgs = serde_json::from_value(serde_json::json!({
            "actor": { "id": "usr_1", "username": "ana" }, "workspace": "acme", "number": 3,
            "repo": { "namespace": "acme", "name": "api" }
        }))
        .unwrap();
        assert_eq!(link.role, LinkRole::Target);
    }
}
