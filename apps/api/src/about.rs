//! A repository's About over REST and MCP: its languages, contributors and
//! license (read from the default branch in the background and kept by
//! commit), stars, and releases. The repos service decides who may see
//! and change each (`g1t_contracts::about`).

use g1t_contracts::about::*;
use g1t_contracts::repos::RepoPath;
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use worker::Result;

use crate::operations::Services;

/// One operation on a repository's About, stars or releases.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AboutOp {
    GetLanguages,
    ListContributors,
    GetLicense,
    ListStargazers,
    ListStarred,
    CheckStarred,
    Star,
    Unstar,
    ListReleases,
    GetLatestRelease,
    GetReleaseByTag,
    GetRelease,
    CreateRelease,
    UpdateRelease,
    DeleteRelease,
}

impl AboutOp {
    /// Every one: `Op::ALL` lists each as `Op::About(…)`, which a test checks.
    #[cfg(test)]
    pub const ALL: [AboutOp; 15] = [
        AboutOp::GetLanguages,
        AboutOp::ListContributors,
        AboutOp::GetLicense,
        AboutOp::ListStargazers,
        AboutOp::ListStarred,
        AboutOp::CheckStarred,
        AboutOp::Star,
        AboutOp::Unstar,
        AboutOp::ListReleases,
        AboutOp::GetLatestRelease,
        AboutOp::GetReleaseByTag,
        AboutOp::GetRelease,
        AboutOp::CreateRelease,
        AboutOp::UpdateRelease,
        AboutOp::DeleteRelease,
    ];

