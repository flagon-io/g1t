//! GitHub's workflow syntax: the keys each mapping in a workflow may have,
//! as GitHub's own schema lists them (`schema/workflow-v1.0.json`, from
//! actions/languageservices; the tests below check these lists against
//! it), with g1t's own beside them: the `work_item` and
//! `work_item_comment` events ([`OWN_EVENTS`]) and the `work` permission
//! ([`OWN_PERMISSIONS`]). [`crate::workflow::parse`] refuses any other
//! key, as GitHub does, except `g1t`, g1t's own settings, on the workflow,
//! a job and a step.

/// g1t's own key, allowed on the workflow, each job and each step.
pub const EXTENSION: &str = "g1t";

/// The workflow's top level (`workflow-root-strict`).
pub const WORKFLOW: &[&str] = &["on", "name", "description", "run-name", "defaults", "env", "permissions", "concurrency", "jobs"];

/// A job that runs steps on a runner (`job-factory`).
pub const JOB: &[&str] = &[
    "needs",
    "if",
    "strategy",
    "name",
    "runs-on",
    "timeout-minutes",
    "cancel-timeout-minutes",
    "continue-on-error",
    "container",
    "services",
    "env",
    "environment",
    "permissions",
    "concurrency",
    "outputs",
    "defaults",
    "steps",
    "snapshot",
];

/// A job that calls a reusable workflow (`workflow-job`).
pub const CALLER_JOB: &[&str] = &["name", "uses", "with", "secrets", "needs", "if", "permissions", "concurrency", "strategy"];

/// A step that runs a command (`run-step`).
pub const RUN_STEP: &[&str] =
    &["name", "id", "if", "timeout-minutes", "run", "continue-on-error", "env", "working-directory", "shell", "background"];

/// A step that uses an action (`regular-step`).
pub const ACTION_STEP: &[&str] = &["name", "id", "if", "continue-on-error", "timeout-minutes", "uses", "with", "env", "background"];

/// Keys of GitHub's background steps (`background`, and the `wait-step`,
/// `wait-all-step`, `cancel-step` and `parallel-step` steps), which g1t
/// does not run yet.
pub const BACKGROUND_STEPS: &[&str] = &["background", "wait", "wait-all", "cancel", "parallel"];

/// `strategy`.
pub const STRATEGY: &[&str] = &["fail-fast", "max-parallel", "matrix"];

/// `runs-on` as a mapping (`runs-on-mapping`).
pub const RUNS_ON: &[&str] = &["group", "labels"];

/// `container` as a mapping (`container-mapping`).
pub const CONTAINER: &[&str] = &["image", "options", "env", "ports", "volumes", "credentials"];

/// Each of `services` as a mapping (`service-container-mapping`).
pub const SERVICE: &[&str] = &["image", "options", "env", "ports", "volumes", "command", "entrypoint", "credentials"];

/// `credentials` of a container or service (`container-registry-credentials`).
pub const CREDENTIALS: &[&str] = &["username", "password"];

/// `environment` as a mapping (`job-environment-mapping`).
pub const ENVIRONMENT: &[&str] = &["name", "url", "deployment"];

/// `concurrency` as a mapping (`concurrency-mapping`).
pub const CONCURRENCY: &[&str] = &["group", "cancel-in-progress", "queue"];

/// `defaults` (`workflow-defaults`, `job-defaults`).
pub const DEFAULTS: &[&str] = &["run"];

/// `defaults.run` (`workflow-defaults-run`, `job-defaults-run`).
pub const DEFAULTS_RUN: &[&str] = &["shell", "working-directory"];

/// `permissions` as a mapping (`permissions-mapping`), and g1t's own.
pub const PERMISSIONS: &[&str] = &[
    "actions",
    "artifact-metadata",
    "attestations",
    "checks",
    "code-quality",
    "contents",
    "copilot-requests",
    "deployments",
    "discussions",
    "drives",
    "id-token",
    "issues",
    "models",
    "packages",
    "pages",
    "pull-requests",
    "repository-projects",
    "security-events",
    "statuses",
    "vulnerability-alerts",
    "work",
];

/// Permissions g1t has that GitHub does not: `work`, for work items.
pub const OWN_PERMISSIONS: &[&str] = &["work"];

/// Each entry of `on.schedule` (`cron-mapping`).
pub const CRON: &[&str] = &["cron", "timezone"];

/// `on.workflow_dispatch` (`workflow-dispatch-mapping`).
pub const WORKFLOW_DISPATCH: &[&str] = &["inputs"];

