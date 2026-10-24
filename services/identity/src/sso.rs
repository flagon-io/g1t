//! Single sign-on: a workspace's own identity provider, on every paid plan.
//! See `g1t_contracts::sso` for the model; in short, it never signs anyone
//! in to g1t. A person signed in to g1t proves themselves to the
//! workspace's provider to use the workspace:
//!
//! 1. `sso_start` keeps a state row bound to their session and sends them
//!    to the provider: OpenID Connect or OAuth 2.0 with PKCE (oauth.rs),
//!    or a SAML request (saml.rs).
//! 2. `sso_finish` (a code) or `sso_saml` (a posted response) spends the
//!    state, checks what the provider said, and `complete` links who they
//!    are there to their g1t account (once, and one each way), adds them
//!    as a member when the workspace lets its provider's people join, and
//!    marks their session as signed in through it for a day.
//!
//! **Requiring it.** `workspaces.require_sso` is read with the memberships
//! (workspaces.rs), so it costs nothing where no workspace asks. A member
//! of one that requires it uses it ([`Identity::sso_holds`]) only from a
//! session marked for it (`sso_sessions`), or with a token or key once
//! they have linked (`sso_identities`); otherwise the workspace, and their
//! roles on its repositories, are held out with a notice that links to
//! signing in through it. Owners and g1t's own agent are never held, so a
//! provider that breaks never locks a workspace out of itself.
//!
//! **Paid plans.** Setting it up, changing it, requiring it, and signing in
//! through it need a paid plan (paid.rs). Turning it off and deleting it
//! never do. A workspace whose plan ends keeps its settings; its members
//! cannot sign in through it until the plan starts again or an owner turns
//! the requirement off.

#[path = "sso/jwt.rs"]
mod jwt;
#[path = "sso/oauth.rs"]
mod oauth;
#[path = "sso/provisioning.rs"]
mod provisioning;
#[path = "sso/saml.rs"]
mod saml;
#[path = "sso/scim.rs"]
mod scim;

use std::collections::HashSet;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use g1t_contracts::audit::Surface;
use g1t_contracts::events::JoinedHow;
use g1t_contracts::identity::SlugArgs;
use g1t_contracts::members::PolicyHold;
use g1t_contracts::sso::*;
use g1t_contracts::time::{SQL_NOW, rfc3339, sql_after};
use g1t_contracts::{FailureCode, Membership, Outcome, PrincipalKind, Role, User, new_id};
use g1t_kit::now_ms;
use g1t_secrets::Sealer;
use serde::Deserialize;
use serde_json::Value;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::security::is_person;
use crate::{Identity, crypto};

const STATE_TTL_SECONDS: u64 = 10 * 60;
/// How long a session signed in through a workspace's provider counts as
/// that, before it goes through the provider again (usually at once: the
/// provider remembers them).
const SSO_SESSION_SECONDS: u64 = 24 * 60 * 60;
const OWNERS_ONLY: &str = "Only an owner can change the workspace's single sign-on.";
const EXPIRED: &str = "This single sign-on took too long or was already used. Start again.";
const MAX_FIELD: usize = 2048;

/// What to say to a free workspace.
fn plan_needed(slug: &str) -> String {
    format!("Single sign-on comes with every paid plan. An owner of {slug} can start the plan at /{slug}/-/settings/billing#plan.")
}

/// What to tell a member a workspace holds out until they sign in through
/// its provider.
pub fn hold_reason(slug: &str) -> String {
    format!("{slug} requires single sign-on. Sign in through its identity provider to use it.")
}

#[derive(Deserialize)]
struct ConnectionRow {
    id: String,
    workspace_id: String,
    protocol: String,
    config: String,
    client_secret: Option<String>,
    allow_join: u8,
    tested_at: Option<String>,
    #[serde(default)]
    tested_by_username: Option<String>,
    created_at: String,
    updated_at: String,
}

impl ConnectionRow {
    fn protocol(&self) -> SsoProtocol {
        SsoProtocol::parse(&self.protocol).unwrap_or(SsoProtocol::Oidc)
    }

    fn config(&self) -> SsoConfig {
        serde_json::from_str(&self.config).unwrap_or_default()
    }

