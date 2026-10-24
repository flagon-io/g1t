//! Session titles that settle: named from the whole of a session's record
//! by g1t, not chased turn by turn by its agent.
//!
//! A title says where it came from (`TitleSource`):
//!
//! - **prompt**: provisional. The first prompt with an intent names a
//!   session as it records it ([`prompted_sql`]), until g1t settles one.
//! - **agent**: its harness or agent named it (`g1t session attach
//!   --title`). Kept, unless the session went on to other work items or
//!   pull requests after it was named, when it is settled again as it
//!   ends. Its agent naming it again what g1t already calls it changes
//!   nothing.
//! - **person**: named from the site: pinned, never replaced by g1t or
//!   the agent.
//! - **item**, **pull**, **summary**: settled by g1t.
//!
//! g1t settles a title when one is due (`title_due_at`), in the cron
//! ([`Work::settle_titles`]):
//!
//! 1. once there is enough to go on: the session was tied to a work item
//!    or pull request in a way that means it works on it (attached,
//!    claimed, opened, pushed, a commit or trailer; not a `#N` mention),
//!    it recorded [`PROMPTS_TO_SETTLE`] prompts, or
//!    [`SETTLE_AFTER_MINUTES`] passed since its title was provisional;
//! 2. again only when what it works on changed (another work item or pull
//!    request, or its prompts grew past [`more_prompts`]), at most every
//!    [`RESETTLE_MINUTES`], and only when the new title differs from the
//!    one it has in more than wording ([`similar`]);
//! 3. a last time as it ends, from everything it did (`title_final`).
//!
//! The title is the workspace's AI provider's (the one Ask answers with,
//! asked through integrations' `ai_brief` on its fast model) when the
//! record is more than one work item or pull request, with a bounded
//! digest of the record ([`digest`]): prompts as recorded (credentials
//! already out), the work items and pull requests, subagents' tasks,
//! where it changed files, its commits and what it reported. At most
//! [`MAX_AI_CALLS`] per session. Without a provider, or when it fails,
//! [`fallback`]: the work item's title, else the pull request's, else
//! what the most telling prompt asks for, without its preamble.
//!
//! A subagent keeps its task as what it is called and is never titled.

use std::collections::{HashMap, HashSet};

use g1t_contracts::Outcome;
use g1t_contracts::ai::{AiBriefArgs, MAX_BRIEF_INPUT_CHARS};
use g1t_contracts::repos::{PathByIdArgs, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_kit::now_ms;
use serde::Deserialize;
use worker::Result;

use super::{SessionRow, shown};
use crate::Work;

/// Prompts after which a provisional title is settled.
pub(crate) const PROMPTS_TO_SETTLE: u32 = 3;
/// Minutes after which a provisional title is settled, prompts or not.
pub(crate) const SETTLE_AFTER_MINUTES: u32 = 30;
/// The least time between two settles of one session's title.
pub(crate) const RESETTLE_MINUTES: u32 = 20;
/// The most times one session's title is asked of the AI provider.
pub(crate) const MAX_AI_CALLS: u32 = 5;
/// The most AI calls one cron run makes.
const RUN_AI_CALLS: u32 = 8;
/// The most sessions one cron run settles that became due lately, and
/// that were due long ago (the backfill).
const RUN_LIVE: u32 = 15;
const RUN_BACKFILL: u32 = 40;
/// How long a due title counts as live, not backfill.
const LIVE_MS: u64 = 24 * 60 * 60 * 1000;
/// The longest title g1t gives.
pub(crate) const TITLE_CHARS: usize = 80;
/// The most prompts, and characters of each, a digest holds.
const DIGEST_PROMPTS: usize = 6;
const DIGEST_PROMPT_CHARS: usize = 400;

/// What the AI provider is told.
pub(crate) const SYSTEM: &str = "You name a coding session for its team's list of work. Reply with only a title of 3-8 words naming the whole of the work the session did, in the team's terms (use a work item's wording when it fits), no trailing period, no quotes, no prefix.";

/// The time `minutes` after `column`, as stored, or `now` (`?N`) when later.
fn not_before(now: &str, column: &str, minutes: u32) -> String {
    format!("MAX({now}, COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', {column}, '+{minutes} minutes'), {now}))")
}

/// The prompts after which a settled title is due again: twice as many as
/// it was settled with, five more at least.
pub(crate) fn more_prompts(settled_with: u32) -> u32 {
    settled_with + settled_with.max(5)
}

/// SQL to set as a session ends at `at` (an expression): its title is due
/// a last time, unless it is a subagent's or pinned.
pub(crate) fn final_due(at: &str) -> String {
    format!("title_due_at = CASE WHEN parent_id IS NULL AND COALESCE(title_source, '') <> 'person' THEN {at} ELSE title_due_at END")
}

/// Session `?1` recorded `?2` prompts, the first of them with intent `?3`
/// (or none), at `?4`; `?5` is `?4` plus [`SETTLE_AFTER_MINUTES`]. An
/// untitled session at the top of its tree takes the intent as its
/// provisional title; a provisional one is due at `?5`, or now once it
/// has [`PROMPTS_TO_SETTLE`] prompts; a settled one is due again once its
/// prompts grew past [`more_prompts`], not before [`RESETTLE_MINUTES`].
pub(crate) fn prompted_sql() -> String {
    format!(
        "UPDATE sessions SET prompts = prompts + ?2,
           title = CASE WHEN title IS NULL AND parent_id IS NULL THEN ?3 ELSE title END,
           title_source = CASE WHEN title IS NULL AND parent_id IS NULL AND ?3 IS NOT NULL THEN 'prompt' ELSE title_source END,
           title_due_at = CASE
             WHEN parent_id IS NOT NULL OR title_final = 1 OR title_source IN ('person', 'agent') THEN title_due_at
             WHEN title IS NULL OR title_source IS NULL OR title_source = 'prompt' THEN
               CASE WHEN prompts + ?2 >= {PROMPTS_TO_SETTLE} THEN ?4 ELSE COALESCE(title_due_at, ?5) END
             WHEN title_due_at IS NULL AND prompts + ?2 >= title_prompts + MAX(title_prompts, 5) THEN {later}
             ELSE title_due_at END
         WHERE id = ?1",
        later = not_before("?4", "title_settled_at", RESETTLE_MINUTES),
    )
}

/// Session `?1` was tied, at `?2`, to a work item or pull request it works
/// on: a provisional title is due now, a settled one again not before
/// [`RESETTLE_MINUTES`] after it settled. Not a subagent's, a pinned one
/// or its agent's (settled as it ends), nor one settled for good.
pub(crate) fn linked_sql() -> String {
    let due = format!(
        "CASE WHEN title_source IN ('item', 'pull', 'summary') THEN {} ELSE ?2 END",
        not_before("?2", "title_settled_at", RESETTLE_MINUTES)
    );
    format!(
        "UPDATE sessions SET title_due_at = MIN(COALESCE(title_due_at, {due}), {due})
         WHERE id = ?1 AND parent_id IS NULL AND title_final = 0
           AND COALESCE(title_source, '') NOT IN ('person', 'agent')"
    )
}

/// A title its agent gives (`?5` of the heartbeat): pinned ones keep
/// theirs. `?13` is where it came from ([`given_source`]), `?11` now. An
/// agent saying again the title it gave changes nothing: it settled when
/// first given, and is as stale as it was.
pub(crate) const SET_TITLE: &str = "title = CASE WHEN ?5 IS NULL OR title_source = 'person' THEN title ELSE ?5 END,
     title_due_at = CASE WHEN ?5 IS NULL OR title_source = 'person' OR ?13 <> 'agent'
         OR (title_source = 'agent' AND lower(title) = lower(?5)) THEN title_due_at ELSE NULL END,
     title_settled_at = CASE WHEN ?5 IS NULL OR title_source = 'person' OR ?13 <> 'agent'
         OR (title_source = 'agent' AND lower(title) = lower(?5)) THEN title_settled_at ELSE ?11 END,
     title_source = CASE WHEN ?5 IS NULL OR title_source = 'person' THEN title_source ELSE ?13 END";

/// A person names session `?3` `?1` at `?2`: pinned.
pub(crate) const PIN_TITLE: &str = "UPDATE sessions SET title = ?1, title_source = 'person', title_settled_at = ?2, title_due_at = NULL
     WHERE id = ?3";

/// A person unpins session `?2`'s title at `?1`: g1t names it again.
pub(crate) const UNPIN_TITLE: &str = "UPDATE sessions SET title_source = 'prompt', title_due_at = ?1, title_final = 0
     WHERE id = ?2 AND title_source = 'person'";

/// Where a title an agent gives came from: its agent's, unless it is what
/// the session is provisionally called already (an older plugin echoing
/// the first prompt's intent back), which stays provisional.
pub(crate) fn given_source(given: &str, current: Option<&str>, source: Option<TitleSource>) -> TitleSource {
    match (current, source) {
        (Some(current), None | Some(TitleSource::Prompt)) if same_words(given, current) => TitleSource::Prompt,
        (Some(current), Some(kept)) if kept.settled() && same_words(given, current) => kept,
        _ => TitleSource::Agent,
    }
}

// --- Reading prompts ---------------------------------------------------------

/// Removes each `<open…>…</close>` block (to the end when it is not closed).
fn drop_blocks(text: &str, open: &str, close: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let lower = text.to_ascii_lowercase();
    let mut at = 0;
    while let Some(found) = lower[at..].find(open) {
        let start = at + found;
        // `<pasted_content` must be the tag itself, not a longer name.
        let next = lower[start + open.len()..].chars().next();
        if next.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            out.push_str(&text[at..start + open.len()]);
            at = start + open.len();
            continue;
        }
        out.push_str(&text[at..start]);
        out.push('\n');
        match lower[start..].find(close) {
            Some(end) => {
                let after = start + end + close.len();
                // The rest of the closing tag.
                at = lower[after..].find('>').map_or(after, |gt| after + gt + 1);
            }
            None => {
                at = text.len();
            }
        }
    }
    out.push_str(&text[at..]);
    out
}

