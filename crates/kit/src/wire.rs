//! JSON keys on the wire: `snake_case` in every body that leaves g1t.
//!
//! Services talk to each other, and to the site, in the contracts' own
//! `camelCase`. Public bodies (API responses and errors, MCP tool results,
//! webhook payloads) are converted on their way out, here, so the
//! contracts stay as they are.
//!
//! Only keys that read as `camelCase` identifiers (`isPrivate`, `prUrl`,
//! `last4`) are converted; anything else (`G1T_TOKEN`, `fail-fast`,
//! `content-type`, a path) is left as it is. Values are never changed.
//!
//! People's own names are never renamed. A field in [`USER_KEYED`], or
//! named `by_…`, whose value is an object is a map keyed by data, such as
//! a workflow's inputs or a variable's name: it is passed through whole,
//! keys and values as given. A surface that carries more of them names
//! its own with [`snake_case_keeping`].

use serde_json::{Map, Value};

/// Fields whose object value is keyed by data rather than by g1t, wherever
/// they appear: workflow `inputs` and `on.workflow_dispatch.inputs`
/// (`dispatch`), `env`, `secrets`, `variables` and `vars` by name, a job's
/// `matrix`, `needs` and `outputs`, an action's `with`, guardrail `rules`
/// and `minutes` by id and kind of run, HTTP `headers`, `metadata`,
/// `labels` by name, an `sbom`, which is a standard's own document, and a
/// deployment's `payload`, as its reporter gave it.
pub const USER_KEYED: &[&str] = &[
    "inputs",
    "dispatch",
    "env",
    "secrets",
    "variables",
    "vars",
    "matrix",
    "needs",
    "outputs",
    "with",
    "rules",
    "minutes",
    "headers",
    "metadata",
    "labels",
    // An SBOM, sent as SPDX spells it.
    "sbom",
    // A deployment's payload, as its reporter gave it.
    "payload",
];

/// Whether a key is a `camelCase` identifier with something to convert.
pub fn is_camel_case(key: &str) -> bool {
    let mut chars = key.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && key.chars().all(|c| c.is_ascii_alphanumeric())
        && key.chars().any(|c| c.is_ascii_uppercase())
}

