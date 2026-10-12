//! Trusting the certificate a sandbox's HTTPS is re-signed with.
//!
//! When a sandbox's network is restricted by its project's guardrails (or a
//! workflow job may be given brokered secrets), its HTTP and HTTPS pass the
//! runner Worker, which re-signs HTTPS with a certificate Cloudflare puts in
//! the sandbox. The network list, the credentials a sandbox holds, and
//! branch protection on g1t's side are what bound a sandbox's work.

use std::path::Path;
use std::process::{Command, Stdio};

/// The certificate the sandbox's HTTPS is re-signed with, when it is guarded.
const EGRESS_CA: &str = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/// Runs a command as root without asking. False where that is not allowed.
fn sudo(args: &[&str]) -> bool {
    Command::new("sudo")
        .arg("-n")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Trusts the certificate a guarded sandbox's HTTPS is re-signed with, so
/// that git, package managers and this program can reach allowed hosts.
/// Does nothing in a sandbox whose network is open. Called first thing,
/// before any request is made.
pub fn trust_egress_ca() {
    const TRUSTED: &str = "/usr/local/share/ca-certificates/cloudflare-containers-ca.crt";
    // Once per sandbox.
    if !Path::new(EGRESS_CA).exists() || Path::new(TRUSTED).exists() {
        return;
    }
    let trusted = sudo(&["cp", EGRESS_CA, TRUSTED]) && sudo(&["update-ca-certificates"]);
    if !trusted {
        eprintln!("g1t-runner: could not trust the sandbox's egress certificate; HTTPS will fail");
    }
}
