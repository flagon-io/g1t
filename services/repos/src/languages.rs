//! Which language each file is written in, and which files count towards a
//! repository's languages: a small version of what people know from the
//! language bar on code hosts. Programming and markup languages count;
//! data (JSON, YAML) and prose (Markdown) do not, unless `.gitattributes`
//! says `linguist-detectable`. Vendored, generated and documentation files
//! never count, unless `.gitattributes` says otherwise:
//!
//! ```text
//! third_party/** -linguist-vendored
//! *.gen.ts linguist-generated
//! docs/** -linguist-documentation
//! *.inc linguist-language=PHP
//! *.sql linguist-detectable
//! ```

use g1t_contracts::about::LanguageShare;

/// What a language is, as it decides whether it counts by default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Programming,
    Markup,
    Data,
    Prose,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Language {
    pub name: &'static str,
    pub color: Option<&'static str>,
    pub kind: Kind,
}

const fn lang(name: &'static str, color: &'static str, kind: Kind) -> Language {
    Language { name, color: Some(color), kind }
}

use Kind::{Data, Markup, Programming, Prose};

/// Every language g1t knows, with the colors people know them by.
pub static LANGUAGES: &[Language] = &[
    lang("Assembly", "#6E4C13", Programming),
    lang("Astro", "#ff5a03", Markup),
    lang("Batchfile", "#C1F12E", Programming),
    lang("Blade", "#f7523f", Markup),
    lang("C", "#555555", Programming),
    lang("C#", "#178600", Programming),
    lang("C++", "#f34b7d", Programming),
    lang("Clojure", "#db5855", Programming),
    lang("CMake", "#DA3434", Programming),
    lang("Common Lisp", "#3fb68b", Programming),
    lang("Crystal", "#000100", Programming),
    lang("CSS", "#663399", Markup),
    lang("Cuda", "#3A4E3A", Programming),
    lang("Dart", "#00B4AB", Programming),
    lang("Dockerfile", "#384d54", Programming),
    lang("EJS", "#a91e50", Markup),
    lang("Elixir", "#6e4a7e", Programming),
    lang("Elm", "#60B5CC", Programming),
    lang("Emacs Lisp", "#c065db", Programming),
    lang("Erlang", "#B83998", Programming),
    lang("F#", "#b845fc", Programming),
    lang("Fortran", "#4d41b1", Programming),
    lang("Gleam", "#ffaff3", Programming),
    lang("GLSL", "#5686a5", Programming),
    lang("Go", "#00ADD8", Programming),
    lang("GraphQL", "#e10098", Data),
    lang("Groovy", "#4298b8", Programming),
    lang("Handlebars", "#f7931e", Markup),
    lang("Haskell", "#5e5086", Programming),
    lang("HCL", "#844FBA", Programming),
    lang("HTML", "#e34c26", Markup),
    lang("Java", "#b07219", Programming),
    lang("JavaScript", "#f1e05a", Programming),
    lang("JSON", "#292929", Data),
    lang("Jsonnet", "#0064bd", Programming),
    lang("Julia", "#a270ba", Programming),
    lang("Jupyter Notebook", "#DA5B0B", Markup),
    lang("Kotlin", "#A97BFF", Programming),
    lang("Less", "#1d365d", Markup),
    lang("Liquid", "#67b8de", Markup),
    lang("Lua", "#000080", Programming),
    lang("Makefile", "#427819", Programming),
    lang("Markdown", "#083fa1", Prose),
    lang("MDX", "#fcb32c", Markup),
    lang("Nim", "#ffc200", Programming),
    lang("Nix", "#7e7eff", Programming),
    lang("Objective-C", "#438eff", Programming),
    lang("Objective-C++", "#6866fb", Programming),
    lang("OCaml", "#ef7a08", Programming),
    lang("Perl", "#0298c3", Programming),
    lang("PHP", "#4F5D95", Programming),
    lang("PLpgSQL", "#336790", Programming),
    lang("PowerShell", "#012456", Programming),
    lang("Pug", "#a86454", Markup),
    lang("Python", "#3572A5", Programming),
    lang("R", "#198CE7", Programming),
    lang("Racket", "#3c5caa", Programming),
    lang("Ruby", "#701516", Programming),
    lang("Rust", "#dea584", Programming),
    lang("Sass", "#a53b70", Markup),
    lang("Scala", "#c22d40", Programming),
    lang("Scheme", "#1e4aff", Programming),
    lang("SCSS", "#c6538c", Markup),
    lang("Shell", "#89e051", Programming),
    lang("Solidity", "#AA6746", Programming),
    lang("SQL", "#e38c00", Data),
    lang("Starlark", "#76d275", Programming),
    lang("Stylus", "#ff6347", Markup),
    lang("Svelte", "#ff3e00", Markup),
    lang("Swift", "#F05138", Programming),
    lang("TOML", "#9c4221", Data),
    lang("TSX", "#3178c6", Programming),
    lang("Twig", "#c1d026", Markup),
    lang("TypeScript", "#3178c6", Programming),
    lang("Vim Script", "#199f4b", Programming),
    lang("Visual Basic .NET", "#945db7", Programming),
    lang("Vue", "#41b883", Markup),
    lang("WebAssembly", "#04133b", Programming),
    lang("XML", "#0060ac", Data),
    lang("YAML", "#cb171e", Data),
    lang("Zig", "#ec915c", Programming),
];

