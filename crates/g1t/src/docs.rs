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

/// The `g1t …` command lines in a page: in code blocks (a line starting
/// with `g1t `, or `$ g1t `) and in inline code. Each is cut at the first
/// shell operator or comment.
pub fn command_lines(page: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut in_block = false;
    let mut take = |text: &str| {
        let text = text.trim();
        let text = text.strip_prefix("$ ").unwrap_or(text);
        if !text.starts_with("g1t ") {
            return;
        }
        let end = [
            " | ", " && ", " || ", " ; ", "; ", " # ", " > ", " < ", "`", " 2>",
        ]
        .iter()
        .filter_map(|op| text.find(op))
        .min()
        .unwrap_or(text.len());
        found.push(text[..end].trim().to_owned());
    };
    for line in page.lines() {
        if line.trim_start().starts_with("```") {
            in_block = !in_block;
            continue;
        }
        if in_block {
            take(line);
            continue;
        }
        for (i, part) in line.split('`').enumerate() {
            if i % 2 == 1 {
                take(part);
            }
        }
    }
    found
}

/// What is wrong with a documented command line: a command the CLI does
/// not have, or a flag the command does not take. None when it is right, or
/// when it cannot be told (an alias, a placeholder).
pub fn wrong(line: &str) -> Option<String> {
    let mut root = <crate::cli::Cli as clap::CommandFactory>::command();
    root.build();
    let words = shell_words(line);
    // Not a command: "g1t / deploy" (a check's name), "g1t <noreply@…>".
    let command_word = |w: &String| {
        w.chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c == '-')
    };
    if !words.get(1).is_some_and(command_word) {
        return None;
    }
    let mut cmd = &root;
    let mut path = vec!["g1t".to_owned()];
    let mut rest = words.iter().skip(1).peekable();
    while let Some(word) = rest.peek() {
        if word.starts_with('-') || !cmd.has_subcommands() {
            break;
        }
        match cmd.find_subcommand(word.as_str()) {
            Some(sub) => {
                path.push(word.to_string());
                cmd = sub;
                rest.next();
            }
            // The aliases the docs make, and placeholders like COMMAND, are not checked.
            None if path.len() == 1 && DOC_ALIASES.contains(&word.as_str()) => return None,
            None => {
                if word
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c == '_' || c == '<' || c == '>')
                {
                    return None;
                }
                return Some(format!("`{}` has no command `{word}`", path.join(" ")));
            }
        }
    }
    let globals: Vec<&clap::Arg> = root.get_arguments().collect();
    let rest: Vec<&String> = rest.collect();
    for (i, word) in rest.iter().enumerate() {
        if *word == "--" {
            break;
        }
        let Some(flag) = word.strip_prefix("--") else {
            continue;
        };
        let (flag, inline) = match flag.split_once('=') {
            Some((flag, value)) => (flag, Some(value)),
            None => (flag, None),
        };
        if flag.is_empty()
            || flag.starts_with(['<', '['])
            || flag.chars().any(|c| c.is_ascii_uppercase())
        {
            continue;
        }
        let known = |arg: &&clap::Arg| {
            arg.get_long() == Some(flag) || arg.get_all_aliases().is_some_and(|a| a.contains(&flag))
        };
        let Some(arg) = cmd
            .get_arguments()
            .find(known)
            .or_else(|| globals.iter().copied().find(known))
        else {
            if matches!(flag, "help" | "version") {
                continue;
            }
            return Some(format!("`{}` takes no --{flag}", path.join(" ")));
        };
        // A value from a fixed list: one of them (a placeholder is not checked).
        let values = arg.get_possible_values();
        let value = inline.or_else(|| rest.get(i + 1).map(|v| v.as_str()));
        let literal = |v: &&str| {
            v.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        };
        let unknown = |v: &&str| !values.iter().any(|p| p.matches(v, false));
        if let Some(value) = value.filter(|v| !values.is_empty() && literal(v) && unknown(v)) {
            let names: Vec<String> = values.iter().map(|v| v.get_name().to_owned()).collect();
            return Some(format!(
                "`{} --{flag}` takes {}, not {value}",
                path.join(" "),
                names.join(", ")
            ));
        }
    }
    None
}

/// Aliases the docs show being made (`g1t alias set …`) and then used.
const DOC_ALIASES: &[&str] = &["bugs", "co", "mine"];

/// Splits a command line at spaces outside quotes.
fn shell_words(line: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    for c in line.chars() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), c) if c == q => quote = None,
            (None, ' ' | '\t') => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            }
            (_, c) => word.push(c),
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

#[cfg(test)]
mod tests {
    /// Every `g1t …` command in the docs is one the CLI has, with flags it takes.
    #[test]
    fn docs_name_real_commands_and_flags() {
        // The docs, and the plugins' skills, commands and instructions.
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let mut pages: Vec<std::path::PathBuf> =
            ["apps/docs/src/content/docs", "plugins", "README.md"]
                .iter()
                .map(|p| std::path::Path::new(root).join(p))
                .collect();
        let mut problems = Vec::new();
        let mut checked = 0;
        while let Some(path) = pages.pop() {
            if path.is_dir() {
                pages.extend(std::fs::read_dir(&path).unwrap().map(|e| e.unwrap().path()));
                continue;
            }
            let name = path.to_string_lossy().replace('\\', "/");
            // The reference is written from the CLI itself, and the note on
            // issues becoming work items names the commands that went.
            if !(name.ends_with(".md") || name.ends_with(".mdx"))
                || name.ends_with("reference/cli.md")
                || name.ends_with("about/issues-became-work-items.md")
            {
                continue;
            }
            let page = std::fs::read_to_string(&path).unwrap();
            for line in super::command_lines(&page) {
                checked += 1;
                if let Some(problem) = super::wrong(&line) {
                    let short = name
                        .split("content/docs/")
                        .last()
                        .unwrap_or(&name)
                        .to_owned();
                    problems.push(format!("{short}: {line}: {problem}"));
                }
            }
        }
        assert!(checked > 100, "found only {checked} command lines");
        assert!(
            problems.is_empty(),
            "commands the CLI does not have:\n{}",
            problems.join("\n")
        );
    }

    #[test]
    fn a_wrong_command_or_flag_is_found() {
        assert_eq!(super::wrong("g1t session start --harness codex"), None);
        assert_eq!(super::wrong("g1t pr create --item N --draft --fill"), None);
        assert!(super::wrong("g1t issue list").is_some());
        assert!(super::wrong("g1t session pause").is_some());
        assert!(super::wrong("g1t session start --hearbeat").is_some());
        assert!(super::wrong("g1t session start --harness claude-managed-agents").is_some());
        assert_eq!(super::wrong("g1t session log --kind tool-call x"), None);
        assert_eq!(
            super::wrong("g1t session start --harness=claude_code"),
            None
        );
        assert_eq!(super::wrong("g1t / deploy"), None, "not a command");
        assert_eq!(super::wrong("g1t co 12"), None, "an alias is not checked");
        assert_eq!(
            super::command_lines(
                "Run `g1t work claim 12 --note x` and\n```sh\n$ g1t pr view | head\n```"
            ),
            vec!["g1t work claim 12 --note x", "g1t pr view"]
        );
    }

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
