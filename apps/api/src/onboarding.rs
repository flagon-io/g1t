//! A person's own Getting started in a workspace, over REST: the setup
//! guide its owners see on its Home, at
//! `GET`/`PATCH /workspaces/{workspace}/onboarding`. Identity keeps it
//! (services/identity/src/onboarding.rs): whether the person dismissed it
//! and the steps they skipped. Whether each step is done is read from the
//! workspace itself, so it is not here. People only, each their own; not
//! an action of any MCP tool, since it is about a person at a page.

use g1t_contracts::identity::{ONBOARDING_STEPS, OnboardingChange};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use worker::Result;

use crate::operations::Services;

/// One operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnboardingOp {
    GetOnboarding,
    UpdateOnboarding,
}

impl OnboardingOp {
    /// Every one: `Op::ALL` lists each as `Op::Onboarding(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [OnboardingOp; 2] = [OnboardingOp::GetOnboarding, OnboardingOp::UpdateOnboarding];

    pub fn name(self) -> &'static str {
        match self {
            OnboardingOp::GetOnboarding => "get_onboarding",
            OnboardingOp::UpdateOnboarding => "update_onboarding",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            OnboardingOp::GetOnboarding => "Get your Getting started in a workspace",
            OnboardingOp::UpdateOnboarding => "Dismiss or skip steps of Getting started",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            OnboardingOp::GetOnboarding => {
                "Your own state of a workspace's Getting started, the setup guide that opens on its Home for its owners: dismissed_at (when you dismissed it, so it no longer opens by itself; null while it does), skipped (the steps you chose to skip, in the guide's order: ai, ask, code, harness, people, runner) and updated_at (null when you never changed it). Whether a step is done is not here: it is the workspace's own state, such as its AI providers, repositories, members and runners. Members only, as people; each person's own."
            }
            OnboardingOp::UpdateOnboarding => {
                "Change your own Getting started in a workspace; fields left out stay as they are. dismissed true dismisses it, so it no longer opens by itself on the workspace's Home (dismissing it again keeps the first time); false makes it open by itself again. skipped replaces the steps you skipped: any of ai, ask, code, harness, people and runner. Opening the guide from Settings or the AI page changes nothing here. Members only, as people; each person's own."
            }
        }
    }

    /// Whether it changes anything: checked against the scope table in tests.
    #[cfg(test)]
    pub fn writes(self) -> bool {
        self == OnboardingOp::UpdateOnboarding
    }

    pub fn input(self) -> Value {
        let workspace = json!({ "type": "string", "description": "The workspace's name, e.g. \"acme\"." });
        let (properties, required): (Value, &[&str]) = match self {
            OnboardingOp::GetOnboarding => (json!({ "workspace": workspace }), &["workspace"]),
            OnboardingOp::UpdateOnboarding => (
                json!({
                    "workspace": workspace,
                    "dismissed": { "type": "boolean", "description": "True dismisses it, so it no longer opens by itself; false makes it open by itself again." },
                    "skipped": {
                        "type": "array",
                        "items": { "type": "string", "enum": ONBOARDING_STEPS },
                        "description": "The steps you skip, replacing those you skipped before. An empty list skips none.",
                    },
                }),
                &["workspace"],
            ),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

/// `dismissed` as sent: a boolean, or a word from a form; null when left out.
fn dismissed(input: &Value) -> std::result::Result<Option<bool>, ()> {
    match &input["dismissed"] {
        Value::Null => Ok(None),
        Value::Bool(on) => Ok(Some(*on)),
        Value::String(word) => match word.trim() {
            "true" | "1" => Ok(Some(true)),
            "false" | "0" => Ok(Some(false)),
            _ => Err(()),
        },
        _ => Err(()),
    }
}

/// `skipped` as sent: a list of step names; null when left out.
fn skipped(input: &Value) -> std::result::Result<Option<Vec<String>>, ()> {
    match &input["skipped"] {
        Value::Null => Ok(None),
        Value::Array(items) => {
            items.iter().map(|item| item.as_str().map(str::to_owned).ok_or(())).collect::<std::result::Result<Vec<_>, _>>().map(Some)
        }
        _ => Err(()),
    }
}

pub async fn run(op: OnboardingOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let Some(user) = viewer.clone() else {
        return Ok(Outcome::fail(FailureCode::Unauthenticated, "This needs a g1t access token."));
    };
    let workspace = input["workspace"].as_str().map(str::trim).unwrap_or_default().to_lowercase();
    if workspace.is_empty() {
        return Ok(Outcome::fail(FailureCode::Invalid, "Name the workspace."));
    }
    let identity = &services.identity;
    match op {
        OnboardingOp::GetOnboarding => g1t_kit::call(identity, "onboarding", &json!({ "user": user, "workspace": workspace })).await,
        OnboardingOp::UpdateOnboarding => {
            let Ok(dismissed) = dismissed(input) else {
                return Ok(Outcome::fail(FailureCode::Invalid, "dismissed is true or false."));
            };
            let Ok(skipped) = skipped(input) else {
                return Ok(Outcome::fail(FailureCode::Invalid, "skipped is a list of step names."));
            };
            let change = OnboardingChange { dismissed, skipped };
            g1t_kit::call(identity, "set_onboarding", &json!({ "user": user, "workspace": workspace, "change": change })).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::scopes::{Level, scope_for};

    #[test]
    fn a_change_is_read_from_what_was_sent() {
        assert_eq!(dismissed(&json!({})), Ok(None));
        assert_eq!(dismissed(&json!({ "dismissed": true })), Ok(Some(true)));
        assert_eq!(dismissed(&json!({ "dismissed": "false" })), Ok(Some(false)));
        assert!(dismissed(&json!({ "dismissed": "maybe" })).is_err());
        assert_eq!(skipped(&json!({})), Ok(None));
        assert_eq!(skipped(&json!({ "skipped": ["people"] })), Ok(Some(vec!["people".to_owned()])));
        assert_eq!(skipped(&json!({ "skipped": [] })), Ok(Some(Vec::new())));
        assert!(skipped(&json!({ "skipped": "people" })).is_err());
        assert!(skipped(&json!({ "skipped": [1] })).is_err());
    }

    #[test]
    fn each_operation_is_described_and_scoped() {
        for op in OnboardingOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::Onboarding(op)), "{}", op.name());
            assert!(crate::tools::REST_ONLY.contains(&crate::operations::Op::Onboarding(op)), "{}", op.name());
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            assert!(op.input()["required"].as_array().unwrap().contains(&json!("workspace")), "{}", op.name());
            let level = scope_for(op.name()).unwrap().level();
            assert_eq!(level, if op.writes() { Level::Write } else { Level::Read }, "{}", op.name());
        }
    }
}
