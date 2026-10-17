//! SCIM 2.0 (RFC 7643, 7644) for a workspace with single sign-on: its
//! identity provider tells g1t who is assigned to it, and who is not any
//! more. The pure parts: users as SCIM resources, filters, PATCH, and
//! errors. The rest is in ../sso.rs.
//!
//! Users only. A provisioned user is not a g1t account: people still sign
//! in to g1t as themselves. It says the provider has them assigned, which
//! single sign-on then requires of anyone signing in through it, and
//! taking it away (`active: false`, or deleting it) takes them out of the
//! workspace at once. Groups are not kept; a provider that pushes them is
//! told so.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub const USER_SCHEMA: &str = "urn:ietf:params:scim:schemas:core:2.0:User";
pub const LIST_SCHEMA: &str = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
#[cfg(test)]
pub const PATCH_SCHEMA: &str = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
pub const ERROR_SCHEMA: &str = "urn:ietf:params:scim:api:messages:2.0:Error";
/// The most users one page lists.
pub const MAX_PAGE: usize = 200;

/// A user as the provider describes them, as kept.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScimUser {
    pub user_name: String,
    pub external_id: Option<String>,
    pub display_name: Option<String>,
    pub given_name: Option<String>,
    pub family_name: Option<String>,
    /// Lowercased addresses, the primary first.
    pub emails: Vec<String>,
    pub active: bool,
}

/// A SCIM error: its status, and `scimType` when RFC 7644 names one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScimError {
    pub status: u16,
    pub scim_type: Option<&'static str>,
    pub detail: String,
}

impl ScimError {
    pub fn new(status: u16, scim_type: Option<&'static str>, detail: impl Into<String>) -> Self {
        ScimError { status, scim_type, detail: detail.into() }
    }

    pub fn invalid(detail: impl Into<String>) -> Self {
        ScimError::new(400, Some("invalidValue"), detail)
    }

    pub fn body(&self) -> Value {
        let mut body = json!({ "schemas": [ERROR_SCHEMA], "status": self.status.to_string(), "detail": self.detail });
        if let Some(kind) = self.scim_type {
            body["scimType"] = json!(kind);
        }
        body
    }
}

/// The key a user name is found by.
pub fn user_name_key(user_name: &str) -> String {
    user_name.trim().to_lowercase()
}

/// A boolean as providers send it: `true`, or the string `"True"`.
fn boolean(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(on) => Some(*on),
        Value::String(text) => match text.trim().to_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::trim).filter(|t| !t.is_empty()).map(|t| t.chars().take(512).collect())
}

/// The addresses of an `emails` value, the primary first, lowercased.
fn emails_of(value: &Value) -> Vec<String> {
    let mut found: Vec<(bool, String)> = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|email| Some((email["primary"].as_bool() == Some(true) || boolean(&email["primary"]) == Some(true), text(&email["value"])?.to_lowercase())))
        .filter(|(_, address)| address.contains('@'))
        .collect();
    found.sort_by_key(|(primary, _)| !primary);
    let mut out: Vec<String> = Vec::new();
    for (_, address) in found {
        if !out.contains(&address) {
            out.push(address);
        }
    }
    out.truncate(10);
    out
}

/// A user from a resource sent with POST or PUT.
pub fn from_resource(body: &Value) -> Result<ScimUser, ScimError> {
    let user_name = text(&body["userName"]).ok_or_else(|| ScimError::invalid("userName is required."))?;
    Ok(ScimUser {
        user_name,
        external_id: text(&body["externalId"]),
        display_name: text(&body["displayName"]),
        given_name: text(&body["name"]["givenName"]),
        family_name: text(&body["name"]["familyName"]),
        emails: emails_of(&body["emails"]),
        // Active unless it says otherwise.
        active: match body.get("active") {
            None | Some(Value::Null) => true,
            Some(value) => boolean(value).ok_or_else(|| ScimError::invalid("active is true or false."))?,
        },
    })
}

