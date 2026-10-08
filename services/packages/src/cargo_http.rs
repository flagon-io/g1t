//! The Cargo registry: `g1t.sh/-/cargo/<workspace>/`, a sparse registry
//! for each workspace. `.cargo/config.toml` names it, and `cargo login`
//! keeps a g1t token for it:
//!
//! ```toml
//! [registries.acme]
//! index = "sparse+https://g1t.sh/-/cargo/acme/index/"
//! ```
//!
//! Cargo sends the token as the whole `Authorization` header, with no
//! scheme. The index is made from the versions on each read; a `.crate`
//! is stored once, by its SHA-256, which is also its index `cksum`.

use g1t_contracts::User;
use g1t_contracts::events::PackageEvent;
use g1t_contracts::new_id;
use g1t_kit::now_ms;
use serde_json::{Value, json};
use worker::{Context, Headers, Method, Request, Response, ResponseBody, Result, Url};

use crate::access::Action;
use crate::cargo::{self, CargoRoute};
use crate::db::{NewFile, NewVersion, PackageRow, VersionRow};
use crate::digest::Digest;
use crate::npm;
use crate::oci::{Credentials, origin, published_by};
use crate::store::BlobStore;
use crate::{Caller, Packages, TargetOf, token};

const CARGO: &str = "cargo";
/// The most versions an index file lists.
const MAX_VERSIONS: u32 = 5000;
/// The longest README kept for a crate's page.
const MAX_README_BYTES: usize = 1024 * 1024;
/// The most crates `cargo search` is answered with.
const MAX_SEARCH: u32 = 100;
const DOCS: &str = "https://docs.g1t.sh/guides/cargo/";
const TOKENS: &str = "https://g1t.sh/settings/tokens";

/// Cargo's error shape: `{"errors": [{"detail": "..."}]}`, which it prints.
/// A 401 says where to get a token, which cargo shows beside its own hint.
fn error(status: u16, message: impl Into<String>) -> Result<Response> {
    let mut response = Response::from_json(&json!({ "errors": [{ "detail": message.into() }] }))?.with_status(status);
    if status == 401 {
        response.headers_mut().set("www-authenticate", &format!("Cargo login_url=\"{TOKENS}\""))?;
    }
    Ok(response)
}

fn ok() -> Result<Response> {
    Response::from_json(&json!({ "ok": true }))
}

fn not_found() -> Result<Response> {
    error(404, "Not found: no such crate, or you cannot see it. Private crates need a token: cargo login --registry <workspace>.")
}

fn sign_in(workspace: &str) -> String {
    format!("Sign in to use this registry: cargo login --registry {workspace}, with a g1t access token from {TOKENS}")
}

impl Packages {
    /// Answers a Cargo request.
    pub async fn cargo(&self, request: Request, ctx: &Context) -> Result<Response> {
        let url = request.url()?;
        let Some((workspace, route)) = cargo::route(url.path()) else {
            return error(404, "There is nothing at this address.");
        };
        match self.cargo_route(request, &url, &workspace, route, ctx).await {
            Ok(response) => Ok(response),
            Err(problem) => {
                worker::console_error!("packages: cargo {}: {problem}", url.path());
                error(500, "Something went wrong on our side. Try again in a moment.")
            }
        }
    }

    /// Who the request is from: cargo's bare token, a `Bearer` one, or
    /// Basic credentials with a g1t token as the password.
    async fn cargo_credentials(&self, request: &Request) -> Result<Credentials> {
        let Some(header) = request.headers().get("authorization")? else {
            return Ok(Credentials::None);
        };
        let viewer = if let Some((username, secret)) = token::basic(&header) {
            self.viewer_for(&username, &secret).await?
        } else if let Some(token) = cargo::token(&header) {
            self.viewer_for("token", token).await?
        } else {
            None
        };
        Ok(match viewer {
            Some(user) => Credentials::Viewer(Some(user)),
            None => Credentials::Bad,
        })
    }

