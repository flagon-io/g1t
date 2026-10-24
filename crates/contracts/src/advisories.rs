//! Repository security advisories and private vulnerability reporting,
//! the Reporting half of a repository's Security page.
//!
//! An **advisory** is a repository's own account of a vulnerability in
//! what it ships: what is affected, what fixes it, how bad it is and who
//! found it. Maintainers write it as a draft, then publish it; a published
//! advisory is visible to anyone who can see the repository, and may be
//! withdrawn. Each has an id of the form `G1TSA-2026-abcd-efgh`.
//!
//! A **vulnerability report** is how someone outside tells the maintainers
//! privately, when the repository has private vulnerability reporting on:
//! a signed-in person who can see the repository, or anyone with an email
//! address on a public one. The maintainers accept it, which makes a draft
//! advisory from it, or decline it. Reporters never see the repository's
//! other reports.
//!
//! Mirrors `packages/contracts/src/advisories.ts`.

use serde::{Deserialize, Serialize};

use crate::User;
use crate::repos::RepoPath;

/// The severities an advisory or report takes.
pub const SEVERITIES: [&str; 4] = ["critical", "high", "medium", "low"];

/// An advisory's states.
pub const ADVISORY_STATES: [&str; 3] = ["draft", "published", "withdrawn"];

/// A report's states.
pub const REPORT_STATES: [&str; 3] = ["new", "accepted", "declined"];

/// The longest title, description and version range kept.
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_DESCRIPTION_CHARS: usize = 20_000;
pub const MAX_RANGE_CHARS: usize = 200;
/// The most people credited on one advisory.
pub const MAX_CREDITS: usize = 20;

/// What a repository says about a vulnerability in what it ships.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Advisory {
    /// `adv_…`, for the API and pages.
    pub id: String,
    /// `G1TSA-2026-abcd-efgh`: what people quote.
    pub g1tsa_id: String,
    pub repo_id: String,
    /// `owner/name`.
    pub repo: String,
    pub title: String,
    /// Markdown: what it is, how it is exploited, what to do.
    pub description: String,
    /// `critical`, `high`, `medium` or `low`.
    pub severity: String,
    /// A CVSS vector string, when the maintainers scored it, and its score.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cvss_vector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cvss_score: Option<f64>,
    /// `CVE-2026-12345`, when one was issued elsewhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cve_id: Option<String>,
    /// The package affected: its ecosystem (`npm`, `crates.io`, `Go`,
    /// `PyPI`, or how the project is distributed), its name, the versions
    /// affected and the versions that fix it, as people write ranges
    /// (`>= 1.2.0, < 1.4.1`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ecosystem: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub affected_versions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patched_versions: Option<String>,
    /// `draft`, `published` or `withdrawn`.
    pub state: String,
    /// Who found or fixed it: usernames or names, as the maintainers wrote them.
    #[serde(default)]
    pub credits: Vec<String>,
    /// The report it was made from, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report_id: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withdrawn_at: Option<String>,
}

/// What a maintainer writes when creating or changing an advisory.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvisoryInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub severity: String,
    #[serde(default)]
    pub cvss_vector: Option<String>,
    #[serde(default)]
    pub cvss_score: Option<f64>,
    #[serde(default)]
    pub cve_id: Option<String>,
    #[serde(default)]
    pub ecosystem: Option<String>,
    #[serde(default)]
    pub package: Option<String>,
    #[serde(default)]
    pub affected_versions: Option<String>,
    #[serde(default)]
    pub patched_versions: Option<String>,
    #[serde(default)]
    pub credits: Vec<String>,
}

/// `list_advisories`: a repository's advisories, newest first. Anyone who
/// can see the repository sees the published ones; those who see its
/// findings (Write, or a security manager) see drafts and withdrawn ones
/// too. Returns `Outcome<Vec<Advisory>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListAdvisoriesArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
    /// `draft`, `published` or `withdrawn`; all the viewer may see when absent.
    #[serde(default)]
    pub state: Option<String>,
}

/// `get_advisory`: one advisory by `adv_…` id or `G1TSA-…` id, with the
/// same visibility. Returns `Outcome<Advisory>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct GetAdvisoryArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
    pub id: String,
}

/// `create_advisory`: a draft. Admin on the repository, or a security
/// manager of its workspace (`ManageSecurity`). Returns `Outcome<Advisory>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CreateAdvisoryArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub advisory: AdvisoryInput,
}

/// `update_advisory`: changes an advisory's text and fields in any state;
/// a published one's change is visible at once. Returns `Outcome<Advisory>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateAdvisoryArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    pub advisory: AdvisoryInput,
}

