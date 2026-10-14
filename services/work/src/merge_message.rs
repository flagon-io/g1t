//! What a merge or squash commit says unless its merger writes it: the
//! repository's choice (`RepoSettings::merge_commit_message` and
//! `squash_commit_message`), filled in from the pull request. A rebase and
//! a fast-forward make no commit of their own, so say nothing.

use g1t_contracts::rules::MergeMethod;
use g1t_contracts::work::{CommitMessageDefault, RepoSettings};

/// The longest commit title a merger may write.
pub(crate) const MAX_TITLE_CHARS: usize = 500;
/// The longest commit message body a merger may write.
pub(crate) const MAX_MESSAGE_CHARS: usize = 64_000;

/// One commit the pull request adds, as its message says. Kept as JSON
/// with its pull request (`pull_message_commits`, merging.rs).
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct CommitText {
    pub message: String,
    pub author_email: Option<String>,
}

impl CommitText {
    /// Its message's first line.
    pub(crate) fn subject(&self) -> &str {
        self.message.lines().next().unwrap_or_default().trim()
    }
}

/// What a message is made from.
#[derive(Clone, Debug, Default)]
pub(crate) struct MessageFacts<'a> {
    pub number: u32,
    pub title: &'a str,
    pub body: &'a str,
    /// The branch holding the change.
    pub branch: &'a str,
    /// Who the branch belongs to: the workspace of the repository or fork
    /// it is in, or for a working copy, whoever asked for the change.
    pub head_owner: &'a str,
    /// The repository or fork holding it, `owner/name`.
    pub head_repo: &'a str,
    /// The branch it merges into.
    pub base: &'a str,
    /// Its author's username.
    pub author: &'a str,
    /// Its commits, oldest first, merge commits left out.
    pub commits: &'a [CommitText],
    /// The issues it closes.
    pub issues: &'a [u32],
}

/// Whether making the default message for `method` needs the pull
/// request's commits read.
pub(crate) fn needs_commits(method: MergeMethod, settings: &RepoSettings) -> bool {
    let (choice, template) = match method {
        MergeMethod::Merge => (settings.merge_commit_message, settings.merge_commit_template.as_deref()),
        MergeMethod::Squash => (settings.squash_commit_message, settings.squash_commit_template.as_deref()),
        MergeMethod::Rebase | MergeMethod::FastForward => return false,
    };
    match choice {
        CommitMessageDefault::Default => method == MergeMethod::Squash,
        CommitMessageDefault::PullTitleAndCommits => method == MergeMethod::Squash,
        CommitMessageDefault::Custom => template.is_some_and(|text| text.contains("{commits}") || text.contains("{co_authors}")),
        CommitMessageDefault::PullTitle | CommitMessageDefault::PullTitleAndDescription => false,
    }
}

/// The default title and body of the commit `method` makes, or `None` for
/// one that makes none of its own.
pub(crate) fn default_message(method: MergeMethod, settings: &RepoSettings, facts: &MessageFacts<'_>) -> Option<(String, String)> {
    let numbered = format!("{} (#{})", facts.title.trim(), facts.number);
    let description = facts.body.trim().to_owned();
    match method {
        MergeMethod::Rebase | MergeMethod::FastForward => None,
        MergeMethod::Merge => Some(match settings.merge_commit_message {
            CommitMessageDefault::PullTitle => (numbered, String::new()),
            CommitMessageDefault::PullTitleAndDescription => (numbered, description),
            CommitMessageDefault::Custom => custom(settings.merge_commit_template.as_deref(), facts).unwrap_or_else(|| merge_default(facts)),
            // Listing commits is for squashes; settings refuse it here.
            CommitMessageDefault::Default | CommitMessageDefault::PullTitleAndCommits => merge_default(facts),
        }),
        MergeMethod::Squash => Some(match settings.squash_commit_message {
            CommitMessageDefault::PullTitle => (numbered, String::new()),
            CommitMessageDefault::PullTitleAndDescription => (numbered, description),
            CommitMessageDefault::PullTitleAndCommits => (
                numbered,
                facts.commits.iter().map(|commit| commit.message.trim()).filter(|message| !message.is_empty()).collect::<Vec<_>>().join("\n\n"),
            ),
            CommitMessageDefault::Custom => custom(settings.squash_commit_template.as_deref(), facts).unwrap_or_else(|| squash_default(facts)),
            CommitMessageDefault::Default => squash_default(facts),
        }),
    }
}

/// "Merge pull request #12 from owner/branch", and its title below.
fn merge_default(facts: &MessageFacts<'_>) -> (String, String) {
    (
        format!("Merge pull request #{} from {}/{}", facts.number, facts.head_owner, facts.branch),
        facts.title.trim().to_owned(),
    )
}

/// Its title and number; below, its commits' subjects when it has more
/// than one.
fn squash_default(facts: &MessageFacts<'_>) -> (String, String) {
    let body = if facts.commits.len() > 1 { bullets(facts.commits) } else { String::new() };
    (format!("{} (#{})", facts.title.trim(), facts.number), body)
}

