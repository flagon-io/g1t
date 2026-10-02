//! The public API: REST at api.g1t.sh and the MCP server at mcp.g1t.sh.
//!
//! One Worker, two hostnames. Both are thin adapters over the same
//! operations (see [`operations::Op`]), which call the services that own
//! the data. This Worker holds none.

mod mcp;
mod oauth;
mod openapi;
mod operations;
mod rest;

use g1t_contracts::identity::{
    DeviceClaim, DeviceClaimArgs, DeviceStart, DeviceStartArgs, TokenArgs,
};
use g1t_contracts::work::{CheckRun, ReportChecksArgs};
use g1t_contracts::{Failure, FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use worker::{Context, Env, Method, Request, Response, Result, event};

use operations::Services;

const API: &str = "https://api.g1t.sh";

fn method_name(method: Method) -> &'static str {
    match method {
        Method::Get => "GET",
        Method::Post => "POST",
        Method::Patch => "PATCH",
        Method::Put => "PUT",
        Method::Delete => "DELETE",
        Method::Options => "OPTIONS",
        Method::Head => "HEAD",
        _ => "OTHER",
    }
}

/// An error in the shape every endpoint uses.
fn failure(failure: &Failure) -> Result<Response> {
    Ok(Response::from_json(&json!({ "error": failure }))?.with_status(failure.code.http_status()))
}

fn fail(code: FailureCode, message: &str) -> Result<Response> {
    failure(&Failure {
        code,
        message: message.to_owned(),
    })
}

/// A request body as JSON. An empty or malformed body is no input.
async fn json_body(request: &mut Request) -> Value {
    request.json().await.unwrap_or(Value::Null)
}

/// Who a request's `Authorization: Bearer g1t_…` names. A missing token is
/// an anonymous viewer; a wrong one is refused, so that a typo does not
/// silently look signed out.
async fn authenticate(
    request: &Request,
    services: &Services,
) -> Result<std::result::Result<Viewer, Response>> {
    let header = request.headers().get("authorization")?.unwrap_or_default();
    let token = match header.split_once(' ') {
        Some((scheme, token)) if scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() => {
            token.trim()
        }
        _ => return Ok(Ok(None)),
    };
    let viewer: Viewer = g1t_kit::call(
        &services.identity,
        "user_for_access_token",
        &TokenArgs {
            token: token.to_owned(),
        },
    )
    .await?;
    if viewer.is_some() {
        return Ok(Ok(viewer));
    }
    let mut response = fail(FailureCode::Unauthenticated, "Invalid access token.")?;
    // Tells an MCP client where to sign in again.
    response.headers_mut().set(
        "www-authenticate",
        &format!("{}, error=\"invalid_token\"", oauth::MCP_CHALLENGE),
    )?;
    Ok(Err(response))
}

/// Where everything is, for someone or something exploring the API.
fn index() -> Value {
    let repo = format!("{API}/v1/repos/{{owner}}/{{name}}");
    json!({
        "documentation_url": "https://docs.g1t.sh/api/reference/",
        "openapi_url": format!("{API}/openapi.json"),
        "mcp_url": "https://mcp.g1t.sh",
        "current_user_url": format!("{API}/v1/user"),
        "workspaces_url": format!("{API}/v1/workspaces"),
        "repositories_url": format!("{API}/v1/repos{{?q}}"),
        "repository_url": repo,
        "repository_events_url": format!("{repo}/events{{?before}}"),
        "labels_url": format!("{repo}/labels"),
        "issues_url": format!("{repo}/issues{{?state,label}}"),
        "issue_url": format!("{repo}/issues/{{number}}"),
        "issue_comments_url": format!("{repo}/issues/{{number}}/comments"),
        "pulls_url": format!("{repo}/pulls{{?state}}"),
        "pull_url": format!("{repo}/pulls/{{number}}"),
        "pull_changes_url": format!("{repo}/pulls/{{number}}/changes"),
        "pull_reviews_url": format!("{repo}/pulls/{{number}}/reviews"),
        "pull_session_url": format!("{repo}/pulls/{{number}}/session{{?after}}"),
        "device_code_url": format!("{API}/v1/device/code"),
        "device_token_url": format!("{API}/v1/device/token"),
        "oauth_metadata_url": format!("{API}/.well-known/oauth-authorization-server"),
        "git_url": "https://g1t.sh/{owner}/{name}.git",
    })
}

// Signing in from a tool. Accounts are created, and passwords typed, only
// in a browser; a tool gets its token by having a person approve a code.

