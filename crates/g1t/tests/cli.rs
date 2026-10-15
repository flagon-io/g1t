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
fn pr_merge_says_how_and_auto_merge_turns_on_and_off() {
    let mock = Mock::start(|r| match (r.method.as_str(), r.path()) {
        ("POST", "/repos/acme/web/pulls/14/merge") => (
            200,
            json!({ "number": 14, "status": "merged", "branch": "greet", "head_branch_deleted": true }),
        ),
        ("PUT", "/repos/acme/web/pulls/14/auto-merge") => (
            200,
            json!({ "number": 14, "status": "open", "auto_merge": { "method": "rebase", "enabled_by": "ana" } }),
        ),
        ("DELETE", "/repos/acme/web/pulls/14/auto-merge") => {
            (200, json!({ "number": 14, "status": "open", "auto_merge": null }))
        }
        _ => (404, json!({ "error": { "message": "No such endpoint." } })),
    });
    let out = run(
        &mock,
        &[
            "pr", "merge", "14", "--squash", "-t", "Greet the caller (#14)", "-b", "Names them.",
            "--match-head-commit", "9f2c4e1", "-d", "-R", "acme/web",
        ],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stderr.contains("Deleted the branch greet."), "{}", out.stderr);
    let out = run(&mock, &["pr", "merge", "14", "--ff", "--keep-branch", "-R", "acme/web"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let out = run(&mock, &["pr", "merge", "14", "--auto", "--rebase", "-R", "acme/web"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stderr.contains("will merge on its own"), "{}", out.stderr);
    let out = run(&mock, &["pr", "merge", "14", "--disable-auto", "-R", "acme/web"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stderr.contains("Turned off auto-merge"), "{}", out.stderr);
    let seen = mock.requests();
    assert_eq!(
        seen[0].json(),
        json!({
            "merge_method": "squash",
            "commit_title": "Greet the caller (#14)",
            "commit_message": "Names them.",
            "sha": "9f2c4e1",
            "delete_branch": true,
        })
    );
    assert_eq!(seen[1].json(), json!({ "merge_method": "fast_forward", "delete_branch": false }));
    assert_eq!((seen[2].method.as_str(), seen[2].json()), ("PUT", json!({ "merge_method": "rebase" })));
    assert_eq!(seen[3].method, "DELETE");
    // One method at a time, and auto-merge takes no branch deletion.
    for args in [
        &["pr", "merge", "14", "--squash", "--rebase", "-R", "acme/web"][..],
        &["pr", "merge", "14", "--auto", "-d", "-R", "acme/web"][..],
        &["pr", "merge", "14", "--disable-auto", "--squash", "-R", "acme/web"][..],
    ] {
        assert_eq!(run(&mock, args).code, 2, "{args:?}");
    }
    assert_eq!(mock.requests().len(), 4);
}

#[test]
fn pr_update_branch_merges_or_rebases_and_fails_when_it_cannot() {
    let mock = Mock::start(|r| match (r.method.as_str(), r.path()) {
        ("PUT", "/repos/acme/web/pulls/14/update-branch") if r.json()["update_method"] == "rebase" => (
            200,
            json!({ "outcome": "needs_agent", "reason": "conflicting", "detail": "Both sides changed src/main.rs.", "paths": ["src/main.rs"] }),
        ),
        ("PUT", "/repos/acme/web/pulls/14/update-branch") => {
            (200, json!({ "outcome": "updated", "commit": "5b8d0f2", "previous": "9f2c4e1" }))
        }
        _ => (404, json!({ "error": { "message": "No such endpoint." } })),
    });
    let out = run(&mock, &["pr", "update-branch", "14", "-R", "acme/web"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stderr.contains("Updated the branch of acme/web#14"), "{}", out.stderr);
    assert_eq!(out.stdout.trim(), "https://g1t.sh/acme/web/pull/14");
    let out = run(&mock, &["pr", "update-branch", "14", "--rebase", "-R", "acme/web"]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert!(out.stderr.contains("src/main.rs"), "{}", out.stderr);
    let seen = mock.requests();
    assert!(seen[0].json().as_object().is_none_or(|body| body.is_empty()), "{}", seen[0].body);
    assert_eq!(seen[1].json(), json!({ "update_method": "rebase" }));
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
        &["session", "start", "--harness", "claude_code", "--harness-session-id", "cc-9", "--issue", "12", "--json"],
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

fn cache(id: u64, key: &str, size: u64) -> Value {
    json!({
        "id": id, "key": key, "ref": "refs/heads/main", "version": "", "size_in_bytes": size,
        "created_at": "2026-10-12T10:00:00.000Z", "last_accessed_at": "2026-10-12T11:00:00.000Z",
    })
}

#[test]
fn cache_list_pages_through_the_entries_largest_first() {
    // 150 entries: a first page of 100, then the 50 the limit still wants.
    let mock = Mock::start(|r| {
        let ids = if r.target.contains("page=2") { 101..=150 } else { 1..=100 };
        (200, json!({ "total_count": 150, "actions_caches": ids.map(|n| cache(n, "cargo-x", 1024)).collect::<Vec<_>>() }))
    });
    let out = run(
        &mock,
        &["cache", "list", "-R", "acme/web", "--key", "cargo-", "--sort", "size-in-bytes", "--limit", "120", "--json", "id"],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    let list: Vec<Value> = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(list.len(), 120);
    let seen = mock.requests();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].path(), "/repos/acme/web/actions/caches");
    for want in ["key=cargo-", "sort=size_in_bytes", "direction=desc", "per_page=100", "page=1"] {
        assert!(seen[0].target.contains(want), "{want} in {}", seen[0].target);
    }
    assert!(seen[1].target.contains("page=2"), "{}", seen[1].target);
}

#[test]
fn cache_usage_says_how_full_the_repository_is() {
    let mock = Mock::start(|_| {
        (200, json!({ "full_name": "acme/web", "active_caches_size_in_bytes": 5_368_709_120u64, "active_caches_count": 12, "quota_bytes": 10_737_418_240u64 }))
    });
    let out = run(&mock, &["cache", "usage", "-R", "acme/web"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "acme/web: 12 entries holding 5.0 GiB of 10.0 GiB (50%)\n");
    assert_eq!(mock.requests()[0].target, "/repos/acme/web/actions/cache/usage");
}

#[test]
fn cache_delete_takes_an_id_or_a_key() {
    let mock = Mock::start(|r| match r.path() {
        "/repos/acme/web/actions/caches/9184" => (204, Value::Null),
        _ => (200, json!({ "total_count": 2, "actions_caches": [cache(1, "npm-full-Linux-abc", 1), cache(2, "npm-full-Linux-abc", 1)] })),
    });
    let out = run(&mock, &["cache", "delete", "9184", "-R", "acme/web"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let out = run(&mock, &["cache", "delete", "npm-full-Linux-abc", "--ref", "refs/heads/main", "-R", "acme/web"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stderr.contains("Deleted 2 cache entries with the key npm-full-Linux-abc"), "{}", out.stderr);
    let seen = mock.requests();
    assert_eq!((seen[0].method.as_str(), seen[0].path()), ("DELETE", "/repos/acme/web/actions/caches/9184"));
    assert_eq!(seen[1].method, "DELETE");
    assert!(seen[1].target.starts_with("/repos/acme/web/actions/caches?key=npm-full-Linux-abc&ref=refs"), "{}", seen[1].target);
}

fn workflows_mock(dispatched: Value) -> Mock {
    Mock::start(move |r| match (r.method.as_str(), r.path()) {
        ("GET", "/repos/acme/web/actions/workflows") => (
            200,
            json!([
                { "id": "wfl_1", "path": ".g1t/workflows/ci.yml", "name": "CI", "events": ["push", "pull_request"],
                  "state": "active", "error": null, "notes": [], "dispatch": null, "last_run": null },
                { "id": "wfl_2", "path": ".g1t/workflows/release.yml", "name": "Release", "events": ["workflow_dispatch"],
                  "state": "active", "error": null, "notes": [],
                  "dispatch": { "channel": { "type": "choice", "options": ["beta", "stable"], "default": "beta" } }, "last_run": null },
                { "id": "wfl_3", "path": ".g1t/workflows/nightly.yml", "name": "Nightly", "events": ["schedule"],
                  "state": "disabled", "error": null, "notes": [], "dispatch": null, "last_run": null }
            ]),
        ),
        ("GET", "/repos/acme/web/actions/workflows/wfl_2") => (
            200,
            json!({ "id": "wfl_2", "path": ".g1t/workflows/release.yml", "name": "Release", "state": "active",
                    "ref": "v1.4.0", "source": "name: Release\non: workflow_dispatch\n" }),
        ),
        ("GET", "/repos/acme/web/actions/runs") => (
            200,
            json!([{ "id": "run_9", "workflow_id": "wfl_2", "name": "Release", "title": "Release run by ana", "number": 4,
                     "event": "workflow_dispatch", "ref": "refs/heads/main", "status": "queued", "conclusion": null,
                     "created_at": "2999-01-01T00:00:00Z" }]),
        ),
        ("POST", "/repos/acme/web/actions/workflows/wfl_2/dispatches") => (200, dispatched.clone()),
        ("PUT", p) if p.ends_with("/enable") || p.ends_with("/disable") => (
            200,
            json!({ "id": "wfl_3", "path": ".g1t/workflows/nightly.yml", "name": "Nightly",
                    "state": if p.ends_with("/enable") { "active" } else { "disabled" } }),
        ),
        _ => (404, json!({ "error": { "message": "No such endpoint." } })),
    })
}

fn release_run() -> Value {
    json!({ "id": "run_9", "workflow_id": "wfl_2", "name": "Release", "number": 4, "event": "workflow_dispatch",
            "ref": "refs/tags/v1.4.0", "status": "queued" })
}

#[test]
fn workflow_list_shows_those_turned_on_unless_all() {
    let mock = workflows_mock(json!({}));
    let out = run(&mock, &["workflow", "list", "-R", "acme/web"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let names: Vec<&str> = out
        .stdout
        .lines()
        .map(|l| l.split('\t').next().unwrap())
        .collect();
    assert_eq!(names, ["CI", "Release"]);
    assert_eq!(
        out.stdout.lines().next().unwrap(),
        "CI\tactive\tci.yml\tpush, pull_request\twfl_1"
    );
    let out = run(
        &mock,
        &[
            "workflow", "list", "--all", "-R", "acme/web", "--jq", ".[].path",
        ],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout.lines().count(), 3);
}

#[test]
fn workflow_view_takes_a_name_and_shows_its_latest_runs() {
    let mock = workflows_mock(json!({}));
    let out = run(
        &mock,
        &[
            "workflow",
            "view",
            "release",
            "-R",
            "acme/web",
            "--json",
            "id,runs,url",
        ],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    let shown: Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(shown["id"], "wfl_2");
    assert_eq!(shown["runs"][0]["id"], "run_9");
    assert_eq!(
        shown["url"],
        "https://g1t.sh/acme/web/actions?workflow=wfl_2"
    );
    let runs = mock
        .requests()
        .into_iter()
        .find(|r| r.path() == "/repos/acme/web/actions/runs")
        .unwrap();
    assert_eq!(
        runs.target,
        "/repos/acme/web/actions/runs?workflow=wfl_2&per_page=5"
    );
    // Its file, on a tag: only the file when piped.
    let out = run(
        &mock,
        &[
            "workflow",
            "view",
            "release.yml",
            "--yaml",
            "--ref",
            "v1.4.0",
            "-R",
            "acme/web",
        ],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "name: Release\non: workflow_dispatch\n");
    assert!(
        mock.requests()
            .iter()
            .any(|r| r.target == "/repos/acme/web/actions/workflows/wfl_2?ref=v1.4.0")
    );
    // --ref is for --yaml.
    let out = run(
        &mock,
        &[
            "workflow", "view", "ci.yml", "--ref", "main", "-R", "acme/web",
        ],
    );
    assert_eq!(out.code, 2);
}

#[test]
fn workflow_run_sends_the_ref_and_inputs_and_prints_the_run() {
    let mock = workflows_mock(release_run());
    let out = run(
        &mock,
        &[
            "workflow",
            "run",
            "Release",
            "--ref",
            "v1.4.0",
            "-f",
            "channel=stable",
            "-R",
            "acme/web",
        ],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        out.stdout.trim(),
        "https://g1t.sh/acme/web/actions/runs/run_9"
    );
    assert!(
        out.stderr
            .contains("Started Release (release.yml) #4 on v1.4.0"),
        "{}",
        out.stderr
    );
    let sent = mock
        .requests()
        .into_iter()
        .find(|r| r.method == "POST")
        .unwrap();
    assert_eq!(
        sent.json(),
        json!({ "ref": "v1.4.0", "inputs": { "channel": "stable" } })
    );
}

#[test]
fn workflow_run_json_reads_the_inputs_from_stdin() {
    let mock = workflows_mock(release_run());
    let dir = temp_dir("dispatch");
    let out = g1t(
        &mock,
        &dir,
        &["workflow", "run", "release.yml", "--json", "-R", "acme/web"],
        Some("{\"channel\":\"beta\",\"dry_run\":true}"),
        Some("g1t_test"),
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(
        out.stdout.trim(),
        "https://g1t.sh/acme/web/actions/runs/run_9"
    );
    let sent = mock
        .requests()
        .into_iter()
        .find(|r| r.method == "POST")
        .unwrap();
    assert_eq!(
        sent.json(),
        json!({ "inputs": { "channel": "beta", "dry_run": true } })
    );
    // Not an object, or with -f as well, is using it wrongly.
    let out = g1t(
        &mock,
        &dir,
        &["workflow", "run", "release.yml", "--json", "-R", "acme/web"],
        Some("[1]"),
        Some("g1t_test"),
    );
    assert_eq!(out.code, 2);
    let out = g1t(
        &mock,
        &dir,
        &[
            "workflow",
            "run",
            "release.yml",
            "--json",
            "-f",
            "a=b",
            "-R",
            "acme/web",
        ],
        Some("{}"),
        Some("g1t_test"),
    );
    assert_eq!(out.code, 2);
}

#[test]
fn workflow_run_looks_for_the_run_when_the_answer_lacks_it() {
    let mock = workflows_mock(json!({}));
    let out = run(
        &mock,
        &["workflow", "run", "wfl_2", "-R", "acme/web", "--jq", ".id"],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.stdout, "run_9\n");
    assert!(mock.requests().iter().any(|r| r.target
        == "/repos/acme/web/actions/runs?workflow=wfl_2&event=workflow_dispatch&per_page=1"));
}

#[test]
fn workflow_enable_and_disable_put_its_state() {
    let mock = workflows_mock(json!({}));
    let out = run(
        &mock,
        &["workflow", "enable", "nightly.yml", "-R", "acme/web"],
    );
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(
        out.stderr.contains("Turned Nightly (nightly.yml) on"),
        "{}",
        out.stderr
    );
    let out = run(
        &mock,
        &[
            "workflow", "disable", "Nightly", "-R", "acme/web", "--json", "state",
        ],
    );
    assert_eq!(out.stdout, "{\"state\":\"disabled\"}\n");
    let puts: Vec<String> = mock
        .requests()
        .into_iter()
        .filter(|r| r.method == "PUT")
        .map(|r| r.path().to_owned())
        .collect();
    assert_eq!(
        puts,
        [
            "/repos/acme/web/actions/workflows/wfl_3/enable",
            "/repos/acme/web/actions/workflows/wfl_3/disable"
        ]
    );
}

#[test]
fn a_workflow_that_is_not_there_or_not_named_fails_without_asking() {
    let mock = workflows_mock(json!({}));
    let out = run(&mock, &["workflow", "view", "deploy.yml", "-R", "acme/web"]);
    assert_eq!(out.code, 1);
    assert!(
        out.stderr
            .contains("There is no workflow deploy.yml in acme/web"),
        "{}",
        out.stderr
    );
    let out = run(&mock, &["workflow", "run", "-R", "acme/web"]);
    assert_eq!(out.code, 2);
    assert!(
        out.stderr.contains("The workflow is needed"),
        "{}",
        out.stderr
    );
}

#[test]
fn codex_and_claude_use_the_same_inbox_and_decision_protocol() {
    let mock = Mock::start(|r| {
        if r.method == "POST" && r.path() == "/repos/acme/web/sessions" {
            return (200, session(&format!("ses_{}", r.json()["harness"].as_str().unwrap())));
        }
        if r.method == "GET" && r.path().contains("/sessions/ses_") {
            assert!(r.target.contains("after=4294967295"));
            return (200, json!({ "updates": [{ "id": "upd_overlap", "kind": "overlap.detected", "data": { "path": "src/api.rs" }, "at": "2026-10-14T00:00:00Z" }] }));
        }
        if r.method == "POST" && r.path().ends_with("/entries") {
            assert_eq!(r.json()["acknowledge"], json!(["upd_overlap"]));
            assert_eq!(r.json()["entries"][0]["kind"], "note");
            assert!(r.json()["entries"][0]["text"].as_str().unwrap().contains("I will change tests only"));
            return (200, json!({ "recorded": 1, "duplicates": 0 }));
        }
        (404, json!({}))
    });
    let dir = working_copy("harness-inbox");
    for harness in ["codex", "claude_code"] {
        let id = format!("ses_{harness}");
        let out = g1t_with(&mock, &dir, &["session", "start", "--harness", harness, "--no-remember", "--json"], &[]);
        assert_eq!(out.code, 0, "{}", out.stderr);
        assert!(!dir.join(".git/g1t/session").exists());
        let out = g1t_with(&mock, &dir, &["session", "updates", "--json"], &[("G1T_SESSION", &id)]);
        assert_eq!(out.code, 0, "{}", out.stderr);
        let found: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(found["session_id"], id);
        assert_eq!(found["updates"][0]["id"], "upd_overlap");
        // Explicit identity overrides a conflicting environment, including in a shared checkout.
        let out = g1t_with(&mock, &dir, &["session", "acknowledge", "upd_overlap", "--session", &id, "--note", "I will change tests only"], &[("G1T_SESSION", "ses_wrong")]);
        assert_eq!(out.code, 0, "{}", out.stderr);
        assert_eq!(mock.requests().last().unwrap().path(), format!("/repos/acme/web/sessions/{id}/entries"));
    }
}

#[test]
fn an_inbox_missing_from_an_old_server_is_not_reported_as_empty() {
    let mock = Mock::start(|_| (200, json!({ "entries": [] })));
    let out = run(&mock, &["session", "updates", "ses_a", "-R", "acme/web", "--json"]);
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("does not expose session updates"));
}

#[test]
fn any_harness_checking_its_updates_says_which_files_it_changed() {
    let mock = Mock::start(|r| {
        if r.method == "POST" && r.path().ends_with("/entries") {
            return (200, json!({ "recorded": 0, "duplicates": 0, "acknowledged": 0 }));
        }
        (200, json!({ "updates": [] }))
    });
    let dir = working_copy("auto-touch");
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/api.ts"), "export const x = 1;\n").unwrap();
    let out = g1t_with(&mock, &dir, &["session", "updates", "--json"], &[("G1T_SESSION", "ses_a")]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let requests = mock.requests();
    // Said before the inbox is read, so an overlap it makes is read with it.
    assert!(requests[0].path().ends_with("/sessions/ses_a/entries"), "{}", requests[0].path());
    assert_eq!(requests[0].json()["touched"], json!([{ "kind": "file", "value": "src/api.ts" }]));
    assert!(requests[1].path().ends_with("/sessions/ses_a"));
    // Not with G1T_TOUCH=0.
    let before = mock.requests().len();
    let out = g1t_with(&mock, &dir, &["session", "updates", "--json"], &[("G1T_SESSION", "ses_a"), ("G1T_TOUCH", "0")]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(mock.requests().len(), before + 1);
}

fn repo_json(namespace: &str, name: &str, parent: Option<(&str, &str)>) -> Value {
    json!({
        "id": format!("rep_{name}"), "namespace": namespace, "name": name,
        "is_private": false, "default_branch": "main", "fork_of": null, "archived_at": null,
        "parent_id": parent.map(|_| "rep_parent"),
        "parent": parent.map(|(owner, name)| json!({ "namespace": owner, "name": name })),
        "created_at": "2026-10-14T09:30:12.418Z",
    })
}

/// A clone of ana/web, a fork of acme/web: origin is the fork, upstream
/// the repository it came from.
fn fork_clone(name: &str) -> PathBuf {
    let dir = temp_dir(name);
    for args in [
        &["init", "--quiet"][..],
        &["remote", "add", "origin", "https://g1t.sh/ana/web.git"][..],
        &["remote", "add", "upstream", "https://g1t.sh/acme/web.git"][..],
    ] {
        assert!(Command::new("git").args(args).current_dir(&dir).status().unwrap().success());
    }
    dir
}

#[test]
fn repo_fork_sends_where_and_what_to_copy() {
    let mock = Mock::start(|r| match (r.method.as_str(), r.path()) {
        ("POST", "/repos/acme/web/forks") => (200, repo_json("flagon-io", "site", Some(("acme", "web")))),
        _ => (404, json!({ "error": { "code": "not_found", "message": "No." } })),
    });
    let out = run(&mock, &["repo", "fork", "acme/web", "--workspace", "flagon-io", "--name", "site", "--all-branches"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stderr.contains("Forked acme/web to flagon-io/site"), "{}", out.stderr);
    assert_eq!(out.stdout.trim(), "https://g1t.sh/flagon-io/site");
    assert_eq!(
        mock.requests()[0].json(),
        json!({ "workspace": "flagon-io", "name": "site", "default_branch_only": false })
    );
    // By default: the default branch only, into the API's choice of workspace.
    let out = run(&mock, &["repo", "fork", "acme/web", "--json"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(mock.requests()[1].json(), json!({ "default_branch_only": true }));
}

#[test]
fn repo_view_says_what_a_fork_came_from_and_forks_lists_them() {
    let mock = Mock::start(|r| match (r.method.as_str(), r.path()) {
        ("GET", "/repos/ana/web") => (200, repo_json("ana", "web", Some(("acme", "web")))),
        ("GET", "/repos/acme/web/forks") => (200, json!([repo_json("ana", "web", Some(("acme", "web")))])),
        // A repository has no description: its own project's is shown.
        ("GET", "/workspaces/ana/projects") => (
            200,
            json!([
                { "slug": "web", "repository": "ana/web", "primary": true, "description": "A web app." },
                { "slug": "docs", "repository": "ana/web", "primary": false, "description": "Not this one." },
            ]),
        ),
        _ => (404, json!({ "error": { "code": "not_found", "message": "No." } })),
    });
    let out = run(&mock, &["repo", "view", "ana/web"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("Forked from acme/web"), "{}", out.stdout);
    assert!(out.stdout.contains("A web app."), "{}", out.stdout);
    assert!(!out.stdout.contains("Not this one."), "{}", out.stdout);
    let out = run(&mock, &["repo", "forks", "acme/web", "-L", "5"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("ana/web"), "{}", out.stdout);
    assert!(out.stdout.contains("A web app."), "{}", out.stdout);
    let targets: Vec<String> = mock.requests().iter().map(|r| r.target.clone()).collect();
    assert!(targets.contains(&"/repos/acme/web/forks?limit=5".to_owned()), "{targets:?}");
}

#[test]
fn repo_sync_syncs_the_fork_origin_names_and_fails_on_conflicts() {
    let mock = Mock::start(|r| match (r.method.as_str(), r.path()) {
        ("POST", "/repos/ana/web/merge-upstream") if r.json()["branch"] == "docs" => (
            200,
            json!({ "status": "conflicted", "branch": "docs", "head": "abc1234def", "behind": 2, "ahead": 1, "conflicts": ["README.md"] }),
        ),
        ("POST", "/repos/ana/web/merge-upstream") => (
            200,
            json!({ "status": "fast_forwarded", "branch": "main", "head": "9c4e1f0b7a", "behind": 3, "ahead": 0, "conflicts": [] }),
        ),
        _ => (404, json!({ "error": { "code": "not_found", "message": "No." } })),
    });
    // In a clone of the fork, origin is the fork, though upstream is preferred elsewhere.
    let dir = fork_clone("sync");
    let out = g1t_with(&mock, &dir, &["repo", "sync"], &[]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stderr.contains("took in 3 commits"), "{}", out.stderr);
    assert_eq!(mock.requests()[0].json(), json!({}));
    let out = g1t_with(&mock, &dir, &["repo", "sync", "--branch", "docs"], &[]);
    assert_eq!(out.code, 1, "{}", out.stderr);
    assert!(out.stderr.contains("README.md"), "{}", out.stderr);
    assert!(out.stderr.contains("git pull upstream docs"), "{}", out.stderr);
}

#[test]
fn repo_detach_asks_for_yes_without_a_terminal() {
    let mock = Mock::start(|r| match (r.method.as_str(), r.path()) {
        ("POST", "/repos/ana/web/detach") => (200, repo_json("ana", "web", None)),
        _ => (404, json!({ "error": { "code": "not_found", "message": "No." } })),
    });
    let out = run(&mock, &["repo", "detach", "ana/web"]);
    assert_eq!(out.code, 2, "{}", out.stderr);
    assert!(out.stderr.contains("--yes"), "{}", out.stderr);
    assert!(mock.requests().is_empty());
    let out = run(&mock, &["repo", "detach", "ana/web", "--yes"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(mock.requests()[0].path(), "/repos/ana/web/detach");
}

#[test]
fn pr_create_in_a_fork_clone_proposes_the_forks_branch() {
    let mock = Mock::start(|r| match (r.method.as_str(), r.path()) {
        ("GET", "/repos/acme/web") => (200, repo_json("acme", "web", None)),
        ("POST", "/repos/acme/web/pulls") => (200, json!({ "pull": { "number": 7, "status": "open" } })),
        _ => (404, json!({ "error": { "code": "not_found", "message": "No." } })),
    });
    let dir = fork_clone("fork-pr");
    // The fork's own main branch can hold the change.
    let out = g1t_with(&mock, &dir, &["pr", "create", "--head", "main", "--title", "Fix the link", "--body", "b", "--no-push"], &[]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let sent = mock.requests()[1].json();
    assert_eq!(sent["head_repo"], "ana/web");
    assert_eq!(sent["branch"], "main");
    assert!(out.stderr.contains("from ana/web main"), "{}", out.stderr);
}
