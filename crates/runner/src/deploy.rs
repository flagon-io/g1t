//! Builds one commit of a repository and hands the result to Cloudflare, as
//! a preview of a pull request or as the repository's production.
//!
//! The sandbox never holds a Cloudflare credential that could touch anything
//! else. The deployments service opens an upload for exactly the files
//! this build produced and gives back a key that can only upload those;
//! the sandbox uploads them with it, and sends the Worker's code to the
//! service, which puts the app in place.
//!
//! What gets built:
//!
//! - A Workers project (a `wrangler.jsonc`, `wrangler.json` or
//!   `wrangler.toml`): bundled by `wrangler deploy --dry-run`, with its
//!   static assets, compatibility settings and `vars`. Other bindings (D1,
//!   KV, R2, Durable Objects…) are not provisioned yet; the deployment says
//!   which were left out.
//! - Anything else: a static site. Its `build` script runs, and the first
//!   of `dist`, `build`, `out`, `public`, `_site` or `.output/public` that
//!   exists is served, or the repository itself if it has an `index.html`.
//!
//! Configuration comes from the environment:
//!
//! - `G1T_API`, `DEPLOY_ID`, `DEPLOY_TOKEN`: where and how to report.
//! - `GIT_REMOTE`, `GIT_COMMIT`, `G1T_USER`, `G1T_TOKEN`: what to check out.
//! - `ROOT_DIR`: where in the repository the project lives; empty for all
//!   of it. Everything below is relative to it.
//! - `BUILD_COMMAND`, `OUTPUT_DIR`: the project's own choices, if any.
//! - `BUILD_ENV`, `BUILD_SECRETS`: JSON objects of the repository's
//!   variables and secrets for deploy builds. Both are set for the build;
//!   secrets' values are redacted from its log.
//!
//! From a workflow step, `g1t-runner deploy` runs the same build in the
//! job's own checkout: without `GIT_REMOTE` nothing is cloned, and the
//! project is the current directory (`ROOT_DIR` below it). The build's id
//! and token come from `POST /repos/{owner}/{repo}/deployments/builds`,
//! which the `g1t/deploy` action calls (actions/deploy). Its output goes
//! to the step's log as well as the deployment's. `g1t-runner detect`
//! says what the build would find, as `key=value` lines for
//! `$GITHUB_OUTPUT`, without building anything.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::checks::{redact, run_command};
use crate::{WORKDIR, auth_option, env, git};

/// Where `wrangler deploy --dry-run` writes the bundle in a sandbox.
const BUNDLE_DIR: &str = "/work/g1t-bundle";
/// Cloudflare's limits on a Worker's static assets.
const MAX_FILES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
/// How much of the build's output is kept for the deployment's log.
const MAX_LOG_CHARS: usize = 20_000;
/// Directories a static build usually writes to, in the order they are tried.
const OUTPUT_DIRS: [&str; 6] = ["dist", "build", "out", "public", "_site", ".output/public"];
/// Bindings a Workers project may declare that are not provisioned yet.
const UNSUPPORTED_BINDINGS: [&str; 10] = [
    "kv_namespaces",
    "d1_databases",
    "r2_buckets",
    "durable_objects",
    "services",
    "queues",
    "vectorize",
    "hyperdrive",
    "ai",
    "workflows",
];

struct Reporter {
    base: String,
    token: String,
}

impl Reporter {
    fn send(&self, step: &str, mut body: Value) -> Result<Value> {
        body["token"] = self.token.clone().into();
        let response = ureq::post(&format!("{}/{step}", self.base))
            .send_json(body)
            .with_context(|| format!("could not report `{step}` to g1t"))?;
        Ok(response.into_json().unwrap_or(Value::Null))
    }
}

/// The build's log, kept to its end; also printed, in a workflow step.
#[derive(Default)]
struct Log {
    text: String,
    /// Each line to standard output as well, redacted.
    echo: Option<Vec<String>>,
}

impl Log {
    fn line(&mut self, line: &str) {
        self.text.push_str(line);
        self.text.push('\n');
        if let Some(secrets) = &self.echo {
            println!("{}", redact(line, secrets));
        }
    }

    fn tail(&self) -> String {
        let length = self.text.chars().count();
        if length <= MAX_LOG_CHARS {
            return self.text.clone();
        }
        let kept: String = self.text.chars().skip(length - MAX_LOG_CHARS).collect();
        format!("… (earlier output not shown)\n{kept}")
    }
}

