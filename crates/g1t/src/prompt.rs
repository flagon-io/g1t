//! Questions, asked only of a person at a terminal. Piped, or with
//! `G1T_PROMPT_DISABLED` set, nothing is asked: a command that needs an
//! answer fails with the flag that gives it.

use std::io::{BufRead, IsTerminal, Write};

use crate::error::{Error, Result};

pub fn interactive() -> bool {
    std::io::stdin().is_terminal()
        && std::io::stderr().is_terminal()
        && std::env::var_os("G1T_PROMPT_DISABLED").is_none_or(|v| v.is_empty())
}

/// Fails the way a command does when it would have asked: naming the flag.
pub fn needed(what: &str, flag: &str) -> Error {
    Error::usage(format!("{what} is needed: pass {flag}."))
}

fn read_line() -> Result<String> {
    let mut line = String::new();
    let read = std::io::stdin().lock().read_line(&mut line)?;
    if read == 0 {
        return Err(Error::exit(crate::error::Kind::Failed));
    }
    Ok(line.trim_end_matches(['\n', '\r']).to_owned())
}

pub fn input(label: &str, default: Option<&str>) -> Result<String> {
    let mut err = std::io::stderr().lock();
    match default {
        Some(d) if !d.is_empty() => write!(err, "? {label} ({d}) ")?,
        _ => write!(err, "? {label} ")?,
    }
    err.flush()?;
    drop(err);
    let line = read_line()?;
    Ok(if line.trim().is_empty() {
        default.unwrap_or("").to_owned()
    } else {
        line.trim().to_owned()
    })
}

pub fn secret(label: &str) -> Result<String> {
    rpassword::prompt_password(format!("? {label} "))
        .map_err(|e| Error::failed(format!("Could not read it: {e}")))
}

/// Picks one of `options`, by number.
pub fn select(label: &str, options: &[String]) -> Result<usize> {
    let mut err = std::io::stderr().lock();
    writeln!(err, "? {label}")?;
    for (i, option) in options.iter().enumerate() {
        writeln!(err, "  {}. {option}", i + 1)?;
    }
    drop(err);
    loop {
        let answer = input("Number:", Some("1"))?;
        match answer.parse::<usize>() {
            Ok(n) if (1..=options.len()).contains(&n) => return Ok(n - 1),
            _ => eprintln!("  Pick 1 to {}.", options.len()),
        }
    }
}

/// Opens the editor on `initial` and returns what was saved.
pub fn editor(initial: &str) -> Result<String> {
    let editor = ["G1T_EDITOR", "VISUAL", "EDITOR"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
        .or_else(|| {
            crate::git::run(&["config", "core.editor"])
                .ok()
                .filter(|v| !v.is_empty())
        })
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "notepad".to_owned()
            } else {
                "vi".to_owned()
            }
        });
    let path = std::env::temp_dir().join(format!("g1t-{}.md", std::process::id()));
    std::fs::write(&path, initial)?;
    let shell_line = format!("{editor} \"{}\"", path.display());
    let status = if cfg!(windows) {
        std::process::Command::new("cmd")
            .args(["/C", &shell_line])
            .status()
    } else {
        std::process::Command::new("sh")
            .args(["-c", &shell_line])
            .status()
    }
    .map_err(|e| Error::failed(format!("Could not open {editor}: {e}")))?;
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    if !status.success() {
        return Err(Error::failed(format!("{editor} did not finish.")));
    }
    Ok(text.trim().to_owned())
}

/// A body from `--body`, `--body-file` (`-` for stdin), or the editor.
pub fn body(body: Option<String>, file: Option<&str>, ask: bool) -> Result<Option<String>> {
    if let Some(b) = body {
        return Ok(Some(b));
    }
    if let Some(path) = file {
        let text = if path == "-" {
            let mut s = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)?;
            s
        } else {
            std::fs::read_to_string(path)
                .map_err(|e| Error::failed(format!("Could not read {path}: {e}")))?
        };
        return Ok(Some(text));
    }
    if ask && interactive() {
        let text = editor("")?;
        return Ok((!text.is_empty()).then_some(text));
    }
    Ok(None)
}

/// Opens `url` in a browser, or prints it when there is none to open.
pub fn open_browser(url: &str) -> bool {
    if let Some(browser) = std::env::var("G1T_BROWSER")
        .ok()
        .or_else(|| std::env::var("BROWSER").ok())
        .filter(|b| !b.is_empty())
    {
        return std::process::Command::new(browser)
            .arg(url)
            .status()
            .is_ok_and(|s| s.success());
    }
    let result = if cfg!(windows) {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .status()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).status()
    } else {
        std::process::Command::new("xdg-open")
            .arg(url)
            .stderr(std::process::Stdio::null())
            .status()
    };
    result.is_ok_and(|s| s.success())
}
