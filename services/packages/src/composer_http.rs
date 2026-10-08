//! The Composer registry: `g1t.sh/-/composer/<workspace>/`, one per
//! workspace, built from its repositories (composer.rs says how).
//!
//! ```sh
//! composer config repositories.acme composer https://g1t.sh/-/composer/acme/
//! composer config --global --auth http-basic.g1t.sh <you> <g1t token>
//! composer require acme/lib
//! ```
//!
//! Nothing is uploaded. A repository's versions are read again when it is
//! pushed to (`git.push`), restored, renamed or moved, and once for every
//! repository by the backfill; a request only reads what that left. A zip
//! of a commit is made the first time it is asked for, and kept by its
//! digest like every file here.

use std::collections::{HashMap, HashSet};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use g1t_contracts::User;
use g1t_contracts::events::PackageEvent;
use g1t_contracts::new_id;
use g1t_contracts::repos::{
    AllIdsArgs, FileList, IdPage, ListFilesArgs, MAX_LISTED_FILES, MAX_READ_BLOBS, RawBlob, RawBlobsArgs, RawFile, RawFileArgs, RefsArgs,
    RepoRefs,
};
use g1t_kit::now_ms;
use serde_json::{Value, json};
use worker::{Context, Headers, Method, Request, Response, Result, Url};

use crate::access::Action;
use crate::composer::{self, Origin, Version};
use crate::db::{NewVersion, PackageRow};
use crate::digest::Digest;
use crate::oci::{Credentials, origin};
use crate::store::BlobStore;
use crate::{Caller, Packages};

const COMPOSER: &str = "composer";
/// The biggest `composer.json` or README read.
const MAX_FILE_BYTES: u32 = 1024 * 1024;
/// The most branches and tags a repository's package lists.
const MAX_BRANCHES: usize = 50;
const MAX_TAGS: usize = 300;
/// The most a zip may hold before it is made, in all and per file.
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ARCHIVED_FILE: u32 = 32 * 1024 * 1024;
/// Repositories the backfill reads each hour.
const BACKFILL_PAGE: u32 = 25;
const README_NAMES: [&str; 4] = ["README.md", "readme.md", "README.markdown", "README"];

fn error(status: u16, message: impl Into<String>) -> Result<Response> {
    let mut response = Response::from_json(&json!({ "status": "error", "message": message.into() }))?.with_status(status);
    if status == 401 {
        response.headers_mut().set("www-authenticate", "Basic realm=\"g1t\"")?;
    }
    Ok(response)
}

/// One of the registry's endpoints, under `/-/composer/<workspace>/`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComposerRoute {
    Root { workspace: String },
    /// `p2/<vendor>/<name>.json`, or `~dev.json` for the branches.
    Metadata { workspace: String, name: String, dev: bool },
    Dist { workspace: String, name: String, commit: String },
    Downloads { workspace: String },
}

pub fn route(path: &str) -> Option<ComposerRoute> {
    let rest = path.strip_prefix("/-/composer/")?;
    let (workspace, rest) = rest.split_once('/')?;
    let workspace = workspace.to_ascii_lowercase();
    if rest == "packages.json" || rest.is_empty() {
        return Some(ComposerRoute::Root { workspace });
    }
    if rest == "downloads" {
        return Some(ComposerRoute::Downloads { workspace });
    }
    if let Some(file) = rest.strip_prefix("p2/") {
        let (name, dev) = match file.strip_suffix("~dev.json") {
            Some(name) => (name, true),
            None => (file.strip_suffix(".json")?, false),
        };
        return composer::valid_name(name).then(|| ComposerRoute::Metadata { workspace, name: name.to_owned(), dev });
    }
    let file = rest.strip_prefix("dist/")?;
    let (name, zip) = file.rsplit_once('/')?;
    let commit = zip.strip_suffix(".zip")?;
    (composer::valid_name(name) && commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit())).then(|| ComposerRoute::Dist {
        workspace,
        name: name.to_owned(),
        commit: commit.to_ascii_lowercase(),
    })
}

/// What a version keeps of its ref, to make its entry from on each read.
fn stored_metadata(composer_json: &Value, version: &Version, git_ref: &str, default_branch: bool) -> Value {
    json!({
        "composer": composer_json,
        "version_normalized": version.normalized,
        "ref": git_ref,
        "default_branch": default_branch,
    })
}

