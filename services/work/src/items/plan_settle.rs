//! The plan reads itself (migrations/0057_plan_reads_itself.sql), on the
//! service's cron, a little at a time:
//!
//! - A work item in Triage gets a suggestion of where it goes: a horizon,
//!   an appetite, an open work item it seems to repeat, and why, asked once
//!   of the workspace's own AI provider through integrations' `ai_brief`
//!   (g1t runs no model of its own). A person accepts it or not.
//! - A work item in Now gets a sentence or two on where it stands, drafted
//!   from its record (sessions, decisions, pull requests) whenever
//!   something new has happened on it.
//! - A work item in Later with nothing happening on it for
//!   [`SET_ASIDE_DAYS`] is set aside, saying so in its conversation.
//!
//! A workspace with no provider chosen gets no suggestions and no drafts;
//! the rest of the plan works the same without them.

use std::collections::HashSet;

use g1t_contracts::ai::{AiBriefArgs, MAX_BRIEF_INPUT_CHARS, MAX_BRIEF_TOKENS};
use g1t_contracts::events::WorkItemEvent;
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::Outcome;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use super::plan::days_before;
use crate::Work;

/// The most the provider is asked in one run of the cron, across
/// workspaces: suggestions and drafts together.
const CALLS_PER_RUN: u32 = 12;
/// The most set aside in one run.
const SET_ASIDE_PER_RUN: u32 = 50;
/// The most of the plan a suggestion is asked with.
const PLAN_LINES: u32 = 80;
/// The longest suggestion reason and standing kept, in characters.
const WHY_CHARS: usize = 240;
const STANDING_CHARS: usize = 320;

const SUGGEST_SYSTEM: &str = "You place a new work item in a software team's plan. \
The horizons: now (what the team is on; only for something urgent or blocking), \
next (ranked, taken soon), later (wanted, not soon). \
The appetites: small (one session), medium (a few sessions, about a week), large (a phase to break into smaller items). \
If it repeats one of the open work items listed, give that one's number. \
Answer in exactly four lines and nothing else:\n\
horizon: now|next|later\n\
appetite: small|medium|large\n\
duplicate: <number or none>\n\
why: <one plain sentence>";

const STANDING_SYSTEM: &str = "From the record given, say where this piece of work stands now and what comes next, \
in one or two plain sentences. No preamble, no lists, no headings. Name pull requests and work items as #N.";

/// What one run may still ask the provider, and the workspaces that have
/// none (asked again on the next run).
struct Budget {
    calls: u32,
    without: HashSet<String>,
}

/// A suggestion read from the provider's answer: none when it does not
/// say a horizon it may suggest. `known` are the open work items it may
/// say this one repeats.
pub(crate) fn read_suggestion(answer: &str, known: &[u32], at: &str) -> Option<PlanSuggestion> {
    // Some models answer with a JSON object instead of the four lines.
    let json = answer.find('{').zip(answer.rfind('}')).and_then(|(open, close)| serde_json::from_str::<serde_json::Value>(&answer[open..=close]).ok());
    if let Some(serde_json::Value::Object(fields)) = json {
        let text = |key: &str| match fields.get(key) {
            Some(serde_json::Value::String(text)) => text.clone(),
            Some(serde_json::Value::Number(number)) => number.to_string(),
            _ => String::new(),
        };
        let lines = format!(
            "horizon: {}\nappetite: {}\nduplicate: {}\nwhy: {}",
            text("horizon"),
            text("appetite"),
            if text("duplicate").is_empty() { text("duplicate_of") } else { text("duplicate") },
            text("why")
        );
        return read_lines(&lines, known, at);
    }
    read_lines(answer, known, at)
}