/// A language by name, any case.
pub fn named(name: &str) -> Option<&'static Language> {
    LANGUAGES.iter().find(|language| language.name.eq_ignore_ascii_case(name))
}

/// Files known by their whole name.
fn by_filename(name: &str) -> Option<&'static str> {
    Some(match name {
        "Dockerfile" | "Containerfile" => "Dockerfile",
        "Makefile" | "GNUmakefile" | "makefile" => "Makefile",
        "CMakeLists.txt" => "CMake",
        "Rakefile" | "Gemfile" | "Vagrantfile" | "Podfile" | "Brewfile" => "Ruby",
        "Jenkinsfile" => "Groovy",
        "BUILD" | "BUILD.bazel" | "WORKSPACE" | "WORKSPACE.bazel" | "Tiltfile" => "Starlark",
        _ if name.starts_with("Dockerfile.") => "Dockerfile",
        _ => return None,
    })
}

/// Files known by their extension, lowercased, without the dot.
fn by_extension(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "asm" | "s" | "nasm" => "Assembly",
        "astro" => "Astro",
        "bat" | "cmd" => "Batchfile",
        "c" | "h" => "C",
        "cs" | "csx" => "C#",
        "cc" | "cpp" | "cxx" | "c++" | "hpp" | "hh" | "hxx" | "h++" | "ipp" | "tpp" => "C++",
        "clj" | "cljs" | "cljc" => "Clojure",
        "cmake" => "CMake",
        "lisp" | "lsp" => "Common Lisp",
        "cr" => "Crystal",
        "css" => "CSS",
        "cu" | "cuh" => "Cuda",
        "dart" => "Dart",
        "dockerfile" => "Dockerfile",
        "ejs" => "EJS",
        "ex" | "exs" => "Elixir",
        "elm" => "Elm",
        "el" => "Emacs Lisp",
        "erl" | "hrl" => "Erlang",
        "fs" | "fsi" | "fsx" => "F#",
        "f" | "f77" | "f90" | "f95" | "f03" | "for" => "Fortran",
        "gleam" => "Gleam",
        "glsl" | "vert" | "frag" | "geom" | "comp" => "GLSL",
        "go" => "Go",
        "graphql" | "gql" | "graphqls" => "GraphQL",
        "groovy" | "gradle" | "gvy" => "Groovy",
        "hbs" | "handlebars" | "mustache" => "Handlebars",
        "hs" | "lhs" => "Haskell",
        "hcl" | "tf" | "tfvars" => "HCL",
        "html" | "htm" | "xhtml" => "HTML",
        "java" => "Java",
        "js" | "mjs" | "cjs" | "jsx" => "JavaScript",
        "json" | "jsonc" | "json5" => "JSON",
        "jsonnet" | "libsonnet" => "Jsonnet",
        "jl" => "Julia",
        "ipynb" => "Jupyter Notebook",
        "kt" | "kts" => "Kotlin",
        "less" => "Less",
        "liquid" => "Liquid",
        "lua" => "Lua",
        "mk" | "mak" => "Makefile",
        "md" | "markdown" | "mdown" => "Markdown",
        "mdx" => "MDX",
        "nim" | "nims" => "Nim",
        "nix" => "Nix",
        "m" => "Objective-C",
        "mm" => "Objective-C++",
        "ml" | "mli" => "OCaml",
        "pl" | "pm" => "Perl",
        "php" | "phtml" => "PHP",
        "pgsql" | "plpgsql" => "PLpgSQL",
        "ps1" | "psm1" | "psd1" => "PowerShell",
        "pug" | "jade" => "Pug",
        "py" | "pyi" | "pyw" => "Python",
        "r" => "R",
        "rkt" => "Racket",
        "rb" | "gemspec" | "rake" => "Ruby",
        "rs" => "Rust",
        "sass" => "Sass",
        "scala" | "sc" => "Scala",
        "scm" | "ss" => "Scheme",
        "scss" => "SCSS",
        "sh" | "bash" | "zsh" | "ksh" => "Shell",
        "sol" => "Solidity",
        "sql" => "SQL",
        "bzl" | "star" => "Starlark",
        "styl" => "Stylus",
        "svelte" => "Svelte",
        "swift" => "Swift",
        "toml" => "TOML",
        "tsx" => "TSX",
        "twig" => "Twig",
        "ts" | "mts" | "cts" => "TypeScript",
        "vim" => "Vim Script",
        "vb" => "Visual Basic .NET",
        "vue" => "Vue",
        "wat" | "wast" => "WebAssembly",
        "xml" | "xsd" | "xsl" | "plist" | "csproj" | "fsproj" | "vbproj" => "XML",
        "yml" | "yaml" => "YAML",
        "zig" => "Zig",
        _ => return None,
    })
}

