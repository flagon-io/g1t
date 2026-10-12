//! Projects that deploy as a container: their own `Dockerfile` (or
//! `Containerfile`, or the path the project chose), or, for a server g1t
//! recognises without one, a Dockerfile g1t writes, as `fly launch` does.
//! What is built here runs on Cloudflare Containers behind the app's
//! Worker (the deployments service's containers.ts). Nothing here runs
//! anything: it reads the project and says what to build.

use std::path::Path;

use anyhow::{Result, bail};
use serde_json::Value;

/// The port a container listens on when its Dockerfile names none, and
/// what every Dockerfile g1t writes listens on. `PORT` says it, too.
pub(crate) const DEFAULT_PORT: u16 = 8080;

/// What the project's **Build as** setting says it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum BuildAs {
    /// Found from its files: see `detect` in deploy.rs.
    #[default]
    Auto,
    /// Built and served as a static site, whatever else it has.
    Static,
    /// A Workers project: its Wrangler config, or a framework's adapter.
    Workers,
    /// A container, from its Dockerfile or one g1t writes.
    Docker,
}

impl BuildAs {
    /// `BUILD_AS`, as the deployments service sends the setting: `auto`,
    /// `static`, `workers` or `docker`; anything else is `auto`.
    pub(crate) fn parse(value: &str) -> BuildAs {
        match value.trim().to_ascii_lowercase().as_str() {
            "static" => BuildAs::Static,
            "workers" => BuildAs::Workers,
            "docker" | "container" => BuildAs::Docker,
            _ => BuildAs::Auto,
        }
    }
}

/// The names a project's own Dockerfile is found by, in order.
const DOCKERFILES: [&str; 3] = ["Dockerfile", "Containerfile", "dockerfile"];

/// The project's own Dockerfile, relative to the project: the path it
/// chose (which must exist), else the first of `DOCKERFILES`.
pub(crate) fn own_dockerfile(dir: &Path, chosen: Option<&str>) -> Result<Option<String>> {
    if let Some(chosen) = chosen.map(|c| c.trim().trim_start_matches("./")).filter(|c| !c.is_empty()) {
        if chosen.split('/').any(|part| part == "..") || chosen.starts_with('/') {
            bail!("the Dockerfile path `{chosen}` must be inside the project");
        }
        if !dir.join(chosen).is_file() {
            bail!("the Dockerfile `{chosen}` set in the project's settings does not exist");
        }
        return Ok(Some(chosen.to_owned()));
    }
    Ok(DOCKERFILES.iter().find(|name| dir.join(name).is_file()).map(|name| (*name).to_owned()))
}

/// The port a Dockerfile's last stage says it listens on (its first
/// `EXPOSE` there), if it says.
pub(crate) fn exposed_port(dockerfile: &str) -> Option<u16> {
    let mut port = None;
    for line in dockerfile.lines() {
        let line = line.trim();
        let mut words = line.split_whitespace();
        let Some(word) = words.next() else { continue };
        if word.eq_ignore_ascii_case("FROM") {
            // Each stage starts afresh: only the last one's is what runs.
            port = None;
        } else if word.eq_ignore_ascii_case("EXPOSE") && port.is_none() {
            port = words.next().and_then(|p| p.split('/').next()).and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 0);
        }
    }
    port
}

/// A server g1t can write a Dockerfile for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Server {
    /// As `g1t-runner detect` prints it when no framework names it:
    /// `node`, `django`, `flask`, `fastapi`, `python`, `go`, `rails`,
    /// `rack`, `laravel`, `php`.
    pub id: &'static str,
    /// For the build's log: `Node.js`, `Django`…
    pub name: &'static str,
    /// The Dockerfile, whole.
    pub dockerfile: String,
}

/// What a generated Dockerfile leaves out of the image.
pub(crate) const DOCKERIGNORE: &str = ".git\nnode_modules\n.venv\n__pycache__\n.wrangler\n.g1t\n";

fn header(name: &str) -> String {
    format!(
        "# Written by g1t for this {name} project, which has no Dockerfile of its own.\n\
         # To change how it is built or run, commit this file as `Dockerfile` and edit it.\n"
    )
}

/// `package.json`, as read.
fn package(dir: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).ok()?).ok()
}

fn has_dependency(package: &Value, name: &str) -> bool {
    ["dependencies", "devDependencies"].iter().any(|field| package[field].get(name).is_some())
}

