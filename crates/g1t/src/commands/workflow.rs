//! `g1t workflow`: the workflows in `.g1t/workflows`: listing them, reading
//! one and its file, running one by hand, and turning one on or off.

use serde_json::{Map, Value, json};
use std::io::{IsTerminal, Read};
use std::time::Duration;

use crate::cli::{
    WorkflowCommand, WorkflowListArgs, WorkflowRunArgs, WorkflowSelect, WorkflowViewArgs,
};
use crate::client::Client;
use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::output::{Cell, Output, ago, now, parse_time, s};
use crate::prompt;
use crate::repo::Repo;

/// How many times `workflow run` looks for the run it started, a second
/// apart, when the answer does not carry it.
const LOOKS: u32 = 10;

pub fn run(ctx: &Ctx, command: WorkflowCommand) -> Result<()> {
    match command {
        WorkflowCommand::List(args) => list(ctx, args),
        WorkflowCommand::View(args) => view(ctx, args),
        WorkflowCommand::Run(args) => dispatch(ctx, args),
        WorkflowCommand::Enable(args) => switch(ctx, args, true),
        WorkflowCommand::Disable(args) => switch(ctx, args, false),
    }
}

/// The workflow's page: the Actions tab, showing its runs.
pub fn workflow_url(site: &str, repo: &Repo, id: &str) -> String {
    format!("{site}/{}/{}/actions?workflow={id}", repo.owner, repo.name)
}

/// `ci.yml` for `.g1t/workflows/ci.yml`.
fn file_of(workflow: &Value) -> &str {
    let path = s(workflow, "path");
    path.rsplit('/').next().unwrap_or(path)
}

/// `CI (ci.yml)`.
fn label(workflow: &Value) -> String {
    format!("{} ({})", s(workflow, "name"), file_of(workflow))
}

fn all(client: &Client, repo: &Repo) -> Result<Vec<Value>> {
    Ok(super::items(
        client.op("list_workflows").repo(repo).send()?,
        "workflows",
    ))
}

/// The workflows `given` names: by id or path, then file name, then name
/// (any case), the first way that finds any.
pub fn matching<'a>(workflows: &'a [Value], given: &str) -> Vec<&'a Value> {
    let given = given.trim();
    let file = given.trim_start_matches(".g1t/workflows/");
    let by = |test: &dyn Fn(&Value) -> bool| -> Vec<&'a Value> {
        workflows.iter().filter(|w| test(w)).collect()
    };
    for found in [
        by(&|w| s(w, "id") == given || s(w, "path") == given),
        by(&|w| file_of(w) == file),
        by(&|w| s(w, "name").eq_ignore_ascii_case(given)),
    ] {
        if !found.is_empty() {
            return found;
        }
    }
    Vec::new()
}

/// The workflow the command is about: named, or picked at a terminal from
/// those `fits` keeps.
fn pick(
    client: &Client,
    repo: &Repo,
    given: Option<&str>,
    fits: impl Fn(&Value) -> bool,
    none: &str,
) -> Result<Value> {
    let workflows = all(client, repo)?;
    if let Some(given) = given {
        let found = matching(&workflows, given);
        return match found.as_slice() {
            [] => Err(Error::failed(format!(
                "There is no workflow {} in {repo}. `g1t workflow list --all` lists them.",
                given.trim()
            ))),
            [one] => Ok((*one).clone()),
            many if prompt::interactive() => {
                let options: Vec<String> = many.iter().map(|w| label(w)).collect();
                let i = prompt::select(
                    &format!("More than one workflow is called {}. Which?", given.trim()),
                    &options,
                )?;
                Ok(many[i].clone())
            }
            many => Err(Error::usage(format!(
                "More than one workflow is called {}: {}. Name it by its file.",
                given.trim(),
                many.iter()
                    .map(|w| file_of(w))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))),
        };
    }
    if !prompt::interactive() {
        return Err(prompt::needed("The workflow", "its file name, id or name"));
    }
    let options: Vec<&Value> = workflows.iter().filter(|w| fits(w)).collect();
    if options.is_empty() {
        return Err(Error::failed(format!("{repo} has no {none}.")));
    }
    let labels: Vec<String> = options.iter().map(|w| label(w)).collect();
    let i = prompt::select("Which workflow?", &labels)?;
    Ok(options[i].clone())
}