/// The language of a file by its path, if g1t knows it.
pub fn language_of(path: &str) -> Option<&'static Language> {
    let name = path.rsplit('/').next().unwrap_or(path);
    if name.ends_with(".blade.php") {
        return named("Blade");
    }
    let found = by_filename(name).or_else(|| {
        let (stem, extension) = name.rsplit_once('.')?;
        if stem.is_empty() {
            return None;
        }
        by_extension(&extension.to_ascii_lowercase())
    })?;
    named(found)
}

/// Directories whose code someone else wrote.
const VENDORED_DIRS: &[&str] = &[
    "node_modules",
    "vendor",
    "vendors",
    "third_party",
    "third-party",
    "3rdparty",
    "bower_components",
    "jspm_packages",
    "Pods",
    "Carthage",
    "site-packages",
    "venv",
    "__pypackages__",
];

/// Directories that hold docs and examples.
const DOCUMENTATION_DIRS: &[&str] = &["docs", "doc", "documentation", "examples", "example", "samples"];

/// Directories of output that a build makes.
const GENERATED_DIRS: &[&str] = &["dist", "__generated__", "generated", "__pycache__", ".next", ".nuxt", ".svelte-kit"];

fn directories(path: &str) -> impl Iterator<Item = &str> {
    let mut parts: Vec<&str> = path.split('/').collect();
    parts.pop();
    parts.into_iter()
}

/// Whether a file is someone else's code kept in the repository, or the
/// configuration under a dot-directory (`.github`, `.vscode`).
pub fn vendored(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    directories(path).any(|dir| dir.starts_with('.') || VENDORED_DIRS.iter().any(|vendored| dir.eq_ignore_ascii_case(vendored)))
        || name.starts_with("jquery")
        || name.starts_with("bootstrap") && (name.ends_with(".js") || name.ends_with(".css"))
        || matches!(name.as_str(), "gradlew" | "gradlew.bat" | "mvnw" | "mvnw.cmd")
}

/// Whether a file was made by a tool rather than written: minified,
/// compiled from a schema, or a lockfile.
pub fn generated(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    directories(path).any(|dir| GENERATED_DIRS.iter().any(|generated| dir.eq_ignore_ascii_case(generated)))
        || [".min.js", ".min.css", ".min.mjs", ".map", ".pb.go", "_pb2.py", "_pb2_grpc.py", ".pb.cc", ".pb.h", ".g.dart", ".freezed.dart", ".designer.cs", ".lock"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
        || name.contains(".generated.")
        || matches!(name.as_str(), "package-lock.json" | "pnpm-lock.yaml" | "npm-shrinkwrap.json" | "go.sum" | "composer.lock")
}

/// Whether a file is documentation or an example.
pub fn documentation(path: &str) -> bool {
    directories(path).any(|dir| DOCUMENTATION_DIRS.iter().any(|docs| dir.eq_ignore_ascii_case(docs)))
}

/// What `.gitattributes` says of a path. Each is None when it says nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Said {
    pub vendored: Option<bool>,
    pub generated: Option<bool>,
    pub documentation: Option<bool>,
    pub detectable: Option<bool>,
    pub language: Option<String>,
}

