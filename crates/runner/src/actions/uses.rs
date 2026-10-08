//! `uses:` steps: `actions/checkout` done natively against g1t, actions
//! fetched from another repository on g1t (or else GitHub) and run as they are (JavaScript, composite and
//! Docker), `docker://` images, and a few of GitHub's own whose services
//! g1t does not have yet.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use g1t_actions::expr;
use g1t_actions::workflow::yaml_to_json;
use serde_json::{Map, Value, json};

use super::containers::{self, DockerRun};
use super::files::StepFiles;
use super::process::{self, Commands, Ended};
use super::{Frame, Job, Post, PostRun};

const ACTIONS_DIR: &str = "/home/runner/_actions";

/// Where an action comes from.
enum Source {
    Local(PathBuf),
    /// Another repository: on g1t when g1t has it and this one may use
    /// it, otherwise on GitHub.
    GitHub { owner: String, repo: String, path: String, git_ref: String },
}

fn safe(part: &str) -> bool {
    !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/')) && !part.contains("..")
}

impl Job {
    /// Runs a git command, logging it; the credential header is never logged.
    fn git(&mut self, dir: &Path, args: &[&str], auth: Option<&str>) -> bool {
        let shown: Vec<&str> = args.to_vec();
        self.log.line(&format!("[command]git {}", shown.join(" ")));
        let mut command = Command::new("git");
        command.current_dir(dir);
        if let Some(header) = auth {
            command.args(["-c", &format!("http.extraheader={header}")]);
        }
        command.args(args).env("GIT_TERMINAL_PROMPT", "0");
        let mut commands = Commands::default();
        matches!(process::run(command, Duration::from_secs(600).min(self.remaining_time()), &mut self.log, &mut commands), Ok(Ended::Exited(0)))
    }

    /// A fetch, tried again after a short wait when it fails: a transfer
    /// cut short on the way ("transfer closed with N bytes remaining") is
    /// over by the next try. Three tries in all, as actions/checkout does.
    fn fetch_retrying(&mut self, dir: &Path, args: &[&str], auth: Option<&str>) -> bool {
        for (attempt, wait) in [0u64, 2, 5].into_iter().enumerate() {
            if attempt > 0 {
                self.log.line(&format!("The fetch failed; trying again in {wait} s ({} of 3).", attempt + 1));
                std::thread::sleep(Duration::from_secs(wait));
            }
            if self.git(dir, args, auth) {
                return true;
            }
        }
        false
    }

