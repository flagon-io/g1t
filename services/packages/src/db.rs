//! The packages database: packages, their versions and tags, the blobs
//! they use, and uploads in progress.

use g1t_contracts::time::rfc3339;
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement, Result};

use crate::digest::Digest;
use crate::upload::Progress;

/// A day: how long an unreferenced blob is kept, and an upload left open.
pub const DAY_MS: u64 = 24 * 60 * 60 * 1000;

fn num(n: u64) -> JsValue {
    JsValue::from(n as f64)
}

fn text(s: &str) -> JsValue {
    JsValue::from(s)
}

fn opt(s: Option<&str>) -> JsValue {
    s.map_or(JsValue::NULL, JsValue::from)
}

#[derive(Clone, Debug, Deserialize)]
pub struct PackageRow {
    pub id: String,
    pub workspace: String,
    pub ecosystem: String,
    pub name: String,
    pub repo_id: Option<String>,
    pub repo_name: Option<String>,
    pub visibility: String,
    pub description: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub downloads: u64,
    /// Set while its workspace is deleted and may still be restored.
    #[serde(default)]
    pub workspace_deleted_at: Option<String>,
}

impl PackageRow {
    pub fn public(&self) -> bool {
        self.visibility == "public"
    }

    /// Whether its workspace is deleted: hidden from everyone.
    pub fn hidden(&self) -> bool {
        self.workspace_deleted_at.is_some()
    }
}

/// A package with what listings add up about it.
#[derive(Clone, Debug, Deserialize)]
pub struct ListedRow {
    #[serde(flatten)]
    pub package: PackageRow,
    pub version_count: u32,
    pub bytes: u64,
    pub latest_tag: Option<String>,
    /// The version `latest_tag` points to: what an npm listing shows,
    /// since its tags name versions rather than being what is installed.
    #[serde(default)]
    pub latest_tag_version: Option<String>,
    /// Every version, newest published first, one per line: the summary
    /// picks the highest of them (see `newest_version`).
    pub latest_version: Option<String>,
}

/// The version a listing calls latest: the highest stable one by number
/// (`v3.0.2` over `1.0.0`, whatever order they were published in, as an
/// import publishes every tag at once), else the highest pre-release, else
/// the newest published when none reads as a number.
pub fn newest_version(versions: &str) -> Option<String> {
    // Stable over pre-release, then by number, then pre-releases by label.
    let parse = |version: &str| -> Option<(bool, Vec<u64>, String)> {
        let bare = version.strip_prefix('v').unwrap_or(version);
        let (core, pre) = match bare.split_once(['-', '+']) {
            Some((core, rest)) if bare.as_bytes()[core.len()] == b'-' => (core, rest.to_owned()),
            Some((core, _)) => (core, String::new()),
            None => (bare, String::new()),
        };
        let parts = core.split('.').map(|part| part.parse::<u64>().ok()).collect::<Option<Vec<_>>>()?;
        Some((pre.is_empty(), parts, pre))
    };
    let list: Vec<&str> = versions.lines().map(str::trim).filter(|v| !v.is_empty()).collect();
    list.iter()
        .filter_map(|v| parse(v).map(|key| (key, *v)))
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, v)| v.to_owned())
        .or_else(|| list.first().map(|v| (*v).to_owned()))
}

/// What a listing shows as a package's latest. An image's tag is what is
/// pulled, so it is shown as is; npm's dist-tags (`latest`) name versions,
/// so the version the tag points to is shown, as for every other registry.
/// Without a tag, the highest version (see `newest_version`).
pub fn latest_shown(row: &ListedRow) -> Option<String> {
    let tagged = if row.package.ecosystem == "container" { &row.latest_tag } else { &row.latest_tag_version };
    tagged.clone().or_else(|| row.latest_version.as_deref().and_then(newest_version))
}

#[cfg(test)]
mod newest_tests {
    use super::{ListedRow, PackageRow, latest_shown, newest_version};

    fn listed(ecosystem: &str, tag: Option<&str>, tag_version: Option<&str>, versions: &str) -> ListedRow {
        ListedRow {
            package: PackageRow {
                id: "pkg_1".into(),
                workspace: "acme".into(),
                ecosystem: ecosystem.into(),
                name: "web".into(),
                repo_id: None,
                repo_name: None,
                visibility: "private".into(),
                description: None,
                created_by: "usr_1".into(),
                created_at: "2026-10-06T00:00:00.000Z".into(),
                updated_at: "2026-10-06T00:00:00.000Z".into(),
                downloads: 0,
                workspace_deleted_at: None,
            },
            version_count: 2,
            bytes: 0,
            latest_tag: tag.map(str::to_owned),
            latest_tag_version: tag_version.map(str::to_owned),
            latest_version: Some(versions.to_owned()),
        }
    }

    #[test]
    fn npm_shows_the_version_its_tag_points_to_and_an_image_its_tag() {
        let npm = listed("npm", Some("latest"), Some("1.2.0"), "2.0.0-beta.1\n1.2.0\n1.0.0");
        assert_eq!(latest_shown(&npm).as_deref(), Some("1.2.0"), "the version, not the word latest");
        let image = listed("container", Some("latest"), Some("sha256:abc"), "sha256:abc");
        assert_eq!(latest_shown(&image).as_deref(), Some("latest"), "an image is pulled by its tag");
        let cargo = listed("cargo", None, None, "0.9.0\n1.1.0\n1.0.0");
        assert_eq!(latest_shown(&cargo).as_deref(), Some("1.1.0"), "no tags: the highest version");
        let untagged = listed("container", None, None, "sha256:abc");
        assert_eq!(latest_shown(&untagged).as_deref(), Some("sha256:abc"));
    }

