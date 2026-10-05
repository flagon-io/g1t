//! Reading a search query: words, quoted phrases, `-` to leave a word out,
//! and qualifiers such as `repo:acme/web` or `is:open`. Pure, so every rule
//! is tested apart from the index.

use g1t_contracts::search::{MAX_QUERY_CHARS, SearchType};

use crate::rules::normalize_language;

/// A word or phrase to match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Term {
    pub text: String,
    /// Written in quotes: matched exactly, as one piece.
    pub phrase: bool,
    /// Written with a leading `-`: results must not have it.
    pub negated: bool,
}

/// Values of one qualifier, kept and left out (`-label:wontfix`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Filter {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}

impl Filter {
    fn add(&mut self, value: String, negated: bool) {
        let list = if negated { &mut self.exclude } else { &mut self.include };
        if !list.contains(&value) {
            list.push(value);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.include.is_empty() && self.exclude.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    Issue,
    Pull,
}

/// `is:open`, `is:closed`, `is:merged`, `is:draft`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemState {
    Open,
    Closed,
    Merged,
    Draft,
}

/// `is:public` or `is:private`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Visibility {
    Public,
    Private,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Query {
    pub terms: Vec<Term>,
    /// `repo:owner/name`, lowercase `owner/name`.
    pub repos: Filter,
    /// `org:`, `workspace:`, `owner:` and `user:`: a workspace's slug.
    pub owners: Filter,
    pub languages: Filter,
    /// `path:`, lowercase, as written: a glob when it has a `*`.
    pub paths: Filter,
    pub authors: Filter,
    pub labels: Filter,
    pub kind: Option<ItemKind>,
    pub state: Option<ItemState>,
    pub visibility: Option<Visibility>,
    /// `type:code` and the like.
    pub type_hint: Option<SearchType>,
    /// What the query asked that could not be done, said plainly.
    pub notes: Vec<String>,
}

/// Splits a query into tokens: runs of non-space, with quoted runs kept
/// whole wherever they start (`"a b"`, `label:"good first issue"`).
fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in text.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                current.push(c);
            }
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// A value with its quotes taken off.
fn unquote(value: &str) -> (String, bool) {
    let trimmed = value.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        return (trimmed[1..trimmed.len() - 1].to_owned(), true);
    }
    // An opening quote never closed: the rest of the query.
    if let Some(rest) = trimmed.strip_prefix('"') {
        return (rest.trim_end_matches('"').to_owned(), true);
    }
    (trimmed.replace('"', ""), false)
}

impl Query {
    pub fn parse(text: &str) -> Query {
        let text: String = text.chars().take(MAX_QUERY_CHARS).collect();
        let mut query = Query::default();
        for token in tokens(&text) {
            let (negated, body) = match token.strip_prefix('-') {
                Some(rest) if !rest.is_empty() => (true, rest.to_owned()),
                _ => (false, token.clone()),
            };
            if let Some((key, value)) = body.split_once(':')
                && !key.starts_with('"')
                && query.qualifier(&key.to_lowercase(), value, negated)
            {
                continue;
            }
            let (text, phrase) = unquote(&body);
            if text.trim().is_empty() {
                continue;
            }
            query.terms.push(Term {
                text: if phrase { text } else { text.trim().to_owned() },
                phrase,
                negated,
            });
        }
        query
    }

    /// Takes `key:value` as a qualifier, if `key` is one. False when it is
    /// not, so the token is read as words.
    fn qualifier(&mut self, key: &str, value: &str, negated: bool) -> bool {
        let (value, _) = unquote(value);
        let value = value.trim().to_owned();
        let known = matches!(
            key,
            "repo" | "org" | "workspace" | "owner" | "user" | "language" | "lang" | "path" | "is" | "state" | "author"
                | "label" | "type" | "in"
        );
        if !known {
            return false;
        }
        if value.is_empty() {
            self.notes.push(format!("{key}: needs a value, so it was left out."));
            return true;
        }
        let lower = value.to_lowercase();
        match key {
            "repo" => match lower.split_once('/') {
                Some((owner, name)) if !owner.is_empty() && !name.is_empty() && !name.contains('/') => {
                    self.repos.add(format!("{owner}/{name}"), negated);
                }
                _ => self.notes.push(format!("repo:{value} should be written repo:owner/name.")),
            },
            "org" | "workspace" | "owner" | "user" => self.owners.add(lower, negated),
            "language" | "lang" => self.languages.add(normalize_language(&lower), negated),
            "path" => self.paths.add(lower.trim_start_matches('/').to_owned(), negated),
            "author" => self.authors.add(lower.trim_start_matches('@').to_owned(), negated),
            "label" => self.labels.add(lower, negated),
            "type" => match SearchType::parse(&lower) {
                Some(kind) => self.type_hint = Some(kind),
                None => self.notes.push(format!("type:{value} is not a kind of result.")),
            },
            // `in:title` and the like narrow nothing here: every field is searched.
            "in" => {}
            "is" | "state" => self.is(&lower, &value, negated),
            _ => unreachable!(),
        }
        true
    }

