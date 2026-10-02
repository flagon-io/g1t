//! MCP over streamable HTTP. The server keeps no session state, so every
//! POST is answered directly with JSON.

use g1t_contracts::{Outcome, Viewer};
use serde_json::{Value, json};
use worker::{Method, Request, Response, Result};

use crate::oauth::MCP_CHALLENGE;
use crate::operations::{Op, Services};

const SUPPORTED_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "g1t is a git forge with issues and pull requests, built so that many agents can work on the same issue at once.
To work on an issue: get_issue to read it and see the pull requests already made for it, then create_pull_request with the issue's number. You get a draft pull request with its own fork to clone and push to. Call record_session as you work so people can see your reasoning, push your commits, and call mark_pull_request_ready with a summary.
Issues and pull requests are named by repository (\"owner/name\") and number, and share one sequence of numbers.";

fn result(id: &Value, value: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": value })
}

fn error(id: &Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
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
            let tools: Vec<Value> = Op::ALL
                .into_iter()
                .map(|op| {
                    json!({
                        "name": op.name(),
                        "description": op.description(),
                        "inputSchema": op.input(),
                    })
                })
                .collect();
            result(id, json!({ "tools": tools }))
        }
        "tools/call" => {
            let Some(op) = Op::by_name(params["name"].as_str().unwrap_or_default()) else {
                return Ok(Some(error(id, -32602, "Unknown tool.")));
            };
            let outcome = op.run(services, viewer, &params["arguments"]).await?;
            // A failed operation is a tool result the model can read and
            // act on, not a protocol error.
            let (text, failed) = match outcome {
                Outcome::Ok(value) => (serde_json::to_string_pretty(&value)?, false),
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
fn card() -> Value {
    let tools: Vec<Value> = Op::ALL
        .into_iter()
        .map(|op| json!({ "name": op.name(), "description": op.description() }))
        .collect();
    json!({
        "name": "g1t",
        "description": "The g1t MCP server: issues, pull requests and sessions for agents.",
        "endpoint": "https://mcp.g1t.sh",
        "transport": "streamable-http",
        "protocol_versions": SUPPORTED_VERSIONS,
        "connect": "claude mcp add --transport http g1t https://mcp.g1t.sh",
        "authorization": {
            "required": true,
            "oauth_protected_resource": "https://mcp.g1t.sh/.well-known/oauth-protected-resource",
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
            return Response::from_json(&card());
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
            .set("www-authenticate", MCP_CHALLENGE)?;
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
