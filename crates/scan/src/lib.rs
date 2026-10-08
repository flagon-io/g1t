//! What g1t looks for in a repository, kept apart from any service so it
//! can be tested on its own and shared: secrets in what is pushed
//! ([`secrets`], [`protection`], read out of git packs by [`pack`], and the
//! formats people define themselves, [`custom`], with [`validity`] checks
//! with their issuers), known vulnerabilities in what a project depends on
//! ([`lockfiles`], [`osv`], ordered by [`version`]), its dependency graph
//! ([`graph`], exported as an SPDX document by [`sbom`], compared across a
//! pull request by [`review`]), and code scanning results ([`sarif`]).

pub mod custom;
pub mod graph;
pub mod lockfiles;
pub mod osv;
pub mod pack;
pub mod protection;
pub mod review;
pub mod sarif;
pub mod sbom;
pub mod secrets;
pub mod validity;
pub mod version;
