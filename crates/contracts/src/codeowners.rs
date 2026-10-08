//! Code owners: who owns which paths in a repository, as a CODEOWNERS
//! file says, and whether a pull request has the reviews they ask for.
//!
//! **Where the file is.** g1t reads one file from the branch a pull
//! request merges into: the first of [`LOCATIONS`] that exists
//! ([`pick_location`]). A file larger than [`MAX_BYTES`] is ignored as a
//! whole, with one error saying so.
//!
//! **Rules.** Each line is a pattern, then zero or more owners separated
//! by whitespace. An owner is a person (`@ana`), a team (`@acme/backend`)
//! or an email address (`ana@example.com`). For each path, the last rule
//! that matches it wins, so later lines override earlier ones; a rule
//! with no owners says the path has none. `#` starts a comment at the
//! start of a line or after whitespace; `\#` at the start of a pattern
//! stands for a literal `#`, and `\ ` for a space inside a pattern. Blank
//! lines, a byte order mark and `\r\n` line ends are all fine.
//!
//! **Patterns** follow the CODEOWNERS format, which takes its rules from
//! ignore files:
//!
//! - `*` matches anything but `/`, and `?` one character but `/`.
//! - `**/` at the start matches in every directory, `/**` at the end
//!   matches everything inside, and `/**/` matches zero or more
//!   directories. `**` anywhere else is the same as `*`.
//! - A leading `/`, or a `/` anywhere but at the end, anchors the pattern
//!   to the root of the repository. Without one, it matches at any depth.
//! - A trailing `/` names a directory: it matches everything inside one
//!   of that name, never a file of that name.
//! - A pattern that matches a directory matches every file under it, so
//!   `docs` owns `docs/a.md` and `x/docs/y/z.md`. The exception is a
//!   pattern whose last part has a wildcard, such as `docs/*` or
//!   `*.md`: it matches files only, so `docs/*` owns `docs/a.md` but not
//!   `docs/sub/a.md`, as the standard says.
//! - Paths are case-sensitive.
//!
//! Negation (`!`) and character ranges (`[a-z]`) are not part of the
//! standard; a line that uses them is reported and skipped.
//!
//! **Sections.** A line like `[Docs]` starts a named section, and the
//! rules after it belong to it until the next header. Every section,
//! and the default section before the first header, applies its own last
//! match, so one path can need reviews from several sections. A header
//! may say how many approvals the section needs (`[Docs][2]`, from 1 to
//! 10, 1 when left out), that it is optional (`^[Docs]`: its owners are
//! asked but not required), and default owners (`[Docs] @acme/writers`)
//! that a rule in it gets when it names none. Two headers with the same
//! name, compared without regard to case, are one section: the first
//! spelling is kept, and a later header's approvals and default owners
//! replace the earlier ones when it gives them; a later `^` makes the
//! section optional. A malformed header is reported, and the rules after
//! it stay in the section before.
//!
//! **Reviews.** [`CodeOwners::requirements`] turns a pull request's
//! changed paths into the reviews they need, [`evaluate`] says where each
//! stands given the reviewers' latest verdicts, and [`missing`] writes the
//! sentence a refused merge shows. [`check_owners`] reports owners that
//! do not resolve to someone who can review.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// Where a CODEOWNERS file may be, in the order they are looked for.
pub const LOCATIONS: [&str; 5] = [
    ".g1t/CODEOWNERS",
    ".github/CODEOWNERS",
    "CODEOWNERS",
    "docs/CODEOWNERS",
    ".gitlab/CODEOWNERS",
];

/// The largest file read; a larger one is ignored with an error.
pub const MAX_BYTES: usize = 3 * 1024 * 1024;

/// Whether `path` (from the repository root, no leading `/`) is one of
/// [`LOCATIONS`].
pub fn is_codeowners_path(path: &str) -> bool {
    LOCATIONS.contains(&path)
}

/// The location that is read, given the paths of [`LOCATIONS`] that exist:
/// the first of them in [`LOCATIONS`] order.
pub fn pick_location(existing: &[&str]) -> Option<&'static str> {
    LOCATIONS.into_iter().find(|location| existing.contains(location))
}

/// Someone a rule names as an owner.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Owner {
    /// A person, by username (lowercase).
    User { username: String },
    /// A team, by its workspace and slug (both lowercase).
    Team { workspace: String, slug: String },
    /// Whoever has confirmed this address (lowercase).
    Email { email: String },
}

/// Whether `text` is a username, workspace or team slug as written in a
/// CODEOWNERS file: letters, digits, `.`, `_` and `-`, starting with a
/// letter or digit.
fn is_name(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn is_email(text: &str) -> bool {
    let Some((local, domain)) = text.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains("..")
        && !domain.contains('/')
        && !text.chars().any(|c| c.is_whitespace() || c.is_control())
}

impl Owner {
    /// Reads one owner as written: `@ana` is a person, `@acme/backend` a
    /// team, `ana@example.com` an address. Anything else is `None`.
    /// Names and addresses are lowercased.
    pub fn parse(token: &str) -> Option<Owner> {
        if let Some(rest) = token.strip_prefix('@') {
            return match rest.split_once('/') {
                None => is_name(rest).then(|| Owner::User {
                    username: rest.to_ascii_lowercase(),
                }),
                Some((workspace, slug)) => (is_name(workspace) && is_name(slug)).then(|| Owner::Team {
                    workspace: workspace.to_ascii_lowercase(),
                    slug: slug.to_ascii_lowercase(),
                }),
            };
        }
        is_email(token).then(|| Owner::Email {
            email: token.to_lowercase(),
        })
    }

    /// The owner as written in a file: `@ana`, `@acme/backend`,
    /// `ana@example.com`.
    pub fn text(&self) -> String {
        match self {
            Owner::User { username } => format!("@{username}"),
            Owner::Team { workspace, slug } => format!("@{workspace}/{slug}"),
            Owner::Email { email } => email.clone(),
        }
    }
}

/// A named section of the file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Section {
    /// As the first header for it spells it, trimmed.
    pub name: String,
    /// The line of the first header for it.
    pub line: u32,
    /// Its owners are asked to review, but their approval is not required.
    pub optional: bool,
    /// Approvals it asks for when it is required (1 unless the header
    /// says otherwise).
    pub approvals: u32,
    /// Owners for its rules that name none.
    pub default_owners: Vec<Owner>,
}

/// One line that gives a pattern its owners.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    /// 1-based.
    pub line: u32,
    /// As written, with `\#` and `\ ` read as `#` and a space.
    pub pattern: String,
    /// The valid owners it names, in order; empty when it names none.
    pub owners: Vec<Owner>,
    /// Index into `CodeOwners::sections`; None for the default section.
    pub section: Option<usize>,
}

/// What is wrong with a line of the file, or with an owner it names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// The file is over [`MAX_BYTES`] and was ignored.
    TooLarge,
    /// A pattern starting with `!`; the line was skipped.
    Negation,
    /// A pattern with `[` or `]`; the line was skipped.
    CharacterRange,
    /// A pattern that names no path; the line was skipped.
    BadPattern,
    /// An owner that is not `@user`, `@workspace/team` or an address.
    BadOwner,
    /// A section header that could not be read.
    BadSection,
    /// No account has that username.
    UnknownUser,
    /// The workspace has no team of that slug.
    UnknownTeam,
    /// No account has confirmed that address.
    UnknownEmail,
    /// The person cannot write to the repository.
    NoWriteAccess,
    /// The team has no write access to the repository.
    TeamNoAccess,
}

/// One problem found in the file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineError {
    /// 1-based; 0 for the file as a whole.
    pub line: u32,
    pub kind: ErrorKind,
    /// The owner or pattern at fault, as written.
    pub token: Option<String>,
    /// A sentence saying what is wrong and how to fix it.
    pub message: String,
}

/// A parsed CODEOWNERS file.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeOwners {
    /// Named sections, in the order their first headers appear.
    pub sections: Vec<Section>,
    /// Every rule that was kept, in file order.
    pub rules: Vec<Rule>,
    /// Problems with the file, in line order.
    pub errors: Vec<LineError>,
}

/// Splits a line into whitespace-separated tokens, stopping at a token
/// that starts with `#` (a comment). `\ ` and `\#` stand for a space and
/// `#`; other backslashes are kept for the pattern matcher.
fn tokens(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = line.chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        match chars.peek() {
            None | Some('#') => break,
            _ => {}
        }
        let mut token = String::new();
        while let Some(&c) = chars.peek() {
            if c.is_whitespace() {
                break;
            }
            chars.next();
            if c == '\\' {
                match chars.peek() {
                    Some(&next) if next == ' ' || next == '#' => {
                        token.push(next);
                        chars.next();
                        continue;
                    }
                    _ => {}
                }
            }
            token.push(c);
        }
        out.push(token);
    }
    out
}

/// Reads owner tokens into the valid owners and the invalid tokens.
fn read_owners(words: &[String]) -> (Vec<Owner>, Vec<String>) {
    let mut owners = Vec::new();
    let mut bad = Vec::new();
    for word in words {
        match Owner::parse(word) {
            Some(owner) => owners.push(owner),
            None => bad.push(word.clone()),
        }
    }
    (owners, bad)
}

/// A section header as read from one line.
struct Header {
    name: String,
    optional: bool,
    approvals: Option<u32>,
    owners: Vec<Owner>,
    bad_owners: Vec<String>,
}

