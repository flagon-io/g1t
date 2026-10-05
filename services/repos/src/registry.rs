//! Repository metadata in D1.

use std::cell::RefCell;
use std::collections::HashMap;

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
    protected: u8,
    created_at: String,
    /// Null only on rows written before the column existed and not yet
    /// migrated; their key is the one worked out from the path.
    #[serde(default)]
    store: Option<String>,
    /// JSON; absent on rows read before the column existed.
    #[serde(default)]
    topics: Option<String>,
}

thread_local! {
    /// Store keys that differ from the one a repository's path gives: those
    /// of repositories whose workspace was renamed after they were made.
    /// Filled whenever a row is read or written, so every `Repo` this
    /// service holds has its key here. A key never changes once given, so
    /// requests sharing the isolate can share the map.
    static MOVED: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

/// The key a repository's path gives: what every repository was stored
/// under before workspaces could be renamed.
pub fn path_key(repo: &Repo) -> String {
    format!("{}--{}", repo.namespace, repo.name)
}

/// Records where a repository is stored, when its path does not say.
pub fn remember_store(repo: &Repo, store: &str) {
    if store != path_key(repo) {
        MOVED.with(|moved| moved.borrow_mut().insert(repo.id.clone(), store.to_owned()));
    }
}

impl From<RepoRow> for Repo {
    fn from(row: RepoRow) -> Self {
        let repo = Repo {
            id: row.id,
            namespace: row.namespace,
            name: row.name,
            description: row.description,
            is_private: row.is_private != 0,
            owner_id: row.owner_id,
            default_branch: row.default_branch,
            fork_of: row.fork_of,
            protected: row.protected != 0,
            created_at: row.created_at,
            topics: row
                .topics
                .as_deref()
                .and_then(|topics| serde_json::from_str(topics).ok())
                .unwrap_or_default(),
        };
        if let Some(store) = &row.store {
            remember_store(&repo, store);
        }
        repo
    }
}

/// The key a repo is stored under in the git store.
pub fn store_key(repo: &Repo) -> String {
    MOVED
        .with(|moved| moved.borrow().get(&repo.id).cloned())
        .unwrap_or_else(|| path_key(repo))
}

/// Whether the viewer may read `repo`, going by the repository alone. A
/// private pull request fork is also readable by whoever can read the
/// repository it came from, which `Repos::may_read` checks.
pub fn can_read(repo: &Repo, viewer: &Viewer) -> bool {
    !repo.is_private || can_write(repo, viewer)
}

/// A repository belongs to its workspace, so any member may write to it. A
/// pull request's fork belongs to whoever opened the pull request.
pub fn can_write(repo: &Repo, viewer: &Viewer) -> bool {
    viewer.as_ref().is_some_and(|user| {
        if repo.fork_of.is_some() {
            user.id == repo.owner_id
        } else {
            user.is_member(&repo.namespace)
        }
    })
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

    pub async fn update(
        &self,
        id: &str,
        description: Option<&str>,
        is_private: bool,
        protected: bool,
        topics: &[String],
    ) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET description = ?, is_private = ?, protected = ?, topics = ? WHERE id = ?")
            .bind(&[
                description.map_or(JsValue::NULL, JsValue::from),
                u32::from(is_private).into(),
                u32::from(protected).into(),
                serde_json::to_string(topics)?.into(),
                id.into(),
            ])?
            .run()
            .await?;
        Ok(())
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

    /// Repos the viewer may see, newest first. Excludes pull request forks.
    /// With `member_only`, only repos in the viewer's own workspaces.
    pub async fn list(
        &self,
        viewer: &Viewer,
        query: Option<&str>,
        namespace: Option<&str>,
        member_only: bool,
    ) -> Result<Vec<Repo>> {
        let workspaces: Vec<&str> = viewer
            .iter()
            .flat_map(|user| &user.workspaces)
            .map(|membership| membership.slug.as_str())
            .collect();
        // An empty IN list is not valid SQL, so a viewer in no workspace
        // gets a name no workspace can have.
        let mut params: Vec<JsValue> = if workspaces.is_empty() {
            vec!["".into()]
        } else {
            workspaces.iter().map(|slug| JsValue::from(*slug)).collect()
        };
        let mine = format!("namespace IN ({})", vec!["?"; params.len()].join(", "));
        let mut conditions = vec![
            "fork_of IS NULL".to_owned(),
            if member_only {
                mine
            } else {
                format!("(is_private = 0 OR {mine})")
            },
        ];
        if let Some(namespace) = namespace {
            conditions.push("namespace = ?".to_owned());
            params.push(namespace.to_lowercase().into());
        }
        if let Some(query) = query.map(str::trim).filter(|query| !query.is_empty()) {
            conditions
                .push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')".to_owned());
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

    /// Of these ids, the repositories (not forks) the viewer may read.
    pub async fn readable(&self, ids: &[String], viewer: &Viewer) -> Result<Vec<Repo>> {
        let ids: Vec<&String> = ids.iter().take(g1t_contracts::repos::MAX_READABLE).collect();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        // One parameter however many ids: D1 binds at most 100.
        let rows = self
            .db
            .prepare(
                "SELECT * FROM repos
                 WHERE id IN (SELECT value FROM json_each(?)) AND fork_of IS NULL",
            )
            .bind(&[serde_json::to_string(&ids)?.into()])?
            .all()
            .await?
            .results::<RepoRow>()?;
        Ok(rows
            .into_iter()
            .map(Repo::from)
            .filter(|repo| can_read(repo, viewer))
            .collect())
    }

    /// The workspaces in which this account made a public repository.
    pub async fn public_namespaces(&self, owner_id: &str) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Row {
            namespace: String,
        }
        Ok(self
            .db
            .prepare(
                "SELECT DISTINCT namespace FROM repos
                 WHERE owner_id = ? AND is_private = 0 AND fork_of IS NULL
                 ORDER BY namespace",
            )
            .bind(&[owner_id.into()])?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| row.namespace)
            .collect())
    }

    /// Repositories that are not forks, by id, a page at a time.
    pub async fn ids_after(&self, after: Option<&str>, limit: u32) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Row {
            id: String,
        }
        Ok(self
            .db
            .prepare("SELECT id FROM repos WHERE fork_of IS NULL AND id > ? ORDER BY id LIMIT ?")
            .bind(&[after.unwrap_or("").into(), limit.into()])?
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| row.id)
            .collect())
    }

    /// Adds a pushed pack's bytes to what the repository is counted as
    /// holding: its own, or, for a pull request's working copy, the
    /// repository it is a copy of, whose storage it is.
    pub async fn add_stored_bytes(&self, repo: &Repo, bytes: u64) -> Result<()> {
        if bytes == 0 {
            return Ok(());
        }
        let root = repo.fork_of.as_deref().unwrap_or(&repo.id);
        self.db
            .prepare("UPDATE repos SET stored_bytes = stored_bytes + ? WHERE id = ?")
            .bind(&[(bytes as f64).into(), root.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Which of these `namespace/name` paths are private. A working copy
    /// answers as its repository. Unknown paths are left out.
    pub async fn visibility(&self, paths: &[String]) -> Result<Vec<g1t_contracts::repos::RepoVisibility>> {
        let mut out = Vec::new();
        for path in paths.iter().take(50) {
            let Some((namespace, name)) = path.split_once('/') else { continue };
            let Some(repo) = self
                .by_path(&RepoPath { namespace: namespace.to_owned(), name: name.to_owned() })
                .await?
            else {
                continue;
            };
            let is_private = match &repo.fork_of {
                Some(parent) => self.by_id(parent).await?.map_or(repo.is_private, |parent| parent.is_private),
                None => repo.is_private,
            };
            out.push(g1t_contracts::repos::RepoVisibility { path: path.clone(), is_private });
        }
        Ok(out)
    }

    /// What each workspace's repositories are counted as holding, private
    /// and public apart. Working copies count toward their repository.
    pub async fn storage(&self) -> Result<Vec<g1t_contracts::repos::WorkspaceStorage>> {
        #[derive(Deserialize)]
        struct Row {
            namespace: String,
            private_bytes: Option<f64>,
            public_bytes: Option<f64>,
        }
        Ok(self
            .db
            .prepare(
                "SELECT namespace,
                        SUM(CASE WHEN is_private = 1 THEN stored_bytes ELSE 0 END) AS private_bytes,
                        SUM(CASE WHEN is_private = 0 THEN stored_bytes ELSE 0 END) AS public_bytes
                 FROM repos WHERE fork_of IS NULL AND stored_bytes > 0 GROUP BY namespace",
            )
            .all()
            .await?
            .results::<Row>()?
            .into_iter()
            .map(|row| g1t_contracts::repos::WorkspaceStorage {
                namespace: row.namespace,
                private_bytes: row.private_bytes.unwrap_or(0.0) as i64,
                public_bytes: row.public_bytes.unwrap_or(0.0) as i64,
            })
            .collect())
    }

    /// Forgets a repository that could not be filled.
    pub async fn remove(&self, id: &str) -> Result<()> {
        self.db
            .prepare("DELETE FROM repos WHERE id = ?")
            .bind(&[id.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// Picks the store key for a repository about to be made, and
    /// remembers it: the one its path gives, unless a repository already
    /// holds that (one made in a workspace that has since been renamed,
    /// whose old name this workspace now has), when its id.
    pub async fn claim_store_key(&self, repo: &Repo) -> Result<String> {
        let wanted = path_key(repo);
        let held = self
            .db
            .prepare("SELECT 1 AS held FROM repos WHERE store = ?")
            .bind(&[wanted.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some();
        let key = if held { repo.id.clone() } else { wanted };
        remember_store(repo, &key);
        Ok(key)
    }

    /// Moves a renamed workspace's repositories to its current slug, from
    /// any of `stale`. A repository whose name the current slug already has
    /// (one pushed there in the moment before this ran) stays where it is;
    /// returns how many did.
    pub async fn rename_namespace(&self, stale: &[String], current: &str) -> Result<usize> {
        if stale.is_empty() {
            return Ok(0);
        }
        let marks = vec!["?"; stale.len()].join(", ");
        let mut moved: Vec<JsValue> = vec![current.into()];
        moved.extend(stale.iter().map(|slug| JsValue::from(slug.as_str())));
        let left: Vec<JsValue> = stale.iter().map(|slug| JsValue::from(slug.as_str())).collect();
        let results = self
            .db
            .batch(vec![
                self.db
                    .prepare(format!(
                        "UPDATE OR IGNORE repos SET namespace = ? WHERE namespace IN ({marks})"
                    ))
                    .bind(&moved)?,
                self.db
                    .prepare(format!(
                        "SELECT count(*) AS left FROM repos WHERE namespace IN ({marks})"
                    ))
                    .bind(&left)?,
            ])
            .await?;
        #[derive(Deserialize)]
        struct Left {
            left: usize,
        }
        Ok(results
            .get(1)
            .map(|result| result.results::<Left>())
            .transpose()?
            .and_then(|rows| rows.into_iter().next())
            .map_or(0, |row| row.left))
    }

    pub async fn insert(&self, repo: &Repo) -> Result<()> {
        self.db
            .prepare(
                "INSERT INTO repos
                   (id, namespace, name, description, is_private, owner_id,
                    default_branch, fork_of, created_at, store)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                store_key(repo).into(),
            ])?
            .run()
            .await?;
        Ok(())
    }
}
