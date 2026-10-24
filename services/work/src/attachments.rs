//! Files put in a work item's, a pull request's or a comment's Markdown
//! (`upload_attachment`): whoever may comment on a repository, or on a work
//! item, may add one, as an agent shows a screenshot of its preview in a
//! pull request instead of committing the image. The bytes go in the
//! usercontent namespace (`AVATARS`) under `attachments/<id>`, which the
//! usercontent origin serves at `/attachments/<id>`
//! (apps/web/workers/usercontent.ts); a row here names the repository, or
//! the work item and its workspace, so a purged repository's or a deleted
//! workspace's go with it ([`purge`], [`purge_workspace`]). See
//! `g1t_contracts::attachments`.

use base64::Engine;
use g1t_contracts::access::Capability;
use g1t_contracts::attachments::{
    ATTACHMENT_KEY_PREFIX, ATTACHMENT_TYPES, Attachment, AttachmentMeta, MAX_ATTACHMENT_BYTES, UploadAttachmentArgs, attachment_name,
    attachment_path, normalize_content_type, sniff_attachment,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome};
use g1t_kit::now_ms;
use worker::kv::KvStore;
use worker::{Env, Result};

use crate::retired::writable;
use crate::{UNVERIFIED, Work, items};

/// Unwraps an `Outcome`, returning its failure from the enclosing method.
macro_rules! check {
    ($outcome:expr) => {
        match $outcome {
            Outcome::Ok(value) => value,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        }
    };
}

/// `repo.purged`: the repository's rows, `?1` its id (its bytes go first, [`purge`]).
pub(crate) const PURGED: &str = "DELETE FROM attachments WHERE repo_id = ?1";

/// `workspace.deleted`: its work items' rows, `?1` its slug (their bytes
/// go first, [`purge_workspace`]).
pub(crate) const DELETED: &[&str] = &["DELETE FROM attachments WHERE workspace = ?1"];

/// `workspace.renamed`: its work items' rows follow (`?1` the slug now,
/// `?2` before).
pub(crate) const RENAMED: &[&str] = &["UPDATE attachments SET workspace = ?1 WHERE workspace = ?2"];

const MB: usize = 1024 * 1024;

/// What the file is, read from its bytes, or why it is refused.
pub(crate) fn checked(data: &str, content_type: Option<&str>) -> Outcome<(Vec<u8>, &'static str)> {
    // Base64 is four characters for three bytes: refuse a file far too
    // large before decoding it.
    if data.len() / 4 * 3 > MAX_ATTACHMENT_BYTES + 3 {
        return too_large();
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.trim()) else {
        return Outcome::fail(FailureCode::Invalid, "data must be the file, base64-encoded.");
    };
    if bytes.is_empty() {
        return Outcome::fail(FailureCode::Invalid, "The file is empty.");
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return too_large();
    }
    let Some(kind) = sniff_attachment(&bytes) else {
        return unsupported();
    };
    if let Some(given) = content_type.map(normalize_content_type).filter(|given| !given.is_empty()) {
        if given != kind {
            return Outcome::fail(
                FailureCode::UnsupportedType,
                format!("The file is {kind}, not {given}: send its own content_type, or none."),
            );
        }
    }
    Outcome::Ok((bytes, kind))
}

fn too_large<T>() -> Outcome<T> {
    Outcome::fail(FailureCode::TooLarge, format!("An attachment can be at most {} MB.", MAX_ATTACHMENT_BYTES / MB))
}

fn unsupported<T>() -> Outcome<T> {
    let names: Vec<&str> = ATTACHMENT_TYPES.iter().map(|kind| kind.trim_start_matches("image/")).collect();
    Outcome::fail(
        FailureCode::UnsupportedType,
        format!("An attachment must be an image: {} (by its bytes, not its name).", names.join(", ").to_uppercase()),
    )
}

/// 256 random bits, in hex: an attachment's id, and its address's secret.
fn new_attachment_id() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("no source of randomness");
    hex::encode(bytes)
}

