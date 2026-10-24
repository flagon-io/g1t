//! OpenID Connect and OAuth 2.0 for single sign-on: the authorization code
//! flow, with PKCE (S256) and, for OpenID Connect, a nonce.
//!
//! OpenID Connect reads the issuer's discovery document for its endpoints
//! and keys, and the ID token from the token endpoint. The token's
//! signature is verified with the issuer's published keys (jwt.rs) before
//! anything in it is read, and then its claims are checked: issuer,
//! audience (and azp), expiry, issued-at and nonce. Plain OAuth 2.0
//! has no ID token: the person's id and address are claims of the userinfo
//! endpoint's answer, named in the connection.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use worker::{Fetch, Headers, Method, Request, RequestInit, Url};

/// How far apart g1t's clock and the provider's may be.
const SKEW_SECONDS: u64 = 3 * 60;
const UNREACHABLE: &str = "g1t could not reach the identity provider. Try again in a minute.";

/// Where a provider takes each step.
#[derive(Debug, PartialEq, Eq)]
pub struct Endpoints {
    pub authorize: String,
    pub token: String,
    pub userinfo: Option<String>,
    /// OpenID Connect: the issuer, as its discovery document says it.
    pub issuer: Option<String>,
    /// OpenID Connect: where the issuer publishes its signing keys.
    pub jwks: Option<String>,
    /// Whether the client authenticates with HTTP Basic (else in the form).
    pub basic: bool,
}

/// An address g1t will send people or requests to: https only.
pub fn https(url: &str) -> Option<Url> {
    Url::parse(url.trim()).ok().filter(|url| url.scheme() == "https" && url.host_str().is_some())
}

/// The endpoints in a discovery document, for `issuer`.
pub fn endpoints_from(document: &Value, issuer: &str) -> Result<Endpoints, String> {
    let said = document["issuer"].as_str().unwrap_or_default();
    if said.trim_end_matches('/') != issuer.trim_end_matches('/') {
        return Err(format!(
            "The provider's discovery document names the issuer {said:?}, not {issuer:?}. Use the issuer exactly as it says."
        ));
    }
    let endpoint = |field: &str| document[field].as_str().filter(|url| https(url).is_some()).map(str::to_owned);
    let (Some(authorize), Some(token)) = (endpoint("authorization_endpoint"), endpoint("token_endpoint")) else {
        return Err("The provider's discovery document has no https authorization and token endpoints.".to_owned());
    };
    let Some(jwks) = endpoint("jwks_uri") else {
        return Err(
            "The provider's discovery document publishes no signing keys (jwks_uri), so its ID tokens cannot be verified.".to_owned()
        );
    };
    let methods: Vec<&str> = document["token_endpoint_auth_methods_supported"]
        .as_array()
        .map(|methods| methods.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    Ok(Endpoints {
        authorize,
        token,
        userinfo: endpoint("userinfo_endpoint"),
        issuer: Some(said.to_owned()),
        jwks: Some(jwks),
        // Basic is the default when the provider lists none.
        basic: methods.is_empty() || methods.contains(&"client_secret_basic"),
    })
}

/// Reads an issuer's discovery document.
pub async fn discover(issuer: &str) -> Result<Endpoints, String> {
    let Some(base) = https(issuer) else {
        return Err("The issuer must be an https address.".to_owned());
    };
    let url = format!("{}/.well-known/openid-configuration", base.as_str().trim_end_matches('/'));
    let (status, document) = send(Method::Get, &url, Headers::new(), None).await.map_err(|_| UNREACHABLE.to_owned())?;
    if status != 200 {
        return Err(format!("The provider's discovery document ({url}) answered {status}. Check the issuer."));
    }
    endpoints_from(&document, issuer)
}

/// Reads the issuer's signing keys.
pub async fn keys(url: &str) -> Result<Value, String> {
    let (status, keys) = send(Method::Get, url, Headers::new(), None).await.map_err(|_| UNREACHABLE.to_owned())?;
    if status != 200 || !keys["keys"].is_array() {
        return Err(format!("The provider's signing keys ({url}) answered {status}."));
    }
    Ok(keys)
}

/// The scopes to ask for: as set, always with `openid` for OpenID Connect.
pub fn scopes(set: Option<&str>, openid: bool) -> String {
    let set = set.map(str::trim).filter(|s| !s.is_empty());
    let mut scopes: Vec<&str> = set.unwrap_or(if openid { "openid email profile" } else { "" }).split_whitespace().collect();
    if openid && !scopes.contains(&"openid") {
        scopes.insert(0, "openid");
    }
    scopes.join(" ")
}

pub struct Authorize<'a> {
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub scopes: &'a str,
    pub state: &'a str,
    pub nonce: Option<&'a str>,
    pub challenge: &'a str,
}

