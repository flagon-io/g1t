//! The security suite over REST and MCP: secret scanning (alerts, where
//! each secret is, push protection bypasses and their review, validity
//! checks, custom patterns), code scanning (alerts, analyses, SARIF
//! uploads), vulnerability alerts, the dependency graph with its SBOM and
//! dependency review, "Fix with g1t", settings, and the workspace's
//! overview.
//!
//! The addresses follow the common ones (`/repos/{owner}/{name}/secret-
//! scanning/alerts`, `/code-scanning/sarifs`, `/dependency-graph/sbom`),
//! in g1t's spelling: no version prefix, `snake_case` throughout. The
//! security service decides who may see and change what, and which parts
//! need the Security and quality activation (a 402 says so); this module
//! reads the input and gives each answer its public shape.

use g1t_contracts::repos::RepoPath;
use g1t_contracts::security::{AlertChange, AlertState, DismissArgs, DismissReason, ReopenArgs, SecretFinding, SecurityOverview, Vulnerability};
use g1t_contracts::security_suite::*;
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use worker::Result;

use crate::operations::Services;

/// One operation of the suite.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecurityOp {
    ListSecretAlerts,
    GetSecretAlert,
    UpdateSecretAlert,
    ListSecretLocations,
    BypassPushProtection,
    CheckSecretValidity,
    ListBypassRequests,
    ReviewBypassRequest,
    ListCustomPatterns,
    CreateCustomPattern,
    UpdateCustomPattern,
    DeleteCustomPattern,
    DryRunCustomPattern,
    ListCodeAlerts,
    GetCodeAlert,
    UpdateCodeAlert,
    ListAnalyses,
    UploadSarif,
    GetSarifUpload,
    ListVulnerabilityAlerts,
    GetVulnerabilityAlert,
    UpdateVulnerabilityAlert,
    FixAlert,
    GetDependencyGraph,
    GetSbom,
    CompareDependencies,
    GetSettings,
    UpdateSettings,
    GetWorkspaceSettings,
    UpdateWorkspaceSettings,
    GetOverview,
}

