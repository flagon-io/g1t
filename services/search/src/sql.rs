//! The SQL each search runs, built from a parsed query and its reader.
//! Pure: what is asked of D1 is tested here, including that every query
//! of repository content carries the visibility check.

use serde::Serialize;

use g1t_contracts::search::COUNT_CAP;

use crate::query::{Filter, ItemKind, ItemState, Query, Visibility, path_pattern};
use crate::visibility::{Reader, clause};

/// A value bound to a `?`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Param {
    Text(String),
    Int(i64),
    Null,
}

impl Param {
    /// Text, or null when there is none.
    pub fn opt(value: Option<&str>) -> Param {
        value.map_or(Param::Null, |text| Param::Text(text.to_owned()))
    }
}

impl From<&str> for Param {
    fn from(value: &str) -> Param {
        Param::Text(value.to_owned())
    }
}

impl From<String> for Param {
    fn from(value: String) -> Param {
        Param::Text(value)
    }
}

/// A statement and its values, in order.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Sql {
    pub text: String,
    pub params: Vec<Param>,
}

/// Conditions joined with AND, each with its values.
#[derive(Default)]
struct Where {
    parts: Vec<String>,
    params: Vec<Param>,
}

impl Where {
    fn add(&mut self, condition: impl Into<String>, params: Vec<Param>) {
        self.parts.push(condition.into());
        self.params.extend(params);
    }

    fn text(&self) -> String {
        if self.parts.is_empty() { "1".to_owned() } else { self.parts.join(" AND ") }
    }
}

fn json(values: &[String]) -> Param {
    Param::Text(serde_json::to_string(values).unwrap_or_else(|_| "[]".into()))
}

/// `column IN (…)` for kept values, `NOT IN` for left-out ones.
fn in_list(filter: &Filter, column: &str, out: &mut Where) {
    if !filter.include.is_empty() {
        out.add(format!("{column} IN (SELECT value FROM json_each(?))"), vec![json(&filter.include)]);
    }
    if !filter.exclude.is_empty() {
        out.add(format!("COALESCE({column}, '') NOT IN (SELECT value FROM json_each(?))"), vec![json(&filter.exclude)]);
    }
}

/// What every query of repository content starts with: the visibility
/// check, then `repo:`, `org:` and `is:public`/`is:private`.
fn scope(query: &Query, reader: &Reader, alias: &str) -> Where {
    let mut out = Where::default();
    out.add(clause(alias), vec![Param::Text(reader.namespaces_json()), Param::Text(reader.granted_json())]);
    in_list(&query.repos, &format!("({alias}.namespace || '/' || {alias}.name)"), &mut out);
    in_list(&query.owners, &format!("{alias}.namespace"), &mut out);
    match query.visibility {
        Some(Visibility::Public) => out.add(format!("{alias}.private = 0"), vec![]),
        Some(Visibility::Private) => out.add(format!("{alias}.private = 1"), vec![]),
        None => {}
    }
    out
}

/// A page: `LIMIT ? OFFSET ?`.
#[derive(Clone, Copy, Debug)]
pub struct Page {
    pub limit: u32,
    pub offset: u32,
}

fn paged(mut sql: Sql, page: Page) -> Sql {
    sql.text.push_str(" LIMIT ? OFFSET ?");
    sql.params.push(Param::Int(i64::from(page.limit)));
    sql.params.push(Param::Int(i64::from(page.offset)));
    sql
}

/// How many rows `select` returns, stopping at one past [`COUNT_CAP`].
pub fn count(select: &Sql) -> Sql {
    Sql {
        text: format!("SELECT count(*) AS n FROM ({} LIMIT {})", select.text, COUNT_CAP + 1),
        params: select.params.clone(),
    }
}

/// The words of a query as one lowercase string, for an exact-name boost.
fn exact(query: &Query) -> String {
    query.positive().map(|term| term.text.to_lowercase()).collect::<Vec<_>>().join(" ")
}

