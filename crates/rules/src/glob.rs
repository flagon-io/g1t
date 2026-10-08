//! fnmatch patterns, for branch and tag names, repository names and file
//! paths.
//!
//! - `*` matches any run of characters but `/`.
//! - `**` matches any run of characters, `/` included; `**/` also matches
//!   no directory at all, so `docs/**/*.md` matches `docs/a.md`.
//! - `?` matches one character but `/`.
//! - `[abc]`, `[a-z]` match one character of the set; `[!abc]` or `[^abc]`
//!   one not in it.
//! - `\` makes the next character literal.
//!
//! Matching is a table over pattern and text positions, so it takes time in
//! proportion to their lengths multiplied, never more.

/// One piece of a pattern.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Token {
    Literal(char),
    /// `?`
    One,
    /// `*`
    Star,
    /// `**`, and whether a `/` follows it (`**/`), which it may skip.
    Globstar { slash: bool },
    Class { negated: bool, items: Vec<(char, char)> },
}

fn tokens(pattern: &str) -> Vec<Token> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        match chars[at] {
            '\\' if at + 1 < chars.len() => {
                out.push(Token::Literal(chars[at + 1]));
                at += 2;
            }
            '*' if chars.get(at + 1) == Some(&'*') => {
                let slash = chars.get(at + 2) == Some(&'/');
                out.push(Token::Globstar { slash });
                at += if slash { 3 } else { 2 };
                // More stars right after `**` say no more.
                while !slash && chars.get(at) == Some(&'*') {
                    at += 1;
                }
            }
            '*' => {
                out.push(Token::Star);
                at += 1;
            }
            '?' => {
                out.push(Token::One);
                at += 1;
            }
            '[' => match class(&chars, at) {
                Some((token, next)) => {
                    out.push(token);
                    at = next;
                }
                None => {
                    out.push(Token::Literal('['));
                    at += 1;
                }
            },
            c => {
                out.push(Token::Literal(c));
                at += 1;
            }
        }
    }
    out
}

/// A `[...]` class starting at `start`, and where the pattern goes on.
fn class(chars: &[char], start: usize) -> Option<(Token, usize)> {
    let mut at = start + 1;
    let negated = matches!(chars.get(at), Some('!' | '^'));
    if negated {
        at += 1;
    }
    let mut items = Vec::new();
    let mut first = true;
    loop {
        let c = *chars.get(at)?;
        if c == ']' && !first {
            return Some((Token::Class { negated, items }, at + 1));
        }
        first = false;
        let c = if c == '\\' {
            at += 1;
            *chars.get(at)?
        } else {
            c
        };
        if chars.get(at + 1) == Some(&'-') && chars.get(at + 2).is_some_and(|end| *end != ']') {
            items.push((c, chars[at + 2]));
            at += 3;
        } else {
            items.push((c, c));
            at += 1;
        }
    }
}

fn in_class(c: char, negated: bool, items: &[(char, char)]) -> bool {
    let found = items.iter().any(|(low, high)| (*low..=*high).contains(&c));
    found != negated && c != '/'
}

/// Whether `text` matches `pattern`, exactly.
pub fn matches(pattern: &str, text: &str) -> bool {
    let tokens = tokens(pattern);
    let text: Vec<char> = text.chars().collect();
    // done[t][p]: whether text[t..] matches tokens[p..].
    let (rows, cols) = (text.len() + 1, tokens.len() + 1);
    let mut done = vec![false; rows * cols];
    done[text.len() * cols + tokens.len()] = true;
    for t in (0..rows).rev() {
        for p in (0..tokens.len()).rev() {
            let next = |t: usize, p: usize| done[t * cols + p];
            let here = match &tokens[p] {
                Token::Literal(c) => t < text.len() && text[t] == *c && next(t + 1, p + 1),
                Token::One => t < text.len() && text[t] != '/' && next(t + 1, p + 1),
                Token::Class { negated, items } => {
                    t < text.len() && in_class(text[t], *negated, items) && next(t + 1, p + 1)
                }
                // Nothing more, or one more character (not `/`) and the star again.
                Token::Star => next(t, p + 1) || (t < text.len() && text[t] != '/' && next(t + 1, p)),
                Token::Globstar { slash: false } => next(t, p + 1) || (t < text.len() && next(t + 1, p)),
                // `**/`: no directory at all, or any run ending in `/`.
                Token::Globstar { slash: true } => {
                    next(t, p + 1)
                        || (t < text.len() && {
                            // Consume up to and including a `/`.
                            let mut end = t;
                            let mut found = false;
                            while end < text.len() {
                                if text[end] == '/' && next(end + 1, p + 1) {
                                    found = true;
                                    break;
                                }
                                end += 1;
                            }
                            found
                        })
                }
            };
            done[t * cols + p] = here;
        }
    }
    done[0]
}

