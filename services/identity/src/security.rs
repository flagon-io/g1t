//! Account security: proving it is you again, the security log, and what
//! workspaces ask of their members.
//!
//! **Proving it is you again ("sudo mode").** Changing an account's email
//! addresses, and anything as sensitive added later (a second factor,
//! recovery codes, deleting the account), calls [`Identity::proof`] first.
//! It accepts the session the person is using when they signed in to it
//! within `RECENT_AUTH_SECONDS` (`sessions.authenticated_at`, set when a
//! session starts), or their password, which also renews that time. A
//! caller that gets anything but [`Proof::Given`] answers
//! `FailureCode::ReauthRequired`, and the site asks for the password (or a
//! fresh GitHub sign-in, for an account without one). A second factor will
//! be one more way to give proof, here, and nothing that calls it changes.
//! Turning two-factor authentication on or off, and making new recovery
//! codes, call it too (two_factor.rs).
//!
//! **The security log** (`security_events`) records what happened to an
//! account's addresses and password, by the person or by staff, and is
//! shown to the person in their settings and to staff in sudo.
//!
//! **Workspace policy.** [`WorkspacePolicy`] says what a workspace asks of
//! its members: addresses at its own domain, a confirmed address, a second
//! factor. [`Identity::policy_refusal`] is checked wherever someone joins a
//! workspace (`add_member`, accepting an invite) or is given a role on one
//! of its repositories (access.rs: adding a collaborator, accepting an
//! invitation), and
//! [`Identity::within_policy`] and [`Identity::grants_within_policy`]
//! wherever someone's access to a workspace or its repositories is used
//! (every user resolved from a session or token). The one stored policy
//! is `workspaces.require_two_factor`, read with the memberships and grants
//! themselves, so a workspace that asks nothing costs nothing; only when
//! one asks is the account's own two-factor state read, once. A membership
//! or grant the account does not meet the policy for is left out, and the
//! workspace is named in [`User::held`] with why, for the site's notice.
//! The membership itself stays: turning two-factor on brings it back.

