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
use g1t_contracts::Outcome;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::rows::path_of;
use crate::Work;
use crate::rows::ValueRow;

/// The most work items one pull request or commit closes this way.
pub(crate) const MAX_CLOSES: usize = refs::MAX_REFS;

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
        // Read in a repository the viewer may not read (a member without
        // Code following an old link), `#N` still names the work items
        // they may see; its pull requests stay out of reach.
        let (repo, workspace) = match &a.repo {
            Some(path) => match self.repo(path, &a.viewer).await? {
                Outcome::Ok(repo) => {
                    let workspace = repo.namespace.to_lowercase();
                    (Some((repo.id.clone(), Some(path_of(&repo)))), workspace)
                }
                Outcome::Fail(_) => match self.recorded_repo(&format!("{}/{}", path.namespace, path.name)).await? {
                    Some((id, workspace)) => (Some((id, None)), workspace),
                    None => return Ok(RefTarget::None),
                },
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

    /// The id and workspace of the repository at `path` (`owner/name`), as
    /// recorded, whoever is asking.
    async fn recorded_repo(&self, path: &str) -> Result<Option<(String, String)>> {
        #[derive(Deserialize)]
        struct Recorded {
            repo_id: String,
            workspace: String,
        }
        Ok(self
            .db
            .prepare("SELECT repo_id, workspace FROM repo_workspaces WHERE lower(path) = lower(?)")
            .bind(&[path.into()])?
            .first::<Recorded>(None)
            .await?
            .map(|found| (found.repo_id, found.workspace)))
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
                    match known {
                        Some(row) => (Some(row.value), true),
                        None => (None, false),
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

    /// The work items `text`, written in `repo`, closes and is part of,
    /// with `own` (a pull request's own work item) closed first.
    pub(super) async fn named_items(&self, repo: &Repo, own: Option<&str>, text: &str) -> Result<NamedItems> {
        let named = refs::named(text);
        let mut closes: Vec<String> = own.map(str::to_owned).into_iter().collect();
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
                && !parts.contains(&id)
            {
                parts.push(id);
            }
        }
        closes.truncate(MAX_CLOSES);
        parts.truncate(MAX_CLOSES);
        let mut all = closes.clone();
        all.extend(parts.iter().cloned());
        let held = self.items_by_ids(&all).await?;
        let number = |id: &String| held.iter().find(|held| held.item.id == *id).map(|held| (id.clone(), held.item.number));
        Ok(NamedItems { closes: closes.iter().filter_map(number).collect(), parts: parts.iter().filter_map(number).collect() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