    fn is(&mut self, lower: &str, value: &str, negated: bool) {
        if negated {
            // `-is:open` reads as its opposite where there is one.
            match lower {
                "open" => self.state = Some(ItemState::Closed),
                "closed" => self.state = Some(ItemState::Open),
                "private" => self.visibility = Some(Visibility::Public),
                "public" => self.visibility = Some(Visibility::Private),
                _ => self.notes.push(format!("-is:{value} cannot be left out, so it was ignored.")),
            }
            return;
        }
        match lower {
            "issue" | "issues" => self.kind = Some(ItemKind::Issue),
            "pr" | "pull" | "pulls" | "pull-request" => self.kind = Some(ItemKind::Pull),
            "open" => self.state = Some(ItemState::Open),
            "closed" => self.state = Some(ItemState::Closed),
            "merged" => {
                self.kind = Some(ItemKind::Pull);
                self.state = Some(ItemState::Merged);
            }
            "draft" => {
                self.kind = Some(ItemKind::Pull);
                self.state = Some(ItemState::Draft);
            }
            "public" => self.visibility = Some(Visibility::Public),
            "private" => self.visibility = Some(Visibility::Private),
            _ => self.notes.push(format!("is:{value} is not something g1t can search for.")),
        }
    }

    /// Words and phrases results must have.
    pub fn positive(&self) -> impl Iterator<Item = &Term> {
        self.terms.iter().filter(|term| !term.negated)
    }

    /// What to highlight in a result: every word and phrase it must have.
    pub fn highlights(&self) -> Vec<String> {
        self.positive().map(|term| term.text.clone()).filter(|text| !text.is_empty()).collect()
    }