pub fn authorize_url(endpoint: &str, a: &Authorize) -> Option<String> {
    let mut url = https(endpoint)?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", a.client_id)
            .append_pair("redirect_uri", a.redirect_uri)
            .append_pair("state", a.state)
            .append_pair("code_challenge", a.challenge)
            .append_pair("code_challenge_method", "S256");
        if !a.scopes.is_empty() {
            query.append_pair("scope", a.scopes);
        }
        if let Some(nonce) = a.nonce {
            query.append_pair("nonce", nonce);
        }
    }
    Some(url.to_string())
}

async fn send(method: Method, url: &str, headers: Headers, body: Option<String>) -> worker::Result<(u16, Value)> {
    headers.set("user-agent", "g1t (+https://g1t.sh)")?;
    headers.set("accept", "application/json")?;
    let mut init = RequestInit::new();
    if let Some(body) = body {
        headers.set("content-type", "application/x-www-form-urlencoded")?;
        init.with_body(Some(body.into()));
    }
    init.with_method(method).with_headers(headers);
    let mut response = Fetch::Request(Request::new_with_init(url, &init)?).send().await?;
    let text = response.text().await.unwrap_or_default();
    Ok((response.status_code(), serde_json::from_str(&text).unwrap_or(Value::Null)))
}

pub struct Exchange<'a> {
    pub token_url: &'a str,
    pub basic: bool,
    pub client_id: &'a str,
    pub client_secret: &'a str,
    pub code: &'a str,
    pub redirect_uri: &'a str,
    pub verifier: &'a str,
}

/// Trades the code for tokens.
pub async fn exchange(a: &Exchange<'_>) -> Result<Value, String> {
    let mut form = url_form(&[
        ("grant_type", "authorization_code"),
        ("code", a.code),
        ("redirect_uri", a.redirect_uri),
        ("code_verifier", a.verifier),
    ]);
    let headers = Headers::new();
    if a.basic {
        // RFC 6749 2.3.1: each form-encoded, then joined.
        let user = url_form(&[("", a.client_id)]);
        let pass = url_form(&[("", a.client_secret)]);
        let credentials = format!("{}:{}", &user[1..], &pass[1..]);
        headers.set("authorization", &format!("Basic {}", STANDARD.encode(credentials))).map_err(|_| UNREACHABLE.to_owned())?;
    } else {
        form.push('&');
        form.push_str(&url_form(&[("client_id", a.client_id), ("client_secret", a.client_secret)]));
    }
    let (status, answer) = send(Method::Post, a.token_url, headers, Some(form)).await.map_err(|_| UNREACHABLE.to_owned())?;
    if status != 200 || answer.get("error").is_some() {
        let error = answer["error"].as_str().unwrap_or("no answer");
        worker::console_log!("sso token request refused: {status} {error}");
        return Err(match error {
            "invalid_client" | "unauthorized_client" => {
                "The identity provider did not accept g1t's client id and secret. Check them in the single sign-on settings.".to_owned()
            }
            "invalid_grant" => "The identity provider did not accept the sign-in: it may have taken too long, or the callback URL does not match. Start again.".to_owned(),
            _ => format!("The identity provider did not complete the sign-in ({error})."),
        });
    }
    Ok(answer)
}

fn url_form(pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse("https://form.invalid/").expect("a fixed URL parses");
    url.query_pairs_mut().extend_pairs(pairs);
    url.query().unwrap_or_default().to_owned()
}

/// Reads the userinfo endpoint with the access token.
pub async fn userinfo(url: &str, access_token: &str) -> Result<Value, String> {
    let headers = Headers::new();
    headers.set("authorization", &format!("Bearer {access_token}")).map_err(|_| UNREACHABLE.to_owned())?;
    let (status, answer) = send(Method::Get, url, headers, None).await.map_err(|_| UNREACHABLE.to_owned())?;
    if status != 200 || !answer.is_object() {
        return Err(format!("The identity provider's userinfo endpoint answered {status}."));
    }
    Ok(answer)
}