fn active(workflow: &Value) -> bool {
    s(workflow, "state") == "active"
}

fn list(ctx: &Ctx, args: WorkflowListArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let mut workflows = all(&client, &repo)?;
    let off = workflows.iter().filter(|w| !active(w)).count();
    if !args.all {
        workflows.retain(active);
    }
    workflows.truncate(args.limit);
    if ctx.out.structured() {
        return ctx.out.emit(&Value::Array(workflows));
    }
    if workflows.is_empty() {
        if off > 0 {
            eprintln!("No workflows are on in {repo}; --all lists the {off} turned off.");
        } else {
            eprintln!(
                "No workflows in {repo}. They are read from .g1t/workflows on the default branch."
            );
        }
        return Ok(());
    }
    let out = &ctx.out;
    let rows: Vec<Vec<Cell>> = workflows
        .iter()
        .map(|w| {
            let state = if w["error"].is_string() && active(w) {
                "error"
            } else {
                s(w, "state")
            };
            vec![
                Cell::styled(s(w, "name"), out.bold(s(w, "name"))),
                Cell::styled(state, out.state(state)),
                Cell::new(file_of(w)),
                Cell::new(events(w)),
                Cell::styled(s(w, "id"), out.dim(s(w, "id"))),
            ]
        })
        .collect();
    out.table(&["name", "state", "file", "on", "id"], &rows)
}

