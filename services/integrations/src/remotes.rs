//! Mirroring: a repository's links to copies of it on other hosts (see
//! `g1t_contracts::mirrors` for the model).
//!
//! Every linked repository has exactly one leader. A **mirror** follows a
//! remote that leads: it stands by as an exact, read-only copy, and nothing
//! runs on it. Someone can turn on **CI failover** (the remote keeps the
//! code, g1t runs its workflows) or **take over** (g1t leads for a while).
//! A takeover is **handed back** ref by ref: what only g1t changed is
//! pushed, a protected branch goes as a pull request, and a branch both
//! sides changed waits for a person's decision. A mirror can also be
//! **moved to g1t** for good, after which g1t no longer tracks the remote.
//! A repository g1t leads can be **mirrored to** any number of followers.
//!
//! This service keeps the links (`remotes`), each host's health
//! (`remote_hosts`) and a takeover's starting point (`remote_refs`), and
//! decides. The repos service keeps each repository's `RepoMirror`, set
//! here with `set_mirror`, so pushes and merges are refused or allowed
//! without asking. Git itself moves through the repos service (`mirror`,
//! `mirror_refs`, `mirror_apply`).
//!
//! Hosts are adapters: [`RemoteProvider`] names them, and the few places a
//! host's own API is used (credentials, whether a branch is protected,
//! opening a pull request) match on it. GitHub goes through g1t's GitHub
//! App; another g1t or any git host takes a username and token. A host
//! that sends no webhook is polled.
//!
//! Nothing happens on its own unless someone asked for it in the link's
//! settings: by default an unreachable remote is only shown on the
//! repository, and a takeover starts when someone starts it.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use g1t_contracts::access::{self, Capability};
use g1t_contracts::events::{NewEvent, Publish};
use g1t_contracts::identity::{ListMembersArgs, Member};
use g1t_contracts::mirrors::*;
use g1t_contracts::repos::{
    GetByIdArgs, MirrorApplied, MirrorApplyArgs, MirrorArgs, MirrorDirection, MirrorRefs, MirrorRefsArgs, Mirrored, RefMove,
    Repo, SetMirrorArgs,
};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, Role, User, new_id};
use g1t_kit::{args, now_ms, reply};
use g1t_secrets::Sealer;
use serde::Deserialize;
use serde_json::Value;
use worker::wasm_bindgen::JsValue;
use worker::{Context, D1Database, Env, Fetcher, Method, Response, Result};

use crate::github::GithubApp;
use crate::http;

const SOURCE: &str = "integrations";
/// A host is unreachable after this many failed checks in a row, spanning
/// at least [`DOWN_AFTER_MS`].
const DOWN_CHECKS: u32 = 3;
const DOWN_AFTER_MS: u64 = 2 * 60 * 1000;
/// And reachable again after this many good ones, spanning [`UP_AFTER_MS`].
const UP_CHECKS: u32 = 3;
const UP_AFTER_MS: u64 = 5 * 60 * 1000;
/// How often a remote with no webhook is asked for news.
const POLL_MS: u64 = 5 * 60 * 1000;
/// Where g1t's commits go when the remote will not take them directly.
const HANDBACK_PREFIX: &str = "refs/heads/g1t/handback/";
/// The most branches asked about protection in one plan.
const MAX_PROTECTION_CHECKS: usize = 20;

fn fail<T>(code: FailureCode, message: impl Into<String>) -> Outcome<T> {
    Outcome::fail(code, message)
}

fn null_or(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, Into::into)
}

// --- Pure parts, tested below ----------------------------------------------

/// The host of an https address, lowercased: `github.com`.
pub fn host_of(url: &str) -> String {
    url.trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default()
        .to_lowercase()
}

/// A remote as people name it: `github.com/acme/web`.
pub fn display_name(url: &str) -> String {
    let rest = url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let rest = rest.rsplit_once('@').map_or(rest, |(_, after)| after);
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    if path.is_empty() { host.to_lowercase() } else { format!("{}/{path}", host.to_lowercase()) }
}

/// A clone address: https, with `.git` added when the host leaves it off,
/// and no credentials in it.
pub fn clean_clone_url(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    let rest = url.strip_prefix("https://")?;
    if rest.contains('@') || rest.contains(' ') || !rest.contains('/') || rest.starts_with('/') {
        return None;
    }
    Some(if url.ends_with(".git") { url.to_owned() } else { format!("{url}.git") })
}

/// The web address of a clone address.
pub fn web_url(clone_url: &str) -> String {
    clone_url.strip_suffix(".git").unwrap_or(clone_url).to_owned()
}

/// How a host's health moves with one more check. `now` in milliseconds.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HostHealth {
    pub failures: u32,
    pub successes: u32,
    /// When the current run of failures or successes began.
    pub streak_ms: u64,
    pub unreachable_since: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    None,
    WentDown,
    CameBack,
}

impl HostHealth {
    pub fn reachable(&self) -> bool {
        self.unreachable_since.is_none()
    }

    pub fn checked(&self, answered: bool, now: u64) -> (HostHealth, Change) {
        let mut next = self.clone();
        if answered {
            if next.successes == 0 {
                next.streak_ms = now;
            }
            next.successes += 1;
            next.failures = 0;
            if next.unreachable_since.is_some()
                && next.successes >= UP_CHECKS
                && now.saturating_sub(next.streak_ms) >= UP_AFTER_MS
            {
                next.unreachable_since = None;
                return (next, Change::CameBack);
            }
        } else {
            if next.failures == 0 {
                next.streak_ms = now;
            }
            next.failures += 1;
            next.successes = 0;
            if next.unreachable_since.is_none()
                && next.failures >= DOWN_CHECKS
                && now.saturating_sub(next.streak_ms) >= DOWN_AFTER_MS
            {
                next.unreachable_since = Some(now);
                return (next, Change::WentDown);
            }
        }
        (next, Change::None)
    }
}

/// The branch name in a ref: `main` for `refs/heads/main`.
fn branch_of(git_ref: &str) -> Option<&str> {
    git_ref.strip_prefix("refs/heads/")
}

/// The moves that carry out a hand-back plan, and the refs that go as pull
/// requests. `theirs_all` is every ref the remote has, so a hand-back
/// branch made before is moved from where it is.
pub fn hand_back_moves(plan: &HandbackPlan, theirs_all: &BTreeMap<String, String>) -> (Vec<RefMove>, Vec<String>) {
    let mut moves = Vec::new();
    let mut pull_requests = Vec::new();
    for item in &plan.refs {
        let push = |moves: &mut Vec<RefMove>| {
            moves.push(RefMove {
                direction: MirrorDirection::Push,
                git_ref: item.git_ref.clone(),
                to: None,
                old: item.theirs.clone(),
                new: item.ours.clone(),
            })
        };
        let fetch = |moves: &mut Vec<RefMove>| {
            moves.push(RefMove {
                direction: MirrorDirection::Pull,
                git_ref: item.git_ref.clone(),
                to: None,
                old: item.ours.clone(),
                new: item.theirs.clone(),
            })
        };
        let decision = match item.action {
            RefAction::Diverged => item.decision,
            RefAction::PullRequest => Some(RefDecision::PullRequest),
            _ => None,
        };
        match (item.action, decision) {
            (RefAction::Same, _) => {}
            (RefAction::Push, _) | (RefAction::Diverged, Some(RefDecision::KeepOurs)) => push(&mut moves),
            (RefAction::Fetch, _) | (RefAction::Diverged, Some(RefDecision::KeepTheirs)) => fetch(&mut moves),
            (_, Some(RefDecision::PullRequest)) => {
                let Some(branch) = branch_of(&item.git_ref) else {
                    // Only branches can be pulled; a tag goes as it is.
                    push(&mut moves);
                    continue;
                };
                if let Some(ours) = &item.ours {
                    let target = format!("{HANDBACK_PREFIX}{branch}");
                    moves.push(RefMove {
                        direction: MirrorDirection::Push,
                        git_ref: item.git_ref.clone(),
                        to: Some(target.clone()),
                        old: theirs_all.get(&target).cloned(),
                        new: Some(ours.clone()),
                    });
                    pull_requests.push(item.git_ref.clone());
                }
                // g1t follows the remote's branch; its commits are on the
                // hand-back branch and kept under refs/g1t/replaced/.
                fetch(&mut moves);
            }
            (RefAction::Diverged, None) | (RefAction::PullRequest, _) => {}
        }
    }
    (moves, pull_requests)
}

