//! Rulesets: what may happen to a repository's branches and tags, and what
//! a pull request needs before it merges.
//!
//! A **ruleset** belongs to a repository, or to a workspace and through it
//! to every repository it selects. It targets branches or tags by name
//! (fnmatch patterns, `~DEFAULT_BRANCH`, `~ALL`), lists the rules that hold
//! there, and who may bypass them. Its enforcement is `active` (rules hold),
//! `evaluate` (nothing is refused; what would have been is recorded), or
//! `disabled`.
//!
//! Several rulesets can target the same branch. They stack: every rule of
//! every active ruleset holds, so the most restrictive wins (the largest
//! approval count, every required check, the narrowest merge window).
//!
//! Each rule can hold for everyone, only for agents' changes, or only for
//! people's ([`AppliesTo`]). Agents, g1t's own included, obey rules exactly
//! as people do unless a ruleset lists them as a bypass actor: nobody
//! bypasses by default.
//!
//! The rules engine (`crates/rules`) decides; the work service keeps the
//! rulesets and every evaluation, and enforces them on merge; the repos
//! service enforces them on push and on every change to a branch or tag.
//!
//! Rulesets travel in the shape the API shows them: `snake_case` fields,
//! between services too, so that an exported ruleset imports unchanged on
//! the site, through the API and through MCP. Mirrors
//! `packages/contracts/src/rules.ts`.

use serde::{Deserialize, Serialize};

use crate::repos::RepoPath;
pub use crate::work::ConfidenceLevel;
use crate::{User, Viewer};

/// The repository's default branch, whatever it is called at the time.
pub const DEFAULT_BRANCH: &str = "~DEFAULT_BRANCH";
/// Every branch or tag, or every repository.
pub const ALL: &str = "~ALL";
/// Rulesets a repository, or a workspace, may have.
pub const MAX_RULESETS: usize = 75;
/// Rules in one ruleset.
pub const MAX_RULES: usize = 50;
/// Patterns in one list (branches, paths, extensions, repositories).
pub const MAX_PATTERNS: usize = 100;
/// The longest pattern, regular expression or name kept.
pub const MAX_PATTERN_CHARS: usize = 512;
/// Bypass actors in one ruleset.
pub const MAX_BYPASS_ACTORS: usize = 50;
/// Required approvals a pull request rule may ask for.
pub const MAX_APPROVALS: u32 = 10;
/// The ruleset made from a repository's branch protection, as it was
/// before rulesets: its `source`.
pub const BRANCH_PROTECTION: &str = "branch_protection";

/// Whether a ruleset's rules hold.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Enforcement {
    /// Its rules hold, and what breaks them is refused.
    #[default]
    Active,
    /// A dry run: nothing is refused, and every push or merge it would
    /// have refused is recorded, for its insights.
    Evaluate,
    /// Kept, but not evaluated at all.
    Disabled,
}

impl Enforcement {
    pub fn as_str(self) -> &'static str {
        match self {
            Enforcement::Active => "active",
            Enforcement::Evaluate => "evaluate",
            Enforcement::Disabled => "disabled",
        }
    }
}

/// What a ruleset's name conditions match.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Target {
    #[default]
    Branch,
    Tag,
}

impl Target {
    pub fn as_str(self) -> &'static str {
        match self {
            Target::Branch => "branch",
            Target::Tag => "tag",
        }
    }

    /// The full ref of `name`: `refs/heads/<name>` or `refs/tags/<name>`.
    pub fn full_ref(self, name: &str) -> String {
        match self {
            Target::Branch => format!("refs/heads/{name}"),
            Target::Tag => format!("refs/tags/{name}"),
        }
    }

    /// The target and short name of a full ref, if it is a branch or a tag.
    pub fn of_ref(git_ref: &str) -> Option<(Target, &str)> {
        if let Some(name) = git_ref.strip_prefix("refs/heads/") {
            return Some((Target::Branch, name));
        }
        git_ref.strip_prefix("refs/tags/").map(|name| (Target::Tag, name))
    }
}

/// Whose ruleset it is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    #[default]
    Repository,
    Workspace,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Repository => "repository",
            Level::Workspace => "workspace",
        }
    }
}

/// Which branches or tags a ruleset holds for, by name. A name matches when
/// it matches an `include` pattern and no `exclude` pattern. Patterns are
/// fnmatch: `*` matches within one path segment, `**` across them, `?` one
/// character, `[abc]` one of a set. `~DEFAULT_BRANCH` is the default
/// branch, `~ALL` everything. An empty `include` matches nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RefCondition {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}

/// Which visibility of repository a workspace ruleset selects.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VisibilityCondition {
    #[default]
    Any,
    Public,
    Private,
}

/// Which of a workspace's repositories its ruleset holds in: those whose
/// name matches an `include` pattern (fnmatch, or `~ALL`) and no `exclude`
/// one, of the `visibility` chosen, and, when `topics` is not empty,
/// carrying at least one of them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RepositoryCondition {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub visibility: VisibilityCondition,
    pub topics: Vec<String>,
}

impl Default for RepositoryCondition {
    fn default() -> Self {
        RepositoryCondition {
            include: vec![ALL.to_owned()],
            exclude: Vec::new(),
            visibility: VisibilityCondition::Any,
            topics: Vec::new(),
        }
    }
}

