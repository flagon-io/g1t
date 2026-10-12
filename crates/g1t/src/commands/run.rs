//! `g1t run`: workflow runs.

use serde_json::{Value, json};
use std::io::Write;
use std::time::Duration;

use crate::cli::{
    RunCommand, RunListArgs, RunLogsArgs, RunRerunArgs, RunSelect, RunViewArgs, RunWatchArgs,
};
use crate::client::Client;
use crate::context::Ctx;
use crate::error::{Error, Kind, Result};
use crate::output::{Cell, Output, ago, elapsed, s};
use crate::repo::Repo;

pub fn run(ctx: &Ctx, command: RunCommand) -> Result<()> {
    match command {
        RunCommand::List(args) => list(ctx, args),
        RunCommand::View(args) => view(ctx, args),
        RunCommand::Watch(args) => watch(ctx, args),
        RunCommand::Logs(args) => logs(ctx, args),
        RunCommand::Rerun(args) => rerun(ctx, args),
        RunCommand::Cancel(args) => cancel(ctx, args),
    }
}

pub fn run_url(site: &str, repo: &Repo, id: &str) -> String {
    format!("{site}/{}/{}/actions/runs/{id}", repo.owner, repo.name)
}

/// The state a run or job shows: its conclusion once complete.
fn state(v: &Value) -> &str {
    match v["status"].as_str() {
        Some("completed") => v["conclusion"].as_str().unwrap_or("completed"),
        Some(other) => other,
        None => v["conclusion"].as_str().unwrap_or(""),
    }
}

fn mark(out: &Output, state: &str) -> String {
    match super::pr::bucket(state) {
        "pass" => out.green("✓"),
        "fail" => out.red("X"),
        "skip" => out.dim("-"),
        _ => out.yellow("*"),
    }
}

/// The run's id: given as an id, a number or an address; or the current
/// branch's latest.
fn resolve(ctx: &Ctx, client: &Client, repo: &Repo, given: Option<&str>) -> Result<String> {
    if let Some(given) = given {
        let given = given.trim().trim_end_matches('/');
        let tail = given.rsplit('/').next().unwrap_or(given);
        let tail = tail.split(['?', '#']).next().unwrap_or(tail);
        if tail.starts_with("run_") {
            return Ok(tail.to_owned());
        }
        if let Ok(n) = tail.trim_start_matches('#').parse::<u64>() {
            let runs = super::items(
                client
                    .op("list_workflow_runs")
                    .repo(repo)
                    .query("per_page", 100)
                    .send()?,
                "workflow_runs",
            );
            return runs
                .iter()
                .find(|r| r["number"].as_u64() == Some(n))
                .and_then(|r| r["id"].as_str().map(str::to_owned))
                .ok_or_else(|| Error::failed(format!("No run #{n} among {repo}'s latest 100.")));
        }
        return Err(Error::usage(format!(
            "`{given}` is not a run: give its id (run_…) or number."
        )));
    }
    let branch = crate::git::current_branch();
    let mut call = client
        .op("list_workflow_runs")
        .repo(repo)
        .query("per_page", 1);
    if let Some(b) = &branch {
        call = call.query("branch", b);
    }
    let runs = super::items(call.send()?, "workflow_runs");
    let latest = match runs.first() {
        Some(r) => r.clone(),
        None if branch.is_some() => {
            let all = super::items(
                client
                    .op("list_workflow_runs")
                    .repo(repo)
                    .query("per_page", 1)
                    .send()?,
                "workflow_runs",
            );
            all.first()
                .cloned()
                .ok_or_else(|| Error::failed(format!("{repo} has no workflow runs.")))?
        }
        None => return Err(Error::failed(format!("{repo} has no workflow runs."))),
    };
    if !ctx.out.structured() || ctx.out.tty {
        eprintln!(
            "Run {} ({} #{} on {}, {})",
            s(&latest, "id"),
            s(&latest, "name"),
            latest["number"],
            branch_of(&latest),
            state(&latest)
        );
    }
    Ok(s(&latest, "id").to_owned())
}

