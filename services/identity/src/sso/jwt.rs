//! Verifying an OpenID Connect ID token's signature with the issuer's
//! published keys (its JWKS, from `jwks_uri`): RSA (RS256/384/512 and
//! PS256/384/512) and P-256 (ES256). Anything else, `none` and the HMAC
//! algorithms above all, is refused: g1t never holds a key that would make
//! a shared secret mean anything here.
//!
//! The key is the one the token's header names by `kid`, or the only
//! signing key of the right type when it names none. A key marked for
//! encryption, or for another algorithm, is never used.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rsa::pss::Pss;
use rsa::{BigUint, Pkcs1v15Sign, RsaPublicKey};
use serde_json::Value;
use sha2::{Digest, Sha256, Sha384, Sha512};

const UNREADABLE: &str = "The identity provider's ID token could not be read.";
const BAD_SIGNATURE: &str = "The ID token's signature did not verify with the identity provider's published keys.";

fn decode(part: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).map_err(|_| UNREADABLE.to_owned())
}

/// The algorithms g1t accepts, and what each needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Alg {
    Rs(Bits),
    Ps(Bits),
    Es256,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Bits {
    B256,
    B384,
    B512,
}

impl Bits {
    fn digest(self, data: &[u8]) -> Vec<u8> {
        match self {
            Bits::B256 => Sha256::digest(data).to_vec(),
            Bits::B384 => Sha384::digest(data).to_vec(),
            Bits::B512 => Sha512::digest(data).to_vec(),
        }
    }
}

impl Alg {
    fn parse(name: &str) -> Result<Alg, String> {
        Ok(match name {
            "RS256" => Alg::Rs(Bits::B256),
            "RS384" => Alg::Rs(Bits::B384),
            "RS512" => Alg::Rs(Bits::B512),
            "PS256" => Alg::Ps(Bits::B256),
            "PS384" => Alg::Ps(Bits::B384),
            "PS512" => Alg::Ps(Bits::B512),
            "ES256" => Alg::Es256,
            other => {
                return Err(format!(
                    "The identity provider signs ID tokens with {other:?}, which g1t does not accept. Use RS256 (or PS256 or ES256)."
                ));
            }
        })
    }

    fn kty(self) -> &'static str {
        match self {
            Alg::Rs(_) | Alg::Ps(_) => "RSA",
            Alg::Es256 => "EC",
        }
    }
}

/// The key `kid` names, or the only one that fits.
fn key_for<'a>(jwks: &'a Value, kid: Option<&str>, alg: Alg, name: &str) -> Result<&'a Value, String> {
    let usable: Vec<&Value> = jwks["keys"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|key| key["kty"].as_str() == Some(alg.kty()))
        .filter(|key| key["use"].as_str().is_none_or(|u| u == "sig"))
        .filter(|key| key["alg"].as_str().is_none_or(|a| a == name))
        .collect();
    let found = match kid {
        Some(kid) => usable.into_iter().find(|key| key["kid"].as_str() == Some(kid)),
        None if usable.len() == 1 => usable.into_iter().next(),
        None => None,
    };
    found.ok_or_else(|| "The identity provider's published keys have none for this ID token. If it just rotated its keys, try again.".to_owned())
}

