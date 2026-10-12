//! `g1t pr`.

use serde_json::{Value, json};
use std::io::Write;
use std::time::{Duration, Instant};

use crate::cli::{
    CommentArgs, PrCheckoutArgs, PrChecksArgs, PrCommand, PrCreateArgs, PrDiffArgs, PrListArgs,
    PrMergeArgs, PrReadyArgs, PrReviewArgs, PrSelect, PrState, PrViewArgs,
};
use crate::client::Client;
use crate::context::Ctx;
use crate::error::{Error, Kind, Result};
use crate::git;
use crate::output::{Cell, Output, ago, elapsed, s};
use crate::prompt;
use crate::repo::{self, Repo};

pub fn run(ctx: &Ctx, command: PrCommand) -> Result<()> {
    match command {
        PrCommand::List(args) => list(ctx, args),
        PrCommand::View(args) => view(ctx, args),
        PrCommand::Create(args) => create(ctx, args),
        PrCommand::Checkout(args) => checkout(ctx, args),
        PrCommand::Diff(args) => diff(ctx, args),
        PrCommand::Checks(args) => checks(ctx, args),
        PrCommand::Review(args) => review(ctx, args),
        PrCommand::Merge(args) => merge(ctx, args),
        PrCommand::Ready(args) => ready(ctx, args),
        PrCommand::Comment(args) => comment(ctx, args),
        PrCommand::Close(args) => close(ctx, args, true),
        PrCommand::Reopen(args) => close(ctx, args, false),
    }
}

pub fn pull_url(site: &str, repo: &Repo, number: u64) -> String {
    format!("{site}/{}/{}/pull/{number}", repo.owner, repo.name)
}

/// Where a pull request's changes come from: its branch, or its working copy.
fn head_label(p: &Value) -> String {
    match (
        p["branch"].as_str(),
        p["fork"]["namespace"].as_str(),
        p["fork"]["name"].as_str(),
    ) {
        (Some(b), _, _) => b.to_owned(),
        (None, Some(ns), Some(name)) => format!("{ns}/{name}"),
        _ => String::new(),
    }
}

/// The pull request's number: the one given, or the current branch's.
pub fn number(ctx: &Ctx, client: &Client, repo: &Repo, given: Option<u64>) -> Result<u64> {
    if let Some(n) = given {
        return Ok(n);
    }
    // In a pull request's working copy, it is that pull request.
    let copy = ctx
        .repo()
        .ok()
        .and_then(|r| r.pull_copy().map(str::to_owned));
    let branch = git::current_branch();
    if copy.is_none() && branch.is_none() {
        return Err(Error::usage(
            "Which pull request? Give its number; HEAD is not on a branch.",
        ));
    }
    let found = client
        .op("list_pull_requests")
        .repo(repo)
        .query("state", "open")
        .send()?;
    let pulls = super::items(found, "pulls");
    let hit = pulls.iter().find(|p| match &copy {
        Some(id) => p["id"].as_str() == Some(id) || p["fork"]["name"].as_str() == Some(id),
        None => p["branch"].as_str() == branch.as_deref(),
    });
    match hit.and_then(|p| p["number"].as_u64()) {
        Some(n) => Ok(n),
        None => Err(Error::failed(format!(
            "No open pull request for the branch {}. Give its number, or open one with `g1t pr create`.",
            branch.unwrap_or_default()
        ))),
    }
}

/// The pull request, with its comments and the issue it is for.
fn get(client: &Client, repo: &Repo, number: u64) -> Result<Value> {
    client
        .op("get_pull_request")
        .repo(repo)
        .arg("number", number)
        .send()
}

fn pull_of(found: &Value) -> Value {
    found.get("pull").cloned().unwrap_or_else(|| found.clone())
}

