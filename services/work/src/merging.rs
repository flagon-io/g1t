//! How a pull request merges: by which method (the repository's settings,
//! narrowed by the rules for the branch it merges into), with what commit
//! message (merge_message.rs), what happens when its base has moved, and
//! its branch afterwards, deleted and restored.
//!
//! `merge_pull` (lib.rs) asks these questions; `merge_choices` answers them
//! for the merge box before anyone clicks.

use g1t_contracts::access::{self, Capability};
use g1t_contracts::events::PullEvent;
use g1t_contracts::repos::{CreateBranchArgs, Divergence, HeadArgs, RemoveBranchArgs, Repo, RepoPath};
use g1t_contracts::rules::{InspectCommitsArgs, InspectedCommits, MergeMethod};
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, User};
use g1t_kit::now_ms;
use g1t_rules::merge::{Requirements, method_label};
use serde::Deserialize;
use worker::Result;

use crate::merge_message::{self, CommitText, MessageFacts};
use crate::retired::writable;
use crate::{Work, allowed, no_pull};

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

/// How many of a pull request's commits its default messages read.
const MESSAGE_COMMITS: u32 = 250;
/// The most JSON of commits kept for one pull request (D1 holds 2 MB to a
/// row); a pull request with more has them read each time.
const MAX_KEPT_COMMITS: usize = 1_000_000;

/// The commits kept for a pull request's default messages
/// (`pull_message_commits`), with its mergeability's pair beside them.
#[derive(Deserialize)]
struct KeptCommitsRow {
    #[serde(default)]
    head: Option<String>,
    #[serde(default)]
    pair: Option<String>,
    #[serde(default)]
    commits: Option<String>,
    #[serde(default)]
    mergeable_key: Option<String>,
}

/// Whether commits kept for `kept_head`, last confirmed for the pair of
/// commits `kept_pair`, are a pull request's now: its head is `kept_head`
/// and its mergeability was last worked out for that same pair. A push to
/// either side moves `mergeable_key` before they are kept again, so a list
/// read for another head or another base is never used.
pub(crate) fn kept_is_current(kept_head: Option<&str>, kept_pair: Option<&str>, head: Option<&str>, mergeable_key: Option<&str>) -> bool {
    let (Some(kept_head), Some(kept_pair), Some(head), Some(mergeable_key)) = (kept_head, kept_pair, head, mergeable_key) else {
        return false;
    };
    kept_head == head && kept_pair == mergeable_key && mergeable_key.split_once("..").is_some_and(|(of, _)| of == head)
}

/// What to do with the commits kept for a pull request when its
/// mergeability is worked out for a divergence.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Keeping {
    /// Kept for this pair of commits already.
    Current,
    /// The list holds (same head, same merge base: its base moved without
    /// taking any of its commits); only the pair it holds for moves on.
    Confirm,
    /// Read them again: its head or where it left its base moved, or none
    /// are kept.
    Read,
    /// Keep nothing: it shares no history with its base, so its commits
    /// are read live each time.
    Nothing,
}

/// See [`Keeping`]. `kept` is what is stored: head, merge base and pair.
pub(crate) fn keeping(kept: Option<(&str, Option<&str>, &str)>, divergence: &Divergence) -> Keeping {
    let Some(merge_base) = divergence.merge_base.as_deref() else {
        return Keeping::Nothing;
    };
    let pair = format!("{}..{}", divergence.head, divergence.base);
    match kept {
        Some((head, kept_base, kept_pair)) if head == divergence.head && kept_base == Some(merge_base) => {
            if kept_pair == pair { Keeping::Current } else { Keeping::Confirm }
        }
        _ => Keeping::Read,
    }
}

/// A pull request's commits as its default messages read them, oldest
/// first, merge commits left out.
fn texts_of(inspected: InspectedCommits) -> Vec<CommitText> {
    inspected
        .commits
        .into_iter()
        .rev()
        .filter(|commit| commit.parents <= 1)
        .map(|commit| CommitText { message: commit.message, author_email: commit.author_email })
        .collect()
}

