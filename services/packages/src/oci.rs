//! The container registry: OCI Distribution 1.1 on `g1t.sh/v2/`.
//!
//! A client is sent to `/v2/token` first (the `WWW-Authenticate`
//! challenge), and comes back with a bearer token naming what it may do;
//! Basic credentials and g1t tokens are taken on every endpoint too, for
//! clients that send them straight away. Pulls of public images need
//! neither.

use futures_util::StreamExt;
use g1t_contracts::audit::AuditActor;
use g1t_contracts::events::PackageEvent;
use g1t_contracts::packages::Ecosystem;
use g1t_contracts::time::rfc3339;
use g1t_contracts::{Viewer, new_id};
use g1t_kit::now_ms;
use serde_json::{Value, json};
use worker::{Context, Headers, Method, Request, Response, ResponseBody, Result, Url};

use crate::access::{self, Action};
use crate::limits;
use crate::db::{NewFile, NewVersion, PackageRow, UploadRow};
use crate::digest::{Digest, Sha256};
use crate::manifest::{self, Kind};
use crate::names::{self, ImageName, Reference, Route};
use crate::range;
use crate::store::BlobStore;
use crate::token::{self, Claims, Grant};
use crate::upload::{self, Finished, Progress, Writer};
use crate::{Caller, Packages, TargetOf};

const CONTAINER: &str = "container";
/// Blobs larger than this are downloaded from the store directly when it
/// can sign a URL.
const REDIRECT_BYTES: u64 = 4 * 1024 * 1024;
/// How long a signed download URL works.
const REDIRECT_SECONDS: u32 = 10 * 60;
/// The most tags one page lists.
const MAX_TAGS_PAGE: u32 = 1000;
const DOCS: &str = "https://docs.g1t.sh/guides/containers/";

/// An answer in the registry's error format: `{"errors": [...]}`.
pub fn error(status: u16, code: &str, message: impl Into<String>) -> Result<Response> {
    let body = json!({ "errors": [{ "code": code, "message": message.into(), "detail": null }] });
    Ok(Response::from_json(&body)?.with_status(status))
}

fn respond(status: u16, headers: &[(&str, String)], body: ResponseBody) -> Result<Response> {
    let set = Headers::new();
    for (name, value) in headers {
        set.set(name, value)?;
    }
    Ok(Response::from_body(body)?.with_status(status).with_headers(set))
}

fn empty(status: u16, headers: &[(&str, String)]) -> Result<Response> {
    respond(status, headers, ResponseBody::Empty)
}

/// Who the request comes from, as its headers say.
pub(crate) enum Credentials {
    None,
    /// One of this registry's tokens.
    Token(Claims),
    /// A g1t token or password, resolved.
    Viewer(Viewer),
    /// Credentials that are wrong, or a token that expired.
    Bad,
}

impl Credentials {
    fn anonymous(&self) -> bool {
        matches!(self, Credentials::None) || matches!(self, Credentials::Token(claims) if claims.actor.is_none())
    }
}

/// `scheme://host`, as the client reached the registry.
pub(crate) fn origin(url: &Url) -> String {
    let host = url.host_str().unwrap_or("g1t.sh");
    match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    }
}

fn service_name(url: &Url) -> String {
    match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or("g1t.sh")),
        None => url.host_str().unwrap_or("g1t.sh").to_owned(),
    }
}

/// The challenge that sends a client to get a token.
fn challenge(url: &Url, scope: Option<String>) -> String {
    let mut text = format!("Bearer realm=\"{}/v2/token\",service=\"{}\"", origin(url), service_name(url));
    if let Some(scope) = scope {
        text.push_str(&format!(",scope=\"{scope}\""));
    }
    text
}

fn unauthorized(url: &Url, scope: Option<String>, message: &str) -> Result<Response> {
    let mut response = error(401, "UNAUTHORIZED", message)?;
    response.headers_mut().set("www-authenticate", &challenge(url, scope))?;
    Ok(response)
}

