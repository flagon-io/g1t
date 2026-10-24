//! Plumbing shared by g1t services that run on Workers.
//!
//! Services talk to each other over service bindings with a small JSON
//! protocol: `POST /rpc/<method>` with the method's arguments as the body,
//! answered with the method's return value.

use serde::Serialize;
use serde::de::DeserializeOwned;
use worker::{Date, Fetcher, Headers, Method, Request, RequestInit, Response, Result};

/// The current time in milliseconds since the epoch.
pub fn now_ms() -> u64 {
    Date::now().as_millis()
}

/// The method name of an RPC request, or `None` if it is not one.
pub fn rpc_method(request: &Request) -> Option<String> {
    if request.method() != Method::Post {
        return None;
    }
    request.path().strip_prefix("/rpc/").map(|method| method.to_owned())
}

/// Deserializes a method's arguments.
pub fn args<A: DeserializeOwned>(body: serde_json::Value) -> Result<A> {
    serde_json::from_value(body).map_err(|error| worker::Error::RustError(format!("bad arguments: {error}")))
}

/// Serializes a method's return value as the response body.
pub fn reply<R: Serialize>(value: &R) -> Result<Response> {
    Response::from_json(value)
}

/// Calls `method` on another service through its binding.
pub async fn call<A: Serialize, R: DeserializeOwned>(service: &Fetcher, method: &str, arguments: &A) -> Result<R> {
    call_in(service, method, arguments, None).await
}

/// Calls `method` like [`call`], in the D1 session `session` asks for (a
/// constraint or a bookmark, as [`d1::constraint`] reads them); `None`
/// reads the service's primary, as [`call`] does. For reads made on a
/// caller's behalf, in the session it asked for them ([`d1::forwarded`]).
pub async fn call_in<A: Serialize, R: DeserializeOwned>(
    service: &Fetcher,
    method: &str,
    arguments: &A,
    session: Option<&str>,
) -> Result<R> {
    let headers = Headers::new();
    headers.set("content-type", "application/json")?;
    if let Some(session) = session {
        headers.set(d1::BOOKMARK, session)?;
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Post).with_headers(headers).with_body(Some(serde_json::to_string(arguments)?.into()));
    // The hostname is ignored; a service binding always reaches its service.
    let request = Request::new_with_init(&format!("https://service/rpc/{method}"), &init)?;
    let mut response = service.fetch_request(request).await?;
    if response.status_code() != 200 {
        return Err(worker::Error::RustError(format!(
            "{method} failed with status {}: {}",
            response.status_code(),
            response.text().await.unwrap_or_default()
        )));
    }
    // Say which call's answer did not read, and why: a bare serde error
    // ("JSON serialization error") is all a log would otherwise show. The
    // body is left out, as it may carry a signed link.
    let text = response.text().await?;
    read_answer(method, &text)
}

/// Calls `method` like [`call`], waiting at most `within` for the answer:
/// `None` when none came in time. Nothing on Workers ends a subrequest that
/// stops answering, so a caller that must answer someone (a click on Merge)
/// bounds the calls it makes this way and says what happened instead of
/// hanging until its own caller gives up. The call is not cancelled: what
/// it was doing may still finish, so only a call that is safe to make
/// again (or whose late result is harmless) should be bounded.
pub async fn call_within<A: Serialize, R: DeserializeOwned>(
    service: &Fetcher,
    method: &str,
    arguments: &A,
    within: std::time::Duration,
) -> Result<Option<R>> {
    match first_of(call(service, method, arguments), worker::Delay::from(within)).await {
        Some(answer) => answer.map(Some),
        None => {
            worker::console_error!("{method} did not answer within {} s", within.as_secs());
            Ok(None)
        }
    }
}

/// `work`'s output if it finishes before `deadline` does, `None` otherwise.
pub async fn first_of<W: std::future::Future, D: std::future::Future>(work: W, deadline: D) -> Option<W::Output> {
    use std::task::Poll;
    let mut work = Box::pin(work);
    let mut deadline = Box::pin(deadline);
    std::future::poll_fn(|cx| {
        if let Poll::Ready(output) = work.as_mut().poll(cx) {
            return Poll::Ready(Some(output));
        }
        if deadline.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        Poll::Pending
    })
    .await
}

