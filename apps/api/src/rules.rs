//! Rulesets over REST and MCP: a repository's and a workspace's rulesets,
//! the rules that hold for one branch or tag, and how the rules judged
//! pushes and merges (the evaluations, with insights).
//!
//! Rulesets travel as the API shows them, `snake_case` between services
//! too, so a ruleset read here, exported from the site or written by hand
//! is created and updated unchanged. The work service decides who may see
//! and change them and validates every one (`g1t_rules::validate`).

use g1t_contracts::repos::RepoPath;
use g1t_contracts::rules::*;
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use worker::Result;

use crate::operations::Services;

/// One operation on rulesets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RulesOp {
    ListRepoRulesets,
    GetRepoRuleset,
    CreateRepoRuleset,
    UpdateRepoRuleset,
    DeleteRepoRuleset,
    GetBranchRules,
    ListRuleEvaluations,
    ListWorkspaceRulesets,
    GetWorkspaceRuleset,
    CreateWorkspaceRuleset,
    UpdateWorkspaceRuleset,
    DeleteWorkspaceRuleset,
    ListWorkspaceRuleEvaluations,
}

/// The keys of a ruleset in a request body.
const SPEC_KEYS: [&str; 6] = ["name", "enforcement", "target", "conditions", "bypass_actors", "rules"];

