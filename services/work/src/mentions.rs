//! `@g1t` in a comment, and the label rule.
//!
//! A comment that mentions `@g1t` is recorded here as it is made,
//! with who wrote it and what they seem to want. The runner hears the
//! comment was made, takes the mention (once: a mention is one run at most)
//! and does what it asks through the flows that already exist: assigning
//! the issue, sending the author of a g1t pull request back, a review, or
//! an answer in the thread. Whatever it does, or why it did nothing, is
//! said back in the thread as `g1t`.
//!
//! The label rule is a repository's "when an issue gets this label, give it
//! to g1t": the issue is queued for an agent, as a plan's issues are.

use g1t_contracts::access::{self, Capability};
use g1t_contracts::events::CommentCreated;
use g1t_contracts::repos::{GetByIdArgs, PathByIdArgs, Repo, RepoPath};
use g1t_contracts::time::rfc3339;
use g1t_contracts::work::*;
use g1t_contracts::{FailureCode, Outcome, PrincipalKind, User, Viewer, new_id};
use g1t_kit::now_ms;
use serde::{Deserialize, Serialize};
use worker::Result;
use worker::wasm_bindgen::JsValue;

use crate::Work;
use crate::lifecycle::{POLICY_ACTOR_ID, POLICY_ACTOR_NAME, made_by_g1t};
use crate::reviews::{AGENT_ID, AGENT_NAME};
use crate::rows::{NumberRow, ValueRow};

/// How g1t's agent is mentioned. Matched without regard to case.
pub(crate) const HANDLE: &str = "@g1t";
/// How long a revision asked for in a comment may take before another step can.
const REVISION_MINUTES: u64 = 60;
const MAX_REPLY_CHARS: usize = 20_000;
const MAX_LABEL_CHARS: usize = 40;

// --- Reading a comment -----------------------------------------------------

/// What a comment says in its own words: fenced code blocks, code spans
/// and quoted lines are left out, so that quoting or showing a mention
/// does not make one.
pub(crate) fn spoken(body: &str) -> String {
    let mut out = String::new();
    // The fence that opened the code block being skipped, if one is.
    let mut fence: Option<String> = None;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if let Some(marker) = &fence {
            if trimmed.starts_with(marker.as_str()) {
                fence = None;
            }
            out.push('\n');
            continue;
        }
        if let Some(first) = trimmed.chars().next()
            && (first == '`' || first == '~')
        {
            let run = trimmed.chars().take_while(|c| *c == first).count();
            if run >= 3 {
                fence = Some(std::iter::repeat_n(first, run).collect());
                out.push('\n');
                continue;
            }
        }
        if trimmed.starts_with('>') {
            out.push('\n');
            continue;
        }
        out.push_str(&without_code_spans(line));
        out.push('\n');
    }
    out
}

/// A line with its code spans blanked: a run of backticks opens one, and
/// the next run of the same length closes it. An unclosed run is text.
fn without_code_spans(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let run_at = |at: usize| chars[at..].iter().take_while(|c| **c == '`').count();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '`' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let open = run_at(i);
        let mut j = i + open;
        let mut closed = None;
        while j < chars.len() {
            if chars[j] == '`' {
                let run = run_at(j);
                if run == open {
                    closed = Some(j + run);
                    break;
                }
                j += run;
            } else {
                j += 1;
            }
        }
        match closed {
            Some(end) => {
                out.push(' ');
                i = end;
            }
            None => {
                out.extend(std::iter::repeat_n('`', open));
                i += open;
            }
        }
    }
    out
}

/// Where `text` mentions `@g1t`, as byte ranges. Not in an email
/// address, a domain, a package scope or a longer name (`ops@g1t.sh`,
/// `@g1t.dev`, `@g1t/contracts`, `@g1t-bot`).
pub(crate) fn mentions_in(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let handle = HANDLE.as_bytes();
    let mut found = Vec::new();
    let mut at = 0;
    while at + handle.len() <= bytes.len() {
        if !bytes[at..at + handle.len()].eq_ignore_ascii_case(handle) {
            at += 1;
            continue;
        }
        let end = at + handle.len();
        let before = text[..at].chars().next_back();
        let mut after = text[end..].chars();
        let starts_clean =
            before.is_none_or(|c| !(c.is_alphanumeric() || "._%+-/\\@`=".contains(c)));
        let ends_clean = match after.next() {
            None => true,
            // A longer name, or a path such as the `@g1t/contracts` package.
            Some(c) if c.is_alphanumeric() || "_-@/\\".contains(c) => false,
            // The end of a sentence, or a domain: `@g1t.dev`.
            Some('.') => after.next().is_none_or(|c| !c.is_alphanumeric()),
            Some(_) => true,
        };
        if starts_clean && ends_clean {
            found.push((at, end));
            at = end;
        } else {
            at += 1;
        }
    }
    found
}

