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
//! - `BUILD_COMMAND`, `OUTPUT_DIR`: the repository's own choices, if any.
//! - `BUILD_ENV`, `BUILD_SECRETS`: JSON objects of the repository's
//!   variables and secrets for deploy builds. Both are set for the build;
//!   secrets' values are redacted from its log.

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

/// Where `wrangler deploy --dry-run` writes the bundle.
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

/// The build's log, kept to its end.
#[derive(Default)]
struct Log {
    text: String,
}

impl Log {
    fn line(&mut self, line: &str) {
        self.text.push_str(line);
        self.text.push('\n');
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
    let result = run_command(command, Path::new(WORKDIR), secrets);
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadSession {
    jwt: String,
    #[serde(default)]
    buckets: Vec<Vec<String>>,
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
fn bundle_modules(main: &str) -> Result<(String, Vec<Module>)> {
    let stem = Path::new(main)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "index".to_owned());
    let mut modules = Vec::new();
    let mut files = Vec::new();
    collect_files(Path::new(BUNDLE_DIR), &mut files)?;
    for file in files {
        let name = file
            .strip_prefix(BUNDLE_DIR)?
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

/// What was built: the Worker's code and settings, and where its site is.
struct Built {
    worker: Value,
    assets_dir: Option<PathBuf>,
    warnings: Vec<String>,
}

fn build(log: &mut Log, secrets: &[String]) -> Result<Built> {
    let dir = Path::new(WORKDIR);
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
            for binding in UNSUPPORTED_BINDINGS {
                if config.rest.get(binding).is_some_and(|value| !value.is_null()) {
                    warnings.push(format!(
                        "`{binding}` is not provisioned on g1t.page yet, so the app runs without it."
                    ));
                }
            }
            let mut worker = json!({
                "compatibilityDate": config.compatibility_date.clone().unwrap_or_else(|| "2026-09-26".to_owned()),
                "compatibilityFlags": config.compatibility_flags,
                "vars": config.vars,
            });
            if let Some(main) = &config.main {
                // `--dry-run` runs the project's own build and bundles it,
                // without deploying anywhere.
                step(
                    log,
                    &format!("npx --yes wrangler@4 deploy --dry-run --outdir {BUNDLE_DIR}"),
                    secrets,
                )?;
                let (main_module, modules) = bundle_modules(main)?;
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
            })
        }
        None => {
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
                None => OUTPUT_DIRS
                    .iter()
                    .map(|name| dir.join(name))
                    .find(|path| path.join("index.html").exists() || (path.is_dir() && path != &dir.join("public")))
                    .or_else(|| dir.join("index.html").exists().then(|| dir.to_path_buf()))
                    .context(
                        "found nothing to serve: no Workers config, no index.html, and none of dist, build, out, public, _site or .output/public",
                    )?,
            };
            let spa = !assets_dir.join("404.html").exists();
            Ok(Built {
                worker: json!({
                    "compatibilityDate": "2026-09-26",
                    "compatibilityFlags": [],
                    "vars": {},
                    "notFoundHandling": if spa { "single-page-application" } else { "404-page" },
                }),
                assets_dir: Some(assets_dir),
                warnings,
            })
        }
    }
}

fn check_out(secrets: &[String]) -> Result<()> {
    let remote = env("GIT_REMOTE")?;
    let commit = env("GIT_COMMIT")?;
    let auth = auth_option(&env("G1T_USER")?, &env("G1T_TOKEN")?);
    std::fs::create_dir_all("/work")?;
    let cloned = git(Path::new("/work"), &["-c", &auth, "clone", "--quiet", &remote, WORKDIR]).and_then(|_| {
        git(
            Path::new(WORKDIR),
            &["-c", "advice.detachedHead=false", "checkout", "--quiet", &commit],
        )
    });
    if let Err(error) = cloned {
        bail!("{}", redact(&format!("{error:#}"), secrets));
    }
    Ok(())
}

fn deploy(reporter: &Reporter, log: &mut Log, secrets: &[String]) -> Result<Value> {
    check_out(secrets).context("the commit could not be checked out")?;
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
    });
    if let Some(dir) = &built.assets_dir {
        let skip_project = dir == Path::new(WORKDIR);
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

pub fn main() -> i32 {
    let reporter = match (env("G1T_API"), env("DEPLOY_ID"), env("DEPLOY_TOKEN")) {
        (Ok(api), Ok(id), Ok(token)) => Reporter {
            base: format!("{api}/deployments/jobs/{id}"),
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
    let mut log = Log::default();
    let outcome = deploy(&reporter, &mut log, &secrets);
    let seconds = started.elapsed().as_secs();
    let sent = match outcome {
        Ok(mut finish) => {
            finish["log"] = redact(&log.tail(), &secrets).into();
            finish["buildSeconds"] = seconds.into();
            reporter.send("finish", finish)
        }
        Err(error) => {
            let message = redact(&format!("{error:#}"), &secrets);
            log.line(&format!("The build failed: {message}"));
            reporter.send(
                "fail",
                json!({ "message": message, "log": redact(&log.tail(), &secrets), "buildSeconds": seconds }),
            )
        }
    };
    match sent {
        Ok(_) => 0,
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn files_are_typed_by_extension() {
        assert_eq!(content_type("/index.HTML"), "text/html");
        assert_eq!(content_type("/a/b.woff2"), "font/woff2");
        assert_eq!(content_type("/LICENSE"), "application/octet-stream");
    }
}
