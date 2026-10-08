//! Code scanning results in SARIF 2.1.0, the format static analysis tools
//! write: reading an upload (gzipped, base64-encoded JSON), turning each
//! result into an alert with its rule, severity, message and location, and
//! fingerprinting it so the same problem found by the next run is the same
//! alert, and one no longer reported is fixed.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::osv::Severity;

/// The largest upload, gzipped and base64-encoded.
pub const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
/// The largest SARIF document once unzipped.
pub const MAX_SARIF_BYTES: usize = 40 * 1024 * 1024;
/// Runs one upload may hold.
pub const MAX_RUNS: usize = 20;
/// Results kept from one upload; the rest are counted and dropped.
pub const MAX_RESULTS: usize = 5_000;
/// The longest message kept.
const MAX_MESSAGE_CHARS: usize = 2_000;

/// How a tool rates a result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Level {
    None,
    Note,
    Warning,
    Error,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warning => "warning",
            Level::Note => "note",
            Level::None => "none",
        }
    }

    pub fn parse(text: &str) -> Option<Level> {
        Some(match text {
            "error" => Level::Error,
            "warning" => Level::Warning,
            "note" => Level::Note,
            "none" => Level::None,
            _ => return None,
        })
    }
}

/// Where a result is.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Location {
    /// From the repository's root.
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub start_column: Option<u32>,
    pub end_column: Option<u32>,
}

/// One result, ready to be an alert.
#[derive(Clone, Debug, PartialEq)]
pub struct Finding {
    pub rule_id: String,
    pub rule_name: Option<String>,
    pub rule_description: Option<String>,
    /// Help for the rule, as markdown or text.
    pub help: Option<String>,
    pub help_uri: Option<String>,
    pub tags: Vec<String>,
    pub level: Level,
    /// From the rule's `security-severity` score, for security rules.
    pub security_severity: Option<Severity>,
    pub message: String,
    /// The primary location; absent for results about the whole project.
    pub location: Option<Location>,
    /// Names this result across runs (see [`fingerprint`]).
    pub fingerprint: String,
}

impl Finding {
    /// The severity people sort by: the security severity when the rule has
    /// one, else the level (error high, warning medium, note low).
    pub fn severity(&self) -> Severity {
        self.security_severity.unwrap_or(match self.level {
            Level::Error => Severity::High,
            Level::Warning => Severity::Medium,
            Level::Note => Severity::Low,
            Level::None => Severity::Unknown,
        })
    }
}

/// One run of one tool.
#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    pub tool: String,
    pub tool_version: Option<String>,
    /// Which analysis this is, when a repository runs several of one tool
    /// (one per language, say): from the upload, or the run's
    /// `automationDetails.id` up to its last `/`, or the tool's name.
    pub category: String,
    pub findings: Vec<Finding>,
    /// Results past [`MAX_RESULTS`], not kept.
    pub dropped: usize,
}

/// What reading an upload can find wrong, in words for the person.
pub type Problem = String;

/// Decodes standard base64, ignoring line breaks.
pub fn base64_decode(text: &str) -> Result<Vec<u8>, Problem> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return Err("The sarif field is not base64.".to_owned()),
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Ok(out)
}

