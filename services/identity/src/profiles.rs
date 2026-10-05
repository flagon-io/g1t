//! Profiles: what a person says about themselves, shown to anyone at
//! `g1t.sh/u/<username>`.
//!
//! A profile is public by design, so nothing private goes into one: no
//! email address, and no workspace the viewer has no other way to know the
//! person belongs to (see `profile_workspaces`).

use g1t_contracts::identity::*;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind};
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Identity;

#[derive(Deserialize)]
struct ProfileRow {
    username: String,
    display_name: Option<String>,
    bio: Option<String>,
    location: Option<String>,
    website: Option<String>,
    pronouns: Option<String>,
    avatar: Option<String>,
    created_at: String,
}

impl From<ProfileRow> for Profile {
    fn from(row: ProfileRow) -> Self {
        Profile {
            username: row.username,
            name: row.display_name,
            bio: row.bio,
            location: row.location,
            website: row.website,
            pronouns: row.pronouns,
            avatar: row.avatar,
            created_at: row.created_at,
        }
    }
}

const PROFILE_COLUMNS: &str =
    "username, display_name, bio, location, website, pronouns, avatar, created_at";

/// A field as it is kept: whitespace runs made single spaces, control
/// characters dropped, trimmed. Empty is none. Too long is refused.
fn tidy(value: &str, max: usize, what: &str) -> std::result::Result<Option<String>, String> {
    let text = value
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !c.is_control())
        .collect::<String>()
        .split(' ')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        Ok(None)
    } else if text.chars().count() > max {
        Err(format!("Keep your {what} to {max} characters."))
    } else {
        Ok(Some(text))
    }
}

/// A website as it is kept: an `https://` address with a real host name.
/// A bare `example.com` is taken to mean `https://example.com`. Plain
/// `http://`, other schemes and anything a browser might read as script are
/// refused.
pub fn website(value: &str) -> std::result::Result<Option<String>, &'static str> {
    const REFUSED: &str = "Use an https:// address for your website, such as https://example.com.";
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > MAX_PROFILE_WEBSITE {
        return Err("That website address is too long.");
    }
    if value.chars().any(|c| c.is_whitespace() || c.is_control() || "<>\"'`\\".contains(c)) {
        return Err(REFUSED);
    }
    let address = match value.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("https") => format!("https://{rest}"),
        Some(_) => return Err(REFUSED),
        // `javascript:alert(1)` has no `//` but is no host name either; the
        // host check below refuses it.
        None => format!("https://{value}"),
    };
    let rest = &address["https://".len()..];
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    // No credentials in an address shown to others.
    if authority.contains('@') {
        return Err(REFUSED);
    }
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        Some(_) => return Err(REFUSED),
        None => authority,
    };
    let labels: Vec<&str> = host.split('.').collect();
    let well_formed = labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_alphanumeric() || c == '-')
        });
    if !well_formed {
        return Err(REFUSED);
    }
    Ok(Some(address))
}

/// The fields of an update, checked, or the first thing wrong.
pub struct Checked {
    pub name: Option<String>,
    pub bio: Option<String>,
    pub location: Option<String>,
    pub website: Option<String>,
    pub pronouns: Option<String>,
}

pub fn check(a: &UpdateProfileArgs) -> std::result::Result<Checked, String> {
    Ok(Checked {
        name: tidy(&a.name, MAX_PROFILE_NAME, "name")?,
        bio: tidy(&a.bio, MAX_PROFILE_BIO, "bio")?,
        location: tidy(&a.location, MAX_PROFILE_LOCATION, "location")?,
        website: website(&a.website).map_err(str::to_owned)?,
        pronouns: tidy(&a.pronouns, MAX_PROFILE_PRONOUNS, "pronouns")?,
    })
}

fn optional(value: &Option<String>) -> JsValue {
    value.as_deref().map_or(JsValue::NULL, JsValue::from)
}

impl Identity {
    pub async fn profile(&self, a: UsernameArgs) -> Result<Option<Profile>> {
        Ok(self
            .db
            .prepare(format!("SELECT {PROFILE_COLUMNS} FROM users WHERE username = ?"))
            .bind(&[a.username.trim().to_lowercase().into()])?
            .first::<ProfileRow>(None)
            .await?
            .map(Profile::from))
    }

