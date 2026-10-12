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
//! - A framework g1t knows (deploy/frameworks.rs: Vite, Astro, Next.js,
//!   SvelteKit, Nuxt, Hugo, Jekyll and the rest), found by the package's
//!   dependencies and config files: built with its own command and served
//!   from the folder it writes. A Cloudflare adapter's Worker (Astro's
//!   `dist/_worker.js`, SvelteKit's `.svelte-kit/cloudflare/_worker.js`) is
//!   bundled as a Workers project's is, without a Wrangler config of its
//!   own. A framework set up to need a server fails before anything is
//!   installed, saying what to change.
//! - Anything else: a static site. Its `build` script runs, and the first
//!   of `dist`, `build`, `out`, `public`, `_site` or `.output/public` that
//!   exists is served, or the repository itself if it has an `index.html`.
//!
//! The project's own **Build command** and **Output directory** win over
//! what is detected.
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

use std::collections::{BTreeMap, BTreeSet};
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

mod frameworks;

use frameworks::{Adapter, Framework};

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

/// What is never served from the top of a site: a Pages-style Worker
/// (`_worker.js`, its server code, which a Cloudflare adapter writes beside
/// the site's files), `_routes.json`, and `.assetsignore`, with each name
/// that `.assetsignore` lists, as wrangler leaves them out.
fn ignored_at_root(root: &Path) -> BTreeSet<String> {
    let mut ignored: BTreeSet<String> = ["_worker.js", "_routes.json", ".assetsignore"].map(str::to_owned).into();
    if let Ok(text) = std::fs::read_to_string(root.join(".assetsignore")) {
        ignored.extend(
            text.lines()
                .map(|line| line.trim().trim_matches('/'))
                .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.contains(['*', '/', '!']))
                .map(str::to_owned),
        );
    }
    ignored
}

/// Every file of the site at `root`, but for what never belongs in one.
fn collect_site(root: &Path, skip_project: bool) -> Result<Vec<Asset>> {
    let mut assets = Vec::new();
    collect(root, root, skip_project, &ignored_at_root(root), &mut assets)?;
    Ok(assets)
}