/// Unzips a gzip stream (RFC 1952) of one member, up to `limit` bytes.
pub fn gunzip(bytes: &[u8], limit: usize) -> Result<Vec<u8>, Problem> {
    const FEXTRA: u8 = 4;
    const FNAME: u8 = 8;
    const FCOMMENT: u8 = 16;
    const FHCRC: u8 = 2;
    if bytes.len() < 18 || bytes[0] != 0x1f || bytes[1] != 0x8b || bytes[2] != 8 {
        return Err("The sarif field is not gzipped.".to_owned());
    }
    let flags = bytes[3];
    let mut at = 10;
    let truncated = || "The gzipped SARIF is truncated.".to_owned();
    if flags & FEXTRA != 0 {
        let length = usize::from(u16::from_le_bytes([*bytes.get(at).ok_or_else(truncated)?, *bytes.get(at + 1).ok_or_else(truncated)?]));
        at += 2 + length;
    }
    for flag in [FNAME, FCOMMENT] {
        if flags & flag != 0 {
            let end = bytes.get(at..).and_then(|rest| rest.iter().position(|b| *b == 0)).ok_or_else(truncated)?;
            at += end + 1;
        }
    }
    if flags & FHCRC != 0 {
        at += 2;
    }
    let body = bytes.get(at..bytes.len().saturating_sub(8)).ok_or_else(truncated)?;
    miniz_oxide::inflate::decompress_to_vec_with_limit(body, limit).map_err(|error| match error.status {
        miniz_oxide::inflate::TINFLStatus::HasMoreOutput => {
            format!("The SARIF is larger than {} MB unzipped.", limit / (1024 * 1024))
        }
        _ => "The gzipped SARIF could not be unzipped.".to_owned(),
    })
}

/// The SARIF document an upload carries: `sarif` is gzipped and base64
/// encoded, as uploads conventionally are. Plain base64 JSON is accepted
/// too.
pub fn decode_upload(sarif: &str) -> Result<String, Problem> {
    if sarif.len() > MAX_UPLOAD_BYTES {
        return Err(format!("The upload is larger than {} MB.", MAX_UPLOAD_BYTES / (1024 * 1024)));
    }
    let bytes = base64_decode(sarif.trim())?;
    let json = if bytes.starts_with(&[0x1f, 0x8b]) {
        gunzip(&bytes, MAX_SARIF_BYTES)?
    } else if bytes.len() > MAX_SARIF_BYTES {
        return Err(format!("The SARIF is larger than {} MB.", MAX_SARIF_BYTES / (1024 * 1024)));
    } else {
        bytes
    };
    String::from_utf8(json).map_err(|_| "The SARIF is not UTF-8 text.".to_owned())
}

fn text_of(value: &Value) -> Option<String> {
    value.get("text").and_then(Value::as_str).map(str::to_owned)
}

/// A message with `{0}`-style placeholders filled from its arguments.
fn fill(template: &str, arguments: &[Value]) -> String {
    let mut out = template.to_owned();
    for (index, argument) in arguments.iter().enumerate() {
        let value = argument.as_str().map(str::to_owned).unwrap_or_else(|| argument.to_string());
        out = out.replace(&format!("{{{index}}}"), &value);
    }
    out
}

/// Percent-decoding for a URI's path.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%'
            && let Some(hex) = text.get(at + 1..at + 3)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            at += 3;
            continue;
        }
        out.push(bytes[at]);
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A result's file, from the repository's root: a `file://` URI under the
/// checkout (`checkout`, or the run's `%SRCROOT%`) loses that prefix, and
/// a relative one its leading `./`.
pub fn repository_path(uri: &str, roots: &[String]) -> String {
    let mut path = percent_decode(uri);
    if let Some(rest) = path.strip_prefix("file://") {
        path = rest.to_owned();
    }
    for root in roots {
        let root = percent_decode(root.strip_prefix("file://").unwrap_or(root));
        let root = root.trim_end_matches('/');
        if !root.is_empty() && let Some(rest) = path.strip_prefix(root) {
            path = rest.to_owned();
            break;
        }
    }
    path.trim_start_matches("./").trim_start_matches('/').replace('\\', "/")
}

