//! Finding the files an artifact's `path` names, as `actions/upload-artifact`
//! does with `@actions/glob`: each line a file, a folder (taken whole) or a
//! glob, `!` lines leaving files out, and the folder the files are stored
//! relative to. Done here rather than in bash so it works the same on a
//! self-hosted runner on Windows or macOS.
//!
//! Paths are handled as text with `/` between their parts: `/w/dist` on
//! Linux and macOS, `C:/w/dist` on Windows, where matching ignores case.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// What a `path` found: the folder files are stored relative to, and each
/// file's name in the artifact with the file on disk, sorted by name.
#[derive(Debug, Default)]
pub(crate) struct Found {
    pub(crate) root: String,
    pub(crate) files: Vec<(String, PathBuf)>,
}

/// The files a `path` input names. `workspace` is where relative lines
/// start, `home` what `~` stands for. Files and folders whose names start
/// with `.` are left out below the paths named, unless `hidden`.
pub(crate) fn find(lines: &[String], workspace: &str, home: &str, hidden: bool) -> Found {
    let mut includes = Vec::new();
    let mut excludes = Vec::new();
    for line in lines {
        match line.strip_prefix('!') {
            Some(rest) => excludes.push(resolve(rest.trim(), workspace, home)),
            None => includes.push(resolve(line, workspace, home)),
        }
    }
    let mut matched = BTreeSet::new();
    for pattern in &includes {
        let search = search_path(pattern);
        let Ok(meta) = std::fs::metadata(&search) else { continue };
        let plain = search == *pattern;
        if meta.is_file() {
            if plain {
                matched.insert(search.clone());
            }
            continue;
        }
        let mut files = Vec::new();
        let mut stack = Vec::new();
        walk(Path::new(&search), &search, hidden, &mut stack, &mut files);
        let depth = segments(&search).len();
        for file in files {
            // A glob that matches a folder takes everything in it.
            if plain || prefixes(&file).skip(depth).any(|p| matches(pattern, &p)) {
                matched.insert(file);
            }
        }
    }
    matched.retain(|file| !excludes.iter().any(|ex| prefixes(file).any(|p| matches(ex, &p))));
    let searches: Vec<String> = includes.iter().map(|p| search_path(p)).collect();
    let all: Vec<String> = matched.into_iter().collect();
    let Some(root) = root_dir(&searches, &all) else { return Found::default() };
    let mut files: Vec<(String, PathBuf)> = all
        .iter()
        .filter_map(|file| relative(&root, file).map(|name| (name, PathBuf::from(file))))
        .collect();
    files.sort();
    files.dedup_by(|a, b| a.0 == b.0);
    Found { root, files }
}

/// A line made absolute with `/` separators: `~` is `home`, anything not
/// absolute is under `workspace`; `.` parts dropped and `..` taken back.
pub(crate) fn resolve(line: &str, workspace: &str, home: &str) -> String {
    let line = separators(line.trim());
    let line = if line == "~" {
        separators(home)
    } else if let Some(rest) = line.strip_prefix("~/") {
        format!("{}/{rest}", separators(home).trim_end_matches('/'))
    } else if is_absolute(&line) {
        line
    } else {
        format!("{}/{line}", separators(workspace).trim_end_matches('/'))
    };
    let mut parts: Vec<&str> = Vec::new();
    for (i, part) in line.split('/').enumerate() {
        match part {
            "" if i > 0 => {}
            "." => {}
            ".." if parts.len() > 1 && !has_glob(parts[parts.len() - 1]) => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    let joined = parts.join("/");
    if joined.is_empty() || (parts.len() == 1 && parts[0].is_empty()) { "/".into() } else if parts.len() == 1 { format!("{joined}/") } else { joined }
}

fn separators(path: &str) -> String {
    if cfg!(windows) { path.replace('\\', "/") } else { path.to_owned() }
}

fn is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/') || (cfg!(windows) && bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
}

fn has_glob(segment: &str) -> bool {
    segment.contains(['*', '?', '['])
}

fn segments(path: &str) -> Vec<&str> {
    path.trim_end_matches('/').split('/').collect()
}

/// The part of a pattern before its first glob: where looking starts.
/// A pattern with no glob is its own search path.
pub(crate) fn search_path(pattern: &str) -> String {
    let parts = segments(pattern);
    let literal: Vec<&str> = parts.iter().take_while(|s| !has_glob(s)).copied().collect();
    if literal.len() == parts.len() {
        return pattern.trim_end_matches('/').to_owned();
    }
    let joined = literal.join("/");
    if literal.len() <= 1 { format!("{joined}/") } else { joined }
}

/// A path and each folder above it, shortest first, as text.
fn prefixes(path: &str) -> impl Iterator<Item = String> + '_ {
    let parts = segments(path);
    (1..=parts.len()).map(move |n| parts[..n].join("/"))
}