/// Runs a command in the checkout, logging it; fails if it fails.
fn step(log: &mut Log, command: &str, secrets: &[String]) -> Result<()> {
    log.line(&format!("$ {command}"));
    let result = run_command(command, &project_dir(), secrets);
    if !result.output_text().is_empty() {
        log.line(result.output_text());
    }
    if !result.passed {
        bail!("`{command}` failed");
    }
    Ok(())
}

/// A Workers project's settings, from whichever config file it has.
#[derive(Debug, Default, Deserialize)]
struct WranglerConfig {
    main: Option<String>,
    compatibility_date: Option<String>,
    #[serde(default)]
    compatibility_flags: Vec<String>,
    assets: Option<AssetsConfig>,
    #[serde(default)]
    vars: BTreeMap<String, Value>,
    #[serde(flatten)]
    rest: BTreeMap<String, Value>,
}

#[derive(Debug, Default, Deserialize)]
struct AssetsConfig {
    directory: Option<String>,
    binding: Option<String>,
    html_handling: Option<String>,
    not_found_handling: Option<String>,
}

/// JSON with comments and trailing commas, as `wrangler.jsonc` allows.
fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut last = ' ';
                for c in chars.by_ref() {
                    if last == '*' && c == '/' {
                        break;
                    }
                    last = c;
                }
            }
            _ => out.push(c),
        }
    }
    // Trailing commas before a closing bracket.
    let mut cleaned = String::with_capacity(out.len());
    let chars: Vec<char> = out.chars().collect();
    let mut in_string = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' && (i == 0 || chars[i - 1] != '\\') {
            in_string = !in_string;
        }
        if c == ',' && !in_string {
            let next = chars[i + 1..].iter().find(|c| !c.is_whitespace());
            if matches!(next, Some('}') | Some(']')) {
                i += 1;
                continue;
            }
        }
        cleaned.push(c);
        i += 1;
    }
    cleaned
}

fn read_wrangler(dir: &Path) -> Result<Option<WranglerConfig>> {
    for name in ["wrangler.jsonc", "wrangler.json"] {
        let path = dir.join(name);
        if path.exists() {
            let text = std::fs::read_to_string(&path)?;
            return Ok(Some(
                serde_json::from_str(&strip_jsonc(&text)).with_context(|| format!("could not read {name}"))?,
            ));
        }
    }
    let path = dir.join("wrangler.toml");
    if path.exists() {
        let text = std::fs::read_to_string(&path)?;
        return Ok(Some(toml::from_str(&text).context("could not read wrangler.toml")?));
    }
    Ok(None)
}

/// How to install the project's dependencies, judged by its lockfile.
fn install_command(dir: &Path) -> Option<&'static str> {
    if !dir.join("package.json").exists() {
        return None;
    }
    Some(if dir.join("pnpm-lock.yaml").exists() {
        "corepack enable && pnpm install --frozen-lockfile"
    } else if dir.join("yarn.lock").exists() {
        "corepack enable && yarn install"
    } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        "npx --yes bun install"
    } else if dir.join("package-lock.json").exists() {
        "npm ci"
    } else {
        "npm install"
    })
}

fn has_build_script(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|package| package["scripts"]["build"].is_string())
}

/// One file of the site, as Cloudflare's asset upload names it.
struct Asset {
    path: String,
    hash: String,
    size: u64,
    file: PathBuf,
}

fn content_type(path: &str) -> &'static str {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "application/javascript",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain",
        "xml" => "application/xml",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

/// Every file under `root`, but for what never belongs in a site.
fn collect(root: &Path, dir: &Path, skip_project: bool, out: &mut Vec<Asset>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let kind = entry.file_type()?;
        if name == ".git" || (skip_project && (name == "node_modules" || name.starts_with(".g1t"))) {
            continue;
        }
        if kind.is_dir() {
            collect(root, &path, skip_project, out)?;
            continue;
        }
        if !kind.is_file() || name == "_headers" || name == "_redirects" {
            continue;
        }
        let size = entry.metadata()?.len();
        let relative = path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        if size > MAX_FILE_BYTES {
            bail!("{relative} is larger than Cloudflare's 25 MiB limit for one file");
        }
        let bytes = std::fs::read(&path)?;
        let digest = hex::encode(Sha256::digest(&bytes));
        out.push(Asset {
            path: format!("/{relative}"),
            hash: digest[..32].to_owned(),
            size,
            file: path,
        });
        if out.len() > MAX_FILES {
            bail!("the site has more than {MAX_FILES} files, Cloudflare's limit");
        }
    }
    Ok(())
}

