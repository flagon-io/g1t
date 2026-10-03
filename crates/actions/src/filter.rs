//! Branch, tag and path filters, with GitHub's pattern syntax:
//!
//! - `*` matches any characters except `/`; `**` matches any characters.
//! - `?` makes the character before it optional; `+` repeats it.
//! - `[a-z0-9]` matches one character of a set.
//! - `!` at the start of a pattern excludes what it matches. Patterns are
//!   read in order and the last one that matches decides.
//! - `\` escapes the next character.

#[derive(Clone, Debug, PartialEq, Eq)]
enum Atom {
    Char(char),
    Class(Vec<(char, char)>),
    /// `*`: anything but `/`.
    Star,
    /// `**`: anything.
    Globstar,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Repeat {
    One,
    /// `?`
    Optional,
    /// `+`
    OneOrMore,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Piece {
    atom: Atom,
    repeat: Repeat,
}

/// One compiled pattern.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pattern {
    pieces: Vec<Piece>,
    pub negated: bool,
    pub source: String,
}

impl Pattern {
    pub fn parse(source: &str) -> Pattern {
        let (negated, body) = match source.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, source),
        };
        let chars: Vec<char> = body.chars().collect();
        let mut pieces: Vec<Piece> = Vec::new();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            match c {
                '*' if chars.get(i + 1) == Some(&'*') => {
                    pieces.push(Piece { atom: Atom::Globstar, repeat: Repeat::One });
                    i += 2;
                }
                '*' => {
                    pieces.push(Piece { atom: Atom::Star, repeat: Repeat::One });
                    i += 1;
                }
                '?' | '+' if pieces.last().is_some_and(|p| p.repeat == Repeat::One && !matches!(p.atom, Atom::Star | Atom::Globstar)) => {
                    pieces.last_mut().expect("checked").repeat = if c == '?' { Repeat::Optional } else { Repeat::OneOrMore };
                    i += 1;
                }
                '[' => {
                    // A set, up to the next `]`; without one, a literal `[`.
                    match chars[i + 1..].iter().position(|&x| x == ']') {
                        Some(len) if len > 0 => {
                            let inner = &chars[i + 1..i + 1 + len];
                            let mut ranges = Vec::new();
                            let mut j = 0;
                            while j < inner.len() {
                                if j + 2 < inner.len() && inner[j + 1] == '-' {
                                    ranges.push((inner[j], inner[j + 2]));
                                    j += 3;
                                } else {
                                    ranges.push((inner[j], inner[j]));
                                    j += 1;
                                }
                            }
                            pieces.push(Piece { atom: Atom::Class(ranges), repeat: Repeat::One });
                            i += len + 2;
                        }
                        _ => {
                            pieces.push(Piece { atom: Atom::Char('['), repeat: Repeat::One });
                            i += 1;
                        }
                    }
                }
                '\\' if i + 1 < chars.len() => {
                    pieces.push(Piece { atom: Atom::Char(chars[i + 1]), repeat: Repeat::One });
                    i += 2;
                }
                other => {
                    pieces.push(Piece { atom: Atom::Char(other), repeat: Repeat::One });
                    i += 1;
                }
            }
        }
        Pattern { pieces, negated, source: source.to_owned() }
    }

    /// Whether the text matches, ignoring `!`.
    pub fn matches(&self, text: &str) -> bool {
        let text: Vec<char> = text.chars().collect();
        matches_at(&self.pieces, &text)
    }
}

fn atom_matches(atom: &Atom, c: char) -> bool {
    match atom {
        Atom::Char(expected) => *expected == c,
        Atom::Class(ranges) => ranges.iter().any(|(low, high)| (*low..=*high).contains(&c)),
        Atom::Star => c != '/',
        Atom::Globstar => true,
    }
}

fn matches_at(pieces: &[Piece], text: &[char]) -> bool {
    let Some((piece, rest)) = pieces.split_first() else {
        return text.is_empty();
    };
    match (&piece.atom, &piece.repeat) {
        (Atom::Star | Atom::Globstar, _) => {
            // `**/` also matches nothing, so `**/README.md` finds the root's.
            if piece.atom == Atom::Globstar
                && rest.first().is_some_and(|next| next.atom == Atom::Char('/') && next.repeat == Repeat::One)
                && matches_at(&rest[1..], text)
            {
                return true;
            }
            // Zero or more, as long as each character is allowed.
            for taken in 0..=text.len() {
                if matches_at(rest, &text[taken..]) {
                    return true;
                }
                if taken < text.len() && !atom_matches(&piece.atom, text[taken]) {
                    return false;
                }
            }
            false
        }
        (atom, Repeat::One) => text.first().is_some_and(|&c| atom_matches(atom, c)) && matches_at(rest, &text[1..]),
        (atom, Repeat::Optional) => {
            matches_at(rest, text) || (text.first().is_some_and(|&c| atom_matches(atom, c)) && matches_at(rest, &text[1..]))
        }
        (atom, Repeat::OneOrMore) => {
            let mut taken = 0;
            while taken < text.len() && atom_matches(atom, text[taken]) {
                taken += 1;
                if matches_at(rest, &text[taken..]) {
                    return true;
                }
            }
            false
        }
    }
}