fn branch_of(run: &Value) -> String {
    s(run, "ref")
        .trim_start_matches("refs/heads/")
        .trim_start_matches("refs/tags/")
        .to_owned()
}

fn list(ctx: &Ctx, args: RunListArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let found = client
        .op("list_workflow_runs")
        .repo(&repo)
        .query_opt("workflow", args.workflow.clone())
        .query_opt("branch", args.branch.clone())
        .query_opt("event", args.event.clone())
        .query_opt("head_sha", args.commit.clone())
        .query_opt("pull", args.pr)
        .query("per_page", args.limit.clamp(1, 100))
        .send()?;
    let mut runs = super::items(found, "workflow_runs");
    runs.truncate(args.limit);
    if ctx.out.structured() {
        return ctx.out.emit(&Value::Array(runs));
    }
    if runs.is_empty() {
        eprintln!("No workflow runs in {repo}.");
        return Ok(());
    }
    let out = &ctx.out;
    let rows: Vec<Vec<Cell>> = runs
        .iter()
        .map(|r| {
            let st = state(r);
            vec![
                Cell::styled(st, out.state(st)),
                Cell::new(s(r, "title")),
                Cell::new(format!("{} #{}", s(r, "name"), r["number"])),
                Cell::styled(branch_of(r), out.cyan(&branch_of(r))),
                Cell::new(s(r, "event")),
                Cell::styled(s(r, "id"), out.dim(s(r, "id"))),
                Cell::styled(ago(s(r, "created_at")), out.dim(&ago(s(r, "created_at")))),
            ]
        })
        .collect();
    out.table(
        &["state", "title", "workflow", "branch", "event", "id", "age"],
        &rows,
    )
}

fn get_run(client: &Client, repo: &Repo, id: &str) -> Result<Value> {
    client
        .op("get_workflow_run")
        .repo(repo)
        .arg("id", id)
        .send()
}

/// One object: the run, with its jobs, notes and attempts in it.
fn flatten(found: &Value, url: &str) -> Value {
    let mut run = found.get("run").cloned().unwrap_or_else(|| found.clone());
    if let Some(map) = run.as_object_mut() {
        for key in ["jobs", "notes", "attempts"] {
            map.insert(key.into(), found.get(key).cloned().unwrap_or(json!([])));
        }
        map.insert("url".into(), Value::String(url.to_owned()));
    }
    run
}

fn print_run(out: &Output, run: &Value, job_filter: Option<&str>) {
    let st = state(run);
    println!(
        "{} {} {} {}",
        mark(out, st),
        out.bold(&format!("{} #{}", s(run, "name"), run["number"])),
        s(run, "title"),
        out.dim(&format!(
            "· {} · {} · {} · {}",
            branch_of(run),
            s(run, "event"),
            elapsed(&run["started_at"], &run["finished_at"]),
            s(run, "actor")
        ))
    );
    if let Some(e) = run["error"].as_str() {
        println!("{} {e}", out.red("Error:"));
    }
    for job in run["jobs"].as_array().into_iter().flatten() {
        if job_filter.is_some_and(|f| !job_matches(job, f)) {
            continue;
        }
        let js = state(job);
        println!();
        println!(
            "{} {} {}",
            mark(out, js),
            out.bold(s(job, "name")),
            out.dim(&format!(
                "{} {}",
                js,
                elapsed(&job["started_at"], &job["finished_at"])
            ))
        );
        if let Some(reason) = job["reason"].as_str() {
            println!("  {}", out.dim(reason));
        }
        for step in job["steps"].as_array().into_iter().flatten() {
            let ss = state(step);
            println!("  {} {} {}", mark(out, ss), step["number"], s(step, "name"));
        }
        for a in job["annotations"].as_array().into_iter().flatten() {
            let place = match (a["file"].as_str(), a["line"].as_u64()) {
                (Some(f), Some(l)) => format!("{f}:{l}: "),
                (Some(f), None) => format!("{f}: "),
                _ => String::new(),
            };
            let level = s(a, "level");
            let painted = if level == "error" {
                out.red(level)
            } else {
                out.yellow(level)
            };
            println!("  {painted} {place}{}", s(a, "message"));
        }
    }
    for note in run["notes"].as_array().into_iter().flatten() {
        println!();
        println!("{} {}", out.yellow("Note:"), s(note, "message"));
    }
    println!();
    println!("{}", out.dim(s(run, "url")));
}

