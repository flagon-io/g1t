//! Files put in an issue's, a pull request's or a comment's Markdown: a
//! screenshot of a preview, a recording's still. The work service keeps
//! them (`upload_attachment`), with whoever may comment on the repository
//! allowed to add one, and the usercontent origin serves each at
//! `<usercontent>/attachments/<id>` (apps/web/workers/usercontent.ts),
//! never the site. An id is 256 random bits, so its address is its
//! permission, as a Docs file's is: a private repository's attachment is
//! seen by whoever is given its address, as its Markdown gives it.

use serde::{Deserialize, Serialize};

use crate::User;
use crate::repos::RepoPath;

/// The largest attachment, in bytes: 10 MB.
pub const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;

/// What an attachment may be, as its bytes show it: PNG, JPEG, GIF or WebP.
pub const ATTACHMENT_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];

/// The longest name kept, in characters.
pub const MAX_ATTACHMENT_NAME_CHARS: usize = 200;

/// Where attachments are kept in the usercontent namespace (`AVATARS`):
/// `attachments/<id>`, with [`AttachmentMeta`].
pub const ATTACHMENT_KEY_PREFIX: &str = "attachments/";

/// `upload_attachment`: keep a file to show in Markdown on `repo`, for
/// someone who may comment there. `data` is the file, base64-encoded; its
/// type is read from its bytes, and a `content_type` that says otherwise
/// is refused. Returns `Outcome<Attachment>`: too large is
/// `FailureCode::TooLarge`, another type `FailureCode::UnsupportedType`.
#[derive(Debug, Serialize, Deserialize)]
pub struct UploadAttachmentArgs {
    pub actor: User,
    pub repo: RepoPath,
    /// The file's name, such as `preview.png`: the image's alt text.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    pub data: String,
}

/// An attachment kept: `path` is under the usercontent origin.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub content_type: String,
    pub size: u64,
    /// `/attachments/<id>`.
    pub path: String,
}

/// What is kept with an attachment's bytes, as KV metadata (at most 1 KB).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    /// As the usercontent origin serves it.
    pub content_type: String,
    pub name: String,
    pub repo_id: String,
    pub user_id: String,
    pub size: u64,
    /// Milliseconds since the epoch.
    pub at: u64,
}

/// `/attachments/<id>`: where an attachment is under the usercontent origin.
pub fn attachment_path(id: &str) -> String {
    format!("/attachments/{id}")
}

/// Whether `id` is an attachment's: 64 lowercase hex digits.
pub fn is_attachment_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The type a file's first bytes show it to be, if it is one an attachment may be.
pub fn sniff_attachment(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// A content type as given (`image/PNG; charset=…`), as one of
/// [`ATTACHMENT_TYPES`] compares it; `image/jpg` is `image/jpeg`.
pub fn normalize_content_type(given: &str) -> String {
    let kind = given.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    if kind == "image/jpg" { "image/jpeg".to_owned() } else { kind }
}

/// A file's name as kept: its last path segment, without control
/// characters, at most [`MAX_ATTACHMENT_NAME_CHARS`]; `image` when nothing is left.
pub fn attachment_name(given: &str) -> String {
    let last = given.rsplit(['/', '\\']).next().unwrap_or_default();
    let name: String = last.chars().filter(|c| !c.is_control()).take(MAX_ATTACHMENT_NAME_CHARS).collect();
    let name = name.trim();
    if name.is_empty() { "image".to_owned() } else { name.to_owned() }
}

/// The Markdown that shows the attachment at `url`: `![name](url)`, with
/// the brackets and backslashes of its name escaped.
pub fn attachment_markdown(name: &str, url: &str) -> String {
    let mut alt = String::with_capacity(name.len());
    for c in name.chars() {
        if matches!(c, '[' | ']' | '\\') {
            alt.push('\\');
        }
        alt.push(c);
    }
    format!("![{alt}]({url})")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_are_read_from_bytes() {
        assert_eq!(sniff_attachment(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0]), Some("image/png"));
        assert_eq!(sniff_attachment(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(sniff_attachment(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_attachment(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_attachment(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None);
        assert_eq!(sniff_attachment(b"%PDF-1.7"), None);
        assert_eq!(sniff_attachment(&[]), None);
        for kind in ATTACHMENT_TYPES {
            assert!(kind.starts_with("image/"));
        }
    }

    #[test]
    fn names_and_markdown() {
        assert_eq!(attachment_name("shots/preview.png"), "preview.png");
        assert_eq!(attachment_name("C:\\tmp\\a b.png"), "a b.png");
        assert_eq!(attachment_name("  \n"), "image");
        assert_eq!(attachment_name(&"x".repeat(500)).chars().count(), MAX_ATTACHMENT_NAME_CHARS);
        assert_eq!(attachment_markdown("preview.png", "https://g1tusercontent.com/attachments/ab"), "![preview.png](https://g1tusercontent.com/attachments/ab)");
        assert_eq!(attachment_markdown("a]b[c\\", "u"), "![a\\]b\\[c\\\\](u)");
        assert_eq!(normalize_content_type("Image/JPG; q=1"), "image/jpeg");
        assert_eq!(attachment_path("ab"), "/attachments/ab");
        assert!(is_attachment_id(&"0a".repeat(32)));
        assert!(!is_attachment_id(&"0A".repeat(32)));
        assert!(!is_attachment_id("abc"));
    }

    #[test]
    fn meta_fits_in_kv_metadata() {
        let meta = AttachmentMeta {
            content_type: "image/webp".into(),
            name: "é".repeat(MAX_ATTACHMENT_NAME_CHARS),
            repo_id: "repo_01m4z09g22e7ysqpg2ha423cws".into(),
            user_id: "usr_01m4z09g22e7ysqpg2ha423cws".into(),
            size: MAX_ATTACHMENT_BYTES as u64,
            at: 1_792_627_200_000,
        };
        assert!(serde_json::to_string(&meta).unwrap().len() <= 1024);
    }
}
