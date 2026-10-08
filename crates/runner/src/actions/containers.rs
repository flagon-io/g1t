//! Containers a job asks for, as GitHub's runner starts them, with the
//! `docker` command: its `services:` (a database beside the steps), its
//! `container:` (every step run inside an image), `uses: docker://image`
//! steps and Docker actions (`runs.using: docker`).
//!
//! On g1t's machines the Engine is the job's own (crate::docker). Every
//! container shares the job's network there, so a service is reached at
//! `localhost:<port>` as on GitHub's runner, and by its name as from a job
//! container: the API proxy makes each service's name mean 127.0.0.1.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use g1t_actions::expr;
use serde_json::{Map, Value, json};

use super::files::StepFiles;
use super::process::{self, Commands, Ended};
use super::Job;

/// Set in a job a self-hosted runner started inside its `container:` image.
pub(crate) const IN_JOB_CONTAINER: &str = "G1T_JOB_CONTAINER";
/// Where a job container finds the runner's Node, for JavaScript actions.
pub(crate) const CONTAINER_NODE: &str = "/__e/node24/bin/node";
/// GitHub's folders inside a Docker action's container.
const GITHUB_WORKSPACE: &str = "/github/workspace";
const GITHUB_HOME: &str = "/github/home";
const GITHUB_WORKFLOW: &str = "/github/workflow";
const GITHUB_FILE_COMMANDS: &str = "/github/file_commands";

/// The job's own container, when it has `container:`.
pub(crate) struct JobContainer {
    pub(crate) id: String,
    /// `bash`, or `sh` in an image without it.
    pub(crate) shell: &'static str,
    /// Whether the runner's Node runs in it.
    pub(crate) node: bool,
    /// The image's own `PATH`.
    pub(crate) path: String,
}

/// A `services:` entry or `container:`, read.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ContainerSpec {
    pub(crate) image: String,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) ports: Vec<String>,
    pub(crate) volumes: Vec<String>,
    pub(crate) options: Vec<String>,
    pub(crate) credentials: Option<(String, String)>,
    pub(crate) command: Vec<String>,
    pub(crate) entrypoint: Option<String>,
}

/// Splits a command line as a shell would: words, with `'…'`, `"…"` and
/// `\` quoting. No variables are expanded.
pub(crate) fn split_words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                started = true;
                for c in chars.by_ref() {
                    if c == '\'' {
                        break;
                    }
                    word.push(c);
                }
            }
            '"' => {
                started = true;
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' if matches!(chars.peek(), Some('"' | '\\' | '$' | '`')) => word.push(chars.next().unwrap_or('\\')),
                        c => word.push(c),
                    }
                }
            }
            '\\' => {
                started = true;
                if let Some(next) = chars.next()
                    && next != '\n'
                {
                    word.push(next);
                }
            }
            c if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            c => {
                started = true;
                word.push(c);
            }
        }
    }
    if started {
        words.push(word);
    }
    words
}

fn texts(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().map(expr::to_text).filter(|s| !s.is_empty()).collect(),
        Some(Value::Null) | None => Vec::new(),
        Some(other) => vec![expr::to_text(other)].into_iter().filter(|s| !s.is_empty()).collect(),
    }
}

/// Reads a `services:` entry or `container:`, its expressions already
/// read: a string (the image) or a mapping.
pub(crate) fn container_spec(value: &Value) -> ContainerSpec {
    match value {
        Value::String(image) => ContainerSpec { image: image.trim().to_owned(), ..ContainerSpec::default() },
        Value::Object(fields) => ContainerSpec {
            image: fields.get("image").map(expr::to_text).unwrap_or_default().trim().to_owned(),
            env: fields
                .get("env")
                .and_then(Value::as_object)
                .map(|env| env.iter().map(|(k, v)| (k.clone(), expr::to_text(v))).collect())
                .unwrap_or_default(),
            ports: texts(fields.get("ports")),
            volumes: texts(fields.get("volumes")),
            options: fields.get("options").map(|o| split_words(&expr::to_text(o))).unwrap_or_default(),
            credentials: fields.get("credentials").and_then(Value::as_object).and_then(|c| {
                let username = c.get("username").map(expr::to_text).unwrap_or_default();
                let password = c.get("password").map(expr::to_text).unwrap_or_default();
                (!username.is_empty() || !password.is_empty()).then_some((username, password))
            }),
            command: fields.get("command").map(|c| split_words(&expr::to_text(c))).unwrap_or_default(),
            entrypoint: fields.get("entrypoint").map(expr::to_text).filter(|e| !e.is_empty()),
        },
        _ => ContainerSpec::default(),
    }
}

