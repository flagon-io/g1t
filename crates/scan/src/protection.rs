//! Push protection: which lines a change adds, the secrets on them, and
//! what git is told when a push is refused for them.

use std::collections::HashSet;

use similar::{ChangeTag, TextDiff};

use crate::secrets::{self, ALLOW_MARKER, Hit, SecretKind};

/// Files larger than this are not read for secrets.
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;

/// The lines of `new` (numbered from 1) that are not in `old`.
pub fn added_lines(old: &str, new: &str) -> HashSet<u32> {
    let diff = TextDiff::from_lines(old, new);
    diff.iter_all_changes()
        .filter(|change| change.tag() == ChangeTag::Insert)
        .filter_map(|change| change.new_index().map(|index| index as u32 + 1))
        .collect()
}

/// Text worth scanning, or `None` for binary, oversized or skipped files.
pub fn text_of<'a>(path: &str, bytes: &'a [u8]) -> Option<&'a str> {
    if secrets::skipped_path(path) || bytes.len() > MAX_FILE_BYTES || bytes.contains(&0) {
        return None;
    }
    std::str::from_utf8(bytes).ok()
}

/// The secrets a change to one file adds: on its new lines only, so a
/// secret already in the repository (found and decided on before) does
/// not block every later push that touches the file.
pub fn scan_change(path: &str, old: Option<&[u8]>, new: &[u8]) -> Vec<Hit> {
    let Some(new) = text_of(path, new) else {
        return Vec::new();
    };
    match old.and_then(|old| std::str::from_utf8(old).ok()) {
        Some(old) => {
            let added = added_lines(old, new);
            secrets::scan_lines(new, |line| added.contains(&line))
        }
        None => secrets::scan_text(new),
    }
}

/// A secret that stops a push.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Blocked {
    pub kind: SecretKind,
    pub path: String,
    pub line: u32,
    /// The commit that adds it.
    pub commit: String,
    /// Where it can be allowed, once, by someone who may.
    pub allow_url: Option<String>,
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(7)]
}

/// The reason git prints beside each refused ref: one line.
pub fn reason(blocked: &[Blocked]) -> String {
    match blocked {
        [] => "refused".to_owned(),
        [only] => format!("secret found: {}:{} has {}", only.path, only.line, only.kind.label()),
        [first, rest @ ..] => format!(
            "{} secrets found, first {}:{} ({})",
            rest.len() + 1,
            first.path,
            first.line,
            first.kind.label()
        ),
    }
}

/// What git shows the person pushing, a line at a time, as `remote:`
/// lines: every secret, where it is, and both ways forward.
pub fn explain(blocked: &[Blocked]) -> Vec<String> {
    let count = blocked.len();
    let mut lines = vec![
        format!(
            "g1t found {} in this push, so nothing was pushed.",
            if count == 1 { "a secret".to_owned() } else { format!("{count} secrets") }
        ),
        String::new(),
    ];
    let width = blocked
        .iter()
        .map(|item| item.path.len() + item.line.to_string().len() + 1)
        .max()
        .unwrap_or(0);
    for item in blocked {
        let place = format!("{}:{}", item.path, item.line);
        lines.push(format!("  {place:<width$}  {}  (commit {})", item.kind.label(), short(&item.commit)));
    }
    lines.extend([
        String::new(),
        "Take the secret out of the commit that adds it (git commit --amend, or".to_owned(),
        "git rebase -i for an older commit), rotate it if it was ever real, and".to_owned(),
        "push again.".to_owned(),
        String::new(),
        "If it is not a real secret, such as a test fixture:".to_owned(),
        format!("  - add {ALLOW_MARKER} in a comment on its line, or"),
    ]);
    let links: Vec<&str> = blocked.iter().filter_map(|item| item.allow_url.as_deref()).collect();
    match links.as_slice() {
        [] => lines.push("  - ask a member of the workspace to allow it on the project's Security page.".to_owned()),
        [one] => {
            lines.push(format!("  - allow it once at {one}"));
        }
        many => {
            lines.push("  - allow each once:".to_owned());
            for link in many {
                lines.push(format!("      {link}"));
            }
        }
    }
    lines.push("    Allowing is recorded with your name, then the same push goes through.".to_owned());
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> String {
        format!("AK{}", "IAZ7Q4N2XWLM3KDTRV")
    }

    #[test]
    fn only_added_lines_count() {
        let old = format!("a\n{}\nb\n", key());
        let new = format!("a\n{}\nb\nc {}\n", key(), key());
        assert_eq!(added_lines(&old, &new), HashSet::from([4]));
        let hits = scan_change("src/app.ts", Some(old.as_bytes()), new.as_bytes());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 4);
        // A new file is scanned whole.
        assert_eq!(scan_change("src/app.ts", None, new.as_bytes()).len(), 2);
        // Binary files and lockfiles are not.
        assert!(scan_change("bin/tool", None, &[0, 1, 2]).is_empty());
        assert!(scan_change("package-lock.json", None, new.as_bytes()).is_empty());
    }

    #[test]
    fn the_refusal_names_the_file_line_kind_and_ways_forward() {
        let blocked = vec![Blocked {
            kind: SecretKind::AwsAccessKey,
            path: "config/prod.env".into(),
            line: 3,
            commit: "4807077b296e6edbf410d55e72749d3e1170c291".into(),
            allow_url: Some("https://g1t.sh/acme/rocket/security?finding=sec_1".into()),
        }];
        assert_eq!(reason(&blocked), "secret found: config/prod.env:3 has an AWS access key");
        let text = explain(&blocked).join("\n");
        assert!(text.starts_with("g1t found a secret in this push, so nothing was pushed."));
        assert!(text.contains("config/prod.env:3  an AWS access key  (commit 4807077)"));
        assert!(text.contains("g1t:allow-secret"));
        assert!(text.contains("allow it once at https://g1t.sh/acme/rocket/security?finding=sec_1"));
        assert!(text.contains("recorded with your name"));
    }

    #[test]
    fn several_secrets_are_listed_and_counted() {
        let item = |path: &str, line| Blocked {
            kind: SecretKind::GithubToken,
            path: path.into(),
            line,
            commit: "c71546fcd893".into(),
            allow_url: None,
        };
        let blocked = vec![item("a.env", 1), item("src/deep/b.ts", 12)];
        assert_eq!(reason(&blocked), "2 secrets found, first a.env:1 (a GitHub token)");
        let text = explain(&blocked);
        assert!(text[0].contains("2 secrets"));
        assert!(text.iter().any(|line| line == "  a.env:1           a GitHub token  (commit c71546f)"));
        assert!(text.iter().any(|line| line.contains("Security page")));
    }
}
