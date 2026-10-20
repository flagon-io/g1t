//! `g1t work`: a workspace's work items, and coordinating work on them.
//! Listing, viewing, opening, editing, linking and closing work items; who
//! is on one (claims and sessions), what it waits on, handing it over, and
//! following what happens in the repository as it happens.
//!
//! A work item is its workspace's: `--workspace`, or the current
//! repository's. Its page is `{site}/{workspace}/-/work/{number}`.

use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet, VecDeque};
use std::time::{Duration, Instant};

use crate::cli::{
    CloseReason, ItemState, ReopenArgs, WorkArgs, WorkBlockArgs, WorkClaimArgs, WorkCloseArgs, WorkCommand,
    WorkCommentArgs, WorkDispatchArgs, WorkEditArgs, WorkEventsArgs, WorkHandoffArgs, WorkLinkArgs, WorkListArgs,
    WorkNewArgs, WorkNextArgs, WorkNumber, WorkPlanArgs, WorkReleaseArgs, WorkViewArgs,
};
use crate::client::{Call, Client};
use crate::context::Ctx;
use crate::error::{Error, Kind, Result};
use crate::output::{Cell, Output, ago, now, parse_time, s};
use crate::prompt;
use crate::repo::Repo;

/// How long a follow asks the API to hold each call, in seconds.
const WAIT_SECONDS: u64 = 25;
/// The longest a follow waits before trying again after a failure.
const MAX_BACKOFF_SECONDS: u64 = 30;
/// How many event ids a follow remembers, to print none twice.
const REMEMBERED: usize = 1_000;

pub fn run(ctx: &Ctx, args: WorkArgs) -> Result<()> {
    let workspace = args.workspace.as_deref();
    match args.command {
        WorkCommand::List(args) => list(ctx, workspace, args),
        WorkCommand::View(args) => view(ctx, workspace, args),
        WorkCommand::New(args) => new(ctx, workspace, args),
        WorkCommand::Comment(args) => comment(ctx, workspace, args),
        WorkCommand::Edit(args) => edit(ctx, workspace, args),
        WorkCommand::Close(args) => close(ctx, workspace, args),
        WorkCommand::Reopen(args) => reopen(ctx, workspace, args),
        WorkCommand::Link(args) => link(ctx, workspace, args),
        WorkCommand::Unlink(args) => unlink(ctx, workspace, args),
        WorkCommand::Claim(args) => claim(ctx, workspace, args),
        WorkCommand::Release(args) => release(ctx, workspace, args),
        WorkCommand::Handoff(args) => handoff(ctx, workspace, args),
        WorkCommand::Status => status(ctx),
        WorkCommand::Block(args) => block(ctx, workspace, args, true),
        WorkCommand::Unblock(args) => block(ctx, workspace, args, false),
        WorkCommand::Events(args) => events(ctx, args),
        WorkCommand::Plan(args) => plan(ctx, workspace, args),
        WorkCommand::Next(args) => next(ctx, workspace, args),
        WorkCommand::Dispatch(args) => dispatch(ctx, workspace, args),
    }
}

// --- where -------------------------------------------------------------

/// Where `g1t work` works: a workspace, the repository here when it is one
/// of that workspace's, and a client for the host.
pub struct Place {
    pub workspace: String,
    pub repo: Option<Repo>,
    pub client: Client,
}

impl Place {
    /// A work item's page.
    pub fn url(&self, number: u64) -> String {
        item_url(&self.client.host.site, &self.workspace, number)
    }

    /// `workspace#12`, as a work item is named outside its workspace.
    pub fn name(&self, number: u64) -> String {
        format!("{}#{number}", self.workspace)
    }

    /// The repository here, or why there is none.
    fn here(&self, what: &str) -> Result<&Repo> {
        self.repo.as_ref().ok_or_else(|| {
            Error::usage(format!("{what} needs a repository of the {} workspace: run it in one, or pass --repo OWNER/NAME.", self.workspace))
        })
    }

    /// A call to a work item operation of the workspace.
    fn op(&self, id: &str) -> Call<'_> {
        self.client.op(id).arg("workspace", &self.workspace)
    }
}

/// A work item's page on the site.
pub fn item_url(site: &str, workspace: &str, number: u64) -> String {
    format!("{site}/{workspace}/-/work/{number}")
}

/// The workspace a repository is in: its owner's.
pub fn workspace_of(repo: &Repo) -> String {
    repo.owner.to_lowercase()
}

/// `--workspace`, else the current repository's. With a workspace named,
/// the repository here counts only when it is one of that workspace's.
pub fn place(ctx: &Ctx, workspace: Option<&str>) -> Result<Place> {
    match workspace.map(str::trim).filter(|w| !w.is_empty()) {
        Some(workspace) => {
            let workspace = workspace.to_lowercase();
            let here = ctx.repo_client().ok().filter(|(repo, _)| workspace_of(repo) == workspace);
            let (repo, client) = match here {
                Some((repo, client)) => (Some(repo), client),
                None => (None, ctx.client()?),
            };
            Ok(Place { workspace, repo, client })
        }
        None => {
            let (repo, client) = ctx.repo_client().map_err(|_| {
                Error::usage("Not in a repository: say which workspace with --workspace SLUG, or which repository with --repo OWNER/NAME.")
            })?;
            Ok(Place { workspace: workspace_of(&repo), repo: Some(repo), client })
        }
    }
}

/// [`place`] for the coordination commands, which agents' hooks run in
/// the background: signed in, or failing at once, and quick to give up.
fn coordination_place(ctx: &Ctx, workspace: Option<&str>, read: Duration) -> Result<Place> {
    let mut place = place(ctx, workspace)?;
    if !place.client.has_token() {
        return Err(crate::context::not_signed_in(&place.client.host));
    }
    place.client = place.client.with_timeouts(Duration::from_secs(5), read);
    Ok(place)
}

/// Whether a repository was named with --repo (or G1T_REPO), rather than
/// found from the git remote.
fn repo_named(ctx: &Ctx) -> bool {
    ctx.global.repo.as_deref().is_some_and(|r| !r.trim().is_empty())
}

// --- work items ------------------------------------------------------------

fn list(ctx: &Ctx, workspace: Option<&str>, args: WorkListArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    let state = match args.state {
        ItemState::Open => Some("open"),
        ItemState::Closed => Some("closed"),
        ItemState::All => None,
    };
    // --repo narrows it to the work items linked to that repository; the
    // repository a checkout is in does not.
    let filter = place.repo.as_ref().filter(|_| repo_named(ctx));
    if args.role.is_some() && filter.is_none() {
        return Err(Error::usage("--role goes with --repo OWNER/NAME: how the work items are linked to it."));
    }
    let assignee = match &args.assignee {
        Some(a) => Some(super::who(ctx, &place.client, a)?),
        None => None,
    };
    let found = place
        .op("list_work_items")
        .query_opt("state", state)
        .query_opt("label", args.label.clone())
        .query_opt("milestone", args.milestone)
        .query_opt("assignee", assignee)
        .query_opt("repo", filter.map(Repo::to_string))
        .query_opt("role", args.role.map(|role| role.name()))
        .query_opt("horizon", args.horizon.map(|horizon| horizon.name()))
        .query_opt("limit", args.horizon.map(|_| args.limit.clamp(1, 100)))
        .send()?;
    let mut items = super::items(found, "items");
    if let Some(a) = &args.author {
        let who = super::who(ctx, &place.client, a)?;
        items.retain(|i| i["author"]["username"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(&who)));
    }
    items.truncate(args.limit);
    if ctx.out.structured() {
        return ctx.out.emit(&Value::Array(items));
    }
    if items.is_empty() {
        let in_what = filter.map(Repo::to_string).unwrap_or_else(|| place.workspace.clone());
        eprintln!("No {} work items in {in_what}.", state.unwrap_or("matching"));
        return Ok(());
    }
    print_list(&ctx.out, &items)
}

