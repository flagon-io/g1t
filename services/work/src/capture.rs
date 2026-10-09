//! Memory that fills itself (see `g1t_contracts::capture`).
//!
//! Candidates arrive from four places:
//!
//! - **Runs.** At the end of a run the harness asks the agent what it
//!   learned and reports it with the run's token (`report_learned`).
//! - **Reviews.** A person's request for changes, or a comment that
//!   corrects the agent ("use the shared client instead"), on a pull
//!   request, becomes a convention candidate quoting the comment.
//! - **Merges.** A merged pull request's title, why and files become a
//!   decision candidate. No model is asked: the pull request's own words
//!   are the decision, and a candidate waits for review anyway.
//! - **Docs.** The context service reads a project's README, AGENTS.md,
//!   CONTRIBUTING, docs on how to work in it, and manifests, and sends
//!   what they say (`capture_memories`). Once it has read every file, the
//!   waiting candidates its docs no longer suggest are let go
//!   (`prune_doc_candidates`).
//!
//! The same thing said again, by an independent source, is one memory seen
//! twice, which keeps it (`promotes`). The same thing in other words (a
//! sentence that grew, one cut short) is the memory already there
//! (`same_memory`). A dismissed memory stays dismissed, so the same thing
//! is never suggested again. Nothing that looks like a secret is stored, in
//! the text or in its evidence.

use std::collections::HashMap;

use g1t_contracts::agents::*;
use g1t_contracts::capture::*;
use g1t_contracts::events::{Event, NewEvent, Publish};
use g1t_contracts::repos::{PathByIdArgs, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::{Comment, CommentKind, Pull, PullStatus, Verdict};
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, new_id};
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::rows::PULL_COLUMNS;
use crate::checks::hash;
use crate::rows::{CommentRow, PullRow};

/// The most memories one project, or one workspace, keeps (as memory.rs).
const MAX_PER_SCOPE: u32 = 500;
/// How sure g1t is of what an agent says it learned.
const RUN_CONFIDENCE: f64 = 0.6;
/// Of a person's correction in a review.
const REVIEW_CONFIDENCE: f64 = 0.7;
/// Of a merged pull request's decision, summed up from its own words.
const MERGE_CONFIDENCE: f64 = 0.5;
/// The longest correction or decision kept, in characters.
const MAX_SUMMARY_CHARS: usize = 400;
/// The most files a decision names.
const MAX_FILES_NAMED: usize = 6;
/// Who people's and agents' names are not.
const NOT_PEOPLE: [&str; 2] = ["g1t", "agent"];

/// Words that mark a sentence as telling the agent how things are done.
const CORRECTIVE: [&str; 20] = [
    "instead",
    "don't",
    "do not",
    "never",
    "always",
    "please use",
    "we use",
    "use the",
    "should",
    "shouldn't",
    "prefer",
    "avoid",
    "must",
    "rather than",
    "convention",
    "not how",
    "we don't",
    "make sure",
    "remember to",
    "the right way",
];

#[derive(Clone, Deserialize)]
struct Existing {
    id: String,
    status: String,
    sources: String,
    confidence: Option<f64>,
    text: String,
}

/// The most memories of one scope compared with a new one for being the
/// same thing in other words: every kept and waiting one (at most 500) and
/// the most recently dismissed.
const MAX_COMPARED: u32 = 2000;

/// The memory in `among` that says the same thing as `text`, if any.
fn same_as<'a>(among: &'a [Existing], text: &str) -> Option<&'a Existing> {
    among.iter().find(|existing| same_memory(&existing.text, text))
}

/// Whether `existing` is a waiting candidate that the source `reference`
/// said before and now says in other words (`print`).
fn reworded_by(existing: &Existing, reference: &str, print: &str) -> bool {
    let sources: Vec<String> = serde_json::from_str(&existing.sources).unwrap_or_default();
    existing.status == MemoryStatus::Candidate.as_str()
        && fingerprint(&existing.text) != print
        && sources.iter().any(|source| source == reference)
}

/// Whether a candidate came from docs and manifests alone.
fn only_from_docs(sources: &str) -> bool {
    let list: Vec<String> = serde_json::from_str(sources).unwrap_or_default();
    !list.is_empty() && list.iter().all(|source| source.starts_with("doc:"))
}

/// Of a project's waiting doc candidates, the ids its docs no longer
/// suggest: none of `texts` is the same memory.
fn unsuggested(candidates: &[Existing], texts: &[String]) -> Vec<String> {
    candidates
        .iter()
        .filter(|candidate| only_from_docs(&candidate.sources))
        .filter(|candidate| !texts.iter().any(|text| same_memory(&candidate.text, text)))
        .map(|candidate| candidate.id.clone())
        .collect()
}

#[derive(Deserialize)]
struct RunTicket {
    id: String,
    workspace: String,
    repo_id: String,
    number: Option<u32>,
    token_hash: String,
}

/// `text` cut to `max` characters at a word, with an ellipsis if cut.
fn clip(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        return text;
    }
    let cut: String = text.chars().take(max - 1).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head).to_owned();
    format!("{cut}…")
}