fn job_matches(job: &Value, wanted: &str) -> bool {
    ["id", "key", "name"].iter().any(|k| {
        job[*k]
            .as_str()
            .is_some_and(|v| v.eq_ignore_ascii_case(wanted))
    })
}

fn failed(run: &Value) -> bool {
    super::pr::bucket(state(run)) == "fail"
}

fn view(ctx: &Ctx, args: RunViewArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let id = resolve(ctx, &client, &repo, args.run.as_deref())?;
    let url = run_url(&client.host.site, &repo, &id);
    if args.web {
        return super::browse::open(ctx, &url);
    }
    let run = flatten(&get_run(&client, &repo, &id)?, &url);
    if ctx.out.structured() {
        ctx.out.emit(&run)?;
    } else {
        print_run(&ctx.out, &run, args.job.as_deref());
        if args.log || args.log_failed {
            println!();
            print_logs(
                ctx,
                &client,
                &repo,
                &run,
                args.job.as_deref(),
                args.log_failed,
                60,
            )?;
        }
    }
    if args.exit_status && failed(&run) {
        return Err(Error::exit(Kind::Failed));
    }
    Ok(())
}

fn watch(ctx: &Ctx, args: RunWatchArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let id = resolve(ctx, &client, &repo, args.run.as_deref())?;
    let url = run_url(&client.host.site, &repo, &id);
    let mut seen: std::collections::BTreeMap<String, String> = Default::default();
    loop {
        let run = flatten(&get_run(&client, &repo, &id)?, &url);
        let done = run["status"] == "completed";
        if !ctx.out.structured() {
            if ctx.out.tty {
                print!("\x1b[2J\x1b[H");
                print_run(&ctx.out, &run, None);
                let _ = std::io::stdout().flush();
            } else {
                for job in run["jobs"].as_array().into_iter().flatten() {
                    let name = s(job, "name").to_owned();
                    let st = state(job).to_owned();
                    if seen.get(&name) != Some(&st) {
                        println!("{name}\t{st}");
                        seen.insert(name, st);
                    }
                }
            }
        }
        if done {
            if ctx.out.structured() {
                ctx.out.emit(&run)?;
            } else if !ctx.out.tty {
                eprintln!("{} #{} {}", s(&run, "name"), run["number"], state(&run));
            }
            return if failed(&run) {
                Err(Error::exit(Kind::Failed))
            } else {
                Ok(())
            };
        }
        std::thread::sleep(Duration::from_secs(args.interval.max(1)));
    }
}

/// Every chunk of a job's log there is so far.
fn job_log(client: &Client, repo: &Repo, job: &str) -> Result<Vec<Value>> {
    let mut chunks = Vec::new();
    let mut after = 0u64;
    for _ in 0..200 {
        let page = client
            .op("get_job_logs")
            .repo(repo)
            .arg("job", job)
            .query("after", after)
            .send()?;
        let got = page["chunks"].as_array().cloned().unwrap_or_default();
        if let Some(last) = got.last().and_then(|c| c["seq"].as_u64()) {
            after = last;
        }
        let empty = got.is_empty();
        chunks.extend(got);
        if page["done"] == true || empty {
            break;
        }
    }
    Ok(chunks)
}

