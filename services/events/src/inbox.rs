//! The inbox, kept beside the event log. See `g1t_contracts::inbox`.
//!
//! As each batch arrives from the bus, the events that need a person are
//! read against what they name (the work service's `inbox_subject`) and one
//! item is written for each person told. Who is told is worked out in
//! [`notices`], from the event and its subject alone:
//!
//! | Event | Who | Severity |
//! | --- | --- | --- |
//! | `agent.asked` | the pull request's owner, and its issue's owner and assignees | warning |
//! | `checks.completed`, failed or errored | the pull request's owner | error |
//! | `workflow.completed`, failed | the pull request's owner, or whoever pushed | error |
//! | `review.completed` by g1t | the pull request's owner | success, or info for changes asked |
//! | `pull.ready` for a change g1t made | whoever asked g1t for it | success |
//! | `pull.merged` | the pull request's owner | success |
//! | `comment.created` | everyone mentioned, then the owner | info (success for an approval) |
//!
//! Nobody is told of what they did themselves, and g1t is never told. A
//! failure here is logged and the batch goes on: the bus never waits on
//! the inbox, so an item can be missed, but nothing else is held up.

use std::collections::{HashMap, HashSet};

use g1t_contracts::credentials::Principal;
use g1t_contracts::events::{Event, WorkspaceRenamed};
use g1t_contracts::identity::{AGENT_ID, UsernamesArgs};
use g1t_contracts::inbox::*;
use g1t_contracts::repos::{PathByIdArgs, ReadableArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{new_id, system};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, Fetcher, Result};

/// Items marked done are kept this long, then removed.
pub const DONE_DAYS: u32 = 30;
/// No item is kept longer than this, unless it was saved.
pub const MAX_DAYS: u32 = 180;
/// Unread warnings shown ahead of everything else on the first page.
const MAX_RANKED: u32 = 20;
const MAX_TITLE: usize = 200;
const MAX_BODY: usize = 300;

/// What the inbox asks about an event before deciding who is told.
#[derive(Debug, PartialEq, Eq)]
pub struct Wanted {
    pub repo_id: String,
    /// The issue or pull request, when the event names one.
    pub number: Option<u32>,
    pub comment_id: Option<String>,
}

/// One person to tell, and what.
#[derive(Debug, PartialEq, Eq)]
pub struct Notice {
    pub username: String,
    pub reason: &'static str,
    pub severity: Severity,
    pub title: String,
    pub body: String,
}

/// Who did it, as far as is known.
#[derive(Debug, Default)]
pub struct Actor {
    pub id: Option<String>,
    pub username: Option<String>,
}

impl Actor {
    fn is(&self, person: &Principal) -> bool {
        self.id.as_deref().is_some_and(|id| id == person.id) || self.is_named(&person.username)
    }

    fn is_named(&self, username: &str) -> bool {
        self.username.as_deref().is_some_and(|name| name.eq_ignore_ascii_case(username))
    }
}

fn is_g1t(username: &str) -> bool {
    username.eq_ignore_ascii_case(system::USERNAME) || username.eq_ignore_ascii_case("g1t-agent")
}

fn is_g1t_id(id: &str) -> bool {
    system::is_system_id(id) || id == AGENT_ID
}

/// The issue or pull request an event names, and what to read for it.
/// None for events the inbox does not tell anyone of.
pub fn wants(event: &Event) -> Option<Wanted> {
    let data = &event.data;
    let text = |key: &str| data[key].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
    let number = |key: &str| data[key].as_u64().and_then(|n| u32::try_from(n).ok());
    let repo_id = text("repoId").or_else(|| event.repo_id.clone())?;
    let on = |number: Option<u32>, comment_id: Option<String>| {
        Some(Wanted {
            repo_id: repo_id.clone(),
            number,
            comment_id,
        })
    };
    match event.kind.as_str() {
        "agent.asked" | "pull.merged" | "pull.ready" => on(Some(number("number")?), None),
        "checks.completed" => match data["status"].as_str() {
            Some("failed" | "errored") => on(Some(number("number")?), None),
            _ => None,
        },
        "review.completed" => match data["verdict"].as_str() {
            Some("approve" | "request_changes") => on(Some(number("number")?), None),
            _ => None,
        },
        "workflow.completed" => match data["conclusion"].as_str() {
            Some("failure") => on(number("pull"), None),
            _ => None,
        },
        "comment.created" => on(Some(number("number")?), Some(text("commentId")?)),
        _ => None,
    }
}

/// Collects who is told, each once, never the actor and never g1t.
struct Told<'a> {
    actor: &'a Actor,
    notices: Vec<Notice>,
}

