//! `g1t repo`.

use serde_json::Value;

use crate::cli::{
    RepoCloneArgs, RepoCommand, RepoCreateArgs, RepoDetachArgs, RepoForkArgs, RepoForksArgs, RepoListArgs, RepoSyncArgs,
    RepoViewArgs,
};
use crate::client::Client;
use crate::context::Ctx;
use crate::error::{Error, Kind, Result};
use crate::output::{Cell, s};
use crate::repo::Repo;

pub fn run(ctx: &Ctx, command: RepoCommand) -> Result<()> {
    match command {
        RepoCommand::View(args) => view(ctx, args),
        RepoCommand::Clone(args) => clone(ctx, args),
        RepoCommand::Create(args) => create(ctx, args),
        RepoCommand::List(args) => list(ctx, args),
        RepoCommand::Fork(args) => fork(ctx, args),
        RepoCommand::Forks(args) => forks(ctx, args),
        RepoCommand::Sync(args) => sync(ctx, args),
        RepoCommand::Detach(args) => detach(ctx, args),
    }
}

/// The repository named as OWNER/NAME, with a client for its host, or
/// `current` when none is named.
fn named_or(ctx: &Ctx, name: Option<&str>, current: fn(&Ctx) -> Result<(Repo, Client)>) -> Result<(Repo, Client)> {
    match name {
        Some(name) => {
            let host = ctx.host()?;
            let repo = Repo::parse(name, &host.name)?;
            let host = crate::auth::resolve(&ctx.config, Some(&repo.host))?;
            Ok((repo, ctx.client_for(host)))
        }
        None => current(ctx),
    }
}

/// The repository a fork came from, as `parent` names it.
fn parent_of(found: &Value) -> Option<String> {
    let parent = &found["parent"];
    let (owner, name) = (parent["namespace"].as_str()?, parent["name"].as_str()?);
    Some(format!("{owner}/{name}"))
}

pub fn web_url(site: &str, repo: &Repo) -> String {
    format!("{site}/{}/{}", repo.owner, repo.name)
}

