//! A pull request's title, description and own work item, changed after
//! it opens (`update_pull` with `title`, `body` or `item`).
//!
//! Whoever opened it (or asked g1t for it) may, and anyone with the Write
//! role. Its own work item changes only for someone who can see the one it
//! had and the one it gets. After the change, the work items it closes and
//! is part of are read again from its title and description
//! (`items::named`, refs.rs), under the same rules as when it opened: its
//! own work item first, and only what both the editor and its author may
//! see. Those it no longer names are dropped and those it newly names are
//! added, in `closes_items` and `parts`.
//!
//! A merged or closed pull request's title and description can still be
//! corrected, and nothing else. A merged one's `closes_items` and `parts`
//! are what it landed when it merged (`items::land`): an edit never changes
//! them, so the record of what landed stays true. Its work item is frozen
//! for the same reason, and a closed one's waits until it is reopened.

use g1t_contracts::access::Capability;
use g1t_contracts::events::PullEvent;
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, User};
use g1t_kit::now_ms;
use serde_json::{Value, json};
use worker::Result;

use crate::items::{self, Held};
use crate::{Work, allowed, optional, valid_title};

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

/// What an edit asks for, tidied: each `None` is left as it is.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Edit {
    pub title: Option<String>,
    /// `Some(None)` takes the description away.
    pub body: Option<Option<String>>,
    /// Its own work item by number; `Some(None)` takes it away.
    pub item: Option<Option<u32>>,
}

impl Edit {
    /// What `update_pull` was given, or why it is not an edit.
    pub(crate) fn asked(title: Option<&str>, body: Option<&str>, item: Option<u32>) -> std::result::Result<Edit, &'static str> {
        let title = title.map(valid_title).transpose()?.map(str::to_owned);
        let body = body.map(|body| Some(body.trim().to_owned()).filter(|body| !body.is_empty()));
        let item = item.map(|number| Some(number).filter(|number| *number > 0));
        Ok(Edit { title, body, item })
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.title.is_none() && self.body.is_none() && self.item.is_none()
    }

    /// Only its title and description, which a merged or closed pull
    /// request can still take.
    pub(crate) fn text_only(&self) -> bool {
        self.item.is_none()
    }
}

/// Why a pull request of `status` cannot take `edit`, when it cannot.
pub(crate) fn refusal(status: PullStatus, edit: &Edit) -> Option<&'static str> {
    match status {
        _ if edit.text_only() => None,
        PullStatus::Merged => Some("A merged pull request keeps the work item it landed. Its title and description can still change."),
        PullStatus::Closed => Some("Reopen this pull request to change its work item. Its title and description can still change."),
        PullStatus::Draft | PullStatus::Open => None,
    }
}

/// What it was before, as `pull.edited`'s `changes`: only what changed.
pub(crate) fn changes(before: (&str, Option<&str>, Option<u32>), after: (&str, Option<&str>, Option<u32>)) -> Option<Value> {
    let mut changes = serde_json::Map::new();
    if before.0 != after.0 {
        changes.insert("title".to_owned(), json!({ "from": before.0 }));
    }
    if before.1 != after.1 {
        changes.insert("body".to_owned(), json!({ "from": before.1 }));
    }
    if before.2 != after.2 {
        changes.insert("item".to_owned(), json!({ "from": before.2 }));
    }
    (!changes.is_empty()).then_some(Value::Object(changes))
}

/// The pull request's conversation line for a new title.
pub(crate) fn title_note(before: &str, after: &str) -> String {
    format!("changed the title from “{before}” to “{after}”")
}

/// The pull request's conversation line for its own work item changing.
pub(crate) fn item_note(before: Option<u32>, after: Option<u32>) -> Option<String> {
    match (before, after) {
        (Some(before), Some(after)) if before != after => Some(format!("changed its work item from #{before} to #{after}")),
        (None, Some(after)) => Some(format!("made this for #{after}")),
        (Some(before), None) => Some(format!("took this off #{before}")),
        _ => None,
    }
}

