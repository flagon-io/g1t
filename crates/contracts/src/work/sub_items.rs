//! Sub-items: a work item can have one parent and any number of sub-items,
//! all in its workspace. A parent shows how far along its sub-items are
//! ([`SubItemProgress`]); it is not blocked by them, and closing it never closes
//! them silently ([`OpenSubItems`]). What a work item is blocked by stays
//! separate (`blocked_by`).

use serde::{Deserialize, Serialize};

use crate::User;

/// How far along a parent's sub-items are: `done` of `total` are closed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubItemProgress {
    pub done: u32,
    pub total: u32,
}

impl SubItemProgress {
    /// Whether every sub-item is closed.
    pub fn finished(&self) -> bool {
        self.total > 0 && self.done == self.total
    }
}

/// What closing a work item does with its sub-items that are still open.
/// Closing one that has some is refused until this is said.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenSubItems {
    /// They stay open, still its sub-items.
    Leave,
    /// They close too, with the same reason, and so do theirs.
    Close,
    /// They become sub-items of the work item `move_to` names.
    Move,
}

impl OpenSubItems {
    pub fn as_str(self) -> &'static str {
        match self {
            OpenSubItems::Leave => "leave",
            OpenSubItems::Close => "close",
            OpenSubItems::Move => "move",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "leave" => Some(OpenSubItems::Leave),
            "close" => Some(OpenSubItems::Close),
            "move" => Some(OpenSubItems::Move),
            _ => None,
        }
    }
}

/// `set_work_item_parent`: makes work item `number` a sub-item of
/// `parent`, or, with none, of nothing. With `only_from`, it is taken out
/// only when that is its parent now (how `remove_sub_item` is sure it
/// takes out its own). Its owner, or someone with the Triage role on it,
/// may; the parent must be a work item of the workspace they can see, not
/// the item itself or one of its sub-items, however deep. Publishes
/// `work_item.parent_changed` on it and `work_item.sub_items_changed` on
/// each parent it left or joined. Returns `Outcome<WorkItem>`, the
/// sub-item.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetParentArgs {
    pub actor: User,
    pub workspace: String,
    pub number: u32,
    #[serde(default)]
    pub parent: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only_from: Option<u32>,
}

/// `parent` as asked for `number`, or why it cannot be: it is `number`
/// itself, or `number` is one of its ancestors (`ancestors`: `parent`'s
/// parent, then that one's, and so on), which would make a cycle.
pub fn check_parent(number: u32, parent: u32, ancestors: &[u32]) -> Result<(), String> {
    if parent == number {
        return Err(format!("#{number} cannot be its own sub-item."));
    }
    if let Some(at) = ancestors.iter().position(|ancestor| *ancestor == number) {
        let chain: Vec<String> = std::iter::once(parent).chain(ancestors[..=at].iter().copied()).map(|n| format!("#{n}")).collect();
        return Err(format!(
            "#{parent} is already under #{number} ({}, each a sub-item of the next), so #{number} cannot be its sub-item.",
            chain.join(" → ")
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_parent_is_refused_when_it_would_make_a_cycle() {
        assert_eq!(check_parent(5, 3, &[1]), Ok(()));
        assert_eq!(check_parent(5, 5, &[]), Err("#5 cannot be its own sub-item.".to_owned()));
        assert_eq!(
            check_parent(5, 3, &[4, 5, 9]),
            Err("#3 is already under #5 (#3 → #4 → #5, each a sub-item of the next), so #5 cannot be its sub-item.".to_owned())
        );
    }

    #[test]
    fn progress_is_finished_only_with_every_sub_item_closed() {
        assert!(SubItemProgress { done: 7, total: 7 }.finished());
        assert!(!SubItemProgress { done: 3, total: 7 }.finished());
        assert!(!SubItemProgress::default().finished());
    }

    #[test]
    fn what_to_do_with_open_sub_items_reads_as_written() {
        assert_eq!(OpenSubItems::parse(" Move "), Some(OpenSubItems::Move));
        assert_eq!(OpenSubItems::parse("drop"), None);
        assert_eq!(serde_json::to_value(OpenSubItems::Leave).unwrap(), "leave");
    }
}