/// Where a ruleset holds. `repository` is a workspace ruleset's only.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Conditions {
    pub ref_name: RefCondition,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<RepositoryCondition>,
}

/// Who a bypass actor is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    /// Everyone with at least this repository role (`value`: `write`,
    /// `maintain` or `admin`), or the workspace's owners (`owner`).
    Role,
    /// The people of a team (`value`: its slug, or `workspace/slug`), its
    /// child teams' people included.
    Team,
    /// One person, by username.
    User,
    /// An access token, by its id; `value` `workspace` is any of the
    /// workspace's own tokens.
    Token,
    /// g1t: its agent at work in a sandbox, and the platform acting on its
    /// own (the merge queue, security updates). Never a bypass actor
    /// unless listed.
    G1t,
}

/// When a bypass actor may bypass.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BypassMode {
    /// Always: pushes and merges alike.
    #[default]
    Always,
    /// Only when merging a pull request; their pushes obey the rules.
    PullRequests,
}

impl BypassMode {
    pub fn as_str(self) -> &'static str {
        match self {
            BypassMode::Always => "always",
            BypassMode::PullRequests => "pull_requests",
        }
    }
}

/// Someone a ruleset does not hold for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BypassActor {
    pub kind: ActorKind,
    /// Who, as [`ActorKind`] says. Empty for `g1t`.
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub mode: BypassMode,
}

/// Whose changes a rule holds for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppliesTo {
    #[default]
    Everyone,
    /// Only agents' changes: a push by an agent, a pull request an agent
    /// made (g1t's or another's through a token).
    Agents,
    /// Only people's changes.
    People,
}

impl AppliesTo {
    pub fn as_str(self) -> &'static str {
        match self {
            AppliesTo::Everyone => "everyone",
            AppliesTo::Agents => "agents",
            AppliesTo::People => "people",
        }
    }

    /// Whether it holds for a change by an agent (`agent`) or a person.
    pub fn covers(self, agent: bool) -> bool {
        match self {
            AppliesTo::Everyone => true,
            AppliesTo::Agents => agent,
            AppliesTo::People => !agent,
        }
    }
}

/// A rule with no parameters.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoParameters {}

/// How a pull request is merged.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeMethod {
    /// The branch lands as it is, its commits included: how g1t merges.
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            MergeMethod::Merge => "merge",
            MergeMethod::Squash => "squash",
            MergeMethod::Rebase => "rebase",
        }
    }
}

/// `pull_request`: changes reach the branch only by merging a pull request,
/// and the pull request needs what this says first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PullRequestRule {
    /// Approving reviews needed. A reviewer who has since asked for
    /// changes blocks it; nobody approves their own.
    pub required_approvals: u32,
    /// Whether an agent's approval (g1t's reviewer) counts towards
    /// `required_approvals`. Off means only people's approvals count.
    pub count_agent_approvals: bool,
    /// Approvals given before the latest push no longer count.
    pub dismiss_stale_reviews_on_push: bool,
    /// The code owners of every file it changes must approve.
    pub require_code_owner_review: bool,
    /// Someone other than whoever pushed last must approve after that push.
    pub require_last_push_approval: bool,
    /// The ways it may be merged. Empty allows every one.
    pub allowed_merge_methods: Vec<MergeMethod>,
    /// Pull requests need what this rule says, but pushes straight to the
    /// branch are still allowed. Off (the default) refuses them. Only the
    /// ruleset made from branch protection that did not require pull
    /// requests turns it on.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub allow_direct_pushes: bool,
}

impl Default for PullRequestRule {
    fn default() -> Self {
        PullRequestRule {
            required_approvals: 0,
            count_agent_approvals: true,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            allowed_merge_methods: Vec::new(),
            allow_direct_pushes: false,
        }
    }
}

/// Where a required check's status must come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Integration {
    /// Workflow runs (`.g1t/workflows`).
    Actions,
    /// Deployments: `g1t / deploy`.
    Deployments,
    /// The security suite: code scanning and dependency review.
    Security,
    /// g1t itself, such as code owners.
    G1t,
}

impl Integration {
    pub fn as_str(self) -> &'static str {
        match self {
            Integration::Actions => "actions",
            Integration::Deployments => "deployments",
            Integration::Security => "security",
            Integration::G1t => "g1t",
        }
    }

    pub fn parse(text: &str) -> Option<Integration> {
        match text {
            "actions" => Some(Integration::Actions),
            "deployments" => Some(Integration::Deployments),
            "security" => Some(Integration::Security),
            "g1t" => Some(Integration::G1t),
            _ => None,
        }
    }
}

/// One check that must pass: a workflow's name (`CI`) or another status's
/// context, and, if set, the integration that must have reported it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequiredCheck {
    pub context: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration: Option<Integration>,
}

/// `required_status_checks`: these checks must pass on a pull request's
/// head before it merges.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[derive(Default)]
pub struct StatusChecksRule {
    pub checks: Vec<RequiredCheck>,
    /// The pull request must contain the branch's latest commits, so that
    /// what merges is what was checked.
    pub strict: bool,
    /// Required only when the pull request changes a file matching one of
    /// these patterns. Empty: always.
    pub paths: Vec<String>,
    /// Someone who may merge can merge past checks that have not passed,
    /// saying so as they merge.
    pub allow_bypass_on_merge: bool,
}


