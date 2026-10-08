//! The Maven repository: `g1t.sh/-/maven/<workspace>/`, one for each
//! workspace, in the standard layout. `mvn deploy` and Gradle's `publish`
//! upload each file with a `PUT` and Basic credentials (any username, a g1t
//! token as the password); a `Bearer` token works too, for Gradle's header
//! credentials.
//!
//! Files are kept once, by their SHA-256, with their MD5, SHA-1 and SHA-512
//! worked out as they arrive, so the checksum files beside them are
//! answered without reading them again; checksums uploaded are checked
//! against them, not kept. `maven-metadata.xml` is made from the versions
//! on each read: an uploaded one is taken and let go.
//!
//! A release's files are written once. A SNAPSHOT's builds arrive as
//! timestamped files beside each other, and its metadata names the newest.
//! The POM is the version's record. The artifact's `maven-metadata.xml`, which
//! Maven and Gradle upload last, publishes what the deploy brought, as an
//! event and an audit entry.

use g1t_contracts::User;
use g1t_contracts::events::PackageEvent;
use g1t_contracts::new_id;
use g1t_kit::now_ms;
use serde_json::{Value, json};
use worker::{Context, Headers, Method, Request, Response, ResponseBody, Result};

use crate::access::Action;
use crate::archive;
use crate::db::{Checksums, NewFile, NewVersion, PackageRow, VersionRow};
use crate::digest::Digest;
use crate::maven::{self, Checksum, MavenPath};
use crate::npm;
use crate::oci::{Credentials, published_by};
use crate::store::BlobStore;
use crate::{Caller, Packages, TargetOf};

const MAVEN: &str = "maven";
/// The most versions an artifact's metadata lists.
const MAX_VERSIONS: u32 = 5000;
/// The longest POM read for its description and source.
const MAX_POM_BYTES: usize = 1024 * 1024;
/// The most artifacts of a group read for its plugins.
const MAX_GROUP: u32 = 500;
/// Where a plugin's jar keeps its descriptor, and the most read of it.
const PLUGIN_DESCRIPTOR: &str = "META-INF/maven/plugin.xml";
const MAX_DESCRIPTOR_BYTES: usize = 4 * 1024 * 1024;
const DOCS: &str = "https://docs.g1t.sh/guides/maven/";
const TOKENS: &str = "https://g1t.sh/settings/tokens";

/// A plain-text answer. Maven and Gradle print the status; the text says
/// why for anyone reading the response.
fn error(status: u16, message: impl Into<String>) -> Result<Response> {
    let mut response = Response::ok(format!("{}\n", message.into()))?.with_status(status);
    response.headers_mut().set("content-type", "text/plain; charset=utf-8")?;
    if status == 401 {
        response.headers_mut().set("www-authenticate", "Basic realm=\"g1t\"")?;
    }
    Ok(response)
}

fn created() -> Result<Response> {
    Ok(Response::empty()?.with_status(201))
}

fn sign_in() -> String {
    format!("Sign in to use this repository: Basic credentials with a g1t access token from {TOKENS} as the password. See {DOCS}")
}

/// A file or document as Maven reads it; a `HEAD` gets its headers alone.
fn serve(bytes: Vec<u8>, media_type: &str, head: bool, cache: &str) -> Result<Response> {
    let headers = Headers::new();
    headers.set("content-type", media_type)?;
    headers.set("content-length", &bytes.len().to_string())?;
    headers.set("cache-control", cache)?;
    let body = if head { ResponseBody::Empty } else { ResponseBody::Body(bytes) };
    Ok(Response::from_body(body)?.with_headers(headers))
}

impl Packages {
    /// Answers a Maven request.
    pub async fn maven(&self, request: Request, ctx: &Context) -> Result<Response> {
        let url = request.url()?;
        let Some((workspace, path)) = maven::route(url.path()) else {
            return error(404, "There is nothing at this address.");
        };
        match self.maven_route(request, &workspace, path, ctx).await {
            Ok(response) => Ok(response),
            Err(problem) => {
                worker::console_error!("packages: maven {}: {problem}", url.path());
                error(500, "Something went wrong on our side. Try again in a moment.")
            }
        }
    }

