//! The part of a result that matched, with the matches marked: a window of
//! prose, or numbered lines of code. Matching ignores case. Pure, so it is
//! tested apart from the index.

use g1t_contracts::search::{CodeLine, Segment};

/// Characters of prose a snippet shows, about.
pub const PROSE_CHARS: usize = 220;
/// Lines of code a result shows, at most.
pub const CODE_LINES: usize = 9;
/// Characters of one line of code shown; the rest is cut.
const LINE_CHARS: usize = 300;

fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// Which characters of `text` are inside a match of any of `terms`.
fn marks(text: &[char], terms: &[Vec<char>]) -> Vec<bool> {
    let mut marked = vec![false; text.len()];
    for term in terms.iter().filter(|term| !term.is_empty()) {
        if term.len() > text.len() {
            continue;
        }
        for start in 0..=text.len() - term.len() {
            if term.iter().zip(&text[start..]).all(|(a, b)| *a == fold(*b)) {
                marked[start..start + term.len()].iter_mut().for_each(|m| *m = true);
            }
        }
    }
    marked
}

fn folded(terms: &[String]) -> Vec<Vec<char>> {
    terms.iter().map(|term| term.chars().map(fold).collect()).collect()
}

/// `text` in pieces, each marked if it matched.
fn segments_of(text: &[char], marked: &[bool]) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    for (c, highlight) in text.iter().zip(marked) {
        match out.last_mut() {
            Some(last) if last.highlight == *highlight => last.text.push(*c),
            _ => out.push(Segment {
                text: c.to_string(),
                highlight: *highlight,
            }),
        }
    }
    out
}

/// All of `text`, with every match of `terms` marked.
#[cfg(test)]
pub fn highlight(text: &str, terms: &[String]) -> Vec<Segment> {
    let chars: Vec<char> = text.chars().collect();
    let marked = marks(&chars, &folded(terms));
    segments_of(&chars, &marked)
}

/// Whether `text` has any of `terms`.
pub fn contains_any(text: &str, terms: &[String]) -> bool {
    let chars: Vec<char> = text.chars().collect();
    marks(&chars, &folded(terms)).contains(&true)
}

/// About [`PROSE_CHARS`] of `text` around its first match, whitespace made
/// single spaces, with `…` where it was cut and every match marked. The
/// start of the text when nothing matches; empty for empty text.
pub fn prose(text: &str, terms: &[String]) -> Vec<Segment> {
    let flat: Vec<char> = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().collect();
    if flat.is_empty() {
        return Vec::new();
    }
    let marked = marks(&flat, &folded(terms));
    let first = marked.iter().position(|m| *m).unwrap_or(0);
    // A little before the first match, so it reads in context.
    let mut start = first.saturating_sub(PROSE_CHARS / 4);
    let end = (start + PROSE_CHARS).min(flat.len());
    if end - start < PROSE_CHARS {
        start = end.saturating_sub(PROSE_CHARS);
    }
    // Start and end on a word boundary where there is one nearby.
    if start > 0 {
        if let Some(space) = flat[start..first.max(start)].iter().position(|c| *c == ' ') {
            start += space + 1;
        }
    }
    let mut end = end;
    if end < flat.len()
        && let Some(space) = flat[start..end].iter().rposition(|c| *c == ' ')
        && start + space > first
    {
        end = start + space;
    }
    let mut out = segments_of(&flat[start..end], &marked[start..end]);
    if start > 0 {
        prepend(&mut out, "…");
    }
    if end < flat.len() {
        append(&mut out, "…");
    }
    out
}

fn prepend(segments: &mut Vec<Segment>, text: &str) {
    match segments.first_mut() {
        Some(first) if !first.highlight => first.text.insert_str(0, text),
        _ => segments.insert(0, Segment { text: text.to_owned(), highlight: false }),
    }
}

fn append(segments: &mut Vec<Segment>, text: &str) {
    match segments.last_mut() {
        Some(last) if !last.highlight => last.text.push_str(text),
        _ => segments.push(Segment { text: text.to_owned(), highlight: false }),
    }
}