fn events(workflow: &Value) -> String {
    workflow["events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(", ")
}

fn view(ctx: &Ctx, args: WorkflowViewArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let workflow = pick(
        &client,
        &repo,
        args.workflow.as_deref(),
        |_| true,
        "workflows",
    )?;
    let id = s(&workflow, "id");
    let url = workflow_url(&client.host.site, &repo, id);
    if args.web {
        return super::browse::open(ctx, &url);
    }
    let out = &ctx.out;
    if args.yaml {
        let detail = client
            .op("get_workflow")
            .repo(&repo)
            .arg("workflow", id)
            .query_opt("ref", args.git_ref.clone())
            .send()?;
        if out.structured() {
            return out.emit(&detail);
        }
        if out.tty {
            println!(
                "{} {}",
                out.bold(s(&detail, "name")),
                out.dim(&format!("· {} · {}", s(&detail, "path"), s(&detail, "ref")))
            );
            println!();
        }
        let source = s(&detail, "source");
        print!("{source}");
        if !source.ends_with('\n') {
            println!();
        }
        return Ok(());
    }
    let runs = super::items(
        client
            .op("list_workflow_runs")
            .repo(&repo)
            .query("workflow", id)
            .query("per_page", 5)
            .send()?,
        "workflow_runs",
    );
    let mut shown = workflow.clone();
    if let Some(map) = shown.as_object_mut() {
        map.insert("runs".into(), Value::Array(runs.clone()));
        map.insert("url".into(), Value::String(url.clone()));
    }
    if out.structured() {
        return out.emit(&shown);
    }
    println!(
        "{} {}",
        out.bold(s(&workflow, "name")),
        out.dim(s(&workflow, "path"))
    );
    let mut facts = vec![out.state(s(&workflow, "state"))];
    if !events(&workflow).is_empty() {
        facts.push(format!("on {}", events(&workflow)));
    }
    facts.push(out.dim(id));
    println!("{}", facts.join(" · "));
    if let Some(error) = workflow["error"].as_str() {
        println!("{} {error}", out.red("Error:"));
    }
    if let Some(inputs) = workflow["dispatch"].as_object() {
        println!();
        if inputs.is_empty() {
            println!("Runs by hand, with no inputs.");
        } else {
            println!("Runs by hand, with inputs:");
            for (name, spec) in inputs {
                println!("  {} {}", out.bold(name), out.dim(&describe(spec)));
            }
        }
    }
    for note in workflow["notes"].as_array().into_iter().flatten() {
        println!("{} {}", out.yellow("Note:"), s(note, "message"));
    }
    println!();
    if runs.is_empty() {
        println!("No runs yet.");
    } else {
        println!("{}", out.bold("Latest runs"));
        let rows: Vec<Vec<Cell>> = runs
            .iter()
            .map(|r| {
                let st = match s(r, "status") {
                    "completed" => r["conclusion"].as_str().unwrap_or("completed"),
                    other => other,
                };
                let branch = s(r, "ref")
                    .trim_start_matches("refs/heads/")
                    .trim_start_matches("refs/tags/")
                    .to_owned();
                vec![
                    Cell::styled(st, out.state(st)),
                    Cell::new(format!("#{} {}", r["number"], s(r, "title"))),
                    Cell::styled(branch.clone(), out.cyan(&branch)),
                    Cell::new(s(r, "event")),
                    Cell::styled(s(r, "id"), out.dim(s(r, "id"))),
                    Cell::styled(ago(s(r, "created_at")), out.dim(&ago(s(r, "created_at")))),
                ]
            })
            .collect();
        out.table(&["state", "run", "branch", "event", "id", "age"], &rows)?;
    }
    println!();
    println!(
        "{}",
        out.dim(&format!(
            "More runs: g1t run list --workflow {}",
            file_of(&workflow)
        ))
    );
    println!("{}", out.dim(&url));
    Ok(())
}

/// `(choice: beta, stable; default beta; required) What it is for`.
fn describe(spec: &Value) -> String {
    let mut parts = vec![spec["type"].as_str().unwrap_or("string").to_owned()];
    if let Some(options) = spec["options"].as_array() {
        let options: Vec<String> = options.iter().map(text).collect();
        parts[0] = format!("{}: {}", parts[0], options.join(", "));
    }
    if let Some(default) = spec.get("default").filter(|d| !d.is_null()) {
        parts.push(format!("default {}", text(default)));
    }
    if spec["required"] == true {
        parts.push("required".to_owned());
    }
    let mut line = format!("({})", parts.join("; "));
    if let Some(about) = spec["description"].as_str().filter(|d| !d.is_empty()) {
        line.push(' ');
        line.push_str(about);
    }
    line
}

/// A value as text: strings without their quotes.
fn text(value: &Value) -> String {
    match value {
        Value::String(t) => t.clone(),
        other => other.to_string(),
    }
}

/// `key=value` into `inputs`; `files` reads `@FILE` values.
fn put(inputs: &mut Map<String, Value>, pair: &str, files: bool) -> Result<()> {
    let (key, value) = pair
        .split_once('=')
        .filter(|(k, _)| !k.trim().is_empty())
        .ok_or_else(|| Error::usage(format!("`{pair}` is not key=value.")))?;
    let value = match value.strip_prefix('@').filter(|_| files) {
        Some("-") => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text)?;
            text
        }
        Some(path) => std::fs::read_to_string(path)
            .map_err(|e| Error::usage(format!("Could not read {path}: {e}")))?,
        None => value.to_owned(),
    };
    inputs.insert(key.trim().to_owned(), Value::String(value));
    Ok(())
}

/// Asks for each of the workflow's inputs, offering its default.
fn ask(spec: &Map<String, Value>) -> Result<Map<String, Value>> {
    let mut inputs = Map::new();
    for (name, input) in spec {
        let default = input.get("default").filter(|d| !d.is_null()).map(text);
        let options: Vec<String> = input["options"]
            .as_array()
            .map(|o| o.iter().map(text).collect())
            .unwrap_or_default();
        let value = if !options.is_empty() {
            // The default first, so taking the first is taking it.
            let mut ordered = options.clone();
            if let Some(d) = &default
                && let Some(at) = ordered.iter().position(|o| o == d)
            {
                let first = ordered.remove(at);
                ordered.insert(0, first);
            }
            let i = prompt::select(&format!("{name} {}", describe(input)), &ordered)?;
            ordered[i].clone()
        } else {
            prompt::input(&format!("{name} {}", describe(input)), default.as_deref())?
        };
        if !value.is_empty() {
            inputs.insert(name.clone(), Value::String(value));
        }
    }
    Ok(inputs)
}