/// The default title and body of the commit each of `methods` makes for
/// `pull`, from its `commits` (oldest first): `None` for one that makes no
/// commit of its own.
fn messages_for(
    repo: &Repo,
    pull: &Pull,
    settings: &RepoSettings,
    methods: &[MergeMethod],
    commits: &[CommitText],
    items: &[u32],
) -> Vec<(MergeMethod, Option<(String, String)>)> {
    let owner = pull.owner().username.clone();
    let (head_owner, head_repo) = match (&pull.fork, &pull.head_repo) {
        // A working copy is whoever asked for the change's.
        (Some(copy), _) => (owner.clone(), format!("{}/{}", copy.namespace, copy.name)),
        (None, Some(fork)) => (fork.namespace.clone(), format!("{}/{}", fork.namespace, fork.name)),
        (None, None) => (repo.namespace.clone(), format!("{}/{}", repo.namespace, repo.name)),
    };
    let branch = pull
        .branch
        .clone()
        .or_else(|| pull.fork.as_ref().map(|copy| copy.name.clone()))
        .unwrap_or_default();
    let facts = MessageFacts {
        number: pull.number,
        title: &pull.title,
        body: pull.body.as_deref().unwrap_or_default(),
        branch: &branch,
        head_owner: &head_owner,
        head_repo: &head_repo,
        base: pull.base_branch(&repo.default_branch),
        author: &owner,
        commits,
        items,
    };
    methods.iter().map(|method| (*method, merge_message::default_message(*method, settings, &facts))).collect()
}

/// Methods named for people, joined: "squash or rebase".
fn labels(methods: &[MergeMethod]) -> String {
    let named: Vec<&str> = methods.iter().map(|method| method_label(*method)).collect();
    match named.as_slice() {
        [] => "no method".to_owned(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
    }
}

/// The methods a pull request may merge by: those the repository allows,
/// as the rules for its base allow them, in the order offered.
pub(crate) fn offered(settings: &RepoSettings, requirements: &Requirements) -> Vec<MergeMethod> {
    settings.allowed_methods().into_iter().filter(|method| requirements.allows_method(*method)).collect()
}

/// The method a merge uses: the one asked for, if the repository and the
/// rules for `base` allow it; with none asked for, the repository's
/// default where it may be used, else the first that may. Why not, if
/// none can.
pub(crate) fn choose_method(
    asked: Option<MergeMethod>,
    settings: &RepoSettings,
    requirements: &Requirements,
    base: &str,
) -> std::result::Result<MergeMethod, String> {
    let offered = offered(settings, requirements);
    let Some(method) = asked else {
        return if offered.contains(&settings.default_merge_method) {
            Ok(settings.default_merge_method)
        } else {
            offered.first().copied().ok_or_else(|| {
                format!(
                    "No merge method this repository allows ({}) is allowed by the rules for {base}. Its admins can allow another in Settings.",
                    labels(&settings.allowed_methods())
                )
            })
        };
    };
    if !settings.allows(method) {
        return Err(format!(
            "This repository does not allow merging by {}. It allows {}.",
            method_label(method),
            labels(&settings.allowed_methods())
        ));
    }
    if requirements.linear_history && !method.is_linear() {
        return Err(format!(
            "{base} requires linear history, so a merge commit cannot land there. Merge by {} instead.",
            labels(&offered)
        ));
    }
    if !requirements.allows_method(method) {
        return Err(format!(
            "The rules for {base} allow merging only by {}, not by {}.",
            labels(requirements.allowed_merge_methods.as_deref().unwrap_or_default()),
            method_label(method)
        ));
    }
    Ok(method)
}

/// What a merge does about its base having moved without it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WhenBehind {
    /// Land it now: it is not behind, or the method makes new commits on
    /// the base's head anyway.
    Land,
    /// Bring it up to date first, and land it once that push arrives: a
    /// fast-forward needs the base's head in it.
    CatchUpFirst,
    /// Refuse, saying why.
    Refuse(String),
}

/// What to do when `behind`, for a merge by `method`.
pub(crate) fn when_behind(method: MergeMethod, behind: bool, require_up_to_date: bool, base: &str) -> WhenBehind {
    if !behind {
        return WhenBehind::Land;
    }
    if require_up_to_date {
        return WhenBehind::Refuse(format!(
            "{base} has moved since this pull request was made, and this repository requires pull requests to be up to date before they merge. Catch up with {base} first."
        ));
    }
    match method {
        MergeMethod::FastForward => WhenBehind::CatchUpFirst,
        MergeMethod::Merge | MergeMethod::Squash | MergeMethod::Rebase => WhenBehind::Land,
    }
}

/// Why a fast-forward cannot catch up first: whoever merges cannot push
/// to where the change is.
pub(crate) fn cannot_fast_forward(base: &str, source: &str) -> String {
    format!(
        "This pull request can only fast-forward once it is up to date with {base}, and its branch is in {source}, which you cannot push to. Merge it another way, or ask its author to catch it up with {base} first."
    )
}

/// Who a squash commit is by: the person the pull request is theirs (who
/// asked g1t for it, or its author). The merger, for an agent's or g1t's
/// own, and for any other method.
pub(crate) fn squash_author(pull: &Pull, method: MergeMethod) -> Option<User> {
    let owner = pull.owner();
    (method == MergeMethod::Squash && owner.kind == PrincipalKind::User && !g1t_contracts::rules::is_agent(owner)).then(|| owner.clone())
}