/// One key in `snake_case`: `prUrl` is `pr_url`, `headSHA` is `head_sha`,
/// `last4` stays `last4`. A key that is not a `camelCase` identifier is
/// returned as it is.
pub fn snake_case_key(key: &str) -> String {
    if !is_camel_case(key) {
        return key.to_owned();
    }
    let chars: Vec<char> = key.chars().collect();
    let mut out = String::with_capacity(key.len() + 4);
    for (i, &c) in chars.iter().enumerate() {
        if c.is_ascii_uppercase() {
            let previous = chars[i - 1];
            let next_is_lower = chars.get(i + 1).is_some_and(char::is_ascii_lowercase);
            // A new word: after a lowercase letter or a digit, or the last
            // capital of an acronym that starts the next word (`HTTPServer`).
            if previous.is_ascii_lowercase()
                || previous.is_ascii_digit()
                || previous.is_ascii_uppercase() && next_is_lower
            {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn user_keyed(key: &str, extra: &[&str]) -> bool {
    USER_KEYED.contains(&key) || extra.contains(&key) || key.starts_with("by_")
}

/// `value` with every key in `snake_case`, as it is sent out of g1t.
pub fn snake_case(value: Value) -> Value {
    snake_case_keeping(value, &[])
}

/// As [`snake_case`], with `extra` field names (in their `snake_case`
/// spelling) whose object values are passed through as well.
pub fn snake_case_keeping(value: Value, extra: &[&str]) -> Value {
    match value {
        Value::Object(fields) => {
            let mut out = Map::with_capacity(fields.len());
            for (given, value) in fields {
                let key = snake_case_key(&given);
                let value = if value.is_object() && user_keyed(&key, extra) {
                    value
                } else {
                    snake_case_keeping(value, extra)
                };
                // A key sent in both spellings keeps the one given in
                // `snake_case`.
                if given != key && out.contains_key(&key) {
                    continue;
                }
                out.insert(key, value);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| snake_case_keeping(item, extra))
                .collect(),
        ),
        other => other,
    }
}

/// The `camelCase` keys that would survive in `value`, as paths, outside
/// the maps [`snake_case`] passes through. Empty for anything it returned.
pub fn camel_case_keys(value: &Value) -> Vec<String> {
    fn walk(value: &Value, path: &str, extra: &[&str], found: &mut Vec<String>) {
        match value {
            Value::Object(fields) => {
                for (key, value) in fields {
                    let here = format!("{path}.{key}");
                    if is_camel_case(key) {
                        found.push(here.clone());
                    }
                    if !(value.is_object() && user_keyed(key, extra)) {
                        walk(value, &here, extra, found);
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item, &format!("{path}[]"), extra, found);
                }
            }
            _ => {}
        }
    }
    let mut found = Vec::new();
    walk(value, "", &[], &mut found);
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_are_converted() {
        for (camel, snake) in [
            ("isPrivate", "is_private"),
            ("prUrl", "pr_url"),
            ("createdAt", "created_at"),
            ("last4", "last4"),
            ("sha256Hex", "sha256_hex"),
            ("headSHA", "head_sha"),
            ("HTTPServer", "HTTPServer"),
            ("httpServerURL", "http_server_url"),
            ("costUsd", "cost_usd"),
            ("id", "id"),
        ] {
            assert_eq!(snake_case_key(camel), snake, "{camel}");
        }
    }

    #[test]
    fn data_shaped_keys_are_left_alone() {
        for key in ["G1T_TOKEN", "fail-fast", "content-type", "src/main.rs", "Title", "a b", ""] {
            assert_eq!(snake_case_key(key), key);
        }
    }

    #[test]
    fn nested_objects_and_arrays_are_converted() {
        let sent = snake_case(json!({
            "pullRequests": [
                { "prUrl": "x", "checkRuns": [{ "exitCode": 0, "durationMs": 5 }] },
                [{ "deepNested": true }],
            ],
            "lastRun": { "startedAt": null },
        }));
        assert_eq!(
            sent,
            json!({
                "pull_requests": [
                    { "pr_url": "x", "check_runs": [{ "exit_code": 0, "duration_ms": 5 }] },
                    [{ "deep_nested": true }],
                ],
                "last_run": { "started_at": null },
            })
        );
        assert!(camel_case_keys(&sent).is_empty());
    }

    #[test]
    fn snake_case_input_is_unchanged() {
        let body = json!({ "is_private": false, "items": [{ "created_at": "t", "last4": "4242" }] });
        assert_eq!(snake_case(body.clone()), body);
        assert_eq!(snake_case(snake_case(json!({ "prUrl": 1 }))), json!({ "pr_url": 1 }));
    }

    #[test]
    fn the_snake_case_spelling_wins_when_both_are_given() {
        assert_eq!(
            snake_case(json!({ "keep_open": true, "keepOpen": false })),
            json!({ "keep_open": true })
        );
    }

    #[test]
    fn user_keyed_maps_pass_through_whole() {
        let sent = snake_case(json!({
            "workflowId": "wf_1",
            "inputs": { "logLevel": "debug", "dryRun": { "nestedKey": 1 } },
            "dispatch": { "targetEnv": { "type": "string" } },
            "env": { "nodeEnv": "x" },
            "secrets": { "apiKey": "…" },
            "variables": { "baseUrl": "…" },
            "rules": { "forcePush": false },
            "minutes": { "implementFeature": 30 },
            "headers": { "contentType": "application/json" },
            "metadata": { "workspaceId": "wsp_1" },
            "labels": { "goodFirstIssue": 3 },
            "byModel": { "claudeOpus": 1.5 },
            "data": { "issueId": "iss_1", "outputs": { "artifactId": "a" } },
        }));
        assert_eq!(
            sent,
            json!({
                "workflow_id": "wf_1",
                "inputs": { "logLevel": "debug", "dryRun": { "nestedKey": 1 } },
                "dispatch": { "targetEnv": { "type": "string" } },
                "env": { "nodeEnv": "x" },
                "secrets": { "apiKey": "…" },
                "variables": { "baseUrl": "…" },
                "rules": { "forcePush": false },
                "minutes": { "implementFeature": 30 },
                "headers": { "contentType": "application/json" },
                "metadata": { "workspaceId": "wsp_1" },
                "labels": { "goodFirstIssue": 3 },
                "by_model": { "claudeOpus": 1.5 },
                "data": { "issue_id": "iss_1", "outputs": { "artifactId": "a" } },
            })
        );
        assert!(camel_case_keys(&sent).is_empty());
    }

    #[test]
    fn a_listed_name_holding_a_list_is_still_converted() {
        // `secrets` is a map by name in one place and a list of findings in
        // another: only a map is passed through.
        assert_eq!(
            snake_case(json!({ "secrets": [{ "updatedAt": "t" }], "labels": ["goodFirst"] })),
            json!({ "secrets": [{ "updated_at": "t" }], "labels": ["goodFirst"] })
        );
    }

    #[test]
    fn a_surface_can_name_more_maps() {
        let sent = snake_case_keeping(
            json!({ "timeoutMinutes": 5, "github": { "eventName": "push" } }),
            &["github"],
        );
        assert_eq!(sent, json!({ "timeout_minutes": 5, "github": { "eventName": "push" } }));
    }

    #[test]
    fn surviving_camel_case_is_found() {
        assert_eq!(
            camel_case_keys(&json!({ "a": [{ "bC": 1 }], "inputs": { "dE": 1 } })),
            vec![".a[].bC".to_owned()]
        );
    }
}
