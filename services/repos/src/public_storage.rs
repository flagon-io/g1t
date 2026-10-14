//! Public storage admission is independent of a paid subscription. Reserve
//! bytes before contacting the git store; a crash retains the reservation
//! rather than admitting the same capacity twice. A successful HTTP push
//! releases only the difference between its reservation and measured pack.
use g1t_contracts::repos::Repo;
use serde::Deserialize;
use worker::Result;

use crate::registry::Registry;

pub(crate) struct StreamQuota {
    pub registry: Registry,
    pub repo: Repo,
    pub cap: i64,
}

impl<S: crate::store::GitStore> crate::Repos<S> {
    pub(crate) fn public_quota(&self, repo: &Repo) -> Option<std::rc::Rc<StreamQuota>> {
        Some(std::rc::Rc::new(StreamQuota {
            registry: Registry { db: self.registry.db.clone() }, repo: repo.clone(), cap: self.free_public_bytes,
        }))
    }
}

pub(crate) const RESERVE: &str = "UPDATE repos SET storage_reserved_bytes = storage_reserved_bytes + ?2
    WHERE id = ?1 AND fork_of IS NULL AND ?2 >= 0
      AND NOT EXISTS (SELECT 1 FROM storage_copy_locks WHERE repo_id = ?1)
      AND (is_private = 1 OR (?2 <= ?3 AND COALESCE((SELECT SUM(stored_bytes + storage_reserved_bytes) FROM repos r
          WHERE r.namespace = repos.namespace AND r.is_private = 0 AND r.fork_of IS NULL), 0) <= ?3 - ?2))
    RETURNING storage_reserved_bytes AS stored_bytes";

pub(crate) const MAKE_PUBLIC: &str = "UPDATE repos SET is_private = 0 WHERE id = ?1 AND is_private = 1
    AND stored_bytes + storage_reserved_bytes <= ?2 - COALESCE((SELECT SUM(r.stored_bytes + r.storage_reserved_bytes) FROM repos r
        WHERE r.namespace = repos.namespace AND r.is_private = 0 AND r.fork_of IS NULL), 0)
    RETURNING id";

pub(crate) const TRANSFER: &str = "UPDATE repos SET namespace = ?2 WHERE id = ?1 AND namespace = ?3
    AND (is_private = 1 OR stored_bytes + storage_reserved_bytes <= ?4 - COALESCE((SELECT SUM(r.stored_bytes + r.storage_reserved_bytes) FROM repos r
        WHERE r.namespace = ?2 AND r.is_private = 0 AND r.fork_of IS NULL), 0))
    RETURNING id";

impl Registry {
    pub(crate) async fn copy_size(&self, repo: &Repo) -> Result<(u64, u64)> {
        #[derive(Deserialize)]
        struct Size { stored_bytes: f64, storage_reserved_bytes: f64 }
        let row = self.db.prepare("SELECT stored_bytes, storage_reserved_bytes FROM repos WHERE id = ?")
            .bind(&[repo.id.as_str().into()])?.first::<Size>(None).await?
            .ok_or_else(|| worker::Error::RustError("Copy source disappeared".into()))?;
        Ok((row.stored_bytes.max(0.0) as u64, row.storage_reserved_bytes.max(0.0) as u64))
    }
    pub(crate) async fn lock_copy(&self, source: &Repo, destination: &Repo) -> Result<bool> {
        #[derive(Deserialize)]
        struct Locked { #[serde(rename = "repo_id")] _id: String }
        Ok(self.db.prepare("INSERT INTO storage_copy_locks (repo_id, destination_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING RETURNING repo_id")
            .bind(&[source.id.as_str().into(), destination.id.as_str().into(), destination.created_at.as_str().into()])?
            .first::<Locked>(None).await?.is_some())
    }

    pub(crate) async fn unlock_copy(&self, source: &Repo, destination: &Repo) -> Result<()> {
        self.db.prepare("DELETE FROM storage_copy_locks WHERE repo_id = ?1 AND destination_id = ?2")
            .bind(&[source.id.as_str().into(), destination.id.as_str().into()])?.run().await?;
        Ok(())
    }
    pub(crate) async fn make_public(&self, repo: &Repo, cap: i64) -> Result<bool> {
        #[derive(Deserialize)]
        struct Changed { #[serde(rename = "id")] _id: String }
        let results = self.db.batch(vec![
            self.db.prepare(MAKE_PUBLIC).bind(&[repo.id.as_str().into(), (cap as f64).into()])?,
            self.db.prepare("UPDATE repos SET is_private = 0 WHERE fork_of = ?1 AND EXISTS (SELECT 1 FROM repos root WHERE root.id = ?1 AND root.is_private = 0)")
                .bind(&[repo.id.as_str().into()])?,
        ]).await?;
        Ok(!results[0].results::<Changed>()?.is_empty())
    }
    /// Reserves against the canonical root, also counting retained deleted
    /// repositories. Returns false when the workspace cannot fit the write.
    pub(crate) async fn reserve_public(&self, repo: &Repo, bytes: u64, cap: i64) -> Result<bool> {
        #[derive(Deserialize)]
        struct Reserved { #[serde(rename = "stored_bytes")] _bytes: f64 }
        let root = repo.fork_of.as_deref().unwrap_or(&repo.id);
        Ok(self.db.prepare(RESERVE)
            .bind(&[root.into(), (bytes as f64).into(), (cap as f64).into()])?
            .first::<Reserved>(None).await?.is_some())
    }

    pub(crate) async fn release_public(&self, repo: &Repo, bytes: u64) -> Result<()> {
        if bytes == 0 { return Ok(()); }
        let root = repo.fork_of.as_deref().unwrap_or(&repo.id);
        self.db.prepare("UPDATE repos SET storage_reserved_bytes = MAX(0, storage_reserved_bytes - ?2) WHERE id = ?1")
            .bind(&[root.into(), (bytes as f64).into()])?.run().await?;
        Ok(())
    }

    /// Convert admitted capacity to measured storage in one mutation.
    pub(crate) async fn finish_public(&self, repo: &Repo, reserved: u64, measured: u64) -> Result<()> {
        if measured > reserved { return Err(worker::Error::RustError("Push exceeded its storage reservation".into())); }
        let root = repo.fork_of.as_deref().unwrap_or(&repo.id);
        self.db.prepare("UPDATE repos SET stored_bytes = stored_bytes + ?3, storage_reserved_bytes = storage_reserved_bytes - ?2 WHERE id = ?1 AND storage_reserved_bytes >= ?2")
            .bind(&[root.into(), (reserved as f64).into(), (measured as f64).into()])?.run().await?;
        Ok(())
    }
}