/// Packages that make a Node.js project a server of its own.
const NODE_SERVERS: [&str; 14] = [
    "express",
    "fastify",
    "koa",
    "@hapi/hapi",
    "@nestjs/core",
    "@hono/node-server",
    "restify",
    "polka",
    "@adonisjs/core",
    "sails",
    "socket.io",
    "@remix-run/serve",
    "@react-router/serve",
    "@feathersjs/feathers",
];

/// The Node.js version to build with: `.nvmrc` or `.node-version` when it
/// names a major release g1t can pull, else 22.
fn node_major(dir: &Path) -> u32 {
    [".nvmrc", ".node-version"]
        .iter()
        .find_map(|name| std::fs::read_to_string(dir.join(name)).ok())
        .and_then(|text| {
            let digits: String = text.trim().trim_start_matches('v').chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<u32>().ok()
        })
        .filter(|major| (18..=30).contains(major))
        .unwrap_or(22)
}

/// How a Node.js project installs, in the image.
fn node_install(dir: &Path) -> &'static str {
    if dir.join("pnpm-lock.yaml").exists() {
        "corepack enable && pnpm install --frozen-lockfile --prod=false"
    } else if dir.join("yarn.lock").exists() {
        "corepack enable && yarn install"
    } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        "npx --yes bun install"
    } else if dir.join("package-lock.json").exists() {
        "npm ci --include=dev"
    } else {
        "npm install --include=dev"
    }
}

/// A Node.js server's Dockerfile: installed, built if it has a `build`
/// script, then started with `start`.
fn node_dockerfile(dir: &Path, name: &str, start: &str, build: Option<&str>) -> String {
    let build = build.map(|command| format!("RUN {command}\n")).unwrap_or_default();
    format!(
        "{header}FROM node:{major}-slim\n\
         WORKDIR /app\n\
         COPY . .\n\
         RUN {install}\n\
         {build}\
         ENV NODE_ENV=production HOST=0.0.0.0 PORT={DEFAULT_PORT}\n\
         EXPOSE {DEFAULT_PORT}\n\
         CMD {start}\n",
        header = header(name),
        major = node_major(dir),
        install = node_install(dir),
    )
}

/// The command a Node.js server starts with, as a Dockerfile's exec form.
fn exec(words: &[&str]) -> String {
    let quoted: Vec<String> = words.iter().map(|w| format!("\"{w}\"")).collect();
    format!("[{}]", quoted.join(", "))
}

/// A shell command as a Dockerfile's `CMD`, so `$PORT` is read when it starts.
fn shell(command: &str) -> String {
    exec(&["sh", "-c", &format!("exec {command}")])
}

/// A Dockerfile for a framework that needs a server (`framework`, from
/// frameworks.rs), when g1t knows how to run it: Next.js with `next
/// start`, Astro with `@astrojs/node`, SvelteKit with `adapter-node`,
/// React Router and Remix with their own server.
pub(crate) fn for_framework(dir: &Path, framework: &str) -> Option<Server> {
    let package = package(dir)?;
    let scripts = &package["scripts"];
    let script = |name: &str| scripts[name].as_str();
    let has_build = script("build").is_some();
    let start = |fallback: &[&str]| if script("start").is_some() { exec(&["npm", "start"]) } else { exec(fallback) };
    let (name, command, own_build) = match framework {
        "nextjs" => ("Next.js", start(&["npx", "next", "start"]), "npx next build"),
        // `astro dev` is a common `start` script, so Astro's node adapter's
        // own server is run instead.
        "astro" if has_dependency(&package, "@astrojs/node") => ("Astro", exec(&["node", "./dist/server/entry.mjs"]), "npx astro build"),
        "sveltekit" if has_dependency(&package, "@sveltejs/adapter-node") => ("SvelteKit", exec(&["node", "build"]), "npx vite build"),
        "react-router" => ("React Router", start(&["npx", "react-router-serve", "./build/server/index.js"]), "npx react-router build"),
        "remix" => ("Remix", start(&["npx", "remix-serve", "./build/server/index.js"]), "npx remix vite:build"),
        _ => return None,
    };
    // Its own `build` script, else the framework's command.
    let build = if has_build { "npm run build" } else { own_build };
    Some(Server { id: "node", name, dockerfile: node_dockerfile(dir, name, &command, Some(build)) })
}

/// A server g1t recognises in a project with no framework it knows, and
/// the Dockerfile it writes for it.
pub(crate) fn server(dir: &Path) -> Option<Server> {
    node_server(dir).or_else(|| python(dir)).or_else(|| go(dir)).or_else(|| ruby(dir)).or_else(|| php(dir))
}

