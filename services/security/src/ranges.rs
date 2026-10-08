//! Version requirements, as `ignore` rules and manifests write them in
//! each ecosystem's own syntax: npm's `^1.2.0 || 2.x`, Cargo's `1.2`
//! (a caret), pip's `~=1.4, !=1.4.2`, Bundler's `~> 2.0`, NuGet's `7.*`,
//! Maven's `[1.4,)`. And what kind of update one version is from another.

use std::cmp::Ordering;

use g1t_scan::version;

/// How a bare version, with no operator, is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bare {
    /// That version exactly (npm, pip, an `ignore` rule).
    Exact,
    /// A caret requirement (Cargo).
    Caret,
}

#[derive(Clone, Debug, PartialEq)]
enum Bound {
    Min(String, bool),
    Max(String, bool),
    Not(String),
    Exact(String),
}

/// The leading numbers of a version: `v1.2.3-rc.1` is `[1, 2, 3]`.
fn numbers(text: &str) -> Vec<u64> {
    let text = text.trim().trim_start_matches(['v', 'V', '=']);
    let release = text.split(['-', '+']).next().unwrap_or(text);
    let mut out = Vec::new();
    for part in release.split('.') {
        let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            break;
        }
        out.push(digits.parse().unwrap_or(u64::MAX));
        if digits.len() != part.len() {
            break;
        }
    }
    out
}

fn join(parts: &[u64]) -> String {
    parts.iter().map(u64::to_string).collect::<Vec<_>>().join(".")
}

/// The version just past every one starting with `parts`: `[1, 2]` → `1.3`.
fn next_after(parts: &[u64]) -> String {
    let mut parts = parts.to_vec();
    if let Some(last) = parts.last_mut() {
        *last += 1;
    }
    join(&parts)
}

/// A version written with wildcards: `1.2.x`, `1.*`, `*`. Returns the
/// fixed numbers before the first wildcard.
fn wildcard(text: &str) -> Option<Vec<u64>> {
    let text = text.trim().trim_start_matches(['v', '=']);
    let parts: Vec<&str> = text.split('.').collect();
    let at = parts.iter().position(|part| matches!(*part, "x" | "X" | "*"))?;
    parts[..at].iter().map(|part| part.parse().ok()).collect()
}

/// The bounds one comparator sets.
fn comparator(text: &str, bare: Bare) -> Option<Vec<Bound>> {
    let text = text.trim();
    let operators = ["===", "==", ">=", "<=", "!=", "~>", "~=", "^", "~", ">", "<", "="];
    let (operator, rest) = operators
        .iter()
        .find_map(|op| text.strip_prefix(op).map(|rest| (*op, rest.trim())))
        .unwrap_or(("", text));
    if rest.is_empty() {
        return None;
    }
    if let Some(fixed) = wildcard(rest) {
        let low = join(&fixed);
        return Some(match operator {
            "" | "=" | "==" | "===" | "^" | "~" => {
                if fixed.is_empty() {
                    vec![]
                } else {
                    vec![Bound::Min(low, true), Bound::Max(next_after(&fixed), false)]
                }
            }
            "!=" => vec![Bound::Not(rest.to_owned())],
            ">=" | ">" => vec![Bound::Min(low, true)],
            "<" | "<=" => vec![Bound::Max(low, false)],
            _ => return None,
        });
    }
    let parts = numbers(rest);
    if parts.is_empty() {
        return None;
    }
    let version = rest.to_owned();
    let caret = |parts: &[u64]| -> Vec<Bound> {
        // The first non-zero part may not change; `^0.0` and `^0` hold their zeros.
        let keep = parts.iter().position(|part| *part != 0).map_or(parts.len().max(1), |at| at + 1).min(parts.len());
        vec![Bound::Min(version.clone(), true), Bound::Max(next_after(&parts[..keep]), false)]
    };
    Some(match operator {
        "" if bare == Bare::Caret => caret(&parts),
        "" | "=" | "==" | "===" => vec![Bound::Exact(version)],
        "^" => caret(&parts),
        "~" => {
            let keep = if parts.len() >= 2 { 2 } else { 1 };
            vec![Bound::Min(version.clone(), true), Bound::Max(next_after(&parts[..keep]), false)]
        }
        "~>" | "~=" => {
            let keep = parts.len().saturating_sub(1).max(1);
            vec![Bound::Min(version.clone(), true), Bound::Max(next_after(&parts[..keep]), false)]
        }
        ">=" => vec![Bound::Min(version, true)],
        ">" => vec![Bound::Min(version, false)],
        "<=" => vec![Bound::Max(version, true)],
        "<" => vec![Bound::Max(version, false)],
        "!=" => vec![Bound::Not(version)],
        _ => return None,
    })
}

