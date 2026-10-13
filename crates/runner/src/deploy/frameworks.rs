//! Which framework a project is built with, found from its package's
//! dependencies and its config files, and what that means for a g1t.page
//! build: the command that builds it, the folder its static site is written
//! to, or the Worker a Cloudflare adapter writes. Nothing here runs anything.
//!
//! g1t.page serves static sites and Workers, never a server that stays up,
//! so a framework set up to need one is reported with what to change.

use std::collections::BTreeSet;
use std::path::Path;

use regex::Regex;
use serde_json::{Map, Value};

/// Hugo, from the `hugo` on `PATH`, else Hugo's own release by npm.
const HUGO: &str = "if command -v hugo >/dev/null 2>&1; then hugo --minify; else npx --yes hugo-extended@0.166.0 --minify; fi";
/// mdBook, from the `mdbook` on `PATH`, else built by cargo.
const MDBOOK: &str = "if ! command -v mdbook >/dev/null 2>&1; then cargo install mdbook --version 0.5.4 --locked --quiet; fi && mdbook build";
/// Jekyll's gems, kept in the project rather than the system's Ruby.
const BUNDLE_INSTALL: &str = "bundle config set --local path vendor/bundle && bundle install";

/// The Worker a framework's Cloudflare adapter writes, for a project with no
/// Wrangler config of its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Adapter {
    /// The Worker's entry, relative to the project: a file, or a directory
    /// holding an `index.js`.
    pub entry: &'static str,
    /// The static files served beside it.
    pub assets: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Framework {
    /// Short and stable, as `g1t-runner detect` prints it: `astro`, `nextjs`…
    pub id: &'static str,
    /// For the build's log.
    pub name: &'static str,
    /// What installs what the package manager does not (Jekyll's gems).
    pub install: Option<&'static str>,
    /// What builds it, unless the project gives its own command.
    pub build: Option<String>,
    /// Where it writes its static site, relative to the project.
    pub output: Option<String>,
    /// Built for Workers: with a Wrangler config, `build` runs before
    /// wrangler bundles it.
    pub workers: bool,
    /// Without a Wrangler config, the Worker its adapter writes.
    pub adapter: Option<Adapter>,
    /// Why it cannot be served as it is set up, and what to change.
    pub problem: Option<String>,
}

impl Framework {
    fn new(id: &'static str, name: &'static str) -> Self {
        Framework { id, name, install: None, build: None, output: None, workers: false, adapter: None, problem: None }
    }

    fn static_site(mut self, build: String, output: impl Into<String>) -> Self {
        self.build = Some(build);
        self.output = Some(output.into());
        self
    }
}

/// `package.json`: what it depends on, and its scripts.
struct Package {
    dependencies: BTreeSet<String>,
    scripts: Map<String, Value>,
}

impl Package {
    fn read(dir: &Path) -> Option<Package> {
        let text = std::fs::read_to_string(dir.join("package.json")).ok()?;
        let package: Value = serde_json::from_str(&text).ok()?;
        let dependencies = ["dependencies", "devDependencies"]
            .iter()
            .filter_map(|field| package[field].as_object())
            .flat_map(|deps| deps.keys().cloned())
            .collect();
        let scripts = package["scripts"].as_object().cloned().unwrap_or_default();
        Some(Package { dependencies, scripts })
    }

    fn has(&self, name: &str) -> bool {
        self.dependencies.contains(name)
    }

    fn script(&self, name: &str) -> Option<&str> {
        self.scripts.get(name).and_then(Value::as_str)
    }

    /// The package's own `build` script, else the framework's command.
    fn build_or(&self, command: &str) -> String {
        if self.script("build").is_some() { "npm run build".to_owned() } else { command.to_owned() }
    }
}