impl SecurityOp {
    /// Every one: `Op::ALL` lists each as `Op::Security(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [SecurityOp; 31] = [
        SecurityOp::ListSecretAlerts,
        SecurityOp::GetSecretAlert,
        SecurityOp::UpdateSecretAlert,
        SecurityOp::ListSecretLocations,
        SecurityOp::BypassPushProtection,
        SecurityOp::CheckSecretValidity,
        SecurityOp::ListBypassRequests,
        SecurityOp::ReviewBypassRequest,
        SecurityOp::ListCustomPatterns,
        SecurityOp::CreateCustomPattern,
        SecurityOp::UpdateCustomPattern,
        SecurityOp::DeleteCustomPattern,
        SecurityOp::DryRunCustomPattern,
        SecurityOp::ListCodeAlerts,
        SecurityOp::GetCodeAlert,
        SecurityOp::UpdateCodeAlert,
        SecurityOp::ListAnalyses,
        SecurityOp::UploadSarif,
        SecurityOp::GetSarifUpload,
        SecurityOp::ListVulnerabilityAlerts,
        SecurityOp::GetVulnerabilityAlert,
        SecurityOp::UpdateVulnerabilityAlert,
        SecurityOp::FixAlert,
        SecurityOp::GetDependencyGraph,
        SecurityOp::GetSbom,
        SecurityOp::CompareDependencies,
        SecurityOp::GetSettings,
        SecurityOp::UpdateSettings,
        SecurityOp::GetWorkspaceSettings,
        SecurityOp::UpdateWorkspaceSettings,
        SecurityOp::GetOverview,
    ];

    pub fn name(self) -> &'static str {
        match self {
            SecurityOp::ListSecretAlerts => "list_secret_scanning_alerts",
            SecurityOp::GetSecretAlert => "get_secret_scanning_alert",
            SecurityOp::UpdateSecretAlert => "update_secret_scanning_alert",
            SecurityOp::ListSecretLocations => "list_secret_scanning_locations",
            SecurityOp::BypassPushProtection => "bypass_push_protection",
            SecurityOp::CheckSecretValidity => "check_secret_validity",
            SecurityOp::ListBypassRequests => "list_bypass_requests",
            SecurityOp::ReviewBypassRequest => "review_bypass_request",
            SecurityOp::ListCustomPatterns => "list_custom_patterns",
            SecurityOp::CreateCustomPattern => "create_custom_pattern",
            SecurityOp::UpdateCustomPattern => "update_custom_pattern",
            SecurityOp::DeleteCustomPattern => "delete_custom_pattern",
            SecurityOp::DryRunCustomPattern => "dry_run_custom_pattern",
            SecurityOp::ListCodeAlerts => "list_code_scanning_alerts",
            SecurityOp::GetCodeAlert => "get_code_scanning_alert",
            SecurityOp::UpdateCodeAlert => "update_code_scanning_alert",
            SecurityOp::ListAnalyses => "list_code_scanning_analyses",
            SecurityOp::UploadSarif => "upload_sarif",
            SecurityOp::GetSarifUpload => "get_sarif_upload",
            SecurityOp::ListVulnerabilityAlerts => "list_vulnerability_alerts",
            SecurityOp::GetVulnerabilityAlert => "get_vulnerability_alert",
            SecurityOp::UpdateVulnerabilityAlert => "update_vulnerability_alert",
            SecurityOp::FixAlert => "fix_security_alert",
            SecurityOp::GetDependencyGraph => "get_dependency_graph",
            SecurityOp::GetSbom => "get_sbom",
            SecurityOp::CompareDependencies => "compare_dependencies",
            SecurityOp::GetSettings => "get_security_settings",
            SecurityOp::UpdateSettings => "update_security_settings",
            SecurityOp::GetWorkspaceSettings => "get_workspace_security_settings",
            SecurityOp::UpdateWorkspaceSettings => "update_workspace_security_settings",
            SecurityOp::GetOverview => "get_security_overview",
        }
    }

    /// For the API reference: "List secret scanning alerts".
    pub fn title(self) -> &'static str {
        match self {
            SecurityOp::ListSecretAlerts => "List secret scanning alerts",
            SecurityOp::GetSecretAlert => "Get a secret scanning alert",
            SecurityOp::UpdateSecretAlert => "Dismiss or reopen a secret scanning alert",
            SecurityOp::ListSecretLocations => "List where a secret was found",
            SecurityOp::BypassPushProtection => "Bypass push protection",
            SecurityOp::CheckSecretValidity => "Check whether a secret still works",
            SecurityOp::ListBypassRequests => "List push protection bypass requests",
            SecurityOp::ReviewBypassRequest => "Review a bypass request",
            SecurityOp::ListCustomPatterns => "List custom patterns",
            SecurityOp::CreateCustomPattern => "Create a custom pattern",
            SecurityOp::UpdateCustomPattern => "Update a custom pattern",
            SecurityOp::DeleteCustomPattern => "Delete a custom pattern",
            SecurityOp::DryRunCustomPattern => "Dry-run a custom pattern",
            SecurityOp::ListCodeAlerts => "List code scanning alerts",
            SecurityOp::GetCodeAlert => "Get a code scanning alert",
            SecurityOp::UpdateCodeAlert => "Dismiss or reopen a code scanning alert",
            SecurityOp::ListAnalyses => "List code scanning analyses",
            SecurityOp::UploadSarif => "Upload a SARIF file",
            SecurityOp::GetSarifUpload => "Get a SARIF upload",
            SecurityOp::ListVulnerabilityAlerts => "List vulnerability alerts",
            SecurityOp::GetVulnerabilityAlert => "Get a vulnerability alert",
            SecurityOp::UpdateVulnerabilityAlert => "Dismiss or reopen a vulnerability alert",
            SecurityOp::FixAlert => "Fix an alert with g1t",
            SecurityOp::GetDependencyGraph => "Get the dependency graph",
            SecurityOp::GetSbom => "Export an SBOM",
            SecurityOp::CompareDependencies => "Compare dependencies",
            SecurityOp::GetSettings => "Get a repository's security settings",
            SecurityOp::UpdateSettings => "Update a repository's security settings",
            SecurityOp::GetWorkspaceSettings => "Get a workspace's security settings",
            SecurityOp::UpdateWorkspaceSettings => "Update a workspace's security settings",
            SecurityOp::GetOverview => "Get the security overview",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            SecurityOp::ListSecretAlerts => "List secret scanning alerts: secrets found in pushes (blocked) and in history (open), newest first, in a repository or (with workspace) across a workspace. Filter by state (open, dismissed, fixed), secret_type, validity (active, inactive, unknown, unsupported) and bypassed. The secret itself is never returned: a preview and a fingerprint-based id only.",
            SecurityOp::GetSecretAlert => "Get one secret scanning alert by id (sec_…), with every place it was found, its activity, its bypass requests, and whether you may bypass it or only ask to.",
            SecurityOp::UpdateSecretAlert => "Dismiss a secret scanning alert (state dismissed, with a reason: false_positive, used_in_tests, revoked or wont_fix, and an optional comment) or reopen it (state open). Revoked marks it fixed; the others let pushes carrying it through. Takes the Admin role.",
            SecurityOp::ListSecretLocations => "List every place a secret was found: file, line, commit and whether a push or the history scan found it.",
            SecurityOp::BypassPushProtection => "Push past push protection for a blocked secret, with a reason: false_positive or used_in_tests (the alert is closed with that reason) or will_fix_later (it stays open, to be rotated). Recorded on the alert and in the audit log. With delegated bypass on, someone who does not review bypasses makes a request instead, which owners and the repository's admins approve or deny; the answer says which happened. Push again once it is bypassed or approved.",
            SecurityOp::CheckSecretValidity => "Ask a landed secret's issuer whether it still works, and mark the alert active or inactive. The check is the issuer's own read-only identity call over HTTPS; the secret goes nowhere else. Needs validity checks on for the workspace (and the Security and quality activation on a private repository). Formats with no safe check answer unsupported.",
            SecurityOp::ListBypassRequests => "List a workspace's push protection bypass requests, pending first. Owners and repository admins see every request; anyone else their own. Filter by state (pending, approved, denied, cancelled) or repo.",
            SecurityOp::ReviewBypassRequest => "Approve or deny a bypass request (owners and the repository's admins, never your own), or cancel your own. An approved request bypasses push protection for that secret, as its requester asked.",
            SecurityOp::ListCustomPatterns => "List custom secret patterns: a repository's own and the ones it inherits from its workspace (with repo), or a workspace's (with workspace).",
            SecurityOp::CreateCustomPattern => "Create a custom secret pattern: a name, a regular expression for the secret, optional regular expressions for what comes right before and after it, and test strings. Patterns run in linear time (no look-around or back-references) and within size limits. With publish true, push protection and scans use it at once and the history is scanned again for it; otherwise it is a draft. A repository's takes Admin; a workspace's, an owner. On a private repository it needs the Security and quality activation.",
            SecurityOp::UpdateCustomPattern => "Change a custom pattern, publish it, or turn it back into a draft (publish false). Returns where it matched each test string.",
            SecurityOp::DeleteCustomPattern => "Delete a custom pattern. Alerts it found stay.",
            SecurityOp::DryRunCustomPattern => "Run a pattern over the default branch without saving it: of the repository, or (with workspace) of up to ten of its repositories, or those named in repos. Returns the files read and up to fifty matches each, masked.",
            SecurityOp::ListCodeAlerts => "List code scanning alerts: problems a tool reported on the default branch, one per tool, category and fingerprint, open first and worst first. In a repository, or (with workspace) across a workspace. Filter by state, severity, tool and rule_id.",
            SecurityOp::GetCodeAlert => "Get one code scanning alert by number, with its rule, location, activity and the analyses that reported it.",
            SecurityOp::UpdateCodeAlert => "Dismiss a code scanning alert (state dismissed, dismissed_reason false_positive, wont_fix or used_in_tests, optional dismissed_comment) or reopen it (state open). A fixed alert reopens by itself when an analysis reports it again.",
            SecurityOp::ListAnalyses => "List code scanning analyses, newest first: each upload's run of one tool on one commit, with how many results it had and the alerts it opened and fixed.",
            SecurityOp::UploadSarif => "Upload a SARIF 2.1.0 file: sarif is the file gzipped and base64-encoded; commit_sha the full commit; ref refs/heads/<branch> or refs/pull/<number>/head. For the default branch, new results open alerts and results no longer reported fix theirs. For a pull request, its results new to it on lines it changes become review comments and the Code scanning check, which fails at the repository's threshold. Read at once; the answer says complete or failed and why. Needs the Security and quality activation on a private repository.",
            SecurityOp::GetSarifUpload => "Get a SARIF upload by id (sar_…): whether it was read, the analyses it made, and what was wrong.",
            SecurityOp::ListVulnerabilityAlerts => "List vulnerability alerts: a package a lockfile resolves with a known advisory, open first and worst first, with the security update g1t opened for it. In a repository, or (with workspace) across a workspace. Filter by state, severity, ecosystem and package.",
            SecurityOp::GetVulnerabilityAlert => "Get one vulnerability alert by id (vul_…).",
            SecurityOp::UpdateVulnerabilityAlert => "Dismiss a vulnerability alert (state dismissed, with a reason: fix_started, no_bandwidth, tolerable_risk, inaccurate or not_used, and an optional comment) or reopen it (state open).",
            SecurityOp::FixAlert => "Put g1t on an issue to fix an alert: a code scanning alert (cod_…), a vulnerable dependency (vul_…) or a secret in the code (sec_…; rotating it stays with you). Its pull request lands through the repository's required checks. The agent's run is charged as agent usage. Returns the issue, and whether the agent started.",
            SecurityOp::GetDependencyGraph => "Get the dependency graph: every package the lockfiles on the default branch resolve, per lockfile, with whether it is direct or transitive (where the lockfile says), for development, its license when recorded, its package URL and its open vulnerability alerts.",
            SecurityOp::GetSbom => "Export the dependency graph as an SPDX 2.3 JSON document, in sbom. Every package is named by its package URL.",
            SecurityOp::CompareDependencies => "Compare the dependencies at two commits, branches or tags (basehead, as base...head): what was added and removed per lockfile, with the known vulnerabilities of what was added and whether it passes the repository's dependency review policy. Needs the Security and quality activation on a private repository.",
            SecurityOp::GetSettings => "Get a repository's security settings: when the Code scanning check fails, dependency review and its policy, its workspace's settings, and whether the paid features are on for it.",
            SecurityOp::UpdateSettings => "Change a repository's security settings: code_scanning_gate (none, errors, critical, high, medium or any), dependency_review, review_fail_on (critical, high, medium, low or none), review_deny_licenses (SPDX ids) and review_comment. Takes the Maintain role. Require the Code scanning and Dependency review checks in branch protection to gate merges on them.",
            SecurityOp::GetWorkspaceSettings => "Get a workspace's security settings (delegated bypass, validity checks) and whether it has the Security and quality activation.",
            SecurityOp::UpdateWorkspaceSettings => "Turn delegated bypass and validity checks on or off for a workspace. Owners only.",
            SecurityOp::GetOverview => "Get a workspace's security overview: open alerts by type and severity, how many opened and closed in the last days (7 to 90, 30 by default), a daily trend, and for each repository which features are on and what is open, most in need first. Private repositories count with the Security and quality activation only.",
        }
    }

    /// Whether the operation is about one repository named by `repo`
    /// (rather than a workspace, or either).
    pub fn needs_repo(self) -> bool {
        !matches!(
            self,
            SecurityOp::ListSecretAlerts
                | SecurityOp::ListCodeAlerts
                | SecurityOp::ListVulnerabilityAlerts
                | SecurityOp::ListBypassRequests
                | SecurityOp::ReviewBypassRequest
                | SecurityOp::ListCustomPatterns
                | SecurityOp::CreateCustomPattern
                | SecurityOp::UpdateCustomPattern
                | SecurityOp::DeleteCustomPattern
                | SecurityOp::DryRunCustomPattern
                | SecurityOp::GetWorkspaceSettings
                | SecurityOp::UpdateWorkspaceSettings
                | SecurityOp::GetOverview
        )
    }

    pub fn input(self) -> Value {
        let repo = || json!({ "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." });
        let either = |mut properties: Value| {
            properties["repo"] = json!({ "type": "string", "description": "Repository as \"owner/name\". Or give workspace." });
            properties["workspace"] = json!({ "type": "string", "description": "Instead of repo: the workspace's slug, for all of it (or its own, for patterns)." });
            properties
        };
        let secret_id = || json!({ "type": "string", "description": "The alert's id: sec_…" });
        let number = || json!({ "type": "integer", "description": "The code scanning alert's number." });
        let state = || json!({ "type": "string", "enum": ["open", "dismissed", "fixed"], "description": "Only alerts in this state." });
        let severity = || json!({ "type": "string", "enum": ["critical", "high", "medium", "low", "unknown"], "description": "Only alerts of this severity." });
        let set_state = || json!({ "type": "string", "enum": ["open", "dismissed"], "description": "dismissed, with a reason, or open to reopen." });
        let comment = || json!({ "type": "string", "description": "Why, in a sentence; kept with the alert. At most 500 characters." });
        let pattern_fields = |mut properties: Value| {
            properties["pattern_name"] = json!({ "type": "string", "description": "What people call it: \"Acme API key\"." });
            properties["pattern"] = json!({ "type": "string", "description": "The secret's format, as a regular expression (the regex crate's syntax: no look-around or back-references). At most 1,000 characters; it may not match an empty string." });
            properties["before"] = json!({ "type": "string", "description": "What must come right before the secret, as a regular expression. Default: the start of the line or a character that is not a letter or digit." });
            properties["after"] = json!({ "type": "string", "description": "What must come right after it. Default: the end of the line or a character that is not a letter or digit." });
            properties
        };
        let workspace = || json!({ "type": "string", "description": "The workspace's slug, e.g. \"flagon-io\"." });
        let (properties, required): (Value, &[&str]) = match self {
            SecurityOp::ListSecretAlerts => (
                either(json!({
                    "state": state(),
                    "secret_type": { "type": "string", "description": "Only this kind of secret: aws_access_key, github_token, custom_pattern, …" },
                    "validity": { "type": "string", "enum": ["active", "inactive", "unknown", "unsupported"], "description": "Only alerts whose issuer said this when last asked." },
                    "bypassed": { "type": "boolean", "description": "Only alerts someone bypassed push protection for (true), or not (false)." },
                })),
                &[],
            ),
            SecurityOp::GetSecretAlert | SecurityOp::ListSecretLocations | SecurityOp::CheckSecretValidity => {
                (json!({ "repo": repo(), "id": secret_id() }), &["repo", "id"])
            }
            SecurityOp::UpdateSecretAlert => (
                json!({
                    "repo": repo(),
                    "id": secret_id(),
                    "state": set_state(),
                    "reason": { "type": "string", "enum": ["false_positive", "used_in_tests", "revoked", "wont_fix"], "description": "Why it is dismissed. revoked marks it fixed." },
                    "comment": comment(),
                }),
                &["repo", "id", "state"],
            ),
            SecurityOp::BypassPushProtection => (
                json!({
                    "repo": repo(),
                    "id": secret_id(),
                    "reason": { "type": "string", "enum": BypassReason::ALL.map(BypassReason::as_str), "description": "false_positive: not a secret. used_in_tests: a value for tests. will_fix_later: real, to be rotated (the alert stays open)." },
                    "comment": comment(),
                }),
                &["repo", "id", "reason"],
            ),
            SecurityOp::ListBypassRequests => (
                json!({
                    "workspace": workspace(),
                    "repo": { "type": "string", "description": "Only this repository's, as \"owner/name\"." },
                    "state": { "type": "string", "enum": ["pending", "approved", "denied", "cancelled"], "description": "Only requests in this state." },
                }),
                &["workspace"],
            ),
            SecurityOp::ReviewBypassRequest => (
                json!({
                    "workspace": workspace(),
                    "id": { "type": "string", "description": "The request's id: byp_…" },
                    "decision": { "type": "string", "enum": ["approve", "deny", "cancel"], "description": "approve or deny (reviewers), or cancel (your own)." },
                    "comment": comment(),
                }),
                &["workspace", "id", "decision"],
            ),
            SecurityOp::ListCustomPatterns => (either(json!({})), &[]),
            SecurityOp::CreateCustomPattern => (
                either(pattern_fields(json!({
                    "test_strings": { "type": "array", "items": { "type": "string" }, "description": "Up to 20 strings to show the pattern working on." },
                    "publish": { "type": "boolean", "description": "Use it in push protection and scans now (true), or keep a draft (false, the default)." },
                }))),
                &["pattern_name", "pattern"],
            ),
            SecurityOp::UpdateCustomPattern => (
                either(pattern_fields(json!({
                    "id": { "type": "string", "description": "The pattern's id: pat_…" },
                    "test_strings": { "type": "array", "items": { "type": "string" }, "description": "Up to 20 strings to show the pattern working on." },
                    "publish": { "type": "boolean", "description": "Published (true) or a draft (false)." },
                }))),
                &["id", "pattern_name", "pattern"],
            ),
            SecurityOp::DeleteCustomPattern => (either(json!({ "id": { "type": "string", "description": "The pattern's id: pat_…" } })), &["id"]),
            SecurityOp::DryRunCustomPattern => (
                either(pattern_fields(json!({
                    "repos": { "type": "array", "items": { "type": "string" }, "description": "With workspace: repository names to run it on; the first ten when empty." },
                }))),
                &["pattern"],
            ),
            SecurityOp::ListCodeAlerts => (
                either(json!({
                    "state": state(),
                    "severity": severity(),
                    "tool": { "type": "string", "description": "Only this tool's: \"ESLint\"." },
                    "rule_id": { "type": "string", "description": "Only this rule's." },
                })),
                &[],
            ),
            SecurityOp::GetCodeAlert => (json!({ "repo": repo(), "number": number() }), &["repo", "number"]),
            SecurityOp::UpdateCodeAlert => (
                json!({
                    "repo": repo(),
                    "number": number(),
                    "state": set_state(),
                    "dismissed_reason": { "type": "string", "enum": ["false_positive", "wont_fix", "used_in_tests"], "description": "Why it is dismissed." },
                    "dismissed_comment": comment(),
                }),
                &["repo", "number", "state"],
            ),
            SecurityOp::ListAnalyses => (json!({ "repo": repo() }), &["repo"]),
            SecurityOp::UploadSarif => (
                json!({
                    "repo": repo(),
                    "commit_sha": { "type": "string", "description": "The full hash of the commit analysed." },
                    "ref": { "type": "string", "description": "refs/heads/<branch>, or refs/pull/<number>/head (or /merge) for a pull request." },
                    "sarif": { "type": "string", "description": "The SARIF 2.1.0 file, gzipped, then base64-encoded. At most 10 MB encoded and 40 MB unzipped." },
                    "tool_name": { "type": "string", "description": "The tool's name, when the file has one run and you want another name for it." },
                    "category": { "type": "string", "description": "Which analysis this is, when a repository runs several of one tool. Default: the run's automationDetails.id, or the tool's name." },
                    "checkout_uri": { "type": "string", "description": "Where the files were checked out (file:///home/runner/work/repo), so absolute paths become repository paths." },
                }),
                &["repo", "commit_sha", "ref", "sarif"],
            ),
            SecurityOp::GetSarifUpload => (json!({ "repo": repo(), "id": { "type": "string", "description": "The upload's id: sar_…" } }), &["repo", "id"]),
            SecurityOp::ListVulnerabilityAlerts => (
                either(json!({
                    "state": state(),
                    "severity": severity(),
                    "ecosystem": { "type": "string", "description": "Only this ecosystem's: npm, crates.io, Go or PyPI." },
                    "package": { "type": "string", "description": "Only this package's." },
                })),
                &[],
            ),
            SecurityOp::GetVulnerabilityAlert => (json!({ "repo": repo(), "id": { "type": "string", "description": "The alert's id: vul_…" } }), &["repo", "id"]),
            SecurityOp::UpdateVulnerabilityAlert => (
                json!({
                    "repo": repo(),
                    "id": { "type": "string", "description": "The alert's id: vul_…" },
                    "state": set_state(),
                    "reason": { "type": "string", "enum": ["fix_started", "no_bandwidth", "tolerable_risk", "inaccurate", "not_used"], "description": "Why it is dismissed." },
                    "comment": comment(),
                }),
                &["repo", "id", "state"],
            ),
            SecurityOp::FixAlert => (
                json!({ "repo": repo(), "id": { "type": "string", "description": "The alert's id: cod_…, vul_… or sec_…" } }),
                &["repo", "id"],
            ),
            SecurityOp::GetDependencyGraph | SecurityOp::GetSbom | SecurityOp::GetSettings => (json!({ "repo": repo() }), &["repo"]),
            SecurityOp::CompareDependencies => (
                json!({
                    "repo": repo(),
                    "basehead": { "type": "string", "description": "base...head: two commits, branches or tags, e.g. main...my-branch." },
                }),
                &["repo", "basehead"],
            ),
            SecurityOp::UpdateSettings => (
                json!({
                    "repo": repo(),
                    "code_scanning_gate": { "type": "string", "enum": ["none", "errors", "critical", "high", "medium", "any"], "description": "When a pull request's Code scanning check fails: never, on errors, or on new results of this security severity or worse (and errors)." },
                    "dependency_review": { "type": "boolean", "description": "Whether pull requests get the Dependency review check." },
                    "review_fail_on": { "type": "string", "enum": ["critical", "high", "medium", "low", "none"], "description": "The lowest severity of a known vulnerability in an added package that fails the review." },
                    "review_deny_licenses": { "type": "array", "items": { "type": "string" }, "description": "SPDX license ids an added package may not have." },
                    "review_comment": { "type": "boolean", "description": "Whether the review comments its summary on the pull request." },
                }),
                &["repo"],
            ),
            SecurityOp::GetWorkspaceSettings => (json!({ "workspace": workspace() }), &["workspace"]),
            SecurityOp::UpdateWorkspaceSettings => (
                json!({
                    "workspace": workspace(),
                    "delegated_bypass": { "type": "boolean", "description": "Bypasses need an owner's or the repository's admins' approval." },
                    "validity_checks": { "type": "boolean", "description": "Ask issuers whether secrets still work, where that can be done safely." },
                }),
                &["workspace"],
            ),
            SecurityOp::GetOverview => (
                json!({ "workspace": workspace(), "days": { "type": "integer", "description": "Days of trend, 7 to 90. Default 30." } }),
                &["workspace"],
            ),
        };
        let mut schema = json!({ "type": "object", "properties": properties });
        if !required.is_empty() {
            schema["required"] = json!(required);
        }
        schema
    }
}

