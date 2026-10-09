//! Deleting an account: what it takes with it, what stands in its way, and
//! how long g1t keeps it. Identity's `account_deletion.rs` does it; these
//! are its arguments and the rules every caller applies the same way.
//!
//! A person deletes their own account from their settings, signed in as
//! themselves, typing their username and proving it is them
//! ([`crate::accounts::Reauth`]); g1t's staff can delete one from sudo with
//! a reason. Neither is possible while the account is the only owner of a
//! live workspace: its owner transfers it or deletes it first. Staff may
//! instead delete those workspaces with it, in the same request
//! ([`AdminDeleteAccountArgs::with_sole_workspaces`]), unless one of them is
//! protected or its billing cannot settle ([`staff_sole_owner_refusal`]).
//! Accounts
//! that run g1t, and the names g1t shows for itself, can never be deleted
//! ([`is_protected_account`]).
//!
//! Deleting is soft first. The account's sessions, tokens, applications,
//! SSH keys, the deploy keys it added and its pending sign-ins end at once;
//! it leaves every workspace, team and repository; its profile is not
//! found and it cannot sign in. Its row is kept, holding its username, for
//! [`ACCOUNT_RESTORE_DAYS`], when staff can restore it. Then it is purged:
//! the row and its personal data go, the username is never given to anyone
//! again, and what it wrote shows as [`GHOST_USERNAME`].
//!
//! There is no API route for it: only the site and sudo delete accounts.

use serde::{Deserialize, Serialize};

use crate::User;
use crate::accounts::Reauth;

/// How long a deleted account is kept, for g1t's staff to restore, before
/// it is purged.
pub const ACCOUNT_RESTORE_DAYS: u64 = 30;

/// Who wrote what a purged account wrote: issues, pull requests, comments,
/// reviews, and commits made with its noreply address. Reserved: nobody may
/// register it.
pub const GHOST_USERNAME: &str = "ghost";

/// The account row `ghost` has, so that what pointed at a purged account
/// (a workspace's creator) points somewhere. It can never sign in.
pub const GHOST_ID: &str = "usr_ghost";

/// Whether the account `id`, called `username`, can never be deleted: one
/// of the names g1t shows for itself (`g1t`, `g1t-agent`, `ghost`; see
/// [`crate::is_reserved_name`]), or named by id or username in `names`
/// (from [`crate::identity::protected_names`] over identity's
/// `PROTECTED_ACCOUNTS`).
pub fn is_protected_account(names: &[String], id: &str, username: &str) -> bool {
    let named = |name: &str| names.iter().any(|protected| protected.eq_ignore_ascii_case(name.trim()));
    id == GHOST_ID || crate::is_reserved_name(username) || named(id) || named(username)
}

/// Why an account that is protected is not deleted or purged.
pub fn protected_account_refusal(username: &str) -> String {
    format!("{username} is protected and can never be deleted.")
}

/// A live workspace the account is the only owner of. Each one stands in
/// the way of deleting the account until it has another owner or is
/// deleted.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SoleOwnedWorkspace {
    pub slug: String,
    pub name: String,
    /// Everyone in it, the account included.
    pub members: u32,
    /// Why billing could not close it yet if it were deleted now, in words
    /// for its owner: what deleting it first would need. Null when nothing
    /// is owed.
    #[serde(default)]
    pub billing: Option<String>,
    /// It can never be deleted, by anyone (`PROTECTED_WORKSPACES`, or its
    /// row says so), so staff cannot delete it with the account either.
    #[serde(default)]
    pub protected: bool,
}

impl SoleOwnedWorkspace {
    /// Why staff cannot delete it with the account, or `None`.
    pub fn refusal(&self) -> Option<String> {
        if self.protected {
            return Some(crate::identity::protected_refusal(&self.slug));
        }
        self.billing.clone()
    }
}

/// Why staff cannot delete an account together with the workspaces it is
/// the only owner of: each one that is protected or whose billing cannot
/// settle, said in turn. `None` when every one can go.
pub fn staff_sole_owner_refusal(workspaces: &[SoleOwnedWorkspace]) -> Option<String> {
    let reasons: Vec<String> = workspaces.iter().filter_map(SoleOwnedWorkspace::refusal).collect();
    if reasons.is_empty() {
        return None;
    }
    Some(format!("Nothing was deleted. {}", reasons.join(" ")))
}

/// A workspace staff deleted together with the account that alone owned
/// it, kept in the account's [`AccountWent`] so sudo can show it and purge
/// it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDeletedWith {
    pub workspace_id: String,
    pub slug: String,
}

