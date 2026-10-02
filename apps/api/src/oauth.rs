//! The OAuth 2.1 endpoints an application calls directly. The page where a
//! person approves is on the site, at g1t.sh/oauth/authorize.
//!
//! Applications sign people in with the authorization code flow and PKCE.
//! They are public clients: none holds a secret.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use g1t_contracts::Outcome;
use g1t_contracts::identity::{OAuthExchangeArgs, OAuthRefreshArgs, OAuthTokens};
use serde::Serialize;
use serde_json::{Map, Value, json};
use worker::{Request, Response, Result, Url};

use crate::operations::Services;

const ISSUER: &str = "https://api.g1t.sh";
const MCP_RESOURCE: &str = "https://mcp.g1t.sh";
/// What an MCP client is told when it must sign in first (RFC 9728).
pub const MCP_CHALLENGE: &str =
    "Bearer resource_metadata=\"https://mcp.g1t.sh/.well-known/oauth-protected-resource\"";

const CLIENT_PREFIX: &str = "g1c_";
const MAX_NAME_CHARS: usize = 80;
const MAX_REDIRECTS: usize = 5;
const MAX_URI_CHARS: usize = 500;
/// Schemes that run or expose content instead of opening an application.
const FORBIDDEN_SCHEMES: [&str; 6] = ["javascript", "data", "file", "blob", "vbscript", "about"];
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// Whether an application may ask to be redirected here: an https address,
/// http on this machine only, or an application's own scheme.
fn is_valid_redirect_uri(uri: &str) -> bool {
    let Ok(url) = Url::parse(uri) else {
        return false;
    };
    if uri.len() > MAX_URI_CHARS || url.fragment().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => true,
        "http" => url
            .host_str()
            .is_some_and(|host| LOOPBACK_HOSTS.contains(&host)),
        scheme => !FORBIDDEN_SCHEMES.contains(&scheme),
    }
}

/// A client as its id carries it. The site decodes the same shape; see
/// `packages/contracts/src/oauth.ts`.
#[derive(Serialize)]
struct Client<'a> {
    n: &'a str,
    r: &'a [String],
}

/// The client id for a client, or `None` if what it asks for is not
/// allowed. Nothing is stored: the id is the registration itself, encoded,
/// so this open endpoint cannot be used to fill a database.
fn encode_client(name: &str, redirect_uris: &[String]) -> Option<(String, String)> {
    let name: String = name.trim().chars().take(MAX_NAME_CHARS).collect();
    let name = if name.is_empty() {
        "An application".to_owned()
    } else {
        name
    };
    let allowed = !redirect_uris.is_empty()
        && redirect_uris.len() <= MAX_REDIRECTS
        && redirect_uris.iter().all(|uri| is_valid_redirect_uri(uri));
    if !allowed {
        return None;
    }
    let encoded = serde_json::to_string(&Client {
        n: &name,
        r: redirect_uris,
    })
    .ok()?;
    Some((
        format!("{CLIENT_PREFIX}{}", URL_SAFE_NO_PAD.encode(encoded)),
        name,
    ))
}

fn oauth_error(error: &str, description: &str) -> Result<Response> {
    let mut response =
        Response::from_json(&json!({ "error": error, "error_description": description }))?
            .with_status(400);
    response.headers_mut().set("cache-control", "no-store")?;
    Ok(response)
}

/// The request body as fields, whether sent as a form or as JSON.
async fn fields(request: &mut Request) -> Map<String, Value> {
    let json = request
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .is_some_and(|kind| kind.contains("json"));
    let body = request.text().await.unwrap_or_default();
    if json {
        return match serde_json::from_str(&body) {
            Ok(Value::Object(fields)) => fields,
            _ => Map::new(),
        };
    }
    form_urlencoded::parse(body.as_bytes())
        .map(|(name, value)| (name.into_owned(), Value::String(value.into_owned())))
        .collect()
}

