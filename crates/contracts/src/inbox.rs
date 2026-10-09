//! The inbox: what needs a person, or what they follow, as it happens.
//!
//! The events service keeps it, beside the event log: as events arrive it
//! works out who should hear of each (see `services/events/src/inbox.rs`)
//! and why. Each person has one item per **thread**, the thing it is about
//! (an issue, a pull request, a workflow on a branch, a deployment): new
//! activity on a thread brings its item back to the top, unread, and adds
//! a line to its short history, rather than adding another item. Items are
//! kept by username, which never changes.
//!
//! Who hears of a thread follows its **subscriptions**: whoever opened it,
//! is assigned to it, was asked to review it, commented on it or was
//! mentioned in it is subscribed without asking, and anyone can subscribe
//! or unsubscribe by hand. A person can also **watch** a repository: only
//! what they take part in (the default), all of its activity, only some
//! kinds of it, or nothing at all.
//!
//! Methods, served at `POST /rpc/<method>` on the events service:
//!
//! - `inbox_list` takes `ListInboxArgs` and returns `InboxPage`. Items about
//!   a repository the viewer can no longer read are dropped as they are
//!   found.
//! - `inbox_counts` takes `InboxCountsArgs` and returns `InboxCounts`: the
//!   unread items, by severity. One query, for every page's top bar.
//! - `inbox_mark` takes `MarkInboxArgs` and returns how many items changed.
//! - `inbox_thread` takes `ThreadArgs` and returns `Option<InboxThread>`:
//!   one item with its history and the person's subscription.
//! - `inbox_subscription` takes `SubscriptionArgs` and returns
//!   `Option<ThreadSubscription>`; `inbox_subscribe` takes `SubscribeArgs`
//!   and returns the same.
//! - `inbox_watching` takes `WatchingArgs` and returns `Watching`;
//!   `inbox_watch` takes `WatchArgs` and returns `Watching`;
//!   `inbox_watched` takes `InboxCountsArgs` and returns `Vec<Watching>`.
//! - `inbox_settings` takes `InboxCountsArgs` and returns `InboxSettings`;
//!   `inbox_update_settings` takes `UpdateInboxSettingsArgs` and returns
//!   `InboxSettings`.
//!
//! What an event is about (the issue or pull request, its people, the
//! comment) comes from the work service's `inbox_subject`, which takes
//! `InboxSubjectArgs` and returns `Option<InboxSubject>`.

use serde::{Deserialize, Serialize};

use crate::Viewer;
use crate::credentials::Principal;

/// How much an item matters, and how it is shown: a failure, something a
/// person must answer (an agent waiting on them, a review asked of them),
/// something that went well, or something to know.
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

    /// Which of two is kept on an unread thread: what needs the person,
    /// then a failure, then good news, then the rest. Lower comes first.
    pub fn urgency(self) -> u8 {
        match self {
            Severity::Warning => 0,
            Severity::Error => 1,
            Severity::Success => 2,
            Severity::Info => 3,
        }
    }
}

/// Why a person was told: what ties them to the thread, or what it asked
/// of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// An agent is waiting on them: it asked a question, or it stopped
    /// until a person steps in.
    Agent,
    /// Someone asked them to review a pull request.
    ReviewRequested,
    /// They were assigned to it.
    Assign,
    /// Someone mentioned them by name.
    Mention,
    /// Someone mentioned a team they are in (`@workspace/team`).
    TeamMention,
    /// A check, workflow or deployment on their work finished.
    CiActivity,
    /// A security alert on a repository they look after.
    SecurityAlert,
    /// It was closed, reopened or merged.
    StateChange,
    /// They opened it, or asked g1t for it.
    Author,
    /// They commented on it.
    Comment,
    /// They subscribed to it by hand.
    Manual,
    /// They watch its repository.
    Subscribed,
}