/// `job.services.<id>.ports`: each container port, and the host port it
/// is reached on. On g1t's machines a port left for Docker to choose is
/// the container's own.
pub(crate) fn port_map(ports: &[String]) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for port in ports {
        let without_protocol = port.split('/').next().unwrap_or(port);
        let parts: Vec<&str> = without_protocol.split(':').collect();
        let (host, container) = match parts.as_slice() {
            [container] => (*container, *container),
            [host, container] => (if host.is_empty() { *container } else { *host }, *container),
            [_, host, container] => (if host.is_empty() { *container } else { *host }, *container),
            _ => continue,
        };
        if !container.is_empty() {
            map.insert(container.to_owned(), host.to_owned());
        }
    }
    map
}

/// The registry an image is pulled from, for signing in with
/// `credentials:`.
pub(crate) fn registry_of(image: &str) -> String {
    match image.split_once('/') {
        Some((first, _)) if first.contains('.') || first.contains(':') || first == "localhost" => first.to_owned(),
        _ => "https://index.docker.io/v1/".to_owned(),
    }
}

/// A name for Docker from any text: lower case, letters, digits, `_`,
/// `.` and `-`.
pub(crate) fn docker_name(text: &str) -> String {
    let name: String = text
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') { c } else { '_' })
        .collect();
    name.trim_matches(['_', '.', '-']).chars().take(100).collect()
}

/// The `docker create` arguments of a container. `env` is passed by name
/// (`-e NAME`), its values in the command's environment, so secrets never
/// stand on a command line. `keep_alive`: a job container, which waits
/// while steps run in it.
pub(crate) fn create_args(name: &str, network: Option<&str>, alias: Option<&str>, spec: &ContainerSpec, mounts: &[(String, String)], keep_alive: bool) -> Vec<String> {
    let mut args: Vec<String> = vec!["create".into(), "--name".into(), name.into(), "--label".into(), "g1t-job".into()];
    if let Some(network) = network {
        args.extend(["--network".into(), network.into()]);
        if let Some(alias) = alias {
            args.extend(["--network-alias".into(), alias.into()]);
        }
    }
    for port in &spec.ports {
        args.extend(["-p".into(), port.clone()]);
    }
    for volume in &spec.volumes {
        args.extend(["-v".into(), volume.clone()]);
    }
    for (from, to) in mounts {
        args.extend(["-v".into(), format!("{from}:{to}")]);
    }
    for name in spec.env.keys() {
        args.extend(["-e".into(), name.clone()]);
    }
    args.extend(spec.options.iter().cloned());
    if keep_alive {
        args.extend(["--entrypoint".into(), "tail".into(), spec.image.clone(), "-f".into(), "/dev/null".into()]);
    } else {
        if let Some(entrypoint) = &spec.entrypoint {
            args.extend(["--entrypoint".into(), entrypoint.clone()]);
        }
        args.push(spec.image.clone());
        args.extend(spec.command.iter().cloned());
    }
    args
}

/// A Docker action's run, or a `docker://` step's.
#[derive(Clone, Debug)]
pub(crate) struct DockerRun {
    pub(crate) image: String,
    pub(crate) entrypoint: Option<String>,
    pub(crate) args: Vec<String>,
    /// The step's variables, `INPUT_*` included.
    pub(crate) env: BTreeMap<String, String>,
}

/// What a command line shows: secrets are passed by name, so nothing
/// needs hiding, but long lists are kept readable.
fn shown(args: &[String]) -> String {
    args.iter().map(|a| if a.contains(' ') || a.is_empty() { format!("'{a}'") } else { a.clone() }).collect::<Vec<_>>().join(" ")
}

impl Job {
    /// Runs `docker` with `args`, its output in the log. `env`: the
    /// variables it passes to a container by name.
    pub(crate) fn docker(&mut self, args: &[String], env: &BTreeMap<String, String>, timeout: Duration) -> bool {
        self.log.line(&format!("[command]docker {}", shown(args)));
        let mut command = Command::new("docker");
        command.args(args).env_clear().envs(self.docker_cli_env()).envs(env);
        let mut commands = Commands::default();
        matches!(process::run(command, timeout.min(self.remaining_time()), &mut self.log, &mut commands), Ok(Ended::Exited(0)))
    }

