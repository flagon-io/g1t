//! The commands.

pub mod alias;
pub mod api;
pub mod attach;
pub mod auth;
pub mod browse;
pub mod cache;
pub mod cycle;
pub mod deploy;
pub mod logs;
pub mod pr;
pub mod project;
pub mod repo;
pub mod run;
pub mod secret;
pub mod session;
pub mod spend;
pub mod status;
pub mod upgrade;
pub mod why;
pub mod work;
pub mod workflow;

use clap::CommandFactory;

use crate::cli::{Cli, Command};
use crate::context::Ctx;
use crate::error::{Error, Result};

pub fn dispatch(cli: Cli) -> Result<()> {
    match cli.command {
        Command::Completion(args) => {
            let mut command = Cli::command();
            clap_complete::generate(args.shell, &mut command, "g1t", &mut std::io::stdout());
            Ok(())
        }
        Command::Upgrade(args) => upgrade::run(args),
        Command::Push(args) => {
            let push = crate::push::Push::from_args(args).map_err(Error::usage)?;
            push.run().map_err(Error::failed)
        }
        Command::Alias(command) => alias::run(command),
        Command::Auth(command) => auth::run(Ctx::new(cli.global)?, command),
        Command::Repo(command) => repo::run(&Ctx::new(cli.global)?, command),
        Command::Pr(command) => pr::run(&Ctx::new(cli.global)?, command),
        Command::Run(command) => run::run(&Ctx::new(cli.global)?, command),
        Command::Workflow(command) => workflow::run(&Ctx::new(cli.global)?, command),
        Command::Secret(command) => secret::run(&Ctx::new(cli.global)?, command),
        Command::Cache(command) => cache::run(&Ctx::new(cli.global)?, command),
        Command::Deploy(command) => deploy::run(&Ctx::new(cli.global)?, command),
        Command::Logs(args) => logs::run(&Ctx::new(cli.global)?, args),
        Command::Status(_) => status::run(&Ctx::new(cli.global)?),
        Command::Session(command) => session::run(&Ctx::new(cli.global)?, command),
        Command::Work(command) => work::run(&Ctx::new(cli.global)?, command),
        Command::Project(command) => project::run(&Ctx::new(cli.global)?, command),
        Command::Cycle(command) => cycle::run(&Ctx::new(cli.global)?, command),
        Command::Spend(args) => spend::run(&Ctx::new(cli.global)?, args),
        Command::Why(args) => why::run(&Ctx::new(cli.global)?, args),
        Command::Attach(args) => attach::run(&Ctx::new(cli.global)?, args),
        Command::Api(args) => api::run(&Ctx::new(cli.global)?, args),
        Command::Browse(args) => browse::run(&Ctx::new(cli.global)?, args),
    }
}

/// `@me` is the signed-in account.
pub fn who(ctx: &Ctx, client: &crate::client::Client, login: &str) -> Result<String> {
    if login == "@me" { ctx.me(client) } else { Ok(login.trim_start_matches('@').to_owned()) }
}

/// The repository and a signed-in client for the coordination commands
/// (`g1t session`, `g1t work`, `g1t why`). Agents' hooks run them in the
/// background, so they fail at once without a token (exit code 4), never
/// ask anything, and give up on a call after `read` rather than hang.
pub fn coordination_client(ctx: &Ctx, read: std::time::Duration) -> Result<(crate::repo::Repo, crate::client::Client)> {
    let (repo, client) = ctx.repo_client()?;
    if !client.has_token() {
        return Err(crate::context::not_signed_in(&client.host));
    }
    Ok((repo, client.with_timeouts(std::time::Duration::from_secs(5), read)))
}

/// How long a coordination command waits for an answer.
pub const QUICK: std::time::Duration = std::time::Duration::from_secs(15);

/// Who a session, claim or decision belongs to: its `actor` (a login, or
/// an account with one), or its `user`.
pub fn login_of(value: &serde_json::Value) -> String {
    for key in ["actor", "user", "author"] {
        let who = &value[key];
        if let Some(login) =
            who.as_str().or_else(|| who["username"].as_str()).or_else(|| who["login"].as_str()).filter(|login| !login.is_empty())
        {
            return login.to_owned();
        }
    }
    String::new()
}

/// The object under `key` when the answer wraps it, or the answer itself.
pub fn unwrap_key(value: serde_json::Value, key: &str) -> serde_json::Value {
    match value.get(key) {
        Some(inner) if inner.is_object() => inner.clone(),
        _ => value,
    }
}

/// The items of a list answer, which comes bare or under a key.
pub fn items(value: serde_json::Value, key: &str) -> Vec<serde_json::Value> {
    match value {
        serde_json::Value::Array(list) => list,
        mut other => match other.get_mut(key).map(serde_json::Value::take) {
            Some(serde_json::Value::Array(list)) => list,
            _ => match other.get_mut("items").map(serde_json::Value::take) {
                Some(serde_json::Value::Array(list)) => list,
                _ => Vec::new(),
            },
        },
    }
}

/// Prints what was done: the object as JSON, or a line and its address.
pub fn done(ctx: &Ctx, value: &serde_json::Value, said: &str, url: &str) -> Result<()> {
    if ctx.out.structured() {
        return ctx.out.emit(value);
    }
    eprintln!("{} {said}", ctx.out.green("✓"));
    println!("{url}");
    Ok(())
}

/// `call` with the box `g1t work check` or `g1t pr check` names: a number
/// is its place (unless --text), anything else words of its text.
pub fn task_check<'a>(call: crate::client::Call<'a>, args: &crate::cli::TaskCheckArgs) -> crate::client::Call<'a> {
    let task = args.task.trim();
    let call = match task.parse::<u64>() {
        Ok(number) if !args.text => call.field("task", number),
        _ => call.field("text", task),
    };
    call.field("checked", !args.uncheck)
}