    fn view(&self) -> SsoConnection {
        let config = self.config();
        SsoConnection {
            id: self.id.clone(),
            protocol: self.protocol(),
            has_client_secret: self.client_secret.is_some(),
            certificates: config
                .certificates
                .iter()
                .filter_map(|der| STANDARD.decode(der).ok())
                .map(|der| SsoCertificate { fingerprint: saml::fingerprint(&der) })
                .collect(),
            config,
            allow_join: self.allow_join != 0,
            tested_at: self.tested_at.clone(),
            tested_by: self.tested_by_username.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

#[derive(Deserialize)]
struct StateRow {
    connection_id: String,
    session_id: String,
    user_id: String,
    verifier: Option<String>,
    nonce: Option<String>,
    redirect_uri: String,
    audience: Option<String>,
    next: String,
    #[serde(default)]
    browser: Option<String>,
}

/// Who the provider says signed in.
pub(crate) struct Said {
    /// Its stable id for them: OpenID's `sub`, the userinfo subject claim,
    /// or SAML's NameID. An address-shaped one is lowercased, as providers
    /// change its case.
    pub subject: String,
    /// Every stable id it gave, the subject first: also Entra's `oid` and,
    /// for an Entra tenant's own members, their user principal name.
    pub ids: Vec<String>,
    /// The address it gave, for showing.
    pub email: Option<String>,
    /// Whether that address can be trusted to be theirs: OpenID's
    /// `email_verified`, or a SAML assertion the provider signed. Only a
    /// trusted address matches anyone or lets anyone join by domain.
    pub email_verified: bool,
}

impl Said {
    fn new(subject: String, email: Option<String>, email_verified: bool) -> Said {
        let subject = if subject.contains('@') { subject.trim().to_lowercase() } else { subject.trim().to_owned() };
        Said {
            ids: vec![subject.clone()],
            subject,
            email: email.map(|e| e.trim().to_lowercase()).filter(|e| e.contains('@')),
            email_verified,
        }
    }

    fn trusted_email(&self) -> Option<&str> {
        self.email.as_deref().filter(|_| self.email_verified)
    }
}

/// What an OpenID Connect ID token says. For Entra, its `oid` too: the
/// person's object id in the tenant, the same in every app registration
/// (`sub` is not), and what SCIM may know them by. Never its
/// `preferred_username`, which is mutable and, for a guest, their home
/// address.
fn said_by_oidc(claims: &Value, issuer: &str) -> Option<Said> {
    let subject = oauth::claim(claims, "sub")?;
    // Some providers send the flag as a string.
    let verified = claims["email_verified"].as_bool().or_else(|| claims["email_verified"].as_str().map(|v| v.eq_ignore_ascii_case("true")))
        == Some(true);
    let mut said = Said::new(subject, oauth::claim(claims, "email"), verified);
    if issuer.starts_with("https://login.microsoftonline.com/") {
        said.ids.extend(oauth::claim(claims, "oid").filter(|oid| !said.ids.contains(oid)));
    }
    Some(said)
}

/// Whether two lists of a person's ids share one.
fn same_person(stored: &[String], said: &[String]) -> bool {
    stored.iter().any(|id| said.iter().any(|other| other.eq_ignore_ascii_case(id)))
}

/// Why `said` may not join by its address, when the connection names the
/// domains that may: an address the provider vouches for, at one of them.
fn join_domain_refusal(domains: &[String], said: &Said, slug: &str) -> Option<String> {
    if domains.is_empty() {
        return None;
    }
    let at = said.trusted_email().and_then(|email| email.rsplit_once('@')).map(|(_, domain)| domain.to_owned());
    match at {
        Some(domain) if domains.iter().any(|d| d.eq_ignore_ascii_case(&domain)) => None,
        _ => Some(format!(
            "Only people with an address at {} join {slug} through its identity provider. Ask an owner to invite you.",
            domains.join(" or ")
        )),
    }
}

/// The domains a connection lets join, as an owner entered them.
fn domains_from(given: &[String]) -> std::result::Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for domain in given.iter().flat_map(|d| d.split([',', ' ', '\n'])) {
        let domain = domain.trim().trim_start_matches('@').to_lowercase();
        if domain.is_empty() {
            continue;
        }
        if !domain.contains('.') || domain.len() > 253 || !domain.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
            return Err(format!("{domain} is not a domain, such as acme.com."));
        }
        if !out.contains(&domain) {
            out.push(domain);
        }
    }
    out.truncate(20);
    Ok(out)
}

/// Which provider a connection is: changing it unlinks everyone.
fn provider_of(protocol: SsoProtocol, config: &SsoConfig) -> String {
    let at = match protocol {
        SsoProtocol::Oidc => config.issuer.as_deref(),
        SsoProtocol::Oauth2 => config.authorization_url.as_deref(),
        SsoProtocol::Saml => config.idp_entity_id.as_deref(),
    };
    format!("{}:{}", protocol.as_str(), at.unwrap_or_default().trim().trim_end_matches('/'))
}

/// A field as given: trimmed, empty as absent, and not too long.
fn field(value: &Option<String>, name: &str) -> std::result::Result<Option<String>, String> {
    let value = value.as_deref().map(str::trim).filter(|v| !v.is_empty());
    match value {
        Some(v) if v.len() > MAX_FIELD => Err(format!("The {name} is too long.")),
        v => Ok(v.map(str::to_owned)),
    }
}

fn https_field(value: &Option<String>, name: &str) -> std::result::Result<String, String> {
    let value = field(value, name)?.ok_or_else(|| format!("Enter the {name}."))?;
    oauth::https(&value).ok_or_else(|| format!("The {name} must be an https address."))?;
    Ok(value)
}

/// The stored config for what an owner entered, checked for the protocol;
/// `certificates` are SAML's, as they will be kept. Only the protocol's
/// own fields are kept.
fn checked_config(protocol: SsoProtocol, given: &SsoConfig, certificates: Vec<String>) -> std::result::Result<SsoConfig, String> {
    let client_id = || field(&given.client_id, "client id")?.ok_or_else(|| "Enter the client id.".to_owned());
    let join_domains = domains_from(&given.join_domains)?;
    let config = match protocol {
        SsoProtocol::Oidc => SsoConfig {
            issuer: Some(https_field(&given.issuer, "issuer")?),
            client_id: Some(client_id()?),
            scopes: field(&given.scopes, "scopes")?,
            ..SsoConfig::default()
        },
        SsoProtocol::Oauth2 => SsoConfig {
            authorization_url: Some(https_field(&given.authorization_url, "authorization URL")?),
            token_url: Some(https_field(&given.token_url, "token URL")?),
            userinfo_url: Some(https_field(&given.userinfo_url, "userinfo URL")?),
            client_id: Some(client_id()?),
            scopes: field(&given.scopes, "scopes")?,
            subject_claim: field(&given.subject_claim, "subject claim")?,
            email_claim: field(&given.email_claim, "email claim")?,
            ..SsoConfig::default()
        },
        SsoProtocol::Saml => {
            if certificates.is_empty() {
                return Err("Paste the identity provider's signing certificate.".to_owned());
            }
            SsoConfig {
                idp_entity_id: Some(
                    field(&given.idp_entity_id, "entity id")?.ok_or("Enter the identity provider's entity id (its issuer).")?,
                ),
                idp_sso_url: Some(https_field(&given.idp_sso_url, "single sign-on URL")?),
                certificates,
                ..SsoConfig::default()
            }
        }
    };
    Ok(SsoConfig { join_domains, ..config })
}

/// How someone came in, for what single sign-on asks of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via<'a> {
    /// A session on the site: its hash.
    Session(&'a str),
    /// An access token, an SSH key, a deploy key.
    Credential,
    /// Their g1t password (git over HTTPS without a token).
    Password,
}

/// Which of a person's memberships a workspace's single sign-on holds out:
/// those that require it and they have not met, never as an owner.
pub fn held_by_sso(required: &[(String, Role)], met: &HashSet<String>) -> Vec<String> {
    required.iter().filter(|(slug, role)| *role != Role::Owner && !met.contains(slug)).map(|(slug, _)| slug.clone()).collect()
}

/// Leaves out the memberships and grants of the workspaces in `held`, and
/// says why, beside any other holds.
pub fn apply_sso_holds(user: &mut User, held: &[String]) {
    if held.is_empty() {
        return;
    }
    user.workspaces.retain(|membership: &Membership| !held.contains(&membership.slug));
    user.grants.retain(|grant| !held.contains(&grant.workspace));
    for slug in held {
        if !user.held.iter().any(|hold| &hold.slug == slug) {
            user.held.push(PolicyHold { slug: slug.clone(), reason: hold_reason(slug), gap: "sso".to_owned() });
        }
    }
}

impl Identity {
    fn sso_sealer(&self) -> Option<Sealer> {
        Sealer::new(&self.env.secret("IDENTITY_KEY").ok()?.to_string())
    }

    async fn connection_where(&self, column: &str, value: &str) -> Result<Option<ConnectionRow>> {
        self.db
            .prepare(format!(
                "SELECT c.*, u.username AS tested_by_username FROM sso_connections c
                 LEFT JOIN users u ON u.id = c.tested_by WHERE c.{column} = ?"
            ))
            .bind(&[value.into()])?
            .first::<ConnectionRow>(None)
            .await
    }

    /// The workspace's id when `actor` is a confirmed person who owns it.
    async fn sso_owner(&self, actor: &User, slug: &str) -> Result<Outcome<String>> {
        if !is_person(actor) || actor.role_in(slug) != Some(Role::Owner) {
            return Ok(Outcome::fail(FailureCode::Forbidden, OWNERS_ONLY));
        }
        if !actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        Ok(match self.workspace_id_of(slug).await? {
            Some(id) => Outcome::Ok(id),
            None => Outcome::fail(FailureCode::NotFound, "Workspace not found."),
        })
    }

    /// The workspace `key` names, as `(id, slug)`: its id (`wsp_…`, what a
    /// provider is pointed at), its name, or a name it had before a rename.
    pub(crate) async fn sso_workspace(&self, key: &str) -> Result<Option<(String, String)>> {
        #[derive(Deserialize)]
        struct Found {
            id: String,
            slug: String,
        }
        let key = key.trim();
        let found = self
            .db
            .prepare(
                "SELECT id, slug FROM workspaces WHERE deleted_at IS NULL AND (id = ?1 OR slug = lower(?1)
                   OR id = (SELECT workspace_id FROM workspace_redirects WHERE old_slug = lower(?1)))
                 ORDER BY id = ?1 DESC, slug = lower(?1) DESC LIMIT 1",
            )
            .bind(&[key.into()])?
            .first::<Found>(None)
            .await?;
        Ok(found.map(|f| (f.id, f.slug)))
    }

    async fn require_sso_of(&self, workspace_id: &str) -> Result<bool> {
        #[derive(Deserialize)]
        struct Row {
            require_sso: u8,
        }
        Ok(self
            .db
            .prepare("SELECT require_sso FROM workspaces WHERE id = ?")
            .bind(&[workspace_id.into()])?
            .first::<Row>(None)
            .await?
            .is_some_and(|row| row.require_sso != 0))
    }

