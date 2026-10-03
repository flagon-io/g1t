//! A workspace's own model provider: checking that its key works. The
//! requests themselves go through the model proxy, which never lets a
//! sandbox see the key.

use g1t_contracts::integrations::{ConnectionConfig, Provider};
use worker::{Method, Result};

use crate::http;

/// Where requests go, without `/v1`.
pub fn base_url(provider: Provider, config: &ConnectionConfig) -> String {
    match provider {
        Provider::AnthropicEndpoint => config.base_url.as_deref().unwrap_or_default().trim_end_matches('/').trim_end_matches("/v1").to_owned(),
        _ => "https://api.anthropic.com".to_owned(),
    }
}

pub async fn test(provider: Provider, config: &ConnectionConfig, key: Option<&str>) -> Result<std::result::Result<String, String>> {
    let base = base_url(provider, config);
    let bearer = key.map(|key| format!("Bearer {key}"));
    let mut headers = vec![("anthropic-version", "2023-06-01")];
    match (key, config.auth_header.as_deref()) {
        (Some(_), Some("authorization")) => headers.push(("authorization", bearer.as_deref().unwrap_or_default())),
        (Some(key), _) => headers.push(("x-api-key", key)),
        (None, _) => {}
    }
    let answer = http::send(Method::Get, &format!("{base}/v1/models"), &headers, None).await?;
    let system = if provider == Provider::Anthropic { "Anthropic" } else { "The endpoint" };
    if answer.ok() {
        let models = answer.json()["data"].as_array().map_or(0, Vec::len);
        return Ok(Ok(match models {
            0 => format!("{system} accepted the key."),
            count => format!("{system} accepted the key and offers {count} models."),
        }));
    }
    // A proxy may answer messages but not list models: it was reached, and
    // whether the key works shows on the first run.
    if answer.status == 404 && provider == Provider::AnthropicEndpoint {
        return Ok(Ok("Reached the endpoint. It does not list models, so the key will be checked on the first run.".to_owned()));
    }
    Ok(Err(answer.problem(system)))
}
