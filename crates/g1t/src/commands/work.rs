//! `g1t work`: coordinating work on issues. Who is on an issue (claims and
//! sessions), what it waits on, handing it over, and following what happens
//! in the repository as it happens.

use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet, VecDeque};
use std::time::{Duration, Instant};

use crate::cli::{
    WorkBlockArgs, WorkClaimArgs, WorkCommand, WorkEventsArgs, WorkHandoffArgs, WorkNumber,
    WorkReleaseArgs,
};
use crate::client::Client;
use crate::context::Ctx;
use crate::error::{Error, Kind, Result};
use crate::output::{Output, ago, now, parse_time, s};
use crate::repo::Repo;

/// How long a follow asks the API to hold each call, in seconds.
const WAIT_SECONDS: u64 = 25;
/// The longest a follow waits before trying again after a failure.
const MAX_BACKOFF_SECONDS: u64 = 30;
/// How many event ids a follow remembers, to print none twice.
const REMEMBERED: usize = 1_000;

pub fn run(ctx: &Ctx, command: WorkCommand) -> Result<()> {
    match command {
        WorkCommand::Context(args) => context(ctx, args),
        WorkCommand::Claim(args) => claim(ctx, args),
        WorkCommand::Release(args) => release(ctx, args),
        WorkCommand::Handoff(args) => handoff(ctx, args),
        WorkCommand::List => list(ctx),
        WorkCommand::Block(args) => block(ctx, args, true),
        WorkCommand::Unblock(args) => block(ctx, args, false),
        WorkCommand::Events(args) => events(ctx, args),
    }
}

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
    if let Some(issue) = claim["issue"].as_u64() {
        line.push_str(&format!(" on #{issue}"));
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

/// An issue another one waits on, as a line.
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

fn context(ctx: &Ctx, args: WorkNumber) -> Result<()> {
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let work = client.op("get_work").repo(&repo).arg("number", args.number).send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&work);
    }
    print_context(&ctx.out, &repo, args.number, &work);
    Ok(())
}

fn list_of<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().map(Vec::as_slice).unwrap_or_default()
}