/// Removes `[Image #1]` and `[Image: source: …]` placeholders.
fn drop_images(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("[Image") {
        out.push_str(&rest[..start]);
        let tail = &rest[start + "[Image".len()..];
        let ok = tail.starts_with(']') || tail.starts_with(" #") || tail.starts_with(':');
        match (ok, tail.find(']')) {
            (true, Some(end)) if !tail[..end].contains('\n') => {
                out.push(' ');
                rest = &tail[end + 1..];
            }
            _ => {
                out.push_str("[Image");
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Whether `text` starts with a tag like `<command-name>` or `<task-notification id="…">`.
fn starts_with_tag(text: &str) -> bool {
    let text = text.trim_start();
    let Some(rest) = text.strip_prefix('<') else { return false };
    let mut chars = rest.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    for c in chars {
        if c == '>' {
            return true;
        }
        if !(c.is_alphanumeric() || c == '-' || c == '_') {
            return c.is_whitespace() && rest.contains('>');
        }
    }
    false
}

/// Context a harness or an editor puts before what was typed, a whole
/// block at a time: `<ide_opened_file>`, `<system-reminder>`, Claude Code's
/// `<browser_instruction>`. Their names have an underscore or a hyphen,
/// which a tag someone types (`<div>`) does not.
fn drop_leading_context(mut text: String) -> String {
    loop {
        let trimmed = text.trim_start();
        let lower = trimmed.to_ascii_lowercase();
        let Some(after) = lower.strip_prefix('<') else { return text };
        let name: String = after.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
        if !name.starts_with(|c: char| c.is_ascii_alphabetic()) || !name.contains(['_', '-']) {
            return text;
        }
        let close = format!("</{name}>");
        match lower.find(&close) {
            Some(end) => text = trimmed[end + close.len()..].to_owned(),
            None => return text,
        }
    }
}

/// Removes fenced code (``` and ~~~), to the end when a fence is not closed.
fn drop_fences(text: &str, fence: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(fence) {
        out.push_str(&rest[..start]);
        out.push('\n');
        let after = &rest[start + fence.len()..];
        match after.find(fence) {
            Some(end) => rest = &after[end + fence.len()..],
            None => rest = "",
        }
    }
    out.push_str(rest);
    out
}

/// Markdown links and images as their text, inline code as itself.
fn unmark(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let image = c == '!' && chars.get(i + 1) == Some(&'[');
        if c == '[' || image {
            let open = if image { i + 1 } else { i };
            if let Some(close) = chars[open + 1..].iter().position(|&c| c == ']').map(|p| open + 1 + p)
                && chars.get(close + 1) == Some(&'(')
                && let Some(end) = chars[close + 2..].iter().position(|&c| c == ')').map(|p| close + 2 + p)
            {
                out.extend(&chars[open + 1..close]);
                i = end + 1;
                continue;
            }
        }
        if c != '`' {
            out.push(c);
        }
        i += 1;
    }
    out
}

/// A line without its list, heading or quote markers and its emphasis.
fn bare_line(line: &str) -> String {
    let mut line = line.trim_start();
    loop {
        let hashes = line.chars().take_while(|&c| c == '#').count();
        let digits = line.chars().take_while(char::is_ascii_digit).count();
        let spaced = |at: usize| line[at..].starts_with(char::is_whitespace);
        line = if (1..=6).contains(&hashes) && spaced(hashes) {
            line[hashes..].trim_start()
        } else if let Some(rest) = line.strip_prefix('>') {
            rest.trim_start()
        } else if line.starts_with(['-', '*', '+']) && spaced(1) {
            line[1..].trim_start()
        } else if digits > 0 && line[digits..].starts_with(['.', ')']) && spaced(digits + 1) {
            line[digits + 1..].trim_start()
        } else {
            break;
        };
    }
    line.replace("**", "").replace("__", "").replace("~~", "").trim().to_owned()
}

/// A prompt as words to read: what was pasted or attached, editor
/// context, code and markdown taken out. None for a slash command or a
/// turn the harness started itself.
pub(crate) fn readable(prompt: &str) -> Option<String> {
    let text = prompt.trim_start_matches('\u{feff}');
    let text = drop_blocks(text, "<pasted_content", "</pasted_content");
    let text = drop_images(&text);
    let text = drop_leading_context(text);
    if text.trim_start().starts_with('/') || starts_with_tag(&text) {
        return None;
    }
    let text = drop_fences(&drop_fences(&text, "```"), "~~~");
    Some(unmark(&text))
}

/// The lines of a readable prompt that say something.
fn lines(text: &str) -> Vec<String> {
    text.lines().map(bare_line).filter(|line| line.chars().any(char::is_alphanumeric)).collect()
}

/// Sentences: up to a stop followed by a space.
fn sentences(text: &str) -> Vec<String> {
    let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        current.push(c);
        if matches!(c, '.' | '!' | '?') && chars.get(i + 1) == Some(&' ') && chars.get(i + 2).is_some() {
            out.push(current.trim().to_owned());
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_owned());
    }
    out
}

/// Cut to `limit` characters on a word, with "…"; trailing stops off.
fn clip_title(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.chars().count() > limit {
        let cut: String = text.chars().take(limit - 1).collect();
        let at = cut.rfind(' ').filter(|&space| space > limit / 2).unwrap_or(cut.len());
        format!("{}…", cut[..at].trim_end_matches([' ', ',', ';', ':', '.', '-', '–', '—']))
    } else {
        text.trim_end_matches([' ', ',', ';', ':', '.']).to_owned()
    }
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// What a prompt is for, as its session's provisional title: its first
/// line's first sentence, clipped at [`TITLE_CHARS`] on a word. Reads a
/// prompt as the Claude Code plugin's `intentTitle` did, and the site's
/// does still (apps/web/app/lib/coordination.ts).
pub(crate) fn intent_title(prompt: &str) -> Option<String> {
    let text = readable(prompt)?;
    let line = lines(&text).into_iter().next()?;
    let first = sentences(&line).into_iter().next()?;
    let intent = clip_title(&first, TITLE_CHARS);
    (intent.chars().count() >= 2).then(|| capitalized(&intent))
}

/// Words a sentence starts with that say nothing of the work, taken off
/// its front (longest first among those that share a start).
const FILLERS: &[&str] = &[
    "it would be great if you could",
    "it'd be great if you could",
    "i would like you to",
    "i'd like you to",
    "i want you to",
    "i need you to",
    "would you please",
    "could you please",
    "can you please",
    "go ahead and",
    "i would like to",
    "i'd like to",
    "i feel like",
    "i was thinking",
    "what i want is to",
    "i want to",
    "we need to",
    "we should",
    "you should",
    "i think",
    "i believe",
    "i guess",
    "can you",
    "could you",
    "would you",
    "will you",
    "can we",
    "could we",
    "help me",
    "let's",
    "lets",
    "please",
    "so",
    "ok",
    "okay",
    "alright",
    "all right",
    "well",
    "hey",
    "hi",
    "hello",
    "now",
    "basically",
    "actually",
    "also",
    "and",
    "but",
    "then",
    "next",
    "right",
    "great",
    "thanks",
    "thank you",
    "cool",
    "nice",
    "perfect",
    "awesome",
    "yes",
    "yeah",
    "sure",
];

/// How a sentence starts when it sets the scene instead of asking.
const PREAMBLES: &[&str] = &[
    "this project",
    "this repo",
    "this repository",
    "this codebase",
    "this code",
    "this used to",
    "this was",
    "this is",
    "it used to",
    "we used to",
    "i used to",
    "used to",
    "there is",
    "there are",
    "there was",
    "there were",
    "currently",
    "right now",
    "at the moment",
    "as you know",
    "for context",
    "context",
    "background",
    "fyi",
    "i noticed",
    "i see",
    "i saw",
    "i was",
    "i am",
    "i'm",
    "i have",
    "i've",
    "we have",
    "we've",
    "we were",
    "it looks like",
    "looks like",
    "it seems",
    "it's",
    "it is",
    "the problem is",
    "the issue is",
    "here is",
    "here's",
    "you are",
    "you're",
    "my ",
    "our ",
];

/// Verbs a sentence that asks for work starts with.
const ASKS: &[&str] = &[
    "add",
    "build",
    "make",
    "implement",
    "move",
    "migrate",
    "update",
    "remove",
    "delete",
    "refactor",
    "rename",
    "write",
    "create",
    "review",
    "investigate",
    "debug",
    "fix",
    "set",
    "port",
    "convert",
    "replace",
    "improve",
    "clean",
    "support",
    "ship",
    "deploy",
    "release",
    "design",
    "document",
    "test",
    "rewrite",
    "change",
    "extract",
    "split",
    "merge",
    "upgrade",
    "bump",
    "enable",
    "disable",
    "find",
    "figure",
    "wire",
    "hook",
    "handle",
    "allow",
    "prevent",
    "stop",
    "show",
    "hide",
    "finish",
    "audit",
    "harden",
    "optimize",
    "speed",
    "reduce",
    "drop",
    "introduce",
    "integrate",
    "connect",
    "publish",
    "configure",
    "install",
    "generate",
    "redesign",
    "restructure",
    "consolidate",
    "unify",
    "simplify",
    "polish",
    "tighten",
    "rework",
    "backfill",
    "track",
    "record",
    "settle",
    "teach",
    "let",
    "get",
    "go",
    "look",
    "check",
    "explain",
    "plan",
    "draft",
];

/// Short answers that steer, not ask: never the most telling prompt.
const STEERS: &[&str] = &[
    "yes",
    "no",
    "ok",
    "okay",
    "continue",
    "go on",
    "go ahead",
    "do it",
    "lgtm",
    "commit",
    "push",
    "commit it",
    "push it",
    "thanks",
    "thank you",
    "sure",
    "proceed",
    "keep going",
    "retry",
    "try again",
    "done",
    "great",
    "perfect",
    "nice",
    "y",
    "n",
];

fn lower_words(text: &str) -> String {
    text.to_lowercase()
}

/// Whether `text` starts with `phrase` as whole words (a phrase ending in
/// a space is a word that must have one after it).
fn starts_with_words(text: &str, phrase: &str) -> bool {
    if !text.starts_with(phrase) {
        return false;
    }
    phrase.ends_with(' ') || text[phrase.len()..].chars().next().is_none_or(|c| !c.is_alphanumeric() && c != '\'')
}

/// A sentence without the words in front that say nothing of the work.
fn without_fillers(sentence: &str) -> String {
    let mut text = sentence.trim().to_owned();
    loop {
        let lower = lower_words(&text);
        let Some(filler) = FILLERS.iter().find(|filler| starts_with_words(&lower, filler)) else { break };
        if !text.is_char_boundary(filler.len()) {
            break;
        }
        text = text[filler.len()..].trim_start_matches([' ', ',', ':', ';', '-', '—', '!', '.']).to_owned();
    }
    text
}

/// How well a sentence says what the work is.
fn telling(sentence: &str) -> i32 {
    let lower = lower_words(sentence);
    let words = lower.split_whitespace().count();
    if words == 0 {
        return i32::MIN;
    }
    let mut score = 0;
    if PREAMBLES.iter().any(|preamble| starts_with_words(&lower, preamble)) {
        score -= 4;
    }
    let first = lower.split(|c: char| !c.is_alphanumeric()).next().unwrap_or_default();
    if ASKS.contains(&first) {
        score += 4;
    }
    if (3..=16).contains(&words) {
        score += 1;
    }
    if words < 3 {
        score -= 2;
    }
    if lower.ends_with('?') {
        score -= 1;
    }
    score
}

/// What a prompt asks for, as a title: its most telling sentence among the
/// first few, without greetings, preambles ("This project used to be …")
/// and hedges ("I think", "So"). None when it says nothing.
pub(crate) fn cleaned_intent(prompt: &str) -> Option<String> {
    let (_, sentence) = best_sentence(prompt)?;
    let title = clip_title(sentence.trim_end_matches(['?', '!']), TITLE_CHARS);
    (title.chars().count() >= 2).then(|| capitalized(&title))
}

/// A prompt's most telling sentence, with how telling it is.
fn best_sentence(prompt: &str) -> Option<(i32, String)> {
    let text = readable(prompt)?;
    let mut best: Option<(i32, String)> = None;
    for sentence in lines(&text).iter().flat_map(|line| sentences(line)).take(8) {
        let score = telling(&sentence);
        let cleaned = without_fillers(&sentence);
        if !cleaned.chars().any(char::is_alphanumeric) {
            continue;
        }
        // The cleaned sentence may start with what it asks.
        let score = score.max(telling(&cleaned));
        if best.as_ref().is_none_or(|(kept, _)| score > *kept) {
            best = Some((score, cleaned));
        }
    }
    best
}

/// Whether a prompt only steers ("yes", "continue", "commit it").
fn steers(prompt: &str) -> bool {
    let text: String = prompt.trim().trim_end_matches(['.', '!', '?']).to_lowercase();
    text.split_whitespace().count() <= 3 && STEERS.iter().any(|steer| text == *steer || text.starts_with(&format!("{steer} ")))
        || text.split_whitespace().count() <= 1
}

/// The prompt that says best what the session was for, of `prompts`
/// (oldest first): the first one wins ties, a steering one never does.
pub(crate) fn telling_prompt(prompts: &[String]) -> Option<&str> {
    let mut best: Option<(i32, &str)> = None;
    for (index, prompt) in prompts.iter().enumerate() {
        if steers(prompt) {
            continue;
        }
        let Some((score, _)) = best_sentence(prompt) else { continue };
        // What the session was started with counts for a little more.
        let score = score + if index == 0 { 1 } else { 0 };
        if best.is_none_or(|(kept, _)| score > kept) {
            best = Some((score, prompt));
        }
    }
    best.map(|(_, prompt)| prompt)
}

// --- Settling ----------------------------------------------------------------

/// The words of a title that carry meaning, lowercased.
fn meaning(title: &str) -> HashSet<String> {
    const SMALL: &[&str] = &[
        "the", "and", "for", "with", "from", "into", "onto", "that", "this", "its", "our", "your", "a", "an", "of", "to", "in", "on", "at",
        "by",
    ];
    title
        .split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|word| word.len() >= 2 && !SMALL.contains(&word.as_str()))
        .map(|word| stem(&word))
        .collect()
}

/// A word without the endings that make one word several: plural,
/// -ing, -ed (`settles`, `settling`, `settled` are `settl`).
fn stem(word: &str) -> String {
    let mut word = word;
    for ending in ["ing", "ed", "es", "s"] {
        if word.len() > ending.len() + 2 && word.ends_with(ending) {
            word = &word[..word.len() - ending.len()];
            break;
        }
    }
    if word.len() > 3 && word.ends_with('e') {
        word = &word[..word.len() - 1];
    }
    word.to_owned()
}

/// Whether two titles have the same words, whatever their case and stops.
pub(crate) fn same_words(a: &str, b: &str) -> bool {
    let a: Vec<String> = a.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect();
    let b: Vec<String> = b.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect();
    !a.is_empty() && a == b
}

/// Whether two titles say much the same: a new title replaces a settled
/// one only when they do not.
pub(crate) fn similar(a: &str, b: &str) -> bool {
    let (a, b) = (meaning(a), meaning(b));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let shared = a.intersection(&b).count() as f64;
    let all = a.union(&b).count() as f64;
    shared / all >= 0.6
}

/// The AI provider's answer as a title, if it is one: its first line,
/// without quotes, a `Title:` prefix, markdown or a trailing stop; 2 to
/// 12 words and at most [`TITLE_CHARS`].
pub(crate) fn ai_title(answer: &str) -> Option<String> {
    let line = answer.lines().map(str::trim).find(|line| !line.is_empty())?;
    let mut line = line.trim_start_matches(['#', '*', '-', ' ']).trim();
    for prefix in ["title:", "session title:", "session:"] {
        if line.to_lowercase().starts_with(prefix) {
            line = line[prefix.len()..].trim();
        }
    }
    let line = line.replace("**", "").replace('`', "");
    let line = line.trim().trim_matches(['"', '\'', '“', '”', '‘', '’', '*']).trim();
    let line = line.trim_end_matches(['.', '!', ';', ':', ',']).trim();
    let words = line.split_whitespace().count();
    if !(2..=12).contains(&words) || line.chars().count() > TITLE_CHARS {
        return None;
    }
    Some(capitalized(line))
}

/// A work item or pull request a session is tied to.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Tied {
    pub number: u32,
    pub title: String,
    /// It works on it (attached, claimed, opened, pushed), not only named it.
    pub strong: bool,
}

/// What a session did, for naming it.
#[derive(Clone, Debug, Default)]
pub(crate) struct Record {
    pub repo: String,
    /// The work item it says it is on, and the pull request.
    pub item: Option<u32>,
    pub pull: Option<u32>,
    pub items: Vec<Tied>,
    pub pulls: Vec<Tied>,
    /// Its prompts, oldest first (the first and last few).
    pub prompts: Vec<String>,
    pub tasks: Vec<String>,
    /// Where it changed files, most first, with how many.
    pub areas: Vec<(String, usize)>,
    pub commits: usize,
    pub result: Option<String>,
    pub title: Option<String>,
}

impl Record {
    /// The work items it works on, the one it says it is on first.
    fn worked_items(&self) -> Vec<&Tied> {
        let mut items: Vec<&Tied> = self.items.iter().filter(|item| item.strong || Some(item.number) == self.item).collect();
        items.sort_by_key(|item| Some(item.number) != self.item);
        items
    }

    fn worked_pulls(&self) -> Vec<&Tied> {
        let mut pulls: Vec<&Tied> = self.pulls.iter().filter(|pull| pull.strong || Some(pull.number) == self.pull).collect();
        pulls.sort_by_key(|pull| Some(pull.number) != self.pull);
        pulls
    }

    /// What it was settled from: the work items and pull requests it works on.
    pub(crate) fn basis(&self) -> String {
        let mut parts: Vec<String> = self.worked_items().iter().map(|item| format!("i{}", item.number)).collect();
        parts.extend(self.worked_pulls().iter().map(|pull| format!("p{}", pull.number)));
        parts.sort();
        parts.join(",")
    }

    /// Whether one work item, or one pull request, is the whole story:
    /// its title is the session's, with no need to ask.
    pub(crate) fn one_thing(&self) -> bool {
        let items = self.worked_items().len();
        let pulls = self.worked_pulls().len();
        (items == 1 && pulls <= 1) || (items == 0 && pulls == 1)
    }
}

/// The title g1t gives without an AI provider: the work item's title, else
/// the pull request's, else what the most telling prompt asks for; and
/// where it came from.
pub(crate) fn fallback(record: &Record) -> Option<(String, TitleSource)> {
    if let Some(item) = record.worked_items().first().filter(|item| !item.title.trim().is_empty()) {
        return Some((clip_title(&item.title, TITLE_CHARS), TitleSource::Item));
    }
    if let Some(pull) = record.worked_pulls().first().filter(|pull| !pull.title.trim().is_empty()) {
        return Some((clip_title(&pull.title, TITLE_CHARS), TitleSource::Pull));
    }
    if let Some(intent) = telling_prompt(&record.prompts).and_then(cleaned_intent) {
        return Some((intent, TitleSource::Summary));
    }
    // With no prompts recorded: what its first subagent was given to do.
    record.tasks.first().map(|task| (clip_title(&capitalized(task), TITLE_CHARS), TitleSource::Summary))
}

fn clipped(text: &str, limit: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= limit { text } else { format!("{}…", text.chars().take(limit - 1).collect::<String>()) }
}

/// What the AI provider is given: the record, bounded.
pub(crate) fn digest(record: &Record) -> String {
    let mut out = format!("Repository: {}\n", record.repo);
    let named = |tied: &Tied| format!("- #{} {}\n", tied.number, clipped(&tied.title, 160));
    if !record.items.is_empty() {
        out.push_str("Work items it worked on:\n");
        for item in record.worked_items().into_iter().take(6) {
            out.push_str(&named(item));
        }
        let named_only: Vec<&Tied> = record.items.iter().filter(|item| !item.strong && Some(item.number) != record.item).take(4).collect();
        if !named_only.is_empty() {
            out.push_str("Work items it mentioned:\n");
            for item in named_only {
                out.push_str(&named(item));
            }
        }
    }
    if !record.worked_pulls().is_empty() {
        out.push_str("Pull requests:\n");
        for pull in record.worked_pulls().into_iter().take(6) {
            out.push_str(&named(pull));
        }
    }
    let prompts: Vec<String> = record
        .prompts
        .iter()
        .filter_map(|prompt| readable(prompt))
        .map(|text| clipped(&text, DIGEST_PROMPT_CHARS))
        .filter(|text| !text.is_empty())
        .take(DIGEST_PROMPTS)
        .collect();
    if !prompts.is_empty() {
        out.push_str("What the person asked, oldest first:\n");
        for (index, prompt) in prompts.iter().enumerate() {
            out.push_str(&format!("{}. {prompt}\n", index + 1));
        }
    }
    if !record.tasks.is_empty() {
        let tasks: Vec<String> = record.tasks.iter().take(10).map(|task| clipped(task, 100)).collect();
        out.push_str(&format!("Subagents' tasks: {}\n", tasks.join("; ")));
    }
    if !record.areas.is_empty() {
        let areas: Vec<String> = record.areas.iter().take(8).map(|(area, n)| format!("{area} ({n})")).collect();
        out.push_str(&format!("Files changed in: {}\n", areas.join(", ")));
    }
    if record.commits > 0 {
        out.push_str(&format!("Commits: {}\n", record.commits));
    }
    if let Some(result) = record.result.as_deref().filter(|result| !result.trim().is_empty()) {
        out.push_str(&format!("What it reported at the end: {}\n", clipped(result, 500)));
    }
    if let Some(title) = &record.title {
        out.push_str(&format!("Its title so far: {}\n", clipped(title, 120)));
    }
    clipped_lines(&out, MAX_BRIEF_INPUT_CHARS)
}

fn clipped_lines(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    text.chars().take(limit).collect()
}

/// Where changed files are, as their first two directories, most first.
pub(crate) fn areas(files: &[String]) -> Vec<(String, usize)> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for file in files {
        let parts: Vec<&str> = file.trim_start_matches("./").split('/').collect();
        let area = if parts.len() > 2 {
            parts[..2].join("/")
        } else if parts.len() == 2 {
            parts[0].to_owned()
        } else {
            ".".to_owned()
        };
        *counts.entry(area).or_default() += 1;
    }
    let mut areas: Vec<(String, usize)> = counts.into_iter().collect();
    areas.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    areas
}