fn failed(code: FailureCode, message: &str) -> Result<Outcome<Value>> {
    Ok(Outcome::fail(code, message))
}

fn ok<T: Serialize>(value: &T) -> Result<Outcome<Value>> {
    Ok(Outcome::Ok(serde_json::to_value(value)?))
}

fn text(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
}

fn flag(input: &Value, key: &str) -> Option<bool> {
    match &input[key] {
        Value::Bool(value) => Some(*value),
        Value::String(text) => match text.trim() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn whole(input: &Value, key: &str) -> Option<u32> {
    match &input[key] {
        Value::Number(number) => number.as_u64().and_then(|n| u32::try_from(n).ok()),
        Value::String(digits) => digits.trim().parse().ok(),
        _ => None,
    }
}

fn strings(input: &Value, key: &str) -> Vec<String> {
    input[key].as_array().map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

/// One of `allowed`, or why not.
fn one_of(input: &Value, key: &str, allowed: &[&str]) -> std::result::Result<Option<String>, String> {
    match text(input, key) {
        None => Ok(None),
        Some(given) => {
            let lower = given.to_lowercase();
            if allowed.contains(&lower.as_str()) {
                Ok(Some(lower))
            } else {
                Err(format!("{key} is {}, not {given}.", allowed.join(", ")))
            }
        }
    }
}

/// Filters for secret scanning alerts.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct SecretFilters {
    pub state: Option<AlertState>,
    pub secret_type: Option<String>,
    pub validity: Option<String>,
    pub bypassed: Option<bool>,
}

pub(crate) fn secret_filters(input: &Value) -> std::result::Result<SecretFilters, String> {
    Ok(SecretFilters {
        state: one_of(input, "state", &["open", "dismissed", "fixed"])?.and_then(|state| AlertState::parse(&state)),
        secret_type: text(input, "secret_type"),
        validity: one_of(input, "validity", &["active", "inactive", "unknown", "unsupported"])?,
        bypassed: match &input["bypassed"] {
            Value::Null => None,
            _ => Some(flag(input, "bypassed").ok_or("bypassed is true or false.")?),
        },
    })
}

impl SecretFilters {
    pub(crate) fn keeps(&self, secret: &SecretFinding) -> bool {
        self.state.is_none_or(|state| secret.state == state)
            && self.secret_type.as_deref().is_none_or(|kind| secret.kind == kind)
            && self.validity.as_deref().is_none_or(|validity| secret.validity.as_deref().unwrap_or("unknown") == validity)
            && self.bypassed.is_none_or(|bypassed| secret.bypass.is_some() == bypassed)
    }
}

/// Filters for code scanning alerts.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct CodeFilters {
    pub state: Option<AlertState>,
    pub severity: Option<String>,
    pub tool: Option<String>,
    pub rule_id: Option<String>,
}

pub(crate) fn code_filters(input: &Value) -> std::result::Result<CodeFilters, String> {
    Ok(CodeFilters {
        state: one_of(input, "state", &["open", "dismissed", "fixed"])?.and_then(|state| AlertState::parse(&state)),
        severity: one_of(input, "severity", &["critical", "high", "medium", "low", "unknown"])?,
        tool: text(input, "tool"),
        rule_id: text(input, "rule_id"),
    })
}

impl CodeFilters {
    pub(crate) fn keeps(&self, alert: &CodeAlert) -> bool {
        self.state.is_none_or(|state| alert.state == state)
            && self.severity.as_deref().is_none_or(|severity| alert.severity == severity)
            && self.tool.as_deref().is_none_or(|tool| alert.tool.eq_ignore_ascii_case(tool))
            && self.rule_id.as_deref().is_none_or(|rule| alert.rule_id == rule)
    }
}

/// Filters for vulnerability alerts.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct VulnerabilityFilters {
    pub state: Option<AlertState>,
    pub severity: Option<String>,
    pub ecosystem: Option<String>,
    pub package: Option<String>,
}

