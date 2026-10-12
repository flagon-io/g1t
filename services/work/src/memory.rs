//! Memory: what agents and people have learned that the next agent should
//! know, at two levels. A project's memory is about its codebase; the
//! workspace's is true across its projects ("we use pnpm everywhere",
//! "staging lives at …").
//!
//! A workspace's memory is members-only, since it can hold internal
//! knowledge; a project's is for whoever can read the project, and changed
//! by whoever can push to it. It never holds a secret: text that looks like a key or a token is refused.
//! Agents read it with `recall` and add to it with `remember` (MCP), and
//! people manage it on the Memory pages.

use g1t_contracts::access::{self, Capability};
use g1t_contracts::agents::*;
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, User, Viewer, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;

/// A workspace renamed: its runs and memories move to the slug it has now.
/// `?1` is the current slug, `?2` a stale one (see `g1t_kit::rename`).
pub(crate) const RENAMED: &[&str] = &[
    "UPDATE agent_runs SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE agent_runs SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
    "UPDATE memories SET scope_key = ?1 WHERE scope = 'workspace' AND scope_key = ?2",
    "UPDATE memories SET workspace = ?1 WHERE workspace = ?2",
    "UPDATE memories SET repo = ?1 || substr(repo, length(?2) + 1) WHERE substr(repo, 1, length(?2) + 1) = ?2 || '/'",
    "UPDATE memories SET source_repo = ?1 || substr(source_repo, length(?2) + 1) WHERE substr(source_repo, 1, length(?2) + 1) = ?2 || '/'",
];

/// A repository transferred (see `g1t_kit::transfer`): its agent runs and
/// its project's memory go with it, as its issues and pull requests do by
/// id. `?1`/`?2` the path now and before, `?3`/`?4` the workspaces, `?5`
/// the repository's id.
pub(crate) const TRANSFERRED: &[&str] = &[
    "UPDATE agent_runs SET workspace = ?3, repo = ?1 WHERE repo_id = ?5 AND repo = ?2",
    "UPDATE memories SET workspace = ?3, repo = ?1 WHERE scope = 'project' AND scope_key = ?5 AND workspace = ?4",
    "UPDATE memories SET source_repo = ?1 WHERE source_repo = ?2",
];

/// A workspace deleted: its own memory, guardrails and queued runs go.
/// `?1` is its slug. Project memory went with each repository's transfer.
pub(crate) const DELETED: &[&str] = &[
    "DELETE FROM memories WHERE scope = 'workspace' AND scope_key = ?1",
    "DELETE FROM guardrails WHERE scope = 'workspace' AND scope_key = ?1",
];

/// The most memories one project, or one workspace, keeps.
const MAX_PER_SCOPE: u32 = 500;
const DEFAULT_RECALL: u32 = 20;

#[derive(Deserialize)]
pub(crate) struct MemoryRow {
    id: String,
    pub(crate) scope: String,
    workspace: String,
    repo: Option<String>,
    text: String,
    kind: String,
    source_kind: String,
    source_run: Option<String>,
    source_repo: Option<String>,
    source_number: Option<u32>,
    created_by: String,
    pinned: u32,
    created_at: String,
    updated_at: String,
    last_used_at: Option<String>,
    // What automatic capture added (migration 0019); read for memories
    // kept from before it was removed.
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    source_ref: Option<String>,
    #[serde(default)]
    evidence: Option<String>,
    #[serde(default)]
    sources: Option<String>,
}

fn path(text: &str) -> Option<RepoPath> {
    let (namespace, name) = text.split_once('/')?;
    Some(RepoPath {
        namespace: namespace.to_owned(),
        name: name.to_owned(),
    })
}