fn collect(root: &Path, dir: &Path, skip_project: bool, ignored: &BTreeSet<String>, out: &mut Vec<Asset>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let kind = entry.file_type()?;
        if name == ".git" || (skip_project && (name == "node_modules" || name.starts_with(".g1t"))) {
            continue;
        }
        if dir == root && ignored.contains(&name) {
            continue;
        }
        if kind.is_dir() {
            collect(root, &path, skip_project, ignored, out)?;
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
    // An empty list, as a config a framework's build writes has for each
    // kind of binding (`"d1_databases": []`), declares nothing.
    fn declares(value: &Value) -> bool {
        match value {
            Value::Null => false,
            Value::Array(items) => !items.is_empty(),
            Value::Object(fields) => fields.values().any(declares),
            _ => true,
        }
    }
    let mut warnings = Vec::new();
    for binding in UNSUPPORTED_BINDINGS {
        if config.rest.get(binding).is_some_and(declares) {
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
    /// The framework it was found to be built with, if any (`astro`…).
    framework: Option<&'static str>,
}

/// What a project without a Workers config is: a site it built, or its own
/// files served as they are.
fn static_kind(project: &Path, assets_dir: &Path, built: bool) -> &'static str {
    if !built && assets_dir == project { "html" } else { "static" }
}

/// The command that bundles a Workers project, without deploying it,
/// into `bundle` when given, by the config at `config` when given.
fn wrangler_build(bundle: Option<&Path>, config: Option<&Path>) -> String {
    let mut command = "npx --yes wrangler@4 deploy --dry-run".to_owned();
    if let Some(config) = config {
        command.push_str(&format!(" --config {}", config.display()));
    }
    if let Some(bundle) = bundle {
        command.push_str(&format!(" --outdir {}", bundle.display()));
    }
    command
}

/// The config a framework's build wrote for wrangler, which wrangler reads
/// in place of the project's own (`.wrangler/deploy/config.json`, as
/// `@cloudflare/vite-plugin` writes it), with the folder its paths are
/// relative to.
fn redirected_config(dir: &Path) -> Result<Option<(WranglerConfig, PathBuf)>> {
    let pointer = dir.join(".wrangler/deploy/config.json");
    let Ok(text) = std::fs::read_to_string(&pointer) else { return Ok(None) };
    let Some(path) = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["configPath"].as_str().map(str::to_owned)) else {
        return Ok(None);
    };
    let path = dir.join(".wrangler/deploy").join(path);
    let path = path.canonicalize().unwrap_or(path);
    let text = std::fs::read_to_string(&path).with_context(|| format!("could not read {}", path.display()))?;
    let config = serde_json::from_str(&strip_jsonc(&text)).with_context(|| format!("could not read {}", path.display()))?;
    Ok(Some((config, path.parent().map_or_else(|| dir.to_path_buf(), Path::to_path_buf))))
}

/// The entry of the Worker a framework's adapter wrote, once it has built:
/// the file, or a directory's `index.js`.
fn adapter_entry(dir: &Path, adapter: &Adapter) -> Option<PathBuf> {
    let entry = dir.join(adapter.entry);
    if entry.is_file() {
        return Some(entry);
    }
    ["index.js", "index.mjs"].iter().map(|name| entry.join(name)).find(|index| index.is_file())
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
/// unless one was chosen or the framework says where it writes.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Detected {
    /// `workers`, `static`, `html`, or `none` when there is nothing to serve.
    pub kind: &'static str,
    /// The framework it is built with, if g1t knows it.
    pub framework: Option<Framework>,
    pub install: Option<String>,
    pub build: Option<String>,
    pub output_dir: Option<String>,
    /// Why it cannot be served as it is set up, and what to change: the
    /// kind is then `none`.
    pub problem: Option<String>,
    /// What runs before wrangler bundles a Workers project; for anything
    /// else, `build`.
    pre_build: Option<String>,
}

pub(crate) fn detect(dir: &Path, custom_build: Option<&str>, chosen_output: Option<&str>) -> Result<Detected> {
    let custom_build = custom_build.map(str::trim).filter(|c| !c.is_empty());
    let chosen_output = chosen_output.map(|d| d.trim().trim_matches('/')).filter(|d| !d.is_empty());
    let config = read_wrangler(dir)?;
    let framework = frameworks::detect(dir, config.is_some());
    let installs: Vec<&str> = [install_command(dir), framework.as_ref().and_then(|f| f.install)].into_iter().flatten().collect();
    let install = (!installs.is_empty()).then(|| installs.join(" && "));
    let framework_build = framework.as_ref().and_then(|f| f.build.clone());
    if let Some(config) = config {
        // A framework built for Workers builds before wrangler bundles what
        // it wrote; any other project's config builds it, as it always has.
        let pre_build = custom_build
            .map(str::to_owned)
            .or_else(|| framework.as_ref().filter(|f| f.workers).and(framework_build));
        let mut steps: Vec<String> = pre_build.clone().into_iter().collect();
        if config.main.is_some() {
            steps.push(wrangler_build(None, None));
        }
        return Ok(Detected {
            kind: "workers",
            framework,
            install,
            build: (!steps.is_empty()).then(|| steps.join(" && ")),
            output_dir: config.assets.and_then(|assets| assets.directory),
            problem: None,
            pre_build,
        });
    }
    let build = custom_build
        .map(str::to_owned)
        .or(framework_build)
        .or_else(|| has_build_script(dir).then(|| "npm run build".to_owned()));
    // An adapter's Worker, unless the project chose a folder to serve.
    if chosen_output.is_none() && framework.as_ref().is_some_and(|f| f.adapter.is_some()) {
        // Where its files are is known once it has built: the adapter's
        // own folder, or where the config it writes says.
        return Ok(Detected {
            kind: "workers",
            output_dir: None,
            framework,
            install,
            pre_build: build.clone(),
            build,
            problem: None,
        });
    }
    // A command or a folder of the project's own says it knows better.
    let problem = framework
        .as_ref()
        .and_then(|f| f.problem.clone())
        .filter(|_| custom_build.is_none() && chosen_output.is_none());
    if problem.is_some() {
        return Ok(Detected { kind: "none", framework, install, build: None, output_dir: None, problem, pre_build: None });
    }
    let output_dir = chosen_output
        .map(str::to_owned)
        .or_else(|| framework.as_ref().and_then(|f| f.output.clone()))
        .or_else(|| find_output(dir));
    // `.` is the project itself: its own files, served as they are.
    let kind = match (&build, output_dir.as_deref()) {
        (None, Some(".")) => "html",
        (None, None) => "none",
        _ => "static",
    };
    Ok(Detected { kind, framework, install, pre_build: build.clone(), build, output_dir, problem: None })
}

/// The compatibility date a Worker gets when its config names none.
const COMPATIBILITY_DATE: &str = "2026-09-26";

/// A Workers project bundled by wrangler: `config` with its paths relative
/// to `base`, read by wrangler from `config_file` when given (else the
/// project's own, or the one its build wrote).
fn build_worker(
    log: &mut Log,
    secrets: &[String],
    config: WranglerConfig,
    base: &Path,
    config_file: Option<&Path>,
) -> Result<(Value, Option<PathBuf>, Vec<String>)> {
    let bundle = bundle_dir();
    let warnings = config_warnings(&config);
    let mut worker = json!({
        "compatibilityDate": config.compatibility_date.clone().unwrap_or_else(|| COMPATIBILITY_DATE.to_owned()),
        "compatibilityFlags": config.compatibility_flags,
        "vars": config.vars,
    });
    if let Some(main) = &config.main {
        // `--dry-run` runs the config's own build and bundles it, without
        // deploying anywhere.
        let _ = std::fs::remove_dir_all(&bundle);
        step(log, &wrangler_build(Some(&bundle), config_file), secrets)?;
        let (main_module, modules) = bundle_modules(main, &bundle)?;
        worker["mainModule"] = main_module.into();
        worker["modules"] = serde_json::to_value(modules)?;
    }
    let assets = config.assets.unwrap_or_default();
    let assets_dir = assets.directory.as_ref().map(|directory| base.join(directory));
    worker["assetsBinding"] = assets.binding.into();
    worker["htmlHandling"] = assets.html_handling.into();
    worker["notFoundHandling"] = assets.not_found_handling.into();
    Ok((worker, assets_dir, warnings))
}

/// Where the config for an adapter's Worker is written: beside the
/// bundle, never in the checkout.
fn adapter_config_path() -> PathBuf {
    let bundle = bundle_dir();
    bundle.with_file_name(format!("{}.wrangler.json", bundle.file_name().unwrap_or_default().to_string_lossy()))
}

fn build(log: &mut Log, secrets: &[String]) -> Result<Built> {
    let project = project_dir();
    let dir = project.as_path();
    let custom_build = std::env::var("BUILD_COMMAND").ok();
    let chosen = std::env::var("OUTPUT_DIR").ok().filter(|d| !d.trim().is_empty());
    let plan = detect(dir, custom_build.as_deref(), chosen.as_deref())?;
    let framework_id = plan.framework.as_ref().map(|f| f.id);
    if let Some(framework) = &plan.framework {
        log.line(&format!("Detected {}: framework={}.", framework.name, framework.id));
    }
    // Said before anything is installed: it would fail after, less clearly.
    if let Some(problem) = &plan.problem {
        bail!("{problem}");
    }
    if let Some(install) = &plan.install {
        step(log, install, secrets)?;
    }
    if let Some(command) = &plan.pre_build {
        step(log, command, secrets)?;
    }
    let own_config = read_wrangler(dir)?;
    // A framework built for Workers may write the config wrangler reads
    // (`@cloudflare/vite-plugin` does, and Astro's adapter with it), with
    // or without one of the project's own.
    let written = if own_config.is_some() || plan.framework.as_ref().is_some_and(|f| f.workers) {
        redirected_config(dir)?
    } else {
        None
    };
    if let Some((config, base)) = written {
        log.line(&format!("Using the Workers config the build wrote, in {}.", base.display()));
        let (worker, assets_dir, warnings) = build_worker(log, secrets, config, &base, None)?;
        return Ok(Built { worker, assets_dir, warnings, detected: "workers", framework: framework_id });
    }
    if let Some(config) = own_config {
        let (worker, assets_dir, warnings) = build_worker(log, secrets, config, dir, None)?;
        return Ok(Built { worker, assets_dir, warnings, detected: "workers", framework: framework_id });
    }
    let adapter = plan.framework.as_ref().and_then(|f| f.adapter.as_ref()).filter(|_| chosen.is_none());
    if let Some(adapter) = adapter
        && let Some(entry) = adapter_entry(dir, adapter)
    {
        // The adapter's Worker, bundled as a Workers project's is. Its
        // static files are uploaded by g1t, so wrangler is given none.
        let file = adapter_config_path();
        let flags = vec!["nodejs_compat".to_owned()];
        std::fs::write(
            &file,
            serde_json::to_string_pretty(&json!({
                "name": "g1t-app",
                "main": entry,
                "compatibility_date": COMPATIBILITY_DATE,
                "compatibility_flags": flags,
            }))?,
        )?;
        log.line(&format!("Bundling the Worker the adapter wrote, {}.", adapter.entry));
        let config = WranglerConfig {
            main: Some(entry.to_string_lossy().into_owned()),
            compatibility_flags: flags,
            assets: Some(AssetsConfig {
                directory: Some(adapter.assets.to_owned()),
                binding: Some("ASSETS".to_owned()),
                ..AssetsConfig::default()
            }),
            ..WranglerConfig::default()
        };
        let built = build_worker(log, secrets, config, dir, Some(&file));
        let _ = std::fs::remove_file(&file);
        let (worker, assets_dir, warnings) = built?;
        return Ok(Built { worker, assets_dir, warnings, detected: "workers", framework: framework_id });
    }
    if let (Some(adapter), Some(framework)) = (adapter, &plan.framework)
        && framework.output.is_none()
    {
        bail!("{}'s build did not write its Worker, `{}`", framework.name, adapter.entry);
    }
    let assets_dir = match &chosen {
        Some(chosen) => {
            let path = dir.join(chosen.trim().trim_matches('/'));
            if !path.is_dir() {
                bail!("the output directory `{chosen}` does not exist after the build");
            }
            path
        }
        None => {
            let expected = plan.framework.as_ref().and_then(|f| f.output.as_deref());
            match expected.filter(|output| dir.join(output).is_dir()) {
                Some(output) => dir.join(output),
                None => {
                    let found = find_output(dir).with_context(|| match (&plan.framework, expected) {
                        (Some(framework), Some(expected)) => format!(
                            "found nothing to serve: {} writes its site to `{expected}`, which the build did not write. \
                             Set **Output directory** if it writes somewhere else.",
                            framework.name
                        ),
                        (Some(framework), None) if framework.problem.is_some() => {
                            format!("found nothing to serve. {}", framework.problem.as_deref().unwrap_or_default())
                        }
                        _ => "found nothing to serve: no Workers config, no index.html, and none of dist, build, out, public, _site or .output/public".to_owned(),
                    })?;
                    if let Some(expected) = expected {
                        log.line(&format!("`{expected}` was not written; serving `{found}`."));
                    }
                    if found == "." { dir.to_path_buf() } else { dir.join(found) }
                }
            }
        }
    };
    let spa = !assets_dir.join("404.html").exists();
    Ok(Built {
        worker: json!({
            "compatibilityDate": COMPATIBILITY_DATE,
            "compatibilityFlags": [],
            "vars": {},
            "notFoundHandling": if spa { "single-page-application" } else { "404-page" },
        }),
        detected: static_kind(dir, &assets_dir, plan.build.is_some()),
        assets_dir: Some(assets_dir),
        warnings: Vec::new(),
        framework: framework_id,
    })
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
        // Not stored by the deployments service yet, which ignores fields
        // it does not know; the build's log names it too.
        "framework": built.framework,
    });
    for warning in &built.warnings {
        log.line(&format!("Warning: {warning}"));
    }
    if let Some(dir) = &built.assets_dir {
        let skip_project = *dir == project_dir();
        let assets = collect_site(dir, skip_project)?;
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
        let _ = std::fs::remove_file(adapter_config_path());
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
/// `key=value` lines for `$GITHUB_OUTPUT`: `kind`, `install`, `build`,
/// `output-dir`, and `framework` when one is found. Reads `ROOT_DIR`,
/// `BUILD_COMMAND` and `OUTPUT_DIR` as the build does; `--root-dir DIR` is
/// the same as `ROOT_DIR`. A framework set up to need a server is `none`,
/// with what to change on standard error.
pub fn detect_cli(args: &[String]) -> i32 {
    let mut root = std::env::var("ROOT_DIR").unwrap_or_default();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--root-dir" => root = rest.next().cloned().unwrap_or_default(),
            "--help" | "-h" => {
                println!(
                    "g1t-runner detect [--root-dir DIR]: prints kind, install, build, output-dir and framework (when one is found) as key=value lines."
                );
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
            if let Some(problem) = &found.problem {
                eprintln!("g1t-runner detect: {problem}");
            }
            0
        }
        Err(error) => {
            eprintln!("g1t-runner detect: {error:#}");
            1
        }
    }
}