pub(crate) fn vulnerability_filters(input: &Value) -> std::result::Result<VulnerabilityFilters, String> {
    Ok(VulnerabilityFilters {
        state: one_of(input, "state", &["open", "dismissed", "fixed"])?.and_then(|state| AlertState::parse(&state)),
        severity: one_of(input, "severity", &["critical", "high", "medium", "low", "unknown"])?,
        ecosystem: text(input, "ecosystem"),
        package: text(input, "package"),
    })
}

impl VulnerabilityFilters {
    pub(crate) fn keeps(&self, vuln: &Vulnerability) -> bool {
        self.state.is_none_or(|state| vuln.state == state)
            && self.severity.as_deref().is_none_or(|severity| vuln.severity == severity)
            && self.ecosystem.as_deref().is_none_or(|ecosystem| vuln.ecosystem.eq_ignore_ascii_case(ecosystem))
            && self.package.as_deref().is_none_or(|package| vuln.package == package)
    }
}

/// `base...head` (or `base..head`), as compare_dependencies reads it.
pub(crate) fn base_head(text: &str) -> Option<(String, String)> {
    let (base, head) = text.split_once("...").or_else(|| text.split_once(".."))?;
    let (base, head) = (base.trim(), head.trim());
    (!base.is_empty() && !head.is_empty()).then(|| (base.to_owned(), head.to_owned()))
}

