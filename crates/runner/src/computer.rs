//! An agent's own computer (`MODE=computer`): the long-lived process inside
//! the container that is a workspace agent's persistent home
//! (docs.g1t.sh/guides/agents/, "Its computer").
//!
//! Unlike every other mode, which does one job and exits, this one serves
//! the runner's `AgentComputer` Durable Object over HTTP on `PORT` for as
//! long as the computer is awake:
//!
//! - `GET /health`: uptime, disk used under the home, the cap.
//! - `POST /exec`: runs a command under `bash -lc` with the home as `$HOME`,
//!   streaming stdout and stderr lines as NDJSON, then one closing line
//!   with the exit code and how long it took. Output past `MAX_OUTPUT_BYTES`
//!   is dropped and the closing line says so; a command past its timeout is
//!   killed and reported as exit 124.
//! - `GET /files?path=` and `PUT /files?path=`: small files under the home.
//! - `POST /restore`: a tar+zstd of the home, unpacked into it (how the
//!   Durable Object puts a snapshot back when it wakes the computer).
//! - `POST /snapshot`: the home as tar+zstd, streamed; refused with the
//!   largest top-level directories when the home is over `DISK_CAP_BYTES`.
//! - `POST /stop`: exits cleanly, once the snapshot was taken.
//!
//! Every path is checked to lie under the home (`within_home`); nothing
//! outside it is read, written or run from. `G1T_HOME_RESTORE`, an HTTPS
//! address with a one-time token in `G1T_HOME_RESTORE_TOKEN`, restores the
//! home at start for installations that serve snapshots that way; g1t's
//! cloud streams it in through `/restore` instead. Requests carry the token
//! in `G1T_COMPUTER_TOKEN` as a bearer, so nothing else on the network
//! drives the computer.
//!
//! Only the pure parts (path checks, framing, the closing line) are used
//! off Linux, by tests.
#![cfg_attr(not(unix), allow(dead_code))]

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::docker::http::{self, Body, Head};

/// Where the agent lives: its files, clones, caches and notes.
pub(crate) const HOME: &str = "/home/agent";
/// Where a session's work goes by default, under the home.
pub(crate) const SESSIONS_DIR: &str = "sessions";
/// The port the Durable Object reaches the computer on.
pub(crate) const PORT: u16 = 8787;
/// How much the home may hold: 5 GB, a hard cap in v1 (no disk charge).
pub(crate) const DISK_CAP_BYTES: u64 = 5_000_000_000;
/// The most output one command streams back; the rest is dropped and said so.
pub(crate) const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
/// The most a file read or written through `/files` may be.
pub(crate) const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// A command's timeout when none is given, and the longest one may ask for.
pub(crate) const DEFAULT_TIMEOUT_SECONDS: u64 = 120;
pub(crate) const MAX_TIMEOUT_SECONDS: u64 = 1800;
/// The exit code of a command that was killed at its timeout, as `timeout(1)` reports it.
pub(crate) const TIMED_OUT_EXIT: i32 = 124;

/// What the process knows while it serves.
struct Server {
    token: Option<String>,
    started: Instant,
    /// Commands running now: the Durable Object does not put a busy computer to sleep.
    running: AtomicUsize,
}

/// `MODE=computer`: prepares the home, restores it if asked, then serves until `/stop`.
pub fn main() -> i32 {
    let server = Arc::new(Server {
        token: std::env::var("G1T_COMPUTER_TOKEN").ok().filter(|t| !t.is_empty()),
        started: Instant::now(),
        running: AtomicUsize::new(0),
    });
    if let Err(error) = prepare_home(Path::new(HOME)) {
        eprintln!("g1t-runner: the home could not be prepared: {error}");
        return 2;
    }
    if let Ok(url) = std::env::var("G1T_HOME_RESTORE") {
        if !url.trim().is_empty() {
            let token = std::env::var("G1T_HOME_RESTORE_TOKEN").unwrap_or_default();
            match restore_from_url(&url, &token) {
                Ok(()) => eprintln!("g1t-runner: the home was restored"),
                Err(error) => eprintln!("g1t-runner: the home could not be restored, so it starts fresh: {error}"),
            }
        }
    }
    let listener = match TcpListener::bind(("0.0.0.0", PORT)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("g1t-runner: could not listen on {PORT}: {error}");
            return 2;
        }
    };
    eprintln!("g1t-runner: the computer is awake on {PORT}");
    for client in listener.incoming() {
        let Ok(client) = client else { continue };
        let server = server.clone();
        std::thread::spawn(move || {
            if let Err(error) = serve(client, &server) {
                eprintln!("g1t-runner: a request failed: {error}");
            }
        });
    }
    0
}

