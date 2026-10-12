//! `g1t status`: what needs you, across every repository you can see.

use serde_json::{Value, json};

use crate::client::Client;
use crate::context::Ctx;
use crate::error::Result;
use crate::output::{Output, ago, s};

fn search_pulls(client: &Client, me: &str) -> Result<Vec<Value>> {
    let found = client
        .op("search")
        .query("q", format!("is:pr is:open author:{me}"))
        .query("type", "pulls")
        .query("per_page", 20)
        .send()?;
    Ok(super::items(found, "hits"))
}

fn notifications(client: &Client, reason: &str) -> Result<Vec<Value>> {
    let found = client
        .op("list_notifications")
        .query("reason", reason)
        .query("per_page", 20)
        .send()?;
    Ok(super::items(found, "items"))
}

/// Each pull request's checks, looked up side by side.
fn with_checks(client: &Client, pulls: Vec<Value>) -> Vec<Value> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = pulls
            .into_iter()
            .map(|hit| {
                scope.spawn(move || {
                    let repo = hit["repo"]
                        .as_str()
                        .and_then(|r| crate::repo::Repo::parse(r, &client.host.name).ok());
                    let number = hit["number"].as_u64();
                    let mut hit = hit;
                    if let (Some(repo), Some(n)) = (repo, number)
                        && let Ok(found) = client
                            .op("get_pull_request")
                            .repo(&repo)
                            .arg("number", n)
                            .send()
                    {
                        let pull = found.get("pull").cloned().unwrap_or(found);
                        hit["check_status"] = pull["check_status"].clone();
                        hit["status"] = pull["status"].clone();
                        hit["head_commit"] = pull["head_commit"].clone();
                    }
                    hit
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

/// Your active sessions and claims in the current repository, when there
/// is one: none outside a repository, or from a server without them.
fn here(ctx: &Ctx, me: &str) -> (Option<String>, Vec<Value>, Vec<Value>) {
    let Ok((repo, client)) = ctx.repo_client() else {
        return (None, Vec::new(), Vec::new());
    };
    if !client.has_token() {
        return (None, Vec::new(), Vec::new());
    }
    let client = client.with_timeouts(std::time::Duration::from_secs(5), super::QUICK);
    let fetch = |op: &str, key: &str| -> Vec<Value> {
        client
            .op(op)
            .repo(&repo)
            .query("state", "active")
            .send()
            .map(|found| super::items(found, key))
            .unwrap_or_default()
            .into_iter()
            .filter(|item| super::login_of(item).eq_ignore_ascii_case(me))
            .collect()
    };
    let (sessions, claims) = std::thread::scope(|scope| {
        let sessions = scope.spawn(|| fetch("list_sessions", "sessions"));
        let claims = scope.spawn(|| fetch("list_claims", "claims"));
        (sessions.join().unwrap_or_default(), claims.join().unwrap_or_default())
    });
    (Some(repo.to_string()), sessions, claims)
}

fn section(
    out: &Output,
    title: &str,
    items: &[Value],
    empty: &str,
    line: impl Fn(&Value) -> String,
) {
    println!("{}", out.bold(title));
    if items.is_empty() {
        println!("  {}", out.dim(empty));
    }
    for item in items {
        println!("  {}", line(item));
    }
    println!();
}

pub fn run(ctx: &Ctx) -> Result<()> {
    let client = ctx.signed_in_client()?;
    let me = ctx.me(&client)?;
    let (pulls, reviews, assigned, ci, here) = std::thread::scope(|scope| {
        let pulls = scope.spawn(|| search_pulls(&client, &me).map(|p| with_checks(&client, p)));
        let reviews = scope.spawn(|| notifications(&client, "review_requested"));
        let assigned = scope.spawn(|| notifications(&client, "assign"));
        let ci = scope.spawn(|| notifications(&client, "ci_activity"));
        let here = scope.spawn(|| here(ctx, &me));
        (pulls.join(), reviews.join(), assigned.join(), ci.join(), here.join())
    });
    let (repo, sessions, claims) = here.unwrap_or((None, Vec::new(), Vec::new()));
    let unwrap = |r: std::thread::Result<Result<Vec<Value>>>| -> Result<Vec<Value>> {
        r.unwrap_or_else(|_| Err(crate::error::Error::failed("A lookup failed.")))
    };
    let pulls = unwrap(pulls)?;
    let reviews = unwrap(reviews)?;
    let assigned = unwrap(assigned)?;
    let ci: Vec<Value> = unwrap(ci)?
        .into_iter()
        .filter(|n| n["severity"] == "error")
        .collect();
    let failing: Vec<Value> = pulls
        .iter()
        .filter(|p| {
            matches!(
                p["check_status"].as_str(),
                Some("failed" | "failure" | "error")
            )
        })
        .cloned()
        .collect();
    if ctx.out.structured() {
        return ctx.out.emit(&json!({
            "user": me,
            "pulls": pulls,
            "review_requests": reviews,
            "assigned": assigned,
            "failing_checks": failing,
            "ci_failures": ci,
            "repo": repo,
            "sessions": sessions,
            "claims": claims,
        }));
    }
    let out = &ctx.out;
    let pull_line = |p: &Value| {
        let checks = p["check_status"]
            .as_str()
            .map(|c| format!(" {}", out.state(c)))
            .unwrap_or_default();
        format!(
            "{} {}{checks}",
            out.cyan(&format!("{}#{}", s(p, "repo"), p["number"])),
            s(p, "title")
        )
    };
    let note_line = |n: &Value| {
        let place = match n["number"].as_u64() {
            Some(num) => format!("{}#{num}", s(n, "repo")),
            None => s(n, "repo").to_owned(),
        };
        format!(
            "{} {} {}",
            out.cyan(&place),
            s(n, "title"),
            out.dim(&ago(s(n, "updated_at")))
        )
    };
    section(out, "Your open pull requests", &pulls, "None.", pull_line);
    section(out, "Reviews asked of you", &reviews, "None.", note_line);
    section(out, "Assigned to you", &assigned, "Nothing.", note_line);
    let mut broken: Vec<String> = failing.iter().map(pull_line).collect();
    broken.extend(ci.iter().map(note_line));
    println!("{}", out.bold("Failing checks"));
    if broken.is_empty() {
        println!("  {}", out.dim("None."));
    }
    for line in broken {
        println!("  {line}");
    }
    if let Some(repo) = repo {
        println!();
        section(out, &format!("Your sessions in {repo}"), &sessions, "None.", |session| {
            let on = [
                session["issue"].as_u64().map(|n| format!("#{n}")),
                session["branch"].as_str().map(str::to_owned),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
            format!("{} {} {} {}", s(session, "id"), out.state(s(session, "state")), s(session, "harness"), on)
                .trim_end()
                .to_owned()
        });
        println!("{}", out.bold(&format!("Your claims in {repo}")));
        if claims.is_empty() {
            println!("  {}", out.dim("None."));
        }
        for claim in &claims {
            println!("  {}", super::work::claim_line(out, claim));
        }
    }
    Ok(())
}
