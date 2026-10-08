import type { RepoPath } from "./repos";
import type { Result } from "./result";
import type { User, Viewer } from "./identity";
import type { ConfidenceLevel } from "./work";

/**
 * Rulesets: what may happen to a repository's branches and tags, and what a
 * pull request needs before it merges. A ruleset belongs to a repository or
 * to a workspace (and through it to the repositories it selects), targets
 * branches or tags by name, is `active`, `evaluate` (a dry run that records
 * what it would have refused) or `disabled`, lists who may bypass it, and
 * holds rules. Rulesets stack: every rule of each holds.
 *
 * Mirrors `crates/contracts/src/rules.rs`. Rulesets travel in the shape the
 * API shows them, `snake_case`, so an export imports anywhere unchanged.
 */

export const DEFAULT_BRANCH = "~DEFAULT_BRANCH";
export const ALL = "~ALL";
export const MAX_RULESETS = 75;

export type Enforcement = "active" | "evaluate" | "disabled";
export type Target = "branch" | "tag";
export type Level = "repository" | "workspace";
export type AppliesTo = "everyone" | "agents" | "people";
export type BypassActorKind = "role" | "team" | "user" | "token" | "g1t";
export type BypassMode = "always" | "pull_requests";
export type MergeMethod = "merge" | "squash" | "rebase";
export type Integration = "actions" | "deployments" | "security" | "g1t";
export type PatternOperator = "starts_with" | "ends_with" | "contains" | "regex";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type RefCondition = { include: string[]; exclude: string[] };
export type RepositoryCondition = {
  include: string[];
  exclude: string[];
  visibility: "any" | "public" | "private";
  topics: string[];
};
export type Conditions = { ref_name: RefCondition; repository?: RepositoryCondition };
export type BypassActor = { kind: BypassActorKind; value: string; mode: BypassMode };

export type PullRequestParameters = {
  required_approvals: number;
  count_agent_approvals: boolean;
  dismiss_stale_reviews_on_push: boolean;
  require_code_owner_review: boolean;
  require_last_push_approval: boolean;
  allowed_merge_methods: MergeMethod[];
  /** Only the ruleset made from branch protection that did not refuse pushes. */
  allow_direct_pushes?: boolean;
};
export type RulesetCheck = { context: string; integration?: Integration };
export type StatusChecksParameters = {
  checks: RulesetCheck[];
  strict: boolean;
  paths: string[];
  allow_bypass_on_merge: boolean;
};
export type MergeQueueParameters = {
  merge_method: MergeMethod;
  max_entries_to_build: number;
  min_entries_to_merge: number;
  min_entries_wait_minutes: number;
  check_response_timeout_minutes: number;
};
export type PatternParameters = { name: string; operator: PatternOperator; pattern: string; negate: boolean };
export type WeeklyWindow = { days: Weekday[]; start: string; end: string };
export type Period = { start: string; end?: string | null; reason: string };
export type MergeWindowParameters = {
  time_zone: string;
  windows: WeeklyWindow[];
  freezes: Period[];
  exceptions: Period[];
};

/** Every rule type, with its parameters. */
export type Rule =
  | { type: "creation"; parameters: Record<string, never> }
  | { type: "update"; parameters: Record<string, never> }
  | { type: "deletion"; parameters: Record<string, never> }
  | { type: "non_fast_forward"; parameters: Record<string, never> }
  | { type: "required_linear_history"; parameters: Record<string, never> }
  | { type: "required_signatures"; parameters: Record<string, never> }
  | { type: "pull_request"; parameters: PullRequestParameters }
  | { type: "required_status_checks"; parameters: StatusChecksParameters }
  | { type: "merge_queue"; parameters: MergeQueueParameters }
  | { type: "required_deployments"; parameters: { environments: string[] } }
  | { type: "commit_message_pattern"; parameters: PatternParameters }
  | { type: "commit_author_email_pattern"; parameters: PatternParameters }
  | { type: "committer_email_pattern"; parameters: PatternParameters }
  | { type: "branch_name_pattern"; parameters: PatternParameters }
  | { type: "tag_name_pattern"; parameters: PatternParameters }
  | { type: "file_path_restriction"; parameters: { restricted_file_paths: string[] } }
  | { type: "file_extension_restriction"; parameters: { restricted_file_extensions: string[] } }
  | { type: "max_file_size"; parameters: { max_file_size_mb: number } }
  | { type: "max_file_path_length"; parameters: { max_file_path_length: number } }
  | { type: "max_files_changed"; parameters: { max_files: number } }
  | { type: "secret_scanning"; parameters: Record<string, never> }
  | { type: "confidence_threshold"; parameters: { minimum: ConfidenceLevel; required_approvals: number } }
  | { type: "cost_cap"; parameters: { max_usd: number } }
  | { type: "path_review"; parameters: { paths: string[]; required_approvals: number; team?: string | null } }
  | { type: "merge_window"; parameters: MergeWindowParameters }
  | { type: "agent_auto_merge"; parameters: { allowed: boolean; minimum_confidence?: ConfidenceLevel | null } };

