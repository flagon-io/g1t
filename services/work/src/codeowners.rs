//! CODEOWNERS on pull requests (`g1t_contracts::codeowners`).
//!
//! **Which file.** The one on the branch a pull request merges into, the
//! first of `.g1t/CODEOWNERS`, `.github/CODEOWNERS`, `CODEOWNERS`,
//! `docs/CODEOWNERS` and `.gitlab/CODEOWNERS` that exists. A file over
//! 3 MB is ignored as a whole, and says so in its errors.
//!
//! **Owners.** Identity resolves each owner the file names (`resolve_owners`):
//! people, teams of the repository's workspace (with everyone in their
//! child teams) and confirmed email addresses, each needing the Write role
//! or higher. An owner that does not resolve, or cannot write, is an error
//! of the file and owns nothing; a rule left with no owner that resolves
//! asks for no review. `@g1t` is g1t's agent, which counts only where the
//! file names `@g1t` itself.
//!
//! **Reviews.** When a pull request is opened, marked ready, or pushed to,
//! the owners of the files it changes are asked to review it, once each:
//! people as reviewers, teams as team reviewers (team_reviews.rs). Drafts
//! are asked once they are ready. g1t's agent is never asked this way.
//! What was worked out is kept (`pull_code_owners`) for the pull request's
//! page.
//!
//! **Merging.** With `require_code_owner_review` on, merging waits until
//! every rule that owns a changed file has the approvals its section asks
//! for (one by default) from its owners, and no code owner has asked for
//! changes. The pull request's author, or whoever asked g1t for it, never
//! counts. The rule is worked out afresh from the file as it is at merge
//! time, for people and agents alike, and for the merge queue.
//!
//! **The check.** A pull request that changes a CODEOWNERS file gets a
//! status, `g1t / codeowners`, on its head: a failure naming how many
//! lines have errors, or a success.

use std::collections::HashMap;

use base64::Engine;
use g1t_contracts::codeowners::{
    self, CodeOwners, CodeOwnersErrorsArgs, CodeOwnersReport, LineError, Owner, OwnerCheck, PullCodeOwners, Requirement,
};
use g1t_contracts::repos::{BlobArgs, BlobView, GetByIdArgs, RawFile, RawFileArgs, Repo, RepoPath};
use g1t_contracts::teams::{ResolveOwnersArgs, ResolvedOwner};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{Comment, Pull, PullStatus, RepoSettings, SetCommitStatusArgs, Verdict};
use g1t_contracts::{FailureCode, Outcome, User, Viewer};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;

/// The status a pull request that changes a CODEOWNERS file gets.
pub(crate) const CHECK: &str = "g1t / codeowners";

/// A CODEOWNERS file as read from a branch.
pub(crate) struct Read {
    pub path: String,
    pub size: u64,
    /// Null when it is over the limit.
    pub text: Option<String>,
}

/// A file read and checked: what it says, who its owners are, and every
/// problem with it.
pub(crate) struct Checked {
    pub path: String,
    pub size: u64,
    pub file: CodeOwners,
    pub resolved: Vec<ResolvedOwner>,
    pub errors: Vec<LineError>,
}

impl Checked {
    /// Who answers for each owner that resolved.
    pub fn members(&self) -> HashMap<String, Vec<String>> {
        members_of(&self.resolved)
    }
}

/// Who answers for each owner (by its text, `@acme/backend`) that
/// resolved; owners that did not are left out, so they own nothing.
pub(crate) fn members_of(resolved: &[ResolvedOwner]) -> HashMap<String, Vec<String>> {
    resolved
        .iter()
        .filter(|owner| owner.check == OwnerCheck::Ok)
        .map(|owner| (owner.owner.text(), owner.members.clone()))
        .collect()
}

/// The requirements with only owners that resolved, dropping any left
/// with none.
pub(crate) fn answerable(requirements: Vec<Requirement>, members: &HashMap<String, Vec<String>>) -> Vec<Requirement> {
    requirements
        .into_iter()
        .filter_map(|mut requirement| {
            requirement.owners.retain(|owner| members.contains_key(&owner.text()));
            (!requirement.owners.is_empty()).then_some(requirement)
        })
        .collect()
}