/// The versions a repository's refs make: `(version, commit, ref, default)`.
fn wanted_versions(refs: &[g1t_contracts::repos::GitRefEntry], default_branch: &str) -> Vec<(Version, String, String, bool)> {
    let mut branches = Vec::new();
    let mut tags = Vec::new();
    for entry in refs {
        if let Some(branch) = entry.name.strip_prefix("refs/heads/") {
            branches.push((composer::branch_version(branch), entry.commit.clone(), entry.name.clone(), branch == default_branch));
        } else if let Some(tag) = entry.name.strip_prefix("refs/tags/")
            && let Some(version) = composer::tag_version(tag)
        {
            tags.push((version, entry.commit.clone(), entry.name.clone(), false));
        }
    }
    // The default branch first, then the newest tags.
    branches.sort_by_key(|(_, _, _, default)| !*default);
    branches.truncate(MAX_BRANCHES);
    tags.sort_by(|a, b| b.0.normalized.cmp(&a.0.normalized));
    tags.truncate(MAX_TAGS);
    let mut seen = HashSet::new();
    branches.into_iter().chain(tags).filter(|(v, ..)| seen.insert(v.version.clone())).collect()
}

impl Packages {
    pub async fn composer(&self, request: Request, ctx: &Context) -> Result<Response> {
        let url = request.url()?;
        let Some(route) = route(url.path()) else {
            return error(404, "There is nothing at this address.");
        };
        match self.composer_route(request, &url, route, ctx).await {
            Ok(response) => Ok(response),
            Err(problem) => {
                worker::console_error!("packages: composer {}: {problem}", url.path());
                error(500, "Something went wrong on our side. Try again in a moment.")
            }
        }
    }

    async fn composer_route(&self, mut request: Request, url: &Url, route: ComposerRoute, ctx: &Context) -> Result<Response> {
        let credentials = self.credentials(&request).await?;
        if matches!(request.method(), Method::Get | Method::Head)
            && let Some(refused) = self.limited(&request, &credentials, "http-basic credentials").await?
        {
            return Ok(refused);
        }
        let viewer = match credentials {
            Credentials::Viewer(viewer) => viewer,
            Credentials::None => None,
            Credentials::Token(_) | Credentials::Bad => {
                return error(401, "The username or token is not right. Use a g1t access token: composer config --auth http-basic.g1t.sh <you> <token>");
            }
        };
        match route {
            ComposerRoute::Root { workspace } => self.composer_root(&workspace, viewer.as_ref()).await,
            ComposerRoute::Metadata { workspace, name, dev } => self.composer_metadata(url, &workspace, &name, dev, viewer.as_ref()).await,
            ComposerRoute::Dist { workspace, name, commit } => self.composer_dist(&workspace, &name, &commit, viewer.as_ref(), ctx).await,
            ComposerRoute::Downloads { workspace } => {
                let body: Value = request.json().await.unwrap_or_default();
                let names: HashSet<&str> = body["downloads"]
                    .as_array()
                    .map(|list| list.iter().filter_map(|d| d["name"].as_str()).collect())
                    .unwrap_or_default();
                for name in names.into_iter().take(50) {
                    if let Some(package) = self.composer_package(&workspace, name).await? {
                        self.count_download(&package.id, ctx);
                    }
                }
                Ok(Response::empty()?.with_status(204))
            }
        }
    }

    async fn composer_package(&self, workspace: &str, name: &str) -> Result<Option<PackageRow>> {
        Ok(self.db.package(workspace, COMPOSER, name).await?.filter(|p| !p.hidden()))
    }

    /// The answer when `viewer` may not pull `package`, if they may not.
    async fn composer_check(&self, viewer: Option<&User>, package: &PackageRow) -> Result<Option<Result<Response>>> {
        if self.check(viewer, package, Action::Pull).await?.0.allowed {
            return Ok(None);
        }
        Ok(Some(if viewer.is_none() {
            error(401, "Sign in to install this package: composer config --auth http-basic.g1t.sh <you> <g1t token>")
        } else {
            error(404, "Not found: no such package, or you cannot see it.")
        }))
    }

    async fn composer_root(&self, workspace: &str, viewer: Option<&User>) -> Result<Response> {
        let rows = self.db.list(workspace, Some(COMPOSER), None, None, 1000).await?;
        let packages: Vec<&PackageRow> = rows.iter().map(|row| &row.package).collect();
        let may = self.may_all(viewer, &packages, Action::Pull).await?;
        let available: Vec<String> = rows
            .iter()
            .zip(may)
            .filter(|(_, may)| *may)
            .map(|(row, _)| row.package.name.clone())
            .collect();
        Response::from_json(&composer::root(workspace, &available))
    }

