//! Mirroring: a repository kept in step with copies of it on other hosts.
//!
//! Every linked repository has exactly one leader, where work happens; the
//! others follow it. A **mirror** follows a remote that leads (GitHub,
//! another g1t, any git host). While it stands by it is an exact, read-only
//! copy that runs nothing. Someone can **take over**: g1t leads for a
//! while, then **hands back**, sending what was done to the remote. A
//! repository g1t leads can be **mirrored to** any number of followers.
//!
//! The integrations service keeps the links (`remotes`) and decides; the
//! repos service keeps each repository's [`RepoMirror`], so pushes and
//! merges are refused or allowed without asking anyone.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::User;

/// Where a mirror stands with the remote it follows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MirrorState {
    /// A quiet copy: it follows every push and runs nothing.
    #[default]
    Standby,
    /// The remote keeps the code; g1t runs its workflows (CI failover).
    Ci,
    /// g1t leads for now: pushes, pull requests, agents and workflows work.
    Takeover,
    /// Sending what was done during a takeover back to the remote. The
    /// repository is read-only until it is done.
    HandingBack,
}

impl MirrorState {
    pub fn as_str(self) -> &'static str {
        match self {
            MirrorState::Standby => "standby",
            MirrorState::Ci => "ci",
            MirrorState::Takeover => "takeover",
            MirrorState::HandingBack => "handing_back",
        }
    }

    pub fn parse(text: &str) -> Option<MirrorState> {
        Some(match text {
            "standby" => MirrorState::Standby,
            "ci" => MirrorState::Ci,
            "takeover" => MirrorState::Takeover,
            "handing_back" => MirrorState::HandingBack,
            _ => return None,
        })
    }

    /// Whether g1t leads, so the repository takes writes.
    pub fn leads(self) -> bool {
        self == MirrorState::Takeover
    }

    /// Whether g1t copies the remote's pushes in.
    pub fn follows(self) -> bool {
        matches!(self, MirrorState::Standby | MirrorState::Ci)
    }
}

/// A repository's tie to the remote it mirrors, as the repos service keeps
/// it on [`crate::repos::Repo`]. Absent for a repository that leads.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMirror {
    pub state: MirrorState,
    /// The remote, for people: `github.com/acme/web`.
    pub remote: String,
    /// Its web address.
    pub url: String,
    /// RFC 3339: when it entered this state.
    pub since: String,
    /// Run `.g1t/workflows` on pushes copied in while it stands by.
    #[serde(default)]
    pub warm: bool,
    /// Run `.github/workflows` as well, in CI failover and during a takeover.
    #[serde(default)]
    pub github_workflows: bool,
    /// Hold jobs that name an `environment:` for approval, in CI failover
    /// and during a takeover, so nothing deploys twice.
    #[serde(default)]
    pub hold_deploys: bool,
}

impl RepoMirror {
    /// Whether the repository takes pushes, merges, issues and agents.
    pub fn writable(&self) -> bool {
        self.state.leads()
    }
}

/// Why a mirror refuses a write, for people and for `git push`.
pub fn mirror_message(namespace: &str, name: &str, mirror: &RepoMirror) -> String {
    match mirror.state {
        MirrorState::HandingBack => format!(
            "{namespace}/{name} is handing back to {}. It takes changes again once that is done.",
            mirror.remote
        ),
        _ => format!(
            "{namespace}/{name} is a mirror of {remote}, so it is read-only here. Push to {remote}, or take over in Settings → Mirroring to work on g1t.",
            remote = mirror.remote
        ),
    }
}

/// The kinds of host a remote can be. Each is an adapter in integrations
/// (`src/remotes.rs`); a new host is one more arm.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteProvider {
    /// Through g1t's GitHub App.
    Github,
    /// Another g1t: g1t.sh, or one run by its owner.
    G1t,
    /// Any git host over HTTPS, with a username and token.
    Git,
}

impl RemoteProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            RemoteProvider::Github => "github",
            RemoteProvider::G1t => "g1t",
            RemoteProvider::Git => "git",
        }
    }

    pub fn parse(text: &str) -> Option<RemoteProvider> {
        Some(match text {
            "github" => RemoteProvider::Github,
            "g1t" => RemoteProvider::G1t,
            "git" => RemoteProvider::Git,
            _ => return None,
        })
    }
}

/// Which side leads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteRole {
    /// The remote leads; the repository on g1t is its mirror.
    Leader,
    /// g1t leads; the remote is kept in step with it.
    Follower,
}