/// Maven's and NuGet's interval notation: `[1.0,2.0)`, `(,1.0]`, `[1.5,)`, `[1.0]`.
fn interval(text: &str) -> Option<Vec<Bound>> {
    let text = text.trim();
    let open = text.chars().next().filter(|c| matches!(c, '[' | '('))?;
    let close = text.chars().last().filter(|c| matches!(c, ']' | ')'))?;
    let inner = &text[1..text.len() - 1];
    let Some((low, high)) = inner.split_once(',') else {
        return (open == '[' && close == ']').then(|| vec![Bound::Exact(inner.trim().to_owned())]);
    };
    let mut bounds = Vec::new();
    if !low.trim().is_empty() {
        bounds.push(Bound::Min(low.trim().to_owned(), open == '['));
    }
    if !high.trim().is_empty() {
        bounds.push(Bound::Max(high.trim().to_owned(), close == ']'));
    }
    Some(bounds)
}

/// One set of bounds that must all hold, from `>=1.2 <2`, `>= 1.2, < 2` or `1.2 - 2.3`.
fn conjunction(text: &str, bare: Bare) -> Option<Vec<Bound>> {
    let text = text.trim();
    if text.is_empty() || text == "*" || text.eq_ignore_ascii_case("latest") {
        return Some(Vec::new());
    }
    if let Some(bounds) = interval(text) {
        return Some(bounds);
    }
    if let Some((low, high)) = text.split_once(" - ") {
        let high_parts = numbers(high);
        let max = if high.trim().split('.').count() < 3 && !high_parts.is_empty() {
            Bound::Max(next_after(&high_parts), false)
        } else {
            Bound::Max(high.trim().to_owned(), true)
        };
        return Some(vec![Bound::Min(low.trim().to_owned(), true), max]);
    }
    // Operators may be followed by a space: `>= 1.2, < 2`.
    let mut tokens: Vec<String> = Vec::new();
    for word in text.split([',', ' ']).filter(|word| !word.is_empty()) {
        match tokens.last_mut() {
            Some(last) if last.chars().all(|c| "<>=!~^".contains(c)) => last.push_str(word),
            _ => tokens.push(word.to_owned()),
        }
    }
    let mut bounds = Vec::new();
    for token in tokens {
        bounds.extend(comparator(&token, bare)?);
    }
    Some(bounds)
}

fn holds(bound: &Bound, candidate: &str) -> bool {
    let order = version::compare(candidate, match bound {
        Bound::Min(v, _) | Bound::Max(v, _) | Bound::Not(v) | Bound::Exact(v) => v,
    });
    match bound {
        Bound::Min(_, inclusive) => order == Ordering::Greater || (*inclusive && order == Ordering::Equal),
        Bound::Max(_, inclusive) => order == Ordering::Less || (*inclusive && order == Ordering::Equal),
        Bound::Not(text) => match wildcard(text) {
            Some(fixed) => !numbers(candidate).starts_with(&fixed),
            None => order != Ordering::Equal,
        },
        Bound::Exact(_) => order == Ordering::Equal,
    }
}