impl Reason {
    /// Most specific first: when one person is told of something for more
    /// than one reason, the first of these is the one shown.
    pub const ALL: [Reason; 12] = [
        Reason::Agent,
        Reason::ReviewRequested,
        Reason::Assign,
        Reason::Mention,
        Reason::TeamMention,
        Reason::CiActivity,
        Reason::SecurityAlert,
        Reason::StateChange,
        Reason::Author,
        Reason::Comment,
        Reason::Manual,
        Reason::Subscribed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Agent => "agent",
            Reason::ReviewRequested => "review_requested",
            Reason::Assign => "assign",
            Reason::Mention => "mention",
            Reason::TeamMention => "team_mention",
            Reason::CiActivity => "ci_activity",
            Reason::SecurityAlert => "security_alert",
            Reason::StateChange => "state_change",
            Reason::Author => "author",
            Reason::Comment => "comment",
            Reason::Manual => "manual",
            Reason::Subscribed => "subscribed",
        }
    }

    pub fn parse(value: &str) -> Option<Reason> {
        Reason::ALL.into_iter().find(|reason| reason.as_str() == value)
    }

    /// Lower is more specific.
    pub fn rank(self) -> usize {
        Reason::ALL.iter().position(|reason| *reason == self).unwrap_or(Reason::ALL.len())
    }

    /// Whether the person takes part in the thread themselves, rather than
    /// following it: everything but a hand subscription and watching.
    pub fn participating(self) -> bool {
        !matches!(self, Reason::Manual | Reason::Subscribed)
    }

    /// What is asked of the person directly: told even when they
    /// unsubscribed from the thread, though never when they ignore it or
    /// its repository.
    pub fn direct(self) -> bool {
        matches!(
            self,
            Reason::Agent
                | Reason::ReviewRequested
                | Reason::Assign
                | Reason::Mention
                | Reason::TeamMention
                | Reason::CiActivity
                | Reason::SecurityAlert
        )
    }
}

/// What an item is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubjectKind {
    Issue,
    Pull,
    /// A workflow's runs on one branch.
    Run,
    /// A project's deployments: production, or one pull request's preview.
    Deploy,
}

impl SubjectKind {
    pub const ALL: [SubjectKind; 4] = [SubjectKind::Issue, SubjectKind::Pull, SubjectKind::Run, SubjectKind::Deploy];

    pub fn as_str(self) -> &'static str {
        match self {
            SubjectKind::Issue => "issue",
            SubjectKind::Pull => "pull",
            SubjectKind::Run => "run",
            SubjectKind::Deploy => "deploy",
        }
    }

    pub fn parse(value: &str) -> Option<SubjectKind> {
        SubjectKind::ALL.into_iter().find(|kind| kind.as_str() == value)
    }
}

/// One thread in a person's inbox: what it is about, and its latest
/// activity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    /// The thread's id: the same for as long as the person has it.
    pub id: String,
    /// Why they were told of the latest activity.
    pub reason: Reason,
    /// While unread, the most urgent of what happened since it was last
    /// read; once read, the latest's.
    pub severity: Severity,
    /// One line: what happened last, and where.
    pub title: String,
    /// One line: what it happened to, such as the pull request's title.
    pub body: String,
    /// The event behind the latest activity, such as `pull.merged`.
    pub event: Option<String>,
    /// `owner/name`.
    pub repo: Option<String>,
    /// The workspace it happened in.
    pub workspace: Option<String>,
    pub subject: Option<SubjectKind>,
    /// The issue or pull request's number.
    pub number: Option<u32>,
    /// Where it is on g1t.sh: a path such as `/acme/rocket/pull/12`.
    pub url: String,
    /// Who did the latest: a username, or `g1t`. Absent when nobody did.
    pub actor: Option<String>,
    /// How many things have happened on the thread.
    pub count: u32,
    /// RFC 3339: when the person was first told of the thread.
    pub created_at: String,
    /// RFC 3339: its latest activity.
    pub updated_at: String,
    pub read_at: Option<String>,
    pub done_at: Option<String>,
    pub saved: bool,
    /// While this is in the future the item is out of the list.
    pub snoozed_until: Option<String>,
}

/// One thing that happened on a thread, as the person was told of it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxActivity {
    pub reason: Reason,
    pub severity: Severity,
    pub title: String,
    pub body: String,
    pub event: Option<String>,
    pub actor: Option<String>,
    pub created_at: String,
}

/// The most activity kept per thread, newest first.
pub const MAX_ACTIVITY: u32 = 10;

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

impl InboxView {
    pub fn parse(value: &str) -> Option<InboxView> {
        match value {
            "inbox" => Some(InboxView::Inbox),
            "saved" => Some(InboxView::Saved),
            "done" => Some(InboxView::Done),
            _ => None,
        }
    }
}

/// `inbox_list`. Latest activity first, except that in the inbox
/// unfiltered, unread warnings (what is waiting on the person) come first.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
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
    /// Only items told for this reason.
    #[serde(default)]
    pub reason: Option<Reason>,
    /// Only items the person takes part in (see [`Reason::participating`]).
    #[serde(default)]
    pub participating: bool,
    /// Only items about this repository.
    #[serde(default)]
    pub repo_id: Option<String>,
    #[serde(default)]
    pub unread: bool,
    /// RFC 3339: only items with activity at or after it.
    #[serde(default)]
    pub since: Option<String>,
    /// RFC 3339: only items whose latest activity was before it.
    #[serde(default)]
    pub updated_before: Option<String>,
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