/// Each reviewer's latest verdict, by username, in the order they last gave
/// one.
pub(crate) fn latest_verdicts(comments: &[Comment]) -> Vec<codeowners::Verdict> {
    let mut latest: Vec<codeowners::Verdict> = Vec::new();
    for comment in comments {
        let Some(verdict) = comment.verdict else {
            continue;
        };
        let username = comment.author.username.to_lowercase();
        latest.retain(|had| had.username != username);
        latest.push(codeowners::Verdict {
            username,
            approved: verdict == Verdict::Approve,
        });
    }
    latest
}

/// Where the reviews a pull request needs stand.
pub(crate) fn standing(
    path: &str,
    required: bool,
    requirements: &[Requirement],
    members: &HashMap<String, Vec<String>>,
    verdicts: &[codeowners::Verdict],
    author: &str,
    errors: u32,
) -> PullCodeOwners {
    let lookup = |owner: &Owner| members.get(&owner.text()).cloned().unwrap_or_default();
    let reviews = codeowners::evaluate(requirements, &lookup, verdicts, author);
    PullCodeOwners {
        path: path.to_owned(),
        required,
        missing: codeowners::missing(&reviews),
        reviews,
        errors,
    }
}

/// Who to ask to review: the people and teams owning what changed, not yet
/// asked by g1t before, not already reviewers, never the author or g1t.
pub(crate) fn to_ask(
    requirements: &[Requirement],
    resolved: &[ResolvedOwner],
    author: &str,
    reviewers: &[String],
    team_reviewers: &[String],
    asked_before: &[String],
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut people: Vec<String> = Vec::new();
    let mut teams: Vec<String> = Vec::new();
    let mut owners: Vec<String> = Vec::new();
    for requirement in requirements {
        for owner in &requirement.owners {
            let text = owner.text();
            if asked_before.contains(&text) || owners.contains(&text) {
                continue;
            }
            let Some(found) = resolved.iter().find(|found| found.owner == *owner && found.check == OwnerCheck::Ok) else {
                continue;
            };
            match owner {
                Owner::Team { .. } => {
                    let Some(team) = &found.team else { continue };
                    owners.push(text);
                    if !team_reviewers.contains(team) && !teams.contains(team) {
                        teams.push(team.clone());
                    }
                }
                Owner::User { .. } | Owner::Email { .. } => {
                    let Some(name) = found.members.first() else { continue };
                    if name == g1t_contracts::identity::AGENT_NAME {
                        continue;
                    }
                    owners.push(text);
                    if !name.eq_ignore_ascii_case(author) && !reviewers.contains(name) && !people.contains(name) {
                        people.push(name.clone());
                    }
                }
            }
        }
    }
    (people, teams, owners)
}

#[derive(Deserialize)]
struct SnapshotRow {
    path: String,
    requirements: String,
    members: String,
    errors: u32,
    requested: String,
}

impl Work {
    /// The CODEOWNERS file of `path` at `git_ref`, if there is one.
    pub(crate) async fn read_codeowners(&self, repo_id: &str, path: &RepoPath, git_ref: &str, viewer: &Viewer) -> Result<Option<Read>> {
        for location in codeowners::LOCATIONS {
            let found: Outcome<BlobView> = g1t_kit::call(
                &self.repos,
                "blob",
                &BlobArgs {
                    path: path.clone(),
                    viewer: viewer.clone(),
                    git_ref: git_ref.to_owned(),
                    file_path: location.to_owned(),
                },
            )
            .await?;
            let Outcome::Ok(blob) = found else {
                continue;
            };
            if blob.size as usize > codeowners::MAX_BYTES {
                return Ok(Some(Read {
                    path: location.to_owned(),
                    size: blob.size,
                    text: None,
                }));
            }
            let text = match blob.text {
                Some(text) => Some(text),
                // Longer than a page shows: read it whole.
                None => {
                    let raw: Option<RawFile> = g1t_kit::call(
                        &self.repos,
                        "raw_file",
                        &RawFileArgs {
                            repo_id: repo_id.to_owned(),
                            git_ref: git_ref.to_owned(),
                            path: location.to_owned(),
                            max_bytes: codeowners::MAX_BYTES as u32,
                        },
                    )
                    .await?;
                    raw.and_then(|raw| base64::engine::general_purpose::STANDARD.decode(raw.data).ok())
                        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                }
            };
            return Ok(Some(Read {
                path: location.to_owned(),
                size: blob.size,
                text: Some(text.unwrap_or_default()),
            }));
        }
        Ok(None)
    }

