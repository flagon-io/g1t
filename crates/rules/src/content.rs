//! Rules about what commits bring: their messages and addresses, their
//! signatures and parents, and the files they change. The same checks hold
//! for a push and for the commits a pull request lands.

use g1t_contracts::rules::{CommitFacts, PatternRule, Rule, Signature};

use crate::{glob, text};

/// One problem a rule found, and how to fix it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    pub message: String,
    pub remedy: String,
}

impl Problem {
    pub fn new(message: impl Into<String>, remedy: impl Into<String>) -> Problem {
        Problem { message: message.into(), remedy: remedy.into() }
    }
}

/// The most problems one rule reports; the rest are counted.
const MAX_PROBLEMS: usize = 5;

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

/// Whether a rule is about what commits bring, and so needs them read.
pub fn about_content(rule: &Rule) -> bool {
    matches!(
        rule,
        Rule::RequiredLinearHistory(_)
            | Rule::RequiredSignatures(_)
            | Rule::CommitMessagePattern(_)
            | Rule::CommitAuthorEmailPattern(_)
            | Rule::CommitterEmailPattern(_)
            | Rule::FilePathRestriction(_)
            | Rule::FileExtensionRestriction(_)
            | Rule::MaxFileSize(_)
            | Rule::MaxFilePathLength(_)
            | Rule::MaxFilesChanged(_)
            | Rule::SecretScanning(_)
    )
}

fn capped(mut problems: Vec<Problem>) -> Vec<Problem> {
    if problems.len() > MAX_PROBLEMS {
        let more = problems.len() - (MAX_PROBLEMS - 1);
        problems.truncate(MAX_PROBLEMS - 1);
        let remedy = problems[0].remedy.clone();
        problems.push(Problem::new(format!("…and {more} more like it."), remedy));
    }
    problems
}

fn pattern_problems(
    rule: &PatternRule,
    commits: &[CommitFacts],
    what: &str,
    read: impl Fn(&CommitFacts) -> Option<&str>,
) -> Vec<Problem> {
    let compiled = match text::compile(rule) {
        Ok(compiled) => compiled,
        // Saved rules compile; one that no longer does refuses nothing.
        Err(_) => return Vec::new(),
    };
    let remedy = format!("Rewrite the commits so each {what} {}, then push again.", compiled.wants());
    commits
        .iter()
        .filter(|commit| !compiled.allows(read(commit).unwrap_or_default()))
        .map(|commit| Problem::new(format!("Commit {} has a {what} that does not {}.", short(&commit.sha), compiled.wants()), remedy.clone()))
        .collect()
}

/// The extension of a path, lowercase with its dot: `.exe`. Empty without.
fn extension(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(0) | None => String::new(),
        Some(at) => name[at..].to_lowercase(),
    }
}