fn server_metadata() -> Value {
    json!({
        "issuer": ISSUER,
        "authorization_endpoint": "https://g1t.sh/oauth/authorize",
        "token_endpoint": format!("{ISSUER}/oauth/token"),
        "registration_endpoint": format!("{ISSUER}/oauth/register"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "service_documentation": "https://docs.g1t.sh/guides/authentication/",
    })
}

async fn register(request: &mut Request) -> Result<Response> {
    let body = fields(request).await;
    let redirect_uris: Vec<String> = body
        .get("redirect_uris")
        .and_then(Value::as_array)
        .map(|uris| {
            uris.iter()
                .filter_map(|uri| uri.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let name = body
        .get("client_name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some((client_id, client_name)) = encode_client(name, &redirect_uris) else {
        return oauth_error(
            "invalid_redirect_uri",
            "Give one to five redirect_uris: https addresses, http on localhost, or the application's own scheme.",
        );
    };
    Ok(Response::from_json(&json!({
        "client_id": client_id,
        "client_name": client_name,
        "redirect_uris": redirect_uris,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    }))?
    .with_status(201))
}

async fn token(request: &mut Request, services: &Services) -> Result<Response> {
    let body = fields(request).await;
    let text = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let issued: Outcome<OAuthTokens> = match text("grant_type").as_str() {
        "authorization_code" => {
            if text("code").is_empty()
                || text("code_verifier").is_empty()
                || text("client_id").is_empty()
            {
                return oauth_error(
                    "invalid_request",
                    "code, code_verifier and client_id are required.",
                );
            }
            g1t_kit::call(
                &services.identity,
                "oauth_exchange",
                &OAuthExchangeArgs {
                    code: text("code"),
                    code_verifier: text("code_verifier"),
                    client_id: text("client_id"),
                    redirect_uri: text("redirect_uri"),
                },
            )
            .await?
        }
        "refresh_token" => {
            if text("refresh_token").is_empty() || text("client_id").is_empty() {
                return oauth_error(
                    "invalid_request",
                    "refresh_token and client_id are required.",
                );
            }
            g1t_kit::call(
                &services.identity,
                "oauth_refresh",
                &OAuthRefreshArgs {
                    refresh_token: text("refresh_token"),
                    client_id: text("client_id"),
                },
            )
            .await?
        }
        _ => {
            return oauth_error(
                "unsupported_grant_type",
                "grant_type must be authorization_code or refresh_token.",
            );
        }
    };
    let tokens = match issued {
        Outcome::Ok(tokens) => tokens,
        Outcome::Fail(failure) => return oauth_error("invalid_grant", &failure.message),
    };
    let mut response = Response::from_json(&json!({
        "access_token": tokens.access_token,
        "token_type": "Bearer",
        "expires_in": tokens.expires_in,
        "refresh_token": tokens.refresh_token,
    }))?;
    response.headers_mut().set("cache-control", "no-store")?;
    Ok(response)
}

/// Answers the request if it is for an OAuth endpoint. These are served on
/// both hosts: an MCP client looks for the metadata next to the MCP server.
pub async fn handle(
    request: &mut Request,
    services: &Services,
    method: &str,
    path: &str,
) -> Result<Option<Response>> {
    let response = match (method, path) {
        ("GET", "/.well-known/oauth-authorization-server") => {
            Response::from_json(&server_metadata())?
        }
        // Asked for with or without the MCP server's path appended.
        ("GET", path) if path.starts_with("/.well-known/oauth-protected-resource") => {
            Response::from_json(&json!({
                "resource": MCP_RESOURCE,
                "authorization_servers": [ISSUER],
                "bearer_methods_supported": ["header"],
                "resource_documentation": "https://docs.g1t.sh/guides/bring-your-own-agent/",
            }))?
        }
        ("POST", "/oauth/register") => register(request).await?,
        ("POST", "/oauth/token") => token(request, services).await?,
        _ => return Ok(None),
    };
    Ok(Some(response))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uris(list: &[&str]) -> Vec<String> {
        list.iter().map(|uri| (*uri).to_owned()).collect()
    }

    #[test]
    fn a_client_id_matches_the_one_the_site_decodes() {
        // Produced by `encodeOAuthClient` in packages/contracts/src/oauth.ts.
        let (id, name) =
            encode_client(" e2e MCP client ", &uris(&["http://localhost:1/callback"])).unwrap();
        assert_eq!(
            id,
            "g1c_eyJuIjoiZTJlIE1DUCBjbGllbnQiLCJyIjpbImh0dHA6Ly9sb2NhbGhvc3Q6MS9jYWxsYmFjayJdfQ"
        );
        assert_eq!(name, "e2e MCP client");
    }

    #[test]
    fn redirects_are_https_loopback_or_an_application_scheme() {
        for good in [
            "https://example.com/cb",
            "http://localhost:8123/cb",
            "http://127.0.0.1/cb",
            "cursor://anysphere.cursor-mcp/oauth/callback",
        ] {
            assert!(is_valid_redirect_uri(good), "{good}");
        }
        for bad in [
            "http://evil.example/cb",
            "javascript:alert(1)",
            "data:text/html,x",
            "https://example.com/cb#fragment",
            "not a url",
        ] {
            assert!(!is_valid_redirect_uri(bad), "{bad}");
        }
    }

    #[test]
    fn a_client_needs_one_to_five_redirects() {
        assert!(encode_client("x", &[]).is_none());
        assert!(encode_client("x", &uris(&["https://a.example/cb"; 6])).is_none());
        let (_, name) = encode_client("", &uris(&["https://a.example/cb"])).unwrap();
        assert_eq!(name, "An application");
    }
}
