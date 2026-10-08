//! A person's email addresses and the security of their account: identity's
//! methods for them, and the rules they follow, kept pure so every caller
//! applies the same ones.
//!
//! An account has up to [`MAX_EMAILS`] addresses. One is primary: account
//! mail and password resets go there. A confirmed address belongs to one
//! account; until someone confirms it, any account may have added it, and
//! the first to confirm it keeps it. Sensitive changes need the person to
//! have signed in within [`RECENT_AUTH_SECONDS`], or to give their password
//! again ([`Reauth`]); a refusal for that is `FailureCode::ReauthRequired`.
//!
//! An account can turn on two-factor authentication: a code from an
//! authenticator app (TOTP, RFC 6238), with recovery codes for when the app
//! is lost. Signing in with a password then asks for a code as well.
//!
//! Workspaces can ask more of their members. [`WorkspacePolicy`] is where
//! that goes: identity evaluates it wherever someone gains or uses access
//! to a workspace. Today an owner can require two-factor authentication;
//! the email rules are there for later.

use serde::{Deserialize, Serialize};

use crate::User;

/// The most addresses one account may have, confirmed or not.
pub const MAX_EMAILS: usize = 10;

/// How long after signing in (or confirming the password) a person may make
/// sensitive changes without being asked to prove it is them again.
pub const RECENT_AUTH_SECONDS: u64 = 10 * 60;

/// The least time between two confirmation emails to one address.
pub const RESEND_SECONDS: u64 = 60;

/// Where each person's private commit address lives:
/// `<id suffix>+<username>@users.noreply.g1t.sh`.
pub const NOREPLY_DOMAIN: &str = "users.noreply.g1t.sh";

/// How many characters of the account id the noreply address carries. The
/// end of an id is its random part, so a username alone never resolves.
pub const NOREPLY_ID_CHARS: usize = 8;

/// An address trimmed and lowercased, if it looks like one: something, an
/// `@`, and a domain with a dot, at most 254 characters, no spaces.
pub fn normalize_email(text: &str) -> Option<String> {
    let email = text.trim().to_lowercase();
    let well_formed = email.len() <= 254
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && !domain.contains('@') && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
        })
        && !email.contains(char::is_whitespace);
    well_formed.then_some(email)
}

/// The person's noreply address, used for commits g1t makes for them when
/// they keep their address private.
pub fn noreply_address(user_id: &str, username: &str) -> String {
    format!("{}+{}@{NOREPLY_DOMAIN}", id_suffix(user_id), username.to_lowercase())
}

/// The last [`NOREPLY_ID_CHARS`] characters of an account id, lowercased.
pub fn id_suffix(user_id: &str) -> String {
    let chars: Vec<char> = user_id.chars().collect();
    let start = chars.len().saturating_sub(NOREPLY_ID_CHARS);
    chars[start..].iter().collect::<String>().to_lowercase()
}

/// The id suffix and username a noreply address names, or `None` for any
/// other address.
pub fn parse_noreply(email: &str) -> Option<(String, String)> {
    let email = email.trim().to_lowercase();
    let local = email.strip_suffix(&format!("@{NOREPLY_DOMAIN}"))?;
    let (suffix, username) = local.split_once('+')?;
    (suffix.chars().count() == NOREPLY_ID_CHARS && !username.is_empty()).then(|| (suffix.to_owned(), username.to_owned()))
}

/// Whether a sign-in at `authenticated_at` (RFC 3339) is recent at `now`
/// (RFC 3339), within `window_seconds`. Both are g1t's fixed format, which
/// compares as text.
pub fn is_recent(authenticated_at: Option<&str>, now_ms: u64, window_seconds: u64) -> bool {
    let since = crate::time::rfc3339(now_ms.saturating_sub(window_seconds * 1000));
    authenticated_at.is_some_and(|at| at >= since.as_str())
}

/// One address, as the rules about removing and choosing addresses see it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmailState {
    pub email: String,
    pub verified: bool,
    pub primary: bool,
}