impl From<MemoryRow> for Memory {
    fn from(row: MemoryRow) -> Self {
        Memory {
            id: row.id,
            scope: if row.scope == "workspace" {
                MemoryScope::Workspace
            } else {
                MemoryScope::Project
            },
            workspace: row.workspace,
            repo: row.repo.as_deref().and_then(path),
            text: row.text,
            kind: MemoryKind::parse(&row.kind).unwrap_or_default(),
            source: MemorySource {
                kind: row.source_kind,
                run_id: row.source_run,
                repo: row.source_repo.as_deref().and_then(path),
                number: row.source_number,
                reference: row.source_ref,
                evidence: row.evidence,
            },
            created_by: row.created_by,
            pinned: row.pinned != 0,
            created_at: row.created_at,
            updated_at: row.updated_at,
            last_used_at: row.last_used_at,
            status: row.status.as_deref().and_then(MemoryStatus::parse).unwrap_or_default(),
            confidence: row.confidence,
            seen: row
                .sources
                .as_deref()
                .and_then(|sources| serde_json::from_str::<Vec<String>>(sources).ok())
                .map_or(1, |sources| sources.len().max(1) as u32),
        }
    }
}

/// The text tidied, or why it cannot be kept.
fn valid_text(text: &str) -> std::result::Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Write what should be remembered.".into());
    }
    if text.chars().count() > MAX_MEMORY_CHARS {
        return Err(format!(
            "Keep a memory to {MAX_MEMORY_CHARS} characters: one fact, convention, decision or gotcha each."
        ));
    }
    if let Some(what) = secret_in(text) {
        return Err(format!(
            "That looks like {what}. Memory is read by every agent in the workspace, so it never holds secrets. Say where the secret lives instead, such as \"the deploy key is the DEPLOY_KEY secret\"."
        ));
    }
    Ok(text.to_owned())
}

/// Why a person cannot change a memory.
const CHANGE_DENIED: &str = "Only members of the workspace can change its memory, and a project's only with the Write role on it.";

fn denied<T>() -> Outcome<T> {
    Outcome::fail(
        FailureCode::Forbidden,
        "Memory is for members of the workspace and its agents.",
    )
}

/// Whether `actor` may change a memory of `workspace`: the workspace's own
/// needs a member; a project's (`repo_id`, its repository) the Write role
/// on that repository, as pushing to it does.
fn may_write(actor: &User, workspace: &str, repo_id: Option<&str>) -> bool {
    let able = actor.verified || actor.kind != PrincipalKind::User;
    able && match repo_id {
        None => actor.is_member(workspace),
        // Write is never had through being public, so treating it as
        // private changes nothing.
        Some(id) => access::can(
            Some(actor),
            access::RepoRef { id, namespace: workspace, private: true },
            Capability::Push,
        ),
    }
}

/// The order memories are given and listed in: pinned, then most recently
/// used or changed.
const ORDER: &str = "pinned DESC, COALESCE(last_used_at, updated_at) DESC, created_at DESC";

