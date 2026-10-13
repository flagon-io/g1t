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
    let dir = checkout("deploy", &[("site/index.html", "<h1>hello</h1>"), ("site/about.html", "<p>about</p>"), ("README.md", "not served")]);
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
    let dir = checkout(
        "container-site",
        &[("index.html", "<h1>hello</h1>"), ("server.js", ""), ("Dockerfile", "FROM node:22-slim\nCOPY . .\nCMD [\"node\", \"server.js\"]\n")],
    );
    let output = deploy(&dir, &api, &[]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}
{}", String::from_utf8_lossy(&output.stderr));
    assert!(stdout.contains("Building it as a container from Dockerfile, not as the plain HTML site it also has"), "{stdout}");
    assert!(stdout.contains("as a plain HTML site instead"), "{stdout}");
    let seen = seen.lock().unwrap();
    let steps: Vec<&str> = seen.iter().map(|(path, _)| path.as_str()).collect();
    assert_eq!(steps[1], "/deployments/jobs/dpl_1/registry");
    assert_eq!(seen.last().unwrap().1["detected"], "html");
    drop(seen);
    // A Dockerfile that only serves the site with nginx: the site, with no
    // image asked for.
    let (api, seen) = fake_api();
    let files = checkout("files-only", &[("index.html", "<h1>hello</h1>"), ("Dockerfile", "FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nEXPOSE 80\n")]);
    let output = deploy(&files, &api, &[]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}");
    assert!(stdout.contains("its Dockerfile only serves files with `nginx`"), "{stdout}");
    let seen = seen.lock().unwrap();
    assert!(!seen.iter().any(|(path, _)| path.ends_with("/registry")));
    assert_eq!(seen.last().unwrap().1["detected"], "html");
    drop(seen);
    // A server with nothing else to serve fails, saying so.
    let server = checkout("container-only", &[("package.json", r#"{ "scripts": { "start": "node index.js" }, "dependencies": { "express": "5" } }"#)]);
    let output = deploy(&server, &api, &[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stdout).contains("Docker deployments are switched off"));
    // Build as Static site skips the Dockerfile altogether.
    let output = deploy(&dir, &api, &[("BUILD_AS", "static")]);
    assert!(output.status.success());
    let detect = runner().arg("detect").current_dir(&server).env_remove("GIT_REMOTE").output().unwrap();
    assert_eq!(
        String::from_utf8_lossy(&detect.stdout),
        "kind=container
install=
build=docker build -f Dockerfile (written by g1t) .
output-dir=
framework=node
dockerfile=
port=8080
"
    );
}
