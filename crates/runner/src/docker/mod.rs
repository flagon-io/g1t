//! Docker in a workflow job on g1t's own machines: a Docker Engine of the
//! job's own, inside its sandbox, started the first time anything asks
//! for it, and gone with the sandbox when the job ends.
//!
//! - `engine` starts it, as root inside the sandbox (as Cloudflare
//!   Containers run Docker), with no iptables and no IP forwarding, which
//!   a sandbox does not have.
//! - `api` is `/var/run/docker.sock`: the Engine's API, with containers
//!   moved to the job's own network, where its guardrails apply.
//! - `oci` is the `runc` the Engine runs containers with: build steps on
//!   the job's network, and a guarded job's egress certificate in every
//!   container.
//! - `http` is the HTTP/1.1 the proxy reads.
//!
//! Nothing here is shared with another job: each job has its own sandbox,
//! and so its own Engine, images and build cache.

// Off g1t's Linux machines only the pure parts are used, by tests.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

pub(crate) mod api;
pub(crate) mod engine;
pub(crate) mod http;
pub(crate) mod oci;

use std::sync::Mutex;

/// Lines for the job's log, from threads that do not hold it: the Engine
/// starting, a port that could not be forwarded.
static NOTES: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub(crate) fn note(line: impl Into<String>) {
    if let Ok(mut notes) = NOTES.lock() {
        notes.push(line.into());
    }
}

/// The lines noted since the last call.
pub(crate) fn take_notes() -> Vec<String> {
    NOTES.lock().map(|mut notes| std::mem::take(&mut *notes)).unwrap_or_default()
}
