//! What a self-hosted runner calls: registering with a registration token,
//! then polling for work, saying how work ended and removing itself, with
//! its own credential. Neither is a g1t access token, so these are served
//! before anything reads one, and no other endpoint accepts either.
//!
//! | Route | Body |
//! | --- | --- |
//! | `POST /runners/register` | `token`, `name`, `labels`, `os`, `arch`, `version`, `ephemeral`, `group`, `replace`, `isolation`, `machine`, `cpus`, `memory_mib`, `docker`, `sizes` |
//! | `POST /runners/{id}/poll` | `version`, `running`, `wait_ms`, `isolation`, `cpus`, `memory_mib`, `docker`, `sizes` |
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

/// The sizes a runner says it takes: each a machine's key, with the CPUs
/// and MiB its jobs get where it gives more. Null when it says none (an
/// older runner), and an entry that is not one is left out.
fn sizes(given: &Value) -> Value {
    let Some(given) = given.as_array() else { return Value::Null };
    let kept: Vec<Value> = given
        .iter()
        .take(16)
        .filter_map(|size| {
            let key = size["size"].as_str()?;
            Some(json!({ "size": key, "cpus": size["cpus"].as_f64(), "memory_mib": size["memory_mib"].as_u64() }))
        })
        .collect();
    Value::Array(kept)
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
            "isolation": body["isolation"].as_str(),
            "machine": body["machine"].as_str(),
            "cpus": body["cpus"].as_u64(),
            "memory_mib": body["memory_mib"].as_u64(),
            "docker": body["docker"].as_bool(),
            "sizes": sizes(&body["sizes"]),
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
            args["isolation"] = json!(body["isolation"].as_str());
            args["cpus"] = json!(body["cpus"].as_u64());
            args["memory_mib"] = json!(body["memory_mib"].as_u64());
            args["docker"] = json!(body["docker"].as_bool());
            args["sizes"] = sizes(&body["sizes"]);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_pass_through_as_a_runner_says_them() {
        assert_eq!(sizes(&Value::Null), Value::Null, "an older runner");
        let said = json!([{ "size": "2-core", "cpus": 4, "memory_mib": 16384 }, { "size": "1-core" }, { "cpus": 2 }, "4-core"]);
        assert_eq!(
            sizes(&said),
            json!([{ "size": "2-core", "cpus": 4.0, "memory_mib": 16384 }, { "size": "1-core", "cpus": null, "memory_mib": null }])
        );
    }
}
