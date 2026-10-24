//! A Node.js HTTP server (Express, Koa, Hono, plain `node:http`…) run as a
//! Worker rather than a container. Workers run Node's HTTP servers with
//! `nodejs_compat`: `httpServerHandler` from `cloudflare:node` takes a
//! `node:http` server and answers the Worker's requests with it
//! (developers.cloudflare.com/workers/runtime-apis/nodejs/http/; from the
//! compatibility date 2025-09-01, `nodejs_compat` turns on
//! `enable_nodejs_http_server_modules` by itself). g1t writes a Worker
//! entry that imports the app's own start file and hands the server it
//! starts to `httpServerHandler`, or calls its default export's `fetch`
//! when it has one (a Hono app), and wrangler bundles it as it bundles any
//! Workers project.
//!
//! What cannot run as a Worker is found before anything is built where it
//! can be (`plan`): a native addon, a server that needs Node's `upgrade`
//! event or starts itself on timers, a child process, or files read from
//! disk while it runs. Such a project, or one whose bundle or first start
//! fails, is deployed as a container instead (deploy.rs).

use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::Value;

/// How the project runs as a Worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NodeWorker {
    /// For the build's log: `Express`, `Hono`, `Node.js`.
    pub name: &'static str,
    /// The file that starts it, relative to the project with `/`: what its
    /// `start` script runs, else its `main`, else `server.js` and the like.
    /// It may only exist once the project's `build` script has run.
    pub entry: String,
    /// The project's own `build` script, run before it is bundled.
    pub build: Option<String>,
    /// The folder it serves files from (`app.use(express.static("public"))`),
    /// relative to the project, served as the Worker's static assets.
    pub assets: Option<String>,
}

/// What `plan` found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Plan {
    Worker(NodeWorker),
    /// Why it cannot run as a Worker, for the build's log.
    Blocked(String),
}

/// Server packages, by the name the log gives them.
const SERVERS: [(&str, &str); 9] = [
    ("express", "Express"),
    ("koa", "Koa"),
    ("hono", "Hono"),
    ("@hono/node-server", "Hono"),
    ("polka", "Polka"),
    ("restify", "Restify"),
    ("@hapi/hapi", "hapi"),
    ("@feathersjs/feathers", "Feathers"),
    ("h3", "h3"),
];

/// Packages that build native code, which a Worker cannot load.
const NATIVE_ADDONS: [&str; 20] = [
    "better-sqlite3",
    "sqlite3",
    "bcrypt",
    "sharp",
    "canvas",
    "@napi-rs/canvas",
    "argon2",
    "node-sass",
    "puppeteer",
    "playwright",
    "node-pty",
    "ssh2",
    "re2",
    "leveldown",
    "zeromq",
    "@tensorflow/tfjs-node",
    "sodium-native",
    "isolated-vm",
    "uWebSockets.js",
    "libxmljs",
];

/// Packages that make a server g1t does not run as a Worker, and why.
const BLOCKING_PACKAGES: [(&str, &str); 7] = [
    ("fastify", "Fastify starts itself on timers, which a Worker does not run before its first request"),
    ("@nestjs/core", "NestJS loads its modules while it starts, which a Worker's bundle cannot do"),
    ("socket.io", "socket.io accepts WebSocket connections through Node's `upgrade` event, which Workers do not support"),
    ("express-ws", "express-ws accepts WebSocket connections through Node's `upgrade` event, which Workers do not support"),
    ("@remix-run/serve", "remix-serve serves its build from disk"),
    ("@react-router/serve", "react-router-serve serves its build from disk"),
    ("sails", "Sails reads the app from disk while it starts"),
];

/// What in the app's own code a Worker cannot do, and why, in the order
/// they are looked for.
const BLOCKING_CODE: [(&str, &str); 4] = [
    (
        r#"\bchild_process\b|["'](?:node:)?cluster["']|\bworker_threads\b"#,
        "it starts other processes or threads (`child_process`, `cluster`, `worker_threads`), which a Worker cannot",
    ),
    (
        r#"\bWebSocketServer\b|\bWebSocket\.Server\b|\.on\(\s*["']upgrade["']"#,
        "it accepts WebSocket connections through Node's `upgrade` event, which Workers do not support",
    ),
    (
        r#"\b(?:readFileSync|readFile|createReadStream|writeFileSync|writeFile|appendFile|createWriteStream|mkdirSync|sendFile|diskStorage)\s*\(|\.render\(\s*["'`]|["']view engine["']"#,
        "it reads or writes files on disk while it runs, and a Worker has no disk with the project's files",
    ),
    (
        r#"\bserveStatic\s*\(|\bexpress\.static\s*\(|["']koa-static["']|["']@fastify/static["']"#,
        "it serves files from disk in a way g1t cannot serve them for it (only `app.use(express.static(\"<folder>\"))` can be)",
    ),
];

