//! What `#N` in text names, the one set of rules every reader of references
//! follows: closing keywords in pull requests and commits (work), Markdown
//! on the site, chat and the CLI. `apps/web/app/lib/refs.ts` mirrors it.
//!
//! A reference is `#N`, `owner/name#N` (read in that repository's context)
//! or `workspace#N` (in that workspace's). Read in a repository R of
//! workspace W, `#N` is the first of:
//!
//! 1. a pull request of R numbered N;
//! 2. a work item filed in R whose number there was N (an old issue);
//! 3. the work item numbered N in W;
//! 4. a pull request numbered N in another repository of W, when N is
//!    above W's floor: new pull requests are numbered in the workspace, so
//!    those are unique; the numbers its repositories used on their own
//!    before collide, and name none of them from elsewhere.
//!
//! Read in a workspace alone, `#N` is the work item N in W, else a pull
//! request numbered N in W, above its floor. The work service's `resolve_ref` does the
//! lookups.
//!
//! What sits in code, a `span` or a fenced block, is no reference: it is
//! usually an example.

use crate::repos::RepoPath;

/// Where a reference is read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefScope {
    /// `#N`: in the context it is written in.
    Here,
    /// `owner/name#N`: in that repository.
    Repo(RepoPath),
    /// `workspace#N`: in that workspace.
    Workspace(String),
}

/// A reference found in text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ref {
    pub scope: RefScope,
    pub number: u32,
}

impl Ref {
    /// The repository it is read in, given the one it was written in:
    /// its own for `owner/name#N`, `here` for `#N`, none for `workspace#N`.
    pub fn repo<'a>(&'a self, here: Option<&'a RepoPath>) -> Option<&'a RepoPath> {
        match &self.scope {
            RefScope::Here => here,
            RefScope::Repo(repo) => Some(repo),
            RefScope::Workspace(_) => None,
        }
    }

    /// The workspace it is read in, given the one it was written in.
    pub fn workspace<'a>(&'a self, here: &'a str) -> &'a str {
        match &self.scope {
            RefScope::Here => here,
            RefScope::Repo(repo) => &repo.namespace,
            RefScope::Workspace(workspace) => workspace,
        }
    }
}

/// One place `#N` may name something, in the order [`lookup_order`] gives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lookup {
    /// A pull request of the repository it is read in.
    PullInRepo,
    /// A work item filed in that repository, by the number it had there.
    LegacyItem,
    /// The work item of the workspace with that number.
    Item,
    /// A pull request of another repository of the workspace.
    PullInWorkspace,
}

/// Where to look for `#N`, first to last: read in a repository, or in a
/// workspace alone.
pub fn lookup_order(in_repo: bool) -> &'static [Lookup] {
    if in_repo {
        &[Lookup::PullInRepo, Lookup::LegacyItem, Lookup::Item, Lookup::PullInWorkspace]
    } else {
        &[Lookup::Item, Lookup::PullInWorkspace]
    }
}

/// The first of `lookup_order(in_repo)` that `found` finds.
pub fn first_found<T>(in_repo: bool, mut found: impl FnMut(Lookup) -> Option<T>) -> Option<T> {
    lookup_order(in_repo).iter().find_map(|lookup| found(*lookup))
}

/// The words that close a work item: `Fixes #12`.
pub const CLOSING_KEYWORDS: [&str; 9] = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"];

/// The words that tie work to a work item without closing it: `Part of #12`,
/// `Refs #12`.
pub const PART_KEYWORDS: [&str; 3] = ["part of", "refs", "ref"];

/// The most references one text closes or is part of.
pub const MAX_REFS: usize = 50;

/// What a pull request or commit says about the work items it names.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Named {
    /// After a closing keyword, in the order named, each once.
    pub closes: Vec<Ref>,
    /// After `Part of` or `Refs`, in the order named, each once, leaving
    /// out what it also closes.
    pub parts: Vec<Ref>,
}

