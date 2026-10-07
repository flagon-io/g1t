//! The npm registry: `g1t.sh/-/npm/`, for packages scoped by workspace
//! (`@acme/web`). `.npmrc` names it for the scope, with a g1t token:
//!
//! ```text
//! @acme:registry=https://g1t.sh/-/npm/
//! //g1t.sh/-/npm/:_authToken=<token>
//! ```
//!
//! npm sends the token as `Authorization: Bearer`; Basic credentials (a
//! username and a g1t token, `_auth`) work too. Publishing is one `PUT` of
//! the packument with the tarball attached; deprecating and unpublishing a
//! version are `PUT`s of the packument as npm changed it; unpublishing a
//! package is a `DELETE`. A tarball is stored once, by its SHA-256, like
//! every file here.

use std::collections::{HashMap, HashSet};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use g1t_contracts::User;
use g1t_contracts::audit::AuditActor;
use g1t_contracts::events::PackageEvent;
use g1t_contracts::new_id;
use g1t_contracts::time::parse_rfc3339;
use g1t_kit::now_ms;
use serde_json::{Value, json};
use worker::{Context, Headers, Method, Request, Response, ResponseBody, Result, Url};

use crate::access::{self, Action};
use crate::db::{NewFile, NewVersion, PackageRow, VersionRow};
use crate::digest::Digest;
use crate::npm::{self, NpmName, NpmRoute, Packument, StoredVersion};
use crate::oci::{Credentials, origin, published_by};
use crate::store::BlobStore;
use crate::{Caller, Packages, TargetOf};

const NPM: &str = "npm";
/// The most versions a packument lists.
const MAX_VERSIONS: u32 = 2000;
/// The longest README kept for a package's page.
const MAX_README_BYTES: usize = 1024 * 1024;
const DOCS: &str = "https://docs.g1t.sh/guides/npm/";

/// npm's error shape: `{"error": "..."}`, which it prints.
fn error(status: u16, message: impl Into<String>) -> Result<Response> {
    let mut response = Response::from_json(&json!({ "error": message.into() }))?.with_status(status);
    if status == 401 {
        response.headers_mut().set("www-authenticate", "Basic realm=\"g1t\"")?;
    }
    Ok(response)
}

fn ok() -> Result<Response> {
    Response::from_json(&json!({ "ok": true }))
}

fn not_found() -> Result<Response> {
    error(404, "Not found: no such package, or you cannot see it. Private packages need a token in .npmrc.")
}

/// The decision's reason as a 403, or the not-found answer when the
/// viewer may not even read the package.
fn refused(decision: g1t_contracts::credentials::Decision, readable: bool) -> Result<Response> {
    if !readable {
        return not_found();
    }
    error(403, decision.reason.unwrap_or_else(|| "Not allowed.".to_owned()))
}

/// When a version was published, in milliseconds.
fn published_ms(version: &VersionRow) -> u64 {
    parse_rfc3339(&version.published_at).unwrap_or(0)
}

impl Packages {
    /// Answers an npm request.
    pub async fn npm(&self, request: Request, ctx: &Context) -> Result<Response> {
        let url = request.url()?;
        let Some(route) = npm::route(url.path()) else {
            return error(404, "There is nothing at this address.");
        };
        match self.npm_route(request, &url, route, ctx).await {
            Ok(response) => Ok(response),
            Err(problem) => {
                worker::console_error!("packages: npm {}: {problem}", url.path());
                error(500, "Something went wrong on our side. Try again in a moment.")
            }
        }
    }