    async fn sso_linked(&self, connection_id: &str, user_id: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare("SELECT 1 AS yes FROM sso_identities WHERE connection_id = ? AND user_id = ?")
            .bind(&[connection_id.into(), user_id.into()])?
            .first::<Value>(None)
            .await?
            .is_some())
    }

    /// `sso_settings`: the workspace's single sign-on, for its owners.
    pub async fn sso_settings(&self, a: SsoSettingsArgs) -> Result<Outcome<SsoSettings>> {
        let slug = a.slug.trim().to_lowercase();
        let workspace_id = match self.sso_owner(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        self.settings_of(&workspace_id, &slug, &a.actor).await.map(Outcome::Ok)
    }

    async fn settings_of(&self, workspace_id: &str, slug: &str, actor: &User) -> Result<SsoSettings> {
        let row = self.connection_where("workspace_id", workspace_id).await?;
        let you_linked = match &row {
            Some(row) => self.sso_linked(&row.id, &actor.id).await?,
            None => false,
        };
        let (identities, _) = match &row {
            Some(row) => {
                #[derive(Deserialize)]
                struct Linked {
                    user_id: String,
                    username: String,
                    display_username: Option<String>,
                    subject: String,
                    email: Option<String>,
                    created_at: String,
                    last_used_at: String,
                }
                let linked = self
                    .db
                    .prepare(
                        "SELECT i.user_id, u.username, u.display_username, i.subject, i.email, i.created_at, i.last_used_at
                         FROM sso_identities i JOIN users u ON u.id = i.user_id
                         WHERE i.connection_id = ? AND u.deleted_at IS NULL ORDER BY u.username LIMIT 500",
                    )
                    .bind(&[row.id.as_str().into()])?
                    .all()
                    .await?
                    .results::<Linked>()?;
                let you = linked.iter().any(|l| l.user_id == actor.id);
                let identities = linked
                    .into_iter()
                    .map(|l| SsoIdentity {
                        username: l.username,
                        display_username: l.display_username,
                        subject: l.subject,
                        email: l.email,
                        linked_at: l.created_at,
                        last_used_at: l.last_used_at,
                    })
                    .collect();
                (identities, you)
            }
            None => (Vec::new(), false),
        };
        Ok(SsoSettings {
            slug: slug.to_owned(),
            workspace_id: workspace_id.to_owned(),
            connection: row.as_ref().map(ConnectionRow::view),
            required: self.require_sso_of(workspace_id).await?,
            you_linked,
            identities,
            scim: self.scim_status(workspace_id).await?,
        })
    }

    /// `admin_sso`: a workspace's single sign-on, for staff in sudo.
    pub async fn admin_sso(&self, a: SlugArgs) -> Result<AdminSso> {
        let slug = a.slug.trim().to_lowercase();
        let Some(workspace_id) = self.workspace_id_of(&slug).await? else {
            return Ok(None);
        };
        if self.connection_where("workspace_id", &workspace_id).await?.is_none() {
            return Ok(None);
        }
        self.settings_of(&workspace_id, &slug, &User::default()).await.map(Some)
    }

    /// `sso_summary`: whether a workspace has single sign-on, for anyone.
    pub async fn sso_summary(&self, a: SlugArgs) -> Result<SsoSummary> {
        let Some((workspace_id, slug)) = self.sso_workspace(&a.slug).await? else {
            return Ok(SsoSummary::default());
        };
        // Which workspace, even before it has a connection: an owner gives
        // its provider g1t's metadata before saving one.
        let Some(row) = self.connection_where("workspace_id", &workspace_id).await? else {
            return Ok(SsoSummary { workspace_id, slug, ..SsoSummary::default() });
        };
        Ok(SsoSummary {
            workspace_id: workspace_id.clone(),
            slug,
            enabled: true,
            protocol: Some(row.protocol()),
            required: self.require_sso_of(&workspace_id).await?,
            allow_join: row.allow_join != 0,
        })
    }

    /// `save_sso`: see [`SaveSsoArgs`].
    pub async fn save_sso(&self, a: SaveSsoArgs) -> Result<Outcome<SsoSettings>> {
        let slug = a.slug.trim().to_lowercase();
        let workspace_id = match self.sso_owner(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if let Some(refused) = self.plan_refusal(&slug, plan_needed(&slug)).await? {
            return Ok(refused);
        }
        let Some(sealer) = self.sso_sealer() else {
            return Ok(Outcome::fail(FailureCode::Conflict, "Single sign-on is not set up on this g1t: it needs IDENTITY_KEY."));
        };
        let before = self.connection_where("workspace_id", &workspace_id).await?;
        let same_protocol = before.as_ref().filter(|row| row.protocol() == a.protocol);
        // SAML's certificates: as pasted, or the ones kept.
        let certificates = match a.certificate.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            Some(pasted) => match saml::certificates_from(pasted) {
                Ok(certificates) => certificates.iter().map(|der| STANDARD.encode(der)).collect(),
                Err(why) => return Ok(Outcome::fail(FailureCode::Invalid, why)),
            },
            None => same_protocol.map(|row| row.config().certificates).unwrap_or_default(),
        };
        let config = match checked_config(a.protocol, &a.config, if a.protocol == SsoProtocol::Saml { certificates } else { vec![] }) {
            Ok(config) => config,
            Err(why) => return Ok(Outcome::fail(FailureCode::Invalid, why)),
        };
        if a.protocol == SsoProtocol::Oidc
            && let Err(why) = oauth::discover(config.issuer.as_deref().unwrap_or_default()).await
        {
            return Ok(Outcome::fail(FailureCode::Invalid, why));
        }
        let id = before.as_ref().map(|row| row.id.clone()).unwrap_or_else(|| new_id("sso", now_ms()));
        // The client secret: as given, or the one kept.
        let secret = match a.client_secret.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            _ if a.protocol == SsoProtocol::Saml => None,
            Some(secret) if secret.len() > MAX_FIELD => return Ok(Outcome::fail(FailureCode::Invalid, "The client secret is too long.")),
            Some(secret) => Some(sealer.seal(secret, &format!("sso:{id}"))),
            None => match same_protocol.and_then(|row| row.client_secret.clone()) {
                Some(kept) => Some(kept),
                None => return Ok(Outcome::fail(FailureCode::Invalid, "Enter the client secret.")),
            },
        };
        let changed_provider =
            before.as_ref().is_some_and(|row| provider_of(row.protocol(), &row.config()) != provider_of(a.protocol, &config));
        let now = rfc3339(now_ms());
        let stored = serde_json::to_string(&config).unwrap_or_default();
        let secret_value = secret.as_deref().map_or(JsValue::NULL, Into::into);
        self.db
            .prepare(
                "INSERT INTO sso_connections (id, workspace_id, protocol, config, client_secret, allow_join, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT (workspace_id) DO UPDATE SET protocol = excluded.protocol, config = excluded.config,
                   client_secret = excluded.client_secret, allow_join = excluded.allow_join, updated_at = excluded.updated_at",
            )
            .bind(&[
                id.as_str().into(),
                workspace_id.as_str().into(),
                a.protocol.as_str().into(),
                stored.into(),
                secret_value,
                (a.allow_join as u8).into(),
                now.as_str().into(),
            ])?
            .run()
            .await?;
        if changed_provider {
            // Another provider: who people were at the old one means nothing
            // now, and it must be tried before it is required again.
            self.db
                .batch(vec![
                    self.db.prepare("DELETE FROM sso_identities WHERE connection_id = ?").bind(&[id.as_str().into()])?,
                    self.db.prepare("DELETE FROM sso_sessions WHERE workspace_id = ?").bind(&[workspace_id.as_str().into()])?,
                    self.db
                        .prepare("UPDATE sso_connections SET tested_at = NULL, tested_by = NULL WHERE id = ?")
                        .bind(&[id.as_str().into()])?,
                    self.db.prepare("UPDATE workspaces SET require_sso = 0 WHERE id = ?").bind(&[workspace_id.as_str().into()])?,
                ])
                .await?;
        }
        let surface = a.surface.unwrap_or(Surface::Web);
        let message = match (&before, changed_provider) {
            (None, _) => format!("Set up single sign-on over {}", protocol_name(a.protocol)),
            (Some(_), true) => {
                format!("Moved single sign-on to another identity provider ({}), unlinking everyone", protocol_name(a.protocol))
            }
            (Some(before), false) => {
                let was = before.config();
                let mut changes: Vec<String> = Vec::new();
                if was.certificates != config.certificates {
                    changes.push("its signing certificates".to_owned());
                }
                if was.client_id != config.client_id {
                    changes.push("its client id".to_owned());
                }
                if a.client_secret.as_deref().is_some_and(|s| !s.trim().is_empty()) {
                    changes.push("its client secret".to_owned());
                }
                if (before.allow_join != 0) != a.allow_join {
                    changes.push(if a.allow_join {
                        "letting its people join".to_owned()
                    } else {
                        "no longer letting its people join".to_owned()
                    });
                }
                if was.join_domains != config.join_domains {
                    changes.push(format!(
                        "who may join ({})",
                        if config.join_domains.is_empty() { "anyone".to_owned() } else { config.join_domains.join(", ") }
                    ));
                }
                if changes.is_empty() {
                    "Changed single sign-on's settings".to_owned()
                } else {
                    format!("Changed single sign-on: {}", changes.join(", "))
                }
            }
        };
        self.audit_workspace(&a.actor, if before.is_none() { "sso.created" } else { "sso.updated" }, &slug, surface, message).await;
        self.announce_workspace(&workspace_id, &slug, Some(&a.actor.id)).await;
        self.settings_of(&workspace_id, &slug, &a.actor).await.map(Outcome::Ok)
    }

    /// `set_sso_required`: see [`SetSsoRequiredArgs`].
    pub async fn set_sso_required(&self, a: SetSsoRequiredArgs) -> Result<Outcome<bool>> {
        let slug = a.slug.trim().to_lowercase();
        let workspace_id = match self.sso_owner(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let before = self.require_sso_of(&workspace_id).await?;
        if before == a.required {
            return Ok(Outcome::Ok(before));
        }
        if a.required {
            let Some(row) = self.connection_where("workspace_id", &workspace_id).await? else {
                return Ok(Outcome::fail(FailureCode::Conflict, "Set up single sign-on before requiring it."));
            };
            if let Some(refused) = self.plan_refusal(&slug, plan_needed(&slug)).await? {
                return Ok(refused);
            }
            if !self.sso_linked(&row.id, &a.actor.id).await? {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    "Sign in through the identity provider yourself before requiring it of everyone: use Test sign-in.",
                ));
            }
        }
        self.db
            .prepare("UPDATE workspaces SET require_sso = ? WHERE id = ?")
            .bind(&[(a.required as u8).into(), workspace_id.as_str().into()])?
            .run()
            .await?;
        self.audit_workspace(
            &a.actor,
            if a.required { "sso.required" } else { "sso.not_required" },
            &slug,
            a.surface.unwrap_or(Surface::Web),
            if a.required { "Required single sign-on of members".to_owned() } else { "Stopped requiring single sign-on".to_owned() },
        )
        .await;
        self.announce_workspace(&workspace_id, &slug, Some(&a.actor.id)).await;
        Ok(Outcome::Ok(a.required))
    }

    /// `delete_sso`: removes the connection, everyone's links to it, and the
    /// requirement. Never needs a paid plan.
    pub async fn delete_sso(&self, a: SsoSettingsArgs) -> Result<Outcome<bool>> {
        let slug = a.slug.trim().to_lowercase();
        let workspace_id = match self.sso_owner(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(row) = self.connection_where("workspace_id", &workspace_id).await? else {
            return Ok(Outcome::Ok(false));
        };
        self.db
            .batch(vec![
                self.db.prepare("DELETE FROM sso_states WHERE connection_id = ?").bind(&[row.id.as_str().into()])?,
                self.db.prepare("DELETE FROM sso_identities WHERE connection_id = ?").bind(&[row.id.as_str().into()])?,
                self.db.prepare("DELETE FROM sso_connections WHERE id = ?").bind(&[row.id.as_str().into()])?,
                self.db.prepare("DELETE FROM sso_sessions WHERE workspace_id = ?").bind(&[workspace_id.as_str().into()])?,
                self.db.prepare("UPDATE workspaces SET require_sso = 0 WHERE id = ?").bind(&[workspace_id.as_str().into()])?,
                // SCIM is single sign-on's: it goes with it.
                self.db.prepare("DELETE FROM scim_tokens WHERE workspace_id = ?").bind(&[workspace_id.as_str().into()])?,
                self.db.prepare("DELETE FROM scim_users WHERE workspace_id = ?").bind(&[workspace_id.as_str().into()])?,
            ])
            .await?;
        self.audit_workspace(&a.actor, "sso.deleted", &slug, a.surface.unwrap_or(Surface::Web), "Removed single sign-on".to_owned()).await;
        self.announce_workspace(&workspace_id, &slug, Some(&a.actor.id)).await;
        Ok(Outcome::Ok(true))
    }

    /// `unlink_sso_identity`: see [`UnlinkSsoIdentityArgs`].
    pub async fn unlink_sso_identity(&self, a: UnlinkSsoIdentityArgs) -> Result<Outcome<bool>> {
        let slug = a.slug.trim().to_lowercase();
        let workspace_id = match self.sso_owner(&a.actor, &slug).await? {
            Outcome::Ok(id) => id,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(row) = self.connection_where("workspace_id", &workspace_id).await? else {
            return Ok(Outcome::Ok(false));
        };
        let username = a.username.trim().trim_start_matches('@').to_lowercase();
        let removed = self
            .db
            .prepare(
                "DELETE FROM sso_identities WHERE connection_id = ?
                   AND user_id = (SELECT id FROM users WHERE username = ?) RETURNING user_id",
            )
            .bind(&[row.id.as_str().into(), username.as_str().into()])?
            .first::<Value>(None)
            .await?;
        let Some(removed) = removed else {
            return Ok(Outcome::Ok(false));
        };
        if let Some(user_id) = removed["user_id"].as_str() {
            // Their sessions go through the provider again, and their SCIM
            // assignment links to whoever signs in as it next.
            self.db
                .batch(vec![
                    self.db
                        .prepare(
                            "DELETE FROM sso_sessions WHERE workspace_id = ? AND session_id IN (SELECT id FROM sessions WHERE user_id = ?)",
                        )
                        .bind(&[workspace_id.as_str().into(), user_id.into()])?,
                    self.db
                        .prepare(format!(
                            "UPDATE scim_users SET user_id = NULL, updated_at = {SQL_NOW} WHERE workspace_id = ? AND user_id = ?"
                        ))
                        .bind(&[workspace_id.as_str().into(), user_id.into()])?,
                ])
                .await?;
        }
        self.audit_workspace(
            &a.actor,
            "sso.identity_unlinked",
            &slug,
            a.surface.unwrap_or(Surface::Web),
            format!("Unlinked {username}'s identity at the single sign-on provider"),
        )
        .await;
        Ok(Outcome::Ok(true))
    }

    /// `sso_start`: see [`SsoStartArgs`].
    pub async fn sso_start(&self, a: SsoStartArgs) -> Result<Outcome<SsoStart>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Sign in to g1t as yourself first."));
        }
        if !a.user.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Confirm your email address first."));
        }
        let Some((workspace_id, slug)) = self.sso_workspace(&a.slug).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no workspace with that name."));
        };
        let Some(row) = self.connection_where("workspace_id", &workspace_id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, format!("{slug} has not set up single sign-on.")));
        };
        if row.allow_join == 0 && !self.is_member_of(&workspace_id, &a.user.id).await? {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                format!("Only members of {slug} sign in through its identity provider. Ask an owner to invite you."),
            ));
        }
        if let Some(refused) = self.plan_refusal(&slug, plan_needed(&slug)).await? {
            return Ok(refused);
        }
        let session_id = crypto::sha256_hex(&a.session_token);
        let live = self
            .db
            .prepare(format!("SELECT 1 AS yes FROM sessions WHERE id = ? AND user_id = ? AND expires_at > {SQL_NOW}"))
            .bind(&[session_id.as_str().into(), a.user.id.as_str().into()])?
            .first::<Value>(None)
            .await?;
        if live.is_none() {
            return Ok(Outcome::fail(FailureCode::Unauthenticated, "Sign in to g1t again."));
        }
        let callback = worker::Url::parse(&a.redirect_uri).ok();
        if !callback.is_some_and(|url| url.scheme() == "https" || url.host_str() == Some("localhost")) {
            return Ok(Outcome::fail(FailureCode::Invalid, "The callback must be an https address."));
        }
        let config = row.config();
        let (key, url, state, verifier, nonce) = match row.protocol() {
            SsoProtocol::Saml => {
                let Some(entity_id) = a.entity_id.as_deref().filter(|e| !e.is_empty()) else {
                    return Ok(Outcome::fail(FailureCode::Invalid, "SAML needs g1t's entity id."));
                };
                let request_id = saml::request_id(&crypto::random_hex(20));
                let sso_url = config.idp_sso_url.as_deref().unwrap_or_default();
                let Some(url) = saml::authn_request_url(sso_url, &request_id, entity_id, &a.redirect_uri, &slug, now_ms()) else {
                    return Ok(Outcome::fail(FailureCode::Invalid, "The identity provider's single sign-on URL must be an https address."));
                };
                (request_id, url, None, None, None)
            }
            protocol => {
                let endpoints = match self.endpoints_of(protocol, &config).await {
                    Ok(endpoints) => endpoints,
                    Err(why) => return Ok(Outcome::fail(FailureCode::Conflict, why)),
                };
                let state = crypto::random_hex(32);
                let verifier = crate::github::new_verifier();
                let nonce = (protocol == SsoProtocol::Oidc).then(|| crypto::random_hex(16));
                let scopes = oauth::scopes(config.scopes.as_deref(), protocol == SsoProtocol::Oidc);
                let authorize = oauth::Authorize {
                    client_id: config.client_id.as_deref().unwrap_or_default(),
                    redirect_uri: &a.redirect_uri,
                    scopes: &scopes,
                    state: &state,
                    nonce: nonce.as_deref(),
                    challenge: &crate::github::pkce_challenge(&verifier),
                };
                let Some(url) = oauth::authorize_url(&endpoints.authorize, &authorize) else {
                    return Ok(Outcome::fail(FailureCode::Conflict, "The provider's authorization endpoint must be an https address."));
                };
                (state.clone(), url, Some(state), Some(verifier), nonce)
            }
        };
        // SAML's response comes back cross-site, without the session cookie:
        // a SameSite=None cookie of its own binds it to this browser.
        let binding = (row.protocol() == SsoProtocol::Saml).then(|| crypto::random_hex(32));
        let optional = |value: Option<&str>| value.map_or(JsValue::NULL, Into::into);
        let browser = binding.as_deref().map(crypto::sha256_hex);
        self.db
            .prepare(format!(
                "INSERT INTO sso_states (id, connection_id, session_id, user_id, verifier, nonce, redirect_uri, audience, next, browser, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, {})",
                sql_after(STATE_TTL_SECONDS)
            ))
            .bind(&[
                crypto::sha256_hex(&key).into(),
                row.id.as_str().into(),
                session_id.as_str().into(),
                a.user.id.as_str().into(),
                optional(verifier.as_deref()),
                optional(nonce.as_deref()),
                a.redirect_uri.as_str().into(),
                optional(a.entity_id.as_deref()),
                a.next.as_str().into(),
                optional(browser.as_deref()),
            ])?
            .run()
            .await?;
        // Old trips never finished, and sessions past their day, go now and then.
        self.db
            .batch(vec![
                self.db.prepare(format!("DELETE FROM sso_states WHERE expires_at < {SQL_NOW}")),
                self.db.prepare(format!("DELETE FROM sso_sessions WHERE expires_at < {SQL_NOW}")),
            ])
            .await?;
        Ok(Outcome::Ok(SsoStart { url, state, binding }))
    }

    async fn endpoints_of(&self, protocol: SsoProtocol, config: &SsoConfig) -> std::result::Result<oauth::Endpoints, String> {
        match protocol {
            SsoProtocol::Oidc => oauth::discover(config.issuer.as_deref().unwrap_or_default()).await,
            _ => Ok(oauth::Endpoints {
                authorize: config.authorization_url.clone().unwrap_or_default(),
                token: config.token_url.clone().unwrap_or_default(),
                userinfo: config.userinfo_url.clone(),
                issuer: None,
                jwks: None,
                basic: false,
            }),
        }
    }

    /// Spends a state row, once, and finds its connection, which must be the
    /// workspace's that `workspace` names (by id or name), and that
    /// workspace's name now.
    async fn spend_state(&self, key: &str, workspace: &str) -> Result<Option<(StateRow, ConnectionRow, String)>> {
        let state = self
            .db
            .prepare(format!("DELETE FROM sso_states WHERE id = ? AND expires_at > {SQL_NOW} RETURNING *"))
            .bind(&[crypto::sha256_hex(key).into()])?
            .first::<StateRow>(None)
            .await?;
        let Some(state) = state else {
            return Ok(None);
        };
        let Some(row) = self.connection_where("id", &state.connection_id).await? else {
            return Ok(None);
        };
        let Some((workspace_id, slug)) = self.sso_workspace(workspace).await? else {
            return Ok(None);
        };
        Ok((workspace_id == row.workspace_id).then_some((state, row, slug)))
    }

    /// `sso_finish`: see [`SsoFinishArgs`].
    pub async fn sso_finish(&self, a: SsoFinishArgs) -> Result<Outcome<SsoFinished>> {
        let Some((state, row, slug)) = self.spend_state(&a.state, &a.slug).await? else {
            return Ok(Outcome::fail(FailureCode::Invalid, EXPIRED));
        };
        if crypto::sha256_hex(&a.session_token) != state.session_id {
            return Ok(Outcome::fail(FailureCode::Invalid, "This single sign-on started in another session. Start again."));
        }
        let protocol = row.protocol();
        let config = row.config();
        let secret = row.client_secret.as_deref().and_then(|sealed| self.sso_sealer()?.open(sealed, &format!("sso:{}", row.id)));
        let Some(secret) = secret else {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "The client secret could not be read. An owner can enter it again in the single sign-on settings.",
            ));
        };
        let said = async {
            let endpoints = self.endpoints_of(protocol, &config).await?;
            let client_id = config.client_id.as_deref().unwrap_or_default();
            let tokens = oauth::exchange(&oauth::Exchange {
                token_url: &endpoints.token,
                basic: endpoints.basic,
                client_id,
                client_secret: &secret,
                code: &a.code,
                redirect_uri: &state.redirect_uri,
                verifier: state.verifier.as_deref().unwrap_or_default(),
            })
            .await?;
            if protocol == SsoProtocol::Oidc {
                let id_token = tokens["id_token"].as_str().ok_or("The identity provider sent no ID token.")?;
                let keys = oauth::keys(endpoints.jwks.as_deref().unwrap_or_default()).await?;
                let claims = oauth::id_token_claims(
                    id_token,
                    &keys,
                    endpoints.issuer.as_deref().unwrap_or_default(),
                    client_id,
                    state.nonce.as_deref().unwrap_or_default(),
                    now_ms() / 1000,
                )?;
                let said = said_by_oidc(&claims, endpoints.issuer.as_deref().unwrap_or_default()).ok_or("The ID token names no one.")?;
                Ok::<_, String>(said)
            } else {
                let access = tokens["access_token"].as_str().ok_or("The identity provider sent no access token.")?;
                let info = oauth::userinfo(endpoints.userinfo.as_deref().unwrap_or_default(), access).await?;
                let subject = match config.subject_claim.as_deref() {
                    Some(path) => oauth::claim(&info, path),
                    None => oauth::claim(&info, "sub").or_else(|| oauth::claim(&info, "id")),
                }
                .ok_or("The userinfo answer has no id for the person: set the subject claim.")?;
                // Plain OAuth 2.0 says nothing of whether an address is theirs.
                let email = oauth::claim(&info, config.email_claim.as_deref().unwrap_or("email"));
                Ok(Said::new(subject, email, false))
            }
        };
        match said.await {
            Ok(said) => self.complete(&row, &state, &slug, &said).await,
            Err(why) => Ok(Outcome::fail(FailureCode::Invalid, why)),
        }
    }

    /// `sso_saml`: see [`SsoSamlArgs`].
    pub async fn sso_saml(&self, a: SsoSamlArgs) -> Result<Outcome<SsoFinished>> {
        let Some(request_id) = saml::in_response_to(&a.saml_response) else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "Start single sign-on from g1t: sign-ins started at the identity provider are not accepted.",
            ));
        };
        let Some((state, row, slug)) = self.spend_state(&request_id, &a.slug).await? else {
            return Ok(Outcome::fail(FailureCode::Invalid, EXPIRED));
        };
        // Only the browser that set off: its binding cookie came back with
        // the response. Otherwise someone could send their own request to
        // another person, whose provider would answer it for them.
        let bound = match (&state.browser, a.binding.as_deref()) {
            (Some(expected), Some(binding)) => crypto::sha256_hex(binding) == *expected,
            _ => false,
        };
        if !bound {
            return Ok(Outcome::fail(FailureCode::Invalid, "This sign-in did not start in this browser. Start again from g1t."));
        }
        let config = row.config();
        let certificates: Vec<Vec<u8>> = config.certificates.iter().filter_map(|der| STANDARD.decode(der).ok()).collect();
        let expect = saml::Expect {
            idp_entity_id: config.idp_entity_id.as_deref().unwrap_or_default(),
            certificates: &certificates,
            acs_url: &state.redirect_uri,
            audience: state.audience.as_deref().unwrap_or_default(),
            request_id: &request_id,
            now_ms: now_ms(),
        };
        match saml::verify_response(&a.saml_response, &expect) {
            // The provider signed the assertion, address and all.
            Ok(asserted) => self.complete(&row, &state, &slug, &Said::new(asserted.subject, asserted.email, true)).await,
            Err(why) => Ok(Outcome::fail(FailureCode::Invalid, why)),
        }
    }

    /// The provider has said who signed in: link them, let them in, and
    /// mark their session. Everything that can refuse is decided before
    /// anything is written, so a refused sign-in leaves no link behind.
    async fn complete(&self, row: &ConnectionRow, state: &StateRow, slug: &str, said: &Said) -> Result<Outcome<SsoFinished>> {
        let slug = slug.trim().to_lowercase();
        let user_id = state.user_id.as_str();
        let subject = said.subject.as_str();
        let Some(person) = self.sso_person(user_id).await? else {
            return Ok(Outcome::fail(FailureCode::Unauthenticated, "Sign in to g1t again."));
        };
        #[derive(Deserialize)]
        struct Linked {
            user_id: String,
            subject: String,
            ids: String,
        }
        let linked = self
            .db
            .prepare("SELECT user_id, subject, ids FROM sso_identities WHERE connection_id = ?1 AND (subject = ?2 OR user_id = ?3)")
            .bind(&[row.id.as_str().into(), subject.into(), user_id.into()])?
            .all()
            .await?
            .results::<Linked>()?;
        if linked.iter().any(|l| l.subject == subject && l.user_id != user_id) {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("That account at {slug}'s identity provider is linked to another g1t account. An owner of {slug} can unlink it."),
            ));
        }
        // Linked under another subject: the same person when another stable
        // id still matches (Entra's object id, after a new app
        // registration); otherwise someone else at the provider.
        if let Some(other) = linked.iter().find(|l| l.user_id == user_id && l.subject != subject) {
            let mut stored: Vec<String> = serde_json::from_str(&other.ids).unwrap_or_default();
            stored.push(other.subject.clone());
            if !same_person(&stored, &said.ids) {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    format!(
                        "Your g1t account is linked to another account at {slug}'s identity provider. Sign in with that one, or ask an owner of {slug} to unlink it."
                    ),
                ));
            }
        }
        // With SCIM on, only someone the provider has assigned, matched
        // without doubt, and not as another g1t account (provisioning.rs).
        let provisioned = match self.scim_on(&row.workspace_id).await? {
            false => None,
            true => match self.provisioned_as(&row.workspace_id, &said.ids, said.trusted_email()).await? {
                provisioning::Match::One(_, Some(other)) if other != user_id => {
                    return Ok(Outcome::fail(
                        FailureCode::Conflict,
                        format!(
                            "That account at {slug}'s identity provider is linked to another g1t account. An owner of {slug} can unlink it."
                        ),
                    ));
                }
                provisioning::Match::One(id, _) => Some(id),
                provisioning::Match::Many => {
                    return Ok(Outcome::fail(
                        FailureCode::Conflict,
                        format!(
                            "More than one person assigned to g1t in {slug}'s identity provider matches your account there. Ask whoever runs it to fix the assignments."
                        ),
                    ));
                }
                provisioning::Match::None => {
                    return Ok(Outcome::fail(
                        FailureCode::Forbidden,
                        format!(
                            "Your account at {slug}'s identity provider is not assigned to g1t. Ask whoever runs it for {slug} to assign you."
                        ),
                    ));
                }
            },
        };
        // Not a member yet: the provider vouches for them, if the workspace
        // lets it and they meet its rules (security.rs), and they have room.
        let member = self.is_member_of(&row.workspace_id, user_id).await?;
        if !member {
            if row.allow_join == 0 {
                return Ok(Outcome::fail(
                    FailureCode::Forbidden,
                    format!("Only members of {slug} sign in through its identity provider. Ask an owner to invite you."),
                ));
            }
            if let Some(why) = join_domain_refusal(&row.config().join_domains, said, &slug) {
                return Ok(Outcome::fail(FailureCode::Forbidden, why));
            }
            if let Some(why) = self.policy_refusal(user_id, &slug).await? {
                return Ok(Outcome::fail(FailureCode::Forbidden, why));
            }
            if let Some(refused) = self.plan_refusal(&slug, plan_needed(&slug)).await? {
                return Ok(refused);
            }
            if self.memberships(user_id).await?.len() >= crate::workspaces::MAX_WORKSPACES_PER_USER {
                return Ok(Outcome::fail(FailureCode::Conflict, "You belong to the maximum number of workspaces."));
            }
        }
        // Refusals done: write.
        let now = rfc3339(now_ms());
        let email_value = said.email.as_deref().map_or(JsValue::NULL, Into::into);
        let ids = serde_json::to_string(&said.ids).unwrap_or_else(|_| "[]".to_owned());
        let trusted = said.trusted_email().map_or(JsValue::NULL, Into::into);
        if linked.is_empty() {
            self.db
                .prepare(
                    "INSERT INTO sso_identities (connection_id, user_id, subject, email, ids, trusted_email, created_at, last_used_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&[
                    row.id.as_str().into(),
                    user_id.into(),
                    subject.into(),
                    email_value,
                    ids.as_str().into(),
                    trusted,
                    now.as_str().into(),
                    now.as_str().into(),
                ])?
                .run()
                .await?;
            self.audit_workspace(
                &person,
                "sso.identity_linked",
                &slug,
                Surface::Web,
                format!("Linked to {subject} at the single sign-on provider"),
            )
            .await;
        } else {
            self.db
                .prepare(
                    "UPDATE sso_identities SET subject = ?, ids = ?, trusted_email = ?, last_used_at = ?, email = COALESCE(?, email)
                     WHERE connection_id = ? AND user_id = ?",
                )
                .bind(&[
                    subject.into(),
                    ids.as_str().into(),
                    trusted,
                    now.as_str().into(),
                    email_value,
                    row.id.as_str().into(),
                    user_id.into(),
                ])?
                .run()
                .await?;
        }
        if let Some(id) = &provisioned {
            self.db
                .prepare("UPDATE scim_users SET user_id = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
                .bind(&[user_id.into(), now.as_str().into(), id.as_str().into(), row.workspace_id.as_str().into()])?
                .run()
                .await?;
        }
        // With SCIM, only while the assignment is still active: a
        // deprovisioning that lands mid-sign-in wins.
        let still_assigned = "(?4 IS NULL OR EXISTS (SELECT 1 FROM scim_users WHERE id = ?4 AND active = 1))";
        let assignment = provisioned.as_deref().map_or(JsValue::NULL, Into::into);
        let mut joined = false;
        if !member {
            joined = self
                .db
                .prepare(format!(
                    "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
                     SELECT ?1, ?2, 'member', ?3 WHERE {still_assigned} RETURNING user_id"
                ))
                .bind(&[row.workspace_id.as_str().into(), user_id.into(), now.as_str().into(), assignment.clone()])?
                .first::<Value>(None)
                .await?
                .is_some();
            if joined {
                self.audit_workspace(&person, "member.joined_by_sso", &slug, Surface::Web, "Joined through single sign-on".to_owned())
                    .await;
                self.announce_member_joined(&row.workspace_id, &slug, &person, Role::Member, JoinedHow::Joined).await;
            }
        }
        // The session counts as signed in through the provider, while it lasts.
        let counted = self
            .db
            .prepare(format!(
                "INSERT INTO sso_sessions (session_id, workspace_id, expires_at)
                 SELECT ?1, ?2, {} WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?1 AND user_id = ?3 AND expires_at > {SQL_NOW}) AND {still_assigned}
                 ON CONFLICT (session_id, workspace_id) DO UPDATE SET expires_at = excluded.expires_at RETURNING session_id",
                sql_after(SSO_SESSION_SECONDS)
            ))
            .bind(&[state.session_id.as_str().into(), row.workspace_id.as_str().into(), user_id.into(), assignment])?
            .first::<Value>(None)
            .await?
            .is_some();
        if !counted {
            // Unassigned while signing in, or the g1t session ended.
            return Ok(match provisioned {
                Some(_) => Outcome::fail(
                    FailureCode::Forbidden,
                    format!(
                        "Your account at {slug}'s identity provider is not assigned to g1t. Ask whoever runs it for {slug} to assign you."
                    ),
                ),
                None => Outcome::fail(FailureCode::Unauthenticated, "Sign in to g1t again."),
            });
        }
        let first = self
            .db
            .prepare("UPDATE sso_connections SET tested_at = ?, tested_by = ? WHERE id = ? AND tested_at IS NULL RETURNING id")
            .bind(&[now.as_str().into(), user_id.into(), row.id.as_str().into()])?
            .first::<Value>(None)
            .await?
            .is_some();
        Ok(Outcome::Ok(SsoFinished { slug, next: state.next.clone(), joined, first }))
    }

    async fn sso_person(&self, user_id: &str) -> Result<Option<User>> {
        #[derive(Deserialize)]
        struct Person {
            id: String,
            username: String,
            display_username: Option<String>,
            verified: u8,
        }
        Ok(self
            .db
            .prepare("SELECT id, username, display_username, email_verified_at IS NOT NULL AS verified FROM users WHERE id = ? AND deleted_at IS NULL")
            .bind(&[user_id.into()])?
            .first::<Person>(None)
            .await?
            .map(|p| User { id: p.id, username: p.username, display_username: p.display_username, verified: p.verified != 0, ..User::default() }))
    }

    /// The workspaces of `required` (slugs, with the person's role) whose
    /// single sign-on holds the person out, for how they came in (`via`):
    /// a session counts once it went through the provider in the last day,
    /// a token or key once they have linked, and a password never (it is
    /// what single sign-on stands in for). Where SCIM is on, they must also
    /// still be assigned.
    pub async fn sso_holds(&self, user: &User, required: Vec<(String, Role)>, via: Via<'_>) -> Result<Vec<String>> {
        // g1t's own agent is never held: it is no one's to sign in.
        if required.iter().all(|(_, role)| *role == Role::Owner) || crate::paid::is_g1t(&user.username) {
            return Ok(Vec::new());
        }
        #[derive(Deserialize)]
        struct Slug {
            slug: String,
        }
        // Where SCIM is on, only while the provider still has them assigned.
        const ASSIGNED: &str = "(NOT EXISTS (SELECT 1 FROM scim_tokens t WHERE t.workspace_id = w.id)
             OR EXISTS (SELECT 1 FROM scim_users u WHERE u.workspace_id = w.id AND u.user_id = ?2 AND u.active = 1))";
        let met = match via {
            Via::Password => return Ok(held_by_sso(&required, &HashSet::new())),
            Via::Session(session) => {
                self.db
                    .prepare(format!(
                        "SELECT w.slug FROM sso_sessions s JOIN workspaces w ON w.id = s.workspace_id
                         WHERE s.session_id = ?1 AND s.expires_at > {SQL_NOW} AND {ASSIGNED}"
                    ))
                    .bind(&[session.into(), user.id.as_str().into()])?
                    .all()
                    .await?
            }
            Via::Credential => {
                self.db
                    .prepare(format!(
                        "SELECT w.slug FROM sso_identities i JOIN sso_connections c ON c.id = i.connection_id
                         JOIN workspaces w ON w.id = c.workspace_id WHERE i.user_id = ?1 AND {ASSIGNED}"
                    ))
                    .bind(&[user.id.as_str().into(), user.id.as_str().into()])?
                    .all()
                    .await?
            }
        };
        let met: HashSet<String> = met.results::<Slug>()?.into_iter().map(|row| row.slug).collect();
        Ok(held_by_sso(&required, &met))
    }

    /// `sso_metadata`: g1t's SAML metadata for a workspace's provider.
    pub fn sso_metadata(&self, a: SsoMetadataArgs) -> String {
        saml::metadata(&a.entity_id, &a.acs_url)
    }

    /// Forgets which workspaces' providers a session went through, when it ends.
    pub async fn forget_sso_session(&self, session_hash: &str) -> Result<()> {
        self.db.prepare("DELETE FROM sso_sessions WHERE session_id = ?").bind(&[session_hash.into()])?.run().await?;
        Ok(())
    }
}