/// Why `email` cannot be removed from an account with `all`, or `None`.
pub fn removal_refusal(all: &[EmailState], email: &str) -> Option<&'static str> {
    let Some(target) = all.iter().find(|state| state.email == email) else {
        return Some("That address is not on your account.");
    };
    if target.primary {
        return Some("That is your primary address. Make another confirmed address primary first.");
    }
    let confirmed = all.iter().filter(|state| state.verified).count();
    if target.verified && confirmed <= 1 {
        return Some("That is your only confirmed address. Add and confirm another first.");
    }
    None
}

/// Why `email` cannot be made primary, or `None`.
pub fn primary_refusal(all: &[EmailState], email: &str) -> Option<&'static str> {
    match all.iter().find(|state| state.email == email) {
        None => Some("That address is not on your account."),
        Some(state) if !state.verified => Some("Confirm that address before making it primary."),
        Some(_) => None,
    }
}

/// Proof that the person making a sensitive change is the account's owner,
/// now. Either is enough: the session they are using, if they signed in to
/// it within [`RECENT_AUTH_SECONDS`], or their password. A correct password
/// also renews the session's sign-in time, so they are not asked again
/// straight away.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reauth {
    #[serde(default)]
    pub session_token: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    /// Who is asking, such as the visitor's IP address, so wrong passwords
    /// are counted against it too.
    #[serde(default)]
    pub client: Option<String>,
}

/// One of a person's addresses, as they see it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEmail {
    /// As typed when it was added.
    pub email: String,
    pub verified: bool,
    pub primary: bool,
    /// Gets security notices as well as the primary.
    pub backup: bool,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub verified_at: Option<String>,
}

/// A person's addresses and what they do with them. `list_emails` (takes
/// `UserArgs`) returns `Outcome<AccountEmails>`, and so does every change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEmails {
    /// The primary first, then confirmed addresses, then the rest, oldest
    /// first within each.
    pub emails: Vec<AccountEmail>,
    /// Commits g1t makes for the person use `noreply`, not the primary.
    pub private_email: bool,
    /// Pushes of commits that carry one of the person's addresses are
    /// refused while `private_email` is on.
    pub block_private_pushes: bool,
    /// `<id suffix>+<username>@users.noreply.g1t.sh`.
    pub noreply: String,
    /// The address commits g1t makes for the person carry now.
    pub commit_email: String,
    /// [`MAX_EMAILS`].
    pub limit: u32,
}

/// `add_email`: adds an address and emails it a confirmation link; adding
/// one already on the account and unconfirmed sends the link again.
/// `remove_email`: removes one, never the primary nor the last confirmed
/// address. Both need [`Reauth`] and tell every confirmed address.
/// `resend_email_verification` sends the link again, at most once every
/// [`RESEND_SECONDS`], and needs no reauth. People only: never an agent's
/// or a workspace's token.
#[derive(Debug, Serialize, Deserialize)]
pub struct AccountEmailArgs {
    pub user: User,
    pub email: String,
    #[serde(default)]
    pub reauth: Reauth,
}

// --- Confirming an address ---

/// How many digits the code in a confirmation email has.
pub const CONFIRM_CODE_DIGITS: usize = 6;

/// How long the code and the link in a confirmation email work. Sending
/// another email ends both at once.
pub const CONFIRM_TTL_SECONDS: u64 = 60 * 60;

/// What an account that has not confirmed its address hears from anything
/// other than the pages that confirm it: the API, MCP and git. `site` is
/// where the confirmation page is, such as `https://g1t.sh`.
pub fn confirm_email_first(site: &str) -> String {
    format!(
        "Confirm your email address first: enter the code from the email g1t sent you at {}/confirm-email, or follow the link in it.",
        site.trim_end_matches('/')
    )
}

/// A confirmation code as typed or pasted, with spaces and hyphens taken
/// out; None unless that leaves exactly [`CONFIRM_CODE_DIGITS`] digits.
pub fn tidy_confirm_code(code: &str) -> Option<String> {
    let digits: String = code.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    (digits.len() == CONFIRM_CODE_DIGITS && digits.chars().all(|c| c.is_ascii_digit())).then_some(digits)
}

/// `confirm_email_code`: the code from a confirmation email, typed by the
/// signed-in person it was sent to. It confirms the address it was sent
/// to. Wrong codes are counted against the account and `client`; past a
/// limit nothing is checked for a while. Returns `Outcome<EmailConfirmed>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfirmEmailCodeArgs {
    pub user: User,
    pub code: String,
    /// Who is asking, such as the visitor's IP address, for rate limits.
    #[serde(default)]
    pub client: Option<String>,
}

