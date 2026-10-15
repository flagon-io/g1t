//! MCP over streamable HTTP. The server keeps no session state, so every
//! POST is answered directly with JSON.

use g1t_contracts::{Outcome, Viewer};
use serde_json::{Value, json};
use worker::{Method, Request, Response, Result};

use crate::operations::{Op, Services};
use crate::tools::{Gate, TOOLS, Tool};

const SUPPORTED_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "g1t is where your code, its history and the work around it live: repositories, issues, pull requests, workflows, deployments and packages. You bring your own agent; these tools are how it reads and changes what is on g1t, as the person or token it acts for. Repositories are named \"owner/name\"; issues and pull requests in one share a sequence of numbers.
Tools are resources, each with an `action`: search, repository, issue, pull_request, session, workflow, observability, package, secret, webhook, access, team, workspace, ai, billing, security, notifications, account, artifact. The `action` field lists each action and the fields it needs. You see only what your token's scopes allow; a refusal names the scope it needs.
Find a repository: account whoami lists your workspaces; repository list or search finds one.
Work on an issue: issue work (everything about it: what done means, who is on it, its pull requests, what it waits on), issue claim (advisory: it tells you who else is on it), then pull_request create with the issue's number: you get a draft with its own fork to clone and push to. Push your commits, then pull_request ready with a summary. Watch `overlaps` and `behind` on pull_request get, and its checks there: `statuses` from the repository's workflows and `required_checks`, which must pass before it merges. If one fails, read why with workflow get_run and job_logs, push a fix, and the checks run again. Merging closes the pull request's issue; a commit pushed straight to the default branch closes one only when its message says `Closes #N` (or Fixes, Resolves), never with a bare `(#N)`, and issue close with commit closes one after the fact.
Coordinate: session start once per run of your harness (harness_session_id makes it idempotent), session update as a heartbeat, session get between work steps to read pending updates. Reading does not acknowledge: consider relevant changes, record a public decision summary, then session record with acknowledge containing only the exact update IDs considered. Keep your own session ID explicit, especially when sharing a checkout. Separate scopes may proceed concurrently; agree ownership before overlapping edits. session end when done; issue release or handoff (with a note) when you stop.
Record public summaries only, never private chain-of-thought, credentials or secrets. As you work, pull_request record_session appends user-facing decisions, evidence and tool activity to the pull request's session, so reviewers see why the change is what it is; pull_request read_session reads it back. pull_request record_decision keeps a decision (why the change is made this way, or what fixed a failure) and list_decisions reads them; repository why says why a line of code is the way it is.
Merge queue: when your pull request fails combined with the ones ahead of it, g1t says which of them it breaks with and the check that failed (on the pull request, its issue and its session, and as integration.failed). Fix it and push: once its checks pass, it rejoins the queue by itself.
Security: security code_alerts, vulnerability_alerts and secret_alerts show what to fix; fix it in your pull request, which the Code scanning and Dependency review checks judge.
Production: observability overview and errors show what a project's running software did; follow a request or trace to its logs.";

fn result(id: &Value, value: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": value })
}

