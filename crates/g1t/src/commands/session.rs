//! `g1t session`: one run of an agent's harness, recorded as it works.
//!
//! The session a working copy is in is kept in `<git dir>/g1t/session`,
//! where `<git dir>` is the worktree's own (`git rev-parse
//! --absolute-git-dir`), so each worktree has its own; `G1T_SESSION`
//! overrides it. `g1t work claim` attaches its claim to it.

use serde_json::{Value, json};
use std::io::Read;
use std::path::PathBuf;

use crate::cli::{
    SessionAcknowledgeArgs, SessionAttachArgs, SessionCommand, SessionEndArgs, SessionHeartbeatArgs, SessionListArgs, SessionLogArgs,
    SessionStartArgs, SessionState, SessionTouchArgs, SessionViewArgs,
};
use crate::client::Client;
use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::output::{Cell, Output, ago, s};
use crate::repo::Repo;

pub fn run(ctx: &Ctx, command: SessionCommand) -> Result<()> {
    match command {
        SessionCommand::Start(args) => start(ctx, args),
        SessionCommand::Heartbeat(args) => heartbeat(ctx, args),
        SessionCommand::Log(args) => log(ctx, args),
        SessionCommand::Attach(args) => attach(ctx, args),
        SessionCommand::End(args) => end(ctx, args),
        SessionCommand::List(args) => list(ctx, args),
        SessionCommand::View(args) => view(ctx, args),
        SessionCommand::Updates(args) => updates(ctx, args),
        SessionCommand::Acknowledge(args) => acknowledge(ctx, args),
        SessionCommand::Touch(args) => touch(ctx, args),
    }
}

/// Where this working copy's session is kept: `<git dir>/g1t/session`.
fn file() -> Option<PathBuf> {
    crate::git::run(&["rev-parse", "--absolute-git-dir"])
        .ok()
        .filter(|dir| !dir.is_empty())
        .map(|dir| PathBuf::from(dir).join("g1t").join("session"))
}

/// The session id in `G1T_SESSION`, else the one kept in `file`.
fn chosen(env: Option<String>, file: Option<PathBuf>) -> Option<String> {
    env.map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .or_else(|| {
            let text = std::fs::read_to_string(file?).ok()?;
            let id = text.lines().next()?.trim().to_owned();
            (!id.is_empty()).then_some(id)
        })
}

/// The current session's id, if there is one.
pub fn current() -> Option<String> {
    chosen(std::env::var("G1T_SESSION").ok(), file())
}

fn required() -> Result<String> {
    current().ok_or_else(|| {
        Error::usage("No session here: start one with `g1t session start`, or set G1T_SESSION.")
    })
}

fn remember(id: &str) -> Result<()> {
    let Some(path) = file() else {
        // Outside a working copy there is nowhere to keep it; G1T_SESSION does.
        return Ok(());
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, format!("{id}\n"))?;
    Ok(())
}

/// Forgets the kept session, when it is `id`.
fn forget(id: &str) {
    if let Some(path) = file()
        && chosen(None, Some(path.clone())).as_deref() == Some(id)
    {
        let _ = std::fs::remove_file(path);
    }
}

/// The session in an answer that may wrap it (`{session, entries}`).
fn session_of(found: Value) -> Value {
    super::unwrap_key(found, "session")
}

fn start(ctx: &Ctx, args: SessionStartArgs) -> Result<()> {
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let branch = args.branch.clone().or_else(crate::git::current_branch);
    let head = crate::git::run(&["rev-parse", "HEAD"]).ok().filter(|h| !h.is_empty());
    let found = client
        .op("start_session")
        .repo(&repo)
        .field("harness", args.harness.name())
        .field_opt("harness_session_id", args.harness_session_id.clone())
        .field_opt("item", args.item)
        .field_opt("pull", args.pull)
        .field_opt("branch", branch)
        .field_opt("title", args.title.clone())
        .field_opt("head_commit", head)
        .field_opt("parent_id", args.parent.clone())
        .field_opt("agent_type", args.agent_type.clone())
        .field_opt("task", args.task.clone())
        .field_opt("prompt", args.prompt.clone())
        .field_opt("model", args.model.clone())
        .send()?;
    let session = session_of(found);
    let id = s(&session, "id").to_owned();
    if id.is_empty() {
        return Err(Error::failed("The API did not say which session it started."));
    }
    // A subagent's session is its harness's to keep: the working copy's stays its parent's.
    if !args.no_remember && args.parent.is_none() {
        remember(&id)?;
    }
    if ctx.out.structured() {
        return ctx.out.emit(&session);
    }
    println!("{id}");
    Ok(())
}

