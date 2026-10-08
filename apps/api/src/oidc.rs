//! OIDC tokens for workflow jobs: g1t as an OpenID Connect issuer, so a
//! job with `permissions: id-token: write` can trade a short-lived token
//! for a cloud provider's credentials instead of keeping a long-lived key
//! in a secret.
//!
//! - The issuer is `{API}/actions/oidc` (`https://api.g1t.sh/actions/oidc`
//!   hosted): its discovery document at
//!   `/.well-known/openid-configuration` under it, and its keys at
//!   `/.well-known/jwks`. No host of its own: the API's.
//! - A job asks `GET {issuer}/token?api-version=2.0&audience=…` with its
//!   runtime token (`ACTIONS_ID_TOKEN_REQUEST_URL` and `…_TOKEN`, as the
//!   toolkit's `core.getIDToken` reads them) and gets `{ "value": jwt }`.
//! - Tokens are RS256, good for five minutes, with GitHub's claims (the
//!   actions service decides them and whether the job may have one).
//! - The signing key is the Worker secret `ACTIONS_OIDC_KEY`, an RSA
//!   private key in PEM (PKCS#8 or PKCS#1). `ACTIONS_OIDC_KEY_PREVIOUS`,
//!   while it is set, is published too, so tokens it signed still verify
//!   while the new key takes over. Each key's `kid` is its RFC 7638
//!   thumbprint. docs/DEPLOYING.md says how to make and rotate them.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use g1t_contracts::actions::RuntimeAuthArgs;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::js;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use worker::js_sys::{self, Uint8Array};
use worker::{Env, Error, Request, Response, Result};

use crate::operations::Services;

/// How long a token is good for.
const LIFETIME_SECONDS: u64 = 5 * 60;
pub const KEY_SECRET: &str = "ACTIONS_OIDC_KEY";
pub const PREVIOUS_KEY_SECRET: &str = "ACTIONS_OIDC_KEY_PREVIOUS";

/// The issuer, under the API's address.
pub fn issuer(api: &str) -> String {
    format!("{api}/actions/oidc")
}

/// The OpenID Provider configuration, as relying parties fetch it.
pub fn discovery(api: &str) -> Value {
    let issuer = issuer(api);
    json!({
        "issuer": issuer,
        "jwks_uri": format!("{issuer}/.well-known/jwks"),
        "subject_types_supported": ["public", "pairwise"],
        "response_types_supported": ["id_token"],
        "claims_supported": [
            "sub", "aud", "exp", "iat", "iss", "jti", "nbf", "ref", "sha", "repository", "repository_id", "repository_owner",
            "repository_owner_id", "repository_visibility", "run_id", "run_number", "run_attempt", "actor", "actor_id", "workflow",
            "workflow_ref", "workflow_sha", "job_workflow_ref", "job_workflow_sha", "head_ref", "base_ref", "event_name", "ref_type",
            "ref_protected", "environment", "runner_environment"
        ],
        "id_token_signing_alg_values_supported": ["RS256"],
        "scopes_supported": ["openid"],
    })
}

// ── Keys ────────────────────────────────────────────────────────────────────

/// A DER element: its tag, and its contents; and what follows it.
fn der(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (length, rest) = if first < 0x80 {
        (first as usize, rest)
    } else {
        let count = (first & 0x7f) as usize;
        if count == 0 || count > 4 || rest.len() < count {
            return None;
        }
        let length = rest[..count].iter().fold(0usize, |n, b| (n << 8) | *b as usize);
        (length, &rest[count..])
    };
    if rest.len() < length {
        return None;
    }
    Some((tag, &rest[..length], &rest[length..]))
}

/// An INTEGER's magnitude, without the sign byte DER may put in front.
fn unsigned(bytes: &[u8]) -> &[u8] {
    let mut bytes = bytes;
    while bytes.len() > 1 && bytes[0] == 0 {
        bytes = &bytes[1..];
    }
    bytes
}