impl RulesOp {
    /// Every one: `Op::ALL` lists each as `Op::Rules(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [RulesOp; 13] = [
        RulesOp::ListRepoRulesets,
        RulesOp::GetRepoRuleset,
        RulesOp::CreateRepoRuleset,
        RulesOp::UpdateRepoRuleset,
        RulesOp::DeleteRepoRuleset,
        RulesOp::GetBranchRules,
        RulesOp::ListRuleEvaluations,
        RulesOp::ListWorkspaceRulesets,
        RulesOp::GetWorkspaceRuleset,
        RulesOp::CreateWorkspaceRuleset,
        RulesOp::UpdateWorkspaceRuleset,
        RulesOp::DeleteWorkspaceRuleset,
        RulesOp::ListWorkspaceRuleEvaluations,
    ];

    pub fn name(self) -> &'static str {
        match self {
            RulesOp::ListRepoRulesets => "list_repo_rulesets",
            RulesOp::GetRepoRuleset => "get_repo_ruleset",
            RulesOp::CreateRepoRuleset => "create_repo_ruleset",
            RulesOp::UpdateRepoRuleset => "update_repo_ruleset",
            RulesOp::DeleteRepoRuleset => "delete_repo_ruleset",
            RulesOp::GetBranchRules => "get_branch_rules",
            RulesOp::ListRuleEvaluations => "list_rule_evaluations",
            RulesOp::ListWorkspaceRulesets => "list_workspace_rulesets",
            RulesOp::GetWorkspaceRuleset => "get_workspace_ruleset",
            RulesOp::CreateWorkspaceRuleset => "create_workspace_ruleset",
            RulesOp::UpdateWorkspaceRuleset => "update_workspace_ruleset",
            RulesOp::DeleteWorkspaceRuleset => "delete_workspace_ruleset",
            RulesOp::ListWorkspaceRuleEvaluations => "list_workspace_rule_evaluations",
        }
    }

    /// For the API reference: "List a repository's rulesets".
    pub fn title(self) -> &'static str {
        match self {
            RulesOp::ListRepoRulesets => "List a repository's rulesets",
            RulesOp::GetRepoRuleset => "Get a repository ruleset",
            RulesOp::CreateRepoRuleset => "Create a repository ruleset",
            RulesOp::UpdateRepoRuleset => "Update a repository ruleset",
            RulesOp::DeleteRepoRuleset => "Delete a repository ruleset",
            RulesOp::GetBranchRules => "Get the rules for a branch",
            RulesOp::ListRuleEvaluations => "List a repository's rule evaluations",
            RulesOp::ListWorkspaceRulesets => "List a workspace's rulesets",
            RulesOp::GetWorkspaceRuleset => "Get a workspace ruleset",
            RulesOp::CreateWorkspaceRuleset => "Create a workspace ruleset",
            RulesOp::UpdateWorkspaceRuleset => "Update a workspace ruleset",
            RulesOp::DeleteWorkspaceRuleset => "Delete a workspace ruleset",
            RulesOp::ListWorkspaceRuleEvaluations => "List a workspace's rule evaluations",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            RulesOp::ListRepoRulesets => "List a repository's rulesets: what may happen to its branches and tags, and what a pull request needs before it merges. With include_parents, also its workspace's rulesets that hold in it (level workspace). Each has its enforcement (active, evaluate: a dry run that records what it would have refused, or disabled), target (branch or tag), conditions (ref_name include and exclude patterns: fnmatch, ~DEFAULT_BRANCH, ~ALL), bypass_actors and rules. The one made from branch protection settings has source branch_protection.",
            RulesOp::GetRepoRuleset => "Get one of a repository's rulesets by id (rs_…), or one of its workspace's that holds in it.",
            RulesOp::CreateRepoRuleset => "Create a repository ruleset: name, enforcement (active, evaluate or disabled; active by default), target (branch or tag), conditions.ref_name (include and exclude patterns), bypass_actors (each a kind: role, team, user, token or g1t, a value, and a mode: always or pull_requests; nobody bypasses unless listed, g1t included) and rules (each a type, its parameters, and applies_to: everyone, agents or people). Rule types: creation, update, deletion, non_fast_forward, required_linear_history, required_signatures, pull_request, required_status_checks, merge_queue, required_deployments, commit_message_pattern, commit_author_email_pattern, committer_email_pattern, branch_name_pattern, tag_name_pattern, file_path_restriction, file_extension_restriction, max_file_size, max_file_path_length, max_files_changed, secret_scanning, confidence_threshold, cost_cap, path_review, merge_window and agent_auto_merge. Several rulesets stack: every rule of each holds. Takes the Maintain role. Returns the ruleset as saved, tidied.",
            RulesOp::UpdateRepoRuleset => "Change a repository ruleset. Fields left out stay as they are; rules and bypass_actors, when given, replace the whole list. Takes the Maintain role.",
            RulesOp::DeleteRepoRuleset => "Delete a repository ruleset. Its evaluations stay in the log. Takes the Maintain role.",
            RulesOp::GetBranchRules => "Every rule that holds for a branch (or a tag, with target tag) of a repository, from every ruleset that targets it, the repository's and its workspace's: each with its type, parameters and applies_to, and the ruleset_id, ruleset_name, level and enforcement it comes from. Active rules come first, then those of rulesets in evaluate. rulesets lists the rulesets with who may bypass each. A branch name with slashes is URL-encoded in the path.",
            RulesOp::ListRuleEvaluations => "List how a repository's rulesets judged pushes, merges and other changes to its branches and tags, newest first: the ruleset, the action (push, merge, create_ref, delete_ref, rename_ref or commit), the ref, the actor and whether they are a person, an agent or g1t, the verdict (pass, fail or bypass) and each rule broken with why. A fail of a ruleset in evaluate is what it would have refused. Filter by ruleset_id or verdict, or problems_only; page with before. insights counts the last 30 days by ruleset and by rule. Takes the Write role.",
            RulesOp::ListWorkspaceRulesets => "List a workspace's own rulesets. Each holds in the repositories its conditions.repository selects: names matching include (fnmatch, or ~ALL) and not exclude, of a visibility (any, public or private), and carrying one of topics when given. Members only.",
            RulesOp::GetWorkspaceRuleset => "Get one of a workspace's own rulesets by id (rs_…), with its conditions, bypass actors and rules. Members only.",
            RulesOp::CreateWorkspaceRuleset => "Create a workspace ruleset, as for a repository, plus conditions.repository: which of the workspace's repositories it holds in (include and exclude name patterns, visibility, topics). Owners only.",
            RulesOp::UpdateWorkspaceRuleset => "Change a workspace ruleset. Fields left out stay as they are; rules and bypass_actors, when given, replace the whole list. Owners only.",
            RulesOp::DeleteWorkspaceRuleset => "Delete a workspace ruleset: it stops holding in every repository it selected. Its evaluations stay in the log. Owners only.",
            RulesOp::ListWorkspaceRuleEvaluations => "List how a workspace's rulesets, and its repositories' own, judged changes across its repositories, newest first, with 30 days of insights. Members only.",
        }
    }

    /// Whether the operation is about one repository named by `repo`.
    pub fn needs_repo(self) -> bool {
        matches!(
            self,
            RulesOp::ListRepoRulesets
                | RulesOp::GetRepoRuleset
                | RulesOp::CreateRepoRuleset
                | RulesOp::UpdateRepoRuleset
                | RulesOp::DeleteRepoRuleset
                | RulesOp::GetBranchRules
                | RulesOp::ListRuleEvaluations
        )
    }

    pub fn input(self) -> Value {
        let repo = || json!({ "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." });
        let workspace = || json!({ "type": "string", "description": "The workspace's slug, e.g. \"flagon-io\"." });
        let id = || json!({ "type": "string", "description": "The ruleset's id: rs_…" });
        let spec = |mut properties: Value, workspace_level: bool| {
            properties["ruleset_name"] = json!({ "type": "string", "description": "What people call it, at most 100 characters. A ruleset as exported names it `name`, which is read too." });
            properties["enforcement"] = json!({ "type": "string", "enum": ["active", "evaluate", "disabled"], "description": "active: its rules hold. evaluate: nothing is refused, and what would have been is recorded. disabled: kept, not evaluated. Default active." });
            properties["target"] = json!({ "type": "string", "enum": ["branch", "tag"], "description": "What its name conditions match. Default branch." });
            let mut conditions = json!({
                "ref_name": {
                    "type": "object",
                    "description": "Which branches or tags: include and exclude, each a list of fnmatch patterns (* within a path segment, ** across them), ~DEFAULT_BRANCH or ~ALL.",
                    "properties": {
                        "include": { "type": "array", "items": { "type": "string" } },
                        "exclude": { "type": "array", "items": { "type": "string" } },
                    },
                },
            });
            if workspace_level {
                conditions["repository"] = json!({
                    "type": "object",
                    "description": "Which of the workspace's repositories: include and exclude name patterns (or ~ALL), visibility (any, public, private) and topics (any of).",
                    "properties": {
                        "include": { "type": "array", "items": { "type": "string" } },
                        "exclude": { "type": "array", "items": { "type": "string" } },
                        "visibility": { "type": "string", "enum": ["any", "public", "private"] },
                        "topics": { "type": "array", "items": { "type": "string" } },
                    },
                });
            }
            properties["conditions"] = json!({ "type": "object", "properties": conditions });
            properties["bypass_actors"] = json!({
                "type": "array",
                "description": "Who it does not hold for. Nobody bypasses unless listed, g1t included. kind role takes read, triage, write, maintain, admin (that role or higher) or owner; team its slug or workspace/slug; user a username; token a token id, or workspace for any of the workspace's tokens; g1t no value. mode always (pushes and merges) or pull_requests (merges only; a person merging asks to, with bypass_rules).",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": { "type": "string", "enum": ["role", "team", "user", "token", "g1t"] },
                        "value": { "type": "string" },
                        "mode": { "type": "string", "enum": ["always", "pull_requests"] },
                    },
                    "required": ["kind"],
                },
            });
            properties["rules"] = json!({
                "type": "array",
                "description": "Its rules. Each: type, parameters (left-out parameters take their defaults) and applies_to (everyone, agents or people). See the Rules guide for every type's parameters.",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": { "type": "string" },
                        "parameters": { "type": "object" },
                        "applies_to": { "type": "string", "enum": ["everyone", "agents", "people"] },
                    },
                    "required": ["type"],
                },
            });
            properties
        };
        let evaluations = |mut properties: Value| {
            properties["ruleset_id"] = json!({ "type": "string", "description": "Only this ruleset's evaluations." });
            properties["verdict"] = json!({ "type": "string", "enum": ["pass", "fail", "bypass"], "description": "Only evaluations that came out this way." });
            properties["problems_only"] = json!({ "type": "boolean", "description": "Only evaluations that broke a rule: failed, would have failed, or bypassed." });
            properties["before"] = json!({ "type": "string", "description": "An evaluation's id (rev_…): only older ones. The page's next." });
            properties["limit"] = json!({ "type": "integer", "description": "How many, 1 to 100; 30 by default." });
            properties
        };
        let (properties, required): (Value, &[&str]) = match self {
            RulesOp::ListRepoRulesets => (
                json!({ "repo": repo(), "include_parents": { "type": "boolean", "description": "Also list the workspace's rulesets that hold in it." } }),
                &["repo"],
            ),
            RulesOp::GetRepoRuleset | RulesOp::DeleteRepoRuleset => (json!({ "repo": repo(), "id": id() }), &["repo", "id"]),
            RulesOp::CreateRepoRuleset => (spec(json!({ "repo": repo() }), false), &["repo"]),
            RulesOp::UpdateRepoRuleset => (spec(json!({ "repo": repo(), "id": id() }), false), &["repo", "id"]),
            RulesOp::GetBranchRules => (
                json!({
                    "repo": repo(),
                    "branch": { "type": "string", "description": "The branch (or tag) name, such as main or release/1.x." },
                    "target": { "type": "string", "enum": ["branch", "tag"], "description": "branch (the default) or tag." },
                }),
                &["repo", "branch"],
            ),
            RulesOp::ListRuleEvaluations => (evaluations(json!({ "repo": repo() })), &["repo"]),
            RulesOp::ListWorkspaceRulesets => (json!({ "workspace": workspace() }), &["workspace"]),
            RulesOp::GetWorkspaceRuleset | RulesOp::DeleteWorkspaceRuleset => {
                (json!({ "workspace": workspace(), "id": id() }), &["workspace", "id"])
            }
            RulesOp::CreateWorkspaceRuleset => (spec(json!({ "workspace": workspace() }), true), &["workspace"]),
            RulesOp::UpdateWorkspaceRuleset => (spec(json!({ "workspace": workspace(), "id": id() }), true), &["workspace", "id"]),
            RulesOp::ListWorkspaceRuleEvaluations => (evaluations(json!({ "workspace": workspace() })), &["workspace"]),
        };
        let mut schema = json!({ "type": "object", "properties": properties });
        if !required.is_empty() {
            schema["required"] = json!(required);
        }
        schema
    }
}

