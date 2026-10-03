//! Alerts: what an outside system reports, in one shape, whichever system
//! it came from. Sentry has its own reader; Datadog and plain webhooks
//! send JSON whose fields g1t picks out by their usual names.

use serde_json::Value;

use crate::crypto;

/// What an alert asks g1t to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Open an issue for it, or count it against the one already open.
    Open,
    /// It came back after being fixed: reopen the issue.
    Reopen,
    /// It stopped. Say so on the issue, and nothing more.
    Recovered,
}

/// One alert, from any system.
#[derive(Clone, Debug)]
pub struct Signal {
    /// What the sender called it: `issue.created`, `Triggered`.
    pub event: String,
    pub action: Action,
    /// The sender's stable id for the problem, so it maps to one issue.
    pub external_id: String,
    pub key: String,
    pub title: String,
    pub url: String,
    /// Markdown describing it.
    pub body: String,
    /// How many times it has happened, if the sender says.
    pub count: Option<u32>,
}

fn first(payload: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| match &payload[*name] {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

/// Whether a Datadog or webhook request carries the connection's secret:
/// as `Authorization: Bearer <secret>`, or as an HMAC-SHA256 of the body in
/// `X-G1t-Signature`.
pub fn authentic(headers: &std::collections::HashMap<String, String>, body: &str, secret: &str) -> bool {
    if let Some(signature) = headers.get("x-g1t-signature") {
        return crypto::signed(secret, body, signature);
    }
    headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer ")))
        .is_some_and(|given| crypto::same(given.trim(), secret))
}

/// Reads a Datadog webhook or a plain one.
///
/// Fields, by their first name present: an id (`id`, `alert_id`,
/// `aggregate`, `incident_key`), a title (`title`, `event_title`,
/// `summary`), a description (`body`, `message`, `event_msg`, `text`), an
/// address (`url`, `link`) and a state (`status`, `transition`,
/// `alert_transition`), where `recovered`, `resolved` or `ok` means it
/// stopped.
pub fn signal(system: &str, payload: &Value) -> std::result::Result<Signal, String> {
    if !payload.is_object() {
        return Err("The body is not a JSON object.".to_owned());
    }
    let title = first(payload, &["title", "event_title", "summary", "name"])
        .ok_or_else(|| "The payload has no title.".to_owned())?;
    let external_id = first(payload, &["id", "alert_id", "aggregate", "incident_key", "dedup_key"])
        .unwrap_or_else(|| title.clone());
    let state = first(payload, &["status", "transition", "alert_transition", "state"]).unwrap_or_default();
    let action = match state.to_ascii_lowercase().as_str() {
        "recovered" | "resolved" | "ok" | "closed" => Action::Recovered,
        _ => Action::Open,
    };
    let url = first(payload, &["url", "link", "html_url"]).unwrap_or_default();
    let mut body = vec![match url.is_empty() {
        true => format!("**{system}**"),
        false => format!("**{system}** · [open it there]({url})"),
    }];
    if !state.is_empty() {
        body.push(format!("State: {state}."));
    }
    if let Some(priority) = first(payload, &["priority", "severity", "level"]) {
        body.push(format!("Priority: {priority}."));
    }
    if let Some(text) = first(payload, &["body", "message", "event_msg", "text", "description"]) {
        body.push(crate::http::shorten(&text, 6000));
    }
    if let Some(tags) = first(payload, &["tags"]) {
        body.push(format!("Tags: `{tags}`"));
    }
    Ok(Signal {
        event: if state.is_empty() { "alert".to_owned() } else { state },
        action,
        key: external_id.chars().take(40).collect(),
        external_id,
        title: title.chars().take(200).collect(),
        url,
        body: body.join("\n\n"),
        count: first(payload, &["count"]).and_then(|count| count.parse().ok()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_datadog_alert_is_read_by_its_usual_names() {
        let alert = signal(
            "Datadog",
            &json!({ "alert_id": 123, "event_title": "[Triggered] p99 latency high", "event_msg": "p99 > 2s",
                     "link": "https://app.datadoghq.com/monitors/123", "alert_transition": "Triggered", "priority": "P2" }),
        )
        .unwrap();
        assert_eq!(alert.external_id, "123");
        assert_eq!(alert.action, Action::Open);
        assert!(alert.body.contains("p99 > 2s"));
        assert!(alert.body.contains("Priority: P2."));
    }

    #[test]
    fn recovered_means_it_stopped() {
        let alert = signal("Datadog", &json!({ "id": "1", "title": "x", "alert_transition": "Recovered" })).unwrap();
        assert_eq!(alert.action, Action::Recovered);
    }

    #[test]
    fn a_title_is_required() {
        assert!(signal("Webhook", &json!({ "id": "1" })).is_err());
        assert!(signal("Webhook", &json!([1, 2])).is_err());
    }

    #[test]
    fn the_secret_is_checked_either_way() {
        let body = "{\"title\":\"x\"}";
        let mut headers = std::collections::HashMap::new();
        headers.insert("authorization".to_owned(), "Bearer shh".to_owned());
        assert!(authentic(&headers, body, "shh"));
        assert!(!authentic(&headers, body, "other"));
        let mut signed = std::collections::HashMap::new();
        signed.insert("x-g1t-signature".to_owned(), format!("sha256={}", crypto::hmac_sha256_hex("shh", body)));
        assert!(authentic(&signed, body, "shh"));
        assert!(!authentic(&std::collections::HashMap::new(), body, "shh"));
    }
}
