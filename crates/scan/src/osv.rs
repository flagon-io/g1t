//! Asking OSV (api.osv.dev) which packages have known vulnerabilities,
//! and reading its answers: how severe each is and which version fixes it.
//!
//! Only the requests and the reading of answers live here; the service
//! that calls OSV does the fetching.

use serde_json::{Value, json};

use crate::lockfiles::Package;
use crate::version;

pub const QUERY_BATCH_URL: &str = "https://api.osv.dev/v1/querybatch";
/// OSV takes at most this many queries in one batch.
pub const MAX_BATCH: usize = 1000;

pub fn vuln_url(id: &str) -> String {
    format!("https://api.osv.dev/v1/vulns/{id}")
}

pub fn page_url(id: &str) -> String {
    format!("https://osv.dev/vulnerability/{id}")
}

/// The bodies to POST to [`QUERY_BATCH_URL`], [`MAX_BATCH`] packages each.
pub fn batch_bodies(packages: &[Package]) -> Vec<Value> {
    packages
        .chunks(MAX_BATCH)
        .map(|chunk| {
            json!({
                "queries": chunk.iter().map(|package| json!({
                    "package": { "name": package.name, "ecosystem": package.ecosystem.osv() },
                    "version": package.version,
                })).collect::<Vec<_>>()
            })
        })
        .collect()
}

/// The ids of the vulnerabilities affecting each query of one batch, in
/// the order the queries were sent, and the queries with more to fetch
/// (index, page token).
pub fn read_batch(answer: &Value, sent: usize) -> (Vec<Vec<String>>, Vec<(usize, String)>) {
    let results = answer.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut ids = vec![Vec::new(); sent];
    let mut more = Vec::new();
    for (index, result) in results.into_iter().enumerate().take(sent) {
        if let Some(vulns) = result.get("vulns").and_then(Value::as_array) {
            ids[index] = vulns
                .iter()
                .filter_map(|vuln| vuln.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect();
        }
        if let Some(token) = result.get("next_page_token").and_then(Value::as_str) {
            more.push((index, token.to_owned()));
        }
    }
    (ids, more)
}

/// How bad a vulnerability is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Severity {
    Unknown,
    Low,
    Medium,
    High,
    Critical,
}

impl Severity {
    pub const ALL: [Severity; 5] = [Severity::Critical, Severity::High, Severity::Medium, Severity::Low, Severity::Unknown];

    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Critical => "critical",
            Severity::High => "high",
            Severity::Medium => "medium",
            Severity::Low => "low",
            Severity::Unknown => "unknown",
        }
    }

    pub fn parse(text: &str) -> Severity {
        match text.to_ascii_lowercase().as_str() {
            "critical" => Severity::Critical,
            "high" => Severity::High,
            "moderate" | "medium" => Severity::Medium,
            "low" => Severity::Low,
            _ => Severity::Unknown,
        }
    }

    pub fn from_score(score: f64) -> Severity {
        match score {
            s if s >= 9.0 => Severity::Critical,
            s if s >= 7.0 => Severity::High,
            s if s >= 4.0 => Severity::Medium,
            s if s > 0.0 => Severity::Low,
            _ => Severity::Unknown,
        }
    }
}

/// The base score of a CVSS 3.0 or 3.1 vector, such as
/// `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H` (9.8).
pub fn cvss3_score(vector: &str) -> Option<f64> {
    if !vector.starts_with("CVSS:3") {
        return None;
    }
    let metric = |name: &str| {
        vector
            .split('/')
            .find_map(|part| part.strip_prefix(name).and_then(|rest| rest.strip_prefix(':')))
    };
    let changed = metric("S")? == "C";
    let av = match metric("AV")? { "N" => 0.85, "A" => 0.62, "L" => 0.55, "P" => 0.2, _ => return None };
    let ac = match metric("AC")? { "L" => 0.77, "H" => 0.44, _ => return None };
    let pr = match (metric("PR")?, changed) {
        ("N", _) => 0.85,
        ("L", false) => 0.62,
        ("L", true) => 0.68,
        ("H", false) => 0.27,
        ("H", true) => 0.5,
        _ => return None,
    };
    let ui = match metric("UI")? { "N" => 0.85, "R" => 0.62, _ => return None };
    let cia = |name: &str| match metric(name) { Some("H") => Some(0.56), Some("L") => Some(0.22), Some("N") => Some(0.0), _ => None };
    let (c, i, a) = (cia("C")?, cia("I")?, cia("A")?);
    let iss: f64 = 1.0 - (1.0 - c) * (1.0 - i) * (1.0 - a);
    let impact = if changed { 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02).powi(15) } else { 6.42 * iss };
    if impact <= 0.0 {
        return Some(0.0);
    }
    let exploitability = 8.22 * av * ac * pr * ui;
    let total = if changed { 1.08 * (impact + exploitability) } else { impact + exploitability };
    // CVSS rounds up to one decimal, ignoring floating-point dust.
    let tenths = (total.min(10.0) * 100_000.0).round() as i64;
    Some(if tenths % 10_000 == 0 { tenths as f64 / 100_000.0 } else { ((tenths / 10_000) + 1) as f64 / 10.0 })
}

