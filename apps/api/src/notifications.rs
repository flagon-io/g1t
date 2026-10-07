//! Notifications: a person's inbox, its threads, their subscriptions to
//! issues and pull requests, and how they watch repositories. The events
//! service keeps all of it (`g1t_contracts::inbox`); this is its public
//! shape, which follows the inbox's own: a thread is one item about one
//! thing, brought back to the top as things happen to it.
//!
//! Every operation here is the person's own: a personal access token or a
//! session, never a workspace's token or g1t's agents (which act as g1t,
//! and g1t is never told anything).

use g1t_contracts::inbox::*;
use g1t_contracts::repos::{GetArgs, Repo, RepoPath};
use g1t_contracts::time::{parse_rfc3339, rfc3339};
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, User, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::operations::{Op, Services};

fn failed(code: FailureCode, message: &str) -> Result<Outcome<Value>> {
    Ok(Outcome::fail(code, message))
}

fn ok<T: serde::Serialize>(value: &T) -> Result<Outcome<Value>> {
    Ok(Outcome::Ok(serde_json::to_value(value)?))
}

const NO_THREAD: &str = "No such notification thread.";
const NO_SUBJECT: &str = "Name a thread by id, or an issue or pull request by repo and number.";

fn text(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
}

/// A yes or no, given as a boolean or as `true`/`false` (a query string).
fn flag(input: &Value, key: &str) -> Option<bool> {
    match &input[key] {
        Value::Bool(value) => Some(*value),
        Value::String(text) => match text.trim() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn whole(input: &Value, key: &str) -> Option<u32> {
    match &input[key] {
        Value::Number(number) => number.as_u64().and_then(|n| u32::try_from(n).ok()),
        Value::String(digits) => digits.trim().parse().ok(),
        _ => None,
    }
}

/// A time given as RFC 3339, as the inbox stores times (to the
/// millisecond, in UTC), or why it is not one.
pub(crate) fn instant(input: &Value, key: &str) -> std::result::Result<Option<String>, String> {
    match text(input, key) {
        None => Ok(None),
        Some(given) => parse_rfc3339(&given)
            .map(|ms| Some(rfc3339(ms)))
            .ok_or_else(|| format!("{key} is a time like 2026-10-07T12:00:00Z, not {given}.")),
    }
}

/// The repository `repo` names, if the viewer may read it.
async fn readable_repo(services: &Services, viewer: &Viewer, input: &Value) -> Result<Option<Outcome<Repo>>> {
    let Some(path) = crate::operations::repo_path(input) else {
        return Ok(None);
    };
    let found: Outcome<Repo> = g1t_kit::call(
        &services.repos,
        "get",
        &GetArgs {
            path: RepoPath {
                namespace: path.namespace,
                name: path.name,
            },
            viewer: viewer.clone(),
        },
    )
    .await?;
    Ok(Some(found))
}

/// What `list_notifications` reads from its input.
pub(crate) fn list_args(viewer: &Viewer, input: &Value) -> std::result::Result<ListInboxArgs, String> {
    let view = match text(input, "view") {
        None => InboxView::Inbox,
        Some(view) => InboxView::parse(&view).ok_or_else(|| format!("view is inbox, saved or done, not {view}."))?,
    };
    let reason = match text(input, "reason") {
        None => None,
        Some(reason) => Some(Reason::parse(&reason).ok_or_else(|| {
            format!(
                "{reason} is not a reason. Give one of {}.",
                Reason::ALL.map(Reason::as_str).join(", ")
            )
        })?),
    };
    let severity = match text(input, "severity") {
        None => None,
        Some(severity) => Some(
            Severity::parse(&severity).ok_or_else(|| format!("severity is error, warning, success or info, not {severity}."))?,
        ),
    };
    // As it is elsewhere: what is unread, unless all is asked for. Saved
    // and done are lists of their own, read or not.
    let all = flag(input, "all").unwrap_or(false);
    let unread = flag(input, "unread").unwrap_or(view == InboxView::Inbox && !all);
    Ok(ListInboxArgs {
        viewer: viewer.clone(),
        view,
        severity,
        reason,
        participating: flag(input, "participating").unwrap_or(false),
        repo_id: None,
        unread,
        since: instant(input, "since")?,
        updated_before: instant(input, "before")?,
        before: text(input, "cursor"),
        limit: whole(input, "per_page").map(|n| n.clamp(1, MAX_INBOX_PAGE)),
    })
}

/// How a person watches a repository, as the API shows it: its level and
/// kinds, and the plain answers to whether they get its activity and
/// whether they ignore it.
pub(crate) fn watching_json(watching: &Watching, repo: Option<&str>) -> Value {
    json!({
        "repo": repo.map(str::to_owned).or_else(|| watching.repo.clone()),
        "level": watching.level,
        "events": watching.events,
        "subscribed": matches!(watching.level, WatchLevel::All | WatchLevel::Custom),
        "ignored": watching.level == WatchLevel::Ignore,
        "updated_at": watching.updated_at,
    })
}

/// The level `set_repo_subscription` asks for: `level` (with `events`), or
/// the yes-or-no of `subscribed` and `ignored`.
pub(crate) fn watch_level(input: &Value) -> std::result::Result<(WatchLevel, Vec<String>), String> {
    let events: Vec<String> = input["events"]
        .as_array()
        .map(|events| events.iter().filter_map(|event| event.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    if let Some(level) = text(input, "level") {
        let level = WatchLevel::parse(&level)
            .ok_or_else(|| format!("level is participating, all, ignore or custom, not {level}."))?;
        if level == WatchLevel::Custom {
            let unknown: Vec<&String> = events
                .iter()
                .filter(|event| !WATCH_EVENTS.contains(&event.trim().to_lowercase().as_str()))
                .collect();
            if let Some(event) = unknown.first() {
                return Err(format!("{event} is not something to watch. Give some of {}.", WATCH_EVENTS.join(", ")));
            }
            if events.is_empty() {
                return Err(format!("A custom watch needs events: some of {}.", WATCH_EVENTS.join(", ")));
            }
        }
        return Ok((level, events));
    }
    Ok(match (flag(input, "ignored"), flag(input, "subscribed")) {
        (Some(true), _) => (WatchLevel::Ignore, Vec::new()),
        (_, Some(false)) => (WatchLevel::Participating, Vec::new()),
        _ => (WatchLevel::All, Vec::new()),
    })
}

/// Which issue or pull request a subscription call names: a thread's id,
/// or a repository and number. Checks the viewer can read the repository.
async fn subscription_args(services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<SubscriptionArgs>> {
    if let Some(id) = text(input, "id") {
        return Ok(Outcome::Ok(SubscriptionArgs {
            viewer: viewer.clone(),
            id: Some(id),
            ..SubscriptionArgs::default()
        }));
    }
    let (Some(found), Some(number)) = (readable_repo(services, viewer, input).await?, whole(input, "number")) else {
        return Ok(Outcome::fail(FailureCode::Invalid, NO_SUBJECT));
    };
    Ok(match found {
        Outcome::Ok(repo) => Outcome::Ok(SubscriptionArgs {
            viewer: viewer.clone(),
            id: None,
            repo_id: Some(repo.id),
            number: Some(number),
        }),
        Outcome::Fail(failure) => Outcome::Fail(failure),
    })
}

/// The viewer as a person: notifications are nobody else's.
fn person(viewer: &Viewer) -> std::result::Result<&User, &'static str> {
    match viewer {
        Some(user) if user.kind == PrincipalKind::User => Ok(user),
        Some(_) => Err("Notifications are a person's own: use a personal access token, not a workspace's or an agent's."),
        None => Err("This needs a g1t access token."),
    }
}

/// One thread, after a change, or not found.
async fn thread_after(services: &Services, viewer: &Viewer, id: String) -> Result<Outcome<Value>> {
    let thread: Option<InboxThread> = g1t_kit::call(&services.events, "inbox_thread", &ThreadArgs { viewer: viewer.clone(), id }).await?;
    match thread {
        Some(thread) => ok(&thread),
        None => failed(FailureCode::NotFound, NO_THREAD),
    }
}

/// Marks one of the person's threads, then returns it as it is now.
async fn mark_one(services: &Services, viewer: &Viewer, user: &User, input: &Value, mark: InboxMark, until: Option<String>) -> Result<Outcome<Value>> {
    let Some(id) = text(input, "id") else {
        return failed(FailureCode::Invalid, "Give the thread's id.");
    };
    // Only a thread the person can still see; one about a repository they
    // lost is gone.
    if let Outcome::Fail(failure) = thread_after(services, viewer, id.clone()).await? {
        return Ok(Outcome::Fail(failure));
    }
    let _: u32 = g1t_kit::call(
        &services.events,
        "inbox_mark",
        &MarkInboxArgs {
            username: user.username.clone(),
            mark,
            ids: vec![id.clone()],
            all: false,
            severity: None,
            repo_id: None,
            last_read_at: None,
            until,
        },
    )
    .await?;
    thread_after(services, viewer, id).await
}

/// Runs one of the notification operations.
pub async fn run(op: Op, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let user = match person(viewer) {
        Ok(user) => user,
        Err(message) => return failed(FailureCode::Forbidden, message),
    };
    let username = user.username.to_lowercase();
    match op {
        Op::ListNotifications => {
            let mut args = match list_args(viewer, input) {
                Ok(args) => args,
                Err(message) => return failed(FailureCode::Invalid, &message),
            };
            if let Some(found) = readable_repo(services, viewer, input).await? {
                match found {
                    Outcome::Ok(repo) => args.repo_id = Some(repo.id),
                    Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
                }
            }
            let page: InboxPage = g1t_kit::call(&services.events, "inbox_list", &args).await?;
            ok(&page)
        }
        Op::MarkNotificationsRead => {
            let last_read_at = match instant(input, "last_read_at") {
                Ok(at) => at.unwrap_or_else(|| rfc3339(g1t_kit::now_ms())),
                Err(message) => return failed(FailureCode::Invalid, &message),
            };
            let repo_id = match readable_repo(services, viewer, input).await? {
                Some(Outcome::Ok(repo)) => Some(repo.id),
                Some(Outcome::Fail(failure)) => return Ok(Outcome::Fail(failure)),
                None => None,
            };
            let mark = if flag(input, "read") == Some(false) { InboxMark::Unread } else { InboxMark::Read };
            let marked: u32 = g1t_kit::call(
                &services.events,
                "inbox_mark",
                &MarkInboxArgs {
                    username,
                    mark,
                    ids: Vec::new(),
                    all: true,
                    severity: None,
                    repo_id,
                    last_read_at: Some(last_read_at.clone()),
                    until: None,
                },
            )
            .await?;
            ok(&json!({ "marked": marked, "last_read_at": last_read_at }))
        }
        Op::GetNotificationThread => match text(input, "id") {
            Some(id) => thread_after(services, viewer, id).await,
            None => failed(FailureCode::Invalid, "Give the thread's id."),
        },
        Op::MarkThreadRead => {
            let mark = if flag(input, "read") == Some(false) { InboxMark::Unread } else { InboxMark::Read };
            mark_one(services, viewer, user, input, mark, None).await
        }
        Op::MarkThreadDone => {
            let mark = if flag(input, "done") == Some(false) { InboxMark::Undone } else { InboxMark::Done };
            mark_one(services, viewer, user, input, mark, None).await
        }
        Op::SaveThread => {
            let mark = if flag(input, "saved") == Some(false) { InboxMark::Unsave } else { InboxMark::Save };
            mark_one(services, viewer, user, input, mark, None).await
        }
        Op::SnoozeThread => {
            let until = match instant(input, "until") {
                Ok(until) => until,
                Err(message) => return failed(FailureCode::Invalid, &message),
            };
            match until {
                Some(until) if until.as_str() <= rfc3339(g1t_kit::now_ms()).as_str() => {
                    failed(FailureCode::Invalid, "until is a time to come; leave it out to bring the thread back now.")
                }
                Some(until) => mark_one(services, viewer, user, input, InboxMark::Snooze, Some(until)).await,
                None => mark_one(services, viewer, user, input, InboxMark::Unsnooze, None).await,
            }
        }
        Op::GetThreadSubscription | Op::SetThreadSubscription | Op::DeleteThreadSubscription => {
            let on = match subscription_args(services, viewer, input).await? {
                Outcome::Ok(on) => on,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            };
            let found: Option<ThreadSubscription> = match op {
                Op::GetThreadSubscription => g1t_kit::call(&services.events, "inbox_subscription", &on).await?,
                _ => {
                    let (subscribed, ignored) = match op {
                        Op::SetThreadSubscription => (Some(flag(input, "subscribed").unwrap_or(true)), flag(input, "ignored").unwrap_or(false)),
                        _ => (Some(false), false),
                    };
                    g1t_kit::call(&services.events, "inbox_subscribe", &SubscribeArgs { on, subscribed, ignored }).await?
                }
            };
            match found {
                Some(subscription) => ok(&subscription),
                None => failed(FailureCode::NotFound, "No such issue or pull request, or it is a thread nobody subscribes to."),
            }
        }
        Op::GetRepoSubscription | Op::SetRepoSubscription | Op::DeleteRepoSubscription => {
            let repo = match readable_repo(services, viewer, input).await? {
                Some(Outcome::Ok(repo)) => repo,
                Some(Outcome::Fail(failure)) => return Ok(Outcome::Fail(failure)),
                None => return failed(FailureCode::Invalid, "Give the repository as \"owner/name\"."),
            };
            let path = format!("{}/{}", repo.namespace, repo.name);
            let watching: Watching = match op {
                Op::GetRepoSubscription => {
                    g1t_kit::call(&services.events, "inbox_watching", &WatchingArgs { username, repo_id: repo.id }).await?
                }
                _ => {
                    let (level, events) = match op {
                        Op::SetRepoSubscription => match watch_level(input) {
                            Ok((level, events)) => (Some(level), events),
                            Err(message) => return failed(FailureCode::Invalid, &message),
                        },
                        _ => (None, Vec::new()),
                    };
                    g1t_kit::call(
                        &services.events,
                        "inbox_watch",
                        &WatchArgs {
                            username,
                            repo_id: repo.id,
                            repo: Some(path.clone()),
                            level,
                            events,
                        },
                    )
                    .await?
                }
            };
            Ok(Outcome::Ok(watching_json(&watching, Some(&path))))
        }
        Op::ListWatchedRepos => {
            let watched: Vec<Watching> = g1t_kit::call(&services.events, "inbox_watched", &InboxCountsArgs { username }).await?;
            Ok(Outcome::Ok(Value::Array(watched.iter().map(|watching| watching_json(watching, None)).collect())))
        }
        _ => failed(FailureCode::NotFound, "No such endpoint."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewer() -> Viewer {
        Some(User {
            id: "usr_1".into(),
            username: "ana".into(),
            ..User::default()
        })
    }

    #[test]
    fn a_list_shows_what_is_unread_unless_all_is_asked_for() {
        let args = list_args(&viewer(), &json!({})).unwrap();
        assert!(args.unread);
        assert_eq!(args.view, InboxView::Inbox);
        let args = list_args(&viewer(), &json!({ "all": "true" })).unwrap();
        assert!(!args.unread);
        // Saved and done show everything in them.
        assert!(!list_args(&viewer(), &json!({ "view": "done" })).unwrap().unread);
        let args = list_args(
            &viewer(),
            &json!({ "reason": "review_requested", "participating": true, "since": "2026-10-01T00:00:00Z", "before": "2026-10-07T00:00:00Z", "cursor": "ntf_9", "per_page": "500" }),
        )
        .unwrap();
        assert_eq!(args.reason, Some(Reason::ReviewRequested));
        assert!(args.participating);
        assert_eq!(args.since.as_deref(), Some("2026-10-01T00:00:00.000Z"));
        assert_eq!(args.updated_before.as_deref(), Some("2026-10-07T00:00:00.000Z"));
        assert_eq!(args.before.as_deref(), Some("ntf_9"));
        assert_eq!(args.limit, Some(MAX_INBOX_PAGE));
    }

    #[test]
    fn a_list_names_what_it_cannot_read() {
        assert!(list_args(&viewer(), &json!({ "reason": "gossip" })).unwrap_err().contains("not a reason"));
        assert!(list_args(&viewer(), &json!({ "view": "archive" })).unwrap_err().contains("inbox, saved or done"));
        assert!(list_args(&viewer(), &json!({ "since": "yesterday" })).unwrap_err().contains("since is a time"));
    }

    #[test]
    fn watching_is_a_level_or_a_yes_or_no() {
        assert_eq!(watch_level(&json!({ "level": "all" })).unwrap().0, WatchLevel::All);
        assert_eq!(watch_level(&json!({ "ignored": true })).unwrap().0, WatchLevel::Ignore);
        assert_eq!(watch_level(&json!({ "subscribed": false })).unwrap().0, WatchLevel::Participating);
        assert_eq!(watch_level(&json!({})).unwrap().0, WatchLevel::All);
        let (level, events) = watch_level(&json!({ "level": "custom", "events": ["pulls", "deployments"] })).unwrap();
        assert_eq!((level, events.len()), (WatchLevel::Custom, 2));
        assert!(watch_level(&json!({ "level": "custom" })).unwrap_err().contains("needs events"));
        assert!(watch_level(&json!({ "level": "custom", "events": ["releases"] })).unwrap_err().contains("releases"));
        assert!(watch_level(&json!({ "level": "loud" })).is_err());
    }

    #[test]
    fn watching_says_plainly_whether_activity_comes() {
        let custom = Watching {
            repo_id: "rep_1".into(),
            repo: None,
            level: WatchLevel::Custom,
            events: vec!["pulls".into()],
            updated_at: None,
        };
        let shown = watching_json(&custom, Some("acme/rocket"));
        assert_eq!(shown["repo"], "acme/rocket");
        assert_eq!(shown["level"], "custom");
        assert_eq!(shown["subscribed"], true);
        assert_eq!(shown["ignored"], false);
        assert!(shown.get("repo_id").is_none());
    }

    #[test]
    fn notifications_are_a_persons_own() {
        assert!(person(&viewer()).is_ok());
        let workspace = Some(User { kind: PrincipalKind::Workspace, ..User::default() });
        assert!(person(&workspace).unwrap_err().contains("person's own"));
        assert!(person(&None).is_err());
    }
}