/// What dismissing or reopening an alert of `kind` asks: the reason, if
/// dismissing, checked against the reasons that kind takes.
pub(crate) fn state_change(input: &Value, reason_key: &str, reasons: &[DismissReason]) -> std::result::Result<Option<DismissReason>, String> {
    match text(input, "state").as_deref() {
        Some("open") => Ok(None),
        Some("dismissed") => {
            let names: Vec<&str> = reasons.iter().map(|reason| reason.as_str()).collect();
            let given = text(input, reason_key).ok_or_else(|| format!("Give {reason_key}: one of {}.", names.join(", ")))?;
            DismissReason::parse(&given)
                .filter(|reason| reasons.contains(reason))
                .map(Some)
                .ok_or_else(|| format!("{reason_key} is {}, not {given}.", names.join(", ")))
        }
        _ => Err("state is open or dismissed.".to_owned()),
    }
}

const SECRET_REASONS: [DismissReason; 4] = [DismissReason::FalsePositive, DismissReason::UsedInTests, DismissReason::Revoked, DismissReason::WontFix];
const CODE_REASONS: [DismissReason; 3] = [DismissReason::FalsePositive, DismissReason::WontFix, DismissReason::UsedInTests];
const DEPENDENCY_REASONS: [DismissReason; 5] = [
    DismissReason::FixStarted,
    DismissReason::NoBandwidth,
    DismissReason::TolerableRisk,
    DismissReason::Inaccurate,
    DismissReason::NotUsed,
];

async fn call<A: Serialize, T: DeserializeOwned>(services: &Services, method: &str, args: &A) -> Result<Outcome<T>> {
    g1t_kit::call(&services.security, method, args).await
}

/// Passes a service's outcome through as it is.
async fn pass<A: Serialize>(services: &Services, method: &str, args: &A) -> Result<Outcome<Value>> {
    call(services, method, args).await
}

fn path_of(input: &Value) -> Option<RepoPath> {
    crate::operations::repo_path(input)
}