/// The `linguist-*` lines of a `.gitattributes` file, in order: a later
/// line that matches wins, as in git.
#[derive(Clone, Debug, Default)]
pub struct Attributes {
    rules: Vec<(String, Said)>,
}

/// An attribute set (`attr`, `attr=true`), unset (`-attr`, `attr=false`) or
/// not this one.
fn switch(word: &str, attribute: &str) -> Option<bool> {
    if let Some(rest) = word.strip_prefix('-') {
        return (rest == attribute).then_some(false);
    }
    if word == attribute {
        return Some(true);
    }
    let (name, value) = word.split_once('=')?;
    (name == attribute).then_some(!matches!(value, "false" | "0"))
}

impl Attributes {
    pub fn parse(text: &str) -> Self {
        let mut rules = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut words = line.split_whitespace();
            let Some(pattern) = words.next() else { continue };
            let mut said = Said::default();
            for word in words {
                if let Some(on) = switch(word, "linguist-vendored") {
                    said.vendored = Some(on);
                } else if let Some(on) = switch(word, "linguist-generated") {
                    said.generated = Some(on);
                } else if let Some(on) = switch(word, "linguist-documentation") {
                    said.documentation = Some(on);
                } else if let Some(on) = switch(word, "linguist-detectable") {
                    said.detectable = Some(on);
                } else if let Some(name) = word.strip_prefix("linguist-language=") {
                    said.language = Some(name.replace("-", " "));
                }
            }
            if said != Said::default() {
                rules.push((pattern.to_owned(), said));
            }
        }
        Attributes { rules }
    }

    /// What the file's matching lines say, the later over the earlier.
    pub fn of(&self, path: &str) -> Said {
        let mut said = Said::default();
        for (pattern, rule) in &self.rules {
            if !g1t_rules::glob::path_matches(pattern, path) {
                continue;
            }
            said.vendored = rule.vendored.or(said.vendored);
            said.generated = rule.generated.or(said.generated);
            said.documentation = rule.documentation.or(said.documentation);
            said.detectable = rule.detectable.or(said.detectable);
            if rule.language.is_some() {
                said.language = rule.language.clone();
            }
        }
        said
    }
}

/// The language a file counts towards, or None when it does not count.
pub fn counted(path: &str, attributes: &Attributes) -> Option<&'static Language> {
    let said = attributes.of(path);
    let language = match &said.language {
        Some(name) => named(name).or_else(|| language_of(path))?,
        None => language_of(path)?,
    };
    if said.vendored.unwrap_or_else(|| vendored(path))
        || said.generated.unwrap_or_else(|| generated(path))
        || said.documentation.unwrap_or_else(|| documentation(path))
    {
        return None;
    }
    let detectable = said.detectable.unwrap_or(matches!(language.kind, Kind::Programming | Kind::Markup));
    detectable.then_some(language)
}