fn list(ctx: &Ctx, args: PrListArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let state = match args.state {
        PrState::Open => Some("open"),
        PrState::Closed | PrState::Merged => Some("closed"),
        PrState::All => None,
    };
    let found = client
        .op("list_pull_requests")
        .repo(&repo)
        .query_opt("state", state)
        .query_opt("label", args.label.clone())
        .query_opt("base", args.base.clone())
        .send()?;
    let mut pulls = super::items(found, "pulls");
    if args.state == PrState::Merged {
        pulls.retain(|p| p["status"] == "merged");
    }
    if args.draft {
        pulls.retain(|p| p["status"] == "draft");
    }
    if let Some(a) = &args.author {
        let who = super::who(ctx, &client, a)?;
        pulls.retain(|p| {
            p["author"]["username"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(&who))
        });
    }
    pulls.truncate(args.limit);
    if ctx.out.structured() {
        return ctx.out.emit(&Value::Array(pulls));
    }
    if pulls.is_empty() {
        eprintln!("No matching pull requests in {repo}.");
        return Ok(());
    }
    print_list(&ctx.out, &pulls)
}

pub fn print_list(out: &Output, pulls: &[Value]) -> Result<()> {
    let rows: Vec<Vec<Cell>> = pulls
        .iter()
        .map(|p| {
            let number = format!("#{}", p["number"]);
            let status = s(p, "status");
            let checks = s(p, "check_status");
            vec![
                Cell::styled(
                    number.clone(),
                    if status == "open" {
                        out.green(&number)
                    } else {
                        out.dim(&number)
                    },
                ),
                Cell::new(s(p, "title")),
                Cell::styled(head_label(p), out.cyan(&head_label(p))),
                Cell::styled(status, out.state(status)),
                Cell::styled(checks, out.state(checks)),
                Cell::styled(ago(s(p, "updated_at")), out.dim(&ago(s(p, "updated_at")))),
            ]
        })
        .collect();
    out.table(
        &["number", "title", "branch", "status", "checks", "updated"],
        &rows,
    )
}

