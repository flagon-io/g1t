//! The Engine API as a job sees it: `/var/run/docker.sock` is this proxy,
//! and the job's own Docker Engine is behind it. It passes everything
//! through, and changes the few requests that would not work in a
//! sandbox as they are:
//!
//! - **A container's network.** A sandbox cannot route a container's
//!   bridge network out (Cloudflare Containers allow no iptables and no IP
//!   forwarding), so containers join the job's own network (`host`), the
//!   one its guardrails apply to. The names a container would have had on
//!   its network (its name, its aliases, its Compose service) resolve to
//!   127.0.0.1 in later containers and in the job's own steps, and a port
//!   published under another number (`-p 8080:80`) is forwarded to it.
//!   `docker inspect` reports the ports as published, for tools that look
//!   a container's port up.
//! - **Networks joined later** (`docker network connect`): the container
//!   already has the job's network, so the request only adds its aliases.
//! - **The classic builder** (`DOCKER_BUILDKIT=0`): its `RUN` steps use the
//!   job's network too. BuildKit's are handled where they start (oci.rs).
//! - **Miners**: a container whose image or command names one is refused,
//!   as a step's script would be.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, BufReader, Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};

use super::http;

/// What the proxy remembers across connections.
#[derive(Default)]
pub(crate) struct State {
    /// Every name a container has been given, which all now mean 127.0.0.1.
    pub(crate) aliases: BTreeSet<String>,
    /// Containers moved to the job's network: by id and by name, the ports
    /// they publish (`80/tcp` → the host port, as text).
    pub(crate) published: BTreeMap<String, BTreeMap<String, String>>,
}

/// What the proxy asks of the sandbox around it.
pub(crate) trait Host: Send + Sync {
    /// Makes names resolve to 127.0.0.1 in the job's own steps.
    fn add_hosts(&self, names: &[String]);
    /// Forwards a host port to a container's port on the job's network.
    fn forward(&self, host_port: u16, container_port: u16);
    /// Makes sure the Engine is running; why not, if it cannot be.
    fn ensure_engine(&self) -> Result<(), String>;
    /// Connects to the Engine itself.
    fn connect(&self) -> io::Result<Box<dyn Duplex>>;
}

/// A connection, readable and writable from two threads.
pub(crate) trait Duplex: Read + Write + Send {
    fn try_clone_box(&self) -> io::Result<Box<dyn Duplex>>;
    fn shutdown_both(&self);
    /// Ends what this side sends, and goes on reading.
    fn shutdown_write(&self);
}

impl Duplex for std::net::TcpStream {
    fn try_clone_box(&self) -> io::Result<Box<dyn Duplex>> {
        Ok(Box::new(self.try_clone()?))
    }
    fn shutdown_both(&self) {
        let _ = self.shutdown(std::net::Shutdown::Both);
    }
    fn shutdown_write(&self) {
        let _ = self.shutdown(std::net::Shutdown::Write);
    }
}

#[cfg(unix)]
impl Duplex for std::os::unix::net::UnixStream {
    fn try_clone_box(&self) -> io::Result<Box<dyn Duplex>> {
        Ok(Box::new(self.try_clone()?))
    }
    fn shutdown_both(&self) {
        let _ = self.shutdown(std::net::Shutdown::Both);
    }
    fn shutdown_write(&self) {
        let _ = self.shutdown(std::net::Shutdown::Write);
    }
}

/// The Engine's routes start with an optional `/v1.NN`.
fn route(target: &str) -> (&str, &str) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let path = match path.strip_prefix("/v") {
        Some(rest) if rest.starts_with(|c: char| c.is_ascii_digit()) => rest.find('/').map_or(path, |slash| &rest[slash..]),
        _ => path,
    };
    (path, query)
}