/// [`read_suggestion`] of the four `key: value` lines.
fn read_lines(answer: &str, known: &[u32], at: &str) -> Option<PlanSuggestion> {
    let mut horizon = None;
    let mut appetite = None;
    let mut duplicate_of = None;
    let mut why = String::new();
    for line in answer.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(|c: char| c == '*' || c == '`' || c == '"').trim();
        match key.trim().trim_matches(|c: char| c == '*' || c == '-' || c == '#' || c == '"').trim().to_ascii_lowercase().as_str() {
            "horizon" => horizon = Horizon::parse(value).filter(|h| matches!(h, Horizon::Now | Horizon::Next | Horizon::Later)),
            "appetite" => appetite = Appetite::parse(value),
            "duplicate" => {
                duplicate_of = value.trim_start_matches('#').parse::<u32>().ok().filter(|number| known.contains(number));
            }
            "why" => why = clip(value, WHY_CHARS),
            _ => {}
        }
    }
    Some(PlanSuggestion { horizon: horizon?, appetite, duplicate_of, why, at: at.to_owned() })
}

/// `text` on one line, at most `limit` characters, cut at a word.
pub(crate) fn clip(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= limit {
        return flat;
    }
    let cut: String = flat.chars().take(limit).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head).trim_end_matches([',', ';', ':', '.']);
    format!("{cut}…")
}

/// A drafted standing as kept: one paragraph, bounded; none when the
/// answer has nothing in it.
pub(crate) fn read_standing(answer: &str) -> Option<String> {
    // A list marker or bold the model put in front, never a #N it begins with.
    let trimmed = answer.trim();
    let trimmed = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")).unwrap_or(trimmed).trim_matches('*');
    let text = clip(trimmed, STANDING_CHARS);
    (!text.is_empty()).then_some(text)
}

#[derive(Deserialize)]
struct Pending {
    id: String,
    workspace: String,
    number: u32,
    title: String,
    body: String,
    #[serde(default)]
    origin: Option<String>,
}

#[derive(Deserialize)]
struct PlanLine {
    number: u32,
    horizon: String,
    title: String,
}

#[derive(Deserialize)]
struct Line {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    number: Option<u32>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Deserialize)]
struct Stale {
    id: String,
}

impl Work {
    /// One run of the plan's upkeep: sets aside what has waited too long in
    /// Later, then suggests and drafts within the run's budget.
    pub(crate) async fn settle_plan(&self) -> Result<()> {
        self.set_aside_stale().await?;
        let mut budget = Budget { calls: CALLS_PER_RUN, without: HashSet::new() };
        self.suggest_triage(&mut budget).await?;
        self.draft_standings(&mut budget).await?;
        Ok(())
    }

    /// Asks the workspace's provider, within `budget`. None when it has no
    /// provider, or could not answer (said in the log).
    async fn brief(&self, workspace: &str, system: &str, input: String, max_tokens: u32, budget: &mut Budget) -> Option<String> {
        if budget.calls == 0 || budget.without.contains(workspace) {
            return None;
        }
        let integrations = self.integrations.as_ref()?;
        budget.calls -= 1;
        let input: String = input.chars().take(MAX_BRIEF_INPUT_CHARS).collect();
        let args = AiBriefArgs { workspace: workspace.to_owned(), system: system.to_owned(), input, max_tokens };
        match g1t_kit::call::<_, Outcome<Option<String>>>(integrations, "ai_brief", &args).await {
            Ok(Outcome::Ok(Some(answer))) => Some(answer),
            Ok(Outcome::Ok(None)) => {
                worker::console_log!("{workspace}: the plan got no answer from the AI provider (none chosen, or an empty answer)");
                budget.without.insert(workspace.to_owned());
                None
            }
            Ok(Outcome::Fail(failure)) => {
                worker::console_error!("{workspace}: the plan got no answer from the AI provider: {}", failure.message);
                budget.without.insert(workspace.to_owned());
                None
            }
            Err(error) => {
                worker::console_error!("{workspace}: the plan got no answer from the AI provider: {error}");
                budget.without.insert(workspace.to_owned());
                None
            }
        }
    }

