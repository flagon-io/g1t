/**
 * Rulesets on the site: how each rule is shown and set up, a new ruleset
 * and rule with their defaults, export and import as JSON, and how people
 * read who may bypass a ruleset. The types are `@g1t/contracts`' rules.ts.
 */
import type {
  AppliesTo,
  BypassActor,
  Conditions,
  Enforcement,
  Level,
  PatternOperator,
  PatternParameters,
  Rule,
  RuleEntry,
  RuleType,
  RulesetSpec,
  Target,
} from "@g1t/contracts";

/** The default branch, whatever it is called (contracts' DEFAULT_BRANCH). */
export const DEFAULT_BRANCH = "~DEFAULT_BRANCH";
/** Every branch, tag or repository (contracts' ALL). */
export const ALL = "~ALL";

/** How each rule is shown and set up on the site. */
export type RuleTypeInfo = {
  type: RuleType;
  label: string;
  /** What it does, in a sentence. */
  about: string;
  group: "branches" | "pull_requests" | "commits" | "files" | "agents";
  /** Whether it can target tags, branches or both. */
  targets: Target[];
  /** Parameters a new rule starts with. */
  defaults: Rule["parameters"];
  /** Rules that may appear more than once. */
  repeatable?: boolean;
};

const none = {} as Record<string, never>;
const pattern = (operator: PatternOperator = "regex"): PatternParameters => ({ name: "", operator, pattern: "", negate: false });