/// What g1t keeps of an advisory for one package.
#[derive(Clone, Debug, PartialEq)]
pub struct Advisory {
    /// OSV's id.
    pub id: String,
    /// The id people know it by: its GHSA id when it has one.
    pub display_id: String,
    pub aliases: Vec<String>,
    pub summary: String,
    pub severity: Severity,
    /// The lowest version above the one in use that is not affected.
    pub fixed: Option<String>,
}

fn severity_of(vuln: &Value) -> Severity {
    let named = |value: Option<&Value>| value.and_then(Value::as_str).map(Severity::parse);
    let mut found = named(vuln.pointer("/database_specific/severity"));
    if found.is_none_or(|severity| severity == Severity::Unknown)
        && let Some(affected) = vuln.get("affected").and_then(Value::as_array)
    {
        found = affected
            .iter()
            .filter_map(|entry| {
                named(entry.pointer("/database_specific/severity")).or_else(|| named(entry.pointer("/ecosystem_specific/severity")))
            })
            .max();
    }
    if let Some(severity) = found.filter(|severity| *severity != Severity::Unknown) {
        return severity;
    }
    vuln.get("severity")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("score").and_then(Value::as_str).and_then(cvss3_score))
        .map(Severity::from_score)
        .max()
        .unwrap_or(Severity::Unknown)
}

/// The fixed version for `package`: the end of the affected range it is
/// in, or failing that the lowest fix above its version.
fn fixed_for(vuln: &Value, package: &Package) -> Option<String> {
    let mut candidates = Vec::new();
    for entry in vuln.get("affected").and_then(Value::as_array).into_iter().flatten() {
        let name = entry.pointer("/package/name").and_then(Value::as_str).unwrap_or_default();
        let ecosystem = entry.pointer("/package/ecosystem").and_then(Value::as_str).unwrap_or_default();
        if ecosystem != package.ecosystem.osv() || package.ecosystem.normalize(name) != package.name {
            continue;
        }
        for range in entry.get("ranges").and_then(Value::as_array).into_iter().flatten() {
            if range.get("type").and_then(Value::as_str) == Some("GIT") {
                continue;
            }
            for event in range.get("events").and_then(Value::as_array).into_iter().flatten() {
                if let Some(fixed) = event.get("fixed").and_then(Value::as_str)
                    && version::compare(fixed, &package.version).is_gt()
                {
                    candidates.push(fixed.to_owned());
                }
            }
        }
    }
    candidates.into_iter().min_by(|a, b| version::compare(a, b))
}

/// Reads OSV's record of a vulnerability (`GET /v1/vulns/<id>`) as it
/// concerns `package`.
pub fn read_vuln(vuln: &Value, package: &Package) -> Option<Advisory> {
    let id = vuln.get("id").and_then(Value::as_str)?.to_owned();
    let aliases: Vec<String> = vuln
        .get("aliases")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|alias| alias.as_str().map(str::to_owned))
        .collect();
    let display_id = if id.starts_with("GHSA-") {
        id.clone()
    } else {
        aliases
            .iter()
            .find(|alias| alias.starts_with("GHSA-"))
            .or_else(|| aliases.iter().find(|alias| alias.starts_with("CVE-")))
            .cloned()
            .unwrap_or_else(|| id.clone())
    };
    let summary = vuln
        .get("summary")
        .and_then(Value::as_str)
        .or_else(|| vuln.get("details").and_then(Value::as_str).and_then(|details| details.lines().next()))
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect();
    Some(Advisory {
        severity: severity_of(vuln),
        fixed: fixed_for(vuln, package),
        id,
        display_id,
        aliases,
        summary,
    })
}