async fn device_code(request: &mut Request, services: &Services) -> Result<Response> {
    let body = json_body(request).await;
    let started: DeviceStart = g1t_kit::call(
        &services.identity,
        "device_start",
        &DeviceStartArgs {
            client_name: body["client_name"].as_str().unwrap_or_default().to_owned(),
        },
    )
    .await?;
    Response::from_json(&json!({
        "device_code": started.device_code,
        "user_code": started.user_code,
        "verification_uri": "https://g1t.sh/device",
        "verification_uri_complete": format!("https://g1t.sh/device?code={}", started.user_code),
        "expires_in": started.expires_in,
        "interval": started.interval,
    }))
}

async fn device_token(request: &mut Request, services: &Services) -> Result<Response> {
    let body = json_body(request).await;
    let claim: DeviceClaim = g1t_kit::call(
        &services.identity,
        "device_claim",
        &DeviceClaimArgs {
            device_code: body["device_code"].as_str().unwrap_or_default().to_owned(),
        },
    )
    .await?;
    Response::from_json(&match claim {
        DeviceClaim::Approved { token, user } => json!({
            "status": "approved",
            "token": token,
            "username": user.username,
            "verified": user.verified,
        }),
        DeviceClaim::Pending => json!({ "status": "pending" }),
        DeviceClaim::Denied => json!({ "status": "denied" }),
        DeviceClaim::Expired => json!({ "status": "expired" }),
    })
}

/// A sandbox reporting on its run of a pull request's acceptance checks.
/// The run's own token, in the body, is the credential: it was given to
/// that sandbox and to nothing else.
async fn report_checks(
    request: &mut Request,
    services: &Services,
    run_id: &str,
) -> Result<Response> {
    let body = json_body(request).await;
    let reported: Outcome<CheckRun> = g1t_kit::call(
        &services.work,
        "report_checks",
        &ReportChecksArgs {
            run_id: run_id.to_owned(),
            token: body["token"].as_str().unwrap_or_default().to_owned(),
            results: serde_json::from_value(body["results"].clone()).unwrap_or_default(),
            error: body["error"].as_str().map(str::to_owned),
            skip: false,
        },
    )
    .await?;
    match reported {
        Outcome::Ok(run) => Response::from_json(&json!({ "status": run.status })),
        Outcome::Fail(refused) => failure(&refused),
    }
}

async fn respond(mut request: Request, env: &Env) -> Result<Response> {
    let method = method_name(request.method());
    if method == "OPTIONS" {
        return Ok(Response::empty()?.with_status(204));
    }
    let url = request.url()?;
    let path = url.path().to_owned();
    let on_mcp = url.host_str().is_some_and(|host| host.starts_with("mcp."));
    let services = Services::new(env)?;

    let viewer = match authenticate(&request, &services).await? {
        Ok(viewer) => viewer,
        Err(refused) => return Ok(refused),
    };
    if let Some(response) = oauth::handle(&mut request, &services, method, &path).await? {
        return Ok(response);
    }
    if on_mcp {
        return mcp::handle(request, &services, &viewer).await;
    }

    match (method, path.trim_end_matches('/')) {
        ("GET", "" | "/v1") => return Response::from_json(&index()),
        ("GET", "/openapi.json") => return Response::from_json(&openapi::document()),
        ("POST", "/v1/device/code") => return device_code(&mut request, &services).await,
        ("POST", "/v1/device/token") => return device_token(&mut request, &services).await,
        ("POST", path) if path.starts_with("/v1/checks/") => {
            let run_id = path.trim_start_matches("/v1/checks/").to_owned();
            return report_checks(&mut request, &services, &run_id).await;
        }
        _ => {}
    }

    let query: Vec<(String, String)> = url
        .query_pairs()
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    let body = if method == "GET" {
        Value::Null
    } else {
        json_body(&mut request).await
    };
    let Some((route, input)) = rest::resolve(method, &path, &query, body) else {
        return fail(FailureCode::NotFound, "No such endpoint.");
    };
    match route.op.run(&services, &viewer, &input).await? {
        Outcome::Ok(value) => Response::from_json(&value),
        Outcome::Fail(refused) => failure(&refused),
    }
}

// The API is called from browsers too: the reference's explorer, and apps
// built on g1t. It carries no cookies, so any origin may call it.
#[event(fetch)]
async fn fetch(request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let mut response = respond(request, &env).await?;
    let headers = response.headers_mut();
    headers.set("access-control-allow-origin", "*")?;
    headers.set(
        "access-control-allow-headers",
        "authorization, content-type",
    )?;
    headers.set("access-control-allow-methods", "GET, POST, PATCH, OPTIONS")?;
    headers.set("access-control-expose-headers", "www-authenticate")?;
    Ok(response)
}