/// What a linked repository that is gone, with no path kept, is called (the web's `DELETED_REPO`).
const DELETED_REPO: &str = "deleted repository";

/// A linked repository's path, or "deleted repository" when it was deleted before work items and kept none.
fn repo_path(repo: &Value) -> &str {
    repo["path"].as_str().filter(|path| !path.is_empty()).unwrap_or(DELETED_REPO)
}

/// A work item's repositories, short: the first, and `+2` for the rest.
fn repos_cell(item: &Value) -> String {
    let paths: Vec<&str> = item["repos"].as_array().into_iter().flatten().map(repo_path).collect();
    match paths.as_slice() {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [first, rest @ ..] => format!("{first} +{}", rest.len()),
    }
}

pub fn print_list(out: &Output, items: &[Value]) -> Result<()> {
    let rows: Vec<Vec<Cell>> = items
        .iter()
        .map(|i| {
            let number = format!("#{}", i["number"]);
            let state = s(i, "state");
            let labels = super::names(&i["labels"]).join(", ");
            let repos = repos_cell(i);
            vec![
                Cell::styled(number.clone(), if state == "open" { out.green(&number) } else { out.dim(&number) }),
                Cell::new(s(i, "title")),
                Cell::styled(repos.clone(), out.dim(&repos)),
                Cell::styled(labels.clone(), out.dim(&labels)),
                Cell::styled(ago(s(i, "updated_at")), out.dim(&ago(s(i, "updated_at")))),
            ]
        })
        .collect();
    out.table(&["number", "title", "repos", "labels", "updated"], &rows)
}

fn view(ctx: &Ctx, workspace: Option<&str>, args: WorkViewArgs) -> Result<()> {
    let place = coordination_place(ctx, workspace, super::QUICK)?;
    if args.web {
        return super::browse::open(ctx, &place.url(args.number));
    }
    let mut work = place.op("get_work").arg("number", args.number).send()?;
    if args.comments {
        let detail = place.op("get_work_item").arg("number", args.number).send()?;
        work["comments"] = detail.get("comments").cloned().unwrap_or(json!([]));
    }
    work["url"] = Value::String(place.url(args.number));
    if ctx.out.structured() {
        return ctx.out.emit(&work);
    }
    print_context(&ctx.out, &place.name(args.number), &work);
    if args.comments {
        super::print_comments(&ctx.out, &work["comments"]);
    } else if let Some(count) = work["item"]["comment_count"].as_u64().filter(|n| *n > 0) {
        println!();
        println!("{}", ctx.out.dim(&format!("{count} comment(s): g1t work view {} --comments", args.number)));
    }
    println!();
    println!("{}", ctx.out.dim(s(&work, "url")));
    Ok(())
}

/// The repository a new work item is filed from, when there is one here.
fn origin(place: &Place) -> Option<String> {
    place.repo.as_ref().map(Repo::to_string)
}

fn new(ctx: &Ctx, workspace: Option<&str>, args: WorkNewArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    if args.web {
        let url = match &place.repo {
            Some(repo) => format!("{}/{}/-/work/new?repo={}", place.client.host.site, place.workspace, repo.name),
            None => format!("{}/{}/-/work/new", place.client.host.site, place.workspace),
        };
        return super::browse::open(ctx, &url);
    }
    let title = match args.title {
        Some(t) => t,
        None if prompt::interactive() => prompt::input("Title:", None)?,
        None => return Err(prompt::needed("A title", "--title")),
    };
    if title.trim().is_empty() {
        return Err(Error::usage("The title is empty."));
    }
    let body = prompt::body(
        args.body.body,
        args.body.body_file.as_deref(),
        args.body.body_file.is_none() && args.attach.is_empty() && prompt::interactive() && !ctx.out.structured(),
    )?;
    // Images go with a repository it is filed from; without one, the work
    // item keeps them, once it is open.
    let (body, later) = match &place.repo {
        Some(repo) if !args.attach.is_empty() => (super::attach::with_attachments(&place.client, repo, body, &args.attach)?, &[][..]),
        _ => (body, &args.attach[..]),
    };
    let labels: Vec<Value> = args.label.iter().map(|l| Value::String(l.clone())).collect();
    let targets: Vec<Value> = args.target.iter().map(|t| Value::String(t.trim().to_owned())).collect();
    let made = place
        .op("open_work_item")
        .field("title", title)
        .field_opt("body", body)
        .field_opt("repo", origin(&place))
        .field_opt("targets", (!targets.is_empty()).then_some(Value::Array(targets)))
        .field_opt("labels", (!labels.is_empty()).then_some(Value::Array(labels)))
        .field_opt("milestone", args.milestone)
        .send()?;
    let number = made["number"].as_u64().unwrap_or_default();
    let made = if later.is_empty() {
        made
    } else {
        let body = super::attach::with_item_attachments(&place.client, &place.workspace, number, made["body"].as_str().map(str::to_owned), later)?;
        place.op("update_work_item").arg("number", number).field_opt("body", body).send()?
    };
    let made = if args.assignee.is_empty() {
        made
    } else {
        let who: Vec<Value> = args
            .assignee
            .iter()
            .map(|a| super::who(ctx, &place.client, a).map(Value::String))
            .collect::<Result<_>>()?;
        place.op("update_work_item").arg("number", number).field("assignees", Value::Array(who)).send()?
    };
    super::done(ctx, &made, &format!("Opened {}", place.name(number)), &place.url(number))
}

fn comment(ctx: &Ctx, workspace: Option<&str>, args: WorkCommentArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    // Images alone make a comment; without any, the text is asked for.
    let body = prompt::body(args.body.body, args.body.body_file.as_deref(), args.attach.is_empty())?;
    let body = super::attach::with_item_attachments(&place.client, &place.workspace, args.number, body, &args.attach)?;
    let body = body
        .filter(|b| !b.trim().is_empty())
        .ok_or_else(|| prompt::needed("The comment", "--body, --body-file or --attach"))?;
    let made = place.op("add_work_item_comment").arg("number", args.number).field("body", body).send()?;
    let id = s(&made, "id").to_owned();
    super::done(ctx, &made, &format!("Commented on {}", place.name(args.number)), &format!("{}#{id}", place.url(args.number)))
}

fn close(ctx: &Ctx, workspace: Option<&str>, args: WorkCloseArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    // A commit is on a repository's default branch: this one's.
    let repo = match &args.commit {
        Some(_) => Some(place.here("--commit")?.to_string()),
        None => None,
    };
    if let Some(text) = args.comment {
        place.op("add_work_item_comment").arg("number", args.number).field("body", text).send()?;
    }
    let reason = args.reason.map(|r| match r {
        CloseReason::Completed => "completed",
        CloseReason::NotPlanned => "not_planned",
    });
    let closed = place
        .op("close_work_item")
        .arg("number", args.number)
        .field_opt("reason", reason)
        .field_opt("commit", args.commit.as_deref())
        .field_opt("repo", repo)
        .send()?;
    let said = if closed["state"] == "closed" {
        format!("Closed {}", place.name(args.number))
    } else {
        format!("Landed {} in this repository; it waits on {}", place.name(args.number), missing(&closed).join(", "))
    };
    super::done(ctx, &closed, &said, &place.url(args.number))
}

