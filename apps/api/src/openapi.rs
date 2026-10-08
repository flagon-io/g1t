//! The OpenAPI document, generated from the same list the routes are.
//!
//! The docs site builds its API reference from a copy of this document,
//! `apps/docs/src/data/openapi.json`. A test keeps the copy current: run
//! `G1T_WRITE_OPENAPI=1 cargo test -p g1t-api openapi` to rewrite it.

use g1t_contracts::scopes::scope_for;
use serde_json::{Map, Value, json};

use crate::about::AboutOp;
use crate::artifacts::ArtifactsOp;
use crate::deployments::DeploymentsOp;
use crate::operations::Op;
use crate::checks::ChecksOp;
use crate::rules::RulesOp;
use crate::security::SecurityOp;
use crate::rest::{ROUTES, Route};

/// The sections of the API reference: a name, what it covers, and its
/// operations in the order a reader meets them.
const SECTIONS: &[(&str, &str, &[Op])] = &[
    (
        "Accounts",
        "Signing in from a tool, who a token acts as, and your email addresses.",
        &[Op::Whoami, Op::ListEmails, Op::AddEmail, Op::RemoveEmail, Op::UpdateEmailSettings],
    ),
    (
        "Notifications",
        "Your inbox: a thread for each thing you were told about (an issue, a pull request, a workflow on a branch, a deployment), why you were told, and what you subscribe to and watch. Your own: personal tokens and sessions only.",
        &[
            Op::ListNotifications,
            Op::MarkNotificationsRead,
            Op::GetNotificationThread,
            Op::MarkThreadRead,
            Op::MarkThreadDone,
            Op::SaveThread,
            Op::SnoozeThread,
            Op::GetThreadSubscription,
            Op::SetThreadSubscription,
            Op::DeleteThreadSubscription,
            Op::GetRepoSubscription,
            Op::SetRepoSubscription,
            Op::DeleteRepoSubscription,
            Op::ListWatchedRepos,
        ],
    ),
    (
        "Pinned projects",
        "The projects you keep at the top of a workspace's sidebar, in your order, up to eight a workspace. Your own: personal tokens and sessions only.",
        &[Op::ListPinnedProjects, Op::PinProject, Op::UnpinProject, Op::ReorderPinnedProjects],
    ),
    (
        "Projects",
        "A project is what a workspace builds and runs, from a repository or a root directory in one. Each says what it is, where it runs and where to find it: its homepage, docs and other links.",
        &[Op::ListProjects, Op::GetProject, Op::UpdateProject],
    ),
    (
        "Workspaces",
        "A workspace owns repositories and is the first part of their address. People and agents work in workspaces.",
        &[Op::GetWorkspace, Op::CreateWorkspace, Op::UpdateWorkspace, Op::DeleteWorkspace],
    ),
    (
        "Members",
        "A workspace's members and owners: who belongs to it, their roles (owner or member, with billing manager and security manager on top), handing it to another member, and leaving it.",
        &[Op::ListMembers, Op::UpdateMember, Op::RemoveMember, Op::TransferOwnership, Op::LeaveWorkspace],
    ),
    (
        "Invites",
        "While g1t is invite-only, every new account needs an invite. Your invites, and inviting people into a workspace by email.",
        &[
            Op::ListInvites,
            Op::CreateInvite,
            Op::RevokeInvite,
            Op::ListWorkspaceInvites,
            Op::InviteMember,
            Op::RevokeWorkspaceInvite,
        ],
    ),
    (
        "Billing",
        "A workspace's usage, its budget, its AI credit, its invoices and its AI Gateway requests. Members read them; owners change the budget and buy credit, as people. g1t's agents never change billing.",
        &[
            Op::GetUsage,
            Op::GetBudget,
            Op::SetBudget,
            Op::GetAiCredit,
            Op::BuyAiCredit,
            Op::ListInvoices,
            Op::GetBillingDetails,
            Op::ListGatewayRequests,
        ],
    ),
    (
        "Repositories",
        "A repository, how it handles pull requests, and its timeline: renaming, archiving, moving and deleting it.",
        &[
            Op::ListRepos,
            Op::CreateRepo,
            Op::GetRepo,
            Op::UpdateRepo,
            Op::RenameRepo,
            Op::RenameBranch,
            Op::SetRepoVisibility,
            Op::ArchiveRepo,
            Op::UnarchiveRepo,
            Op::TransferRepo,
            Op::DeleteRepo,
            Op::ListDeletedRepos,
            Op::RestoreRepo,
            Op::PurgeRepo,
            Op::GetRepoSettings,
            Op::UpdateRepoSettings,
            Op::ListCheckNames,
            Op::GetCodeownersErrors,
            Op::ListEvents,
        ],
    ),
    (
        "Repository insights",
        "What a repository's default branch says about it, read in the background and kept by commit: the languages it is written in, who made it, and its license.",
        &[Op::About(AboutOp::GetLanguages), Op::About(AboutOp::ListContributors), Op::About(AboutOp::GetLicense)],
    ),
    (
        "Stars",
        "Starring a repository, to keep it and to say you like it: who starred one, and what you starred.",
        &[
            Op::About(AboutOp::ListStargazers),
            Op::About(AboutOp::ListStarred),
            Op::About(AboutOp::CheckStarred),
            Op::About(AboutOp::Star),
            Op::About(AboutOp::Unstar),
        ],
    ),
    (
        "Releases",
        "A release is a tag published with a title and notes. The latest is the newest published one that is neither a draft nor a prerelease.",
        &[
            Op::About(AboutOp::ListReleases),
            Op::About(AboutOp::CreateRelease),
            Op::About(AboutOp::GetLatestRelease),
            Op::About(AboutOp::GetReleaseByTag),
            Op::About(AboutOp::GetRelease),
            Op::About(AboutOp::UpdateRelease),
            Op::About(AboutOp::DeleteRelease),
        ],
    ),
    (
        "Access",
        "Who can do what in a repository: repository roles, people given a role on one repository (outside collaborators when they are not members), invitations, and a workspace's base permission.",
        &[
            Op::ListCollaborators,
            Op::AddCollaborator,
            Op::UpdateCollaborator,
            Op::RemoveCollaborator,
            Op::GetCollaboratorPermission,
            Op::ListRepoInvitations,
            Op::RevokeRepoInvitation,
            Op::ListMyRepoInvitations,
            Op::AcceptRepoInvitation,
            Op::DeclineRepoInvitation,
            Op::SetBasePermission,
            Op::ListOutsideCollaborators,
        ],
    ),
    (
        "Teams",
        "Groups of a workspace's members: given a role on repositories together, mentioned together as @workspace/team, and asked to review together. Any member may create a team; the workspace's owners and the team's maintainers manage it.",
        &[
            Op::ListTeams,
            Op::CreateTeam,
            Op::GetTeam,
            Op::UpdateTeam,
            Op::DeleteTeam,
            Op::ListTeamMembers,
            Op::SetTeamMember,
            Op::RemoveTeamMember,
            Op::ListChildTeams,
            Op::ListTeamRepos,
            Op::SetTeamRepo,
            Op::RemoveTeamRepo,
            Op::SetTeamReviewAssignment,
            Op::ListUserTeams,
        ],
    ),
    (
        "Security",
        "Secrets found in what is pushed and in a repository's history, and dependencies with known vulnerabilities: listing the alerts, and dismissing or reopening them.",
        &[Op::ListSecurityAlerts, Op::DismissSecurityAlert, Op::ReopenSecurityAlert],
    ),
    (
        "Secret scanning",
        "Secrets found in pushes and history, where each one is, pushing past push protection with a reason (and asking for approval when the workspace delegates bypasses), checking with a secret's issuer whether it still works, and custom patterns.",
        &[
            Op::Security(SecurityOp::ListSecretAlerts),
            Op::Security(SecurityOp::GetSecretAlert),
            Op::Security(SecurityOp::UpdateSecretAlert),
            Op::Security(SecurityOp::ListSecretLocations),
            Op::Security(SecurityOp::BypassPushProtection),
            Op::Security(SecurityOp::CheckSecretValidity),
            Op::Security(SecurityOp::ListBypassRequests),
            Op::Security(SecurityOp::ReviewBypassRequest),
            Op::Security(SecurityOp::ListCustomPatterns),
            Op::Security(SecurityOp::CreateCustomPattern),
            Op::Security(SecurityOp::UpdateCustomPattern),
            Op::Security(SecurityOp::DeleteCustomPattern),
            Op::Security(SecurityOp::DryRunCustomPattern),
        ],
    ),
    (
        "Code scanning",
        "Results of static analysis tools, uploaded as SARIF: alerts on the default branch, the analyses that made them, uploads, and putting g1t on an alert to fix it.",
        &[
            Op::Security(SecurityOp::ListCodeAlerts),
            Op::Security(SecurityOp::GetCodeAlert),
            Op::Security(SecurityOp::UpdateCodeAlert),
            Op::Security(SecurityOp::ListAnalyses),
            Op::Security(SecurityOp::UploadSarif),
            Op::Security(SecurityOp::GetSarifUpload),
            Op::Security(SecurityOp::FixAlert),
        ],
    ),
    (
        "Supply chain",
        "What a repository depends on: vulnerability alerts, the dependency graph, an SPDX SBOM of it, and comparing two commits' dependencies as dependency review does.",
        &[
            Op::Security(SecurityOp::ListVulnerabilityAlerts),
            Op::Security(SecurityOp::GetVulnerabilityAlert),
            Op::Security(SecurityOp::UpdateVulnerabilityAlert),
            Op::Security(SecurityOp::GetDependencyGraph),
            Op::Security(SecurityOp::GetSbom),
            Op::Security(SecurityOp::CompareDependencies),
        ],
    ),
    (
        "Security settings",
        "When pull request checks fail, dependency review's policy, delegated bypass and validity checks, and a workspace's security overview.",
        &[
            Op::Security(SecurityOp::GetSettings),
            Op::Security(SecurityOp::UpdateSettings),
            Op::Security(SecurityOp::GetWorkspaceSettings),
            Op::Security(SecurityOp::UpdateWorkspaceSettings),
            Op::Security(SecurityOp::GetOverview),
        ],
    ),
    (
        "Rules",
        "Rulesets: what may happen to a repository's branches and tags and what a pull request needs before it merges, for a repository or across a workspace; the rules that hold for one branch; and how they judged each push and merge, with insights.",
        &[
            Op::Rules(RulesOp::ListRepoRulesets),
            Op::Rules(RulesOp::CreateRepoRuleset),
            Op::Rules(RulesOp::GetRepoRuleset),
            Op::Rules(RulesOp::UpdateRepoRuleset),
            Op::Rules(RulesOp::DeleteRepoRuleset),
            Op::Rules(RulesOp::GetBranchRules),
            Op::Rules(RulesOp::ListRuleEvaluations),
            Op::Rules(RulesOp::ListWorkspaceRulesets),
            Op::Rules(RulesOp::CreateWorkspaceRuleset),
            Op::Rules(RulesOp::GetWorkspaceRuleset),
            Op::Rules(RulesOp::UpdateWorkspaceRuleset),
            Op::Rules(RulesOp::DeleteWorkspaceRuleset),
            Op::Rules(RulesOp::ListWorkspaceRuleEvaluations),
        ],
    ),
    (
        "Checks",
        "What CI, integrations and g1t Actions say about a commit, in the shapes CI tools already send: statuses (a state per context) and check runs (a lifecycle, a conclusion, a Markdown report, annotations on lines and buttons), grouped per reporter into check suites. g1t Actions jobs are check runs too. Required checks are met by either.",
        &[
            Op::Checks(ChecksOp::CreateCommitStatus),
            Op::Checks(ChecksOp::ListCommitStatuses),
            Op::Checks(ChecksOp::GetCombinedStatus),
            Op::Checks(ChecksOp::CreateCheckRun),
            Op::Checks(ChecksOp::UpdateCheckRun),
            Op::Checks(ChecksOp::GetCheckRun),
            Op::Checks(ChecksOp::ListCheckRunAnnotations),
            Op::Checks(ChecksOp::RerequestCheckRun),
            Op::Checks(ChecksOp::ListCheckRunsForRef),
            Op::Checks(ChecksOp::ListCheckSuitesForRef),
            Op::Checks(ChecksOp::GetCheckSuite),
            Op::Checks(ChecksOp::RerequestCheckSuite),
        ],
    ),
    (
        "Issues",
        "What should change in a repository, with labels and comments. Issues and pull requests share one sequence of numbers.",
        &[
            Op::ListIssues,
            Op::CreateIssue,
            Op::GetIssue,
            Op::UpdateIssue,
            Op::CloseIssue,
            Op::ReopenIssue,
            Op::AssignIssue,
            Op::Delegate,
            Op::AddComment,
            Op::ListIssueLabels,
            Op::AddIssueLabels,
            Op::SetIssueLabels,
            Op::RemoveIssueLabels,
        ],
    ),
    (
        "Labels and milestones",
        "A repository's labels, which issues and pull requests carry by name, and its milestones, which gather them under a goal and a due date.",
        &[
            Op::ListLabels,
            Op::CreateLabel,
            Op::UpdateLabel,
            Op::DeleteLabel,
            Op::AddDefaultLabels,
            Op::ListMilestones,
            Op::CreateMilestone,
            Op::GetMilestone,
            Op::UpdateMilestone,
            Op::DeleteMilestone,
        ],
    ),
    (
        "Plans",
        "An outcome turned into the issues that would get there, with the order they must merge in.",
        &[Op::PlanWork, Op::GetPlan, Op::ApplyPlan],
    ),
    (
        "Pull requests",
        "A proposed change in its own fork or on a branch. Several can be made for one issue; the one merged resolves it.",
        &[
            Op::ListPullRequests,
            Op::CreatePullRequest,
            Op::GetPullRequest,
            Op::UpdatePullRequest,
            Op::GetPullRequestChanges,
            Op::MarkPullRequestReady,
            Op::RequestReviewers,
            Op::RemoveRequestedReviewers,
            Op::ReviewPullRequest,
            Op::MergePullRequest,
            Op::ClosePullRequest,
            Op::GetMergeQueue,
            Op::MessageAgent,
            Op::AnswerMessage,
            Op::TakeMessages,
        ],
    ),
    (
        "Sessions",
        "The record of how a pull request was made: prompts, reasoning and the tools that ran.",
        &[Op::ReadSession, Op::RecordSession],
    ),
    (
        "Memory",
        "What agents and people learned that the next agent should know, for one project or across a workspace. Members and g1t's agents only; never a secret.",
        &[Op::Remember, Op::Recall],
    ),
    (
        "Search",
        "One search across all of g1t: repositories, code, issues, pull requests, people and workspaces. Public content for everyone, and private content in workspaces you belong to.",
        &[Op::Search],
    ),
    (
        "Context",
        "A workspace's context hub: a catalog of what it builds and runs, built from its repositories, deployments and integrations, and one search across the catalog, docs, issues, pull requests and memory.",
        &[Op::SearchContext, Op::GetEntity],
    ),
    (
        "Actions",
        "GitHub Actions workflows in .g1t/workflows, their runs, and their jobs' logs.",
        &[
            Op::ListWorkflows,
            Op::ListWorkflowRuns,
            Op::GetWorkflowRun,
            Op::GetJobLogs,
            Op::DispatchWorkflow,
            Op::CancelWorkflowRun,
            Op::RerunWorkflowRun,
            Op::UpdateWorkflow,
            Op::Artifacts(ArtifactsOp::ListArtifacts),
            Op::Artifacts(ArtifactsOp::ListRunArtifacts),
            Op::Artifacts(ArtifactsOp::GetArtifact),
            Op::Artifacts(ArtifactsOp::DownloadArtifact),
            Op::Artifacts(ArtifactsOp::DeleteArtifact),
            Op::Artifacts(ArtifactsOp::GetArtifactRetention),
            Op::Artifacts(ArtifactsOp::SetArtifactRetention),
        ],
    ),
    (
        "Deployments",
        "A repository's deployments wherever they run: reported from any CI with these routes, made by g1t Actions jobs with an `environment:`, or built on g1t.page. Each has statuses, shows on its commit as the check `deploy / <environment>`, and belongs to an environment.",
        &[
            Op::Deployments(DeploymentsOp::ListDeployments),
            Op::Deployments(DeploymentsOp::CreateDeployment),
            Op::Deployments(DeploymentsOp::GetDeployment),
            Op::Deployments(DeploymentsOp::ListDeploymentStatuses),
            Op::Deployments(DeploymentsOp::CreateDeploymentStatus),
            Op::Deployments(DeploymentsOp::ListEnvironments),
            Op::Deployments(DeploymentsOp::GetEnvironment),
        ],
    ),
    (
        "Secrets and variables",
        "Values that workflows and deployments read, per repository or for a whole workspace, with a row per environment.",
        &[
            Op::ListActionsSecrets,
            Op::SetActionsSecret,
            Op::DeleteActionsSecret,
            Op::ListActionsVariables,
            Op::SetActionsVariable,
            Op::DeleteActionsVariable,
        ],
    ),
    (
        "Runners",
        "Self-hosted runners: your own machines, which run your workflow jobs (and, if you choose, your agents' work) for $0 of g1t compute. They register with a short-lived token and only ever connect out.",
        &[
            Op::ListRunners,
            Op::CreateRunnerRegistrationToken,
            Op::RemoveRunner,
            Op::ListRunnerGroups,
            Op::CreateRunnerGroup,
            Op::UpdateRunnerGroup,
            Op::DeleteRunnerGroup,
            Op::GetRunnerSettings,
            Op::UpdateRunnerSettings,
        ],
    ),
    (
        "Webhooks",
        "Signed HTTPS requests sent to your own address as things happen, for a repository or a whole workspace.",
        &[
            Op::ListWebhooks,
            Op::CreateWebhook,
            Op::UpdateWebhook,
            Op::DeleteWebhook,
            Op::PingWebhook,
            Op::ListWebhookDeliveries,
            Op::RedeliverWebhook,
        ],
    ),
    (
        "Integrations",
        "A workspace's connections to outside systems: model providers, alert sources and issue trackers.",
        &[
            Op::ListIntegrations,
            Op::ConnectIntegration,
            Op::UpdateIntegration,
            Op::DisconnectIntegration,
            Op::TestIntegration,
            Op::GetModelRoutes,
            Op::SetModelRoutes,
            Op::GetContext,
            Op::ImportIssue,
        ],
    ),
];