fn query_value<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| pair.split_once('=').filter(|(key, _)| *key == name).map(|(_, value)| value))
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match bytes[i] {
            b'%' if i + 2 < bytes.len() && hex(bytes[i + 1]).is_some() && hex(bytes[i + 2]).is_some() => {
                out.push((hex(bytes[i + 1]).unwrap_or(0) * 16 + hex(bytes[i + 2]).unwrap_or(0)) as u8);
                i += 3;
                continue;
            }
            b'+' => out.push(b' '),
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What a request is, to the proxy.
#[derive(Debug, PartialEq)]
pub(crate) enum Kind {
    CreateContainer { name: Option<String> },
    InspectContainer { id: String },
    ConnectNetwork,
    DisconnectNetwork,
    ClassicBuild,
    Other,
}

pub(crate) fn classify(method: &str, target: &str) -> Kind {
    let (path, query) = route(target);
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    match (method, parts.as_slice()) {
        ("POST", ["containers", "create"]) => Kind::CreateContainer { name: query_value(query, "name").map(decode).filter(|n| !n.is_empty()) },
        ("GET", ["containers", id, "json"]) => Kind::InspectContainer { id: decode(id) },
        ("POST", ["networks", _, "connect"]) => Kind::ConnectNetwork,
        ("POST", ["networks", _, "disconnect"]) => Kind::DisconnectNetwork,
        ("POST", ["build"]) => Kind::ClassicBuild,
        _ => Kind::Other,
    }
}

/// Whether a network mode is one a sandbox can run as it is.
fn keeps_network(mode: &str) -> bool {
    matches!(mode, "host" | "none") || mode.starts_with("container:")
}

/// Whether a name can stand in `/etc/hosts`.
fn host_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name != "localhost"
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
        && !name.starts_with(['-', '.'])
}

/// What changing a container's create request came to.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Created {
    /// The network it asked for, now the job's.
    pub(crate) moved_from: Option<String>,
    /// Its own names, now meaning 127.0.0.1.
    pub(crate) aliases: Vec<String>,
    /// `(host port, container port)` pairs to forward.
    pub(crate) forwards: Vec<(u16, u16)>,
    /// What `docker inspect` should say it publishes.
    pub(crate) published: BTreeMap<String, String>,
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

/// Moves a container to the job's network, unless it asked for `host`,
/// `none` or another container's. `known` is every name given so far.
pub(crate) fn rewrite_create(body: &mut Value, name: Option<&str>, known: &BTreeSet<String>) -> Created {
    let mut created = Created::default();
    let Some(config) = body.as_object_mut() else { return created };
    let host_config = config.entry("HostConfig").or_insert_with(|| json!({}));
    if !host_config.is_object() {
        *host_config = json!({});
    }
    let mode = host_config.get("NetworkMode").and_then(Value::as_str).unwrap_or_default().to_owned();
    if keeps_network(&mode) {
        return created;
    }
    created.moved_from = Some(if mode.is_empty() || mode == "default" { "bridge".to_owned() } else { mode.clone() });

    // Its names: its own, its aliases on each network, its links' aliases
    // and its Compose service.
    let mut aliases: Vec<String> = Vec::new();
    if let Some(name) = name {
        aliases.push(name.trim_start_matches('/').to_owned());
    }
    if let Some(Value::Object(endpoints)) = config.get("NetworkingConfig").and_then(|n| n.get("EndpointsConfig")) {
        for endpoint in endpoints.values() {
            aliases.extend(strings(endpoint.get("Aliases")));
            aliases.extend(strings(endpoint.get("DNSNames")));
        }
    }
    if let Some(service) = config.get("Labels").and_then(|l| l.get("com.docker.compose.service")).and_then(Value::as_str) {
        aliases.push(service.to_owned());
    }
    let host_config = config.get_mut("HostConfig").and_then(Value::as_object_mut).expect("made above");
    for link in strings(host_config.get("Links")) {
        // `name:alias`, or `/name:/container/alias` as the Engine stores them.
        if let Some((_, alias)) = link.split_once(':') {
            aliases.push(alias.rsplit('/').next().unwrap_or(alias).to_owned());
        }
    }
    let mut seen = BTreeSet::new();
    aliases.retain(|alias| host_name(alias) && seen.insert(alias.clone()));
    created.aliases = aliases.clone();

    // Ports: published under the same number, they need nothing; under
    // another, a forward. A port left to the Engine to choose is the
    // container's own.
    if let Some(Value::Object(bindings)) = host_config.get("PortBindings") {
        for (port, hosts) in bindings {
            let (number, protocol) = port.split_once('/').unwrap_or((port, "tcp"));
            let Ok(container_port) = number.parse::<u16>() else { continue };
            let host_port = hosts
                .as_array()
                .and_then(|list| list.iter().find_map(|h| h.get("HostPort").and_then(Value::as_str).filter(|p| !p.is_empty())))
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(container_port);
            created.published.insert(format!("{container_port}/{protocol}"), host_port.to_string());
            if host_port != container_port && protocol == "tcp" {
                created.forwards.push((host_port, container_port));
            }
        }
    }

    host_config.insert("NetworkMode".into(), json!("host"));
    host_config.remove("Links");
    host_config.insert("PublishAllPorts".into(), json!(false));
    let mut extra = strings(host_config.get("ExtraHosts"));
    for alias in known.iter().chain(aliases.iter()) {
        let entry = format!("{alias}:127.0.0.1");
        if !extra.iter().any(|e| e.split(':').next() == Some(alias.as_str())) {
            extra.push(entry);
        }
    }
    host_config.insert("ExtraHosts".into(), json!(extra));
    config.remove("NetworkingConfig");
    config.remove("MacAddress");
    created
}

