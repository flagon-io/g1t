//! The issues a pull request says it closes: a closing keyword followed by
//! an issue of the same repository, in its title or description, such as
//! `Fixes #12`, `closes: #3` or `Resolves flagon-io/g1t#40`. They close
//! when it merges into the default branch (`Work::record_merge`), where the
//! repository closes issues that way (`RepoSettings::auto_close_issues`).
//!
//! What sits in code, a `span` or a fenced block, says nothing: it is
//! usually an example.

use g1t_contracts::repos::RepoPath;

const KEYWORDS: [&str; 9] = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"];

/// The most issues one pull request closes this way.
pub(crate) const MAX_CLOSES: usize = 50;

/// The issue numbers `text` names after a closing keyword, in the order
/// named, each once. `repo` is the repository the pull request is in: a
/// reference naming another repository closes nothing.
pub(crate) fn references(text: &str, repo: &RepoPath) -> Vec<u32> {
    let mut found = Vec::new();
    for prose in outside_code(text) {
        scan(&prose, repo, &mut found);
    }
    found.truncate(MAX_CLOSES);
    found
}

/// The issues a pull request closes: its own issue first, then those its
/// title and description name.
pub(crate) fn closes(issue: Option<u32>, title: &str, body: Option<&str>, repo: &RepoPath) -> Vec<u32> {
    let mut closes: Vec<u32> = issue.into_iter().collect();
    let text = format!("{title}\n{}", body.unwrap_or_default());
    for number in references(&text, repo) {
        if !closes.contains(&number) {
            closes.push(number);
        }
    }
    closes.truncate(MAX_CLOSES);
    closes
}

/// The parts of Markdown outside fenced code blocks and code spans, each
/// with code replaced by a space so words on either side stay apart.
fn outside_code(text: &str) -> Vec<String> {
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
            (Some((mark, length)), Some((closing, run))) if closing == mark && run >= length && trimmed.trim_end().chars().all(|c| c == mark) => {
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

/// Every keyword-and-reference pair in `text`.
fn scan(text: &str, repo: &RepoPath, found: &mut Vec<u32>) {
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
        i = end;
        if !KEYWORDS.contains(&word.as_str()) {
            continue;
        }
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
        if let Some((number, after)) = reference(&chars, at, repo) {
            if !found.contains(&number) {
                found.push(number);
            }
            i = after;
        }
    }
}

/// An issue of `repo` referenced at `at`: `#12` or `owner/name#12`, ending
/// at a word boundary. The number and where the reference ends.
fn reference(chars: &[char], at: usize, repo: &RepoPath) -> Option<(u32, usize)> {
    let hash = if chars.get(at) == Some(&'#') {
        at
    } else {
        // owner/name#N, naming this repository.
        let length = chars[at..].iter().position(|c| *c == '#' || c.is_whitespace()).unwrap_or(chars.len() - at);
        let hash = at + length;
        if chars.get(hash) != Some(&'#') {
            return None;
        }
        let named: String = chars[at..hash].iter().collect();
        let (owner, name) = named.split_once('/')?;
        if !owner.eq_ignore_ascii_case(&repo.namespace) || !name.eq_ignore_ascii_case(&repo.name) {
            return None;
        }
        hash
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
    (number > 0).then_some((number, after))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> RepoPath {
        RepoPath { namespace: "flagon-io".into(), name: "g1t".into() }
    }

    fn refs(text: &str) -> Vec<u32> {
        references(text, &repo())
    }

    #[test]
    fn every_keyword_closes_whatever_its_case() {
        for keyword in KEYWORDS {
            assert_eq!(refs(&format!("{keyword} #7")), vec![7], "{keyword}");
            assert_eq!(refs(&format!("{} #7", keyword.to_uppercase())), vec![7], "{keyword}");
        }
        assert_eq!(refs("Fixes: #12"), vec![12]);
        assert_eq!(refs("fixes:#12"), vec![12]);
        assert_eq!(refs("This fixes #3 and resolves #4, closes #3 again."), vec![3, 4]);
    }

    #[test]
    fn only_whole_words_and_whole_numbers() {
        assert!(refs("prefixes #3").is_empty());
        assert!(refs("fixesthis #3").is_empty());
        assert!(refs("fixes#3").is_empty(), "no space and no colon");
        assert!(refs("fixes #3a").is_empty());
        assert!(refs("fixes #").is_empty());
        assert!(refs("fixes #0").is_empty());
        assert!(refs("fixes\n#3").is_empty(), "on the same line");
        assert_eq!(refs("(fixes #3)."), vec![3]);
        assert!(refs("fixes issue #3").is_empty(), "the reference follows the keyword");
    }

    #[test]
    fn a_reference_to_this_repository_by_name_counts_and_others_do_not() {
        assert_eq!(refs("Closes flagon-io/g1t#40"), vec![40]);
        assert_eq!(refs("closes Flagon-IO/G1T#40"), vec![40]);
        assert!(refs("closes someone/else#40").is_empty());
        assert!(refs("closes flagon-io/g1t-docs#40").is_empty());
        assert!(refs("closes g1t#40").is_empty());
    }

    #[test]
    fn code_says_nothing() {
        assert!(refs("Write `fixes #3` to close an issue.").is_empty());
        assert!(refs("Write ``fixes #3 `x` `` here.").is_empty());
        assert!(refs("```\nfixes #3\n```").is_empty());
        assert!(refs("~~~md\nfixes #3\n~~~").is_empty());
        assert_eq!(refs("```\nfixes #3\n```\nfixes #4"), vec![4]);
        // An unclosed span is just a backtick.
        assert_eq!(refs("a ` fixes #5"), vec![5]);
        // An unclosed fence hides the rest.
        assert!(refs("````\nfixes #6\n```\nfixes #7").is_empty());
    }

    #[test]
    fn its_own_issue_comes_first_and_nothing_twice() {
        assert_eq!(closes(Some(12), "Fix it", Some("Fixes #12, fixes #3"), &repo()), vec![12, 3]);
        assert_eq!(closes(None, "Resolve #9", None, &repo()), vec![9]);
        assert!(closes(None, "Nothing", Some(""), &repo()).is_empty());
        let many: String = (1..=80).map(|n| format!("fixes #{n} ")).collect();
        assert_eq!(closes(None, "", Some(&many), &repo()).len(), MAX_CLOSES);
    }
}