fn store(env: &Env) -> Result<KvStore> {
    env.kv("AVATARS")
}

impl Work {
    /// `upload_attachment`: as `add_comment` checks who may comment (a
    /// confirmed account that can read the repository, which is not
    /// archived, or that may take part in the work item), then keeps the
    /// file.
    pub(crate) async fn upload_attachment(&self, env: &Env, a: UploadAttachmentArgs) -> Result<Outcome<Attachment>> {
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, UNVERIFIED));
        }
        let (bytes, content_type) = check!(checked(&a.data, a.content_type.as_deref()));
        // What it is kept by: the repository, or the work item and its workspace.
        let (repo_id, item) = match &a.repo {
            Some(path) => {
                let repo = check!(self.repo(path, &Some(a.actor.clone())).await?);
                check!(writable(&repo));
                (Some(repo.id), None)
            }
            None => {
                let Some(number) = a.number.filter(|number| *number > 0) else {
                    return Ok(Outcome::fail(FailureCode::Invalid, "Say which repository, or which work item (workspace and number)."));
                };
                let held = check!(items::for_viewer(self, &Some(a.actor.clone()), &a.workspace, number, Capability::Participate).await?);
                (None, Some((held.item.id, held.item.workspace)))
            }
        };
        let name = attachment_name(&a.name);
        let id = new_attachment_id();
        let now = now_ms();
        let size = bytes.len() as u64;
        store(env)?
            .put_bytes(&format!("{ATTACHMENT_KEY_PREFIX}{id}"), &bytes)?
            .metadata(AttachmentMeta {
                content_type: content_type.to_owned(),
                name: name.clone(),
                repo_id: repo_id.clone(),
                item_id: item.as_ref().map(|(id, _)| id.clone()),
                user_id: a.actor.id.clone(),
                size,
                at: now,
            })?
            .execute()
            .await?;
        self.db
            .prepare(
                "INSERT INTO attachments (id, repo_id, item_id, workspace, user_id, name, content_type, size, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                crate::optional(&repo_id),
                crate::optional(&item.as_ref().map(|(id, _)| id.clone())),
                crate::optional(&item.as_ref().map(|(_, workspace)| workspace.clone())),
                a.actor.id.as_str().into(),
                name.as_str().into(),
                content_type.into(),
                (size as f64).into(),
                rfc3339(now).into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(Attachment { path: attachment_path(&id), id, name, content_type: content_type.to_owned(), size }))
    }
}

/// `repo.purged`: deletes the repository's attachments' bytes; its rows go
/// with [`PURGED`], after.
pub(crate) async fn purge(env: &Env, db: &worker::D1Database, repo_id: &str) -> Result<()> {
    purge_where(env, db, "repo_id = ?1", repo_id).await
}

/// `workspace.deleted`: deletes the bytes of its work items' attachments;
/// their rows go with [`DELETED`], after.
pub(crate) async fn purge_workspace(env: &Env, db: &worker::D1Database, workspace: &str) -> Result<()> {
    purge_where(env, db, "workspace = ?1", &workspace.to_lowercase()).await
}