// ---- Repositories ----------------------------------------------------------

const REPO_COLUMNS: &str = "r.repo_id, r.namespace, r.name, r.description, r.topics, r.language, r.private, r.pushed_at, r.created_at";

/// Repositories matching the query, without order or page.
fn repos_select(query: &Query, reader: &Reader) -> (Sql, bool) {
    let mut filters = scope(query, reader, "r");
    in_list(&query.languages, "r.language", &mut filters);
    match query.prose_match() {
        Some(expression) => {
            let mut params = vec![Param::Text(expression)];
            params.extend(filters.params.clone());
            (
                Sql {
                    text: format!(
                        "SELECT {REPO_COLUMNS}, snippet(repos_fts, 4, '', '', '…', 24) AS readme \
                         FROM repos_fts JOIN repos r ON r.rid = repos_fts.rowid \
                         WHERE repos_fts MATCH ? AND {}",
                        filters.text()
                    ),
                    params,
                },
                true,
            )
        }
        None => (
            Sql {
                text: format!("SELECT {REPO_COLUMNS}, NULL AS readme FROM repos r WHERE {}", filters.text()),
                params: filters.params,
            },
            false,
        ),
    }
}

pub fn repos_count(query: &Query, reader: &Reader) -> Sql {
    count(&repos_select(query, reader).0)
}

pub fn repos_page(query: &Query, reader: &Reader, page: Page) -> Sql {
    let (mut sql, text) = repos_select(query, reader);
    if text {
        let name = exact(query);
        sql.text.push_str(
            " ORDER BY (r.name = ? OR (r.namespace || '/' || r.name) = ?) DESC, \
             bm25(repos_fts, 3.0, 10.0, 4.0, 6.0, 1.0), r.pushed_at DESC",
        );
        sql.params.push(Param::Text(name.clone()));
        sql.params.push(Param::Text(name));
    } else {
        sql.text.push_str(" ORDER BY COALESCE(r.pushed_at, r.created_at) DESC, r.rid DESC");
    }
    paged(sql, page)
}

// ---- Code ------------------------------------------------------------------

/// How a code search reads the index.
#[derive(Clone, Debug, PartialEq)]
pub enum CodePlan {
    /// Through the trigram index; `short` words are matched directly.
    Index { expression: String, short: Vec<String> },
    /// Words too short for the index, in named repositories only.
    Scan { short: Vec<String> },
    /// No words: the files of named repositories, by path.
    Files,
}

/// How to search code for a query, or why it cannot be.
pub fn code_plan(query: &Query) -> Result<CodePlan, &'static str> {
    let (expression, short) = query.code_match();
    let scoped = !query.repos.include.is_empty();
    match expression {
        Some(expression) => Ok(CodePlan::Index { expression, short }),
        None if !scoped => Err("Code search needs a word of at least three characters, or repo:owner/name."),
        None if short.is_empty() => Ok(CodePlan::Files),
        None => Ok(CodePlan::Scan { short }),
    }
}

fn code_filters(query: &Query, reader: &Reader) -> Where {
    let mut filters = scope(query, reader, "r");
    in_list(&query.languages, "fl.language", &mut filters);
    if !query.paths.include.is_empty() {
        let any = vec!["fl.path LIKE ? ESCAPE '\\'"; query.paths.include.len()].join(" OR ");
        filters.add(format!("({any})"), query.paths.include.iter().map(|p| Param::Text(path_pattern(p))).collect());
    }
    for path in &query.paths.exclude {
        filters.add("fl.path NOT LIKE ? ESCAPE '\\'", vec![Param::Text(path_pattern(path))]);
    }
    filters
}

fn short_words(short: &[String], column: &str, out: &mut Where) {
    for word in short {
        out.add(format!("instr(lower({column}), ?) > 0"), vec![Param::Text(word.to_lowercase())]);
    }
}