fn lines_of(chunks: &[Value], step: Option<u64>) -> Vec<String> {
    let text: String = chunks
        .iter()
        .filter(|c| step.is_none_or(|n| c["step"].as_u64() == Some(n)))
        .map(|c| s(c, "text"))
        .collect();
    text.lines().map(str::to_owned).collect()
}

/// The last `n` lines worth reading: group markers dropped.
pub fn tail(lines: &[String], n: usize) -> Vec<String> {
    let kept: Vec<&String> = lines
        .iter()
        .filter(|l| !l.starts_with("##[group]") && !l.starts_with("##[endgroup]"))
        .collect();
    kept[kept.len().saturating_sub(n)..]
        .iter()
        .map(|l| (*l).clone())
        .collect()
}

/// For each failing step of each failing job: its last lines.
pub fn failing_steps(jobs: &[(Value, Vec<Value>)], n: usize) -> Vec<Value> {
    let mut out = Vec::new();
    for (job, chunks) in jobs {
        if super::pr::bucket(state(job)) != "fail" {
            continue;
        }
        let steps: Vec<&Value> = job["steps"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|st| super::pr::bucket(state(st)) == "fail")
            .collect();
        if steps.is_empty() {
            // It failed outside its steps, setting up or being cancelled.
            out.push(json!({
                "job": job["name"], "job_id": job["id"], "step": Value::Null, "name": Value::Null,
                "state": state(job), "reason": job["reason"], "lines": tail(&lines_of(chunks, None), n),
                "annotations": job["annotations"],
            }));
        }
        for st in steps {
            out.push(json!({
                "job": job["name"], "job_id": job["id"], "step": st["number"], "name": st["name"],
                "state": state(st), "lines": tail(&lines_of(chunks, st["number"].as_u64()), n),
                "annotations": job["annotations"],
            }));
        }
    }
    out
}