    async fn composer_metadata(&self, url: &Url, workspace: &str, name: &str, dev: bool, viewer: Option<&User>) -> Result<Response> {
        let Some(package) = self.composer_package(workspace, name).await? else {
            return error(404, format!("There is no package {name} in {workspace}."));
        };
        if let Some(refusal) = self.composer_check(viewer, &package).await? {
            return refusal;
        }
        let base = origin(url);
        let repo = package.repo_name.clone().unwrap_or_default();
        let git_url = format!("{base}/{}/{repo}.git", package.workspace);
        let mut entries = Vec::new();
        for row in self.db.versions(&package.id, 1000).await? {
            let meta = row.meta();
            let version = Version {
                version: row.version.clone(),
                normalized: meta["version_normalized"].as_str().unwrap_or(&row.version).to_owned(),
            };
            if version.is_dev() != dev {
                continue;
            }
            let dist_url = format!("{base}/-/composer/{}/dist/{name}/{}.zip", package.workspace, row.digest);
            let origin = Origin {
                git_url: &git_url,
                dist_url: &dist_url,
                commit: &row.digest,
                default_branch: meta["default_branch"].as_bool().unwrap_or(false),
            };
            entries.push(composer::version_entry(&meta["composer"], name, &version, &origin));
        }
        let mut response = Response::from_json(&composer::p2(name, &entries))?;
        response.headers_mut().set("last-modified", &package.updated_at)?;
        Ok(response)
    }

    async fn composer_dist(&self, workspace: &str, name: &str, commit: &str, viewer: Option<&User>, ctx: &Context) -> Result<Response> {
        let Some(package) = self.composer_package(workspace, name).await? else {
            return error(404, format!("There is no package {name} in {workspace}."));
        };
        if let Some(refusal) = self.composer_check(viewer, &package).await? {
            return refusal;
        }
        // Only the commits of its versions: a zip is never made of any
        // other commit of the repository.
        let Some(version) = self.db.version_by_digest(&package.id, commit).await? else {
            return error(404, format!("{commit} is not a version of {name}."));
        };
        let blob = match self.db.dist_for_commit(&package.id, commit).await? {
            Some(blob) => blob,
            None => match self.build_dist(&package, commit).await? {
                Ok(blob) => blob,
                Err(refusal) => return refusal,
            },
        };
        let Some(got) = self.store.get(&blob.object_key, None).await? else {
            return error(404, "The archive is missing. Try again.");
        };
        self.count_version_download(&package.id, &version.id, ctx);
        let headers = Headers::new();
        headers.set("content-type", "application/zip")?;
        headers.set("content-length", &blob.size.to_string())?;
        headers.set("cache-control", "max-age=31536000")?;
        Ok(Response::from_body(got.body)?.with_headers(headers))
    }

