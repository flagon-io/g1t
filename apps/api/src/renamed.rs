//! Old addresses: a workspace's slug after a rename, and a repository's
//! path after a transfer.
//!
//! Old workspace slugs, after a rename. An operation that names a
//! repository (`owner/name`) or a workspace by a slug the workspace has
//! since been renamed from is run again under the slug it has now, so
//! scripts and agents written against the old address keep working while
//! it redirects. A workspace alias g1t's staff set (identity's aliases.rs:
//! `g1t` for `flagon-io`) resolves the same way, for good, so responses
//! name the workspace by its own slug.

use g1t_contracts::identity::SlugArgs;
use serde_json::Value;
use worker::Result;

use crate::operations::Services;

/// The workspace slug an operation's input names: the owner in `repo`, or
/// `workspace`.
pub fn named_slug(input: &Value) -> Option<&str> {
    input["repo"]
        .as_str()
        .and_then(|repo| repo.split_once('/'))
        .map(|(owner, _)| owner)
        .or_else(|| input["workspace"].as_str())
        .filter(|slug| !slug.is_empty())
}

/// `input` with `old` replaced by `new` wherever it names the workspace.
pub fn rewrite(input: &Value, old: &str, new: &str) -> Value {
    let mut input = input.clone();
    if let Some(repo) = input["repo"].as_str()
        && let Some((owner, name)) = repo.split_once('/')
        && owner.eq_ignore_ascii_case(old)
    {
        input["repo"] = Value::String(format!("{new}/{name}"));
    }
    if input["workspace"]
        .as_str()
        .is_some_and(|workspace| workspace.eq_ignore_ascii_case(old))
    {
        input["workspace"] = Value::String(new.to_owned());
    }
    input
}

/// The input under the workspace's current slug, if it names an old one.
pub async fn retarget(services: &Services, input: &Value) -> Result<Option<Value>> {
    let Some(old) = named_slug(input) else {
        return Ok(None);
    };
    let current: Option<String> = g1t_kit::call(
        &services.identity,
        "resolve_slug",
        &SlugArgs {
            slug: old.to_owned(),
        },
    )
    .await?;
    Ok(current.map(|new| rewrite(input, old, &new)))
}

/// The input under a transferred repository's path now, if `repo` names
/// the path it left.
pub async fn transferred(services: &Services, input: &Value) -> Result<Option<Value>> {
    let Some((namespace, name)) = input["repo"].as_str().and_then(|repo| repo.split_once('/')) else {
        return Ok(None);
    };
    let now: Option<g1t_contracts::repos::RepoPath> = g1t_kit::call(
        &services.repos,
        "resolve_path",
        &g1t_contracts::repos::ResolvePathArgs {
            path: g1t_contracts::repos::RepoPath {
                namespace: namespace.to_owned(),
                name: name.to_owned(),
            },
        },
    )
    .await?;
    Ok(now.map(|path| moved_to(input, &format!("{}/{}", path.namespace, path.name))))
}

/// `input` with `repo` replaced by `path`.
pub fn moved_to(input: &Value, path: &str) -> Value {
    let mut input = input.clone();
    input["repo"] = Value::String(path.to_owned());
    input
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_the_slug_an_operation_names() {
        assert_eq!(named_slug(&json!({ "repo": "acme/rocket" })), Some("acme"));
        assert_eq!(named_slug(&json!({ "workspace": "acme" })), Some("acme"));
        assert_eq!(named_slug(&json!({ "id": "x" })), None);
    }

    #[test]
    fn a_transferred_repository_is_named_by_its_new_path() {
        let input = json!({ "repo": "syntaqx/g1t", "number": 4 });
        assert_eq!(
            moved_to(&input, "flagon-io/g1t"),
            json!({ "repo": "flagon-io/g1t", "number": 4 })
        );
    }

    #[test]
    fn an_alias_is_run_again_under_its_workspace() {
        let input = json!({ "repo": "g1t/g1t", "number": 7 });
        assert_eq!(named_slug(&input), Some("g1t"));
        assert_eq!(
            rewrite(&input, "g1t", "flagon-io"),
            json!({ "repo": "flagon-io/g1t", "number": 7 })
        );
        assert_eq!(
            rewrite(&json!({ "workspace": "G1T" }), "g1t", "flagon-io"),
            json!({ "workspace": "flagon-io" })
        );
    }

    #[test]
    fn rewrites_only_the_old_slug() {
        let input = json!({ "repo": "Acme/rocket", "workspace": "acme", "title": "acme/x" });
        assert_eq!(
            rewrite(&input, "acme", "acme-inc"),
            json!({ "repo": "acme-inc/rocket", "workspace": "acme-inc", "title": "acme/x" })
        );
        let other = json!({ "repo": "globex/rocket" });
        assert_eq!(rewrite(&other, "acme", "acme-inc"), other);
    }
}
