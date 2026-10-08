//! The job's own Docker Engine: set up when the job starts (a socket, and
//! nothing running), and started the first time the socket is used, or a
//! job's `services:` or `container:` need it.
//!
//! What Cloudflare Containers allow, and so how it is started: `dockerd`
//! as root (a rootless Engine does not start there), with
//! `--iptables=false --ip6tables=false --ip-forward=false`, since a sandbox
//! may not change its packet filter or forward packets. Containers on a
//! bridge network therefore have no way out, which is why the API proxy
//! puts them on the job's network (api.rs). The Engine's data goes on the
//! sandbox's disk with the overlay filesystem when the disk takes it, and
//! with plain copies (containerd's `native` snapshotter) when it does not. Docker Hub's images come
//! through Google's public mirror of it first, so jobs from many machines
//! sharing addresses do not run into Docker Hub's anonymous limits.

use std::path::Path;

use serde_json::{Value, json};

/// Everything of the Engine's that is not its data.
pub(crate) const DIR: &str = "/run/g1t-docker";
/// What the job's steps reach: the API proxy.
pub(crate) const PROXY_SOCKET: &str = "/run/g1t-docker/docker.sock";
/// The Engine itself.
pub(crate) const ENGINE_SOCKET: &str = "/run/g1t-docker/engine.sock";
/// Where the job's steps look for Docker.
pub(crate) const DOCKER_SOCKET: &str = "/var/run/docker.sock";
pub(crate) const MIRROR: &str = "https://mirror.gcr.io";

/// What the job tells the Engine when it sets it up.
#[derive(Clone, Default)]
pub(crate) struct Options {
    /// g1t's container registry (`g1t.sh`) and the run's token, to be
    /// signed in to from the start. None for a run without secrets.
    pub(crate) registry: Option<(String, String)>,
}

/// The Engine's `daemon.json`. `group`: the group whose members may use
/// its socket (the job's user). `copies`: the disk does not take overlays.
pub(crate) fn daemon_config(group: &str, copies: bool) -> Value {
    let mut config = json!({
        "hosts": [format!("unix://{ENGINE_SOCKET}")],
        "group": group,
        "pidfile": format!("{DIR}/dockerd.pid"),
        "iptables": false,
        "ip6tables": false,
        "ip-forward": false,
        "registry-mirrors": [MIRROR],
        "log-driver": "json-file",
        "log-opts": { "max-size": "20m", "max-file": "2" },
    });
    if copies {
        // The containerd image store's name for plain copies (vfs).
        config["storage-driver"] = json!("native");
    }
    config
}

/// `~/.docker/config.json`, signed in to `registry` with `token` unless it
/// is already signed in there.
pub(crate) fn with_login(mut config: Value, registry: &str, token: &str) -> Option<Value> {
    use base64::Engine;
    if !config.is_object() {
        config = json!({});
    }
    let auths = config.as_object_mut()?.entry("auths").or_insert_with(|| json!({}));
    let auths = auths.as_object_mut()?;
    if auths.contains_key(registry) {
        return None;
    }
    let auth = base64::engine::general_purpose::STANDARD.encode(format!("g1t:{token}"));
    auths.insert(registry.to_owned(), json!({ "auth": auth }));
    Some(config)
}