/// Matching files, one row each (`fid`, `score`), without order or page.
fn code_select(plan: &CodePlan, query: &Query, reader: &Reader) -> Sql {
    let mut filters = code_filters(query, reader);
    match plan {
        CodePlan::Index { expression, short } => {
            short_words(short, "c.content", &mut filters);
            let mut params = vec![Param::Text(expression.clone())];
            params.extend(filters.params.clone());
            Sql {
                // bm25() cannot be called inside an aggregate; the rank
                // column can, weighted as the migration sets it.
                text: format!(
                    "SELECT c.fid AS fid, MIN(chunks_fts.rank) AS score, fl.path AS path                      FROM chunks_fts JOIN chunks c ON c.cid = chunks_fts.rowid                      JOIN files fl ON fl.fid = c.fid JOIN repos r ON r.repo_id = fl.repo_id                      WHERE chunks_fts MATCH ? AND {} GROUP BY c.fid",
                    filters.text()
                ),
                params,
            }
        }
        CodePlan::Scan { short } => {
            short_words(short, "c.content", &mut filters);
            Sql {
                text: format!(
                    "SELECT c.fid AS fid, 0 AS score, fl.path AS path \
                     FROM chunks c JOIN files fl ON fl.fid = c.fid JOIN repos r ON r.repo_id = fl.repo_id \
                     WHERE {} GROUP BY c.fid",
                    filters.text()
                ),
                params: filters.params,
            }
        }
        CodePlan::Files => {
            filters.add("fl.skipped IS NULL", vec![]);
            Sql {
                text: format!(
                    "SELECT fl.fid AS fid, 0 AS score, fl.path AS path \
                     FROM files fl JOIN repos r ON r.repo_id = fl.repo_id WHERE {}",
                    filters.text()
                ),
                params: filters.params,
            }
        }
    }
}

pub fn code_count(plan: &CodePlan, query: &Query, reader: &Reader) -> Sql {
    count(&code_select(plan, query, reader))
}

pub fn code_page(plan: &CodePlan, query: &Query, reader: &Reader, page: Page) -> Sql {
    let mut sql = code_select(plan, query, reader);
    sql.text.push_str(" ORDER BY score, path");
    paged(sql, page)
}

/// The files of a page: where each is and in which repository.
pub fn code_files(fids: &[i64]) -> Sql {
    Sql {
        text: "SELECT fl.fid, fl.path, fl.language, r.repo_id, r.namespace, r.name, r.default_branch, r.private \
               FROM files fl JOIN repos r ON r.repo_id = fl.repo_id \
               WHERE fl.fid IN (SELECT value FROM json_each(?))"
            .to_owned(),
        params: vec![Param::Text(serde_json::to_string(fids).unwrap_or_else(|_| "[]".into()))],
    }
}

/// The pieces of a page's files that matched, at most `limit`.
pub fn code_pieces(plan: &CodePlan, fids: &[i64], limit: u32) -> Sql {
    let ids = Param::Text(serde_json::to_string(fids).unwrap_or_else(|_| "[]".into()));
    match plan {
        CodePlan::Index { expression, .. } => Sql {
            text: "SELECT c.fid, c.start_line, c.content FROM chunks_fts JOIN chunks c ON c.cid = chunks_fts.rowid \
                   WHERE chunks_fts MATCH ? AND c.fid IN (SELECT value FROM json_each(?)) \
                   ORDER BY c.fid, c.start_line LIMIT ?"
                .to_owned(),
            params: vec![Param::Text(expression.clone()), ids, Param::Int(i64::from(limit))],
        },
        CodePlan::Scan { short } => {
            let mut filters = Where::default();
            filters.add("c.fid IN (SELECT value FROM json_each(?))", vec![ids]);
            short_words(short, "c.content", &mut filters);
            let mut params = filters.params;
            params.push(Param::Int(i64::from(limit)));
            Sql {
                text: format!(
                    "SELECT c.fid, c.start_line, c.content FROM chunks c WHERE {} ORDER BY c.fid, c.start_line LIMIT ?",
                    filters.parts.join(" AND ")
                ),
                params,
            }
        }
        CodePlan::Files => first_pieces(fids),
    }
}

