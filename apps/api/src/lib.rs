//! The public API: REST at api.g1t.sh and the MCP server at mcp.g1t.sh.
//!
//! One Worker, two hostnames. Both are thin adapters over the same
//! operations (see [`operations::Op`]), which call the services that own
//! the data. This Worker holds none.

mod about;
mod activity;
mod commits;
mod contents;
mod run_artifacts;
mod caches;
mod archives;
mod addresses;
mod alerts;
mod audit;
mod billing;
mod blobs;
mod broker;
mod checks;
mod coordination;
mod deployments;
mod telemetry;
mod deploy_keys;
mod limits;
mod version;
mod logs;
mod mcp;
mod notifications;
mod oauth;
mod oidc;
mod packages;
mod folios;
mod follow;
mod people;
mod openapi;
mod pins;
mod projects;
mod protection;
mod operations;
mod renamed;
#[cfg(test)]
mod responses;
mod rest;
mod rules;
mod runners;
mod security;
mod tools;
mod why;
mod token_policy;
mod sso;
mod onboarding;
mod toolkit;

use g1t_contracts::identity::{
    DeviceClaim, DeviceClaimArgs, DeviceStart, DeviceStartArgs, TokenArgs,
};
use g1t_contracts::work::{
    CheckRun, Mergeable, QueueState, ReportChecksArgs, ReportMergecheckArgs,
    ReportQueueArgs,
};
use g1t_contracts::{Failure, FailureCode, Outcome, PrincipalKind, User, Viewer};
use g1t_kit::wire;
use serde_json::{Value, json};
use worker::{Context, Env, Method, Request, Response, Result, event};

use operations::Services;

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

/// A JSON response. Every body the API sends has its keys in `snake_case`;
/// the contracts it passes through are `camelCase`, so they are converted
/// here, on the way out (see [`g1t_kit::wire`]). The OpenAPI document and
/// the MCP protocol's own envelope keep the spelling their standards use.
pub(crate) fn reply<T: serde::Serialize>(value: &T) -> Result<Response> {
    Response::from_json(&wire::snake_case(serde_json::to_value(value)?))
}

/// The parts of a job's spec (`POST /actions/jobs/{job}/spec`) that are the
/// workflow file, GitHub's contexts and event, and where to check out, all
/// passed through as they are.
const JOB_SPEC_AS_GIVEN: &[&str] = &[
    "spec", "workflow", "github", "event", "contexts", "checkout", "permissions",
];

/// Puts the toolkit's variables in a job's spec: its runtime token, where
/// the toolkit's services are, and where to ask for an OIDC token when the
/// job may have one and this installation issues them. The `runtime` the
/// actions service sent goes no further.
fn with_runtime(spec: &mut Value, api: &str, oidc: bool) {
    let Some(runtime) = spec.as_object_mut().and_then(|s| s.remove("runtime")) else { return };
    let Some(token) = runtime["token"].as_str().filter(|t| !t.is_empty()) else { return };
    let id_token = oidc && runtime["id_token"].as_bool() == Some(true);
    let vars = toolkit::runtime_variables(api, token, id_token);
    if let Some(variables) = spec.get_mut("variables").and_then(Value::as_object_mut) {
        variables.extend(vars);
    }
}

/// What a person whose account has not confirmed its email address may
/// call: who they are, their addresses, and confirming one with the code
/// from the email. Nothing over MCP.
fn pending_may(method: &str, path: &str, on_mcp: bool) -> bool {
    !on_mcp
        && matches!(
            (method, path.trim_end_matches('/')),
            ("GET", "/user") | ("GET", "/user/emails") | ("POST", "/user/emails/confirm")
        )
}