/// Whether a comment mentions `@g1t` in its own words.
pub(crate) fn mentions_agent(body: &str) -> bool {
    !mentions_in(&spoken(body)).is_empty()
}

/// What someone who mentions `@g1t` wants.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Intent {
    /// Do something: take the issue, or change the pull request.
    Work,
    /// Answer in the thread, changing nothing.
    Question,
    /// Review the pull request.
    Review,
}

impl Intent {
    fn as_str(self) -> &'static str {
        match self {
            Intent::Work => "work",
            Intent::Question => "question",
            Intent::Review => "review",
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "question" => Intent::Question,
            "review" => Intent::Review,
            _ => Intent::Work,
        }
    }
}

/// Words that start a request to do something.
const WORK_VERBS: &[&str] = &[
    "take", "fix", "implement", "do", "work", "handle", "pick", "start", "add", "update",
    "change", "make", "refactor", "write", "remove", "delete", "rename", "address", "try",
    "revise", "go", "build", "resolve", "move", "use", "rewrite", "split", "clean", "finish",
    "apply", "drop", "bump", "upgrade", "rebase", "merge", "test",
];
/// Words that start a question.
const QUESTION_WORDS: &[&str] = &[
    "what", "why", "how", "where", "when", "which", "who", "whose", "whom", "is", "are", "was",
    "were", "does", "did", "explain", "tell", "describe", "summarize", "summarise", "clarify",
];
/// Politeness before the request itself.
const PREFIXES: &[&[&str]] = &[
    &["please"],
    &["pls"],
    &["hey"],
    &["hi"],
    &["can", "you"],
    &["could", "you"],
    &["would", "you"],
    &["will", "you"],
];

/// What a comment mentioning `@g1t` asks for, read from what it says
/// after the mention (or before, when nothing follows it).
pub(crate) fn intent(body: &str) -> Intent {
    let spoken = spoken(body);
    let found = mentions_in(&spoken);
    let request = match (found.first(), found.last()) {
        (Some(&(start, _)), Some(&(_, end))) => {
            let after = spoken[end..].trim();
            if after.is_empty() { spoken[..start].trim().to_owned() } else { after.to_owned() }
        }
        _ => spoken.trim().to_owned(),
    };
    // Other mentions of the agent in the request say nothing about it.
    let mut request = request.to_lowercase();
    for (start, end) in mentions_in(&request).into_iter().rev() {
        request.replace_range(start..end, " ");
    }
    let words: Vec<&str> = request
        .split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .filter(|word| !word.is_empty())
        .collect();
    let mut rest: &[&str] = &words;
    'strip: loop {
        for prefix in PREFIXES {
            if rest.starts_with(prefix) {
                rest = &rest[prefix.len()..];
                continue 'strip;
            }
        }
        break;
    }
    if rest.iter().take(4).any(|word| *word == "review" || *word == "re-review") {
        return Intent::Review;
    }
    let first = rest.first().copied().unwrap_or_default();
    if WORK_VERBS.contains(&first) {
        return Intent::Work;
    }
    // The question is the sentence the mention starts.
    let sentence = request.split_inclusive(['.', '!', '\n']).next().unwrap_or_default();
    if QUESTION_WORDS.contains(&first)
        || words.first().is_some_and(|word| QUESTION_WORDS.contains(word))
        || sentence.trim_end().ends_with('?')
        || request.trim_end().ends_with('?')
    {
        return Intent::Question;
    }
    Intent::Work
}

// --- Contracts -------------------------------------------------------------
// Mirrored in TypeScript by `packages/contracts/src/mentions.ts`.

/// `take_mention`: claims the mention a comment made, once. Null when the
/// comment made none, or it was already taken. Returns `Option<MentionJob>`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TakeMentionArgs {
    comment_id: String,
}

