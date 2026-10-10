//! The MCP server's tools: a few resource tools, each with an `action`.
//!
//! Every operation is one action of one tool. A call is dispatched to the
//! operation it names, so permissions, the audit log, billing and outcomes
//! are exactly those of the REST API. A token sees only the actions its
//! scopes allow, and a tool none of whose actions it may use is not listed.
//!
//! The listed input schema is one flat object: `action`, then every field
//! any of its actions takes. Which fields each action needs is in the
//! `action` field's description and checked on every call. Claude's API,
//! and so most MCP clients, refuse a tool whose input schema has `oneOf`
//! at its top level, so the schema keyed by action, with each action's
//! required fields, is [`discriminated`], published on the server's card
//! and in the docs.

use g1t_contracts::credentials::NEVER;
use g1t_contracts::identity::AgentScope;
use g1t_contracts::scopes::{Level, NO_SCOPE, TokenAccess, scope_for};
use serde_json::{Map, Value, json};

use crate::about::AboutOp;
use crate::run_artifacts::ArtifactsOp;
use crate::deploy_keys::DeployKeysOp;
use crate::mirrors::MirrorsOp;
use crate::deployments::DeploymentsOp;
use crate::packages::PackagesOp;
use crate::folios::FoliosOp;
use crate::protection::ProtectionOp;
use crate::token_policy::TokenOp;
use crate::operations::Op;
use crate::checks::ChecksOp;
use crate::rules::RulesOp;
use crate::security::SecurityOp;

pub struct Action {
    pub name: &'static str,
    pub op: Op,
    /// One line, for the `action` field's description.
    pub summary: &'static str,
}

pub struct Tool {
    pub name: &'static str,
    pub title: &'static str,
    /// What it is for, in a sentence or two.
    pub description: &'static str,
    pub actions: &'static [Action],
    /// The action a call without one runs.
    pub default_action: Option<&'static str>,
}

const fn a(name: &'static str, op: Op, summary: &'static str) -> Action {
    Action { name, op, summary }
}