/// `merge_queue`: merging joins the queue, which tests each pull request
/// together with those ahead of it. The queue lands on the default branch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MergeQueueRule {
    pub merge_method: MergeMethod,
    /// Entries tested at once.
    pub max_entries_to_build: u32,
    /// Entries a batch waits for before it starts, unless the oldest has
    /// waited `min_entries_wait_minutes`.
    pub min_entries_to_merge: u32,
    pub min_entries_wait_minutes: u32,
    /// How long a batch's checks may take before it is tested again.
    pub check_response_timeout_minutes: u32,
}

impl Default for MergeQueueRule {
    fn default() -> Self {
        MergeQueueRule {
            merge_method: MergeMethod::Merge,
            max_entries_to_build: 4,
            min_entries_to_merge: 1,
            min_entries_wait_minutes: 0,
            check_response_timeout_minutes: 45,
        }
    }
}

/// `required_deployments`: a pull request's head must have deployed
/// successfully to these environments: `preview` (its preview), or a
/// project's slug for a repository with several.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DeploymentsRule {
    pub environments: Vec<String>,
}

/// How a pattern rule compares.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatternOperator {
    #[default]
    StartsWith,
    EndsWith,
    Contains,
    /// A regular expression, run by a linear-time engine.
    Regex,
}

/// A rule about text: a commit message, an author's or committer's email
/// address, a branch's or tag's name. The text must match the pattern, or
/// with `negate`, must not.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PatternRule {
    /// What people are told the rule is, such as "Conventional commits".
    pub name: String,
    pub operator: PatternOperator,
    pub pattern: String,
    pub negate: bool,
}

/// `file_path_restriction`: pushes and pull requests may not change files
/// matching these patterns (fnmatch, `**` across directories).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FilePathRule {
    pub restricted_file_paths: Vec<String>,
}

/// `file_extension_restriction`: files with these extensions (`.exe`,
/// `.zip`) may not be added or changed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FileExtensionRule {
    pub restricted_file_extensions: Vec<String>,
}

/// `max_file_size`: no file larger than this, in megabytes (1 to 100).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MaxFileSizeRule {
    pub max_file_size_mb: u32,
}

impl Default for MaxFileSizeRule {
    fn default() -> Self {
        MaxFileSizeRule { max_file_size_mb: 10 }
    }
}

/// `max_file_path_length`: no path longer than this many characters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MaxFilePathLengthRule {
    pub max_file_path_length: u32,
}

impl Default for MaxFilePathLengthRule {
    fn default() -> Self {
        MaxFilePathLengthRule { max_file_path_length: 255 }
    }
}

/// `max_files_changed`: a push's commits, each, and a pull request as a
/// whole, change at most this many files.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MaxFilesChangedRule {
    pub max_files: u32,
}

impl Default for MaxFilesChangedRule {
    fn default() -> Self {
        MaxFilesChangedRule { max_files: 100 }
    }
}

/// `confidence_threshold`: an agent's change g1t rates below `minimum`
/// needs approvals from people before it merges.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ConfidenceRule {
    pub minimum: ConfidenceLevel,
    pub required_approvals: u32,
}

impl Default for ConfidenceRule {
    fn default() -> Self {
        ConfidenceRule { minimum: ConfidenceLevel::Medium, required_approvals: 1 }
    }
}

/// `cost_cap`: once agents have spent more than this on a pull request, in
/// US dollars, it neither merges nor is sent back to its agent until a
/// person approves it after that.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CostCapRule {
    pub max_usd: f64,
}

impl Default for CostCapRule {
    fn default() -> Self {
        CostCapRule { max_usd: 10.0 }
    }
}

/// `path_review`: a pull request that changes a file matching `paths`
/// needs `required_approvals` from people, from `team` when one is named
/// (its slug, or `workspace/slug`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PathReviewRule {
    pub paths: Vec<String>,
    pub required_approvals: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
}

impl Default for PathReviewRule {
    fn default() -> Self {
        PathReviewRule { paths: Vec::new(), required_approvals: 1, team: None }
    }
}

/// A day of the week.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl Weekday {
    pub const ALL: [Weekday; 7] = [
        Weekday::Mon,
        Weekday::Tue,
        Weekday::Wed,
        Weekday::Thu,
        Weekday::Fri,
        Weekday::Sat,
        Weekday::Sun,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Weekday::Mon => "mon",
            Weekday::Tue => "tue",
            Weekday::Wed => "wed",
            Weekday::Thu => "thu",
            Weekday::Fri => "fri",
            Weekday::Sat => "sat",
            Weekday::Sun => "sun",
        }
    }
}

/// Hours on some days of the week when merging is allowed, `HH:MM` to
/// `HH:MM` in the rule's time zone. An `end` before `start` runs past
/// midnight.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WeeklyWindow {
    pub days: Vec<Weekday>,
    pub start: String,
    pub end: String,
}

/// A stretch of time, RFC 3339 UTC. With no `end`, it lasts until removed:
/// an incident freeze.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Period {
    pub start: String,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub reason: String,
}

/// `merge_window`: when pull requests may merge into the branch. Outside
/// every `windows` entry (when there are any), or during a `freezes` one,
/// merging waits, unless an `exceptions` entry covers the moment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MergeWindowRule {
    /// A fixed offset from UTC, `+02:00` or `-05:00`; `UTC` or empty is UTC.
    /// Daylight saving time is not applied.
    pub time_zone: String,
    pub windows: Vec<WeeklyWindow>,
    pub freezes: Vec<Period>,
    pub exceptions: Vec<Period>,
}