/// Folders of a project that hold no code the server runs.
const SKIPPED_DIRS: [&str; 15] = [
    "node_modules",
    ".git",
    ".g1t",
    ".wrangler",
    "dist",
    "build",
    "out",
    "coverage",
    "test",
    "tests",
    "__tests__",
    "public",
    "static",
    "scripts",
    "docs",
];

/// Source files read at most, and the largest read.
const MAX_SOURCES: usize = 2_000;
const MAX_SOURCE_BYTES: u64 = 1024 * 1024;

fn has_dependency(package: &Value, name: &str) -> bool {
    ["dependencies", "devDependencies", "optionalDependencies"].iter().any(|field| package[field].get(name).is_some())
}

/// The name the log gives the server: its framework, else `Node.js`.
fn server_name(package: &Value) -> &'static str {
    SERVERS.iter().find(|(name, _)| has_dependency(package, name)).map_or("Node.js", |(_, shown)| shown)
}

/// The file a `start` script runs: the last command of it, when that is
/// `node`, `tsx` or `ts-node` with a file. None for anything else
/// (`nest start`, `npm run serve`, `pm2-runtime …`).
pub(crate) fn start_file(script: &str) -> Option<String> {
    let last = script.split("&&").last()?.split(';').next_back()?.trim();
    let mut words = last.split_whitespace().peekable();
    // `NODE_ENV=production node …`, `cross-env NODE_ENV=production node …`.
    while let Some(word) = words.peek() {
        if *word == "cross-env" || *word == "env" || (word.contains('=') && !word.starts_with('-')) {
            words.next();
        } else {
            break;
        }
    }
    let runner = words.next()?;
    if !["node", "tsx", "ts-node", "ts-node-esm"].contains(&runner) {
        return None;
    }
    // Flags that take the next word as their value.
    const WITH_VALUE: [&str; 6] = ["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file"];
    let mut file = None;
    while let Some(word) = words.next() {
        if WITH_VALUE.contains(&word) {
            words.next();
        } else if word.starts_with('-') {
            continue;
        } else {
            file = Some(word);
            break;
        }
    }
    let file = file?.trim_matches(['"', '\'']).trim_start_matches("./");
    (!file.is_empty() && !file.contains("..") && !file.starts_with('/')).then(|| file.to_owned())
}

/// `file` as Node finds it from the project: as it is, with an extension,
/// or a folder's `index`. When nothing is there yet (a build writes it),
/// the name as given.
fn resolve(dir: &Path, file: &str) -> String {
    let file = file.trim_end_matches('/');
    if dir.join(file).is_file() {
        return file.to_owned();
    }
    for extension in ["js", "mjs", "cjs", "ts", "mts"] {
        let with = format!("{file}.{extension}");
        if dir.join(&with).is_file() {
            return with;
        }
    }
    for index in ["index.js", "index.mjs", "index.cjs", "index.ts"] {
        let inside = format!("{file}/{index}");
        if dir.join(&inside).is_file() {
            return inside;
        }
    }
    file.to_owned()
}

/// The file that starts the app, relative to the project: what `start`
/// runs, else `main`, else the usual names; why not, when it cannot be told.
fn app_entry(dir: &Path, package: &Value) -> Result<String, String> {
    let has_build = package["scripts"]["build"].is_string();
    let found = |file: String| {
        let file = resolve(dir, &file);
        // A file the build writes is there once it has run.
        if dir.join(&file).is_file() || has_build { Ok(file) } else { Err(format!("its start file `{file}` does not exist")) }
    };
    if let Some(start) = package["scripts"]["start"].as_str() {
        return match start_file(start) {
            Some(file) => found(file),
            None => Err(format!("g1t cannot tell which file its `start` script (`{start}`) runs")),
        };
    }
    if let Some(main) = package["main"].as_str().map(|m| m.trim_start_matches("./")).filter(|m| !m.is_empty()) {
        return found(main.to_owned());
    }
    [
        "server.js",
        "index.js",
        "app.js",
        "server.mjs",
        "index.mjs",
        "src/server.js",
        "src/index.js",
        "server.ts",
        "src/index.ts",
        "src/server.ts",
    ]
    .iter()
    .find(|file| dir.join(file).is_file())
    .map(|file| (*file).to_owned())
    .ok_or_else(|| "g1t cannot tell which file starts it: it has no `start` script or `main`".to_owned())
}