/// The upload, as the API sends it: `snake_case`, or `uploadUrl` from
/// before its bodies were.
#[derive(Deserialize)]
struct UploadSession {
    jwt: String,
    #[serde(default)]
    buckets: Vec<Vec<String>>,
    #[serde(alias = "uploadUrl")]
    upload_url: String,
}

/// Sends one bucket of files with the upload's key. The last bucket's
/// answer carries the key that completes the upload.
fn upload_bucket(session: &UploadSession, bucket: &[String], by_hash: &BTreeMap<&str, &Asset>) -> Result<Option<String>> {
    let boundary = format!("g1t-{}", hex::encode(Sha256::digest(bucket.join(",").as_bytes()))[..24].to_owned());
    let mut body: Vec<u8> = Vec::new();
    for hash in bucket {
        let asset = by_hash
            .get(hash.as_str())
            .with_context(|| format!("Cloudflare asked for a file this build does not have ({hash})"))?;
        let bytes = std::fs::read(&asset.file)?;
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{hash}\"; filename=\"{hash}\"\r\nContent-Type: {}\r\n\r\n",
                content_type(&asset.path)
            )
            .as_bytes(),
        );
        body.extend_from_slice(STANDARD.encode(bytes).as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let response = ureq::post(&session.upload_url)
        .set("authorization", &format!("Bearer {}", session.jwt))
        .set("content-type", &format!("multipart/form-data; boundary={boundary}"))
        .send_bytes(&body);
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(code, response)) => {
            bail!("Cloudflare refused the upload ({code}): {}", response.into_string().unwrap_or_default())
        }
        Err(error) => bail!("could not upload to Cloudflare: {error}"),
    };
    let answer: Value = response.into_json().unwrap_or(Value::Null);
    Ok(answer["result"]["jwt"].as_str().map(str::to_owned))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Module {
    name: String,
    content_base64: String,
    content_type: String,
}

/// The bundle `wrangler deploy --dry-run` wrote, main module first.
fn bundle_modules(main: &str, bundle: &Path) -> Result<(String, Vec<Module>)> {
    let stem = Path::new(main)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "index".to_owned());
    let mut modules = Vec::new();
    let mut files = Vec::new();
    collect_files(bundle, &mut files)?;
    for file in files {
        let name = file
            .strip_prefix(bundle)?
            .to_string_lossy()
            .replace('\\', "/");
        let kind = match name.rsplit('.').next().unwrap_or("") {
            "js" | "mjs" => "application/javascript+module",
            "wasm" => "application/wasm",
            "map" | "md" => continue,
            _ => "text/plain",
        };
        modules.push(Module {
            content_base64: STANDARD.encode(std::fs::read(&file)?),
            content_type: kind.to_owned(),
            name,
        });
    }
    let main_name = modules
        .iter()
        .map(|module| module.name.clone())
        .find(|name| *name == format!("{stem}.js") || *name == format!("{stem}.mjs"))
        .or_else(|| {
            modules
                .iter()
                .find(|module| module.content_type == "application/javascript+module")
                .map(|module| module.name.clone())
        })
        .context("wrangler wrote no JavaScript module")?;
    Ok((main_name, modules))
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            collect_files(&entry.path(), out)?;
        } else {
            out.push(entry.path());
        }
    }
    Ok(())
}

/// What a Workers config asks for that g1t.page does not provision, said
/// as the deployment's warnings: bindings it runs without, and scheduled
/// (`triggers.crons`) runs that never fire.
fn config_warnings(config: &WranglerConfig) -> Vec<String> {
    let mut warnings = Vec::new();
    for binding in UNSUPPORTED_BINDINGS {
        if config.rest.get(binding).is_some_and(|value| !value.is_null()) {
            warnings.push(format!("`{binding}` is not provisioned on g1t.page yet, so the app runs without it."));
        }
    }
    let crons = config
        .rest
        .get("triggers")
        .and_then(|triggers| triggers.get("crons"))
        .and_then(Value::as_array)
        .map_or(0, |crons| crons.iter().filter(|cron| cron.as_str().is_some_and(|c| !c.trim().is_empty())).count());
    if crons > 0 {
        let schedules = if crons == 1 { "schedule" } else { "schedules" };
        warnings.push(format!(
            "`triggers.crons` ({crons} {schedules}) is not set up on g1t.page yet, so the Worker's `scheduled` handler never runs."
        ));
    }
    warnings
}

/// What was built: the Worker's code and settings, and where its site is.
struct Built {
    worker: Value,
    assets_dir: Option<PathBuf>,
    warnings: Vec<String>,
    /// What kind of project it was found to be, for its settings page:
    /// `workers`, `static` (a build's output) or `html` (the files as they are).
    detected: &'static str,
}

