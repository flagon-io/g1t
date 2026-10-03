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
    route("GET", "/repos", Op::ListRepos, &[("q", "query")]),
    route("POST", "/repos", Op::CreateRepo, &[]),
    route("GET", "/repos/:owner/:name", Op::GetRepo, &[]),
    route("PATCH", "/repos/:owner/:name", Op::UpdateRepo, &[]),
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
    for key in ["plan", "id"] {
        if let Some(value) = param(key) {
            input.insert(key.to_owned(), Value::String(value.to_owned()));
        }
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
            "/repos/syntaqx/hello/pulls/14/merge",
            &[],
            json!({ "keep_issue_open": true, "number": 99, "repo": "someone/else" }),
        )
        .unwrap();
        assert_eq!(route.op, Op::MergePullRequest);
        // What the path names wins over the body.
        assert_eq!(
            input,
            json!({ "keep_issue_open": true, "number": 14, "repo": "syntaqx/hello" })
        );
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