impl RemoteRole {
    pub fn as_str(self) -> &'static str {
        match self {
            RemoteRole::Leader => "leader",
            RemoteRole::Follower => "follower",
        }
    }
}

/// A link's state. A leader is `standby`, `ci`, `takeover` or
/// `handing_back` (see [`MirrorState`]); a follower is `following`, or
/// `stuck` when the remote refused what g1t sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteState {
    Standby,
    Ci,
    Takeover,
    HandingBack,
    Following,
    Stuck,
}

impl RemoteState {
    pub fn as_str(self) -> &'static str {
        match self {
            RemoteState::Standby => "standby",
            RemoteState::Ci => "ci",
            RemoteState::Takeover => "takeover",
            RemoteState::HandingBack => "handing_back",
            RemoteState::Following => "following",
            RemoteState::Stuck => "stuck",
        }
    }

    pub fn parse(text: &str) -> RemoteState {
        match text {
            "ci" => RemoteState::Ci,
            "takeover" => RemoteState::Takeover,
            "handing_back" => RemoteState::HandingBack,
            "following" => RemoteState::Following,
            "stuck" => RemoteState::Stuck,
            _ => RemoteState::Standby,
        }
    }

    /// The mirror state of a leader in this state.
    pub fn mirror(self) -> Option<MirrorState> {
        MirrorState::parse(self.as_str())
    }
}

/// Who hears that a remote stopped answering. Nobody is woken up unless
/// they asked to be.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Notify {
    /// The repository shows it, and that is all.
    #[default]
    Banner,
    /// Also an inbox item for the repository's admins.
    Inbox,
}

/// When a takeover is handed back once the remote answers again.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandBack {
    /// Only when someone hands it back.
    Ask,
    /// On its own when every branch goes back without a decision.
    #[default]
    WhenClean,
}

/// What a follower does about pushes made on the remote itself.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemotePushes {
    /// Fast-forwards are taken in; anything else is shown as diverged.
    #[default]
    Adopt,
    /// g1t's branches are pushed over them (what they pointed at is kept).
    Overwrite,
}

/// The levers on a link. Every one defaults to doing nothing on its own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MirrorSettings {
    pub notify: Notify,
    /// Take over on its own once the remote has not answered for this many
    /// minutes. `None`: only when someone takes over.
    pub take_over_after: Option<u32>,
    pub hand_back: HandBack,
    /// Run `.g1t/workflows` on pushes copied in while standing by.
    pub keep_ci_warm: bool,
    /// Run `.github/workflows` in CI failover and during a takeover.
    pub github_workflows: bool,
    /// Hold deploy jobs for approval in CI failover and during a takeover.
    pub hold_deploys: bool,
    /// For followers.
    pub remote_pushes: RemotePushes,
}

impl Default for MirrorSettings {
    fn default() -> Self {
        MirrorSettings {
            notify: Notify::Banner,
            take_over_after: None,
            hand_back: HandBack::WhenClean,
            keep_ci_warm: false,
            github_workflows: true,
            hold_deploys: true,
            remote_pushes: RemotePushes::Adopt,
        }
    }
}

/// The shortest and longest wait a person may set before an automatic
/// takeover.
pub const TAKE_OVER_AFTER_MINUTES: (u32, u32) = (5, 24 * 60);

/// A repository's link to a remote.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub id: String,
    pub repo_id: String,
    /// `workspace/name` on g1t.
    pub repo: String,
    pub provider: RemoteProvider,
    pub role: RemoteRole,
    /// For people: `github.com/acme/web`.
    pub name: String,
    /// Its web address.
    pub url: String,
    pub state: RemoteState,
    pub state_since: String,
    /// Who put it in this state: a username, or `g1t` when it was automatic.
    pub state_by: Option<String>,
    /// Whether its host answers. A remote that refuses g1t's credential
    /// still answers: that is [`Remote::last_error`].
    pub reachable: bool,
    pub unreachable_since: Option<String>,
    pub synced_at: Option<String>,
    pub last_error: Option<String>,
    pub settings: MirrorSettings,
    pub created_at: String,
}

/// What happens to one ref when a takeover is handed back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefAction {
    /// Nothing moved on either side, or both moved to the same commit.
    Same,
    /// Only g1t moved: pushed to the remote.
    Push,
    /// Only the remote moved: copied in.
    Fetch,
    /// g1t moved, but the remote protects the branch: sent as a pull
    /// request from `g1t/handback/<branch>`, and g1t follows the remote.
    PullRequest,
    /// Both moved, apart. Waits for a [`RefDecision`].
    Diverged,
}