/// The app's own source files: JavaScript and TypeScript outside the
/// folders that hold no code it runs, and not its tests or tools' configs.
fn sources(dir: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, top: bool, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            if out.len() >= MAX_SOURCES {
                return;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if !name.starts_with('.') && !SKIPPED_DIRS.contains(&name.as_str()) {
                    walk(&path, false, out);
                }
                continue;
            }
            let code = ["js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx"].iter().any(|e| name.ends_with(&format!(".{e}")));
            let tooling =
                [".test.", ".spec.", ".config.", ".d.ts"].iter().any(|part| name.contains(part)) || (top && name.starts_with("eslint"));
            if kind.is_file() && code && !tooling && entry.metadata().is_ok_and(|m| m.len() <= MAX_SOURCE_BYTES) {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, true, &mut out);
    out.sort();
    out
}

/// `app.use(express.static("public"))`, unmounted, with the folder as a
/// literal (or `path.join(__dirname, "public")`): the folder, relative to
/// the file it is in or the project.
/// Each with what of `text` is left once it is taken out.
fn static_folders(pattern: &Regex, text: &str) -> (Vec<(bool, String)>, String) {
    let folders = pattern.captures_iter(text).map(|c| (c.get(1).is_some(), c[2].to_owned())).collect();
    (folders, pattern.replace_all(text, ".use(").into_owned())
}

/// `app.use(express.static("<folder>"))`, as `static_folders` reads it.
fn static_pattern() -> Regex {
    Regex::new(
        r#"\.use\(\s*(?:express\.static|serveStatic|serve)\(\s*(path\.(?:join|resolve)\(\s*__dirname\s*,\s*)?["'`]\.?/?([\w./-]*?)/?["'`]\s*[,)]"#,
    )
    .expect("a valid pattern")
}

/// What to make of the project at `dir`, a Node.js server (container.rs's
/// `node_server` found it): how it runs as a Worker, or why it cannot.
pub(crate) fn plan(dir: &Path) -> Plan {
    let Some(package) = std::fs::read_to_string(dir.join("package.json")).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok())
    else {
        return Plan::Blocked("its package.json could not be read".to_owned());
    };
    if let Some(addon) = NATIVE_ADDONS.iter().find(|name| has_dependency(&package, name)) {
        return Plan::Blocked(format!("it depends on `{addon}`, which builds native code a Worker cannot load"));
    }
    if let Some((_, why)) = BLOCKING_PACKAGES.iter().find(|(name, _)| has_dependency(&package, name)) {
        return Plan::Blocked((*why).to_owned());
    }
    let entry = match app_entry(dir, &package) {
        Ok(entry) => entry,
        Err(why) => return Plan::Blocked(why),
    };
    let blocking: Vec<(Regex, &str)> =
        BLOCKING_CODE.iter().map(|(pattern, why)| (Regex::new(pattern).expect("a valid pattern"), *why)).collect();
    let served = static_pattern();
    let mut assets: Option<String> = None;
    for file in sources(dir) {
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let relative = file.strip_prefix(dir).unwrap_or(&file).to_string_lossy().replace('\\', "/");
        // Each folder served the one way g1t can serve, taken out before
        // the rest is looked at.
        let (folders, rest) = static_folders(&served, &text);
        for (from_file, folder) in folders {
            let base = if from_file { Path::new(&relative).parent().map(Path::to_path_buf).unwrap_or_default() } else { PathBuf::new() };
            let folder = base.join(folder.trim_end_matches('/')).to_string_lossy().replace('\\', "/");
            let folder = if folder.is_empty() { ".".to_owned() } else { folder };
            if folder == "." || !dir.join(&folder).is_dir() {
                return Plan::Blocked(format!("it serves the folder `{folder}` from disk, which g1t cannot serve for it"));
            }
            if assets.as_ref().is_some_and(|served| *served != folder) {
                return Plan::Blocked("it serves more than one folder from disk".to_owned());
            }
            assets = Some(folder);
        }
        if let Some((pattern, why)) = blocking.iter().find(|(pattern, _)| pattern.is_match(&rest)) {
            let found = pattern.find(&rest).map(|m| m.as_str().trim().to_owned()).unwrap_or_default();
            return Plan::Blocked(format!("{why} (`{found}` in {relative})"));
        }
    }
    Plan::Worker(NodeWorker {
        name: server_name(&package),
        entry,
        build: package["scripts"]["build"].is_string().then(|| "npm run build".to_owned()),
        assets,
    })
}