    async fn npm_route(&self, mut request: Request, url: &Url, route: NpmRoute, ctx: &Context) -> Result<Response> {
        let method = request.method();
        let credentials = self.credentials(&request).await?;
        if matches!(method, Method::Get | Method::Head)
            && let Some(refused) = self.limited(&request, &credentials, "a token in .npmrc").await?
        {
            return Ok(refused);
        }
        let viewer = match credentials {
            Credentials::Viewer(viewer) => viewer,
            Credentials::None => None,
            // The container registry's own tokens are not npm's.
            Credentials::Token(_) | Credentials::Bad => {
                return error(401, "The token is not right, or has expired. Put a g1t access token in .npmrc: //g1t.sh/-/npm/:_authToken=<token>");
            }
        };
        match route {
            NpmRoute::Ping => Response::from_json(&json!({})),
            NpmRoute::Whoami => match viewer {
                Some(user) => Response::from_json(&json!({ "username": user.username })),
                None => error(401, "Not signed in. Put a g1t access token in .npmrc."),
            },
            NpmRoute::Login => self.npm_login(&mut request).await,
            NpmRoute::DistTags { name, tag } => {
                let name = match npm::parse_name(&name) {
                    Ok(name) => name,
                    Err(message) => return error(400, message),
                };
                self.dist_tags(&mut request, method, &name, tag.as_deref(), viewer.as_ref()).await
            }
            NpmRoute::Package { name, rev } => {
                let name = match npm::parse_name(&name) {
                    Ok(name) => name,
                    Err(message) => return error(400, message),
                };
                match (method, rev) {
                    (Method::Get | Method::Head, _) => self.packument(&request, url, &name, viewer.as_ref()).await,
                    (Method::Put, _) => self.npm_put(&mut request, &name, viewer.as_ref()).await,
                    (Method::Delete, Some(_)) => self.unpublish_package(&name, viewer.as_ref()).await,
                    _ => error(405, "Not a method this address takes."),
                }
            }
            NpmRoute::Tarball { name, file, rev } => {
                let name = match npm::parse_name(&name) {
                    Ok(name) => name,
                    Err(message) => return error(400, message),
                };
                let Some(version) = npm::version_of_file(&name, &file) else {
                    return error(404, format!("{file} is not a tarball of {}.", name.full()));
                };
                let head = method == Method::Head;
                match (method, rev) {
                    (Method::Get | Method::Head, _) => self.tarball(&name, &version, viewer.as_ref(), head, ctx).await,
                    (Method::Delete, Some(_)) => self.unpublish_tarball(&name, &version, viewer.as_ref()).await,
                    _ => error(405, "Not a method this address takes."),
                }
            }
        }
    }

    /// `npm login --auth-type=legacy`: the password has to be a g1t token,
    /// which npm then keeps and sends as its bearer token.
    async fn npm_login(&self, request: &mut Request) -> Result<Response> {
        let body: Value = request.json().await.unwrap_or_default();
        let (name, password) = (body["name"].as_str().unwrap_or(""), body["password"].as_str().unwrap_or(""));
        if !password.starts_with("g1t_") {
            return error(401, "Use a g1t access token as the password: https://g1t.sh/settings/tokens");
        }
        match self.viewer_for(name, password).await? {
            Some(user) => Ok(Response::from_json(&json!({ "ok": true, "id": format!("org.couchdb.user:{}", user.username), "token": password }))?
                .with_status(201)),
            None => error(401, "That token is not right, or has expired."),
        }
    }

    /// The package, if it is there and its workspace is not deleted.
    async fn npm_package(&self, name: &NpmName) -> Result<Option<PackageRow>> {
        Ok(self.db.package(&name.workspace, NPM, &name.name).await?.filter(|p| !p.hidden()))
    }

    /// Whether `viewer` may `action` the package, as the answer when not:
    /// 401 for someone not signed in who may not read it (npm then says to
    /// log in), 404 for anyone else who may not read it, and 403 with the
    /// reason for one who may read it but not do this.
    fn npm_check(&self, viewer: Option<&User>, package: &PackageRow, action: Action) -> Option<Result<Response>> {
        let target = TargetOf::package(package);
        let decision = access::decide(viewer, &target.view(), action);
        if decision.allowed {
            return None;
        }
        let readable = action != Action::Pull && access::decide(viewer, &target.view(), Action::Pull).allowed;
        if !readable && viewer.is_none() {
            return Some(error(401, "Sign in to use this package: put a g1t access token in .npmrc (//g1t.sh/-/npm/:_authToken=<token>)."));
        }
        Some(refused(decision, readable))
    }

    async fn stored_versions(&self, package: &PackageRow) -> Result<Vec<(VersionRow, StoredVersion)>> {
        let mut rows = self.db.versions(&package.id, MAX_VERSIONS).await?;
        rows.reverse();
        Ok(rows
            .into_iter()
            .map(|row| {
                let stored = StoredVersion {
                    version: row.version.clone(),
                    manifest: row.meta(),
                    deprecated: row.deprecated.clone(),
                    published_at: row.published_at.clone(),
                };
                (row, stored)
            })
            .collect())
    }

    async fn tag_pairs(&self, package: &PackageRow, versions: &[(VersionRow, StoredVersion)]) -> Result<Vec<(String, String)>> {
        let by_id: HashMap<&str, &str> = versions.iter().map(|(row, _)| (row.id.as_str(), row.version.as_str())).collect();
        Ok(self
            .db
            .tags(&package.id)
            .await?
            .into_iter()
            .filter_map(|tag| by_id.get(tag.version_id.as_str()).map(|version| (tag.tag, (*version).to_owned())))
            .collect())
    }