/// `Detected` as `$GITHUB_OUTPUT` lines; a value on one line, empty when
/// there is none. `framework` is left out when none was found, which a
/// step's outputs read as empty all the same.
fn output_lines(found: &Detected) -> String {
    let one_line = |value: Option<&str>| value.unwrap_or_default().replace(['\r', '\n'], " ");
    let mut lines = format!(
        "kind={}\ninstall={}\nbuild={}\noutput-dir={}\n",
        found.kind,
        one_line(found.install.as_deref()),
        one_line(found.build.as_deref()),
        one_line(found.output_dir.as_deref()),
    );
    if let Some(framework) = &found.framework {
        lines.push_str(&format!("framework={}\n", framework.id));
    }
    lines
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
        // A config a build wrote lists every kind of binding, mostly empty.
        let written: WranglerConfig = serde_json::from_str(
            r#"{ "main": "entry.mjs", "d1_databases": [], "durable_objects": { "bindings": [] }, "triggers": {}, "kv_namespaces": [{ "binding": "SESSION" }] }"#,
        )
        .unwrap();
        assert_eq!(config_warnings(&written).len(), 1);
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
        assert_eq!(found.install.as_deref(), Some("corepack enable && pnpm install --frozen-lockfile"));
        assert_eq!(found.framework, None);
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
        assert_eq!(found.kind, "static");
        assert_eq!(found.install.as_deref(), Some("npm ci"));
        assert_eq!(found.build.as_deref(), Some("npm run build"));
        assert_eq!(found.output_dir, None, "its output is found once it has built");
        assert_eq!(found.framework, None, "a build script alone names no framework");
        std::fs::create_dir_all(built.join("dist")).unwrap();
        std::fs::write(built.join("dist/index.html"), "<h1>hi</h1>").unwrap();
        assert_eq!(detect(&built, None, None).unwrap().output_dir.as_deref(), Some("dist"));
        assert_eq!(detect(&built, None, Some("/site/")).unwrap().output_dir.as_deref(), Some("site"));

        let html = project("html", &[("index.html", "<h1>hi</h1>")]);
        let found = detect(&html, None, None).unwrap();
        assert_eq!((found.kind, found.install, found.build, found.output_dir.as_deref()), ("html", None, None, Some(".")));
        // A `public` folder alone, without an index.html, is not a site.
        let empty = project("empty", &[("public/robots.txt", ""), ("README.md", "")]);
        assert_eq!(detect(&empty, None, None).unwrap().kind, "none");
    }

    #[test]
    fn detect_prints_lines_for_github_output() {
        let mut found = Detected {
            kind: "static",
            framework: None,
            install: Some("npm ci".into()),
            build: Some("a\nb".into()),
            output_dir: None,
            problem: None,
            pre_build: None,
        };
        assert_eq!(output_lines(&found), "kind=static\ninstall=npm ci\nbuild=a b\noutput-dir=\n");
        let vite = project("lines", &[("package.json", r#"{ "devDependencies": { "vite": "7" } }"#)]);
        found.framework = frameworks::detect(&vite, false);
        assert!(output_lines(&found).ends_with("output-dir=\nframework=vite\n"));
    }

    /// One project of the table below: its files, the project's own
    /// settings, and what detect should say.
    struct Case {
        name: &'static str,
        files: &'static [(&'static str, &'static str)],
        custom_build: Option<&'static str>,
        chosen_output: Option<&'static str>,
        kind: &'static str,
        framework: Option<&'static str>,
        build: Option<&'static str>,
        output_dir: Option<&'static str>,
        /// A phrase the problem says, if there is one.
        problem: Option<&'static str>,
    }

    const CASE: Case = Case {
        name: "",
        files: &[],
        custom_build: None,
        chosen_output: None,
        kind: "static",
        framework: None,
        build: Some("npm run build"),
        output_dir: None,
        problem: None,
    };

    #[test]
    fn detect_knows_each_framework() {
        let cases = [
            Case {
                name: "vite",
                files: &[("package.json", r#"{ "devDependencies": { "vite": "7" } }"#)],
                framework: Some("vite"),
                build: Some("npx vite build"),
                output_dir: Some("dist"),
                ..CASE
            },
            Case {
                name: "vite-react",
                files: &[
                    ("package.json", r#"{ "scripts": { "build": "tsc && vite build" }, "dependencies": { "react": "19" }, "devDependencies": { "vite": "7", "@vitejs/plugin-react": "5" } }"#),
                    ("vite.config.ts", "export default defineConfig({ plugins: [react()], build: { outDir: 'site' } })"),
                ],
                framework: Some("vite-react"),
                output_dir: Some("site"),
                ..CASE
            },
            Case {
                name: "vite-vue",
                files: &[("package.json", r#"{ "scripts": { "build": "vite build" }, "devDependencies": { "vite": "7", "@vitejs/plugin-vue": "6" } }"#)],
                framework: Some("vite-vue"),
                output_dir: Some("dist"),
                ..CASE
            },
            Case {
                name: "vite-svelte",
                files: &[("package.json", r#"{ "devDependencies": { "vite": "7", "@sveltejs/vite-plugin-svelte": "6" } }"#)],
                framework: Some("vite-svelte"),
                build: Some("npx vite build"),
                output_dir: Some("dist"),
                ..CASE
            },
            Case {
                name: "vite-solid",
                files: &[("package.json", r#"{ "devDependencies": { "vite": "7", "vite-plugin-solid": "2" } }"#)],
                framework: Some("vite-solid"),
                build: Some("npx vite build"),
                output_dir: Some("dist"),
                ..CASE
            },
            Case {
                name: "vite-cloudflare",
                files: &[
                    ("package.json", r#"{ "scripts": { "build": "vite build" }, "devDependencies": { "vite": "7", "@cloudflare/vite-plugin": "1" } }"#),
                    ("wrangler.jsonc", r#"{ "main": "worker/index.ts" }"#),
                ],
                kind: "workers",
                framework: Some("vite"),
                build: Some("npm run build && npx --yes wrangler@4 deploy --dry-run"),
                ..CASE
            },
            Case {
                name: "astro",
                files: &[("package.json", r#"{ "scripts": { "build": "astro build" }, "dependencies": { "astro": "5" } }"#), ("astro.config.mjs", "export default defineConfig({ site: 'https://x.dev' })")],
                framework: Some("astro"),
                output_dir: Some("dist"),
                ..CASE
            },
            Case {
                name: "astro-server",
                files: &[("package.json", r#"{ "dependencies": { "astro": "5", "@astrojs/node": "9" } }"#), ("astro.config.mjs", "export default { output: \"server\" }")],
                kind: "none",
                framework: Some("astro"),
                build: None,
                problem: Some("`output: 'static'`"),
                ..CASE
            },
            Case {
                name: "astro-cloudflare",
                files: &[("package.json", r#"{ "scripts": { "build": "astro build" }, "dependencies": { "astro": "5", "@astrojs/cloudflare": "12" } }"#)],
                kind: "workers",
                framework: Some("astro"),
                ..CASE
            },
            Case {
                name: "astro-cloudflare-folder",
                files: &[("package.json", r#"{ "scripts": { "build": "astro build" }, "dependencies": { "astro": "5", "@astrojs/cloudflare": "12" } }"#)],
                chosen_output: Some("dist"),
                framework: Some("astro"),
                output_dir: Some("dist"),
                ..CASE
            },
            Case {
                name: "next-export",
                files: &[("package.json", r#"{ "scripts": { "build": "next build" }, "dependencies": { "next": "16" } }"#), ("next.config.ts", "const config: NextConfig = {\n  output: 'export',\n};")],
                framework: Some("nextjs"),
                output_dir: Some("out"),
                ..CASE
            },
            Case {
                name: "next-server",
                files: &[("package.json", r#"{ "scripts": { "build": "next build" }, "dependencies": { "next": "16" } }"#), ("next.config.mjs", "export default {}")],
                kind: "none",
                framework: Some("nextjs"),
                build: None,
                problem: Some("`@opennextjs/cloudflare`"),
                ..CASE
            },
            Case {
                name: "next-server-own-folder",
                files: &[("package.json", r#"{ "scripts": { "build": "next build" }, "dependencies": { "next": "16" } }"#)],
                chosen_output: Some("out"),
                framework: Some("nextjs"),
                output_dir: Some("out"),
                ..CASE
            },
            Case {
                name: "opennext",
                files: &[
                    ("package.json", r#"{ "scripts": { "build": "next build" }, "dependencies": { "next": "16", "@opennextjs/cloudflare": "1" } }"#),
                    ("wrangler.jsonc", r#"{ "main": ".open-next/worker.js", "assets": { "directory": ".open-next/assets", "binding": "ASSETS" } }"#),
                ],
                kind: "workers",
                framework: Some("nextjs"),
                build: Some("npx opennextjs-cloudflare build && npx --yes wrangler@4 deploy --dry-run"),
                output_dir: Some(".open-next/assets"),
                ..CASE
            },
            Case {
                name: "opennext-no-config",
                files: &[("package.json", r#"{ "dependencies": { "next": "16", "@opennextjs/cloudflare": "1" } }"#)],
                kind: "none",
                framework: Some("nextjs"),
                build: None,
                problem: Some("`.open-next/worker.js`"),
                ..CASE
            },
            Case {
                name: "sveltekit-static",
                files: &[
                    ("package.json", r#"{ "scripts": { "build": "vite build" }, "devDependencies": { "@sveltejs/kit": "2", "@sveltejs/adapter-static": "3", "vite": "7" } }"#),
                    ("svelte.config.js", "import adapter from '@sveltejs/adapter-static';\nexport default { kit: { adapter: adapter() } };"),
                ],
                framework: Some("sveltekit"),
                output_dir: Some("build"),
                ..CASE
            },
            Case {
                name: "sveltekit-3-static",
                files: &[
                    ("package.json", r#"{ "scripts": { "build": "vite build" }, "devDependencies": { "@sveltejs/kit": "3", "@sveltejs/adapter-static": "4", "@sveltejs/adapter-cloudflare": "8" } }"#),
                    ("vite.config.js", "import adapter from '@sveltejs/adapter-static';\nexport default defineConfig({ plugins: [sveltekit({ adapter: adapter({ pages: 'www' }) })] });"),
                ],
                framework: Some("sveltekit"),
                output_dir: Some("www"),
                ..CASE
            },
            Case {
                name: "sveltekit-cloudflare",
                files: &[("package.json", r#"{ "scripts": { "build": "vite build" }, "devDependencies": { "@sveltejs/kit": "2", "@sveltejs/adapter-cloudflare": "7" } }"#)],
                kind: "workers",
                framework: Some("sveltekit"),
                ..CASE
            },
            Case {
                name: "sveltekit-auto",
                files: &[("package.json", r#"{ "scripts": { "build": "vite build" }, "devDependencies": { "@sveltejs/kit": "2", "@sveltejs/adapter-auto": "6" } }"#)],
                kind: "none",
                framework: Some("sveltekit"),
                build: None,
                problem: Some("`@sveltejs/adapter-static`"),
                ..CASE
            },
            Case {
                name: "nuxt",
                files: &[("package.json", r#"{ "scripts": { "build": "nuxt build", "generate": "nuxt generate" }, "dependencies": { "nuxt": "4" } }"#)],
                framework: Some("nuxt"),
                build: Some("npm run generate"),
                output_dir: Some(".output/public"),
                ..CASE
            },
            Case {
                name: "nuxt-no-generate",
                files: &[("package.json", r#"{ "scripts": { "build": "nuxt build" }, "dependencies": { "nuxt": "4" } }"#)],
                framework: Some("nuxt"),
                build: Some("npx nuxi generate"),
                output_dir: Some(".output/public"),
                ..CASE
            },
            Case {
                name: "react-router-spa",
                files: &[
                    ("package.json", r#"{ "scripts": { "build": "react-router build" }, "devDependencies": { "@react-router/dev": "7", "vite": "7" } }"#),
                    ("react-router.config.ts", "export default {\n  // Server-side render by default\n  ssr: false,\n} satisfies Config;"),
                ],
                framework: Some("react-router"),
                output_dir: Some("build/client"),
                ..CASE
            },
            Case {
                name: "react-router-ssr",
                files: &[("package.json", r#"{ "devDependencies": { "@react-router/dev": "7" } }"#), ("react-router.config.ts", "export default { ssr: true }")],
                kind: "none",
                framework: Some("react-router"),
                build: None,
                problem: Some("`ssr: false`"),
                ..CASE
            },
            Case {
                name: "remix-spa",
                files: &[
                    ("package.json", r#"{ "scripts": { "build": "remix vite:build" }, "devDependencies": { "@remix-run/dev": "2", "vite": "5" } }"#),
                    ("vite.config.ts", "export default defineConfig({ plugins: [remix({ ssr: false })] })"),
                ],
                framework: Some("remix"),
                output_dir: Some("build/client"),
                ..CASE
            },
            Case {
                name: "gatsby",
                files: &[("package.json", r#"{ "scripts": { "build": "gatsby build" }, "dependencies": { "gatsby": "5" } }"#)],
                framework: Some("gatsby"),
                output_dir: Some("public"),
                ..CASE
            },
            Case {
                name: "docusaurus",
                files: &[("package.json", r#"{ "scripts": { "build": "docusaurus build" }, "dependencies": { "@docusaurus/core": "3" } }"#)],
                framework: Some("docusaurus"),
                output_dir: Some("build"),
                ..CASE
            },
            Case {
                name: "eleventy",
                files: &[("package.json", r#"{ "devDependencies": { "@11ty/eleventy": "3" } }"#)],
                framework: Some("eleventy"),
                build: Some("npx @11ty/eleventy"),
                output_dir: Some("_site"),
                ..CASE
            },
            Case {
                name: "angular",
                files: &[
                    ("package.json", r#"{ "scripts": { "build": "ng build" }, "dependencies": { "@angular/core": "20" } }"#),
                    ("angular.json", r#"{ "projects": { "shop": { "projectType": "application", "architect": { "build": { "builder": "@angular/build:application", "options": { "outputPath": "dist/shop" } } } } } }"#),
                ],
                framework: Some("angular"),
                output_dir: Some("dist/shop/browser"),
                ..CASE
            },
            Case {
                name: "angular-default",
                files: &[
                    ("package.json", r#"{ "dependencies": { "@angular/core": "20" } }"#),
                    ("angular.json", r#"{ "projects": { "app": { "projectType": "application", "architect": { "build": { "builder": "@angular/build:application", "options": {} } } } } }"#),
                ],
                framework: Some("angular"),
                build: Some("npx ng build"),
                output_dir: Some("dist/app/browser"),
                ..CASE
            },
            Case {
                name: "hugo",
                files: &[("hugo.toml", "baseURL = 'https://example.org/'\ntitle = 'Site'\n")],
                framework: Some("hugo"),
                build: Some(frameworks_hugo()),
                output_dir: Some("public"),
                ..CASE
            },
            Case {
                name: "hugo-config-toml",
                files: &[("config.toml", "baseURL = \"https://example.org/\"\npublishDir = \"site\"\n")],
                framework: Some("hugo"),
                build: Some(frameworks_hugo()),
                output_dir: Some("site"),
                ..CASE
            },
            Case {
                name: "not-hugo",
                files: &[("config.toml", "base_url = \"https://example.org\"\n"), ("index.html", "")],
                kind: "html",
                build: None,
                output_dir: Some("."),
                ..CASE
            },
            Case {
                name: "jekyll",
                files: &[("_config.yml", "title: Blog\n"), ("Gemfile", "gem 'jekyll'\n")],
                framework: Some("jekyll"),
                build: Some("bundle exec jekyll build"),
                output_dir: Some("_site"),
                ..CASE
            },
            Case {
                name: "mdbook",
                files: &[("book.toml", "[book]\ntitle = \"Guide\"\n")],
                framework: Some("mdbook"),
                build: Some(frameworks_mdbook()),
                output_dir: Some("book"),
                ..CASE
            },
            Case {
                name: "mdbook-build-dir",
                files: &[("book.toml", "[book]\ntitle = \"Guide\"\n[build]\nbuild-dir = \"site\"\n")],
                framework: Some("mdbook"),
                build: Some(frameworks_mdbook()),
                output_dir: Some("site"),
                ..CASE
            },
            // The project's own settings win.
            Case {
                name: "own-settings",
                files: &[("package.json", r#"{ "scripts": { "build": "vite build" }, "devDependencies": { "vite": "7" } }"#)],
                custom_build: Some("make site"),
                chosen_output: Some("www"),
                framework: Some("vite"),
                build: Some("make site"),
                output_dir: Some("www"),
                ..CASE
            },
        ];
        for case in cases {
            let dir = project(&format!("fw-{}", case.name), case.files);
            let found = detect(&dir, case.custom_build, case.chosen_output).unwrap();
            let name = case.name;
            assert_eq!(found.kind, case.kind, "{name}: kind");
            assert_eq!(found.framework.as_ref().map(|f| f.id), case.framework, "{name}: framework");
            assert_eq!(found.build.as_deref(), case.build, "{name}: build");
            assert_eq!(found.output_dir.as_deref(), case.output_dir, "{name}: output-dir");
            match case.problem {
                Some(phrase) => assert!(found.problem.as_deref().is_some_and(|p| p.contains(phrase)), "{name}: {:?}", found.problem),
                None => assert_eq!(found.problem, None, "{name}: problem"),
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    fn frameworks_hugo() -> &'static str {
        "if command -v hugo >/dev/null 2>&1; then hugo --minify; else npx --yes hugo-extended@0.166.0 --minify; fi"
    }

    fn frameworks_mdbook() -> &'static str {
        "if ! command -v mdbook >/dev/null 2>&1; then cargo install mdbook --version 0.5.4 --locked --quiet; fi && mdbook build"
    }

    #[test]
    fn jekyll_installs_its_gems_after_the_packages() {
        let dir = project("jekyll-install", &[("_config.yml", ""), ("Gemfile", ""), ("package.json", "{}")]);
        let found = detect(&dir, None, None).unwrap();
        assert_eq!(found.install.as_deref(), Some("npm install && bundle config set --local path vendor/bundle && bundle install"));
    }

    #[test]
    fn an_adapters_worker_is_found_once_built_and_never_served() {
        let dir = project(
            "adapter",
            &[
                ("dist/_worker.js/index.js", "export default {}"),
                ("dist/_routes.json", "{}"),
                ("dist/.assetsignore", "_worker.js\nsecret.txt\n"),
                ("dist/secret.txt", "no"),
                ("dist/index.html", "<h1>hi</h1>"),
                ("dist/about/_worker.js", "a page's own file"),
                ("kit/.svelte-kit/cloudflare/_worker.js", "export default {}"),
            ],
        );
        let astro = Adapter { entry: "dist/_worker.js", assets: "dist" };
        assert_eq!(adapter_entry(&dir, &astro), Some(dir.join("dist/_worker.js/index.js")));
        let kit = Adapter { entry: ".svelte-kit/cloudflare/_worker.js", assets: ".svelte-kit/cloudflare" };
        assert_eq!(adapter_entry(&dir.join("kit"), &kit), Some(dir.join("kit/.svelte-kit/cloudflare/_worker.js")));
        assert_eq!(adapter_entry(&dir.join("missing"), &kit), None);
        let mut served: Vec<String> = collect_site(&dir.join("dist"), false).unwrap().into_iter().map(|a| a.path).collect();
        served.sort();
        assert_eq!(served, ["/about/_worker.js", "/index.html"]);
    }

    #[test]
    fn a_config_the_build_wrote_is_read_in_place_of_the_projects() {
        let dir = project(
            "redirected",
            &[
                ("wrangler.jsonc", r#"{ "main": "worker/index.ts" }"#),
                (".wrangler/deploy/config.json", r#"{ "configPath": "../../dist/app/wrangler.json" }"#),
                ("dist/app/wrangler.json", r#"{ "main": "index.js", "assets": { "directory": "../client" } }"#),
            ],
        );
        let (config, base) = redirected_config(&dir).unwrap().unwrap();
        assert_eq!(config.main.as_deref(), Some("index.js"));
        assert_eq!(base, dir.join("dist/app").canonicalize().unwrap());
        assert!(base.join(config.assets.unwrap().directory.unwrap()).ends_with("dist/app/../client"));
        assert!(redirected_config(&project("not-redirected", &[])).unwrap().is_none());
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
        assert_eq!(wrangler_build(Some(Path::new("/tmp/b")), None), "npx --yes wrangler@4 deploy --dry-run --outdir /tmp/b");
        assert_eq!(
            wrangler_build(Some(Path::new("/tmp/b")), Some(Path::new("/tmp/w.json"))),
            "npx --yes wrangler@4 deploy --dry-run --config /tmp/w.json --outdir /tmp/b"
        );
    }
}
