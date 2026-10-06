//! Reading the manifests a client pushes: Docker's image manifest and
//! manifest list, and OCI's image manifest and index, artifacts and their
//! `subject` included.

use serde::Deserialize;
use serde_json::Value;

use crate::digest::Digest;

pub const DOCKER_MANIFEST: &str = "application/vnd.docker.distribution.manifest.v2+json";
pub const DOCKER_LIST: &str = "application/vnd.docker.distribution.manifest.list.v2+json";
pub const OCI_MANIFEST: &str = "application/vnd.oci.image.manifest.v1+json";
pub const OCI_INDEX: &str = "application/vnd.oci.image.index.v1+json";
/// The config of an artifact that has none of its own.
const OCI_EMPTY: &str = "application/vnd.oci.empty.v1+json";
/// The most a manifest may be, as other registries allow.
pub const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;

/// Whether a manifest lists images (a manifest list or index) or is one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Image,
    Index,
}

/// Something a manifest refers to by digest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    pub digest: Digest,
    pub size: u64,
    pub media_type: Option<String>,
    /// `config` or `layer`, for an image's blobs; the platform, for an
    /// index's manifests.
    pub role: String,
}

/// A manifest as read.
#[derive(Clone, Debug, PartialEq)]
pub struct Manifest {
    pub media_type: String,
    pub kind: Kind,
    /// The blobs an image manifest names: its config, then its layers.
    pub blobs: Vec<Reference>,
    /// The manifests an index names.
    pub manifests: Vec<Reference>,
    pub subject: Option<Digest>,
    /// What an artifact is: `artifactType`, or an image's config's type.
    pub artifact_type: Option<String>,
    pub annotations: Option<Value>,
    /// For an index: `os/architecture[/variant]` of each manifest that says.
    pub platforms: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    media_type: Option<String>,
    digest: String,
    size: u64,
    #[serde(default)]
    platform: Option<Platform>,
}

#[derive(Deserialize)]
struct Platform {
    architecture: String,
    os: String,
    #[serde(default)]
    variant: Option<String>,
}