/// The branch a pull request's merge or close may delete, and where it is:
/// a branch of the repository, never its default branch nor the branch it
/// merges into, or a branch of a fork. Never a working copy's, which repos
/// retires with it.
pub(crate) fn deletable_branch(pull: &Pull, repo: &Repo) -> Option<(RepoPath, String)> {
    if pull.fork_repo_id.is_some() {
        return None;
    }
    let branch = pull.branch.as_deref().map(str::trim).filter(|branch| !branch.is_empty())?;
    if pull.from_head_repo() {
        return Some((pull.head_repo.clone()?, branch.to_owned()));
    }
    if branch == repo.default_branch || branch == pull.base_branch(&repo.default_branch) {
        return None;
    }
    Some((RepoPath { namespace: repo.namespace.clone(), name: repo.name.clone() }, branch.to_owned()))
}

/// What the timeline says a merge by `method` did.
pub(crate) fn merged_note(method: MergeMethod) -> &'static str {
    match method {
        MergeMethod::Squash => "squashed and merged this",
        MergeMethod::Rebase => "rebased and merged this",
        MergeMethod::Merge | MergeMethod::FastForward => "merged this",
    }
}

impl Work {
    /// A pull request's commits as its default messages read them, read
    /// from its source now: only their messages, from a pack fetched from
    /// `merge_base` when that is known. Empty when they cannot be read.
    async fn read_commit_texts(
        &self,
        pull: &Pull,
        target_id: &str,
        base_branch: &str,
        merge_base: Option<String>,
    ) -> Result<Vec<CommitText>> {
        let Some(head) = pull.head_commit.clone() else {
            return Ok(Vec::new());
        };
        let found: Outcome<InspectedCommits> = g1t_kit::call(
            &self.repos,
            "inspect_commits",
            &InspectCommitsArgs {
                source_id: pull.source_id().to_owned(),
                head,
                target_id: target_id.to_owned(),
                base_branch: base_branch.to_owned(),
                limit: Some(MESSAGE_COMMITS),
                merge_base,
                messages_only: true,
            },
        )
        .await?;
        Ok(match found {
            Outcome::Ok(inspected) => texts_of(inspected),
            Outcome::Fail(_) => Vec::new(),
        })
    }

    /// The commits kept for a pull request's default messages, if they are
    /// its commits as it is now ([`kept_is_current`]). One database read.
    async fn kept_commit_texts(&self, pull: &Pull) -> Result<Option<Vec<CommitText>>> {
        if !pull.status.is_active() || pull.head_commit.is_none() {
            return Ok(None);
        }
        let row = self
            .timing
            .db(
                1,
                self.db
                    .prepare(
                        "SELECT kept.head, kept.pair, kept.commits, pulls.mergeable_key
                         FROM pulls LEFT JOIN pull_message_commits AS kept ON kept.pull_id = pulls.id
                         WHERE pulls.id = ?",
                    )
                    .bind(&[pull.id.as_str().into()])?
                    .first::<KeptCommitsRow>(None),
            )
            .await?;
        let Some(row) = row else { return Ok(None) };
        if !kept_is_current(row.head.as_deref(), row.pair.as_deref(), pull.head_commit.as_deref(), row.mergeable_key.as_deref()) {
            return Ok(None);
        }
        Ok(row.commits.as_deref().and_then(|commits| serde_json::from_str(commits).ok()))
    }

    /// A pull request's commits as its default messages read them, oldest
    /// first, merge commits left out: those kept for it when they are
    /// current, else read now.
    async fn commit_texts(&self, repo: &Repo, pull: &Pull) -> Result<Vec<CommitText>> {
        if let Some(kept) = self.kept_commit_texts(pull).await? {
            return Ok(kept);
        }
        self.read_commit_texts(pull, &repo.id, pull.base_branch(&repo.default_branch), None).await
    }

