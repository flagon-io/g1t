//! Work items (`g1t_contracts::work::items`): any tracked work of a
//! workspace, linked to the repositories it concerns
//! (migrations/0049_work_items.sql).
//!
//! A work item is numbered in its workspace's sequence (`work_counters`),
//! which new pull requests share, and links repositories in
//! `work_item_repos`: its origin, its targets and those it touched. Who may
//! see one is `access::item_role`: the workspace's members, and anyone who
//! can read its origin. What closes one is closing.rs.

use g1t_contracts::access::{self, Capability, Denied, RepoRef};
use g1t_contracts::events::{EventLabel, WorkItemEvent};
use g1t_contracts::repos::{ReadableArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::refs::{Lookup, first_found};
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User, Viewer, new_id};
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::rows::{CommentRow, NumberRow, PULL_COLUMNS, PullRow, ValueRow, milestone_ref, requester, user};
use crate::{LIST_PAGE, UNVERIFIED, Work, optional, optional_number, state_name, valid_title};

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

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

/// The next number of workspace `?1`'s sequence, taken in one statement so
/// two openings never get the same one. A pull request of repository `?2`
/// never takes a number one of that repository's has (a repository moved
/// in from another workspace brings its own), and a workspace's first
/// number comes after every number its repositories used before work
/// items moved to the workspace.
pub(crate) const NEXT_NUMBER: &str = "INSERT INTO work_counters (workspace, last)
     SELECT ?1, MAX(COALESCE(MAX(c.last), 0), COALESCE((SELECT MAX(number) FROM pulls WHERE repo_id = ?2), 0)) + 1
     FROM counters c
     WHERE c.repo_id = ?2 OR c.repo_id IN (SELECT repo_id FROM repo_workspaces WHERE workspace = ?1)
     ON CONFLICT (workspace) DO UPDATE SET last = MAX(work_counters.last + 1, excluded.last)
     RETURNING last AS n";

/// What `#N` could name, read in repository `?1` (NULL for none) of
/// workspace `?2`: a pull request of the repository, a work item filed
/// there under that old number, the workspace's work item, and the newest
/// pull request of that number in the workspace's other repositories.
pub(crate) const REF_SQL: &str = "SELECT
     (SELECT 1 FROM pulls WHERE repo_id = ?1 AND number = ?3) AS pull_here,
     (SELECT item_id FROM work_item_repos WHERE repo_id = ?1 AND legacy_number = ?3) AS legacy,
     (SELECT id FROM work_items WHERE workspace = ?2 AND number = ?3) AS item,
     (SELECT repo_id FROM pulls WHERE number = ?3 AND repo_id IS NOT ?1
        AND repo_id IN (SELECT repo_id FROM repo_workspaces WHERE workspace = ?2)
      ORDER BY created_at DESC LIMIT 1) AS pull_there";

/// Records where repository `?1` is: workspace `?2`, path `?3`, and
/// whether it is private (`?4`).
pub(crate) const REMEMBER_REPO: &str = "INSERT INTO repo_workspaces (repo_id, workspace, path, private)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (repo_id) DO UPDATE SET workspace = excluded.workspace, path = excluded.path, private = excluded.private";

/// What [`REF_SQL`] found.
#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct RefRow {
    #[serde(default)]
    pub pull_here: Option<u8>,
    #[serde(default)]
    pub legacy: Option<String>,
    #[serde(default)]
    pub item: Option<String>,
    #[serde(default)]
    pub pull_there: Option<String>,
}

/// What a reference names, by the order of `refs::lookup_order`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Named {
    /// A pull request of the repository it was read in.
    PullHere,
    /// A work item, by id.
    Item(String),
    /// A pull request of another repository of the workspace, by id.
    PullThere(String),
}

impl RefRow {
    /// The first thing found, in the order references are read in: in a
    /// repository (`in_repo`), or a workspace alone.
    pub(crate) fn named(self, in_repo: bool) -> Option<Named> {
        first_found(in_repo, |lookup| match lookup {
            Lookup::PullInRepo => self.pull_here.map(|_| Named::PullHere),
            Lookup::LegacyItem => self.legacy.clone().map(Named::Item),
            Lookup::Item => self.item.clone().map(Named::Item),
            Lookup::PullInWorkspace => self.pull_there.clone().map(Named::PullThere),
        })
    }
}

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

/// What `list_work_items` reads: `?1` the workspace, then the filters, and
/// `?8` whether the viewer is a member (else only work items filed in a
/// public repository or one in `?9`, the repositories they were given a
/// role on).
const LIST_SQL: &str = "SELECT {ITEM_COLUMNS} FROM work_items
     WHERE workspace = ?1 AND (?2 IS NULL OR state = ?2)
       AND (?3 IS NULL OR EXISTS (SELECT 1 FROM json_each(work_items.labels) WHERE json_each.value = ?3))
       AND (?4 IS NULL OR milestone = ?4)
       AND (?5 IS NULL OR EXISTS (SELECT 1 FROM json_each(work_items.assignees) WHERE json_each.value = ?5))
       AND (?6 IS NULL OR EXISTS (SELECT 1 FROM work_item_repos r
             WHERE r.item_id = work_items.id AND r.repo_id = ?6 AND (?7 IS NULL OR r.role = ?7)))
       AND (?8 = 1 OR EXISTS (SELECT 1 FROM work_item_repos o JOIN repo_workspaces rw ON rw.repo_id = o.repo_id
             WHERE o.item_id = work_items.id AND o.role = 'origin'
               AND (rw.private = 0 OR o.repo_id IN (SELECT value FROM json_each(?9)))))
     ORDER BY number DESC LIMIT ?10";