    pub fn name(self) -> &'static str {
        match self {
            AboutOp::GetLanguages => "get_languages",
            AboutOp::ListContributors => "list_contributors",
            AboutOp::GetLicense => "get_license",
            AboutOp::ListStargazers => "list_stargazers",
            AboutOp::ListStarred => "list_starred",
            AboutOp::CheckStarred => "check_starred",
            AboutOp::Star => "star_repo",
            AboutOp::Unstar => "unstar_repo",
            AboutOp::ListReleases => "list_releases",
            AboutOp::GetLatestRelease => "get_latest_release",
            AboutOp::GetReleaseByTag => "get_release_by_tag",
            AboutOp::GetRelease => "get_release",
            AboutOp::CreateRelease => "create_release",
            AboutOp::UpdateRelease => "update_release",
            AboutOp::DeleteRelease => "delete_release",
        }
    }

    /// For the API reference: "List a repository's languages".
    pub fn title(self) -> &'static str {
        match self {
            AboutOp::GetLanguages => "Get a repository's languages",
            AboutOp::ListContributors => "List a repository's contributors",
            AboutOp::GetLicense => "Get a repository's license",
            AboutOp::ListStargazers => "List who starred a repository",
            AboutOp::ListStarred => "List repositories you starred",
            AboutOp::CheckStarred => "Check whether you starred a repository",
            AboutOp::Star => "Star a repository",
            AboutOp::Unstar => "Unstar a repository",
            AboutOp::ListReleases => "List releases",
            AboutOp::GetLatestRelease => "Get the latest release",
            AboutOp::GetReleaseByTag => "Get a release by its tag",
            AboutOp::GetRelease => "Get a release",
            AboutOp::CreateRelease => "Create a release",
            AboutOp::UpdateRelease => "Update a release",
            AboutOp::DeleteRelease => "Delete a release",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            AboutOp::GetLanguages => "The languages a repository's default branch is written in, by bytes, largest first: each with its name, color, bytes and percent. Programming and markup languages count; data (JSON, YAML) and prose (Markdown) do not, nor do vendored, generated and documentation files, unless the repository's .gitattributes says otherwise (linguist-vendored, linguist-generated, linguist-documentation, linguist-language, linguist-detectable). Worked out in the background for the default branch's head and kept by commit: commit says which commit the answer is for, and pending is true while the first is worked out (ask again in a few seconds). partial is true when the repository was too large to read in full.",
            AboutOp::ListContributors => "Everyone whose commits are on a repository's default branch, most commits first: each with kind (user, matched to an account by an address they confirmed or their noreply address; g1t, g1t itself; author, anyone else, by the name on their commits), name, username and avatar for a user, commits, first_at, last_at, and weeks (commits per week, for the 100 most active). total is how many there are (at most 500 are listed), commits how many were read (the newest 3,000), and weeks the repository's commits by week, oldest first. Worked out in the background and kept by commit, as for get_languages.",
            AboutOp::GetLicense => "The license in a repository's LICENSE file (or LICENCE, COPYING, UNLICENSE, with or without an extension) on its default branch: its spdx_id (null when the text is not one g1t recognizes), name (\"Other\" then) and path. Not found when it has none, or before the default branch has been read the first time.",
            AboutOp::ListStargazers => "Who starred a repository, newest first: each username, avatar and starred_at. 100 a page; page from 1.",
            AboutOp::ListStarred => "The repositories you starred that you can still see, newest first, at most 100: each repository, when you starred it (starred_at) and how many stars it has.",
            AboutOp::CheckStarred => "Whether you starred a repository (starred), and how many people have (stars).",
            AboutOp::Star => "Star a repository you can see. Starring one you starred already changes nothing. Returns starred and the count of stars. People only: a workspace's or an agent's token cannot.",
            AboutOp::Unstar => "Take back your star from a repository. Returns starred (false) and the count of stars.",
            AboutOp::ListReleases => "A repository's releases, newest first, at most 100: each with its id (rel_…), tag_name, target (the commit the tag named), name, body (Markdown notes), draft, prerelease, author, created_at, published_at and latest (the newest published release that is neither a draft nor a prerelease). Drafts are listed only to those with the Write role.",
            AboutOp::GetLatestRelease => "The latest release: the newest published release that is neither a draft nor a prerelease. Not found when there is none.",
            AboutOp::GetReleaseByTag => "The release of one tag. A tag with slashes is URL-encoded in the path.",
            AboutOp::GetRelease => "One release by its id (rel_…), with its tag, target commit, title, notes and whether it is a draft, a prerelease or the latest. A draft is found only by those with the Write role.",
            AboutOp::CreateRelease => "Publish a release of a tag, with a title (release_name; name in the answer) and notes (body, Markdown). A tag that does not exist yet is made at target (a branch or commit; the default branch when left out), as a lightweight tag, under the repository's tag rulesets. draft keeps it from everyone without the Write role until it is published; prerelease marks it not ready for everyone, so it is never the latest. One release per tag. Needs the Write role.",
            AboutOp::UpdateRelease => "Change a release's name, body, draft or prerelease; fields left out stay as they are, and an empty release_name clears it. Setting draft to false publishes it (published_at is set the first time). Needs the Write role.",
            AboutOp::DeleteRelease => "Delete a release. Its tag stays: delete that with git (git push origin :refs/tags/<tag>). Needs the Write role.",
        }
    }

    /// Whether the operation is about one repository named by `repo`.
    pub fn needs_repo(self) -> bool {
        self != AboutOp::ListStarred
    }

    /// Whether an anonymous caller may use it, on a public repository.
    pub fn anonymous(self) -> bool {
        matches!(
            self,
            AboutOp::GetLanguages
                | AboutOp::ListContributors
                | AboutOp::GetLicense
                | AboutOp::ListStargazers
                | AboutOp::ListReleases
                | AboutOp::GetLatestRelease
                | AboutOp::GetReleaseByTag
                | AboutOp::GetRelease
        )
    }

    /// Whether it is about the caller's own stars: nobody else's business,
    /// so not audited.
    pub fn personal(self) -> bool {
        matches!(self, AboutOp::ListStarred | AboutOp::CheckStarred | AboutOp::Star | AboutOp::Unstar)
    }

    pub fn input(self) -> Value {
        let repo = || json!({ "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." });
        let id = || json!({ "type": "string", "description": "The release's id: rel_…" });
        let release_fields = |mut properties: Value| {
            properties["release_name"] = json!({ "type": "string", "description": "Its title (name in the answer), at most 200 characters; under a repository's address `name` is the repository's. The tag's name is shown when it has none." });
            properties["body"] = json!({ "type": "string", "description": "Its notes, Markdown, at most 125,000 characters." });
            properties["draft"] = json!({ "type": "boolean", "description": "Seen only by those with the Write role until published." });
            properties["prerelease"] = json!({ "type": "boolean", "description": "Not ready for everyone: never the latest release." });
            properties
        };
        let (properties, required): (Value, &[&str]) = match self {
            AboutOp::GetLanguages
            | AboutOp::ListContributors
            | AboutOp::GetLicense
            | AboutOp::CheckStarred
            | AboutOp::Star
            | AboutOp::Unstar
            | AboutOp::ListReleases
            | AboutOp::GetLatestRelease => (json!({ "repo": repo() }), &["repo"]),
            AboutOp::ListStargazers => (
                json!({ "repo": repo(), "page": { "type": "integer", "description": "The page, from 1; 100 a page." } }),
                &["repo"],
            ),
            AboutOp::ListStarred => (json!({}), &[]),
            AboutOp::GetReleaseByTag => (
                json!({ "repo": repo(), "tag": { "type": "string", "description": "The tag's name, such as v1.2.0." } }),
                &["repo", "tag"],
            ),
            AboutOp::GetRelease | AboutOp::DeleteRelease => (json!({ "repo": repo(), "id": id() }), &["repo", "id"]),
            AboutOp::CreateRelease => (
                release_fields(json!({
                    "repo": repo(),
                    "tag_name": { "type": "string", "description": "The tag to release, such as v1.2.0. Made at target when it does not exist yet." },
                    "target": { "type": "string", "description": "A branch or commit to make a new tag at. The default branch when left out; ignored for a tag that exists." },
                })),
                &["repo", "tag_name"],
            ),
            AboutOp::UpdateRelease => (release_fields(json!({ "repo": repo(), "id": id() })), &["repo", "id"]),
        };
        let mut schema = json!({ "type": "object", "properties": properties });
        if !required.is_empty() {
            schema["required"] = json!(required);
        }
        schema
    }
}

