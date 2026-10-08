//! REST: each route maps an HTTP request onto one operation.

use serde_json::{Map, Value};

use crate::about::AboutOp;
use crate::operations::Op;
use crate::rules::RulesOp;
use crate::security::SecurityOp;

pub struct Route {
    pub method: &'static str,
    /// Segments starting with `:` are parameters.
    pub path: &'static str,
    pub op: Op,
    /// Query parameters the route reads, as `(name in the URL, input name)`.
    pub query: &'static [(&'static str, &'static str)],
}

const fn route(
    method: &'static str,
    path: &'static str,
    op: Op,
    query: &'static [(&'static str, &'static str)],
) -> Route {
    Route {
        method,
        path,
        op,
        query,
    }
}

pub const ROUTES: &[Route] = &[
    route("GET", "/user", Op::Whoami, &[]),
    route("POST", "/workspaces", Op::CreateWorkspace, &[]),
    route("GET", "/workspaces/:workspace", Op::GetWorkspace, &[]),
    route("DELETE", "/workspaces/:workspace", Op::DeleteWorkspace, &[]),
    route("GET", "/user/emails", Op::ListEmails, &[]),
    route("POST", "/user/emails", Op::AddEmail, &[]),
    route("DELETE", "/user/emails/:email", Op::RemoveEmail, &[]),
    route("PATCH", "/user/email-settings", Op::UpdateEmailSettings, &[]),
    route("GET", "/user/invites", Op::ListInvites, &[]),
    route("POST", "/user/invites", Op::CreateInvite, &[]),
    route("DELETE", "/user/invites/:id", Op::RevokeInvite, &[]),
    route("GET", "/workspaces/:workspace/invitations", Op::ListWorkspaceInvites, &[]),
    route("POST", "/workspaces/:workspace/invitations", Op::InviteMember, &[]),
    route("DELETE", "/workspaces/:workspace/invitations/:id", Op::RevokeWorkspaceInvite, &[]),
    // Who has access. GitHub's addresses, but for adding someone, which
    // takes an email address as well as a username.
    route("GET", "/repos/:owner/:name/collaborators", Op::ListCollaborators, &[]),
    route("POST", "/repos/:owner/:name/collaborators", Op::AddCollaborator, &[]),
    route("PATCH", "/repos/:owner/:name/collaborators/:username", Op::UpdateCollaborator, &[]),
    route("DELETE", "/repos/:owner/:name/collaborators/:username", Op::RemoveCollaborator, &[]),
    route(
        "GET",
        "/repos/:owner/:name/collaborators/:username/permission",
        Op::GetCollaboratorPermission,
        &[],
    ),
    route("GET", "/repos/:owner/:name/invitations", Op::ListRepoInvitations, &[]),
    route("DELETE", "/repos/:owner/:name/invitations/:id", Op::RevokeRepoInvitation, &[]),
    route("GET", "/user/repository_invitations", Op::ListMyRepoInvitations, &[]),
    // Your notifications: threads, marking them, and what you subscribe
    // to and watch. GitHub's addresses, with g1t's saved and snoozed.
    route("GET", "/notifications", Op::ListNotifications, &[("all", "all"), ("participating", "participating"), ("view", "view"), ("reason", "reason"), ("severity", "severity"), ("since", "since"), ("before", "before"), ("cursor", "cursor"), ("per_page", "per_page")]),
    route("PUT", "/notifications", Op::MarkNotificationsRead, &[]),
    route("GET", "/notifications/threads/:id", Op::GetNotificationThread, &[]),
    route("PATCH", "/notifications/threads/:id", Op::MarkThreadRead, &[]),
    route("DELETE", "/notifications/threads/:id", Op::MarkThreadDone, &[]),
    route("PUT", "/notifications/threads/:id/saved", Op::SaveThread, &[]),
    route("DELETE", "/notifications/threads/:id/saved", Op::SaveThread, &[]),
    route("PUT", "/notifications/threads/:id/snooze", Op::SnoozeThread, &[]),
    route("DELETE", "/notifications/threads/:id/snooze", Op::SnoozeThread, &[]),
    route("GET", "/notifications/threads/:id/subscription", Op::GetThreadSubscription, &[]),
    route("PUT", "/notifications/threads/:id/subscription", Op::SetThreadSubscription, &[]),
    route("DELETE", "/notifications/threads/:id/subscription", Op::DeleteThreadSubscription, &[]),
    route("GET", "/repos/:owner/:name/notifications", Op::ListNotifications, &[("all", "all"), ("participating", "participating"), ("view", "view"), ("reason", "reason"), ("severity", "severity"), ("since", "since"), ("before", "before"), ("cursor", "cursor"), ("per_page", "per_page")]),
    route("PUT", "/repos/:owner/:name/notifications", Op::MarkNotificationsRead, &[]),
    route("GET", "/repos/:owner/:name/subscription", Op::GetRepoSubscription, &[]),
    route("PUT", "/repos/:owner/:name/subscription", Op::SetRepoSubscription, &[]),
    route("DELETE", "/repos/:owner/:name/subscription", Op::DeleteRepoSubscription, &[]),
    route("GET", "/repos/:owner/:name/issues/:number/subscription", Op::GetThreadSubscription, &[]),
    route("PUT", "/repos/:owner/:name/issues/:number/subscription", Op::SetThreadSubscription, &[]),
    route("DELETE", "/repos/:owner/:name/issues/:number/subscription", Op::DeleteThreadSubscription, &[]),
    route("GET", "/user/subscriptions", Op::ListWatchedRepos, &[]),
    // Stars: yours, and who starred a repository.
    route("GET", "/user/starred", Op::About(AboutOp::ListStarred), &[]),
    route("GET", "/user/starred/:owner/:name", Op::About(AboutOp::CheckStarred), &[]),
    route("PUT", "/user/starred/:owner/:name", Op::About(AboutOp::Star), &[]),
    route("DELETE", "/user/starred/:owner/:name", Op::About(AboutOp::Unstar), &[]),
    route("GET", "/repos/:owner/:name/stargazers", Op::About(AboutOp::ListStargazers), &[("page", "page")]),
    // What the default branch says about a repository, kept by commit.
    route("GET", "/repos/:owner/:name/languages", Op::About(AboutOp::GetLanguages), &[]),
    route("GET", "/repos/:owner/:name/contributors", Op::About(AboutOp::ListContributors), &[]),
    route("GET", "/repos/:owner/:name/license", Op::About(AboutOp::GetLicense), &[]),
    // Releases: `latest` and `tags/…` before an id.
    route("GET", "/repos/:owner/:name/releases", Op::About(AboutOp::ListReleases), &[]),
    route("POST", "/repos/:owner/:name/releases", Op::About(AboutOp::CreateRelease), &[]),
    route("GET", "/repos/:owner/:name/releases/latest", Op::About(AboutOp::GetLatestRelease), &[]),
    route("GET", "/repos/:owner/:name/releases/tags/:tag", Op::About(AboutOp::GetReleaseByTag), &[]),
    route("GET", "/repos/:owner/:name/releases/:id", Op::About(AboutOp::GetRelease), &[]),
    route("PATCH", "/repos/:owner/:name/releases/:id", Op::About(AboutOp::UpdateRelease), &[]),
    route("DELETE", "/repos/:owner/:name/releases/:id", Op::About(AboutOp::DeleteRelease), &[]),
    // Your pinned projects in a workspace, in your order.
    route("GET", "/user/pinned_projects/:workspace", Op::ListPinnedProjects, &[]),
    route("PUT", "/user/pinned_projects/:workspace", Op::ReorderPinnedProjects, &[]),
    route("PUT", "/user/pinned_projects/:workspace/:project", Op::PinProject, &[]),
    route("DELETE", "/user/pinned_projects/:workspace/:project", Op::UnpinProject, &[]),
    route("PATCH", "/user/repository_invitations/:id", Op::AcceptRepoInvitation, &[]),
    route("DELETE", "/user/repository_invitations/:id", Op::DeclineRepoInvitation, &[]),
    route("PATCH", "/workspaces/:workspace", Op::UpdateWorkspace, &[]),
    route("PUT", "/workspaces/:workspace/base_permission", Op::SetBasePermission, &[]),
    route(
        "GET",
        "/workspaces/:workspace/outside_collaborators",
        Op::ListOutsideCollaborators,
        &[],
    ),
    // Teams: a workspace's groups of members, with roles on repositories.
    route("GET", "/workspaces/:workspace/teams", Op::ListTeams, &[("q", "query")]),
    route("POST", "/workspaces/:workspace/teams", Op::CreateTeam, &[]),
    route("GET", "/workspaces/:workspace/teams/:team", Op::GetTeam, &[]),
    route("PATCH", "/workspaces/:workspace/teams/:team", Op::UpdateTeam, &[]),
    route("DELETE", "/workspaces/:workspace/teams/:team", Op::DeleteTeam, &[]),
    route(
        "GET",
        "/workspaces/:workspace/teams/:team/members",
        Op::ListTeamMembers,
        &[("include_child_teams", "include_child_teams")],
    ),
    route("PUT", "/workspaces/:workspace/teams/:team/members/:username", Op::SetTeamMember, &[]),
    route("DELETE", "/workspaces/:workspace/teams/:team/members/:username", Op::RemoveTeamMember, &[]),
    route("GET", "/workspaces/:workspace/teams/:team/teams", Op::ListChildTeams, &[]),
    route("GET", "/workspaces/:workspace/teams/:team/repos", Op::ListTeamRepos, &[]),
    route("PUT", "/workspaces/:workspace/teams/:team/repos/:repo", Op::SetTeamRepo, &[]),
    route("DELETE", "/workspaces/:workspace/teams/:team/repos/:repo", Op::RemoveTeamRepo, &[]),
    route(
        "PUT",
        "/workspaces/:workspace/teams/:team/review_assignment",
        Op::SetTeamReviewAssignment,
        &[],
    ),
    route("GET", "/workspaces/:workspace/members/:username/teams", Op::ListUserTeams, &[]),
    // A workspace's billing: usage, budget, AI credit and invoices.
    route(
        "GET",
        "/workspaces/:workspace/usage",
        Op::GetUsage,
        &[("from", "from"), ("until", "until"), ("products", "products"), ("projects", "projects"), ("group_by", "group_by")],
    ),
    route("GET", "/workspaces/:workspace/budget", Op::GetBudget, &[]),
    route("PUT", "/workspaces/:workspace/budget", Op::SetBudget, &[]),
    route("GET", "/workspaces/:workspace/ai_credit", Op::GetAiCredit, &[]),
    route("POST", "/workspaces/:workspace/ai_credit/checkout", Op::BuyAiCredit, &[]),
    route("GET", "/workspaces/:workspace/invoices", Op::ListInvoices, &[]),
    route("GET", "/workspaces/:workspace/billing_details", Op::GetBillingDetails, &[]),
    // The AI Gateway's log of a workspace's requests.
    route("GET", "/workspaces/:workspace/gateway/requests", Op::ListGatewayRequests, &[("limit", "limit"), ("before", "before")]),
    // Code owners: the CODEOWNERS file, checked.
    route("GET", "/repos/:owner/:name/codeowners/errors", Op::GetCodeownersErrors, &[("ref", "ref")]),
    // Security alerts: secrets and vulnerable dependencies.
    route(
        "GET",
        "/repos/:owner/:name/security/alerts",
        Op::ListSecurityAlerts,
        &[("state", "state"), ("kind", "kind")],
    ),
    route("POST", "/repos/:owner/:name/security/alerts/:id/dismiss", Op::DismissSecurityAlert, &[]),
    route("POST", "/repos/:owner/:name/security/alerts/:id/reopen", Op::ReopenSecurityAlert, &[]),
    // The security suite: secret scanning, code scanning, vulnerability
    // alerts and the supply chain, at the common addresses.
    route("GET", "/repos/:owner/:name/secret-scanning/alerts", Op::Security(SecurityOp::ListSecretAlerts), &[("state", "state"), ("secret_type", "secret_type"), ("validity", "validity"), ("bypassed", "bypassed")]),
    route("GET", "/workspaces/:workspace/secret-scanning/alerts", Op::Security(SecurityOp::ListSecretAlerts), &[("state", "state"), ("secret_type", "secret_type"), ("validity", "validity"), ("bypassed", "bypassed")]),
    route("GET", "/repos/:owner/:name/secret-scanning/alerts/:id", Op::Security(SecurityOp::GetSecretAlert), &[]),
    route("PATCH", "/repos/:owner/:name/secret-scanning/alerts/:id", Op::Security(SecurityOp::UpdateSecretAlert), &[]),
    route("GET", "/repos/:owner/:name/secret-scanning/alerts/:id/locations", Op::Security(SecurityOp::ListSecretLocations), &[]),
    route("POST", "/repos/:owner/:name/secret-scanning/alerts/:id/bypass", Op::Security(SecurityOp::BypassPushProtection), &[]),
    route("POST", "/repos/:owner/:name/secret-scanning/alerts/:id/validity", Op::Security(SecurityOp::CheckSecretValidity), &[]),
    route("GET", "/workspaces/:workspace/secret-scanning/bypass-requests", Op::Security(SecurityOp::ListBypassRequests), &[("state", "state"), ("repo", "repo")]),
    route("PATCH", "/workspaces/:workspace/secret-scanning/bypass-requests/:id", Op::Security(SecurityOp::ReviewBypassRequest), &[]),
    route("POST", "/repos/:owner/:name/secret-scanning/custom-patterns/dry-run", Op::Security(SecurityOp::DryRunCustomPattern), &[]),
    route("POST", "/workspaces/:workspace/secret-scanning/custom-patterns/dry-run", Op::Security(SecurityOp::DryRunCustomPattern), &[]),
    route("GET", "/repos/:owner/:name/secret-scanning/custom-patterns", Op::Security(SecurityOp::ListCustomPatterns), &[]),
    route("GET", "/workspaces/:workspace/secret-scanning/custom-patterns", Op::Security(SecurityOp::ListCustomPatterns), &[]),
    route("POST", "/repos/:owner/:name/secret-scanning/custom-patterns", Op::Security(SecurityOp::CreateCustomPattern), &[]),
    route("POST", "/workspaces/:workspace/secret-scanning/custom-patterns", Op::Security(SecurityOp::CreateCustomPattern), &[]),
    route("PATCH", "/repos/:owner/:name/secret-scanning/custom-patterns/:id", Op::Security(SecurityOp::UpdateCustomPattern), &[]),
    route("PATCH", "/workspaces/:workspace/secret-scanning/custom-patterns/:id", Op::Security(SecurityOp::UpdateCustomPattern), &[]),
    route("DELETE", "/repos/:owner/:name/secret-scanning/custom-patterns/:id", Op::Security(SecurityOp::DeleteCustomPattern), &[]),
    route("DELETE", "/workspaces/:workspace/secret-scanning/custom-patterns/:id", Op::Security(SecurityOp::DeleteCustomPattern), &[]),
    route("GET", "/repos/:owner/:name/code-scanning/alerts", Op::Security(SecurityOp::ListCodeAlerts), &[("state", "state"), ("severity", "severity"), ("tool", "tool"), ("rule_id", "rule_id")]),
    route("GET", "/workspaces/:workspace/code-scanning/alerts", Op::Security(SecurityOp::ListCodeAlerts), &[("state", "state"), ("severity", "severity"), ("tool", "tool"), ("rule_id", "rule_id")]),
    route("GET", "/repos/:owner/:name/code-scanning/alerts/:number", Op::Security(SecurityOp::GetCodeAlert), &[]),
    route("PATCH", "/repos/:owner/:name/code-scanning/alerts/:number", Op::Security(SecurityOp::UpdateCodeAlert), &[]),
    route("GET", "/repos/:owner/:name/code-scanning/analyses", Op::Security(SecurityOp::ListAnalyses), &[]),
    route("POST", "/repos/:owner/:name/code-scanning/sarifs", Op::Security(SecurityOp::UploadSarif), &[]),
    route("GET", "/repos/:owner/:name/code-scanning/sarifs/:id", Op::Security(SecurityOp::GetSarifUpload), &[]),
    route("GET", "/repos/:owner/:name/vulnerability-alerts", Op::Security(SecurityOp::ListVulnerabilityAlerts), &[("state", "state"), ("severity", "severity"), ("ecosystem", "ecosystem"), ("package", "package")]),
    route("GET", "/workspaces/:workspace/vulnerability-alerts", Op::Security(SecurityOp::ListVulnerabilityAlerts), &[("state", "state"), ("severity", "severity"), ("ecosystem", "ecosystem"), ("package", "package")]),
    route("GET", "/repos/:owner/:name/vulnerability-alerts/:id", Op::Security(SecurityOp::GetVulnerabilityAlert), &[]),
    route("PATCH", "/repos/:owner/:name/vulnerability-alerts/:id", Op::Security(SecurityOp::UpdateVulnerabilityAlert), &[]),
    route("POST", "/repos/:owner/:name/security/alerts/:id/fix", Op::Security(SecurityOp::FixAlert), &[]),
    route("GET", "/repos/:owner/:name/dependency-graph", Op::Security(SecurityOp::GetDependencyGraph), &[]),
    route("GET", "/repos/:owner/:name/dependency-graph/sbom", Op::Security(SecurityOp::GetSbom), &[]),
    route("GET", "/repos/:owner/:name/dependency-graph/compare/:basehead", Op::Security(SecurityOp::CompareDependencies), &[]),
    route("GET", "/repos/:owner/:name/security/settings", Op::Security(SecurityOp::GetSettings), &[]),
    route("PATCH", "/repos/:owner/:name/security/settings", Op::Security(SecurityOp::UpdateSettings), &[]),
    route("GET", "/workspaces/:workspace/security/settings", Op::Security(SecurityOp::GetWorkspaceSettings), &[]),
    route("PATCH", "/workspaces/:workspace/security/settings", Op::Security(SecurityOp::UpdateWorkspaceSettings), &[]),
    route("GET", "/workspaces/:workspace/security/overview", Op::Security(SecurityOp::GetOverview), &[("days", "days")]),
    route("GET", "/repos", Op::ListRepos, &[("q", "query")]),
    route(
        "GET",
        "/search",
        Op::Search,
        &[("q", "query"), ("type", "type"), ("page", "page"), ("per_page", "per_page")],
    ),
    route("POST", "/repos", Op::CreateRepo, &[]),
    route("GET", "/repos/:owner/:name", Op::GetRepo, &[]),
    route("PATCH", "/repos/:owner/:name", Op::UpdateRepo, &[]),
    route("POST", "/repos/:owner/:name/transfer", Op::TransferRepo, &[]),
    route("DELETE", "/repos/:owner/:name", Op::DeleteRepo, &[]),
    route(
        "GET",
        "/workspaces/:workspace/repos/deleted",
        Op::ListDeletedRepos,
        &[],
    ),
    route("POST", "/repos/:owner/:name/restore", Op::RestoreRepo, &[]),
    route("POST", "/repos/:owner/:name/purge", Op::PurgeRepo, &[]),
    route("POST", "/repos/:owner/:name/rename", Op::RenameRepo, &[]),
    route("POST", "/repos/:owner/:name/archive", Op::ArchiveRepo, &[]),
    route("POST", "/repos/:owner/:name/unarchive", Op::UnarchiveRepo, &[]),
    route(
        "POST",
        "/repos/:owner/:name/visibility",
        Op::SetRepoVisibility,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/branches/:branch/rename",
        Op::RenameBranch,
        &[],
    ),
    route(
        "GET",
        "/repos/:owner/:name/settings",
        Op::GetRepoSettings,
        &[],
    ),
    route(
        "PATCH",
        "/repos/:owner/:name/settings",
        Op::UpdateRepoSettings,
        &[],
    ),
    route("GET", "/repos/:owner/:name/check-names", Op::ListCheckNames, &[]),
    // Rulesets: a repository's, a workspace's, the rules of one branch,
    // and how they judged pushes and merges.
    route("GET", "/repos/:owner/:name/rulesets", Op::Rules(RulesOp::ListRepoRulesets), &[("include_parents", "include_parents")]),
    route("POST", "/repos/:owner/:name/rulesets", Op::Rules(RulesOp::CreateRepoRuleset), &[]),
    route("GET", "/repos/:owner/:name/rulesets/:id", Op::Rules(RulesOp::GetRepoRuleset), &[]),
    route("PUT", "/repos/:owner/:name/rulesets/:id", Op::Rules(RulesOp::UpdateRepoRuleset), &[]),
    route("DELETE", "/repos/:owner/:name/rulesets/:id", Op::Rules(RulesOp::DeleteRepoRuleset), &[]),
    route("GET", "/repos/:owner/:name/rules/branches/:branch", Op::Rules(RulesOp::GetBranchRules), &[("target", "target")]),
    route(
        "GET",
        "/repos/:owner/:name/rules/evaluations",
        Op::Rules(RulesOp::ListRuleEvaluations),
        &[("ruleset_id", "ruleset_id"), ("verdict", "verdict"), ("problems_only", "problems_only"), ("before", "before"), ("limit", "limit")],
    ),
    route("GET", "/workspaces/:workspace/rulesets", Op::Rules(RulesOp::ListWorkspaceRulesets), &[]),
    route("POST", "/workspaces/:workspace/rulesets", Op::Rules(RulesOp::CreateWorkspaceRuleset), &[]),
    route("GET", "/workspaces/:workspace/rulesets/:id", Op::Rules(RulesOp::GetWorkspaceRuleset), &[]),
    route("PUT", "/workspaces/:workspace/rulesets/:id", Op::Rules(RulesOp::UpdateWorkspaceRuleset), &[]),
    route("DELETE", "/workspaces/:workspace/rulesets/:id", Op::Rules(RulesOp::DeleteWorkspaceRuleset), &[]),
    route(
        "GET",
        "/workspaces/:workspace/rules/evaluations",
        Op::Rules(RulesOp::ListWorkspaceRuleEvaluations),
        &[("ruleset_id", "ruleset_id"), ("verdict", "verdict"), ("problems_only", "problems_only"), ("before", "before"), ("limit", "limit")],
    ),
    route("GET", "/repos/:owner/:name/queue", Op::GetMergeQueue, &[]),
    route(
        "POST",
        "/repos/:owner/:name/pulls/:number/messages",
        Op::MessageAgent,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/pulls/:number/messages/take",
        Op::TakeMessages,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/messages/:id/answer",
        Op::AnswerMessage,
        &[],
    ),
    route("POST", "/repos/:owner/:name/memory", Op::Remember, &[]),
    route(
        "GET",
        "/repos/:owner/:name/memory",
        Op::Recall,
        &[("q", "query"), ("limit", "limit")],
    ),
    route(
        "GET",
        "/repos/:owner/:name/events",
        Op::ListEvents,
        &[("before", "before")],
    ),
    route("GET", "/repos/:owner/:name/labels", Op::ListLabels, &[]),
    route("POST", "/repos/:owner/:name/labels", Op::CreateLabel, &[]),
    route("POST", "/repos/:owner/:name/labels/defaults", Op::AddDefaultLabels, &[]),
    route("PATCH", "/repos/:owner/:name/labels/:label", Op::UpdateLabel, &[]),
    route("DELETE", "/repos/:owner/:name/labels/:label", Op::DeleteLabel, &[]),
    route("GET", "/repos/:owner/:name/issues/:number/labels", Op::ListIssueLabels, &[]),
    route("POST", "/repos/:owner/:name/issues/:number/labels", Op::AddIssueLabels, &[]),
    route("PUT", "/repos/:owner/:name/issues/:number/labels", Op::SetIssueLabels, &[]),
    route("DELETE", "/repos/:owner/:name/issues/:number/labels", Op::RemoveIssueLabels, &[]),
    route("DELETE", "/repos/:owner/:name/issues/:number/labels/:label", Op::RemoveIssueLabels, &[]),
    route("GET", "/repos/:owner/:name/milestones", Op::ListMilestones, &[("state", "state")]),
    route("POST", "/repos/:owner/:name/milestones", Op::CreateMilestone, &[]),
    route("GET", "/repos/:owner/:name/milestones/:milestone", Op::GetMilestone, &[]),
    route("PATCH", "/repos/:owner/:name/milestones/:milestone", Op::UpdateMilestone, &[]),
    route("DELETE", "/repos/:owner/:name/milestones/:milestone", Op::DeleteMilestone, &[]),
    route(
        "GET",
        "/repos/:owner/:name/issues",
        Op::ListIssues,
        &[("state", "state"), ("label", "label"), ("milestone", "milestone")],
    ),
    route("POST", "/repos/:owner/:name/issues", Op::CreateIssue, &[]),
    route(
        "GET",
        "/repos/:owner/:name/issues/:number",
        Op::GetIssue,
        &[],
    ),
    route(
        "PATCH",
        "/repos/:owner/:name/issues/:number",
        Op::UpdateIssue,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/issues/:number/close",
        Op::CloseIssue,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/issues/:number/reopen",
        Op::ReopenIssue,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/issues/:number/assign",
        Op::AssignIssue,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/issues/import",
        Op::ImportIssue,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/issues/delegate",
        Op::Delegate,
        &[],
    ),
    route(
        "GET",
        "/repos/:owner/:name/context",
        Op::GetContext,
        &[("reference", "reference")],
    ),
    route(
        "GET",
        "/workspaces/:workspace/context/search",
        Op::SearchContext,
        &[("q", "query"), ("project", "project"), ("kinds", "kinds"), ("limit", "limit")],
    ),
    route(
        "GET",
        "/workspaces/:workspace/context/:kind/:id",
        Op::GetEntity,
        &[],
    ),
    route(
        "GET",
        "/workspaces/:workspace/integrations",
        Op::ListIntegrations,
        &[],
    ),
    route(
        "POST",
        "/workspaces/:workspace/integrations",
        Op::ConnectIntegration,
        &[],
    ),
    route(
        "GET",
        "/repos/:owner/:name/hooks",
        Op::ListWebhooks,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/hooks",
        Op::CreateWebhook,
        &[],
    ),
    route(
        "PATCH",
        "/repos/:owner/:name/hooks/:id",
        Op::UpdateWebhook,
        &[],
    ),
    route(
        "DELETE",
        "/repos/:owner/:name/hooks/:id",
        Op::DeleteWebhook,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/hooks/:id/pings",
        Op::PingWebhook,
        &[],
    ),
    route(
        "GET",
        "/repos/:owner/:name/hooks/:id/deliveries",
        Op::ListWebhookDeliveries,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/hooks/:id/deliveries/:delivery/redeliver",
        Op::RedeliverWebhook,
        &[],
    ),
    route(
        "GET",
        "/workspaces/:workspace/hooks",
        Op::ListWebhooks,
        &[],
    ),
    route(
        "POST",
        "/workspaces/:workspace/hooks",
        Op::CreateWebhook,
        &[],
    ),
    route(
        "PATCH",
        "/workspaces/:workspace/hooks/:id",
        Op::UpdateWebhook,
        &[],
    ),
    route(
        "DELETE",
        "/workspaces/:workspace/hooks/:id",
        Op::DeleteWebhook,
        &[],
    ),
    route(
        "POST",
        "/workspaces/:workspace/hooks/:id/pings",
        Op::PingWebhook,
        &[],
    ),
    route(
        "GET",
        "/workspaces/:workspace/hooks/:id/deliveries",
        Op::ListWebhookDeliveries,
        &[],
    ),
    route(
        "POST",
        "/workspaces/:workspace/hooks/:id/deliveries/:delivery/redeliver",
        Op::RedeliverWebhook,
        &[],
    ),
    route(
        "GET",
        "/workspaces/:workspace/model-routes",
        Op::GetModelRoutes,
        &[],
    ),
    route(
        "PUT",
        "/workspaces/:workspace/model-routes",
        Op::SetModelRoutes,
        &[],
    ),
    route(
        "DELETE",
        "/workspaces/:workspace/integrations/:id",
        Op::DisconnectIntegration,
        &[],
    ),
    route(
        "POST",
        "/workspaces/:workspace/integrations/:id/test",
        Op::TestIntegration,
        &[],
    ),
    route(
        "GET",
        "/repos/:owner/:name/actions/workflows",
        Op::ListWorkflows,
        &[],
    ),
    route(
        "GET",
        "/repos/:owner/:name/actions/workflows/:workflow/runs",
        Op::ListWorkflowRuns,
        &[("branch", "branch"), ("event", "event"), ("per_page", "limit")],
    ),
    route(
        "POST",
        "/repos/:owner/:name/actions/workflows/:workflow/dispatches",
        Op::DispatchWorkflow,
        &[],
    ),
    route(
        "PATCH",
        "/repos/:owner/:name/actions/workflows/:workflow",
        Op::UpdateWorkflow,
        &[],
    ),
    route(
        "PUT",
        "/repos/:owner/:name/actions/workflows/:workflow/enable",
        Op::UpdateWorkflow,
        &[],
    ),
    route(
        "PUT",
        "/repos/:owner/:name/actions/workflows/:workflow/disable",
        Op::UpdateWorkflow,
        &[],
    ),
    route(
        "GET",
        "/repos/:owner/:name/actions/runs",
        Op::ListWorkflowRuns,
        &[("workflow", "workflow"), ("branch", "branch"), ("event", "event"), ("pull", "pull"), ("head_sha", "sha"), ("per_page", "limit")],
    ),
    route(
        "GET",
        "/repos/:owner/:name/actions/runs/:id",
        Op::GetWorkflowRun,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/actions/runs/:id/cancel",
        Op::CancelWorkflowRun,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/actions/runs/:id/rerun",
        Op::RerunWorkflowRun,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/actions/runs/:id/rerun-failed-jobs",
        Op::RerunWorkflowRun,
        &[],
    ),
    route(
        "GET",
        "/repos/:owner/:name/actions/jobs/:job/logs",
        Op::GetJobLogs,
        &[("after", "after")],
    ),
    route(
        "GET",
        "/repos/:owner/:name/actions/secrets",
        Op::ListActionsSecrets,
        &[],
    ),
    route(
        "PUT",
        "/repos/:owner/:name/actions/secrets/:setting",
        Op::SetActionsSecret,
        &[],
    ),
    route(
        "DELETE",
        "/repos/:owner/:name/actions/secrets/:setting",
        Op::DeleteActionsSecret,
        &[],
    ),
    route(
        "GET",
        "/repos/:owner/:name/actions/variables",
        Op::ListActionsVariables,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/actions/variables",
        Op::SetActionsVariable,
        &[],
    ),
    route(
        "PATCH",
        "/repos/:owner/:name/actions/variables/:setting",
        Op::SetActionsVariable,
        &[],
    ),
    route(
        "DELETE",
        "/repos/:owner/:name/actions/variables/:setting",
        Op::DeleteActionsVariable,
        &[],
    ),
    route(
        "GET",
        "/workspaces/:workspace/actions/secrets",
        Op::ListActionsSecrets,
        &[],
    ),
    route(
        "PUT",
        "/workspaces/:workspace/actions/secrets/:setting",
        Op::SetActionsSecret,
        &[],
    ),
    route(
        "DELETE",
        "/workspaces/:workspace/actions/secrets/:setting",
        Op::DeleteActionsSecret,
        &[],
    ),
    route(
        "GET",
        "/workspaces/:workspace/actions/variables",
        Op::ListActionsVariables,
        &[],
    ),
    route(
        "POST",
        "/workspaces/:workspace/actions/variables",
        Op::SetActionsVariable,
        &[],
    ),
    route(
        "PATCH",
        "/workspaces/:workspace/actions/variables/:setting",
        Op::SetActionsVariable,
        &[],
    ),
    route(
        "DELETE",
        "/workspaces/:workspace/actions/variables/:setting",
        Op::DeleteActionsVariable,
        &[],
    ),
    // Self-hosted runners: a repository's own, or a workspace's.
    route("GET", "/repos/:owner/:name/actions/runners", Op::ListRunners, &[]),
    route("POST", "/repos/:owner/:name/actions/runners/registration-token", Op::CreateRunnerRegistrationToken, &[]),
    route("DELETE", "/repos/:owner/:name/actions/runners/:id", Op::RemoveRunner, &[]),
    route("GET", "/repos/:owner/:name/actions/runner-settings", Op::GetRunnerSettings, &[]),
    route("PATCH", "/repos/:owner/:name/actions/runner-settings", Op::UpdateRunnerSettings, &[]),
    route("GET", "/workspaces/:workspace/actions/runners", Op::ListRunners, &[]),
    route("POST", "/workspaces/:workspace/actions/runners/registration-token", Op::CreateRunnerRegistrationToken, &[]),
    route("DELETE", "/workspaces/:workspace/actions/runners/:id", Op::RemoveRunner, &[]),
    route("GET", "/workspaces/:workspace/actions/runner-settings", Op::GetRunnerSettings, &[]),
    route("PATCH", "/workspaces/:workspace/actions/runner-settings", Op::UpdateRunnerSettings, &[]),
    route("GET", "/workspaces/:workspace/actions/runner-groups", Op::ListRunnerGroups, &[]),
    route("POST", "/workspaces/:workspace/actions/runner-groups", Op::CreateRunnerGroup, &[]),
    route("PATCH", "/workspaces/:workspace/actions/runner-groups/:id", Op::UpdateRunnerGroup, &[]),
    route("DELETE", "/workspaces/:workspace/actions/runner-groups/:id", Op::DeleteRunnerGroup, &[]),
    route("POST", "/repos/:owner/:name/plans", Op::PlanWork, &[]),
    route("GET", "/repos/:owner/:name/plans/:plan", Op::GetPlan, &[]),
    route(
        "POST",
        "/repos/:owner/:name/plans/:plan/apply",
        Op::ApplyPlan,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/issues/:number/comments",
        Op::AddComment,
        &[],
    ),
    route(
        "GET",
        "/repos/:owner/:name/pulls",
        Op::ListPullRequests,
        &[("state", "state"), ("label", "label"), ("milestone", "milestone"), ("base", "base")],
    ),
    route(
        "POST",
        "/repos/:owner/:name/pulls",
        Op::CreatePullRequest,
        &[],
    ),
    route(
        "GET",
        "/repos/:owner/:name/pulls/:number",
        Op::GetPullRequest,
        &[],
    ),
    route(
        "PATCH",
        "/repos/:owner/:name/pulls/:number",
        Op::UpdatePullRequest,
        &[],
    ),
    route(
        "GET",
        "/repos/:owner/:name/pulls/:number/changes",
        Op::GetPullRequestChanges,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/pulls/:number/reviews",
        Op::ReviewPullRequest,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/pulls/:number/requested_reviewers",
        Op::RequestReviewers,
        &[],
    ),
    route(
        "DELETE",
        "/repos/:owner/:name/pulls/:number/requested_reviewers",
        Op::RemoveRequestedReviewers,
        &[],
    ),
    route(
        "GET",
        "/repos/:owner/:name/pulls/:number/session",
        Op::ReadSession,
        &[("after", "after")],
    ),
    route(
        "POST",
        "/repos/:owner/:name/pulls/:number/session",
        Op::RecordSession,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/pulls/:number/ready",
        Op::MarkPullRequestReady,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/pulls/:number/close",
        Op::ClosePullRequest,
        &[],
    ),
    route(
        "POST",
        "/repos/:owner/:name/pulls/:number/merge",
        Op::MergePullRequest,
        &[],
    ),
];

