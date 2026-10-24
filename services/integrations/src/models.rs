//! A workspace's AI providers: where each one's API is, how it takes its
//! key, and checking that the key works by asking the provider for its
//! models.

use g1t_contracts::ai::{AiConfig, AiProvider};
use worker::{Method, Result};

use crate::http;

/// Where requests go: without `/v1` for Anthropic's API, with the version
/// for OpenAI's (`…/v1`, or Gemini's `…/v1beta/openai`).
pub fn base_url(provider: AiProvider, config: &AiConfig) -> String {
    let given = config.base_url.as_deref().unwrap_or_default().trim_end_matches('/');
    match provider {
        AiProvider::AnthropicEndpoint => given.trim_end_matches("/v1").to_owned(),
        AiProvider::OpenaiEndpoint => given.to_owned(),
        // Azure's v1 API, on the workspace's own resource.
        AiProvider::AzureOpenai => format!("{}/openai/v1", given.trim_end_matches("/openai/v1").trim_end_matches("/openai")),
        _ => provider.spec().base_url.to_owned(),
    }
}

/// The header the key goes in; `authorization` means `Bearer <key>`.
pub fn auth_header(provider: AiProvider, config: &AiConfig) -> String {
    match provider {
        AiProvider::AnthropicEndpoint | AiProvider::OpenaiEndpoint => {
            config.auth_header.clone().unwrap_or_else(|| provider.spec().auth_header.to_owned())
        }
        _ => provider.spec().auth_header.to_owned(),
    }
}

/// Whether a model id is one for chat: not embeddings, images,
/// speech or moderation.
fn for_chat(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    !["embed", "tts", "whisper", "dall-e", "image", "moderation", "audio", "transcribe", "realtime", "search", "aqa", "imagen", "veo"]
        .iter()
        .any(|word| id.contains(word))
}

/// Asks the provider for its models with the key. `Ok` with what to say and
/// the models it offers; `Err` with what went wrong.
pub async fn test(
    provider: AiProvider,
    config: &AiConfig,
    key: Option<&str>,
) -> Result<std::result::Result<(String, Vec<String>), String>> {
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
            headers.push((header.as_str(), key));
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
        models.truncate(1000);
        let message = match models.len() {
            0 => format!("{system} accepted the key."),
            count => format!("{system} accepted the key and offers {count} models."),
        };
        return Ok(Ok((message, models)));
    }
    // A proxy may answer messages but not list models: it was reached, but
    // the key could not be checked.
    if answer.status == 404 && matches!(provider, AiProvider::AnthropicEndpoint | AiProvider::OpenaiEndpoint) {
        return Ok(Ok(("Reached the endpoint. It does not list models, so the key could not be checked.".to_owned(), Vec::new())));
    }
    Ok(Err(answer.problem(system)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_provider_has_its_address_and_header() {
        let config = AiConfig { base_url: Some("https://llm.acme.dev/v1/".to_owned()), ..AiConfig::default() };
        assert_eq!(base_url(AiProvider::Openai, &config), "https://api.openai.com/v1");
        assert_eq!(base_url(AiProvider::OpenaiEndpoint, &config), "https://llm.acme.dev/v1");
        assert_eq!(base_url(AiProvider::AnthropicEndpoint, &config), "https://llm.acme.dev");
        assert_eq!(auth_header(AiProvider::Gemini, &config), "authorization");
        assert_eq!(auth_header(AiProvider::Anthropic, &config), "x-api-key");
        assert_eq!(auth_header(AiProvider::AzureOpenai, &config), "api-key");
        assert_eq!(base_url(AiProvider::Groq, &config), "https://api.groq.com/openai/v1");
        let azure = AiConfig { base_url: Some("https://acme.openai.azure.com/".to_owned()), ..AiConfig::default() };
        assert_eq!(base_url(AiProvider::AzureOpenai, &azure), "https://acme.openai.azure.com/openai/v1");
    }

    #[test]
    fn only_models_that_can_chat_are_offered() {
        assert!(for_chat("gpt-5"));
        assert!(for_chat("gemini-2.5-pro"));
        assert!(!for_chat("text-embedding-3-large"));
        assert!(!for_chat("gpt-image-1"));
    }
}