/// Builds the plan for a hand-back from both sides' refs and what each ref
/// was when the takeover began. `protected` names branches the remote
/// protects.
pub fn plan_refs(
    bases: &BTreeMap<String, (Option<String>, Option<RefDecision>)>,
    ours: &BTreeMap<String, String>,
    theirs: &BTreeMap<String, String>,
    protected: &BTreeSet<String>,
) -> Vec<RefPlan> {
    let names: BTreeSet<&String> = bases.keys().chain(ours.keys()).chain(theirs.keys()).collect();
    names
        .into_iter()
        .filter(|name| !name.starts_with(HANDBACK_PREFIX))
        .filter(|name| name.starts_with("refs/heads/") || name.starts_with("refs/tags/"))
        .filter_map(|name| {
            let (base, decision) = bases.get(name).cloned().unwrap_or((None, None));
            let ours = ours.get(name).cloned();
            let theirs = theirs.get(name).cloned();
            // A ref g1t never had and the remote made since is copied in; a
            // ref neither had at the start nor has now is nothing.
            let action = ref_action(base.as_deref(), ours.as_deref(), theirs.as_deref(), protected.contains(name));
            (action != RefAction::Same).then(|| RefPlan {
                git_ref: name.clone(),
                base,
                ours,
                theirs,
                action,
                decision: if action == RefAction::Diverged { decision } else { None },
            })
        })
        .collect()
}

// --- Rows -------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct RemoteRow {
    pub id: String,
    pub repo_id: String,
    pub workspace: String,
    pub repo: String,
    pub provider: String,
    pub role: String,
    pub name: String,
    pub url: String,
    pub clone_url: String,
    pub connection_id: Option<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
    pub state: String,
    pub state_since: String,
    pub state_by: Option<String>,
    pub settings: String,
    pub synced_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
}

impl RemoteRow {
    fn provider(&self) -> RemoteProvider {
        RemoteProvider::parse(&self.provider).unwrap_or(RemoteProvider::Git)
    }

    fn leads(&self) -> bool {
        self.role == RemoteRole::Leader.as_str()
    }

    fn state(&self) -> RemoteState {
        RemoteState::parse(&self.state)
    }

    fn settings(&self) -> MirrorSettings {
        serde_json::from_str(&self.settings).unwrap_or_default()
    }

    fn host(&self) -> String {
        host_of(&self.clone_url)
    }

    /// `owner/name` on GitHub.
    fn full_name(&self) -> &str {
        self.url.trim_start_matches("https://github.com/")
    }

    /// What the repos service keeps for a mirror of this remote.
    fn repo_mirror(&self) -> Option<RepoMirror> {
        if !self.leads() {
            return None;
        }
        let settings = self.settings();
        Some(RepoMirror {
            state: self.state().mirror().unwrap_or_default(),
            remote: self.name.clone(),
            url: self.url.clone(),
            since: self.state_since.clone(),
            warm: settings.keep_ci_warm,
            github_workflows: settings.github_workflows,
            hold_deploys: settings.hold_deploys,
        })
    }

    fn contract(&self, health: Option<&HostRow>) -> Remote {
        Remote {
            id: self.id.clone(),
            repo_id: self.repo_id.clone(),
            repo: self.repo.clone(),
            provider: self.provider(),
            role: if self.leads() { RemoteRole::Leader } else { RemoteRole::Follower },
            name: self.name.clone(),
            url: self.url.clone(),
            state: self.state(),
            state_since: self.state_since.clone(),
            state_by: self.state_by.clone(),
            reachable: health.is_none_or(|health| health.unreachable_since.is_none()),
            unreachable_since: health.and_then(|health| health.unreachable_since.clone()),
            synced_at: self.synced_at.clone(),
            last_error: self.last_error.clone(),
            settings: self.settings(),
            created_at: self.created_at.clone(),
        }
    }

    fn link(&self) -> String {
        format!("/{}/settings/mirroring", self.repo)
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct HostRow {
    pub host: String,
    pub failures: u32,
    pub successes: u32,
    pub streak_ms: f64,
    pub unreachable_since: Option<String>,
}

impl HostRow {
    fn health(&self) -> HostHealth {
        HostHealth {
            failures: self.failures,
            successes: self.successes,
            streak_ms: self.streak_ms as u64,
            unreachable_since: self.unreachable_since.as_deref().and_then(crate::github::parse_time),
        }
    }
}

/// Who is acting: a person, or g1t on its own (an automatic takeover or
/// hand-back), which needs no role.
enum By<'a> {
    Person(&'a User),
    G1t,
}

impl By<'_> {
    fn name(&self) -> String {
        match self {
            By::Person(user) => user.username.clone(),
            By::G1t => "g1t".to_owned(),
        }
    }
}

pub struct Mirrors {
    db: D1Database,
    sealer: Option<Sealer>,
    repos: Fetcher,
    identity: Fetcher,
    events: Option<Fetcher>,
    github: GithubApp,
}

impl Mirrors {
    pub fn new(env: &Env) -> Result<Self> {
        Ok(Mirrors {
            db: env.d1("DB")?,
            sealer: env.secret("INTEGRATIONS_KEY").ok().and_then(|key| Sealer::new(&key.to_string())),
            repos: env.service("REPOS")?,
            identity: env.service("IDENTITY")?,
            events: env.service("EVENTS").ok(),
            github: GithubApp::new(env)?,
        })
    }

    // --- Reading --------------------------------------------------------------

    async fn rows(&self, repo_id: &str) -> Result<Vec<RemoteRow>> {
        self.db
            .prepare("SELECT * FROM remotes WHERE repo_id = ? ORDER BY role, created_at")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<RemoteRow>()
    }

    async fn row(&self, id: &str) -> Result<Option<RemoteRow>> {
        self.db.prepare("SELECT * FROM remotes WHERE id = ?").bind(&[id.into()])?.first::<RemoteRow>(None).await
    }

    async fn leader(&self, repo_id: &str) -> Result<Option<RemoteRow>> {
        self.db
            .prepare("SELECT * FROM remotes WHERE repo_id = ? AND role = 'leader'")
            .bind(&[repo_id.into()])?
            .first::<RemoteRow>(None)
            .await
    }

    async fn hosts(&self) -> Result<HashMap<String, HostRow>> {
        Ok(self
            .db
            .prepare("SELECT * FROM remote_hosts")
            .all()
            .await?
            .results::<HostRow>()?
            .into_iter()
            .map(|row| (row.host.clone(), row))
            .collect())
    }

    async fn repo(&self, repo_id: &str, viewer: Option<&User>) -> Result<Option<Repo>> {
        let viewer = viewer.cloned().or_else(|| Some(User::system("g1t")));
        let found: Outcome<Repo> =
            g1t_kit::call(&self.repos, "get_by_id", &GetByIdArgs { id: repo_id.to_owned(), viewer }).await?;
        Ok(found.into_result().ok())
    }

    /// Why `actor` may not change `repo`'s links, if they may not.
    fn refused<T>(actor: &User, repo: &Repo, capability: Capability) -> Option<Outcome<T>> {
        let target = access::RepoRef { id: &repo.id, namespace: &repo.namespace, private: repo.is_private };
        match access::check(Some(actor), target, capability) {
            Ok(()) => None,
            Err(access::Denied::NotFound) => Some(fail(FailureCode::NotFound, "Repository not found.")),
            Err(access::Denied::Forbidden) => {
                Some(fail(FailureCode::Forbidden, access::needs(capability, &format!("{}/{}", repo.namespace, repo.name))))
            }
        }
    }

    /// The repository and its leader, for someone changing them.
    async fn leader_for(&self, actor: &User, repo_id: &str) -> Result<std::result::Result<(Repo, RemoteRow), Outcome<MirrorView>>> {
        let Some(repo) = self.repo(repo_id, Some(actor)).await? else {
            return Ok(Err(fail(FailureCode::NotFound, "Repository not found.")));
        };
        if let Some(refused) = Self::refused(actor, &repo, Capability::ManageIntegrations) {
            return Ok(Err(refused));
        }
        let Some(row) = self.leader(repo_id).await? else {
            return Ok(Err(fail(FailureCode::NotFound, format!("{}/{} is not a mirror.", repo.namespace, repo.name))));
        };
        Ok(Ok((repo, row)))
    }

    async fn view_of(&self, repo_id: &str, can_manage: bool, plan: Option<HandbackPlan>) -> Result<MirrorView> {
        let hosts = self.hosts().await?;
        Ok(MirrorView {
            remotes: self.rows(repo_id).await?.iter().map(|row| row.contract(hosts.get(&row.host()))).collect(),
            plan,
            can_manage,
            notes: Vec::new(),
        })
    }

    pub async fn view(&self, a: MirrorViewArgs) -> Result<Outcome<MirrorView>> {
        let Some(repo) = self.repo(&a.repo_id, a.viewer.as_ref()).await? else {
            return Ok(fail(FailureCode::NotFound, "Repository not found."));
        };
        let can_manage = a
            .viewer
            .as_ref()
            .is_some_and(|viewer| Self::refused::<()>(viewer, &repo, Capability::ManageIntegrations).is_none());
        Ok(Outcome::Ok(self.view_of(&repo.id, can_manage, None).await?))
    }