fn query(url: &Url, key: &str) -> Option<String> {
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

/// The audit actor a version's `published_by` names.
pub(crate) fn published_by(caller: &Caller) -> Option<String> {
    caller.actor.as_ref().map(|actor| actor.on_behalf_of.clone().unwrap_or_else(|| actor.actor.clone()))
}

fn too_large(limit: u64) -> Result<Response> {
    let mb = limit / 1_000_000;
    error(
        413,
        "SIZE_INVALID",
        format!(
            "A request to this registry may hold at most {mb} MB, and this one holds more. `docker push` sends each layer in one request, so a layer has to be under {mb} MB. See {DOCS}#the-{mb}-mb-limit"
        ),
    )
}

impl Packages {
    /// Answers a registry request.
    pub async fn registry(&self, request: Request, ctx: &Context) -> Result<Response> {
        let url = request.url()?;
        let Some(route) = names::route(url.path()) else {
            return error(404, "NAME_UNKNOWN", "There is nothing at this address.");
        };
        let mut response = match self.route(request, &url, route, ctx).await {
            Ok(response) => response,
            Err(problem) => {
                worker::console_error!("packages: {} {}: {problem}", url.path(), problem);
                error(500, "UNKNOWN", "Something went wrong on our side. Try again in a moment.")?
            }
        };
        response.headers_mut().set("docker-distribution-api-version", "registry/2.0")?;
        Ok(response)
    }

    async fn route(&self, mut request: Request, url: &Url, route: Route, ctx: &Context) -> Result<Response> {
        let method = request.method();
        let credentials = self.credentials(&request).await?;
        if limits::counts(&method, &route)
            && let Some(refused) = self.limited(&request, &credentials, "`docker login g1t.sh`").await?
        {
            return Ok(refused);
        }
        if let Route::Base = route {
            return match credentials {
                Credentials::Token(_) | Credentials::Viewer(Some(_)) => Ok(Response::from_json(&json!({}))?),
                _ => unauthorized(url, None, "Sign in with `docker login`, a g1t token as the password."),
            };
        }
        if let Route::Token = route {
            // Docker's OAuth form: `grant_type=password` with the username
            // and password in the body, and the scopes beside them.
            if method == Method::Post {
                let form = request.text().await.unwrap_or_default();
                let fields: Vec<(String, String)> = Url::parse(&format!("http://form/?{form}"))?
                    .query_pairs()
                    .map(|(k, v)| (k.into_owned(), v.into_owned()))
                    .collect();
                let field = |key: &str| fields.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
                let credentials = match (field("grant_type").as_deref(), field("username"), field("password")) {
                    (Some("password"), Some(username), Some(password)) => match self.viewer_for(&username, &password).await? {
                        Some(user) => Credentials::Viewer(Some(user)),
                        None => Credentials::Bad,
                    },
                    (Some("password"), ..) | (Some("refresh_token"), ..) => Credentials::Bad,
                    _ => credentials,
                };
                let scopes: Vec<String> = fields.iter().filter(|(k, _)| k == "scope").map(|(_, v)| v.clone()).collect();
                return self.issue(url, credentials, &scopes).await;
            }
            let scopes: Vec<String> = url.query_pairs().filter(|(k, _)| k == "scope").map(|(_, v)| v.into_owned()).collect();
            return self.issue(url, credentials, &scopes).await;
        }
        let (name, action) = match &route {
            Route::Manifest { name, .. } => (name, match method {
                Method::Get | Method::Head => Action::Pull,
                Method::Put => Action::Push,
                Method::Delete => Action::Delete,
                _ => return error(405, "UNSUPPORTED", "Not a method manifests take."),
            }),
            Route::Blob { name, .. } => (name, match method {
                Method::Get | Method::Head => Action::Pull,
                Method::Delete => Action::Delete,
                _ => return error(405, "UNSUPPORTED", "Not a method blobs take."),
            }),
            Route::Uploads { name } | Route::Upload { name, .. } => (name, Action::Push),
            Route::Tags { name } | Route::Referrers { name, .. } => (name, Action::Pull),
            Route::Base | Route::Token => unreachable!("answered above"),
        };
        let name = match names::parse_name(name) {
            Ok(name) => name,
            Err(message) => return error(400, "NAME_INVALID", message),
        };
        let found = self.db.package(&name.workspace, CONTAINER, &name.name).await?;
        // A deleted workspace's images are gone for everyone until it is
        // restored: pulls find nothing, and nothing new is pushed to it.
        let hidden = match &found {
            Some(package) => package.hidden(),
            None => action == Action::Push && self.db.workspace_hidden(&name.workspace).await?,
        };
        if hidden {
            return if action == Action::Pull {
                error(404, "NAME_UNKNOWN", format!("There is no image {}.", name.full()))
            } else {
                error(403, "DENIED", format!("The workspace {} is deleted; nothing can be pushed to it or deleted from it.", name.workspace))
            };
        }
        let caller = match self.authorize(url, &credentials, &name, found.as_ref(), action).await? {
            Ok(caller) => caller,
            Err(refused) => return Ok(refused),
        };
        match route {
            Route::Manifest { reference, .. } => match method {
                Method::Put => self.put_manifest(&mut request, &name, found, &reference, &caller).await,
                Method::Delete => self.delete_manifest(&name, found, &reference, &caller).await,
                _ => self.get_manifest(&name, found, &reference, method == Method::Head, ctx).await,
            },
            Route::Blob { digest, .. } => {
                let Some(digest) = Digest::parse(&digest) else {
                    return error(400, "DIGEST_INVALID", format!("{digest} is not a sha256 digest."));
                };
                let Some(package) = found else {
                    return error(404, "BLOB_UNKNOWN", "No such blob in this image.");
                };
                match method {
                    Method::Delete => self.delete_blob(&package, &digest).await,
                    _ => self.get_blob(&request, &package, &digest, method == Method::Head).await,
                }
            }
            Route::Uploads { .. } => {
                if method != Method::Post {
                    return error(405, "UNSUPPORTED", "Start an upload with POST.");
                }
                self.start_upload(request, url, &name, found, &credentials, &caller).await
            }
            Route::Upload { id, .. } => {
                let Some(row) = self.db.upload(&id).await?.filter(|row| row.package == name.full()) else {
                    return error(404, "BLOB_UPLOAD_UNKNOWN", "No such upload; it may have finished or expired. Start again.");
                };
                match method {
                    Method::Patch => self.patch_upload(request, &name, row).await,
                    Method::Put => match found {
                        Some(package) => self.finish_upload(request, url, &name, &package, row).await,
                        None => {
                            self.cancel_upload(row).await?;
                            error(404, "NAME_UNKNOWN", format!("{} was deleted while this upload was open.", name.full()))
                        }
                    },
                    Method::Get => upload_status(&name, &row),
                    Method::Delete => self.cancel_upload(row).await,
                    _ => error(405, "UNSUPPORTED", "Not a method uploads take."),
                }
            }
            Route::Tags { .. } => self.tags(url, &name, found).await,
            Route::Referrers { digest, .. } => self.referrers(url, &name, found, &digest).await,
            Route::Base | Route::Token => unreachable!("answered above"),
        }
    }

    /// The 429 for a client past its limit, if it is. A limit that is not
    /// configured (self-hosted) or cannot be asked lets the request through.
    /// `sign_in` is how a client of this registry signs in, for the message.
    pub(crate) async fn limited(&self, request: &Request, credentials: &Credentials, sign_in: &str) -> Result<Option<Response>> {
        let subject = match credentials {
            Credentials::Token(claims) => claims.actor.as_ref().map(|actor| actor.actor_id.clone()),
            Credentials::Viewer(Some(user)) => Some(user.id.clone()),
            _ => None,
        };
        let address = request.headers().get("cf-connecting-ip")?;
        let (limit, key) = limits::key(subject.as_deref(), address.as_deref());
        let Ok(limiter) = self.env.rate_limiter(limit.binding()) else {
            return Ok(None);
        };
        match limiter.limit(key).await {
            Ok(outcome) if !outcome.success => {
                let mut response = error(
                    429,
                    "TOOMANYREQUESTS",
                    match limit {
                        limits::Limit::Anonymous => format!("Too many requests from this address. Wait a minute, or sign in with {sign_in} for a higher limit."),
                        limits::Limit::Signed => "Too many requests. Wait a minute and try again.".to_owned(),
                    },
                )?;
                response.headers_mut().set("retry-after", &limits::RETRY_AFTER_SECONDS.to_string())?;
                Ok(Some(response))
            }
            Ok(_) => Ok(None),
            Err(problem) => {
                worker::console_error!("packages: the rate limit could not be asked: {problem}");
                Ok(None)
            }
        }
    }

    pub(crate) async fn credentials(&self, request: &Request) -> Result<Credentials> {
        let Some(header) = request.headers().get("authorization")? else {
            return Ok(Credentials::None);
        };
        if let Some(bearer) = token::bearer(&header) {
            if token::is_registry_token(bearer) {
                return Ok(match token::verify(bearer, &self.secret, now_ms() / 1000) {
                    Some(claims) => Credentials::Token(claims),
                    None => Credentials::Bad,
                });
            }
            return Ok(match self.viewer_for("token", bearer).await? {
                Some(user) => Credentials::Viewer(Some(user)),
                None => Credentials::Bad,
            });
        }
        if let Some((username, secret)) = token::basic(&header) {
            return Ok(match self.viewer_for(&username, &secret).await? {
                Some(user) => Credentials::Viewer(Some(user)),
                None => Credentials::Bad,
            });
        }
        Ok(Credentials::Bad)
    }

    /// Whether the request may do `action` to the image, and as whom.
    async fn authorize(
        &self,
        url: &Url,
        credentials: &Credentials,
        name: &ImageName,
        found: Option<&PackageRow>,
        action: Action,
    ) -> Result<std::result::Result<Caller, Response>> {
        let scope = Some(format!("repository:{}:{}", name.full(), match action {
            Action::Pull => "pull",
            Action::Push => "pull,push",
            Action::Delete => "delete",
        }));
        let viewer = match credentials {
            Credentials::Bad => {
                return Ok(Err(unauthorized(url, scope, "The token or password is not right, or has expired. Sign in again with `docker login`.")?));
            }
            Credentials::Token(claims) => {
                if claims.allows(&name.full(), action) {
                    return Ok(Ok(Caller { actor: claims.actor.clone() }));
                }
                // A token for something else still pulls a public image.
                if action == Action::Pull && found.is_some_and(|package| package.public()) {
                    return Ok(Ok(Caller { actor: claims.actor.clone() }));
                }
                if credentials.anonymous() {
                    return Ok(Err(unauthorized(url, scope, "Sign in with `docker login` to do that.")?));
                }
                return Ok(Err(error(403, "DENIED", format!("This token may not {} {}.", action.as_str(), name.full()))?));
            }
            Credentials::Viewer(viewer) => viewer.clone(),
            Credentials::None => None,
        };
        let target = self.target(name, found).await?;
        let decision = access::decide(viewer.as_ref(), &target.view(), action);
        if decision.allowed {
            return Ok(Ok(Caller { actor: viewer.as_ref().map(AuditActor::of) }));
        }
        let reason = decision.reason.unwrap_or_else(|| "Not allowed.".to_owned());
        if viewer.is_none() {
            return Ok(Err(unauthorized(url, scope, &reason)?));
        }
        Ok(Err(error(403, "DENIED", reason)?))
    }

    /// `GET /v2/token`: a token for each scope asked for, cut down to what
    /// the credentials may do.
    async fn issue(&self, url: &Url, credentials: Credentials, asked: &[String]) -> Result<Response> {
        let viewer = match credentials {
            Credentials::Viewer(viewer) => viewer,
            Credentials::None => None,
            // A registry token is not a way to get another.
            Credentials::Token(_) | Credentials::Bad => {
                return unauthorized(url, None, "The username or token is not right. Use a g1t token as the password.");
            }
        };
        let mut access: Vec<Grant> = Vec::new();
        let scopes: Vec<String> = asked.iter().flat_map(|value| value.split(' ').map(str::to_owned)).collect();
        for scope in scopes.iter().take(20) {
            let Some((full, wanted)) = token::parse_scope(scope) else { continue };
            let Ok(name) = names::parse_name(&full) else { continue };
            let found = self.db.package(&name.workspace, CONTAINER, &name.name).await?;
            // Nothing is granted on a deleted workspace's images.
            if found.as_ref().is_some_and(|package| package.hidden()) {
                continue;
            }
            let target = self.target(&name, found.as_ref()).await?;
            let actions: Vec<Action> = wanted
                .into_iter()
                .filter(|action| access::decide(viewer.as_ref(), &target.view(), *action).allowed)
                .collect();
            if let Some(grant) = access.iter_mut().find(|grant| grant.name == full) {
                for action in actions {
                    if !grant.actions.contains(&action) {
                        grant.actions.push(action);
                    }
                }
            } else {
                access.push(Grant { name: full, actions });
            }
        }
        let now = now_ms();
        let claims = Claims {
            actor: viewer.as_ref().map(AuditActor::of),
            access,
            iat: now / 1000,
            exp: now / 1000 + token::TTL_SECONDS,
        };
        let signed = token::sign(&claims, &self.secret);
        Response::from_json(&json!({
            "token": signed,
            "access_token": signed,
            "expires_in": token::TTL_SECONDS,
            "issued_at": rfc3339(now),
        }))
    }

    /// The package for an image, made on its first push and linked to the
    /// repository of the image's name when there is one.
    async fn package_for_push(&self, name: &ImageName, found: Option<PackageRow>, caller: &Caller) -> Result<PackageRow> {
        if let Some(found) = found {
            return Ok(found);
        }
        let repo = self.repo_by_name(&name.workspace, name.repo_name()).await?;
        self.db
            .create_package(
                &new_id("pkg", now_ms()),
                &name.workspace,
                CONTAINER,
                &name.name,
                repo.as_ref().map(|repo| (repo.id.as_str(), repo.name.as_str(), repo.is_private)),
                caller.actor.as_ref().map_or("", |actor| actor.actor_id.as_str()),
                now_ms(),
            )
            .await
    }

    async fn get_manifest(
        &self,
        name: &ImageName,
        found: Option<PackageRow>,
        reference: &str,
        head: bool,
        ctx: &Context,
    ) -> Result<Response> {
        let Some(package) = found else {
            return error(404, "NAME_UNKNOWN", format!("There is no image {}.", name.full()));
        };
        let version = match Reference::parse(reference) {
            Some(Reference::Tag(tag)) => self.db.version_by_tag(&package.id, &tag).await?,
            Some(Reference::Digest(digest)) => self.db.version_by_digest(&package.id, digest.as_str()).await?,
            None => return error(400, "MANIFEST_INVALID", format!("{reference} is not a tag or a digest.")),
        };
        let Some(version) = version else {
            return error(404, "MANIFEST_UNKNOWN", format!("{}:{reference} is not there.", name.full()));
        };
        let digest = Digest::parse(&version.digest).ok_or_else(|| worker::Error::RustError("a stored digest is malformed".into()))?;
        let Some(blob) = self.db.blob(&digest).await? else {
            return error(404, "MANIFEST_UNKNOWN", format!("{}:{reference} is not there.", name.full()));
        };
        let headers = [
            ("content-type", version.media_type().unwrap_or_else(|| manifest::OCI_MANIFEST.to_owned())),
            ("docker-content-digest", version.digest.clone()),
            ("etag", format!("\"{}\"", version.digest)),
            ("content-length", blob.size.to_string()),
        ];
        if head {
            return empty(200, &headers);
        }
        let Some(bytes) = self.store.read(&blob.object_key).await? else {
            return error(404, "MANIFEST_UNKNOWN", format!("{}:{reference} is not there.", name.full()));
        };
        self.count_download(&package.id, ctx);
        respond(200, &headers, ResponseBody::Body(bytes))
    }

    async fn put_manifest(
        &self,
        request: &mut Request,
        name: &ImageName,
        found: Option<PackageRow>,
        reference: &str,
        caller: &Caller,
    ) -> Result<Response> {
        let reference = match Reference::parse(reference) {
            Some(reference) => reference,
            None => return error(400, "TAG_INVALID", format!("{reference} is not a valid tag.")),
        };
        let bytes = request.bytes().await?;
        if bytes.len() > manifest::MAX_MANIFEST_BYTES {
            return error(413, "SIZE_INVALID", "A manifest is at most 4 MiB.");
        }
        let digest = Digest::of(&bytes);
        if let Reference::Digest(given) = &reference
            && given != &digest
        {
            return error(400, "DIGEST_INVALID", format!("The manifest's digest is {digest}, not {given}."));
        }
        let content_type = request.headers().get("content-type")?;
        let parsed = match manifest::parse(&bytes, content_type.as_deref()) {
            Ok(parsed) => parsed,
            Err(manifest::Refused::Invalid(message)) => return error(400, "MANIFEST_INVALID", message),
            Err(manifest::Refused::Unsupported(message)) => return error(415, "UNSUPPORTED", message),
        };
        let package = self.package_for_push(name, found, caller).await?;
        let mut files = vec![NewFile {
            name: "manifest".to_owned(),
            digest: digest.to_string(),
            size: bytes.len() as u64,
            media_type: Some(parsed.media_type.clone()),
        }];
        match parsed.kind {
            Kind::Image => {
                let mut layer = 0;
                for blob in &parsed.blobs {
                    let Some(stored) = self.db.package_blob(&package.id, &blob.digest).await? else {
                        return error(400, "MANIFEST_BLOB_UNKNOWN", format!("Blob {} is not in {}: push it first.", blob.digest, name.full()));
                    };
                    let file_name = if blob.role == "config" {
                        "config".to_owned()
                    } else {
                        layer += 1;
                        format!("layer:{layer}")
                    };
                    files.push(NewFile { name: file_name, digest: blob.digest.to_string(), size: stored.size, media_type: blob.media_type.clone() });
                }
            }
            Kind::Index => {
                for child in &parsed.manifests {
                    if self.db.version_by_digest(&package.id, child.digest.as_str()).await?.is_none() {
                        return error(400, "MANIFEST_UNKNOWN", format!("Manifest {} is not in {}: push it first.", child.digest, name.full()));
                    }
                }
            }
        }
        let pushed: Vec<(String, u64)> = files.iter().map(|file| (file.digest.clone(), file.size)).collect();
        if let Some(refused) = self.storage_refusal(&package, &pushed).await? {
            return error(403, "DENIED", refused);
        }
        if self.db.blob(&digest).await?.is_none() {
            self.store.put(&digest.object_key(), bytes.clone()).await?;
        }
        let now = now_ms();
        self.db
            .keep_blob(&package.id, &digest, bytes.len() as u64, Some(&parsed.media_type), &digest.object_key(), now)
            .await?;
        let size = files.iter().map(|file| file.size).sum();
        let metadata = json!({
            "media_type": parsed.media_type,
            "artifact_type": parsed.artifact_type,
            "annotations": parsed.annotations,
            "platforms": parsed.platforms,
        });
        let tag = match &reference {
            Reference::Tag(tag) => Some(tag.as_str()),
            Reference::Digest(_) => None,
        };
        let (version, changed) = self
            .db
            .publish(
                NewVersion {
                    id: new_id("ver", now),
                    package_id: package.id.clone(),
                    version: digest.to_string(),
                    digest: digest.to_string(),
                    size,
                    metadata: metadata.to_string(),
                    subject: parsed.subject.as_ref().map(Digest::to_string),
                    published_by: published_by(caller),
                    files,
                },
                tag,
                now,
            )
            .await?;
        self.db.measure(&package.workspace).await?;
        if changed {
            let tags: Vec<String> = self
                .db
                .tags(&package.id)
                .await?
                .into_iter()
                .filter(|row| row.version_id == version.id)
                .map(|row| row.tag)
                .collect();
            let event = PackageEvent {
                version: Some(version.version.clone()),
                digest: Some(version.digest.clone()),
                size: Some(version.size),
                tags: Some(tags),
                ..self.event_of(&package)
            };
            self.announce("package.published", &package, event, caller).await;
            self.audit(caller, "package.publish", &package, Some(&format!("{}@{}", name.full(), version.digest)), None)
                .await;
        }
        let mut headers = vec![
            ("location", format!("/v2/{}/manifests/{digest}", name.full())),
            ("docker-content-digest", digest.to_string()),
        ];
        if let Some(subject) = &parsed.subject {
            headers.push(("oci-subject", subject.to_string()));
        }
        empty(201, &headers)
    }

    async fn delete_manifest(&self, name: &ImageName, found: Option<PackageRow>, reference: &str, caller: &Caller) -> Result<Response> {
        let Some(package) = found else {
            return error(404, "NAME_UNKNOWN", format!("There is no image {}.", name.full()));
        };
        match Reference::parse(reference) {
            Some(Reference::Tag(tag)) => {
                if self.db.version_by_tag(&package.id, &tag).await?.is_none() {
                    return error(404, "MANIFEST_UNKNOWN", format!("{}:{tag} is not there.", name.full()));
                }
                self.db.delete_tag(&package.id, &tag).await?;
                self.audit(caller, "package.untag", &package, Some(&format!("{}:{tag}", name.full())), None).await;
                empty(202, &[])
            }
            Some(Reference::Digest(digest)) => {
                let Some(version) = self.db.version_by_digest(&package.id, digest.as_str()).await? else {
                    return error(404, "MANIFEST_UNKNOWN", format!("{}@{digest} is not there.", name.full()));
                };
                self.remove_version(&package, &version, caller).await?;
                empty(202, &[])
            }
            None => error(400, "MANIFEST_INVALID", format!("{reference} is not a tag or a digest.")),
        }
    }

    async fn get_blob(&self, request: &Request, package: &PackageRow, digest: &Digest, head: bool) -> Result<Response> {
        let Some(blob) = self.db.package_blob(&package.id, digest).await? else {
            return error(404, "BLOB_UNKNOWN", format!("Blob {digest} is not in this image."));
        };
        let mut headers = vec![
            ("docker-content-digest", digest.to_string()),
            ("content-type", "application/octet-stream".to_owned()),
            ("accept-ranges", "bytes".to_owned()),
            ("etag", format!("\"{digest}\"")),
            ("cache-control", "max-age=31536000".to_owned()),
        ];
        if head {
            headers.push(("content-length", blob.size.to_string()));
            return empty(200, &headers);
        }
        let wanted = match range::parse_range(request.headers().get("range")?.as_deref(), blob.size) {
            Ok(wanted) => wanted,
            Err(()) => {
                headers.push(("content-range", format!("bytes */{}", blob.size)));
                return respond(416, &headers, ResponseBody::Empty);
            }
        };
        if wanted.is_none()
            && blob.size > REDIRECT_BYTES
            && let Some(url) = self.store.presign_get(&blob.object_key, REDIRECT_SECONDS, now_ms())
        {
            headers.push(("location", url));
            return empty(307, &headers);
        }
        let Some(got) = self.store.get(&blob.object_key, wanted).await? else {
            return error(404, "BLOB_UNKNOWN", format!("Blob {digest} is not in this image."));
        };
        match wanted {
            Some(wanted) => {
                headers.push(("content-range", wanted.content_range(got.size)));
                headers.push(("content-length", wanted.length.to_string()));
                respond(206, &headers, got.body)
            }
            None => {
                headers.push(("content-length", got.size.to_string()));
                respond(200, &headers, got.body)
            }
        }
    }

    async fn delete_blob(&self, package: &PackageRow, digest: &Digest) -> Result<Response> {
        if self.db.package_blob(&package.id, digest).await?.is_none() {
            return error(404, "BLOB_UNKNOWN", format!("Blob {digest} is not in this image."));
        }
        if self.db.blob_in_use(&package.id, digest).await? {
            return error(405, "DENIED", format!("Blob {digest} is used by a manifest of this image; delete the manifest instead."));
        }
        self.db.unlink_blob(&package.id, digest).await?;
        empty(202, &[])
    }

    async fn start_upload(
        &self,
        request: Request,
        url: &Url,
        name: &ImageName,
        found: Option<PackageRow>,
        credentials: &Credentials,
        caller: &Caller,
    ) -> Result<Response> {
        let package = self.package_for_push(name, found, caller).await?;
        // A blob another image of the workspace has: linked, not copied.
        if let (Some(mount), Some(from)) = (query(url, "mount"), query(url, "from"))
            && let (Some(digest), Ok(from)) = (Digest::parse(&mount), names::parse_name(&from))
            && from.workspace == name.workspace
            && let Some(source) = self.db.package(&from.workspace, CONTAINER, &from.name).await?
            && self.may_pull(credentials, &from, &source).await?
            && let Some(blob) = self.db.package_blob(&source.id, &digest).await?
        {
            if let Some(refused) = self.storage_refusal(&package, &[(digest.to_string(), blob.size)]).await? {
                return error(403, "DENIED", refused);
            }
            self.db.link_blob(&package.id, &digest, now_ms()).await?;
            return empty(201, &[
                ("location", format!("/v2/{}/blobs/{digest}", name.full())),
                ("docker-content-digest", digest.to_string()),
            ]);
        }
        let id = new_id("upl", now_ms());
        let row = UploadRow {
            id: id.clone(),
            workspace: name.workspace.clone(),
            package_id: package.id.clone(),
            package: name.full(),
            multipart_id: None,
            parts: "[]".to_owned(),
            offset: 0,
            tail: 0,
            hash_state: Sha256::new().save(),
        };
        // The whole blob in this one request.
        if let Some(digest) = query(url, "digest") {
            let Some(digest) = Digest::parse(&digest) else {
                return error(400, "DIGEST_INVALID", format!("{digest} is not a sha256 digest."));
            };
            let writer = Writer::resume(&self.store, Progress::new(&id)).await?;
            let writer = match self.take_body(request, writer).await? {
                Ok(writer) => writer,
                Err(refused) => return Ok(refused),
            };
            return self.complete(writer, name, &package, &digest).await;
        }
        self.db.create_upload(&row, now_ms()).await?;
        upload_status_with(name, &id, 0, 202)
    }

    /// Whether the credentials may pull another image, for a mount.
    async fn may_pull(&self, credentials: &Credentials, name: &ImageName, package: &PackageRow) -> Result<bool> {
        Ok(match credentials {
            Credentials::Token(claims) => claims.allows(&name.full(), Action::Pull) || package.public(),
            Credentials::Viewer(viewer) => {
                let target = TargetOf::package(package);
                access::decide(viewer.as_ref(), &target.view(), Action::Pull).allowed
            }
            Credentials::None | Credentials::Bad => package.public(),
        })
    }

    /// Writes the request's body into the upload, refusing one over the
    /// limit. On a refusal or a failure the whole upload is let go, the
    /// parts this request sent and the tail an earlier one kept included,
    /// so nothing is left in the store; the caller forgets its row.
    async fn take_body<'a, S: BlobStore>(
        &self,
        mut request: Request,
        mut writer: Writer<'a, S>,
    ) -> Result<std::result::Result<Writer<'a, S>, Response>> {
        let declared = request.headers().get("content-length")?.and_then(|n| n.parse::<u64>().ok());
        if declared.is_some_and(|n| n > self.max_request) {
            writer.abandon().await?;
            return Ok(Err(too_large(self.max_request)?));
        }
        let mut received = 0u64;
        let mut stream = match request.stream() {
            Ok(stream) => stream,
            // No body at all.
            Err(_) => return Ok(Ok(writer)),
        };
        while let Some(chunk) = stream.next().await {
            let written = match chunk {
                Ok(chunk) => {
                    received += chunk.len() as u64;
                    if received > self.max_request {
                        writer.abandon().await?;
                        return Ok(Err(too_large(self.max_request)?));
                    }
                    writer.write(&chunk).await
                }
                Err(error) => Err(error),
            };
            if let Err(error) = written {
                let _ = writer.abandon().await;
                return Err(error);
            }
        }
        Ok(Ok(writer))
    }

    async fn patch_upload(&self, request: Request, name: &ImageName, row: UploadRow) -> Result<Response> {
        let Some(progress) = row.progress() else {
            return error(404, "BLOB_UPLOAD_INVALID", "This upload cannot be continued. Start again.");
        };
        if let Some(header) = request.headers().get("content-range")? {
            match range::parse_content_range(&header) {
                Some(chunk) if chunk.start == progress.offset => {}
                _ => {
                    return empty(416, &[
                        ("location", format!("/v2/{}/blobs/uploads/{}", name.full(), row.id)),
                        ("range", range::upload_range(progress.offset)),
                        ("docker-upload-uuid", row.id.clone()),
                    ]);
                }
            }
        }
        let writer = Writer::resume(&self.store, progress).await?;
        // A refused or failed chunk ends the upload: the store holds
        // nothing of it any more (take_body, pause), so neither does its row.
        let progress = match self.take_body(request, writer).await {
            Ok(Ok(writer)) => writer.pause().await,
            Ok(Err(refused)) => {
                self.db.delete_upload(&row.id).await?;
                return Ok(refused);
            }
            Err(error) => Err(error),
        };
        let progress = match progress {
            Ok(progress) => progress,
            Err(error) => {
                self.db.delete_upload(&row.id).await?;
                return Err(error);
            }
        };
        self.db.save_progress(&progress, now_ms()).await?;
        upload_status_with(name, &row.id, progress.offset, 202)
    }

    async fn finish_upload(&self, request: Request, url: &Url, name: &ImageName, package: &PackageRow, row: UploadRow) -> Result<Response> {
        let Some(digest) = query(url, "digest").and_then(|d| Digest::parse(&d)) else {
            return error(400, "DIGEST_INVALID", "Finish an upload with ?digest=sha256:<hex>.");
        };
        let Some(progress) = row.progress() else {
            return error(404, "BLOB_UPLOAD_INVALID", "This upload cannot be continued. Start again.");
        };
        let writer = Writer::resume(&self.store, progress).await?;
        // However it ends, the upload is over and its row goes.
        let answer = match self.take_body(request, writer).await {
            Ok(Ok(writer)) => self.complete(writer, name, package, &digest).await,
            Ok(Err(refused)) => Ok(refused),
            Err(error) => Err(error),
        };
        self.db.delete_upload(&row.id).await?;
        answer
    }

    /// Ends an upload whose bytes are all in: checks the digest and the
    /// workspace's free storage, and keeps the blob unless it was already
    /// kept. Anything refused is let go.
    async fn complete<S: BlobStore>(&self, writer: Writer<'_, S>, name: &ImageName, package: &PackageRow, digest: &Digest) -> Result<Response> {
        let package_id = package.id.as_str();
        let refused = self.storage_refusal(package, &[(digest.to_string(), writer.received())]).await;
        match refused {
            Ok(None) => {}
            Ok(Some(refused)) => {
                writer.abandon().await?;
                return error(403, "DENIED", refused);
            }
            Err(error) => {
                let _ = writer.abandon().await;
                return Err(error);
            }
        }
        // Recorded and still in the store: these bytes are not needed. A
        // blob whose object went missing is stored again.
        let stored = match self.db.blob(digest).await {
            Ok(Some(blob)) => self.store.head(&blob.object_key).await.map(|size| size.is_some()),
            Ok(None) => Ok(false),
            Err(error) => Err(error),
        };
        let stored = match stored {
            Ok(stored) => stored,
            Err(error) => {
                let _ = writer.abandon().await;
                return Err(error);
            }
        };
        let now = now_ms();
        match writer.finish(digest, stored).await? {
            Finished::Mismatch { actual } => {
                return error(400, "DIGEST_INVALID", format!("The upload's digest is {actual}, not {digest}."));
            }
            Finished::Duplicate { .. } => self.db.link_blob(package_id, digest, now).await?,
            Finished::Stored { key, size } => self.db.keep_blob(package_id, digest, size, None, &key, now).await?,
        }
        empty(201, &[
            ("location", format!("/v2/{}/blobs/{digest}", name.full())),
            ("docker-content-digest", digest.to_string()),
        ])
    }

    async fn cancel_upload(&self, row: UploadRow) -> Result<Response> {
        if let Some(progress) = row.progress() {
            upload::abort(&self.store, &progress).await?;
        }
        self.db.delete_upload(&row.id).await?;
        empty(204, &[])
    }

    async fn tags(&self, url: &Url, name: &ImageName, found: Option<PackageRow>) -> Result<Response> {
        let Some(package) = found else {
            return error(404, "NAME_UNKNOWN", format!("There is no image {}.", name.full()));
        };
        let n = query(url, "n").and_then(|n| n.parse::<u32>().ok()).unwrap_or(MAX_TAGS_PAGE).min(MAX_TAGS_PAGE);
        let last = query(url, "last");
        let tags = if n == 0 { Vec::new() } else { self.db.tag_names(&package.id, last.as_deref(), n).await? };
        let mut response = Response::from_json(&json!({ "name": name.full(), "tags": tags }))?;
        if tags.len() as u32 == n
            && let Some(final_tag) = tags.last()
        {
            response
                .headers_mut()
                .set("link", &format!("</v2/{}/tags/list?n={n}&last={final_tag}>; rel=\"next\"", name.full()))?;
        }
        Ok(response)
    }

    async fn referrers(&self, url: &Url, name: &ImageName, found: Option<PackageRow>, digest: &str) -> Result<Response> {
        let Some(digest) = Digest::parse(digest) else {
            return error(400, "DIGEST_INVALID", format!("{digest} is not a sha256 digest."));
        };
        let Some(package) = found else {
            return error(404, "NAME_UNKNOWN", format!("There is no image {}.", name.full()));
        };
        let wanted = query(url, "artifactType");
        let mut manifests: Vec<Value> = Vec::new();
        for version in self.db.referrers(&package.id, digest.as_str()).await? {
            let meta = version.meta();
            let artifact_type = meta["artifact_type"].as_str().map(str::to_owned);
            if wanted.is_some() && artifact_type != wanted {
                continue;
            }
            let size = self.db.blob(&Digest::parse(&version.digest).unwrap_or(digest.clone())).await?.map_or(0, |b| b.size);
            let mut entry = json!({
                "mediaType": meta["media_type"].as_str().unwrap_or(manifest::OCI_MANIFEST),
                "digest": version.digest,
                "size": size,
            });
            if let Some(artifact_type) = artifact_type {
                entry["artifactType"] = json!(artifact_type);
            }
            if meta["annotations"].is_object() {
                entry["annotations"] = meta["annotations"].clone();
            }
            manifests.push(entry);
        }
        let body = json!({ "schemaVersion": 2, "mediaType": manifest::OCI_INDEX, "manifests": manifests });
        let mut response = Response::from_json(&body)?;
        response.headers_mut().set("content-type", manifest::OCI_INDEX)?;
        if wanted.is_some() {
            response.headers_mut().set("oci-filters-applied", "artifactType")?;
        }
        Ok(response)
    }

    /// Deletes a version of a package, with its tags, and says so.
    pub(crate) async fn remove_version(&self, package: &PackageRow, version: &crate::db::VersionRow, caller: &Caller) -> Result<()> {
        self.db.delete_version(&version.id).await?;
        self.db.measure(&package.workspace).await?;
        let event = PackageEvent {
            version: Some(version.version.clone()),
            digest: Some(version.digest.clone()),
            ..self.event_of(package)
        };
        self.announce("package.version_deleted", package, event, caller).await;
        // npm and Cargo name a version by its number; an image by its digest.
        let path = if package.ecosystem == "npm" {
            format!("@{}/{}@{}", package.workspace, package.name, version.version)
        } else if package.ecosystem == "cargo" {
            format!("{}/{}@{}", package.workspace, package.name, version.version)
        } else {
            format!("{}/{}@{}", package.workspace, package.name, version.digest)
        };
        self.audit(caller, "package.delete_version", package, Some(&path), None).await;
        Ok(())
    }

    pub(crate) fn event_of(&self, package: &PackageRow) -> PackageEvent {
        PackageEvent {
            package_id: package.id.clone(),
            workspace: package.workspace.clone(),
            ecosystem: Ecosystem::parse(&package.ecosystem).unwrap_or(Ecosystem::Container).as_str().to_owned(),
            name: package.name.clone(),
            repo_id: package.repo_id.clone(),
            ..PackageEvent::default()
        }
    }
}

fn upload_status(name: &ImageName, row: &UploadRow) -> Result<Response> {
    upload_status_with(name, &row.id, row.offset, 204)
}

fn upload_status_with(name: &ImageName, id: &str, offset: u64, status: u16) -> Result<Response> {
    empty(status, &[
        ("location", format!("/v2/{}/blobs/uploads/{id}", name.full())),
        ("range", range::upload_range(offset)),
        ("docker-upload-uuid", id.to_owned()),
        ("content-length", "0".to_owned()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_names_the_token_endpoint_on_the_same_host() {
        let url = Url::parse("https://g1t.sh/v2/").unwrap();
        assert_eq!(challenge(&url, None), "Bearer realm=\"https://g1t.sh/v2/token\",service=\"g1t.sh\"");
        let local = Url::parse("http://localhost:8790/v2/acme/web/manifests/latest").unwrap();
        assert_eq!(
            challenge(&local, Some("repository:acme/web:pull".into())),
            "Bearer realm=\"http://localhost:8790/v2/token\",service=\"localhost:8790\",scope=\"repository:acme/web:pull\""
        );
    }
}
