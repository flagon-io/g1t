//! SCIM for a workspace with single sign-on, kept: its token, the users its
//! identity provider has assigned to it, and what happens when one is
//! unassigned. The protocol's own parts are in scim.rs; who may sign in is
//! decided in `complete` (../sso.rs), which asks `provisioned_as`.

use std::collections::HashMap;

use super::*;

#[derive(Deserialize)]
struct ScimRow {
    id: String,
    resource: String,
    user_id: Option<String>,
    created_at: String,
    updated_at: String,
}

impl ScimRow {
    fn user(&self) -> scim::ScimUser {
        serde_json::from_str(&self.resource).unwrap_or_default()
    }
}

/// Who SCIM acts as in the audit log: the workspace's identity provider.
fn scim_actor() -> User {
    User { id: "scim".into(), username: "scim".into(), kind: PrincipalKind::System, ..User::default() }
}

fn answer(status: u16, body: Option<Value>) -> ScimAnswer {
    ScimAnswer { status, body }
}

fn scim_error(error: scim::ScimError) -> ScimAnswer {
    answer(error.status, Some(error.body()))
}

/// Where a SCIM request is acting.
struct Scim<'a> {
    workspace_id: &'a str,
    slug: &'a str,
    connection_id: &'a str,
    base: &'a str,
    /// Why the workspace may not let anyone in now, when its plan has
    /// ended: assigning or reactivating anyone is refused; reading and
    /// taking people out never are, so leavers still leave.
    plan: Option<&'a str>,
}

impl Scim<'_> {
    fn plan_refusal(&self) -> Option<ScimAnswer> {
        self.plan.map(|why| scim_error(scim::ScimError::new(403, None, why)))
    }
}

const SELECT_ROW: &str = "SELECT id, resource, user_id, created_at, updated_at FROM scim_users";

/// Which provisioned user someone signing in is.
pub(crate) enum Match {
    None,
    /// The one: its id, and the g1t account already linked to it.
    One(String, Option<String>),
    /// More than one: nobody is chosen.
    Many,
}