/// The modulus and public exponent of an RSA private key: PKCS#1
/// `RSAPrivateKey`, or PKCS#8 `PrivateKeyInfo` holding one.
pub fn public_numbers(key: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let (0x30, body, _) = der(key)? else { return None };
    let (0x02, _version, rest) = der(body)? else { return None };
    let rsa = match der(rest)? {
        // PKCS#8: the algorithm, then the key in an OCTET STRING.
        (0x30, _algorithm, after) => {
            let (0x04, inner, _) = der(after)? else { return None };
            let (0x30, rsa, _) = der(inner)? else { return None };
            let (0x02, _version, rsa) = der(rsa)? else { return None };
            rsa
        }
        // PKCS#1: the modulus is next.
        (0x02, _, _) => rest,
        _ => return None,
    };
    let (0x02, n, rsa) = der(rsa)? else { return None };
    let (0x02, e, _) = der(rsa)? else { return None };
    Some((unsigned(n).to_vec(), unsigned(e).to_vec()))
}

/// A DER length.
fn der_length(length: usize) -> Vec<u8> {
    if length < 0x80 {
        return vec![length as u8];
    }
    let bytes: Vec<u8> = length.to_be_bytes().into_iter().skip_while(|byte| *byte == 0).collect();
    let mut out = vec![0x80 | bytes.len() as u8];
    out.extend(bytes);
    out
}

/// Wraps a PKCS#1 key in PKCS#8, which is all WebCrypto imports.
fn pkcs1_to_pkcs8(pkcs1: &[u8]) -> Vec<u8> {
    const RSA_ALGORITHM: [u8; 15] = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
    let mut octets = vec![0x04];
    octets.extend(der_length(pkcs1.len()));
    octets.extend_from_slice(pkcs1);
    let mut body = vec![0x02, 0x01, 0x00];
    body.extend_from_slice(&RSA_ALGORITHM);
    body.extend(octets);
    let mut out = vec![0x30];
    out.extend(der_length(body.len()));
    out.extend(body);
    out
}

/// A signing key: its PKCS#8 DER, and its public half as a JWK.
pub struct SigningKey {
    pub pkcs8: Vec<u8>,
    pub jwk: Value,
}

impl SigningKey {
    /// From PEM, either form; line breaks pasted as `\n` are read too.
    pub fn from_pem(pem: &str) -> std::result::Result<SigningKey, String> {
        let pem = pem.replace("\\n", "\n");
        let pkcs1 = pem.contains("BEGIN RSA PRIVATE KEY");
        if !pkcs1 && !pem.contains("BEGIN PRIVATE KEY") {
            return Err(format!("{KEY_SECRET} is not a PEM RSA private key."));
        }
        let body: String = pem.lines().filter(|l| !l.starts_with("-----")).flat_map(str::chars).filter(|c| !c.is_whitespace()).collect();
        let der = STANDARD.decode(body).map_err(|_| format!("{KEY_SECRET} is not valid base64."))?;
        let (n, e) = public_numbers(&der).ok_or_else(|| format!("{KEY_SECRET} is not an RSA key."))?;
        let pkcs8 = if pkcs1 { pkcs1_to_pkcs8(&der) } else { der };
        Ok(SigningKey { pkcs8, jwk: jwk(&n, &e) })
    }

    pub fn kid(&self) -> String {
        self.jwk["kid"].as_str().unwrap_or_default().to_owned()
    }
}

/// The public JWK of a key, its `kid` the RFC 7638 thumbprint.
pub fn jwk(n: &[u8], e: &[u8]) -> Value {
    let (n, e) = (URL_SAFE_NO_PAD.encode(n), URL_SAFE_NO_PAD.encode(e));
    // RFC 7638: the required members, in lexicographic order, no spaces.
    let canonical = format!(r#"{{"e":"{e}","kty":"RSA","n":"{n}"}}"#);
    let kid = URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes()));
    json!({ "kty": "RSA", "alg": "RS256", "use": "sig", "kid": kid, "n": n, "e": e })
}