pub const TOOLS: &[Tool] = &[
    Tool {
        name: "search",
        title: "Search",
        description: "Find things. `code` (the default) searches all of g1t you can see: repositories, code, issues, pull requests and people, with qualifiers like repo:owner/name, language:rust, is:issue. `context` searches one workspace's catalog, docs, issues and memory by meaning.",
        default_action: Some("code"),
        actions: &[
            a("code", Op::Search, "Search all of g1t: repositories, code, issues, pull requests, people"),
            a("context", Op::SearchContext, "Search a workspace's context hub by meaning"),
            a("entity", Op::GetEntity, "One catalog entry and its relations"),
            a("ticket", Op::GetContext, "A Jira, Linear or Sentry item the work refers to, as it is now"),
        ],
    },
    Tool {
        name: "repository",
        title: "Repositories",
        description: "Repositories: find, read and create them, change their settings and rulesets (what may happen to branches and tags, and what a pull request needs to merge), check their CODEOWNERS file, manage their labels and milestones, see and dismiss their security alerts (secrets and vulnerable dependencies), read what their default branch says (languages, contributors, license), star them, publish releases, and look after their mirroring (take a mirror over, hand it back, or move it to g1t for good). Name one as \"owner/name\". Deleting, transferring and changing visibility need `confirm`.",
        default_action: None,
        actions: &[
            a("list", Op::ListRepos, "Repositories you can see"),
            a("get", Op::GetRepo, "One repository"),
            a("create", Op::CreateRepo, "Create one, empty or copied from a public git URL"),
            a("update", Op::UpdateRepo, "Change description, website, topics, default branch, protection"),
            a("get_settings", Op::GetRepoSettings, "How pull requests merge, and the default branch's protection as its rules stack"),
            a("update_settings", Op::UpdateRepoSettings, "Change how pull requests merge and the default branch protection ruleset"),
            a("check_names", Op::ListCheckNames, "Check names reported lately, to require in a ruleset"),
            a("list_rulesets", Op::Rules(RulesOp::ListRepoRulesets), "Its rulesets, and its workspace's that hold in it"),
            a("get_ruleset", Op::Rules(RulesOp::GetRepoRuleset), "One ruleset"),
            a("create_ruleset", Op::Rules(RulesOp::CreateRepoRuleset), "Create a ruleset for its branches or tags"),
            a("update_ruleset", Op::Rules(RulesOp::UpdateRepoRuleset), "Change a ruleset"),
            a("delete_ruleset", Op::Rules(RulesOp::DeleteRepoRuleset), "Delete a ruleset"),
            a("branch_rules", Op::Rules(RulesOp::GetBranchRules), "Every rule that holds for a branch or tag, and where it comes from"),
            a("rule_evaluations", Op::Rules(RulesOp::ListRuleEvaluations), "How its rules judged pushes and merges, with insights"),
            a("codeowners", Op::GetCodeownersErrors, "Problems in its CODEOWNERS file, by line"),
            a("list_labels", Op::ListLabels, "Labels, with colors and how many issues and pull requests carry each"),
            a("create_label", Op::CreateLabel, "Create a label"),
            a("update_label", Op::UpdateLabel, "Rename a label or change its color or description"),
            a("delete_label", Op::DeleteLabel, "Delete a label, from everything that carries it"),
            a("add_default_labels", Op::AddDefaultLabels, "Add the default labels it is missing"),
            a("list_milestones", Op::ListMilestones, "Milestones, with progress and due dates"),
            a("get_milestone", Op::GetMilestone, "One milestone with its issues and pull requests"),
            a("create_milestone", Op::CreateMilestone, "Create a milestone"),
            a("update_milestone", Op::UpdateMilestone, "Change a milestone's title, description, due date or state"),
            a("delete_milestone", Op::DeleteMilestone, "Delete a milestone"),
            a("list_events", Op::ListEvents, "Timeline: pushes, issues, pull requests, comments"),
            a("languages", Op::About(AboutOp::GetLanguages), "Its languages by bytes, with colors and percentages"),
            a("contributors", Op::About(AboutOp::ListContributors), "Who made it: commits per person, agent and author, by week"),
            a("license", Op::About(AboutOp::GetLicense), "The license its LICENSE file holds"),
            a("stargazers", Op::About(AboutOp::ListStargazers), "Who starred it"),
            a("starred", Op::About(AboutOp::CheckStarred), "Whether you starred it, and how many have"),
            a("star", Op::About(AboutOp::Star), "Star it"),
            a("unstar", Op::About(AboutOp::Unstar), "Take your star back"),
            a("list_starred", Op::About(AboutOp::ListStarred), "Repositories you starred"),
            a("list_releases", Op::About(AboutOp::ListReleases), "Releases, newest first"),
            a("latest_release", Op::About(AboutOp::GetLatestRelease), "The latest release"),
            a("get_release", Op::About(AboutOp::GetRelease), "One release by id"),
            a("get_release_by_tag", Op::About(AboutOp::GetReleaseByTag), "The release of a tag"),
            a("create_release", Op::About(AboutOp::CreateRelease), "Publish a release of a tag, making the tag if needed"),
            a("update_release", Op::About(AboutOp::UpdateRelease), "Change a release's title, notes, draft or prerelease"),
            a("delete_release", Op::About(AboutOp::DeleteRelease), "Delete a release; its tag stays"),
            a("rename_branch", Op::RenameBranch, "Rename a branch"),
            a("rename", Op::RenameRepo, "Rename it; old addresses redirect"),
            a("transfer", Op::TransferRepo, "Move it to another workspace you own"),
            a("mirror", Op::Mirrors(MirrorsOp::GetMirror), "Its remotes: what it mirrors or is mirrored to"),
            a("mirror_hand_back_plan", Op::Mirrors(MirrorsOp::GetHandBackPlan), "What handing a takeover back would do, ref by ref"),
            a("mirror_take_over", Op::Mirrors(MirrorsOp::TakeOver), "Make g1t lead a mirror for now"),
            a("mirror_ci", Op::Mirrors(MirrorsOp::SetCiFailover), "Run a mirror's workflows on g1t (on), or stop (off)"),
            a("mirror_hand_back", Op::Mirrors(MirrorsOp::HandBack), "Send a takeover back, deciding diverged refs"),
            a("mirror_move_to_g1t", Op::Mirrors(MirrorsOp::MoveToG1t), "Stop tracking the remote; g1t leads for good"),
            a("mirror_sync", Op::Mirrors(MirrorsOp::SyncMirror), "Bring its remotes in step now"),
            a("mirror_add_remote", Op::Mirrors(MirrorsOp::AddRemote), "Link another g1t or git host"),
            a("mirror_update_remote", Op::Mirrors(MirrorsOp::UpdateRemote), "Change a remote's settings"),
            a("mirror_remove_remote", Op::Mirrors(MirrorsOp::RemoveRemote), "Unlink a remote"),
            a("archive", Op::ArchiveRepo, "Make it read-only"),
            a("unarchive", Op::UnarchiveRepo, "Make it writable again"),
            a("set_visibility", Op::SetRepoVisibility, "Make it public or private"),
            a("delete", Op::DeleteRepo, "Delete it; restorable for 30 days"),
            a("list_deleted", Op::ListDeletedRepos, "A workspace's deleted repositories"),
            a("restore", Op::RestoreRepo, "Restore a deleted one"),
            a("purge", Op::PurgeRepo, "Remove a deleted one for good"),
            a("security_alerts", Op::ListSecurityAlerts, "Secret and dependency alerts, filtered by state"),
            a("dismiss_alert", Op::DismissSecurityAlert, "Dismiss an alert with a reason"),
            a("reopen_alert", Op::ReopenSecurityAlert, "Reopen a dismissed alert"),
        ],
    },
    Tool {
        name: "issue",
        title: "Issues",
        description: "Issues: what should change. Read one before working on it to see the pull requests already made for it. Issues and pull requests share numbers; `comment` works on either.",
        default_action: None,
        actions: &[
            a("list", Op::ListIssues, "Issues on a repository, newest first"),
            a("get", Op::GetIssue, "One issue with comments and its pull requests"),
            a("create", Op::CreateIssue, "Open an issue"),
            a("update", Op::UpdateIssue, "Change title, body, labels, milestone or assignees"),
            a("labels", Op::ListIssueLabels, "The labels an issue or pull request carries"),
            a("add_labels", Op::AddIssueLabels, "Add labels to an issue or pull request"),
            a("set_labels", Op::SetIssueLabels, "Replace the labels of an issue or pull request"),
            a("remove_labels", Op::RemoveIssueLabels, "Take labels off an issue or pull request"),
            a("close", Op::CloseIssue, "Close it without a pull request"),
            a("reopen", Op::ReopenIssue, "Reopen it"),
            a("comment", Op::AddComment, "Comment on an issue or pull request; path and line for one line of a change"),
            a("edit_comment", Op::EditComment, "Change a comment's text: your own, or any with the Maintain role"),
            a("delete_comment", Op::DeleteComment, "Delete a comment: your own, or any with the Maintain role"),
            a("import", Op::ImportIssue, "Open an issue from a Jira, Linear or Sentry item"),
        ],
    },
    Tool {
        name: "pull_request",
        title: "Pull requests",
        description: "Pull requests: start a change for an issue, record your session, mark it ready, ask people and teams to review, review and merge. Read `overlaps` and `behind` on `get` before going far, and `code_owners` for whose approval it needs.",
        default_action: None,
        actions: &[
            a("list", Op::ListPullRequests, "Pull requests on a repository, newest first"),
            a("get", Op::GetPullRequest, "Status, checks and required checks, reviews, overlaps, whether it is behind"),
            a("changes", Op::GetPullRequestChanges, "Files and line-by-line diff"),
            a("create", Op::CreatePullRequest, "Start a draft with its own fork to push to, or open one from a pushed branch"),
            a("update", Op::UpdatePullRequest, "Change its base branch, labels, milestone, assignees or reviewers"),
            a("record_session", Op::RecordSession, "Append prompt, reasoning and tool entries to its session"),
            a("read_session", Op::ReadSession, "Its recorded session"),
            a("ready", Op::MarkPullRequestReady, "Mark a draft ready, with a summary"),
            a("draft", Op::ConvertPullRequestToDraft, "Turn it back into a draft"),
            a("request_reviewers", Op::RequestReviewers, "Ask people or teams to review it"),
            a("remove_requested_reviewers", Op::RemoveRequestedReviewers, "Stop asking people or teams to review it"),
            a("review", Op::ReviewPullRequest, "Approve or request changes"),
            a("close", Op::ClosePullRequest, "Close without merging"),
            a("reopen", Op::ReopenPullRequest, "Reopen a closed one"),
            a("merge", Op::MergePullRequest, "Land it, or join the merge queue"),
            a("merge_queue", Op::GetMergeQueue, "The repository's merge queue"),
        ],
    },
    Tool {
        name: "agent",
        title: "g1t agents",
        description: "Put g1t's agent to work and talk to it. One agent per issue; to do more at once, use more issues. Starting an agent uses the workspace's money.",
        default_action: None,
        actions: &[
            a("delegate", Op::Delegate, "Open an issue and put an agent on it in one step"),
            a("assign", Op::AssignIssue, "Put an agent on an existing issue"),
            a("message", Op::MessageAgent, "Tell the agent on a pull request something, or ask another agent"),
            a("answer", Op::AnswerMessage, "Answer a question or handoff sent to you"),
            a("take_messages", Op::TakeMessages, "For a g1t agent: messages not seen yet"),
        ],
    },
    Tool {
        name: "plan",
        title: "Plans",
        description: "Turn an outcome into issues: an agent proposes them with what done means and their dependencies; nothing opens until you apply the plan.",
        default_action: None,
        actions: &[
            a("create", Op::PlanWork, "Ask an agent for a plan; read it with get until ready"),
            a("get", Op::GetPlan, "A plan and the issues it proposes"),
            a("apply", Op::ApplyPlan, "Open its issues; with assign, agents start in dependency order"),
        ],
    },
    Tool {
        name: "memory",
        title: "Memory",
        description: "What the project and its workspace remember for the next agent: how to build, conventions, decisions, traps. Recall before you start; remember one short fact at a time, never a secret.",
        default_action: None,
        actions: &[
            a("recall", Op::Recall, "Search memory, or list it all"),
            a("remember", Op::Remember, "Save one fact"),
        ],
    },
    Tool {
        name: "workflow",
        title: "Workflows",
        description: "GitHub Actions workflows from .g1t/workflows: their runs, jobs and logs, and running, cancelling or rerunning them. Runs' artifacts: listing, a download link, deleting, and how long they are kept. Deployments wherever they run (reported from any CI, made by jobs with an `environment:`, or built on g1t.page), their statuses and environments, and reporting your own; environments' protection rules, approving or rejecting the jobs they hold, approving a pull request's run from outside, the token's default permissions and repository dispatch. Checks on commits: statuses, check runs (a g1t Actions job is one) and check suites, to read where a commit stands or report on it from CI or an integration. Also the self-hosted runners they run on: a workspace's (`workspace`) or a repository's own (`repo`), their groups, and where agent work runs.",
        default_action: None,
        actions: &[
            a("list", Op::ListWorkflows, "Workflows on the default branch"),
            a("list_runs", Op::ListWorkflowRuns, "Runs, newest first"),
            a("get_run", Op::GetWorkflowRun, "One run with its jobs and steps; an earlier attempt with attempt"),
            a("job_logs", Op::GetJobLogs, "A job's log after a sequence number"),
            a("dispatch", Op::DispatchWorkflow, "Run a workflow_dispatch workflow"),
            a("cancel", Op::CancelWorkflowRun, "Cancel a run, letting its jobs clean up; force stops them outright"),
            a("rerun", Op::RerunWorkflowRun, "Run a finished run again: all, failed_only, or one job; debug for debug logging"),
            a("update", Op::UpdateWorkflow, "Turn a workflow on or off"),
            a("list_artifacts", Op::Artifacts(ArtifactsOp::ListArtifacts), "A repository's artifacts, newest first; or a run's with run_artifacts"),
            a("run_artifacts", Op::Artifacts(ArtifactsOp::ListRunArtifacts), "One run's artifacts"),
            a("get_artifact", Op::Artifacts(ArtifactsOp::GetArtifact), "One artifact: size, digest, expiry, run"),
            a("download_artifact", Op::Artifacts(ArtifactsOp::DownloadArtifact), "A 10-minute link to an artifact's zip"),
            a("delete_artifact", Op::Artifacts(ArtifactsOp::DeleteArtifact), "Delete an artifact before it expires"),
            a("artifact_retention", Op::Artifacts(ArtifactsOp::GetArtifactRetention), "Days the repository keeps artifacts"),
            a("set_artifact_retention", Op::Artifacts(ArtifactsOp::SetArtifactRetention), "Change the days the repository keeps artifacts"),
            a("combined_status", Op::Checks(ChecksOp::GetCombinedStatus), "A commit's statuses and the state they add up to"),
            a("list_statuses", Op::Checks(ChecksOp::ListCommitStatuses), "A commit's statuses, newest first"),
            a("set_status", Op::Checks(ChecksOp::CreateCommitStatus), "Set a status on a commit"),
            a("list_check_runs", Op::Checks(ChecksOp::ListCheckRunsForRef), "A commit's check runs, g1t Actions jobs included"),
            a("get_check_run", Op::Checks(ChecksOp::GetCheckRun), "One check run with its report"),
            a("check_run_annotations", Op::Checks(ChecksOp::ListCheckRunAnnotations), "What a check run says about lines of files"),
            a("create_check_run", Op::Checks(ChecksOp::CreateCheckRun), "Report a check run on a commit"),
            a("update_check_run", Op::Checks(ChecksOp::UpdateCheckRun), "Move a check run on, complete it, add annotations"),
            a("rerequest_check_run", Op::Checks(ChecksOp::RerequestCheckRun), "Ask for a check run to run again"),
            a("list_check_suites", Op::Checks(ChecksOp::ListCheckSuitesForRef), "A commit's check suites, one per reporter or workflow run"),
            a("get_check_suite", Op::Checks(ChecksOp::GetCheckSuite), "One check suite"),
            a("rerequest_check_suite", Op::Checks(ChecksOp::RerequestCheckSuite), "Ask for a check suite to run again"),
            a("list_deployments", Op::Deployments(DeploymentsOp::ListDeployments), "Deployments wherever they run, newest first, filtered"),
            a("get_deployment", Op::Deployments(DeploymentsOp::GetDeployment), "One deployment with every status it has had"),
            a("create_deployment", Op::Deployments(DeploymentsOp::CreateDeployment), "Report a deployment of a ref to an environment"),
            a("deployment_statuses", Op::Deployments(DeploymentsOp::ListDeploymentStatuses), "A deployment's statuses, newest first"),
            a("create_deployment_status", Op::Deployments(DeploymentsOp::CreateDeploymentStatus), "Report where a deployment is: in_progress, success, failure"),
            a("list_environments", Op::Deployments(DeploymentsOp::ListEnvironments), "Environments with their current and latest deployments"),
            a("get_environment", Op::Deployments(DeploymentsOp::GetEnvironment), "One environment by name, with its protection rules"),
            a("update_environment", Op::Protection(ProtectionOp::UpdateEnvironment), "Set an environment's reviewers, wait timer and branches"),
            a("delete_environment", Op::Protection(ProtectionOp::DeleteEnvironment), "Remove an environment's protection rules"),
            a("pending_deployments", Op::Protection(ProtectionOp::GetPendingDeployments), "The environments holding a run's jobs"),
            a("review_deployments", Op::Protection(ProtectionOp::ReviewPendingDeployments), "Approve or reject a run's jobs for its environments"),
            a("approve_run", Op::Protection(ProtectionOp::ApproveWorkflowRun), "Let a run of a pull request from outside start"),
            a("get_permissions", Op::Protection(ProtectionOp::GetWorkflowPermissions), "What a job's token gets without `permissions:`"),
            a("set_permissions", Op::Protection(ProtectionOp::SetWorkflowPermissions), "Set it: read or write"),
            a("get_approval_policy", Op::Protection(ProtectionOp::GetForkPrApproval), "Which pull requests' runs wait for approval"),
            a("set_approval_policy", Op::Protection(ProtectionOp::SetForkPrApproval), "Set which pull requests' runs wait for approval"),
            a("get_access", Op::Protection(ProtectionOp::GetActionsAccess), "Which repositories may use this one's actions and workflows"),
            a("set_access", Op::Protection(ProtectionOp::SetActionsAccess), "Let the workspace's private repositories use them, or not"),
            a("repository_dispatch", Op::Protection(ProtectionOp::CreateRepositoryDispatch), "Start repository_dispatch workflows with an event"),
            a("get_workspace_permissions", Op::Protection(ProtectionOp::GetWorkspaceWorkflowPermissions), "A workspace's default and maximum token permissions"),
            a("set_workspace_permissions", Op::Protection(ProtectionOp::SetWorkspaceWorkflowPermissions), "Set them, and whether jobs may open pull requests"),
            a("list_runners", Op::ListRunners, "Self-hosted runners, with status, labels and what each is doing"),
            a("create_runner_token", Op::CreateRunnerRegistrationToken, "A one-hour token for g1t-runner register"),
            a("remove_runner", Op::RemoveRunner, "Remove a self-hosted runner"),
            a("list_runner_groups", Op::ListRunnerGroups, "A workspace's runner groups"),
            a("create_runner_group", Op::CreateRunnerGroup, "Make a group, for some repositories"),
            a("update_runner_group", Op::UpdateRunnerGroup, "Rename a group or change its repositories"),
            a("delete_runner_group", Op::DeleteRunnerGroup, "Delete a group; its runners join the default"),
            a("get_runner_settings", Op::GetRunnerSettings, "Where agent work runs; whether forks may use runners"),
            a("update_runner_settings", Op::UpdateRunnerSettings, "Change them"),
        ],
    },
    Tool {
        name: "package",
        title: "Packages",
        description: "A workspace's packages in every registry (container images, npm, Cargo, Maven, NuGet, RubyGems, Composer): their versions and downloads, deleting and restoring them within 30 days, their visibility and repository, who has a role on them, and which repositories' workflows may use them (Manage Actions access). Name one by workspace, package_type and package_name.",
        default_action: None,
        actions: &[
            a("list", Op::Packages(PackagesOp::ListPackages), "A workspace's packages; state deleted for restorable ones"),
            a("get", Op::Packages(PackagesOp::GetPackage), "One package: address, visibility, repository, downloads"),
            a("versions", Op::Packages(PackagesOp::ListVersions), "Its versions with tags and downloads; state deleted too"),
            a("get_version", Op::Packages(PackagesOp::GetVersion), "One version by id, version, digest or tag"),
            a("update", Op::Packages(PackagesOp::UpdatePackage), "Set visibility, or inherit_access for a linked one"),
            a("link", Op::Packages(PackagesOp::LinkPackage), "Link it to a repository of its workspace"),
            a("unlink", Op::Packages(PackagesOp::UnlinkPackage), "Unlink it: the workspace's, private"),
            a("access", Op::Packages(PackagesOp::ListAccess), "People and teams with a role on it"),
            a("set_access", Op::Packages(PackagesOp::SetAccess), "Give a person or team read, write or admin"),
            a("remove_access", Op::Packages(PackagesOp::RemoveAccess), "Take a person's or team's role away"),
            a("actions_access", Op::Packages(PackagesOp::ListActionsAccess), "Repositories whose workflows may use it"),
            a("set_actions_access", Op::Packages(PackagesOp::SetActionsAccess), "Let a repository's workflows read or write it"),
            a("remove_actions_access", Op::Packages(PackagesOp::RemoveActionsAccess), "Stop a repository's workflows using it"),
            a("delete", Op::Packages(PackagesOp::DeletePackage), "Delete it; restorable for 30 days"),
            a("restore", Op::Packages(PackagesOp::RestorePackage), "Restore a deleted package"),
            a("delete_version", Op::Packages(PackagesOp::DeleteVersion), "Delete a version; restorable for 30 days"),
            a("restore_version", Op::Packages(PackagesOp::RestoreVersion), "Restore a deleted version"),
        ],
    },
    Tool {
        name: "secret",
        title: "Secrets and variables",
        description: "A repository's or workspace's secrets and variables, read by workflows and deployments. Secret values are never returned.",
        default_action: None,
        actions: &[
            a("list_secrets", Op::ListActionsSecrets, "Secrets, without values"),
            a("set_secret", Op::SetActionsSecret, "Add or change a secret"),
            a("delete_secret", Op::DeleteActionsSecret, "Remove a secret"),
            a("list_variables", Op::ListActionsVariables, "Variables, with values"),
            a("set_variable", Op::SetActionsVariable, "Add or change a variable"),
            a("delete_variable", Op::DeleteActionsVariable, "Remove a variable"),
        ],
    },
    Tool {
        name: "webhook",
        title: "Webhooks",
        description: "HTTPS addresses sent signed events as they happen, for a repository or a whole workspace.",
        default_action: None,
        actions: &[
            a("list", Op::ListWebhooks, "Webhooks, without secrets"),
            a("create", Op::CreateWebhook, "Register one; a ping is sent"),
            a("update", Op::UpdateWebhook, "Change address, events or active"),
            a("delete", Op::DeleteWebhook, "Remove one"),
            a("ping", Op::PingWebhook, "Send a ping"),
            a("list_deliveries", Op::ListWebhookDeliveries, "Latest deliveries"),
            a("redeliver", Op::RedeliverWebhook, "Send a delivery again"),
        ],
    },
    Tool {
        name: "access",
        title: "Who has access",
        description: "Who has access to a repository and with which role (read, triage, write, maintain, admin), outside collaborators, a workspace's base permission, and a repository's deploy keys.",
        default_action: None,
        actions: &[
            a("list_collaborators", Op::ListCollaborators, "Everyone with a role, and pending invitations"),
            a("get_permission", Op::GetCollaboratorPermission, "One person's role and capabilities"),
            a("add_collaborator", Op::AddCollaborator, "Give someone a role, by username or email"),
            a("update_collaborator", Op::UpdateCollaborator, "Change a direct role"),
            a("remove_collaborator", Op::RemoveCollaborator, "Take away a direct role"),
            a("list_invitations", Op::ListRepoInvitations, "Pending invitations to a repository"),
            a("revoke_invitation", Op::RevokeRepoInvitation, "Withdraw one"),
            a("set_base_permission", Op::SetBasePermission, "What every member gets on each repository"),
            a("list_outside_collaborators", Op::ListOutsideCollaborators, "People with roles who are not members"),
            a("list_deploy_keys", Op::DeployKeys(DeployKeysOp::ListDeployKeys), "SSH keys that reach this one repository"),
            a("get_deploy_key", Op::DeployKeys(DeployKeysOp::GetDeployKey), "One deploy key, by id"),
            a("add_deploy_key", Op::DeployKeys(DeployKeysOp::CreateDeployKey), "Add one; read-only unless read_only is false"),
            a("remove_deploy_key", Op::DeployKeys(DeployKeysOp::DeleteDeployKey), "Delete one"),
        ],
    },
    Tool {
        name: "team",
        title: "Teams",
        description: "Teams: groups of a workspace's members, given roles on repositories together, mentioned as @workspace/team and asked to review together. Name one by `workspace` and its slug (`team`). Any member may create a team; the workspace's owners and the team's maintainers manage it. A secret team is seen only by its people and the owners.",
        default_action: None,
        actions: &[
            a("list", Op::ListTeams, "A workspace's teams you can see"),
            a("get", Op::GetTeam, "One team"),
            a("create", Op::CreateTeam, "Create a team; you become its maintainer"),
            a("update", Op::UpdateTeam, "Change its name, slug, description, visibility, parent or notifications"),
            a("delete", Op::DeleteTeam, "Delete it; its child teams move up"),
            a("list_members", Op::ListTeamMembers, "Its people and their roles, child teams' with include_child_teams"),
            a("set_member", Op::SetTeamMember, "Add a member of the workspace, or change their role"),
            a("remove_member", Op::RemoveTeamMember, "Take someone out of it"),
            a("list_child_teams", Op::ListChildTeams, "The teams nested under it"),
            a("list_repos", Op::ListTeamRepos, "The repositories it has a role on"),
            a("set_repo", Op::SetTeamRepo, "Give it a role on a repository"),
            a("remove_repo", Op::RemoveTeamRepo, "Take its role on a repository away"),
            a("set_review_assignment", Op::SetTeamReviewAssignment, "Whom it picks when asked to review"),
            a("list_user_teams", Op::ListUserTeams, "The teams someone is in"),
        ],
    },
    Tool {
        name: "workspace",
        title: "Workspaces",
        description: "Workspaces own repositories (g1t.sh/{workspace}/{repo}): create, update or delete one, invite members, connect integrations and model providers, set rulesets that hold across its repositories, read and change its projects (what each is, where it runs, its links), and keep your own pinned projects at the top of its sidebar.",
        default_action: None,
        actions: &[
            a("get", Op::GetWorkspace, "A workspace's details and settings"),
            a("create", Op::CreateWorkspace, "Create a workspace"),
            a("delete", Op::DeleteWorkspace, "Delete a workspace and everything in it (support can restore it for 30 days)"),
            a("update", Op::UpdateWorkspace, "Change its name, description, base permission, who may create teams, member privileges or the two-factor requirement"),
            a("list_members", Op::ListMembers, "Its members, owners first, with their roles"),
            a("update_member", Op::UpdateMember, "Make someone an owner or a member, billing manager or security manager"),
            a("remove_member", Op::RemoveMember, "Remove someone from it"),
            a("transfer_ownership", Op::TransferOwnership, "Hand it to another member: they become an owner, you a member"),
            a("leave", Op::LeaveWorkspace, "Leave it yourself"),
            a("list_invites", Op::ListWorkspaceInvites, "Its invites"),
            a("invite_member", Op::InviteMember, "Invite someone by username or email address"),
            a("revoke_invite", Op::RevokeWorkspaceInvite, "Revoke a pending invite"),
            a("list_integrations", Op::ListIntegrations, "Model providers, alert sources, trackers"),
            a("connect_integration", Op::ConnectIntegration, "Connect one"),
            a("update_integration", Op::UpdateIntegration, "Change one: rotate its key, choose its AI Gateway models"),
            a("disconnect_integration", Op::DisconnectIntegration, "Remove one"),
            a("test_integration", Op::TestIntegration, "Check its credentials"),
            a("get_model_routes", Op::GetModelRoutes, "Where each kind of work's model requests go"),
            a("set_model_routes", Op::SetModelRoutes, "Replace them"),
            a("list_projects", Op::ListProjects, "Its projects you can see: what each is, where it runs, its links"),
            a("get_project", Op::GetProject, "One project"),
            a("update_project", Op::UpdateProject, "Change a project's name, description, kind, where it runs or its links"),
            a("list_pinned_projects", Op::ListPinnedProjects, "Your pinned projects in it, in your order"),
            a("pin_project", Op::PinProject, "Pin a project, at a position or the end"),
            a("unpin_project", Op::UnpinProject, "Unpin a project"),
            a("reorder_pinned_projects", Op::ReorderPinnedProjects, "Put your pins in a new order"),
            a("list_rulesets", Op::Rules(RulesOp::ListWorkspaceRulesets), "Its rulesets, which hold across its repositories"),
            a("get_ruleset", Op::Rules(RulesOp::GetWorkspaceRuleset), "One of its rulesets"),
            a("create_ruleset", Op::Rules(RulesOp::CreateWorkspaceRuleset), "Create a ruleset for some or all of its repositories"),
            a("update_ruleset", Op::Rules(RulesOp::UpdateWorkspaceRuleset), "Change one of its rulesets"),
            a("delete_ruleset", Op::Rules(RulesOp::DeleteWorkspaceRuleset), "Delete one of its rulesets"),
            a("rule_evaluations", Op::Rules(RulesOp::ListWorkspaceRuleEvaluations), "How rules judged changes across its repositories"),
            a("get_token_policy", Op::Tokens(TokenOp::GetTokenPolicy), "Its rules for personal access tokens"),
            a("set_token_policy", Op::Tokens(TokenOp::SetTokenPolicy), "Change them: which tokens reach it, approval, lifetime"),
            a("list_member_tokens", Op::Tokens(TokenOp::ListMemberTokens), "Members' personal access tokens that reach it"),
            a("list_token_requests", Op::Tokens(TokenOp::ListTokenRequests), "Tokens waiting for approval"),
            a("review_token_request", Op::Tokens(TokenOp::ReviewTokenRequest), "Approve or deny one"),
            a("revoke_member_token", Op::Tokens(TokenOp::RevokeMemberToken), "Revoke a member's token in it"),
        ],
    },
    Tool {
        name: "billing",
        title: "Billing",
        description: "A workspace's billing: its usage by product, project and day, its budget (the monthly spend limit, alerts and whether usage pauses at it), its AI credit, its invoices, and its AI Gateway requests. Amounts are whole millionths of a dollar (`_micros`), or cents (`_cents`) where named. Members read it; changing the budget and buying credit are for owners, as people, and never for g1t's agents.",
        default_action: Some("usage"),
        actions: &[
            a("usage", Op::GetUsage, "Usage over a range of days, by product, meter, project and day, and what paid for it"),
            a("budget", Op::GetBudget, "The monthly spend limit, what was spent, alerts and whether usage pauses at the limit"),
            a("set_budget", Op::SetBudget, "Change the spend limit, alerts, pausing or the alert webhook"),
            a("ai_credit", Op::GetAiCredit, "AI credit left, its grants, auto-reload and how to buy more"),
            a("buy_ai_credit", Op::BuyAiCredit, "A payment page to buy AI credit, for a person to open"),
            a("invoices", Op::ListInvoices, "Every invoice, the itemised usage invoices, and the next one so far"),
            a("billing_details", Op::GetBillingDetails, "Who invoices are made out to and the payment method on file"),
            a("gateway_requests", Op::ListGatewayRequests, "Recent AI Gateway requests: model, tokens, cost, status and token"),
        ],
    },
    Tool {
        name: "security",
        title: "Security",
        description: "A repository's security: secret scanning alerts and push protection bypasses, custom secret patterns, code scanning alerts and SARIF uploads, vulnerability alerts, the dependency graph and its SBOM, dependency review, settings, and a workspace's overview. Fix an alert with g1t. Findings are shown to those who can change the code only. Give `repo` (owner/name), or `workspace` for lists across one.",
        default_action: Some("secret_alerts"),
        actions: &[
            a("secret_alerts", Op::Security(SecurityOp::ListSecretAlerts), "Secret scanning alerts; by state, secret_type, validity, bypassed"),
            a("secret_alert", Op::Security(SecurityOp::GetSecretAlert), "One secret alert, with where it was found and its bypass requests"),
            a("update_secret_alert", Op::Security(SecurityOp::UpdateSecretAlert), "Dismiss a secret alert with a reason, or reopen it"),
            a("secret_locations", Op::Security(SecurityOp::ListSecretLocations), "Every file, line and commit a secret is in"),
            a("bypass", Op::Security(SecurityOp::BypassPushProtection), "Push past push protection with a reason, or ask to"),
            a("check_validity", Op::Security(SecurityOp::CheckSecretValidity), "Ask a secret's issuer whether it still works"),
            a("bypass_requests", Op::Security(SecurityOp::ListBypassRequests), "A workspace's push protection bypass requests"),
            a("review_bypass", Op::Security(SecurityOp::ReviewBypassRequest), "Approve, deny or cancel a bypass request"),
            a("patterns", Op::Security(SecurityOp::ListCustomPatterns), "Custom secret patterns of a repository or workspace"),
            a("create_pattern", Op::Security(SecurityOp::CreateCustomPattern), "Create a custom secret pattern, as a draft or published"),
            a("update_pattern", Op::Security(SecurityOp::UpdateCustomPattern), "Change, publish or unpublish a custom pattern"),
            a("delete_pattern", Op::Security(SecurityOp::DeleteCustomPattern), "Delete a custom pattern"),
            a("dry_run_pattern", Op::Security(SecurityOp::DryRunCustomPattern), "Run a pattern over the default branch without saving it"),
            a("code_alerts", Op::Security(SecurityOp::ListCodeAlerts), "Code scanning alerts; by state, severity, tool, rule_id"),
            a("code_alert", Op::Security(SecurityOp::GetCodeAlert), "One code scanning alert by number"),
            a("update_code_alert", Op::Security(SecurityOp::UpdateCodeAlert), "Dismiss a code scanning alert with a reason, or reopen it"),
            a("analyses", Op::Security(SecurityOp::ListAnalyses), "Code scanning analyses, newest first"),
            a("upload_sarif", Op::Security(SecurityOp::UploadSarif), "Upload a SARIF file, gzipped and base64-encoded"),
            a("sarif_upload", Op::Security(SecurityOp::GetSarifUpload), "Whether a SARIF upload was read, and its analyses"),
            a("vulnerability_alerts", Op::Security(SecurityOp::ListVulnerabilityAlerts), "Vulnerable dependencies; by state, severity, ecosystem, package"),
            a("vulnerability_alert", Op::Security(SecurityOp::GetVulnerabilityAlert), "One vulnerability alert"),
            a("update_vulnerability_alert", Op::Security(SecurityOp::UpdateVulnerabilityAlert), "Dismiss a vulnerability alert with a reason, or reopen it"),
            a("fix", Op::Security(SecurityOp::FixAlert), "Put g1t on an issue to fix an alert"),
            a("dependency_graph", Op::Security(SecurityOp::GetDependencyGraph), "Every package the lockfiles resolve, direct or transitive"),
            a("sbom", Op::Security(SecurityOp::GetSbom), "The dependency graph as an SPDX 2.3 document"),
            a("compare_dependencies", Op::Security(SecurityOp::CompareDependencies), "What changes in dependencies between base...head"),
            a("settings", Op::Security(SecurityOp::GetSettings), "A repository's security settings"),
            a("update_settings", Op::Security(SecurityOp::UpdateSettings), "Change when checks fail and dependency review's policy"),
            a("workspace_settings", Op::Security(SecurityOp::GetWorkspaceSettings), "A workspace's delegated bypass and validity checks"),
            a("update_workspace_settings", Op::Security(SecurityOp::UpdateWorkspaceSettings), "Turn delegated bypass or validity checks on or off"),
            a("overview", Op::Security(SecurityOp::GetOverview), "A workspace's alerts, trends and coverage"),
        ],
    },
    Tool {
        name: "notifications",
        title: "Notifications",
        description: "Your inbox: what needs you, and what you follow. One thread per issue, pull request, workflow or deployment, with why you were told (`reason`): an agent waiting on you, a review asked of you, an assignment, a mention, your work's checks, or what you subscribe to and watch. Mark threads read or done once handled, and choose what you hear of with subscribe, unsubscribe and watch. Your own: a personal token.",
        default_action: Some("list"),
        actions: &[
            a("list", Op::ListNotifications, "Unread threads, latest first; all, a view, a reason, a repository"),
            a("get", Op::GetNotificationThread, "One thread with its recent activity and your subscription"),
            a("mark_read", Op::MarkThreadRead, "Mark a thread read, or unread"),
            a("mark_all_read", Op::MarkNotificationsRead, "Mark everything read up to a time, or one repository's"),
            a("done", Op::MarkThreadDone, "Mark a thread done; new activity brings it back"),
            a("save", Op::SaveThread, "Save a thread, or unsave it"),
            a("snooze", Op::SnoozeThread, "Snooze a thread until a time, or bring it back"),
            a("subscription", Op::GetThreadSubscription, "Your subscription to an issue or pull request"),
            a("subscribe", Op::SetThreadSubscription, "Subscribe to an issue or pull request, or ignore it"),
            a("unsubscribe", Op::DeleteThreadSubscription, "Unsubscribe until you comment or are mentioned"),
            a("watching", Op::GetRepoSubscription, "How you watch a repository"),
            a("watch", Op::SetRepoSubscription, "Watch a repository: participating, all, ignore or custom"),
            a("unwatch", Op::DeleteRepoSubscription, "Stop watching a repository"),
            a("watched", Op::ListWatchedRepos, "Repositories you watch other than the default way"),
        ],
    },
    Tool {
        name: "account",
        title: "Your account",
        description: "Who this token acts as and its workspaces (`whoami`), your email addresses, your invites, and invitations to workspaces and repositories waiting for you.",
        default_action: Some("whoami"),
        actions: &[
            a("whoami", Op::Whoami, "Who the token acts as, and its workspaces"),
            a("list_emails", Op::ListEmails, "Your addresses"),
            a("add_email", Op::AddEmail, "Add an address"),
            a("confirm_email", Op::ConfirmEmail, "Confirm an address with the code from its email"),
            a("remove_email", Op::RemoveEmail, "Remove an address"),
            a("update_email_settings", Op::UpdateEmailSettings, "Primary, backup and privacy"),
            a("list_invites", Op::ListInvites, "Your invites to g1t"),
            a("create_invite", Op::CreateInvite, "Make an invite"),
            a("revoke_invite", Op::RevokeInvite, "Revoke one"),
            a("list_workspace_invitations", Op::ListInvitations, "Invitations to workspaces for you"),
            a("accept_workspace_invitation", Op::AcceptInvitation, "Accept one and join"),
            a("decline_workspace_invitation", Op::DeclineInvitation, "Decline one"),
            a("list_repository_invitations", Op::ListMyRepoInvitations, "Invitations to repositories for you"),
            a("accept_repository_invitation", Op::AcceptRepoInvitation, "Accept one"),
            a("decline_repository_invitation", Op::DeclineRepoInvitation, "Decline one"),
        ],
    },
    Tool {
        name: "artifact",
        title: "Artifacts",
        description: "A workspace's docs, slides, designs and dashboards (Artifacts mode), as you can open them: list, search and read them (a doc's content is Markdown, with block ids to target), make them, edit them (a change with the edit role, a suggestion with comment), move, trash and restore them, their versions, and who can open them. Name one by its id (fol_…) or its address. Not the `workflow` tool's run artifacts. Slides, designs and dashboards answer that they are not here yet.",
        default_action: None,
        actions: &[
            a("list", Op::Folios(FoliosOp::List), "Artifacts you can open; tab, kind, space, q; state trashed for the trash"),
            a("search", Op::Folios(FoliosOp::Search), "Search them by words and meaning, with the passage that matched"),
            a("get", Op::Folios(FoliosOp::Get), "One artifact: kind, title, space, owner, your role, who it is shared with"),
            a("read", Op::Folios(FoliosOp::GetContent), "Its content: a doc's Markdown and block ids, and what you may do"),
            a("versions", Op::Folios(FoliosOp::ListVersions), "Its saved versions, newest first"),
            a("access", Op::Folios(FoliosOp::GetAccess), "Who can open it, and how"),
            a("templates", Op::Folios(FoliosOp::ListTemplates), "Templates to start one from"),
            a("spaces", Op::Folios(FoliosOp::ListSpaces), "The spaces in your sidebar"),
            a("query_data", Op::Folios(FoliosOp::QueryDataset), "Run a dataset query as you, over what you can read"),
            a("create", Op::Folios(FoliosOp::Create), "Make one: in a space, under a doc, or in your Private"),
            a("update", Op::Folios(FoliosOp::Update), "Rename it, change its icon, or move it"),
            a("edit", Op::Folios(FoliosOp::Edit), "Change its content: append, replace it all, a section or blocks"),
            a("trash", Op::Folios(FoliosOp::Trash), "Move it to the trash; restorable for 30 days"),
            a("restore", Op::Folios(FoliosOp::Restore), "Bring it back from the trash"),
            a("restore_version", Op::Folios(FoliosOp::RestoreVersion), "Make an earlier version its content again"),
            a("share", Op::Folios(FoliosOp::SetAccess), "Share it, change general access, or take access away"),
            a("purge", Op::Folios(FoliosOp::Purge), "Delete one in the trash for good"),
        ],
    },
];