fn view(ctx: &Ctx, args: PrViewArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let n = number(ctx, &client, &repo, args.number)?;
    let url = pull_url(&client.host.site, &repo, n);
    if args.web {
        return super::browse::open(ctx, &url);
    }
    let found = get(&client, &repo, n)?;
    let mut pull = pull_of(&found);
    if let Some(map) = pull.as_object_mut() {
        map.insert(
            "comments".into(),
            found.get("comments").cloned().unwrap_or(json!([])),
        );
        map.insert("url".into(), Value::String(url.clone()));
    }
    if ctx.out.structured() {
        return ctx.out.emit(&pull);
    }
    let out = &ctx.out;
    println!(
        "{} {}",
        out.bold(s(&pull, "title")),
        out.dim(&format!("{repo}#{n}"))
    );
    let mut facts = vec![
        out.state(s(&pull, "status")),
        format!(
            "by {} {}",
            s(&pull["author"], "username"),
            ago(s(&pull, "created_at"))
        ),
        format!("{} ← {}", s(&pull, "base"), out.cyan(&head_label(&pull))),
    ];
    if let Some(c) = pull["check_status"].as_str() {
        facts.push(format!("checks {}", out.state(c)));
    }
    println!("{}", facts.join(" · "));
    if let Some(issue) = pull["issue"].as_u64() {
        println!("{} #{issue}", out.dim("For:"));
    }
    let reviewers: Vec<String> = pull["reviewers"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(pull["team_reviewers"].as_array().into_iter().flatten())
        .filter_map(|r| r.as_str().map(str::to_owned))
        .collect();
    if !reviewers.is_empty() {
        println!("{} {}", out.dim("Reviewers:"), reviewers.join(", "));
    }
    if let Some(files) = pull["files"].as_array().filter(|f| !f.is_empty()) {
        let adds: u64 = files.iter().filter_map(|f| f["additions"].as_u64()).sum();
        let dels: u64 = files.iter().filter_map(|f| f["deletions"].as_u64()).sum();
        println!(
            "{} {} file(s), {} {}",
            out.dim("Changes:"),
            files.len(),
            out.green(&format!("+{adds}")),
            out.red(&format!("-{dels}"))
        );
    }
    println!();
    match pull["body"].as_str().filter(|b| !b.trim().is_empty()) {
        Some(b) => println!("{}", b.trim_end()),
        None => println!("{}", out.dim("No description.")),
    }
    let comments = pull["comments"]
        .as_array()
        .map(|c| c.iter().filter(|c| c["kind"] == "comment").count())
        .unwrap_or(0);
    if args.comments {
        super::issue::print_comments(out, &pull["comments"]);
    } else if comments > 0 {
        println!();
        println!(
            "{}",
            out.dim(&format!(
                "{comments} comment(s): g1t pr view {n} --comments"
            ))
        );
    }
    println!();
    println!("{}", out.dim(&url));
    Ok(())
}

/// The remote that is `repo`, in this clone.
fn remote_for(repo: &Repo) -> Option<String> {
    git::remotes()
        .into_iter()
        .find(|(_, url)| {
            repo::parse_remote(url).is_some_and(|r| {
                r.owner.eq_ignore_ascii_case(&repo.owner) && r.name.eq_ignore_ascii_case(&repo.name)
            })
        })
        .map(|(name, _)| name)
}

/// A title and body from the branch's commits.
pub fn fill(commits: &[(String, String)], branch: &str) -> (String, String) {
    match commits {
        [(subject, body)] => (subject.clone(), body.clone()),
        [] => (humanize(branch), String::new()),
        many => {
            let body = many
                .iter()
                .map(|(s, _)| format!("- {s}"))
                .collect::<Vec<_>>()
                .join("\n");
            (humanize(branch), body)
        }
    }
}

fn humanize(branch: &str) -> String {
    let words = branch
        .rsplit('/')
        .next()
        .unwrap_or(branch)
        .replace(['-', '_'], " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn create(ctx: &Ctx, args: PrCreateArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let default = super::repo::default_branch(&client, &repo)?;
    let head = args.head.clone().or_else(git::current_branch);
    let on_default = head
        .as_deref()
        .is_none_or(|h| h == default || Some(h) == args.base.as_deref());
    let body_given = prompt::body(
        args.body.body.clone(),
        args.body.body_file.as_deref(),
        false,
    )?;

    // For an issue, with no branch of its own: a draft with a working copy.
    if on_default {
        let Some(issue) = args.issue else {
            return Err(Error::usage(format!(
                "You are on {}. Make a branch with your changes, or pass --issue N to start a pull request in a working copy of its own.",
                head.unwrap_or(default)
            )));
        };
        let made = client
            .op("create_pull_request")
            .repo(&repo)
            .field("issue", issue)
            .field_opt("title", args.title.clone())
            .field_opt("body", body_given)
            .field_opt("base", args.base.clone())
            .send()?;
        let pull = pull_of(&made);
        let n = pull["number"].as_u64().unwrap_or_default();
        if ctx.out.structured() {
            return ctx.out.emit(&made);
        }
        let remote = s(&made["git"], "remote");
        eprintln!(
            "{} Started draft {repo}#{n} for #{issue}.",
            ctx.out.green("✓")
        );
        eprintln!("  Its working copy: {remote}");
        eprintln!("  Push your commits there, then: g1t pr ready {n} --summary '...'");
        println!("{}", pull_url(&client.host.site, &repo, n));
        return Ok(());
    }
    let head = head.unwrap_or_default();
    let remote = remote_for(&repo);
    if !args.no_push {
        let Some(remote) = &remote else {
            return Err(Error::usage(format!(
                "No remote here is {repo}, so the branch cannot be pushed. Push it yourself and pass --no-push."
            )));
        };
        eprintln!("Pushing {head} to {remote}...");
        let refspec = format!("HEAD:refs/heads/{head}");
        let pushed = if git::current_branch().as_deref() == Some(head.as_str()) {
            git::run(&["push", "--set-upstream", remote, &refspec])
        } else {
            git::run(&[
                "push",
                remote,
                &format!("refs/heads/{head}:refs/heads/{head}"),
            ])
        };
        pushed?;
    }
    let base = args.base.clone().unwrap_or_else(|| default.clone());
    let (mut title, mut body) = (args.title.clone(), body_given);
    if args.fill || (title.is_none() && !prompt::interactive()) {
        let upstream = remote
            .as_deref()
            .map(|r| format!("{r}/{base}"))
            .filter(|r| git::ok(&["rev-parse", "--verify", "--quiet", r]));
        let commits = git::commits_between(upstream.as_deref().unwrap_or(&base), &head);
        let (t, b) = fill(&commits, &head);
        title = title.or(Some(t));
        if body.is_none() && !b.is_empty() {
            body = Some(b);
        }
    }
    let title = match title {
        Some(t) => t,
        None => prompt::input("Title:", Some(&humanize(&head)))?,
    };
    if body.is_none() && prompt::interactive() && !ctx.out.structured() {
        body = prompt::body(None, None, true)?;
    }
    let made = client
        .op("create_pull_request")
        .repo(&repo)
        .field("branch", head.clone())
        .field("title", title)
        .field_opt("body", body)
        .field_opt("base", args.base.clone())
        .field_opt("issue", args.issue)
        .send()?;
    let pull = pull_of(&made);
    let n = pull["number"].as_u64().unwrap_or_default();
    let pull = if args.draft {
        client
            .op("convert_pull_request_to_draft")
            .repo(&repo)
            .arg("number", n)
            .send()?
    } else {
        pull
    };
    super::issue::done(
        ctx,
        &pull,
        &format!("Opened {repo}#{n} from {head} into {base}"),
        &pull_url(&client.host.site, &repo, n),
    )
}

fn checkout(ctx: &Ctx, args: PrCheckoutArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let pull = pull_of(&get(&client, &repo, args.number)?);
    let n = args.number;
    if let Some(branch) = pull["branch"].as_str() {
        let remote =
            remote_for(&repo).ok_or_else(|| Error::usage(format!("No remote here is {repo}.")))?;
        let local = args.branch.clone().unwrap_or_else(|| branch.to_owned());
        let tracking = format!("refs/remotes/{remote}/{branch}");
        git::run(&[
            "fetch",
            &remote,
            &format!("+refs/heads/{branch}:{tracking}"),
        ])?;
        if git::ok(&[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{local}"),
        ]) {
            git::run(&["checkout", &local])?;
            if args.force {
                git::run(&["reset", "--hard", &tracking])?;
            } else {
                git::run(&["merge", "--ff-only", &tracking])?;
            }
        } else {
            git::run(&[
                "checkout",
                "-b",
                &local,
                "--track",
                &format!("{remote}/{branch}"),
            ])?;
        }
        eprintln!("{} On {local}, at #{n}'s head.", ctx.out.green("✓"));
        return Ok(());
    }
    // A working copy of its own: fetch its head from there, or from the
    // repository once the copy is gone.
    let id = s(&pull, "id").to_owned();
    let copy = format!(
        "{}/{}/{}.git",
        client.host.site,
        s(&pull["fork"], "namespace"),
        s(&pull["fork"], "name")
    );
    let local = args.branch.clone().unwrap_or_else(|| format!("pr-{n}"));
    let fetched = pull["fork"].is_object() && git::run(&["fetch", &copy, "HEAD"]).is_ok();
    if !fetched {
        let remote =
            remote_for(&repo).ok_or_else(|| Error::usage(format!("No remote here is {repo}.")))?;
        git::run(&["fetch", &remote, &format!("refs/pull/{id}/head")])?;
    }
    let exists = git::ok(&[
        "rev-parse",
        "--verify",
        "--quiet",
        &format!("refs/heads/{local}"),
    ]);
    if exists && !args.force {
        git::run(&["checkout", &local])?;
        git::run(&["merge", "--ff-only", "FETCH_HEAD"])?;
    } else {
        git::run(&["checkout", "-B", &local, "FETCH_HEAD"])?;
    }
    eprintln!("{} On {local}, at #{n}'s head.", ctx.out.green("✓"));
    if fetched {
        let target = git::run(&["ls-remote", "--symref", &copy, "HEAD"])
            .ok()
            .and_then(|o| {
                o.lines().find_map(|l| {
                    l.strip_prefix("ref: refs/heads/")
                        .map(|r| r.split_whitespace().next().unwrap_or("main").to_owned())
                })
            })
            .unwrap_or_else(|| "main".to_owned());
        eprintln!("  Push to it with: git push {copy} HEAD:{target}");
    }
    Ok(())
}

/// The changes as a unified diff.
pub fn render_diff(changes: &Value, out: &Output, color: bool, name_only: bool) -> String {
    let paint = |code: &str, t: &str| {
        if color {
            out.paint(code, t)
        } else {
            t.to_owned()
        }
    };
    let mut text = String::new();
    for file in changes["files"].as_array().into_iter().flatten() {
        let path = s(file, "path");
        if name_only {
            text.push_str(path);
            text.push('\n');
            continue;
        }
        let old = file["old_path"]
            .as_str()
            .or(file["previous_path"].as_str())
            .unwrap_or(path);
        let status = s(file, "status");
        text.push_str(&paint("1", &format!("diff --git a/{old} b/{path}")));
        text.push('\n');
        if file["binary"] == true {
            text.push_str(&format!("Binary files a/{old} and b/{path} differ\n"));
            continue;
        }
        let (a, b) = match status {
            "added" => ("/dev/null".to_owned(), format!("b/{path}")),
            "deleted" | "removed" => (format!("a/{old}"), "/dev/null".to_owned()),
            _ => (format!("a/{old}"), format!("b/{path}")),
        };
        text.push_str(&paint("1", &format!("--- {a}\n+++ {b}")));
        text.push('\n');
        for hunk in file["hunks"].as_array().into_iter().flatten() {
            let lines = hunk["lines"].as_array().cloned().unwrap_or_default();
            let old_start = lines.iter().find_map(|l| l["old"].as_u64()).unwrap_or(0);
            let new_start = lines.iter().find_map(|l| l["new"].as_u64()).unwrap_or(0);
            let old_count = lines.iter().filter(|l| l["kind"] != "add").count();
            let new_count = lines.iter().filter(|l| l["kind"] != "delete").count();
            text.push_str(&paint(
                "36",
                &format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@"),
            ));
            text.push('\n');
            for line in &lines {
                let body = s(line, "text");
                match s(line, "kind") {
                    "add" => text.push_str(&paint("32", &format!("+{body}"))),
                    "delete" => text.push_str(&paint("31", &format!("-{body}"))),
                    _ => text.push_str(&format!(" {body}")),
                }
                text.push('\n');
            }
        }
    }
    if changes["truncated"] == true {
        text.push_str("... the diff is longer than the API returns; see it on the site.\n");
    }
    text
}

fn diff(ctx: &Ctx, args: PrDiffArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let n = number(ctx, &client, &repo, args.number)?;
    let changes = client
        .op("get_pull_request_changes")
        .repo(&repo)
        .arg("number", n)
        .send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&changes);
    }
    let color = match args.color.as_str() {
        "always" => true,
        "never" => false,
        _ => ctx.out.color,
    };
    let mut stdout = std::io::stdout().lock();
    write!(
        stdout,
        "{}",
        render_diff(&changes, &ctx.out, color, args.name_only)
    )?;
    Ok(())
}