    async fn packument(&self, request: &Request, url: &Url, name: &NpmName, viewer: Option<&User>) -> Result<Response> {
        let Some(package) = self.npm_package(name).await? else {
            return not_found();
        };
        if let Some(refusal) = self.npm_check(viewer, &package, Action::Pull) {
            return refusal;
        }
        let versions = self.stored_versions(&package).await?;
        let tags = self.tag_pairs(&package, &versions).await?;
        let abbreviated = request
            .headers()
            .get("accept")?
            .is_some_and(|accept| accept.contains(npm::ABBREVIATED))
            && url.query_pairs().all(|(k, _)| k != "write");
        let readme = match (abbreviated, self.db.readme_digest(&package.id).await?.and_then(|d| Digest::parse(&d))) {
            (false, Some(digest)) => match self.db.blob(&digest).await? {
                Some(blob) => self.store.read(&blob.object_key).await?.map(|b| String::from_utf8_lossy(&b).into_owned()),
                None => None,
            },
            _ => None,
        };
        let stored: Vec<StoredVersion> = versions.into_iter().map(|(_, stored)| stored).collect();
        let base = format!("{}/-/npm", origin(url));
        let packument = Packument {
            name,
            versions: &stored,
            tags: &tags,
            created: &package.created_at,
            modified: &package.updated_at,
            readme: readme.as_deref(),
            base: &base,
        };
        if abbreviated {
            let mut response = Response::from_json(&packument.abbreviated())?;
            response.headers_mut().set("content-type", npm::ABBREVIATED)?;
            return Ok(response);
        }
        Response::from_json(&packument.full())
    }

    async fn tarball(&self, name: &NpmName, version: &str, viewer: Option<&User>, head: bool, ctx: &Context) -> Result<Response> {
        let Some(package) = self.npm_package(name).await? else {
            return not_found();
        };
        if let Some(refusal) = self.npm_check(viewer, &package, Action::Pull) {
            return refusal;
        }
        let Some(row) = self.db.version_named(&package.id, version).await? else {
            return error(404, format!("{}@{version} is not there.", name.full()));
        };
        let Some(digest) = Digest::parse(&row.digest) else {
            return error(404, format!("{}@{version} is not there.", name.full()));
        };
        let Some(blob) = self.db.package_blob(&package.id, &digest).await? else {
            return error(404, format!("{}@{version} is not there.", name.full()));
        };
        let headers = Headers::new();
        headers.set("content-type", "application/octet-stream")?;
        headers.set("content-length", &blob.size.to_string())?;
        headers.set("cache-control", "max-age=31536000")?;
        if head {
            return Ok(Response::from_body(ResponseBody::Empty)?.with_headers(headers));
        }
        let Some(got) = self.store.get(&blob.object_key, None).await? else {
            return error(404, format!("{}@{version} is not there.", name.full()));
        };
        self.count_download(&package.id, ctx);
        Ok(Response::from_body(got.body)?.with_headers(headers))
    }

    /// The package publishing makes, linked to the repository its
    /// `package.json` names on g1t, or else the one named like it.
    async fn npm_target(&self, name: &NpmName, manifest: &Value) -> Result<TargetOf> {
        let named = npm::repository_of(&manifest["repository"], &self.host)
            .filter(|(workspace, _)| workspace == &name.workspace)
            .map(|(_, repo)| repo);
        let mut repo = None;
        for candidate in named.iter().map(String::as_str).chain([name.name.as_str()]) {
            if let Some(found) = self.repo_by_name(&name.workspace, candidate).await? {
                repo = Some(found);
                break;
            }
        }
        Ok(TargetOf {
            workspace: name.workspace.clone(),
            repo: repo.map(|r| (r.id, r.name, r.is_private)),
            public: false,
        })
    }