/// What settling a title comes to.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Settled {
    /// Nothing changes, but it is no longer due (and final, when it ended).
    Keep { source: Option<TitleSource> },
    /// It is called this now.
    Retitle { title: String, source: TitleSource },
}

/// What a due title's session is, for [`decide`].
#[derive(Clone, Debug)]
pub(crate) struct Due {
    pub title: Option<String>,
    pub source: Option<TitleSource>,
    pub ended: bool,
    /// For its agent's title: it went on to other work after it was named.
    pub stale: bool,
    /// What it was last settled from, and with how many prompts.
    pub basis: Option<String>,
    pub prompts: u32,
    pub settled_prompts: u32,
    pub settled_before: bool,
}

/// Whether a due title needs naming again at all (before any AI call).
pub(crate) fn needs_naming(due: &Due, record: &Record) -> bool {
    match due.source {
        Some(TitleSource::Person) => false,
        Some(TitleSource::Agent) => due.ended && due.stale,
        Some(source) if source.settled() && due.settled_before => {
            due.ended || due.basis.as_deref() != Some(record.basis().as_str()) || due.prompts >= more_prompts(due.settled_prompts)
        }
        _ => true,
    }
}

/// Settles a due title with `candidate` (the AI provider's, else
/// [`fallback`]'s): a pinned title stays, an agent's stays unless stale, a
/// settled one changes only when the new one says something else.
pub(crate) fn decide(due: &Due, record: &Record, candidate: Option<(String, TitleSource)>) -> Settled {
    if !needs_naming(due, record) {
        return Settled::Keep { source: due.source };
    }
    let Some((title, source)) = candidate else {
        return Settled::Keep { source: due.source };
    };
    match (&due.title, due.source) {
        (Some(current), Some(kept)) if kept != TitleSource::Prompt && similar(current, &title) => Settled::Keep { source: Some(kept) },
        (Some(current), _) if same_words(current, &title) => Settled::Keep { source: Some(source) },
        _ => Settled::Retitle { title, source },
    }
}