    /// Whether anything at all was asked.
    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
            && self.repos.is_empty()
            && self.owners.is_empty()
            && self.languages.is_empty()
            && self.paths.is_empty()
            && self.authors.is_empty()
            && self.labels.is_empty()
            && self.kind.is_none()
            && self.state.is_none()
            && self.visibility.is_none()
    }

    /// The tab a query is about when none is named: `type:` if given, then
    /// pull requests for `is:pr`, issues for `is:issue` or anything only
    /// issues have, code for `path:`, else repositories.
    pub fn default_type(&self) -> SearchType {
        if let Some(kind) = self.type_hint {
            return kind;
        }
        match self.kind {
            Some(ItemKind::Pull) => return SearchType::Pulls,
            Some(ItemKind::Issue) => return SearchType::Issues,
            None => {}
        }
        if !self.paths.is_empty() {
            return SearchType::Code;
        }
        if self.state.is_some() || !self.authors.is_empty() || !self.labels.is_empty() {
            return SearchType::Issues;
        }
        SearchType::Repositories
    }

    /// Whether the query can have results of `kind`: qualifiers only one
    /// kind has rule the others out (`path:` is only code, `label:` only
    /// issues and pull requests).
    pub fn applies_to(&self, kind: SearchType) -> bool {
        let item_only = self.state.is_some() || !self.authors.is_empty() || !self.labels.is_empty();
        let repo_scoped = !self.repos.is_empty() || !self.owners.is_empty() || self.visibility.is_some();
        match kind {
            SearchType::Repositories => self.paths.is_empty() && self.kind.is_none() && !item_only,
            SearchType::Code => self.kind.is_none() && !item_only,
            SearchType::Issues => {
                self.paths.is_empty() && self.languages.is_empty() && self.kind != Some(ItemKind::Pull)
                    && !matches!(self.state, Some(ItemState::Merged | ItemState::Draft))
            }
            SearchType::Pulls => self.paths.is_empty() && self.languages.is_empty() && self.kind != Some(ItemKind::Issue),
            SearchType::People => {
                self.paths.is_empty() && self.languages.is_empty() && self.kind.is_none() && !item_only && !repo_scoped
            }
        }
    }

    /// The full-text expression for prose (repositories, issues, people):
    /// every word, each a prefix as people type it, phrases exact, `-`
    /// words left out. `None` when there are no words to match.
    pub fn prose_match(&self) -> Option<String> {
        let words: Vec<&Term> = self
            .terms
            .iter()
            .filter(|term| term.text.chars().any(char::is_alphanumeric))
            .collect();
        let positive: Vec<&&Term> = words.iter().filter(|term| !term.negated).collect();
        if positive.is_empty() {
            return None;
        }
        let mut parts: Vec<String> = positive
            .iter()
            .map(|term| {
                let quoted = fts_string(&term.text);
                // A bare word that ends in a letter or digit also matches
                // longer words it starts: `pars` finds `parser`.
                let prefix = !term.phrase && term.text.chars().last().is_some_and(char::is_alphanumeric);
                if prefix { format!("{quoted}*") } else { quoted }
            })
            .collect();
        for term in words.iter().filter(|term| term.negated) {
            parts.push(format!("NOT {}", fts_string(&term.text)));
        }
        Some(parts.join(" "))
    }

    /// The full-text expression for code, which matches any run of three
    /// characters or more: each word or phrase as written. Shorter words
    /// cannot use the index and come back separately, to be matched
    /// against the text directly.
    pub fn code_match(&self) -> (Option<String>, Vec<String>) {
        let mut parts = Vec::new();
        let mut short = Vec::new();
        for term in self.positive() {
            if term.text.chars().count() >= 3 {
                parts.push(fts_string(&term.text));
            } else {
                short.push(term.text.to_lowercase());
            }
        }
        if parts.is_empty() {
            return (None, short);
        }
        for term in self.terms.iter().filter(|term| term.negated && term.text.chars().count() >= 3) {
            parts.push(format!("NOT {}", fts_string(&term.text)));
        }
        (Some(parts.join(" ")), short)
    }

    /// The query written back out, tidied, as results say it was read.
    pub fn display(&self) -> String {
        let mut out: Vec<String> = Vec::new();
        for term in &self.terms {
            let text = if term.phrase || term.text.contains(' ') { format!("\"{}\"", term.text) } else { term.text.clone() };
            out.push(if term.negated { format!("-{text}") } else { text });
        }
        let mut qualifier = |key: &str, filter: &Filter| {
            for value in &filter.include {
                out.push(format!("{key}:{}", quote_if_needed(value)));
            }
            for value in &filter.exclude {
                out.push(format!("-{key}:{}", quote_if_needed(value)));
            }
        };
        qualifier("repo", &self.repos);
        qualifier("org", &self.owners);
        qualifier("language", &self.languages);
        qualifier("path", &self.paths);
        qualifier("author", &self.authors);
        qualifier("label", &self.labels);
        match self.kind {
            Some(ItemKind::Issue) => out.push("is:issue".into()),
            Some(ItemKind::Pull) if !matches!(self.state, Some(ItemState::Merged | ItemState::Draft)) => out.push("is:pr".into()),
            _ => {}
        }
        match self.state {
            Some(ItemState::Open) => out.push("is:open".into()),
            Some(ItemState::Closed) => out.push("is:closed".into()),
            Some(ItemState::Merged) => out.push("is:merged".into()),
            Some(ItemState::Draft) => out.push("is:draft".into()),
            None => {}
        }
        match self.visibility {
            Some(Visibility::Public) => out.push("is:public".into()),
            Some(Visibility::Private) => out.push("is:private".into()),
            None => {}
        }
        out.join(" ")
    }
}

fn quote_if_needed(value: &str) -> String {
    if value.contains(' ') { format!("\"{value}\"") } else { value.to_owned() }
}