/// What the runner needs to act on a mention.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MentionJob {
    comment_id: String,
    /// Who wrote it, with the memberships they had then.
    actor: User,
    repo: RepoPath,
    number: u32,
    /// The comment as written.
    body: String,
    intent: Intent,
    /// Whether they may put agents to work in the repository: the Write
    /// role or higher (the name is from when that meant a member).
    member: bool,
    default_branch: String,
    /// Set when the comment is on an issue: whether it is still open.
    issue_open: Option<bool>,
    /// On an issue: the pull request g1t is already working on for it, if any.
    working_pull: Option<u32>,
    /// Set when the comment is on a pull request.
    pull: Option<MentionPull>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MentionPull {
    id: String,
    status: PullStatus,
    /// Made by g1t, which sees it through.
    agent_authored: bool,
    /// Where its change is: its fork, or the repository itself.
    source: RepoPath,
    /// The head is a branch of the repository itself, not a fork.
    in_repo: bool,
    branch: Option<String>,
    head_commit: Option<String>,
    files: Vec<String>,
}

/// `mention_revision`: sends the author of a g1t pull request back to
/// address a comment that mentioned it. Returns `Outcome<LifecycleJob>`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MentionRevisionArgs {
    comment_id: String,
}

/// `reply_mention`: g1t's answer to a mention, in its thread.
/// Returns `bool`: false when there was no such mention.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplyMentionArgs {
    comment_id: String,
    body: String,
}

/// A repository's rules for putting g1t to work by itself.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRules {
    /// When an issue is given this label, g1t takes it.
    label: Option<String>,
    updated_by: Option<String>,
    updated_at: Option<String>,
}

/// `get_agent_rules`. Returns `Outcome<AgentRules>`.
#[derive(Debug, Deserialize)]
pub(crate) struct GetAgentRulesArgs {
    repo: RepoPath,
    viewer: Viewer,
}

/// `set_agent_rules`: needs the Maintain role. Returns `Outcome<AgentRules>`.
#[derive(Debug, Deserialize)]
pub(crate) struct SetAgentRulesArgs {
    actor: User,
    repo: RepoPath,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Deserialize)]
struct MentionRow {
    comment_id: String,
    repo_id: String,
    number: u32,
    pull_id: Option<String>,
    actor: String,
    body: String,
    intent: String,
    member: u8,
}

#[derive(Deserialize)]
struct RulesRow {
    label: Option<String>,
    updated_by: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct RevisionsRow {
    revisions: u32,
}

/// A label as issues store them, or `None` for no rule.
fn normalize_label(label: Option<&str>) -> std::result::Result<Option<String>, &'static str> {
    let Some(label) = label.map(str::trim).filter(|label| !label.is_empty()) else {
        return Ok(None);
    };
    if label.chars().count() > MAX_LABEL_CHARS {
        return Err("A label is up to 40 characters.");
    }
    Ok(Some(label.to_lowercase()))
}