impl Default for MergeWindowRule {
    fn default() -> Self {
        MergeWindowRule {
            time_zone: "UTC".to_owned(),
            windows: Vec::new(),
            freezes: Vec::new(),
            exceptions: Vec::new(),
        }
    }
}

/// `agent_auto_merge`: whether g1t lands an agent's ready pull request into
/// the branch without a person pressing merge, and how sure of it g1t must
/// be. The repository's auto-merge setting must be on as well.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentAutoMergeRule {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum_confidence: Option<ConfidenceLevel>,
}

impl Default for AgentAutoMergeRule {
    fn default() -> Self {
        AgentAutoMergeRule { allowed: true, minimum_confidence: None }
    }
}

/// One rule and its parameters, tagged by `type`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "parameters", rename_all = "snake_case")]
pub enum Rule {
    /// Only bypass actors may create a matching branch or tag.
    Creation(NoParameters),
    /// Only bypass actors may push to (move) a matching branch or tag.
    Update(NoParameters),
    /// Only bypass actors may delete a matching branch or tag.
    Deletion(NoParameters),
    /// Nobody force pushes: a push must only add to its history.
    NonFastForward(NoParameters),
    /// No merge commits: history stays a straight line.
    RequiredLinearHistory(NoParameters),
    /// Every commit carries a signature g1t verifies.
    RequiredSignatures(NoParameters),
    PullRequest(PullRequestRule),
    RequiredStatusChecks(StatusChecksRule),
    MergeQueue(MergeQueueRule),
    RequiredDeployments(DeploymentsRule),
    CommitMessagePattern(PatternRule),
    CommitAuthorEmailPattern(PatternRule),
    CommitterEmailPattern(PatternRule),
    BranchNamePattern(PatternRule),
    TagNamePattern(PatternRule),
    FilePathRestriction(FilePathRule),
    FileExtensionRestriction(FileExtensionRule),
    MaxFileSize(MaxFileSizeRule),
    MaxFilePathLength(MaxFilePathLengthRule),
    MaxFilesChanged(MaxFilesChangedRule),
    /// Pushes that add a secret are refused, whatever the repository's own
    /// push protection setting says.
    SecretScanning(NoParameters),
    ConfidenceThreshold(ConfidenceRule),
    CostCap(CostCapRule),
    PathReview(PathReviewRule),
    MergeWindow(MergeWindowRule),
    AgentAutoMerge(AgentAutoMergeRule),
}

impl Rule {
    /// Its `type`, as the API names it.
    pub fn kind(&self) -> &'static str {
        match self {
            Rule::Creation(_) => "creation",
            Rule::Update(_) => "update",
            Rule::Deletion(_) => "deletion",
            Rule::NonFastForward(_) => "non_fast_forward",
            Rule::RequiredLinearHistory(_) => "required_linear_history",
            Rule::RequiredSignatures(_) => "required_signatures",
            Rule::PullRequest(_) => "pull_request",
            Rule::RequiredStatusChecks(_) => "required_status_checks",
            Rule::MergeQueue(_) => "merge_queue",
            Rule::RequiredDeployments(_) => "required_deployments",
            Rule::CommitMessagePattern(_) => "commit_message_pattern",
            Rule::CommitAuthorEmailPattern(_) => "commit_author_email_pattern",
            Rule::CommitterEmailPattern(_) => "committer_email_pattern",
            Rule::BranchNamePattern(_) => "branch_name_pattern",
            Rule::TagNamePattern(_) => "tag_name_pattern",
            Rule::FilePathRestriction(_) => "file_path_restriction",
            Rule::FileExtensionRestriction(_) => "file_extension_restriction",
            Rule::MaxFileSize(_) => "max_file_size",
            Rule::MaxFilePathLength(_) => "max_file_path_length",
            Rule::MaxFilesChanged(_) => "max_files_changed",
            Rule::SecretScanning(_) => "secret_scanning",
            Rule::ConfidenceThreshold(_) => "confidence_threshold",
            Rule::CostCap(_) => "cost_cap",
            Rule::PathReview(_) => "path_review",
            Rule::MergeWindow(_) => "merge_window",
            Rule::AgentAutoMerge(_) => "agent_auto_merge",
        }
    }

    /// How people are shown it.
    pub fn label(&self) -> &'static str {
        match self {
            Rule::Creation(_) => "Restrict creations",
            Rule::Update(_) => "Restrict updates",
            Rule::Deletion(_) => "Restrict deletions",
            Rule::NonFastForward(_) => "Block force pushes",
            Rule::RequiredLinearHistory(_) => "Require linear history",
            Rule::RequiredSignatures(_) => "Require signed commits",
            Rule::PullRequest(_) => "Require a pull request before merging",
            Rule::RequiredStatusChecks(_) => "Require status checks to pass",
            Rule::MergeQueue(_) => "Require the merge queue",
            Rule::RequiredDeployments(_) => "Require deployments to succeed",
            Rule::CommitMessagePattern(_) => "Commit message pattern",
            Rule::CommitAuthorEmailPattern(_) => "Commit author email pattern",
            Rule::CommitterEmailPattern(_) => "Committer email pattern",
            Rule::BranchNamePattern(_) => "Branch name pattern",
            Rule::TagNamePattern(_) => "Tag name pattern",
            Rule::FilePathRestriction(_) => "Restrict file paths",
            Rule::FileExtensionRestriction(_) => "Restrict file extensions",
            Rule::MaxFileSize(_) => "Restrict file size",
            Rule::MaxFilePathLength(_) => "Restrict file path length",
            Rule::MaxFilesChanged(_) => "Restrict files changed",
            Rule::SecretScanning(_) => "Block pushes that add secrets",
            Rule::ConfidenceThreshold(_) => "Confidence threshold",
            Rule::CostCap(_) => "Cost cap",
            Rule::PathReview(_) => "Review for sensitive paths",
            Rule::MergeWindow(_) => "Merge window",
            Rule::AgentAutoMerge(_) => "Agent auto-merge",
        }
    }

    /// Whether the rule is about pushes: what a push may do or bring.
    /// Pull request rules hold on merge.
    pub fn on_push(&self) -> bool {
        matches!(
            self,
            Rule::Creation(_)
                | Rule::Update(_)
                | Rule::Deletion(_)
                | Rule::NonFastForward(_)
                | Rule::RequiredLinearHistory(_)
                | Rule::RequiredSignatures(_)
                | Rule::PullRequest(_)
                | Rule::MergeQueue(_)
                | Rule::CommitMessagePattern(_)
                | Rule::CommitAuthorEmailPattern(_)
                | Rule::CommitterEmailPattern(_)
                | Rule::BranchNamePattern(_)
                | Rule::TagNamePattern(_)
                | Rule::FilePathRestriction(_)
                | Rule::FileExtensionRestriction(_)
                | Rule::MaxFileSize(_)
                | Rule::MaxFilePathLength(_)
                | Rule::MaxFilesChanged(_)
                | Rule::SecretScanning(_)
        )
    }

    /// Whether it says anything only tags can break (or only branches).
    pub fn for_branches_only(&self) -> bool {
        matches!(
            self,
            Rule::PullRequest(_)
                | Rule::RequiredStatusChecks(_)
                | Rule::MergeQueue(_)
                | Rule::RequiredDeployments(_)
                | Rule::BranchNamePattern(_)
                | Rule::ConfidenceThreshold(_)
                | Rule::CostCap(_)
                | Rule::PathReview(_)
                | Rule::MergeWindow(_)
                | Rule::AgentAutoMerge(_)
        )
    }

    pub fn for_tags_only(&self) -> bool {
        matches!(self, Rule::TagNamePattern(_))
    }
}

