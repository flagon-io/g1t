//! The g1t command line.

mod auth;
mod chunk;
mod cli;
mod client;
mod commands;
mod config;
mod context;
mod credentials;
#[cfg(test)]
mod docs;
mod error;
mod git;
mod image;
mod jq;
mod mapping;
mod ops;
mod ops_table;
mod output;
mod prompt;
mod push;
mod reference;
mod registry;
mod repo;

use clap::{CommandFactory, FromArgMatches};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let code = match run(args) {
        Ok(()) => 0,
        Err(error) => {
            if !error.silent && !error.message.is_empty() {
                eprintln!("g1t: {}", error.message.trim_end());
            }
            error.kind.code()
        }
    };
    ExitCode::from(code)
}

fn run(args: Vec<String>) -> error::Result<()> {
    let args = match commands::alias::expand(args)? {
        commands::alias::Expanded::Args(args) => args,
        commands::alias::Expanded::Ran(code) => {
            return if code == 0 {
                Ok(())
            } else {
                Err(error::Error::exit(error::Kind::Failed))
            };
        }
    };
    let matches = match cli::Cli::command().try_get_matches_from(&args) {
        Ok(m) => m,
        Err(e) => return clap_error(e),
    };
    let parsed = match cli::Cli::from_arg_matches(&matches) {
        Ok(p) => p,
        Err(e) => return clap_error(e),
    };
    // A newer release, said after the command at a terminal (upgrade.rs).
    let notice = commands::upgrade::Notice::start(matches!(parsed.command, cli::Command::Upgrade(_)));
    let ran = commands::dispatch(parsed);
    notice.finish();
    ran
}

/// Help and the version go to stdout and succeed; a mistake is one line on
/// stderr and exit code 2.
fn clap_error(e: clap::Error) -> error::Result<()> {
    use clap::error::ErrorKind;
    match e.kind() {
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => {
            let _ = e.print();
            Ok(())
        }
        ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
            let _ = e.print();
            Err(error::Error::exit(error::Kind::Usage))
        }
        _ => {
            let text = e.render().to_string();
            let line = text
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim_start_matches("error: ")
                .trim();
            let tip = text
                .lines()
                .find(|l| l.trim_start().starts_with("tip:"))
                .map(|l| format!(" ({})", l.trim().trim_start_matches("tip: ")))
                .unwrap_or_default();
            Err(error::Error::usage(format!("{line}{tip} See --help.")))
        }
    }
}