fn dispatch(ctx: &Ctx, args: WorkflowRunArgs) -> Result<()> {
    // A bare --json is the inputs on stdin, as a JSON object; --json FIELDS
    // and --jq still shape what is printed.
    let from_stdin = ctx.out.json.as_ref().is_some_and(Vec::is_empty) && ctx.out.jq.is_none();
    let out = if from_stdin {
        Output {
            json: None,
            ..ctx.out.clone()
        }
    } else {
        ctx.out.clone()
    };
    let mut inputs = Map::new();
    if from_stdin {
        if !args.raw_field.is_empty() || !args.field.is_empty() {
            return Err(Error::usage(
                "--json reads every input from stdin: leave out -f and -F.",
            ));
        }
        if std::io::stdin().is_terminal() {
            return Err(Error::usage(
                "--json reads the inputs from stdin, as a JSON object such as {\"channel\":\"stable\"}.",
            ));
        }
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        inputs = match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => map,
            _ => {
                return Err(Error::usage(
                    "The inputs on stdin must be a JSON object, such as {\"channel\":\"stable\"}.",
                ));
            }
        };
    }
    for pair in &args.raw_field {
        put(&mut inputs, pair, false)?;
    }
    for pair in &args.field {
        put(&mut inputs, pair, true)?;
    }
    let (repo, client) = ctx.repo_client()?;
    let workflow = pick(
        &client,
        &repo,
        args.workflow.as_deref(),
        |w| active(w) && w["dispatch"].is_object(),
        "workflows that can be run by hand (`on: workflow_dispatch`)",
    )?;
    let asked = !from_stdin && args.raw_field.is_empty() && args.field.is_empty();
    if asked
        && prompt::interactive()
        && let Some(spec) = workflow["dispatch"].as_object()
        && !spec.is_empty()
    {
        inputs = ask(spec)?;
    }
    let id = s(&workflow, "id").to_owned();
    let since = now();
    let started = client
        .op("dispatch_workflow")
        .repo(&repo)
        .arg("workflow", &id)
        .field_opt("ref", args.git_ref.clone())
        .field("inputs", Value::Object(inputs))
        .send()?;
    let on = args.git_ref.clone().unwrap_or_else(|| {
        let r = s(&started, "ref");
        if r.is_empty() {
            "the default branch".to_owned()
        } else {
            r.trim_start_matches("refs/heads/")
                .trim_start_matches("refs/tags/")
                .to_owned()
        }
    });
    let run = if started["id"].is_string() {
        Some(started)
    } else {
        look_for_run(&client, &repo, &id, since)?
    };
    let Some(mut run) = run else {
        if out.structured() {
            return out.emit(&json!({ "workflow": workflow, "run": null }));
        }
        eprintln!(
            "{} Asked for a run of {} on {on}. It has not appeared yet: `g1t run list --workflow {}` lists its runs.",
            out.green("✓"),
            label(&workflow),
            file_of(&workflow)
        );
        return Ok(());
    };
    let run_id = s(&run, "id").to_owned();
    let url = super::run::run_url(&client.host.site, &repo, &run_id);
    if let Some(map) = run.as_object_mut() {
        map.insert("url".into(), Value::String(url.clone()));
    }
    if out.structured() {
        return out.emit(&run);
    }
    let number = run["number"]
        .as_u64()
        .map(|n| format!(" #{n}"))
        .unwrap_or_default();
    eprintln!(
        "{} Started {}{number} on {on}",
        out.green("✓"),
        label(&workflow)
    );
    println!("{url}");
    if out.tty {
        eprintln!("{}", out.dim(&format!("Follow it: g1t run watch {run_id}")));
    }
    Ok(())
}

