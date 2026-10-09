//! Mirroring over REST and MCP: a repository's links to copies of it on
//! other hosts (see `g1t_contracts::mirrors`), at
//! `/repos/{owner}/{name}/mirror…`, and as the MCP `mirror` tool.
//!
//! The integrations service keeps the links and decides who may change
//! them: the Admin role on the repository; syncing needs push. Agents never
//! move a repository to g1t or handle a remote's token.

use g1t_contracts::mirrors::{
    MirrorActArgs, MirrorAddArgs, MirrorCiArgs, MirrorHandBackArgs, MirrorMoveInArgs, MirrorRemoveArgs, MirrorSettings,
    MirrorSettingsArgs, MirrorViewArgs, RefDecision, RemoteProvider, RemoteRole,
};
use g1t_contracts::repos::{GetArgs, Repo};
use g1t_contracts::{FailureCode, Outcome, Viewer};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use worker::Result;

use crate::operations::{Services, repo_path};

/// One operation on a repository's mirroring.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MirrorsOp {
    GetMirror,
    GetHandBackPlan,
    TakeOver,
    SetCiFailover,
    HandBack,
    MoveToG1t,
    SyncMirror,
    AddRemote,
    UpdateRemote,
    RemoveRemote,
}

impl MirrorsOp {
    /// Every one: `Op::ALL` lists each as `Op::Mirrors(…)`, which a test
    /// checks against this.
    #[cfg(test)]
    pub const ALL: [MirrorsOp; 10] = [
        MirrorsOp::GetMirror,
        MirrorsOp::GetHandBackPlan,
        MirrorsOp::TakeOver,
        MirrorsOp::SetCiFailover,
        MirrorsOp::HandBack,
        MirrorsOp::MoveToG1t,
        MirrorsOp::SyncMirror,
        MirrorsOp::AddRemote,
        MirrorsOp::UpdateRemote,
        MirrorsOp::RemoveRemote,
    ];