pub async fn run(op: SecurityOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let actor = || viewer.clone().unwrap_or_default();
    let repo = path_of(input);
    let workspace = text(input, "workspace").map(|slug| slug.to_lowercase());
    let need_repo = || "Give the repository as \"owner/name\".".to_owned();
    // Operations on a repository or a workspace: which.
    let scope_repo = repo.clone();
    let scope_workspace = || workspace.clone().or_else(|| repo.as_ref().map(|repo| repo.namespace.to_lowercase()));
    match op {
        SecurityOp::ListSecretAlerts => {
            let filters = match secret_filters(input) {
                Ok(filters) => filters,
                Err(message) => return failed(FailureCode::Invalid, &message),
            };
            match (scope_repo, workspace) {
                (Some(repo), _) => {
                    let overview: Outcome<SecurityOverview> =
                        call(services, "overview", &g1t_contracts::security::OverviewArgs { repo, viewer: viewer.clone() }).await?;
                    match overview {
                        Outcome::Ok(overview) => {
                            let alerts: Vec<SecretFinding> = overview.secrets.into_iter().filter(|secret| filters.keeps(secret)).collect();
                            ok(&alerts)
                        }
                        Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
                    }
                }
                (None, Some(workspace)) => {
                    let found: Outcome<Vec<WorkspaceAlert>> = call(
                        services,
                        "workspace_alerts",
                        &WorkspaceAlertsArgs { viewer: viewer.clone(), workspace, alert_type: AlertType::SecretScanning },
                    )
                    .await?;
                    match found {
                        Outcome::Ok(found) => {
                            let alerts: Vec<WorkspaceAlert> =
                                found.into_iter().filter(|alert| alert.secret.as_ref().is_some_and(|secret| filters.keeps(secret))).collect();
                            ok(&alerts)
                        }
                        Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
                    }
                }
                (None, None) => failed(FailureCode::Invalid, "Give repo, or workspace for all of one."),
            }
        }
        SecurityOp::GetSecretAlert | SecurityOp::ListSecretLocations => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            let id = text(input, "id").unwrap_or_default();
            let detail: Outcome<SecretAlertDetail> = call(services, "secret_alert", &SecretAlertArgs { viewer: viewer.clone(), repo, id }).await?;
            match (detail, op) {
                (Outcome::Ok(detail), SecurityOp::ListSecretLocations) => ok(&detail.locations),
                (Outcome::Ok(detail), _) => ok(&detail),
                (Outcome::Fail(failure), _) => Ok(Outcome::Fail(failure)),
            }
        }
        SecurityOp::UpdateSecretAlert | SecurityOp::UpdateVulnerabilityAlert => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            let id = text(input, "id").unwrap_or_default();
            let (reasons, wants): (&[DismissReason], &str) = match op {
                SecurityOp::UpdateSecretAlert => (&SECRET_REASONS, "sec_"),
                _ => (&DEPENDENCY_REASONS, "vul_"),
            };
            if !id.starts_with(wants) {
                return failed(FailureCode::NotFound, "No such alert.");
            }
            let reason = match state_change(input, "reason", reasons) {
                Ok(reason) => reason,
                Err(message) => return failed(FailureCode::Invalid, &message),
            };
            let changed: Outcome<AlertChange> = match reason {
                Some(reason) => {
                    let comment = text(input, "comment").unwrap_or_default();
                    call(services, "dismiss", &DismissArgs { actor: actor(), repo, id, reason, comment }).await?
                }
                None => call(services, "reopen", &ReopenArgs { actor: actor(), repo, id }).await?,
            };
            match changed {
                Outcome::Ok(AlertChange { secret: Some(secret), .. }) => ok(&secret),
                Outcome::Ok(AlertChange { vulnerability: Some(vuln), .. }) => ok(&vuln),
                Outcome::Ok(_) => failed(FailureCode::NotFound, "No such alert."),
                Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
            }
        }
        SecurityOp::BypassPushProtection => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            let Some(reason) = text(input, "reason").as_deref().and_then(BypassReason::parse) else {
                return failed(FailureCode::Invalid, "reason is false_positive, used_in_tests or will_fix_later.");
            };
            let args = BypassArgs { actor: actor(), repo, id: text(input, "id").unwrap_or_default(), reason, comment: text(input, "comment").unwrap_or_default() };
            pass(services, "bypass", &args).await
        }
        SecurityOp::CheckSecretValidity => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            pass(services, "check_validity", &CheckValidityArgs { actor: actor(), repo, id: text(input, "id").unwrap_or_default() }).await
        }
        SecurityOp::ListBypassRequests => {
            let Some(workspace) = workspace else { return failed(FailureCode::Invalid, "Give the workspace.") };
            let state = match one_of(input, "state", &["pending", "approved", "denied", "cancelled"]) {
                Ok(state) => state,
                Err(message) => return failed(FailureCode::Invalid, &message),
            };
            pass(services, "bypass_requests", &BypassRequestsArgs { viewer: viewer.clone(), workspace, repo, state }).await
        }
        SecurityOp::ReviewBypassRequest => {
            let Some(workspace) = workspace else { return failed(FailureCode::Invalid, "Give the workspace.") };
            let decision = match one_of(input, "decision", &["approve", "deny", "cancel"]) {
                Ok(Some(decision)) => decision,
                Ok(None) => return failed(FailureCode::Invalid, "decision is approve, deny or cancel."),
                Err(message) => return failed(FailureCode::Invalid, &message),
            };
            let args = ReviewBypassArgs {
                actor: actor(),
                workspace,
                id: text(input, "id").unwrap_or_default(),
                decision,
                comment: text(input, "comment").unwrap_or_default(),
            };
            pass(services, "review_bypass", &args).await
        }
        SecurityOp::ListCustomPatterns => {
            let Some(workspace) = scope_workspace() else { return failed(FailureCode::Invalid, "Give repo or workspace.") };
            pass(services, "custom_patterns", &CustomPatternsArgs { viewer: viewer.clone(), workspace, repo: scope_repo }).await
        }
        SecurityOp::CreateCustomPattern | SecurityOp::UpdateCustomPattern => {
            let Some(workspace) = scope_workspace() else { return failed(FailureCode::Invalid, "Give repo or workspace.") };
            let args = SaveCustomPatternArgs {
                actor: actor(),
                workspace,
                repo: scope_repo,
                id: if op == SecurityOp::UpdateCustomPattern { text(input, "id") } else { None },
                name: text(input, "pattern_name").unwrap_or_default(),
                pattern: input["pattern"].as_str().unwrap_or_default().to_owned(),
                before: text(input, "before"),
                after: text(input, "after"),
                test_strings: strings(input, "test_strings"),
                publish: flag(input, "publish").unwrap_or(false),
            };
            pass(services, "save_custom_pattern", &args).await
        }
        SecurityOp::DeleteCustomPattern => {
            let Some(workspace) = scope_workspace() else { return failed(FailureCode::Invalid, "Give repo or workspace.") };
            let args = DeleteCustomPatternArgs { actor: actor(), workspace, repo: scope_repo, id: text(input, "id").unwrap_or_default() };
            match call::<_, bool>(services, "delete_custom_pattern", &args).await? {
                Outcome::Ok(_) => ok(&json!({ "deleted": true })),
                Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
            }
        }
        SecurityOp::DryRunCustomPattern => {
            let Some(workspace) = scope_workspace() else { return failed(FailureCode::Invalid, "Give repo or workspace.") };
            let args = DryRunPatternArgs {
                actor: actor(),
                workspace,
                repo: scope_repo,
                repos: strings(input, "repos"),
                pattern: input["pattern"].as_str().unwrap_or_default().to_owned(),
                before: text(input, "before"),
                after: text(input, "after"),
            };
            pass(services, "dry_run_pattern", &args).await
        }
        SecurityOp::ListCodeAlerts => {
            let filters = match code_filters(input) {
                Ok(filters) => filters,
                Err(message) => return failed(FailureCode::Invalid, &message),
            };
            match (scope_repo, workspace) {
                (Some(repo), _) => match call::<_, CodeScanning>(services, "code_scanning", &CodeScanningArgs { viewer: viewer.clone(), repo }).await? {
                    Outcome::Ok(scanning) => {
                        let alerts: Vec<CodeAlert> = scanning.alerts.into_iter().filter(|alert| filters.keeps(alert)).collect();
                        ok(&alerts)
                    }
                    Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
                },
                (None, Some(workspace)) => {
                    let found: Outcome<Vec<WorkspaceAlert>> = call(
                        services,
                        "workspace_alerts",
                        &WorkspaceAlertsArgs { viewer: viewer.clone(), workspace, alert_type: AlertType::CodeScanning },
                    )
                    .await?;
                    match found {
                        Outcome::Ok(found) => {
                            let alerts: Vec<WorkspaceAlert> =
                                found.into_iter().filter(|alert| alert.code.as_ref().is_some_and(|code| filters.keeps(code))).collect();
                            ok(&alerts)
                        }
                        Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
                    }
                }
                (None, None) => failed(FailureCode::Invalid, "Give repo, or workspace for all of one."),
            }
        }
        SecurityOp::GetCodeAlert => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            pass(services, "code_alert", &CodeAlertArgs { viewer: viewer.clone(), repo, number: whole(input, "number").unwrap_or(0) }).await
        }
        SecurityOp::UpdateCodeAlert => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            let reason = match state_change(input, "dismissed_reason", &CODE_REASONS) {
                Ok(reason) => reason,
                Err(message) => return failed(FailureCode::Invalid, &message),
            };
            let args = SetCodeAlertStateArgs {
                actor: actor(),
                repo,
                number: whole(input, "number").unwrap_or(0),
                state: if reason.is_some() { AlertState::Dismissed } else { AlertState::Open },
                reason,
                comment: text(input, "dismissed_comment").unwrap_or_default(),
            };
            pass(services, "set_code_alert_state", &args).await
        }
        SecurityOp::ListAnalyses => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            match call::<_, CodeScanning>(services, "code_scanning", &CodeScanningArgs { viewer: viewer.clone(), repo }).await? {
                Outcome::Ok(scanning) => ok(&scanning.analyses),
                Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
            }
        }
        SecurityOp::UploadSarif => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            let (Some(commit_sha), Some(git_ref), Some(sarif)) = (text(input, "commit_sha"), text(input, "ref"), text(input, "sarif")) else {
                return failed(FailureCode::Invalid, "Give commit_sha, ref and sarif (the file gzipped and base64-encoded).");
            };
            if sarif.len() > g1t_scan_limits::MAX_UPLOAD_BYTES {
                return failed(FailureCode::Invalid, "The upload is larger than 10 MB.");
            }
            let args = UploadSarifArgs {
                actor: actor(),
                repo,
                commit_sha,
                git_ref,
                sarif,
                tool_name: text(input, "tool_name"),
                category: text(input, "category"),
                checkout_uri: text(input, "checkout_uri"),
            };
            pass(services, "upload_sarif", &args).await
        }
        SecurityOp::GetSarifUpload => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            pass(services, "sarif_status", &SarifStatusArgs { viewer: viewer.clone(), repo, id: text(input, "id").unwrap_or_default() }).await
        }
        SecurityOp::ListVulnerabilityAlerts => {
            let filters = match vulnerability_filters(input) {
                Ok(filters) => filters,
                Err(message) => return failed(FailureCode::Invalid, &message),
            };
            match (scope_repo, workspace) {
                (Some(repo), _) => {
                    let overview: Outcome<SecurityOverview> =
                        call(services, "overview", &g1t_contracts::security::OverviewArgs { repo, viewer: viewer.clone() }).await?;
                    match overview {
                        Outcome::Ok(overview) => {
                            let alerts: Vec<Vulnerability> = overview.vulnerabilities.into_iter().filter(|vuln| filters.keeps(vuln)).collect();
                            ok(&alerts)
                        }
                        Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
                    }
                }
                (None, Some(workspace)) => {
                    let found: Outcome<Vec<WorkspaceAlert>> = call(
                        services,
                        "workspace_alerts",
                        &WorkspaceAlertsArgs { viewer: viewer.clone(), workspace, alert_type: AlertType::Vulnerability },
                    )
                    .await?;
                    match found {
                        Outcome::Ok(found) => {
                            let alerts: Vec<WorkspaceAlert> =
                                found.into_iter().filter(|alert| alert.vulnerability.as_ref().is_some_and(|vuln| filters.keeps(vuln))).collect();
                            ok(&alerts)
                        }
                        Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
                    }
                }
                (None, None) => failed(FailureCode::Invalid, "Give repo, or workspace for all of one."),
            }
        }
        SecurityOp::GetVulnerabilityAlert => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            let id = text(input, "id").unwrap_or_default();
            let overview: Outcome<SecurityOverview> =
                call(services, "overview", &g1t_contracts::security::OverviewArgs { repo, viewer: viewer.clone() }).await?;
            match overview {
                Outcome::Ok(overview) => match overview.vulnerabilities.into_iter().find(|vuln| vuln.id == id) {
                    Some(vuln) => ok(&vuln),
                    None => failed(FailureCode::NotFound, "No such alert."),
                },
                Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
            }
        }
        SecurityOp::FixAlert => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            pass(services, "fix_alert", &FixAlertArgs { actor: actor(), repo, id: text(input, "id").unwrap_or_default() }).await
        }
        SecurityOp::GetDependencyGraph => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            pass(services, "dependency_graph", &DependencyGraphArgs { viewer: viewer.clone(), repo }).await
        }
        SecurityOp::GetSbom => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            // The document goes out as SPDX spells it: `sbom` is passed
            // through untouched (g1t_kit::wire::USER_KEYED).
            match call::<_, Value>(services, "sbom", &SbomArgs { viewer: viewer.clone(), repo }).await? {
                Outcome::Ok(document) => ok(&json!({ "sbom": document })),
                Outcome::Fail(failure) => Ok(Outcome::Fail(failure)),
            }
        }
        SecurityOp::CompareDependencies => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            let Some((base, head)) = text(input, "basehead").as_deref().and_then(base_head) else {
                return failed(FailureCode::Invalid, "basehead is base...head, e.g. main...my-branch.");
            };
            pass(services, "dependency_review", &DependencyReviewArgs { viewer: viewer.clone(), repo, base, head }).await
        }
        SecurityOp::GetSettings => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            pass(services, "security_settings", &SecuritySettingsArgs { viewer: viewer.clone(), repo }).await
        }
        SecurityOp::UpdateSettings => {
            let Some(repo) = repo else { return failed(FailureCode::Invalid, &need_repo()) };
            // What is not given stays as it is.
            let current: Outcome<SecuritySettingsView> =
                call(services, "security_settings", &SecuritySettingsArgs { viewer: viewer.clone(), repo: repo.clone() }).await?;
            let mut settings = match current {
                Outcome::Ok(view) => view.settings,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            };
            if let Some(gate) = text(input, "code_scanning_gate") {
                settings.code_scanning_gate = gate.to_lowercase();
            }
            if let Some(on) = flag(input, "dependency_review") {
                settings.dependency_review = on;
            }
            if let Some(fail_on) = text(input, "review_fail_on") {
                settings.review_fail_on = fail_on.to_lowercase();
            }
            if input["review_deny_licenses"].is_array() {
                settings.review_deny_licenses = strings(input, "review_deny_licenses");
            }
            if let Some(on) = flag(input, "review_comment") {
                settings.review_comment = on;
            }
            pass(services, "set_security_settings", &SetSecuritySettingsArgs { actor: actor(), repo, settings }).await
        }
        SecurityOp::GetWorkspaceSettings => {
            let Some(workspace) = workspace else { return failed(FailureCode::Invalid, "Give the workspace.") };
            pass(services, "workspace_security_settings", &WorkspaceSecuritySettingsArgs { viewer: viewer.clone(), workspace }).await
        }
        SecurityOp::UpdateWorkspaceSettings => {
            let Some(workspace) = workspace else { return failed(FailureCode::Invalid, "Give the workspace.") };
            let current: Outcome<WorkspaceSecurityView> =
                call(services, "workspace_security_settings", &WorkspaceSecuritySettingsArgs { viewer: viewer.clone(), workspace: workspace.clone() }).await?;
            let mut settings = match current {
                Outcome::Ok(view) => view.settings,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            };
            if let Some(on) = flag(input, "delegated_bypass") {
                settings.delegated_bypass = on;
            }
            if let Some(on) = flag(input, "validity_checks") {
                settings.validity_checks = on;
            }
            pass(services, "set_workspace_security_settings", &SetWorkspaceSecuritySettingsArgs { actor: actor(), workspace, settings }).await
        }
        SecurityOp::GetOverview => {
            let Some(workspace) = workspace else { return failed(FailureCode::Invalid, "Give the workspace.") };
            pass(services, "security_overview", &WorkspaceOverviewArgs { viewer: viewer.clone(), workspace, days: whole(input, "days") }).await
        }
    }
}

