//! Transferring a repository to another workspace.
//!
//! A repository keeps its id, its name and its git store key; only its
//! namespace changes, so its git data does not move at all. The path it
//! left is kept in `repo_redirects`, pointing at its id, so old links, git
//! remotes and API calls resolve to wherever it is now, however many times
//! it has moved since. A redirect stops when a repository is made at its
//! path.
//!
//! Everything other services keep under the repository's path or its
//! workspace's slug follows on `repo.transferred` (see
//! `g1t_kit::transfer`); the tokens of agents at work on it are moved here,
//! with identity, before the event goes out, so a run under way keeps
//! working.

use g1t_contracts::audit::{
    AuditActor, AuditOutcome, AuditTarget, NewAuditEntry, RecordAuditArgs, Surface,
};
use g1t_contracts::events::{NewEvent, RepoTransferred};
use g1t_contracts::identity::TransferRepoScopesArgs;
use g1t_contracts::repos::{Repo, RepoPath, TransferArgs};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, Role, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use crate::registry::Registry;
use crate::store::GitStore;
use crate::{Repos, SOURCE, UNVERIFIED, git_ops, not_found};

/// Everything about a transfer that decides whether it may happen, as read
/// from the request and the database.
#[derive(Debug, Default)]
pub struct Facts {
    /// The actor is a person, not a workspace's or an agent's token.
    pub person: bool,
    pub verified: bool,
    pub role_in_source: Option<Role>,
    pub role_in_destination: Option<Role>,
    /// A member (not an owner) of the source with the Admin role on the
    /// repository, whose member privileges let admins delete and transfer.
    pub admin_may_transfer: bool,
    /// The destination's member privileges let its members create a
    /// repository of this one's visibility.
    pub may_create_in_destination: bool,
    pub source: String,
    pub destination: String,
    pub name: String,
    /// Another repository has the name in the destination.
    pub name_taken: bool,
    pub is_private: bool,
    /// The repository's measured bytes.
    pub bytes: i64,
    /// The destination is on no plan, so its private storage is capped.
    pub destination_free: bool,
    /// What the destination's private repositories hold now.
    pub destination_private_bytes: i64,
    /// What a free workspace's private repositories may hold.
    pub free_private_bytes: i64,
}

/// Whether the transfer `facts` describe may happen: `Ok`, or why not, in
/// words for the person asking.
pub fn check(facts: &Facts) -> std::result::Result<(), (FailureCode, String)> {
    let refuse = |code, message: String| Err((code, message));
    if !facts.person {
        return refuse(
            FailureCode::Forbidden,
            "Only a person can transfer a repository. Sign in, or use a personal access token.".into(),
        );
    }
    let source_ok = facts.role_in_source == Some(Role::Owner)
        || (facts.role_in_source == Some(Role::Member) && facts.admin_may_transfer);
    if !source_ok {
        return refuse(
            FailureCode::Forbidden,
            format!(
                "Only an owner of {} can transfer its repositories, unless its member privileges let repository admins.",
                facts.source
            ),
        );
    }
    if !facts.verified {
        return refuse(FailureCode::Forbidden, UNVERIFIED.into());
    }
    if facts.destination.is_empty() {
        return refuse(FailureCode::Invalid, "Say which workspace to transfer it to.".into());
    }
    if facts.destination == facts.source {
        return refuse(
            FailureCode::Invalid,
            format!("{}/{} is already in {}.", facts.source, facts.name, facts.destination),
        );
    }
    let destination_ok = facts.role_in_destination == Some(Role::Owner)
        || (facts.role_in_destination == Some(Role::Member) && facts.may_create_in_destination);
    if !destination_ok {
        return refuse(
            FailureCode::Forbidden,
            format!(
                "You can transfer a repository only to a workspace where you can create one, and you cannot in {}.",
                facts.destination
            ),
        );
    }
    if facts.name_taken {
        return refuse(
            FailureCode::Conflict,
            format!(
                "{} already has a repository named {}. Rename or remove that one first.",
                facts.destination, facts.name
            ),
        );
    }
    if facts.is_private
        && facts.destination_free
        && git_ops::storage_full(facts.destination_private_bytes + facts.bytes, facts.free_private_bytes)
    {
        return refuse(
            FailureCode::PaymentRequired,
            format!(
                "{}'s private repositories would hold {:.2} GB, more than the {:.0} GB a free workspace has. Start the g1t plan in {}, or make the repository public first.",
                facts.destination,
                (facts.destination_private_bytes + facts.bytes) as f64 / 1e9,
                facts.free_private_bytes as f64 / 1e9,
                facts.destination
            ),
        );
    }
    Ok(())
}