    pub async fn briefs(&self, a: MirrorBriefsArgs) -> Result<Vec<RemoteBrief>> {
        let ids: Vec<&String> = a.repo_ids.iter().take(200).collect();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let marks = vec!["?"; ids.len()].join(", ");
        let bind: Vec<JsValue> = ids.iter().map(|id| id.as_str().into()).collect();
        let rows = self
            .db
            .prepare(format!("SELECT * FROM remotes WHERE repo_id IN ({marks}) ORDER BY role, created_at"))
            .bind(&bind)?
            .all()
            .await?
            .results::<RemoteRow>()?;
        let hosts = self.hosts().await?;
        Ok(rows
            .iter()
            .map(|row| RemoteBrief {
                repo_id: row.repo_id.clone(),
                role: if row.leads() { RemoteRole::Leader } else { RemoteRole::Follower },
                name: row.name.clone(),
                state: row.state(),
                reachable: hosts.get(&row.host()).is_none_or(|host| host.unreachable_since.is_none()),
                synced_at: row.synced_at.clone(),
            })
            .collect())
    }

    // --- Talking to hosts -----------------------------------------------------

    /// The user and token a remote is opened with.
    async fn credential(&self, row: &RemoteRow) -> Result<std::result::Result<(Option<String>, String), String>> {
        match row.provider() {
            RemoteProvider::Github => {
                let Some(installation) = row.connection_id.as_deref().and_then(|id| id.parse::<u64>().ok()) else {
                    return Ok(Err("This link has no GitHub installation.".to_owned()));
                };
                Ok(self.github.installation_token(installation).await?.map(|token| (None, token)))
            }
            RemoteProvider::G1t | RemoteProvider::Git => {
                let (Some(sealer), Some(sealed)) = (&self.sealer, row.credential.as_deref()) else {
                    return Ok(Err("This link has no token. Add one in its settings.".to_owned()));
                };
                match sealer.open(sealed, &format!("rmt:{}", row.id)) {
                    Some(token) => Ok(Ok((row.username.clone(), token))),
                    None => Ok(Err("This link's token could not be read. Add it again.".to_owned())),
                }
            }
        }
    }

    /// Which of `branches` the remote protects. Hosts that cannot say
    /// protect none: a refused push still goes as a pull request.
    async fn protected(&self, row: &RemoteRow, token: &str, branches: &[String]) -> Result<BTreeSet<String>> {
        let mut protected = BTreeSet::new();
        if row.provider() != RemoteProvider::Github {
            return Ok(protected);
        }
        for git_ref in branches.iter().take(MAX_PROTECTION_CHECKS) {
            let Some(branch) = branch_of(git_ref) else { continue };
            let Ok(answer) = self
                .github
                .api(Method::Get, &format!("/repos/{}/branches/{}", row.full_name(), branch), token, None)
                .await
            else {
                continue;
            };
            if answer.ok() && answer.json()["protected"].as_bool() == Some(true) {
                protected.insert(git_ref.clone());
            }
        }
        Ok(protected)
    }

    /// Opens a pull request on the remote from a hand-back branch. Returns
    /// a line for people: where it is, or how to open it by hand.
    async fn open_pull_request(&self, row: &RemoteRow, token: &str, git_ref: &str, repo: &str) -> Result<String> {
        let branch = branch_of(git_ref).unwrap_or(git_ref);
        let head = format!("g1t/handback/{branch}");
        let by_hand = format!("{branch}: g1t's commits are on {head} on {}. Open a pull request from it into {branch}.", row.name);
        if row.provider() != RemoteProvider::Github {
            return Ok(by_hand);
        }
        let body = serde_json::json!({
            "title": format!("Changes made on g1t while {} was unreachable", row.name),
            "head": head,
            "base": branch,
            "body": format!(
                "g1t led [{repo}](https://g1t.sh/{repo}) while this repository could not be reached. These are the commits made there on `{branch}`.\n\nThe branch is protected here, so they come as a pull request rather than a push."
            ),
            "maintainer_can_modify": true,
        });
        let Ok(answer) = self.github.api(Method::Post, &format!("/repos/{}/pulls", row.full_name()), token, Some(body)).await
        else {
            return Ok(by_hand);
        };
        let said = answer.json();
        Ok(if answer.ok() {
            format!("{branch}: opened {}", said["html_url"].as_str().unwrap_or("a pull request"))
        } else if answer.status == 422 && said.to_string().contains("already exists") {
            format!("{branch}: the pull request from {head} was already open and now has the new commits.")
        } else {
            format!("{by_hand} ({})", answer.problem("GitHub"))
        })
    }

    async fn repos_refs(&self, row: &RemoteRow, username: Option<String>, token: String) -> Result<Outcome<MirrorRefs>> {
        g1t_kit::call(
            &self.repos,
            "mirror_refs",
            &MirrorRefsArgs { repo_id: row.repo_id.clone(), url: row.clone_url.clone(), token, username },
        )
        .await
    }

    /// g1t's own refs, asking nothing of the remote: a takeover starts while
    /// it is away, when not even a token can be had from it.
    async fn our_refs(&self, row: &RemoteRow) -> Result<Outcome<MirrorRefs>> {
        g1t_kit::call(
            &self.repos,
            "mirror_refs",
            &MirrorRefsArgs { repo_id: row.repo_id.clone(), url: String::new(), token: String::new(), username: None },
        )
        .await
    }

    async fn apply(&self, row: &RemoteRow, username: Option<String>, token: String, moves: Vec<RefMove>) -> Result<Outcome<MirrorApplied>> {
        g1t_kit::call(
            &self.repos,
            "mirror_apply",
            &MirrorApplyArgs { repo_id: row.repo_id.clone(), url: row.clone_url.clone(), token, username, moves },
        )
        .await
    }

    /// Copies refs in the link's direction: a mirror catches up, a follower
    /// is pushed to. `Err` is a reason, already recorded on the link.
    async fn sync(&self, row: &RemoteRow) -> Result<std::result::Result<Mirrored, String>> {
        let direction = if row.leads() { MirrorDirection::Pull } else { MirrorDirection::Push };
        let (username, token) = match self.credential(row).await? {
            Ok(credential) => credential,
            Err(reason) => {
                self.note(row, Some(&reason)).await?;
                return Ok(Err(reason));
            }
        };
        let done: Outcome<Mirrored> = g1t_kit::call(
            &self.repos,
            "mirror",
            &MirrorArgs { repo_id: row.repo_id.clone(), url: row.clone_url.clone(), token, username, direction },
        )
        .await?;
        match done {
            Outcome::Ok(mirrored) => {
                self.note(row, None).await?;
                self.host_checked(&row.host(), true, None).await?;
                Ok(Ok(mirrored))
            }
            Outcome::Fail(failure) => {
                let unreachable = failure.code == FailureCode::Unavailable;
                if unreachable {
                    self.host_checked(&row.host(), false, Some(&failure.message)).await?;
                } else {
                    self.note(row, Some(&failure.message)).await?;
                }
                if !row.leads() && !unreachable {
                    self.set_state(row, RemoteState::Stuck, None).await?;
                }
                Ok(Err(failure.message))
            }
        }
    }

    async fn note(&self, row: &RemoteRow, problem: Option<&str>) -> Result<()> {
        let statement = match problem {
            Some(problem) => self
                .db
                .prepare("UPDATE remotes SET last_error = ?2 WHERE id = ?1")
                .bind(&[row.id.as_str().into(), problem.into()])?,
            None => self
                .db
                .prepare("UPDATE remotes SET last_error = NULL, synced_at = ?2 WHERE id = ?1")
                .bind(&[row.id.as_str().into(), rfc3339(now_ms()).into()])?,
        };
        statement.run().await?;
        if problem.is_none() && row.state() == RemoteState::Stuck {
            self.set_state(row, RemoteState::Following, None).await?;
        }
        Ok(())
    }

    // --- State ------------------------------------------------------------------

    /// Records a link's state, and tells the repos service what a mirror
    /// is now. A link the repos service has not heard of yet is retried by
    /// the cron (`recorded`).
    async fn set_state(&self, row: &RemoteRow, state: RemoteState, by: Option<&str>) -> Result<RemoteRow> {
        let now = rfc3339(now_ms());
        self.db
            .prepare("UPDATE remotes SET state = ?2, state_since = ?3, state_by = ?4, recorded = 0 WHERE id = ?1")
            .bind(&[row.id.as_str().into(), state.as_str().into(), now.as_str().into(), null_or(by)])?
            .run()
            .await?;
        let row = RemoteRow {
            state: state.as_str().to_owned(),
            state_since: now,
            state_by: by.map(str::to_owned),
            ..row.clone()
        };
        self.record(&row).await?;
        Ok(row)
    }

    /// Tells the repos service a repository's mirror, as this link has it.
    async fn record(&self, row: &RemoteRow) -> Result<()> {
        if !row.leads() {
            return Ok(());
        }
        let done: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "set_mirror",
            &SetMirrorArgs { repo_id: row.repo_id.clone(), mirror: row.repo_mirror() },
        )
        .await?;
        if done.into_result().is_ok() {
            self.db.prepare("UPDATE remotes SET recorded = 1 WHERE id = ?").bind(&[row.id.as_str().into()])?.run().await?;
        }
        Ok(())
    }

