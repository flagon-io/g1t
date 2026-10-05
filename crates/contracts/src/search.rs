//! The search service: one search across all of g1t, and Explore.
//!
//! It covers everything public, and private content the viewer is a member
//! of: repositories (name, description, topics, README), code on default
//! branches, issues and pull requests, people and workspaces. Who may see
//! what is decided when the query runs, against the viewer's current
//! memberships and each repository's current visibility, never only when
//! something was indexed.
//!
//! Each `*Args` struct is the argument of the method of the same name,
//! served at `POST /rpc/<method>`. Mirrors `packages/contracts/src/search.ts`.

use serde::{Deserialize, Serialize};

use crate::Viewer;

/// What a search looks through: one tab of results.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchType {
    Repositories,
    Code,
    Issues,
    Pulls,
    People,
}

impl SearchType {
    pub const ALL: [SearchType; 5] = [
        SearchType::Repositories,
        SearchType::Code,
        SearchType::Issues,
        SearchType::Pulls,
        SearchType::People,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SearchType::Repositories => "repositories",
            SearchType::Code => "code",
            SearchType::Issues => "issues",
            SearchType::Pulls => "pulls",
            SearchType::People => "people",
        }
    }

    /// Reads a type as people write it: `repositories`, `repos`, `code`,
    /// `issues`, `pulls`, `prs`, `people`, `users`.
    pub fn parse(text: &str) -> Option<SearchType> {
        match text.trim().to_lowercase().as_str() {
            "repositories" | "repository" | "repos" | "repo" | "projects" | "project" => Some(SearchType::Repositories),
            "code" => Some(SearchType::Code),
            "issues" | "issue" => Some(SearchType::Issues),
            "pulls" | "pull" | "prs" | "pr" | "pull_requests" | "pull-requests" => Some(SearchType::Pulls),
            "people" | "users" | "user" | "workspaces" | "workspace" => Some(SearchType::People),
            _ => None,
        }
    }
}

/// The most results on one page.
pub const MAX_PER_PAGE: u32 = 50;
/// Results on a page when none is asked for.
pub const DEFAULT_PER_PAGE: u32 = 20;
/// Counts stop here: past it a tab says "1,000+".
pub const COUNT_CAP: u32 = 1000;
/// The longest query read; the rest is ignored.
pub const MAX_QUERY_CHARS: usize = 256;

/// `search`. Returns `Outcome<SearchResults>`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchArgs {
    pub viewer: Viewer,
    /// Words, quoted phrases and qualifiers, such as
    /// `parse_query repo:acme/web language:rust`.
    pub query: String,
    /// Which tab of results. Worked out from the qualifiers when absent:
    /// `path:` means code, `is:pr` pull requests, and so on.
    #[serde(default, rename = "type")]
    pub kind: Option<SearchType>,
    /// From 1.
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub per_page: Option<u32>,
}

/// One piece of a snippet, highlighted where it matched the query.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub text: String,
    #[serde(default)]
    pub highlight: bool,
}

/// A line of code in a result, numbered from 1.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeLine {
    pub number: u32,
    pub parts: Vec<Segment>,
}

/// What a result is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HitKind {
    Repository,
    Code,
    Issue,
    Pull,
    User,
    Workspace,
}