/// The version to move a package to so that every advisory with a fix is
/// fixed: the highest of their fixed versions.
pub fn upgrade_target<'a>(fixed: impl IntoIterator<Item = &'a str>) -> Option<String> {
    fixed.into_iter().max_by(|a, b| version::compare(a, b)).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lockfiles::Ecosystem;

    fn lodash(version: &str) -> Package {
        Package { ecosystem: Ecosystem::Npm, name: "lodash".into(), version: version.into() }
    }

    #[test]
    fn packages_go_in_batches_of_a_thousand() {
        let packages: Vec<Package> = (0..2500).map(|n| lodash(&format!("1.0.{n}"))).collect();
        let bodies = batch_bodies(&packages);
        assert_eq!(bodies.len(), 3);
        assert_eq!(bodies[0]["queries"].as_array().unwrap().len(), 1000);
        assert_eq!(bodies[2]["queries"].as_array().unwrap().len(), 500);
        assert_eq!(bodies[0]["queries"][0], json!({"package": {"name": "lodash", "ecosystem": "npm"}, "version": "1.0.0"}));
    }

    #[test]
    fn a_batch_answer_is_read_in_order() {
        let answer = json!({"results": [
            {"vulns": [{"id": "GHSA-a", "modified": "x"}, {"id": "GHSA-b"}]},
            {},
            {"vulns": [{"id": "PYSEC-1"}], "next_page_token": "t"}
        ]});
        let (ids, more) = read_batch(&answer, 3);
        assert_eq!(ids, vec![vec!["GHSA-a".to_owned(), "GHSA-b".to_owned()], vec![], vec!["PYSEC-1".to_owned()]]);
        assert_eq!(more, vec![(2, "t".to_owned())]);
        // A short answer leaves the rest empty rather than failing.
        assert_eq!(read_batch(&json!({}), 2).0, vec![Vec::<String>::new(), vec![]]);
    }

    #[test]
    fn cvss_scores() {
        assert_eq!(cvss3_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), Some(9.8));
        assert_eq!(cvss3_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N"), Some(6.1));
        assert_eq!(cvss3_score("CVSS:3.0/AV:L/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:L"), Some(1.8));
        assert_eq!(cvss3_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N"), Some(0.0));
        assert_eq!(cvss3_score("CVSS:4.0/AV:N"), None);
    }

    #[test]
    fn an_advisory_says_how_bad_and_what_fixes_it() {
        let vuln = json!({
            "id": "GHSA-35jh-r3h4-6jhm",
            "aliases": ["CVE-2021-23337"],
            "summary": "Command Injection in lodash",
            "database_specific": {"severity": "HIGH"},
            "affected": [{
                "package": {"ecosystem": "npm", "name": "lodash"},
                "ranges": [{"type": "SEMVER", "events": [{"introduced": "0"}, {"fixed": "4.17.21"}]}]
            }]
        });
        let advisory = read_vuln(&vuln, &lodash("4.17.20")).unwrap();
        assert_eq!(advisory.display_id, "GHSA-35jh-r3h4-6jhm");
        assert_eq!(advisory.severity, Severity::High);
        assert_eq!(advisory.fixed.as_deref(), Some("4.17.21"));
    }

    #[test]
    fn the_fix_is_the_one_for_the_version_in_use() {
        let vuln = json!({
            "id": "RUSTSEC-2020-0071",
            "aliases": ["CVE-2020-26235", "GHSA-wcg3-cvx6-7396"],
            "severity": [{"type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H"}],
            "affected": [{
                "package": {"ecosystem": "crates.io", "name": "time"},
                "ranges": [{"type": "SEMVER", "events": [
                    {"introduced": "0.0.0"}, {"fixed": "0.2.23"},
                    {"introduced": "0.3.0"}, {"fixed": "0.3.1"}
                ]}]
            }, {
                "package": {"ecosystem": "crates.io", "name": "other"},
                "ranges": [{"type": "SEMVER", "events": [{"introduced": "0"}, {"fixed": "0.1.44"}]}]
            }]
        });
        let time = Package { ecosystem: Ecosystem::Cargo, name: "time".into(), version: "0.1.43".into() };
        let advisory = read_vuln(&vuln, &time).unwrap();
        assert_eq!(advisory.display_id, "GHSA-wcg3-cvx6-7396");
        assert_eq!(advisory.severity, Severity::Medium);
        assert_eq!(advisory.fixed.as_deref(), Some("0.2.23"));
        assert_eq!(upgrade_target(["0.2.23", "0.3.1", "0.2.9"]).as_deref(), Some("0.3.1"));
    }

    #[test]
    fn an_advisory_without_a_fix_says_so() {
        let vuln = json!({"id": "PYSEC-2024-1", "details": "Bad thing.\nMore.", "affected": [{
            "package": {"ecosystem": "PyPI", "name": "Some_Package"},
            "ranges": [{"type": "ECOSYSTEM", "events": [{"introduced": "0"}, {"last_affected": "2.0"}]}]
        }]});
        let package = Package { ecosystem: Ecosystem::PyPI, name: "some-package".into(), version: "1.0".into() };
        let advisory = read_vuln(&vuln, &package).unwrap();
        assert_eq!(advisory.fixed, None);
        assert_eq!(advisory.summary, "Bad thing.");
        assert_eq!(advisory.severity, Severity::Unknown);
    }
}