impl Told<'_> {
    fn tell(&mut self, username: &str, reason: &'static str, severity: Severity, title: &str, body: &str) {
        let username = username.trim().trim_start_matches('@').to_lowercase();
        if username.is_empty()
            || is_g1t(&username)
            || self.actor.is_named(&username)
            || self.notices.iter().any(|told| told.username == username)
        {
            return;
        }
        self.notices.push(Notice {
            username,
            reason,
            severity,
            title: clip(title, MAX_TITLE),
            body: clip(body, MAX_BODY),
        });
    }

    /// A person known by id as well as name, such as an author.
    fn tell_person(&mut self, person: &Principal, reason: &'static str, severity: Severity, title: &str, body: &str) {
        if is_g1t_id(&person.id) || self.actor.is(person) {
            return;
        }
        self.tell(&person.username, reason, severity, title, body);
    }
}

fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let cut: String = text.chars().take(max - 1).collect();
    format!("{}…", cut.trim_end())
}

/// Who is told of `event`, in `repo` (`owner/name`), given what it names.
/// `actor` is who caused it; outcomes nobody chose (checks, workflows, a
/// review, an agent finishing) are told whoever caused them.
pub fn notices(event: &Event, repo: &str, actor: &Actor, subject: Option<&InboxSubject>) -> Vec<Notice> {
    let nobody = Actor::default();
    let data = &event.data;
    // The issue or pull request, as titles name it: `acme/rocket#12`.
    let at = match data["number"].as_u64().or(data["pull"].as_u64()) {
        Some(number) if subject.is_some() => format!("{repo}#{number}"),
        _ => repo.to_owned(),
    };
    let outcome = matches!(
        event.kind.as_str(),
        "checks.completed" | "workflow.completed" | "review.completed" | "pull.ready" | "agent.asked"
    );
    let mut told = Told {
        actor: if outcome { &nobody } else { actor },
        notices: Vec::new(),
    };

    match (event.kind.as_str(), subject) {
        ("agent.asked", Some(pull)) => {
            let title = format!("An agent is waiting on {}", at);
            told.tell_person(pull.owner(), "agent_asked", Severity::Warning, &title, &pull.title);
            if let Some(issue) = &pull.issue {
                told.tell_person(issue.owner(), "agent_asked", Severity::Warning, &title, &pull.title);
                for name in &issue.assignees {
                    told.tell(name, "agent_asked", Severity::Warning, &title, &pull.title);
                }
            }
        }
        ("checks.completed", Some(pull)) => {
            let title = match data["status"].as_str() {
                Some("errored") => format!("Checks could not run on {}", at),
                _ => format!("Checks failed on {}", at),
            };
            told.tell_person(pull.owner(), "checks_failed", Severity::Error, &title, &pull.title);
        }
        ("workflow.completed", subject) => {
            let workflow = data["workflow"].as_str().filter(|name| !name.is_empty()).unwrap_or("A workflow");
            match subject {
                Some(pull) => {
                    let title = format!("{workflow} failed on {}", at);
                    told.tell_person(pull.owner(), "workflow_failed", Severity::Error, &title, &pull.title);
                }
                None => {
                    // Not on a pull request: whoever pushed the commit it ran on.
                    let branch = data["ref"].as_str().unwrap_or_default();
                    let branch = branch.strip_prefix("refs/heads/").unwrap_or(branch);
                    let title = format!("{workflow} failed on {branch} in {repo}");
                    let body = format!("Run {} at {}", data["number"], short(data["sha"].as_str().unwrap_or_default()));
                    if let Some(id) = &actor.id
                        && !is_g1t_id(id)
                        && let Some(name) = &actor.username
                    {
                        told.tell(name, "workflow_failed", Severity::Error, &title, &body);
                    }
                }
            }
        }
        ("review.completed", Some(pull)) => {
            let (title, severity, reason) = match data["verdict"].as_str() {
                Some("approve") => (format!("g1t approved {}", at), Severity::Success, "approved"),
                _ => (format!("g1t asked for changes on {}", at), Severity::Info, "changes_requested"),
            };
            told.tell_person(pull.owner(), reason, severity, &title, &pull.title);
        }
        ("pull.ready", Some(pull)) => {
            // A change g1t made is ready: the agent's run is over.
            if let Some(owner) = pull.requested_by.as_ref().filter(|_| is_g1t_id(&pull.author.id) || is_g1t(&pull.author.username)) {
                let title = format!("g1t finished {}", at);
                told.tell_person(owner, "agent_finished", Severity::Success, &title, &pull.title);
            }
        }
        ("pull.merged", Some(pull)) => {
            let title = match &actor.username {
                Some(name) if !is_g1t(name) => format!("{name} merged {}", at),
                _ => format!("{} was merged", at),
            };
            told.tell_person(pull.owner(), "merged", Severity::Success, &title, &pull.title);
        }
        ("comment.created", Some(on)) => {
            let Some(comment) = on.comment.as_ref().filter(|comment| !comment.event) else {
                return Vec::new();
            };
            // Whoever wrote it is the actor, whatever the event says.
            let writer = Actor {
                id: Some(comment.author.id.clone()),
                username: Some(comment.author.username.clone()),
            };
            told.actor = &writer;
            let who = &comment.author.username;
            let body = if comment.excerpt.is_empty() { &on.title } else { &comment.excerpt };
            for name in &comment.mentions {
                let title = format!("{who} mentioned you on {}", at);
                told.tell(name, "mentioned", Severity::Info, &title, body);
            }
            let (reason, severity, title) = match comment.verdict.as_deref() {
                Some("approve") => ("approved", Severity::Success, format!("{who} approved {}", at)),
                Some("request_changes") => ("changes_requested", Severity::Info, format!("{who} asked for changes on {}", at)),
                _ => ("commented", Severity::Info, format!("{who} commented on {}", at)),
            };
            told.tell_person(on.owner(), reason, severity, &title, body);
            return told.notices;
        }
        _ => {}
    }
    told.notices
}

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// Where an item is on g1t.sh.
pub fn url(repo: Option<&str>, subject: Option<SubjectKind>, number: Option<u32>, run_id: Option<&str>) -> String {
    let Some(repo) = repo else {
        return "/inbox".to_owned();
    };
    match (subject, number, run_id) {
        (Some(SubjectKind::Pull), Some(number), _) => format!("/{repo}/pull/{number}"),
        (Some(SubjectKind::Issue), Some(number), _) => format!("/{repo}/issues/{number}"),
        (Some(SubjectKind::Run), _, Some(run)) => format!("/{repo}/actions/runs/{run}"),
        _ => format!("/{repo}"),
    }
}