fn protocol_name(protocol: SsoProtocol) -> &'static str {
    match protocol {
        SsoProtocol::Oidc => "OpenID Connect",
        SsoProtocol::Oauth2 => "OAuth 2.0",
        SsoProtocol::Saml => "SAML",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::access::{RepoGrant, RepoRole};

    #[test]
    fn owners_are_never_held_and_a_met_workspace_is_let_in() {
        let required = vec![("acme".to_owned(), Role::Member), ("globex".to_owned(), Role::Owner), ("initech".to_owned(), Role::Member)];
        let met: HashSet<String> = ["initech".to_owned()].into();
        assert_eq!(held_by_sso(&required, &met), vec!["acme".to_owned()]);
        assert!(held_by_sso(&required, &["acme".to_owned(), "initech".to_owned()].into()).is_empty());
    }

    #[test]
    fn a_held_workspace_takes_its_repositories_with_it() {
        let mut user = User {
            id: "usr_1".into(),
            username: "ada".into(),
            workspaces: vec![Membership::member("acme"), Membership::member("globex")],
            grants: vec![
                RepoGrant { repo_id: "rep_1".into(), workspace: "acme".into(), role: RepoRole::Admin, team: None },
                RepoGrant { repo_id: "rep_2".into(), workspace: "globex".into(), role: RepoRole::Write, team: None },
            ],
            ..User::default()
        };
        apply_sso_holds(&mut user, &["acme".to_owned()]);
        assert_eq!(user.workspaces.iter().map(|m| m.slug.as_str()).collect::<Vec<_>>(), vec!["globex"]);
        assert_eq!(user.grants.iter().map(|g| g.repo_id.as_str()).collect::<Vec<_>>(), vec!["rep_2"]);
        assert_eq!(user.held.len(), 1);
        assert_eq!(user.held[0].gap, "sso");
        assert!(user.held[0].reason.contains("acme requires single sign-on"));
    }

    #[test]
    fn each_protocol_keeps_only_its_own_fields() {
        let given = SsoConfig {
            issuer: Some(" https://acme.okta.com ".into()),
            client_id: Some("client".into()),
            authorization_url: Some("https://elsewhere.test/authorize".into()),
            ..SsoConfig::default()
        };
        let oidc = checked_config(SsoProtocol::Oidc, &given, vec![]).unwrap();
        assert_eq!(oidc.issuer.as_deref(), Some("https://acme.okta.com"));
        assert_eq!(oidc.authorization_url, None);
        assert!(checked_config(SsoProtocol::Oauth2, &given, vec![]).unwrap_err().contains("token URL"));
        let plain = SsoConfig { issuer: Some("http://acme.test".into()), client_id: Some("c".into()), ..SsoConfig::default() };
        assert!(checked_config(SsoProtocol::Oidc, &plain, vec![]).unwrap_err().contains("https"));
        let saml = SsoConfig {
            idp_entity_id: Some("http://idp/entity".into()),
            idp_sso_url: Some("https://idp/sso".into()),
            ..SsoConfig::default()
        };
        assert!(checked_config(SsoProtocol::Saml, &saml, vec![]).unwrap_err().contains("certificate"));
        assert_eq!(checked_config(SsoProtocol::Saml, &saml, vec!["AAAA".into()]).unwrap().certificates, vec!["AAAA".to_owned()]);
    }

    #[test]
    fn only_a_trusted_address_at_a_named_domain_joins() {
        let domains = vec!["acme.com".to_owned()];
        let trusted = Said::new("u1".into(), Some("Ada@Acme.com".into()), true);
        assert_eq!(join_domain_refusal(&domains, &trusted, "acme"), None);
        let untrusted = Said::new("u1".into(), Some("ada@acme.com".into()), false);
        assert!(join_domain_refusal(&domains, &untrusted, "acme").is_some());
        let elsewhere = Said::new("u1".into(), Some("ada@gmail.com".into()), true);
        assert!(join_domain_refusal(&domains, &elsewhere, "acme").unwrap().contains("acme.com"));
        assert_eq!(join_domain_refusal(&[], &elsewhere, "acme"), None);
        assert_eq!(domains_from(&["@Acme.com, globex.io".to_owned()]).unwrap(), vec!["acme.com".to_owned(), "globex.io".to_owned()]);
        assert!(domains_from(&["not a domain!".to_owned()]).is_err());
    }

    #[test]
    fn an_address_shaped_subject_is_lowercased() {
        assert_eq!(Said::new(" Ada@Acme.COM ".into(), None, true).subject, "ada@acme.com");
        assert_eq!(Said::new("00uAbC".into(), None, true).subject, "00uAbC");
    }

    #[test]
    fn entra_gives_its_object_id_and_a_members_principal_name() {
        let claims = serde_json::json!({ "sub": "pairwise", "oid": "11111111-2222", "preferred_username": "Ada@Contoso.com", "email": "ada@contoso.com" });
        let said = said_by_oidc(&claims, "https://login.microsoftonline.com/tid/v2.0").unwrap();
        // The object id, never the mutable principal name.
        assert_eq!(said.ids, vec!["pairwise".to_owned(), "11111111-2222".to_owned()]);
        // Entra sends no email_verified: its address is never trusted.
        assert_eq!(said.trusted_email(), None);
        // A new app registration: another pairwise subject, the same object id.
        assert!(same_person(&["old-pairwise".to_owned(), "11111111-2222".to_owned()], &said.ids));
        assert!(!same_person(&["old-pairwise".to_owned()], &said.ids));
        let stringly = serde_json::json!({ "sub": "1", "email": "a@b.co", "email_verified": "true" });
        assert_eq!(said_by_oidc(&stringly, "https://idp.test").unwrap().trusted_email(), Some("a@b.co"));
        let okta = serde_json::json!({ "sub": "00u1", "oid": "x", "email": "ada@acme.com", "email_verified": true });
        let said = said_by_oidc(&okta, "https://acme.okta.com").unwrap();
        assert_eq!(said.ids, vec!["00u1".to_owned()]);
        assert_eq!(said.trusted_email(), Some("ada@acme.com"));
    }

    #[test]
    fn another_provider_is_told_apart_from_a_changed_setting() {
        let a = SsoConfig { issuer: Some("https://acme.okta.com/".into()), client_id: Some("one".into()), ..SsoConfig::default() };
        let b = SsoConfig { issuer: Some("https://acme.okta.com".into()), client_id: Some("two".into()), ..SsoConfig::default() };
        assert_eq!(provider_of(SsoProtocol::Oidc, &a), provider_of(SsoProtocol::Oidc, &b));
        let c = SsoConfig { issuer: Some("https://globex.okta.com".into()), ..SsoConfig::default() };
        assert_ne!(provider_of(SsoProtocol::Oidc, &a), provider_of(SsoProtocol::Oidc, &c));
        assert_ne!(provider_of(SsoProtocol::Oidc, &a), provider_of(SsoProtocol::Saml, &a));
    }
}