/// The claims of an ID token: its signature verified with the issuer's
/// keys (jwt.rs), then what it says checked against this sign-in.
pub fn id_token_claims(
    id_token: &str,
    keys: &Value,
    issuer: &str,
    client_id: &str,
    nonce: &str,
    now_seconds: u64,
) -> Result<Value, String> {
    let claims = super::jwt::verify(id_token, keys)?;
    check_claims(claims, issuer, client_id, nonce, now_seconds)
}

/// Whether a verified ID token's claims say it is for this sign-in.
pub fn check_claims(claims: Value, issuer: &str, client_id: &str, nonce: &str, now_seconds: u64) -> Result<Value, String> {
    // Google issues ID tokens as either form of its issuer (its OpenID
    // Connect docs say so); no other issuer is taken without its scheme.
    let google = issuer == "https://accounts.google.com" && claims["iss"].as_str() == Some("accounts.google.com");
    if claims["iss"].as_str() != Some(issuer) && !google {
        return Err(format!("The ID token was issued by {:?}, not {issuer:?}.", claims["iss"].as_str().unwrap_or_default()));
    }
    let audiences: Vec<&str> = match &claims["aud"] {
        Value::String(one) => vec![one.as_str()],
        Value::Array(many) => many.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    };
    if !audiences.contains(&client_id) || (audiences.len() > 1 && claims["azp"].as_str().is_some_and(|azp| azp != client_id)) {
        return Err("The ID token is not for g1t's client id.".to_owned());
    }
    if claims["exp"].as_u64().is_none_or(|exp| exp + SKEW_SECONDS <= now_seconds) {
        return Err("The ID token has expired. Start again.".to_owned());
    }
    if claims["iat"].as_u64().is_some_and(|iat| iat > now_seconds + SKEW_SECONDS) {
        return Err("The ID token was issued in the future: check the identity provider's clock.".to_owned());
    }
    if claims["nonce"].as_str() != Some(nonce) {
        return Err("The ID token answers another sign-in. Start again.".to_owned());
    }
    Ok(claims)
}