pub fn print_context(out: &Output, repo: &Repo, number: u64, work: &Value) {
    let issue = &work["issue"];
    println!("{} {}", out.bold(s(issue, "title")), out.dim(&format!("{repo}#{number}")));
    let mut facts = vec![out.state(s(issue, "state"))];
    let assignees: Vec<String> = issue["assignees"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a.as_str().map(str::to_owned).or_else(|| a["username"].as_str().map(str::to_owned)))
        .collect();
    if !assignees.is_empty() {
        facts.push(format!("assigned to {}", assignees.join(", ")));
    }
    println!("{}", facts.join(" · "));
    if let Some(done) = issue["definition_of_done"].as_str().filter(|d| !d.trim().is_empty()) {
        heading(out, "Definition of done");
        for line in done.trim().lines() {
            println!("  {line}");
        }
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
    let pulls = list_of(work, "pulls");
    heading(out, "Pull requests");
    if pulls.is_empty() {
        println!("  {}", out.dim("None yet."));
    }
    for pull in pulls {
        let status = pull["status"].as_str().or_else(|| pull["state"].as_str()).unwrap_or("");
        let mut line = format!("#{} {} {}", pull["number"], s(pull, "title"), out.state(status));
        let checks = pull["checks"]["status"]
            .as_str()
            .or_else(|| pull["checks"].as_str())
            .or_else(|| pull["check_status"].as_str());
        if let Some(checks) = checks {
            line.push_str(&format!(", checks {}", out.state(checks)));
        }
        if let Some(position) = pull["queue_position"].as_u64().or_else(|| pull["queue"]["position"].as_u64()) {
            line.push_str(&format!(", queued {position}"));
        }
        println!("  {line}");
        for overlap in list_of(pull, "overlaps") {
            let other = overlap["pull"].as_u64().or_else(|| overlap["number"].as_u64()).unwrap_or(0);
            let files: Vec<&str> = list_of(overlap, "files").iter().filter_map(Value::as_str).collect();
            println!(
                "    {} #{other}{}",
                out.yellow("overlaps"),
                if files.is_empty() { String::new() } else { format!(": {}", files.join(", ")) }
            );
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

fn claim(ctx: &Ctx, args: WorkClaimArgs) -> Result<()> {
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let found = client
        .op("claim_issue")
        .repo(&repo)
        .arg("number", args.number)
        .field_opt("session_id", super::session::current())
        .field_opt("note", args.note.clone())
        .field_opt("ttl_minutes", args.ttl)
        .send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    let out = &ctx.out;
    let claim = &found["claim"];
    match claim["expires_at"].as_str() {
        Some(expires) => println!("Claimed #{}; it expires {} unless renewed.", args.number, until(expires)),
        None => println!("Claimed #{}.", args.number),
    }
    let others = list_of(&found, "others");
    if !others.is_empty() {
        println!("{}", out.yellow(&format!("#{} is claimed by others too:", args.number)));
        for other in others {
            println!("  {}", claim_line(out, other));
        }
    }
    let waiting: Vec<&Value> = list_of(&found, "blocked_by")
        .iter()
        .filter(|b| !matches!(b["state"].as_str(), Some("closed" | "merged")))
        .collect();
    if !waiting.is_empty() {
        println!("{}", out.yellow(&format!("#{} waits on:", args.number)));
        for blocker in waiting {
            println!("  {}", blocker_line(out, blocker));
        }
    }
    Ok(())
}

fn release(ctx: &Ctx, args: WorkReleaseArgs) -> Result<()> {
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let found = client
        .op("release_claim")
        .repo(&repo)
        .arg("number", args.number)
        .field_opt("reason", args.reason.clone())
        .send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    eprintln!("Released your claim on #{}.", args.number);
    Ok(())
}

fn handoff(ctx: &Ctx, args: WorkHandoffArgs) -> Result<()> {
    if args.note.trim().is_empty() {
        return Err(Error::usage("Say where it stands with --note."));
    }
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let to = match &args.to {
        Some(login) => Some(super::who(ctx, &client, login)?),
        None => None,
    };
    let found = client
        .op("hand_off_issue")
        .repo(&repo)
        .arg("number", args.number)
        .field_opt("to", to.clone())
        .field("note", args.note.trim())
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

pub fn active_claims(client: &Client, repo: &Repo) -> Result<Vec<Value>> {
    let found = client.op("list_claims").repo(repo).query("state", "active").send()?;
    Ok(super::items(found, "claims"))
}

fn list(ctx: &Ctx) -> Result<()> {
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

/// The issues `number` waits on once `by` is added to `current`
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

fn block(ctx: &Ctx, args: WorkBlockArgs, add: bool) -> Result<()> {
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let found = client.op("get_issue").repo(&repo).arg("number", args.number).send()?;
    let issue = super::unwrap_key(found, "issue");
    let current: Vec<u64> = issue["blocked_by"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|n| n.as_u64().or_else(|| n["number"].as_u64()))
        .collect();
    let wanted = blocked_set(args.number, &current, &args.by, add)?;
    let updated = client
        .op("update_issue")
        .repo(&repo)
        .arg("number", args.number)
        .field("blocked_by", json!(wanted))
        .send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&super::unwrap_key(updated, "issue"));
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

/// The issue or pull request an event is about.
fn event_number(data: &Value) -> Option<u64> {
    data["number"]
        .as_u64()
        .or_else(|| data["issue"].as_u64())
        .or_else(|| data["pull"].as_u64())
        .or_else(|| data["issue"]["number"].as_u64())
        .or_else(|| data["pull"]["number"].as_u64())
        .or_else(|| data["claim"]["issue"].as_u64())
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
        numbers: args.issues.iter().map(u64::to_string).collect::<Vec<_>>().join(","),
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
            "data": { "number": 14, "issue": 12, "check": { "name": "test", "conclusion": "failure" }, "combination": [14, 15] },
        });
        assert_eq!(
            event_line(&out, &failed),
            "2026-10-12 09:01:02\tintegration.failed\t#14\ttest failure with #14, #15\tevt_2"
        );
        let claimed = json!({
            "id": "evt_3", "type": "work.claimed", "time": "2026-10-12T09:02:00Z",
            "data": { "number": 12, "claim": { "issue": 12, "note": "taking the parser" } },
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
        let line = claim_line(&out, &json!({ "actor": "ana", "harness": "claude_code", "issue": 12, "state": "active", "note": "parser" }));
        assert_eq!(line, "ana (claude_code) on #12: parser");
        assert_eq!(until("2000-01-01T00:00:00Z"), "expired");
    }
}