    /// `actions/checkout`, against g1t.
    fn checkout(&mut self, with: &BTreeMap<String, String>) -> (bool, BTreeMap<String, String>) {
        let checkout = self.spec["checkout"].clone();
        let own = checkout["repository"].as_str().unwrap_or_default().to_owned();
        let server = self.contexts["github"]["server_url"].as_str().unwrap_or("https://g1t.sh").to_owned();
        let repository = with.get("repository").filter(|r| !r.is_empty()).cloned().unwrap_or(own.clone());
        let same = repository.eq_ignore_ascii_case(&own);
        let token = with.get("token").filter(|t| !t.is_empty()).cloned().or_else(|| checkout["token"].as_str().map(str::to_owned)).unwrap_or_default();
        let url = if same { checkout["url"].as_str().unwrap_or_default().to_owned() } else { format!("{server}/{repository}.git") };
        let path = with.get("path").filter(|p| !p.is_empty()).map_or(self.workspace.clone(), |p| self.workspace.join(p));
        let depth: u32 = with.get("fetch-depth").and_then(|d| d.parse().ok()).unwrap_or(1);
        let wanted_ref = with.get("ref").filter(|r| !r.is_empty()).cloned();
        let auth = (!token.is_empty()).then(|| format!("AUTHORIZATION: basic {}", STANDARD.encode(format!("x-access-token:{token}"))));

        self.log.line(&format!("Checking out {repository} into {}", path.display()));
        if path.exists() {
            let _ = std::fs::remove_dir_all(&path);
        }
        if let Err(error) = std::fs::create_dir_all(&path) {
            self.log.line(&format!("##[error]Could not make {}: {error}", path.display()));
            return (false, BTreeMap::new());
        }
        let _ = Command::new("git").args(["config", "--global", "--add", "safe.directory", "*"]).status();
        if !self.git(&path, &["init", "--quiet"], None) || !self.git(&path, &["remote", "add", "origin", &url], None) {
            return (false, BTreeMap::new());
        }

        // What to fetch, and which commit to end up on.
        let run_ref = checkout["ref"].as_str().unwrap_or_default().to_owned();
        let run_sha = checkout["sha"].as_str().unwrap_or_default().to_owned();
        let is_sha = |r: &str| r.len() == 40 && r.chars().all(|c| c.is_ascii_hexdigit());
        let (fetch, sha, branch): (String, Option<String>, Option<String>) = match &wanted_ref {
            Some(r) if is_sha(r) => ("HEAD".into(), Some(r.clone()), None),
            Some(r) if r.starts_with("refs/") => (r.clone(), None, r.strip_prefix("refs/heads/").map(str::to_owned)),
            Some(r) => (r.clone(), None, Some(r.clone())),
            // A pull request's merge ref, or no ref at all (a deployment of
            // a bare commit): the commit itself.
            None if same && (run_ref.starts_with("refs/pull/") || run_ref.is_empty()) => ("HEAD".into(), Some(run_sha.clone()), None),
            None if same => (run_ref.clone(), Some(run_sha.clone()), run_ref.strip_prefix("refs/heads/").map(str::to_owned)),
            None => ("HEAD".into(), None, None),
        };
        let depth_arg = format!("--depth={depth}");
        let mut args = vec!["fetch", "--no-tags", "--prune", "--quiet"];
        if depth > 0 {
            args.push(&depth_arg);
        }
        if with.get("fetch-tags").is_some_and(|t| t == "true") {
            args.retain(|a| *a != "--no-tags");
        }
        args.push("origin");
        args.push(&fetch);
        if !self.fetch_retrying(&path, &args, auth.as_deref()) {
            self.log.line(&format!("##[error]Could not fetch {fetch} from {repository}."));
            return (false, BTreeMap::new());
        }
        let target = sha.clone().unwrap_or_else(|| "FETCH_HEAD".into());
        // The commit may be further back than a shallow fetch reaches: the
        // branch moved on after the run began, say. Ask for the commit
        // itself, and failing that the whole history; a plain fetch never
        // reaches past a shallow boundary.
        let has = |target: &str| Command::new("git").current_dir(&path).args(["cat-file", "-e", &format!("{target}^{{commit}}")]).status().is_ok_and(|s| s.success());
        if !has(&target) {
            let by_sha = sha.as_deref().is_some_and(|sha| {
                let mut args = vec!["fetch", "--no-tags", "--quiet"];
                if depth > 0 {
                    args.push(&depth_arg);
                }
                args.extend(["origin", sha]);
                self.git(&path, &args, auth.as_deref()) && has(sha)
            });
            let shallow = path.join(".git").join("shallow").exists();
            let deepen: &[&str] = if shallow { &["fetch", "--no-tags", "--quiet", "--unshallow", "origin"] } else { &["fetch", "--no-tags", "--quiet", "origin"] };
            if !by_sha && !self.fetch_retrying(&path, deepen, auth.as_deref()) {
                return (false, BTreeMap::new());
            }
        }
        let checked_out = match &branch {
            Some(branch) => self.git(&path, &["checkout", "--quiet", "--force", "-B", branch, &target], None),
            None => self.git(&path, &["checkout", "--quiet", "--force", "--detach", &target], None),
        };
        if !checked_out {
            return (false, BTreeMap::new());
        }
        if with.get("persist-credentials").is_none_or(|p| p != "false")
            && let Some(header) = &auth
        {
            let key = format!("http.{server}/.extraheader");
            let _ = Command::new("git").current_dir(&path).args(["config", "--local", &key, header]).status();
        }
        if let Some(submodules) = with.get("submodules").filter(|s| *s == "true" || *s == "recursive") {
            let mut args = vec!["submodule", "update", "--init", "--quiet"];
            if submodules == "recursive" {
                args.push("--recursive");
            }
            if !self.git(&path, &args, auth.as_deref()) {
                self.log.line("##[warning]Submodules could not all be checked out; only those hosted on g1t can be.");
            }
        }
        if with.get("lfs").is_some_and(|l| l == "true") {
            self.log.line("##[warning]Git LFS files are not fetched on g1t yet.");
        }
        let commit = Command::new("git").current_dir(&path).args(["rev-parse", "HEAD"]).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned()).unwrap_or_default();
        self.log.line(&format!("Checked out {commit}"));
        let mut outputs = BTreeMap::new();
        outputs.insert("ref".into(), wanted_ref.unwrap_or(run_ref));
        outputs.insert("commit".into(), commit);
        (true, outputs)
    }

    /// Fetches another repository's action, once per job: from g1t when
    /// g1t has the repository and this one may use it, otherwise from
    /// GitHub. A private repository on g1t that may not be used here fails
    /// the step, saying why, rather than fetching something else by its
    /// name.
    fn fetch_remote_action(&mut self, owner: &str, repo: &str, git_ref: &str) -> Option<PathBuf> {
        let on_g1t = super::paths::under_home(ACTIONS_DIR).join("_g1t").join(owner).join(repo).join(git_ref);
        let on_github = super::paths::under_home(ACTIONS_DIR).join(owner).join(repo).join(git_ref);
        for dir in [&on_g1t, &on_github] {
            if dir.join(".g1t-fetched").exists() {
                return Some(dir.clone());
            }
        }
        if !(safe(owner) && safe(repo) && safe(git_ref)) {
            self.log.line(&format!("##[error]`{owner}/{repo}@{git_ref}` is not a name g1t can fetch."));
            return None;
        }
        match self.log.api.action(&format!("{owner}/{repo}"), git_ref) {
            Ok(found) if found["source"] == "g1t" => self.fetch_g1t_action(&on_g1t, owner, repo, git_ref, &found),
            Ok(_) => self.fetch_action(owner, repo, git_ref),
            Err((true, why)) => {
                self.log.line(&format!("##[error]{why}"));
                None
            }
            Err((false, why)) => {
                self.log.line(&format!("##[warning]g1t could not say where {owner}/{repo} is ({why}); fetching it from GitHub."));
                self.fetch_action(owner, repo, git_ref)
            }
        }
    }

    /// Fetches an action from a repository on g1t, at its ref, with the
    /// read-only token g1t gave for it when it is private.
    fn fetch_g1t_action(&mut self, dir: &Path, owner: &str, repo: &str, git_ref: &str, found: &Value) -> Option<PathBuf> {
        let url = found["url"].as_str().unwrap_or_default().to_owned();
        let token = found["token"].as_str().filter(|token| !token.is_empty()).map(str::to_owned);
        if let Some(token) = &token {
            self.log.add_mask(token);
        }
        let auth = token.map(|token| format!("AUTHORIZATION: basic {}", STANDARD.encode(format!("x-access-token:{token}"))));
        self.log.line(&format!("Download action repository '{owner}/{repo}@{git_ref}' from g1t"));
        let _ = std::fs::remove_dir_all(dir);
        if std::fs::create_dir_all(dir).is_err() || !self.git(dir, &["init", "--quiet"], None) || !self.git(dir, &["remote", "add", "origin", &url], None) {
            return None;
        }
        // A branch or tag at its tip; a commit may need the history.
        let shallow = self.fetch_retrying(dir, &["fetch", "--depth=1", "--no-tags", "--quiet", "origin", git_ref], auth.as_deref());
        let checked_out = if shallow {
            self.git(dir, &["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], None)
        } else {
            self.fetch_retrying(dir, &["fetch", "--quiet", "--tags", "origin", "+refs/heads/*:refs/remotes/origin/*"], auth.as_deref())
                && self.git(dir, &["checkout", "--quiet", "--force", "--detach", git_ref], None)
        };
        if !checked_out {
            self.log.line(&format!("##[error]Could not fetch {owner}/{repo}@{git_ref} from g1t: is {git_ref} a branch, tag or commit there?"));
            let _ = std::fs::remove_dir_all(dir);
            return None;
        }
        let _ = std::fs::write(dir.join(".g1t-fetched"), "");
        Some(dir.to_path_buf())
    }

    /// Fetches an action from GitHub, once per job.
    fn fetch_action(&mut self, owner: &str, repo: &str, git_ref: &str) -> Option<PathBuf> {
        let dir = super::paths::under_home(ACTIONS_DIR).join(owner).join(repo).join(git_ref);
        if dir.join(".g1t-fetched").exists() {
            return Some(dir);
        }
        if !(safe(owner) && safe(repo) && safe(git_ref)) {
            self.log.line(&format!("##[error]`{owner}/{repo}@{git_ref}` is not a name g1t can fetch."));
            return None;
        }
        self.log.line(&format!("Download action repository '{owner}/{repo}@{git_ref}'"));
        let _ = std::fs::create_dir_all(&dir);
        let url = format!("https://codeload.github.com/{owner}/{repo}/tar.gz/{git_ref}");
        let script = format!("set -o pipefail; curl -fsSL --retry 3 '{url}' | tar -xz -C '{}' --strip-components=1", dir.display());
        let mut command = Command::new("bash");
        command.args(["-c", &script]);
        let mut commands = Commands::default();
        match process::run(command, Duration::from_secs(300).min(self.remaining_time()), &mut self.log, &mut commands) {
            Ok(Ended::Exited(0)) => {
                let _ = std::fs::write(dir.join(".g1t-fetched"), "");
                Some(dir)
            }
            _ => {
                self.log.line(&format!("##[error]Could not download {owner}/{repo}@{git_ref} from GitHub."));
                let _ = std::fs::remove_dir_all(&dir);
                None
            }
        }
    }

    /// Runs a JavaScript file of an action with Node.
    pub(crate) fn run_node(&mut self, action_dir: &Path, script: &str, env: &BTreeMap<String, String>) -> bool {
        let id = format!("node{}", super::rand_id());
        let Ok(files) = StepFiles::new(&self.temp, &id) else { return false };
        let full = self.process_env(env, &files);
        let script_path = action_dir.join(script);
        // In a job container whose image runs the runner's Node, the action
        // runs there, as on GitHub.
        let in_container = self.container.as_ref().filter(|c| c.node).map(|c| c.path.clone()).and_then(|image_path| {
            let inside = self.container_env(env, full.clone(), &image_path);
            self.in_container(containers::CONTAINER_NODE, &[script_path.display().to_string()], &self.workspace, inside)
        });
        let command = match in_container {
            Some(command) => command,
            None => {
                let mut command = Command::new("node");
                command.arg(&script_path).current_dir(&self.workspace).env_clear().envs(full);
                command
            }
        };
        let mut commands = Commands {
            debug: false,
            ..Commands::default()
        };
        let ended = process::run(command, Duration::from_secs(6 * 3600).min(self.deadline_left()), &mut self.log, &mut commands);
        let ok = matches!(ended, Ok(Ended::Exited(0)));
        match ended {
            Ok(Ended::Exited(code)) if code != 0 => self.log.line(&format!("##[error]The action exited with code {code}.")),
            Ok(Ended::TimedOut) => self.log.line("##[error]The action ran past its time limit and was stopped."),
            _ => {}
        }
        let (outputs, state) = self.absorb(&files, &commands);
        self.last_node_outputs = outputs;
        self.last_node_state = state;
        ok
    }

    fn deadline_left(&self) -> Duration {
        self.remaining_time()
    }

    /// Runs a `uses:` step. Returns whether it succeeded, and its outputs.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn uses(
        &mut self,
        uses: &str,
        with: &BTreeMap<String, String>,
        env: &BTreeMap<String, String>,
        frame: &Frame,
        title: &str,
        id: Option<&str>,
        _timeout: Duration,
    ) -> (bool, BTreeMap<String, String>) {
        let uses = uses.trim();
        if let Some(image) = uses.strip_prefix("docker://") {
            // `with.args` and `with.entrypoint` are the container's; every
            // input is also an `INPUT_` variable, as on GitHub.
            let mut step_env = env.clone();
            for (input, value) in with {
                step_env.insert(format!("INPUT_{}", input.replace(' ', "_").to_ascii_uppercase()), value.clone());
            }
            let run = DockerRun {
                image: image.to_owned(),
                entrypoint: with.get("entrypoint").filter(|e| !e.is_empty()).cloned(),
                args: with.get("args").map(|a| containers::split_words(a)).unwrap_or_default(),
                env: step_env,
            };
            let (ok, outputs, _) = self.run_docker(&run);
            return (ok, outputs);
        }
        let (name, git_ref) = uses.split_once('@').unwrap_or((uses, ""));
        let lower = name.to_ascii_lowercase();
        if lower == "docker/setup-buildx-action" && self.docker_hosted {
            return self.setup_buildx(with);
        }
        match lower.as_str() {
            "actions/checkout" => return self.checkout(with),
            "actions/upload-artifact" => return self.upload_artifact(with),
            "actions/upload-artifact/merge" => return self.merge_artifacts(with),
            "actions/download-artifact" => return self.download_artifact(with),
            "actions/cache" => return self.cache(with, true, title),
            "actions/cache/restore" => return self.cache(with, false, title),
            "actions/cache/save" => return self.cache_save_now(with),
            _ => {}
        }
        let source = if let Some(local) = name.strip_prefix("./") {
            // A repository moved from GitHub renamed `.github` to `.g1t`, but
            // its workflows still say `./.github/actions/…`.
            let mut dir = self.workspace.join(local);
            if let Some(rest) = local.strip_prefix(".github/")
                && !dir.exists()
            {
                dir = self.workspace.join(".g1t").join(rest);
            }
            Source::Local(dir)
        } else {
            let mut parts = name.splitn(3, '/');
            let (Some(owner), Some(repo)) = (parts.next(), parts.next()) else {
                self.log.line(&format!("##[error]`{uses}` is not an action: use owner/repo@ref, owner/repo/path@ref, or ./path."));
                return (false, BTreeMap::new());
            };
            if git_ref.is_empty() {
                self.log.line(&format!("##[error]`{uses}` needs a version, such as @v4."));
                return (false, BTreeMap::new());
            }
            Source::GitHub {
                owner: owner.to_owned(),
                repo: repo.to_owned(),
                path: parts.next().unwrap_or_default().to_owned(),
                git_ref: git_ref.to_owned(),
            }
        };
        let (dir, repository) = match &source {
            Source::Local(dir) => (dir.clone(), String::new()),
            Source::GitHub { owner, repo, path, git_ref } => match self.fetch_remote_action(owner, repo, git_ref) {
                Some(root) => (if path.is_empty() { root } else { root.join(path) }, format!("{owner}/{repo}")),
                None => return (false, BTreeMap::new()),
            },
        };
        let manifest = ["action.yml", "action.yaml"].iter().map(|f| dir.join(f)).find(|p| p.exists());
        let Some(manifest) = manifest else {
            self.log.line(&format!("##[error]`{uses}` has no action.yml."));
            return (false, BTreeMap::new());
        };
        let action = match std::fs::read_to_string(&manifest).ok().and_then(|text| serde_yaml::from_str::<serde_yaml::Value>(&text).ok()) {
            Some(yaml) => yaml_to_json(&yaml),
            None => {
                self.log.line(&format!("##[error]`{uses}`: its action.yml does not read."));
                return (false, BTreeMap::new());
            }
        };

        // Inputs: what the step gives, else the action's defaults.
        let env_context = env.clone();
        let contexts = self.contexts_for(frame, &env_context);
        let mut inputs: BTreeMap<String, String> = BTreeMap::new();
        if let Some(Value::Object(declared)) = action.get("inputs") {
            for (input, spec) in declared {
                let given = with.iter().find(|(k, _)| k.eq_ignore_ascii_case(input)).map(|(_, v)| v.clone());
                let value = match given {
                    Some(value) => value,
                    None => match spec.get("default") {
                        Some(default) => {
                            let default = self.with_scope(&contexts, |scope| expr::interpolate_value(default, scope)).unwrap_or(Value::Null);
                            expr::to_text(&default)
                        }
                        None => String::new(),
                    },
                };
                inputs.insert(input.clone(), value);
            }
        }
        for (key, value) in with {
            if !inputs.keys().any(|k| k.eq_ignore_ascii_case(key)) {
                inputs.insert(key.clone(), value.clone());
            }
        }

        let runs = action.get("runs").cloned().unwrap_or(Value::Null);
        let using = runs.get("using").map(expr::to_text).unwrap_or_default().to_ascii_lowercase();
        let mut step_env = env.clone();
        step_env.insert("GITHUB_ACTION".into(), id.map_or_else(|| format!("__{}", repository.replace('/', "_")), str::to_owned));
        step_env.insert("GITHUB_ACTION_REPOSITORY".into(), repository.clone());
        step_env.insert("GITHUB_ACTION_REF".into(), git_ref.to_owned());
        step_env.insert("GITHUB_ACTION_PATH".into(), dir.display().to_string());

        if using.starts_with("node") {
            for (input, value) in &inputs {
                step_env.insert(format!("INPUT_{}", input.replace(' ', "_").to_ascii_uppercase()), value.clone());
            }
            let condition_of = |key: &str| runs.get(key).map(expr::to_text).unwrap_or_else(|| "always()".into());
            if let Some(pre) = runs.get("pre").map(expr::to_text) {
                let run_pre = self.with_scope(&contexts, |scope| expr::condition(&condition_of("pre-if"), scope)).unwrap_or(true);
                if run_pre && !self.run_node(&dir, &pre, &step_env) {
                    return (false, BTreeMap::new());
                }
            }
            let Some(main) = runs.get("main").map(expr::to_text) else {
                self.log.line(&format!("##[error]`{uses}` has no `runs.main`."));
                return (false, BTreeMap::new());
            };
            let ok = self.run_node(&dir, &main, &step_env);
            let outputs = std::mem::take(&mut self.last_node_outputs);
            let state = std::mem::take(&mut self.last_node_state);
            if let Some(post) = runs.get("post").map(expr::to_text) {
                let mut post_env = step_env.clone();
                for (name, value) in state {
                    post_env.insert(format!("STATE_{name}"), value);
                }
                self.posts.push(Post {
                    name: format!("Post {title}"),
                    condition: condition_of("post-if"),
                    env: post_env,
                    run: PostRun::Node { action_dir: dir.clone(), script: post },
                });
            }
            return (ok, outputs);
        }
        if using == "composite" {
            let mut inner = Frame {
                steps: Map::new(),
                inputs: Some(Value::Object(inputs.iter().map(|(k, v)| (k.clone(), json!(v))).collect())),
                action_path: Some(dir.display().to_string()),
                env: env.clone(),
            };
            let steps: Vec<Map<String, Value>> = runs.get("steps").and_then(Value::as_array).map(|s| s.iter().filter_map(|s| s.as_object().cloned()).collect()).unwrap_or_default();
            let was_failed = self.failed;
            // A composite's steps see their own success, not the job's.
            self.failed = false;
            let mut ok = true;
            for step in &steps {
                if !self.step(&mut inner, step, 0, false, &Map::new()) {
                    ok = false;
                }
            }
            let contexts = self.contexts_for(&inner, &inner.env.clone());
            let mut outputs = BTreeMap::new();
            if let Some(Value::Object(declared)) = action.get("outputs") {
                for (name, spec) in declared {
                    if let Some(value) = spec.get("value") {
                        let value = self.with_scope(&contexts, |scope| expr::interpolate_value(value, scope)).unwrap_or(Value::Null);
                        outputs.insert(name.clone(), expr::to_text(&value));
                    }
                }
            }
            self.failed = was_failed;
            return (ok, outputs);
        }
        if using == "docker" {
            return self.docker_action(uses, &dir, &runs, &inputs, &step_env, frame, title);
        }
        self.log.line(&format!("##[error]`{uses}` runs with `{using}`, which g1t does not know."));
        (false, BTreeMap::new())
    }

    /// A Docker action: its image built from its Dockerfile (or pulled,
    /// for `docker://`), then run with its `args`, `entrypoint` and `env`,
    /// its inputs as `INPUT_` variables, and `pre-entrypoint` and
    /// `post-entrypoint` around it.
    #[allow(clippy::too_many_arguments)]
    fn docker_action(
        &mut self,
        uses: &str,
        dir: &Path,
        runs: &Value,
        inputs: &BTreeMap<String, String>,
        step_env: &BTreeMap<String, String>,
        frame: &Frame,
        title: &str,
    ) -> (bool, BTreeMap<String, String>) {
        let image = runs.get("image").map(expr::to_text).unwrap_or_default();
        let image = if let Some(pulled) = image.strip_prefix("docker://") {
            pulled.to_owned()
        } else if image.is_empty() {
            self.log.line(&format!("##[error]`{uses}` has no `runs.image`."));
            return (false, BTreeMap::new());
        } else {
            match self.build_action_image(dir, &image, uses) {
                Some(tag) => tag,
                None => return (false, BTreeMap::new()),
            }
        };
        // `args` and `env` read with the action's own inputs.
        let mut env = step_env.clone();
        for (input, value) in inputs {
            env.insert(format!("INPUT_{}", input.replace(' ', "_").to_ascii_uppercase()), value.clone());
        }
        let mut scope_frame = frame.clone();
        scope_frame.inputs = Some(Value::Object(inputs.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
        let contexts = self.contexts_for(&scope_frame, &env);
        if let Some(Value::Object(own)) = runs.get("env") {
            for (name, value) in own {
                let value = self.with_scope(&contexts, |scope| expr::interpolate_value(value, scope)).unwrap_or(Value::Null);
                env.insert(name.clone(), expr::to_text(&value));
            }
        }
        let args: Vec<String> = match runs.get("args") {
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| {
                    let value = self.with_scope(&contexts, |scope| expr::interpolate_value(item, scope)).unwrap_or(Value::Null);
                    expr::to_text(&value)
                })
                .collect(),
            _ => Vec::new(),
        };
        let entry = |key: &str| runs.get(key).map(expr::to_text).filter(|e| !e.is_empty());
        if let Some(pre) = entry("pre-entrypoint") {
            let run = DockerRun { image: image.clone(), entrypoint: Some(pre), args: Vec::new(), env: env.clone() };
            if !self.run_docker(&run).0 {
                return (false, BTreeMap::new());
            }
        }
        let run = DockerRun { image: image.clone(), entrypoint: entry("entrypoint"), args, env: env.clone() };
        let (ok, outputs, state) = self.run_docker(&run);
        if let Some(post) = entry("post-entrypoint") {
            let mut post_env = env;
            for (name, value) in state {
                post_env.insert(format!("STATE_{name}"), value);
            }
            self.posts.push(Post {
                name: format!("Post {title}"),
                condition: runs.get("post-if").map(expr::to_text).unwrap_or_else(|| "always()".into()),
                env: BTreeMap::new(),
                run: PostRun::Docker(DockerRun { image, entrypoint: Some(post), args: Vec::new(), env: post_env }),
            });
        }
        (ok, outputs)
    }
}