    /// Keeps a pull request's commits for its default messages, once its
    /// mergeability was worked out for `divergence` after a push, so that
    /// the merge box reads them from here. They are read again only when
    /// its head or where it left its base moved; a push to its base that
    /// took none of its commits only moves the pair they hold for. Nothing
    /// is read when no method the repository allows writes commits into a
    /// message.
    pub(crate) async fn keep_commit_texts(&self, pull: &Pull, divergence: &Divergence) -> Result<()> {
        if !pull.status.is_active() || pull.head_commit.as_deref() != Some(divergence.head.as_str()) {
            return Ok(());
        }
        #[derive(Deserialize)]
        struct Kept {
            head: String,
            merge_base: Option<String>,
            pair: String,
        }
        let (settings, kept) = futures_util::future::try_join(
            self.settings(&pull.repo_id),
            self.db
                .prepare("SELECT head, merge_base, pair FROM pull_message_commits WHERE pull_id = ?")
                .bind(&[pull.id.as_str().into()])?
                .first::<Kept>(None),
        )
        .await?;
        if !settings.allowed_methods().into_iter().any(|method| merge_message::needs_commits(method, &settings)) {
            return Ok(());
        }
        let pair = format!("{}..{}", divergence.head, divergence.base);
        let now = g1t_contracts::time::rfc3339(now_ms());
        match keeping(kept.as_ref().map(|kept| (kept.head.as_str(), kept.merge_base.as_deref(), kept.pair.as_str())), divergence) {
            Keeping::Current | Keeping::Nothing => Ok(()),
            Keeping::Confirm => {
                self.db
                    .prepare("UPDATE pull_message_commits SET pair = ?, updated_at = ? WHERE pull_id = ? AND head = ?")
                    .bind(&[pair.into(), now.into(), pull.id.as_str().into(), divergence.head.as_str().into()])?
                    .run()
                    .await?;
                Ok(())
            }
            Keeping::Read => {
                let texts = self
                    .read_commit_texts(pull, &pull.repo_id, pull.base.as_deref().unwrap_or_default(), divergence.merge_base.clone())
                    .await?;
                let commits = serde_json::to_string(&texts)?;
                if commits.len() > MAX_KEPT_COMMITS {
                    self.db
                        .prepare("DELETE FROM pull_message_commits WHERE pull_id = ?")
                        .bind(&[pull.id.as_str().into()])?
                        .run()
                        .await?;
                    return Ok(());
                }
                self.db
                    .prepare(
                        "INSERT INTO pull_message_commits (pull_id, head, merge_base, pair, commits, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                         ON CONFLICT (pull_id) DO UPDATE SET head = ?2, merge_base = ?3, pair = ?4, commits = ?5, updated_at = ?6",
                    )
                    .bind(&[
                        pull.id.as_str().into(),
                        divergence.head.as_str().into(),
                        crate::optional(&divergence.merge_base),
                        pair.into(),
                        commits.into(),
                        now.into(),
                    ])?
                    .run()
                    .await?;
                Ok(())
            }
        }
    }

    /// The default title and body of the commit each of `methods` makes
    /// for `pull`, as the repository's settings write them: `None` for one
    /// that makes no commit of its own.
    pub(crate) async fn default_messages(
        &self,
        repo: &Repo,
        pull: &Pull,
        settings: &RepoSettings,
        methods: &[MergeMethod],
    ) -> Result<Vec<(MergeMethod, Option<(String, String)>)>> {
        let commits = if methods.iter().any(|method| merge_message::needs_commits(*method, settings)) {
            self.commit_texts(repo, pull).await?
        } else {
            Vec::new()
        };
        let items = self.items_to_close(pull, repo, settings, false).await?.close_numbers();
        Ok(messages_for(repo, pull, settings, methods, &commits, &items))
    }