/// The references `text` names after closing keywords and after `Part of`
/// or `Refs`, outside code.
pub fn named(text: &str) -> Named {
    let mut named = Named::default();
    for prose in outside_code(text) {
        scan(&prose, &mut named);
    }
    named.parts.retain(|part| !named.closes.contains(part));
    named.closes.truncate(MAX_REFS);
    named.parts.truncate(MAX_REFS);
    named
}

/// Every reference in `text` outside code, in order, each once: `#12`,
/// `owner/name#12` and `workspace#12`, for rendering them as links.
pub fn refs_in_text(text: &str) -> Vec<Ref> {
    let mut found: Vec<Ref> = Vec::new();
    for prose in outside_code(text) {
        let chars: Vec<char> = prose.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let starts = i == 0 || !is_name(chars[i - 1]) && chars[i - 1] != '#' && chars[i - 1] != '&';
            if starts && let Some((reference, after)) = reference_at(&chars, i) {
                if !found.contains(&reference) {
                    found.push(reference);
                }
                i = after;
                continue;
            }
            i += 1;
        }
    }
    found
}

/// A single reference, the whole of `text`: `#12`, `owner/name#12` or
/// `workspace#12`.
pub fn parse_ref(text: &str) -> Option<Ref> {
    let chars: Vec<char> = text.trim().chars().collect();
    match reference_at(&chars, 0) {
        Some((reference, after)) if after == chars.len() => Some(reference),
        _ => None,
    }
}

/// The parts of Markdown outside fenced code blocks and code spans, each
/// with code replaced by a space so words on either side stay apart.
pub fn outside_code(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    // The fence that opened the block being skipped: its character and length.
    let mut fence: Option<(char, usize)> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        let opener = ['`', '~'].into_iter().find_map(|mark| {
            let run = trimmed.chars().take_while(|c| *c == mark).count();
            (run >= 3).then_some((mark, run))
        });
        match (fence, opener) {
            (None, Some(opened)) => {
                fence = Some(opened);
                parts.push(std::mem::take(&mut current));
            }
            (Some((mark, length)), Some((closing, run)))
                if closing == mark && run >= length && trimmed.trim_end().chars().all(|c| c == mark) =>
            {
                fence = None;
            }
            (Some(_), _) => {}
            (None, None) => {
                current.push_str(&without_spans(line));
                current.push('\n');
            }
        }
    }
    parts.push(current);
    parts
}

/// A line with its code spans (between matching runs of backticks) blanked.
fn without_spans(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '`' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let run = chars[i..].iter().take_while(|c| **c == '`').count();
        // The closing run of the same length, if there is one.
        let mut j = i + run;
        let mut close = None;
        while j < chars.len() {
            if chars[j] == '`' {
                let other = chars[j..].iter().take_while(|c| **c == '`').count();
                if other == run {
                    close = Some(j + other);
                    break;
                }
                j += other;
            } else {
                j += 1;
            }
        }
        match close {
            Some(end) => {
                out.push(' ');
                i = end;
            }
            // An unmatched run is literal backticks.
            None => {
                out.extend(&chars[i..i + run]);
                i += run;
            }
        }
    }
    out
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// A character of a workspace or repository name.
fn is_name(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
}