/// The resource for a user kept as `id`.
pub fn to_resource(id: &str, user: &ScimUser, created: &str, modified: &str, base: &str) -> Value {
    let mut name = Map::new();
    if let Some(given) = &user.given_name {
        name.insert("givenName".into(), json!(given));
    }
    if let Some(family) = &user.family_name {
        name.insert("familyName".into(), json!(family));
    }
    let emails: Vec<Value> = user
        .emails
        .iter()
        .enumerate()
        .map(|(i, address)| json!({ "value": address, "type": "work", "primary": i == 0 }))
        .collect();
    let mut resource = json!({
        "schemas": [USER_SCHEMA],
        "id": id,
        "userName": user.user_name,
        "active": user.active,
        "emails": emails,
        "meta": { "resourceType": "User", "created": created, "lastModified": modified, "location": format!("{base}/Users/{id}") },
    });
    if let Some(external) = &user.external_id {
        resource["externalId"] = json!(external);
    }
    if let Some(display) = &user.display_name {
        resource["displayName"] = json!(display);
    }
    if !name.is_empty() {
        resource["name"] = Value::Object(name);
    }
    resource
}

/// What a list may be filtered by: `attribute eq "value"`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Filter {
    UserName(String),
    ExternalId(String),
    Id(String),
    Email(String),
}

/// Reads a filter. Providers look a user up by one attribute, `eq`;
/// anything else is refused as RFC 7644 says, so nothing is listed wrongly.
pub fn parse_filter(filter: &str) -> Result<Filter, ScimError> {
    let refused = || ScimError::new(400, Some("invalidFilter"), format!("Only `attribute eq \"value\"` on userName, externalId, id or emails is supported: {filter}"));
    let filter = filter.trim();
    let (attribute, rest) = filter.split_once(char::is_whitespace).ok_or_else(refused)?;
    let (operator, value) = rest.trim().split_once(char::is_whitespace).ok_or_else(refused)?;
    if !operator.eq_ignore_ascii_case("eq") {
        return Err(refused());
    }
    let value = value.trim();
    let value = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).ok_or_else(refused)?.replace("\\\"", "\"");
    match attribute.to_lowercase().as_str() {
        "username" => Ok(Filter::UserName(value)),
        "externalid" => Ok(Filter::ExternalId(value)),
        "id" => Ok(Filter::Id(value)),
        "emails.value" | "emails" | "emails[type eq \"work\"].value" => Ok(Filter::Email(value.to_lowercase())),
        _ => Err(refused()),
    }
}

/// Applies a PATCH request (RFC 7644 3.5.2) to a user, as Okta and
/// Microsoft Entra send them: `op` in any case, a `path`, or a `value`
/// object of attributes with none, and booleans as strings.
pub fn apply_patch(user: &mut ScimUser, body: &Value) -> Result<(), ScimError> {
    let operations = body["Operations"].as_array().ok_or_else(|| ScimError::invalid("Operations is required."))?;
    for operation in operations {
        let op = operation["op"].as_str().unwrap_or_default().to_lowercase();
        if !matches!(op.as_str(), "add" | "replace" | "remove") {
            return Err(ScimError::invalid(format!("op {op:?} is add, replace or remove.")));
        }
        let value = &operation["value"];
        match operation["path"].as_str().map(str::trim).filter(|p| !p.is_empty()) {
            Some(path) => set(user, path, if op == "remove" { &Value::Null } else { value })?,
            None => {
                let fields = value.as_object().ok_or_else(|| ScimError::invalid("A change without a path needs an object of attributes."))?;
                for (path, value) in fields {
                    set(user, path, if op == "remove" { &Value::Null } else { value })?;
                }
            }
        }
    }
    Ok(())
}

