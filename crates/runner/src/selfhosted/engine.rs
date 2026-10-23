//! Docker Engines of the runner's own, for `nested-container` isolation
//! (sandbox.rs):
//!
//! - **The runner's engine.** In the runner's image under Sysbox
//!   (`G1T_RUNNER_SANDBOX=nested`), the runner starts `dockerd` inside its
//!   own container and runs every job's container on it. It is a child of
//!   the runner, which `docker-init` (tini) supervises as PID 1, and is
//!   started again before a job if it stopped. Started the way g1t's own
//!   sandboxes start a job's engine (crate::docker::engine): the cgroup
//!   controllers handed down first, as moby's `hack/dind` does, and plain
//!   copies when the disk takes no overlays. Unlike there, Sysbox lets it
//!   keep its packet filter, so each job gets a bridge network of its own.
//! - **A job's engine.** A job that uses Docker (`services:`, a Docker
//!   action, `docker` in a step) gets an engine of its own, started the
//!   first time the job's Docker socket is used: a `docker:dind` container
//!   beside the job's, in the job's network namespace, so what it
//!   publishes is on the job's `localhost`. It mounts the job's own volumes
//!   at the job's paths (`/home/runner`, `/tmp`: exec.rs's `job_volumes`),
//!   so a bind mount of a job's path from a step is the job's folder, as
//!   where the job and its Docker share one filesystem; nothing else is
//!   shared. The job sees only a socket that the runner passes on. The engine is privileged within the
//!   runner's container, never on the machine (Sysbox maps its root to an
//!   unprivileged user there), and is removed with its data after the job.