    async fn maven_route(&self, mut request: Request, workspace: &str, path: MavenPath, ctx: &Context) -> Result<Response> {
        let method = request.method();
        let credentials = self.credentials(&request).await?;
        let read = matches!(method, Method::Get | Method::Head);
        if read && let Some(refused) = self.limited(&request, &credentials, "Basic credentials with a g1t token").await? {
            return Ok(refused);
        }
        let viewer = match credentials {
            Credentials::Viewer(viewer) => viewer,
            Credentials::None => None,
            Credentials::Token(_) | Credentials::Bad => {
                return error(401, format!("The token is not right, or has expired. Make an access token at {TOKENS}."));
            }
        };
        let viewer = viewer.as_ref();
        let head = method == Method::Head;
        match (path, method) {
            (MavenPath::ArtifactMetadata { group, artifact, checksum }, Method::Get | Method::Head) => {
                self.maven_metadata(workspace, &group, &artifact, None, checksum, viewer, head).await
            }
            (MavenPath::GroupMetadata { group, checksum }, Method::Get | Method::Head) => {
                self.maven_group_metadata(workspace, &group, None, checksum, viewer, head).await
            }
            (MavenPath::VersionMetadata { group, artifact, version, checksum }, Method::Get | Method::Head) => {
                self.maven_metadata(workspace, &group, &artifact, Some(&version), checksum, viewer, head).await
            }
            (MavenPath::File { group, artifact, version, file, checksum }, Method::Get | Method::Head) => {
                self.maven_file(workspace, &maven::package_name(&group, &artifact), &version, &file, checksum, viewer, head, ctx)
                    .await
            }
            (MavenPath::File { group, artifact, version, file, checksum: None }, Method::Put) => {
                self.maven_upload(&mut request, workspace, &group, &artifact, &version, &file, viewer).await
            }
            (MavenPath::File { group, artifact, version, file, checksum: Some(checksum) }, Method::Put) => {
                let name = maven::package_name(&group, &artifact);
                self.maven_checksum(&mut request, workspace, &name, &version, &file, checksum, viewer).await
            }
            (path @ (MavenPath::ArtifactMetadata { .. } | MavenPath::VersionMetadata { .. } | MavenPath::GroupMetadata { .. }), Method::Put) => {
                self.maven_metadata_upload(&mut request, workspace, &path, viewer).await
            }
            _ => error(405, "Not a method this address takes. Versions are deleted on the package's page."),
        }
    }

    async fn maven_package(&self, workspace: &str, name: &str) -> Result<Option<PackageRow>> {
        Ok(self.db.package(workspace, MAVEN, name).await?.filter(|p| !p.hidden()))
    }

    /// The answer for something that is not there: to someone not signed
    /// in, a 401 when the workspace has private artifacts (so Maven sends
    /// its credentials and asks again, and a private artifact looks like a
    /// missing one), else a 404.
    async fn maven_absent(&self, workspace: &str, viewer: Option<&User>) -> Result<Response> {
        if viewer.is_none() && self.db.has_private(workspace, MAVEN).await? {
            return error(401, sign_in());
        }
        error(404, "Not found: no such artifact or file, or you cannot see it.")
    }

    /// Whether `viewer` may `action` the artifact, as the answer when not.
    async fn maven_check(&self, viewer: Option<&User>, package: &PackageRow, action: Action) -> Result<Option<Response>> {
        let (decision, readable) = self.check(viewer, package, action).await?;
        if decision.allowed {
            return Ok(None);
        }
        if !readable && viewer.is_none() {
            return Ok(Some(error(401, sign_in())?));
        }
        if !readable {
            return Ok(Some(self.maven_absent(&package.workspace, viewer).await?));
        }
        Ok(Some(error(403, decision.reason.unwrap_or_else(|| "Not allowed.".to_owned()))?))
    }