/// Sets one attribute by its path; null clears it.
fn set(user: &mut ScimUser, path: &str, value: &Value) -> Result<(), ScimError> {
    let lower = path.to_lowercase();
    // A schema-qualified path is read as the attribute it names.
    let attribute = lower.strip_prefix(&format!("{}:", USER_SCHEMA.to_lowercase())).unwrap_or(&lower);
    match attribute {
        "active" => {
            user.active = boolean(value).ok_or_else(|| ScimError::invalid("active is true or false."))?;
        }
        "username" => user.user_name = text(value).ok_or_else(|| ScimError::invalid("userName cannot be empty."))?,
        "externalid" => user.external_id = text(value),
        "displayname" => user.display_name = text(value),
        "name.givenname" => user.given_name = text(value),
        "name.familyname" => user.family_name = text(value),
        "name" => {
            user.given_name = text(&value["givenName"]);
            user.family_name = text(&value["familyName"]);
        }
        "emails" => user.emails = emails_of(value),
        path if path.starts_with("emails[") => {
            // emails[type eq "work"].value: the one address.
            match text(value).or_else(|| value.as_array().and_then(|items| items.first()).and_then(|first| text(&first["value"]))) {
                Some(address) if address.contains('@') => {
                    let address = address.to_lowercase();
                    user.emails.retain(|kept| kept != &address);
                    user.emails.insert(0, address);
                }
                Some(_) => return Err(ScimError::invalid("That is not an email address.")),
                None => user.emails.clear(),
            }
        }
        // Attributes g1t does not keep (phone numbers, titles, enterprise
        // extensions) are accepted and let go, as providers send them.
        _ => {}
    }
    Ok(())
}

/// Whether someone who signed in through the provider is this provisioned
/// user: one of the stable ids it gave (`ids`) is their userName or
/// externalId, or an address it vouches for (`trusted_email`) is their
/// userName or primary address. A secondary address, or one the provider
/// does not vouch for, never matches.
pub fn is_them(user: &ScimUser, ids: &[String], trusted_email: Option<&str>) -> bool {
    let same = |value: &str| ids.iter().any(|id| id.trim().eq_ignore_ascii_case(value.trim()));
    same(&user.user_name)
        || user.external_id.as_deref().is_some_and(same)
        || trusted_email.is_some_and(|email| {
            let email = email.trim().to_lowercase();
            user_name_key(&user.user_name) == email || user.emails.first() == Some(&email)
        })
}

const GROUP_SCHEMA: &str = "urn:ietf:params:scim:schemas:core:2.0:Group";

/// A group a provider pushed, accepted and let go: g1t keeps users, not
/// groups, but a provider that pushes them (Entra does by default) must
/// not fail, or it stops sending deactivations too. Its id is its name,
/// hex-encoded (hashed when long): pushing it again gives the same one, and
/// reading it back gives its name.
pub fn group_accepted(body: &Value, base: &str) -> Value {
    let name = text(&body["displayName"]).unwrap_or_default();
    let id = if name.len() <= 100 {
        format!("grp_{}", hex::encode(name.as_bytes()))
    } else {
        use sha2::{Digest, Sha256};
        format!("grh_{}", hex::encode(&Sha256::digest(name.as_bytes())[..12]))
    };
    group_echo(&id, body, base)
}

/// The name in a group's id, when it holds one.
pub fn group_named(id: &str) -> Option<String> {
    if let Some(hexed) = id.strip_prefix("grp_") {
        return String::from_utf8(hex::decode(hexed).ok()?).ok();
    }
    id.starts_with("grh_").then(String::new)
}

/// A group as sent, under `id`, with no members kept.
pub fn group_echo(id: &str, body: &Value, base: &str) -> Value {
    let mut group = json!({
        "schemas": [GROUP_SCHEMA],
        "id": id,
        "displayName": text(&body["displayName"]).unwrap_or_default(),
        "members": [],
        "meta": { "resourceType": "Group", "location": format!("{base}/Groups/{id}") },
    });
    if let Some(external) = text(&body["externalId"]) {
        group["externalId"] = json!(external);
    }
    group
}