/// The targets a work item has not landed in yet.
fn missing(item: &Value) -> Vec<String> {
    item["repos"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["role"] == "target" && r["landed"] != true)
        .map(|r| repo_path(r).to_owned())
        .collect()
}

fn reopen(ctx: &Ctx, workspace: Option<&str>, args: ReopenArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    if let Some(text) = args.comment {
        place.op("add_work_item_comment").arg("number", args.number).field("body", text).send()?;
    }
    let opened = place.op("reopen_work_item").arg("number", args.number).send()?;
    super::done(ctx, &opened, &format!("Reopened {}", place.name(args.number)), &place.url(args.number))
}

fn edit(ctx: &Ctx, workspace: Option<&str>, args: WorkEditArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    let body = prompt::body(args.body.body, args.body.body_file.as_deref(), false)?;
    let mut call = place.op("update_work_item").arg("number", args.number);
    let mut changed = false;
    if let Some(t) = args.title {
        call = call.field("title", t);
        changed = true;
    }
    if let Some(b) = body {
        call = call.field("body", b);
        changed = true;
    }
    let touches_lists = !(args.add_label.is_empty()
        && args.remove_label.is_empty()
        && args.add_assignee.is_empty()
        && args.remove_assignee.is_empty());
    if touches_lists {
        let found = place.op("get_work_item").arg("number", args.number).send()?;
        let item = found.get("item").unwrap_or(&found);
        if !(args.add_label.is_empty() && args.remove_label.is_empty()) {
            let labels = super::adjust(super::names(&item["labels"]), &args.add_label, &args.remove_label);
            call = call.field("labels", json!(labels));
        }
        if !(args.add_assignee.is_empty() && args.remove_assignee.is_empty()) {
            let add: Vec<String> = args.add_assignee.iter().map(|a| super::who(ctx, &place.client, a)).collect::<Result<_>>()?;
            let remove: Vec<String> =
                args.remove_assignee.iter().map(|a| super::who(ctx, &place.client, a)).collect::<Result<_>>()?;
            call = call.field("assignees", json!(super::adjust(super::names(&item["assignees"]), &add, &remove)));
        }
        changed = true;
    }
    if let Some(m) = args.milestone {
        call = call.field("milestone", m);
        changed = true;
    }
    if args.remove_milestone {
        call = call.field("milestone", Value::Null);
        changed = true;
    }
    if !changed {
        return Err(Error::usage("Nothing to change: pass --title, --body, --add-label, --add-assignee or --milestone."));
    }
    let updated = call.send()?;
    super::done(ctx, &updated, &format!("Edited {}", place.name(args.number)), &place.url(args.number))
}

fn link(ctx: &Ctx, workspace: Option<&str>, args: WorkLinkArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    let repo = place.here("Linking")?.to_string();
    let linked = place
        .op("link_work_item")
        .arg("number", args.number)
        .field("repo", repo.as_str())
        .field("role", args.role.name())
        .send()?;
    super::done(ctx, &linked, &format!("Linked {repo} to {} as {}", place.name(args.number), args.role.name()), &place.url(args.number))
}

fn unlink(ctx: &Ctx, workspace: Option<&str>, args: WorkNumber) -> Result<()> {
    let place = place(ctx, workspace)?;
    let repo = place.here("Unlinking")?.to_string();
    let unlinked = place.op("unlink_work_item").arg("number", args.number).query("repo", &repo).send()?;
    super::done(ctx, &unlinked, &format!("Unlinked {repo} from {}", place.name(args.number)), &place.url(args.number))
}

// --- coordination ------------------------------------------------------------
/// `in 27m`, `in 2h5m`, or `expired` for a time still to come.
pub fn until(text: &str) -> String {
    match parse_time(text) {
        Some(then) if then > now() => format!("in {}", crate::output::duration(then - now())),
        Some(_) => "expired".to_owned(),
        None => text.to_owned(),
    }
}

/// One claim as a line: who, with what, since when, until when, and why.
pub fn claim_line(out: &Output, claim: &Value) -> String {
    let who = super::login_of(claim);
    let mut line = out.bold(if who.is_empty() { "someone" } else { &who });
    if let Some(harness) = claim["harness"].as_str().filter(|h| !h.is_empty()) {
        line.push_str(&out.dim(&format!(" ({harness})")));
    }
    if let Some(item) = claim["item"].as_u64() {
        line.push_str(&format!(" on #{item}"));
    }
    let state = s(claim, "state");
    if !state.is_empty() && state != "active" {
        line.push_str(&format!(" {}", out.state(state)));
    }
    if let Some(created) = claim["created_at"].as_str() {
        line.push_str(&out.dim(&format!(" since {}", ago(created))));
    }
    if let Some(expires) = claim["expires_at"].as_str().filter(|_| state.is_empty() || state == "active") {
        line.push_str(&out.dim(&format!(", expires {}", until(expires))));
    }
    if let Some(to) = claim["handoff_to"].as_str() {
        line.push_str(&format!(", handed to {to}"));
    }
    if let Some(note) = claim["note"].as_str().filter(|n| !n.trim().is_empty()) {
        line.push_str(&format!(": {}", note.trim()));
    }
    line
}

/// A work item another one waits on, as a line.
fn blocker_line(out: &Output, blocker: &Value) -> String {
    let mut line = format!("#{} {} {}", blocker["number"], s(blocker, "title"), out.state(s(blocker, "state")));
    let claims = blocker["claims"].as_array().map(Vec::as_slice).unwrap_or_default();
    let who: Vec<String> = claims.iter().map(super::login_of).filter(|w| !w.is_empty()).collect();
    if !who.is_empty() {
        line.push_str(&out.dim(&format!(", claimed by {}", who.join(", "))));
    }
    let pulls: Vec<String> = blocker["pulls"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| match p["status"].as_str().or_else(|| p["state"].as_str()) {
            Some(status) => format!("#{} {status}", p["number"]),
            None => format!("#{}", p["number"]),
        })
        .collect();
    if !pulls.is_empty() {
        line.push_str(&out.dim(&format!(", pull requests {}", pulls.join(", "))));
    }
    line
}

fn heading(out: &Output, title: &str) {
    println!();
    println!("{}", out.bold(title));
}

fn list_of<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or_default()
}

