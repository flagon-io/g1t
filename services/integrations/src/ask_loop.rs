//! One answer as it runs: the provider streams, asks for tools, Ask runs
//! them as the person asking (ask_tools.rs) and sends the provider the
//! results, round after round, until the model answers. Each line goes to
//! the person as soon as it is known: the answer's text as it is written,
//! each step as it starts and ends, then the sources and `done`.
//!
//! The answer is bounded: at most [`ASK_MAX_TOOL_ROUNDS`] rounds and
//! [`ASK_MAX_TOOL_CALLS`] calls, [`ASK_MAX_TOOL_SECONDS`] of calling tools,
//! [`ASK_MAX_TOOL_RESULT_CHARS`] of any one result and
//! [`ASK_MAX_TOOL_TOTAL_CHARS`] of results in all. Past a bound the model is
//! told so and answers with what it has. The person pressing Stop drops the
//! stream, and with it whatever is in flight.

use std::collections::VecDeque;

use futures_util::StreamExt;
use g1t_contracts::identity::RevokeAskTokenArgs;
use g1t_contracts::ai::{
    ASK_MAX_TOOL_CALLS, ASK_MAX_TOOL_RESULT_CHARS, ASK_MAX_TOOL_ROUNDS, ASK_MAX_TOOL_SECONDS, ASK_MAX_TOOL_TOTAL_CHARS,
    AskEvent, AskMessage, AskToolStatus, AiConfig, AiProvider,
};
use serde_json::Value;
use worker::{ByteStream, Fetcher, Method};

use crate::ask::{self, Answered, Call, Request, Round};
use crate::ask_tools::{self, Decision, Mcp, Sources, Toolbox};
use crate::http;

/// What the model is told when a call is not run because the answer used
/// what it may.
const SPENT: &str = "Not run: this answer has used the tool calls it may make. Answer now with what you have read, and say what you could not check.";

/// What the model is told once a session is proposed.
const PROPOSED: &str = "Proposed. The person now sees a card under your answer to start this session on their workspace's Anthropic account or copy a Claude Code command for it; nothing has started. Don't ask them to confirm in words: say in a sentence what the session will do.";

/// What the model is told once it proposes building a new repository.
const PROPOSED_NEW: &str = "Proposed. The person now sees a card under your answer; nothing has happened yet. Starting it creates the repository, turns on its deployments if you asked, opens the issue and starts the session, which pushes the first version to the default branch; that push deploys it, and the card then shows the address where it will be live on g1t.page. Don't ask them to confirm in words: say in a sentence or two what will be built, that it goes live on its own once the session pushes it, and that they can ask you how it is going.";

/// The most sessions one answer proposes.
const MAX_PROPOSALS: usize = 5;

/// What an answer has spent of its bounds.
#[derive(Debug, Default)]
pub struct Budget {
    /// When the answer started, in milliseconds.
    pub started: u64,
    /// Rounds of tool calls run.
    pub rounds: usize,
    pub calls: usize,
    /// Characters of results given to the model.
    pub chars: usize,
}

impl Budget {
    pub fn new(started: u64) -> Self {
        Budget { started, ..Budget::default() }
    }

    /// Whether the answer has used what it may of the tools, at `now`: the
    /// model must answer with what it has.
    pub fn spent(&self, now: u64) -> bool {
        self.rounds >= ASK_MAX_TOOL_ROUNDS
            || self.calls >= ASK_MAX_TOOL_CALLS
            || self.chars >= ASK_MAX_TOOL_TOTAL_CHARS
            || now.saturating_sub(self.started) > ASK_MAX_TOOL_SECONDS * 1000
    }

    /// Takes one call, if one is left.
    pub fn take_call(&mut self, now: u64) -> bool {
        if self.spent(now) {
            return false;
        }
        self.calls += 1;
        true
    }

    /// How much of a result the model may be given now.
    pub fn room(&self) -> usize {
        ASK_MAX_TOOL_TOTAL_CHARS.saturating_sub(self.chars).min(ASK_MAX_TOOL_RESULT_CHARS)
    }

    /// A model that keeps asking for tools after it was told to answer:
    /// the answer ends with what it has written.
    pub fn overrun(&self) -> bool {
        self.rounds > ASK_MAX_TOOL_ROUNDS
    }
}

