//! `g1t-runner deploy` and `g1t-runner detect` as a workflow step runs
//! them: in a checkout of its own, with nothing cloned, reporting to an API
//! (here a fake one on localhost) with the build's token.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

fn runner() -> Command {
    Command::new(env!("CARGO_BIN_EXE_g1t-runner"))
}

/// A fresh checkout holding `files`.
fn checkout(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("g1t-runner-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    for (path, text) in files {
        let path = dir.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    dir
}

#[test]
fn detect_prints_what_the_build_would_find() {
    let dir = checkout("detect", &[("site/index.html", "<h1>hello</h1>")]);
    let output = runner().arg("detect").args(["--root-dir", "site"]).current_dir(&dir).env_remove("GIT_REMOTE").output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "kind=html\ninstall=\nbuild=\noutput-dir=.\n");
    let unknown = runner().args(["detect", "--nope"]).current_dir(&dir).output().unwrap();
    assert_eq!(unknown.status.code(), Some(2));
}

/// The API's `/deployments/jobs/<id>/<step>`: answers each step as the
/// deployments service does, and keeps what it was sent.
fn fake_api() -> (String, Arc<Mutex<Vec<(String, Value)>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let kept = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            let path = first.split_whitespace().nth(1).unwrap_or_default().to_owned();
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let answer = if path.ends_with("/session") {
                json!({ "ok": true, "value": { "jwt": "complete-me", "buckets": [], "upload_url": "http://127.0.0.1:9/never" } })
            } else if path.ends_with("/registry") {
                // As the deployments service answers while it runs no containers.
                json!({ "ok": false, "error": { "code": "not_enabled", "message": "Docker deployments are not on." } })
            } else {
                json!({ "ok": true, "value": true })
            };
            kept.lock().unwrap().push((path, body));
            let text = answer.to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
                text.len()
            );
        }
    });
    (base, seen)
}

fn deploy(dir: &Path, api: &str, extra: &[(&str, &str)]) -> std::process::Output {
    let mut command = runner();
    command
        .arg("deploy")
        .current_dir(dir)
        .env_remove("GIT_REMOTE")
        .env("G1T_API", api)
        .env("DEPLOY_ID", "dpl_1")
        .env("DEPLOY_TOKEN", "build-token-0123456789")
        .env("BUILD_SECRETS", r#"{"API_KEY":"very-secret-value"}"#)
        .env("BUILD_ENV", r#"{"PUBLIC_URL":"https://example.com"}"#);
    for (name, value) in extra {
        command.env(name, value);
    }
    command.output().unwrap()
}

#[test]
fn deploy_builds_the_checkout_it_runs_in_without_cloning() {
    let (api, seen) = fake_api();
    let dir =
        checkout("deploy", &[("site/index.html", "<h1>hello</h1>"), ("site/about.html", "<p>about</p>"), ("README.md", "not served")]);
    let output = deploy(&dir, &api, &[("ROOT_DIR", "site")]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
    // Its log is the step's too.
    assert!(stdout.contains("as it is checked out"), "{stdout}");
    assert!(stdout.contains("Uploading 2 files."), "{stdout}");
    let seen = seen.lock().unwrap();
    let steps: Vec<&str> = seen.iter().map(|(path, _)| path.as_str()).collect();
    assert_eq!(steps, ["/deployments/jobs/dpl_1/started", "/deployments/jobs/dpl_1/session", "/deployments/jobs/dpl_1/finish"]);
    for (_, body) in seen.iter() {
        assert_eq!(body["token"], "build-token-0123456789");
    }
    let manifest = seen[1].1["manifest"].as_object().unwrap();
    let mut files: Vec<&String> = manifest.keys().collect();
    files.sort();
    assert_eq!(files, ["/about.html", "/index.html"]);
    let finish = &seen[2].1;
    assert_eq!(finish["detected"], "html");
    assert_eq!(finish["completionJwt"], "complete-me");
    assert!(!finish["log"].as_str().unwrap().contains("build-token-0123456789"));
}

#[test]
fn a_failed_build_is_reported_and_fails_the_step() {
    let (api, seen) = fake_api();
    let dir = checkout("fail", &[("README.md", "nothing to serve")]);
    let output = deploy(&dir, &api, &[]);
    assert_eq!(output.status.code(), Some(1));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("found nothing to serve"), "{stdout}");
    let seen = seen.lock().unwrap();
    assert_eq!(seen.last().unwrap().0, "/deployments/jobs/dpl_1/fail");
    // A missing root directory says so.
    drop(seen);
    let missing = deploy(&dir, &api, &[("ROOT_DIR", "apps/web")]);
    assert_eq!(missing.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&missing.stdout).contains("does not exist in this checkout"));
}

#[test]
fn deploy_needs_its_build() {
    let output = runner().arg("deploy").env_remove("DEPLOY_ID").env_remove("DEPLOY_TOKEN").output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("DEPLOY_ID"));
}