/// The keys configured: the current one first.
pub fn keys(env: &Env) -> (Option<std::result::Result<SigningKey, String>>, Option<SigningKey>) {
    let read = |name: &str| env.secret(name).ok().map(|s| s.to_string()).filter(|s| !s.trim().is_empty());
    let current = read(KEY_SECRET).map(|pem| SigningKey::from_pem(&pem));
    let previous = read(PREVIOUS_KEY_SECRET).and_then(|pem| SigningKey::from_pem(&pem).ok());
    (current, previous)
}

/// Whether this installation can issue OIDC tokens.
pub fn configured(env: &Env) -> bool {
    matches!(keys(env).0, Some(Ok(_)))
}

pub fn jwks(current: Option<&SigningKey>, previous: Option<&SigningKey>) -> Value {
    json!({ "keys": current.into_iter().chain(previous).map(|k| k.jwk.clone()).collect::<Vec<_>>() })
}

// ── Tokens ──────────────────────────────────────────────────────────────────

/// The token's claims: what the actions service said about the job, and
/// who issued it, for whom and when.
pub fn full_claims(mut claims: Value, issuer: &str, audience: &str, jti: &str, now: u64) -> Value {
    claims["iss"] = json!(issuer);
    claims["aud"] = json!(audience);
    claims["jti"] = json!(jti);
    claims["iat"] = json!(now);
    claims["nbf"] = json!(now.saturating_sub(60));
    claims["exp"] = json!(now + LIFETIME_SECONDS);
    claims
}

/// The header and claims, base64url-encoded and joined: what is signed.
pub fn signing_input(kid: &str, claims: &Value) -> String {
    let header = json!({ "typ": "JWT", "alg": "RS256", "kid": kid, "x5t": kid });
    format!("{}.{}", URL_SAFE_NO_PAD.encode(header.to_string()), URL_SAFE_NO_PAD.encode(claims.to_string()))
}

/// RSASSA-PKCS1-v1_5 with SHA-256, by WebCrypto.
async fn sign_rs256(pkcs8: &[u8], data: &[u8]) -> Result<Vec<u8>> {
    let subtle = js::get(&js::get(&js_sys::global(), "crypto"), "subtle");
    let algorithm = js::to_js(&json!({ "name": "RSASSA-PKCS1-v1_5", "hash": "SHA-256" }))?;
    let usages = js::to_js(&json!(["sign"]))?;
    let key = js::call(&subtle, "importKey", &["pkcs8".into(), Uint8Array::from(pkcs8).into(), algorithm.clone(), false.into(), usages])
        .await
        .map_err(|thrown| Error::RustError(format!("{KEY_SECRET} could not be used: {thrown}")))?;
    let signature = js::call(&subtle, "sign", &[algorithm, key, Uint8Array::from(data).into()]).await?;
    Ok(Uint8Array::new(&signature).to_vec())
}

fn error(status: u16, message: &str) -> Result<Response> {
    Ok(crate::reply(&json!({ "error": { "message": message } }))?.with_status(status))
}

