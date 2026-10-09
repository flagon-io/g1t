//! Repository metadata in D1.

use std::cell::RefCell;
use std::collections::HashMap;

use g1t_contracts::Viewer;
use g1t_contracts::access::{self, Capability, RepoRole};
use g1t_contracts::repos::{Repo, RepoPath};
use serde::Deserialize;
use worker::wasm_bindgen::JsValue;
use worker::{D1Database, Result};

#[derive(Deserialize)]
pub(crate) struct RepoRow {
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
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    archived_at: Option<String>,
    /// JSON `RepoMirror`; absent on rows read before the column existed.
    #[serde(default)]
    mirror: Option<String>,
    #[serde(default)]
    deleted_at: Option<String>,
    /// Bumped by everything that changes the repository's refs; see
    /// [`RefsState`]. Absent on rows read before the column existed.
    #[serde(default)]
    refs_version: Option<f64>,
    #[serde(default)]
    refs_open_until: Option<f64>,
    /// A pull request working copy whose git data was removed, and the
    /// head it had (forks.rs). Absent before the columns existed.
    #[serde(default)]
    retired_at: Option<String>,
    #[serde(default)]
    retired_head: Option<String>,
    /// Until when writes wait, and why: a move between namespaces
    /// (moves.rs). Absent before the columns existed.
    #[serde(default)]
    writes_paused_until: Option<f64>,
    #[serde(default)]
    writes_paused_for: Option<String>,
}

thread_local! {
    /// Repositories whose writes wait, by id: until when, and why. Filled
    /// whenever a row is read.
    static PAUSED: RefCell<HashMap<String, (u64, String)>> = RefCell::new(HashMap::new());
}

/// Records whether writes to the repository with this id wait, as its row says.
pub fn note_paused(id: &str, until: Option<u64>, reason: Option<&str>) {
    PAUSED.with(|paused| {
        let mut paused = paused.borrow_mut();
        match until {
            Some(until) => {
                paused.insert(id.to_owned(), (until, reason.unwrap_or("maintenance").to_owned()));
            }
            None => {
                paused.remove(id);
            }
        }
    });
}

/// Why writes to the repository with this id wait at `now`, if they do, as
/// its row last read here said.
pub fn paused(id: &str, now: u64) -> Option<String> {
    PAUSED.with(|paused| paused.borrow().get(id).filter(|(until, _)| *until > now).map(|(_, reason)| reason.clone()))
}

/// Where a repository's refs stand, as its row last said: `version` goes up
/// with every change g1t makes to them, so an answer that lists them (see
/// refs_cache.rs) is kept under the version it was made at, and a change
/// leaves it behind. Until `open_until` (milliseconds) a credential that
/// can change them is out of g1t's hands, and nothing is kept.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RefsState {
    pub version: u64,
    pub open_until: u64,
}

/// The newest [`RefsState`] this isolate has read or written, by
/// repository id. A version only goes up, so an older read finishing late
/// never takes a newer one back.
#[derive(Default)]
pub struct RefsStates {
    states: HashMap<String, RefsState>,
}

impl RefsStates {
    pub fn note(&mut self, id: &str, state: RefsState) {
        let kept = self.states.entry(id.to_owned()).or_default();
        kept.version = kept.version.max(state.version);
        kept.open_until = kept.open_until.max(state.open_until);
    }

    pub fn get(&self, id: &str) -> Option<RefsState> {
        self.states.get(id).copied()
    }
}

thread_local! {
    static REFS: RefCell<RefsStates> = RefCell::new(RefsStates::default());
}

/// Where the refs of the repository with this id stand, as this isolate
/// last read them; `None` before the column existed or before its row was
/// read here.
pub fn refs_state(id: &str) -> Option<RefsState> {
    REFS.with(|refs| refs.borrow().get(id))
}

fn note_refs(id: &str, version: Option<f64>, open_until: Option<f64>) {
    if let Some(version) = version {
        let state = RefsState {
            version: version as u64,
            open_until: open_until.unwrap_or(0.0) as u64,
        };
        REFS.with(|refs| refs.borrow_mut().note(id, state));
    }
}

