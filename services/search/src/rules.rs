//! What gets indexed, and how: which files are skipped, what language a
//! file is in, and how a file is cut into pieces for the index. Pure, so
//! the rules are tested apart from the store.

/// Files larger than this are not indexed.
pub const MAX_FILE_BYTES: u32 = 512 * 1024;
/// Lines in one piece of a file, at most.
pub const CHUNK_LINES: usize = 120;
/// Bytes in one piece of a file, at most; a longer line is a piece of its own.
pub const CHUNK_BYTES: usize = 16 * 1024;

/// Directories never read: other people's code and what a build makes.
/// Matched by name at any depth.
pub const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "bower_components",
    "jspm_packages",
    "vendor",
    "vendored",
    "third_party",
    "third-party",
    "Pods",
    "Carthage",
    ".yarn",
    ".pnpm-store",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".output",
    ".turbo",
    ".wrangler",
    "dist",
    "target",
    "coverage",
];

/// Lockfiles: long, generated, and never what anyone searches for.
const LOCKFILES: &[&str] = &[
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "bun.lock",
    "deno.lock",
    "cargo.lock",
    "gemfile.lock",
    "poetry.lock",
    "pipfile.lock",
    "uv.lock",
    "pdm.lock",
    "composer.lock",
    "go.sum",
    "go.work.sum",
    "flake.lock",
    "mix.lock",
    "pubspec.lock",
    "podfile.lock",
    "package.resolved",
    "packages.lock.json",
    "gradle.lockfile",
    "conan.lock",
];

/// Extensions of files that are not text, or not worth reading as text.
const BINARY: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "icns", "bmp", "tif", "tiff", "psd", "ai", "sketch", "fig",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "key", "numbers", "pages", "zip", "gz", "tgz", "bz2", "xz",
    "zst", "7z", "rar", "tar", "jar", "war", "ear", "class", "o", "obj", "a", "lib", "so", "dylib", "dll", "exe",
    "bin", "dat", "wasm", "pyc", "pyo", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "m4a", "mov", "avi",
    "wav", "flac", "ogg", "webm", "mkv", "sqlite", "sqlite3", "db", "parquet", "arrow", "pb", "onnx", "pt", "ckpt",
    "safetensors", "npy", "npz", "glb", "gltf", "fbx", "blend", "iso", "dmg", "img", "deb", "rpm", "apk", "ipa",
];

/// Why a file is not indexed, judged by its path alone, or `None` to read it.
pub fn skip_path(path: &str) -> Option<&'static str> {
    let mut parts = path.split('/').collect::<Vec<_>>();
    let name = parts.pop().unwrap_or_default();
    if parts.iter().any(|dir| SKIP_DIRS.iter().any(|skip| skip.eq_ignore_ascii_case(dir))) {
        return Some("vendored");
    }
    let lower = name.to_lowercase();
    if LOCKFILES.contains(&lower.as_str()) || lower.ends_with(".lock") || lower.ends_with(".lockb") {
        return Some("lockfile");
    }
    if let Some((_, extension)) = lower.rsplit_once('.')
        && BINARY.contains(&extension)
    {
        return Some("binary");
    }
    if lower.ends_with(".min.js")
        || lower.ends_with(".min.css")
        || lower.ends_with(".min.mjs")
        || lower.ends_with(".map")
        || lower.ends_with(".bundle.js")
    {
        return Some("minified");
    }
    if lower == ".ds_store" || lower == "thumbs.db" {
        return Some("binary");
    }
    None
}

/// Why a file's text is not indexed, or `None` to index it: too large, or
/// minified (some line far longer than code is written).
pub fn skip_text(text: &str) -> Option<&'static str> {
    if text.len() > MAX_FILE_BYTES as usize {
        return Some("too large");
    }
    if text.len() > 16 * 1024 && text.lines().any(|line| line.len() > 4096) {
        return Some("minified");
    }
    None
}