/// Each of `on.workflow_dispatch.inputs` (`workflow-dispatch-input`).
pub const DISPATCH_INPUT: &[&str] = &["description", "type", "required", "default", "options"];

/// `on.workflow_call` (`workflow-call-mapping`).
pub const WORKFLOW_CALL: &[&str] = &["inputs", "outputs", "secrets"];

/// Each of `on.workflow_call.inputs` (`workflow-call-input-definition`).
pub const CALL_INPUT: &[&str] = &["description", "type", "required", "default"];

/// Each of `on.workflow_call.outputs` (`workflow-call-output-definition`).
pub const CALL_OUTPUT: &[&str] = &["description", "value"];

/// Each of `on.workflow_call.secrets` (`workflow-call-secret-mapping-definition`).
pub const CALL_SECRET: &[&str] = &["description", "required"];

/// What an event under `on` may be given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventSpec {
    /// Nothing: `create:`.
    Bare,
    /// Nothing, or a mapping with these keys.
    Filters(&'static [&'static str]),
    /// `schedule`: a list of [`CRON`] mappings.
    Schedule,
}

const TYPES: EventSpec = EventSpec::Filters(&["types"]);
const PULL_REQUEST: EventSpec = EventSpec::Filters(&["types", "branches", "branches-ignore", "paths", "paths-ignore"]);

/// Every event GitHub has, and what each takes (`on-mapping-strict`),
/// and g1t's own.
pub const EVENTS: &[(&str, EventSpec)] = &[
    ("branch_protection_rule", TYPES),
    ("check_run", TYPES),
    ("check_suite", TYPES),
    ("create", EventSpec::Bare),
    ("delete", EventSpec::Bare),
    ("deployment", EventSpec::Bare),
    ("deployment_status", EventSpec::Bare),
    ("discussion", TYPES),
    ("discussion_comment", TYPES),
    ("fork", EventSpec::Bare),
    ("gollum", EventSpec::Bare),
    ("image_version", EventSpec::Filters(&["types", "names", "versions"])),
    ("issue_comment", TYPES),
    ("issues", TYPES),
    ("label", TYPES),
    ("merge_group", EventSpec::Filters(&["types", "branches", "branches-ignore"])),
    ("milestone", TYPES),
    ("page_build", EventSpec::Bare),
    ("project", TYPES),
    ("project_card", TYPES),
    ("project_column", TYPES),
    ("public", EventSpec::Bare),
    ("pull_request", PULL_REQUEST),
    ("pull_request_comment", TYPES),
    ("pull_request_review", TYPES),
    ("pull_request_review_comment", TYPES),
    ("pull_request_target", PULL_REQUEST),
    ("push", EventSpec::Filters(&["branches", "branches-ignore", "tags", "tags-ignore", "paths", "paths-ignore"])),
    ("registry_package", TYPES),
    ("release", TYPES),
    ("repository_dispatch", TYPES),
    ("schedule", EventSpec::Schedule),
    ("status", EventSpec::Bare),
    ("watch", TYPES),
    ("workflow_call", EventSpec::Filters(WORKFLOW_CALL)),
    ("workflow_dispatch", EventSpec::Filters(WORKFLOW_DISPATCH)),
    ("workflow_run", EventSpec::Filters(&["types", "branches", "branches-ignore", "workflows"])),
    ("work_item", TYPES),
    ("work_item_comment", TYPES),
];

/// Events g1t has that GitHub does not: a work item changed, and a comment
/// on a work item or a pull request.
pub const OWN_EVENTS: &[&str] = &["work_item", "work_item_comment"];

/// What `event` takes, if GitHub has it.
pub fn event(event: &str) -> Option<EventSpec> {
    EVENTS.iter().find(|(name, _)| *name == event).map(|(_, spec)| *spec)
}