/// One check, a check run or a commit status, the same shape for both.
pub fn check_rows(runs: &Value, statuses: &Value) -> Vec<Value> {
    let mut rows = Vec::new();
    for r in runs["check_runs"].as_array().into_iter().flatten() {
        let name = match r["workflow"]["name"].as_str() {
            Some(w) => format!("{w} / {}", s(r, "name")),
            None => s(r, "name").to_owned(),
        };
        let state = if r["status"] == "completed" {
            s(r, "conclusion").to_owned()
        } else {
            s(r, "status").to_owned()
        };
        rows.push(json!({
            "name": name,
            "state": state,
            "bucket": bucket(&state),
            "started_at": r["started_at"],
            "completed_at": r["completed_at"],
            "url": r["html_url"].as_str().or(r["details_url"].as_str()),
            "kind": "check_run",
            "id": r["id"],
        }));
    }
    for st in statuses["statuses"].as_array().into_iter().flatten() {
        let state = s(st, "state").to_owned();
        rows.push(json!({
            "name": st["context"],
            "state": state,
            "bucket": bucket(&state),
            "started_at": Value::Null,
            "completed_at": st["updated_at"],
            "url": st["target_url"],
            "kind": "status",
            "description": st["description"],
        }));
    }
    rows
}

/// pass, fail, pending or skip.
pub fn bucket(state: &str) -> &'static str {
    match state {
        "success" | "neutral" => "pass",
        "skipped" => "skip",
        "failure" | "error" | "timed_out" | "cancelled" | "action_required" | "startup_failure"
        | "stale" => "fail",
        _ => "pending",
    }
}

