//! Single sign-on: a workspace's own identity provider, over OpenID
//! Connect, OAuth 2.0 or SAML 2.0. On every paid plan; a free workspace
//! sees it and cannot set it up. Mirrors `packages/contracts/src/sso.ts`.
//!
//! It never signs anyone in to g1t. A person signs in to g1t as
//! themselves, then proves themselves to the workspace's provider to use
//! the workspace, the first time linking who they are there to their g1t
//! account. A workspace can require it of its members: then a member uses
//! it only from a session that went through its provider in the last
//! day, and an access token of theirs only once they have linked. Owners
//! are never held out, so a provider that breaks never locks a workspace
//! out of itself.
//!
//! The identity service (`POST /rpc/<method>`):
//!
//! - `sso_settings` takes `SsoSettingsArgs`, returns `Outcome<SsoSettings>`.
//! - `save_sso` takes `SaveSsoArgs`, returns `Outcome<SsoSettings>`.
//! - `set_sso_required` takes `SetSsoRequiredArgs`, returns `Outcome<bool>`.
//! - `delete_sso` takes `SsoSettingsArgs`, returns `Outcome<bool>`.
//! - `unlink_sso_identity` takes `UnlinkSsoIdentityArgs`, returns `Outcome<bool>`.
//! - `sso_start` takes `SsoStartArgs`, returns `Outcome<SsoStart>`.
//! - `sso_finish` takes `SsoFinishArgs`, returns `Outcome<SsoFinished>`.
//! - `sso_saml` takes `SsoSamlArgs`, returns `Outcome<SsoFinished>`.
//! - `sso_summary` takes `SlugArgs`, returns `SsoSummary`.
//! - `sso_metadata` takes `SsoMetadataArgs`, returns the XML as a string.

use serde::{Deserialize, Serialize};

use crate::User;
use crate::audit::Surface;

/// How a workspace's provider is spoken to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SsoProtocol {
    /// OpenID Connect: an issuer whose discovery document says the rest.
    Oidc,
    /// Plain OAuth 2.0: authorize, token and userinfo endpoints, and which
    /// claims of the userinfo answer are the person's id and address.
    Oauth2,
    /// SAML 2.0: the provider's entity id, sign-in URL and certificates.
    Saml,
}

impl SsoProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            SsoProtocol::Oidc => "oidc",
            SsoProtocol::Oauth2 => "oauth2",
            SsoProtocol::Saml => "saml",
        }
    }

    pub fn parse(text: &str) -> Option<SsoProtocol> {
        match text {
            "oidc" => Some(SsoProtocol::Oidc),
            "oauth2" => Some(SsoProtocol::Oauth2),
            "saml" => Some(SsoProtocol::Saml),
            _ => None,
        }
    }
}

/// What a connection needs, by protocol; the fields of the others are
/// absent. Stored as JSON, and shown to owners as it is: it holds no
/// secret.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SsoConfig {
    /// OpenID Connect: the issuer, such as `https://acme.okta.com`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    /// OpenID Connect and OAuth 2.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// Space-separated. OpenID Connect always asks for `openid`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scopes: Option<String>,
    /// OAuth 2.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub userinfo_url: Option<String>,
    /// The userinfo claim that is the person's stable id; `sub` when
    /// absent, then `id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject_claim: Option<String>,
    /// The userinfo claim that is their address; `email` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email_claim: Option<String>,
    /// SAML: the provider's entity id (its issuer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idp_entity_id: Option<String>,
    /// SAML: where its single sign-on service takes requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idp_sso_url: Option<String>,
    /// SAML: its signing certificates, base64 DER; more than one while a
    /// certificate is rotated.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub certificates: Vec<String>,
}

/// A SAML signing certificate, as shown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SsoCertificate {
    /// SHA-256, `AB:CD:…`, as providers show it.
    pub fingerprint: String,
}

/// A workspace's connection to its provider, as its owners see it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SsoConnection {
    pub id: String,
    pub protocol: SsoProtocol,
    pub config: SsoConfig,
    /// Whether a client secret is kept; it is never shown.
    pub has_client_secret: bool,
    pub certificates: Vec<SsoCertificate>,
    /// Whether anyone the provider signs in may join as a member.
    pub allow_join: bool,
    /// When someone first signed in through it, and who (a username).
    pub tested_at: Option<String>,
    pub tested_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Someone linked to who they are at the workspace's provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SsoIdentity {
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_username: Option<String>,
    /// The provider's id for them.
    pub subject: String,
    /// The address the provider gave, for showing.
    pub email: Option<String>,
    pub linked_at: String,
    pub last_used_at: String,
}

