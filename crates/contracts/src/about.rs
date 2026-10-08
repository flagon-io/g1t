//! A repository's About, as its Files page shows it beside the files: what
//! its files say about it (its license, its security policy and the
//! languages it is written in), who made it (its contributors), who starred
//! it, and its releases. Methods of the repos service.
//!
//! What is read from history and files is worked out in the background for
//! the default branch's head and kept by commit (services/repos/src/stats.rs),
//! never on the way to a page: an answer can be for an older commit
//! (`commit` is not `head`) while the newer one is worked out, or `pending`
//! when nothing has been worked out yet.

use serde::{Deserialize, Serialize};

use crate::repos::{RepoPath, Repo};
use crate::{User, Viewer};

/// One language's share of a repository's code, by bytes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageShare {
    pub name: String,
    /// `#rrggbb`, the color it is known by; null for one without.
    pub color: Option<String>,
    pub bytes: u64,
    /// Of the bytes counted, to one decimal place.
    pub percent: f64,
}

/// The license a repository's LICENSE (or COPYING) file holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct License {
    /// Its SPDX identifier, such as `MIT` or `Apache-2.0`; null when the
    /// text is not one g1t recognizes.
    pub spdx_id: Option<String>,
    /// What people call it: "MIT License", or "Other" when unrecognized.
    pub name: String,
    /// The file it was read from, from the root: `LICENSE`.
    pub path: String,
}

/// Who a contributor is: a person with an account (their commits' address
/// is one they confirmed), g1t itself, or an author g1t cannot match to an
/// account.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributorKind {
    User,
    G1t,
    Author,
}

/// Commits in one week, the week named by its Monday (`YYYY-MM-DD`, UTC).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WeekCommits {
    pub week: String,
    pub commits: u32,
}

/// Someone whose commits are on the default branch.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributor {
    pub kind: ContributorKind,
    /// Their username for a `user` (and `g1t` for g1t); the name on their
    /// commits otherwise.
    pub name: String,
    /// The account's username, for a `user`.
    #[serde(default)]
    pub username: Option<String>,
    /// The uploaded avatar's hash, for a `user` who has one.
    #[serde(default)]
    pub avatar: Option<String>,
    pub commits: u32,
    /// RFC 3339: their first and latest commit read.
    pub first_at: String,
    pub last_at: String,
    /// Their commits by week, oldest first, the weeks with none left out.
    /// Only for the most active contributors (`MAX_CONTRIBUTOR_WEEKS` of
    /// them); empty for the rest and in the About summary.
    #[serde(default)]
    pub weeks: Vec<WeekCommits>,
}

/// The most contributors kept for a repository.
pub const MAX_CONTRIBUTORS: usize = 500;
/// The contributors whose commits are kept week by week.
pub const MAX_CONTRIBUTOR_WEEKS: usize = 100;
/// The contributors the About summary names.
pub const ABOUT_CONTRIBUTORS: usize = 14;

/// Where an answer worked out from the default branch stands.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Freshness {
    /// The default branch's head now; null for an empty repository.
    pub head: Option<String>,
    /// The commit the answer was worked out for; null when none has been.
    pub commit: Option<String>,
    /// RFC 3339: when it was.
    pub computed_at: Option<String>,
    /// Nothing has been worked out yet; it is under way. Ask again shortly.
    pub pending: bool,
    /// The history or the files were too large to read in full, so the
    /// answer counts what was read.
    pub partial: bool,
}

/// `languages`: a repository's languages by bytes, largest first.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Languages {
    #[serde(flatten)]
    pub freshness: Freshness,
    pub languages: Vec<LanguageShare>,
}

/// `contributors`: everyone whose commits are on the default branch, most
/// commits first, and the repository's commits by week.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributors {
    #[serde(flatten)]
    pub freshness: Freshness,
    /// How many there are; `contributors` lists at most `MAX_CONTRIBUTORS`.
    pub total: u32,
    /// The commits read.
    pub commits: u32,
    pub contributors: Vec<Contributor>,
    /// Every commit read, by week, oldest first, including empty weeks.
    pub weeks: Vec<WeekCommits>,
}

/// A release: a tag, published with a title and notes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    /// `rel_…`.
    pub id: String,
    pub tag_name: String,
    /// The commit the tag named when the release was made.
    pub target: String,
    /// Its title; the tag's name when it has none.
    pub name: Option<String>,
    /// Its notes, Markdown.
    pub body: String,
    /// Seen only by those who can push until it is published.
    pub draft: bool,
    /// Not ready for everyone: never the latest release.
    pub prerelease: bool,
    /// The username of who made it.
    pub author: Option<String>,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339; null while it is a draft.
    pub published_at: Option<String>,
    /// Whether it is the latest release: the newest published one that is
    /// neither a draft nor a prerelease.
    #[serde(default)]
    pub latest: bool,
}

/// The longest release title, and the longest notes.
pub const MAX_RELEASE_NAME_CHARS: usize = 200;
pub const MAX_RELEASE_BODY_CHARS: usize = 125_000;

/// Someone who starred a repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stargazer {
    pub username: String,
    pub avatar: Option<String>,
    /// RFC 3339.
    pub starred_at: String,
}

/// A repository someone starred.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarredRepo {
    pub repo: Repo,
    /// RFC 3339.
    pub starred_at: String,
    pub stars: u64,
}