// --- The cron ----------------------------------------------------------------

#[derive(Deserialize)]
struct DueRow {
    id: String,
    repo_id: String,
    #[serde(default)]
    title_basis: Option<String>,
    #[serde(default)]
    title_prompts: u32,
    #[serde(default)]
    title_calls: u32,
    #[serde(default)]
    prompts: u32,
}

const DUE_COLUMNS: &str = "id, repo_id, title_basis, title_prompts, title_calls, prompts";

#[derive(Deserialize)]
struct TextRow {
    text: String,
}

#[derive(Deserialize)]
struct CountRow {
    n: u32,
}

/// Settles session `?1`'s title: `?2` title (or as it was), `?3` source,
/// `?4` now, `?5` final, `?6` basis, `?7` prompts then, `?8` AI calls made.
/// Not when a person pinned it meanwhile.
const SETTLE: &str = "UPDATE sessions SET title = COALESCE(?2, title), title_source = ?3, title_settled_at = ?4,
       title_due_at = NULL, title_final = ?5, title_basis = ?6, title_prompts = ?7, title_calls = title_calls + ?8
     WHERE id = ?1 AND COALESCE(title_source, '') <> 'person'";

/// What one cron run may still spend, and on whom.
struct Budget {
    calls: u32,
    /// Workspaces whose provider answered nothing (none chosen) or failed.
    without: HashSet<String>,
    paths: HashMap<String, Option<RepoPath>>,
}

