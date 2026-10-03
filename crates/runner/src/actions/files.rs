//! The files a step writes to talk back (`GITHUB_OUTPUT`, `GITHUB_ENV`,
//! `GITHUB_PATH`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY`), and `hashFiles`.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use g1t_actions::filter::Patterns;
use sha2::{Digest, Sha256};

/// `name=value` lines and `name<<DELIMITER` … `DELIMITER` blocks.
pub(crate) fn key_values(text: &str) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.trim().is_empty() {
            continue;
        }
        let heredoc = line.find("<<");
        let equals = line.find('=');
        match (heredoc, equals) {
            (Some(at), eq) if eq.is_none_or(|eq| at < eq) => {
                let name = line[..at].to_owned();
                let delimiter = &line[at + 2..];
                if name.is_empty() || delimiter.is_empty() {
                    return Err(format!("`{line}` is not a name and a delimiter."));
                }
                let mut value = Vec::new();
                let mut closed = false;
                for body in lines.by_ref() {
                    if body == delimiter {
                        closed = true;
                        break;
                    }
                    value.push(body);
                }
                if !closed {
                    return Err(format!("The value of `{name}` never reaches its delimiter `{delimiter}`."));
                }
                out.insert(name, value.join("\n"));
            }
            (_, Some(eq)) => {
                out.insert(line[..eq].to_owned(), line[eq + 1..].to_owned());
            }
            _ => return Err(format!("`{line}` is not `name=value`.")),
        }
    }
    Ok(out)
}

/// The files of one step, made empty before it runs.
pub(crate) struct StepFiles {
    pub(crate) output: PathBuf,
    pub(crate) env: PathBuf,
    pub(crate) path: PathBuf,
    pub(crate) state: PathBuf,
    pub(crate) summary: PathBuf,
}

impl StepFiles {
    pub(crate) fn new(temp: &Path, id: &str) -> std::io::Result<StepFiles> {
        let dir = temp.join("_runner_file_commands");
        std::fs::create_dir_all(&dir)?;
        let files = StepFiles {
            output: dir.join(format!("set_output_{id}")),
            env: dir.join(format!("set_env_{id}")),
            path: dir.join(format!("add_path_{id}")),
            state: dir.join(format!("save_state_{id}")),
            summary: dir.join(format!("step_summary_{id}")),
        };
        for file in [&files.output, &files.env, &files.path, &files.state, &files.summary] {
            std::fs::write(file, "")?;
        }
        Ok(files)
    }

    pub(crate) fn read(path: &Path) -> String {
        let mut text = String::new();
        if let Ok(mut file) = std::fs::File::open(path) {
            let _ = file.read_to_string(&mut text);
        }
        text
    }

    pub(crate) fn variables(&self) -> [(&'static str, String); 5] {
        [
            ("GITHUB_OUTPUT", self.output.display().to_string()),
            ("GITHUB_ENV", self.env.display().to_string()),
            ("GITHUB_PATH", self.path.display().to_string()),
            ("GITHUB_STATE", self.state.display().to_string()),
            ("GITHUB_STEP_SUMMARY", self.summary.display().to_string()),
        ]
    }
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if entry.file_name() == ".git" {
                continue;
            }
            walk(root, &path, out);
        } else if kind.is_file()
            && let Ok(relative) = path.strip_prefix(root)
        {
            out.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }
}

/// `hashFiles(patterns)`: the SHA-256 of the SHA-256 of each matching file
/// in the workspace, in path order; empty when nothing matches.
pub(crate) fn hash_files(workspace: &Path, patterns: &[String]) -> String {
    // Patterns may be absolute under the workspace, or relative to it.
    let prefix = format!("{}/", workspace.display());
    let relative: Vec<String> = patterns.iter().map(|p| p.strip_prefix(&prefix).unwrap_or(p).to_owned()).collect();
    let patterns = Patterns::new(&relative);
    let mut files = Vec::new();
    walk(workspace, workspace, &mut files);
    files.sort();
    let mut all = Sha256::new();
    let mut any = false;
    for file in files.iter().filter(|file| patterns.includes(file)) {
        let Ok(bytes) = std::fs::read(workspace.join(file)) else { continue };
        all.update(Sha256::digest(&bytes));
        any = true;
    }
    if any { hex::encode(all.finalize()) } else { String::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_and_heredocs() {
        let text = "version=1.2.3\nnotes<<EOF\nline one\nline=two\nEOF\nempty=\n";
        let values = key_values(text).unwrap();
        assert_eq!(values["version"], "1.2.3");
        assert_eq!(values["notes"], "line one\nline=two");
        assert_eq!(values["empty"], "");
        assert!(key_values("x<<EOF\nnever closed").is_err());
        assert!(key_values("no equals").is_err());
        // A value holding `<<` after its `=` is a plain value.
        assert_eq!(key_values("cmd=a << b").unwrap()["cmd"], "a << b");
    }

    #[test]
    fn hashes_files_by_pattern() {
        let dir = std::env::temp_dir().join(format!("g1t-hash-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::write(dir.join("a/package-lock.json"), "{}").unwrap();
        std::fs::write(dir.join("README.md"), "hi").unwrap();
        let one = hash_files(&dir, &["**/package-lock.json".to_owned()]);
        assert_eq!(one.len(), 64);
        assert_eq!(one, hash_files(&dir, &["**/package-lock.json".to_owned()]));
        assert_ne!(one, hash_files(&dir, &["**/*".to_owned()]));
        assert_eq!(hash_files(&dir, &["**/Cargo.lock".to_owned()]), "");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
