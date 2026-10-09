//! Which events each subscribing service's queue is sent.
//!
//! The events service passes each batch on to one queue per subscriber
//! (`SUBSCRIBER_*` bindings). Each is sent only the types its consumer acts
//! on, so an event costs a queue write for the services that read it, not
//! for all of them. A consumer that starts acting on a new type adds it
//! here in the same change, or it never hears of it; the tests below and
//! beside each consumer check what they can.
//!
//! A pattern is an exact type (`git.push`), a family (`pull.*`, every type
//! that starts `pull.`), or `*`, every type. A binding not named here is
//! sent everything, so a new subscriber is never left out.

/// What the shared helpers in `g1t_kit` act on (`rename`, `transfer`,
/// `lifecycle`, `deleted`, `user_deleted`): rows that follow a workspace
/// or repository, or go with it. Rare, so every subscriber is sent them.
const LIFECYCLE: [&str; 8] = [
    "workspace.renamed",
    "workspace.deleted",
    "repo.renamed",
    "repo.transferred",
    "repo.deleted",
    "repo.restored",
    "repo.purged",
    "user.deleted",
];

/// Each subscriber's binding and the types it is sent beside [`LIFECYCLE`].
pub const ROUTES: &[(&str, &[&str])] = &[
    // Memory captured from merges and comments, mentions, pull request
    // bases, runs stopped in archived repositories (work/src/lib.rs queue).
    (
        "SUBSCRIBER_WORK",
        &[
            "git.push",
            "branch.renamed",
            "repo.created",
            "repo.archived",
            "repo.default_branch_changed",
            "pull.merged",
            "comment.created",
        ],
    ),
    // Pull requests g1t is seeing through, mentions, queued issues and the
    // merge queue (runner/src/index.ts queue).
    (
        "SUBSCRIBER_RUNNER",
        &[
            "pull.opened",
            "pull.ready",
            "pull.updated",
            "pull.mergeability",
            "pull.mergecheck",
            "pull.merge_requested",
            "pull.merged",
            "pull.closed",
            "checks.completed",
            "review.completed",
            "queue.changed",
            "comment.created",
            "issue.opened",
            "issue.updated",
            "issue.closed",
            "agent.asked",
            "repo.archived",
        ],
    ),
    // Push mirrors and write-back to linked trackers (integrations/src).
    ("SUBSCRIBER_INTEGRATIONS", &["git.push", "issue.closed", "pull.opened"]),
    // A hook may ask for any type, or for every one.
    ("SUBSCRIBER_WEBHOOKS", &["*"]),
    // Every event a workflow can run on (g1t_actions::events::github_events),
    // and runs stopped in archived repositories.
    (
        "SUBSCRIBER_ACTIONS",
        &[
            "git.push",
            "pull.*",
            "issue.*",
            "comment.*",
            "release.*",
            "deployment.created",
            "deployment_status.created",
            "review.completed",
            "workflow.completed",
            "repo.archived",
        ],
    ),
    // Previews and production deploys (deployments/src/index.ts queue).
    (
        "SUBSCRIBER_DEPLOYMENTS",
        &[
            "git.push",
            "branch.renamed",
            "repo.default_branch_changed",
            "pull.opened",
            "pull.ready",
            "pull.updated",
            "pull.reopened",
            "pull.closed",
            "pull.merged",
            "workspace.deleting",
            "workspace.restored",
        ],
    ),
    // Projects follow their repositories, and wake on activity
    // (projects/src/index.ts, activity.ts).
    (
        "SUBSCRIBER_PROJECTS",
        &[
            "git.push",
            "repo.*",
            "issue.opened",
            "issue.closed",
            "issue.reopened",
            "pull.opened",
            "pull.updated",
            "pull.merged",
            "pull.closed",
            "review.completed",
            "comment.created",
            "deployment.succeeded",
            "deployment.failed",
            "package.published",
            "package.deleted",
            "package.version_deleted",
            "workspace.deleting",
            "workspace.restored",
        ],
    ),
    // Pull request working copies, workspaces' repositories, contributors
    // shown as ghost (repos/src/lib.rs handle_event).
    (
        "SUBSCRIBER_REPOS",
        &[
            "pull.merged",
            "pull.closed",
            "pull.reopened",
            "workspace.deleting",
            "workspace.restored",
            "user.deleting",
            "user.restored",
        ],
    ),
    // Usage rows that follow a renamed workspace or repository.
    ("SUBSCRIBER_BILLING", &[]),
    // Secret and dependency scans, and version update pull requests
    // (security/src/lib.rs on_event).
    (
        "SUBSCRIBER_SECURITY",
        &[
            "git.push",
            "pull.opened",
            "pull.updated",
            "pull.ready",
            "pull.merged",
            "pull.closed",
            "checks.completed",
            "comment.created",
            "repo.created",
            "repo.visibility_changed",
        ],
    ),
    // What agents are told about a repository (context/src/index.ts).
    (
        "SUBSCRIBER_CONTEXT",
        &[
            "git.push",
            "issue.opened",
            "issue.updated",
            "issue.closed",
            "pull.ready",
            "pull.merged",
            "memory.changed",
        ],
    ),
    // The site-wide search index (search/src/index.rs).
    ("SUBSCRIBER_SEARCH", &["git.push", "repo.*", "issue.*", "pull.*", "user.*", "workspace.*"]),
    // Composer packages read from repositories, and packages that follow
    // their workspace, team or repository (packages/src/lib.rs on_event).
    (
        "SUBSCRIBER_PACKAGES",
        &[
            "git.push",
            "repo.visibility_changed",
            "workspace.deleting",
            "workspace.restored",
            "team.edited",
            "team.deleted",
        ],
    ),
    // Agents' routines that run on events: a pull request ready for
    // review or merged, checks or a deploy failing, an issue opened
    // (agents/src/triggers.ts).
    (
        "SUBSCRIBER_AGENTS",
        &[
            "pull.opened",
            "pull.ready",
            "pull.merged",
            "checks.completed",
            "issue.opened",
            "deployment.failed",
        ],
    ),
];