/// The most files said at once, as the server takes them.
const MAX_CHANGED: usize = 200;

/// The files changed in this working copy, from its root: modified, added,
/// deleted, renamed (by the new name) and untracked, never ignored. Empty
/// outside a working copy, or with `G1T_TOUCH=0`.
fn working_changes() -> Vec<String> {
    if std::env::var("G1T_TOUCH").is_ok_and(|value| value.trim() == "0") {
        return Vec::new();
    }
    crate::git::run(&["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .map(|out| changed_paths(&out))
        .unwrap_or_default()
}

/// The paths in `git status --porcelain=v1 -z` output, at most
/// [`MAX_CHANGED`]. A rename or copy names its new path, then its old one.
fn changed_paths(status: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut records = status.split('\0').filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        let Some((code, path)) = record.split_at_checked(3) else {
            continue;
        };
        if code.starts_with('R') || code.starts_with('C') {
            records.next();
        }
        if !path.is_empty() && !paths.iter().any(|known: &String| known == path) {
            paths.push(path.to_owned());
        }
        if paths.len() == MAX_CHANGED {
            break;
        }
    }
    paths
}

/// Says what this working copy changed as touched by session `id`, so that
/// another session changing the same files is an `overlap.detected` for
/// both whichever harness either runs in. A file is kept once, so saying it
/// again does nothing. Never fails the command it is part of.
fn say_changes(client: &crate::client::Client, repo: &crate::repo::Repo, id: &str) {
    let files: Vec<Value> = working_changes().into_iter().map(|file| json!({ "kind": "file", "value": file })).collect();
    if files.is_empty() {
        return;
    }
    let _ = client
        .op("record_session_entries")
        .repo(repo)
        .arg("id", id)
        .field("entries", json!([]))
        .field("touched", Value::Array(files))
        .send();
}

/// Usage as `--usage-json` gives it: a JSON list of objects, each naming
/// its model. The server checks the counts.
fn usage_of(text: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(text.trim())
        .map_err(|error| Error::usage(format!("--usage-json is not JSON: {error}.")))?;
    let named = |row: &Value| row["model"].as_str().is_some_and(|model| !model.trim().is_empty());
    match &value {
        Value::Array(rows) if rows.iter().all(named) => Ok(value),
        _ => Err(Error::usage(
            "--usage-json is a list of {model, tier, input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens}.",
        )),
    }
}

fn heartbeat(ctx: &Ctx, args: SessionHeartbeatArgs) -> Result<()> {
    let id = required()?;
    let usage = match args.usage_json.as_deref() {
        Some("-") => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text)?;
            Some(usage_of(&text)?)
        }
        Some(text) => Some(usage_of(text)?),
        None => None,
    };
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let mut request = client.op("update_session").repo(&repo).arg("id", &id);
    if let Some(usage) = usage {
        request = request.field("usage", usage);
    }
    let found = request.send()?;
    say_changes(&client, &repo, &id);
    if ctx.out.structured() {
        return ctx.out.emit(&session_of(found));
    }
    Ok(())
}

fn log(ctx: &Ctx, args: SessionLogArgs) -> Result<()> {
    let id = required()?;
    let text = if args.text == "-" {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        text
    } else {
        args.text.clone()
    };
    if text.trim().is_empty() {
        return Err(Error::usage("Nothing to record: give the text."));
    }
    let mut entry = json!({ "kind": args.kind.name(), "text": text.trim_end() });
    if let Some(tool) = &args.tool {
        entry["tool"] = json!(tool);
    }
    if let Some(key) = &args.key {
        entry["key"] = json!(key);
    }
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let found = client
        .op("record_session_entries")
        .repo(&repo)
        .arg("id", &id)
        .field("entries", json!([entry]))
        .send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    Ok(())
}

