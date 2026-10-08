//! Deploy keys, and who an SSH key belongs to.
//!
//! A deploy key is an SSH key one repository's admins add so that a
//! machine can clone it, or push to it when they allowed write access. The
//! rules are `g1t_contracts::deploy_keys`; this keeps the keys, beside
//! people's own (`ssh_keys`, lib.rs). A public key is registered once
//! across both tables: the services check, and triggers (migration 0035)
//! refuse a second insert that slips past the check.
//!
//! Keys are kept by repository id, so a rename or a transfer keeps them;
//! the path, and the workspace a key acts as, are looked up each time it
//! is used. A deleted repository's keys resolve to no one while it is
//! deleted, and go with it when it is purged (`forget_deploy_keys`, called
//! with `forget_repo_access`).
//!
//! **Last used.** Both kinds of key record when they last signed in, at
//! most once every 5 minutes, as access tokens do (tokens.rs), and only once
//! the client proved it holds the private key.

use g1t_contracts::audit::Surface;
use g1t_contracts::deploy_keys::{
    self, AddDeployKeyArgs, DeployKey, DeployKeyArgs, DeployKeysArgs, KEY_IN_USE, MAX_PER_REPO, RemoveDeployKeyArgs,
    SshKeyArgs,
};
use g1t_contracts::repos::{PathByIdArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, User, Viewer, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::{Identity, crypto};

/// How stale a key's last-used time may get before it is written again.
const LAST_USED_RESOLUTION_MS: u64 = 5 * 60 * 1000;
const NOT_FOUND: &str = "Repository not found.";
const NO_SUCH_KEY: &str = "There is no deploy key with that id on this repository.";

const COLUMNS: &str = "dk.id, dk.title, dk.public_key, dk.fingerprint, dk.read_only, dk.created_at, dk.last_used_at,
  COALESCE(u.username, w.slug) AS created_by
  FROM deploy_keys dk
  LEFT JOIN users u ON u.id = dk.created_by
  LEFT JOIN workspaces w ON w.id = dk.created_by";

#[derive(Deserialize)]
struct Row {
    id: String,
    title: String,
    public_key: String,
    fingerprint: String,
    read_only: u8,
    created_at: String,
    last_used_at: Option<String>,
    created_by: Option<String>,
}

impl From<Row> for DeployKey {
    fn from(row: Row) -> Self {
        DeployKey {
            id: row.id,
            title: row.title,
            key: row.public_key,
            fingerprint: row.fingerprint,
            read_only: row.read_only != 0,
            created_at: row.created_at,
            created_by: row.created_by,
            last_used_at: row.last_used_at,
        }
    }
}

/// The title a key is given: what was typed, else the key's comment, else
/// `fallback`.
pub fn title_for(typed: &str, comment: &str, fallback: &str) -> String {
    [typed.trim(), comment.trim(), fallback]
        .into_iter()
        .find(|candidate| !candidate.is_empty())
        .unwrap_or_default()
        .chars()
        .take(100)
        .collect()
}

/// Whether a last-used time should be written now.
fn due(last: Option<&str>) -> bool {
    deploy_keys::note_use_due(last, &rfc3339(now_ms().saturating_sub(LAST_USED_RESOLUTION_MS)))
}

impl Identity {
    /// The repository at `path`, if `viewer` may see and change its deploy
    /// keys, with the id of its workspace.
    async fn keys_of(&self, viewer: &Viewer, path: &RepoPath) -> Result<Outcome<(Repo, String)>> {
        let Some(repo) = self.repo_for(path, viewer).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_FOUND));
        };
        if let Some(why) = deploy_keys::refusal(viewer.as_ref(), (&repo).into(), &format!("{}/{}", repo.namespace, repo.name)) {
            return Ok(Outcome::fail(FailureCode::Forbidden, why));
        }
        let Some(workspace_id) = self.workspace_id_of(&repo.namespace).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NOT_FOUND));
        };
        Ok(Outcome::Ok((repo, workspace_id)))
    }

    async fn deploy_key_row(&self, repo_id: &str, id: &str) -> Result<Option<DeployKey>> {
        Ok(self
            .db
            .prepare(format!("SELECT {COLUMNS} WHERE dk.repo_id = ? AND dk.id = ?"))
            .bind(&[repo_id.into(), id.trim().into()])?
            .first::<Row>(None)
            .await?
            .map(DeployKey::from))
    }

    /// Whether any account's SSH key, or any repository's deploy key, has
    /// this fingerprint.
    pub(crate) async fn key_in_use(&self, fingerprint: &str) -> Result<bool> {
        Ok(self
            .db
            .prepare(
                "SELECT fingerprint FROM ssh_keys WHERE fingerprint = ?1
                 UNION ALL SELECT fingerprint FROM deploy_keys WHERE fingerprint = ?1 LIMIT 1",
            )
            .bind(&[fingerprint.into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some())
    }

    pub async fn list_deploy_keys(&self, a: DeployKeysArgs) -> Result<Outcome<Vec<DeployKey>>> {
        let (repo, _) = match self.keys_of(&a.viewer, &a.path).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let rows = self
            .db
            .prepare(format!("SELECT {COLUMNS} WHERE dk.repo_id = ? ORDER BY dk.created_at, dk.id LIMIT {MAX_PER_REPO}"))
            .bind(&[repo.id.as_str().into()])?
            .all()
            .await?
            .results::<Row>()?;
        Ok(Outcome::Ok(rows.into_iter().map(DeployKey::from).collect()))
    }

    pub async fn get_deploy_key(&self, a: DeployKeyArgs) -> Result<Outcome<DeployKey>> {
        let (repo, _) = match self.keys_of(&a.viewer, &a.path).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        Ok(match self.deploy_key_row(&repo.id, &a.id).await? {
            Some(key) => Outcome::Ok(key),
            None => Outcome::fail(FailureCode::NotFound, NO_SUCH_KEY),
        })
    }

    pub async fn add_deploy_key(&self, a: AddDeployKeyArgs) -> Result<Outcome<DeployKey>> {
        let actor = Some(a.actor.clone());
        let (repo, workspace_id) = match self.keys_of(&actor, &a.path).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Confirm your email address before adding deploy keys."));
        }
        let Some(key) = crypto::parse_ssh_key(&a.key) else {
            return Ok(Outcome::fail(
                FailureCode::Invalid,
                "That is not a valid OpenSSH public key. Paste one line, such as the contents of id_ed25519.pub.",
            ));
        };
        if self.key_in_use(&key.fingerprint).await? {
            return Ok(Outcome::fail(FailureCode::Conflict, KEY_IN_USE));
        }
        #[derive(Deserialize)]
        struct Count {
            count: u32,
        }
        let count = self
            .db
            .prepare("SELECT count(*) AS count FROM deploy_keys WHERE repo_id = ?")
            .bind(&[repo.id.as_str().into()])?
            .first::<Count>(None)
            .await?
            .map_or(0, |row| row.count);
        if count as usize >= MAX_PER_REPO {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("A repository can have at most {MAX_PER_REPO} deploy keys. Delete one first."),
            ));
        }
        let now = now_ms();
        let id = new_id("dk", now);
        let title = title_for(&a.title, &key.comment, "Deploy key");
        let inserted = self
            .db
            .prepare(
                "INSERT INTO deploy_keys (id, repo_id, workspace_id, title, public_key, fingerprint, read_only, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                repo.id.as_str().into(),
                workspace_id.as_str().into(),
                title.as_str().into(),
                key.public_key.as_str().into(),
                key.fingerprint.as_str().into(),
                JsValue::from(u8::from(a.read_only)),
                a.actor.id.as_str().into(),
                rfc3339(now).into(),
            ])?
            .run()
            .await;
        // Added at the same moment elsewhere: the trigger or the unique
        // index refused it.
        if let Err(error) = inserted {
            if self.key_in_use(&key.fingerprint).await? {
                return Ok(Outcome::fail(FailureCode::Conflict, KEY_IN_USE));
            }
            return Err(error);
        }
        let access = if a.read_only { "read-only" } else { "read and write" };
        self.audit(
            &a.actor,
            "repo.deploy_key_added",
            (&repo).into(),
            a.surface.unwrap_or(Surface::Web),
            format!("Added the deploy key \"{title}\" ({}, {access})", key.fingerprint),
        )
        .await;
        Ok(match self.deploy_key_row(&repo.id, &id).await? {
            Some(key) => Outcome::Ok(key),
            None => Outcome::fail(FailureCode::NotFound, NO_SUCH_KEY),
        })
    }

    pub async fn remove_deploy_key(&self, a: RemoveDeployKeyArgs) -> Result<Outcome<bool>> {
        let actor = Some(a.actor.clone());
        let (repo, _) = match self.keys_of(&actor, &a.path).await? {
            Outcome::Ok(found) => found,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let Some(key) = self.deploy_key_row(&repo.id, &a.id).await? else {
            return Ok(Outcome::fail(FailureCode::NotFound, NO_SUCH_KEY));
        };
        self.db
            .prepare("DELETE FROM deploy_keys WHERE id = ? AND repo_id = ?")
            .bind(&[key.id.as_str().into(), repo.id.as_str().into()])?
            .run()
            .await?;
        self.audit(
            &a.actor,
            "repo.deploy_key_removed",
            (&repo).into(),
            a.surface.unwrap_or(Surface::Web),
            format!("Removed the deploy key \"{}\" ({})", key.title, key.fingerprint),
        )
        .await;
        Ok(Outcome::Ok(true))
    }

    /// A purged repository's deploy keys go with it.
    pub async fn forget_deploy_keys(&self, repo_id: &str) -> Result<()> {
        self.db
            .prepare("DELETE FROM deploy_keys WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Who signs in with the SSH key with this fingerprint: the person who
    /// registered it, with their workspaces and grants as any credential
    /// resolves them; or, for a deploy key, its repository's workspace
    /// acting through a token that reaches that repository only
    /// (`deploy_keys::principal`). Nobody for an unknown key, or a deploy
    /// key whose repository or workspace is deleted.
    pub async fn principal_for_ssh_key(&self, a: SshKeyArgs) -> Result<Viewer> {
        #[derive(Deserialize)]
        struct Person {
            key_id: String,
            last_used_at: Option<String>,
            id: String,
            username: String,
            verified: u8,
        }
        let person = self
            .db
            .prepare(
                "SELECT ssh_keys.id AS key_id, ssh_keys.last_used_at, users.id, users.username,
                   users.email_verified_at IS NOT NULL AS verified
                 FROM ssh_keys JOIN users ON users.id = ssh_keys.user_id
                 WHERE ssh_keys.fingerprint = ?",
            )
            .bind(&[a.fingerprint.as_str().into()])?
            .first::<Person>(None)
            .await?;
        if let Some(person) = person {
            if a.used && due(person.last_used_at.as_deref()) {
                self.note_key_use("ssh_keys", &person.key_id).await?;
            }
            let user = User {
                id: person.id,
                username: person.username,
                verified: person.verified != 0,
                ..User::default()
            };
            return self.with_workspaces(Some(user)).await;
        }

        #[derive(Deserialize)]
        struct Key {
            id: String,
            title: String,
            repo_id: String,
            read_only: u8,
            last_used_at: Option<String>,
        }
        let Some(key) = self
            .db
            .prepare("SELECT id, title, repo_id, read_only, last_used_at FROM deploy_keys WHERE fingerprint = ?")
            .bind(&[a.fingerprint.as_str().into()])?
            .first::<Key>(None)
            .await?
        else {
            return Ok(None);
        };
        // Where the repository is now; none while it is deleted.
        let path: Option<RepoPath> =
            g1t_kit::call(&self.env.service("REPOS")?, "path_by_id", &PathByIdArgs { id: key.repo_id.clone() }).await?;
        let Some(path) = path else {
            return Ok(None);
        };
        let Some(workspace_id) = self.workspace_id_of(&path.namespace).await? else {
            return Ok(None);
        };
        let Some(workspace) = self.workspace_principal(&workspace_id).await? else {
            return Ok(None);
        };
        if a.used && due(key.last_used_at.as_deref()) {
            self.note_key_use("deploy_keys", &key.id).await?;
        }
        let repo = format!("{}/{}", path.namespace, path.name);
        let access = deploy_keys::access(&key.id, &key.title, &repo, key.read_only != 0);
        Ok(Some(deploy_keys::principal(&workspace.id, &workspace.username, access)))
    }

    async fn note_key_use(&self, table: &str, id: &str) -> Result<()> {
        self.db
            .prepare(format!("UPDATE {table} SET last_used_at = ? WHERE id = ?"))
            .bind(&[rfc3339(now_ms()).into(), id.into()])?
            .run()
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_titled_by_what_was_typed_then_its_comment() {
        assert_eq!(title_for(" CI ", "ana@laptop", "Deploy key"), "CI");
        assert_eq!(title_for("", "ana@laptop", "Deploy key"), "ana@laptop");
        assert_eq!(title_for("  ", " ", "Deploy key"), "Deploy key");
        assert_eq!(title_for(&"x".repeat(300), "", "Deploy key").len(), 100);
    }

    #[test]
    fn a_key_parsed_for_a_repository_is_stored_without_its_comment() {
        let line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE deploy@ci";
        let key = crypto::parse_ssh_key(line).unwrap();
        assert_eq!(key.public_key, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE");
        assert!(key.fingerprint.starts_with("SHA256:"));
        assert_eq!(title_for("", &key.comment, "Deploy key"), "deploy@ci");
    }
}