/// What a project without a Workers config is: a site it built, or its own
/// files served as they are.
fn static_kind(project: &Path, assets_dir: &Path, built: bool) -> &'static str {
    if !built && assets_dir == project { "html" } else { "static" }
}

/// The command that bundles a Workers project, without deploying it,
/// into `bundle` when given.
fn wrangler_build(bundle: Option<&Path>) -> String {
    match bundle {
        Some(bundle) => format!("npx --yes wrangler@4 deploy --dry-run --outdir {}", bundle.display()),
        None => "npx --yes wrangler@4 deploy --dry-run".to_owned(),
    }
}

/// The first of the usual output directories a static build wrote (or the
/// project's own `index.html`), relative to the project: `.` for itself.
fn find_output(dir: &Path) -> Option<String> {
    OUTPUT_DIRS
        .iter()
        .find(|name| {
            let path = dir.join(name);
            path.join("index.html").exists() || (path.is_dir() && **name != "public")
        })
        .map(|name| (*name).to_owned())
        .or_else(|| dir.join("index.html").exists().then(|| ".".to_owned()))
}

/// What a build of the project at `dir` does, found before anything runs:
/// what it is, how its dependencies are installed, what builds it, and
/// where what it serves is. For a site with a build of its own, the output
/// directory may only exist once it has run; then `output_dir` is `None`
/// unless one was chosen.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Detected {
    /// `workers`, `static`, `html`, or `none` when there is nothing to serve.
    pub kind: &'static str,
    pub install: Option<&'static str>,
    pub build: Option<String>,
    pub output_dir: Option<String>,
}

pub(crate) fn detect(dir: &Path, custom_build: Option<&str>, chosen_output: Option<&str>) -> Result<Detected> {
    let custom_build = custom_build.map(str::trim).filter(|c| !c.is_empty());
    let chosen_output = chosen_output.map(|d| d.trim().trim_matches('/')).filter(|d| !d.is_empty());
    let install = install_command(dir);
    if let Some(config) = read_wrangler(dir)? {
        let mut steps: Vec<String> = custom_build.map(str::to_owned).into_iter().collect();
        if config.main.is_some() {
            steps.push(wrangler_build(None));
        }
        return Ok(Detected {
            kind: "workers",
            install,
            build: (!steps.is_empty()).then(|| steps.join(" && ")),
            output_dir: config.assets.and_then(|assets| assets.directory),
        });
    }
    let build = custom_build
        .map(str::to_owned)
        .or_else(|| has_build_script(dir).then(|| "npm run build".to_owned()));
    let output_dir = chosen_output.map(str::to_owned).or_else(|| find_output(dir));
    // `.` is the project itself: its own files, served as they are.
    let kind = match (&build, output_dir.as_deref()) {
        (None, Some(".")) => "html",
        (None, None) => "none",
        _ => "static",
    };
    Ok(Detected { kind, install, build, output_dir })
}