#[cfg(test)]
mod deadline_tests {
    use super::first_of;
    use std::future::{pending, ready};
    use std::task::{Context, Poll, Waker};

    fn now<F: std::future::Future>(future: F) -> Poll<F::Output> {
        let mut future = Box::pin(future);
        future.as_mut().poll(&mut Context::from_waker(Waker::noop()))
    }

    #[test]
    fn an_answer_in_time_is_passed_through_and_a_late_one_is_not_waited_for() {
        assert_eq!(now(first_of(ready(7), pending::<()>())), Poll::Ready(Some(7)));
        assert_eq!(now(first_of(pending::<u8>(), ready(()))), Poll::Ready(None));
        // Both ready: the answer wins.
        assert_eq!(now(first_of(ready(1), ready(()))), Poll::Ready(Some(1)));
        assert_eq!(now(first_of(pending::<u8>(), pending::<()>())), Poll::Pending);
    }
}

/// A method's answer, read from its body.
pub fn read_answer<R: DeserializeOwned>(method: &str, text: &str) -> Result<R> {
    serde_json::from_str(text).map_err(|error| worker::Error::RustError(format!("{method} answered with what could not be read: {error}")))
}

pub mod d1;
pub mod limits;
pub mod pause;
pub mod wire;

/// Helpers for bindings that workers-rs has no typed wrapper for, such as
/// Artifacts and Email Sending. Values cross the boundary as JSON.
pub mod js {
    use std::fmt;

    use serde::Serialize;
    use serde::de::DeserializeOwned;
    use worker::js_sys::{Array, Function, JSON, Promise, Reflect};
    use worker::wasm_bindgen::{JsCast, JsValue};
    use worker::wasm_bindgen_futures::JsFuture;
    use worker::{Env, Error, Result};

    /// An exception thrown by JavaScript, with its `code` if it had one.
    #[derive(Debug)]
    pub struct Thrown {
        pub code: Option<String>,
        pub message: String,
    }

    impl Thrown {
        fn from_value(value: JsValue) -> Self {
            let property = |name: &str| Reflect::get(&value, &name.into()).ok().and_then(|property| property.as_string());
            Thrown { code: property("code"), message: property("message").unwrap_or_else(|| format!("{value:?}")) }
        }

        pub fn is(&self, code: &str) -> bool {
            self.code.as_deref() == Some(code)
        }
    }

    impl fmt::Display for Thrown {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match &self.code {
                Some(code) => write!(f, "{code}: {}", self.message),
                None => f.write_str(&self.message),
            }
        }
    }

    impl From<Thrown> for Error {
        fn from(thrown: Thrown) -> Self {
            Error::RustError(thrown.to_string())
        }
    }

    /// The binding called `name`, as a raw JavaScript value.
    pub fn binding(env: &Env, name: &str) -> Result<JsValue> {
        let value = Reflect::get(env.as_ref(), &name.into()).map_err(Thrown::from_value)?;
        if value.is_undefined() {
            return Err(Error::RustError(format!("binding {name} is not configured")));
        }
        Ok(value)
    }

    /// Reads a property of a JavaScript object.
    pub fn get(target: &JsValue, name: &str) -> JsValue {
        Reflect::get(target, &name.into()).unwrap_or(JsValue::UNDEFINED)
    }

    /// Sets a property on an object.
    pub fn set(target: &JsValue, name: &str, value: &JsValue) {
        let _ = Reflect::set(target, &name.into(), value);
    }

    pub fn to_js<T: Serialize>(value: &T) -> Result<JsValue> {
        Ok(JSON::parse(&serde_json::to_string(value)?).map_err(Thrown::from_value)?)
    }

    pub fn from_js<T: DeserializeOwned>(value: &JsValue) -> Result<T> {
        let text = if value.is_undefined() { None } else { JSON::stringify(value).map_err(Thrown::from_value)?.as_string() };
        let text = text.as_deref().unwrap_or("null");
        serde_json::from_str(text).map_err(|error| {
            // Say what arrived; a bare serde error is useless in a log.
            let seen: String = text.chars().take(300).collect();
            Error::RustError(format!("unexpected value from JavaScript ({error}): {seen}"))
        })
    }

    /// Calls `target[method](...args)` and awaits the result if it is a
    /// thenable. `method` may be a name or a symbol.
    pub async fn call_key(target: &JsValue, method: &JsValue, args: &[JsValue]) -> std::result::Result<JsValue, Thrown> {
        let function: Function = Reflect::get(target, method)
            .map_err(Thrown::from_value)?
            .dyn_into()
            .map_err(|_| Thrown { code: None, message: format!("{method:?} is not a function") })?;
        let arguments: Array = args.iter().collect();
        // An RPC stub treats every property access as a remote method, so
        // `function.apply(...)` would be sent over the wire as a call to
        // "apply". Reflect.apply invokes the function without touching it.
        let returned = Reflect::apply(&function, target, &arguments).map_err(Thrown::from_value)?;
        // Worker RPC returns its own thenable rather than a Promise, so
        // resolve whatever came back instead of testing its type.
        JsFuture::from(Promise::resolve(&returned)).await.map_err(Thrown::from_value)
    }

    /// Calls `target.method(...args)`; see [`call_key`].
    pub async fn call(target: &JsValue, method: &str, args: &[JsValue]) -> std::result::Result<JsValue, Thrown> {
        call_key(target, &method.into(), args).await
    }
}

