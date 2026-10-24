//! `g1t alias`: shortcuts, kept in config.json and expanded before the
//! command line is read.

use clap::CommandFactory;

use crate::cli::{AliasCommand, Cli};
use crate::config::Config;
use crate::error::{Error, Kind, Result};

pub enum Expanded {
    Args(Vec<String>),
    /// A `!` alias ran in the shell, with this exit code.
    Ran(i32),
}

fn builtin(name: &str) -> bool {
    Cli::command().get_subcommands().any(|c| c.get_name() == name || c.get_all_aliases().any(|a| a == name)) || matches!(name, "help")
}

/// Splits `text` into words the way a shell would, quotes included.
pub fn split(text: &str) -> Result<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = text.chars();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') => {
                if let Some(next) = chars.next() {
                    word.push(next);
                }
            }
            (Some(_), c) => word.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                in_word = true;
            }
            (None, '\\') => {
                if let Some(next) = chars.next() {
                    word.push(next);
                    in_word = true;
                }
            }
            (None, c) if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            (None, c) => {
                word.push(c);
                in_word = true;
            }
        }
    }
    if quote.is_some() {
        return Err(Error::usage(format!("Unclosed quote in `{text}`.")));
    }
    if in_word {
        words.push(word);
    }
    Ok(words)
}

/// Puts `args` into `expansion`'s `$1`, `$2`...; the ones not used go after.
pub fn substitute(expansion: &[String], args: &[String]) -> Vec<String> {
    let mut used = vec![false; args.len()];
    let mut out: Vec<String> = expansion
        .iter()
        .map(|word| {
            let mut word = word.clone();
            for (i, arg) in args.iter().enumerate().rev() {
                let marker = format!("${}", i + 1);
                if word.contains(&marker) {
                    word = word.replace(&marker, arg);
                    used[i] = true;
                }
            }
            word
        })
        .collect();
    out.extend(args.iter().zip(&used).filter(|(_, u)| !**u).map(|(a, _)| a.clone()));
    out
}

pub fn expand(args: Vec<String>) -> Result<Expanded> {
    let Some(first) = args.get(1) else {
        return Ok(Expanded::Args(args));
    };
    if first.starts_with('-') || builtin(first) {
        return Ok(Expanded::Args(args));
    }
    let config = Config::load()?;
    let Some(expansion) = config.aliases.get(first) else {
        return Ok(Expanded::Args(args));
    };
    let rest = &args[2..];
    if let Some(shell_line) = expansion.strip_prefix('!') {
        let shell_args = substitute(&[shell_line.to_owned()], rest);
        let line = shell_args.join(" ");
        let status = std::process::Command::new("sh")
            .args(["-c", &line])
            .status()
            .map_err(|e| Error::failed(format!("Could not run the alias {first} in sh: {e}")))?;
        return Ok(Expanded::Ran(status.code().unwrap_or(1)));
    }
    let words = split(expansion)?;
    let mut out = vec![args[0].clone()];
    out.extend(substitute(&words, rest));
    Ok(Expanded::Args(out))
}

pub fn run(command: AliasCommand) -> Result<()> {
    let mut config = Config::load()?;
    match command {
        AliasCommand::Set(args) => {
            if builtin(&args.name) {
                return Err(Error::usage(format!("`{}` is already a g1t command.", args.name)));
            }
            if !args.expansion.starts_with('!') {
                let words = split(&args.expansion)?;
                match words.first() {
                    Some(first) if builtin(first) || config.aliases.contains_key(first) => {}
                    _ => {
                        return Err(Error::usage(format!(
                            "`{}` does not start with a g1t command. Start it with ! to run it in the shell.",
                            args.expansion
                        )));
                    }
                }
            }
            let replaced = config.aliases.insert(args.name.clone(), args.expansion.clone()).is_some();
            config.save()?;
            eprintln!("✓ {} {} now runs `g1t {}`.", if replaced { "Changed:" } else { "Added:" }, args.name, args.expansion);
            Ok(())
        }
        AliasCommand::List => {
            if config.aliases.is_empty() {
                eprintln!("No aliases. Add one: g1t alias set co 'pr checkout'");
                return Ok(());
            }
            for (name, expansion) in &config.aliases {
                println!("{name}: {expansion}");
            }
            Ok(())
        }
        AliasCommand::Delete(args) => {
            if config.aliases.remove(&args.name).is_none() {
                return Err(Error { kind: Kind::Failed, message: format!("No alias {}.", args.name), silent: false });
            }
            config.save()?;
            eprintln!("✓ Deleted the alias {}.", args.name);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(words: &[&str]) -> Vec<String> {
        words.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn words_split_like_a_shell() {
        assert_eq!(split("pr checkout").unwrap(), v(&["pr", "checkout"]));
        assert_eq!(split(r#"work list --label "good first issue""#).unwrap(), v(&["work", "list", "--label", "good first issue"]));
        assert_eq!(split("api '/repos/{owner}/{name}'").unwrap(), v(&["api", "/repos/{owner}/{name}"]));
        assert_eq!(split(r"a\ b c").unwrap(), v(&["a b", "c"]));
        assert_eq!(split("x ''").unwrap(), v(&["x", ""]));
        assert!(split("'open").is_err());
    }

    #[test]
    fn arguments_fill_their_places() {
        assert_eq!(substitute(&v(&["pr", "checkout"]), &v(&["12"])), v(&["pr", "checkout", "12"]));
        assert_eq!(
            substitute(&v(&["work", "list", "--label", "$1"]), &v(&["bug", "-L", "5"])),
            v(&["work", "list", "--label", "bug", "-L", "5"])
        );
    }

    #[test]
    fn commands_are_builtin() {
        assert!(builtin("pr"));
        assert!(builtin("help"));
        assert!(!builtin("co"));
    }
}
