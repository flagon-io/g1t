//! The S3 adapter, for self-hosted installations: any S3-compatible store
//! (MinIO, Ceph, Garage, AWS) over fetch, signed with SigV4, path-style.
//! S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_REGION say
//! where, and the service's own variable (`Config::s3_bucket`) which
//! bucket. Its public endpoint variable, when it names one and that is
//! set, is the address clients reach the store at, and large downloads are
//! then sent there with a signed URL instead of through the Worker.

use worker::wasm_bindgen::JsValue;
use worker::{Env, Fetch, Headers, Method, Request, RequestInit, Response, Result, Url};

use crate::sigv4::{Credentials, UNSIGNED, amz_date};
use crate::{BlobStore, Config, Got, Part, Wanted, var};

pub struct S3Store {
    /// `http://minio:9000`, without a trailing slash.
    endpoint: String,
    /// Where clients reach the same store, for signed URLs.
    public_endpoint: Option<String>,
    bucket: String,
    credentials: Credentials,
}

fn failed(what: &str, status: u16, body: &str) -> worker::Error {
    let said: String = body.chars().take(300).collect();
    worker::Error::RustError(format!("storage {what} failed with status {status}: {said}"))
}

/// The text of the first `<tag>` in an XML answer.
fn xml_value<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{tag}>"))? + start;
    Some(&xml[start..end])
}

fn host_of(endpoint: &str) -> String {
    endpoint
        .split_once("://")
        .map_or(endpoint, |(_, rest)| rest)
        .split('/')
        .next()
        .unwrap_or_default()
        .to_owned()
}

impl S3Store {
    pub fn from_env(env: &Env, config: &Config) -> Result<S3Store> {
        let endpoint = var(env, "S3_ENDPOINT").trim_end_matches('/').to_owned();
        let bucket = var(env, config.s3_bucket);
        if endpoint.is_empty() || bucket.is_empty() {
            return Err(worker::Error::RustError(format!(
                "{} is s3, but S3_ENDPOINT or {} is not set",
                config.kind, config.s3_bucket
            )));
        }
        let region = var(env, "S3_REGION");
        let public = config
            .s3_public_endpoint
            .map(|name| var(env, name).trim_end_matches('/').to_owned())
            .unwrap_or_default();
        Ok(S3Store {
            endpoint,
            public_endpoint: (!public.is_empty()).then_some(public),
            bucket,
            credentials: Credentials {
                access_key_id: var(env, "S3_ACCESS_KEY_ID"),
                secret_access_key: var(env, "S3_SECRET_ACCESS_KEY"),
                region: if region.is_empty() { "us-east-1".to_owned() } else { region },
            },
        })
    }

    fn path(&self, key: &str) -> String {
        format!("/{}/{key}", self.bucket)
    }

    /// Sends one signed request, and answers with the response whatever
    /// its status.
    async fn send(
        &self,
        method: Method,
        key: &str,
        query: &[(String, String)],
        extra: &[(&str, String)],
        body: Option<Vec<u8>>,
    ) -> Result<Response> {
        let path = self.path(key);
        let date = amz_date(g1t_kit::now_ms());
        let mut signed = vec![
            ("host".to_owned(), host_of(&self.endpoint)),
            ("x-amz-content-sha256".to_owned(), UNSIGNED.to_owned()),
            ("x-amz-date".to_owned(), date),
        ];
        for (name, value) in extra {
            signed.push(((*name).to_owned(), value.clone()));
        }
        let authorization = self
            .credentials
            .authorization(method.as_ref(), &path, query, &signed, UNSIGNED);
        let headers = Headers::new();
        for (name, value) in &signed {
            if name != "host" {
                headers.set(name, value)?;
            }
        }
        headers.set("authorization", &authorization)?;
        let mut url = Url::parse(&format!("{}{}", self.endpoint, crate::sigv4::uri_encode(&path, true)))?;
        if !query.is_empty() {
            let text: Vec<String> = query
                .iter()
                .map(|(k, v)| {
                    let (k, v) = (crate::sigv4::uri_encode(k, false), crate::sigv4::uri_encode(v, false));
                    if v.is_empty() { format!("{k}=") } else { format!("{k}={v}") }
                })
                .collect();
            url.set_query(Some(&text.join("&")));
        }
        let mut init = RequestInit::new();
        init.with_method(method).with_headers(headers);
        if let Some(body) = body {
            init.with_body(Some(JsValue::from(worker::js_sys::Uint8Array::from(body.as_slice()))));
        }
        Fetch::Request(Request::new_with_init(url.as_str(), &init)?).send().await
    }

    async fn ok(&self, what: &str, mut response: Response) -> Result<Response> {
        let status = response.status_code();
        if (200..300).contains(&status) {
            return Ok(response);
        }
        let body = response.text().await.unwrap_or_default();
        Err(failed(what, status, &body))
    }
}