    async fn cargo_route(&self, mut request: Request, url: &Url, workspace: &str, route: CargoRoute, ctx: &Context) -> Result<Response> {
        let method = request.method();
        let credentials = self.cargo_credentials(&request).await?;
        if matches!(method, Method::Get | Method::Head)
            && let Some(refused) = self.limited(&request, &credentials, &format!("a token (cargo login --registry {workspace})")).await?
        {
            return Ok(refused);
        }
        let viewer = match credentials {
            Credentials::Viewer(viewer) => viewer,
            Credentials::None => None,
            Credentials::Token(_) | Credentials::Bad => {
                return error(
                    401,
                    format!("The token is not right, or has expired. Make an access token at {TOKENS}, then: cargo login --registry {workspace}"),
                );
            }
        };
        let viewer = viewer.as_ref();
        let read = matches!(method, Method::Get | Method::Head);
        match route {
            CargoRoute::Config if read => self.cargo_config(url, workspace, viewer).await,
            CargoRoute::Index { name } if read => self.cargo_index(&request, workspace, &name, viewer).await,
            CargoRoute::Download { name, version } if read => self.crate_download(workspace, &name, &version, viewer, method == Method::Head, ctx).await,
            CargoRoute::Search if read => self.cargo_search(url, workspace, viewer).await,
            CargoRoute::Publish if method == Method::Put => self.cargo_publish(&mut request, workspace, viewer).await,
            CargoRoute::Yank { name, version } if method == Method::Delete => self.cargo_yank(workspace, &name, &version, true, viewer).await,
            CargoRoute::Unyank { name, version } if method == Method::Put => self.cargo_yank(workspace, &name, &version, false, viewer).await,
            CargoRoute::Owners { .. } => error(
                400,
                "Crate owners are not kept here: who may publish a crate is decided by its repository's roles, or the workspace's. See https://docs.g1t.sh/guides/packages/#who-can-see-and-publish-a-package",
            ),
            _ => error(405, "Not a method this address takes."),
        }
    }

    /// The crate, by its name in any case, if its workspace is not deleted.
    async fn crate_package(&self, workspace: &str, name: &str) -> Result<Option<PackageRow>> {
        Ok(self.db.package_any_case(workspace, CARGO, name).await?.filter(|p| !p.hidden()))
    }

    /// Whether `viewer` may `action` the crate, as the answer when not: 401
    /// for someone not signed in who may not read it, 404 for anyone else
    /// who may not read it, and 403 with the reason for one who may.
    async fn cargo_check(&self, viewer: Option<&User>, package: &PackageRow, action: Action) -> Result<Option<Result<Response>>> {
        let (decision, readable) = self.check(viewer, package, action).await?;
        if decision.allowed {
            return Ok(None);
        }
        if !readable && viewer.is_none() {
            return Ok(Some(error(401, sign_in(&package.workspace))));
        }
        if !readable {
            return Ok(Some(not_found()));
        }
        Ok(Some(error(403, decision.reason.unwrap_or_else(|| "Not allowed.".to_owned()))))
    }

    /// `index/config.json`. Signed in, cargo is told to send its token with
    /// every request. Anonymous requests to a workspace that has private
    /// crates get a 401, which makes cargo ask again with its token; one
    /// with only public crates is open to anyone.
    async fn cargo_config(&self, url: &Url, workspace: &str, viewer: Option<&User>) -> Result<Response> {
        if viewer.is_none() && self.db.has_private(workspace, CARGO).await? {
            return error(401, sign_in(workspace));
        }
        let base = format!("{}/-/cargo/{workspace}", origin(url));
        let mut response = Response::from_json(&cargo::config(&base, viewer.is_some()))?;
        response.headers_mut().set("cache-control", "no-cache")?;
        Ok(response)
    }

    /// A crate's index file: one line per version, oldest first.
    async fn cargo_index(&self, request: &Request, workspace: &str, name: &str, viewer: Option<&User>) -> Result<Response> {
        let Some(package) = self.crate_package(workspace, name).await? else {
            return not_found();
        };
        if let Some(refusal) = self.cargo_check(viewer, &package, Action::Pull).await? {
            return refusal;
        }
        let mut versions = self.db.versions(&package.id, MAX_VERSIONS).await?;
        if versions.is_empty() {
            return not_found();
        }
        versions.reverse();
        let mut body = String::new();
        for version in &versions {
            body.push_str(&cargo::index_line(&version.meta(), version.is_yanked()));
            body.push('\n');
        }
        let etag = format!("\"{}\"", &Digest::of(body.as_bytes()).hex()[..32]);
        let headers = Headers::new();
        headers.set("content-type", "text/plain; charset=utf-8")?;
        headers.set("cache-control", "no-cache")?;
        headers.set("etag", &etag)?;
        if request.headers().get("if-none-match")?.is_some_and(|sent| sent == etag) {
            return Ok(Response::empty()?.with_status(304).with_headers(headers));
        }
        Ok(Response::ok(body)?.with_headers(headers))
    }

    async fn crate_download(&self, workspace: &str, name: &str, version: &str, viewer: Option<&User>, head: bool, ctx: &Context) -> Result<Response> {
        let Some(package) = self.crate_package(workspace, name).await? else {
            return not_found();
        };
        if let Some(refusal) = self.cargo_check(viewer, &package, Action::Pull).await? {
            return refusal;
        }
        let gone = || error(404, format!("{name}@{version} is not there."));
        let Some(row) = self.db.version_named(&package.id, version).await? else {
            return gone();
        };
        let Some(digest) = Digest::parse(&row.digest) else {
            return gone();
        };
        let Some(blob) = self.db.package_blob(&package.id, &digest).await? else {
            return gone();
        };
        let headers = Headers::new();
        headers.set("content-type", "application/gzip")?;
        headers.set("content-length", &blob.size.to_string())?;
        headers.set("cache-control", "max-age=31536000")?;
        if head {
            return Ok(Response::from_body(ResponseBody::Empty)?.with_headers(headers));
        }
        let Some(got) = self.store.get(&blob.object_key, None).await? else {
            return gone();
        };
        self.count_version_download(&package.id, &row.id, ctx);
        Ok(Response::from_body(got.body)?.with_headers(headers))
    }