    /// Sets aside what has had nothing happen on it in Later for
    /// [`SET_ASIDE_DAYS`].
    async fn set_aside_stale(&self) -> Result<()> {
        let now = now_ms();
        let before = days_before(now, SET_ASIDE_DAYS);
        let stale = self
            .db
            .prepare(
                "SELECT id FROM work_items
                 WHERE state = 'open' AND horizon = 'later' AND number IS NOT NULL
                   AND max(updated_at, COALESCE(planned_at, '')) < ?1
                 LIMIT ?2",
            )
            .bind(&[before.as_str().into(), SET_ASIDE_PER_RUN.into()])?
            .all()
            .await?
            .results::<Stale>()?;
        let at = rfc3339(now);
        for row in stale {
            self.db
                .prepare("UPDATE work_items SET horizon = 'set_aside', rank = NULL, planned_at = ?1 WHERE id = ?2 AND horizon = 'later'")
                .bind(&[at.as_str().into(), row.id.as_str().into()])?
                .run()
                .await?;
            let Some(held) = self.item_by_id(&row.id).await? else {
                continue;
            };
            self.publish_item(
                "work_item.planned",
                &held,
                None,
                WorkItemEvent {
                    horizon: Some(Horizon::SetAside),
                    from_horizon: Some(Horizon::Later),
                    appetite: held.item.appetite,
                    urgent: Some(false),
                    ..Self::item_event(&held)
                },
            )
            .await?;
            self.note_item(
                &row.id,
                (g1t_contracts::identity::AGENT_ID, "g1t"),
                &format!("set this aside: nothing happened on it in Later for {SET_ASIDE_DAYS} days"),
            )
            .await?;
        }
        Ok(())
    }

    /// Suggests where new work items in Triage go, the newest first.
    async fn suggest_triage(&self, budget: &mut Budget) -> Result<()> {
        let pending = self
            .db
            .prepare(
                "SELECT w.id, w.workspace, w.number, w.title, w.body,
                   (SELECT COALESCE(rw.path, o.path) FROM work_item_repos o LEFT JOIN repo_workspaces rw ON rw.repo_id = o.repo_id
                    WHERE o.item_id = w.id AND o.role = 'origin') AS origin
                 FROM work_items w
                 WHERE w.state = 'open' AND COALESCE(w.horizon, 'triage') = 'triage' AND w.suggested_at IS NULL
                   AND w.number IS NOT NULL
                 ORDER BY w.created_at DESC LIMIT ?1",
            )
            .bind(&[budget.calls.into()])?
            .all()
            .await?
            .results::<Pending>()?;
        for item in pending {
            if budget.calls == 0 {
                break;
            }
            let plan = self
                .db
                .prepare(
                    "SELECT number, COALESCE(horizon, 'triage') AS horizon, title FROM work_items
                     WHERE workspace = ?1 AND state = 'open' AND number IS NOT NULL AND id <> ?2
                     ORDER BY CASE COALESCE(horizon, 'triage') WHEN 'now' THEN 0 WHEN 'next' THEN 1 WHEN 'later' THEN 2
                       WHEN 'triage' THEN 3 ELSE 4 END, rank IS NULL, rank, number DESC
                     LIMIT ?3",
                )
                .bind(&[item.workspace.as_str().into(), item.id.as_str().into(), PLAN_LINES.into()])?
                .all()
                .await?
                .results::<PlanLine>()?;
            let known: Vec<u32> = plan.iter().map(|line| line.number).collect();
            let listed: Vec<String> = plan.iter().map(|line| format!("#{} [{}] {}", line.number, line.horizon, line.title)).collect();
            let input = format!(
                "New work item #{}{}: {}\n\n{}\n\nOpen work items:\n{}",
                item.number,
                item.origin.as_deref().map(|path| format!(" (filed in {path})")).unwrap_or_default(),
                item.title,
                clip(&item.body, 1_500),
                listed.join("\n")
            );
            let at = rfc3339(now_ms());
            let answer = self.brief(&item.workspace, SUGGEST_SYSTEM, input, MAX_BRIEF_TOKENS, budget).await;
            if answer.is_none() && !budget.without.contains(&item.workspace) {
                // Out of calls for this run: asked again on the next.
                break;
            }
            let suggestion = answer.as_deref().and_then(|answer| read_suggestion(answer, &known, &at));
            if let (Some(answer), None) = (&answer, &suggestion) {
                worker::console_log!("{}#{}: the AI provider's suggestion did not read: {}", item.workspace, item.number, clip(answer, 300));
            }
            // Asked once: with no provider, or no usable answer, it is not
            // asked again.
            self.db
                .prepare("UPDATE work_items SET suggestion = ?1, suggested_at = ?2 WHERE id = ?3")
                .bind(&[
                    suggestion.as_ref().map(serde_json::to_string).transpose()?.map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                    at.as_str().into(),
                    item.id.as_str().into(),
                ])?
                .run()
                .await?;
        }
        Ok(())
    }