/// What g1t can do, for `GET /ServiceProviderConfig`.
pub fn service_provider_config(docs: &str) -> Value {
    json!({
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        "documentationUri": docs,
        "patch": { "supported": true },
        "bulk": { "supported": false, "maxOperations": 0, "maxPayloadSize": 0 },
        "filter": { "supported": true, "maxResults": MAX_PAGE },
        "changePassword": { "supported": false },
        "sort": { "supported": false },
        "etag": { "supported": false },
        "authenticationSchemes": [{
            "type": "oauthbearertoken",
            "name": "Bearer token",
            "description": "The SCIM token from the workspace's single sign-on settings.",
            "primary": true,
        }],
        "meta": { "resourceType": "ServiceProviderConfig" },
    })
}

/// `GET /ResourceTypes`: users only.
pub fn resource_types(base: &str) -> Value {
    json!({
        "schemas": [LIST_SCHEMA],
        "totalResults": 1,
        "Resources": [{
            "schemas": ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
            "id": "User",
            "name": "User",
            "endpoint": "/Users",
            "schema": USER_SCHEMA,
            "meta": { "resourceType": "ResourceType", "location": format!("{base}/ResourceTypes/User") },
        }],
    })
}

/// A page of a list.
pub fn list(resources: Vec<Value>, total: usize, start_index: usize) -> Value {
    json!({
        "schemas": [LIST_SCHEMA],
        "totalResults": total,
        "startIndex": start_index,
        "itemsPerPage": resources.len(),
        "Resources": resources,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn okta_user() -> Value {
        json!({
            "schemas": [USER_SCHEMA],
            "userName": "Ada@Acme.test",
            "name": { "givenName": "Ada", "familyName": "Lovelace" },
            "emails": [{ "primary": true, "value": "Ada@Acme.test", "type": "work" }],
            "displayName": "Ada Lovelace",
            "externalId": "00u1abcd",
            "active": true,
        })
    }

    #[test]
    fn a_resource_is_read_and_written_back() {
        let user = from_resource(&okta_user()).unwrap();
        assert_eq!(user.user_name, "Ada@Acme.test");
        assert_eq!(user.emails, vec!["ada@acme.test".to_owned()]);
        assert!(user.active);
        let resource = to_resource("scu_1", &user, "2026-10-17T00:00:00Z", "2026-10-17T00:00:00Z", "https://api.g1t.sh/scim/v2/acme");
        assert_eq!(resource["userName"], "Ada@Acme.test");
        assert_eq!(resource["name"]["familyName"], "Lovelace");
        assert_eq!(resource["meta"]["location"], "https://api.g1t.sh/scim/v2/acme/Users/scu_1");
        assert_eq!(resource["emails"][0]["primary"], true);
        // Entra sends active as a string; it may be left out.
        assert!(!from_resource(&json!({ "userName": "x", "active": "False" })).unwrap().active);
        assert!(from_resource(&json!({ "userName": "x" })).unwrap().active);
        assert_eq!(from_resource(&json!({ "active": true })).unwrap_err().status, 400);
    }

    #[test]
    fn filters_find_one_attribute() {
        assert_eq!(parse_filter("userName eq \"ada@acme.test\"").unwrap(), Filter::UserName("ada@acme.test".into()));
        assert_eq!(parse_filter("externalId eq \"00u1\"").unwrap(), Filter::ExternalId("00u1".into()));
        assert_eq!(parse_filter("emails[type eq \"work\"].value eq \"Ada@Acme.test\"").unwrap_err().scim_type, Some("invalidFilter"));
        assert_eq!(parse_filter("emails.value eq \"Ada@Acme.test\"").unwrap(), Filter::Email("ada@acme.test".into()));
        assert!(parse_filter("userName co \"ada\"").is_err());
        assert!(parse_filter("userName eq ada").is_err());
    }

    #[test]
    fn okta_deactivates_with_a_path() {
        let mut user = from_resource(&okta_user()).unwrap();
        apply_patch(&mut user, &json!({ "schemas": [PATCH_SCHEMA], "Operations": [{ "op": "replace", "value": { "active": false } }] })).unwrap();
        assert!(!user.active);
        apply_patch(&mut user, &json!({ "Operations": [{ "op": "replace", "path": "active", "value": true }] })).unwrap();
        assert!(user.active);
    }

    #[test]
    fn entra_patches_as_entra_does() {
        let mut user = from_resource(&okta_user()).unwrap();
        apply_patch(
            &mut user,
            &json!({ "Operations": [
                { "op": "Replace", "path": "active", "value": "False" },
                { "op": "Replace", "path": "emails[type eq \"work\"].value", "value": "Ada.L@Acme.test" },
                { "op": "Add", "path": "name.givenName", "value": "Augusta" },
                { "op": "Replace", "path": "urn:ietf:params:scim:schemas:core:2.0:User:displayName", "value": "Augusta Ada" },
                { "op": "Add", "path": "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department", "value": "Engines" },
                { "op": "Remove", "path": "externalId" },
            ] }),
        )
        .unwrap();
        assert!(!user.active);
        assert_eq!(user.emails, vec!["ada.l@acme.test".to_owned(), "ada@acme.test".to_owned()]);
        assert_eq!(user.given_name.as_deref(), Some("Augusta"));
        assert_eq!(user.display_name.as_deref(), Some("Augusta Ada"));
        assert_eq!(user.external_id, None);
        let refused = apply_patch(&mut user, &json!({ "Operations": [{ "op": "move", "path": "active" }] })).unwrap_err();
        assert_eq!(refused.status, 400);
        assert!(apply_patch(&mut user, &json!({ "Operations": [{ "op": "replace", "path": "active", "value": "maybe" }] })).is_err());
    }

    #[test]
    fn a_sign_in_is_matched_by_id_name_or_vouched_address() {
        let user = from_resource(&okta_user()).unwrap();
        let ids = |list: &[&str]| list.iter().map(|id| id.to_string()).collect::<Vec<_>>();
        assert!(is_them(&user, &ids(&["00u1abcd"]), None));
        assert!(is_them(&user, &ids(&["ADA@acme.test"]), None));
        assert!(is_them(&user, &ids(&["pairwise", "00u1abcd"]), None));
        assert!(is_them(&user, &ids(&["some-oidc-sub"]), Some("ada@acme.test")));
        assert!(!is_them(&user, &ids(&["some-oidc-sub"]), Some("eve@acme.test")));
        assert!(!is_them(&user, &ids(&["00u9"]), None));
        // A secondary address is not enough.
        let mut two = user.clone();
        two.user_name = "ada".into();
        two.emails = vec!["ada@acme.test".into(), "shared@acme.test".into()];
        assert!(!is_them(&two, &ids(&["x"]), Some("shared@acme.test")));
        assert!(is_them(&two, &ids(&["x"]), Some("ada@acme.test")));
    }

    #[test]
    fn a_pushed_group_reads_back() {
        let group = group_accepted(&json!({ "displayName": "Engineering", "externalId": null }), "https://api.test/scim/v2/wsp_1");
        let id = group["id"].as_str().unwrap();
        assert_eq!(group_named(id).as_deref(), Some("Engineering"));
        assert!(group.get("externalId").is_none());
        assert_eq!(group_accepted(&json!({ "displayName": "Engineering" }), "x")["id"], group["id"]);
        assert_eq!(group_named("grp_zz"), None);
        assert_eq!(group_named("scu_1"), None);
    }

    #[test]
    fn errors_are_scim_errors() {
        let body = ScimError::new(409, Some("uniqueness"), "taken").body();
        assert_eq!(body["status"], "409");
        assert_eq!(body["scimType"], "uniqueness");
        assert_eq!(body["schemas"][0], ERROR_SCHEMA);
    }
}