/// A list of patterns, read in order: a later `!pattern` excludes what an
/// earlier one included, and a later pattern can include it again.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Patterns(pub Vec<Pattern>);

impl Patterns {
    pub fn new<S: AsRef<str>>(sources: &[S]) -> Patterns {
        Patterns(sources.iter().map(|source| Pattern::parse(source.as_ref())).collect())
    }

    /// Whether the text is included.
    pub fn includes(&self, text: &str) -> bool {
        let mut included = false;
        for pattern in &self.0 {
            if pattern.matches(text) {
                included = !pattern.negated;
            }
        }
        included
    }

    /// Whether any pattern matches the text (for `-ignore` lists, where
    /// `!` patterns put a text back).
    pub fn ignores(&self, text: &str) -> bool {
        self.includes(text)
    }
}

/// A filter as a workflow gives it: `branches` or `branches-ignore`,
/// `tags` or `tags-ignore`, `paths` or `paths-ignore`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Filter {
    pub only: Option<Patterns>,
    pub ignore: Option<Patterns>,
}

impl Filter {
    pub fn is_set(&self) -> bool {
        self.only.is_some() || self.ignore.is_some()
    }

    /// Whether one name (a branch or a tag) passes.
    pub fn allows(&self, name: &str) -> bool {
        if let Some(only) = &self.only
            && !only.includes(name)
        {
            return false;
        }
        if let Some(ignore) = &self.ignore
            && ignore.ignores(name)
        {
            return false;
        }
        true
    }

    /// Whether a set of changed paths passes: `paths` needs at least one
    /// included path; `paths-ignore` needs at least one path not ignored.
    /// With no paths known, it passes.
    pub fn allows_paths(&self, paths: &[String]) -> bool {
        if paths.is_empty() {
            return true;
        }
        if let Some(only) = &self.only
            && !paths.iter().any(|path| only.includes(path))
        {
            return false;
        }
        if let Some(ignore) = &self.ignore
            && paths.iter().all(|path| ignore.ignores(path))
        {
            return false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pattern: &str, text: &str) -> bool {
        Pattern::parse(pattern).matches(text)
    }

    #[test]
    fn stars_and_globstars() {
        assert!(m("main", "main"));
        assert!(!m("main", "mainline"));
        assert!(m("releases/*", "releases/v1"));
        assert!(!m("releases/*", "releases/v1/hotfix"));
        assert!(m("releases/**", "releases/v1/hotfix"));
        assert!(m("feature/**", "feature/a/b/c"));
        assert!(m("*", "main"));
        assert!(!m("*", "feature/x"));
        assert!(m("**", "feature/x"));
        assert!(m("**.js", "src/app/index.js"));
        assert!(m("*.js", "index.js"));
        assert!(!m("*.js", "src/index.js"));
        assert!(m("docs/**", "docs/guide/intro.md"));
        assert!(m("**/README.md", "a/b/README.md"));
        assert!(m("**/*.md", "README.md"));
        assert!(m("**/README.md", "README.md"));
        assert!(m("**/README.md", "server/README.md"));
    }

    #[test]
    fn repeats_classes_and_escapes() {
        assert!(m("v[12].[0-9]+.[0-9]+", "v1.10.3"));
        assert!(!m("v[12].[0-9]+.[0-9]+", "v3.1.0"));
        assert!(m("v2*", "v2.0.0"));
        assert!(m("colou?r", "color"));
        assert!(m("colou?r", "colour"));
        assert!(m("v[0-9]+", "v123"));
        assert!(!m("v[0-9]+", "v"));
        assert!(m("a\\*b", "a*b"));
        assert!(!m("a\\*b", "axb"));
    }

    #[test]
    fn order_decides_with_negations() {
        let list = Patterns::new(&["releases/**", "!releases/**-alpha"]);
        assert!(list.includes("releases/v1"));
        assert!(!list.includes("releases/v1-alpha"));
        let again = Patterns::new(&["**", "!docs/**", "docs/api/**"]);
        assert!(again.includes("src/a.rs"));
        assert!(!again.includes("docs/intro.md"));
        assert!(again.includes("docs/api/x.md"));
    }

    #[test]
    fn filters_for_names_and_paths() {
        let branches = Filter { only: Some(Patterns::new(&["main", "release/**"])), ignore: None };
        assert!(branches.allows("main"));
        assert!(branches.allows("release/2.0"));
        assert!(!branches.allows("feature/x"));
        let ignored = Filter { only: None, ignore: Some(Patterns::new(&["dependabot/**"])) };
        assert!(!ignored.allows("dependabot/npm/x"));
        assert!(ignored.allows("main"));

        let paths = Filter { only: Some(Patterns::new(&["src/**", "!src/**/*.md"])), ignore: None };
        assert!(paths.allows_paths(&["src/main.rs".into()]));
        assert!(!paths.allows_paths(&["src/notes.md".into(), "README.md".into()]));
        let docs = Filter { only: None, ignore: Some(Patterns::new(&["docs/**", "*.md"])) };
        assert!(!docs.allows_paths(&["docs/a.md".into(), "README.md".into()]));
        assert!(docs.allows_paths(&["docs/a.md".into(), "src/lib.rs".into()]));
        assert!(docs.allows_paths(&[]));
    }
}