fn error(id: &Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// What decides the actions a caller sees: a run's scope, an
/// access token's scopes, or nothing beyond the person's role.
fn gate<'a>(services: &'a Services, viewer: &'a Viewer) -> Gate<'a> {
    if let Some(scope) = &services.scope {
        return Gate::Agent(scope);
    }
    match viewer.as_ref().and_then(|user| user.token.as_deref()) {
        Some(access) => Gate::Token(access),
        None => Gate::Everything,
    }
}

/// Answers one JSON-RPC request, or `None` for a notification.
async fn answer(services: &Services, viewer: &Viewer, request: &Value) -> Result<Option<Value>> {
    // Notifications carry no id and get no response.
    let Some(id) = request.get("id") else {
        return Ok(None);
    };
    let params = &request["params"];
    let answer = match request["method"].as_str().unwrap_or_default() {
        "initialize" => {
            let requested = params["protocolVersion"].as_str().unwrap_or_default();
            let version = SUPPORTED_VERSIONS
                .into_iter()
                .find(|version| *version == requested)
                .unwrap_or(SUPPORTED_VERSIONS[0]);
            result(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "g1t", "version": "0.1.0" },
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => result(id, json!({})),
        "tools/list" => {
            // A caller sees the tools, and the actions of each, that its
            // token may use.
            let gate = gate(services, viewer);
            let tools: Vec<Value> = TOOLS.iter().filter_map(|tool| tool.listed(&gate)).collect();
            result(id, json!({ "tools": tools }))
        }
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or_default();
            let arguments = &params["arguments"];
            let op = match Tool::by_name(name) {
                Some(tool) => match crate::tools::resolve(tool, arguments) {
                    Ok(op) => op,
                    Err(problem) => {
                        return Ok(Some(result(
                            id,
                            json!({ "content": [{ "type": "text", "text": problem }], "isError": true }),
                        )));
                    }
                },
                // A tool per operation, as the server had before its
                // resource tools. Still answered, no longer listed; never
                // one offered over REST alone.
                None => match Op::by_name(name).filter(|op| !crate::tools::REST_ONLY.contains(op)) {
                    Some(op) => op,
                    None => return Ok(Some(error(id, -32602, "Unknown tool."))),
                },
            };
            let arguments = &crate::tools::with_defaults(op, arguments);
            let outcome = crate::audit::run(op, services, viewer, arguments).await?;
            // A failed operation is a tool result the model can read and
            // act on, not a protocol error.
            let (text, failed) = match outcome {
                // In `snake_case`, as the REST API answers; the protocol's
                // own envelope keeps MCP's spelling.
                Outcome::Ok(value) => (
                    serde_json::to_string_pretty(&g1t_kit::wire::snake_case_keeping(value, op.as_given()))?,
                    false,
                ),
                Outcome::Fail(failure) => (failure.message, true),
            };
            result(
                id,
                json!({ "content": [{ "type": "text", "text": text }], "isError": failed }),
            )
        }
        method => error(id, -32601, &format!("Method not found: {method}")),
    };
    Ok(Some(answer))
}

/// What someone sees when they open the server's address in a browser:
/// what this is, how to connect, and what it offers.
fn card(addresses: &crate::addresses::Addresses) -> Value {
    let tools: Vec<Value> = TOOLS
        .iter()
        .map(|tool| {
            let actions: Vec<&crate::tools::Action> = tool.actions.iter().collect();
            json!({
                "name": tool.name,
                "title": tool.title,
                "description": tool.description,
                "actions": tool.actions.iter().map(|action| json!({
                    "name": action.name,
                    "description": action.summary,
                    "operation": action.op.name(),
                    "scope": g1t_contracts::scopes::scope_for(action.op.name()).map(|scope| scope.as_str()),
                })).collect::<Vec<_>>(),
                "input_schema": tool.discriminated(&actions),
            })
        })
        .collect();
    json!({
        "name": "g1t",
        "description": "The g1t MCP server: issues, pull requests and sessions for agents.",
        "endpoint": addresses.mcp,
        "transport": "streamable-http",
        "protocol_versions": SUPPORTED_VERSIONS,
        // For Claude Code, g1t's plugin comes first: it adds this server
        // itself (as plugin:g1t:g1t), so `connect` is for Claude Code
        // without the plugin; with both, every tool is listed twice.
        "connect": format!("claude mcp add --transport http g1t {}", addresses.mcp),
        "claude_code_plugin": {
            "install": [
                "claude plugin marketplace add https://g1t.sh/flagon-io/g1t-plugins.git",
                "claude plugin install g1t@g1t",
            ],
            "note": "The plugin adds this server (listed in /mcp as plugin:g1t:g1t) and records your sessions on g1t. With it installed, skip `connect`, or each tool is listed twice.",
            "documentation_url": "https://docs.g1t.sh/guides/claude-code-plugin/",
        },
        "authorization": {
            "required": true,
            "oauth_protected_resource": addresses.protected_resource(),
            "alternative": "Authorization: Bearer <g1t access token>",
        },
        "documentation_url": "https://docs.g1t.sh/guides/bring-your-own-agent/",
        "instructions": INSTRUCTIONS,
        "tools": tools,
    })
}

pub async fn handle(
    mut request: Request,
    services: &Services,
    viewer: &Viewer,
) -> Result<Response> {
    if request.method() != Method::Post {
        // A client asking for a stream of server messages is told there is
        // none. Anyone else, a person with a browser, gets a description.
        let wants_stream = request
            .headers()
            .get("accept")?
            .is_some_and(|accept| accept.contains("text/event-stream"));
        if request.method() == Method::Get && !wants_stream {
            return Response::from_json(&card(&services.addresses));
        }
        let mut response = Response::empty()?.with_status(405);
        response.headers_mut().set("allow", "GET, POST")?;
        return Ok(response);
    }
    // Calls need a signed-in user. Answering 401 with this header is what
    // makes a client open the browser to sign in.
    if viewer.is_none() {
        let mut response = Response::from_json(&error(
            &Value::Null,
            -32001,
            "Sign in to use the g1t MCP server.",
        ))?
        .with_status(401);
        response
            .headers_mut()
            .set("www-authenticate", &services.addresses.mcp_challenge())?;
        return Ok(response);
    }
    let Ok(body) = request.json::<Value>().await else {
        return Ok(
            Response::from_json(&error(&Value::Null, -32700, "Parse error"))?.with_status(400),
        );
    };
    let accepted = || Ok(Response::empty()?.with_status(202));
    match body {
        Value::Array(batch) => {
            let mut answers = Vec::new();
            for request in &batch {
                answers.extend(answer(services, viewer, request).await?);
            }
            if answers.is_empty() {
                accepted()
            } else {
                Response::from_json(&answers)
            }
        }
        single => match answer(services, viewer, &single).await? {
            Some(answer) => Response::from_json(&answer),
            None => accepted(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The instructions name every tool, in the order `tools/list` gives
    /// them, so that no tool goes unmentioned.
    #[test]
    fn the_instructions_list_every_tool() {
        let names: Vec<&str> = TOOLS.iter().map(|tool| tool.name).collect();
        let listed = format!("each with an `action`: {}.", names.join(", "));
        assert!(INSTRUCTIONS.contains(&listed), "{listed}");
    }
}