/// The redirect of an old path, as read with where its repository is now.
#[derive(Debug, Deserialize)]
struct Moved {
    namespace: String,
    name: String,
}

impl Registry {
    /// Moves a repository to `to`, keeping its old path as a redirect. Any
    /// redirect held by the path it moves to gives way: a repository is
    /// there now.
    pub async fn transfer(&self, repo: &Repo, to: &str) -> Result<()> {
        let now = rfc3339(now_ms());
        self.db
            .batch(vec![
                self.db
                    .prepare("UPDATE repos SET namespace = ? WHERE id = ? AND namespace = ?")
                    .bind(&[to.into(), repo.id.as_str().into(), repo.namespace.as_str().into()])?,
                self.db
                    .prepare("DELETE FROM repo_redirects WHERE namespace = ? AND name = ?")
                    .bind(&[to.into(), repo.name.as_str().into()])?,
                self.db
                    .prepare(
                        "INSERT OR REPLACE INTO repo_redirects (namespace, name, repo_id, created_at)
                         VALUES (?, ?, ?, ?)",
                    )
                    .bind(&[
                        repo.namespace.as_str().into(),
                        repo.name.as_str().into(),
                        repo.id.as_str().into(),
                        now.as_str().into(),
                    ])?,
            ])
            .await?;
        Ok(())
    }

    /// Where the repository that left `path` is now, unless a repository
    /// is at `path` itself.
    pub async fn resolve_moved(&self, path: &RepoPath) -> Result<Option<RepoPath>> {
        Ok(self
            .db
            .prepare(
                "SELECT repos.namespace, repos.name FROM repo_redirects
                 JOIN repos ON repos.id = repo_redirects.repo_id AND repos.deleted_at IS NULL
                 WHERE repo_redirects.namespace = ?1 AND repo_redirects.name = ?2
                   AND NOT EXISTS (SELECT 1 FROM repos AS here WHERE here.namespace = ?1 AND here.name = ?2)",
            )
            .bind(&[
                path.namespace.to_lowercase().into(),
                path.name.to_lowercase().into(),
            ])?
            .first::<Moved>(None)
            .await?
            .map(|moved| RepoPath {
                namespace: moved.namespace,
                name: moved.name,
            }))
    }

    /// A repository made at `path` ends any redirect there.
    pub async fn drop_redirect(&self, path: &RepoPath) -> Result<()> {
        self.db
            .prepare("DELETE FROM repo_redirects WHERE namespace = ? AND name = ?")
            .bind(&[path.namespace.as_str().into(), path.name.as_str().into()])?
            .run()
            .await?;
        Ok(())
    }

