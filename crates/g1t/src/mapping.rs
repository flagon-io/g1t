//! Which API operations each command calls.
//!
//! Every operation is reachable as `g1t api <operation>`, from the table
//! generated out of the API's OpenAPI document (`ops_table.rs`). The
//! commands written by hand for the common paths are listed here with the
//! operations they call, and the tests below hold the three together:
//!
//! - every operation named here is in the generated table, so a command
//!   whose operation the API drops or renames fails the build's tests;
//! - every command in the command tree is listed here, and nothing else;
//! - the operations each command's source names are exactly the ones
//!   listed for it, so this table cannot fall behind the code.

use std::collections::BTreeMap;

pub struct Mapping {
    pub command: &'static str,
    pub ops: &'static [&'static str],
}

pub static COMMANDS: &[Mapping] = &[
    Mapping {
        command: "auth login",
        ops: &["device_code", "device_token", "whoami"],
    },
    Mapping {
        command: "auth logout",
        ops: &[],
    },
    Mapping {
        command: "auth status",
        ops: &["whoami"],
    },
    Mapping {
        command: "auth token",
        ops: &[],
    },
    Mapping {
        command: "auth switch",
        ops: &[],
    },
    Mapping {
        command: "auth setup-git",
        ops: &[],
    },
    Mapping {
        command: "auth git-credential",
        ops: &["whoami"],
    },
    Mapping {
        command: "repo view",
        ops: &["get_repo", "list_projects"],
    },
    Mapping {
        command: "repo clone",
        ops: &["whoami"],
    },
    Mapping {
        command: "repo create",
        ops: &["create_repo"],
    },
    Mapping {
        command: "repo list",
        ops: &["list_repos", "list_projects"],
    },
    Mapping {
        command: "repo fork",
        ops: &["fork_repo"],
    },
    Mapping {
        command: "repo forks",
        ops: &["list_forks", "list_projects"],
    },
    Mapping {
        command: "repo sync",
        ops: &["sync_fork"],
    },
    Mapping {
        command: "repo detach",
        ops: &["detach_fork"],
    },
    Mapping {
        command: "pr list",
        ops: &["list_pull_requests"],
    },
    Mapping {
        command: "pr view",
        ops: &["get_pull_request", "list_pull_requests"],
    },
    Mapping {
        command: "pr create",
        ops: &[
            "create_pull_request",
            "get_repo",
            "convert_pull_request_to_draft",
            "upload_attachment",
        ],
    },
    Mapping {
        command: "pr checkout",
        ops: &["get_pull_request"],
    },
    Mapping {
        command: "pr diff",
        ops: &["get_pull_request_changes"],
    },
    Mapping {
        command: "pr checks",
        ops: &[
            "get_pull_request",
            "list_check_runs_for_ref",
            "get_combined_status",
        ],
    },
    Mapping {
        command: "pr review",
        ops: &["review_pull_request", "add_comment"],
    },
    Mapping {
        command: "pr merge",
        ops: &[
            "merge_pull_request",
            "enable_pull_request_auto_merge",
            "disable_pull_request_auto_merge",
        ],
    },
    Mapping {
        command: "pr update-branch",
        ops: &["update_pull_request_branch"],
    },
    Mapping {
        command: "pr ready",
        ops: &["mark_pull_request_ready", "convert_pull_request_to_draft", "upload_attachment"],
    },
    Mapping {
        command: "pr comment",
        ops: &["add_comment", "upload_attachment"],
    },
    Mapping {
        command: "pr close",
        ops: &["close_pull_request"],
    },
    Mapping {
        command: "pr reopen",
        ops: &["reopen_pull_request"],
    },
    Mapping {
        command: "run list",
        ops: &["list_workflow_runs"],
    },
    Mapping {
        command: "run view",
        ops: &["get_workflow_run", "get_job_logs"],
    },
    Mapping {
        command: "run watch",
        ops: &["get_workflow_run"],
    },
    Mapping {
        command: "run logs",
        ops: &["get_workflow_run", "get_job_logs"],
    },
    Mapping {
        command: "run rerun",
        ops: &["rerun_workflow_run", "rerun_failed_jobs", "rerun_job"],
    },
    Mapping {
        command: "run cancel",
        ops: &["cancel_workflow_run"],
    },
    Mapping {
        command: "workflow list",
        ops: &["list_workflows"],
    },
    Mapping {
        command: "workflow view",
        ops: &["list_workflows", "get_workflow", "list_workflow_runs"],
    },
    Mapping {
        command: "workflow run",
        ops: &["list_workflows", "dispatch_workflow", "list_workflow_runs"],
    },
    Mapping {
        command: "workflow enable",
        ops: &["list_workflows", "enable_workflow"],
    },
    Mapping {
        command: "workflow disable",
        ops: &["list_workflows", "disable_workflow"],
    },
    Mapping {
        command: "secret list",
        ops: &["list_actions_secrets", "list_actions_secrets_for_workspace"],
    },
    Mapping {
        command: "secret set",
        ops: &["set_actions_secret", "set_actions_secret_for_workspace"],
    },
    Mapping {
        command: "secret delete",
        ops: &[
            "delete_actions_secret",
            "delete_actions_secret_for_workspace",
        ],
    },
    Mapping {
        command: "cache list",
        ops: &["list_caches"],
    },
    Mapping {
        command: "cache usage",
        ops: &["get_cache_usage"],
    },
    Mapping {
        command: "cache delete",
        ops: &["delete_cache", "delete_caches_by_key"],
    },
    Mapping {
        command: "deploy list",
        ops: &["list_deployments"],
    },
    Mapping {
        command: "deploy view",
        ops: &["get_deployment"],
    },
    // These find the current repository's project as `logs` does.
    Mapping {
        command: "deploy settings",
        ops: &["get_deployment_settings", "update_deployment_settings"],
    },
    Mapping {
        command: "deploy enable",
        ops: &["update_deployment_settings"],
    },
    Mapping {
        command: "deploy disable",
        ops: &["update_deployment_settings"],
    },
    Mapping {
        command: "logs",
        ops: &["list_logs", "list_errors", "list_projects", "get_repo"],
    },
    Mapping {
        command: "status",
        ops: &[
            "search",
            "list_notifications",
            "get_pull_request",
            "list_sessions",
            "list_claims",
        ],
    },
    Mapping { command: "session start", ops: &["start_session"] },
    Mapping { command: "session heartbeat", ops: &["update_session"] },
    Mapping { command: "session log", ops: &["record_session_entries"] },
    Mapping { command: "session attach", ops: &["update_session"] },
    Mapping { command: "session end", ops: &["end_session"] },
    Mapping { command: "session list", ops: &["list_sessions"] },
    Mapping { command: "session view", ops: &["get_session"] },
    Mapping { command: "session updates", ops: &["get_session"] },
    Mapping { command: "session acknowledge", ops: &["record_session_entries"] },
    Mapping { command: "session touch", ops: &["record_session_entries"] },
    Mapping { command: "work list", ops: &["list_work_items"] },
    Mapping { command: "work view", ops: &["get_work", "get_work_item"] },
    Mapping { command: "work new", ops: &["open_work_item", "update_work_item", "upload_attachment"] },
    Mapping { command: "work comment", ops: &["add_work_item_comment", "upload_attachment"] },
    Mapping { command: "work edit", ops: &["update_work_item", "get_work_item"] },
    Mapping { command: "work close", ops: &["close_work_item", "add_work_item_comment"] },
    Mapping { command: "work reopen", ops: &["reopen_work_item", "add_work_item_comment"] },
    Mapping { command: "work link", ops: &["link_work_item"] },
    Mapping { command: "work unlink", ops: &["unlink_work_item"] },
    Mapping { command: "work claim", ops: &["claim_work_item", "claim_new_work_item"] },
    Mapping { command: "work release", ops: &["release_claim"] },
    Mapping { command: "work handoff", ops: &["hand_off_work_item"] },
    Mapping { command: "work status", ops: &["list_claims", "list_sessions"] },
    Mapping { command: "work block", ops: &["get_work_item", "update_work_item"] },
    Mapping { command: "work unblock", ops: &["get_work_item", "update_work_item"] },
    Mapping { command: "work events", ops: &["list_events"] },
    Mapping { command: "work dispatch", ops: &["start_agent_session"] },
    Mapping { command: "why", ops: &["why"] },
    Mapping { command: "attach", ops: &["upload_attachment"] },
    // Every operation, by name: the table generated from the OpenAPI document.
    Mapping {
        command: "api",
        ops: &[],
    },
    Mapping {
        command: "browse",
        ops: &["resolve_ref"],
    },
    Mapping {
        command: "alias set",
        ops: &[],
    },
    Mapping {
        command: "alias list",
        ops: &[],
    },
    Mapping {
        command: "alias delete",
        ops: &[],
    },
    Mapping {
        command: "completion",
        ops: &[],
    },
    // The registry's own protocol, not the REST API.
    Mapping {
        command: "push",
        ops: &[],
    },
    // The site's downloads, not the REST API.
    Mapping {
        command: "upgrade",
        ops: &[],
    },
];

