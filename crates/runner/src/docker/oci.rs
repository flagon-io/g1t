//! `runc`, as the job's Docker Engine finds it. The Engine is started with
//! a folder of g1t's first on its `PATH`, holding this program under the
//! name `runc`, so every container it and its builder start passes
//! through here on its way to the real runc. Two changes, then the real
//! runc runs with the same arguments:
//!
//! - **BuildKit's `RUN` steps** that would join a bridge network join the
//!   job's own network instead (their network namespace and libnetwork's
//!   hook are taken out of the container's config), because a sandbox has
//!   no route out of a bridge. `RUN --network=none` stays without one.
//! - **In a guarded job**, every container (`docker run`, services, build
//!   steps, `docker exec`) gets the certificate the job's HTTPS is
//!   re-signed with: the folder of certificates at `/dev/g1t-egress`, and
//!   the variables that point common tools at it, unless the container
//!   sets them itself. `/dev` is a filesystem of the container's own, so
//!   nothing of this is ever written into an image's layers.
//!
//! Anything unexpected leaves the config as it was: this never stops a
//! container from starting.

use serde_json::{Value, json};

/// Where the certificates are seen inside a container.
pub(crate) const CA_MOUNT: &str = "/dev/g1t-egress";
/// The system's bundle, with the egress certificate added.
pub(crate) const BUNDLE: &str = "ca-certificates.crt";
/// The egress certificate alone.
pub(crate) const EGRESS: &str = "egress-ca.crt";

/// The variables a container is given in a guarded job, as the sandbox's
/// own (services/runner egress.ts `EGRESS_ENV`) point its tools.
pub(crate) fn ca_variables() -> Vec<(&'static str, String)> {
    let bundle = format!("{CA_MOUNT}/{BUNDLE}");
    vec![
        ("SSL_CERT_FILE", bundle.clone()),
        ("NODE_EXTRA_CA_CERTS", format!("{CA_MOUNT}/{EGRESS}")),
        ("REQUESTS_CA_BUNDLE", bundle.clone()),
        ("CURL_CA_BUNDLE", bundle.clone()),
        ("PIP_CERT", bundle.clone()),
        ("GIT_SSL_CAINFO", bundle.clone()),
        ("CARGO_HTTP_CAINFO", bundle),
    ]
}

/// What runc was asked to do, from its arguments.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Call {
    pub(crate) command: Option<String>,
    pub(crate) bundle: Option<String>,
    /// `runc exec --process <file>`.
    pub(crate) process: Option<String>,
}

/// runc's global flags that take a value.
const GLOBAL_VALUES: &[&str] = &["--root", "--log", "--log-format", "--criu", "--rootless"];

pub(crate) fn parse(args: &[String]) -> Call {
    let mut call = Call::default();
    let mut iter = args.iter().peekable();
    while let Some(arg) = iter.next() {
        if call.command.is_none() {
            if GLOBAL_VALUES.contains(&arg.as_str()) {
                iter.next();
            } else if !arg.starts_with('-') {
                call.command = Some(arg.clone());
            }
            continue;
        }
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value.to_owned())),
            _ => (arg.as_str(), None),
        };
        let mut value = || inline.clone().or_else(|| iter.next().cloned());
        match flag {
            "--bundle" | "-b" => call.bundle = value(),
            "--process" | "-p" => call.process = value(),
            _ => {}
        }
    }
    call
}

/// Whether a hook entry is libnetwork's, which joins a container to a
/// network the Engine set up.
fn libnetwork_hook(hook: &Value) -> bool {
    hook.get("args")
        .and_then(Value::as_array)
        .is_some_and(|args| args.iter().any(|a| a.as_str().is_some_and(|a| a.contains("libnetwork-setkey"))))
}

/// Adds the certificates and their variables to a process's environment.
fn add_variables(process: &mut Value) -> bool {
    let Some(env) = process.get_mut("env").and_then(Value::as_array_mut) else { return false };
    let mut changed = false;
    for (name, value) in ca_variables() {
        let prefix = format!("{name}=");
        if !env.iter().any(|e| e.as_str().is_some_and(|e| e.starts_with(&prefix))) {
            env.push(json!(format!("{name}={value}")));
            changed = true;
        }
    }
    changed
}

