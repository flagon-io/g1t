//! MCP over streamable HTTP. The server keeps no session state, so every
//! POST is answered directly with JSON.

use g1t_contracts::{Outcome, Viewer};
use serde_json::{Value, json};
use worker::{Method, Request, Response, Result};

use crate::operations::{Op, Services};
use crate::tools::{Gate, TOOLS, Tool};

const SUPPORTED_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "g1t is a git forge where people and agents work through issues and pull requests. Repositories are named \"owner/name\"; issues and pull requests in one share a sequence of numbers.
Tools are resources, each with an `action`: search, repository, issue, pull_request, agent, plan, memory, workflow, secret, webhook, access, workspace, account. The `action` field lists each action and the fields it needs. You see only what your token's scopes allow; a refusal names the scope it needs.
Find a repository: account whoami lists your workspaces; repository list or search finds one.
Work on an issue: issue get (read it and the pull requests already made for it), memory recall, then pull_request create with the issue's number: you get a draft with its own fork to clone and push to. Record your reasoning with pull_request record_session as you go, push, then pull_request ready with a summary. Watch `overlaps` and `behind` on pull_request get, and its checks there: `statuses` from the repository's workflows and `required_checks`, which must pass before it merges. If one fails, read why with workflow get_run and job_logs, push a fix, and the checks run again.
Hand work to g1t's agent: agent delegate opens an issue and starts it in one step; agent assign starts it on an existing issue. Each costs the workspace money.
When you learn something the next agent needs, memory remember it (scope project or workspace). Never a secret.";

fn result(id: &Value, value: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": value })
}

fn error(id: &Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// What decides the actions a caller sees: an agent's run scope, an
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
                // resource tools. Still answered, no longer listed.
                None => match Op::by_name(name) {
                    Some(op) => op,
                    None => return Ok(Some(error(id, -32602, "Unknown tool."))),
                },
            };
            let outcome = crate::audit::run(op, services, viewer, arguments).await?;
            // A failed operation is a tool result the model can read and
            // act on, not a protocol error.
            let (text, failed) = match outcome {
                // In `snake_case`, as the REST API answers; the protocol's
                // own envelope keeps MCP's spelling.
                Outcome::Ok(value) => (
                    serde_json::to_string_pretty(&g1t_kit::wire::snake_case(value))?,
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
        "connect": format!("claude mcp add --transport http g1t {}", addresses.mcp),
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