/// Whether `candidate` meets `requirement`. `None` when the requirement
/// cannot be read.
pub fn satisfies(requirement: &str, candidate: &str, bare: Bare) -> Option<bool> {
    let mut any = false;
    for alternative in requirement.split("||") {
        let bounds = conjunction(alternative, bare)?;
        any |= bounds.iter().all(|bound| holds(bound, candidate));
    }
    Some(any)
}

/// Whether an `ignore` rule's `versions` entry covers `candidate`. One
/// that cannot be read covers the version it names, and nothing else.
pub fn ignored_by(versions: &str, candidate: &str) -> bool {
    satisfies(versions, candidate, Bare::Exact).unwrap_or_else(|| versions.trim() == candidate.trim())
}

/// `major`, `minor` or `patch`: the first of the three numbers that
/// differs from `from` to `to`.
pub fn update_level(from: &str, to: &str) -> &'static str {
    let (a, b) = (numbers(from), numbers(to));
    let at = |parts: &[u64], index: usize| parts.get(index).copied().unwrap_or(0);
    if at(&a, 0) != at(&b, 0) {
        "major"
    } else if at(&a, 1) != at(&b, 1) {
        "minor"
    } else {
        "patch"
    }
}

/// `version-update:semver-<level>`.
pub fn update_type(from: &str, to: &str) -> String {
    format!("version-update:semver-{}", update_level(from, to))
}

/// The requirement an `@g1t ignore this <level> version` comment records,
/// as an `ignore` rule's `versions` would say it: `>= 5.a, < 6` for a major
/// version, `>= 5.1.a, < 5.2` for a minor one, `5.1.3` for a patch.
pub fn ignore_level(to: &str, level: &str) -> String {
    let parts = numbers(to);
    let at = |index: usize| parts.get(index).copied().unwrap_or(0);
    match level {
        "major" => format!(">= {}.a, < {}", at(0), at(0) + 1),
        "minor" => format!(">= {}.{}.a, < {}.{}", at(0), at(1), at(0), at(1) + 1),
        _ => to.trim().to_owned(),
    }
}