pub fn print_context(out: &Output, name: &str, work: &Value) {
    let item = &work["item"];
    println!("{} {}", out.bold(s(item, "title")), out.dim(name));
    let mut facts = vec![out.state(s(item, "state"))];
    let assignees: Vec<String> = item["assignees"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a.as_str().map(str::to_owned).or_else(|| a["username"].as_str().map(str::to_owned)))
        .collect();
    if !assignees.is_empty() {
        facts.push(format!("assigned to {}", assignees.join(", ")));
    }
    let labels = super::names(&item["labels"]);
    if !labels.is_empty() {
        facts.push(format!("labels {}", labels.join(", ")));
    }
    if let Some(milestone) = item["milestone"]["title"].as_str() {
        facts.push(format!("milestone {milestone}"));
    }
    println!("{}", facts.join(" · "));
    println!();
    match item["body"].as_str().filter(|b| !b.trim().is_empty()) {
        Some(body) => println!("{}", body.trim_end()),
        None => println!("{}", out.dim("No description.")),
    }
    // get_work gives the items under its "Definition of done".
    let done: Vec<&str> = list_of(work, "definition_of_done").iter().filter_map(Value::as_str).collect();
    if !done.is_empty() {
        heading(out, "Definition of done");
        for line in done {
            println!("  - {line}");
        }
    }
    heading(out, "Repositories");
    let repos = list_of(work, "repos");
    if repos.is_empty() {
        println!("  {}", out.dim("None linked yet."));
    }
    for repo in repos {
        let landed = if repo["landed"] == true { format!(" {}", out.green("landed")) } else { String::new() };
        let legacy = repo["legacy_number"].as_u64().map(|n| out.dim(&format!(" (was #{n} there)"))).unwrap_or_default();
        let path = repo_path(repo);
        let path = if path == DELETED_REPO { out.dim(path) } else { path.to_owned() };
        println!("  {path} {}{landed}{legacy}", out.dim(s(repo, "role")));
        for pull in list_of(repo, "pulls") {
            println!("    {}", pull_line(out, pull));
            for overlap in list_of(pull, "overlaps") {
                let other = overlap["pull"].as_u64().or_else(|| overlap["number"].as_u64()).unwrap_or(0);
                let files: Vec<&str> =
                    list_of(overlap, "paths").iter().chain(list_of(overlap, "files")).filter_map(Value::as_str).collect();
                println!(
                    "      {} #{other}{}",
                    out.yellow("overlaps"),
                    if files.is_empty() { String::new() } else { format!(": {}", files.join(", ")) }
                );
            }
        }
    }
    let missing: Vec<&str> = list_of(work, "missing").iter().filter_map(Value::as_str).collect();
    if !missing.is_empty() {
        println!("  {} {}", out.yellow("Still to land in:"), missing.join(", "));
    }
    let suggested = list_of(work, "suggested_targets");
    if !suggested.is_empty() {
        heading(out, "Suggested targets");
        for target in suggested {
            let target: Suggested = serde_json::from_value(target.clone()).unwrap_or_default();
            println!("  {} {}", target.path, out.dim(&target.why));
        }
        println!("  {}", out.dim("Link one: g1t work link N --repo OWNER/NAME"));
    }
    heading(out, "Claims");
    let claims = list_of(work, "claims");
    if claims.is_empty() {
        println!("  {}", out.dim("Nobody has claimed it."));
    }
    for claim in claims {
        println!("  {}", claim_line(out, claim));
    }
    let sessions = list_of(work, "sessions");
    if !sessions.is_empty() {
        heading(out, "Sessions");
        for session in sessions {
            let mut line = format!(
                "{} {} {}",
                s(session, "id"),
                out.state(s(session, "state")),
                super::login_of(session)
            );
            if let Some(harness) = session["harness"].as_str() {
                line.push_str(&out.dim(&format!(" ({harness})")));
            }
            if let Some(branch) = session["branch"].as_str().filter(|b| !b.is_empty()) {
                line.push_str(&format!(" on {branch}"));
            }
            if let Some(seen) = session["last_seen_at"].as_str() {
                line.push_str(&out.dim(&format!(", last seen {}", ago(seen))));
            }
            println!("  {line}");
        }
    }
    let blocked_by = list_of(work, "blocked_by");
    if !blocked_by.is_empty() {
        heading(out, "Blocked by");
        for blocker in blocked_by {
            println!("  {}", blocker_line(out, blocker));
        }
    }
    let blocks = list_of(work, "blocks");
    if !blocks.is_empty() {
        heading(out, "Blocks");
        for blocked in blocks {
            println!("  #{} {} {}", blocked["number"], s(blocked, "title"), out.state(s(blocked, "state")));
        }
    }
    let failure = &work["last_integration_failure"];
    if failure.is_object() {
        heading(out, "Last integration failure");
        println!("  {}", event_summary(failure.get("data").unwrap_or(failure)));
    }
    let decisions = list_of(work, "decisions");
    if !decisions.is_empty() {
        heading(out, "Decisions");
        for decision in decisions {
            println!("  {}", decision_line(out, decision));
        }
    }
    let recent = list_of(work, "recent");
    if !recent.is_empty() {
        heading(out, "Recent");
        for event in recent {
            println!("  {}", event_line(out, event));
        }
    }
}

/// A repository a work item may belong in, and why.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct Suggested {
    path: String,
    why: String,
}

/// One of a work item's pull requests as a line: its number, title,
/// status, checks and place in the merge queue.
fn pull_line(out: &Output, pull: &Value) -> String {
    let status = pull["status"].as_str().or_else(|| pull["state"].as_str()).unwrap_or("");
    let mut line = format!("#{} {} {}", pull["number"], s(pull, "title"), out.state(status));
    let checks = pull["checks"]["status"].as_str().or_else(|| pull["checks"].as_str()).or_else(|| pull["check_status"].as_str());
    if let Some(checks) = checks {
        line.push_str(&format!(", checks {}", out.state(checks)));
    }
    if let Some(position) = pull["queue_position"].as_u64().or_else(|| pull["queue"]["position"].as_u64()) {
        line.push_str(&format!(", queued {position}"));
    }
    line
}

/// A decision as a line: how sure, what kind, what it says, who and when.
pub fn decision_line(out: &Output, decision: &Value) -> String {
    let confidence = s(decision, "confidence");
    let shown = match confidence {
        "approved" => out.green(confidence),
        "tested" => out.cyan(confidence),
        _ => out.dim(confidence),
    };
    let mut line = format!("[{shown}] {}: {}", s(decision, "kind"), s(decision, "summary"));
    let who = super::login_of(decision);
    let when = decision["created_at"].as_str().map(ago).unwrap_or_default();
    let by = [who, when].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
    if !by.is_empty() {
        line.push_str(&out.dim(&format!(" ({by})")));
    }
    line
}

fn claim(ctx: &Ctx, workspace: Option<&str>, args: WorkClaimArgs) -> Result<()> {
    if args.number.is_some() && args.body.is_some() {
        return Err(Error::usage("--body is the new work item's description: give it with --title, not a number."));
    }
    let place = coordination_place(ctx, workspace, super::QUICK)?;
    // A number claims that work item; a title opens one and claims it.
    let request = match (args.number, &args.title) {
        (Some(number), _) => place.op("claim_work_item").arg("number", number),
        (None, Some(title)) => place.op("claim_new_work_item").field("title", title.as_str()).field_opt("body", args.body.clone()),
        (None, None) => return Err(Error::usage("Name the work item by its number, or give --title to open one.")),
    };
    // The checkout it is claimed from, which a new work item is filed from.
    let found = request
        .field_opt("repo", origin(&place))
        .field_opt("session_id", super::session::current())
        .field_opt("note", args.note.clone())
        .field_opt("ttl_minutes", args.ttl)
        .send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    let out = &ctx.out;
    let claim = &found["claim"];
    let number = claimed_number(args.number, &found);
    if args.number.is_none() {
        println!("Opened {} {}.", place.name(number), s(&found["item"], "title"));
    }
    match claim["expires_at"].as_str() {
        Some(expires) => println!("Claimed #{number}; it expires {} unless renewed.", until(expires)),
        None => println!("Claimed #{number}."),
    }
    let others = list_of(&found, "others");
    if !others.is_empty() {
        println!("{}", out.yellow(&format!("#{number} is claimed by others too:")));
        for other in others {
            println!("  {}", claim_line(out, other));
        }
    }
    let waiting: Vec<&Value> = list_of(&found, "blocked_by")
        .iter()
        .filter(|b| !matches!(b["state"].as_str(), Some("closed" | "merged")))
        .collect();
    if !waiting.is_empty() {
        println!("{}", out.yellow(&format!("#{number} waits on:")));
        for blocker in waiting {
            println!("  {}", blocker_line(out, blocker));
        }
    }
    Ok(())
}

