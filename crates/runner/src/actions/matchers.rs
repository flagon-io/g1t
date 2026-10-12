//! Problem matchers, as GitHub's runner has them. `::add-matcher::` reads a
//! JSON file of patterns (`actions/setup-node`, `setup-go` and
//! `setup-python` each add some), and from then on, for the rest of the
//! job, an output line they match becomes an annotation in place of the
//! line. A pattern can span lines, and the last one of several can `loop`
//! to match many issues after one header.

use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::{Map, Value};

/// One line's pattern, and which of its groups hold what.
#[derive(Debug)]
struct Pattern {
    regex: Regex,
    file: Option<usize>,
    line: Option<usize>,
    column: Option<usize>,
    severity: Option<usize>,
    code: Option<usize>,
    message: Option<usize>,
    from_path: Option<usize>,
    looping: bool,
}

/// What the lines matched so far say about an issue.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Found {
    pub(crate) file: Option<String>,
    pub(crate) line: Option<String>,
    pub(crate) column: Option<String>,
    pub(crate) severity: Option<String>,
    pub(crate) code: Option<String>,
    pub(crate) message: Option<String>,
    pub(crate) from_path: Option<String>,
}

impl Found {
    /// `running` with what `pattern` read from `caps` over it.
    fn read(running: Option<&Found>, pattern: &Pattern, caps: &regex::Captures) -> Found {
        let mut found = running.cloned().unwrap_or_default();
        let group = |index: Option<usize>, into: &mut Option<String>| {
            if let Some(index) = index {
                *into = caps.get(index).map(|m| m.as_str().to_owned());
            }
        };
        group(pattern.file, &mut found.file);
        group(pattern.line, &mut found.line);
        group(pattern.column, &mut found.column);
        group(pattern.severity, &mut found.severity);
        group(pattern.code, &mut found.code);
        group(pattern.message, &mut found.message);
        group(pattern.from_path, &mut found.from_path);
        found
    }
}

/// One matcher: its owner, the severity it gives by default, its patterns,
/// and how far into them the output has gone.
#[derive(Debug)]
pub(crate) struct Matcher {
    pub(crate) owner: String,
    severity: Option<String>,
    patterns: Vec<Pattern>,
    /// For each pattern but the last, what it matched on the line before.
    state: Vec<Option<Found>>,
}

impl Matcher {
    fn reset(&mut self) {
        self.state.iter_mut().for_each(|s| *s = None);
    }

    /// The issue `line` completes, if it does, as GitHub's runner reads one:
    /// a single pattern matches by itself; several are worked through from
    /// the last back, each needing the one before it to have matched the
    /// line before.
    pub(crate) fn matches(&mut self, line: &str) -> Option<Found> {
        let last = self.patterns.len() - 1;
        if last == 0 {
            let caps = self.patterns[0].regex.captures(line)?;
            return Some(self.with_default(Found::read(None, &self.patterns[0], &caps)));
        }
        for i in (0..=last).rev() {
            let running = if i > 0 { self.state[i - 1].clone() } else { None };
            if i > 0 && running.is_none() {
                continue;
            }
            let pattern = &self.patterns[i];
            match pattern.regex.captures(line) {
                Some(caps) if i == last => {
                    let found = Found::read(running.as_ref(), pattern, &caps);
                    let looping = pattern.looping;
                    self.reset();
                    // A loop keeps what led up to it, for the next line.
                    if looping {
                        self.state[i - 1] = running;
                    }
                    return Some(self.with_default(found));
                }
                Some(caps) => self.state[i] = Some(Found::read(running.as_ref(), pattern, &caps)),
                None if i == last => self.state[i - 1] = None,
                None => self.state[i] = None,
            }
        }
        None
    }

    fn with_default(&self, mut found: Found) -> Found {
        if found.severity.as_deref().is_none_or(str::is_empty) {
            found.severity = self.severity.clone();
        }
        found
    }
}

/// Reads a problem matcher file: `{"problemMatcher": [{"owner",
/// "severity"?, "pattern": [{"regexp", "file", "line", "column",
/// "severity", "code", "message", "fromPath", "loop"}]}]}`.
pub(crate) fn parse(text: &str) -> Result<Vec<Matcher>, String> {
    let config: Value = serde_json::from_str(text).map_err(|e| format!("The problem matcher file is not JSON: {e}"))?;
    let Some(list) = config.get("problemMatcher").and_then(Value::as_array) else {
        return Err("The problem matcher file has no `problemMatcher` list.".into());
    };
    list.iter().map(parse_matcher).collect()
}