fn parse_header(text: &str) -> Result<Header, String> {
    let (optional, rest) = match text.strip_prefix('^') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let rest = rest.strip_prefix('[').unwrap_or(rest);
    let Some(close) = rest.find(']') else {
        return Err("The section header has no closing ]; write it as [Name].".into());
    };
    let name = rest[..close].trim();
    if name.is_empty() {
        return Err("The section header has no name; write it as [Name].".into());
    }
    if name.contains('[') {
        return Err("The section name cannot contain [; write it as [Name].".into());
    }
    let mut rest = &rest[close + 1..];
    let mut approvals = None;
    if let Some(after) = rest.strip_prefix('[') {
        let Some(close) = after.find(']') else {
            return Err("The approval count has no closing ]; write it as [Name][2].".into());
        };
        let count = after[..close].trim();
        let parsed = if !count.is_empty() && count.bytes().all(|b| b.is_ascii_digit()) {
            count.parse::<u32>().ok()
        } else {
            None
        };
        match parsed {
            Some(n) if (1..=10).contains(&n) => approvals = Some(n),
            _ => {
                return Err(format!(
                    "The approval count [{count}] must be a whole number from 1 to 10."
                ));
            }
        }
        rest = &after[close + 1..];
    }
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return Err("Put a space between the section header and its owners.".into());
    }
    let (owners, bad_owners) = read_owners(&tokens(rest));
    Ok(Header {
        name: name.to_string(),
        optional,
        approvals,
        owners,
        bad_owners,
    })
}

fn bad_owner(line: u32, token: &str) -> LineError {
    LineError {
        line,
        kind: ErrorKind::BadOwner,
        token: Some(token.to_string()),
        message: format!("{token} is not an owner; write @username, @workspace/team or an email address."),
    }
}

/// Reads a CODEOWNERS file. It never fails: what cannot be read is in
/// `errors`, and everything else is kept.
pub fn parse(text: &str) -> CodeOwners {
    let mut file = CodeOwners::default();
    if text.len() > MAX_BYTES {
        file.errors.push(LineError {
            line: 0,
            kind: ErrorKind::TooLarge,
            token: None,
            message: "The CODEOWNERS file is larger than 3 MB, so none of it applies; make it smaller.".into(),
        });
        return file;
    }
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut current: Option<usize> = None;
    for (index, raw) in text.split('\n').enumerate() {
        let line = u32::try_from(index + 1).unwrap_or(u32::MAX);
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let trimmed = raw.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') || trimmed.starts_with("^[") {
            match parse_header(trimmed) {
                Ok(header) => {
                    for token in &header.bad_owners {
                        file.errors.push(bad_owner(line, token));
                    }
                    current = Some(file.add_section(line, header));
                }
                Err(message) => file.errors.push(LineError {
                    line,
                    kind: ErrorKind::BadSection,
                    token: Some(trimmed.trim_end().to_string()),
                    message,
                }),
            }
            continue;
        }
        let words = tokens(trimmed);
        let Some((pattern, owner_words)) = words.split_first() else {
            continue;
        };
        let skip = if pattern.starts_with('!') {
            Some((
                ErrorKind::Negation,
                format!(
                    "{pattern} starts with !, and negation is not supported; this line is skipped. Give the path a later rule with no owners instead."
                ),
            ))
        } else if pattern.contains('[') || pattern.contains(']') {
            Some((
                ErrorKind::CharacterRange,
                format!(
                    "{pattern} uses [ or ], and character ranges are not supported; this line is skipped. Write one rule per name, or use * or ?."
                ),
            ))
        } else if compile(pattern).is_none() {
            Some((
                ErrorKind::BadPattern,
                format!(
                    "{pattern} names no path; this line is skipped. Write a file or directory pattern, such as * or /docs/."
                ),
            ))
        } else {
            None
        };
        if let Some((kind, message)) = skip {
            file.errors.push(LineError {
                line,
                kind,
                token: Some(pattern.clone()),
                message,
            });
            continue;
        }
        let (owners, bad) = read_owners(owner_words);
        for token in &bad {
            file.errors.push(bad_owner(line, token));
        }
        file.rules.push(Rule {
            line,
            pattern: pattern.clone(),
            owners,
            section: current,
        });
    }
    file
}

impl CodeOwners {
    /// Adds a header's section, or combines it with one of the same name;
    /// returns the section's index.
    fn add_section(&mut self, line: u32, header: Header) -> usize {
        let key = header.name.to_lowercase();
        if let Some(index) = self.sections.iter().position(|s| s.name.to_lowercase() == key) {
            let section = &mut self.sections[index];
            if header.optional {
                section.optional = true;
            }
            if let Some(approvals) = header.approvals {
                section.approvals = approvals;
            }
            if !header.owners.is_empty() {
                section.default_owners = header.owners;
            }
            return index;
        }
        self.sections.push(Section {
            name: header.name,
            line,
            optional: header.optional,
            approvals: header.approvals.unwrap_or(1),
            default_owners: header.owners,
        });
        self.sections.len() - 1
    }

    fn compiled(&self) -> Vec<Option<Compiled>> {
        self.rules.iter().map(|rule| compile(&rule.pattern)).collect()
    }

    /// For each section with a match, in order (default section first),
    /// the section index and the index of the last rule matching `path`.
    fn last_matches(&self, compiled: &[Option<Compiled>], path: &str) -> Vec<(Option<usize>, usize)> {
        let mut found: Vec<Option<usize>> = vec![None; self.sections.len() + 1];
        let parts = path_parts(path);
        for (index, rule) in self.rules.iter().enumerate().rev() {
            let slot = rule.section.map_or(0, |s| s + 1);
            if slot >= found.len() || found[slot].is_some() {
                continue;
            }
            if compiled[index].as_ref().is_some_and(|c| c.matches(&parts)) {
                found[slot] = Some(index);
            }
        }
        found
            .into_iter()
            .enumerate()
            .filter_map(|(slot, rule)| rule.map(|rule| (slot.checked_sub(1), rule)))
            .collect()
    }

    /// The owners a rule gives: its own, or its section's defaults when it
    /// names none.
    fn rule_owners(&self, rule: &Rule) -> Vec<Owner> {
        if !rule.owners.is_empty() {
            return rule.owners.clone();
        }
        rule.section
            .and_then(|s| self.sections.get(s))
            .map(|s| s.default_owners.clone())
            .unwrap_or_default()
    }

    fn section_name(&self, section: Option<usize>) -> Option<String> {
        section.and_then(|s| self.sections.get(s)).map(|s| s.name.clone())
    }

    /// For one path: in each section (default section first, then named
    /// sections in file order), the last rule that matches it, with its
    /// owners (the rule's, or the section's defaults when the rule has
    /// none and the section has some). A section where the last match has
    /// no owners contributes an [`Applied`] with empty owners.
    pub fn owners_of(&self, path: &str) -> Vec<Applied> {
        let compiled = self.compiled();
        self.last_matches(&compiled, path)
            .into_iter()
            .map(|(section, index)| {
                let rule = &self.rules[index];
                Applied {
                    section: self.section_name(section),
                    line: rule.line,
                    pattern: rule.pattern.clone(),
                    owners: self.rule_owners(rule),
                }
            })
            .collect()
    }

    /// For the changed paths of a pull request: one [`Requirement`] per
    /// section and rule whose applied owners are not empty, with the paths
    /// it covers, ordered by section (default first) and then line.
    pub fn requirements(&self, paths: &[String]) -> Vec<Requirement> {
        let compiled = self.compiled();
        // (section slot, rule index, requirement)
        let mut found: Vec<(usize, usize, Requirement)> = Vec::new();
        for path in paths {
            for (section, index) in self.last_matches(&compiled, path) {
                let rule = &self.rules[index];
                let owners = self.rule_owners(rule);
                if owners.is_empty() {
                    continue;
                }
                if let Some((_, _, requirement)) = found.iter_mut().find(|(_, i, _)| *i == index) {
                    if !requirement.files.contains(path) {
                        requirement.files.push(path.clone());
                    }
                    continue;
                }
                let settings = section.and_then(|s| self.sections.get(s));
                let optional = settings.is_some_and(|s| s.optional);
                let approvals = if optional {
                    0
                } else {
                    settings.map_or(1, |s| s.approvals)
                };
                found.push((
                    section.map_or(0, |s| s + 1),
                    index,
                    Requirement {
                        section: self.section_name(section),
                        line: rule.line,
                        pattern: rule.pattern.clone(),
                        owners,
                        approvals,
                        optional,
                        files: vec![path.clone()],
                    },
                ));
            }
        }
        found.sort_by_key(|(slot, _, requirement)| (*slot, requirement.line));
        found.into_iter().map(|(_, _, requirement)| requirement).collect()
    }

    /// Every distinct owner named anywhere (rules and section defaults),
    /// sorted.
    pub fn owners(&self) -> Vec<Owner> {
        let mut all = BTreeSet::new();
        for rule in &self.rules {
            all.extend(rule.owners.iter().cloned());
        }
        for section in &self.sections {
            all.extend(section.default_owners.iter().cloned());
        }
        all.into_iter().collect()
    }

    /// Lines that name `owner`, ascending. Default owners of a section
    /// count at the line of its first header.
    pub fn lines_naming(&self, owner: &Owner) -> Vec<u32> {
        let mut lines = BTreeSet::new();
        for rule in &self.rules {
            if rule.owners.contains(owner) {
                lines.insert(rule.line);
            }
        }
        for section in &self.sections {
            if section.default_owners.contains(owner) {
                lines.insert(section.line);
            }
        }
        lines.into_iter().collect()
    }
}

