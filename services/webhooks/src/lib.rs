//! The webhooks service: events, delivered to the addresses a repository or
//! a workspace registers. See `g1t_contracts::webhooks` for the methods and
//! their arguments.
//!
//! An event from the bus becomes a delivery for each active webhook that
//! wants it, and is sent at once. One that is not answered with a 2xx is
//! tried again by the minute's sweep, waiting longer each time, until it
//! has had every attempt. Every delivery is kept for a fortnight, with what
//! was sent and what came back.

mod deliver;
mod rename;

use std::time::Duration;

use futures_util::future::{Either, select};
use g1t_contracts::access::{self, Capability};
use g1t_contracts::events::Event;
use g1t_contracts::identity::{AGENT_ID, AGENT_NAME, UsernamesArgs};
use g1t_contracts::repos::{GetArgs, GetByIdArgs, Repo};
use g1t_contracts::time::rfc3339;
use g1t_contracts::webhooks::*;
use g1t_contracts::{FailureCode, Membership, Outcome, PrincipalKind, Role, User, Viewer, new_id};
use g1t_kit::{args, now_ms, reply, rpc_method};
use g1t_secrets::Sealer;
use serde::Deserialize;
use serde_json::Value;
use worker::wasm_bindgen::JsValue;
use worker::{
    Context, D1Database, Delay, Env, Fetch, Fetcher, Headers, MessageBatch, MessageExt, Method, Request, RequestInit, Response,
    Result, ScheduleContext, ScheduledEvent, event,
};

/// How long a receiver has to answer.
const TIMEOUT: Duration = Duration::from_secs(10);
/// How much of an answer is kept.
const RESPONSE_KEPT: usize = 2_000;
const DELIVERIES_SHOWN: u32 = 50;
/// How long deliveries are kept.
const KEPT_DAYS: u64 = 14;
/// How many due retries one sweep makes.
const SWEEP: u32 = 50;

#[derive(Deserialize)]
struct HookRow {
    id: String,
    scope: String,
    workspace: String,
    repo: Option<String>,
    url: String,
    events: String,
    active: u32,
    secret: String,
    secret_hint: String,
    created_by: String,
    created_at: String,
    last_status: Option<String>,
    last_delivered_at: Option<String>,
}

impl HookRow {
    fn events(&self) -> Vec<String> {
        serde_json::from_str(&self.events).unwrap_or_else(|_| vec!["*".to_owned()])
    }

    fn to_hook(&self) -> Hook {
        Hook {
            id: self.id.clone(),
            scope: if self.scope == "repo" { HookScope::Repo } else { HookScope::Workspace },
            workspace: self.workspace.clone(),
            repo: self.repo.clone(),
            url: self.url.clone(),
            events: self.events(),
            active: self.active != 0,
            secret_hint: self.secret_hint.clone(),
            created_by: self.created_by.clone(),
            created_at: self.created_at.clone(),
            last_status: self.last_status.clone(),
            last_delivered_at: self.last_delivered_at.clone(),
        }
    }
}

#[derive(Deserialize)]
struct DeliveryRow {
    id: String,
    hook_id: String,
    event_id: String,
    event: String,
    payload: String,
    status: String,
    attempts: u32,
    response_status: Option<u16>,
    response_body: Option<String>,
    error: Option<String>,
    duration_ms: Option<u32>,
    created_at: String,
    delivered_at: Option<String>,
    next_attempt_at: Option<String>,
}

impl From<DeliveryRow> for HookDelivery {
    fn from(row: DeliveryRow) -> Self {
        HookDelivery {
            id: row.id,
            hook_id: row.hook_id,
            event_id: row.event_id,
            event: row.event,
            status: row.status,
            attempts: row.attempts,
            response_status: row.response_status,
            response_body: row.response_body,
            error: row.error,
            duration_ms: row.duration_ms,
            payload: row.payload,
            created_at: row.created_at,
            delivered_at: row.delivered_at,
            next_attempt_at: row.next_attempt_at,
        }
    }
}

#[derive(Deserialize)]
struct NameRow {
    namespace: String,
    name: String,
}

/// What one attempt to send came to.
struct Attempt {
    status: Option<u16>,
    body: Option<String>,
    error: Option<String>,
    duration_ms: u32,
}