/// Operations that cannot be undone, or reach beyond g1t's own records:
/// clients ask before running a tool that has any of them.
fn destructive(op: Op) -> bool {
    matches!(
        op,
        Op::Security(SecurityOp::DeleteCustomPattern | SecurityOp::BypassPushProtection)
            | Op::Rules(RulesOp::DeleteRepoRuleset | RulesOp::DeleteWorkspaceRuleset)
            | Op::DeleteWorkspace
            | Op::UpdateWorkspace
            | Op::Tokens(TokenOp::RevokeMemberToken | TokenOp::SetTokenPolicy)
            | Op::RemoveMember
            | Op::TransferOwnership
            | Op::LeaveWorkspace
            | Op::DeleteRepo
            | Op::PurgeRepo
            | Op::TransferRepo
            | Op::SetRepoVisibility
            | Op::RemoveEmail
            | Op::RemoveCollaborator
            | Op::DisconnectIntegration
            | Op::UpdateIntegration
            | Op::DeleteWebhook
            | Op::DeleteActionsSecret
            | Op::DeleteActionsVariable
            | Op::SetActionsSecret
            | Op::SetActionsVariable
            | Op::SetModelRoutes
            | Op::SetBasePermission
            | Op::DeleteTeam
            | Op::RemoveTeamRepo
            | Op::MergePullRequest
            | Op::RemoveRunner
            | Op::DeleteRunnerGroup
            | Op::UpdateRunnerSettings
            | Op::Folios(FoliosOp::SetAccess | FoliosOp::Purge)
    )
}