/// The rule that applies to one path in one section.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Applied {
    /// The section's name; None for the default section.
    pub section: Option<String>,
    pub line: u32,
    pub pattern: String,
    /// Empty when the rule says the path has no owners.
    pub owners: Vec<Owner>,
}

/// One review the changed files need: one per section and matching rule
/// with owners.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requirement {
    /// The section's name; None for the default section.
    pub section: Option<String>,
    pub line: u32,
    pub pattern: String,
    pub owners: Vec<Owner>,
    /// Approvals needed: the section's count, 0 when the section is
    /// optional.
    pub approvals: u32,
    pub optional: bool,
    /// The changed paths it covers, in the order given.
    pub files: Vec<String>,
}

// ---------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------

/// One character position in a pattern part.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tok {
    Lit(char),
    /// Any run of characters, none of them `/`.
    Star,
    /// Any one character.
    One,
}

/// One `/`-separated part of a pattern.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Seg {
    /// `**` as a whole part: zero or more directories (one or more at the
    /// end of a pattern).
    Globstar,
    Glob(Vec<Tok>),
}

/// A pattern ready to match.
#[derive(Clone, Debug)]
struct Compiled {
    segs: Vec<Seg>,
    /// Ended with `/`: matches only directories, so only parents of a path.
    dir_only: bool,
    /// Its last part has a wildcard: matches the path itself only.
    files_only: bool,
}

fn glob_tokens(part: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut chars = part.chars();
    while let Some(c) = chars.next() {
        let tok = match c {
            '\\' => Tok::Lit(chars.next().unwrap_or('\\')),
            '*' => Tok::Star,
            '?' => Tok::One,
            c => Tok::Lit(c),
        };
        if tok == Tok::Star && out.last() == Some(&Tok::Star) {
            continue;
        }
        out.push(tok);
    }
    out
}

fn compile(pattern: &str) -> Option<Compiled> {
    let mut rest = pattern;
    let mut anchored = false;
    if let Some(after) = rest.strip_prefix('/') {
        anchored = true;
        rest = after;
    }
    let dir_only = rest.ends_with('/');
    let rest = rest.trim_end_matches('/');
    if rest.contains('/') {
        anchored = true;
    }
    let parts: Vec<&str> = rest.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    let mut segs = Vec::new();
    if !anchored {
        segs.push(Seg::Globstar);
    }
    for part in parts {
        if part == "**" {
            if segs.last() != Some(&Seg::Globstar) {
                segs.push(Seg::Globstar);
            }
        } else {
            segs.push(Seg::Glob(glob_tokens(part)));
        }
    }
    let files_only = !dir_only
        && matches!(segs.last(), Some(Seg::Glob(toks)) if toks.iter().any(|t| matches!(t, Tok::Star | Tok::One)));
    Some(Compiled {
        segs,
        dir_only,
        files_only,
    })
}

fn path_parts(path: &str) -> Vec<&str> {
    path.split('/').filter(|part| !part.is_empty()).collect()
}

impl Compiled {
    fn matches(&self, parts: &[&str]) -> bool {
        if parts.is_empty() {
            return false;
        }
        if !self.dir_only && match_segs(&self.segs, parts) {
            return true;
        }
        if self.files_only {
            return false;
        }
        (1..parts.len()).any(|k| match_segs(&self.segs, &parts[..k]))
    }
}

fn match_segs(segs: &[Seg], parts: &[&str]) -> bool {
    match segs.split_first() {
        None => parts.is_empty(),
        Some((Seg::Globstar, [])) => !parts.is_empty(),
        Some((Seg::Globstar, rest)) => (0..=parts.len()).any(|skip| match_segs(rest, &parts[skip..])),
        Some((Seg::Glob(toks), rest)) => parts
            .split_first()
            .is_some_and(|(first, tail)| match_glob(toks, first) && match_segs(rest, tail)),
    }
}

fn match_glob(toks: &[Tok], text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < chars.len() {
        match toks.get(p) {
            Some(Tok::Star) => {
                star = Some((p, t));
                p += 1;
                continue;
            }
            Some(Tok::One) => {
                p += 1;
                t += 1;
                continue;
            }
            Some(Tok::Lit(c)) if *c == chars[t] => {
                p += 1;
                t += 1;
                continue;
            }
            _ => {}
        }
        match star {
            Some((sp, st)) => {
                p = sp + 1;
                t = st + 1;
                star = Some((sp, st + 1));
            }
            None => return false,
        }
    }
    toks[p..].iter().all(|tok| *tok == Tok::Star)
}

/// Whether a pattern, as a [`Rule`] holds it, matches `path` (from the
/// repository root, no leading `/`), by the rules in the module docs. A
/// pattern that names no path matches nothing.
pub fn pattern_matches(pattern: &str, path: &str) -> bool {
    compile(pattern).is_some_and(|compiled| compiled.matches(&path_parts(path)))
}

// ---------------------------------------------------------------------
// Resolving owners
// ---------------------------------------------------------------------

/// How an owner named in the file resolved, from the caller's lookups.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OwnerCheck {
    /// Someone who can review.
    Ok,
    /// No account has the username.
    UnknownUser,
    /// The workspace has no team of the slug.
    UnknownTeam,
    /// No account has confirmed the address.
    UnknownEmail,
    /// The person cannot write to the repository.
    NoWriteAccess,
    /// The team has no write access to the repository.
    TeamNoAccess,
}

fn check_message(owner: &Owner, check: OwnerCheck) -> Option<(ErrorKind, String)> {
    let text = owner.text();
    Some(match check {
        OwnerCheck::Ok => return None,
        OwnerCheck::UnknownUser => (ErrorKind::UnknownUser, format!("{text} is not a g1t account.")),
        OwnerCheck::UnknownTeam => (
            ErrorKind::UnknownTeam,
            match owner {
                Owner::Team { workspace, .. } => format!("{text} is not a team of {workspace}."),
                _ => format!("{text} is not a team."),
            },
        ),
        OwnerCheck::UnknownEmail => (
            ErrorKind::UnknownEmail,
            format!("No g1t account has confirmed {}.", text.trim_start_matches('@')),
        ),
        OwnerCheck::NoWriteAccess => (
            ErrorKind::NoWriteAccess,
            format!("{text} cannot write to this repository; code owners need the Write role or higher."),
        ),
        OwnerCheck::TeamNoAccess => (
            ErrorKind::TeamNoAccess,
            format!("{text} has no access to this repository; give the team the Write role or higher."),
        ),
    })
}

/// The errors of resolving each owner: one [`LineError`] per line that
/// names an owner whose check is not [`OwnerCheck::Ok`], sorted by line
/// then token. `check` is asked once per distinct owner. Syntax errors
/// are not repeated here.
pub fn check_owners(file: &CodeOwners, check: &dyn Fn(&Owner) -> OwnerCheck) -> Vec<LineError> {
    let mut errors = Vec::new();
    for owner in file.owners() {
        let Some((kind, message)) = check_message(&owner, check(&owner)) else {
            continue;
        };
        for line in file.lines_naming(&owner) {
            errors.push(LineError {
                line,
                kind,
                token: Some(owner.text()),
                message: message.clone(),
            });
        }
    }
    errors.sort_by(|a, b| (a.line, &a.token).cmp(&(b.line, &b.token)));
    errors
}

// ---------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------

/// One reviewer's latest verdict.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    pub username: String,
    /// True for an approval, false for a request for changes.
    pub approved: bool,
}

/// Where one requirement stands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerReview {
    /// The section's name; None for the default section.
    pub section: Option<String>,
    pub line: u32,
    pub pattern: String,
    /// Owners as written ("@acme/backend").
    pub owners: Vec<String>,
    pub files: Vec<String>,
    pub optional: bool,
    /// Approvals needed.
    pub required: u32,
    /// Usernames (lowercase) of owners who approved, in verdict order.
    pub approved_by: Vec<String>,
    /// Usernames (lowercase) of owners who asked for changes, in verdict
    /// order.
    pub changes_requested_by: Vec<String>,
    /// Optional, or enough approvals and no request for changes.
    pub satisfied: bool,
}

/// Where each requirement stands. `members(owner)` returns the usernames
/// who may answer for that owner (a person; a team's members, child teams
/// included; the account an address belongs to). A verdict counts for a
/// requirement when its username is among the members of any of its
/// owners and is not `author`; names are compared lowercase.
pub fn evaluate(
    requirements: &[Requirement],
    members: &dyn Fn(&Owner) -> Vec<String>,
    verdicts: &[Verdict],
    author: &str,
) -> Vec<OwnerReview> {
    let author = author.to_lowercase();
    requirements
        .iter()
        .map(|requirement| {
            let allowed: BTreeSet<String> = requirement
                .owners
                .iter()
                .flat_map(members)
                .map(|name| name.to_lowercase())
                .collect();
            let mut approved_by: Vec<String> = Vec::new();
            let mut changes_requested_by: Vec<String> = Vec::new();
            for verdict in verdicts {
                let name = verdict.username.to_lowercase();
                if name == author || !allowed.contains(&name) {
                    continue;
                }
                let list = if verdict.approved {
                    &mut approved_by
                } else {
                    &mut changes_requested_by
                };
                if !list.contains(&name) {
                    list.push(name);
                }
            }
            let required = requirement.approvals;
            let satisfied =
                requirement.optional || (changes_requested_by.is_empty() && approved_by.len() >= required as usize);
            OwnerReview {
                section: requirement.section.clone(),
                line: requirement.line,
                pattern: requirement.pattern.clone(),
                owners: requirement.owners.iter().map(Owner::text).collect(),
                files: requirement.files.clone(),
                optional: requirement.optional,
                required,
                approved_by,
                changes_requested_by,
                satisfied,
            }
        })
        .collect()
}

