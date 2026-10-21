//! `g1t project`: a workspace's projects in Work, homes for bodies of work.
//! Listing, viewing, creating and changing them, with their people and the
//! repositories their work lands in.
//!
//! A project is its workspace's: `--workspace`, or the current repository's.
//! Its page is `{site}/{workspace}/-/work/projects/{slug}`.

use serde_json::{Value, json};

use crate::cli::{ProjectArgs, ProjectCommand, ProjectCreateArgs, ProjectEditArgs, ProjectFields, ProjectListArgs, ProjectViewArgs};
use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::output::{Cell, Output, s};
use crate::prompt;

use super::work::{Place, place};

pub fn run(ctx: &Ctx, args: ProjectArgs) -> Result<()> {
    let workspace = args.workspace.as_deref();
    match args.command {
        ProjectCommand::List(args) => list(ctx, workspace, args),
        ProjectCommand::View(args) => view(ctx, workspace, args),
        ProjectCommand::Create(args) => create(ctx, workspace, args),
        ProjectCommand::Edit(args) => edit(ctx, workspace, args),
    }
}

/// A project's page on the site.
fn project_url(place: &Place, slug: &str) -> String {
    format!("{}/{}/-/work/projects/{slug}", place.client.host.site, place.workspace)
}

/// How a project's health reads.
fn health_label(health: &str) -> &'static str {
    match health {
        "on_track" => "on track",
        "at_risk" => "at risk",
        "off_track" => "off track",
        _ => "",
    }
}

/// Its health, colored: green on track, yellow at risk, red off track.
fn health_cell(out: &Output, health: &str) -> Cell {
    let label = health_label(health).to_owned();
    let styled = match health {
        "on_track" => out.green(&label),
        "at_risk" => out.yellow(&label),
        "off_track" => out.red(&label),
        _ => String::new(),
    };
    Cell::styled(label, styled)
}

/// `S`, `M`, `L` or a word for an appetite; `none` clears it (`null`).
fn appetite_value(given: &str) -> Result<Value> {
    match given.trim().to_ascii_lowercase().as_str() {
        "none" | "" => Ok(Value::Null),
        "s" | "small" => Ok(json!("small")),
        "m" | "medium" => Ok(json!("medium")),
        "l" | "large" => Ok(json!("large")),
        _ => Err(Error::usage("--appetite is S, M, L or none.")),
    }
}

/// `on-track`, `at risk`, `off_track`; `none` clears it (`null`).
fn health_value(given: &str) -> Result<Value> {
    let name: String = given.trim().to_ascii_lowercase().chars().map(|c| if c == '-' || c == ' ' { '_' } else { c }).collect();
    match name.as_str() {
        "none" | "" => Ok(Value::Null),
        "on_track" | "at_risk" | "off_track" => Ok(Value::String(name)),
        _ => Err(Error::usage("--health is on-track, at-risk, off-track or none.")),
    }
}

/// The fields `create` and `edit` both set, onto `call`. Whether any was given.
fn with_fields<'a>(ctx: &Ctx, place: &Place, mut call: crate::client::Call<'a>, fields: &ProjectFields) -> Result<(crate::client::Call<'a>, bool)> {
    let mut changed = false;
    let brief = prompt::body(fields.brief.clone(), fields.brief_file.as_deref(), false)?;
    for (key, value) in [
        ("summary", fields.summary.clone()),
        ("brief", brief),
        ("instructions", fields.instructions.clone()),
        ("start_on", fields.start_on.clone()),
        ("target_on", fields.target_on.clone()),
        ("icon", fields.icon.clone()),
        ("color", fields.color.clone()),
    ] {
        if let Some(value) = value {
            call = call.field(key, value);
            changed = true;
        }
    }
    if let Some(lead) = &fields.lead {
        let lead = if lead.trim().is_empty() { String::new() } else { super::who(ctx, &place.client, lead)? };
        call = call.field("lead", lead);
        changed = true;
    }
    if let Some(state) = fields.state {
        call = call.field("state", state.name());
        changed = true;
    }
    if let Some(appetite) = &fields.appetite {
        call = call.field("appetite", appetite_value(appetite)?);
        changed = true;
    }
    if let Some(health) = &fields.health {
        call = call.field("health", health_value(health)?);
        changed = true;
    }
    Ok((call, changed))
}

