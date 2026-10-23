//! Running one process for a step: its output streamed to the log as it
//! comes, with GitHub's workflow commands (`::error::`, `::group::`,
//! `::add-mask::`…) read out of it.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use super::report::Log;

/// What a step's workflow commands left behind.
#[derive(Default)]
pub(crate) struct Commands {
    /// `::set-output` (old, still honoured).
    pub(crate) outputs: BTreeMap<String, String>,
    /// `::save-state`, for the action's post step.
    pub(crate) state: BTreeMap<String, String>,
    /// Set by `::stop-commands::token` until `::token::`.
    pub(crate) stopped: Option<String>,
    /// Whether `::debug::` lines are shown (`ACTIONS_STEP_DEBUG`).
    pub(crate) debug: bool,
    /// `::echo::on` or `::echo::off`: whether command lines are shown as
    /// well as acted on. Until a step says, they are with debug logging.
    pub(crate) echo: Option<bool>,
}

/// `%25`, `%0D`, `%0A`, and in properties `%3A` and `%2C`, as the
/// toolkit escapes them.
fn unescape(text: &str, property: bool) -> String {
    let mut out = text.replace("%0D", "\r").replace("%0A", "\n");
    if property {
        out = out.replace("%3A", ":").replace("%2C", ",");
    }
    out.replace("%25", "%")
}

/// `::name key=value,key=value::message`, if the line is a command.
pub(crate) fn parse_command(line: &str) -> Option<(String, Map<String, Value>, String)> {
    let rest = line.trim_start().strip_prefix("::")?;
    let end = rest.find("::")?;
    let (head, data) = (&rest[..end], &rest[end + 2..]);
    let (name, properties) = match head.split_once(' ') {
        Some((name, properties)) => (name, properties),
        None => (head, ""),
    };
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    let mut map = Map::new();
    for pair in properties.split(',').filter(|p| !p.trim().is_empty()) {
        if let Some((key, value)) = pair.split_once('=') {
            map.insert(key.trim().to_owned(), Value::String(unescape(value, true)));
        }
    }
    Some((name.to_owned(), map, unescape(data, false)))
}

