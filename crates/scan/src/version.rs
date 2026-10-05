//! Ordering versions well enough to pick an upgrade: semver, Cargo, Go's
//! `v1.2.3`, Python's `1.2.post1` and the like.

use std::cmp::Ordering;

#[derive(Debug, PartialEq, Eq)]
enum Part {
    Number(u64),
    Text(String),
}

/// The release and the pre-release of a version, each split into numbers
/// and words. `+build` metadata is ignored, as semver says.
fn parts(version: &str) -> (Vec<Part>, Vec<Part>) {
    let version = version.trim().trim_start_matches(['v', 'V', '=']);
    let version = version.split('+').next().unwrap_or(version);
    let (release, pre) = match version.split_once('-') {
        Some((release, pre)) => (release, Some(pre)),
        None => (version, None),
    };
    let split = |text: &str| -> Vec<Part> {
        let mut out = Vec::new();
        let mut current = String::new();
        let mut digits = false;
        let flush = |current: &mut String, digits: bool, out: &mut Vec<Part>| {
            if current.is_empty() {
                return;
            }
            out.push(if digits {
                Part::Number(current.parse().unwrap_or(u64::MAX))
            } else {
                Part::Text(current.to_lowercase())
            });
            current.clear();
        };
        for c in text.chars() {
            if c.is_ascii_alphanumeric() {
                let is_digit = c.is_ascii_digit();
                if !current.is_empty() && is_digit != digits {
                    flush(&mut current, digits, &mut out);
                }
                digits = is_digit;
                current.push(c);
            } else {
                flush(&mut current, digits, &mut out);
            }
        }
        flush(&mut current, digits, &mut out);
        out
    };
    let mut release = split(release);
    // A Python pre-release is written into the release: `2.0.0rc1`.
    let mut pre_parts = pre.map(split).unwrap_or_default();
    if let Some(at) = release.iter().position(|part| matches!(part, Part::Text(text) if is_pre_word(text))) {
        let mut tail = release.split_off(at);
        tail.append(&mut pre_parts);
        pre_parts = tail;
    }
    (release, pre_parts)
}

fn is_pre_word(text: &str) -> bool {
    matches!(text, "a" | "b" | "c" | "rc" | "alpha" | "beta" | "pre" | "dev" | "preview")
}

fn compare_parts(a: &[Part], b: &[Part]) -> Ordering {
    let length = a.len().max(b.len());
    for index in 0..length {
        let ordering = match (a.get(index), b.get(index)) {
            (Some(Part::Number(x)), Some(Part::Number(y))) => x.cmp(y),
            (Some(Part::Text(x)), Some(Part::Text(y))) => x.cmp(y),
            (Some(Part::Number(_)), Some(Part::Text(_))) => Ordering::Greater,
            (Some(Part::Text(_)), Some(Part::Number(_))) => Ordering::Less,
            // 1.2 == 1.2.0
            (Some(Part::Number(x)), None) => x.cmp(&0),
            (None, Some(Part::Number(y))) => 0.cmp(y),
            // 1.2.post1 > 1.2
            (Some(Part::Text(_)), None) => Ordering::Greater,
            (None, Some(Part::Text(_))) => Ordering::Less,
            (None, None) => Ordering::Equal,
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
}

/// Orders two versions. A pre-release comes before its release.
pub fn compare(a: &str, b: &str) -> Ordering {
    let (a_release, a_pre) = parts(a);
    let (b_release, b_pre) = parts(b);
    compare_parts(&a_release, &b_release).then_with(|| match (a_pre.is_empty(), b_pre.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => compare_parts(&a_pre, &b_pre),
    })
}

#[cfg(test)]
mod tests {
    use super::compare;
    use std::cmp::Ordering::*;

    #[test]
    fn versions_are_ordered() {
        for (a, b, expected) in [
            ("1.2.3", "1.2.10", Less),
            ("v1.9.0", "v1.10.0", Less),
            ("2.0.0", "2.0.0-rc.1", Greater),
            ("1.0.0-alpha", "1.0.0-beta", Less),
            ("1.2", "1.2.0", Equal),
            ("4.17.21", "4.17.21", Equal),
            ("2.0.0rc1", "2.0.0", Less),
            ("1.2.post1", "1.2", Greater),
            ("0.10.0", "0.9.9", Greater),
            ("1.0.0+build.5", "1.0.0", Equal),
        ] {
            assert_eq!(compare(a, b), expected, "{a} vs {b}");
        }
    }
}