/// A workspace's single sign-on, for its settings page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SsoSettings {
    pub slug: String,
    pub connection: Option<SsoConnection>,
    /// Whether members must sign in through it.
    pub required: bool,
    /// Whether the person asking has signed in through it: an owner must
    /// before requiring it.
    pub you_linked: bool,
    pub identities: Vec<SsoIdentity>,
}

/// Whether a workspace has single sign-on, for anyone: the sign-in page
/// and the notice for someone it holds out.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SsoSummary {
    pub enabled: bool,
    pub protocol: Option<SsoProtocol>,
    pub required: bool,
    pub allow_join: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SsoSettingsArgs {
    pub actor: User,
    pub slug: String,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// `save_sso`: sets up or changes the workspace's connection. Owners only,
/// on a paid plan. A secret or certificate left empty keeps the one saved.
/// Changing which provider it is (protocol, issuer, entity id) unlinks
/// everyone, stops requiring it, and needs a sign-in through it again.
#[derive(Debug, Serialize, Deserialize)]
pub struct SaveSsoArgs {
    pub actor: User,
    pub slug: String,
    pub protocol: SsoProtocol,
    #[serde(default)]
    pub config: SsoConfig,
    #[serde(default)]
    pub client_secret: Option<String>,
    /// SAML: certificates as pasted (PEM).
    #[serde(default)]
    pub certificate: Option<String>,
    #[serde(default = "yes")]
    pub allow_join: bool,
    #[serde(default)]
    pub surface: Option<Surface>,
}

fn yes() -> bool {
    true
}

/// `set_sso_required`: whether members must sign in through the provider.
/// Turning it on needs a paid plan and the owner to have signed in through
/// it themselves; turning it off never does.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetSsoRequiredArgs {
    pub actor: User,
    pub slug: String,
    pub required: bool,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// `unlink_sso_identity`: forgets who someone is at the provider, so they
/// link again (or another person can) the next time. Owners only.
#[derive(Debug, Serialize, Deserialize)]
pub struct UnlinkSsoIdentityArgs {
    pub actor: User,
    pub slug: String,
    pub username: String,
    #[serde(default)]
    pub surface: Option<Surface>,
}

/// `sso_start`: the signed-in person sets off to the workspace's provider.
#[derive(Debug, Serialize, Deserialize)]
pub struct SsoStartArgs {
    pub user: User,
    /// The session it is for: what comes back counts for it alone.
    pub session_token: String,
    pub slug: String,
    /// The callback (OpenID Connect, OAuth 2.0) or assertion consumer
    /// service (SAML), exactly as registered with the provider.
    pub redirect_uri: String,
    /// SAML: g1t's entity id for the workspace.
    #[serde(default)]
    pub entity_id: Option<String>,
    /// A same-site path to return to.
    #[serde(default)]
    pub next: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SsoStart {
    /// Where to send the browser.
    pub url: String,
    /// OpenID Connect and OAuth 2.0: the state, for a cookie that binds
    /// the trip to this browser. Absent for SAML, whose response is posted
    /// cross-site, without cookies; its request id binds it instead.
    pub state: Option<String>,
}

/// `sso_finish`: the provider sent the browser back with a code.
#[derive(Debug, Serialize, Deserialize)]
pub struct SsoFinishArgs {
    pub slug: String,
    pub session_token: String,
    pub state: String,
    pub code: String,
}

/// `sso_saml`: the provider posted its response.
#[derive(Debug, Serialize, Deserialize)]
pub struct SsoSamlArgs {
    pub slug: String,
    pub saml_response: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SsoFinished {
    pub slug: String,
    pub next: String,
    /// Whether they joined the workspace just now.
    pub joined: bool,
    /// Whether this was the first sign-in through the connection, which
    /// marks it tested.
    pub first: bool,
}

/// `sso_metadata`: g1t's SAML service provider metadata for a workspace.
#[derive(Debug, Serialize, Deserialize)]
pub struct SsoMetadataArgs {
    pub entity_id: String,
    pub acs_url: String,
}
