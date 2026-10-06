//! Signing as g1t's GitHub App: a short-lived RS256 JSON Web Token, made
//! with WebCrypto, which GitHub trades for an installation access token.
//!
//! GitHub hands out app private keys as PKCS#1 PEM (`BEGIN RSA PRIVATE
//! KEY`); WebCrypto imports only PKCS#8. A PKCS#1 key is wrapped in the
//! PKCS#8 structure here, so the downloaded file can be stored as it is.
//! A PKCS#8 key (`BEGIN PRIVATE KEY`) is used unchanged.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use g1t_kit::js;
use serde_json::json;
use worker::js_sys::{self, Uint8Array};
use worker::{Error, Result};

/// `AlgorithmIdentifier` for rsaEncryption (1.2.840.113549.1.1.1) with
/// NULL parameters, DER-encoded.
const RSA_ALGORITHM: [u8; 15] = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

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

/// Wraps a PKCS#1 `RSAPrivateKey` in a PKCS#8 `PrivateKeyInfo`:
/// `SEQUENCE { INTEGER 0, rsaEncryption, OCTET STRING { pkcs1 } }`.
pub fn pkcs1_to_pkcs8(pkcs1: &[u8]) -> Vec<u8> {
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

/// The PKCS#8 DER of a PEM private key, in either form. Tolerates the
/// line breaks of a key pasted into a secret as `\n`.
pub fn private_key_der(pem: &str) -> std::result::Result<Vec<u8>, String> {
    let pem = pem.replace("\\n", "\n");
    let pkcs1 = pem.contains("BEGIN RSA PRIVATE KEY");
    if !pkcs1 && !pem.contains("BEGIN PRIVATE KEY") {
        return Err("GITHUB_APP_PRIVATE_KEY is not a PEM private key.".to_owned());
    }
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .flat_map(|line| line.chars())
        .filter(|character| !character.is_whitespace())
        .collect();
    let der = STANDARD
        .decode(body)
        .map_err(|_| "GITHUB_APP_PRIVATE_KEY is not valid base64.".to_owned())?;
    Ok(if pkcs1 { pkcs1_to_pkcs8(&der) } else { der })
}

/// The header and claims of an app JWT, base64url-encoded and joined:
/// what is signed. Issued a minute in the past against clock drift, and
/// good for nine minutes, under GitHub's ten.
pub fn signing_input(issuer: &str, now_seconds: u64) -> String {
    let header = json!({ "alg": "RS256", "typ": "JWT" });
    let claims = json!({
        "iat": now_seconds.saturating_sub(60),
        "exp": now_seconds + 9 * 60,
        "iss": issuer,
    });
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

/// RSASSA-PKCS1-v1_5 with SHA-256, by WebCrypto.
async fn sign_rs256(pkcs8: &[u8], data: &[u8]) -> Result<Vec<u8>> {
    let subtle = js::get(&js::get(&js_sys::global(), "crypto"), "subtle");
    let algorithm = js::to_js(&json!({ "name": "RSASSA-PKCS1-v1_5", "hash": "SHA-256" }))?;
    let usages = js::to_js(&json!(["sign"]))?;
    let key = js::call(
        &subtle,
        "importKey",
        &["pkcs8".into(), Uint8Array::from(pkcs8).into(), algorithm.clone(), false.into(), usages],
    )
    .await
    .map_err(|thrown| Error::RustError(format!("GITHUB_APP_PRIVATE_KEY could not be used: {thrown}")))?;
    let signature = js::call(&subtle, "sign", &[algorithm, key, Uint8Array::from(data).into()]).await?;
    Ok(Uint8Array::new(&signature).to_vec())
}

/// A JWT that authenticates as the app.
pub async fn app_jwt(issuer: &str, private_key_pem: &str, now_seconds: u64) -> Result<String> {
    let der = private_key_der(private_key_pem).map_err(Error::RustError)?;
    let input = signing_input(issuer, now_seconds);
    let signature = sign_rs256(&der, input.as_bytes()).await?;
    Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_are_der() {
        assert_eq!(der_length(5), vec![5]);
        assert_eq!(der_length(127), vec![127]);
        assert_eq!(der_length(128), vec![0x81, 0x80]);
        assert_eq!(der_length(608), vec![0x82, 0x02, 0x60]);
        assert_eq!(der_length(70_000), vec![0x83, 0x01, 0x11, 0x70]);
    }

    #[test]
    fn a_pkcs1_key_is_wrapped_as_openssl_does() {
        // `openssl pkcs8 -topk8 -nocrypt` of a 1024-bit key, whose PKCS#1
        // form is 608 bytes, begins with exactly these 26 bytes.
        let pkcs1 = vec![0xab; 608];
        let wrapped = pkcs1_to_pkcs8(&pkcs1);
        let expected = hex::decode("30820276020100300d06092a864886f70d0101010500048202 60".replace(' ', "")).unwrap();
        assert_eq!(&wrapped[..expected.len()], expected.as_slice());
        assert_eq!(&wrapped[expected.len()..], pkcs1.as_slice());
        assert_eq!(wrapped.len(), 634);
        // A 2048-bit key, as GitHub issues: 1190-ish bytes, two-byte lengths.
        let wrapped = pkcs1_to_pkcs8(&vec![1; 1191]);
        assert_eq!(&wrapped[..4], &[0x30, 0x82, 0x04, 0xbd]);
        assert_eq!(&wrapped[22..26], &[0x04, 0x82, 0x04, 0xa7]);
    }

    /// With G1T_TEST_PKCS1_PEM and G1T_TEST_PKCS8_DER naming a key made by
    /// `openssl genrsa -traditional` and its `openssl pkcs8 -topk8 -nocrypt
    /// -outform DER`, the conversion must match byte for byte.
    #[test]
    fn a_real_key_matches_openssl_when_given_one() {
        let (Ok(pem), Ok(der)) = (std::env::var("G1T_TEST_PKCS1_PEM"), std::env::var("G1T_TEST_PKCS8_DER")) else {
            return;
        };
        let pem = std::fs::read_to_string(pem).unwrap();
        let expected = std::fs::read(der).unwrap();
        assert_eq!(private_key_der(&pem).unwrap(), expected);
    }

    #[test]
    fn either_pem_form_is_read() {
        let body = STANDARD.encode([0x30, 0x03, 0x02, 0x01, 0x00]);
        let pkcs1 = format!("{}\n{body}\n{}\n", concat!("-----BEGIN RSA ", "PRIVATE KEY-----"), concat!("-----END RSA ", "PRIVATE KEY-----"));
        assert_eq!(private_key_der(&pkcs1).unwrap(), pkcs1_to_pkcs8(&[0x30, 0x03, 0x02, 0x01, 0x00]));
        // Pasted into a secret with escaped line breaks.
        assert_eq!(private_key_der(&pkcs1.replace('\n', "\\n")).unwrap(), private_key_der(&pkcs1).unwrap());
        let pkcs8 = format!("{}\r\n{body}\r\n{}", concat!("-----BEGIN ", "PRIVATE KEY-----"), concat!("-----END ", "PRIVATE KEY-----"));
        assert_eq!(private_key_der(&pkcs8).unwrap(), vec![0x30, 0x03, 0x02, 0x01, 0x00]);
        assert!(private_key_der("not a key").is_err());
    }

    #[test]
    fn the_claims_are_backdated_and_short() {
        let input = signing_input("Iv23liZS94alfjIUn1eW", 1_700_000_000);
        let (header, claims) = input.split_once('.').unwrap();
        let header: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).unwrap()).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims).unwrap()).unwrap();
        assert_eq!(header["alg"], "RS256");
        assert_eq!(claims["iss"], "Iv23liZS94alfjIUn1eW");
        assert_eq!(claims["iat"], 1_700_000_000 - 60);
        let lifetime = claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap();
        assert!(lifetime <= 600, "GitHub refuses a JWT good for more than ten minutes");
    }
}