// --- Writing ---------------------------------------------------------------

/// The services the inbox reads from as events arrive.
pub struct Sources<'a> {
    pub work: &'a Fetcher,
    pub repos: &'a Fetcher,
    pub identity: &'a Fetcher,
}

/// Writes the items a batch from the bus calls for. Never fails the batch:
/// what cannot be worked out is logged and left.
pub async fn deliver(db: &D1Database, sources: &Sources<'_>, events: &[Event]) {
    let wanted: Vec<(&Event, Wanted)> = events
        .iter()
        .filter_map(|event| wants(event).map(|wanted| (event, wanted)))
        .collect();
    if wanted.is_empty() {
        return;
    }
    // Everyone who caused one, named in one call.
    let ids: Vec<String> = wanted
        .iter()
        .filter_map(|(event, _)| event.actor.clone())
        .filter(|id| !is_g1t_id(id))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let names: HashMap<String, String> = if ids.is_empty() {
        HashMap::new()
    } else {
        g1t_kit::call(sources.identity, "usernames", &UsernamesArgs { ids })
            .await
            .unwrap_or_else(|error| {
                worker::console_error!("inbox: could not name who acted: {error}");
                HashMap::new()
            })
    };
    let mut paths: HashMap<String, Option<RepoPath>> = HashMap::new();
    for (event, wanted) in wanted {
        if let Err(error) = deliver_one(db, sources, &names, &mut paths, event, wanted).await {
            worker::console_error!("inbox: {} {} not delivered: {error}", event.kind, event.id);
        }
    }
}

async fn deliver_one(
    db: &D1Database,
    sources: &Sources<'_>,
    names: &HashMap<String, String>,
    paths: &mut HashMap<String, Option<RepoPath>>,
    event: &Event,
    wanted: Wanted,
) -> Result<()> {
    if !paths.contains_key(&wanted.repo_id) {
        let path: Option<RepoPath> = g1t_kit::call(
            sources.repos,
            "path_by_id",
            &PathByIdArgs {
                id: wanted.repo_id.clone(),
            },
        )
        .await?;
        paths.insert(wanted.repo_id.clone(), path);
    }
    // A repository that is gone tells nobody.
    let Some(path) = paths.get(&wanted.repo_id).cloned().flatten() else {
        return Ok(());
    };
    let subject: Option<InboxSubject> = match wanted.number {
        Some(number) => {
            let found: Option<InboxSubject> = g1t_kit::call(
                sources.work,
                "inbox_subject",
                &InboxSubjectArgs {
                    repo_id: wanted.repo_id.clone(),
                    number,
                    comment_id: wanted.comment_id.clone(),
                },
            )
            .await?;
            if found.is_none() {
                return Ok(());
            }
            found
        }
        None => None,
    };
    let actor = Actor {
        id: event.actor.clone(),
        username: match event.actor.as_deref() {
            Some(id) if is_g1t_id(id) => Some(system::USERNAME.to_owned()),
            Some(id) => names.get(id).map(|name| name.to_lowercase()),
            None => None,
        },
    };
    let repo = format!("{}/{}", path.namespace, path.name).to_lowercase();
    let told = notices(event, &repo, &actor, subject.as_ref());
    if told.is_empty() {
        return Ok(());
    }
    let (kind, number, run_id) = match (&subject, event.kind.as_str()) {
        (Some(subject), _) => (subject.kind, wanted.number, None),
        (None, "workflow.completed") => (Some(SubjectKind::Run), None, event.data["runId"].as_str()),
        (None, _) => (None, None, None),
    };
    let now = now_ms();
    let mut statements = Vec::with_capacity(told.len());
    for notice in told {
        statements.push(
            db.prepare(
                // A redelivered event finds its rows there already.
                "INSERT OR IGNORE INTO inbox_items (id, username, event_id, reason, severity, title, body,
                   workspace, repo_id, repo, subject, number, run_id, actor, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                new_id("ntf", now).into(),
                notice.username.as_str().into(),
                event.id.as_str().into(),
                notice.reason.into(),
                notice.severity.as_str().into(),
                notice.title.as_str().into(),
                notice.body.as_str().into(),
                path.namespace.to_lowercase().into(),
                wanted.repo_id.as_str().into(),
                repo.as_str().into(),
                kind.map_or(JsValue::NULL, |kind| kind.as_str().into()),
                number.map_or(JsValue::NULL, JsValue::from),
                run_id.map_or(JsValue::NULL, JsValue::from),
                actor.username.as_deref().map_or(JsValue::NULL, JsValue::from),
                event.time.as_str().into(),
            ])?,
        );
    }
    db.batch(statements).await?;
    Ok(())
}