/// A memory's text folded for comparing: lowercase words and digits, one
/// space apart, so wording that differs only in case, punctuation or
/// spacing is the same memory.
fn fingerprint(text: &str) -> String {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

impl Work {
    async fn memories_of(&self, scope: MemoryScope, key: &str, limit: u32) -> Result<Vec<Memory>> {
        Ok(self
            .db
            .prepare(format!(
                // Only what is kept: candidates captured before are not shown.
                "SELECT * FROM memories WHERE scope = ? AND scope_key = ? AND status = 'kept' ORDER BY {ORDER} LIMIT ?"
            ))
            .bind(&[scope.as_str().into(), key.into(), limit.into()])?
            .all()
            .await?
            .results::<MemoryRow>()?
            .into_iter()
            .map(Memory::from)
            .collect())
    }

    async fn memory_row(&self, workspace: &str, id: &str) -> Result<Option<Memory>> {
        Ok(self
            .db
            .prepare("SELECT * FROM memories WHERE id = ? AND workspace = ?")
            .bind(&[id.into(), workspace.into()])?
            .first::<MemoryRow>(None)
            .await?
            .map(Memory::from))
    }

    /// The repository a project's memory is about; none for the workspace's.
    async fn memory_repo_id(&self, id: &str) -> Result<Option<String>> {
        self
            .db
            .prepare("SELECT scope_key AS value FROM memories WHERE id = ? AND scope = 'project'")
            .bind(&[id.into()])?
            .first::<String>(Some("value"))
            .await
    }

    async fn mark_used(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        self.db
            .prepare("UPDATE memories SET last_used_at = ? WHERE id IN (SELECT value FROM json_each(?))")
            .bind(&[rfc3339(now_ms()).into(), serde_json::to_string(ids)?.into()])?
            .run()
            .await?;
        Ok(())
    }

    /// The project's repository, which must be in `workspace`.
    async fn project_repo(&self, path: &RepoPath, viewer: &Viewer, workspace: &str) -> Result<Outcome<Repo>> {
        Ok(match self.repo(path, viewer).await? {
            Outcome::Ok(repo) if repo.namespace.to_lowercase() == workspace => Outcome::Ok(repo),
            Outcome::Ok(_) => Outcome::fail(FailureCode::Invalid, "That project is in another workspace."),
            Outcome::Fail(failure) => Outcome::Fail(failure),
        })
    }

    pub(crate) async fn list_memories(&self, a: ListMemoriesArgs) -> Result<Outcome<Memories>> {
        let workspace = a.workspace.to_lowercase();
        let member = a.viewer.as_ref().is_some_and(|viewer| viewer.is_member(&workspace));
        // Someone else who can read the project sees its memory alone.
        if !member && a.repo.is_none() {
            return Ok(denied());
        }
        let project = match &a.repo {
            Some(path) => match self.project_repo(path, &a.viewer, &workspace).await? {
                Outcome::Ok(repo) => self.memories_of(MemoryScope::Project, &repo.id, MAX_PER_SCOPE).await?,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            },
            None => Vec::new(),
        };
        let workspace = if member {
            self.memories_of(MemoryScope::Workspace, &workspace, MAX_PER_SCOPE).await?
        } else {
            Vec::new()
        };
        Ok(Outcome::Ok(Memories { project, workspace }))
    }

    pub(crate) async fn add_memory(&self, a: AddMemoryArgs) -> Result<Outcome<Memory>> {
        let workspace = a.workspace.to_lowercase();
        if a.scope == MemoryScope::Workspace && !may_write(&a.actor, &workspace, None) {
            return Ok(denied());
        }
        let text = match valid_text(&a.text) {
            Ok(text) => text,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let viewer = Some(a.actor.clone());
        let repo = match &a.repo {
            Some(path) => match self.project_repo(path, &viewer, &workspace).await? {
                Outcome::Ok(repo) => Some(repo),
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            },
            None => None,
        };
        let key = match (a.scope, &repo) {
            (MemoryScope::Workspace, _) => workspace.clone(),
            (MemoryScope::Project, Some(repo)) => {
                if !may_write(&a.actor, &workspace, Some(&repo.id)) {
                    return Ok(Outcome::fail(FailureCode::Forbidden, CHANGE_DENIED));
                }
                repo.id.clone()
            }
            (MemoryScope::Project, None) => {
                return Ok(Outcome::fail(FailureCode::Invalid, "Name the project this memory is about."));
            }
        };
        // The same thing remembered twice is one memory, freshened; written
        // by hand, a candidate or a dismissed one with the same words is
        // kept.
        let now = rfc3339(now_ms());
        let print = fingerprint(&text);
        let same = self
            .db
            .prepare(
                "UPDATE memories SET updated_at = ?, status = 'kept'
                 WHERE scope = ? AND scope_key = ? AND (text = ? OR fingerprint = ?) RETURNING id AS value",
            )
            .bind(&[now.as_str().into(), a.scope.as_str().into(), key.as_str().into(), text.as_str().into(), print.as_str().into()])?
            .first::<String>(Some("value"))
            .await?;
        if let Some(id) = same {
            return Ok(match self.memory_row(&workspace, &id).await? {
                Some(memory) => Outcome::Ok(memory),
                None => Outcome::fail(FailureCode::NotFound, "Memory not found."),
            });
        }
        let count = self
            .db
            .prepare("SELECT count(*) AS value FROM memories WHERE scope = ? AND scope_key = ? AND status != 'dismissed'")
            .bind(&[a.scope.as_str().into(), key.as_str().into()])?
            .first::<u32>(Some("value"))
            .await?
            .unwrap_or_default();
        if count >= MAX_PER_SCOPE {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                format!("This {} already keeps {MAX_PER_SCOPE} memories. Remove some that no longer hold first.", a.scope.as_str()),
            ));
        }
        // Where it came from: a person, or an agent working for one.
        let from = match (&repo, a.from_number) {
            (Some(repo), Some(number)) => Some((repo, number)),
            _ => None,
        };
        let source_kind = match a.actor.kind {
            PrincipalKind::User => "person",
            _ => "agent",
        };
        let id = new_id("mem", now_ms());
        let repo_text = repo.as_ref().map(|repo| format!("{}/{}", repo.namespace, repo.name));
        // Its source, as earlier memories record theirs.
        let reference = format!("{source_kind}:{}", a.actor.username);
        self.db
            .prepare(
                "INSERT INTO memories
                   (id, scope, scope_key, workspace, repo, text, kind, source_kind, source_run,
                    source_repo, source_number, created_by, pinned, created_at, updated_at,
                    status, fingerprint, sources, source_ref)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'kept', ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                a.scope.as_str().into(),
                key.clone().into(),
                workspace.as_str().into(),
                // A workspace's memory belongs to no one project, though it
                // remembers which it was learned in.
                if a.scope == MemoryScope::Project { repo_text.clone().map_or(JsValue::NULL, JsValue::from) } else { JsValue::NULL },
                text.into(),
                a.kind.as_str().into(),
                source_kind.into(),
                JsValue::NULL,
                repo_text.map_or(JsValue::NULL, JsValue::from),
                from.map_or(JsValue::NULL, |(_, number)| number.into()),
                a.actor.username.as_str().into(),
                u32::from(a.pinned).into(),
                now.as_str().into(),
                now.as_str().into(),
                print.as_str().into(),
                serde_json::to_string(&[&reference])?.into(),
                reference.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(match self.memory_row(&workspace, &id).await? {
            Some(memory) => Outcome::Ok(memory),
            None => Outcome::fail(FailureCode::NotFound, "Memory not found."),
        })
    }

    pub(crate) async fn update_memory(&self, a: UpdateMemoryArgs) -> Result<Outcome<Memory>> {
        let workspace = a.workspace.to_lowercase();
        let repo_id = self.memory_repo_id(&a.id).await?;
        if !may_write(&a.actor, &workspace, repo_id.as_deref()) || a.actor.kind == PrincipalKind::Agent {
            return Ok(Outcome::fail(FailureCode::Forbidden, CHANGE_DENIED));
        }
        if self.memory_row(&workspace, &a.id).await?.is_none() {
            return Ok(Outcome::fail(FailureCode::NotFound, "Memory not found."));
        }
        let text = match a.text.as_deref().map(valid_text) {
            Some(Err(message)) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            Some(Ok(text)) => Some(text),
            None => None,
        };
        let print = text.as_deref().map(fingerprint);
        self.db
            .prepare(
                "UPDATE memories SET text = COALESCE(?, text), kind = COALESCE(?, kind),
                   pinned = COALESCE(?, pinned), fingerprint = COALESCE(?, fingerprint), updated_at = ?
                 WHERE id = ? AND workspace = ?",
            )
            .bind(&[
                text.map_or(JsValue::NULL, JsValue::from),
                a.kind.map_or(JsValue::NULL, |kind| kind.as_str().into()),
                a.pinned.map_or(JsValue::NULL, |pinned| u32::from(pinned).into()),
                print.map_or(JsValue::NULL, JsValue::from),
                rfc3339(now_ms()).into(),
                a.id.as_str().into(),
                workspace.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(match self.memory_row(&workspace, &a.id).await? {
            Some(memory) => Outcome::Ok(memory),
            None => Outcome::fail(FailureCode::NotFound, "Memory not found."),
        })
    }

    pub(crate) async fn delete_memory(&self, a: DeleteMemoryArgs) -> Result<Outcome<bool>> {
        let workspace = a.workspace.to_lowercase();
        let repo_id = self.memory_repo_id(&a.id).await?;
        if !may_write(&a.actor, &workspace, repo_id.as_deref()) || a.actor.kind == PrincipalKind::Agent {
            return Ok(Outcome::fail(FailureCode::Forbidden, CHANGE_DENIED));
        }
        let gone = self
            .db
            .prepare("DELETE FROM memories WHERE id = ? AND workspace = ? RETURNING id AS value")
            .bind(&[a.id.as_str().into(), workspace.as_str().into()])?
            .first::<String>(Some("value"))
            .await?;
        Ok(match gone {
            Some(_) => Outcome::Ok(true),
            None => Outcome::fail(FailureCode::NotFound, "Memory not found."),
        })
    }

    pub(crate) async fn recall(&self, a: RecallArgs) -> Result<Outcome<Memories>> {
        let repo = match self.repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        let workspace = repo.namespace.to_lowercase();
        // Found for the viewer, so they can read the project and its
        // memory; the workspace's is its members'.
        let member = a.viewer.as_ref().is_some_and(|viewer| viewer.is_member(&workspace));
        let words: Vec<String> = a
            .query
            .as_deref()
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_lowercase)
            .collect();
        let limit = a.limit.unwrap_or(DEFAULT_RECALL).clamp(1, 100) as usize;
        let matching = |memories: Vec<Memory>| -> Vec<Memory> {
            memories
                .into_iter()
                .filter(|memory| {
                    let text = memory.text.to_lowercase();
                    words.iter().all(|word| text.contains(word.as_str()))
                })
                .take(limit)
                .collect()
        };
        let found = Memories {
            project: matching(self.memories_of(MemoryScope::Project, &repo.id, MAX_PER_SCOPE).await?),
            workspace: if member {
                matching(self.memories_of(MemoryScope::Workspace, &workspace, MAX_PER_SCOPE).await?)
            } else {
                Vec::new()
            },
        };
        let ids: Vec<String> = found
            .project
            .iter()
            .chain(&found.workspace)
            .map(|memory| memory.id.clone())
            .collect();
        self.mark_used(&ids).await?;
        Ok(Outcome::Ok(found))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_and_deletion_statements_take_what_they_name() {
        for sql in TRANSFERRED.iter().chain(crate::guardrails::TRANSFERRED) {
            let n = g1t_kit::transfer::parameters(sql);
            assert!((1..=5).contains(&n), "{sql}");
        }
        for sql in DELETED {
            assert_eq!(g1t_kit::rename::parameters(sql), 1, "{sql}");
        }
    }

    #[test]
    fn rename_statements_take_the_two_slugs() {
        for sql in RENAMED {
            assert_eq!(g1t_kit::rename::parameters(sql), 2, "{sql}");
        }
    }

    #[test]
    fn secrets_are_refused_with_a_way_out() {
        // Joined at run time, so no whole key sits in the source for scanners to flag.
        let key = ["ghp", "_", "abcdefghijklmnopqrstuvwxyz0123456789"].concat();
        let refused = valid_text(&format!("deploy with {key}")).unwrap_err();
        assert!(refused.contains("never holds secrets"));
        assert_eq!(valid_text("  We use pnpm. ").unwrap(), "We use pnpm.");
        assert!(valid_text("   ").is_err());
    }

    fn person(base: Option<access::BasePermission>, grants: &[(&str, access::RepoRole)], member: bool) -> User {
        User {
            id: "usr_1".into(),
            username: "ana".into(),
            verified: true,
            workspaces: if member {
                vec![g1t_contracts::Membership { base_permission: base, ..g1t_contracts::Membership::member("acme") }]
            } else {
                Vec::new()
            },
            grants: grants
                .iter()
                .map(|(id, role)| access::RepoGrant { repo_id: (*id).into(), workspace: "acme".into(), role: *role, team: None })
                .collect(),
            ..User::default()
        }
    }

    #[test]
    fn a_workspaces_memory_is_its_members_and_a_projects_needs_write() {
        use access::{BasePermission, RepoRole};
        let member = person(None, &[], true);
        assert!(may_write(&member, "acme", None));
        assert!(may_write(&member, "acme", Some("rep_1")));
        // A reader may not change a project's memory, nor may an outsider.
        let reader = person(Some(BasePermission::Read), &[], true);
        assert!(may_write(&reader, "acme", None));
        assert!(!may_write(&reader, "acme", Some("rep_1")));
        let outsider = person(None, &[("rep_1", RepoRole::Write)], false);
        assert!(may_write(&outsider, "acme", Some("rep_1")));
        assert!(!may_write(&outsider, "acme", Some("rep_2")));
        assert!(!may_write(&outsider, "acme", None));
        let unverified = User { verified: false, ..person(None, &[], true) };
        assert!(!may_write(&unverified, "acme", None));
    }
}