export type RuleType = Rule["type"];
export type RuleEntry = Rule & { applies_to: AppliesTo };

/** What a ruleset says: what is created, changed, exported and imported. */
export type RulesetSpec = {
  name: string;
  enforcement: Enforcement;
  target: Target;
  conditions: Conditions;
  bypass_actors: BypassActor[];
  rules: RuleEntry[];
};

export type Ruleset = RulesetSpec & {
  id: string;
  level: Level;
  workspace: string;
  repo_id?: string;
  repository?: string;
  /** `branch_protection` for the one made from branch protection settings. */
  source?: string;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
};

export type RulesetSummary = {
  id: string;
  name: string;
  level: Level;
  enforcement: Enforcement;
  bypass_actors: BypassActor[];
};

export type EffectiveRule = RuleEntry & {
  ruleset_id: string;
  ruleset_name: string;
  level: Level;
  enforcement: Enforcement;
};

export type EffectiveRules = {
  name: string;
  target: Target;
  default_branch: boolean;
  rules: EffectiveRule[];
  rulesets: RulesetSummary[];
};

export type RuleVerdict = "pass" | "fail" | "bypass";
export type Action = "push" | "merge" | "create_ref" | "delete_ref" | "rename_ref" | "commit";

export type Violation = {
  rule: string;
  ruleset_id: string;
  ruleset_name: string;
  enforcement: Enforcement;
  message: string;
  remedy: string;
};

export type Evaluation = {
  id: string;
  repo_id: string;
  workspace: string;
  ruleset_id: string;
  ruleset_name: string;
  enforcement: Enforcement;
  action: Action;
  git_ref: string;
  actor: string;
  actor_kind: string;
  verdict: RuleVerdict;
  violations: Violation[];
  number: number | null;
  sha: string | null;
  repository: string;
  created_at: string;
};

export type Insights = {
  days: number;
  total: number;
  passed: number;
  blocked: number;
  would_block: number;
  bypassed: number;
  by_ruleset: {
    ruleset_id: string;
    ruleset_name: string;
    enforcement: Enforcement;
    total: number;
    blocked: number;
    would_block: number;
    bypassed: number;
  }[];
  by_rule: { rule: string; count: number }[];
};

export type EvaluationPage = { evaluations: Evaluation[]; next: string | null; insights: Insights };

/** What a pull request's merge box shows of the rules of its base. */
export type MergeRules = {
  unmet: Violation[];
  bypassable: Violation[];
  evaluate: Violation[];
  rulesets: RulesetSummary[];
  merge_queue: boolean;
  /** What the active rules ask, as they stack. */
  required_approvals: number;
  strict: boolean;
  allow_bypass_on_merge: boolean;
};

/** Whose rulesets: a repository's or a workspace's. */
export type RulesetOwner = { repo: RepoPath } | { workspace: string };

export type EvaluationFilter = {
  ruleset_id?: string;
  verdict?: RuleVerdict;
  problems_only?: boolean;
  before?: string;
  limit?: number;
};

export interface RulesApi {
  listRulesets(owner: RulesetOwner, viewer: Viewer, includeParents?: boolean): Promise<Result<Ruleset[]>>;
  getRuleset(owner: RulesetOwner, id: string, viewer: Viewer): Promise<Result<Ruleset>>;
  /** Creates one (no `id`) or replaces one. */
  saveRuleset(actor: User, owner: RulesetOwner, ruleset: RulesetSpec, id?: string): Promise<Result<Ruleset>>;
  deleteRuleset(actor: User, owner: RulesetOwner, id: string): Promise<Result<boolean>>;
  effectiveRules(repo: RepoPath, name: string, viewer: Viewer, target?: Target): Promise<Result<EffectiveRules>>;
  ruleEvaluations(owner: RulesetOwner, viewer: Viewer, filter?: EvaluationFilter): Promise<Result<EvaluationPage>>;
}
