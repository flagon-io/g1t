//! Workspace invitations: nobody joins a workspace without saying yes.
//!
//! An invite that names a workspace (`invites.workspace_id`) is an
//! invitation for one account (`invitee_id`), which accepts or declines it:
//!
//! - **Someone with an account**, invited from a workspace's People page by
//!   username or by address, gets the invitation at once: an item in their
//!   inbox and an email, both leading to `/invitations`. Accepting joins
//!   with the role chosen when they were invited; declining tells whoever
//!   invited them, in their inbox.
//! - **Someone without one** gets an invite to make an account, which can
//!   name a workspace the inviter owns (Settings → Invites, "Bring them
//!   into"). Once the new account confirms its address, the invitation
//!   waits for its answer the same way, for the invite TTL from then.
//!
//! An invitation works for the invite TTL (`INVITE_TTL_DAYS`, 30 days),
//! and the workspace's owners can revoke it from People → Pending
//! invitations until it is answered. A workspace on the free plan adds no
//! one (paid.rs): its invitations cannot be accepted until it starts the
//! plan, so they cannot be made either.
//!
//! Every new account that its invite does not bring into a workspace gets
//! a workspace of its own, named for its username, on the free plan
//! (workspaces.rs, `create_own_workspace`), so nobody is left without one.

use g1t_contracts::audit::Surface;
use g1t_contracts::identity::*;
use g1t_contracts::time::{SQL_NOW, rfc3339};
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, User};
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use super::{CREATES_PER_HOUR, Draft, InviteRow, TOO_MANY};
use crate::Identity;

/// What an invitation that is not someone's, or no longer open, gets.
const NOT_OPEN: &str = "That invitation is not open: it may have been answered, revoked or expired. Ask the workspace's owners to invite you again.";
/// The most people `find_people` returns.
const MAX_PEOPLE: u32 = 10;
/// The most invitations one person's list shows.
const MAX_INVITATIONS: u32 = 50;

/// Whether an invitation can still be answered at `now`: it names a
/// workspace that exists, is neither answered nor revoked, has not
/// expired, and is ready for its person: an existing account's at once
/// (unused), a new account's once that account confirmed its address.
pub fn answerable(row: &InviteRow, now: &str) -> std::result::Result<(), &'static str> {
    let ready = match row.kind.as_str() {
        "workspace" => row.redeemed_at.is_none(),
        _ => row.redeemed_at.is_some() && row.applied_at.is_some(),
    };
    if row.workspace_id.is_none()
        || row.workspace.is_none()
        || row.accepted_at.is_some()
        || row.declined_at.is_some()
        || row.revoked_at.is_some()
        || row.expires_at.as_str() <= now
        || !ready
    {
        return Err(NOT_OPEN);
    }
    Ok(())
}

/// Whether a new account gets a workspace of its own: unless its invite
/// brings it into one (`invited_to`, a workspace that still exists) that
/// can take it, which a workspace on the free plan (`free`) cannot.
pub fn makes_own_workspace(invited_to: Option<&str>, free: bool) -> bool {
    invited_to.is_none() || free
}

/// The LIKE patterns `find_people` matches: a username starting with the
/// query, a name containing it. None for an empty query. `%`, `_` and `\`
/// match only themselves.
pub fn people_patterns(query: &str) -> Option<(String, String)> {
    let query = query.trim().trim_start_matches('@').to_lowercase();
    if query.is_empty() {
        return None;
    }
    let escaped: String = query
        .chars()
        .flat_map(|c| match c {
            '%' | '_' | '\\' => vec!['\\', c],
            c => vec![c],
        })
        .collect();
    Some((format!("{escaped}%"), format!("%{escaped}%")))
}

/// How an invitation's role reads in a sentence.
fn as_role(role: Role) -> &'static str {
    match role {
        Role::Owner => "an owner",
        Role::Member => "a member",
    }
}

/// `workspace_invitation.created`, `.accepted`, `.declined` and `.revoked`:
/// told in the inbox of the people named in `notify`, with a link (events'
/// inbox.rs). The inbox closes the invitee's item once it is answered or
/// revoked.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InvitationNotice<'a> {
    workspace: &'a str,
    invitation_id: &'a str,
    thread: String,
    notify: Vec<String>,
    title: String,
    body: String,
    link: String,
}

