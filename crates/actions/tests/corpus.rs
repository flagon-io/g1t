//! Workflows as people write them for GitHub (`tests/corpus/valid`), each
//! of which g1t reads, and workflows GitHub refuses
//! (`tests/corpus/invalid`), each of which g1t refuses too, with the
//! problem its first line names (`# error: ...`). Every file was written
//! for this test; the refused ones follow the cases in GitHub's own parser
//! tests (actions/languageservices, `workflow-parser/testdata/reader`).

use std::path::{Path, PathBuf};

use g1t_actions::workflow;

fn files(kind: &str) -> Vec<(String, String)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus").join(kind);
    let mut files: Vec<(String, String)> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("yml"))
        .map(|path: PathBuf| (name(&path), std::fs::read_to_string(&path).unwrap()))
        .collect();
    files.sort();
    files
}

fn name(path: &Path) -> String {
    path.file_name().unwrap().to_string_lossy().into_owned()
}

#[test]
fn every_github_workflow_reads() {
    let files = files("valid");
    assert!(files.len() >= 40, "{}", files.len());
    let mut problems = Vec::new();
    for (name, source) in &files {
        if let Err(problem) = workflow::parse(source) {
            problems.push(format!("{name}: {problem}"));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn what_github_refuses_is_refused() {
    let files = files("invalid");
    assert!(files.len() >= 40, "{}", files.len());
    let mut problems = Vec::new();
    for (name, source) in &files {
        let expected = source
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("# error: "))
            .unwrap_or_else(|| panic!("{name}: its first line is `# error: <what the problem says>`"));
        match workflow::parse(source) {
            Ok(_) => problems.push(format!("{name}: reads, and should not")),
            Err(problem) if !problem.contains(expected) => problems.push(format!("{name}: says {problem:?}, not {expected:?}")),
            Err(_) => {}
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}