impl Commands {
    /// Handles one line of output: a command is acted on, and the line to
    /// show (if any) is returned.
    pub(crate) fn handle(&mut self, line: &str, log: &mut Log) -> Option<String> {
        if let Some(token) = &self.stopped {
            if line.trim() == format!("::{token}::") {
                self.stopped = None;
                return None;
            }
            return Some(output(line, log));
        }
        let Some((name, properties, data)) = parse_command(line) else {
            return Some(output(line, log));
        };
        // Echoed as it reads, before it is acted on; `::add-mask::` never is.
        let known = matches!(
            name.as_str(),
            "add-mask" | "error" | "warning" | "notice" | "group" | "endgroup" | "debug" | "set-output" | "save-state" | "stop-commands" | "echo" | "add-matcher" | "remove-matcher" | "add-path" | "set-env"
        );
        if known && name != "add-mask" && self.echo.unwrap_or(self.debug) {
            log.line(line);
        }
        match name.as_str() {
            "add-mask" => {
                if !data.trim().is_empty() {
                    log.add_mask(data.trim());
                }
                None
            }
            "error" | "warning" | "notice" => {
                log.annotation(&name, &data, &properties);
                Some(issue_line(&name, &data))
            }
            "group" => Some(format!("##[group]{data}")),
            "endgroup" => Some("##[endgroup]".to_owned()),
            "debug" => self.debug.then(|| format!("##[debug]{data}")),
            "set-output" => {
                if let Some(name) = properties.get("name").and_then(Value::as_str) {
                    self.outputs.insert(name.to_owned(), data);
                }
                None
            }
            "save-state" => {
                if let Some(name) = properties.get("name").and_then(Value::as_str) {
                    self.state.insert(name.to_owned(), data);
                }
                None
            }
            "stop-commands" => {
                self.stopped = Some(data);
                None
            }
            "echo" => {
                match data.trim().to_ascii_lowercase().as_str() {
                    "on" => self.echo = Some(true),
                    "off" => self.echo = Some(false),
                    _ => return Some(format!("##[error]Invalid echo command value. Possible values can be: 'on', 'off'. Current value is: '{}'.", data.trim())),
                }
                None
            }
            "add-matcher" => {
                let path = matcher_path(data.trim(), &log.matchers.workspace);
                let read = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display())).and_then(|text| super::matchers::parse(&text));
                match read {
                    Ok(matchers) => {
                        log.matchers.add(matchers);
                        None
                    }
                    Err(problem) => Some(format!("##[error]Unable to process command '{line}' successfully.\n##[error]{problem}")),
                }
            }
            "remove-matcher" => {
                match properties.get("owner").and_then(Value::as_str).filter(|o| !o.trim().is_empty()) {
                    Some(owner) => log.matchers.remove(owner.trim()),
                    // No owner: every matcher in the file named.
                    None => {
                        let path = matcher_path(data.trim(), &log.matchers.workspace);
                        match std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display())).and_then(|text| super::matchers::parse(&text)) {
                            Ok(matchers) => matchers.iter().for_each(|m| log.matchers.remove(&m.owner)),
                            Err(problem) => return Some(format!("##[error]Unable to process command '{line}' successfully.\n##[error]{problem}")),
                        }
                    }
                }
                None
            }
            "add-path" | "set-env" => Some(format!(
                "##[error]The `{name}` command is disabled, as on GitHub. Write to the file in $GITHUB_{} instead.",
                if name == "add-path" { "PATH" } else { "ENV" }
            )),
            _ => Some(output(line, log)),
        }
    }
}

/// How an annotation shows in the log.
fn issue_line(level: &str, message: &str) -> String {
    let label = match level {
        "error" => "Error",
        "warning" => "Warning",
        _ => "Notice",
    };
    format!("##[{level}]{label}: {message}")
}

/// A line of output, as the log shows it: as it is, or, when a problem
/// matcher reads an issue in it, the issue, annotated.
fn output(line: &str, log: &mut Log) -> String {
    match log.matchers.issue(line) {
        Some(issue) => {
            log.annotation(issue.level, &issue.message, &issue.properties);
            issue_line(issue.level, &issue.message)
        }
        None => line.to_owned(),
    }
}

/// A matcher file's path: relative to the workspace, and a Docker action's
/// `/github/workspace` read as the workspace it is.
fn matcher_path(given: &str, workspace: &std::path::Path) -> std::path::PathBuf {
    if let Some(rest) = given.strip_prefix("/github/workspace") {
        return workspace.join(rest.trim_start_matches('/'));
    }
    let path = std::path::Path::new(given);
    if path.is_absolute() { path.to_path_buf() } else { workspace.join(path) }
}

/// Whether a step's own process was stopped by a SIGTERM the runner did
/// not send: no cancellation, no timeout. That is the machine being
/// stopped under the job (flagon-io#426: Cloudflare sent one to a live
/// job's container with nothing from g1t asking), and the job's end says
/// so (`machine_stopped`), so g1t runs it again on another machine.
static MACHINE_STOPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether [`MACHINE_STOPPED`] happened to any step of this job.
pub(crate) fn machine_stopped() -> bool {
    MACHINE_STOPPED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Whether a process was stopped by SIGTERM.
fn terminated(status: &std::process::ExitStatus) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal() == Some(libc::SIGTERM)
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        false
    }
}

/// How a process ended.
pub(crate) enum Ended {
    Exited(i32),
    TimedOut,
    /// The run was cancelled: it was interrupted, then stopped.
    Cancelled,
}

