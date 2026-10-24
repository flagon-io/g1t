//! SCIM 2.0 for a workspace's identity provider, at
//! `/scim/v2/{workspace}/…`: the provider assigns and unassigns people,
//! with the workspace's SCIM token as its bearer token, which is not a g1t
//! access token. Identity checks the token and answers everything
//! (services/identity/src/sso/provisioning.rs); this passes the request on
//! and writes the answer as `application/scim+json`.

use g1t_contracts::sso::{ScimAnswer, ScimRequestArgs};
use serde_json::json;
use worker::{Request, Response, Result};

use crate::operations::Services;

/// The workspace and the rest of a path after `/scim/v2/`.
pub fn split(rest: &str) -> Option<(String, String)> {
    let (workspace, path) = match rest.split_once('/') {
        Some((workspace, path)) => (workspace, format!("/{path}")),
        None => (rest, "/".to_owned()),
    };
    let workspace = workspace.trim().to_lowercase();
    // The workspace's id (`wsp_…`), or for an older setup its name.
    let valid =
        !workspace.is_empty() && workspace.len() <= 64 && workspace.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    valid.then_some((workspace, path))
}

fn reply(status: u16, body: Option<serde_json::Value>) -> Result<Response> {
    let mut response = match body {
        Some(body) => Response::from_json(&body)?,
        None => Response::empty()?,
    }
    .with_status(status);
    if status != 204 {
        response.headers_mut().set("content-type", "application/scim+json")?;
    }
    response.headers_mut().set("cache-control", "no-store")?;
    Ok(response)
}

pub async fn handle(mut request: Request, services: &Services, method: &str, rest: &str) -> Result<Response> {
    let Some((workspace, path)) = split(rest) else {
        return reply(
            404,
            Some(
                json!({ "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"], "status": "404", "detail": "Name the workspace: /scim/v2/{workspace}/Users." }),
            ),
        );
    };
    let query = request.url()?.query().map(str::to_owned);
    let body = if matches!(method, "POST" | "PUT" | "PATCH") { Some(request.text().await?) } else { None };
    let base = format!("{}/scim/v2/{workspace}", services.addresses.api);
    let args = ScimRequestArgs { workspace, token: crate::toolkit::bearer(&request), method: method.to_owned(), path, query, body, base };
    let answer: ScimAnswer = g1t_kit::call(&services.identity, "scim_request", &args).await?;
    reply(answer.status, answer.body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workspace_comes_first() {
        assert_eq!(split("acme/Users/scu_1"), Some(("acme".into(), "/Users/scu_1".into())));
        assert_eq!(split("Acme/Users"), Some(("acme".into(), "/Users".into())));
        assert_eq!(split("acme"), Some(("acme".into(), "/".into())));
        assert_eq!(split("/Users"), None);
        assert_eq!(split("ac me/Users"), None);
        assert_eq!(split("wsp_01m54abc/Users"), Some(("wsp_01m54abc".into(), "/Users".into())));
    }
}