    /// Drafts where work items in Now stand, those with something new
    /// since their last draft first.
    async fn draft_standings(&self, budget: &mut Budget) -> Result<()> {
        #[derive(Deserialize)]
        struct Due {
            id: String,
            workspace: String,
            number: u32,
            title: String,
        }
        let due = self
            .db
            .prepare(
                "SELECT id, workspace, number, title FROM (
                   SELECT w.id, w.workspace, w.number, w.title, w.standing_at,
                     max(COALESCE((SELECT max(s.last_seen_at) FROM sessions s WHERE s.item_id = w.id), ''),
                         COALESCE((SELECT max(d.created_at) FROM decisions d WHERE d.item_id = w.id), ''),
                         COALESCE((SELECT max(p.updated_at) FROM pulls p WHERE p.item_id = w.id), '')) AS active_at
                   FROM work_items w WHERE w.state = 'open' AND w.horizon = 'now' AND w.number IS NOT NULL)
                 WHERE active_at <> '' AND (standing_at IS NULL OR standing_at < active_at)
                 ORDER BY active_at DESC LIMIT ?1",
            )
            .bind(&[budget.calls.into()])?
            .all()
            .await?
            .results::<Due>()?;
        for item in due {
            if budget.calls == 0 {
                break;
            }
            let key = [worker::wasm_bindgen::JsValue::from(item.id.as_str())];
            let statements = vec![
                self.db
                    .prepare("SELECT title, state, result FROM sessions WHERE item_id = ?1 ORDER BY last_seen_at DESC LIMIT 5")
                    .bind(&key)?,
                self.db.prepare("SELECT summary FROM decisions WHERE item_id = ?1 ORDER BY created_at DESC LIMIT 5").bind(&key)?,
                self.db.prepare("SELECT number, status, title FROM pulls WHERE item_id = ?1 ORDER BY created_at DESC LIMIT 5").bind(&key)?,
            ];
            let results = self.db.batch(statements).await?;
            let lines = |index: usize| -> Result<Vec<Line>> {
                results.get(index).map_or_else(|| Ok(Vec::new()), |result| result.results::<Line>())
            };
            let sessions: Vec<String> = lines(0)?
                .into_iter()
                .map(|line| {
                    let result = line.result.as_deref().map(|text| format!(": {}", clip(text, 300))).unwrap_or_default();
                    format!("- {} ({}){result}", line.title.unwrap_or_else(|| "Untitled session".into()), line.state.unwrap_or_default())
                })
                .collect();
            let decisions: Vec<String> = lines(1)?.into_iter().filter_map(|line| line.summary).map(|summary| format!("- {}", clip(&summary, 300))).collect();
            let pulls: Vec<String> = lines(2)?
                .into_iter()
                .map(|line| format!("- #{} {} ({})", line.number.unwrap_or_default(), line.title.unwrap_or_default(), line.status.unwrap_or_default()))
                .collect();
            let none = || "- none".to_owned();
            let input = format!(
                "Work item #{}: {}\n\nSessions, newest first:\n{}\n\nDecisions, newest first:\n{}\n\nPull requests:\n{}",
                item.number,
                item.title,
                if sessions.is_empty() { none() } else { sessions.join("\n") },
                if decisions.is_empty() { none() } else { decisions.join("\n") },
                if pulls.is_empty() { none() } else { pulls.join("\n") },
            );
            let answer = self.brief(&item.workspace, STANDING_SYSTEM, input, MAX_BRIEF_TOKENS, budget).await;
            if answer.is_none() && !budget.without.contains(&item.workspace) {
                break;
            }
            // With no provider, the time is still kept, so it is asked again
            // only when something new happens.
            let standing = answer.as_deref().and_then(read_standing);
            self.db
                .prepare("UPDATE work_items SET standing = COALESCE(?1, standing), standing_at = ?2 WHERE id = ?3")
                .bind(&[
                    standing.map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                    rfc3339(now_ms()).into(),
                    item.id.as_str().into(),
                ])?
                .run()
                .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_suggestion_is_read_from_the_four_lines() {
        let at = "2026-10-20T00:00:00Z";
        let answer = "horizon: next\nappetite: small\nduplicate: #12\nwhy: It is a small fix to Home that others wait on.";
        let read = read_suggestion(answer, &[12, 14], at).unwrap();
        assert_eq!(read.horizon, Horizon::Next);
        assert_eq!(read.appetite, Some(Appetite::Small));
        assert_eq!(read.duplicate_of, Some(12));
        assert_eq!(read.why, "It is a small fix to Home that others wait on.");
        // Markdown around it, and a number not in the plan.
        let read = read_suggestion("**Horizon:** Later\n- Appetite: L\nDuplicate: 99\nWhy: Big.", &[12], at).unwrap();
        assert_eq!((read.horizon, read.appetite, read.duplicate_of), (Horizon::Later, Some(Appetite::Large), None));
        // A horizon it may not suggest, or none: no suggestion.
        assert_eq!(read_suggestion("horizon: set_aside\nwhy: old", &[], at), None);
        assert_eq!(read_suggestion("I think this should go next.", &[], at), None);
        // A JSON object, in a code fence or not.
        let json = "```json\n{\"horizon\": \"next\", \"appetite\": \"medium\", \"duplicate\": 12, \"why\": \"Same as #12.\"}\n```";
        let read = read_suggestion(json, &[12], at).unwrap();
        assert_eq!((read.horizon, read.appetite, read.duplicate_of, read.why.as_str()), (Horizon::Next, Some(Appetite::Medium), Some(12), "Same as #12."));
        let read = read_suggestion("{\"horizon\":\"later\",\"appetite\":\"small\",\"duplicate\":null,\"why\":\"Nice to have.\"}", &[], at).unwrap();
        assert_eq!((read.horizon, read.duplicate_of), (Horizon::Later, None));
        // Keys in quotes or headings.
        let read = read_suggestion("## Horizon: next\n\"appetite\": small\nwhy: ok", &[], at).unwrap();
        assert_eq!((read.horizon, read.appetite), (Horizon::Next, Some(Appetite::Small)));
    }

    #[test]
    fn what_is_kept_is_one_bounded_line() {
        assert_eq!(clip("Two   words\nhere", 50), "Two words here");
        let long = "word ".repeat(100);
        let clipped = clip(&long, 30);
        assert!(clipped.chars().count() <= 31 && clipped.ends_with('…'), "{clipped}");
        assert_eq!(read_standing("  \n "), None);
        assert_eq!(read_standing("- #205 merged; the plan is live. Next: place the backlog.").as_deref(), Some("#205 merged; the plan is live. Next: place the backlog."));
    }
}