/// After a cancellation, how long a step has after SIGINT before SIGTERM,
/// and after SIGTERM before it is killed, as GitHub's runner waits.
const INTERRUPT_GRACE: Duration = Duration::from_millis(7500);
const TERMINATE_GRACE: Duration = Duration::from_millis(2500);

/// Sends `signal` to the process's group (it leads its own), so what the
/// step started hears it too. Windows has no signals: it is left to `kill`.
/// Sent with kill(2) itself: a machine without the `kill` program (procps
/// is not in every image) would otherwise give the step no SIGINT at all,
/// and leave what it started running after the step was killed.
#[cfg(unix)]
fn signal(child: &std::process::Child, signal: &str) {
    let number = match signal {
        "INT" => libc::SIGINT,
        "TERM" => libc::SIGTERM,
        _ => libc::SIGKILL,
    };
    let Ok(group) = libc::pid_t::try_from(child.id()) else {
        return;
    };
    // SAFETY: kill(2) with a negative pid signals that process group; it
    // reads no memory of ours.
    unsafe {
        libc::kill(-group, number);
    }
}

#[cfg(not(unix))]
fn signal(_child: &std::process::Child, _signal: &str) {}

/// What the job's steps started and left running, as GitHub's "Complete
/// job" finds it: every process whose environment carries the job's
/// `RUNNER_TRACKING_ID`, which each step's processes inherit, by pid and
/// name. Read from /proc, so only on Linux; elsewhere nothing is found.
pub(crate) fn orphans(tracking_id: &str) -> Vec<(u32, String)> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let marker = format!("RUNNER_TRACKING_ID={tracking_id}");
    let own = std::process::id();
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else {
            continue;
        };
        if pid == own {
            continue;
        }
        // Another user's process cannot be read, and is not the job's.
        let Ok(environ) = std::fs::read(entry.path().join("environ")) else {
            continue;
        };
        if !environ.split(|byte| *byte == 0).any(|pair| pair == marker.as_bytes()) {
            continue;
        }
        let stat = std::fs::read_to_string(entry.path().join("stat")).unwrap_or_default();
        if let Some(name) = live_name(&stat) {
            found.push((pid, name));
        }
    }
    found.sort();
    found
}

/// A running process's name from `/proc/<pid>/stat` (`pid (name) state …`),
/// whose name may hold spaces and parentheses; None for a zombie, which
/// has already ended.
fn live_name(stat: &str) -> Option<String> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let state = stat.get(close + 1..)?.split_whitespace().next()?;
    (state != "Z").then(|| stat.get(open + 1..close).map(str::to_owned)).flatten()
}

