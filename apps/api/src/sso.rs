//! A workspace's single sign-on, over REST and MCP: its connection to the
//! workspace's identity provider (OpenID Connect, OAuth 2.0 or SAML 2.0),
//! requiring it of members, the people linked to it, and unlinking one.
//! Identity decides and keeps all of it (services/identity/src/sso.rs);
//! owners only, as people, and setting it up needs a paid plan. Signing in
//! through it is a browser's trip to the provider, so it is not here.

use g1t_contracts::sso::{ScimToken, SsoConfig, SsoConnection, SsoProtocol, SsoSettings, sso_addresses};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::operations::Services;

/// One operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SsoOp {
    GetSso,
    ConfigureSso,
    SetSsoRequired,
    DeleteSso,
    ListSsoIdentities,
    UnlinkSsoIdentity,
    EnableScim,
    DisableScim,
}

/// The config fields an owner sends, as `SsoConfig` names them.
const CONFIG_FIELDS: [&str; 10] = [
    "issuer",
    "client_id",
    "scopes",
    "authorization_url",
    "token_url",
    "userinfo_url",
    "subject_claim",
    "email_claim",
    "idp_entity_id",
    "idp_sso_url",
];

impl SsoOp {
    /// Every one: `Op::ALL` lists each as `Op::Sso(…)`, which a test checks
    /// against this.
    #[cfg(test)]
    pub const ALL: [SsoOp; 8] = [
        SsoOp::GetSso,
        SsoOp::ConfigureSso,
        SsoOp::SetSsoRequired,
        SsoOp::DeleteSso,
        SsoOp::ListSsoIdentities,
        SsoOp::UnlinkSsoIdentity,
        SsoOp::EnableScim,
        SsoOp::DisableScim,
    ];