/// Markdown reduced to plain prose: no code blocks, quotes, headings or
/// list markers.
fn prose(markdown: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut fenced = false;
    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced || trimmed.starts_with('>') || trimmed.starts_with('#') || trimmed.starts_with("<!--") {
            lines.push(String::new());
            continue;
        }
        let item = trimmed.trim_start_matches(['-', '*', '+']).trim_start();
        lines.push(item.to_owned());
    }
    lines
}

/// The sentences of a comment, as plain prose.
fn sentences(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in prose(body) {
        let mut current = String::new();
        for c in line.chars() {
            current.push(c);
            if matches!(c, '.' | '!' | '?') {
                let sentence = current.trim().to_owned();
                if !sentence.is_empty() {
                    out.push(sentence);
                }
                current.clear();
            }
        }
        let rest = current.trim();
        if !rest.is_empty() {
            out.push(rest.to_owned());
        }
    }
    out
}

/// Whether a sentence tells the agent how something is done here.
fn corrective(sentence: &str) -> bool {
    let lower = format!(" {} ", sentence.to_lowercase());
    !sentence.trim_end().ends_with('?') && CORRECTIVE.iter().any(|word| lower.contains(word))
}

/// What a person's review comment teaches, as one convention: its first
/// sentence that says how things are done, or, for a request for changes,
/// its first real sentence. None when it teaches nothing reusable: a
/// question, a thank-you, a nit too short to mean anything.
pub(crate) fn correction(body: &str, requested_changes: bool) -> Option<String> {
    let all = sentences(body);
    let found = all
        .iter()
        .find(|sentence| sentence.chars().count() >= 15 && corrective(sentence))
        .or_else(|| {
            requested_changes.then(|| {
                all.iter()
                    .find(|sentence| sentence.chars().count() >= 20 && !sentence.ends_with('?'))
            })?
        })?;
    Some(clip(found, MAX_SUMMARY_CHARS))
}

/// A merged pull request's decision, from its own words: its title, the
/// first paragraph of its description (why), and the files it changed.
/// None when it says no more than its title.
pub(crate) fn decision(number: u32, title: &str, body: Option<&str>, files: &[String]) -> Option<String> {
    let body = body.unwrap_or_default();
    let mut paragraph = String::new();
    for line in prose(body) {
        if line.trim().is_empty() {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        // "Summary:" and the like say nothing by themselves.
        if paragraph.is_empty() && line.trim_end_matches(':').split_whitespace().count() <= 1 {
            continue;
        }
        if !paragraph.is_empty() {
            paragraph.push(' ');
        }
        paragraph.push_str(line.trim());
    }
    if paragraph.chars().count() < 30 {
        return None;
    }
    let why = clip(&paragraph, MAX_SUMMARY_CHARS);
    let mut text = format!("Decided in #{number}, \"{}\": {why}", clip(title, 120));
    if !files.is_empty() {
        let named: Vec<&str> = files.iter().take(MAX_FILES_NAMED).map(String::as_str).collect();
        let more = files.len().saturating_sub(MAX_FILES_NAMED);
        text.push_str(&format!(
            " Changed {}{}.",
            named.join(", "),
            if more > 0 { format!(" and {more} more") } else { String::new() }
        ));
    }
    Some(clip(&text, MAX_MEMORY_CHARS))
}

/// The JSON list of sources, with `reference` added once.
fn with_source(sources: &str, reference: &str) -> Vec<String> {
    let mut list: Vec<String> = serde_json::from_str(sources).unwrap_or_default();
    if !list.iter().any(|seen| seen == reference) {
        list.push(reference.to_owned());
    }
    list
}

/// An item tidied, or why it cannot be kept.
fn checked(item: &CaptureItem) -> std::result::Result<(String, Option<String>), &'static str> {
    let text = item.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() < 8 {
        return Err("too short");
    }
    if text.chars().count() > MAX_MEMORY_CHARS {
        return Err("too long");
    }
    if secret_in(&text).is_some() {
        return Err("looks like a secret");
    }
    let evidence = item
        .evidence
        .as_deref()
        .map(|evidence| clip(evidence, MAX_EVIDENCE_CHARS))
        .filter(|evidence| !evidence.is_empty());
    // Evidence quoting a key would put the key in memory all the same.
    if evidence.as_deref().is_some_and(|evidence| secret_in(evidence).is_some()) {
        return Err("looks like a secret");
    }
    Ok((text, evidence))
}

impl Work {
    /// The `owner/name` of a repository, by id, remembered for one capture.
    async fn path_of(&self, cache: &mut HashMap<String, Option<RepoPath>>, repo_id: &str) -> Result<Option<RepoPath>> {
        if let Some(found) = cache.get(repo_id) {
            return Ok(found.clone());
        }
        let found: Option<RepoPath> =
            g1t_kit::call(&self.repos, "path_by_id", &PathByIdArgs { id: repo_id.to_owned() }).await?;
        cache.insert(repo_id.to_owned(), found.clone());
        Ok(found)
    }