/// Names a result across runs. A tool's own `primaryLocationLineHash` (or
/// another partial fingerprint) is used when it gives one, since it
/// survives lines moving; otherwise the rule, file and the code it points
/// at (or its message), so editing elsewhere in the file does not make it a
/// new alert. `occurrence` tells apart identical results in one file.
pub fn fingerprint(tool: &str, rule: &str, path: &str, partial: Option<&str>, content: &str, occurrence: usize) -> String {
    let basis = match partial {
        Some(partial) => format!("{tool}\n{rule}\n{path}\npartial:{partial}"),
        None => format!("{tool}\n{rule}\n{path}\ncontent:{}\n{occurrence}", content.split_whitespace().collect::<Vec<_>>().join(" ")),
    };
    let digest = Sha256::digest(basis.as_bytes());
    digest[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The rules of a tool component, by id and by index.
struct Rules<'a> {
    list: Vec<&'a Value>,
    by_id: HashMap<&'a str, &'a Value>,
}

impl<'a> Rules<'a> {
    fn of(component: &'a Value) -> Rules<'a> {
        let list: Vec<&Value> = component["rules"].as_array().map(|rules| rules.iter().collect()).unwrap_or_default();
        let by_id = list.iter().filter_map(|rule| Some((rule["id"].as_str()?, *rule))).collect();
        Rules { list, by_id }
    }
}

/// The `security-severity` a rule's properties give, as a severity.
fn security_severity(rule: Option<&Value>) -> Option<Severity> {
    let raw = &rule?["properties"]["security-severity"];
    let score = raw.as_f64().or_else(|| raw.as_str()?.trim().parse().ok())?;
    Some(Severity::from_score(score)).filter(|severity| *severity != Severity::Unknown)
}

/// Reads a SARIF 2.1.0 document into its runs. `category` and `checkout`
/// come from the upload, when it gives them.
pub fn parse(text: &str, category: Option<&str>, checkout: Option<&str>) -> Result<Vec<Run>, Problem> {
    let document: Value = serde_json::from_str(text).map_err(|error| format!("The SARIF is not valid JSON: {error}"))?;
    let version = document["version"].as_str().unwrap_or_default();
    if version != "2.1.0" {
        return Err(format!("Only SARIF 2.1.0 is read; this document says {}.", if version.is_empty() { "no version" } else { version }));
    }
    let runs = document["runs"].as_array().ok_or("The SARIF has no runs.")?;
    if runs.len() > MAX_RUNS {
        return Err(format!("The SARIF has {} runs; at most {MAX_RUNS} are read per upload.", runs.len()));
    }
    let mut out = Vec::new();
    let mut kept = 0usize;
    for run in runs {
        let driver = &run["tool"]["driver"];
        let tool = driver["name"].as_str().filter(|name| !name.trim().is_empty()).ok_or("A run names no tool.")?.trim().to_owned();
        let tool_version = driver["semanticVersion"].as_str().or(driver["version"].as_str()).map(str::to_owned);
        let category = category
            .map(str::to_owned)
            .filter(|category| !category.trim().is_empty())
            .or_else(|| {
                let id = run["automationDetails"]["id"].as_str()?;
                // `category/run-id`: the category is what precedes the last slash.
                id.rsplit_once('/').map(|(category, _)| category.to_owned()).filter(|category| !category.is_empty())
            })
            .unwrap_or_else(|| tool.clone());
        let mut roots: Vec<String> = Vec::new();
        if let Some(checkout) = checkout {
            roots.push(checkout.to_owned());
        }
        if let Some(bases) = run["originalUriBaseIds"].as_object() {
            roots.extend(bases.values().filter_map(|base| base["uri"].as_str().map(str::to_owned)));
        }
        let driver_rules = Rules::of(driver);
        let extensions: Vec<Rules> = run["tool"]["extensions"].as_array().map(|list| list.iter().map(Rules::of).collect()).unwrap_or_default();
        let mut findings = Vec::new();
        let mut dropped = 0usize;
        let mut occurrences: HashMap<(String, String, String), usize> = HashMap::new();
        for result in run["results"].as_array().into_iter().flatten() {
            if kept >= MAX_RESULTS {
                dropped += 1;
                continue;
            }
            // Suppressed results (in the source, or accepted) are not alerts.
            if result["suppressions"].as_array().is_some_and(|list| {
                list.iter().any(|suppression| suppression["status"].as_str().is_none_or(|status| status == "accepted"))
            }) {
                continue;
            }
            let rules = match result["rule"]["toolComponent"]["index"].as_u64() {
                Some(index) => extensions.get(index as usize).unwrap_or(&driver_rules),
                None => &driver_rules,
            };
            let rule_id = result["ruleId"].as_str().or(result["rule"]["id"].as_str());
            let rule = result["ruleIndex"]
                .as_u64()
                .or(result["rule"]["index"].as_u64())
                .and_then(|index| rules.list.get(index as usize).copied())
                .or_else(|| rule_id.and_then(|id| rules.by_id.get(id).copied()));
            let Some(rule_id) = rule_id.or_else(|| rule?["id"].as_str()) else { continue };
            let level = result["level"]
                .as_str()
                .and_then(Level::parse)
                .or_else(|| rule?["defaultConfiguration"]["level"].as_str().and_then(Level::parse))
                .unwrap_or(Level::Warning);
            let message = {
                let arguments: Vec<Value> = result["message"]["arguments"].as_array().cloned().unwrap_or_default();
                let template = text_of(&result["message"]).or_else(|| {
                    let id = result["message"]["id"].as_str()?;
                    text_of(&rule?["messageStrings"][id])
                });
                let text = template.map(|template| fill(&template, &arguments)).unwrap_or_else(|| rule_id.to_owned());
                text.chars().take(MAX_MESSAGE_CHARS).collect::<String>()
            };
            let physical = &result["locations"][0]["physicalLocation"];
            let location = physical["artifactLocation"]["uri"].as_str().map(|uri| {
                let region = &physical["region"];
                let start_line = region["startLine"].as_u64().unwrap_or(1).max(1) as u32;
                Location {
                    path: repository_path(uri, &roots),
                    start_line,
                    end_line: region["endLine"].as_u64().map_or(start_line, |line| (line as u32).max(start_line)),
                    start_column: region["startColumn"].as_u64().map(|c| c as u32),
                    end_column: region["endColumn"].as_u64().map(|c| c as u32),
                }
            });
            let partial = result["partialFingerprints"]
                .as_object()
                .and_then(|partial| {
                    partial
                        .get("primaryLocationLineHash")
                        .or_else(|| partial.iter().min_by_key(|(key, _)| key.as_str()).map(|(_, value)| value))
                })
                .or_else(|| result["fingerprints"].as_object().and_then(|all| all.iter().min_by_key(|(key, _)| key.as_str()).map(|(_, v)| v)))
                .and_then(Value::as_str)
                // Some tools fill these with a placeholder ("requires
                // login"); only a hash-like value names a result.
                .filter(|value| value.len() >= 8 && !value.contains(char::is_whitespace));
            let path = location.as_ref().map_or("", |location| location.path.as_str());
            let content = physical["region"]["snippet"]["text"].as_str().unwrap_or(&message).to_owned();
            let occurrence = {
                let count = occurrences.entry((rule_id.to_owned(), path.to_owned(), content.clone())).or_insert(0);
                *count += 1;
                *count
            };
            let description = rule.and_then(|rule| text_of(&rule["shortDescription"]).or_else(|| text_of(&rule["fullDescription"])));
            findings.push(Finding {
                fingerprint: fingerprint(&tool, rule_id, path, partial, &content, occurrence),
                rule_id: rule_id.to_owned(),
                rule_name: rule.and_then(|rule| rule["name"].as_str().map(str::to_owned)),
                rule_description: description,
                help: rule.and_then(|rule| rule["help"]["markdown"].as_str().or(rule["help"]["text"].as_str()).map(str::to_owned)),
                help_uri: rule.and_then(|rule| rule["helpUri"].as_str().map(str::to_owned)),
                tags: rule
                    .and_then(|rule| rule["properties"]["tags"].as_array())
                    .map(|tags| tags.iter().filter_map(|tag| tag.as_str().map(str::to_owned)).collect())
                    .unwrap_or_default(),
                security_severity: security_severity(rule),
                level,
                message,
                location,
            });
            kept += 1;
        }
        out.push(Run { tool, tool_version, category, findings, dropped });
    }
    Ok(out)
}

/// What an analysis on the default branch does to the alerts of its tool
/// and category: fingerprints of results not seen before (new alerts),
/// and of open alerts it no longer reports (fixed).
pub fn reconcile(open: &BTreeSet<String>, found: &[Finding]) -> (Vec<String>, Vec<String>) {
    let now: BTreeSet<&str> = found.iter().map(|finding| finding.fingerprint.as_str()).collect();
    let new = now.iter().filter(|fingerprint| !open.contains(**fingerprint)).map(|f| (*f).to_owned()).collect();
    let fixed = open.iter().filter(|fingerprint| !now.contains(fingerprint.as_str())).cloned().collect();
    (new, fixed)
}

/// The threshold a pull request's code scanning check fails at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// Never fails.
    None,
    /// Fails on results the tool calls errors.
    Errors,
    /// Fails on security results of this severity or worse, and on errors.
    AtLeast(Severity),
}

impl Gate {
    pub fn as_str(self) -> &'static str {
        match self {
            Gate::None => "none",
            Gate::Errors => "errors",
            Gate::AtLeast(Severity::Critical) => "critical",
            Gate::AtLeast(Severity::High) => "high",
            Gate::AtLeast(Severity::Medium) => "medium",
            Gate::AtLeast(_) => "any",
        }
    }

    pub fn parse(text: &str) -> Option<Gate> {
        Some(match text {
            "none" => Gate::None,
            "errors" => Gate::Errors,
            "critical" => Gate::AtLeast(Severity::Critical),
            "high" => Gate::AtLeast(Severity::High),
            "medium" => Gate::AtLeast(Severity::Medium),
            "any" => Gate::AtLeast(Severity::Low),
            _ => return None,
        })
    }

    /// Whether a new result fails the check.
    pub fn fails(self, finding: &Finding) -> bool {
        match self {
            Gate::None => false,
            Gate::Errors => finding.level == Level::Error,
            Gate::AtLeast(threshold) => {
                finding.level == Level::Error || finding.security_severity.is_some_and(|severity| severity >= threshold)
            }
        }
    }
}