/// The work item a claim is on: the number given, or the one it opened.
fn claimed_number(given: Option<u64>, found: &Value) -> u64 {
    given
        .or_else(|| found["claim"]["item"].as_u64())
        .or_else(|| found["item"]["number"].as_u64())
        .unwrap_or_default()
}

/// The time a dispatch may take: starting a Managed Agents session makes
/// several calls to the provider.
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(60);

fn dispatch(ctx: &Ctx, workspace: Option<&str>, mut args: WorkDispatchArgs) -> Result<()> {
    // Neither a number nor a title: what the plan says to take next.
    if args.number.is_none() && args.title.is_none() {
        let place = coordination_place(ctx, workspace, super::QUICK)?;
        let found = place.op("next_work_item").query_opt("repo", place.repo.as_ref().filter(|_| repo_named(ctx)).map(Repo::to_string)).send()?;
        let Some(number) = next_item(&found)["number"].as_u64() else {
            return Err(Error::usage(format!("Nothing in {}'s plan is ready to take: give a work item's number, or --title for a new one.", place.workspace)));
        };
        eprintln!("Taking #{number}, next in the plan.");
        args.number = Some(number);
    }
    let (repo, client) = super::coordination_client(ctx, DISPATCH_TIMEOUT)?;
    let handoff = if args.handoff {
        Some(true)
    } else if args.managed {
        Some(false)
    } else {
        None
    };
    let found = client
        .op("start_agent_session")
        .repo(&repo)
        .field_opt("item", args.number)
        .field_opt("title", args.title.clone())
        .field_opt("body", args.body.clone())
        .field_opt("instruction", args.instruction.clone())
        .field_opt("mode", args.mode.map(|mode| mode.name()))
        .field_opt("handoff", handoff)
        .send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    let item = found["item"].as_u64().unwrap_or_default();
    if found["handoff"].as_bool() == Some(true) {
        eprintln!("Run this where the repository is checked out, with g1t's Claude Code plugin, to work on #{item}:");
        println!("{}", s(&found, "command"));
        return Ok(());
    }
    let out = &ctx.out;
    println!("{}", s(&found, "session_url"));
    eprintln!(
        "Started {} on #{item} on the workspace's Anthropic account.",
        found["session"]["id"].as_str().unwrap_or("a session")
    );
    if let Some(url) = found["provider_session_url"].as_str() {
        eprintln!("{} {url}", out.dim("On Anthropic:"));
    }
    Ok(())
}

// --- the plan ---------------------------------------------------------------

/// What a plan's horizon is called, as people say it.
fn horizon_label(name: &str) -> &str {
    match name {
        "now" => "Now",
        "next" => "Next",
        "later" => "Later",
        "set_aside" => "Set aside",
        _ => "Triage",
    }
}

/// A hill's stage, as people say it.
fn hill_label(name: &str) -> &'static str {
    match name {
        "decided" => "Decided",
        "building" => "Building",
        "landing" => "Landing",
        _ => "Figuring it out",
    }
}

/// An appetite as given: `S`, `small` and so on, or `none` to clear it.
pub fn appetite_field(text: &str) -> Result<Value> {
    match text.trim().to_ascii_lowercase().as_str() {
        "s" | "small" => Ok(json!("small")),
        "m" | "medium" => Ok(json!("medium")),
        "l" | "large" => Ok(json!("large")),
        "none" | "" => Ok(Value::Null),
        _ => Err(Error::usage("--appetite is S (one session), M (about a week), L (a phase), or none.")),
    }
}

/// A budget as given: dollars (`25`, `$25.50`), or `none` to clear it.
pub fn budget_field(text: &str) -> Result<Value> {
    let text = text.trim().trim_start_matches('$');
    if text.eq_ignore_ascii_case("none") {
        return Ok(Value::Null);
    }
    match text.parse::<f64>() {
        Ok(dollars) if dollars.is_finite() && dollars > 0.0 => Ok(json!(dollars)),
        _ => Err(Error::usage("--budget is a number of dollars above 0, or none.")),
    }
}

/// The work item `next_work_item` answered, if any (the API may wrap it).
fn next_item(found: &Value) -> &Value {
    match found.get("item") {
        Some(item) => item,
        None => found,
    }
}

/// A work item as a row of the plan: number, title, appetite, urgent.
fn plan_row(out: &Output, rank: usize, item: &Value) -> Vec<Cell> {
    let number = format!("#{}", item["number"]);
    let appetite = match s(item, "appetite") {
        "small" => "S",
        "medium" => "M",
        "large" => "L",
        _ => "",
    };
    let flags = if item["urgent"].as_bool() == Some(true) { "urgent" } else { "" };
    let waits: Vec<String> = item["blocked_by"].as_array().into_iter().flatten().filter_map(Value::as_u64).map(|n| format!("#{n}")).collect();
    let waits = if waits.is_empty() { String::new() } else { format!("waits on {}", waits.join(", ")) };
    vec![
        Cell::styled(rank.to_string(), out.dim(&rank.to_string())),
        Cell::styled(number.clone(), out.green(&number)),
        Cell::new(s(item, "title")),
        Cell::styled(appetite.to_owned(), out.dim(appetite)),
        Cell::styled(flags.to_owned(), out.red(flags)),
        Cell::styled(waits.clone(), out.dim(&waits)),
    ]
}

fn plan(ctx: &Ctx, workspace: Option<&str>, args: WorkPlanArgs) -> Result<()> {
    let place = coordination_place(ctx, workspace, super::QUICK)?;
    let Some(number) = args.number else {
        let found = place
            .op("get_plan")
            .query_opt("repo", place.repo.as_ref().filter(|_| repo_named(ctx)).map(Repo::to_string))
            .query_opt("all", args.all.then_some(true))
            .send()?;
        if ctx.out.structured() {
            return ctx.out.emit(&found);
        }
        return print_plan(&ctx.out, &place.workspace, &found);
    };
    let horizon = [
        (args.now, "now"),
        (args.next, "next"),
        (args.later, "later"),
        (args.set_aside, "set_aside"),
        (args.triage, "triage"),
    ]
    .into_iter()
    .find_map(|(chosen, name)| chosen.then_some(name));
    let urgent = if args.urgent {
        Some(true)
    } else if args.not_urgent {
        Some(false)
    } else {
        None
    };
    let mut call = place
        .op("plan_work_item")
        .arg("number", number)
        .field_opt("horizon", horizon)
        .field_opt("before", args.before)
        .field_opt("after", args.after)
        .field_opt("urgent", urgent);
    if args.top {
        call = call.field("top", true);
    }
    if let Some(appetite) = &args.appetite {
        call = call.field("appetite", appetite_field(appetite)?);
    }
    if let Some(budget) = &args.budget {
        call = call.field("budget_usd", budget_field(budget)?);
    }
    let changes = horizon.is_some() || args.before.is_some() || args.after.is_some() || args.top || urgent.is_some();
    if !changes && args.appetite.is_none() && args.budget.is_none() {
        return Err(Error::usage("Say where to move it (--now, --next, --later, --set-aside, --triage, --before, --after, --top), or what to set (--appetite, --budget, --urgent)."));
    }
    let updated = super::unwrap_key(call.send()?, "item");
    if ctx.out.structured() {
        return ctx.out.emit(&updated);
    }
    eprintln!("#{number} is in {}.", horizon_label(s(&updated, "horizon")));
    Ok(())
}

