//! `g1t attach FILE...`: upload images to show in a work item, a pull request
//! or a comment, and print the Markdown that shows each. `--attach FILE`
//! on `g1t work new`, `g1t work comment`, `g1t pr create`, `g1t pr
//! comment` and `g1t pr ready` does the same and adds the Markdown to the
//! text ([`with_attachments`]). An agent shows a screenshot of its preview
//! this way, instead of committing the image to the repository.

use base64::Engine;
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::cli::AttachArgs;
use crate::client::Client;
use crate::context::Ctx;
use crate::error::{Error, Result};
use crate::output::s;
use crate::repo::Repo;

/// The largest file the API takes, as `MAX_ATTACHMENT_BYTES` in the contracts.
pub const MAX_BYTES: u64 = 10 * 1024 * 1024;

pub fn run(ctx: &Ctx, args: AttachArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let mut uploaded = Vec::with_capacity(args.files.len());
    for file in &args.files {
        uploaded.push(upload(&client, &repo, file)?);
    }
    if ctx.out.structured() {
        return match <[Value; 1]>::try_from(uploaded) {
            Ok([one]) => ctx.out.emit(&one),
            Err(many) => ctx.out.emit(&Value::Array(many)),
        };
    }
    for attachment in &uploaded {
        println!("{}", s(attachment, "markdown"));
    }
    Ok(())
}

/// The type a file's name says it is, which the API checks against its bytes.
pub fn content_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Uploads one file to `repo`: `{ id, name, url, markdown, content_type, size }`.
pub fn upload(client: &Client, repo: &Repo, path: &Path) -> Result<Value> {
    let (name, kind, data) = read(path)?;
    client.op("upload_attachment").repo(repo).field("name", name).field_opt("content_type", kind).field("data", data).send()
}

/// Uploads one file to work item `number` of `workspace`, which keeps it:
/// one filed with no repository takes files too.
pub fn upload_to_item(client: &Client, workspace: &str, number: u64, path: &Path) -> Result<Value> {
    let (name, kind, data) = read(path)?;
    client
        .op("upload_work_item_attachment")
        .arg("workspace", workspace)
        .arg("number", number)
        .field("name", name)
        .field_opt("content_type", kind)
        .field("data", data)
        .send()
}

/// A file's name, the type its name says and its bytes in base64, once it
/// is known to be small enough.
fn read(path: &Path) -> Result<(String, Option<&'static str>, String)> {
    let shown = path.display();
    let size = std::fs::metadata(path).map_err(|error| Error::usage(format!("{shown}: {error}")))?.len();
    if size > MAX_BYTES {
        return Err(Error::usage(format!(
            "{shown} is {:.1} MB; an attachment can be at most {} MB.",
            size as f64 / 1024.0 / 1024.0,
            MAX_BYTES / 1024 / 1024
        )));
    }
    let bytes = std::fs::read(path).map_err(|error| Error::usage(format!("{shown}: {error}")))?;
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("image").to_owned();
    Ok((name, content_type(path), base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// `body` with the Markdown of each of `files` after it, uploaded to
/// `repo`, one to a line; `body` as it is with no files.
pub fn with_attachments(client: &Client, repo: &Repo, body: Option<String>, files: &[PathBuf]) -> Result<Option<String>> {
    if files.is_empty() {
        return Ok(body);
    }
    let mut markdown = Vec::with_capacity(files.len());
    for file in files {
        let uploaded = upload(client, repo, file)?;
        markdown.push(s(&uploaded, "markdown").to_owned());
    }
    Ok(Some(appended(body.as_deref(), &markdown)))
}

/// As [`with_attachments`], with the files kept by work item `number` of
/// `workspace`.
pub fn with_item_attachments(
    client: &Client,
    workspace: &str,
    number: u64,
    body: Option<String>,
    files: &[PathBuf],
) -> Result<Option<String>> {
    if files.is_empty() {
        return Ok(body);
    }
    let mut markdown = Vec::with_capacity(files.len());
    for file in files {
        let uploaded = upload_to_item(client, workspace, number, file)?;
        markdown.push(s(&uploaded, "markdown").to_owned());
    }
    Ok(Some(appended(body.as_deref(), &markdown)))
}

/// `body`, then a blank line, then each image's Markdown on a line of its own.
pub fn appended(body: Option<&str>, markdown: &[String]) -> String {
    let images = markdown.join("\n");
    match body.map(str::trim_end).filter(|body| !body.is_empty()) {
        Some(body) => format!("{body}\n\n{images}"),
        None => images,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_follow_the_extension() {
        assert_eq!(content_type(Path::new("shots/Preview.PNG")), Some("image/png"));
        assert_eq!(content_type(Path::new("a.jpg")), Some("image/jpeg"));
        assert_eq!(content_type(Path::new("a.webp")), Some("image/webp"));
        assert_eq!(content_type(Path::new("a.svg")), None);
        assert_eq!(content_type(Path::new("README")), None);
    }

    #[test]
    fn images_go_after_the_text() {
        let images = vec!["![a.png](u1)".to_owned(), "![b.png](u2)".to_owned()];
        assert_eq!(appended(Some("Looks right.\n"), &images), "Looks right.\n\n![a.png](u1)\n![b.png](u2)");
        assert_eq!(appended(None, &images[..1]), "![a.png](u1)");
        assert_eq!(appended(Some("  "), &images[..1]), "![a.png](u1)");
    }
}