/// `set_advisory_state`: publishes a draft (`published`), withdraws a
/// published one (`withdrawn`), or puts a withdrawn one back
/// (`published`). Publishing tells webhooks and the repository's watchers.
/// Returns `Outcome<Advisory>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetAdvisoryStateArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    pub state: String,
}

/// Something someone told the maintainers privately.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VulnerabilityReport {
    /// `vrp_…`.
    pub id: String,
    pub repo_id: String,
    pub repo: String,
    /// The reporter: a username when signed in, else the address they gave.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reporter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reporter_email: Option<String>,
    pub title: String,
    pub description: String,
    /// What the reporter thinks: `critical`, `high`, `medium` or `low`, or none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    /// `new`, `accepted` or `declined`.
    pub state: String,
    /// The draft advisory an accepted report became.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advisory_id: Option<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_note: Option<String>,
}

/// `report_vulnerability`: tells the maintainers privately. Needs private
/// vulnerability reporting on for the repository; anyone who can see the
/// repository may report, and on a public one someone signed out may with
/// an `email`. Returns `Outcome<VulnerabilityReport>`; the reporter sees
/// only their own report.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReportVulnerabilityArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub severity: Option<String>,
    /// For someone signed out: where the maintainers can answer.
    #[serde(default)]
    pub email: Option<String>,
}

/// `report_settings`: whether a repository takes private vulnerability
/// reports, for anyone who can see it (its public Security page says so).
/// Returns `Outcome<ReportSettings>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReportSettingsArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSettings {
    pub private_vulnerability_reporting: bool,
    /// Published advisories.
    pub published: u32,
}

/// `list_vulnerability_reports`: a repository's reports, newest first.
/// Those who see findings. Returns `Outcome<Vec<VulnerabilityReport>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ListReportsArgs {
    pub viewer: Option<User>,
    pub repo: RepoPath,
    /// `new`, `accepted` or `declined`; all when absent.
    #[serde(default)]
    pub state: Option<String>,
}

/// `review_vulnerability_report`: `accept`, which makes a draft advisory
/// from it, or `decline`. `ManageSecurity`. Returns `Outcome<ReviewedReport>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReviewReportArgs {
    pub actor: User,
    pub repo: RepoPath,
    pub id: String,
    /// `accept` or `decline`.
    pub decision: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedReport {
    pub report: VulnerabilityReport,
    /// The draft made, on accept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advisory: Option<Advisory>,
}

/// What `security_advisory.published`, `.withdrawn` and `.reported` carry,
/// for webhooks and the inbox. A report's event names no reporter and
/// carries no description: it tells the maintainers to look.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvisoryEvent {
    pub repo_id: String,
    /// `adv_…`, or for a report `vrp_…`.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub g1tsa_id: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    pub state: String,
    /// Its page, from the site's root.
    pub link: String,
    /// Who hears of it: the workspace's owners and security managers, for
    /// a report. Usernames.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notify: Vec<String>,
}

/// The id people quote, from a time and some randomness: `G1TSA-2026-abcd-efgh`.
pub fn g1tsa_id(year: u32, random: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghjkmnpqrstuvwxyz23456789-";
    let mut letters: Vec<char> = random.iter().take(8).map(|byte| ALPHABET[(*byte as usize) % 31] as char).collect();
    while letters.len() < 8 {
        letters.push('a');
    }
    let first: String = letters[..4].iter().collect();
    let second: String = letters[4..].iter().collect();
    format!("G1TSA-{year}-{first}-{second}")
}

/// Whether text is a `G1TSA-…` id.
pub fn is_g1tsa_id(text: &str) -> bool {
    text.starts_with("G1TSA-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_people_quote_have_a_year_and_eight_letters() {
        let id = g1tsa_id(2026, &[0, 1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(id, "G1TSA-2026-abcd-efgh");
        assert!(is_g1tsa_id(&id) && !is_g1tsa_id("adv_1"));
        // Short randomness is padded, never a panic.
        assert_eq!(g1tsa_id(2026, &[]).len(), "G1TSA-2026-aaaa-aaaa".len());
    }

    #[test]
    fn events_leave_out_what_is_empty() {
        let event = AdvisoryEvent {
            repo_id: "rep_1".into(),
            id: "vrp_1".into(),
            title: "XSS in the search box".into(),
            state: "new".into(),
            ..Default::default()
        };
        let json = serde_json::to_value(&event).unwrap();
        assert!(json.get("g1tsaId").is_none() && json.get("notify").is_none());
        assert_eq!(json["repoId"], "rep_1");
    }
}