/// `check_account_deletion` (takes `UserArgs`, people only) returns
/// `Outcome<AccountDeletion>`: what deleting the account would take with
/// it, and what stands in the way, changing nothing. Nothing does when
/// `sole_owner_of` is empty and it is not `protected`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountDeletion {
    pub username: String,
    /// Live workspaces it is a member or owner of, which it leaves.
    pub workspaces: u32,
    /// Its personal access tokens.
    pub tokens: u32,
    pub ssh_keys: u32,
    /// Applications signed in as it (OAuth).
    pub applications: u32,
    /// Repositories it has a role on directly, as an outside collaborator
    /// or a member given more.
    pub repositories: u32,
    /// Workspaces it is the only owner of.
    #[serde(default)]
    pub sole_owner_of: Vec<SoleOwnedWorkspace>,
    /// It can never be deleted, by anyone.
    #[serde(default)]
    pub protected: bool,
}

impl AccountDeletion {
    pub fn blocked(&self) -> bool {
        self.reason().is_some()
    }

    /// Why the account cannot be deleted, as one sentence, or `None`.
    pub fn reason(&self) -> Option<String> {
        if self.protected {
            return Some(protected_account_refusal(&self.username));
        }
        sole_owner_refusal(&self.sole_owner_of)
    }
}

/// Why an account that is the only owner of `workspaces` cannot be
/// deleted, naming them, or `None` when it owns none alone.
pub fn sole_owner_refusal(workspaces: &[SoleOwnedWorkspace]) -> Option<String> {
    let slugs: Vec<&str> = workspaces.iter().map(|workspace| workspace.slug.as_str()).collect();
    match slugs.as_slice() {
        [] => None,
        [one] => Some(format!(
            "You are the only owner of {one}. Make someone else an owner of it, or delete it, first."
        )),
        many => Some(format!(
            "You are the only owner of {}. Make someone else an owner of each, or delete them, first.",
            list(many)
        )),
    }
}

/// `a`, `a and b`, `a, b and c`.
fn list(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// Whether what was typed confirms `username`: the username itself, in
/// any case, without the spaces around it.
pub fn confirms_username(username: &str, typed: &str) -> bool {
    let typed = typed.trim();
    !typed.is_empty() && typed.eq_ignore_ascii_case(username.trim())
}

/// `delete_account`: the person deletes their own account. `confirm` is
/// their username typed out; `reauth` is proof it is them. Refused for
/// anyone but the person themselves (never a token's or an agent's), for a
/// protected account, and while they are the only owner of a live
/// workspace. Publishes `user.deleting`. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteAccountArgs {
    pub user: User,
    #[serde(default)]
    pub confirm: String,
    #[serde(default)]
    pub reauth: Reauth,
}

/// What went with a deleted account, counted when it was deleted, and who
/// deleted it when it was staff.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountWent {
    pub workspaces: u32,
    pub teams: u32,
    pub repositories: u32,
    pub tokens: u32,
    pub ssh_keys: u32,
    /// The staff member who deleted it, by email; null when the person did.
    #[serde(default)]
    pub staff: Option<String>,
    /// Why staff deleted it.
    #[serde(default)]
    pub reason: Option<String>,
    /// The workspaces it was the only owner of that staff deleted with it,
    /// in the same request (`with_sole_workspaces`). Each is deleted the
    /// way an owner deletes one, and restored or purged on its own.
    #[serde(default)]
    pub deleted_workspaces: Vec<WorkspaceDeletedWith>,
}

/// An account deleted and kept until `purge_after` for staff to restore.
/// `admin_deleted_accounts` takes no arguments (`{}`) and returns
/// `Vec<DeletedAccount>`, newest first. Staff only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedAccount {
    pub user_id: String,
    pub username: String,
    /// RFC 3339.
    pub deleted_at: String,
    /// RFC 3339: when it is purged unless restored first.
    pub purge_after: String,
    pub went: AccountWent,
    /// Whether staff can still restore it.
    pub restorable: bool,
}

/// `admin_delete_account`: staff delete an account, with a reason (kept in
/// sudo's audit log and the account's record). `confirm` is the username
/// typed out. Refused for a protected account, and while it is the only
/// owner of a live workspace unless `with_sole_workspaces`. Returns
/// `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminDeleteAccountArgs {
    pub username: String,
    pub reason: String,
    #[serde(default)]
    pub confirm: String,
    /// The staff member, by email.
    pub staff: String,
    /// Delete the workspaces the account is the only owner of first, each
    /// exactly as its owner would (billing closes it, `workspace.deleting`,
    /// its audit log), with the staff member as `deleted_by`, then the
    /// account. Refused whole, deleting nothing, while any of them is
    /// protected or its billing cannot settle
    /// ([`staff_sole_owner_refusal`]). Should one fail on the way (a card
    /// declined that moment), the account is not deleted, and the failure
    /// says which workspace, and which went before it.
    #[serde(default)]
    pub with_sole_workspaces: bool,
}

