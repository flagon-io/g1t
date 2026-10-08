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
            return Some(line.to_owned());
        }
        let Some((name, properties, data)) = parse_command(line) else {
            return Some(line.to_owned());
        };
        match name.as_str() {
            "add-mask" => {
                if !data.trim().is_empty() {
                    log.add_mask(data.trim());
                }
                None
            }
            "error" | "warning" | "notice" => {
                log.annotation(&name, &data, &properties);
                let label = match name.as_str() {
                    "error" => "Error",
                    "warning" => "Warning",
                    _ => "Notice",
                };
                Some(format!("##[{name}]{label}: {data}"))
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
            "echo" => None,
            "add-path" | "set-env" => Some(format!(
                "##[error]The `{name}` command is disabled, as on GitHub. Write to the file in $GITHUB_{} instead.",
                if name == "add-path" { "PATH" } else { "ENV" }
            )),
            _ => Some(line.to_owned()),
        }
    }
}

/// How a process ended.
pub(crate) enum Ended {
    Exited(i32),
    TimedOut,
}

/// Runs the command, sending its output (stdout and stderr together, a
/// line at a time) through `commands` to the log, until it ends or
/// `timeout` passes.
pub(crate) fn run(mut command: Command, timeout: Duration, log: &mut Log, commands: &mut Commands) -> std::io::Result<Ended> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
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
            let _ = child.kill();
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
    Ok(Ended::Exited(status.code().unwrap_or(1)))
}

#[cfg(test)]
mod tests {
    use super::parse_command;

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
