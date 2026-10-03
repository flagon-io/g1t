//! The OpenAPI document, generated from the same list the routes are.

use serde_json::{Map, Value, json};

use crate::operations::Op;
use crate::rest::{ROUTES, Route};

/// The section of the API reference an operation is listed under.
fn tag(op: Op) -> &'static str {
    let name = op.name();
    if name.contains("webhook") {
        "Webhooks"
    } else if name.contains("automation") {
        "Automations"
    } else if name.contains("integration") || name.contains("model_routes") || op == Op::GetContext {
        "Integrations"
    } else if op == Op::Whoami || name.contains("workspace") {
        "Accounts"
    } else if name.contains("session") {
        "Sessions"
    } else if name.contains("pull_request") {
        "Pull requests"
    } else if ["issue", "label", "comment"]
        .iter()
        .any(|word| name.contains(word))
    {
        "Issues"
    } else {
        "Repositories"
    }
}

/// A short title from an operation name: `create_issue` is "Create issue".
fn title(op: Op) -> String {
    if op == Op::Whoami {
        return "Get the current user".to_owned();
    }
    let words = op.name().replace('_', " ");
    let mut letters = words.chars();
    match letters.next() {
        Some(first) => first.to_uppercase().chain(letters).collect(),
        None => words,
    }
}