use g1t_contracts::accounts::{
    RECENT_AUTH_SECONDS, Reauth, ReauthenticateArgs, SECURITY_LOG_LIMIT, SecurityEvent, SecurityFacts,
    WorkspacePolicy, is_recent,
};
use g1t_contracts::access::RepoGrant;
use g1t_contracts::identity::UserArgs;
use g1t_contracts::members::PolicyHold;
use g1t_contracts::time::{SQL_NOW, rfc3339};
use g1t_contracts::{FailureCode, Membership, Outcome, PrincipalKind, User, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::{Identity, crypto};

/// What a person sees when a change needs them to prove it is them.
pub const REAUTH: &str = "Enter your password to make this change.";
pub const WRONG_PASSWORD: &str = "That password is not right.";
pub const PEOPLE_ONLY: &str = "Only you can change your email addresses, signed in as yourself; never with an agent's or a workspace's token.";

/// What [`Identity::proof`] found.
#[derive(Debug, PartialEq, Eq)]
pub enum Proof {
    /// A recent sign-in, or the right password.
    Given,
    /// Nothing recent enough: ask.
    Missing,
    /// A password was given and was wrong.
    WrongPassword,
    /// Too many wrong passwords: nothing was checked.
    Throttled,
}

impl Proof {
    /// The refusal to return for anything but [`Proof::Given`].
    pub fn refusal<T>(&self) -> Option<Outcome<T>> {
        match self {
            Proof::Given => None,
            Proof::Missing => Some(Outcome::fail(FailureCode::ReauthRequired, REAUTH)),
            Proof::WrongPassword => Some(Outcome::fail(FailureCode::ReauthRequired, WRONG_PASSWORD)),
            Proof::Throttled => Some(Outcome::fail(FailureCode::ReauthRequired, crate::throttle::THROTTLED)),
        }
    }
}

/// Whether `user` is a person acting for themselves: not a workspace's
/// token, not an agent, not anyone acting on someone's behalf.
pub fn is_person(user: &User) -> bool {
    user.kind == PrincipalKind::User && user.acting.is_none() && !user.id.is_empty()
}

#[derive(Deserialize)]
struct SecurityRow {
    kind: String,
    detail: Option<String>,
    staff: Option<String>,
    reason: Option<String>,
    created_at: String,
}

impl SecurityRow {
    fn event(self, for_staff: bool) -> SecurityEvent {
        SecurityEvent {
            kind: self.kind,
            detail: self.detail,
            by_staff: self.staff.is_some(),
            reason: self.reason,
            staff: if for_staff { self.staff } else { None },
            created_at: self.created_at,
        }
    }
}

impl Identity {
    /// Whether the person making a sensitive change has proved, just now,
    /// that they are `user_id`. See the module docs.
    pub async fn proof(&self, user_id: &str, reauth: &Reauth) -> Result<Proof> {
        let session = reauth.session_token.as_deref().map(crypto::sha256_hex);
        if let Some(password) = reauth.password.as_deref().filter(|password| !password.is_empty()) {
            let (account_key, client_key) = Identity::password_keys(user_id, reauth.client.as_deref());
            if self.password_locked(&account_key, client_key.as_deref()).await? {
                return Ok(Proof::Throttled);
            }
            #[derive(Deserialize)]
            struct Hash {
                username: String,
                password_hash: String,
            }
            let hash = self
                .db
                .prepare("SELECT username, password_hash FROM users WHERE id = ?")
                .bind(&[user_id.into()])?
                .first::<Hash>(None)
                .await?;
            let right = hash
                .as_ref()
                .is_some_and(|row| !row.password_hash.is_empty() && crypto::verify_password(password, &row.password_hash));
            if !right {
                let owner = hash.as_ref().map(|row| (user_id, row.username.as_str()));
                self.password_failed(&account_key, client_key.as_deref(), owner).await?;
                return Ok(Proof::WrongPassword);
            }
            self.clear(&account_key).await?;
            if let Some(session) = &session {
                self.renew_authentication(session, user_id).await?;
            }
            return Ok(Proof::Given);
        }
        let Some(session) = session else {
            return Ok(Proof::Missing);
        };
        #[derive(Deserialize)]
        struct Authenticated {
            authenticated_at: Option<String>,
        }
        let row = self
            .db
            .prepare(format!(
                "SELECT authenticated_at FROM sessions WHERE id = ? AND user_id = ? AND expires_at > {SQL_NOW}"
            ))
            .bind(&[session.as_str().into(), user_id.into()])?
            .first::<Authenticated>(None)
            .await?;
        let recent = row.is_some_and(|row| is_recent(row.authenticated_at.as_deref(), now_ms(), RECENT_AUTH_SECONDS));
        Ok(if recent { Proof::Given } else { Proof::Missing })
    }

    async fn renew_authentication(&self, session_hash: &str, user_id: &str) -> Result<()> {
        self.db
            .prepare(format!("UPDATE sessions SET authenticated_at = {SQL_NOW} WHERE id = ? AND user_id = ?"))
            .bind(&[session_hash.into(), user_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// `reauthenticate`: the person typed their password again.
    pub async fn reauthenticate(&self, a: ReauthenticateArgs) -> Result<Outcome<bool>> {
        #[derive(Deserialize)]
        struct Owner {
            user_id: String,
        }
        let owner = self
            .db
            .prepare(format!("SELECT user_id FROM sessions WHERE id = ? AND expires_at > {SQL_NOW}"))
            .bind(&[crypto::sha256_hex(&a.session_token).into()])?
            .first::<Owner>(None)
            .await?;
        let Some(owner) = owner else {
            return Ok(Outcome::fail(FailureCode::Unauthenticated, "Sign in again."));
        };
        let reauth = Reauth {
            session_token: Some(a.session_token),
            password: Some(a.password),
            client: a.client,
        };
        Ok(match self.proof(&owner.user_id, &reauth).await? {
            Proof::Given => Outcome::Ok(true),
            other => other.refusal().unwrap_or(Outcome::Ok(true)),
        })
    }

    /// Adds a line to an account's security log. Best effort: the change
    /// it records has happened.
    pub async fn log_security(&self, user_id: &str, kind: &str, detail: Option<&str>, staff: Option<(&str, &str)>) {
        let written = async {
            self.db
                .prepare(
                    "INSERT INTO security_events (id, user_id, kind, detail, staff, reason, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&[
                    new_id("sev", now_ms()).into(),
                    user_id.into(),
                    kind.into(),
                    detail.map_or(JsValue::NULL, Into::into),
                    staff.map_or(JsValue::NULL, |(who, _)| who.into()),
                    staff.map_or(JsValue::NULL, |(_, why)| why.into()),
                    rfc3339(now_ms()).into(),
                ])?
                .run()
                .await
        };
        if let Err(error) = written.await {
            worker::console_error!("security event {kind} not logged: {error}");
        }
    }

    /// The newest entries of an account's security log.
    pub async fn security_events(&self, user_id: &str, for_staff: bool) -> Result<Vec<SecurityEvent>> {
        let rows = self
            .db
            .prepare(format!(
                "SELECT kind, detail, staff, reason, created_at FROM security_events
                 WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT {SECURITY_LOG_LIMIT}"
            ))
            .bind(&[user_id.into()])?
            .all()
            .await?
            .results::<SecurityRow>()?;
        Ok(rows.into_iter().map(|row| row.event(for_staff)).collect())
    }

    /// `security_log`: a person's own security log.
    pub async fn security_log(&self, a: UserArgs) -> Result<Outcome<Vec<SecurityEvent>>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, PEOPLE_ONLY));
        }
        Ok(Outcome::Ok(self.security_events(&a.user.id, false).await?))
    }

    // --- Workspace policy ---

    /// What a workspace asks of its members: today, whether it requires
    /// two-factor authentication.
    pub async fn workspace_policy(&self, slug: &str) -> Result<WorkspacePolicy> {
        #[derive(Deserialize)]
        struct Row {
            require_two_factor: u8,
        }
        let row = self
            .db
            .prepare("SELECT require_two_factor FROM workspaces WHERE slug = ? AND deleted_at IS NULL")
            .bind(&[slug.to_lowercase().into()])?
            .first::<Row>(None)
            .await?;
        Ok(policy_of(row.is_some_and(|row| row.require_two_factor != 0)))
    }

    /// What an account can show a policy.
    async fn security_facts(&self, user_id: &str) -> Result<SecurityFacts> {
        Ok(SecurityFacts {
            verified_emails: self.verified_emails(user_id).await?,
            two_factor: self.two_factor_enabled(user_id).await?,
        })
    }

    /// Why `user_id` may not join or use the workspace `slug`, or `None`.
    pub async fn policy_refusal(&self, user_id: &str, slug: &str) -> Result<Option<String>> {
        let policy = self.workspace_policy(slug).await?;
        if policy.asks_nothing() {
            return Ok(None);
        }
        let facts = self.security_facts(user_id).await?;
        Ok(policy.gaps(&facts).first().map(|gap| gap.message(slug)))
    }

    /// The memberships and grants whose workspace's policy the account
    /// meets: access to a workspace, as a member or an outside
    /// collaborator, is used only through these. Each carries whether its
    /// workspace requires two-factor authentication.
    pub async fn within_policy(
        &self,
        user_id: &str,
        memberships: Vec<(Membership, bool)>,
        grants: Vec<(RepoGrant, bool)>,
    ) -> Result<WithinPolicy> {
        let asks = memberships.iter().any(|(_, required)| *required) || grants.iter().any(|(_, required)| *required);
        let facts = if asks { Some(self.security_facts(user_id).await?) } else { None };
        Ok(apply_policies(facts.as_ref(), memberships, grants))
    }
}