/// What `docker network connect` adds: the container's aliases there.
pub(crate) fn connect_aliases(body: &Value) -> Vec<String> {
    let mut aliases = strings(body.get("EndpointConfig").and_then(|e| e.get("Aliases")));
    aliases.extend(strings(body.get("EndpointConfig").and_then(|e| e.get("DNSNames"))));
    aliases.retain(|alias| host_name(alias));
    aliases
}

/// A container's inspection, with the ports it publishes filled in.
pub(crate) fn rewrite_inspect(body: &mut Value, published: &BTreeMap<String, String>) {
    let ports: Map<String, Value> = published
        .iter()
        .map(|(port, host)| (port.clone(), json!([{ "HostIp": "0.0.0.0", "HostPort": host }])))
        .collect();
    if let Some(settings) = body.get_mut("NetworkSettings").and_then(Value::as_object_mut) {
        settings.insert("Ports".into(), Value::Object(ports));
    }
}

/// The classic builder's `RUN` steps on the job's network.
pub(crate) fn rewrite_build(target: &str) -> String {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let mode = query_value(query, "networkmode").unwrap_or_default();
    if keeps_network(mode) {
        return target.to_owned();
    }
    let mut pairs: Vec<&str> = query.split('&').filter(|pair| !pair.is_empty() && !pair.starts_with("networkmode=")).collect();
    pairs.push("networkmode=host");
    format!("{path}?{}", pairs.join("&"))
}

/// What the response thread is to do with the next response.
enum Pending {
    /// Pass it through.
    Plain { method: String },
    /// A container was created: note its id against its ports.
    Created { name: Option<String>, published: BTreeMap<String, String> },
    /// Fill in an inspection's ports.
    Inspect { published: BTreeMap<String, String> },
    /// Answer it here: the Engine was never asked.
    Answer(Vec<u8>),
    /// The connection leaves HTTP after this response.
    Upgrade,
}

/// Serves one connection from a client, until either side closes it.
pub(crate) fn serve(client: Box<dyn Duplex>, host: Arc<dyn Host>, state: Arc<Mutex<State>>) {
    if let Err(problem) = host.ensure_engine() {
        let mut client = client;
        let mut reader = BufReader::new(client.try_clone_box().expect("a clone"));
        // Answer whatever was asked, so the CLI says why.
        if let Ok(Some(head)) = http::read_head(&mut reader) {
            let _ = http::read_body(&mut reader, http::request_body(&head));
            let _ = client.write_all(&http::json_response(503, "Service Unavailable", &json!({ "message": problem })));
        }
        client.shutdown_both();
        return;
    }
    let upstream = match host.connect() {
        Ok(upstream) => upstream,
        Err(_) => {
            client.shutdown_both();
            return;
        }
    };
    let (Ok(client_writer), Ok(upstream_reader)) = (client.try_clone_box(), upstream.try_clone_box()) else { return };
    let (sender, pending) = mpsc::channel::<Pending>();
    let responses = {
        let state = state.clone();
        std::thread::spawn(move || answer(upstream_reader, client_writer, pending, state))
    };
    let _ = forward(client, upstream, sender, &host, &state);
    let _ = responses.join();
}