/// The section of the API reference an operation is listed under.
fn tag(op: Op) -> &'static str {
    SECTIONS
        .iter()
        .find(|(_, _, ops)| ops.contains(&op))
        .map_or("Repositories", |(name, _, _)| name)
}

/// What an operation's page is called, as a short sentence.
fn title(op: Op) -> &'static str {
    match op {
        Op::Whoami => "Get the current user",
        Op::GetWorkspace => "Get a workspace",
        Op::CreateWorkspace => "Create a workspace",
        Op::DeleteWorkspace => "Delete a workspace",
        Op::UpdateWorkspace => "Update a workspace",
        Op::ListMembers => "List a workspace's members",
        Op::UpdateMember => "Change a member's role",
        Op::RemoveMember => "Remove a member",
        Op::TransferOwnership => "Transfer a workspace's ownership",
        Op::LeaveWorkspace => "Leave a workspace",
        Op::ListEmails => "List your email addresses",
        Op::AddEmail => "Add an email address",
        Op::RemoveEmail => "Remove an email address",
        Op::UpdateEmailSettings => "Change your email settings",
        Op::ListInvites => "List your invites",
        Op::CreateInvite => "Create an invite",
        Op::RevokeInvite => "Revoke an invite",
        Op::ListWorkspaceInvites => "List a workspace's invites",
        Op::InviteMember => "Invite someone to a workspace",
        Op::RevokeWorkspaceInvite => "Revoke a workspace's invite",
        Op::TransferRepo => "Transfer a repository",
        Op::RenameRepo => "Rename a repository",
        Op::RenameBranch => "Rename a branch",
        Op::ArchiveRepo => "Archive a repository",
        Op::UnarchiveRepo => "Unarchive a repository",
        Op::SetRepoVisibility => "Change a repository's visibility",
        Op::DeleteRepo => "Delete a repository",
        Op::ListDeletedRepos => "List recently deleted repositories",
        Op::RestoreRepo => "Restore a deleted repository",
        Op::PurgeRepo => "Purge a deleted repository",
        Op::ListRepos => "List repositories",
        Op::GetRepo => "Get a repository",
        Op::CreateRepo => "Create a repository",
        Op::UpdateRepo => "Update a repository",
        Op::GetRepoSettings => "Get repository settings",
        Op::UpdateRepoSettings => "Update repository settings",
        Op::ListCheckNames => "List check names",
        Op::GetMergeQueue => "Get the merge queue",
        Op::MessageAgent => "Message an agent",
        Op::AnswerMessage => "Answer a message",
        Op::TakeMessages => "Take new messages",
        Op::Remember => "Remember something",
        Op::Recall => "Recall memory",
        Op::SearchContext => "Search the context hub",
        Op::GetEntity => "Get a catalog entry",
        Op::Search => "Search g1t",
        Op::ListIssues => "List issues",
        Op::GetIssue => "Get an issue",
        Op::CreateIssue => "Create an issue",
        Op::UpdateIssue => "Update an issue",
        Op::CloseIssue => "Close an issue",
        Op::ReopenIssue => "Reopen an issue",
        Op::AssignIssue => "Assign an issue to g1t",
        Op::Delegate => "Put an agent on it",
        Op::PlanWork => "Plan work",
        Op::GetPlan => "Get a plan",
        Op::ApplyPlan => "Apply a plan",
        Op::ListLabels => "List labels",
        Op::CreateLabel => "Create a label",
        Op::UpdateLabel => "Update a label",
        Op::DeleteLabel => "Delete a label",
        Op::AddDefaultLabels => "Add the default labels",
        Op::ListIssueLabels => "List an issue's labels",
        Op::AddIssueLabels => "Add labels to an issue",
        Op::SetIssueLabels => "Set an issue's labels",
        Op::RemoveIssueLabels => "Remove labels from an issue",
        Op::ListMilestones => "List milestones",
        Op::GetMilestone => "Get a milestone",
        Op::CreateMilestone => "Create a milestone",
        Op::UpdateMilestone => "Update a milestone",
        Op::DeleteMilestone => "Delete a milestone",
        Op::UpdatePullRequest => "Update a pull request",
        Op::AddComment => "Add a comment",
        Op::ReviewPullRequest => "Review a pull request",
        Op::ListPullRequests => "List pull requests",
        Op::GetPullRequest => "Get a pull request",
        Op::CreatePullRequest => "Create a pull request",
        Op::RecordSession => "Record session entries",
        Op::ReadSession => "Read a session",
        Op::MarkPullRequestReady => "Mark a pull request ready",
        Op::ClosePullRequest => "Close a pull request",
        Op::GetPullRequestChanges => "Get a pull request's changes",
        Op::MergePullRequest => "Merge a pull request",
        Op::ListEvents => "List repository events",
        Op::ListIntegrations => "List integrations",
        Op::ConnectIntegration => "Connect an integration",
        Op::UpdateIntegration => "Update an integration",
        Op::DisconnectIntegration => "Disconnect an integration",
        Op::TestIntegration => "Test an integration",
        Op::GetContext => "Look up a ticket",
        Op::ImportIssue => "Import an issue",
        Op::GetModelRoutes => "Get model routes",
        Op::SetModelRoutes => "Set model routes",
        Op::ListWebhooks => "List webhooks",
        Op::CreateWebhook => "Create a webhook",
        Op::UpdateWebhook => "Update a webhook",
        Op::DeleteWebhook => "Delete a webhook",
        Op::PingWebhook => "Ping a webhook",
        Op::ListWebhookDeliveries => "List webhook deliveries",
        Op::RedeliverWebhook => "Redeliver a webhook delivery",
        Op::ListWorkflows => "List workflows",
        Op::ListWorkflowRuns => "List workflow runs",
        Op::GetWorkflowRun => "Get a workflow run",
        Op::GetJobLogs => "Get a job's log",
        Op::DispatchWorkflow => "Run a workflow",
        Op::CancelWorkflowRun => "Cancel a workflow run",
        Op::RerunWorkflowRun => "Re-run a workflow run",
        Op::UpdateWorkflow => "Turn a workflow on or off",
        Op::ListActionsSecrets => "List secrets",
        Op::SetActionsSecret => "Set a secret",
        Op::DeleteActionsSecret => "Delete a secret",
        Op::ListActionsVariables => "List variables",
        Op::SetActionsVariable => "Set a variable",
        Op::DeleteActionsVariable => "Delete a variable",
        Op::ListRunners => "List self-hosted runners",
        Op::ListRunnerGroups => "List runner groups",
        Op::GetRunnerSettings => "Get runner settings",
        Op::CreateRunnerRegistrationToken => "Create a runner registration token",
        Op::RemoveRunner => "Remove a self-hosted runner",
        Op::CreateRunnerGroup => "Create a runner group",
        Op::UpdateRunnerGroup => "Change a runner group",
        Op::DeleteRunnerGroup => "Delete a runner group",
        Op::UpdateRunnerSettings => "Change runner settings",
        Op::ListCollaborators => "List who has access",
        Op::AddCollaborator => "Add a collaborator",
        Op::UpdateCollaborator => "Change a collaborator's role",
        Op::RemoveCollaborator => "Remove a collaborator",
        Op::GetCollaboratorPermission => "Get someone's permission",
        Op::ListRepoInvitations => "List a repository's invitations",
        Op::RevokeRepoInvitation => "Revoke a repository invitation",
        Op::ListMyRepoInvitations => "List your repository invitations",
        Op::AcceptRepoInvitation => "Accept a repository invitation",
        Op::DeclineRepoInvitation => "Decline a repository invitation",
        Op::SetBasePermission => "Set the base permission",
        Op::ListOutsideCollaborators => "List outside collaborators",
        Op::ListSecurityAlerts => "List security alerts",
        Op::DismissSecurityAlert => "Dismiss a security alert",
        Op::ReopenSecurityAlert => "Reopen a security alert",
        Op::ListNotifications => "List notifications",
        Op::MarkNotificationsRead => "Mark notifications read",
        Op::GetNotificationThread => "Get a thread",
        Op::MarkThreadRead => "Mark a thread read",
        Op::MarkThreadDone => "Mark a thread done",
        Op::SaveThread => "Save a thread",
        Op::SnoozeThread => "Snooze a thread",
        Op::GetThreadSubscription => "Get a thread subscription",
        Op::SetThreadSubscription => "Set a thread subscription",
        Op::DeleteThreadSubscription => "Unsubscribe from a thread",
        Op::GetRepoSubscription => "Get how you watch a repository",
        Op::SetRepoSubscription => "Watch a repository",
        Op::DeleteRepoSubscription => "Stop watching a repository",
        Op::ListWatchedRepos => "List repositories you watch",
        Op::ListPinnedProjects => "List your pinned projects",
        Op::GetUsage => "Get a workspace's usage",
        Op::GetBudget => "Get a workspace's budget",
        Op::SetBudget => "Change a workspace's budget",
        Op::GetAiCredit => "Get a workspace's AI credit",
        Op::BuyAiCredit => "Buy AI credit",
        Op::ListInvoices => "List a workspace's invoices",
        Op::GetBillingDetails => "Get a workspace's billing details",
        Op::ListGatewayRequests => "List a workspace's AI Gateway requests",
        Op::PinProject => "Pin a project",
        Op::UnpinProject => "Unpin a project",
        Op::ReorderPinnedProjects => "Reorder your pinned projects",
        Op::ListProjects => "List a workspace's projects",
        Op::GetProject => "Get a project",
        Op::UpdateProject => "Update a project",
        Op::ListTeams => "List teams",
        Op::GetTeam => "Get a team",
        Op::CreateTeam => "Create a team",
        Op::UpdateTeam => "Update a team",
        Op::DeleteTeam => "Delete a team",
        Op::ListTeamMembers => "List a team's members",
        Op::SetTeamMember => "Add or change a team member",
        Op::RemoveTeamMember => "Remove a team member",
        Op::ListChildTeams => "List child teams",
        Op::ListTeamRepos => "List a team's repositories",
        Op::SetTeamRepo => "Give a team a role on a repository",
        Op::RemoveTeamRepo => "Remove a team from a repository",
        Op::SetTeamReviewAssignment => "Set a team's review assignment",
        Op::ListUserTeams => "List someone's teams",
        Op::RequestReviewers => "Request reviewers",
        Op::RemoveRequestedReviewers => "Remove requested reviewers",
        Op::GetCodeownersErrors => "List CODEOWNERS errors",
        Op::Security(op) => op.title(),
        Op::Rules(op) => op.title(),
        Op::Checks(op) => op.title(),
        Op::About(op) => op.title(),
        Op::Deployments(op) => op.title(),
        Op::Artifacts(op) => op.title(),
    }
}

