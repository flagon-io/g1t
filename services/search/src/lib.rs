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
use g1t_contracts::events::Event;
use g1t_kit::{args, reply, rpc_method};
use worker::{Context, D1Database, Env, Fetcher, MessageBatch, MessageExt, Request, Response, Result, event};

use index::Job;

/// The queue of this service's own jobs.
const JOBS_QUEUE: &str = "g1t-search-jobs";

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
    let search = Search::new(env)?;
    let body: serde_json::Value = request.json().await?;
    match method.as_str() {
        "search" => reply(&search.search(args(body)?).await?),
        "suggest" => reply(&search.suggest(args(body)?).await?),
        "explore" => reply(&search.explore(args(body)?).await?),
        _ => Response::error("Unknown method", 404),
    }
}

/// Events from the bus, and this service's own jobs. Indexing is
/// idempotent, so a message that fails is retried.
#[event(queue)]
async fn queue(batch: MessageBatch<serde_json::Value>, env: Env, _ctx: Context) -> Result<()> {
    let search = Search::new(env)?;
    let jobs = batch.queue() == JOBS_QUEUE;
    if !jobs && let Err(error) = search.ensure_backfill().await {
        worker::console_error!("search: could not start the backfill: {error}");
    }
    for message in batch.messages()? {
        let body = message.body().clone();
        let outcome = if jobs {
            match serde_json::from_value::<Job>(body) {
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