impl Route {
    /// The names of the route's path parameters, in order.
    pub fn params(&self) -> impl Iterator<Item = &'static str> {
        self.path
            .split('/')
            .filter_map(|segment| segment.strip_prefix(':'))
    }

    /// The values of the path parameters, if `path` is this route's.
    fn matches<'a>(&self, path: &'a str) -> Option<Vec<(&'static str, &'a str)>> {
        let mut values = Vec::new();
        let mut actual = path.trim_end_matches('/').split('/');
        for expected in self.path.split('/') {
            let segment = actual.next()?;
            match expected.strip_prefix(':') {
                Some(name) if !segment.is_empty() => values.push((name, segment)),
                Some(_) => return None,
                None if expected == segment => {}
                None => return None,
            }
        }
        actual.next().is_none().then_some(values)
    }
}

/// A path segment with its `%XX` escapes decoded; as given when that is not
/// UTF-8.
fn percent_decoded(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escaped = (bytes[i] == b'%')
            .then(|| segment.get(i + 1..i + 3))
            .flatten()
            .filter(|hex| hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match escaped {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| segment.to_owned())
}

/// The route for a request, and the operation input it describes.
///
/// The input is the JSON body, overlaid with the query parameters the route
/// reads and then with what the path names: `owner` and `name` become
/// `repo`, as does a team's `repo` with its `workspace`, and `number`
/// becomes an integer.
pub fn resolve(
    method: &str,
    path: &str,
    query: &[(String, String)],
    body: Value,
) -> Option<(&'static Route, Value)> {
    let (route, params) = ROUTES
        .iter()
        .filter(|route| route.method == method)
        .find_map(|route| Some((route, route.matches(path)?)))?;

    let mut input = match body {
        Value::Object(fields) => fields,
        _ => Map::new(),
    };
    for (name, key) in route.query {
        if let Some((_, value)) = query.iter().find(|(query_name, _)| query_name == name) {
            input.insert((*key).to_owned(), Value::String(value.clone()));
        }
    }
    let param = |wanted: &str| {
        params
            .iter()
            .find(|(name, _)| *name == wanted)
            .map(|(_, value)| *value)
    };
    if let (Some(owner), Some(name)) = (param("owner"), param("name")) {
        input.insert("repo".to_owned(), Value::String(format!("{owner}/{name}")));
    }
    for key in ["plan", "id", "workspace", "delivery", "workflow", "job", "setting", "username", "team", "basehead"] {
        if let Some(value) = param(key) {
            input.insert(key.to_owned(), Value::String(value.to_owned()));
        }
    }
    // A repository of a team's workspace, named by itself.
    if let (Some(workspace), Some(name)) = (param("workspace"), param("repo")) {
        input.insert("repo".to_owned(), Value::String(format!("{workspace}/{name}")));
    }
    // A branch name may hold slashes, sent URL-encoded as one segment, and
    // a label's name spaces.
    if let Some(branch) = param("branch") {
        input.insert("branch".to_owned(), Value::String(percent_decoded(branch)));
    }
    if let Some(label) = param("label") {
        input.insert("label".to_owned(), Value::String(percent_decoded(label)));
    }
    if let Some(milestone) = param("milestone") {
        // Not a number: zero, which no milestone has.
        input.insert("milestone".to_owned(), milestone.parse::<u32>().unwrap_or(0).into());
    }
    // GitHub says some things with the path alone.
    if route.path.ends_with("/enable") || route.path.ends_with("/disable") {
        input.insert("enabled".to_owned(), Value::Bool(route.path.ends_with("/enable")));
    }
    if route.path.ends_with("/rerun-failed-jobs") {
        input.insert("failed_only".to_owned(), Value::Bool(true));
    }
    // Unsaving and waking a thread are a DELETE of what PUT made.
    if route.method == "DELETE" && route.path.ends_with("/saved") {
        input.insert("saved".to_owned(), Value::Bool(false));
    }
    if route.method == "DELETE" && route.path.ends_with("/snooze") {
        input.remove("until");
    }
    if let Some(number) = param("number") {
        // Not a number: zero, which no issue or pull request has.
        input.insert(
            "number".to_owned(),
            number.parse::<u32>().unwrap_or(0).into(),
        );
    }
    Some((route, Value::Object(input)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_path_resolves_to_its_operation_and_input() {
        let (route, input) = resolve(
            "POST",
            "/repos/flagon-io/hello/pulls/14/merge",
            &[],
            json!({ "keep_issue_open": true, "number": 99, "repo": "someone/else" }),
        )
        .unwrap();
        assert_eq!(route.op, Op::MergePullRequest);
        // What the path names wins over the body.
        assert_eq!(
            input,
            json!({ "keep_issue_open": true, "number": 14, "repo": "flagon-io/hello" })
        );
    }

    #[test]
    fn a_branch_with_slashes_is_one_encoded_segment() {
        let (route, input) = resolve(
            "POST",
            "/repos/flagon-io/hello/branches/feature%2Flogin/rename",
            &[],
            json!({ "new_name": "feature/sign-in" }),
        )
        .unwrap();
        assert_eq!(route.op, Op::RenameBranch);
        assert_eq!(
            input,
            json!({ "new_name": "feature/sign-in", "branch": "feature/login", "repo": "flagon-io/hello" })
        );
        assert_eq!(percent_decoded("100%"), "100%");
        assert_eq!(percent_decoded("a%2bb%zz"), "a+b%zz");
    }

    #[test]
    fn a_collaborator_is_named_by_username() {
        let (route, input) = resolve(
            "PATCH",
            "/repos/flagon-io/hello/collaborators/ada",
            &[],
            json!({ "role": "maintain" }),
        )
        .unwrap();
        assert_eq!(route.op, Op::UpdateCollaborator);
        assert_eq!(input, json!({ "role": "maintain", "username": "ada", "repo": "flagon-io/hello" }));
        let (route, input) = resolve("DELETE", "/user/repository_invitations/rin_1", &[], Value::Null).unwrap();
        assert_eq!(route.op, Op::DeclineRepoInvitation);
        assert_eq!(input, json!({ "id": "rin_1" }));
    }

    #[test]
    fn teams_are_addressed_by_workspace_and_slug() {
        let query = [("q".to_owned(), "back".to_owned())];
        let (route, input) = resolve("GET", "/workspaces/acme/teams", &query, Value::Null).unwrap();
        assert_eq!(route.op, Op::ListTeams);
        assert_eq!(input, json!({ "query": "back", "workspace": "acme" }));
        let (route, input) = resolve("PATCH", "/workspaces/acme/teams/backend", &[], json!({ "name": "Back end" })).unwrap();
        assert_eq!(route.op, Op::UpdateTeam);
        assert_eq!(input, json!({ "name": "Back end", "workspace": "acme", "team": "backend" }));
        let (route, input) =
            resolve("PUT", "/workspaces/acme/teams/backend/members/ana", &[], json!({ "role": "maintainer" })).unwrap();
        assert_eq!(route.op, Op::SetTeamMember);
        assert_eq!(input, json!({ "role": "maintainer", "workspace": "acme", "team": "backend", "username": "ana" }));
        let query = [("include_child_teams".to_owned(), "true".to_owned())];
        let (route, input) = resolve("GET", "/workspaces/acme/teams/backend/members", &query, Value::Null).unwrap();
        assert_eq!(route.op, Op::ListTeamMembers);
        assert_eq!(input, json!({ "include_child_teams": "true", "workspace": "acme", "team": "backend" }));
        // A repository is named by itself, in the team's workspace.
        let (route, input) =
            resolve("PUT", "/workspaces/acme/teams/backend/repos/rocket", &[], json!({ "role": "write" })).unwrap();
        assert_eq!(route.op, Op::SetTeamRepo);
        assert_eq!(input, json!({ "role": "write", "workspace": "acme", "team": "backend", "repo": "acme/rocket" }));
        let op = |method: &str, path: &str| resolve(method, path, &[], Value::Null).unwrap().0.op;
        assert_eq!(op("DELETE", "/workspaces/acme/teams/backend/repos/rocket"), Op::RemoveTeamRepo);
        assert_eq!(op("GET", "/workspaces/acme/teams/backend/teams"), Op::ListChildTeams);
        assert_eq!(op("GET", "/workspaces/acme/teams/backend/repos"), Op::ListTeamRepos);
        assert_eq!(op("PUT", "/workspaces/acme/teams/backend/review_assignment"), Op::SetTeamReviewAssignment);
        assert_eq!(op("DELETE", "/workspaces/acme/teams/backend"), Op::DeleteTeam);
        assert_eq!(op("POST", "/workspaces/acme/teams"), Op::CreateTeam);
        assert_eq!(op("GET", "/workspaces/acme/teams/backend"), Op::GetTeam);
        assert_eq!(op("DELETE", "/workspaces/acme/teams/backend/members/ana"), Op::RemoveTeamMember);
        let (route, input) = resolve("GET", "/workspaces/acme/members/ana/teams", &[], Value::Null).unwrap();
        assert_eq!(route.op, Op::ListUserTeams);
        assert_eq!(input, json!({ "workspace": "acme", "username": "ana" }));
    }

    #[test]
    fn reviewers_are_requested_and_code_owners_checked_on_a_repository() {
        let body = json!({ "reviewers": ["ana"], "team_reviewers": ["backend"] });
        let (route, input) = resolve("POST", "/repos/acme/rocket/pulls/7/requested_reviewers", &[], body.clone()).unwrap();
        assert_eq!(route.op, Op::RequestReviewers);
        assert_eq!(
            input,
            json!({ "reviewers": ["ana"], "team_reviewers": ["backend"], "repo": "acme/rocket", "number": 7 })
        );
        let (route, _) = resolve("DELETE", "/repos/acme/rocket/pulls/7/requested_reviewers", &[], body).unwrap();
        assert_eq!(route.op, Op::RemoveRequestedReviewers);
        let query = [("ref".to_owned(), "main".to_owned())];
        let (route, input) = resolve("GET", "/repos/acme/rocket/codeowners/errors", &query, Value::Null).unwrap();
        assert_eq!(route.op, Op::GetCodeownersErrors);
        assert_eq!(input, json!({ "ref": "main", "repo": "acme/rocket" }));
    }

    #[test]
    fn notifications_are_addressed_as_threads_and_by_issue() {
        let (route, input) = resolve("DELETE", "/notifications/threads/ntf_1", &[], Value::Null).unwrap();
        assert_eq!(route.op, Op::MarkThreadDone);
        assert_eq!(input, json!({ "id": "ntf_1" }));
        let (route, input) = resolve("DELETE", "/notifications/threads/ntf_1/saved", &[], Value::Null).unwrap();
        assert_eq!(route.op, Op::SaveThread);
        assert_eq!(input, json!({ "id": "ntf_1", "saved": false }));
        let (route, input) = resolve("DELETE", "/notifications/threads/ntf_1/snooze", &[], json!({ "until": "x" })).unwrap();
        assert_eq!(route.op, Op::SnoozeThread);
        assert_eq!(input, json!({ "id": "ntf_1" }));
        let query = [("all".to_owned(), "true".to_owned()), ("per_page".to_owned(), "50".to_owned())];
        let (route, input) = resolve("GET", "/repos/acme/rocket/notifications", &query, Value::Null).unwrap();
        assert_eq!(route.op, Op::ListNotifications);
        assert_eq!(input, json!({ "all": "true", "per_page": "50", "repo": "acme/rocket" }));
        let (route, input) = resolve("PUT", "/repos/acme/rocket/issues/7/subscription", &[], json!({ "ignored": true })).unwrap();
        assert_eq!(route.op, Op::SetThreadSubscription);
        assert_eq!(input, json!({ "ignored": true, "number": 7, "repo": "acme/rocket" }));
        assert_eq!(resolve("GET", "/user/subscriptions", &[], Value::Null).unwrap().0.op, Op::ListWatchedRepos);
    }

    #[test]
    fn labels_and_milestones_are_named_in_the_path() {
        let (route, input) = resolve("PATCH", "/repos/acme/web/labels/good%20first%20issue", &[], json!({ "color": "7057ff" })).unwrap();
        assert_eq!(route.op, Op::UpdateLabel);
        assert_eq!(input, json!({ "color": "7057ff", "label": "good first issue", "repo": "acme/web" }));
        let (route, input) = resolve("DELETE", "/repos/acme/web/issues/7/labels/bug", &[], Value::Null).unwrap();
        assert_eq!(route.op, Op::RemoveIssueLabels);
        assert_eq!(input, json!({ "label": "bug", "number": 7, "repo": "acme/web" }));
        let (route, input) = resolve("DELETE", "/repos/acme/web/issues/7/labels", &[], Value::Null).unwrap();
        assert_eq!(route.op, Op::RemoveIssueLabels);
        assert_eq!(input, json!({ "number": 7, "repo": "acme/web" }));
        let (route, _) = resolve("POST", "/repos/acme/web/labels/defaults", &[], Value::Null).unwrap();
        assert_eq!(route.op, Op::AddDefaultLabels);
        let (route, input) = resolve("PATCH", "/repos/acme/web/milestones/3", &[], json!({ "state": "closed" })).unwrap();
        assert_eq!(route.op, Op::UpdateMilestone);
        assert_eq!(input, json!({ "state": "closed", "milestone": 3, "repo": "acme/web" }));
        let (route, input) = resolve("PATCH", "/repos/acme/web/pulls/9", &[], json!({ "base": "release" })).unwrap();
        assert_eq!(route.op, Op::UpdatePullRequest);
        assert_eq!(input, json!({ "base": "release", "number": 9, "repo": "acme/web" }));
    }

    #[test]
    fn billing_is_addressed_by_workspace() {
        let query = [("from".to_owned(), "2026-10-01".to_owned()), ("products".to_owned(), "agent,sandboxes".to_owned())];
        let (route, input) = resolve("GET", "/workspaces/acme/usage", &query, Value::Null).unwrap();
        assert_eq!(route.op, Op::GetUsage);
        assert_eq!(input, json!({ "from": "2026-10-01", "products": "agent,sandboxes", "workspace": "acme" }));
        let (route, input) = resolve("PUT", "/workspaces/acme/budget", &[], json!({ "alerts": [50] })).unwrap();
        assert_eq!(route.op, Op::SetBudget);
        assert_eq!(input, json!({ "alerts": [50], "workspace": "acme" }));
        let op = |method: &str, path: &str| resolve(method, path, &[], Value::Null).unwrap().0.op;
        assert_eq!(op("GET", "/workspaces/acme/budget"), Op::GetBudget);
        assert_eq!(op("GET", "/workspaces/acme/ai_credit"), Op::GetAiCredit);
        assert_eq!(op("POST", "/workspaces/acme/ai_credit/checkout"), Op::BuyAiCredit);
        assert_eq!(op("GET", "/workspaces/acme/invoices"), Op::ListInvoices);
        assert_eq!(op("GET", "/workspaces/acme/billing_details"), Op::GetBillingDetails);
        assert_eq!(op("GET", "/workspaces/acme/gateway/requests"), Op::ListGatewayRequests);
    }

    #[test]
    fn query_parameters_are_renamed() {
        let query = [
            ("q".to_owned(), "parser".to_owned()),
            ("x".to_owned(), "y".to_owned()),
        ];
        let (route, input) = resolve("GET", "/repos", &query, Value::Null).unwrap();
        assert_eq!(route.op, Op::ListRepos);
        assert_eq!(input, json!({ "query": "parser" }));
    }

    #[test]
    fn method_and_shape_must_match() {
        assert!(resolve("GET", "/repos/a/b/issues/1/close", &[], Value::Null).is_none());
        assert!(resolve("GET", "/repos/a", &[], Value::Null).is_none());
        assert!(resolve("GET", "/repos/a/b/issues/1/extra", &[], Value::Null).is_none());
        assert!(resolve("GET", "/repos/a/b/", &[], Value::Null).is_some());
    }

    #[test]
    fn every_parameter_and_query_name_is_an_input() {
        for route in ROUTES {
            let properties = route.op.properties();
            for (_, key) in route.query {
                assert!(properties.contains_key(*key), "{}: {key}", route.path);
            }
            for name in route.params() {
                let covered = matches!(name, "owner" | "name") && properties.contains_key("repo")
                    || properties.contains_key(name);
                assert!(covered, "{}: {name}", route.path);
            }
        }
    }

    #[test]
    fn every_operation_has_a_route() {
        for op in Op::ALL {
            assert!(ROUTES.iter().any(|route| route.op == op), "{}", op.name());
        }
    }
}