/// A person's decision for a diverged ref.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefDecision {
    /// g1t's commit is pushed over the remote's.
    KeepOurs,
    /// The remote's commit is taken; g1t's is kept under `refs/g1t/replaced/`.
    KeepTheirs,
    /// g1t's commits go to the remote as a pull request.
    PullRequest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefPlan {
    #[serde(rename = "ref")]
    pub git_ref: String,
    /// The commit both sides agreed on when the takeover began.
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub action: RefAction,
    /// For a diverged ref, what someone decided.
    pub decision: Option<RefDecision>,
}

/// What handing a takeover back would do, ref by ref.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandbackPlan {
    pub refs: Vec<RefPlan>,
    /// Whether the remote answered, so the plan reflects it.
    pub reachable: bool,
    /// Whether it can go back now: the remote answers and every diverged
    /// ref has a decision.
    pub ready: bool,
}

/// Decides one ref of a hand-back. `base` is what both sides agreed on when
/// the takeover began. A ref only g1t moved goes back by push, or by pull
/// request when the remote protects it.
pub fn ref_action(base: Option<&str>, ours: Option<&str>, theirs: Option<&str>, protected: bool) -> RefAction {
    if ours == theirs {
        return RefAction::Same;
    }
    let ours_moved = ours != base;
    let theirs_moved = theirs != base;
    match (ours_moved, theirs_moved) {
        (false, _) => RefAction::Fetch,
        (true, false) if protected && ours.is_some() && theirs.is_some() => RefAction::PullRequest,
        (true, false) => RefAction::Push,
        (true, true) => RefAction::Diverged,
    }
}

impl HandbackPlan {
    pub fn new(refs: Vec<RefPlan>, reachable: bool) -> Self {
        let ready = reachable
            && refs
                .iter()
                .all(|plan| plan.action != RefAction::Diverged || plan.decision.is_some());
        HandbackPlan { refs, reachable, ready }
    }

    /// Whether it needs nobody: no ref is diverged.
    pub fn clean(&self) -> bool {
        self.reachable && !self.refs.iter().any(|plan| plan.action == RefAction::Diverged)
    }
}

/// Everything about a repository's links, for its pages and API.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorView {
    pub remotes: Vec<Remote>,
    /// While a takeover is on or being handed back.
    pub plan: Option<HandbackPlan>,
    /// Whether the viewer may change the links and take over.
    pub can_manage: bool,
    /// What the last action did that people should know: pull requests it
    /// opened, branches it could not bring up to date.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

/// A repository's links in brief, for lists.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBrief {
    pub repo_id: String,
    pub role: RemoteRole,
    pub name: String,
    pub state: RemoteState,
    pub reachable: bool,
}

/// The payload of the `mirror.*` events: `mirror.unreachable` (a mirror's
/// remote stopped answering), `mirror.reachable` (it answers again),
/// `mirror.state_changed` (stood by, CI failover, taken over, handing back,
/// handed back) and `mirror.moved_in` (moved to g1t for good).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorEvent {
    pub repo_id: String,
    /// `workspace/name`.
    pub repo: String,
    pub remote_id: String,
    /// `github.com/acme/web`.
    pub remote: String,
    /// A `RemoteState` as text; absent once moved in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// Who did it: a username, or `g1t` when it happened on its own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    /// What happened, for people.
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Usernames to tell in their inbox (the workspace's owners, when the
    /// link's settings ask for it).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notify: Vec<String>,
    /// The repository's mirroring settings page.
    pub link: String,
}

// --- Methods of the integrations service ----------------------------------

/// `mirror_view`: a repository's links, as the viewer may see them.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorViewArgs {
    pub viewer: Option<User>,
    pub repo_id: String,
}

/// `mirror_briefs`: the links of these repositories. Returns `[RemoteBrief]`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorBriefsArgs {
    pub repo_ids: Vec<String>,
}

/// `mirror_take_over`, `mirror_hand_back_plan`, `mirror_sync`: one
/// repository's mirror. Return `Outcome<MirrorView>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorActArgs {
    pub actor: User,
    pub repo_id: String,
}

/// `mirror_ci`: starts or ends CI failover. Returns `Outcome<MirrorView>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorCiArgs {
    pub actor: User,
    pub repo_id: String,
    pub on: bool,
}

/// `mirror_hand_back`: sends a takeover back, with decisions for diverged
/// refs. Refused while a diverged ref has none. Returns
/// `Outcome<MirrorView>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorHandBackArgs {
    pub actor: User,
    pub repo_id: String,
    #[serde(default)]
    pub decisions: BTreeMap<String, RefDecision>,
}

