//! The commands.

pub mod alias;
pub mod api;
pub mod auth;
pub mod browse;
pub mod cache;
pub mod deploy;
pub mod issue;
pub mod logs;
pub mod pr;
pub mod repo;
pub mod run;
pub mod secret;
pub mod session;
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
        Command::Issue(command) => issue::run(&Ctx::new(cli.global)?, command),
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
        Command::Why(args) => why::run(&Ctx::new(cli.global)?, args),
        Command::Api(args) => api::run(&Ctx::new(cli.global)?, args),
        Command::Browse(args) => browse::run(&Ctx::new(cli.global)?, args),
    }
}

/// `@me` is the signed-in account.
pub fn who(ctx: &Ctx, client: &crate::client::Client, login: &str) -> Result<String> {
    if login == "@me" {
        ctx.me(client)
    } else {
        Ok(login.trim_start_matches('@').to_owned())
    }
}

/// The repository and a signed-in client for the coordination commands
/// (`g1t session`, `g1t work`, `g1t why`). Agents' hooks run them in the
/// background, so they fail at once without a token (exit code 4), never
/// ask anything, and give up on a call after `read` rather than hang.
pub fn coordination_client(
    ctx: &Ctx,
    read: std::time::Duration,
) -> Result<(crate::repo::Repo, crate::client::Client)> {
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
        if let Some(login) = who
            .as_str()
            .or_else(|| who["username"].as_str())
            .or_else(|| who["login"].as_str())
            .filter(|login| !login.is_empty())
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