// --- Reading and changing ----------------------------------------------------

#[derive(Deserialize)]
struct Row {
    id: String,
    reason: String,
    severity: String,
    title: String,
    body: String,
    workspace: Option<String>,
    repo_id: Option<String>,
    repo: Option<String>,
    subject: Option<String>,
    number: Option<f64>,
    run_id: Option<String>,
    actor: Option<String>,
    created_at: String,
    read_at: Option<String>,
    done_at: Option<String>,
    saved: f64,
    snoozed_until: Option<String>,
}

impl Row {
    fn into_item(self) -> InboxItem {
        let subject = self.subject.as_deref().and_then(SubjectKind::parse);
        let number = self.number.map(|n| n as u32);
        InboxItem {
            url: url(self.repo.as_deref(), subject, number, self.run_id.as_deref()),
            id: self.id,
            reason: self.reason,
            severity: Severity::parse(&self.severity).unwrap_or(Severity::Info),
            title: self.title,
            body: self.body,
            repo: self.repo,
            workspace: self.workspace,
            subject,
            number,
            actor: self.actor,
            created_at: self.created_at,
            read_at: self.read_at,
            done_at: self.done_at,
            saved: self.saved != 0.0,
            snoozed_until: self.snoozed_until,
        }
    }
}

const COLUMNS: &str = "id, reason, severity, title, body, workspace, repo_id, repo, subject, number, run_id, actor,
                       created_at, read_at, done_at, saved, snoozed_until";

/// The conditions that pick a view's items, after `username = ?1`; `?2` is now.
fn view_filter(view: InboxView) -> &'static str {
    match view {
        InboxView::Inbox => "done_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?2)",
        InboxView::Saved => "saved = 1",
        InboxView::Done => "done_at IS NOT NULL",
    }
}

/// Whether a list ranks unread warnings first: the inbox itself, unfiltered.
fn ranked(a: &ListInboxArgs) -> bool {
    a.view == InboxView::Inbox && a.severity.is_none() && !a.unread
}

pub async fn list(db: &D1Database, repos: &Fetcher, a: ListInboxArgs) -> Result<InboxPage> {
    let Some(viewer) = &a.viewer else {
        return Ok(InboxPage::default());
    };
    let username = viewer.username.to_lowercase();
    let now = rfc3339(now_ms());
    let limit = a.limit.unwrap_or(DEFAULT_INBOX_PAGE).clamp(1, MAX_INBOX_PAGE);
    let mut conditions = vec!["username = ?1".to_owned(), view_filter(a.view).to_owned()];
    let mut values: Vec<JsValue> = vec![username.as_str().into(), now.as_str().into()];
    if let Some(severity) = a.severity {
        values.push(severity.as_str().into());
        conditions.push(format!("severity = ?{}", values.len()));
    }
    if a.unread {
        conditions.push("read_at IS NULL".to_owned());
    }
    let ranked = ranked(&a);
    // Unread warnings lead the first page, and are left out of the rest.
    let leading = "severity = 'warning' AND read_at IS NULL";
    let mut rest = conditions.clone();
    if ranked {
        rest.push(format!("NOT ({leading})"));
    }
    if let Some(before) = &a.before {
        values.push(before.as_str().into());
        rest.push(format!("id < ?{}", values.len()));
    }
    values.push((limit + 1).into());
    let order = if a.view == InboxView::Done { "done_at DESC, id DESC" } else { "id DESC" };
    let mut statements = vec![
        db.prepare(format!(
            "SELECT {COLUMNS} FROM inbox_items WHERE {} ORDER BY {order} LIMIT ?{}",
            rest.join(" AND "),
            values.len()
        ))
        .bind(&values)?,
    ];
    if ranked && a.before.is_none() {
        statements.push(
            db.prepare(format!(
                "SELECT {COLUMNS} FROM inbox_items WHERE {} AND {leading} ORDER BY id DESC LIMIT ?3"
                , conditions.join(" AND ")
            ))
            .bind(&[username.as_str().into(), now.as_str().into(), MAX_RANKED.into()])?,
        );
    }
    let results = db.batch(statements).await?;
    let mut rows = results.first().map(|result| result.results::<Row>()).transpose()?.unwrap_or_default();
    let next = if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        rows.last().map(|row| row.id.clone())
    } else {
        None
    };
    let mut items: Vec<Row> = results.get(1).map(|result| result.results::<Row>()).transpose()?.unwrap_or_default();
    items.extend(rows);

    // What is about a repository they can no longer read is dropped.
    let ids: Vec<String> = items
        .iter()
        .filter_map(|row| row.repo_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if !ids.is_empty() {
        let readable: Vec<Repo> = g1t_kit::call(
            repos,
            "readable",
            &ReadableArgs {
                ids: ids.clone(),
                viewer: a.viewer.clone(),
            },
        )
        .await?;
        let readable: HashSet<String> = readable.into_iter().map(|repo| repo.id).collect();
        let gone: Vec<String> = ids.into_iter().filter(|id| !readable.contains(id)).collect();
        if !gone.is_empty() {
            forget(db, &username, &gone).await?;
            items.retain(|row| row.repo_id.as_ref().is_none_or(|id| !gone.contains(id)));
        }
    }
    Ok(InboxPage {
        items: items.into_iter().map(Row::into_item).collect(),
        next,
    })
}