/// Requests, client to Engine.
fn forward(client: Box<dyn Duplex>, mut upstream: Box<dyn Duplex>, pending: mpsc::Sender<Pending>, host: &Arc<dyn Host>, state: &Arc<Mutex<State>>) -> io::Result<()> {
    let closer = client.try_clone_box()?;
    let upstream_closer = upstream.try_clone_box()?;
    let mut reader = BufReader::new(client);
    let result = (|| -> io::Result<()> {
        loop {
            let Some(mut head) = http::read_head(&mut reader)? else { return Ok(()) };
            let body = http::request_body(&head);
            let method = head.method().to_owned();
            match classify(&method, head.target()) {
                Kind::CreateContainer { name } => {
                    let raw = http::read_body(&mut reader, body)?;
                    let Ok(mut config) = serde_json::from_slice::<Value>(&raw) else {
                        upstream.write_all(&http::with_length(head, &raw))?;
                        let _ = pending.send(Pending::Plain { method });
                        continue;
                    };
                    if let Some(miner) = miner_in_config(&config) {
                        let refusal = json!({ "message": format!("g1t does not run cryptocurrency miners ({miner}). This container was not created.") });
                        let _ = pending.send(Pending::Answer(http::json_response(403, "Forbidden", &refusal)));
                        continue;
                    }
                    let known = state.lock().map(|s| s.aliases.clone()).unwrap_or_default();
                    let created = rewrite_create(&mut config, name.as_deref(), &known);
                    if created.moved_from.is_some() {
                        let fresh: Vec<String> = created.aliases.iter().filter(|a| !known.contains(*a)).cloned().collect();
                        if let Ok(mut state) = state.lock() {
                            state.aliases.extend(created.aliases.iter().cloned());
                            // By name now; by id once the Engine says it.
                            if let Some(name) = &name {
                                state.published.insert(name.trim_start_matches('/').to_owned(), created.published.clone());
                            }
                        }
                        if !fresh.is_empty() {
                            host.add_hosts(&fresh);
                        }
                        for (host_port, container_port) in &created.forwards {
                            host.forward(*host_port, *container_port);
                        }
                    }
                    let text = serde_json::to_vec(&config).unwrap_or(raw);
                    upstream.write_all(&http::with_length(head, &text))?;
                    let _ = pending.send(if created.moved_from.is_some() {
                        Pending::Created { name, published: created.published }
                    } else {
                        Pending::Plain { method }
                    });
                }
                Kind::InspectContainer { id } => {
                    let published = state.lock().ok().and_then(|s| published_for(&s, &id));
                    upstream.write_all(&head.to_bytes())?;
                    http::copy_body(&mut reader, &mut upstream, body)?;
                    let _ = pending.send(match published {
                        Some(published) => Pending::Inspect { published },
                        None => Pending::Plain { method },
                    });
                }
                kind @ (Kind::ConnectNetwork | Kind::DisconnectNetwork) => {
                    let raw = http::read_body(&mut reader, body)?;
                    let value: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
                    let container = value.get("Container").and_then(Value::as_str).unwrap_or_default().to_owned();
                    let moved = state.lock().ok().is_some_and(|s| published_for(&s, &container).is_some());
                    if moved {
                        // The container is on the job's network already.
                        if kind == Kind::ConnectNetwork {
                            let aliases = connect_aliases(&value);
                            let fresh: Vec<String> = match state.lock() {
                                Ok(mut state) => aliases.into_iter().filter(|a| state.aliases.insert(a.clone())).collect(),
                                Err(_) => Vec::new(),
                            };
                            if !fresh.is_empty() {
                                host.add_hosts(&fresh);
                            }
                        }
                        let _ = pending.send(Pending::Answer(http::empty_ok()));
                    } else {
                        upstream.write_all(&http::with_length(head, &raw))?;
                        let _ = pending.send(Pending::Plain { method });
                    }
                }
                Kind::ClassicBuild => {
                    let target = rewrite_build(head.target());
                    head.set_target(&target);
                    upstream.write_all(&head.to_bytes())?;
                    http::copy_body(&mut reader, &mut upstream, body)?;
                    let _ = pending.send(Pending::Plain { method });
                }
                Kind::Other => {
                    let upgrade = head.upgrades();
                    upstream.write_all(&head.to_bytes())?;
                    if upgrade {
                        let _ = pending.send(Pending::Upgrade);
                        // From here the two ends speak to each other.
                        io::copy(&mut reader, &mut upstream)?;
                        upstream_closer.shutdown_write();
                        return Ok(());
                    }
                    http::copy_body(&mut reader, &mut upstream, body)?;
                    let _ = pending.send(Pending::Plain { method });
                }
            }
        }
    })();
    // The client is done asking; the Engine's answers may still be coming.
    drop(pending);
    if result.is_err() {
        closer.shutdown_both();
        upstream_closer.shutdown_both();
    }
    result
}