/// `change_pending_email`: for an account that has not confirmed any
/// address, replaces the address it signed up with and sends a new code
/// and link there. Returns `Outcome<AccountEmails>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct PendingEmailArgs {
    pub user: User,
    pub email: String,
}

/// What confirming an address did. `verify_email` (the link) and
/// `confirm_email_code` (the code) return it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailConfirmed {
    pub username: String,
    /// The address confirmed, as typed when it was added.
    pub email: String,
    /// Whether the account is confirmed now: whether its primary is.
    pub verified: bool,
    /// The workspace the invite the account signed up with joined it to,
    /// by slug, now that the account is confirmed.
    #[serde(default)]
    pub joined: Option<String>,
    /// Why the invite the account signed up with no longer applies, when it
    /// was revoked, expired or its workspace deleted while the account
    /// waited. The address is confirmed all the same.
    #[serde(default)]
    pub invite_lapsed: Option<String>,
}

/// `update_email_settings`: each field given is changed. `primary` must be
/// a confirmed address. `backup` is a confirmed address to get security
/// notices too, or empty for the primary only. Changing either needs
/// [`Reauth`]; the privacy switches do not. Returns `Outcome<AccountEmails>`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailSettingsArgs {
    pub user: User,
    #[serde(default)]
    pub primary: Option<String>,
    #[serde(default)]
    pub backup: Option<String>,
    #[serde(default)]
    pub private_email: Option<bool>,
    #[serde(default)]
    pub block_private_pushes: Option<bool>,
    #[serde(default)]
    pub reauth: Reauth,
}

/// `reauthenticate`: the person typed their password again for the session
/// they are using; sensitive changes need no more proof for
/// [`RECENT_AUTH_SECONDS`]. Returns `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReauthenticateArgs {
    pub session_token: String,
    pub password: String,
    #[serde(default)]
    pub client: Option<String>,
}

/// `email_owners`: who wrote commits, by their author addresses. Matches
/// confirmed addresses and noreply addresses only, never an unconfirmed
/// one. At most 200 addresses. Returns a map from each address that
/// matched, lowercased, to its owner.
#[derive(Debug, Serialize, Deserialize)]
pub struct EmailOwnersArgs {
    pub emails: Vec<String>,
}

/// The account an address belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmailOwner {
    pub id: String,
    pub username: String,
    pub avatar: Option<String>,
}

/// `commit_identity`: the name and address to put on a commit g1t makes for
/// a person (a merge, a web edit, catching a branch up). Their noreply
/// address while they keep their address private, otherwise their primary.
/// Returns `Option<CommitIdentity>`; null for an unknown account.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitIdentityArgs {
    pub user_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitIdentity {
    pub name: String,
    pub email: String,
}

/// `push_email_guard` (takes `CommitIdentityArgs`): what a push by this
/// person must not publish. Returns `Option<PushEmailGuard>`: null unless
/// they keep their address private and block pushes that expose it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushEmailGuard {
    /// Their confirmed addresses, lowercased.
    pub emails: Vec<String>,
    /// The address to commit with instead.
    pub noreply: String,
}

impl PushEmailGuard {
    /// Whether a commit carrying `email` would publish one of the
    /// person's addresses.
    pub fn exposes(&self, email: &str) -> bool {
        let email = email.trim().to_lowercase();
        !email.is_empty() && self.emails.contains(&email)
    }
}

/// An address with all but the first letter of its local part hidden:
/// `s***@gmail.com`.
pub fn mask_email(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) => {
            let first: String = local.chars().take(1).collect();
            format!("{first}***@{domain}")
        }
        None => "***".to_owned(),
    }
}