#[derive(Deserialize)]
struct Person {
    id: String,
    username: String,
    email: Option<String>,
    verified: u8,
}

#[derive(Deserialize)]
struct Pending {
    id: String,
    slug: String,
    name: String,
    avatar: Option<String>,
    role: Option<String>,
    created_at: String,
    expires_at: String,
    inviter: Option<String>,
    inviter_name: Option<String>,
    inviter_avatar: Option<String>,
}

impl Identity {
    /// The workspace an own invite brings its person into, from `join` (a
    /// slug): one `user` owns that can add members. None for none.
    pub(crate) async fn joinable_workspace(&self, user: &User, join: Option<&str>) -> Result<Outcome<Option<(String, String)>>> {
        let Some(slug) = join.map(str::trim).filter(|slug| !slug.is_empty()).map(str::to_lowercase) else {
            return Ok(Outcome::Ok(None));
        };
        if user.role_in(&slug) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a workspace's owners can bring people into it."));
        }
        let Some(id) = self.workspace_id(&slug).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Workspace not found."));
        };
        // A free workspace adds no one until it starts the plan (paid.rs).
        if let Some(refused) = self.free_workspace_refusal(&slug).await? {
            return Ok(refused);
        }
        Ok(Outcome::Ok(Some((id, slug))))
    }

    /// Gives a new account a workspace of its own unless `invite` brings
    /// it into one. Never fails the sign-up: an account left without one
    /// is asked to make one by the site.
    pub(crate) async fn give_own_workspace(&self, user: &User, invite: Option<&InviteRow>) {
        let invited_to = invite.and_then(|row| row.workspace.as_deref());
        let free = match invited_to {
            Some(slug) => self.is_free_workspace(slug).await,
            None => false,
        };
        if !makes_own_workspace(invited_to, free) {
            return;
        }
        match self.create_own_workspace(user).await {
            Ok(Some(_)) => {}
            Ok(None) => worker::console_log!("no workspace of its own for {}: its name is taken", user.id),
            Err(error) => worker::console_error!("no workspace of its own for {}: {error}", user.id),
        }
    }

    /// `invite_member` with a username: that account gets an invitation
    /// to `slug` (already checked: the actor owns it, it can add people).
    pub(crate) async fn invite_account(
        &self,
        actor: &User,
        slug: &str,
        workspace_id: &str,
        username: &str,
        role: Role,
        surface: Surface,
    ) -> Result<Outcome<Invite>> {
        let person = self
            .db
            .prepare(
                "SELECT id, username, email, email_verified_at IS NOT NULL AS verified
                 FROM users WHERE username = ? AND deleted_at IS NULL",
            )
            .bind(&[username.into()])?
            .first::<Person>(None)
            .await?;
        let Some(person) = person.filter(|person| !crate::paid::is_g1t(&person.username)) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no account with that username."));
        };
        if person.id == actor.id {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("You are already in {slug}.")));
        }
        let member = self
            .db
            .prepare("SELECT 1 AS n FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
            .bind(&[workspace_id.into(), person.id.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if member.is_some() {
            return Ok(Outcome::fail(FailureCode::Conflict, format!("@{} is already in {slug}.", person.username)));
        }
        if !self.hit(&format!("invite.create:{}", actor.id), CREATES_PER_HOUR).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, TOO_MANY));
        }
        let pending = self
            .rows(
                &format!(
                    "WHERE i.workspace_id = ? AND i.invitee_id = ? AND i.accepted_at IS NULL AND i.declined_at IS NULL
                       AND i.revoked_at IS NULL AND i.expires_at > {SQL_NOW}"
                ),
                &[workspace_id.into(), person.id.as_str().into()],
                1,
            )
            .await?;
        if !pending.is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("@{} already has a pending invitation to {slug}. Revoke it to send a new one.", person.username),
            ));
        }
        let draft = Draft {
            email: None,
            kind: "workspace",
            workspace_id: Some(workspace_id),
            inviter: Some(actor),
            staff: None,
            // Costs nothing: the person is on g1t already.
            charged_to: "none",
            charged_workspace_id: None,
            limit: None,
            invitee_id: Some(&person.id),
            role: Some(if role == Role::Owner { "owner" } else { "member" }),
        };
        let Some(invite) = self.insert_invite(draft).await? else {
            return Ok(Outcome::fail(FailureCode::Conflict, "The invitation could not be made. Try again."));
        };
        if let (Some(email), true, Some(code)) = (&person.email, person.verified != 0, &invite.code) {
            let from = self.display_name(actor).await;
            let workspace = self.workspace_name(workspace_id, slug).await;
            self.send_invite_email(email, Some(&from), Some(&workspace), true, code, None).await;
        }
        if let Some(row) = self.invite_by_id(&invite.id).await? {
            self.invitation_sent(&row, &person.username).await;
        }
        self.audit_invites(
            actor,
            "invite.created",
            vec![slug.to_owned()],
            surface,
            format!("Invited @{} to {slug} as {}", person.username, as_role(role)),
        )
        .await;
        Ok(Outcome::Ok(invite))
    }

    /// Tells `username` in their inbox that they are invited to the
    /// invite's workspace.
    pub(crate) async fn invitation_sent(&self, row: &InviteRow, username: &str) {
        let (Some(workspace_id), Some(slug)) = (&row.workspace_id, &row.workspace) else {
            return;
        };
        let workspace = self.workspace_name(workspace_id, slug).await;
        let from = match &row.inviter {
            Some(inviter) => format!("@{inviter}"),
            None => "The g1t team".to_owned(),
        };
        self.invitation_notice(
            "workspace_invitation.created",
            row.inviter_id.as_deref(),
            row,
            vec![username.to_owned()],
            format!("{from} invited you to join {workspace}"),
            format!("Join as {}, or decline. The invitation works until {}.", as_role(row.joins_as()), &row.expires_at[..10.min(row.expires_at.len())]),
            "/invitations".to_owned(),
        )
        .await;
    }

    #[allow(clippy::too_many_arguments)]
    async fn invitation_notice(
        &self,
        kind: &'static str,
        actor: Option<&str>,
        row: &InviteRow,
        notify: Vec<String>,
        title: String,
        body: String,
        link: String,
    ) {
        let slug = row.workspace.as_deref().unwrap_or_default();
        self.announce(
            kind,
            actor,
            InvitationNotice {
                workspace: slug,
                invitation_id: &row.id,
                thread: format!("invitation:{}", row.id),
                notify,
                title,
                body,
                link,
            },
        )
        .await;
    }

    /// `list_invitations`: the workspace invitations waiting for `user`'s
    /// answer, newest first.
    pub async fn list_invitations(&self, a: UserArgs) -> Result<Vec<WorkspaceInvitation>> {
        if a.user.kind != PrincipalKind::User || a.user.acting.is_some() {
            return Ok(Vec::new());
        }
        let rows = self
            .db
            .prepare(format!(
                "SELECT i.id, w.slug, w.name, w.avatar, i.role, i.created_at, i.expires_at,
                   iu.username AS inviter, iu.display_name AS inviter_name, iu.avatar AS inviter_avatar
                 FROM invites i
                 JOIN workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
                 LEFT JOIN users iu ON iu.id = i.inviter_id
                 WHERE i.invitee_id = ?1 AND i.accepted_at IS NULL AND i.declined_at IS NULL
                   AND i.revoked_at IS NULL AND i.expires_at > {SQL_NOW}
                   AND ((i.kind = 'workspace' AND i.redeemed_at IS NULL)
                     OR (i.kind = 'account' AND i.redeemed_at IS NOT NULL AND i.applied_at IS NOT NULL))
                   AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = i.workspace_id AND m.user_id = ?1)
                 ORDER BY i.created_at DESC, i.id DESC LIMIT {MAX_INVITATIONS}"
            ))
            .bind(&[a.user.id.as_str().into()])?
            .all()
            .await?
            .results::<Pending>()?;
        Ok(rows
            .into_iter()
            .map(|row| WorkspaceInvitation {
                id: row.id,
                workspace: ProfileWorkspace { slug: row.slug, name: row.name, avatar: row.avatar },
                role: if row.role.as_deref() == Some("owner") { Role::Owner } else { Role::Member },
                invited_by: row.inviter.map(|username| InviteFrom {
                    username,
                    name: row.inviter_name,
                    avatar: row.inviter_avatar,
                }),
                created_at: row.created_at,
                expires_at: row.expires_at,
            })
            .collect())
    }

    /// The invitation `id` if it is `user`'s and can be answered.
    async fn open_invitation(&self, user: &User, id: &str) -> Result<std::result::Result<InviteRow, &'static str>> {
        let row = self
            .invite_by_id(id)
            .await?
            .filter(|row| row.invitee_id.as_deref() == Some(user.id.as_str()));
        let Some(row) = row else {
            return Ok(Err(NOT_OPEN));
        };
        Ok(answerable(&row, &rfc3339(now_ms())).map(|()| row))
    }

    /// `accept_invitation`: joins the invitation's workspace with its role.
    pub async fn accept_invitation(&self, a: InvitationArgs) -> Result<Outcome<String>> {
        if a.user.kind != PrincipalKind::User || a.user.acting.is_some() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a person can accept an invitation."));
        }
        if !a.user.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Confirm your email address first, then accept the invitation."));
        }
        let row = match self.open_invitation(&a.user, &a.id).await? {
            Ok(row) => row,
            Err(why) => return Ok(Outcome::fail(FailureCode::NotFound, why)),
        };
        let (Some(workspace_id), Some(slug)) = (row.workspace_id.clone(), row.workspace.clone()) else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_OPEN));
        };
        // What the workspace asks of its members (security.rs).
        if let Some(why) = self.policy_refusal(&a.user.id, &slug).await? {
            return Ok(Outcome::fail(FailureCode::Forbidden, why));
        }
        // A free workspace adds no one until it starts the plan (paid.rs);
        // the invitation stays open until then.
        if let Some(refused) = self.free_workspace_refusal(&slug).await? {
            return Ok(refused);
        }
        let role = row.joins_as();
        let now = rfc3339(now_ms());
        let user = JsValue::from(a.user.id.as_str());
        let id = JsValue::from(row.id.as_str());
        let at = JsValue::from(now.as_str());
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "UPDATE invites SET accepted_at = ?3, redeemed_by = COALESCE(redeemed_by, ?2),
                           redeemed_at = COALESCE(redeemed_at, ?3), applied_at = COALESCE(applied_at, ?3), sealed_code = NULL
                         WHERE id = ?1 AND invitee_id = ?2 AND accepted_at IS NULL AND declined_at IS NULL
                           AND revoked_at IS NULL AND expires_at > ?3",
                    )
                    .bind(&[id.clone(), user.clone(), at.clone()])?,
                self.db
                    .prepare(
                        "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
                         SELECT ?4, ?2, ?5, ?3
                         WHERE EXISTS (SELECT 1 FROM invites WHERE id = ?1 AND invitee_id = ?2 AND accepted_at = ?3)
                           AND EXISTS (SELECT 1 FROM workspaces WHERE id = ?4 AND deleted_at IS NULL)",
                    )
                    .bind(&[
                        id.clone(),
                        user,
                        at,
                        workspace_id.as_str().into(),
                        if role == Role::Owner { "owner" } else { "member" }.into(),
                    ])?,
            ])
            .await?;
        #[derive(Deserialize)]
        struct Accepted {
            accepted_at: Option<String>,
        }
        let accepted = self
            .db
            .prepare("SELECT accepted_at FROM invites WHERE id = ?")
            .bind(&[id])?
            .first::<Accepted>(None)
            .await?
            .and_then(|row| row.accepted_at);
        if accepted.as_deref() != Some(now.as_str()) {
            return Ok(Outcome::fail(FailureCode::Conflict, NOT_OPEN));
        }
        if row.kind == "workspace" {
            // An existing account's invitation: using it is this.
            self.settled(&row, &a.user, false, Some(slug.clone())).await;
        } else {
            let surface = a.surface.unwrap_or(Surface::Web);
            self.audit_invites(&a.user, "invite.accepted", vec![slug.clone()], surface, "Accepted the invitation".to_owned()).await;
            self.audit_invites(
                &a.user,
                "member.added",
                vec![slug.clone()],
                surface,
                format!("{} joined as {}", a.user.username, as_role(role)),
            )
            .await;
        }
        let workspace = self.workspace_name(&workspace_id, &slug).await;
        self.invitation_notice(
            "workspace_invitation.accepted",
            Some(&a.user.id),
            &row,
            row.inviter.iter().cloned().collect(),
            format!("@{} accepted your invitation to {workspace}", a.user.username),
            format!("They joined as {}.", as_role(role)),
            format!("/{slug}/-/people"),
        )
        .await;
        Ok(Outcome::Ok(slug))
    }

    /// `decline_invitation`: says no, and tells whoever sent it.
    pub async fn decline_invitation(&self, a: InvitationArgs) -> Result<Outcome<bool>> {
        if a.user.kind != PrincipalKind::User || a.user.acting.is_some() {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a person can decline an invitation."));
        }
        let row = match self.open_invitation(&a.user, &a.id).await? {
            Ok(row) => row,
            Err(why) => return Ok(Outcome::fail(FailureCode::NotFound, why)),
        };
        let declined = self
            .db
            .prepare(format!(
                "UPDATE invites SET declined_at = {SQL_NOW}, sealed_code = NULL
                 WHERE id = ?1 AND invitee_id = ?2 AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL
                 RETURNING id"
            ))
            .bind(&[row.id.as_str().into(), a.user.id.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?;
        if declined.is_none() {
            return Ok(Outcome::fail(FailureCode::Conflict, NOT_OPEN));
        }
        let (Some(workspace_id), Some(slug)) = (&row.workspace_id, &row.workspace) else {
            return Ok(Outcome::Ok(true));
        };
        self.audit_invites(
            &a.user,
            "invite.declined",
            vec![slug.clone()],
            a.surface.unwrap_or(Surface::Web),
            format!("{} declined the invitation", a.user.username),
        )
        .await;
        let workspace = self.workspace_name(workspace_id, slug).await;
        self.invitation_notice(
            "workspace_invitation.declined",
            Some(&a.user.id),
            &row,
            row.inviter.iter().cloned().collect(),
            format!("@{} declined your invitation to {workspace}", a.user.username),
            "Nothing changed in the workspace.".to_owned(),
            format!("/{slug}/-/people"),
        )
        .await;
        Ok(Outcome::Ok(true))
    }

    /// Closes the invitee's inbox item for an invitation revoked from People.
    pub(crate) async fn invitation_revoked(&self, actor: &User, row: &InviteRow) {
        if row.workspace_id.is_none() || row.invitee_id.is_none() {
            return;
        }
        self.invitation_notice(
            "workspace_invitation.revoked",
            Some(&actor.id),
            row,
            Vec::new(),
            String::new(),
            String::new(),
            String::new(),
        )
        .await;
    }

    /// `find_people`: accounts to invite, by username or name.
    pub async fn find_people(&self, a: FindPeopleArgs) -> Result<Vec<InviteFrom>> {
        let Some((username, name)) = people_patterns(&a.query) else {
            return Ok(Vec::new());
        };
        let exact = a.query.trim().trim_start_matches('@').to_lowercase();
        let limit = a.limit.unwrap_or(8).clamp(1, MAX_PEOPLE);
        #[derive(Deserialize)]
        struct Row {
            username: String,
            name: Option<String>,
            avatar: Option<String>,
        }
        let rows = self
            .db
            .prepare(format!(
                "SELECT username, display_name AS name, avatar FROM users
                 WHERE deleted_at IS NULL AND email_verified_at IS NOT NULL AND username <> ?4
                   AND (username LIKE ?1 ESCAPE '\\' OR lower(display_name) LIKE ?2 ESCAPE '\\')
                 ORDER BY username = ?3 DESC, username LIKE ?1 ESCAPE '\\' DESC, length(username), username
                 LIMIT {limit}"
            ))
            .bind(&[
                username.into(),
                name.into(),
                exact.into(),
                g1t_contracts::identity::AGENT_NAME.into(),
            ])?
            .all()
            .await?
            .results::<Row>()?;
        Ok(rows
            .into_iter()
            .map(|row| InviteFrom { username: row.username, name: row.name, avatar: row.avatar })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-10-08T12:00:00.000Z";
    const EARLIER: &str = "2026-10-01T12:00:00.000Z";
    const LATER: &str = "2026-11-07T12:00:00.000Z";

    fn invitation(kind: &str) -> InviteRow {
        InviteRow {
            id: "inv_1".into(),
            hint: "g1t-k7m2".into(),
            sealed_code: None,
            email: None,
            kind: kind.into(),
            workspace_id: Some("wsp_1".into()),
            workspace: Some("acme".into()),
            inviter_id: Some("usr_owner".into()),
            inviter: Some("syntaqx".into()),
            staff: None,
            charged_to: "none".into(),
            created_at: EARLIER.into(),
            expires_at: LATER.into(),
            revoked_at: None,
            redeemer: None,
            redeemed_at: None,
            applied_at: None,
            invitee_id: Some("usr_ada".into()),
            invitee: Some("ada".into()),
            role: None,
            accepted_at: None,
            declined_at: None,
        }
    }

    #[test]
    fn an_existing_accounts_invitation_is_open_until_answered_revoked_or_expired() {
        let open = invitation("workspace");
        assert_eq!(answerable(&open, NOW), Ok(()));
        for closed in [
            InviteRow { accepted_at: Some(NOW.into()), ..invitation("workspace") },
            InviteRow { declined_at: Some(NOW.into()), ..invitation("workspace") },
            InviteRow { revoked_at: Some(NOW.into()), ..invitation("workspace") },
            InviteRow { expires_at: EARLIER.into(), ..invitation("workspace") },
            // Its workspace was deleted.
            InviteRow { workspace: None, ..invitation("workspace") },
            // Used through its link already.
            InviteRow { redeemed_at: Some(EARLIER.into()), ..invitation("workspace") },
        ] {
            assert_eq!(answerable(&closed, NOW), Err(NOT_OPEN));
        }
    }

    #[test]
    fn a_new_accounts_invitation_opens_once_the_account_is_confirmed() {
        // The invite made the account, which has not confirmed its address.
        let waiting = InviteRow { redeemed_at: Some(EARLIER.into()), ..invitation("account") };
        assert_eq!(answerable(&waiting, NOW), Err(NOT_OPEN));
        // Confirmed: the invitation waits for its answer, and nothing was joined.
        let confirmed = InviteRow { applied_at: Some(NOW.into()), ..waiting };
        assert_eq!(answerable(&confirmed, NOW), Ok(()));
        assert_eq!(confirmed.status(NOW), InviteStatus::AwaitingAnswer);
        // Accepting joins with the role it names; member when none.
        assert_eq!(confirmed.joins_as(), Role::Member);
        assert_eq!(InviteRow { role: Some("owner".into()), ..invitation("workspace") }.joins_as(), Role::Owner);
        // An unused code is not an invitation yet.
        assert_eq!(answerable(&invitation("account"), NOW), Err(NOT_OPEN));
    }

    #[test]
    fn an_answered_invitation_says_how_it_was_answered() {
        let accepted = InviteRow {
            redeemed_at: Some(NOW.into()),
            applied_at: Some(NOW.into()),
            accepted_at: Some(NOW.into()),
            ..invitation("account")
        };
        assert_eq!(accepted.status(NOW), InviteStatus::Redeemed);
        let declined = InviteRow { declined_at: Some(NOW.into()), ..invitation("workspace") };
        assert_eq!(declined.status(NOW), InviteStatus::Declined);
        // Not answered in time: expired, though the account it made stays.
        let late = InviteRow {
            redeemed_at: Some(EARLIER.into()),
            applied_at: Some(EARLIER.into()),
            expires_at: EARLIER.into(),
            ..invitation("account")
        };
        assert_eq!(late.status(NOW), InviteStatus::Expired);
        // An existing account's open invitation is pending.
        assert_eq!(invitation("workspace").status(NOW), InviteStatus::Pending);
    }

    #[test]
    fn a_new_account_gets_its_own_workspace_unless_its_invite_brings_it_into_one() {
        // No invite, a shared link, or an invite that names no workspace.
        assert!(makes_own_workspace(None, false));
        // Brought into a workspace: none of its own, so never two.
        assert!(!makes_own_workspace(Some("acme"), false));
        // Into one on the free plan, which cannot take it: its own as well.
        assert!(makes_own_workspace(Some("acme"), true));
    }

    #[test]
    fn people_are_found_by_username_prefix_or_name_with_wildcards_taken_literally() {
        assert_eq!(people_patterns("  @Ada "), Some(("ada%".to_owned(), "%ada%".to_owned())));
        assert_eq!(people_patterns("a_b%"), Some(("a\\_b\\%%".to_owned(), "%a\\_b\\%%".to_owned())));
        assert_eq!(people_patterns(" @ "), None);
        assert_eq!(people_patterns(""), None);
    }
}