/// `inbox_counts`, and the other methods that need only whose.
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
    /// Back into the inbox now.
    Unsnooze,
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
    /// With `all`: only items about this repository.
    #[serde(default)]
    pub repo_id: Option<String>,
    /// With `all`: only items whose latest activity was at or before this
    /// (RFC 3339), so what arrived after the person looked stays unread.
    #[serde(default)]
    pub last_read_at: Option<String>,
    /// For `snooze`: RFC 3339.
    #[serde(default)]
    pub until: Option<String>,
}

/// The most ids one `inbox_mark` call changes.
pub const MAX_MARK: usize = 100;

/// `inbox_thread`: one of the viewer's own threads, by id.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadArgs {
    pub viewer: Viewer,
    pub id: String,
}

/// A thread with its history and the person's subscription to it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxThread {
    #[serde(flatten)]
    pub item: InboxItem,
    /// Newest first, at most [`MAX_ACTIVITY`].
    pub activity: Vec<InboxActivity>,
    /// For an issue or pull request; absent for a run or a deployment,
    /// which nobody subscribes to.
    pub subscription: Option<ThreadSubscription>,
}

/// A person's subscription to an issue or pull request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSubscription {
    /// Whether they hear of what happens on it.
    pub subscribed: bool,
    /// Whether they hear of nothing on it at all, not even a mention.
    pub ignored: bool,
    /// Why they are subscribed: they opened it (`author`), are assigned
    /// (`assign`), were asked to review (`review_requested`), commented
    /// (`comment`), were mentioned (`mention`) or subscribed by hand
    /// (`manual`). Absent when they are not.
    pub reason: Option<Reason>,
    /// `owner/name`, and the issue or pull request's number.
    pub repo: Option<String>,
    pub number: Option<u32>,
    /// RFC 3339: when they last chose, or null if they never did.
    pub updated_at: Option<String>,
}

/// Which issue or pull request: by a thread's id, or by its repository and
/// number.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionArgs {
    pub viewer: Viewer,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub repo_id: Option<String>,
    #[serde(default)]
    pub number: Option<u32>,
}

/// `inbox_subscribe`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeArgs {
    #[serde(flatten)]
    pub on: SubscriptionArgs,
    /// True to subscribe, false to unsubscribe. Absent with `ignored`
    /// false: back to the default, subscribed only while taking part.
    #[serde(default)]
    pub subscribed: Option<bool>,
    /// True to hear of nothing on it, not even a mention.
    #[serde(default)]
    pub ignored: bool,
}

/// How closely a person follows a repository.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchLevel {
    /// Only what they take part in or are mentioned in: the default.
    #[default]
    Participating,
    /// Everything: every issue and pull request opened, commented on,
    /// closed or merged, and every deployment.
    All,
    /// Nothing at all, not even a mention.
    Ignore,
    /// What they take part in, and the kinds of activity in `events`.
    Custom,
}

impl WatchLevel {
    pub const ALL: [WatchLevel; 4] = [WatchLevel::Participating, WatchLevel::All, WatchLevel::Ignore, WatchLevel::Custom];

    pub fn as_str(self) -> &'static str {
        match self {
            WatchLevel::Participating => "participating",
            WatchLevel::All => "all",
            WatchLevel::Ignore => "ignore",
            WatchLevel::Custom => "custom",
        }
    }

    pub fn parse(value: &str) -> Option<WatchLevel> {
        WatchLevel::ALL.into_iter().find(|level| level.as_str() == value)
    }
}

/// The kinds of activity a custom watch can follow.
pub const WATCH_EVENTS: [&str; 4] = ["issues", "pulls", "deployments", "security"];

/// How a person watches one repository.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watching {
    pub repo_id: String,
    /// `owner/name`, when known.
    #[serde(default)]
    pub repo: Option<String>,
    pub level: WatchLevel,
    /// With `custom`: some of [`WATCH_EVENTS`].
    #[serde(default)]
    pub events: Vec<String>,
    /// RFC 3339: when they chose, or null if they never did.
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// `inbox_watching`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchingArgs {
    pub username: String,
    pub repo_id: String,
}

/// `inbox_watchers`: how many watch a repository: all of its activity,
/// or some of it (custom). The default (participating) and ignoring are
/// not counted. Returns `u64`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchersArgs {
    pub repo_id: String,
}

/// `inbox_watch`. No `level`: back to the default.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchArgs {
    pub username: String,
    pub repo_id: String,
    /// `owner/name`, kept to list what the person watches.
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub level: Option<WatchLevel>,
    #[serde(default)]
    pub events: Vec<String>,
}

/// A person's choices about being told.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxSettings {
    /// The reasons they are also emailed for.
    pub email: Vec<Reason>,
    /// How they watch a repository they create.
    pub default_watch: WatchLevel,
}

impl Default for InboxSettings {
    fn default() -> Self {
        InboxSettings {
            email: DEFAULT_EMAIL.to_vec(),
            default_watch: WatchLevel::All,
        }
    }
}