fn text(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
}

/// A string that may be given empty, to clear it.
fn given(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::to_owned)
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

fn number(input: &Value, key: &str) -> Option<u32> {
    match &input[key] {
        Value::Number(number) => number.as_u64().and_then(|n| u32::try_from(n).ok()),
        Value::String(digits) => digits.trim().parse().ok(),
        _ => None,
    }
}

async fn call<A: Serialize, T: DeserializeOwned>(services: &Services, method: &str, args: &A) -> Result<Outcome<T>> {
    g1t_kit::call(&services.repos, method, args).await
}

fn ok<T: Serialize>(value: &T) -> Result<Outcome<Value>> {
    Ok(Outcome::Ok(serde_json::to_value(value)?))
}

fn out<T: Serialize>(outcome: Outcome<T>) -> Result<Outcome<Value>> {
    match outcome {
        Outcome::Ok(value) => ok(&value),
        Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
    }
}

pub async fn run(op: AboutOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let actor = || viewer.clone().unwrap_or_default();
    if op == AboutOp::ListStarred {
        let username = actor().username;
        let starred: Vec<StarredRepo> = g1t_kit::call(&services.repos, "starred", &StarredArgs { username, viewer: viewer.clone() }).await?;
        return ok(&starred);
    }
    let Some(path) = crate::operations::repo_path(input) else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository as \"owner/name\"."));
    };
    let view = |path: RepoPath| RepoViewArgs { path, viewer: viewer.clone() };
    let release = |path: RepoPath, id: Option<String>, tag: Option<String>, latest: bool| ReleaseArgs { path, viewer: viewer.clone(), id, tag, latest };
    match op {
        AboutOp::GetLanguages => out(call::<_, Languages>(services, "languages", &view(path)).await?),
        AboutOp::ListContributors => out(call::<_, Contributors>(services, "contributors", &view(path)).await?),
        AboutOp::GetLicense => match call::<_, Option<License>>(services, "license", &view(path)).await? {
            Outcome::Ok(Some(license)) => ok(&license),
            Outcome::Ok(None) => Ok(Outcome::fail(
                FailureCode::NotFound,
                "No license file was found on the default branch. A repository just pushed to is read in the background: try again in a moment.",
            )),
            Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
        },
        AboutOp::ListStargazers => {
            out(call::<_, Vec<Stargazer>>(services, "stargazers", &StargazersArgs { path, viewer: viewer.clone(), page: number(input, "page") }).await?)
        }
        AboutOp::CheckStarred => out(call::<_, Stars>(services, "stars", &view(path)).await?),
        AboutOp::Star | AboutOp::Unstar => {
            out(call::<_, Stars>(services, "star", &StarArgs { path, actor: actor(), starred: op == AboutOp::Star }).await?)
        }
        AboutOp::ListReleases => out(call::<_, Vec<Release>>(services, "releases", &view(path)).await?),
        AboutOp::GetLatestRelease => out(call::<_, Release>(services, "release", &release(path, None, None, true)).await?),
        AboutOp::GetReleaseByTag => {
            let Some(tag) = text(input, "tag") else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Name the tag."));
            };
            out(call::<_, Release>(services, "release", &release(path, None, Some(tag), false)).await?)
        }
        AboutOp::GetRelease => {
            let Some(id) = text(input, "id") else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give the release's id."));
            };
            out(call::<_, Release>(services, "release", &release(path, Some(id), None, false)).await?)
        }
        AboutOp::CreateRelease => {
            let Some(tag_name) = text(input, "tag_name") else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Name the tag to release: tag_name."));
            };
            let args = CreateReleaseArgs {
                path,
                actor: actor(),
                tag_name,
                target: text(input, "target"),
                name: text(input, "release_name"),
                body: given(input, "body"),
                draft: flag(input, "draft").unwrap_or(false),
                prerelease: flag(input, "prerelease").unwrap_or(false),
            };
            out(call::<_, Release>(services, "create_release", &args).await?)
        }
        AboutOp::UpdateRelease => {
            let Some(id) = text(input, "id") else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give the release's id."));
            };
            let args = UpdateReleaseArgs {
                path,
                actor: actor(),
                id,
                name: given(input, "release_name"),
                body: given(input, "body"),
                draft: flag(input, "draft"),
                prerelease: flag(input, "prerelease"),
            };
            out(call::<_, Release>(services, "update_release", &args).await?)
        }
        AboutOp::DeleteRelease => {
            let Some(id) = text(input, "id") else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give the release's id."));
            };
            match call::<_, bool>(services, "delete_release", &DeleteReleaseArgs { path, actor: actor(), id }).await? {
                Outcome::Ok(deleted) => ok(&json!({ "deleted": deleted })),
                Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
            }
        }
        AboutOp::ListStarred => unreachable!("answered above"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_operation_is_described_with_a_schema() {
        for op in AboutOp::ALL {
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            let schema = op.input();
            assert_eq!(schema["type"], "object");
            if op.needs_repo() {
                assert!(schema["required"].as_array().unwrap().contains(&json!("repo")), "{}", op.name());
            }
        }
    }

    #[test]
    fn every_operation_is_one_of_the_api_s() {
        for op in AboutOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::About(op)), "{}", op.name());
        }
    }

    #[test]
    fn inputs_are_read_loosely() {
        let input = json!({ "draft": "true", "prerelease": false, "page": "2", "name": "" });
        assert_eq!(flag(&input, "draft"), Some(true));
        assert_eq!(flag(&input, "prerelease"), Some(false));
        assert_eq!(flag(&input, "missing"), None);
        assert_eq!(number(&input, "page"), Some(2));
        assert_eq!(given(&input, "name").as_deref(), Some(""), "an empty release_name clears it");
        assert_eq!(text(&input, "name"), None);
    }
}
