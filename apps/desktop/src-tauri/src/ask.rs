//! Asking before g1t cuts a job short: restarting or quitting stops the
//! runner g1t runs itself (runner/mod.rs `plan`), and a job it is running
//! would fail. The system's own dialog asks, from a thread that isn't the
//! window's, wherever the restart was asked (the settings, the tray, the
//! menu): Windows' message box, macOS's dialog, or zenity or kdialog on
//! Linux. With none of them, g1t waits for the job, which cuts nothing short.

#[cfg(unix)]
use std::process::{Command, Stdio};

use crate::runner::Going;

/// What the person chose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    /// Go once the job finishes, without asking again.
    WhenDone,
    /// Stop the job and go now.
    Now,
    /// Keep g1t open.
    Stay,
}

/// The question, the button that waits for the job, and what g1t does.
fn words(going: Going) -> (&'static str, &'static str, &'static str) {
    match going {
        Going::Restart => {
            ("A job is running on this computer. Restart when it finishes, or stop it now?", "Restart when it finishes", "restart")
        }
        Going::Quit => ("A job is running on this computer. Quit when it finishes, or stop it now?", "Quit when it finishes", "quit"),
    }
}

/// The button that stops the job.
#[cfg_attr(windows, allow(dead_code))]
const NOW: &str = "Stop it now";

/// Asks, and waits for the answer.
pub fn job_running(going: Going) -> Answer {
    let (question, when, verb) = words(going);
    asked(question, when, verb)
}

#[cfg(windows)]
fn asked(question: &str, _when: &str, verb: &str) -> Answer {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(window: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    const MB_YESNOCANCEL: u32 = 0x3;
    const MB_ICONWARNING: u32 = 0x30;
    const MB_SETFOREGROUND: u32 = 0x1_0000;
    const MB_TOPMOST: u32 = 0x4_0000;
    // Its buttons are Windows' own Yes, No and Cancel, so the text says which is which.
    let text = format!("{question}\n\nYes: {verb} when it finishes.\nNo: stop it now and {verb}.\nCancel: keep g1t open.");
    let wide = |text: &str| OsStr::new(text).encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (text, caption) = (wide(&text), wide("g1t"));
    // SAFETY: both strings live until the call returns. No owner window: this
    // isn't the window's thread, and the dialog stays on top by itself.
    let pressed =
        unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), MB_YESNOCANCEL | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST) };
    message_box(pressed)
}

/// Windows' answer: IDYES, IDNO, or anything else (IDCANCEL, or Escape).
#[cfg_attr(not(windows), allow(dead_code))]
fn message_box(pressed: i32) -> Answer {
    match pressed {
        6 => Answer::WhenDone,
        7 => Answer::Now,
        _ => Answer::Stay,
    }
}

#[cfg(target_os = "macos")]
fn asked(question: &str, when: &str, _verb: &str) -> Answer {
    // The words go in as arguments, never into the script's text.
    let script = [
        "on run argv",
        "display dialog (item 1 of argv) with title \"g1t\" buttons {\"Cancel\", item 3 of argv, item 2 of argv} default button 3 cancel button 1 with icon caution",
        "end run",
    ];
    let mut command = Command::new("osascript");
    for line in script {
        command.args(["-e", line]);
    }
    match command.args([question, when, NOW]).stdin(Stdio::null()).stderr(Stdio::null()).output() {
        Ok(out) => dialog(out.status.code(), &String::from_utf8_lossy(&out.stdout), when),
        Err(_) => Answer::WhenDone,
    }
}

/// macOS's answer: `button returned:<label>`; Cancel ends it with an error.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn dialog(code: Option<i32>, out: &str, when: &str) -> Answer {
    match (code, out.trim().strip_prefix("button returned:")) {
        (Some(0), Some(label)) if label == NOW => Answer::Now,
        (Some(0), Some(label)) if label == when => Answer::WhenDone,
        _ => Answer::Stay,
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn asked(question: &str, when: &str, _verb: &str) -> Answer {
    let zenity = Command::new("zenity")
        .args(["--question", "--title=g1t", "--icon-name=dialog-warning"])
        .arg(format!("--text={question}"))
        .arg(format!("--ok-label={when}"))
        .arg("--cancel-label=Cancel")
        .arg(format!("--extra-button={NOW}"))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    if let Ok(out) = zenity {
        return zenity_answer(out.status.code(), &String::from_utf8_lossy(&out.stdout));
    }
    let kdialog = Command::new("kdialog")
        .args(["--title", "g1t", "--yesnocancel", question, "--yes-label", when, "--no-label", NOW, "--cancel-label", "Cancel"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match kdialog {
        Ok(status) => kdialog_answer(status.code()),
        Err(_) => Answer::WhenDone,
    }
}

/// zenity's answer: OK ends it with 0; the extra button prints its label
/// and ends it with 1, as Cancel does without.
#[cfg_attr(any(not(unix), target_os = "macos"), allow(dead_code))]
fn zenity_answer(code: Option<i32>, out: &str) -> Answer {
    match code {
        Some(0) => Answer::WhenDone,
        Some(1) if out.trim() == NOW => Answer::Now,
        _ => Answer::Stay,
    }
}

/// kdialog's answer: 0 for yes, 1 for no, 2 for cancel.
#[cfg_attr(any(not(unix), target_os = "macos"), allow(dead_code))]
fn kdialog_answer(code: Option<i32>) -> Answer {
    match code {
        Some(0) => Answer::WhenDone,
        Some(1) => Answer::Now,
        _ => Answer::Stay,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_question_says_what_happens_to_the_job() {
        assert_eq!(words(Going::Restart).0, "A job is running on this computer. Restart when it finishes, or stop it now?");
        assert_eq!(words(Going::Quit).1, "Quit when it finishes");
    }

    /// Every system's dialog read the same way: closing it, or a dialog that
    /// failed, keeps g1t open, so nothing is stopped that wasn't asked for.
    #[test]
    fn each_dialog_is_read_as_the_person_answered_it() {
        assert_eq!(message_box(6), Answer::WhenDone);
        assert_eq!(message_box(7), Answer::Now);
        assert_eq!(message_box(2), Answer::Stay);
        let when = words(Going::Restart).1;
        assert_eq!(dialog(Some(0), "button returned:Restart when it finishes\n", when), Answer::WhenDone);
        assert_eq!(dialog(Some(0), "button returned:Stop it now\n", when), Answer::Now);
        assert_eq!(dialog(Some(1), "", when), Answer::Stay);
        assert_eq!(zenity_answer(Some(0), ""), Answer::WhenDone);
        assert_eq!(zenity_answer(Some(1), "Stop it now\n"), Answer::Now);
        assert_eq!(zenity_answer(Some(1), ""), Answer::Stay);
        assert_eq!(zenity_answer(Some(5), ""), Answer::Stay);
        assert_eq!(kdialog_answer(Some(1)), Answer::Now);
        assert_eq!(kdialog_answer(Some(2)), Answer::Stay);
    }
}
