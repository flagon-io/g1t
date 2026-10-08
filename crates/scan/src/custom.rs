//! Custom patterns: secret formats a workspace or repository defines for
//! itself, as regular expressions, found alongside the built-in formats in
//! [`crate::secrets`] by push protection and history scans.
//!
//! A pattern is untrusted input that runs on every push, so it is compiled
//! with the `regex` crate, whose engines run in time linear in the text
//! (no backtracking, no look-around, no back-references), and within size
//! limits: [`MAX_PATTERN_CHARS`] of source, [`COMPILED_SIZE_LIMIT`] bytes
//! compiled. A pattern that matches the empty string is refused, as is one
//! that matches every test string meant to stay unmatched.

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::secrets::ALLOW_MARKER;

/// The longest pattern, and the longest before or after context, in
/// characters.
pub const MAX_PATTERN_CHARS: usize = 1_000;
/// What one compiled pattern may take, in bytes, for its program and for
/// its lazy DFA's cache each.
pub const COMPILED_SIZE_LIMIT: usize = 1 << 20;
/// How deeply a pattern may nest groups and repetitions.
pub const MAX_NEST: u32 = 50;
/// The most patterns one repository is scanned with: its own and its
/// workspace's together.
pub const MAX_PATTERNS: usize = 100;
/// Test strings a pattern keeps, and how long each may be.
pub const MAX_TEST_STRINGS: usize = 20;
pub const MAX_TEST_STRING_CHARS: usize = 2_000;
/// The longest secret a pattern can find: a longer match is cut here for
/// its fingerprint and preview, never stored whole.
pub const MAX_SECRET_CHARS: usize = 1_000;
/// Lines longer than this are skipped (minified code, data).
pub const MAX_LINE_CHARS: usize = 4_000;

/// What has to come before a secret when the pattern says nothing: the
/// start of the line or a character that is not a letter or digit.
pub const DEFAULT_BEFORE: &str = r"\A|[^0-9A-Za-z]";
/// And after it: the end of the line or the same.
pub const DEFAULT_AFTER: &str = r"\z|[^0-9A-Za-z]";

/// A pattern as it is stored and sent between services.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternSpec {
    /// `pat_…`.
    pub id: String,
    /// What people call it: "Acme internal API key".
    pub name: String,
    /// The secret's format.
    pub pattern: String,
    /// What must come right before it; [`DEFAULT_BEFORE`] when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    /// What must come right after it; [`DEFAULT_AFTER`] when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

/// A pattern ready to run.
#[derive(Clone, Debug)]
pub struct Compiled {
    pub id: String,
    pub name: String,
    regex: Regex,
}

/// A secret a custom pattern found on one line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CustomHit {
    pub pattern_id: String,
    pub pattern_name: String,
    /// From 1.
    pub line: u32,
    /// The secret itself: never stored or shown, as with built-in hits.
    pub value: String,
}

/// The kind custom findings are stored under; the pattern says which.
pub const KIND: &str = "custom_pattern";

impl CustomHit {
    pub fn fingerprint(&self) -> String {
        fingerprint(&self.pattern_id, &self.value)
    }

    /// The first quarter of the secret, three to eight characters.
    pub fn preview(&self) -> String {
        let chars: Vec<char> = self.value.chars().collect();
        let shown = (chars.len() / 4).clamp(3, 8).min(chars.len());
        format!("{}…", chars[..shown].iter().collect::<String>())
    }

    /// "Acme internal API key", as a sentence names it.
    pub fn label(&self) -> String {
        label(&self.pattern_name)
    }
}

/// How a sentence names a custom pattern's finding.
pub fn label(name: &str) -> String {
    format!("a match for the custom pattern \"{name}\"")
}