/// An error in the shape every endpoint uses.
fn failure(failure: &Failure) -> Result<Response> {
    Ok(reply(&json!({ "error": failure }))?.with_status(failure.code.http_status()))
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

/// Who a request's `Authorization: Bearer g1t_…` (or `token g1t_…`, as
/// Octokit sends it) names. A missing token is an anonymous viewer; a
/// wrong one is refused, so that a typo does not silently look signed out.
async fn authenticate(
    request: &Request,
    services: &Services,
) -> Result<std::result::Result<Viewer, Response>> {
    let header = request.headers().get("authorization")?.unwrap_or_default();
    let Some(token) = limits::bearer(&header) else {
        return Ok(Ok(None));
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
        &format!("{}, error=\"invalid_token\"", services.addresses.mcp_challenge()),
    )?;
    Ok(Err(response))
}

/// Where everything is, for someone or something exploring the API.
fn index(addresses: &addresses::Addresses) -> Value {
    let api = &addresses.api;
    let repo = format!("{api}/repos/{{owner}}/{{name}}");
    json!({
        "documentation_url": "https://docs.g1t.sh/reference/api/",
        "openapi_url": format!("{api}/openapi.json"),
        "mcp_url": addresses.mcp,
        "current_user_url": format!("{api}/user"),
        "workspaces_url": format!("{api}/workspaces"),
        "repositories_url": format!("{api}/repos{{?q}}"),
        "search_url": format!("{api}/search{{?q,type,page,per_page}}"),
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
        "device_code_url": format!("{api}/device/code"),
        "device_token_url": format!("{api}/device/token"),
        "oauth_metadata_url": format!("{api}/.well-known/oauth-authorization-server"),
        "git_url": format!("{}/{{owner}}/{{name}}.git", addresses.site),
        "integrations_url": format!("{api}/workspaces/{{workspace}}/integrations"),
        "context_url": format!("{repo}/context{{?reference}}"),
        "import_issue_url": format!("{repo}/issues/import"),
        "hooks_url": format!("{api}/hooks/{{integration}}"),
    })
}

// Signing in from a tool. Accounts are created, and passwords typed, only
// in a browser; a tool gets its token by having a person approve a code.

/// Passes a request from an outside system to its connection, as it came:
/// its signature covers the exact bytes of the body.
async fn receive_hook(request: &mut Request, services: &Services, id: &str) -> Result<Response> {
    let headers: std::collections::HashMap<String, String> = request
        .headers()
        .entries()
        .map(|(name, value)| (name.to_lowercase(), value))
        .collect();
    let body = request.text().await.unwrap_or_default();
    // A push to GitHub with many commits makes a large payload.
    let limit = if id == "github" { 10_000_000 } else { 1_000_000 };
    if body.len() > limit {
        return Ok(reply(&json!({ "message": "The body is too large." }))?.with_status(413));
    }
    // g1t's GitHub App has one webhook for every installation; it is
    // checked against the app's own secret.
    let (method, args) = if id == "github" {
        ("github_receive", json!({ "headers": headers, "body": body }))
    } else {
        ("receive", json!({ "id": id, "headers": headers, "body": body }))
    };
    let received: g1t_contracts::integrations::Received =
        g1t_kit::call(&services.integrations, method, &args).await?;
    Ok(reply(&json!({ "message": received.message }))?.with_status(received.status))
}

async fn receive_stripe(request: &mut Request, env: &Env) -> Result<Response> {
    let signature = request.headers().get("stripe-signature")?.unwrap_or_default();
    let payload = request.text().await.unwrap_or_default();
    if payload.len() > 1_000_000 || signature.is_empty() {
        return Ok(reply(&json!({ "message": "Not a Stripe event." }))?.with_status(400));
    }
    let handled: g1t_contracts::Outcome<bool> = g1t_kit::call(
        &env.service("BILLING")?,
        "stripe_webhook",
        &g1t_contracts::billing::StripeWebhookArgs { payload, signature },
    )
    .await?;
    // A refusal is a 400, so Stripe shows it as failed; anything handled,
    // or already handled, is a 200, so Stripe stops sending it.
    Ok(match handled {
        g1t_contracts::Outcome::Ok(_) => reply(&json!({ "received": true }))?,
        g1t_contracts::Outcome::Fail(failure) => {
            reply(&json!({ "message": failure.message }))?.with_status(400)
        }
    })
}

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
    reply(&json!({
        "device_code": started.device_code,
        "user_code": started.user_code,
        "verification_uri": format!("{}/device", services.addresses.site),
        "verification_uri_complete": format!("{}/device?code={}", services.addresses.site, started.user_code),
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
    reply(&match claim {
        DeviceClaim::Approved { token, user } => json!({
            "status": "approved",
            "token": token,
            "display_username": user.display_username.clone().filter(|display| display.eq_ignore_ascii_case(&user.username)).unwrap_or_else(|| user.username.clone()),
            "username": user.username,
            "verified": user.verified,
        }),
        DeviceClaim::Pending => json!({ "status": "pending" }),
        DeviceClaim::Denied => json!({ "status": "denied" }),
        DeviceClaim::Expired => json!({ "status": "expired" }),
    })
}

/// A sandbox reporting on a run of an issue's commands, from before a pull
/// request's checks were the workflows run on it.
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
        Outcome::Ok(run) => reply(&json!({ "status": run.status })),
        Outcome::Fail(refused) => failure(&refused),
    }
}

/// A sandbox reporting one tested state of a merge queue. As with checks,
/// the entry's own token is the credential.
async fn report_queue(
    request: &mut Request,
    services: &Services,
    entry_id: &str,
) -> Result<Response> {
    let body = json_body(request).await;
    let reported: Outcome<QueueState> = g1t_kit::call(
        &services.work,
        "report_queue",
        &ReportQueueArgs {
            entry_id: entry_id.to_owned(),
            token: body["token"].as_str().unwrap_or_default().to_owned(),
            combined_commit: body["combinedCommit"].as_str().map(str::to_owned),
            results: serde_json::from_value(body["results"].clone()).unwrap_or_default(),
            error: body["error"].as_str().map(str::to_owned),
            conflict_with: body["conflictWith"].as_u64().map(|n| n as u32),
            conflicts: serde_json::from_value(body["conflicts"].clone()).unwrap_or_default(),
        },
    )
    .await?;
    match reported {
        Outcome::Ok(state) => reply(&json!({ "state": state })),
        Outcome::Fail(refused) => failure(&refused),
    }
}

/// A sandbox reporting whether a pull request merges cleanly. As with
/// checks, the probe's own token is the credential.
async fn report_mergecheck(
    request: &mut Request,
    services: &Services,
    pull_id: &str,
) -> Result<Response> {
    let body = json_body(request).await;
    let reported: Outcome<Mergeable> = g1t_kit::call(
        &services.work,
        "report_mergecheck",
        &ReportMergecheckArgs {
            pull_id: pull_id.to_owned(),
            token: body["token"].as_str().unwrap_or_default().to_owned(),
            conflicts: serde_json::from_value(body["conflicts"].clone()).unwrap_or_default(),
            error: body["error"].as_str().map(str::to_owned),
        },
    )
    .await?;
    match reported {
        Outcome::Ok(state) => reply(&json!({ "mergeable": state })),
        Outcome::Fail(refused) => failure(&refused),
    }
}

/// A backup's sandbox, passed on to the repos service, which holds the
/// job (services/repos/src/backups.rs; the flow is in
/// `g1t_contracts::backups`):
///
/// - `POST /backups/{job}/spec`: what to cut, and a read-only git credential
/// - `PUT /backups/{job}/parts/{n}`: one part of the bundle, as bytes
/// - `POST /backups/{job}/complete` with `{ refs, size, sha256, parts, fetched_bytes }`
/// - `POST /backups/{job}/fail` with `{ error, fetched_bytes }`
///
/// Bodies are passed through as they are: snake_case already, and a
/// bundle's refs are keyed by ref names, which must not be converted.
async fn backup_job(request: &mut Request, services: &Services, method: &str, path: &str) -> Result<Response> {
    use g1t_contracts::backups::TOKEN_HEADER;
    let token = request.headers().get(TOKEN_HEADER)?.unwrap_or_default();
    let rest = path.trim_start_matches("/backups/");
    let (job, action) = rest.split_once('/').unwrap_or((rest, ""));
    if job.is_empty() || token.is_empty() {
        return fail(FailureCode::Unauthenticated, "A backup job's token is required.");
    }
    if method == "PUT" && action.starts_with("parts/") {
        let bytes = request.bytes().await?;
        if bytes.len() as u64 > g1t_contracts::backups::PART_BYTES {
            return fail(FailureCode::Invalid, "A part holds 32 MiB at most.");
        }
        let headers = worker::Headers::new();
        headers.set(TOKEN_HEADER, &token)?;
        let mut init = worker::RequestInit::new();
        init.with_method(Method::Put)
            .with_headers(headers)
            .with_body(Some(worker::js_sys::Uint8Array::from(bytes.as_slice()).into()));
        let forwarded = Request::new_with_init(&format!("https://repos/backups/{job}/{action}"), &init)?;
        let mut answered = services.repos.fetch_request(forwarded).await?;
        return outcome_as_given(answered.json().await?);
    }
    let rpc = match (method, action) {
        ("POST", "spec") => "backup_spec",
        ("POST", "complete") => "backup_complete",
        ("POST", "fail") => "backup_fail",
        _ => return fail(FailureCode::NotFound, "No such endpoint."),
    };
    let mut body = json_body(request).await;
    if !body.is_object() {
        body = json!({});
    }
    body["job_id"] = json!(job);
    body["token"] = json!(token);
    let answered: Value = g1t_kit::call(&services.repos, rpc, &body).await?;
    outcome_as_given(answered)
}

/// An `Outcome` from a service whose keys are already the API's: the value,
/// or the failure in the shape every endpoint uses.
fn outcome_as_given(answered: Value) -> Result<Response> {
    match serde_json::from_value::<Outcome<Value>>(answered)? {
        Outcome::Ok(value) => Response::from_json(&value),
        Outcome::Fail(refused) => failure(&refused),
    }
}

async fn respond(mut request: Request, env: &Env, rate_policy: &mut Option<limits::Policy>) -> Result<Response> {
    let method = method_name(request.method());
    if method == "OPTIONS" {
        return Ok(Response::empty()?.with_status(204));
    }
    let url = request.url()?;
    // Paths carry no version. An earlier form began with `/v1`, which is
    // still accepted so that nothing already written against it breaks.
    let path = match url.path().strip_prefix("/v1") {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => rest.to_owned(),
        _ => url.path().to_owned(),
    };
    let mut services = Services::new(env)?;
    // MCP is a host of its own hosted, and may be a path on this one
    // self-hosted (addresses.rs).
    let on_mcp = services.addresses.mcp_path(&url).is_some();
    if !on_mcp && !version::supported(request.headers().get(version::HEADER)?.as_deref()) {
        return fail(FailureCode::Invalid, "Unsupported X-G1t-Api-Version. Use 1 or omit the header. See https://docs.g1t.sh/reference/api/#versioning-and-deprecation.");
    }

    // Stripe reporting to billing. Signed with the secret of the endpoint
    // billing registered; the body goes through exactly as received, since
    // the signature covers its bytes.
    if method == "POST" && !on_mcp && path == "/stripe/webhook" {
        return receive_stripe(&mut request, env).await;
    }

    // Outside systems reporting to a connection. They sign what they send
    // with the connection's own secret, which is not a g1t token, so this
    // comes before anything that would read one.
    if method == "POST" && !on_mcp
        && let Some(id) = path.strip_prefix("/hooks/").filter(|id| !id.is_empty() && !id.contains('/')) {
            return receive_hook(&mut request, &services, id).await;
        }

    // A sandbox building a deployment, reporting with its build's token,
    // which is not a g1t token, or a container app's Worker reporting how
    // long its container ran, with its own token. The body goes through as
    // it is: it can carry a Worker's bundled code.
    if method == "POST" && !on_mcp
        && let Some(rest) = path
            .strip_prefix("/deployments/jobs/")
            .map(|rest| format!("jobs/{rest}"))
            .or_else(|| path.strip_prefix("/deployments/apps/").filter(|rest| rest.ends_with("/meter")).map(|rest| format!("apps/{rest}")))
    {
        let target = format!("https://deployments/{rest}");
        let body = request.bytes().await?;
        let headers = worker::Headers::new();
        headers.set("content-type", "application/json")?;
        let mut init = worker::RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(worker::js_sys::Uint8Array::from(body.as_slice()).into()));
        let mut answer = env
            .service("DEPLOYMENTS")?
            .fetch_request(Request::new_with_init(&target, &init)?)
            .await?;
        // A fresh response: a fetched one's headers cannot be changed, and
        // every response gets the API's own on the way out.
        let status = answer.status_code();
        let bytes = answer.bytes().await?;
        let bytes = match serde_json::from_slice::<Value>(&bytes) {
            Ok(body) => serde_json::to_vec(&wire::snake_case(body))?,
            Err(_) => bytes,
        };
        return Ok(Response::from_bytes(bytes)?
            .with_status(status)
            .with_headers({
                let headers = worker::Headers::new();
                headers.set("content-type", "application/json")?;
                headers
            }));
    }

    // The services GitHub's toolkit calls from inside a job, with its
    // runtime token, and the links they hand out (toolkit.rs).
    if !on_mcp && method == "POST"
        && let Some(rest) = path.strip_prefix("/twirp/")
    {
        let (service, rpc) = rest.split_once('/').unwrap_or((rest, ""));
        let (service, rpc) = (service.to_owned(), rpc.to_owned());
        return toolkit::twirp(request, env, &services, &service, &rpc).await;
    }
    if !on_mcp && let Some(rest) = path.strip_prefix("/actions/toolkit/_apis/artifactcache/") {
        let rest = rest.to_owned();
        return toolkit::cache_v1(request, env, &services, method, &rest).await;
    }
    if !on_mcp && let Some(token) = path.strip_prefix("/actions/toolkit/blobs/") {
        let token = token.to_owned();
        return toolkit::blob(request, env, &services, method, &token).await;
    }
    // g1t as an OIDC issuer for workflow jobs (oidc.rs).
    if !on_mcp && method == "GET" && path.starts_with("/actions/oidc/") {
        return oidc::handle(&request, env, &services, &path).await;
    }

    // A sandbox's artifacts and cache, with its job's token, which is not a
    // g1t token either.
    if !on_mcp
        && let Some(rest) = path.strip_prefix("/actions/jobs/")
        && (rest.contains("/artifacts") || rest.ends_with("/cache") || rest.contains("/cache/uploads"))
    {
        let rest = rest.to_owned();
        return blobs::for_job(request, env, &services, method, &rest).await;
    }
    // A self-hosted job's request to a brokered secret's host, passed to
    // g1t to be filled in (broker.rs). The job's token is the credential.
    if !on_mcp
        && method == "POST"
        && let Some(job) = broker::job_of(&path)
    {
        let job = job.to_owned();
        return broker::relay(request, &services, &job).await;
    }

    // A self-hosted runner, with a registration token or its own
    // credential, neither of which is a g1t access token.
    if method == "POST"
        && !on_mcp
        && path.starts_with("/runners/")
        && let Some(response) = runners::handle(&mut request, &services, &path).await?
    {
        return Ok(response);
    }

    // Per token, or per address without one (limits.rs).
    if let Some(limited) = limits::limited(&request, env, method, &path, on_mcp, rate_policy).await? {
        return Ok(limited);
    }
    let viewer = match authenticate(&request, &services).await? {
        Ok(viewer) => viewer,
        Err(refused) => return Ok(limits::wrong_token(&request, env, on_mcp, rate_policy).await?.unwrap_or(refused)),
    };
    // A person who has not confirmed their email address: who they are,
    // their addresses, and confirming one, nothing else (REST or MCP).
    if viewer.as_ref().is_some_and(User::awaits_confirmation) && !pending_may(method, &path, on_mcp) {
        return fail(
            FailureCode::Forbidden,
            &g1t_contracts::accounts::confirm_email_first(&services.addresses.site),
        );
    }
    services.audit = audit::AuditContext::of(&request, on_mcp);
    // A run's token: what it may do comes with it, on the composite
    // identity identity resolved it to. Any other token of g1t's own
    // principal (the agent tokens g1t no longer issues) does nothing.
    if let Some(acting) = viewer.as_ref().and_then(|viewer| viewer.acting.as_ref()) {
        services.scope = Some(acting.scope.clone());
    } else if viewer.as_ref().is_some_and(|viewer| viewer.kind == PrincipalKind::Agent) {
        return fail(FailureCode::Unauthenticated, "Invalid access token.");
    }
    if let Some(response) = oauth::handle(&mut request, &services, method, &path).await? {
        return Ok(response);
    }
    if on_mcp {
        return mcp::handle(request, &services, &viewer).await;
    }

    // Workflow logs to download: a run's as a zip, a job's as text (logs.rs).
    if method == "GET" {
        let text = url.query_pairs().any(|(name, value)| name == "format" && value == "text");
        if let Some(wanted) = logs::wanted(&path, text) {
            return logs::download(&services, &viewer, wanted).await;
        }
    }

    match (method, path.trim_end_matches('/')) {
        ("GET", "") => return reply(&index(&services.addresses)),
        ("GET", "/openapi.json") => return Response::from_json(&openapi::document()),
        // One of a run's artifacts downloaded by name (the run's artifacts
        // are listed by the REST route in rest.rs).
        ("GET", path) if path.starts_with("/repos/") && path.contains("/actions/runs/") && path.contains("/artifacts/") => {
            let parts: Vec<&str> = path.trim_start_matches("/repos/").split('/').collect();
            if let [owner, repo, "actions", "runs", run, "artifacts", name] = parts.as_slice() {
                // A workflow job's token reaches its own repository only.
                if viewer
                    .as_ref()
                    .and_then(|user| user.token.as_deref())
                    .is_some_and(|token| !token.reaches(&format!("{owner}/{repo}")))
                {
                    return fail(FailureCode::NotFound, "No such run.");
                }
                return blobs::download(env, &services, &viewer, owner, repo, run, name).await;
            }
        }
        ("POST", "/device/code") => return device_code(&mut request, &services).await,
        ("POST", "/device/token") => return device_token(&mut request, &services).await,
        // Where a pull request lives, for a tool that knows only its fork.
        ("GET", path) if path.starts_with("/pulls/") && !path[7..].contains('/') => {
            let located: Outcome<Value> = g1t_kit::call(
                &services.work,
                "locate_pull",
                &json!({ "id": &path[7..], "viewer": viewer }),
            )
            .await?;
            return match located {
                Outcome::Ok(value) => reply(&value),
                Outcome::Fail(refused) => failure(&refused),
            };
        }
        ("POST", path) if path.starts_with("/mergechecks/") => {
            let pull_id = path.trim_start_matches("/mergechecks/").to_owned();
            return report_mergecheck(&mut request, &services, &pull_id).await;
        }
        // A sandbox making a repository's nightly backup. The job's own
        // token, in its header, is the credential.
        (method, path) if path.starts_with("/backups/") => {
            return backup_job(&mut request, &services, method, path).await;
        }
        ("POST", path) if path.starts_with("/queue/") => {
            let entry_id = path.trim_start_matches("/queue/").to_owned();
            return report_queue(&mut request, &services, &entry_id).await;
        }
        // A sandbox running a GitHub Actions job: fetching the job, and
        // reporting how it goes. The job's own token is the credential.
        // A sandbox downloading an action's archive that g1t keeps
        // (actions' registry.rs). The job's own token is the credential.
        ("POST", path) if path.starts_with("/actions/jobs/") && path.ends_with("/archive") => {
            let job = path.trim_start_matches("/actions/jobs/").trim_end_matches("/archive").to_owned();
            let body = json_body(&mut request).await;
            let kept: Outcome<Value> = g1t_kit::call(
                &services.actions,
                "job_action_archive",
                &json!({ "job": job, "token": body["token"], "report": body["report"] }),
            )
            .await?;
            let kept = match kept {
                Outcome::Ok(kept) => kept,
                Outcome::Fail(refused) => return failure(&refused),
            };
            let bucket = env.bucket("ACTIONS_CACHE")?;
            let object = kept["object"].as_str().unwrap_or_default();
            let Some(stored) = bucket.get(object).execute().await? else {
                return fail(FailureCode::NotFound, "The archive is gone.");
            };
            let Some(body) = stored.body() else {
                return fail(FailureCode::NotFound, "The archive is gone.");
            };
            let mut response = Response::from_body(body.response_body()?)?;
            response.headers_mut().set("content-type", "application/gzip")?;
            return Ok(response);
        }
        ("POST", path) if path.starts_with("/actions/jobs/") => {
            let rest = path.trim_start_matches("/actions/jobs/");
            // `/action`: where to fetch another repository's action from (on
            // g1t, with a read token for a private one, or GitHub).
            let (job, method) = match (rest.strip_suffix("/spec"), rest.strip_suffix("/action")) {
                (Some(job), _) => (job.to_owned(), "job_spec"),
                (_, Some(job)) => (job.to_owned(), "job_action"),
                _ => (rest.to_owned(), "job_report"),
            };
            let body = json_body(&mut request).await;
            // `rotate`: a harness that takes a new token with the spec and
            // lets go of the one it asked with (plan.rs `job_spec`).
            let rotate = method == "job_spec" && body["rotate"].as_bool() == Some(true);
            // `broker`: a self-hosted harness that passes its job's
            // requests to brokered hosts through g1t (broker.rs).
            let broker = method == "job_spec" && body["broker"].as_bool() == Some(true);
            let answered: Outcome<Value> = g1t_kit::call(
                &services.actions,
                method,
                &json!({ "job": job, "token": body["token"], "report": body["report"], "rotate": rotate, "broker": broker }),
            )
            .await?;
            return match answered {
                // A job's spec is the workflow and its contexts as GitHub
                // has them; only g1t's own keys around them are converted.
                Outcome::Ok(value) => {
                    let mut spec = wire::snake_case_keeping(value, JOB_SPEC_AS_GIVEN);
                    with_runtime(&mut spec, &services.addresses.api, oidc::configured(env));
                    Response::from_json(&spec)
                }
                Outcome::Fail(refused) => failure(&refused),
            };
        }
        ("POST", path) if path.starts_with("/checks/") => {
            let run_id = path.trim_start_matches("/checks/").to_owned();
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
        snake_case_keys(json_body(&mut request).await)
    };
    let Some((route, input)) = rest::resolve(method, &path, &query, body) else {
        return fail(FailureCode::NotFound, "No such endpoint.");
    };
    match audit::run(route.op, &services, &viewer, &input).await? {
        // A download is a redirect to its signed link, as GitHub's is: an
        // artifact's, and a repository's tarball and zipball.
        Outcome::Ok(value) if route.op.redirects() => {
            match value["url"].as_str().and_then(|url| worker::Url::parse(url).ok()) {
                Some(url) => Response::redirect_with_status(url, 302),
                None => reply(&value),
            }
        }
        // A deleted comment has nothing to say, as GitHub's says nothing.
        Outcome::Ok(_) if route.no_content() => Ok(Response::empty()?.with_status(204)),
        Outcome::Ok(value) => Response::from_json(&wire::snake_case_keeping(value, route.op.as_given())),
        // A token without the scope a call needs is told which one.
        Outcome::Fail(refused) => match (refused.code, audit::missing_scope(route.op, &viewer, &input)) {
            (FailureCode::Forbidden, Some(scope)) => Ok(reply(&json!({
                "error": {
                    "code": refused.code,
                    "message": refused.message,
                    "needed_scope": scope.as_str(),
                }
            }))?
            .with_status(403)),
            _ => failure(&refused),
        },
    }
}

/// Request bodies take the same keys as the MCP tools, `snake_case`, as
/// responses use; the `camelCase` spelling is accepted too.
fn snake_case_keys(body: Value) -> Value {
    let Value::Object(fields) = body else {
        return body;
    };
    let mut out = serde_json::Map::new();
    for (key, value) in fields {
        let mut snake = String::with_capacity(key.len() + 4);
        for c in key.chars() {
            if c.is_ascii_uppercase() {
                snake.push('_');
                snake.push(c.to_ascii_lowercase());
            } else {
                snake.push(c);
            }
        }
        // A key given in both spellings keeps the snake_case one.
        if snake != key && out.contains_key(&snake) {
            continue;
        }
        out.insert(snake, value);
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::snake_case_keys;
    use serde_json::json;

    #[test]
    fn an_unconfirmed_account_may_only_see_itself_and_confirm_its_address() {
        assert!(super::pending_may("GET", "/user", false));
        assert!(super::pending_may("GET", "/user/emails/", false));
        assert!(super::pending_may("POST", "/user/emails/confirm", false));
        assert!(!super::pending_may("POST", "/user/emails", false));
        assert!(!super::pending_may("POST", "/workspaces", false));
        assert!(!super::pending_may("GET", "/repos/acme/rocket", false));
        assert!(!super::pending_may("POST", "/user/emails/confirm", true));
        assert!(!super::pending_may("POST", "/", true));
    }

    #[test]
    fn a_job_spec_gets_the_toolkits_variables() {
        // As the actions service sends it, converted as the API does.
        let sent = json!({ "variables": { "GITHUB_SHA": "abc" }, "runtime": { "token": "h.p.s", "idToken": true }, "nextToken": "n" });
        let mut spec = g1t_kit::wire::snake_case_keeping(sent.clone(), super::JOB_SPEC_AS_GIVEN);
        super::with_runtime(&mut spec, "https://api.g1t.sh", true);
        assert!(spec.get("runtime").is_none(), "the runner never sees it");
        // The token that replaces the one the harness asked with.
        assert_eq!(spec["next_token"], "n");
        let vars = &spec["variables"];
        assert_eq!(vars["GITHUB_SHA"], "abc");
        assert_eq!(vars["ACTIONS_RUNTIME_TOKEN"], "h.p.s");
        assert_eq!(vars["ACTIONS_CACHE_URL"], "https://api.g1t.sh/actions/toolkit/");
        assert_eq!(vars["ACTIONS_ID_TOKEN_REQUEST_TOKEN"], "h.p.s");
        // No OIDC key here: no OIDC variables, whatever the job may do.
        let mut spec = g1t_kit::wire::snake_case_keeping(sent, super::JOB_SPEC_AS_GIVEN);
        super::with_runtime(&mut spec, "https://api.g1t.sh", false);
        assert!(spec["variables"].get("ACTIONS_ID_TOKEN_REQUEST_URL").is_none());
        assert_eq!(spec["variables"]["ACTIONS_RESULTS_URL"], "https://api.g1t.sh/");
    }

    #[test]
    fn camel_case_keys_are_accepted() {
        assert_eq!(
            snake_case_keys(json!({ "countAgentApprovals": false, "title": "x" })),
            json!({ "count_agent_approvals": false, "title": "x" })
        );
    }

    #[test]
    fn snake_case_wins_when_both_are_given() {
        assert_eq!(
            snake_case_keys(json!({ "keep_issue_open": true, "keepIssueOpen": false })),
            json!({ "keep_issue_open": true })
        );
    }
}

// The API is called from browsers too: the reference's explorer, and apps
// built on g1t. It carries no cookies, so any origin may call it.
/// The signal an OTLP path sends (`/otlp/v1/traces`, `logs` or `metrics`),
/// if it is one.
fn otlp_signal(path: &str) -> Option<&'static str> {
    let path = path.strip_prefix("/v1").filter(|rest| rest.starts_with('/')).unwrap_or(path);
    match path.trim_end_matches('/') {
        "/otlp/v1/traces" => Some("traces"),
        "/otlp/v1/logs" => Some("logs"),
        "/otlp/v1/metrics" => Some("metrics"),
        _ => None,
    }
}

/// OpenTelemetry sent to the API's own address: a self-hosted install's
/// only door, and a second one hosted. It goes to the telemetry service as
/// it came, which checks the project's ingest token itself (not a g1t
/// token), and its answer comes back as it is, CORS headers included.
async fn forward_otlp(mut request: Request, env: &Env, signal: &str) -> Result<Response> {
    let method = request.method();
    let headers = worker::Headers::new();
    for name in ["authorization", "x-g1t-token", "content-type", "content-encoding"] {
        if let Some(value) = request.headers().get(name)? {
            headers.set(name, &value)?;
        }
    }
    let mut init = worker::RequestInit::new();
    init.with_method(method.clone()).with_headers(headers);
    if method == Method::Post {
        let body = request.bytes().await?;
        init.with_body(Some(worker::js_sys::Uint8Array::from(body.as_slice()).into()));
    }
    let target = format!("https://telemetry/v1/{signal}");
    let mut answer = env.service("TELEMETRY")?.fetch_request(Request::new_with_init(&target, &init)?).await?;
    // A fresh response, with the service's headers: a fetched one's cannot
    // be changed, and nothing should be added to them.
    let status = answer.status_code();
    let headers = worker::Headers::new();
    for (name, value) in answer.headers().entries() {
        headers.set(&name, &value)?;
    }
    let bytes = answer.bytes().await?;
    let response = if bytes.is_empty() { Response::empty()? } else { Response::from_bytes(bytes)? };
    Ok(response.with_status(status).with_headers(headers))
}

#[event(fetch)]
async fn fetch(request: Request, env: Env, _ctx: Context) -> Result<Response> {
    // OTLP passes through untouched, before any g1t token is read.
    if let Some(signal) = otlp_signal(&request.path()) {
        return forward_otlp(request, &env, signal).await;
    }
    let on_mcp = addresses::Addresses::from_env(&env).mcp_path(&request.url()?).is_some();
    let mut rate_policy = None;
    let mut response = respond(request, &env, &mut rate_policy).await?;
    if let Some(policy) = rate_policy { policy.apply(&mut response)?; }
    let headers = response.headers_mut();
    if !on_mcp { headers.set(version::HEADER, version::CURRENT)?; }
    headers.set("access-control-allow-origin", "*")?;
    headers.set(
        "access-control-allow-headers",
        "authorization, content-type, x-g1t-api-version",
    )?;
    headers.set("access-control-allow-methods", "GET, POST, PATCH, OPTIONS")?;
    headers.set("access-control-expose-headers", "www-authenticate, retry-after, ratelimit-policy, ratelimit, x-g1t-api-version, deprecation, sunset, link")?;
    Ok(response)
}