/// A Node.js server: a `start` script, with a server package or nothing
/// that looks like a static site (no `build` script and no `index.html`).
fn node_server(dir: &Path) -> Option<Server> {
    let package = package(dir)?;
    let scripts = &package["scripts"];
    let server_package = NODE_SERVERS.iter().any(|name| has_dependency(&package, name));
    let has_build = scripts["build"].is_string();
    let start = if scripts["start"].is_string() {
        exec(&["npm", "start"])
    } else if server_package {
        let main = package["main"].as_str().map(str::to_owned).or_else(|| {
            ["server.js", "index.js", "app.js", "server.mjs", "index.mjs"].iter().find(|f| dir.join(f).is_file()).map(|f| (*f).to_owned())
        })?;
        exec(&["node", &main])
    } else {
        return None;
    };
    if !server_package && (has_build || dir.join("index.html").exists()) {
        return None;
    }
    Some(Server { id: "node", name: "Node.js", dockerfile: node_dockerfile(dir, "Node.js", &start, has_build.then_some("npm run build")) })
}

/// A Python web app: its requirements, and the file that starts it.
fn python(dir: &Path) -> Option<Server> {
    let requirements = ["requirements.txt", "pyproject.toml", "Pipfile"].iter().find(|f| dir.join(f).is_file())?;
    let text = ["requirements.txt", "pyproject.toml", "Pipfile"]
        .iter()
        .filter_map(|f| std::fs::read_to_string(dir.join(f)).ok())
        .collect::<Vec<_>>()
        .join("\n")
        .to_ascii_lowercase();
    let uses = |name: &str| {
        text.lines().any(|line| {
            let line = line.trim().trim_start_matches(['"', '\'']);
            line.starts_with(name) && !line[name.len()..].starts_with(|c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        })
    };
    let install = match *requirements {
        "requirements.txt" => "pip install --no-cache-dir -r requirements.txt",
        "Pipfile" => "pip install --no-cache-dir pipenv && pipenv install --system --deploy",
        _ => "pip install --no-cache-dir .",
    };
    let module = ["app", "main", "server", "wsgi", "asgi"].iter().find(|m| dir.join(format!("{m}.py")).is_file()).copied();
    let (id, name, extra, command) = if dir.join("manage.py").is_file() {
        // Django: the project's package is the folder with its `wsgi.py`.
        let project = std::fs::read_dir(dir)
            .ok()?
            .flatten()
            .find(|entry| entry.path().join("wsgi.py").is_file())?
            .file_name()
            .to_string_lossy()
            .into_owned();
        ("django", "Django", "gunicorn", format!("gunicorn --bind 0.0.0.0:$PORT {project}.wsgi"))
    } else if uses("fastapi") || uses("starlette") {
        let module = module?;
        ("fastapi", "FastAPI", "uvicorn", format!("uvicorn {module}:app --host 0.0.0.0 --port $PORT"))
    } else if uses("flask") {
        let module = module?;
        ("flask", "Flask", "gunicorn", format!("gunicorn --bind 0.0.0.0:$PORT {module}:app"))
    } else {
        let module = module?;
        ("python", "Python", "", format!("python {module}.py"))
    };
    let extra = if extra.is_empty() || uses(extra) { String::new() } else { format!(" && pip install --no-cache-dir {extra}") };
    let dockerfile = format!(
        "{header}FROM python:3.12-slim\n\
         WORKDIR /app\n\
         ENV PYTHONUNBUFFERED=1 PORT={DEFAULT_PORT}\n\
         COPY . .\n\
         RUN {install}{extra}\n\
         EXPOSE {DEFAULT_PORT}\n\
         CMD {cmd}\n",
        header = header(name),
        cmd = shell(&command),
    );
    Some(Server { id, name, dockerfile })
}

/// Whether a Go file is `package main`.
fn is_main(path: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|text| {
        text.lines().map(str::trim).find(|line| line.starts_with("package ")).is_some_and(|line| line == "package main")
    })
}

fn has_main(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let path = entry.path();
            path.extension().is_some_and(|e| e == "go") && !path.to_string_lossy().ends_with("_test.go") && is_main(&path)
        })
    })
}