async fn purge_where(env: &Env, db: &worker::D1Database, condition: &str, value: &str) -> Result<()> {
    #[derive(serde::Deserialize)]
    struct Row {
        id: String,
    }
    let rows: Vec<Row> =
        db.prepare(format!("SELECT id FROM attachments WHERE {condition}")).bind(&[value.into()])?.all().await?.results()?;
    if rows.is_empty() {
        return Ok(());
    }
    let kv = store(env)?;
    for row in rows {
        kv.delete(&format!("{ATTACHMENT_KEY_PREFIX}{}", row.id)).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

    fn refusal<T>(outcome: Outcome<T>) -> (FailureCode, String) {
        match outcome {
            Outcome::Fail(failure) => (failure.code, failure.message),
            Outcome::Ok(_) => panic!("was not refused"),
        }
    }

    #[test]
    fn an_image_is_taken_by_its_bytes() {
        match checked(&b64(PNG), None) {
            Outcome::Ok((bytes, kind)) => {
                assert_eq!(bytes, PNG);
                assert_eq!(kind, "image/png");
            }
            Outcome::Fail(failure) => panic!("{}", failure.message),
        }
        assert!(matches!(checked(&b64(PNG), Some("image/PNG")), Outcome::Ok(_)));
        assert!(matches!(checked(&b64(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpg")), Outcome::Ok((_, "image/jpeg"))));
    }

    #[test]
    fn other_types_are_unsupported() {
        let (code, message) = refusal(checked(&b64(b"<svg onload=alert(1)>"), Some("image/svg+xml")));
        assert_eq!(code, FailureCode::UnsupportedType);
        assert!(message.contains("PNG, JPEG, GIF, WEBP"), "{message}");
        // A PNG said to be a JPEG.
        let (code, message) = refusal(checked(&b64(PNG), Some("image/jpeg")));
        assert_eq!(code, FailureCode::UnsupportedType);
        assert!(message.contains("image/png, not image/jpeg"), "{message}");
        assert_eq!(code.http_status(), 415);
    }

    #[test]
    fn too_large_is_refused_before_and_after_decoding() {
        let mut big = PNG.to_vec();
        big.resize(MAX_ATTACHMENT_BYTES + 1, 0);
        let (code, message) = refusal(checked(&b64(&big), None));
        assert_eq!(code, FailureCode::TooLarge);
        assert_eq!(code.http_status(), 413);
        assert!(message.contains("10 MB"));
        let mut most = PNG.to_vec();
        most.resize(MAX_ATTACHMENT_BYTES, 0);
        assert!(matches!(checked(&b64(&most), None), Outcome::Ok(_)));
        assert_eq!(refusal(checked(&"A".repeat(MAX_ATTACHMENT_BYTES * 2), None)).0, FailureCode::TooLarge);
    }

    #[test]
    fn not_base64_or_empty_is_invalid() {
        assert_eq!(refusal(checked("not base64!", None)).0, FailureCode::Invalid);
        assert_eq!(refusal(checked("", None)).0, FailureCode::Invalid);
    }

    #[test]
    fn ids_are_attachment_ids() {
        let id = new_attachment_id();
        assert!(g1t_contracts::attachments::is_attachment_id(&id), "{id}");
        assert_ne!(id, new_attachment_id());
    }

    #[test]
    fn purging_takes_the_repository_id() {
        assert_eq!(g1t_kit::transfer::parameters(PURGED), 1);
        assert_eq!(g1t_kit::transfer::parameters(DELETED[0]), 1);
        assert_eq!(g1t_kit::rename::parameters(RENAMED[0]), 2);
    }

    #[test]
    fn a_work_item_keeps_attachments_of_its_own() {
        let db = crate::migrated::database();
        db.execute_batch(
            "INSERT INTO attachments (id, repo_id, user_id, name, content_type, size, created_at)
               VALUES ('a1', 'rep_1', 'usr_1', 'one.png', 'image/png', 1, 'now');
             INSERT INTO attachments (id, item_id, workspace, user_id, name, content_type, size, created_at)
               VALUES ('a2', 'wki_1', 'acme', 'usr_1', 'two.png', 'image/png', 1, 'now');",
        )
        .unwrap();
        // Each names a repository or a work item.
        let neither = "INSERT INTO attachments (id, user_id, name, content_type, size, created_at) VALUES ('a3', 'usr_1', 'x', 'image/png', 1, 'now')";
        assert!(db.execute(neither, []).is_err());
        db.execute(RENAMED[0], ["globex", "acme"]).unwrap();
        db.execute(PURGED, ["rep_1"]).unwrap();
        let left: Vec<(String, String)> = db
            .prepare("SELECT id, workspace FROM attachments")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(left, vec![("a2".to_owned(), "globex".to_owned())]);
        db.execute(DELETED[0], ["globex"]).unwrap();
        let none: u32 = db.query_row("SELECT count(*) FROM attachments", [], |row| row.get(0)).unwrap();
        assert_eq!(none, 0);
    }
}