fn list(ctx: &Ctx, workspace: Option<&str>, args: ProjectListArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    let found = place
        .client
        .op("list_work_projects")
        .arg("workspace", &place.workspace)
        .query_opt("state", args.state.map(|state| state.name()))
        .query_opt("archived", args.archived.then_some("true"))
        .send()?;
    let projects = super::items(found, "projects");
    if ctx.out.structured() {
        return ctx.out.emit(&Value::Array(projects));
    }
    if projects.is_empty() {
        let what = if args.archived { "archived projects" } else { "projects" };
        eprintln!("No {what} in {}. Create one with g1t project create --name NAME.", place.workspace);
        return Ok(());
    }
    let out = &ctx.out;
    let rows: Vec<Vec<Cell>> = projects
        .iter()
        .map(|p| {
            let done = p["closed_items"].as_u64().unwrap_or_default();
            let total = done + p["open_items"].as_u64().unwrap_or_default();
            let progress = format!("{done}/{total}");
            let lead = p["lead"].as_str().unwrap_or_default().to_owned();
            let target = p["target_on"].as_str().unwrap_or_default().to_owned();
            vec![
                Cell::styled(s(p, "slug").to_owned(), out.bold(s(p, "slug"))),
                Cell::new(s(p, "name").to_owned()),
                Cell::styled(s(p, "state").to_owned(), out.dim(s(p, "state"))),
                health_cell(out, s(p, "health")),
                Cell::styled(lead.clone(), out.dim(&lead)),
                Cell::new(progress),
                Cell::styled(target.clone(), out.dim(&target)),
            ]
        })
        .collect();
    out.table(&["slug", "name", "state", "health", "lead", "done", "target"], &rows)
}

fn view(ctx: &Ctx, workspace: Option<&str>, args: ProjectViewArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    let url = project_url(&place, &args.slug);
    if args.web {
        return super::browse::open(ctx, &url);
    }
    let mut detail = place.client.op("get_work_project").arg("workspace", &place.workspace).arg("project", &args.slug).send()?;
    detail["url"] = Value::String(url.clone());
    if ctx.out.structured() {
        return ctx.out.emit(&detail);
    }
    let out = &ctx.out;
    let project = &detail["project"];
    let icon = project["icon"].as_str().map(|icon| format!("{icon} ")).unwrap_or_default();
    println!("{icon}{} {}", out.bold(s(project, "name")), out.dim(s(project, "slug")));
    let mut facts = vec![s(project, "state").to_owned()];
    if let Some(lead) = project["lead"].as_str() {
        facts.push(format!("lead {lead}"));
    }
    match (project["start_on"].as_str(), project["target_on"].as_str()) {
        (Some(start), Some(target)) => facts.push(format!("{start} → {target}")),
        (None, Some(target)) => facts.push(format!("target {target}")),
        (Some(start), None) => facts.push(format!("from {start}")),
        (None, None) => {}
    }
    let health = s(project, "health");
    if !health.is_empty() {
        facts.push(health_cell(out, health).shown);
    }
    let done = project["closed_items"].as_u64().unwrap_or_default();
    let total = done + project["open_items"].as_u64().unwrap_or_default();
    facts.push(format!("{done} of {total} done"));
    println!("{}", facts.join(" · "));
    if project["archived_at"].is_string() {
        println!("{}", out.yellow("Archived."));
    }
    if let Some(summary) = project["summary"].as_str().filter(|summary| !summary.is_empty()) {
        println!("{summary}");
    }
    println!();
    match project["brief"].as_str().filter(|brief| !brief.trim().is_empty()) {
        Some(brief) => println!("{}", brief.trim_end()),
        None => println!("{}", out.dim(&format!("No brief yet: g1t project edit {} --brief-file FILE.", s(project, "slug")))),
    }
    // Its open work items, Now first, each with where it is on its hill.
    let open = detail["open"].as_array().cloned().unwrap_or_default();
    let progress = detail["progress"].as_array().cloned().unwrap_or_default();
    println!();
    println!("{}", out.bold("Open work items"));
    if open.is_empty() {
        println!("  {}", out.dim("None open."));
    }
    for item in &open {
        let number = item["number"].as_u64().unwrap_or_default();
        let hill = progress
            .iter()
            .find(|p| p["number"].as_u64() == Some(number))
            .and_then(|p| p["hill"].as_str())
            .map(|hill| hill.replace('_', " "))
            .unwrap_or_default();
        let horizon = s(item, "horizon").replace('_', " ");
        println!("  {} {}  {}", out.green(&format!("#{number}")), s(item, "title"), out.dim(&format!("{horizon} · {hill}")));
    }
    let milestones = detail["milestones"].as_array().cloned().unwrap_or_default();
    if !milestones.is_empty() {
        println!();
        println!("{}", out.bold("Milestones"));
        for m in &milestones {
            let done = m["closed_items"].as_u64().unwrap_or_default();
            let total = done + m["open_items"].as_u64().unwrap_or_default();
            let due = m["due_on"].as_str().map(|due| format!(" · due {due}")).unwrap_or_default();
            println!("  {} {}", s(m, "title"), out.dim(&format!("{done}/{total}{due}")));
        }
    }
    println!();
    println!("{}", out.bold("People"));
    let members = detail["members"].as_array().cloned().unwrap_or_default();
    if members.is_empty() {
        println!("  {}", out.dim("Nobody yet."));
    }
    for m in &members {
        let role = if s(m, "role") == "lead" { out.dim(" (lead)") } else { String::new() };
        println!("  {}{role}", s(m, "username"));
    }
    println!();
    println!("{}", out.bold("Repositories"));
    let repos = detail["repos"].as_array().cloned().unwrap_or_default();
    if repos.is_empty() {
        println!("  {}", out.dim("None named yet."));
    }
    for r in &repos {
        let target = if r["default_target"].as_bool() == Some(true) { out.dim(" (default target)") } else { String::new() };
        println!("  {}{target}", s(r, "path"));
    }
    println!();
    println!("{}", out.dim(&url));
    Ok(())
}

