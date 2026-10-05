//! What g1t looks for in a repository, kept apart from any service so it
//! can be tested on its own and shared: secrets in what is pushed
//! ([`secrets`], [`protection`], read out of git packs by [`pack`]), and
//! known vulnerabilities in what a project depends on ([`lockfiles`],
//! [`osv`], ordered by [`version`]).

pub mod lockfiles;
pub mod osv;
pub mod pack;
pub mod protection;
pub mod secrets;
pub mod version;