/// Results on a pull request: those whose fingerprint the default branch
/// already has open are existing; the others are new, and only new ones
/// fail the check. Returns (new, existing).
pub fn split_new<'a>(found: &'a [Finding], on_default: &BTreeSet<String>) -> (Vec<&'a Finding>, Vec<&'a Finding>) {
    found.iter().partition(|finding| !on_default.contains(&finding.fingerprint))
}

/// The lines a diff adds, per file, from a unified diff's hunk headers and
/// lines. Results on these lines are the pull request's own.
pub fn added_lines(diff: &str) -> BTreeMap<String, BTreeSet<u32>> {
    let mut out: BTreeMap<String, BTreeSet<u32>> = BTreeMap::new();
    let mut file: Option<String> = None;
    let mut line = 0u32;
    for text in diff.lines() {
        if let Some(path) = text.strip_prefix("+++ ") {
            file = path.strip_prefix("b/").or(Some(path)).filter(|path| *path != "/dev/null").map(str::to_owned);
            continue;
        }
        if text.starts_with("--- ") {
            continue;
        }
        if let Some(header) = text.strip_prefix("@@ ") {
            // `@@ -a,b +c,d @@`
            line = header
                .split_whitespace()
                .find_map(|part| part.strip_prefix('+'))
                .and_then(|range| range.split(',').next()?.parse().ok())
                .unwrap_or(1);
            continue;
        }
        let Some(path) = &file else { continue };
        if text.starts_with('+') {
            out.entry(path.clone()).or_default().insert(line);
            line += 1;
        } else if text.starts_with(' ') {
            line += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEMGREP: &str = include_str!("../fixtures/semgrep.sarif");
    const ESLINT: &str = include_str!("../fixtures/eslint.sarif");
    const CODEQL: &str = include_str!("../fixtures/codeql.sarif");

    #[test]
    fn semgrep_results_become_findings() {
        let runs = parse(SEMGREP, None, None).unwrap();
        assert_eq!(runs.len(), 1);
        let run = &runs[0];
        assert_eq!(run.tool, "Semgrep OSS");
        assert_eq!(run.category, "Semgrep OSS");
        assert!(!run.findings.is_empty());
        let first = &run.findings[0];
        let location = first.location.as_ref().unwrap();
        assert!(!location.path.starts_with('/') && !location.path.starts_with("file:"));
        assert!(location.start_line >= 1);
        assert!(first.rule_id.contains('.'), "semgrep rule ids are dotted: {}", first.rule_id);
        assert_eq!(first.fingerprint.len(), 32);
    }

    #[test]
    fn eslint_results_use_rule_indexes_and_levels() {
        let runs = parse(ESLINT, None, Some("file:///home/runner/work/app/app")).unwrap();
        let run = &runs[0];
        assert_eq!(run.tool, "ESLint");
        assert!(run.findings.iter().any(|finding| finding.level == Level::Error));
        for finding in &run.findings {
            let path = &finding.location.as_ref().unwrap().path;
            assert!(!path.contains("home/runner"), "the checkout is cut off: {path}");
        }
    }

    #[test]
    fn codeql_security_severity_and_partial_fingerprints() {
        let runs = parse(CODEQL, None, None).unwrap();
        let run = &runs[0];
        assert_eq!(run.tool, "CodeQL");
        assert_eq!(run.category, "/language:javascript");
        let injection = run.findings.iter().find(|finding| finding.rule_id == "js/sql-injection").unwrap();
        assert_eq!(injection.security_severity, Some(Severity::High));
        assert_eq!(injection.severity(), Severity::High);
        assert_eq!(injection.message, "This query string depends on a user-provided value.");
        // The tool's own fingerprint survives the lines moving.
        let moved = CODEQL.replace("\"startLine\": 12", "\"startLine\": 40");
        let again = parse(&moved, None, None).unwrap();
        assert_eq!(again[0].findings.iter().find(|f| f.rule_id == "js/sql-injection").unwrap().fingerprint, injection.fingerprint);
        // A rule found through an extension, with a message from messageStrings.
        let extension = run.findings.iter().find(|finding| finding.rule_id == "js/clear-text-logging").unwrap();
        assert_eq!(extension.security_severity, Some(Severity::High));
        assert_eq!(extension.message, "This logs sensitive data returned by password as clear text.");
    }

    #[test]
    fn fingerprints_without_a_tool_hash_ignore_the_line_and_count_duplicates() {
        let a = fingerprint("t", "r", "a.js", None, "eval(x)", 1);
        assert_eq!(a, fingerprint("t", "r", "a.js", None, "eval(x)  ", 1));
        assert_ne!(a, fingerprint("t", "r", "a.js", None, "eval(x)", 2));
        assert_ne!(a, fingerprint("t", "r", "b.js", None, "eval(x)", 1));
        assert_ne!(a, fingerprint("u", "r", "a.js", None, "eval(x)", 1));
    }

    #[test]
    fn a_later_analysis_fixes_what_it_no_longer_reports() {
        let runs = parse(SEMGREP, None, None).unwrap();
        let findings = &runs[0].findings;
        let all: BTreeSet<String> = findings.iter().map(|finding| finding.fingerprint.clone()).collect();
        // First analysis: everything is new.
        let (new, fixed) = reconcile(&BTreeSet::new(), findings);
        assert_eq!((new.len(), fixed.len()), (all.len(), 0));
        // The same again: nothing new, nothing fixed (dedupe across runs).
        let (new, fixed) = reconcile(&all, findings);
        assert!(new.is_empty() && fixed.is_empty());
        // One result gone: its alert is fixed.
        let (new, fixed) = reconcile(&all, &findings[1..]);
        assert!(new.is_empty());
        assert_eq!(fixed, [findings[0].fingerprint.clone()]);
    }

    #[test]
    fn uploads_are_gzipped_base64() {
        let gz = {
            // A gzip member: header, raw deflate, crc32 and size (not checked).
            let mut out = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff];
            out.extend(miniz_oxide::deflate::compress_to_vec(SEMGREP.as_bytes(), 6));
            out.extend([0u8; 8]);
            out
        };
        let encoded = encode(&gz);
        assert_eq!(decode_upload(&encoded).unwrap(), SEMGREP);
        assert_eq!(decode_upload(&encode(SEMGREP.as_bytes())).unwrap(), SEMGREP);
        assert!(decode_upload("not base64!").unwrap_err().contains("base64"));
        let bomb = {
            let mut out = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff];
            out.extend(miniz_oxide::deflate::compress_to_vec(&vec![b' '; MAX_SARIF_BYTES + 1], 6));
            out.extend([0u8; 8]);
            out
        };
        assert!(decode_upload(&encode(&bomb)).unwrap_err().contains("larger than"));
    }

    fn encode(bytes: &[u8]) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    #[test]
    fn bad_documents_say_what_is_wrong() {
        assert!(parse("{", None, None).unwrap_err().contains("not valid JSON"));
        assert!(parse(r#"{"version":"2.0.0","runs":[]}"#, None, None).unwrap_err().contains("2.1.0"));
        assert!(parse(r#"{"version":"2.1.0"}"#, None, None).unwrap_err().contains("no runs"));
        assert!(parse(r#"{"version":"2.1.0","runs":[{"tool":{"driver":{}}}]}"#, None, None).unwrap_err().contains("names no tool"));
        let suppressed = r#"{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"x"}},"results":[
            {"ruleId":"a","message":{"text":"m"},"suppressions":[{"kind":"inSource"}]},
            {"ruleId":"b","message":{"text":"m"}}]}]}"#;
        let runs = parse(suppressed, Some("lint"), None).unwrap();
        assert_eq!(runs[0].category, "lint");
        assert_eq!(runs[0].findings.len(), 1);
        assert_eq!(runs[0].findings[0].level, Level::Warning);
        assert!(runs[0].findings[0].location.is_none());
    }

    #[test]
    fn the_gate_fails_on_what_the_repository_chose() {
        let runs = parse(CODEQL, None, None).unwrap();
        let injection = runs[0].findings.iter().find(|finding| finding.rule_id == "js/sql-injection").unwrap();
        assert!(Gate::AtLeast(Severity::High).fails(injection));
        assert!(!Gate::AtLeast(Severity::Critical).fails(injection) || injection.level == Level::Error);
        assert!(!Gate::None.fails(injection));
        for gate in ["none", "errors", "critical", "high", "medium", "any"] {
            assert_eq!(Gate::parse(gate).unwrap().as_str(), gate);
        }
    }

    #[test]
    fn a_diff_says_which_lines_it_adds() {
        let diff = "diff --git a/src/db.js b/src/db.js\n--- a/src/db.js\n+++ b/src/db.js\n@@ -10,3 +10,4 @@ fn\n const a = 1;\n-const q = 'x';\n+const q = 'SELECT ' + id;\n+run(q);\n const b = 2;\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,2 @@\n+one\n+two\n";
        let added = added_lines(diff);
        assert_eq!(added["src/db.js"], BTreeSet::from([11, 12]));
        assert_eq!(added["new.js"], BTreeSet::from([1, 2]));
    }

    #[test]
    fn paths_are_from_the_repository_root() {
        assert_eq!(repository_path("file:///home/runner/work/app/src/a%20b.js", &["file:///home/runner/work/app/".into()]), "src/a b.js");
        assert_eq!(repository_path("./src/a.js", &[]), "src/a.js");
        assert_eq!(repository_path("src\\win.js", &[]), "src/win.js");
    }
}