    /// Makes the zip of a commit: its files but those `.gitattributes`
    /// marks `export-ignore`, as `git archive` would leave them out.
    async fn build_dist(&self, package: &PackageRow, commit: &str) -> Result<std::result::Result<crate::db::BlobRow, Result<Response>>> {
        let Some(repo_id) = package.repo_id.clone() else {
            return Ok(Err(error(404, "This package has no repository.")));
        };
        let listed: FileList = g1t_kit::call(
            &self.repos,
            "list_files",
            &ListFilesArgs { repo_id: repo_id.clone(), git_ref: Some(commit.to_owned()), skip_dirs: Vec::new(), limit: MAX_LISTED_FILES },
        )
        .await?;
        if listed.truncated {
            return Ok(Err(error(507, format!("The commit has more than {MAX_LISTED_FILES} files, too many for an archive. Install from source: composer install --prefer-source"))));
        }
        let attributes = self.repo_file(&repo_id, commit, ".gitattributes").await?;
        let ignores = attributes.map(|text| composer::export_ignores(&String::from_utf8_lossy(&text))).unwrap_or_default();
        let files: Vec<(String, String)> = listed
            .files
            .into_iter()
            .filter_map(|file| Some((file.path, file.hash?)))
            .filter(|(path, _)| !composer::ignored(&ignores, path))
            .collect();
        let mut bytes_of: HashMap<String, Vec<u8>> = HashMap::new();
        let unique: Vec<String> = files.iter().map(|(_, hash)| hash.clone()).collect::<HashSet<_>>().into_iter().collect();
        let mut total = 0u64;
        for chunk in unique.chunks(MAX_READ_BLOBS) {
            let read: Vec<RawBlob> = g1t_kit::call(
                &self.repos,
                "raw_blobs",
                &RawBlobsArgs { repo_id: repo_id.clone(), hashes: chunk.to_vec(), max_bytes: MAX_ARCHIVED_FILE },
            )
            .await?;
            for blob in read {
                total += blob.size;
                if total > MAX_ARCHIVE_BYTES || (blob.data.is_none() && blob.size > 0) {
                    return Ok(Err(error(
                        507,
                        format!("The commit is too large for an archive (over {} MB). Install from source: composer install --prefer-source", MAX_ARCHIVE_BYTES / 1_048_576),
                    )));
                }
                let data = blob.data.as_deref().map(|d| STANDARD.decode(d).unwrap_or_default()).unwrap_or_default();
                bytes_of.insert(blob.hash, data);
            }
        }
        let entries: Vec<(String, Vec<u8>)> = files
            .into_iter()
            .map(|(path, hash)| {
                let data = bytes_of.get(&hash).cloned().unwrap_or_default();
                (path, data)
            })
            .collect();
        let zip = composer::zip(&entries);
        let digest = Digest::of(&zip);
        let size = zip.len() as u64;
        let now = now_ms();
        if self.db.blob(&digest).await?.is_none() {
            self.store.put(&digest.object_key(), zip).await?;
        }
        self.db.keep_blob(&package.id, &digest, size, Some("application/zip"), &digest.object_key(), now).await?;
        self.db.add_dist(&package.id, commit, &digest, size).await?;
        self.db.measure(&package.workspace).await?;
        Ok(Ok(crate::db::BlobRow { digest: digest.to_string(), size, media_type: Some("application/zip".into()), object_key: digest.object_key() }))
    }

    /// A file of a repository at a commit, if it is there and not large.
    async fn repo_file(&self, repo_id: &str, git_ref: &str, path: &str) -> Result<Option<Vec<u8>>> {
        let file: Option<RawFile> = g1t_kit::call(
            &self.repos,
            "raw_file",
            &RawFileArgs { repo_id: repo_id.to_owned(), git_ref: git_ref.to_owned(), path: path.to_owned(), max_bytes: MAX_FILE_BYTES },
        )
        .await?;
        Ok(file.and_then(|file| STANDARD.decode(file.data).ok()))
    }

