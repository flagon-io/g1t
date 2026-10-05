//! A person's work, for their profile: the issues and pull requests they
//! opened, newest first, a page at a time.
//!
//! Only work on repositories the viewer may read is ever shown, counted or
//! named. Which those are is the repos service's decision (`readable`, the
//! same check as opening the repository), made once per request over every
//! repository the person has worked in; every query here is then confined
//! to that set. A private repository's titles, numbers and even its
//! existence never reach anyone who could not open it.

use std::collections::HashMap;

use g1t_contracts::identity::UsernameArgs;
use g1t_contracts::repos::{ReadableArgs, Repo, RepoPath, MAX_READABLE};
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;

#[derive(Deserialize)]
struct ItemRow {
    kind: AuthoredKind,
    id: String,
    repo_id: String,
    number: u32,
    title: String,
    state: State,
    reason: Option<IssueReason>,
    status: Option<PullStatus>,
    created_at: String,
    updated_at: String,
    merged_at: Option<String>,
}

#[derive(Deserialize)]
struct RepoCount {
    repo_id: String,
    n: u32,
}

/// Where a page ends: the sort key and id of its last item.
fn cursor(sort: AuthoredSort, row: &ItemRow) -> String {
    let key = match sort {
        AuthoredSort::Updated => &row.updated_at,
        AuthoredSort::Created | AuthoredSort::Oldest => &row.created_at,
    };
    format!("{key}|{}", row.id)
}

/// A cursor read back, or none if it is not one.
fn parse_cursor(value: &str) -> Option<(&str, &str)> {
    let (key, id) = value.split_once('|')?;
    (!key.is_empty() && !id.is_empty() && !id.contains('|')).then_some((key, id))
}

/// One bound value; made a `JsValue` only when bound, so the SQL can be
/// built and tested outside a Worker.
enum Param {
    Text(String),
    Number(u32),
}

impl From<&str> for Param {
    fn from(value: &str) -> Self {
        Param::Text(value.to_owned())
    }
}

impl From<u32> for Param {
    fn from(value: u32) -> Self {
        Param::Number(value)
    }
}

/// Parameters bound by number, so each can be used more than once.
struct Params(Vec<Param>);

impl Params {
    fn push(&mut self, value: impl Into<Param>) -> String {
        self.0.push(value.into());
        format!("?{}", self.0.len())
    }

    fn values(&self) -> Vec<JsValue> {
        self.0
            .iter()
            .map(|param| match param {
                Param::Text(text) => JsValue::from(text.as_str()),
                Param::Number(n) => JsValue::from(*n),
            })
            .collect()
    }
}

/// The work SQL for one page: the person's issues and pull requests in
/// `visible` as one list, filtered, ordered and cut to `limit + 1` rows.
fn page_sql(a: &ByAuthorArgs, params: &mut Params, author: &str, visible: &str, limit: u32) -> String {
    let author = params.push(author);
    let visible = params.push(visible);
    let mut conditions = Vec::new();
    if let Some(kind) = a.kind {
        conditions.push(format!(
            "kind = {}",
            params.push(match kind {
                AuthoredKind::Issue => "issue",
                AuthoredKind::Pull => "pull",
            })
        ));
    }
    match a.state {
        Some(AuthoredState::Open) => conditions.push("state = 'open'".to_owned()),
        Some(AuthoredState::Closed) => conditions.push("state = 'closed'".to_owned()),
        Some(AuthoredState::Merged) => conditions.push("status = 'merged'".to_owned()),
        None => {}
    }
    let (key, direction, beyond) = match a.sort {
        AuthoredSort::Created => ("created_at", "DESC", "<"),
        AuthoredSort::Updated => ("updated_at", "DESC", "<"),
        AuthoredSort::Oldest => ("created_at", "ASC", ">"),
    };
    if let Some((after_key, after_id)) = a.before.as_deref().and_then(parse_cursor) {
        let after_key = params.push(after_key);
        let after_id = params.push(after_id);
        conditions.push(format!(
            "({key} {beyond} {after_key} OR ({key} = {after_key} AND id {beyond} {after_id}))"
        ));
    }
    let filter = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let limit = params.push(limit + 1);
    format!(
        "SELECT * FROM (
           SELECT 'issue' AS kind, id, repo_id, number, title, state, reason,
             NULL AS status, created_at, updated_at, NULL AS merged_at
           FROM issues
           WHERE author_id = {author} AND repo_id IN (SELECT value FROM json_each({visible}))
           UNION ALL
           SELECT 'pull' AS kind, id, repo_id, number, title,
             CASE WHEN status IN ('draft', 'open') THEN 'open' ELSE 'closed' END AS state,
             NULL AS reason, status, created_at, updated_at, merged_at
           FROM pulls
           WHERE author_id = {author} AND repo_id IN (SELECT value FROM json_each({visible}))
         ) AS work
         {filter}
         ORDER BY {key} {direction}, id {direction}
         LIMIT {limit}"
    )
}

