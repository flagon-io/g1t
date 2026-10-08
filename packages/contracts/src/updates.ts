/**
 * Dependency updates: the file that asks for them, written in
 * `dependabot.yml` (version 2) syntax, and the pull requests g1t opens from
 * it. Mirrors `g1t_contracts::updates`.
 */

/** Where the dependency update file may be, in the order it is looked for. */
export const DEPENDABOT_PATHS = [
  ".g1t/dependabot.yml",
  ".g1t/dependabot.yaml",
  ".github/dependabot.yml",
  ".github/dependabot.yaml",
] as const;

/** The status a pull request that changes the file gets on its head. */
export const DEPENDABOT_CHECK = "g1t / dependabot.yml";

/** One thing wrong with the dependency update file, and where. */
export type ConfigProblem = {
  /** 1-based; 0 when the problem is with the file as a whole. */
  line: number;
  column: number;
  /** The key it is about: `updates[0].schedule.interval`. */
  key: string;
  message: string;
};

/** A `groups` rule. */
export type UpdateGroup = {
  name: string;
  /** `version-updates` or `security-updates`. */
  appliesTo: string;
  patterns: string[];
  excludePatterns: string[];
  /** `major`, `minor`, `patch`; every one when empty. */
  updateTypes: string[];
  dependencyType: string | null;
  groupBy: string | null;
};

/** An `ignore` rule. */
export type UpdateIgnore = {
  dependency: string;
  versions: string[];
  updateTypes: string[];
};

/** An `allow` rule. */
export type UpdateAllow = {
  dependency: string | null;
  dependencyType: string | null;
  updateTypes: string[];
};

/** One entry of the file's `updates`, and where its version updates stand. */
export type VersionUpdateEntry = {
  /** What "Check for updates" names. */
  id: string;
  /** `package-ecosystem`, as written. */
  ecosystem: string;
  directories: string[];
  /** Whether g1t opens version update pull requests for this ecosystem. */
  supported: boolean;
  interval: string;
  /** The schedule in words: "Weekdays at 05:00 (UTC)". */
  schedule: string;
  openPullRequestsLimit: number;
  targetBranch: string | null;
  multiEcosystemGroup: string | null;
  groups: UpdateGroup[];
  ignore: UpdateIgnore[];
  allow: UpdateAllow[];
  /** Null for the default labels; empty for none. */
  labels: string[] | null;
  assignees: string[];
  reviewers: string[];
  milestone: number | null;
  versioningStrategy: string | null;
  /** The entry as read, with the file's own key names. */
  options: Record<string, unknown>;
  /** Options g1t reads but does not act on, each with why. */
  notes: string[];
  nextRunAt: string | null;
  lastCheckedAt: string | null;
  lastResult: string | null;
  lastError: string | null;
};

/** A private registry from the file, without its credentials. */
export type UpdateRegistry = {
  name: string;
  kind: string;
  url: string;
  /** The secrets its credentials name. */
  secrets: string[];
};

/** One dependency an update pull request raises. */
export type UpdatedDependency = {
  name: string;
  from: string;
  to: string;
  directory: string;
  dependencyType: string;
  updateType: string;
};

/** A pull request g1t opened, or is making, to update dependencies. */
export type UpdatePull = {
  kind: "version" | "security";
  entry: string;
  ecosystem: string;
  group: string | null;
  branch: string;
  title: string;
  state: "requested" | "open" | "merged" | "closed" | "superseded" | "needs_code" | "failed";
  pull: number | null;
  dependencies: UpdatedDependency[];
  mergeRequestedBy: string | null;
  error: string | null;
  updatedAt: string;
};

/** A dependency, or some of its versions, skipped because someone said so in a comment. */
export type IgnoreCondition = {
  ecosystem: string;
  dependency: string;
  versions: string | null;
  updateType: string | null;
  by: string;
  pull: number | null;
  at: string;
};

/** What the dependency update file asks for, as last read from the default branch. */
export type VersionUpdatesState = {
  found: boolean;
  /** The file read. */
  path: string | null;
  /** Other dependency update files, not read because `path` comes first. */
  ignoredPaths: string[];
  /** The first problem, as a sentence. */
  error: string | null;
  problems: ConfigProblem[];
  updates: VersionUpdateEntry[];
  registries: UpdateRegistry[];
  readAt: string | null;
  commit: string | null;
  pulls: UpdatePull[];
  ignores: IgnoreCondition[];
};

/** One package of a grouped `bump`. */
export type BumpPackage = { package: string; version: string };

/** A private registry a `bump` sandbox's tools may read, with its credentials. */
export type BumpRegistry = {
  type: string;
  url: string;
  username?: string;
  password?: string;
  token?: string;
  replacesBase?: boolean;
  scopes?: string[];
};