fn parse_matcher(config: &Value) -> Result<Matcher, String> {
    let owner = config.get("owner").and_then(Value::as_str).filter(|o| !o.trim().is_empty()).ok_or("A problem matcher needs an `owner`.")?;
    let severity = config.get("severity").and_then(Value::as_str).map(str::to_owned);
    let patterns: Vec<&Value> = match config.get("pattern") {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(item @ Value::Object(_)) => vec![item],
        _ => Vec::new(),
    };
    if patterns.is_empty() {
        return Err(format!("The problem matcher `{owner}` has no patterns."));
    }
    let count = patterns.len();
    let mut read = Vec::new();
    for (index, pattern) in patterns.into_iter().enumerate() {
        let regexp = pattern.get("regexp").and_then(Value::as_str).filter(|r| !r.is_empty()).ok_or(format!("A pattern of `{owner}` needs a `regexp`."))?;
        let regex = Regex::new(regexp).map_err(|e| format!("A pattern of `{owner}` does not read: {e}"))?;
        let group = |key: &str| -> Result<Option<usize>, String> {
            match pattern.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(value) => value.as_u64().map(|n| Some(n as usize)).ok_or(format!("`{key}` in a pattern of `{owner}` must be a group's number.")),
            }
        };
        let looping = pattern.get("loop").and_then(Value::as_bool).unwrap_or(false);
        let read_pattern = Pattern {
            regex,
            file: group("file")?,
            line: group("line")?,
            column: group("column")?,
            severity: group("severity")?,
            code: group("code")?,
            message: group("message")?,
            from_path: group("fromPath")?,
            looping,
        };
        if looping && (count == 1 || index != count - 1) {
            return Err(format!("Only the last of several patterns may `loop` (`{owner}`)."));
        }
        if looping && read_pattern.message.is_none() {
            return Err(format!("The looping pattern of `{owner}` must set `message`."));
        }
        read.push(read_pattern);
    }
    if !read.iter().any(|p| p.message.is_some()) {
        return Err(format!("One of the patterns of `{owner}` must set `message`."));
    }
    Ok(Matcher { owner: owner.to_owned(), severity, state: vec![None; read.len() - 1], patterns: read })
}

/// An issue a matcher found: the annotation's level, its message, and its
/// `file`, `line`, `col` and `code`, as an `::error::` command's properties.
#[derive(Debug, PartialEq)]
pub(crate) struct Issue {
    pub(crate) level: &'static str,
    pub(crate) message: String,
    pub(crate) properties: Map<String, Value>,
}

/// The job's matchers, in the order they were added.
#[derive(Default)]
pub(crate) struct Matchers {
    list: Vec<Matcher>,
    /// Where relative files are read from: `github.workspace`.
    pub(crate) workspace: PathBuf,
}

impl Matchers {
    /// Adds matchers; one with an owner already here takes its place.
    pub(crate) fn add(&mut self, new: Vec<Matcher>) {
        for matcher in new {
            match self.list.iter_mut().find(|m| m.owner.eq_ignore_ascii_case(&matcher.owner)) {
                Some(old) => *old = matcher,
                None => self.list.push(matcher),
            }
        }
    }

    pub(crate) fn remove(&mut self, owner: &str) {
        self.list.retain(|m| !m.owner.eq_ignore_ascii_case(owner));
    }

    /// The issue `line` makes, if a matcher reads one in it. The first
    /// matcher to match has it, and the others start over.
    pub(crate) fn issue(&mut self, line: &str) -> Option<Issue> {
        if self.list.is_empty() {
            return None;
        }
        let line = strip_colors(line);
        for index in 0..self.list.len() {
            let Some(found) = self.list[index].matches(&line) else { continue };
            for (other, matcher) in self.list.iter_mut().enumerate() {
                if other != index {
                    matcher.reset();
                }
            }
            if let Some(issue) = to_issue(&found, &self.workspace) {
                return Some(issue);
            }
        }
        None
    }
}