/// Each language's share of the bytes, largest first, to one decimal place.
pub fn shares(bytes: impl IntoIterator<Item = (&'static Language, u64)>) -> Vec<LanguageShare> {
    let mut by_language: Vec<(&'static Language, u64)> = Vec::new();
    for (language, size) in bytes {
        match by_language.iter_mut().find(|(known, _)| known.name == language.name) {
            Some((_, total)) => *total += size,
            None => by_language.push((language, size)),
        }
    }
    let total: u64 = by_language.iter().map(|(_, size)| size).sum();
    by_language.retain(|(_, size)| *size > 0);
    by_language.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.name.cmp(b.0.name)));
    by_language
        .into_iter()
        .map(|(language, size)| LanguageShare {
            name: language.name.to_owned(),
            color: language.color.map(str::to_owned),
            bytes: size,
            percent: if total == 0 { 0.0 } else { (size as f64 * 1000.0 / total as f64).round() / 10.0 },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(path: &str) -> Option<&'static str> {
        counted(path, &Attributes::default()).map(|language| language.name)
    }

    #[test]
    fn files_are_known_by_extension_and_name() {
        assert_eq!(name("src/main.rs"), Some("Rust"));
        assert_eq!(name("app/routes/home.tsx"), Some("TSX"));
        assert_eq!(name("lib/x.mts"), Some("TypeScript"));
        assert_eq!(name("Dockerfile"), Some("Dockerfile"));
        assert_eq!(name("deploy/Dockerfile.prod"), Some("Dockerfile"));
        assert_eq!(name("Makefile"), Some("Makefile"));
        assert_eq!(name("resources/views/home.blade.php"), Some("Blade"));
        assert_eq!(name("SCRIPT.SH"), Some("Shell"));
        assert_eq!(name(".bashrc"), None, "a dotfile has no extension");
        assert_eq!(name("LICENSE"), None);
    }

    #[test]
    fn data_prose_vendored_generated_and_docs_do_not_count() {
        assert_eq!(name("package.json"), None);
        assert_eq!(name("README.md"), None);
        assert_eq!(name("config.yml"), None);
        assert_eq!(name("node_modules/react/index.js"), None);
        assert_eq!(name("web/vendor/lib.go"), None);
        assert_eq!(name("static/jquery-3.7.1.js"), None);
        assert_eq!(name("public/app.min.js"), None);
        assert_eq!(name("dist/index.js"), None);
        assert_eq!(name("api/v1/service.pb.go"), None);
        assert_eq!(name("docs/src/plugin.ts"), None);
        assert_eq!(name("examples/hello.rs"), None);
        assert_eq!(name(".github/scripts/release.sh"), None);
        assert_eq!(name("tests/it.rs"), Some("Rust"), "tests count");
    }

    #[test]
    fn gitattributes_overrides_what_is_counted() {
        let attributes = Attributes::parse(
            "# ours\n\
             vendor/** -linguist-vendored\n\
             *.gen.ts linguist-generated=true\n\
             docs/** linguist-documentation=false\n\
             *.inc linguist-language=PHP\n\
             *.sql linguist-detectable\n\
             src/legacy/*.js -linguist-detectable\n",
        );
        let of = |path: &str| counted(path, &attributes).map(|language| language.name);
        assert_eq!(of("vendor/ours.go"), Some("Go"));
        assert_eq!(of("src/api.gen.ts"), None);
        assert_eq!(of("docs/site.ts"), Some("TypeScript"));
        assert_eq!(of("lib/header.inc"), Some("PHP"));
        assert_eq!(of("db/schema.sql"), Some("SQL"));
        assert_eq!(of("src/legacy/old.js"), None);
        assert_eq!(of("src/new.js"), Some("JavaScript"));
    }

    #[test]
    fn a_later_line_wins() {
        let attributes = Attributes::parse("*.js linguist-vendored\nsrc/*.js -linguist-vendored\n");
        assert_eq!(attributes.of("src/a.js").vendored, Some(false));
        assert_eq!(attributes.of("lib/a.js").vendored, Some(true));
    }

    #[test]
    fn shares_add_up_by_language() {
        let rust = named("Rust").unwrap();
        let ts = named("TypeScript").unwrap();
        let shares = shares([(rust, 600), (ts, 300), (rust, 100), (ts, 0)]);
        assert_eq!(shares.len(), 2);
        assert_eq!(shares[0].name, "Rust");
        assert_eq!(shares[0].bytes, 700);
        assert_eq!(shares[0].percent, 70.0);
        assert_eq!(shares[1].percent, 30.0);
        assert_eq!(shares[0].color.as_deref(), Some("#dea584"));
        assert!(super::shares(Vec::new()).is_empty());
    }

    #[test]
    fn every_extension_names_a_known_language() {
        let one_of_each = "asm astro bat c cs cpp clj cmake lisp cr css cu dart dockerfile ejs ex elm el erl fs f90 gleam glsl go graphql \
            groovy hbs hs tf html java js json jsonnet jl ipynb kt less liquid lua mk md mdx nim nix m mm ml pl php pgsql ps1 pug py r \
            rkt rb rs sass scala scm scss sh sol sql bzl styl svelte swift toml tsx twig ts vim vb vue wat xml yml zig";
        for extension in one_of_each.split_whitespace() {
            assert!(language_of(&format!("a.{extension}")).is_some(), "{extension}");
        }
        for name in ["Dockerfile", "Makefile", "CMakeLists.txt", "Gemfile", "Jenkinsfile", "BUILD.bazel", "x.blade.php"] {
            assert!(language_of(name).is_some(), "{name}");
        }
        for path in ["a.asm", "a.tsx", "a.ipynb", "a.vue", "a.ex", "a.hcl", "a.sol", "a.zig", "a.wat", "a.bzl", "a.vb", "a.pgsql"] {
            assert!(language_of(path).is_some(), "{path}");
        }
        let mut names: Vec<&str> = LANGUAGES.iter().map(|language| language.name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), LANGUAGES.len(), "each language once");
    }
}