/// Something that happened to an account's security. `security_log` (takes
/// `UserArgs`) returns the newest [`SECURITY_LOG_LIMIT`], newest first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityEvent {
    /// `email_added`, `email_verified`, `email_removed`,
    /// `primary_email_changed`, `backup_email_changed`,
    /// `email_privacy_changed`, `password_changed`, `two_factor_enabled`,
    /// `two_factor_disabled`, `recovery_codes_regenerated`,
    /// `recovery_code_used`, `token_created`, `token_deleted`,
    /// `token_rescoped`, `ssh_key_added`, `ssh_key_removed`,
    /// `oauth_grant_created`, `oauth_grant_revoked` or
    /// `oauth_grant_rescoped`.
    pub kind: String,
    /// The address concerned, or what changed.
    pub detail: Option<String>,
    /// Whether g1t staff made the change.
    pub by_staff: bool,
    /// Why staff made it.
    pub reason: Option<String>,
    /// The staff member, by email. Only in staff views.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staff: Option<String>,
    /// RFC 3339.
    pub created_at: String,
}

/// How many entries `security_log` returns.
pub const SECURITY_LOG_LIMIT: usize = 50;

// --- Two-factor authentication ---

/// How long one TOTP code lasts, in seconds (RFC 6238's default).
pub const TOTP_STEP_SECONDS: u64 = 30;
/// How many digits a code has.
pub const TOTP_DIGITS: u32 = 6;
/// How many steps either side of now a code is accepted from, for clocks
/// that are a little off: one, so a code works for up to 90 seconds.
pub const TOTP_SKEW_STEPS: u64 = 1;
/// How many recovery codes an account gets.
pub const RECOVERY_CODES: usize = 10;
/// How long a sign-in waits for its code, in seconds.
pub const TWO_FACTOR_CHALLENGE_SECONDS: u64 = 10 * 60;
/// How many wrong codes one sign-in may have before it must start again.
pub const TWO_FACTOR_ATTEMPTS: u32 = 5;
/// The issuer authenticator apps show beside the account.
pub const TOTP_ISSUER: &str = "g1t";

/// Where an account's two-factor authentication stands.
/// `two_factor_status` (takes `UserArgs`) returns `Outcome<TwoFactorStatus>`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TwoFactorStatus {
    pub enabled: bool,
    /// RFC 3339.
    pub enabled_at: Option<String>,
    /// Recovery codes not used yet.
    pub recovery_codes_left: u32,
    /// The workspaces the person belongs to that require it.
    pub required_by: Vec<String>,
}

/// What an authenticator app needs: the secret in base32, and the same as
/// an `otpauth://` address for a QR code.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TwoFactorSetup {
    pub secret: String,
    pub uri: String,
}

/// Single-use recovery codes, shown once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryCodes {
    pub codes: Vec<String>,
}

/// `two_factor_start`: begins turning it on, replacing any enrolment in
/// progress. Needs [`Reauth`]. Refused while it is on. Returns
/// `Outcome<TwoFactorSetup>`.
///
/// `two_factor_recovery_codes`: makes new recovery codes, replacing the
/// old ones. Needs [`Reauth`] and two-factor on. Returns
/// `Outcome<RecoveryCodes>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct TwoFactorArgs {
    pub user: User,
    #[serde(default)]
    pub reauth: Reauth,
}

/// `two_factor_enable`: a code from the app confirms the enrolment, and
/// two-factor is on; returns the recovery codes, shown once.
/// `two_factor_disable`: turns it off; needs a code (or a recovery code)
/// as well as [`Reauth`]. Refused for an owner of a workspace that
/// requires it. Both return `Outcome<...>`: `RecoveryCodes` and `bool`.
#[derive(Debug, Serialize, Deserialize)]
pub struct TwoFactorCodeArgs {
    pub user: User,
    pub code: String,
    #[serde(default)]
    pub reauth: Reauth,
}

/// `two_factor_sign_in`: the second step of signing in. `challenge` is
/// what `sign_in` returned as `SignedIn::two_factor_challenge`; `code` is a
/// code from the app or a recovery code. Returns `Outcome<SignedIn>`, with
/// a session.
#[derive(Debug, Serialize, Deserialize)]
pub struct TwoFactorSignInArgs {
    pub challenge: String,
    pub code: String,
    #[serde(default)]
    pub client: Option<String>,
}