    /// Reads a repository's Composer package again from its refs: makes it
    /// when its default branch gained a `composer.json`, records new and
    /// moved versions, lets go of deleted ones, and deletes the package
    /// when the repository stopped being one. Says whether it is one.
    pub(crate) async fn sync_composer(&self, repo_id: &str) -> Result<bool> {
        let found: Option<RepoRefs> = g1t_kit::call(&self.repos, "refs", &RefsArgs { repo_id: repo_id.to_owned() }).await?;
        let existing = self.db.package_for_repo(repo_id, COMPOSER).await?;
        let Some(RepoRefs { repo, refs }) = found else {
            if let Some(package) = existing {
                self.drop_composer(&package).await?;
            }
            return Ok(false);
        };
        let workspace = repo.namespace.to_lowercase();
        if self.db.workspace_hidden(&workspace).await? {
            return Ok(false);
        }
        let default = refs.iter().find(|r| r.name == format!("refs/heads/{}", repo.default_branch)).map(|r| r.commit.clone());
        let manifest = match &default {
            Some(commit) => self.composer_json(repo_id, commit).await?,
            None => None,
        };
        let Some((name, root_manifest)) = manifest else {
            if let Some(package) = existing {
                self.drop_composer(&package).await?;
            }
            return Ok(false);
        };
        // A repository moved to another workspace takes its package along.
        let existing = match existing {
            Some(package) if package.workspace != workspace => {
                self.drop_composer(&package).await?;
                None
            }
            other => other,
        };
        let now = now_ms();
        let package = match existing {
            Some(package) if package.name == name => package,
            Some(package) => {
                if self.db.package(&workspace, COMPOSER, &name).await?.is_some() {
                    worker::console_error!("packages: {workspace}/{} names {name}, which another repository has", repo.name);
                    package
                } else {
                    self.db.rename_package(&package.id, &name, now).await?;
                    PackageRow { name: name.clone(), ..package }
                }
            }
            None => {
                if let Some(other) = self.db.package(&workspace, COMPOSER, &name).await?
                    && other.repo_id.as_deref() != Some(repo_id)
                {
                    worker::console_error!("packages: {workspace}/{} names {name}, which another repository has", repo.name);
                    return Ok(false);
                }
                self.db
                    .create_package(&new_id("pkg", now), &workspace, COMPOSER, &name, Some((&repo.id, &repo.name, repo.is_private)), "g1t", now)
                    .await?
            }
        };

        // Versions follow git, so g1t records them: what made them is the
        // push, already in the log as `git.push`.
        let caller = Caller::system();
        let wanted = wanted_versions(&refs, &repo.default_branch);
        let stored = self.db.versions(&package.id, 1000).await?;
        let mut manifests: HashMap<String, Option<Value>> = HashMap::new();
        if let Some(commit) = &default {
            manifests.insert(commit.clone(), Some(root_manifest.clone()));
        }
        let mut changed = false;
        for (version, commit, git_ref, is_default) in &wanted {
            let current = stored.iter().find(|row| row.version == version.version);
            if let Some(row) = current
                && row.digest == *commit
                && row.meta()["default_branch"].as_bool().unwrap_or(false) == *is_default
            {
                continue;
            }
            if !manifests.contains_key(commit) {
                let read = self.composer_json(repo_id, commit).await?.map(|(_, json)| json);
                manifests.insert(commit.clone(), read);
            }
            // A ref without a composer.json of its own is not a version.
            let Some(Some(json)) = manifests.get(commit) else { continue };
            self.db
                .replace_version(
                    &NewVersion {
                        id: new_id("ver", now),
                        package_id: package.id.clone(),
                        version: version.version.clone(),
                        digest: commit.clone(),
                        size: 0,
                        metadata: stored_metadata(json, version, git_ref, *is_default).to_string(),
                        subject: None,
                        published_by: None,
                        files: Vec::new(),
                    },
                    now,
                )
                .await?;
            changed = true;
            if current.is_none() {
                let event = PackageEvent { version: Some(version.version.clone()), digest: Some(commit.clone()), ..self.event_of(&package) };
                self.announce("package.published", &package, event, &caller).await;
                self.audit(&caller, "package.publish", &package, Some(&format!("{name}@{}", version.version)), None).await;
            }
        }
        let kept: HashSet<&str> = wanted.iter().map(|(v, ..)| v.version.as_str()).collect();
        for row in stored.iter().filter(|row| !kept.contains(row.version.as_str())) {
            self.db.delete_version(&row.id).await?;
            let event = PackageEvent { version: Some(row.version.clone()), digest: Some(row.digest.clone()), ..self.event_of(&package) };
            self.announce("package.version_deleted", &package, event, &caller).await;
            self.audit(&caller, "package.delete_version", &package, Some(&format!("{}@{}", package.name, row.version)), None).await;
            changed = true;
        }
        if let Some(commit) = &default {
            self.composer_readme(&package, repo_id, commit, &root_manifest, now).await?;
        }
        if changed {
            self.db.measure(&workspace).await?;
        }
        Ok(true)
    }

    /// The package's README and description, from the default branch.
    async fn composer_readme(&self, package: &PackageRow, repo_id: &str, commit: &str, manifest: &Value, now: u64) -> Result<()> {
        let mut readme = None;
        for name in README_NAMES {
            if let Some(bytes) = self.repo_file(repo_id, commit, name).await? {
                readme = Some(bytes);
                break;
            }
        }
        let digest = match readme.filter(|b| !b.is_empty()) {
            Some(bytes) => {
                let digest = Digest::of(&bytes);
                if self.db.blob(&digest).await?.is_none() {
                    self.store.put(&digest.object_key(), bytes.clone()).await?;
                }
                self.db.keep_blob(&package.id, &digest, bytes.len() as u64, Some("text/markdown"), &digest.object_key(), now).await?;
                Some(digest.to_string())
            }
            None => None,
        };
        self.db.set_readme(&package.id, digest.as_deref(), manifest["description"].as_str(), now).await
    }