/// `admin_restore_account` and `admin_purge_account`: staff restore a
/// deleted account within [`ACCOUNT_RESTORE_DAYS`], or purge it now.
/// Purging needs `confirm`, the username typed out. Restoring publishes
/// `user.restored`; purging, `user.deleted`. Both return `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminDeletedAccountArgs {
    pub user_id: String,
    pub staff: String,
    #[serde(default)]
    pub confirm: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::protected_names;

    fn sole(slug: &str) -> SoleOwnedWorkspace {
        SoleOwnedWorkspace { slug: slug.into(), name: slug.into(), members: 1, billing: None, protected: false }
    }

    #[test]
    fn staff_are_told_each_workspace_that_cannot_go_with_the_account() {
        assert_eq!(staff_sole_owner_refusal(&[]), None);
        assert_eq!(staff_sole_owner_refusal(&[sole("acme"), sole("globex")]), None);
        let protected = SoleOwnedWorkspace { protected: true, ..sole("flagon-io") };
        let owing = SoleOwnedWorkspace { billing: Some("globex has an unpaid invoice.".into()), ..sole("globex") };
        assert_eq!(
            staff_sole_owner_refusal(&[sole("acme"), protected, owing]).unwrap(),
            "Nothing was deleted. flagon-io is protected and can never be deleted. globex has an unpaid invoice."
        );
    }

    #[test]
    fn older_records_and_requests_read_without_the_new_fields() {
        let old: AccountWent =
            serde_json::from_str(r#"{"workspaces":1,"teams":0,"repositories":0,"tokens":0,"sshKeys":0}"#).unwrap();
        assert!(old.deleted_workspaces.is_empty());
        let args: AdminDeleteAccountArgs =
            serde_json::from_str(r#"{"username":"ada","reason":"r","staff":"s","withSoleWorkspaces":true}"#).unwrap();
        assert!(args.with_sole_workspaces);
        let args: AdminDeleteAccountArgs = serde_json::from_str(r#"{"username":"ada","reason":"r","staff":"s"}"#).unwrap();
        assert!(!args.with_sole_workspaces);
    }

    #[test]
    fn g1t_ghost_and_named_accounts_are_protected() {
        let names = protected_names(Some("usr_keep, Ada"));
        for (id, username) in [
            ("usr_1", "g1t"),
            ("usr_1", "G1T-Agent"),
            ("usr_1", "ghost"),
            (GHOST_ID, "anything"),
            ("usr_keep", "someone"),
            ("usr_2", "ada"),
        ] {
            assert!(is_protected_account(&names, id, username), "{id} {username}");
        }
        assert!(!is_protected_account(&names, "usr_3", "grace"));
        assert!(!is_protected_account(&protected_names(None), "usr_3", "ghosts"));
    }

    #[test]
    fn the_only_owner_of_a_workspace_is_told_which() {
        assert_eq!(sole_owner_refusal(&[]), None);
        assert_eq!(
            sole_owner_refusal(&[sole("acme")]).unwrap(),
            "You are the only owner of acme. Make someone else an owner of it, or delete it, first."
        );
        assert_eq!(
            sole_owner_refusal(&[sole("acme"), sole("globex"), sole("initech")]).unwrap(),
            "You are the only owner of acme, globex and initech. Make someone else an owner of each, or delete them, first."
        );
    }

    #[test]
    fn protection_comes_before_ownership() {
        let deletion = AccountDeletion {
            username: "g1t".into(),
            sole_owner_of: vec![sole("acme")],
            protected: true,
            ..AccountDeletion::default()
        };
        assert_eq!(deletion.reason().unwrap(), "g1t is protected and can never be deleted.");
        assert!(deletion.blocked());
        let free = AccountDeletion { username: "ada".into(), ..AccountDeletion::default() };
        assert!(!free.blocked());
    }

    #[test]
    fn only_the_username_itself_confirms() {
        assert!(confirms_username("ada", " Ada "));
        assert!(!confirms_username("ada", ""));
        assert!(!confirms_username("ada", "ada-l"));
        assert!(!confirms_username("ada", "   "));
    }
}