/// One rule of a ruleset, and whose changes it holds for. `parameters`
/// may be left out, or left partly out: what is missing takes its default.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RuleEntry {
    #[serde(flatten)]
    pub rule: Rule,
    pub applies_to: AppliesTo,
}

impl<'de> Deserialize<'de> for RuleEntry {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Written {
            #[serde(rename = "type")]
            kind: String,
            #[serde(default)]
            parameters: serde_json::Value,
            #[serde(default)]
            applies_to: AppliesTo,
        }
        let written = Written::deserialize(deserializer)?;
        let parameters = match written.parameters {
            serde_json::Value::Null => serde_json::json!({}),
            other => other,
        };
        let rule = serde_json::from_value(serde_json::json!({ "type": written.kind, "parameters": parameters }))
            .map_err(serde::de::Error::custom)?;
        Ok(RuleEntry { rule, applies_to: written.applies_to })
    }
}

impl RuleEntry {
    pub fn everyone(rule: Rule) -> RuleEntry {
        RuleEntry { rule, applies_to: AppliesTo::Everyone }
    }
}

/// What a ruleset says, as it is created, changed, exported and imported.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RulesetSpec {
    pub name: String,
    pub enforcement: Enforcement,
    pub target: Target,
    pub conditions: Conditions,
    pub bypass_actors: Vec<BypassActor>,
    pub rules: Vec<RuleEntry>,
}

/// A ruleset, as it is kept.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Ruleset {
    pub id: String,
    pub level: Level,
    /// The workspace it belongs to, or its repository's.
    pub workspace: String,
    /// A repository ruleset's repository: its id and `owner/name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(flatten)]
    pub spec: RulesetSpec,
    /// `branch_protection` for the ruleset made from a repository's branch
    /// protection settings when rulesets arrived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub created_by: String,
    /// RFC 3339.
    pub created_at: String,
    pub updated_by: String,
    pub updated_at: String,
}

/// Whose rulesets: a repository's (`repo`) or a workspace's (`workspace`).
/// Exactly one is set.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Owner {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<RepoPath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

impl Owner {
    pub fn repo(path: RepoPath) -> Owner {
        Owner { repo: Some(path), workspace: None }
    }

    pub fn workspace(slug: &str) -> Owner {
        Owner { repo: None, workspace: Some(slug.to_lowercase()) }
    }
}

/// `list_rulesets`: a repository's or a workspace's rulesets. With
/// `include_parents`, a repository's list also has its workspace's
/// rulesets that hold in it. Anyone who may see the repository (members,
/// for a workspace). Returns `Outcome<Vec<Ruleset>>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ListRulesetsArgs {
    pub viewer: Viewer,
    #[serde(flatten)]
    pub owner: Owner,
    #[serde(default)]
    pub include_parents: bool,
}

