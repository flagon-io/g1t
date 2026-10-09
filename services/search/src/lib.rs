//! The search service: one search across all of g1t, and Explore.
//!
//! - **What it searches.** Repositories (name, description, topics, the
//!   opening of the README), code on default branches (paths and
//!   contents), issues and pull requests (titles and bodies), people and
//!   workspaces. Everything public, and private content the viewer is a
//!   member of.
//! - **The index.** D1 with FTS5, a database that costs nothing while no
//!   one uses it: words for prose (`unicode61`), every run of three
//!   characters for code (`trigram`), each table kept in step with its
//!   index by triggers. See `migrations/0001_init.sql`.
//! - **Visibility.** Decided when a query runs, twice: in SQL against the
//!   viewer's memberships now, then on the page against the repos service.
//!   See `visibility.rs`.
//! - **Keeping it current.** From the events bus (`g1t-events-search`) and
//!   its own job queue (`g1t-search-jobs`), with the cost of each push
//!   capped. See `index.rs`.
//!
//! Reached through service bindings: `POST /rpc/<method>`; see
//! `g1t_contracts::search`.

mod index;
mod query;
mod read;
mod rules;
mod snippet;
mod sql;
mod store;
mod visibility;

use std::cell::RefCell;
use std::collections::HashMap;

use g1t_contracts::User;
use g1t_contracts::billing::PauseLevel;
use g1t_contracts::events::Event;
use g1t_kit::{args, reply, rpc_method};
use worker::{Context, D1Database, Env, Fetcher, MessageBatch, MessageExt, Request, Response, Result, event};

use index::Job;

/// The queue of this service's own jobs.
const JOBS_QUEUE: &str = "g1t-search-jobs";

/// How often an isolate looks for backfill pages parked while indexing
/// was paused.
const RESUME_EVERY_MS: u64 = 5 * 60 * 1000;

thread_local! {
    static RESUME_CHECKED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Whether to look for parked pages now; marks it looked for.
fn resume_due(now: u64) -> bool {
    RESUME_CHECKED.with(|last| {
        if now.saturating_sub(last.get()) < RESUME_EVERY_MS {
            return false;
        }
        last.set(now);
        true
    })
}

pub struct Search {
    db: D1Database,
    env: Env,
    repos: Fetcher,
    work: Fetcher,
    identity: Fetcher,
    /// Each workspace's own principal, asked of identity once per invocation.
    actors: RefCell<HashMap<String, Option<User>>>,
}

impl Search {
    fn new(env: Env) -> Result<Self> {
        Ok(Search {
            db: env.d1("DB")?,
            repos: env.service("REPOS")?,
            work: env.service("WORK")?,
            identity: env.service("IDENTITY")?,
            actors: RefCell::new(HashMap::new()),
            env,
        })
    }
}

#[event(fetch)]
async fn fetch(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let Some(method) = rpc_method(&request) else {
        return Response::error("Not found", 404);
    };
    // A replica near the caller when it asks for one (crates/kit/src/d1.rs).
    let (db, served) = g1t_kit::d1::open(&env, "DB", &request)?;
    let mut search = Search::new(env)?;
    search.db = db;
    let body: serde_json::Value = request.json().await?;
    let answered = match method.as_str() {
        "search" => reply(&search.search(args(body)?).await?),
        "suggest" => reply(&search.suggest(args(body)?).await?),
        "explore" => reply(&search.explore(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    };
    served.finish(answered)
}

/// Events from the bus, and this service's own jobs. Indexing is
/// idempotent, so a message that fails is retried.
#[event(queue)]
async fn queue(batch: MessageBatch<serde_json::Value>, env: Env, _ctx: Context) -> Result<()> {
    let search = Search::new(env)?;
    let jobs = batch.queue() == JOBS_QUEUE;
    // Indexing paused across g1t (billing's `platform_pause`, kept 30
    // seconds in the isolate): backfills wait, and events still keep the
    // index current. Without a billing binding nothing is ever paused.
    let paused = match search.env.service("BILLING") {
        Ok(billing) => g1t_kit::pause::paused(&billing, PauseLevel::Indexing).await,
        Err(_) => false,
    };
    if !jobs && !paused {
        if let Err(error) = search.ensure_backfill().await {
            worker::console_error!("search: could not start the backfill: {error}");
        }
        // Pages parked while paused, looked for at most every few minutes.
        if resume_due(g1t_kit::now_ms()) {
            match search.resume_parked().await {
                Ok(0) => {}
                Ok(found) => worker::console_log!("search: resumed {found} parked backfill pages"),
                Err(error) => worker::console_error!("search: could not resume parked backfill pages: {error}"),
            }
        }
    }
    for message in batch.messages()? {
        let body = message.body().clone();
        let outcome = if jobs {
            match serde_json::from_value::<Job>(body) {
                Ok(job) if paused && index::parked_key(&job).is_some() => search.park(&job).await,
                Ok(job) => search.run_job(job).await,
                Err(error) => {
                    worker::console_error!("search: a job could not be read: {error}");
                    Ok(())
                }
            }
        } else {
            match serde_json::from_value::<Event>(body) {
                Ok(event) => search.on_event(&event).await,
                Err(_) => Ok(()),
            }
        };
        match outcome {
            Ok(()) => message.ack(),
            Err(error) => {
                worker::console_error!("search: a message failed and will be retried: {error}");
                message.retry();
            }
        }
    }
    Ok(())
}