impl Work {
    /// Settles the titles that are due: those that became due lately
    /// first, then some of those due long ago (the backfill of sessions
    /// from before titles settled), newest first. Bounded: see
    /// [`RUN_LIVE`], [`RUN_BACKFILL`] and [`RUN_AI_CALLS`].
    pub(crate) async fn settle_titles(&self) -> Result<u32> {
        let now = now_ms();
        let at = rfc3339(now);
        let live_since = rfc3339(now.saturating_sub(LIVE_MS));
        let live = self
            .db
            .prepare(format!(
                "SELECT {DUE_COLUMNS} FROM sessions WHERE title_due_at IS NOT NULL AND title_due_at <= ?1 AND title_due_at > ?2
                 ORDER BY title_due_at LIMIT ?3"
            ))
            .bind(&[at.as_str().into(), live_since.as_str().into(), RUN_LIVE.into()])?
            .all()
            .await?
            .results::<DueRow>()?;
        let old = self
            .db
            .prepare(format!(
                "SELECT {DUE_COLUMNS} FROM sessions WHERE title_due_at IS NOT NULL AND title_due_at <= ?1
                 ORDER BY title_due_at DESC LIMIT ?2"
            ))
            .bind(&[live_since.as_str().into(), RUN_BACKFILL.into()])?
            .all()
            .await?
            .results::<DueRow>()?;
        let mut budget = Budget { calls: RUN_AI_CALLS, without: HashSet::new(), paths: HashMap::new() };
        let mut settled = 0;
        for due in live.into_iter().chain(old) {
            let id = due.id.clone();
            match self.settle_title(due, &mut budget).await {
                Ok(true) => settled += 1,
                Ok(false) => {}
                Err(error) => {
                    worker::console_error!("session {id}: its title was not settled: {error}");
                    // Not tried again at once: the next settle is the next change.
                    let _ =
                        self.db.prepare("UPDATE sessions SET title_due_at = NULL WHERE id = ?").bind(&[id.as_str().into()])?.run().await;
                }
            }
        }
        Ok(settled)
    }