/// Whether `pattern` (see the module's notes) matches the type `kind`.
fn matches(pattern: &str, kind: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => kind.starts_with(prefix),
        None => pattern == kind,
    }
}

/// Whether the subscriber behind `binding` is sent events of type `kind`.
pub fn routed(binding: &str, kind: &str) -> bool {
    match ROUTES.iter().find(|(name, _)| *name == binding) {
        Some((_, patterns)) => {
            LIFECYCLE.contains(&kind) || patterns.iter().any(|pattern| matches(pattern, kind))
        }
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Types published on the bus that hooks are not offered.
    const UNOFFERED: [&str; 18] = [
        "pull.mergecheck",
        "pull.mergeability",
        "deployment.review_requested",
        "memory.changed",
        "abuse.flagged",
        "invite.created",
        "invite.redeemed",
        "waitlist.requested",
        "user.updated",
        "user.deleting",
        "user.restored",
        "user.deleted",
        "user.email_added",
        "workspace.updated",
        "workspace.renamed",
        "workspace.deleting",
        "workspace.restored",
        "workspace.deleted",
    ];

    fn published(kind: &str) -> bool {
        crate::webhooks::EVENT_TYPES.contains(&kind) || UNOFFERED.contains(&kind)
    }

    #[test]
    fn every_exact_route_names_a_type_that_is_published() {
        for (binding, patterns) in ROUTES {
            for pattern in patterns.iter().chain(LIFECYCLE.iter()) {
                if pattern.ends_with('*') {
                    let prefix = pattern.trim_end_matches('*');
                    assert!(
                        prefix.is_empty()
                            || crate::webhooks::EVENT_TYPES.iter().chain(UNOFFERED.iter()).any(|kind| kind.starts_with(prefix)),
                        "{binding}: {pattern} matches nothing"
                    );
                } else {
                    assert!(published(pattern), "{binding}: {pattern} is not a type anything publishes");
                }
            }
        }
    }

    #[test]
    fn every_route_is_a_subscriber_binding_named_once() {
        let mut names: Vec<&str> = ROUTES.iter().map(|(name, _)| *name).collect();
        assert!(names.iter().all(|name| name.starts_with("SUBSCRIBER_")));
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), count);
        assert_eq!(count, 14);
    }

    #[test]
    fn subscribers_hear_what_they_act_on_and_not_the_rest() {
        assert!(routed("SUBSCRIBER_WEBHOOKS", "secret_scanning_alert.created"));
        assert!(routed("SUBSCRIBER_WEBHOOKS", "anything.new"));
        assert!(routed("SUBSCRIBER_ACTIONS", "pull.labeled"));
        assert!(routed("SUBSCRIBER_ACTIONS", "release.published"));
        assert!(!routed("SUBSCRIBER_ACTIONS", "check_run.completed"));
        assert!(routed("SUBSCRIBER_RUNNER", "comment.created"));
        assert!(!routed("SUBSCRIBER_RUNNER", "status.created"));
        assert!(routed("SUBSCRIBER_BILLING", "workspace.renamed"));
        assert!(!routed("SUBSCRIBER_BILLING", "git.push"));
        assert!(routed("SUBSCRIBER_SEARCH", "user.updated"));
        assert!(routed("SUBSCRIBER_REPOS", "user.deleting"));
        assert!(!routed("SUBSCRIBER_REPOS", "git.push"));
        // Every subscriber follows what moves or removes a repository.
        for (binding, _) in ROUTES {
            for kind in LIFECYCLE {
                assert!(routed(binding, kind), "{binding} misses {kind}");
            }
        }
    }

    #[test]
    fn a_subscriber_not_in_the_table_hears_everything() {
        assert!(routed("SUBSCRIBER_NEW", "git.push"));
        assert!(routed("SUBSCRIBER_NEW", "status.created"));
    }

    #[test]
    fn a_family_matches_only_its_own_types() {
        assert!(matches("pull.*", "pull.opened"));
        assert!(!matches("pull.*", "pulls.opened"));
        assert!(!matches("pull.*", "pull"));
        assert!(matches("*", "x"));
        assert!(matches("git.push", "git.push"));
        assert!(!matches("git.push", "git.pushed"));
    }
}