/// Every keyword-and-reference pair in `text`.
fn scan(text: &str, named: &mut Named) {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // A word starts here.
        if !is_word(chars[i]) || (i > 0 && is_word(chars[i - 1])) {
            i += 1;
            continue;
        }
        let end = chars[i..].iter().position(|c| !is_word(*c)).map_or(chars.len(), |n| i + n);
        let word: String = chars[i..end].iter().collect::<String>().to_lowercase();
        let (closing, end) = if CLOSING_KEYWORDS.contains(&word.as_str()) {
            (true, end)
        } else if PART_KEYWORDS.contains(&word.as_str()) {
            (false, end)
        } else if word == "part" {
            // `part of`, with spaces between.
            let spaces = chars[end..].iter().take_while(|c| **c == ' ' || **c == '\t').count();
            let of: String = chars[(end + spaces).min(chars.len())..].iter().take(2).collect::<String>().to_lowercase();
            let after = end + spaces + 2;
            if spaces == 0 || of != "of" || chars.get(after).is_some_and(|c| is_word(*c)) {
                i = end;
                continue;
            }
            (false, after)
        } else {
            i = end;
            continue;
        };
        i = end;
        // An optional colon, then spaces on the same line; without a colon,
        // at least one space.
        let mut at = end;
        let colon = chars.get(at) == Some(&':');
        if colon {
            at += 1;
        }
        let spaces = chars[at..].iter().take_while(|c| **c == ' ' || **c == '\t').count();
        if spaces == 0 && !colon {
            continue;
        }
        at += spaces;
        if let Some((reference, after)) = reference_at(&chars, at) {
            let list = if closing { &mut named.closes } else { &mut named.parts };
            if !list.contains(&reference) {
                list.push(reference);
            }
            i = after;
        }
    }
}