/// Whether a file path matches a path pattern. A pattern with no `/` in it
/// matches a file of that name in any directory (`*.exe`, `CODEOWNERS`);
/// one with a `/` matches from the repository's root, a leading `/`
/// optional. A pattern ending in `/` matches everything under it.
pub fn path_matches(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return false;
    }
    let path = path.trim_start_matches('/');
    if let Some(directory) = pattern.strip_suffix('/') {
        let directory = directory.trim_start_matches('/');
        return matches(&format!("{directory}/**"), path);
    }
    if !pattern.contains('/') {
        let name = path.rsplit('/').next().unwrap_or(path);
        return matches(pattern, name) || matches(pattern, path);
    }
    matches(pattern.trim_start_matches('/'), path)
}

/// Whether a pattern is one [`matches`] reads as written: its classes are
/// closed. Anything else is still matched, as literal text.
pub fn well_formed(pattern: &str) -> bool {
    let chars: Vec<char> = pattern.chars().collect();
    let mut at = 0;
    while at < chars.len() {
        match chars[at] {
            '\\' => at += 2,
            '[' => match class(&chars, at) {
                Some((_, next)) => at = next,
                None => return false,
            },
            _ => at += 1,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_star_stays_within_a_segment() {
        assert!(matches("release/*", "release/1.x"));
        assert!(!matches("release/*", "release/1.x/hotfix"));
        assert!(!matches("release/*", "release"));
        assert!(matches("*", "main"));
        assert!(!matches("*", "feature/x"));
        assert!(matches("feat*", "feature"));
        assert!(matches("*-rc", "v1-rc"));
    }

    #[test]
    fn a_globstar_crosses_segments() {
        assert!(matches("release/**", "release/1.x/hotfix"));
        assert!(matches("**", "a/b/c"));
        assert!(matches("docs/**/*.md", "docs/a.md"));
        assert!(matches("docs/**/*.md", "docs/guides/deep/a.md"));
        assert!(!matches("docs/**/*.md", "src/a.md"));
        assert!(matches(".g1t/workflows/**", ".g1t/workflows/ci.yml"));
        assert!(matches("**/secrets.json", "secrets.json"));
        assert!(matches("**/secrets.json", "config/prod/secrets.json"));
    }

    #[test]
    fn single_characters_and_classes() {
        assert!(matches("v?", "v1"));
        assert!(!matches("v?", "v10"));
        assert!(!matches("a?b", "a/b"));
        assert!(matches("v[0-9]*", "v1.2"));
        assert!(!matches("v[0-9]*", "va"));
        assert!(matches("[!m]*", "dev"));
        assert!(!matches("[!m]*", "main"));
        assert!(matches("[^m]*", "dev"));
        assert!(matches("[]]", "]"));
    }

    #[test]
    fn escapes_and_unclosed_classes_are_literal() {
        assert!(matches(r"a\*b", "a*b"));
        assert!(!matches(r"a\*b", "axb"));
        assert!(matches("a[b", "a[b"));
        assert!(!well_formed("a[b"));
        assert!(well_formed("release/[0-9]*"));
    }

    #[test]
    fn exact_names_match_only_themselves() {
        assert!(matches("main", "main"));
        assert!(!matches("main", "mainline"));
        assert!(!matches("main", "Main"));
        assert!(matches("", ""));
        assert!(!matches("", "x"));
    }

    #[test]
    fn long_texts_do_not_take_long() {
        let text = "a".repeat(2000);
        let pattern = "*a*a*a*a*a*a*a*a*b";
        assert!(!matches(pattern, &text));
    }

    #[test]
    fn paths_without_a_slash_match_a_name_anywhere() {
        assert!(path_matches("CODEOWNERS", "CODEOWNERS"));
        assert!(path_matches("CODEOWNERS", ".g1t/CODEOWNERS"));
        assert!(path_matches("*.exe", "bin/tool.exe"));
        assert!(!path_matches("*.exe", "bin/tool.exe.txt"));
        assert!(path_matches("/infra/**", "infra/main.tf"));
        assert!(path_matches("infra/", "infra/modules/a.tf"));
        assert!(!path_matches("infra/", "src/infra.rs"));
        assert!(!path_matches("src/*.rs", "lib/src/a.rs"));
        assert!(!path_matches("  ", "a"));
    }
}
