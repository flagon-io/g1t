//! The dependency update file on the default branch: which of
//! [`DEPENDABOT_PATHS`] is read, and what it says, as the Security page
//! shows it. A file under `.g1t/` is read in place of one under
//! `.github/`, which is reported as ignored. Reading and checking the
//! format is `config`'s; acting on it is `version_updates`'s.

use g1t_contracts::updates::{DEPENDABOT_PATHS, VersionUpdateEntry, VersionUpdatesState};

use crate::config::{self, Config, Entry};

/// A file found: its path and its text, if it is text.
pub type Found = (String, Option<String>);

/// The file to read among those found (each a path and its text, in any
/// order), and the others, which are ignored.
pub fn choose(found: Vec<Found>) -> Option<(Found, Vec<String>)> {
    let mut found = found;
    found.sort_by_key(|(path, _)| DEPENDABOT_PATHS.iter().position(|known| known == path).unwrap_or(usize::MAX));
    let mut found = found.into_iter();
    let first = found.next()?;
    Some((first, found.map(|(path, _)| path).collect()))
}

/// How one entry is shown. `seed` picks its time of day when the
/// schedule names none: the repository's id.
pub fn entry_view(entry: &Entry, seed: &str, default_branch: Option<&str>) -> VersionUpdateEntry {
    let schedule_seed = format!("{seed}:{}", entry.id());
    VersionUpdateEntry {
        id: entry.id(),
        ecosystem: entry.ecosystem.clone(),
        directories: entry.directories.clone(),
        supported: entry.supported(),
        interval: entry.schedule.as_ref().map(|schedule| schedule.interval.as_str().to_owned()).unwrap_or_default(),
        schedule: entry.schedule.as_ref().map(|schedule| schedule.describe(&schedule_seed)).unwrap_or_default(),
        open_pull_requests_limit: entry.open_pull_requests_limit,
        target_branch: entry.target_branch.clone(),
        multi_ecosystem_group: entry.multi_ecosystem_group.clone(),
        groups: entry.groups.clone(),
        ignore: entry.ignore.clone(),
        allow: entry.allow.clone(),
        labels: entry.labels.clone(),
        assignees: entry.assignees.clone(),
        reviewers: entry.reviewers.clone(),
        milestone: entry.milestone,
        versioning_strategy: entry.versioning_strategy.clone(),
        options: entry.options.clone(),
        notes: config::notes(entry, default_branch),
        ..VersionUpdateEntry::default()
    }
}

/// The schedule seed for an entry of a repository: what keeps its picked
/// time of day the same from one read to the next.
pub fn seed(repo_id: &str, entry: &Entry) -> String {
    format!("{repo_id}:{}", entry.id())
}

/// What the file at `path` says, for the Security page. `None` text is a
/// file too large or not text.
pub fn state(
    path: &str,
    text: Option<&str>,
    ignored_paths: Vec<String>,
    repo_id: &str,
    default_branch: Option<&str>,
) -> (VersionUpdatesState, Option<Config>) {
    let mut state = VersionUpdatesState { found: true, path: Some(path.to_owned()), ignored_paths, ..VersionUpdatesState::default() };
    let Some(text) = text else {
        state.error = Some(format!("{path} is too large to read or is not text."));
        return (state, None);
    };
    let read = config::read(text);
    state.updates = read.config.updates.iter().map(|entry| entry_view(entry, repo_id, default_branch)).collect();
    state.registries = read.config.registries.iter().map(|registry| registry.info()).collect();
    state.error = read.problems.first().map(|problem| problem.sentence());
    let valid = read.problems.is_empty();
    state.problems = read.problems;
    (state, valid.then_some(read.config))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn g1t_comes_before_github() {
        let found = vec![
            (".github/dependabot.yml".to_owned(), Some("a".to_owned())),
            (".g1t/dependabot.yaml".to_owned(), Some("b".to_owned())),
        ];
        let ((path, text), ignored) = choose(found).unwrap();
        assert_eq!((path.as_str(), text.as_deref()), (".g1t/dependabot.yaml", Some("b")));
        assert_eq!(ignored, [".github/dependabot.yml"]);
        assert!(choose(Vec::new()).is_none());
    }

    #[test]
    fn the_page_sees_entries_and_problems() {
        let source = "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n      time: \"05:00\"\n  - package-ecosystem: docker\n    directory: /\n    schedule: {interval: monthly}\n";
        let (found, config) = state(".github/dependabot.yml", Some(source), Vec::new(), "rep_1", Some("main"));
        assert!(config.is_some() && found.error.is_none());
        assert_eq!(found.updates.len(), 2);
        assert_eq!(found.updates[0].schedule, "Mondays at 05:00 (UTC)");
        assert!(found.updates[0].supported && !found.updates[1].supported);
        assert_eq!(found.updates[0].id, "npm:/");

        let (broken, config) = state(".github/dependabot.yml", Some("version: 2\nupdates:\n  - package-ecosystem: npm\n"), Vec::new(), "rep_1", None);
        assert!(config.is_none());
        assert_eq!(broken.error.as_deref(), Some("line 3, updates[0]: `directory` (or `directories`) is required: where the manifest is, such as \"/\"."));
        let (binary, _) = state(".g1t/dependabot.yml", None, Vec::new(), "rep_1", None);
        assert!(binary.error.unwrap().contains("too large"));
    }
}