fn print_logs(
    ctx: &Ctx,
    client: &Client,
    repo: &Repo,
    run: &Value,
    job_filter: Option<&str>,
    failed_only: bool,
    n: usize,
) -> Result<()> {
    let jobs: Vec<Value> = run["jobs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|j| job_filter.is_none_or(|f| job_matches(j, f)))
        .filter(|j| !failed_only || super::pr::bucket(state(j)) == "fail")
        .cloned()
        .collect();
    if job_filter.is_some() && jobs.is_empty() {
        return Err(Error::usage(format!(
            "No job {} in this run.",
            job_filter.unwrap_or_default()
        )));
    }
    let mut fetched = Vec::new();
    for job in jobs {
        let chunks = if job["started_at"].is_null() {
            Vec::new()
        } else {
            job_log(client, repo, s(&job, "id"))?
        };
        fetched.push((job, chunks));
    }
    let out = &ctx.out;
    if failed_only {
        let steps = failing_steps(&fetched, n);
        if ctx.out.structured() {
            return ctx.out.emit(&Value::Array(steps));
        }
        if steps.is_empty() {
            eprintln!("No failing steps in this run ({}).", state(run));
            return Ok(());
        }
        for st in &steps {
            let title = match st["name"].as_str() {
                Some(name) => format!("{} › {} {name}", s(st, "job"), st["step"]),
                None => format!(
                    "{} ({})",
                    s(st, "job"),
                    st["reason"].as_str().unwrap_or("failed")
                ),
            };
            println!("{} {}", out.red("X"), out.bold(&title));
            for line in st["lines"].as_array().into_iter().flatten() {
                println!("{}", line.as_str().unwrap_or(""));
            }
            println!();
        }
        return Ok(());
    }
    if ctx.out.structured() {
        let all: Vec<Value> = fetched
            .iter()
            .map(|(job, chunks)| json!({ "job": job["name"], "job_id": job["id"], "state": state(job), "chunks": chunks }))
            .collect();
        return ctx.out.emit(&Value::Array(all));
    }
    for (job, chunks) in &fetched {
        println!(
            "{}",
            out.bold(&format!("== {} ({}) ==", s(job, "name"), state(job)))
        );
        let names: std::collections::HashMap<u64, String> = job["steps"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|st| Some((st["number"].as_u64()?, s(st, "name").to_owned())))
            .collect();
        let mut step = None;
        for c in chunks {
            let this = c["step"].as_u64();
            if this != step {
                step = this;
                let n = this.unwrap_or(0);
                let name = names.get(&n).cloned().unwrap_or_else(|| {
                    if n == 0 {
                        "Set up".to_owned()
                    } else {
                        format!("Step {n}")
                    }
                });
                println!("{}", out.cyan(&format!("-- {n} {name}")));
            }
            print!("{}", s(c, "text"));
            if !s(c, "text").ends_with('\n') {
                println!();
            }
        }
        println!();
    }
    Ok(())
}

fn logs(ctx: &Ctx, args: RunLogsArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let id = resolve(ctx, &client, &repo, args.run.as_deref())?;
    let run = flatten(
        &get_run(&client, &repo, &id)?,
        &run_url(&client.host.site, &repo, &id),
    );
    print_logs(
        ctx,
        &client,
        &repo,
        &run,
        args.job.as_deref(),
        args.failed,
        args.tail,
    )
}

fn rerun(ctx: &Ctx, args: RunRerunArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let (call, what) = if let Some(job) = &args.job {
        (
            client.op("rerun_job").repo(&repo).arg("job", job),
            format!("job {job}"),
        )
    } else {
        let id = resolve(ctx, &client, &repo, args.run.as_deref())?;
        if args.failed {
            (
                client.op("rerun_failed_jobs").repo(&repo).arg("id", &id),
                format!("the failed jobs of {id}"),
            )
        } else {
            (
                client.op("rerun_workflow_run").repo(&repo).arg("id", &id),
                id.clone(),
            )
        }
    };
    let call = if args.debug {
        call.field("debug", true)
    } else {
        call
    };
    let run = call.send()?;
    let id = s(&run, "id").to_owned();
    super::issue::done(
        ctx,
        &run,
        &format!("Rerunning {what} (attempt {})", run["attempt"]),
        &run_url(&client.host.site, &repo, &id),
    )
}

fn cancel(ctx: &Ctx, args: RunSelect) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let id = resolve(ctx, &client, &repo, args.run.as_deref())?;
    let run = client
        .op("cancel_workflow_run")
        .repo(&repo)
        .arg("id", &id)
        .send()?;
    super::issue::done(
        ctx,
        &run,
        &format!("Cancelling {id}"),
        &run_url(&client.host.site, &repo, &id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_failing_steps_tails_are_kept() {
        let job = json!({ "id": "job_1", "name": "test", "status": "completed", "conclusion": "failure", "steps": [
            { "number": 1, "name": "checkout", "status": "completed", "conclusion": "success" },
            { "number": 2, "name": "cargo test", "status": "completed", "conclusion": "failure" },
        ], "annotations": [] });
        let ok = json!({ "id": "job_2", "name": "lint", "status": "completed", "conclusion": "success", "steps": [] });
        let chunks = vec![
            json!({ "seq": 1, "step": 1, "text": "cloned\n" }),
            json!({ "seq": 2, "step": 2, "text": "##[group]Run cargo test\na\nb\nc\n##[endgroup]\n" }),
            json!({ "seq": 3, "step": 2, "text": "test greet ... FAILED\n" }),
        ];
        let steps = failing_steps(&[(job, chunks), (ok, vec![])], 2);
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0]["name"], "cargo test");
        assert_eq!(steps[0]["lines"], json!(["c", "test greet ... FAILED"]));
    }

    #[test]
    fn states_prefer_the_conclusion() {
        assert_eq!(
            state(&json!({ "status": "completed", "conclusion": "failure" })),
            "failure"
        );
        assert_eq!(
            state(&json!({ "status": "in_progress", "conclusion": null })),
            "in_progress"
        );
    }
}
