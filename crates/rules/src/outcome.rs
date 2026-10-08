//! How one ruleset judged one change, and how several stack.

use g1t_contracts::rules::{Applicable, BypassMode, Enforcement, Level, Verdict, Violation};

use crate::content::Problem;

/// One ruleset's judgement of one change to one ref.
#[derive(Clone, Debug, PartialEq)]
pub struct Judged {
    pub id: String,
    pub name: String,
    pub level: Level,
    pub enforcement: Enforcement,
    pub bypass: Option<BypassMode>,
    /// The full ref.
    pub git_ref: String,
    pub violations: Vec<Violation>,
    /// Whether the change is a pull request merging (a bypass "for pull
    /// requests" holds) rather than a push.
    pub merging: bool,
}

impl Judged {
    pub(crate) fn of(ruleset: &Applicable, git_ref: &str, merging: bool) -> Judged {
        Judged {
            id: ruleset.id.clone(),
            name: ruleset.name.clone(),
            level: ruleset.level,
            enforcement: ruleset.enforcement,
            bypass: ruleset.bypass,
            git_ref: git_ref.to_owned(),
            violations: Vec::new(),
            merging,
        }
    }

    pub(crate) fn add(&mut self, rule: &str, problem: Problem) {
        self.violations.push(Violation {
            rule: rule.to_owned(),
            ruleset_id: self.id.clone(),
            ruleset_name: self.name.clone(),
            enforcement: self.enforcement,
            message: problem.message,
            remedy: problem.remedy,
        });
    }

    /// Whether the actor's bypass holds for this change.
    pub fn bypassed(&self) -> bool {
        match self.bypass {
            Some(BypassMode::Always) => true,
            Some(BypassMode::PullRequests) => self.merging,
            None => false,
        }
    }

    pub fn verdict(&self) -> Verdict {
        if self.violations.is_empty() {
            Verdict::Pass
        } else if self.bypassed() {
            Verdict::Bypass
        } else {
            Verdict::Fail
        }
    }

    /// Whether it refuses the change: an active ruleset that failed.
    pub fn blocks(&self) -> bool {
        self.enforcement == Enforcement::Active && self.verdict() == Verdict::Fail
    }

    /// Whether it would refuse it, were it active.
    pub fn would_block(&self) -> bool {
        self.enforcement == Enforcement::Evaluate && self.verdict() == Verdict::Fail
    }
}

/// The violations that refuse the change, across rulesets.
pub fn blocking(judged: &[Judged]) -> Vec<&Violation> {
    judged.iter().filter(|one| one.blocks()).flat_map(|one| one.violations.iter()).collect()
}

/// The violations rulesets in `evaluate` would have refused it for.
pub fn would_block(judged: &[Judged]) -> Vec<&Violation> {
    judged.iter().filter(|one| one.would_block()).flat_map(|one| one.violations.iter()).collect()
}

/// Whether anything refuses the change.
pub fn refused(judged: &[Judged]) -> bool {
    judged.iter().any(Judged::blocks)
}
