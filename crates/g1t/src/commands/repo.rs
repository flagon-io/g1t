//! `g1t repo`.

use serde_json::Value;

use crate::cli::{RepoCloneArgs, RepoCommand, RepoCreateArgs, RepoListArgs, RepoViewArgs};
use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::output::{Cell, s};
use crate::repo::Repo;

pub fn run(ctx: &Ctx, command: RepoCommand) -> Result<()> {
    match command {
        RepoCommand::View(args) => view(ctx, args),
        RepoCommand::Clone(args) => clone(ctx, args),
        RepoCommand::Create(args) => create(ctx, args),
        RepoCommand::List(args) => list(ctx, args),
    }
}

pub fn web_url(site: &str, repo: &Repo) -> String {
    format!("{site}/{}/{}", repo.owner, repo.name)
}

fn view(ctx: &Ctx, args: RepoViewArgs) -> Result<()> {
    let (repo, client) = match &args.repository {
        Some(name) => {
            let host = ctx.host()?;
            let repo = Repo::parse(name, &host.name)?;
            let host = crate::auth::resolve(&ctx.config, Some(&repo.host))?;
            (repo, ctx.client_for(host))
        }
        None => ctx.repo_client()?,
    };
    if args.web {
        return super::browse::open(ctx, &web_url(&client.host.site, &repo));
    }
    let found = client.op("get_repo").repo(&repo).send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    let out = &ctx.out;
    let name = format!("{}/{}", s(&found, "namespace"), s(&found, "name"));
    println!("{}", out.bold(&name));
    if let Some(d) = found["description"].as_str().filter(|d| !d.is_empty()) {
        println!("{d}");
    }
    let visibility = if found["is_private"] == true {
        "private"
    } else {
        "public"
    };
    let mut facts = vec![
        visibility.to_owned(),
        format!("default branch {}", s(&found, "default_branch")),
    ];
    if found["archived_at"].is_string() {
        facts.push("archived".to_owned());
    }
    if let Some(site) = found["website"].as_str().filter(|w| !w.is_empty()) {
        facts.push(site.to_owned());
    }
    println!("{}", out.dim(&facts.join(" · ")));
    println!("{}", out.dim(&web_url(&client.host.site, &repo)));
    Ok(())
}

fn clone(ctx: &Ctx, args: RepoCloneArgs) -> Result<()> {
    let host = ctx.host()?;
    let repo = if args.repository.contains('/') || args.repository.contains(':') {
        Repo::parse(&args.repository, &host.name)?
    } else {
        let client = ctx.signed_in_client()?;
        Repo {
            host: host.name.clone(),
            owner: ctx.me(&client)?,
            name: args.repository.clone(),
        }
    };
    let host = crate::auth::resolve(&ctx.config, Some(&repo.host))?;
    let url = format!("{}.git", web_url(&host.site, &repo));
    let mut git_args: Vec<&str> = vec!["clone"];
    git_args.extend(args.git_flags.iter().map(String::as_str));
    git_args.push(&url);
    if let Some(dir) = &args.directory {
        git_args.push(dir);
    }
    crate::git::run_visible(&git_args)
}

fn create(ctx: &Ctx, args: RepoCreateArgs) -> Result<()> {
    let client = ctx.signed_in_client()?;
    let name = match args.name {
        Some(n) => n,
        None if crate::prompt::interactive() => crate::prompt::input("Repository name:", None)?,
        None => return Err(crate::prompt::needed("A name", "NAME")),
    };
    let (workspace, name) = match name.split_once('/') {
        Some((w, n)) => (Some(w.to_owned()), n.to_owned()),
        None => (None, name),
    };
    let made = client
        .op("create_repo")
        .field("name", name.clone())
        .field_opt("workspace", workspace)
        .field_opt("description", args.description)
        .field("private", !args.public)
        .send()?;
    let repo = Repo {
        host: client.host.name.clone(),
        owner: s(&made, "namespace").to_owned(),
        name: s(&made, "name").to_owned(),
    };
    let url = web_url(&client.host.site, &repo);
    if ctx.out.structured() {
        ctx.out.emit(&made)?;
    } else {
        eprintln!("{} Made {repo}", ctx.out.green("✓"));
        println!("{url}");
    }
    let remote = format!("{url}.git");
    if let Some(dir) = &args.source {
        crate::git::run(&["-C", dir, "remote", "add", &args.remote, &remote])?;
        crate::git::run_visible(&["-C", dir, "push", "-u", &args.remote, "HEAD"])?;
    } else if args.clone {
        crate::git::run_visible(&["clone", &remote])?;
    }
    Ok(())
}

fn list(ctx: &Ctx, args: RepoListArgs) -> Result<()> {
    let client = ctx.client()?;
    let found = client
        .op("list_repos")
        .query_opt("q", args.query.clone())
        .send()?;
    let mut repos: Vec<Value> = super::items(found, "repositories");
    if let Some(w) = &args.workspace {
        repos.retain(|r| {
            r["namespace"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(w))
        });
    }
    repos.truncate(args.limit);
    if ctx.out.structured() {
        return ctx.out.emit(&Value::Array(repos));
    }
    if repos.is_empty() {
        eprintln!("No repositories.");
        return Ok(());
    }
    let out = &ctx.out;
    let rows: Vec<Vec<Cell>> = repos
        .iter()
        .map(|r| {
            let visibility = if r["is_private"] == true {
                "private"
            } else {
                "public"
            };
            vec![
                Cell::styled(
                    format!("{}/{}", s(r, "namespace"), s(r, "name")),
                    out.bold(&format!("{}/{}", s(r, "namespace"), s(r, "name"))),
                ),
                Cell::new(s(r, "description")),
                Cell::styled(visibility, out.dim(visibility)),
            ]
        })
        .collect();
    out.table(&["name", "description", "visibility"], &rows)
}

/// The repository's default branch.
pub fn default_branch(client: &crate::client::Client, repo: &Repo) -> Result<String> {
    let found = client.op("get_repo").repo(repo).send()?;
    found["default_branch"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::failed(format!("{repo} has no default branch yet.")))
}