/// The language a file is written in, by its name. Names are as people
/// write them in `language:` (`rust`, `typescript`), lowercase.
pub fn language(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    let by_name = match name.as_str() {
        "dockerfile" | "containerfile" => Some("dockerfile"),
        "makefile" | "gnumakefile" => Some("makefile"),
        "cmakelists.txt" => Some("cmake"),
        "gemfile" | "rakefile" => Some("ruby"),
        "justfile" => Some("just"),
        _ => None,
    };
    if by_name.is_some() {
        return by_name;
    }
    if name.starts_with("dockerfile.") {
        return Some("dockerfile");
    }
    let extension = name.rsplit_once('.').map(|(_, extension)| extension)?;
    Some(match extension {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "py" | "pyi" => "python",
        "go" => "go",
        "rb" => "ruby",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "scala" => "scala",
        "swift" => "swift",
        "m" | "mm" => "objective-c",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => "c++",
        "cs" => "c#",
        "fs" | "fsx" => "f#",
        "php" => "php",
        "pl" | "pm" => "perl",
        "lua" => "lua",
        "r" => "r",
        "jl" => "julia",
        "ex" | "exs" => "elixir",
        "erl" | "hrl" => "erlang",
        "hs" => "haskell",
        "ml" | "mli" => "ocaml",
        "clj" | "cljs" | "cljc" | "edn" => "clojure",
        "dart" => "dart",
        "zig" => "zig",
        "nim" => "nim",
        "v" => "v",
        "sol" => "solidity",
        "sh" | "bash" | "zsh" => "shell",
        "fish" => "fish",
        "ps1" | "psm1" => "powershell",
        "sql" => "sql",
        "graphql" | "gql" => "graphql",
        "proto" => "protobuf",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" | "sass" => "scss",
        "less" => "less",
        "vue" => "vue",
        "svelte" => "svelte",
        "astro" => "astro",
        "md" | "markdown" => "markdown",
        "mdx" => "mdx",
        "rst" => "restructuredtext",
        "txt" => "text",
        "json" | "jsonc" | "json5" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" | "svg" => "xml",
        "ini" | "cfg" => "ini",
        "tf" | "hcl" => "hcl",
        "nix" => "nix",
        "tex" => "tex",
        "wgsl" => "wgsl",
        "glsl" | "vert" | "frag" => "glsl",
        _ => return None,
    })
}

/// Languages that are prose or data rather than code, which do not count
/// when saying what language a repository is written in.
pub const DATA_LANGUAGES: &[&str] =
    &["markdown", "mdx", "restructuredtext", "text", "json", "yaml", "toml", "xml", "ini", "html", "css"];

/// The language a `language:` qualifier names, as [`language`] writes it:
/// `ts` is `typescript`, `cpp` is `c++`, `js` is `javascript`.
pub fn normalize_language(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    match lower.as_str() {
        "ts" => "typescript",
        "js" => "javascript",
        "py" => "python",
        "rb" => "ruby",
        "rs" => "rust",
        "golang" => "go",
        "cpp" | "cxx" => "c++",
        "csharp" | "cs" => "c#",
        "fsharp" => "f#",
        "objc" | "objectivec" => "objective-c",
        "bash" | "sh" | "zsh" => "shell",
        "yml" => "yaml",
        "md" => "markdown",
        "kt" => "kotlin",
        other => return other.to_owned(),
    }
    .to_owned()
}