fn print_plan(out: &Output, workspace: &str, plan: &Value) -> Result<()> {
    let count = |key: &str| plan[key].as_u64().unwrap_or_default();
    let now = list_of(plan, "now");
    let next = list_of(plan, "next");
    let cap = count("now_cap");
    let over = if now.len() as u64 > cap { out.red(" over its cap") } else { String::new() };
    println!("{}", out.bold(&format!("Now · {} of {cap}{over}", now.len())));
    if now.is_empty() {
        println!("{}", out.dim("  Nothing in Now. Move what you're taking on: g1t work plan <number> --now"));
    } else {
        let progress = list_of(plan, "progress");
        let of = |item: &Value| progress.iter().find(|p| p["number"] == item["number"]);
        let rows: Vec<Vec<Cell>> = now
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let mut row = plan_row(out, i + 1, item);
                let stage = of(item).map(|p| hill_label(s(p, "hill"))).unwrap_or_default();
                let quiet = if of(item).and_then(|p| p["quiet"].as_bool()) == Some(true) { " · quiet" } else { "" };
                let stage = format!("{stage}{quiet}");
                row.insert(3, Cell::styled(stage.clone(), out.dim(&stage)));
                row
            })
            .collect();
        out.table(&["", "number", "title", "hill", "appetite", "", "waits"], &rows)?;
        // Where each stands, as g1t drafted it from its record.
        for item in now {
            if let Some(standing) = of(item).and_then(|p| p["standing"].as_str()) {
                println!("{}", out.dim(&format!("  #{}: {standing}", item["number"])));
            }
        }
    }
    let landed = list_of(plan, "landed");
    if !landed.is_empty() {
        let list: Vec<String> = landed.iter().map(|item| format!("#{}", item["number"])).collect();
        println!("{}", out.dim(&format!("  Landed from Now this week: {}", list.join(", "))));
    }
    println!();
    println!("{}", out.bold(&format!("Next · {}", count("next_total"))));
    if next.is_empty() {
        println!("{}", out.dim("  Nothing in Next."));
    } else {
        let rows: Vec<Vec<Cell>> = next.iter().enumerate().map(|(i, item)| plan_row(out, now.len() + i + 1, item)).collect();
        out.table(&["", "number", "title", "appetite", "", "waits"], &rows)?;
        let more = count("next_total").saturating_sub(next.len() as u64);
        if more > 0 {
            println!("{}", out.dim(&format!("  {more} more: g1t work plan --all")));
        }
    }
    println!();
    println!(
        "{}",
        out.dim(&format!(
            "{} in Triage · {} in Later · {} set aside, in {workspace}. List one with g1t work list --horizon <name>.",
            count("triage_total"),
            count("later_total"),
            count("set_aside_total")
        ))
    );
    let waiting = count("triage_waiting");
    if waiting > 0 {
        println!("{}", out.dim(&format!("{waiting} waited in Triage over a week: g1t work list --horizon triage")));
    }
    Ok(())
}

fn next(ctx: &Ctx, workspace: Option<&str>, args: WorkNextArgs) -> Result<()> {
    let place = coordination_place(ctx, workspace, super::QUICK)?;
    let found = place.op("next_work_item").query_opt("repo", place.repo.as_ref().filter(|_| repo_named(ctx)).map(Repo::to_string)).send()?;
    let item = next_item(&found).clone();
    let Some(number) = item["number"].as_u64() else {
        if ctx.out.structured() {
            return ctx.out.emit(&Value::Null);
        }
        eprintln!("Nothing in {}'s plan is ready to take: everything in Now and Next is claimed, blocked or someone else's.", place.workspace);
        return Ok(());
    };
    if args.claim {
        let claimed = place.op("claim_work_item").arg("number", number).send()?;
        if ctx.out.structured() {
            return ctx.out.emit(&json!({ "item": item, "claim": claimed }));
        }
        println!("#{number} {}", s(&item, "title"));
        eprintln!("Claimed #{number}. {}", place.url(number));
        return Ok(());
    }
    if ctx.out.structured() {
        return ctx.out.emit(&item);
    }
    println!("#{number} {}", s(&item, "title"));
    eprintln!("{} in the plan. Claim it with g1t work claim {number}.", horizon_label(s(&item, "horizon")));
    Ok(())
}

fn release(ctx: &Ctx, workspace: Option<&str>, args: WorkReleaseArgs) -> Result<()> {
    let place = coordination_place(ctx, workspace, super::QUICK)?;
    let found = place
        .op("release_claim")
        .arg("number", args.number)
        .field_opt("reason", args.reason.clone())
        .field_opt("session_id", super::session::current())
        .send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    eprintln!("Released your claim on #{}.", args.number);
    Ok(())
}

fn handoff(ctx: &Ctx, workspace: Option<&str>, args: WorkHandoffArgs) -> Result<()> {
    if args.note.trim().is_empty() {
        return Err(Error::usage("Say where it stands with --note."));
    }
    let place = coordination_place(ctx, workspace, super::QUICK)?;
    let to = match &args.to {
        Some(login) => Some(super::who(ctx, &place.client, login)?),
        None => None,
    };
    let found = place
        .op("hand_off_work_item")
        .arg("number", args.number)
        .field_opt("to", to.clone())
        .field("note", args.note.trim())
        .field_opt("session_id", super::session::current())
        .send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    match to {
        Some(login) => eprintln!("Handed #{} to {login}.", args.number),
        None => eprintln!("Handed #{} to whoever takes it next.", args.number),
    }
    Ok(())
}

/// The active claims made from a repository's checkouts, or on work items
/// linked to it.
pub fn active_claims(client: &Client, repo: &Repo) -> Result<Vec<Value>> {
    let found = client
        .op("list_claims")
        .arg("workspace", workspace_of(repo))
        .query("repo", repo)
        .query("state", "active")
        .send()?;
    Ok(super::items(found, "claims"))
}

fn status(ctx: &Ctx) -> Result<()> {
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let (claims, sessions) = std::thread::scope(|scope| {
        let claims = scope.spawn(|| active_claims(&client, &repo));
        let sessions = scope.spawn(|| -> Result<Vec<Value>> {
            let found = client.op("list_sessions").repo(&repo).query("state", "active").send()?;
            Ok(super::items(found, "sessions"))
        });
        (claims.join(), sessions.join())
    });
    let failed = || Error::failed("A lookup failed.");
    let claims = claims.map_err(|_| failed())??;
    let sessions = sessions.map_err(|_| failed())??;
    if ctx.out.structured() {
        return ctx.out.emit(&json!({ "claims": claims, "sessions": sessions }));
    }
    let out = &ctx.out;
    println!("{}", out.bold(&format!("Claims in {repo}")));
    if claims.is_empty() {
        println!("  {}", out.dim("None."));
    }
    for claim in &claims {
        println!("  {}", claim_line(out, claim));
    }
    println!();
    println!("{}", out.bold(&format!("Active sessions in {repo}")));
    if sessions.is_empty() {
        println!("  {}", out.dim("None."));
        return Ok(());
    }
    super::session::print_list(out, &sessions, super::session::current().as_deref())
}

/// The work items `number` waits on once `by` is added to `current`
/// (`add`) or taken from it.
pub fn blocked_set(number: u64, current: &[u64], by: &[u64], add: bool) -> Result<Vec<u64>> {
    if add && by.contains(&number) {
        return Err(Error::usage(format!("#{number} cannot wait on itself.")));
    }
    let mut set: BTreeSet<u64> = current.iter().copied().collect();
    for n in by {
        if add {
            set.insert(*n);
        } else {
            set.remove(n);
        }
    }
    Ok(set.into_iter().collect())
}