    /// What `docker` prints, or None if it fails.
    pub(crate) fn docker_output(&self, args: &[&str]) -> Option<String> {
        let output = Command::new("docker").args(args).env_clear().envs(self.docker_cli_env()).output().ok()?;
        output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    /// What the `docker` command itself needs of the sandbox's variables:
    /// where it is, where its config is, and how to reach the Engine.
    fn docker_cli_env(&self) -> BTreeMap<String, String> {
        ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]
            .iter()
            .filter_map(|name| self.base_env_value(name).map(|value| (name.to_string(), value)))
            .collect()
    }

    /// Makes sure Docker answers before a job's containers start: the
    /// job's own Engine, on g1t's machines.
    fn docker_ready(&mut self) -> bool {
        if self.docker_hosted {
            let started = crate::docker::engine::ensure_started();
            self.log_docker_notes();
            // Why it could not start is among the notes just logged.
            return started.is_ok();
        }
        if self.docker_output(&["version", "--format", "{{.Server.Version}}"]).is_some() {
            return true;
        }
        self.log.line("##[error]This job needs Docker (`services`, `container` or a Docker action), and Docker does not answer here. On a self-hosted runner, run the runner directly on a machine with Docker (`--no-docker`).");
        false
    }

    pub(crate) fn log_docker_notes(&mut self) {
        for line in crate::docker::take_notes() {
            self.log.line(&line);
        }
    }