impl Attempt {
    fn delivered(&self) -> bool {
        self.status.is_some_and(|status| (200..300).contains(&status))
    }
}

fn optional(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::NULL, JsValue::from)
}

fn fail<T>(code: FailureCode, message: impl Into<String>) -> Outcome<T> {
    Outcome::fail(code, message)
}

/// The workspace itself, as the one asking: it can see its own
/// repositories, private ones too, and no one else's.
fn workspace_viewer(slug: &str) -> Viewer {
    Some(User {
        id: String::new(),
        username: slug.to_owned(),
        kind: PrincipalKind::Workspace,
        verified: true,
        workspaces: vec![Membership::member(slug.to_owned())],
        ..User::default()
    })
}

struct Webhooks {
    db: D1Database,
    sealer: Option<Sealer>,
    repos: Fetcher,
    identity: Fetcher,
}

impl Webhooks {
    fn new(env: &Env) -> Result<Self> {
        Ok(Webhooks {
            db: env.d1("DB")?,
            sealer: env.secret("WEBHOOKS_KEY").ok().and_then(|key| Sealer::new(&key.to_string())),
            repos: env.service("REPOS")?,
            identity: env.service("IDENTITY")?,
        })
    }

    // --- Who may do what --------------------------------------------------------

    /// The repository a repository's webhooks are for, if it is the
    /// workspace's and the viewer can see it.
    async fn repository(&self, owner: &HookOwner, viewer: &Viewer) -> Result<Option<Repo>> {
        let Some(path) = &owner.repo else {
            return Ok(None);
        };
        let found: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get",
            &GetArgs {
                path: path.clone(),
                viewer: viewer.clone(),
            },
        )
        .await?;
        Ok(found
            .into_result()
            .ok()
            .filter(|repo| repo.namespace == owner.workspace && repo.fork_of.is_none()))
    }

    /// Whether `viewer` may see (or, `managing`, change) `owner`'s webhooks,
    /// and the repository when they are a repository's. A repository's
    /// need the Admin role on it, to see as to change, since they carry
    /// its events out; the workspace's are its members' to see and its
    /// owners' to change. An agent's token changes neither.
    async fn allowed(&self, viewer: &Viewer, owner: &HookOwner, managing: bool) -> Result<Outcome<Option<Repo>>> {
        let Some(user) = viewer.as_ref() else {
            return Ok(fail(FailureCode::Forbidden, "Sign in to see webhooks."));
        };
        if managing && user.kind == PrincipalKind::Agent {
            return Ok(fail(FailureCode::Forbidden, "An agent cannot manage webhooks."));
        }
        if owner.repo.is_some() {
            let Some(repo) = self.repository(owner, viewer).await? else {
                return Ok(fail(FailureCode::NotFound, "There is no such repository in this workspace."));
            };
            if !access::can(viewer.as_ref(), &repo, Capability::ManageIntegrations) {
                return Ok(fail(
                    FailureCode::Forbidden,
                    access::needs(Capability::ManageIntegrations, &format!("{}/{}", repo.namespace, repo.name)),
                ));
            }
            return Ok(Outcome::Ok(Some(repo)));
        }
        if !user.is_member(&owner.workspace) {
            return Ok(fail(FailureCode::Forbidden, format!("Only members of {} can see its webhooks.", owner.workspace)));
        }
        if managing && user.role_in(&owner.workspace) != Some(Role::Owner) {
            return Ok(fail(FailureCode::Forbidden, "Only an owner can manage a workspace's own webhooks."));
        }
        Ok(Outcome::Ok(None))
    }

    fn owner(mut owner: HookOwner) -> HookOwner {
        owner.workspace = owner.workspace.to_lowercase();
        if let Some(repo) = &mut owner.repo {
            repo.namespace = repo.namespace.to_lowercase();
        }
        owner
    }

    /// The webhook, if it belongs to `owner`.
    async fn hook_of(&self, owner: &HookOwner, id: &str) -> Result<Option<HookRow>> {
        let row = self
            .db
            .prepare("SELECT * FROM hooks WHERE id = ? AND workspace = ?")
            .bind(&[id.into(), owner.workspace.as_str().into()])?
            .first::<HookRow>(None)
            .await?;
        let repo = owner.repo.as_ref().map(|path| format!("{}/{}", path.namespace, path.name));
        Ok(row.filter(|row| match &repo {
            Some(repo) => row.scope == "repo" && row.repo.as_deref().is_some_and(|r| r.eq_ignore_ascii_case(repo)),
            None => row.scope == "workspace",
        }))
    }

    // --- Managing webhooks ------------------------------------------------------

    async fn list(&self, a: ListArgs) -> Result<Outcome<Vec<Hook>>> {
        let owner = Self::owner(a.owner);
        if let Outcome::Fail(refused) = self.allowed(&a.viewer, &owner, false).await? {
            return Ok(Outcome::Fail(refused));
        }
        let rows = match &owner.repo {
            Some(path) => self
                .db
                .prepare("SELECT * FROM hooks WHERE scope = 'repo' AND workspace = ? AND lower(repo) = lower(?) ORDER BY id")
                .bind(&[owner.workspace.as_str().into(), format!("{}/{}", path.namespace, path.name).into()])?,
            None => self
                .db
                .prepare("SELECT * FROM hooks WHERE scope = 'workspace' AND workspace = ? ORDER BY id")
                .bind(&[owner.workspace.as_str().into()])?,
        }
        .all()
        .await?
        .results::<HookRow>()?;
        Ok(Outcome::Ok(rows.iter().map(HookRow::to_hook).collect()))
    }

    async fn create(&self, a: CreateArgs) -> Result<Outcome<CreatedHook>> {
        let owner = Self::owner(a.owner);
        let repo = match self.allowed(&Some(a.actor.clone()), &owner, true).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(refused) => return Ok(Outcome::Fail(refused)),
        };
        let Some(sealer) = &self.sealer else {
            return Ok(fail(FailureCode::Conflict, "Webhooks are not set up on this g1t: it has no key to keep secrets with."));
        };
        let url = a.url.trim().to_owned();
        if let Err(problem) = deliver::check_url(&url) {
            return Ok(fail(FailureCode::Invalid, problem));
        }
        let events = match deliver::tidy_events(&a.events) {
            Ok(events) => events,
            Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
        };
        let given = a.secret.map(|secret| secret.trim().to_owned()).filter(|secret| !secret.is_empty());
        let made = given.is_none();
        let secret = given.unwrap_or_else(|| format!("whsec_{}", g1t_secrets::random_hex(24)));
        let now = now_ms();
        let id = new_id("hk", now);
        self.db
            .prepare(
                "INSERT INTO hooks (id, scope, workspace, repo_id, repo, url, events, secret, secret_hint, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                if repo.is_some() { "repo" } else { "workspace" }.into(),
                owner.workspace.as_str().into(),
                optional(repo.as_ref().map(|repo| repo.id.as_str())),
                optional(repo.as_ref().map(|repo| format!("{}/{}", repo.namespace, repo.name)).as_deref()),
                url.as_str().into(),
                serde_json::to_string(&events)?.into(),
                sealer.seal(&secret, &id).into(),
                g1t_secrets::hint(&secret).into(),
                a.actor.username.as_str().into(),
                rfc3339(now).into(),
            ])?
            .run()
            .await?;
        let Some(row) = self.hook_of(&owner, &id).await? else {
            return Ok(fail(FailureCode::NotFound, "The webhook was not saved."));
        };
        // Tells the receiver it is wired up, and shows whether it answers.
        self.send_ping(&row).await?;
        let row = self.hook_of(&owner, &id).await?.unwrap_or(row);
        Ok(Outcome::Ok(CreatedHook {
            hook: row.to_hook(),
            secret: made.then_some(secret),
        }))
    }

    async fn update(&self, a: UpdateArgs) -> Result<Outcome<Hook>> {
        let owner = Self::owner(a.owner);
        if let Outcome::Fail(refused) = self.allowed(&Some(a.actor.clone()), &owner, true).await? {
            return Ok(Outcome::Fail(refused));
        }
        let Some(row) = self.hook_of(&owner, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such webhook."));
        };
        let url = a.url.map(|url| url.trim().to_owned()).unwrap_or(row.url.clone());
        if let Err(problem) = deliver::check_url(&url) {
            return Ok(fail(FailureCode::Invalid, problem));
        }
        let events = match a.events {
            Some(events) => match deliver::tidy_events(&events) {
                Ok(events) => events,
                Err(problem) => return Ok(fail(FailureCode::Invalid, problem)),
            },
            None => row.events(),
        };
        let active = a.active.unwrap_or(row.active != 0);
        self.db
            .prepare("UPDATE hooks SET url = ?, events = ?, active = ? WHERE id = ?")
            .bind(&[url.into(), serde_json::to_string(&events)?.into(), (active as u32).into(), row.id.as_str().into()])?
            .run()
            .await?;
        Ok(match self.hook_of(&owner, &row.id).await? {
            Some(row) => Outcome::Ok(row.to_hook()),
            None => fail(FailureCode::NotFound, "No such webhook."),
        })
    }

    async fn delete(&self, a: HookArgs) -> Result<Outcome<bool>> {
        let owner = Self::owner(a.owner);
        if let Outcome::Fail(refused) = self.allowed(&Some(a.actor.clone()), &owner, true).await? {
            return Ok(Outcome::Fail(refused));
        }
        let Some(row) = self.hook_of(&owner, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such webhook."));
        };
        self.db
            .batch(vec![
                self.db.prepare("DELETE FROM hooks WHERE id = ?").bind(&[row.id.as_str().into()])?,
                self.db.prepare("DELETE FROM deliveries WHERE hook_id = ?").bind(&[row.id.as_str().into()])?,
            ])
            .await?;
        Ok(Outcome::Ok(true))
    }

    async fn ping(&self, a: HookArgs) -> Result<Outcome<HookDelivery>> {
        let owner = Self::owner(a.owner);
        if let Outcome::Fail(refused) = self.allowed(&Some(a.actor.clone()), &owner, true).await? {
            return Ok(Outcome::Fail(refused));
        }
        let Some(row) = self.hook_of(&owner, &a.id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such webhook."));
        };
        let id = self.send_ping(&row).await?;
        Ok(self.delivery(&id).await?.map_or_else(|| fail(FailureCode::NotFound, "The ping was not recorded."), Outcome::Ok))
    }

    async fn deliveries(&self, a: DeliveriesArgs) -> Result<Outcome<Vec<HookDelivery>>> {
        let owner = Self::owner(a.owner);
        if let Outcome::Fail(refused) = self.allowed(&a.viewer, &owner, false).await? {
            return Ok(Outcome::Fail(refused));
        }
        if self.hook_of(&owner, &a.id).await?.is_none() {
            return Ok(fail(FailureCode::NotFound, "No such webhook."));
        }
        let rows = self
            .db
            .prepare("SELECT * FROM deliveries WHERE hook_id = ? ORDER BY id DESC LIMIT ?")
            .bind(&[a.id.as_str().into(), DELIVERIES_SHOWN.into()])?
            .all()
            .await?
            .results::<DeliveryRow>()?;
        Ok(Outcome::Ok(rows.into_iter().map(HookDelivery::from).collect()))
    }

    async fn redeliver(&self, a: RedeliverArgs) -> Result<Outcome<HookDelivery>> {
        let owner = Self::owner(a.owner);
        if let Outcome::Fail(refused) = self.allowed(&Some(a.actor.clone()), &owner, true).await? {
            return Ok(Outcome::Fail(refused));
        }
        let Some(original) = self.delivery(&a.delivery_id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such delivery."));
        };
        let Some(row) = self.hook_of(&owner, &original.hook_id).await? else {
            return Ok(fail(FailureCode::NotFound, "No such delivery."));
        };
        // A new delivery of the same payload: its own attempts and log.
        let id = self.enqueue(&row, "", &original.event, &original.payload).await?;
        if let Some(id) = &id {
            self.attempt(&row, id).await?;
        }
        Ok(match id {
            Some(id) => self.delivery(&id).await?.map_or_else(|| fail(FailureCode::NotFound, "No such delivery."), Outcome::Ok),
            None => fail(FailureCode::Conflict, "That delivery could not be made again."),
        })
    }

    async fn delivery(&self, id: &str) -> Result<Option<HookDelivery>> {
        Ok(self
            .db
            .prepare("SELECT * FROM deliveries WHERE id = ?")
            .bind(&[id.into()])?
            .first::<DeliveryRow>(None)
            .await?
            .map(HookDelivery::from))
    }

    // --- Delivering -------------------------------------------------------------

    /// Records a delivery to make. `None` when this event was already
    /// delivered to this webhook.
    async fn enqueue(&self, hook: &HookRow, event_id: &str, event: &str, payload: &str) -> Result<Option<String>> {
        let now = now_ms();
        let id = new_id("dlv", now);
        let inserted = self
            .db
            .prepare(
                "INSERT OR IGNORE INTO deliveries (id, hook_id, event_id, event, payload, status, created_at, next_attempt_at)
                 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING id",
            )
            .bind(&[
                id.as_str().into(),
                hook.id.as_str().into(),
                event_id.into(),
                event.into(),
                payload.into(),
                rfc3339(now).into(),
                rfc3339(now).into(),
            ])?
            .first::<Value>(None)
            .await?;
        Ok(inserted.map(|_| id))
    }

    async fn send_ping(&self, hook: &HookRow) -> Result<String> {
        let body = deliver::ping(&hook.id, &hook.url, &hook.events(), &rfc3339(now_ms())).to_string();
        let id = self.enqueue(hook, "", "ping", &body).await?.unwrap_or_default();
        self.attempt(hook, &id).await?;
        Ok(id)
    }

    /// Sends one delivery once, and records how it went.
    async fn attempt(&self, hook: &HookRow, delivery_id: &str) -> Result<()> {
        let Some(delivery) = self.delivery(delivery_id).await? else {
            return Ok(());
        };
        let Some(secret) = self.sealer.as_ref().and_then(|sealer| sealer.open(&hook.secret, &hook.id)) else {
            return Ok(());
        };
        let attempt = send(&hook.url, &hook.id, &delivery, &secret).await;
        let attempts = delivery.attempts + 1;
        let now = now_ms();
        let (status, next) = if attempt.delivered() {
            ("delivered", None)
        } else {
            match deliver::retry_after(attempts) {
                Some(wait) => ("pending", Some(rfc3339(now + wait * 1000))),
                None => ("failed", None),
            }
        };
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "UPDATE deliveries SET status = ?, attempts = ?, response_status = ?, response_body = ?, error = ?,
                           duration_ms = ?, delivered_at = ?, next_attempt_at = ? WHERE id = ?",
                    )
                    .bind(&[
                        status.into(),
                        attempts.into(),
                        attempt.status.map_or(JsValue::NULL, |status| status.into()),
                        optional(attempt.body.as_deref()),
                        optional(attempt.error.as_deref()),
                        attempt.duration_ms.into(),
                        optional(attempt.delivered().then(|| rfc3339(now)).as_deref()),
                        optional(next.as_deref()),
                        delivery_id.into(),
                    ])?,
                self.db
                    .prepare("UPDATE hooks SET last_status = ?, last_delivered_at = ? WHERE id = ?")
                    .bind(&[status.into(), rfc3339(now).into(), hook.id.as_str().into()])?,
            ])
            .await?;
        Ok(())
    }

    /// Which workspace a repository is in, and its name.
    async fn repo_name(&self, repo_id: &str, workspaces: &[String]) -> Result<Option<NameRow>> {
        if let Some(known) = self
            .db
            .prepare("SELECT namespace, name FROM repo_names WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<NameRow>(None)
            .await?
        {
            return Ok(Some(known));
        }
        // Asked as each workspace with webhooks in turn: each sees only its
        // own private repositories.
        for workspace in workspaces {
            let found: Outcome<Repo> = g1t_kit::call(
                &self.repos,
                "get_by_id",
                &GetByIdArgs {
                    id: repo_id.to_owned(),
                    viewer: workspace_viewer(workspace),
                },
            )
            .await?;
            if let Outcome::Ok(repo) = found
                && repo.fork_of.is_none()
            {
                self.remember(repo_id, &repo.namespace, &repo.name).await?;
                return Ok(Some(NameRow {
                    namespace: repo.namespace,
                    name: repo.name,
                }));
            }
        }
        Ok(None)
    }

    async fn remember(&self, repo_id: &str, namespace: &str, name: &str) -> Result<()> {
        self.db
            .prepare("INSERT OR REPLACE INTO repo_names (repo_id, namespace, name) VALUES (?, ?, ?)")
            .bind(&[repo_id.into(), namespace.into(), name.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// An event from the bus, delivered to every webhook that wants it.
    async fn on_event(&self, event: &Event) -> Result<()> {
        if event.kind == "repo.created"
            && let (Some(id), Some(namespace), Some(name)) =
                (event.data["repoId"].as_str(), event.data["namespace"].as_str(), event.data["name"].as_str())
        {
            self.remember(id, namespace, name).await?;
        }
        let Some(repo_id) = event.repo_id.as_deref().or_else(|| event.data["repoId"].as_str()) else {
            return Ok(());
        };
        let mut hooks = self
            .db
            .prepare("SELECT * FROM hooks WHERE active = 1 AND scope = 'repo' AND repo_id = ?")
            .bind(&[repo_id.into()])?
            .all()
            .await?
            .results::<HookRow>()?;
        let workspaces: Vec<String> = self
            .db
            .prepare("SELECT DISTINCT workspace FROM hooks WHERE active = 1 AND scope = 'workspace'")
            .all()
            .await?
            .results::<Value>()?
            .into_iter()
            .filter_map(|row| row["workspace"].as_str().map(str::to_owned))
            .collect();
        let name = if hooks.is_empty() && workspaces.is_empty() {
            None
        } else {
            // A deleted repository looks missing to repos; its own events
            // name it.
            self.repo_name(repo_id, &workspaces)
                .await?
                .or_else(|| deliver::named_in(event).map(|(namespace, name)| NameRow { namespace, name }))
        };
        if let Some(name) = &name {
            hooks.extend(
                self.db
                    .prepare("SELECT * FROM hooks WHERE active = 1 AND scope = 'workspace' AND workspace = ?")
                    .bind(&[name.namespace.as_str().into()])?
                    .all()
                    .await?
                    .results::<HookRow>()?,
            );
        }
        let wanted: Vec<&HookRow> = hooks.iter().filter(|hook| deliver::wants(&hook.events(), &event.kind)).collect();
        if wanted.is_empty() {
            return Ok(());
        }
        // Who caused it, by name: people and workspaces, or g1t's agent.
        let actor_name = match &event.actor {
            Some(id) => {
                let names: std::collections::HashMap<String, String> =
                    g1t_kit::call(&self.identity, "usernames", &UsernamesArgs { ids: vec![id.clone()] }).await?;
                names.get(id).cloned().or_else(|| (id == AGENT_ID).then(|| AGENT_NAME.to_owned()))
            }
            None => None,
        };
        for hook in wanted {
            let full_name = hook
                .repo
                .clone()
                .or_else(|| name.as_ref().map(|name| format!("{}/{}", name.namespace, name.name)))
                .unwrap_or_default();
            let payload = deliver::payload(event, &hook.workspace, Some((repo_id, &full_name)), actor_name.as_deref()).to_string();
            if let Some(id) = self.enqueue(hook, &event.id, &event.kind, &payload).await? {
                self.attempt(hook, &id).await?;
            }
        }
        Ok(())
    }

    /// Tries again what is due, and forgets what is old.
    async fn sweep(&self) -> Result<()> {
        let now = now_ms();
        let due = self
            .db
            .prepare("SELECT * FROM deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?")
            .bind(&[rfc3339(now).into(), SWEEP.into()])?
            .all()
            .await?
            .results::<DeliveryRow>()?;
        for delivery in due {
            let hook = self
                .db
                .prepare("SELECT * FROM hooks WHERE id = ?")
                .bind(&[delivery.hook_id.as_str().into()])?
                .first::<HookRow>(None)
                .await?;
            match hook {
                Some(hook) if hook.active != 0 => self.attempt(&hook, &delivery.id).await?,
                // A webhook turned off or removed takes its retries with it.
                _ => {
                    self.db
                        .prepare("UPDATE deliveries SET status = 'failed', next_attempt_at = NULL WHERE id = ?")
                        .bind(&[delivery.id.as_str().into()])?
                        .run()
                        .await?;
                }
            }
        }
        self.db
            .prepare("DELETE FROM deliveries WHERE created_at < ?")
            .bind(&[rfc3339(now.saturating_sub(KEPT_DAYS * 24 * 60 * 60 * 1000)).into()])?
            .run()
            .await?;
        Ok(())
    }
}

/// One HTTPS POST of a delivery's payload, signed, given ten seconds.
async fn send(url: &str, hook_id: &str, delivery: &HookDelivery, secret: &str) -> Attempt {
    let started = now_ms();
    let elapsed = || (now_ms() - started) as u32;
    let request = (|| -> Result<Request> {
        let headers = Headers::new();
        headers.set("content-type", "application/json")?;
        headers.set("user-agent", "g1t-webhooks/1 (+https://docs.g1t.sh/guides/webhooks/)")?;
        headers.set("x-g1t-event", &delivery.event)?;
        headers.set("x-g1t-delivery", &delivery.id)?;
        headers.set("x-g1t-hook", hook_id)?;
        headers.set("x-g1t-signature-256", &deliver::signature(secret, &delivery.payload))?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post).with_headers(headers).with_body(Some(delivery.payload.clone().into()));
        Request::new_with_init(url, &init)
    })();
    let request = match request {
        Ok(request) => request,
        Err(error) => {
            return Attempt {
                status: None,
                body: None,
                error: Some(format!("The request could not be made: {error}")),
                duration_ms: 0,
            };
        }
    };
    let fetcher = Fetch::Request(request);
    let fetch = Box::pin(fetcher.send());
    let timeout = Box::pin(Delay::from(TIMEOUT));
    match select(fetch, timeout).await {
        Either::Left((Ok(mut response), _)) => {
            let status = response.status_code();
            let body: String = response.text().await.unwrap_or_default().chars().take(RESPONSE_KEPT).collect();
            Attempt {
                status: Some(status),
                body: Some(body),
                error: None,
                duration_ms: elapsed(),
            }
        }
        Either::Left((Err(error), _)) => Attempt {
            status: None,
            body: None,
            error: Some(format!("The receiver could not be reached: {error}")),
            duration_ms: elapsed(),
        },
        Either::Right(_) => Attempt {
            status: None,
            body: None,
            error: Some(format!("The receiver did not answer within {} seconds.", TIMEOUT.as_secs())),
            duration_ms: elapsed(),
        },
    }
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    let body: Value = request.json().await?;
    let service = Webhooks::new(&env)?;
    match method.as_str() {
        "list" => reply(&service.list(args(body)?).await?),
        "create" => reply(&service.create(args(body)?).await?),
        "update" => reply(&service.update(args(body)?).await?),
        "delete" => reply(&service.delete(args(body)?).await?),
        "ping" => reply(&service.ping(args(body)?).await?),
        "deliveries" => reply(&service.deliveries(args(body)?).await?),
        "redeliver" => reply(&service.redeliver(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}

/// Events from the bus, on this service's own queue.
#[event(queue)]
async fn queue(batch: MessageBatch<Event>, env: Env, _ctx: Context) -> Result<()> {
    let service = Webhooks::new(&env)?;
    for message in batch.messages()? {
        // A workspace renamed: its rows move to the slug it has now.
        if g1t_kit::rename::on_event(&env, &env.d1("DB")?, message.body(), rename::STATEMENTS).await? {
            message.ack();
            continue;
        }
        // A repository renamed or transferred: its rows follow its new path,
        // and then the event is delivered like any other, naming it there.
        if g1t_kit::transfer::on_event(&env, &env.d1("DB")?, message.body(), rename::TRANSFERRED).await? {
            service.on_event(message.body()).await?;
            message.ack();
            continue;
        }
        // A repository purged: its last event is delivered, then its own
        // webhooks go.
        if message.body().kind == "repo.purged" {
            service.on_event(message.body()).await?;
            g1t_kit::lifecycle::on_purged(&env.d1("DB")?, message.body(), rename::PURGED).await?;
            message.ack();
            continue;
        }
        // A workspace deleted: what it kept for itself goes.
        if g1t_kit::deleted::on_event(&env.d1("DB")?, message.body(), rename::DELETED).await? {
            message.ack();
            continue;
        }
        service.on_event(message.body()).await?;
        message.ack();
    }
    Ok(())
}

/// Every minute: retries that are due, and deliveries old enough to forget.
#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    match Webhooks::new(&env) {
        Ok(service) => {
            if let Err(error) = service.sweep().await {
                worker::console_error!("webhooks: the sweep failed: {error}");
            }
        }
        Err(error) => worker::console_error!("webhooks: could not start: {error}"),
    }
}