/// `get_ruleset`. Returns `Outcome<Ruleset>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GetRulesetArgs {
    pub viewer: Viewer,
    #[serde(flatten)]
    pub owner: Owner,
    pub id: String,
}

/// `save_ruleset`: creates one (no `id`) or replaces one. The Maintain
/// role on a repository (`ManageProtection`); a workspace's owners for its
/// own. Returns `Outcome<Ruleset>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SaveRulesetArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: Owner,
    #[serde(default)]
    pub id: Option<String>,
    pub ruleset: RulesetSpec,
    /// Set by the API, which records the change in the audit log itself.
    #[serde(default)]
    pub from_api: bool,
}

/// `delete_ruleset`. Returns `Outcome<bool>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeleteRulesetArgs {
    pub actor: User,
    #[serde(flatten)]
    pub owner: Owner,
    pub id: String,
    #[serde(default)]
    pub from_api: bool,
}

/// `effective_rules`: every rule that holds for a branch (or a tag, with
/// `target` `tag`) of a repository, with the ruleset each comes from.
/// Returns `Outcome<EffectiveRules>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EffectiveRulesArgs {
    pub viewer: Viewer,
    pub repo: RepoPath,
    pub name: String,
    #[serde(default)]
    pub target: Target,
}

/// A rule that holds for a branch, and where it comes from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EffectiveRule {
    #[serde(flatten)]
    pub entry: RuleEntry,
    pub ruleset_id: String,
    pub ruleset_name: String,
    pub level: Level,
    pub enforcement: Enforcement,
}

/// What holds for one branch or tag.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EffectiveRules {
    pub name: String,
    pub target: Target,
    /// Whether it is the repository's default branch.
    pub default_branch: bool,
    /// Active rules first, then those being evaluated.
    pub rules: Vec<EffectiveRule>,
    /// The rulesets that hold, by id: their names and who may bypass them.
    pub rulesets: Vec<RulesetSummary>,
}

/// A ruleset in brief.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RulesetSummary {
    pub id: String,
    pub name: String,
    pub level: Level,
    pub enforcement: Enforcement,
    pub bypass_actors: Vec<BypassActor>,
}

/// What a change was: a push, a merge, or a change made through g1t.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Push,
    Merge,
    CreateRef,
    DeleteRef,
    RenameRef,
    /// A commit made through g1t, such as a web edit.
    Commit,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Push => "push",
            Action::Merge => "merge",
            Action::CreateRef => "create_ref",
            Action::DeleteRef => "delete_ref",
            Action::RenameRef => "rename_ref",
            Action::Commit => "commit",
        }
    }
}

/// How an evaluation came out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// Every rule was met.
    Pass,
    /// A rule was broken and the change refused (an active ruleset), or
    /// would have been (`evaluate`).
    Fail,
    /// A rule was broken by a bypass actor, who was let through.
    Bypass,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Pass => "pass",
            Verdict::Fail => "fail",
            Verdict::Bypass => "bypass",
        }
    }
}

/// One rule that a change breaks, and how to meet it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Violation {
    /// The rule's `type`.
    pub rule: String,
    pub ruleset_id: String,
    pub ruleset_name: String,
    pub enforcement: Enforcement,
    /// What is wrong, in a sentence.
    pub message: String,
    /// How to satisfy it, in a sentence. May be empty.
    #[serde(default)]
    pub remedy: String,
}

/// One ruleset's evaluation of one change, as it is recorded.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NewEvaluation {
    pub repo_id: String,
    pub workspace: String,
    pub ruleset_id: String,
    pub ruleset_name: String,
    pub enforcement: Enforcement,
    pub action: Action,
    /// The full ref: `refs/heads/main`.
    pub git_ref: String,
    pub actor: String,
    /// `person`, `agent` or `g1t`.
    pub actor_kind: String,
    pub verdict: Verdict,
    #[serde(default)]
    pub violations: Vec<Violation>,
    /// The pull request merged, for a merge.
    #[serde(default)]
    pub number: Option<u32>,
    /// The commit it would have moved the ref to.
    #[serde(default)]
    pub sha: Option<String>,
}

/// A recorded evaluation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Evaluation {
    pub id: String,
    #[serde(flatten)]
    pub evaluation: NewEvaluation,
    /// `owner/name`, as it was.
    #[serde(default)]
    pub repository: String,
    /// RFC 3339.
    pub created_at: String,
}

/// `record_evaluations`: services only. Returns how many were kept.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordEvaluationsArgs {
    pub evaluations: Vec<NewEvaluation>,
}

/// `rule_evaluations`: the latest evaluations of a repository's or a
/// workspace's rulesets, newest first, filtered. Returns
/// `Outcome<EvaluationPage>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvaluationsArgs {
    pub viewer: Viewer,
    #[serde(flatten)]
    pub owner: Owner,
    #[serde(default)]
    pub ruleset_id: Option<String>,
    #[serde(default)]
    pub verdict: Option<Verdict>,
    /// Only those that broke a rule (failed, would have failed, bypassed).
    #[serde(default)]
    pub problems_only: bool,
    /// An evaluation's id: only older ones.
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// A page of evaluations, and how they came out over the last 30 days.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EvaluationPage {
    pub evaluations: Vec<Evaluation>,
    /// The `before` for the next page, when there is one.
    #[serde(default)]
    pub next: Option<String>,
    pub insights: Insights,
}