/// Limits the API checks before passing an upload on.
mod g1t_scan_limits {
    /// As the security service's: 10 MB gzipped and base64-encoded.
    pub const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_one_is_an_operation() {
        for op in SecurityOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::Security(op)), "{}", op.name());
        }
    }

    #[test]
    fn names_are_unique_and_found_again() {
        let mut names: Vec<&str> = SecurityOp::ALL.iter().map(|op| op.name()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), SecurityOp::ALL.len());
    }

    #[test]
    fn secret_filters_are_read_as_words() {
        let filters = secret_filters(&json!({ "state": "OPEN", "validity": "active", "bypassed": "true", "secret_type": "github_token" })).unwrap();
        assert_eq!(filters.state, Some(AlertState::Open));
        assert_eq!(filters.validity.as_deref(), Some("active"));
        assert_eq!(filters.bypassed, Some(true));
        assert!(secret_filters(&json!({ "validity": "maybe" })).unwrap_err().contains("validity is active, inactive"));
        assert!(secret_filters(&json!({ "bypassed": "perhaps" })).is_err());
        assert_eq!(secret_filters(&json!({})).unwrap(), SecretFilters::default());
    }

    #[test]
    fn a_state_change_needs_a_reason_its_kind_takes() {
        assert_eq!(state_change(&json!({ "state": "open" }), "reason", &SECRET_REASONS), Ok(None));
        assert_eq!(
            state_change(&json!({ "state": "dismissed", "reason": "revoked" }), "reason", &SECRET_REASONS),
            Ok(Some(DismissReason::Revoked))
        );
        assert!(state_change(&json!({ "state": "dismissed", "reason": "not_used" }), "reason", &SECRET_REASONS).unwrap_err().contains("reason is false_positive"));
        assert!(state_change(&json!({ "state": "dismissed" }), "dismissed_reason", &CODE_REASONS).unwrap_err().starts_with("Give dismissed_reason"));
        assert!(state_change(&json!({ "state": "fixed" }), "reason", &CODE_REASONS).is_err());
    }

    #[test]
    fn base_and_head_are_split_at_the_dots() {
        assert_eq!(base_head("main...feature/x"), Some(("main".into(), "feature/x".into())));
        assert_eq!(base_head("v1.0..v1.1"), Some(("v1.0".into(), "v1.1".into())));
        assert_eq!(base_head("main"), None);
        assert_eq!(base_head("...head"), None);
    }

    #[test]
    fn code_and_vulnerability_filters_check_their_words() {
        assert!(code_filters(&json!({ "severity": "severe" })).unwrap_err().contains("severity is critical"));
        let filters = vulnerability_filters(&json!({ "ecosystem": "npm", "state": "dismissed" })).unwrap();
        assert_eq!(filters.state, Some(AlertState::Dismissed));
    }

    #[test]
    fn a_read_only_token_sees_only_the_security_reads() {
        use g1t_contracts::scopes::{Scope, scope_for};
        for op in SecurityOp::ALL {
            let scope = scope_for(op.name()).unwrap_or_else(|| panic!("{} has no scope", op.name()));
            assert!(matches!(scope, Scope::SecurityRead | Scope::SecurityWrite), "{}", op.name());
        }
        assert_eq!(scope_for("get_sbom"), Some(Scope::SecurityRead));
        assert_eq!(scope_for("upload_sarif"), Some(Scope::SecurityWrite));
        // Fixing an alert also opens an issue and spends agent time.
        let needed = g1t_contracts::scopes::needed("fix_security_alert", &json!({}));
        assert_eq!(needed, [Scope::SecurityWrite, Scope::IssuesWrite, Scope::AgentsRun]);
        // No agent decides about security.
        for name in ["bypass_push_protection", "review_bypass_request", "update_security_settings", "fix_security_alert"] {
            assert!(g1t_contracts::credentials::NEVER.contains(&name), "{name}");
        }
    }

    #[test]
    fn workspace_wide_operations_do_not_need_a_repository() {
        for op in [SecurityOp::GetOverview, SecurityOp::ListBypassRequests, SecurityOp::ListCustomPatterns] {
            assert!(!op.needs_repo());
        }
        assert!(SecurityOp::UploadSarif.needs_repo());
        let required = SecurityOp::UploadSarif.input()["required"].clone();
        assert_eq!(required, json!(["repo", "commit_sha", "ref", "sarif"]));
    }
}
