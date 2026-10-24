//! What `#N` names (`g1t_contracts::work::refs`): read in a repository or
//! a workspace alone, and the work items a text closes and is part of.
//!
//! A closing keyword followed by a reference (`Fixes #12`, `closes: #3`,
//! `Resolves flagon-io/g1t#40`) names a work item to close; `Part of #12`
//! or `Refs #12` one it is part of. Each is read in the repository the
//! pull request or commit is in, and only work items of that repository's
//! workspace count: another workspace's are never closed from here.

use g1t_contracts::access::Capability;
use g1t_contracts::repos::{ReadableArgs, Repo};
use g1t_contracts::work::refs::{self, Lookup, Ref, RefScope, first_found};
use g1t_contracts::work::*;
use g1t_contracts::{Outcome, User};
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::rows::{Held, path_of};
use crate::Work;
use crate::rows::ValueRow;

/// The most work items one pull request or commit closes this way.
pub(crate) const MAX_CLOSES: usize = refs::MAX_REFS;

/// What `#N` could name, read in repository `?1` (NULL for none) of
/// workspace `?2`: a pull request of the repository, a work item of the
/// workspace filed there under that old number (a repository moved in from
/// another workspace brings old numbers that name that workspace's work
/// items, never this one's), the workspace's work item, and a pull request
/// of that number in the workspace's other repositories. Only a number
/// above the workspace's floor (`work_counters.floor`, the highest any of
/// its repositories used on its own) is the workspace's alone; one at or
/// below it may be any of its repositories' old pull requests, and names
/// none of them from elsewhere.
pub(crate) const REF_SQL: &str = "SELECT
     (SELECT 1 FROM pulls WHERE repo_id = ?1 AND number = ?3) AS pull_here,
     (SELECT item_id FROM work_item_repos WHERE repo_id = ?1 AND legacy_number = ?3
        AND item_id IN (SELECT id FROM work_items WHERE workspace = ?2 OR workspace IS NULL)) AS legacy,
     (SELECT id FROM work_items WHERE workspace = ?2 AND number = ?3) AS item,
     (SELECT repo_id FROM pulls WHERE number = ?3 AND repo_id IS NOT ?1
        AND repo_id IN (SELECT repo_id FROM repo_workspaces WHERE workspace = ?2)
        AND number > COALESCE((SELECT floor FROM work_counters WHERE workspace = ?2), 0)
      ORDER BY created_at DESC LIMIT 1) AS pull_there";

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

/// The work items a text names, by id and number, in the order named.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct NamedItems {
    pub closes: Vec<(String, u32)>,
    pub parts: Vec<(String, u32)>,
}

impl NamedItems {
    pub(crate) fn close_ids(&self) -> Vec<String> {
        self.closes.iter().map(|(id, _)| id.clone()).collect()
    }

    pub(crate) fn part_ids(&self) -> Vec<String> {
        self.parts.iter().map(|(id, _)| id.clone()).collect()
    }

    pub(crate) fn close_numbers(&self) -> Vec<u32> {
        self.closes.iter().map(|(_, number)| *number).collect()
    }

    pub(crate) fn part_numbers(&self) -> Vec<u32> {
        self.parts.iter().map(|(_, number)| *number).collect()
    }
}