/// Removes a person's items about repositories they cannot read.
async fn forget(db: &D1Database, username: &str, repo_ids: &[String]) -> Result<()> {
    let marks = vec!["?"; repo_ids.len()].join(", ");
    let mut values: Vec<JsValue> = vec![username.into()];
    values.extend(repo_ids.iter().map(|id| JsValue::from(id.as_str())));
    db.prepare(format!("DELETE FROM inbox_items WHERE username = ? AND repo_id IN ({marks})"))
        .bind(&values)?
        .run()
        .await?;
    Ok(())
}

#[derive(Deserialize)]
struct CountRow {
    severity: String,
    n: f64,
}

pub async fn counts(db: &D1Database, a: InboxCountsArgs) -> Result<InboxCounts> {
    let rows = db
        .prepare(
            "SELECT severity, count(*) AS n FROM inbox_items
             WHERE username = ? AND read_at IS NULL AND done_at IS NULL
               AND (snoozed_until IS NULL OR snoozed_until <= ?)
             GROUP BY severity",
        )
        .bind(&[a.username.to_lowercase().into(), rfc3339(now_ms()).into()])?
        .all()
        .await?
        .results::<CountRow>()?;
    let mut counts = InboxCounts::default();
    for row in rows {
        let n = row.n as u32;
        counts.unread += n;
        match Severity::parse(&row.severity) {
            Some(Severity::Error) => counts.error += n,
            Some(Severity::Warning) => counts.warning += n,
            Some(Severity::Success) => counts.success += n,
            Some(Severity::Info) | None => counts.info += n,
        }
    }
    Ok(counts)
}

/// The change a mark makes, as a `SET` clause; `?1` is now.
fn mark_change(mark: InboxMark) -> &'static str {
    match mark {
        InboxMark::Read => "read_at = COALESCE(read_at, ?1)",
        InboxMark::Unread => "read_at = NULL",
        InboxMark::Done => "done_at = ?1, read_at = COALESCE(read_at, ?1)",
        InboxMark::Undone => "done_at = NULL",
        InboxMark::Save => "saved = 1",
        InboxMark::Unsave => "saved = 0",
        InboxMark::Snooze => "snoozed_until = ?2, read_at = COALESCE(read_at, ?1)",
    }
}

#[derive(Deserialize)]
struct IdRow {
    #[allow(dead_code)]
    id: String,
}

/// Changes the person's own items. Returns how many changed.
pub async fn mark(db: &D1Database, a: MarkInboxArgs) -> Result<u32> {
    let now = rfc3339(now_ms());
    let until = match (a.mark, a.until.as_deref().map(str::trim)) {
        // Times compare as text (`g1t_contracts::time`); a snooze is for later.
        (InboxMark::Snooze, Some(until)) if until.len() == now.len() && until > now.as_str() => until.to_owned(),
        (InboxMark::Snooze, _) => return Ok(0),
        _ => String::new(),
    };
    let mut values: Vec<JsValue> = vec![now.as_str().into(), until.as_str().into(), a.username.to_lowercase().into()];
    let target = if a.all && a.ids.is_empty() {
        let mut target = "done_at IS NULL".to_owned();
        if let Some(severity) = a.severity {
            values.push(severity.as_str().into());
            target.push_str(&format!(" AND severity = ?{}", values.len()));
        }
        target
    } else {
        let ids: Vec<&String> = a.ids.iter().take(MAX_MARK).collect();
        if ids.is_empty() {
            return Ok(0);
        }
        let first = values.len() + 1;
        values.extend(ids.iter().map(|id| JsValue::from(id.as_str())));
        let marks: Vec<String> = (first..values.len() + 1).map(|at| format!("?{at}")).collect();
        format!("id IN ({})", marks.join(", "))
    };
    let changed = db
        .prepare(format!(
            "UPDATE inbox_items SET {} WHERE username = ?3 AND {target} RETURNING id",
            mark_change(a.mark)
        ))
        .bind(&values)?
        .all()
        .await?
        .results::<IdRow>()?;
    Ok(changed.len() as u32)
}