/// `mirror_settings`: changes a link's levers. Returns `Outcome<Remote>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorSettingsArgs {
    pub actor: User,
    pub remote_id: String,
    pub settings: MirrorSettings,
}

/// `mirror_add`: links a repository to a remote on another g1t or any git
/// host. GitHub links are made by `github_import`. A leader can only be
/// added to an empty repository, which is then filled from it. Returns
/// `Outcome<Remote>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorAddArgs {
    pub actor: User,
    pub repo_id: String,
    pub provider: RemoteProvider,
    pub role: RemoteRole,
    /// The remote's https clone address.
    pub url: String,
    #[serde(default)]
    pub username: Option<String>,
    /// A token for it. Kept sealed; never shown again.
    #[serde(default)]
    pub token: Option<String>,
}

/// `mirror_move_in`: moves a mirror to g1t for good. The repository stops
/// being a mirror and g1t stops tracking the remote: pushes made there no
/// longer come here. Allowed while it stands by, in CI failover, or during
/// a takeover (what g1t holds is kept as it is, nothing is handed back).
/// With `keep_remote_updated`, the remote becomes a follower instead of
/// being unlinked: g1t pushes to it from then on. Returns
/// `Outcome<MirrorView>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorMoveInArgs {
    pub actor: User,
    pub repo_id: String,
    #[serde(default)]
    pub keep_remote_updated: bool,
}

/// `mirror_remove`: unlinks a remote. A mirror becomes an ordinary
/// repository with what it has. Refused during a takeover. Returns
/// `Outcome<bool>`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorRemoveArgs {
    pub actor: User,
    pub remote_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hand_back_decides_each_ref_from_the_base() {
        let (a, b, c) = (Some("a"), Some("b"), Some("c"));
        assert_eq!(ref_action(a, a, a, false), RefAction::Same);
        assert_eq!(ref_action(a, b, b, false), RefAction::Same, "both moved to the same commit");
        assert_eq!(ref_action(a, b, a, false), RefAction::Push);
        assert_eq!(ref_action(a, b, a, true), RefAction::PullRequest, "a protected branch goes as a pull request");
        assert_eq!(ref_action(a, a, b, false), RefAction::Fetch);
        assert_eq!(ref_action(a, b, c, false), RefAction::Diverged);
        assert_eq!(ref_action(None, b, None, true), RefAction::Push, "a new branch is pushed");
        assert_eq!(ref_action(a, None, a, false), RefAction::Push, "a deleted branch is deleted there");
        assert_eq!(ref_action(None, None, b, false), RefAction::Fetch, "a branch made there is copied in");
    }

    #[test]
    fn a_plan_is_ready_once_every_diverged_ref_is_decided() {
        let diverged = |decision| RefPlan {
            git_ref: "refs/heads/docs".into(),
            base: Some("a".into()),
            ours: Some("b".into()),
            theirs: Some("c".into()),
            action: RefAction::Diverged,
            decision,
        };
        let plan = HandbackPlan::new(vec![diverged(None)], true);
        assert!(!plan.ready && !plan.clean());
        let plan = HandbackPlan::new(vec![diverged(Some(RefDecision::KeepTheirs))], true);
        assert!(plan.ready && !plan.clean());
        assert!(!HandbackPlan::new(Vec::new(), false).ready, "not while the remote is away");
        assert!(HandbackPlan::new(Vec::new(), true).clean());
    }

    #[test]
    fn only_a_takeover_takes_writes() {
        let mut mirror = RepoMirror { remote: "github.com/acme/web".into(), ..RepoMirror::default() };
        for (state, writable) in [
            (MirrorState::Standby, false),
            (MirrorState::Ci, false),
            (MirrorState::Takeover, true),
            (MirrorState::HandingBack, false),
        ] {
            mirror.state = state;
            assert_eq!(mirror.writable(), writable, "{state:?}");
            assert_eq!(MirrorState::parse(state.as_str()), Some(state));
            assert_eq!(RemoteState::parse(state.as_str()).mirror(), Some(state));
        }
        assert!(mirror_message("acme", "web", &RepoMirror { remote: "github.com/acme/web".into(), ..RepoMirror::default() })
            .contains("is a mirror of github.com/acme/web"));
    }

    #[test]
    fn settings_default_to_doing_nothing_on_their_own() {
        let settings: MirrorSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings, MirrorSettings::default());
        assert_eq!(settings.notify, Notify::Banner);
        assert_eq!(settings.take_over_after, None);
        assert!(!settings.keep_ci_warm);
    }
}