/// The lines of a file that matched, with the line before and after each,
/// at most [`CODE_LINES`]. `pieces` are parts of the file as indexed, each
/// with the number of its first line. When no line matched (a match on the
/// file's path), its first lines.
pub fn code(pieces: &[(u32, &str)], terms: &[String]) -> Vec<CodeLine> {
    let folded_terms = folded(terms);
    let mut lines: Vec<(u32, Vec<char>, Vec<bool>)> = Vec::new();
    for (start, text) in pieces {
        for (offset, line) in text.lines().enumerate() {
            let chars: Vec<char> = line.trim_end_matches('\r').chars().take(LINE_CHARS).collect();
            let marked = marks(&chars, &folded_terms);
            lines.push((start + offset as u32, chars, marked));
        }
    }
    lines.sort_by_key(|(number, _, _)| *number);
    lines.dedup_by_key(|(number, _, _)| *number);
    let hits: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, (_, _, marked))| marked.contains(&true))
        .map(|(index, _)| index)
        .collect();
    let mut wanted: Vec<usize> = Vec::new();
    if hits.is_empty() {
        wanted.extend(0..lines.len().min(3));
    }
    for hit in hits {
        for index in hit.saturating_sub(1)..=(hit + 1).min(lines.len().saturating_sub(1)) {
            if !wanted.contains(&index) {
                wanted.push(index);
            }
        }
        if wanted.len() >= CODE_LINES {
            break;
        }
    }
    wanted.sort_unstable();
    wanted.truncate(CODE_LINES);
    wanted
        .into_iter()
        .map(|index| {
            let (number, chars, marked) = &lines[index];
            CodeLine {
                number: *number,
                parts: segments_of(chars, marked),
            }
        })
        .collect()
}

/// The first line number that matched, for a link straight to it.
pub fn first_match(lines: &[CodeLine]) -> Option<u32> {
    lines
        .iter()
        .find(|line| line.parts.iter().any(|part| part.highlight))
        .map(|line| line.number)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(segments: &[Segment]) -> String {
        segments
            .iter()
            .map(|s| if s.highlight { format!("[{}]", s.text) } else { s.text.clone() })
            .collect()
    }

    fn terms(list: &[&str]) -> Vec<String> {
        list.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn matches_are_marked_whatever_their_case() {
        let out = highlight("Parse the parser, PARSE it", &terms(&["parse"]));
        assert_eq!(shown(&out), "[Parse] the [parse]r, [PARSE] it");
    }

    #[test]
    fn overlapping_terms_make_one_mark() {
        let out = highlight("foobar", &terms(&["foo", "oba"]));
        assert_eq!(shown(&out), "[fooba]r");
    }

    #[test]
    fn nothing_to_mark_is_plain_text() {
        assert_eq!(shown(&highlight("plain", &terms(&["zzz"]))), "plain");
        assert_eq!(shown(&highlight("plain", &[])), "plain");
    }

    #[test]
    fn letters_outside_ascii_are_matched() {
        let out = highlight("Ärger über Ölpreise", &terms(&["über", "öl"]));
        assert_eq!(shown(&out), "Ärger [über] [Öl]preise");
    }

    #[test]
    fn prose_is_a_window_around_the_first_match() {
        let text = format!("{} the needle is here {}", "word ".repeat(100), "tail ".repeat(100));
        let out = prose(&text, &terms(&["needle"]));
        let plain = shown(&out);
        assert!(plain.starts_with('…') && plain.ends_with('…'), "{plain}");
        assert!(plain.contains("[needle]"));
        assert!(plain.chars().count() <= PROSE_CHARS + 4);
    }

    #[test]
    fn short_prose_is_shown_whole() {
        let out = prose("Fix  the\nlogin redirect", &terms(&["login"]));
        assert_eq!(shown(&out), "Fix the [login] redirect");
        assert!(prose("", &terms(&["x"])).is_empty());
    }

    #[test]
    fn code_lines_are_numbered_with_context() {
        let first = "use std::io;\n\nfn main() {\n    let query = parse();\n}\n";
        let out = code(&[(1, first)], &terms(&["parse"]));
        let numbers: Vec<u32> = out.iter().map(|line| line.number).collect();
        assert_eq!(numbers, vec![3, 4, 5]);
        assert_eq!(shown(&out[1].parts), "    let query = [parse]();");
        assert_eq!(first_match(&out), Some(4));
    }

    #[test]
    fn code_from_later_pieces_keeps_its_numbers() {
        let piece = "a\nb match\nc\n";
        let out = code(&[(121, piece)], &terms(&["match"]));
        assert_eq!(out.iter().map(|l| l.number).collect::<Vec<_>>(), vec![121, 122, 123]);
    }

    #[test]
    fn a_path_match_shows_the_first_lines() {
        let out = code(&[(1, "one\ntwo\nthree\nfour\n")], &terms(&["zzz"]));
        assert_eq!(out.iter().map(|l| l.number).collect::<Vec<_>>(), vec![1, 2, 3]);
        assert_eq!(first_match(&out), None);
    }

    #[test]
    fn many_matches_stop_at_the_limit() {
        let text: String = (0..100).map(|n| format!("hit {n}\n")).collect();
        let out = code(&[(1, &text)], &terms(&["hit"]));
        assert_eq!(out.len(), CODE_LINES);
    }
}