/// An edit checked and ready to make.
pub(crate) struct Ready {
    repo: Repo,
    edit: Edit,
    /// With `edit.item`: the work item it gets, if any.
    item: Option<Held>,
    /// With `edit.item`: the work item it had, if any.
    had: Option<Held>,
}

impl Work {
    /// Checks an edit of `pull` by `actor` before anything changes: who may,
    /// whether its status allows it, and the work items it names. `None`
    /// when nothing is asked.
    pub(crate) async fn ready_pull_edit(&self, actor: &User, path: &RepoPath, pull: &Pull, edit: Edit) -> Result<Outcome<Option<Ready>>> {
        if edit.is_empty() {
            return Ok(Outcome::Ok(None));
        }
        let repo = check!(self.repo(path, &Some(actor.clone())).await?);
        // Its author, or whoever asked g1t for it; anyone else needs Write.
        if !pull.is_owned_by(&actor.id) {
            check!(allowed(Some(actor), &repo, Capability::Push));
        }
        if let Some(refused) = refusal(pull.status, &edit) {
            return Ok(Outcome::fail(FailureCode::Conflict, refused));
        }
        let (mut item, mut had) = (None, None);
        if let Some(wanted) = edit.item {
            had = items::for_pull(self, &pull.id).await?;
            // One it had that they may not see is not theirs to take away.
            if had.as_ref().is_some_and(|held| !held.may(Some(actor), Capability::Read)) {
                return Ok(Outcome::fail(FailureCode::Forbidden, "You can't see this pull request's work item, so you can't change it."));
            }
            if let Some(number) = wanted {
                let workspace = repo.namespace.to_lowercase();
                let held = check!(items::for_viewer(self, &Some(actor.clone()), &workspace, number, Capability::Read).await?);
                if held.item.state != State::Open {
                    return Ok(Outcome::fail(FailureCode::Conflict, "This work item is closed."));
                }
                item = Some(held);
            }
        }
        Ok(Outcome::Ok(Some(Ready { repo, edit, item, had })))
    }