    /// Tells subscribers (the context service's search) that a memory
    /// changed. Never fails what changed it.
    pub(crate) async fn memory_changed(&self, id: &str, workspace: &str, status: &str, repo_id: Option<&str>) {
        let event = NewEvent {
            kind: "memory.changed",
            source: "work",
            repo_id: repo_id.map(str::to_owned),
            actor: None,
            data: MemoryChanged {
                memory_id: id.to_owned(),
                workspace: workspace.to_owned(),
                status: status.to_owned(),
            },
        };
        let sent: Result<()> = g1t_kit::call(&self.events, "publish", &Publish { events: vec![event] }).await;
        if let Err(error) = sent {
            worker::console_error!("memory.changed for {id} was not published: {error}");
        }
    }

    /// Adds candidates, or counts them as another sighting of what is there.
    pub(crate) async fn capture(&self, workspace: &str, items: &[CaptureItem], by: &str) -> Result<Captured> {
        let workspace = workspace.to_lowercase();
        let mut done = Captured::default();
        let mut paths = HashMap::new();
        // Each scope's memories, read once a capture, for near-duplicates.
        let mut scopes: HashMap<(&'static str, String), Vec<Existing>> = HashMap::new();
        for item in items.iter().take(MAX_CAPTURE) {
            let Ok((text, evidence)) = checked(item) else {
                done.refused += 1;
                continue;
            };
            let (key, repo) = match (item.scope, &item.repo_id) {
                (MemoryScope::Workspace, _) => (workspace.clone(), item.repo_id.clone()),
                (MemoryScope::Project, Some(repo_id)) => (repo_id.clone(), Some(repo_id.clone())),
                (MemoryScope::Project, None) => {
                    done.refused += 1;
                    continue;
                }
            };
            let path = match &repo {
                Some(repo_id) => self.path_of(&mut paths, repo_id).await?,
                None => None,
            };
            // A project's memory belongs to a repository of this workspace.
            if item.scope == MemoryScope::Project
                && !path.as_ref().is_some_and(|path| path.namespace.to_lowercase() == workspace)
            {
                done.refused += 1;
                continue;
            }
            let print = fingerprint(&text);
            let now = rfc3339(now_ms());
            let mut existing = self
                .db
                .prepare(
                    "SELECT id, status, sources, confidence, text FROM memories
                     WHERE scope = ? AND scope_key = ? AND (fingerprint = ? OR text = ?) LIMIT 1",
                )
                .bind(&[item.scope.as_str().into(), key.as_str().into(), print.as_str().into(), text.as_str().into()])?
                .first::<Existing>(None)
                .await?;
            // The same thing in other words: a sentence that grew, or one
            // cut short, is the memory already there, kept, waiting or
            // dismissed.
            let scope_key = (item.scope.as_str(), key.clone());
            if existing.is_none() {
                if !scopes.contains_key(&scope_key) {
                    let rows = self
                        .db
                        .prepare(
                            "SELECT id, status, sources, confidence, text FROM memories
                             WHERE scope = ? AND scope_key = ?
                             ORDER BY status = 'dismissed', updated_at DESC LIMIT ?",
                        )
                        .bind(&[item.scope.as_str().into(), key.as_str().into(), MAX_COMPARED.into()])?
                        .all()
                        .await?
                        .results::<Existing>()?;
                    scopes.insert(scope_key.clone(), rows);
                }
                existing = scopes.get(&scope_key).and_then(|among| same_as(among, &text)).cloned();
            }
            if let Some(existing) = existing {
                done.merged += 1;
                if existing.status == MemoryStatus::Dismissed.as_str() {
                    continue;
                }
                let sources = with_source(&existing.sources, &item.reference);
                // A waiting candidate its own source now says in other words
                // (a doc's line read whole, or edited) takes the new words,
                // kind and confidence. Kept memory keeps its words.
                let reworded = reworded_by(&existing, &item.reference, &print);
                let confidence = match (existing.confidence, item.confidence) {
                    _ if reworded => item.confidence,
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (a, b) => a.or(b),
                };
                let keep = existing.status == MemoryStatus::Candidate.as_str()
                    && promotes(sources.len(), item.source, confidence);
                if keep {
                    done.kept += 1;
                }
                let status = if keep { MemoryStatus::Kept.as_str() } else { existing.status.as_str() };
                let (new_text, new_print) =
                    if reworded { (text.clone(), print.clone()) } else { (existing.text.clone(), fingerprint(&existing.text)) };
                self.db
                    .prepare(
                        "UPDATE memories SET sources = ?, confidence = ?, status = ?, text = ?, fingerprint = ?,
                           kind = COALESCE(?, kind), evidence = COALESCE(?, evidence), updated_at = ?
                         WHERE id = ?",
                    )
                    .bind(&[
                        serde_json::to_string(&sources)?.into(),
                        confidence.map_or(JsValue::NULL, JsValue::from),
                        status.into(),
                        new_text.as_str().into(),
                        new_print.as_str().into(),
                        if reworded { item.kind.as_str().into() } else { JsValue::NULL },
                        if reworded { evidence.clone().map_or(JsValue::NULL, JsValue::from) } else { JsValue::NULL },
                        now.as_str().into(),
                        existing.id.as_str().into(),
                    ])?
                    .run()
                    .await?;
                if keep {
                    self.memory_changed(&existing.id, &workspace, status, repo.as_deref()).await;
                }
                continue;
            }
            let count = self
                .db
                .prepare("SELECT count(*) AS value FROM memories WHERE scope = ? AND scope_key = ? AND status != 'dismissed'")
                .bind(&[item.scope.as_str().into(), key.as_str().into()])?
                .first::<u32>(Some("value"))
                .await?
                .unwrap_or_default();
            if count >= MAX_PER_SCOPE {
                done.refused += 1;
                continue;
            }
            let keep = promotes(1, item.source, item.confidence);
            let status = if keep { MemoryStatus::Kept } else { MemoryStatus::Candidate };
            let id = new_id("mem", now_ms());
            let repo_text = path.as_ref().map(|path| format!("{}/{}", path.namespace, path.name));
            self.db
                .prepare(
                    "INSERT INTO memories
                       (id, scope, scope_key, workspace, repo, text, kind, source_kind, source_run,
                        source_repo, source_number, created_by, pinned, created_at, updated_at,
                        status, confidence, source_ref, evidence, fingerprint, sources)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(&[
                    id.as_str().into(),
                    item.scope.as_str().into(),
                    key.as_str().into(),
                    workspace.as_str().into(),
                    if item.scope == MemoryScope::Project { repo_text.clone().map_or(JsValue::NULL, JsValue::from) } else { JsValue::NULL },
                    text.as_str().into(),
                    item.kind.as_str().into(),
                    item.source.as_str().into(),
                    item.run_id.as_deref().map_or(JsValue::NULL, JsValue::from),
                    repo_text.map_or(JsValue::NULL, JsValue::from),
                    item.number.map_or(JsValue::NULL, JsValue::from),
                    by.into(),
                    now.as_str().into(),
                    now.as_str().into(),
                    status.as_str().into(),
                    item.confidence.map_or(JsValue::NULL, JsValue::from),
                    item.reference.as_str().into(),
                    evidence.map_or(JsValue::NULL, JsValue::from),
                    print.as_str().into(),
                    serde_json::to_string(&[&item.reference])?.into(),
                ])?
                .run()
                .await?;
            done.added += 1;
            if keep {
                done.kept += 1;
            }
            // The same thing twice in one capture is one memory.
            if let Some(among) = scopes.get_mut(&scope_key) {
                among.push(Existing {
                    id: id.clone(),
                    status: status.as_str().to_owned(),
                    sources: serde_json::to_string(&[&item.reference])?,
                    confidence: item.confidence,
                    text: text.clone(),
                });
            }
            self.memory_changed(&id, &workspace, status.as_str(), repo.as_deref()).await;
        }
        Ok(done)
    }

    /// Removes a project's waiting candidates that came from its docs alone
    /// and that its docs, as read now, no longer suggest. Kept and dismissed
    /// memory is never touched, nor a candidate another source saw too.
    pub(crate) async fn prune_doc_candidates(&self, a: PruneDocCandidatesArgs) -> Result<Pruned> {
        let workspace = a.workspace.to_lowercase();
        let candidates = self
            .db
            .prepare(
                "SELECT id, status, sources, confidence, text FROM memories
                 WHERE workspace = ? AND scope = 'project' AND scope_key = ? AND status = 'candidate'
                   AND source_kind = 'doc'
                 LIMIT ?",
            )
            .bind(&[workspace.as_str().into(), a.repo_id.as_str().into(), MAX_COMPARED.into()])?
            .all()
            .await?
            .results::<Existing>()?;
        let gone = unsuggested(&candidates, &a.texts);
        if gone.is_empty() {
            return Ok(Pruned::default());
        }
        let removed = self
            .db
            .prepare(
                "DELETE FROM memories WHERE workspace = ? AND scope_key = ? AND status = 'candidate'
                   AND id IN (SELECT value FROM json_each(?)) RETURNING id",
            )
            .bind(&[workspace.as_str().into(), a.repo_id.as_str().into(), serde_json::to_string(&gone)?.into()])?
            .all()
            .await?
            .results::<serde_json::Value>()?
            .len();
        worker::console_log!("pruned {removed} doc candidates of {} in {workspace}", a.repo_id);
        Ok(Pruned { removed: removed as u32 })
    }

    pub(crate) async fn capture_memories(&self, a: CaptureMemoriesArgs) -> Result<Captured> {
        self.capture(&a.workspace, &a.items, a.by.as_deref().unwrap_or("g1t")).await
    }

    pub(crate) async fn report_learned(&self, a: ReportLearnedArgs) -> Result<Outcome<Captured>> {
        let run = self
            .db
            .prepare("SELECT id, workspace, repo_id, number, token_hash FROM agent_runs WHERE id = ?")
            .bind(&[a.run_id.as_str().into()])?
            .first::<RunTicket>(None)
            .await?
            .filter(|run| !a.token.is_empty() && run.token_hash == hash(&a.token));
        let Some(run) = run else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Run not found."));
        };
        let items: Vec<CaptureItem> = a
            .items
            .iter()
            .take(MAX_LEARNED)
            .map(|learned| CaptureItem {
                scope: if learned.scope.as_deref() == Some("workspace") {
                    MemoryScope::Workspace
                } else {
                    MemoryScope::Project
                },
                repo_id: Some(run.repo_id.clone()),
                kind: learned.kind.as_deref().and_then(MemoryKind::parse).unwrap_or_default(),
                text: learned.text.clone(),
                confidence: Some(RUN_CONFIDENCE),
                source: CaptureSource::Run,
                reference: format!("run:{}", run.id),
                evidence: learned.evidence.clone(),
                number: run.number,
                run_id: Some(run.id.clone()),
            })
            .collect();
        Ok(Outcome::Ok(self.capture(&run.workspace, &items, "g1t").await?))
    }

    pub(crate) async fn list_candidates(&self, a: ListCandidatesArgs) -> Result<Outcome<Vec<Memory>>> {
        let workspace = a.workspace.to_lowercase();
        if !a.viewer.as_ref().is_some_and(|viewer| viewer.is_member(&workspace)) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Memory is for members of the workspace and its agents."));
        }
        let statement = match &a.repo {
            Some(path) => {
                let repo = match self.repo(path, &a.viewer).await? {
                    Outcome::Ok(repo) => repo,
                    Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
                };
                // The project's own, and the workspace's learned there.
                self.db
                    .prepare(
                        "SELECT * FROM memories WHERE workspace = ? AND status = 'candidate'
                           AND (scope_key = ? OR (scope = 'workspace' AND source_repo = ?))
                         ORDER BY updated_at DESC LIMIT 200",
                    )
                    .bind(&[
                        workspace.as_str().into(),
                        repo.id.as_str().into(),
                        format!("{}/{}", repo.namespace, repo.name).into(),
                    ])?
            }
            None => self
                .db
                .prepare("SELECT * FROM memories WHERE workspace = ? AND status = 'candidate' ORDER BY updated_at DESC LIMIT 200")
                .bind(&[workspace.as_str().into()])?,
        };
        let rows = statement.all().await?.results::<crate::memory::MemoryRow>()?;
        Ok(Outcome::Ok(rows.into_iter().map(Memory::from).collect()))
    }

