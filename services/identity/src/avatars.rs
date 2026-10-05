//! Uploaded avatars: a workspace's icon and a person's picture.
//!
//! An image is checked by its bytes, not by what it claims to be: only
//! PNG, JPEG, WebP and GIF, which a browser shows as an image and nothing
//! else. SVG is refused, since it can carry script. Each is stored in the
//! `AVATARS` KV namespace under the SHA-256 of its bytes, with its media
//! type as metadata. The hash is also what the workspace or user row holds
//! and what the address `/avatars/<hash>` names: an address always means
//! the same image, so it can be cached for good. The site serves the
//! namespace; only this service writes to it.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use g1t_contracts::identity::*;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role};
use sha2::{Digest, Sha256};
use worker::wasm_bindgen::JsValue;
use worker::Result;

use crate::Identity;

/// The media type an image's bytes show it to be, or why it is refused.
pub fn sniff(bytes: &[u8]) -> std::result::Result<&'static str, &'static str> {
    if bytes.is_empty() {
        return Err("That file is empty.");
    }
    if bytes.len() > MAX_AVATAR_BYTES {
        return Err("Use an image of at most 1 MB.");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Ok("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Ok("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Ok("image/webp")
    } else {
        Err("Use a PNG, JPEG, WebP or GIF image.")
    }
}

/// An upload decoded and checked: its key and media type.
pub struct Checked {
    pub key: String,
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

/// Decodes an uploaded image and checks it.
pub fn check(image: &str) -> std::result::Result<Checked, &'static str> {
    // Base64 is a third longer; anything far past the limit is refused
    // before it is decoded.
    if image.len() > MAX_AVATAR_BYTES / 3 * 4 + 8 {
        return Err("Use an image of at most 1 MB.");
    }
    let bytes = STANDARD
        .decode(image.trim())
        .map_err(|_| "That upload could not be read.")?;
    let content_type = sniff(&bytes)?;
    Ok(Checked {
        key: hex::encode(Sha256::digest(&bytes)),
        content_type,
        bytes,
    })
}

/// Whether a stored avatar key is well formed: 64 lowercase hex digits.
pub fn is_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// What is kept beside an avatar's bytes, as the site reads it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    content_type: &'static str,
}

impl Identity {
    /// Stores a checked image. The same bytes always land on the same
    /// key, so storing them again changes nothing.
    async fn store_avatar(&self, checked: Checked) -> Result<String> {
        self.env
            .kv("AVATARS")?
            .put_bytes(&checked.key, &checked.bytes)?
            .metadata(Stored {
                content_type: checked.content_type,
            })?
            .execute()
            .await?;
        Ok(checked.key)
    }

