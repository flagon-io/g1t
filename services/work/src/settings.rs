//! A repository's settings for how its pull requests are handled,
//! and the branch protection settings that are now its "Default branch
//! protection" ruleset (rulesets.rs).
//!
//! What a merge needs is decided by the rules of the branch it merges into
//! (`Work::merge_gate_by`, `Work::merge_gate_seen`); `approvals_gap` asks them for what people must
//! still do, as g1t sees it when it merges by itself.

use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::Work;

const MAX_REQUIRED_APPROVALS: u32 = 6;

#[derive(Deserialize)]
struct SettingsRow {
    auto_merge: u8,
    require_up_to_date: u8,
    required_approvals: u32,
    count_agent_approvals: u8,
    allow_ignoring_checks: u8,
    #[serde(default)]
    merge_queue: u8,
    /// JSON array of names.
    #[serde(default)]
    required_checks: Option<String>,
    #[serde(default)]
    require_code_owner_review: u8,
    /// NULL for the default (migrations/0041_pull_head_repo.sql).
    #[serde(default)]
    has_work_items: Option<u8>,
    // How pull requests merge (migrations/0042_merge_settings.sql): NULL
    // for the default.
    #[serde(default)]
    allow_merge_commit: Option<u8>,
    #[serde(default)]
    allow_squash_merge: Option<u8>,
    #[serde(default)]
    allow_rebase_merge: Option<u8>,
    #[serde(default)]
    allow_fast_forward: Option<u8>,
    #[serde(default)]
    default_merge_method: Option<String>,
    #[serde(default)]
    merge_commit_message: Option<String>,
    #[serde(default)]
    squash_commit_message: Option<String>,
    #[serde(default)]
    merge_commit_template: Option<String>,
    #[serde(default)]
    squash_commit_template: Option<String>,
    #[serde(default)]
    suggest_updating_branches: Option<u8>,
    #[serde(default)]
    allow_auto_merge: Option<u8>,
    #[serde(default)]
    delete_branch_on_merge: Option<u8>,
    #[serde(default)]
    require_web_commit_sign_off: Option<u8>,
    #[serde(default)]
    allow_commit_comments: Option<u8>,
    #[serde(default)]
    auto_close_items: Option<u8>,
    updated_by: String,
    updated_at: String,
}

/// A stored flag, or `default` where none was stored.
fn flag(stored: Option<u8>, default: bool) -> bool {
    stored.map_or(default, |on| on != 0)
}

/// A stored name of a contract enum (snake_case), if it names one.
fn named<T: serde::de::DeserializeOwned>(stored: Option<&str>) -> Option<T> {
    serde_json::from_value(serde_json::Value::String(stored?.to_owned())).ok()
}

/// The snake_case name a contract enum is stored as.
fn name_of<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}

/// A stored flag to bind.
fn bit(on: bool) -> worker::wasm_bindgen::JsValue {
    u32::from(on).into()
}

impl From<SettingsRow> for RepoSettings {
    fn from(row: SettingsRow) -> Self {
        let defaults = RepoSettings::default();
        RepoSettings {
            allow_merge_commit: flag(row.allow_merge_commit, defaults.allow_merge_commit),
            allow_squash_merge: flag(row.allow_squash_merge, defaults.allow_squash_merge),
            allow_rebase_merge: flag(row.allow_rebase_merge, defaults.allow_rebase_merge),
            allow_fast_forward: flag(row.allow_fast_forward, defaults.allow_fast_forward),
            default_merge_method: named(row.default_merge_method.as_deref()).unwrap_or(defaults.default_merge_method),
            merge_commit_message: named(row.merge_commit_message.as_deref()).unwrap_or_default(),
            squash_commit_message: named(row.squash_commit_message.as_deref()).unwrap_or_default(),
            merge_commit_template: row.merge_commit_template,
            squash_commit_template: row.squash_commit_template,
            suggest_updating_branches: flag(row.suggest_updating_branches, defaults.suggest_updating_branches),
            allow_auto_merge: flag(row.allow_auto_merge, defaults.allow_auto_merge),
            delete_branch_on_merge: flag(row.delete_branch_on_merge, defaults.delete_branch_on_merge),
            require_web_commit_sign_off: flag(row.require_web_commit_sign_off, defaults.require_web_commit_sign_off),
            allow_commit_comments: flag(row.allow_commit_comments, defaults.allow_commit_comments),
            auto_close_items: flag(row.auto_close_items, defaults.auto_close_items),
            auto_merge: row.auto_merge != 0,
            required_checks: row.required_checks.as_deref().and_then(|names| serde_json::from_str(names).ok()).unwrap_or_default(),
            require_up_to_date: row.require_up_to_date != 0,
            required_approvals: row.required_approvals,
            count_agent_approvals: row.count_agent_approvals != 0,
            allow_ignoring_checks: row.allow_ignoring_checks != 0,
            merge_queue: row.merge_queue != 0,
            require_code_owner_review: row.require_code_owner_review != 0,
            has_work_items: row.has_work_items.map(|on| on != 0),
            // Whether the repository is a fork is not known here: see
            // `work_items_enabled`.
            work_items_enabled: row.has_work_items.is_none_or(|on| on != 0),
            updated_by: Some(row.updated_by),
            updated_at: Some(row.updated_at),
        }
    }
}