/// A Go program: `go.mod`, and a `package main` at the top or in one
/// folder of `cmd/`.
fn go(dir: &Path) -> Option<Server> {
    if !dir.join("go.mod").is_file() {
        return None;
    }
    let target = if has_main(dir) {
        ".".to_owned()
    } else {
        let mut commands: Vec<String> = std::fs::read_dir(dir.join("cmd"))
            .ok()?
            .flatten()
            .filter(|entry| has_main(&entry.path()))
            .map(|entry| format!("./cmd/{}", entry.file_name().to_string_lossy()))
            .collect();
        commands.sort();
        // More than one program: which to run is the project's to say.
        if commands.len() != 1 {
            return None;
        }
        commands.remove(0)
    };
    let dockerfile = format!(
        "{header}FROM golang:1.25 AS build\n\
         WORKDIR /src\n\
         COPY . .\n\
         RUN go mod download && CGO_ENABLED=0 go build -trimpath -ldflags=-s -o /out/app {target}\n\
         \n\
         FROM scratch\n\
         COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/\n\
         COPY --from=build /out/app /app\n\
         ENV PORT={DEFAULT_PORT}\n\
         EXPOSE {DEFAULT_PORT}\n\
         ENTRYPOINT [\"/app\"]\n",
        header = header("Go"),
    );
    Some(Server { id: "go", name: "Go", dockerfile })
}

/// A Ruby web app: Rails, or any Rack app with a `config.ru`.
fn ruby(dir: &Path) -> Option<Server> {
    let gemfile = std::fs::read_to_string(dir.join("Gemfile")).ok()?;
    let rails = gemfile.lines().any(|line| {
        let line = line.trim();
        line.starts_with("gem \"rails\"") || line.starts_with("gem 'rails'")
    });
    let (id, name, setup, command) = if rails {
        (
            "rails",
            "Rails",
            "RUN if bundle exec rails -T assets:precompile 2>/dev/null | grep -q assets:precompile; then SECRET_KEY_BASE_DUMMY=1 bundle exec rails assets:precompile; fi\n",
            "bundle exec rails server -b 0.0.0.0 -p $PORT",
        )
    } else if dir.join("config.ru").is_file() {
        ("rack", "Rack", "", "bundle exec rackup -o 0.0.0.0 -p $PORT")
    } else {
        return None;
    };
    let dockerfile = format!(
        "{header}FROM ruby:3.3-slim\n\
         RUN apt-get update && apt-get install -y --no-install-recommends build-essential git libpq-dev libyaml-dev pkg-config && rm -rf /var/lib/apt/lists/*\n\
         WORKDIR /app\n\
         ENV RAILS_ENV=production RACK_ENV=production BUNDLE_WITHOUT=development:test RAILS_LOG_TO_STDOUT=1 RAILS_SERVE_STATIC_FILES=1 PORT={DEFAULT_PORT}\n\
         COPY . .\n\
         RUN bundle install\n\
         {setup}\
         EXPOSE {DEFAULT_PORT}\n\
         CMD {cmd}\n",
        header = header(name),
        cmd = shell(command),
    );
    Some(Server { id, name, dockerfile })
}