/// Whether an operation only reads.
pub fn reads_only(op: Op) -> bool {
    NO_SCOPE.contains(&op.name())
        || scope_for(op.name()).is_some_and(|scope| scope.level() == Level::Read)
}

/// What decides which actions a caller sees.
pub enum Gate<'a> {
    /// No limit beyond the person's own role.
    Everything,
    /// A g1t agent's token: the operations its run lists.
    Agent(&'a AgentScope),
    /// An access token with scopes.
    Token(&'a TokenAccess),
}

impl Gate<'_> {
    pub fn allows(&self, op: Op) -> bool {
        match self {
            Gate::Everything => true,
            Gate::Agent(scope) => op.allowed_by(scope) && !NEVER.contains(&op.name()),
            Gate::Token(access) => {
                if NO_SCOPE.contains(&op.name()) {
                    return true;
                }
                match scope_for(op.name()) {
                    Some(scope) => access.allows(scope),
                    None => access.scopes.is_none(),
                }
            }
        }
    }
}

impl Tool {
    pub fn by_name(name: &str) -> Option<&'static Tool> {
        TOOLS.iter().find(|tool| tool.name == name)
    }

    pub fn action(&self, name: &str) -> Option<&'static Action> {
        // The tools are 'static; find through TOOLS to keep the lifetime.
        TOOLS
            .iter()
            .find(|tool| tool.name == self.name)
            .and_then(|tool| tool.actions.iter().find(|action| action.name == name))
    }

    pub fn visible(&self, gate: &Gate) -> Vec<&'static Action> {
        TOOLS
            .iter()
            .find(|tool| tool.name == self.name)
            .map(|tool| tool.actions.iter().filter(|action| gate.allows(action.op)).collect())
            .unwrap_or_default()
    }

    /// The flat input schema of the actions given.
    pub fn input_schema(&self, actions: &[&Action]) -> Value {
        let mut properties = Map::new();
        let lines: Vec<String> = actions
            .iter()
            .map(|action| {
                let required: Vec<String> = action.op.required();
                if required.is_empty() {
                    format!("{}: {}.", action.name, action.summary)
                } else {
                    format!("{} ({}): {}.", action.name, required.join(", "), action.summary)
                }
            })
            .collect();
        let mut action_schema = json!({
            "type": "string",
            "enum": actions.iter().map(|action| action.name).collect::<Vec<_>>(),
            "description": lines.join("\n"),
        });
        if let Some(default) = self.default_action.filter(|name| actions.iter().any(|action| action.name == *name)) {
            action_schema["default"] = json!(default);
        }
        properties.insert("action".to_owned(), action_schema);
        for action in actions {
            for (name, schema) in action.op.properties() {
                merge_property(&mut properties, name, schema);
            }
        }
        let mut required = vec![];
        if self.default_action.is_none() {
            required.push("action");
        }
        let mut schema = json!({ "type": "object", "properties": properties });
        if !required.is_empty() {
            schema["required"] = json!(required);
        }
        schema
    }

    /// The input schema keyed by action: one `oneOf` branch per action,
    /// each with its own fields and the ones it needs.
    pub fn discriminated(&self, actions: &[&Action]) -> Value {
        let branches: Vec<Value> = actions
            .iter()
            .map(|action| {
                let mut properties = Map::new();
                properties.insert("action".to_owned(), json!({ "const": action.name }));
                properties.extend(action.op.properties());
                let mut required = vec![Value::String("action".to_owned())];
                // The default action may leave `action` out.
                if self.default_action == Some(action.name) {
                    required.clear();
                }
                required.extend(action.op.required().into_iter().map(Value::String));
                json!({
                    "title": action.name,
                    "description": action.summary,
                    "type": "object",
                    "properties": properties,
                    "required": required,
                })
            })
            .collect();
        json!({ "type": "object", "oneOf": branches })
    }

    /// MCP's hints about the actions given: whether the tool only reads,
    /// whether it can destroy something, and whether calling it twice is
    /// the same as once.
    pub fn annotations(&self, actions: &[&Action]) -> Value {
        let read_only = actions.iter().all(|action| reads_only(action.op));
        json!({
            "title": self.title,
            "readOnlyHint": read_only,
            "destructiveHint": !read_only && actions.iter().any(|action| destructive(action.op)),
            "idempotentHint": read_only,
            "openWorldHint": false,
        })
    }

    /// The tool as `tools/list` gives it, for a caller behind `gate`, or
    /// `None` when it may use none of its actions.
    pub fn listed(&self, gate: &Gate) -> Option<Value> {
        let actions = self.visible(gate);
        if actions.is_empty() {
            return None;
        }
        Some(json!({
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": self.input_schema(&actions),
            "annotations": self.annotations(&actions),
        }))
    }
}