const COUNTS_SQL: &str = "SELECT
   (SELECT count(*) FROM pulls WHERE author_id = ?1
      AND repo_id IN (SELECT value FROM json_each(?2)) AND status = 'merged') AS pulls_merged,
   (SELECT count(*) FROM pulls WHERE author_id = ?1
      AND repo_id IN (SELECT value FROM json_each(?2)) AND status IN ('draft', 'open')) AS pulls_open,
   (SELECT count(*) FROM pulls WHERE author_id = ?1
      AND repo_id IN (SELECT value FROM json_each(?2))) AS pulls,
   (SELECT count(*) FROM issues WHERE author_id = ?1
      AND repo_id IN (SELECT value FROM json_each(?2))) AS issues,
   (SELECT count(*) FROM issues WHERE author_id = ?1
      AND repo_id IN (SELECT value FROM json_each(?2)) AND state = 'open') AS issues_open";

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct CountsRow {
    pulls_merged: u32,
    pulls_open: u32,
    pulls: u32,
    issues: u32,
    issues_open: u32,
}

/// Whether `repo` is the one named `namespace/name`.
fn is_named(repo: &Repo, name: &str) -> bool {
    name.split_once('/').is_some_and(|(namespace, name)| {
        repo.namespace.eq_ignore_ascii_case(namespace) && repo.name.eq_ignore_ascii_case(name)
    })
}

impl Work {
    pub(crate) async fn by_author(&self, a: ByAuthorArgs) -> Result<Outcome<Authored>> {
        let person: Viewer = g1t_kit::call(
            &self.identity,
            "user_by_username",
            &UsernameArgs {
                username: a.username.trim().to_lowercase(),
            },
        )
        .await?;
        let Some(person) = person else {
            return Ok(Outcome::fail(FailureCode::NotFound, "There is no such account."));
        };

        // Every repository they have opened work in, busiest first...
        let touched = self
            .db
            .prepare(
                "SELECT repo_id, count(*) AS n FROM (
                   SELECT repo_id FROM issues WHERE author_id = ?1
                   UNION ALL SELECT repo_id FROM pulls WHERE author_id = ?1
                 ) GROUP BY repo_id ORDER BY n DESC LIMIT ?2",
            )
            .bind(&[person.id.as_str().into(), (MAX_READABLE as u32).into()])?
            .all()
            .await?
            .results::<RepoCount>()?;
        if touched.is_empty() {
            return Ok(Outcome::Ok(Authored::default()));
        }
        // ...and of those, the ones the viewer may read.
        let readable: Vec<Repo> = g1t_kit::call(
            &self.repos,
            "readable",
            &ReadableArgs {
                ids: touched.iter().map(|row| row.repo_id.clone()).collect(),
                viewer: a.viewer.clone(),
            },
        )
        .await?;
        let by_id: HashMap<&str, &Repo> = readable.iter().map(|repo| (repo.id.as_str(), repo)).collect();
        let repos: Vec<AuthoredRepo> = touched
            .iter()
            .filter_map(|row| {
                by_id.get(row.repo_id.as_str()).map(|repo| AuthoredRepo {
                    repo: RepoPath {
                        namespace: repo.namespace.clone(),
                        name: repo.name.clone(),
                    },
                    count: row.n,
                })
            })
            .collect();
        if readable.is_empty() {
            return Ok(Outcome::Ok(Authored::default()));
        }

        let all_ids: Vec<&str> = readable.iter().map(|repo| repo.id.as_str()).collect();
        let all = serde_json::to_string(&all_ids)?;
        let counts = self
            .db
            .prepare(COUNTS_SQL)
            .bind(&[person.id.as_str().into(), all.as_str().into()])?
            .first::<CountsRow>(None)
            .await?
            .map(|row| AuthoredCounts {
                pulls_merged: row.pulls_merged,
                pulls_open: row.pulls_open,
                pulls: row.pulls,
                issues: row.issues,
                issues_open: row.issues_open,
            })
            .unwrap_or_default();

