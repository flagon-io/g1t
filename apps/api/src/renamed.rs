//! Old workspace slugs, after a rename. An operation that names a
//! repository (`owner/name`) or a workspace by a slug the workspace has
//! since been renamed from is run again under the slug it has now, so
//! scripts and agents written against the old address keep working while
//! it redirects.

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