    async fn publish(&self, kind: &'static str, row: &RemoteRow, by: Option<&str>, title: String, detail: Option<String>, notify: Vec<String>) {
        let Some(events) = &self.events else { return };
        let event = NewEvent {
            kind,
            source: SOURCE,
            repo_id: Some(row.repo_id.clone()),
            actor: None,
            data: MirrorEvent {
                repo_id: row.repo_id.clone(),
                repo: row.repo.clone(),
                remote_id: row.id.clone(),
                remote: row.name.clone(),
                state: (kind != "mirror.moved_in").then(|| row.state.clone()),
                from: None,
                by: by.map(str::to_owned),
                title,
                detail,
                notify,
                link: row.link(),
            },
        };
        let sent: Result<Value> = g1t_kit::call(events, "publish", &Publish { events: vec![event] }).await;
        if let Err(error) = sent {
            worker::console_error!("mirrors: publishing {kind} for {} failed: {error}", row.repo);
        }
    }

    /// The workspace's owners, when the link asks for the inbox.
    async fn told(&self, row: &RemoteRow, except: Option<&str>) -> Vec<String> {
        if row.settings().notify != Notify::Inbox {
            return Vec::new();
        }
        let members: Result<Outcome<Vec<Member>>> = g1t_kit::call(
            &self.identity,
            "list_members",
            &ListMembersArgs { slug: row.workspace.clone(), viewer: Some(User::system(&row.workspace)) },
        )
        .await;
        match members {
            Ok(Outcome::Ok(members)) => members
                .into_iter()
                .filter(|member| member.role == Role::Owner)
                .map(|member| member.username)
                .filter(|name| except.is_none_or(|except| !name.eq_ignore_ascii_case(except)))
                .collect(),
            _ => Vec::new(),
        }
    }

    // --- Takeover, CI failover, hand-back, moving in ------------------------------

    pub async fn take_over(&self, a: MirrorActArgs) -> Result<Outcome<MirrorView>> {
        let (_, row) = match self.leader_for(&a.actor, &a.repo_id).await? {
            Ok(found) => found,
            Err(refused) => return Ok(refused),
        };
        self.start_takeover(row, By::Person(&a.actor)).await
    }