// --- Keeping up ------------------------------------------------------------------

/// Moves rows with renamed workspaces and repositories, and drops those
/// of purged repositories and deleted workspaces.
pub async fn follow(db: &D1Database, events: &[Event]) -> Result<()> {
    let mut statements = Vec::new();
    for event in events {
        let text = |key: &str| event.data[key].as_str().unwrap_or_default().to_lowercase();
        match event.kind.as_str() {
            "workspace.renamed" => {
                let Ok(renamed) = serde_json::from_value::<WorkspaceRenamed>(event.data.clone()) else {
                    continue;
                };
                let (from, to) = (renamed.from.to_lowercase(), renamed.to.to_lowercase());
                if from == to {
                    continue;
                }
                statements.push(
                    db.prepare(
                        "UPDATE inbox_items SET repo = ?2 || substr(repo, length(?1) + 1), workspace = ?2
                         WHERE workspace = ?1",
                    )
                    .bind(&[from.as_str().into(), to.as_str().into()])?,
                );
            }
            "repo.renamed" => statements.push(
                db.prepare("UPDATE inbox_items SET repo = ? WHERE repo_id = ?").bind(&[
                    format!("{}/{}", text("namespace"), text("to")).into(),
                    text("repoId").into(),
                ])?,
            ),
            "repo.transferred" => statements.push(
                db.prepare("UPDATE inbox_items SET repo = ?, workspace = ? WHERE repo_id = ?")
                    .bind(&[
                        format!("{}/{}", text("to"), text("name")).into(),
                        text("to").into(),
                        text("repoId").into(),
                    ])?,
            ),
            "repo.purged" => statements.push(
                db.prepare("DELETE FROM inbox_items WHERE repo_id = ?")
                    .bind(&[text("repoId").into()])?,
            ),
            "workspace.deleted" => statements.push(
                db.prepare("DELETE FROM inbox_items WHERE workspace = ?")
                    .bind(&[text("slug").into()])?,
            ),
            _ => {}
        }
    }
    if !statements.is_empty() {
        db.batch(statements).await?;
    }
    Ok(())
}