/// Makes sure the home exists and is ours to write, with its sessions
/// directory. The image runs as `node` with sudo, and `/home` is root's.
fn prepare_home(home: &Path) -> io::Result<()> {
    if std::fs::create_dir_all(home).is_err() || !writable(home) {
        let user = Command::new("id").arg("-un").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned()).unwrap_or_default();
        let made = Command::new("sudo").args(["-n", "mkdir", "-p"]).arg(home).status().is_ok_and(|s| s.success());
        let owned = Command::new("sudo").args(["-n", "chown", "-R", &format!("{user}:{user}")]).arg(home).status().is_ok_and(|s| s.success());
        if !made || !owned || !writable(home) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("{} is not writable", home.display())));
        }
    }
    std::fs::create_dir_all(home.join(SESSIONS_DIR))
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(".g1t-probe");
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

/// Downloads a tar+zstd snapshot and unpacks it into the home.
fn restore_from_url(url: &str, token: &str) -> Result<(), String> {
    let response = ureq::get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(Duration::from_secs(600))
        .call()
        .map_err(|error| error.to_string())?;
    let mut reader = response.into_reader();
    let mut tar = untar(Path::new(HOME)).map_err(|error| error.to_string())?;
    {
        let mut stdin = tar.stdin.take().ok_or("tar has no stdin")?;
        io::copy(&mut reader, &mut stdin).map_err(|error| error.to_string())?;
    }
    let status = tar.wait().map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!("tar exited with {status}"));
    }
    Ok(())
}

/// `tar --zstd -x` into `home`, reading from its stdin.
fn untar(home: &Path) -> io::Result<Child> {
    Command::new("tar").args(["--zstd", "-x", "-f", "-", "-C"]).arg(home).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn()
}