/// The `otpauth://` address for a secret, as authenticator apps read it
/// from a QR code.
pub fn otpauth_uri(secret_base32: &str, username: &str) -> String {
    let label: String = format!("{TOTP_ISSUER}:{username}")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "-._~:".contains(c) { c.to_string() } else { format!("%{:02X}", c as u32) })
        .collect();
    format!(
        "otpauth://totp/{label}?secret={secret_base32}&issuer={TOTP_ISSUER}&algorithm=SHA1&digits={TOTP_DIGITS}&period={TOTP_STEP_SECONDS}"
    )
}

/// A code as typed, tidied: spaces and hyphens taken out, lowercased.
pub fn tidy_code(code: &str) -> String {
    code.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_lowercase()
}

/// Whether a tidied code is shaped like an app's: six digits.
pub fn is_totp_shaped(code: &str) -> bool {
    code.len() == TOTP_DIGITS as usize && code.chars().all(|c| c.is_ascii_digit())
}

// --- Staff ---

/// `admin_user` (takes `UsernameArgs`): one account's addresses and
/// security log, for staff. Returns `Option<AdminUser>`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUser {
    pub id: String,
    pub username: String,
    /// RFC 3339.
    pub created_at: String,
    pub emails: Vec<AccountEmail>,
    pub private_email: bool,
    pub log: Vec<SecurityEvent>,
}

/// `admin_remove_email`: staff remove an address from an account, such as
/// an unconfirmed one someone else needs or a compromised one. Never the
/// last confirmed address; removing the primary makes the oldest other
/// confirmed address primary. Recorded in the person's security log with
/// the reason, and the person is told. Returns `Outcome<AdminUser>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AdminRemoveEmailArgs {
    pub username: String,
    pub email: String,
    pub reason: String,
    /// The staff member, by email.
    pub staff: String,
}

// --- Workspace policy ---

/// What a workspace asks of its members' accounts. Nothing, today, for
/// every workspace ([`WorkspacePolicy::default`]); identity already checks
/// it wherever someone joins a workspace or uses access to one, so asking
/// for more is a matter of storing it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePolicy {
    /// Members need a confirmed address at one of these domains. Empty:
    /// any domain.
    #[serde(default)]
    pub allowed_email_domains: Vec<String>,
    /// Members need a confirmed address at all.
    #[serde(default)]
    pub require_verified_email: bool,
    /// Members need a second factor on their account.
    #[serde(default)]
    pub require_two_factor: bool,
}

/// What a policy can ask about an account.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SecurityFacts {
    /// Lowercased.
    pub verified_emails: Vec<String>,
    pub two_factor: bool,
}

/// What an account lacks to meet a workspace's policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyGap {
    VerifiedEmail,
    EmailDomain(Vec<String>),
    TwoFactor,
}

impl PolicyGap {
    /// Its name: `verified_email`, `email_domain` or `two_factor`.
    pub fn as_str(&self) -> &'static str {
        match self {
            PolicyGap::VerifiedEmail => "verified_email",
            PolicyGap::EmailDomain(_) => "email_domain",
            PolicyGap::TwoFactor => "two_factor",
        }
    }

    /// What to tell the person, for a workspace named `slug`.
    pub fn message(&self, slug: &str) -> String {
        match self {
            PolicyGap::VerifiedEmail => format!("{slug} needs members to have a confirmed email address."),
            PolicyGap::EmailDomain(domains) => format!(
                "{slug} needs members to have a confirmed address at {}. Add one in your account settings.",
                domains.join(" or ")
            ),
            PolicyGap::TwoFactor => format!("{slug} requires two-factor authentication. Turn it on in your account's security settings to use it again."),
        }
    }
}

impl WorkspacePolicy {
    /// Whether the policy asks for anything, so callers can skip gathering
    /// [`SecurityFacts`] when it does not.
    pub fn asks_nothing(&self) -> bool {
        self.allowed_email_domains.is_empty() && !self.require_verified_email && !self.require_two_factor
    }