/// A note of a landing: where, and by what.
pub(crate) fn landing_note(path: &str, pull: Option<u32>, commit: Option<&str>) -> String {
    match (pull, commit) {
        (Some(pull), _) => format!("{path}#{pull}"),
        (None, Some(commit)) => format!("{path}@{}", &commit[..7.min(commit.len())]),
        (None, None) => path.to_owned(),
    }
}

impl Work {
    /// A work item by workspace and number, whoever is asking.
    pub(crate) async fn item(&self, workspace: &str, number: u32) -> Result<Option<Held>> {
        Ok(self
            .db
            .prepare(format!("SELECT {ITEM_COLUMNS} FROM work_items WHERE workspace = ? AND number = ?"))
            .bind(&[workspace.to_lowercase().into(), number.into()])?
            .first::<ItemRow>(None)
            .await?
            .and_then(ItemRow::held))
    }

    /// A work item by id, whoever is asking.
    pub(crate) async fn item_by_id(&self, id: &str) -> Result<Option<Held>> {
        Ok(self
            .db
            .prepare(format!("SELECT {ITEM_COLUMNS} FROM work_items WHERE id = ?"))
            .bind(&[id.into()])?
            .first::<ItemRow>(None)
            .await?
            .and_then(ItemRow::held))
    }