/// The run a dispatch made, once it shows: the workflow's newest
/// `workflow_dispatch` run made since `since`.
fn look_for_run(client: &Client, repo: &Repo, workflow: &str, since: i64) -> Result<Option<Value>> {
    for look in 0..LOOKS {
        if look > 0 {
            std::thread::sleep(Duration::from_secs(1));
        }
        let runs = super::items(
            client
                .op("list_workflow_runs")
                .repo(repo)
                .query("workflow", workflow)
                .query("event", "workflow_dispatch")
                .query("per_page", 1)
                .send()?,
            "workflow_runs",
        );
        // A few seconds' grace for the server's clock and this one's.
        if let Some(run) = runs
            .into_iter()
            .find(|r| parse_time(s(r, "created_at")).is_some_and(|t| t >= since - 5))
        {
            return Ok(Some(run));
        }
    }
    Ok(None)
}

fn switch(ctx: &Ctx, args: WorkflowSelect, on: bool) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let workflow = if on {
        pick(
            &client,
            &repo,
            args.workflow.as_deref(),
            |w| !active(w),
            "workflows turned off",
        )?
    } else {
        pick(
            &client,
            &repo,
            args.workflow.as_deref(),
            active,
            "workflows turned on",
        )?
    };
    let id = s(&workflow, "id");
    let call = if on {
        client.op("enable_workflow")
    } else {
        client.op("disable_workflow")
    };
    let changed = call.repo(&repo).arg("workflow", id).send()?;
    let shown = if changed.is_object() {
        changed
    } else {
        workflow.clone()
    };
    super::done(
        ctx,
        &shown,
        &format!(
            "Turned {} {}",
            label(&workflow),
            if on { "on" } else { "off" }
        ),
        &workflow_url(&client.host.site, &repo, id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workflows() -> Vec<Value> {
        vec![
            json!({ "id": "wfl_1", "path": ".g1t/workflows/ci.yml", "name": "CI", "state": "active" }),
            json!({ "id": "wfl_2", "path": ".g1t/workflows/release.yml", "name": "Release", "state": "active" }),
            json!({ "id": "wfl_3", "path": ".g1t/workflows/nightly.yml", "name": "ci", "state": "disabled" }),
        ]
    }

    #[test]
    fn workflows_are_named_by_id_file_path_or_name() {
        let all = workflows();
        let ids = |given: &str| -> Vec<&str> {
            matching(&all, given).iter().map(|w| s(w, "id")).collect()
        };
        assert_eq!(ids("wfl_2"), ["wfl_2"]);
        assert_eq!(ids("release.yml"), ["wfl_2"]);
        assert_eq!(ids(".g1t/workflows/release.yml"), ["wfl_2"]);
        assert_eq!(ids("release"), ["wfl_2"]);
        // A file name wins over a name, and names match in any case.
        assert_eq!(ids("ci.yml"), ["wfl_1"]);
        assert_eq!(ids("CI"), ["wfl_1", "wfl_3"]);
        assert!(ids("deploy.yml").is_empty());
    }

    #[test]
    fn inputs_are_described_with_their_options_and_default() {
        let spec = json!({ "type": "choice", "options": ["beta", "stable"], "default": "beta", "required": true, "description": "Where it goes" });
        assert_eq!(
            describe(&spec),
            "(choice: beta, stable; default beta; required) Where it goes"
        );
    }

    #[test]
    fn fields_must_be_key_value() {
        let mut inputs = Map::new();
        put(&mut inputs, "channel=stable=1", false).unwrap();
        assert_eq!(inputs["channel"], "stable=1");
        assert!(put(&mut inputs, "channel", false).is_err());
        assert!(put(&mut inputs, "=x", false).is_err());
    }
}