    pub fn name(self) -> &'static str {
        match self {
            MirrorsOp::GetMirror => "get_mirror",
            MirrorsOp::GetHandBackPlan => "get_hand_back_plan",
            MirrorsOp::TakeOver => "take_over_mirror",
            MirrorsOp::SetCiFailover => "set_ci_failover",
            MirrorsOp::HandBack => "hand_back_mirror",
            MirrorsOp::MoveToG1t => "move_mirror_to_g1t",
            MirrorsOp::SyncMirror => "sync_mirror",
            MirrorsOp::AddRemote => "add_mirror_remote",
            MirrorsOp::UpdateRemote => "update_mirror_remote",
            MirrorsOp::RemoveRemote => "remove_mirror_remote",
        }
    }

    /// For the API reference.
    pub fn title(self) -> &'static str {
        match self {
            MirrorsOp::GetMirror => "Get a repository's mirroring",
            MirrorsOp::GetHandBackPlan => "Get the hand-back plan",
            MirrorsOp::TakeOver => "Take over a mirror",
            MirrorsOp::SetCiFailover => "Start or end CI failover",
            MirrorsOp::HandBack => "Hand a takeover back",
            MirrorsOp::MoveToG1t => "Move a mirror to g1t",
            MirrorsOp::SyncMirror => "Sync a repository's remotes",
            MirrorsOp::AddRemote => "Add a remote",
            MirrorsOp::UpdateRemote => "Update a remote's settings",
            MirrorsOp::RemoveRemote => "Remove a remote",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            MirrorsOp::GetMirror => "A repository's links to other hosts. `remotes` lists each with its `role` (`leader`: the remote leads and this repository is its mirror; `follower`: g1t leads and the remote is kept in step), `provider` (`github`, `g1t` or `git`), `name` (`github.com/acme/web`), `state` (a mirror is `standby`, `ci`, `takeover` or `handing_back`; a follower is `following` or `stuck`), `reachable` and `unreachable_since`, `synced_at`, `last_error` and its `settings`. `can_manage` says whether you may change them. A mirror standing by is read-only on g1t and runs nothing. Needs read access.",
            MirrorsOp::GetHandBackPlan => "What handing a takeover back would do, ref by ref, in `plan.refs`: each with `base` (where it was when the takeover began), `ours`, `theirs` and `action`: `push` (only g1t moved), `fetch` (only the remote moved), `pull_request` (the remote protects the branch: g1t's commits go to `g1t/handback/<branch>` there as a pull request, and g1t follows the remote's branch) or `diverged` (both moved: it needs a decision). `plan.reachable` is false while the remote does not answer; `plan.ready` once it answers and every diverged ref has a decision. Asks the remote, so it takes a moment. Needs the Admin role.",
            MirrorsOp::TakeOver => "Take over a mirror: g1t leads it for now, so pushes, pull requests, issues, agents and workflows work on g1t, whether or not the remote is answering. Each ref's commit is recorded as where the takeover began. Workflows that deploy wait for approval, unless the link's settings say otherwise. End it with hand_back_mirror, or keep it with move_mirror_to_g1t. Needs the Admin role.",
            MirrorsOp::SetCiFailover => "Start (`on: true`) or end (`on: false`) CI failover on a mirror standing by: the remote keeps the code, and g1t runs its workflows, `.github/workflows` as well as `.g1t/workflows`, on each push copied in. Workflows that deploy wait for approval unless the link's settings say otherwise. Needs the Admin role.",
            MirrorsOp::HandBack => "Hand a takeover back to the remote, as get_hand_back_plan describes, with `decisions` for diverged refs: an object from ref (`refs/heads/docs`) to `keep_ours` (g1t's commit is pushed over the remote's), `keep_theirs` (the remote's is taken; g1t's is kept under `refs/g1t/replaced/`) or `pull_request`. Refused while the remote does not answer or a diverged ref has no decision. The repository is read-only while it goes back; if anything is refused, g1t keeps the lead and says why. On success the mirror stands by again, and `notes` lists the pull requests opened. Needs the Admin role.",
            MirrorsOp::MoveToG1t => "Move a mirror to g1t for good: it stops being a mirror and g1t no longer tracks the remote, so pushes made there no longer come here. Allowed while it stands by, in CI failover, or during a takeover, whose work stays as it is. With `keep_remote_updated: true` the remote becomes a follower instead of being unlinked, and g1t pushes to it from then on. Needs the Admin role; agents' tokens are refused.",
            MirrorsOp::SyncMirror => "Bring a repository's remotes in step now: a mirror standing by or in CI failover copies the remote's branches and tags in; each follower is pushed g1t's (which also clears a follower that was stuck by pushing over what changed there). Needs push access.",
            MirrorsOp::AddRemote => "Link a repository to a remote on another g1t or any git host over HTTPS (GitHub repositories are linked by importing them through g1t's GitHub App). `role` `follower`: g1t leads and pushes to it. `role` `leader`: this repository becomes its mirror; only an empty repository can, and it is filled from the remote. `url` is its https clone address, `token` a token that can read and push (kept sealed, never returned), `username` the user it is sent as. Needs the Admin role; agents' tokens are refused.",
            MirrorsOp::UpdateRemote => "Change a remote's `settings`, all optional: `notify` (`banner`, or `inbox` to also tell the workspace's owners), `take_over_after` (minutes, 5 to 1440, after which g1t takes over on its own while the remote does not answer; null for never), `hand_back` (`when_clean`: an automatic takeover goes back on its own once every ref goes back without a decision; `ask`), `keep_ci_warm` (run `.g1t/workflows` on pushes copied in while standing by), `github_workflows` (run `.github/workflows` in CI failover and takeovers), `hold_deploys`, and for a follower `remote_pushes` (`adopt` fast-forwards made there, or `overwrite` them). Needs the Admin role; agents' tokens are refused.",
            MirrorsOp::RemoveRemote => "Unlink a remote. A mirror becomes an ordinary repository with what it has; a follower is no longer pushed to. Refused during a takeover: hand it back or move it to g1t first. Needs the Admin role; agents' tokens are refused.",
        }
    }

    pub fn input(self) -> Value {
        let repo = json!({ "type": "string", "description": "Repository as \"owner/name\", e.g. \"flagon-io/hello\"." });
        let id = json!({ "type": "string", "description": "The remote's id (rmt_…), from get_mirror." });
        let (properties, required): (Value, &[&str]) = match self {
            MirrorsOp::GetMirror | MirrorsOp::GetHandBackPlan | MirrorsOp::TakeOver | MirrorsOp::SyncMirror => {
                (json!({ "repo": repo }), &["repo"])
            }
            MirrorsOp::SetCiFailover => (
                json!({ "repo": repo, "on": { "type": "boolean", "description": "True to start CI failover, false to end it." } }),
                &["repo", "on"],
            ),
            MirrorsOp::HandBack => (
                json!({
                    "repo": repo,
                    "decisions": {
                        "type": "object",
                        "description": "For each diverged ref, by its full name: keep_ours, keep_theirs or pull_request.",
                        "additionalProperties": { "type": "string", "enum": ["keep_ours", "keep_theirs", "pull_request"] },
                    },
                }),
                &["repo"],
            ),
            MirrorsOp::MoveToG1t => (
                json!({
                    "repo": repo,
                    "keep_remote_updated": { "type": "boolean", "description": "True to keep pushing to the remote from g1t; false (the default) to stop tracking it." },
                }),
                &["repo"],
            ),
            MirrorsOp::AddRemote => (
                json!({
                    "repo": repo,
                    "provider": { "type": "string", "enum": ["g1t", "git"], "description": "Another g1t (g1t.sh or your own), or any git host." },
                    "role": { "type": "string", "enum": ["follower", "leader"], "description": "follower: g1t leads and pushes to it. leader: this empty repository becomes its mirror." },
                    "url": { "type": "string", "description": "Its https clone address, such as https://g1t.sh/acme/web.git." },
                    "username": { "type": "string", "description": "The user the token is sent as. x-access-token when left out." },
                    "token": { "type": "string", "description": "A token that can read and push. Kept sealed; never returned." },
                }),
                &["repo", "provider", "role", "url", "token"],
            ),
            MirrorsOp::UpdateRemote => (
                json!({
                    "repo": repo,
                    "id": id,
                    "notify": { "type": "string", "enum": ["banner", "inbox"] },
                    "take_over_after": { "type": ["integer", "null"], "minimum": 5, "maximum": 1440 },
                    "hand_back": { "type": "string", "enum": ["when_clean", "ask"] },
                    "keep_ci_warm": { "type": "boolean" },
                    "github_workflows": { "type": "boolean" },
                    "hold_deploys": { "type": "boolean" },
                    "remote_pushes": { "type": "string", "enum": ["adopt", "overwrite"] },
                }),
                &["repo", "id"],
            ),
            MirrorsOp::RemoveRemote => (json!({ "repo": repo, "id": id }), &["repo", "id"]),
        };
        json!({ "type": "object", "properties": properties, "required": required })
    }
}

