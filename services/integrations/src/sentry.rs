//! Sentry: issues it reports become g1t issues, the latest event's stack
//! trace goes with them, and the Sentry issue is resolved when the fix
//! lands.
//!
//! Connected as a Sentry internal integration: its webhook points at the
//! connection's address and is signed with the integration's client
//! secret; its token reads events and resolves issues.

use g1t_contracts::integrations::{ConnectionConfig, ContextItem, Provider};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde_json::{Value, json};
use worker::{Method, Result};

use crate::alerts::{Action, Signal};
use crate::http::{self, Answer};

fn site(config: &ConnectionConfig) -> String {
    config
        .site
        .as_deref()
        .unwrap_or("https://sentry.io")
        .trim_end_matches('/')
        .to_owned()
}

async fn call(config: &ConnectionConfig, token: &str, method: Method, path: &str, body: Option<Value>) -> Result<Answer> {
    let auth = format!("Bearer {token}");
    http::send(
        method,
        &format!("{}/api/0{path}", site(config)),
        &[("authorization", &auth)],
        body.map(|body| body.to_string()),
    )
    .await
}

fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// The address people open the issue at.
fn web_url(config: &ConnectionConfig, issue: &Value, id: &str) -> String {
    text(&issue["web_url"])
        .or_else(|| text(&issue["permalink"]))
        .unwrap_or_else(|| match &config.organization {
            Some(org) => format!("https://{org}.sentry.io/issues/{id}/"),
            None => format!("{}/issues/{id}/", site(config)),
        })
}

/// What a webhook from Sentry asks for, or why it asks for nothing.
pub fn signal(resource: &str, payload: &Value, config: &ConnectionConfig) -> std::result::Result<Signal, String> {
    let action = payload["action"].as_str().unwrap_or_default();
    let event = format!("{resource}.{action}");
    let (issue, act) = match (resource, action) {
        ("issue", "created") => (&payload["data"]["issue"], Action::Open),
        // A regression: Sentry saw it again after it was resolved.
        ("issue", "unresolved") => (&payload["data"]["issue"], Action::Reopen),
        ("event_alert", "triggered") => (&payload["data"]["event"], Action::Open),
        ("installation", _) => return Err("Sentry installed the integration.".to_owned()),
        _ => return Err(format!("g1t does nothing with {event}.")),
    };
    let id = text(&issue["id"])
        .filter(|_| resource == "issue")
        .or_else(|| text(&issue["issue_id"]))
        .ok_or_else(|| "The payload names no issue.".to_owned())?;
    let title = text(&issue["title"]).unwrap_or_else(|| "A problem Sentry reported".to_owned());
    let key = text(&issue["shortId"]).unwrap_or_else(|| format!("Sentry {id}"));
    let mut facts = vec![format!("**Sentry** · [{key}]({})", web_url(config, issue, &id))];
    if let Some(level) = text(&issue["level"]) {
        facts.push(level);
    }
    let count = text(&issue["count"]).and_then(|count| count.parse::<u32>().ok());
    if let Some(count) = count {
        facts.push(format!("{count} {}", if count == 1 { "event" } else { "events" }));
    }
    if let Some(users) = issue["userCount"].as_u64().filter(|users| *users > 0) {
        facts.push(format!("{users} {}", if users == 1 { "user" } else { "users" }));
    }
    let mut body = vec![facts.join(" · ")];
    if let Some(project) = text(&issue["project"]["slug"]).or_else(|| text(&issue["project"])) {
        body.push(format!("Project `{project}`."));
    }
    let what = [text(&issue["metadata"]["type"]), text(&issue["metadata"]["value"])]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(": ");
    if !what.is_empty() {
        body.push(format!("> {}", http::shorten(&what, 600).replace('\n', "\n> ")));
    }
    if let Some(culprit) = text(&issue["culprit"]) {
        body.push(format!("In `{culprit}`."));
    }
    // An alert carries its event, and with it the stack trace.
    if let Some(trace) = stack_trace(issue) {
        body.push(trace);
    }
    Ok(Signal {
        event,
        action: act,
        external_id: id,
        key,
        title,
        url: web_url(config, issue, &text(&issue["id"]).unwrap_or_default()),
        body: body.join("\n\n"),
        count,
    })
}