/// The project as a Worker whatever `plan` found, for **Build as** set to
/// Workers: none when the file that starts it cannot be told.
pub(crate) fn forced(dir: &Path) -> Option<NodeWorker> {
    let package: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).ok()?).ok()?;
    let entry = app_entry(dir, &package).ok()?;
    Some(NodeWorker {
        name: server_name(&package),
        entry,
        build: package["scripts"]["build"].is_string().then(|| "npm run build".to_owned()),
        assets: None,
    })
}

/// Runs before the app's own code: keeps the servers it starts, has
/// `listen` take no address (on Workers, `listen` takes a port or nothing,
/// and the port only names the server), sets `PORT` for apps that read it,
/// and keeps the runtime's `Request` and `Response`, which some packages
/// (`@hono/node-server`) replace with their own.
pub(crate) const PRELUDE: &str = r#"// Written by g1t: runs before the app's own code.
import http from "node:http";
globalThis.__g1tServers = [];
globalThis.__g1tGlobals = { Request: globalThis.Request, Response: globalThis.Response };
process.env.PORT ??= "8080";
const keep = (server) => {
  if (!globalThis.__g1tServers.includes(server)) globalThis.__g1tServers.push(server);
  return server;
};
const createServer = http.createServer;
http.createServer = function (...args) {
  return keep(createServer.apply(this, args));
};
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  keep(this);
  return listen.call(this, args.find((arg) => typeof arg === "function"));
};
"#;

/// What the Worker's entry answers with when the app started no server.
pub(crate) const NO_SERVER: &str = "The app started no HTTP server: it never called listen().";