fn ok<T: Serialize>(value: &T) -> Result<Outcome<Value>> {
    Ok(Outcome::Ok(serde_json::to_value(value)?))
}

fn text(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
}

fn flag(input: &Value, key: &str) -> bool {
    match &input[key] {
        Value::Bool(value) => *value,
        Value::String(text) => matches!(text.trim(), "true" | "1"),
        _ => false,
    }
}

async fn call<A: Serialize, T: DeserializeOwned>(services: &Services, method: &str, args: &A) -> Result<Outcome<T>> {
    g1t_kit::call(&services.work, method, args).await
}

/// The ruleset in a request body, laid over `current` for an update: the
/// fields given replace those it had.
pub(crate) fn spec_of(input: &Value, current: Option<&RulesetSpec>) -> std::result::Result<RulesetSpec, String> {
    let mut merged: Map<String, Value> = match current {
        Some(current) => match serde_json::to_value(current) {
            Ok(Value::Object(fields)) => fields,
            _ => Map::new(),
        },
        None => Map::new(),
    };
    for key in SPEC_KEYS {
        if let Some(value) = input.get(key).filter(|value| !value.is_null()) {
            merged.insert(key.to_owned(), value.clone());
        }
    }
    // Under a repository's address `name` is the repository's, so the API
    // names the ruleset `ruleset_name`; an exported ruleset's `name` is read
    // as well.
    if let Some(name) = input.get("ruleset_name").filter(|value| !value.is_null()) {
        merged.insert("name".to_owned(), name.clone());
    }
    serde_json::from_value(Value::Object(merged)).map_err(|error| format!("The ruleset could not be read: {error}"))
}

