//! The command reference in the docs, `apps/docs/src/content/docs/reference/cli.md`,
//! is written from the command tree itself. A test fails when it is out of
//! date; regenerate it with
//!
//! ```sh
//! G1T_WRITE_DOCS=1 cargo test -p g1t cli_reference
//! ```

use clap::{Arg, ArgAction, Command};
use std::fmt::Write as _;

const HEAD: &str = "---
title: CLI commands
description: Every g1t command with its arguments and flags, written from the CLI's own definitions.
---

<!-- Generated from crates/g1t by `G1T_WRITE_DOCS=1 cargo test -p g1t cli_reference`. Do not edit by hand. -->

Every command of the [g1t CLI](/guides/cli/), with its arguments and flags.
`g1t <command> --help` prints the same at a terminal. Each command that talks
to the API names the operations it calls, which link to the
[API reference](/reference/api/); [`g1t api`](#g1t-api) calls any other.

## Flags every command takes

| Flag | |
| --- | --- |
";

/// Help text as a sentence: clap drops the full stop doc comments end with.
fn sentence(text: &str) -> String {
    let text = text.trim();
    if text.is_empty() || text.ends_with(['.', ':', '?', '!']) {
        text.to_owned()
    } else {
        format!("{text}.")
    }
}

fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_owned()
}

fn cell(text: &str) -> String {
    text.replace('|', "\\|").replace('\n', " ")
}

fn flag(arg: &Arg) -> String {
    let value = arg
        .get_value_names()
        .map(|v| {
            v.iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_else(|| arg.get_id().to_string().to_uppercase());
    let takes_value = matches!(arg.get_action(), ArgAction::Set | ArgAction::Append);
    let optional = arg.get_num_args().is_some_and(|n| n.min_values() == 0);
    let mut name = match (arg.get_short(), arg.get_long()) {
        (Some(s), Some(l)) => format!("-{s}, --{l}"),
        (None, Some(l)) => format!("--{l}"),
        (Some(s), None) => format!("-{s}"),
        (None, None) => {
            return if arg.is_required_set() {
                format!("<{value}>")
            } else {
                format!("[{value}]")
            };
        }
    };
    if takes_value {
        name.push_str(&if optional {
            format!(" [{value}]")
        } else {
            format!(" <{value}>")
        });
    }
    name
}

fn describe(arg: &Arg) -> String {
    let mut text = sentence(&arg.get_help().map(|h| h.to_string()).unwrap_or_default());
    let values: Vec<String> = arg
        .get_possible_values()
        .iter()
        .filter(|v| !v.is_hide_set())
        .map(|v| format!("`{}`", v.get_name()))
        .collect();
    if !values.is_empty() && !text.contains(&values.join(", ")) {
        let _ = write!(
            text,
            "{}One of {}.",
            if text.is_empty() { "" } else { " " },
            values.join(", ")
        );
    }
    let defaults: Vec<String> = arg
        .get_default_values()
        .iter()
        .map(|v| v.to_string_lossy().into_owned())
        .collect();
    if !defaults.is_empty() && !matches!(arg.get_action(), ArgAction::SetTrue) {
        let _ = write!(text, " Default: `{}`.", defaults.join(","));
    }
    if arg.is_last_set() {
        text = format!("After `--`. {text}");
    }
    cell(text.trim())
}

fn command(out: &mut String, cmd: &Command, path: &str, depth: usize) {
    if cmd.is_hide_set() || cmd.get_name() == "help" {
        return;
    }
    let subs: Vec<&Command> = cmd
        .get_subcommands()
        .filter(|c| !c.is_hide_set() && c.get_name() != "help")
        .collect();
    let heading = "#".repeat(depth.min(4));
    let _ = writeln!(out, "{heading} {path}\n");
    if let Some(about) = cmd.get_about() {
        let _ = writeln!(out, "{}\n", sentence(&about.to_string()));
    }
    if !subs.is_empty() {
        for sub in &subs {
            command(out, sub, &format!("{path} {}", sub.get_name()), depth + 1);
        }
        return;
    }
    let usage = cmd.clone().render_usage().to_string();
    let usage = usage.trim_start_matches("Usage: ").trim();
    let _ = writeln!(out, "```text\n{usage}\n```\n");
    let args: Vec<&Arg> = cmd
        .get_arguments()
        .filter(|a| {
            !a.is_hide_set()
                && !a.is_global_set()
                && !matches!(a.get_id().as_str(), "help" | "version")
        })
        .collect();
    if !args.is_empty() {
        let _ = writeln!(out, "| Argument or flag | |\n| --- | --- |");
        for arg in args {
            let _ = writeln!(out, "| `{}` | {} |", cell(&flag(arg)), describe(arg));
        }
        let _ = writeln!(out);
    }
    if let Some(after) = cmd.get_after_help() {
        let _ = writeln!(out, "```text\n{}\n```\n", after.to_string().trim());
    }
    let key = path.trim_start_matches("g1t ");
    if let Some(m) = crate::mapping::COMMANDS
        .iter()
        .find(|m| m.command == key)
        .filter(|m| !m.ops.is_empty())
    {
        let links: Vec<String> = m
            .ops
            .iter()
            .map(|id| {
                let tag = crate::ops::find(id).map(|op| op.tag).unwrap_or("");
                format!("[`{id}`](/reference/api/{}/{}/)", slug(tag), slug(id))
            })
            .collect();
        let _ = writeln!(out, "Calls {}.\n", links.join(", "));
    }
}

pub fn reference() -> String {
    let mut root = <crate::cli::Cli as clap::CommandFactory>::command();
    root.build();
    let mut out = HEAD.to_owned();
    for arg in root
        .get_arguments()
        .filter(|a| a.is_global_set() && !a.is_hide_set())
    {
        let _ = writeln!(out, "| `{}` | {} |", cell(&flag(arg)), describe(arg));
    }
    let _ = writeln!(out);
    for sub in root.get_subcommands() {
        command(&mut out, sub, &format!("g1t {}", sub.get_name()), 2);
    }
    out.trim_end().to_owned() + "\n"
}

#[cfg(test)]
mod tests {
    #[test]
    fn cli_reference_is_current() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/docs/src/content/docs/reference/cli.md"
        );
        let want = super::reference();
        if std::env::var_os("G1T_WRITE_DOCS").is_some() {
            std::fs::write(path, &want).unwrap();
            return;
        }
        let have = std::fs::read_to_string(path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert!(
            have == want,
            "apps/docs/src/content/docs/reference/cli.md is out of date: run G1T_WRITE_DOCS=1 cargo test -p g1t cli_reference"
        );
    }
}