/// Joins names as "a", "a or b", "a, b or c".
fn join(names: &[String], word: &str) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} {word} {last}", init.join(", ")),
    }
}

/// What still stands in the way, for a merge refusal: None when every
/// review is satisfied. Owners who asked for changes come first, then
/// those who have not approved; at most three are listed, then "and N
/// more".
pub fn missing(reviews: &[OwnerReview]) -> Option<String> {
    const SHOWN: usize = 3;
    let open: Vec<&OwnerReview> = reviews.iter().filter(|r| !r.satisfied).collect();
    if open.is_empty() {
        return None;
    }
    let (changes, approvals): (Vec<&OwnerReview>, Vec<&OwnerReview>) =
        open.iter().partition(|r| !r.changes_requested_by.is_empty());
    let more = open.len().saturating_sub(SHOWN);
    let mut sentences = Vec::new();
    let mut shown = 0;
    for review in &changes {
        if shown == SHOWN {
            break;
        }
        shown += 1;
        let names: Vec<String> = review.changes_requested_by.iter().map(|n| format!("@{n}")).collect();
        sentences.push(format!(
            "{} asked for changes on {} (code owner).",
            join(&names, "and"),
            review.pattern
        ));
    }
    let mut items = Vec::new();
    for review in &approvals {
        if shown == SHOWN {
            break;
        }
        shown += 1;
        let mut item = format!("{} for {}", join(&review.owners, "or"), review.pattern);
        if review.required > 1 {
            item.push_str(&format!(
                " ({} of {} approvals)",
                review.approved_by.len(),
                review.required
            ));
        }
        items.push(item);
    }
    if !items.is_empty() {
        if more > 0 {
            items.push(format!("and {more} more"));
        }
        sentences.push(format!("Code owners have not approved: {}.", items.join(", ")));
    } else if more > 0 {
        sentences.push(format!("And {more} more."));
    }
    Some(sentences.join(" "))
}

/// Who owns what a pull request changes, as its page and the API show it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullCodeOwners {
    /// Where the file was found on the branch the pull request merges
    /// into, such as `.github/CODEOWNERS`.
    pub path: String,
    /// Whether that branch's protection requires code owners' approval.
    pub required: bool,
    /// One per section and rule that owns a changed file.
    pub reviews: Vec<OwnerReview>,
    /// What still stands in the way, as the merge box says it; null when
    /// every review is satisfied.
    pub missing: Option<String>,
    /// How many problems the file has (see the errors view).
    pub errors: u32,
}

/// A repository's CODEOWNERS file at one branch, checked like a linter:
/// what `GET /repos/{owner}/{name}/codeowners/errors` answers.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeOwnersReport {
    /// Where it was found; null when there is none.
    pub path: Option<String>,
    /// The branch or commit read.
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub size: u64,
    /// How many rules and sections it has.
    pub rules: u32,
    pub sections: Vec<String>,
    /// Every problem, by line: syntax, and owners that do not resolve or
    /// cannot write to the repository.
    pub errors: Vec<LineError>,
}

/// `codeowners_errors` on the work service. `ref` defaults to the
/// repository's default branch. Needs Read on the repository. Returns
/// `Outcome<CodeOwnersReport>`.
#[derive(Debug, Serialize, Deserialize)]
pub struct CodeOwnersErrorsArgs {
    pub viewer: crate::Viewer,
    pub repo: crate::repos::RepoPath,
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(name: &str) -> Owner {
        Owner::User { username: name.into() }
    }

    fn team(workspace: &str, slug: &str) -> Owner {
        Owner::Team {
            workspace: workspace.into(),
            slug: slug.into(),
        }
    }

    fn email(address: &str) -> Owner {
        Owner::Email { email: address.into() }
    }

    /// owners_of as "section:line:owners" strings, "-" for the default
    /// section and an empty owner list for "no owners".
    fn who(file: &CodeOwners, path: &str) -> Vec<String> {
        file.owners_of(path)
            .into_iter()
            .map(|applied| {
                let owners: Vec<String> = applied.owners.iter().map(Owner::text).collect();
                format!(
                    "{}:{}:{}",
                    applied.section.as_deref().unwrap_or("-"),
                    applied.line,
                    owners.join(" ")
                )
            })
            .collect()
    }

    /// requirements as "section:line:pattern:approvals:files".
    fn needs(file: &CodeOwners, paths: &[&str]) -> Vec<String> {
        let paths: Vec<String> = paths.iter().map(|p| p.to_string()).collect();
        file.requirements(&paths)
            .into_iter()
            .map(|r| {
                format!(
                    "{}:{}:{}:{}:{}",
                    r.section.as_deref().unwrap_or("-"),
                    r.line,
                    r.pattern,
                    r.approvals,
                    r.files.join(",")
                )
            })
            .collect()
    }

    fn kinds(file: &CodeOwners) -> Vec<(u32, ErrorKind, Option<String>)> {
        file.errors.iter().map(|e| (e.line, e.kind, e.token.clone())).collect()
    }

    // -----------------------------------------------------------------
    // Fixtures: the single-section convention
    // -----------------------------------------------------------------

    /// Written like a large real-world file of the single-section
    /// convention, comments and all.
    const MONOREPO: &str = "\
# This is a comment.
# Each line is a file pattern followed by one or more owners.

# These owners are the default owners for everything in
# the repository. Unless a later match takes precedence,
# they are asked to review every pull request.
*       @global-owner1 @global-owner2

# Order is important; the last matching pattern takes the most
# precedence.
*.js    @js-owner #This is an inline comment.

# Email addresses work too.
*.go docs@example.com

# Teams can be owners as well.
*.html @acme/octocats

# A trailing slash: everything in build/logs at the root.
/build/logs/ @doctocat

# Files directly in docs at the root, not deeper.
docs/* docs@example.com

# Any directory named apps, at any depth.
apps/ @octocat

# The docs directory at the root, and everything under it.
/docs/ @doctocat

# Several owners.
/scripts/ @doctocat @octocat

# A directory named logs anywhere.
**/logs @octocat

# The apps directory at the root, except apps/github, which has no owners.
/apps/ @octocat
/apps/github
";

    #[test]
    fn monorepo_fixture_parses_cleanly() {
        let file = parse(MONOREPO);
        assert!(file.errors.is_empty(), "{:?}", file.errors);
        assert!(file.sections.is_empty());
        assert_eq!(file.rules.len(), 12);
        assert_eq!(file.rules[0].line, 7);
        assert_eq!(file.rules[0].pattern, "*");
        assert_eq!(file.rules[1].owners, vec![user("js-owner")]);
        assert_eq!(file.rules[11].pattern, "/apps/github");
        assert!(file.rules[11].owners.is_empty());
        assert!(file.rules.iter().all(|r| r.section.is_none()));
    }

    #[test]
    fn monorepo_fixture_owners() {
        let file = parse(MONOREPO);
        let cases: &[(&str, &str)] = &[
            ("README.md", "-:7:@global-owner1 @global-owner2"),
            ("x/docs/y.md", "-:7:@global-owner1 @global-owner2"),
            ("src/app.js", "-:11:@js-owner"),
            ("main.go", "-:14:docs@example.com"),
            ("web/index.html", "-:17:@acme/octocats"),
            // /build/logs/ matches, but **/logs comes later.
            ("build/logs/a.txt", "-:35:@octocat"),
            ("docs/getting-started.md", "-:29:@doctocat"),
            ("docs/build-app/troubleshooting.md", "-:29:@doctocat"),
            ("x/apps/y.ts", "-:26:@octocat"),
            ("a/b/apps/c/d.ts", "-:26:@octocat"),
            ("apps/web/index.ts", "-:38:@octocat"),
            ("apps/web/app.js", "-:38:@octocat"),
            ("apps/github/main.go", "-:39:"),
            ("apps/github", "-:39:"),
            ("scripts/deploy.sh", "-:32:@doctocat @octocat"),
            ("deeply/nested/logs/z.log", "-:35:@octocat"),
            ("logs", "-:35:@octocat"),
        ];
        for (path, expected) in cases {
            assert_eq!(who(&file, path), vec![expected.to_string()], "{path}");
        }
    }

    #[test]
    fn monorepo_fixture_requirements() {
        let file = parse(MONOREPO);
        assert_eq!(
            needs(
                &file,
                &[
                    "README.md",
                    "src/app.js",
                    "apps/github/x.go",
                    "lib/util.js",
                    "docs/a.md",
                    "scripts/run.sh",
                    "build/logs/today.log",
                ]
            ),
            vec![
                "-:7:*:1:README.md",
                "-:11:*.js:1:src/app.js,lib/util.js",
                "-:29:/docs/:1:docs/a.md",
                "-:32:/scripts/:1:scripts/run.sh",
                "-:35:**/logs:1:build/logs/today.log",
            ]
        );
    }

