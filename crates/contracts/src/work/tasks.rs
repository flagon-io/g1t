//! Task lists: the `- [ ]` and `- [x]` boxes in a work item's or pull
//! request's body, and ticking one. `packages/contracts/src/tasks.ts`
//! mirrors [`task_list`] for the site, which maps each box it draws to the
//! one counted here by its line; `tasks.fixtures.json` there keeps the two
//! the same.
//!
//! A box is a list item (`-`, `*`, `+`, `1.` or `1)`, in a block quote or
//! not, at any depth) that starts with `[ ]`, `[x]` or `[X]`, a space and
//! some text. Boxes in fenced code blocks are examples, not boxes. They are
//! numbered from 1 in the order they are written.
//!
//! Ticking one changes only the character between its brackets, and is
//! done against the body as it is when written (the work service compares
//! and swaps), so two people ticking different boxes at once both keep
//! their change.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
use crate::{FailureCode, User};

/// A box of a task list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    /// Its place in the body, from 1.
    pub number: u32,
    /// The line it is on, from 1.
    pub line: u32,
    /// What it says after the box.
    pub text: String,
    pub checked: bool,
    /// Where the character between its brackets is, in bytes.
    #[serde(skip)]
    pub mark: usize,
}

/// Which box to tick or untick, and how.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TaskCheck {
    /// Its place in the body, from 1.
    #[serde(default)]
    pub task: Option<u32>,
    /// Instead of `task`: words of its text. The box whose text is exactly
    /// this (ignoring case and spacing), else the one box whose text
    /// contains it; more than one is refused, naming them.
    #[serde(default)]
    pub text: Option<String>,
    /// Ticked (the default) or not.
    #[serde(default = "ticked")]
    pub checked: bool,
    /// With `task`: its text as the caller last read it. When the box at
    /// `task` says something else, the one box that says this is used
    /// instead (a box was added or removed above it); with none, it is
    /// refused as a conflict rather than ticking the wrong box.
    #[serde(default)]
    pub expected: Option<String>,
}

fn ticked() -> bool {
    true
}

/// `check_work_item_task`: ticks or unticks a box of a work item's body.
/// Whoever may edit the body may: its owner, or someone with the Triage
/// role on it. Returns `Outcome<CheckedTask>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CheckWorkItemTaskArgs {
    pub actor: User,
    pub workspace: String,
    pub number: u32,
    #[serde(flatten)]
    pub check: TaskCheck,
}

/// `check_pull_task`: ticks or unticks a box of a pull request's
/// description. Whoever opened it, or someone with the Triage role, may,
/// whatever its state. Returns `Outcome<CheckedTask>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CheckPullTaskArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub number: u32,
    #[serde(flatten)]
    pub check: TaskCheck,
}

/// What ticking a box did: the box as it is now, whether it changed (it
/// was not already so), and the body with it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CheckedTask {
    pub task: Task,
    pub changed: bool,
    pub body: String,
    /// How many boxes it has, and how many are ticked.
    pub done: u32,
    pub total: u32,
}