impl Work {
    /// A repository's stored settings, by its id: how its pull requests are
    /// handled. Defaults if none were set. Branch protection is
    /// its rules': see `settings_on`.
    pub(crate) async fn settings(&self, repo_id: &str) -> Result<RepoSettings> {
        if let Some(found) = self.prefetched_repo(repo_id) {
            let row = found.first::<SettingsRow>(crate::prefetch::Slot::Settings)?;
            return Ok(row.map_or_else(RepoSettings::default, RepoSettings::from));
        }
        let row =
            self.db.prepare("SELECT * FROM repo_settings WHERE repo_id = ?").bind(&[repo_id.into()])?.first::<SettingsRow>(None).await?;
        Ok(row.map_or_else(RepoSettings::default, RepoSettings::from))
    }

    /// The default branch's settings: the stored ones, with branch
    /// protection as its rules stack.
    pub(crate) async fn get_settings(&self, a: ViewArgs) -> Result<Outcome<RepoSettings>> {
        let repo = match self.repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        Ok(Outcome::Ok(self.timing.db(3, self.default_branch_settings(&repo)).await?))
    }

    /// Replaces a repository's settings: how pull requests are handled, kept here,
    /// and the branch protection ones, written to its "Default branch
    /// protection" ruleset (made when it has none and they protect
    /// anything). Rules that only rulesets have stay as they are.
    pub(crate) async fn update_settings(&self, a: UpdateSettingsArgs) -> Result<Outcome<RepoSettings>> {
        let repo = match self.repo(&a.repo, &Some(a.actor.clone())).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if let Outcome::Fail(failure) = crate::retired::writable(&repo) {
            return Ok(Outcome::Fail(failure));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
        }
        if let Outcome::Fail(failure) = crate::allowed(Some(&a.actor), &repo, g1t_contracts::access::Capability::ManageSettings) {
            return Ok(Outcome::Fail(failure));
        }
        let before = self.default_branch_settings(&repo).await?;
        let a = match tidy_merge_settings(a.settings) {
            Ok(settings) => UpdateSettingsArgs { settings, ..a },
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let settings = RepoSettings {
            required_approvals: a.settings.required_approvals.min(MAX_REQUIRED_APPROVALS),
            required_checks: tidy_required(&a.settings.required_checks),
            updated_by: Some(a.actor.username.clone()),
            updated_at: Some(rfc3339(now_ms())),
            ..a.settings
        };
        // Branch protection changes need the role that changes it.
        if protection_changed(&before, &settings)
            && let Outcome::Fail(failure) = crate::allowed(Some(&a.actor), &repo, g1t_contracts::access::Capability::ManageProtection)
        {
            return Ok(Outcome::Fail(failure));
        }
        self.db
            .prepare(
                "INSERT INTO repo_settings
                   (repo_id, auto_merge, require_up_to_date, required_approvals,
                    count_agent_approvals, allow_ignoring_checks,
                    merge_queue, required_checks, require_code_owner_review, has_work_items,
                    allow_merge_commit, allow_squash_merge, allow_rebase_merge, allow_fast_forward,
                    default_merge_method, merge_commit_message, squash_commit_message,
                    merge_commit_template, squash_commit_template, suggest_updating_branches,
                    allow_auto_merge, delete_branch_on_merge, require_web_commit_sign_off,
                    allow_commit_comments, auto_close_items,
                    updated_by, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (repo_id) DO UPDATE SET
                   auto_merge = excluded.auto_merge,
                   require_up_to_date = excluded.require_up_to_date,
                   required_approvals = excluded.required_approvals,
                   count_agent_approvals = excluded.count_agent_approvals,
                   allow_ignoring_checks = excluded.allow_ignoring_checks,
                   merge_queue = excluded.merge_queue,
                   required_checks = excluded.required_checks,
                   require_code_owner_review = excluded.require_code_owner_review,
                   has_work_items = excluded.has_work_items,
                   allow_merge_commit = excluded.allow_merge_commit,
                   allow_squash_merge = excluded.allow_squash_merge,
                   allow_rebase_merge = excluded.allow_rebase_merge,
                   allow_fast_forward = excluded.allow_fast_forward,
                   default_merge_method = excluded.default_merge_method,
                   merge_commit_message = excluded.merge_commit_message,
                   squash_commit_message = excluded.squash_commit_message,
                   merge_commit_template = excluded.merge_commit_template,
                   squash_commit_template = excluded.squash_commit_template,
                   suggest_updating_branches = excluded.suggest_updating_branches,
                   allow_auto_merge = excluded.allow_auto_merge,
                   delete_branch_on_merge = excluded.delete_branch_on_merge,
                   require_web_commit_sign_off = excluded.require_web_commit_sign_off,
                   allow_commit_comments = excluded.allow_commit_comments,
                   auto_close_items = excluded.auto_close_items,
                   updated_by = excluded.updated_by,
                   updated_at = excluded.updated_at",
            )
            .bind(&[
                repo.id.as_str().into(),
                u32::from(settings.auto_merge).into(),
                u32::from(settings.require_up_to_date).into(),
                settings.required_approvals.into(),
                u32::from(settings.count_agent_approvals).into(),
                u32::from(settings.allow_ignoring_checks).into(),
                u32::from(settings.merge_queue).into(),
                serde_json::to_string(&settings.required_checks)?.into(),
                u32::from(settings.require_code_owner_review).into(),
                settings.has_work_items.map_or(worker::wasm_bindgen::JsValue::NULL, |on| u32::from(on).into()),
                bit(settings.allow_merge_commit),
                bit(settings.allow_squash_merge),
                bit(settings.allow_rebase_merge),
                bit(settings.allow_fast_forward),
                name_of(&settings.default_merge_method).into(),
                name_of(&settings.merge_commit_message).into(),
                name_of(&settings.squash_commit_message).into(),
                crate::optional(&settings.merge_commit_template),
                crate::optional(&settings.squash_commit_template),
                bit(settings.suggest_updating_branches),
                bit(settings.allow_auto_merge),
                bit(settings.delete_branch_on_merge),
                bit(settings.require_web_commit_sign_off),
                bit(settings.allow_commit_comments),
                bit(settings.auto_close_items),
                settings.updated_by.as_deref().unwrap_or_default().into(),
                settings.updated_at.as_deref().unwrap_or_default().into(),
            ])?
            .run()
            .await?;
        if protection_changed(&before, &settings) {
            self.write_branch_protection(&repo, &settings, &a.actor).await?;
        }
        // Auto-merge turned off: every pull request waiting to merge on its
        // own stops waiting (automerge.rs).
        if before.allow_auto_merge && !settings.allow_auto_merge {
            self.auto_merge_turned_off(&repo, &a.actor).await?;
        }
        // What its pull requests need may have changed with it.
        self.forget_stages(&repo.id).await?;
        Ok(Outcome::Ok(self.default_branch_settings(&repo).await?))
    }

    /// Whether work items can be filed from `repo`: its setting, or on
    /// unless it is a fork of another repository.
    pub(crate) async fn work_items_enabled(&self, repo: &g1t_contracts::repos::Repo) -> Result<bool> {
        Ok(self.settings(&repo.id).await?.work_items_on(repo.forked_from.is_some()))
    }
}

/// Why no work item can be filed from `repo`: they are off there.
pub(crate) fn work_items_off(repo: &g1t_contracts::repos::Repo) -> String {
    format!(
        "Work items are turned off for {}/{}: none can be filed from it. Its admins can turn them on in Settings.",
        repo.namespace, repo.name
    )
}

/// The longest merge or squash commit template.
const MAX_TEMPLATE_CHARS: usize = 2_000;

/// How pull requests merge, made consistent, or why it cannot be: at least
/// one method allowed, the default one of them (else the first allowed),
/// templates trimmed, and a custom message only with a template.
fn tidy_merge_settings(mut settings: RepoSettings) -> std::result::Result<RepoSettings, String> {
    if settings.allowed_methods().is_empty() {
        return Err("Allow at least one way to merge pull requests.".to_owned());
    }
    if !settings.allows(settings.default_merge_method) {
        settings.default_merge_method = settings.allowed_methods()[0];
    }
    // A squash's commits are listed only in a squash's message.
    if settings.merge_commit_message == CommitMessageDefault::PullTitleAndCommits {
        return Err("A merge commit's message cannot list the pull request's commits; choose another default.".to_owned());
    }
    for (template, kind) in [(&mut settings.merge_commit_template, "merge"), (&mut settings.squash_commit_template, "squash")] {
        *template = template.as_deref().map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned);
        if template.as_ref().is_some_and(|text| text.chars().count() > MAX_TEMPLATE_CHARS) {
            return Err(format!("The {kind} commit template is too long: keep it to {MAX_TEMPLATE_CHARS} characters."));
        }
    }
    if settings.merge_commit_message == CommitMessageDefault::Custom && settings.merge_commit_template.is_none() {
        return Err("Write the merge commit template, or choose another default message.".to_owned());
    }
    if settings.squash_commit_message == CommitMessageDefault::Custom && settings.squash_commit_template.is_none() {
        return Err("Write the squash commit template, or choose another default message.".to_owned());
    }
    Ok(settings)
}

/// Whether the branch protection part of the settings differs.
fn protection_changed(before: &RepoSettings, after: &RepoSettings) -> bool {
    let names = |settings: &RepoSettings| -> Vec<String> {
        let mut names: Vec<String> = settings.required_checks.iter().map(|name| name.to_lowercase()).collect();
        names.sort();
        names
    };
    names(before) != names(after)
        || before.require_up_to_date != after.require_up_to_date
        || before.required_approvals != after.required_approvals
        || before.count_agent_approvals != after.count_agent_approvals
        || before.allow_ignoring_checks != after.allow_ignoring_checks
        || before.merge_queue != after.merge_queue
        || before.require_code_owner_review != after.require_code_owner_review
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_protection_changes_count_as_protection_changes() {
        let before = RepoSettings::default();
        let auto = RepoSettings { auto_merge: true, ..RepoSettings::default() };
        assert!(!protection_changed(&before, &auto));
        let checks = RepoSettings { required_checks: vec!["CI".into()], ..RepoSettings::default() };
        assert!(protection_changed(&before, &checks));
        let same = RepoSettings { required_checks: vec!["ci".into()], ..RepoSettings::default() };
        assert!(!protection_changed(&checks, &same), "names compare without case");
        let approvals = RepoSettings { required_approvals: 1, ..RepoSettings::default() };
        assert!(protection_changed(&before, &approvals));
        let items = RepoSettings { has_work_items: Some(false), ..RepoSettings::default() };
        assert!(!protection_changed(&before, &items), "work items are not protection");
    }

    #[test]
    fn merge_settings_are_made_consistent_or_refused() {
        use g1t_contracts::rules::MergeMethod;
        let none = RepoSettings {
            allow_merge_commit: false,
            allow_squash_merge: false,
            allow_rebase_merge: false,
            allow_fast_forward: false,
            ..RepoSettings::default()
        };
        assert!(tidy_merge_settings(none).is_err(), "one method at least");
        // A default that is not allowed becomes the first that is.
        let squash_only = RepoSettings { allow_merge_commit: false, allow_rebase_merge: false, ..RepoSettings::default() };
        assert_eq!(tidy_merge_settings(squash_only).unwrap().default_merge_method, MergeMethod::Squash);
        let ff = RepoSettings {
            allow_merge_commit: false,
            allow_squash_merge: false,
            allow_rebase_merge: false,
            allow_fast_forward: true,
            default_merge_method: MergeMethod::Rebase,
            ..RepoSettings::default()
        };
        assert_eq!(tidy_merge_settings(ff).unwrap().default_merge_method, MergeMethod::FastForward);
        // Templates are trimmed; an empty one is none, which Custom needs.
        let blank = RepoSettings {
            squash_commit_message: CommitMessageDefault::Custom,
            squash_commit_template: Some("  ".into()),
            ..RepoSettings::default()
        };
        assert!(tidy_merge_settings(blank).is_err());
        let custom = RepoSettings {
            merge_commit_message: CommitMessageDefault::Custom,
            merge_commit_template: Some("  {title} (#{number})\n".into()),
            ..RepoSettings::default()
        };
        assert_eq!(tidy_merge_settings(custom).unwrap().merge_commit_template.as_deref(), Some("{title} (#{number})"));
        let long = RepoSettings { merge_commit_template: Some("x".repeat(MAX_TEMPLATE_CHARS + 1)), ..RepoSettings::default() };
        assert!(tidy_merge_settings(long).is_err());
        let commits = RepoSettings { merge_commit_message: CommitMessageDefault::PullTitleAndCommits, ..RepoSettings::default() };
        assert!(tidy_merge_settings(commits).is_err(), "squash only");
    }

    #[test]
    fn a_row_from_before_merge_settings_reads_as_the_defaults() {
        let read: RepoSettings = serde_json::from_value::<SettingsRow>(serde_json::json!({
            "auto_merge": 0, "require_up_to_date": 0, "required_approvals": 0,
            "count_agent_approvals": 1, "allow_ignoring_checks": 1,
            "updated_by": "ana", "updated_at": ""
        }))
        .unwrap()
        .into();
        let defaults = RepoSettings::default();
        assert_eq!(read.allowed_methods(), defaults.allowed_methods());
        assert_eq!(read.default_merge_method, defaults.default_merge_method);
        assert!(read.allow_auto_merge && read.auto_close_items && read.allow_commit_comments && read.suggest_updating_branches);
        assert!(!read.delete_branch_on_merge && !read.require_web_commit_sign_off);
        let stored: RepoSettings = serde_json::from_value::<SettingsRow>(serde_json::json!({
            "auto_merge": 0, "require_up_to_date": 0, "required_approvals": 0,
            "count_agent_approvals": 1, "allow_ignoring_checks": 1,
            "allow_merge_commit": 0, "allow_fast_forward": 1, "default_merge_method": "fast_forward",
            "squash_commit_message": "pull_title_and_commits", "delete_branch_on_merge": 1,
            "updated_by": "ana", "updated_at": ""
        }))
        .unwrap()
        .into();
        assert!(!stored.allow_merge_commit && stored.allow_fast_forward && stored.delete_branch_on_merge);
        assert_eq!(stored.default_merge_method, g1t_contracts::rules::MergeMethod::FastForward);
        assert_eq!(stored.squash_commit_message, CommitMessageDefault::PullTitleAndCommits);
        assert_eq!(name_of(&stored.squash_commit_message), "pull_title_and_commits");
    }

    #[test]
    fn work_items_are_on_by_default_except_in_a_fork() {
        let unset = RepoSettings::default();
        assert!(unset.work_items_on(false));
        assert!(!unset.work_items_on(true));
        let on = RepoSettings { has_work_items: Some(true), ..RepoSettings::default() };
        assert!(on.work_items_on(true), "a fork can turn them on");
        let off = RepoSettings { has_work_items: Some(false), ..RepoSettings::default() };
        assert!(!off.work_items_on(false));
    }

    #[test]
    fn a_stored_row_keeps_the_work_items_setting_or_its_absence() {
        let row = |has_work_items: serde_json::Value| -> RepoSettings {
            serde_json::from_value::<SettingsRow>(serde_json::json!({
                "auto_merge": 0, "require_up_to_date": 0, "required_approvals": 0,
                "count_agent_approvals": 1, "allow_ignoring_checks": 1,
                "has_work_items": has_work_items, "updated_by": "ana", "updated_at": ""
            }))
            .unwrap()
            .into()
        };
        assert_eq!(row(serde_json::Value::Null).has_work_items, None);
        assert_eq!(row(serde_json::json!(0)).has_work_items, Some(false));
        assert_eq!(row(serde_json::json!(1)).has_work_items, Some(true));
    }
}
