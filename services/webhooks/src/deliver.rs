//! What a delivery is made of, apart from sending it: the payload, the
//! signature, when to try again, and which addresses may be sent to.

use g1t_contracts::events::Event;
use g1t_contracts::webhooks::EVENT_TYPES;
use serde_json::{Value, json};

/// How long to wait after each failed attempt before the next, so a
/// delivery gets six attempts over about seven and a half hours.
pub const RETRY_WAITS_SECONDS: [u64; 5] = [60, 5 * 60, 30 * 60, 2 * 60 * 60, 5 * 60 * 60];

/// When to try again after `attempts` attempts, in seconds from now, or
/// `None` when it has had them all.
pub fn retry_after(attempts: u32) -> Option<u64> {
    RETRY_WAITS_SECONDS.get(attempts.checked_sub(1)? as usize).copied()
}

/// Whether a webhook that wants `wanted` is sent an event of type `kind`.
pub fn wants(wanted: &[String], kind: &str) -> bool {
    wanted.iter().any(|event| event == "*" || event == kind)
}

/// Event types as given, checked and in catalogue order. `["*"]` when none
/// or all are given. `Err` names the first that is not one.
pub fn tidy_events(given: &[String]) -> Result<Vec<String>, String> {
    if given.is_empty() || given.iter().any(|event| event == "*") {
        return Ok(vec!["*".to_owned()]);
    }
    if let Some(unknown) = given.iter().find(|event| !EVENT_TYPES.contains(&event.as_str())) {
        return Err(format!("There is no event called {unknown}."));
    }
    Ok(EVENT_TYPES
        .iter()
        .filter(|kind| given.iter().any(|event| event == *kind))
        .map(|kind| (*kind).to_owned())
        .collect())
}

/// What is sent for an event: the event as the bus has it, with the
/// repository, the workspace and whoever caused it named.
pub fn payload(event: &Event, workspace: &str, repo: Option<(&str, &str)>, actor_name: Option<&str>) -> Value {
    json!({
        "id": event.id,
        "type": event.kind,
        "time": event.time,
        "workspace": workspace,
        "repository": repo.map(|(id, full_name)| json!({ "id": id, "fullName": full_name })),
        "actor": event.actor.as_ref().map(|id| json!({ "id": id, "username": actor_name })),
        "data": event.data,
    })
}

/// What is sent to check a webhook works.
pub fn ping(hook_id: &str, url: &str, events: &[String], time: &str) -> Value {
    json!({
        "type": "ping",
        "time": time,
        "hook": { "id": hook_id, "url": url, "events": events },
        "message": "g1t will send this webhook's events here.",
    })
}

/// The signature header's value: the body's HMAC-SHA256 under the secret.
pub fn signature(secret: &str, body: &str) -> String {
    format!("sha256={}", g1t_secrets::hmac_sha256_hex(secret, body))
}

/// Whether g1t may send to `url`: HTTPS, to a public host. `Err` says why
/// not.
pub fn check_url(url: &str) -> Result<(), String> {
    let Some(rest) = url.strip_prefix("https://") else {
        return Err("Webhooks are sent over HTTPS: the address must start with https://.".to_owned());
    };
    if url.len() > 2000 {
        return Err("That address is too long.".to_owned());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit('@').next().unwrap_or_default();
    let host = host.strip_prefix('[').map_or_else(
        || host.split(':').next().unwrap_or_default(),
        |v6| v6.split(']').next().unwrap_or_default(),
    );
    let host = host.to_ascii_lowercase();
    if host.is_empty() || !host.contains(['.', ':']) {
        return Err("The address needs a host g1t can reach on the internet.".to_owned());
    }
    let private_name = host == "localhost"
        || [".localhost", ".local", ".internal", ".lan", ".home.arpa"]
            .iter()
            .any(|suffix| host.ends_with(suffix));
    let private_ip = host.parse::<std::net::IpAddr>().is_ok_and(|ip| match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast() || v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1])
        }
        std::net::IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80,
    });
    if private_name || private_ip {
        return Err("Webhooks go to public addresses, not private or local ones.".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_wait_longer_each_time_then_stop() {
        assert_eq!(retry_after(1), Some(60));
        assert_eq!(retry_after(2), Some(300));
        assert_eq!(retry_after(5), Some(18_000));
        assert_eq!(retry_after(6), None);
        assert_eq!(retry_after(0), None);
    }

    #[test]
    fn events_are_checked_and_ordered() {
        let given = vec!["pull.merged".to_owned(), "git.push".to_owned()];
        assert_eq!(tidy_events(&given).unwrap(), vec!["git.push", "pull.merged"]);
        assert_eq!(tidy_events(&[]).unwrap(), vec!["*"]);
        assert!(tidy_events(&["pull.exploded".to_owned()]).is_err());
        assert!(wants(&["*".to_owned()], "issue.opened"));
        assert!(!wants(&["git.push".to_owned()], "issue.opened"));
    }

    #[test]
    fn only_public_https_addresses_are_allowed() {
        assert!(check_url("https://hooks.example.com/g1t").is_ok());
        assert!(check_url("https://example.com:8443/hook?x=1").is_ok());
        for url in [
            "http://example.com/hook",
            "https://localhost/hook",
            "https://127.0.0.1/hook",
            "https://10.0.0.5/hook",
            "https://192.168.1.2:8080/hook",
            "https://169.254.169.254/latest",
            "https://100.64.0.1/hook",
            "https://[::1]/hook",
            "https://[fd00::1]/hook",
            "https://printer.local/hook",
            "https://intranet/hook",
            "https://user@10.0.0.1/hook",
        ] {
            assert!(check_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn the_signature_is_the_bodys_hmac() {
        let signature = signature("shh", "{\"a\":1}");
        assert!(signature.starts_with("sha256="));
        assert!(g1t_secrets::signed("shh", "{\"a\":1}", &signature));
    }
}