    /// Written like a real-world file for a service workspace: crates,
    /// lock files, CI and a release owner, with emails and teams.
    const WORKSPACE: &str = "\
# Code owners for the platform workspace.
# Keep this file sorted from broad to narrow.

*                          @acme/platform

# Build and CI
/.g1t/                     @acme/infra
/.g1t/workflows/release.yml @release-captain release@acme.dev
Cargo.lock                 @acme/infra
/Cargo.toml                @acme/infra @acme/platform

# Crates
/crates/contracts/         @acme/api-guild
/crates/*/migrations/      @dba
/crates/**/tests/          @acme/qa
/crates/web/src/**/*.css   @designer

# Generated files have no owners.
/crates/contracts/src/generated/

# Documentation
*.md                       @acme/docs
/crates/web/README.md      @Web-Lead
";

    #[test]
    fn workspace_fixture_owners() {
        let file = parse(WORKSPACE);
        assert!(file.errors.is_empty(), "{:?}", file.errors);
        let cases: &[(&str, &str)] = &[
            ("src/main.rs", "-:4:@acme/platform"),
            (".g1t/workflows/ci.yml", "-:7:@acme/infra"),
            (".g1t/workflows/release.yml", "-:8:@release-captain release@acme.dev"),
            ("Cargo.lock", "-:9:@acme/infra"),
            ("crates/web/Cargo.lock", "-:9:@acme/infra"),
            ("Cargo.toml", "-:10:@acme/infra @acme/platform"),
            ("crates/web/Cargo.toml", "-:4:@acme/platform"),
            ("crates/contracts/src/lib.rs", "-:13:@acme/api-guild"),
            ("crates/store/migrations/0001.sql", "-:14:@dba"),
            ("crates/store/src/migrations/0001.sql", "-:4:@acme/platform"),
            ("crates/store/tests/a.rs", "-:15:@acme/qa"),
            ("crates/store/src/deep/tests/a.rs", "-:15:@acme/qa"),
            ("crates/web/src/a/b/site.css", "-:16:@designer"),
            ("crates/web/src/site.css", "-:16:@designer"),
            ("crates/web/site.css", "-:4:@acme/platform"),
            ("crates/contracts/src/generated/types.rs", "-:19:"),
            ("crates/contracts/src/generated/README.md", "-:22:@acme/docs"),
            ("README.md", "-:22:@acme/docs"),
            ("crates/web/README.md", "-:23:@web-lead"),
        ];
        for (path, expected) in cases {
            assert_eq!(who(&file, path), vec![expected.to_string()], "{path}");
        }
        assert_eq!(
            needs(
                &file,
                &[
                    "crates/contracts/src/generated/types.rs",
                    "crates/contracts/src/a.rs",
                    "README.md",
                    "Cargo.lock"
                ]
            ),
            vec![
                "-:9:Cargo.lock:1:Cargo.lock",
                "-:13:/crates/contracts/:1:crates/contracts/src/a.rs",
                "-:22:*.md:1:README.md",
            ]
        );
    }

    /// Written like a real-world front-end file, saved on another system:
    /// a byte order mark, CRLF line ends, escapes and inline comments.
    const FRONTEND: &str = "\u{feff}# Front end\r\n\
* @ana\r\n\
\r\n\
   # indented comment\r\n\
**/*.test.ts @acme/qa # tests\r\n\
/package.json @ana @bo\r\n\
docs/My\\ Notes.md @writer\r\n\
\\#hashtag.txt @bo\r\n\
/src/components/ @acme/ui\r\n\
/src/components/legacy/**\r\n\
/*.config.js @tooling\r\n\
?.txt @single\r\n";

    #[test]
    fn frontend_fixture_owners() {
        let file = parse(FRONTEND);
        assert!(file.errors.is_empty(), "{:?}", file.errors);
        assert_eq!(file.rules[0].line, 2);
        assert_eq!(file.rules[3].pattern, "docs/My Notes.md");
        assert_eq!(file.rules[4].pattern, "#hashtag.txt");
        let cases: &[(&str, &str)] = &[
            ("index.ts", "-:2:@ana"),
            ("src/a.test.ts", "-:5:@acme/qa"),
            ("a.test.ts", "-:5:@acme/qa"),
            ("package.json", "-:6:@ana @bo"),
            ("web/package.json", "-:2:@ana"),
            ("docs/My Notes.md", "-:7:@writer"),
            ("#hashtag.txt", "-:8:@bo"),
            ("x/#hashtag.txt", "-:8:@bo"),
            ("src/components/Button.tsx", "-:9:@acme/ui"),
            ("src/components/Button.test.ts", "-:9:@acme/ui"),
            ("src/components/legacy/Old.tsx", "-:10:"),
            ("src/components/legacy", "-:9:@acme/ui"),
            ("vite.config.js", "-:11:@tooling"),
            ("web/vite.config.js", "-:2:@ana"),
            ("a.txt", "-:12:@single"),
            ("ab.txt", "-:2:@ana"),
        ];
        for (path, expected) in cases {
            assert_eq!(who(&file, path), vec![expected.to_string()], "{path}");
        }
        assert_eq!(
            needs(
                &file,
                &[
                    "src/components/legacy/Old.tsx",
                    "package.json",
                    "index.ts",
                    "src/x.test.ts"
                ]
            ),
            vec![
                "-:2:*:1:index.ts",
                "-:5:**/*.test.ts:1:src/x.test.ts",
                "-:6:/package.json:1:package.json",
            ]
        );
    }

    // -----------------------------------------------------------------
    // Fixtures: the sections convention
    // -----------------------------------------------------------------

    /// Written like a real-world file of the sections convention.
    const SECTIONED: &str = "\
# Default owners, before any section
* @admins

[Documentation][2] @acme/writers @lead
docs/
*.md
README.md @ana

^[Frontend]
app/assets/ @fe-lead
*.css @designer

[Backend] @acme/backend
app/models/
lib/
lib/vendor/ @vendor-keeper

[documentation]
CONTRIBUTING.md @bo
";

    #[test]
    fn sectioned_fixture_sections() {
        let file = parse(SECTIONED);
        assert!(file.errors.is_empty(), "{:?}", file.errors);
        assert_eq!(
            file.sections,
            vec![
                Section {
                    name: "Documentation".into(),
                    line: 4,
                    optional: false,
                    approvals: 2,
                    default_owners: vec![team("acme", "writers"), user("lead")],
                },
                Section {
                    name: "Frontend".into(),
                    line: 9,
                    optional: true,
                    approvals: 1,
                    default_owners: vec![],
                },
                Section {
                    name: "Backend".into(),
                    line: 13,
                    optional: false,
                    approvals: 1,
                    default_owners: vec![team("acme", "backend")],
                },
            ]
        );
        let contributing = file.rules.iter().find(|r| r.pattern == "CONTRIBUTING.md").unwrap();
        assert_eq!(contributing.section, Some(0));
        assert_eq!(file.rules[0].section, None);
    }

    #[test]
    fn sectioned_fixture_owners() {
        let file = parse(SECTIONED);
        let cases: &[(&str, &[&str])] = &[
            ("main.c", &["-:2:@admins"]),
            ("docs/guide.md", &["-:2:@admins", "Documentation:6:@acme/writers @lead"]),
            (
                "docs/img/a.png",
                &["-:2:@admins", "Documentation:5:@acme/writers @lead"],
            ),
            ("README.md", &["-:2:@admins", "Documentation:7:@ana"]),
            ("CONTRIBUTING.md", &["-:2:@admins", "Documentation:19:@bo"]),
            ("app/assets/x.css", &["-:2:@admins", "Frontend:11:@designer"]),
            ("app/assets/x.js", &["-:2:@admins", "Frontend:10:@fe-lead"]),
            ("app/models/user.rb", &["-:2:@admins", "Backend:14:@acme/backend"]),
            ("lib/b.rb", &["-:2:@admins", "Backend:15:@acme/backend"]),
            ("lib/vendor/a.rb", &["-:2:@admins", "Backend:16:@vendor-keeper"]),
            (
                "lib/notes.md",
                &[
                    "-:2:@admins",
                    "Documentation:6:@acme/writers @lead",
                    "Backend:15:@acme/backend",
                ],
            ),
        ];
        for (path, expected) in cases {
            assert_eq!(who(&file, path), *expected, "{path}");
        }
    }

    #[test]
    fn sectioned_fixture_requirements() {
        let file = parse(SECTIONED);
        let paths = ["docs/guide.md", "README.md", "app/assets/x.css", "lib/b.rb", "lib/c.rb"];
        assert_eq!(
            needs(&file, &paths),
            vec![
                "-:2:*:1:docs/guide.md,README.md,app/assets/x.css,lib/b.rb,lib/c.rb",
                "Documentation:6:*.md:2:docs/guide.md",
                "Documentation:7:README.md:2:README.md",
                "Frontend:11:*.css:0:app/assets/x.css",
                "Backend:15:lib/:1:lib/b.rb,lib/c.rb",
            ]
        );
        let paths: Vec<String> = paths.iter().map(|p| p.to_string()).collect();
        let reqs = file.requirements(&paths);
        assert!(reqs[3].optional);
        assert_eq!(reqs[1].owners, vec![team("acme", "writers"), user("lead")]);
    }