/// Changes a container's `config.json`. `ca_dir`: the folder of
/// certificates to give it, in a guarded job. Returns whether it changed.
pub(crate) fn patch_config(config: &mut Value, bundle: &str, ca_dir: Option<&str>) -> bool {
    let mut changed = false;
    // A BuildKit step bound for a bridge network: the job's network instead.
    if bundle.contains("/buildkit/") {
        let mut bridged = false;
        if let Some(hooks) = config.get_mut("hooks").and_then(Value::as_object_mut) {
            for list in hooks.values_mut() {
                if let Some(entries) = list.as_array_mut() {
                    let before = entries.len();
                    entries.retain(|hook| !libnetwork_hook(hook));
                    bridged |= entries.len() != before;
                }
            }
        }
        if bridged && let Some(namespaces) = config.pointer_mut("/linux/namespaces").and_then(Value::as_array_mut) {
            namespaces.retain(|ns| ns.get("type").and_then(Value::as_str) != Some("network"));
            changed = true;
        }
    }
    if let Some(dir) = ca_dir {
        if let Some(mounts) = config.get_mut("mounts").and_then(Value::as_array_mut)
            && !mounts.iter().any(|m| m.get("destination").and_then(Value::as_str) == Some(CA_MOUNT))
        {
            mounts.push(json!({
                "destination": CA_MOUNT,
                "type": "bind",
                "source": dir,
                "options": ["rbind", "ro", "nosuid", "nodev", "noexec"],
            }));
            changed = true;
        }
        if let Some(process) = config.get_mut("process") {
            changed |= add_variables(process);
        }
    }
    changed
}

/// Changes the process of a `runc exec` (`docker exec`), which has an
/// environment of its own.
pub(crate) fn patch_process(process: &mut Value, ca_dir: Option<&str>) -> bool {
    ca_dir.is_some() && add_variables(process)
}

/// Whether this program was started as `runc`.
pub(crate) fn invoked_as_runc() -> bool {
    std::env::args_os()
        .next()
        .and_then(|arg| std::path::Path::new(&arg).file_name().map(|name| name == "runc"))
        .unwrap_or(false)
}

/// Rewrites a JSON file in place, if `change` changes it.
#[cfg(unix)]
fn rewrite(path: &std::path::Path, change: impl FnOnce(&mut Value) -> bool) {
    let Ok(text) = std::fs::read(path) else { return };
    let Ok(mut value) = serde_json::from_slice::<Value>(&text) else { return };
    if change(&mut value)
        && let Ok(out) = serde_json::to_vec(&value)
    {
        let staged = path.with_extension("g1t");
        if std::fs::write(&staged, out).is_ok() {
            let _ = std::fs::rename(&staged, path);
        }
    }
}

/// `runc …`: changes the container's config, then becomes the real runc.
#[cfg(unix)]
pub(crate) fn main() -> ! {
    use std::os::unix::process::CommandExt;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let call = parse(&args);
    let ca_dir = std::env::var("G1T_DOCKER_CA_DIR").ok().filter(|dir| std::path::Path::new(dir).is_dir());
    match (call.command.as_deref(), &call.bundle, &call.process) {
        (Some("create" | "run"), Some(bundle), _) => {
            rewrite(&std::path::Path::new(bundle).join("config.json"), |config| patch_config(config, bundle, ca_dir.as_deref()));
        }
        (Some("exec"), _, Some(process)) => rewrite(std::path::Path::new(process), |process| patch_process(process, ca_dir.as_deref())),
        _ => {}
    }
    let real = std::env::var("G1T_REAL_RUNC").unwrap_or_else(|_| "/usr/bin/runc".into());
    let error = std::process::Command::new(&real).arg0("runc").args(&args).exec();
    eprintln!("g1t-runner: could not run {real}: {error}");
    std::process::exit(127)
}