impl Platform {
    fn name(&self) -> String {
        match &self.variant {
            Some(variant) if !variant.is_empty() => format!("{}/{}/{variant}", self.os, self.architecture),
            _ => format!("{}/{}", self.os, self.architecture),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    #[serde(default)]
    schema_version: Option<u32>,
    #[serde(default)]
    media_type: Option<String>,
    #[serde(default)]
    artifact_type: Option<String>,
    #[serde(default)]
    config: Option<Descriptor>,
    #[serde(default)]
    layers: Option<Vec<Descriptor>>,
    #[serde(default)]
    manifests: Option<Vec<Descriptor>>,
    #[serde(default)]
    subject: Option<Descriptor>,
    #[serde(default)]
    annotations: Option<Value>,
}

/// Why a manifest was refused, as the registry's error codes say it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refused {
    /// Not a manifest this registry reads (`MANIFEST_INVALID`).
    Invalid(String),
    /// Docker's schema 1, long retired (`UNSUPPORTED`).
    Unsupported(String),
}

fn reference(descriptor: Descriptor, role: String) -> Result<Reference, Refused> {
    let digest = Digest::parse(&descriptor.digest)
        .ok_or_else(|| Refused::Invalid(format!("{} is not a sha256 digest.", descriptor.digest)))?;
    Ok(Reference { digest, size: descriptor.size, media_type: descriptor.media_type, role })
}

/// Reads a manifest. `content_type` is the request's, which wins over the
/// manifest's own `mediaType` when both are given, as the spec says.
pub fn parse(bytes: &[u8], content_type: Option<&str>) -> Result<Manifest, Refused> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(Refused::Invalid(format!("A manifest is at most {} MiB.", MAX_MANIFEST_BYTES / 1024 / 1024)));
    }
    let raw: Raw = serde_json::from_slice(bytes).map_err(|error| Refused::Invalid(format!("The manifest is not valid JSON: {error}.")))?;
    let given = content_type
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_owned())
        .filter(|value| !value.is_empty() && value != "application/json" && value != "application/octet-stream");
    let media_type = given.or(raw.media_type.clone()).unwrap_or_default();
    if media_type.starts_with("application/vnd.docker.distribution.manifest.v1+") || raw.schema_version == Some(1) {
        return Err(Refused::Unsupported("Docker image manifests of schema 1 are not accepted; push with a current client.".to_owned()));
    }
    let kind = match media_type.as_str() {
        DOCKER_MANIFEST | OCI_MANIFEST => Kind::Image,
        DOCKER_LIST | OCI_INDEX => Kind::Index,
        // An OCI manifest may leave its media type out: what it holds says.
        "" if raw.manifests.is_some() => Kind::Index,
        "" if raw.config.is_some() => Kind::Image,
        other => return Err(Refused::Invalid(format!("Manifests of type {other} are not accepted."))),
    };
    let media_type = match (media_type.as_str(), kind) {
        ("", Kind::Image) => OCI_MANIFEST.to_owned(),
        ("", Kind::Index) => OCI_INDEX.to_owned(),
        _ => media_type,
    };
    let subject = match raw.subject {
        Some(subject) => Some(reference(subject, "subject".to_owned())?.digest),
        None => None,
    };
    let mut manifest = Manifest {
        media_type,
        kind,
        blobs: Vec::new(),
        manifests: Vec::new(),
        subject,
        artifact_type: raw.artifact_type.filter(|t| !t.is_empty()),
        annotations: raw.annotations,
        platforms: Vec::new(),
    };
    match kind {
        Kind::Image => {
            let config = raw.config.ok_or_else(|| Refused::Invalid("An image manifest names its config.".to_owned()))?;
            // What a referrer is, when it says only through its config.
            if manifest.artifact_type.is_none() && manifest.subject.is_some() {
                manifest.artifact_type = config.media_type.clone().filter(|t| t != OCI_EMPTY);
            }
            manifest.blobs.push(reference(config, "config".to_owned())?);
            for layer in raw.layers.unwrap_or_default() {
                manifest.blobs.push(reference(layer, "layer".to_owned())?);
            }
        }
        Kind::Index => {
            for entry in raw.manifests.unwrap_or_default() {
                let platform = entry.platform.as_ref().map(Platform::name);
                if let Some(platform) = &platform
                    && !platform.starts_with("unknown/")
                    && !manifest.platforms.contains(platform)
                {
                    manifest.platforms.push(platform.clone());
                }
                manifest.manifests.push(reference(entry, platform.unwrap_or_default())?);
            }
        }
    }
    Ok(manifest)
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn digest(c: char) -> String {
        format!("sha256:{}", c.to_string().repeat(64))
    }

    #[test]
    fn an_image_names_its_config_then_its_layers() {
        let body = json!({
            "schemaVersion": 2,
            "mediaType": DOCKER_MANIFEST,
            "config": { "mediaType": "application/vnd.docker.container.image.v1+json", "digest": digest('a'), "size": 10 },
            "layers": [{ "mediaType": "application/vnd.docker.image.rootfs.diff.tar.gzip", "digest": digest('b'), "size": 20 }],
        });
        let manifest = parse(body.to_string().as_bytes(), Some(DOCKER_MANIFEST)).unwrap();
        assert_eq!(manifest.kind, Kind::Image);
        assert_eq!(manifest.blobs.len(), 2);
        assert_eq!(manifest.blobs[0].role, "config");
        assert_eq!(manifest.blobs[1].size, 20);
        assert_eq!(manifest.subject, None);
    }

    #[test]
    fn an_index_names_its_manifests_and_platforms() {
        let body = json!({
            "schemaVersion": 2,
            "mediaType": OCI_INDEX,
            "manifests": [
                { "mediaType": OCI_MANIFEST, "digest": digest('a'), "size": 1, "platform": { "os": "linux", "architecture": "amd64" } },
                { "mediaType": OCI_MANIFEST, "digest": digest('b'), "size": 1, "platform": { "os": "linux", "architecture": "arm64", "variant": "v8" } },
                { "mediaType": OCI_MANIFEST, "digest": digest('c'), "size": 1, "platform": { "os": "unknown", "architecture": "unknown" } },
            ],
        });
        // Sent as plain JSON: the manifest's own type says what it is.
        let manifest = parse(body.to_string().as_bytes(), Some("application/json")).unwrap();
        assert_eq!(manifest.kind, Kind::Index);
        assert_eq!(manifest.manifests.len(), 3);
        assert_eq!(manifest.platforms, ["linux/amd64", "linux/arm64/v8"]);
    }

    #[test]
    fn an_artifact_names_its_subject_and_type() {
        let body = json!({
            "schemaVersion": 2,
            "mediaType": OCI_MANIFEST,
            "artifactType": "application/vnd.example.sbom",
            "config": { "mediaType": OCI_EMPTY, "digest": digest('e'), "size": 2 },
            "layers": [],
            "subject": { "mediaType": OCI_MANIFEST, "digest": digest('a'), "size": 100 },
            "annotations": { "org.example": "yes" },
        });
        let manifest = parse(body.to_string().as_bytes(), None).unwrap();
        assert_eq!(manifest.subject.unwrap().as_str(), digest('a'));
        assert_eq!(manifest.artifact_type.as_deref(), Some("application/vnd.example.sbom"));
        assert_eq!(manifest.annotations.unwrap()["org.example"], "yes");
        // Without artifactType, a referrer's config type is what it is.
        let typed = json!({
            "schemaVersion": 2,
            "config": { "mediaType": "application/vnd.example.sig", "digest": digest('e'), "size": 2 },
            "layers": [],
            "subject": { "mediaType": OCI_MANIFEST, "digest": digest('a'), "size": 100 },
        });
        let manifest = parse(typed.to_string().as_bytes(), None).unwrap();
        assert_eq!(manifest.media_type, OCI_MANIFEST);
        assert_eq!(manifest.artifact_type.as_deref(), Some("application/vnd.example.sig"));
    }

    #[test]
    fn what_is_not_a_manifest_is_refused() {
        assert!(matches!(parse(b"not json", None), Err(Refused::Invalid(_))));
        let v1 = json!({ "schemaVersion": 1, "name": "x", "fsLayers": [] });
        assert!(matches!(parse(v1.to_string().as_bytes(), None), Err(Refused::Unsupported(_))));
        let no_config = json!({ "schemaVersion": 2, "mediaType": OCI_MANIFEST, "layers": [] });
        assert!(matches!(parse(no_config.to_string().as_bytes(), None), Err(Refused::Invalid(_))));
        let bad_digest = json!({ "schemaVersion": 2, "mediaType": OCI_MANIFEST, "config": { "digest": "md5:x", "size": 1 } });
        assert!(matches!(parse(bad_digest.to_string().as_bytes(), None), Err(Refused::Invalid(_))));
        let other = json!({ "schemaVersion": 2, "mediaType": "text/plain" });
        assert!(matches!(parse(other.to_string().as_bytes(), Some("text/plain")), Err(Refused::Invalid(_))));
    }
}
