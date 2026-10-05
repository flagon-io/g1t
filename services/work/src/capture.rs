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
//!   docs and manifests and sends what they say (`capture_memories`).
//!
//! The same thing said again, by an independent source, is one memory seen
//! twice, which keeps it (`promotes`). A dismissed memory stays dismissed,
//! so the same wording is never suggested again. Nothing that looks like a
//! secret is stored, in the text or in its evidence.

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
const NOT_PEOPLE: [&str; 3] = ["g1t-agent", "g1t", "agent"];

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

#[derive(Deserialize)]
struct Existing {
    id: String,
    status: String,
    sources: String,
    confidence: Option<f64>,
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
            let existing = self
                .db
                .prepare(
                    "SELECT id, status, sources, confidence FROM memories
                     WHERE scope = ? AND scope_key = ? AND (fingerprint = ? OR text = ?) LIMIT 1",
                )
                .bind(&[item.scope.as_str().into(), key.as_str().into(), print.as_str().into(), text.as_str().into()])?
                .first::<Existing>(None)
                .await?;
            if let Some(existing) = existing {
                done.merged += 1;
                if existing.status == MemoryStatus::Dismissed.as_str() {
                    continue;
                }
                let sources = with_source(&existing.sources, &item.reference);
                let confidence = match (existing.confidence, item.confidence) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (a, b) => a.or(b),
                };
                let keep = existing.status == MemoryStatus::Candidate.as_str()
                    && promotes(sources.len(), item.source, confidence);
                if keep {
                    done.kept += 1;
                }
                let status = if keep { MemoryStatus::Kept.as_str() } else { existing.status.as_str() };
                self.db
                    .prepare(
                        "UPDATE memories SET sources = ?, confidence = ?, status = ?, fingerprint = ?, updated_at = ?
                         WHERE id = ?",
                    )
                    .bind(&[
                        serde_json::to_string(&sources)?.into(),
                        confidence.map_or(JsValue::NULL, JsValue::from),
                        status.into(),
                        print.as_str().into(),
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
            self.memory_changed(&id, &workspace, status.as_str(), repo.as_deref()).await;
        }
        Ok(done)
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
        Ok(Outcome::Ok(self.capture(&run.workspace, &items, "g1t-agent").await?))
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
            .prepare("SELECT * FROM pulls WHERE repo_id = ? AND status = 'merged' ORDER BY merged_at DESC LIMIT ?")
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
pub(crate) const METHODS: [&str; 7] = [
    "capture_memories",
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
