//! Memory: what agents and people have learned that the next agent should
//! know, at two levels. A project's memory is about its codebase; the
//! workspace's is true across its projects ("we use pnpm everywhere",
//! "staging lives at …").
//!
//! It is members-only, since it can hold internal knowledge, and it never
//! holds a secret: text that looks like a key or a token is refused. Every
//! g1t agent run is given it (`memory_context`): pinned first, then what
//! was used most recently, within a size budget.

use g1t_contracts::agents::*;
use g1t_contracts::repos::{Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, User, Viewer, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::runs::member_of;

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

/// The most memories one project, or one workspace, keeps.
const MAX_PER_SCOPE: u32 = 500;
/// What an agent is given by default, in characters.
const DEFAULT_BUDGET: u32 = 6000;
const MAX_BUDGET: u32 = 20_000;
const DEFAULT_RECALL: u32 = 20;

#[derive(Deserialize)]
struct MemoryRow {
    id: String,
    scope: String,
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
            },
            created_by: row.created_by,
            pinned: row.pinned != 0,
            created_at: row.created_at,
            updated_at: row.updated_at,
            last_used_at: row.last_used_at,
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

fn denied<T>() -> Outcome<T> {
    Outcome::fail(
        FailureCode::Forbidden,
        "Memory is for members of the workspace and its agents.",
    )
}

/// Whether `actor` may change `workspace`'s memory.
fn may_write(actor: &User, workspace: &str) -> bool {
    actor.is_member(workspace) && (actor.verified || actor.kind != PrincipalKind::User)
}

/// The order memories are given and listed in: pinned, then most recently
/// used or changed.
const ORDER: &str = "pinned DESC, COALESCE(last_used_at, updated_at) DESC, created_at DESC";

/// What an agent is told about memory, ahead of the memories themselves.
const PREAMBLE: &str = "What people and agents have learned here before you, kept as memory. Treat it as notes from colleagues: usually right, sometimes out of date. Where it disagrees with the code, the code wins; say so in your summary.";

/// How an agent is told to add to memory.
const HOW_TO_REMEMBER: &str = "When you learn something the next agent here would need (how to build or test, a convention, a decision and why, a trap), save it with the remember tool: scope project for this codebase, workspace for what holds across the workspace's projects. One short fact each. Never a secret, a key or a token. recall searches what is kept.";

/// The context an agent gets: as many memories as fit in `budget`, each
/// level labelled, and the ids of those given.
fn compose(workspace: &[Memory], project: &[Memory], repo: &RepoPath, budget: usize) -> (Option<String>, Vec<String>) {
    let line = |memory: &Memory| {
        format!(
            "- [{}{}] {}",
            memory.kind.as_str(),
            if memory.pinned { ", pinned" } else { "" },
            memory.text.replace('\n', " ")
        )
    };
    let mut used = PREAMBLE.len() + HOW_TO_REMEMBER.len() + 200;
    let mut given = Vec::new();
    let mut sections = Vec::new();
    // Pinned memories of either level go in before anything else does.
    let mut take = |memories: &[Memory], pinned: bool, out: &mut Vec<String>| {
        for memory in memories.iter().filter(|memory| memory.pinned == pinned) {
            let text = line(memory);
            if used + text.len() + 1 > budget {
                continue;
            }
            used += text.len() + 1;
            given.push(memory.id.clone());
            out.push(text);
        }
    };
    let (mut ws, mut own) = (Vec::new(), Vec::new());
    take(workspace, true, &mut ws);
    take(project, true, &mut own);
    take(project, false, &mut own);
    take(workspace, false, &mut ws);
    if ws.is_empty() && own.is_empty() {
        return (None, given);
    }
    sections.push(PREAMBLE.to_owned());
    if !ws.is_empty() {
        sections.push(format!(
            "Workspace memory (true across the {} workspace's projects):\n{}",
            repo.namespace,
            ws.join("\n")
        ));
    }
    if !own.is_empty() {
        sections.push(format!(
            "Project memory ({}/{}):\n{}",
            repo.namespace,
            repo.name,
            own.join("\n")
        ));
    }
    sections.push(HOW_TO_REMEMBER.to_owned());
    (Some(sections.join("\n\n")), given)
}

impl Work {
    async fn memories_of(&self, scope: MemoryScope, key: &str, limit: u32) -> Result<Vec<Memory>> {
        Ok(self
            .db
            .prepare(format!(
                "SELECT * FROM memories WHERE scope = ? AND scope_key = ? ORDER BY {ORDER} LIMIT ?"
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
        if !a.viewer.as_ref().is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(denied());
        }
        let project = match &a.repo {
            Some(path) => match self.project_repo(path, &a.viewer, &workspace).await? {
                Outcome::Ok(repo) => self.memories_of(MemoryScope::Project, &repo.id, MAX_PER_SCOPE).await?,
                Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
            },
            None => Vec::new(),
        };
        Ok(Outcome::Ok(Memories {
            project,
            workspace: self.memories_of(MemoryScope::Workspace, &workspace, MAX_PER_SCOPE).await?,
        }))
    }

    pub(crate) async fn add_memory(&self, a: AddMemoryArgs) -> Result<Outcome<Memory>> {
        let workspace = a.workspace.to_lowercase();
        if !may_write(&a.actor, &workspace) {
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
            (MemoryScope::Project, Some(repo)) => repo.id.clone(),
            (MemoryScope::Project, None) => {
                return Ok(Outcome::fail(FailureCode::Invalid, "Name the project this memory is about."));
            }
        };
        // The same thing remembered twice is one memory, freshened.
        let now = rfc3339(now_ms());
        let same = self
            .db
            .prepare("UPDATE memories SET updated_at = ? WHERE scope = ? AND scope_key = ? AND text = ? RETURNING id AS value")
            .bind(&[now.as_str().into(), a.scope.as_str().into(), key.as_str().into(), text.as_str().into()])?
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
            .prepare("SELECT count(*) AS value FROM memories WHERE scope = ? AND scope_key = ?")
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
        // Where it came from: a person, or an agent, and the run it was in.
        let from = match (&repo, a.from_number) {
            (Some(repo), Some(number)) => Some((repo, number)),
            _ => None,
        };
        let run = match (a.actor.kind, from) {
            (PrincipalKind::Agent, Some((repo, number))) => self.active_run_on(&repo.id, number).await?,
            _ => None,
        };
        let source_kind = match (a.actor.kind, &run) {
            (PrincipalKind::User, _) => "person",
            (_, Some(_)) => "run",
            _ => "agent",
        };
        let id = new_id("mem", now_ms());
        let repo_text = repo.as_ref().map(|repo| format!("{}/{}", repo.namespace, repo.name));
        self.db
            .prepare(
                "INSERT INTO memories
                   (id, scope, scope_key, workspace, repo, text, kind, source_kind, source_run,
                    source_repo, source_number, created_by, pinned, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                id.as_str().into(),
                a.scope.as_str().into(),
                key.into(),
                workspace.as_str().into(),
                // A workspace's memory belongs to no one project, though it
                // remembers which it was learned in.
                if a.scope == MemoryScope::Project { repo_text.clone().map_or(JsValue::NULL, JsValue::from) } else { JsValue::NULL },
                text.into(),
                a.kind.as_str().into(),
                source_kind.into(),
                run.map_or(JsValue::NULL, JsValue::from),
                repo_text.map_or(JsValue::NULL, JsValue::from),
                from.map_or(JsValue::NULL, |(_, number)| number.into()),
                a.actor.username.as_str().into(),
                u32::from(a.pinned).into(),
                now.as_str().into(),
                now.as_str().into(),
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
        if !may_write(&a.actor, &workspace) || a.actor.kind == PrincipalKind::Agent {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only members of the workspace can change its memory."));
        }
        if self.memory_row(&workspace, &a.id).await?.is_none() {
            return Ok(Outcome::fail(FailureCode::NotFound, "Memory not found."));
        }
        let text = match a.text.as_deref().map(valid_text) {
            Some(Err(message)) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
            Some(Ok(text)) => Some(text),
            None => None,
        };
        self.db
            .prepare(
                "UPDATE memories SET text = COALESCE(?, text), kind = COALESCE(?, kind),
                   pinned = COALESCE(?, pinned), updated_at = ?
                 WHERE id = ? AND workspace = ?",
            )
            .bind(&[
                text.map_or(JsValue::NULL, JsValue::from),
                a.kind.map_or(JsValue::NULL, |kind| kind.as_str().into()),
                a.pinned.map_or(JsValue::NULL, |pinned| u32::from(pinned).into()),
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
        if !may_write(&a.actor, &workspace) || a.actor.kind == PrincipalKind::Agent {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only members of the workspace can change its memory."));
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
        if !a.viewer.as_ref().is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(denied());
        }
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
            workspace: matching(self.memories_of(MemoryScope::Workspace, &workspace, MAX_PER_SCOPE).await?),
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

    pub(crate) async fn memory_context(&self, a: MemoryContextArgs) -> Result<MemoryContext> {
        let service = User {
            id: "g1t_runner".into(),
            username: "g1t".into(),
            ..User::default()
        };
        let Outcome::Ok(repo) = self.repo(&a.repo, &member_of(&service, &a.repo.namespace)).await? else {
            return Ok(MemoryContext::default());
        };
        let workspace = self
            .memories_of(MemoryScope::Workspace, &repo.namespace.to_lowercase(), MAX_PER_SCOPE)
            .await?;
        let project = self.memories_of(MemoryScope::Project, &repo.id, MAX_PER_SCOPE).await?;
        let budget = a.budget.unwrap_or(DEFAULT_BUDGET).clamp(500, MAX_BUDGET) as usize;
        let path = RepoPath {
            namespace: repo.namespace.clone(),
            name: repo.name.clone(),
        };
        let (text, given) = compose(&workspace, &project, &path, budget);
        self.mark_used(&given).await?;
        Ok(MemoryContext {
            text,
            count: given.len() as u32,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory(id: &str, text: &str, pinned: bool) -> Memory {
        Memory {
            id: id.into(),
            scope: MemoryScope::Project,
            workspace: "acme".into(),
            repo: None,
            text: text.into(),
            kind: MemoryKind::Fact,
            source: MemorySource::default(),
            created_by: "ana".into(),
            pinned,
            created_at: String::new(),
            updated_at: String::new(),
            last_used_at: None,
        }
    }

    fn repo() -> RepoPath {
        RepoPath {
            namespace: "acme".into(),
            name: "web".into(),
        }
    }

    #[test]
    fn rename_statements_take_the_two_slugs() {
        for sql in RENAMED {
            assert_eq!(g1t_kit::rename::parameters(sql), 2, "{sql}");
        }
    }

    #[test]
    fn nothing_kept_is_nothing_said() {
        assert_eq!(compose(&[], &[], &repo(), 6000), (None, Vec::new()));
    }

    #[test]
    fn levels_are_labelled_and_pinned_come_first() {
        let workspace = [memory("w1", "We use pnpm everywhere.", false)];
        let project = [memory("p1", "Tests need TZ=UTC.", false), memory("p2", "Never edit generated.rs.", true)];
        let (text, given) = compose(&workspace, &project, &repo(), 6000);
        let text = text.unwrap();
        assert!(text.contains("Workspace memory (true across the acme workspace's projects)"));
        assert!(text.contains("Project memory (acme/web)"));
        assert!(text.find("Never edit").unwrap() < text.find("Tests need").unwrap());
        assert_eq!(given, ["p2", "p1", "w1"]);
    }

    #[test]
    fn the_budget_is_kept() {
        let project: Vec<Memory> = (0..100).map(|n| memory(&format!("p{n}"), &"x".repeat(200), false)).collect();
        let (text, given) = compose(&[], &project, &repo(), 3000);
        assert!(text.unwrap().len() <= 3000);
        assert!(given.len() < 100 && !given.is_empty());
    }

    #[test]
    fn secrets_are_refused_with_a_way_out() {
        let refused = valid_text("deploy with ghp_abcdefghijklmnopqrstuvwxyz0123456789").unwrap_err();
        assert!(refused.contains("never holds secrets"));
        assert_eq!(valid_text("  We use pnpm. ").unwrap(), "We use pnpm.");
        assert!(valid_text("   ").is_err());
    }
}