/// How a ruleset's evaluations came out.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Insights {
    pub days: u32,
    pub total: u32,
    pub passed: u32,
    /// Refused by an active ruleset.
    pub blocked: u32,
    /// Would have been refused by a ruleset in `evaluate`.
    pub would_block: u32,
    pub bypassed: u32,
    /// Per ruleset, most problems first.
    pub by_ruleset: Vec<RulesetInsight>,
    /// Per rule type, most problems first.
    pub by_rule: Vec<RuleInsight>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RulesetInsight {
    pub ruleset_id: String,
    pub ruleset_name: String,
    pub enforcement: Enforcement,
    pub total: u32,
    pub blocked: u32,
    pub would_block: u32,
    pub bypassed: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RuleInsight {
    pub rule: String,
    pub count: u32,
}

/// A ruleset that holds for refs a service is about to change, with
/// whether the actor may bypass it and how. What `ref_rules` returns.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Applicable {
    pub id: String,
    pub name: String,
    pub level: Level,
    pub enforcement: Enforcement,
    pub target: Target,
    pub conditions: RefCondition,
    pub rules: Vec<RuleEntry>,
    /// How the actor may bypass it, if they may.
    #[serde(default)]
    pub bypass: Option<BypassMode>,
}

/// `ref_rules`: services only. The rulesets of a repository (its own and
/// its workspace's) that are not disabled and hold for any of `refs` (full
/// refs), with whether `actor` may bypass each. Returns
/// `Outcome<RefRules>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RefRulesArgs {
    /// The repository, as the repos service read it.
    pub repo: crate::repos::Repo,
    pub actor: Option<User>,
    pub refs: Vec<String>,
}

/// What a pull request's merge box shows of the rules for the branch it
/// merges into, for whoever is looking.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MergeRules {
    /// Rules not met, which refuse the merge.
    pub unmet: Vec<Violation>,
    /// Rules not met that the viewer may bypass, by asking to as they
    /// merge (`bypass_rules`).
    pub bypassable: Vec<Violation>,
    /// Rules of rulesets in `evaluate` that would refuse it.
    pub evaluate: Vec<Violation>,
    /// The rulesets that hold for the branch.
    pub rulesets: Vec<RulesetSummary>,
    /// Whether merging joins the merge queue.
    pub merge_queue: bool,
    /// What the active rules ask, as they stack: the approvals a merge
    /// needs, whether it must be up to date, and whether a merger may merge
    /// past required checks that have not passed.
    #[serde(default)]
    pub required_approvals: u32,
    #[serde(default)]
    pub strict: bool,
    #[serde(default)]
    pub allow_bypass_on_merge: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RefRules {
    pub default_branch: String,
    pub workspace: String,
    pub rulesets: Vec<Applicable>,
}

/// What g1t made of a commit's signature.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Signature {
    #[default]
    Unsigned,
    /// Valid, made with a key the account owning the committer's verified
    /// address registered: that account's username.
    Verified { signer: String },
    /// Signed, but not verified: why.
    Unverified { reason: String },
}

/// One file a commit adds, changes or deletes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    /// Its size in bytes, when its content is new and was read.
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub deleted: bool,
}

/// What rules about commits look at, for one commit.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitFacts {
    pub sha: String,
    /// At most 4 KiB of it.
    pub message: String,
    #[serde(default)]
    pub author_email: Option<String>,
    #[serde(default)]
    pub committer_email: Option<String>,
    pub parents: u32,
    #[serde(default)]
    pub signature: Signature,
    #[serde(default)]
    pub files: Vec<FileChange>,
    /// Whether `files` is every file it changes.
    #[serde(default)]
    pub files_complete: bool,
}

/// `inspect_commits`: services only. The commits a branch of `source_id`
/// adds on top of `base_branch` of `target_id`, read as rules look at
/// them, at most `limit`. Returns `Outcome<InspectedCommits>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InspectCommitsArgs {
    pub source_id: String,
    pub head: String,
    pub target_id: String,
    pub base_branch: String,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InspectedCommits {
    pub commits: Vec<CommitFacts>,
    /// Whether `commits` holds every commit the branch adds, each read in
    /// full. A change too large to read is not.
    pub complete: bool,
}

/// What kind of actor a change is by, for rules that hold only for agents'
/// or people's changes and for the evaluation log.
pub fn actor_kind(actor: &User) -> &'static str {
    use crate::PrincipalKind;
    match actor.kind {
        PrincipalKind::System => "g1t",
        PrincipalKind::Agent => "agent",
        _ if actor.acting.is_some() => "agent",
        PrincipalKind::Workspace => "token",
        PrincipalKind::User => "person",
    }
}