/// Everything one answer needs, owned, so its stream outlives the request
/// that started it.
pub struct Answering {
    pub provider: AiProvider,
    pub config: AiConfig,
    pub key: Option<String>,
    pub model: String,
    pub system: String,
    pub messages: Vec<AskMessage>,
    pub max_tokens: u32,
    pub toolbox: Toolbox,
    /// g1t's MCP server as the person asking; none when it could not be
    /// reached, and the answer goes without tools.
    pub mcp: Option<Mcp>,
    pub site: String,
    /// Identity, and the credential to revoke when the answer ends.
    pub identity: Fetcher,
    pub credential: Option<String>,
    budget: Budget,
    phase: Phase,
    out: VecDeque<String>,
    /// The rounds of tool calls so far, in the provider's shape.
    rounds: Vec<Value>,
    /// All the answer's text, for its sources.
    written: String,
    sources: Sources,
    /// Sessions proposed so far, at most [`MAX_PROPOSALS`].
    proposals: usize,
}

enum Phase {
    Streaming { upstream: ByteStream, round: Round },
    /// The model asked for tools: their `running` lines have gone; run them.
    Calling { text: String, calls: Vec<Call>, ids: Vec<String> },
    /// Ask the provider again, with the round's results.
    Asking,
    Finished,
}

/// Why a provider could not be asked, for the person.
pub fn refused_by(provider: AiProvider, status: u16, body: String) -> String {
    http::Answer { status, body }.problem(provider.label())
}

