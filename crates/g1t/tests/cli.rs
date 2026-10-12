//! The g1t binary against a mock API: what it asks for, what it prints, and
//! the exit codes it gives.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
struct Request {
    method: String,
    /// The path and query, as sent.
    target: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Request {
    fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or("")
    }
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

type Handler = dyn Fn(&Request) -> (u16, Value) + Send + Sync;

struct Mock {
    url: String,
    seen: Arc<Mutex<Vec<Request>>>,
}

impl Mock {
    fn start(handler: impl Fn(&Request) -> (u16, Value) + Send + Sync + 'static) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("").to_owned();
                let target = parts.next().unwrap_or("").to_owned();
                let mut headers = Vec::new();
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    let h = h.trim_end().to_owned();
                    if h.is_empty() {
                        break;
                    }
                    if let Some((k, v)) = h.split_once(':') {
                        headers.push((k.trim().to_owned(), v.trim().to_owned()));
                    }
                }
                let length: usize = headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, v)| v.parse().ok())
                    .unwrap_or(0);
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let request = Request {
                    method,
                    target,
                    headers,
                    body: String::from_utf8_lossy(&body).into_owned(),
                };
                let (status, reply) = handler(&request);
                log.lock().unwrap().push(request);
                let text = serde_json::to_string(&reply).unwrap();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
                    text.len()
                );
            }
        });
        Mock { url, seen }
    }

    fn requests(&self) -> Vec<Request> {
        self.seen.lock().unwrap().clone()
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("g1t-test-{name}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}

fn g1t(
    mock: &Mock,
    config: &PathBuf,
    args: &[&str],
    stdin: Option<&str>,
    token: Option<&str>,
) -> Run {
    let mut command = Command::new(env!("CARGO_BIN_EXE_g1t"));
    command
        .args(args)
        .current_dir(config)
        .env("G1T_API_URL", &mock.url)
        .env("G1T_CONFIG_DIR", config)
        .env("G1T_KEYRING", "off")
        .env("G1T_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .env("GIT_CEILING_DIRECTORIES", std::env::temp_dir())
        .env_remove("G1T_REPO")
        .env_remove("G1T_HOST")
        .env_remove("G1T_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(t) = token {
        command.env("G1T_TOKEN", t);
    }
    let mut child = command.spawn().unwrap();
    {
        let mut input = child.stdin.take().unwrap();
        if let Some(text) = stdin {
            input.write_all(text.as_bytes()).unwrap();
        }
    }
    let Output {
        status,
        stdout,
        stderr,
    } = child.wait_with_output().unwrap();
    Run {
        code: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    }
}

fn run(mock: &Mock, args: &[&str]) -> Run {
    let dir = temp_dir("run");
    g1t(mock, &dir, args, None, Some("g1t_test"))
}

fn issue(number: u64, title: &str, labels: &[&str]) -> Value {
    json!({
        "number": number, "title": title, "state": "open", "labels": labels, "body": "b",
        "author": { "username": "ana" }, "assignees": [], "updated_at": "2026-10-01T18:04:11.482Z",
    })
}

#[test]
fn issue_list_asks_for_open_issues_and_prints_json_fields() {
    let mock = Mock::start(|_| {
        (
            200,
            json!([issue(12, "Greeting", &["feature"]), issue(11, "Docs", &[])]),
        )
    });
    let out = run(
        &mock,
        &["issue", "list", "-R", "acme/web", "--json", "number,title"],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        out.stdout,
        "[{\"number\":12,\"title\":\"Greeting\"},{\"number\":11,\"title\":\"Docs\"}]\n"
    );
    let seen = mock.requests();
    assert_eq!(seen[0].method, "GET");
    assert_eq!(seen[0].target, "/repos/acme/web/issues?state=open");
    assert_eq!(seen[0].header("authorization"), Some("Bearer g1t_test"));
    assert!(
        seen[0]
            .header("user-agent")
            .unwrap()
            .starts_with("g1t-cli/")
    );
}

#[test]
fn piped_lists_are_tab_separated_without_a_header() {
    let mock = Mock::start(|_| (200, json!([issue(12, "Greeting", &["feature", "p1"])])));
    let out = run(&mock, &["issue", "list", "-R", "acme/web", "--limit", "5"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let line = out.stdout.lines().next().unwrap();
    let cells: Vec<&str> = line.split('\t').collect();
    assert_eq!(&cells[..3], &["#12", "Greeting", "feature, p1"]);
    assert_eq!(out.stdout.lines().count(), 1);
}

#[test]
fn limits_keep_lists_short() {
    let many: Vec<Value> = (1..=50).map(|n| issue(n, "x", &[])).collect();
    let mock = Mock::start(move |_| (200, Value::Array(many.clone())));
    let out = run(
        &mock,
        &["issue", "list", "-R", "acme/web", "--json", "number"],
    );
    let list: Vec<Value> = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(list.len(), 20, "the default page is small");
}

#[test]
fn jq_selects_from_the_json() {
    let mock = Mock::start(|_| {
        (
            200,
            json!([issue(12, "Greeting", &[]), issue(11, "Docs", &[])]),
        )
    });
    let out = run(
        &mock,
        &["issue", "list", "-R", "acme/web", "--jq", ".[].title"],
    );
    assert_eq!(out.stdout, "Greeting\nDocs\n");
}

#[test]
fn an_unknown_json_field_is_a_usage_error() {
    let mock = Mock::start(|_| (200, json!([issue(12, "Greeting", &[])])));
    let out = run(
        &mock,
        &["issue", "list", "-R", "acme/web", "--json", "nope"],
    );
    assert_eq!(out.code, 2);
    assert_eq!(out.stderr.lines().count(), 1, "{}", out.stderr);
    assert!(out.stderr.contains("Available:"), "{}", out.stderr);
}

#[test]
fn issue_create_sends_the_title_and_body() {
    let mock = Mock::start(|r| match (r.method.as_str(), r.path()) {
        ("POST", "/repos/acme/web/issues") => (200, issue(13, "Broken link", &["docs"])),
        _ => (
            404,
            json!({ "error": { "code": "not_found", "message": "No." } }),
        ),
    });
    let out = run(
        &mock,
        &[
            "issue",
            "create",
            "-R",
            "acme/web",
            "-t",
            "Broken link",
            "-b",
            "On the home page.",
            "-l",
            "docs",
        ],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout.trim(), "https://g1t.sh/acme/web/issues/13");
    let sent = mock.requests()[0].json();
    assert_eq!(
        sent,
        json!({ "title": "Broken link", "body": "On the home page.", "labels": ["docs"] })
    );
}

#[test]
fn a_missing_title_without_a_terminal_names_the_flag() {
    let mock = Mock::start(|_| (200, json!({})));
    let out = run(&mock, &["issue", "create", "-R", "acme/web"]);
    assert_eq!(out.code, 2);
    assert!(out.stderr.contains("--title"), "{}", out.stderr);
    assert!(mock.requests().is_empty());
}

#[test]
fn a_refused_token_exits_4_with_one_line() {
    let mock = Mock::start(|_| {
        (
            401,
            json!({ "error": { "code": "unauthenticated", "message": "The token is not valid." } }),
        )
    });
    let out = run(&mock, &["issue", "view", "12", "-R", "acme/web"]);
    assert_eq!(out.code, 4);
    assert_eq!(out.stderr.lines().count(), 1, "{}", out.stderr);
    assert!(
        out.stderr.starts_with("g1t: The token is not valid."),
        "{}",
        out.stderr
    );
}

#[test]
fn a_missing_scope_is_named() {
    let mock = Mock::start(|_| {
        (
            403,
            json!({ "error": { "code": "forbidden", "message": "Not allowed.", "needed_scope": "issues:write" } }),
        )
    });
    let out = run(&mock, &["issue", "close", "12", "-R", "acme/web"]);
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("`issues:write`"), "{}", out.stderr);
}

#[test]
fn usage_mistakes_exit_2_on_one_line() {
    let mock = Mock::start(|_| (200, json!({})));
    let out = run(&mock, &["issue", "list", "--state", "sideways"]);
    assert_eq!(out.code, 2);
    assert_eq!(out.stderr.lines().count(), 1, "{}", out.stderr);
    let out = run(&mock, &["frobnicate"]);
    assert_eq!(out.code, 2);
}

fn pull(check_status: &str) -> Value {
    json!({ "pull": { "number": 14, "title": "Greet", "status": "open", "head_commit": "9f2c4e1a7b3d5f60812a4c6e8b0d2f4a6c8e0b13", "check_status": check_status, "branch": "greet", "base": "main" }, "comments": [] })
}

fn checks_mock(runs: Value) -> Mock {
    Mock::start(move |r| match r.path() {
        "/repos/acme/web/pulls/14" => (200, pull("pending")),
        p if p.ends_with("/check-runs") => (200, runs.clone()),
        p if p.ends_with("/status") => (200, json!({ "state": "success", "statuses": [] })),
        _ => (404, json!({ "error": { "message": "No such endpoint." } })),
    })
}

#[test]
fn pr_checks_exit_codes_say_how_they_went() {
    let passing = json!({ "check_runs": [{ "name": "test", "status": "completed", "conclusion": "success" }] });
    let failing = json!({ "check_runs": [{ "name": "test", "status": "completed", "conclusion": "failure" }] });
    let pending =
        json!({ "check_runs": [{ "name": "test", "status": "in_progress", "conclusion": null }] });
    assert_eq!(
        run(
            &checks_mock(passing),
            &["pr", "checks", "14", "-R", "acme/web"]
        )
        .code,
        0
    );
    assert_eq!(
        run(
            &checks_mock(failing),
            &["pr", "checks", "14", "-R", "acme/web"]
        )
        .code,
        1
    );
    let mock = checks_mock(pending);
    let out = run(
        &mock,
        &[
            "pr",
            "checks",
            "14",
            "-R",
            "acme/web",
            "--json",
            "name,bucket",
        ],
    );
    assert_eq!(out.code, 8);
    assert_eq!(out.stdout, "[{\"bucket\":\"pending\",\"name\":\"test\"}]\n");
    let refs: Vec<String> = mock.requests().iter().map(|r| r.target.clone()).collect();
    assert!(
        refs.iter().any(|t| t.starts_with(
            "/repos/acme/web/commits/9f2c4e1a7b3d5f60812a4c6e8b0d2f4a6c8e0b13/check-runs"
        )),
        "{refs:?}"
    );
}

#[test]
fn pr_checks_watch_fail_fast_stops_at_the_first_failure() {
    let mixed = json!({ "check_runs": [
        { "name": "lint", "status": "completed", "conclusion": "failure", "html_url": "https://g1t.sh/x" },
        { "name": "test", "status": "in_progress", "conclusion": null },
    ]});
    let mock = checks_mock(mixed);
    let started = std::time::Instant::now();
    let out = run(
        &mock,
        &[
            "pr",
            "checks",
            "14",
            "-R",
            "acme/web",
            "--watch",
            "--fail-fast",
            "--interval",
            "1",
        ],
    );
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    assert!(out.stdout.contains("lint\tfailure"), "{}", out.stdout);
}

#[test]
fn run_logs_failed_prints_only_the_failing_steps_tail() {
    let mock = Mock::start(|r| match r.path() {
        "/repos/acme/web/actions/runs/run_1" => (
            200,
            json!({ "run": { "id": "run_1", "name": "CI", "number": 3, "status": "completed", "conclusion": "failure" }, "jobs": [
                { "id": "job_1", "name": "test", "status": "completed", "conclusion": "failure", "started_at": "2026-10-01T18:00:00Z",
                  "steps": [
                    { "number": 1, "name": "checkout", "status": "completed", "conclusion": "success" },
                    { "number": 2, "name": "cargo test", "status": "completed", "conclusion": "failure" }
                  ], "annotations": [] },
                { "id": "job_2", "name": "lint", "status": "completed", "conclusion": "success", "started_at": "2026-10-01T18:00:00Z", "steps": [] }
            ]}),
        ),
        "/repos/acme/web/actions/jobs/job_1/logs" => (
            200,
            json!({ "chunks": [
                { "seq": 1, "step": 1, "text": "cloned\n" },
                { "seq": 2, "step": 2, "text": "running 3 tests\nline a\nline b\ntest greet ... FAILED\n" }
            ], "done": true }),
        ),
        _ => (404, json!({ "error": { "message": "No such endpoint." } })),
    });
    let out = run(
        &mock,
        &[
            "run", "logs", "run_1", "--failed", "-n", "2", "-R", "acme/web",
        ],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("test › 2 cargo test"), "{}", out.stdout);
    assert!(
        out.stdout.contains("line b\ntest greet ... FAILED"),
        "{}",
        out.stdout
    );
    assert!(!out.stdout.contains("cloned"), "{}", out.stdout);
    assert!(!out.stdout.contains("line a"), "{}", out.stdout);
    // The passing job's log is never fetched.
    assert!(mock.requests().iter().all(|r| !r.path().contains("job_2")));
}

#[test]
fn api_calls_operations_by_name() {
    let mock = Mock::start(|_| (200, json!([issue(12, "Greeting", &[])])));
    let out = run(
        &mock,
        &[
            "api",
            "list_issues",
            "-f",
            "state=closed",
            "-R",
            "acme/web",
            "--jq",
            ".[0].title",
        ],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "Greeting\n");
    assert_eq!(
        mock.requests()[0].target,
        "/repos/acme/web/issues?state=closed"
    );
}

#[test]
fn api_posts_typed_fields() {
    let mock = Mock::start(|_| (200, json!({ "number": 13 })));
    let out = run(
        &mock,
        &[
            "api",
            "create_issue",
            "-R",
            "acme/web",
            "-f",
            "title=Hi",
            "-f",
            "labels[]=docs",
            "-F",
            "milestone=3",
        ],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    let r = &mock.requests()[0];
    assert_eq!(
        (r.method.as_str(), r.path()),
        ("POST", "/repos/acme/web/issues")
    );
    assert_eq!(
        r.json(),
        json!({ "title": "Hi", "labels": ["docs"], "milestone": 3 })
    );
}

#[test]
fn api_paginates_by_cursor_and_slurps() {
    let mock = Mock::start(|r| {
        if r.target.contains("cursor=c2") {
            (200, json!({ "items": [{ "id": 3 }], "next": null }))
        } else {
            (
                200,
                json!({ "items": [{ "id": 1 }, { "id": 2 }], "next": "c2" }),
            )
        }
    });
    let out = run(
        &mock,
        &[
            "api",
            "notifications",
            "--paginate",
            "--slurp",
            "--jq",
            "map(.id)",
        ],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout.trim(), "[1,2,3]");
    assert_eq!(mock.requests().len(), 2);
}

#[test]
fn api_errors_print_the_body_and_exit_1() {
    let mock = Mock::start(|_| {
        (
            404,
            json!({ "error": { "code": "not_found", "message": "No such endpoint." } }),
        )
    });
    let out = run(&mock, &["api", "/nowhere"]);
    assert_eq!(out.code, 1);
    assert!(out.stdout.contains("not_found"));
    assert_eq!(out.stderr.trim(), "g1t: No such endpoint.");
}

#[test]
fn signing_in_with_a_token_keeps_it_for_status_token_and_git() {
    let mock = Mock::start(|r| match r.header("authorization") {
        Some("Bearer g1t_good") => (
            200,
            json!({ "username": "ana", "token": { "scopes": ["repo:read"] } }),
        ),
        _ => (
            401,
            json!({ "error": { "message": "The token is not valid." } }),
        ),
    });
    let dir = temp_dir("auth");
    let out = g1t(
        &mock,
        &dir,
        &["auth", "login", "--with-token"],
        Some("g1t_good\n"),
        None,
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        out.stderr.contains("Signed in to g1t.sh as ana"),
        "{}",
        out.stderr
    );
    let config: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
    assert_eq!(config["hosts"]["g1t.sh"]["user"], "ana");

    let out = g1t(&mock, &dir, &["auth", "token"], None, None);
    assert_eq!(out.stdout, "g1t_good\n");

    let out = g1t(
        &mock,
        &dir,
        &["auth", "status", "--json", "host,user,valid,active"],
        None,
        None,
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        out.stdout.trim(),
        r#"[{"active":true,"host":"g1t.sh","user":"ana","valid":true}]"#
    );

    let out = g1t(
        &mock,
        &dir,
        &["auth", "git-credential", "get"],
        Some("protocol=https\nhost=g1t.sh\n\n"),
        None,
    );
    assert_eq!(
        out.stdout,
        "protocol=https\nhost=g1t.sh\nusername=ana\npassword=g1t_good\n"
    );
    let out = g1t(
        &mock,
        &dir,
        &["auth", "git-credential", "get"],
        Some("protocol=https\nhost=example.com\n\n"),
        None,
    );
    assert_eq!(out.stdout, "");

    let out = g1t(&mock, &dir, &["auth", "logout"], None, None);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let out = g1t(&mock, &dir, &["auth", "status"], None, None);
    assert_eq!(out.code, 4);
}

#[test]
fn a_bad_token_is_not_kept() {
    let mock = Mock::start(|_| {
        (
            401,
            json!({ "error": { "message": "The token is not valid." } }),
        )
    });
    let dir = temp_dir("bad");
    let out = g1t(
        &mock,
        &dir,
        &["auth", "login", "--with-token"],
        Some("nope"),
        None,
    );
    assert_eq!(out.code, 4);
    assert!(!dir.join("config.json").exists());
}

#[test]
fn secrets_are_read_from_stdin() {
    let mock = Mock::start(|_| (200, json!({ "name": "NPM_TOKEN", "kind": "secret" })));
    let dir = temp_dir("secret");
    let out = g1t(
        &mock,
        &dir,
        &[
            "secret",
            "set",
            "npm_token",
            "-R",
            "acme/web",
            "--env",
            "production",
        ],
        Some("s3cret\n"),
        Some("g1t_test"),
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    let r = &mock.requests()[0];
    assert_eq!(
        (r.method.as_str(), r.path()),
        ("PUT", "/repos/acme/web/actions/secrets/NPM_TOKEN")
    );
    assert_eq!(
        r.json(),
        json!({ "value": "s3cret", "environments": ["production"] })
    );
    assert!(!out.stdout.contains("s3cret") && !out.stderr.contains("s3cret"));
}

#[test]
fn aliases_expand_before_the_command_runs() {
    let mock = Mock::start(|_| (200, json!([issue(12, "Greeting", &["bug"])])));
    let dir = temp_dir("alias");
    let out = g1t(
        &mock,
        &dir,
        &["alias", "set", "bugs", "issue list --label bug"],
        None,
        None,
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    let out = g1t(
        &mock,
        &dir,
        &["bugs", "-R", "acme/web", "--json", "number"],
        None,
        Some("g1t_test"),
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout.trim(), r#"[{"number":12}]"#);
    assert_eq!(
        mock.requests()[0].target,
        "/repos/acme/web/issues?state=open&label=bug"
    );
    let out = g1t(
        &mock,
        &dir,
        &["alias", "set", "pr", "issue list"],
        None,
        None,
    );
    assert_eq!(out.code, 2, "a command's name cannot be an alias");
}

#[test]
fn pr_merge_and_review_send_what_was_asked() {
    let mock = Mock::start(|r| match (r.method.as_str(), r.path()) {
        ("POST", "/repos/acme/web/pulls/14/merge") => {
            (200, json!({ "number": 14, "status": "merged" }))
        }
        ("POST", "/repos/acme/web/pulls/14/reviews") => {
            (200, json!({ "id": "cmt_1", "verdict": "approve" }))
        }
        _ => (404, json!({ "error": { "message": "No such endpoint." } })),
    });
    let out = run(
        &mock,
        &[
            "pr",
            "review",
            "14",
            "--approve",
            "-b",
            "Looks right.",
            "-R",
            "acme/web",
        ],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    let out = run(
        &mock,
        &["pr", "merge", "14", "--keep-issue-open", "-R", "acme/web"],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout.trim(), "https://g1t.sh/acme/web/pull/14");
    let seen = mock.requests();
    assert_eq!(
        seen[0].json(),
        json!({ "verdict": "approve", "body": "Looks right." })
    );
    assert_eq!(seen[1].json(), json!({ "keep_issue_open": true }));
}

#[test]
fn status_gathers_what_needs_you() {
    let mock = Mock::start(|r| match r.path() {
        "/user" => (200, json!({ "username": "ana" })),
        "/search" => (
            200,
            json!({ "hits": [{ "repo": "acme/web", "number": 14, "title": "Greet" }] }),
        ),
        "/repos/acme/web/pulls/14" => (200, pull("failed")),
        "/notifications" if r.target.contains("review_requested") => (
            200,
            json!({ "items": [{ "repo": "acme/api", "number": 3, "title": "ada asked you to review acme/api#3" }] }),
        ),
        "/notifications" => (200, json!({ "items": [] })),
        _ => (404, json!({ "error": { "message": "No such endpoint." } })),
    });
    let out = run(
        &mock,
        &["status", "--json", "pulls,review_requests,failing_checks"],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    let v: Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(v["pulls"][0]["number"], 14);
    assert_eq!(v["review_requests"][0]["number"], 3);
    assert_eq!(v["failing_checks"][0]["check_status"], "failed");
    let search = mock
        .requests()
        .into_iter()
        .find(|r| r.path() == "/search")
        .unwrap();
    assert!(search.target.contains("author%3Aana"), "{}", search.target);
}

#[test]
fn help_and_version_succeed() {
    let mock = Mock::start(|_| (200, json!({})));
    let out = run(&mock, &["--version"]);
    assert_eq!(out.code, 0);
    assert!(out.stdout.starts_with("g1t "));
    let out = run(&mock, &["pr", "--help"]);
    assert_eq!(out.code, 0);
    assert!(out.stdout.contains("checks"));
    let out = run(&mock, &["completion", "bash"]);
    assert_eq!(out.code, 0);
    assert!(out.stdout.contains("_g1t"));
}

#[test]
fn login_approves_a_code_in_the_browser() {
    let polls = Arc::new(Mutex::new(0));
    let counter = polls.clone();
    let mock = Mock::start(move |r| match r.path() {
        "/device/code" => (
            200,
            json!({ "device_code": "dev_1", "user_code": "WDJB-MJHT", "verification_uri": "https://g1t.sh/device",
                    "verification_uri_complete": "https://g1t.sh/device?code=WDJB-MJHT", "expires_in": 60, "interval": 1 }),
        ),
        "/device/token" => {
            let mut n = counter.lock().unwrap();
            *n += 1;
            if *n < 2 {
                (200, json!({ "status": "pending" }))
            } else {
                (
                    200,
                    json!({ "status": "approved", "token": "g1t_device", "username": "ana" }),
                )
            }
        }
        _ => (404, json!({ "error": { "message": "No such endpoint." } })),
    });
    let dir = temp_dir("device");
    let out = g1t(&mock, &dir, &["auth", "login", "--no-browser"], None, None);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stderr.contains("WDJB-MJHT"), "{}", out.stderr);
    assert!(
        out.stderr.contains("https://g1t.sh/device?code=WDJB-MJHT"),
        "{}",
        out.stderr
    );
    let seen = mock.requests();
    assert!(
        seen[0].json()["client_name"]
            .as_str()
            .unwrap()
            .starts_with("g1t CLI on ")
    );
    assert!(
        seen.iter()
            .filter(|r| r.path() == "/device/token")
            .all(|r| r.json() == json!({ "device_code": "dev_1" }))
    );
    let out = g1t(&mock, &dir, &["auth", "token"], None, None);
    assert_eq!(out.stdout, "g1t_device\n");
}

#[test]
fn the_repository_comes_from_the_git_remote() {
    let mock = Mock::start(|_| (200, json!([])));
    let dir = temp_dir("remote");
    let git = |args: &[&str]| {
        let ok = Command::new("git")
            .args(args)
            .current_dir(&dir)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "--quiet"]);
    git(&["remote", "add", "mine", "https://g1t.sh/ana/web.git"]);
    git(&["remote", "add", "origin", "git@g1t.sh:acme/web.git"]);
    git(&[
        "remote",
        "add",
        "elsewhere",
        "https://example.com/acme/other.git",
    ]);
    let out = g1t(
        &mock,
        &dir,
        &["issue", "list", "--json"],
        None,
        Some("g1t_test"),
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "[]\n");
    assert_eq!(mock.requests()[0].path(), "/repos/acme/web/issues");
    // Outside any repository, and without --repo, it says what to do.
    let bare = temp_dir("bare");
    let out = g1t(&mock, &bare, &["issue", "list"], None, Some("g1t_test"));
    assert_eq!(out.code, 2);
    assert!(out.stderr.contains("--repo"), "{}", out.stderr);
}

/// Runs g1t in `dir` with a token and the environment `env` added.
fn g1t_with(mock: &Mock, dir: &PathBuf, args: &[&str], env: &[(&str, &str)]) -> Run {
    let mut command = Command::new(env!("CARGO_BIN_EXE_g1t"));
    command
        .args(args)
        .current_dir(dir)
        .env("G1T_API_URL", &mock.url)
        .env("G1T_CONFIG_DIR", dir)
        .env("G1T_KEYRING", "off")
        .env("G1T_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .env("GIT_CEILING_DIRECTORIES", std::env::temp_dir())
        .env("G1T_TOKEN", "g1t_test")
        .env_remove("G1T_REPO")
        .env_remove("G1T_HOST")
        .env_remove("G1T_SESSION")
        .stdin(Stdio::null());
    for (k, v) in env {
        command.env(k, v);
    }
    let Output { status, stdout, stderr } = command.output().unwrap();
    Run {
        code: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    }
}

/// A working copy of acme/web.
fn working_copy(name: &str) -> PathBuf {
    let dir = temp_dir(name);
    for args in [
        &["init", "--quiet"][..],
        &["remote", "add", "origin", "https://g1t.sh/acme/web.git"][..],
    ] {
        assert!(Command::new("git").args(args).current_dir(&dir).status().unwrap().success());
    }
    dir
}

fn session(id: &str) -> Value {
    json!({ "id": id, "state": "active", "harness": "claude_code", "issue": 12, "actor": "ana" })
}

#[test]
fn a_session_is_remembered_per_working_copy_and_claims_carry_it() {
    let mock = Mock::start(|r| match (r.method.as_str(), r.path()) {
        ("POST", "/repos/acme/web/sessions") => (200, session("ses_1")),
        ("POST", "/repos/acme/web/sessions/ses_1/entries") => (200, json!({ "recorded": 1 })),
        ("POST", "/repos/acme/web/sessions/ses_2/entries") => (200, json!({ "recorded": 1 })),
        ("POST", "/repos/acme/web/issues/12/claim") => (
            200,
            json!({ "claim": { "id": "clm_1", "issue": 12, "actor": "ana" }, "others": [], "blocked_by": [] }),
        ),
        ("POST", "/repos/acme/web/sessions/ses_1/end") => (200, session("ses_1")),
        _ => (404, json!({ "error": { "message": "No such endpoint." } })),
    });
    let dir = working_copy("session");
    let out = g1t_with(
        &mock,
        &dir,
        &["session", "start", "--harness", "claude-code", "--harness-session-id", "cc-9", "--issue", "12", "--json"],
        &[],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    let started: Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(started["id"], "ses_1");
    let sent = mock.requests()[0].json();
    assert_eq!(sent["harness"], "claude_code");
    assert_eq!(sent["harness_session_id"], "cc-9");
    assert_eq!(sent["issue"], 12);
    let kept = std::fs::read_to_string(dir.join(".git/g1t/session")).unwrap();
    assert_eq!(kept.trim(), "ses_1");

    let out = g1t_with(
        &mock,
        &dir,
        &["session", "log", "--kind", "tool-call", "--tool", "Edit", "--", "--edited src/a.rs"],
        &[],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    let logged = mock.requests().last().unwrap().clone();
    assert_eq!(logged.path(), "/repos/acme/web/sessions/ses_1/entries");
    assert_eq!(
        logged.json(),
        json!({ "entries": [{ "kind": "tool_call", "text": "--edited src/a.rs", "tool": "Edit" }] })
    );

    // G1T_SESSION wins over the kept one.
    let out = g1t_with(&mock, &dir, &["session", "log", "hi"], &[("G1T_SESSION", "ses_2")]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(mock.requests().last().unwrap().path(), "/repos/acme/web/sessions/ses_2/entries");

    let out = g1t_with(&mock, &dir, &["work", "claim", "12", "--note", "parser", "--ttl", "2h"], &[]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        mock.requests().last().unwrap().json(),
        json!({ "session_id": "ses_1", "note": "parser", "ttl_minutes": 120 })
    );
    assert!(out.stdout.contains("Claimed #12"), "{}", out.stdout);

    let out = g1t_with(&mock, &dir, &["session", "end", "--reason", "done"], &[]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(!dir.join(".git/g1t/session").exists(), "an ended session is forgotten");
}

#[test]
fn coordination_without_a_session_or_a_token_fails_at_once() {
    let mock = Mock::start(|_| (200, json!({})));
    let dir = working_copy("nosession");
    let out = g1t_with(&mock, &dir, &["session", "heartbeat"], &[]);
    assert_eq!(out.code, 2);
    assert!(out.stderr.contains("g1t session start"), "{}", out.stderr);
    let out = g1t_with(&mock, &dir, &["work", "claim", "12"], &[("G1T_TOKEN", "")]);
    assert_eq!(out.code, 4, "{}", out.stderr);
    assert!(mock.requests().is_empty());
}

#[test]
fn an_older_server_says_it_cannot_do_this_yet() {
    let mock = Mock::start(|_| {
        (404, json!({ "error": { "code": "not_found", "message": "No such endpoint." } }))
    });
    let out = run(&mock, &["work", "context", "12", "-R", "acme/web"]);
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("older than this CLI"), "{}", out.stderr);
    assert!(out.stderr.contains("/repos/acme/web/issues/12/work"), "{}", out.stderr);
}

#[test]
fn blocking_replaces_the_set_the_issue_waits_on() {
    let mock = Mock::start(|r| match (r.method.as_str(), r.path()) {
        ("GET", "/repos/acme/web/issues/12") => {
            (200, json!({ "issue": { "number": 12, "blocked_by": [9] } }))
        }
        ("PATCH", "/repos/acme/web/issues/12") => (200, json!({ "number": 12, "blocked_by": [9, 10] })),
        _ => (404, json!({ "error": { "message": "No such endpoint." } })),
    });
    let out = run(&mock, &["work", "block", "12", "--by", "10", "--by", "9", "-R", "acme/web"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(mock.requests()[1].json(), json!({ "blocked_by": [9, 10] }));
}

#[test]
fn events_follow_from_the_newest_and_resume_from_the_last() {
    let calls = Arc::new(Mutex::new(0));
    let count = calls.clone();
    let event = |id: &str, kind: &str, number: u64| {
        json!({ "id": id, "type": kind, "time": "2026-10-12T09:00:00Z", "data": { "number": number, "title": "t" } })
    };
    let mock = Mock::start(move |r| {
        let mut n = count.lock().unwrap();
        *n += 1;
        match *n {
            // Where following starts.
            1 => (200, json!([event("evt_5", "push", 0)])),
            // The past, newest first.
            2 => (200, json!([event("evt_5", "work.claimed", 12), event("evt_4", "work.claimed", 12)])),
            3 if r.target.contains("after=evt_5") => (200, json!([event("evt_6", "work.released", 12)])),
            4 if r.target.contains("after=evt_6") => (200, json!([event("evt_7", "work.claimed", 12)])),
            // A refused token ends the follow.
            _ => (401, json!({ "error": { "message": "Token expired." } })),
        }
    });
    let out = run(
        &mock,
        &[
            "work", "events", "--follow", "--issue", "12", "--type", "work.claimed", "-t",
            "work.released", "--json", "id", "-R", "acme/web",
        ],
    );
    assert_eq!(out.code, 4, "{}", out.stderr);
    assert_eq!(
        out.stdout,
        "{\"id\":\"evt_4\"}\n{\"id\":\"evt_5\"}\n{\"id\":\"evt_6\"}\n{\"id\":\"evt_7\"}\n"
    );
    let seen = mock.requests();
    assert!(!seen[0].target.contains("numbers="), "{}", seen[0].target);
    assert!(seen[1].target.contains("numbers=12"), "{}", seen[1].target);
    assert!(seen[1].target.contains("types=work.claimed%2Cwork.released"), "{}", seen[1].target);
    assert!(seen[2].target.contains("wait=25"), "{}", seen[2].target);
}