fn view(ctx: &Ctx, args: RepoViewArgs) -> Result<()> {
    let (repo, client) = named_or(ctx, args.repository.as_deref(), Ctx::repo_client)?;
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
    if let Some(parent) = parent_of(&found) {
        println!("{}", out.dim(&format!("Forked from {parent}")));
    } else if found["parent_id"].is_string() {
        println!("{}", out.dim("Forked from a repository you cannot see"));
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

fn fork(ctx: &Ctx, args: RepoForkArgs) -> Result<()> {
    let (source, client) = named_or(ctx, args.repository.as_deref(), Ctx::repo_client)?;
    if !client.has_token() {
        return Err(crate::context::not_signed_in(&client.host));
    }
    let made = client
        .op("fork_repo")
        .repo(&source)
        .field_opt("workspace", args.workspace)
        .field_opt("name", args.name)
        .field_opt("description", args.description)
        .field("default_branch_only", !args.all_branches)
        .send()?;
    let fork = Repo {
        host: client.host.name.clone(),
        owner: s(&made, "namespace").to_owned(),
        name: s(&made, "name").to_owned(),
    };
    let url = web_url(&client.host.site, &fork);
    if ctx.out.structured() {
        ctx.out.emit(&made)?;
    } else {
        eprintln!("{} Forked {source} to {fork}", ctx.out.green("✓"));
        println!("{url}");
    }
    if args.clone {
        let remote = format!("{url}.git");
        crate::git::run_visible(&["clone", &remote, &fork.name])?;
        let upstream = format!("{}.git", web_url(&client.host.site, &source));
        crate::git::run(&["-C", &fork.name, "remote", "add", "upstream", &upstream])?;
        if !ctx.out.structured() {
            eprintln!("  Cloned into {}: origin is {fork}, upstream is {source}.", fork.name);
        }
    }
    Ok(())
}

fn forks(ctx: &Ctx, args: RepoForksArgs) -> Result<()> {
    let (repo, client) = named_or(ctx, args.repository.as_deref(), Ctx::repo_client)?;
    let found = client
        .op("list_forks")
        .repo(&repo)
        .query("limit", args.limit.clamp(1, 100))
        .send()?;
    let mut list: Vec<Value> = super::items(found, "forks");
    list.truncate(args.limit);
    if ctx.out.structured() {
        return ctx.out.emit(&Value::Array(list));
    }
    if list.is_empty() {
        eprintln!("No forks of {repo} that you can see.");
        return Ok(());
    }
    let out = &ctx.out;
    let rows: Vec<Vec<Cell>> = list
        .iter()
        .map(|r| {
            let name = format!("{}/{}", s(r, "namespace"), s(r, "name"));
            let made = s(r, "created_at");
            let made = made.get(..10).unwrap_or(made);
            vec![
                Cell::styled(name.clone(), out.bold(&name)),
                Cell::new(s(r, "description")),
                Cell::styled(made, out.dim(made)),
            ]
        })
        .collect();
    out.table(&["name", "description", "created"], &rows)
}

fn sync(ctx: &Ctx, args: RepoSyncArgs) -> Result<()> {
    let (fork, client) = named_or(ctx, args.repository.as_deref(), Ctx::pushed_repo_client)?;
    let synced = client.op("sync_fork").repo(&fork).field_opt("branch", args.branch).send()?;
    let conflicted = synced["status"] == "conflicted";
    if ctx.out.structured() {
        ctx.out.emit(&synced)?;
        return if conflicted { Err(Error::exit(Kind::Failed)) } else { Ok(()) };
    }
    let out = &ctx.out;
    let branch = s(&synced, "branch");
    let behind = synced["behind"].as_u64().unwrap_or_default();
    let ahead = synced["ahead"].as_u64().unwrap_or_default();
    let commits = |n: u64| if n == 1 { "1 commit".to_owned() } else { format!("{n} commits") };
    let head = s(&synced, "head");
    let short = head.get(..7).unwrap_or(head);
    match s(&synced, "status") {
        "up_to_date" => eprintln!("{} {fork} {branch} is up to date.", out.green("✓")),
        "fast_forwarded" => eprintln!(
            "{} Synced {fork} {branch}: took in {}, now at {short}.",
            out.green("✓"),
            commits(behind)
        ),
        "merged" => eprintln!(
            "{} Synced {fork} {branch}: merged {} into its {} of its own, now at {short}.",
            out.green("✓"),
            commits(behind),
            commits(ahead)
        ),
        _ => {
            eprintln!(
                "{} {fork} {branch} was not synced: it and the repository it came from both changed these files.",
                out.red("✗")
            );
            for path in synced["conflicts"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                eprintln!("  {path}");
            }
            eprintln!("  Merge them in your clone, then push: git pull upstream {branch}");
            return Err(Error::exit(Kind::Failed));
        }
    }
    if behind > 0 && !conflicted {
        eprintln!("  Update your clone: git pull origin {branch}");
    }
    Ok(())
}

fn detach(ctx: &Ctx, args: RepoDetachArgs) -> Result<()> {
    let (fork, client) = named_or(ctx, args.repository.as_deref(), Ctx::pushed_repo_client)?;
    if !args.yes {
        if !crate::prompt::interactive() {
            return Err(crate::prompt::needed("Confirmation", "--yes"));
        }
        let choice = crate::prompt::select(
            &format!("Detach {fork} from the repository it was forked from? It cannot be linked again."),
            &["Detach it".to_owned(), "Cancel".to_owned()],
        )?;
        if choice != 0 {
            return Err(Error::exit(Kind::Failed));
        }
    }
    let detached = client.op("detach_fork").repo(&fork).send()?;
    super::issue::done(
        ctx,
        &detached,
        &format!("Detached {fork}: it is no longer a fork"),
        &web_url(&client.host.site, &fork),
    )
}

/// The repository's default branch.
pub fn default_branch(client: &crate::client::Client, repo: &Repo) -> Result<String> {
    let found = client.op("get_repo").repo(repo).send()?;
    found["default_branch"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::failed(format!("{repo} has no default branch yet.")))
}