impl Work {
    /// Records a comment's mention of `@g1t`, if it makes one, for
    /// the runner to take when it hears of the comment. g1t mentioning
    /// itself is not recorded, so no agent can set another to work.
    pub(crate) async fn note_mention(
        &self,
        actor: &User,
        repo: &Repo,
        number: u32,
        comment: &Comment,
        pull_id: Option<&str>,
    ) -> Result<()> {
        if actor.kind == PrincipalKind::Agent
            || actor.is_system()
            || actor.id == AGENT_ID
            || !mentions_agent(&comment.body)
        {
            return Ok(());
        }
        // Whether it may set the agent to work: mentioning spends compute.
        let member = actor.verified && access::can(Some(actor), repo, Capability::Run);
        self.db
            .prepare(
                "INSERT OR IGNORE INTO agent_mentions
                   (comment_id, repo_id, number, pull_id, actor, body, intent, member, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&[
                comment.id.as_str().into(),
                repo.id.as_str().into(),
                number.into(),
                pull_id.map_or(JsValue::NULL, JsValue::from),
                serde_json::to_string(actor)?.into(),
                comment.body.as_str().into(),
                intent(&comment.body).as_str().into(),
                u32::from(member).into(),
                comment.created_at.as_str().into(),
            ])?
            .run()
            .await?;
        Ok(())
    }

    pub(crate) async fn take_mention(&self, a: TakeMentionArgs) -> Result<Option<MentionJob>> {
        let Some(row) = self
            .db
            .prepare(
                "UPDATE agent_mentions SET status = 'taken', taken_at = ?
                 WHERE comment_id = ? AND status = 'pending'
                 RETURNING *",
            )
            .bind(&[rfc3339(now_ms()).into(), a.comment_id.as_str().into()])?
            .first::<MentionRow>(None)
            .await?
        else {
            return Ok(None);
        };
        let Ok(actor) = serde_json::from_str::<User>(&row.actor) else {
            return Ok(None);
        };
        // Where the repository is now, as whoever commented: they could see it.
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: row.repo_id.clone(),
                viewer: Some(actor.clone()),
            },
        )
        .await?;
        let Outcome::Ok(repo) = crate::retired::unless_archived(repo) else {
            return Ok(None);
        };
        let path = RepoPath {
            namespace: repo.namespace.clone(),
            name: repo.name.clone(),
        };
        let pull = match &row.pull_id {
            Some(id) => self.pull_by_id(id).await?,
            None => None,
        };
        let issue = match &pull {
            Some(_) => None,
            None => self.issue(&repo.id, row.number).await?,
        };
        let issue_open = pull.is_none().then(|| issue.as_ref().is_some_and(|issue| issue.state == State::Open));
        let working_pull = match &issue {
            Some(issue) => self
                .db
                .prepare(
                    "SELECT number AS n FROM pulls
                     WHERE issue_id = ? AND agent = ? AND status IN ('draft', 'open')
                     ORDER BY number DESC LIMIT 1",
                )
                .bind(&[issue.id.as_str().into(), AGENT_NAME.into()])?
                .first::<NumberRow>(None)
                .await?
                .map(|row| row.n),
            None => None,
        };
        Ok(Some(MentionJob {
            comment_id: row.comment_id,
            actor,
            number: row.number,
            body: row.body,
            intent: Intent::parse(&row.intent),
            member: row.member != 0,
            default_branch: repo.default_branch.clone(),
            issue_open,
            working_pull,
            pull: pull.map(|pull| MentionPull {
                agent_authored: made_by_g1t(&pull),
                source: pull.fork.clone().unwrap_or_else(|| path.clone()),
                in_repo: pull.fork.is_none(),
                files: pull.files.iter().map(|file| file.path.clone()).collect(),
                id: pull.id,
                status: pull.status,
                branch: pull.branch,
                head_commit: pull.head_commit,
            }),
            repo: path,
        }))
    }

    pub(crate) async fn mention_revision(
        &self,
        a: MentionRevisionArgs,
    ) -> Result<Outcome<LifecycleJob>> {
        let Some(row) = self
            .db
            .prepare("SELECT * FROM agent_mentions WHERE comment_id = ? AND status = 'taken'")
            .bind(&[a.comment_id.as_str().into()])?
            .first::<MentionRow>(None)
            .await?
        else {
            return Ok(Outcome::fail(FailureCode::NotFound, "No such mention."));
        };
        let actor: User = serde_json::from_str(&row.actor)?;
        let Some(pull) = (match &row.pull_id {
            Some(id) => self.pull_by_id(id).await?,
            None => None,
        }) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Pull request not found."));
        };
        if row.member == 0 || !made_by_g1t(&pull) {
            return Ok(Outcome::fail(
                FailureCode::Forbidden,
                "Only someone with the Write role or higher can send g1t back to a pull request it made.",
            ));
        }
        match pull.status {
            PullStatus::Open => {}
            PullStatus::Draft => {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    "g1t is still making this change.",
                ));
            }
            status => {
                return Ok(Outcome::fail(
                    FailureCode::Conflict,
                    format!("This pull request is already {}.", serde_json::to_value(status)?.as_str().unwrap_or("closed")),
                ));
            }
        }
        let viewer = self.owner_viewer(&pull).await?;
        let repo: Outcome<Repo> = g1t_kit::call(
            &self.repos,
            "get_by_id",
            &GetByIdArgs {
                id: pull.repo_id.clone(),
                viewer,
            },
        )
        .await?;
        let (Outcome::Ok(repo), Some(source)) = (crate::retired::unless_archived(repo), pull.fork.clone()) else {
            return Ok(Outcome::fail(FailureCode::NotFound, "Pull request not found."));
        };
        // A person asking outranks a stop and the limit on revisions.
        self.db
            .prepare("UPDATE pulls SET stalled = NULL WHERE id = ?")
            .bind(&[pull.id.as_str().into()])?
            .run()
            .await?;
        if !self.claim(&pull.id, "revision", REVISION_MINUTES, true).await? {
            return Ok(Outcome::fail(
                FailureCode::Conflict,
                "g1t is already taking a step on this pull request.",
            ));
        }
        let round = self
            .db
            .prepare("SELECT revisions FROM pulls WHERE id = ?")
            .bind(&[pull.id.as_str().into()])?
            .first::<RevisionsRow>(None)
            .await?
            .map_or(1, |row| row.revisions);
        let issue = match pull.issue {
            Some(number) => self.issue(&pull.repo_id, number).await?,
            None => None,
        };
        self.note(
            &pull.repo_id,
            pull.number,
            (POLICY_ACTOR_ID, POLICY_ACTOR_NAME),
            &format!("sent g1t back to address {}'s comment", actor.username),
        )
        .await?;
        Ok(Outcome::Ok(LifecycleJob {
            pull_id: pull.id,
            repo: RepoPath {
                namespace: repo.namespace,
                name: repo.name,
            },
            number: pull.number,
            author: pull.requested_by.unwrap_or(pull.author),
            source,
            branch: None,
            default_branch: repo.default_branch,
            title: pull.title,
            description: pull.body.unwrap_or_default(),
            issue,
            feedback: format!(
                "{} mentioned you in a comment on this pull request:\n\n{}\n\nThis is a change a person asked for. Make it.",
                actor.username,
                row.body.trim()
            ),
            round,
        }))
    }

    /// Says something in a mention's thread as g1t, once per mention.
    pub(crate) async fn reply_mention(&self, a: ReplyMentionArgs) -> Result<bool> {
        let body: String = a.body.trim().chars().take(MAX_REPLY_CHARS).collect();
        if body.is_empty() {
            return Ok(false);
        }
        let Some(row) = self
            .db
            .prepare(
                "UPDATE agent_mentions SET status = 'replied', outcome = ?
                 WHERE comment_id = ? AND status = 'taken'
                 RETURNING *",
            )
            .bind(&[body.as_str().into(), a.comment_id.as_str().into()])?
            .first::<MentionRow>(None)
            .await?
        else {
            return Ok(false);
        };
        let now = now_ms();
        let id = new_id("cmt", now);
        let at = rfc3339(now);
        let table = if row.pull_id.is_some() { "pulls" } else { "issues" };
        self.db
            .batch(vec![
                self.db
                    .prepare(
                        "INSERT INTO comments
                           (id, repo_id, number, author_id, author_name, body, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&[
                        id.as_str().into(),
                        row.repo_id.as_str().into(),
                        row.number.into(),
                        AGENT_ID.into(),
                        AGENT_NAME.into(),
                        body.as_str().into(),
                        at.as_str().into(),
                    ])?,
                self.db
                    .prepare(format!(
                        "UPDATE {table} SET updated_at = ? WHERE repo_id = ? AND number = ?"
                    ))
                    .bind(&[at.as_str().into(), row.repo_id.as_str().into(), row.number.into()])?,
            ])
            .await?;
        self.publish_as(
            "comment.created",
            &row.repo_id,
            Some(AGENT_ID.to_owned()),
            CommentCreated {
                comment_id: id,
                repo_id: row.repo_id.clone(),
                number: row.number,
                pull_id: row.pull_id,
                verdict: None,
            },
        )
        .await?;
        Ok(true)
    }

    // --- The label rule ----------------------------------------------------

    async fn rules(&self, repo_id: &str) -> Result<AgentRules> {
        Ok(self
            .db
            .prepare("SELECT label, updated_by, updated_at FROM agent_rules WHERE repo_id = ?")
            .bind(&[repo_id.into()])?
            .first::<RulesRow>(None)
            .await?
            .map_or_else(AgentRules::default, |row| AgentRules {
                label: row.label,
                updated_by: Some(row.updated_by),
                updated_at: Some(row.updated_at),
            }))
    }

    pub(crate) async fn get_agent_rules(&self, a: GetAgentRulesArgs) -> Result<Outcome<AgentRules>> {
        let repo = match self.repo(&a.repo, &a.viewer).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        Ok(Outcome::Ok(self.rules(&repo.id).await?))
    }

    pub(crate) async fn set_agent_rules(&self, a: SetAgentRulesArgs) -> Result<Outcome<AgentRules>> {
        let repo = match self.repo(&a.repo, &Some(a.actor.clone())).await? {
            Outcome::Ok(repo) => repo,
            Outcome::Fail(failure) => return Ok(Outcome::Fail(failure)),
        };
        if let Outcome::Fail(failure) = crate::retired::writable(&repo) {
            return Ok(Outcome::Fail(failure));
        }
        if !a.actor.verified {
            return Ok(Outcome::fail(FailureCode::Forbidden, crate::UNVERIFIED));
        }
        if let Outcome::Fail(failure) = crate::allowed(Some(&a.actor), &repo, Capability::ManageSettings) {
            return Ok(Outcome::Fail(failure));
        }
        let label = match normalize_label(a.label.as_deref()) {
            Ok(label) => label,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        let rules = AgentRules {
            label,
            updated_by: Some(a.actor.username.clone()),
            updated_at: Some(rfc3339(now_ms())),
        };
        self.db
            .prepare(
                "INSERT INTO agent_rules (repo_id, label, updated_by, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT (repo_id) DO UPDATE SET
                   label = excluded.label,
                   updated_by = excluded.updated_by,
                   updated_at = excluded.updated_at",
            )
            .bind(&[
                repo.id.as_str().into(),
                rules.label.as_deref().map_or(JsValue::NULL, JsValue::from),
                rules.updated_by.as_deref().unwrap_or_default().into(),
                rules.updated_at.as_deref().unwrap_or_default().into(),
            ])?
            .run()
            .await?;
        Ok(Outcome::Ok(rules))
    }

    /// Queues an issue for g1t when it has just been given the label
    /// the repository's rule names, by someone who may run agents in it.
    /// The runner starts queued issues as there is room, as it does a
    /// plan's.
    pub(crate) async fn apply_label_rule(&self, actor: &User, issue: &Issue, before: &[String]) -> Result<()> {
        if issue.state != State::Open || issue.queued || issue.agent.is_some() {
            return Ok(());
        }
        let Some(label) = self.rules(&issue.repo_id).await?.label else {
            return Ok(());
        };
        if !issue.labels.contains(&label) || before.contains(&label) {
            return Ok(());
        }
        let path: Option<RepoPath> = g1t_kit::call(
            &self.repos,
            "path_by_id",
            &PathByIdArgs {
                id: issue.repo_id.clone(),
            },
        )
        .await?;
        let Some(path) = path else {
            return Ok(());
        };
        // Running needs Write, which public alone never gives, so whether
        // the repository is public does not matter here.
        let target = access::RepoRef { id: &issue.repo_id, namespace: &path.namespace, private: true };
        if !actor.verified
            || actor.kind == PrincipalKind::Agent
            || !access::can(Some(actor), target, Capability::Run)
        {
            return Ok(());
        }
        let queued = self
            .db
            .prepare(
                "UPDATE issues SET queued_by = ? WHERE id = ? AND queued_by IS NULL
                 RETURNING id AS value",
            )
            .bind(&[serde_json::to_string(actor)?.into(), issue.id.as_str().into()])?
            .first::<ValueRow>(None)
            .await?;
        if queued.is_some() {
            self.note(
                &issue.repo_id,
                issue.number,
                (POLICY_ACTOR_ID, POLICY_ACTOR_NAME),
                &format!("queued this for g1t, because it was labelled {label}"),
            )
            .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mention_is_found_whatever_its_case() {
        assert!(mentions_agent("@g1t take this"));
        assert!(mentions_agent("@G1T take this"));
        assert!(mentions_agent("Thanks, @g1t."));
        assert!(mentions_agent("(@g1t) and"));
        assert!(mentions_agent("cc @g1t, please"));
        assert!(mentions_agent("first line\n@g1t"));
    }

    #[test]
    fn code_does_not_mention_anyone() {
        assert!(!mentions_agent("Type `@g1t take this` to hand it over."));
        assert!(!mentions_agent("Use ``@g1t `x` `` like so."));
        assert!(!mentions_agent("```\n@g1t take this\n```"));
        assert!(!mentions_agent("~~~md\n@g1t\n~~~"));
        assert!(!mentions_agent("````\n```\n@g1t\n```\n````"));
        // Outside the code, it still counts.
        assert!(mentions_agent("`code` then @g1t fix it"));
        assert!(mentions_agent("```\nx\n```\n@g1t fix it"));
        // A backtick that opens nothing is text.
        assert!(mentions_agent("a ` b @g1t"));
    }

    #[test]
    fn quoting_a_mention_does_not_repeat_it() {
        assert!(!mentions_agent("> @g1t take this\n\nI don't think we should."));
        assert!(!mentions_agent("  > > @g1t"));
        assert!(mentions_agent("> earlier\n\n@g1t yes, do it"));
    }

    #[test]
    fn email_addresses_and_longer_names_are_not_mentions() {
        assert!(!mentions_agent("write to ops@g1t.sh"));
        assert!(!mentions_agent("mail g1t@users.noreply.g1t.sh"));
        assert!(!mentions_agent("bot@g1t"));
        assert!(!mentions_agent("@g1t.dev is the address"));
        assert!(!mentions_agent("@g1t.sh"));
        assert!(!mentions_agent("@g1ts"));
        assert!(!mentions_agent("@g1t2"));
        assert!(!mentions_agent("@g1t-2"));
        assert!(!mentions_agent("@g1t-bot take this"));
        assert!(!mentions_agent("@g1t-agent take this"));
        assert!(!mentions_agent("@g1t_x"));
        assert!(!mentions_agent("https://g1t.sh/@g1t"));
        assert!(!mentions_agent("see https://g1t.sh/g1t/docs"));
        assert!(!mentions_agent("\\@g1t"));
        assert!(!mentions_agent("g1t without the at"));
        assert!(!mentions_agent("import { x } from \"@g1t/contracts\";"));
        assert!(!mentions_agent("npm i @g1t/contracts"));
        assert!(!mentions_agent("@@g1t"));
        assert!(!mentions_agent("name@g1t: hi"));
    }

    #[test]
    fn a_mention_ends_at_punctuation() {
        assert!(mentions_agent("@g1t: take this"));
        assert!(mentions_agent("@g1t! fix it"));
        assert!(mentions_agent("ok @g1t?"));
        assert!(mentions_agent("\"@g1t\" take this"));
        assert!(mentions_agent("**@g1t** take this"));
        assert!(mentions_agent("@g1t.\nThanks"));
        assert_eq!(mentions_in("@g1t and @g1t-bot and @g1t"), vec![(0, 4), (22, 26)]);
    }

    #[test]
    fn non_ascii_text_around_a_mention_is_fine() {
        assert!(mentions_agent("é @g1t ü"));
        assert!(!mentions_agent("é@g1t"));
        assert_eq!(mentions_in("ü @g1t"), vec![(3, 3 + HANDLE.len())]);
    }

    #[test]
    fn a_request_is_work() {
        assert_eq!(intent("@g1t take this"), Intent::Work);
        assert_eq!(intent("@g1t"), Intent::Work);
        assert_eq!(intent("@g1t please fix the typo in the README"), Intent::Work);
        assert_eq!(intent("@g1t can you add tests for this?"), Intent::Work);
        assert_eq!(intent("Looks close. @g1t rename `foo` to `bar`."), Intent::Work);
        assert_eq!(intent("@G1T Handle the empty case too"), Intent::Work);
    }

    #[test]
    fn a_question_is_answered() {
        assert_eq!(intent("@g1t why does this fail on Windows?"), Intent::Question);
        assert_eq!(intent("@g1t how is the cache invalidated"), Intent::Question);
        assert_eq!(intent("@g1t can you explain the retry logic"), Intent::Question);
        assert_eq!(intent("@g1t is this safe to merge as it is?"), Intent::Question);
        assert_eq!(intent("@g1t the parser or the lexer?"), Intent::Question);
        assert_eq!(intent("What does this do, @g1t?"), Intent::Question);
    }

    #[test]
    fn a_review_is_a_review() {
        assert_eq!(intent("@g1t review this"), Intent::Review);
        assert_eq!(intent("@g1t please review"), Intent::Review);
        assert_eq!(intent("@g1t could you review the migration?"), Intent::Review);
        assert_eq!(intent("@g1t re-review"), Intent::Review);
    }

    #[test]
    fn quoted_and_code_text_does_not_change_the_intent() {
        assert_eq!(intent("> why?\n\n@g1t fix it"), Intent::Work);
        assert_eq!(intent("@g1t fix `why?`"), Intent::Work);
    }

    #[test]
    fn labels_are_stored_as_issues_store_them() {
        assert_eq!(normalize_label(Some("  Agent ")), Ok(Some("agent".to_owned())));
        assert_eq!(normalize_label(Some("   ")), Ok(None));
        assert_eq!(normalize_label(None), Ok(None));
        assert!(normalize_label(Some(&"x".repeat(41))).is_err());
    }
}