/// `\x1b[…m` colour codes, which a matcher never sees.
fn strip_colors(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("\x1b[") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find(|c: char| !(c.is_ascii_digit() || c == ';'));
        match end {
            Some(end) if after[end..].starts_with('m') => rest = &after[end + 1..],
            _ => {
                out.push_str("\x1b[");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// What GitHub's runner makes of a match: nothing without a message or
/// with a severity other than error, warning or notice; a line and column
/// only when they are numbers; a file only when it is there, inside a
/// repository in the workspace, and then relative to that repository.
fn to_issue(found: &Found, workspace: &Path) -> Option<Issue> {
    let message = found.message.as_deref().filter(|m| !m.trim().is_empty())?;
    let level = match found.severity.as_deref().map(str::to_ascii_lowercase).as_deref() {
        None | Some("") | Some("error") => "error",
        Some("warning") => "warning",
        Some("notice") => "notice",
        Some(_) => return None,
    };
    let mut properties = Map::new();
    for (key, value) in [("line", &found.line), ("col", &found.column)] {
        if let Some(number) = value.as_deref().and_then(|v| v.trim().parse::<u32>().ok()) {
            properties.insert(key.into(), Value::String(number.to_string()));
        }
    }
    if let Some(code) = found.code.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        properties.insert("code".into(), Value::String(code.to_owned()));
    }
    if let Some(file) = found.file.as_deref().map(str::trim).filter(|f| !f.is_empty())
        && let Some(file) = repository_file(file, found.from_path.as_deref(), workspace)
    {
        properties.insert("file".into(), Value::String(file));
    }
    Some(Issue { level, message: message.to_owned(), properties })
}

/// `file` as a path inside its repository, if it is in one in the workspace.
fn repository_file(file: &str, from_path: Option<&str>, workspace: &Path) -> Option<String> {
    let mut path = PathBuf::from(file.replace('\\', "/"));
    if !path.is_absolute()
        && let Some(from) = from_path.map(Path::new).and_then(Path::parent).filter(|p| !p.as_os_str().is_empty())
    {
        path = from.join(path);
    }
    if !path.is_absolute() {
        path = workspace.join(path);
    }
    if !path.is_file() {
        return None;
    }
    let repository = path.ancestors().skip(1).take_while(|dir| dir.starts_with(workspace)).find(|dir| dir.join(".git").exists())?;
    let relative = path.strip_prefix(repository).ok()?;
    let parts: Vec<String> = relative.iter().map(|part| part.to_string_lossy().into_owned()).collect();
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// actions/setup-node's `tsc` matcher, as it ships.
    const TSC: &str = r#"{
        "problemMatcher": [{
            "owner": "tsc",
            "pattern": [{
                "regexp": "^([^\\s].*)[\\(:](\\d+)[,:](\\d+)(?:\\):\\s+|\\s+-\\s+)(error|warning|info)\\s+TS(\\d+)\\s*:\\s*(.*)$",
                "file": 1, "line": 2, "column": 3, "severity": 4, "code": 5, "message": 6
            }]
        }]
    }"#;

    /// actions/setup-node's `eslint-stylish`: a file, then its issues.
    const STYLISH: &str = r#"{
        "problemMatcher": [{
            "owner": "eslint-stylish",
            "pattern": [
                { "regexp": "^([^\\s].*)$", "file": 1 },
                { "regexp": "^\\s+(\\d+):(\\d+)\\s+(error|warning|info)\\s+(.*)\\s\\s+(.*)$", "line": 1, "column": 2, "severity": 3, "message": 4, "code": 5, "loop": true }
            ]
        }]
    }"#;

    #[test]
    fn a_single_pattern_reads_its_groups() {
        let mut matchers = parse(TSC).unwrap();
        assert_eq!(matchers[0].owner, "tsc");
        let found = matchers[0].matches("src/app.ts(12,5): error TS2322: Type 'string' is not assignable.").unwrap();
        assert_eq!(found.file.as_deref(), Some("src/app.ts"));
        assert_eq!(found.line.as_deref(), Some("12"));
        assert_eq!(found.column.as_deref(), Some("5"));
        assert_eq!(found.severity.as_deref(), Some("error"));
        assert_eq!(found.code.as_deref(), Some("2322"));
        assert_eq!(found.message.as_deref(), Some("Type 'string' is not assignable."));
        assert!(matchers[0].matches("Compiled successfully.").is_none());
    }

    #[test]
    fn several_patterns_span_lines_and_a_loop_goes_on() {
        let mut matcher = parse(STYLISH).unwrap().remove(0);
        assert!(matcher.matches("/w/src/a.js").is_none(), "the header alone is no issue");
        let first = matcher.matches("  1:10  error  'x' is defined but never used  no-unused-vars").unwrap();
        assert_eq!(first.file.as_deref(), Some("/w/src/a.js"));
        assert_eq!((first.line.as_deref(), first.column.as_deref()), (Some("1"), Some("10")));
        assert_eq!(first.code.as_deref(), Some("no-unused-vars"));
        // The loop keeps the file for the next issue.
        let second = matcher.matches("  3:1   warning  Unexpected console statement  no-console").unwrap();
        assert_eq!(second.file.as_deref(), Some("/w/src/a.js"));
        assert_eq!(second.severity.as_deref(), Some("warning"));
        // A line that is neither ends the run.
        assert!(matcher.matches("").is_none());
        assert!(matcher.matches("  4:1   error  Late  semi").is_none(), "no file is held after the run ended");
    }

    #[test]
    fn without_a_loop_each_issue_needs_its_header() {
        let config = r#"{"problemMatcher": [{"owner": "two", "severity": "warning", "pattern": [
            {"regexp": "^FILE (.*)$", "file": 1},
            {"regexp": "^MSG (.*)$", "message": 1}
        ]}]}"#;
        let mut matcher = parse(config).unwrap().remove(0);
        assert!(matcher.matches("MSG orphan").is_none());
        assert!(matcher.matches("FILE a.txt").is_none());
        let found = matcher.matches("MSG broke").unwrap();
        assert_eq!((found.file.as_deref(), found.message.as_deref()), (Some("a.txt"), Some("broke")));
        assert_eq!(found.severity.as_deref(), Some("warning"), "the matcher's own severity");
        assert!(matcher.matches("MSG again").is_none());
        // A line between header and message breaks the pair.
        matcher.matches("FILE b.txt");
        matcher.matches("something else");
        assert!(matcher.matches("MSG late").is_none());
    }

    #[test]
    fn bad_matchers_are_refused() {
        assert!(parse("not json").is_err());
        assert!(parse(r#"{"problemMatcher": [{"pattern": [{"regexp": "x", "message": 0}]}]}"#).unwrap_err().contains("owner"));
        assert!(parse(r#"{"problemMatcher": [{"owner": "a", "pattern": [{"regexp": "x"}]}]}"#).unwrap_err().contains("message"));
        assert!(parse(r#"{"problemMatcher": [{"owner": "a", "pattern": [{"regexp": "x", "message": 0, "loop": true}]}]}"#).unwrap_err().contains("loop"));
        assert!(parse(r#"{"problemMatcher": [{"owner": "a", "pattern": [{"regexp": "(", "message": 1}]}]}"#).is_err());
    }

    #[test]
    fn matchers_are_replaced_by_owner_and_removed() {
        let mut matchers = Matchers::default();
        matchers.add(parse(TSC).unwrap());
        matchers.add(parse(TSC).unwrap());
        assert_eq!(matchers.list.len(), 1);
        matchers.add(parse(STYLISH).unwrap());
        assert_eq!(matchers.list.len(), 2);
        matchers.remove("TSC");
        assert_eq!(matchers.list[0].owner, "eslint-stylish");
    }

    #[test]
    fn issues_carry_numbers_and_files_inside_the_repository() {
        let workspace = std::env::temp_dir().join(format!("g1t-matchers-{}", std::process::id()));
        std::fs::create_dir_all(workspace.join(".git")).unwrap();
        std::fs::create_dir_all(workspace.join("src")).unwrap();
        std::fs::write(workspace.join("src/app.ts"), "").unwrap();
        let mut matchers = Matchers { workspace: workspace.clone(), ..Matchers::default() };
        matchers.add(parse(TSC).unwrap());
        let issue = matchers.issue("\x1b[31msrc/app.ts(12,5): error TS2322: Bad.\x1b[0m").unwrap();
        assert_eq!(issue.level, "error");
        assert_eq!(issue.message, "Bad.");
        assert_eq!(issue.properties["file"], "src/app.ts");
        assert_eq!(issue.properties["line"], "12");
        assert_eq!(issue.properties["col"], "5");
        assert_eq!(issue.properties["code"], "2322");
        // A file that is not there is dropped; the issue stays.
        let issue = matchers.issue("gone.ts(1,1): warning TS1: Missing.").unwrap();
        assert_eq!(issue.level, "warning");
        assert!(!issue.properties.contains_key("file"));
        // An absolute path inside the workspace is made relative.
        let absolute = format!("{}(2,3): error TS9: Abs.", workspace.join("src/app.ts").display());
        assert_eq!(matchers.issue(&absolute).unwrap().properties["file"], "src/app.ts");
        // `info` is no annotation GitHub has.
        assert!(matchers.issue("src/app.ts(1,1): info TS1: Hint.").is_none());
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn colour_codes_are_stripped() {
        assert_eq!(strip_colors("\x1b[1;31merror\x1b[0m: x"), "error: x");
        assert_eq!(strip_colors("plain"), "plain");
        assert_eq!(strip_colors("\x1b[Kodd"), "\x1b[Kodd");
    }
}