fn build(log: &mut Log, secrets: &[String]) -> Result<Built> {
    let project = project_dir();
    let dir = project.as_path();
    let bundle = bundle_dir();
    let config = read_wrangler(dir)?;
    let custom_build = std::env::var("BUILD_COMMAND").ok().filter(|c| !c.trim().is_empty());
    if let Some(install) = install_command(dir) {
        step(log, install, secrets)?;
    }
    let mut warnings = Vec::new();
    match config {
        Some(config) => {
            if let Some(command) = &custom_build {
                step(log, command, secrets)?;
            }
            warnings.extend(config_warnings(&config));
            let mut worker = json!({
                "compatibilityDate": config.compatibility_date.clone().unwrap_or_else(|| "2026-09-26".to_owned()),
                "compatibilityFlags": config.compatibility_flags,
                "vars": config.vars,
            });
            if let Some(main) = &config.main {
                // `--dry-run` runs the project's own build and bundles it,
                // without deploying anywhere.
                let _ = std::fs::remove_dir_all(&bundle);
                step(log, &wrangler_build(Some(&bundle)), secrets)?;
                let (main_module, modules) = bundle_modules(main, &bundle)?;
                worker["mainModule"] = main_module.into();
                worker["modules"] = serde_json::to_value(modules)?;
            }
            let assets = config.assets.unwrap_or_default();
            let assets_dir = assets.directory.as_ref().map(|directory| dir.join(directory));
            worker["assetsBinding"] = assets.binding.into();
            worker["htmlHandling"] = assets.html_handling.into();
            worker["notFoundHandling"] = assets.not_found_handling.into();
            Ok(Built {
                worker,
                assets_dir,
                warnings,
                detected: "workers",
            })
        }
        None => {
            let built = custom_build.is_some() || has_build_script(dir);
            if let Some(command) = &custom_build {
                step(log, command, secrets)?;
            } else if has_build_script(dir) {
                step(log, "npm run build", secrets)?;
            }
            let chosen = std::env::var("OUTPUT_DIR").ok().filter(|d| !d.trim().is_empty());
            let assets_dir = match chosen {
                Some(chosen) => {
                    let path = dir.join(chosen.trim_matches('/'));
                    if !path.is_dir() {
                        bail!("the output directory `{chosen}` does not exist after the build");
                    }
                    path
                }
                None => match find_output(dir).context(
                    "found nothing to serve: no Workers config, no index.html, and none of dist, build, out, public, _site or .output/public",
                )? {
                    own if own == "." => dir.to_path_buf(),
                    output => dir.join(output),
                },
            };
            let spa = !assets_dir.join("404.html").exists();
            Ok(Built {
                worker: json!({
                    "compatibilityDate": "2026-09-26",
                    "compatibilityFlags": [],
                    "vars": {},
                    "notFoundHandling": if spa { "single-page-application" } else { "404-page" },
                }),
                detected: static_kind(dir, &assets_dir, built),
                assets_dir: Some(assets_dir),
                warnings,
            })
        }
    }
}

/// Whether the build checks out its own commit (a sandbox, given
/// `GIT_REMOTE`) rather than building the checkout it runs in.
fn clones() -> bool {
    std::env::var("GIT_REMOTE").is_ok_and(|remote| !remote.trim().is_empty())
}

/// The checkout the build runs in: the sandbox's clone, or, from a
/// workflow step, the current directory.
fn checkout_dir() -> PathBuf {
    if clones() {
        PathBuf::from(WORKDIR)
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    }
}

/// Where `wrangler deploy --dry-run` writes the bundle: in a workflow
/// step, a directory of the job's temporary space, never the checkout.
fn bundle_dir() -> PathBuf {
    if clones() {
        return PathBuf::from(BUNDLE_DIR);
    }
    let base = std::env::var_os("RUNNER_TEMP").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join(format!("g1t-bundle-{}", std::process::id()))
}

/// Where the project lives in the checkout `base`: its root directory,
/// never above the checkout.
fn project_dir_in(base: &Path, root: &str) -> PathBuf {
    let root = root.trim().trim_matches('/');
    if root.is_empty() || root == "." || root.split('/').any(|part| part == "..") {
        base.to_path_buf()
    } else {
        base.join(root)
    }
}

/// Where the project lives: `ROOT_DIR` in the checkout.
fn project_dir() -> PathBuf {
    project_dir_in(&checkout_dir(), &std::env::var("ROOT_DIR").unwrap_or_default())
}

fn check_out(secrets: &[String]) -> Result<()> {
    let remote = env("GIT_REMOTE")?;
    let commit = env("GIT_COMMIT")?;
    let auth = auth_option(&env("G1T_USER")?, &env("G1T_TOKEN")?);
    std::fs::create_dir_all("/work")?;
    let workdir = Path::new(WORKDIR);
    // The clone is shallow and of the default branch; a preview's commit is
    // often on another one, so it is fetched before checking out.
    let cloned = crate::clone::clone(Path::new("/work"), &auth, &[], &remote, WORKDIR)
        .and_then(|_| git(workdir, &["rev-parse", "--abbrev-ref", "HEAD"]))
        .and_then(|branch| crate::clone::ensure(workdir, &auth, "origin", &branch, &commit))
        .and_then(|_| git(workdir, &["-c", "advice.detachedHead=false", "checkout", "--quiet", &commit]));
    if let Err(error) = cloned {
        bail!("{}", redact(&format!("{error:#}"), secrets));
    }
    Ok(())
}