/// What access an account may use under its workspaces' policies.
#[derive(Debug, Default)]
pub struct WithinPolicy {
    pub memberships: Vec<Membership>,
    pub grants: Vec<RepoGrant>,
    /// The workspaces the account is held out of, with why.
    pub held: Vec<PolicyHold>,
}

/// The policy a workspace's stored settings make.
pub fn policy_of(require_two_factor: bool) -> WorkspacePolicy {
    WorkspacePolicy { require_two_factor, ..WorkspacePolicy::default() }
}

/// Keeps the memberships and grants whose policy `facts` meets. `facts`
/// is only needed, and only read, when some workspace asks something.
pub fn apply_policies(
    facts: Option<&SecurityFacts>,
    memberships: Vec<(Membership, bool)>,
    grants: Vec<(RepoGrant, bool)>,
) -> WithinPolicy {
    let mut within = WithinPolicy::default();
    let gap = |slug: &str, required: bool| -> Option<PolicyHold> {
        let facts = facts?;
        policy_of(required).gaps(facts).first().map(|gap| PolicyHold {
            slug: slug.to_owned(),
            reason: gap.message(slug),
            gap: gap.as_str().to_owned(),
        })
    };
    for (membership, required) in memberships {
        match gap(&membership.slug, required) {
            Some(hold) => within.held.push(hold),
            None => within.memberships.push(membership),
        }
    }
    for (grant, required) in grants {
        match gap(&grant.workspace, required) {
            Some(hold) => {
                if !within.held.iter().any(|held| held.slug == hold.slug) {
                    within.held.push(hold);
                }
            }
            None => within.grants.push(grant),
        }
    }
    within
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_person_acting_for_themselves_may_change_their_account() {
        let person = User { id: "usr_1".into(), username: "ada".into(), ..User::default() };
        assert!(is_person(&person));
        let workspace = User { kind: PrincipalKind::Workspace, ..person.clone() };
        assert!(!is_person(&workspace));
        let agent = User { kind: PrincipalKind::Agent, ..person.clone() };
        assert!(!is_person(&agent));
        assert!(!is_person(&User::default()));
    }

    fn membership(slug: &str) -> Membership {
        Membership::member(slug)
    }

    fn grant(repo: &str, workspace: &str) -> RepoGrant {
        RepoGrant { repo_id: repo.into(), workspace: workspace.into(), role: g1t_contracts::access::RepoRole::Write, team: None }
    }

    #[test]
    fn a_workspace_requiring_two_factor_holds_out_whoever_lacks_it() {
        let without = SecurityFacts { verified_emails: vec!["ada@x.io".into()], two_factor: false };
        let within = apply_policies(
            Some(&without),
            vec![(membership("acme"), true), (membership("globex"), false)],
            vec![(grant("rep_1", "initech"), true), (grant("rep_2", "globex"), false)],
        );
        assert_eq!(within.memberships.iter().map(|m| m.slug.as_str()).collect::<Vec<_>>(), vec!["globex"]);
        assert_eq!(within.grants.iter().map(|g| g.repo_id.as_str()).collect::<Vec<_>>(), vec!["rep_2"]);
        assert_eq!(within.held.iter().map(|h| h.slug.as_str()).collect::<Vec<_>>(), vec!["acme", "initech"]);
        assert!(within.held.iter().all(|hold| hold.gap == "two_factor" && hold.reason.contains("two-factor")));
        // Turned on: everything is back.
        let with = SecurityFacts { two_factor: true, ..without };
        let within = apply_policies(
            Some(&with),
            vec![(membership("acme"), true)],
            vec![(grant("rep_1", "initech"), true)],
        );
        assert_eq!(within.memberships.len(), 1);
        assert_eq!(within.grants.len(), 1);
        assert!(within.held.is_empty());
    }

    #[test]
    fn nothing_is_held_where_no_workspace_asks() {
        let within = apply_policies(None, vec![(membership("acme"), false)], vec![(grant("rep_1", "acme"), false)]);
        assert_eq!(within.memberships.len(), 1);
        assert_eq!(within.grants.len(), 1);
        assert!(within.held.is_empty());
    }

    #[test]
    fn anything_but_proof_is_refused_as_reauth_required() {
        assert!(Proof::Given.refusal::<bool>().is_none());
        for proof in [Proof::Missing, Proof::WrongPassword, Proof::Throttled] {
            match proof.refusal::<bool>() {
                Some(Outcome::Fail(failure)) => assert_eq!(failure.code, FailureCode::ReauthRequired),
                _ => panic!("expected a refusal"),
            }
        }
    }
}