/// A claim by name, or by a dotted path (`data.id`), as text: ids are
/// sometimes numbers.
pub fn claim(value: &Value, path: &str) -> Option<String> {
    let mut at = value;
    for part in path.split('.') {
        at = at.get(part)?;
    }
    match at {
        Value::String(text) => Some(text.trim().to_owned()).filter(|t| !t.is_empty()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn discovery_must_name_the_issuer_and_https_endpoints() {
        let document = json!({
            "issuer": "https://acme.okta.com",
            "authorization_endpoint": "https://acme.okta.com/oauth2/v1/authorize",
            "token_endpoint": "https://acme.okta.com/oauth2/v1/token",
            "userinfo_endpoint": "https://acme.okta.com/oauth2/v1/userinfo",
            "jwks_uri": "https://acme.okta.com/oauth2/v1/keys",
            "token_endpoint_auth_methods_supported": ["client_secret_post"],
        });
        let found = endpoints_from(&document, "https://acme.okta.com/").unwrap();
        assert_eq!(found.issuer.as_deref(), Some("https://acme.okta.com"));
        assert!(!found.basic);
        assert!(endpoints_from(&document, "https://globex.okta.com").unwrap_err().contains("names the issuer"));
        let plain =
            json!({ "issuer": "https://a.test", "authorization_endpoint": "http://a.test/auth", "token_endpoint": "https://a.test/token" });
        assert!(endpoints_from(&plain, "https://a.test").is_err());
        let defaults = json!({ "issuer": "https://a.test", "authorization_endpoint": "https://a.test/auth", "token_endpoint": "https://a.test/token", "jwks_uri": "https://a.test/keys" });
        assert!(endpoints_from(&defaults, "https://a.test").unwrap().basic);
        let keyless = json!({ "issuer": "https://a.test", "authorization_endpoint": "https://a.test/auth", "token_endpoint": "https://a.test/token" });
        assert!(endpoints_from(&keyless, "https://a.test").unwrap_err().contains("jwks_uri"));
    }

    #[test]
    fn openid_is_always_asked_for() {
        assert_eq!(scopes(None, true), "openid email profile");
        assert_eq!(scopes(Some("email groups"), true), "openid email groups");
        assert_eq!(scopes(Some(" "), false), "");
        assert_eq!(scopes(Some("read:user user:email"), false), "read:user user:email");
    }

    #[test]
    fn the_authorize_url_carries_pkce_and_the_nonce() {
        let url = authorize_url(
            "https://idp.test/authorize?tenant=1",
            &Authorize {
                client_id: "c",
                redirect_uri: "https://g1t.sh/auth/sso/acme/callback",
                scopes: "openid",
                state: "s",
                nonce: Some("n"),
                challenge: "x",
            },
        )
        .unwrap();
        let pairs: std::collections::HashMap<String, String> = Url::parse(&url).unwrap().query_pairs().into_owned().collect();
        assert_eq!(pairs["tenant"], "1");
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert_eq!(pairs["nonce"], "n");
        assert_eq!(pairs["redirect_uri"], "https://g1t.sh/auth/sso/acme/callback");
        assert!(
            authorize_url(
                "http://idp.test/authorize",
                &Authorize { client_id: "c", redirect_uri: "r", scopes: "", state: "s", nonce: None, challenge: "x" }
            )
            .is_none()
        );
    }

    #[test]
    fn an_id_token_must_be_for_this_sign_in() {
        let now = 1_800_000_000;
        let good =
            json!({ "iss": "https://idp.test", "aud": "client", "exp": now + 60, "nonce": "n", "sub": "u1", "email": "ada@acme.test" });
        let claims = check_claims(good.clone(), "https://idp.test", "client", "n", now).unwrap();
        assert_eq!(claim(&claims, "sub").as_deref(), Some("u1"));
        let with = |field: &str, value: Value| {
            let mut claims = good.clone();
            claims[field] = value;
            check_claims(claims, "https://idp.test", "client", "n", now)
        };
        assert!(with("iss", json!("https://evil.test")).unwrap_err().contains("issued by"));
        assert!(with("aud", json!("other")).unwrap_err().contains("client id"));
        assert!(with("aud", json!(["other", "client"])).is_ok());
        assert!(with("exp", json!(now - 600)).unwrap_err().contains("expired"));
        assert!(with("nonce", json!("m")).unwrap_err().contains("another sign-in"));
        assert!(with("iat", json!(now + 3600)).unwrap_err().contains("future"));
        let google = json!({ "iss": "accounts.google.com", "aud": "client", "exp": now + 60, "nonce": "n", "sub": "1" });
        assert!(check_claims(google.clone(), "https://accounts.google.com", "client", "n", now).is_ok());
        assert!(check_claims(google, "https://idp.test", "client", "n", now).is_err());
        assert!(id_token_claims("not.a-token", &json!({ "keys": [] }), "https://idp.test", "client", "n", now).is_err());
    }

    #[test]
    fn a_signed_id_token_is_verified_then_checked() {
        let fixtures: Value = serde_json::from_str(include_str!("jwt_fixtures.json")).unwrap();
        let token = fixtures["tokens"]["rs256"].as_str().unwrap();
        let claims = id_token_claims(token, &fixtures["jwks"], "https://idp.example.test", "client", "n", 1_800_000_100).unwrap();
        assert_eq!(claim(&claims, "email").as_deref(), Some("ada@acme.test"));
        // Signed, but for another sign-in.
        assert!(id_token_claims(token, &fixtures["jwks"], "https://idp.example.test", "client", "other", 1_800_000_100).is_err());
        // Not signed with the issuer's keys.
        assert!(
            id_token_claims(
                token,
                &json!({ "keys": [fixtures["jwks"]["keys"][1].clone()] }),
                "https://idp.example.test",
                "client",
                "n",
                1_800_000_100
            )
            .is_err()
        );
    }

    #[test]
    fn claims_are_found_by_path_and_read_as_text() {
        let info = json!({ "id": 42, "data": { "login": "ada" }, "blank": "" });
        assert_eq!(claim(&info, "id").as_deref(), Some("42"));
        assert_eq!(claim(&info, "data.login").as_deref(), Some("ada"));
        assert_eq!(claim(&info, "blank"), None);
        assert_eq!(claim(&info, "missing"), None);
    }

    #[test]
    fn form_values_are_encoded() {
        assert_eq!(url_form(&[("a", "b c"), ("d", "&=")]), "a=b+c&d=%26%3D");
    }
}
