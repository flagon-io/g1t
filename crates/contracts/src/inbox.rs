//! The inbox: what needs a person, or what they follow, as it happens.
//!
//! The events service keeps it, beside the event log: as events arrive it
//! works out who should hear of each (see `services/events/src/inbox.rs`)
//! and writes one item per person. Items are kept by username, which never
//! changes. Methods, served at `POST /rpc/<method>` on the events service:
//!
//! - `inbox_list` takes `ListInboxArgs` and returns `InboxPage`. Items about
//!   a repository the viewer can no longer read are dropped as they are
//!   found.
//! - `inbox_counts` takes `InboxCountsArgs` and returns `InboxCounts`: the
//!   unread items, by severity. One query, for every page's top bar.
//! - `inbox_mark` takes `MarkInboxArgs` and returns how many items changed.
//!
//! What an event is about (the issue or pull request, its people, the
//! comment) comes from the work service's `inbox_subject`, which takes
//! `InboxSubjectArgs` and returns `Option<InboxSubject>`.

use serde::{Deserialize, Serialize};

use crate::Viewer;
use crate::credentials::Principal;

/// How much an item matters, and how it is shown: a failure, something a
/// person must answer (an agent waiting on them), something that went
/// well, or something to know.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Success,
    Info,
}

impl Severity {
    pub const ALL: [Severity; 4] = [Severity::Error, Severity::Warning, Severity::Success, Severity::Info];

    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
            Severity::Success => "success",
            Severity::Info => "info",
        }
    }

    pub fn parse(value: &str) -> Option<Severity> {
        Severity::ALL.into_iter().find(|severity| severity.as_str() == value)
    }
}

/// What an item is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubjectKind {
    Issue,
    Pull,
    /// A workflow run.
    Run,
}

impl SubjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SubjectKind::Issue => "issue",
            SubjectKind::Pull => "pull",
            SubjectKind::Run => "run",
        }
    }

    pub fn parse(value: &str) -> Option<SubjectKind> {
        [SubjectKind::Issue, SubjectKind::Pull, SubjectKind::Run]
            .into_iter()
            .find(|kind| kind.as_str() == value)
    }
}

/// One thing a person was told.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    /// Why they were told, such as `checks_failed` or `mentioned`.
    pub reason: String,
    pub severity: Severity,
    /// One line: what happened, and where.
    pub title: String,
    /// One line: what it happened to, such as the pull request's title.
    pub body: String,
    /// `owner/name`.
    pub repo: Option<String>,
    /// The workspace it happened in.
    pub workspace: Option<String>,
    pub subject: Option<SubjectKind>,
    /// The issue or pull request's number.
    pub number: Option<u32>,
    /// Where it is on g1t.sh: a path such as `/acme/rocket/pull/12`.
    pub url: String,
    /// Who did it: a username, or `g1t`. Absent when nobody did.
    pub actor: Option<String>,
    /// RFC 3339.
    pub created_at: String,
    pub read_at: Option<String>,
    pub done_at: Option<String>,
    pub saved: bool,
    /// While this is in the future the item is out of the list.
    pub snoozed_until: Option<String>,
}

/// Which items a list shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InboxView {
    /// Everything not done and not snoozed: the inbox itself.
    #[default]
    Inbox,
    /// Saved items, done or not.
    Saved,
    /// Items marked done.
    Done,
}

/// `inbox_list`. Newest first, except that unread warnings (an agent
/// waiting on the person) come before everything else in the inbox.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListInboxArgs {
    /// Whose inbox: the person signed in. Their memberships decide which
    /// repositories they can still read.
    pub viewer: Viewer,
    #[serde(default)]
    pub view: InboxView,
    /// Only items of this severity.
    #[serde(default)]
    pub severity: Option<Severity>,
    #[serde(default)]
    pub unread: bool,
    /// The `next` of the page before.
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

pub const DEFAULT_INBOX_PAGE: u32 = 30;
pub const MAX_INBOX_PAGE: u32 = 100;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxPage {
    pub items: Vec<InboxItem>,
    /// Pass as `before` for the next page; absent on the last.
    pub next: Option<String>,
}

/// `inbox_counts`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxCountsArgs {
    pub username: String,
}

/// Unread items in the inbox view, by severity.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxCounts {
    pub unread: u32,
    pub error: u32,
    pub warning: u32,
    pub success: u32,
    pub info: u32,
}

/// What `inbox_mark` does to the items it names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxMark {
    Read,
    Unread,
    /// Out of the inbox, into Done; read with it.
    Done,
    /// Back into the inbox.
    Undone,
    Save,
    Unsave,
    /// Out of the inbox until `until`.
    Snooze,
}

/// `inbox_mark`: changes the person's own items, by id, or every item in
/// their inbox when `ids` is empty and `all` is set (Mark all read).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkInboxArgs {
    pub username: String,
    pub mark: InboxMark,
    #[serde(default)]
    pub ids: Vec<String>,
    #[serde(default)]
    pub all: bool,
    /// With `all`: only items of this severity.
    #[serde(default)]
    pub severity: Option<Severity>,
    /// For `snooze`: RFC 3339.
    #[serde(default)]
    pub until: Option<String>,
}

/// The most ids one `inbox_mark` call changes.
pub const MAX_MARK: usize = 100;

/// `inbox_subject` on the work service: what an event names, for the
/// inbox. A service-to-service read: it checks nobody's access, and what
/// it returns is only ever shown to the people it names, or to those who
/// can read the repository.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxSubjectArgs {
    pub repo_id: String,
    pub number: u32,
    /// The comment the event is about, if any.
    #[serde(default)]
    pub comment_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxSubject {
    /// `issue` or `pull`.
    pub kind: Option<SubjectKind>,
    pub title: String,
    pub author: Principal,
    /// For work g1t did: the person it was done for.
    #[serde(default)]
    pub requested_by: Option<Principal>,
    /// Usernames.
    #[serde(default)]
    pub assignees: Vec<String>,
    /// Usernames, and `g1t`. Pull requests only.
    #[serde(default)]
    pub reviewers: Vec<String>,
    /// For a pull request: the issue it is for, with that issue's people.
    #[serde(default)]
    pub issue: Option<Box<InboxSubject>>,
    #[serde(default)]
    pub comment: Option<InboxComment>,
}

impl InboxSubject {
    /// Whose it is to answer for: whoever asked g1t for it, or its author.
    pub fn owner(&self) -> &Principal {
        self.requested_by.as_ref().unwrap_or(&self.author)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxComment {
    pub author: Principal,
    /// The first line or so, as written.
    pub excerpt: String,
    /// The people it mentions by name, outside code and quotes. Never `g1t`.
    #[serde(default)]
    pub mentions: Vec<String>,
    /// A review's verdict: `approve` or `request_changes`.
    #[serde(default)]
    pub verdict: Option<String>,
    /// Something that happened (an assignment, a close), not something written.
    #[serde(default)]
    pub event: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severities_and_subjects_read_back() {
        for severity in Severity::ALL {
            assert_eq!(Severity::parse(severity.as_str()), Some(severity));
        }
        assert_eq!(Severity::parse("fatal"), None);
        assert_eq!(SubjectKind::parse("pull"), Some(SubjectKind::Pull));
        assert_eq!(serde_json::to_value(InboxMark::Unsave).unwrap(), "unsave");
    }
}