    /// Makes an edit [`Work::ready_pull_edit`] checked: its title,
    /// description and work item, then the work items it closes and is part
    /// of, read again (never a merged one's); a line in its conversation and
    /// its work items', and `pull.edited`.
    pub(crate) async fn make_pull_edit(&self, actor: &User, pull: &Pull, ready: Ready) -> Result<()> {
        let Ready { repo, edit, item, had } = ready;
        let title = edit.title.clone().unwrap_or_else(|| pull.title.clone());
        let body = edit.body.clone().unwrap_or_else(|| pull.body.clone());
        let own = match &edit.item {
            Some(_) => item.as_ref().map(|held| held.item.id.clone()),
            None => self.pull_item_id(&pull.id).await?,
        };
        // What it names now, as anyone who wrote it may see: the editor,
        // and whoever it is for.
        let named = if pull.status == PullStatus::Merged {
            None
        } else {
            let owner = if pull.is_owned_by(&actor.id) { None } else { self.pull_owner(pull).await? };
            let mut who: Vec<&User> = vec![actor];
            who.extend(owner.as_ref());
            let text = format!("{title}\n{}", body.as_deref().unwrap_or_default());
            Some(items::named(self, &repo, own.as_deref(), &text, &who).await?)
        };
        let closes = named.as_ref().map(|named| serde_json::to_string(&named.close_ids())).transpose()?;
        let parts = named.as_ref().map(|named| serde_json::to_string(&named.part_ids())).transpose()?;
        // A merge since it was read keeps what it landed.
        self.db
            .prepare(
                "UPDATE pulls
                 SET title = ?1,
                     body = CASE WHEN ?2 = 1 THEN ?3 ELSE body END,
                     item_id = CASE WHEN ?4 = 1 AND status <> 'merged' THEN ?5 ELSE item_id END,
                     closes_items = CASE WHEN ?6 IS NULL OR status = 'merged' THEN closes_items ELSE ?6 END,
                     parts = CASE WHEN ?7 IS NULL OR status = 'merged' THEN parts ELSE ?7 END,
                     updated_at = ?8
                 WHERE id = ?9",
            )
            .bind(&[
                title.as_str().into(),
                u32::from(edit.body.is_some()).into(),
                optional(&body),
                u32::from(edit.item.is_some()).into(),
                optional(&own),
                optional(&closes),
                optional(&parts),
                rfc3339(now_ms()).into(),
                pull.id.as_str().into(),
            ])?
            .run()
            .await?;
        let item_after = match &edit.item {
            Some(_) => item.as_ref().map(|held| held.item.number),
            None => pull.item,
        };
        let Some(changes) = changes((&pull.title, pull.body.as_deref(), pull.item), (&title, body.as_deref(), item_after)) else {
            return Ok(());
        };
        if title != pull.title {
            self.note(&pull.repo_id, pull.number, actor, &title_note(&pull.title, &title)).await?;
        }
        if let Some(line) = item_note(pull.item, item_after) {
            self.note(&pull.repo_id, pull.number, actor, &line).await?;
            let here = format!("{}#{}", items::path_of(&repo), pull.number);
            if let Some(had) = &had {
                items::note(self, &had.item.id, actor, &format!("took {here} off this")).await?;
            }
            // The work item hears of it, and links the repository it is in.
            if let Some(held) = &item {
                items::note(self, &held.item.id, actor, &format!("made {here} for this")).await?;
                items::touch(self, held, &repo, actor).await?;
            }
        }
        let fresh = self.pull(&pull.repo_id, pull.number).await?;
        let shown = fresh.as_ref().unwrap_or(pull);
        self.publish("pull.edited", &pull.repo_id, actor, PullEvent { changes: Some(changes), ..Self::pull_event(shown) }).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edit_is_tidied_and_a_bad_title_refused() {
        let edit = Edit::asked(Some("  Trim the name "), Some("  "), Some(0)).unwrap();
        assert_eq!(edit, Edit { title: Some("Trim the name".into()), body: Some(None), item: Some(None) });
        assert_eq!(Edit::asked(None, Some(" Fixes #3 "), Some(12)).unwrap().body, Some(Some("Fixes #3".into())));
        assert!(Edit::asked(None, None, None).unwrap().is_empty());
        assert_eq!(Edit::asked(Some("   "), None, None), Err("A title is required."));
    }

    #[test]
    fn a_merged_or_closed_pull_request_takes_only_text() {
        let text = Edit { title: Some("Better".into()), body: Some(None), item: None };
        let item = Edit { item: Some(Some(12)), ..Edit::default() };
        for status in [PullStatus::Draft, PullStatus::Open, PullStatus::Merged, PullStatus::Closed] {
            assert_eq!(refusal(status, &text), None);
        }
        assert_eq!(refusal(PullStatus::Open, &item), None);
        assert_eq!(refusal(PullStatus::Draft, &item), None);
        assert!(refusal(PullStatus::Merged, &item).unwrap().contains("keeps the work item it landed"));
        assert!(refusal(PullStatus::Closed, &item).unwrap().starts_with("Reopen"));
    }

    #[test]
    fn what_changed_is_said_with_what_it_was() {
        assert_eq!(changes(("Tidy", None, None), ("Tidy", None, None)), None);
        assert_eq!(
            changes(("Tidy", Some("Fixes #3"), Some(3)), ("Tidy up", None, Some(4))),
            Some(json!({ "title": { "from": "Tidy" }, "body": { "from": "Fixes #3" }, "item": { "from": 3 } }))
        );
        assert_eq!(changes(("Tidy", None, None), ("Tidy", Some("Part of #9"), None)), Some(json!({ "body": { "from": null } })));
    }

    #[test]
    fn its_conversation_says_how_its_title_and_work_item_changed() {
        assert_eq!(title_note("Tidy", "Tidy up"), "changed the title from “Tidy” to “Tidy up”");
        assert_eq!(item_note(Some(3), Some(4)).as_deref(), Some("changed its work item from #3 to #4"));
        assert_eq!(item_note(None, Some(4)).as_deref(), Some("made this for #4"));
        assert_eq!(item_note(Some(3), None).as_deref(), Some("took this off #3"));
        assert_eq!(item_note(Some(3), Some(3)), None);
        assert_eq!(item_note(None, None), None);
    }
}