    pub async fn update_profile(&self, a: UpdateProfileArgs) -> Result<Outcome<Profile>> {
        if a.actor.kind != PrincipalKind::User || a.actor.id.is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only a person can change their own profile.",
            ));
        }
        let fields = match check(&a) {
            Ok(fields) => fields,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let row = self
            .db
            .prepare(format!(
                "UPDATE users SET display_name = ?, bio = ?, location = ?, website = ?, pronouns = ?
                 WHERE id = ? RETURNING {PROFILE_COLUMNS}"
            ))
            .bind(&[
                optional(&fields.name),
                optional(&fields.bio),
                optional(&fields.location),
                optional(&fields.website),
                optional(&fields.pronouns),
                a.actor.id.as_str().into(),
            ])?
            .first::<ProfileRow>(None)
            .await?;
        Ok(match row {
            Some(row) => Outcome::Ok(row.into()),
            None => Outcome::fail(FailureCode::NotFound, "There is no such account."),
        })
    }

    /// The workspaces a profile shows to `viewer`. Belonging to a workspace
    /// is private to its members, so a membership is shown only where the
    /// viewer could know it anyway:
    ///
    /// - a workspace the viewer belongs to too, whose members they can list;
    /// - a workspace in `public`, where the person made a public project,
    ///   which the project's page shows already.
    ///
    /// Anything else, including every workspace of someone viewed signed
    /// out, is left off. Only real memberships are ever returned: `public`
    /// can narrow what is shown, never add to it.
    pub async fn profile_workspaces(&self, a: ProfileWorkspacesArgs) -> Result<Vec<ProfileWorkspace>> {
        #[derive(Deserialize)]
        struct Row {
            id: String,
        }
        let Some(person) = self
            .db
            .prepare("SELECT id FROM users WHERE username = ?")
            .bind(&[a.username.trim().to_lowercase().into()])?
            .first::<Row>(None)
            .await?
        else {
            return Ok(Vec::new());
        };
        let memberships = self.memberships(&person.id).await?;
        let shared = |slug: &str| a.viewer.as_ref().is_some_and(|viewer| viewer.is_member(slug));
        let public = |slug: &str| a.public.iter().any(|shown| shown.eq_ignore_ascii_case(slug));
        Ok(memberships
            .into_iter()
            .filter(|membership| shared(&membership.slug) || public(&membership.slug))
            .map(|membership| ProfileWorkspace {
                name: membership.name.clone().unwrap_or_else(|| membership.slug.clone()),
                slug: membership.slug,
                avatar: membership.avatar,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_https_addresses() {
        assert_eq!(website("https://example.com").unwrap().as_deref(), Some("https://example.com"));
        assert_eq!(
            website("HTTPS://syntaqx.com/about?x=1#me").unwrap().as_deref(),
            Some("https://syntaqx.com/about?x=1#me")
        );
        assert_eq!(website("example.com/me").unwrap().as_deref(), Some("https://example.com/me"));
        assert_eq!(website("https://a.b.example.dev:8443/").unwrap().as_deref(), Some("https://a.b.example.dev:8443/"));
        assert_eq!(website("  ").unwrap(), None);
    }

    #[test]
    fn refuses_anything_else() {
        for refused in [
            "http://example.com",
            "javascript:alert(1)",
            "javascript://example.com/%0Aalert(1)",
            "data:text/html,<script>",
            "ftp://example.com",
            "https://localhost",
            "https://user:pass@example.com",
            "https://exa mple.com",
            "https://example.com/\"onmouseover=",
            "https://-bad.com",
            "https://example..com",
            "https://example.com:port",
            "https://",
        ] {
            assert!(website(refused).is_err(), "{refused} was kept");
        }
        assert!(website(&format!("https://example.com/{}", "a".repeat(200))).is_err());
    }

    #[test]
    fn tidies_text_fields() {
        assert_eq!(tidy("  Chase \n  Pierce ", 80, "name").unwrap().as_deref(), Some("Chase Pierce"));
        assert_eq!(tidy("\u{0}\u{7}", 80, "name").unwrap(), None);
        assert_eq!(tidy("", 80, "name").unwrap(), None);
        assert!(tidy(&"a".repeat(161), MAX_PROFILE_BIO, "bio").is_err());
        assert!(tidy(&"é".repeat(160), MAX_PROFILE_BIO, "bio").is_ok());
    }

    #[test]
    fn checks_every_field() {
        let args = UpdateProfileArgs {
            name: "Chase".into(),
            bio: "Builds g1t.".into(),
            website: "http://insecure.example".into(),
            ..UpdateProfileArgs::default()
        };
        assert!(check(&args).is_err());
        let args = UpdateProfileArgs {
            website: "syntaqx.com".into(),
            pronouns: "he/him".into(),
            ..args
        };
        let fields = check(&args).ok().unwrap();
        assert_eq!(fields.website.as_deref(), Some("https://syntaqx.com"));
        assert_eq!(fields.pronouns.as_deref(), Some("he/him"));
        assert_eq!(fields.location, None);
    }
}
