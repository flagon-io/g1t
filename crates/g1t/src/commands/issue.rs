//! `g1t issue`.

use serde_json::{Value, json};

use crate::cli::{
    CloseReason, CommentArgs, IssueCloseArgs, IssueCommand, IssueCreateArgs, IssueEditArgs,
    IssueListArgs, IssueState, IssueViewArgs, ReopenArgs,
};
use crate::client::Client;
use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::output::{Cell, Output, ago, s};
use crate::prompt;
use crate::repo::Repo;

pub fn run(ctx: &Ctx, command: IssueCommand) -> Result<()> {
    match command {
        IssueCommand::List(args) => list(ctx, args),
        IssueCommand::View(args) => view(ctx, args),
        IssueCommand::Create(args) => create(ctx, args),
        IssueCommand::Comment(args) => comment(ctx, args),
        IssueCommand::Close(args) => close(ctx, args),
        IssueCommand::Reopen(args) => reopen(ctx, args),
        IssueCommand::Edit(args) => edit(ctx, args),
    }
}

pub fn issue_url(site: &str, repo: &Repo, number: u64) -> String {
    format!("{site}/{}/{}/issues/{number}", repo.owner, repo.name)
}

fn names(list: &Value) -> Vec<String> {
    list.as_array()
        .map(|l| {
            l.iter()
                .filter_map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .or_else(|| v["username"].as_str().map(str::to_owned))
                        .or_else(|| v["name"].as_str().map(str::to_owned))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn list(ctx: &Ctx, args: IssueListArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let state = match args.state {
        IssueState::Open => Some("open"),
        IssueState::Closed => Some("closed"),
        IssueState::All => None,
    };
    let found = client
        .op("list_issues")
        .repo(&repo)
        .query_opt("state", state)
        .query_opt("label", args.label.clone())
        .query_opt("milestone", args.milestone)
        .send()?;
    let mut issues = super::items(found, "issues");
    if let Some(a) = &args.assignee {
        let who = super::who(ctx, &client, a)?;
        issues.retain(|i| {
            names(&i["assignees"])
                .iter()
                .any(|n| n.eq_ignore_ascii_case(&who))
        });
    }
    if let Some(a) = &args.author {
        let who = super::who(ctx, &client, a)?;
        issues.retain(|i| {
            i["author"]["username"]
                .as_str()
                .is_some_and(|n| n.eq_ignore_ascii_case(&who))
        });
    }
    issues.truncate(args.limit);
    if ctx.out.structured() {
        return ctx.out.emit(&Value::Array(issues));
    }
    if issues.is_empty() {
        eprintln!("No {} issues in {repo}.", state.unwrap_or("matching"));
        return Ok(());
    }
    print_list(&ctx.out, &issues)
}

pub fn print_list(out: &Output, issues: &[Value]) -> Result<()> {
    let rows: Vec<Vec<Cell>> = issues
        .iter()
        .map(|i| {
            let number = format!("#{}", i["number"]);
            let state = s(i, "state");
            let labels = names(&i["labels"]).join(", ");
            vec![
                Cell::styled(
                    number.clone(),
                    if state == "open" {
                        out.green(&number)
                    } else {
                        out.dim(&number)
                    },
                ),
                Cell::new(s(i, "title")),
                Cell::styled(labels.clone(), out.dim(&labels)),
                Cell::styled(ago(s(i, "updated_at")), out.dim(&ago(s(i, "updated_at")))),
            ]
        })
        .collect();
    out.table(&["number", "title", "labels", "updated"], &rows)
}

fn view(ctx: &Ctx, args: IssueViewArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    if args.web {
        return super::browse::open(ctx, &issue_url(&client.host.site, &repo, args.number));
    }
    let found = client
        .op("get_issue")
        .repo(&repo)
        .arg("number", args.number)
        .send()?;
    // One object: the issue, with its comments and pull requests in it.
    let mut issue = found.get("issue").cloned().unwrap_or_else(|| found.clone());
    if let Some(map) = issue.as_object_mut() {
        map.insert(
            "comments".into(),
            found.get("comments").cloned().unwrap_or(json!([])),
        );
        map.insert(
            "pulls".into(),
            found.get("pulls").cloned().unwrap_or(json!([])),
        );
        map.insert(
            "url".into(),
            Value::String(issue_url(&client.host.site, &repo, args.number)),
        );
    }
    if ctx.out.structured() {
        return ctx.out.emit(&issue);
    }
    let out = &ctx.out;
    println!(
        "{} {}",
        out.bold(s(&issue, "title")),
        out.dim(&format!("{repo}#{}", args.number))
    );
    let mut facts = vec![
        out.state(s(&issue, "state")),
        format!(
            "opened by {} {}",
            s(&issue["author"], "username"),
            ago(s(&issue, "created_at"))
        ),
    ];
    let comments = issue["comments"]
        .as_array()
        .map(|c| c.iter().filter(|c| c["kind"] == "comment").count())
        .unwrap_or(0);
    facts.push(format!("{comments} comment(s)"));
    println!("{}", facts.join(" · "));
    let labels = names(&issue["labels"]);
    if !labels.is_empty() {
        println!("{} {}", out.dim("Labels:"), labels.join(", "));
    }
    let assignees = names(&issue["assignees"]);
    if !assignees.is_empty() {
        println!("{} {}", out.dim("Assignees:"), assignees.join(", "));
    }
    if let Some(m) = issue["milestone"]["title"].as_str() {
        println!("{} {m}", out.dim("Milestone:"));
    }
    if let Some(pulls) = issue["pulls"].as_array().filter(|p| !p.is_empty()) {
        let list: Vec<String> = pulls
            .iter()
            .map(|p| format!("#{} {}", p["number"], out.state(s(p, "status"))))
            .collect();
        println!("{} {}", out.dim("Pull requests:"), list.join(", "));
    }
    println!();
    match issue["body"].as_str().filter(|b| !b.trim().is_empty()) {
        Some(body) => println!("{}", body.trim_end()),
        None => println!("{}", out.dim("No description.")),
    }
    if args.comments {
        print_comments(out, &issue["comments"]);
    } else if comments > 0 {
        println!();
        println!(
            "{}",
            out.dim(&format!(
                "{comments} comment(s): g1t issue view {} --comments",
                args.number
            ))
        );
    }
    println!();
    println!("{}", out.dim(s(&issue, "url")));
    Ok(())
}

pub fn print_comments(out: &Output, comments: &Value) {
    for c in comments.as_array().into_iter().flatten() {
        let who = s(&c["author"], "username");
        let when = ago(s(c, "created_at"));
        if c["kind"] == "event" {
            println!("{}", out.dim(&format!("  {who} {} {when}", s(c, "body"))));
            continue;
        }
        println!();
        let verdict = match c["verdict"].as_str() {
            Some(v) => format!(
                " {}",
                out.state(if v == "approve" { "approved" } else { v })
            ),
            None => String::new(),
        };
        let place = match (c["path"].as_str(), c["line"].as_u64()) {
            (Some(p), Some(l)) => out.dim(&format!(" on {p}:{l}")),
            (Some(p), None) => out.dim(&format!(" on {p}")),
            _ => String::new(),
        };
        println!("{}{verdict}{place} {}", out.bold(who), out.dim(&when));
        for line in s(c, "body").trim_end().lines() {
            println!("  {line}");
        }
    }
}

fn create(ctx: &Ctx, args: IssueCreateArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    if args.web {
        return super::browse::open(
            ctx,
            &format!(
                "{}/{}/{}/issues/new",
                client.host.site, repo.owner, repo.name
            ),
        );
    }
    let title = match args.title {
        Some(t) => t,
        None if prompt::interactive() => prompt::input("Title:", None)?,
        None => return Err(prompt::needed("A title", "--title")),
    };
    if title.trim().is_empty() {
        return Err(Error::usage("The title is empty."));
    }
    let body = prompt::body(
        args.body.body,
        args.body.body_file.as_deref(),
        args.body.body_file.is_none() && prompt::interactive() && !ctx.out.structured(),
    )?;
    let labels: Vec<Value> = args
        .label
        .iter()
        .map(|l| Value::String(l.clone()))
        .collect();
    let made = client
        .op("create_issue")
        .repo(&repo)
        .field("title", title)
        .field_opt("body", body)
        .field_opt(
            "labels",
            (!labels.is_empty()).then_some(Value::Array(labels)),
        )
        .field_opt("milestone", args.milestone)
        .send()?;
    let number = made["number"].as_u64().unwrap_or_default();
    let made = if args.assignee.is_empty() {
        made
    } else {
        let who: Vec<Value> = args
            .assignee
            .iter()
            .map(|a| super::who(ctx, &client, a).map(Value::String))
            .collect::<Result<_>>()?;
        client
            .op("update_issue")
            .repo(&repo)
            .arg("number", number)
            .field("assignees", Value::Array(who))
            .send()?
    };
    done(
        ctx,
        &made,
        &format!("Opened {repo}#{number}"),
        &issue_url(&client.host.site, &repo, number),
    )
}

/// Prints what was done: the object as JSON, or a line and its address.
pub fn done(ctx: &Ctx, value: &Value, said: &str, url: &str) -> Result<()> {
    if ctx.out.structured() {
        return ctx.out.emit(value);
    }
    eprintln!("{} {said}", ctx.out.green("✓"));
    println!("{url}");
    Ok(())
}

pub fn comment_on(
    ctx: &Ctx,
    client: &Client,
    repo: &Repo,
    number: u64,
    args: CommentArgs,
    url: &str,
) -> Result<()> {
    let body = prompt::body(args.body.body, args.body.body_file.as_deref(), true)?
        .filter(|b| !b.trim().is_empty())
        .ok_or_else(|| prompt::needed("The comment", "--body or --body-file"))?;
    let made = client
        .op("add_comment")
        .repo(repo)
        .arg("number", number)
        .field("body", body)
        .send()?;
    let id = s(&made, "id").to_owned();
    done(
        ctx,
        &made,
        &format!("Commented on {repo}#{number}"),
        &format!("{url}#{id}"),
    )
}

fn comment(ctx: &Ctx, args: CommentArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let number = args
        .number
        .ok_or_else(|| Error::usage("Which issue? Give its number."))?;
    let url = issue_url(&client.host.site, &repo, number);
    comment_on(ctx, &client, &repo, number, args, &url)
}

fn close(ctx: &Ctx, args: IssueCloseArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    if let Some(text) = args.comment {
        client
            .op("add_comment")
            .repo(&repo)
            .arg("number", args.number)
            .field("body", text)
            .send()?;
    }
    let reason = args.reason.map(|r| match r {
        CloseReason::Completed => "completed",
        CloseReason::NotPlanned => "not_planned",
    });
    let closed = client
        .op("close_issue")
        .repo(&repo)
        .arg("number", args.number)
        .field_opt("reason", reason)
        .send()?;
    done(
        ctx,
        &closed,
        &format!("Closed {repo}#{}", args.number),
        &issue_url(&client.host.site, &repo, args.number),
    )
}

fn reopen(ctx: &Ctx, args: ReopenArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    if let Some(text) = args.comment {
        client
            .op("add_comment")
            .repo(&repo)
            .arg("number", args.number)
            .field("body", text)
            .send()?;
    }
    let opened = client
        .op("reopen_issue")
        .repo(&repo)
        .arg("number", args.number)
        .send()?;
    done(
        ctx,
        &opened,
        &format!("Reopened {repo}#{}", args.number),
        &issue_url(&client.host.site, &repo, args.number),
    )
}

/// `current` with `add` put in and `remove` taken out, compared without case.
pub fn adjust(current: Vec<String>, add: &[String], remove: &[String]) -> Vec<String> {
    let mut out: Vec<String> = current
        .into_iter()
        .filter(|c| !remove.iter().any(|r| r.eq_ignore_ascii_case(c)))
        .collect();
    for a in add {
        if !out.iter().any(|c| c.eq_ignore_ascii_case(a)) {
            out.push(a.clone());
        }
    }
    out
}

fn edit(ctx: &Ctx, args: IssueEditArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let body = prompt::body(args.body.body, args.body.body_file.as_deref(), false)?;
    let mut call = client
        .op("update_issue")
        .repo(&repo)
        .arg("number", args.number);
    let mut changed = false;
    if let Some(t) = args.title {
        call = call.field("title", t);
        changed = true;
    }
    if let Some(b) = body {
        call = call.field("body", b);
        changed = true;
    }
    let touches_lists = !(args.add_label.is_empty()
        && args.remove_label.is_empty()
        && args.add_assignee.is_empty()
        && args.remove_assignee.is_empty());
    if touches_lists {
        let found = client
            .op("get_issue")
            .repo(&repo)
            .arg("number", args.number)
            .send()?;
        let issue = found.get("issue").unwrap_or(&found);
        if !(args.add_label.is_empty() && args.remove_label.is_empty()) {
            let labels = adjust(names(&issue["labels"]), &args.add_label, &args.remove_label);
            call = call.field("labels", json!(labels));
        }
        if !(args.add_assignee.is_empty() && args.remove_assignee.is_empty()) {
            let add: Vec<String> = args
                .add_assignee
                .iter()
                .map(|a| super::who(ctx, &client, a))
                .collect::<Result<_>>()?;
            let remove: Vec<String> = args
                .remove_assignee
                .iter()
                .map(|a| super::who(ctx, &client, a))
                .collect::<Result<_>>()?;
            call = call.field(
                "assignees",
                json!(adjust(names(&issue["assignees"]), &add, &remove)),
            );
        }
        changed = true;
    }
    if let Some(m) = args.milestone {
        call = call.field("milestone", m);
        changed = true;
    }
    if args.remove_milestone {
        call = call.field("milestone", Value::Null);
        changed = true;
    }
    if !changed {
        return Err(Error::usage(
            "Nothing to change: pass --title, --body, --add-label, --add-assignee or --milestone.",
        ));
    }
    let updated = call.send()?;
    done(
        ctx,
        &updated,
        &format!("Edited {repo}#{}", args.number),
        &issue_url(&client.host.site, &repo, args.number),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_are_adjusted_without_case() {
        let have = vec!["bug".to_owned(), "docs".to_owned()];
        assert_eq!(
            adjust(have.clone(), &["Bug".into(), "p1".into()], &["DOCS".into()]),
            vec!["bug".to_owned(), "p1".to_owned()]
        );
        assert_eq!(
            adjust(have, &[], &[]),
            vec!["bug".to_owned(), "docs".to_owned()]
        );
    }

    #[test]
    fn names_come_from_strings_or_objects() {
        assert_eq!(
            names(&json!(["a", { "username": "b" }, { "name": "c" }])),
            vec!["a", "b", "c"]
        );
    }
}