/// Responses, Engine to client, in the order they were asked for.
fn answer(upstream: Box<dyn Duplex>, mut client: Box<dyn Duplex>, pending: mpsc::Receiver<Pending>, state: Arc<Mutex<State>>) {
    let closer = upstream.try_clone_box().ok();
    let mut reader = BufReader::new(upstream);
    let result = (|| -> io::Result<()> {
        while let Ok(next) = pending.recv() {
            if let Pending::Answer(bytes) = next {
                client.write_all(&bytes)?;
                client.flush()?;
                continue;
            }
            let Some(head) = http::read_head(&mut reader)? else { return Ok(()) };
            match next {
                Pending::Upgrade => {
                    client.write_all(&head.to_bytes())?;
                    client.flush()?;
                    io::copy(&mut reader, &mut client)?;
                    client.shutdown_write();
                    return Err(io::Error::other("upgraded"));
                }
                Pending::Plain { method } => {
                    let body = http::response_body(&head, &method);
                    client.write_all(&head.to_bytes())?;
                    http::copy_body(&mut reader, &mut client, body)?;
                }
                Pending::Created { name, published } => {
                    let body = http::read_body(&mut reader, http::response_body(&head, "POST"))?;
                    if (200..300).contains(&head.status())
                        && let Some(id) = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v.get("Id").and_then(Value::as_str).map(str::to_owned))
                        && let Ok(mut state) = state.lock()
                    {
                        state.published.insert(id, published.clone());
                        if let Some(name) = name {
                            state.published.insert(name.trim_start_matches('/').to_owned(), published);
                        }
                    }
                    client.write_all(&http::with_length(head, &body))?;
                }
                Pending::Inspect { published } => {
                    let body = http::read_body(&mut reader, http::response_body(&head, "GET"))?;
                    let rewritten = match serde_json::from_slice::<Value>(&body) {
                        Ok(mut value) if head.status() == 200 => {
                            rewrite_inspect(&mut value, &published);
                            serde_json::to_vec(&value).unwrap_or(body)
                        }
                        _ => body,
                    };
                    client.write_all(&http::with_length(head, &rewritten))?;
                }
                Pending::Answer(_) => unreachable!("answered above"),
            }
            client.flush()?;
        }
        Ok(())
    })();
    if matches!(&result, Err(error) if error.to_string() == "upgraded") {
        // A hijacked connection ends when both ends have said so.
        return;
    }
    client.shutdown_both();
    if let Some(closer) = closer {
        closer.shutdown_both();
    }
}