    /// A `PUT` of the packument: a publish when a tarball is attached,
    /// otherwise npm's change of an existing one (deprecate, tags, a
    /// version unpublished).
    async fn npm_put(&self, request: &mut Request, name: &NpmName, viewer: Option<&User>) -> Result<Response> {
        let declared = request.headers().get("content-length")?.and_then(|n| n.parse::<u64>().ok());
        let too_large = || {
            let mb = self.max_request / 1_000_000;
            error(413, format!("A publish may be at most {mb} MB, tarball and package.json together. See {DOCS}#size"))
        };
        if declared.is_some_and(|n| n > self.max_request) {
            return too_large();
        }
        let bytes = request.bytes().await?;
        if bytes.len() as u64 > self.max_request {
            return too_large();
        }
        let Ok(body) = serde_json::from_slice::<Value>(&bytes) else {
            return error(400, "The body is not JSON.");
        };
        if body["name"].as_str().is_some_and(|sent| sent != name.full()) {
            return error(400, format!("The package's name is {}, not {}.", body["name"].as_str().unwrap_or(""), name.full()));
        }
        let attached = body["_attachments"].as_object().is_some_and(|a| !a.is_empty());
        if attached {
            self.publish(name, &body, viewer).await
        } else {
            self.change(name, &body, viewer).await
        }
    }

    async fn publish(&self, name: &NpmName, body: &Value, viewer: Option<&User>) -> Result<Response> {
        let Some(versions) = body["versions"].as_object().filter(|v| v.len() == 1) else {
            return error(400, "A publish names exactly one version.");
        };
        let (version, manifest) = versions.iter().next().map(|(v, m)| (v.clone(), m.clone())).unwrap_or_default();
        if !npm::valid_version(&version) {
            return error(400, format!("{version} is not a semver version."));
        }
        let Some((_, attachment)) = body["_attachments"].as_object().and_then(|a| a.iter().next()) else {
            return error(400, "The tarball is missing.");
        };
        let Some(tarball) = attachment["data"].as_str().and_then(|data| STANDARD.decode(data).ok()) else {
            return error(400, "The tarball is not base64.");
        };
        if attachment["length"].as_u64().is_some_and(|length| length != tarball.len() as u64) {
            return error(400, "The tarball's length is not what the publish says.");
        }
        let computed = npm::integrity(&tarball);
        let dist = &manifest["dist"];
        if !npm::agrees(&computed, dist["integrity"].as_str(), dist["shasum"].as_str()) {
            return error(400, "The tarball's integrity is not what the publish says. Publish again.");
        }

        let found = self.npm_package(name).await?;
        if found.is_none() && self.db.workspace_hidden(&name.workspace).await? {
            return error(403, format!("The workspace {} is deleted; nothing can be published to it.", name.workspace));
        }
        let target = match &found {
            Some(package) => TargetOf::package(package),
            None => self.npm_target(name, &manifest).await?,
        };
        let decision = access::decide(viewer, &target.view(), Action::Push);
        if !decision.allowed {
            let readable = access::decide(viewer, &target.view(), Action::Pull).allowed || found.is_none();
            return refused(decision, readable);
        }
        let caller = Caller { actor: viewer.map(AuditActor::of) };
        let package = match found {
            Some(package) => package,
            None => {
                self.db
                    .create_package(
                        &new_id("pkg", now_ms()),
                        &name.workspace,
                        NPM,
                        &name.name,
                        target.repo.as_ref().map(|(id, repo, private)| (id.as_str(), repo.as_str(), *private)),
                        caller.actor.as_ref().map_or("", |actor| actor.actor_id.as_str()),
                        now_ms(),
                    )
                    .await?
            }
        };
        if self.db.version_named(&package.id, &version).await?.is_some() {
            return error(403, format!("You cannot publish over the previously published version {version}. Bump the version in package.json."));
        }

        let digest = Digest::of(&tarball);
        let size = tarball.len() as u64;
        if let Some(refusal) = self.storage_refusal(&package, &[(digest.to_string(), size)]).await? {
            return error(403, refusal);
        }
        let now = now_ms();
        let stored = match self.db.blob(&digest).await? {
            Some(blob) => self.store.head(&blob.object_key).await?.is_some(),
            None => false,
        };
        if !stored {
            self.store.put(&digest.object_key(), tarball).await?;
        }
        self.db
            .keep_blob(&package.id, &digest, size, Some("application/octet-stream"), &digest.object_key(), now)
            .await?;

        // The dist-tags that point to this version; `latest` when none.
        let mut tags: Vec<String> = body["dist-tags"]
            .as_object()
            .map(|tags| {
                tags.iter()
                    .filter(|(tag, v)| v.as_str() == Some(version.as_str()) && npm::valid_tag(tag))
                    .map(|(tag, _)| tag.clone())
                    .collect()
            })
            .unwrap_or_default();
        if tags.is_empty() {
            tags.push("latest".to_owned());
        }
        let (row, _) = self
            .db
            .publish(
                NewVersion {
                    id: new_id("ver", now),
                    package_id: package.id.clone(),
                    version: version.clone(),
                    digest: digest.to_string(),
                    size,
                    metadata: npm::stored_manifest(&manifest, &computed).to_string(),
                    subject: None,
                    published_by: published_by(&caller),
                    files: vec![NewFile {
                        name: "tarball".to_owned(),
                        digest: digest.to_string(),
                        size,
                        media_type: Some("application/octet-stream".to_owned()),
                    }],
                },
                Some(&tags[0]),
                now,
            )
            .await?;
        for tag in &tags[1..] {
            self.db.set_tag(&package.id, tag, &row.id, now).await?;
        }
        // The README the package page shows: the latest version's.
        if tags.iter().any(|tag| tag == "latest") {
            let readme = body["readme"].as_str().or(manifest["readme"].as_str()).unwrap_or("").trim();
            let description = manifest["description"].as_str();
            let readme_digest = if readme.is_empty() || readme == "ERROR: No README data found!" || readme.len() > MAX_README_BYTES {
                None
            } else {
                let bytes = readme.as_bytes().to_vec();
                let digest = Digest::of(&bytes);
                if self.db.blob(&digest).await?.is_none() {
                    self.store.put(&digest.object_key(), bytes.clone()).await?;
                }
                self.db
                    .keep_blob(&package.id, &digest, bytes.len() as u64, Some("text/markdown"), &digest.object_key(), now)
                    .await?;
                Some(digest.to_string())
            };
            self.db.set_readme(&package.id, readme_digest.as_deref(), description, now).await?;
        }
        self.db.measure(&package.workspace).await?;
        let event = PackageEvent {
            version: Some(version.clone()),
            digest: Some(digest.to_string()),
            size: Some(size),
            tags: Some(tags.clone()),
            ..self.event_of(&package)
        };
        self.announce("package.published", &package, event, &caller).await;
        self.audit(&caller, "package.publish", &package, Some(&format!("{}@{version}", name.full())), None).await;
        Ok(Response::from_json(&json!({ "ok": true, "id": name.full(), "rev": format!("1-{}", &digest.hex()[..16]) }))?.with_status(201))
    }

