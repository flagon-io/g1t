//! Repository metadata in D1.

use g1t_contracts::Viewer;
use g1t_contracts::repos::{Repo, RepoPath};
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, Result};

#[derive(Deserialize)]
struct RepoRow {
    id: String,
    namespace: String,
    name: String,
    description: Option<String>,
    is_private: u8,
    owner_id: String,
    default_branch: String,
    fork_of: Option<String>,
    created_at: String,
}

impl From<RepoRow> for Repo {
    fn from(row: RepoRow) -> Self {
        Repo {
            id: row.id,
            namespace: row.namespace,
            name: row.name,
            description: row.description,
            is_private: row.is_private != 0,
            owner_id: row.owner_id,
            default_branch: row.default_branch,
            fork_of: row.fork_of,
            created_at: row.created_at,
        }
    }
}

/// The key a repo is stored under in the git store.
pub fn store_key(repo: &Repo) -> String {
    format!("{}--{}", repo.namespace, repo.name)
}

pub fn can_read(repo: &Repo, viewer: &Viewer) -> bool {
    !repo.is_private || can_write(repo, viewer)
}

pub fn can_write(repo: &Repo, viewer: &Viewer) -> bool {
    viewer.as_ref().is_some_and(|user| user.id == repo.owner_id)
}

fn optional(value: &Option<String>) -> JsValue {
    value.as_deref().map_or(JsValue::NULL, JsValue::from)
}

pub struct Registry {
    pub db: D1Database,
}

impl Registry {
    pub async fn by_path(&self, path: &RepoPath) -> Result<Option<Repo>> {
        Ok(self
            .db
            .prepare("SELECT * FROM repos WHERE namespace = ? AND name = ?")
            .bind(&[
                path.namespace.to_lowercase().into(),
                path.name.to_lowercase().into(),
            ])?
            .first::<RepoRow>(None)
            .await?
            .map(Repo::from))
    }

    pub async fn by_id(&self, id: &str) -> Result<Option<Repo>> {
        Ok(self
            .db
            .prepare("SELECT * FROM repos WHERE id = ?")
            .bind(&[id.into()])?
            .first::<RepoRow>(None)
            .await?
            .map(Repo::from))
    }

    /// Repos the viewer may see, newest first. Excludes attempt forks.
    pub async fn list(
        &self,
        viewer: &Viewer,
        query: Option<&str>,
        namespace: Option<&str>,
    ) -> Result<Vec<Repo>> {
        let mut conditions = vec!["fork_of IS NULL", "(is_private = 0 OR owner_id = ?)"];
        let viewer_id = viewer.as_ref().map_or("", |user| user.id.as_str());
        let mut params: Vec<JsValue> = vec![viewer_id.into()];
        if let Some(namespace) = namespace {
            conditions.push("namespace = ?");
            params.push(namespace.to_lowercase().into());
        }
        if let Some(query) = query.map(str::trim).filter(|query| !query.is_empty()) {
            conditions.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
            // LIKE wildcards in the query are matched literally.
            let escaped: String = query
                .chars()
                .flat_map(|c| match c {
                    '\\' | '%' | '_' => vec!['\\', c],
                    _ => vec![c],
                })
                .collect();
            let pattern = format!("%{escaped}%");
            params.push(pattern.as_str().into());
            params.push(pattern.into());
        }
        let sql = format!(
            "SELECT * FROM repos WHERE {} ORDER BY created_at DESC, id DESC LIMIT 50",
            conditions.join(" AND ")
        );
        let rows = self
            .db
            .prepare(sql)
            .bind(&params)?
            .all()
            .await?
            .results::<RepoRow>()?;
        Ok(rows.into_iter().map(Repo::from).collect())
    }

    pub async fn insert(&self, repo: &Repo) -> Result<()> {
        self.db
            .prepare(
                "INSERT INTO repos
                   (id, namespace, name, description, is_private, owner_id,
                    default_branch, fork_of, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                repo.id.as_str().into(),
                repo.namespace.as_str().into(),
                repo.name.as_str().into(),
                optional(&repo.description),
                (repo.is_private as u8).into(),
                repo.owner_id.as_str().into(),
                repo.default_branch.as_str().into(),
                optional(&repo.fork_of),
                repo.created_at.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(())
    }
}