/// Every file under `dir`, following links, leaving out hidden names
/// unless `hidden`. `stack` holds the folders being walked, so a link
/// back up the tree is not followed round.
fn walk(dir: &Path, text: &str, hidden: bool, stack: &mut Vec<PathBuf>, out: &mut Vec<String>) {
    let real = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if stack.contains(&real) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    stack.push(real);
    let mut names: Vec<(String, PathBuf)> = entries.flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), e.path())).collect();
    names.sort();
    for (name, path) in names {
        if !hidden && name.starts_with('.') {
            continue;
        }
        let child = format!("{}/{name}", text.trim_end_matches('/'));
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_dir() => walk(&path, &child, hidden, stack, out),
            Ok(meta) if meta.is_file() => out.push(child),
            _ => {}
        }
    }
    stack.pop();
}

/// The folder an artifact's files are stored relative to, as
/// `actions/upload-artifact` picks it: the deepest folder common to the
/// search paths when there are several; the folder of the one file when
/// the only search path is that file; otherwise the search path.
pub(crate) fn root_dir(searches: &[String], files: &[String]) -> Option<String> {
    let mut unique: Vec<String> = Vec::new();
    for search in searches {
        if !unique.contains(search) {
            unique.push(search.clone());
        }
    }
    // A search path inside another one adds nothing.
    let unique: Vec<String> = unique
        .iter()
        .filter(|s| !unique.iter().any(|other| other != *s && relative(other, s).is_some()))
        .cloned()
        .collect();
    match unique.as_slice() {
        [] => None,
        [one] if files.len() == 1 && files[0] == *one => {
            let parts = segments(one);
            let parent = parts[..parts.len() - 1].join("/");
            Some(if parts.len() <= 2 { format!("{parent}/") } else { parent })
        }
        [one] => Some(one.clone()),
        many => {
            let first = segments(&many[0]);
            let mut common = first.len();
            for other in &many[1..] {
                let other = segments(other);
                common = common.min(first.iter().zip(&other).take_while(|(a, b)| same(a, b)).count());
            }
            if common == 0 {
                return None;
            }
            let joined = first[..common].join("/");
            Some(if common == 1 { format!("{joined}/") } else { joined })
        }
    }
}

fn same(a: &str, b: &str) -> bool {
    if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a == b }
}

/// `path` relative to the folder `root`, with `/`, when it is inside it.
fn relative(root: &str, path: &str) -> Option<String> {
    let root = segments(root);
    let path = segments(path);
    let root: Vec<&str> = root.into_iter().filter(|s| !s.is_empty()).collect();
    let rest: Vec<&str> = path.iter().copied().filter(|s| !s.is_empty()).collect();
    if rest.len() <= root.len() || !root.iter().zip(&rest).all(|(a, b)| same(a, b)) {
        return None;
    }
    Some(rest[root.len()..].join("/"))
}

/// Whether `path` matches `pattern`, both absolute with `/`: `*` and `?`
/// within a part, `**` as a whole part for any number of parts, `[...]`
/// for one of a set. Leading dots match like any character.
pub(crate) fn matches(pattern: &str, path: &str) -> bool {
    let pattern = segments(pattern);
    let path = segments(path);
    match_parts(&pattern, &path)
}

fn match_parts(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((&"**", rest)) => (0..=path.len()).any(|skip| match_parts(rest, &path[skip..])),
        Some((first, rest)) => match path.split_first() {
            Some((part, others)) => matches_part(first, part) && match_parts(rest, others),
            None => false,
        },
    }
}

/// Whether one name matches one glob part (`**` within a part is `*`).
pub(crate) fn matches_part(pattern: &str, name: &str) -> bool {
    let (pattern, name): (Vec<char>, Vec<char>) = if cfg!(windows) {
        (pattern.to_lowercase().chars().collect(), name.to_lowercase().chars().collect())
    } else {
        (pattern.chars().collect(), name.chars().collect())
    };
    let mut memo = BTreeMap::new();
    glob_chars(&pattern, &name, 0, 0, &mut memo)
}