    /// npm's change of a packument it read: versions it left out are
    /// unpublished, `deprecated` set or cleared, dist-tags made to match.
    async fn change(&self, name: &NpmName, body: &Value, viewer: Option<&User>) -> Result<Response> {
        let Some(package) = self.npm_package(name).await? else {
            return not_found();
        };
        if let Some(refusal) = self.npm_check(viewer, &package, Action::Push) {
            return refusal;
        }
        let Some(sent) = body["versions"].as_object() else {
            return error(400, "The packument names no versions.");
        };
        let caller = Caller { actor: viewer.map(AuditActor::of) };
        let admin = access::decide(viewer, &TargetOf::package(&package).view(), Action::Delete).allowed;
        let now = now_ms();
        let versions = self.stored_versions(&package).await?;
        let removed: Vec<&VersionRow> = versions.iter().map(|(row, _)| row).filter(|row| !sent.contains_key(&row.version)).collect();
        if let Some(late) = removed.iter().find(|row| !npm::may_unpublish(published_ms(row), now, admin)) {
            return error(
                403,
                format!("{}@{} was published more than 72 hours ago: unpublishing it needs the Admin role. Deprecate it instead.", name.full(), late.version),
            );
        }
        for (row, stored) in &versions {
            let Some(version) = sent.get(&row.version) else { continue };
            let wanted = version["deprecated"].as_str().filter(|m| !m.is_empty()).map(str::to_owned);
            if wanted != stored.deprecated {
                self.db.set_deprecated(&row.id, wanted.as_deref()).await?;
                let action = if wanted.is_some() { "package.deprecate" } else { "package.undeprecate" };
                self.audit(&caller, action, &package, Some(&format!("{}@{}", name.full(), row.version)), None).await;
            }
        }
        for row in &removed {
            self.remove_version(&package, row, &caller).await?;
        }
        // The dist-tags, as sent, for the versions that are left.
        if let Some(tags) = body["dist-tags"].as_object() {
            let left: HashMap<&str, &str> = versions
                .iter()
                .filter(|(row, _)| sent.contains_key(&row.version))
                .map(|(row, _)| (row.version.as_str(), row.id.as_str()))
                .collect();
            let current = self.tag_pairs(&package, &versions).await?;
            let mut wanted = HashSet::new();
            for (tag, version) in tags {
                let Some(id) = version.as_str().and_then(|v| left.get(v)) else { continue };
                wanted.insert(tag.as_str());
                if !current.iter().any(|(t, v)| t == tag && Some(v.as_str()) == version.as_str()) {
                    self.db.set_tag(&package.id, tag, id, now).await?;
                }
            }
            for (tag, _) in current.iter().filter(|(tag, _)| !wanted.contains(tag.as_str())) {
                self.db.delete_tag(&package.id, tag).await?;
            }
        }
        self.db.touch_package(&package.id, now).await?;
        ok()
    }