    async fn repo_path_of(&self, repo_id: &str, budget: &mut Budget) -> Result<Option<RepoPath>> {
        if let Some(path) = budget.paths.get(repo_id) {
            return Ok(path.clone());
        }
        let path: Option<RepoPath> = g1t_kit::call(&self.repos, "path_by_id", &PathByIdArgs { id: repo_id.to_owned() }).await?;
        budget.paths.insert(repo_id.to_owned(), path.clone());
        Ok(path)
    }

    /// What a session did, for naming it.
    async fn title_record(&self, row: &SessionRow, path: Option<&RepoPath>) -> Result<Record> {
        let now = now_ms();
        let session = row.clone().at(now);
        let first = self
            .db
            .prepare("SELECT text FROM session_entries WHERE session_id = ? AND kind = 'prompt' ORDER BY session_seq LIMIT 3")
            .bind(&[row.id.as_str().into()])?
            .all()
            .await?
            .results::<TextRow>()?;
        let last = self
            .db
            .prepare("SELECT text FROM session_entries WHERE session_id = ? AND kind = 'prompt' ORDER BY session_seq DESC LIMIT 3")
            .bind(&[row.id.as_str().into()])?
            .all()
            .await?
            .results::<TextRow>()?;
        // As recorded, credentials out (again, for what was recorded before they were taken out as it was).
        let mut prompts: Vec<String> = first.into_iter().map(|row| shown::clean(&row.text)).collect();
        for text in last.into_iter().rev().map(|row| shown::clean(&row.text)) {
            if !prompts.contains(&text) {
                prompts.push(text);
            }
        }
        let children = self.subagents_of(&row.id, now).await?;
        let mut ids = vec![row.id.clone()];
        ids.extend(children.iter().map(|child| child.id.clone()));
        let (touched, links, _) = self.tree_facts(&row.repo_id, &ids).await?;
        let tied = |link: &SessionLink| Tied {
            number: link.number,
            title: link.title.clone(),
            strong: link.via.iter().any(|via| *via != LinkVia::Ref),
        };
        let files: Vec<String> = touched.iter().filter(|touch| touch.kind == TouchKind::File).map(|touch| touch.value.clone()).collect();
        Ok(Record {
            repo: path.map(|path| format!("{}/{}", path.namespace, path.name)).unwrap_or_default(),
            item: session.item,
            pull: session.pull,
            items: links.iter().filter(|link| link.kind == LinkKind::Item).map(tied).collect(),
            pulls: links.iter().filter(|link| link.kind == LinkKind::Pull).map(tied).collect(),
            prompts,
            tasks: children
                .iter()
                .filter(|child| child.parent_id.as_deref() == Some(row.id.as_str()))
                .filter_map(|child| child.task.clone())
                .collect(),
            areas: areas(&files),
            commits: touched.iter().filter(|touch| touch.kind == TouchKind::Commit).count(),
            result: session.result.as_deref().map(shown::clean),
            title: session.title.clone(),
        })
    }

    /// The workspace's AI provider's title for a record, if it has one
    /// and answers with one.
    async fn asked_title(&self, workspace: &str, record: &Record, budget: &mut Budget) -> Option<String> {
        if budget.calls == 0 || budget.without.contains(workspace) {
            return None;
        }
        let integrations = self.integrations.as_ref()?;
        budget.calls -= 1;
        let args = AiBriefArgs { workspace: workspace.to_owned(), system: SYSTEM.to_owned(), input: digest(record), max_tokens: 40 };
        let answer: Result<Outcome<Option<String>>> = g1t_kit::call(integrations, "ai_brief", &args).await;
        match answer {
            Ok(Outcome::Ok(Some(answer))) => {
                let title = ai_title(&answer);
                if title.is_none() {
                    worker::console_log!("{workspace}: the AI provider's title was not one: {}", clipped(&answer, 120));
                }
                title
            }
            Ok(Outcome::Ok(None)) => {
                budget.without.insert(workspace.to_owned());
                None
            }
            Ok(Outcome::Fail(failure)) => {
                worker::console_error!("{workspace}: no title from the AI provider: {}", failure.message);
                budget.without.insert(workspace.to_owned());
                None
            }
            Err(error) => {
                worker::console_error!("{workspace}: no title from the AI provider: {error}");
                budget.without.insert(workspace.to_owned());
                None
            }
        }
    }

