//! The commands.

pub mod alias;
pub mod api;
pub mod auth;
pub mod browse;
pub mod deploy;
pub mod issue;
pub mod logs;
pub mod pr;
pub mod repo;
pub mod run;
pub mod secret;
pub mod status;
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
        Command::Deploy(command) => deploy::run(&Ctx::new(cli.global)?, command),
        Command::Logs(args) => logs::run(&Ctx::new(cli.global)?, args),
        Command::Status(_) => status::run(&Ctx::new(cli.global)?),
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