fn block(ctx: &Ctx, workspace: Option<&str>, args: WorkBlockArgs, add: bool) -> Result<()> {
    let place = coordination_place(ctx, workspace, super::QUICK)?;
    let found = place.op("get_work_item").arg("number", args.number).send()?;
    let item = super::unwrap_key(found, "item");
    let current: Vec<u64> = item["blocked_by"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|n| n.as_u64().or_else(|| n["number"].as_u64()))
        .collect();
    let wanted = blocked_set(args.number, &current, &args.by, add)?;
    let updated = place.op("update_work_item").arg("number", args.number).field("blocked_by", json!(wanted)).send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&super::unwrap_key(updated, "item"));
    }
    let list: Vec<String> = wanted.iter().map(|n| format!("#{n}")).collect();
    if list.is_empty() {
        eprintln!("#{} waits on nothing.", args.number);
    } else {
        eprintln!("#{} waits on {}.", args.number, list.join(", "));
    }
    Ok(())
}

// --- events -------------------------------------------------------------

/// `15m`, `2h`, `1d`, `1w` ago as an RFC 3339 time; anything else as given.
pub fn since_time(text: &str, now_secs: i64) -> String {
    let ms = super::logs::since(text, now_secs * 1000);
    if ms == text.trim() {
        return ms;
    }
    match ms.parse::<i64>() {
        Ok(ms) => format!("{}Z", super::logs::clock(ms * 1000).replacen(' ', "T", 1)),
        Err(_) => ms,
    }
}

/// The work item or pull request an event is about.
fn event_number(data: &Value) -> Option<u64> {
    data["number"]
        .as_u64()
        .or_else(|| data["item"].as_u64())
        .or_else(|| data["pull"].as_u64())
        .or_else(|| data["item"]["number"].as_u64())
        .or_else(|| data["pull"]["number"].as_u64())
        .or_else(|| data["claim"]["item"].as_u64())
}