    pub fn name(self) -> &'static str {
        match self {
            SsoOp::GetSso => "get_sso",
            SsoOp::ConfigureSso => "configure_sso",
            SsoOp::SetSsoRequired => "set_sso_required",
            SsoOp::DeleteSso => "delete_sso",
            SsoOp::ListSsoIdentities => "list_sso_identities",
            SsoOp::UnlinkSsoIdentity => "unlink_sso_identity",
            SsoOp::EnableScim => "enable_scim",
            SsoOp::DisableScim => "disable_scim",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            SsoOp::GetSso => "Get a workspace's single sign-on",
            SsoOp::ConfigureSso => "Set up or change a workspace's single sign-on",
            SsoOp::SetSsoRequired => "Require single sign-on, or stop",
            SsoOp::DeleteSso => "Remove a workspace's single sign-on",
            SsoOp::ListSsoIdentities => "List the people linked through single sign-on",
            SsoOp::UnlinkSsoIdentity => "Unlink someone from single sign-on",
            SsoOp::EnableScim => "Turn on SCIM, or make a new SCIM token",
            SsoOp::DisableScim => "Turn off SCIM",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            SsoOp::GetSso => "A workspace's single sign-on through its own identity provider: connection (null when it has none: its id, protocol oidc, oauth2 or saml, config with the protocol's fields, has_client_secret, certificates by SHA-256 fingerprint for SAML, allow_join, tested_at and tested_by, when the first person signed in through it), required (whether members must sign in through it), you_linked (whether you have), identities (the people linked: username, subject and email at the provider, linked_at, last_used_at), and service_provider: the addresses to give the provider (redirect_uri for OpenID Connect and OAuth 2.0; entity_id, acs_url and metadata_url for SAML; sign_in_url, where people start). The client secret is never returned. Owners only, as people.",
            SsoOp::ConfigureSso => "Set up the workspace's single sign-on, or change it; a field left out keeps what is saved for the same protocol. oidc: issuer (read for its discovery document first), client_id, client_secret, scopes (openid email profile by default). oauth2: authorization_url, token_url, userinfo_url, client_id, client_secret, scopes, subject_claim (sub, then id, by default) and email_claim (email). saml: idp_entity_id, idp_sso_url and certificate (the provider's signing certificates, PEM; several while rotating). client_secret and certificate left out keep what is saved. allow_join (false by default) lets anyone the provider signs in join as a member; join_domains limits that to addresses the provider vouches for at those domains. Moving to another provider (protocol, issuer or entity id) unlinks everyone and stops requiring it. Needs a paid plan. Returns what get_sso does. Recorded as sso.created or sso.updated. Owners only, as people.",
            SsoOp::SetSsoRequired => "Whether members must sign in through the provider: then a member uses the workspace only from a session that did in the last day, and with tokens and keys once linked; held out otherwise, keeping their place. Owners are never held, and outside collaborators are not asked. Requiring it needs a paid plan and you to have signed in through it yourself (you_linked); stopping never does. Recorded as sso.required or sso.not_required. Owners only, as people.",
            SsoOp::DeleteSso => "Remove the workspace's single sign-on: forgets the provider and who everyone is there, and stops requiring it. Members keep their place. Never needs a plan. Recorded as sso.deleted. Owners only, as people.",
            SsoOp::ListSsoIdentities => "The people linked to the workspace's provider: username, subject (their id at the provider), email (as the provider gave it, for showing), linked_at and last_used_at. Owners only, as people.",
            SsoOp::EnableScim => "Turn on SCIM for the workspace's single sign-on, or replace its token: returns token (shown this once; the old one stops working), hint (its last four characters) and scim_url, the SCIM 2.0 base URL to give the identity provider with the token as a bearer token. With SCIM on, only people the provider has assigned (active users) can sign in through single sign-on, and one it deactivates or deletes leaves the workspace at once: membership, roles, link and sessions. Owners are never removed that way. Users only; groups are not kept. Needs single sign-on set up and a paid plan. Recorded as sso.scim_enabled or sso.scim_token_rotated. Owners only, as people.",
            SsoOp::DisableScim => "Turn off SCIM: the token stops working and the provisioned users are forgotten. Nobody is removed from the workspace, and single sign-on lets people in as before. Recorded as sso.scim_disabled. Owners only, as people.",
            SsoOp::UnlinkSsoIdentity => "Forget who someone is at the workspace's provider, so they (or another account there) link again on their next sign-in through it; their sessions go through it again. Recorded as sso.identity_unlinked. Owners only, as people.",
        }
    }

    /// Whether it changes anything: checked against the scope table in tests.
    #[cfg(test)]
    pub fn writes(self) -> bool {
        !matches!(self, SsoOp::GetSso | SsoOp::ListSsoIdentities)
    }

    pub fn input(self) -> Value {
        let workspace = json!({ "type": "string", "description": "The workspace's name, e.g. \"acme\"." });
        let (properties, required): (Value, &[&str]) = match self {
            SsoOp::GetSso | SsoOp::DeleteSso | SsoOp::ListSsoIdentities | SsoOp::EnableScim | SsoOp::DisableScim => (json!({ "workspace": workspace }), &["workspace"]),
            SsoOp::ConfigureSso => (
                json!({
                    "workspace": workspace,
                    "protocol": { "type": "string", "enum": ["oidc", "oauth2", "saml"], "description": "How g1t speaks to the provider." },
                    "issuer": { "type": "string", "description": "oidc: the issuer, where its /.well-known/openid-configuration lives." },
                    "client_id": { "type": "string", "description": "oidc, oauth2: the client id." },
                    "client_secret": { "type": "string", "description": "oidc, oauth2: the client secret; kept encrypted, never returned. Left out keeps the one saved." },
                    "scopes": { "type": "string", "description": "oidc, oauth2: space-separated scopes." },
                    "authorization_url": { "type": "string", "description": "oauth2: the authorization endpoint (https)." },
                    "token_url": { "type": "string", "description": "oauth2: the token endpoint (https)." },
                    "userinfo_url": { "type": "string", "description": "oauth2: the userinfo endpoint (https)." },
                    "subject_claim": { "type": "string", "description": "oauth2: the userinfo claim that is the person's stable id; a dotted path works." },
                    "email_claim": { "type": "string", "description": "oauth2: the userinfo claim that is their address." },
                    "idp_entity_id": { "type": "string", "description": "saml: the provider's entity id (its issuer)." },
                    "idp_sso_url": { "type": "string", "description": "saml: where the provider takes requests (HTTP-Redirect, https)." },
                    "certificate": { "type": "string", "description": "saml: the provider's signing certificates, PEM. Left out keeps the ones saved." },
                    "allow_join": { "type": "boolean", "description": "Anyone the provider signs in joins as a member when they first sign in through it. False by default; leave it off for a provider anyone can sign in to." },
                    "join_domains": { "type": "array", "items": { "type": "string" }, "description": "When joining is on, only people whose address the provider vouches for (OpenID's email_verified, or a signed SAML assertion) is at one of these domains, such as [\"acme.com\"]. Empty: anyone it signs in." },
                }),
                &["workspace", "protocol"],
            ),
            SsoOp::SetSsoRequired => (
                json!({
                    "workspace": workspace,
                    "required": { "type": "boolean", "description": "True to require it of members; false to stop." },
                }),
                &["workspace", "required"],
            ),
            SsoOp::UnlinkSsoIdentity => (
                json!({
                    "workspace": workspace,
                    "username": { "type": "string", "description": "Whose link to forget." },
                }),
                &["workspace", "username"],
            ),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

fn text(input: &Value, key: &str) -> Option<String> {
    match &input[key] {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
        _ => None,
    }
}

fn flag(input: &Value, key: &str) -> Option<bool> {
    match &input[key] {
        Value::Bool(value) => Some(*value),
        Value::String(text) => match text.trim() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// The protocol's fields as sent: the config, its secret and certificate.
fn config_of(input: &Value) -> SsoConfig {
    let mut config = json!({});
    for field in CONFIG_FIELDS {
        if let Some(value) = text(input, field) {
            config[field] = json!(value);
        }
    }
    // A list, or one comma-separated string.
    let domains: Vec<String> = match &input["join_domains"] {
        Value::Array(items) => items.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        Value::String(text) => text.split(',').map(str::to_owned).collect(),
        _ => Vec::new(),
    };
    config["join_domains"] = json!(domains);
    serde_json::from_value(config).unwrap_or_default()
}

/// The settings, with where to point the provider.
fn with_addresses(settings: SsoSettings, site: &str, api: &str) -> Value {
    let addresses = sso_addresses(site, &settings.workspace_id, &settings.slug);
    let mut out = serde_json::to_value(&settings).unwrap_or_default();
    out["service_provider"] = serde_json::to_value(addresses).unwrap_or_default();
    out["service_provider"]["scim_url"] = json!(scim_url(api, &settings.workspace_id));
    out
}

/// The SCIM 2.0 base URL for a workspace, by its id, which a rename never
/// changes (scim.rs).
fn scim_url(api: &str, workspace_id: &str) -> String {
    format!("{}/scim/v2/{}", api.trim_end_matches('/'), workspace_id)
}

/// What `configure_sso` was sent, over what is saved for the same protocol:
/// a field left out keeps its value, so changing one thing (a rotated
/// secret) changes nothing else.
fn merged(input: &Value, saved: Option<&SsoConnection>, protocol: SsoProtocol) -> (SsoConfig, bool) {
    let mut config = config_of(input);
    let same = saved.filter(|saved| saved.protocol == protocol);
    if let Some(saved) = same {
        let kept = &saved.config;
        // Left out, or sent as null (some clients send every parameter).
        let absent = |field: &str| input.get(field).is_none_or(Value::is_null);
        let keep = |sent: &mut Option<String>, kept: &Option<String>, field: &str| {
            if absent(field) {
                *sent = kept.clone();
            }
        };
        keep(&mut config.issuer, &kept.issuer, "issuer");
        keep(&mut config.client_id, &kept.client_id, "client_id");
        keep(&mut config.scopes, &kept.scopes, "scopes");
        keep(&mut config.authorization_url, &kept.authorization_url, "authorization_url");
        keep(&mut config.token_url, &kept.token_url, "token_url");
        keep(&mut config.userinfo_url, &kept.userinfo_url, "userinfo_url");
        keep(&mut config.subject_claim, &kept.subject_claim, "subject_claim");
        keep(&mut config.email_claim, &kept.email_claim, "email_claim");
        keep(&mut config.idp_entity_id, &kept.idp_entity_id, "idp_entity_id");
        keep(&mut config.idp_sso_url, &kept.idp_sso_url, "idp_sso_url");
        if absent("join_domains") {
            config.join_domains = kept.join_domains.clone();
        }
    }
    let allow_join = flag(input, "allow_join").unwrap_or_else(|| same.is_some_and(|saved| saved.allow_join));
    (config, allow_join)
}

pub async fn run(op: SsoOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let Some(actor) = viewer.clone() else {
        return Ok(Outcome::fail(FailureCode::Unauthenticated, "This needs a g1t access token."));
    };
    let Some(workspace) = text(input, "workspace").map(|w| w.to_lowercase()) else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Name the workspace."));
    };
    let identity = &services.identity;
    let surface = services.audit.surface;
    let site = services.addresses.site.as_str();
    let api = services.addresses.api.as_str();
    let settings = |outcome: Outcome<SsoSettings>| match outcome {
        Outcome::Ok(settings) => Outcome::Ok(with_addresses(settings, site, api)),
        Outcome::Fail(failure) => Outcome::Fail(failure),
    };
    Ok(match op {
        SsoOp::GetSso => settings(g1t_kit::call(identity, "sso_settings", &json!({ "actor": actor, "slug": workspace })).await?),
        SsoOp::ListSsoIdentities => {
            let found: Outcome<SsoSettings> = g1t_kit::call(identity, "sso_settings", &json!({ "actor": actor, "slug": workspace })).await?;
            match found {
                Outcome::Ok(found) => Outcome::Ok(serde_json::to_value(found.identities).unwrap_or_default()),
                Outcome::Fail(failure) => Outcome::Fail(failure),
            }
        }
        SsoOp::ConfigureSso => {
            let Some(protocol) = text(input, "protocol").as_deref().and_then(SsoProtocol::parse) else {
                return Ok(Outcome::fail(FailureCode::Invalid, "protocol is oidc, oauth2 or saml."));
            };
            if input.get("allow_join").is_some_and(|v| !v.is_null()) && flag(input, "allow_join").is_none() {
                return Ok(Outcome::fail(FailureCode::Invalid, "allow_join is true or false."));
            }
            let before: Outcome<SsoSettings> = g1t_kit::call(identity, "sso_settings", &json!({ "actor": actor, "slug": workspace })).await?;
            let before = match before {
                Outcome::Ok(before) => before,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            };
            let (config, allow_join) = merged(input, before.connection.as_ref(), protocol);
            let saved: Outcome<SsoSettings> = g1t_kit::call(
                identity,
                "save_sso",
                &json!({
                    "actor": actor,
                    "slug": workspace,
                    "protocol": protocol,
                    "config": config,
                    "client_secret": text(input, "client_secret"),
                    "certificate": text(input, "certificate"),
                    "allow_join": allow_join,
                    "surface": surface,
                }),
            )
            .await?;
            settings(saved)
        }
        SsoOp::SetSsoRequired => {
            let Some(required) = flag(input, "required") else {
                return Ok(Outcome::fail(FailureCode::Invalid, "required is true or false."));
            };
            let set: Outcome<bool> = g1t_kit::call(
                identity,
                "set_sso_required",
                &json!({ "actor": actor, "slug": workspace, "required": required, "surface": surface }),
            )
            .await?;
            match set {
                Outcome::Ok(required) => Outcome::Ok(json!({ "required": required })),
                Outcome::Fail(failure) => Outcome::Fail(failure),
            }
        }
        SsoOp::DeleteSso => {
            let removed: Outcome<bool> =
                g1t_kit::call(identity, "delete_sso", &json!({ "actor": actor, "slug": workspace, "surface": surface })).await?;
            match removed {
                Outcome::Ok(removed) => Outcome::Ok(json!({ "deleted": removed })),
                Outcome::Fail(failure) => Outcome::Fail(failure),
            }
        }
        SsoOp::EnableScim => {
            let made: Outcome<ScimToken> =
                g1t_kit::call(identity, "enable_scim", &json!({ "actor": actor, "slug": workspace, "surface": surface })).await?;
            match made {
                Outcome::Ok(made) => Outcome::Ok(json!({ "token": made.token, "hint": made.hint, "scim_url": scim_url(api, &made.workspace_id) })),
                Outcome::Fail(failure) => Outcome::Fail(failure),
            }
        }
        SsoOp::DisableScim => {
            let off: Outcome<bool> =
                g1t_kit::call(identity, "disable_scim", &json!({ "actor": actor, "slug": workspace, "surface": surface })).await?;
            match off {
                Outcome::Ok(off) => Outcome::Ok(json!({ "disabled": off })),
                Outcome::Fail(failure) => Outcome::Fail(failure),
            }
        }
        SsoOp::UnlinkSsoIdentity => {
            let Some(username) = text(input, "username") else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Name the person to unlink."));
            };
            let unlinked: Outcome<bool> = g1t_kit::call(
                identity,
                "unlink_sso_identity",
                &json!({ "actor": actor, "slug": workspace, "username": username, "surface": surface }),
            )
            .await?;
            match unlinked {
                Outcome::Ok(unlinked) => Outcome::Ok(json!({ "unlinked": unlinked })),
                Outcome::Fail(failure) => Outcome::Fail(failure),
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::scopes::{Level, scope_for};

    #[test]
    fn each_operation_is_described_and_scoped() {
        for op in SsoOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::Sso(op)), "{}", op.name());
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            assert!(op.input()["required"].as_array().unwrap().contains(&json!("workspace")), "{}", op.name());
            let level = scope_for(op.name()).unwrap().level();
            assert_eq!(level == Level::Read, !op.writes(), "{}", op.name());
        }
    }

    #[test]
    fn only_the_protocols_fields_are_sent() {
        let config = config_of(&json!({ "issuer": " https://acme.okta.com ", "client_id": "c", "client_secret": "s", "certificate": "pem", "nonsense": "x", "scopes": "" }));
        assert_eq!(config.issuer.as_deref(), Some("https://acme.okta.com"));
        assert_eq!(config.client_id.as_deref(), Some("c"));
        assert_eq!(config.scopes, None);
        assert!(config.certificates.is_empty());
    }

    #[test]
    fn a_field_left_out_keeps_what_is_saved() {
        let saved = SsoConnection {
            id: "sso_1".into(),
            protocol: SsoProtocol::Oidc,
            config: SsoConfig { issuer: Some("https://acme.okta.com".into()), client_id: Some("c".into()), join_domains: vec!["acme.com".into()], ..SsoConfig::default() },
            has_client_secret: true,
            certificates: vec![],
            allow_join: true,
            tested_at: None,
            tested_by: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        // Rotating the secret alone changes nothing else.
        let (config, allow_join) = merged(&json!({ "protocol": "oidc", "client_secret": "new" }), Some(&saved), SsoProtocol::Oidc);
        assert_eq!(config.issuer.as_deref(), Some("https://acme.okta.com"));
        let (nulls, _) = merged(&json!({ "protocol": "oidc", "issuer": null, "join_domains": null }), Some(&saved), SsoProtocol::Oidc);
        assert_eq!(nulls.issuer.as_deref(), Some("https://acme.okta.com"));
        assert_eq!(nulls.join_domains, vec!["acme.com".to_owned()]);
        assert_eq!(config.join_domains, vec!["acme.com".to_owned()]);
        assert!(allow_join);
        // Sent empty is changed; another protocol starts afresh.
        let (config, allow_join) = merged(&json!({ "protocol": "oidc", "join_domains": [], "allow_join": false }), Some(&saved), SsoProtocol::Oidc);
        assert!(config.join_domains.is_empty());
        assert!(!allow_join);
        let (config, allow_join) = merged(&json!({ "protocol": "saml" }), Some(&saved), SsoProtocol::Saml);
        assert_eq!(config.issuer, None);
        assert!(!allow_join);
    }

    #[test]
    fn the_answer_says_where_to_point_the_provider() {
        let settings = SsoSettings { slug: "acme".into(), workspace_id: "wsp_1".into(), connection: None, required: false, you_linked: false, identities: vec![], scim: None };
        let out = with_addresses(settings, "https://g1t.sh", "https://api.g1t.sh");
        assert_eq!(out["service_provider"]["scim_url"], "https://api.g1t.sh/scim/v2/wsp_1");
        assert_eq!(out["service_provider"]["acs_url"], "https://g1t.sh/auth/sso/wsp_1/saml");
        assert_eq!(out["service_provider"]["redirect_uri"], "https://g1t.sh/auth/sso/wsp_1/callback");
        assert_eq!(out["service_provider"]["sign_in_url"], "https://g1t.sh/auth/sso/acme");
        assert_eq!(out["connection"], Value::Null);
    }
}