    /// `maven-metadata.xml` of an artifact, or of one of its SNAPSHOTs, or
    /// a checksum of it.
    #[allow(clippy::too_many_arguments)]
    async fn maven_metadata(
        &self,
        workspace: &str,
        group: &str,
        artifact: &str,
        snapshot: Option<&str>,
        checksum: Option<Checksum>,
        viewer: Option<&User>,
        head: bool,
    ) -> Result<Response> {
        let found = self.maven_package(workspace, &maven::package_name(group, artifact)).await?;
        // `com/acme/plugins/maven-metadata.xml` is also the group
        // `com.acme.plugins`'s, which lists its plugins.
        let Some(package) = found else {
            if snapshot.is_none() {
                return self.maven_group_metadata(workspace, &format!("{group}.{artifact}"), None, checksum, viewer, head).await;
            }
            return self.maven_absent(workspace, viewer).await;
        };
        if let Some(refusal) = self.maven_check(viewer, &package, Action::Pull).await? {
            return Ok(refusal);
        }
        let xml = match snapshot {
            None => {
                let versions: Vec<String> = self.db.versions(&package.id, MAX_VERSIONS).await?.into_iter().map(|v| v.version).collect();
                if versions.is_empty() {
                    return self.maven_absent(workspace, viewer).await;
                }
                let xml = maven::artifact_metadata(group, artifact, &versions, &package.updated_at);
                return self.maven_group_metadata(workspace, &format!("{group}.{artifact}"), Some(xml), checksum, viewer, head).await;
            }
            Some(version) => {
                let Some(row) = self.db.version_named(&package.id, version).await? else {
                    return self.maven_absent(workspace, viewer).await;
                };
                let files: Vec<String> = self.db.files(&row.id).await?.into_iter().map(|f| f.name).collect();
                let Some(xml) = maven::snapshot_metadata(group, artifact, version, &files) else {
                    return self.maven_absent(workspace, viewer).await;
                };
                xml
            }
        };
        match checksum {
            Some(checksum) => serve(checksum.of(xml.as_bytes()).into_bytes(), "text/plain", head, "no-cache"),
            None => serve(xml.into_bytes(), "application/xml", head, "no-cache"),
        }
    }