/// `/actions/oidc/…`: discovery, keys, and a job's token.
pub async fn handle(request: &Request, env: &Env, services: &Services, path: &str) -> Result<Response> {
    let api = services.addresses.api.clone();
    let (current, previous) = keys(env);
    let current = match current {
        Some(Ok(key)) => key,
        Some(Err(problem)) => {
            worker::console_error!("oidc: {problem}");
            return error(503, "OIDC tokens are not set up on this installation.");
        }
        None => return error(404, "OIDC tokens are not set up on this installation."),
    };
    let cached = |value: &Value| -> Result<Response> {
        let mut response = Response::from_json(value)?;
        response.headers_mut().set("cache-control", "public, max-age=300")?;
        Ok(response)
    };
    match path {
        "/actions/oidc/.well-known/openid-configuration" => cached(&discovery(&api)),
        "/actions/oidc/.well-known/jwks" => cached(&jwks(Some(&current), previous.as_ref())),
        "/actions/oidc/token" => {
            let token = crate::toolkit::bearer(request);
            let Some(job) = crate::toolkit::runtime_job(&token) else {
                return error(401, "Send the job's ACTIONS_ID_TOKEN_REQUEST_TOKEN as a bearer token.");
            };
            let claims: Outcome<Value> = g1t_kit::call(&services.actions, "oidc_claims", &RuntimeAuthArgs { job, token }).await?;
            let claims = match claims {
                Outcome::Ok(claims) => claims,
                Outcome::Fail(refused) => {
                    let status = match refused.code {
                        FailureCode::Unauthenticated => 401,
                        FailureCode::Forbidden => 403,
                        _ => 404,
                    };
                    return error(status, &refused.message);
                }
            };
            let url = request.url()?;
            let owner = claims["repository_owner"].as_str().unwrap_or_default().to_owned();
            let audience = url
                .query_pairs()
                .find(|(k, _)| k == "audience")
                .map(|(_, v)| v.into_owned())
                .filter(|a| !a.trim().is_empty())
                // GitHub's default: the owner's address.
                .unwrap_or_else(|| format!("{}/{owner}", services.addresses.site));
            let now = g1t_kit::now_ms() / 1000;
            let jti = g1t_contracts::new_id("oidc", g1t_kit::now_ms());
            let claims = full_claims(claims, &issuer(&api), &audience, &jti, now);
            let input = signing_input(&current.kid(), &claims);
            let signature = sign_rs256(&current.pkcs8, input.as_bytes()).await?;
            let value = format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature));
            Response::from_json(&json!({ "count": value.len(), "value": value }))
        }
        _ => error(404, "No such endpoint."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn discovery_names_the_issuer_and_its_keys() {
        let doc = discovery("https://api.g1t.sh");
        assert_eq!(doc["issuer"], "https://api.g1t.sh/actions/oidc");
        assert_eq!(doc["jwks_uri"], "https://api.g1t.sh/actions/oidc/.well-known/jwks");
        assert_eq!(doc["id_token_signing_alg_values_supported"], json!(["RS256"]));
        assert!(doc["claims_supported"].as_array().unwrap().contains(&json!("job_workflow_ref")));
    }

    #[test]
    fn a_thumbprint_is_rfc_7638s() {
        // RFC 7638, section 3.1: the example key and its thumbprint.
        let n = URL_SAFE_NO_PAD
            .decode("0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw")
            .unwrap();
        let key = jwk(&n, &[1, 0, 1]);
        assert_eq!(key["e"], "AQAB");
        assert_eq!(key["kid"], "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
    }

    #[test]
    fn claims_get_who_issued_them_and_a_short_life() {
        let claims = full_claims(json!({ "sub": "repo:acme/web:ref:refs/heads/main" }), "https://api.g1t.sh/actions/oidc", "sts.amazonaws.com", "oidc_1", 1_700_000_000);
        assert_eq!(claims["iss"], "https://api.g1t.sh/actions/oidc");
        assert_eq!(claims["aud"], "sts.amazonaws.com");
        assert_eq!(claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap(), LIFETIME_SECONDS);
        assert!(claims["nbf"].as_u64().unwrap() <= claims["iat"].as_u64().unwrap());
        let input = signing_input("kid1", &claims);
        let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(input.split('.').next().unwrap()).unwrap()).unwrap();
        assert_eq!((header["alg"].as_str(), header["kid"].as_str()), (Some("RS256"), Some("kid1")));
    }

    #[test]
    fn a_key_that_is_not_one_is_refused() {
        assert!(SigningKey::from_pem("hello").is_err());
        let pem = format!("{}\nAAAA\n{}", concat!("-----BEGIN ", "PRIVATE KEY-----"), concat!("-----END ", "PRIVATE KEY-----"));
        assert!(SigningKey::from_pem(&pem).is_err());
    }

    fn openssl(args: &[&str]) -> Option<std::process::Output> {
        Command::new("openssl").args(args).output().ok().filter(|o| o.status.success())
    }

    /// With openssl on the machine: a key made here, read in both PEM
    /// forms, gives the modulus openssl gives, and a token signed with it
    /// (by openssl, as WebCrypto is not here) verifies against the public
    /// key built from the JWKS.
    #[test]
    fn a_real_key_signs_tokens_its_jwks_verifies() {
        let dir = std::env::temp_dir().join(format!("g1t-oidc-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = |name: &str| dir.join(name).display().to_string();
        if openssl(&["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", &path("key.pem")]).is_none() {
            eprintln!("openssl is not here; skipped");
            return;
        }
        let pem = std::fs::read_to_string(path("key.pem")).unwrap();
        let key = SigningKey::from_pem(&pem).unwrap();
        // The modulus is openssl's.
        let modulus = openssl(&["rsa", "-in", &path("key.pem"), "-noout", "-modulus"]).unwrap();
        let modulus = String::from_utf8_lossy(&modulus.stdout).trim().trim_start_matches("Modulus=").to_lowercase();
        let n = URL_SAFE_NO_PAD.decode(key.jwk["n"].as_str().unwrap()).unwrap();
        assert_eq!(n.iter().map(|b| format!("{b:02x}")).collect::<String>(), modulus);
        assert_eq!(key.jwk["e"], "AQAB");
        // The traditional form reads to the same key.
        if openssl(&["rsa", "-in", &path("key.pem"), "-traditional", "-out", &path("key1.pem")]).is_some() {
            let pkcs1 = std::fs::read_to_string(path("key1.pem")).unwrap();
            if pkcs1.contains("BEGIN RSA PRIVATE KEY") {
                let again = SigningKey::from_pem(&pkcs1).unwrap();
                assert_eq!(again.kid(), key.kid());
                assert_eq!(again.pkcs8, key.pkcs8, "PKCS#1 is wrapped as openssl writes PKCS#8");
            }
        }
        // Sign the token's input with openssl, verify with the JWKS's key.
        let claims = full_claims(json!({ "sub": "repo:acme/web:environment:prod" }), "https://api.g1t.sh/actions/oidc", "sts.amazonaws.com", "j", 1_700_000_000);
        let input = signing_input(&key.kid(), &claims);
        std::fs::write(path("input"), &input).unwrap();
        openssl(&["dgst", "-sha256", "-sign", &path("key.pem"), "-out", &path("sig"), &path("input")]).unwrap();
        // The public key from n and e alone: RSAPublicKey DER.
        let integer = |bytes: &[u8]| {
            let mut value = bytes.to_vec();
            if value[0] & 0x80 != 0 {
                value.insert(0, 0);
            }
            let mut out = vec![0x02];
            out.extend(der_length(value.len()));
            out.extend(value);
            out
        };
        let mut body = integer(&n);
        body.extend(integer(&URL_SAFE_NO_PAD.decode(key.jwk["e"].as_str().unwrap()).unwrap()));
        let mut public = vec![0x30];
        public.extend(der_length(body.len()));
        public.extend(body);
        std::fs::write(path("public.der"), &public).unwrap();
        let checked = openssl(&["rsa", "-RSAPublicKey_in", "-inform", "DER", "-in", &path("public.der"), "-pubout", "-out", &path("public.pem")]);
        assert!(checked.is_some(), "openssl reads the public key built from the JWKS");
        let verified = openssl(&["dgst", "-sha256", "-verify", &path("public.pem"), "-signature", &path("sig"), &path("input")]);
        assert!(verified.is_some(), "the JWKS key verifies the token's signature");
        // And not a token whose claims were changed.
        std::fs::write(path("input"), format!("{input}A")).unwrap();
        let forged = openssl(&["dgst", "-sha256", "-verify", &path("public.pem"), "-signature", &path("sig"), &path("input")]);
        assert!(forged.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
