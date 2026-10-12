//! What the runner's log says, read a line at a time. `g1t-runner` writes
//! one line per thing it does (crates/runner/src/selfhosted/mod.rs), the
//! same in every backend: in a sandbox, in a container, or on this
//! computer. The app reads its state from those lines rather than asking
//! g1t, so the tray is right even while g1t cannot be reached.

/// What one line of the log means for the app.
#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    /// Registered and polling for work: `g1t-runner 0.2.3: name (labels) is listening for work from …`.
    Listening { version: String },
    /// It took work: `Took workflow build (acme/web).`
    Took { name: String, repo: String },
    /// The work it had ended: `workflow build ended (0).`
    Ended,
    /// g1t does not know this runner any more: it was removed, or its
    /// credential was. The registration is gone and a new one is needed.
    Forgotten,
    /// The registration token was refused: expired, or not one.
    TokenRefused,
    /// g1t could not be reached; the runner tries again by itself.
    Offline,
    /// Something went wrong that stops the runner: the program's own error line.
    Failed(String),
    /// Anything else, kept only in the log file.
    Other,
}

/// The line without the time the runner put in front of it (`2026-10-12T08:00:00Z …`).
pub fn message(line: &str) -> &str {
    let line = line.trim();
    match line.split_once(' ') {
        Some((first, rest)) if first.len() == 20 && first.starts_with("20") && first.ends_with('Z') => rest,
        _ => line,
    }
}

pub fn read(line: &str) -> Event {
    let text = message(line);
    if let Some(rest) = text.strip_prefix("g1t-runner ")
        && let Some((version, after)) = rest.split_once(": ")
        && after.contains(" is listening for work from ")
    {
        return Event::Listening { version: version.to_owned() };
    }
    if let Some(rest) = text.strip_prefix("Took ")
        && let Some(rest) = rest.strip_suffix(").")
        && let Some((head, repo)) = rest.rsplit_once(" (")
    {
        let name = head.split_once(' ').map_or(head, |(_kind, name)| name);
        return Event::Took { name: name.to_owned(), repo: repo.to_owned() };
    }
    if (text.starts_with("workflow ") || text.starts_with("agent ")) && text.contains(" ended (") {
        return Event::Ended;
    }
    if text.contains("g1t no longer knows this runner") || text.contains("This runner was removed from g1t") {
        return Event::Forgotten;
    }
    if text.contains("could not reach g1t") && !text.starts_with("g1t-runner: ") {
        return Event::Offline;
    }
    if let Some(error) = text.strip_prefix("g1t-runner: ") {
        let lower = error.to_ascii_lowercase();
        if lower.contains("token") && (lower.contains("not valid") || lower.contains("expired") || lower.contains("invalid")) {
            return Event::TokenRefused;
        }
        return Event::Failed(error.to_owned());
    }
    Event::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_runner_listening_is_read_with_its_version() {
        let line = "2026-10-12T08:00:00Z g1t-runner 0.2.3: syntaqx-win (self-hosted, windows, x64, desktop) is listening for work from https://g1t.sh. Isolation: host: jobs run directly on this machine, unsandboxed.";
        assert_eq!(read(line), Event::Listening { version: "0.2.3".into() });
    }

    #[test]
    fn work_taken_and_ended_is_read() {
        assert_eq!(
            read("2026-10-12T08:00:01Z Took workflow Build the installer (flagon-io/g1t)."),
            Event::Took { name: "Build the installer".into(), repo: "flagon-io/g1t".into() }
        );
        assert_eq!(read("2026-10-12T08:09:00Z workflow Build the installer ended (0)."), Event::Ended);
        assert_eq!(read("agent Review ended (1)."), Event::Ended);
    }

    #[test]
    fn losing_the_registration_is_read() {
        assert_eq!(read("g1t-runner: g1t no longer knows this runner (401 unauthorized). Register it again."), Event::Forgotten);
        assert_eq!(read("2026-10-12T08:00:00Z This runner was removed from g1t; stopping."), Event::Forgotten);
        assert_eq!(read("g1t-runner: The registration token is not valid, or has expired."), Event::TokenRefused);
        assert_eq!(read("g1t-runner: could not make /data"), Event::Failed("could not make /data".into()));
        assert_eq!(read("2026-10-12T08:00:00Z Registered syntaqx-win in acme."), Event::Other);
        assert_eq!(message("plain"), "plain");
        assert_eq!(read("2026-10-12T08:00:00Z could not reach g1t: dns error; trying again in 4s"), Event::Offline);
    }
}