        // A repository filter narrows the set; one the viewer cannot read,
        // or the person never worked in, leaves nothing.
        let shown = match a.repo.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
            Some(name) => serde_json::to_string(
                &readable
                    .iter()
                    .filter(|repo| is_named(repo, name))
                    .map(|repo| repo.id.as_str())
                    .collect::<Vec<_>>(),
            )?,
            None => all,
        };
        let limit = a.limit.unwrap_or(AUTHORED_PAGE).clamp(1, AUTHORED_PAGE);
        let mut params = Params(Vec::new());
        let sql = page_sql(&a, &mut params, &person.id, &shown, limit);
        let mut rows = self
            .db
            .prepare(sql)
            .bind(&params.values())?
            .all()
            .await?
            .results::<ItemRow>()?;
        let next = if rows.len() > limit as usize {
            rows.truncate(limit as usize);
            rows.last().map(|row| cursor(a.sort, row))
        } else {
            None
        };
        let items = rows
            .into_iter()
            .filter_map(|row| {
                let repo = by_id.get(row.repo_id.as_str())?;
                Some(AuthoredItem {
                    kind: row.kind,
                    repo: RepoPath {
                        namespace: repo.namespace.clone(),
                        name: repo.name.clone(),
                    },
                    number: row.number,
                    title: row.title,
                    state: row.state,
                    draft: row.status == Some(PullStatus::Draft),
                    merged: row.status == Some(PullStatus::Merged),
                    status: row.status,
                    reason: row.reason,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    merged_at: row.merged_at,
                })
            })
            .collect();
        Ok(Outcome::Ok(Authored {
            items,
            next,
            counts,
            repos,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> ByAuthorArgs {
        ByAuthorArgs {
            username: "ada".into(),
            viewer: None,
            kind: None,
            state: None,
            repo: None,
            sort: AuthoredSort::Created,
            before: None,
            limit: None,
        }
    }

    fn row(created: &str, updated: &str, id: &str) -> ItemRow {
        ItemRow {
            kind: AuthoredKind::Pull,
            id: id.into(),
            repo_id: "rep_1".into(),
            number: 1,
            title: "t".into(),
            state: State::Open,
            reason: None,
            status: Some(PullStatus::Open),
            created_at: created.into(),
            updated_at: updated.into(),
            merged_at: None,
        }
    }

    #[test]
    fn every_query_is_confined_to_the_readable_set() {
        let mut params = Params(Vec::new());
        let sql = page_sql(&args(), &mut params, "usr_1", "[]", 25);
        assert_eq!(sql.matches("json_each(?2)").count(), 2);
        assert_eq!(sql.matches("author_id = ?1").count(), 2);
        assert_eq!(COUNTS_SQL.matches("json_each(?2)").count(), 5);
        assert!(sql.contains("LIMIT ?3"));
        assert!(sql.contains("ORDER BY created_at DESC, id DESC"));
    }

    #[test]
    fn filters_by_kind_state_and_page() {
        let mut params = Params(Vec::new());
        let a = ByAuthorArgs {
            kind: Some(AuthoredKind::Pull),
            state: Some(AuthoredState::Merged),
            sort: AuthoredSort::Oldest,
            before: Some("2026-10-01T00:00:00.000Z|pul_9".into()),
            ..args()
        };
        let sql = page_sql(&a, &mut params, "usr_1", "[]", 10);
        assert!(sql.contains("kind = ?3"));
        assert!(sql.contains("status = 'merged'"));
        assert!(sql.contains("(created_at > ?4 OR (created_at = ?4 AND id > ?5))"));
        assert!(sql.contains("ORDER BY created_at ASC, id ASC"));
        assert!(sql.contains("LIMIT ?6"));
        assert_eq!(params.0.len(), 6);
    }

    #[test]
    fn ignores_a_cursor_that_is_not_one() {
        let mut params = Params(Vec::new());
        let a = ByAuthorArgs {
            before: Some("nonsense".into()),
            ..args()
        };
        let sql = page_sql(&a, &mut params, "usr_1", "[]", 10);
        assert!(!sql.contains(" OR ("));
        assert_eq!(parse_cursor("a|b|c"), None);
        assert_eq!(parse_cursor("|b"), None);
        assert_eq!(parse_cursor("k|i"), Some(("k", "i")));
    }

    #[test]
    fn a_cursor_names_the_sort_key() {
        let r = row("2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "pul_1");
        assert_eq!(cursor(AuthoredSort::Created, &r), "2026-01-01T00:00:00.000Z|pul_1");
        assert_eq!(cursor(AuthoredSort::Updated, &r), "2026-02-01T00:00:00.000Z|pul_1");
        assert_eq!(parse_cursor(&cursor(AuthoredSort::Oldest, &r)), Some(("2026-01-01T00:00:00.000Z", "pul_1")));
    }

    #[test]
    fn names_a_repository_by_its_path() {
        let repo = Repo {
            id: "rep_1".into(),
            namespace: "acme".into(),
            name: "Rocket".into(),
            description: None,
            is_private: false,
            owner_id: "usr_1".into(),
            default_branch: "main".into(),
            fork_of: None,
            protected: false,
            created_at: String::new(),
        };
        assert!(is_named(&repo, "acme/rocket"));
        assert!(is_named(&repo, "ACME/Rocket"));
        assert!(!is_named(&repo, "acme"));
        assert!(!is_named(&repo, "other/rocket"));
    }
}