/// Serves one connection: one request, one response.
fn serve(client: TcpStream, server: &Server) -> io::Result<()> {
    let mut reader = BufReader::new(client.try_clone()?);
    let mut writer = client;
    let Some(head) = http::read_head(&mut reader)? else { return Ok(()) };
    let body = http::request_body(&head);
    let (path, query) = split_target(head.target());
    let authorised = match &server.token {
        None => true,
        Some(token) => head.header("authorization").is_some_and(|value| value.trim() == format!("Bearer {token}")),
    };
    if !authorised {
        let _ = http::read_body(&mut reader, body);
        return respond(&mut writer, 401, "Unauthorized", &json!({ "message": "This computer takes requests from its own Durable Object only." }));
    }
    match (head.method(), path) {
        ("GET", "/health") => {
            let _ = http::read_body(&mut reader, body);
            respond(&mut writer, 200, "OK", &health(server))
        }
        ("POST", "/exec") => {
            let raw = http::read_body(&mut reader, body)?;
            let request: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
            let Some(cmd) = request.get("cmd").and_then(Value::as_str).filter(|c| !c.trim().is_empty()) else {
                return respond(&mut writer, 400, "Bad Request", &json!({ "message": "Give the command to run as cmd." }));
            };
            let cwd = match within_home(request.get("cwd").and_then(Value::as_str).unwrap_or("")) {
                Some(cwd) => cwd,
                None => return respond(&mut writer, 400, "Bad Request", &json!({ "message": format!("cwd must be under {HOME}.") })),
            };
            let timeout = request.get("timeout_seconds").and_then(Value::as_u64).unwrap_or(DEFAULT_TIMEOUT_SECONDS).clamp(1, MAX_TIMEOUT_SECONDS);
            let env = request.get("env").and_then(Value::as_object).map(|map| map.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned()))).collect()).unwrap_or_default();
            server.running.fetch_add(1, Ordering::SeqCst);
            let result = stream_exec(&mut writer, cmd, &cwd, Duration::from_secs(timeout), &env);
            server.running.fetch_sub(1, Ordering::SeqCst);
            result
        }
        ("GET", "/files") => {
            let _ = http::read_body(&mut reader, body);
            let Some(path) = query.get("path").and_then(|p| resolve_in_home(p)) else {
                return respond(&mut writer, 400, "Bad Request", &json!({ "message": format!("path must be under {HOME}.") }));
            };
            let size = match std::fs::metadata(&path) {
                Ok(meta) if meta.is_file() => meta.len(),
                Ok(_) => return respond(&mut writer, 400, "Bad Request", &json!({ "message": "That is a directory, not a file." })),
                Err(_) => return respond(&mut writer, 404, "Not Found", &json!({ "message": "There is no such file." })),
            };
            if size > MAX_FILE_BYTES {
                return respond(&mut writer, 413, "Payload Too Large", &json!({ "message": format!("The file is {size} bytes; files read this way are at most {MAX_FILE_BYTES}."), "bytes": size }));
            }
            let bytes = std::fs::read(&path)?;
            let head = Head { start: "HTTP/1.1 200 OK".into(), headers: vec![("Content-Type".into(), "application/octet-stream".into())] };
            writer.write_all(&http::with_length(head, &bytes))?;
            writer.flush()
        }
        ("PUT", "/files") => {
            let Some(path) = query.get("path").and_then(|p| resolve_in_home(p)) else {
                let _ = http::read_body(&mut reader, body);
                return respond(&mut writer, 400, "Bad Request", &json!({ "message": format!("path must be under {HOME}.") }));
            };
            if let Body::Length(n) = body {
                if n > MAX_FILE_BYTES {
                    return respond(&mut writer, 413, "Payload Too Large", &json!({ "message": format!("Files written this way are at most {MAX_FILE_BYTES} bytes.") }));
                }
            }
            let bytes = http::read_body(&mut reader, body)?;
            if bytes.len() as u64 > MAX_FILE_BYTES {
                return respond(&mut writer, 413, "Payload Too Large", &json!({ "message": format!("Files written this way are at most {MAX_FILE_BYTES} bytes.") }));
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, &bytes)?;
            respond(&mut writer, 200, "OK", &json!({ "ok": true, "path": path.to_string_lossy(), "bytes": bytes.len() }))
        }
        ("POST", "/restore") => {
            let mut tar = untar(Path::new(HOME))?;
            let copied = {
                let mut stdin = tar.stdin.take().expect("tar's stdin");
                http::copy_body(&mut reader, &mut stdin, body)
            };
            let status = tar.wait()?;
            match (copied, status.success()) {
                (Ok(()), true) => respond(&mut writer, 200, "OK", &json!({ "ok": true, "disk_used_bytes": dir_size(Path::new(HOME)) })),
                (Err(error), _) => respond(&mut writer, 400, "Bad Request", &json!({ "message": format!("The snapshot could not be read: {error}") })),
                (Ok(()), false) => respond(&mut writer, 500, "Internal Server Error", &json!({ "message": format!("tar exited with {status}") })),
            }
        }
        ("POST", "/snapshot") => {
            let _ = http::read_body(&mut reader, body);
            let home = Path::new(HOME);
            let used = dir_size(home);
            if used > DISK_CAP_BYTES {
                let largest: Vec<Value> = largest_top_level(home).into_iter().take(8).map(|(name, bytes)| json!({ "path": name, "bytes": bytes })).collect();
                return respond(
                    &mut writer,
                    413,
                    "Payload Too Large",
                    &json!({ "message": over_cap_message(used, &largest_top_level(home)), "disk_used_bytes": used, "disk_cap_bytes": DISK_CAP_BYTES, "largest": largest }),
                );
            }
            stream_snapshot(&mut writer, home, used)
        }
        ("POST", "/stop") => {
            let _ = http::read_body(&mut reader, body);
            respond(&mut writer, 200, "OK", &json!({ "ok": true }))?;
            let _ = writer.shutdown(std::net::Shutdown::Both);
            eprintln!("g1t-runner: the computer is going to sleep");
            std::process::exit(0);
        }
        _ => {
            let _ = http::read_body(&mut reader, body);
            respond(&mut writer, 404, "Not Found", &json!({ "message": "No such route." }))
        }
    }
}