/// Whether a version is a pre-release: `2.0.0-rc.1`, `2.0.0b1`, `2.0.0.dev1`.
pub fn prerelease(text: &str) -> bool {
    let text = text.trim().trim_start_matches(['v', 'V']);
    let release = text.split('+').next().unwrap_or(text);
    release.contains('-')
        || release
            .split('.')
            .any(|part| part.chars().any(|c| c.is_ascii_alphabetic()) && !part.starts_with("post") && !part.starts_with("final"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn npm(requirement: &str, candidate: &str) -> bool {
        satisfies(requirement, candidate, Bare::Exact).unwrap()
    }

    #[test]
    fn npm_ranges() {
        assert!(npm("^1.2.3", "1.9.0") && !npm("^1.2.3", "2.0.0") && !npm("^1.2.3", "1.2.2"));
        assert!(npm("^0.2.3", "0.2.9") && !npm("^0.2.3", "0.3.0"));
        assert!(npm("^0.0.3", "0.0.3") && !npm("^0.0.3", "0.0.4"));
        assert!(npm("~1.2.3", "1.2.9") && !npm("~1.2.3", "1.3.0"));
        assert!(npm("1.2.x", "1.2.7") && !npm("1.2.x", "1.3.0"));
        assert!(npm("1.x || >=3", "3.1.0") && npm("1.x || >=3", "1.4.0") && !npm("1.x || >=3", "2.0.0"));
        assert!(npm(">=1.2 <2", "1.5.0") && !npm(">=1.2 <2", "2.0.0"));
        assert!(npm("1.2 - 1.4", "1.4.9") && !npm("1.2 - 1.4", "1.5.0"));
        assert!(npm("*", "9.9.9") && npm("", "1.0.0"));
        assert!(npm("4.17.21", "4.17.21") && !npm("4.17.21", "4.17.20"));
    }

    #[test]
    fn other_ecosystems() {
        // Cargo: a bare version is a caret.
        assert!(satisfies("1.2", "1.9.0", Bare::Caret).unwrap());
        assert!(!satisfies("1.2", "2.0.0", Bare::Caret).unwrap());
        assert!(satisfies("0.3", "0.3.7", Bare::Caret).unwrap() && !satisfies("0.3", "0.4.0", Bare::Caret).unwrap());
        assert!(satisfies("=1.2.3", "1.2.3", Bare::Caret).unwrap());
        // pip.
        assert!(npm("~=1.4.2", "1.4.9") && !npm("~=1.4.2", "1.5.0"));
        assert!(npm("~=1.4", "1.9") && !npm("~=1.4", "2.0"));
        assert!(npm(">=2.0,!=2.1.0,<3", "2.2.0") && !npm(">=2.0,!=2.1.0,<3", "2.1.0"));
        assert!(npm("==1.*", "1.5") && !npm("==1.*", "2.0"));
        assert!(npm("!=1.*", "2.0") && !npm("!=1.*", "1.3"));
        // Bundler.
        assert!(npm("~> 2.0", "2.9") && !npm("~> 2.0", "3.0"));
        assert!(npm("~> 2.0.1", "2.0.9") && !npm("~> 2.0.1", "2.1.0"));
        // NuGet and Maven.
        assert!(npm("7.*", "7.3.1") && !npm("7.*", "8.0.0"));
        assert!(npm("[1.4,)", "1.4") && npm("[1.4,)", "3.0") && !npm("[1.4,)", "1.3"));
        assert!(npm("[1.0,2.0)", "1.9.9") && !npm("[1.0,2.0)", "2.0"));
        assert!(npm("(,1.0]", "1.0") && !npm("(,1.0]", "1.0.1"));
        assert!(npm("[1.0]", "1.0") && !npm("[1.0]", "1.1"));
        // An ignore rule written with spaces after operators.
        assert!(npm(">= 5.a, < 6", "5.0.0") && npm(">= 5.a, < 6", "5.9.1") && !npm(">= 5.a, < 6", "6.0.0") && !npm(">= 5.a, < 6", "4.9.0"));
        assert_eq!(satisfies("^", "1.0.0", Bare::Exact), None);
        assert!(ignored_by("not a range", "not a range"));
    }

    #[test]
    fn update_levels() {
        assert_eq!(update_level("4.17.20", "4.17.21"), "patch");
        assert_eq!(update_level("4.17.20", "4.18.0"), "minor");
        assert_eq!(update_level("4.17.20", "5.0.0"), "major");
        assert_eq!(update_level("v0.7.0", "v0.23.0"), "minor");
        assert_eq!(update_level("1.2", "1.2.1"), "patch");
        assert_eq!(update_type("1.0.0", "2.0.0"), "version-update:semver-major");
    }

    #[test]
    fn ignore_comments_become_requirements() {
        assert_eq!(ignore_level("5.1.3", "major"), ">= 5.a, < 6");
        assert_eq!(ignore_level("5.1.3", "minor"), ">= 5.1.a, < 5.2");
        assert_eq!(ignore_level("5.1.3", "patch"), "5.1.3");
        assert!(ignored_by(&ignore_level("5.1.3", "minor"), "5.1.9"));
        assert!(!ignored_by(&ignore_level("5.1.3", "minor"), "5.2.0"));
    }

    #[test]
    fn prereleases() {
        for pre in ["2.0.0-rc.1", "2.0.0b1", "2.0.0.dev1", "v1.0.0-alpha", "1.0a1"] {
            assert!(prerelease(pre), "{pre}");
        }
        for release in ["2.0.0", "v1.2.3", "1.2.post1", "1.0.0+build.5"] {
            assert!(!prerelease(release), "{release}");
        }
    }
}