/// A file cut into pieces for the index: each with the number of its first
/// line (from 1) and its text, at most [`CHUNK_LINES`] lines and, unless one
/// line is longer, [`CHUNK_BYTES`] bytes.
pub fn chunks(text: &str) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut start = 1u32;
    let mut lines = 0usize;
    for (index, line) in text.split_inclusive('\n').enumerate() {
        if lines > 0 && (lines >= CHUNK_LINES || current.len() + line.len() > CHUNK_BYTES) {
            out.push((start, std::mem::take(&mut current)));
            start = index as u32 + 1;
            lines = 0;
        }
        current.push_str(line);
        lines += 1;
    }
    if !current.is_empty() {
        out.push((start, current));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendored_directories_are_skipped_at_any_depth() {
        assert_eq!(skip_path("node_modules/react/index.js"), Some("vendored"));
        assert_eq!(skip_path("apps/web/node_modules/x/y.ts"), Some("vendored"));
        assert_eq!(skip_path("crates/foo/vendor/lib.c"), Some("vendored"));
        assert_eq!(skip_path("target/release/build.rs"), Some("vendored"));
        // A file named like a skipped directory is still read.
        assert_eq!(skip_path("src/vendor.rs"), None);
        assert_eq!(skip_path("src/dist.ts"), None);
    }

    #[test]
    fn lockfiles_are_skipped() {
        for path in ["package-lock.json", "web/yarn.lock", "Cargo.lock", "go.sum", "pnpm-lock.yaml", "x/flake.lock", "bun.lockb"] {
            assert_eq!(skip_path(path), Some("lockfile"), "{path}");
        }
        assert_eq!(skip_path("Cargo.toml"), None);
        assert_eq!(skip_path("package.json"), None);
    }

    #[test]
    fn binaries_and_minified_files_are_skipped() {
        assert_eq!(skip_path("public/logo.PNG"), Some("binary"));
        assert_eq!(skip_path("fonts/inter.woff2"), Some("binary"));
        assert_eq!(skip_path("build/app.wasm"), Some("binary"));
        assert_eq!(skip_path("static/app.min.js"), Some("minified"));
        assert_eq!(skip_path("static/app.js.map"), Some("minified"));
        assert_eq!(skip_path("src/main.rs"), None);
        assert_eq!(skip_path("Makefile"), None);
    }

    #[test]
    fn large_and_minified_text_is_skipped() {
        assert_eq!(skip_text("fn main() {}\n"), None);
        let big = "a\n".repeat(300 * 1024);
        assert_eq!(skip_text(&big), Some("too large"));
        let one_line = "x".repeat(20 * 1024);
        assert_eq!(skip_text(&one_line), Some("minified"));
        // Exactly the limit is kept.
        let edge = "a".repeat(MAX_FILE_BYTES as usize - 1) + "\n";
        assert_eq!(skip_text(&edge), Some("minified"));
        let edge_lines = "abcdefg\n".repeat(MAX_FILE_BYTES as usize / 8);
        assert_eq!(skip_text(&edge_lines), None);
    }

    #[test]
    fn languages_come_from_names() {
        assert_eq!(language("src/main.rs"), Some("rust"));
        assert_eq!(language("app/routes/x.tsx"), Some("tsx"));
        assert_eq!(language("Dockerfile"), Some("dockerfile"));
        assert_eq!(language("docs/README.md"), Some("markdown"));
        assert_eq!(language("LICENSE"), None);
        assert_eq!(normalize_language("TS"), "typescript");
        assert_eq!(normalize_language("cpp"), "c++");
        assert_eq!(normalize_language("Rust"), "rust");
    }

    #[test]
    fn chunks_keep_line_numbers() {
        let text: String = (1..=250).map(|n| format!("line {n}\n")).collect();
        let pieces = chunks(&text);
        assert_eq!(pieces.iter().map(|(start, _)| *start).collect::<Vec<_>>(), vec![1, 121, 241]);
        assert!(pieces[1].1.starts_with("line 121\n"));
        assert_eq!(pieces.iter().map(|(_, text)| text.as_str()).collect::<String>(), text);
    }

    #[test]
    fn chunks_stay_under_their_size() {
        let line = format!("{}\n", "y".repeat(1000));
        let text = line.repeat(40);
        let pieces = chunks(&text);
        assert!(pieces.iter().all(|(_, piece)| piece.len() <= CHUNK_BYTES));
        assert_eq!(pieces[1].0, 17);
    }
}