/// Where a session is: `#12`, `pull #14`, its branch.
fn place(session: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(item) = session["item"].as_u64() {
        parts.push(format!("#{item}"));
    }
    if let Some(pull) = session["pull"].as_u64() {
        parts.push(format!("pull #{pull}"));
    }
    if let Some(branch) = session["branch"].as_str().filter(|b| !b.is_empty()) {
        parts.push(branch.to_owned());
    }
    parts.join(", ")
}

fn attach(ctx: &Ctx, args: SessionAttachArgs) -> Result<()> {
    let id = required()?;
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let found = client
        .op("update_session")
        .repo(&repo)
        .arg("id", &id)
        .field_opt("item", args.item)
        .field_opt("pull", args.pull)
        .field_opt("branch", args.branch.clone())
        .field_opt("head_commit", args.head_commit.clone())
        .field_opt("title", args.title.clone())
        .send()?;
    let session = session_of(found);
    if ctx.out.structured() {
        return ctx.out.emit(&session);
    }
    if args.item.is_some() || args.pull.is_some() || args.branch.is_some() || args.head_commit.is_some() {
        eprintln!("Session {id} is on {}.", place(&session));
    }
    if args.title.is_some() {
        eprintln!("Session {id} is titled {}.", s(&session, "title"));
    }
    Ok(())
}

fn end(ctx: &Ctx, args: SessionEndArgs) -> Result<()> {
    let id = required()?;
    let result = match args.result.as_deref() {
        Some("-") => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text)?;
            Some(text)
        }
        other => other.map(str::to_owned),
    };
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let found = client
        .op("end_session")
        .repo(&repo)
        .arg("id", &id)
        .field_opt("reason", args.reason.clone())
        .field_opt("result", result.filter(|text| !text.trim().is_empty()))
        .send()?;
    forget(&id);
    if ctx.out.structured() {
        return ctx.out.emit(&session_of(found));
    }
    eprintln!("Ended session {id}.");
    Ok(())
}

pub fn fetch_filtered(
    client: &Client,
    repo: &Repo,
    state: Option<&str>,
    item: Option<u64>,
    pull: Option<u64>,
    path: Option<&str>,
    subagents: bool,
) -> Result<Vec<Value>> {
    let found = client
        .op("list_sessions")
        .repo(repo)
        .query_opt("state", state)
        .query_opt("item", item)
        .query_opt("pull", pull)
        .query_opt("path", path)
        .query_opt("subagents", subagents.then_some("true"))
        .send()?;
    Ok(super::items(found, "sessions"))
}

fn list(ctx: &Ctx, args: SessionListArgs) -> Result<()> {
    if args.workspace.is_some() {
        return list_workspace(ctx, args);
    }
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let state = args.state.map(|state| match state {
        SessionState::Active => "active",
        SessionState::Idle => "idle",
        SessionState::Ended => "ended",
    });
    let mut sessions = fetch_filtered(&client, &repo, state, args.item, args.pull, args.path.as_deref(), args.subagents)?;
    sessions.truncate(args.limit);
    if ctx.out.structured() {
        return ctx.out.emit(&Value::Array(sessions));
    }
    if sessions.is_empty() {
        eprintln!("No {} sessions in {repo}.", state.unwrap_or("matching"));
        return Ok(());
    }
    print_list(&ctx.out, &sessions, current().as_deref())
}