/// Whether the viewer starred a repository, and how many have.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stars {
    pub starred: bool,
    pub stars: u64,
}

/// The About of a repository's Files page, in one answer: what is kept for
/// the default branch's head, the stars and the releases.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoAbout {
    #[serde(flatten)]
    pub freshness: Freshness,
    pub license: Option<License>,
    /// The path of its security policy (SECURITY.md at the root, or in
    /// `.g1t`, `.github` or `docs`), when it has one.
    pub security_policy: Option<String>,
    pub languages: Vec<LanguageShare>,
    /// How many contributors there are, and the most active
    /// (`ABOUT_CONTRIBUTORS`), without their weeks.
    pub contributors: u32,
    pub top_contributors: Vec<Contributor>,
    pub stars: u64,
    pub starred: bool,
    /// Published releases the viewer can see, drafts left out unless they
    /// can push.
    pub releases: u64,
    pub latest_release: Option<Release>,
}

/// `about`, `languages`, `contributors`, `license`, `stars` and
/// `releases`: one repository, for the viewer. `about` returns
/// `Outcome<RepoAbout>`, `languages` `Outcome<Languages>`, `contributors`
/// `Outcome<Contributors>`, `license` `Outcome<Option<License>>`, `stars`
/// `Outcome<Stars>` and `releases` `Outcome<Vec<Release>>` (newest first,
/// at most 100).
#[derive(Debug, Serialize, Deserialize)]
pub struct RepoViewArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
}

/// `star`: stars the repository for the actor, or takes their star back.
/// Returns `Outcome<Stars>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StarArgs {
    pub path: RepoPath,
    pub actor: User,
    pub starred: bool,
}

/// `stargazers`: who starred a repository, newest first, 100 a page;
/// `page` from 1. Returns `Outcome<Vec<Stargazer>>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct StargazersArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
    #[serde(default)]
    pub page: Option<u32>,
}

/// `starred`: the repositories a person starred that the viewer can see,
/// newest first, at most 100. The person by `username`. Returns
/// `Vec<StarredRepo>`; empty for an unknown person.
#[derive(Debug, Serialize, Deserialize)]
pub struct StarredArgs {
    pub username: String,
    pub viewer: Viewer,
}

/// `release`: one release, by `id` or `tag`, or with `latest` the latest
/// one. Returns `Outcome<Release>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReleaseArgs {
    pub path: RepoPath,
    pub viewer: Viewer,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub latest: bool,
}

/// `create_release`: a release of `tag_name`. A tag that does not exist
/// yet is made at `target` (a branch or commit; the default branch when
/// absent). Needs the Write role. Returns `Outcome<Release>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReleaseArgs {
    pub path: RepoPath,
    pub actor: User,
    pub tag_name: String,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
}

/// `update_release`: changes whichever of a release's title, notes, draft
/// and prerelease are given; an empty title clears it. Publishing a draft
/// sets `published_at`. Needs the Write role. Returns `Outcome<Release>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateReleaseArgs {
    pub path: RepoPath,
    pub actor: User,
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub draft: Option<bool>,
    #[serde(default)]
    pub prerelease: Option<bool>,
}

/// `delete_release`: deletes a release; its tag stays. Needs the Write
/// role. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteReleaseArgs {
    pub path: RepoPath,
    pub actor: User,
    pub id: String,
}

/// Monday of the week `rfc3339` falls in (UTC), as `YYYY-MM-DD`; None when
/// it cannot be read.
pub fn week_of(rfc3339: &str) -> Option<String> {
    let days = days_from_civil_str(rfc3339.get(..10)?)?;
    // 1970-01-01 was a Thursday: day 0 is three days after a Monday.
    let monday = days - (days + 3).rem_euclid(7);
    Some(civil_from_days(monday))
}

/// The Monday after `week` (a Monday, `YYYY-MM-DD`).
pub fn next_week(week: &str) -> Option<String> {
    Some(civil_from_days(days_from_civil_str(week)? + 7))
}

fn days_from_civil_str(date: &str) -> Option<i64> {
    let mut parts = date.splitn(3, '-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Howard Hinnant's days_from_civil.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

fn civil_from_days(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_week_is_named_by_its_monday() {
        // 2026-10-07 is a Wednesday.
        assert_eq!(week_of("2026-10-07T10:00:00Z").as_deref(), Some("2026-10-05"));
        assert_eq!(week_of("2026-10-05T00:00:00Z").as_deref(), Some("2026-10-05"));
        assert_eq!(week_of("2026-10-11T23:59:59Z").as_deref(), Some("2026-10-05"));
        assert_eq!(week_of("2026-01-01T00:00:00Z").as_deref(), Some("2025-12-29"));
        assert_eq!(week_of("1970-01-01T00:00:00Z").as_deref(), Some("1969-12-29"));
        assert_eq!(week_of("nonsense"), None);
        assert_eq!(next_week("2025-12-29").as_deref(), Some("2026-01-05"));
    }

    #[test]
    fn the_about_is_camel_case_between_services() {
        let about = RepoAbout { contributors: 3, ..RepoAbout::default() };
        let value = serde_json::to_value(&about).unwrap();
        assert_eq!(value["topContributors"], serde_json::json!([]));
        assert_eq!(value["pending"], false);
        assert_eq!(value["securityPolicy"], serde_json::Value::Null);
    }
}
