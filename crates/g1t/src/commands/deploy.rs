//! `g1t deploy`: a repository's deployments, wherever they ran.

use serde_json::Value;

use crate::cli::{DeployCommand, DeployListArgs, DeployViewArgs};
use crate::context::Ctx;
use crate::error::Result;
use crate::output::{Cell, ago, s};

pub fn run(ctx: &Ctx, command: DeployCommand) -> Result<()> {
    match command {
        DeployCommand::List(args) => list(ctx, args),
        DeployCommand::View(args) => view(ctx, args),
    }
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
    out.table(
        &["id", "environment", "state", "ref", "source", "url", "age"],
        &rows,
    )
}

fn view(ctx: &Ctx, args: DeployViewArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let page = format!(
        "{}/{}/{}/deployments/{}",
        client.host.site, repo.owner, repo.name, args.id
    );
    if args.web {
        return super::browse::open(ctx, &page);
    }
    let d = client
        .op("get_deployment")
        .repo(&repo)
        .arg("id", &args.id)
        .send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&d);
    }
    let out = &ctx.out;
    println!(
        "{} {} {}",
        out.bold(s(&d, "environment")),
        out.state(s(&d, "state")),
        out.dim(s(&d, "id"))
    );
    let sha = s(&d, "sha");
    println!(
        "{} {} at {}",
        out.dim("Ref:"),
        s(&d, "ref"),
        &sha[..sha.len().min(12)]
    );
    if let Some(desc) = d["description"].as_str().filter(|x| !x.is_empty()) {
        println!("{} {desc}", out.dim("What:"));
    }
    println!(
        "{} {} by {}, {}",
        out.dim("From:"),
        s(&d, "source"),
        s(&d, "creator"),
        ago(s(&d, "created_at"))
    );
    for (label, key) in [
        ("Address:", "environment_url"),
        ("Log:", "log_url"),
        ("Run:", "run_url"),
    ] {
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