/// One result. Which fields are set depends on `kind`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub kind: HitKind,
    /// What to show as the result's name: `acme/web`, a file's path,
    /// `Fix the login redirect`, a person's name.
    pub title: String,
    /// Where it is on g1t.sh, as a path: `/acme/web/blob/main/src/app.rs#L12`.
    pub url: String,
    /// The repository, as `owner/name`, for everything but people.
    #[serde(default)]
    pub repo: Option<String>,
    /// Whether only members of its workspace can see it.
    #[serde(default)]
    pub private: bool,
    /// A repository's or workspace's description, a person's bio.
    #[serde(default)]
    pub description: Option<String>,
    /// The part of the text that matched, highlighted. Empty for code.
    #[serde(default)]
    pub snippet: Vec<Segment>,
    /// For code: the lines that matched, with a line around each.
    #[serde(default)]
    pub lines: Vec<CodeLine>,
    /// For code: the file's path in its repository.
    #[serde(default)]
    pub path: Option<String>,
    /// For code: the file's language. For a repository: the language most
    /// of its code is in.
    #[serde(default)]
    pub language: Option<String>,
    /// For code: the branch it was read from.
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
    /// For issues and pull requests.
    #[serde(default)]
    pub number: Option<u32>,
    /// `open` or `closed` for an issue; `draft`, `open`, `merged` or
    /// `closed` for a pull request.
    #[serde(default)]
    pub state: Option<String>,
    /// Who opened the issue or pull request.
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    /// A repository's topics.
    #[serde(default)]
    pub topics: Vec<String>,
    /// A user's username or a workspace's slug.
    #[serde(default)]
    pub slug: Option<String>,
    /// The uploaded avatar's hash, for people and workspaces.
    #[serde(default)]
    pub avatar: Option<String>,
    /// RFC 3339: when it last changed, or a repository's last push.
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl Hit {
    pub fn new(kind: HitKind, title: impl Into<String>, url: impl Into<String>) -> Hit {
        Hit {
            kind,
            title: title.into(),
            url: url.into(),
            repo: None,
            private: false,
            description: None,
            snippet: Vec::new(),
            lines: Vec::new(),
            path: None,
            language: None,
            git_ref: None,
            number: None,
            state: None,
            author: None,
            labels: Vec::new(),
            topics: Vec::new(),
            slug: None,
            avatar: None,
            updated_at: None,
        }
    }
}

/// How many results each tab has, up to [`COUNT_CAP`].
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchCounts {
    pub repositories: u32,
    pub code: u32,
    pub issues: u32,
    pub pulls: u32,
    pub people: u32,
}

impl SearchCounts {
    pub fn get(&self, kind: SearchType) -> u32 {
        match kind {
            SearchType::Repositories => self.repositories,
            SearchType::Code => self.code,
            SearchType::Issues => self.issues,
            SearchType::Pulls => self.pulls,
            SearchType::People => self.people,
        }
    }

    pub fn set(&mut self, kind: SearchType, count: u32) {
        let slot = match kind {
            SearchType::Repositories => &mut self.repositories,
            SearchType::Code => &mut self.code,
            SearchType::Issues => &mut self.issues,
            SearchType::Pulls => &mut self.pulls,
            SearchType::People => &mut self.people,
        };
        *slot = count;
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    /// The query as it was read.
    pub query: String,
    /// The tab these results are for.
    #[serde(rename = "type")]
    pub kind: SearchType,
    pub counts: SearchCounts,
    pub page: u32,
    pub per_page: u32,
    /// Whether there is a page after this one.
    pub more: bool,
    pub hits: Vec<Hit>,
    /// What the query could not do, such as a code search with no word of
    /// three characters or more.
    #[serde(default)]
    pub notes: Vec<String>,
}

/// `suggest`: a few results of every kind but code, for the command
/// palette as someone types. Returns `Vec<Hit>`.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SuggestArgs {
    pub viewer: Viewer,
    pub query: String,
}

/// `explore`: public repositories, recently active or newly created,
/// optionally of one language or topic. Returns `Explore`.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExploreArgs {
    pub viewer: Viewer,
    /// `active` (the default) or `new`.
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub page: Option<u32>,
}

/// A public repository as Explore lists it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExploreRepo {
    pub namespace: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub topics: Vec<String>,
    pub language: Option<String>,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339: the last push to its default branch, if any.
    pub pushed_at: Option<String>,
}

/// A language or topic, with how many public repositories have it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Facet {
    pub name: String,
    pub count: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Explore {
    pub repos: Vec<ExploreRepo>,
    pub languages: Vec<Facet>,
    pub topics: Vec<Facet>,
    pub page: u32,
    pub more: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_read_as_people_write_them() {
        assert_eq!(SearchType::parse("prs"), Some(SearchType::Pulls));
        assert_eq!(SearchType::parse("Repos"), Some(SearchType::Repositories));
        assert_eq!(SearchType::parse("users"), Some(SearchType::People));
        assert_eq!(SearchType::parse("wiki"), None);
    }

    #[test]
    fn the_type_is_sent_as_type() {
        let results = SearchResults {
            query: "x".into(),
            kind: SearchType::Code,
            counts: SearchCounts::default(),
            page: 1,
            per_page: 20,
            more: false,
            hits: vec![],
            notes: vec![],
        };
        let value = serde_json::to_value(&results).unwrap();
        assert_eq!(value["type"], "code");
        assert_eq!(value["perPage"], 20);
    }
}