thread_local! {
    /// Working copies whose git data was removed, by id, with the head
    /// each had (forks.rs). Filled whenever a row is read.
    static RETIRED: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

/// The head a removed working copy had, if the repository with this id is one.
pub fn retired(id: &str) -> Option<String> {
    RETIRED.with(|retired| retired.borrow().get(id).cloned())
}

/// Records whether the repository with this id is a removed working copy.
pub fn note_retired(id: &str, head: Option<&str>) {
    RETIRED.with(|retired| {
        let mut retired = retired.borrow_mut();
        match head {
            Some(head) => {
                retired.insert(id.to_owned(), head.to_owned());
            }
            None => {
                retired.remove(id);
            }
        }
    });
}

thread_local! {
    /// Store keys that differ from the one a repository's path gives: those
    /// of repositories whose workspace was renamed after they were made.
    /// Filled whenever a row is read or written, so every `Repo` this
    /// service holds has its key here. A key changes only when a move
    /// between namespaces switches it (moves.rs), and every row read
    /// after that brings the new one, so requests sharing the isolate can
    /// share the map.
    static MOVED: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

/// How long a fetch may go by a repository's row as it was read a moment
/// ago: a clone is two or three requests in quick succession, and each
/// would otherwise read the same row. Short enough that making a repository
/// private, archiving or deleting it applies within seconds.
pub const RECENT_MS: u64 = 5_000;

/// Repositories read in the last [`RECENT_MS`], by path. Only rows that
/// were found are kept, so a repository just made is never missed.
#[derive(Default)]
pub struct Recent {
    rows: HashMap<(String, String), (Repo, u64)>,
}

impl Recent {
    fn key(path: &RepoPath) -> (String, String) {
        (path.namespace.to_lowercase(), path.name.to_lowercase())
    }

    pub fn get(&self, path: &RepoPath, now: u64) -> Option<Repo> {
        self.rows
            .get(&Self::key(path))
            .filter(|(_, read)| now.saturating_sub(*read) < RECENT_MS)
            .map(|(repo, _)| repo.clone())
    }

    pub fn keep(&mut self, path: &RepoPath, repo: &Repo, now: u64) {
        self.rows.retain(|_, (_, read)| now.saturating_sub(*read) < RECENT_MS);
        self.rows.insert(Self::key(path), (repo.clone(), now));
    }
}

thread_local! {
    static RECENT: RefCell<Recent> = RefCell::new(Recent::default());
}

/// The key a repository's path gives: what every repository was stored
/// under before workspaces could be renamed.
pub fn path_key(repo: &Repo) -> String {
    format!("{}--{}", repo.namespace, repo.name)
}

/// Records where a repository is stored, when its path does not say. A
/// key changes when the repository moves between namespaces (moves.rs),
/// so one that is the path's again is forgotten.
pub fn remember_store(repo: &Repo, store: &str) {
    MOVED.with(|moved| {
        let mut moved = moved.borrow_mut();
        if store != path_key(repo) {
            moved.insert(repo.id.clone(), store.to_owned());
        } else {
            moved.remove(&repo.id);
        }
    });
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
            website: row.website,
            archived_at: row.archived_at,
            mirror: row.mirror.as_deref().and_then(|mirror| serde_json::from_str(mirror).ok()),
        };
        if let Some(store) = &row.store {
            remember_store(&repo, store);
        }
        note_refs(&repo.id, row.refs_version, row.refs_open_until);
        note_retired(&repo.id, row.retired_at.as_ref().and(row.retired_head.as_deref()));
        note_paused(&repo.id, row.writes_paused_until.map(|until| until as u64), row.writes_paused_for.as_deref());
        repo
    }
}

/// The key a repo is stored under in the git store.
pub fn store_key(repo: &Repo) -> String {
    let key = MOVED
        .with(|moved| moved.borrow().get(&repo.id).cloned())
        .unwrap_or_else(|| path_key(repo));
    // Its interactions with the store are metered for its workspace.
    crate::meters::note_owner(&key, &repo.namespace);
    key
}

/// The viewer's role on `repo` (see `g1t_contracts::access`): ownership of
/// its workspace, the workspace's base permission, a direct grant, or
/// Read on a public repository. A pull request's fork is its author's to
/// write; whoever can read the repository it came from can read it too,
/// which `Repos::may_read` checks.
pub fn role(repo: &Repo, viewer: &Viewer) -> Option<RepoRole> {
    if repo.fork_of.is_some() {
        let author = viewer.as_ref().is_some_and(|user| user.id == repo.owner_id);
        return if author {
            Some(RepoRole::Write)
        } else if repo.is_private {
            None
        } else {
            Some(RepoRole::Read)
        };
    }
    access::permission(viewer.as_ref(), repo)
}