fn bullets(commits: &[CommitText]) -> String {
    commits
        .iter()
        .map(CommitText::subject)
        .filter(|subject| !subject.is_empty())
        .map(|subject| format!("* {subject}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `Co-authored-by:` lines for the commits' authors, each once.
fn co_authors(commits: &[CommitText]) -> String {
    let mut seen: Vec<String> = Vec::new();
    for email in commits.iter().filter_map(|commit| commit.author_email.as_deref()) {
        let email = email.trim().to_lowercase();
        if !email.is_empty() && !seen.contains(&email) {
            seen.push(email);
        }
    }
    seen.iter()
        .map(|email| format!("Co-authored-by: {} <{email}>", email.split('@').next().unwrap_or(email)))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The repository's template filled in: its first line is the title, the
/// rest the body. `None` when there is no template or it says nothing.
fn custom(template: Option<&str>, facts: &MessageFacts<'_>) -> Option<(String, String)> {
    let issues = facts.issues.iter().map(|number| format!("#{number}")).collect::<Vec<_>>().join(", ");
    let filled = fill(
        template?,
        &[
            ("title", facts.title.trim()),
            ("number", &facts.number.to_string()),
            ("body", facts.body.trim()),
            ("branch", facts.branch),
            ("head_repo", facts.head_repo),
            ("base", facts.base),
            ("author", facts.author),
            ("commits", &bullets(facts.commits)),
            ("issues", &issues),
            ("co_authors", &co_authors(facts.commits)),
        ],
    );
    let (title, body) = split(&filled);
    (!title.is_empty()).then_some((title, body))
}

/// `template` with each `{name}` replaced once, left to right: what a
/// value holds is never filled in again. Unknown names stay as written.
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let named = after.find('}').map(|close| (&after[..close], &after[close + 1..]));
        match named.and_then(|(name, tail)| values.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value, tail))) {
            Some((value, tail)) => {
                out.push_str(value);
                rest = tail;
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// A whole message as its title (first line) and body (the rest, blank
/// lines around it dropped).
pub(crate) fn split(message: &str) -> (String, String) {
    let message = message.trim();
    match message.split_once('\n') {
        Some((title, body)) => (title.trim().to_owned(), body.trim().to_owned()),
        None => (message.to_owned(), String::new()),
    }
}

/// A title and body as one commit message.
pub(crate) fn compose(title: &str, body: &str) -> String {
    let (title, body) = (title.trim(), body.trim());
    if body.is_empty() { title.to_owned() } else { format!("{title}\n\n{body}") }
}

/// The message a merger wrote, over the default: a title they give
/// replaces the default's, a body they give (even empty) replaces its body.
/// Or why it cannot be used.
pub(crate) fn chosen(
    default: Option<(String, String)>,
    title: Option<&str>,
    body: Option<&str>,
) -> std::result::Result<Option<String>, &'static str> {
    let Some((default_title, default_body)) = default else {
        return Ok(None);
    };
    let title = match title.map(str::trim) {
        Some("") => return Err("A commit title is required."),
        Some(title) if title.chars().count() > MAX_TITLE_CHARS => return Err("That commit title is too long."),
        Some(title) if title.contains('\n') => return Err("A commit title is one line; put the rest in the message."),
        Some(title) => title.to_owned(),
        None => default_title,
    };
    let body = match body {
        Some(body) if body.chars().count() > MAX_MESSAGE_CHARS => return Err("That commit message is too long."),
        Some(body) => body.to_owned(),
        None => default_body,
    };
    Ok(Some(compose(&title, &body)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(message: &str, email: &str) -> CommitText {
        CommitText { message: message.into(), author_email: Some(email.into()) }
    }

    fn facts<'a>(commits: &'a [CommitText], issues: &'a [u32]) -> MessageFacts<'a> {
        MessageFacts {
            number: 12,
            title: "Add forks ",
            body: "Forks are ordinary repositories.\n",
            branch: "forks",
            head_owner: "ana",
            head_repo: "ana/g1t",
            base: "main",
            author: "ana",
            commits,
            issues,
        }
    }

    fn with(merge: CommitMessageDefault, squash: CommitMessageDefault) -> RepoSettings {
        RepoSettings { merge_commit_message: merge, squash_commit_message: squash, ..RepoSettings::default() }
    }

    fn message(method: MergeMethod, settings: &RepoSettings, facts: &MessageFacts<'_>) -> (String, String) {
        default_message(method, settings, facts).expect("a commit of its own")
    }

    #[test]
    fn a_merge_commit_names_where_it_came_from_by_default() {
        let none = [];
        let settings = RepoSettings::default();
        assert_eq!(
            message(MergeMethod::Merge, &settings, &facts(&none, &[])),
            ("Merge pull request #12 from ana/forks".into(), "Add forks".into())
        );
        let titled = with(CommitMessageDefault::PullTitle, CommitMessageDefault::Default);
        assert_eq!(message(MergeMethod::Merge, &titled, &facts(&none, &[])), ("Add forks (#12)".into(), String::new()));
        let described = with(CommitMessageDefault::PullTitleAndDescription, CommitMessageDefault::Default);
        assert_eq!(
            message(MergeMethod::Merge, &described, &facts(&none, &[])),
            ("Add forks (#12)".into(), "Forks are ordinary repositories.".into())
        );
    }

    #[test]
    fn a_squash_lists_its_commits_when_it_has_more_than_one() {
        let settings = RepoSettings::default();
        let one = [commit("Add forks\n\nLong story.", "ana@example.com")];
        assert_eq!(message(MergeMethod::Squash, &settings, &facts(&one, &[])), ("Add forks (#12)".into(), String::new()));
        let two = [commit("Add forks\n\nLong story.", "ana@example.com"), commit("Fix the test", "bo@example.com")];
        assert_eq!(
            message(MergeMethod::Squash, &settings, &facts(&two, &[])),
            ("Add forks (#12)".into(), "* Add forks\n* Fix the test".into())
        );
        let all = with(CommitMessageDefault::Default, CommitMessageDefault::PullTitleAndCommits);
        assert_eq!(
            message(MergeMethod::Squash, &all, &facts(&two, &[])),
            ("Add forks (#12)".into(), "Add forks\n\nLong story.\n\nFix the test".into())
        );
        let described = with(CommitMessageDefault::Default, CommitMessageDefault::PullTitleAndDescription);
        assert_eq!(message(MergeMethod::Squash, &described, &facts(&two, &[])).1, "Forks are ordinary repositories.");
    }

    #[test]
    fn rebases_and_fast_forwards_make_no_message() {
        let settings = RepoSettings::default();
        assert!(default_message(MergeMethod::Rebase, &settings, &facts(&[], &[])).is_none());
        assert!(default_message(MergeMethod::FastForward, &settings, &facts(&[], &[])).is_none());
        assert!(!needs_commits(MergeMethod::Rebase, &settings));
    }

    #[test]
    fn a_template_is_filled_in_once() {
        let commits = [commit("One", "ana@example.com"), commit("Two", "Ana@Example.com"), commit("Three", "bo@example.com")];
        let settings = RepoSettings {
            squash_commit_message: CommitMessageDefault::Custom,
            squash_commit_template: Some(
                "{title} (#{number}) into {base}\n\n{body}\nFrom {head_repo}:{branch} by {author}\n{commits}\nCloses {issues}\n{co_authors}\n{unknown} {title"
                    .into(),
            ),
            ..RepoSettings::default()
        };
        let (title, body) = message(MergeMethod::Squash, &settings, &facts(&commits, &[3, 4]));
        assert_eq!(title, "Add forks (#12) into main");
        assert_eq!(
            body,
            "Forks are ordinary repositories.\nFrom ana/g1t:forks by ana\n* One\n* Two\n* Three\nCloses #3, #4\nCo-authored-by: ana <ana@example.com>\nCo-authored-by: bo <bo@example.com>\n{unknown} {title"
        );
        assert!(needs_commits(MergeMethod::Squash, &settings));
        // A value holding a placeholder is not filled in again.
        let tricky = MessageFacts { title: "{body}", ..facts(&[], &[]) };
        let echo = RepoSettings { merge_commit_message: CommitMessageDefault::Custom, merge_commit_template: Some("{title}".into()), ..RepoSettings::default() };
        assert_eq!(message(MergeMethod::Merge, &echo, &tricky).0, "{body}");
        // A template that fills in nothing falls back to the default.
        let empty = RepoSettings { merge_commit_message: CommitMessageDefault::Custom, merge_commit_template: Some("{body}".into()), ..RepoSettings::default() };
        let blank = MessageFacts { body: "", ..facts(&[], &[]) };
        assert_eq!(message(MergeMethod::Merge, &empty, &blank).0, "Merge pull request #12 from ana/forks");
        assert!(!needs_commits(MergeMethod::Merge, &echo));
    }

    #[test]
    fn what_the_merger_writes_wins() {
        let default = Some(("Add forks (#12)".to_owned(), "* One".to_owned()));
        assert_eq!(chosen(default.clone(), None, None), Ok(Some("Add forks (#12)\n\n* One".into())));
        assert_eq!(chosen(default.clone(), Some(" Mine "), None), Ok(Some("Mine\n\n* One".into())));
        assert_eq!(chosen(default.clone(), None, Some("")), Ok(Some("Add forks (#12)".into())));
        assert_eq!(chosen(default.clone(), Some("Mine"), Some("Why\n")), Ok(Some("Mine\n\nWhy".into())));
        assert!(chosen(default.clone(), Some("  "), None).is_err());
        assert!(chosen(default.clone(), Some("a\nb"), None).is_err());
        assert!(chosen(default.clone(), Some(&"x".repeat(MAX_TITLE_CHARS + 1)), None).is_err());
        // Nothing to write for a rebase or fast-forward.
        assert_eq!(chosen(None, Some("Mine"), None), Ok(None));
    }

    #[test]
    fn a_message_splits_into_title_and_body() {
        assert_eq!(split("Title\n\n\nBody\n"), ("Title".into(), "Body".into()));
        assert_eq!(split(" Title "), ("Title".into(), String::new()));
        assert_eq!(compose("Title", "  "), "Title");
    }
}
