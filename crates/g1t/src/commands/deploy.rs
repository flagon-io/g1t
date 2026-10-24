//! `g1t deploy`: a repository's deployments, wherever they ran, and a
//! project's g1t.page deployment settings.

use serde_json::{Map, Value};

use crate::cli::{DeployCommand, DeployListArgs, DeployProjectArgs, DeploySettingsArgs, DeployViewArgs, Switch};
use crate::context::Ctx;
use crate::error::Result;
use crate::output::{Cell, ago, s};

pub fn run(ctx: &Ctx, command: DeployCommand) -> Result<()> {
    match command {
        DeployCommand::List(args) => list(ctx, args),
        DeployCommand::View(args) => view(ctx, args),
        DeployCommand::Settings(args) => settings(ctx, args),
        DeployCommand::Enable(args) => switch(ctx, args, true),
        DeployCommand::Disable(args) => switch(ctx, args, false),
    }
}

/// The change the flags ask for, as `update_deployment_settings` takes it.
fn changes(args: &DeploySettingsArgs) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in [("production", args.production), ("previews", args.previews), ("via_workflow", args.via_workflow)] {
        if let Some(value) = value {
            out.insert(key.to_owned(), (value == Switch::On).into());
        }
    }
    for (key, value) in [
        ("build_as", &args.build_as),
        ("build_command", &args.build_command),
        ("output_dir", &args.output_dir),
        ("dockerfile", &args.dockerfile),
        ("instance_type", &args.instance_type),
    ] {
        if let Some(value) = value {
            out.insert(key.to_owned(), value.clone().into());
        }
    }
    if let Some(days) = args.idle_days {
        out.insert("idle_days".to_owned(), days.into());
    }
    out
}

fn settings(ctx: &Ctx, args: DeploySettingsArgs) -> Result<()> {
    let (workspace, project, client) = super::logs::resolve_project(ctx, args.project.as_deref())?;
    let wanted = changes(&args);
    let found = if wanted.is_empty() {
        client.op("get_deployment_settings").arg("workspace", &workspace).arg("project", &project).send()?
    } else {
        let mut call = client.op("update_deployment_settings").arg("workspace", &workspace).arg("project", &project);
        for (key, value) in wanted {
            call = call.field(&key, value);
        }
        call.send()?
    };
    show(ctx, &found)
}

fn switch(ctx: &Ctx, args: DeployProjectArgs, on: bool) -> Result<()> {
    let (workspace, project, client) = super::logs::resolve_project(ctx, args.project.as_deref())?;
    let found =
        client.op("update_deployment_settings").arg("workspace", &workspace).arg("project", &project).field("enabled", on).send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    if on {
        eprintln!(
            "{} Deployments are on for {workspace}/{project}: production is building at {}",
            ctx.out.green("✓"),
            s(&found, "production_url")
        );
    } else {
        eprintln!("{} Deployments are off for {workspace}/{project}: every app is down.", ctx.out.green("✓"));
    }
    Ok(())
}

/// A project's deployment settings, one to a line.
fn show(ctx: &Ctx, found: &Value) -> Result<()> {
    if ctx.out.structured() {
        return ctx.out.emit(found);
    }
    let out = &ctx.out;
    let on = |key: &str| if found[key].as_bool() == Some(true) { "on" } else { "off" };
    let text = |key: &str, unset: &str| found[key].as_str().filter(|v| !v.is_empty()).unwrap_or(unset).to_owned();
    println!(
        "{} {}",
        out.bold(&format!("{}/{}", s(found, "workspace"), s(found, "project"))),
        if found["enabled"].as_bool() == Some(true) { out.green("deployments on") } else { out.dim("deployments off") }
    );
    let rows = [
        ("Production:", format!("{} at {}", on("production"), s(found, "production_url"))),
        ("Previews:", on("previews").to_owned()),
        ("Build as:", text("build_as", "auto")),
        ("Build command:", text("build_command", "the repository's own")),
        ("Output dir:", text("output_dir", "found by itself")),
        ("Dockerfile:", text("dockerfile", "Dockerfile or Containerfile")),
        ("Container size:", text("instance_type", "lite")),
        ("Idle days:", found["idle_days"].to_string()),
        ("Via workflow:", on("via_workflow").to_owned()),
        ("Detected:", text("detected", "at the first build")),
    ];
    for (label, value) in rows {
        println!("{} {value}", out.dim(label));
    }
    if let Some(domain) = found["primary_domain"].as_str() {
        println!("{} {domain}", out.dim("Domain:"));
    }
    Ok(())
}