impl Work {
    /// What [`REF_SQL`] finds for `#number` in `repo_id` (or none) of
    /// `workspace`.
    pub(super) async fn lookup_ref(&self, repo_id: Option<&str>, workspace: &str, number: u32) -> Result<RefRow> {
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
        // Read in a repository the viewer may not read, `#N` names
        // nothing, exactly as in one that does not exist: anything else
        // would tell them a private repository is there.
        let (repo, workspace) = match &a.repo {
            Some(path) => match read_in(self.repo(path, &a.viewer).await?) {
                Some(repo) => {
                    let workspace = repo.namespace.to_lowercase();
                    (Some((repo.id.clone(), Some(path_of(&repo)))), workspace)
                }
                None => return Ok(RefTarget::None),
            },
            None => (None, a.workspace.trim().to_lowercase()),
        };
        if a.number == 0 || workspace.is_empty() {
            return Ok(RefTarget::None);
        }
        // What the viewer may not see is passed over for what comes next.
        let mut row = self.lookup_ref(repo.as_ref().map(|(id, _)| id.as_str()), &workspace, a.number).await?;
        for _ in 0..4 {
            let Some(named) = row.clone().named(repo.is_some()) else {
                return Ok(RefTarget::None);
            };
            match named {
                Named::PullHere => match repo.as_ref().and_then(|(_, path)| path.clone()) {
                    Some(repo) => return Ok(RefTarget::Pull { repo, number: a.number }),
                    None => row.pull_here = None,
                },
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
                    let readable: Vec<Repo> =
                        g1t_kit::call(&self.repos, "readable", &ReadableArgs { ids: vec![repo_id.clone()], viewer: a.viewer.clone() })
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

    /// The work item `reference` names, read in `repo`: its id, when it is
    /// one of the workspace's work items.
    pub(super) async fn ref_item(&self, repo: &Repo, reference: &Ref) -> Result<Option<String>> {
        let workspace = repo.namespace.to_lowercase();
        let (repo_id, in_repo) = match &reference.scope {
            RefScope::Here => (Some(repo.id.clone()), true),
            RefScope::Workspace(named) => {
                if *named != workspace {
                    return Ok(None);
                }
                (None, false)
            }
            RefScope::Repo(path) => {
                if !path.namespace.eq_ignore_ascii_case(&workspace) {
                    return Ok(None);
                }
                let named = format!("{}/{}", path.namespace, path.name);
                if named.eq_ignore_ascii_case(&path_of(repo)) {
                    (Some(repo.id.clone()), true)
                } else {
                    let known = self
                        .db
                        .prepare("SELECT repo_id AS value FROM repo_workspaces WHERE lower(path) = lower(?)")
                        .bind(&[named.as_str().into()])?
                        .first::<ValueRow>(None)
                        .await?;
                    // A repository not known names nothing, as resolve_ref
                    // reads it: never the workspace's work item of that number.
                    match known {
                        Some(row) => (Some(row.value), true),
                        None => return Ok(None),
                    }
                }
            }
        };
        let found = self.lookup_ref(repo_id.as_deref(), &workspace, reference.number).await?;
        Ok(match found.named(in_repo) {
            Some(Named::Item(id)) => Some(id),
            _ => None,
        })
    }

    /// What `reference` names read in `repo_id` of `workspace`, and the
    /// repository it is read in ([`super::resolve_in`]).
    pub(super) async fn resolve_in(&self, repo_id: &str, workspace: &str, reference: &Ref) -> Result<Option<(String, Named)>> {
        let read_in = match &reference.scope {
            RefScope::Here => Some(repo_id.to_owned()),
            RefScope::Workspace(named) => {
                if !named.eq_ignore_ascii_case(workspace) {
                    return Ok(None);
                }
                None
            }
            RefScope::Repo(path) => {
                if !path.namespace.eq_ignore_ascii_case(workspace) {
                    return Ok(None);
                }
                let known = self
                    .db
                    .prepare("SELECT repo_id AS value FROM repo_workspaces WHERE lower(path) = lower(?)")
                    .bind(&[format!("{}/{}", path.namespace, path.name).into()])?
                    .first::<ValueRow>(None)
                    .await?;
                match known {
                    Some(row) => Some(row.value),
                    None => return Ok(None),
                }
            }
        };
        let found = self.lookup_ref(read_in.as_deref(), workspace, reference.number).await?;
        Ok(found.named(read_in.is_some()).map(|named| (read_in.unwrap_or_else(|| repo_id.to_owned()), named)))
    }

    /// The work items `text`, written in `repo`, closes and is part of,
    /// with `own` (a pull request's own work item) closed first. Each of
    /// `who` (whoever wrote it, merges it or pushed it) must be able to
    /// see what it names ([`admits`]); what one of them may not is left
    /// unresolved, as a reference to nothing.
    pub(super) async fn named_items(&self, repo: &Repo, own: Option<&str>, text: &str, who: &[&User]) -> Result<NamedItems> {
        let named = refs::named(text);
        let mut closes: Vec<String> = Vec::new();
        for reference in &named.closes {
            if let Some(id) = self.ref_item(repo, reference).await?
                && !closes.contains(&id)
            {
                closes.push(id);
            }
        }
        let mut parts: Vec<String> = Vec::new();
        for reference in &named.parts {
            if let Some(id) = self.ref_item(repo, reference).await?
                && !closes.contains(&id)
                && own != Some(id.as_str())
                && !parts.contains(&id)
            {
                parts.push(id);
            }
        }
        let mut all: Vec<String> = own.map(str::to_owned).into_iter().collect();
        all.extend(closes.iter().take(MAX_CLOSES * 2).cloned());
        all.extend(parts.iter().take(MAX_CLOSES * 2).cloned());
        let held = self.items_by_ids(&all).await?;
        let found = |id: &String| held.iter().find(|held| held.item.id == *id);
        // Its own work item first, whoever may see it: the pull request
        // was made for it.
        let mut closing: Vec<(String, u32)> =
            own.map(str::to_owned).into_iter().filter_map(|id| found(&id).map(|held| (id, held.item.number))).collect();
        for id in &closes {
            if let Some(held) = found(id).filter(|held| admits(held, who, true))
                && !closing.iter().any(|(known, _)| known == id)
            {
                closing.push((id.clone(), held.item.number));
            }
        }
        let mut parted: Vec<(String, u32)> = Vec::new();
        for id in &parts {
            if let Some(held) = found(id).filter(|held| admits(held, who, false)) {
                parted.push((id.clone(), held.item.number));
            }
        }
        closing.truncate(MAX_CLOSES);
        parted.truncate(MAX_CLOSES);
        Ok(NamedItems { closes: closing, parts: parted })
    }
}

/// The repository `#N` is read in, as the viewer found it: none when they
/// may not read it, exactly as when there is no such repository.
fn read_in<T>(found: Outcome<T>) -> Option<T> {
    match found {
        Outcome::Ok(repo) => Some(repo),
        Outcome::Fail(_) => None,
    }
}

/// Whether everyone in `who` may have `held` closed (`closing`: they may
/// triage it) or linked as something they are part of (they may see it).
pub(crate) fn admits(held: &Held, who: &[&User], closing: bool) -> bool {
    let capability = if closing { Capability::Triage } else { Capability::Read };
    who.iter().all(|user| held.may(Some(user), capability))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repository_the_viewer_may_not_read_is_read_as_none() {
        assert_eq!(read_in(Outcome::<u8>::fail(g1t_contracts::FailureCode::NotFound, "Repository not found.")), None);
        assert_eq!(read_in(Outcome::Ok(1)), Some(1));
    }

    #[test]
    fn only_what_everyone_involved_may_see_is_closed_or_linked() {
        use crate::items::rows_for_test::{held_for_test, person_for_test};
        let member = person_for_test("usr_2", Some("acme"));
        // An outside collaborator with Write on public acme/web.
        let mut outsider = person_for_test("usr_9", None);
        outsider.grants.push(g1t_contracts::access::RepoGrant {
            repo_id: "rep_web".into(),
            workspace: "acme".into(),
            role: g1t_contracts::access::RepoRole::Write,
            team: None,
        });
        let filed_in_web = held_for_test(1, &[("rep_web", "origin", "acme", false)], &[]);
        let members_only = held_for_test(2, &[("rep_web", "target", "acme", false)], &[]);
        let private = held_for_test(3, &[("rep_secret", "origin", "acme", true)], &[]);
        assert!(admits(&filed_in_web, &[&outsider], true));
        assert!(!admits(&members_only, &[&outsider], true));
        assert!(!admits(&members_only, &[&outsider], false));
        assert!(!admits(&private, &[&outsider], true));
        assert!(admits(&private, &[&member], true));
        // Merged by a member, written by the outsider: what both may.
        assert!(!admits(&private, &[&member, &outsider], true));
        // Someone who may only read a public work item may not close it.
        let reader = person_for_test("usr_8", None);
        assert!(admits(&filed_in_web, &[&reader], false));
        assert!(!admits(&filed_in_web, &[&reader], true));
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