/// The problems `rule` finds in `commits`. `complete` says whether they
/// are everything the change brings, each read in full: content rules
/// cannot be met by a change too large to read.
pub fn problems(rule: &Rule, commits: &[CommitFacts], complete: bool) -> Vec<Problem> {
    if !about_content(rule) {
        return Vec::new();
    }
    if !complete {
        return vec![Problem::new(
            "The change is too large for g1t to check against this rule.",
            "Split it into smaller pushes or pull requests.",
        )];
    }
    let found = match rule {
        Rule::RequiredLinearHistory(_) => commits
            .iter()
            .filter(|commit| commit.parents > 1)
            .map(|commit| {
                Problem::new(
                    format!("Commit {} is a merge commit; this branch keeps a linear history.", short(&commit.sha)),
                    "Rebase onto the branch instead of merging it in, then push again.",
                )
            })
            .collect(),
        Rule::RequiredSignatures(_) => commits
            .iter()
            .filter_map(|commit| match &commit.signature {
                Signature::Verified { .. } => None,
                Signature::Unsigned => Some(Problem::new(
                    format!("Commit {} is not signed.", short(&commit.sha)),
                    "Sign your commits with an SSH key registered on your g1t account (git config gpg.format ssh; git commit -S), then push again.",
                )),
                Signature::Unverified { reason } => Some(Problem::new(
                    format!("Commit {}'s signature could not be verified: {reason}", short(&commit.sha)),
                    "Sign with an SSH key registered on the g1t account that owns the committer's verified email address.",
                )),
            })
            .collect(),
        Rule::CommitMessagePattern(pattern) => pattern_problems(pattern, commits, "message", |commit| Some(&commit.message)),
        Rule::CommitAuthorEmailPattern(pattern) => {
            pattern_problems(pattern, commits, "author email", |commit| commit.author_email.as_deref())
        }
        Rule::CommitterEmailPattern(pattern) => {
            pattern_problems(pattern, commits, "committer email", |commit| commit.committer_email.as_deref())
        }
        Rule::FilePathRestriction(paths) => commits
            .iter()
            .flat_map(|commit| {
                commit.files.iter().filter_map(move |file| {
                    paths
                        .restricted_file_paths
                        .iter()
                        .find(|pattern| glob::path_matches(pattern, &file.path))
                        .map(|pattern| {
                            Problem::new(
                                format!("Commit {} changes {}, which matches the restricted path {pattern}.", short(&commit.sha), file.path),
                                "Leave restricted paths unchanged, or ask someone who may bypass this ruleset.",
                            )
                        })
                })
            })
            .collect(),
        Rule::FileExtensionRestriction(extensions) => {
            let restricted: Vec<String> = extensions
                .restricted_file_extensions
                .iter()
                .map(|extension| {
                    let extension = extension.trim().to_lowercase();
                    if extension.starts_with('.') { extension } else { format!(".{extension}") }
                })
                .collect();
            commits
                .iter()
                .flat_map(|commit| {
                    let restricted = &restricted;
                    commit.files.iter().filter(|file| !file.deleted).filter_map(move |file| {
                        let found = extension(&file.path);
                        (!found.is_empty() && restricted.contains(&found)).then(|| {
                            Problem::new(
                                format!("Commit {} adds {}, and {found} files are not allowed.", short(&commit.sha), file.path),
                                "Remove the file from the commits (git rm --cached, then amend or rebase).",
                            )
                        })
                    })
                })
                .collect()
        }
        Rule::MaxFileSize(limit) => {
            let max = u64::from(limit.max_file_size_mb) * 1024 * 1024;
            commits
                .iter()
                .flat_map(|commit| {
                    commit.files.iter().filter(|file| file.size.is_some_and(|size| size > max)).map(move |file| {
                        Problem::new(
                            format!(
                                "Commit {} adds {} at {:.1} MB; files may be at most {} MB.",
                                short(&commit.sha),
                                file.path,
                                file.size.unwrap_or(0) as f64 / (1024.0 * 1024.0),
                                limit.max_file_size_mb
                            ),
                            "Take the file out of the commits, and keep large files in a package or release instead.",
                        )
                    })
                })
                .collect()
        }
        Rule::MaxFilePathLength(limit) => commits
            .iter()
            .flat_map(|commit| {
                commit
                    .files
                    .iter()
                    .filter(|file| !file.deleted && file.path.chars().count() > limit.max_file_path_length as usize)
                    .map(move |file| {
                        Problem::new(
                            format!(
                                "Commit {} adds a path {} characters long; paths may be at most {}.",
                                short(&commit.sha),
                                file.path.chars().count(),
                                limit.max_file_path_length
                            ),
                            "Use a shorter path.",
                        )
                    })
            })
            .collect(),
        Rule::MaxFilesChanged(limit) => commits
            .iter()
            .filter(|commit| !commit.files_complete || commit.files.len() > limit.max_files as usize)
            .map(|commit| {
                Problem::new(
                    format!("Commit {} changes more than {} files.", short(&commit.sha), limit.max_files),
                    "Split the change into smaller commits.",
                )
            })
            .collect(),
        // Secrets are push protection's to find; this rule only asks that
        // every push be read whole, which `complete` said it was.
        _ => Vec::new(),
    };
    capped(found)
}

#[cfg(test)]
pub(crate) mod tests_support {
    use g1t_contracts::rules::{CommitFacts, FileChange, Signature};

    /// A commit by ada@acme.com changing `files`, 10 bytes each.
    pub(crate) fn commit(sha: &str, message: &str, files: &[&str]) -> CommitFacts {
        CommitFacts {
            sha: sha.into(),
            message: message.into(),
            author_email: Some("ada@acme.com".into()),
            committer_email: Some("ada@acme.com".into()),
            parents: 1,
            signature: Signature::Unsigned,
            files: files.iter().map(|path| FileChange { path: (*path).into(), size: Some(10), deleted: false }).collect(),
            files_complete: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::commit;
    use super::*;
    use g1t_contracts::rules::{
        FileExtensionRule, FilePathRule, MaxFilePathLengthRule, MaxFileSizeRule, MaxFilesChangedRule, NoParameters,
        PatternOperator,
    };

    #[test]
    fn merge_commits_break_linear_history() {
        let mut merge = commit("aaaaaaaaaa", "Merge main", &[]);
        merge.parents = 2;
        let found = problems(&Rule::RequiredLinearHistory(NoParameters {}), &[commit("b", "x", &[]), merge], true);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].message, "Commit aaaaaaa is a merge commit; this branch keeps a linear history.");
    }

