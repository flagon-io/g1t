//! The NuGet feed: `g1t.sh/-/nuget/<workspace>/v3/index.json`, a v3 feed
//! for each workspace. `dotnet nuget push` sends a g1t token as its API key
//! (`X-NuGet-ApiKey`); restores send Basic credentials (any username, a g1t
//! token as the password) from `nuget.config`, after the feed answers a
//! private request with a `401`.
//!
//! A `.nupkg` is stored once, by its SHA-256, with its `.nuspec` beside it;
//! the flat container, registration and search documents are made from the
//! versions on each read. `dotnet nuget delete` unlists a version, as
//! nuget.org does: it is still downloaded by those who name it. Each
//! `.nupkg` download counts for its version as well as its package.
//!
//! A symbol package (`.snupkg`, pushed to `api/v2/symbolpackage` after its
//! `.nupkg`) is kept beside the version, and each portable PDB in it by
//! the key debuggers ask the symbol server (`symbols/`) with, as the
//! Simple Symbol Query Protocol names it: `<file>/<guid>ffffffff/<file>`.

use g1t_contracts::User;
use g1t_contracts::audit::AuditActor;
use g1t_contracts::events::PackageEvent;
use g1t_contracts::new_id;
use g1t_kit::now_ms;
use serde_json::{Value, json};
use worker::{Context, Headers, Method, Request, Response, ResponseBody, Result, Url};

use crate::access::{self, Action};
use crate::db::{NewFile, NewVersion, PackageRow, VersionRow};
use crate::digest::Digest;
use crate::npm;
use crate::nuget::{self, Content, Listed, NugetRoute};
use crate::oci::{Credentials, origin, published_by};
use crate::store::BlobStore;
use crate::{Caller, Packages, TargetOf, token};

const NUGET: &str = "nuget";
/// The most versions a package's documents list.
const MAX_VERSIONS: u32 = 5000;
/// The longest README kept for a package's page.
const MAX_README_BYTES: usize = 1024 * 1024;
/// The most packages one search answers with.
const MAX_SEARCH: u32 = 100;
const DOCS: &str = "https://docs.g1t.sh/guides/nuget/";
const TOKENS: &str = "https://g1t.sh/settings/tokens";

/// A plain-text answer, which `dotnet` prints after the status.
fn error(status: u16, message: impl Into<String>) -> Result<Response> {
    let mut response = Response::ok(message.into())?.with_status(status);
    response.headers_mut().set("content-type", "text/plain; charset=utf-8")?;
    if status == 401 {
        response.headers_mut().set("www-authenticate", "Basic realm=\"g1t\"")?;
    }
    Ok(response)
}

fn sign_in() -> String {
    format!("Sign in to use this feed: give the source a username and a g1t access token from {TOKENS} as its password. See {DOCS}")
}

fn json_response(value: &Value, head: bool) -> Result<Response> {
    let mut response = if head { Response::empty()? } else { Response::from_json(value)? };
    response.headers_mut().set("content-type", "application/json")?;
    response.headers_mut().set("cache-control", "no-cache")?;
    Ok(response)
}

impl Packages {
    /// Answers a NuGet request.
    pub async fn nuget(&self, request: Request, ctx: &Context) -> Result<Response> {
        let url = request.url()?;
        let Some((workspace, route)) = nuget::route(url.path()) else {
            return error(404, "There is nothing at this address.");
        };
        match self.nuget_route(request, &url, &workspace, route, ctx).await {
            Ok(response) => Ok(response),
            Err(problem) => {
                worker::console_error!("packages: nuget {}: {problem}", url.path());
                error(500, "Something went wrong on our side. Try again in a moment.")
            }
        }
    }

