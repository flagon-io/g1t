//! `g1t why PATH[:LINE]`: why a file or a line is as it is. The line's
//! commit (by blame), the pull request that merged it, the issue that pull
//! request was for, and the decisions and sessions recorded on them.

use serde_json::Value;

use crate::cli::WhyArgs;
use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::output::{ago, s};

/// `src/app.rs:42` as the path and the line; a path alone has no line.
pub fn split_target(target: &str) -> (String, Option<u64>) {
    if let Some((path, line)) = target.rsplit_once(':')
        && !path.is_empty()
        && let Ok(line) = line.parse::<u64>()
    {
        return (path.to_owned(), Some(line));
    }
    (target.to_owned(), None)
}

/// A path given from inside the working copy as the repository's path for
/// it: `prefix` is where the current directory is (`git rev-parse
/// --show-prefix`), and `..` and `.` are resolved.
pub fn repo_path(prefix: &str, given: &str) -> Result<String> {
    let given = given.replace('\\', "/");
    let start = if given.starts_with('/') { "" } else { prefix };
    let mut parts: Vec<&str> = Vec::new();
    for part in start.split('/').chain(given.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(Error::usage(format!("{given} is outside the repository.")));
                }
            }
            part => parts.push(part),
        }
    }
    if parts.is_empty() {
        return Err(Error::usage("Name a file: g1t why PATH[:LINE]."));
    }
    Ok(parts.join("/"))
}

pub fn run(ctx: &Ctx, args: WhyArgs) -> Result<()> {
    let (given, line) = split_target(&args.target);
    // From inside a working copy, a path is relative to where you are.
    let prefix = if ctx.global.repo.is_none() {
        crate::git::run(&["rev-parse", "--show-prefix"]).unwrap_or_default()
    } else {
        String::new()
    };
    let path = repo_path(&prefix, &given)?;
    let (repo, client) = super::coordination_client(ctx, super::QUICK)?;
    let found = client
        .op("why")
        .repo(&repo)
        .query("path", &path)
        .query_opt("line", line)
        .query_opt("ref", args.reference.clone())
        .send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    let out = &ctx.out;
    let place = match line {
        Some(line) => format!("{path}:{line}"),
        None => path.clone(),
    };
    println!("{}", out.bold(&place));
    let commit = &found["commit"];
    if commit.is_object() {
        let sha = commit["sha"].as_str().or_else(|| commit["id"].as_str()).unwrap_or("");
        let message = commit["message"].as_str().or_else(|| commit["subject"].as_str()).unwrap_or("");
        let who = commit["author"]["name"]
            .as_str()
            .or_else(|| commit["author"]["username"].as_str())
            .or_else(|| commit["author"].as_str())
            .unwrap_or("");
        let when = commit["date"]
            .as_str()
            .or_else(|| commit["author"]["date"].as_str())
            .map(ago)
            .unwrap_or_default();
        println!(
            "  {} {} {}",
            out.dim("Commit "),
            out.yellow(sha.get(..12).unwrap_or(sha)),
            message.lines().next().unwrap_or("")
        );
        let by = [who.to_owned(), when].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(", ");
        if !by.is_empty() {
            println!("          {}", out.dim(&by));
        }
    } else if let Some(sha) = commit.as_str() {
        println!("  {} {}", out.dim("Commit "), out.yellow(sha.get(..12).unwrap_or(sha)));
    }
    let item = |label: &str, value: &Value| {
        if let Some(number) = value["number"].as_u64().or_else(|| value.as_u64()) {
            let status = value["status"].as_str().or_else(|| value["state"].as_str()).unwrap_or("");
            println!("  {} #{number} {} {}", out.dim(label), s(value, "title"), out.state(status));
        }
    };
    item("Pull   ", &found["pull"]);
    item("Issue  ", &found["issue"]);
    if found["pull"].is_null() && found["issue"].is_null() {
        println!("  {}", out.dim("No pull request merged this line; it came in a push."));
    }
    let decisions = found["decisions"].as_array().cloned().unwrap_or_default();
    if !decisions.is_empty() {
        println!();
        println!("{}", out.bold("Decisions"));
        for decision in &decisions {
            println!("  {}", super::work::decision_line(out, decision));
        }
    }
    let sessions = found["sessions"].as_array().cloned().unwrap_or_default();
    if !sessions.is_empty() {
        println!();
        println!("{}", out.bold("Sessions"));
        for session in &sessions {
            println!(
                "  {} {} {}{}",
                s(session, "id"),
                super::login_of(session),
                out.dim(s(session, "harness")),
                session["title"].as_str().map(|t| format!(": {t}")).unwrap_or_default()
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_take_a_line() {
        assert_eq!(split_target("src/app.rs:42"), ("src/app.rs".into(), Some(42)));
        assert_eq!(split_target("src/app.rs"), ("src/app.rs".into(), None));
        assert_eq!(split_target("notes:todo"), ("notes:todo".into(), None));
        assert_eq!(split_target("C:\\code\\a.rs:3"), ("C:\\code\\a.rs".into(), Some(3)));
    }

    #[test]
    fn paths_are_the_repositorys() {
        assert_eq!(repo_path("crates/g1t/", "src/main.rs").unwrap(), "crates/g1t/src/main.rs");
        assert_eq!(repo_path("crates/g1t/", "../kit/src/lib.rs").unwrap(), "crates/kit/src/lib.rs");
        assert_eq!(repo_path("", ".\\src\\app.rs").unwrap(), "src/app.rs");
        assert_eq!(repo_path("docs/", "/README.md").unwrap(), "README.md");
        assert!(repo_path("", "../x").is_err());
        assert!(repo_path("", ".").is_err());
    }
}