    #[test]
    fn only_verified_signatures_meet_the_signature_rule() {
        let mut signed = commit("s", "x", &[]);
        signed.signature = Signature::Verified { signer: "ada".into() };
        let mut bad = commit("u", "x", &[]);
        bad.signature = Signature::Unverified { reason: "GPG signatures are not verified yet.".into() };
        let found = problems(&Rule::RequiredSignatures(NoParameters {}), &[signed, bad, commit("n", "x", &[])], true);
        assert_eq!(found.len(), 2);
        assert!(found[0].message.contains("could not be verified: GPG"));
        assert!(found[1].message.contains("is not signed"));
    }

    #[test]
    fn message_and_address_patterns_check_every_commit() {
        let conventional = PatternRule { name: String::new(), operator: PatternOperator::Regex, pattern: "^(feat|fix): ".into(), negate: false };
        let found = problems(&Rule::CommitMessagePattern(conventional), &[commit("a1", "feat: x", &[]), commit("b2", "stuff", &[])], true);
        assert_eq!(found.len(), 1);
        assert!(found[0].message.starts_with("Commit b2 has a message that does not match"));
        let domain = PatternRule { name: String::new(), operator: PatternOperator::EndsWith, pattern: "@acme.com".into(), negate: false };
        let mut outsider = commit("c3", "x", &[]);
        outsider.author_email = Some("eve@example.com".into());
        assert_eq!(problems(&Rule::CommitAuthorEmailPattern(domain.clone()), &[outsider.clone()], true).len(), 1);
        assert!(problems(&Rule::CommitterEmailPattern(domain), &[outsider], true).is_empty());
    }

    #[test]
    fn restricted_paths_extensions_sizes_and_lengths() {
        let paths = Rule::FilePathRestriction(FilePathRule { restricted_file_paths: vec![".g1t/workflows/**".into(), "CODEOWNERS".into()] });
        let change = commit("a", "x", &["src/a.rs", ".g1t/workflows/ci.yml", "docs/CODEOWNERS"]);
        assert_eq!(problems(&paths, &[change.clone()], true).len(), 2);
        let extensions = Rule::FileExtensionRestriction(FileExtensionRule { restricted_file_extensions: vec!["exe".into(), ".ZIP".into()] });
        let binaries = commit("b", "x", &["tool.exe", "a.zip", "README", ".env"]);
        assert_eq!(problems(&extensions, &[binaries], true).len(), 2);
        let mut big = commit("c", "x", &["video.mp4"]);
        big.files[0].size = Some(30 * 1024 * 1024);
        let found = problems(&Rule::MaxFileSize(MaxFileSizeRule { max_file_size_mb: 10 }), &[big], true);
        assert_eq!(found[0].message, "Commit c adds video.mp4 at 30.0 MB; files may be at most 10 MB.");
        let long = commit("d", "x", &[&"a/".repeat(200)]);
        assert_eq!(problems(&Rule::MaxFilePathLength(MaxFilePathLengthRule { max_file_path_length: 255 }), &[long], true).len(), 1);
        let many = commit("e", "x", &["1", "2", "3"]);
        assert_eq!(problems(&Rule::MaxFilesChanged(MaxFilesChangedRule { max_files: 2 }), &[many.clone()], true).len(), 1);
        assert!(problems(&Rule::MaxFilesChanged(MaxFilesChangedRule { max_files: 3 }), &[many], true).is_empty());
    }

    #[test]
    fn deleting_a_file_still_changes_a_restricted_path_but_adds_no_extension() {
        let mut gone = commit("a", "x", &["CODEOWNERS", "tool.exe"]);
        for file in &mut gone.files {
            file.deleted = true;
        }
        assert_eq!(problems(&Rule::FilePathRestriction(FilePathRule { restricted_file_paths: vec!["CODEOWNERS".into()] }), &[gone.clone()], true).len(), 1);
        assert!(problems(&Rule::FileExtensionRestriction(FileExtensionRule { restricted_file_extensions: vec!["exe".into()] }), &[gone], true).is_empty());
    }

    #[test]
    fn a_change_too_large_to_read_cannot_meet_a_content_rule() {
        let found = problems(&Rule::SecretScanning(NoParameters {}), &[], false);
        assert_eq!(found[0].message, "The change is too large for g1t to check against this rule.");
        assert!(problems(&Rule::SecretScanning(NoParameters {}), &[], true).is_empty());
        assert!(problems(&Rule::Deletion(NoParameters {}), &[], false).is_empty(), "not a content rule");
    }

    #[test]
    fn many_problems_are_summed_up() {
        let commits: Vec<CommitFacts> = (0..20).map(|n| commit(&format!("c{n}"), "x", &[])).collect();
        let found = problems(&Rule::RequiredSignatures(NoParameters {}), &commits, true);
        assert_eq!(found.len(), 5);
        assert_eq!(found[4].message, "…and 16 more like it.");
    }
}