/// The first command that calls each operation, for `g1t api --list`.
pub fn by_operation() -> BTreeMap<&'static str, &'static str> {
    let mut map = BTreeMap::new();
    for m in COMMANDS {
        for op in m.ops {
            map.entry(*op).or_insert(m.command);
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Cli;
    use clap::CommandFactory;
    use std::collections::BTreeSet;

    fn leaves(command: &clap::Command, prefix: &str, out: &mut Vec<String>) {
        let subs: Vec<&clap::Command> = command
            .get_subcommands()
            .filter(|c| c.get_name() != "help")
            .collect();
        if subs.is_empty() {
            out.push(prefix.trim().to_owned());
        }
        for sub in subs {
            leaves(sub, &format!("{prefix} {}", sub.get_name()), out);
        }
    }

    #[test]
    fn every_mapped_operation_exists() {
        for m in COMMANDS {
            for op in m.ops {
                assert!(
                    crate::ops::find(op).is_some(),
                    "`g1t {}` calls {op}, which the API no longer has",
                    m.command
                );
            }
        }
    }

    #[test]
    fn every_command_is_mapped_and_nothing_else() {
        let mut tree = Vec::new();
        leaves(&Cli::command(), "", &mut tree);
        let tree: BTreeSet<String> = tree.into_iter().collect();
        let mapped: BTreeSet<String> = COMMANDS.iter().map(|m| m.command.to_owned()).collect();
        let missing: Vec<&String> = tree.difference(&mapped).collect();
        let extra: Vec<&String> = mapped.difference(&tree).collect();
        assert!(
            missing.is_empty(),
            "commands with no entry in mapping.rs: {missing:?}"
        );
        assert!(
            extra.is_empty(),
            "mapping.rs lists commands that do not exist: {extra:?}"
        );
    }

    /// The operations a source file names, as string literals.
    fn named_in(source: &str) -> BTreeSet<&'static str> {
        let source = source.split("#[cfg(test)]").next().unwrap_or(source);
        crate::ops::all()
            .map(|op| op.id)
            .filter(|id| source.contains(&format!("\"{id}\"")))
            .collect()
    }

    #[test]
    fn the_table_matches_what_the_code_calls() {
        let sources: &[(&str, &str)] = &[
            ("auth", include_str!("commands/auth.rs")),
            ("repo", include_str!("commands/repo.rs")),
            ("pr", include_str!("commands/pr.rs")),
            ("run", include_str!("commands/run.rs")),
            ("workflow", include_str!("commands/workflow.rs")),
            ("secret", include_str!("commands/secret.rs")),
            ("cache", include_str!("commands/cache.rs")),
            ("deploy", include_str!("commands/deploy.rs")),
            ("logs", include_str!("commands/logs.rs")),
            ("status", include_str!("commands/status.rs")),
            ("session", include_str!("commands/session.rs")),
            ("work", include_str!("commands/work.rs")),
            ("why", include_str!("commands/why.rs")),
            ("attach", include_str!("commands/attach.rs")),
            ("browse", include_str!("commands/browse.rs")),
        ];
        // What context.rs calls on every command's behalf, and what
        // attach.rs uploads for --attach.
        let shared: BTreeSet<&str> = named_in(include_str!("context.rs"))
            .union(&named_in(include_str!("commands/attach.rs")))
            .copied()
            .collect();
        for (top, source) in sources {
            let named = named_in(source);
            let listed: BTreeSet<&str> = COMMANDS
                .iter()
                .filter(|m| m.command == *top || m.command.starts_with(&format!("{top} ")))
                .flat_map(|m| m.ops.iter().copied())
                .collect();
            let unlisted: Vec<&&str> = named.difference(&listed).collect();
            let unused: Vec<&&str> = listed
                .difference(&named)
                .filter(|op| !shared.contains(**op))
                .collect();
            assert!(
                unlisted.is_empty(),
                "commands/{top}.rs calls {unlisted:?}, which mapping.rs does not list"
            );
            assert!(
                unused.is_empty(),
                "mapping.rs lists {unused:?} for `{top}`, which commands/{top}.rs does not call"
            );
        }
    }

    /// `g1t api <operation>` can make a request for every operation: each
    /// path parameter can be filled from a field.
    #[test]
    fn every_operation_is_reachable_through_api() {
        let repo = || {
            Ok(crate::repo::Repo {
                host: "g1t.sh".into(),
                owner: "acme".into(),
                name: "web".into(),
            })
        };
        for op in crate::ops::OPERATIONS {
            let mut given = serde_json::Map::new();
            for p in op.path_params() {
                given.insert(p.name.to_owned(), serde_json::Value::String("x".into()));
            }
            let plan = crate::commands::api::plan_op(op, None, given, &repo)
                .unwrap_or_else(|e| panic!("{}: {}", op.id, e.message));
            assert!(!plan.path.contains('{'), "{}: {}", op.id, plan.path);
            assert_eq!(plan.method, op.method);
        }
    }
}