/// A reference at `at`: `#12`, `owner/name#12` or `workspace#12`, ending at
/// a word boundary. The reference and where it ends.
fn reference_at(chars: &[char], at: usize) -> Option<(Ref, usize)> {
    let length = chars[at..].iter().position(|c| *c == '#' || !(is_name(*c) || *c == '/')).unwrap_or(chars.len() - at);
    let hash = at + length;
    if chars.get(hash) != Some(&'#') {
        return None;
    }
    let named: String = chars[at..hash].iter().collect();
    let scope = if named.is_empty() {
        RefScope::Here
    } else {
        match named.split_once('/') {
            Some((owner, name)) => {
                if owner.is_empty() || name.is_empty() || name.contains('/') {
                    return None;
                }
                RefScope::Repo(RepoPath { namespace: owner.to_lowercase(), name: name.to_owned() })
            }
            None => RefScope::Workspace(named.to_lowercase()),
        }
    };
    let digits = chars[hash + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits > 9 {
        return None;
    }
    let after = hash + 1 + digits;
    if chars.get(after).is_some_and(|c| is_word(*c)) {
        return None;
    }
    let number: u32 = chars[hash + 1..after].iter().collect::<String>().parse().ok()?;
    (number > 0).then_some((Ref { scope, number }, after))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn here(number: u32) -> Ref {
        Ref { scope: RefScope::Here, number }
    }

    fn repo(owner: &str, name: &str, number: u32) -> Ref {
        Ref { scope: RefScope::Repo(RepoPath { namespace: owner.into(), name: name.into() }), number }
    }

    fn closes(text: &str) -> Vec<Ref> {
        named(text).closes
    }

    #[test]
    fn every_keyword_closes_whatever_its_case() {
        for keyword in CLOSING_KEYWORDS {
            assert_eq!(closes(&format!("{keyword} #7")), vec![here(7)], "{keyword}");
            assert_eq!(closes(&format!("{} #7", keyword.to_uppercase())), vec![here(7)], "{keyword}");
        }
        assert_eq!(closes("Fixes: #12"), vec![here(12)]);
        assert_eq!(closes("fixes:#12"), vec![here(12)]);
        assert_eq!(closes("This fixes #3 and resolves #4, closes #3 again."), vec![here(3), here(4)]);
    }

    #[test]
    fn only_whole_words_and_whole_numbers() {
        assert!(closes("prefixes #3").is_empty());
        assert!(closes("fixesthis #3").is_empty());
        assert!(closes("fixes#3").is_empty(), "no space and no colon");
        assert!(closes("fixes #3a").is_empty());
        assert!(closes("fixes #").is_empty());
        assert!(closes("fixes #0").is_empty());
        assert!(closes("fixes\n#3").is_empty(), "on the same line");
        assert_eq!(closes("(fixes #3)."), vec![here(3)]);
        assert!(closes("fixes issue #3").is_empty(), "the reference follows the keyword");
    }

    #[test]
    fn a_reference_names_its_repository_or_workspace() {
        assert_eq!(closes("Closes flagon-io/g1t#40"), vec![repo("flagon-io", "g1t", 40)]);
        assert_eq!(closes("closes Flagon-IO/g1t#40"), vec![repo("flagon-io", "g1t", 40)]);
        assert_eq!(closes("closes acme#9"), vec![Ref { scope: RefScope::Workspace("acme".into()), number: 9 }]);
        assert!(closes("closes a/b/c#4").is_empty());
        assert_eq!(parse_ref("acme/web#3"), Some(repo("acme", "web", 3)));
        assert_eq!(parse_ref(" #3 "), Some(here(3)));
        assert_eq!(parse_ref("#3 and more"), None);
    }

    #[test]
    fn part_of_and_refs_link_without_closing() {
        let found = named("Part of #12, refs acme/api#3. Fixes #4; part of #4");
        assert_eq!(found.closes, vec![here(4)]);
        assert_eq!(found.parts, vec![here(12), repo("acme", "api", 3)]);
        assert!(named("partly #3").parts.is_empty());
        assert!(named("part #3").parts.is_empty());
        assert_eq!(named("Part  of: #8").parts, vec![here(8)]);
    }

    #[test]
    fn code_says_nothing() {
        assert!(closes("Write `fixes #3` to close a work item.").is_empty());
        assert!(closes("Write ``fixes #3 `x` `` here.").is_empty());
        assert!(closes("```\nfixes #3\n```").is_empty());
        assert!(closes("~~~md\nfixes #3\n~~~").is_empty());
        assert_eq!(closes("```\nfixes #3\n```\nfixes #4"), vec![here(4)]);
        // An unclosed span is just a backtick.
        assert_eq!(closes("a ` fixes #5"), vec![here(5)]);
        // An unclosed fence hides the rest.
        assert!(closes("````\nfixes #6\n```\nfixes #7").is_empty());
    }

    #[test]
    fn no_more_than_fifty() {
        let many: String = (1..=80).map(|n| format!("fixes #{n} ")).collect();
        assert_eq!(closes(&many).len(), MAX_REFS);
    }

    #[test]
    fn references_in_text_are_found_once_each() {
        let text = "See #4, acme/web#7 and acme#9; not &#39;, #4a or `#5`. #4 again.";
        assert_eq!(refs_in_text(text), vec![here(4), repo("acme", "web", 7), Ref { scope: RefScope::Workspace("acme".into()), number: 9 }]);
    }

    #[test]
    fn in_a_repository_its_own_pull_requests_and_old_issues_come_first() {
        assert_eq!(lookup_order(true), [Lookup::PullInRepo, Lookup::LegacyItem, Lookup::Item, Lookup::PullInWorkspace]);
        assert_eq!(lookup_order(false), [Lookup::Item, Lookup::PullInWorkspace]);
        // An old issue of the repository wins over the workspace's item of
        // the same number; a pull request of the repository over both.
        let found = |have: &[Lookup]| first_found(true, |lookup| have.contains(&lookup).then_some(lookup));
        assert_eq!(found(&[Lookup::Item, Lookup::LegacyItem]), Some(Lookup::LegacyItem));
        assert_eq!(found(&[Lookup::Item, Lookup::PullInRepo, Lookup::LegacyItem]), Some(Lookup::PullInRepo));
        assert_eq!(found(&[Lookup::PullInWorkspace]), Some(Lookup::PullInWorkspace));
        assert_eq!(found(&[]), None);
        let written = repo("acme", "api", 3);
        let web = RepoPath { namespace: "acme".into(), name: "web".into() };
        assert_eq!(written.repo(Some(&web)).map(|r| r.name.as_str()), Some("api"));
        assert_eq!(here(3).workspace("acme"), "acme");
    }
}