    async fn start_takeover(&self, row: RemoteRow, by: By<'_>) -> Result<Outcome<MirrorView>> {
        match row.state() {
            RemoteState::Takeover => return Ok(Outcome::Ok(self.view_of(&row.repo_id, true, None).await?)),
            RemoteState::HandingBack => {
                return Ok(fail(FailureCode::Conflict, "It is being handed back. Wait for that to finish, or for it to stop."));
            }
            _ => {}
        }
        // The starting point: what g1t holds now, which is what it last
        // copied from the remote.
        let refs = match self.our_refs(&row).await? {
            Outcome::Ok(refs) => refs,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let mut statements = vec![self.db.prepare("DELETE FROM remote_refs WHERE remote_id = ?").bind(&[row.id.as_str().into()])?];
        for (name, hash) in &refs.ours {
            statements.push(
                self.db
                    .prepare("INSERT INTO remote_refs (remote_id, ref, base) VALUES (?, ?, ?)")
                    .bind(&[row.id.as_str().into(), name.as_str().into(), hash.as_str().into()])?,
            );
        }
        self.db.batch(statements).await?;
        let name = by.name();
        let row = self.set_state(&row, RemoteState::Takeover, Some(&name)).await?;
        let notify = self.told(&row, Some(&name)).await;
        let title = match by {
            By::G1t => format!("g1t took over {} while {} is unreachable", row.repo, row.name),
            By::Person(_) => format!("{name} took over {} from {}", row.repo, row.name),
        };
        self.publish("mirror.state_changed", &row, Some(&name), title, None, notify).await;
        Ok(Outcome::Ok(self.view_of(&row.repo_id, true, None).await?))
    }

    pub async fn ci(&self, a: MirrorCiArgs) -> Result<Outcome<MirrorView>> {
        let (_, row) = match self.leader_for(&a.actor, &a.repo_id).await? {
            Ok(found) => found,
            Err(refused) => return Ok(refused),
        };
        let next = match (row.state(), a.on) {
            (RemoteState::Standby, true) => RemoteState::Ci,
            (RemoteState::Ci, false) => RemoteState::Standby,
            (RemoteState::Ci, true) | (RemoteState::Standby, false) => {
                return Ok(Outcome::Ok(self.view_of(&row.repo_id, true, None).await?));
            }
            _ => return Ok(fail(FailureCode::Conflict, "g1t leads this repository now: its workflows already run here.")),
        };
        let row = self.set_state(&row, next, Some(&a.actor.username)).await?;
        let title = if a.on {
            format!("{} started running {}'s workflows on g1t", a.actor.username, row.name)
        } else {
            format!("{} ended CI failover for {}", a.actor.username, row.repo)
        };
        self.publish("mirror.state_changed", &row, Some(&a.actor.username), title, None, Vec::new()).await;
        Ok(Outcome::Ok(self.view_of(&row.repo_id, true, None).await?))
    }

    /// What handing back would do now.
    async fn plan(&self, row: &RemoteRow) -> Result<Outcome<HandbackPlan>> {
        let (username, token) = match self.credential(row).await? {
            Ok(credential) => credential,
            Err(reason) => return Ok(fail(FailureCode::Conflict, reason)),
        };
        let refs = match self.repos_refs(row, username, token.clone()).await? {
            Outcome::Ok(refs) => refs,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let bases = self.bases(row).await?;
        let Some(theirs) = refs.theirs else {
            // The remote is away: what g1t changed, as it would go.
            let refs = plan_refs(&bases, &refs.ours, &bases_as_theirs(&bases), &BTreeSet::new());
            return Ok(Outcome::Ok(HandbackPlan::new(refs, false)));
        };
        let candidates: Vec<String> = plan_refs(&bases, &refs.ours, &theirs, &BTreeSet::new())
            .into_iter()
            .filter(|plan| plan.action == RefAction::Push && plan.ours.is_some() && plan.theirs.is_some())
            .map(|plan| plan.git_ref)
            .collect();
        let protected = self.protected(row, &token, &candidates).await?;
        Ok(Outcome::Ok(HandbackPlan::new(plan_refs(&bases, &refs.ours, &theirs, &protected), true)))
    }

    async fn bases(&self, row: &RemoteRow) -> Result<BTreeMap<String, (Option<String>, Option<RefDecision>)>> {
        #[derive(Deserialize)]
        struct Base {
            #[serde(rename = "ref")]
            git_ref: String,
            base: Option<String>,
            decision: Option<String>,
        }
        Ok(self
            .db
            .prepare("SELECT ref, base, decision FROM remote_refs WHERE remote_id = ?")
            .bind(&[row.id.as_str().into()])?
            .all()
            .await?
            .results::<Base>()?
            .into_iter()
            .map(|base| {
                let decision = base.decision.and_then(|text| serde_json::from_value(Value::String(text)).ok());
                (base.git_ref, (base.base, decision))
            })
            .collect())
    }

    pub async fn hand_back_plan(&self, a: MirrorActArgs) -> Result<Outcome<MirrorView>> {
        let (_, row) = match self.leader_for(&a.actor, &a.repo_id).await? {
            Ok(found) => found,
            Err(refused) => return Ok(refused),
        };
        if !matches!(row.state(), RemoteState::Takeover | RemoteState::HandingBack) {
            return Ok(fail(FailureCode::Conflict, "g1t has not taken over, so there is nothing to hand back."));
        }
        let plan = match self.plan(&row).await? {
            Outcome::Ok(plan) => plan,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        Ok(Outcome::Ok(self.view_of(&row.repo_id, true, Some(plan)).await?))
    }

    pub async fn hand_back(&self, a: MirrorHandBackArgs) -> Result<Outcome<MirrorView>> {
        let (_, row) = match self.leader_for(&a.actor, &a.repo_id).await? {
            Ok(found) => found,
            Err(refused) => return Ok(refused),
        };
        let mut statements = Vec::new();
        for (git_ref, decision) in &a.decisions {
            let decision = serde_json::to_value(decision).ok().and_then(|value| value.as_str().map(str::to_owned));
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO remote_refs (remote_id, ref, decision) VALUES (?1, ?2, ?3)
                         ON CONFLICT (remote_id, ref) DO UPDATE SET decision = excluded.decision",
                    )
                    .bind(&[row.id.as_str().into(), git_ref.as_str().into(), null_or(decision.as_deref())])?,
            );
        }
        if !statements.is_empty() {
            self.db.batch(statements).await?;
        }
        self.finish_takeover(row, By::Person(&a.actor)).await
    }

    /// Hands a takeover back: freezes the repository, moves each ref as the
    /// plan says, and returns to standing by. If anything is refused, g1t
    /// keeps the lead and says why, so nobody is stuck.
    async fn finish_takeover(&self, row: RemoteRow, by: By<'_>) -> Result<Outcome<MirrorView>> {
        if !matches!(row.state(), RemoteState::Takeover | RemoteState::HandingBack) {
            return Ok(fail(FailureCode::Conflict, "g1t has not taken over, so there is nothing to hand back."));
        }
        let plan = match self.plan(&row).await? {
            Outcome::Ok(plan) => plan,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !plan.reachable {
            return Ok(fail(FailureCode::Unavailable, format!("{} is not answering yet. Hand back once it is.", row.name)));
        }
        if !plan.ready {
            return Ok(Outcome::Fail(undecided(&plan)));
        }
        let name = by.name();
        // Nothing moves on g1t while it goes back.
        let row = self.set_state(&row, RemoteState::HandingBack, Some(&name)).await?;
        let plan = match self.plan(&row).await? {
            Outcome::Ok(plan) if plan.ready => plan,
            Outcome::Ok(plan) => {
                let row = self.set_state(&row, RemoteState::Takeover, row.state_by.as_deref()).await?;
                let _ = row;
                return Ok(Outcome::Fail(undecided(&plan)));
            }
            Outcome::Fail(failure) => {
                self.set_state(&row, RemoteState::Takeover, Some(&name)).await?;
                return Ok(Outcome::Fail(failure));
            }
        };
        let (username, token) = match self.credential(&row).await? {
            Ok(credential) => credential,
            Err(reason) => {
                self.set_state(&row, RemoteState::Takeover, Some(&name)).await?;
                return Ok(fail(FailureCode::Conflict, reason));
            }
        };
        let theirs_all = match self.repos_refs(&row, username.clone(), token.clone()).await? {
            Outcome::Ok(refs) => refs.theirs.unwrap_or_default(),
            Outcome::Fail(_) => BTreeMap::new(),
        };
        let (moves, mut pull_requests) = hand_back_moves(&plan, &theirs_all);
        let mut problems = Vec::new();
        if !moves.is_empty() {
            let applied = match self.apply(&row, username.clone(), token.clone(), moves).await? {
                Outcome::Ok(applied) => applied,
                Outcome::Fail(failure) => {
                    self.set_state(&row, RemoteState::Takeover, Some(&name)).await?;
                    self.note(&row, Some(&failure.message)).await?;
                    return Ok(Outcome::Fail(failure));
                }
            };
            // A push the remote refused (a protected branch it did not say
            // was protected) goes as a pull request instead.
            let refused: Vec<RefPlan> = applied
                .moved
                .iter()
                .filter(|moved| moved.direction == MirrorDirection::Push && moved.problem.is_some())
                .filter_map(|moved| {
                    plan.refs
                        .iter()
                        .find(|item| item.git_ref == moved.git_ref && branch_of(&item.git_ref).is_some() && item.ours.is_some())
                        .cloned()
                })
                .collect();
            for moved in applied.moved.iter().filter(|moved| moved.problem.is_some()) {
                if !refused.iter().any(|item| item.git_ref == moved.git_ref) {
                    problems.push(format!("{}: {}", moved.git_ref, moved.problem.as_deref().unwrap_or_default()));
                }
            }
            if !refused.is_empty() {
                let retry = HandbackPlan::new(
                    refused
                        .into_iter()
                        .map(|item| RefPlan { action: RefAction::PullRequest, ..item })
                        .collect(),
                    true,
                );
                let (moves, more) = hand_back_moves(&retry, &theirs_all);
                match self.apply(&row, username.clone(), token.clone(), moves).await? {
                    Outcome::Ok(applied) => {
                        for moved in applied.moved.iter().filter(|moved| moved.problem.is_some()) {
                            problems.push(format!("{}: {}", moved.git_ref, moved.problem.as_deref().unwrap_or_default()));
                        }
                        pull_requests.extend(more);
                    }
                    Outcome::Fail(failure) => problems.push(failure.message),
                }
            }
        }
        if !problems.is_empty() {
            let reason = format!("Some branches did not go back: {}", problems.join("; "));
            let row = self.set_state(&row, RemoteState::Takeover, Some(&name)).await?;
            self.note(&row, Some(&reason)).await?;
            return Ok(fail(FailureCode::Conflict, format!("{reason}. g1t still leads; try again or decide differently.")));
        }
        let mut notes = Vec::new();
        for git_ref in &pull_requests {
            notes.push(self.open_pull_request(&row, &token, git_ref, &row.repo).await?);
        }
        self.db.prepare("DELETE FROM remote_refs WHERE remote_id = ?").bind(&[row.id.as_str().into()])?.run().await?;
        let row = self.set_state(&row, RemoteState::Standby, Some(&name)).await?;
        // Anything else the remote has, g1t now follows.
        if let Err(reason) = self.sync(&row).await? {
            notes.push(format!("Catching up after handing back: {reason}"));
        }
        let notify = self.told(&row, Some(&name)).await;
        let detail = (!notes.is_empty()).then(|| notes.join("\n"));
        self.publish(
            "mirror.state_changed",
            &row,
            Some(&name),
            format!("{} was handed back to {}", row.repo, row.name),
            detail,
            notify,
        )
        .await;
        let mut view = self.view_of(&row.repo_id, true, None).await?;
        view.notes = notes;
        Ok(Outcome::Ok(view))
    }

    pub async fn move_in(&self, a: MirrorMoveInArgs) -> Result<Outcome<MirrorView>> {
        let (_, row) = match self.leader_for(&a.actor, &a.repo_id).await? {
            Ok(found) => found,
            Err(refused) => return Ok(refused),
        };
        if row.state() == RemoteState::HandingBack {
            return Ok(fail(FailureCode::Conflict, "It is being handed back. Move it to g1t once that is done."));
        }
        let done: Outcome<Repo> =
            g1t_kit::call(&self.repos, "set_mirror", &SetMirrorArgs { repo_id: row.repo_id.clone(), mirror: None }).await?;
        if let Outcome::Fail(failure) = done {
            return Ok(Outcome::Fail(failure));
        }
        self.db.prepare("DELETE FROM remote_refs WHERE remote_id = ?").bind(&[row.id.as_str().into()])?.run().await?;
        let mut notes = Vec::new();
        if a.keep_remote_updated {
            let now = rfc3339(now_ms());
            self.db
                .prepare(
                    "UPDATE remotes SET role = 'follower', state = 'following', state_since = ?2, state_by = ?3, recorded = 1
                     WHERE id = ?1",
                )
                .bind(&[row.id.as_str().into(), now.as_str().into(), a.actor.username.as_str().into()])?
                .run()
                .await?;
            if let Some(follower) = self.row(&row.id).await?
                && let Err(reason) = self.sync(&follower).await?
            {
                notes.push(format!("{} could not be brought up to date yet: {reason}", row.name));
            }
        } else {
            self.db.prepare("DELETE FROM remotes WHERE id = ?").bind(&[row.id.as_str().into()])?.run().await?;
        }
        if row.provider() == RemoteProvider::Github {
            let mode = if a.keep_remote_updated { "push" } else { "import" };
            self.db
                .prepare("UPDATE github_repos SET mode = ? WHERE repo_id = ?")
                .bind(&[mode.into(), row.repo_id.as_str().into()])?
                .run()
                .await?;
        }
        let title = if a.keep_remote_updated {
            format!("{} moved {} to g1t; {} now follows it", a.actor.username, row.repo, row.name)
        } else {
            format!("{} moved {} to g1t and stopped tracking {}", a.actor.username, row.repo, row.name)
        };
        self.publish("mirror.moved_in", &row, Some(&a.actor.username), title, None, Vec::new()).await;
        let mut view = self.view_of(&row.repo_id, true, None).await?;
        view.notes = notes;
        Ok(Outcome::Ok(view))
    }

    pub async fn sync_now(&self, a: MirrorActArgs) -> Result<Outcome<MirrorView>> {
        let Some(repo) = self.repo(&a.repo_id, Some(&a.actor)).await? else {
            return Ok(fail(FailureCode::NotFound, "Repository not found."));
        };
        // Syncing brings commits in, as pushing does.
        if let Some(refused) = Self::refused(&a.actor, &repo, Capability::Push) {
            return Ok(refused);
        }
        let rows = self.rows(&repo.id).await?;
        if rows.is_empty() {
            return Ok(fail(FailureCode::NotFound, "This repository is not linked to another host."));
        }
        let mut problems = Vec::new();
        for row in &rows {
            if row.leads() && !row.state().mirror().is_some_and(MirrorState::follows) {
                continue;
            }
            if let Err(reason) = self.sync(row).await? {
                problems.push(format!("{}: {reason}", row.name));
            }
        }
        if !problems.is_empty() {
            return Ok(fail(FailureCode::Conflict, problems.join("; ")));
        }
        Ok(Outcome::Ok(self.view_of(&repo.id, true, None).await?))
    }

    pub async fn settings(&self, a: MirrorSettingsArgs) -> Result<Outcome<Remote>> {
        let Some(row) = self.row(&a.remote_id).await? else {
            return Ok(fail(FailureCode::NotFound, "That link was not found."));
        };
        let Some(repo) = self.repo(&row.repo_id, Some(&a.actor)).await? else {
            return Ok(fail(FailureCode::NotFound, "Repository not found."));
        };
        if let Some(refused) = Self::refused(&a.actor, &repo, Capability::ManageIntegrations) {
            return Ok(refused);
        }
        let (least, most) = TAKE_OVER_AFTER_MINUTES;
        if a.settings.take_over_after.is_some_and(|minutes| minutes < least || minutes > most) {
            return Ok(fail(FailureCode::Invalid, format!("Take over after between {least} minutes and {} hours.", most / 60)));
        }
        let settings = serde_json::to_string(&a.settings).unwrap_or_else(|_| "{}".to_owned());
        self.db
            .prepare("UPDATE remotes SET settings = ?2, recorded = 0 WHERE id = ?1")
            .bind(&[row.id.as_str().into(), settings.as_str().into()])?
            .run()
            .await?;
        let row = RemoteRow { settings, ..row };
        self.record(&row).await?;
        let hosts = self.hosts().await?;
        Ok(Outcome::Ok(row.contract(hosts.get(&row.host()))))
    }

    pub async fn add(&self, a: MirrorAddArgs) -> Result<Outcome<Remote>> {
        if a.provider == RemoteProvider::Github {
            return Ok(fail(FailureCode::Invalid, "Link GitHub repositories through the GitHub App, from New → Import from GitHub."));
        }
        let Some(repo) = self.repo(&a.repo_id, Some(&a.actor)).await? else {
            return Ok(fail(FailureCode::NotFound, "Repository not found."));
        };
        if let Some(refused) = Self::refused(&a.actor, &repo, Capability::ManageIntegrations) {
            return Ok(refused);
        }
        let Some(clone_url) = clean_clone_url(&a.url) else {
            return Ok(fail(FailureCode::Invalid, "Give the remote's https address, such as https://g1t.sh/acme/web.git."));
        };
        let Some(token) = a.token.as_deref().map(str::trim).filter(|token| !token.is_empty()) else {
            return Ok(fail(FailureCode::Invalid, "Give a token that can read and push to the remote."));
        };
        let Some(sealer) = &self.sealer else {
            return Ok(fail(FailureCode::Conflict, "Tokens cannot be kept on this g1t: INTEGRATIONS_KEY is not set."));
        };
        if a.role == RemoteRole::Leader && self.leader(&repo.id).await?.is_some() {
            return Ok(fail(FailureCode::Conflict, "This repository already mirrors a remote. A repository follows one leader."));
        }
        let now = now_ms();
        let id = new_id("rmt", now);
        let row = RemoteRow {
            id: id.clone(),
            repo_id: repo.id.clone(),
            workspace: repo.namespace.clone(),
            repo: format!("{}/{}", repo.namespace, repo.name),
            provider: a.provider.as_str().to_owned(),
            role: a.role.as_str().to_owned(),
            name: display_name(&clone_url),
            url: web_url(&clone_url),
            clone_url: clone_url.clone(),
            connection_id: None,
            username: a.username.map(|name| name.trim().to_owned()).filter(|name| !name.is_empty()),
            credential: Some(sealer.seal(token, &format!("rmt:{id}"))),
            state: if a.role == RemoteRole::Leader { "standby" } else { "following" }.to_owned(),
            state_since: rfc3339(now),
            state_by: Some(a.actor.username.clone()),
            settings: "{}".to_owned(),
            synced_at: None,
            last_error: None,
            created_at: rfc3339(now),
        };
        if row.name.eq_ignore_ascii_case(&format!("g1t.sh/{}", row.repo)) {
            return Ok(fail(FailureCode::Invalid, "That is this repository."));
        }
        // A leader fills an empty repository; one with history of its own
        // would lose it.
        if a.role == RemoteRole::Leader {
            let refs = match self.repos_refs(&row, row.username.clone(), token.to_owned()).await? {
                Outcome::Ok(refs) => refs,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            };
            if !refs.ours.is_empty() {
                return Ok(fail(
                    FailureCode::Conflict,
                    "Only an empty repository can become a mirror: it is filled from the remote. Make a new repository for it.",
                ));
            }
            if let Some(reason) = refs.unreachable {
                return Ok(fail(FailureCode::Unavailable, reason));
            }
        }
        self.db
            .prepare(
                "INSERT INTO remotes
                   (id, repo_id, workspace, repo, provider, role, name, url, clone_url, username, credential,
                    state, state_since, state_by, settings, created_by, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, '{}', ?15, ?13)",
            )
            .bind(&[
                row.id.as_str().into(),
                row.repo_id.as_str().into(),
                row.workspace.as_str().into(),
                row.repo.as_str().into(),
                row.provider.as_str().into(),
                row.role.as_str().into(),
                row.name.as_str().into(),
                row.url.as_str().into(),
                row.clone_url.as_str().into(),
                null_or(row.username.as_deref()),
                null_or(row.credential.as_deref()),
                row.state.as_str().into(),
                row.state_since.as_str().into(),
                a.actor.username.as_str().into(),
                a.actor.id.as_str().into(),
            ])?
            .run()
            .await?;
        self.record(&row).await?;
        let synced = self.sync(&row).await?;
        let row = self.row(&id).await?.unwrap_or(row);
        if let Err(reason) = synced {
            let hosts = self.hosts().await?;
            let mut remote = row.contract(hosts.get(&row.host()));
            remote.last_error = Some(reason);
            return Ok(Outcome::Ok(remote));
        }
        let hosts = self.hosts().await?;
        Ok(Outcome::Ok(row.contract(hosts.get(&row.host()))))
    }

    pub async fn remove(&self, a: MirrorRemoveArgs) -> Result<Outcome<bool>> {
        let Some(row) = self.row(&a.remote_id).await? else {
            return Ok(Outcome::Ok(false));
        };
        let Some(repo) = self.repo(&row.repo_id, Some(&a.actor)).await? else {
            return Ok(fail(FailureCode::NotFound, "Repository not found."));
        };
        if let Some(refused) = Self::refused(&a.actor, &repo, Capability::ManageIntegrations) {
            return Ok(refused);
        }
        if row.leads() && matches!(row.state(), RemoteState::Takeover | RemoteState::HandingBack) {
            return Ok(fail(
                FailureCode::Conflict,
                "g1t leads this repository for now. Hand it back, or move it to g1t, before unlinking.",
            ));
        }
        if row.leads() {
            let done: Outcome<Repo> =
                g1t_kit::call(&self.repos, "set_mirror", &SetMirrorArgs { repo_id: row.repo_id.clone(), mirror: None }).await?;
            if let Outcome::Fail(failure) = done {
                return Ok(Outcome::Fail(failure));
            }
        }
        self.db.prepare("DELETE FROM remote_refs WHERE remote_id = ?").bind(&[row.id.as_str().into()])?.run().await?;
        self.db.prepare("DELETE FROM remotes WHERE id = ?").bind(&[row.id.as_str().into()])?.run().await?;
        if row.provider() == RemoteProvider::Github {
            self.db
                .prepare("UPDATE github_repos SET mode = 'import' WHERE repo_id = ?")
                .bind(&[row.repo_id.as_str().into()])?
                .run()
                .await?;
        }
        Ok(Outcome::Ok(true))
    }

    /// A remote g1t can no longer reach for good (uninstalled, deleted). A
    /// mirror standing by becomes an ordinary repository with what it has,
    /// since it can no longer follow; a follower is let go; a takeover
    /// keeps going and is told why, so nothing is lost.
    pub async fn link_gone(&self, id: &str, why: &str) -> Result<()> {
        let Some(row) = self.row(id).await? else { return Ok(()) };
        if row.leads() && matches!(row.state(), RemoteState::Takeover | RemoteState::HandingBack) {
            let reason = format!("{} {why}. g1t keeps leading; move it to g1t to keep it here.", row.name);
            return self.note(&row, Some(&reason)).await;
        }
        if row.leads() {
            let _: Outcome<Repo> =
                g1t_kit::call(&self.repos, "set_mirror", &SetMirrorArgs { repo_id: row.repo_id.clone(), mirror: None }).await?;
        }
        self.db.prepare("DELETE FROM remote_refs WHERE remote_id = ?").bind(&[row.id.as_str().into()])?.run().await?;
        self.db.prepare("DELETE FROM remotes WHERE id = ?").bind(&[row.id.as_str().into()])?.run().await?;
        let title = if row.leads() {
            format!("{} stopped mirroring {}: it {why}. g1t keeps what it has.", row.repo, row.name)
        } else {
            format!("{} stopped pushing to {}: it {why}.", row.repo, row.name)
        };
        let notify = self.told(&row, None).await;
        self.publish("mirror.moved_in", &row, Some("g1t"), title, None, notify).await;
        Ok(())
    }

    // --- What hosts and g1t say -----------------------------------------------

    /// A push on GitHub, from the App's webhook.
    pub async fn on_github_push(&self, payload: &Value) -> Result<()> {
        let Some(id) = payload["repository"]["id"].as_u64() else { return Ok(()) };
        let rows = self
            .db
            .prepare("SELECT * FROM remotes WHERE provider = 'github' AND external_id = ?")
            .bind(&[id.to_string().into()])?
            .all()
            .await?
            .results::<RemoteRow>()?;
        for row in rows {
            if let Err(error) = self.on_remote_push(&row, payload).await {
                worker::console_error!("mirrors: a push on {} was not followed: {error}", row.name);
            }
        }
        Ok(())
    }

    /// A push on a remote: a mirror standing by catches up; during a
    /// takeover nothing moves (the hand-back will see it); a follower takes
    /// in fast-forwards, or overwrites, as its settings say.
    async fn on_remote_push(&self, row: &RemoteRow, payload: &Value) -> Result<()> {
        if row.leads() {
            if row.state().mirror().is_some_and(MirrorState::follows)
                && let Err(reason) = self.sync(row).await?
            {
                worker::console_log!("mirrors: {} did not catch up with {}: {reason}", row.repo, row.name);
            }
            return Ok(());
        }
        let (Some(git_ref), Some(after)) = (payload["ref"].as_str(), payload["after"].as_str()) else {
            return Ok(());
        };
        let before = payload["before"].as_str().filter(|hash| !hash.chars().all(|c| c == '0'));
        let deleted = payload["deleted"].as_bool() == Some(true) || after.chars().all(|c| c == '0');
        let (username, token) = match self.credential(row).await? {
            Ok(credential) => credential,
            Err(reason) => return self.note(row, Some(&reason)).await,
        };
        let refs = match self.repos_refs(row, username.clone(), token.clone()).await? {
            Outcome::Ok(refs) => refs,
            Outcome::Fail(failure) => return self.note(row, Some(&failure.message)).await,
        };
        let ours = refs.ours.get(git_ref).map(String::as_str);
        // g1t's own push coming back: nothing to do.
        if ours == Some(after) || (deleted && ours.is_none()) {
            return Ok(());
        }
        if row.settings().remote_pushes == RemotePushes::Overwrite {
            let _ = self.sync(row).await?;
            return Ok(());
        }
        let forced = payload["forced"].as_bool() == Some(true);
        if !deleted && !forced && before == ours {
            let moves = vec![RefMove {
                direction: MirrorDirection::Pull,
                git_ref: git_ref.to_owned(),
                to: None,
                old: ours.map(str::to_owned),
                new: Some(after.to_owned()),
            }];
            if let Outcome::Ok(applied) = self.apply(row, username, token, moves).await?
                && applied.moved.iter().all(|moved| moved.problem.is_none())
            {
                return self.note(row, None).await;
            }
        }
        let branch = branch_of(git_ref).unwrap_or(git_ref);
        let reason = format!(
            "{branch} changed on {} in a way g1t cannot follow. Sync to push g1t's {branch} over it, or bring that change into g1t first.",
            row.name
        );
        self.note(row, Some(&reason)).await?;
        self.set_state(row, RemoteState::Stuck, None).await?;
        Ok(())
    }

    /// A push on g1t: each follower is sent it. A stuck follower waits for
    /// someone to sync it, so a change made on it is not pushed over.
    pub async fn on_event(&self, event: &g1t_contracts::events::Event) -> Result<()> {
        if event.kind != "git.push" {
            return Ok(());
        }
        let Some(repo_id) = event.repo_id.as_deref() else { return Ok(()) };
        for row in self.rows(repo_id).await? {
            if row.leads() || row.state() != RemoteState::Following {
                continue;
            }
            if let Err(reason) = self.sync(&row).await? {
                worker::console_log!("mirrors: {} not pushed to {}: {reason}", row.repo, row.name);
            }
        }
        Ok(())
    }

    /// Records one check of a host, and acts when it goes down or comes back.
    async fn host_checked(&self, host: &str, answered: bool, problem: Option<&str>) -> Result<()> {
        let now = now_ms();
        let row = self
            .db
            .prepare("SELECT * FROM remote_hosts WHERE host = ?")
            .bind(&[host.into()])?
            .first::<HostRow>(None)
            .await?
            .unwrap_or_else(|| HostRow { host: host.to_owned(), ..HostRow::default() });
        let (next, change) = row.health().checked(answered, now);
        self.db
            .prepare(
                "INSERT INTO remote_hosts (host, failures, successes, streak_ms, unreachable_since, checked_ms, last_problem)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (host) DO UPDATE SET failures = excluded.failures, successes = excluded.successes,
                   streak_ms = excluded.streak_ms, unreachable_since = excluded.unreachable_since,
                   checked_ms = excluded.checked_ms, last_problem = COALESCE(excluded.last_problem, remote_hosts.last_problem)",
            )
            .bind(&[
                host.into(),
                next.failures.into(),
                next.successes.into(),
                (next.streak_ms as f64).into(),
                null_or(next.unreachable_since.map(rfc3339).as_deref()),
                (now as f64).into(),
                null_or(problem),
            ])?
            .run()
            .await?;
        if change == Change::None {
            return Ok(());
        }
        let rows = self
            .db
            .prepare("SELECT * FROM remotes WHERE role = 'leader'")
            .all()
            .await?
            .results::<RemoteRow>()?;
        for row in rows.into_iter().filter(|row| row.host() == host) {
            let (kind, title) = match change {
                Change::WentDown => ("mirror.unreachable", format!("{} is not answering. {} keeps its copy.", row.name, row.repo)),
                _ => ("mirror.reachable", format!("{} answers again", row.name)),
            };
            let notify = self.told(&row, None).await;
            let detail = (change == Change::WentDown && row.state().mirror().is_some_and(MirrorState::follows))
                .then(|| format!("Take over {} to keep working on g1t until it is back.", row.repo));
            self.publish(kind, &row, None, title, detail, notify).await;
        }
        Ok(())
    }

    // --- Every minute -----------------------------------------------------------

    pub async fn on_minute(&self) -> Result<()> {
        let now = now_ms();
        // Mirrors the repos service has not heard of yet.
        let unrecorded = self
            .db
            .prepare("SELECT * FROM remotes WHERE recorded = 0 LIMIT 50")
            .all()
            .await?
            .results::<RemoteRow>()?;
        for row in &unrecorded {
            if row.leads() {
                self.record(row).await?;
            } else {
                self.db.prepare("UPDATE remotes SET recorded = 1 WHERE id = ?").bind(&[row.id.as_str().into()])?.run().await?;
            }
        }
        let leaders = self
            .db
            .prepare("SELECT * FROM remotes WHERE role = 'leader'")
            .all()
            .await?
            .results::<RemoteRow>()?;
        // One check per host a mirror follows.
        let mut by_host: BTreeMap<String, &RemoteRow> = BTreeMap::new();
        for row in &leaders {
            by_host.entry(row.host()).or_insert(row);
        }
        for (host, row) in &by_host {
            let answered = self.probe(row).await?;
            self.host_checked(host, answered.is_ok(), answered.err().as_deref()).await?;
        }
        let hosts = self.hosts().await?;
        for row in &leaders {
            let health = hosts.get(&row.host()).map(HostRow::health).unwrap_or_default();
            let settings = row.settings();
            match row.state() {
                // Taking over on its own, only when asked to.
                RemoteState::Standby | RemoteState::Ci => {
                    if let (Some(minutes), Some(since)) = (settings.take_over_after, health.unreachable_since)
                        && now.saturating_sub(since) >= u64::from(minutes) * 60_000
                    {
                        if let Outcome::Fail(failure) = self.start_takeover(row.clone(), By::G1t).await? {
                            worker::console_log!("mirrors: {} not taken over: {}", row.repo, failure.message);
                        }
                        continue;
                    }
                    // Hosts with no webhook are polled.
                    if row.provider() != RemoteProvider::Github && health.reachable() {
                        let polled = self
                            .db
                            .prepare("UPDATE remotes SET polled_ms = ?2 WHERE id = ?1 AND polled_ms < ?3 RETURNING id")
                            .bind(&[row.id.as_str().into(), (now as f64).into(), (now.saturating_sub(POLL_MS) as f64).into()])?
                            .first::<Value>(None)
                            .await?;
                        if polled.is_some() {
                            let _ = self.sync(row).await?;
                        }
                    }
                }
                // Handing back on its own once the remote is back and it is
                // clean, when asked to.
                RemoteState::Takeover if health.reachable() && settings.hand_back == HandBack::WhenClean && row.state_by.as_deref() == Some("g1t") => {
                    if let Outcome::Ok(plan) = self.plan(row).await?
                        && plan.clean()
                        && let Outcome::Fail(failure) = self.finish_takeover(row.clone(), By::G1t).await?
                    {
                        worker::console_log!("mirrors: {} not handed back: {}", row.repo, failure.message);
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Whether a remote's host answers `info/refs`: any answer but a server
    /// error counts, since a refused credential is the link's problem, not
    /// the host's.
    async fn probe(&self, row: &RemoteRow) -> Result<std::result::Result<(), String>> {
        let (username, token) = match self.credential(row).await? {
            Ok(credential) => credential,
            // No credential: ask without one; the host still answers.
            Err(_) => (None, String::new()),
        };
        let authorization = if token.is_empty() {
            String::new()
        } else {
            let user = username.unwrap_or_else(|| "x-access-token".to_owned());
            format!("Basic {}", base64(&format!("{user}:{token}")))
        };
        let url = format!("{}/info/refs?service=git-upload-pack", row.clone_url);
        let mut headers = vec![("accept", "*/*")];
        if !authorization.is_empty() {
            headers.push(("authorization", authorization.as_str()));
        }
        match http::send(Method::Get, &url, &headers, None).await {
            Ok(answer) if answer.status < 500 && answer.status != 429 && answer.status != 408 => Ok(Ok(())),
            Ok(answer) => Ok(Err(format!("{} answered {}.", row.host(), answer.status))),
            Err(_) => Ok(Err(format!("{} could not be reached.", row.host()))),
        }
    }
}

fn base64(text: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            out.push(if i <= chunk.len() { ALPHABET[(n >> shift) as usize & 63] as char } else { '=' });
        }
    }
    out
}

/// When the remote is away, the plan assumes it is where the takeover
/// started.
fn bases_as_theirs(bases: &BTreeMap<String, (Option<String>, Option<RefDecision>)>) -> BTreeMap<String, String> {
    bases.iter().filter_map(|(name, (base, _))| base.clone().map(|base| (name.clone(), base))).collect()
}

fn undecided(plan: &HandbackPlan) -> g1t_contracts::Failure {
    let waiting: Vec<&str> = plan
        .refs
        .iter()
        .filter(|item| item.action == RefAction::Diverged && item.decision.is_none())
        .map(|item| branch_of(&item.git_ref).unwrap_or(&item.git_ref))
        .collect();
    g1t_contracts::Failure {
        code: FailureCode::Conflict,
        message: format!(
            "Changed on both sides: {}. Decide for each whether to keep g1t's, keep the remote's, or send g1t's as a pull request.",
            waiting.join(", ")
        ),
    }
}

/// Answers the `mirror_*` methods; `None` for any other.
pub async fn route(method: &str, body: &Value, env: &Env, _ctx: &Context) -> Option<Result<Response>> {
    if !method.starts_with("mirror_") {
        return None;
    }
    Some(handle(method, body.clone(), env).await)
}

async fn handle(method: &str, body: Value, env: &Env) -> Result<Response> {
    let mirrors = Mirrors::new(env)?;
    match method {
        "mirror_view" => reply(&mirrors.view(args(body)?).await?),
        "mirror_briefs" => reply(&mirrors.briefs(args(body)?).await?),
        "mirror_take_over" => reply(&mirrors.take_over(args(body)?).await?),
        "mirror_ci" => reply(&mirrors.ci(args(body)?).await?),
        "mirror_hand_back_plan" => reply(&mirrors.hand_back_plan(args(body)?).await?),
        "mirror_hand_back" => reply(&mirrors.hand_back(args(body)?).await?),
        "mirror_move_in" => reply(&mirrors.move_in(args(body)?).await?),
        "mirror_sync" => reply(&mirrors.sync_now(args(body)?).await?),
        "mirror_settings" => reply(&mirrors.settings(args(body)?).await?),
        "mirror_add" => reply(&mirrors.add(args(body)?).await?),
        "mirror_remove" => reply(&mirrors.remove(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remotes_are_named_as_people_say_them() {
        assert_eq!(host_of("https://GitHub.com/acme/web.git"), "github.com");
        assert_eq!(host_of("https://user@git.acme.internal/x"), "git.acme.internal");
        assert_eq!(display_name("https://github.com/acme/web.git"), "github.com/acme/web");
        assert_eq!(display_name("https://g1t.sh/acme/web/"), "g1t.sh/acme/web");
        assert_eq!(clean_clone_url("https://g1t.sh/acme/web").as_deref(), Some("https://g1t.sh/acme/web.git"));
        assert_eq!(clean_clone_url("https://git.example/a.git/").as_deref(), Some("https://git.example/a.git"));
        assert_eq!(clean_clone_url("http://git.example/a"), None, "https only");
        assert_eq!(clean_clone_url("https://me:secret@git.example/a"), None, "no credentials in the address");
        assert_eq!(clean_clone_url("https://git.example"), None);
        assert_eq!(web_url("https://github.com/acme/web.git"), "https://github.com/acme/web");
    }

    #[test]
    fn a_host_goes_down_slowly_and_comes_back_slower() {
        let minute = 60_000;
        let mut health = HostHealth::default();
        let mut changes = Vec::new();
        for at in [0, minute, 2 * minute] {
            let (next, change) = health.checked(false, at);
            health = next;
            changes.push(change);
        }
        assert_eq!(changes, [Change::None, Change::None, Change::WentDown], "three failures over two minutes");
        assert!(!health.reachable());
        // One blip does not bring it back, nor do three quick answers.
        let (next, change) = health.checked(true, 3 * minute);
        assert_eq!(change, Change::None);
        let (next, _) = next.checked(true, 3 * minute + 1);
        let (next, change) = next.checked(true, 3 * minute + 2);
        assert_eq!(change, Change::None, "three answers in a moment are not five minutes");
        let (back, change) = next.checked(true, 8 * minute);
        assert_eq!(change, Change::CameBack);
        assert!(back.reachable());
        // A failure in between starts the count again.
        let (flaky, _) = HostHealth::default().checked(false, 0);
        let (flaky, _) = flaky.checked(true, minute);
        let (flaky, _) = flaky.checked(false, 2 * minute);
        let (_, change) = flaky.checked(false, 3 * minute);
        assert_eq!(change, Change::None);
    }

    fn refs(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(name, hash)| (name.to_string(), hash.to_string())).collect()
    }

    #[test]
    fn a_hand_back_plan_reads_each_ref_against_where_the_takeover_began() {
        let bases: BTreeMap<_, _> = [
            ("refs/heads/main", "a"),
            ("refs/heads/fix", "f"),
            ("refs/heads/docs", "d"),
            ("refs/heads/quiet", "q"),
        ]
        .into_iter()
        .map(|(name, base)| (name.to_owned(), (Some(base.to_owned()), None)))
        .collect();
        let ours = refs(&[
            ("refs/heads/main", "a2"),
            ("refs/heads/fix", "f2"),
            ("refs/heads/docs", "d2"),
            ("refs/heads/quiet", "q"),
            ("refs/heads/agent", "n"),
        ]);
        let theirs = refs(&[
            ("refs/heads/main", "a"),
            ("refs/heads/fix", "f"),
            ("refs/heads/docs", "d3"),
            ("refs/heads/quiet", "q"),
            ("refs/heads/g1t/handback/old", "x"),
        ]);
        let protected = BTreeSet::from(["refs/heads/main".to_owned()]);
        let plan = plan_refs(&bases, &ours, &theirs, &protected);
        let actions: Vec<(&str, RefAction)> = plan.iter().map(|item| (item.git_ref.as_str(), item.action)).collect();
        assert_eq!(actions, [
            ("refs/heads/agent", RefAction::Push),
            ("refs/heads/docs", RefAction::Diverged),
            ("refs/heads/fix", RefAction::Push),
            ("refs/heads/main", RefAction::PullRequest),
        ]);
        let plan = HandbackPlan::new(plan, true);
        assert!(!plan.ready, "docs needs a decision");

        let (moves, pull_requests) = hand_back_moves(&plan, &theirs);
        assert_eq!(pull_requests, ["refs/heads/main"]);
        let summary: Vec<(MirrorDirection, &str, Option<&str>)> =
            moves.iter().map(|m| (m.direction, m.git_ref.as_str(), m.to.as_deref())).collect();
        assert_eq!(summary, [
            (MirrorDirection::Push, "refs/heads/agent", None),
            (MirrorDirection::Push, "refs/heads/fix", None),
            (MirrorDirection::Push, "refs/heads/main", Some("refs/heads/g1t/handback/main")),
            (MirrorDirection::Pull, "refs/heads/main", None),
        ], "an undecided ref does not move");
        let main_back = &moves[3];
        assert_eq!((main_back.old.as_deref(), main_back.new.as_deref()), (Some("a2"), Some("a")), "g1t follows the remote's main");
        let push_fix = &moves[1];
        assert_eq!((push_fix.old.as_deref(), push_fix.new.as_deref()), (Some("f"), Some("f2")), "only from where the remote is");
    }

    #[test]
    fn decisions_settle_a_diverged_ref() {
        let plan = |decision| {
            HandbackPlan::new(
                vec![RefPlan {
                    git_ref: "refs/heads/docs".into(),
                    base: Some("d".into()),
                    ours: Some("d2".into()),
                    theirs: Some("d3".into()),
                    action: RefAction::Diverged,
                    decision: Some(decision),
                }],
                true,
            )
        };
        let theirs = refs(&[("refs/heads/g1t/handback/docs", "old")]);
        let (moves, _) = hand_back_moves(&plan(RefDecision::KeepOurs), &theirs);
        assert_eq!((moves[0].direction, moves[0].old.as_deref(), moves[0].new.as_deref()), (MirrorDirection::Push, Some("d3"), Some("d2")));
        let (moves, _) = hand_back_moves(&plan(RefDecision::KeepTheirs), &theirs);
        assert_eq!((moves[0].direction, moves[0].old.as_deref(), moves[0].new.as_deref()), (MirrorDirection::Pull, Some("d2"), Some("d3")));
        let (moves, pull_requests) = hand_back_moves(&plan(RefDecision::PullRequest), &theirs);
        assert_eq!(pull_requests, ["refs/heads/docs"]);
        assert_eq!(moves[0].old.as_deref(), Some("old"), "an old hand-back branch is moved from where it is");
        assert_eq!(moves.len(), 2);
    }
}