fn count(rows: &[Value], b: &str) -> usize {
    rows.iter().filter(|r| r["bucket"] == b).count()
}

fn print_checks(out: &Output, rows: &[Value]) -> Result<()> {
    let table: Vec<Vec<Cell>> = rows
        .iter()
        .map(|r| {
            let state = s(r, "state");
            let mark = match s(r, "bucket") {
                "pass" => out.green("✓"),
                "fail" => out.red("X"),
                "skip" => out.dim("-"),
                _ => out.yellow("*"),
            };
            let took = elapsed(&r["started_at"], &r["completed_at"]);
            vec![
                Cell::styled(
                    format!("{} {}", plain_mark(s(r, "bucket")), s(r, "name")),
                    format!("{mark} {}", s(r, "name")),
                ),
                Cell::styled(state, out.state(state)),
                Cell::new(took),
                Cell::styled(s(r, "url"), out.dim(s(r, "url"))),
            ]
        })
        .collect();
    out.table(&["check", "state", "took", "url"], &table)
}

fn plain_mark(bucket: &str) -> &'static str {
    match bucket {
        "pass" => "✓",
        "fail" => "X",
        "skip" => "-",
        _ => "*",
    }
}

fn summary(rows: &[Value]) -> String {
    format!(
        "{} failing, {} pending, {} passing, {} skipped",
        count(rows, "fail"),
        count(rows, "pending"),
        count(rows, "pass"),
        count(rows, "skip")
    )
}

