//! Who made a repository: the authors of the commits on its default branch,
//! each matched to their account by an address they confirmed (or their
//! noreply address), g1t as itself, and anyone else by the name on their
//! commits. Several addresses of one account count as one contributor.

use std::collections::{BTreeMap, HashMap};

use g1t_contracts::about::{Contributor, ContributorKind, MAX_CONTRIBUTOR_WEEKS, MAX_CONTRIBUTORS, WeekCommits, next_week, week_of};
use g1t_contracts::accounts::EmailOwner;

/// The address g1t's own commits carry.
pub const G1T_EMAIL: &str = "g1t@users.noreply.g1t.sh";

/// The addresses g1t's agents and merge queue committed as before they
/// committed as g1t (2026-10-06): history keeps them, and they are g1t's.
/// The site matches the same set (apps/web/app/lib/commit-people.ts).
pub const LEGACY_G1T_EMAILS: [&str; 3] = ["agent@g1t.sh", "queue@g1t.sh", "mergecheck@g1t.sh"];

/// One commit's author, as history gives it.
#[derive(Clone, Debug)]
pub struct Authored {
    pub name: String,
    pub email: String,
    /// RFC 3339.
    pub at: String,
}

/// Whether a commit's author is g1t itself.
pub fn is_g1t(author: &Authored) -> bool {
    let email = author.email.trim();
    email.eq_ignore_ascii_case(G1T_EMAIL) || LEGACY_G1T_EMAILS.iter().any(|legacy| email.eq_ignore_ascii_case(legacy))
}

#[derive(Default)]
struct Tally {
    kind: Option<ContributorKind>,
    name: String,
    username: Option<String>,
    avatar: Option<String>,
    commits: u32,
    first_at: String,
    last_at: String,
    weeks: BTreeMap<String, u32>,
}