/// The first piece of each file, for files that matched by name.
pub fn first_pieces(fids: &[i64]) -> Sql {
    Sql {
        text: "SELECT c.fid, c.start_line, c.content FROM chunks c \
               WHERE c.fid IN (SELECT value FROM json_each(?)) AND c.start_line = 1"
            .to_owned(),
        params: vec![Param::Text(serde_json::to_string(fids).unwrap_or_else(|_| "[]".into()))],
    }
}

// ---- Issues and pull requests ----------------------------------------------

const ITEM_COLUMNS: &str = "i.kind, i.number, i.title, i.state, i.status, i.author, i.requested_by, i.labels, i.updated_at, \
                            r.repo_id, r.namespace, r.name, r.private";

fn items_select(query: &Query, reader: &Reader, kind: ItemKind) -> (Sql, bool) {
    let mut filters = scope(query, reader, "r");
    filters.add("i.kind = ?", vec![Param::Text(if kind == ItemKind::Issue { "issue" } else { "pull" }.into())]);
    match query.state {
        Some(ItemState::Open) => filters.add("i.state = 'open'", vec![]),
        Some(ItemState::Closed) => filters.add("i.state = 'closed'", vec![]),
        Some(ItemState::Merged) => filters.add("i.status = 'merged'", vec![]),
        Some(ItemState::Draft) => filters.add("i.status = 'draft'", vec![]),
        None => {}
    }
    in_list(&query.authors, "i.author", &mut filters);
    for label in &query.labels.include {
        filters.add("instr(i.labels, ?) > 0", vec![Param::Text(format!("|{label}|"))]);
    }
    for label in &query.labels.exclude {
        filters.add("instr(i.labels, ?) = 0", vec![Param::Text(format!("|{label}|"))]);
    }
    match query.prose_match() {
        Some(expression) => {
            let mut params = vec![Param::Text(expression)];
            params.extend(filters.params.clone());
            (
                Sql {
                    text: format!(
                        "SELECT {ITEM_COLUMNS}, snippet(items_fts, 1, '', '', '…', 40) AS body \
                         FROM items_fts JOIN items i ON i.iid = items_fts.rowid JOIN repos r ON r.repo_id = i.repo_id \
                         WHERE items_fts MATCH ? AND {}",
                        filters.text()
                    ),
                    params,
                },
                true,
            )
        }
        None => (
            Sql {
                text: format!(
                    "SELECT {ITEM_COLUMNS}, substr(i.body, 1, 400) AS body \
                     FROM items i JOIN repos r ON r.repo_id = i.repo_id WHERE {}",
                    filters.text()
                ),
                params: filters.params,
            },
            false,
        ),
    }
}

pub fn items_count(query: &Query, reader: &Reader, kind: ItemKind) -> Sql {
    count(&items_select(query, reader, kind).0)
}

pub fn items_page(query: &Query, reader: &Reader, kind: ItemKind, page: Page) -> Sql {
    let (mut sql, text) = items_select(query, reader, kind);
    sql.text.push_str(if text {
        " ORDER BY bm25(items_fts, 4.0, 1.0), i.updated_at DESC"
    } else {
        " ORDER BY i.updated_at DESC, i.iid DESC"
    });
    paged(sql, page)
}

// ---- People ----------------------------------------------------------------

/// People and workspaces; only words narrow them.
pub fn people_select(query: &Query) -> Option<Sql> {
    let expression = query.prose_match()?;
    Some(Sql {
        text: "SELECT p.kind, p.slug, p.name, p.bio, p.avatar FROM people_fts JOIN people p ON p.pid = people_fts.rowid \
               WHERE people_fts MATCH ?"
            .to_owned(),
        params: vec![Param::Text(expression)],
    })
}

