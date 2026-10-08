//! Who follows what, for the inbox (inbox.rs): subscriptions to issues and
//! pull requests, how people watch repositories, and what each person
//! chose about being told. See `g1t_contracts::inbox`.
//!
//! An issue's or pull request's author (or whoever asked g1t for it), its
//! assignees and its reviewers are subscribed without a row. A row records
//! the rest: someone who commented or was mentioned (subscribed as they
//! did), or who subscribed, unsubscribed or ignored it by hand. Commenting
//! or being mentioned subscribes again someone who unsubscribed; nothing
//! but their own choice undoes ignoring.

use std::collections::HashMap;

use g1t_contracts::events::Event;
use g1t_contracts::inbox::*;
use g1t_kit::now_ms;
use g1t_contracts::time::rfc3339;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement, Fetcher, Result};

use crate::inbox::{is_g1t, is_g1t_id, numbered_thread};

/// The most watchers read for one repository's event.
const MAX_WATCHERS: u32 = 5000;

/// Where a person stands on one thread, by their own row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Subscribed,
    Unsubscribed,
    Ignored,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Subscribed => "subscribed",
            State::Unsubscribed => "unsubscribed",
            State::Ignored => "ignored",
        }
    }

    pub fn parse(value: &str) -> Option<State> {
        [State::Subscribed, State::Unsubscribed, State::Ignored]
            .into_iter()
            .find(|state| state.as_str() == value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subscription {
    pub username: String,
    pub state: State,
    pub reason: Option<Reason>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Watcher {
    pub username: String,
    pub level: WatchLevel,
    pub events: Vec<String>,
}

/// Who follows the thread an event is on, beyond its own people: its
/// subscription rows, and the repository's watchers.
#[derive(Clone, Debug, Default)]
pub struct Audience {
    pub subscriptions: Vec<Subscription>,
    pub watchers: Vec<Watcher>,
}

impl Audience {
    fn row(&self, username: &str) -> Option<&Subscription> {
        self.subscriptions.iter().find(|row| row.username.eq_ignore_ascii_case(username))
    }

    /// Hears of nothing here: they ignore the thread or the repository.
    pub fn ignores(&self, username: &str) -> bool {
        self.row(username).is_some_and(|row| row.state == State::Ignored)
            || self
                .watchers
                .iter()
                .any(|watcher| watcher.level == WatchLevel::Ignore && watcher.username.eq_ignore_ascii_case(username))
    }

    /// Hears only of what is asked of them.
    pub fn unsubscribed(&self, username: &str) -> bool {
        self.row(username).is_some_and(|row| row.state == State::Unsubscribed)
    }

    /// Everyone with a row saying they are subscribed, and why.
    pub fn subscribed(&self) -> impl Iterator<Item = (String, Reason)> + '_ {
        self.subscriptions
            .iter()
            .filter(|row| row.state == State::Subscribed)
            .map(|row| (row.username.clone(), row.reason.unwrap_or(Reason::Manual)))
    }

    /// Everyone watching the repository for `kind` of activity: `issues`,
    /// `pulls`, `deployments` or `security`.
    pub fn watching<'a>(&'a self, kind: &'a str) -> impl Iterator<Item = String> + 'a {
        self.watchers
            .iter()
            .filter(move |watcher| match watcher.level {
                WatchLevel::All => true,
                WatchLevel::Custom => watcher.events.iter().any(|event| event == kind),
                WatchLevel::Participating | WatchLevel::Ignore => false,
            })
            .map(|watcher| watcher.username.clone())
    }
}

#[derive(Deserialize)]
struct SubscriptionRow {
    username: String,
    state: String,
    reason: Option<String>,
    chosen_at: Option<String>,
}

impl SubscriptionRow {
    fn into_subscription(self) -> Option<Subscription> {
        Some(Subscription {
            username: self.username,
            state: State::parse(&self.state)?,
            reason: self.reason.as_deref().and_then(Reason::parse),
        })
    }
}

/// An issue's or pull request's subscription rows.
pub async fn of_thread(db: &D1Database, thread: &str) -> Result<Vec<Subscription>> {
    Ok(db
        .prepare("SELECT username, state, reason, chosen_at FROM inbox_subscriptions WHERE thread = ?")
        .bind(&[thread.into()])?
        .all()
        .await?
        .results::<SubscriptionRow>()?
        .into_iter()
        .filter_map(SubscriptionRow::into_subscription)
        .collect())
}

#[derive(Deserialize)]
struct WatcherRow {
    username: String,
    level: String,
    events: Option<String>,
}

fn events_of(text: Option<&str>) -> Vec<String> {
    text.and_then(|text| serde_json::from_str::<Vec<String>>(text).ok()).unwrap_or_default()
}

/// How many watch a repository: all of it, or some of it.
pub async fn watchers_count(db: &D1Database, a: WatchersArgs) -> Result<u64> {
    #[derive(Deserialize)]
    struct Row {
        count: f64,
    }
    Ok(db
        .prepare("SELECT COUNT(*) AS count FROM inbox_watching WHERE repo_id = ? AND level IN ('all', 'custom')")
        .bind(&[a.repo_id.into()])?
        .first::<Row>(None)
        .await?
        .map_or(0, |row| row.count as u64))
}

/// Everyone who watches a repository other than the default way.
pub async fn watchers(db: &D1Database, repo_id: &str) -> Result<Vec<Watcher>> {
    Ok(db
        .prepare("SELECT username, level, events FROM inbox_watching WHERE repo_id = ? AND level != 'participating' LIMIT ?")
        .bind(&[repo_id.into(), MAX_WATCHERS.into()])?
        .all()
        .await?
        .results::<WatcherRow>()?
        .into_iter()
        .filter_map(|row| {
            Some(Watcher {
                level: WatchLevel::parse(&row.level)?,
                events: events_of(row.events.as_deref()),
                username: row.username,
            })
        })
        .collect())
}

/// Subscribes the people an event names to its issue or pull request:
/// anyone without a row, and anyone who had unsubscribed. Someone who
/// ignores it stays ignoring it.
pub fn auto_subscribe(
    db: &D1Database,
    thread: &str,
    repo_id: &str,
    people: &[(String, Reason)],
    at: &str,
) -> Result<Vec<D1PreparedStatement>> {
    if !thread.contains('#') {
        return Ok(Vec::new());
    }
    people
        .iter()
        .map(|(username, reason)| {
            db.prepare(
                "INSERT INTO inbox_subscriptions (username, thread, repo_id, state, reason, created_at)
                 VALUES (?1, ?2, ?3, 'subscribed', ?4, ?5)
                 ON CONFLICT (thread, username) DO UPDATE SET state = 'subscribed', reason = excluded.reason
                 WHERE inbox_subscriptions.state = 'unsubscribed'",
            )
            .bind(&[
                username.as_str().into(),
                thread.into(),
                repo_id.into(),
                reason.as_str().into(),
                at.into(),
            ])
        })
        .collect()
}

/// Whoever made a repository watches it as they chose for new ones (all of
/// its activity, unless they said otherwise).
pub async fn watch_created(db: &D1Database, event: &Event, names: &HashMap<String, String>) -> Result<()> {
    let Some(id) = event.actor.as_deref().filter(|id| !is_g1t_id(id)) else {
        return Ok(());
    };
    let (Some(username), Some(repo_id)) = (
        names.get(id).map(|name| name.to_lowercase()).filter(|name| !is_g1t(name)),
        event.data["repoId"].as_str().map(str::to_owned).or_else(|| event.repo_id.clone()),
    ) else {
        return Ok(());
    };
    let repo = format!(
        "{}/{}",
        event.data["namespace"].as_str().unwrap_or_default(),
        event.data["name"].as_str().unwrap_or_default()
    )
    .to_lowercase();
    db.prepare(
        "INSERT OR IGNORE INTO inbox_watching (username, repo_id, repo, level, events, updated_at)
         SELECT ?1, ?2, ?3, COALESCE((SELECT default_watch FROM inbox_settings WHERE username = ?1), ?4), '[]', ?5",
    )
    .bind(&[
        username.into(),
        repo_id.into(),
        repo.into(),
        InboxSettings::default().default_watch.as_str().into(),
        event.time.as_str().into(),
    ])?
    .run()
    .await?;
    Ok(())
}

// --- One person's subscriptions ----------------------------------------------

#[derive(Deserialize)]
struct ItemRow {
    thread: Option<String>,
    repo_id: Option<String>,
    repo: Option<String>,
    number: Option<f64>,
    subject: Option<String>,
}

/// The issue or pull request asked about: its thread, repository and
/// number, and its `owner/name` when known.
struct Target {
    thread: String,
    repo_id: String,
    number: u32,
    repo: Option<String>,
}

async fn target(db: &D1Database, username: &str, a: &SubscriptionArgs) -> Result<Option<Target>> {
    if let Some(id) = &a.id {
        let row = db
            .prepare("SELECT thread, repo_id, repo, number, subject FROM inbox_items WHERE id = ? AND username = ?")
            .bind(&[id.as_str().into(), username.into()])?
            .first::<ItemRow>(None)
            .await?;
        return Ok(row.and_then(|row| {
            let kind = row.subject.as_deref().and_then(SubjectKind::parse);
            if !matches!(kind, Some(SubjectKind::Issue | SubjectKind::Pull)) {
                return None;
            }
            Some(Target {
                thread: row.thread?,
                repo_id: row.repo_id?,
                number: row.number? as u32,
                repo: row.repo,
            })
        }));
    }
    let (Some(repo_id), Some(number)) = (&a.repo_id, a.number) else {
        return Ok(None);
    };
    Ok(Some(Target {
        thread: numbered_thread(repo_id, number),
        repo_id: repo_id.clone(),
        number,
        repo: None,
    }))
}

/// Why the person is subscribed without a row: they own it, wrote it, are
/// assigned or were asked to review.
fn implicit(subject: &InboxSubject, username: &str) -> Option<Reason> {
    let is = |name: &str| name.eq_ignore_ascii_case(username);
    if is(&subject.owner().username) || is(&subject.author.username) {
        Some(Reason::Author)
    } else if subject.assignees.iter().any(|name| is(name)) {
        Some(Reason::Assign)
    } else if subject.reviewers.iter().any(|name| is(name)) {
        Some(Reason::ReviewRequested)
    } else {
        None
    }
}

/// What a row, or the lack of one, says.
fn standing(row: Option<&SubscriptionRow>, implicit: Option<Reason>) -> (bool, bool, Option<Reason>) {
    match row.and_then(|row| State::parse(&row.state).map(|state| (state, row))) {
        Some((State::Ignored, _)) => (false, true, None),
        Some((State::Unsubscribed, _)) => (false, false, None),
        Some((State::Subscribed, row)) => (true, false, row.reason.as_deref().and_then(Reason::parse).or(Some(Reason::Manual))),
        None => (implicit.is_some(), false, implicit),
    }
}

/// The person's subscription to an issue or pull request. None when there
/// is no such issue or pull request, or it is a thread nobody subscribes to.
pub async fn subscription(db: &D1Database, work: &Fetcher, a: SubscriptionArgs) -> Result<Option<ThreadSubscription>> {
    let Some(viewer) = &a.viewer else {
        return Ok(None);
    };
    let username = viewer.username.to_lowercase();
    let Some(target) = target(db, &username, &a).await? else {
        return Ok(None);
    };
    let row = db
        .prepare("SELECT username, state, reason, chosen_at FROM inbox_subscriptions WHERE thread = ? AND username = ?")
        .bind(&[target.thread.as_str().into(), username.as_str().into()])?
        .first::<SubscriptionRow>(None)
        .await?;
    // Without a row, whether they take part is the issue's to say; and an
    // issue that is not there has no subscription.
    let subject: Option<InboxSubject> = g1t_kit::call(
        work,
        "inbox_subject",
        &InboxSubjectArgs {
            repo_id: target.repo_id.clone(),
            number: target.number,
            comment_id: None,
        },
    )
    .await?;
    let Some(subject) = subject else {
        return Ok(None);
    };
    let (subscribed, ignored, reason) = standing(row.as_ref(), implicit(&subject, &username));
    Ok(Some(ThreadSubscription {
        subscribed,
        ignored,
        reason,
        repo: target.repo,
        number: Some(target.number),
        updated_at: row.and_then(|row| row.chosen_at),
    }))
}

/// Subscribes, unsubscribes or ignores by hand, or goes back to the
/// default (subscribed only while taking part).
pub async fn subscribe(db: &D1Database, work: &Fetcher, a: SubscribeArgs) -> Result<Option<ThreadSubscription>> {
    let Some(viewer) = &a.on.viewer else {
        return Ok(None);
    };
    let username = viewer.username.to_lowercase();
    if is_g1t(&username) {
        return Ok(None);
    }
    let Some(target) = target(db, &username, &a.on).await? else {
        return Ok(None);
    };
    // Only an issue or pull request that is there.
    let found: Option<InboxSubject> = g1t_kit::call(
        work,
        "inbox_subject",
        &InboxSubjectArgs {
            repo_id: target.repo_id.clone(),
            number: target.number,
            comment_id: None,
        },
    )
    .await?;
    if found.is_none() {
        return Ok(None);
    }
    let now = rfc3339(now_ms());
    let state = match (a.ignored, a.subscribed) {
        (true, _) => Some(State::Ignored),
        (false, Some(true)) => Some(State::Subscribed),
        (false, Some(false)) => Some(State::Unsubscribed),
        (false, None) => None,
    };
    match state {
        None => {
            db.prepare("DELETE FROM inbox_subscriptions WHERE thread = ? AND username = ?")
                .bind(&[target.thread.as_str().into(), username.as_str().into()])?
                .run()
                .await?;
        }
        Some(state) => {
            db.prepare(
                "INSERT INTO inbox_subscriptions (username, thread, repo_id, state, reason, created_at, chosen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT (thread, username) DO UPDATE SET
                   state = excluded.state,
                   reason = CASE WHEN excluded.state = 'subscribed' AND inbox_subscriptions.state = 'subscribed'
                     THEN inbox_subscriptions.reason ELSE excluded.reason END,
                   chosen_at = excluded.chosen_at",
            )
            .bind(&[
                username.as_str().into(),
                target.thread.as_str().into(),
                target.repo_id.as_str().into(),
                state.as_str().into(),
                if state == State::Subscribed { Reason::Manual.as_str().into() } else { JsValue::NULL },
                now.as_str().into(),
            ])?
            .run()
            .await?;
        }
    }
    subscription(db, work, a.on).await
}

// --- Watching ------------------------------------------------------------------

#[derive(Deserialize)]
struct WatchingRow {
    repo_id: String,
    repo: Option<String>,
    level: String,
    events: Option<String>,
    updated_at: Option<String>,
}

impl WatchingRow {
    fn into_watching(self) -> Watching {
        Watching {
            level: WatchLevel::parse(&self.level).unwrap_or_default(),
            events: events_of(self.events.as_deref()),
            repo_id: self.repo_id,
            repo: self.repo,
            updated_at: self.updated_at,
        }
    }
}

/// How the person watches one repository: participating unless they chose.
pub async fn watching(db: &D1Database, a: WatchingArgs) -> Result<Watching> {
    let row = db
        .prepare("SELECT repo_id, repo, level, events, updated_at FROM inbox_watching WHERE repo_id = ? AND username = ?")
        .bind(&[a.repo_id.as_str().into(), a.username.to_lowercase().into()])?
        .first::<WatchingRow>(None)
        .await?;
    Ok(row.map(WatchingRow::into_watching).unwrap_or(Watching {
        repo_id: a.repo_id,
        ..Watching::default()
    }))
}

/// The kinds a custom watch follows: known ones, each once, in their order.
pub fn custom_events(events: &[String]) -> Vec<String> {
    WATCH_EVENTS
        .into_iter()
        .filter(|kind| events.iter().any(|event| event.trim().eq_ignore_ascii_case(kind)))
        .map(str::to_owned)
        .collect()
}

/// Sets how the person watches a repository; no level goes back to the
/// default.
pub async fn watch(db: &D1Database, a: WatchArgs) -> Result<Watching> {
    let username = a.username.to_lowercase();
    match a.level {
        None => {
            db.prepare("DELETE FROM inbox_watching WHERE repo_id = ? AND username = ?")
                .bind(&[a.repo_id.as_str().into(), username.as_str().into()])?
                .run()
                .await?;
        }
        Some(level) => {
            let events = if level == WatchLevel::Custom { custom_events(&a.events) } else { Vec::new() };
            db.prepare(
                "INSERT INTO inbox_watching (username, repo_id, repo, level, events, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (repo_id, username) DO UPDATE SET
                   repo = COALESCE(excluded.repo, inbox_watching.repo), level = excluded.level,
                   events = excluded.events, updated_at = excluded.updated_at",
            )
            .bind(&[
                username.as_str().into(),
                a.repo_id.as_str().into(),
                a.repo.as_deref().map(str::to_lowercase).map_or(JsValue::NULL, JsValue::from),
                level.as_str().into(),
                serde_json::to_string(&events)?.into(),
                rfc3339(now_ms()).into(),
            ])?
            .run()
            .await?;
        }
    }
    watching(
        db,
        WatchingArgs {
            username,
            repo_id: a.repo_id,
        },
    )
    .await
}

/// The repositories the person watches other than the default way.
pub async fn watched(db: &D1Database, a: InboxCountsArgs) -> Result<Vec<Watching>> {
    Ok(db
        .prepare(
            "SELECT repo_id, repo, level, events, updated_at FROM inbox_watching
             WHERE username = ? AND level != 'participating' ORDER BY repo LIMIT 500",
        )
        .bind(&[a.username.to_lowercase().into()])?
        .all()
        .await?
        .results::<WatchingRow>()?
        .into_iter()
        .map(WatchingRow::into_watching)
        .collect())
}

// --- Settings ------------------------------------------------------------------

#[derive(Deserialize)]
struct SettingsRow {
    username: String,
    email: Option<String>,
    default_watch: Option<String>,
}

impl SettingsRow {
    fn into_settings(self) -> InboxSettings {
        let defaults = InboxSettings::default();
        InboxSettings {
            email: match self.email.as_deref().and_then(|text| serde_json::from_str::<Vec<String>>(text).ok()) {
                Some(reasons) => email_reasons(&reasons),
                None => defaults.email,
            },
            default_watch: self.default_watch.as_deref().and_then(WatchLevel::parse).unwrap_or(defaults.default_watch),
        }
    }
}

/// Reasons as given, known ones only, each once, in their order.
pub fn email_reasons(reasons: &[String]) -> Vec<Reason> {
    Reason::ALL
        .into_iter()
        .filter(|reason| reasons.iter().any(|given| given == reason.as_str()))
        .collect()
}

/// Each person's settings, by username; the defaults for those who never chose.
pub async fn settings_of(db: &D1Database, usernames: &[String]) -> Result<HashMap<String, InboxSettings>> {
    if usernames.is_empty() {
        return Ok(HashMap::new());
    }
    let marks = vec!["?"; usernames.len()].join(", ");
    let values: Vec<JsValue> = usernames.iter().map(|name| JsValue::from(name.as_str())).collect();
    Ok(db
        .prepare(format!("SELECT username, email, default_watch FROM inbox_settings WHERE username IN ({marks})"))
        .bind(&values)?
        .all()
        .await?
        .results::<SettingsRow>()?
        .into_iter()
        .map(|row| (row.username.clone(), row.into_settings()))
        .collect())
}

pub async fn settings(db: &D1Database, a: InboxCountsArgs) -> Result<InboxSettings> {
    let username = a.username.to_lowercase();
    Ok(settings_of(db, std::slice::from_ref(&username))
        .await?
        .remove(&username)
        .unwrap_or_default())
}

pub async fn update_settings(db: &D1Database, a: UpdateInboxSettingsArgs) -> Result<InboxSettings> {
    let username = a.username.to_lowercase();
    let email = a
        .email
        .map(|reasons| {
            let names: Vec<String> = reasons.iter().map(|reason| reason.as_str().to_owned()).collect();
            serde_json::to_string(&email_reasons(&names).iter().map(|reason| reason.as_str()).collect::<Vec<_>>())
        })
        .transpose()?;
    db.prepare(
        "INSERT INTO inbox_settings (username, email, default_watch, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (username) DO UPDATE SET
           email = COALESCE(excluded.email, inbox_settings.email),
           default_watch = COALESCE(excluded.default_watch, inbox_settings.default_watch),
           updated_at = excluded.updated_at",
    )
    .bind(&[
        username.as_str().into(),
        email.map_or(JsValue::NULL, JsValue::from),
        a.default_watch.map_or(JsValue::NULL, |level| level.as_str().into()),
        rfc3339(now_ms()).into(),
    ])?
    .run()
    .await?;
    settings(db, InboxCountsArgs { username }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::credentials::Principal;

    fn row(state: &str, reason: Option<&str>) -> SubscriptionRow {
        SubscriptionRow {
            username: "ana".into(),
            state: state.into(),
            reason: reason.map(str::to_owned),
            chosen_at: None,
        }
    }

    #[test]
    fn a_row_says_more_than_taking_part() {
        assert_eq!(standing(None, Some(Reason::Author)), (true, false, Some(Reason::Author)));
        assert_eq!(standing(None, None), (false, false, None));
        assert_eq!(standing(Some(&row("unsubscribed", None)), Some(Reason::Author)), (false, false, None));
        assert_eq!(standing(Some(&row("ignored", None)), Some(Reason::Author)), (false, true, None));
        assert_eq!(standing(Some(&row("subscribed", Some("comment"))), None), (true, false, Some(Reason::Comment)));
        assert_eq!(standing(Some(&row("subscribed", None)), None), (true, false, Some(Reason::Manual)));
    }

    #[test]
    fn taking_part_is_owning_writing_being_assigned_or_reviewing() {
        let subject = InboxSubject {
            author: Principal { id: "usr_g1t_agent".into(), username: "g1t".into() },
            requested_by: Some(Principal { id: "usr_ana".into(), username: "ana".into() }),
            assignees: vec!["bo".into()],
            reviewers: vec!["cy".into()],
            ..InboxSubject::default()
        };
        assert_eq!(implicit(&subject, "ANA"), Some(Reason::Author));
        assert_eq!(implicit(&subject, "bo"), Some(Reason::Assign));
        assert_eq!(implicit(&subject, "cy"), Some(Reason::ReviewRequested));
        assert_eq!(implicit(&subject, "dee"), None);
    }

    #[test]
    fn an_audience_knows_who_ignores_unsubscribed_and_watches() {
        let audience = Audience {
            subscriptions: vec![
                Subscription { username: "ana".into(), state: State::Ignored, reason: None },
                Subscription { username: "bo".into(), state: State::Unsubscribed, reason: None },
                Subscription { username: "cy".into(), state: State::Subscribed, reason: Some(Reason::Mention) },
                Subscription { username: "dee".into(), state: State::Subscribed, reason: None },
            ],
            watchers: vec![
                Watcher { username: "eve".into(), level: WatchLevel::Ignore, events: Vec::new() },
                Watcher { username: "fay".into(), level: WatchLevel::Custom, events: vec!["deployments".into()] },
                Watcher { username: "gus".into(), level: WatchLevel::All, events: Vec::new() },
            ],
        };
        assert!(audience.ignores("ana") && audience.ignores("eve") && !audience.ignores("bo"));
        assert!(audience.unsubscribed("bo") && !audience.unsubscribed("cy"));
        assert_eq!(
            audience.subscribed().collect::<Vec<_>>(),
            vec![("cy".to_owned(), Reason::Mention), ("dee".to_owned(), Reason::Manual)]
        );
        assert_eq!(audience.watching("deployments").collect::<Vec<_>>(), vec!["fay", "gus"]);
        assert_eq!(audience.watching("issues").collect::<Vec<_>>(), vec!["gus"]);
    }

    #[test]
    fn choices_keep_only_what_is_known() {
        assert_eq!(custom_events(&["Pulls".into(), "releases".into(), "issues".into(), "pulls".into()]), vec!["issues", "pulls"]);
        assert_eq!(email_reasons(&["mention".into(), "nope".into(), "agent".into()]), vec![Reason::Agent, Reason::Mention]);
        let settings = SettingsRow { username: "ana".into(), email: None, default_watch: Some("participating".into()) }.into_settings();
        assert_eq!(settings.email, DEFAULT_EMAIL.to_vec());
        assert_eq!(settings.default_watch, WatchLevel::Participating);
        let settings = SettingsRow { username: "ana".into(), email: Some("[]".into()), default_watch: None }.into_settings();
        assert!(settings.email.is_empty());
        assert_eq!(settings.default_watch, WatchLevel::All);
    }
}