/// What a person is emailed for until they choose: what is waiting on them.
pub const DEFAULT_EMAIL: [Reason; 3] = [Reason::Agent, Reason::ReviewRequested, Reason::Mention];

/// `inbox_update_settings`. What is left out is unchanged.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInboxSettingsArgs {
    pub username: String,
    #[serde(default)]
    pub email: Option<Vec<Reason>>,
    #[serde(default)]
    pub default_watch: Option<WatchLevel>,
}

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
    /// The people its description mentions by name, outside code and
    /// quotes, for `issue.opened` and `pull.opened`. Never `g1t`.
    #[serde(default)]
    pub mentions: Vec<String>,
    /// The teams its description mentions, with the people each tells.
    #[serde(default)]
    pub team_mentions: Vec<TeamMentioned>,
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
    /// The teams it mentions (`@workspace/team`), with the people each
    /// tells: everyone in the team and its child teams, unless the team
    /// turned notifications off. A secret team tells nobody unless the
    /// writer is in it.
    #[serde(default)]
    pub team_mentions: Vec<TeamMentioned>,
    /// A review's verdict: `approve` or `request_changes`.
    #[serde(default)]
    pub verdict: Option<String>,
    /// Something that happened (an assignment, a close), not something written.
    #[serde(default)]
    pub event: bool,
    /// Set when one of the workspace's agents wrote it, as itself: it is
    /// shown by its name, marked as an agent, never as a person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<crate::work::AgentRef>,
    /// Who the agent acted for, set with `agent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acting_for: Option<Principal>,
    /// An agent's review: its verdict is advisory.
    #[serde(default)]
    pub advisory: bool,
}

/// A team a comment or description mentions, and who it tells.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMentioned {
    /// `workspace/slug`.
    pub team: String,
    /// Usernames.
    pub members: Vec<String>,
}

/// `notify_by_email` on the identity service: one item, emailed to the
/// person it is for, if they can still read its repository and their
/// address is confirmed. Returns whether it was sent.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyByEmailArgs {
    pub username: String,
    pub repo_id: String,
    /// The subject line and the first paragraph.
    pub subject: String,
    pub intro: String,
    /// What was said, and who said it, when it was written by someone.
    #[serde(default)]
    pub quote: Option<(String, String)>,
    /// A path on the site, such as `/acme/rocket/pull/12`.
    pub path: String,
    pub reason: Reason,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severities_reasons_and_subjects_read_back() {
        for severity in Severity::ALL {
            assert_eq!(Severity::parse(severity.as_str()), Some(severity));
        }
        assert_eq!(Severity::parse("fatal"), None);
        for reason in Reason::ALL {
            assert_eq!(Reason::parse(reason.as_str()), Some(reason));
            assert_eq!(serde_json::to_value(reason).unwrap(), reason.as_str());
        }
        for kind in SubjectKind::ALL {
            assert_eq!(SubjectKind::parse(kind.as_str()), Some(kind));
        }
        for level in WatchLevel::ALL {
            assert_eq!(WatchLevel::parse(level.as_str()), Some(level));
        }
        assert_eq!(serde_json::to_value(InboxMark::Unsave).unwrap(), "unsave");
    }

    #[test]
    fn what_is_asked_of_a_person_outranks_what_they_follow() {
        assert!(Reason::Agent.rank() < Reason::Mention.rank());
        assert!(Reason::Mention.rank() < Reason::Author.rank());
        assert!(Reason::Author.rank() < Reason::Subscribed.rank());
        assert!(Reason::ReviewRequested.direct() && !Reason::Comment.direct());
        assert!(!Reason::Subscribed.participating() && Reason::Author.participating());
        assert!(Severity::Warning.urgency() < Severity::Error.urgency());
    }

    #[test]
    fn a_thread_carries_its_item_flat() {
        let thread = InboxThread {
            item: InboxItem {
                id: "ntf_1".into(),
                reason: Reason::Mention,
                severity: Severity::Info,
                title: "t".into(),
                body: "b".into(),
                event: None,
                repo: None,
                workspace: None,
                subject: None,
                number: None,
                url: "/inbox".into(),
                actor: None,
                count: 1,
                created_at: "2026-10-07T12:00:00.000Z".into(),
                updated_at: "2026-10-07T12:00:00.000Z".into(),
                read_at: None,
                done_at: None,
                saved: false,
                snoozed_until: None,
            },
            activity: Vec::new(),
            subscription: None,
        };
        let value = serde_json::to_value(&thread).unwrap();
        assert_eq!(value["id"], "ntf_1");
        assert_eq!(value["reason"], "mention");
        assert!(value["activity"].is_array());
    }
}