/// The host of a server URL: `https://g1t.sh` is `g1t.sh`.
pub(crate) fn registry_host(server_url: &str) -> Option<String> {
    let rest = server_url.split_once("://").map_or(server_url, |(_, rest)| rest);
    let host = rest.split('/').next().unwrap_or_default();
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// The last lines of a file, for a message.
fn tail(path: &Path, lines: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[cfg(target_os = "linux")]
pub(crate) use linux::{enable, ensure_started};

#[cfg(not(target_os = "linux"))]
pub(crate) fn enable(_options: Options) -> Result<(), String> {
    Err("Docker runs in jobs on g1t's own Linux machines.".into())
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn ensure_started() -> Result<String, String> {
    Err("Docker runs in jobs on g1t's own Linux machines.".into())
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::BTreeSet;
    use std::io::{self, Write};
    use std::net::{TcpListener, TcpStream};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;
    use std::process::{Child, Command, Stdio};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use serde_json::Value;

    use super::super::api::{self, Duplex, Host, State};
    use super::{DIR, DOCKER_SOCKET, ENGINE_SOCKET, Options, PROXY_SOCKET, daemon_config, tail, with_login};

    const LOG: &str = "/run/g1t-docker/dockerd.log";
    /// From moby's `hack/dind`: the sandbox's processes into a group of
    /// their own, then every controller enabled for the groups below.
    const CGROUP_NESTING: &str = "if [ -f /sys/fs/cgroup/cgroup.controllers ] && [ -z \"$(cat /sys/fs/cgroup/cgroup.subtree_control)\" ]; then \
        mkdir -p /sys/fs/cgroup/init && xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null; \
        sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control; fi";
    const CERTS: &str = "/run/g1t-docker/certs";
    const BIN: &str = "/run/g1t-docker/bin";

    /// The options the job set up with, once set up.
    static OPTIONS: OnceLock<Options> = OnceLock::new();
    /// How starting went: the Engine's version, or why not. Held while
    /// starting, so everything that needs the Engine waits for it.
    static STARTED: Mutex<Option<Result<String, String>>> = Mutex::new(None);
    /// Host ports forwarded so far.
    static FORWARDED: Mutex<BTreeSet<u16>> = Mutex::new(BTreeSet::new());

    fn sudo(args: &[&str]) -> bool {
        Command::new("sudo").arg("-n").args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
    }

    fn sudo_with_input(args: &[&str], input: &str) -> bool {
        let Ok(mut child) = Command::new("sudo").arg("-n").args(args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else {
            return false;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(input.as_bytes());
        }
        child.wait().is_ok_and(|s| s.success())
    }

    fn ids() -> (u32, u32) {
        std::fs::metadata("/proc/self").map(|m| (m.uid(), m.gid())).unwrap_or((1000, 1000))
    }

    fn group_name() -> String {
        Command::new("id").arg("-gn").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned()).filter(|g| !g.is_empty()).unwrap_or_else(|| "node".into())
    }

    /// Sets the socket up, with no Engine behind it yet.
    pub(crate) fn enable(options: Options) -> Result<(), String> {
        if !Path::new("/usr/bin/dockerd").exists() {
            return Err("this sandbox's image has no Docker Engine".into());
        }
        let (uid, gid) = ids();
        if !sudo(&["install", "-d", "-m", "0755", "-o", &uid.to_string(), "-g", &gid.to_string(), DIR]) {
            return Err(format!("could not make {DIR}"));
        }
        let _ = std::fs::remove_file(PROXY_SOCKET);
        let listener = UnixListener::bind(PROXY_SOCKET).map_err(|e| format!("could not listen on {PROXY_SOCKET}: {e}"))?;
        // Every process in the sandbox is the job's, root or not.
        let _ = std::fs::set_permissions(PROXY_SOCKET, std::fs::Permissions::from_mode(0o666));
        if !sudo(&["ln", "-sfn", PROXY_SOCKET, DOCKER_SOCKET]) {
            return Err(format!("could not link {DOCKER_SOCKET}"));
        }
        let _ = OPTIONS.set(options);
        let host: Arc<dyn Host> = Arc::new(Sandbox);
        let state = Arc::new(Mutex::new(State::default()));
        std::thread::spawn(move || {
            for client in listener.incoming().flatten() {
                let (host, state) = (host.clone(), state.clone());
                std::thread::spawn(move || api::serve(Box::new(client), host, state));
            }
        });
        Ok(())
    }

    /// Starts the Engine, once; its version, or why it could not start.
    pub(crate) fn ensure_started() -> Result<String, String> {
        let mut started = STARTED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(result) = &*started {
            return result.clone();
        }
        let begun = Instant::now();
        let result = start();
        match &result {
            Ok(version) => super::super::note(format!(
                "Docker: started this job's own Docker Engine {version} in {:.1}s. Its containers run in this job's sandbox, on the job's network and under its guardrails, and end with the job.",
                begun.elapsed().as_secs_f64()
            )),
            Err(problem) => super::super::note(format!("##[error]Docker could not start: {problem}")),
        }
        *started = Some(result.clone());
        result
    }

    /// Whether the overlay filesystem works where the Engine keeps its data.
    fn overlay_works() -> bool {
        let script = "d=/var/lib/docker/.g1t-probe; rm -rf $d; mkdir -p $d/l $d/u $d/w $d/m && echo x > $d/l/f && mount -t overlay overlay -o lowerdir=$d/l,upperdir=$d/u,workdir=$d/w $d/m && umount $d/m; s=$?; rm -rf $d; exit $s";
        sudo(&["sh", "-c", script])
    }

    fn start() -> Result<String, String> {
        // This program, as the runc the Engine finds first (oci.rs).
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(BIN).map_err(|e| format!("could not make {BIN}: {e}"))?;
        let shim = Path::new(BIN).join("runc");
        let _ = std::fs::remove_file(&shim);
        std::os::unix::fs::symlink(&exe, &shim).map_err(|e| format!("could not link runc: {e}"))?;

        // A guarded job's certificate, for its containers.
        let mut ca_dir = None;
        if let Ok(ca) = std::env::var("G1T_EGRESS_CA")
            && Path::new(&ca).exists()
        {
            let _ = std::fs::create_dir_all(CERTS);
            let copied = std::fs::copy(&ca, Path::new(CERTS).join(super::super::oci::EGRESS)).is_ok()
                && std::fs::copy("/etc/ssl/certs/ca-certificates.crt", Path::new(CERTS).join(super::super::oci::BUNDLE)).is_ok();
            if copied {
                ca_dir = Some(CERTS.to_owned());
            }
        }
        // `-p 80:8080` is forwarded by this process, which is not root.
        let _ = sudo(&["sysctl", "-q", "-w", "net.ipv4.ip_unprivileged_port_start=0"]);
        // Containers' resource limits (`--cpus`, `--memory`) need the
        // cgroup controllers handed down, which cgroup v2 allows only from
        // a group with no processes of its own: move ours aside first, as
        // the Engine's own Docker-in-Docker image does.
        let _ = sudo(&["sh", "-c", CGROUP_NESTING]);

        let mut vfs = !overlay_works();
        let group = group_name();
        let mut last = String::new();
        for _ in 0..2 {
            let config = daemon_config(&group, vfs);
            std::fs::write(format!("{DIR}/daemon.json"), serde_json::to_vec_pretty(&config).unwrap_or_default())
                .map_err(|e| format!("could not write daemon.json: {e}"))?;
            let mut child = spawn(ca_dir.as_deref())?;
            match wait_ready(&mut child, Duration::from_secs(90)) {
                Ok(()) => {
                    let version = engine_version().unwrap_or_else(|| "?".into());
                    sign_in();
                    return Ok(if vfs { format!("{version} (plain-copy storage: this disk takes no overlays, so images take more room)") } else { version });
                }
                Err(problem) => {
                    last = problem;
                    let _ = child.kill();
                    let _ = sudo(&["pkill", "-x", "dockerd"]);
                    let _ = sudo(&["pkill", "-x", "containerd"]);
                    if vfs {
                        break;
                    }
                    // Overlays that mount but do not work for the Engine.
                    vfs = true;
                }
            }
        }
        Err(last)
    }

    fn spawn(ca_dir: Option<&str>) -> Result<Child, String> {
        let log = std::fs::File::create(LOG).map_err(|e| format!("could not write {LOG}: {e}"))?;
        let err = log.try_clone().map_err(|e| e.to_string())?;
        let path = format!("{BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        let mut command = Command::new("sudo");
        command.args(["-n", "env", &format!("PATH={path}"), "G1T_REAL_RUNC=/usr/bin/runc"]);
        if let Some(dir) = ca_dir {
            command.arg(format!("G1T_DOCKER_CA_DIR={dir}"));
        }
        command.args(["dockerd", "--config-file", &format!("{DIR}/daemon.json")]);
        command.stdin(Stdio::null()).stdout(log).stderr(err);
        command.spawn().map_err(|e| format!("could not run dockerd: {e}"))
    }

    /// A request to the Engine; its status and body.
    fn ask(method: &str, path: &str) -> io::Result<(u16, Vec<u8>)> {
        let mut stream = UnixStream::connect(ENGINE_SOCKET)?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        stream.write_all(format!("{method} {path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n").as_bytes())?;
        let mut reader = io::BufReader::new(stream);
        let head = super::super::http::read_head(&mut reader)?.ok_or_else(|| io::Error::other("no answer"))?;
        let body = super::super::http::read_body(&mut reader, super::super::http::response_body(&head, method))?;
        Ok((head.status(), body))
    }

    fn wait_ready(child: &mut Child, limit: Duration) -> Result<(), String> {
        let until = Instant::now() + limit;
        loop {
            if matches!(ask("GET", "/_ping"), Ok((200, _))) {
                return Ok(());
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("dockerd stopped ({status}):\n{}", tail(Path::new(LOG), 15)));
            }
            if Instant::now() >= until {
                return Err(format!("dockerd did not answer in {} s:\n{}", limit.as_secs(), tail(Path::new(LOG), 15)));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn engine_version() -> Option<String> {
        let (_, body) = ask("GET", "/version").ok()?;
        let value: Value = serde_json::from_slice(&body).ok()?;
        value.get("Version").and_then(Value::as_str).map(str::to_owned)
    }

    /// Signs the job in to g1t's registry with the run's own token.
    fn sign_in() {
        let Some((registry, token)) = OPTIONS.get().and_then(|o| o.registry.clone()) else { return };
        let home = std::env::var("HOME").unwrap_or_else(|_| "/home/node".into());
        let path = Path::new(&home).join(".docker").join("config.json");
        let current: Value = std::fs::read(&path).ok().and_then(|t| serde_json::from_slice(&t).ok()).unwrap_or(Value::Null);
        if let Some(config) = with_login(current, &registry, &token) {
            let _ = std::fs::create_dir_all(path.parent().expect("a folder"));
            if std::fs::write(&path, serde_json::to_vec_pretty(&config).unwrap_or_default()).is_ok() {
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
                super::super::note(format!("Docker: signed in to {registry} with this run's token."));
            }
        }
    }

    /// The sandbox, as the API proxy sees it.
    struct Sandbox;

    impl Host for Sandbox {
        fn add_hosts(&self, names: &[String]) {
            let lines: String = names.iter().map(|name| format!("127.0.0.1\t{name}\n")).collect();
            if !sudo_with_input(&["sh", "-c", "cat >> /etc/hosts"], &lines) {
                super::super::note(format!("Docker: could not add {} to /etc/hosts.", names.join(", ")));
            }
        }

        fn forward(&self, host_port: u16, container_port: u16) {
            if !FORWARDED.lock().is_ok_and(|mut set| set.insert(host_port)) {
                return;
            }
            let listener = match TcpListener::bind(("0.0.0.0", host_port)) {
                Ok(listener) => listener,
                Err(error) => {
                    super::super::note(format!("##[warning]Docker: port {host_port} could not be published for port {container_port}: {error}"));
                    return;
                }
            };
            std::thread::spawn(move || {
                for client in listener.incoming().flatten() {
                    std::thread::spawn(move || {
                        let Ok(target) = TcpStream::connect(("127.0.0.1", container_port)) else { return };
                        pipe(client, target);
                    });
                }
            });
        }

        fn ensure_engine(&self) -> Result<(), String> {
            ensure_started().map(|_| ())
        }

        fn connect(&self) -> io::Result<Box<dyn Duplex>> {
            Ok(Box::new(UnixStream::connect(ENGINE_SOCKET)?))
        }
    }

    /// Copies two connections into each other until both are done.
    fn pipe(a: TcpStream, b: TcpStream) {
        let (Ok(mut a_read), Ok(mut b_read)) = (a.try_clone(), b.try_clone()) else { return };
        let (mut a_write, mut b_write) = (a, b);
        let back = std::thread::spawn(move || {
            let _ = io::copy(&mut b_read, &mut a_write);
            let _ = a_write.shutdown(std::net::Shutdown::Write);
        });
        let _ = io::copy(&mut a_read, &mut b_write);
        let _ = b_write.shutdown(std::net::Shutdown::Write);
        let _ = back.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_engine_runs_as_a_sandbox_allows() {
        let config = daemon_config("node", false);
        assert_eq!(config["iptables"], false);
        assert_eq!(config["ip6tables"], false);
        assert_eq!(config["ip-forward"], false);
        assert_eq!(config["group"], "node");
        assert_eq!(config["hosts"][0], "unix:///run/g1t-docker/engine.sock");
        assert_eq!(config["registry-mirrors"][0], MIRROR);
        assert!(config.get("storage-driver").is_none());
        assert_eq!(daemon_config("node", true)["storage-driver"], "native");
    }

    #[test]
    fn the_run_signs_in_to_g1t_unless_already_signed_in() {
        let config = with_login(json!({ "auths": { "ghcr.io": { "auth": "x" } } }), "g1t.sh", "tok").unwrap();
        assert_eq!(config["auths"]["g1t.sh"]["auth"], "ZzF0OnRvaw==");
        assert_eq!(config["auths"]["ghcr.io"]["auth"], "x");
        assert!(with_login(config, "g1t.sh", "other").is_none());
        assert!(with_login(Value::Null, "g1t.sh", "tok").is_some());
        assert_eq!(registry_host("https://g1t.sh").as_deref(), Some("g1t.sh"));
        assert_eq!(registry_host("http://localhost:8787/").as_deref(), Some("localhost:8787"));
    }
}