/// The boxes of `body`, in order.
pub fn task_list(body: &str) -> Vec<Task> {
    let mut tasks = Vec::new();
    // The fence a code block was opened with: its character and length.
    let mut fence: Option<(u8, usize)> = None;
    let mut start = 0;
    for (index, raw) in body.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let offset = start;
        start += raw.len() + 1;
        let (indent, rest) = unquoted(line);
        if let Some((mark, run)) = fence_of(rest) {
            match fence {
                None => fence = Some((mark, run)),
                Some((open, length)) if open == mark && run >= length && rest[run..].trim().is_empty() => fence = None,
                Some(_) => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if let Some((at, checked, text)) = boxed(rest) {
            tasks.push(Task {
                number: tasks.len() as u32 + 1,
                line: index as u32 + 1,
                text: text.to_owned(),
                checked,
                mark: offset + indent + at,
            });
        }
    }
    tasks
}

/// `line` without its block quote markers and leading space: how many
/// bytes those took, and the rest.
fn unquoted(line: &str) -> (usize, &str) {
    let mut rest = line;
    loop {
        let trimmed = rest.trim_start_matches([' ', '\t']);
        match trimmed.strip_prefix('>') {
            Some(after) => rest = after,
            None => return (line.len() - trimmed.len(), trimmed),
        }
    }
}

/// The fence a line opens or closes a code block with: three or more
/// backticks or tildes.
fn fence_of(rest: &str) -> Option<(u8, usize)> {
    let mark = *rest.as_bytes().first()?;
    if mark != b'`' && mark != b'~' {
        return None;
    }
    let run = rest.bytes().take_while(|byte| *byte == mark).count();
    (run >= 3).then_some((mark, run))
}

/// A list item that starts with a box: where the character between the
/// brackets is (in `rest`), whether it is ticked, and the text after it.
fn boxed(rest: &str) -> Option<(usize, bool, &str)> {
    let bytes = rest.as_bytes();
    let marker = match bytes.first()? {
        b'-' | b'*' | b'+' => 1,
        b'0'..=b'9' => {
            let digits = bytes.iter().take_while(|byte| byte.is_ascii_digit()).count();
            if digits > 9 || !matches!(bytes.get(digits), Some(b'.' | b')')) {
                return None;
            }
            digits + 1
        }
        _ => return None,
    };
    let after = &rest[marker..];
    let spaced = after.trim_start_matches([' ', '\t']);
    if spaced.len() == after.len() {
        return None;
    }
    let at = marker + (after.len() - spaced.len());
    let checked = match spaced.as_bytes() {
        [b'[', b' ', b']', b' ' | b'\t', ..] => false,
        [b'[', b'x' | b'X', b']', b' ' | b'\t', ..] => true,
        _ => return None,
    };
    let text = spaced[3..].trim();
    (!text.is_empty()).then_some((at + 1, checked, text))
}

/// `body` with the box at `task` ticked or not.
pub fn set_task(body: &str, task: &Task, checked: bool) -> String {
    let mut out = String::with_capacity(body.len());
    out.push_str(&body[..task.mark]);
    out.push(if checked { 'x' } else { ' ' });
    out.push_str(&body[task.mark + 1..]);
    out
}

/// The box `check` names in `tasks`, or why there is none: a number out
/// of range or text no box has is not found, text more than one box has
/// is invalid, and a box that moved is a conflict.
pub fn pick_task<'a>(tasks: &'a [Task], check: &TaskCheck) -> Result<&'a Task, (FailureCode, String)> {
    if tasks.is_empty() {
        return Err((FailureCode::NotFound, "It has no task list: no `- [ ]` boxes.".to_owned()));
    }
    let said = |task: &Task, words: &str| plain(&task.text) == plain(words);
    match (check.task, check.text.as_deref().map(str::trim).filter(|text| !text.is_empty())) {
        (Some(number), _) => {
            let at = tasks.get((number as usize).wrapping_sub(1));
            let Some(expected) = check.expected.as_deref() else {
                return at.ok_or_else(|| out_of_range(number, tasks.len()));
            };
            if let Some(task) = at.filter(|task| said(task, expected)) {
                return Ok(task);
            }
            let moved: Vec<&Task> = tasks.iter().filter(|task| said(task, expected)).collect();
            match moved.as_slice() {
                [task] => Ok(task),
                _ => Err((
                    FailureCode::Conflict,
                    "The task list changed since it was read, so that box is not where it was. Read it again and retry.".to_owned(),
                )),
            }
        }
        (None, Some(words)) => {
            let exact: Vec<&Task> = tasks.iter().filter(|task| said(task, words)).collect();
            let found = if exact.is_empty() {
                let words = plain(words);
                tasks.iter().filter(|task| plain(&task.text).contains(&words)).collect()
            } else {
                exact
            };
            match found.as_slice() {
                [task] => Ok(task),
                [] => Err((FailureCode::NotFound, format!("No box says \"{words}\"."))),
                many => Err((
                    FailureCode::Invalid,
                    format!(
                        "{} boxes say \"{words}\": {}. Give more of its text, or its number.",
                        many.len(),
                        many.iter().map(|task| format!("{} {}", task.number, task.text)).collect::<Vec<_>>().join("; ")
                    ),
                )),
            }
        }
        (None, None) => Err((FailureCode::Invalid, "Give the box's number (from 1), or words of its text.".to_owned())),
    }
}

fn out_of_range(number: u32, count: usize) -> (FailureCode, String) {
    let boxes = if count == 1 { "1 box".to_owned() } else { format!("{count} boxes") };
    (FailureCode::NotFound, format!("There is no box {number}: it has {boxes}, numbered from 1."))
}