    /// Everything the account lacks, or an empty list when it meets the
    /// policy.
    pub fn gaps(&self, facts: &SecurityFacts) -> Vec<PolicyGap> {
        let mut gaps = Vec::new();
        if self.require_verified_email && facts.verified_emails.is_empty() {
            gaps.push(PolicyGap::VerifiedEmail);
        }
        if !self.allowed_email_domains.is_empty() {
            let allowed: Vec<String> = self.allowed_email_domains.iter().map(|domain| domain.trim().trim_start_matches('@').to_lowercase()).collect();
            let has = facts.verified_emails.iter().any(|email| {
                email
                    .rsplit_once('@')
                    .is_some_and(|(_, domain)| allowed.iter().any(|allowed| domain == allowed))
            });
            if !has {
                gaps.push(PolicyGap::EmailDomain(allowed));
            }
        }
        if self.require_two_factor && !facts.two_factor {
            gaps.push(PolicyGap::TwoFactor);
        }
        gaps
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_confirmation_code_is_six_digits_however_it_is_typed() {
        assert_eq!(tidy_confirm_code("482913").as_deref(), Some("482913"));
        assert_eq!(tidy_confirm_code(" 482 913 ").as_deref(), Some("482913"));
        assert_eq!(tidy_confirm_code("482-913").as_deref(), Some("482913"));
        assert_eq!(tidy_confirm_code("48291"), None);
        assert_eq!(tidy_confirm_code("4829134"), None);
        assert_eq!(tidy_confirm_code("48291a"), None);
        assert_eq!(tidy_confirm_code(""), None);
    }

    #[test]
    fn a_pending_account_is_a_person_without_a_confirmed_address() {
        let person = User { id: "usr_1".into(), username: "ada".into(), ..User::default() };
        assert!(person.awaits_confirmation());
        assert!(!User { verified: true, ..person.clone() }.awaits_confirmation());
        // A workspace's token, an agent and g1t itself are never pending.
        assert!(!User { kind: crate::PrincipalKind::Workspace, ..person.clone() }.awaits_confirmation());
        assert!(!User { kind: crate::PrincipalKind::Agent, ..person.clone() }.awaits_confirmation());
        assert!(!User::system("acme").awaits_confirmation());
        let said = confirm_email_first("https://git.example.com/");
        assert!(said.contains("https://git.example.com/confirm-email"));
        assert!(said.starts_with("Confirm your email address first"));
    }

    #[test]
    fn a_push_guard_matches_the_persons_own_addresses_and_masks_them() {
        let guard = PushEmailGuard { emails: vec!["sam@gmail.com".into()], noreply: "abc+sam@users.noreply.g1t.sh".into() };
        assert!(guard.exposes(" Sam@Gmail.com"));
        assert!(!guard.exposes("abc+sam@users.noreply.g1t.sh"));
        assert!(!guard.exposes("someone@gmail.com"));
        assert!(!guard.exposes(""));
        assert_eq!(mask_email("sam@gmail.com"), "s***@gmail.com");
        assert_eq!(mask_email("nope"), "***");
    }

    fn state(email: &str, verified: bool, primary: bool) -> EmailState {
        EmailState { email: email.into(), verified, primary }
    }

    #[test]
    fn addresses_are_trimmed_lowercased_and_checked() {
        assert_eq!(normalize_email("  Ada@Example.COM "), Some("ada@example.com".into()));
        assert_eq!(normalize_email("ada+g1t@mail.example.co.uk"), Some("ada+g1t@mail.example.co.uk".into()));
        for bad in ["", "ada", "@example.com", "ada@example", "ada@@example.com", "a da@example.com", "ada@.com", "ada@example."] {
            assert_eq!(normalize_email(bad), None, "{bad}");
        }
        assert_eq!(normalize_email(&format!("{}@example.com", "a".repeat(250))), None);
    }

    #[test]
    fn the_noreply_address_carries_the_end_of_the_id_and_the_username() {
        let address = noreply_address("usr_01j9zq4m8x7k2v5n3b6c1d0efg", "Ada");
        assert_eq!(address, "6c1d0efg+ada@users.noreply.g1t.sh");
        assert_eq!(parse_noreply(&address), Some(("6c1d0efg".into(), "ada".into())));
        assert_eq!(parse_noreply("6C1D0EFG+Ada@Users.Noreply.G1T.sh"), Some(("6c1d0efg".into(), "ada".into())));
        assert_eq!(parse_noreply("ada@example.com"), None);
        assert_eq!(parse_noreply("short+ada@users.noreply.g1t.sh"), None);
        assert_eq!(parse_noreply("6c1d0efg@users.noreply.g1t.sh"), None);
        assert_eq!(parse_noreply("6c1d0efg+@users.noreply.g1t.sh"), None);
        assert_eq!(id_suffix("usr_x"), "usr_x");
    }

    #[test]
    fn a_sign_in_is_recent_for_ten_minutes() {
        let now = 1_800_000_000_000;
        let at = |ms_ago: u64| crate::time::rfc3339(now - ms_ago);
        assert!(is_recent(Some(&at(0)), now, RECENT_AUTH_SECONDS));
        assert!(is_recent(Some(&at(9 * 60 * 1000)), now, RECENT_AUTH_SECONDS));
        assert!(is_recent(Some(&at(10 * 60 * 1000)), now, RECENT_AUTH_SECONDS));
        assert!(!is_recent(Some(&at(10 * 60 * 1000 + 1)), now, RECENT_AUTH_SECONDS));
        assert!(!is_recent(None, now, RECENT_AUTH_SECONDS));
    }

    #[test]
    fn neither_the_primary_nor_the_last_confirmed_address_can_be_removed() {
        let all = [state("a@x.io", true, true), state("b@x.io", true, false), state("c@x.io", false, false)];
        assert!(removal_refusal(&all, "a@x.io").unwrap().contains("primary"));
        assert_eq!(removal_refusal(&all, "b@x.io"), None);
        assert_eq!(removal_refusal(&all, "c@x.io"), None);
        assert!(removal_refusal(&all, "d@x.io").is_some());
        // An unconfirmed primary (a new account) stays; so does the only
        // confirmed address, primary or not.
        let lone = [state("a@x.io", false, true), state("b@x.io", true, false)];
        assert!(removal_refusal(&lone, "b@x.io").unwrap().contains("only confirmed"));
    }

    #[test]
    fn only_a_confirmed_address_can_be_primary() {
        let all = [state("a@x.io", true, true), state("b@x.io", false, false)];
        assert_eq!(primary_refusal(&all, "a@x.io"), None);
        assert!(primary_refusal(&all, "b@x.io").unwrap().contains("Confirm"));
        assert!(primary_refusal(&all, "z@x.io").is_some());
    }

    #[test]
    fn the_otpauth_address_names_the_account_and_issuer() {
        let uri = otpauth_uri("JBSWY3DPEHPK3PXP", "ada lovelace");
        assert_eq!(
            uri,
            "otpauth://totp/g1t:ada%20lovelace?secret=JBSWY3DPEHPK3PXP&issuer=g1t&algorithm=SHA1&digits=6&period=30"
        );
    }

    #[test]
    fn codes_are_tidied_before_they_are_checked() {
        assert_eq!(tidy_code(" 123 456 "), "123456");
        assert!(is_totp_shaped(&tidy_code("123-456")));
        assert!(!is_totp_shaped("12345"));
        assert!(!is_totp_shaped("abcdef"));
        assert_eq!(tidy_code("ABCD-EFGH-IJ"), "abcdefghij");
    }

    #[test]
    fn the_default_policy_asks_nothing_and_any_account_meets_it() {
        let policy = WorkspacePolicy::default();
        assert!(policy.asks_nothing());
        assert!(policy.gaps(&SecurityFacts::default()).is_empty());
    }

    #[test]
    fn a_policy_names_everything_an_account_lacks() {
        let policy = WorkspacePolicy {
            allowed_email_domains: vec!["@Acme.com".into()],
            require_verified_email: true,
            require_two_factor: true,
        };
        assert!(!policy.asks_nothing());
        assert_eq!(
            policy.gaps(&SecurityFacts::default()),
            vec![PolicyGap::VerifiedEmail, PolicyGap::EmailDomain(vec!["acme.com".into()]), PolicyGap::TwoFactor]
        );
        let member = SecurityFacts { verified_emails: vec!["ada@gmail.com".into(), "ada@acme.com".into()], two_factor: true };
        assert!(policy.gaps(&member).is_empty());
        let lookalike = SecurityFacts { verified_emails: vec!["ada@notacme.com".into()], two_factor: true };
        assert_eq!(policy.gaps(&lookalike), vec![PolicyGap::EmailDomain(vec!["acme.com".into()])]);
        assert!(PolicyGap::EmailDomain(vec!["acme.com".into()]).message("acme").contains("acme.com"));
    }
}