/// A PHP app with Composer: Laravel, or any app with an `index.php`.
fn php(dir: &Path) -> Option<Server> {
    if !dir.join("composer.json").is_file() {
        return None;
    }
    let (id, name) = if dir.join("artisan").is_file() { ("laravel", "Laravel") } else { ("php", "PHP") };
    let root = if dir.join("public/index.php").is_file() {
        "/var/www/html/public"
    } else if dir.join("index.php").is_file() {
        "/var/www/html"
    } else {
        return None;
    };
    let dockerfile = format!(
        "{header}FROM composer:2 AS vendor\n\
         WORKDIR /app\n\
         COPY . .\n\
         RUN composer install --no-dev --prefer-dist --no-interaction --optimize-autoloader --ignore-platform-reqs\n\
         \n\
         FROM php:8.3-apache\n\
         ENV PORT={DEFAULT_PORT} APACHE_DOCUMENT_ROOT={root}\n\
         RUN sed -ri -e 's!/var/www/html!${{APACHE_DOCUMENT_ROOT}}!g' /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf \\\n \
         && sed -ri -e 's/^Listen 80$/Listen ${{PORT}}/' /etc/apache2/ports.conf \\\n \
         && sed -ri -e 's/:80>/:${{PORT}}>/' /etc/apache2/sites-available/000-default.conf \\\n \
         && a2enmod rewrite\n\
         COPY --from=vendor --chown=www-data:www-data /app /var/www/html\n\
         EXPOSE {DEFAULT_PORT}\n",
        header = header(name),
    );
    Some(Server { id, name, dockerfile })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, files: &[(&str, &str)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("g1t-container-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (path, text) in files {
            let path = dir.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        dir
    }

    #[test]
    fn build_as_is_read_from_the_setting() {
        assert_eq!(BuildAs::parse("docker"), BuildAs::Docker);
        assert_eq!(BuildAs::parse(" Static "), BuildAs::Static);
        assert_eq!(BuildAs::parse("workers"), BuildAs::Workers);
        assert_eq!(BuildAs::parse(""), BuildAs::Auto);
        assert_eq!(BuildAs::parse("something"), BuildAs::Auto);
    }

    #[test]
    fn a_dockerfile_is_found_by_its_names_or_the_chosen_path() {
        let dir = project("own", &[("Containerfile", "FROM scratch"), ("deploy/web.Dockerfile", "FROM scratch")]);
        assert_eq!(own_dockerfile(&dir, None).unwrap().as_deref(), Some("Containerfile"));
        assert_eq!(own_dockerfile(&dir, Some("./deploy/web.Dockerfile")).unwrap().as_deref(), Some("deploy/web.Dockerfile"));
        assert!(own_dockerfile(&dir, Some("missing/Dockerfile")).unwrap_err().to_string().contains("does not exist"));
        assert!(own_dockerfile(&dir, Some("../etc/passwd")).is_err());
        assert_eq!(own_dockerfile(&project("none", &[]), None).unwrap(), None);
    }

    #[test]
    fn the_port_is_the_last_stages_first_expose() {
        assert_eq!(exposed_port("FROM node\nEXPOSE 3000\nEXPOSE 9229"), Some(3000));
        assert_eq!(exposed_port("FROM golang AS build\nEXPOSE 9000\nFROM scratch\nexpose 8000/tcp"), Some(8000));
        assert_eq!(exposed_port("FROM golang AS build\nEXPOSE 9000\nFROM scratch\n"), None);
        assert_eq!(exposed_port("FROM x\nEXPOSE $PORT"), None);
    }

    #[test]
    fn node_servers_are_recognised_and_static_sites_are_not() {
        let express = project("express", &[("package.json", r#"{ "scripts": { "start": "node server.js" }, "dependencies": { "express": "5" } }"#), ("package-lock.json", "{}")]);
        let found = server(&express).unwrap();
        assert_eq!((found.id, found.name), ("node", "Node.js"));
        assert!(found.dockerfile.contains("FROM node:22-slim"));
        assert!(found.dockerfile.contains("RUN npm ci --include=dev"));
        assert!(found.dockerfile.contains("CMD [\"npm\", \"start\"]"));
        assert!(found.dockerfile.contains("EXPOSE 8080"));
        assert!(!found.dockerfile.contains("npm run build"));
        // A server package without a start script runs its main file.
        let main = project("main", &[("package.json", r#"{ "main": "src/app.js", "dependencies": { "fastify": "5" } }"#), (".nvmrc", "v20.11\n")]);
        let found = server(&main).unwrap();
        assert!(found.dockerfile.contains("CMD [\"node\", \"src/app.js\"]"));
        assert!(found.dockerfile.contains("FROM node:20-slim"));
        // A start script beside a build script and no server package is a
        // static site's preview server, not an app.
        let site = project("site", &[("package.json", r#"{ "scripts": { "build": "x", "start": "serve dist" } }"#)]);
        assert_eq!(server(&site), None);
        assert_eq!(server(&project("bare", &[("package.json", "{}")])), None);
    }

    #[test]
    fn python_apps_get_the_server_their_framework_runs_on() {
        let flask = project("flask", &[("requirements.txt", "Flask==3.1\n"), ("app.py", "")]);
        let found = server(&flask).unwrap();
        assert_eq!(found.id, "flask");
        assert!(found.dockerfile.contains("pip install --no-cache-dir -r requirements.txt && pip install --no-cache-dir gunicorn"));
        assert!(found.dockerfile.contains(r#"CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:$PORT app:app"]"#));
        let fastapi = project("fastapi", &[("requirements.txt", "fastapi\nuvicorn[standard]\n"), ("main.py", "")]);
        let found = server(&fastapi).unwrap();
        assert_eq!(found.id, "fastapi");
        assert!(!found.dockerfile.contains("pip install --no-cache-dir uvicorn"), "already required");
        assert!(found.dockerfile.contains("uvicorn main:app --host 0.0.0.0 --port $PORT"));
        let django = project("django", &[("requirements.txt", "Django>=5\ngunicorn\n"), ("manage.py", ""), ("shop/wsgi.py", "")]);
        let found = server(&django).unwrap();
        assert_eq!(found.id, "django");
        assert!(found.dockerfile.contains("gunicorn --bind 0.0.0.0:$PORT shop.wsgi"));
        // Requirements without an app to start (a docs site's) are not one.
        assert_eq!(server(&project("mkdocs", &[("requirements.txt", "mkdocs\n"), ("mkdocs.yml", "")])), None);
        // flask-cors is not Flask.
        let cors = project("cors", &[("requirements.txt", "flask-cors\n"), ("app.py", "")]);
        assert_eq!(server(&cors).unwrap().id, "python");
    }

    #[test]
    fn go_ruby_and_php_apps_are_recognised() {
        let go_root = project("go", &[("go.mod", "module x\n"), ("main.go", "// x\npackage main\n"), ("main_test.go", "package main")]);
        let found = server(&go_root).unwrap();
        assert_eq!(found.id, "go");
        assert!(found.dockerfile.contains("go build -trimpath -ldflags=-s -o /out/app .\n"));
        assert!(found.dockerfile.contains("FROM scratch"));
        let go_cmd = project("gocmd", &[("go.mod", "module x\n"), ("lib.go", "package x"), ("cmd/api/main.go", "package main")]);
        assert!(server(&go_cmd).unwrap().dockerfile.contains("-o /out/app ./cmd/api\n"));
        let go_two = project("gotwo", &[("go.mod", "module x\n"), ("cmd/a/main.go", "package main"), ("cmd/b/main.go", "package main")]);
        assert_eq!(server(&go_two), None, "which program runs is the project's to say");

        let rails = project("rails", &[("Gemfile", "source 'https://rubygems.org'\ngem \"rails\", \"~> 8.0\"\n"), ("config.ru", "")]);
        let found = server(&rails).unwrap();
        assert_eq!(found.id, "rails");
        assert!(found.dockerfile.contains("bundle exec rails server -b 0.0.0.0 -p $PORT"));
        let rack = project("rack", &[("Gemfile", "gem 'sinatra'\n"), ("config.ru", "run App")]);
        assert_eq!(server(&rack).unwrap().id, "rack");
        assert_eq!(server(&project("gems", &[("Gemfile", "gem 'rake'\n")])), None);

        let laravel = project("laravel", &[("composer.json", "{}"), ("artisan", ""), ("public/index.php", "")]);
        let found = server(&laravel).unwrap();
        assert_eq!(found.id, "laravel");
        assert!(found.dockerfile.contains("APACHE_DOCUMENT_ROOT=/var/www/html/public"));
        assert!(found.dockerfile.contains("Listen ${PORT}"));
        assert_eq!(server(&project("composer", &[("composer.json", "{}")])), None);
    }

    #[test]
    fn frameworks_that_need_a_server_get_one() {
        let next = project("next", &[("package.json", r#"{ "scripts": { "build": "next build", "start": "next start" }, "dependencies": { "next": "16" } }"#)]);
        let found = for_framework(&next, "nextjs").unwrap();
        assert!(found.dockerfile.contains("RUN npm run build\n"));
        assert!(found.dockerfile.contains("CMD [\"npm\", \"start\"]"));
        let bare = project("next-bare", &[("package.json", r#"{ "dependencies": { "next": "16" } }"#)]);
        let found = for_framework(&bare, "nextjs").unwrap();
        assert!(found.dockerfile.contains("RUN npx next build\n"));
        assert!(found.dockerfile.contains("CMD [\"npx\", \"next\", \"start\"]"));
        let astro = project("astro-node", &[("package.json", r#"{ "scripts": { "build": "astro build", "start": "astro dev" }, "dependencies": { "astro": "5", "@astrojs/node": "9" } }"#)]);
        assert!(for_framework(&astro, "astro").unwrap().dockerfile.contains("CMD [\"node\", \"./dist/server/entry.mjs\"]"));
        let kit = project("kit-auto", &[("package.json", r#"{ "devDependencies": { "@sveltejs/kit": "2", "@sveltejs/adapter-auto": "6" } }"#)]);
        assert_eq!(for_framework(&kit, "sveltekit"), None, "adapter-auto has no server to run");
        let rr = project("rr", &[("package.json", r#"{ "devDependencies": { "@react-router/dev": "7" } }"#)]);
        let found = for_framework(&rr, "react-router").unwrap();
        assert!(found.dockerfile.contains("RUN npx react-router build\n"));
        assert!(found.dockerfile.contains("react-router-serve"));
    }
}