/// Whether the actor is an agent: g1t's, or another acting through an
/// agent token. g1t acting on its own counts as an agent.
pub fn is_agent(actor: &User) -> bool {
    matches!(actor_kind(actor), "agent" | "g1t")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_rule_is_its_type_and_parameters() {
        let entry = RuleEntry {
            rule: Rule::PullRequest(PullRequestRule { required_approvals: 2, ..PullRequestRule::default() }),
            applies_to: AppliesTo::Agents,
        };
        let value = serde_json::to_value(&entry).unwrap();
        assert_eq!(value["type"], "pull_request");
        assert_eq!(value["parameters"]["required_approvals"], 2);
        assert_eq!(value["applies_to"], "agents");
        let back: RuleEntry = serde_json::from_value(value).unwrap();
        assert_eq!(back, entry);
    }

    #[test]
    fn parameters_left_out_take_their_defaults() {
        let entry: RuleEntry = serde_json::from_value(json!({ "type": "deletion" })).unwrap();
        assert_eq!(entry.rule, Rule::Deletion(NoParameters {}));
        assert_eq!(entry.applies_to, AppliesTo::Everyone);
        let entry: RuleEntry = serde_json::from_value(json!({ "type": "deletion", "parameters": {} })).unwrap();
        assert_eq!(entry.rule.kind(), "deletion");
        let entry: RuleEntry =
            serde_json::from_value(json!({ "type": "merge_queue", "parameters": { "max_entries_to_build": 8 } })).unwrap();
        let Rule::MergeQueue(queue) = entry.rule else { panic!() };
        assert_eq!((queue.max_entries_to_build, queue.check_response_timeout_minutes), (8, 45));
    }

    #[test]
    fn every_rule_type_reads_back_as_it_is_named() {
        let rules = [
            Rule::Creation(NoParameters {}),
            Rule::Update(NoParameters {}),
            Rule::Deletion(NoParameters {}),
            Rule::NonFastForward(NoParameters {}),
            Rule::RequiredLinearHistory(NoParameters {}),
            Rule::RequiredSignatures(NoParameters {}),
            Rule::PullRequest(PullRequestRule::default()),
            Rule::RequiredStatusChecks(StatusChecksRule::default()),
            Rule::MergeQueue(MergeQueueRule::default()),
            Rule::RequiredDeployments(DeploymentsRule::default()),
            Rule::CommitMessagePattern(PatternRule::default()),
            Rule::CommitAuthorEmailPattern(PatternRule::default()),
            Rule::CommitterEmailPattern(PatternRule::default()),
            Rule::BranchNamePattern(PatternRule::default()),
            Rule::TagNamePattern(PatternRule::default()),
            Rule::FilePathRestriction(FilePathRule::default()),
            Rule::FileExtensionRestriction(FileExtensionRule::default()),
            Rule::MaxFileSize(MaxFileSizeRule::default()),
            Rule::MaxFilePathLength(MaxFilePathLengthRule::default()),
            Rule::MaxFilesChanged(MaxFilesChangedRule::default()),
            Rule::SecretScanning(NoParameters {}),
            Rule::ConfidenceThreshold(ConfidenceRule::default()),
            Rule::CostCap(CostCapRule::default()),
            Rule::PathReview(PathReviewRule::default()),
            Rule::MergeWindow(MergeWindowRule::default()),
            Rule::AgentAutoMerge(AgentAutoMergeRule::default()),
        ];
        for rule in rules {
            let value = serde_json::to_value(RuleEntry::everyone(rule.clone())).unwrap();
            assert_eq!(value["type"], rule.kind());
            let back: RuleEntry = serde_json::from_value(value).unwrap();
            assert_eq!(back.rule, rule);
            assert!(!rule.label().is_empty());
        }
    }

    #[test]
    fn a_ruleset_reads_as_the_api_shows_it() {
        let ruleset: RulesetSpec = serde_json::from_value(json!({
            "name": "Protect main",
            "enforcement": "evaluate",
            "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH", "release/**"], "exclude": [] } },
            "bypass_actors": [{ "kind": "role", "value": "admin", "mode": "pull_requests" }, { "kind": "g1t" }],
            "rules": [{ "type": "non_fast_forward" }, { "type": "required_status_checks", "parameters": { "checks": [{ "context": "CI", "integration": "actions" }], "strict": true } }]
        }))
        .unwrap();
        assert_eq!(ruleset.enforcement, Enforcement::Evaluate);
        assert_eq!(ruleset.target, Target::Branch);
        assert_eq!(ruleset.bypass_actors[1], BypassActor { kind: ActorKind::G1t, value: String::new(), mode: BypassMode::Always });
        let Rule::RequiredStatusChecks(checks) = &ruleset.rules[1].rule else { panic!() };
        assert_eq!(checks.checks[0].integration, Some(Integration::Actions));
        assert!(checks.strict);
    }

    #[test]
    fn refs_split_into_their_target_and_name() {
        assert_eq!(Target::of_ref("refs/heads/release/1.x"), Some((Target::Branch, "release/1.x")));
        assert_eq!(Target::of_ref("refs/tags/v1"), Some((Target::Tag, "v1")));
        assert_eq!(Target::of_ref("refs/notes/x"), None);
        assert_eq!(Target::Tag.full_ref("v2"), "refs/tags/v2");
    }

    #[test]
    fn whose_change_it_is() {
        assert!(AppliesTo::Everyone.covers(true) && AppliesTo::Everyone.covers(false));
        assert!(AppliesTo::Agents.covers(true) && !AppliesTo::Agents.covers(false));
        assert!(AppliesTo::People.covers(false) && !AppliesTo::People.covers(true));
        let person = User { id: "usr_1".into(), username: "ada".into(), ..User::default() };
        assert_eq!(actor_kind(&person), "person");
        assert!(!is_agent(&person));
        assert!(is_agent(&User::system("acme")));
    }
}
