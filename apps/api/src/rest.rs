//! REST: each route maps an HTTP request onto one operation.

use serde_json::{Map, Value};

use crate::operations::Op;

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
    // Security alerts: secrets and vulnerable dependencies.
    route(
        "GET",
        "/repos/:owner/:name/security/alerts",
        Op::ListSecurityAlerts,
        &[("state", "state"), ("kind", "kind")],
    ),
    route("POST", "/repos/:owner/:name/security/alerts/:id/dismiss", Op::DismissSecurityAlert, &[]),
    route("POST", "/repos/:owner/:name/security/alerts/:id/reopen", Op::ReopenSecurityAlert, &[]),
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
    route(
        "GET",
        "/repos/:owner/:name/issues",
        Op::ListIssues,
        &[("state", "state"), ("label", "label")],
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
        &[("state", "state")],
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
/// `repo`, and `number` becomes an integer.
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
    for key in ["plan", "id", "workspace", "delivery", "workflow", "job", "setting", "username"] {
        if let Some(value) = param(key) {
            input.insert(key.to_owned(), Value::String(value.to_owned()));
        }
    }
    // A branch name may hold slashes, sent URL-encoded as one segment.
    if let Some(branch) = param("branch") {
        input.insert("branch".to_owned(), Value::String(percent_decoded(branch)));
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
