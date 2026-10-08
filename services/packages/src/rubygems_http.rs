//! The RubyGems registry: `g1t.sh/-/rubygems/<workspace>/`, one for each
//! workspace. `gem push --host` sends a g1t token as the whole
//! `Authorization` header (`GEM_HOST_API_KEY`, or `~/.gem/credentials`);
//! Bundler sends Basic credentials (any username, a g1t token as the
//! password) from `bundle config`.
//!
//! Bundler installs from the compact index (`versions`, `info/<gem>`,
//! `names`), made from the versions on each read, with each file's MD5 as
//! its `ETag` as Bundler checks it. `gem install --source` and `gem search`
//! read the full index: `specs.4.8.gz` (and `latest_` and `prerelease_`),
//! and a version's `quick/Marshal.4.8/<gem>.gemspec.rz`, made from what
//! each version keeps, in Ruby's Marshal format. A `.gem` is stored once, by its
//! SHA-256, which is also its index `checksum`. `gem yank` takes a version
//! out of the index; its file stays for lockfiles that name it.

use g1t_contracts::User;
use g1t_contracts::events::PackageEvent;
use g1t_contracts::new_id;
use g1t_kit::now_ms;
use serde_json::Value;
use worker::{Context, Headers, Method, Request, Response, ResponseBody, Result, Url};

use crate::access::Action;
use crate::db::{NewFile, NewVersion, PackageRow, VersionRow};
use crate::digest::Digest;
use crate::oci::{Credentials, published_by};
use crate::rubygems::{self, GemRoute};
use crate::store::BlobStore;
use crate::{Caller, Packages, TargetOf, cargo, npm, token};

const RUBYGEMS: &str = "rubygems";
/// The most versions a workspace's index lists.
const MAX_VERSIONS: u32 = 20_000;
/// The most gems a workspace's index lists.
const MAX_GEMS: u32 = 2000;
const DOCS: &str = "https://docs.g1t.sh/guides/rubygems/";
const TOKENS: &str = "https://g1t.sh/settings/tokens";

/// A plain-text answer, which `gem` and Bundler print.
fn error(status: u16, message: impl Into<String>) -> Result<Response> {
    let mut response = Response::ok(message.into())?.with_status(status);
    response.headers_mut().set("content-type", "text/plain; charset=utf-8")?;
    if status == 401 {
        response.headers_mut().set("www-authenticate", "Basic realm=\"g1t\"")?;
    }
    Ok(response)
}

fn sign_in(workspace: &str) -> String {
    format!(
        "Sign in to use this registry: bundle config set --global https://g1t.sh/-/rubygems/{workspace}/ <you>:<token>, with a g1t access token from {TOKENS}. See {DOCS}"
    )
}

/// An index file, with the quoted MD5 of its body as its `ETag`: Bundler
/// checks the file it keeps against it, and asks with `If-None-Match`.
fn index_file(request: &Request, body: String, head: bool) -> Result<Response> {
    let etag = format!("\"{:x}\"", md5::compute(body.as_bytes()));
    let headers = Headers::new();
    headers.set("content-type", "text/plain; charset=utf-8")?;
    headers.set("cache-control", "no-cache")?;
    headers.set("etag", &etag)?;
    if request.headers().get("if-none-match")?.is_some_and(|sent| sent.trim_start_matches("W/") == etag) {
        return Ok(Response::empty()?.with_status(304).with_headers(headers));
    }
    headers.set("content-length", &body.len().to_string())?;
    let body = if head { ResponseBody::Empty } else { ResponseBody::Body(body.into_bytes()) };
    Ok(Response::from_body(body)?.with_headers(headers))
}

/// A full index file or a specification, which `gem` reads as bytes.
fn binary(bytes: Vec<u8>, head: bool, cache: &str) -> Result<Response> {
    let headers = Headers::new();
    headers.set("content-type", "application/octet-stream")?;
    headers.set("content-length", &bytes.len().to_string())?;
    headers.set("cache-control", cache)?;
    let body = if head { ResponseBody::Empty } else { ResponseBody::Body(bytes) };
    Ok(Response::from_body(body)?.with_headers(headers))
}

/// A version's line in the index.
fn line(row: &VersionRow) -> String {
    let checksum = Digest::parse(&row.digest).map(|d| d.hex().to_owned()).unwrap_or_default();
    rubygems::info_line(&row.version, &row.meta(), &checksum)
}

