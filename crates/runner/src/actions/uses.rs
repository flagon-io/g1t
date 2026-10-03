//! `uses:` steps: `actions/checkout` done natively against g1t, actions
//! fetched from GitHub and run as they are (JavaScript and composite), and
//! a few of GitHub's own whose services g1t does not have yet.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use g1t_actions::expr;
use g1t_actions::workflow::yaml_to_json;
use serde_json::{Map, Value, json};

use super::files::StepFiles;
use super::process::{self, Commands, Ended};
use super::{Frame, Job, Post};

const ACTIONS_DIR: &str = "/home/runner/_actions";

/// Where an action comes from.
enum Source {
    Local(PathBuf),
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
        matches!(process::run(command, Duration::from_secs(600), &mut self.log, &mut commands), Ok(Ended::Exited(0)))
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
            None if same && run_ref.starts_with("refs/pull/") => ("HEAD".into(), Some(run_sha.clone()), None),
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
        if !self.git(&path, &args, auth.as_deref()) {
            self.log.line(&format!("##[error]Could not fetch {fetch} from {repository}."));
            return (false, BTreeMap::new());
        }
        let target = sha.clone().unwrap_or_else(|| "FETCH_HEAD".into());
        // The commit may be further back than a shallow fetch reaches.
        let present = Command::new("git").current_dir(&path).args(["cat-file", "-e", &format!("{target}^{{commit}}")]).status().is_ok_and(|s| s.success());
        if !present && !self.git(&path, &["fetch", "--no-tags", "--quiet", "origin"], auth.as_deref()) {
            return (false, BTreeMap::new());
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

    /// Fetches an action from GitHub, once per job.
    fn fetch_action(&mut self, owner: &str, repo: &str, git_ref: &str) -> Option<PathBuf> {
        let dir = Path::new(ACTIONS_DIR).join(owner).join(repo).join(git_ref);
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
        match process::run(command, Duration::from_secs(300), &mut self.log, &mut commands) {
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
        let mut command = Command::new("node");
        command.arg(action_dir.join(script)).current_dir(&self.workspace).env_clear().envs(self.process_env(env, &files));
        let mut commands = Commands {
            debug: false,
            ..Commands::default()
        };
        let ended = process::run(command, Duration::from_secs(6 * 3600).min(self.deadline_left()), &mut self.log, &mut commands);
        let ok = matches!(ended, Ok(Ended::Exited(0)));
        if let Ok(Ended::Exited(code)) = ended
            && code != 0
        {
            self.log.line(&format!("##[error]The action exited with code {code}."));
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
        if uses.starts_with("docker://") {
            self.log.line(&format!("##[error]`{uses}`: Docker actions do not run on g1t yet."));
            return (false, BTreeMap::new());
        }
        let (name, git_ref) = uses.split_once('@').unwrap_or((uses, ""));
        let lower = name.to_ascii_lowercase();
        match lower.as_str() {
            "actions/checkout" => return self.checkout(with),
            "actions/upload-artifact" => {
                self.log.line("##[warning]Artifacts are not kept on g1t yet: nothing was uploaded, and the job goes on.");
                return (true, BTreeMap::new());
            }
            "actions/download-artifact" => {
                self.log.line("##[error]Artifacts are not kept on g1t yet, so there is nothing to download.");
                return (false, BTreeMap::new());
            }
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
            Source::GitHub { owner, repo, path, git_ref } => match self.fetch_action(owner, repo, git_ref) {
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
                    action_dir: dir.clone(),
                    script: post,
                    condition: condition_of("post-if"),
                    env: post_env,
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
            self.log.line(&format!("##[error]`{uses}` is a Docker action, which does not run on g1t yet."));
            return (false, BTreeMap::new());
        }
        self.log.line(&format!("##[error]`{uses}` runs with `{using}`, which g1t does not know."));
        (false, BTreeMap::new())
    }
}