pub fn people_page(query: &Query, page: Page) -> Option<Sql> {
    let mut sql = people_select(query)?;
    sql.text.push_str(" ORDER BY (p.slug = ?) DESC, bm25(people_fts, 10.0, 5.0, 1.0), p.kind DESC");
    sql.params.push(Param::Text(exact(query)));
    Some(paged(sql, page))
}

// ---- Explore ---------------------------------------------------------------

/// Public repositories, recently active or newly made.
pub fn explore(newest: bool, language: Option<&str>, topic: Option<&str>, page: Page) -> Sql {
    let mut filters = Where::default();
    filters.add("r.private = 0", vec![]);
    if let Some(language) = language {
        filters.add("r.language = ?", vec![Param::Text(language.to_owned())]);
    }
    if let Some(topic) = topic {
        filters.add("r.repo_id IN (SELECT repo_id FROM repo_topics WHERE topic = ?)", vec![Param::Text(topic.to_owned())]);
    }
    let order = if newest { "r.created_at DESC" } else { "COALESCE(r.pushed_at, r.created_at) DESC" };
    paged(
        Sql {
            text: format!("SELECT {REPO_COLUMNS} FROM repos r WHERE {} ORDER BY {order}, r.rid DESC", filters.text()),
            params: filters.params,
        },
        page,
    )
}

pub const LANGUAGE_FACETS: &str = "SELECT language AS name, count(*) AS count FROM repos \
     WHERE private = 0 AND language IS NOT NULL GROUP BY language ORDER BY count DESC, name LIMIT 24";

pub const TOPIC_FACETS: &str = "SELECT t.topic AS name, count(*) AS count FROM repo_topics t \
     JOIN repos r ON r.repo_id = t.repo_id WHERE r.private = 0 GROUP BY t.topic ORDER BY count DESC, name LIMIT 30";

#[cfg(test)]
mod tests {
    use g1t_contracts::{Membership, User};

    use super::*;

    fn reader(workspaces: &[&str]) -> Reader {
        Reader::of(&Some(User {
            workspaces: workspaces.iter().map(|w| Membership::member(*w)).collect(),
            ..User::default()
        }))
    }

    const PAGE: Page = Page { limit: 20, offset: 0 };

    fn placeholders(sql: &Sql) -> usize {
        sql.text.matches('?').count()
    }