    /// Settles one due title. Whether it changed.
    async fn settle_title(&self, due: DueRow, budget: &mut Budget) -> Result<bool> {
        let Some(row) = self.session_row(&due.repo_id, &due.id).await? else {
            return Ok(false);
        };
        let now = now_ms();
        let at = rfc3339(now);
        let ended = row.state == "ended";
        let mut source = row.title_source.as_deref().and_then(TitleSource::parse);
        let path = self.repo_path_of(&row.repo_id, budget).await?;
        let record = self.title_record(&row, path.as_ref()).await?;
        // From before titles said where they came from: the first prompt's
        // intent is provisional, any other title its agent's.
        if source.is_none()
            && let Some(title) = &row.title
        {
            let first = record.prompts.first().and_then(|prompt| intent_title(prompt));
            source =
                Some(if first.as_deref().is_some_and(|first| same_words(first, title)) { TitleSource::Prompt } else { TitleSource::Agent });
        }
        let stale = source == Some(TitleSource::Agent)
            && ended
            && match &row.title_settled_at {
                Some(named) => self
                    .db
                    .prepare("SELECT COUNT(*) AS n FROM session_links WHERE session_id = ? AND via <> 'ref' AND at > ?")
                    .bind(&[row.id.as_str().into(), named.as_str().into()])?
                    .first::<CountRow>(None)
                    .await?
                    .is_some_and(|count| count.n > 0),
                None => false,
            };
        let state = Due {
            title: row.title.clone(),
            source,
            ended,
            stale,
            basis: due.title_basis.clone(),
            prompts: due.prompts,
            settled_prompts: due.title_prompts,
            settled_before: row.title_settled_at.is_some(),
        };
        let mut asked = 0;
        let candidate = if needs_naming(&state, &record) {
            let ask = !record.one_thing()
                && due.title_calls < MAX_AI_CALLS
                && (!record.prompts.is_empty() || !record.items.is_empty() || !record.pulls.is_empty());
            let workspace = path.as_ref().map(|path| path.namespace.to_lowercase()).unwrap_or_default();
            let ai = if ask && !workspace.is_empty() {
                let before = budget.calls;
                let title = self.asked_title(&workspace, &record, budget).await;
                asked = before - budget.calls;
                title.map(|title| (title, TitleSource::Summary))
            } else {
                None
            };
            ai.or_else(|| fallback(&record))
        } else {
            None
        };
        let decided = decide(&state, &record, candidate);
        let (title, source) = match &decided {
            Settled::Keep { source } => (None, *source),
            Settled::Retitle { title, source } => (Some(shown::clean(title)), Some(*source)),
        };
        // Its prompts as they are start the count to the next settle.
        let settled_prompts = due.prompts;
        let source_text = source.map(TitleSource::as_str);
        let settled_at =
            if title.is_some() || row.title_settled_at.is_none() { at.clone() } else { row.title_settled_at.clone().unwrap_or(at.clone()) };
        self.db
            .prepare(SETTLE)
            .bind(&[
                row.id.as_str().into(),
                title.as_deref().map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                source_text.map_or(worker::wasm_bindgen::JsValue::NULL, Into::into),
                settled_at.as_str().into(),
                u32::from(ended).into(),
                record.basis().as_str().into(),
                settled_prompts.into(),
                asked.into(),
            ])?
            .run()
            .await?;
        if title.is_none() {
            return Ok(false);
        }
        // The pages showing it follow along.
        self.publish_as(
            "session.progressed",
            &row.repo_id,
            Some(row.actor_id.clone()),
            SessionProgressed { repo_id: row.repo_id.clone(), number: row.pull.or(row.item), session_id: row.id.clone(), root_id: None },
        )
        .await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prompts_intent_is_its_first_lines_first_sentence() {
        assert_eq!(intent_title("fix the login redirect. It loops.").as_deref(), Some("Fix the login redirect"));
        assert_eq!(intent_title("/clear"), None);
        assert_eq!(intent_title("<command-name>/model</command-name>"), None);
        assert_eq!(
            intent_title("<ide_opened_file>a.rs</ide_opened_file>\nship the runner setup").as_deref(),
            Some("Ship the runner setup")
        );
        assert_eq!(
            intent_title("<pasted_content id=\"5c50\">\nlog\n</pasted_content>\nship the runner setup").as_deref(),
            Some("Ship the runner setup")
        );
        assert_eq!(intent_title("## Plan\n- **move** the [docs](https://x) to `docs/`").as_deref(), Some("Plan"));
        assert_eq!(intent_title("```\ncode\n```\nrename the crate [Image #1]").as_deref(), Some("Rename the crate"));
        let long = intent_title(&"word ".repeat(40)).unwrap();
        assert!(long.ends_with('…') && long.chars().count() <= TITLE_CHARS, "{long}");
        // As the Claude Code plugin read them when it titled sessions itself.
        assert_eq!(
            intent_title("Make preview builds faster. They time out on big repositories.").as_deref(),
            Some("Make preview builds faster")
        );
        assert_eq!(intent_title("Why does `src/app.ts` fail? It worked yesterday.").as_deref(), Some("Why does src/app.ts fail?"));
        assert_eq!(intent_title("```js\nconst a = 1;\n```\n## Clean **this** up\nmore").as_deref(), Some("Clean this up"));
        assert_eq!(
            intent_title("\n\n- look at [the docs](https://docs.g1t.sh) for g1t.mjs").as_deref(),
            Some("Look at the docs for g1t.mjs")
        );
        assert_eq!(intent_title("  spread   over\tspaces  ").as_deref(), Some("Spread over spaces"));
        let tidy = "[TEST] Tidy up the README and then look at the CI pipeline, which keeps failing on the Windows runners";
        let clipped = intent_title(tidy).unwrap();
        assert!(clipped.ends_with('…') && !clipped.ends_with(" …") && tidy.starts_with(clipped.trim_end_matches('…')), "{clipped}");
        assert_eq!(
            intent_title("<pasted_content id=\"5c50\">\nUncaught TypeError: x is undefined\n</pasted_content>\nAlso you broke the buttons")
                .as_deref(),
            Some("Also you broke the buttons")
        );
        assert_eq!(intent_title("[Image #1] the PR link is missing on Home").as_deref(), Some("The PR link is missing on Home"));
        assert_eq!(intent_title("[Image: source: C:\\tmp\\1.png]\nmake it render").as_deref(), Some("Make it render"));
        assert_eq!(intent_title("<pasted_content id=\"1\">only a paste"), None);
        assert_eq!(
            intent_title("<ide_opened_file>The user opened the file c:\\a\\Dockerfile in the IDE.</ide_opened_file>\nWhether it's the desktop app or the page, it crashes").as_deref(),
            Some("Whether it's the desktop app or the page, it crashes")
        );
        assert_eq!(
            intent_title("<ide_selection>const a = 1;</ide_selection>\n<ide_opened_file>a.ts</ide_opened_file>\nrename this").as_deref(),
            Some("Rename this")
        );
        assert_eq!(intent_title("<ide_opened_file>a.ts</ide_opened_file>\n/clear"), None);
        // What Claude Code injects ahead of the prompt is not what it is for.
        assert_eq!(
            intent_title(
                "<browser_instruction># Claude in Chrome\n\nUse the tools.</browser_instruction>Fix the sidebar under the app bar"
            )
            .as_deref(),
            Some("Fix the sidebar under the app bar")
        );
        for prompt in [
            "/clear",
            "/compact keep the plan",
            "/g1t:status 4",
            "<command-name>/clear</command-name>",
            "<local-command-stdout lang=\"en\">ok</local-command-stdout>",
            "```\ncode only\n```",
            "?",
            "",
        ] {
            assert_eq!(intent_title(prompt), None, "{prompt}");
        }
    }

    #[test]
    fn a_cleaned_intent_skips_preambles_and_hedges() {
        assert_eq!(
            cleaned_intent("This project used to be in syntaqx/g1t, but moved it finally in my directory. Migrate every remote and CI config to flagon-io/g1t.").as_deref(),
            Some("Migrate every remote and CI config to flagon-io/g1t")
        );
        assert_eq!(
            cleaned_intent("So I think we should add retries to the webhook sender").as_deref(),
            Some("Add retries to the webhook sender")
        );
        assert_eq!(cleaned_intent("Hey! Can you please fix the flaky queue test?").as_deref(), Some("Fix the flaky queue test"));
        assert_eq!(cleaned_intent("ok, now rename the crate").as_deref(), Some("Rename the crate"));
        assert_eq!(cleaned_intent("/compact"), None);
    }

    #[test]
    fn the_telling_prompt_is_not_one_that_steers() {
        let prompts: Vec<String> =
            ["continue", "This repo is a monorepo. Add a sessions view to Work.", "yes", "commit it"].map(String::from).to_vec();
        assert_eq!(telling_prompt(&prompts), Some("This repo is a monorepo. Add a sessions view to Work."));
        let prompts: Vec<String> = ["Fix the deploy script", "Also fix the readme"].map(String::from).to_vec();
        assert_eq!(telling_prompt(&prompts), Some("Fix the deploy script"));
    }

    #[test]
    fn an_ai_answer_is_a_title_only_when_it_reads_as_one() {
        assert_eq!(ai_title("\"Move sessions into Work.\"").as_deref(), Some("Move sessions into Work"));
        assert_eq!(ai_title("Title: settle session titles server-side").as_deref(), Some("Settle session titles server-side"));
        assert_eq!(
            ai_title("**Repository migration to flagon-io**\n\nThis session…").as_deref(),
            Some("Repository migration to flagon-io")
        );
        assert_eq!(ai_title("Done"), None);
        assert_eq!(ai_title(&"long ".repeat(20)), None);
        assert_eq!(ai_title(""), None);
    }

    #[test]
    fn similar_titles_say_the_same_in_other_words() {
        assert!(similar("Settle session titles", "Settling the session titles"));
        assert!(similar("Move issues to Work items", "Move issues into work items"));
        assert!(!similar("Fix the login redirect", "Migrate repositories to flagon-io"));
        assert!(same_words("Fix the login redirect.", "fix the Login redirect"));
        assert!(!same_words("Fix login", "Fix the login"));
    }

    fn tied(number: u32, title: &str, strong: bool) -> Tied {
        Tied { number, title: title.into(), strong }
    }

    #[test]
    fn the_fallback_is_the_item_then_the_pull_then_the_prompt() {
        let mut record = Record {
            prompts: vec!["This project used to be in syntaqx/g1t. Move it to flagon-io and fix every remote.".into()],
            ..Record::default()
        };
        assert_eq!(fallback(&record), Some(("Move it to flagon-io and fix every remote".into(), TitleSource::Summary)));
        record.pulls = vec![tied(12, "Point remotes at flagon-io", true)];
        assert_eq!(fallback(&record), Some(("Point remotes at flagon-io".into(), TitleSource::Pull)));
        // Named in passing only: not what it works on.
        record.items = vec![tied(4, "Old bug", false)];
        assert_eq!(fallback(&record).unwrap().1, TitleSource::Pull);
        record.items.push(tied(57, "Move issues to workspace-level Work items", true));
        assert_eq!(fallback(&record), Some(("Move issues to workspace-level Work items".into(), TitleSource::Item)));
        // The one it says it is on comes first.
        record.items.push(tied(60, "Session titles that settle", true));
        record.item = Some(60);
        assert_eq!(fallback(&record).unwrap().0, "Session titles that settle");
        assert_eq!(record.basis(), "i57,i60,p12");
        assert!(!record.one_thing());
        let none = Record { tasks: vec!["find the endpoints".into()], ..Record::default() };
        assert_eq!(fallback(&none), Some(("Find the endpoints".into(), TitleSource::Summary)));
        assert_eq!(fallback(&Record::default()), None);
    }

    fn due(title: &str, source: Option<TitleSource>) -> Due {
        Due {
            title: Some(title.into()),
            source,
            ended: false,
            stale: false,
            basis: None,
            prompts: 3,
            settled_prompts: 0,
            settled_before: false,
        }
    }

    #[test]
    fn a_pinned_title_is_never_replaced() {
        let record = Record { items: vec![tied(1, "Something else", true)], ..Record::default() };
        let pinned = Due { ended: true, stale: true, ..due("Mine", Some(TitleSource::Person)) };
        assert_eq!(
            decide(&pinned, &record, Some(("Something else".into(), TitleSource::Item))),
            Settled::Keep { source: Some(TitleSource::Person) }
        );
    }

    #[test]
    fn a_provisional_title_is_replaced_once_there_is_signal() {
        let record = Record { items: vec![tied(57, "Move issues to Work items", true)], ..Record::default() };
        let provisional = due("This project used to be in syntaqx/g1t, but moved it finally in my directory…", Some(TitleSource::Prompt));
        assert_eq!(
            decide(&provisional, &record, fallback(&record)),
            Settled::Retitle { title: "Move issues to Work items".into(), source: TitleSource::Item }
        );
        // The same words again: kept, settled.
        let same = due("Move issues to work items", Some(TitleSource::Prompt));
        assert_eq!(decide(&same, &record, fallback(&record)), Settled::Keep { source: Some(TitleSource::Item) });
    }

    #[test]
    fn a_settled_title_changes_only_when_the_scope_does_and_says_something_else() {
        let record = Record { items: vec![tied(57, "Move issues to Work items", true)], ..Record::default() };
        let settled = Due {
            basis: Some("i57".into()),
            settled_before: true,
            settled_prompts: 3,
            prompts: 5,
            ..due("Move issues to Work items", Some(TitleSource::Item))
        };
        // Nothing changed: not named again, not even asked.
        assert!(!needs_naming(&settled, &record));
        assert_eq!(
            decide(&settled, &record, Some(("Anything".into(), TitleSource::Summary))),
            Settled::Keep { source: Some(TitleSource::Item) }
        );
        // Its prompts grew past twice as many: named again, but a title in
        // other words is not a change.
        let grown = Due { prompts: 8, ..settled.clone() };
        assert!(needs_naming(&grown, &record));
        assert_eq!(
            decide(&grown, &record, Some(("Moving issues into work items".into(), TitleSource::Summary))),
            Settled::Keep { source: Some(TitleSource::Item) }
        );
        // Another work item: a new title that says more.
        let wider = Record {
            items: vec![tied(57, "Move issues to Work items", true), tied(61, "Sessions inside Work", true)],
            ..Record::default()
        };
        assert!(needs_naming(&settled, &wider));
        assert_eq!(
            decide(&settled, &wider, Some(("Work items and the sessions view".into(), TitleSource::Summary))),
            Settled::Retitle { title: "Work items and the sessions view".into(), source: TitleSource::Summary }
        );
    }

    #[test]
    fn an_agents_title_is_kept_unless_stale_at_the_end() {
        let record = Record { items: vec![tied(9, "Other work", true)], ..Record::default() };
        let named = due("Fix the queue", Some(TitleSource::Agent));
        assert!(!needs_naming(&named, &record));
        assert!(!needs_naming(&Due { ended: true, ..named.clone() }, &record));
        let stale = Due { ended: true, stale: true, ..named };
        assert_eq!(decide(&stale, &record, fallback(&record)), Settled::Retitle { title: "Other work".into(), source: TitleSource::Item });
    }

    #[test]
    fn it_is_finalized_from_everything_as_it_ends() {
        let record = Record { items: vec![tied(57, "Move issues to Work items", true)], ..Record::default() };
        let settled = Due {
            basis: Some("i57".into()),
            settled_before: true,
            ended: true,
            ..due("Move issues to Work items", Some(TitleSource::Item))
        };
        assert!(needs_naming(&settled, &record));
        assert_eq!(decide(&settled, &record, fallback(&record)), Settled::Keep { source: Some(TitleSource::Item) });
    }

    #[test]
    fn an_agent_echoing_the_provisional_title_leaves_it_provisional() {
        assert_eq!(given_source("Fix the login redirect", Some("Fix the login redirect"), Some(TitleSource::Prompt)), TitleSource::Prompt);
        assert_eq!(given_source("Fix the login redirect", Some("Fix the login redirect"), None), TitleSource::Prompt);
        assert_eq!(given_source("Rewrite auth", Some("Fix the login redirect"), Some(TitleSource::Prompt)), TitleSource::Agent);
        assert_eq!(given_source("Rewrite auth", None, None), TitleSource::Agent);
        assert_eq!(
            given_source("move issues to work items", Some("Move issues to Work items"), Some(TitleSource::Item)),
            TitleSource::Item
        );
    }

    #[test]
    fn the_digest_is_bounded_and_says_what_it_did() {
        let record = Record {
            repo: "acme/web".into(),
            items: vec![tied(57, "Move issues to Work items", true), tied(3, "Old", false)],
            prompts: vec!["x".repeat(5_000), "/clear".into(), "add the sessions view".into()],
            tasks: vec!["Find endpoints".into()],
            areas: areas(&["services/work/src/a.rs".into(), "services/work/src/b.rs".into(), "README.md".into()]),
            commits: 4,
            result: Some("Done.".into()),
            ..Record::default()
        };
        let text = digest(&record);
        assert!(text.contains("#57 Move issues to Work items"));
        assert!(text.contains("mentioned:\n- #3 Old"));
        assert!(text.contains("services/work (2)"));
        assert!(text.contains("Commits: 4"));
        assert!(!text.contains("/clear"));
        assert!(text.chars().count() <= MAX_BRIEF_INPUT_CHARS);
        assert!(text.contains(&format!("1. {}…", "x".repeat(DIGEST_PROMPT_CHARS - 1))));
    }
}