/// Moving a service's rows when a workspace is renamed.
pub mod rename {
    use std::collections::HashMap;

    use g1t_contracts::events::{Event, WorkspaceRenamed};
    use g1t_contracts::identity::UsernamesArgs;
    use worker::wasm_bindgen::JsValue;
    use worker::{D1Database, Env, Result};

    /// Handles `workspace.renamed` with `statements`, and says whether
    /// `event` was one. Each statement uses `?1` for the workspace's current
    /// slug (asked of identity by id, so renames delivered twice or out of
    /// order converge) and `?2` for a slug its rows may still be under; the
    /// statements run in one batch per such slug. A statement that matches
    /// nothing changes nothing, so running them again is harmless.
    pub async fn on_event(env: &Env, db: &D1Database, event: &Event, statements: &[&str]) -> Result<bool> {
        if event.kind != "workspace.renamed" {
            return Ok(false);
        }
        let Ok(renamed) = serde_json::from_value::<WorkspaceRenamed>(event.data.clone()) else {
            worker::console_error!("workspace.renamed {} could not be read", event.id);
            return Ok(true);
        };
        let names: HashMap<String, String> =
            crate::call(&env.service("IDENTITY")?, "usernames", &UsernamesArgs { ids: vec![renamed.workspace_id.clone()] }).await?;
        let current = names.get(&renamed.workspace_id).cloned().unwrap_or_else(|| renamed.to.clone());
        for stale in renamed.stale_slugs(&current) {
            let values: [JsValue; 2] = [current.as_str().into(), stale.as_str().into()];
            let mut batch = Vec::with_capacity(statements.len());
            for sql in statements {
                batch.push(db.prepare(*sql).bind(&values[..parameters(sql)])?);
            }
            db.batch(batch).await?;
        }
        Ok(true)
    }

    /// How many values a statement takes: its highest `?N`.
    pub fn parameters(sql: &str) -> usize {
        sql.split('?')
            .skip(1)
            .filter_map(|rest| {
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                digits.parse().ok()
            })
            .max()
            .unwrap_or(0)
    }

    #[cfg(test)]
    mod tests {
        use super::parameters;

        #[test]
        fn counts_numbered_parameters() {
            assert_eq!(parameters("UPDATE t SET a = ?1 WHERE a = ?2"), 2);
            assert_eq!(parameters("DELETE FROM t WHERE a = ?2"), 2);
            assert_eq!(parameters("UPDATE t SET a = ?1"), 1);
            assert_eq!(parameters("DELETE FROM t"), 0);
        }
    }
}

/// Moving a service's rows when a repository's path changes: transferred
/// to another workspace (`repo.transferred`) or renamed within its own
/// (`repo.renamed`). Both are handled the same way, so a service that
/// follows transfers follows renames too.
pub mod transfer {
    use g1t_contracts::events::{Event, RepoRenamed, RepoTransferred};
    use g1t_contracts::repos::{PathByIdArgs, RepoPath};
    use worker::wasm_bindgen::JsValue;
    use worker::{D1Database, Env, Result};

    pub use crate::rename::parameters;