    pub(crate) async fn review_memory(&self, a: ReviewMemoryArgs) -> Result<Outcome<Memory>> {
        let workspace = a.workspace.to_lowercase();
        if !a.actor.is_member(&workspace) || a.actor.kind != PrincipalKind::User || !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only members of the workspace can review its memory."));
        }
        let Some(row) = self
            .db
            .prepare("SELECT * FROM memories WHERE id = ? AND workspace = ?")
            .bind(&[a.id.as_str().into(), workspace.as_str().into()])?
            .first::<crate::memory::MemoryRow>(None)
            .await?
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Memory not found."));
        };
        let text = match a.text.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
            Some(text) => {
                if text.chars().count() > MAX_MEMORY_CHARS {
                    return Ok(Outcome::fail(FailureCode::Invalid, format!("Keep a memory to {MAX_MEMORY_CHARS} characters.")));
                }
                if let Some(what) = secret_in(text) {
                    return Ok(Outcome::fail(
                        FailureCode::Invalid,
                        format!("That looks like {what}. Memory never holds secrets; say where the secret lives instead."),
                    ));
                }
                Some(text.to_owned())
            }
            None => None,
        };
        let status = match a.decision {
            ReviewDecision::Keep => MemoryStatus::Kept,
            ReviewDecision::Dismiss => MemoryStatus::Dismissed,
        };
        let now = rfc3339(now_ms());
        let print = text.as_deref().map(fingerprint);
        self.db
            .prepare(
                "UPDATE memories SET status = ?, text = COALESCE(?, text), fingerprint = COALESCE(?, fingerprint),
                   kind = COALESCE(?, kind), reviewed_by = ?, reviewed_at = ?, updated_at = ?
                 WHERE id = ? AND workspace = ?",
            )
            .bind(&[
                status.as_str().into(),
                text.map_or(JsValue::NULL, JsValue::from),
                print.map_or(JsValue::NULL, JsValue::from),
                a.kind.map_or(JsValue::NULL, |kind| kind.as_str().into()),
                a.actor.username.as_str().into(),
                now.as_str().into(),
                now.as_str().into(),
                a.id.as_str().into(),
                workspace.as_str().into(),
            ])?
            .run()
            .await?;
        let repo_id = (row.scope == "project").then(|| row.scope_key.clone());
        self.memory_changed(&a.id, &workspace, status.as_str(), repo_id.as_deref()).await;
        let reviewed = self
            .db
            .prepare("SELECT * FROM memories WHERE id = ?")
            .bind(&[a.id.as_str().into()])?
            .first::<crate::memory::MemoryRow>(None)
            .await?;
        Ok(match reviewed {
            Some(row) => Outcome::Ok(Memory::from(row)),
            None => Outcome::fail(FailureCode::NotFound, "Memory not found."),
        })
    }

    pub(crate) async fn memories_by_id(&self, a: MemoriesByIdArgs) -> Result<Vec<Memory>> {
        let ids: Vec<&String> = a.ids.iter().take(100).collect();
        let rows = self
            .db
            .prepare("SELECT * FROM memories WHERE workspace = ? AND id IN (SELECT value FROM json_each(?))")
            .bind(&[a.workspace.to_lowercase().into(), serde_json::to_string(&ids)?.into()])?
            .all()
            .await?
            .results::<crate::memory::MemoryRow>()?;
        Ok(rows.into_iter().map(Memory::from).collect())
    }

    pub(crate) async fn search_memories(&self, a: SearchMemoriesArgs) -> Result<Vec<Memory>> {
        let status = a.status.unwrap_or(MemoryStatus::Kept);
        let limit = a.limit.unwrap_or(20).clamp(1, 100) as usize;
        let statement = match &a.repo_ids {
            Some(ids) => self
                .db
                .prepare(
                    "SELECT * FROM memories WHERE workspace = ? AND status = ?
                       AND (scope = 'workspace' OR scope_key IN (SELECT value FROM json_each(?)))
                     ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC LIMIT 1000",
                )
                .bind(&[a.workspace.to_lowercase().into(), status.as_str().into(), serde_json::to_string(ids)?.into()])?,
            None => self
                .db
                .prepare(
                    "SELECT * FROM memories WHERE workspace = ? AND status = ?
                     ORDER BY pinned DESC, COALESCE(last_used_at, updated_at) DESC LIMIT 1000",
                )
                .bind(&[a.workspace.to_lowercase().into(), status.as_str().into()])?,
        };
        let words: Vec<String> = a
            .query
            .as_deref()
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_lowercase)
            .collect();
        Ok(statement
            .all()
            .await?
            .results::<crate::memory::MemoryRow>()?
            .into_iter()
            .map(Memory::from)
            .filter(|memory| {
                let text = memory.text.to_lowercase();
                words.iter().all(|word| text.contains(word.as_str()))
            })
            .take(limit)
            .collect())
    }

    /// What a merged pull request decided, as a candidate.
    fn decision_item(pull: &Pull) -> Option<CaptureItem> {
        let files: Vec<String> = pull.files.iter().map(|file| file.path.clone()).collect();
        let text = decision(pull.number, &pull.title, pull.body.as_deref(), &files)?;
        Some(CaptureItem {
            scope: MemoryScope::Project,
            repo_id: Some(pull.repo_id.clone()),
            kind: MemoryKind::Decision,
            text,
            confidence: Some(MERGE_CONFIDENCE),
            source: CaptureSource::Pr,
            reference: format!("pull:{}#{}", pull.repo_id, pull.number),
            evidence: Some(clip(&pull.title, MAX_EVIDENCE_CHARS)),
            number: Some(pull.number),
            run_id: None,
        })
    }

    /// What a person's comment on a pull request corrected, as a candidate.
    fn correction_item(pull: &Pull, comment: &Comment) -> Option<CaptureItem> {
        if comment.kind != CommentKind::Comment
            || comment.author.kind == PrincipalKind::Agent
            || NOT_PEOPLE.contains(&comment.author.username.as_str())
        {
            return None;
        }
        let text = correction(&comment.body, comment.verdict == Some(Verdict::RequestChanges))?;
        Some(CaptureItem {
            scope: MemoryScope::Project,
            repo_id: Some(pull.repo_id.clone()),
            kind: MemoryKind::Convention,
            text,
            confidence: Some(REVIEW_CONFIDENCE),
            source: CaptureSource::Review,
            reference: format!("comment:{}", comment.id),
            evidence: Some(format!(
                "{} on #{}{}: {}",
                comment.author.username,
                pull.number,
                comment.path.as_deref().map(|path| format!(" ({path})")).unwrap_or_default(),
                clip(&comment.body, MAX_EVIDENCE_CHARS - 60)
            )),
            number: Some(pull.number),
            run_id: None,
        })
    }

    async fn workspace_of(&self, repo_id: &str) -> Result<Option<String>> {
        let mut cache = HashMap::new();
        Ok(self.path_of(&mut cache, repo_id).await?.map(|path| path.namespace.to_lowercase()))
    }

    pub(crate) async fn seed_from_pulls(&self, a: SeedFromPullsArgs) -> Result<Captured> {
        let Some(workspace) = self.workspace_of(&a.repo_id).await? else {
            return Ok(Captured::default());
        };
        let limit = a.limit.unwrap_or(20).clamp(1, 50);
        let pulls: Vec<Pull> = self
            .db
            .prepare(format!("SELECT {PULL_COLUMNS} FROM pulls WHERE repo_id = ? AND status = 'merged' ORDER BY merged_at DESC LIMIT ?"))
            .bind(&[a.repo_id.as_str().into(), limit.into()])?
            .all()
            .await?
            .results::<PullRow>()?
            .into_iter()
            .map(Pull::from)
            .collect();
        let mut items = Vec::new();
        for pull in &pulls {
            items.extend(Self::decision_item(pull));
            let comments = self
                .db
                .prepare("SELECT * FROM comments WHERE repo_id = ? AND number = ? ORDER BY id LIMIT 100")
                .bind(&[pull.repo_id.as_str().into(), pull.number.into()])?
                .all()
                .await?
                .results::<CommentRow>()?;
            items.extend(
                comments
                    .into_iter()
                    .map(Comment::from)
                    .filter_map(|comment| Self::correction_item(pull, &comment)),
            );
        }
        let mut done = Captured::default();
        for chunk in items.chunks(MAX_CAPTURE) {
            let part = self.capture(&workspace, chunk, "g1t").await?;
            done.added += part.added;
            done.merged += part.merged;
            done.kept += part.kept;
            done.refused += part.refused;
        }
        Ok(done)
    }

    /// Captures from the bus: corrections in review, decisions on merge.
    async fn capture_event(&self, event: &Event) -> Result<()> {
        let field = |name: &str| event.data[name].as_str().map(str::to_owned);
        match event.kind.as_str() {
            "pull.merged" => {
                let Some(pull) = (match field("pullId") {
                    Some(id) => self.pull_by_id(&id).await?,
                    None => None,
                }) else {
                    return Ok(());
                };
                if pull.status != PullStatus::Merged {
                    return Ok(());
                }
                if let (Some(item), Some(workspace)) = (Self::decision_item(&pull), self.workspace_of(&pull.repo_id).await?) {
                    self.capture(&workspace, &[item], "g1t").await?;
                }
            }
            "comment.created" => {
                let (Some(comment_id), Some(pull_id)) = (field("commentId"), field("pullId")) else {
                    return Ok(());
                };
                let Some(pull) = self.pull_by_id(&pull_id).await? else {
                    return Ok(());
                };
                let Some(comment) = self
                    .db
                    .prepare("SELECT * FROM comments WHERE id = ?")
                    .bind(&[comment_id.as_str().into()])?
                    .first::<CommentRow>(None)
                    .await?
                    .map(Comment::from)
                else {
                    return Ok(());
                };
                if let (Some(item), Some(workspace)) =
                    (Self::correction_item(&pull, &comment), self.workspace_of(&pull.repo_id).await?)
                {
                    self.capture(&workspace, &[item], "g1t").await?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// The methods this module serves at `POST /rpc/<method>`.
pub(crate) const METHODS: [&str; 8] = [
    "capture_memories",
    "prune_doc_candidates",
    "report_learned",
    "list_candidates",
    "review_memory",
    "memories_by_id",
    "search_memories",
    "seed_from_pulls",
];

pub(crate) async fn dispatch(work: &Work, method: &str, body: serde_json::Value) -> Result<worker::Response> {
    use g1t_kit::{args, reply};
    match method {
        "capture_memories" => reply(&work.capture_memories(args(body)?).await?),
        "prune_doc_candidates" => reply(&work.prune_doc_candidates(args(body)?).await?),
        "report_learned" => reply(&work.report_learned(args(body)?).await?),
        "list_candidates" => reply(&work.list_candidates(args(body)?).await?),
        "review_memory" => reply(&work.review_memory(args(body)?).await?),
        "memories_by_id" => reply(&work.memories_by_id(args(body)?).await?),
        "search_memories" => reply(&work.search_memories(args(body)?).await?),
        "seed_from_pulls" => reply(&work.seed_from_pulls(args(body)?).await?),
        _ => worker::Response::error("Unknown method", 404),
    }
}

/// Captures what an event teaches. Never holds up the queue: a failure is
/// logged and the event goes on to its other handlers.
pub(crate) async fn on_event(work: &Work, event: &Event) {
    if let Err(error) = work.capture_event(event).await {
        worker::console_error!("capturing memory from {} {} failed: {error}", event.kind, event.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_correction_keeps_the_sentence_that_says_how() {
        let body = "Thanks for this! We use the shared `api` client instead of calling fetch directly. Otherwise looks fine.";
        assert_eq!(
            correction(body, false).as_deref(),
            Some("We use the shared `api` client instead of calling fetch directly.")
        );
    }

    #[test]
    fn questions_and_praise_teach_nothing() {
        assert_eq!(correction("Why not use the cache here?", false), None);
        assert_eq!(correction("LGTM, nice work.", false), None);
        assert_eq!(correction("> never do this\n\nok", false), None);
        assert_eq!(correction("```\nnever run this\n```", false), None);
    }

    #[test]
    fn a_request_for_changes_without_a_marker_keeps_its_first_sentence() {
        assert_eq!(
            correction("The migration has to be idempotent for D1 replays.", true).as_deref(),
            Some("The migration has to be idempotent for D1 replays.")
        );
        assert_eq!(correction("The migration has to be idempotent for D1 replays.", false), None);
    }

    #[test]
    fn a_decision_names_why_and_the_files() {
        let files: Vec<String> = (1..=8).map(|n| format!("src/f{n}.rs")).collect();
        let text = decision(
            12,
            "Keep the v1 webhook payload",
            Some("## Summary\n\nTwo customers still parse the v1 payload, so it stays alongside v2.\n\nMore detail."),
            &files,
        )
        .unwrap();
        assert!(text.starts_with("Decided in #12, \"Keep the v1 webhook payload\": Two customers still parse"));
        assert!(text.contains("src/f1.rs") && text.contains("and 2 more"));
        assert!(!text.contains("More detail"));
    }

    #[test]
    fn a_pull_request_that_says_only_its_title_decides_nothing() {
        assert_eq!(decision(3, "Fix typo", Some("Fix typo."), &[]), None);
        assert_eq!(decision(3, "Fix typo", None, &[]), None);
    }

    #[test]
    fn sources_are_counted_once_each() {
        assert_eq!(with_source("[\"run:a\"]", "run:a"), ["run:a"]);
        assert_eq!(with_source("[\"run:a\"]", "comment:b"), ["run:a", "comment:b"]);
        assert_eq!(with_source("not json", "doc:x"), ["doc:x"]);
    }

    fn existing(id: &str, text: &str, sources: &str) -> Existing {
        Existing { id: id.into(), status: "candidate".into(), sources: sources.into(), confidence: Some(0.7), text: text.into() }
    }

    #[test]
    fn the_same_thing_in_other_words_is_found() {
        let among = [
            existing("a", "Run cargo test in the crate you changed.", "[]"),
            existing("b", "g1t is a Cargo workspace (apps/api, crates/*, services/actions); `cargo test` runs its tests.", "[]"),
        ];
        assert_eq!(same_as(&among, "run cargo test in the crate you changed").map(|e| e.id.as_str()), Some("a"));
        assert_eq!(
            same_as(&among, "g1t is a Cargo workspace (apps/*, crates/*, services/*); `cargo test` runs its tests.").map(|e| e.id.as_str()),
            Some("b")
        );
        assert!(same_as(&among, "Use pnpm, never npm.").is_none());
    }

    #[test]
    fn a_candidate_cut_short_takes_its_doc_s_whole_words() {
        let cut = existing("a", "Work started by an automation cannot retrigger the", "[\"doc:r:CONTRIBUTING.md\"]");
        let whole = fingerprint("Work started by an automation cannot retrigger the same automation.");
        assert!(reworded_by(&cut, "doc:r:CONTRIBUTING.md", &whole));
        // Another source saying it is a sighting, not new words.
        assert!(!reworded_by(&cut, "run:x", &whole));
        // Kept memory keeps the words someone kept.
        let kept = Existing { status: "kept".into(), ..cut.clone() };
        assert!(!reworded_by(&kept, "doc:r:CONTRIBUTING.md", &whole));
        // The same words are not new ones.
        assert!(!reworded_by(&cut, "doc:r:CONTRIBUTING.md", &fingerprint(&cut.text)));
    }

    #[test]
    fn waiting_doc_candidates_the_docs_no_longer_suggest_are_let_go() {
        let candidates = [
            // Cut mid-sentence by the old reader; the docs now say it whole.
            existing("cut", "Run the whole suite before you push, every", "[\"doc:r:CONTRIBUTING.md\"]"),
            // From a plan, which is no longer read for memory.
            existing("plan", "Loop protection. Work started by an automation cannot retrigger the", "[\"doc:r:docs/PLAN.md\"]"),
            // Still suggested.
            existing("still", "`cargo test` in the crate or service you changed.", "[\"doc:r:CONTRIBUTING.md\"]"),
            // Seen by a run too: not the docs' alone to take back.
            existing("run", "Deduplication. The same Sentry issue firing 500 times maps to one", "[\"doc:r:docs/PLAN.md\",\"run:x\"]"),
        ];
        let texts = [
            "Run the whole suite before you push, every time, on every branch.".to_owned(),
            "`cargo test` in the crate or service you changed.".to_owned(),
        ];
        assert_eq!(unsuggested(&candidates, &texts), ["plan"]);
        assert!(only_from_docs("[\"doc:a\",\"doc:b\"]"));
        assert!(!only_from_docs("[]"));
        assert!(!only_from_docs("[\"doc:a\",\"review:b\"]"));
    }

    fn item(text: &str, evidence: Option<&str>) -> CaptureItem {
        CaptureItem {
            scope: MemoryScope::Project,
            repo_id: Some("rep_1".into()),
            kind: MemoryKind::Gotcha,
            text: text.into(),
            confidence: Some(0.6),
            source: CaptureSource::Run,
            reference: "run:1".into(),
            evidence: evidence.map(str::to_owned),
            number: None,
            run_id: None,
        }
    }

    #[test]
    fn secrets_are_refused_on_capture_in_text_and_evidence() {
        // Key-shaped values are joined at run time, as in the contracts' tests.
        let key = format!("{}{}", "gh", "p_abcdefghijklmnopqrstuvwxyz0123456789");
        assert!(checked(&item(&format!("Clone with {key} for the mirror."), None)).is_err());
        assert!(checked(&item("The mirror needs a token from the MIRROR_TOKEN secret.", Some(&format!("export T={key}")))).is_err());
        let (text, evidence) = checked(&item("  Tests need   TZ=UTC. ", Some("cargo test failed on dates"))).unwrap();
        assert_eq!(text, "Tests need TZ=UTC.");
        assert_eq!(evidence.as_deref(), Some("cargo test failed on dates"));
        assert!(checked(&item("short", None)).is_err());
    }
}
