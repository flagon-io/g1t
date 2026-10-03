//! GitHub Actions on g1t. A repository's `.g1t/workflows/*.yml`, written
//! exactly as GitHub's `.github/workflows`, run on
//! g1t as they are: this crate reads them ([`workflow`]), evaluates their
//! `${{ }}` expressions ([`expr`]), matches their branch and path filters
//! ([`filter`]), expands their matrices ([`matrix`]), and says which g1t
//! events are which GitHub events ([`events`]).
//!
//! It has no I/O, so the actions service (in a Worker) and the sandbox
//! (in a container) share it: the service decides what runs, the sandbox
//! runs the steps, and both read workflows and expressions the same way.

pub mod cron;
pub mod events;
pub mod expr;
pub mod filter;
pub mod matrix;
pub mod workflow;