/// Names a secret a custom pattern found without holding it.
pub fn fingerprint(pattern_id: &str, value: &str) -> String {
    let digest = Sha256::digest(format!("custom:{pattern_id}:{value}").as_bytes());
    digest[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

fn checked(what: &str, source: &str) -> Result<(), String> {
    if source.trim().is_empty() {
        return Err(format!("The {what} is empty."));
    }
    if source.chars().count() > MAX_PATTERN_CHARS {
        return Err(format!("The {what} is longer than {MAX_PATTERN_CHARS} characters."));
    }
    Ok(())
}

fn build(source: &str) -> Result<Regex, String> {
    RegexBuilder::new(source)
        .size_limit(COMPILED_SIZE_LIMIT)
        .dfa_size_limit(COMPILED_SIZE_LIMIT)
        .nest_limit(MAX_NEST)
        .build()
        .map_err(|error| match error {
            regex::Error::CompiledTooBig(_) => "The pattern is too complex: simplify its repetitions.".to_owned(),
            regex::Error::Syntax(text) => {
                // The crate's message is several lines with a caret under
                // the problem; its last line says what is wrong.
                let last = text.lines().rev().find(|line| line.starts_with("error:")).unwrap_or(&text);
                format!("The pattern is not a valid regular expression: {}", last.trim_start_matches("error:").trim())
            }
            other => format!("The pattern could not be compiled: {other}"),
        })
}

/// Compiles a pattern, or says what is wrong with it.
pub fn compile(spec: &PatternSpec) -> Result<Compiled, String> {
    checked("pattern", &spec.pattern)?;
    if spec.name.trim().is_empty() {
        return Err("Give the pattern a name.".to_owned());
    }
    // Each part is compiled alone first, so an error names the right one.
    build(&spec.pattern)?;
    let before = spec.before.as_deref().filter(|text| !text.trim().is_empty());
    let after = spec.after.as_deref().filter(|text| !text.trim().is_empty());
    if let Some(before) = before {
        checked("text before the secret", before)?;
        build(before).map_err(|error| error.replace("The pattern", "The text before the secret"))?;
    }
    if let Some(after) = after {
        checked("text after the secret", after)?;
        build(after).map_err(|error| error.replace("The pattern", "The text after the secret"))?;
    }
    let pattern = Regex::new(&spec.pattern).map_err(|error| error.to_string())?;
    if pattern.is_match("") {
        return Err("The pattern matches an empty string, so it would match everywhere.".to_owned());
    }
    let combined = format!(
        "(?:{})(?P<secret>{})(?:{})",
        before.unwrap_or(DEFAULT_BEFORE),
        spec.pattern,
        after.unwrap_or(DEFAULT_AFTER)
    );
    Ok(Compiled { id: spec.id.clone(), name: spec.name.trim().to_owned(), regex: build(&combined)? })
}

/// Compiles every pattern that compiles; one that no longer does (it was
/// saved under other limits) is skipped rather than failing a push.
pub fn compile_all(specs: &[PatternSpec]) -> Vec<Compiled> {
    specs.iter().take(MAX_PATTERNS).filter_map(|spec| compile(spec).ok()).collect()
}

impl Compiled {
    /// The secrets on one line: the `secret` group of each match.
    pub fn find(&self, line: &str) -> Vec<String> {
        if line.len() > MAX_LINE_CHARS {
            return Vec::new();
        }
        self.regex
            .captures_iter(line)
            .filter_map(|captures| captures.name("secret"))
            .map(|found| found.as_str().chars().take(MAX_SECRET_CHARS).collect::<String>())
            .filter(|value| !value.is_empty())
            .collect()
    }
}

/// Every secret the patterns find in `text`, on the lines `wanted` accepts
/// (numbered from 1). A line with [`ALLOW_MARKER`] is skipped, as it is for
/// the built-in formats.
pub fn scan_lines(text: &str, patterns: &[Compiled], wanted: impl Fn(u32) -> bool) -> Vec<CustomHit> {
    let mut hits = Vec::new();
    if patterns.is_empty() {
        return hits;
    }
    for (index, line) in text.lines().enumerate() {
        let number = index as u32 + 1;
        if !wanted(number) || line.contains(ALLOW_MARKER) {
            continue;
        }
        for pattern in patterns {
            for value in pattern.find(line) {
                if hits.iter().any(|hit: &CustomHit| hit.line == number && hit.value == value) {
                    continue;
                }
                hits.push(CustomHit { pattern_id: pattern.id.clone(), pattern_name: pattern.name.clone(), line: number, value });
            }
        }
    }
    hits
}

/// Where a pattern matched a test string: the match's start and end, in
/// characters, or `None`.
pub fn test(compiled: &Compiled, strings: &[String]) -> Vec<Option<(usize, usize)>> {
    strings
        .iter()
        .map(|text| {
            compiled.regex.captures(text).and_then(|captures| captures.name("secret")).map(|found| {
                let start = text[..found.start()].chars().count();
                (start, start + found.as_str().chars().count())
            })
        })
        .collect()
}

/// Cleans the test strings a person typed: trimmed of blank ones, at most
/// [`MAX_TEST_STRINGS`] of at most [`MAX_TEST_STRING_CHARS`] each.
pub fn clean_test_strings(strings: &[String]) -> Result<Vec<String>, String> {
    let kept: Vec<String> = strings.iter().filter(|text| !text.trim().is_empty()).cloned().collect();
    if kept.len() > MAX_TEST_STRINGS {
        return Err(format!("Keep at most {MAX_TEST_STRINGS} test strings."));
    }
    if kept.iter().any(|text| text.chars().count() > MAX_TEST_STRING_CHARS) {
        return Err(format!("A test string is longer than {MAX_TEST_STRING_CHARS} characters."));
    }
    Ok(kept)
}

/// A preview of a match, as a dry run shows it: the line with the secret
/// masked but for its first characters, cut to 160 characters around it.
pub fn masked_line(line: &str, value: &str) -> String {
    let shown: String = value.chars().take((value.chars().count() / 4).clamp(3, 8)).collect();
    let masked = format!("{shown}{}", "•".repeat(value.chars().count().saturating_sub(shown.chars().count()).min(24)));
    let replaced = line.replacen(value, &masked, 1);
    let trimmed = replaced.trim();
    if trimmed.chars().count() <= 160 {
        return trimmed.to_owned();
    }
    let at = trimmed.find(&masked).map(|at| trimmed[..at].chars().count()).unwrap_or(0);
    let start = at.saturating_sub(60);
    let cut: String = trimmed.chars().skip(start).take(160).collect();
    format!("{}{cut}…", if start > 0 { "…" } else { "" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(pattern: &str) -> PatternSpec {
        PatternSpec { id: "pat_1".into(), name: "Acme key".into(), pattern: pattern.into(), before: None, after: None }
    }

    #[test]
    fn a_pattern_finds_its_secret_between_boundaries() {
        let compiled = compile(&spec(r"acme_[a-z0-9]{24}")).unwrap();
        let text = "a = 1\nKEY=acme_0123456789abcdefghijklmn\nxacme_0123456789abcdefghijklmn\n";
        let hits = scan_lines(text, std::slice::from_ref(&compiled), |_| true);
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0].line, hits[0].value.as_str()), (2, "acme_0123456789abcdefghijklmn"));
        assert_eq!(hits[0].preview(), "acme_01…");
        assert_eq!(hits[0].fingerprint(), fingerprint("pat_1", "acme_0123456789abcdefghijklmn"));
        assert_ne!(hits[0].fingerprint(), fingerprint("pat_2", "acme_0123456789abcdefghijklmn"));
        // Only wanted lines, and never a line marked allowed.
        assert!(scan_lines(text, std::slice::from_ref(&compiled), |line| line != 2).is_empty());
        let allowed = "KEY=acme_0123456789abcdefghijklmn # g1t:allow-secret";
        assert!(scan_lines(allowed, &[compiled], |_| true).is_empty());
    }

    #[test]
    fn before_and_after_context_narrow_a_match() {
        let mut with_context = spec(r"[A-Z0-9]{20}");
        with_context.before = Some(r#"ACME_TOKEN\s*=\s*""#.into());
        with_context.after = Some("\"".into());
        let compiled = compile(&with_context).unwrap();
        assert_eq!(compiled.find(r#"ACME_TOKEN = "ABCDEFGHIJ0123456789""#), ["ABCDEFGHIJ0123456789"]);
        assert!(compiled.find(r#"OTHER = "ABCDEFGHIJ0123456789""#).is_empty());
        let results = test(&compiled, &[r#"ACME_TOKEN="ABCDEFGHIJ0123456789""#.into(), "nothing".into()]);
        assert_eq!(results, [Some((12, 32)), None]);
    }

    #[test]
    fn bad_and_dangerous_patterns_are_refused() {
        assert!(compile(&spec("")).unwrap_err().contains("empty"));
        assert!(compile(&spec("(unclosed")).unwrap_err().starts_with("The pattern is not a valid regular expression"));
        assert!(compile(&spec("a*")).unwrap_err().contains("empty string"));
        // Look-around and back-references, which need backtracking, do
        // not exist in this engine.
        assert!(compile(&spec(r"(?=x)abc")).is_err());
        assert!(compile(&spec(r"(a)\1")).is_err());
        assert!(compile(&spec(&"a".repeat(MAX_PATTERN_CHARS + 1))).unwrap_err().contains("longer than"));
        // A pattern whose compiled program would be enormous.
        assert!(compile(&spec(r"\w{1000}\w{1000}\w{1000}")).unwrap_err().contains("too complex"));
        let mut unnamed = spec("abc");
        unnamed.name = " ".into();
        assert!(compile(&unnamed).is_err());
        let mut bad_after = spec("abc");
        bad_after.after = Some("[".into());
        assert!(compile(&bad_after).unwrap_err().starts_with("The text after the secret"));
    }

    #[test]
    fn a_pattern_that_used_to_explode_runs_in_linear_time() {
        // `(a+)+$` takes exponential time in a backtracking engine on a
        // run of a's that ends in something else; here it is linear.
        let compiled = compile(&spec(r"(a+)+b")).unwrap();
        let line = format!("{}c", "a".repeat(MAX_LINE_CHARS - 1));
        let started = std::time::Instant::now();
        assert!(compiled.find(&line).is_empty());
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        // Lines past the limit are skipped outright.
        assert!(compiled.find(&format!("{}b", "a".repeat(MAX_LINE_CHARS + 1))).is_empty());
    }

    #[test]
    fn patterns_that_no_longer_compile_are_skipped() {
        let specs = vec![spec("acme_[0-9]{8}"), spec("("), spec("x+")];
        assert_eq!(compile_all(&specs).len(), 2);
    }

    #[test]
    fn test_strings_are_limited() {
        assert_eq!(clean_test_strings(&["a".into(), " ".into()]).unwrap(), ["a"]);
        assert!(clean_test_strings(&vec!["a".to_owned(); MAX_TEST_STRINGS + 1]).is_err());
        assert!(clean_test_strings(&["a".repeat(MAX_TEST_STRING_CHARS + 1)]).is_err());
    }

    #[test]
    fn a_dry_run_masks_what_it_found() {
        let line = "const key = 'acme_0123456789abcdefghijklmn';";
        let masked = masked_line(line, "acme_0123456789abcdefghijklmn");
        assert!(masked.starts_with("const key = 'acme_01•") && !masked.contains("abcdefghijklmn"));
        let long = format!("{} acme_0123456789abcdefghijklmn {}", "x".repeat(300), "y".repeat(300));
        let cut = masked_line(&long, "acme_0123456789abcdefghijklmn");
        assert!(cut.starts_with('…') && cut.ends_with('…') && cut.contains("acme_01•"));
    }
}