/// Adds a property to a tool's flat schema. The first action to use a name
/// describes it; a later one with other allowed values adds them.
fn merge_property(properties: &mut Map<String, Value>, name: String, schema: Value) {
    match properties.get_mut(&name) {
        None => {
            properties.insert(name, schema);
        }
        Some(existing) => {
            if let (Some(Value::Array(had)), Some(Value::Array(more))) =
                (existing.get("enum").cloned(), schema.get("enum"))
            {
                let mut merged = had;
                for value in more {
                    if !merged.contains(value) {
                        merged.push(value.clone());
                    }
                }
                existing["enum"] = Value::Array(merged);
            }
            // Different kinds of value under one name: say less, accept both.
            if existing.get("type") != schema.get("type")
                && let Some(fields) = existing.as_object_mut()
            {
                fields.remove("type");
                fields.remove("items");
            }
        }
    }
}

/// What a call to a tool runs: the operation its action names, or why not.
pub fn resolve(tool: &Tool, arguments: &Value) -> Result<Op, String> {
    let names = || {
        tool.actions
            .iter()
            .map(|action| action.name)
            .collect::<Vec<_>>()
            .join(", ")
    };
    let Some(name) = arguments["action"].as_str().or(tool.default_action) else {
        return Err(format!("Give an action: one of {}.", names()));
    };
    let Some(action) = tool.action(name) else {
        return Err(format!("{} has no action {name}. Its actions: {}.", tool.name, names()));
    };
    let missing: Vec<String> = action
        .op
        .required()
        .into_iter()
        .filter(|field| arguments.get(field).is_none_or(Value::is_null))
        .collect();
    if !missing.is_empty() {
        return Err(format!("{}.{name} needs {}.", tool.name, missing.join(", ")));
    }
    Ok(action.op)
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::scopes::{Preset, Scope};

    fn listed(gate: &Gate) -> Vec<Value> {
        TOOLS.iter().filter_map(|tool| tool.listed(gate)).collect()
    }

    fn token(scopes: Option<Vec<Scope>>) -> TokenAccess {
        TokenAccess {
            token_id: "tok_1".to_owned(),
            scopes: scopes.map(|scopes| scopes.iter().map(|scope| scope.as_str().to_owned()).collect()),
            legacy: false,
            name: None,
            ..TokenAccess::default()
        }
    }

    #[test]
    fn every_operation_is_exactly_one_action_of_one_tool() {
        for op in Op::ALL {
            let count = TOOLS
                .iter()
                .flat_map(|tool| tool.actions.iter())
                .filter(|action| action.op == op)
                .count();
            assert_eq!(count, 1, "{} is {count} actions", op.name());
        }
        for tool in TOOLS {
            let mut names = std::collections::HashSet::new();
            for action in tool.actions {
                assert!(names.insert(action.name), "{}.{} twice", tool.name, action.name);
            }
            if let Some(default) = tool.default_action {
                assert!(tool.action(default).is_some(), "{}", tool.name);
            }
        }
        assert!(TOOLS.len() <= 19, "{} tools", TOOLS.len());
    }

    #[test]
    fn every_operation_needs_exactly_one_scope_or_none() {
        use g1t_contracts::scopes::OPERATIONS;
        for op in Op::ALL {
            let mapped = OPERATIONS.iter().filter(|(name, _)| *name == op.name()).count();
            let free = NO_SCOPE.contains(&op.name());
            assert_eq!(mapped + usize::from(free), 1, "{}", op.name());
        }
        for (name, _) in OPERATIONS {
            assert!(Op::by_name(name).is_some(), "{name} is not an operation");
        }
    }

    #[test]
    fn each_tool_schema_is_valid_with_one_branch_per_action() {
        for tool in TOOLS {
            let actions: Vec<&Action> = tool.actions.iter().collect();
            let flat = tool.input_schema(&actions);
            assert_eq!(flat["type"], "object");
            assert!(flat.get("oneOf").is_none(), "no oneOf at the top level");
            let listed: Vec<&str> = flat["properties"]["action"]["enum"]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap())
                .collect();
            assert_eq!(listed, tool.actions.iter().map(|action| action.name).collect::<Vec<_>>());
            for action in tool.actions {
                for field in action.op.required() {
                    assert!(flat["properties"].get(&field).is_some(), "{}.{}: {field}", tool.name, action.name);
                }
            }
            let keyed = tool.discriminated(&actions);
            let branches = keyed["oneOf"].as_array().unwrap();
            assert_eq!(branches.len(), tool.actions.len());
            for (branch, action) in branches.iter().zip(tool.actions) {
                assert_eq!(branch["properties"]["action"]["const"], action.name);
                for field in branch["required"].as_array().unwrap() {
                    assert!(branch["properties"].get(field.as_str().unwrap()).is_some(), "{}.{}: {field}", tool.name, action.name);
                }
            }
            // A well-formed JSON Schema object throughout.
            let text = serde_json::to_string(&flat).unwrap();
            assert!(serde_json::from_str::<Value>(&text).is_ok());
        }
    }

    #[test]
    fn a_read_only_token_sees_read_actions_only() {
        let access = token(Preset::ReadOnly.scopes());
        let gate = Gate::Token(&access);
        for tool in TOOLS {
            for action in tool.visible(&gate) {
                assert!(reads_only(action.op), "{}.{}", tool.name, action.name);
            }
        }
        let tools = listed(&gate);
        for tool in &tools {
            assert_eq!(tool["annotations"]["readOnlyHint"], true, "{}", tool["name"]);
            assert_eq!(tool["annotations"]["destructiveHint"], false);
        }
        let issue = tools.iter().find(|tool| tool["name"] == "issue").unwrap();
        assert_eq!(issue["inputSchema"]["properties"]["action"]["enum"], json!(["list", "get", "labels"]));
        // Nothing of the agent tool is a read.
        assert!(!tools.iter().any(|tool| tool["name"] == "agent"));
    }

    #[test]
    fn a_narrow_token_sees_only_its_tools() {
        let access = token(Some(vec![Scope::IssuesWrite]));
        let names: Vec<Value> = listed(&Gate::Token(&access)).into_iter().map(|tool| tool["name"].clone()).collect();
        // Labels and milestones are the repository's, managed with issues:write.
        assert_eq!(names, vec![json!("repository"), json!("issue"), json!("plan"), json!("account")]);
        // Notifications are a resource of their own: reading them lists
        // only what reads.
        let reader = token(Some(vec![Scope::NotificationsRead]));
        let tools = listed(&Gate::Token(&reader));
        let notifications = tools.iter().find(|tool| tool["name"] == "notifications").unwrap();
        assert_eq!(
            notifications["inputSchema"]["properties"]["action"]["enum"],
            json!(["list", "get", "subscription", "watching", "watched"])
        );
        assert_eq!(notifications["annotations"]["readOnlyHint"], true);
        let full = token(None);
        assert_eq!(listed(&Gate::Token(&full)).len(), TOOLS.len());
        assert_eq!(listed(&Gate::Everything).len(), TOOLS.len());
    }

    #[test]
    fn a_tool_that_can_destroy_says_so() {
        let tools = listed(&Gate::Everything);
        let repository = tools.iter().find(|tool| tool["name"] == "repository").unwrap();
        assert_eq!(repository["annotations"]["destructiveHint"], true);
        assert_eq!(repository["annotations"]["readOnlyHint"], false);
        let memory = tools.iter().find(|tool| tool["name"] == "memory").unwrap();
        assert_eq!(memory["annotations"]["destructiveHint"], false);
    }

    #[test]
    fn calls_resolve_to_their_operation_or_say_what_is_missing() {
        let issue = Tool::by_name("issue").unwrap();
        assert_eq!(resolve(issue, &json!({ "action": "get", "repo": "a/b", "number": 1 })), Ok(Op::GetIssue));
        assert_eq!(resolve(issue, &json!({ "action": "get", "repo": "a/b" })), Err("issue.get needs number.".to_owned()));
        assert!(resolve(issue, &json!({})).unwrap_err().starts_with("Give an action"));
        assert!(resolve(issue, &json!({ "action": "explode" })).unwrap_err().contains("no action explode"));
        let search = Tool::by_name("search").unwrap();
        assert_eq!(resolve(search, &json!({ "query": "x" })), Ok(Op::Search));
        let account = Tool::by_name("account").unwrap();
        assert_eq!(resolve(account, &json!({})), Ok(Op::Whoami));
    }

    #[test]
    fn teams_are_one_tool_and_a_workspace_reader_sees_only_its_reads() {
        let team = Tool::by_name("team").unwrap();
        let names: Vec<&str> = team.actions.iter().map(|action| action.name).collect();
        assert_eq!(
            names,
            [
                "list",
                "get",
                "create",
                "update",
                "delete",
                "list_members",
                "set_member",
                "remove_member",
                "list_child_teams",
                "list_repos",
                "set_repo",
                "remove_repo",
                "set_review_assignment",
                "list_user_teams",
            ]
        );
        let reader = token(Some(vec![Scope::WorkspaceRead]));
        let tools = listed(&Gate::Token(&reader));
        let listed_team = tools.iter().find(|tool| tool["name"] == "team").unwrap();
        assert_eq!(
            listed_team["inputSchema"]["properties"]["action"]["enum"],
            json!(["list", "get", "list_members", "list_child_teams", "list_repos", "list_user_teams"])
        );
        assert_eq!(listed_team["annotations"]["readOnlyHint"], true);
        // A team's role on a repository is who has access.
        let admin = token(Some(vec![Scope::WorkspaceAdmin]));
        let tools = listed(&Gate::Token(&admin));
        let listed_team = tools.iter().find(|tool| tool["name"] == "team").unwrap();
        let actions = listed_team["inputSchema"]["properties"]["action"]["enum"].as_array().unwrap();
        assert!(actions.contains(&json!("set_review_assignment")) && !actions.contains(&json!("set_repo")));
        let access = token(Some(vec![Scope::AccessAdmin]));
        let tools = listed(&Gate::Token(&access));
        let listed_team = tools.iter().find(|tool| tool["name"] == "team").unwrap();
        assert_eq!(listed_team["inputSchema"]["properties"]["action"]["enum"], json!(["set_repo", "remove_repo"]));
        // Both kinds of role a schema names are offered.
        let roles = &listed(&Gate::Everything).into_iter().find(|tool| tool["name"] == "team").unwrap()["inputSchema"]
            ["properties"]["role"]["enum"];
        for role in ["member", "maintainer", "read", "admin"] {
            assert!(roles.as_array().unwrap().contains(&json!(role)), "{role}");
        }
        assert_eq!(
            resolve(team, &json!({ "action": "set_repo", "workspace": "acme", "team": "backend", "repo": "rocket" })),
            Err("team.set_repo needs role.".to_owned())
        );
    }

    #[test]
    fn reviewers_and_code_owners_are_actions_of_their_tools() {
        let pull = Tool::by_name("pull_request").unwrap();
        assert_eq!(
            resolve(pull, &json!({ "action": "request_reviewers", "repo": "a/b", "number": 1, "team_reviewers": ["backend"] })),
            Ok(Op::RequestReviewers)
        );
        assert_eq!(pull.action("remove_requested_reviewers").map(|action| action.op), Some(Op::RemoveRequestedReviewers));
        let repository = Tool::by_name("repository").unwrap();
        assert_eq!(resolve(repository, &json!({ "action": "codeowners", "repo": "a/b" })), Ok(Op::GetCodeownersErrors));
        assert!(reads_only(Op::GetCodeownersErrors));
        assert!(!reads_only(Op::RequestReviewers));
    }

    /// The `artifact` tool offers each token only what its artifacts scope
    /// allows: reading, then changing, then sharing and deleting for good.
    /// Workflow runs' artifacts are the `workflow` tool's, under their own
    /// scope, and neither scope reaches the other's.
    #[test]
    fn the_artifact_tool_offers_what_the_artifacts_scope_allows() {
        let actions = |scopes: Vec<Scope>| -> Option<Value> {
            let access = token(Some(scopes));
            Tool::by_name("artifact").unwrap().listed(&Gate::Token(&access)).map(|tool| tool["inputSchema"]["properties"]["action"]["enum"].clone())
        };
        let reads = json!(["list", "search", "get", "read", "versions", "access", "templates", "spaces", "query_data"]);
        assert_eq!(actions(vec![Scope::ArtifactsRead]), Some(reads.clone()));
        let writes = actions(vec![Scope::ArtifactsWrite]).unwrap();
        for action in ["create", "update", "edit", "trash", "restore", "restore_version"] {
            assert!(writes.as_array().unwrap().contains(&json!(action)), "{action}");
        }
        assert!(!writes.as_array().unwrap().contains(&json!("share")) && !writes.as_array().unwrap().contains(&json!("purge")));
        let admin = actions(vec![Scope::ArtifactsAdmin]).unwrap();
        assert_eq!(admin.as_array().unwrap().len(), Tool::by_name("artifact").unwrap().actions.len());
        // Without an artifacts scope there is no artifact tool at all.
        assert_eq!(actions(vec![Scope::WorkflowsWrite, Scope::IssuesWrite]), None);
        // And an artifacts scope shows nothing of workflow runs' artifacts.
        let access = token(Some(vec![Scope::ArtifactsAdmin]));
        assert!(Tool::by_name("workflow").unwrap().listed(&Gate::Token(&access)).is_none());
        // The read-only and agent presets read artifacts and change none.
        for preset in [Preset::ReadOnly, Preset::Agent] {
            let access = token(preset.scopes());
            let tool = Tool::by_name("artifact").unwrap().listed(&Gate::Token(&access)).unwrap();
            assert_eq!(tool["inputSchema"]["properties"]["action"]["enum"], reads, "{}", preset.as_str());
            assert_eq!(tool["annotations"]["readOnlyHint"], true);
        }
        // Sharing and deleting for good can't be undone the same way.
        let tools = listed(&Gate::Everything);
        let artifact = tools.iter().find(|tool| tool["name"] == "artifact").unwrap();
        assert_eq!(artifact["annotations"]["destructiveHint"], true);
        assert!(artifact["description"].as_str().unwrap().contains("Not the `workflow` tool's run artifacts"));
        let tool = Tool::by_name("artifact").unwrap();
        assert_eq!(resolve(tool, &json!({ "action": "read", "workspace": "acme" })), Err("artifact.read needs artifact_id.".to_owned()));
        assert_eq!(
            resolve(tool, &json!({ "action": "edit", "workspace": "acme", "artifact_id": "fol_1", "markdown": "x" })),
            Ok(Op::Folios(FoliosOp::Edit))
        );
    }

    /// How much smaller `tools/list` is than one tool per operation. Run
    /// with `--nocapture` to see the numbers.
    #[test]
    fn the_tool_list_is_much_smaller_than_one_tool_per_operation() {
        let before: Vec<Value> = Op::ALL
            .into_iter()
            .map(|op| json!({ "name": op.name(), "description": op.description(), "inputSchema": op.input() }))
            .collect();
        let after = listed(&Gate::Everything);
        let before_bytes = serde_json::to_string(&json!({ "tools": before })).unwrap().len();
        let after_bytes = serde_json::to_string(&json!({ "tools": after })).unwrap().len();
        let agent = token(Preset::Agent.scopes());
        let agent_bytes = serde_json::to_string(&json!({ "tools": listed(&Gate::Token(&agent)) })).unwrap().len();
        let read = token(Preset::ReadOnly.scopes());
        let read_bytes = serde_json::to_string(&json!({ "tools": listed(&Gate::Token(&read)) })).unwrap().len();
        println!(
            "tools/list: before {} tools, {before_bytes} bytes (~{} tokens); after {} tools, {after_bytes} bytes (~{} tokens); agent preset {agent_bytes} bytes (~{} tokens); read only {read_bytes} bytes (~{} tokens)",
            before.len(),
            before_bytes / 4,
            after.len(),
            after_bytes / 4,
            agent_bytes / 4,
            read_bytes / 4,
        );
        assert!(after_bytes * 2 < before_bytes, "{after_bytes} vs {before_bytes}");
    }
}