/// The ports of a container moved to the job's network, by its id, the
/// start of its id, or its name.
fn published_for(state: &State, id: &str) -> Option<BTreeMap<String, String>> {
    let id = id.trim_start_matches('/');
    if id.is_empty() {
        return None;
    }
    if let Some(found) = state.published.get(id) {
        return Some(found.clone());
    }
    if id.len() >= 6 && id.chars().all(|c| c.is_ascii_hexdigit()) {
        let mut matches = state.published.iter().filter(|(key, _)| key.len() == 64 && key.starts_with(id));
        if let (Some((_, found)), None) = (matches.next(), matches.next()) {
            return Some(found.clone());
        }
    }
    None
}

/// The miner a container's image or command names, if any.
fn miner_in_config(config: &Value) -> Option<&'static str> {
    let mut words = vec![config.get("Image").and_then(Value::as_str).unwrap_or_default().to_owned()];
    for key in ["Entrypoint", "Cmd"] {
        match config.get(key) {
            Some(Value::String(text)) => words.push(text.clone()),
            other => words.extend(strings(other)),
        }
    }
    crate::abuse::miner_in(&words.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_are_read_with_or_without_a_version() {
        assert_eq!(classify("POST", "/v1.47/containers/create?name=db"), Kind::CreateContainer { name: Some("db".into()) });
        assert_eq!(classify("POST", "/containers/create"), Kind::CreateContainer { name: None });
        assert_eq!(classify("GET", "/v1.51/containers/abc123/json?size=false"), Kind::InspectContainer { id: "abc123".into() });
        assert_eq!(classify("POST", "/v1.47/networks/app_default/connect"), Kind::ConnectNetwork);
        assert_eq!(classify("POST", "/v1.47/build?t=x"), Kind::ClassicBuild);
        assert_eq!(classify("GET", "/v1.47/containers/json"), Kind::Other);
        assert_eq!(classify("POST", "/v1.47/containers/abc/start"), Kind::Other);
    }

    #[test]
    fn a_compose_service_moves_to_the_jobs_network_and_keeps_its_names() {
        let mut body = json!({
            "Image": "postgres:17",
            "Labels": { "com.docker.compose.service": "db", "com.docker.compose.project": "app" },
            "HostConfig": {
                "NetworkMode": "app_default",
                "PortBindings": { "5432/tcp": [{ "HostIp": "", "HostPort": "15432" }], "8080/tcp": [{ "HostPort": "" }] },
                "Links": ["/cache:/app-db-1/redis"],
                "ExtraHosts": ["host.docker.internal:host-gateway"],
            },
            "NetworkingConfig": { "EndpointsConfig": { "app_default": { "Aliases": ["db", "app-db-1"], "MacAddress": "x" } } },
        });
        let known: BTreeSet<String> = ["cache".to_owned()].into();
        let created = rewrite_create(&mut body, Some("app-db-1"), &known);
        assert_eq!(created.moved_from.as_deref(), Some("app_default"));
        assert_eq!(created.aliases, vec!["app-db-1", "db", "redis"]);
        assert_eq!(created.forwards, vec![(15432, 5432)]);
        assert_eq!(created.published["5432/tcp"], "15432");
        assert_eq!(created.published["8080/tcp"], "8080");
        assert_eq!(body["HostConfig"]["NetworkMode"], "host");
        assert!(body.get("NetworkingConfig").is_none());
        assert!(body["HostConfig"].get("Links").is_none());
        let extra = strings(body["HostConfig"].get("ExtraHosts"));
        assert!(extra.contains(&"host.docker.internal:host-gateway".to_owned()));
        for name in ["cache", "db", "app-db-1", "redis"] {
            assert!(extra.contains(&format!("{name}:127.0.0.1")), "{name} in {extra:?}");
        }
    }

    #[test]
    fn host_none_and_shared_networks_are_left_alone() {
        for mode in ["host", "none", "container:abc"] {
            let mut body = json!({ "Image": "alpine", "HostConfig": { "NetworkMode": mode } });
            let before = body.clone();
            assert_eq!(rewrite_create(&mut body, Some("x"), &BTreeSet::new()), Created::default());
            assert_eq!(body, before);
        }
        // The default network, named or not.
        let mut body = json!({ "Image": "alpine" });
        assert_eq!(rewrite_create(&mut body, None, &BTreeSet::new()).moved_from.as_deref(), Some("bridge"));
        assert_eq!(body["HostConfig"]["NetworkMode"], "host");
    }

    #[test]
    fn names_that_cannot_be_hosts_are_skipped() {
        let mut body = json!({ "HostConfig": {}, "NetworkingConfig": { "EndpointsConfig": { "n": { "Aliases": ["ok-name", "bad name", "localhost", ""] } } } });
        assert_eq!(rewrite_create(&mut body, None, &BTreeSet::new()).aliases, vec!["ok-name"]);
    }

    #[test]
    fn inspections_report_the_ports_published() {
        let mut body = json!({ "Id": "abc", "NetworkSettings": { "Ports": {}, "Networks": { "host": {} } } });
        rewrite_inspect(&mut body, &[("5432/tcp".to_owned(), "15432".to_owned())].into());
        assert_eq!(body["NetworkSettings"]["Ports"]["5432/tcp"][0]["HostPort"], "15432");
    }

    #[test]
    fn the_classic_builder_runs_on_the_jobs_network() {
        assert_eq!(rewrite_build("/v1.47/build?t=app&networkmode=default"), "/v1.47/build?t=app&networkmode=host");
        assert_eq!(rewrite_build("/build"), "/build?networkmode=host");
        assert_eq!(rewrite_build("/build?networkmode=none"), "/build?networkmode=none");
    }

    #[test]
    fn ids_are_found_by_their_start_or_a_name() {
        let mut state = State::default();
        let id = "a".repeat(64);
        state.published.insert(id.clone(), [("80/tcp".to_owned(), "8080".to_owned())].into());
        state.published.insert("web".into(), [("80/tcp".to_owned(), "8080".to_owned())].into());
        assert!(published_for(&state, "aaaaaaaaaaaa").is_some());
        assert!(published_for(&state, "/web").is_some());
        assert!(published_for(&state, "aaa").is_none());
        assert!(published_for(&state, "other").is_none());
    }

    #[test]
    fn miners_are_refused_by_image_or_command() {
        assert!(miner_in_config(&json!({ "Image": "metal3d/xmrig" })).is_some());
        assert!(miner_in_config(&json!({ "Image": "alpine", "Cmd": ["sh", "-c", "./xmrig -o stratum+tcp://pool"] })).is_some());
        assert!(miner_in_config(&json!({ "Image": "postgres:17", "Cmd": ["postgres"] })).is_none());
    }

    /// A pretend Engine on TCP, and the proxy in front of it, end to end.
    #[test]
    fn requests_and_responses_pass_through_in_order() {
        use std::net::{TcpListener, TcpStream};
        let engine = TcpListener::bind("127.0.0.1:0").unwrap();
        let engine_addr = engine.local_addr().unwrap();
        // The Engine: a create, an inspect, a chunked stream, then a hijack.
        let fake = std::thread::spawn(move || {
            let (stream, _) = engine.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut writer = stream;
            let mut seen = Vec::new();
            while let Some(head) = http::read_head(&mut reader).unwrap() {
                let body = http::read_body(&mut reader, http::request_body(&head)).unwrap();
                seen.push((head.start.clone(), String::from_utf8_lossy(&body).into_owned()));
                if head.target().contains("/containers/create") {
                    writer.write_all(&http::json_response(201, "Created", &json!({ "Id": "c".repeat(64), "Warnings": [] }))).unwrap();
                } else if head.target().contains("/json") {
                    writer
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n")
                        .unwrap();
                    let text = json!({ "Id": "c".repeat(64), "NetworkSettings": { "Ports": {} } }).to_string();
                    writer.write_all(format!("{:x}\r\n{text}\r\n0\r\n\r\n", text.len()).as_bytes()).unwrap();
                } else if head.target().contains("/logs") {
                    writer.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\none\r\n3\r\ntwo\r\n0\r\n\r\n").unwrap();
                } else if head.upgrades() {
                    writer.write_all(b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n").unwrap();
                    let mut buffer = [0u8; 5];
                    reader.read_exact(&mut buffer).unwrap();
                    writer.write_all(&buffer).unwrap();
                    break;
                }
            }
            seen
        });

        struct Fake(std::net::SocketAddr, Mutex<Vec<(u16, u16)>>, Mutex<Vec<String>>);
        impl Host for Fake {
            fn add_hosts(&self, names: &[String]) {
                self.2.lock().unwrap().extend(names.iter().cloned());
            }
            fn forward(&self, host_port: u16, container_port: u16) {
                self.1.lock().unwrap().push((host_port, container_port));
            }
            fn ensure_engine(&self) -> Result<(), String> {
                Ok(())
            }
            fn connect(&self) -> io::Result<Box<dyn Duplex>> {
                Ok(Box::new(TcpStream::connect(self.0)?))
            }
        }
        let host = Arc::new(Fake(engine_addr, Mutex::new(Vec::new()), Mutex::new(Vec::new())));
        let state = Arc::new(Mutex::new(State::default()));
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy_addr = proxy.local_addr().unwrap();
        let (host2, state2) = (host.clone() as Arc<dyn Host>, state.clone());
        std::thread::spawn(move || {
            let (stream, _) = proxy.accept().unwrap();
            serve(Box::new(stream), host2, state2);
        });

        let client = TcpStream::connect(proxy_addr).unwrap();
        let mut reader = BufReader::new(client.try_clone().unwrap());
        let mut writer = client;
        let create = json!({ "Image": "redis", "HostConfig": { "PortBindings": { "6379/tcp": [{ "HostPort": "16379" }] } }, "NetworkingConfig": { "EndpointsConfig": { "job": { "Aliases": ["redis"] } } } }).to_string();
        // Pipelined: all asked before any answer is read.
        writer
            .write_all(format!("POST /v1.47/containers/create?name=cache HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{create}", create.len()).as_bytes())
            .unwrap();
        writer.write_all(b"GET /v1.47/containers/cache/json HTTP/1.1\r\nHost: docker\r\n\r\n").unwrap();
        writer.write_all(b"GET /v1.47/containers/cache/logs?follow=1 HTTP/1.1\r\nHost: docker\r\n\r\n").unwrap();
        writer.write_all(b"POST /v1.47/containers/cache/attach?stream=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nhello").unwrap();

        let created = http::read_head(&mut reader).unwrap().unwrap();
        assert_eq!(created.status(), 201);
        let body: Value = serde_json::from_slice(&http::read_body(&mut reader, http::response_body(&created, "POST")).unwrap()).unwrap();
        assert_eq!(body["Id"].as_str().unwrap().len(), 64);
        let inspected = http::read_head(&mut reader).unwrap().unwrap();
        let body: Value = serde_json::from_slice(&http::read_body(&mut reader, http::response_body(&inspected, "GET")).unwrap()).unwrap();
        assert_eq!(body["NetworkSettings"]["Ports"]["6379/tcp"][0]["HostPort"], "16379");
        let logs = http::read_head(&mut reader).unwrap().unwrap();
        assert_eq!(http::read_body(&mut reader, http::response_body(&logs, "GET")).unwrap(), b"onetwo");
        let upgraded = http::read_head(&mut reader).unwrap().unwrap();
        assert_eq!(upgraded.status(), 101);
        let mut echoed = [0u8; 5];
        reader.read_exact(&mut echoed).unwrap();
        assert_eq!(&echoed, b"hello");

        let seen = fake.join().unwrap();
        assert!(seen[0].1.contains("\"NetworkMode\":\"host\""), "{}", seen[0].1);
        assert!(seen[0].1.contains("redis:127.0.0.1"));
        assert_eq!(*host.1.lock().unwrap(), vec![(16379, 6379)]);
        assert_eq!(*host.2.lock().unwrap(), vec!["cache".to_owned(), "redis".to_owned()]);
    }
}