use std::io::{self, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use super::log;

/// Everything of the runner's engine that is not its data.
pub const DIR: &str = "/run/g1t-runner";
/// The runner's engine's socket: not `/var/run/docker.sock`, so a socket
/// there is never the runner's own (sandbox.rs looks for one).
pub const SOCKET: &str = "/run/g1t-runner/docker.sock";
/// Where a job's sockets are kept, a folder each.
pub const JOBS_DIR: &str = "/run/g1t-runner/jobs";
/// Where the job sees its Docker socket.
pub const JOB_SOCKET_DIR: &str = "/run/g1t-docker";
/// The Docker CLI in the runner's image, lent to a job read-only.
pub const DOCKER_CLI: &str = "/usr/local/bin/docker";
/// The image a job's engine runs.
pub const DEFAULT_JOB_ENGINE_IMAGE: &str = "docker:28-dind";

const LOG: &str = "/run/g1t-runner/dockerd.log";
/// From moby's `hack/dind`, as crate::docker::engine does it.
const CGROUP_NESTING: &str = "if [ -f /sys/fs/cgroup/cgroup.controllers ] && [ -z \"$(cat /sys/fs/cgroup/cgroup.subtree_control)\" ]; then \
    mkdir -p /sys/fs/cgroup/init && xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null; \
    sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control; fi";

/// The engine the runner's `docker` commands use: its own, once started.
static HOST: OnceLock<String> = OnceLock::new();
/// The runner's engine, while it runs.
static ENGINE: Mutex<Option<Child>> = Mutex::new(None);

/// Whether the runner uses an engine of its own.
pub fn in_use() -> bool {
    HOST.get().is_some()
}

/// `docker`, pointed at the runner's own engine when it has one.
pub fn docker() -> Command {
    let mut command = Command::new("docker");
    if let Some(host) = HOST.get() {
        command.env("DOCKER_HOST", host);
    }
    command
}

/// The runner's engine's `daemon.json`. `copies`: the disk takes no
/// overlays. Its own address ranges, away from Docker's defaults, which
/// the machine's engine (and so the runner's own address) already uses.
pub fn daemon_config(copies: bool) -> Value {
    let mut config = json!({
        "hosts": [format!("unix://{SOCKET}")],
        "pidfile": format!("{DIR}/dockerd.pid"),
        "bip": "172.31.254.1/24",
        "default-address-pools": [{ "base": "172.30.0.0/16", "size": 24 }],
        "registry-mirrors": [crate::docker::engine::MIRROR],
        "log-driver": "json-file",
        "log-opts": { "max-size": "20m", "max-file": "2" },
    });
    if copies {
        config["storage-driver"] = json!("vfs");
    }
    config
}

/// A request to an engine's socket; its status.
fn ping(socket: &Path) -> Option<u16> {
    let mut stream = UnixStream::connect(socket).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    stream.write_all(b"GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n").ok()?;
    let mut head = [0u8; 12];
    stream.read_exact(&mut head).ok()?;
    std::str::from_utf8(&head[9..12]).ok()?.parse().ok()
}

fn tail(path: &Path, lines: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// Starts the runner's own engine, or finds it running (the runner
/// restarted after an update); its version.
pub fn start() -> Result<String> {
    let _ = HOST.set(format!("unix://{SOCKET}"));
    let mut engine = ENGINE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(child) = engine.as_mut()
        && matches!(child.try_wait(), Ok(None))
        && ping(Path::new(SOCKET)) == Some(200)
    {
        return Ok(version());
    }
    if engine.is_none() && ping(Path::new(SOCKET)) == Some(200) {
        return Ok(version());
    }
    std::fs::create_dir_all(DIR).with_context(|| format!("could not make {DIR}"))?;
    let _ = Command::new("sh").args(["-c", CGROUP_NESTING]).status();
    let mut last = String::new();
    for copies in [false, true] {
        std::fs::write(format!("{DIR}/daemon.json"), serde_json::to_vec_pretty(&daemon_config(copies))?)?;
        let _ = std::fs::remove_file(SOCKET);
        let out = std::fs::File::create(LOG).with_context(|| format!("could not write {LOG}"))?;
        let err = out.try_clone()?;
        let mut child = Command::new("dockerd")
            .args(["--config-file", &format!("{DIR}/daemon.json")])
            .env_remove("DOCKER_HOST")
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err)
            .spawn()
            .context("could not run dockerd: the runner's image has it; is this the runner's image?")?;
        let until = Instant::now() + Duration::from_secs(90);
        loop {
            if ping(Path::new(SOCKET)) == Some(200) {
                *engine = Some(child);
                let version = version();
                return Ok(if copies { format!("{version} (plain-copy storage: this disk takes no overlays)") } else { version });
            }
            if let Ok(Some(status)) = child.try_wait() {
                last = format!("dockerd stopped ({status}):\n{}", tail(Path::new(LOG), 15));
                break;
            }
            if Instant::now() >= until {
                let _ = child.kill();
                let _ = child.wait();
                last = format!("dockerd did not answer in 90 s:\n{}", tail(Path::new(LOG), 15));
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    bail!(
        "the runner's own Docker Engine could not start. Under Sysbox it needs no more than `docker run --runtime=sysbox-runc`; without Sysbox it cannot start without --privileged, which this runner does not use.\n{last}"
    )
}

/// Before a job: the runner's engine is running, started again if not.
pub fn ensure_running() -> Result<()> {
    let stopped = {
        let mut engine = ENGINE.lock().unwrap_or_else(|p| p.into_inner());
        match engine.as_mut() {
            Some(child) => !matches!(child.try_wait(), Ok(None)),
            None => ping(Path::new(SOCKET)) != Some(200),
        }
    };
    if stopped {
        log("The runner's Docker Engine stopped; starting it again.");
        start()?;
    }
    Ok(())
}

fn version() -> String {
    docker()
        .args(["version", "--format", "{{.Server.Version}}"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "?".into())
}

// --- A job's own engine -------------------------------------------------

/// A job's Docker: a socket now, an engine the first time it is used.
pub struct JobEngine {
    /// `JOBS_DIR/<job container>`: `proxy/docker.sock` (the job's) and
    /// `engine/docker.sock` (its engine's).
    pub dir: PathBuf,
    /// The engine's container and its data's volume.
    pub container: String,
    pub volume: String,
    stop: Arc<AtomicBool>,
}

/// What starting it needs.
#[derive(Clone)]
struct EngineSpec {
    image: String,
    container: String,
    volume: String,
    /// The job's container, whose network the engine joins.
    job: String,
    label: String,
    engine_dir: PathBuf,
    /// The job's own volumes and where the job has them: the engine mounts
    /// each at the same path.
    shared: Vec<(String, String)>,
}

/// The `docker run` for a job's engine. Privileged within the runner's
/// container: Sysbox maps its root to an unprivileged user on the
/// machine, and gives the runner's container no devices of the machine's.
fn engine_args(spec: &EngineSpec) -> Vec<String> {
    let mut args: Vec<String> = ["run", "-d", "--rm", "--name", &spec.container, "--label", &spec.label, "--privileged", "--pull", "missing"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.extend(["--network".into(), format!("container:{}", spec.job)]);
    // No TLS certificates and no TCP port: only the socket, which the
    // runner passes on.
    args.extend(["-e".into(), "DOCKER_TLS_CERTDIR=".into()]);
    args.extend(["-v".into(), format!("{}:/run/g1t-engine", spec.engine_dir.display())]);
    args.extend(["-v".into(), format!("{}:/var/lib/docker", spec.volume)]);
    // The job's files where the job has them, so `-v /home/runner/work/…`
    // resolves here to the job's folder (flagon-io#480).
    for (volume, path) in &spec.shared {
        args.extend(["-v".into(), format!("{volume}:{path}")]);
    }
    args.extend([spec.image.clone(), "dockerd".into(), "--host=unix:///run/g1t-engine/docker.sock".into()]);
    args
}

fn start_job_engine(spec: &EngineSpec) -> Result<(), String> {
    let begun = Instant::now();
    let output = docker().args(engine_args(spec)).output().map_err(|e| format!("could not run docker: {e}"))?;
    if !output.status.success() {
        return Err(format!("could not start the job's Docker Engine: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let socket = spec.engine_dir.join("docker.sock");
    while begun.elapsed() < Duration::from_secs(120) {
        if ping(&socket) == Some(200) {
            log(&format!("Started the job's own Docker Engine in {:.1}s.", begun.elapsed().as_secs_f64()));
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("the job's Docker Engine did not answer in 120 s".into())
}

/// Passes one connection on to the job's engine, starting it first.
fn serve(mut client: UnixStream, spec: &EngineSpec, started: &Mutex<Option<Result<(), String>>>) {
    let ready = {
        let mut started = started.lock().unwrap_or_else(|p| p.into_inner());
        if started.is_none() {
            *started = Some(start_job_engine(spec));
        }
        started.clone().unwrap_or(Ok(()))
    };
    if let Err(problem) = ready {
        let body = serde_json::to_string(&json!({ "message": problem })).unwrap_or_default();
        let _ = write!(client, "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        return;
    }
    let Ok(engine) = UnixStream::connect(spec.engine_dir.join("docker.sock")) else { return };
    let (Ok(mut client_read), Ok(mut engine_write)) = (client.try_clone(), engine.try_clone()) else { return };
    let upstream = std::thread::spawn(move || {
        let _ = io::copy(&mut client_read, &mut engine_write);
        let _ = engine_write.shutdown(std::net::Shutdown::Write);
    });
    let mut engine_read = engine;
    let _ = io::copy(&mut engine_read, &mut client);
    let _ = client.shutdown(std::net::Shutdown::Both);
    let _ = upstream.join();
}

impl JobEngine {
    /// Sets a job's Docker socket up, with no engine behind it yet.
    /// `shared`: the job's own volumes and where the job mounts them.
    pub fn prepare(job: &str, runner: &str, image: &str, shared: &[(String, &str)]) -> Result<JobEngine> {
        let dir = Path::new(JOBS_DIR).join(job);
        let _ = std::fs::remove_dir_all(&dir);
        let (proxy, engine_dir) = (dir.join("proxy"), dir.join("engine"));
        std::fs::create_dir_all(&proxy).and_then(|()| std::fs::create_dir_all(&engine_dir)).with_context(|| format!("could not make {}", dir.display()))?;
        let socket = proxy.join("docker.sock");
        let listener = UnixListener::bind(&socket).with_context(|| format!("could not listen on {}", socket.display()))?;
        {
            use std::os::unix::fs::PermissionsExt;
            // Whoever the job's image runs as.
            std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o666))?;
        }
        listener.set_nonblocking(true)?;
        let spec = EngineSpec {
            image: image.to_owned(),
            container: format!("{job}-docker"),
            volume: format!("{job}-docker"),
            job: job.to_owned(),
            label: format!("sh.g1t.runner={runner}"),
            engine_dir,
            shared: shared.iter().map(|(volume, path)| (volume.clone(), (*path).to_owned())).collect(),
        };
        let stop = Arc::new(AtomicBool::new(false));
        let (stopping, thread_spec) = (stop.clone(), spec.clone());
        std::thread::spawn(move || {
            let started: Arc<Mutex<Option<Result<(), String>>>> = Arc::new(Mutex::new(None));
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((client, _)) => {
                        let _ = client.set_nonblocking(false);
                        let (spec, started) = (thread_spec.clone(), started.clone());
                        std::thread::spawn(move || serve(client, &spec, &started));
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
                    Err(_) => std::thread::sleep(Duration::from_millis(100)),
                }
            }
        });
        Ok(JobEngine { dir, container: spec.container, volume: spec.volume, stop })
    }

    /// What the job's `docker run` adds: its socket's folder, read-only
    /// (a socket on a read-only mount still connects), the Docker CLI, and
    /// `DOCKER_HOST`.
    pub fn job_args(&self) -> Vec<String> {
        let mut args = vec!["-v".into(), format!("{}:{JOB_SOCKET_DIR}:ro", self.dir.join("proxy").display())];
        if Path::new(DOCKER_CLI).exists() {
            args.extend(["-v".into(), format!("{DOCKER_CLI}:/usr/local/bin/docker:ro")]);
        }
        args.extend(["-e".into(), format!("DOCKER_HOST=unix://{JOB_SOCKET_DIR}/docker.sock")]);
        args
    }

    /// Stops the engine and removes it, its data and its sockets.
    pub fn remove(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let quiet = |args: &[&str]| {
            let _ = docker().args(args).stdout(Stdio::null()).stderr(Stdio::null()).status();
        };
        quiet(&["rm", "-f", "-v", &self.container]);
        quiet(&["volume", "rm", "-f", &self.volume]);
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_runners_engine_keeps_its_own_socket_and_addresses() {
        let config = daemon_config(false);
        assert_eq!(config["hosts"][0], "unix:///run/g1t-runner/docker.sock");
        assert_ne!(SOCKET, "/var/run/docker.sock");
        assert!(config.get("storage-driver").is_none());
        assert_eq!(daemon_config(true)["storage-driver"], "vfs");
        // Not Docker's default range, which the machine's engine has.
        assert!(!config["bip"].as_str().unwrap().starts_with("172.17."));
    }

    #[test]
    fn a_jobs_engine_is_in_the_jobs_network_and_mounts_nothing_of_the_machine() {
        let spec = EngineSpec {
            image: DEFAULT_JOB_ENGINE_IMAGE.into(),
            container: "g1t-job_1-docker".into(),
            volume: "g1t-job_1-docker".into(),
            job: "g1t-job_1".into(),
            label: "sh.g1t.runner=rnr_1".into(),
            engine_dir: PathBuf::from("/run/g1t-runner/jobs/g1t-job_1/engine"),
            shared: Vec::new(),
        };
        let args = engine_args(&spec);
        let joined = args.join(" ");
        assert!(joined.contains("--network container:g1t-job_1"));
        assert!(joined.contains("--rm"));
        assert!(!joined.contains("docker.sock:/"), "no engine socket is mounted in: {joined}");
        // Its volumes: the runner's own folder for its socket, and a volume.
        let mounts: Vec<&String> = args.windows(2).filter(|w| w[0] == "-v").map(|w| &w[1]).collect();
        assert_eq!(mounts.len(), 2);
        assert!(mounts[0].starts_with("/run/g1t-runner/jobs/"));
        assert!(mounts[1].starts_with("g1t-job_1-docker:"));
        assert!(args.iter().any(|a| a == "DOCKER_TLS_CERTDIR="));
    }

    #[test]
    fn a_jobs_engine_sees_the_jobs_files_at_the_jobs_paths() {
        let shared = crate::selfhosted::exec::job_volumes("g1t-job_1", "workflow", true);
        let spec = EngineSpec {
            image: DEFAULT_JOB_ENGINE_IMAGE.into(),
            container: "g1t-job_1-docker".into(),
            volume: "g1t-job_1-docker".into(),
            job: "g1t-job_1".into(),
            label: "sh.g1t.runner=rnr_1".into(),
            engine_dir: PathBuf::from("/run/g1t-runner/jobs/g1t-job_1/engine"),
            shared: shared.iter().map(|(volume, path)| (volume.clone(), (*path).to_owned())).collect(),
        };
        let args = engine_args(&spec);
        let mounts: Vec<&str> = args.windows(2).filter(|w| w[0] == "-v").map(|w| w[1].as_str()).collect();
        // The same volumes at the same paths as the job's container has them.
        assert_eq!(mounts[2..], ["g1t-job_1-work:/home/runner", "g1t-job_1-tmp:/tmp"]);
        // Nothing else: the runner's folder for the engine's socket and the
        // engine's data, as before; no folder of the runner's or the machine's.
        assert_eq!(mounts.len(), 4);
        assert!(!mounts.iter().any(|m| m.starts_with("/home") || m.starts_with("/tmp") || m.starts_with("/var/run")));
        // Its image and command stay last.
        assert_eq!(&args[args.len() - 3..], [DEFAULT_JOB_ENGINE_IMAGE, "dockerd", "--host=unix:///run/g1t-engine/docker.sock"]);
    }

    /// Against a real Docker Engine, as root, with `docker:28-dind` at
    /// hand: `G1T_TEST_DOCKER=1 cargo test -- --ignored job_engine`.
    #[test]
    #[ignore]
    fn a_jobs_engine_starts_when_the_job_first_uses_it() {
        if std::env::var("G1T_TEST_DOCKER").as_deref() != Ok("1") {
            return;
        }
        let job = "g1t-engine-test";
        let quiet = |args: &[&str]| {
            let _ = docker().args(args).stdout(Stdio::null()).stderr(Stdio::null()).status();
        };
        quiet(&["rm", "-f", job]);
        let shared = crate::selfhosted::exec::job_volumes(job, "workflow", true);
        for (volume, _) in &shared {
            quiet(&["volume", "rm", "-f", volume]);
            quiet(&["volume", "create", volume]);
        }
        let engine = JobEngine::prepare(job, "test", DEFAULT_JOB_ENGINE_IMAGE, &shared).unwrap();
        // A job's container with the job's Docker: the dind image has a CLI.
        let mut run = docker();
        run.args(["run", "-d", "--rm", "--name", job, "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]);
        for (volume, path) in &shared {
            run.args(["-v", &format!("{volume}:{path}")]);
        }
        let mut job_args = engine.job_args();
        // This machine's CLI may not run in Alpine; the image has its own.
        if let Some(at) = job_args.iter().position(|a| a.starts_with(DOCKER_CLI)) {
            job_args.drain(at - 1..=at);
        }
        run.args(&job_args).args(["--entrypoint", "sleep", DEFAULT_JOB_ENGINE_IMAGE, "300"]);
        assert!(run.status().unwrap().success());
        // Nothing runs behind the socket until it is used.
        assert!(!docker().args(["inspect", &engine.container]).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success());
        let version = docker().args(["exec", job, "docker", "version", "--format", "{{.Server.Version}}"]).output().unwrap();
        let shown = String::from_utf8_lossy(&version.stdout).trim().to_owned();
        let errors = String::from_utf8_lossy(&version.stderr).trim().to_owned();
        // The job cannot change its socket's folder.
        let wrote = docker().args(["exec", job, "touch", "/run/g1t-docker/x"]).stderr(Stdio::null()).status().unwrap();
        // A step's bind mounts of the job's paths are the job's folders
        // (flagon-io#480): its workspace, and /tmp.
        let script = "mkdir -p /home/runner/work/repo && cd /home/runner/work/repo && echo hi > f && echo there > /tmp/g \
            && docker run --rm -v \"$PWD\":/w -v /tmp:/t docker:28-dind sh -c 'cat /w/f /t/g && echo back > /w/out'";
        let bound = docker().args(["exec", job, "sh", "-c", script]).output().unwrap();
        let back = docker().args(["exec", job, "cat", "/home/runner/work/repo/out"]).output().unwrap();
        quiet(&["rm", "-f", job]);
        engine.remove();
        for (volume, _) in &shared {
            quiet(&["volume", "rm", "-f", volume]);
        }
        assert_eq!(String::from_utf8_lossy(&bound.stdout), "hi\nthere\n", "{}", String::from_utf8_lossy(&bound.stderr));
        assert_eq!(String::from_utf8_lossy(&back.stdout), "back\n");
        assert!(version.status.success(), "docker version in the job: {errors}");
        assert!(shown.starts_with("28."), "{shown}");
        assert!(!wrote.success());
        assert!(!engine.dir.exists());
    }
}