fn text(input: &Value, key: &str) -> String {
    input[key].as_str().map(str::trim).unwrap_or_default().to_owned()
}

/// A boolean as sent: JSON, or a word from a form.
fn flag(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::String(word) => match word.trim().to_ascii_lowercase().as_str() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// `settings` with what `input` changes, in `snake_case` as sent.
pub fn settings_from(mut settings: MirrorSettings, input: &Value) -> std::result::Result<MirrorSettings, String> {
    let word = |key: &str| input.get(key).filter(|value| !value.is_null()).map(|value| value.as_str().unwrap_or_default());
    if let Some(notify) = word("notify") {
        settings.notify = serde_json::from_value(json!(notify)).map_err(|_| "notify is banner or inbox.")?;
    }
    if let Some(value) = input.get("take_over_after") {
        settings.take_over_after = match value {
            Value::Null => None,
            value => Some(value.as_u64().map(|minutes| minutes as u32).ok_or("take_over_after is a number of minutes, or null.")?),
        };
    }
    if let Some(hand_back) = word("hand_back") {
        settings.hand_back = serde_json::from_value(json!(hand_back)).map_err(|_| "hand_back is when_clean or ask.")?;
    }
    if let Some(remote_pushes) = word("remote_pushes") {
        settings.remote_pushes = serde_json::from_value(json!(remote_pushes)).map_err(|_| "remote_pushes is adopt or overwrite.")?;
    }
    for (key, field) in [
        ("keep_ci_warm", &mut settings.keep_ci_warm),
        ("github_workflows", &mut settings.github_workflows),
        ("hold_deploys", &mut settings.hold_deploys),
    ] {
        if let Some(value) = input.get(key).filter(|value| !value.is_null()) {
            *field = flag(value).ok_or_else(|| format!("{key} is true or false."))?;
        }
    }
    Ok(settings)
}

/// `decisions` as sent: ref to `keep_ours`, `keep_theirs` or `pull_request`.
pub fn decisions_from(input: &Value) -> std::result::Result<BTreeMap<String, RefDecision>, String> {
    let Some(decisions) = input.get("decisions").filter(|value| !value.is_null()) else {
        return Ok(BTreeMap::new());
    };
    let Some(decisions) = decisions.as_object() else {
        return Err("decisions is an object from ref to keep_ours, keep_theirs or pull_request.".to_owned());
    };
    decisions
        .iter()
        .map(|(git_ref, decision)| {
            let decision = serde_json::from_value(decision.clone())
                .map_err(|_| format!("{git_ref}: say keep_ours, keep_theirs or pull_request."))?;
            let git_ref = if git_ref.starts_with("refs/") { git_ref.clone() } else { format!("refs/heads/{git_ref}") };
            Ok((git_ref, decision))
        })
        .collect()
}

pub async fn run(op: MirrorsOp, services: &Services, viewer: &Viewer, input: &Value) -> Result<Outcome<Value>> {
    let Some(path) = repo_path(input) else {
        return Ok(Outcome::fail(FailureCode::Invalid, "Give the repository as \"owner/name\"."));
    };
    let found: Outcome<Repo> = g1t_kit::call(&services.repos, "get", &GetArgs { path, viewer: viewer.clone() }).await?;
    let repo = match found {
        Outcome::Ok(repo) => repo,
        Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
    };
    let integrations = &services.integrations;
    if op == MirrorsOp::GetMirror {
        return g1t_kit::call(integrations, "mirror_view", &MirrorViewArgs { viewer: viewer.clone(), repo_id: repo.id }).await;
    }
    let Some(actor) = viewer.clone() else {
        return Ok(Outcome::fail(FailureCode::Unauthenticated, "Sign in to change a repository's mirroring."));
    };
    let act = || MirrorActArgs { actor: actor.clone(), repo_id: repo.id.clone() };
    let id = text(input, "id");
    if matches!(op, MirrorsOp::UpdateRemote | MirrorsOp::RemoveRemote) && id.is_empty() {
        return Ok(Outcome::fail(FailureCode::Invalid, "Name the remote by its id (rmt_…), from get_mirror."));
    }
    match op {
        MirrorsOp::GetMirror => unreachable!("answered above"),
        MirrorsOp::GetHandBackPlan => g1t_kit::call(integrations, "mirror_hand_back_plan", &act()).await,
        MirrorsOp::TakeOver => g1t_kit::call(integrations, "mirror_take_over", &act()).await,
        MirrorsOp::SyncMirror => g1t_kit::call(integrations, "mirror_sync", &act()).await,
        MirrorsOp::SetCiFailover => {
            let Some(on) = flag(&input["on"]) else {
                return Ok(Outcome::fail(FailureCode::Invalid, "Say on: true to start CI failover, or false to end it."));
            };
            g1t_kit::call(integrations, "mirror_ci", &MirrorCiArgs { actor, repo_id: repo.id, on }).await
        }
        MirrorsOp::HandBack => {
            let decisions = match decisions_from(input) {
                Ok(decisions) => decisions,
                Err(problem) => return Ok(Outcome::fail(FailureCode::Invalid, problem)),
            };
            g1t_kit::call(integrations, "mirror_hand_back", &MirrorHandBackArgs { actor, repo_id: repo.id, decisions }).await
        }
        MirrorsOp::MoveToG1t => {
            let keep_remote_updated = match &input["keep_remote_updated"] {
                Value::Null => false,
                value => match flag(value) {
                    Some(keep) => keep,
                    None => return Ok(Outcome::fail(FailureCode::Invalid, "keep_remote_updated is true or false.")),
                },
            };
            g1t_kit::call(integrations, "mirror_move_in", &MirrorMoveInArgs { actor, repo_id: repo.id, keep_remote_updated }).await
        }
        MirrorsOp::AddRemote => {
            let provider = match text(input, "provider").as_str() {
                "g1t" => RemoteProvider::G1t,
                "git" => RemoteProvider::Git,
                "github" => {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        "GitHub repositories are linked by importing them through g1t's GitHub App.",
                    ));
                }
                _ => return Ok(Outcome::fail(FailureCode::Invalid, "provider is g1t or git.")),
            };
            let role = match text(input, "role").as_str() {
                "leader" => RemoteRole::Leader,
                "follower" => RemoteRole::Follower,
                _ => return Ok(Outcome::fail(FailureCode::Invalid, "role is follower (g1t leads) or leader (the remote leads).")),
            };
            let username = Some(text(input, "username")).filter(|name| !name.is_empty());
            let token = Some(text(input, "token")).filter(|token| !token.is_empty());
            let args = MirrorAddArgs { actor, repo_id: repo.id, provider, role, url: text(input, "url"), username, token };
            g1t_kit::call(integrations, "mirror_add", &args).await
        }
        MirrorsOp::UpdateRemote => {
            let view: Outcome<g1t_contracts::mirrors::MirrorView> =
                g1t_kit::call(integrations, "mirror_view", &MirrorViewArgs { viewer: viewer.clone(), repo_id: repo.id }).await?;
            let view = match view {
                Outcome::Ok(view) => view,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            };
            let Some(remote) = view.remotes.into_iter().find(|remote| remote.id == id) else {
                return Ok(Outcome::fail(FailureCode::NotFound, "That remote is not one of this repository's."));
            };
            let settings = match settings_from(remote.settings, input) {
                Ok(settings) => settings,
                Err(problem) => return Ok(Outcome::fail(FailureCode::Invalid, problem)),
            };
            g1t_kit::call(integrations, "mirror_settings", &MirrorSettingsArgs { actor, remote_id: id, settings }).await
        }
        MirrorsOp::RemoveRemote => {
            let view: Outcome<g1t_contracts::mirrors::MirrorView> =
                g1t_kit::call(integrations, "mirror_view", &MirrorViewArgs { viewer: viewer.clone(), repo_id: repo.id }).await?;
            if !matches!(&view, Outcome::Ok(view) if view.remotes.iter().any(|remote| remote.id == id)) {
                return Ok(Outcome::fail(FailureCode::NotFound, "That remote is not one of this repository's."));
            }
            g1t_kit::call(integrations, "mirror_remove", &MirrorRemoveArgs { actor, remote_id: id }).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::credentials::NEVER;
    use g1t_contracts::mirrors::{HandBack, Notify, RemotePushes};
    use g1t_contracts::scopes::{Level, scope_for};

    #[test]
    fn each_operation_is_described_and_scoped() {
        for op in MirrorsOp::ALL {
            assert!(crate::operations::Op::ALL.contains(&crate::operations::Op::Mirrors(op)), "{}", op.name());
            assert!(!op.title().is_empty() && op.description().len() > 40, "{}", op.name());
            assert!(op.input()["required"].as_array().unwrap().contains(&json!("repo")), "{}", op.name());
            let level = scope_for(op.name()).unwrap_or_else(|| panic!("{} has no scope", op.name())).level();
            let expected = match op {
                MirrorsOp::GetMirror => Level::Read,
                MirrorsOp::SyncMirror => Level::Write,
                _ => Level::Admin,
            };
            assert_eq!(level, expected, "{}", op.name());
        }
        for op in [MirrorsOp::MoveToG1t, MirrorsOp::AddRemote, MirrorsOp::UpdateRemote, MirrorsOp::RemoveRemote] {
            assert!(NEVER.contains(&op.name()), "agents never {}", op.name());
        }
    }

    #[test]
    fn settings_change_only_what_is_sent() {
        let base = MirrorSettings::default();
        let changed = settings_from(base.clone(), &json!({ "notify": "inbox", "take_over_after": 30, "keep_ci_warm": "true" })).unwrap();
        assert_eq!(changed.notify, Notify::Inbox);
        assert_eq!(changed.take_over_after, Some(30));
        assert!(changed.keep_ci_warm);
        assert_eq!(changed.hand_back, HandBack::WhenClean);
        assert_eq!(changed.remote_pushes, RemotePushes::Adopt);
        let cleared = settings_from(changed, &json!({ "take_over_after": null })).unwrap();
        assert_eq!(cleared.take_over_after, None);
        assert!(settings_from(base.clone(), &json!({ "notify": "pager" })).is_err());
        assert!(settings_from(base, &json!({ "hold_deploys": "maybe" })).is_err());
    }

    #[test]
    fn decisions_name_refs_or_branches() {
        let decisions = decisions_from(&json!({ "decisions": { "docs": "keep_theirs", "refs/tags/v1": "keep_ours" } })).unwrap();
        assert_eq!(decisions.get("refs/heads/docs"), Some(&RefDecision::KeepTheirs));
        assert_eq!(decisions.get("refs/tags/v1"), Some(&RefDecision::KeepOurs));
        assert!(decisions_from(&json!({ "decisions": { "docs": "merge" } })).is_err());
        assert!(decisions_from(&json!({})).unwrap().is_empty());
    }
}