/// The Worker's entry: the prelude, then the app at `app` (an absolute
/// path), served by its default export's `fetch` when it has one, else by
/// `httpServerHandler` with the last server it started.
pub(crate) fn entry_module(app: &Path) -> String {
    let app = serde_json::to_string(&app.to_string_lossy().replace('\\', "/")).expect("a string");
    let no_server = serde_json::to_string(NO_SERVER).expect("a string");
    format!(
        r#"// Written by g1t: runs this Node.js app as a Worker.
import "./g1t-prelude.mjs";
import {{ httpServerHandler }} from "cloudflare:node";
import * as app from {app};

const {{ Response: NativeResponse }} = globalThis.__g1tGlobals;
const own = app.default && typeof app.default.fetch === "function" ? app.default : null;
let handler;

// A response made with a replaced Response class, as the runtime's own.
async function native(answer) {{
  const response = await answer;
  if (Object.getPrototypeOf(response) === NativeResponse.prototype) return response;
  return new NativeResponse(response.body, {{ status: response.status, statusText: response.statusText, headers: response.headers }});
}}

export default {{
  fetch(request, env, ctx) {{
    if (own) return native(own.fetch(request, env, ctx));
    const server = globalThis.__g1tServers.at(-1);
    if (!server) return new NativeResponse({no_server}, {{ status: 500 }});
    handler ??= httpServerHandler(server);
    return handler.fetch(request, env, ctx);
  }},
}};
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("g1t-node-worker-{name}-{}", std::process::id()));
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
    fn the_start_file_is_what_start_runs() {
        assert_eq!(start_file("node server.js").as_deref(), Some("server.js"));
        assert_eq!(start_file("NODE_ENV=production node --enable-source-maps ./dist/index.js").as_deref(), Some("dist/index.js"));
        assert_eq!(start_file("cross-env NODE_ENV=production node -r dotenv/config src/app.js").as_deref(), Some("src/app.js"));
        assert_eq!(start_file("npm run build && node build/server.mjs").as_deref(), Some("build/server.mjs"));
        assert_eq!(start_file("tsx src/index.ts").as_deref(), Some("src/index.ts"));
        assert_eq!(start_file("nest start"), None);
        assert_eq!(start_file("pm2-runtime start ecosystem.config.js"), None);
        assert_eq!(start_file("node ../x.js"), None);
    }

    #[test]
    fn an_express_server_runs_as_a_worker() {
        let dir = project(
            "express",
            &[
                ("package.json", r#"{ "scripts": { "start": "node server" }, "dependencies": { "express": "5" } }"#),
                (
                    "server.js",
                    "const app = require('express')();\napp.get('/', (req, res) => res.send('hi'));\napp.listen(process.env.PORT || 3000);\n",
                ),
            ],
        );
        assert_eq!(plan(&dir), Plan::Worker(NodeWorker { name: "Express", entry: "server.js".into(), build: None, assets: None }));
        assert!(entry_module(&dir.join("server.js")).contains("httpServerHandler(server)"));
    }

    #[test]
    fn a_folder_it_serves_becomes_the_workers_assets() {
        let dir = project(
            "assets",
            &[
                ("package.json", r#"{ "main": "src/app.js", "scripts": { "build": "tsc" }, "dependencies": { "express": "5" } }"#),
                ("src/app.js", "app.use(express.static(path.join(__dirname, 'www')));\napp.listen(8080);\n"),
                ("src/www/index.html", ""),
            ],
        );
        let Plan::Worker(worker) = plan(&dir) else { panic!("{:?}", plan(&dir)) };
        assert_eq!((worker.assets.as_deref(), worker.build.as_deref()), (Some("src/www"), Some("npm run build")));
        // Mounted under a path, it is served from disk.
        let mounted = project(
            "mounted",
            &[
                ("package.json", r#"{ "main": "app.js", "dependencies": { "express": "5" } }"#),
                ("app.js", "app.use('/static', express.static('public'));\n"),
                ("public/a.css", ""),
            ],
        );
        assert!(matches!(plan(&mounted), Plan::Blocked(why) if why.contains("serves files from disk")));
        // As is a folder named by a variable, beside one g1t can serve.
        let named = project(
            "named",
            &[
                ("package.json", r#"{ "main": "app.js", "dependencies": { "express": "5" } }"#),
                ("app.js", "app.use(express.static('public'));\napp.use(express.static(uploads));\n"),
                ("public/a.css", ""),
            ],
        );
        assert!(matches!(plan(&named), Plan::Blocked(why) if why.contains("`express.static(` in app.js")));
    }

    #[test]
    fn what_a_worker_cannot_do_is_found_first() {
        /// A project, and a phrase why it cannot run as a Worker says.
        type Case = (&'static str, &'static [(&'static str, &'static str)], &'static str);
        let cases: [Case; 6] = [
            (
                "addon",
                &[("package.json", r#"{ "main": "a.js", "dependencies": { "express": "5", "better-sqlite3": "12" } }"#), ("a.js", "")],
                "`better-sqlite3`",
            ),
            ("fastify", &[("package.json", r#"{ "main": "a.js", "dependencies": { "fastify": "5" } }"#), ("a.js", "")], "Fastify"),
            (
                "spawn",
                &[
                    ("package.json", r#"{ "main": "a.js", "dependencies": { "koa": "3" } }"#),
                    ("a.js", "const { spawn } = require('node:child_process');"),
                ],
                "child_process",
            ),
            (
                "ws",
                &[
                    ("package.json", r#"{ "main": "a.js", "dependencies": { "express": "5", "ws": "8" } }"#),
                    ("a.js", "new WebSocketServer({ server })"),
                ],
                "`upgrade`",
            ),
            (
                "views",
                &[
                    ("package.json", r#"{ "main": "a.js", "dependencies": { "express": "5" } }"#),
                    ("a.js", ""),
                    ("lib/routes.js", "res.render('home')"),
                ],
                "lib/routes.js",
            ),
            (
                "start",
                &[("package.json", r#"{ "scripts": { "start": "nest start" }, "dependencies": { "express": "5" } }"#)],
                "`nest start`",
            ),
        ];
        for (name, files, phrase) in cases {
            let dir = project(name, files);
            match plan(&dir) {
                Plan::Blocked(why) => assert!(why.contains(phrase), "{name}: {why}"),
                other => panic!("{name}: {other:?}"),
            }
        }
        // Tests and scripts are not the server's code.
        let tests = project(
            "tests-only",
            &[
                ("package.json", r#"{ "main": "a.js", "dependencies": { "express": "5" } }"#),
                ("a.js", ""),
                ("test/a.test.js", "readFileSync('x')"),
                ("scripts/seed.js", "writeFileSync('x')"),
            ],
        );
        assert!(matches!(plan(&tests), Plan::Worker(_)));
    }
}
