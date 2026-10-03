//! Jira and Linear: a ticket key resolves to the ticket, and the ticket is
//! told when work on it starts and lands.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use g1t_contracts::integrations::{ConnectionConfig, ContextItem, Provider};
use g1t_contracts::time::rfc3339;
use g1t_kit::now_ms;
use serde_json::{Value, json};
use worker::{Method, Result};

use crate::http::{self, Answer};

/// A ticket, and the id its system's API takes for it.
pub struct Ticket {
    pub item: ContextItem,
    pub external_id: String,
}

/// `Ok(None)` when the system has no such ticket; `Err` with what went
/// wrong otherwise.
pub type Fetched = std::result::Result<Option<Ticket>, String>;

const MAX_BODY: usize = 8000;

// --- Jira ----------------------------------------------------------------

fn jira_site(config: &ConnectionConfig) -> String {
    config.site.as_deref().unwrap_or_default().trim_end_matches('/').to_owned()
}

async fn jira(config: &ConnectionConfig, token: &str, method: Method, path: &str, body: Option<Value>) -> Result<Answer> {
    let auth = format!(
        "Basic {}",
        STANDARD.encode(format!("{}:{token}", config.email.as_deref().unwrap_or_default()))
    );
    http::send(
        method,
        &format!("{}/rest/api/3{path}", jira_site(config)),
        &[("authorization", &auth)],
        body.map(|body| body.to_string()),
    )
    .await
}

/// Atlassian's document format, as plain text.
pub fn adf_text(node: &Value) -> String {
    match node["type"].as_str() {
        Some("text") => node["text"].as_str().unwrap_or_default().to_owned(),
        Some("hardBreak") => "\n".to_owned(),
        Some("mention") => node["attrs"]["text"].as_str().unwrap_or_default().to_owned(),
        Some("inlineCard") => node["attrs"]["url"].as_str().unwrap_or_default().to_owned(),
        kind => {
            let inner: Vec<String> = node["content"].as_array().map(|nodes| nodes.iter().map(adf_text).collect()).unwrap_or_default();
            match kind {
                Some("paragraph" | "heading" | "blockquote" | "rule") => format!("{}\n\n", inner.concat()),
                Some("listItem") => format!("- {}", inner.concat().trim_end()) + "\n",
                Some("bulletList" | "orderedList") => format!("{}\n", inner.concat()),
                Some("codeBlock") => format!("```\n{}\n```\n\n", inner.concat()),
                _ => inner.concat(),
            }
        }
    }
}