/// `g1t session list --workspace`: what is cooking across a workspace.
fn list_workspace(ctx: &Ctx, args: SessionListArgs) -> Result<()> {
    let place = super::work::place(ctx, args.workspace.as_deref())?;
    let state = match args.state {
        None => "recent",
        Some(SessionState::Active | SessionState::Idle) => "live",
        Some(SessionState::Ended) => "ended",
    };
    let mut call = place.client.op("list_workspace_sessions").arg("workspace", &place.workspace).query("state", state).query("limit", args.limit.clamp(1, 200));
    if let Some(item) = args.item {
        call = call.query("item", item);
    }
    if let Some(harness) = &args.harness {
        call = call.query("harness", harness);
    }
    if let Some(person) = &args.person {
        call = call.query("person", person.trim_start_matches('@'));
    }
    if let Some(name) = &args.in_repo {
        call = call.query("repo", name);
    }
    if args.subagents {
        call = call.query("subagents", true);
    }
    let found = call.send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    let sessions = found["sessions"].as_array().cloned().unwrap_or_default();
    if sessions.is_empty() {
        eprintln!("No {} sessions in the {} workspace.", if state == "recent" { "matching" } else { state }, place.workspace);
        return Ok(());
    }
    let mine = current();
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    for session in &sessions {
        let id = s(session, "id");
        let marked = if Some(id) == mine.as_deref() { format!("{id} *") } else { id.to_owned() };
        let by = match session["harness"].as_str() {
            Some(harness) => harness.to_owned(),
            None => format!("{} {}", s(session, "kind"), s(session, "agent")).trim().to_owned(),
        };
        let mut on = s(session, "repo").to_owned();
        if let Some(item) = session["item"].as_u64() {
            on.push_str(&format!(" #{item}"));
        }
        if let Some(pull) = session["pull"].as_u64() {
            on.push_str(&format!(" PR #{pull}"));
        }
        rows.push(vec![
            Cell::new(marked),
            Cell::styled(s(session, "state"), ctx.out.state(s(session, "state"))),
            Cell::new(s(session, "actor")),
            Cell::new(by),
            Cell::new(on),
            Cell::styled(ago(s(session, "last_activity_at")), ctx.out.dim(&ago(s(session, "last_activity_at")))),
        ]);
        for child in session["children"].as_array().into_iter().flatten() {
            rows.push(vec![
                Cell::new(format!("↳ {} {}", s(child, "id"), s(child, "agent_type")).trim_end().to_owned()),
                Cell::styled(s(child, "state"), ctx.out.state(s(child, "state"))),
                Cell::new(super::login_of(child)),
                Cell::new(s(child, "harness")),
                Cell::new(String::new()),
                Cell::styled(ago(s(child, "last_seen_at")), ctx.out.dim(&ago(s(child, "last_seen_at")))),
            ]);
        }
    }
    ctx.out.table(&["session", "state", "who", "harness", "on", "last seen"], &rows)?;
    let waiting: u64 = found["queue"].as_array().into_iter().flatten().map(|queue| queue["active"].as_array().map_or(0, |active| active.len() as u64)).sum();
    if waiting > 0 {
        eprintln!("{waiting} waiting in merge queues.");
    }
    Ok(())
}

pub fn print_list(out: &Output, sessions: &[Value], mine: Option<&str>) -> Result<()> {
    let rows: Vec<Vec<Cell>> = sessions
        .iter()
        .map(|session| {
            let id = s(session, "id");
            let marked = if Some(id) == mine { format!("{id} *") } else { id.to_owned() };
            // A subagent is shown under what started it.
            let marked = match session["parent_id"].as_str() {
                Some(_) => format!("↳ {marked} {}", s(session, "agent_type")).trim_end().to_owned(),
                None => marked,
            };
            vec![
                Cell::new(marked),
                Cell::styled(s(session, "state"), out.state(s(session, "state"))),
                Cell::new(super::login_of(session)),
                Cell::new(s(session, "harness")),
                Cell::new(place(session)),
                Cell::styled(ago(s(session, "last_seen_at")), out.dim(&ago(s(session, "last_seen_at")))),
            ]
        })
        .collect();
    out.table(&["session", "state", "who", "harness", "on", "last seen"], &rows)
}