/// The frames of an event's exceptions, newest last, as a code block.
/// Takes both the API's form (`entries`) and the raw event's
/// (`exception.values`).
pub fn stack_trace(event: &Value) -> Option<String> {
    let values: Vec<&Value> = event["entries"]
        .as_array()
        .and_then(|entries| entries.iter().find(|entry| entry["type"] == "exception"))
        .and_then(|entry| entry["data"]["values"].as_array())
        .or_else(|| event["exception"]["values"].as_array())
        .map(|values| values.iter().collect())
        .unwrap_or_default();
    let mut lines = Vec::new();
    for value in values {
        let frames = value["stacktrace"]["frames"].as_array().cloned().unwrap_or_default();
        let in_app: Vec<&Value> = frames
            .iter()
            .filter(|frame| frame["inApp"].as_bool().or(frame["in_app"].as_bool()) == Some(true))
            .collect();
        let shown: Vec<&Value> = if in_app.is_empty() { frames.iter().collect() } else { in_app };
        let skip = shown.len().saturating_sub(12);
        if let Some(kind) = text(&value["type"]) {
            lines.push(format!("{kind}: {}", text(&value["value"]).unwrap_or_default()));
        }
        for (at, frame) in shown.iter().enumerate().skip(skip) {
            let file = text(&frame["filename"]).or_else(|| text(&frame["absPath"])).unwrap_or_else(|| "?".to_owned());
            let line = frame["lineNo"].as_u64().or(frame["lineno"].as_u64());
            let function = text(&frame["function"]).unwrap_or_else(|| "?".to_owned());
            lines.push(format!(
                "  {file}{} in {function}",
                line.map(|line| format!(":{line}")).unwrap_or_default()
            ));
            // The line itself, for the frame the error was raised in.
            if at + 1 == shown.len()
                && let Some(code) = frame["context"]
                    .as_array()
                    .and_then(|context| context.iter().find(|pair| pair[0].as_u64() == line))
                    .and_then(|pair| pair[1].as_str())
            {
                lines.push(format!("    > {}", code.trim()));
            }
        }
    }
    (!lines.is_empty()).then(|| format!("Stack trace, most recent call last:\n\n```\n{}\n```", lines.join("\n")))
}

/// The stack trace of the issue's latest event, read with the token.
pub async fn latest_trace(config: &ConnectionConfig, token: &str, id: &str) -> Result<Option<String>> {
    let Some(org) = &config.organization else {
        return Ok(None);
    };
    let answer = call(config, token, Method::Get, &format!("/organizations/{org}/issues/{id}/events/latest/"), None).await?;
    Ok(answer.ok().then(|| stack_trace(&answer.json())).flatten())
}

/// A Sentry issue as it is now.
pub async fn fetch(config: &ConnectionConfig, token: &str, id: &str) -> Result<std::result::Result<Option<ContextItem>, String>> {
    let Some(org) = &config.organization else {
        return Ok(Err("The Sentry connection names no organization.".to_owned()));
    };
    let answer = call(config, token, Method::Get, &format!("/organizations/{org}/issues/{id}/"), None).await?;
    if answer.status == 404 {
        return Ok(Ok(None));
    }
    if !answer.ok() {
        return Ok(Err(answer.problem("Sentry")));
    }
    let issue = answer.json();
    let mut body = Vec::new();
    if let Some(culprit) = text(&issue["culprit"]) {
        body.push(format!("In `{culprit}`."));
    }
    if let Some(count) = text(&issue["count"]) {
        body.push(format!("{count} events, last seen {}.", text(&issue["lastSeen"]).unwrap_or_default()));
    }
    if let Some(trace) = latest_trace(config, token, id).await? {
        body.push(trace);
    }
    Ok(Ok(Some(ContextItem {
        provider: Provider::Sentry,
        key: text(&issue["shortId"]).unwrap_or_else(|| id.to_owned()),
        title: text(&issue["title"]).unwrap_or_default(),
        url: web_url(config, &issue, id),
        status: text(&issue["status"]),
        body: http::shorten(&body.join("\n\n"), 6000),
        fetched_at: rfc3339(now_ms()),
    })))
}

