//! Live repository pages: every event a repository page shows is passed to
//! the notify service as a small change (`g1t_contracts::live`), which
//! tells the people watching that repository's pages. One call per batch
//! (more for a very busy one); nothing written in the repository goes
//! along, and who may see it is notify's to keep: a tab watches a
//! repository only after the site checked its person may read it.

use g1t_contracts::events::Event;
use g1t_contracts::live::{REPO_CHANGED, RepoChangedArgs, changes_of};
use worker::{Fetcher, Result};

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
