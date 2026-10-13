//! `g1t cache`: the repository's actions/cache entries, what they hold
//! against its quota, and deleting them.

use serde_json::{Value, json};

use crate::chunk::human;
use crate::cli::{CacheCommand, CacheDeleteArgs, CacheListArgs, CacheSort, SortOrder};
use crate::context::Ctx;
use crate::error::Result;
use crate::output::{Cell, ago, s};

pub fn run(ctx: &Ctx, command: CacheCommand) -> Result<()> {
    match command {
        CacheCommand::List(args) => list(ctx, args),
        CacheCommand::Usage => usage(ctx),
        CacheCommand::Delete(args) => delete(ctx, args),
    }
}

fn sort_name(sort: CacheSort) -> &'static str {
    match sort {
        CacheSort::LastAccessedAt => "last_accessed_at",
        CacheSort::CreatedAt => "created_at",
        CacheSort::SizeInBytes => "size_in_bytes",
    }
}

fn bytes(row: &Value, key: &str) -> u64 {
    row[key].as_u64().unwrap_or(0)
}

fn list(ctx: &Ctx, args: CacheListArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let limit = args.limit.max(1);
    let mut caches = Vec::new();
    let mut total = 0;
    // Pages of at most 100, until the limit or the end.
    for page in 1.. {
        let found = client
            .op("list_caches")
            .repo(&repo)
            .query_opt("key", args.key.clone())
            .query_opt("ref", args.git_ref.clone())
            .query("sort", sort_name(args.sort))
            .query(
                "direction",
                if args.order == SortOrder::Asc {
                    "asc"
                } else {
                    "desc"
                },
            )
            .query("per_page", limit.min(100))
            .query("page", page)
            .send()?;
        total = found["total_count"].as_u64().unwrap_or(0);
        let rows = super::items(found, "actions_caches");
        let last = rows.len() < limit.min(100);
        caches.extend(rows);
        if last || caches.len() >= limit {
            break;
        }
    }
    caches.truncate(limit);
    if ctx.out.structured() {
        return ctx.out.emit(&Value::Array(caches));
    }
    if caches.is_empty() {
        eprintln!("No cache entries in {repo}.");
        return Ok(());
    }
    let out = &ctx.out;
    let rows: Vec<Vec<Cell>> = caches
        .iter()
        .map(|c| {
            let id = c["id"].to_string();
            vec![
                Cell::styled(id.clone(), out.dim(&id)),
                Cell::new(s(c, "key")),
                Cell::styled(s(c, "ref"), out.cyan(s(c, "ref"))),
                Cell::new(human(bytes(c, "size_in_bytes"))),
                Cell::styled(ago(s(c, "created_at")), out.dim(&ago(s(c, "created_at")))),
                Cell::styled(
                    ago(s(c, "last_accessed_at")),
                    out.dim(&ago(s(c, "last_accessed_at"))),
                ),
            ]
        })
        .collect();
    out.table(&["id", "key", "ref", "size", "saved", "last used"], &rows)?;
    if (caches.len() as u64) < total {
        eprintln!("{} of {total} entries; --limit shows more.", caches.len());
    }
    Ok(())
}

fn usage(ctx: &Ctx) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let found = client.op("get_cache_usage").repo(&repo).send()?;
    if ctx.out.structured() {
        return ctx.out.emit(&found);
    }
    let held = bytes(&found, "active_caches_size_in_bytes");
    let quota = bytes(&found, "quota_bytes");
    let count = bytes(&found, "active_caches_count");
    let share = if quota > 0 {
        format!(" ({:.0}%)", held as f64 * 100.0 / quota as f64)
    } else {
        String::new()
    };
    println!(
        "{repo}: {count} {} holding {} of {}{share}",
        if count == 1 { "entry" } else { "entries" },
        human(held),
        human(quota),
    );
    Ok(())
}

/// An id is all digits; anything else is a key.
fn is_id(entry: &str) -> bool {
    !entry.is_empty() && entry.bytes().all(|b| b.is_ascii_digit())
}

fn delete(ctx: &Ctx, args: CacheDeleteArgs) -> Result<()> {
    let (repo, client) = ctx.repo_client()?;
    let deleted = if is_id(&args.entry) {
        client
            .op("delete_cache")
            .repo(&repo)
            .arg("id", &args.entry)
            .send()?;
        vec![json!({ "id": args.entry.parse::<u64>().unwrap_or_default() })]
    } else {
        let found = client
            .op("delete_caches_by_key")
            .repo(&repo)
            .query("key", &args.entry)
            .query_opt("ref", args.git_ref.clone())
            .send()?;
        super::items(found, "actions_caches")
    };
    if ctx.out.structured() {
        return ctx.out.emit(&Value::Array(deleted));
    }
    let what = if is_id(&args.entry) {
        format!("cache entry {}", args.entry)
    } else {
        let n = deleted.len();
        format!(
            "{n} cache {} with the key {}",
            if n == 1 { "entry" } else { "entries" },
            args.entry
        )
    };
    eprintln!("{} Deleted {what} from {repo}.", ctx.out.green("✓"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_number_is_an_id_and_anything_else_a_key() {
        assert!(is_id("9184"));
        assert!(!is_id("cargo-test-Linux-1.99.0-abc"));
        assert!(!is_id("12a"));
        assert!(!is_id(""));
    }

    #[test]
    fn sorts_are_github_s_names() {
        assert_eq!(sort_name(CacheSort::LastAccessedAt), "last_accessed_at");
        assert_eq!(sort_name(CacheSort::SizeInBytes), "size_in_bytes");
    }
}