    /// A commit's `composer.json`, when it has one naming a valid package.
    async fn composer_json(&self, repo_id: &str, commit: &str) -> Result<Option<(String, Value)>> {
        let Some(bytes) = self.repo_file(repo_id, commit, "composer.json").await? else {
            return Ok(None);
        };
        let Ok(json) = serde_json::from_slice::<Value>(&bytes) else {
            return Ok(None);
        };
        let Some(name) = json["name"].as_str().map(str::to_lowercase).filter(|n| composer::valid_name(n)) else {
            return Ok(None);
        };
        Ok(Some((name, json)))
    }

    async fn drop_composer(&self, package: &PackageRow) -> Result<()> {
        self.db.delete_package(&package.id).await?;
        self.db.measure(&package.workspace).await?;
        let caller = Caller::system();
        self.announce("package.deleted", package, self.event_of(package), &caller).await;
        self.audit(&caller, "package.delete", package, Some(&package.name), None).await;
        Ok(())
    }

    /// Deletes the Composer package built from a deleted repository.
    pub(crate) async fn composer_repo_gone(&self, repo_id: &str) -> Result<()> {
        if let Some(package) = self.db.package_for_repo(repo_id, COMPOSER).await? {
            self.drop_composer(&package).await?;
        }
        Ok(())
    }

    /// Reads a page of repositories the backfill has not yet, until it has
    /// read them all once. Says how many were packages.
    pub(crate) async fn composer_backfill(&self) -> Result<u32> {
        let (after, finished) = self.db.backfill().await?;
        if finished {
            return Ok(0);
        }
        let page: IdPage = g1t_kit::call(&self.repos, "all_ids", &AllIdsArgs { after: after.clone(), limit: BACKFILL_PAGE }).await?;
        let mut found = 0;
        for id in &page.ids {
            match self.sync_composer(id).await {
                Ok(true) => found += 1,
                Ok(false) => {}
                Err(error) => worker::console_error!("packages: composer backfill of {id}: {error}"),
            }
        }
        let last = page.ids.last().cloned().or(after);
        self.db.set_backfill(last.as_deref(), page.next.is_none(), now_ms()).await?;
        Ok(found)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::repos::GitRefEntry;

    #[test]
    fn every_endpoint_is_routed() {
        let commit = "a".repeat(40);
        assert_eq!(route("/-/composer/acme/packages.json"), Some(ComposerRoute::Root { workspace: "acme".into() }));
        assert_eq!(route("/-/composer/acme/"), Some(ComposerRoute::Root { workspace: "acme".into() }));
        assert_eq!(
            route("/-/composer/acme/p2/acme/lib.json"),
            Some(ComposerRoute::Metadata { workspace: "acme".into(), name: "acme/lib".into(), dev: false })
        );
        assert_eq!(
            route("/-/composer/acme/p2/acme/lib~dev.json"),
            Some(ComposerRoute::Metadata { workspace: "acme".into(), name: "acme/lib".into(), dev: true })
        );
        assert_eq!(
            route(&format!("/-/composer/acme/dist/acme/lib/{commit}.zip")),
            Some(ComposerRoute::Dist { workspace: "acme".into(), name: "acme/lib".into(), commit: commit.clone() })
        );
        assert_eq!(route("/-/composer/acme/downloads"), Some(ComposerRoute::Downloads { workspace: "acme".into() }));
        assert_eq!(route("/-/composer/acme/p2/Acme/lib.json"), None);
        assert_eq!(route("/-/composer/acme/dist/acme/lib/short.zip"), None);
        assert_eq!(route("/-/composer/acme"), None);
    }

    #[test]
    fn a_repositorys_refs_make_its_versions() {
        let entry = |name: &str, commit: &str| GitRefEntry { name: name.into(), commit: commit.into() };
        let refs = [
            entry("refs/heads/feature", "f"),
            entry("refs/heads/main", "m"),
            entry("refs/tags/v1.0.0", "a"),
            entry("refs/tags/v1.1.0", "b"),
            entry("refs/tags/nightly", "n"),
        ];
        let wanted = wanted_versions(&refs, "main");
        let names: Vec<(&str, &str, bool)> = wanted.iter().map(|(v, c, _, d)| (v.version.as_str(), c.as_str(), *d)).collect();
        assert_eq!(
            names,
            [("dev-main", "m", true), ("dev-feature", "f", false), ("v1.1.0", "b", false), ("v1.0.0", "a", false)],
            "the default branch first, newest tags next, tags that are not versions left out"
        );
    }
}