/// The contributors, most commits first (then by name), at most
/// `MAX_CONTRIBUTORS`, the most active `MAX_CONTRIBUTOR_WEEKS` with their
/// weeks; how many there are; and every commit by week, oldest first, with
/// the empty weeks between.
pub fn tally(commits: &[Authored], owners: &HashMap<String, EmailOwner>) -> (Vec<Contributor>, u32, Vec<WeekCommits>) {
    let mut by_key: HashMap<String, Tally> = HashMap::new();
    let mut all_weeks: BTreeMap<String, u32> = BTreeMap::new();
    for commit in commits {
        let email = commit.email.trim().to_ascii_lowercase();
        let (key, kind, name, username, avatar) = if is_g1t(commit) {
            ("g1t".to_owned(), ContributorKind::G1t, "g1t".to_owned(), None, None)
        } else if let Some(owner) = owners.get(&email) {
            (format!("user:{}", owner.id), ContributorKind::User, owner.username.clone(), Some(owner.username.clone()), owner.avatar.clone())
        } else {
            let key = if email.is_empty() { format!("name:{}", commit.name.trim().to_lowercase()) } else { format!("email:{email}") };
            (key, ContributorKind::Author, commit.name.trim().to_owned(), None, None)
        };
        let tally = by_key.entry(key).or_default();
        if tally.kind.is_none() {
            *tally = Tally { kind: Some(kind), name, username, avatar, first_at: commit.at.clone(), last_at: commit.at.clone(), ..Tally::default() };
        }
        tally.commits += 1;
        if commit.at < tally.first_at {
            tally.first_at = commit.at.clone();
        }
        if commit.at > tally.last_at {
            tally.last_at = commit.at.clone();
        }
        if let Some(week) = week_of(&commit.at) {
            *tally.weeks.entry(week.clone()).or_default() += 1;
            *all_weeks.entry(week).or_default() += 1;
        }
    }
    let total = by_key.len() as u32;
    let mut tallies: Vec<Tally> = by_key.into_values().collect();
    tallies.sort_by(|a, b| b.commits.cmp(&a.commits).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    tallies.truncate(MAX_CONTRIBUTORS);
    let contributors = tallies
        .into_iter()
        .enumerate()
        .map(|(rank, tally)| Contributor {
            kind: tally.kind.unwrap_or(ContributorKind::Author),
            name: tally.name,
            username: tally.username,
            avatar: tally.avatar,
            commits: tally.commits,
            first_at: tally.first_at,
            last_at: tally.last_at,
            weeks: if rank < MAX_CONTRIBUTOR_WEEKS {
                tally.weeks.into_iter().map(|(week, commits)| WeekCommits { week, commits }).collect()
            } else {
                Vec::new()
            },
        })
        .collect();
    (contributors, total, filled(&all_weeks))
}

/// Every week from the first to the last, with none for those without.
fn filled(weeks: &BTreeMap<String, u32>) -> Vec<WeekCommits> {
    let (Some(first), Some(last)) = (weeks.keys().next(), weeks.keys().next_back()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut week = first.clone();
    // At most twenty years of weeks, whatever the dates say.
    while week <= *last && out.len() < 1_100 {
        out.push(WeekCommits { commits: weeks.get(&week).copied().unwrap_or(0), week: week.clone() });
        match next_week(&week) {
            Some(next) => week = next,
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authored(name: &str, email: &str, at: &str) -> Authored {
        Authored { name: name.into(), email: email.into(), at: at.into() }
    }

    #[test]
    fn authors_are_matched_merged_and_ranked() {
        let commits = vec![
            authored("Ada", "ada@example.com", "2026-10-07T10:00:00Z"),
            authored("Ada L", "ADA@work.example", "2026-09-30T10:00:00Z"),
            authored("g1t", G1T_EMAIL, "2026-10-06T10:00:00Z"),
            authored("g1t", G1T_EMAIL, "2026-10-01T10:00:00Z"),
            authored("g1t", G1T_EMAIL, "2026-09-20T10:00:00Z"),
            authored("Sam", "sam@example.com", "2026-09-16T10:00:00Z"),
        ];
        let ada = EmailOwner { id: "usr_ada".into(), username: "ada".into(), avatar: Some("abc".into()) };
        let owners = HashMap::from([("ada@example.com".to_owned(), ada.clone()), ("ada@work.example".to_owned(), ada)]);
        let (contributors, total, weeks) = tally(&commits, &owners);
        assert_eq!(total, 3);
        assert_eq!(contributors[0].kind, ContributorKind::G1t);
        assert_eq!(contributors[0].commits, 3);
        assert_eq!(contributors[1].username.as_deref(), Some("ada"));
        assert_eq!(contributors[1].commits, 2, "both of Ada's addresses");
        assert_eq!(contributors[1].first_at, "2026-09-30T10:00:00Z");
        assert_eq!(contributors[1].last_at, "2026-10-07T10:00:00Z");
        assert_eq!(contributors[1].avatar.as_deref(), Some("abc"));
        assert_eq!(contributors[2].kind, ContributorKind::Author);
        assert_eq!(contributors[2].name, "Sam");
        // Weeks of 2026-09-14 through 2026-10-05, none skipped.
        let named: Vec<(&str, u32)> = weeks.iter().map(|week| (week.week.as_str(), week.commits)).collect();
        assert_eq!(named, vec![("2026-09-14", 2), ("2026-09-21", 0), ("2026-09-28", 2), ("2026-10-05", 2)]);
        assert_eq!(contributors[1].weeks.len(), 2);
    }

    #[test]
    fn g1t_older_addresses_are_g1t() {
        let commits = vec![
            authored("g1t agent", "agent@g1t.sh", "2026-10-01T10:00:00Z"),
            authored("g1t merge queue", "Queue@g1t.sh", "2026-10-02T10:00:00Z"),
            authored("g1t", G1T_EMAIL, "2026-10-07T10:00:00Z"),
            authored("Not g1t", "someone@g1t.sh", "2026-10-07T10:00:00Z"),
        ];
        let (contributors, total, _) = tally(&commits, &HashMap::new());
        assert_eq!(total, 2);
        assert_eq!(contributors[0].kind, ContributorKind::G1t);
        assert_eq!(contributors[0].name, "g1t");
        assert_eq!(contributors[0].commits, 3);
        assert_eq!(contributors[1].kind, ContributorKind::Author, "only g1t's own addresses");
    }

    #[test]
    fn no_history_is_no_one() {
        let (contributors, total, weeks) = tally(&[], &HashMap::new());
        assert!(contributors.is_empty() && weeks.is_empty());
        assert_eq!(total, 0);
    }
}