/// Whether the viewer may read `repo`, going by the repository alone.
pub fn can_read(repo: &Repo, viewer: &Viewer) -> bool {
    role(repo, viewer).is_some()
}

/// Whether the viewer may push to `repo`: Write or higher, or the author
/// of a pull request's fork.
pub fn can_write(repo: &Repo, viewer: &Viewer) -> bool {
    can(repo, viewer, Capability::Push)
}

/// Whether the viewer may do `capability` in `repo`. A fork has only its
/// author's Write.
pub fn can(repo: &Repo, viewer: &Viewer, capability: Capability) -> bool {
    if repo.fork_of.is_some() {
        return role(repo, viewer).is_some_and(|role| access::allows(role, capability))
            && !access::OWNER_ONLY.contains(&capability);
    }
    access::can(viewer.as_ref(), repo, capability)
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
            .prepare("SELECT * FROM repos WHERE namespace = ? AND name = ? AND deleted_at IS NULL")
            .bind(&[
                path.namespace.to_lowercase().into(),
                path.name.to_lowercase().into(),
            ])?
            .first::<RepoRow>(None)
            .await?
            .map(Repo::from))
    }

    /// The repository at `path`, as read in the last few seconds if it was
    /// (see [`RECENT_MS`]). For fetches only: a push always reads the row.
    pub async fn by_path_recent(&self, path: &RepoPath) -> Result<Option<Repo>> {
        let now = g1t_kit::now_ms();
        if let Some(repo) = RECENT.with(|recent| recent.borrow().get(path, now)) {
            return Ok(Some(repo));
        }
        let found = self.by_path(path).await?;
        if let Some(repo) = &found {
            RECENT.with(|recent| recent.borrow_mut().keep(path, repo, now));
        }
        Ok(found)
    }

    /// Its details; who can see it changes with `set_private`.
    pub async fn update(
        &self,
        id: &str,
        description: Option<&str>,
        protected: bool,
        topics: &[String],
        website: Option<&str>,
    ) -> Result<()> {
        self.db
            .prepare("UPDATE repos SET description = ?, protected = ?, topics = ?, website = ? WHERE id = ?")
            .bind(&[
                description.map_or(JsValue::NULL, JsValue::from),
                u32::from(protected).into(),
                serde_json::to_string(topics)?.into(),
                website.map_or(JsValue::NULL, JsValue::from),
                id.into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn by_id(&self, id: &str) -> Result<Option<Repo>> {
        Ok(self
            .db
            .prepare("SELECT * FROM repos WHERE id = ? AND deleted_at IS NULL")
            .bind(&[id.into()])?
            .first::<RepoRow>(None)
            .await?
            .map(Repo::from))
    }

    /// The repository at `path`, deleted or not: what holds the name.
    pub async fn by_path_any(&self, path: &RepoPath) -> Result<Option<(Repo, Option<String>)>> {
        Ok(self
            .db
            .prepare("SELECT * FROM repos WHERE namespace = ? AND name = ?")
            .bind(&[
                path.namespace.to_lowercase().into(),
                path.name.to_lowercase().into(),
            ])?
            .first::<RepoRow>(None)
            .await?
            .map(|mut row| {
                let deleted_at = row.deleted_at.take();
                (Repo::from(row), deleted_at)
            }))
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
        // The workspaces whose private repositories the viewer reads all
        // of (an owner, or a base permission other than none), and the
        // repositories they were given a role on: see access.rs. A probe
        // repository in each workspace stands for all of them.
        let reading: Vec<&str> = viewer
            .iter()
            .flat_map(|user| {
                user.workspaces.iter().filter(move |membership| {
                    let probe = access::RepoRef { id: "", namespace: &membership.slug, private: true };
                    access::granted(user, probe).is_some()
                })
            })
            .map(|membership| membership.slug.as_str())
            .collect();
        let mut granted: Vec<&str> = viewer
            .iter()
            .flat_map(|user| {
                let token = user.token.as_deref();
                user.grants
                    .iter()
                    .filter(move |grant| token.is_none_or(|token| token.covers_repo(&grant.repo_id, &grant.workspace)))
            })
            .map(|grant| grant.repo_id.as_str())
            .collect();
        // A fine-grained token's selected repositories, where its owner's
        // membership reaches them.
        if let Some(user) = viewer.as_ref()
            && let Some(reach) = user.token.as_deref().and_then(|token| token.fine_grained.as_ref())
            && let Some(workspace) = reach.workspace.as_deref()
        {
            granted.extend(
                reach
                    .repo_ids
                    .iter()
                    .filter(|id| access::granted(user, access::RepoRef { id, namespace: workspace, private: true }).is_some())
                    .map(String::as_str),
            );
        }
        let mut params: Vec<JsValue> = vec![
            serde_json::to_string(&reading)?.into(),
            serde_json::to_string(&granted)?.into(),
        ];
        let private_ok = "(namespace IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?)))";
        let mut conditions = vec![
            "fork_of IS NULL AND deleted_at IS NULL".to_owned(),
            format!("(is_private = 0 OR {private_ok})"),
        ];
        if member_only {
            conditions.push("namespace IN (SELECT value FROM json_each(?))".to_owned());
            params.push(serde_json::to_string(&workspaces)?.into());
        }
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
                 WHERE id IN (SELECT value FROM json_each(?)) AND fork_of IS NULL AND deleted_at IS NULL",
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
                 WHERE owner_id = ? AND is_private = 0 AND fork_of IS NULL AND deleted_at IS NULL
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
    /// Repositories that are not forks, with who created each, by id after
    /// `after`.
    pub async fn creators_after(&self, after: Option<&str>, limit: u32) -> Result<Vec<g1t_contracts::repos::RepoCreator>> {
        self.db
            .prepare(
                "SELECT id, namespace, name, owner_id FROM repos
                 WHERE fork_of IS NULL AND deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?",
            )
            .bind(&[after.unwrap_or("").into(), limit.into()])?
            .all()
            .await?
            .results::<g1t_contracts::repos::RepoCreator>()
    }

    pub async fn ids_after(&self, after: Option<&str>, limit: u32) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Row {
            id: String,
        }
        Ok(self
            .db
            .prepare("SELECT id FROM repos WHERE fork_of IS NULL AND deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?")
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
                 FROM repos WHERE fork_of IS NULL AND deleted_at IS NULL AND stored_bytes > 0 GROUP BY namespace",
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

    /// What one workspace's private repositories are counted as holding.
    pub async fn private_bytes(&self, namespace: &str) -> Result<i64> {
        #[derive(Deserialize)]
        struct Row {
            bytes: Option<f64>,
        }
        Ok(self
            .db
            .prepare("SELECT SUM(stored_bytes) AS bytes FROM repos WHERE namespace = ? AND is_private = 1 AND fork_of IS NULL AND deleted_at IS NULL")
            .bind(&[namespace.into()])?
            .first::<Row>(None)
            .await?
            .and_then(|row| row.bytes)
            .unwrap_or(0.0) as i64)
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
    ///
    /// `namespace` is the git store namespace it goes in (shards.rs), or
    /// `None` for the default, `default`. A name is taken in any of them.
    pub async fn claim_store_key(&self, repo: &Repo, namespace: Option<&str>, default: &str) -> Result<String> {
        let wanted = path_key(repo);
        let held = self
            .db
            .prepare(
                "SELECT 1 AS held FROM repos
                 WHERE store = ?1 OR (instr(store, '/') > 0 AND substr(store, instr(store, '/') + 1) = ?1)
                 UNION ALL
                 SELECT 1 AS held FROM repo_move_copies WHERE name = ?1 AND cleaned_ms IS NULL",
            )
            .bind(&[wanted.as_str().into()])?
            .first::<serde_json::Value>(None)
            .await?
            .is_some();
        let name = if held { repo.id.clone() } else { wanted };
        let key = crate::shards::compose(namespace, &name, default);
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
                // Git operations follow the workspace, added together.
                self.db
                    .prepare(format!(
                        "INSERT INTO git_operations (namespace, hour, operations)
                         SELECT ?, hour, SUM(operations) FROM git_operations WHERE namespace IN ({marks}) GROUP BY hour
                         ON CONFLICT (namespace, hour) DO UPDATE SET operations = git_operations.operations + excluded.operations"
                    ))
                    .bind(&moved)?,
                self.db
                    .prepare(format!("DELETE FROM git_operations WHERE namespace IN ({marks})"))
                    .bind(&left)?,
                // Paths repositories were transferred away from follow the
                // workspace too, so the old slug's redirect then finds them.
                self.db
                    .prepare(format!(
                        "UPDATE OR IGNORE repo_redirects SET namespace = ? WHERE namespace IN ({marks})"
                    ))
                    .bind(&moved)?,
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

    /// Records that the refs of the repository with this id changed, after
    /// they did: what anything that lists them keeps goes stale.
    pub async fn refs_moved(&self, id: &str) -> Result<()> {
        self.bump_refs(
            "UPDATE repos SET refs_version = refs_version + 1 WHERE id = ?
             RETURNING refs_version, refs_open_until",
            &[id.into()],
            id,
        )
        .await
    }

    /// Records that a credential able to change the refs of the repository
    /// with this id was handed out of g1t's hands, until `until`
    /// (milliseconds): until then, nothing that lists them is kept.
    pub async fn refs_open(&self, id: &str, until: u64) -> Result<()> {
        self.bump_refs(
            "UPDATE repos SET refs_version = refs_version + 1,
               refs_open_until = max(coalesce(refs_open_until, 0), ?)
             WHERE id = ? RETURNING refs_version, refs_open_until",
            &[(until as f64).into(), id.into()],
            id,
        )
        .await
    }

    async fn bump_refs(&self, sql: &str, params: &[JsValue], id: &str) -> Result<()> {
        #[derive(Deserialize)]
        struct Bumped {
            refs_version: Option<f64>,
            refs_open_until: Option<f64>,
        }
        let bumped = self
            .db
            .prepare(sql)
            .bind(params)?
            .first::<Bumped>(None)
            .await?;
        if let Some(bumped) = bumped {
            note_refs(id, bumped.refs_version, bumped.refs_open_until);
        }
        Ok(())
    }

    pub async fn insert(&self, repo: &Repo) -> Result<()> {
        self.db
            .prepare(
                "INSERT INTO repos
                   (id, namespace, name, description, is_private, owner_id,
                    default_branch, fork_of, created_at, store, mirror)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                repo.mirror
                    .as_ref()
                    .and_then(|mirror| serde_json::to_string(mirror).ok())
                    .map_or(JsValue::NULL, JsValue::from),
            ])?
            .run()
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use g1t_contracts::access::{BasePermission, RepoGrant};
    use g1t_contracts::{Membership, Role, User};

    #[test]
    fn the_refs_state_kept_only_moves_forward() {
        let mut states = RefsStates::default();
        assert_eq!(states.get("rep_1"), None);
        states.note("rep_1", RefsState { version: 3, open_until: 0 });
        // A read that started before a bump and finished after it.
        states.note("rep_1", RefsState { version: 2, open_until: 0 });
        assert_eq!(states.get("rep_1").unwrap().version, 3);
        states.note("rep_1", RefsState { version: 4, open_until: 9_000 });
        states.note("rep_1", RefsState { version: 5, open_until: 0 });
        assert_eq!(states.get("rep_1"), Some(RefsState { version: 5, open_until: 9_000 }));
        assert_eq!(states.get("rep_2"), None);
    }

    #[test]
    fn a_row_from_before_the_column_has_no_refs_state() {
        let row = |version: Option<f64>| RepoRow {
            id: format!("rep_row_{}", version.is_some()),
            namespace: "acme".into(),
            name: "rocket".into(),
            description: None,
            is_private: 0,
            owner_id: "usr_owner".into(),
            default_branch: "main".into(),
            fork_of: None,
            protected: 0,
            created_at: String::new(),
            store: None,
            topics: None,
            website: None,
            archived_at: None,
            mirror: None,
            deleted_at: None,
            refs_version: version,
            refs_open_until: None,
            retired_at: None,
            retired_head: None,
            writes_paused_until: None,
            writes_paused_for: None,
        };
        let old = Repo::from(row(None));
        assert_eq!(refs_state(&old.id), None);
        let new = Repo::from(row(Some(7.0)));
        assert_eq!(refs_state(&new.id), Some(RefsState { version: 7, open_until: 0 }));
    }

    #[test]
    fn a_removed_working_copy_is_known_by_its_row() {
        note_retired("rep_fork", Some("abc"));
        assert_eq!(retired("rep_fork").as_deref(), Some("abc"));
        note_retired("rep_fork", None);
        assert_eq!(retired("rep_fork"), None);
    }

    #[test]
    fn a_repository_read_a_moment_ago_is_reused_for_a_few_seconds() {
        let mut recent = Recent::default();
        let path = RepoPath {
            namespace: "Acme".into(),
            name: "Rocket".into(),
        };
        recent.keep(&path, &repo(false), 1_000);
        // Paths are matched as the table matches them, ignoring case.
        let lower = RepoPath {
            namespace: "acme".into(),
            name: "rocket".into(),
        };
        assert_eq!(recent.get(&lower, 1_000 + RECENT_MS - 1).unwrap().id, "rep_1");
        assert!(recent.get(&lower, 1_000 + RECENT_MS).is_none());
        let other = RepoPath {
            namespace: "acme".into(),
            name: "booster".into(),
        };
        assert!(recent.get(&other, 1_000).is_none());
        // Keeping another later drops the stale row.
        recent.keep(&other, &repo(true), 1_000 + RECENT_MS);
        assert_eq!(recent.rows.len(), 1);
    }

    fn repo(private: bool) -> Repo {
        Repo {
            id: "rep_1".into(),
            namespace: "acme".into(),
            name: "rocket".into(),
            description: None,
            is_private: private,
            owner_id: "usr_owner".into(),
            default_branch: "main".into(),
            fork_of: None,
            protected: false,
            created_at: String::new(),
            topics: Vec::new(),
            website: None,
            archived_at: None,
            mirror: None,
        }
    }

    fn person(id: &str, memberships: Vec<Membership>, grants: Vec<(&str, RepoRole)>) -> Viewer {
        Some(User {
            id: id.into(),
            username: id.into(),
            verified: true,
            workspaces: memberships,
            grants: grants
                .into_iter()
                .map(|(repo_id, role)| RepoGrant { repo_id: repo_id.into(), workspace: "acme".into(), role, team: None })
                .collect(),
            ..User::default()
        })
    }

    /// What git asks: clone and fetch need Read on a private repository,
    /// push needs Write.
    #[test]
    fn git_reads_with_read_and_pushes_with_write() {
        let private = repo(true);
        let reader = person("usr_r", vec![], vec![("rep_1", RepoRole::Read)]);
        assert!(can_read(&private, &reader));
        assert!(!can_write(&private, &reader));
        let writer = person("usr_w", vec![], vec![("rep_1", RepoRole::Write)]);
        assert!(can_read(&private, &writer) && can_write(&private, &writer));
        let stranger = person("usr_s", vec![], vec![("rep_2", RepoRole::Admin)]);
        assert!(!can_read(&private, &stranger) && !can_write(&private, &stranger));
        assert!(!can_read(&private, &None));
        // A public repository: anyone clones, nobody without Write pushes.
        let public = repo(false);
        assert!(can_read(&public, &None) && !can_write(&public, &None));
        assert!(can_read(&public, &stranger) && !can_write(&public, &stranger));
    }

    #[test]
    fn members_follow_the_base_permission_and_owners_have_admin() {
        let private = repo(true);
        let default_member = person("usr_m", vec![Membership::member("acme")], vec![]);
        assert!(can_write(&private, &default_member));
        assert!(!can(&private, &default_member, Capability::ManageIntegrations));
        let none = Membership { base_permission: Some(BasePermission::None), ..Membership::member("acme") };
        let locked_out = person("usr_n", vec![none.clone()], vec![]);
        assert!(!can_read(&private, &locked_out));
        let given = person("usr_g", vec![none], vec![("rep_1", RepoRole::Triage)]);
        assert!(can_read(&private, &given) && !can_write(&private, &given));
        let owner = person("usr_o", vec![Membership { role: Role::Owner, ..Membership::member("acme") }], vec![]);
        assert_eq!(role(&private, &owner), Some(RepoRole::Admin));
        assert!(can(&private, &owner, Capability::Delete));
    }

    #[test]
    fn a_pull_requests_fork_is_its_authors() {
        let fork = Repo {
            namespace: "pulls".into(),
            fork_of: Some("rep_1".into()),
            owner_id: "usr_a".into(),
            ..repo(true)
        };
        let author = person("usr_a", vec![], vec![]);
        assert!(can_write(&fork, &author));
        assert!(!can(&fork, &author, Capability::ManageSettings));
        let other = person("usr_b", vec![Membership::member("acme")], vec![]);
        assert!(!can_write(&fork, &other));
    }
}
