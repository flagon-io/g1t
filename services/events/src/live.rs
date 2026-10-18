//! Live repository pages: every event a repository page shows is passed to
//! the notify service as a small change (`g1t_contracts::live`), which
//! tells the people watching that repository's pages. One call per batch
//! (more for a very busy one); nothing written in the repository goes
//! along, and who may see it is notify's to keep: a tab watches a
//! repository only after the site checked its person may read it.
//!
//! A work item's events and comments go to its origin (the event's own
//! repository, which it may not have) and to its workspace's Work pages
//! (`workspace_changed`), which hear of it with or without a repository.
//! The other repositories it is linked to (`repoIds`) hear of it only when
//! their readers may all read it: when its origin is public. A private
//! one's kind and number are not for whoever reads a repository it only
//! names, nor is an item with no origin, which is its workspace's alone.

use g1t_contracts::events::Event;
use g1t_contracts::live::{
    MAX_CHANGES, REPO_CHANGED, RepoChange, RepoChangedArgs, WORKSPACE_CHANGED, WorkspaceChangedArgs, change_of, workspace_changes_of,
};
use g1t_contracts::repos::{MAX_READABLE, ReadableArgs, Repo};
use std::collections::HashSet;
use worker::{Fetcher, Result};

/// The changes an event makes: one for its repository, and one for each
/// other repository it names in `repoIds` when the event's repository (a
/// work item's origin) is among the `public` ones.
pub(crate) fn changes_for(event: &Event, public: &HashSet<String>) -> Vec<RepoChange> {
    let linked_to = event.data["repoIds"].as_array().is_some_and(|ids| !ids.is_empty());
    let origin = event.repo_id.as_deref().filter(|id| !id.is_empty());
    // A work item's origin is the event's own repository, never a
    // `repoId` in its data.
    let mut changes: Vec<RepoChange> = if linked_to && origin.is_none() {
        Vec::new()
    } else {
        change_of(event).into_iter().collect()
    };
    if !origin.is_some_and(|origin| public.contains(origin)) {
        return changes;
    }
    for repo_id in event.data["repoIds"].as_array().into_iter().flatten().filter_map(|id| id.as_str()) {
        if repo_id.is_empty() || changes.iter().any(|change| change.repo_id == repo_id) {
            continue;
        }
        let linked = Event { repo_id: Some(repo_id.to_owned()), ..event.clone() };
        changes.extend(change_of(&linked));
    }
    changes
}

/// A batch's changes, in order, in calls of at most [`MAX_CHANGES`].
pub(crate) fn changes_of(events: &[Event], public: &HashSet<String>) -> Vec<Vec<RepoChange>> {
    let changes: Vec<RepoChange> = events.iter().flat_map(|event| changes_for(event, public)).collect();
    changes.chunks(MAX_CHANGES).map(<[RepoChange]>::to_vec).collect()
}

/// Which of these repositories anyone may read, in one `readable` call
/// with no viewer. None when the repos service cannot say: nothing is
/// taken to be public that is not known to be.
pub(crate) async fn public_of(repos: &Fetcher, ids: Vec<String>) -> HashSet<String> {
    if ids.is_empty() {
        return HashSet::new();
    }
    let readable: Result<Vec<Repo>> = g1t_kit::call(repos, "readable", &ReadableArgs { ids, viewer: None }).await;
    match readable {
        Ok(repos) => repos.into_iter().map(|repo| repo.id).collect(),
        Err(error) => {
            worker::console_error!("events: could not tell which repositories are public: {error}");
            HashSet::new()
        }
    }
}

/// The origins of the batch's events that name other repositories
/// (`repoIds`): the ones whose publicness decides who else hears.
fn origins_linked(events: &[Event]) -> Vec<String> {
    let origins: HashSet<String> = events
        .iter()
        .filter(|event| event.data["repoIds"].as_array().is_some_and(|ids| ids.len() > 1))
        .filter_map(|event| event.repo_id.clone().filter(|id| !id.is_empty()))
        .collect();
    origins.into_iter().take(MAX_READABLE).collect()
}

/// Tells notify of the batch's changes. Logged and left when it cannot be
/// reached: pages then catch up by themselves, and nothing else waits on it.
pub(crate) async fn tell(notify: &Fetcher, repos: &Fetcher, events: &[Event]) {
    let public = public_of(repos, origins_linked(events)).await;
    for changes in changes_of(events, &public) {
        let told: Result<serde_json::Value> = g1t_kit::call(notify, REPO_CHANGED, &RepoChangedArgs { changes }).await;
        if let Err(error) = told {
            worker::console_error!("events: live pages not told: {error}");
        }
    }
    for changes in workspace_changes_of(events) {
        let told: Result<serde_json::Value> = g1t_kit::call(notify, WORKSPACE_CHANGED, &WorkspaceChangedArgs { changes }).await;
        if let Err(error) = told {
            worker::console_error!("events: live Work pages not told: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(kind: &str, repo_id: Option<&str>, data: serde_json::Value) -> Event {
        Event {
            id: "evt_1".into(),
            kind: kind.into(),
            source: "work".into(),
            time: "2026-10-11T10:00:00Z".into(),
            repo_id: repo_id.map(Into::into),
            actor: None,
            data,
        }
    }

    fn public(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn a_public_work_item_changes_every_repository_it_is_linked_to() {
        let data = json!({ "itemId": "wki_1", "workspace": "acme", "number": 40, "repoIds": ["rep_1", "rep_2"] });
        let with_origin = event("work_item.updated", Some("rep_1"), data);
        let repos: Vec<_> = changes_for(&with_origin, &public(&["rep_1"])).into_iter().map(|change| (change.repo_id, change.number)).collect();
        assert_eq!(repos, vec![("rep_1".to_owned(), Some(40)), ("rep_2".to_owned(), Some(40))]);
        assert_eq!(origins_linked(&[with_origin]), vec!["rep_1".to_owned()]);
        // What changes no page stays quiet.
        assert!(changes_for(&event("audit.recorded", None, json!({ "repoIds": ["rep_1"] })), &public(&["rep_1"])).is_empty());
    }

    #[test]
    fn a_private_work_item_changes_only_its_origin() {
        let repos = |event: &Event| changes_for(event, &public(&["rep_9"])).into_iter().map(|change| change.repo_id).collect::<Vec<_>>();
        // Its origin is private: the repositories it only names hear nothing.
        let data = json!({ "itemId": "wki_1", "workspace": "acme", "number": 40, "repoIds": ["rep_1", "rep_2"] });
        assert_eq!(repos(&event("work_item.updated", Some("rep_1"), data)), vec!["rep_1".to_owned()]);
        // Filed in the workspace: no repository hears of it, not even the
        // first it is linked to, nor one its data names.
        let filed = json!({ "itemId": "wki_1", "workspace": "acme", "number": 40, "repoId": "rep_2", "repoIds": ["rep_2", "rep_9"] });
        assert!(repos(&event("work_item.linked", None, filed.clone())).is_empty());
        assert!(repos(&event("comment.created", None, filed)).is_empty());
    }
}