/// Removes items done more than [`DONE_DAYS`] ago, and any not saved older
/// than [`MAX_DAYS`]. Returns how many went.
pub async fn purge(db: &D1Database, now: u64) -> Result<u32> {
    let done = crate::audit::keep_from(now, DONE_DAYS);
    let oldest = crate::audit::keep_from(now, MAX_DAYS);
    let results = db
        .batch(vec![
            db.prepare("DELETE FROM inbox_items WHERE saved = 0 AND done_at < ?")
                .bind(&[done.into()])?,
            db.prepare("DELETE FROM inbox_items WHERE saved = 0 AND created_at < ?")
                .bind(&[oldest.into()])?,
        ])
        .await?;
    let mut removed = 0;
    for result in results {
        removed += result.meta()?.and_then(|meta| meta.changes).unwrap_or(0) as u32;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(kind: &str, actor: Option<&str>, data: serde_json::Value) -> Event {
        Event {
            id: "evt_1".into(),
            kind: kind.into(),
            source: "work".into(),
            time: "2026-10-07T12:00:00.000Z".into(),
            repo_id: Some("rep_1".into()),
            actor: actor.map(str::to_owned),
            data,
        }
    }

    fn person(id: &str, username: &str) -> Principal {
        Principal {
            id: id.into(),
            username: username.into(),
        }
    }

    fn actor(id: &str, username: &str) -> Actor {
        Actor {
            id: Some(id.into()),
            username: Some(username.into()),
        }
    }

    /// A pull request ana opened, assigned to bo, for an issue cy filed and dee is assigned.
    fn pull() -> InboxSubject {
        InboxSubject {
            kind: Some(SubjectKind::Pull),
            title: "Add the inbox".into(),
            author: person("usr_ana", "ana"),
            assignees: vec!["bo".into()],
            issue: Some(Box::new(InboxSubject {
                kind: Some(SubjectKind::Issue),
                title: "An inbox".into(),
                author: person("usr_cy", "cy"),
                assignees: vec!["dee".into()],
                ..InboxSubject::default()
            })),
            ..InboxSubject::default()
        }
    }

    /// A change g1t made for ana.
    fn g1t_pull() -> InboxSubject {
        InboxSubject {
            author: person(AGENT_ID, "g1t"),
            requested_by: Some(person("usr_ana", "ana")),
            ..pull()
        }
    }

    fn told(notices: &[Notice]) -> Vec<(&str, &str, Severity)> {
        notices
            .iter()
            .map(|notice| (notice.username.as_str(), notice.reason, notice.severity))
            .collect()
    }

    fn comment(author: Principal, body: &str, mentions: &[&str]) -> InboxSubject {
        InboxSubject {
            comment: Some(InboxComment {
                author,
                excerpt: body.into(),
                mentions: mentions.iter().map(|name| (*name).to_owned()).collect(),
                ..InboxComment::default()
            }),
            ..pull()
        }
    }

    #[test]
    fn only_events_that_tell_someone_are_read() {
        let asked = |kind: &str, data| wants(&event(kind, None, data));
        assert_eq!(
            asked("checks.completed", json!({ "repoId": "rep_1", "number": 4, "status": "failed" })),
            Some(Wanted { repo_id: "rep_1".into(), number: Some(4), comment_id: None })
        );
        assert_eq!(asked("checks.completed", json!({ "repoId": "rep_1", "number": 4, "status": "passed" })), None);
        assert_eq!(asked("review.completed", json!({ "repoId": "rep_1", "number": 4 })), None);
        assert_eq!(asked("workflow.completed", json!({ "repoId": "rep_1", "conclusion": "success" })), None);
        assert_eq!(
            asked("workflow.completed", json!({ "repoId": "rep_1", "conclusion": "failure" })),
            Some(Wanted { repo_id: "rep_1".into(), number: None, comment_id: None })
        );
        assert_eq!(
            asked("comment.created", json!({ "repoId": "rep_1", "number": 2, "commentId": "cmt_1" })).map(|w| w.comment_id),
            Some(Some("cmt_1".into()))
        );
        assert_eq!(asked("git.push", json!({ "repoId": "rep_1" })), None);
        assert_eq!(asked("issue.opened", json!({ "repoId": "rep_1", "number": 1 })), None);
    }

    #[test]
    fn a_waiting_agent_needs_the_pull_requests_and_the_issues_people_first() {
        let asked = event("agent.asked", Some("usr_agent"), json!({ "number": 7 }));
        let notices = notices(&asked, "acme/rocket", &Actor::default(), Some(&pull()));
        assert_eq!(
            told(&notices),
            vec![
                ("ana", "agent_asked", Severity::Warning),
                ("cy", "agent_asked", Severity::Warning),
                ("dee", "agent_asked", Severity::Warning),
            ]
        );
        assert_eq!(notices[0].title, "An agent is waiting on acme/rocket#7");
        assert_eq!(notices[0].body, "Add the inbox");
    }

    #[test]
    fn failures_go_to_whoever_answers_for_the_change() {
        let failed = event("checks.completed", None, json!({ "number": 7, "status": "failed" }));
        assert_eq!(told(&notices(&failed, "acme/rocket", &Actor::default(), Some(&pull()))), vec![("ana", "checks_failed", Severity::Error)]);
        // g1t's change is the person's who asked for it, never g1t's.
        let notices_ = notices(&failed, "acme/rocket", &Actor::default(), Some(&g1t_pull()));
        assert_eq!(told(&notices_), vec![("ana", "checks_failed", Severity::Error)]);
        let errored = event("checks.completed", None, json!({ "number": 7, "status": "errored" }));
        assert_eq!(notices(&errored, "acme/rocket", &Actor::default(), Some(&pull()))[0].title, "Checks could not run on acme/rocket#7");
    }

    #[test]
    fn a_workflow_that_fails_tells_its_pull_requests_owner_even_if_they_pushed() {
        let failed = event("workflow.completed", Some("usr_ana"), json!({ "pull": 7, "workflow": "CI", "conclusion": "failure" }));
        let notices_ = notices(&failed, "acme/rocket", &actor("usr_ana", "ana"), Some(&pull()));
        assert_eq!(told(&notices_), vec![("ana", "workflow_failed", Severity::Error)]);
        assert_eq!(notices_[0].title, "CI failed on acme/rocket#7");
        // On a branch: whoever pushed.
        let pushed = event(
            "workflow.completed",
            Some("usr_bo"),
            json!({ "workflow": "Deploy", "conclusion": "failure", "ref": "refs/heads/main", "number": 12, "sha": "abcdef0123" }),
        );
        let notices_ = notices(&pushed, "acme/rocket", &actor("usr_bo", "bo"), None);
        assert_eq!(told(&notices_), vec![("bo", "workflow_failed", Severity::Error)]);
        assert_eq!(notices_[0].title, "Deploy failed on main in acme/rocket");
        assert_eq!(notices_[0].body, "Run 12 at abcdef0");
        // Nobody to tell when g1t pushed.
        assert!(notices(&pushed, "acme/rocket", &actor("g1t", "g1t"), None).is_empty());
    }

    #[test]
    fn nobody_hears_of_what_they_did_themselves() {
        let merged = event("pull.merged", Some("usr_ana"), json!({ "number": 7 }));
        assert!(notices(&merged, "acme/rocket", &actor("usr_ana", "ana"), Some(&pull())).is_empty());
        let by_bo = notices(&merged, "acme/rocket", &actor("usr_bo", "bo"), Some(&pull()));
        assert_eq!(told(&by_bo), vec![("ana", "merged", Severity::Success)]);
        assert_eq!(by_bo[0].title, "bo merged acme/rocket#7");
        let by_queue = notices(&merged, "acme/rocket", &Actor::default(), Some(&pull()));
        assert_eq!(by_queue[0].title, "acme/rocket#7 was merged");
    }

    #[test]
    fn g1t_finishing_or_reviewing_tells_the_person_it_worked_for() {
        // The agent acts as the person it works for: still an outcome they hear of.
        let ready = event("pull.ready", Some("usr_ana"), json!({ "number": 7 }));
        let notices_ = notices(&ready, "acme/rocket", &actor("usr_ana", "ana"), Some(&g1t_pull()));
        assert_eq!(told(&notices_), vec![("ana", "agent_finished", Severity::Success)]);
        assert_eq!(notices_[0].title, "g1t finished acme/rocket#7");
        // A person's draft marked ready is not news to them.
        assert!(notices(&ready, "acme/rocket", &actor("usr_ana", "ana"), Some(&pull())).is_empty());

        let approve = event("review.completed", None, json!({ "number": 7, "verdict": "approve" }));
        assert_eq!(told(&notices(&approve, "acme/rocket", &Actor::default(), Some(&pull()))), vec![("ana", "approved", Severity::Success)]);
        let changes = event("review.completed", None, json!({ "number": 7, "verdict": "request_changes" }));
        assert_eq!(
            told(&notices(&changes, "acme/rocket", &Actor::default(), Some(&pull()))),
            vec![("ana", "changes_requested", Severity::Info)]
        );
    }

    #[test]
    fn comments_tell_those_mentioned_then_the_owner_never_the_writer() {
        let created = event("comment.created", Some("usr_bo"), json!({ "number": 7, "commentId": "cmt_1" }));
        let on = comment(person("usr_bo", "bo"), "@cy @bo have a look", &["cy", "bo", "g1t"]);
        let notices_ = notices(&created, "acme/rocket", &actor("usr_bo", "bo"), Some(&on));
        assert_eq!(
            told(&notices_),
            vec![("cy", "mentioned", Severity::Info), ("ana", "commented", Severity::Info)]
        );
        assert_eq!(notices_[0].title, "bo mentioned you on acme/rocket#7");
        assert_eq!(notices_[0].body, "@cy @bo have a look");
        // Mentioned and the owner: told once, as mentioned.
        let on = comment(person("usr_bo", "bo"), "@ana", &["ana"]);
        assert_eq!(told(&notices(&created, "acme/rocket", &actor("usr_bo", "bo"), Some(&on))), vec![("ana", "mentioned", Severity::Info)]);
        // The owner's own comment tells nobody but those they mention.
        let on = comment(person("usr_ana", "ana"), "thanks", &[]);
        assert!(notices(&created, "acme/rocket", &actor("usr_ana", "ana"), Some(&on)).is_empty());
        // Something that happened, not something written, tells nobody.
        let mut on = comment(person("usr_bo", "bo"), "assigned cy", &[]);
        on.comment.as_mut().unwrap().event = true;
        assert!(notices(&created, "acme/rocket", &actor("usr_bo", "bo"), Some(&on)).is_empty());
        // An approval is good news.
        let mut on = comment(person("usr_bo", "bo"), "", &[]);
        on.comment.as_mut().unwrap().verdict = Some("approve".into());
        let notices_ = notices(&created, "acme/rocket", &actor("usr_bo", "bo"), Some(&on));
        assert_eq!(told(&notices_), vec![("ana", "approved", Severity::Success)]);
        assert_eq!(notices_[0].body, "Add the inbox");
    }

    #[test]
    fn items_link_to_what_they_are_about() {
        assert_eq!(url(Some("acme/rocket"), Some(SubjectKind::Pull), Some(7), None), "/acme/rocket/pull/7");
        assert_eq!(url(Some("acme/rocket"), Some(SubjectKind::Issue), Some(3), None), "/acme/rocket/issues/3");
        assert_eq!(url(Some("acme/rocket"), Some(SubjectKind::Run), None, Some("run_1")), "/acme/rocket/actions/runs/run_1");
        assert_eq!(url(Some("acme/rocket"), None, None, None), "/acme/rocket");
        assert_eq!(url(None, None, None, None), "/inbox");
    }

    #[test]
    fn long_titles_are_cut_to_a_line() {
        let long = "x".repeat(400);
        assert_eq!(clip(&long, MAX_TITLE).chars().count(), MAX_TITLE);
        assert_eq!(clip("  short ", MAX_TITLE), "short");
    }

    #[test]
    fn marks_change_only_what_they_say() {
        assert_eq!(mark_change(InboxMark::Read), "read_at = COALESCE(read_at, ?1)");
        assert!(mark_change(InboxMark::Done).contains("done_at = ?1"));
        assert!(ranked(&ListInboxArgs {
            viewer: None,
            view: InboxView::Inbox,
            severity: None,
            unread: false,
            before: None,
            limit: None,
        }));
    }
}