/// Why an operation can be refused with `402 payment_required`, if it
/// can: the ones that start an agent, when the workspace has no credit,
/// and the ones that make a repository private in a workspace, when a free
/// workspace's private storage has no room for it.
fn may_need_payment(op: Op) -> Option<&'static str> {
    match op {
        Op::AssignIssue | Op::PlanWork | Op::ApplyPlan => Some("The workspace has no agent credit."),
        Op::UpdateRepo | Op::SetRepoVisibility | Op::TransferRepo => Some(
            "A free workspace's private storage has no room for this private repository.",
        ),
        _ => None,
    }
}

/// What the reference says beyond each operation's own description, keyed
/// by operation id, written by hand from what the services return: `notes`
/// (Markdown, added to the description) and example `params` (path),
/// `query`, `request` (body) and `response`.
const REFERENCE: &str = include_str!("reference.json");

fn examples() -> Map<String, Value> {
    match serde_json::from_str(REFERENCE) {
        Ok(Value::Object(examples)) => examples,
        _ => Map::new(),
    }
}

/// `/repos/:owner/:name` as OpenAPI writes it: `/repos/{owner}/{name}`.
fn openapi_path(route: &Route) -> String {
    route
        .path
        .split('/')
        .map(|segment| match segment.strip_prefix(':') {
            Some(name) => format!("{{{name}}}"),
            None => segment.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn error_response(description: &str) -> Value {
    json!({
        "description": description,
        "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } },
    })
}

/// A parameter in the path or the query, described by the operation's
/// input schema where it has the same name.
fn parameter(name: &str, place: &str, required: bool, schema: Option<&Value>) -> Value {
    let mut schema = schema.cloned().unwrap_or_else(|| json!({ "type": "string" }));
    let description = match name {
        "owner" => Some(Value::from("The workspace that owns the repository.")),
        "name" => Some(Value::from("The repository's name.")),
        _ => schema.as_object_mut().and_then(|schema| schema.remove("description")),
    };
    let mut parameter = json!({
        "name": name,
        "in": place,
        "required": required,
        "schema": schema,
    });
    if let Some(description) = description {
        parameter["description"] = description;
    }
    parameter
}

/// The operation id of a route. An operation reached at a workspace's
/// address as well as a repository's is documented once for each, with its
/// own id; GitHub's alternative addresses for one operation keep GitHub's
/// names.
fn operation_id(route: &Route) -> String {
    let op = route.op;
    let base = match (route.method, route.path.rsplit('/').next().unwrap_or_default()) {
        ("PUT", "enable") => "enable_workflow".to_owned(),
        ("PUT", "disable") => "disable_workflow".to_owned(),
        ("POST", "rerun-failed-jobs") => "rerun_failed_jobs".to_owned(),
        ("PATCH", ":setting") => "update_actions_variable".to_owned(),
        ("GET", "runs") if route.path.contains("/workflows/:workflow/") => "list_runs_of_workflow".to_owned(),
        // One repository's notifications, and an issue's subscription by
        // its number rather than a thread's id.
        (_, "notifications") if route.path.starts_with("/repos/") => match op {
            Op::ListNotifications => "list_repo_notifications".to_owned(),
            _ => "mark_repo_notifications_read".to_owned(),
        },
        (method, "subscription") if route.path.contains("/issues/:number/") => match method {
            "GET" => "get_issue_subscription".to_owned(),
            "PUT" => "set_issue_subscription".to_owned(),
            _ => "delete_issue_subscription".to_owned(),
        },
        // One label off an issue, by its name in the path.
        ("DELETE", ":label") if route.path.contains("/issues/:number/") => "remove_issue_label".to_owned(),
        ("DELETE", "saved") => "unsave_thread".to_owned(),
        ("DELETE", "snooze") => "unsnooze_thread".to_owned(),
        _ => op.name().to_owned(),
    };
    if route.path.starts_with("/workspaces/") && ROUTES.iter().any(|other| other.op == op && other.path.starts_with("/repos/")) {
        format!("{base}_for_workspace")
    } else {
        base
    }
}

/// The summary of a route: its operation's title, or for one of GitHub's
/// alternative addresses, what that address does.
fn summary(route: &Route, id: &str) -> String {
    let base = match id.trim_end_matches("_for_workspace") {
        "enable_workflow" => "Turn a workflow on",
        "disable_workflow" => "Turn a workflow off",
        "rerun_failed_jobs" => "Re-run failed jobs",
        "update_actions_variable" => "Update a variable",
        "list_runs_of_workflow" => "List a workflow's runs",
        "list_repo_notifications" => "List a repository's notifications",
        "mark_repo_notifications_read" => "Mark a repository's notifications read",
        "get_issue_subscription" => "Get your subscription to an issue",
        "set_issue_subscription" => "Subscribe to an issue",
        "delete_issue_subscription" => "Unsubscribe from an issue",
        "unsave_thread" => "Unsave a thread",
        "unsnooze_thread" => "Bring a snoozed thread back",
        _ => title(route.op),
    };
    if id.ends_with("_for_workspace") {
        format!("{base} for a workspace")
    } else {
        base.to_owned()
    }
}

fn operation(route: &Route) -> Value {
    let op = route.op;
    let path_params: Vec<&str> = route.params().collect();
    // `owner` and `name` in the path stand for the operation's `repo` input,
    // so a `name` in the body, such as a check run's, is the body's own.
    let stands_for_repo =
        |name: &str| matches!(name, "owner" | "name") && path_params.contains(&"owner") && path_params.contains(&"name");
    let covered = |name: &str| name == "repo" || (path_params.contains(&name) && !stands_for_repo(name));
    let all_properties = op.properties();
    let mut properties = all_properties.clone();
    properties.retain(|name, _| !covered(name));
    let required: Vec<String> = op
        .required()
        .into_iter()
        .filter(|name| !covered(name))
        .collect();

    let mut parameters: Vec<Value> = path_params
        .iter()
        .map(|name| parameter(name, "path", true, if stands_for_repo(name) { None } else { all_properties.get(*name) }))
        .collect();
    let mut body = Value::Null;
    if route.method == "GET" {
        for (name, key) in route.query {
            parameters.push(parameter(
                name,
                "query",
                required.iter().any(|required| required == key),
                properties.get(*key),
            ));
        }
    } else if !properties.is_empty() {
        let mut schema = json!({ "type": "object", "properties": properties });
        if !required.is_empty() {
            schema["required"] = json!(required);
        }
        body = json!({
            "required": !required.is_empty(),
            "content": { "application/json": { "schema": schema } },
        });
    }

    let id = operation_id(route);
    let mut responses = Map::new();
    responses.insert(
        "200".into(),
        json!({
            "description": "Success.",
            "content": { "application/json": { "schema": {} } },
        }),
    );
    responses.insert(
        "401".into(),
        error_response("A token is required, or the one sent is not valid."),
    );
    if let Some(reason) = may_need_payment(op) {
        responses.insert("402".into(), error_response(reason));
    }
    responses.insert(
        "403".into(),
        error_response("Signed in, but not allowed to do this: the role you have is not enough, or the token lacks the scope it needs, which `needed_scope` names."),
    );
    if !matches!(op, Op::Whoami | Op::ListRepos | Op::Search) {
        responses.insert("404".into(), error_response("It does not exist, or you cannot see it."));
    }
    if route.method != "GET" {
        responses.insert(
            "409".into(),
            error_response("The request conflicts with the current state."),
        );
    }
    if op != Op::Whoami {
        responses.insert("422".into(), error_response("The input is not valid."));
    }
    // Public data can be read without a token; everything else needs one.
    let scope: Vec<&str> = scope_for(op.name()).map(|scope| scope.as_str()).into_iter().collect();
    let security = if op.needs_user() {
        json!([{ "token": scope }])
    } else {
        json!([{ "token": scope }, {}])
    };
    let (tool, action) = crate::tools::TOOLS
        .iter()
        .find_map(|tool| {
            tool.actions
                .iter()
                .find(|action| action.op == op)
                .map(|action| (tool.name, action.name))
        })
        .unwrap_or_default();
    let mut described = json!({
        "operationId": id,
        "tags": [tag(op)],
        "summary": summary(route, &id),
        "description": op.description(),
        "x-operation": op.name(),
        "x-mcp-tool": tool,
        "x-mcp-action": action,
        "x-scope": scope.first().copied(),
        "security": security,
        "parameters": parameters,
        "responses": responses,
    });
    if !body.is_null() {
        described["requestBody"] = body;
    }
    described
}

/// Entries for device sign-in, which is not an operation.
fn onboarding() -> Map<String, Value> {
    let paths = json!({
        "/device/code": {
            "post": {
                "operationId": "device_code",
                "tags": ["Accounts"],
                "summary": "Start signing in",
                "description": "Begins a device sign-in. Show the person `verification_uri_complete` and have them open it in a browser, where they sign in or register and approve the code. Then poll `/device/token`.",
                "security": [],
                "requestBody": {
                    "content": { "application/json": { "schema": {
                        "type": "object",
                        "properties": {
                            "client_name": {
                                "type": "string",
                                "description": "What is asking, shown to the person approving. For example, Claude Code.",
                            },
                        },
                    } } },
                },
                "responses": { "200": {
                    "description": "The codes for this sign-in.",
                    "content": { "application/json": { "schema": {
                        "type": "object",
                        "properties": {
                            "device_code": { "type": "string", "description": "Secret. Send it to /device/token." },
                            "user_code": { "type": "string", "description": "Shown to the person, like WDJB-MJHT." },
                            "verification_uri": { "type": "string" },
                            "verification_uri_complete": {
                                "type": "string",
                                "description": "The link to give the person; it carries the code.",
                            },
                            "expires_in": { "type": "integer", "description": "Seconds until the codes expire." },
                            "interval": { "type": "integer", "description": "Seconds to wait between polls." },
                        },
                    } } },
                } },
            },
        },
        "/device/token": {
            "post": {
                "operationId": "device_token",
                "tags": ["Accounts"],
                "summary": "Finish signing in",
                "description": "Asks whether the person has approved. Poll no faster than the interval. The token is returned once.",
                "security": [],
                "requestBody": {
                    "required": true,
                    "content": { "application/json": { "schema": {
                        "type": "object",
                        "required": ["device_code"],
                        "properties": { "device_code": { "type": "string" } },
                    } } },
                },
                "responses": { "200": {
                    "description": "The state of the sign-in.",
                    "content": { "application/json": { "schema": {
                        "type": "object",
                        "required": ["status"],
                        "properties": {
                            "status": { "type": "string", "enum": ["pending", "approved", "denied", "expired"] },
                            "token": { "type": "string", "description": "Present when approved." },
                            "username": { "type": "string" },
                            "verified": {
                                "type": "boolean",
                                "description": "Whether the account's email is confirmed.",
                            },
                        },
                    } } },
                } },
            },
        },
    });
    match paths {
        Value::Object(paths) => paths,
        _ => Map::new(),
    }
}


/// Puts each operation's examples, where it has them, into its request
/// and response. Path and query values go under `x-example-params` and
/// `x-example-query`, which tools that build a request can use.
fn attach_examples(paths: &mut Map<String, Value>) {
    let examples = examples();
    for methods in paths.values_mut() {
        let Some(methods) = methods.as_object_mut() else { continue };
        for operation in methods.values_mut() {
            let id = operation["operationId"].as_str().unwrap_or_default().to_owned();
            let name = operation["x-operation"].as_str().unwrap_or_default().to_owned();
            let Some(example) = examples.get(&id).or_else(|| examples.get(&name)) else {
                continue;
            };
            if let Some(notes) = example.get("notes").and_then(Value::as_str) {
                let description = operation["description"].as_str().unwrap_or_default();
                operation["description"] = json!(format!("{description}\n\n{notes}"));
            }
            if let Some(response) = example.get("response") {
                let content = &mut operation["responses"]["200"]["content"]["application/json"];
                if content.is_object() {
                    content["example"] = response.clone();
                }
            }
            if let Some(request) = example.get("request") {
                let content = &mut operation["requestBody"]["content"]["application/json"];
                if content.is_object() {
                    content["example"] = request.clone();
                }
            }
            for (key, extension) in [("params", "x-example-params"), ("query", "x-example-query")] {
                if let Some(values) = example.get(key) {
                    operation[extension] = values.clone();
                }
            }
        }
    }
}

pub fn document() -> Value {
    let mut paths = onboarding();
    for route in ROUTES {
        let entry = paths
            .entry(openapi_path(route))
            .or_insert_with(|| json!({}));
        entry[route.method.to_lowercase()] = operation(route);
    }
    attach_examples(&mut paths);
    let tags: Vec<Value> = SECTIONS
        .iter()
        .map(|(name, description, ops)| {
            json!({
                "name": name,
                "description": description,
                // The section's operations in reading order, by MCP tool name.
                "x-tools": ops.iter().map(|op| op.name()).collect::<Vec<_>>(),
            })
        })
        .collect();
    let codes = ["unauthenticated", "payment_required", "forbidden", "not_found", "conflict", "invalid"];
    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "g1t API",
            "version": "1",
            "description": "The REST API for g1t, a git forge built for agents. The same operations are available to agents as MCP tools at https://mcp.g1t.sh. Every name in a request or response body is `snake_case`; names you chose, such as a workflow's inputs or a secret's name, are returned as you wrote them.",
            "license": { "name": "MIT", "identifier": "MIT" },
        },
        "servers": [{ "url": "https://api.g1t.sh" }],
        "security": [{ "token": [] }, {}],
        "tags": tags,
        "paths": paths,
        "components": {
            "securitySchemes": {
                "token": {
                    "type": "http",
                    "scheme": "bearer",
                    "description": "An access token, `g1t_…`. Public data needs none. Each operation names the scope a token needs for it; see https://docs.g1t.sh/guides/authentication/#scopes.",
                },
            },
            "schemas": {
                "Error": {
                    "type": "object",
                    "required": ["error"],
                    "properties": {
                        "error": {
                            "type": "object",
                            "required": ["code", "message"],
                            "properties": {
                                "code": { "type": "string", "enum": codes },
                                "message": { "type": "string" },
                                "needed_scope": {
                                    "type": "string",
                                    "description": "On a 403 for an access token without the scope the call needs: that scope, such as `issues:write`.",
                                },
                            },
                        },
                    },
                },
            },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_route_is_documented_once() {
        let document = document();
        let mut ids = Vec::new();
        for (_, methods) in document["paths"].as_object().unwrap() {
            for (_, operation) in methods.as_object().unwrap() {
                ids.push(operation["operationId"].as_str().unwrap().to_owned());
            }
        }
        for op in Op::ALL {
            assert_eq!(
                ids.iter().filter(|id| *id == op.name()).count(),
                1,
                "{}",
                op.name()
            );
        }
        let mut unique = ids.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), ids.len(), "operation ids repeat");
    }

    #[test]
    fn path_and_query_inputs_are_not_repeated_in_the_body() {
        let document = document();
        let merge = &document["paths"]["/repos/{owner}/{name}/pulls/{number}/merge"]["post"];
        let body = &merge["requestBody"]["content"]["application/json"]["schema"]["properties"];
        assert!(body.get("keep_issue_open").is_some());
        assert!(body.get("repo").is_none() && body.get("number").is_none());
        let list = &document["paths"]["/repos"]["get"];
        assert_eq!(list["parameters"][0]["name"], "q");
        assert!(list.get("requestBody").is_none());
    }

    #[test]
    fn every_operation_is_in_one_section() {
        for op in Op::ALL {
            let sections = SECTIONS
                .iter()
                .filter(|(_, _, ops)| ops.contains(&op))
                .count();
            assert_eq!(sections, 1, "{}", op.name());
        }
    }

    #[test]
    fn titles_read_as_sentences() {
        assert_eq!(title(Op::CreateIssue), "Create an issue");
        assert_eq!(title(Op::Whoami), "Get the current user");
    }

    #[test]
    fn every_operation_has_an_example_response() {
        let examples = examples();
        assert!(!examples.is_empty(), "reference.json does not parse");
        let document = document();
        let mut known = Vec::new();
        for (path, methods) in document["paths"].as_object().unwrap() {
            for (method, operation) in methods.as_object().unwrap() {
                known.push(operation["operationId"].as_str().unwrap().to_owned());
                let example = &operation["responses"]["200"]["content"]["application/json"]["example"];
                assert!(!example.is_null(), "{method} {path} has no example response");
            }
        }
        for id in examples.keys() {
            assert!(known.contains(id), "reference.json names {id}, which is not an operation");
        }
    }

    #[test]
    fn example_requests_send_only_what_the_body_takes() {
        let document = document();
        for (path, methods) in document["paths"].as_object().unwrap() {
            for (method, operation) in methods.as_object().unwrap() {
                let content = &operation["requestBody"]["content"]["application/json"];
                let Some(example) = content["example"].as_object() else { continue };
                let properties = &content["schema"]["properties"];
                for key in example.keys() {
                    assert!(!properties[key].is_null(), "{method} {path}: {key} is not in the body");
                }
            }
        }
    }

    /// The docs site's copy of the document. Run with `G1T_WRITE_OPENAPI=1`
    /// to rewrite it after changing an operation.
    #[test]
    fn the_docs_copy_is_current() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/src/data/openapi.json");
        let current = serde_json::to_string_pretty(&document()).unwrap() + "\n";
        if std::env::var_os("G1T_WRITE_OPENAPI").is_some() {
            std::fs::write(path, &current).unwrap();
            return;
        }
        let copy = std::fs::read_to_string(path).unwrap_or_default().replace("\r\n", "\n");
        assert!(
            copy == current,
            "apps/docs/src/data/openapi.json is out of date: run G1T_WRITE_OPENAPI=1 cargo test -p g1t-api openapi"
        );
    }

    /// The reference shows responses as they are sent: `snake_case`.
    #[test]
    fn example_responses_are_snake_case() {
        let document = document();
        for (path, methods) in document["paths"].as_object().unwrap() {
            for (method, operation) in methods.as_object().unwrap() {
                let example = &operation["responses"]["200"]["content"]["application/json"]["example"];
                let leaked = g1t_kit::wire::camel_case_keys(example);
                assert!(leaked.is_empty(), "{method} {path} shows {leaked:?}");
            }
        }
    }

    /// Examples never hold anything that reads as a real credential, which
    /// secret scanners rightly flag in a public repository: they end in `…`
    /// after the prefix, as `whsec_…` and `g1t_…` do.
    #[test]
    fn examples_hold_no_real_looking_secrets() {
        let prefixes = ["whsec_", "g1t_", "g1tr_", "g1trt_", "sk_live_", "sk_test_", "ghp_", "github_pat_", "xoxb-", "AKIA"];
        for (line, text) in REFERENCE.lines().enumerate() {
            for prefix in prefixes {
                let mut rest = text;
                while let Some(at) = rest.find(prefix) {
                    let after = &rest[at + prefix.len()..];
                    let run = after.chars().take_while(|c| c.is_ascii_alphanumeric()).count();
                    assert!(
                        run < 12,
                        "reference.json line {}: `{prefix}` followed by {run} characters reads as a real secret; write `{prefix}…`",
                        line + 1
                    );
                    rest = after;
                }
            }
        }
    }
}