fn deploy(reporter: &Reporter, log: &mut Log, secrets: &[String]) -> Result<Value> {
    if clones() {
        check_out(secrets).context("the commit could not be checked out")?;
    } else {
        let dir = project_dir();
        if !dir.is_dir() {
            bail!("the project's directory {} does not exist in this checkout", dir.display());
        }
        log.line(&format!("Building {} as it is checked out.", dir.display()));
    }
    // The repository's variables and secrets for deploy builds.
    for source in ["BUILD_ENV", "BUILD_SECRETS"] {
        if let Ok(vars) = std::env::var(source)
            && let Ok(Value::Object(vars)) = serde_json::from_str::<Value>(&vars)
        {
            for (name, value) in vars {
                if let Some(value) = value.as_str() {
                    // SAFETY: single-threaded; set before any command runs.
                    unsafe { std::env::set_var(name, value) };
                }
            }
        }
    }
    let built = build(log, secrets)?;
    let mut finish = json!({
        "worker": built.worker,
        "warnings": built.warnings,
        "detected": built.detected,
    });
    for warning in &built.warnings {
        log.line(&format!("Warning: {warning}"));
    }
    if let Some(dir) = &built.assets_dir {
        let skip_project = *dir == project_dir();
        let mut assets = Vec::new();
        collect(dir, dir, skip_project, &mut assets)?;
        if assets.is_empty() {
            bail!("the site to serve is empty");
        }
        log.line(&format!("Uploading {} files.", assets.len()));
        for special in ["_headers", "_redirects"] {
            if let Ok(text) = std::fs::read_to_string(dir.join(special)) {
                finish["worker"][special] = text.into();
            }
        }
        let manifest: BTreeMap<&str, Value> = assets
            .iter()
            .map(|asset| (asset.path.as_str(), json!({ "hash": asset.hash, "size": asset.size })))
            .collect();
        let answer = reporter.send("session", json!({ "manifest": manifest }))?;
        if answer["ok"] == false {
            bail!("{}", answer["error"]["message"].as_str().unwrap_or("g1t refused the upload"));
        }
        let session: UploadSession =
            serde_json::from_value(answer["value"].clone()).context("g1t's answer to the upload was not understood")?;
        let by_hash: BTreeMap<&str, &Asset> = assets.iter().map(|asset| (asset.hash.as_str(), asset)).collect();
        let mut completion = session.jwt.clone();
        for bucket in &session.buckets {
            if let Some(jwt) = upload_bucket(&session, bucket, &by_hash)? {
                completion = jwt;
            }
        }
        finish["completionJwt"] = completion.into();
    }
    Ok(finish)
}

/// A sandbox's build (`MODE=deploy`).
pub fn main() -> i32 {
    run(false)
}

/// `g1t-runner deploy`, from a workflow step: the build in the job's own
/// checkout, its log in the step's as well. Exits 1 when the build fails,
/// after reporting it, so the step fails too.
pub fn cli(args: &[String]) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{CLI_HELP}");
        return 0;
    }
    run(true)
}

const CLI_HELP: &str = "g1t-runner deploy: builds the project in this checkout and puts it on g1t.page.