    /// The sections convention with optional counts, a header that later
    /// changes its section's settings, rules without owners in a section
    /// without defaults, and broken headers in between.
    const SECTIONED_SETTINGS: &str = "\
*.rb @ruby

^[Security][3] @acme/security
/config/secrets/
*.key

[Database] @dba
db/
db/schema.rb
[Database
db/seeds.rb @seed-keeper

[Release]
VERSION @release

[database][2] @acme/data
db/migrate/

[Release][0]
CHANGELOG.md @scribe
";

    #[test]
    fn sectioned_settings_fixture() {
        let file = parse(SECTIONED_SETTINGS);
        assert_eq!(
            kinds(&file),
            vec![
                (10, ErrorKind::BadSection, Some("[Database".into())),
                (19, ErrorKind::BadSection, Some("[Release][0]".into())),
            ]
        );
        let security = &file.sections[0];
        assert_eq!(security.name, "Security");
        assert!(security.optional);
        let database = &file.sections[1];
        assert_eq!(database.name, "Database");
        assert_eq!(database.line, 7);
        assert_eq!(database.approvals, 2);
        assert_eq!(database.default_owners, vec![team("acme", "data")]);
        // After the unclosed header, rules stay in Database; after the
        // [0] header, they stay in the second Database header's section.
        let seeds = file.rules.iter().find(|r| r.pattern == "db/seeds.rb").unwrap();
        assert_eq!(seeds.section, Some(1));
        let changelog = file.rules.iter().find(|r| r.pattern == "CHANGELOG.md").unwrap();
        assert_eq!(changelog.section, Some(1));

        let cases: &[(&str, &[&str])] = &[
            ("app/user.rb", &["-:1:@ruby"]),
            ("config/secrets/prod.key", &["Security:5:@acme/security"]),
            ("config/secrets/prod.yml", &["Security:4:@acme/security"]),
            ("db/schema.rb", &["-:1:@ruby", "Database:9:@acme/data"]),
            ("db/seeds.rb", &["-:1:@ruby", "Database:11:@seed-keeper"]),
            ("db/migrate/001.rb", &["-:1:@ruby", "Database:17:@acme/data"]),
            ("VERSION", &["Release:14:@release"]),
            ("CHANGELOG.md", &["Database:20:@scribe"]),
        ];
        for (path, expected) in cases {
            assert_eq!(who(&file, path), *expected, "{path}");
        }
        assert_eq!(
            needs(&file, &["config/secrets/a.key", "db/migrate/002.rb", "VERSION"]),
            vec![
                "-:1:*.rb:1:db/migrate/002.rb",
                "Security:5:*.key:0:config/secrets/a.key",
                "Database:17:db/migrate/:2:db/migrate/002.rb",
                "Release:14:VERSION:1:VERSION",
            ]
        );
    }

    #[test]
    fn rule_without_owners_in_section_without_defaults_has_none() {
        let file = parse("[Docs]\ndocs/ @ana\ndocs/drafts/\n");
        assert_eq!(who(&file, "docs/a.md"), vec!["Docs:2:@ana"]);
        assert_eq!(who(&file, "docs/drafts/a.md"), vec!["Docs:3:"]);
        assert!(needs(&file, &["docs/drafts/a.md"]).is_empty());
    }

    #[test]
    fn optional_header_with_count_needs_no_approvals() {
        let file = parse("^[Style][2] @lint\n*.css\n");
        assert!(file.sections[0].optional);
        assert_eq!(file.sections[0].approvals, 2);
        let reqs = file.requirements(&["a.css".to_string()]);
        assert_eq!(reqs[0].approvals, 0);
        assert!(reqs[0].optional);
    }

    #[test]
    fn later_header_settings_replace_earlier() {
        let file = parse("[A][3] @one\nx @x\n^[a]\n[A] @two\n");
        let section = &file.sections[0];
        assert_eq!(section.name, "A");
        assert_eq!(section.approvals, 3);
        assert!(section.optional);
        assert_eq!(section.default_owners, vec![user("two")]);
        assert_eq!(file.sections.len(), 1);
    }

    // -----------------------------------------------------------------
    // Pattern matching
    // -----------------------------------------------------------------

    fn table(cases: &[(&str, &str, bool)]) {
        for (pattern, path, expected) in cases {
            assert_eq!(pattern_matches(pattern, path), *expected, "{pattern} vs {path}");
        }
    }

    #[test]
    fn single_star_stays_within_a_part() {
        table(&[
            ("*", "a", true),
            ("*", "a/b/c", true),
            ("*.js", "a.js", true),
            ("*.js", "a/b/c.js", true),
            ("*.js", "a.jsx", false),
            ("*.js", "a.js/b.txt", false),
            ("src/*.js", "src/a.js", true),
            ("src/*.js", "src/x/a.js", false),
            ("a*b", "ab", true),
            ("a*b", "axxb", true),
            ("a*b", "a/b", false),
            ("a**b", "axxb", true),
            ("a**b", "a/x/b", false),
        ]);
    }

    #[test]
    fn question_mark_is_one_character() {
        table(&[
            ("?.txt", "a.txt", true),
            ("?.txt", "ab.txt", false),
            ("?.txt", ".txt", false),
            ("a?c", "abc", true),
            ("a?c", "a/c", false),
            ("x/?", "x/y", true),
            ("x/?", "x/yz", false),
        ]);
    }

    #[test]
    fn double_star() {
        table(&[
            ("a/**/b", "a/b", true),
            ("a/**/b", "a/x/b", true),
            ("a/**/b", "a/x/y/b", true),
            ("a/**/b", "a/x/y/c", false),
            ("a/**/b", "x/a/b", false),
            ("a/**/b", "a/x/b/inner.txt", true),
            ("**/foo", "foo", true),
            ("**/foo", "x/foo", true),
            ("**/foo", "x/y/foo", true),
            ("**/foo", "x/foo/bar", true),
            ("**/foo", "x/foobar", false),
            ("foo/**", "foo/a", true),
            ("foo/**", "foo/a/b", true),
            ("foo/**", "foo", false),
            ("foo/**", "x/foo/a", false),
            ("/foo/**", "foo/a", true),
            ("**", "anything/at/all", true),
            ("**/*.md", "a.md", true),
            ("**/*.md", "x/y/a.md", true),
            ("src/**/*.rs", "src/main.rs", true),
            ("src/**/*.rs", "src/a/b/main.rs", true),
            ("src/**/*.rs", "lib/main.rs", false),
            ("a/**/**/b", "a/b", true),
            ("a/**/**/b", "a/x/y/b", true),
        ]);
    }

    #[test]
    fn anchoring() {
        table(&[
            ("/*.md", "README.md", true),
            ("/*.md", "docs/README.md", false),
            ("docs/*", "docs/a.md", true),
            ("docs/*", "x/docs/a.md", false),
            ("docs/*", "docs/sub/a.md", false),
            ("/docs", "docs/a.md", true),
            ("/docs", "x/docs/a.md", false),
            ("docs", "docs/x", true),
            ("docs", "a/docs/x/y", true),
            ("docs", "docs", true),
            ("docs", "mydocs/x", false),
            ("/build/logs", "build/logs/a.txt", true),
            ("/build/logs", "build/logs", true),
            ("/build/logs", "x/build/logs/a.txt", false),
            ("build/logs", "x/build/logs/a.txt", false),
            ("a/b", "a/b/c/d", true),
        ]);
    }

    #[test]
    fn trailing_slash_is_directory_only() {
        table(&[
            ("logs/", "logs/a", true),
            ("logs/", "x/logs/a", true),
            ("logs/", "x/y/logs/a/b", true),
            ("logs/", "logs", false),
            ("logs/", "x/logs", false),
            ("/logs/", "logs/a", true),
            ("/logs/", "x/logs/a", false),
            ("apps/", "apps/web/index.ts", true),
            ("apps/", "x/apps/y.ts", true),
            ("/build/logs/", "build/logs/a.txt", true),
            ("/build/logs/", "build/logs", false),
            ("crates/*/migrations/", "crates/a/migrations/1.sql", true),
            ("crates/*/migrations/", "crates/a/b/migrations/1.sql", false),
            ("foo/**/", "foo/a/b", true),
            ("foo/**/", "foo/a", false),
        ]);
    }

    #[test]
    fn case_and_escapes() {
        table(&[
            ("README.md", "readme.md", false),
            ("README.md", "README.md", true),
            ("*.MD", "a.md", false),
            ("Docs/", "docs/a", false),
            ("a\\*b", "a*b", true),
            ("a\\*b", "axb", false),
            ("a\\?b", "a?b", true),
            ("My Notes.md", "x/My Notes.md", true),
            ("#notes", "#notes", true),
        ]);
    }

    #[test]
    fn patterns_naming_no_path() {
        table(&[
            ("/", "a", false),
            ("//", "a", false),
            ("", "a", false),
            ("*", "", false),
        ]);
    }

    // -----------------------------------------------------------------
    // Precedence
    // -----------------------------------------------------------------

    #[test]
    fn last_match_wins_within_a_section() {
        let file = parse("* @a\n*.rs @b\nsrc/ @c\nsrc/*.rs @d\n");
        assert_eq!(who(&file, "x.rs"), vec!["-:2:@b"]);
        assert_eq!(who(&file, "src/x.rs"), vec!["-:4:@d"]);
        assert_eq!(who(&file, "src/x.txt"), vec!["-:3:@c"]);
        assert_eq!(who(&file, "src/a/x.rs"), vec!["-:3:@c"]);
        let reversed = parse("src/*.rs @d\nsrc/ @c\n*.rs @b\n* @a\n");
        assert_eq!(who(&reversed, "src/x.rs"), vec!["-:4:@a"]);
    }

    #[test]
    fn each_section_applies_its_own_last_match() {
        let file = parse("* @a\n[One]\n* @b\n*.rs @c\n[Two]\n*.rs @d\n* @e\n");
        assert_eq!(who(&file, "x.rs"), vec!["-:1:@a", "One:4:@c", "Two:7:@e"]);
        assert_eq!(who(&file, "x.txt"), vec!["-:1:@a", "One:3:@b", "Two:7:@e"]);
    }

    #[test]
    fn ownerless_rule_removes_owners_in_default_section() {
        let file = parse("* @a\n/vendor/\n");
        assert_eq!(who(&file, "vendor/x"), vec!["-:2:"]);
        assert!(file.requirements(&["vendor/x".into()]).is_empty());
        assert!(parse("").owners_of("x").is_empty());
    }

    #[test]
    fn requirements_list_each_path_once() {
        let file = parse("* @a\n");
        assert_eq!(needs(&file, &["x", "y", "x"]), vec!["-:1:*:1:x,y"]);
    }

    #[test]
    fn locations() {
        assert_eq!(pick_location(&[]), None);
        assert_eq!(
            pick_location(&["CODEOWNERS", ".github/CODEOWNERS"]),
            Some(".github/CODEOWNERS")
        );
        assert_eq!(
            pick_location(&[".gitlab/CODEOWNERS", "docs/CODEOWNERS"]),
            Some("docs/CODEOWNERS")
        );
        assert_eq!(
            pick_location(&[".gitlab/CODEOWNERS", ".g1t/CODEOWNERS"]),
            Some(".g1t/CODEOWNERS")
        );
        assert_eq!(pick_location(&["src/CODEOWNERS"]), None);
        assert!(is_codeowners_path(".g1t/CODEOWNERS"));
        assert!(is_codeowners_path("CODEOWNERS"));
        assert!(!is_codeowners_path("/CODEOWNERS"));
        assert!(!is_codeowners_path("codeowners"));
        assert!(!is_codeowners_path("a/CODEOWNERS"));
    }

    // -----------------------------------------------------------------
    // Owners and errors
    // -----------------------------------------------------------------

    #[test]
    fn owner_tokens() {
        assert_eq!(Owner::parse("@Ana"), Some(user("ana")));
        assert_eq!(Owner::parse("@ana.b_c-d"), Some(user("ana.b_c-d")));
        assert_eq!(Owner::parse("@Acme/Back-End"), Some(team("acme", "back-end")));
        assert_eq!(Owner::parse("Ana@Example.COM"), Some(email("ana@example.com")));
        assert_eq!(
            Owner::parse("first.last+tag@mail.example.org"),
            Some(email("first.last+tag@mail.example.org"))
        );
        for bad in [
            "@", "@a/b/c", "foo", "@a/", "@/b", "@-ana", "@ana!", "a@b", "@a@b.com", "a@@b.com", "a@.com", "a@b.",
            "a@b..com", "",
        ] {
            assert_eq!(Owner::parse(bad), None, "{bad}");
        }
        for owner in [user("ana"), team("acme", "backend"), email("ana@example.com")] {
            assert_eq!(Owner::parse(&owner.text()), Some(owner.clone()));
        }
        assert_eq!(team("acme", "backend").text(), "@acme/backend");
    }

    #[test]
    fn errors_with_lines() {
        let text = "\
* @ana
!vendor/ @bo
src/[ab].rs @bo
lib/ @bo nobody @acme/a/b @cy
\\#hash @dee # owners of #hash
/
[Unclosed
[]
[Name][x]
[Name][0]
[Name][11]
[Name]oops
[Good][10] @ok bad-owner
";
        let file = parse(text);
        assert_eq!(
            kinds(&file),
            vec![
                (2, ErrorKind::Negation, Some("!vendor/".into())),
                (3, ErrorKind::CharacterRange, Some("src/[ab].rs".into())),
                (4, ErrorKind::BadOwner, Some("nobody".into())),
                (4, ErrorKind::BadOwner, Some("@acme/a/b".into())),
                (6, ErrorKind::BadPattern, Some("/".into())),
                (7, ErrorKind::BadSection, Some("[Unclosed".into())),
                (8, ErrorKind::BadSection, Some("[]".into())),
                (9, ErrorKind::BadSection, Some("[Name][x]".into())),
                (10, ErrorKind::BadSection, Some("[Name][0]".into())),
                (11, ErrorKind::BadSection, Some("[Name][11]".into())),
                (12, ErrorKind::BadSection, Some("[Name]oops".into())),
                (13, ErrorKind::BadOwner, Some("bad-owner".into())),
            ]
        );
        let patterns: Vec<&str> = file.rules.iter().map(|r| r.pattern.as_str()).collect();
        assert_eq!(patterns, vec!["*", "lib/", "#hash"]);
        assert_eq!(file.rules[1].owners, vec![user("bo"), user("cy")]);
        assert_eq!(file.rules[2].owners, vec![user("dee")]);
        assert_eq!(file.rules[2].line, 5);
        assert_eq!(file.sections.len(), 1);
        assert_eq!(file.sections[0].approvals, 10);
        assert_eq!(file.sections[0].default_owners, vec![user("ok")]);
        assert!(file.errors[0].message.contains("negation is not supported"));
        assert!(file.errors[2].message.starts_with("nobody is not an owner"));
        assert!(file.errors.iter().all(|e| e.message.ends_with('.')));
    }

    #[test]
    fn inline_comments_need_whitespace_before_them() {
        let file = parse("a#b @ana#x @bo #c @cy\n");
        assert_eq!(file.rules[0].pattern, "a#b");
        assert_eq!(file.rules[0].owners, vec![user("bo")]);
        assert_eq!(kinds(&file), vec![(1, ErrorKind::BadOwner, Some("@ana#x".into()))]);
        let header = parse("[Docs] @ana # writers\n");
        assert_eq!(header.sections[0].default_owners, vec![user("ana")]);
    }

    #[test]
    fn crlf_and_bom() {
        let file = parse("\u{feff}*.md @ana\r\n\r\n[Docs][2] @bo\r\ndocs/\r\n");
        assert!(file.errors.is_empty(), "{:?}", file.errors);
        assert_eq!(file.rules[0].pattern, "*.md");
        assert_eq!(file.rules[0].owners, vec![user("ana")]);
        assert_eq!(file.sections[0].name, "Docs");
        assert_eq!(file.sections[0].line, 3);
        assert_eq!(file.rules[1].line, 4);
        assert_eq!(file.rules[1].pattern, "docs/");
    }

    #[test]
    fn too_large() {
        let mut text = String::from("* @ana\n");
        text.push_str(&"#".repeat(MAX_BYTES));
        let file = parse(&text);
        assert!(file.rules.is_empty());
        assert_eq!(kinds(&file), vec![(0, ErrorKind::TooLarge, None)]);
        let just_fits = "#".repeat(MAX_BYTES);
        assert!(parse(&just_fits).errors.is_empty());
    }

    #[test]
    fn owners_and_lines_naming() {
        let file = parse("* @bo ana@example.com\n[Docs] @acme/docs @bo\ndocs/\n*.md @bo\n");
        assert_eq!(
            file.owners(),
            vec![user("bo"), team("acme", "docs"), email("ana@example.com")]
        );
        assert_eq!(file.lines_naming(&user("bo")), vec![1, 2, 4]);
        assert_eq!(file.lines_naming(&team("acme", "docs")), vec![2]);
        assert!(file.lines_naming(&user("nobody")).is_empty());
    }

    #[test]
    fn check_owners_reports_each_line() {
        let file = parse(
            "\
* @ana @ghost
docs/ @acme/docs @acme/infra
*.md ana@example.com @ghost
[Ops] @carl
ops/ @acme/ops
",
        );
        let lookup = |owner: &Owner| match owner.text().as_str() {
            "@ghost" => OwnerCheck::UnknownUser,
            "@acme/infra" => OwnerCheck::UnknownTeam,
            "@acme/docs" => OwnerCheck::TeamNoAccess,
            "ana@example.com" => OwnerCheck::UnknownEmail,
            "@carl" => OwnerCheck::NoWriteAccess,
            _ => OwnerCheck::Ok,
        };
        let errors = check_owners(&file, &lookup);
        let got: Vec<(u32, ErrorKind, &str, &str)> = errors
            .iter()
            .map(|e| (e.line, e.kind, e.token.as_deref().unwrap(), e.message.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                (1, ErrorKind::UnknownUser, "@ghost", "@ghost is not a g1t account."),
                (
                    2,
                    ErrorKind::TeamNoAccess,
                    "@acme/docs",
                    "@acme/docs has no access to this repository; give the team the Write role or higher."
                ),
                (
                    2,
                    ErrorKind::UnknownTeam,
                    "@acme/infra",
                    "@acme/infra is not a team of acme."
                ),
                (3, ErrorKind::UnknownUser, "@ghost", "@ghost is not a g1t account."),
                (
                    3,
                    ErrorKind::UnknownEmail,
                    "ana@example.com",
                    "No g1t account has confirmed ana@example.com."
                ),
                (
                    4,
                    ErrorKind::NoWriteAccess,
                    "@carl",
                    "@carl cannot write to this repository; code owners need the Write role or higher."
                ),
            ]
        );
        assert!(check_owners(&file, &|_| OwnerCheck::Ok).is_empty());
    }

    // -----------------------------------------------------------------
    // Reviews
    // -----------------------------------------------------------------

    fn verdicts(list: &[(&str, bool)]) -> Vec<Verdict> {
        list.iter()
            .map(|(username, approved)| Verdict {
                username: username.to_string(),
                approved: *approved,
            })
            .collect()
    }

    fn members(owner: &Owner) -> Vec<String> {
        let names: &[&str] = match owner.text().as_str() {
            "@acme/backend" => &["bo", "cy", "Dee"],
            "@acme/writers" => &["wil", "xan"],
            "ana@example.com" => &["ana"],
            "@ana" => &["ana"],
            "@bo" => &["bo"],
            _ => &[],
        };
        names.iter().map(|n| n.to_string()).collect()
    }

    fn requirement(section: Option<&str>, line: u32, pattern: &str, owners: Vec<Owner>, approvals: u32) -> Requirement {
        Requirement {
            section: section.map(String::from),
            line,
            pattern: pattern.into(),
            owners,
            approvals,
            optional: false,
            files: vec![format!("{pattern}-file")],
        }
    }

    #[test]
    fn approvals_count_per_requirement() {
        let reqs = vec![
            requirement(None, 1, "src/api/**", vec![team("acme", "backend")], 2),
            requirement(None, 2, "*.md", vec![user("ana")], 1),
        ];
        let reviews = evaluate(&reqs, &members, &verdicts(&[("bo", true), ("ANA", true)]), "eve");
        assert_eq!(reviews[0].approved_by, vec!["bo"]);
        assert!(!reviews[0].satisfied);
        assert_eq!(reviews[1].approved_by, vec!["ana"]);
        assert!(reviews[1].satisfied);
        assert_eq!(reviews[0].owners, vec!["@acme/backend"]);
        assert_eq!(reviews[0].required, 2);

        let both = evaluate(
            &reqs,
            &members,
            &verdicts(&[("bo", true), ("dee", true), ("ana", true)]),
            "eve",
        );
        assert_eq!(both[0].approved_by, vec!["bo", "dee"]);
        assert!(both.iter().all(|r| r.satisfied));
    }

    #[test]
    fn two_approvals_need_two_people() {
        let reqs = vec![requirement(Some("Docs"), 3, "docs/", vec![team("acme", "writers")], 2)];
        let same = evaluate(&reqs, &members, &verdicts(&[("wil", true), ("WIL", true)]), "eve");
        assert_eq!(same[0].approved_by, vec!["wil"]);
        assert!(!same[0].satisfied);
        let two = evaluate(&reqs, &members, &verdicts(&[("wil", true), ("xan", true)]), "eve");
        assert!(two[0].satisfied);
    }

    #[test]
    fn author_never_counts() {
        let reqs = vec![requirement(None, 1, "*", vec![user("ana"), user("bo")], 1)];
        let reviews = evaluate(&reqs, &members, &verdicts(&[("ana", true)]), "Ana");
        assert!(reviews[0].approved_by.is_empty());
        assert!(!reviews[0].satisfied);
        let reviews = evaluate(&reqs, &members, &verdicts(&[("ana", false)]), "ana");
        assert!(reviews[0].changes_requested_by.is_empty());
    }

    #[test]
    fn only_owners_count() {
        let reqs = vec![requirement(None, 1, "*", vec![user("ana")], 1)];
        let reviews = evaluate(&reqs, &members, &verdicts(&[("stranger", true), ("bo", false)]), "eve");
        assert!(reviews[0].approved_by.is_empty());
        assert!(reviews[0].changes_requested_by.is_empty());
        assert!(!reviews[0].satisfied);
    }

    #[test]
    fn team_members_and_emails_count() {
        let reqs = vec![requirement(
            None,
            1,
            "*",
            vec![team("acme", "backend"), email("ana@example.com")],
            2,
        )];
        let reviews = evaluate(&reqs, &members, &verdicts(&[("dee", true), ("ana", true)]), "eve");
        assert_eq!(reviews[0].approved_by, vec!["dee", "ana"]);
        assert!(reviews[0].satisfied);
    }

    #[test]
    fn a_change_request_blocks() {
        let reqs = vec![requirement(None, 1, "docs/", vec![team("acme", "backend")], 1)];
        let reviews = evaluate(&reqs, &members, &verdicts(&[("cy", true), ("bo", false)]), "eve");
        assert_eq!(reviews[0].approved_by, vec!["cy"]);
        assert_eq!(reviews[0].changes_requested_by, vec!["bo"]);
        assert!(!reviews[0].satisfied);
        assert_eq!(
            missing(&reviews).unwrap(),
            "@bo asked for changes on docs/ (code owner)."
        );
    }

    #[test]
    fn optional_never_blocks() {
        let mut req = requirement(Some("Style"), 1, "*.css", vec![user("bo")], 0);
        req.optional = true;
        let reviews = evaluate(&[req], &members, &verdicts(&[("bo", false)]), "eve");
        assert_eq!(reviews[0].changes_requested_by, vec!["bo"]);
        assert!(reviews[0].satisfied);
        assert_eq!(missing(&reviews), None);
    }

    #[test]
    fn one_approver_satisfies_several_requirements() {
        let file = parse("* @acme/backend\n[Docs]\n*.md @bo\n[Api][1] @acme/backend\nsrc/\n");
        let reqs = file.requirements(&["src/a.rs".into(), "README.md".into()]);
        assert_eq!(reqs.len(), 3);
        let reviews = evaluate(&reqs, &members, &verdicts(&[("bo", true)]), "eve");
        assert!(reviews.iter().all(|r| r.satisfied), "{reviews:?}");
        assert_eq!(missing(&reviews), None);
    }

    #[test]
    fn missing_wording() {
        let reqs = vec![
            requirement(None, 1, "src/api/**", vec![team("acme", "backend")], 2),
            requirement(None, 2, "*.md", vec![user("ana")], 1),
        ];
        let reviews = evaluate(&reqs, &members, &verdicts(&[("bo", true)]), "eve");
        assert_eq!(
            missing(&reviews).unwrap(),
            "Code owners have not approved: @acme/backend for src/api/** (1 of 2 approvals), @ana for *.md."
        );

        let reqs = vec![
            requirement(None, 1, "docs/", vec![user("bo")], 1),
            requirement(None, 2, "*.md", vec![user("ana"), user("bo")], 1),
        ];
        let reviews = evaluate(&reqs, &members, &verdicts(&[("bo", false)]), "eve");
        assert_eq!(
            missing(&reviews).unwrap(),
            "@bo asked for changes on docs/ (code owner). @bo asked for changes on *.md (code owner)."
        );

        assert_eq!(missing(&[]), None);
    }

    #[test]
    fn missing_caps_at_three() {
        let reqs: Vec<Requirement> = (1..=5)
            .map(|n| requirement(None, n, &format!("p{n}/"), vec![user("ana")], 1))
            .collect();
        let reviews = evaluate(&reqs, &members, &[], "eve");
        assert_eq!(
            missing(&reviews).unwrap(),
            "Code owners have not approved: @ana for p1/, @ana for p2/, @ana for p3/, and 2 more."
        );
        let mut changes: Vec<Requirement> = (1..=4)
            .map(|n| requirement(None, n, &format!("d{n}/"), vec![user("bo")], 1))
            .collect();
        changes.push(requirement(None, 9, "z/", vec![user("ana")], 1));
        let reviews = evaluate(&changes, &members, &verdicts(&[("bo", false)]), "eve");
        assert_eq!(
            missing(&reviews).unwrap(),
            "@bo asked for changes on d1/ (code owner). @bo asked for changes on d2/ (code owner). \
             @bo asked for changes on d3/ (code owner). And 2 more."
        );
    }

    // -----------------------------------------------------------------
    // Serde
    // -----------------------------------------------------------------

    #[test]
    fn serde_shapes() {
        assert_eq!(
            serde_json::to_string(&team("acme", "backend")).unwrap(),
            r#"{"kind":"team","workspace":"acme","slug":"backend"}"#
        );
        assert_eq!(
            serde_json::to_string(&user("ana")).unwrap(),
            r#"{"kind":"user","username":"ana"}"#
        );
        assert_eq!(
            serde_json::to_string(&email("a@b.co")).unwrap(),
            r#"{"kind":"email","email":"a@b.co"}"#
        );
        assert_eq!(
            serde_json::to_string(&ErrorKind::CharacterRange).unwrap(),
            r#""character_range""#
        );
        assert_eq!(serde_json::to_string(&ErrorKind::TooLarge).unwrap(), r#""too_large""#);
        assert_eq!(
            serde_json::to_string(&OwnerCheck::TeamNoAccess).unwrap(),
            r#""team_no_access""#
        );
        assert_eq!(serde_json::to_string(&OwnerCheck::Ok).unwrap(), r#""ok""#);
        let file = parse("[Docs][2] @acme/writers\ndocs/\n");
        let json = serde_json::to_string(&file).unwrap();
        assert!(json.contains(r#""default_owners":[{"kind":"team","workspace":"acme","slug":"writers"}]"#));
        let back: CodeOwners = serde_json::from_str(&json).unwrap();
        assert_eq!(back, file);
    }
}