    /// Pulls an image, signed in with `credentials` if it has them.
    fn pull(&mut self, image: &str, credentials: Option<&(String, String)>) -> bool {
        let Some((username, password)) = credentials else {
            return self.docker(&["pull".into(), image.into()], &BTreeMap::new(), Duration::from_secs(1800));
        };
        // A config of its own, so the credentials go no further than this pull.
        let config = self.temp.join(format!("docker-config-{:x}", super::rand_id()));
        let _ = std::fs::create_dir_all(&config);
        let registry = registry_of(image);
        let config_text = config.display().to_string();
        self.log.line(&format!("[command]docker --config {config_text} login {registry} --username *** --password-stdin"));
        let login = Command::new("docker")
            .args(["--config", &config_text, "login", &registry, "--username", username, "--password-stdin"])
            .env_clear()
            .envs(self.docker_cli_env())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(password.as_bytes());
                }
                child.wait_with_output()
            });
        let ok = match login {
            Ok(output) if output.status.success() => {
                self.docker(&["--config".into(), config_text.clone(), "pull".into(), image.into()], &BTreeMap::new(), Duration::from_secs(1800))
            }
            Ok(output) => {
                self.log.line(&format!("##[error]Could not sign in to {registry}: {}", String::from_utf8_lossy(&output.stderr).trim()));
                false
            }
            Err(error) => {
                self.log.line(&format!("##[error]Could not run docker login: {error}"));
                false
            }
        };
        let _ = std::fs::remove_dir_all(&config);
        ok
    }

    /// Reads a `services:` entry or `container:` with the job's contexts.
    fn read_container(&self, value: &Value) -> ContainerSpec {
        let frame = super::Frame::default();
        let env = self.env_context(&frame);
        let contexts = self.contexts_for(&frame, &env);
        let value = self.with_scope(&contexts, |scope| expr::interpolate_value(value, scope)).unwrap_or(Value::Null);
        container_spec(&value)
    }

    /// Starts the job's services and its container, before its steps:
    /// GitHub's "Initialize containers". Returns whether they all started.
    pub(crate) fn start_containers(&mut self) -> bool {
        let services: Vec<(String, Value)> = self.spec["spec"]["services"].as_object().map(|s| s.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
        let container = self.spec["spec"].get("container").filter(|c| !c.is_null()).cloned();
        let container = container.map(|c| self.read_container(&c)).filter(|c| !c.image.is_empty());
        let services: Vec<(String, ContainerSpec)> = services.into_iter().map(|(name, value)| (name, self.read_container(&value))).filter(|(_, spec)| !spec.image.is_empty()).collect();
        // A self-hosted runner in Docker mode started this job in its
        // `container:` image already (selfhosted/exec.rs).
        let container = container.filter(|_| std::env::var_os(IN_JOB_CONTAINER).is_none());
        if services.is_empty() && container.is_none() {
            return true;
        }
        // A self-hosted machine without Docker runs the steps as before,
        // on the machine, without the containers.
        if !self.docker_hosted && self.docker_output(&["version", "--format", "{{.Server.Version}}"]).is_none() {
            self.log.line("##[warning]Docker does not answer on this runner, so the job's `services` and `container` are not started and its steps run on the machine. Run the runner directly on a machine with Docker (`--no-docker`) to start them.");
            return true;
        }
        self.log.line("##[group]Initialize containers");
        let ok = self.docker_ready() && self.start_containers_now(services, container);
        self.log.line("##[endgroup]");
        ok
    }

    fn start_containers_now(&mut self, services: Vec<(String, ContainerSpec)>, container: Option<ContainerSpec>) -> bool {
        let job_id = docker_name(&format!("{}_{:x}", self.spec["name"].as_str().unwrap_or("job"), super::rand_id() & 0xffff_ffff));
        let network = format!("g1t_{job_id}");
        if !self.docker(&["network".into(), "create".into(), "--label".into(), "g1t-job".into(), network.clone()], &BTreeMap::new(), Duration::from_secs(60)) {
            self.log.line("##[error]Could not make the job's network.");
            return false;
        }
        self.network = Some(network.clone());

        let mut services_context = Map::new();
        for (service, spec) in &services {
            if !self.pull(&spec.image, spec.credentials.as_ref()) {
                self.log.line(&format!("##[error]Could not pull {} for the service `{service}`.", spec.image));
                return false;
            }
            let name = docker_name(&format!("{service}_{job_id}"));
            let args = create_args(&name, Some(&network), Some(service), spec, &[], false);
            if !self.docker(&args, &spec.env, Duration::from_secs(300)) {
                self.log.line(&format!("##[error]Could not create the service `{service}`."));
                return false;
            }
            self.services.push((service.clone(), name.clone()));
            if !self.docker(&["start".into(), name.clone()], &BTreeMap::new(), Duration::from_secs(300)) {
                self.log.line(&format!("##[error]Could not start the service `{service}`."));
                return false;
            }
            let id = self.docker_output(&["inspect", "--format", "{{.Id}}", &name]).unwrap_or_default();
            let ports: Map<String, Value> = port_map(&spec.ports).into_iter().map(|(k, v)| (k, json!(v))).collect();
            services_context.insert(service.clone(), json!({ "id": id, "network": network, "ports": ports }));
        }

        if let Some(spec) = container {
            if !self.pull(&spec.image, spec.credentials.as_ref()) {
                self.log.line(&format!("##[error]Could not pull {} for the job's container.", spec.image));
                return false;
            }
            let name = docker_name(&format!("job_{job_id}"));
            let mounts = self.container_mounts();
            let mut spec = spec;
            spec.env.insert("HOME".into(), GITHUB_HOME.into());
            spec.env.insert("CI".into(), "true".into());
            spec.env.insert("GITHUB_ACTIONS".into(), "true".into());
            let mut args = create_args(&name, Some(&network), None, &spec, &mounts, true);
            // Steps start in the workspace.
            args.splice(1..1, ["-w".to_owned(), self.workspace.display().to_string()]);
            if !self.docker(&args, &spec.env, Duration::from_secs(300)) || !self.docker(&["start".into(), name.clone()], &BTreeMap::new(), Duration::from_secs(300)) {
                self.log.line("##[error]Could not start the job's container.");
                return false;
            }
            let id = self.docker_output(&["inspect", "--format", "{{.Id}}", &name]).unwrap_or_default();
            let has_bash = self.docker_output(&["exec", &name, "sh", "-c", "command -v bash"]).is_some_and(|out| !out.is_empty());
            let node = self.docker_output(&["exec", &name, CONTAINER_NODE, "--version"]).is_some();
            let path = self.docker_output(&["exec", &name, "sh", "-c", "printf %s \"$PATH\""]).unwrap_or_else(|| "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into());
            if !node {
                self.log.line("##[warning]The runner's Node does not run in this image (it needs glibc and libstdc++), so JavaScript actions run beside the container, on g1t's image, with the same files.");
            }
            self.job_context.insert("container".into(), json!({ "id": id, "network": network }));
            self.container = Some(JobContainer { id: name, shell: if has_bash { "bash" } else { "sh" }, node, path });
        }

        // Services with a health check are waited for.
        for (service, name) in self.services.clone() {
            if !self.wait_healthy(&service, &name) {
                return false;
            }
        }
        if !services_context.is_empty() {
            self.job_context.insert("services".into(), Value::Object(services_context));
        }
        self.log_docker_notes();
        true
    }

    /// GitHub's runner's folders, at the same paths, and Docker's socket.
    fn container_mounts(&self) -> Vec<(String, String)> {
        let home = super::paths::under_home(super::paths::HOME_RUNNER);
        let github_home = self.temp.join("_github_home");
        let _ = std::fs::create_dir_all(&github_home);
        let mut mounts: Vec<(String, String)> = ["work", "_temp", "_actions", "_tool"]
            .iter()
            .map(|dir| {
                let path = home.join(dir);
                let _ = std::fs::create_dir_all(&path);
                (path.display().to_string(), path.display().to_string())
            })
            .collect();
        mounts.push((github_home.display().to_string(), GITHUB_HOME.into()));
        if let Some(node) = which_node() {
            mounts.push((node.display().to_string(), format!("{CONTAINER_NODE}:ro")));
        }
        mounts.push((crate::docker::engine::DOCKER_SOCKET.into(), crate::docker::engine::DOCKER_SOCKET.into()));
        mounts
    }

    fn wait_healthy(&mut self, service: &str, name: &str) -> bool {
        let limit = Duration::from_secs(600).min(self.remaining_time());
        let until = Instant::now() + limit;
        let mut wait = Duration::from_secs(1);
        loop {
            let status = self.docker_output(&["inspect", "--format", "{{if .Config.Healthcheck}}{{print .State.Health.Status}}{{end}}", name]).unwrap_or_default();
            match status.as_str() {
                "" => return true,
                "healthy" => {
                    self.log.line(&format!("{service} is healthy."));
                    return true;
                }
                "unhealthy" => {
                    self.log.line(&format!("##[error]The service `{service}` is unhealthy."));
                    self.service_logs(service, name);
                    return false;
                }
                _ => {}
            }
            if Instant::now() >= until {
                self.log.line(&format!("##[error]The service `{service}` did not become healthy in {} s.", limit.as_secs()));
                self.service_logs(service, name);
                return false;
            }
            self.log.line(&format!("Waiting for {service} to be healthy ({status})."));
            std::thread::sleep(wait);
            wait = (wait * 2).min(Duration::from_secs(8));
        }
    }

    fn service_logs(&mut self, service: &str, name: &str) {
        self.log.line(&format!("##[group]Service container {service}"));
        self.docker(&["logs".into(), "--tail".into(), "200".into(), name.into()], &BTreeMap::new(), Duration::from_secs(60));
        self.log.line("##[endgroup]");
    }

    /// Whether the job has containers to stop when it ends.
    pub(crate) fn has_containers(&self) -> bool {
        self.network.is_some()
    }

    /// GitHub's "Stop containers": each service's log, then the job's
    /// containers and network removed.
    pub(crate) fn stop_containers(&mut self) -> bool {
        for (service, name) in self.services.clone() {
            self.service_logs(&service, &name);
        }
        let mut names: Vec<String> = self.services.iter().map(|(_, name)| name.clone()).collect();
        if let Some(container) = &self.container {
            names.push(container.id.clone());
        }
        if !names.is_empty() {
            let mut args = vec!["rm".to_owned(), "--force".to_owned()];
            args.extend(names);
            self.docker(&args, &BTreeMap::new(), Duration::from_secs(120));
        }
        if let Some(network) = self.network.take() {
            self.docker(&["network".into(), "rm".into(), network], &BTreeMap::new(), Duration::from_secs(60));
        }
        self.container = None;
        true
    }

    /// The variables a process inside a container is given: the step's,
    /// GitHub's and the job's, but not the sandbox's own (its `PATH`,
    /// `HOME` and the like, which mean nothing in another image).
    pub(crate) fn container_env(&self, step_env: &BTreeMap<String, String>, full: BTreeMap<String, String>, image_path: &str) -> BTreeMap<String, String> {
        let mut out: BTreeMap<String, String> = full
            .into_iter()
            .filter(|(name, _)| step_env.contains_key(name) || !self.host_env.contains(name) || name.starts_with("GITHUB_") || name.starts_with("RUNNER_"))
            .collect();
        if !step_env.contains_key("PATH") {
            out.remove("PATH");
            if !self.path_prepend_entries().is_empty() {
                out.insert("PATH".into(), format!("{}:{image_path}", self.path_prepend_entries().join(":")));
            }
        }
        if !step_env.contains_key("HOME") {
            out.remove("HOME");
        }
        out
    }

    /// A step's command, run inside the job's container instead.
    pub(crate) fn in_container(&self, program: &str, args: &[String], dir: &Path, env: BTreeMap<String, String>) -> Option<Command> {
        let container = self.container.as_ref()?;
        let mut command = Command::new("docker");
        command.args(["exec", "-w", &dir.display().to_string()]);
        for name in env.keys() {
            command.args(["-e", name]);
        }
        command.arg(&container.id).arg(program).args(args);
        command.env_clear().envs(self.docker_cli_env()).envs(env);
        Some(command)
    }

    /// Runs a container for a Docker action or a `docker://` step, as
    /// GitHub's runner does: the workspace at /github/workspace, the step's
    /// files at /github/file_commands, the job's network.
    pub(crate) fn run_docker(&mut self, run: &DockerRun) -> (bool, BTreeMap<String, String>, BTreeMap<String, String>) {
        let fail = (false, BTreeMap::new(), BTreeMap::new());
        if !self.docker_ready() {
            return fail;
        }
        let id = format!("{:x}", super::rand_id());
        let Ok(files) = StepFiles::new(&self.temp, &id) else { return fail };
        let commands_dir = self.temp.join("_runner_file_commands");
        let workflow_dir = self.temp.join("_github_workflow");
        let home_dir = self.temp.join("_github_home");
        for dir in [&workflow_dir, &home_dir] {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::copy(self.temp.join("event.json"), workflow_dir.join("event.json"));

        let full = self.process_env(&run.env, &files);
        let mut env = self.container_env(&run.env, full, "");
        env.remove("PATH");
        // Paths as the container sees them.
        let moved = |path: &Path| format!("{GITHUB_FILE_COMMANDS}/{}", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        env.insert("GITHUB_OUTPUT".into(), moved(&files.output));
        env.insert("GITHUB_ENV".into(), moved(&files.env));
        env.insert("GITHUB_PATH".into(), moved(&files.path));
        env.insert("GITHUB_STATE".into(), moved(&files.state));
        env.insert("GITHUB_STEP_SUMMARY".into(), moved(&files.summary));
        env.insert("GITHUB_WORKSPACE".into(), GITHUB_WORKSPACE.into());
        env.insert("GITHUB_EVENT_PATH".into(), format!("{GITHUB_WORKFLOW}/event.json"));
        env.insert("HOME".into(), GITHUB_HOME.into());
        env.remove("GITHUB_ACTION_PATH");

        let mut args: Vec<String> = vec!["run".into(), "--rm".into(), "--label".into(), "g1t-job".into(), "--workdir".into(), GITHUB_WORKSPACE.into()];
        if let Some(network) = &self.network {
            args.extend(["--network".into(), network.clone()]);
        }
        for (from, to) in [
            (self.workspace.clone(), GITHUB_WORKSPACE),
            (home_dir, GITHUB_HOME),
            (workflow_dir, GITHUB_WORKFLOW),
            (commands_dir, GITHUB_FILE_COMMANDS),
            (PathBuf::from(crate::docker::engine::DOCKER_SOCKET), crate::docker::engine::DOCKER_SOCKET),
        ] {
            args.extend(["-v".into(), format!("{}:{to}", from.display())]);
        }
        for name in env.keys() {
            args.extend(["-e".into(), name.clone()]);
        }
        if let Some(entrypoint) = &run.entrypoint {
            args.extend(["--entrypoint".into(), entrypoint.clone()]);
        }
        args.push(run.image.clone());
        args.extend(run.args.iter().cloned());

        crate::abuse::touch();
        if let Some(miner) = crate::abuse::miner_in(&shown(&args)) {
            self.log.line(&format!("##[error]g1t does not run cryptocurrency miners ({miner}). This step was not run."));
            return fail;
        }
        self.log.line(&format!("[command]docker {}", shown(&args)));
        let mut command = Command::new("docker");
        command.args(&args).env_clear().envs(self.docker_cli_env()).envs(&env);
        let mut commands = Commands::default();
        let ended = process::run(command, self.remaining_time(), &mut self.log, &mut commands);
        self.log_docker_notes();
        let ok = match ended {
            Ok(Ended::Exited(0)) => true,
            Ok(Ended::Exited(code)) => {
                self.log.line(&format!("##[error]Docker run failed with exit code {code}."));
                false
            }
            Ok(Ended::TimedOut) => {
                self.log.line("##[error]The step ran past its time limit and was stopped.");
                false
            }
            Err(error) => {
                self.log.line(&format!("##[error]docker could not be started: {error}"));
                false
            }
        };
        let (outputs, state) = self.absorb(&files, &commands);
        (ok, outputs, state)
    }

    /// Builds a Docker action's image from its Dockerfile, once per job.
    pub(crate) fn build_action_image(&mut self, dir: &Path, dockerfile: &str, tag_of: &str) -> Option<String> {
        let tag = format!("g1t-action/{}", docker_name(tag_of));
        if self.built_actions.contains(&tag) {
            return Some(tag);
        }
        if !self.docker_ready() {
            return None;
        }
        let file = dir.join(dockerfile);
        let args = vec!["build".into(), "-t".into(), tag.clone(), "-f".into(), file.display().to_string(), dir.display().to_string()];
        if !self.docker(&args, &BTreeMap::new(), Duration::from_secs(1800)) {
            self.log.line("##[error]The action's image did not build.");
            return None;
        }
        self.built_actions.insert(tag.clone());
        Some(tag)
    }

    /// `docker/setup-buildx-action` on g1t's machines: the job's own
    /// Engine is the builder (BuildKit, the `docker` driver, with the
    /// containerd image store, so cache export and attestations work).
    pub(crate) fn setup_buildx(&mut self, with: &BTreeMap<String, String>) -> (bool, BTreeMap<String, String>) {
        if !self.docker_ready() {
            return (false, BTreeMap::new());
        }
        if let Some(driver) = with.get("driver").filter(|d| !d.is_empty() && *d != "docker") {
            self.log.line(&format!("`driver: {driver}` is not used on g1t's machines: builds run on this job's own Docker Engine (BuildKit, the `docker` driver), which keeps the sandbox's network and guardrails."));
        }
        for input in ["driver-opts", "buildkitd-flags", "buildkitd-config", "buildkitd-config-inline", "endpoint"] {
            if with.get(input).is_some_and(|v| !v.trim().is_empty()) {
                self.log.line(&format!("`{input}` is not used on g1t's machines."));
            }
        }
        self.docker(&["buildx".into(), "version".into()], &BTreeMap::new(), Duration::from_secs(60));
        let inspect = self.docker_output(&["buildx", "inspect", "default"]).unwrap_or_default();
        let platforms = inspect
            .lines()
            .find_map(|line| line.trim().strip_prefix("Platforms:"))
            .map(|p| p.split(',').map(|s| s.trim().trim_end_matches('*').to_owned()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(","))
            .unwrap_or_else(|| "linux/amd64".into());
        self.log.line(&format!("Builder: default (this job's Docker Engine), platforms {platforms}"));
        let mut outputs = BTreeMap::new();
        outputs.insert("name".into(), "default".into());
        outputs.insert("driver".into(), "docker".into());
        outputs.insert("platforms".into(), platforms.clone());
        outputs.insert("endpoint".into(), "default".into());
        outputs.insert("status".into(), "running".into());
        outputs.insert("flags".into(), String::new());
        outputs.insert(
            "nodes".into(),
            json!([{ "name": "default", "endpoint": "default", "status": "running", "platforms": platforms }]).to_string(),
        );
        (true, outputs)
    }
}

/// The runner's Node, its real file (not a link), to mount into a job
/// container.
fn which_node() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join("node")).find(|p| p.is_file()).and_then(|p| std::fs::canonicalize(p).ok())
}

/// The job context's `container` and `services`, merged with its status.
pub(crate) fn job_context(status: &str, extra: &Map<String, Value>) -> Value {
    let mut job = Map::new();
    job.insert("status".into(), json!(status));
    for (key, value) in extra {
        job.insert(key.clone(), value.clone());
    }
    Value::Object(job)
}

/// Names a set of tags already built in this job.
pub(crate) type Built = BTreeSet<String>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_split_as_a_shell_would() {
        assert_eq!(
            split_words(r#"--health-cmd "pg_isready -U postgres" --health-interval 10s --health-retries=5"#),
            vec!["--health-cmd", "pg_isready -U postgres", "--health-interval", "10s", "--health-retries=5"]
        );
        assert_eq!(split_words("--health-cmd 'redis-cli ping' --tmpfs /var/lib/x"), vec!["--health-cmd", "redis-cli ping", "--tmpfs", "/var/lib/x"]);
        assert_eq!(split_words(r#"a\ b "c\"d" ''"#), vec!["a b", "c\"d", ""]);
        assert!(split_words("   ").is_empty());
    }

    #[test]
    fn services_are_read_from_either_form() {
        assert_eq!(container_spec(&json!("redis:7")).image, "redis:7");
        let spec = container_spec(&json!({
            "image": "postgres:17",
            "env": { "POSTGRES_PASSWORD": "secret", "POSTGRES_DB": "app" },
            "ports": ["5432:5432", 6543],
            "volumes": ["/data:/var/lib/postgresql/data"],
            "options": "--health-cmd pg_isready --health-interval 10s",
            "credentials": { "username": "me", "password": "token" },
        }));
        assert_eq!(spec.image, "postgres:17");
        assert_eq!(spec.env["POSTGRES_DB"], "app");
        assert_eq!(spec.ports, vec!["5432:5432", "6543"]);
        assert_eq!(spec.options, vec!["--health-cmd", "pg_isready", "--health-interval", "10s"]);
        assert_eq!(spec.credentials, Some(("me".into(), "token".into())));
        // An empty image is a service the job leaves out, as on GitHub.
        assert_eq!(container_spec(&json!({ "image": "" })).image, "");
    }

    #[test]
    fn ports_map_container_to_host() {
        let map = port_map(&["5432:5432".into(), "6543:5432/tcp".into(), "6379".into(), "127.0.0.1:8080:80".into(), ":9000".into()]);
        assert_eq!(map["5432"], "6543");
        assert_eq!(map["6379"], "6379");
        assert_eq!(map["80"], "8080");
        assert_eq!(map["9000"], "9000");
    }

    #[test]
    fn credentials_sign_in_to_the_images_registry() {
        assert_eq!(registry_of("ghcr.io/acme/db:1"), "ghcr.io");
        assert_eq!(registry_of("g1t.sh/acme/web"), "g1t.sh");
        assert_eq!(registry_of("localhost:5000/x"), "localhost:5000");
        assert_eq!(registry_of("acme/private"), "https://index.docker.io/v1/");
        assert_eq!(registry_of("postgres"), "https://index.docker.io/v1/");
    }

    #[test]
    fn a_service_is_created_with_its_values_passed_by_name() {
        let spec = container_spec(&json!({
            "image": "postgres:17",
            "env": { "POSTGRES_PASSWORD": "secret" },
            "ports": ["5432:5432"],
            "options": "--health-cmd pg_isready",
        }));
        let args = create_args("postgres_job", Some("g1t_job"), Some("postgres"), &spec, &[], false);
        assert_eq!(
            args,
            vec![
                "create", "--name", "postgres_job", "--label", "g1t-job", "--network", "g1t_job", "--network-alias", "postgres", "-p", "5432:5432", "-e",
                "POSTGRES_PASSWORD", "--health-cmd", "pg_isready", "postgres:17"
            ]
        );
        assert!(!args.iter().any(|a| a.contains("secret")));
        let job = create_args("job_x", Some("g1t_job"), None, &container_spec(&json!("node:24")), &[("/home/runner/work".into(), "/home/runner/work".into())], true);
        assert!(job.ends_with(&["--entrypoint".into(), "tail".into(), "node:24".into(), "-f".into(), "/dev/null".into()]));
        assert!(job.contains(&"/home/runner/work:/home/runner/work".to_owned()));
    }

    #[test]
    fn names_are_docker_names() {
        assert_eq!(docker_name("Build & test_1a2b"), "build___test_1a2b");
        assert_eq!(docker_name("docker/login-action@v3"), "docker_login-action_v3");
    }

    #[test]
    fn the_job_context_carries_containers() {
        let mut extra = Map::new();
        extra.insert("services".into(), json!({ "db": { "ports": { "5432": "5432" } } }));
        let job = job_context("success", &extra);
        assert_eq!(job["status"], "success");
        assert_eq!(job["services"]["db"]["ports"]["5432"], "5432");
    }
}