#[test]
fn a_container_is_built_as_its_site_where_containers_are_switched_off() {
    let (api, seen) = fake_api();
    // A Go server beside a folder of files: a container, else the files.
    let dir =
        checkout("container-site", &[("go.mod", "module x\n"), ("main.go", "package main\n"), ("public/index.html", "<h1>hello</h1>")]);
    let output = deploy(&dir, &api, &[]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}
{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.contains("Building it as a Go server, not as a site of `public`"), "{stdout}");
    assert!(stdout.contains("as a static site instead"), "{stdout}");
    let seen = seen.lock().unwrap();
    let steps: Vec<&str> = seen.iter().map(|(path, _)| path.as_str()).collect();
    assert_eq!(steps[1], "/deployments/jobs/dpl_1/registry");
    assert_eq!(seen.last().unwrap().1["detected"], "static");
    drop(seen);
    // A site beside a Dockerfile that runs a server: the site, with no
    // image asked for, saying the Dockerfile is not used.
    let (api, seen) = fake_api();
    let files = checkout(
        "site-and-dockerfile",
        &[
            ("index.html", "<h1>hello</h1>"),
            ("server.js", ""),
            ("Dockerfile", "FROM node:22-slim\nCOPY . .\nCMD [\"node\", \"server.js\"]\n"),
        ],
    );
    let output = deploy(&files, &api, &[]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}");
    assert!(stdout.contains("Built as a plain HTML site; Dockerfile is not used (a container is only the fallback"), "{stdout}");
    let seen = seen.lock().unwrap();
    assert!(!seen.iter().any(|(path, _)| path.ends_with("/registry")));
    assert_eq!(seen.last().unwrap().1["detected"], "html");
    drop(seen);
    // A server with nothing else to serve fails, saying so.
    let server = checkout("container-only", &[("go.mod", "module x\n"), ("main.go", "package main\n")]);
    let output = deploy(&server, &api, &[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stdout).contains("Docker deployments are switched off"));
    // Build as Static site skips the server altogether.
    let output = deploy(&dir, &api, &[("BUILD_AS", "static")]);
    assert!(output.status.success());
    let detect = runner().arg("detect").current_dir(&server).env_remove("GIT_REMOTE").output().unwrap();
    assert_eq!(
        String::from_utf8_lossy(&detect.stdout),
        "kind=container
install=
build=docker build -f Dockerfile (written by g1t) .
output-dir=
framework=go
dockerfile=
port=8080
"
    );
}

/// Whether `npx` can run here: the Node.js tests below need it, and the
/// network to install their packages.
fn has_npx() -> bool {
    Command::new(if cfg!(windows) { "npx.cmd" } else { "npx" }).arg("--version").output().is_ok_and(|output| output.status.success())
}

/// One of the Node.js tests at a time: two `npx --yes wrangler@4` installing
/// into an empty npx cache at once leave it broken for both.
static NPX: Mutex<()> = Mutex::new(());