    /// Who the request is from: the push's API key, or Basic credentials
    /// (or a `Bearer` token) from the source's settings.
    async fn nuget_credentials(&self, request: &Request) -> Result<Credentials> {
        if let Some(key) = request.headers().get("x-nuget-apikey")?.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty()) {
            return Ok(match self.viewer_for("token", &key).await? {
                Some(user) => Credentials::Viewer(Some(user)),
                None => Credentials::Bad,
            });
        }
        let Some(header) = request.headers().get("authorization")? else {
            return Ok(Credentials::None);
        };
        let viewer = if let Some((username, secret)) = token::basic(&header) {
            self.viewer_for(&username, &secret).await?
        } else if let Some(bearer) = token::bearer(&header) {
            self.viewer_for("token", bearer).await?
        } else {
            None
        };
        Ok(match viewer {
            Some(user) => Credentials::Viewer(Some(user)),
            None => Credentials::Bad,
        })
    }

    async fn nuget_route(&self, mut request: Request, url: &Url, workspace: &str, route: NugetRoute, ctx: &Context) -> Result<Response> {
        let method = request.method();
        let credentials = self.nuget_credentials(&request).await?;
        let read = matches!(method, Method::Get | Method::Head);
        if read && let Some(refused) = self.limited(&request, &credentials, "a g1t token in the source's credentials").await? {
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
        let base = format!("{}/-/nuget/{workspace}", origin(url));
        let head = method == Method::Head;
        match route {
            NugetRoute::Index if read => {
                if viewer.is_none() && self.db.has_private(workspace, NUGET).await? {
                    return error(401, sign_in());
                }
                json_response(&nuget::service_index(&base), head)
            }
            NugetRoute::Versions { id } if read => self.nuget_versions(workspace, &id, viewer, head).await,
            NugetRoute::Content { id, version, file } if read => self.nuget_content(workspace, &id, &version, file, viewer, head, ctx).await,
            NugetRoute::Registration { id } if read => self.nuget_registration(&base, workspace, &id, None, viewer, head).await,
            NugetRoute::Leaf { id, version } if read => self.nuget_registration(&base, workspace, &id, Some(&version), viewer, head).await,
            NugetRoute::Search if read => self.nuget_search(url, &base, workspace, viewer).await,
            NugetRoute::Push if method == Method::Put => self.nuget_push(&mut request, workspace, viewer).await,
            NugetRoute::Listing { id, version } if method == Method::Delete => self.nuget_listing(workspace, &id, &version, false, viewer).await,
            NugetRoute::Listing { id, version } if method == Method::Post => self.nuget_listing(workspace, &id, &version, true, viewer).await,
            NugetRoute::SymbolPush if method == Method::Put => self.nuget_symbol_push(&mut request, workspace, viewer).await,
            NugetRoute::Symbol { file, key } if read => self.nuget_symbol(workspace, &file, &key, viewer, head).await,
            _ => error(405, "Not a method this address takes."),
        }
    }

    /// The package, by its id in any case, if its workspace is not deleted.
    async fn nuget_package(&self, workspace: &str, id: &str) -> Result<Option<PackageRow>> {
        Ok(self.db.package_any_case(workspace, NUGET, id).await?.filter(|p| !p.hidden()))
    }

    /// The answer for something not there: a `401` to someone not signed
    /// in when the workspace has private packages, so the client sends its
    /// credentials and a private package looks like a missing one.
    async fn nuget_absent(&self, workspace: &str, viewer: Option<&User>) -> Result<Response> {
        if viewer.is_none() && self.db.has_private(workspace, NUGET).await? {
            return error(401, sign_in());
        }
        error(404, "Not found: no such package or version, or you cannot see it.")
    }

    async fn nuget_check(&self, viewer: Option<&User>, package: &PackageRow, action: Action) -> Result<Option<Response>> {
        let target = TargetOf::package(package);
        let decision = access::decide(viewer, &target.view(), action);
        if decision.allowed {
            return Ok(None);
        }
        let readable = action != Action::Pull && access::decide(viewer, &target.view(), Action::Pull).allowed;
        if !readable && viewer.is_none() {
            return Ok(Some(error(401, sign_in())?));
        }
        if !readable {
            return Ok(Some(self.nuget_absent(&package.workspace, viewer).await?));
        }
        Ok(Some(error(403, decision.reason.unwrap_or_else(|| "Not allowed.".to_owned()))?))
    }

    /// The package and its versions, oldest first, when the viewer may read it.
    async fn nuget_readable(&self, workspace: &str, id: &str, viewer: Option<&User>) -> Result<std::result::Result<(PackageRow, Vec<VersionRow>), Response>> {
        let Some(package) = self.nuget_package(workspace, id).await? else {
            return Ok(Err(self.nuget_absent(workspace, viewer).await?));
        };
        if let Some(refusal) = self.nuget_check(viewer, &package, Action::Pull).await? {
            return Ok(Err(refusal));
        }
        let mut versions = self.db.versions(&package.id, MAX_VERSIONS).await?;
        if versions.is_empty() {
            return Ok(Err(self.nuget_absent(workspace, viewer).await?));
        }
        versions.sort_by(|a, b| nuget::compare(&a.version, &b.version));
        Ok(Ok((package, versions)))
    }

    /// The flat container's version list: every version, unlisted ones too.
    async fn nuget_versions(&self, workspace: &str, id: &str, viewer: Option<&User>, head: bool) -> Result<Response> {
        let (_, versions) = match self.nuget_readable(workspace, id, viewer).await? {
            Ok(found) => found,
            Err(refused) => return Ok(refused),
        };
        let listed: Vec<String> = versions.iter().map(|v| v.version.to_ascii_lowercase()).collect();
        json_response(&json!({ "versions": listed }), head)
    }

    /// A version's `.nupkg` or `.nuspec`.
    #[allow(clippy::too_many_arguments)]
    async fn nuget_content(&self, workspace: &str, id: &str, version: &str, file: Content, viewer: Option<&User>, head: bool, ctx: &Context) -> Result<Response> {
        let (package, versions) = match self.nuget_readable(workspace, id, viewer).await? {
            Ok(found) => found,
            Err(refused) => return Ok(refused),
        };
        let wanted = nuget::normalize(version).unwrap_or_default().to_ascii_lowercase();
        let Some(row) = versions.iter().find(|v| v.version.to_ascii_lowercase() == wanted) else {
            return self.nuget_absent(workspace, viewer).await;
        };
        let Some(kept) = self.db.file(&row.id, file.file()).await? else {
            return self.nuget_absent(workspace, viewer).await;
        };
        let Some(digest) = Digest::parse(&kept.digest) else {
            return self.nuget_absent(workspace, viewer).await;
        };
        let Some(blob) = self.db.package_blob(&package.id, &digest).await? else {
            return self.nuget_absent(workspace, viewer).await;
        };
        let headers = Headers::new();
        headers.set("content-type", if file == Content::Nuspec { "application/xml" } else { "application/octet-stream" })?;
        headers.set("content-length", &blob.size.to_string())?;
        headers.set("cache-control", "max-age=31536000")?;
        if head {
            return Ok(Response::from_body(ResponseBody::Empty)?.with_headers(headers));
        }
        let Some(got) = self.store.get(&blob.object_key, None).await? else {
            return self.nuget_absent(workspace, viewer).await;
        };
        if file == Content::Nupkg {
            self.count_version_download(&package.id, &row.id, ctx);
        }
        Ok(Response::from_body(got.body)?.with_headers(headers))
    }

    /// A package's registration index, or one version's leaf.
    async fn nuget_registration(&self, base: &str, workspace: &str, id: &str, version: Option<&str>, viewer: Option<&User>, head: bool) -> Result<Response> {
        let (package, versions) = match self.nuget_readable(workspace, id, viewer).await? {
            Ok(found) => found,
            Err(refused) => return Ok(refused),
        };
        let metadata: Vec<Value> = versions.iter().map(VersionRow::meta).collect();
        let listed: Vec<Listed<'_>> = versions
            .iter()
            .zip(&metadata)
            .map(|(row, metadata)| Listed { version: &row.version, metadata, published: &row.published_at, listed: !row.is_yanked(), downloads: row.downloads })
            .collect();
        match version {
            None => json_response(&nuget::registration(base, &package.name, &listed), head),
            Some(version) => {
                let wanted = nuget::normalize(version).unwrap_or_default().to_ascii_lowercase();
                let Some(one) = listed.iter().find(|v| v.version.to_ascii_lowercase() == wanted) else {
                    return self.nuget_absent(workspace, viewer).await;
                };
                json_response(&nuget::leaf(base, &package.name, one), head)
            }
        }
    }

    /// Search: the workspace's packages the viewer may see whose id or
    /// description holds the query, with their listed versions.
    async fn nuget_search(&self, url: &Url, base: &str, workspace: &str, viewer: Option<&User>) -> Result<Response> {
        let query = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
        let q = query("q").unwrap_or_default().trim().to_ascii_lowercase();
        let skip = query("skip").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
        let take = query("take").and_then(|v| v.parse::<usize>().ok()).unwrap_or(20).min(MAX_SEARCH as usize);
        let prerelease = query("prerelease").is_some_and(|v| v.eq_ignore_ascii_case("true"));
        if viewer.is_none() && self.db.has_private(workspace, NUGET).await? {
            return error(401, sign_in());
        }
        let packages = self.db.packages_of(workspace, NUGET, 1000).await?;
        let versions = self.db.ecosystem_versions(workspace, NUGET, 20_000).await?;
        let mut found = Vec::new();
        for package in &packages {
            if !access::decide(viewer, &TargetOf::package(package).view(), Action::Pull).allowed {
                continue;
            }
            let rows: Vec<&VersionRow> = versions
                .iter()
                .filter(|v| v.package_id == package.id && (prerelease || !nuget::is_prerelease(&v.version)))
                .collect();
            let metadata: Vec<Value> = rows.iter().map(|v| v.meta()).collect();
            let matches = q.is_empty()
                || package.name.to_ascii_lowercase().contains(&q)
                || package.description.as_deref().is_some_and(|d| d.to_ascii_lowercase().contains(&q));
            if !matches {
                continue;
            }
            let mut listed: Vec<Listed<'_>> = rows
                .iter()
                .zip(&metadata)
                .map(|(row, metadata)| Listed { version: &row.version, metadata, published: &row.published_at, listed: !row.is_yanked(), downloads: row.downloads })
                .collect();
            listed.sort_by(|a, b| nuget::compare(a.version, b.version));
            if let Some(mut result) = nuget::search_result(base, &package.name, &listed) {
                result["totalDownloads"] = json!(package.downloads);
                found.push(result);
            }
        }
        let total = found.len();
        let data: Vec<Value> = found.into_iter().skip(skip).take(take).collect();
        json_response(&json!({ "totalHits": total, "data": data }), false)
    }

    /// The package a first push makes, linked to the repository its
    /// `.nuspec` names on g1t, or else one named like its id.
    async fn nuget_target(&self, workspace: &str, id: &str, repository: Option<&str>) -> Result<TargetOf> {
        let named = repository
            .and_then(|url| npm::repository_of(&Value::String(url.to_owned()), &self.host))
            .filter(|(owner, _)| owner == workspace)
            .map(|(_, repo)| repo);
        let lower = id.to_ascii_lowercase();
        let dashed = lower.replace('.', "-");
        let mut repo = None;
        for candidate in named.iter().map(String::as_str).chain([lower.as_str(), dashed.as_str()]) {
            if let Some(found) = self.repo_by_name(workspace, candidate).await? {
                repo = Some(found);
                break;
            }
        }
        Ok(TargetOf { workspace: workspace.to_owned(), repo: repo.map(|r| (r.id, r.name, r.is_private)), public: false })
    }

    /// `dotnet nuget push`: a `PUT` of the `.nupkg`, in a multipart body.
    async fn nuget_push(&self, request: &mut Request, workspace: &str, viewer: Option<&User>) -> Result<Response> {
        let declared = request.headers().get("content-length")?.and_then(|n| n.parse::<u64>().ok());
        let too_large = || {
            let mb = self.max_request / 1_000_000;
            error(413, format!("A push may be at most {mb} MB. See {DOCS}#size"))
        };
        if declared.is_some_and(|n| n > self.max_request) {
            return too_large();
        }
        let content_type = request.headers().get("content-type")?;
        let body = request.bytes().await?;
        if body.len() as u64 > self.max_request {
            return too_large();
        }
        if viewer.is_none() {
            return error(401, format!("Push with a g1t access token as the API key: dotnet nuget push <file> --api-key <token>. Make one at {TOKENS}."));
        }
        let nupkg = match nuget::pushed_file(content_type.as_deref(), &body) {
            Ok(file) => file,
            Err(message) => return error(400, message),
        };
        let read = match nuget::read_package(nupkg) {
            Ok(read) => read,
            Err(message) => return error(400, message),
        };
        let spec = &read.nuspec;
        if !nuget::valid_id(&spec.id) {
            return error(400, format!("{} is not a valid package id: letters, digits and _, in parts joined by ., - or _.", spec.id));
        }
        let Some(version) = nuget::normalize(&spec.version) else {
            return error(400, format!("{} is not a version NuGet reads.", spec.version));
        };

        let found = self.db.package_any_case(workspace, NUGET, &spec.id).await?;
        if found.as_ref().is_some_and(PackageRow::hidden) || (found.is_none() && self.db.workspace_hidden(workspace).await?) {
            return error(403, format!("The workspace {workspace} is deleted; nothing can be pushed to it."));
        }
        let target = match &found {
            Some(package) => TargetOf::package(package),
            None => self.nuget_target(workspace, &spec.id, spec.repository_url.as_deref()).await?,
        };
        let decision = access::decide(viewer, &target.view(), Action::Push);
        if !decision.allowed {
            let readable = found.is_none() || access::decide(viewer, &target.view(), Action::Pull).allowed;
            if !readable {
                return error(404, "Not found: no such package, or you cannot see it.");
            }
            return error(403, decision.reason.unwrap_or_else(|| "Not allowed.".to_owned()));
        }
        let caller = Caller { actor: viewer.map(AuditActor::of) };
        let package = match found {
            Some(package) => package,
            None => {
                self.db
                    .create_package(
                        &new_id("pkg", now_ms()),
                        workspace,
                        NUGET,
                        &spec.id,
                        target.repo.as_ref().map(|(id, repo, private)| (id.as_str(), repo.as_str(), *private)),
                        caller.actor.as_ref().map_or("", |actor| actor.actor_id.as_str()),
                        now_ms(),
                    )
                    .await?
            }
        };
        let existing = self.db.versions(&package.id, MAX_VERSIONS).await?;
        if let Some(taken) = existing.iter().find(|v| v.version.eq_ignore_ascii_case(&version)) {
            return error(409, format!("{} {} is already pushed, and a version is pushed once. Bump the version.", package.name, taken.version));
        }

        let nupkg = nupkg.to_vec();
        let digest = Digest::of(&nupkg);
        let size = nupkg.len() as u64;
        let nuspec_digest = Digest::of(&read.nuspec_bytes);
        let nuspec_size = read.nuspec_bytes.len() as u64;
        let files = [(digest.to_string(), size), (nuspec_digest.to_string(), nuspec_size)];
        if let Some(refusal) = self.storage_refusal(&package, &files).await? {
            return error(403, refusal);
        }
        let now = now_ms();
        for (digest, bytes, media_type) in [(&digest, nupkg, "application/octet-stream"), (&nuspec_digest, read.nuspec_bytes.clone(), "application/xml")] {
            let stored = match self.db.blob(digest).await? {
                Some(blob) => self.store.head(&blob.object_key).await?.is_some(),
                None => false,
            };
            let length = bytes.len() as u64;
            if !stored {
                self.store.put(&digest.object_key(), bytes).await?;
            }
            self.db.keep_blob(&package.id, digest, length, Some(media_type), &digest.object_key(), now).await?;
        }
        self.db
            .publish(
                NewVersion {
                    id: new_id("ver", now),
                    package_id: package.id.clone(),
                    version: version.clone(),
                    digest: digest.to_string(),
                    size: size + nuspec_size,
                    metadata: nuget::stored(spec, &version).to_string(),
                    subject: None,
                    published_by: published_by(&caller),
                    files: vec![
                        NewFile { name: "nupkg".to_owned(), digest: digest.to_string(), size, media_type: Some("application/octet-stream".to_owned()) },
                        NewFile {
                            name: "nuspec".to_owned(),
                            digest: nuspec_digest.to_string(),
                            size: nuspec_size,
                            media_type: Some("application/xml".to_owned()),
                        },
                    ],
                },
                None,
                now,
            )
            .await?;
        // The README and description the page shows: the highest stable
        // version's, so a pre-release does not replace them.
        let highest = !nuget::is_prerelease(&version)
            && existing.iter().filter(|v| !nuget::is_prerelease(&v.version)).all(|v| nuget::compare(&v.version, &version).is_lt());
        let first = nuget::is_prerelease(&version) && existing.is_empty();
        if highest || first {
            let readme = read.readme.as_deref().map(str::trim).filter(|r| !r.is_empty() && r.len() <= MAX_README_BYTES);
            let readme_digest = match readme {
                Some(readme) => {
                    let bytes = readme.as_bytes().to_vec();
                    let digest = Digest::of(&bytes);
                    if self.db.blob(&digest).await?.is_none() {
                        self.store.put(&digest.object_key(), bytes.clone()).await?;
                    }
                    self.db.keep_blob(&package.id, &digest, bytes.len() as u64, Some("text/markdown"), &digest.object_key(), now).await?;
                    Some(digest.to_string())
                }
                None => None,
            };
            self.db.set_readme(&package.id, readme_digest.as_deref(), spec.description.as_deref(), now).await?;
        }
        self.db.measure(&package.workspace).await?;
        let event = PackageEvent {
            version: Some(version.clone()),
            digest: Some(digest.to_string()),
            size: Some(size),
            ..self.event_of(&package)
        };
        self.announce("package.published", &package, event, &caller).await;
        self.audit(&caller, "package.publish", &package, Some(&format!("{workspace}/{}@{version}", package.name)), None).await;
        error(201, format!("{} {version} was pushed.", package.name))
    }

    /// `dotnet nuget push` of a `.snupkg`, which it sends after the
    /// `.nupkg` beside it: the symbols of a version already pushed, kept
    /// with it, and each portable PDB in it kept by its symbol server key.
    async fn nuget_symbol_push(&self, request: &mut Request, workspace: &str, viewer: Option<&User>) -> Result<Response> {
        let declared = request.headers().get("content-length")?.and_then(|n| n.parse::<u64>().ok());
        let too_large = || {
            let mb = self.max_request / 1_000_000;
            error(413, format!("A push may be at most {mb} MB. See {DOCS}#size"))
        };
        if declared.is_some_and(|n| n > self.max_request) {
            return too_large();
        }
        let content_type = request.headers().get("content-type")?;
        let body = request.bytes().await?;
        if body.len() as u64 > self.max_request {
            return too_large();
        }
        if viewer.is_none() {
            return error(401, format!("Push with a g1t access token as the API key: dotnet nuget push <file> --api-key <token>. Make one at {TOKENS}."));
        }
        let snupkg = match nuget::pushed_file(content_type.as_deref(), &body) {
            Ok(file) => file,
            Err(message) => return error(400, message),
        };
        let symbols = match nuget::read_symbols(snupkg) {
            Ok(symbols) => symbols,
            Err(message) => return error(400, message),
        };
        let spec = &symbols.nuspec;
        let Some(version) = nuget::normalize(&spec.version) else {
            return error(400, format!("{} is not a version NuGet reads.", spec.version));
        };
        let push_first = || error(404, format!("Push {} {version} before its symbols: dotnet nuget push pushes the .snupkg beside a .nupkg after it.", spec.id));
        let Some(package) = self.nuget_package(workspace, &spec.id).await? else {
            return push_first();
        };
        if let Some(refusal) = self.nuget_check(viewer, &package, Action::Push).await? {
            return Ok(refusal);
        }
        let versions = self.db.versions(&package.id, MAX_VERSIONS).await?;
        let Some(row) = versions.iter().find(|v| v.version.eq_ignore_ascii_case(&version)) else {
            return push_first();
        };
        let snupkg = snupkg.to_vec();
        let digest = Digest::of(&snupkg);
        if let Some(kept) = self.db.file(&row.id, Content::Snupkg.file()).await? {
            if kept.digest == digest.to_string() {
                return error(201, format!("The symbols of {} {} were pushed.", package.name, row.version));
            }
            return error(409, format!("{} {} already has symbols, and a version's symbols are pushed once. Bump the version.", package.name, row.version));
        }
        let mut files = vec![(Content::Snupkg.file().to_owned(), digest.clone(), snupkg)];
        for pdb in symbols.pdbs {
            let name = nuget::symbol_file(&pdb.file, &pdb.key);
            if files.iter().all(|(kept, _, _)| *kept != name) {
                files.push((name, Digest::of(&pdb.bytes), pdb.bytes));
            }
        }
        let sizes: Vec<(String, u64)> = files.iter().map(|(_, d, bytes)| (d.to_string(), bytes.len() as u64)).collect();
        if let Some(refusal) = self.storage_refusal(&package, &sizes).await? {
            return error(403, refusal);
        }
        let now = now_ms();
        for (name, digest, bytes) in files {
            let size = bytes.len() as u64;
            let stored = match self.db.blob(&digest).await? {
                Some(blob) => self.store.head(&blob.object_key).await?.is_some(),
                None => false,
            };
            if !stored {
                self.store.put(&digest.object_key(), bytes).await?;
            }
            self.db.keep_blob(&package.id, &digest, size, Some("application/octet-stream"), &digest.object_key(), now).await?;
            let file = NewFile { name, digest: digest.to_string(), size, media_type: Some("application/octet-stream".to_owned()) };
            self.db.put_file(&package.id, &row.id, &file, now).await?;
        }
        let mut metadata = row.meta();
        if metadata.is_object() {
            metadata["symbols"] = json!(true);
            self.db.set_version(&row.id, &row.digest, &metadata.to_string()).await?;
        }
        self.db.measure(&package.workspace).await?;
        let caller = Caller { actor: viewer.map(AuditActor::of) };
        self.audit(&caller, "package.publish_symbols", &package, Some(&format!("{workspace}/{}@{}", package.name, row.version)), None).await;
        error(201, format!("The symbols of {} {} were pushed.", package.name, row.version))
    }

    /// The symbol server: a PDB by its file name and key, from a package
    /// of the workspace the viewer may read.
    async fn nuget_symbol(&self, workspace: &str, file: &str, key: &str, viewer: Option<&User>, head: bool) -> Result<Response> {
        for found in self.db.files_named(workspace, NUGET, &nuget::symbol_file(file, key), 10).await? {
            let Some(package) = self.db.package_by_id(&found.package_id).await?.filter(|p| !p.hidden()) else {
                continue;
            };
            if !access::decide(viewer, &TargetOf::package(&package).view(), Action::Pull).allowed {
                continue;
            }
            let Some(digest) = Digest::parse(&found.digest) else { continue };
            let Some(blob) = self.db.package_blob(&package.id, &digest).await? else { continue };
            let headers = Headers::new();
            headers.set("content-type", "application/octet-stream")?;
            headers.set("content-length", &blob.size.to_string())?;
            headers.set("cache-control", "max-age=31536000")?;
            if head {
                return Ok(Response::from_body(ResponseBody::Empty)?.with_headers(headers));
            }
            let Some(got) = self.store.get(&blob.object_key, None).await? else { continue };
            return Ok(Response::from_body(got.body)?.with_headers(headers));
        }
        self.nuget_absent(workspace, viewer).await
    }

    /// `dotnet nuget delete` unlists a version; a `POST` lists it again.
    async fn nuget_listing(&self, workspace: &str, id: &str, version: &str, listed: bool, viewer: Option<&User>) -> Result<Response> {
        let Some(package) = self.nuget_package(workspace, id).await? else {
            return self.nuget_absent(workspace, viewer).await;
        };
        if let Some(refusal) = self.nuget_check(viewer, &package, Action::Push).await? {
            return Ok(refusal);
        }
        let wanted = nuget::normalize(version).unwrap_or_default();
        let versions = self.db.versions(&package.id, MAX_VERSIONS).await?;
        let Some(row) = versions.iter().find(|v| v.version.eq_ignore_ascii_case(&wanted)) else {
            return error(404, format!("{} {version} is not there.", package.name));
        };
        if row.is_yanked() == listed {
            self.db.set_yanked(&row.id, !listed).await?;
            self.db.touch_package(&package.id, now_ms()).await?;
            let caller = Caller { actor: viewer.map(AuditActor::of) };
            let action = if listed { "package.relist" } else { "package.unlist" };
            self.audit(&caller, action, &package, Some(&format!("{workspace}/{}@{}", package.name, row.version)), None).await;
        }
        Ok(Response::empty()?.with_status(if listed { 200 } else { 204 }))
    }
}