    /// A repository's path change, from either event.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Moved {
        pub repo_id: String,
        /// The paths (`namespace/name`) the event names, old then new.
        pub paths: [String; 2],
    }

    impl Moved {
        /// The paths whose rows move to `current`: the two the event
        /// names, minus `current`.
        pub fn stale_paths(&self, current: &str) -> Vec<String> {
            let mut paths: Vec<String> = Vec::new();
            for path in &self.paths {
                if path != current && !paths.contains(path) {
                    paths.push(path.clone());
                }
            }
            paths
        }

        /// Where the event says it went, for when repos does not know.
        pub fn destination(&self) -> &str {
            &self.paths[1]
        }
    }

    impl From<RepoTransferred> for Moved {
        fn from(t: RepoTransferred) -> Self {
            Moved { paths: [format!("{}/{}", t.from, t.name), format!("{}/{}", t.to, t.name)], repo_id: t.repo_id }
        }
    }

    impl From<RepoRenamed> for Moved {
        fn from(r: RepoRenamed) -> Self {
            Moved { paths: [format!("{}/{}", r.namespace, r.from), format!("{}/{}", r.namespace, r.to)], repo_id: r.repo_id }
        }
    }

    /// The values the statements are bound with for one stale path, in
    /// order: `?1` the current path (`namespace/name`), `?2` the stale
    /// path, `?3` the current workspace, `?4` the stale workspace, `?5` the
    /// repository's id, `?6` the current name, `?7` the stale name.
    pub fn values(current: &str, stale: &str, repo_id: &str) -> [String; 7] {
        let namespace = |path: &str| path.split_once('/').map_or(path, |(ns, _)| ns).to_owned();
        let name = |path: &str| path.split_once('/').map_or("", |(_, name)| name).to_owned();
        [current.to_owned(), stale.to_owned(), namespace(current), namespace(stale), repo_id.to_owned(), name(current), name(stale)]
    }

    /// Handles `repo.transferred` and `repo.renamed` with `statements`, and
    /// says whether `event` was one. The repository's current path is asked
    /// of repos by id, so path changes delivered twice or out of order
    /// converge; the statements run in one batch per path its rows may
    /// still be under (see [`values`] for the parameters). A statement that
    /// matches nothing changes nothing, so running them again is harmless.
    pub async fn on_event(env: &Env, db: &D1Database, event: &Event, statements: &[&str]) -> Result<bool> {
        let Some(moved) = read(event) else {
            return Ok(false);
        };
        let current = current_path(env, &moved).await?;
        for stale in moved.stale_paths(&current) {
            let values = values(&current, &stale, &moved.repo_id);
            let values: Vec<JsValue> = values.iter().map(|v| JsValue::from(v.as_str())).collect();
            let mut batch = Vec::with_capacity(statements.len());
            for sql in statements {
                batch.push(db.prepare(*sql).bind(&values[..parameters(sql)])?);
            }
            db.batch(batch).await?;
        }
        Ok(true)
    }

    /// The path change `event` announces, if it is one.
    pub fn read(event: &Event) -> Option<Moved> {
        let read = match event.kind.as_str() {
            "repo.transferred" => serde_json::from_value::<RepoTransferred>(event.data.clone()).map(Moved::from),
            "repo.renamed" => serde_json::from_value::<RepoRenamed>(event.data.clone()).map(Moved::from),
            _ => return None,
        };
        if read.is_err() {
            worker::console_error!("{} {} could not be read", event.kind, event.id);
        }
        read.ok()
    }

    /// The repository's path now, as `namespace/name`: asked of repos, or
    /// where the event says it went when repos does not know it.
    pub async fn current_path(env: &Env, moved: &Moved) -> Result<String> {
        let path: Option<RepoPath> = crate::call(&env.service("REPOS")?, "path_by_id", &PathByIdArgs { id: moved.repo_id.clone() }).await?;
        Ok(path.map_or_else(|| moved.destination().to_owned(), |path| format!("{}/{}", path.namespace, path.name)))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn binds_paths_workspaces_names_and_the_id() {
            assert_eq!(
                values("flagon-io/g1t", "syntaqx/g1t", "rep_1"),
                ["flagon-io/g1t", "syntaqx/g1t", "flagon-io", "syntaqx", "rep_1", "g1t", "g1t"].map(String::from)
            );
            assert_eq!(values("acme/new", "acme/old", "rep_1")[5..], ["new".to_owned(), "old".to_owned()]);
        }

        #[test]
        fn a_rename_and_a_transfer_are_both_moves() {
            let renamed: Moved =
                RepoRenamed { repo_id: "rep_1".into(), namespace: "acme".into(), from: "old".into(), to: "new".into() }.into();
            assert_eq!(renamed.stale_paths("acme/new"), vec!["acme/old"]);
            assert_eq!(renamed.destination(), "acme/new");
            let transferred: Moved =
                RepoTransferred { repo_id: "rep_1".into(), name: "g1t".into(), from: "a".into(), to: "b".into() }.into();
            assert_eq!(transferred.stale_paths("c/g1t"), vec!["a/g1t", "b/g1t"]);
        }
    }
}