impl Answering {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        provider: AiProvider,
        config: AiConfig,
        key: Option<String>,
        model: String,
        system: String,
        messages: Vec<AskMessage>,
        max_tokens: u32,
        toolbox: Toolbox,
        mcp: Option<Mcp>,
        site: String,
        identity: Fetcher,
        credential: Option<String>,
        started: u64,
    ) -> Self {
        Answering {
            provider,
            config,
            key,
            model,
            system,
            messages,
            max_tokens,
            toolbox,
            mcp,
            site,
            identity,
            credential,
            budget: Budget::new(started),
            phase: Phase::Asking,
            out: VecDeque::new(),
            rounds: Vec::new(),
            written: String::new(),
            sources: Sources::default(),
            proposals: 0,
        }
    }

    /// The provider's request for the next round.
    pub fn request(&self) -> Result<ask::Built, String> {
        ask::build(&Request {
            provider: self.provider,
            config: &self.config,
            key: self.key.as_deref(),
            model: &self.model,
            system: &self.system,
            messages: &self.messages,
            rounds: &self.rounds,
            tools: self.toolbox.specs(),
            answer_now: self.budget.spent(g1t_kit::now_ms()),
            max_tokens: self.max_tokens,
        })
    }

    /// Starts streaming the first round's answer, already opened.
    pub fn streaming(&mut self, upstream: ByteStream, first: String) {
        self.out.push_back(first);
        self.phase = Phase::Streaming { upstream, round: Round::new(self.provider, false) };
    }

    /// The next line to send, or `None` when the answer is over.
    pub async fn next(&mut self) -> Option<String> {
        loop {
            if let Some(line) = self.out.pop_front() {
                return Some(line);
            }
            match std::mem::replace(&mut self.phase, Phase::Finished) {
                Phase::Finished => return None,
                Phase::Asking => self.ask().await,
                Phase::Streaming { mut upstream, mut round } => {
                    let label = self.provider.label();
                    let lines = match upstream.next().await {
                        Some(Ok(bytes)) => round.feed(&bytes),
                        Some(Err(error)) => {
                            round.broke(&format!("The answer from {label} broke off: {error}"));
                            String::new()
                        }
                        None => round.end(),
                    };
                    self.written.push_str(&texts(&lines));
                    if !lines.is_empty() {
                        self.out.push_back(lines);
                    }
                    if round.over() {
                        self.after(round).await;
                    } else {
                        self.phase = Phase::Streaming { upstream, round };
                    }
                }
                Phase::Calling { text, calls, ids } => self.call(text, calls, ids).await,
            }
        }
    }

    /// A round ended: run the tools it asked for, or finish.
    async fn after(&mut self, round: Round) {
        if let Some(problem) = round.error() {
            self.out.push_back(ask::line(&AskEvent::Error { message: problem.to_owned() }));
            return self.finish().await;
        }
        let calls = round.calls();
        // No tools asked for, none to give, or a model that keeps asking
        // after it was told to answer: what it wrote is the answer.
        if calls.is_empty() || self.toolbox.is_empty() || self.budget.overrun() {
            let sources = self.sources.finish(&self.site, &self.written);
            if !sources.is_empty() {
                self.out.push_back(ask::line(&AskEvent::Sources { sources }));
            }
            self.out.push_back(ask::line(&AskEvent::Done { stop_reason: round.stop_reason() }));
            return self.finish().await;
        }
        // Each step shows as it starts.
        let mut ids = Vec::with_capacity(calls.len());
        for call in &calls {
            let id = format!("step_{}_{}", self.budget.rounds, ids.len());
            self.out.push_back(ask::line(&self.step(&id, call, AskToolStatus::Running, None)));
            ids.push(id);
        }
        self.phase = Phase::Calling { text: round.text().to_owned(), calls, ids };
    }

    fn step(&self, id: &str, call: &Call, status: AskToolStatus, summary: Option<String>) -> AskEvent {
        AskEvent::Tool {
            id: id.to_owned(),
            name: call.name.clone(),
            action: call.input["action"].as_str().map(str::to_owned),
            label: ask_tools::label(&call.name, &call.input),
            status,
            summary,
            link: ask_tools::link(&self.site, &call.name, &call.input),
        }
    }

    /// Runs a round's calls, all at once, and asks the provider again.
    async fn call(&mut self, text: String, calls: Vec<Call>, ids: Vec<String>) {
        enum Plan {
            Run,
            Skip(String, AskToolStatus),
        }
        let mut plans = Vec::with_capacity(calls.len());
        for call in &calls {
            let now = g1t_kit::now_ms();
            let plan = if self.budget.spent(now) {
                Plan::Skip(SPENT.to_owned(), AskToolStatus::Refused)
            } else {
                match self.toolbox.decide(&call.name, &call.input) {
                    Decision::Run if self.budget.take_call(now) => Plan::Run,
                    Decision::Run => Plan::Skip(SPENT.to_owned(), AskToolStatus::Refused),
                    // Dispatch: the answer shows a proposal the person
                    // starts themselves; the click is the confirmation.
                    Decision::Confirm if self.proposals >= MAX_PROPOSALS => {
                        Plan::Skip("Not run: this answer has proposed as many sessions as it may.".to_owned(), AskToolStatus::Refused)
                    }
                    Decision::Confirm => {
                        let id = format!("proposal_{}_{}", self.budget.rounds, self.proposals);
                        match ask_tools::proposal(&id, &call.input) {
                            Ok(proposal) => {
                                self.proposals += 1;
                                let told = match &proposal {
                                    AskEvent::Proposal { new_repository: true, .. } => PROPOSED_NEW,
                                    _ => PROPOSED,
                                };
                                self.out.push_back(ask::line(&proposal));
                                Plan::Skip(told.to_owned(), AskToolStatus::Done)
                            }
                            Err(why) => Plan::Skip(why, AskToolStatus::Failed),
                        }
                    }
                    Decision::Refuse(why) => Plan::Skip(why, AskToolStatus::Refused),
                }
            };
            plans.push(plan);
        }
        let runs = calls.iter().zip(&plans).map(|(call, plan)| {
            let mcp = self.mcp.clone();
            let native = self.toolbox.is_native(&call.name);
            async move {
                match plan {
                    Plan::Skip(why, status) => (why.clone(), true, *status),
                    Plan::Run => {
                        let ran = match (native, mcp) {
                            (true, _) => ask_tools::run_native(&call.name, &call.input).await,
                            (false, Some(mcp)) => mcp.call(&call.name, &call.input).await,
                            (false, None) => Err("g1t's tools could not be reached.".to_owned()),
                        };
                        match ran {
                            Ok((text, false)) => (text, false, AskToolStatus::Done),
                            // Nothing there is an answer (a name checked free), not a read that failed.
                            Ok((text, true)) if ask_tools::is_not_found(&text) => (text, true, AskToolStatus::Done),
                            Ok((text, true)) => (text, true, AskToolStatus::Failed),
                            Err(problem) => (problem, true, AskToolStatus::Failed),
                        }
                    }
                }
            }
        });
        let results = futures_util::future::join_all(runs).await;
        let mut answered = Vec::with_capacity(calls.len());
        for ((call, id), (text, is_error, status)) in calls.iter().zip(&ids).zip(results) {
            let summary = ask_tools::summary(&text, is_error);
            let event = self.step(id, call, status, Some(summary));
            if status == AskToolStatus::Done {
                let direct = match (&event, call.input["number"].is_u64()) {
                    (AskEvent::Tool { link: Some(link), label, .. }, true) => Some((link.clone(), label.clone())),
                    _ => None,
                };
                self.sources.read(&self.site, &call.name, &call.input, &text, direct.as_ref().map(|(url, title)| (url.as_str(), title.as_str())));
            }
            self.out.push_back(ask::line(&event));
            // What the model is given: trimmed to fit, within what the
            // answer may read in all.
            let room = self.budget.room();
            let content = if room < 400 && !is_error {
                SPENT.to_owned()
            } else {
                ask_tools::trim_result(&text, room.max(400), ask_tools::Keep::of(&call.name, &call.input))
            };
            self.budget.chars += content.chars().count();
            answered.push(Answered { id: call.id.clone(), content, is_error });
        }
        self.rounds.extend(ask::tool_turns(self.provider.api(), &text, &calls, &answered));
        self.budget.rounds += 1;
        self.phase = Phase::Asking;
    }

    /// Asks the provider for the next round.
    async fn ask(&mut self) {
        let built = match self.request() {
            Ok(built) => built,
            Err(problem) => {
                self.out.push_back(ask::line(&AskEvent::Error { message: problem }));
                return self.finish().await;
            }
        };
        let headers: Vec<(&str, &str)> = built.headers.iter().map(|(name, value)| (name.as_str(), value.as_str())).collect();
        let label = self.provider.label();
        let opened = http::open(Method::Post, &built.url, &headers, Some(built.body)).await;
        let mut response = match opened {
            Ok(response) => response,
            Err(error) => {
                self.out.push_back(ask::line(&AskEvent::Error { message: format!("{label} could not be reached: {error}") }));
                return self.finish().await;
            }
        };
        let status = response.status_code();
        if !(200..300).contains(&status) {
            let body = response.text().await.unwrap_or_default();
            self.out.push_back(ask::line(&AskEvent::Error { message: refused_by(self.provider, status, body) }));
            return self.finish().await;
        }
        match response.stream() {
            Ok(upstream) => {
                self.phase = Phase::Streaming { upstream, round: Round::new(self.provider, !self.written.trim().is_empty()) };
            }
            Err(error) => {
                self.out.push_back(ask::line(&AskEvent::Error { message: format!("The answer from {label} broke off: {error}") }));
                self.finish().await;
            }
        }
    }

    /// The answer is over: its credential ends with it.
    async fn finish(&mut self) {
        self.phase = Phase::Finished;
        if let Some(id) = self.credential.take() {
            let _: worker::Result<bool> = g1t_kit::call(&self.identity, "revoke_ask_token", &RevokeAskTokenArgs { id }).await;
        }
    }
}