Reads DEPLOY_ID and DEPLOY_TOKEN (from POST /repos/{owner}/{repo}/deployments/builds),
G1T_API (https://api.g1t.sh), and optionally ROOT_DIR, BUILD_COMMAND, OUTPUT_DIR,
BUILD_ENV and BUILD_SECRETS (JSON objects). The g1t/deploy action sets them all.

g1t-runner detect prints what the build would find, as key=value lines.";

fn run(step_log: bool) -> i32 {
    let reporter = match (env("G1T_API"), env("DEPLOY_ID"), env("DEPLOY_TOKEN")) {
        (Ok(api), Ok(id), Ok(token)) => Reporter {
            base: format!("{}/deployments/jobs/{id}", api.trim_end_matches('/')),
            token,
        },
        _ => {
            eprintln!("g1t-runner: G1T_API, DEPLOY_ID and DEPLOY_TOKEN must be set");
            return 2;
        }
    };
    let mut secrets: Vec<String> = ["G1T_TOKEN", "DEPLOY_TOKEN"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .filter(|secret| !secret.is_empty())
        .collect();
    // The repository's build secrets never appear in the log.
    if let Ok(Value::Object(build)) = serde_json::from_str::<Value>(&std::env::var("BUILD_SECRETS").unwrap_or_default()) {
        secrets.extend(build.values().filter_map(Value::as_str).filter(|v| v.len() >= 4).map(str::to_owned));
    }
    if let Err(error) = reporter.send("started", json!({})) {
        eprintln!("g1t-runner: {error:#}");
        return 1;
    }
    let started = Instant::now();
    let mut log = Log { echo: step_log.then(|| secrets.clone()), ..Log::default() };
    let outcome = deploy(&reporter, &mut log, &secrets);
    let seconds = started.elapsed().as_secs();
    if step_log {
        let _ = std::fs::remove_dir_all(bundle_dir());
    }
    let (sent, failed) = match outcome {
        Ok(mut finish) => {
            finish["log"] = redact(&log.tail(), &secrets).into();
            finish["buildSeconds"] = seconds.into();
            (reporter.send("finish", finish), false)
        }
        Err(error) => {
            let message = redact(&format!("{error:#}"), &secrets);
            log.line(&format!("The build failed: {message}"));
            let sent = reporter.send(
                "fail",
                json!({ "message": message, "log": redact(&log.tail(), &secrets), "buildSeconds": seconds }),
            );
            (sent, true)
        }
    };
    match sent {
        // A sandbox's build has said how it ended; a step fails with its build.
        Ok(answer) if step_log && (failed || answer["ok"] == false || answer["value"] == false) => {
            if !failed {
                eprintln!("g1t-runner: g1t did not take the build; its deployment says why");
            }
            1
        }
        Ok(_) => 0,
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            1
        }
    }
}

/// `g1t-runner detect`: what a build of the project would find, as
/// `key=value` lines for `$GITHUB_OUTPUT`: `kind`, `install`, `build` and
/// `output-dir`. Reads `ROOT_DIR`, `BUILD_COMMAND` and `OUTPUT_DIR` as the
/// build does; `--root-dir DIR` is the same as `ROOT_DIR`.
pub fn detect_cli(args: &[String]) -> i32 {
    let mut root = std::env::var("ROOT_DIR").unwrap_or_default();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--root-dir" => root = rest.next().cloned().unwrap_or_default(),
            "--help" | "-h" => {
                println!("g1t-runner detect [--root-dir DIR]: prints kind, install, build and output-dir as key=value lines.");
                return 0;
            }
            other => {
                eprintln!("g1t-runner detect: unknown argument {other}");
                return 2;
            }
        }
    }
    let dir = project_dir_in(&checkout_dir(), &root);
    let custom = std::env::var("BUILD_COMMAND").ok();
    let output = std::env::var("OUTPUT_DIR").ok();
    match detect(&dir, custom.as_deref(), output.as_deref()) {
        Ok(found) => {
            print!("{}", output_lines(&found));
            0
        }
        Err(error) => {
            eprintln!("g1t-runner detect: {error:#}");
            1
        }
    }
}