fn checks(ctx: &Ctx, args: PrChecksArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let n = number(ctx, &client, &repo, args.number)?;
    let started = Instant::now();
    let mut last_seen: std::collections::BTreeMap<String, String> = Default::default();
    loop {
        let pull = pull_of(&get(&client, &repo, n)?);
        let Some(sha) = pull["head_commit"].as_str().map(str::to_owned) else {
            if !args.watch {
                eprintln!("#{n} has no commits yet.");
                return Ok(());
            }
            std::thread::sleep(Duration::from_secs(args.interval));
            continue;
        };
        let runs = client
            .op("list_check_runs_for_ref")
            .repo(&repo)
            .arg("ref", &sha)
            .send()?;
        let statuses = client
            .op("get_combined_status")
            .repo(&repo)
            .arg("ref", &sha)
            .send()?;
        let rows = check_rows(&runs, &statuses);
        let failing = count(&rows, "fail");
        let pending = count(&rows, "pending");
        // Right after a push, runs take a moment to appear.
        let waiting_for_any =
            rows.is_empty() && args.watch && started.elapsed() < Duration::from_secs(120);
        let finished = !waiting_for_any && (pending == 0 || (args.fail_fast && failing > 0));
        if args.watch && !finished {
            if !ctx.out.structured() {
                if ctx.out.tty {
                    // Redraw in place.
                    print!("\x1b[2J\x1b[H");
                    println!(
                        "{} {}",
                        ctx.out.bold(&format!("Checks for #{n}")),
                        ctx.out.dim(&format!("at {}", &sha[..sha.len().min(7)]))
                    );
                    print_checks(&ctx.out, &rows)?;
                    println!();
                    println!("{}", summary(&rows));
                    let _ = std::io::stdout().flush();
                } else {
                    // Piped: a line for each check whose state changed.
                    for r in &rows {
                        let name = s(r, "name").to_owned();
                        let state = s(r, "state").to_owned();
                        if last_seen.get(&name) != Some(&state) {
                            println!("{}\t{}\t{}", name, state, s(r, "url"));
                            last_seen.insert(name, state);
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(args.interval));
            continue;
        }
        if ctx.out.structured() {
            ctx.out.emit(&Value::Array(rows.clone()))?;
        } else if rows.is_empty() {
            eprintln!(
                "No checks reported for #{n} at {}.",
                &sha[..sha.len().min(7)]
            );
        } else if args.watch && !ctx.out.tty {
            for r in &rows {
                let name = s(r, "name").to_owned();
                if last_seen.get(&name).map(String::as_str) != Some(s(r, "state")) {
                    println!("{}\t{}\t{}", name, s(r, "state"), s(r, "url"));
                }
            }
            eprintln!("{}", summary(&rows));
        } else {
            if args.watch && ctx.out.tty {
                print!("\x1b[2J\x1b[H");
            }
            print_checks(&ctx.out, &rows)?;
            if ctx.out.tty {
                println!();
                println!("{}", summary(&rows));
            } else {
                eprintln!("{}", summary(&rows));
            }
        }
        return if failing > 0 {
            Err(Error::exit(Kind::Failed))
        } else if pending > 0 {
            Err(Error::exit(Kind::Pending))
        } else {
            Ok(())
        };
    }
}

fn review(ctx: &Ctx, args: PrReviewArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let n = number(ctx, &client, &repo, args.number)?;
    let url = pull_url(&client.host.site, &repo, n);
    let body = prompt::body(
        args.body.body,
        args.body.body_file.as_deref(),
        args.comment || args.request_changes,
    )?;
    if args.comment {
        let text = body
            .filter(|b| !b.trim().is_empty())
            .ok_or_else(|| prompt::needed("The comment", "--body"))?;
        let made = client
            .op("add_comment")
            .repo(&repo)
            .arg("number", n)
            .field("body", text)
            .send()?;
        return super::issue::done(ctx, &made, &format!("Commented on {repo}#{n}"), &url);
    }
    let verdict = if args.approve {
        "approve"
    } else {
        "request_changes"
    };
    let made = client
        .op("review_pull_request")
        .repo(&repo)
        .arg("number", n)
        .field("verdict", verdict)
        .field_opt("body", body)
        .send()?;
    let said = if args.approve {
        "Approved"
    } else {
        "Asked for changes on"
    };
    super::issue::done(ctx, &made, &format!("{said} {repo}#{n}"), &url)
}

fn merge(ctx: &Ctx, args: PrMergeArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let n = number(ctx, &client, &repo, args.number)?;
    let mut call = client.op("merge_pull_request").repo(&repo).arg("number", n);
    if args.keep_issue_open {
        call = call.field("keep_issue_open", true);
    }
    if args.admin {
        call = call
            .field("ignore_checks", true)
            .field("bypass_rules", true);
    }
    let merged = call.send()?;
    let url = pull_url(&client.host.site, &repo, n);
    if args.delete_branch
        && let Some(branch) = merged["branch"].as_str()
    {
        client
            .op("delete_branch")
            .repo(&repo)
            .arg("branch", branch)
            .send()?;
        if git::current_branch().as_deref() != Some(branch) {
            let _ = git::run(&["branch", "-D", branch]);
        }
        eprintln!("{} Deleted the branch {branch}.", ctx.out.green("✓"));
    }
    super::issue::done(ctx, &merged, &format!("Merged {repo}#{n}"), &url)
}

fn ready(ctx: &Ctx, args: PrReadyArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let n = number(ctx, &client, &repo, args.number)?;
    let url = pull_url(&client.host.site, &repo, n);
    if args.undo {
        let pull = client
            .op("convert_pull_request_to_draft")
            .repo(&repo)
            .arg("number", n)
            .send()?;
        return super::issue::done(ctx, &pull, &format!("{repo}#{n} is a draft again"), &url);
    }
    let summary = match args.summary {
        Some(s) => s,
        None => {
            let pull = pull_of(&get(&client, &repo, n)?);
            match pull["body"].as_str().filter(|b| !b.trim().is_empty()) {
                Some(b) => b.to_owned(),
                None if prompt::interactive() => prompt::editor("")?,
                None => {
                    return Err(prompt::needed(
                        "A summary of what changed and why",
                        "--summary",
                    ));
                }
            }
        }
    };
    let pull = client
        .op("mark_pull_request_ready")
        .repo(&repo)
        .arg("number", n)
        .field("summary", summary)
        .send()?;
    super::issue::done(ctx, &pull, &format!("{repo}#{n} is ready for review"), &url)
}

fn comment(ctx: &Ctx, args: CommentArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let n = number(ctx, &client, &repo, args.number)?;
    let url = pull_url(&client.host.site, &repo, n);
    super::issue::comment_on(ctx, &client, &repo, n, args, &url)
}

fn close(ctx: &Ctx, args: PrSelect, closing: bool) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let n = number(ctx, &client, &repo, args.number)?;
    let id = if closing {
        "close_pull_request"
    } else {
        "reopen_pull_request"
    };
    let pull = client.op(id).repo(&repo).arg("number", n).send()?;
    let said = if closing { "Closed" } else { "Reopened" };
    super::issue::done(
        ctx,
        &pull,
        &format!("{said} {repo}#{n}"),
        &pull_url(&client.host.site, &repo, n),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_fill_from_commits() {
        let one = vec![("Trim the name".to_owned(), "Before greeting.".to_owned())];
        assert_eq!(
            fill(&one, "x"),
            ("Trim the name".to_owned(), "Before greeting.".to_owned())
        );
        let two = vec![
            ("a".to_owned(), String::new()),
            ("b".to_owned(), String::new()),
        ];
        assert_eq!(
            fill(&two, "ana/greet-by-name"),
            ("Greet by name".to_owned(), "- a\n- b".to_owned())
        );
        assert_eq!(fill(&[], "fix_typo").0, "Fix typo");
    }

    #[test]
    fn checks_fall_into_buckets() {
        let runs = json!({ "check_runs": [
            { "name": "lint", "status": "completed", "conclusion": "failure", "html_url": "u1" },
            { "name": "Test", "status": "in_progress", "conclusion": null, "workflow": { "name": "CI" } },
        ]});
        let statuses = json!({ "statuses": [{ "context": "ci/build", "state": "success", "target_url": "u3" }] });
        let rows = check_rows(&runs, &statuses);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["bucket"], "fail");
        assert_eq!(rows[1]["name"], "CI / Test");
        assert_eq!(rows[1]["bucket"], "pending");
        assert_eq!(rows[2]["bucket"], "pass");
        assert_eq!(summary(&rows), "1 failing, 1 pending, 1 passing, 0 skipped");
    }

    #[test]
    fn diffs_render_unified() {
        let changes = json!({ "files": [{ "path": "src/main.rs", "status": "modified", "binary": false, "hunks": [{ "lines": [
            { "kind": "context", "old": 3, "new": 3, "text": "fn main() {" },
            { "kind": "delete", "old": 4, "new": null, "text": "    old();" },
            { "kind": "add", "old": null, "new": 4, "text": "    new();" },
        ]}]}], "truncated": false });
        let text = render_diff(&changes, &Output::default(), false, false);
        assert_eq!(
            text,
            "diff --git a/src/main.rs b/src/main.rs\n--- a/src/main.rs\n+++ b/src/main.rs\n@@ -3,2 +3,2 @@\n fn main() {\n-    old();\n+    new();\n"
        );
        assert_eq!(
            render_diff(&changes, &Output::default(), false, true),
            "src/main.rs\n"
        );
    }
}