/// Kills the processes `orphans` found.
pub(crate) fn kill_orphans(found: &[(u32, String)]) {
    #[cfg(unix)]
    for (pid, _) in found {
        if let Ok(pid) = libc::pid_t::try_from(*pid) {
            // SAFETY: kill(2) on one pid; it reads no memory of ours.
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = found;
}

/// Runs the command, sending its output (stdout and stderr together, a
/// line at a time) through `commands` to the log, until it ends or
/// `timeout` passes.
pub(crate) fn run(command: Command, timeout: Duration, log: &mut Log, commands: &mut Commands) -> std::io::Result<Ended> {
    run_until(command, timeout, log, commands, &super::report::interrupt)
}

/// `run`, stopping the process gracefully once `interrupt` says so.
fn run_until(
    mut command: Command,
    timeout: Duration,
    log: &mut Log,
    commands: &mut Commands,
    interrupt: &dyn Fn() -> bool,
) -> std::io::Result<Ended> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // A group of its own, so a cancellation reaches what the step started.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        // A shell cannot trap a signal it was started with ignored, and a
        // runner started in the background (as a service, or under `&`)
        // passes SIGINT on ignored. Back to the defaults, so a cancelled
        // step hears SIGINT and its own trap runs.
        // SAFETY: only signal(), which is async-signal-safe, between fork and exec.
        unsafe {
            command.pre_exec(|| {
                for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGQUIT] {
                    libc::signal(signal, libc::SIG_DFL);
                }
                Ok(())
            });
        }
    }
    // Read before the step starts, so the end can tell whether the kernel
    // stopped anything for want of memory while it ran.
    let oom_before = oom_kills();
    let mut child = command.spawn()?;
    let (sender, lines) = mpsc::channel::<String>();
    let mut readers = Vec::new();
    let pipes: Vec<Box<dyn Read + Send>> = vec![
        Box::new(child.stdout.take().expect("piped")),
        Box::new(child.stderr.take().expect("piped")),
    ];
    for pipe in pipes {
        let sender = sender.clone();
        readers.push(std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut buffer = Vec::new();
            loop {
                buffer.clear();
                match reader.read_until(b'\n', &mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let text = String::from_utf8_lossy(&buffer);
                        let text = text.trim_end_matches(['\n', '\r']);
                        // A progress bar redraws with \r; keep its last state.
                        let text = text.rsplit('\r').next().unwrap_or(text);
                        if sender.send(text.to_owned()).is_err() {
                            break;
                        }
                    }
                }
            }
        }));
    }
    drop(sender);
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    // When the cancellation reached it, and which signal it has had.
    let mut interrupted: Option<(Instant, u8)> = None;
    loop {
        match lines.recv_timeout(Duration::from_millis(250)) {
            Ok(line) => {
                if let Some(shown) = commands.handle(&line, log) {
                    log.line(&shown);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // The job's Docker Engine starting, from its own thread.
                for note in crate::docker::take_notes() {
                    log.line(&note);
                }
                log.tick();
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if Instant::now() >= deadline {
            timed_out = true;
            signal(&child, "KILL");
            let _ = child.kill();
            break;
        }
        // Cancelled: SIGINT, then SIGTERM, then killed, as on GitHub.
        match interrupted {
            None if interrupt() => {
                log.line("##[error]The operation was canceled.");
                signal(&child, "INT");
                interrupted = Some((Instant::now(), 1));
            }
            Some((at, 1)) if at.elapsed() >= INTERRUPT_GRACE => {
                signal(&child, "TERM");
                interrupted = Some((Instant::now(), 2));
            }
            Some((at, 2)) if at.elapsed() >= TERMINATE_GRACE => {
                signal(&child, "KILL");
                let _ = child.kill();
                break;
            }
            _ => {}
        }
        if interrupted.is_some() && matches!(child.try_wait(), Ok(Some(_))) {
            // The step is gone; what it started may still hold its output.
            signal(&child, "KILL");
            break;
        }
    }
    let status = child.wait()?;
    for reader in readers {
        let _ = reader.join();
    }
    // Whatever arrived after the readers finished.
    while let Ok(line) = lines.try_recv() {
        if let Some(shown) = commands.handle(&line, log) {
            log.line(&shown);
        }
    }
    if timed_out {
        return Ok(Ended::TimedOut);
    }
    if interrupted.is_some() {
        return Ok(Ended::Cancelled);
    }
    let code = exit_code(&status);
    if code != 0 {
        // Whether the kernel stopped anything for want of memory meanwhile:
        // None when that cannot be told.
        let oom = oom_before
            .zip(oom_kills())
            .map(|(before, after)| after.saturating_sub(before));
        if let Some(stopped) = stopped_by(&status, oom.is_none()) {
            log.line(&stopped);
        }
        if let Some(stopped) = oom.filter(|n| *n > 0) {
            log.line(&out_of_memory(stopped));
        }
        // Neither cancelled nor timed out (both returned above).
        if terminated(&status) {
            MACHINE_STOPPED.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
    Ok(Ended::Exited(code))
}

/// A process's exit code, as GitHub's runner and a shell give it: one a
/// signal stopped is 128 and the signal's number (137 for SIGKILL). It was
/// 1, so CI #599's step, stopped mid-build with nothing printed, read as a
/// command that failed by itself and left no output.
fn exit_code(status: &std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    status.code().unwrap_or(1)
}

/// What the log says of a process a signal stopped (not the runner: it
/// says so itself when it cancels a step or ends one past its time). With
/// `guess`, when whether the machine ran out of memory cannot be read, a
/// SIGKILL says that is the likeliest cause.
fn stopped_by(status: &std::process::ExitStatus, guess: bool) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        let signal = status.signal()?;
        let name = match signal {
            libc::SIGKILL => "SIGKILL",
            libc::SIGTERM => "SIGTERM",
            libc::SIGINT => "SIGINT",
            libc::SIGSEGV => "SIGSEGV",
            libc::SIGABRT => "SIGABRT",
            libc::SIGBUS => "SIGBUS",
            libc::SIGHUP => "SIGHUP",
            libc::SIGPIPE => "SIGPIPE",
            _ => "",
        };
        let name = if name.is_empty() {
            String::new()
        } else {
            format!(" ({name})")
        };
        let why = if signal == libc::SIGKILL && guess {
            " The likeliest cause is the machine running out of memory."
        } else {
            ""
        };
        Some(format!(
            "##[error]The step's process was stopped by signal {signal}{name}.{why}"
        ))
    }
    #[cfg(not(unix))]
    {
        let _ = (status, guess);
        None
    }
}

/// How many processes the kernel has stopped for want of memory: the job's
/// cgroup's count (cgroup v2 `memory.events`), else the machine's
/// (`/proc/vmstat`). None where neither can be read (not Linux).
fn oom_kills() -> Option<u64> {
    let cgroup = std::fs::read_to_string("/sys/fs/cgroup/memory.events")
        .ok()
        .and_then(|text| counter(&text, "oom_kill"));
    cgroup.or_else(|| {
        std::fs::read_to_string("/proc/vmstat")
            .ok()
            .and_then(|text| counter(&text, "oom_kill"))
    })
}

/// `name value` from a file of such lines.
fn counter(text: &str, name: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once(char::is_whitespace)?;
        (key == name).then(|| value.trim().parse().ok()).flatten()
    })
}