fn create(ctx: &Ctx, workspace: Option<&str>, args: ProjectCreateArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    let name = match args.name {
        Some(name) => name,
        None if prompt::interactive() => prompt::input("Name:", None)?,
        None => return Err(prompt::needed("A name", "--name")),
    };
    if name.trim().is_empty() {
        return Err(Error::usage("The name is empty."));
    }
    let call = place.client.op("create_work_project").arg("workspace", &place.workspace).field("name", name.trim()).field_opt("slug", args.slug);
    let (call, _) = with_fields(ctx, &place, call, &args.fields)?;
    let made = call.send()?;
    let slug = s(&made, "slug").to_owned();
    for login in &args.add_member {
        add_member(ctx, &place, &slug, login)?;
    }
    for repo in &args.add_repo {
        add_repo(&place, &slug, repo)?;
    }
    let url = project_url(&place, &slug);
    super::done(ctx, &made, &format!("Created the {} project ({slug})", s(&made, "name")), &url)
}

fn add_member(ctx: &Ctx, place: &Place, slug: &str, login: &str) -> Result<Value> {
    let who = super::who(ctx, &place.client, login)?;
    place
        .client
        .op("add_work_project_member")
        .arg("workspace", &place.workspace)
        .arg("project", slug)
        .arg("username", &who)
        .send()
}

fn add_repo(place: &Place, slug: &str, repo: &str) -> Result<Value> {
    place
        .client
        .op("add_work_project_repo")
        .arg("workspace", &place.workspace)
        .arg("project", slug)
        .field("repo", repo.trim())
        .send()
}

fn edit(ctx: &Ctx, workspace: Option<&str>, args: ProjectEditArgs) -> Result<()> {
    let place = place(ctx, workspace)?;
    let mut slug = args.slug.trim().to_owned();
    let call = place
        .client
        .op("update_work_project")
        .arg("workspace", &place.workspace)
        .arg("project", &slug)
        .field_opt("name", args.name.clone())
        .field_opt("slug", args.new_slug.clone());
    let (call, fields_changed) = with_fields(ctx, &place, call, &args.fields)?;
    let mut changed = false;
    let mut result = Value::Null;
    if fields_changed || args.name.is_some() || args.new_slug.is_some() {
        result = call.send()?;
        slug = s(&result, "slug").to_owned();
        changed = true;
    }
    for login in &args.add_member {
        add_member(ctx, &place, &slug, login)?;
        changed = true;
    }
    for login in &args.remove_member {
        let who = super::who(ctx, &place.client, login)?;
        place
            .client
            .op("remove_work_project_member")
            .arg("workspace", &place.workspace)
            .arg("project", &slug)
            .arg("username", &who)
            .send()?;
        changed = true;
    }
    for repo in &args.add_repo {
        add_repo(&place, &slug, repo)?;
        changed = true;
    }
    for repo in &args.remove_repo {
        place
            .client
            .op("remove_work_project_repo")
            .arg("workspace", &place.workspace)
            .arg("project", &slug)
            .query("repo", repo.trim())
            .send()?;
        changed = true;
    }
    if args.archive || args.unarchive {
        result = place
            .client
            .op("archive_work_project")
            .arg("workspace", &place.workspace)
            .arg("project", &slug)
            .field("archived", args.archive)
            .send()?;
        changed = true;
    }
    if !changed {
        return Err(Error::usage(
            "Nothing to change: pass --name, --summary, --brief, --lead, --state, --health, --target-on, --add-member, --add-repo or --archive.",
        ));
    }
    if result.is_null() {
        result = place.client.op("get_work_project").arg("workspace", &place.workspace).arg("project", &slug).send()?;
    }
    super::done(ctx, &result, &format!("Edited the {slug} project"), &project_url(&place, &slug))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appetite_and_health_read_as_people_write_them() {
        assert_eq!(appetite_value("M").unwrap(), json!("medium"));
        assert_eq!(appetite_value("none").unwrap(), Value::Null);
        assert!(appetite_value("huge").is_err());
        assert_eq!(health_value("at-risk").unwrap(), json!("at_risk"));
        assert_eq!(health_value("On track").unwrap(), json!("on_track"));
        assert_eq!(health_value("none").unwrap(), Value::Null);
        assert!(health_value("fine").is_err());
        assert_eq!(health_label("off_track"), "off track");
    }
}