    #[test]
    fn every_query_of_repository_content_checks_visibility() {
        let query = Query::parse("parse repo:acme/web");
        let reader = reader(&["acme"]);
        let plan = code_plan(&query).unwrap();
        for sql in [
            repos_page(&query, &reader, PAGE),
            repos_count(&query, &reader),
            code_page(&plan, &query, &reader, PAGE),
            code_count(&plan, &query, &reader),
            items_page(&query, &reader, ItemKind::Issue, PAGE),
            items_count(&query, &reader, ItemKind::Pull),
        ] {
            assert!(sql.text.contains("r.private = 0 OR r.namespace IN"), "{}", sql.text);
            assert!(sql.text.contains("OR r.repo_id IN"), "{}", sql.text);
            assert!(sql.params.contains(&Param::Text(r#"["acme"]"#.into())));
            assert_eq!(placeholders(&sql), sql.params.len(), "{}", sql.text);
        }
    }

    #[test]
    fn signed_out_readers_bind_no_workspaces() {
        let sql = repos_page(&Query::parse("x"), &Reader::of(&None), PAGE);
        assert!(sql.params.contains(&Param::Text("[]".into())));
    }

    #[test]
    fn qualifiers_become_conditions() {
        let query = Query::parse("parse language:rust path:*.rs -path:tests/ org:acme");
        let plan = code_plan(&query).unwrap();
        let sql = code_page(&plan, &query, &reader(&[]), PAGE);
        assert!(sql.text.contains("fl.language IN"));
        assert!(sql.text.contains("fl.path LIKE ? ESCAPE"));
        assert!(sql.text.contains("fl.path NOT LIKE ?"));
        assert!(sql.text.contains("r.namespace IN"));
        assert!(sql.params.contains(&Param::Text("%.rs".into())));
        assert!(sql.params.contains(&Param::Text("%tests/%".into())));
        assert_eq!(placeholders(&sql), sql.params.len());
    }

    #[test]
    fn issue_qualifiers_become_conditions() {
        let query = Query::parse("crash is:closed author:ana label:bug -label:wontfix");
        let sql = items_page(&query, &reader(&[]), ItemKind::Issue, PAGE);
        assert!(sql.text.contains("i.state = 'closed'"));
        assert!(sql.text.contains("i.author IN"));
        assert!(sql.params.contains(&Param::Text("|bug|".into())));
        assert!(sql.text.contains("instr(i.labels, ?) = 0"));
        assert_eq!(placeholders(&sql), sql.params.len());
    }

    #[test]
    fn code_needs_three_characters_unless_scoped() {
        assert!(code_plan(&Query::parse("fn")).is_err());
        assert_eq!(code_plan(&Query::parse("fn repo:a/b")).unwrap(), CodePlan::Scan { short: vec!["fn".into()] });
        assert_eq!(code_plan(&Query::parse("repo:a/b path:src")).unwrap(), CodePlan::Files);
        assert!(matches!(code_plan(&Query::parse("fn main")).unwrap(), CodePlan::Index { .. }));
    }

    #[test]
    fn every_plan_binds_what_it_asks() {
        let reader = reader(&[]);
        for text in ["fn repo:a/b", "repo:a/b path:src", "fn main"] {
            let query = Query::parse(text);
            let plan = code_plan(&query).unwrap();
            for sql in [code_page(&plan, &query, &reader, PAGE), code_count(&plan, &query, &reader), code_pieces(&plan, &[1, 2], 10)] {
                assert_eq!(placeholders(&sql), sql.params.len(), "{text}: {}", sql.text);
            }
        }
    }

    #[test]
    fn counts_stop_past_the_cap() {
        let sql = repos_count(&Query::parse("x"), &reader(&[]));
        assert!(sql.text.ends_with(&format!("LIMIT {})", COUNT_CAP + 1)));
    }

    #[test]
    fn explore_is_public_only() {
        let sql = explore(false, Some("rust"), Some("cli"), PAGE);
        assert!(sql.text.contains("r.private = 0"));
        assert_eq!(placeholders(&sql), sql.params.len());
    }

    /// Writes every kind of statement to stdout as JSON, to run against
    /// SQLite with the migrations: `cargo test -p g1t-search dump_sql --
    /// --ignored --nocapture`.
    #[test]
    #[ignore]
    fn dump_sql() {
        let reader = reader(&["acme"]);
        let mut out = Vec::new();
        for text in [
            "parse",
            "parse repo:acme/web",
            "\"fn main\" language:rust path:src -path:tests",
            "fn repo:acme/web",
            "repo:acme/web path:*.rs",
            "crash is:open label:bug author:ana",
            "language:rust",
            "ana",
        ] {
            let query = Query::parse(text);
            out.push(repos_page(&query, &reader, PAGE));
            out.push(repos_count(&query, &reader));
            if let Ok(plan) = code_plan(&query) {
                out.push(code_page(&plan, &query, &reader, PAGE));
                out.push(code_count(&plan, &query, &reader));
                out.push(code_pieces(&plan, &[1, 2], 10));
            }
            out.push(items_page(&query, &reader, ItemKind::Issue, PAGE));
            out.push(items_count(&query, &reader, ItemKind::Pull));
            if let Some(sql) = people_page(&query, PAGE) {
                out.push(sql);
            }
        }
        out.push(code_files(&[1, 2]));
        out.push(first_pieces(&[1, 2]));
        out.push(explore(true, Some("rust"), Some("cli"), PAGE));
        out.push(Sql { text: LANGUAGE_FACETS.into(), params: vec![] });
        out.push(Sql { text: TOPIC_FACETS.into(), params: vec![] });
        println!("{}", serde_json::to_string(&out).unwrap());
    }
}