/// Verifies `token`'s signature with a key of `jwks` and returns its claims.
/// Only the signature: what the claims must say is checked after.
pub fn verify(token: &str, jwks: &Value) -> Result<Value, String> {
    let mut parts = token.trim().split('.');
    let (Some(header), Some(payload), Some(signature), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err(UNREADABLE.to_owned());
    };
    let head: Value = serde_json::from_slice(&decode(header)?).map_err(|_| UNREADABLE.to_owned())?;
    let name = head["alg"].as_str().unwrap_or("none");
    let alg = Alg::parse(name)?;
    if head.get("crit").is_some() || head.get("jku").is_some() || head.get("x5u").is_some() || head.get("jwk").is_some() {
        // Keys named in the token itself are never trusted.
        return Err("The ID token names its own key, which g1t does not accept.".to_owned());
    }
    let key = key_for(jwks, head["kid"].as_str(), alg, name)?;
    let signed = format!("{header}.{payload}");
    let signature = decode(signature)?;
    let verified = match alg {
        Alg::Rs(bits) | Alg::Ps(bits) => {
            let (Some(n), Some(e)) = (key["n"].as_str(), key["e"].as_str()) else {
                return Err(BAD_SIGNATURE.to_owned());
            };
            let public = RsaPublicKey::new(BigUint::from_bytes_be(&decode(n)?), BigUint::from_bytes_be(&decode(e)?)).map_err(|_| BAD_SIGNATURE.to_owned())?;
            let hashed = bits.digest(signed.as_bytes());
            match (alg, bits) {
                (Alg::Rs(_), Bits::B256) => public.verify(Pkcs1v15Sign::new::<Sha256>(), &hashed, &signature),
                (Alg::Rs(_), Bits::B384) => public.verify(Pkcs1v15Sign::new::<Sha384>(), &hashed, &signature),
                (Alg::Rs(_), Bits::B512) => public.verify(Pkcs1v15Sign::new::<Sha512>(), &hashed, &signature),
                (_, Bits::B256) => public.verify(Pss::new::<Sha256>(), &hashed, &signature),
                (_, Bits::B384) => public.verify(Pss::new::<Sha384>(), &hashed, &signature),
                (_, Bits::B512) => public.verify(Pss::new::<Sha512>(), &hashed, &signature),
            }
            .is_ok()
        }
        Alg::Es256 => {
            use p256::ecdsa::signature::Verifier;
            use p256::ecdsa::{Signature, VerifyingKey};
            if key["crv"].as_str() != Some("P-256") {
                return Err(BAD_SIGNATURE.to_owned());
            }
            let (Some(x), Some(y)) = (key["x"].as_str(), key["y"].as_str()) else {
                return Err(BAD_SIGNATURE.to_owned());
            };
            let mut point = vec![0x04];
            point.extend(decode(x)?);
            point.extend(decode(y)?);
            match (VerifyingKey::from_sec1_bytes(&point), Signature::from_slice(&signature)) {
                (Ok(public), Ok(signature)) => public.verify(signed.as_bytes(), &signature).is_ok(),
                _ => false,
            }
        }
    };
    if !verified {
        return Err(BAD_SIGNATURE.to_owned());
    }
    serde_json::from_slice(&decode(payload)?).map_err(|_| UNREADABLE.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("jwt_fixtures.json")).unwrap()
    }

    fn token(name: &str) -> String {
        fixtures()["tokens"][name].as_str().unwrap().to_owned()
    }

    #[test]
    fn tokens_signed_by_the_issuer_verify() {
        let jwks = fixtures()["jwks"].clone();
        for name in ["rs256", "ps256", "es256", "rs256_other_key"] {
            let claims = verify(&token(name), &jwks).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(claims["sub"], "u1", "{name}");
        }
    }

    #[test]
    fn a_changed_token_does_not() {
        let jwks = fixtures()["jwks"].clone();
        for name in ["rs256", "ps256", "es256"] {
            let token = token(name);
            let mut parts: Vec<String> = token.split('.').map(str::to_owned).collect();
            let mut claims: Value = serde_json::from_slice(&decode(&parts[1]).unwrap()).unwrap();
            claims["sub"] = json!("eve");
            parts[1] = URL_SAFE_NO_PAD.encode(claims.to_string());
            assert_eq!(verify(&parts.join("."), &jwks).unwrap_err(), BAD_SIGNATURE, "{name}");
        }
    }

    #[test]
    fn a_key_the_issuer_did_not_publish_is_not_found() {
        let without = fixtures()["jwks_without_rsa2"].clone();
        assert!(verify(&token("rs256_other_key"), &without).unwrap_err().contains("none for this ID token"));
    }

    #[test]
    fn unsigned_and_shared_secret_tokens_are_refused() {
        let jwks = fixtures()["jwks"].clone();
        let unsigned = format!("{}.{}.", URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#), URL_SAFE_NO_PAD.encode(r#"{"sub":"eve"}"#));
        assert!(verify(&unsigned, &jwks).unwrap_err().contains("\"none\""));
        let hmac = format!("{}.{}.c2ln", URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","kid":"rsa1"}"#), URL_SAFE_NO_PAD.encode(r#"{"sub":"eve"}"#));
        assert!(verify(&hmac, &jwks).unwrap_err().contains("HS256"));
        let own_key = format!("{}.{}.c2ln", URL_SAFE_NO_PAD.encode(r#"{"alg":"RS256","jku":"https://evil.test/keys"}"#), URL_SAFE_NO_PAD.encode(r#"{"sub":"eve"}"#));
        assert!(verify(&own_key, &jwks).unwrap_err().contains("names its own key"));
    }

    #[test]
    fn an_es256_token_is_not_checked_with_an_rsa_key() {
        // The EC token's header renamed to an RSA key: the types differ.
        let token = token("es256");
        let mut parts: Vec<String> = token.split('.').map(str::to_owned).collect();
        parts[0] = URL_SAFE_NO_PAD.encode(r#"{"alg":"ES256","kid":"rsa1"}"#);
        assert!(verify(&parts.join("."), &fixtures()["jwks"]).is_err());
    }
}