fn respond(writer: &mut TcpStream, status: u16, reason: &str, body: &Value) -> io::Result<()> {
    writer.write_all(&http::json_response(status, reason, body))?;
    writer.flush()
}

fn health(server: &Server) -> Value {
    json!({
        "uptime_seconds": server.started.elapsed().as_secs(),
        "disk_used_bytes": dir_size(Path::new(HOME)),
        "disk_cap_bytes": DISK_CAP_BYTES,
        "running_commands": server.running.load(Ordering::SeqCst),
        "home": HOME,
    })
}

/// A request target as its path and its query, decoded.
pub(crate) fn split_target(target: &str) -> (&str, BTreeMap<String, String>) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mut out = BTreeMap::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        out.insert(percent_decode(key), percent_decode(value));
    }
    (path, out)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = &text[i + 1..i + 3];
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── Paths ─────────────────────────────────────────────────────────────────

/// `given` as a path under `home`, or `None` when it would leave it: a
/// relative path is taken from the home, `..` is resolved without touching
/// the filesystem, and anything that climbs above the home is refused. The
/// empty path is the home itself. Pure, so it is tested everywhere.
pub(crate) fn within(home: &str, given: &str) -> Option<PathBuf> {
    if given.contains('\0') {
        return None;
    }
    let given = given.trim();
    let home = home.trim_end_matches('/');
    let mut parts: Vec<&str> = if given.starts_with('/') { Vec::new() } else { home.split('/').filter(|p| !p.is_empty()).collect() };
    for part in given.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            name => parts.push(name),
        }
    }
    let joined = format!("/{}", parts.join("/"));
    if joined == home || joined.starts_with(&format!("{home}/")) { Some(PathBuf::from(joined)) } else { None }
}

/// `within` for the real home.
pub(crate) fn within_home(given: &str) -> Option<PathBuf> {
    within(HOME, given)
}

/// `within_home`, and then the path as the filesystem resolves it: a
/// symlink inside the home that points out of it is refused too. The
/// deepest existing ancestor is what is resolved, so a file not made yet
/// can still be written.
fn resolve_in_home(given: &str) -> Option<PathBuf> {
    let path = within_home(given)?;
    let home = std::fs::canonicalize(HOME).unwrap_or_else(|_| PathBuf::from(HOME));
    let mut probe = path.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(&probe) {
            if real != home && !real.starts_with(&home) {
                return None;
            }
            let mut out = real;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return Some(out);
        }
        let name = probe.file_name()?.to_owned();
        tail.push(name);
        probe = probe.parent()?.to_path_buf();
    }
}

// ── Running commands ──────────────────────────────────────────────────────

/// One line of a command's output, as streamed.
pub(crate) fn output_line(stream: &str, line: &str) -> Value {
    json!({ "stream": stream, "line": line })
}

/// The closing line of a command: how it ended.
pub(crate) fn final_line(exit_code: i32, duration: Duration, dropped_bytes: usize, timed_out: bool) -> Value {
    let mut line = json!({ "exit_code": exit_code, "duration_ms": duration.as_millis() as u64, "truncated": dropped_bytes > 0, "timed_out": timed_out });
    if dropped_bytes > 0 {
        line["note"] = json!(format!("Output past {} was dropped: {} more bytes.", human_bytes(MAX_OUTPUT_BYTES as u64), dropped_bytes));
    }
    if timed_out {
        line["note"] = json!(format!(
            "{}The command was still running at its timeout and was killed.",
            line.get("note").and_then(Value::as_str).map(|n| format!("{n} ")).unwrap_or_default()
        ));
    }
    line
}