/// The first of `names` in `dir`, read, without its comment lines.
fn config(dir: &Path, names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| std::fs::read_to_string(dir.join(name)).ok())
        .map(|text| {
            text.lines()
                .filter(|line| {
                    let line = line.trim_start();
                    !(line.starts_with("//") || line.starts_with('*') || line.starts_with("/*") || line.starts_with('#'))
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// Every string value `key` is given in a JavaScript or JSON config:
/// `key: 'value'`, `"key": "value"`, and so on.
fn values_of(text: &str, key: &str) -> Vec<String> {
    let pattern = format!(r#"(?:^|[^\w$.])["']?{}["']?\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)"#, regex::escape(key));
    let Ok(pattern) = Regex::new(&pattern) else { return Vec::new() };
    pattern
        .captures_iter(text)
        .filter_map(|found| found.get(1).or(found.get(2)).or(found.get(3)).map(|m| m.as_str().to_owned()))
        .collect()
}

fn value_of(text: &str, key: &str) -> Option<String> {
    values_of(text, key).into_iter().next().map(|v| v.trim().trim_start_matches("./").trim_matches('/').to_owned()).filter(|v| !v.is_empty())
}

/// Whether the config sets `key` to `value`, quoted or not (`ssr: false`).
fn sets(text: &str, key: &str, value: &str) -> bool {
    if values_of(text, key).iter().any(|v| v == value) {
        return true;
    }
    let pattern = format!(r#"(?:^|[^\w$.])["']?{}["']?\s*:\s*{}\b"#, regex::escape(key), regex::escape(value));
    Regex::new(&pattern).is_ok_and(|pattern| pattern.is_match(text))
}

/// `key = "value"` (TOML) or `key: value` (YAML), case aside.
fn setting(text: &str, key: &str) -> Option<String> {
    let pattern = format!(r#"(?im)^\s*{}\s*[=:]\s*["']?([^"'\s#]+)"#, regex::escape(key));
    Regex::new(&pattern).ok()?.captures(text).map(|found| found[1].trim_matches('/').to_owned())
}

const NEXT_CONFIGS: [&str; 4] = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"];
const ASTRO_CONFIGS: [&str; 5] = ["astro.config.mjs", "astro.config.js", "astro.config.ts", "astro.config.mts", "astro.config.cjs"];
const SVELTE_CONFIGS: [&str; 3] = ["svelte.config.js", "svelte.config.mjs", "svelte.config.ts"];
const VITE_CONFIGS: [&str; 6] = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts", "vite.config.cjs", "vite.config.cts"];
const REACT_ROUTER_CONFIGS: [&str; 4] = ["react-router.config.ts", "react-router.config.js", "react-router.config.mjs", "react-router.config.mts"];
const ELEVENTY_CONFIGS: [&str; 6] =
    ["eleventy.config.js", "eleventy.config.mjs", "eleventy.config.cjs", ".eleventy.js", ".eleventy.mjs", ".eleventy.cjs"];

/// The framework the project at `dir` is built with, if g1t knows it.
/// `wrangler` is whether the project has a Wrangler config of its own.
pub(crate) fn detect(dir: &Path, wrangler: bool) -> Option<Framework> {
    let package = Package::read(dir);
    if let Some(package) = &package
        && let Some(found) = node(dir, package, wrangler)
    {
        return Some(found);
    }
    let build_or = |command: &str| package.as_ref().map_or_else(|| command.to_owned(), |p| p.build_or(command));
    for name in ["hugo.toml", "hugo.yaml", "hugo.json", "config.toml", "config.yaml"] {
        let Ok(text) = std::fs::read_to_string(dir.join(name)) else { continue };
        // `config.toml` is also Zola's and others': Hugo's names `baseURL`,
        // or the folder has Hugo's layout.
        let hugo = name.starts_with("hugo.")
            || (package.is_none()
                && (text.to_ascii_lowercase().contains("baseurl")
                    || ["layouts", "archetypes", "themes"].iter().any(|d| dir.join(d).is_dir())));
        if hugo {
            let output = setting(&text, "publishDir").unwrap_or_else(|| "public".to_owned());
            return Some(Framework::new("hugo", "Hugo").static_site(build_or(HUGO), output));
        }
    }
    if dir.join("_config.yml").exists() && dir.join("Gemfile").exists() {
        let text = std::fs::read_to_string(dir.join("_config.yml")).unwrap_or_default();
        let output = setting(&text, "destination").unwrap_or_else(|| "_site".to_owned());
        let mut jekyll = Framework::new("jekyll", "Jekyll").static_site(build_or("bundle exec jekyll build"), output);
        jekyll.install = Some(BUNDLE_INSTALL);
        return Some(jekyll);
    }
    if let Ok(text) = std::fs::read_to_string(dir.join("book.toml")) {
        let output = toml::from_str::<toml::Value>(&text)
            .ok()
            .and_then(|book| book.get("build")?.get("build-dir")?.as_str().map(|d| d.trim_matches('/').to_owned()))
            .unwrap_or_else(|| "book".to_owned());
        return Some(Framework::new("mdbook", "mdBook").static_site(build_or(MDBOOK), output));
    }
    None
}

/// A framework found by the package's dependencies.
fn node(dir: &Path, package: &Package, wrangler: bool) -> Option<Framework> {
    if package.has("next") {
        let mut next = Framework::new("nextjs", "Next.js");
        if package.has("@opennextjs/cloudflare") {
            next.name = "Next.js (OpenNext's Cloudflare adapter)";
            next.workers = true;
            next.build = Some("npx opennextjs-cloudflare build".to_owned());
            if !wrangler {
                next.problem = Some(
                    "This Next.js app uses OpenNext's Cloudflare adapter (`@opennextjs/cloudflare`), which deploys as a Workers project: \
                     add a `wrangler.jsonc` beside `package.json` with `main` set to `.open-next/worker.js` and `assets.directory` \
                     to `.open-next/assets`, as OpenNext's guide shows."
                        .to_owned(),
                );
            }
        } else if sets(&config(dir, &NEXT_CONFIGS), "output", "export") {
            next = next.static_site(package.build_or("npx next build"), "out");
        } else if !wrangler {
            next.problem = Some(
                "This is a Next.js app that needs a server, and g1t could not write a Dockerfile to run it. Set \
                 `output: 'export'` in `next.config` to build it as a static site (served from `out`), or deploy it as a \
                 Worker with OpenNext's Cloudflare adapter, `@opennextjs/cloudflare`, and a `wrangler.jsonc`."
                    .to_owned(),
            );
        }
        return Some(next);
    }
    if package.has("astro") {
        let text = config(dir, &ASTRO_CONFIGS);
        let output = value_of(&text, "outDir").unwrap_or_else(|| "dist".to_owned());
        let mut astro = Framework::new("astro", "Astro").static_site(package.build_or("npx astro build"), output);
        if package.has("@astrojs/cloudflare") {
            astro.name = "Astro (Cloudflare adapter)";
            astro.workers = true;
            if !wrangler {
                astro.adapter = Some(Adapter { entry: "dist/_worker.js", assets: "dist" });
            }
        } else if !wrangler && (sets(&text, "output", "server") || sets(&text, "output", "hybrid")) {
            astro.problem = Some(
                "This Astro site renders on a server (`output: 'server'`) with no adapter g1t can start. Add \
                 `@astrojs/node` to run it as a container, use `output: 'static'` (the default) to build a static site, \
                 or add the `@astrojs/cloudflare` adapter to run it as a Worker."
                    .to_owned(),
            );
        }
        return Some(astro);
    }
    if package.has("@sveltejs/kit") {
        // SvelteKit 3 takes its options in `vite.config`, 2 in `svelte.config`.
        let text = format!("{}\n{}", config(dir, &SVELTE_CONFIGS), config(dir, &VITE_CONFIGS));
        let adapters = ["@sveltejs/adapter-static", "@sveltejs/adapter-cloudflare-workers", "@sveltejs/adapter-cloudflare"];
        let adapter = adapters
            .iter()
            .find(|adapter| text.contains(*adapter))
            .or_else(|| adapters.iter().find(|adapter| package.has(adapter)));
        let build = package.build_or("npx vite build");
        let mut kit = Framework::new("sveltekit", "SvelteKit");
        match adapter.copied() {
            Some("@sveltejs/adapter-static") => {
                let output = value_of(&text, "pages").unwrap_or_else(|| "build".to_owned());
                kit = kit.static_site(build, output);
                kit.name = "SvelteKit (static adapter)";
            }
            Some("@sveltejs/adapter-cloudflare") => {
                kit.name = "SvelteKit (Cloudflare adapter)";
                kit.build = Some(build);
                kit.workers = true;
                if !wrangler {
                    kit.adapter = Some(Adapter { entry: ".svelte-kit/cloudflare/_worker.js", assets: ".svelte-kit/cloudflare" });
                }
            }
            Some(_) if wrangler => {
                kit.build = Some(build);
                kit.workers = true;
            }
            Some(_) => {
                kit.problem = Some(
                    "`@sveltejs/adapter-cloudflare-workers` needs a `wrangler.toml`; it is deprecated, so switch to \
                     `@sveltejs/adapter-cloudflare` instead, which needs none."
                        .to_owned(),
                );
            }
            None if wrangler => {}
            None => {
                kit.problem = Some(
                    "This SvelteKit app has no adapter g1t.page can serve. Use `@sveltejs/adapter-static` to build a static \
                     site, `@sveltejs/adapter-cloudflare` to run it as a Worker, or `@sveltejs/adapter-node` to run it as a \
                     container; `adapter-auto` and the others need a host of their own."
                        .to_owned(),
                );
            }
        }
        return Some(kit);
    }
    if package.has("nuxt") {
        let mut nuxt = Framework::new("nuxt", "Nuxt");
        if wrangler {
            nuxt.build = Some(package.build_or("npx nuxi build"));
            nuxt.workers = true;
        } else {
            // Static generation: its `generate` script, a `build` script
            // that generates, or `nuxi generate` itself.
            let build = if package.script("generate").is_some() {
                "npm run generate".to_owned()
            } else if package.script("build").is_some_and(|script| script.contains("generate")) {
                "npm run build".to_owned()
            } else {
                "npx nuxi generate".to_owned()
            };
            nuxt = nuxt.static_site(build, ".output/public");
        }
        return Some(nuxt);
    }
    for (dependency, id, name, configs, command) in [
        ("@react-router/dev", "react-router", "React Router", &REACT_ROUTER_CONFIGS[..], "npx react-router build"),
        ("@remix-run/dev", "remix", "Remix", &VITE_CONFIGS[..], "npx remix vite:build"),
    ] {
        if !package.has(dependency) {
            continue;
        }
        let mut found = Framework::new(id, name);
        if sets(&config(dir, configs), "ssr", "false") {
            found = found.static_site(package.build_or(command), "build/client");
            found.name = if id == "remix" { "Remix (SPA mode)" } else { "React Router (SPA mode)" };
        } else if wrangler {
            found.build = Some(package.build_or(command));
            found.workers = true;
        } else {
            let file = if id == "remix" { "the Remix plugin's options in `vite.config`" } else { "`react-router.config.ts`" };
            found.problem = Some(format!(
                "This {name} app renders on a server, and g1t could not write a Dockerfile to run it. Set `ssr: false` in {file} \
                 to build it as a single-page app (served from `build/client`), or deploy it as a Worker with \
                 `@cloudflare/vite-plugin` and a `wrangler.jsonc`."
            ));
        }
        return Some(found);
    }
    if package.has("gatsby") {
        return Some(Framework::new("gatsby", "Gatsby").static_site(package.build_or("npx gatsby build"), "public"));
    }
    if package.has("@docusaurus/core") {
        return Some(Framework::new("docusaurus", "Docusaurus").static_site(package.build_or("npx docusaurus build"), "build"));
    }
    if package.has("@11ty/eleventy") {
        let output = value_of(&config(dir, &ELEVENTY_CONFIGS), "output").unwrap_or_else(|| "_site".to_owned());
        return Some(Framework::new("eleventy", "Eleventy").static_site(package.build_or("npx @11ty/eleventy"), output));
    }
    if package.has("@angular/core") && dir.join("angular.json").exists() {
        let mut angular = Framework::new("angular", "Angular");
        angular.build = Some(package.build_or("npx ng build"));
        angular.output = angular_output(dir);
        return Some(angular);
    }
    if package.has("react-scripts") {
        return Some(
            Framework::new("create-react-app", "Create React App").static_site(package.build_or("npx react-scripts build"), "build"),
        );
    }
    let vite_config = VITE_CONFIGS.iter().any(|name| dir.join(name).exists());
    if package.has("vite") || vite_config {
        let (id, name) = [
            ("@vitejs/plugin-react", "vite-react", "React (Vite)"),
            ("@vitejs/plugin-react-swc", "vite-react", "React (Vite)"),
            ("@vitejs/plugin-vue", "vite-vue", "Vue (Vite)"),
            ("@sveltejs/vite-plugin-svelte", "vite-svelte", "Svelte (Vite)"),
            ("vite-plugin-solid", "vite-solid", "Solid (Vite)"),
            ("@preact/preset-vite", "vite-preact", "Preact (Vite)"),
        ]
        .iter()
        .find(|(plugin, ..)| package.has(plugin))
        .map_or(("vite", "Vite"), |(_, id, name)| (*id, *name));
        let build = package.build_or("npx vite build");
        if wrangler && package.has("@cloudflare/vite-plugin") {
            let mut vite = Framework::new(id, name);
            vite.build = Some(build);
            vite.workers = true;
            return Some(vite);
        }
        let output = value_of(&config(dir, &VITE_CONFIGS), "outDir").unwrap_or_else(|| "dist".to_owned());
        return Some(Framework::new(id, name).static_site(build, output));
    }
    None
}

/// Where `ng build` writes the app's browser files: the application
/// builder's `<outputPath>/browser`, or the older builders' `<outputPath>`.
fn angular_output(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("angular.json")).ok()?;
    let workspace: Value = serde_json::from_str(&text).ok()?;
    let projects = workspace["projects"].as_object()?;
    let (name, project) = workspace["defaultProject"]
        .as_str()
        .and_then(|name| projects.get_key_value(name))
        .or_else(|| projects.iter().find(|(_, project)| project["projectType"] == "application"))
        .or_else(|| projects.iter().next())?;
    let targets = if project["architect"].is_object() { &project["architect"] } else { &project["targets"] };
    let build = &targets["build"];
    let builder = build["builder"].as_str().unwrap_or("");
    let application = builder.is_empty() || builder.ends_with(":application");
    let trim = |path: &str| path.trim().trim_start_matches("./").trim_matches('/').to_owned();
    Some(match &build["options"]["outputPath"] {
        Value::String(path) if application => format!("{}/browser", trim(path)),
        Value::String(path) => trim(path),
        Value::Object(output) => {
            let base = output.get("base").and_then(Value::as_str).map_or_else(|| format!("dist/{name}"), trim);
            match output.get("browser").and_then(Value::as_str).map(trim) {
                Some(browser) if browser.is_empty() => base,
                Some(browser) => format!("{base}/{browser}"),
                None => format!("{base}/browser"),
            }
        }
        _ if application => format!("dist/{name}/browser"),
        _ => format!("dist/{name}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_values_are_read_quoted_or_not() {
        let text = "export default defineConfig({\n  output: 'export',\n  build: { \"outDir\": \"site\" },\n  ssr: false,\n})";
        assert!(sets(text, "output", "export"));
        assert!(!sets(text, "output", "server"));
        assert!(sets(text, "ssr", "false"));
        assert_eq!(value_of(text, "outDir").as_deref(), Some("site"));
        // Another key that ends the same is not it.
        assert!(!sets("{ distOutput: 'export' }", "output", "export"));
        assert_eq!(setting("baseURL = 'https://x'\npublishDir = \"site/\"", "publishDir").as_deref(), Some("site"));
    }
}