/// What an event says, in a few words.
pub fn event_summary(data: &Value) -> String {
    let nums = |key: &str| -> String {
        data[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|n| n.as_u64().or_else(|| n["number"].as_u64()))
            .map(|n| format!("#{n}"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    if let Some(check) = data["check"].as_object() {
        let mut line = format!(
            "{} {}",
            check.get("name").and_then(Value::as_str).unwrap_or("check"),
            check.get("conclusion").and_then(Value::as_str).unwrap_or("")
        );
        let combination = nums("combination");
        if !combination.is_empty() {
            line.push_str(&format!(" with {combination}"));
        }
        let landed = nums("landed");
        if !landed.is_empty() {
            line.push_str(&format!(" (since it branched: {landed} landed)"));
        }
        return line.trim().to_owned();
    }
    if let Some(other) = data["other_pull"].as_u64() {
        let files: Vec<&str> = data["files"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        return format!("overlaps #{other}: {}", files.join(", "));
    }
    if !data["blocked_by"].is_null() && data["blocked_by"].is_array() {
        let list = nums("blocked_by");
        return if list.is_empty() { "waits on nothing".to_owned() } else { format!("waits on {list}") };
    }
    for path in [
        &data["title"],
        &data["summary"],
        &data["decision"]["summary"],
        &data["note"],
        &data["claim"]["note"],
        &data["session"]["title"],
        &data["reason"],
    ] {
        if let Some(text) = path.as_str().filter(|t| !t.trim().is_empty()) {
            return text.trim().lines().next().unwrap_or("").to_owned();
        }
    }
    String::new()
}

/// One event as the cells of its line: time, type, number, summary, id.
pub fn event_cells(event: &Value) -> [String; 5] {
    let time = s(event, "time");
    let time = time.get(..19).unwrap_or(time).replacen('T', " ", 1);
    let data = &event["data"];
    let number = event_number(data).map(|n| format!("#{n}")).unwrap_or_default();
    [time, s(event, "type").to_owned(), number, event_summary(data), s(event, "id").to_owned()]
}

/// One event as a line: on a terminal spaced and colored, piped
/// tab-separated.
pub fn event_line(out: &Output, event: &Value) -> String {
    let [time, kind, number, summary, id] = event_cells(event);
    if !out.tty {
        return [time, kind, number, summary, id].join("\t");
    }
    let painted = if kind.contains("failed") || kind.ends_with("expired") {
        out.red(&kind)
    } else if kind.starts_with("overlap") || kind.starts_with("dependency") || kind.contains("handoff") {
        out.yellow(&kind)
    } else if kind.ends_with("passed") || kind.ends_with("merged") {
        out.green(&kind)
    } else {
        out.cyan(&kind)
    };
    let mut line = format!("{} {painted}", out.dim(&time));
    if !number.is_empty() {
        line.push_str(&format!(" {number}"));
    }
    if !summary.is_empty() {
        line.push_str(&format!(" {summary}"));
    }
    line.push_str(&format!(" {}", out.dim(&id)));
    line
}

/// The ids a follow has printed, the oldest forgotten first.
#[derive(Default)]
pub struct Seen {
    ids: HashSet<String>,
    order: VecDeque<String>,
}

impl Seen {
    /// Whether `id` is new, remembering it.
    pub fn insert(&mut self, id: &str) -> bool {
        if !self.ids.insert(id.to_owned()) {
            return false;
        }
        self.order.push_back(id.to_owned());
        if self.order.len() > REMEMBERED
            && let Some(old) = self.order.pop_front()
        {
            self.ids.remove(&old);
        }
        true
    }

    pub fn contains(&self, id: &str) -> bool {
        self.ids.contains(id)
    }
}

/// How long to wait after `failures` failures in a row: 1, 2, 4... 30 s.
pub fn backoff(failures: u32) -> Duration {
    let secs = 1u64 << failures.saturating_sub(1).min(5);
    Duration::from_secs(secs.min(MAX_BACKOFF_SECONDS))
}

struct Query<'a> {
    client: &'a Client,
    repo: &'a Repo,
    types: String,
    numbers: String,
    since: Option<String>,
}

impl Query<'_> {
    fn fetch(&self, after: Option<&str>, wait: Option<u64>, limit: usize, filtered: bool) -> Result<Vec<Value>> {
        let mut call = self
            .client
            .op("list_events")
            .repo(self.repo)
            .query_opt("after", after)
            .query_opt("wait", wait)
            .query("limit", limit.clamp(1, 200));
        if filtered {
            if !self.types.is_empty() {
                call = call.query("types", &self.types);
            }
            if !self.numbers.is_empty() {
                call = call.query("numbers", &self.numbers);
            }
            call = call.query_opt("since", self.since.clone());
        }
        Ok(super::items(call.send()?, "events"))
    }
}

fn events(ctx: &Ctx, args: WorkEventsArgs) -> Result<()> {
    let (repo, client) = super::coordination_client(ctx, std::time::Duration::from_secs(WAIT_SECONDS + 35))?;
    let query = Query {
        client: &client,
        repo: &repo,
        types: args.types.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(","),
        numbers: args.items.iter().map(u64::to_string).collect::<Vec<_>>().join(","),
        since: args.since.as_deref().map(|t| since_time(t, now())),
    };
    let out = &ctx.out;
    let print = |event: &Value| -> Result<()> {
        if out.structured() {
            out.emit_line(event)
        } else {
            println!("{}", event_line(out, event));
            Ok(())
        }
    };
    let mut seen = Seen::default();
    // Where following starts, read before the past events so that nothing
    // written between the two is missed: the newest event now, or for a
    // repository with none yet, the start of the log.
    let mut cursor = match &args.after {
        Some(after) => Some(after.clone()),
        None if args.follow => Some(
            query
                .fetch(None, None, 1, false)?
                .first()
                .map(|event| s(event, "id").to_owned())
                .unwrap_or_else(|| "evt_0".to_owned()),
        ),
        None => None,
    };
    let past = match &args.after {
        // Resuming: what came after it, oldest first.
        Some(after) => query.fetch(Some(after), None, args.limit, true)?,
        None => {
            let mut past = query.fetch(None, None, args.limit, true)?;
            past.truncate(args.limit);
            past.reverse();
            past
        }
    };
    for event in &past {
        seen.insert(s(event, "id"));
        print(event)?;
    }
    if !args.follow {
        if past.is_empty() && !out.structured() {
            eprintln!("No events in {repo} that match.");
        }
        return Ok(());
    }
    if args.after.is_some()
        && let Some(last) = past.last()
    {
        cursor = Some(s(last, "id").to_owned());
    }
    let mut failures = 0u32;
    loop {
        let asked = Instant::now();
        match query.fetch(cursor.as_deref(), Some(WAIT_SECONDS), 200, true) {
            Ok(batch) => {
                if failures > 0 && !out.structured() {
                    eprintln!("g1t: following {repo} again.");
                }
                failures = 0;
                // A server that ignores `after` answers with what it has
                // already sent, over and over.
                if !batch.is_empty() && batch.iter().all(|event| seen.contains(s(event, "id"))) {
                    return Err(Error::failed(format!(
                        "{} cannot follow events: the g1t server is older than this CLI.",
                        client.host.api
                    )));
                }
                for event in &batch {
                    if seen.insert(s(event, "id")) {
                        print(event)?;
                    }
                }
                if let Some(last) = batch.last() {
                    cursor = Some(s(last, "id").to_owned());
                } else if asked.elapsed() < Duration::from_secs(1) {
                    // Answered at once with nothing: not held, so not
                    // asked again at once.
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
            Err(error) if matches!(error.kind, Kind::Auth | Kind::Usage) => return Err(error),
            Err(error) => {
                failures += 1;
                let wait = backoff(failures);
                eprintln!("g1t: {} Trying again in {}s.", error.message.trim_end(), wait.as_secs());
                std::thread::sleep(wait);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_claim_says_which_work_item_it_is_on() {
        assert_eq!(claimed_number(Some(12), &json!({ "claim": { "item": 12 } })), 12);
        // Opened for it: the claim names it, and so does the work item opened.
        assert_eq!(claimed_number(None, &json!({ "claim": { "item": 31 }, "item": { "number": 31 } })), 31);
        assert_eq!(claimed_number(None, &json!({ "item": { "number": 31 } })), 31);
    }

    #[test]
    fn a_work_item_has_its_page_in_its_workspace() {
        assert_eq!(item_url("https://g1t.sh", "acme", 12), "https://g1t.sh/acme/-/work/12");
        let repo = Repo { host: "g1t.sh".into(), owner: "Acme".into(), name: "web".into() };
        assert_eq!(workspace_of(&repo), "acme");
        let item = json!({ "repos": [{ "path": "acme/web", "role": "origin" }, { "path": "acme/api", "role": "target", "landed": true }, { "path": "acme/docs", "role": "target" }] });
        assert_eq!(repos_cell(&item), "acme/web +2");
        assert_eq!(missing(&item), vec!["acme/docs".to_owned()]);
    }

    #[test]
    fn a_repository_deleted_before_work_items_is_named_so() {
        // Its link kept no path: the column says what it was, not nothing.
        let item = json!({ "repos": [{ "path": "", "role": "origin" }] });
        assert_eq!(repos_cell(&item), "deleted repository");
        let item = json!({ "repos": [{ "path": null, "role": "origin" }, { "path": "acme/api", "role": "target" }] });
        assert_eq!(repos_cell(&item), "deleted repository +1");
        assert_eq!(repo_path(&json!({ "path": "acme/web" })), "acme/web");
    }

    #[test]
    fn blocking_adds_and_unblocking_removes() {
        assert_eq!(blocked_set(12, &[9], &[10, 9], true).unwrap(), vec![9, 10]);
        assert_eq!(blocked_set(12, &[9, 10], &[9], false).unwrap(), vec![10]);
        assert_eq!(blocked_set(12, &[], &[3], false).unwrap(), Vec::<u64>::new());
        assert!(blocked_set(12, &[], &[12], true).is_err());
    }

    #[test]
    fn events_read_as_one_line_each() {
        let out = Output::default();
        let failed = json!({
            "id": "evt_2", "type": "integration.failed", "time": "2026-10-12T09:01:02.345Z",
            "data": { "number": 14, "item": 12, "check": { "name": "test", "conclusion": "failure" }, "combination": [14, 15] },
        });
        assert_eq!(
            event_line(&out, &failed),
            "2026-10-12 09:01:02\tintegration.failed\t#14\ttest failure with #14, #15\tevt_2"
        );
        let claimed = json!({
            "id": "evt_3", "type": "work.claimed", "time": "2026-10-12T09:02:00Z",
            "data": { "number": 12, "claim": { "item": 12, "note": "taking the parser" } },
        });
        assert_eq!(event_cells(&claimed)[3], "taking the parser");
        let overlap = json!({ "type": "overlap.detected", "data": { "pull": 14, "other_pull": 15, "files": ["src/a.rs"] } });
        assert_eq!(event_cells(&overlap)[2], "#14");
        assert_eq!(event_cells(&overlap)[3], "overlaps #15: src/a.rs");
        let dependency = json!({ "type": "dependency.changed", "data": { "number": 12, "blocked_by": [9, 10] } });
        assert_eq!(event_cells(&dependency)[3], "waits on #9, #10");
    }

    #[test]
    fn json_events_are_one_object_a_line() {
        let out = Output { json: Some(vec!["id".into(), "type".into()]), ..Output::default() };
        let line = crate::output::json_line(&out, &json!({ "type": "push", "id": "evt_1", "data": {} })).unwrap();
        assert_eq!(line, r#"{"id":"evt_1","type":"push"}"#);
        let all = Output { json: Some(vec![]), tty: true, ..Output::default() };
        let line = crate::output::json_line(&all, &json!({ "b": { "c": 1 }, "a": 2 })).unwrap();
        assert_eq!(line, r#"{"a":2,"b":{"c":1}}"#, "compact on a terminal too");
    }

    #[test]
    fn a_follow_backs_off_to_thirty_seconds() {
        let waits: Vec<u64> = (1..=8).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(waits, vec![1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn a_follow_remembers_what_it_printed_but_not_forever() {
        let mut seen = Seen::default();
        assert!(seen.insert("evt_1"));
        assert!(!seen.insert("evt_1"));
        for n in 0..REMEMBERED {
            seen.insert(&format!("evt_x{n}"));
        }
        assert!(!seen.contains("evt_1"), "the oldest is forgotten");
        assert_eq!(seen.ids.len(), REMEMBERED);
    }

    #[test]
    fn since_takes_spans_and_times() {
        // 2026-10-12T10:00:00Z
        let now = 1_791_799_200;
        assert_eq!(since_time("2h", now), "2026-10-12T08:00:00Z");
        assert_eq!(since_time("15m", now), "2026-10-12T09:45:00Z");
        assert_eq!(since_time("2026-10-01T00:00:00Z", now), "2026-10-01T00:00:00Z");
    }

    #[test]
    fn claims_say_who_until_when_and_why() {
        let out = Output::default();
        let line = claim_line(&out, &json!({ "actor": "ana", "harness": "claude_code", "item": 12, "state": "active", "note": "parser" }));
        assert_eq!(line, "ana (claude_code) on #12: parser");
        assert_eq!(until("2000-01-01T00:00:00Z"), "expired");
    }
}