fn owner(op: RulesOp, input: &Value, repo: Option<RepoPath>) -> std::result::Result<Owner, String> {
    if op.needs_repo() {
        return repo.map(Owner::repo).ok_or_else(|| "Give the repository as \"owner/name\".".to_owned());
    }
    text(input, "workspace").map(|slug| Owner::workspace(&slug)).ok_or_else(|| "Give the workspace's slug.".to_owned())
}

pub async fn run(op: RulesOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let owner = match owner(op, input, crate::operations::repo_path(input)) {
        Ok(owner) => owner,
        Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
    };
    let actor = || viewer.clone().unwrap_or_default();
    let id = || text(input, "id").unwrap_or_default();
    match op {
        RulesOp::ListRepoRulesets | RulesOp::ListWorkspaceRulesets => {
            call(
                services,
                "list_rulesets",
                &ListRulesetsArgs { viewer: viewer.clone(), owner, include_parents: flag(input, "include_parents") },
            )
            .await
        }
        RulesOp::GetRepoRuleset | RulesOp::GetWorkspaceRuleset => {
            call(services, "get_ruleset", &GetRulesetArgs { viewer: viewer.clone(), owner, id: id() }).await
        }
        RulesOp::CreateRepoRuleset | RulesOp::CreateWorkspaceRuleset => {
            let ruleset = match spec_of(input, None) {
                Ok(ruleset) => ruleset,
                Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            };
            call(services, "save_ruleset", &SaveRulesetArgs { actor: actor(), owner, id: None, ruleset, from_api: true }).await
        }
        RulesOp::UpdateRepoRuleset | RulesOp::UpdateWorkspaceRuleset => {
            let current: Outcome<Ruleset> =
                call(services, "get_ruleset", &GetRulesetArgs { viewer: viewer.clone(), owner: owner.clone(), id: id() }).await?;
            let current = match current {
                Outcome::Ok(current) => current,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            };
            if current.level == Level::Workspace && op == RulesOp::UpdateRepoRuleset {
                return Ok(Outcome::fail(
                    FailureCode::Invalid,
                    "That is the workspace's ruleset: change it with update_workspace_ruleset.",
                ));
            }
            let ruleset = match spec_of(input, Some(&current.spec)) {
                Ok(ruleset) => ruleset,
                Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            };
            call(services, "save_ruleset", &SaveRulesetArgs { actor: actor(), owner, id: Some(current.id), ruleset, from_api: true })
                .await
        }
        RulesOp::DeleteRepoRuleset | RulesOp::DeleteWorkspaceRuleset => {
            let deleted: Outcome<bool> =
                call(services, "delete_ruleset", &DeleteRulesetArgs { actor: actor(), owner, id: id(), from_api: true }).await?;
            match deleted {
                Outcome::Ok(deleted) => ok(&json!({ "deleted": deleted })),
                Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
            }
        }
        RulesOp::GetBranchRules => {
            let Some(repo) = owner.repo else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository as \"owner/name\"."));
            };
            let target = match text(input, "target").as_deref() {
                None | Some("branch") => Target::Branch,
                Some("tag") => Target::Tag,
                Some(other) => return Ok(Outcome::fail(FailureCode::Invalid, format!("{other} is not a target: use branch or tag."))),
            };
            let Some(name) = text(input, "branch") else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Name the branch."));
            };
            call(services, "effective_rules", &EffectiveRulesArgs { viewer: viewer.clone(), repo, name, target }).await
        }
        RulesOp::ListRuleEvaluations | RulesOp::ListWorkspaceRuleEvaluations => {
            let verdict = match text(input, "verdict").as_deref() {
                None => None,
                Some("pass") => Some(Verdict::Pass),
                Some("fail") => Some(Verdict::Fail),
                Some("bypass") => Some(Verdict::Bypass),
                Some(other) => return Ok(Outcome::fail(FailureCode::Invalid, format!("{other} is not a verdict: use pass, fail or bypass."))),
            };
            let limit = match &input["limit"] {
                Value::Number(number) => number.as_u64().and_then(|n| u32::try_from(n).ok()),
                Value::String(digits) => digits.trim().parse().ok(),
                _ => None,
            };
            call(
                services,
                "rule_evaluations",
                &EvaluationsArgs {
                    viewer: viewer.clone(),
                    owner,
                    ruleset_id: text(input, "ruleset_id"),
                    verdict,
                    problems_only: flag(input, "problems_only"),
                    before: text(input, "before"),
                    limit,
                },
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_is_a_ruleset_and_an_update_keeps_what_it_leaves_out() {
        let body = json!({
            "repo": "acme/web",
            "name": "Protect main",
            "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"] } },
            "rules": [{ "type": "deletion" }, { "type": "pull_request", "parameters": { "required_approvals": 2 } }]
        });
        let created = spec_of(&body, None).unwrap();
        assert_eq!(created.name, "Protect main");
        assert_eq!(created.enforcement, Enforcement::Active);
        assert_eq!(created.rules.len(), 2);
        let updated = spec_of(&json!({ "enforcement": "evaluate" }), Some(&created)).unwrap();
        assert_eq!(updated.enforcement, Enforcement::Evaluate);
        assert_eq!(updated.rules, created.rules, "rules left out stay");
        let replaced = spec_of(&json!({ "rules": [] }), Some(&created)).unwrap();
        assert!(replaced.rules.is_empty(), "a list given replaces the list");
        let renamed = spec_of(&json!({ "ruleset_name": "Protect releases" }), Some(&created)).unwrap();
        assert_eq!(renamed.name, "Protect releases");
        assert!(spec_of(&json!({ "rules": [{ "type": "no_such_rule" }] }), None).is_err());
    }

    #[test]
    fn whose_rulesets_comes_from_repo_or_workspace() {
        let input = json!({ "workspace": "Acme" });
        assert_eq!(owner(RulesOp::ListWorkspaceRulesets, &input, None).unwrap(), Owner::workspace("acme"));
        assert!(owner(RulesOp::ListRepoRulesets, &input, None).is_err());
        let path = RepoPath { namespace: "acme".into(), name: "web".into() };
        assert_eq!(owner(RulesOp::GetBranchRules, &json!({}), Some(path.clone())).unwrap(), Owner::repo(path));
    }

    #[test]
    fn each_operation_is_described_with_a_schema() {
        for op in RulesOp::ALL {
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            assert_eq!(op.input()["type"], "object");
            if op.needs_repo() {
                assert!(op.input()["required"].as_array().unwrap().contains(&json!("repo")), "{}", op.name());
            } else {
                assert!(op.input()["required"].as_array().unwrap().contains(&json!("workspace")), "{}", op.name());
            }
        }
    }
}