/// Environment the agent may set for a command: plain names, and never the
/// process's own credentials or anything that changes how programs load.
pub(crate) fn safe_env(given: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    given
        .iter()
        .filter(|(name, _)| {
            let plain = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !name.starts_with(|c: char| c.is_ascii_digit());
            let risky = name.starts_with("G1T_") || name.starts_with("LD_") || matches!(name.as_str(), "BASH_ENV" | "ENV" | "PROMPT_COMMAND" | "HOME" | "SHELLOPTS" | "BASHOPTS");
            plain && !risky
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

/// Something a command's output produced.
enum Produced {
    Line(&'static str, String),
    Closed,
}

/// Runs `cmd` and gives every line to `sink` as it comes, then the closing
/// line. Returns what the closing line said.
pub(crate) fn run_streaming(cmd: &str, cwd: &Path, timeout: Duration, env: &BTreeMap<String, String>, sink: &mut dyn FnMut(Value) -> io::Result<()>) -> io::Result<Value> {
    std::fs::create_dir_all(cwd)?;
    let started = Instant::now();
    let mut command = Command::new("bash");
    command.args(["-lc", cmd]).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.env_remove("G1T_COMPUTER_TOKEN").env_remove("G1T_HOME_RESTORE").env_remove("G1T_HOME_RESTORE_TOKEN");
    command.env("HOME", HOME).env("G1T_COMPUTER", "1");
    for (name, value) in safe_env(env) {
        command.env(name, value);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let line = json!({ "exit_code": 127, "duration_ms": 0, "truncated": false, "timed_out": false, "note": format!("bash could not be started: {error}") });
            sink(line.clone())?;
            return Ok(line);
        }
    };
    let (sender, receiver) = mpsc::channel::<Produced>();
    let mut readers = Vec::new();
    for (name, pipe) in [("stdout", child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>)), ("stderr", child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>))] {
        let Some(pipe) = pipe else { continue };
        let sender = sender.clone();
        readers.push(std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut buffer = Vec::new();
            loop {
                buffer.clear();
                match reader.read_until(b'\n', &mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let text = String::from_utf8_lossy(&buffer).trim_end_matches(['\r', '\n']).to_owned();
                        if sender.send(Produced::Line(name, text)).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = sender.send(Produced::Closed);
        }));
    }
    drop(sender);
    let mut open = readers.len();
    let mut sent = 0usize;
    let mut dropped = 0usize;
    let mut timed_out = false;
    let deadline = started + timeout;
    while open > 0 {
        let now = Instant::now();
        if now >= deadline {
            timed_out = true;
            let _ = child.kill();
            break;
        }
        match receiver.recv_timeout(deadline - now) {
            Ok(Produced::Line(stream, text)) => {
                let bytes = text.len() + 1;
                if sent + bytes > MAX_OUTPUT_BYTES {
                    dropped += bytes;
                    continue;
                }
                sent += bytes;
                sink(output_line(stream, &text))?;
            }
            Ok(Produced::Closed) => open -= 1,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                timed_out = true;
                let _ = child.kill();
                break;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let status = child.wait()?;
    for reader in readers {
        let _ = reader.join();
    }
    let exit_code = if timed_out { TIMED_OUT_EXIT } else { status.code().unwrap_or(-1) };
    let line = final_line(exit_code, started.elapsed(), dropped, timed_out);
    sink(line.clone())?;
    Ok(line)
}

/// `/exec`: the command's lines as a chunked NDJSON response.
fn stream_exec(writer: &mut TcpStream, cmd: &str, cwd: &Path, timeout: Duration, env: &BTreeMap<String, String>) -> io::Result<()> {
    writer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\n\r\n")?;
    writer.flush()?;
    let mut sink = |line: Value| -> io::Result<()> {
        let mut text = line.to_string();
        text.push('\n');
        write_chunk(writer, text.as_bytes())
    };
    run_streaming(cmd, cwd, timeout, env, &mut sink)?;
    writer.write_all(b"0\r\n\r\n")?;
    writer.flush()
}

/// One chunk of a chunked body, flushed so it is seen as it is written.
pub(crate) fn write_chunk<W: Write>(writer: &mut W, bytes: &[u8]) -> io::Result<()> {
    if bytes.is_empty() {
        return Ok(());
    }
    write!(writer, "{:x}\r\n", bytes.len())?;
    writer.write_all(bytes)?;
    writer.write_all(b"\r\n")?;
    writer.flush()
}

// ── Snapshots ─────────────────────────────────────────────────────────────

/// Every file's size under `dir`, symlinks not followed.
pub(crate) fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut total = 0;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            total += dir_size(&entry.path());
        } else if meta.is_file() {
            total += meta.len();
        }
    }
    total
}

