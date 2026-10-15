//! A repository's files at a branch, tag or commit as one archive, at
//! GitHub's addresses: `GET /repos/{owner}/{repo}/tarball/{ref}` and
//! `/zipball/{ref}` (and without a ref, the default branch).
//!
//! As GitHub's redirect to codeload, these answer `302 Found` with a link to
//! the site's archive route (apps/web routes/repo/archive.ts) for the commit
//! the ref names, carrying a token the repos service made for whoever asked
//! (services/repos archive_links.rs). The link is good for 10 minutes and
//! needs no token of its own, so a client following the redirect, which
//! drops its `Authorization` header on the way, gets a private
//! repository's files too. The archive holds one folder,
//! `<owner>-<repo>-<short sha>/`, as GitHub's does: `actions/checkout`
//! downloads one this way in a job container without git, and expects it.

use g1t_contracts::repos::{ArchiveLink, ArchiveLinkArgs};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::operations::{Services, repo_path};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchiveOp {
    DownloadTarball,
    DownloadZipball,
}

impl ArchiveOp {
    #[cfg(test)]
    pub const ALL: [ArchiveOp; 2] = [ArchiveOp::DownloadTarball, ArchiveOp::DownloadZipball];

    pub fn name(self) -> &'static str {
        match self {
            ArchiveOp::DownloadTarball => "download_tarball_archive",
            ArchiveOp::DownloadZipball => "download_zipball_archive",
        }
    }

    /// For the API reference.
    pub fn title(self) -> &'static str {
        match self {
            ArchiveOp::DownloadTarball => "Download a repository archive (tar)",
            ArchiveOp::DownloadZipball => "Download a repository archive (zip)",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            ArchiveOp::DownloadTarball => "A link to download a branch, tag or commit as a gzipped tar archive (the default branch without ref), good for 10 minutes and needing no token. Over REST, GET …/tarball/{ref} answers 302 with the link in Location, as GitHub does: `curl -L` follows it. Over MCP the link is returned as url, with commit and expires_at. The archive holds one folder, <owner>-<repo>-<first 7 of the commit>/, with executable files and symlinks as git has them and the commit in its pax header. Up to 10,000 files and 24 MB; clone a larger repository. Needs the Read role; a public repository's are open to anyone.",
            ArchiveOp::DownloadZipball => "A link to download a branch, tag or commit as a zip archive (the default branch without ref), good for 10 minutes and needing no token. Over REST, GET …/zipball/{ref} answers 302 with the link in Location, as GitHub does: `curl -L` follows it. Over MCP the link is returned as url, with commit and expires_at. The archive holds one folder, <owner>-<repo>-<first 7 of the commit>/. Up to 10,000 files and 24 MB; clone a larger repository. Needs the Read role; a public repository's are open to anyone.",
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            ArchiveOp::DownloadTarball => "tar.gz",
            ArchiveOp::DownloadZipball => "zip",
        }
    }

    pub fn input(self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "repo": { "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." },
                "ref": { "type": "string", "description": "A branch, tag or commit; the default branch when left out. A branch with slashes is sent URL-encoded as one path segment." },
            },
            "required": ["repo"],
        })
    }
}

/// Where the site serves the archive of `link`.
pub fn archive_url(site: &str, link: &ArchiveLink, op: ArchiveOp) -> String {
    format!(
        "{site}/{}/{}/archive/{}.{}?token={}",
        link.repo.namespace,
        link.repo.name,
        link.commit,
        op.suffix(),
        link.token
    )
}

pub async fn run(op: ArchiveOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let Some(path) = repo_path(input) else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository as \"owner/name\"."));
    };
    let git_ref = input["ref"].as_str().map(str::trim).filter(|git_ref| !git_ref.is_empty()).map(str::to_owned);
    let found: Outcome<ArchiveLink> = g1t_kit::call(&services.repos, "archive_link", &ArchiveLinkArgs { path, viewer: viewer.clone(), git_ref }).await?;
    Ok(match found {
        Outcome::Ok(link) => Outcome::Ok(json!({
            "url": archive_url(&services.addresses.site, &link, op),
            "commit": link.commit,
            "expires_at": link.expires_at,
        })),
        Outcome::Fail(refused) => Outcome::Fail(refused),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link() -> ArchiveLink {
        let repo: g1t_contracts::repos::Repo = serde_json::from_value(json!({
            "id": "repo_1", "namespace": "acme", "name": "web", "isPrivate": true,
            "ownerId": "ws_1", "defaultBranch": "main", "forkOf": null, "createdAt": "2026-10-01T00:00:00.000Z",
        }))
        .unwrap();
        ArchiveLink { repo, commit: "4807077b296e6edbf410d55e72749d3e1170c291".into(), token: "abc_-123".into(), expires_at: "2026-10-12T00:10:00.000Z".into() }
    }

    #[test]
    fn the_link_is_the_sites_archive_of_the_commit() {
        let link = link();
        assert_eq!(
            archive_url("https://g1t.sh", &link, ArchiveOp::DownloadTarball),
            "https://g1t.sh/acme/web/archive/4807077b296e6edbf410d55e72749d3e1170c291.tar.gz?token=abc_-123"
        );
        assert_eq!(
            archive_url("http://localhost:8787", &link, ArchiveOp::DownloadZipball),
            "http://localhost:8787/acme/web/archive/4807077b296e6edbf410d55e72749d3e1170c291.zip?token=abc_-123"
        );
    }

    #[test]
    fn each_operation_is_described_with_a_schema() {
        for op in ArchiveOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::Archives(op)), "{}", op.name());
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            assert_eq!(op.input()["required"], json!(["repo"]));
            assert_eq!(g1t_contracts::scopes::scope_for(op.name()), Some(g1t_contracts::scopes::Scope::CodeRead), "{}", op.name());
        }
    }
}