    #[test]
    fn the_latest_is_the_highest_stable_version_not_the_last_published() {
        assert_eq!(newest_version("1.0.0
3.0.2
2.0.0
3.0.0").as_deref(), Some("3.0.2"));
        assert_eq!(newest_version("v1.10.0
v1.9.3").as_deref(), Some("v1.10.0"));
        assert_eq!(newest_version("4.0.0-beta.1
3.0.2").as_deref(), Some("3.0.2"));
        assert_eq!(newest_version("4.0.0-beta.1
4.0.0-alpha").as_deref(), Some("4.0.0-beta.1"));
        assert_eq!(newest_version("dev-main
nightly").as_deref(), Some("dev-main"));
        assert_eq!(newest_version(""), None);
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct BlobRow {
    pub digest: String,
    pub size: u64,
    pub media_type: Option<String>,
    pub object_key: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct VersionRow {
    pub id: String,
    pub package_id: String,
    pub version: String,
    pub digest: String,
    pub size: u64,
    pub metadata: String,
    pub subject: Option<String>,
    pub published_by: Option<String>,
    pub published_at: String,
    /// npm's deprecation message, when the version is deprecated.
    #[serde(default)]
    pub deprecated: Option<String>,
    /// Cargo: 1 when the version is yanked.
    #[serde(default)]
    pub yanked: u32,
}

impl VersionRow {
    pub fn is_yanked(&self) -> bool {
        self.yanked != 0
    }
}

impl VersionRow {
    pub fn meta(&self) -> serde_json::Value {
        serde_json::from_str(&self.metadata).unwrap_or_default()
    }

    pub fn media_type(&self) -> Option<String> {
        self.meta()["media_type"].as_str().map(str::to_owned)
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct TagRow {
    pub tag: String,
    pub version_id: String,
    pub digest: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct UploadRow {
    pub id: String,
    pub workspace: String,
    pub package_id: String,
    pub package: String,
    pub multipart_id: Option<String>,
    pub parts: String,
    pub offset: u64,
    pub tail: u64,
    pub hash_state: String,
}

impl UploadRow {
    pub fn progress(&self) -> Option<Progress> {
        Some(Progress {
            id: self.id.clone(),
            multipart_id: self.multipart_id.clone(),
            parts: serde_json::from_str(&self.parts).ok()?,
            offset: self.offset,
            tail: self.tail,
            hasher: crate::digest::Sha256::restore(&self.hash_state)?,
        })
    }
}

/// One file of a version, as it is kept.
#[derive(Clone, Debug, Deserialize)]
pub struct FileRow {
    pub name: String,
    pub digest: String,
    pub size: u64,
    pub media_type: Option<String>,
}

/// A file's other checksums, in hex, beside its SHA-256 digest.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Checksums {
    pub md5: String,
    pub sha1: String,
    pub sha512: String,
}

impl Checksums {
    pub fn of(bytes: &[u8]) -> Checksums {
        use sha1::Digest as _;
        Checksums {
            md5: format!("{:x}", md5::compute(bytes)),
            sha1: hex::encode(sha1::Sha1::digest(bytes)),
            sha512: hex::encode(sha2::Sha512::digest(bytes)),
        }
    }
}

/// One file of a version, as it is recorded.
pub struct NewFile {
    pub name: String,
    pub digest: String,
    pub size: u64,
    pub media_type: Option<String>,
}

/// A version to record.
pub struct NewVersion {
    pub id: String,
    pub package_id: String,
    pub version: String,
    pub digest: String,
    pub size: u64,
    pub metadata: String,
    pub subject: Option<String>,
    pub published_by: Option<String>,
    pub files: Vec<NewFile>,
}

const PACKAGE_COLUMNS: &str =
    "id, workspace, ecosystem, name, repo_id, repo_name, visibility, description, created_by, created_at, updated_at, downloads, workspace_deleted_at";
/// Workspaces that are deleted, waiting to be purged or restored.
const DELETED_WORKSPACES: &str = "SELECT workspace FROM packages WHERE workspace_deleted_at IS NOT NULL";
const VERSION_COLUMNS: &str = "id, package_id, version, digest, size, metadata, subject, published_by, published_at, deprecated, yanked";

pub struct Db {
    pub db: D1Database,
}

impl Db {
    fn prepare(&self, sql: &str, values: &[JsValue]) -> Result<D1PreparedStatement> {
        self.db.prepare(sql).bind(values)
    }

    pub async fn package(&self, workspace: &str, ecosystem: &str, name: &str) -> Result<Option<PackageRow>> {
        self.prepare(
            &format!("SELECT {PACKAGE_COLUMNS} FROM packages WHERE workspace = ? AND ecosystem = ? AND name = ?"),
            &[text(workspace), text(ecosystem), text(name)],
        )?
        .first(None)
        .await
    }

    /// A package by its name in any case: Cargo's names are one name
    /// whatever their case (`Inflector` is `inflector`).
    pub async fn package_any_case(&self, workspace: &str, ecosystem: &str, name: &str) -> Result<Option<PackageRow>> {
        self.prepare(
            &format!("SELECT {PACKAGE_COLUMNS} FROM packages WHERE workspace = ? AND ecosystem = ? AND name = ? COLLATE NOCASE LIMIT 1"),
            &[text(workspace), text(ecosystem), text(name)],
        )?
        .first(None)
        .await
    }

    /// The package a new crate's name would clash with: one named the same
    /// apart from case and `-` against `_`, as crates.io decides.
    pub async fn package_folded(&self, workspace: &str, ecosystem: &str, folded: &str) -> Result<Option<PackageRow>> {
        self.prepare(
            &format!(
                "SELECT {PACKAGE_COLUMNS} FROM packages WHERE workspace = ? AND ecosystem = ? AND replace(lower(name), '_', '-') = ? LIMIT 1"
            ),
            &[text(workspace), text(ecosystem), text(folded)],
        )?
        .first(None)
        .await
    }

    /// Whether the workspace has a private package of the ecosystem.
    pub async fn has_private(&self, workspace: &str, ecosystem: &str) -> Result<bool> {
        let row: Option<serde_json::Value> = self
            .prepare(
                "SELECT 1 AS private FROM packages WHERE workspace = ? AND ecosystem = ? AND visibility = 'private' AND workspace_deleted_at IS NULL LIMIT 1",
                &[text(workspace), text(ecosystem)],
            )?
            .first(None)
            .await?;
        Ok(row.is_some())
    }

    pub async fn set_yanked(&self, version_id: &str, yanked: bool) -> Result<()> {
        self.prepare("UPDATE versions SET yanked = ? WHERE id = ?", &[num(u64::from(yanked)), text(version_id)])?
            .run()
            .await?;
        Ok(())
    }

    /// Makes a package unless one of the name is already there (a push
    /// beside this one may have made it), and answers with the one kept.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_package(
        &self,
        id: &str,
        workspace: &str,
        ecosystem: &str,
        name: &str,
        repo: Option<(&str, &str, bool)>,
        created_by: &str,
        now_ms: u64,
    ) -> Result<PackageRow> {
        let now = rfc3339(now_ms);
        let visibility = match repo {
            Some((_, _, private)) if !private => "public",
            _ => "private",
        };
        self.prepare(
            "INSERT OR IGNORE INTO packages (id, workspace, ecosystem, name, repo_id, repo_name, visibility, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                text(id),
                text(workspace),
                text(ecosystem),
                text(name),
                opt(repo.map(|r| r.0)),
                opt(repo.map(|r| r.1)),
                text(visibility),
                text(created_by),
                text(&now),
                text(&now),
            ],
        )?
        .run()
        .await?;
        self.package(workspace, ecosystem, name)
            .await?
            .ok_or_else(|| worker::Error::RustError(format!("package {workspace}/{name} was not made")))
    }

    /// A workspace's packages with their counts, newest first.
    pub async fn list(
        &self,
        workspace: &str,
        ecosystem: Option<&str>,
        repo_id: Option<&str>,
        query: Option<&str>,
        limit: u32,
    ) -> Result<Vec<ListedRow>> {
        let mut sql = format!(
            "SELECT {}, \
               (SELECT COUNT(*) FROM versions v WHERE v.package_id = p.id) AS version_count, \
               (SELECT COALESCE(SUM(b.size), 0) FROM blobs b WHERE b.digest IN \
                  (SELECT vf.digest FROM version_files vf JOIN versions v ON v.id = vf.version_id WHERE v.package_id = p.id)) AS bytes, \
               (SELECT t.tag FROM tags t WHERE t.package_id = p.id ORDER BY t.tag = 'latest' DESC, t.updated_at DESC LIMIT 1) AS latest_tag, \
               (SELECT v.version FROM tags t JOIN versions v ON v.id = t.version_id WHERE t.package_id = p.id \
                  ORDER BY t.tag = 'latest' DESC, t.updated_at DESC LIMIT 1) AS latest_tag_version, \
               (SELECT GROUP_CONCAT(version, char(10)) FROM \
                  (SELECT v.version FROM versions v WHERE v.package_id = p.id AND v.yanked = 0 ORDER BY v.published_at DESC)) AS latest_version \
             FROM packages p WHERE p.workspace = ? AND p.workspace_deleted_at IS NULL",
            PACKAGE_COLUMNS.split(", ").map(|c| format!("p.{c}")).collect::<Vec<_>>().join(", ")
        );
        let mut values = vec![text(workspace)];
        if let Some(ecosystem) = ecosystem {
            sql.push_str(" AND p.ecosystem = ?");
            values.push(text(ecosystem));
        }
        if let Some(repo_id) = repo_id {
            sql.push_str(" AND p.repo_id = ?");
            values.push(text(repo_id));
        }
        if let Some(query) = query.map(str::trim).filter(|q| !q.is_empty()) {
            sql.push_str(" AND p.name LIKE ? ESCAPE '\\'");
            let escaped = query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            values.push(text(&format!("%{}%", escaped.to_lowercase())));
        }
        sql.push_str(&format!(" ORDER BY p.updated_at DESC LIMIT {limit}"));
        self.prepare(&sql, &values)?.all().await?.results()
    }

    pub async fn set_visibility(&self, package_id: &str, visibility: &str, now_ms: u64) -> Result<()> {
        self.prepare(
            "UPDATE packages SET visibility = ?, updated_at = ? WHERE id = ?",
            &[text(visibility), text(&rfc3339(now_ms)), text(package_id)],
        )?
        .run()
        .await?;
        Ok(())
    }

    pub async fn set_link(&self, package_id: &str, repo: Option<(&str, &str)>, visibility: &str, now_ms: u64) -> Result<()> {
        self.prepare(
            "UPDATE packages SET repo_id = ?, repo_name = ?, visibility = ?, updated_at = ? WHERE id = ?",
            &[opt(repo.map(|r| r.0)), opt(repo.map(|r| r.1)), text(visibility), text(&rfc3339(now_ms)), text(package_id)],
        )?
        .run()
        .await?;
        Ok(())
    }

    pub async fn add_downloads(&self, counts: &[(String, u64)]) -> Result<()> {
        if counts.is_empty() {
            return Ok(());
        }
        let mut batch = Vec::with_capacity(counts.len());
        for (id, count) in counts {
            batch.push(self.prepare("UPDATE packages SET downloads = downloads + ? WHERE id = ?", &[num(*count), text(id)])?);
        }
        self.db.batch(batch).await?;
        Ok(())
    }

    /// A package and everything it holds. Its blobs are left to the sweep.
    pub async fn delete_package(&self, package_id: &str) -> Result<()> {
        let id = [text(package_id)];
        self.db
            .batch(vec![
                self.prepare("DELETE FROM tags WHERE package_id = ?", &id)?,
                self.prepare("DELETE FROM version_files WHERE version_id IN (SELECT id FROM versions WHERE package_id = ?)", &id)?,
                self.prepare("DELETE FROM versions WHERE package_id = ?", &id)?,
                self.prepare("DELETE FROM package_blobs WHERE package_id = ?", &id)?,
                self.prepare("DELETE FROM uploads WHERE package_id = ?", &id)?,
                self.prepare("DELETE FROM packages WHERE id = ?", &id)?,
            ])
            .await?;
        Ok(())
    }

    pub async fn blob(&self, digest: &Digest) -> Result<Option<BlobRow>> {
        self.prepare("SELECT digest, size, media_type, object_key FROM blobs WHERE digest = ?", &[text(digest.as_str())])?
            .first(None)
            .await
    }

    /// The blob, if this package may serve it.
    pub async fn package_blob(&self, package_id: &str, digest: &Digest) -> Result<Option<BlobRow>> {
        self.prepare(
            "SELECT b.digest, b.size, b.media_type, b.object_key FROM package_blobs pb JOIN blobs b ON b.digest = pb.digest
             WHERE pb.package_id = ? AND pb.digest = ?",
            &[text(package_id), text(digest.as_str())],
        )?
        .first(None)
        .await
    }

    /// Records a stored blob, or where it is now, and lets the package
    /// serve it. Either way the blob is marked as just used.
    pub async fn keep_blob(&self, package_id: &str, digest: &Digest, size: u64, media_type: Option<&str>, key: &str, now_ms: u64) -> Result<()> {
        let now = rfc3339(now_ms);
        self.db
            .batch(vec![
                self.prepare(
                    "INSERT INTO blobs (digest, size, media_type, object_key, created_at, touched_at) VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT (digest) DO UPDATE SET object_key = excluded.object_key, size = excluded.size",
                    &[text(digest.as_str()), num(size), opt(media_type), text(key), text(&now), text(&now)],
                )?,
                self.prepare("UPDATE blobs SET touched_at = ? WHERE digest = ?", &[text(&now), text(digest.as_str())])?,
                self.prepare(
                    "INSERT OR IGNORE INTO package_blobs (package_id, digest, created_at) VALUES (?, ?, ?)",
                    &[text(package_id), text(digest.as_str()), text(&now)],
                )?,
            ])
            .await?;
        Ok(())
    }

    /// Lets the package serve a blob that is already stored.
    pub async fn link_blob(&self, package_id: &str, digest: &Digest, now_ms: u64) -> Result<()> {
        let now = rfc3339(now_ms);
        self.db
            .batch(vec![
                self.prepare("UPDATE blobs SET touched_at = ? WHERE digest = ?", &[text(&now), text(digest.as_str())])?,
                self.prepare(
                    "INSERT OR IGNORE INTO package_blobs (package_id, digest, created_at) VALUES (?, ?, ?)",
                    &[text(package_id), text(digest.as_str()), text(&now)],
                )?,
            ])
            .await?;
        Ok(())
    }

    /// Whether any version of the package names the blob.
    pub async fn blob_in_use(&self, package_id: &str, digest: &Digest) -> Result<bool> {
        let row: Option<serde_json::Value> = self
            .prepare(
                "SELECT 1 AS used FROM version_files vf JOIN versions v ON v.id = vf.version_id WHERE v.package_id = ? AND vf.digest = ? LIMIT 1",
                &[text(package_id), text(digest.as_str())],
            )?
            .first(None)
            .await?;
        Ok(row.is_some())
    }

    pub async fn unlink_blob(&self, package_id: &str, digest: &Digest) -> Result<()> {
        self.prepare("DELETE FROM package_blobs WHERE package_id = ? AND digest = ?", &[text(package_id), text(digest.as_str())])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn create_upload(&self, row: &UploadRow, now_ms: u64) -> Result<()> {
        self.prepare(
            "INSERT INTO uploads (id, workspace, package_id, package, parts, \"offset\", tail, hash_state, created_at, expires_at)
             VALUES (?, ?, ?, ?, '[]', 0, 0, ?, ?, ?)",
            &[
                text(&row.id),
                text(&row.workspace),
                text(&row.package_id),
                text(&row.package),
                text(&row.hash_state),
                text(&rfc3339(now_ms)),
                text(&rfc3339(now_ms + DAY_MS)),
            ],
        )?
        .run()
        .await?;
        Ok(())
    }

    pub async fn upload(&self, id: &str) -> Result<Option<UploadRow>> {
        self.prepare(
            "SELECT id, workspace, package_id, package, multipart_id, parts, \"offset\" AS offset, tail, hash_state FROM uploads WHERE id = ?",
            &[text(id)],
        )?
        .first(None)
        .await
    }

    pub async fn save_progress(&self, progress: &Progress, now_ms: u64) -> Result<()> {
        self.prepare(
            "UPDATE uploads SET multipart_id = ?, parts = ?, \"offset\" = ?, tail = ?, hash_state = ?, expires_at = ? WHERE id = ?",
            &[
                opt(progress.multipart_id.as_deref()),
                text(&serde_json::to_string(&progress.parts)?),
                num(progress.offset),
                num(progress.tail),
                text(&progress.hasher.save()),
                text(&rfc3339(now_ms + DAY_MS)),
                text(&progress.id),
            ],
        )?
        .run()
        .await?;
        Ok(())
    }

    pub async fn delete_upload(&self, id: &str) -> Result<()> {
        self.prepare("DELETE FROM uploads WHERE id = ?", &[text(id)])?.run().await?;
        Ok(())
    }

    pub async fn expired_uploads(&self, now_ms: u64, limit: u32) -> Result<Vec<UploadRow>> {
        self.prepare(
            &format!(
                "SELECT id, workspace, package_id, package, multipart_id, parts, \"offset\" AS offset, tail, hash_state
                 FROM uploads WHERE expires_at < ? ORDER BY expires_at LIMIT {limit}"
            ),
            &[text(&rfc3339(now_ms))],
        )?
        .all()
        .await?
        .results()
    }

    pub async fn version_by_digest(&self, package_id: &str, digest: &str) -> Result<Option<VersionRow>> {
        self.prepare(
            &format!("SELECT {VERSION_COLUMNS} FROM versions WHERE package_id = ? AND digest = ? LIMIT 1"),
            &[text(package_id), text(digest)],
        )?
        .first(None)
        .await
    }

    pub async fn version_by_tag(&self, package_id: &str, tag: &str) -> Result<Option<VersionRow>> {
        self.prepare(
            &format!(
                "SELECT {} FROM tags t JOIN versions v ON v.id = t.version_id WHERE t.package_id = ? AND t.tag = ?",
                VERSION_COLUMNS.split(", ").map(|c| format!("v.{c}")).collect::<Vec<_>>().join(", ")
            ),
            &[text(package_id), text(tag)],
        )?
        .first(None)
        .await
    }

    /// A version by its version, digest, or a tag that points to it.
    pub async fn find_version(&self, package_id: &str, reference: &str) -> Result<Option<VersionRow>> {
        if let Some(found) = self.version_by_digest(package_id, reference).await? {
            return Ok(Some(found));
        }
        let by_version: Option<VersionRow> = self
            .prepare(
                &format!("SELECT {VERSION_COLUMNS} FROM versions WHERE package_id = ? AND version = ?"),
                &[text(package_id), text(reference)],
            )?
            .first(None)
            .await?;
        if by_version.is_some() {
            return Ok(by_version);
        }
        self.version_by_tag(package_id, reference).await
    }

    pub async fn versions(&self, package_id: &str, limit: u32) -> Result<Vec<VersionRow>> {
        self.prepare(
            &format!("SELECT {VERSION_COLUMNS} FROM versions WHERE package_id = ? ORDER BY published_at DESC, id DESC LIMIT {limit}"),
            &[text(package_id)],
        )?
        .all()
        .await?
        .results()
    }

    /// Records a version unless one of its digest is there, moves `tag` to
    /// it, and says whether anything was published: a new version, or a
    /// tag that now points somewhere else.
    pub async fn publish(&self, version: NewVersion, tag: Option<&str>, now_ms: u64) -> Result<(VersionRow, bool)> {
        let now = rfc3339(now_ms);
        let existing = self.version_by_digest(&version.package_id, &version.digest).await?;
        let mut changed = existing.is_none();
        let mut batch = Vec::new();
        let version_id = match &existing {
            Some(row) => row.id.clone(),
            None => {
                batch.push(self.prepare(
                    "INSERT INTO versions (id, package_id, version, digest, size, metadata, subject, published_by, published_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    &[
                        text(&version.id),
                        text(&version.package_id),
                        text(&version.version),
                        text(&version.digest),
                        num(version.size),
                        text(&version.metadata),
                        opt(version.subject.as_deref()),
                        opt(version.published_by.as_deref()),
                        text(&now),
                    ],
                )?);
                for file in &version.files {
                    batch.push(self.prepare(
                        "INSERT OR IGNORE INTO version_files (version_id, name, digest, size, media_type) VALUES (?, ?, ?, ?, ?)",
                        &[text(&version.id), text(&file.name), text(&file.digest), num(file.size), opt(file.media_type.as_deref())],
                    )?);
                }
                version.id.clone()
            }
        };
        if let Some(tag) = tag {
            let before = self.version_by_tag(&version.package_id, tag).await?;
            changed |= before.map(|row| row.id) != Some(version_id.clone());
            batch.push(self.prepare(
                "INSERT INTO tags (package_id, tag, version_id, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (package_id, tag) DO UPDATE SET version_id = excluded.version_id, updated_at = excluded.updated_at",
                &[text(&version.package_id), text(tag), text(&version_id), text(&now)],
            )?);
        }
        if changed {
            batch.push(self.prepare("UPDATE packages SET updated_at = ? WHERE id = ?", &[text(&now), text(&version.package_id)])?);
        }
        if !batch.is_empty() {
            self.db.batch(batch).await?;
        }
        let row = self
            .version_by_digest(&version.package_id, &version.digest)
            .await?
            .ok_or_else(|| worker::Error::RustError("the version was not recorded".into()))?;
        Ok((row, changed))
    }

    pub async fn tags(&self, package_id: &str) -> Result<Vec<TagRow>> {
        self.prepare(
            "SELECT t.tag, t.version_id, v.digest, t.updated_at FROM tags t JOIN versions v ON v.id = t.version_id
             WHERE t.package_id = ? ORDER BY t.tag",
            &[text(package_id)],
        )?
        .all()
        .await?
        .results()
    }

    /// Tag names in order, `n` of them after `last`.
    pub async fn tag_names(&self, package_id: &str, last: Option<&str>, n: u32) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Name {
            tag: String,
        }
        let rows: Vec<Name> = self
            .prepare(
                &format!("SELECT tag FROM tags WHERE package_id = ? AND tag > ? ORDER BY tag LIMIT {n}"),
                &[text(package_id), text(last.unwrap_or(""))],
            )?
            .all()
            .await?
            .results()?;
        Ok(rows.into_iter().map(|row| row.tag).collect())
    }

    pub async fn referrers(&self, package_id: &str, subject: &str) -> Result<Vec<VersionRow>> {
        self.prepare(
            &format!("SELECT {VERSION_COLUMNS} FROM versions WHERE package_id = ? AND subject = ? ORDER BY published_at"),
            &[text(package_id), text(subject)],
        )?
        .all()
        .await?
        .results()
    }

    /// The package of an ecosystem built from a repository (Composer's).
    pub async fn package_for_repo(&self, repo_id: &str, ecosystem: &str) -> Result<Option<PackageRow>> {
        self.prepare(
            &format!("SELECT {PACKAGE_COLUMNS} FROM packages WHERE repo_id = ? AND ecosystem = ? LIMIT 1"),
            &[text(repo_id), text(ecosystem)],
        )?
        .first(None)
        .await
    }

    pub async fn rename_package(&self, package_id: &str, name: &str, now_ms: u64) -> Result<()> {
        self.prepare(
            "UPDATE packages SET name = ?, updated_at = ? WHERE id = ?",
            &[text(name), text(&rfc3339(now_ms)), text(package_id)],
        )?
        .run()
        .await?;
        Ok(())
    }

    /// Records a version, in place of one of the same version string
    /// (a tag or branch that moved): its files and tags go with the old one.
    pub async fn replace_version(&self, version: &NewVersion, now_ms: u64) -> Result<()> {
        let now = rfc3339(now_ms);
        let old = [text(&version.package_id), text(&version.version)];
        let old_ids = "SELECT id FROM versions WHERE package_id = ? AND version = ?";
        let mut batch = vec![
            self.prepare(&format!("DELETE FROM tags WHERE version_id IN ({old_ids})"), &old)?,
            self.prepare(&format!("DELETE FROM version_files WHERE version_id IN ({old_ids})"), &old)?,
            self.prepare("DELETE FROM versions WHERE package_id = ? AND version = ?", &old)?,
            self.prepare(
                "INSERT INTO versions (id, package_id, version, digest, size, metadata, subject, published_by, published_at)
                 VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
                &[
                    text(&version.id),
                    text(&version.package_id),
                    text(&version.version),
                    text(&version.digest),
                    num(version.size),
                    text(&version.metadata),
                    opt(version.published_by.as_deref()),
                    text(&now),
                ],
            )?,
        ];
        for file in &version.files {
            batch.push(self.prepare(
                "INSERT OR IGNORE INTO version_files (version_id, name, digest, size, media_type) VALUES (?, ?, ?, ?, ?)",
                &[text(&version.id), text(&file.name), text(&file.digest), num(file.size), opt(file.media_type.as_deref())],
            )?);
        }
        batch.push(self.prepare("UPDATE packages SET updated_at = ? WHERE id = ?", &[text(&now), text(&version.package_id)])?);
        self.db.batch(batch).await?;
        Ok(())
    }

    /// The zip already made of a commit of the package, if one was.
    pub async fn dist_for_commit(&self, package_id: &str, commit: &str) -> Result<Option<BlobRow>> {
        self.prepare(
            "SELECT b.digest, b.size, b.media_type, b.object_key FROM versions v
             JOIN version_files vf ON vf.version_id = v.id AND vf.name = 'dist'
             JOIN blobs b ON b.digest = vf.digest
             WHERE v.package_id = ? AND v.digest = ? LIMIT 1",
            &[text(package_id), text(commit)],
        )?
        .first(None)
        .await
    }

    /// Records the zip of a commit as a file of every version at it.
    pub async fn add_dist(&self, package_id: &str, commit: &str, digest: &Digest, size: u64) -> Result<()> {
        let at = [text(package_id), text(commit)];
        self.db
            .batch(vec![
                self.prepare(
                    "INSERT OR IGNORE INTO version_files (version_id, name, digest, size, media_type)
                     SELECT id, 'dist', ?, ?, 'application/zip' FROM versions WHERE package_id = ? AND digest = ?",
                    &[text(digest.as_str()), num(size), text(package_id), text(commit)],
                )?,
                self.prepare("UPDATE versions SET size = ? WHERE package_id = ? AND digest = ?", &[num(size), at[0].clone(), at[1].clone()])?,
            ])
            .await?;
        Ok(())
    }

    /// Where the Composer backfill is: the last repository done, and
    /// whether it went through them all.
    pub async fn backfill(&self) -> Result<(Option<String>, bool)> {
        #[derive(Deserialize)]
        struct Row {
            after: Option<String>,
            finished_at: Option<String>,
        }
        let row: Option<Row> = self
            .prepare("SELECT after, finished_at FROM composer_backfill WHERE key = 'repos'", &[])?
            .first(None)
            .await?;
        Ok(row.map_or((None, false), |row| (row.after, row.finished_at.is_some())))
    }

    pub async fn set_backfill(&self, after: Option<&str>, finished: bool, now_ms: u64) -> Result<()> {
        self.prepare(
            "INSERT INTO composer_backfill (key, after, finished_at) VALUES ('repos', ?, ?)
             ON CONFLICT (key) DO UPDATE SET after = excluded.after, finished_at = excluded.finished_at",
            &[opt(after), if finished { text(&rfc3339(now_ms)) } else { JsValue::NULL }],
        )?
        .run()
        .await?;
        Ok(())
    }

    /// Points `tag` at a version, made or moved.
    pub async fn set_tag(&self, package_id: &str, tag: &str, version_id: &str, now_ms: u64) -> Result<()> {
        self.prepare(
            "INSERT INTO tags (package_id, tag, version_id, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (package_id, tag) DO UPDATE SET version_id = excluded.version_id, updated_at = excluded.updated_at",
            &[text(package_id), text(tag), text(version_id), text(&rfc3339(now_ms))],
        )?
        .run()
        .await?;
        Ok(())
    }

    /// A version by its version string alone.
    pub async fn version_named(&self, package_id: &str, version: &str) -> Result<Option<VersionRow>> {
        self.prepare(
            &format!("SELECT {VERSION_COLUMNS} FROM versions WHERE package_id = ? AND version = ?"),
            &[text(package_id), text(version)],
        )?
        .first(None)
        .await
    }

    pub async fn set_deprecated(&self, version_id: &str, message: Option<&str>) -> Result<()> {
        self.prepare("UPDATE versions SET deprecated = ? WHERE id = ?", &[opt(message), text(version_id)])?
            .run()
            .await?;
        Ok(())
    }

    /// The README shown for the package, kept as a blob, and its description.
    pub async fn set_readme(&self, package_id: &str, digest: Option<&str>, description: Option<&str>, now_ms: u64) -> Result<()> {
        self.prepare(
            "UPDATE packages SET readme_digest = ?, description = ?, updated_at = ? WHERE id = ?",
            &[opt(digest), opt(description), text(&rfc3339(now_ms)), text(package_id)],
        )?
        .run()
        .await?;
        Ok(())
    }

    pub async fn readme_digest(&self, package_id: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Readme {
            readme_digest: Option<String>,
        }
        let row: Option<Readme> = self
            .prepare("SELECT readme_digest FROM packages WHERE id = ?", &[text(package_id)])?
            .first(None)
            .await?;
        Ok(row.and_then(|r| r.readme_digest))
    }

    pub async fn touch_package(&self, package_id: &str, now_ms: u64) -> Result<()> {
        self.prepare("UPDATE packages SET updated_at = ? WHERE id = ?", &[text(&rfc3339(now_ms)), text(package_id)])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn delete_tag(&self, package_id: &str, tag: &str) -> Result<()> {
        self.prepare("DELETE FROM tags WHERE package_id = ? AND tag = ?", &[text(package_id), text(tag)])?
            .run()
            .await?;
        Ok(())
    }

    /// A version, its tags and its files. Blobs are left to the sweep.
    pub async fn delete_version(&self, version_id: &str) -> Result<()> {
        let id = [text(version_id)];
        self.db
            .batch(vec![
                self.prepare("DELETE FROM tags WHERE version_id = ?", &id)?,
                self.prepare("DELETE FROM version_files WHERE version_id = ?", &id)?,
                self.prepare("DELETE FROM versions WHERE id = ?", &id)?,
            ])
            .await?;
        Ok(())
    }

    /// Works out again what the workspace stores: each blob its versions
    /// use, once, public when any public package uses it.
    pub async fn measure(&self, workspace: &str) -> Result<()> {
        let ws = [text(workspace)];
        self.db
            .batch(vec![
                self.prepare("DELETE FROM workspace_blobs WHERE workspace = ?", &ws)?,
                self.prepare(
                    "INSERT INTO workspace_blobs (workspace, digest, size, public)
                     SELECT p.workspace, vf.digest, MAX(vf.size), MAX(p.visibility = 'public')
                     FROM version_files vf JOIN versions v ON v.id = vf.version_id JOIN packages p ON p.id = v.package_id
                     WHERE p.workspace = ? GROUP BY vf.digest",
                    &ws,
                )?,
            ])
            .await?;
        Ok(())
    }

    pub async fn storage(&self, workspace: &str) -> Result<(u64, u64)> {
        #[derive(Deserialize)]
        struct Sums {
            public_bytes: Option<u64>,
            private_bytes: Option<u64>,
        }
        let sums: Option<Sums> = self
            .prepare(
                &format!(
                    "SELECT SUM(CASE WHEN public = 1 THEN size ELSE 0 END) AS public_bytes,
                            SUM(CASE WHEN public = 1 THEN 0 ELSE size END) AS private_bytes
                     FROM workspace_blobs WHERE workspace = ? AND workspace NOT IN ({DELETED_WORKSPACES})"
                ),
                &[text(workspace)],
            )?
            .first(None)
            .await?;
        Ok(sums.map_or((0, 0), |s| (s.public_bytes.unwrap_or(0), s.private_bytes.unwrap_or(0))))
    }

    /// Hides (`deleted_at` given) or shows again (`None`) a workspace's
    /// packages. Hiding keeps a mark already set; showing clears only marks.
    pub async fn mark_workspace(&self, workspace: &str, deleted_at: Option<&str>) -> Result<()> {
        let statement = match deleted_at {
            Some(at) => self.prepare(
                "UPDATE packages SET workspace_deleted_at = ? WHERE workspace = ? AND workspace_deleted_at IS NULL",
                &[text(at), text(workspace)],
            )?,
            None => self.prepare(
                "UPDATE packages SET workspace_deleted_at = NULL WHERE workspace = ? AND workspace_deleted_at IS NOT NULL",
                &[text(workspace)],
            )?,
        };
        statement.run().await?;
        Ok(())
    }

    /// Whether the workspace is deleted, as its packages say.
    pub async fn workspace_hidden(&self, workspace: &str) -> Result<bool> {
        let row: Option<serde_json::Value> = self
            .prepare("SELECT 1 AS hidden FROM packages WHERE workspace = ? AND workspace_deleted_at IS NOT NULL LIMIT 1", &[text(workspace)])?
            .first(None)
            .await?;
        Ok(row.is_some())
    }

    /// Every workspace's package storage, by workspace.
    pub async fn storage_all(&self) -> Result<Vec<g1t_contracts::packages::WorkspacePackageStorage>> {
        self.prepare(
            &format!(
                "SELECT workspace,
                        COALESCE(SUM(CASE WHEN public = 1 THEN size ELSE 0 END), 0) AS public_bytes,
                        COALESCE(SUM(CASE WHEN public = 1 THEN 0 ELSE size END), 0) AS private_bytes
                 FROM workspace_blobs WHERE workspace NOT IN ({DELETED_WORKSPACES}) GROUP BY workspace ORDER BY workspace"
            ),
            &[],
        )?
        .all()
        .await?
        .results()
    }

    /// Which of `digests` the workspace already holds.
    pub async fn held(&self, workspace: &str, digests: &[String]) -> Result<std::collections::HashSet<String>> {
        #[derive(Deserialize)]
        struct Held {
            digest: String,
        }
        let mut held = std::collections::HashSet::new();
        for chunk in digests.chunks(50) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let mut values = vec![text(workspace)];
            values.extend(chunk.iter().map(|d| text(d)));
            let rows: Vec<Held> = self
                .prepare(&format!("SELECT digest FROM workspace_blobs WHERE workspace = ? AND digest IN ({marks})"), &values)?
                .all()
                .await?
                .results()?;
            held.extend(rows.into_iter().map(|row| row.digest));
        }
        Ok(held)
    }

    /// Blobs no version uses and nothing has touched for a day.
    pub async fn unused_blobs(&self, now_ms: u64, limit: u32) -> Result<Vec<BlobRow>> {
        self.prepare(
            &format!(
                "SELECT digest, size, media_type, object_key FROM blobs b
                 WHERE touched_at < ? AND NOT EXISTS (SELECT 1 FROM version_files vf WHERE vf.digest = b.digest)
                   AND NOT EXISTS (SELECT 1 FROM packages p WHERE p.readme_digest = b.digest)
                 ORDER BY touched_at LIMIT {limit}"
            ),
            &[text(&rfc3339(now_ms.saturating_sub(DAY_MS)))],
        )?
        .all()
        .await?
        .results()
    }

    /// A version by its version string, made from `version` when there is
    /// none, and whether it was made now. Files are added one at a time
    /// with `put_file` (Maven uploads each in a request of its own).
    pub async fn version_or_new(&self, version: &NewVersion, now_ms: u64) -> Result<(VersionRow, bool)> {
        self.prepare(
            "INSERT OR IGNORE INTO versions (id, package_id, version, digest, size, metadata, subject, published_by, published_at)
             VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)",
            &[
                text(&version.id),
                text(&version.package_id),
                text(&version.version),
                text(&version.digest),
                text(&version.metadata),
                opt(version.published_by.as_deref()),
                text(&rfc3339(now_ms)),
            ],
        )?
        .run()
        .await?;
        let row = self
            .version_named(&version.package_id, &version.version)
            .await?
            .ok_or_else(|| worker::Error::RustError("the version was not recorded".into()))?;
        let made = row.id == version.id;
        Ok((row, made))
    }

    /// Adds a file to a version, or replaces the one of its name, and
    /// works out the version's size again.
    pub async fn put_file(&self, package_id: &str, version_id: &str, file: &NewFile, now_ms: u64) -> Result<()> {
        let now = rfc3339(now_ms);
        self.db
            .batch(vec![
                self.prepare(
                    "INSERT INTO version_files (version_id, name, digest, size, media_type) VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT (version_id, name) DO UPDATE SET digest = excluded.digest, size = excluded.size, media_type = excluded.media_type",
                    &[text(version_id), text(&file.name), text(&file.digest), num(file.size), opt(file.media_type.as_deref())],
                )?,
                self.prepare(
                    "UPDATE versions SET size = (SELECT COALESCE(SUM(size), 0) FROM version_files WHERE version_id = ?) WHERE id = ?",
                    &[text(version_id), text(version_id)],
                )?,
                self.prepare("UPDATE packages SET updated_at = ? WHERE id = ?", &[text(&now), text(package_id)])?,
            ])
            .await?;
        Ok(())
    }

    /// A version's files, by name.
    pub async fn files(&self, version_id: &str) -> Result<Vec<FileRow>> {
        self.prepare("SELECT name, digest, size, media_type FROM version_files WHERE version_id = ? ORDER BY name", &[text(version_id)])?
            .all()
            .await?
            .results()
    }

    pub async fn file(&self, version_id: &str, name: &str) -> Result<Option<FileRow>> {
        self.prepare(
            "SELECT name, digest, size, media_type FROM version_files WHERE version_id = ? AND name = ?",
            &[text(version_id), text(name)],
        )?
        .first(None)
        .await
    }

    /// Changes what a version is named by and keeps about itself.
    pub async fn set_version(&self, version_id: &str, digest: &str, metadata: &str) -> Result<()> {
        self.prepare("UPDATE versions SET digest = ?, metadata = ? WHERE id = ?", &[text(digest), text(metadata), text(version_id)])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn set_checksums(&self, digest: &Digest, sums: &Checksums) -> Result<()> {
        self.prepare(
            "INSERT OR IGNORE INTO checksums (digest, md5, sha1, sha512) VALUES (?, ?, ?, ?)",
            &[text(digest.as_str()), text(&sums.md5), text(&sums.sha1), text(&sums.sha512)],
        )?
        .run()
        .await?;
        Ok(())
    }

    pub async fn checksums(&self, digest: &Digest) -> Result<Option<Checksums>> {
        self.prepare("SELECT md5, sha1, sha512 FROM checksums WHERE digest = ?", &[text(digest.as_str())])?
            .first(None)
            .await
    }

    /// Every version of a workspace's packages of an ecosystem, oldest
    /// first: what an index of the whole registry is made from.
    pub async fn ecosystem_versions(&self, workspace: &str, ecosystem: &str, limit: u32) -> Result<Vec<VersionRow>> {
        self.prepare(
            &format!(
                "SELECT {} FROM versions v JOIN packages p ON p.id = v.package_id
                 WHERE p.workspace = ? AND p.ecosystem = ? AND p.workspace_deleted_at IS NULL
                 ORDER BY v.published_at, v.id LIMIT {limit}",
                VERSION_COLUMNS.split(", ").map(|c| format!("v.{c}")).collect::<Vec<_>>().join(", ")
            ),
            &[text(workspace), text(ecosystem)],
        )?
        .all()
        .await?
        .results()
    }

    /// A workspace's packages of an ecosystem, by name.
    pub async fn packages_of(&self, workspace: &str, ecosystem: &str, limit: u32) -> Result<Vec<PackageRow>> {
        self.prepare(
            &format!(
                "SELECT {PACKAGE_COLUMNS} FROM packages WHERE workspace = ? AND ecosystem = ? AND workspace_deleted_at IS NULL ORDER BY name LIMIT {limit}"
            ),
            &[text(workspace), text(ecosystem)],
        )?
        .all()
        .await?
        .results()
    }

    /// A workspace's Maven artifacts of one groupId (`com.acme:*`), by
    /// name: those named from `com.acme:` up to `com.acme;`, the
    /// character after `:`.
    pub async fn maven_group(&self, workspace: &str, group: &str, limit: u32) -> Result<Vec<PackageRow>> {
        self.prepare(
            &format!(
                "SELECT {PACKAGE_COLUMNS} FROM packages WHERE workspace = ? AND ecosystem = 'maven' AND name >= ? AND name < ?
                 AND workspace_deleted_at IS NULL ORDER BY name LIMIT {limit}"
            ),
            &[text(workspace), text(&format!("{group}:")), text(&format!("{group};"))],
        )?
        .all()
        .await?
        .results()
    }

    pub async fn forget_blob(&self, digest: &str) -> Result<()> {
        let d = [text(digest)];
        self.db
            .batch(vec![
                self.prepare("DELETE FROM checksums WHERE digest = ?", &d)?,
                self.prepare("DELETE FROM package_blobs WHERE digest = ?", &d)?,
                self.prepare("DELETE FROM workspace_blobs WHERE digest = ?", &d)?,
                self.prepare("DELETE FROM blobs WHERE digest = ?", &d)?,
            ])
            .await?;
        Ok(())
    }

    /// Workspaces with packages linked to the repository.
    pub async fn workspaces_linked_to(&self, repo_id: &str) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Ws {
            workspace: String,
        }
        let rows: Vec<Ws> = self
            .prepare("SELECT DISTINCT workspace FROM packages WHERE repo_id = ?", &[text(repo_id)])?
            .all()
            .await?
            .results()?;
        Ok(rows.into_iter().map(|row| row.workspace).collect())
    }

    pub async fn follow_visibility(&self, repo_id: &str, private: bool) -> Result<()> {
        self.prepare(
            "UPDATE packages SET visibility = ? WHERE repo_id = ?",
            &[text(if private { "private" } else { "public" }), text(repo_id)],
        )?
        .run()
        .await?;
        Ok(())
    }
}