/// The home's top-level entries by size, largest first.
pub(crate) fn largest_top_level(home: &Path) -> Vec<(String, u64)> {
    let Ok(entries) = std::fs::read_dir(home) else { return Vec::new() };
    let mut out: Vec<(String, u64)> = entries
        .flatten()
        .map(|entry| {
            let size = entry.metadata().map(|meta| if meta.is_dir() { dir_size(&entry.path()) } else { meta.len() }).unwrap_or(0);
            (entry.file_name().to_string_lossy().into_owned(), size)
        })
        .collect();
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
}

/// What the computer says when its home is over the cap.
pub(crate) fn over_cap_message(used: u64, largest: &[(String, u64)]) -> String {
    let named: Vec<String> = largest.iter().take(5).map(|(name, bytes)| format!("{name} ({})", human_bytes(*bytes))).collect();
    format!(
        "The home holds {}, over its {} cap, so it can't be saved. Largest at the top level: {}. Remove or trim some of it, or reset the computer.",
        human_bytes(used),
        human_bytes(DISK_CAP_BYTES),
        if named.is_empty() { "nothing".to_owned() } else { named.join(", ") }
    )
}

pub(crate) fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 { format!("{bytes} B") } else { format!("{value:.1} {}", UNITS[unit]) }
}

/// `/snapshot`: the home as tar+zstd, chunked as tar writes it. A tar
/// that fails ends the connection without the closing chunk, so the reader
/// knows the archive is not whole.
fn stream_snapshot(writer: &mut TcpStream, home: &Path, used: u64) -> io::Result<()> {
    let mut tar = Command::new("tar")
        .args(["--zstd", "-c", "-f", "-", "-C"])
        .arg(home)
        .arg(".")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let mut stdout = tar.stdout.take().expect("tar's stdout");
    writer.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/zstd\r\nTransfer-Encoding: chunked\r\nX-G1t-Disk-Used: {used}\r\n\r\n").as_bytes())?;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let n = stdout.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        write_chunk(writer, &buffer[..n])?;
    }
    let status = tar.wait()?;
    if !status.success() {
        let _ = writer.shutdown(std::net::Shutdown::Both);
        return Err(io::Error::other(format!("tar exited with {status}")));
    }
    writer.write_all(b"0\r\n\r\n")?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_under_the_home() {
        let home = "/home/agent";
        assert_eq!(within(home, ""), Some(PathBuf::from("/home/agent")));
        assert_eq!(within(home, "notes.md"), Some(PathBuf::from("/home/agent/notes.md")));
        assert_eq!(within(home, "./sessions/asn_1/"), Some(PathBuf::from("/home/agent/sessions/asn_1")));
        assert_eq!(within(home, "/home/agent/x/../y"), Some(PathBuf::from("/home/agent/y")));
        assert_eq!(within(home, "a/b/../../c"), Some(PathBuf::from("/home/agent/c")));
        assert_eq!(within(home, "/home/agent"), Some(PathBuf::from("/home/agent")));
    }

    #[test]
    fn paths_that_leave_the_home_are_refused() {
        let home = "/home/agent";
        assert_eq!(within(home, "../etc/passwd"), None);
        assert_eq!(within(home, "/etc/passwd"), None);
        assert_eq!(within(home, "/home/agentx/secret"), None);
        assert_eq!(within(home, "/home/agent/../node/.ssh"), None);
        assert_eq!(within(home, "a/../../.."), None);
        assert_eq!(within(home, "/"), None);
        assert_eq!(within(home, "ok\0bad"), None);
    }

    #[test]
    fn targets_split_into_path_and_query() {
        let (path, query) = split_target("/files?path=%2Fhome%2Fagent%2Fa+b.txt&x=1");
        assert_eq!(path, "/files");
        assert_eq!(query.get("path").map(String::as_str), Some("/home/agent/a b.txt"));
        assert_eq!(query.get("x").map(String::as_str), Some("1"));
        assert_eq!(split_target("/health").0, "/health");
    }

    #[test]
    fn the_closing_line_says_how_it_ended() {
        let plain = final_line(0, Duration::from_millis(1234), 0, false);
        assert_eq!(plain["exit_code"], 0);
        assert_eq!(plain["duration_ms"], 1234);
        assert_eq!(plain["truncated"], false);
        assert_eq!(plain["timed_out"], false);
        assert!(plain.get("note").is_none());
        let cut = final_line(TIMED_OUT_EXIT, Duration::from_secs(2), 10, true);
        assert_eq!(cut["truncated"], true);
        assert_eq!(cut["timed_out"], true);
        let note = cut["note"].as_str().unwrap();
        assert!(note.contains("dropped") && note.contains("killed"), "{note}");
    }

    #[test]
    fn the_environment_keeps_out_what_it_must() {
        let mut given = BTreeMap::new();
        for (k, v) in [("FOO", "1"), ("G1T_TOKEN", "x"), ("LD_PRELOAD", "evil.so"), ("HOME", "/root"), ("bad-name", "1"), ("1ABC", "1"), ("CI", "true")] {
            given.insert(k.to_owned(), v.to_owned());
        }
        let kept = safe_env(&given);
        assert_eq!(kept.keys().cloned().collect::<Vec<_>>(), vec!["CI".to_owned(), "FOO".to_owned()]);
    }

    #[test]
    fn chunks_are_framed() {
        let mut out = Vec::new();
        write_chunk(&mut out, b"hello").unwrap();
        write_chunk(&mut out, b"").unwrap();
        assert_eq!(out, b"5\r\nhello\r\n");
    }

    #[test]
    fn bytes_read_as_words() {
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(5_000_000_000), "5.0 GB");
        assert!(over_cap_message(6_000_000_000, &[("node_modules".into(), 4_000_000_000)]).contains("node_modules (4.0 GB)"));
    }

    #[cfg(unix)]
    #[test]
    fn a_command_streams_its_lines_then_how_it_ended() {
        let dir = std::env::temp_dir().join(format!("g1t-computer-{}", std::process::id()));
        let mut lines = Vec::new();
        let last = run_streaming("echo one; echo two 1>&2; exit 3", &dir, Duration::from_secs(10), &BTreeMap::new(), &mut |line| {
            lines.push(line);
            Ok(())
        })
        .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(lines.len(), 3, "{lines:?}");
        assert!(lines.iter().any(|l| l["stream"] == "stdout" && l["line"] == "one"));
        assert!(lines.iter().any(|l| l["stream"] == "stderr" && l["line"] == "two"));
        assert_eq!(last["exit_code"], 3);
        assert_eq!(last["timed_out"], false);
        assert_eq!(lines[2], last);
    }

    #[cfg(unix)]
    #[test]
    fn a_command_past_its_timeout_is_killed() {
        let dir = std::env::temp_dir().join(format!("g1t-computer-slow-{}", std::process::id()));
        let mut lines = Vec::new();
        let last = run_streaming("echo start; sleep 30; echo never", &dir, Duration::from_millis(300), &BTreeMap::new(), &mut |line| {
            lines.push(line);
            Ok(())
        })
        .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(last["exit_code"], TIMED_OUT_EXIT);
        assert_eq!(last["timed_out"], true);
        assert!(!lines.iter().any(|l| l["line"] == "never"));
    }
}