/// `/repos/:owner/:name` as OpenAPI writes it: `/repos/{owner}/{name}`.
fn openapi_path(route: &Route) -> String {
    route
        .path
        .split('/')
        .map(|segment| match segment.strip_prefix(':') {
            Some(name) => format!("{{{name}}}"),
            None => segment.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn error_response(description: &str) -> Value {
    json!({
        "description": description,
        "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } },
    })
}

fn operation(route: &Route) -> Value {
    let op = route.op;
    let path_params: Vec<&str> = route.params().collect();
    // `owner` and `name` in the path stand for the operation's `repo` input.
    let covered = |name: &str| name == "repo" || path_params.contains(&name);
    let mut properties = op.properties();
    properties.retain(|name, _| !covered(name));
    let required: Vec<String> = op
        .required()
        .into_iter()
        .filter(|name| !covered(name))
        .collect();

    let mut parameters: Vec<Value> = path_params
        .iter()
        .map(|name| {
            json!({
                "name": name,
                "in": "path",
                "required": true,
                "schema": { "type": if *name == "number" { "integer" } else { "string" } },
            })
        })
        .collect();
    let mut body = Value::Null;
    if route.method == "GET" {
        for (name, key) in route.query {
            parameters.push(json!({
                "name": name,
                "in": "query",
                "required": false,
                "schema": properties.get(*key).cloned().unwrap_or_else(|| json!({})),
            }));
        }
    } else if !properties.is_empty() {
        let mut schema = json!({ "type": "object", "properties": properties });
        if !required.is_empty() {
            schema["required"] = json!(required);
        }
        body = json!({
            "required": !required.is_empty(),
            "content": { "application/json": { "schema": schema } },
        });
    }

    // An operation reached at a workspace's address as well as a
    // repository's is documented once for each, with its own id.
    let id = if route.path.starts_with("/workspaces/") && ROUTES.iter().any(|other| other.op == op && other.path.starts_with("/repos/")) {
        format!("{}_for_workspace", op.name())
    } else {
        op.name().to_owned()
    };
    let mut described = json!({
        "operationId": id,
        "tags": [tag(op)],
        "summary": title(op),
        "description": op.description(),
        "parameters": parameters,
        "responses": {
            "200": {
                "description": "Success.",
                "content": { "application/json": { "schema": {} } },
            },
            "401": error_response("A token is required, or the one sent is not valid."),
            "403": error_response("Signed in, but not allowed to do this."),
            "404": error_response("It does not exist, or you cannot see it."),
            "409": error_response("The request conflicts with the current state."),
            "422": error_response("The input is not valid."),
        },
    });
    if !body.is_null() {
        described["requestBody"] = body;
    }
    described
}

/// Entries for device sign-in, which is not an operation.
fn onboarding() -> Map<String, Value> {
    let paths = json!({
        "/device/code": {
            "post": {
                "operationId": "device_code",
                "tags": ["Accounts"],
                "summary": "Start signing in",
                "description": "Begins a device sign-in. Show the person `verification_uri_complete` and have them open it in a browser, where they sign in or register and approve the code. Then poll `/device/token`.",
                "security": [],
                "requestBody": {
                    "content": { "application/json": { "schema": {
                        "type": "object",
                        "properties": {
                            "client_name": {
                                "type": "string",
                                "description": "What is asking, shown to the person approving. For example, Claude Code.",
                            },
                        },
                    } } },
                },
                "responses": { "200": {
                    "description": "The codes for this sign-in.",
                    "content": { "application/json": { "schema": {
                        "type": "object",
                        "properties": {
                            "device_code": { "type": "string", "description": "Secret. Send it to /device/token." },
                            "user_code": { "type": "string", "description": "Shown to the person, like WDJB-MJHT." },
                            "verification_uri": { "type": "string" },
                            "verification_uri_complete": {
                                "type": "string",
                                "description": "The link to give the person; it carries the code.",
                            },
                            "expires_in": { "type": "integer", "description": "Seconds until the codes expire." },
                            "interval": { "type": "integer", "description": "Seconds to wait between polls." },
                        },
                    } } },
                } },
            },
        },
        "/device/token": {
            "post": {
                "operationId": "device_token",
                "tags": ["Accounts"],
                "summary": "Finish signing in",
                "description": "Asks whether the person has approved. Poll no faster than the interval. The token is returned once.",
                "security": [],
                "requestBody": {
                    "required": true,
                    "content": { "application/json": { "schema": {
                        "type": "object",
                        "required": ["device_code"],
                        "properties": { "device_code": { "type": "string" } },
                    } } },
                },
                "responses": { "200": {
                    "description": "The state of the sign-in.",
                    "content": { "application/json": { "schema": {
                        "type": "object",
                        "required": ["status"],
                        "properties": {
                            "status": { "type": "string", "enum": ["pending", "approved", "denied", "expired"] },
                            "token": { "type": "string", "description": "Present when approved." },
                            "username": { "type": "string" },
                            "verified": {
                                "type": "boolean",
                                "description": "Whether the account's email is confirmed.",
                            },
                        },
                    } } },
                } },
            },
        },
    });
    match paths {
        Value::Object(paths) => paths,
        _ => Map::new(),
    }
}

pub fn document() -> Value {
    let mut paths = onboarding();
    for route in ROUTES {
        let entry = paths
            .entry(openapi_path(route))
            .or_insert_with(|| json!({}));
        entry[route.method.to_lowercase()] = operation(route);
    }
    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "g1t API",
            "version": "1",
            "description": "The REST API for g1t, a git forge built for agents. The same operations are available to agents as MCP tools at https://mcp.g1t.sh.",
            "license": { "name": "MIT", "identifier": "MIT" },
        },
        "servers": [{ "url": "https://api.g1t.sh" }],
        "security": [{ "token": [] }, {}],
        "tags": [
            { "name": "Accounts", "description": "Signing in from a tool, and the current user." },
            { "name": "Repositories" },
            {
                "name": "Issues",
                "description": "What should change in a repository, with labels and comments. Issues and pull requests share one sequence of numbers.",
            },
            {
                "name": "Pull requests",
                "description": "A proposed change in its own fork or on a branch. Several can be made for one issue; the one merged resolves it.",
            },
            { "name": "Sessions", "description": "The record of how a pull request was made." },
        ],
        "paths": paths,
        "components": {
            "securitySchemes": {
                "token": {
                    "type": "http",
                    "scheme": "bearer",
                    "description": "An access token, `g1t_…`. Public data needs none.",
                },
            },
            "schemas": {
                "Error": {
                    "type": "object",
                    "required": ["error"],
                    "properties": {
                        "error": {
                            "type": "object",
                            "required": ["code", "message"],
                            "properties": {
                                "code": {
                                    "type": "string",
                                    "enum": ["unauthenticated", "forbidden", "not_found", "conflict", "invalid"],
                                },
                                "message": { "type": "string" },
                            },
                        },
                    },
                },
            },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_route_is_documented_once() {
        let document = document();
        let mut ids = Vec::new();
        for (_, methods) in document["paths"].as_object().unwrap() {
            for (_, operation) in methods.as_object().unwrap() {
                ids.push(operation["operationId"].as_str().unwrap().to_owned());
            }
        }
        for op in Op::ALL {
            assert_eq!(
                ids.iter().filter(|id| *id == op.name()).count(),
                1,
                "{}",
                op.name()
            );
        }
        let mut unique = ids.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), ids.len(), "operation ids repeat");
    }

    #[test]
    fn path_and_query_inputs_are_not_repeated_in_the_body() {
        let document = document();
        let merge = &document["paths"]["/repos/{owner}/{name}/pulls/{number}/merge"]["post"];
        let body = &merge["requestBody"]["content"]["application/json"]["schema"]["properties"];
        assert!(body.get("keep_issue_open").is_some());
        assert!(body.get("repo").is_none() && body.get("number").is_none());
        let list = &document["paths"]["/repos"]["get"];
        assert_eq!(list["parameters"][0]["name"], "q");
        assert!(list.get("requestBody").is_none());
    }

    #[test]
    fn titles_read_as_sentences() {
        assert_eq!(title(Op::CreateIssue), "Create issue");
        assert_eq!(title(Op::Whoami), "Get the current user");
    }
}
