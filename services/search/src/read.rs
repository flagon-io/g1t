//! Answering searches, suggestions as someone types, and Explore.

use std::collections::{HashMap, HashSet};

use g1t_contracts::repos::{ReadableArgs, Repo};
use g1t_contracts::search::*;
use g1t_contracts::{Outcome, Viewer};
use serde::Deserialize;
use worker::Result;

use crate::Search;
use crate::query::{ItemKind, Query};
use crate::rules::normalize_language;
use crate::snippet;
use crate::sql::{self, CodePlan, Page, Param, Sql};
use crate::store;
use crate::visibility::{Indexed, Reader, check};

/// Results a page can reach: no further than the counts go.
const MAX_PAGE: u32 = 50;
/// Results of each kind in a suggestion.
const SUGGEST_EACH: u32 = 4;
/// Repositories on a page of Explore.
const EXPLORE_PAGE: u32 = 24;
/// Pieces of code read for each file on a page, at most.
const PIECES_PER_FILE: u32 = 4;

/// A path's segments made safe to put in an address.
pub fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|segment| {
            let mut out = String::with_capacity(segment.len());
            for byte in segment.bytes() {
                match byte {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'@' | b'+' | b'=' | b',' => {
                        out.push(byte as char)
                    }
                    _ => out.push_str(&format!("%{byte:02X}")),
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn split_labels(labels: &str) -> Vec<String> {
    labels.split('|').filter(|label| !label.is_empty()).map(str::to_owned).collect()
}

fn split_topics(topics: &str) -> Vec<String> {
    topics.split_whitespace().map(str::to_owned).collect()
}

#[derive(Deserialize)]
struct RepoRow {
    repo_id: String,
    namespace: String,
    name: String,
    description: Option<String>,
    topics: String,
    language: Option<String>,
    private: u8,
    pushed_at: Option<String>,
    created_at: String,
    #[serde(default)]
    readme: Option<String>,
}

#[derive(Deserialize)]
struct FileHit {
    fid: i64,
}

#[derive(Deserialize)]
struct FileRow {
    fid: i64,
    path: String,
    language: Option<String>,
    repo_id: String,
    namespace: String,
    name: String,
    default_branch: String,
    private: u8,
}

#[derive(Deserialize)]
struct PieceRow {
    fid: i64,
    start_line: u32,
    content: String,
}

#[derive(Deserialize)]
struct ItemRow {
    kind: String,
    number: u32,
    title: String,
    state: String,
    status: String,
    author: String,
    labels: String,
    updated_at: String,
    repo_id: String,
    namespace: String,
    name: String,
    private: u8,
    body: Option<String>,
}

#[derive(Deserialize)]
struct PersonRow {
    kind: String,
    slug: String,
    name: Option<String>,
    bio: Option<String>,
    avatar: Option<String>,
}

/// A result, and the repository whose visibility decides whether it is shown.
struct Found {
    hit: Hit,
    repo: Option<Indexed>,
}

fn repo_hit(row: RepoRow, terms: &[String]) -> Found {
    let full = format!("{}/{}", row.namespace, row.name);
    let mut hit = Hit::new(HitKind::Repository, full.clone(), format!("/{}/{}", row.namespace, row.name));
    hit.repo = Some(full);
    hit.private = row.private != 0;
    hit.snippet = match (&row.description, &row.readme) {
        (Some(description), _) if !description.trim().is_empty() => snippet::prose(description, terms),
        (_, Some(readme)) if snippet::contains_any(readme, terms) => snippet::prose(readme, terms),
        _ => Vec::new(),
    };
    hit.description = row.description;
    hit.language = row.language;
    hit.topics = split_topics(&row.topics);
    hit.updated_at = row.pushed_at.or(Some(row.created_at));
    Found {
        hit,
        repo: Some(Indexed {
            repo_id: row.repo_id,
            namespace: row.namespace,
            private: row.private != 0,
        }),
    }
}

fn item_hit(row: ItemRow, terms: &[String]) -> Found {
    let pull = row.kind == "pull";
    let full = format!("{}/{}", row.namespace, row.name);
    let url = format!("/{full}/{}/{}", if pull { "pull" } else { "issues" }, row.number);
    let mut hit = Hit::new(if pull { HitKind::Pull } else { HitKind::Issue }, row.title, url);
    hit.repo = Some(full);
    hit.private = row.private != 0;
    hit.snippet = snippet::prose(row.body.as_deref().unwrap_or_default(), terms);
    hit.number = Some(row.number);
    hit.state = Some(if pull { row.status } else { row.state });
    hit.author = Some(row.author);
    hit.labels = split_labels(&row.labels);
    hit.updated_at = Some(row.updated_at);
    Found {
        hit,
        repo: Some(Indexed {
            repo_id: row.repo_id,
            namespace: row.namespace,
            private: row.private != 0,
        }),
    }
}

fn person_hit(row: PersonRow, terms: &[String]) -> Found {
    let workspace = row.kind == "workspace";
    let url = if workspace { format!("/{}", row.slug) } else { format!("/u/{}", row.slug) };
    let title = row.name.clone().filter(|name| !name.trim().is_empty()).unwrap_or_else(|| row.slug.clone());
    let mut hit = Hit::new(if workspace { HitKind::Workspace } else { HitKind::User }, title, url);
    hit.slug = Some(row.slug);
    hit.snippet = row.bio.as_deref().map(|bio| snippet::prose(bio, terms)).unwrap_or_default();
    hit.description = row.bio;
    hit.avatar = row.avatar;
    Found { hit, repo: None }
}

impl Search {
    /// The second visibility check: of these repositories, the ones the
    /// repos service says this viewer may read now. Corrects the index
    /// where it was behind.
    async fn readable(&self, viewer: &Viewer, indexed: &[Indexed]) -> HashSet<String> {
        if indexed.is_empty() {
            return HashSet::new();
        }
        let ids: Vec<String> = indexed.iter().map(|row| row.repo_id.clone()).collect::<HashSet<_>>().into_iter().collect();
        let readable: Result<Vec<Repo>> =
            g1t_kit::call(&self.repos, "readable", &ReadableArgs { ids, viewer: viewer.clone() }).await;
        if let Err(error) = &readable {
            worker::console_error!("search: could not check visibility: {error}");
        }
        let verdict = check(&Reader::of(viewer), indexed, readable.as_deref().ok());
        if !verdict.corrections.is_empty() {
            let mut statements = Vec::new();
            for correction in &verdict.corrections {
                let (text, params) = match &correction.path {
                    Some((namespace, name)) => (
                        "UPDATE repos SET private = ?, namespace = ?, name = ? WHERE repo_id = ?",
                        vec![
                            Param::Int(i64::from(correction.private)),
                            Param::Text(namespace.clone()),
                            Param::Text(name.clone()),
                            Param::Text(correction.repo_id.clone()),
                        ],
                    ),
                    None => (
                        "UPDATE repos SET private = ? WHERE repo_id = ?",
                        vec![Param::Int(i64::from(correction.private)), Param::Text(correction.repo_id.clone())],
                    ),
                };
                if let Ok(statement) = store::prepare(&self.db, text, params) {
                    statements.push(statement);
                }
            }
            if let Err(error) = store::run_all(&self.db, statements).await {
                worker::console_error!("search: could not correct visibility: {error}");
            }
        }
        verdict.keep
    }

    /// Results the viewer may see, in order.
    async fn admit(&self, viewer: &Viewer, found: Vec<Found>) -> Vec<Hit> {
        let indexed: Vec<Indexed> = found.iter().filter_map(|f| f.repo.clone()).collect();
        let keep = self.readable(viewer, &indexed).await;
        found
            .into_iter()
            .filter(|f| f.repo.as_ref().is_none_or(|repo| keep.contains(&repo.repo_id)))
            .map(|f| f.hit)
            .collect()
    }

    async fn count_of(&self, kind: SearchType, query: &Query, reader: &Reader) -> Result<u32> {
        if !query.applies_to(kind) {
            return Ok(0);
        }
        let sql = match kind {
            SearchType::Repositories => Some(sql::repos_count(query, reader)),
            SearchType::Code => sql::code_plan(query).ok().map(|plan| sql::code_count(&plan, query, reader)),
            SearchType::Issues => Some(sql::items_count(query, reader, ItemKind::Issue)),
            SearchType::Pulls => Some(sql::items_count(query, reader, ItemKind::Pull)),
            SearchType::People => sql::people_select(query).map(|select| sql::count(&select)),
        };
        match sql {
            Some(sql) => Ok(store::count(&self.db, &sql).await?.min(COUNT_CAP)),
            None => Ok(0),
        }
    }

    async fn code_hits(&self, plan: &CodePlan, query: &Query, reader: &Reader, page: Page, terms: &[String]) -> Result<Vec<Found>> {
        let fids: Vec<i64> = store::all::<FileHit>(&self.db, &sql::code_page(plan, query, reader, page))
            .await?
            .into_iter()
            .map(|row| row.fid)
            .collect();
        if fids.is_empty() {
            return Ok(Vec::new());
        }
        let files = store::all::<FileRow>(&self.db, &sql::code_files(&fids)).await?;
        let mut pieces: HashMap<i64, Vec<PieceRow>> = HashMap::new();
        for piece in store::all::<PieceRow>(&self.db, &sql::code_pieces(plan, &fids, page.limit * PIECES_PER_FILE)).await? {
            pieces.entry(piece.fid).or_default().push(piece);
        }
        // Files that matched by name have no matching piece: their first.
        let missing: Vec<i64> = fids.iter().copied().filter(|fid| !pieces.contains_key(fid)).collect();
        if !missing.is_empty() {
            for piece in store::all::<PieceRow>(&self.db, &sql::first_pieces(&missing)).await? {
                pieces.entry(piece.fid).or_default().push(piece);
            }
        }
        let by_id: HashMap<i64, FileRow> = files.into_iter().map(|file| (file.fid, file)).collect();
        let mut found = Vec::new();
        for fid in fids {
            let Some(file) = by_id.get(&fid) else { continue };
            let parts: Vec<(u32, &str)> = pieces
                .get(&fid)
                .map(|list| list.iter().take(PIECES_PER_FILE as usize).map(|p| (p.start_line, p.content.as_str())).collect())
                .unwrap_or_default();
            let lines = snippet::code(&parts, terms);
            let line = snippet::first_match(&lines);
            let full = format!("{}/{}", file.namespace, file.name);
            let url = format!(
                "/{full}/blob/{}/{}{}",
                encode_path(&file.default_branch),
                encode_path(&file.path),
                line.map(|n| format!("#L{n}")).unwrap_or_default()
            );
            let mut hit = Hit::new(HitKind::Code, file.path.clone(), url);
            hit.repo = Some(full);
            hit.private = file.private != 0;
            hit.path = Some(file.path.clone());
            hit.language = file.language.clone();
            hit.git_ref = Some(file.default_branch.clone());
            hit.lines = lines;
            found.push(Found {
                hit,
                repo: Some(Indexed {
                    repo_id: file.repo_id.clone(),
                    namespace: file.namespace.clone(),
                    private: file.private != 0,
                }),
            });
        }
        Ok(found)
    }

    async fn page_of(&self, kind: SearchType, query: &Query, reader: &Reader, page: Page, terms: &[String]) -> Result<Vec<Found>> {
        if !query.applies_to(kind) {
            return Ok(Vec::new());
        }
        Ok(match kind {
            SearchType::Repositories => store::all::<RepoRow>(&self.db, &sql::repos_page(query, reader, page))
                .await?
                .into_iter()
                .map(|row| repo_hit(row, terms))
                .collect(),
            SearchType::Code => match sql::code_plan(query) {
                Ok(plan) => self.code_hits(&plan, query, reader, page, terms).await?,
                Err(_) => Vec::new(),
            },
            SearchType::Issues | SearchType::Pulls => {
                let item = if kind == SearchType::Issues { ItemKind::Issue } else { ItemKind::Pull };
                store::all::<ItemRow>(&self.db, &sql::items_page(query, reader, item, page))
                    .await?
                    .into_iter()
                    .map(|row| item_hit(row, terms))
                    .collect()
            }
            SearchType::People => match sql::people_page(query, page) {
                Some(sql) => store::all::<PersonRow>(&self.db, &sql)
                    .await?
                    .into_iter()
                    .map(|row| person_hit(row, terms))
                    .collect(),
                None => Vec::new(),
            },
        })
    }

    pub async fn search(&self, a: SearchArgs) -> Result<Outcome<SearchResults>> {
        let query = Query::parse(&a.query);
        let reader = Reader::of(&a.viewer);
        let kind = a.kind.unwrap_or_else(|| query.default_type());
        let per_page = a.per_page.unwrap_or(DEFAULT_PER_PAGE).clamp(1, MAX_PER_PAGE);
        let page = a.page.unwrap_or(1).clamp(1, MAX_PAGE);
        let mut results = SearchResults {
            query: query.display(),
            kind,
            counts: SearchCounts::default(),
            page,
            per_page,
            more: false,
            hits: Vec::new(),
            notes: query.notes.clone(),
        };
        if query.is_empty() {
            results.notes.push("Type a word, a \"phrase\" or a qualifier such as repo:owner/name.".into());
            return Ok(Outcome::Ok(results));
        }
        if kind == SearchType::Code
            && let Err(why) = sql::code_plan(&query)
        {
            results.notes.push(why.to_owned());
        }
        for each in SearchType::ALL {
            let counted = match self.count_of(each, &query, &reader).await {
                Ok(count) => count,
                Err(error) => {
                    worker::console_error!("search: counting {} failed: {error}", each.as_str());
                    0
                }
            };
            results.counts.set(each, counted);
        }
        // One more than a page, to know whether there is another.
        let window = Page { limit: per_page + 1, offset: (page - 1) * per_page };
        let terms = query.highlights();
        let found = match self.page_of(kind, &query, &reader, window, &terms).await {
            Ok(found) => found,
            Err(error) => {
                // Most often a query the index could not read.
                worker::console_error!("search: {} failed for {:?}: {error}", kind.as_str(), results.query);
                results.notes.push("Part of that query could not be read. Try fewer symbols, or put them in quotes.".into());
                Vec::new()
            }
        };
        let before = found.len();
        let mut hits = self.admit(&a.viewer, found).await;
        // What the second check dropped is not counted either.
        let dropped = (before - hits.len()) as u32;
        results.counts.set(kind, results.counts.get(kind).saturating_sub(dropped));
        results.more = hits.len() > per_page as usize;
        hits.truncate(per_page as usize);
        results.hits = hits;
        Ok(Outcome::Ok(results))
    }

    /// A few repositories, issues, pull requests and people, for the
    /// command palette. Never code: that is a full search away.
    pub async fn suggest(&self, a: SuggestArgs) -> Result<Vec<Hit>> {
        let query = Query::parse(&a.query);
        if query.prose_match().is_none() {
            return Ok(Vec::new());
        }
        let reader = Reader::of(&a.viewer);
        let page = Page { limit: SUGGEST_EACH, offset: 0 };
        let terms = query.highlights();
        let mut found = Vec::new();
        for kind in [SearchType::Repositories, SearchType::Issues, SearchType::Pulls, SearchType::People] {
            match self.page_of(kind, &query, &reader, page, &terms).await {
                Ok(more) => found.extend(more),
                Err(error) => worker::console_error!("search: suggesting {} failed: {error}", kind.as_str()),
            }
        }
        Ok(self.admit(&a.viewer, found).await)
    }

    pub async fn explore(&self, a: ExploreArgs) -> Result<Explore> {
        let newest = a.sort.as_deref() == Some("new");
        let language = a.language.as_deref().map(str::trim).filter(|l| !l.is_empty()).map(normalize_language);
        let topic = a.topic.as_deref().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty());
        let page = a.page.unwrap_or(1).clamp(1, MAX_PAGE);
        let window = Page { limit: EXPLORE_PAGE + 1, offset: (page - 1) * EXPLORE_PAGE };
        let rows = store::all::<RepoRow>(&self.db, &sql::explore(newest, language.as_deref(), topic.as_deref(), window)).await?;
        let indexed: Vec<Indexed> = rows
            .iter()
            .map(|row| Indexed { repo_id: row.repo_id.clone(), namespace: row.namespace.clone(), private: row.private != 0 })
            .collect();
        // Explore is for everyone: checked as if signed out, whoever asks.
        let keep = self.readable(&None, &indexed).await;
        let mut repos: Vec<ExploreRepo> = rows
            .into_iter()
            .filter(|row| keep.contains(&row.repo_id))
            .map(|row| ExploreRepo {
                namespace: row.namespace,
                name: row.name,
                description: row.description,
                topics: split_topics(&row.topics),
                language: row.language,
                created_at: row.created_at,
                pushed_at: row.pushed_at,
            })
            .collect();
        let more = repos.len() > EXPLORE_PAGE as usize;
        repos.truncate(EXPLORE_PAGE as usize);
        let (languages, topics) = if page == 1 {
            (
                store::all::<Facet>(&self.db, &Sql { text: sql::LANGUAGE_FACETS.into(), params: vec![] }).await?,
                store::all::<Facet>(&self.db, &Sql { text: sql::TOPIC_FACETS.into(), params: vec![] }).await?,
            )
        } else {
            (Vec::new(), Vec::new())
        };
        Ok(Explore { repos, languages, topics, page, more })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_safe_in_addresses() {
        assert_eq!(encode_path("src/main.rs"), "src/main.rs");
        assert_eq!(encode_path("docs/a b#c?.md"), "docs/a%20b%23c%3F.md");
        assert_eq!(encode_path("src/ünï.rs"), "src/%C3%BCn%C3%AF.rs");
    }

    #[test]
    fn labels_and_topics_are_split() {
        assert_eq!(split_labels("|bug|good first issue|"), vec!["bug", "good first issue"]);
        assert!(split_labels("|").is_empty());
        assert_eq!(split_topics("cli rust"), vec!["cli", "rust"]);
    }
}