/// Marks the Sentry issue resolved and says why. `Err` with what went
/// wrong, for the connection to show.
pub async fn resolve(config: &ConnectionConfig, token: &str, id: &str, note: &str) -> Result<std::result::Result<(), String>> {
    let Some(org) = &config.organization else {
        return Ok(Err("The Sentry connection names no organization.".to_owned()));
    };
    let answer = call(
        config,
        token,
        Method::Put,
        &format!("/organizations/{org}/issues/{id}/"),
        Some(json!({ "status": "resolved" })),
    )
    .await?;
    if !answer.ok() {
        return Ok(Err(answer.problem("Sentry")));
    }
    comment(config, token, id, note).await
}

pub async fn comment(config: &ConnectionConfig, token: &str, id: &str, note: &str) -> Result<std::result::Result<(), String>> {
    let answer = call(config, token, Method::Post, &format!("/issues/{id}/comments/"), Some(json!({ "text": note }))).await?;
    Ok(if answer.ok() { Ok(()) } else { Err(answer.problem("Sentry")) })
}

pub async fn test(config: &ConnectionConfig, token: &str) -> Result<std::result::Result<String, String>> {
    let Some(org) = &config.organization else {
        return Ok(Err("Name the Sentry organization, by its slug.".to_owned()));
    };
    let answer = call(config, token, Method::Get, &format!("/organizations/{org}/"), None).await?;
    Ok(if answer.ok() {
        Ok(format!("Connected to {}.", text(&answer.json()["name"]).unwrap_or_else(|| org.clone())))
    } else {
        Err(answer.problem("Sentry"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ConnectionConfig {
        ConnectionConfig {
            organization: Some("acme".to_owned()),
            ..ConnectionConfig::default()
        }
    }

    #[test]
    fn a_new_issue_opens_one() {
        let payload = json!({
            "action": "created",
            "data": { "issue": {
                "id": "4509", "shortId": "WEB-3F", "title": "TypeError: x is undefined",
                "culprit": "getUser(src/api/users.ts)", "level": "error", "count": "12", "userCount": 3,
                "project": { "slug": "web" },
                "metadata": { "type": "TypeError", "value": "x is undefined" }
            }}
        });
        let signal = signal("issue", &payload, &config()).unwrap();
        assert_eq!(signal.external_id, "4509");
        assert_eq!(signal.key, "WEB-3F");
        assert_eq!(signal.action, Action::Open);
        assert_eq!(signal.count, Some(12));
        assert_eq!(signal.url, "https://acme.sentry.io/issues/4509/");
        assert!(signal.body.contains("12 events · 3 users"));
        assert!(signal.body.contains("> TypeError: x is undefined"));
    }

    #[test]
    fn a_regression_reopens_and_other_actions_are_ignored() {
        let issue = json!({ "id": "1", "title": "t" });
        let reopened = signal("issue", &json!({ "action": "unresolved", "data": { "issue": issue } }), &config()).unwrap();
        assert_eq!(reopened.action, Action::Reopen);
        assert!(signal("issue", &json!({ "action": "assigned", "data": { "issue": issue } }), &config()).is_err());
        assert!(signal("installation", &json!({ "action": "created" }), &config()).is_err());
    }

    #[test]
    fn an_alert_brings_its_stack_trace() {
        let payload = json!({
            "action": "triggered",
            "data": { "event": {
                "issue_id": "77", "title": "boom", "web_url": "https://acme.sentry.io/issues/77/events/abc/",
                "exception": { "values": [{ "type": "Error", "value": "boom", "stacktrace": { "frames": [
                    { "filename": "node_modules/x.js", "lineno": 1, "function": "lib", "in_app": false },
                    { "filename": "src/a.ts", "lineno": 10, "function": "outer", "in_app": true },
                    { "filename": "src/b.ts", "lineno": 20, "function": "inner", "in_app": true,
                      "context": [[19, "  const y = 1;"], [20, "  throw new Error('boom');"]] }
                ]}}]}
            }}
        });
        let signal = signal("event_alert", &payload, &config()).unwrap();
        assert_eq!(signal.external_id, "77");
        assert!(signal.body.contains("src/a.ts:10 in outer\n  src/b.ts:20 in inner\n    > throw new Error('boom');"));
        assert!(!signal.body.contains("node_modules"));
    }
}