    /// How many repositories (not working copies) a workspace holds.
    pub async fn count_in(&self, namespace: &str) -> Result<u32> {
        #[derive(Deserialize)]
        struct Count {
            n: u32,
        }
        Ok(self
            .db
            .prepare("SELECT count(*) AS n FROM repos WHERE namespace = ? AND fork_of IS NULL AND deleted_at IS NULL")
            .bind(&[namespace.to_lowercase().into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |count| count.n))
    }

    /// The repository's measured bytes.
    pub async fn stored_bytes(&self, id: &str) -> Result<i64> {
        #[derive(Deserialize)]
        struct Bytes {
            stored_bytes: Option<f64>,
        }
        Ok(self
            .db
            .prepare("SELECT stored_bytes FROM repos WHERE id = ? AND deleted_at IS NULL")
            .bind(&[id.into()])?
            .first::<Bytes>(None)
            .await?
            .and_then(|row| row.stored_bytes)
            .unwrap_or(0.0) as i64)
    }
}

impl<S: GitStore> Repos<S> {
    /// `transfer`: see `g1t_contracts::repos::TransferArgs`.
    pub(crate) async fn transfer(&self, a: TransferArgs) -> Result<Outcome<Repo>> {
        let viewer = Some(a.actor.clone());
        let Some(repo) = self.readable(&a.path, &viewer).await? else {
            return Ok(not_found());
        };
        if repo.fork_of.is_some() {
            return Ok(not_found());
        }
        let destination = a.to.trim().to_lowercase();
        let source = repo.namespace.clone();
        // A repository deleted there but not yet purged holds the name too.
        let taken = !destination.is_empty()
            && self
                .registry
                .by_path_any(&RepoPath {
                    namespace: destination.clone(),
                    name: repo.name.clone(),
                })
                .await?
                .is_some();
        let private_checks = repo.is_private && !destination.is_empty() && destination != source;
        let (bytes, held, free) = if private_checks {
            let free = git_ops::is_free(self.billing.as_ref(), &destination).await;
            (
                self.registry.stored_bytes(&repo.id).await?,
                self.registry.private_bytes(&destination).await.unwrap_or(0),
                free,
            )
        } else {
            (0, 0, false)
        };
        let viewer = Some(a.actor.clone());
        let admin_may_transfer = crate::registry::role(&repo, &viewer) == Some(g1t_contracts::access::RepoRole::Admin)
            && a.actor.privileges_in(&source).members_can_delete_repositories;
        let may_create_in_destination = a
            .actor
            .role_in(&destination)
            .is_some_and(|role| a.actor.privileges_in(&destination).may_create(role, repo.is_private));
        let facts = Facts {
            person: a.actor.kind == PrincipalKind::User,
            verified: a.actor.verified,
            role_in_source: a.actor.role_in(&source),
            role_in_destination: a.actor.role_in(&destination),
            admin_may_transfer,
            may_create_in_destination,
            source: source.clone(),
            destination: destination.clone(),
            name: repo.name.clone(),
            name_taken: taken,
            is_private: repo.is_private,
            bytes,
            destination_free: free,
            destination_private_bytes: held,
            free_private_bytes: self.free_private_bytes,
        };
        if let Err((code, message)) = check(&facts) {
            return Ok(Outcome::fail(code, message));
        }

        self.registry.transfer(&repo, &destination).await?;
        let moved = Repo {
            namespace: destination.clone(),
            ..repo.clone()
        };
        let from = RepoPath {
            namespace: source.clone(),
            name: repo.name.clone(),
        };
        let to = RepoPath {
            namespace: destination.clone(),
            name: repo.name.clone(),
        };
        // Agents at work on it keep their scope, which names it by path.
        if let Some(identity) = &self.identity {
            let moved_scopes: Result<bool> = g1t_kit::call(
                identity,
                "transfer_repo_scopes",
                &TransferRepoScopesArgs {
                    from: from.clone(),
                    to: to.clone(),
                },
            )
            .await;
            if let Err(error) = moved_scopes {
                worker::console_error!("agent scopes for {} not moved: {error}", repo.id);
            }
        }
        self.publish(NewEvent {
            kind: "repo.transferred",
            source: SOURCE,
            repo_id: Some(repo.id.clone()),
            actor: Some(a.actor.id.clone()),
            data: RepoTransferred {
                repo_id: repo.id.clone(),
                name: repo.name.clone(),
                from: source.clone(),
                to: destination.clone(),
            },
        })
        .await?;
        self.record_transfer(&a, &from, &to).await;
        Ok(Outcome::Ok(moved))
    }