/// The line that says the machine ran out of memory while a step ran.
fn out_of_memory(stopped: u64) -> String {
    let processes = if stopped == 1 {
        "1 process".to_owned()
    } else {
        format!("{stopped} processes")
    };
    format!(
        "##[error]The machine ran out of memory while this step ran: the kernel stopped {processes} to free some."
    )
}

#[cfg(test)]
mod tests {
    use super::parse_command;

    /// What a step left running is found by the job's tracking id, and
    /// only that.
    #[cfg(target_os = "linux")]
    #[test]
    fn orphans_are_found_by_the_jobs_tracking_id() {
        use super::{kill_orphans, live_name, orphans};
        let id = format!("github_test{}", std::process::id());
        let mut left = std::process::Command::new("sleep").arg("30").env("RUNNER_TRACKING_ID", &id).spawn().unwrap();
        let mut other = std::process::Command::new("sleep").arg("30").env("RUNNER_TRACKING_ID", "github_someone_else").spawn().unwrap();
        // /proc shows the new environment once exec has happened.
        let mut found = Vec::new();
        for _ in 0..50 {
            found = orphans(&id);
            if !found.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(found, [(left.id(), "sleep".to_owned())]);
        kill_orphans(&found);
        assert!(!left.wait().unwrap().success(), "killed");
        let _ = other.kill();
        let _ = other.wait();
        assert_eq!(live_name("12 (tmux: server) S 1 12 12"), Some("tmux: server".into()));
        assert_eq!(live_name("13 (gone) Z 1 13 13"), None);
    }

    /// A cancelled step hears SIGINT, and its own trap runs.
    #[cfg(unix)]
    #[test]
    fn a_cancelled_step_is_interrupted_and_may_clean_up() {
        use super::{Commands, Ended, run_until};
        use crate::actions::report::{Api, Log};
        use std::process::Command;
        use std::time::{Duration, Instant};

        // Offline: on a busy machine the step can outlast a batch of the log,
        // and sending it to an address that is not there held the loop for
        // seconds, past the grace this test measures.
        let mut log = Log::new(Api::offline(), Vec::new());
        let mut command = Command::new("sh");
        command.args(["-c", "trap 'echo cleaned up; exit 3' INT; echo started; while true; do sleep 0.1; done"]);
        let began = Instant::now();
        let ask = move || began.elapsed() >= Duration::from_millis(600);
        let ended = run_until(command, Duration::from_secs(60), &mut log, &mut Commands::default(), &ask).unwrap();
        assert!(matches!(ended, Ended::Cancelled));
        assert!(began.elapsed() < Duration::from_secs(8), "SIGINT ended it, not the kill after the grace period");
        let text = log.buffered();
        assert!(text.contains("The operation was canceled."), "{text}");
        assert!(text.contains("cleaned up"), "{text}");
    }

    /// `::echo::on` shows command lines until `::echo::off`, which is
    /// itself shown; `::add-mask::` never is.
    #[cfg(unix)]
    #[test]
    fn echo_shows_command_lines_while_on() {
        use super::Commands;
        use crate::actions::report::{Api, Log};

        let mut log = Log::new(Api::offline(), Vec::new());
        let mut commands = Commands::default();
        for line in ["::set-output name=a::1", "::echo::on", "::save-state name=b::2", "::add-mask::s3cret", "::echo::off", "::save-state name=c::3"] {
            if let Some(shown) = commands.handle(line, &mut log) {
                log.line(&shown);
            }
        }
        let text = log.buffered();
        assert_eq!(text, "::save-state name=b::2\n::echo::off\n");
        assert_eq!((commands.outputs.len(), commands.state.len()), (1, 2));
        // Debug logging echoes until a step says otherwise.
        let mut log = Log::new(Api::offline(), Vec::new());
        let mut commands = Commands { debug: true, ..Commands::default() };
        commands.handle("::set-output name=a::1", &mut log);
        assert!(log.buffered().contains("::set-output name=a::1"));
        assert!(commands.handle("::echo::maybe", &mut log).unwrap().contains("Invalid echo command value"));
    }

    /// A matcher added by one line reads the lines after it, until removed.
    #[cfg(unix)]
    #[test]
    fn matchers_are_added_and_removed_by_command() {
        use super::Commands;
        use crate::actions::report::{Api, Log};

        let dir = std::env::temp_dir().join(format!("g1t-add-matcher-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("go.json"),
            r#"{"problemMatcher": [{"owner": "go", "pattern": [{"regexp": "^\\s*(.+\\.go):(?:(\\d+):(\\d+):)? (.*)", "file": 1, "line": 2, "column": 3, "message": 4}]}]}"#,
        )
        .unwrap();
        let mut log = Log::new(Api::offline(), Vec::new());
        log.matchers.workspace = dir.clone();
        let mut commands = Commands::default();
        assert_eq!(commands.handle("main.go:3:1: undefined: x", &mut log).unwrap(), "main.go:3:1: undefined: x");
        assert!(commands.handle("::add-matcher::go.json", &mut log).is_none());
        assert_eq!(commands.handle("main.go:3:1: undefined: x", &mut log).unwrap(), "##[error]Error: undefined: x");
        assert!(commands.handle("::remove-matcher owner=go::", &mut log).is_none());
        assert_eq!(commands.handle("main.go:3:1: undefined: x", &mut log).unwrap(), "main.go:3:1: undefined: x");
        assert!(commands.handle("::add-matcher::missing.json", &mut log).unwrap().contains("Unable to process command"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A step stopped by a SIGTERM the runner did not send (no cancel, no
    /// timeout) marks the job's machine stopped (#426).
    #[cfg(unix)]
    #[test]
    fn a_sigterm_the_runner_did_not_send_marks_the_machine_stopped() {
        use super::{Commands, Ended, machine_stopped, run};
        use crate::actions::report::{Api, Log};
        use std::process::Command;
        use std::time::Duration;

        let mut log = Log::new(Api::offline(), Vec::new());
        let mut command = Command::new("sh");
        command.args(["-c", "echo compiling; kill -TERM $$"]);
        let ended = run(command, Duration::from_secs(60), &mut log, &mut Commands::default()).unwrap();
        assert!(matches!(ended, Ended::Exited(143)));
        assert!(log.buffered().contains("##[error]The step's process was stopped by signal 15 (SIGTERM)."));
        assert!(machine_stopped());
    }

    /// A step a signal stops says so, and exits as a shell says it did
    /// (128 and the signal), not with a 1 that reads as a command that
    /// failed by itself: CI #599's step showed only "exit code 1".
    #[cfg(unix)]
    #[test]
    fn a_step_a_signal_stops_says_so() {
        use super::{Commands, Ended, run};
        use crate::actions::report::{Api, Log};
        use std::process::Command;
        use std::time::Duration;

        let mut log = Log::new(Api::offline(), Vec::new());
        let mut command = Command::new("sh");
        command.args(["-c", "echo compiling; kill -9 $$"]);
        let ended = run(
            command,
            Duration::from_secs(60),
            &mut log,
            &mut Commands::default(),
        )
        .unwrap();
        assert!(matches!(ended, Ended::Exited(137)));
        let text = log.buffered();
        assert!(text.starts_with("compiling\n"), "{text}");
        assert!(
            text.contains("##[error]The step's process was stopped by signal 9 (SIGKILL)."),
            "{text}"
        );
        // A process that fails by itself says nothing more.
        let mut log = Log::new(Api::offline(), Vec::new());
        let mut command = Command::new("sh");
        command.args(["-c", "echo failed >&2; exit 101"]);
        let ended = run(
            command,
            Duration::from_secs(60),
            &mut log,
            &mut Commands::default(),
        )
        .unwrap();
        assert!(matches!(ended, Ended::Exited(101)));
        assert_eq!(log.buffered(), "failed\n");
    }

    #[test]
    fn the_kernels_out_of_memory_count_is_read() {
        use super::{counter, out_of_memory};
        let events = "low 0\nhigh 0\nmax 12\noom 2\noom_kill 3\noom_group_kill 0\n";
        assert_eq!(counter(events, "oom_kill"), Some(3));
        assert_eq!(counter(events, "oom"), Some(2));
        assert_eq!(counter("nr_free_pages 100\npgfault 9\n", "oom_kill"), None);
        assert_eq!(
            out_of_memory(1),
            "##[error]The machine ran out of memory while this step ran: the kernel stopped 1 process to free some."
        );
        assert!(out_of_memory(2).contains("stopped 2 processes"));
    }

    #[test]
    fn commands_are_read_with_their_properties() {
        let (name, properties, data) = parse_command("::error file=app.js,line=10,title=Bad%3A thing::Something%0Abroke").unwrap();
        assert_eq!(name, "error");
        assert_eq!(properties["file"], "app.js");
        assert_eq!(properties["line"], "10");
        assert_eq!(properties["title"], "Bad: thing");
        assert_eq!(data, "Something\nbroke");
        let (name, properties, data) = parse_command("::group::Install").unwrap();
        assert_eq!((name.as_str(), properties.len(), data.as_str()), ("group", 0, "Install"));
        assert_eq!(parse_command("::set-output name=version::1.2.3").unwrap().1["name"], "version");
        assert!(parse_command("plain text").is_none());
        assert!(parse_command(":: not a command").is_none());
    }
}