fn glob_chars(p: &[char], n: &[char], i: usize, j: usize, memo: &mut BTreeMap<(usize, usize), bool>) -> bool {
    if let Some(known) = memo.get(&(i, j)) {
        return *known;
    }
    let result = if i == p.len() {
        j == n.len()
    } else {
        match p[i] {
            '*' => glob_chars(p, n, i + 1, j, memo) || (j < n.len() && glob_chars(p, n, i, j + 1, memo)),
            '?' => j < n.len() && glob_chars(p, n, i + 1, j + 1, memo),
            '[' => match class(p, i) {
                Some((end, set)) => j < n.len() && set(n[j]) && glob_chars(p, n, end, j + 1, memo),
                None => j < n.len() && n[j] == '[' && glob_chars(p, n, i + 1, j + 1, memo),
            },
            c => j < n.len() && n[j] == c && glob_chars(p, n, i + 1, j + 1, memo),
        }
    };
    memo.insert((i, j), result);
    result
}

/// The set `[...]` starting at `p[start]`: where it ends, and what it
/// takes. `None` when it never closes, so the `[` is a plain character.
#[allow(clippy::type_complexity)]
fn class(p: &[char], start: usize) -> Option<(usize, Box<dyn Fn(char) -> bool>)> {
    let mut i = start + 1;
    let negated = i < p.len() && (p[i] == '!' || p[i] == '^');
    if negated {
        i += 1;
    }
    let mut ranges = Vec::new();
    let mut first = true;
    while i < p.len() {
        if p[i] == ']' && !first {
            return Some((i + 1, Box::new(move |c| ranges.iter().any(|&(lo, hi)| lo <= c && c <= hi) != negated)));
        }
        first = false;
        if i + 2 < p.len() && p[i + 1] == '-' && p[i + 2] != ']' {
            ranges.push((p[i], p[i + 2]));
            i += 3;
        } else {
            ranges.push((p[i], p[i]));
            i += 1;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(files: &[&str]) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("g1t-glob-test-{}-{}", std::process::id(), super::super::rand_id()));
        for file in files {
            let path = dir.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, file).unwrap();
        }
        let text = separators(&dir.display().to_string());
        (dir, text)
    }

    fn names(found: &Found) -> Vec<&str> {
        found.files.iter().map(|(name, _)| name.as_str()).collect()
    }

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(str::to_owned).collect()
    }

    #[test]
    fn parts_match_stars_marks_and_sets() {
        assert!(matches_part("*.txt", "a.txt"));
        assert!(matches_part("*.txt", ".hidden.txt"));
        assert!(!matches_part("*.txt", "a.txt.bak"));
        assert!(matches_part("a?c", "abc"));
        assert!(!matches_part("a?c", "ac"));
        assert!(matches_part("[abc]x", "bx"));
        assert!(!matches_part("[!abc]x", "bx"));
        assert!(matches_part("[^abc]x", "dx"));
        assert!(matches_part("v[0-9]", "v7"));
        assert!(!matches_part("v[0-9]", "vx"));
        assert!(matches_part("[]]", "]"));
        assert!(matches_part("a[b", "a[b"));
        assert!(matches_part("a**b", "axyzb"));
    }

    #[test]
    fn globstar_reaches_any_depth() {
        assert!(matches("/w/**/*.rs", "/w/main.rs"));
        assert!(matches("/w/**/*.rs", "/w/a/b/c.rs"));
        assert!(!matches("/w/**/*.rs", "/x/a.rs"));
        assert!(matches("/w/*/x", "/w/a/x"));
        assert!(!matches("/w/*/x", "/w/a/b/x"));
        assert!(matches("/w/**", "/w/a/b"));
    }

    #[test]
    fn lines_resolve_against_the_workspace_and_home() {
        assert_eq!(resolve("dist/", "/w/repo", "/home/u"), "/w/repo/dist");
        assert_eq!(resolve("./a/../b/*.txt", "/w/repo/", "/home/u"), "/w/repo/b/*.txt");
        assert_eq!(resolve("~/out", "/w", "/home/u"), "/home/u/out");
        assert_eq!(resolve("~", "/w", "/home/u"), "/home/u");
        assert_eq!(resolve("/abs/x", "/w", "/home/u"), "/abs/x");
        assert_eq!(resolve("../other", "/w/repo", "/h"), "/w/other");
    }

    #[test]
    #[cfg(windows)]
    fn windows_paths_take_either_separator_and_any_case() {
        assert_eq!(resolve("dist\\out", "C:\\w\\repo", "C:\\Users\\u"), "C:/w/repo/dist/out");
        assert_eq!(resolve("D:\\x\\*.txt", "C:\\w", "C:\\h"), "D:/x/*.txt");
        assert!(matches("C:/w/*.TXT", "c:/W/a.txt"));
        assert_eq!(search_path("C:/w/**/*.txt"), "C:/w");
    }

    #[test]
    fn search_paths_stop_before_the_first_glob() {
        assert_eq!(search_path("/w/dist/**/*.js"), "/w/dist");
        assert_eq!(search_path("/w/dist/a.txt"), "/w/dist/a.txt");
        assert_eq!(search_path("/w/d?st/a"), "/w");
        assert_eq!(search_path("/*.txt"), "/");
    }

    #[test]
    fn the_root_is_picked_as_upload_artifact_does() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        // One file named: its folder.
        assert_eq!(root_dir(&s(&["/w/dist/a.txt"]), &s(&["/w/dist/a.txt"])).unwrap(), "/w/dist");
        // One folder, or one glob: the search path.
        assert_eq!(root_dir(&s(&["/w/dist"]), &s(&["/w/dist/a.txt"])).unwrap(), "/w/dist");
        assert_eq!(root_dir(&s(&["/w/dist"]), &s(&["/w/dist/a", "/w/dist/b"])).unwrap(), "/w/dist");
        // Several: what they have in common.
        assert_eq!(root_dir(&s(&["/w/a/x.txt", "/w/b/c"]), &s(&["/w/a/x.txt", "/w/b/c/y"])).unwrap(), "/w");
        assert_eq!(root_dir(&s(&["/w/a", "/w/a/sub"]), &[]).unwrap(), "/w/a");
        assert_eq!(root_dir(&s(&["/a", "/b"]), &[]).unwrap(), "/");
        assert!(root_dir(&[], &[]).is_none());
    }

    #[test]
    fn finding_files_takes_folders_globs_and_exclusions() {
        let (dir, w) = tree(&["dist/a.js", "dist/sub/b.js", "dist/sub/c.map", "dist/.env", "dist/.cache/x", "src/main.rs", "README.md", ".hidden/y"]);
        let found = find(&lines("dist"), &w, "/h", false);
        assert_eq!(found.root, format!("{w}/dist"));
        assert_eq!(names(&found), ["a.js", "sub/b.js", "sub/c.map"]);

        let found = find(&lines("dist\n!dist/**/*.map"), &w, "/h", false);
        assert_eq!(names(&found), ["a.js", "sub/b.js"]);
        // Leaving a folder out leaves out what is in it.
        let found = find(&lines("dist\n!dist/sub"), &w, "/h", false);
        assert_eq!(names(&found), ["a.js"]);

        let found = find(&lines("dist"), &w, "/h", true);
        assert!(names(&found).contains(&".env") && names(&found).contains(&".cache/x"));

        let found = find(&lines("**/*.js"), &w, "/h", false);
        assert_eq!(found.root, w);
        assert_eq!(names(&found), ["dist/a.js", "dist/sub/b.js"]);

        // Stored relative to the search path, the part before the glob.
        let found = find(&lines("dist/s?b/[bc].*"), &w, "/h", false);
        assert_eq!(found.root, format!("{w}/dist"));
        assert_eq!(names(&found), ["sub/b.js", "sub/c.map"]);

        // A glob matching a folder takes what is in it.
        let found = find(&lines("d*"), &w, "/h", false);
        assert_eq!(names(&found), ["dist/a.js", "dist/sub/b.js", "dist/sub/c.map"]);

        let found = find(&lines("README.md"), &w, "/h", false);
        assert_eq!(found.root, w);
        assert_eq!(names(&found), ["README.md"]);

        let found = find(&lines("README.md\nsrc/"), &w, "/h", false);
        assert_eq!(names(&found), ["README.md", "src/main.rs"]);

        // A hidden path named outright is taken.
        let found = find(&lines(".hidden"), &w, "/h", false);
        assert_eq!(names(&found), ["y"]);
        let found = find(&lines("dist/.env"), &w, "/h", false);
        assert_eq!(names(&found), [".env"]);

        assert!(find(&lines("nothing/*"), &w, "/h", false).files.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