export const RULES: RuleTypeInfo[] = [
  { type: "creation", label: "Restrict creations", about: "Only bypass actors may create matching branches or tags.", group: "branches", targets: ["branch", "tag"], defaults: none },
  { type: "update", label: "Restrict updates", about: "Only bypass actors may push to matching branches or tags, merges included.", group: "branches", targets: ["branch", "tag"], defaults: none },
  { type: "deletion", label: "Restrict deletions", about: "Only bypass actors may delete matching branches or tags.", group: "branches", targets: ["branch", "tag"], defaults: none },
  { type: "non_fast_forward", label: "Block force pushes", about: "Nobody rewrites history: a push must only add to it.", group: "branches", targets: ["branch", "tag"], defaults: none },
  { type: "required_linear_history", label: "Require linear history", about: "No merge commits: rebase instead of merging the branch in.", group: "commits", targets: ["branch", "tag"], defaults: none },
  { type: "required_signatures", label: "Require signed commits", about: "Every commit carries an SSH signature g1t verifies against its committer's account.", group: "commits", targets: ["branch", "tag"], defaults: none },
  {
    type: "pull_request",
    label: "Require a pull request before merging",
    about: "Changes arrive only through pull requests, with the reviews set here.",
    group: "pull_requests",
    targets: ["branch"],
    defaults: {
      required_approvals: 1,
      count_agent_approvals: true,
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_last_push_approval: false,
      allowed_merge_methods: [],
    },
  },
  {
    type: "required_status_checks",
    label: "Require status checks to pass",
    about: "Checks that must pass on a pull request's head before it merges, for every file or only some paths.",
    group: "pull_requests",
    targets: ["branch"],
    defaults: { checks: [], strict: false, paths: [], allow_bypass_on_merge: false },
    repeatable: true,
  },
  {
    type: "merge_queue",
    label: "Require the merge queue",
    about: "Merging into the default branch joins the queue, which tests pull requests together before it moves.",
    group: "pull_requests",
    targets: ["branch"],
    defaults: { merge_method: "merge", max_entries_to_build: 4, min_entries_to_merge: 1, min_entries_wait_minutes: 0, check_response_timeout_minutes: 45 },
  },
  { type: "required_deployments", label: "Require deployments to succeed", about: "A pull request's head must have deployed to these environments.", group: "pull_requests", targets: ["branch"], defaults: { environments: ["preview"] } },
  { type: "commit_message_pattern", label: "Commit message pattern", about: "Every commit message must match, or must not.", group: "commits", targets: ["branch", "tag"], defaults: pattern(), repeatable: true },
  { type: "commit_author_email_pattern", label: "Commit author email pattern", about: "Every author address must match, or must not.", group: "commits", targets: ["branch", "tag"], defaults: pattern("ends_with"), repeatable: true },
  { type: "committer_email_pattern", label: "Committer email pattern", about: "Every committer address must match, or must not.", group: "commits", targets: ["branch", "tag"], defaults: pattern("ends_with"), repeatable: true },
  { type: "branch_name_pattern", label: "Branch name pattern", about: "New branches must be named to match, or not to.", group: "branches", targets: ["branch"], defaults: pattern(), repeatable: true },
  { type: "tag_name_pattern", label: "Tag name pattern", about: "New tags must be named to match, or not to.", group: "branches", targets: ["tag"], defaults: pattern(), repeatable: true },
  { type: "file_path_restriction", label: "Restrict file paths", about: "Changes to matching paths are refused.", group: "files", targets: ["branch", "tag"], defaults: { restricted_file_paths: [] }, repeatable: true },
  { type: "file_extension_restriction", label: "Restrict file extensions", about: "Files with these extensions may not be added.", group: "files", targets: ["branch", "tag"], defaults: { restricted_file_extensions: [] } },
  { type: "max_file_size", label: "Restrict file size", about: "No file larger than this.", group: "files", targets: ["branch", "tag"], defaults: { max_file_size_mb: 10 } },
  { type: "max_file_path_length", label: "Restrict file path length", about: "No path longer than this.", group: "files", targets: ["branch", "tag"], defaults: { max_file_path_length: 255 } },
  { type: "max_files_changed", label: "Restrict files changed", about: "A commit may change at most this many files.", group: "files", targets: ["branch", "tag"], defaults: { max_files: 100 } },
  { type: "secret_scanning", label: "Block pushes that add secrets", about: "Every push is scanned; one too large to scan is refused instead of let through.", group: "files", targets: ["branch", "tag"], defaults: none },
  { type: "confidence_threshold", label: "Confidence threshold", about: "An agent's change rated below this needs approvals from people.", group: "agents", targets: ["branch"], defaults: { minimum: "medium", required_approvals: 1 } },
  { type: "cost_cap", label: "Cost cap", about: "Over this much agent spend, a pull request waits for a person before it merges or its agent continues.", group: "agents", targets: ["branch"], defaults: { max_usd: 10 } },
  { type: "path_review", label: "Review for sensitive paths", about: "Changes to these paths need approvals from people, from a team if you name one.", group: "agents", targets: ["branch"], defaults: { paths: [], required_approvals: 1, team: null }, repeatable: true },
  { type: "merge_window", label: "Merge window", about: "When pull requests may merge: weekly hours, freezes and exceptions.", group: "agents", targets: ["branch"], defaults: { time_zone: "UTC", windows: [], freezes: [], exceptions: [] } },
  { type: "agent_auto_merge", label: "Agent auto-merge", about: "Whether an agent's ready change lands here without a person, and how sure g1t must be.", group: "agents", targets: ["branch"], defaults: { allowed: true, minimum_confidence: null } },
];

export const RULE_GROUPS: { id: RuleTypeInfo["group"]; label: string }[] = [
  { id: "branches", label: "Branches and tags" },
  { id: "pull_requests", label: "Pull requests and checks" },
  { id: "commits", label: "Commits" },
  { id: "files", label: "Files" },
  { id: "agents", label: "Agents, review and timing" },
];

/** A rule type's information, or undefined for an unknown type. */
export function ruleInfo(type: string): RuleTypeInfo | undefined {
  return RULES.find((rule) => rule.type === type);
}

/** A new ruleset, as the form starts it. */
export function newRuleset(level: Level): RulesetSpec {
  return {
    name: "",
    enforcement: "active",
    target: "branch",
    conditions: {
      ref_name: { include: [DEFAULT_BRANCH], exclude: [] },
      ...(level === "workspace" ? { repository: { include: [ALL], exclude: [], visibility: "any" as const, topics: [] } } : {}),
    },
    bypass_actors: [],
    rules: [],
  };
}