/// A string as the full-text index reads it: in double quotes, with any
/// double quote in it doubled, so nothing in it is read as syntax.
pub fn fts_string(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

/// A `path:` value as a SQL `LIKE` pattern: a glob when it has a `*`
/// (`*.rs`, `src/*/mod.rs`), else anywhere in the path. `%`, `_` and `\`
/// match themselves.
pub fn path_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    for c in value.chars() {
        match c {
            '\\' | '%' | '_' => {
                escaped.push('\\');
                escaped.push(c);
            }
            '*' => escaped.push('%'),
            '?' => escaped.push('_'),
            c => escaped.push(c),
        }
    }
    if value.contains('*') || value.contains('?') {
        escaped
    } else {
        format!("%{escaped}%")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(query: &Query) -> Vec<(&str, bool, bool)> {
        query.terms.iter().map(|t| (t.text.as_str(), t.phrase, t.negated)).collect()
    }

    #[test]
    fn words_phrases_and_left_out_words() {
        let query = Query::parse(r#"parse "exact phrase" -legacy  token"#);
        assert_eq!(
            words(&query),
            vec![("parse", false, false), ("exact phrase", true, false), ("legacy", false, true), ("token", false, false)]
        );
    }

    #[test]
    fn qualifiers_are_read() {
        let query = Query::parse("fn repo:Acme/Web org:acme language:TS path:src/ is:pr is:open author:@ana label:\"good first issue\"");
        assert_eq!(words(&query), vec![("fn", false, false)]);
        assert_eq!(query.repos.include, vec!["acme/web"]);
        assert_eq!(query.owners.include, vec!["acme"]);
        assert_eq!(query.languages.include, vec!["typescript"]);
        assert_eq!(query.paths.include, vec!["src/"]);
        assert_eq!(query.authors.include, vec!["ana"]);
        assert_eq!(query.labels.include, vec!["good first issue"]);
        assert_eq!(query.kind, Some(ItemKind::Pull));
        assert_eq!(query.state, Some(ItemState::Open));
        assert!(query.notes.is_empty());
    }

    #[test]
    fn workspace_and_org_mean_the_same() {
        assert_eq!(Query::parse("workspace:acme").owners, Query::parse("org:ACME").owners);
    }

    #[test]
    fn qualifiers_can_be_left_out() {
        let query = Query::parse("-label:wontfix -language:markdown -is:closed");
        assert_eq!(query.labels.exclude, vec!["wontfix"]);
        assert_eq!(query.languages.exclude, vec!["markdown"]);
        assert_eq!(query.state, Some(ItemState::Open));
    }

    #[test]
    fn unknown_keys_are_words() {
        let query = Query::parse("http://example.com std::io");
        assert_eq!(words(&query), vec![("http://example.com", false, false), ("std::io", false, false)]);
    }

    #[test]
    fn mistakes_are_said() {
        let query = Query::parse("repo:acme is:spaceship label:");
        assert_eq!(query.notes.len(), 3);
        assert!(query.repos.is_empty());
    }

    #[test]
    fn the_tab_follows_the_qualifiers() {
        assert_eq!(Query::parse("router").default_type(), SearchType::Repositories);
        assert_eq!(Query::parse("router path:src").default_type(), SearchType::Code);
        assert_eq!(Query::parse("crash is:pr").default_type(), SearchType::Pulls);
        assert_eq!(Query::parse("crash is:open").default_type(), SearchType::Issues);
        assert_eq!(Query::parse("crash label:bug").default_type(), SearchType::Issues);
        assert_eq!(Query::parse("crash type:code").default_type(), SearchType::Code);
    }

    #[test]
    fn qualifiers_rule_kinds_out() {
        let code = Query::parse("x path:src");
        assert!(code.applies_to(SearchType::Code));
        assert!(!code.applies_to(SearchType::Repositories));
        assert!(!code.applies_to(SearchType::Issues));
        let issues = Query::parse("x label:bug");
        assert!(issues.applies_to(SearchType::Issues) && issues.applies_to(SearchType::Pulls));
        assert!(!issues.applies_to(SearchType::Code) && !issues.applies_to(SearchType::People));
        let merged = Query::parse("x is:merged");
        assert!(merged.applies_to(SearchType::Pulls) && !merged.applies_to(SearchType::Issues));
        let scoped = Query::parse("x repo:a/b");
        assert!(!scoped.applies_to(SearchType::People));
        assert!(Query::parse("ana").applies_to(SearchType::People));
    }

    #[test]
    fn prose_matching_is_safe_and_prefixed() {
        let query = Query::parse(r#"pars "say hi" -old"#);
        assert_eq!(query.prose_match().unwrap(), r#""pars"* "say hi" NOT "old""#);
        // A quote inside a word is doubled, never read as syntax.
        assert_eq!(fts_string(r#"a"b"#), r#""a""b""#);
        // Punctuation alone matches nothing and is not sent.
        assert_eq!(Query::parse("++ --").prose_match(), None);
        // Only words left out: nothing to match on.
        assert_eq!(Query::parse("-old").prose_match(), None);
        // Words that look like the index's own syntax are only words.
        assert_eq!(Query::parse("NEAR OR").prose_match().unwrap(), r#""NEAR"* "OR"*"#);
    }

    #[test]
    fn code_matching_needs_three_characters() {
        let (expression, short) = Query::parse("fn parse_query -old").code_match();
        assert_eq!(expression.unwrap(), r#""parse_query" NOT "old""#);
        assert_eq!(short, vec!["fn"]);
        let (expression, short) = Query::parse("fn io").code_match();
        assert_eq!(expression, None);
        assert_eq!(short, vec!["fn", "io"]);
    }

    #[test]
    fn paths_become_patterns() {
        assert_eq!(path_pattern("src/"), "%src/%");
        assert_eq!(path_pattern("*.rs"), "%.rs");
        assert_eq!(path_pattern("100%_done"), "%100\\%\\_done%");
    }

    #[test]
    fn the_query_is_written_back_tidied() {
        let query = Query::parse("  Parse  REPO:acme/web \"two words\" is:issue ");
        assert_eq!(query.display(), "Parse \"two words\" repo:acme/web is:issue");
    }

    #[test]
    fn long_queries_are_cut() {
        let query = Query::parse(&"a ".repeat(1000));
        assert!(query.terms.len() <= MAX_QUERY_CHARS / 2);
    }
}