/// The answer's text in some lines, for finding what it cites.
fn texts(lines: &str) -> String {
    lines
        .lines()
        .filter_map(|line| match serde_json::from_str::<AskEvent>(line) {
            Ok(AskEvent::Text { text }) => Some(text),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answers_text_is_read_back_from_its_lines() {
        let lines = format!(
            "{}{}",
            ask::line(&AskEvent::Text { text: "See ".into() }),
            ask::line(&AskEvent::Text { text: "https://g1t.sh/a/b/pull/1".into() })
        );
        assert_eq!(texts(&lines), "See https://g1t.sh/a/b/pull/1");
        assert_eq!(texts(""), "");
    }

    #[test]
    fn an_answer_stops_calling_tools_at_its_bounds() {
        let start = 1_000_000;
        let mut budget = Budget::new(start);
        assert!(!budget.spent(start));
        // Calls run out.
        for _ in 0..ASK_MAX_TOOL_CALLS {
            assert!(budget.take_call(start));
        }
        assert!(!budget.take_call(start));
        assert!(budget.spent(start));
        // So do rounds.
        let mut budget = Budget::new(start);
        budget.rounds = ASK_MAX_TOOL_ROUNDS - 1;
        assert!(!budget.spent(start));
        budget.rounds += 1;
        assert!(budget.spent(start));
        assert!(!budget.overrun(), "one more round, to answer");
        budget.rounds += 1;
        assert!(budget.overrun());
        // And time.
        let budget = Budget::new(start);
        assert!(!budget.spent(start + ASK_MAX_TOOL_SECONDS * 1000));
        assert!(budget.spent(start + ASK_MAX_TOOL_SECONDS * 1000 + 1));
        // And what the model may be given: one result at most, then what is left.
        let mut budget = Budget::new(start);
        assert_eq!(budget.room(), ASK_MAX_TOOL_RESULT_CHARS);
        budget.chars = ASK_MAX_TOOL_TOTAL_CHARS - 1_000;
        assert_eq!(budget.room(), 1_000);
        budget.chars = ASK_MAX_TOOL_TOTAL_CHARS;
        assert_eq!(budget.room(), 0);
        assert!(budget.spent(start));
    }
}
