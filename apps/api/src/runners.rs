//! What a self-hosted runner calls: registering with a registration token,
//! then polling for work, saying how work ended and removing itself, with
//! its own credential. Neither is a g1t access token, so these are served
//! before anything reads one, and no other endpoint accepts either.
//!
//! | Route | Body |
//! | --- | --- |
//! | `POST /runners/register` | `token`, `name`, `labels`, `os`, `arch`, `version`, `ephemeral`, `group`, `replace` |
//! | `POST /runners/{id}/poll` | `version`, `running`, `wait_ms` |
//! | `POST /runners/{id}/finished` | `id`, `exit_code`, `reason` |
//! | `POST /runners/{id}/remove` | nothing |
//!
//! The last three send `Authorization: Bearer g1tr_…`. See
//! `g1t_contracts::runners` for what each answers.

use g1t_contracts::Outcome;
use g1t_kit::wire;
use serde_json::{Value, json};
use worker::{Request, Response, Result};

use crate::operations::Services;
use crate::{fail, failure, json_body};

/// What is passed through as given: an agent task's environment.
const AS_GIVEN: &[&str] = &["env"];

fn credential(request: &Request) -> Result<String> {
    let header = request.headers().get("authorization")?.unwrap_or_default();
    Ok(match header.split_once(' ') {
        Some((scheme, token)) if scheme.eq_ignore_ascii_case("bearer") => token.trim().to_owned(),
        _ => String::new(),
    })
}

async fn answer(services: &Services, method: &str, args: &Value) -> Result<Response> {
    let answered: Outcome<Value> = g1t_kit::call(&services.actions, method, args).await?;
    match answered {
        Outcome::Ok(value) => Response::from_json(&wire::snake_case_keeping(value, AS_GIVEN)),
        Outcome::Fail(refused) => failure(&refused),
    }
}

/// Serves `path` if it is one of the runner's routes.
pub async fn handle(request: &mut Request, services: &Services, path: &str) -> Result<Option<Response>> {
    let Some(rest) = path.strip_prefix("/runners/") else { return Ok(None) };
    let body = json_body(request).await;
    let body = if body.is_object() { body } else { json!({}) };
    if rest == "register" {
        let args = json!({
            "token": body["token"].as_str().unwrap_or_default(),
            "name": body["name"].as_str().unwrap_or_default(),
            "labels": body["labels"].as_array().cloned().unwrap_or_default(),
            "os": body["os"].as_str().unwrap_or_default(),
            "arch": body["arch"].as_str().unwrap_or_default(),
            "version": body["version"].as_str().unwrap_or_default(),
            "ephemeral": body["ephemeral"].as_bool().unwrap_or(false),
            "group": body["group"].as_str(),
            "replace": body["replace"].as_bool().unwrap_or(false),
        });
        return Ok(Some(answer(services, "runner_register", &args).await?));
    }
    let Some((runner, action)) = rest.split_once('/') else {
        return Ok(Some(fail(g1t_contracts::FailureCode::NotFound, "No such endpoint.")?));
    };
    let auth = json!({ "runner": runner, "credential": credential(request)? });
    let mut args = auth;
    let method = match action {
        "poll" => {
            args["version"] = json!(body["version"].as_str().unwrap_or_default());
            args["running"] = json!(body["running"].as_array().cloned().unwrap_or_default());
            args["wait_ms"] = json!(body["wait_ms"].as_u64().unwrap_or(0));
            "runner_poll"
        }
        "finished" => {
            args["id"] = json!(body["id"].as_str().unwrap_or_default());
            args["exit_code"] = json!(body["exit_code"].as_i64().unwrap_or(1));
            args["reason"] = body["reason"].clone();
            "runner_finished"
        }
        "remove" => "runner_remove_self",
        _ => return Ok(Some(fail(g1t_contracts::FailureCode::NotFound, "No such endpoint.")?)),
    };
    Ok(Some(answer(services, method, &args).await?))
}