#[test]
#[ignore = "installs Express and wrangler from npm, and runs the Worker with wrangler dev"]
fn an_express_server_deploys_as_a_worker() {
    let _one = NPX.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !has_npx() {
        return;
    }
    let (api, seen) = fake_api();
    let dir = checkout(
        "express-worker",
        &[
            ("package.json", r#"{ "private": true, "scripts": { "start": "node server.js" }, "dependencies": { "express": "5.1.0" } }"#),
            (
                "server.js",
                "const express = require('express');\nconst app = express();\napp.use(express.static('public'));\napp.get('/api', (req, res) => res.json({ ok: true, url: process.env.PUBLIC_URL }));\napp.listen(process.env.PORT || 3000, '0.0.0.0');\n",
            ),
            ("public/index.html", "<h1>hello</h1>"),
        ],
    );
    let output = deploy(&dir, &api, &[]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
    // The build's log, for `--nocapture`.
    eprintln!("{stdout}");
    assert!(stdout.contains("Running this Express server as a Worker, from `server.js`"), "{stdout}");
    assert!(stdout.contains("It started and answered a request, as a Worker."), "{stdout}");
    assert!(stdout.contains("Serving `public` as the Worker's static files"), "{stdout}");
    let seen = seen.lock().unwrap();
    assert!(!seen.iter().any(|(path, _)| path.ends_with("/registry")));
    let finish = &seen.last().unwrap().1;
    assert_eq!((finish["detected"].as_str(), finish["framework"].as_str()), (Some("workers"), Some("node")));
    assert_eq!(finish["worker"]["mainModule"], "g1t-entry.js");
    assert_eq!(finish["worker"]["compatibilityFlags"], json!(["nodejs_compat"]));
    let manifest = seen.iter().find(|(path, _)| path.ends_with("/session")).unwrap().1["manifest"].as_object().unwrap().clone();
    assert_eq!(manifest.keys().collect::<Vec<_>>(), ["/index.html"]);
}

#[test]
#[ignore = "installs packages from npm and bundles them with wrangler"]
fn a_server_that_cannot_run_as_a_worker_falls_back_to_a_container() {
    let _one = NPX.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !has_npx() {
        return;
    }
    let (api, seen) = fake_api();
    // A module the bundle cannot find: wrangler fails, and the container is
    // next (switched off here, so the build fails saying both).
    let dir = checkout(
        "worker-fallback",
        &[
            ("package.json", r#"{ "private": true, "scripts": { "start": "node server.js" }, "dependencies": { "express": "5.1.0" } }"#),
            ("server.js", "require('./missing-module');\nrequire('express')().listen(3000);\n"),
        ],
    );
    let output = deploy(&dir, &api, &[]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(output.status.code(), Some(1), "{stdout}");
    assert!(stdout.contains("Could not run as a Worker: `npx --yes wrangler@4 deploy --dry-run"), "{stdout}");
    assert!(stdout.contains("; deploying as a container."), "{stdout}");
    assert!(stdout.contains("Docker deployments are switched off"), "{stdout}");
    assert!(seen.lock().unwrap().iter().any(|(path, _)| path.ends_with("/registry")));
    // A top-level await that never settles bundles, and fails as it starts.
    let (api, _) = fake_api();
    let unsettled = checkout(
        "worker-unsettled",
        &[
            (
                "package.json",
                r#"{ "private": true, "type": "module", "scripts": { "start": "node server.js" }, "dependencies": { "express": "5.1.0" } }"#,
            ),
            (
                "server.js",
                "import express from 'express';\nawait new Promise((resolve) => setTimeout(resolve, 10));\nexpress().listen(3000);\n",
            ),
        ],
    );
    let output = deploy(&unsettled, &api, &[]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert_eq!(output.status.code(), Some(1), "{stdout}");
    assert!(stdout.contains("Could not run as a Worker: it failed as it started: Uncaught"), "{stdout}");
}