/// Reading the repository lifecycle events every service reacts to:
/// `repo.deleted` (stop and hide; it may come back), `repo.restored`
/// (start again) and `repo.purged` (drop every row kept by its id).
pub mod lifecycle {
    use g1t_contracts::events::{Event, RepoDeleted, RepoPurged, RepoRestored};
    use worker::{D1Database, Result};

    /// One of the three, read.
    #[derive(Debug)]
    pub enum Lifecycle {
        Deleted(RepoDeleted),
        Restored(RepoRestored),
        Purged(RepoPurged),
    }

    impl Lifecycle {
        pub fn repo_id(&self) -> &str {
            match self {
                Lifecycle::Deleted(e) => &e.repo_id,
                Lifecycle::Restored(e) => &e.repo_id,
                Lifecycle::Purged(e) => &e.repo_id,
            }
        }
    }

    /// The lifecycle event `event` is, if it is one.
    pub fn read(event: &Event) -> Option<Lifecycle> {
        let data = event.data.clone();
        let read = match event.kind.as_str() {
            "repo.deleted" => serde_json::from_value(data).map(Lifecycle::Deleted),
            "repo.restored" => serde_json::from_value(data).map(Lifecycle::Restored),
            "repo.purged" => serde_json::from_value(data).map(Lifecycle::Purged),
            _ => return None,
        };
        if read.is_err() {
            worker::console_error!("{} {} could not be read", event.kind, event.id);
        }
        read.ok()
    }

    /// Handles `repo.purged` with `statements`, each taking the
    /// repository's id as `?1`, in one batch; says whether `event` was
    /// one. Running them again changes nothing.
    pub async fn on_purged(db: &D1Database, event: &Event, statements: &[&str]) -> Result<bool> {
        let Some(Lifecycle::Purged(purged)) = read(event) else {
            return Ok(false);
        };
        if statements.is_empty() {
            return Ok(true);
        }
        let mut batch = Vec::with_capacity(statements.len());
        for sql in statements {
            batch.push(db.prepare(*sql).bind(&[purged.repo_id.as_str().into()])?);
        }
        db.batch(batch).await?;
        Ok(true)
    }
}

/// What a service does when an account is purged (`user.deleted`): drop
/// what it keeps for the account alone, and show what it wrote as `ghost`.
pub mod user_deleted {
    use g1t_contracts::events::{Event, UserDeleted};
    use worker::wasm_bindgen::JsValue;
    use worker::{D1Database, Result};

    /// What each statement is given: the account's id as `?1`, and its
    /// username (lowercase) as `?2` when the statement names `?2`.
    pub fn binds<'a>(sql: &str, user_id: &'a str, username: &'a str) -> Vec<&'a str> {
        let mut binds = vec![user_id];
        if sql.contains("?2") {
            binds.push(username);
        }
        binds
    }

    /// Handles `user.deleted` with `statements` in one batch; says whether
    /// `event` was one. Running them again changes nothing.
    pub async fn on_event(db: &D1Database, event: &Event, statements: &[&str]) -> Result<bool> {
        if event.kind != "user.deleted" {
            return Ok(false);
        }
        let Ok(deleted) = serde_json::from_value::<UserDeleted>(event.data.clone()) else {
            worker::console_error!("user.deleted {} could not be read", event.id);
            return Ok(true);
        };
        let username = deleted.username.to_lowercase();
        if deleted.user_id.is_empty() || username.is_empty() || statements.is_empty() {
            return Ok(true);
        }
        let mut batch = Vec::with_capacity(statements.len());
        for sql in statements {
            let values: Vec<JsValue> = binds(sql, &deleted.user_id, &username).into_iter().map(JsValue::from).collect();
            batch.push(db.prepare(*sql).bind(&values)?);
        }
        db.batch(batch).await?;
        Ok(true)
    }
}