pub async fn jira_fetch(config: &ConnectionConfig, token: &str, key: &str) -> Result<Fetched> {
    let answer = jira(
        config,
        token,
        Method::Get,
        &format!("/issue/{key}?fields=summary,description,status,issuetype,priority,labels"),
        None,
    )
    .await?;
    if answer.status == 404 {
        return Ok(Ok(None));
    }
    if !answer.ok() {
        return Ok(Err(answer.problem("Jira")));
    }
    let issue = answer.json();
    let fields = &issue["fields"];
    let mut body = Vec::new();
    let kind = [fields["issuetype"]["name"].as_str(), fields["priority"]["name"].as_str()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(", priority ");
    if !kind.is_empty() {
        body.push(format!("{kind}."));
    }
    let description = adf_text(&fields["description"]);
    if !description.trim().is_empty() {
        body.push(description.trim().to_owned());
    }
    if let Some(labels) = fields["labels"].as_array().filter(|labels| !labels.is_empty()) {
        body.push(format!(
            "Labels: {}",
            labels.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")
        ));
    }
    let key = issue["key"].as_str().unwrap_or(key).to_owned();
    Ok(Ok(Some(Ticket {
        external_id: key.clone(),
        item: ContextItem {
            provider: Provider::Jira,
            url: format!("{}/browse/{key}", jira_site(config)),
            key,
            title: fields["summary"].as_str().unwrap_or_default().to_owned(),
            status: fields["status"]["name"].as_str().map(str::to_owned),
            body: http::shorten(&body.join("\n\n"), MAX_BODY),
            fetched_at: rfc3339(now_ms()),
        },
    })))
}

pub async fn jira_comment(config: &ConnectionConfig, token: &str, key: &str, text: &str, link: &str) -> Result<std::result::Result<(), String>> {
    let body = json!({ "body": { "type": "doc", "version": 1, "content": [{
        "type": "paragraph",
        "content": [
            { "type": "text", "text": format!("{text} ") },
            { "type": "text", "text": link, "marks": [{ "type": "link", "attrs": { "href": link } }] }
        ]
    }]}});
    let answer = jira(config, token, Method::Post, &format!("/issue/{key}/comment"), Some(body)).await?;
    Ok(if answer.ok() { Ok(()) } else { Err(answer.problem("Jira")) })
}

pub async fn jira_test(config: &ConnectionConfig, token: &str) -> Result<std::result::Result<String, String>> {
    let answer = jira(config, token, Method::Get, "/myself", None).await?;
    Ok(if answer.ok() {
        Ok(format!(
            "Connected to {} as {}.",
            jira_site(config),
            answer.json()["displayName"].as_str().unwrap_or("you")
        ))
    } else {
        Err(answer.problem("Jira"))
    })
}

// --- Linear --------------------------------------------------------------

async fn linear(token: &str, query: &str, variables: Value) -> Result<Answer> {
    http::send(
        Method::Post,
        "https://api.linear.app/graphql",
        &[("authorization", token)],
        Some(json!({ "query": query, "variables": variables }).to_string()),
    )
    .await
}

fn linear_problem(answer: &Answer) -> Option<String> {
    if !answer.ok() {
        return Some(answer.problem("Linear"));
    }
    answer.json()["errors"][0]["message"].as_str().map(|message| format!("Linear: {message}"))
}

pub async fn linear_fetch(token: &str, key: &str) -> Result<Fetched> {
    let answer = linear(
        token,
        "query($id: String!) { issue(id: $id) { id identifier title description url priorityLabel state { name } labels { nodes { name } } } }",
        json!({ "id": key }),
    )
    .await?;
    let said = answer.json();
    if let Some(problem) = linear_problem(&answer) {
        // Linear says a missing issue is an error like any other.
        return Ok(if problem.to_ascii_lowercase().contains("not found") { Ok(None) } else { Err(problem) });
    }
    let issue = &said["data"]["issue"];
    if issue.is_null() {
        return Ok(Ok(None));
    }
    let mut body = Vec::new();
    if let Some(priority) = issue["priorityLabel"].as_str().filter(|p| *p != "No priority") {
        body.push(format!("Priority {priority}."));
    }
    if let Some(description) = issue["description"].as_str().filter(|d| !d.trim().is_empty()) {
        body.push(description.trim().to_owned());
    }
    Ok(Ok(Some(Ticket {
        external_id: issue["id"].as_str().unwrap_or_default().to_owned(),
        item: ContextItem {
            provider: Provider::Linear,
            key: issue["identifier"].as_str().unwrap_or(key).to_owned(),
            title: issue["title"].as_str().unwrap_or_default().to_owned(),
            url: issue["url"].as_str().unwrap_or_default().to_owned(),
            status: issue["state"]["name"].as_str().map(str::to_owned),
            body: http::shorten(&body.join("\n\n"), MAX_BODY),
            fetched_at: rfc3339(now_ms()),
        },
    })))
}

pub async fn linear_comment(token: &str, issue_id: &str, text: &str, link: &str) -> Result<std::result::Result<(), String>> {
    let answer = linear(
        token,
        "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
        json!({ "input": { "issueId": issue_id, "body": format!("{text} [{link}]({link})") } }),
    )
    .await?;
    Ok(match linear_problem(&answer) {
        Some(problem) => Err(problem),
        None => Ok(()),
    })
}

pub async fn linear_test(token: &str) -> Result<std::result::Result<String, String>> {
    let answer = linear(token, "{ viewer { name } organization { name } }", json!({})).await?;
    if let Some(problem) = linear_problem(&answer) {
        return Ok(Err(problem));
    }
    let said = answer.json();
    Ok(Ok(format!(
        "Connected to {} as {}.",
        said["data"]["organization"]["name"].as_str().unwrap_or("Linear"),
        said["data"]["viewer"]["name"].as_str().unwrap_or("you")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atlassian_documents_read_as_text() {
        let doc = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "Users see a 500 on " }, { "type": "text", "text": "/login" }] },
            { "type": "bulletList", "content": [
                { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "on Safari" }] }] },
                { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "since Monday" }] }] }
            ]},
            { "type": "codeBlock", "content": [{ "type": "text", "text": "GET /login 500" }] }
        ]});
        let text = adf_text(&doc);
        assert!(text.starts_with("Users see a 500 on /login\n\n"));
        assert!(text.contains("- on Safari\n- since Monday\n"));
        assert!(text.contains("```\nGET /login 500\n```"));
    }
}