    /// `cargo search`: the workspace's crates the viewer may see, by name.
    async fn cargo_search(&self, url: &Url, workspace: &str, viewer: Option<&User>) -> Result<Response> {
        let query = url.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).unwrap_or_default();
        let per_page = url
            .query_pairs()
            .find(|(k, _)| k == "per_page")
            .and_then(|(_, v)| v.parse::<u32>().ok())
            .unwrap_or(10)
            .clamp(1, MAX_SEARCH);
        let rows = self.db.list(workspace, Some(CARGO), None, Some(&query), MAX_SEARCH).await?;
        let packages: Vec<&PackageRow> = rows.iter().map(|row| &row.package).collect();
        let may = self.may_all(viewer, &packages, Action::Pull).await?;
        let visible: Vec<_> = rows.iter().zip(may).filter(|(_, may)| *may).map(|(row, _)| row).collect();
        let crates: Vec<Value> = visible
            .iter()
            .take(per_page as usize)
            .map(|row| {
                json!({
                    "name": row.package.name,
                    "max_version": crate::db::latest_shown(row).unwrap_or_default(),
                    "description": row.package.description,
                })
            })
            .collect();
        Response::from_json(&json!({ "crates": crates, "meta": { "total": visible.len() } }))
    }

    /// The package publishing makes, linked to the repository the crate's
    /// `repository` names on g1t, or else the one named like it.
    async fn cargo_target(&self, workspace: &str, name: &str, metadata: &Value) -> Result<TargetOf> {
        let named = npm::repository_of(&metadata["repository"], &self.host)
            .filter(|(owner, _)| owner == workspace)
            .map(|(_, repo)| repo);
        let lower = name.to_ascii_lowercase();
        let dashed = lower.replace('_', "-");
        let mut repo = None;
        for candidate in named.iter().map(String::as_str).chain([lower.as_str(), dashed.as_str()]) {
            if let Some(found) = self.repo_by_name(workspace, candidate).await? {
                repo = Some(found);
                break;
            }
        }
        Ok(TargetOf::unmade(workspace, name, repo.map(|r| (r.id, r.name, r.is_private))))
    }

    /// `cargo publish`: the metadata and the `.crate` in one body.
    async fn cargo_publish(&self, request: &mut Request, workspace: &str, viewer: Option<&User>) -> Result<Response> {
        let declared = request.headers().get("content-length")?.and_then(|n| n.parse::<u64>().ok());
        let too_large = || {
            let mb = self.max_request / 1_000_000;
            error(413, format!("A publish may be at most {mb} MB, the .crate file and its metadata together. See {DOCS}#size"))
        };
        if declared.is_some_and(|n| n > self.max_request) {
            return too_large();
        }
        let bytes = request.bytes().await?;
        if bytes.len() as u64 > self.max_request {
            return too_large();
        }
        let (metadata, krate) = match cargo::parse_publish(&bytes) {
            Ok(parts) => parts,
            Err(message) => return error(400, message),
        };
        let name = metadata["name"].as_str().unwrap_or("").to_owned();
        if let Err(message) = cargo::valid_name(&name) {
            return error(400, message);
        }
        let version = metadata["vers"].as_str().unwrap_or("").to_owned();
        if !npm::valid_version(&version) {
            return error(400, format!("{version} is not a semver version."));
        }
        if krate.is_empty() {
            return error(400, "The .crate file is empty.");
        }
        let digest = Digest::of(krate);
        let entry = match cargo::index_entry(&metadata, digest.hex()) {
            Ok(entry) => entry,
            Err(message) => return error(400, message),
        };

        // A name is taken whatever its case, and `-` and `_` are one.
        let found = self.db.package_folded(workspace, CARGO, &cargo::folded(&name)).await?;
        if let Some(found) = &found {
            if found.hidden() {
                return error(403, Packages::hidden_refusal(found));
            }
            if found.name != name {
                return error(400, format!("The name {name} is taken by the crate {}. Publish it under that name.", found.name));
            }
        } else if self.db.workspace_hidden(workspace).await? {
            return error(403, format!("The workspace {workspace} is deleted; nothing can be published to it."));
        }
        let mut target = match &found {
            Some(package) => TargetOf::package(package),
            None => self.cargo_target(workspace, &name, &metadata).await?,
        };
        let decision = self.decide(viewer, &mut target, Action::Push).await?;
        if !decision.allowed {
            if viewer.is_none() {
                return error(401, sign_in(workspace));
            }
            let readable = found.is_none() || self.decide(viewer, &mut target, Action::Pull).await?.allowed;
            if !readable {
                return not_found();
            }
            return error(403, decision.reason.unwrap_or_else(|| "Not allowed.".to_owned()));
        }
        let caller = Caller::of(viewer);
        let package = match found {
            Some(package) => package,
            None => {
                self.make_package(
                    workspace,
                    CARGO,
                    &name,
                    target.repo.as_ref().map(|(id, repo, private)| (id.as_str(), repo.as_str(), *private)),
                    &caller,
                    now_ms(),
                )
                .await?
            }
        };
        let existing = self.db.versions(&package.id, MAX_VERSIONS).await?;
        if let Some(taken) = existing.iter().find(|v| cargo::without_build(&v.version) == cargo::without_build(&version)) {
            return error(
                400,
                format!("{name}@{} is already published, and a version is published once. Bump the version in Cargo.toml.", taken.version),
            );
        }
        // A deleted version's number is not published again until it is purged.
        let deleted = self.db.deleted_versions(&package.id, MAX_VERSIONS).await?;
        if let Some(taken) = deleted.iter().find(|v| cargo::without_build(&v.version) == cargo::without_build(&version))
            && let Some(refused) = self.reserved_refusal(&package, &taken.version).await?
        {
            return error(400, refused);
        }

        let size = krate.len() as u64;
        if let Some(refusal) = self.storage_refusal(&package, &[(digest.to_string(), size)]).await? {
            return error(403, refusal);
        }
        let now = now_ms();
        let stored = match self.db.blob(&digest).await? {
            Some(blob) => self.store.head(&blob.object_key).await?.is_some(),
            None => false,
        };
        if !stored {
            self.store.put(&digest.object_key(), krate.to_vec()).await?;
        }
        self.db
            .keep_blob(&package.id, &digest, size, Some("application/gzip"), &digest.object_key(), now)
            .await?;
        self.db
            .publish(
                NewVersion {
                    id: new_id("ver", now),
                    package_id: package.id.clone(),
                    version: version.clone(),
                    digest: digest.to_string(),
                    size,
                    metadata: entry.to_string(),
                    subject: None,
                    published_by: published_by(&caller),
                    files: vec![NewFile {
                        name: "crate".to_owned(),
                        digest: digest.to_string(),
                        size,
                        media_type: Some("application/gzip".to_owned()),
                    }],
                },
                None,
                now,
            )
            .await?;
        // The README and description the crate's page shows: the highest
        // stable version's, so a pre-release does not replace them.
        let highest = std::iter::once(version.as_str())
            .chain(existing.iter().map(|v| v.version.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
        if crate::db::newest_version(&highest).as_deref() == Some(version.as_str()) {
            let readme = metadata["readme"].as_str().unwrap_or("").trim();
            let readme_digest = if readme.is_empty() || readme.len() > MAX_README_BYTES {
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
            self.db.set_readme(&package.id, readme_digest.as_deref(), metadata["description"].as_str(), now).await?;
        }
        self.db.measure(&package.workspace).await?;
        let event = PackageEvent {
            version: Some(version.clone()),
            digest: Some(digest.to_string()),
            size: Some(size),
            ..self.event_of(&package)
        };
        self.announce("package.published", &package, event, &caller).await;
        self.audit(&caller, "package.publish", &package, Some(&format!("{workspace}/{name}@{version}")), None).await;
        Response::from_json(&json!({ "warnings": { "invalid_categories": [], "invalid_badges": [], "other": [] } }))
    }

    /// `cargo yank` and `cargo yank --undo`: the version stays, for
    /// lockfiles that name it, but is no longer picked for new ones.
    async fn cargo_yank(&self, workspace: &str, name: &str, version: &str, yank: bool, viewer: Option<&User>) -> Result<Response> {
        let Some(package) = self.crate_package(workspace, name).await? else {
            return not_found();
        };
        if let Some(refusal) = self.cargo_check(viewer, &package, Action::Push).await? {
            return refusal;
        }
        let Some(row): Option<VersionRow> = self.db.version_named(&package.id, version).await? else {
            return error(404, format!("{name}@{version} is not there."));
        };
        if row.is_yanked() != yank {
            self.db.set_yanked(&row.id, yank).await?;
            self.db.touch_package(&package.id, now_ms()).await?;
            let caller = Caller::of(viewer);
            let action = if yank { "package.yank" } else { "package.unyank" };
            self.audit(&caller, action, &package, Some(&format!("{workspace}/{}@{version}", package.name)), None).await;
        }
        ok()
    }
}
