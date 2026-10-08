/**
 * An environment's protection rules as the Environments settings page
 * shows and posts them: what a form says, and a rule set in a few words.
 */
import type { BranchPattern, Environment, EnvironmentChange, EnvironmentReviewer } from "@g1t/contracts";

/** What an environment may be called: lowercase letters, digits, `-` and `_`, up to 40. */
export const ENVIRONMENT_NAME = /^[a-z0-9_-]{1,40}$/;

/** An environment's name as someone typed it, lowercased; null when it cannot be one. */
export function environmentName(value: string | null | undefined): string | null {
  const name = (value ?? "").trim().toLowerCase();
  return ENVIRONMENT_NAME.test(name) ? name : null;
}

/** The limits the actions service holds rules to. */
export type EnvironmentLimits = { reviewers: number; waitMinutes: number };

const POLICIES: Environment["branchPolicy"][] = ["all", "protected", "selected"];

/**
 * The rules a settings form posts: `reviewerType`/`reviewerName` and
 * `patternType`/`patternName` pairs in order, blanks left out. Reviewers
 * past the limit are an error; numbers are kept within theirs.
 */
export function environmentFromForm(form: FormData, limits: EnvironmentLimits): { change: EnvironmentChange } | { error: string } {
  const types = form.getAll("reviewerType").map(String);
  const reviewers: EnvironmentReviewer[] = [];
  const seen = new Set<string>();
  form.getAll("reviewerName").forEach((value, index) => {
    const name = String(value).trim().replace(/^@/, "");
    const type = types[index] === "team" ? "team" : "user";
    const key = `${type}:${name.toLowerCase()}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    reviewers.push({ type, name });
  });
  if (reviewers.length > limits.reviewers) {
    return { error: `An environment can have up to ${limits.reviewers} reviewers.` };
  }

  const minutes = Math.trunc(Number(form.get("waitMinutes") ?? 0));
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > limits.waitMinutes) {
    return { error: `The wait timer is a number of minutes from 0 to ${limits.waitMinutes.toLocaleString("en-US")}.` };
  }

  const policy = String(form.get("branchPolicy") ?? "all") as Environment["branchPolicy"];
  const branchPolicy = POLICIES.includes(policy) ? policy : "all";
  const patternTypes = form.getAll("patternType").map(String);
  const branchPatterns: BranchPattern[] = [];
  form.getAll("patternName").forEach((value, index) => {
    const name = String(value).trim();
    if (name) branchPatterns.push({ name, type: patternTypes[index] === "tag" ? "tag" : "branch" });
  });
  if (branchPolicy === "selected" && branchPatterns.length === 0) {
    return { error: "Add at least one branch or tag pattern, or choose another option for deployment branches." };
  }

  return {
    change: {
      reviewers,
      preventSelfReview: form.get("preventSelfReview") === "on",
      waitMinutes: minutes,
      branchPolicy,
      // Patterns only mean something for selected branches and tags.
      branchPatterns: branchPolicy === "selected" ? branchPatterns : [],
      adminsBypass: form.get("adminsBypass") === "on",
    },
  };
}

/** `30m`, `2h`, `1d 4h`: a wait timer in short. */
export function waitWords(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return [days && `${days}d`, hours && `${hours}h`, rest && `${rest}m`].filter(Boolean).join(" ");
}

/** A reviewer as the pages show one: a user by name, a team as @team. */
export function reviewerLabel(reviewer: EnvironmentReviewer): string {
  return reviewer.type === "team" ? `@${reviewer.name}` : reviewer.name;
}

/** An environment's rules in a few words each, for its row in the list. */
export function environmentSummary(environment: Environment): string[] {
  if (!environment.protected) return [];
  const parts: string[] = [];
  const { reviewers } = environment;
  if (reviewers.length > 0) {
    parts.push(
      reviewers.length <= 2
        ? `Reviewers: ${reviewers.map(reviewerLabel).join(", ")}`
        : `${reviewers.length} reviewers`,
    );
  }
  if (environment.waitMinutes > 0) parts.push(`Wait ${waitWords(environment.waitMinutes)}`);
  if (environment.branchPolicy === "protected") parts.push("Protected branches only");
  if (environment.branchPolicy === "selected") {
    const count = environment.branchPatterns.length;
    parts.push(`${count} branch and tag pattern${count === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) parts.push("No reviewers, wait timer or branch limits");
  return parts;
}