impl Identity {
    pub(super) async fn scim_on(&self, workspace_id: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT 1 AS yes FROM scim_tokens WHERE workspace_id = ?")
            .bind(&[workspace_id.into()])?
            .first::<Value>(None)
            .await?
            .is_some())
    }

    pub(super) async fn scim_status(&self, workspace_id: &str) -> Result<Option<ScimStatus>> {
        #[derive(Deserialize)]
        struct TokenRow {
            hint: String,
            created_at: String,
            created_by: Option<String>,
            last_used_at: Option<String>,
        }
        let token = self
            .db
            .prepare(
                "SELECT t.hint, t.created_at, u.username AS created_by, t.last_used_at FROM scim_tokens t
                 LEFT JOIN users u ON u.id = t.created_by WHERE t.workspace_id = ?",
            )
            .bind(&[workspace_id.into()])?
            .first::<TokenRow>(None)
            .await?;
        let Some(token) = token else {
            return Ok(None);
        };
        #[derive(Deserialize)]
        struct UserRow {
            id: String,
            user_name: String,
            resource: String,
            active: u8,
            username: Option<String>,
            updated_at: String,
        }
        let users = self
            .db
            .prepare(
                "SELECT s.id, s.user_name, s.resource, s.active, u.username, s.updated_at FROM scim_users s
                 LEFT JOIN users u ON u.id = s.user_id WHERE s.workspace_id = ? ORDER BY s.user_name_key LIMIT 500",
            )
            .bind(&[workspace_id.into()])?
            .all()
            .await?
            .results::<UserRow>()?
            .into_iter()
            .map(|row| ProvisionedUser {
                display_name: serde_json::from_str::<scim::ScimUser>(&row.resource).ok().and_then(|user| user.display_name),
                id: row.id,
                user_name: row.user_name,
                active: row.active != 0,
                username: row.username,
                updated_at: row.updated_at,
            })
            .collect();
        Ok(Some(ScimStatus {
            hint: token.hint,
            created_at: token.created_at,
            created_by: token.created_by,
            last_used_at: token.last_used_at,
            users,
        }))
    }

    /// The active provisioned user someone signing in is (scim::is_them):
    /// exactly one, or nobody.
    pub(super) async fn provisioned_as(&self, workspace_id: &str, ids: &[String], trusted_email: Option<&str>) -> Result<Match> {
        let rows = self
            .db
            .prepare(format!("{SELECT_ROW} WHERE workspace_id = ? AND active = 1"))
            .bind(&[workspace_id.into()])?
            .all()
            .await?
            .results::<ScimRow>()?;
        let mut found = rows.into_iter().filter(|row| scim::is_them(&row.user(), ids, trusted_email));
        Ok(match (found.next(), found.next()) {
            (None, _) => Match::None,
            (Some(row), None) => Match::One(row.id, row.user_id),
            (Some(_), Some(_)) => Match::Many,
        })
    }

    /// `enable_scim`: a new token, replacing any other. Owners, on a paid
    /// plan, with single sign-on set up.
    pub async fn enable_scim(&self, a: SsoSettingsArgs) -> Result<Outcome<ScimToken>> {
        let slug = a.slug.trim().to_lowercase();
        let workspace_id = match self.sso_owner(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if self.connection_where("workspace_id", &workspace_id).await?.is_none() {
            return Ok(Outcome::fail(FailureCode::Conflict, "Set up single sign-on before SCIM."));
        }
        if let Some(refused) = self.plan_refusal(&slug, plan_needed(&slug)).await? {
            return Ok(refused);
        }
        let token = format!("g1t_scim_{}", crypto::random_hex(32));
        let hint = token[token.len() - 4..].to_owned();
        let rotated = self.scim_on(&workspace_id).await?;
        self.db
            .prepare(
                "INSERT INTO scim_tokens (workspace_id, token_hash, hint, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (workspace_id) DO UPDATE SET token_hash = excluded.token_hash, hint = excluded.hint,
                   created_by = excluded.created_by, created_at = excluded.created_at, last_used_at = NULL",
            )
            .bind(&[
                workspace_id.as_str().into(),
                crypto::sha256_hex(&token).into(),
                hint.as_str().into(),
                a.actor.id.as_str().into(),
                rfc3339(now_ms()).into(),
            ])?
            .run()
            .await?;
        self.audit_workspace(
            &a.actor,
            if rotated { "sso.scim_token_rotated" } else { "sso.scim_enabled" },
            &slug,
            a.surface.unwrap_or(Surface::Web),
            if rotated { "Made a new SCIM token; the old one stopped working".to_owned() } else { "Turned on SCIM".to_owned() },
        )
        .await;
        Ok(Outcome::Ok(ScimToken { token, hint }))
    }

    /// `disable_scim`: the token stops working and the provisioned users are
    /// forgotten. Nobody is removed from the workspace.
    pub async fn disable_scim(&self, a: SsoSettingsArgs) -> Result<Outcome<bool>> {
        let slug = a.slug.trim().to_lowercase();
        let workspace_id = match self.sso_owner(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !self.scim_on(&workspace_id).await? {
            return Ok(Outcome::Ok(false));
        }
        self.db
            .batch(vec![
                self.db.prepare("DELETE FROM scim_tokens WHERE workspace_id = ?").bind(&[workspace_id.as_str().into()])?,
                self.db.prepare("DELETE FROM scim_users WHERE workspace_id = ?").bind(&[workspace_id.as_str().into()])?,
            ])
            .await?;
        self.audit_workspace(&a.actor, "sso.scim_disabled", &slug, a.surface.unwrap_or(Surface::Web), "Turned off SCIM".to_owned()).await;
        Ok(Outcome::Ok(true))
    }

    /// `scim_request`: one request from the workspace's provider.
    pub async fn scim_request(&self, a: ScimRequestArgs) -> Result<ScimAnswer> {
        let slug = a.workspace.trim().to_lowercase();
        let unauthorized = || scim_error(scim::ScimError::new(401, None, "Send the workspace's SCIM token as a bearer token."));
        let token = a.token.trim();
        if token.is_empty() {
            return Ok(unauthorized());
        }
        let Some(workspace_id) = self.workspace_id_of(&slug).await? else {
            return Ok(unauthorized());
        };
        #[derive(Deserialize)]
        struct Owner {
            workspace_id: String,
        }
        let owner = self
            .db
            .prepare("SELECT workspace_id FROM scim_tokens WHERE token_hash = ?")
            .bind(&[crypto::sha256_hex(token).into()])?
            .first::<Owner>(None)
            .await?;
        if owner.is_none_or(|owner| owner.workspace_id != workspace_id) {
            return Ok(unauthorized());
        }
        let Some(connection) = self.connection_where("workspace_id", &workspace_id).await? else {
            return Ok(scim_error(scim::ScimError::new(403, None, "Set up single sign-on for the workspace first.")));
        };
        let plan = self.plan_refusal::<()>(&slug, plan_needed(&slug)).await?.and_then(|refused| match refused {
            Outcome::Fail(failure) => Some(failure.message),
            Outcome::Ok(()) => None,
        });
        self.db
            .prepare("UPDATE scim_tokens SET last_used_at = ? WHERE workspace_id = ?")
            .bind(&[rfc3339(now_ms()).into(), workspace_id.as_str().into()])?
            .run()
            .await?;
        let body: Value = match a.body.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
            None => Value::Null,
            Some(text) => match serde_json::from_str(text) {
                Ok(body) => body,
                Err(_) => return Ok(scim_error(scim::ScimError::new(400, Some("invalidSyntax"), "The body is not JSON."))),
            },
        };
        let segments: Vec<&str> = a.path.split('/').filter(|s| !s.is_empty()).collect();
        let method = a.method.to_uppercase();
        let query: HashMap<String, String> = worker::Url::parse(&format!("https://q.invalid/?{}", a.query.as_deref().unwrap_or("")))
            .map(|url| url.query_pairs().into_owned().collect())
            .unwrap_or_default();
        let at = Scim { workspace_id: &workspace_id, slug: &slug, connection_id: &connection.id, base: &a.base, plan: plan.as_deref() };
        Ok(match (method.as_str(), segments.as_slice()) {
            ("GET", ["ServiceProviderConfig"]) => answer(200, Some(scim::service_provider_config("https://docs.g1t.sh/guides/single-sign-on/#scim"))),
            ("GET", ["ResourceTypes"]) => answer(200, Some(scim::resource_types(&a.base))),
            ("GET", ["Schemas"]) => answer(200, Some(scim::list(Vec::new(), 0, 1))),
            ("GET", ["Users"]) => self.scim_list(&at, &query).await?,
            ("POST", ["Users"]) => self.scim_create(&at, &body).await?,
            ("GET", ["Users", id]) => match self.scim_row(&workspace_id, id).await? {
                Some(row) => answer(200, Some(scim::to_resource(&row.id, &row.user(), &row.created_at, &row.updated_at, &a.base))),
                None => scim_error(scim::ScimError::new(404, None, "No such user.")),
            },
            ("PUT" | "PATCH", ["Users", id]) => self.scim_change(&at, id, &body, method == "PATCH").await?,
            ("DELETE", ["Users", id]) => self.scim_delete(&at, id).await?,
            ("GET", ["Groups"]) => answer(200, Some(scim::list(Vec::new(), 0, 1))),
            (_, ["Groups", ..]) => scim_error(scim::ScimError::new(
                501,
                None,
                "g1t keeps users, not groups: assign people (or a group's members) to g1t, and turn off pushing groups.",
            )),
            _ => scim_error(scim::ScimError::new(404, None, "No such SCIM endpoint.")),
        })
    }

    async fn scim_row(&self, workspace_id: &str, id: &str) -> Result<Option<ScimRow>> {
        self.db
            .prepare(format!("{SELECT_ROW} WHERE workspace_id = ? AND id = ?"))
            .bind(&[workspace_id.into(), id.into()])?
            .first::<ScimRow>(None)
            .await
    }

    async fn scim_list(&self, at: &Scim<'_>, query: &HashMap<String, String>) -> Result<ScimAnswer> {
        let filter = match query.get("filter").map(String::as_str).filter(|f| !f.trim().is_empty()) {
            Some(filter) => match scim::parse_filter(filter) {
                Ok(filter) => Some(filter),
                Err(error) => return Ok(scim_error(error)),
            },
            None => None,
        };
        let start = query.get("startIndex").and_then(|s| s.parse::<usize>().ok()).unwrap_or(1).max(1);
        let count = query.get("count").and_then(|s| s.parse::<usize>().ok()).unwrap_or(100).min(scim::MAX_PAGE);
        let rows = self
            .db
            .prepare(format!("{SELECT_ROW} WHERE workspace_id = ? ORDER BY created_at, id"))
            .bind(&[at.workspace_id.into()])?
            .all()
            .await?
            .results::<ScimRow>()?;
        let matching: Vec<ScimRow> = rows
            .into_iter()
            .filter(|row| {
                let user = row.user();
                match &filter {
                    None => true,
                    Some(scim::Filter::UserName(name)) => scim::user_name_key(&user.user_name) == scim::user_name_key(name),
                    Some(scim::Filter::ExternalId(id)) => user.external_id.as_deref() == Some(id.as_str()),
                    Some(scim::Filter::Id(id)) => &row.id == id,
                    Some(scim::Filter::Email(email)) => user.emails.contains(email),
                }
            })
            .collect();
        let page: Vec<Value> = matching
            .iter()
            .skip(start - 1)
            .take(count)
            .map(|row| scim::to_resource(&row.id, &row.user(), &row.created_at, &row.updated_at, at.base))
            .collect();
        Ok(answer(200, Some(scim::list(page, matching.len(), start))))
    }

    async fn user_name_taken(&self, workspace_id: &str, key: &str, other_than: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT 1 AS yes FROM scim_users WHERE workspace_id = ? AND user_name_key = ? AND id != ?")
            .bind(&[workspace_id.into(), key.into(), other_than.into()])?
            .first::<Value>(None)
            .await?
            .is_some())
    }

    async fn scim_create(&self, at: &Scim<'_>, body: &Value) -> Result<ScimAnswer> {
        let user = match scim::from_resource(body) {
            Ok(user) => user,
            Err(error) => return Ok(scim_error(error)),
        };
        if user.active
            && let Some(refused) = at.plan_refusal()
        {
            return Ok(refused);
        }
        let key = scim::user_name_key(&user.user_name);
        if self.user_name_taken(at.workspace_id, &key, "").await? {
            return Ok(scim_error(scim::ScimError::new(409, Some("uniqueness"), format!("{} is provisioned already.", user.user_name))));
        }
        let id = new_id("scu", now_ms());
        let now = rfc3339(now_ms());
        let linked = self.sso_account_of(at.connection_id, &user).await?;
        self.db
            .prepare(
                "INSERT INTO scim_users (id, workspace_id, user_name, user_name_key, external_id, resource, active, user_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            )
            .bind(&[
                id.as_str().into(),
                at.workspace_id.into(),
                user.user_name.as_str().into(),
                key.as_str().into(),
                user.external_id.as_deref().map_or(JsValue::NULL, Into::into),
                serde_json::to_string(&user).unwrap_or_default().into(),
                (user.active as u8).into(),
                linked.as_deref().map_or(JsValue::NULL, Into::into),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        self.audit_workspace(&scim_actor(), "sso.scim_user_provisioned", at.slug, Surface::Rest, format!("Provisioned {}", user.user_name))
            .await;
        if !user.active
            && let Some(user_id) = &linked
        {
            self.deprovision(at, user_id, &user.user_name).await?;
        }
        Ok(answer(201, Some(scim::to_resource(&id, &user, &now, &now, at.base))))
    }

    async fn scim_change(&self, at: &Scim<'_>, id: &str, body: &Value, patch: bool) -> Result<ScimAnswer> {
        let Some(row) = self.scim_row(at.workspace_id, id).await? else {
            return Ok(scim_error(scim::ScimError::new(404, None, "No such user.")));
        };
        let before = row.user();
        let changed = if patch {
            let mut user = before.clone();
            scim::apply_patch(&mut user, body).map(|_| user)
        } else {
            scim::from_resource(body)
        };
        let user = match changed {
            Ok(user) => user,
            Err(error) => return Ok(scim_error(error)),
        };
        if user.active
            && let Some(refused) = at.plan_refusal()
        {
            return Ok(refused);
        }
        let key = scim::user_name_key(&user.user_name);
        if self.user_name_taken(at.workspace_id, &key, id).await? {
            return Ok(scim_error(scim::ScimError::new(409, Some("uniqueness"), format!("{} is provisioned already.", user.user_name))));
        }
        let linked = match row.user_id.clone() {
            Some(linked) => Some(linked),
            None => self.sso_account_of(at.connection_id, &user).await?,
        };
        let now = rfc3339(now_ms());
        self.db
            .prepare(
                "UPDATE scim_users SET user_name = ?, user_name_key = ?, external_id = ?, resource = ?, active = ?, user_id = ?, updated_at = ?
                 WHERE id = ? AND workspace_id = ?",
            )
            .bind(&[
                user.user_name.as_str().into(),
                key.as_str().into(),
                user.external_id.as_deref().map_or(JsValue::NULL, Into::into),
                serde_json::to_string(&user).unwrap_or_default().into(),
                (user.active as u8).into(),
                linked.as_deref().map_or(JsValue::NULL, Into::into),
                now.as_str().into(),
                id.into(),
                at.workspace_id.into(),
            ])?
            .run()
            .await?;
        if before.active != user.active {
            let (action, word) = if user.active { ("sso.scim_user_activated", "Activated") } else { ("sso.scim_user_deactivated", "Deactivated") };
            self.audit_workspace(&scim_actor(), action, at.slug, Surface::Rest, format!("{word} {}", user.user_name)).await;
        }
        if !user.active
            && let Some(user_id) = &linked
        {
            self.deprovision(at, user_id, &user.user_name).await?;
        }
        Ok(answer(200, Some(scim::to_resource(id, &user, &row.created_at, &now, at.base))))
    }

    async fn scim_delete(&self, at: &Scim<'_>, id: &str) -> Result<ScimAnswer> {
        let Some(row) = self.scim_row(at.workspace_id, id).await? else {
            return Ok(scim_error(scim::ScimError::new(404, None, "No such user.")));
        };
        let user = row.user();
        let linked = match row.user_id.clone() {
            Some(linked) => Some(linked),
            None => self.sso_account_of(at.connection_id, &user).await?,
        };
        if let Some(user_id) = &linked {
            self.deprovision(at, user_id, &user.user_name).await?;
        }
        self.db
            .prepare("DELETE FROM scim_users WHERE id = ? AND workspace_id = ?")
            .bind(&[id.into(), at.workspace_id.into()])?
            .run()
            .await?;
        self.audit_workspace(&scim_actor(), "sso.scim_user_deleted", at.slug, Surface::Rest, format!("Deprovisioned {}", user.user_name))
            .await;
        Ok(answer(204, None))
    }

    /// The g1t account already linked through single sign-on as `user`, by
    /// the subject it signed in as (the address it gave is not trusted for
    /// this). Only when exactly one is.
    async fn sso_account_of(&self, connection_id: &str, user: &scim::ScimUser) -> Result<Option<String>> {
        #[derive(Deserialize)]
        struct Linked {
            user_id: String,
            subject: String,
        }
        let linked = self
            .db
            .prepare("SELECT user_id, subject FROM sso_identities WHERE connection_id = ?")
            .bind(&[connection_id.into()])?
            .all()
            .await?
            .results::<Linked>()?;
        let mut found = linked.into_iter().filter(|l| scim::is_them(user, std::slice::from_ref(&l.subject), None));
        Ok(match (found.next(), found.next()) {
            (Some(one), None) => Some(one.user_id),
            _ => None,
        })
    }

    /// Someone the provider unassigned leaves the workspace: their
    /// membership and roles (`drop_member`), their link, and their sessions
    /// through it. Never an owner: a provider cannot lock a workspace out of
    /// itself, so an owner is kept and the audit log says so.
    async fn deprovision(&self, at: &Scim<'_>, user_id: &str, user_name: &str) -> Result<()> {
        #[derive(Deserialize)]
        struct Member {
            role: String,
        }
        let member = self
            .db
            .prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
            .bind(&[at.workspace_id.into(), user_id.into()])?
            .first::<Member>(None)
            .await?;
        if member.as_ref().is_some_and(|m| m.role == "owner") {
            self.audit_workspace(
                &scim_actor(),
                "sso.scim_owner_kept",
                at.slug,
                Surface::Rest,
                format!("{user_name} was deprovisioned but is an owner, so stays: remove them by hand if they should go"),
            )
            .await;
            return Ok(());
        }
        self.db
            .batch(vec![
                self.db
                    .prepare("DELETE FROM sso_identities WHERE connection_id = ? AND user_id = ?")
                    .bind(&[at.connection_id.into(), user_id.into()])?,
                self.db
                    .prepare("DELETE FROM sso_sessions WHERE workspace_id = ? AND session_id IN (SELECT id FROM sessions WHERE user_id = ?)")
                    .bind(&[at.workspace_id.into(), user_id.into()])?,
                // An invitation waiting for them would only let them back in.
                self.db
                    .prepare(format!(
                        "UPDATE invites SET revoked_at = {SQL_NOW}, sealed_code = NULL
                         WHERE workspace_id = ? AND invitee_id = ? AND revoked_at IS NULL AND accepted_at IS NULL
                           AND declined_at IS NULL AND redeemed_at IS NULL"
                    ))
                    .bind(&[at.workspace_id.into(), user_id.into()])?,
            ])
            .await?;
        if member.is_some() {
            self.drop_member(at.workspace_id, user_id).await?;
            let username = self.sso_person(user_id).await?.map(|p| p.username).unwrap_or_else(|| user_name.to_owned());
            self.audit_workspace(
                &scim_actor(),
                "member.removed_by_scim",
                at.slug,
                Surface::Rest,
                format!("Removed {username}: deprovisioned as {user_name}"),
            )
            .await;
            self.announce_workspace(at.workspace_id, at.slug, None).await;
        }
        Ok(())
    }
}