    /// The work items of these ids, in no particular order.
    pub(crate) async fn items_by_ids(&self, ids: &[String]) -> Result<Vec<Held>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self
            .db
            .prepare(format!("SELECT {ITEM_COLUMNS} FROM work_items WHERE id IN (SELECT value FROM json_each(?))"))
            .bind(&[serde_json::to_string(ids)?.into()])?
            .all()
            .await?
            .results::<ItemRow>()?
            .into_iter()
            .filter_map(ItemRow::held)
            .collect())
    }

    /// A work item, if `viewer` may do `capability` on it.
    pub(crate) async fn item_for(&self, viewer: &Viewer, workspace: &str, number: u32, capability: Capability) -> Result<Outcome<Held>> {
        let Some(held) = self.item(workspace, number).await? else {
            return Ok(no_item());
        };
        check!(held.allowed(viewer.as_ref(), capability));
        Ok(Outcome::Ok(held))
    }

    /// A work item `actor` may change: theirs (`WorkItem::owner`), or one
    /// they may triage.
    pub(crate) async fn manageable_item(&self, actor: &User, workspace: &str, number: u32) -> Result<Outcome<Held>> {
        let held = check!(self.item_for(&Some(actor.clone()), workspace, number, Capability::Read).await?);
        if held.item.owner().id != actor.id {
            check!(held.allowed(Some(actor), Capability::Triage));
        }
        Ok(Outcome::Ok(held))
    }

    /// The next number of `workspace`'s sequence, for a work item, or for
    /// a pull request of `repo_id` ([`NEXT_NUMBER`]).
    pub(crate) async fn next_number(&self, workspace: &str, repo_id: Option<&str>) -> Result<u32> {
        let row = self
            .db
            .prepare(NEXT_NUMBER)
            .bind(&[workspace.to_lowercase().into(), repo_id.map_or(JsValue::NULL, JsValue::from)])?
            .first::<NumberRow>(None)
            .await?;
        row.map(|row| row.n).ok_or_else(|| worker::Error::RustError("no number was assigned".into()))
    }

    /// Records which workspace `repo` is in, its path and whether it is
    /// private, as repos just said.
    pub(crate) async fn remember_repo(&self, repo: &Repo) -> Result<()> {
        self.db
            .prepare(REMEMBER_REPO)
            .bind(&[
                repo.id.as_str().into(),
                repo.namespace.to_lowercase().into(),
                path_of(repo).into(),
                u32::from(repo.is_private).into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// The workspace repository `repo_id` is in: as recorded, or as repos
    /// says when it is not yet.
    pub(crate) async fn repo_workspace(&self, repo_id: &str) -> Result<Option<String>> {
        let recorded = self
            .db
            .prepare("SELECT workspace AS value FROM repo_workspaces WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<ValueRow>(None)
            .await?;
        if let Some(row) = recorded {
            return Ok(Some(row.value));
        }
        let path: Option<RepoPath> =
            g1t_kit::call(&self.repos, "path_by_id", &g1t_contracts::repos::PathByIdArgs { id: repo_id.to_owned() }).await?;
        Ok(path.map(|path| path.namespace.to_lowercase()))
    }

    /// Whether the job that moved issues into work items is done.
    pub(crate) async fn items_moved(&self) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT done_at AS value FROM work_jobs WHERE name = 'work_items' AND done_at IS NOT NULL")
            .first::<ValueRow>(None)
            .await?
            .is_some())
    }

    pub(crate) fn item_event(held: &Held) -> WorkItemEvent {
        WorkItemEvent {
            item_id: held.item.id.clone(),
            workspace: held.item.workspace.clone(),
            number: held.item.number,
            repo_ids: held.repo_ids(),
            author: Some((&held.item.author).into()),
            requested_by: held.item.requested_by.as_ref().map(Into::into),
            ..WorkItemEvent::default()
        }
    }

    /// Publishes a `work_item.*` event about `held`, filed under its origin.
    pub(crate) async fn publish_item(&self, kind: &'static str, held: &Held, actor: Option<&User>, data: WorkItemEvent) -> Result<()> {
        let data = g1t_contracts::events::marked(data, actor);
        self.publish_on(kind, held.event_repo(), actor.map(|actor| actor.id.clone()), data).await
    }

    /// Notes something that happened to a work item, in its conversation.
    pub(crate) async fn note_item<'a>(&self, item_id: &str, author: impl Into<crate::rows::By<'a>>, text: &str) -> Result<()> {
        self.note_on(crate::On::Item(item_id), author.into(), text).await
    }

    // --- RPC methods ----------------------------------------------------------

    pub(crate) async fn open_work_item(&self, a: OpenWorkItemArgs) -> Result<Outcome<WorkItem>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let title = match valid_title(&a.title) {
            Ok(title) => title.to_owned(),
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let Some(labels) = normalize_labels(&a.labels) else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("A work item can have up to {MAX_LABELS} labels of up to {MAX_LABEL_CHARS} characters each."),
            ));
        };
        let workspace = workspace_of(&a.workspace, a.repo.as_ref());
        if workspace.is_empty() {
            return Ok(Outcome::fail(FailureCode::Invalid, "Say which workspace, or which repository it is filed from."));
        }
        // Numbered only once the issues before it are, so every new number
        // comes after the old ones.
        if !self.items_moved().await? {
            return Ok(crate::labels::still_moving());
        }
        let actor = Some(a.actor.clone());
        // Where it is filed from: someone who may take part there may file
        // it; without one, only a member of the workspace.
        let origin = match &a.repo {
            Some(path) => {
                let repo = check!(self.repo(path, &actor).await?);
                if !repo.namespace.eq_ignore_ascii_case(&workspace) {
                    return Ok(Outcome::fail(FailureCode::Invalid, format!("{} is not a repository of {workspace}.", path_of(&repo))));
                }
                check!(crate::retired::writable(&repo));
                check!(crate::allowed(Some(&a.actor), &repo, Capability::Participate));
                if !self.work_items_enabled(&repo).await? {
                    return Ok(Outcome::fail(FailureCode::Forbidden, crate::settings::work_items_off(&repo)));
                }
                self.remember_repo(&repo).await?;
                Some(repo)
            }
            None => {
                if access::workspace_role(&a.actor, &workspace).is_none() {
                    return Ok(Outcome::fail(
                        FailureCode::Forbidden,
                        format!("Only members of {workspace} can file a work item there without a repository to file it from."),
                    ));
                }
                None
            }
        };
        let origin_ref = origin.as_ref().map(RepoRef::from);
        let may = |capability| access::can_item(Some(&a.actor), &workspace, origin_ref, capability);
        // Where it should land: repositories of the workspace the actor can see.
        let mut targets: Vec<Repo> = Vec::new();
        for path in &a.targets {
            let repo = check!(self.repo(path, &actor).await?);
            if !repo.namespace.eq_ignore_ascii_case(&workspace) {
                return Ok(Outcome::fail(FailureCode::Invalid, format!("{} is not a repository of {workspace}.", path_of(&repo))));
            }
            if origin.as_ref().is_some_and(|origin| origin.id == repo.id) || targets.iter().any(|known| known.id == repo.id) {
                continue;
            }
            self.remember_repo(&repo).await?;
            targets.push(repo);
        }
        if !targets.is_empty() && origin.is_some() && !may(Capability::Triage) {
            return Ok(Outcome::fail(FailureCode::Forbidden, access::needs_on_item(Capability::Triage, &workspace)));
        }
        let colors = check!(self.ensure_labels(&a.actor, &workspace, origin_ref, &labels).await?);
        let milestone = match a.milestone.filter(|number| *number > 0) {
            Some(number) => {
                if !may(Capability::Triage) {
                    return Ok(Outcome::fail(FailureCode::Forbidden, access::needs_on_item(Capability::Triage, &workspace)));
                }
                check!(self.milestone_ref(&workspace, number).await?)
            }
            None => None,
        };
        let now = now_ms();
        let id = new_id("wki", now);
        let number = self.next_number(&workspace, origin.as_ref().map(|repo| repo.id.as_str())).await?;
        let timestamp = rfc3339(now);
        let (author, requested_by) = authorship(&a.actor);
        let mut statements = vec![self
            .db
            .prepare(
                "INSERT INTO work_items
                   (id, workspace, number, title, body, labels, author_id, author_name, requested_by_id,
                    requested_by_name, created_at, updated_at, milestone)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                workspace.as_str().into(),
                number.into(),
                title.as_str().into(),
                a.body.trim().into(),
                serde_json::to_string(&labels)?.into(),
                author.id.as_str().into(),
                author.username.as_str().into(),
                optional(&requested_by.as_ref().map(|user| user.id.clone())),
                optional(&requested_by.as_ref().map(|user| user.username.clone())),
                timestamp.as_str().into(),
                timestamp.as_str().into(),
                optional_number(milestone.as_ref().map(|milestone| milestone.number)),
            ])?];
        let links = origin.iter().map(|repo| (repo, LinkRole::Origin)).chain(targets.iter().map(|repo| (repo, LinkRole::Target)));
        for (repo, role) in links {
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO work_item_repos (item_id, repo_id, role, path, added_at, added_by)
                         VALUES (?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        id.as_str().into(),
                        repo.id.as_str().into(),
                        role.as_str().into(),
                        path_of(repo).into(),
                        timestamp.as_str().into(),
                        a.actor.id.as_str().into(),
                    ])?,
            );
        }
        self.db.batch(statements).await?;
        let Some(held) = self.item_by_id(&id).await? else {
            return Ok(no_item());
        };
        self.publish_item("work_item.opened", &held, Some(&a.actor), WorkItemEvent { title: Some(held.item.title.clone()), ..Self::item_event(&held) })
            .await?;
        // Opened with labels and a milestone: each is said, as it would be
        // if they were added afterwards, without notes in the conversation.
        for label in &held.item.labels {
            let color = colors.iter().find(|(name, _)| name == label).map_or_else(|| label_color_for(label), |(_, c)| c.clone());
            let label = Some(EventLabel { name: label.clone(), color });
            self.publish_item("work_item.labeled", &held, Some(&a.actor), WorkItemEvent { label, ..Self::item_event(&held) }).await?;
        }
        if let Some(milestone) = milestone {
            self.publish_item(
                "work_item.milestoned",
                &held,
                Some(&a.actor),
                WorkItemEvent { milestone: Some(milestone), ..Self::item_event(&held) },
            )
            .await?;
        }
        Ok(Outcome::Ok(held.item))
    }

    pub(crate) async fn list_work_items(&self, a: ListWorkItemsArgs) -> Result<Outcome<Vec<WorkItem>>> {
        let workspace = workspace_of(&a.workspace, a.repo.as_ref());
        let repo = match &a.repo {
            Some(path) => {
                let repo = check!(self.repo(path, &a.viewer).await?);
                if !repo.namespace.eq_ignore_ascii_case(&workspace) {
                    return Ok(Outcome::Ok(Vec::new()));
                }
                Some(repo)
            }
            None => None,
        };
        let viewer = a.viewer.as_ref();
        let member = viewer.and_then(|user| access::workspace_role(user, &workspace)).is_some();
        let granted: Vec<&str> = viewer
            .map(|user| user.grants.iter().filter(|grant| grant.workspace.eq_ignore_ascii_case(&workspace)).map(|grant| grant.repo_id.as_str()).collect())
            .unwrap_or_default();
        let label = a
            .label
            .map(|label| label.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase())
            .filter(|label| !label.is_empty());
        let assignee = a.assignee.map(|name| name.trim().trim_start_matches('@').to_lowercase()).filter(|name| !name.is_empty());
        let state = state_name(a.state).map_or(JsValue::NULL, JsValue::from);
        let query = self
            .db
            .prepare(LIST_SQL.replace("{ITEM_COLUMNS}", ITEM_COLUMNS))
            .bind(&[
                workspace.as_str().into(),
                state,
                optional(&label),
                optional_number(a.milestone),
                optional(&assignee),
                optional(&repo.as_ref().map(|repo| repo.id.clone())),
                a.role.map_or(JsValue::NULL, |role| role.as_str().into()),
                u32::from(member).into(),
                serde_json::to_string(&granted)?.into(),
                LIST_PAGE.into(),
            ])?;
        let rows = self.timing.db(1, query.all()).await?.results::<ItemRow>()?;
        Ok(Outcome::Ok(
            rows.into_iter()
                .filter_map(ItemRow::held)
                .filter(|held| held.may(viewer, Capability::Read))
                .map(|held| held.item)
                .collect(),
        ))
    }

    /// A work item, the pull requests for it the viewer may see, and its
    /// comments and reactions.
    pub(crate) async fn get_work_item(&self, a: WorkItemViewArgs) -> Result<Outcome<WorkItemDetail>> {
        let held = check!(self.item_for(&a.viewer, &a.workspace, a.number, Capability::Read).await?);
        let key = [JsValue::from(held.item.id.as_str())];
        let statements = vec![
            self.db.prepare(format!("SELECT {PULL_COLUMNS} FROM pulls WHERE item_id = ?1 ORDER BY created_at")).bind(&key)?,
            self.db.prepare("SELECT * FROM comments WHERE item_id = ?1 ORDER BY id LIMIT 500").bind(&key)?,
            self.db.prepare(crate::reactions::ITEM_THREAD_SQL).bind(&key)?,
        ];
        let results = self.timing.db(3, self.db.batch(statements)).await?;
        let rows = |index: usize| results.get(index).ok_or_else(|| worker::Error::RustError("short batch".into()));
        let pulls: Vec<Pull> = rows(0)?.results::<PullRow>()?.into_iter().map(Pull::from).collect();
        let mut comments: Vec<Comment> = rows(1)?.results::<CommentRow>()?.into_iter().map(Comment::from).collect();
        let reacted = rows(2)?.results::<crate::reactions::ReactionRow>()?;
        let reactions = crate::reactions::attach(&reacted, &held.item.id, &mut comments);
        let pulls = self.readable_pulls(&a.viewer, pulls).await?;
        Ok(Outcome::Ok(WorkItemDetail { item: held.item, pulls, comments, reactions }))
    }

    /// Those of `pulls` whose repositories `viewer` may read, each naming
    /// the branch it merges into.
    pub(crate) async fn readable_pulls(&self, viewer: &Viewer, pulls: Vec<Pull>) -> Result<Vec<Pull>> {
        if pulls.is_empty() {
            return Ok(pulls);
        }
        let mut ids: Vec<String> = pulls.iter().map(|pull| pull.repo_id.clone()).collect();
        ids.sort();
        ids.dedup();
        let readable: Vec<Repo> = g1t_kit::call(&self.repos, "readable", &ReadableArgs { ids, viewer: viewer.clone() }).await?;
        Ok(pulls
            .into_iter()
            .filter_map(|mut pull| {
                let repo = readable.iter().find(|repo| repo.id == pull.repo_id)?;
                crate::fill_base(&mut pull, repo);
                Some(pull)
            })
            .collect())
    }

    pub(crate) async fn update_work_item(&self, a: UpdateWorkItemArgs) -> Result<Outcome<WorkItem>> {
        let held = check!(self.manageable_item(&a.actor, &a.workspace, a.number).await?);
        let title = match a.title.as_deref().map(valid_title) {
            Some(Err(message)) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            Some(Ok(title)) => Some(title.to_owned()),
            None => None,
        };
        if a.labels.as_deref().is_some_and(|labels| normalize_labels(labels).is_none()) {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                format!("A work item can have up to {MAX_LABELS} labels of up to {MAX_LABEL_CHARS} characters each."),
            ));
        }
        let assignees = match a.assignees {
            Some(names) => Some(check!(self.valid_assignees(names).await?)),
            None => None,
        };
        // What it is blocked by: checked before anything changes.
        let blocked_by = match &a.blocked_by {
            Some(asked) => Some(check!(self.checked_blocked_by(&held.item.workspace, held.item.number, asked).await?)),
            None => None,
        };
        // Its labels and milestone first: either can be refused, and then
        // nothing else changes.
        if let Some(number) = a.milestone {
            check!(self.set_milestone(&a.actor, &crate::labels::Labeled::Item(held.clone()), number).await?);
        }
        if let Some(labels) = &a.labels {
            check!(self.relabel(&a.actor, &crate::labels::Labeled::Item(held.clone()), labels).await?);
        }
        let assigned = assignees.as_ref().map(serde_json::to_string).transpose()?;
        let blocked_ids = match &blocked_by {
            Some(numbers) => Some(serde_json::to_string(&self.item_ids(&held.item.workspace, numbers).await?)?),
            None => None,
        };
        let body = a.body.map(|body| body.trim().to_owned());
        let updated_at = rfc3339(now_ms());
        let dependency = match &blocked_by {
            Some(after) => self.dependency_change(&held, after, &a.actor).await?,
            None => None,
        };
        let mut statements = vec![self
            .db
            .prepare(
                "UPDATE work_items
                 SET title = COALESCE(?, title), body = COALESCE(?, body),
                     assignees = COALESCE(?, assignees), blocked_by = COALESCE(?, blocked_by),
                     updated_at = ?
                 WHERE id = ?",
            )
            .bind(&[
                optional(&title),
                optional(&body),
                optional(&assigned),
                optional(&blocked_ids),
                updated_at.as_str().into(),
                held.item.id.as_str().into(),
            ])?];
        // A change to what it is blocked by reaches the sessions it concerns
        // with the change itself.
        let dependency_sent = match (&dependency, &blocked_ids) {
            (Some(data), Some(blocked)) => crate::coordination::updates::push_delivery(
                &mut statements,
                self.delivery_to(
                    "dependency.changed",
                    &held.repo_ids(),
                    data.clone(),
                    &format!("{}:blocked_by:{updated_at}", held.item.id),
                    "EXISTS (SELECT 1 FROM work_items WHERE id = ?7 AND blocked_by = ?8 AND updated_at = ?9)",
                    vec![held.item.id.as_str().into(), blocked.as_str().into(), updated_at.as_str().into()],
                )?,
            ),
            _ => None,
        };
        self.db.batch(statements).await?;
        let before = held.item.assignees.clone();
        let blocked_before = held.item.blocked_by.clone();
        let Some(held) = self.item_by_id(&held.item.id).await? else {
            return Ok(no_item());
        };
        self.publish_item("work_item.updated", &held, Some(&a.actor), Self::item_event(&held)).await?;
        if let Some(data) = dependency {
            self.delivered(dependency_sent, "dependency.changed", held.event_repo().unwrap_or_default(), Some(a.actor.id.clone()), data)
                .await?;
            self.blocked_by_changed(&held, &blocked_before, &a.actor).await?;
        }
        if let Some(assignees) = assignees {
            self.note_changes(crate::On::Item(&held.item.id), &a.actor, &before, &assignees, ("assigned", "unassigned")).await?;
            let added: Vec<String> = assignees.iter().filter(|name| !before.contains(name)).cloned().collect();
            self.publish_item(
                "work_item.assigned",
                &held,
                Some(&a.actor),
                WorkItemEvent { assignees: Some(assignees), added: Some(added), ..Self::item_event(&held) },
            )
            .await?;
        }
        Ok(Outcome::Ok(held.item))
    }

    /// The ids of the work items of `workspace` with these numbers, in the
    /// order given.
    pub(crate) async fn item_ids(&self, workspace: &str, numbers: &[u32]) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct IdNumber {
            id: String,
            number: u32,
        }
        if numbers.is_empty() {
            return Ok(Vec::new());
        }
        let rows = self
            .db
            .prepare("SELECT id, number FROM work_items WHERE workspace = ? AND number IN (SELECT value FROM json_each(?))")
            .bind(&[workspace.into(), serde_json::to_string(numbers)?.into()])?
            .all()
            .await?
            .results::<IdNumber>()?;
        Ok(numbers.iter().filter_map(|number| rows.iter().find(|row| row.number == *number).map(|row| row.id.clone())).collect())
    }

    pub(crate) async fn close_work_item(&self, args: CloseWorkItemArgs) -> Result<Outcome<WorkItem>> {
        let CloseWorkItemArgs { item: a, repo, commit } = args;
        let held = check!(self.manageable_item(&a.actor, &a.workspace, a.number).await?);
        if held.item.state == State::Closed {
            return Ok(Outcome::fail(FailureCode::Conflict, "This work item is already closed."));
        }
        // Closed by a commit on a repository's default branch: as its push
        // would have.
        if let Some(commit) = commit.as_deref() {
            if a.reason == Some(CloseReason::NotPlanned) {
                return Ok(Outcome::fail(FailureCode::Invalid, "A commit closes a work item as completed, not as not planned."));
            }
            let Some(path) = repo.as_ref() else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Say which repository the commit is in (repo)."));
            };
            let found = check!(self.repo(path, &Some(a.actor.clone())).await?);
            let (commit, named) = check!(self.closing_commit(&found, &held, commit, &a.actor).await?);
            let session = match named {
                Some(session) => Some(session),
                None => self.caller_session(&held, &a.actor).await?,
            };
            let landing = crate::closing::Landing { pull: None, commit: Some(commit), pushed_by: Some(a.actor.username.clone()) };
            self.land(&found, &landing, &a.actor, std::slice::from_ref(&held.item.id), &[], session.as_deref(), false).await?;
            return Ok(match self.item_by_id(&held.item.id).await? {
                Some(held) => Outcome::Ok(held.item),
                None => no_item(),
            });
        }
        let session = self.caller_session(&held, &a.actor).await?;
        let reason = a.reason.unwrap_or(CloseReason::Completed);
        let now = rfc3339(now_ms());
        self.db
            .prepare("UPDATE work_items SET state = 'closed', reason = ?, closed_at = ?, updated_at = ? WHERE id = ?")
            .bind(&[reason.as_str().into(), now.as_str().into(), now.as_str().into(), held.item.id.as_str().into()])?
            .run()
            .await?;
        self.publish_item(
            "work_item.closed",
            &held,
            Some(&a.actor),
            WorkItemEvent { reason: Some(reason.as_str()), session: session.clone(), ..Self::item_event(&held) },
        )
        .await?;
        let note = match reason {
            CloseReason::Completed => "closed this as completed",
            CloseReason::NotPlanned => "closed this as not planned",
        };
        self.note_item(&held.item.id, &a.actor, &crate::pushed::closed_note(note, session.as_deref())).await?;
        // Its claims end, and the work items it blocks hear (coordination/).
        self.item_resolved(&held, &a.actor, true, None).await;
        let mut item = held.item;
        item.state = State::Closed;
        item.reason = Some(reason);
        item.closed_at = Some(now.clone());
        item.updated_at = now;
        Ok(Outcome::Ok(item))
    }

    pub(crate) async fn reopen_work_item(&self, a: WorkItemActionArgs) -> Result<Outcome<WorkItem>> {
        let held = check!(self.manageable_item(&a.actor, &a.workspace, a.number).await?);
        if held.item.state == State::Open {
            return Ok(Outcome::fail(FailureCode::Conflict, "This work item is already open."));
        }
        let now = rfc3339(now_ms());
        // Reopened, nothing has landed for it any more.
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "UPDATE work_items
                         SET state = 'open', reason = NULL, resolutions = '[]', closed_at = NULL, updated_at = ?
                         WHERE id = ?",
                    )
                    .bind(&[now.as_str().into(), held.item.id.as_str().into()])?,
                self.db.prepare("UPDATE work_item_repos SET landed_at = NULL WHERE item_id = ?").bind(&[held.item.id.as_str().into()])?,
            ])
            .await?;
        self.publish_item("work_item.reopened", &held, Some(&a.actor), Self::item_event(&held)).await?;
        self.note_item(&held.item.id, &a.actor, "reopened this").await?;
        Ok(match self.item_by_id(&held.item.id).await? {
            Some(held) => Outcome::Ok(held.item),
            None => no_item(),
        })
    }

    pub(crate) async fn link_work_item(&self, a: LinkWorkItemArgs) -> Result<Outcome<WorkItem>> {
        self.relink(a, false).await
    }

    pub(crate) async fn unlink_work_item(&self, a: LinkWorkItemArgs) -> Result<Outcome<WorkItem>> {
        self.relink(a, true).await
    }

    async fn relink(&self, a: LinkWorkItemArgs, unlink: bool) -> Result<Outcome<WorkItem>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let held = check!(self.item_for(&Some(a.actor.clone()), &a.workspace, a.number, Capability::Triage).await?);
        let repo = check!(self.repo(&a.repo, &Some(a.actor.clone())).await?);
        let path = path_of(&repo);
        if !repo.namespace.eq_ignore_ascii_case(&held.item.workspace) {
            return Ok(Outcome::fail(FailureCode::Invalid, format!("{path} is not a repository of {}.", held.item.workspace)));
        }
        self.remember_repo(&repo).await?;
        let current = held.item.link(&repo.id).cloned();
        if current.as_ref().is_some_and(|link| link.role == LinkRole::Origin) {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("{path} is where this work item was filed; that link stays as it is."),
            ));
        }
        let now = rfc3339(now_ms());
        let (kind, role, text) = if unlink {
            let Some(link) = current else {
                return Ok(Outcome::fail(FailureCode::NotFound, format!("This work item is not linked to {path}.")));
            };
            self.db
                .prepare("DELETE FROM work_item_repos WHERE item_id = ? AND repo_id = ? AND role <> 'origin'")
                .bind(&[held.item.id.as_str().into(), repo.id.as_str().into()])?
                .run()
                .await?;
            ("work_item.unlinked", link.role, format!("unlinked {path}"))
        } else {
            if a.role == LinkRole::Origin {
                return Ok(Outcome::fail(FailureCode::Invalid, "A work item's origin is where it was filed; link a target instead."));
            }
            if current.as_ref().is_some_and(|link| link.role == a.role) {
                return Ok(Outcome::Ok(held.item));
            }
            self.db
                .prepare(
                    "INSERT INTO work_item_repos (item_id, repo_id, role, path, added_at, added_by)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT (item_id, repo_id) DO UPDATE SET role = excluded.role WHERE work_item_repos.role <> 'origin'",
                )
                .bind(&[
                    held.item.id.as_str().into(),
                    repo.id.as_str().into(),
                    a.role.as_str().into(),
                    path.as_str().into(),
                    now.as_str().into(),
                    a.actor.id.as_str().into(),
                ])?
                .run()
                .await?;
            let text = match a.role {
                LinkRole::Target => format!("added {path} as a target"),
                _ => format!("linked {path}"),
            };
            ("work_item.linked", a.role, text)
        };
        self.db
            .prepare("UPDATE work_items SET updated_at = ? WHERE id = ?")
            .bind(&[now.as_str().into(), held.item.id.as_str().into()])?
            .run()
            .await?;
        let Some(after) = self.item_by_id(&held.item.id).await? else {
            return Ok(no_item());
        };
        // An unlinked repository still hears that it was.
        let mut event = Self::item_event(&after);
        if unlink {
            event.repo_ids.push(repo.id.clone());
        }
        self.publish_item(kind, &after, Some(&a.actor), WorkItemEvent { repo: Some(path), role: Some(role), ..event }).await?;
        self.note_item(&after.item.id, &a.actor, &text).await?;
        Ok(Outcome::Ok(after.item))
    }

    /// What [`REF_SQL`] finds for `#number` in `repo_id` (or none) of
    /// `workspace`.
    pub(crate) async fn lookup_ref(&self, repo_id: Option<&str>, workspace: &str, number: u32) -> Result<RefRow> {
        Ok(self
            .db
            .prepare(REF_SQL)
            .bind(&[repo_id.map_or(JsValue::NULL, JsValue::from), workspace.to_lowercase().into(), number.into()])?
            .first::<RefRow>(None)
            .await?
            .unwrap_or_default())
    }

    /// `resolve_ref`: what `#number` names for the viewer, read in `repo`
    /// or in `workspace` (`refs`).
    pub(crate) async fn resolve_ref(&self, a: ResolveRefArgs) -> Result<RefTarget> {
        let (repo, workspace) = match &a.repo {
            Some(path) => match self.repo(path, &a.viewer).await? {
                Outcome::Ok(repo) => {
                    let workspace = repo.namespace.to_lowercase();
                    (Some(repo), workspace)
                }
                Outcome::Fail(_) => return Ok(RefTarget::None),
            },
            None => (None, a.workspace.trim().to_lowercase()),
        };
        if a.number == 0 || workspace.is_empty() {
            return Ok(RefTarget::None);
        }
        // What the viewer may not see is passed over for what comes next.
        let mut row = self.lookup_ref(repo.as_ref().map(|repo| repo.id.as_str()), &workspace, a.number).await?;
        for _ in 0..4 {
            let Some(named) = row.clone().named(repo.is_some()) else {
                return Ok(RefTarget::None);
            };
            match named {
                Named::PullHere => {
                    let repo = repo.as_ref().map(path_of).unwrap_or_default();
                    return Ok(RefTarget::Pull { repo, number: a.number });
                }
                Named::Item(id) => {
                    if let Some(held) = self.item_by_id(&id).await?
                        && held.may(a.viewer.as_ref(), Capability::Read)
                    {
                        return Ok(RefTarget::WorkItem { workspace: held.item.workspace, number: held.item.number, item_id: held.item.id });
                    }
                    if row.legacy.as_deref() == Some(id.as_str()) {
                        row.legacy = None;
                    } else {
                        row.item = None;
                    }
                }
                Named::PullThere(repo_id) => {
                    let readable: Vec<Repo> = g1t_kit::call(
                        &self.repos,
                        "readable",
                        &ReadableArgs { ids: vec![repo_id.clone()], viewer: a.viewer.clone() },
                    )
                    .await?;
                    return Ok(match readable.first() {
                        Some(other) => RefTarget::Pull { repo: path_of(other), number: a.number },
                        None => RefTarget::None,
                    });
                }
            }
        }
        Ok(RefTarget::None)
    }

    /// `legacy_item_map`: a page of where repositories' old issues went.
    pub(crate) async fn legacy_item_map(&self, a: LegacyItemMapArgs) -> Result<LegacyItemPage> {
        let limit = a.limit.clamp(1, 500);
        let items = self
            .db
            .prepare(
                "SELECT r.repo_id, r.legacy_number, i.workspace, i.number, i.id AS item_id
                 FROM work_item_repos r JOIN work_items i ON i.id = r.item_id
                 WHERE r.legacy_number IS NOT NULL AND i.number IS NOT NULL AND (?1 IS NULL OR i.id > ?1)
                 ORDER BY i.id LIMIT ?2",
            )
            .bind(&[optional(&a.after), limit.into()])?
            .all()
            .await?
            .results::<MigratedItem>()?;
        let next = (items.len() as u32 == limit).then(|| items.last().map(|item| item.item_id.clone())).flatten();
        Ok(LegacyItemPage { items, next })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn a_landing_is_named_by_its_pull_request_or_commit() {
        assert_eq!(landing_note("acme/web", Some(12), None), "acme/web#12");
        assert_eq!(landing_note("acme/web", None, Some("abcdef1234")), "acme/web@abcdef1");
        assert_eq!(workspace_of(" ", Some(&RepoPath { namespace: "Acme".into(), name: "web".into() })), "acme");
        assert_eq!(workspace_of("Globex", None), "globex");
    }

    #[test]
    fn a_reference_names_the_first_thing_found_in_order() {
        let row = |pull_here: bool, legacy: Option<&str>, item: Option<&str>, there: Option<&str>| RefRow {
            pull_here: pull_here.then_some(1),
            legacy: legacy.map(str::to_owned),
            item: item.map(str::to_owned),
            pull_there: there.map(str::to_owned),
        };
        // In a repository: its own pull request, then its old issue, then
        // the workspace's item, then another repository's pull request.
        assert_eq!(row(true, Some("iss_1"), Some("wki_1"), None).named(true), Some(Named::PullHere));
        assert_eq!(row(false, Some("iss_1"), Some("wki_1"), None).named(true), Some(Named::Item("iss_1".into())));
        assert_eq!(row(false, None, Some("wki_1"), Some("rep_2")).named(true), Some(Named::Item("wki_1".into())));
        assert_eq!(row(false, None, None, Some("rep_2")).named(true), Some(Named::PullThere("rep_2".into())));
        // In a workspace alone: its item, then a pull request.
        assert_eq!(row(false, None, Some("wki_1"), Some("rep_2")).named(false), Some(Named::Item("wki_1".into())));
        assert_eq!(row(false, None, None, None).named(false), None);
    }
}