    /// Deletes an avatar no workspace or person uses any more.
    async fn forget_avatar(&self, key: Option<String>) -> Result<()> {
        let Some(key) = key.filter(|key| is_key(key)) else {
            return Ok(());
        };
        let used = self
            .db
            .prepare(
                "SELECT 1 FROM workspaces WHERE avatar = ?1
                 UNION ALL SELECT 1 FROM users WHERE avatar = ?1 LIMIT 1",
            )
            .bind(&[key.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some();
        if !used {
            self.env.kv("AVATARS")?.delete(&key).await?;
        }
        Ok(())
    }

    /// The avatar a row has now, before it is changed.
    async fn current_avatar(&self, sql: &str, param: &str) -> Result<Option<String>> {
        #[derive(serde::Deserialize)]
        struct Row {
            avatar: Option<String>,
        }
        Ok(self
            .db
            .prepare(sql)
            .bind(&[param.into()])?
            .first::<Row>(None)
            .await?
            .and_then(|row| row.avatar))
    }

    /// Checks and stores `image`, or does nothing for none; the new key.
    async fn upload(&self, image: Option<&str>) -> Result<std::result::Result<Option<String>, &'static str>> {
        let Some(image) = image else {
            return Ok(Ok(None));
        };
        match check(image) {
            Ok(checked) => Ok(Ok(Some(self.store_avatar(checked).await?))),
            Err(message) => Ok(Err(message)),
        }
    }

    pub async fn set_workspace_avatar(&self, a: SetWorkspaceAvatarArgs) -> Result<Outcome<Workspace>> {
        let slug = a.slug.to_lowercase();
        // Checked here, not only by the page: only an owner, as a person.
        if a.actor.kind != PrincipalKind::User || a.actor.role_in(&slug) != Some(Role::Owner) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only an owner can change a workspace's icon.",
            ));
        }
        let previous = self
            .current_avatar("SELECT avatar FROM workspaces WHERE slug = ?", &slug)
            .await?;
        let key = match self.upload(a.image.as_deref()).await? {
            Ok(key) => key,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        self.db
            .prepare("UPDATE workspaces SET avatar = ? WHERE slug = ?")
            .bind(&[
                key.as_deref().map_or(JsValue::NULL, JsValue::from),
                slug.as_str().into(),
            ])?
            .run()
            .await?;
        if previous != key {
            self.forget_avatar(previous).await?;
        }
        Ok(match self.get_workspace(SlugArgs { slug }).await? {
            Some(workspace) => Outcome::Ok(workspace),
            None => Outcome::fail(FailureCode::NotFound, "Workspace not found."),
        })
    }

    pub async fn set_user_avatar(&self, a: SetUserAvatarArgs) -> Result<Outcome<Option<String>>> {
        if a.user.kind != PrincipalKind::User || a.user.id.is_empty() {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only a person can change their own picture.",
            ));
        }
        let previous = self
            .current_avatar("SELECT avatar FROM users WHERE id = ?", &a.user.id)
            .await?;
        let key = match self.upload(a.image.as_deref()).await? {
            Ok(key) => key,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        self.db
            .prepare("UPDATE users SET avatar = ? WHERE id = ?")
            .bind(&[
                key.as_deref().map_or(JsValue::NULL, JsValue::from),
                a.user.id.as_str().into(),
            ])?
            .run()
            .await?;
        if previous != key {
            self.forget_avatar(previous).await?;
        }
        Ok(Outcome::Ok(key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, b'J', b'F', b'I', b'F'];
    const WEBP: &[u8] = b"RIFF\x24\0\0\0WEBPVP8 ";
    const GIF: &[u8] = b"GIF89a\x01\0\x01\0";

    #[test]
    fn knows_each_image_by_its_bytes() {
        assert_eq!(sniff(PNG), Ok("image/png"));
        assert_eq!(sniff(JPEG), Ok("image/jpeg"));
        assert_eq!(sniff(WEBP), Ok("image/webp"));
        assert_eq!(sniff(GIF), Ok("image/gif"));
        assert_eq!(sniff(b"GIF87a\x01\0"), Ok("image/gif"));
    }

    #[test]
    fn refuses_svg_and_anything_else() {
        assert!(sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>").is_err());
        assert!(sniff(b"<?xml version=\"1.0\"?><svg/>").is_err());
        assert!(sniff(b"<html><body>hi</body></html>").is_err());
        assert!(sniff(b"RIFF\0\0\0\0WAVEfmt ").is_err());
        assert!(sniff(b"\x89PNX").is_err());
        assert!(sniff(b"").is_err());
    }

    #[test]
    fn refuses_more_than_a_megabyte() {
        let mut big = PNG.to_vec();
        big.resize(MAX_AVATAR_BYTES, 0);
        assert_eq!(sniff(&big), Ok("image/png"));
        big.push(0);
        assert!(sniff(&big).is_err());
        assert!(check(&STANDARD.encode(&big)).is_err());
    }

    #[test]
    fn keys_an_image_by_its_hash() {
        let checked = check(&STANDARD.encode(PNG)).ok().unwrap();
        assert_eq!(checked.content_type, "image/png");
        assert_eq!(checked.key, hex::encode(Sha256::digest(PNG)));
        assert!(is_key(&checked.key));
        assert!(!is_key("../etc/passwd"));
        assert!(!is_key(&checked.key.to_uppercase()));
    }

    #[test]
    fn refuses_what_is_not_base64() {
        assert!(check("not base64!").is_err());
    }
}