#[cfg(not(unix))]
pub(crate) fn main() -> ! {
    eprintln!("g1t-runner: runc runs on Linux only");
    std::process::exit(127)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn calls_are_read_as_containerd_and_buildkit_make_them() {
        let call = parse(&args(
            "--root /var/run/docker/runtime-runc/moby --log /x/log.json --log-format json create --bundle /var/run/docker/containerd/daemon/io.containerd.runtime.v2.task/moby/abc --pid-file /x/init.pid abc",
        ));
        assert_eq!(call.command.as_deref(), Some("create"));
        assert_eq!(call.bundle.as_deref(), Some("/var/run/docker/containerd/daemon/io.containerd.runtime.v2.task/moby/abc"));
        let call = parse(&args("--log /var/lib/docker/buildkit/executor/runc-log.json --log-format json run --bundle /var/lib/docker/buildkit/executor/x1 --keep x1"));
        assert_eq!((call.command.as_deref(), call.bundle.as_deref()), (Some("run"), Some("/var/lib/docker/buildkit/executor/x1")));
        let call = parse(&args("--root /r exec --process /tmp/runc-process1 --detach --pid-file /p abc"));
        assert_eq!((call.command.as_deref(), call.process.as_deref()), (Some("exec"), Some("/tmp/runc-process1")));
        assert_eq!(parse(&args("--root=/r start abc")).command.as_deref(), Some("start"));
        assert_eq!(parse(&args("create --bundle=/b x")).bundle.as_deref(), Some("/b"));
        assert_eq!(parse(&args("--version")), Call::default());
    }

    fn build_step(hooked: bool) -> Value {
        let hooks = if hooked {
            json!({ "prestart": [{ "path": "/proc/21/exe", "args": ["libnetwork-setkey", "-exec-root=/var/run/docker", "abc", "def"] }] })
        } else {
            json!({})
        };
        json!({
            "hostname": "buildkitsandbox",
            "process": { "env": ["PATH=/usr/bin", "SSL_CERT_FILE=/mine.pem"] },
            "mounts": [{ "destination": "/proc" }, { "destination": "/dev", "type": "tmpfs" }],
            "linux": { "namespaces": [{ "type": "pid" }, { "type": "network" }, { "type": "mount" }] },
            "hooks": hooks,
        })
    }

    #[test]
    fn build_steps_bound_for_a_bridge_join_the_jobs_network() {
        let mut config = build_step(true);
        assert!(patch_config(&mut config, "/var/lib/docker/buildkit/executor/x1", None));
        let namespaces: Vec<&str> = config["linux"]["namespaces"].as_array().unwrap().iter().map(|n| n["type"].as_str().unwrap()).collect();
        assert_eq!(namespaces, vec!["pid", "mount"]);
        assert!(config["hooks"]["prestart"].as_array().unwrap().is_empty());
        // RUN --network=none: no libnetwork hook, so its own empty network.
        let mut config = build_step(false);
        assert!(!patch_config(&mut config, "/var/lib/docker/buildkit/executor/x2", None));
        assert_eq!(config["linux"]["namespaces"].as_array().unwrap().len(), 3);
        // A container the Engine runs is the API proxy's business, not this.
        let mut config = build_step(true);
        assert!(!patch_config(&mut config, "/run/containerd/io.containerd.runtime.v2.task/moby/abc", None));
    }

    #[test]
    fn guarded_containers_get_the_certificates_without_losing_their_own_settings() {
        let mut config = build_step(false);
        assert!(patch_config(&mut config, "/run/containerd/io.containerd.runtime.v2.task/moby/abc", Some("/run/g1t-docker/certs")));
        let mounts = config["mounts"].as_array().unwrap();
        let last = mounts.last().unwrap();
        assert_eq!(last["destination"], CA_MOUNT);
        assert_eq!(last["source"], "/run/g1t-docker/certs");
        assert!(last["options"].as_array().unwrap().contains(&json!("ro")));
        let env: Vec<&str> = config["process"]["env"].as_array().unwrap().iter().map(|e| e.as_str().unwrap()).collect();
        assert!(env.contains(&"SSL_CERT_FILE=/mine.pem"));
        assert!(!env.contains(&"SSL_CERT_FILE=/dev/g1t-egress/ca-certificates.crt"));
        assert!(env.contains(&"NODE_EXTRA_CA_CERTS=/dev/g1t-egress/egress-ca.crt"));
        // Patching twice changes nothing more.
        assert!(!patch_config(&mut config, "/run/containerd/io.containerd.runtime.v2.task/moby/abc", Some("/run/g1t-docker/certs")));
        let mut process = json!({ "env": ["PATH=/bin"] });
        assert!(patch_process(&mut process, Some("/run/g1t-docker/certs")));
        assert!(!patch_process(&mut json!({ "env": [] }), None));
    }
}