/// Whether `id` may name a job or a step: a letter or `_` first, then
/// letters, digits, `-` and `_`, under 100 characters, and not starting
/// with `__`, which GitHub keeps for itself.
pub fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else { return false };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && id.len() < 100
        && !id.starts_with("__")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::BTreeSet;

    fn schema() -> Value {
        serde_json::from_str(include_str!("../schema/workflow-v1.0.json")).unwrap()
    }

    /// The keys of the mapping `name` in GitHub's schema.
    fn keys(schema: &Value, name: &str) -> BTreeSet<String> {
        let definition = &schema["definitions"][name];
        let properties = definition["mapping"]["properties"].as_object().unwrap_or_else(|| panic!("{name} is no mapping"));
        properties.keys().cloned().collect()
    }

    fn set(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|key| (*key).to_owned()).collect()
    }

    /// GitHub's part of a list: without g1t's own.
    fn upstream(list: &[&str], own: &[&str]) -> BTreeSet<String> {
        list.iter().filter(|key| !own.contains(key)).map(|key| (*key).to_owned()).collect()
    }

    #[test]
    fn the_lists_are_githubs() {
        let schema = schema();
        for (list, name) in [
            (WORKFLOW, "workflow-root-strict"),
            (JOB, "job-factory"),
            (CALLER_JOB, "workflow-job"),
            (RUN_STEP, "run-step"),
            (ACTION_STEP, "regular-step"),
            (STRATEGY, "strategy"),
            (RUNS_ON, "runs-on-mapping"),
            (CONTAINER, "container-mapping"),
            (SERVICE, "service-container-mapping"),
            (CREDENTIALS, "container-registry-credentials"),
            (ENVIRONMENT, "job-environment-mapping"),
            (CONCURRENCY, "concurrency-mapping"),
            (DEFAULTS, "workflow-defaults"),
            (DEFAULTS, "job-defaults"),
            (DEFAULTS_RUN, "workflow-defaults-run"),
            (DEFAULTS_RUN, "job-defaults-run"),
            (PERMISSIONS, "permissions-mapping"),
            (CRON, "cron-mapping"),
            (WORKFLOW_DISPATCH, "workflow-dispatch-mapping"),
            (DISPATCH_INPUT, "workflow-dispatch-input"),
            (WORKFLOW_CALL, "workflow-call-mapping"),
            (CALL_INPUT, "workflow-call-input-definition"),
            (CALL_OUTPUT, "workflow-call-output-definition"),
            (CALL_SECRET, "workflow-call-secret-mapping-definition"),
        ] {
            assert_eq!(upstream(list, OWN_PERMISSIONS), keys(&schema, name), "{name}");
        }
        for own in OWN_PERMISSIONS {
            assert!(PERMISSIONS.contains(own) && !keys(&schema, "permissions-mapping").contains(*own), "{own}");
        }
        // The background steps' own keys.
        let mut background = BTreeSet::from(["background".to_owned()]);
        for name in ["wait-step", "wait-all-step", "cancel-step", "parallel-step"] {
            background.extend(keys(&schema, name).into_iter().filter(|key| !["name", "id", "continue-on-error"].contains(&key.as_str())));
        }
        assert_eq!(set(BACKGROUND_STEPS), background);
        // Every step kind GitHub has is one of these.
        let kinds: Vec<&str> = schema["definitions"]["steps-item"]["one-of"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert_eq!(kinds, ["run-step", "regular-step", "wait-step", "wait-all-step", "cancel-step", "parallel-step"]);
        // A job is one or the other.
        assert_eq!(schema["definitions"]["job"]["one-of"], serde_json::json!(["job-factory", "workflow-job"]));
    }

    #[test]
    fn the_events_are_githubs() {
        let schema = schema();
        let definitions = &schema["definitions"];
        let events = definitions["on-mapping-strict"]["mapping"]["properties"].as_object().unwrap();
        let names: Vec<&str> = EVENTS.iter().map(|(name, _)| *name).collect();
        assert_eq!(events.keys().cloned().collect::<BTreeSet<_>>(), upstream(&names, OWN_EVENTS));
        for own in OWN_EVENTS {
            assert!(!events.contains_key(*own), "{own}");
            assert_eq!(event(own), Some(TYPES), "{own}");
        }
        for (name, kind) in events {
            let kind = kind.as_str().or_else(|| kind["type"].as_str()).unwrap();
            let definition = &definitions[kind];
            let expected = if definition.get("null").is_some() {
                EventSpec::Bare
            } else if definition["sequence"]["item-type"] == "cron-mapping" {
                EventSpec::Schedule
            } else {
                let options: Vec<&str> = definition["one-of"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
                assert_eq!(options.len(), 2, "{name}");
                assert_eq!(options[0], "null", "{name}");
                let ours = match event(name) {
                    Some(EventSpec::Filters(keys)) => set(keys),
                    other => panic!("{name}: {other:?}"),
                };
                assert_eq!(ours, keys(&schema, options[1]), "{name}");
                continue;
            };
            assert_eq!(event(name), Some(expected), "{name}");
        }
    }

    #[test]
    fn ids_follow_githubs_rule() {
        for id in ["build", "_", "_a", "a__", "build-2", "Test_all"] {
            assert!(valid_id(id), "{id}");
        }
        for id in ["", "my.job", "my%job", ".job", "0job", " job", "-job", "__", "__a", &"a".repeat(100)] {
            assert!(!valid_id(id), "{id}");
        }
    }
}
