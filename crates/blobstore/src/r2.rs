//! The R2 adapter: the service's bucket binding for everything, and R2's S3
//! endpoint only to sign download URLs, when the service names signing
//! variables (`Config::r2_signer`) and they are set. Without them, large
//! objects stream through the Worker like small ones.

use worker::{Bucket, Env, Range, Result, UploadedPart};

use crate::sigv4::{Credentials, amz_date};
use crate::{BlobStore, Config, Got, Part, Wanted, var};

pub struct R2Store {
    bucket: Bucket,
    signer: Option<(Credentials, String, String)>,
}

impl R2Store {
    pub fn from_env(env: &Env, config: &Config) -> Result<R2Store> {
        let [key, secret, account, bucket] = config
            .r2_signer
            .map(|names| names.map(|name| var(env, name)))
            .unwrap_or_default();
        let signer = (!key.is_empty() && !secret.is_empty() && !account.is_empty() && !bucket.is_empty()).then(|| {
            (
                Credentials { access_key_id: key, secret_access_key: secret, region: "auto".to_owned() },
                format!("{account}.r2.cloudflarestorage.com"),
                bucket,
            )
        });
        Ok(R2Store { bucket: env.bucket(config.binding)?, signer })
    }
}

impl BlobStore for R2Store {
    async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
        self.bucket.put(key, bytes).execute().await?;
        Ok(())
    }

    async fn get(&self, key: &str, range: Option<Wanted>) -> Result<Option<Got>> {
        let mut get = self.bucket.get(key);
        if let Some(range) = range {
            get = get.range(Range::OffsetWithLength { offset: range.offset, length: range.length });
        }
        let Some(object) = get.execute().await? else {
            return Ok(None);
        };
        let size = object.size();
        let Some(body) = object.body() else {
            return Ok(None);
        };
        Ok(Some(Got { size, body: body.response_body()? }))
    }

    async fn head(&self, key: &str) -> Result<Option<u64>> {
        Ok(self.bucket.head(key).await?.map(|object| object.size()))
    }

    async fn delete(&self, key: &str) -> Result<()> {
        self.bucket.delete(key).await
    }

    async fn create_multipart(&self, key: &str) -> Result<String> {
        let upload = self.bucket.create_multipart_upload(key).execute().await?;
        Ok(upload.upload_id().await)
    }

    async fn upload_part(&self, key: &str, upload_id: &str, number: u16, bytes: Vec<u8>) -> Result<Part> {
        let upload = self.bucket.resume_multipart_upload(key, upload_id)?;
        let part = upload.upload_part(number, bytes).await?;
        Ok(Part { number: part.part_number(), etag: part.etag() })
    }

    async fn complete_multipart(&self, key: &str, upload_id: &str, parts: &[Part]) -> Result<()> {
        let upload = self.bucket.resume_multipart_upload(key, upload_id)?;
        upload
            .complete(parts.iter().map(|part| UploadedPart::new(part.number, part.etag.clone())))
            .await?;
        Ok(())
    }

    async fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<()> {
        self.bucket.resume_multipart_upload(key, upload_id)?.abort().await
    }

    fn presign_get(&self, key: &str, expires: u32, now_ms: u64) -> Option<String> {
        let (credentials, host, bucket) = self.signer.as_ref()?;
        let path = format!("/{bucket}/{key}");
        Some(credentials.presign_get(&format!("https://{host}"), host, &path, &amz_date(now_ms), expires))
    }
}
