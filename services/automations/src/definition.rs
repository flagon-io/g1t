//! Reading an automation's file, and the rules it gives: what starts it,
//! the conditions, the steps, and the words in `{{ }}` that steps fill in.

use std::collections::BTreeMap;

use g1t_contracts::webhooks::EVENT_TYPES;
use serde_yaml::Value;

use crate::cron::Schedule;

/// What starts an automation.
#[derive(Clone, Debug)]
pub enum Trigger {
    Events(Vec<String>),
    Schedule { text: String, schedule: Schedule },
    Manual,
}

impl Trigger {
    pub fn describe(&self) -> String {
        match self {
            Trigger::Events(events) => events.join(", "),
            Trigger::Schedule { text, .. } => format!("on the schedule {text} (UTC)"),
            Trigger::Manual => "by hand".to_owned(),
        }
    }
}

/// One condition: a field, and the values any of which it may have.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Condition {
    pub field: String,
    pub values: Vec<String>,
}

impl Condition {
    pub fn describe(&self) -> String {
        let values = self.values.join(" or ");
        match self.field.as_str() {
            "labels" => format!("labelled {values}"),
            "actor" => format!("caused by {values}"),
            "branch" => format!("on {values}"),
            field => format!("{field} is {values}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Comment(String),
    Label(String),
    Unlabel(String),
    AssignAgent,
    MessageAgent(String),
    OpenIssue { title: String, body: String, labels: Vec<String>, assign_agent: bool },
    CloseIssue { not_planned: bool },
    ReopenIssue,
    Notify { url: String, text: String },
}

impl Step {
    pub fn describe(&self) -> String {
        match self {
            Step::Comment(_) => "comment".to_owned(),
            Step::Label(label) => format!("label {label}"),
            Step::Unlabel(label) => format!("remove the label {label}"),
            Step::AssignAgent => "put a g1t agent on it".to_owned(),
            Step::MessageAgent(_) => "message the agent working on it".to_owned(),
            Step::OpenIssue { title, assign_agent, .. } => {
                format!("open the issue \u{201c}{title}\u{201d}{}", if *assign_agent { " and put an agent on it" } else { "" })
            }
            Step::CloseIssue { not_planned } => {
                if *not_planned { "close it as not planned".to_owned() } else { "close it".to_owned() }
            }
            Step::ReopenIssue => "reopen it".to_owned(),
            Step::Notify { url, .. } => format!("post to {}", host(url)),
        }
    }

    /// Whether the step acts on the issue or pull request the event is about.
    pub fn needs_target(&self) -> bool {
        !matches!(self, Step::OpenIssue { .. } | Step::Notify { .. })
    }
}

fn host(url: &str) -> &str {
    url.trim_start_matches("https://").split('/').next().unwrap_or(url)
}

#[derive(Clone, Debug)]
pub struct Definition {
    pub name: String,
    pub trigger: Trigger,
    pub conditions: Vec<Condition>,
    pub steps: Vec<Step>,
    pub per_hour: u32,
}

/// The default and the most runs an automation makes in an hour.
pub const DEFAULT_PER_HOUR: u32 = 30;
pub const MAX_PER_HOUR: u32 = 200;

fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn texts(value: &Value) -> Result<Vec<String>, String> {
    match value {
        Value::Sequence(items) => items.iter().map(|item| text(item).ok_or_else(|| "a list of words".to_owned())).collect(),
        other => text(other).map(|one| vec![one]).ok_or_else(|| "a word or a list of words".to_owned()),
    }
}

fn step(value: &Value) -> Result<Step, String> {
    let (name, argument) = match value {
        Value::String(name) => (name.as_str(), &Value::Null),
        Value::Mapping(map) if map.len() == 1 => {
            let (key, argument) = map.iter().next().expect("one entry");
            (key.as_str().ok_or("a step's name is a word")?, argument)
        }
        _ => return Err("each step is a name, such as `assign_agent`, or a name and what it takes, such as `comment: Thanks!`".to_owned()),
    };
    let field = |key: &str| match argument {
        Value::Mapping(map) => map.get(key).and_then(text),
        _ => None,
    };
    let needs_text = |what: &str| text(argument).filter(|t| !t.trim().is_empty()).ok_or(format!("`{name}` needs {what}"));
    Ok(match name {
        "comment" => Step::Comment(needs_text("the comment's text")?),
        "label" => Step::Label(needs_text("a label")?),
        "unlabel" => Step::Unlabel(needs_text("a label")?),
        "assign_agent" => Step::AssignAgent,
        "message_agent" => Step::MessageAgent(needs_text("the message")?),
        "close_issue" => Step::CloseIssue {
            not_planned: matches!(text(argument).as_deref(), Some("not_planned")),
        },
        "reopen_issue" => Step::ReopenIssue,
        "open_issue" => Step::OpenIssue {
            title: field("title").filter(|t| !t.trim().is_empty()).ok_or("`open_issue` needs a title")?,
            body: field("body").unwrap_or_default(),
            labels: match argument {
                Value::Mapping(map) => map.get("labels").map(texts).transpose()?.unwrap_or_default(),
                _ => Vec::new(),
            },
            assign_agent: matches!(field("assign_agent").as_deref(), Some("true")),
        },
        "notify" => {
            let url = field("url").ok_or("`notify` needs a url")?;
            if !url.starts_with("https://") {
                return Err("`notify` posts only to https:// addresses".to_owned());
            }
            Step::Notify {
                url,
                text: field("text").ok_or("`notify` needs text")?,
            }
        }
        other => {
            return Err(format!(
                "there is no step called `{other}`; steps are comment, label, unlabel, assign_agent, message_agent, open_issue, close_issue, reopen_issue and notify"
            ));
        }
    })
}

/// Reads an automation's file. `Err` says what is wrong with it, for the
/// person who wrote it.
pub fn parse(yaml: &str, file_name: &str) -> Result<Definition, String> {
    let root: Value = serde_yaml::from_str(yaml).map_err(|error| format!("It is not valid YAML: {error}"))?;
    let Value::Mapping(map) = &root else {
        return Err("An automation is a mapping with `on` and `do`.".to_owned());
    };
    let name = map
        .get("name")
        .and_then(text)
        .unwrap_or_else(|| file_name.trim_end_matches(".yml").trim_end_matches(".yaml").replace(['-', '_'], " "));
    let trigger = match map.get("on") {
        None => return Err("`on` is missing: say which event starts it, a schedule, or manual.".to_owned()),
        Some(Value::String(manual)) if manual == "manual" => Trigger::Manual,
        Some(Value::Mapping(on)) if on.contains_key("schedule") => {
            let text = on.get("schedule").and_then(text).ok_or("`schedule` takes a cron line, such as \"0 9 * * mon\".")?;
            let schedule = Schedule::parse(&text).map_err(|problem| format!("The schedule does not read: {problem}."))?;
            Trigger::Schedule { text, schedule }
        }
        Some(events) => {
            let events = texts(events).map_err(|_| "`on` takes an event, a list of events, `manual`, or `schedule:`.".to_owned())?;
            if let Some(unknown) = events.iter().find(|event| !EVENT_TYPES.contains(&event.as_str())) {
                return Err(format!("There is no event called {unknown}. Events are {}.", EVENT_TYPES.join(", ")));
            }
            Trigger::Events(events)
        }
    };
    let mut conditions = Vec::new();
    if let Some(when) = map.get("if") {
        let Value::Mapping(when) = when else {
            return Err("`if` is a mapping of fields to the values they must have.".to_owned());
        };
        for (field, values) in when {
            let field = field.as_str().ok_or("`if` keys are field names")?.to_owned();
            let values = texts(values).map_err(|problem| format!("`if` {field}: give {problem}."))?;
            conditions.push(Condition { field, values });
        }
    }
    let steps = match map.get("do") {
        Some(Value::Sequence(steps)) if !steps.is_empty() => steps.iter().map(step).collect::<Result<Vec<_>, _>>()?,
        Some(single @ (Value::String(_) | Value::Mapping(_))) => vec![step(single)?],
        _ => return Err("`do` is missing: give the steps to take, as a list.".to_owned()),
    };
    if matches!(trigger, Trigger::Schedule { .. })
        && let Some(step) = steps.iter().find(|step| step.needs_target()) {
            return Err(format!(
                "A scheduled automation has no issue or pull request to act on, so it cannot {}. It can open_issue or notify.",
                step.describe()
            ));
        }
    let per_hour = match map.get("limits").and_then(|limits| limits.get("per_hour")) {
        Some(value) => value
            .as_u64()
            .filter(|n| (1..=u64::from(MAX_PER_HOUR)).contains(n))
            .ok_or(format!("`limits.per_hour` is a number from 1 to {MAX_PER_HOUR}."))? as u32,
        None => DEFAULT_PER_HOUR,
    };
    Ok(Definition {
        name,
        trigger,
        conditions,
        steps,
        per_hour,
    })
}

/// What a run knows, by name: for conditions and for `{{ }}` in steps.
#[derive(Clone, Debug, Default)]
pub struct Context {
    pub vars: BTreeMap<String, String>,
    pub labels: Vec<String>,
}

impl Context {
    pub fn set(&mut self, key: &str, value: impl Into<String>) {
        self.vars.insert(key.to_owned(), value.into());
    }

    /// An event's data, as `data.<field>` and, where nothing else claims
    /// the name, as `<field>`.
    pub fn add_data(&mut self, data: &serde_json::Value) {
        let Some(fields) = data.as_object() else { return };
        for (key, value) in fields {
            let value = match value {
                serde_json::Value::String(text) => text.clone(),
                serde_json::Value::Number(number) => number.to_string(),
                serde_json::Value::Bool(flag) => flag.to_string(),
                _ => continue,
            };
            self.vars.entry(key.clone()).or_insert_with(|| value.clone());
            self.vars.insert(format!("data.{key}"), value);
        }
    }
}

/// Whether every condition holds. `labels` matches when the issue or pull
/// request has any of the labels; other fields compare with the context.
pub fn holds(conditions: &[Condition], context: &Context) -> Result<(), String> {
    for condition in conditions {
        let ok = if condition.field == "labels" {
            condition.values.iter().any(|value| context.labels.iter().any(|label| label.eq_ignore_ascii_case(value)))
        } else {
            let actual = context.vars.get(&condition.field).or_else(|| context.vars.get(&format!("data.{}", condition.field)));
            actual.is_some_and(|actual| condition.values.iter().any(|value| value.eq_ignore_ascii_case(actual)))
        };
        if !ok {
            return Err(format!("not {}", condition.describe()));
        }
    }
    Ok(())
}

/// Fills `{{ name }}` with what the context knows; an unknown name is left
/// empty.
pub fn render(template: &str, context: &Context) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let name = after[..end].trim();
        out.push_str(context.vars.get(name).map(String::as_str).unwrap_or_default());
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUGS: &str = r#"
name: Put an agent on new bugs
on: issue.opened
if:
  labels: [bug, regression]
do:
  - comment: "Thanks, {{actor}}. An agent is on it."
  - assign_agent
  - notify: { url: "https://hooks.slack.com/x", text: "{{repo}}#{{number}}: {{title}}" }
limits:
  per_hour: 5
"#;

    #[test]
    fn a_whole_automation_reads() {
        let definition = parse(BUGS, "bugs.yml").unwrap();
        assert_eq!(definition.name, "Put an agent on new bugs");
        assert!(matches!(&definition.trigger, Trigger::Events(events) if events == &vec!["issue.opened".to_owned()]));
        assert_eq!(definition.conditions, vec![Condition { field: "labels".into(), values: vec!["bug".into(), "regression".into()] }]);
        assert_eq!(definition.steps.len(), 3);
        assert_eq!(definition.steps[1], Step::AssignAgent);
        assert_eq!(definition.per_hour, 5);
        assert_eq!(definition.steps[2].describe(), "post to hooks.slack.com");
    }

    #[test]
    fn mistakes_are_explained() {
        let problem = |yaml: &str| parse(yaml, "x.yml").unwrap_err();
        assert!(problem("on: issue.exploded\ndo: [assign_agent]").contains("no event called issue.exploded"));
        assert!(problem("on: issue.opened").contains("`do` is missing"));
        assert!(problem("do: [assign_agent]").contains("`on` is missing"));
        assert!(problem("on: issue.opened\ndo: [dance]").contains("no step called `dance`"));
        assert!(problem("on: issue.opened\ndo: [{notify: {url: 'http://x', text: hi}}]").contains("https://"));
        assert!(problem("on: { schedule: '0 9 * * mon' }\ndo: [assign_agent]").contains("cannot put a g1t agent on it"));
        assert!(problem("on: { schedule: 'often' }\ndo: [{open_issue: {title: x}}]").contains("schedule does not read"));
        assert!(problem("on: issue.opened\ndo: [assign_agent]\nlimits: { per_hour: 0 }").contains("per_hour"));
        assert!(problem(": : :").contains("not valid YAML"));
    }

    #[test]
    fn schedules_and_manual_runs_read() {
        let weekly = parse("on: { schedule: '0 9 * * mon' }\ndo:\n  - open_issue: { title: Weekly tidy, labels: chore, assign_agent: true }", "weekly.yml").unwrap();
        assert!(matches!(weekly.trigger, Trigger::Schedule { .. }));
        assert_eq!(weekly.name, "weekly");
        assert!(matches!(&weekly.steps[0], Step::OpenIssue { labels, assign_agent: true, .. } if labels == &vec!["chore".to_owned()]));
        assert!(matches!(parse("on: manual\ndo:\n  comment: hi", "m.yml").unwrap().trigger, Trigger::Manual));
    }

    #[test]
    fn conditions_check_labels_fields_and_data() {
        let mut context = Context::default();
        context.labels = vec!["Bug".into()];
        context.set("actor", "ada");
        context.add_data(&serde_json::json!({ "status": "failed", "number": 7 }));
        let condition = |field: &str, values: &[&str]| Condition { field: field.into(), values: values.iter().map(|v| v.to_string()).collect() };
        assert!(holds(&[condition("labels", &["bug"]), condition("status", &["failed", "errored"])], &context).is_ok());
        assert!(holds(&[condition("data.status", &["failed"])], &context).is_ok());
        assert_eq!(holds(&[condition("actor", &["grace"])], &context).unwrap_err(), "not caused by grace");
        assert!(holds(&[condition("verdict", &["approve"])], &context).is_err());
    }

    #[test]
    fn templates_fill_in_what_is_known() {
        let mut context = Context::default();
        context.set("repo", "acme/web");
        context.set("number", "12");
        assert_eq!(render("{{repo}}#{{ number }} by {{actor}}", &context), "acme/web#12 by ");
        assert_eq!(render("no braces", &context), "no braces");
        assert_eq!(render("half {{open", &context), "half {{open");
    }
}