    /// One entry in each workspace's audit log: the one it left and the
    /// one it joined.
    async fn record_transfer(&self, a: &TransferArgs, from: &RepoPath, to: &RepoPath) {
        let request_id = new_id("req", now_ms());
        let entry = |workspace: &str, repo: &RepoPath, message: String| NewAuditEntry {
            actor: AuditActor::of(&a.actor),
            action: "repo.transferred".to_owned(),
            surface: a.surface.unwrap_or(Surface::Web),
            target: AuditTarget {
                workspace: workspace.to_owned(),
                repo: Some(format!("{}/{}", repo.namespace, repo.name)),
                ..AuditTarget::default()
            },
            outcome: AuditOutcome::Allowed,
            rule: "owner".to_owned(),
            result: Some("ok".to_owned()),
            message: Some(message),
            request_id: request_id.clone(),
        };
        let entries = vec![
            entry(
                &from.namespace,
                from,
                format!("Transferred to {}/{}", to.namespace, to.name),
            ),
            entry(
                &to.namespace,
                to,
                format!("Transferred from {}/{}", from.namespace, from.name),
            ),
        ];
        let recorded: Result<u32> =
            g1t_kit::call(&self.events, "audit_record", &RecordAuditArgs { entries }).await;
        if let Err(error) = recorded {
            worker::console_error!("transfer audit entries not recorded: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts {
            person: true,
            verified: true,
            role_in_source: Some(Role::Owner),
            role_in_destination: Some(Role::Owner),
            source: "syntaqx".into(),
            destination: "flagon-io".into(),
            name: "g1t".into(),
            free_private_bytes: 1_000_000_000,
            ..Facts::default()
        }
    }

    fn refused(facts: &Facts) -> FailureCode {
        check(facts).unwrap_err().0
    }

    #[test]
    fn an_owner_of_both_may_transfer() {
        assert!(check(&facts()).is_ok());
    }

    #[test]
    fn member_privileges_let_an_admin_transfer_where_they_may_create() {
        let member = Facts { role_in_source: Some(Role::Member), role_in_destination: Some(Role::Member), ..facts() };
        assert_eq!(refused(&member), FailureCode::Forbidden);
        let allowed = Facts { admin_may_transfer: true, may_create_in_destination: true, ..member };
        assert!(check(&allowed).is_ok());
        assert_eq!(
            refused(&Facts { may_create_in_destination: false, admin_may_transfer: true, role_in_source: Some(Role::Member), role_in_destination: Some(Role::Member), ..facts() }),
            FailureCode::Forbidden
        );
    }

    #[test]
    fn needs_a_verified_person_who_owns_both() {
        assert_eq!(refused(&Facts { person: false, ..facts() }), FailureCode::Forbidden);
        assert_eq!(refused(&Facts { verified: false, ..facts() }), FailureCode::Forbidden);
        assert_eq!(
            refused(&Facts { role_in_source: Some(Role::Member), ..facts() }),
            FailureCode::Forbidden
        );
        assert_eq!(
            refused(&Facts { role_in_destination: Some(Role::Member), ..facts() }),
            FailureCode::Forbidden
        );
        assert_eq!(refused(&Facts { role_in_destination: None, ..facts() }), FailureCode::Forbidden);
    }

    #[test]
    fn needs_somewhere_else_with_the_name_free() {
        assert_eq!(refused(&Facts { destination: String::new(), ..facts() }), FailureCode::Invalid);
        assert_eq!(
            refused(&Facts { destination: "syntaqx".into(), role_in_destination: Some(Role::Owner), ..facts() }),
            FailureCode::Invalid
        );
        let (code, message) = check(&Facts { name_taken: true, ..facts() }).unwrap_err();
        assert_eq!(code, FailureCode::Conflict);
        assert!(message.contains("flagon-io already has a repository named g1t"));
    }

    #[test]
    fn a_free_destination_takes_private_repositories_within_its_storage() {
        let heavy = Facts {
            is_private: true,
            destination_free: true,
            destination_private_bytes: 900_000_000,
            bytes: 200_000_000,
            ..facts()
        };
        assert_eq!(refused(&heavy), FailureCode::PaymentRequired);
        // Public, or a destination on the plan: no cap.
        assert!(check(&Facts { is_private: false, ..heavy }).is_ok());
        let heavy = Facts {
            is_private: true,
            destination_free: true,
            destination_private_bytes: 900_000_000,
            bytes: 200_000_000,
            ..facts()
        };
        assert!(check(&Facts { destination_free: false, ..heavy }).is_ok());
        let light = Facts {
            is_private: true,
            destination_free: true,
            bytes: 10_000,
            ..facts()
        };
        assert!(check(&light).is_ok());
    }
}