impl Packages {
    /// Answers a RubyGems request.
    pub async fn rubygems(&self, request: Request, ctx: &Context) -> Result<Response> {
        let url = request.url()?;
        let Some((workspace, route)) = rubygems::route(url.path()) else {
            return error(404, "There is nothing at this address.");
        };
        match self.rubygems_route(request, &url, &workspace, route, ctx).await {
            Ok(response) => Ok(response),
            Err(problem) => {
                worker::console_error!("packages: rubygems {}: {problem}", url.path());
                error(500, "Something went wrong on our side. Try again in a moment.")
            }
        }
    }

    /// Who the request is from: `gem`'s bare key (or a `Bearer` one), or
    /// Bundler's Basic credentials.
    async fn gem_credentials(&self, request: &Request) -> Result<Credentials> {
        let Some(header) = request.headers().get("authorization")? else {
            return Ok(Credentials::None);
        };
        let viewer = if let Some((username, secret)) = token::basic(&header) {
            self.viewer_for(&username, &secret).await?
        } else if let Some(key) = cargo::token(&header) {
            self.viewer_for("token", key).await?
        } else {
            None
        };
        Ok(match viewer {
            Some(user) => Credentials::Viewer(Some(user)),
            None => Credentials::Bad,
        })
    }

    async fn rubygems_route(&self, mut request: Request, url: &Url, workspace: &str, route: GemRoute, ctx: &Context) -> Result<Response> {
        let method = request.method();
        let credentials = self.gem_credentials(&request).await?;
        let read = matches!(method, Method::Get | Method::Head);
        if read && let Some(refused) = self.limited(&request, &credentials, "Basic credentials in bundle config").await? {
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
        match route {
            GemRoute::Versions if read => self.gem_versions(&request, workspace, viewer, head).await,
            GemRoute::Names if read => self.gem_names(&request, workspace, viewer, head).await,
            GemRoute::Info { name } if read => self.gem_info(&request, workspace, &name, viewer, head).await,
            GemRoute::Gem { stem } if read => self.gem_download(workspace, &stem, viewer, head, ctx).await,
            GemRoute::Specs(which) if read => self.gem_specs(workspace, which, viewer, head).await,
            GemRoute::QuickSpec { stem } if read => self.gem_quick_spec(workspace, &stem, viewer, head).await,
            GemRoute::Push if method == Method::Post => self.gem_push(&mut request, workspace, viewer).await,
            GemRoute::Yank if method == Method::Delete => self.gem_yank(&mut request, url, workspace, viewer).await,
            _ => error(405, "Not a method this address takes."),
        }
    }

    /// The answer for something not there: a `401` to someone not signed
    /// in when the workspace has private gems, so Bundler asks for
    /// credentials and a private gem looks like a missing one.
    async fn gem_absent(&self, workspace: &str, viewer: Option<&User>) -> Result<Response> {
        if viewer.is_none() && self.db.has_private(workspace, RUBYGEMS).await? {
            return error(401, sign_in(workspace));
        }
        error(404, "Not found: no such gem or version, or you cannot see it.")
    }

    async fn gem_check(&self, viewer: Option<&User>, package: &PackageRow, action: Action) -> Result<Option<Response>> {
        let (decision, readable) = self.check(viewer, package, action).await?;
        if decision.allowed {
            return Ok(None);
        }
        if !readable && viewer.is_none() {
            return Ok(Some(error(401, sign_in(&package.workspace))?));
        }
        if !readable {
            return Ok(Some(self.gem_absent(&package.workspace, viewer).await?));
        }
        Ok(Some(error(403, decision.reason.unwrap_or_else(|| "Not allowed.".to_owned()))?))
    }

    /// The workspace's gems the viewer may see, with their versions in the
    /// index (not yanked), oldest first.
    async fn gem_index(&self, workspace: &str, viewer: Option<&User>) -> Result<std::result::Result<Vec<(PackageRow, Vec<VersionRow>)>, Response>> {
        if viewer.is_none() && self.db.has_private(workspace, RUBYGEMS).await? {
            return Ok(Err(error(401, sign_in(workspace))?));
        }
        let packages = self.db.packages_of(workspace, RUBYGEMS, MAX_GEMS).await?;
        let versions = self.db.ecosystem_versions(workspace, RUBYGEMS, MAX_VERSIONS).await?;
        let may = self.may_all(viewer, &packages.iter().collect::<Vec<_>>(), Action::Pull).await?;
        Ok(Ok(packages
            .into_iter()
            .zip(may)
            .filter(|(_, may)| *may)
            .map(|(p, _)| {
                let rows: Vec<VersionRow> = versions.iter().filter(|v| v.package_id == p.id && !v.is_yanked()).cloned().collect();
                (p, rows)
            })
            .filter(|(_, rows)| !rows.is_empty())
            .collect()))
    }

    async fn gem_versions(&self, request: &Request, workspace: &str, viewer: Option<&User>, head: bool) -> Result<Response> {
        let gems = match self.gem_index(workspace, viewer).await? {
            Ok(gems) => gems,
            Err(refused) => return Ok(refused),
        };
        let created = gems
            .iter()
            .flat_map(|(_, rows)| rows.iter().map(|r| r.published_at.as_str()))
            .min()
            .map(|at| format!("{}Z", &at[..at.len().min(19)]))
            .unwrap_or_else(|| "2026-01-01T00:00:00Z".to_owned());
        let lines: Vec<(String, Vec<String>, String)> = gems
            .iter()
            .map(|(package, rows)| {
                let info = rubygems::info(&rows.iter().map(line).collect::<Vec<_>>());
                (package.name.clone(), rows.iter().map(|r| r.version.clone()).collect(), format!("{:x}", md5::compute(info.as_bytes())))
            })
            .collect();
        index_file(request, rubygems::versions_file(&created, &lines), head)
    }

    async fn gem_names(&self, request: &Request, workspace: &str, viewer: Option<&User>, head: bool) -> Result<Response> {
        let gems = match self.gem_index(workspace, viewer).await? {
            Ok(gems) => gems,
            Err(refused) => return Ok(refused),
        };
        let names: Vec<String> = gems.into_iter().map(|(p, _)| p.name).collect();
        index_file(request, rubygems::names_file(&names), head)
    }

    async fn gem_info(&self, request: &Request, workspace: &str, name: &str, viewer: Option<&User>, head: bool) -> Result<Response> {
        let Some(package) = self.db.package(workspace, RUBYGEMS, name).await?.filter(|p| !p.hidden()) else {
            return self.gem_absent(workspace, viewer).await;
        };
        if let Some(refusal) = self.gem_check(viewer, &package, Action::Pull).await? {
            return Ok(refusal);
        }
        let mut rows: Vec<VersionRow> = self.db.versions(&package.id, MAX_VERSIONS).await?.into_iter().filter(|v| !v.is_yanked()).collect();
        if rows.is_empty() {
            return self.gem_absent(workspace, viewer).await;
        }
        rows.reverse();
        index_file(request, rubygems::info(&rows.iter().map(line).collect::<Vec<_>>()), head)
    }

    /// A full index file: the versions in the index of every gem the
    /// viewer may see, as `[name, Gem::Version, platform]`.
    async fn gem_specs(&self, workspace: &str, which: rubygems::Specs, viewer: Option<&User>, head: bool) -> Result<Response> {
        let gems = match self.gem_index(workspace, viewer).await? {
            Ok(gems) => gems,
            Err(refused) => return Ok(refused),
        };
        let tuples: Vec<rubygems::Tuple> =
            gems.iter().flat_map(|(package, rows)| rows.iter().map(|row| rubygems::Tuple::of(&package.name, &row.version, &row.meta()))).collect();
        binary(rubygems::specs_file(which, &tuples), head, "no-cache")
    }

    /// A version's specification, marshalled and deflated, which `gem
    /// install` reads before the gem. Yanked versions' too, as their files.
    async fn gem_quick_spec(&self, workspace: &str, stem: &str, viewer: Option<&User>, head: bool) -> Result<Response> {
        for (name, key) in rubygems::candidates(stem).into_iter().rev() {
            let Some(package) = self.db.package(workspace, RUBYGEMS, &name).await?.filter(|p| !p.hidden()) else {
                continue;
            };
            if let Some(refusal) = self.gem_check(viewer, &package, Action::Pull).await? {
                return Ok(refusal);
            }
            let Some(row) = self.db.version_named(&package.id, &key).await? else {
                continue;
            };
            let spec = rubygems::quick_spec(&package.name, &row.version, &row.meta(), &row.published_at);
            return binary(spec, head, "max-age=300");
        }
        self.gem_absent(workspace, viewer).await
    }

    /// A `.gem`, yanked ones too: a lockfile may still name them.
    async fn gem_download(&self, workspace: &str, stem: &str, viewer: Option<&User>, head: bool, ctx: &Context) -> Result<Response> {
        for (name, key) in rubygems::candidates(stem).into_iter().rev() {
            let Some(package) = self.db.package(workspace, RUBYGEMS, &name).await?.filter(|p| !p.hidden()) else {
                continue;
            };
            if let Some(refusal) = self.gem_check(viewer, &package, Action::Pull).await? {
                return Ok(refusal);
            }
            let Some(row) = self.db.version_named(&package.id, &key).await? else {
                continue;
            };
            let Some(digest) = Digest::parse(&row.digest) else { continue };
            let Some(blob) = self.db.package_blob(&package.id, &digest).await? else { continue };
            let headers = Headers::new();
            headers.set("content-type", "application/octet-stream")?;
            headers.set("content-length", &blob.size.to_string())?;
            headers.set("cache-control", "max-age=31536000")?;
            if head {
                return Ok(Response::from_body(ResponseBody::Empty)?.with_headers(headers));
            }
            let Some(got) = self.store.get(&blob.object_key, None).await? else { continue };
            self.count_version_download(&package.id, &row.id, ctx);
            return Ok(Response::from_body(got.body)?.with_headers(headers));
        }
        self.gem_absent(workspace, viewer).await
    }

    /// The package a first push makes, linked to the repository the gem's
    /// `source_code_uri` or homepage names on g1t, or else one named like it.
    async fn gem_target(&self, workspace: &str, spec: &rubygems::Gemspec) -> Result<TargetOf> {
        let named: Vec<String> = [&spec.source_code_uri, &spec.homepage]
            .into_iter()
            .flatten()
            .filter_map(|url| npm::repository_of(&Value::String(url.clone()), &self.host))
            .filter(|(owner, _)| owner == workspace)
            .map(|(_, repo)| repo)
            .collect();
        let lower = spec.name.to_ascii_lowercase();
        let dashed = lower.replace('_', "-");
        let mut repo = None;
        for candidate in named.iter().map(String::as_str).chain([lower.as_str(), dashed.as_str()]) {
            if let Some(found) = self.repo_by_name(workspace, candidate).await? {
                repo = Some(found);
                break;
            }
        }
        Ok(TargetOf::unmade(workspace, &spec.name, repo.map(|r| (r.id, r.name, r.is_private))))
    }

    /// `gem push`: the `.gem` as the body.
    async fn gem_push(&self, request: &mut Request, workspace: &str, viewer: Option<&User>) -> Result<Response> {
        let declared = request.headers().get("content-length")?.and_then(|n| n.parse::<u64>().ok());
        let too_large = || {
            let mb = self.max_request / 1_000_000;
            error(413, format!("A gem may be at most {mb} MB. See {DOCS}#size"))
        };
        if declared.is_some_and(|n| n > self.max_request) {
            return too_large();
        }
        let gem = request.bytes().await?;
        if gem.len() as u64 > self.max_request {
            return too_large();
        }
        if viewer.is_none() {
            return error(401, format!("Push with a g1t access token: GEM_HOST_API_KEY=<token> gem push <file> --host https://g1t.sh/-/rubygems/{workspace}. Make one at {TOKENS}."));
        }
        let spec = match rubygems::read_gem(&gem) {
            Ok(spec) => spec,
            Err(message) => return error(422, message),
        };
        if !rubygems::valid_name(&spec.name) {
            return error(422, format!("{} is not a valid gem name: letters, digits, ., - and _, with a letter.", spec.name));
        }
        if !rubygems::valid_version(&spec.version) {
            return error(422, format!("{} is not a version RubyGems reads.", spec.version));
        }
        let key = rubygems::key(&spec.version, &spec.platform);

        // A name is taken whatever its case.
        let found = self.db.package_any_case(workspace, RUBYGEMS, &spec.name).await?;
        if let Some(found) = &found {
            if found.hidden() {
                return error(403, Packages::hidden_refusal(found));
            }
            if found.name != spec.name {
                return error(409, format!("The name {} is taken by the gem {}. Push it under that name.", spec.name, found.name));
            }
        } else if self.db.workspace_hidden(workspace).await? {
            return error(403, format!("The workspace {workspace} is deleted; nothing can be pushed to it."));
        }
        let mut target = match &found {
            Some(package) => TargetOf::package(package),
            None => self.gem_target(workspace, &spec).await?,
        };
        let decision = self.decide(viewer, &mut target, Action::Push).await?;
        if !decision.allowed {
            let readable = found.is_none() || self.decide(viewer, &mut target, Action::Pull).await?.allowed;
            if !readable {
                return error(404, "Not found: no such gem, or you cannot see it.");
            }
            return error(403, decision.reason.unwrap_or_else(|| "Not allowed.".to_owned()));
        }
        let caller = Caller::of(viewer);
        let package = match found {
            Some(package) => package,
            None => {
                self.make_package(
                    workspace,
                    RUBYGEMS,
                    &spec.name,
                    target.repo.as_ref().map(|(id, repo, private)| (id.as_str(), repo.as_str(), *private)),
                    &caller,
                    now_ms(),
                )
                .await?
            }
        };
        let existing = self.db.versions(&package.id, MAX_VERSIONS).await?;
        if existing.iter().any(|v| v.version == key) {
            return error(409, format!("{} ({key}) is already pushed, and a version is pushed once, yanked or not. Bump the version.", package.name));
        }
        if let Some(refused) = self.reserved_refusal(&package, &key).await? {
            return error(409, refused);
        }

        let digest = Digest::of(&gem);
        let size = gem.len() as u64;
        if let Some(refusal) = self.storage_refusal(&package, &[(digest.to_string(), size)]).await? {
            return error(403, refusal);
        }
        let now = now_ms();
        let stored = match self.db.blob(&digest).await? {
            Some(blob) => self.store.head(&blob.object_key).await?.is_some(),
            None => false,
        };
        if !stored {
            self.store.put(&digest.object_key(), gem).await?;
        }
        self.db.keep_blob(&package.id, &digest, size, Some("application/octet-stream"), &digest.object_key(), now).await?;
        self.db
            .publish(
                NewVersion {
                    id: new_id("ver", now),
                    package_id: package.id.clone(),
                    version: key.clone(),
                    digest: digest.to_string(),
                    size,
                    metadata: rubygems::stored(&spec).to_string(),
                    subject: None,
                    published_by: published_by(&caller),
                    files: vec![NewFile { name: "gem".to_owned(), digest: digest.to_string(), size, media_type: Some("application/octet-stream".to_owned()) }],
                },
                None,
                now,
            )
            .await?;
        // The description the page shows: the highest stable version's.
        let highest = !rubygems::is_prerelease(&spec.version)
            && existing.iter().map(|v| v.meta()).filter_map(|m| m["number"].as_str().map(str::to_owned)).all(|other| {
                rubygems::is_prerelease(&other) || crate::db::newest_version(&format!("{other}\n{}", spec.version)).as_deref() == Some(spec.version.as_str())
            });
        if highest || existing.is_empty() {
            let description = spec.summary.as_deref().or(spec.description.as_deref());
            self.db.set_readme(&package.id, None, description, now).await?;
        }
        self.db.measure(&package.workspace).await?;
        let event = PackageEvent {
            version: Some(key.clone()),
            digest: Some(digest.to_string()),
            size: Some(size),
            ..self.event_of(&package)
        };
        self.announce("package.published", &package, event, &caller).await;
        self.audit(&caller, "package.publish", &package, Some(&format!("{workspace}/{}@{key}", package.name)), None).await;
        let mut response = Response::ok(format!("Successfully registered gem: {} ({key})", package.name))?;
        response.headers_mut().set("content-type", "text/plain; charset=utf-8")?;
        Ok(response)
    }

    /// `gem yank`: the version leaves the index, its file stays.
    async fn gem_yank(&self, request: &mut Request, url: &Url, workspace: &str, viewer: Option<&User>) -> Result<Response> {
        let body = request.text().await.unwrap_or_default();
        let query = url.query().unwrap_or("").to_owned();
        let value = |key: &str| rubygems::form_value(&body, key).or_else(|| rubygems::form_value(&query, key));
        let (Some(name), Some(version)) = (value("gem_name"), value("version")) else {
            return error(400, "Name the gem and version: gem yank <gem> --version <version>.");
        };
        let key = rubygems::key(&version, value("platform").as_deref().unwrap_or("ruby"));
        let Some(package) = self.db.package(workspace, RUBYGEMS, &name).await?.filter(|p| !p.hidden()) else {
            return self.gem_absent(workspace, viewer).await;
        };
        if let Some(refusal) = self.gem_check(viewer, &package, Action::Push).await? {
            return Ok(refusal);
        }
        let Some(row) = self.db.version_named(&package.id, &key).await? else {
            return error(404, format!("{name} ({key}) is not there."));
        };
        if row.is_yanked() {
            return error(422, format!("{name} ({key}) is already yanked."));
        }
        self.db.set_yanked(&row.id, true).await?;
        self.db.touch_package(&package.id, now_ms()).await?;
        let caller = Caller::of(viewer);
        self.audit(&caller, "package.yank", &package, Some(&format!("{workspace}/{name}@{key}")), None).await;
        let mut response = Response::ok(format!("Successfully deleted gem: {name} ({key})"))?;
        response.headers_mut().set("content-type", "text/plain; charset=utf-8")?;
        Ok(response)
    }
}