/// What `g1t session touch` says, as `touched` items.
fn touches(args: &SessionTouchArgs) -> Vec<Value> {
    let mut touched = Vec::new();
    let mut add = |kind: &str, value: String| touched.push(json!({ "kind": kind, "value": value }));
    args.file.iter().for_each(|file| add("file", file.clone()));
    args.commit.iter().for_each(|commit| add("commit", commit.clone()));
    args.branch.iter().for_each(|branch| add("branch", branch.clone()));
    args.pull.iter().for_each(|pull| add("pull", pull.to_string()));
    args.item.iter().for_each(|item| add("item", item.to_string()));
    touched
}

fn touch(ctx: &Ctx, args: SessionTouchArgs) -> Result<()> {
    let id = required()?;
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let found = client
        .op("record_session_entries")
        .repo(&repo)
        .arg("id", &id)
        .field("entries", json!([]))
        .field("touched", Value::Array(touches(&args)))
        .send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    Ok(())
}

fn updates(ctx: &Ctx, args: SessionViewArgs) -> Result<()> {
    let id = match args.id { Some(id) => id, None => required()? };
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    // First, so an overlap the changes make is among the updates read.
    say_changes(&client, &repo, &id);
    let found = client.op("get_session").repo(&repo).arg("id", &id).query("after", u32::MAX).send()?;
    // A server without inbox support must not masquerade as an empty inbox.
    let updates = found.get("updates").and_then(Value::as_array)
        .ok_or_else(|| Error::failed("This server does not expose session updates yet."))?;
    if ctx.out.structured() { return ctx.out.emit(&json!({ "session_id": id, "updates": updates })); }
    if updates.is_empty() { println!("No pending updates for {id}."); }
    for update in updates {
        println!("{} {} {}", s(update, "id"), s(update, "kind"), s(update, "at"));
        println!("{}", serde_json::to_string_pretty(&update["data"]).expect("JSON values serialize"));
    }
    Ok(())
}

fn acknowledgement_entries(ids: &[String], note: &str) -> Value {
    use sha2::{Digest, Sha256};
    // Sorting makes a retry with the same IDs in another order idempotent.
    let mut ids = ids.to_vec();
    ids.sort();
    ids.dedup();
    let key = hex::encode(Sha256::digest(serde_json::to_vec(&ids).expect("strings serialize")));
    json!([{ "kind": "note", "text": format!("Coordination updates {}: {}", ids.join(", "), note.trim()), "key": format!("ack:{key}") }])
}

fn acknowledge(ctx: &Ctx, args: SessionAcknowledgeArgs) -> Result<()> {
    if args.note.trim().is_empty() { return Err(Error::usage("Say what you decided in --note.")); }
    let id = match args.session { Some(id) => id, None => required()? };
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let touched: Vec<Value> = working_changes().into_iter().map(|file| json!({ "kind": "file", "value": file })).collect();
    let found = client.op("record_session_entries").repo(&repo).arg("id", &id)
        .field("entries", acknowledgement_entries(&args.updates, &args.note))
        .field("touched", Value::Array(touched))
        .field("acknowledge", json!(args.updates)).send()?;
    let mut given = args.updates.clone();
    given.sort();
    given.dedup();
    // An older server does not count; only a count that falls short is news.
    let missed = found.get("acknowledged").and_then(Value::as_u64).map(|n| given.len() as u64 - n.min(given.len() as u64)).unwrap_or(0);
    if ctx.out.structured() { return ctx.out.emit(&found); }
    println!("Recorded your decision and acknowledged the named updates for {id}.");
    if missed > 0 {
        eprintln!("{missed} of those IDs are not updates of {id}: check them with `g1t session updates {id}`.");
    }
    Ok(())
}