    /// Reads, parses and resolves the CODEOWNERS file of a repository at
    /// `git_ref`. `owners_repo` is the repository whose access the owners
    /// are checked against (the pull request's target, for a head read
    /// from a fork).
    pub(crate) async fn check_codeowners(
        &self,
        repo_id: &str,
        path: &RepoPath,
        git_ref: &str,
        viewer: &Viewer,
        owners_repo: (&str, &str),
    ) -> Result<Option<Checked>> {
        let Some(read) = self.read_codeowners(repo_id, path, git_ref, viewer).await? else {
            return Ok(None);
        };
        let file = match &read.text {
            Some(text) => codeowners::parse(text),
            None => codeowners::parse(&" ".repeat(codeowners::MAX_BYTES + 1)),
        };
        let owners = file.owners();
        let resolved: Vec<ResolvedOwner> = if owners.is_empty() {
            Vec::new()
        } else {
            g1t_kit::call(
                &self.identity,
                "resolve_owners",
                &ResolveOwnersArgs {
                    repo_id: owners_repo.0.to_owned(),
                    workspace: owners_repo.1.to_owned(),
                    owners,
                },
            )
            .await?
        };
        let checks: HashMap<Owner, OwnerCheck> = resolved.iter().map(|found| (found.owner.clone(), found.check)).collect();
        let mut errors = file.errors.clone();
        errors.extend(codeowners::check_owners(&file, &|owner| checks.get(owner).copied().unwrap_or(OwnerCheck::Ok)));
        errors.sort_by(|a, b| a.line.cmp(&b.line).then_with(|| a.token.cmp(&b.token)));
        Ok(Some(Checked {
            path: read.path,
            size: read.size,
            file,
            resolved,
            errors,
        }))
    }