    async fn unpublish_package(&self, name: &NpmName, viewer: Option<&User>) -> Result<Response> {
        let Some(package) = self.npm_package(name).await? else {
            return not_found();
        };
        if let Some(refusal) = self.npm_check(viewer, &package, Action::Push) {
            return refusal;
        }
        let admin = access::decide(viewer, &TargetOf::package(&package).view(), Action::Delete).allowed;
        let now = now_ms();
        let versions = self.db.versions(&package.id, MAX_VERSIONS).await?;
        if let Some(late) = versions.iter().find(|row| !npm::may_unpublish(published_ms(row), now, admin)) {
            return error(
                403,
                format!("{}@{} was published more than 72 hours ago: unpublishing the package needs the Admin role.", name.full(), late.version),
            );
        }
        let caller = Caller { actor: viewer.map(AuditActor::of) };
        self.db.delete_package(&package.id).await?;
        self.db.measure(&package.workspace).await?;
        self.announce("package.deleted", &package, self.event_of(&package), &caller).await;
        self.audit(&caller, "package.delete", &package, Some(&name.full()), None).await;
        ok()
    }

    /// The last step of `npm unpublish <name>@<version>`: the packument
    /// without the version was sent first, so usually it is gone already.
    async fn unpublish_tarball(&self, name: &NpmName, version: &str, viewer: Option<&User>) -> Result<Response> {
        let Some(package) = self.npm_package(name).await? else {
            return ok();
        };
        if let Some(refusal) = self.npm_check(viewer, &package, Action::Push) {
            return refusal;
        }
        let Some(row) = self.db.version_named(&package.id, version).await? else {
            return ok();
        };
        let admin = access::decide(viewer, &TargetOf::package(&package).view(), Action::Delete).allowed;
        if !npm::may_unpublish(published_ms(&row), now_ms(), admin) {
            return error(403, format!("{}@{version} was published more than 72 hours ago: unpublishing it needs the Admin role.", name.full()));
        }
        let caller = Caller { actor: viewer.map(AuditActor::of) };
        self.remove_version(&package, &row, &caller).await?;
        ok()
    }

    async fn dist_tags(&self, request: &mut Request, method: Method, name: &NpmName, tag: Option<&str>, viewer: Option<&User>) -> Result<Response> {
        let Some(package) = self.npm_package(name).await? else {
            return not_found();
        };
        let action = if matches!(method, Method::Get | Method::Head) { Action::Pull } else { Action::Push };
        if let Some(refusal) = self.npm_check(viewer, &package, action) {
            return refusal;
        }
        let versions = self.stored_versions(&package).await?;
        match (method, tag) {
            (Method::Get | Method::Head, None) => {
                let tags = self.tag_pairs(&package, &versions).await?;
                Response::from_json(&Value::Object(tags.into_iter().map(|(t, v)| (t, json!(v))).collect()))
            }
            (Method::Put | Method::Post, Some(tag)) => {
                if !npm::valid_tag(tag) {
                    return error(400, format!("{tag} is not a valid tag: it may not look like a version."));
                }
                let body: Value = request.json().await.unwrap_or_default();
                let Some(version) = body.as_str() else {
                    return error(400, "Send the version the tag points to, as a JSON string.");
                };
                let Some((row, _)) = versions.iter().find(|(row, _)| row.version == version) else {
                    return error(404, format!("{}@{version} is not there.", name.full()));
                };
                self.db.set_tag(&package.id, tag, &row.id, now_ms()).await?;
                self.db.touch_package(&package.id, now_ms()).await?;
                ok()
            }
            (Method::Delete, Some(tag)) => {
                if tag == "latest" {
                    return error(400, "The latest tag cannot be removed; point it at another version instead.");
                }
                self.db.delete_tag(&package.id, tag).await?;
                self.db.touch_package(&package.id, now_ms()).await?;
                ok()
            }
            _ => error(405, "Not a method this address takes."),
        }
    }
}
