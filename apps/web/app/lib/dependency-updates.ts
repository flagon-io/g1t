/**
 * How the Security page words the dependency update file: when an entry
 * next runs, what each rule says, and which pull requests are live. Only
 * type imports, so it is tested on its own.
 */
import type { IgnoreCondition, UpdateGroup, UpdateIgnore, UpdatePull, VersionUpdateEntry } from "@g1t/contracts";

/** Where the docs explain the dependency update file. */
export const DEPENDENCY_UPDATES_DOCS = "https://docs.g1t.sh/guides/dependency-updates/";

const UNITS: [string, number][] = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
];

/** A time ahead, said shortly: "in 3h", "in 2d", "due now". */
export function timeUntil(at: string, now: number = Date.now()): string {
  const ahead = new Date(at).getTime() - now;
  if (!Number.isFinite(ahead) || ahead <= 60_000) return "due now";
  const [unit, size] = UNITS.find(([, size]) => ahead >= size) ?? UNITS[UNITS.length - 1]!;
  return `in ${Math.floor(ahead / size)}${unit}`;
}

/** A moment in UTC, for a title attribute: "2026-10-12 05:00 UTC". */
export function utc(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Where an entry stands, in a word or two, and how to tone it. */
export function entryStatus(entry: VersionUpdateEntry): { label: string; tone: "accent" | "neutral" | "warn" | "danger" } {
  if (!entry.supported) return { label: "Not updated yet", tone: "neutral" };
  if (entry.openPullRequestsLimit === 0) return { label: "Off", tone: "neutral" };
  if (!entry.nextRunAt) return { label: "Not scheduled", tone: "warn" };
  if (entry.lastError) return { label: "Last check failed", tone: "danger" };
  return { label: "Active", tone: "accent" };
}

/** A `groups` rule in a line: "lint: eslint*, prettier (minor, patch)". */
export function groupText(group: UpdateGroup): string {
  const parts = [group.patterns.length > 0 ? group.patterns.join(", ") : "every dependency"];
  if (group.excludePatterns.length > 0) parts.push(`not ${group.excludePatterns.join(", ")}`);
  if (group.dependencyType) parts.push(group.dependencyType);
  if (group.updateTypes.length > 0) parts.push(group.updateTypes.join(", "));
  if (group.groupBy) parts.push("one per dependency");
  const security = group.appliesTo === "security-updates" ? " · security updates" : "";
  return `${group.name}: ${parts.join(" · ")}${security}`;
}

function level(updateType: string): string {
  return updateType.replace("version-update:semver-", "");
}

/** An `ignore` rule in a line: "react >=19", "* major". */
export function ignoreText(rule: UpdateIgnore): string {
  const what = [...rule.versions, ...rule.updateTypes.map(level)];
  return what.length > 0 ? `${rule.dependency} ${what.join(", ")}` : `${rule.dependency} (every version)`;
}

/** An ignore condition from a comment, in a few words. */
export function conditionText(condition: IgnoreCondition): string {
  if (condition.versions) return condition.versions;
  if (condition.updateType) return `${level(condition.updateType)} versions`;
  return "every version";
}

/** Update pull requests worth showing: those open or being made, newest first. */
export function livePulls(pulls: UpdatePull[]): UpdatePull[] {
  return pulls.filter((pull) => pull.state === "requested" || pull.state === "open" || pull.state === "needs_code");
}

/** How an update pull request's state reads. */
export const PULL_STATES: Record<UpdatePull["state"], string> = {
  requested: "Being made",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
  superseded: "Superseded",
  needs_code: "Needs code changes",
  failed: "Failed",
};