/// Text as compared: lowercase, with runs of space as one.
fn plain(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boxes(body: &str) -> Vec<(u32, u32, &'static str, bool)> {
        task_list(body).into_iter().map(|task| (task.number, task.line, &*task.text.leak(), task.checked)).collect()
    }

    /// The cases `tasks.ts` is tested against too.
    #[test]
    fn the_fixtures() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../../../packages/contracts/src/tasks.fixtures.json")).unwrap();
        let lists = fixtures["lists"].as_array().unwrap();
        assert!(lists.len() > 10);
        for case in lists {
            let body = case["body"].as_str().unwrap();
            let want: Vec<Task> = serde_json::from_value(case["tasks"].clone()).unwrap();
            let got: Vec<Task> = task_list(body).into_iter().map(|task| Task { mark: 0, ..task }).collect();
            assert_eq!(got, want, "{body:?}");
        }
    }

    #[test]
    fn ticking_changes_only_the_box() {
        let body = "Steps:\r\n\r\n- [ ] one\r\n  - [X] two\r\n> 1. [ ] three\r\n";
        let tasks = task_list(body);
        assert_eq!(set_task(body, &tasks[0], true), "Steps:\r\n\r\n- [x] one\r\n  - [X] two\r\n> 1. [ ] three\r\n");
        assert_eq!(set_task(body, &tasks[1], false), "Steps:\r\n\r\n- [ ] one\r\n  - [ ] two\r\n> 1. [ ] three\r\n");
        assert_eq!(set_task(body, &tasks[2], true), "Steps:\r\n\r\n- [ ] one\r\n  - [X] two\r\n> 1. [x] three\r\n");
        // After text that is not ASCII, the byte offsets still hold.
        let body = "Café ☕\n- [ ] naïve ✓\n- [ ] après";
        let tasks = task_list(body);
        assert_eq!(set_task(body, &tasks[1], true), "Café ☕\n- [ ] naïve ✓\n- [x] après");
    }

    #[test]
    fn code_holds_no_boxes() {
        let body = "```md\n- [ ] example\n```\n- [ ] real\n~~~~\n- [ ] also an example\n~~~\n- [ ] still code\n~~~~\n> ```\n> - [ ] quoted code\n> ```\n";
        assert_eq!(boxes(body), [(1, 4, "real", false)]);
    }

    fn check(task: Option<u32>, text: Option<&str>, expected: Option<&str>) -> TaskCheck {
        TaskCheck { task, text: text.map(str::to_owned), checked: true, expected: expected.map(str::to_owned) }
    }

    #[test]
    fn picking_a_box() {
        let tasks = task_list("- [ ] Write the docs\n- [ ] Write the tests\n- [x] Ship it\n");
        let number = |picked: Result<&Task, (FailureCode, String)>| picked.map(|task| task.number).map_err(|(code, _)| code);
        assert_eq!(number(pick_task(&tasks, &check(Some(2), None, None))), Ok(2));
        assert_eq!(number(pick_task(&tasks, &check(Some(4), None, None))), Err(FailureCode::NotFound));
        assert_eq!(number(pick_task(&tasks, &check(Some(0), None, None))), Err(FailureCode::NotFound));
        assert_eq!(number(pick_task(&tasks, &check(None, Some("ship IT"), None))), Ok(3));
        assert_eq!(number(pick_task(&tasks, &check(None, Some("tests"), None))), Ok(2));
        assert_eq!(number(pick_task(&tasks, &check(None, Some("write"), None))), Err(FailureCode::Invalid));
        assert_eq!(number(pick_task(&tasks, &check(None, Some("deploy"), None))), Err(FailureCode::NotFound));
        assert_eq!(number(pick_task(&tasks, &check(None, None, None))), Err(FailureCode::Invalid));
        assert_eq!(number(pick_task(&[], &check(Some(1), None, None))), Err(FailureCode::NotFound));
        // The box read as 2 is still 2; one added above moved it to 3; one
        // that is gone, or now there twice, is a conflict.
        assert_eq!(number(pick_task(&tasks, &check(Some(2), None, Some("Write the tests")))), Ok(2));
        assert_eq!(number(pick_task(&tasks, &check(Some(2), None, Some("Ship it")))), Ok(3));
        assert_eq!(number(pick_task(&tasks, &check(Some(2), None, Some("Deploy")))), Err(FailureCode::Conflict));
        let twice = task_list("- [ ] a\n- [ ] b\n- [ ] b\n");
        assert_eq!(number(pick_task(&twice, &check(Some(1), None, Some("b")))), Err(FailureCode::Conflict));
    }

    #[test]
    fn a_check_reads_from_json() {
        let check: TaskCheck = serde_json::from_str(r#"{"task": 2}"#).unwrap();
        assert!(check.checked && check.task == Some(2));
        let args: CheckWorkItemTaskArgs = serde_json::from_value(serde_json::json!({
            "actor": { "id": "usr_1", "username": "ada" },
            "workspace": "acme",
            "number": 12,
            "text": "docs",
            "checked": false,
        }))
        .unwrap();
        assert_eq!(args.check.text.as_deref(), Some("docs"));
        assert!(!args.check.checked);
    }
}
