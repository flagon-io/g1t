//! Live repository pages: every event a repository page shows is passed to
//! the notify service as a small change (`g1t_contracts::live`), which
//! tells the people watching that repository's pages. One call per batch
//! (more for a very busy one); nothing written in the repository goes
//! along, and who may see it is notify's to keep: a tab watches a
//! repository only after the site checked its person may read it.
//!
//! A work item's events and comments go to every repository it is linked
//! to (`repoIds`), not only its origin, which it may not have.

use g1t_contracts::events::Event;
use g1t_contracts::live::{MAX_CHANGES, REPO_CHANGED, RepoChange, RepoChangedArgs, change_of};
use worker::{Fetcher, Result};

/// The changes an event makes: one for its repository, and one for each
/// other repository it names in `repoIds`.
pub(crate) fn changes_for(event: &Event) -> Vec<RepoChange> {
    let mut changes: Vec<RepoChange> = change_of(event).into_iter().collect();
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
pub(crate) fn changes_of(events: &[Event]) -> Vec<Vec<RepoChange>> {
    let changes: Vec<RepoChange> = events.iter().flat_map(changes_for).collect();
    changes.chunks(MAX_CHANGES).map(<[RepoChange]>::to_vec).collect()
}

/// Tells notify of the batch's changes. Logged and left when it cannot be
/// reached: pages then catch up by themselves, and nothing else waits on it.
pub(crate) async fn tell(notify: &Fetcher, events: &[Event]) {
    for changes in changes_of(events) {
        let told: Result<serde_json::Value> = g1t_kit::call(notify, REPO_CHANGED, &RepoChangedArgs { changes }).await;
        if let Err(error) = told {
            worker::console_error!("events: live pages not told: {error}");
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

    #[test]
    fn a_work_item_changes_every_repository_it_is_linked_to() {
        let data = json!({ "itemId": "wki_1", "workspace": "acme", "number": 40, "repoIds": ["rep_1", "rep_2"] });
        let repos = |event: &Event| changes_for(event).into_iter().map(|change| (change.repo_id, change.number)).collect::<Vec<_>>();
        let with_origin = event("work_item.updated", Some("rep_1"), data.clone());
        assert_eq!(repos(&with_origin), vec![("rep_1".to_owned(), Some(40)), ("rep_2".to_owned(), Some(40))]);
        // Filed in the workspace: only the repositories it is linked to.
        let without = event("work_item.linked", None, data);
        assert_eq!(repos(&without).len(), 2);
        // What changes no page stays quiet.
        assert!(changes_for(&event("audit.recorded", None, json!({ "repoIds": ["rep_1"] }))).is_empty());
    }
}
