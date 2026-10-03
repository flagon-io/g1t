//! A workspace's own model providers: where each one's API is, how it takes
//! its key, and checking that the key works. The requests themselves go
//! through the model proxy, which never lets a sandbox see a key.

use g1t_contracts::integrations::{ConnectionConfig, Provider};
use worker::{Method, Result};

use crate::http;

/// Where requests go: without `/v1` for Anthropic's API, with the version
/// for OpenAI's (`…/v1`, or Gemini's `…/v1beta/openai`).
pub fn base_url(provider: Provider, config: &ConnectionConfig) -> String {
    let given = || config.base_url.as_deref().unwrap_or_default().trim_end_matches('/').to_owned();
    match provider {
        Provider::AnthropicEndpoint => given().trim_end_matches("/v1").to_owned(),
        Provider::Openai => "https://api.openai.com/v1".to_owned(),
        Provider::Gemini => "https://generativelanguage.googleapis.com/v1beta/openai".to_owned(),
        Provider::OpenaiEndpoint => given(),
        _ => "https://api.anthropic.com".to_owned(),
    }
}

/// The header the key goes in.
pub fn auth_header(provider: Provider, config: &ConnectionConfig) -> String {
    match provider {
        Provider::Anthropic => "x-api-key".to_owned(),
        Provider::AnthropicEndpoint => config.auth_header.clone().unwrap_or_else(|| "x-api-key".to_owned()),
        _ => config.auth_header.clone().unwrap_or_else(|| "authorization".to_owned()),
    }
}

/// Whether a model id is one an agent could use: not embeddings, images,
/// speech or moderation.
fn for_chat(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    !["embed", "tts", "whisper", "dall-e", "image", "moderation", "audio", "transcribe", "realtime", "search", "aqa", "imagen", "veo"]
        .iter()
        .any(|word| id.contains(word))
}

/// Asks the provider for its models with the key. `Ok` with what to say and
/// the models it offers; `Err` with what went wrong.
pub async fn test(provider: Provider, config: &ConnectionConfig, key: Option<&str>) -> Result<std::result::Result<(String, Vec<String>), String>> {
    let base = base_url(provider, config);
    let url = match provider.api() {
        "anthropic" => format!("{base}/v1/models?limit=100"),
        _ => format!("{base}/models"),
    };
    let header = auth_header(provider, config);
    let bearer = key.map(|key| format!("Bearer {key}"));
    let mut headers = vec![("anthropic-version", "2023-06-01")];
    if let Some(key) = key {
        if header == "authorization" {
            headers.push(("authorization", bearer.as_deref().unwrap_or_default()));
        } else {
            headers.push(("x-api-key", key));
        }
    }
    let answer = http::send(Method::Get, &url, &headers, None).await?;
    let system = provider.label();
    if answer.ok() {
        let mut models: Vec<String> = answer.json()["data"]
            .as_array()
            .map(|data| {
                data.iter()
                    .filter_map(|model| model["id"].as_str())
                    // Gemini names models `models/gemini-…`.
                    .map(|id| id.trim_start_matches("models/").to_owned())
                    .filter(|id| for_chat(id))
                    .collect()
            })
            .unwrap_or_default();
        models.sort();
        models.truncate(200);
        let message = match models.len() {
            0 => format!("{system} accepted the key."),
            count => format!("{system} accepted the key and offers {count} models."),
        };
        return Ok(Ok((message, models)));
    }
    // A proxy may answer messages but not list models: it was reached, and
    // whether the key works shows on the first run.
    if answer.status == 404 && matches!(provider, Provider::AnthropicEndpoint | Provider::OpenaiEndpoint) {
        return Ok(Ok((
            "Reached the endpoint. It does not list models, so the key will be checked on the first run.".to_owned(),
            Vec::new(),
        )));
    }
    Ok(Err(answer.problem(system)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_provider_has_its_address_and_header() {
        let config = ConnectionConfig {
            base_url: Some("https://llm.acme.dev/v1/".to_owned()),
            ..ConnectionConfig::default()
        };
        assert_eq!(base_url(Provider::Openai, &config), "https://api.openai.com/v1");
        assert_eq!(base_url(Provider::OpenaiEndpoint, &config), "https://llm.acme.dev/v1");
        assert_eq!(base_url(Provider::AnthropicEndpoint, &config), "https://llm.acme.dev");
        assert_eq!(auth_header(Provider::Gemini, &config), "authorization");
        assert_eq!(auth_header(Provider::Anthropic, &config), "x-api-key");
    }

    #[test]
    fn only_models_that_can_chat_are_offered() {
        assert!(for_chat("gpt-5"));
        assert!(for_chat("gemini-2.5-pro"));
        assert!(!for_chat("text-embedding-3-large"));
        assert!(!for_chat("gpt-image-1"));
    }
}
