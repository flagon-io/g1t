//! Types and service interfaces shared by every g1t service.
//!
//! Each service has a module here holding the data it exchanges and the
//! arguments of each of its methods. Services and their callers depend on
//! this crate, never on each other's code.

pub mod events;
pub mod identity;
mod ids;
mod names;
mod outcome;
pub mod repos;
pub mod time;
pub mod work;

pub use ids::new_id;
pub use names::{is_valid_namespace, is_valid_repo_name};
pub use outcome::{Failure, FailureCode, Outcome};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub username: String,
    /// Whether the account's email address has been confirmed. Unverified
    /// accounts can sign in but cannot create or change anything.
    #[serde(default)]
    pub verified: bool,
}

/// Who is asking. Every read and write in every service takes one.
pub type Viewer = Option<User>;