/// What ticking a box says: which box, and how many are done.
pub fn task_checked(ctx: &Ctx, checked: &serde_json::Value, of: &str, url: &str) -> Result<()> {
    if ctx.out.structured() {
        return ctx.out.emit(checked);
    }
    let task = &checked["task"];
    let ticked = task["checked"].as_bool() == Some(true);
    let what = format!("box {} of {of}: {}", task["number"].as_u64().unwrap_or_default(), task["text"].as_str().unwrap_or_default());
    let said = match (checked["changed"].as_bool() == Some(true), ticked) {
        (true, true) => format!("Ticked {what}"),
        (true, false) => format!("Unticked {what}"),
        (false, true) => format!("Already ticked: {what}"),
        (false, false) => format!("Already unticked: {what}"),
    };
    eprintln!(
        "{} {said} ({} of {} done)",
        ctx.out.green("✓"),
        checked["done"].as_u64().unwrap_or_default(),
        checked["total"].as_u64().unwrap_or_default()
    );
    println!("{url}");
    Ok(())
}

/// Names from a list of strings, or of objects with a username or a name.
pub fn names(list: &serde_json::Value) -> Vec<String> {
    list.as_array()
        .map(|l| {
            l.iter()
                .filter_map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .or_else(|| v["username"].as_str().map(str::to_owned))
                        .or_else(|| v["name"].as_str().map(str::to_owned))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `current` with `add` put in and `remove` taken out, compared without case.
pub fn adjust(current: Vec<String>, add: &[String], remove: &[String]) -> Vec<String> {
    let mut out: Vec<String> = current.into_iter().filter(|c| !remove.iter().any(|r| r.eq_ignore_ascii_case(c))).collect();
    for a in add {
        if !out.iter().any(|c| c.eq_ignore_ascii_case(a)) {
            out.push(a.clone());
        }
    }
    out
}

/// How many polls in a row a watch rides out before it gives up: one
/// answer of HTTP 500, or the network dropping for a moment, ends no watch.
pub const WATCH_TRIES: u32 = 5;

/// One poll of a watch. A failure, while fewer than `tries` in a row have
/// failed, is said on stderr and comes back as `None`, to be waited out;
/// being signed out never is.
pub fn polled<T>(result: Result<T>, failures: &mut u32, tries: u32) -> Result<Option<T>> {
    match result {
        Ok(value) => {
            *failures = 0;
            Ok(Some(value))
        }
        Err(error) if error.kind != crate::error::Kind::Auth && *failures + 1 < tries => {
            *failures += 1;
            eprintln!("g1t: {} (trying again, {} of {tries})", error.message, *failures + 1);
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

/// A thread's comments: notes of what happened dimmed, the rest in full.
pub fn print_comments(out: &crate::output::Output, comments: &serde_json::Value) {
    use crate::output::{ago, s};
    for c in comments.as_array().into_iter().flatten() {
        let who = s(&c["author"], "username");
        let when = ago(s(c, "created_at"));
        if c["kind"] == "event" {
            println!("{}", out.dim(&format!("  {who} {} {when}", s(c, "body"))));
            continue;
        }
        println!();
        let verdict = match c["verdict"].as_str() {
            Some(v) => format!(" {}", out.state(if v == "approve" { "approved" } else { v })),
            None => String::new(),
        };
        let place = match (c["path"].as_str(), c["line"].as_u64()) {
            (Some(p), Some(l)) => out.dim(&format!(" on {p}:{l}")),
            (Some(p), None) => out.dim(&format!(" on {p}")),
            _ => String::new(),
        };
        println!("{}{verdict}{place} {}", out.bold(who), out.dim(&when));
        for line in s(c, "body").trim_end().lines() {
            println!("  {line}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_watch_rides_out_a_few_failed_polls() {
        let mut failures = 0;
        for _ in 0..WATCH_TRIES - 1 {
            assert!(polled::<u32>(Err(Error::failed("api.g1t.sh answered HTTP 500")), &mut failures, WATCH_TRIES).unwrap().is_none());
        }
        // Too many in a row: it gives up with the last.
        assert!(polled::<u32>(Err(Error::failed("again")), &mut failures, WATCH_TRIES).is_err());
        // An answer starts the count again.
        let mut failures = WATCH_TRIES - 1;
        assert_eq!(polled(Ok(7), &mut failures, WATCH_TRIES).unwrap(), Some(7));
        assert_eq!(failures, 0);
        // Signed out, or not watching: at once.
        let signed_out = Error { kind: crate::error::Kind::Auth, message: "Sign in".into(), silent: false };
        assert!(polled::<u32>(Err(signed_out), &mut 0, WATCH_TRIES).is_err());
        assert!(polled::<u32>(Err(Error::failed("once")), &mut 0, 1).is_err());
    }

    #[test]
    fn lists_are_adjusted_without_case() {
        let have = vec!["bug".to_owned(), "docs".to_owned()];
        assert_eq!(adjust(have.clone(), &["Bug".into(), "p1".into()], &["DOCS".into()]), vec!["bug".to_owned(), "p1".to_owned()]);
        assert_eq!(adjust(have, &[], &[]), vec!["bug".to_owned(), "docs".to_owned()]);
    }

    #[test]
    fn names_come_from_strings_or_objects() {
        assert_eq!(names(&json!(["a", { "username": "b" }, { "name": "c" }])), vec!["a", "b", "c"]);
    }
}
