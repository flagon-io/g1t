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
    SessionAttachArgs, SessionCommand, SessionEndArgs, SessionListArgs, SessionLogArgs,
    SessionStartArgs, SessionState, SessionViewArgs,
};
use crate::client::Client;
use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::output::{Cell, Output, ago, s};
use crate::repo::Repo;

pub fn run(ctx: &Ctx, command: SessionCommand) -> Result<()> {
    match command {
        SessionCommand::Start(args) => start(ctx, args),
        SessionCommand::Heartbeat => heartbeat(ctx),
        SessionCommand::Log(args) => log(ctx, args),
        SessionCommand::Attach(args) => attach(ctx, args),
        SessionCommand::End(args) => end(ctx, args),
        SessionCommand::List(args) => list(ctx, args),
        SessionCommand::View(args) => view(ctx, args),
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
        .field_opt("issue", args.issue)
        .field_opt("pull", args.pull)
        .field_opt("branch", branch)
        .field_opt("title", args.title.clone())
        .field_opt("head_commit", head)
        .send()?;
    let session = session_of(found);
    let id = s(&session, "id").to_owned();
    if id.is_empty() {
        return Err(Error::failed("The API did not say which session it started."));
    }
    remember(&id)?;
    if ctx.out.structured() {
        return ctx.out.emit(&session);
    }
    println!("{id}");
    Ok(())
}

fn heartbeat(ctx: &Ctx) -> Result<()> {
    let id = required()?;
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let found = client.op("update_session").repo(&repo).arg("id", &id).send()?;
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
    if let Some(issue) = session["issue"].as_u64() {
        parts.push(format!("#{issue}"));
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
        .field_opt("issue", args.issue)
        .field_opt("pull", args.pull)
        .field_opt("branch", args.branch.clone())
        .field_opt("head_commit", args.head_commit.clone())
        .send()?;
    let session = session_of(found);
    if ctx.out.structured() {
        return ctx.out.emit(&session);
    }
    eprintln!("Session {id} is on {}.", place(&session));
    Ok(())
}

fn end(ctx: &Ctx, args: SessionEndArgs) -> Result<()> {
    let id = required()?;
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let found = client
        .op("end_session")
        .repo(&repo)
        .arg("id", &id)
        .field_opt("reason", args.reason.clone())
        .send()?;
    forget(&id);
    if ctx.out.structured() {
        return ctx.out.emit(&session_of(found));
    }
    eprintln!("Ended session {id}.");
    Ok(())
}

pub fn fetch_list(
    client: &Client,
    repo: &Repo,
    state: Option<&str>,
    issue: Option<u64>,
    pull: Option<u64>,
) -> Result<Vec<Value>> {
    let found = client
        .op("list_sessions")
        .repo(repo)
        .query_opt("state", state)
        .query_opt("issue", issue)
        .query_opt("pull", pull)
        .send()?;
    Ok(super::items(found, "sessions"))
}

fn list(ctx: &Ctx, args: SessionListArgs) -> Result<()> {
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let state = args.state.map(|state| match state {
        SessionState::Active => "active",
        SessionState::Idle => "idle",
        SessionState::Ended => "ended",
    });
    let mut sessions = fetch_list(&client, &repo, state, args.issue, args.pull)?;
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

pub fn print_list(out: &Output, sessions: &[Value], mine: Option<&str>) -> Result<()> {
    let rows: Vec<Vec<Cell>> = sessions
        .iter()
        .map(|session| {
            let id = s(session, "id");
            let marked = if Some(id) == mine { format!("{id} *") } else { id.to_owned() };
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

fn view(ctx: &Ctx, args: SessionViewArgs) -> Result<()> {
    let id = match args.id {
        Some(id) => id,
        None => required()?,
    };
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let found = client.op("get_session").repo(&repo).arg("id", &id).send()?;
    let entries = found
        .get("entries")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let mut session = session_of(found);
    if let Some(map) = session.as_object_mut() {
        map.insert("entries".into(), entries);
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
    let entries = session["entries"].as_array().cloned().unwrap_or_default();
    if !entries.is_empty() {
        println!();
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
    fn a_session_says_where_it_is() {
        assert_eq!(place(&json!({ "issue": 12, "pull": 14, "branch": "fix-x" })), "#12, pull #14, fix-x");
        assert_eq!(place(&json!({ "issue": null, "branch": "" })), "");
    }
}