fn list(ctx: &Ctx, args: DeployListArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let found = client
        .op("list_deployments")
        .repo(&repo)
        .query_opt("environment", args.env.clone())
        .query_opt("state", args.state.clone())
        .query_opt("source", args.source.clone())
        .query("per_page", args.limit.clamp(1, 100))
        .send()?;
    let mut deployments = super::items(found, "deployments");
    deployments.truncate(args.limit);
    if ctx.out.structured() {
        return ctx.out.emit(&Value::Array(deployments));
    }
    if deployments.is_empty() {
        eprintln!("No deployments in {repo}.");
        return Ok(());
    }
    let out = &ctx.out;
    let rows: Vec<Vec<Cell>> = deployments
        .iter()
        .map(|d| {
            let sha = s(d, "sha");
            let short = &sha[..sha.len().min(7)];
            vec![
                Cell::styled(s(d, "id"), out.dim(s(d, "id"))),
                Cell::styled(s(d, "environment"), out.bold(s(d, "environment"))),
                Cell::styled(s(d, "state"), out.state(s(d, "state"))),
                Cell::new(format!("{} {short}", s(d, "ref"))),
                Cell::new(s(d, "source")),
                Cell::new(s(d, "environment_url")),
                Cell::styled(ago(s(d, "created_at")), out.dim(&ago(s(d, "created_at")))),
            ]
        })
        .collect();
    out.table(&["id", "environment", "state", "ref", "source", "url", "age"], &rows)
}

fn view(ctx: &Ctx, args: DeployViewArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let page = format!("{}/{}/{}/deployments/{}", client.host.site, repo.owner, repo.name, args.id);
    if args.web {
        return super::browse::open(ctx, &page);
    }
    let d = client.op("get_deployment").repo(&repo).arg("id", &args.id).send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&d);
    }
    let out = &ctx.out;
    println!("{} {} {}", out.bold(s(&d, "environment")), out.state(s(&d, "state")), out.dim(s(&d, "id")));
    let sha = s(&d, "sha");
    println!("{} {} at {}", out.dim("Ref:"), s(&d, "ref"), &sha[..sha.len().min(12)]);
    if let Some(desc) = d["description"].as_str().filter(|x| !x.is_empty()) {
        println!("{} {desc}", out.dim("What:"));
    }
    println!("{} {} by {}, {}", out.dim("From:"), s(&d, "source"), s(&d, "creator"), ago(s(&d, "created_at")));
    for (label, key) in [("Address:", "environment_url"), ("Log:", "log_url"), ("Run:", "run_url")] {
        if let Some(v) = d[key].as_str().filter(|x| !x.is_empty()) {
            println!("{} {v}", out.dim(label));
        }
    }
    if let Some(statuses) = d["statuses"].as_array().filter(|l| !l.is_empty()) {
        println!();
        let rows: Vec<Vec<Cell>> = statuses
            .iter()
            .map(|st| {
                vec![
                    Cell::styled(s(st, "state"), out.state(s(st, "state"))),
                    Cell::new(s(st, "description")),
                    Cell::styled(ago(s(st, "created_at")), out.dim(&ago(s(st, "created_at")))),
                ]
            })
            .collect();
        out.table(&["state", "description", "when"], &rows)?;
    }
    println!();
    println!("{}", out.dim(&page));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Command};
    use clap::Parser;

    fn settings_args(argv: &[&str]) -> DeploySettingsArgs {
        let cli = Cli::try_parse_from([&["g1t", "deploy", "settings"], argv].concat()).unwrap();
        match cli.command {
            Command::Deploy(DeployCommand::Settings(args)) => args,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn flags_become_only_the_changes_they_name() {
        assert!(changes(&settings_args(&[])).is_empty());
        let asked = changes(&settings_args(&["--previews", "off", "--build-command", "", "--idle-days", "14", "-p", "acme/web"]));
        assert_eq!(Value::Object(asked), serde_json::json!({ "previews": false, "build_command": "", "idle_days": 14 }));
        assert!(Cli::try_parse_from(["g1t", "deploy", "settings", "--production", "maybe"]).is_err());
    }
}
