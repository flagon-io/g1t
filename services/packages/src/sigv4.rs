//! AWS Signature Version 4, for S3-compatible storage: signing a request's
//! headers, and signing a URL that lets its holder download one object for
//! a while. R2's S3 endpoint takes the same signatures, which is how large
//! downloads are sent straight to it.

use hmac::{Hmac, Mac};
use sha2::{Digest as _, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// The hash of a payload that is not signed: bodies stream as they are.
pub const UNSIGNED: &str = "UNSIGNED-PAYLOAD";

/// Who signs, and for which region.
#[derive(Clone, Debug)]
pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub region: String,
}

/// `20130524T000000Z` from milliseconds since the epoch.
pub fn amz_date(now_ms: u64) -> String {
    let text = g1t_contracts::time::rfc3339(now_ms);
    let whole = text.split('.').next().unwrap_or(&text);
    format!("{}Z", whole.replace(['-', ':'], ""))
}

/// Percent-encodes everything but the unreserved characters, and `/` too
/// unless `path`.
pub fn uri_encode(text: &str, path: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(byte as char),
            b'/' if path => out.push('/'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// The query string, sorted and encoded as signing needs it.
fn canonical_query(query: &[(String, String)]) -> String {
    let mut pairs: Vec<(String, String)> = query
        .iter()
        .map(|(key, value)| (uri_encode(key, false), uri_encode(value, false)))
        .collect();
    pairs.sort();
    pairs
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

impl Credentials {
    fn scope(&self, date: &str) -> String {
        format!("{}/{}/s3/aws4_request", &date[..8], self.region)
    }

    fn signature(&self, date: &str, canonical_request: &str) -> String {
        let to_sign = format!(
            "AWS4-HMAC-SHA256\n{date}\n{}\n{}",
            self.scope(date),
            sha256_hex(canonical_request.as_bytes())
        );
        let key = hmac(format!("AWS4{}", self.secret_access_key).as_bytes(), &date[..8]);
        let key = hmac(&key, &self.region);
        let key = hmac(&key, "s3");
        let key = hmac(&key, "aws4_request");
        hex::encode(hmac(&key, &to_sign))
    }

    /// The `Authorization` header for a request. `headers` must include
    /// `host`, `x-amz-date` and `x-amz-content-sha256`, lowercase; every
    /// one given is signed.
    pub fn authorization(
        &self,
        method: &str,
        path: &str,
        query: &[(String, String)],
        headers: &[(String, String)],
        payload_hash: &str,
    ) -> String {
        let mut headers: Vec<(String, String)> = headers
            .iter()
            .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
            .collect();
        headers.sort();
        let date = headers
            .iter()
            .find(|(name, _)| name == "x-amz-date")
            .map(|(_, value)| value.clone())
            .unwrap_or_default();
        let signed: Vec<&str> = headers.iter().map(|(name, _)| name.as_str()).collect();
        let signed = signed.join(";");
        let canonical_headers: String = headers.iter().map(|(name, value)| format!("{name}:{value}\n")).collect();
        let canonical = format!(
            "{method}\n{}\n{}\n{canonical_headers}\n{signed}\n{payload_hash}",
            uri_encode(path, true),
            canonical_query(query)
        );
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={signed}, Signature={}",
            self.access_key_id,
            self.scope(&date),
            self.signature(&date, &canonical)
        )
    }

    /// A URL that lets anyone `GET` the object at `path` on `host` for
    /// `expires` seconds from `date`. `base` is the scheme and host the
    /// URL starts with.
    pub fn presign_get(&self, base: &str, host: &str, path: &str, date: &str, expires: u32) -> String {
        let mut query = vec![
            ("X-Amz-Algorithm".to_owned(), "AWS4-HMAC-SHA256".to_owned()),
            ("X-Amz-Credential".to_owned(), format!("{}/{}", self.access_key_id, self.scope(date))),
            ("X-Amz-Date".to_owned(), date.to_owned()),
            ("X-Amz-Expires".to_owned(), expires.to_string()),
            ("X-Amz-SignedHeaders".to_owned(), "host".to_owned()),
        ];
        let canonical = format!(
            "GET\n{}\n{}\nhost:{host}\n\nhost\n{UNSIGNED}",
            uri_encode(path, true),
            canonical_query(&query)
        );
        query.push(("X-Amz-Signature".to_owned(), self.signature(date, &canonical)));
        format!("{base}{}?{}", uri_encode(path, true), canonical_query(&query))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example() -> Credentials {
        Credentials {
            access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            region: "us-east-1".into(),
        }
    }

    /// AWS's own example of a presigned URL (Authenticating Requests:
    /// Using Query Parameters).
    #[test]
    fn a_presigned_url_matches_the_aws_example() {
        let url = example().presign_get(
            "https://examplebucket.s3.amazonaws.com",
            "examplebucket.s3.amazonaws.com",
            "/test.txt",
            "20130524T000000Z",
            86400,
        );
        assert!(url.starts_with("https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256"));
        assert!(url.contains("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request"));
        assert!(url.contains("&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404&"), "{url}");
    }

    /// AWS's own example of a signed GET with a range (Authenticating
    /// Requests: Using the Authorization Header).
    #[test]
    fn a_signed_request_matches_the_aws_example() {
        let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let headers = [
            ("Host", "examplebucket.s3.amazonaws.com"),
            ("Range", "bytes=0-9"),
            ("x-amz-content-sha256", empty),
            ("x-amz-date", "20130524T000000Z"),
        ]
        .map(|(name, value)| (name.to_owned(), value.to_owned()));
        let authorization = example().authorization("GET", "/test.txt", &[], &headers, empty);
        assert_eq!(
            authorization,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn dates_and_encoding() {
        assert_eq!(amz_date(1_369_353_600_000), "20130524T000000Z");
        assert_eq!(uri_encode("a b/c+d~", true), "a%20b/c%2Bd~");
        assert_eq!(uri_encode("a/b", false), "a%2Fb");
        let query = [("uploadId".to_owned(), "x y".to_owned()), ("partNumber".to_owned(), "2".to_owned())];
        assert_eq!(canonical_query(&query), "partNumber=2&uploadId=x%20y");
        assert_eq!(canonical_query(&[("uploads".to_owned(), String::new())]), "uploads=");
    }
}