fn view(ctx: &Ctx, args: SessionViewArgs) -> Result<()> {
    let id = match args.id {
        Some(id) => id,
        None => required()?,
    };
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let found = client.op("get_session").repo(&repo).arg("id", &id).send()?;
    let mut session = session_of(found.clone());
    if let Some(map) = session.as_object_mut() {
        map.insert("entries".into(), found.get("entries").cloned().unwrap_or_else(|| json!([])));
        for key in ["children", "touched", "links", "skills", "root", "updates"] {
            if let Some(value) = found.get(key) {
                map.insert(key.into(), value.clone());
            }
        }
    }
    if ctx.out.structured() {
        return ctx.out.emit(&session);
    }
    let out = &ctx.out;
    let title = s(&session, "title");
    println!(
        "{} {}",
        out.bold(if title.is_empty() { s(&session, "id") } else { title }),
        out.dim(&format!("{repo} {}", s(&session, "id")))
    );
    let mut facts = vec![out.state(s(&session, "state"))];
    let who = super::login_of(&session);
    if !who.is_empty() {
        facts.push(format!("{who} with {}", s(&session, "harness")));
    }
    facts.push(format!("started {}", ago(s(&session, "started_at"))));
    if let Some(seen) = session["last_seen_at"].as_str() {
        facts.push(format!("last seen {}", ago(seen)));
    }
    println!("{}", facts.join(" · "));
    let on = place(&session);
    if !on.is_empty() {
        println!("{} {on}", out.dim("On:"));
    }
    if let Some(head) = session["head_commit"].as_str() {
        println!("{} {}", out.dim("Head:"), head.get(..12).unwrap_or(head));
    }
    if let Some(reason) = session["end_reason"].as_str() {
        println!("{} {reason}", out.dim("Ended:"));
    }
    // A subagent: who started it, what it was asked and what it reported.
    if let Some(parent) = session["parent_id"].as_str() {
        let kind = session["agent_type"].as_str().map(|t| format!(" ({t})")).unwrap_or_default();
        println!("{} {parent}{kind}", out.dim("Subagent of:"));
    }
    if let Some(task) = session["task"].as_str().filter(|t| !t.trim().is_empty()) {
        println!("{} {}", out.dim("Task:"), task.trim());
    }
    if let Some(result) = session["result"].as_str().filter(|r| !r.trim().is_empty()) {
        println!("{}", out.dim("Result:"));
        for line in result.trim().lines() {
            println!("  {line}");
        }
    }
    let entries = session["entries"].as_array().cloned().unwrap_or_default();
    if !entries.is_empty() {
        println!();
    }
    let children = session["children"].as_array().cloned().unwrap_or_default();
    if !children.is_empty() {
        println!("{}", out.dim("Subagents:"));
        for child in &children {
            let depth = if child["parent_id"].as_str() == Some(s(&session, "id")) { "  " } else { "    " };
            let task = child["task"].as_str().unwrap_or("");
            println!("{depth}{} {} {} {task}", s(child, "id"), out.state(s(child, "state")), s(child, "agent_type"));
            if let Some(result) = child["result"].as_str() {
                println!("{depth}  {}", out.dim(result.lines().next().unwrap_or("")));
            }
        }
    }
    let links = session["links"].as_array().cloned().unwrap_or_default();
    if !links.is_empty() {
        let named: Vec<String> = links
            .iter()
            .map(|link| {
                let kind = if s(link, "kind") == "pull" { "pull " } else { "" };
                format!("{kind}#{} {}", link["number"], s(link, "title"))
            })
            .collect();
        println!("{} {}", out.dim("Worked on:"), named.join(", "));
    }
    let skills: Vec<String> = session["skills"].as_array().cloned().unwrap_or_default().iter().map(|skill| s(skill, "name").to_owned()).collect();
    if !skills.is_empty() {
        println!("{} {}", out.dim("Skills:"), skills.join(", "));
    }
    for entry in &entries {
        let kind = s(entry, "kind");
        let label = match entry["tool"].as_str() {
            Some(tool) => format!("{kind} {tool}"),
            None => kind.to_owned(),
        };
        let text = s(entry, "text").trim();
        let first = text.lines().next().unwrap_or("");
        println!("{} {first}", out.dim(&format!("{label:>10}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_is_a_list_of_models_and_their_counts() {
        let usage = usage_of(r#" [{"model":"claude-opus-5-5","input_tokens":3}] "#).unwrap();
        assert_eq!(usage[0]["input_tokens"], 3);
        assert!(usage_of("[]").is_ok());
        assert!(usage_of("{}").is_err());
        assert!(usage_of(r#"[{"input_tokens":3}]"#).is_err());
        assert!(usage_of("not json").is_err());
    }

    #[test]
    fn the_environment_overrides_the_kept_session() {
        let dir = std::env::temp_dir().join(format!("g1t-session-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session");
        std::fs::write(&path, "ses_kept\n").unwrap();
        assert_eq!(chosen(None, Some(path.clone())).as_deref(), Some("ses_kept"));
        assert_eq!(chosen(Some("ses_env".into()), Some(path.clone())).as_deref(), Some("ses_env"));
        assert_eq!(chosen(Some("  ".into()), Some(path.clone())).as_deref(), Some("ses_kept"));
        std::fs::write(&path, "\n").unwrap();
        assert_eq!(chosen(None, Some(path)).as_deref(), None);
        assert_eq!(chosen(None, None), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn touches_go_as_kinds_and_values() {
        let args = SessionTouchArgs {
            file: vec!["src/lib.rs".into()],
            commit: vec![],
            branch: vec!["12-fix".into()],
            pull: vec![14],
            item: vec![],
        };
        assert_eq!(
            Value::Array(touches(&args)),
            json!([
                { "kind": "file", "value": "src/lib.rs" },
                { "kind": "branch", "value": "12-fix" },
                { "kind": "pull", "value": "14" },
            ])
        );
    }

    /// UTF-8 read as Windows-1252 and saved again (the middle dot as
    /// U+00C2 U+00B7) printed as mojibake in `g1t session view`; no source
    /// holds it.
    #[test]
    fn no_source_holds_mojibake() {
        let marks = ['\u{00C2}', '\u{00E2}'].map(|lead| {
            // U+00C2 before a Latin-1 symbol, or U+00E2 U+20AC (how an
            // ellipsis, a dash or a curly quote starts when read so).
            move |text: &str| {
                text.char_indices().any(|(i, c)| {
                    c == lead
                        && text[i + c.len_utf8()..]
                            .chars()
                            .next()
                            .is_some_and(|next| ('\u{00A0}'..='\u{00BF}').contains(&next) || next == '\u{20AC}')
                })
            }
        });
        let mut dirs = vec![std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/src"))];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    dirs.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    assert!(!marks.iter().any(|found| found(&text)), "{} holds mojibake", path.display());
                }
            }
        }
    }

    #[test]
    fn a_session_says_where_it_is() {
        assert_eq!(place(&json!({ "item": 12, "pull": 14, "branch": "fix-x" })), "#12, pull #14, fix-x");
        assert_eq!(place(&json!({ "item": null, "branch": "" })), "");
    }
    #[test]
    fn changed_files_are_read_from_porcelain_status() {
        let status = " M src/a.rs\0?? notes/new.md\0R  src/new.rs\0src/old.rs\0R  b.rs\0a\0D  gone.rs\0 M src/a.rs\0";
        assert_eq!(changed_paths(status), ["src/a.rs", "notes/new.md", "src/new.rs", "b.rs", "gone.rs"]);
        assert!(changed_paths("").is_empty());
        let many: String = (0..300).map(|n| format!("?? f{n}\0")).collect();
        assert_eq!(changed_paths(&many).len(), MAX_CHANGED);
    }

    #[test]
    fn acknowledgement_notes_are_idempotent_for_the_same_update_set() {
        let first = acknowledgement_entries(&["upd_b".into(), "upd_a".into()], "Scopes are separate");
        let retry = acknowledgement_entries(&["upd_a".into(), "upd_b".into(), "upd_a".into()], "Scopes are separate");
        assert_eq!(first, retry);
        assert_ne!(first[0]["key"], acknowledgement_entries(&["upd_c".into()], "Scopes are separate")[0]["key"]);
        assert!(first[0]["text"].as_str().unwrap().contains("upd_a, upd_b"));
    }

}