    /// A group's `maven-metadata.xml`: the plugins among its artifacts the
    /// viewer may see, by prefix, so `mvn <prefix>:<goal>` finds them when
    /// the group is one of its `<pluginGroups>`. `artifact` is the
    /// metadata of an artifact at the same path, which it is added to.
    async fn maven_group_metadata(
        &self,
        workspace: &str,
        group: &str,
        artifact: Option<String>,
        checksum: Option<Checksum>,
        viewer: Option<&User>,
        head: bool,
    ) -> Result<Response> {
        let mut plugins = Vec::new();
        for package in self.db.maven_group(workspace, group, MAX_GROUP).await? {
            if !self.check(viewer, &package, Action::Pull).await?.0.allowed {
                continue;
            }
            let artifact_id = package.name.rsplit(':').next().unwrap_or("").to_owned();
            // The highest version that is a plugin says its prefix and name.
            let mut versions = self.db.versions(&package.id, MAX_VERSIONS).await?;
            versions.sort_by(|a, b| maven::compare(&b.version, &a.version));
            let Some(meta) = versions.iter().map(VersionRow::meta).find(|m| m["packaging"] == "maven-plugin" || m["plugin"].is_object()) else {
                continue;
            };
            let text = |value: &Value| value.as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned);
            plugins.push(maven::Plugin {
                prefix: text(&meta["plugin"]["prefix"]).unwrap_or_else(|| maven::default_prefix(&artifact_id)),
                name: text(&meta["name"]).or_else(|| text(&meta["plugin"]["name"])).unwrap_or_else(|| artifact_id.clone()),
                artifact: artifact_id,
            });
        }
        let xml = match (artifact, plugins.is_empty()) {
            (artifact, false) => maven::group_metadata(artifact, &plugins),
            (Some(xml), true) => xml,
            (None, true) => return self.maven_absent(workspace, viewer).await,
        };
        match checksum {
            Some(checksum) => serve(checksum.of(xml.as_bytes()).into_bytes(), "text/plain", head, "no-cache"),
            None => serve(xml.into_bytes(), "application/xml", head, "no-cache"),
        }
    }

    /// One of a version's files, or a checksum of it.
    #[allow(clippy::too_many_arguments)]
    async fn maven_file(
        &self,
        workspace: &str,
        name: &str,
        version: &str,
        file: &str,
        checksum: Option<Checksum>,
        viewer: Option<&User>,
        head: bool,
        ctx: &Context,
    ) -> Result<Response> {
        let Some(package) = self.maven_package(workspace, name).await? else {
            return self.maven_absent(workspace, viewer).await;
        };
        if let Some(refusal) = self.maven_check(viewer, &package, Action::Pull).await? {
            return Ok(refusal);
        }
        let Some(row) = self.db.version_named(&package.id, version).await? else {
            return self.maven_absent(workspace, viewer).await;
        };
        let Some(kept) = self.db.file(&row.id, file).await? else {
            return self.maven_absent(workspace, viewer).await;
        };
        let Some(digest) = Digest::parse(&kept.digest) else {
            return self.maven_absent(workspace, viewer).await;
        };
        let Some(blob) = self.db.package_blob(&package.id, &digest).await? else {
            return self.maven_absent(workspace, viewer).await;
        };
        // A release's files never change; a SNAPSHOT's are timestamped, so
        // each name is one file too.
        let cache = "max-age=31536000";
        if let Some(checksum) = checksum {
            let sums = match self.db.checksums(&digest).await? {
                Some(sums) => sums,
                None => {
                    let Some(bytes) = self.store.read(&blob.object_key).await? else {
                        return self.maven_absent(workspace, viewer).await;
                    };
                    let sums = Checksums::of(&bytes);
                    self.db.set_checksums(&digest, &sums).await?;
                    sums
                }
            };
            return serve(checksum.pick(&sums, digest.hex()).into_bytes(), "text/plain", head, cache);
        }
        let headers = Headers::new();
        headers.set("content-type", maven::media_type(file))?;
        headers.set("content-length", &blob.size.to_string())?;
        headers.set("cache-control", cache)?;
        if head {
            return Ok(Response::from_body(ResponseBody::Empty)?.with_headers(headers));
        }
        let Some(got) = self.store.get(&blob.object_key, None).await? else {
            return self.maven_absent(workspace, viewer).await;
        };
        // A download is the artifact itself, not its POM, signature or
        // Gradle module file, which are read beside it.
        if let Some(parsed) = maven::parse_file(name.rsplit(':').next().unwrap_or(""), version, file)
            && parsed.classifier.is_none()
            && !matches!(parsed.extension.as_str(), "pom" | "module" | "asc")
            && !parsed.extension.ends_with(".asc")
        {
            self.count_version_download(&package.id, &row.id, ctx);
        }
        Ok(Response::from_body(got.body)?.with_headers(headers))
    }

    /// Who may upload to a new artifact: the repository its artifactId
    /// names, else the workspace.
    async fn maven_target(&self, workspace: &str, candidates: &[String]) -> Result<TargetOf> {
        let mut repo = None;
        for candidate in candidates {
            if let Some(found) = self.repo_by_name(workspace, candidate).await? {
                repo = Some(found);
                break;
            }
        }
        Ok(TargetOf::unmade(workspace, candidates.first().map_or("", String::as_str), repo.map(|r| (r.id, r.name, r.is_private))))
    }

    /// Whether `viewer` may upload to the artifact (made on its first
    /// file), as the answer when not.
    async fn maven_refusal(&self, viewer: Option<&User>, target: &mut TargetOf, exists: bool) -> Result<Option<Result<Response>>> {
        let decision = self.decide(viewer, target, Action::Push).await?;
        if decision.allowed {
            return Ok(None);
        }
        if viewer.is_none() {
            return Ok(Some(error(401, sign_in())));
        }
        if exists && !self.decide(viewer, target, Action::Pull).await?.allowed {
            return Ok(Some(error(404, "Not found: no such artifact, or you cannot see it.")));
        }
        Ok(Some(error(403, decision.reason.unwrap_or_else(|| "Not allowed.".to_owned()))))
    }

    async fn maven_body(&self, request: &mut Request) -> Result<std::result::Result<Vec<u8>, Response>> {
        let declared = request.headers().get("content-length")?.and_then(|n| n.parse::<u64>().ok());
        let too_large = || {
            let mb = self.max_request / 1_000_000;
            error(413, format!("A file may be at most {mb} MB. See {DOCS}#size"))
        };
        if declared.is_some_and(|n| n > self.max_request) {
            return Ok(Err(too_large()?));
        }
        let bytes = request.bytes().await?;
        if bytes.len() as u64 > self.max_request {
            return Ok(Err(too_large()?));
        }
        Ok(Ok(bytes))
    }

    /// A `PUT` of one of a version's files.
    #[allow(clippy::too_many_arguments)]
    async fn maven_upload(
        &self,
        request: &mut Request,
        workspace: &str,
        group: &str,
        artifact: &str,
        version: &str,
        file: &str,
        viewer: Option<&User>,
    ) -> Result<Response> {
        let bytes = match self.maven_body(request).await? {
            Ok(bytes) => bytes,
            Err(refused) => return Ok(refused),
        };
        if bytes.is_empty() {
            return error(400, format!("{file} is empty."));
        }
        let Some(parsed) = maven::parse_file(artifact, version, file) else {
            return error(400, format!("{file} is not a file of {artifact} {version}."));
        };
        let is_pom = parsed.classifier.is_none() && parsed.extension == "pom";
        let pom = if is_pom {
            let pom = match maven::read_pom(&bytes[..bytes.len().min(MAX_POM_BYTES)]) {
                Ok(pom) => pom,
                Err(message) => return error(400, message),
            };
            if pom.group != group || pom.artifact != artifact || pom.version != version {
                return error(
                    400,
                    format!(
                        "The POM says {}:{}:{}, but it was uploaded as {group}:{artifact}:{version}.",
                        pom.group, pom.artifact, pom.version
                    ),
                );
            }
            Some(pom)
        } else {
            None
        };

        // The main jar of a Maven plugin holds its descriptor.
        let plugin = if parsed.classifier.is_none() && parsed.extension == "jar" {
            archive::zip_entries(&bytes)
                .ok()
                .and_then(|entries| entries.into_iter().find(|e| e.name == PLUGIN_DESCRIPTOR))
                .and_then(|entry| archive::zip_read(&bytes, &entry, MAX_DESCRIPTOR_BYTES).ok())
                .and_then(|xml| maven::plugin_descriptor(&String::from_utf8_lossy(&xml)))
        } else {
            None
        };

        let name = maven::package_name(group, artifact);
        let found = self.db.package(workspace, MAVEN, &name).await?;
        if let Some(hidden) = found.as_ref().filter(|package| package.hidden()) {
            return error(403, Packages::hidden_refusal(hidden));
        }
        if found.is_none() && self.db.workspace_hidden(workspace).await? {
            return error(403, format!("The workspace {workspace} is deleted; nothing can be published to it."));
        }
        let mut target = match &found {
            Some(package) => TargetOf::package(package),
            None => {
                let lower = artifact.to_ascii_lowercase();
                self.maven_target(workspace, &[lower]).await?
            }
        };
        if let Some(refusal) = self.maven_refusal(viewer, &mut target, found.is_some()).await? {
            return refusal;
        }
        let caller = Caller::of(viewer);
        let now = now_ms();
        let package = match found {
            Some(package) => package,
            None => {
                self.make_package(
                    workspace,
                    MAVEN,
                    &name,
                    target.repo.as_ref().map(|(id, repo, private)| (id.as_str(), repo.as_str(), *private)),
                    &caller,
                    now,
                )
                .await?
            }
        };
        if let Some(refused) = self.reserved_refusal(&package, version).await? {
            return error(409, refused);
        }

        let digest = Digest::of(&bytes);
        let size = bytes.len() as u64;
        let (row, _) = self
            .db
            .version_or_new(
                &NewVersion {
                    id: new_id("ver", now),
                    package_id: package.id.clone(),
                    version: version.to_owned(),
                    digest: digest.to_string(),
                    size: 0,
                    metadata: "{}".to_owned(),
                    subject: None,
                    published_by: published_by(&caller),
                    files: Vec::new(),
                },
                now,
            )
            .await?;
        if let Some(kept) = self.db.file(&row.id, file).await? {
            if kept.digest == digest.to_string() {
                return created();
            }
            if !maven::is_snapshot(version) {
                return error(
                    409,
                    format!("{file} is already published in {name} {version}, and a release's files are published once. Bump the version."),
                );
            }
        }
        if let Some(refusal) = self.storage_refusal(&package, &[(digest.to_string(), size)]).await? {
            return error(403, refusal);
        }
        let stored = match self.db.blob(&digest).await? {
            Some(blob) => self.store.head(&blob.object_key).await?.is_some(),
            None => false,
        };
        let sums = Checksums::of(&bytes);
        if !stored {
            self.store.put(&digest.object_key(), bytes).await?;
        }
        let media_type = maven::media_type(file);
        self.db.keep_blob(&package.id, &digest, size, Some(media_type), &digest.object_key(), now).await?;
        self.db.set_checksums(&digest, &sums).await?;
        self.db
            .put_file(&package.id, &row.id, &NewFile { name: file.to_owned(), digest: digest.to_string(), size, media_type: Some(media_type.to_owned()) }, now)
            .await?;
        self.db.measure(&package.workspace).await?;

        if let Some(pom) = pom {
            self.maven_pom(&package, &row, &digest, &pom, viewer).await?;
        } else if let Some((prefix, title)) = plugin {
            // A plugin's jar names the prefix it is called by.
            let mut metadata = self.db.version_named(&package.id, version).await?.map(|v| v.meta()).unwrap_or_default();
            if !metadata.is_object() {
                metadata = json!({});
            }
            metadata["plugin"] = json!({ "prefix": prefix, "name": title });
            self.db.set_version(&row.id, &row.digest, &metadata.to_string()).await?;
        }
        created()
    }

    /// The POM arrived: it is the version's record. Its description is
    /// the package's when it is the highest release, and a new artifact
    /// whose POM names its source on g1t is linked to that repository.
    async fn maven_pom(&self, package: &PackageRow, row: &VersionRow, digest: &Digest, pom: &maven::Pom, viewer: Option<&User>) -> Result<()> {
        let now = now_ms();
        let version = row.version.as_str();
        let mut metadata = row.meta();
        if !metadata.is_object() {
            metadata = json!({});
        }
        metadata["pom"] = json!(true);
        metadata["name"] = json!(pom.name);
        metadata["description"] = json!(pom.description);
        metadata["source"] = json!(pom.source);
        metadata["packaging"] = json!(pom.packaging);
        self.db.set_version(&row.id, &digest.to_string(), &metadata.to_string()).await?;
        let versions = self.db.versions(&package.id, MAX_VERSIONS).await?;
        let releases: Vec<&str> = versions.iter().map(|v| v.version.as_str()).filter(|v| !maven::is_snapshot(v)).collect();
        let highest = if maven::is_snapshot(version) {
            releases.is_empty()
        } else {
            releases.iter().all(|other| maven::compare(other, version) != std::cmp::Ordering::Greater)
        };
        if highest {
            self.db.set_readme(&package.id, None, pom.description.as_deref().or(pom.name.as_deref()), now).await?;
        }
        if package.repo_id.is_none()
            && versions.len() == 1
            && let Some((owner, repo)) = pom.source.as_ref().and_then(|source| npm::repository_of(&Value::String(source.clone()), &self.host))
            && owner == package.workspace
            && let Some(repo) = self.repo_by_name(&package.workspace, &repo).await?
        {
            let mut linked = TargetOf::unmade(&package.workspace, &package.name, Some((repo.id.clone(), repo.name.clone(), repo.is_private)));
            if self.decide(viewer, &mut linked, Action::Push).await?.allowed {
                let visibility = if repo.is_private { "private" } else { "public" };
                self.db.set_link(&package.id, Some((&repo.id, &repo.name)), visibility, now).await?;
                self.db.measure(&package.workspace).await?;
            }
        }
        Ok(())
    }

    /// The artifact's `maven-metadata.xml` is what Maven and Gradle upload
    /// last: each version (or SNAPSHOT build) whose POM arrived since the
    /// last one is published now, with all its files, as an event and an
    /// audit entry.
    async fn maven_announce(&self, package: &PackageRow, caller: &Caller) -> Result<()> {
        let artifact = package.name.rsplit(':').next().unwrap_or("").to_owned();
        for row in self.db.versions(&package.id, MAX_VERSIONS).await? {
            let mut metadata = row.meta();
            if metadata["pom"] != json!(true) {
                continue;
            }
            let mark = if maven::is_snapshot(&row.version) {
                let files: Vec<String> = self.db.files(&row.id).await?.into_iter().map(|f| f.name).collect();
                match maven::newest_build(&artifact, &row.version, &files) {
                    Some((timestamp, build)) => format!("{timestamp}-{build}"),
                    None => "unique".to_owned(),
                }
            } else {
                "release".to_owned()
            };
            if metadata["published"].as_str() == Some(mark.as_str()) {
                continue;
            }
            metadata["published"] = json!(mark);
            self.db.set_version(&row.id, &row.digest, &metadata.to_string()).await?;
            let event = PackageEvent {
                version: Some(row.version.clone()),
                digest: Some(row.digest.clone()),
                size: Some(row.size),
                ..self.event_of(package)
            };
            self.announce("package.published", package, event, caller).await;
            self.audit(caller, "package.publish", package, Some(&format!("{}/{}@{}", package.workspace, package.name, row.version)), None).await;
        }
        Ok(())
    }

    /// A checksum uploaded beside a file: checked against the file's.
    #[allow(clippy::too_many_arguments)]
    async fn maven_checksum(
        &self,
        request: &mut Request,
        workspace: &str,
        name: &str,
        version: &str,
        file: &str,
        checksum: Checksum,
        viewer: Option<&User>,
    ) -> Result<Response> {
        let bytes = match self.maven_body(request).await? {
            Ok(bytes) => bytes,
            Err(refused) => return Ok(refused),
        };
        let Some(package) = self.maven_package(workspace, name).await? else {
            return self.maven_absent(workspace, viewer).await;
        };
        if let Some(refusal) = self.maven_check(viewer, &package, Action::Push).await? {
            return Ok(refusal);
        }
        let Some(row) = self.db.version_named(&package.id, version).await? else {
            return error(404, format!("Upload {file} before its checksum."));
        };
        let Some(kept) = self.db.file(&row.id, file).await? else {
            return error(404, format!("Upload {file} before its checksum."));
        };
        let Some(digest) = Digest::parse(&kept.digest) else {
            return error(404, format!("Upload {file} before its checksum."));
        };
        let Some(sums) = self.db.checksums(&digest).await? else {
            return created();
        };
        if maven::sent_checksum(&bytes) != checksum.pick(&sums, digest.hex()) {
            return error(400, format!("The {} checksum sent is not {file}'s. Upload the file again.", &checksum.suffix()[1..]));
        }
        created()
    }

    /// An uploaded `maven-metadata.xml`, or its checksum: the repository
    /// makes its own, so it is taken from anyone who may upload and let go.
    /// The artifact's own (not a SNAPSHOT's, nor its checksum) ends a
    /// deploy, and publishes what it brought.
    async fn maven_metadata_upload(&self, request: &mut Request, workspace: &str, path: &MavenPath, viewer: Option<&User>) -> Result<Response> {
        if let Err(refused) = self.maven_body(request).await? {
            return Ok(refused);
        }
        let found = match path {
            MavenPath::ArtifactMetadata { group, artifact, .. } | MavenPath::VersionMetadata { group, artifact, .. } | MavenPath::File { group, artifact, .. } => {
                self.maven_package(workspace, &maven::package_name(group, artifact)).await?
            }
            MavenPath::GroupMetadata { .. } => None,
        };
        let mut target = match &found {
            Some(package) => TargetOf::package(package),
            // A plugin group's metadata names no artifact of its own.
            None => self.maven_target(workspace, &[]).await?,
        };
        if let Some(refusal) = self.maven_refusal(viewer, &mut target, found.is_some()).await? {
            return refusal;
        }
        if let (Some(package), MavenPath::ArtifactMetadata { checksum: None, .. }) = (&found, path) {
            let caller = Caller::of(viewer);
            self.maven_announce(package, &caller).await?;
        }
        created()
    }
}