/// Dropping what a service keeps for a workspace alone when the workspace
/// is deleted.
pub mod deleted {
    use g1t_contracts::events::{Event, WorkspaceDeleted};
    use worker::{D1Database, Result};

    /// Handles `workspace.deleted` with `statements`, each taking the
    /// workspace's slug as `?1`, in one batch; says whether `event` was
    /// one. Running them again changes nothing.
    pub async fn on_event(db: &D1Database, event: &Event, statements: &[&str]) -> Result<bool> {
        if event.kind != "workspace.deleted" {
            return Ok(false);
        }
        let Ok(deleted) = serde_json::from_value::<WorkspaceDeleted>(event.data.clone()) else {
            worker::console_error!("workspace.deleted {} could not be read", event.id);
            return Ok(true);
        };
        let slug = deleted.slug.to_lowercase();
        if slug.is_empty() || statements.is_empty() {
            return Ok(true);
        }
        let mut batch = Vec::with_capacity(statements.len());
        for sql in statements {
            batch.push(db.prepare(*sql).bind(&[slug.as_str().into()])?);
        }
        db.batch(batch).await?;
        Ok(true)
    }
}

/// Catching up on `work.migrated` (issues became work items, g1t #57).
/// A service that rewrites what it kept by issue number when it hears
/// `work.migrated` also pages through the work service's
/// `legacy_item_map` on its cron, applying each page the same way, so a
/// page that never arrived (one left in the dead-letter queue) is not lost.
/// Where it got to is kept in the service's `work_catch_up` table (made by
/// its migration, one row named `work.migrated`), and once the last page is
/// applied it does nothing more. Every rewrite leaves what it already
/// rewrote alone, so a page applied twice changes nothing.
pub mod work_migrated {
    use std::future::Future;

    use g1t_contracts::events::WorkMigrated;
    use g1t_contracts::time::rfc3339;
    use g1t_contracts::work::{LegacyItemMapArgs, LegacyItemPage};
    use serde::Deserialize;
    use worker::wasm_bindgen::JsValue;
    use worker::{D1Database, Fetcher, Result};

    /// Moves asked for at a time, and pages applied in one run.
    pub const PAGE: u32 = 250;
    pub const PAGES_PER_RUN: u32 = 20;

    #[derive(Deserialize)]
    struct Row {
        #[serde(default)]
        cursor: Option<String>,
        page: u32,
        #[serde(default)]
        done_at: Option<String>,
    }

    /// One more stretch of the catch-up: each page read is handed to
    /// `apply` as the `work.migrated` it would have been. Whether it is done.
    /// It waits while the work service is still moving issues.
    pub async fn catch_up<F, Fut>(db: &D1Database, work: &Fetcher, mut apply: F) -> Result<bool>
    where
        F: FnMut(WorkMigrated) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        let row = db.prepare("SELECT cursor, page, done_at FROM work_catch_up WHERE name = 'work.migrated'").first::<Row>(None).await?;
        let Some(row) = row else { return Ok(true) };
        if row.done_at.is_some() {
            return Ok(true);
        }
        let (mut cursor, mut page) = (row.cursor, row.page);
        for _ in 0..PAGES_PER_RUN {
            let found: LegacyItemPage =
                crate::call(work, "legacy_item_map", &LegacyItemMapArgs { after: cursor.clone(), limit: PAGE }).await?;
            if !found.moved {
                return Ok(false);
            }
            page += 1;
            let done = found.next.is_none();
            if !found.items.is_empty() {
                apply(WorkMigrated { page, items: found.items, done }).await?;
            }
            cursor = found.next;
            let done_at = if done { JsValue::from(rfc3339(crate::now_ms())) } else { JsValue::NULL };
            db.prepare("UPDATE work_catch_up SET cursor = ?1, page = ?2, done_at = ?3 WHERE name = 'work.migrated'")
                .bind(&[cursor.as_deref().map_or(JsValue::NULL, JsValue::from), page.into(), done_at])?
                .run()
                .await?;
            if done {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