    async fn repo_by_id(&self, repo_id: &str, namespace: &str) -> Result<Option<Repo>> {
        let found: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: repo_id.to_owned(),
                viewer: Some(User::system(namespace)),
            },
        )
        .await?;
        Ok(match found {
            Outcome::Ok(repo) => Some(repo),
            Outcome::Fail(_) => None,
        })
    }

    /// The target repository of a pull request, as g1t reads it.
    async fn target_of(&self, pull: &Pull) -> Result<Option<Repo>> {
        let path: Option<RepoPath> = g1t_kit::call(
            &self.repos,
            "path_by_id",
            &g1t_contracts::repos::PathByIdArgs { id: pull.repo_id.clone() },
        )
        .await?;
        let Some(path) = path else {
            return Ok(None);
        };
        self.repo_by_id(&pull.repo_id, &path.namespace).await
    }

    /// The pull request's code owners worked out afresh from the branch it
    /// merges into: the file, and the reviews the changed files need.
    async fn fresh_requirements(&self, repo: &Repo, pull: &Pull) -> Result<Option<(Checked, Vec<Requirement>)>> {
        let path = RepoPath {
            namespace: repo.namespace.clone(),
            name: repo.name.clone(),
        };
        let viewer = Some(User::system(&repo.namespace));
        let Some(checked) = self
            .check_codeowners(&repo.id, &path, &repo.default_branch, &viewer, (&repo.id, &repo.namespace))
            .await?
        else {
            return Ok(None);
        };
        let files: Vec<String> = pull.files.iter().map(|file| file.path.clone()).collect();
        let requirements = answerable(checked.file.requirements(&files), &checked.members());
        Ok(Some((checked, requirements)))
    }

    /// Works out a pull request's code owners after it opened, was marked
    /// ready or moved, keeps it for its page, asks them to review, and
    /// checks a CODEOWNERS file it changes. Never fails what set it off: a
    /// problem is logged.
    pub(crate) async fn refresh_code_owners(&self, pull: &Pull) {
        if let Err(error) = self.try_refresh_code_owners(pull).await {
            worker::console_error!("code owners of {} not worked out: {error}", pull.id);
        }
    }

    async fn try_refresh_code_owners(&self, pull: &Pull) -> Result<()> {
        if !pull.status.is_active() {
            return Ok(());
        }
        let Some(repo) = self.target_of(pull).await? else {
            return Ok(());
        };
        let mut pull = pull.clone();
        if pull.files.is_empty() && pull.head_commit.is_some() {
            pull.files = self.refresh_files(&pull).await?;
        }
        self.check_changed_codeowners(&repo, &pull).await?;
        let Some((checked, requirements)) = self.fresh_requirements(&repo, &pull).await? else {
            self.db
                .prepare("DELETE FROM pull_code_owners WHERE pull_id = ?")
                .bind(&[pull.id.as_str().into()])?
                .run()
                .await?;
            return Ok(());
        };
        let before = self
            .db
            .prepare("SELECT * FROM pull_code_owners WHERE pull_id = ?")
            .bind(&[pull.id.as_str().into()])?
            .first::<SnapshotRow>(None)
            .await?;
        let mut asked_before: Vec<String> = before
            .as_ref()
            .and_then(|row| serde_json::from_str(&row.requested).ok())
            .unwrap_or_default();
        // A draft is asked once it is ready.
        if pull.status == PullStatus::Open {
            let (people, teams, owners) = to_ask(
                &requirements,
                &checked.resolved,
                &pull.owner().username,
                &pull.reviewers,
                &pull.team_reviewers,
                &asked_before,
            );
            if !people.is_empty() || !teams.is_empty() {
                self.ask_reviewers(&pull, people, teams, None, true).await?;
            }
            asked_before.extend(owners);
        }
        self.db
            .prepare(
                "INSERT INTO pull_code_owners (pull_id, path, requirements, members, errors, requested, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (pull_id) DO UPDATE SET path = excluded.path, requirements = excluded.requirements,
                   members = excluded.members, errors = excluded.errors, requested = excluded.requested,
                   updated_at = excluded.updated_at",
            )
            .bind(&[
                pull.id.as_str().into(),
                checked.path.as_str().into(),
                serde_json::to_string(&requirements)?.into(),
                serde_json::to_string(&checked.members())?.into(),
                (checked.errors.len() as u32).into(),
                serde_json::to_string(&asked_before)?.into(),
                rfc3339(now_ms()).into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    /// A pull request that changes a CODEOWNERS file: the file as its head
    /// has it, checked, reported as a status on the head.
    async fn check_changed_codeowners(&self, repo: &Repo, pull: &Pull) -> Result<()> {
        let Some(head) = pull.head_commit.as_deref() else {
            return Ok(());
        };
        let Some(changed) = pull
            .files
            .iter()
            .find(|file| codeowners::is_codeowners_path(&file.path))
            .map(|file| file.path.clone())
        else {
            return Ok(());
        };
        let (source_id, source) = match (&pull.fork_repo_id, &pull.fork) {
            (Some(id), Some(fork)) => (id.clone(), fork.clone()),
            _ => (
                repo.id.clone(),
                RepoPath {
                    namespace: repo.namespace.clone(),
                    name: repo.name.clone(),
                },
            ),
        };
        let viewer = self.owner_viewer(pull).await?;
        let checked = self
            .check_codeowners(&source_id, &source, head, &viewer, (&repo.id, &repo.namespace))
            .await?;
        let (state, description) = match &checked {
            // Deleted: nothing to check.
            None => ("success", format!("{changed} was removed")),
            Some(checked) if checked.errors.is_empty() => ("success", format!("{} has no errors", checked.path)),
            Some(checked) => {
                let lines = checked.errors.len();
                ("failure", format!("{} has {lines} {}", checked.path, if lines == 1 { "error" } else { "errors" }))
            }
        };
        // The pull request's own changes: its head may exist only in its fork.
        let target_url = checked
            .as_ref()
            .map(|_| format!("/{}/{}/pull/{}?tab=changes", repo.namespace, repo.name, pull.number));
        self.set_commit_status(SetCommitStatusArgs {
            repo_id: repo.id.clone(),
            sha: head.to_owned(),
            context: CHECK.to_owned(),
            state: state.to_owned(),
            description: Some(description),
            target_url,
            source: Some("g1t".to_owned()),
        })
        .await?;
        Ok(())
    }

    /// The pull request's code owners as last worked out, with where each
    /// review stands now.
    pub(crate) async fn pull_code_owners(&self, pull: &Pull, comments: &[Comment], settings: &RepoSettings) -> Result<Option<PullCodeOwners>> {
        let Some(row) = self
            .db
            .prepare("SELECT * FROM pull_code_owners WHERE pull_id = ?")
            .bind(&[pull.id.as_str().into()])?
            .first::<SnapshotRow>(None)
            .await?
        else {
            return Ok(None);
        };
        let requirements: Vec<Requirement> = serde_json::from_str(&row.requirements).unwrap_or_default();
        let members: HashMap<String, Vec<String>> = serde_json::from_str(&row.members).unwrap_or_default();
        Ok(Some(standing(
            &row.path,
            settings.require_code_owner_review,
            &requirements,
            &members,
            &latest_verdicts(comments),
            &pull.owner().username,
            row.errors,
        )))
    }

    /// What code owners still have to approve before the pull request may
    /// merge, worked out from the file as it is now; `None` when nothing,
    /// or when the repository does not require it.
    pub(crate) async fn code_owners_gap(&self, settings: &RepoSettings, pull: &Pull) -> Result<Option<String>> {
        if !settings.require_code_owner_review {
            return Ok(None);
        }
        let Some(repo) = self.target_of(pull).await? else {
            return Ok(None);
        };
        let Some((checked, requirements)) = self.fresh_requirements(&repo, pull).await? else {
            return Ok(None);
        };
        if requirements.is_empty() {
            return Ok(None);
        }
        let comments = self.comments_of(&pull.repo_id, pull.number).await?;
        let members = checked.members();
        let standing = standing(
            &checked.path,
            true,
            &requirements,
            &members,
            &latest_verdicts(&comments),
            &pull.owner().username,
            checked.errors.len() as u32,
        );
        Ok(standing
            .missing
            .map(|missing| format!("{missing} This repository requires code owners' approval before a pull request merges.")))
    }

    async fn comments_of(&self, repo_id: &str, number: u32) -> Result<Vec<Comment>> {
        Ok(self
            .db
            .prepare("SELECT * FROM comments WHERE repo_id = ? AND number = ? AND verdict IS NOT NULL ORDER BY id")
            .bind(&[repo_id.into(), number.into()])?
            .all()
            .await?
            .results::<crate::rows::CommentRow>()?
            .into_iter()
            .map(Comment::from)
            .collect())
    }

    /// `codeowners_errors`: the CODEOWNERS file of a repository at a
    /// branch, checked.
    pub(crate) async fn codeowners_errors(&self, a: CodeOwnersErrorsArgs) -> Result<Outcome<CodeOwnersReport>> {
        let repo = match self.repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let git_ref = a
            .git_ref
            .as_deref()
            .map(str::trim)
            .filter(|git_ref| !git_ref.is_empty())
            .unwrap_or(&repo.default_branch)
            .to_owned();
        if git_ref.len() > 255 {
            return Ok(Outcome::fail(FailureCode::Invalid, "That ref is too long."));
        }
        let path = RepoPath {
            namespace: repo.namespace.clone(),
            name: repo.name.clone(),
        };
        // Read as g1t: the viewer can read the repository, and the file
        // decides who owns it, whoever asks.
        let viewer = Some(User::system(&repo.namespace));
        let checked = self
            .check_codeowners(&repo.id, &path, &git_ref, &viewer, (&repo.id, &repo.namespace))
            .await?;
        Ok(Outcome::Ok(match checked {
            None => CodeOwnersReport {
                path: None,
                git_ref,
                ..CodeOwnersReport::default()
            },
            Some(checked) => {
                let mut sections: Vec<String> = Vec::new();
                for section in &checked.file.sections {
                    if !sections.contains(&section.name) {
                        sections.push(section.name.clone());
                    }
                }
                CodeOwnersReport {
                    path: Some(checked.path),
                    git_ref,
                    size: checked.size,
                    rules: checked.file.rules.len() as u32,
                    sections,
                    errors: checked.errors,
                }
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::work::CommentKind;

    fn resolved(owner: &str, check: OwnerCheck, members: &[&str], team: Option<&str>) -> ResolvedOwner {
        ResolvedOwner {
            owner: Owner::parse(owner).unwrap(),
            check,
            members: members.iter().map(|name| (*name).to_owned()).collect(),
            team: team.map(str::to_owned),
        }
    }

    fn comment(author: &str, verdict: Option<Verdict>) -> Comment {
        Comment {
            id: format!("cmt_{author}"),
            kind: CommentKind::Comment,
            author: User {
                id: format!("usr_{author}"),
                username: author.to_owned(),
                ..User::default()
            },
            body: String::new(),
            path: None,
            line: None,
            verdict,
            created_at: String::new(),
        }
    }

    const FILE: &str = "\
# Everything
*                @acme/platform
/src/api/        @acme/backend @ana
*.md             docs@example.com
/vendor/         @ghost
/infra/          @acme/infra @g1t

[Security][2] @acme/security
/src/auth/
";

    fn owners() -> Vec<ResolvedOwner> {
        vec![
            resolved("@acme/platform", OwnerCheck::Ok, &["pat", "quinn"], Some("acme/platform")),
            resolved("@acme/backend", OwnerCheck::Ok, &["bo", "cy", "dee"], Some("acme/backend")),
            resolved("@ana", OwnerCheck::Ok, &["ana"], None),
            resolved("docs@example.com", OwnerCheck::Ok, &["wren"], None),
            resolved("@ghost", OwnerCheck::UnknownUser, &[], None),
            resolved("@acme/infra", OwnerCheck::TeamNoAccess, &["ivy"], Some("acme/infra")),
            resolved("@g1t", OwnerCheck::Ok, &["g1t"], None),
            resolved("@acme/security", OwnerCheck::Ok, &["sam", "sky"], Some("acme/security")),
        ]
    }

    fn requirements(paths: &[&str]) -> Vec<Requirement> {
        let file = codeowners::parse(FILE);
        let paths: Vec<String> = paths.iter().map(|path| (*path).to_owned()).collect();
        answerable(file.requirements(&paths), &members_of(&owners()))
    }

    #[test]
    fn owners_that_do_not_resolve_own_nothing() {
        // Only @ghost owns vendor/: nothing to ask, nothing to wait for.
        assert!(requirements(&["vendor/lib.c"]).is_empty());
        // infra/: @acme/infra cannot write, so only @g1t is left.
        let infra = requirements(&["infra/main.tf"]);
        assert_eq!(infra.len(), 1);
        assert_eq!(infra[0].owners, vec![Owner::parse("@g1t").unwrap()]);
    }

    #[test]
    fn code_owners_are_asked_once_never_the_author_or_g1t() {
        let needed = requirements(&["src/api/users.rs", "README.md", "infra/main.tf", "src/auth/login.rs"]);
        let (people, teams, asked) = to_ask(&needed, &owners(), "ana", &[], &[], &[]);
        // ana wrote it; docs@example.com is wren; g1t is never asked.
        assert_eq!(people, vec!["wren"]);
        assert_eq!(teams, vec!["acme/platform", "acme/backend", "acme/security"]);
        assert!(asked.contains(&"@ana".to_owned()) && !asked.contains(&"@g1t".to_owned()));
        // Asked before, or already a reviewer: not again.
        let (people, teams, _) = to_ask(&needed, &owners(), "zed", &["ana".into()], &["acme/backend".into()], &asked);
        assert!(people.is_empty() && teams.is_empty());
        let (people, teams, _) = to_ask(&needed, &owners(), "zed", &["ana".into()], &["acme/backend".into()], &[]);
        assert_eq!(people, vec!["wren"]);
        assert_eq!(teams, vec!["acme/platform", "acme/security"]);
    }

    #[test]
    fn merging_waits_for_every_rule_and_each_sections_count() {
        let needed = requirements(&["src/api/users.rs", "src/auth/login.rs"]);
        let members = members_of(&owners());
        let check = |comments: &[Comment]| standing(".github/CODEOWNERS", true, &needed, &members, &latest_verdicts(comments), "zed", 0);
        assert!(check(&[]).missing.is_some());
        // A backend approval covers /src/api/; src/auth/ is the platform
        // team's in the default section, and security needs two.
        let one = check(&[comment("cy", Some(Verdict::Approve)), comment("sam", Some(Verdict::Approve))]);
        let missing = one.missing.unwrap();
        assert!(missing.contains("@acme/security"), "{missing}");
        assert!(missing.contains("@acme/platform"), "{missing}");
        assert!(!missing.contains("@acme/backend"), "{missing}");
        let done = check(&[
            comment("cy", Some(Verdict::Approve)),
            comment("pat", Some(Verdict::Approve)),
            comment("sam", Some(Verdict::Approve)),
            comment("sky", Some(Verdict::Approve)),
        ]);
        assert_eq!(done.missing, None);
        assert!(done.reviews.iter().all(|review| review.satisfied));
        // A code owner who asks for changes holds it until they approve.
        let changed = check(&[
            comment("cy", Some(Verdict::Approve)),
            comment("pat", Some(Verdict::Approve)),
            comment("sam", Some(Verdict::Approve)),
            comment("sky", Some(Verdict::Approve)),
            comment("dee", Some(Verdict::RequestChanges)),
        ]);
        assert!(changed.missing.is_some());
        let changed_back = [
            comment("dee", Some(Verdict::RequestChanges)),
            comment("cy", Some(Verdict::Approve)),
            comment("pat", Some(Verdict::Approve)),
            comment("sam", Some(Verdict::Approve)),
            comment("sky", Some(Verdict::Approve)),
            comment("dee", Some(Verdict::Approve)),
        ];
        assert_eq!(check(&changed_back).missing, None);
    }

    #[test]
    fn the_author_and_g1t_count_only_as_the_file_says() {
        // infra/ is owned by @g1t alone (once @acme/infra is dropped).
        let infra = requirements(&["infra/main.tf"]);
        let members = members_of(&owners());
        let by = |author: &str, comments: &[Comment]| {
            standing("CODEOWNERS", true, &infra, &members, &latest_verdicts(comments), author, 0).missing
        };
        assert_eq!(by("zed", &[comment("g1t", Some(Verdict::Approve))]), None);
        // Elsewhere g1t's approval does not count.
        let api = requirements(&["src/api/users.rs"]);
        let api_missing = standing("CODEOWNERS", true, &api, &members, &latest_verdicts(&[comment("g1t", Some(Verdict::Approve))]), "zed", 0);
        assert!(api_missing.missing.is_some());
        // The author approving their own does not count.
        let own = standing("CODEOWNERS", true, &api, &members, &latest_verdicts(&[comment("ana", Some(Verdict::Approve))]), "ana", 0);
        assert!(own.missing.is_some());
        let other = standing("CODEOWNERS", true, &api, &members, &latest_verdicts(&[comment("ana", Some(Verdict::Approve))]), "zed", 0);
        assert_eq!(other.missing, None);
    }

    #[test]
    fn only_verdicts_count_and_the_latest_one() {
        let comments = [
            comment("bo", Some(Verdict::RequestChanges)),
            comment("cy", None),
            comment("BO", Some(Verdict::Approve)),
        ];
        let latest = latest_verdicts(&comments);
        assert_eq!(latest.len(), 1);
        assert_eq!(latest[0].username, "bo");
        assert!(latest[0].approved);
    }
}
