//! A repository's `actions/cache` entries over REST and MCP, in GitHub's
//! shapes: listing them, what they hold together against the repository's
//! quota, and deleting them by key or by id.
//!
//! The actions service keeps them and decides who may see and delete them
//! (services/actions/src/cache.rs); their bytes are in R2, which jobs reach
//! through `/actions/jobs/{job}/cache` and the toolkit's protocols, never
//! through these.

use g1t_contracts::actions::{CacheList, CacheUsage, CacheUsageArgs, CachesArgs, DeleteCachesArgs};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::operations::{Services, repo_path};

/// One operation on the cache.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CachesOp {
    ListCaches,
    GetCacheUsage,
    DeleteCachesByKey,
    DeleteCache,
}

impl CachesOp {
    /// Every one: `Op::ALL` lists each as `Op::Caches(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [CachesOp; 4] = [CachesOp::ListCaches, CachesOp::GetCacheUsage, CachesOp::DeleteCachesByKey, CachesOp::DeleteCache];

    pub fn name(self) -> &'static str {
        match self {
            CachesOp::ListCaches => "list_caches",
            CachesOp::GetCacheUsage => "get_cache_usage",
            CachesOp::DeleteCachesByKey => "delete_caches_by_key",
            CachesOp::DeleteCache => "delete_cache",
        }
    }

    /// For the API reference.
    pub fn title(self) -> &'static str {
        match self {
            CachesOp::ListCaches => "List a repository's caches",
            CachesOp::GetCacheUsage => "Get a repository's cache usage",
            CachesOp::DeleteCachesByKey => "Delete caches by key",
            CachesOp::DeleteCache => "Delete a cache by id",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            CachesOp::ListCaches => {
                "List the entries actions/cache has saved in a repository (total_count, actions_caches): each with its id (a number), key, ref (the ref whose run saved it; a pull request from outside saves under untrusted:<ref>), version (the hash of its paths; empty for one g1t's own actions/cache saved), size_in_bytes, created_at and last_accessed_at (its last restore or lookup). Narrow with key (entries whose key starts with it) and ref; order with sort (last_accessed_at, created_at or size_in_bytes; last_accessed_at by default) and direction (asc or desc; desc by default); page with page and per_page (30 by default, at most 100). Needs the Read role."
            }
            CachesOp::GetCacheUsage => {
                "What a repository's saved cache entries hold together: active_caches_size_in_bytes and active_caches_count, and quota_bytes, the most they may hold (10 GiB, or 100 GiB in a workspace on the g1t plan). Saving past it evicts the entries restored longest ago. Needs the Read role."
            }
            CachesOp::DeleteCachesByKey => {
                "Delete every cache entry whose key is exactly key, or only ref's when you give ref. Answers with the entries deleted, in list_caches' shape. Their bytes go at once, and a run that restores the key finds nothing until one saves it again. Needs the Write role."
            }
            CachesOp::DeleteCache => {
                "Delete one cache entry by its id, as list_caches gives it. Over REST it answers 204 with no body, as GitHub does. Needs the Write role."
            }
        }
    }

    /// Whether it changes anything: what its scope says, which a test holds
    /// it to.
    #[cfg(test)]
    pub fn writes(self) -> bool {
        matches!(self, CachesOp::DeleteCachesByKey | CachesOp::DeleteCache)
    }

    pub fn input(self) -> Value {
        let repo = json!({ "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." });
        let git_ref = json!({ "type": "string", "description": "A full ref, e.g. refs/heads/main or refs/pull/7/merge." });
        let (properties, required): (Value, &[&str]) = match self {
            CachesOp::ListCaches => (
                json!({
                    "repo": repo,
                    "key": { "type": "string", "description": "Only entries whose key starts with this." },
                    "ref": git_ref,
                    "sort": { "type": "string", "enum": ["last_accessed_at", "created_at", "size_in_bytes"], "description": "What to order by: last_accessed_at unless you say." },
                    "direction": { "type": "string", "enum": ["asc", "desc"], "description": "desc unless you say." },
                    "page": { "type": "integer", "description": "The page, from 1." },
                    "per_page": { "type": "integer", "description": "Entries a page: 30 unless you say, at most 100." },
                }),
                &["repo"],
            ),
            CachesOp::GetCacheUsage => (json!({ "repo": repo }), &["repo"]),
            CachesOp::DeleteCachesByKey => (
                json!({
                    "repo": repo,
                    "key": { "type": "string", "description": "The key, exactly." },
                    "ref": git_ref,
                }),
                &["repo", "key"],
            ),
            CachesOp::DeleteCache => (
                json!({ "repo": repo, "id": { "type": ["integer", "string"], "description": "The entry's id, a number." } }),
                &["repo", "id"],
            ),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

/// A number from a path segment, a query value or a JSON number.
fn number(input: &Value, key: &str) -> Option<u64> {
    match &input[key] {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn text(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned)
}

fn shown<T: serde::Serialize>(outcome: Outcome<T>) -> Outcome<Value> {
    match outcome {
        Outcome::Ok(value) => Outcome::Ok(serde_json::to_value(value).unwrap_or(Value::Null)),
        Outcome::Fail(refused) => Outcome::Fail(refused),
    }
}

pub async fn run(op: CachesOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let Some(repo) = repo_path(input) else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository as \"owner/name\"."));
    };
    let actions = &services.actions;
    Ok(match op {
        CachesOp::ListCaches => {
            let args = CachesArgs {
                repo,
                viewer: viewer.clone(),
                key: text(input, "key"),
                git_ref: text(input, "ref"),
                sort: text(input, "sort"),
                direction: text(input, "direction"),
                page: number(input, "page").map(|n| n.min(u64::from(u32::MAX)) as u32),
                per_page: number(input, "per_page").map(|n| n.min(100) as u32),
            };
            let found: Outcome<CacheList> = g1t_kit::call(actions, "caches", &args).await?;
            shown(found)
        }
        CachesOp::GetCacheUsage => {
            let found: Outcome<CacheUsage> =
                g1t_kit::call(actions, "cache_usage", &CacheUsageArgs { repo: repo.clone(), viewer: viewer.clone() }).await?;
            match found {
                Outcome::Ok(usage) => Outcome::Ok(json!({
                    "full_name": format!("{}/{}", repo.namespace, repo.name),
                    "active_caches_size_in_bytes": usage.active_caches_size_in_bytes,
                    "active_caches_count": usage.active_caches_count,
                    "quota_bytes": usage.quota_bytes,
                })),
                Outcome::Fail(refused) => Outcome::Fail(refused),
            }
        }
        CachesOp::DeleteCachesByKey | CachesOp::DeleteCache => {
            let Some(actor) = viewer.clone() else {
                return Ok(Outcome::fail(FailureCode::Unauthenticated, "Deleting cache entries needs a g1t access token."));
            };
            let args = if op == CachesOp::DeleteCache {
                let Some(id) = number(input, "id") else {
                    return Ok(Outcome::fail(FailureCode::Invalid, "Name the cache entry by its id, a number."));
                };
                DeleteCachesArgs { actor, repo, id: Some(id), key: None, git_ref: None }
            } else {
                let Some(key) = text(input, "key") else {
                    return Ok(Outcome::fail(FailureCode::Invalid, "Give the key of the entries to delete."));
                };
                DeleteCachesArgs { actor, repo, id: None, key: Some(key), git_ref: text(input, "ref") }
            };
            let done: Outcome<CacheList> = g1t_kit::call(actions, "delete_caches", &args).await?;
            shown(done)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::actions::CacheEntry;

    #[test]
    fn a_list_is_in_github_s_shape() {
        let list = CacheList {
            total_count: 1,
            actions_caches: vec![CacheEntry {
                id: 7,
                key: "npm-full-Linux-abc".into(),
                git_ref: "refs/heads/main".into(),
                version: String::new(),
                size_in_bytes: 1024,
                created_at: "2026-10-12T10:00:00.000Z".into(),
                last_accessed_at: "2026-10-12T11:00:00.000Z".into(),
            }],
        };
        let Outcome::Ok(sent) = shown(Outcome::Ok(list)) else { panic!() };
        assert_eq!(sent["actions_caches"][0]["ref"], "refs/heads/main");
        assert_eq!(sent["actions_caches"][0]["id"], 7);
        assert!(g1t_kit::wire::camel_case_keys(&sent).is_empty());
    }

    #[test]
    fn each_operation_is_described_with_a_schema() {
        for op in CachesOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::Caches(op)), "{}", op.name());
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            assert!(op.input()["required"].as_array().unwrap().contains(&json!("repo")), "{}", op.name());
            let level = g1t_contracts::scopes::scope_for(op.name()).unwrap().level();
            assert_eq!(op.writes(), level == g1t_contracts::scopes::Level::Write, "{}", op.name());
        }
    }
}