fn query(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

impl BlobStore for S3Store {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        let length = bytes.len().to_string();
        let response = self
            .send(Method::Put, key, &[], &[("content-length", length)], Some(bytes))
            .await?;
        self.ok("put", response).await.map(|_| ())
    }

    async fn get(&self, key: &str, range: Option<Wanted>) -> Result<Option<Got>> {
        let extra: Vec<(&str, String)> = range
            .map(|r| ("range", format!("bytes={}-{}", r.offset, r.offset + r.length - 1)))
            .into_iter()
            .collect();
        let response = self.send(Method::Get, key, &[], &extra, None).await?;
        if response.status_code() == 404 {
            return Ok(None);
        }
        let response = self.ok("get", response).await?;
        let size = match response.headers().get("content-range")? {
            // `bytes 0-9/100`: the whole object's size is after the slash.
            Some(range) => range.rsplit('/').next().and_then(|n| n.parse().ok()).unwrap_or(0),
            None => response.headers().get("content-length")?.and_then(|n| n.parse().ok()).unwrap_or(0),
        };
        let (_, body) = response.into_parts();
        Ok(Some(Got { size, body }))
    }

    async fn head(&self, key: &str) -> Result<Option<u64>> {
        let response = self.send(Method::Head, key, &[], &[], None).await?;
        if response.status_code() == 404 {
            return Ok(None);
        }
        let response = self.ok("head", response).await?;
        Ok(response.headers().get("content-length")?.and_then(|n| n.parse().ok()))
    }

    async fn delete(&self, key: &str) -> Result<()> {
        let response = self.send(Method::Delete, key, &[], &[], None).await?;
        if response.status_code() == 404 {
            return Ok(());
        }
        self.ok("delete", response).await.map(|_| ())
    }

    async fn create_multipart(&self, key: &str) -> Result<String> {
        let response = self.send(Method::Post, key, &query(&[("uploads", "")]), &[], None).await?;
        let text = self.ok("create multipart", response).await?.text().await?;
        xml_value(&text, "UploadId")
            .map(str::to_owned)
            .ok_or_else(|| failed("create multipart", 200, &text))
    }

    async fn upload_part(&self, key: &str, upload_id: &str, number: u16, bytes: Vec<u8>) -> Result<Part> {
        let number_text = number.to_string();
        let length = bytes.len().to_string();
        let response = self
            .send(
                Method::Put,
                key,
                &query(&[("partNumber", &number_text), ("uploadId", upload_id)]),
                &[("content-length", length)],
                Some(bytes),
            )
            .await?;
        let response = self.ok("upload part", response).await?;
        let etag = response.headers().get("etag")?.unwrap_or_default();
        Ok(Part { number, etag })
    }

    async fn complete_multipart(&self, key: &str, upload_id: &str, parts: &[Part]) -> Result<()> {
        let mut xml = String::from("<CompleteMultipartUpload>");
        for part in parts {
            xml.push_str(&format!("<Part><PartNumber>{}</PartNumber><ETag>{}</ETag></Part>", part.number, part.etag));
        }
        xml.push_str("</CompleteMultipartUpload>");
        let length = xml.len().to_string();
        let response = self
            .send(Method::Post, key, &query(&[("uploadId", upload_id)]), &[("content-length", length)], Some(xml.into_bytes()))
            .await?;
        // S3 may answer 200 and still have failed, saying so in the body.
        let text = self.ok("complete multipart", response).await?.text().await?;
        if text.contains("<Error>") {
            return Err(failed("complete multipart", 200, &text));
        }
        Ok(())
    }

    async fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<()> {
        let response = self.send(Method::Delete, key, &query(&[("uploadId", upload_id)]), &[], None).await?;
        if response.status_code() == 404 {
            return Ok(());
        }
        self.ok("abort multipart", response).await.map(|_| ())
    }

    fn presign_get(&self, key: &str, expires: u32, now_ms: u64) -> Option<String> {
        let base = self.public_endpoint.as_ref()?;
        Some(self.credentials.presign_get(base, &host_of(base), &self.path(key), &amz_date(now_ms), expires))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_are_read_from_their_xml() {
        let xml = "<InitiateMultipartUploadResult><Bucket>b</Bucket><UploadId>abc-123</UploadId></InitiateMultipartUploadResult>";
        assert_eq!(xml_value(xml, "UploadId"), Some("abc-123"));
        assert_eq!(xml_value(xml, "Key"), None);
        assert_eq!(host_of("http://minio:9000"), "minio:9000");
        assert_eq!(host_of("https://s3.example.com/base"), "s3.example.com");
    }
}
