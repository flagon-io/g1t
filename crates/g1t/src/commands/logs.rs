//! `g1t logs`: a project's log lines, or its errors grouped.

use serde_json::Value;
use std::time::Duration;

use crate::cli::LogsArgs;
use crate::client::Client;
use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::output::{Cell, Output, s};
use crate::repo::Repo;

/// `15m`, `2h`, `1d`, `1w` as Unix milliseconds that long ago; anything
/// else (an RFC 3339 time) as it is.
pub fn since(text: &str, now_ms: i64) -> String {
    let text = text.trim();
    let (number, unit) = text.split_at(text.find(|c: char| !c.is_ascii_digit()).unwrap_or(text.len()));
    let secs = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86_400,
        "w" => 604_800,
        _ => return text.to_owned(),
    };
    match number.parse::<i64>() {
        Ok(n) => (now_ms - n * secs * 1000).to_string(),
        Err(_) => text.to_owned(),
    }
}

/// `2026-10-12 09:01:02` (UTC) for microseconds since 1970.
pub fn clock(time_us: i64) -> String {
    let secs = time_us.div_euclid(1_000_000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// The workspace and project: --project (SLUG or WORKSPACE/SLUG), or the
/// current repository's project.
fn project(ctx: &Ctx, args: &LogsArgs) -> Result<(String, String, Client)> {
    resolve_project(ctx, args.project.as_deref())
}

/// The workspace and slug of a project given as WORKSPACE/SLUG, as a SLUG
/// in the current repository's workspace, or, when left out, the current
/// repository's own project.
pub(crate) fn resolve_project(ctx: &Ctx, given: Option<&str>) -> Result<(String, String, Client)> {
    if let Some(p) = given
        && let Some((w, slug)) = p.split_once('/')
    {
        return Ok((w.to_owned(), slug.to_owned(), ctx.signed_in_client()?));
    }
    let (repo, client) = ctx.repo_client()?;
    if let Some(slug) = given {
        return Ok((repo.owner.clone(), slug.to_owned(), client));
    }
    let (workspace, slug) = project_of(&client, &repo)?;
    Ok((workspace, slug, client))
}

/// The project whose repository this is. A repository moved to another
/// workspace answers to its old name, so the projects are looked up where
/// it is now.
fn project_of(client: &Client, repo: &Repo) -> Result<(String, String)> {
    let found = client.op("get_repo").repo(repo).send()?;
    let here = Repo {
        host: repo.host.clone(),
        owner: found["namespace"].as_str().unwrap_or(&repo.owner).to_owned(),
        name: found["name"].as_str().unwrap_or(&repo.name).to_owned(),
    };
    let projects = super::items(client.op("list_projects").arg("workspace", &here.owner).send()?, "projects");
    let full = here.to_string();
    let mine: Vec<&Value> = projects.iter().filter(|p| s(p, "repository").eq_ignore_ascii_case(&full)).collect();
    let pick = mine.iter().find(|p| p["primary"] == true).or(mine.first());
    match pick {
        Some(p) => Ok((here.owner.clone(), s(p, "slug").to_owned())),
        None => {
            Err(Error::failed(format!("{here} has no deployments or logs of its own. Name a repository with --project WORKSPACE/NAME.")))
        }
    }
}

fn print_lines(out: &Output, lines: &[Value]) -> Result<()> {
    if !out.tty {
        for l in lines {
            let attrs = serde_json::to_string(&l["attributes"]).unwrap_or_default();
            println!(
                "{}\t{}\t{}\t{}\t{}",
                clock(l["time_us"].as_i64().unwrap_or(0)),
                s(l, "severity"),
                s(l, "service"),
                s(l, "body").replace('\n', "\\n"),
                attrs
            );
        }
        return Ok(());
    }
    for l in lines {
        let sev = s(l, "severity");
        let painted = match sev {
            "error" | "fatal" => out.red(sev),
            "warn" => out.yellow(sev),
            "debug" | "trace" => out.dim(sev),
            _ => out.cyan(sev),
        };
        let pad = " ".repeat(5usize.saturating_sub(sev.len()));
        println!("{} {painted}{pad} {} {}", out.dim(&clock(l["time_us"].as_i64().unwrap_or(0))), out.dim(s(l, "service")), s(l, "body"));
    }
    Ok(())
}

pub fn run(ctx: &Ctx, args: LogsArgs) -> Result<()> {
    let (workspace, slug, client) = project(ctx, &args)?;
    let now_ms = crate::output::now() * 1000;
    let from = args.since.as_deref().map(|t| since(t, now_ms));
    if args.errors {
        let found = client
            .op("list_errors")
            .arg("workspace", &workspace)
            .arg("project", &slug)
            .query_opt("state", args.state.clone())
            .query_opt("environment", args.env.clone())
            .query_opt("service", args.service.clone())
            .query_opt("from", from)
            .send()?;
        let mut errors = super::items(found, "errors");
        errors.truncate(args.limit);
        if ctx.out.structured() {
            return ctx.out.emit(&Value::Array(errors));
        }
        if errors.is_empty() {
            eprintln!("No errors in {workspace}/{slug}.");
            return Ok(());
        }
        let out = &ctx.out;
        let rows: Vec<Vec<Cell>> = errors
            .iter()
            .map(|e| {
                vec![
                    Cell::new(e["count"].to_string()),
                    Cell::styled(
                        format!("{}: {}", s(e, "name"), s(e, "message")),
                        format!("{}: {}", out.red(s(e, "name")), s(e, "message")),
                    ),
                    Cell::new(format!("{} {}", s(e, "service"), s(e, "environment"))),
                    Cell::styled(s(e, "state"), out.state(s(e, "state"))),
                    Cell::new(clock(e["last_us"].as_i64().unwrap_or(0))),
                    Cell::styled(s(e, "fingerprint"), out.dim(s(e, "fingerprint"))),
                ]
            })
            .collect();
        return out.table(&["count", "error", "where", "state", "last seen", "fingerprint"], &rows);
    }
    let fetch = |from: Option<String>, limit: usize| -> Result<Vec<Value>> {
        let found = client
            .op("list_logs")
            .arg("workspace", &workspace)
            .arg("project", &slug)
            .query_opt("q", args.query.clone())
            .query_opt("level", args.level.clone())
            .query_opt("environment", args.env.clone())
            .query_opt("service", args.service.clone())
            .query_opt("from", from)
            .query("limit", limit.clamp(1, 1000))
            .send()?;
        Ok(super::items(found, "items"))
    };
    let mut lines = fetch(from, args.limit)?;
    lines.truncate(args.limit);
    // Newest first from the API; oldest first reads like a log.
    lines.reverse();
    if ctx.out.structured() && !args.follow {
        return ctx.out.emit(&Value::Array(lines));
    }
    let emit = |batch: &[Value]| -> Result<()> {
        if ctx.out.structured() {
            for l in batch {
                ctx.out.emit(l)?;
            }
            Ok(())
        } else {
            print_lines(&ctx.out, batch)
        }
    };
    emit(&lines)?;
    if !args.follow {
        if lines.is_empty() && !ctx.out.structured() {
            eprintln!(
                "No log lines in {workspace}/{slug}{}.",
                args.since.as_deref().map(|s| format!(" in the last {s}")).unwrap_or_default()
            );
        }
        return Ok(());
    }
    let mut last_us = lines.iter().filter_map(|l| l["time_us"].as_i64()).max().unwrap_or(now_ms * 1000);
    let mut seen: std::collections::HashSet<String> = lines.iter().map(|l| s(l, "id").to_owned()).collect();
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let mut batch = fetch(Some((last_us / 1000).to_string()), 200)?;
        batch.retain(|l| seen.insert(s(l, "id").to_owned()));
        batch.reverse();
        if let Some(max) = batch.iter().filter_map(|l| l["time_us"].as_i64()).max() {
            last_us = last_us.max(max);
        }
        emit(&batch)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_become_times() {
        assert_eq!(since("15m", 1_000_000_000), (1_000_000_000 - 900_000).to_string());
        assert_eq!(since("2h", 10_000_000_000), (10_000_000_000i64 - 7_200_000).to_string());
        assert_eq!(since("2026-10-12T09:00:00Z", 0), "2026-10-12T09:00:00Z");
    }

    #[test]
    fn clocks_read_in_utc() {
        assert_eq!(clock(0), "1970-01-01 00:00:00");
        assert_eq!(clock(1_790_877_851_000_000), "2026-10-01 18:04:11");
    }
}