    /// The whole message of the commit a merge by `method` makes: what the
    /// merger wrote, over the repository's default. `None` for a rebase or
    /// fast-forward. Or why what they wrote cannot be used.
    pub(crate) async fn merge_message_for(
        &self,
        repo: &Repo,
        pull: &Pull,
        settings: &RepoSettings,
        method: MergeMethod,
        title: Option<&str>,
        body: Option<&str>,
    ) -> Result<std::result::Result<Option<String>, &'static str>> {
        if !matches!(method, MergeMethod::Merge | MergeMethod::Squash) {
            return Ok(Ok(None));
        }
        // Nothing of the default is used when the merger wrote both.
        let default = if title.is_some() && body.is_some() {
            Some((String::new(), String::new()))
        } else {
            self.default_messages(repo, pull, settings, &[method]).await?.pop().and_then(|(_, message)| message)
        };
        Ok(merge_message::chosen(default, title, body))
    }

    /// `merge_choices`: how a pull request may merge now, for the merge box.
    pub(crate) async fn merge_choices(&self, a: ViewArgs) -> Result<Outcome<MergeChoices>> {
        let (repo, mut pull) = check!(self.pull_at(&a.repo, a.number, &a.viewer).await?);
        crate::fill_base(&mut pull, &repo);
        let base = pull.base_branch(&repo.default_branch).to_owned();
        // The commits kept for its messages are read beside its settings;
        // only when none are current are they read from its source.
        let ((settings, requirements), behind, kept) = futures_util::future::try_join3(
            self.settings_and_requirements(&repo, &pull),
            self.behind_now(&pull),
            self.kept_commit_texts(&pull),
        )
        .await?;
        let methods = offered(&settings, &requirements);
        let default_method = choose_method(None, &settings, &requirements, &base).ok();
        let viewer = a.viewer.as_ref();
        // Whoever looks may catch it up to fast-forward it: they could push
        // the merge themselves (catch_up_pull).
        let can_catch_up = viewer.is_some_and(|viewer| match (&pull.fork_repo_id, pull.from_head_repo()) {
            (Some(_), _) => pull.is_owned_by(&viewer.id),
            // A fork's branch takes pushes from whoever repos lets push
            // there, which is not known here: offered, and refused clearly.
            (None, true) => true,
            (None, false) => access::can(Some(viewer), &repo, Capability::Push),
        });
        let commits = if !methods.iter().any(|method| merge_message::needs_commits(*method, &settings)) {
            Vec::new()
        } else if let Some(kept) = kept {
            kept
        } else if pull.status.is_active() {
            self.read_commit_texts(&pull, &repo.id, &base, None).await?
        } else {
            // A merged or closed one merges no more.
            Vec::new()
        };
        let items = self.items_to_close(&pull, &repo, &settings, false).await?.close_numbers();
        let messages = messages_for(&repo, &pull, &settings, &methods, &commits, &items);
        let options = messages
            .into_iter()
            .map(|(method, message)| {
                let unavailable = if behind && settings.require_up_to_date {
                    Some(format!("This repository requires it to be up to date with {base} before it merges."))
                } else {
                    (method == MergeMethod::FastForward && behind && !can_catch_up)
                        .then(|| format!("It can only fast-forward once it is up to date with {base}."))
                };
                let (commit_title, commit_message) = match message {
                    Some((title, body)) => (Some(title), Some(body)),
                    None => (None, None),
                };
                MergeChoice { method, commit_title, commit_message, unavailable }
            })
            .collect();
        let can_delete_branch = deletable_branch(&pull, &repo).is_some();
        let auto_merge_allowed = settings.allow_auto_merge
            && pull.status.is_active()
            && viewer.is_some_and(|viewer| access::can(Some(viewer), &repo, Capability::Merge));
        Ok(Outcome::Ok(MergeChoices {
            methods,
            default_method,
            options,
            behind,
            can_fast_forward: !behind,
            suggest_update: behind && (settings.suggest_updating_branches || settings.require_up_to_date),
            require_up_to_date: settings.require_up_to_date,
            merge_queue: settings.merge_queue,
            auto_merge_allowed,
            delete_branch_default: settings.delete_branch_on_merge && can_delete_branch,
            can_delete_branch,
            sign_off: settings.require_web_commit_sign_off,
        }))
    }

    /// Whether another open pull request still needs `branch` of
    /// `source_id`: one merging into it, or one opened from it into
    /// another branch.
    async fn branch_in_use(&self, pull: &Pull, branch: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare(
                "SELECT 1 AS value FROM pulls
                 WHERE id <> ?1 AND status IN ('draft', 'open') AND fork_repo_id IS NULL
                   AND ((repo_id = ?2 AND base_branch = ?3 AND ?4 IS NULL)
                     OR (source_branch = ?3 AND COALESCE(head_repo_id, repo_id) = ?5))
                 LIMIT 1",
            )
            .bind(&[
                pull.id.as_str().into(),
                pull.repo_id.as_str().into(),
                branch.into(),
                crate::optional(&pull.head_repo_id),
                pull.source_id().into(),
            ])?
            .first::<u32>(Some("value"))
            .await?
            .is_some())
    }

    /// Deletes a pull request's branch as `actor`, if it may be deleted and
    /// still points at `head`, and says so. Repos decides whether `actor`
    /// may push there and whether the rules for the branch let it go.
    /// Whether it was deleted, or why not.
    async fn remove_head_branch(&self, repo: &Repo, pull: &Pull, actor: &User, head: Option<String>) -> Result<Outcome<()>> {
        let Some((path, branch)) = deletable_branch(pull, repo) else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                if pull.fork_repo_id.is_some() {
                    "This pull request's change is in a working copy made for it, which goes by itself.".to_owned()
                } else {
                    "This pull request's branch cannot be deleted here.".to_owned()
                },
            ));
        };
        if self.branch_in_use(pull, &branch).await? {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("Another open pull request still uses {branch}, so it stays."),
            ));
        }
        let removed: Outcome<g1t_contracts::repos::Branch> = g1t_kit::call(
            &self.repos,
            "remove_branch",
            &RemoveBranchArgs { actor: actor.clone(), path, branch: branch.clone(), head, surface: None },
        )
        .await?;
        check!(removed);
        self.db
            .prepare("UPDATE pulls SET head_branch_deleted = 1 WHERE id = ?")
            .bind(&[pull.id.as_str().into()])?
            .run()
            .await?;
        self.note(&pull.repo_id, pull.number, (&actor.id, &actor.username), &format!("deleted the `{branch}` branch"))
            .await?;
        self.publish(
            "pull.head_branch_deleted",
            &pull.repo_id,
            actor,
            PullEvent { detail: Some(branch), ..Self::pull_event(pull) },
        )
        .await?;
        Ok(Outcome::Ok(()))
    }

    /// After a merge: deletes its branch where the merger asked for it, or
    /// the repository does on merge. A branch that cannot go stays, quietly:
    /// the merge itself succeeded.
    pub(crate) async fn delete_branch_after_merge(
        &self,
        repo: &Repo,
        pull: &Pull,
        actor: &User,
        asked: Option<bool>,
        head: Option<String>,
    ) -> Result<()> {
        if !asked.unwrap_or(self.settings(&repo.id).await?.delete_branch_on_merge) || deletable_branch(pull, repo).is_none() {
            return Ok(());
        }
        // A branch that moved since it merged keeps the new commits.
        if head.is_none() {
            return Ok(());
        }
        if let Outcome::Fail(failure) = self.remove_head_branch(repo, pull, actor, head).await? {
            worker::console_warn!("branch of {} kept after merging: {}", pull.id, failure.message);
        }
        Ok(())
    }

    /// `delete_head_branch`: deletes a merged or closed pull request's
    /// branch, if it still points where the pull request left it.
    pub(crate) async fn delete_head_branch(&self, a: PullActionArgs) -> Result<Outcome<Pull>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
        }
        let (repo, pull) = check!(self.pull_at(&a.repo, a.number, &Some(a.actor.clone())).await?);
        check!(writable(&repo));
        if pull.status.is_active() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "This pull request is still open. Its branch can be deleted once it is merged or closed.",
            ));
        }
        if pull.head_branch_deleted {
            return Ok(Outcome::fail(FailureCode::Conflict, "Its branch is already deleted."));
        }
        if !pull.from_head_repo() {
            check!(allowed(Some(&a.actor), &repo, Capability::Push));
        }
        check!(self.remove_head_branch(&repo, &pull, &a.actor, pull.head_commit.clone()).await?);
        Ok(match self.pull(&repo.id, pull.number).await? {
            Some(pull) => Outcome::Ok(pull),
            None => no_pull(),
        })
    }

    /// `restore_head_branch`: makes a merged or closed pull request's
    /// branch again, at the commit it was left at.
    pub(crate) async fn restore_head_branch(&self, a: PullActionArgs) -> Result<Outcome<Pull>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
        }
        let (repo, pull) = check!(self.pull_at(&a.repo, a.number, &Some(a.actor.clone())).await?);
        check!(writable(&repo));
        if pull.status.is_active() {
            return Ok(Outcome::fail(FailureCode::Conflict, "This pull request is still open, and so is its branch."));
        }
        let (Some((path, branch)), Some(head)) = (deletable_branch(&pull, &repo), pull.head_commit.clone()) else {
            return Ok(Outcome::fail(FailureCode::Invalid, "This pull request has no branch that can be restored."));
        };
        let exists: Option<String> = g1t_kit::call(
            &self.repos,
            "head",
            &HeadArgs { repo_id: pull.source_id().to_owned(), branch: branch.clone() },
        )
        .await?;
        if exists.is_some() {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("{branch} exists already.")));
        }
        let created: Outcome<g1t_contracts::repos::Branch> = g1t_kit::call(
            &self.repos,
            "create_branch",
            &CreateBranchArgs { actor: a.actor.clone(), path, name: branch.clone(), from: head, surface: None },
        )
        .await?;
        check!(created);
        self.db
            .prepare("UPDATE pulls SET head_branch_deleted = 0 WHERE id = ?")
            .bind(&[pull.id.as_str().into()])?
            .run()
            .await?;
        self.note(&pull.repo_id, pull.number, (&a.actor.id, &a.actor.username), &format!("restored the `{branch}` branch"))
            .await?;
        self.publish(
            "pull.head_branch_restored",
            &pull.repo_id,
            &a.actor,
            PullEvent { detail: Some(branch), ..Self::pull_event(&pull) },
        )
        .await?;
        Ok(match self.pull(&repo.id, pull.number).await? {
            Some(pull) => Outcome::Ok(pull),
            None => no_pull(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rows::stored::{ASKER, G1T, pull};

    fn rules(allowed: Option<Vec<MergeMethod>>, linear: bool) -> Requirements {
        Requirements { allowed_merge_methods: allowed, linear_history: linear, ..Requirements::default() }
    }

    #[test]
    fn the_method_is_the_one_asked_for_if_allowed() {
        let settings = RepoSettings::default();
        let open = rules(None, false);
        assert_eq!(choose_method(Some(MergeMethod::Squash), &settings, &open, "main"), Ok(MergeMethod::Squash));
        assert_eq!(choose_method(None, &settings, &open, "main"), Ok(MergeMethod::Merge));
        // Fast-forward is off unless the repository turns it on.
        let refused = choose_method(Some(MergeMethod::FastForward), &settings, &open, "main").unwrap_err();
        assert_eq!(refused, "This repository does not allow merging by fast-forward. It allows merge commit, squash or rebase.");
        let ff = RepoSettings { allow_fast_forward: true, ..RepoSettings::default() };
        assert_eq!(choose_method(Some(MergeMethod::FastForward), &ff, &open, "main"), Ok(MergeMethod::FastForward));
    }

    #[test]
    fn linear_history_refuses_a_merge_commit_and_moves_the_default_on() {
        let settings = RepoSettings::default();
        let linear = rules(None, true);
        let refused = choose_method(Some(MergeMethod::Merge), &settings, &linear, "main").unwrap_err();
        assert_eq!(refused, "main requires linear history, so a merge commit cannot land there. Merge by squash or rebase instead.");
        // Unasked, the default (merge) gives way to the first that may.
        assert_eq!(choose_method(None, &settings, &linear, "main"), Ok(MergeMethod::Squash));
        assert_eq!(offered(&settings, &linear), vec![MergeMethod::Squash, MergeMethod::Rebase]);
    }

    #[test]
    fn rules_narrow_the_methods() {
        let settings = RepoSettings { default_merge_method: MergeMethod::Squash, ..RepoSettings::default() };
        let rebase_only = rules(Some(vec![MergeMethod::Rebase]), false);
        assert_eq!(choose_method(None, &settings, &rebase_only, "main"), Ok(MergeMethod::Rebase));
        let refused = choose_method(Some(MergeMethod::Squash), &settings, &rebase_only, "release").unwrap_err();
        assert_eq!(refused, "The rules for release allow merging only by rebase, not by squash.");
        // Nothing both allow.
        let ff_only = rules(Some(vec![MergeMethod::FastForward]), false);
        let none = choose_method(None, &settings, &ff_only, "main").unwrap_err();
        assert!(none.starts_with("No merge method this repository allows (merge commit, squash or rebase)"), "{none}");
        assert!(offered(&settings, &ff_only).is_empty());
    }

    #[test]
    fn behind_is_no_problem_unless_it_must_be_up_to_date_or_fast_forward() {
        assert_eq!(when_behind(MergeMethod::Merge, false, true, "main"), WhenBehind::Land);
        for method in [MergeMethod::Merge, MergeMethod::Squash, MergeMethod::Rebase] {
            assert_eq!(when_behind(method, true, false, "main"), WhenBehind::Land, "{method:?}");
            assert!(matches!(when_behind(method, true, true, "main"), WhenBehind::Refuse(_)));
        }
        assert_eq!(when_behind(MergeMethod::FastForward, true, false, "main"), WhenBehind::CatchUpFirst);
        assert_eq!(when_behind(MergeMethod::FastForward, false, false, "main"), WhenBehind::Land);
        assert!(matches!(when_behind(MergeMethod::FastForward, true, true, "main"), WhenBehind::Refuse(_)));
    }

    fn repo() -> Repo {
        serde_json::from_value(serde_json::json!({
            "id": "rep_1", "namespace": "flagon", "name": "g1t", "isPrivate": false,
            "ownerId": "usr_1", "defaultBranch": "main", "forkOf": null, "protected": false,
            "createdAt": "", "updatedAt": ""
        }))
        .unwrap()
    }

    fn branch_pull(branch: &str) -> Pull {
        let mut made = pull(ASKER, None);
        made.fork = None;
        made.fork_repo_id = None;
        made.branch = Some(branch.into());
        made
    }

    #[test]
    fn only_a_branch_that_is_not_the_base_or_a_working_copy_is_deleted() {
        let repo = repo();
        let feature = branch_pull("feature");
        assert_eq!(
            deletable_branch(&feature, &repo),
            Some((RepoPath { namespace: "flagon".into(), name: "g1t".into() }, "feature".into()))
        );
        assert!(deletable_branch(&branch_pull("main"), &repo).is_none(), "the default branch stays");
        let mut into_release = branch_pull("release");
        into_release.base = Some("release".into());
        assert!(deletable_branch(&into_release, &repo).is_none());
        // A working copy goes by itself.
        assert!(deletable_branch(&pull(G1T, Some(ASKER)), &repo).is_none());
        // A fork's branch, even one named like the base.
        let mut forked = branch_pull("main");
        forked.head_repo = Some(RepoPath { namespace: "ana".into(), name: "g1t".into() });
        forked.head_repo_id = Some("rep_2".into());
        assert_eq!(deletable_branch(&forked, &repo).map(|(path, branch)| (path.namespace, branch)), Some(("ana".into(), "main".into())));
    }

    #[test]
    fn a_squash_is_by_the_person_whose_change_it_is() {
        let own = branch_pull("feature");
        assert_eq!(squash_author(&own, MergeMethod::Squash).map(|user| user.id), Some(ASKER.0.to_owned()));
        assert!(squash_author(&own, MergeMethod::Merge).is_none());
        // What g1t made for someone is theirs.
        assert_eq!(squash_author(&pull(G1T, Some(ASKER)), MergeMethod::Squash).map(|user| user.id), Some(ASKER.0.to_owned()));
        // g1t's own work is the merger's.
        assert!(squash_author(&pull(("g1t", "g1t"), None), MergeMethod::Squash).is_none());
    }

    fn diverged(head: &str, base: &str, merge_base: Option<&str>) -> Divergence {
        Divergence { head: head.into(), base: base.into(), merge_base: merge_base.map(Into::into), ..Divergence::default() }
    }

    #[test]
    fn kept_commits_are_used_only_for_the_head_and_pair_they_were_kept_for() {
        let current = |kept_head, kept_pair, head, key| kept_is_current(kept_head, kept_pair, head, key);
        assert!(current(Some("h1"), Some("h1..b1"), Some("h1"), Some("h1..b1")));
        // Its head moved: pushed to since they were kept.
        assert!(!current(Some("h1"), Some("h1..b1"), Some("h2"), Some("h1..b1")));
        // Its base moved and mergeability was worked out again without them
        // being confirmed for the new pair.
        assert!(!current(Some("h1"), Some("h1..b1"), Some("h1"), Some("h1..b2")));
        // Mergeability worked out for another head than the one it has now.
        assert!(!current(Some("h1"), Some("h1..b1"), Some("h1"), Some("h0..b1")));
        assert!(!current(Some("h1"), Some("h0..b1"), Some("h1"), Some("h0..b1")));
        // Nothing kept, nothing worked out, or nothing pushed.
        assert!(!current(None, None, Some("h1"), Some("h1..b1")));
        assert!(!current(Some("h1"), Some("h1..b1"), Some("h1"), None));
        assert!(!current(Some("h1"), Some("h1..b1"), None, Some("h1..b1")));
    }

    #[test]
    fn commits_are_read_again_only_when_the_head_or_merge_base_moves() {
        let now = diverged("h1", "b1", Some("m1"));
        assert_eq!(keeping(None, &now), Keeping::Read, "none kept");
        assert_eq!(keeping(Some(("h1", Some("m1"), "h1..b1")), &now), Keeping::Current);
        // Its base moved on without taking any of its commits.
        assert_eq!(keeping(Some(("h1", Some("m1"), "h1..b0")), &now), Keeping::Confirm);
        // Pushed to.
        assert_eq!(keeping(Some(("h0", Some("m1"), "h0..b1")), &now), Keeping::Read);
        // Its base took some of its commits, or it caught up with its base.
        assert_eq!(keeping(Some(("h1", Some("m0"), "h1..b0")), &now), Keeping::Read);
        assert_eq!(keeping(Some(("h1", None, "h1..b0")), &now), Keeping::Read);
        // No history in common: nothing is kept, and the box reads them live.
        assert_eq!(keeping(Some(("h1", Some("m1"), "h1..b1")), &diverged("h1", "b1", None)), Keeping::Nothing);
    }

    #[test]
    fn kept_commits_read_back_as_they_were_written() {
        let texts = vec![
            CommitText { message: "feat: one\n\nWhy.".into(), author_email: Some("ada@acme.com".into()) },
            CommitText { message: "fix: two".into(), author_email: None },
        ];
        let json = serde_json::to_string(&texts).unwrap();
        assert_eq!(serde_json::from_str::<Vec<CommitText>>(&json).unwrap(), texts);
    }

    #[test]
    fn merge_commits_are_left_out_of_the_messages_oldest_first() {
        let commit = |sha: &str, parents| g1t_contracts::rules::CommitFacts {
            sha: sha.into(),
            message: sha.into(),
            parents,
            ..g1t_contracts::rules::CommitFacts::default()
        };
        let inspected = InspectedCommits { commits: vec![commit("newest", 1), commit("merge", 2), commit("oldest", 0)], complete: true };
        let texts: Vec<String> = texts_of(inspected).into_iter().map(|text| text.message).collect();
        assert_eq!(texts, ["oldest", "newest"]);
    }

    #[test]
    fn the_timeline_says_how_it_merged() {
        assert_eq!(merged_note(MergeMethod::Squash), "squashed and merged this");
        assert_eq!(merged_note(MergeMethod::FastForward), "merged this");
        assert_eq!(labels(&[MergeMethod::Squash, MergeMethod::Rebase, MergeMethod::FastForward]), "squash, rebase or fast-forward");
    }
}