/// `Detected` as `$GITHUB_OUTPUT` lines; a value on one line, empty when
/// there is none.
fn output_lines(found: &Detected) -> String {
    let one_line = |value: Option<&str>| value.unwrap_or_default().replace(['\r', '\n'], " ");
    format!(
        "kind={}\ninstall={}\nbuild={}\noutput-dir={}\n",
        found.kind,
        one_line(found.install),
        one_line(found.build.as_deref()),
        one_line(found.output_dir.as_deref()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_upload_session_is_read_in_either_spelling() {
        for answer in [
            json!({ "jwt": "j", "buckets": [["a"]], "upload_url": "https://u" }),
            json!({ "jwt": "j", "uploadUrl": "https://u" }),
        ] {
            let session: UploadSession = serde_json::from_value(answer).unwrap();
            assert_eq!(session.upload_url, "https://u");
        }
    }

    #[test]
    fn jsonc_comments_and_trailing_commas_are_dropped() {
        let text = r#"{
            // a comment
            "main": "src/index.ts", /* another */
            "vars": { "URL": "https://x.dev//not-a-comment", },
        }"#;
        let config: WranglerConfig = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(config.main.as_deref(), Some("src/index.ts"));
        assert_eq!(config.vars["URL"], "https://x.dev//not-a-comment");
    }

    #[test]
    fn unsupported_bindings_are_noticed() {
        let config: WranglerConfig =
            serde_json::from_str(r#"{ "main": "a.js", "d1_databases": [{ "binding": "DB" }] }"#).unwrap();
        assert!(config.rest.contains_key("d1_databases"));
    }

    #[test]
    fn crons_g1t_does_not_run_are_warned_about() {
        let config: WranglerConfig =
            serde_json::from_str(r#"{ "main": "a.js", "triggers": { "crons": ["*/5 * * * *", "0 3 * * *"] }, "kv_namespaces": [{ "binding": "KV" }] }"#)
                .unwrap();
        let warnings = config_warnings(&config);
        assert_eq!(warnings.len(), 2);
        assert!(warnings.iter().any(|w| w.contains("kv_namespaces")));
        assert!(warnings.iter().any(|w| w.contains("triggers.crons") && w.contains("2 schedules")));
        let none: WranglerConfig = serde_json::from_str(r#"{ "main": "a.js", "triggers": { "crons": [] } }"#).unwrap();
        assert!(config_warnings(&none).is_empty());
        let toml: WranglerConfig = toml::from_str("main = \"a.js\"
[triggers]
crons = [\"0 * * * *\"]
").unwrap();
        assert!(config_warnings(&toml)[0].contains("1 schedule)"));
    }

    #[test]
    fn a_site_is_plain_html_only_when_its_own_files_are_served_unbuilt() {
        let project = Path::new("/w/site");
        assert_eq!(static_kind(project, project, false), "html");
        assert_eq!(static_kind(project, project, true), "static");
        assert_eq!(static_kind(project, &project.join("dist"), false), "static");
    }

    #[test]
    fn files_are_typed_by_extension() {
        assert_eq!(content_type("/index.HTML"), "text/html");
        assert_eq!(content_type("/a/b.woff2"), "font/woff2");
        assert_eq!(content_type("/LICENSE"), "application/octet-stream");
    }

    /// A fresh directory with `files` (path, contents) in it.
    fn project(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("g1t-detect-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (path, text) in files {
            let path = dir.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detect_finds_a_workers_project_and_how_it_builds() {
        let dir = project(
            "workers",
            &[
                ("wrangler.jsonc", r#"{ "main": "src/index.ts", "assets": { "directory": "./public" }, }"#),
                ("package.json", "{}"),
                ("pnpm-lock.yaml", ""),
            ],
        );
        let found = detect(&dir, None, None).unwrap();
        assert_eq!(found.kind, "workers");
        assert_eq!(found.install, Some("corepack enable && pnpm install --frozen-lockfile"));
        assert_eq!(found.build.as_deref(), Some("npx --yes wrangler@4 deploy --dry-run"));
        assert_eq!(found.output_dir.as_deref(), Some("./public"));
        // The project's own build command runs first.
        let custom = detect(&dir, Some("npm run codegen"), None).unwrap();
        assert_eq!(custom.build.as_deref(), Some("npm run codegen && npx --yes wrangler@4 deploy --dry-run"));
    }

    #[test]
    fn detect_finds_a_static_build_and_a_plain_site() {
        let built = project("static", &[("package.json", r#"{ "scripts": { "build": "vite build" } }"#), ("package-lock.json", "{}")]);
        let found = detect(&built, None, None).unwrap();
        assert_eq!(
            found,
            Detected { kind: "static", install: Some("npm ci"), build: Some("npm run build".into()), output_dir: None },
            "its output is found once it has built"
        );
        std::fs::create_dir_all(built.join("dist")).unwrap();
        std::fs::write(built.join("dist/index.html"), "<h1>hi</h1>").unwrap();
        assert_eq!(detect(&built, None, None).unwrap().output_dir.as_deref(), Some("dist"));
        assert_eq!(detect(&built, None, Some("/site/")).unwrap().output_dir.as_deref(), Some("site"));

        let html = project("html", &[("index.html", "<h1>hi</h1>")]);
        assert_eq!(detect(&html, None, None).unwrap(), Detected { kind: "html", install: None, build: None, output_dir: Some(".".into()) });
        // A `public` folder alone, without an index.html, is not a site.
        let empty = project("empty", &[("public/robots.txt", ""), ("README.md", "")]);
        assert_eq!(detect(&empty, None, None).unwrap().kind, "none");
    }

    #[test]
    fn detect_prints_lines_for_github_output() {
        let found = Detected { kind: "static", install: Some("npm ci"), build: Some("a\nb".into()), output_dir: None };
        assert_eq!(output_lines(&found), "kind=static\ninstall=npm ci\nbuild=a b\noutput-dir=\n");
    }

    #[test]
    fn the_root_directory_stays_inside_the_checkout() {
        let base = Path::new("/w/repo");
        assert_eq!(project_dir_in(base, ""), base);
        assert_eq!(project_dir_in(base, "."), base);
        assert_eq!(project_dir_in(base, "/apps/site/"), base.join("apps/site"));
        assert_eq!(project_dir_in(base, "../etc"), base);
        assert_eq!(project_dir_in(base, "apps/../../x"), base);
    }

    #[test]
    fn a_step_prints_the_log_redacted() {
        let mut log = Log { echo: Some(vec!["hunter22".to_owned()]), ..Log::default() };
        log.line("token hunter22 used");
        assert!(log.text.contains("hunter22"), "the deployment's log is redacted when it is sent");
        assert_eq!(wrangler_build(Some(Path::new("/tmp/b"))), "npx --yes wrangler@4 deploy --dry-run --outdir /tmp/b");
    }
}