/** A new rule of a type, with its defaults. */
export function newRule(type: RuleType, appliesTo: AppliesTo = "everyone"): RuleEntry {
  const info = ruleInfo(type);
  return { type, parameters: structuredClone(info?.defaults ?? {}), applies_to: appliesTo } as RuleEntry;
}

/** What a ruleset exports as: its spec, nothing about where it was kept. */
export function exportRuleset(ruleset: RulesetSpec): RulesetSpec {
  const { name, enforcement, target, conditions, bypass_actors, rules } = ruleset;
  return { name, enforcement, target, conditions, bypass_actors, rules };
}

const ENFORCEMENTS: Enforcement[] = ["active", "evaluate", "disabled"];
const APPLIES: AppliesTo[] = ["everyone", "agents", "people"];

/**
 * A ruleset from imported JSON: an exported one, or one as the API shows it
 * (`ruleset_name` read as its name). Parameters left out take their
 * defaults. Throws with what is wrong.
 */
export function importRuleset(text: string, level: Level): RulesetSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That is not JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("A ruleset is one JSON object.");
  const found = raw as Record<string, unknown>;
  const base = newRuleset(level);
  const name = typeof found.name === "string" ? found.name : typeof found.ruleset_name === "string" ? found.ruleset_name : "";
  const rules = Array.isArray(found.rules) ? (found.rules as Record<string, unknown>[]) : [];
  for (const rule of rules) {
    if (typeof rule?.type !== "string" || !ruleInfo(rule.type)) throw new Error(`${String(rule?.type)} is not a rule type.`);
  }
  const conditions = (found.conditions as Partial<Conditions> | undefined) ?? base.conditions;
  return {
    name,
    enforcement: ENFORCEMENTS.includes(found.enforcement as Enforcement) ? (found.enforcement as Enforcement) : "active",
    target: found.target === "tag" ? "tag" : "branch",
    conditions: {
      ref_name: { include: conditions.ref_name?.include ?? [], exclude: conditions.ref_name?.exclude ?? [] },
      ...(level === "workspace" ? { repository: conditions.repository ?? base.conditions.repository } : {}),
    },
    bypass_actors: Array.isArray(found.bypass_actors) ? (found.bypass_actors as BypassActor[]) : [],
    rules: rules.map((rule) => {
      const info = ruleInfo(rule.type as string)!;
      return {
        type: info.type,
        parameters: { ...structuredClone(info.defaults), ...((rule.parameters as object) ?? {}) },
        applies_to: APPLIES.includes(rule.applies_to as AppliesTo) ? (rule.applies_to as AppliesTo) : "everyone",
      } as RuleEntry;
    }),
  };
}

/** How people read who a bypass actor is. */
export function describeBypassActor(actor: BypassActor): string {
  switch (actor.kind) {
    case "g1t":
      return "g1t";
    case "role":
      return actor.value === "owner" ? "Workspace owners" : `${actor.value[0]?.toUpperCase() ?? ""}${actor.value.slice(1)} role and up`;
    case "team":
    case "user":
      return `@${actor.value}`;
    case "token":
      return actor.value === "workspace" ? "The workspace's tokens" : `Token ${actor.value}`;
  }
}

/** How people read whose changes a rule holds for. */
export function describeAppliesTo(appliesTo: AppliesTo): string {
  return appliesTo === "agents" ? "Agents' changes" : appliesTo === "people" ? "People's changes" : "Everyone";
}

function patternLabel(pattern: string): string {
  if (pattern === DEFAULT_BRANCH) return "Default branch";
  if (pattern === ALL) return "All";
  return pattern;
}

/** A name pattern as people read it: `~DEFAULT_BRANCH` is "Default branch". */
export { patternLabel };

/** What a ruleset targets, in a few words: "Default branch, release/*". */
export function targetSummary(ruleset: Pick<RulesetSpec, "conditions">): string {
  const include = ruleset.conditions.ref_name.include.map(patternLabel);
  const exclude = ruleset.conditions.ref_name.exclude.map(patternLabel);
  const what = include.length === 0 ? "Nothing yet" : include.join(", ");
  return exclude.length ? `${what}, except ${exclude.join(", ")}` : what;
}
