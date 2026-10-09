/**
 * What a routine can run on, in words, and routines that fit an agent's
 * responsibilities, for owners to add in one step: Margo's "Reviewing pull
 * requests for risk and test coverage" runs when a pull request is ready
 * for review. Matched on words, never by a model, so it is instant and the
 * same every time. Pure, so it is tested on its own.
 */
import type { NewRoutine, RoutineEvent, RoutineSuggestion } from "@g1t/contracts";

/** The events a routine can run on, by key. */
export const EVENT_KEYS: RoutineEvent[] = ["pull_ready", "pull_merged", "checks_failed", "issue_opened", "deploy_failed"];

const WORDS: Record<RoutineEvent, string> = {
  pull_ready: "a pull request is ready for review",
  pull_merged: "a pull request is merged",
  checks_failed: "checks fail on a pull request",
  issue_opened: "an issue is opened",
  deploy_failed: "a deploy fails",
};

/** A routine's events in words: "When a pull request is ready for review or checks fail on a pull request". */
export function describeEvents(events: RoutineEvent[]): string {
  const list = events.map((e) => WORDS[e]).filter(Boolean);
  if (!list.length) return "";
  const joined = list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} or ${list.at(-1)}`;
  return `When ${joined}`;
}

const trimmed = (duty: string) => duty.trim().replace(/\.$/, "");

type Rule = { match: RegExp; routine: (duty: string) => Omit<NewRoutine, "channel_id"> };

const RULES: Rule[] = [
  {
    match: /\b(docs|documentation|pages|runbooks?|artifacts?)\b.*\b(change|changes|merge|merges|wrong|current|up to date|stale)\b/i,
    routine: (duty) => ({
      name: "Keep the docs current",
      instructions: `When a pull request is merged, keep the docs true (${trimmed(duty)}). Find the docs it makes wrong or incomplete: stale_artifacts for this repository first (docs citing code it changed), then search_artifacts for what it changed. Update each with edit_artifact (it becomes a suggestion where you can't edit), citing the pull request, with marks_current when it brings a stale doc up to date. Post a short list of what you changed here; say so if nothing needed changing.`,
      schedule: null,
      events: ["pull_merged"],
      repos: [],
    }),
  },
  {
    match: /\b(review|reviewing|reviews)\b.*\b(pull requests?|prs?|changes?|code)\b|\b(pull requests?|prs?)\b.*\breview/i,
    routine: (duty) => ({
      name: "Review pull requests",
      instructions: `When a pull request is ready for review, review it (${trimmed(duty)}). Read the change and its checks, then post your review on the pull request with review_pull: what it changes, the risks, which tests cover it and what they miss, and a verdict (approve, or request changes with what to fix first). Then post a two-line summary here with a link.`,
      schedule: null,
      events: ["pull_ready"],
      repos: [],
    }),
  },
  {
    match: /\b(flaky|failing|broken)\b.*\b(checks?|tests?|builds?|ci)\b|\b(checks?|ci|builds?)\b.*\b(flaky|fail)/i,
    routine: (duty) => ({
      name: "Chase failing checks",
      instructions: `When checks fail on a pull request, look into it (${trimmed(duty)}). Read the failure, say whether it looks real or flaky and why, and what to do next. If a flaky check keeps coming back, offer to file an issue.`,
      schedule: null,
      events: ["checks_failed"],
      repos: [],
    }),
  },
  {
    match: /\btest plans?\b|\bnew features?\b.*\btest/i,
    routine: (duty) => ({
      name: "Test plans for new work",
      instructions: `When an issue is opened for new work, draft a test plan (${trimmed(duty)}): what to test, the edge cases, and what can be automated. Post it on the issue with comment, and a one-line note here. Skip bug reports and questions.`,
      schedule: null,
      events: ["issue_opened"],
      repos: [],
    }),
  },
  {
    match: /\b(triage|triaging)\b|\bincoming (issues|bugs|requests)\b/i,
    routine: (duty) => ({
      name: "Triage new issues",
      instructions: `When an issue is opened, triage it (${trimmed(duty)}): what it is (bug, feature, question), how urgent, which area of the code it touches, and who should own it.`,
      schedule: null,
      events: ["issue_opened"],
      repos: [],
    }),
  },
  {
    match: /\b(deploys?|deployments?|incidents?|on-?call|outages?|rollbacks?)\b/i,
    routine: (duty) => ({
      name: "Watch deploys",
      instructions: `When a deploy fails, find out why (${trimmed(duty)}): what failed, what changed since the last good deploy, and whether to retry, roll back or fix forward.`,
      schedule: null,
      events: ["deploy_failed"],
      repos: [],
    }),
  },
  {
    match: /\b(release notes|changelog|what shipped|weekly (summary|update|digest)|digests?)\b/i,
    routine: (duty) => ({
      name: "Weekly summary",
      instructions: `Every Friday (${trimmed(duty)}): what merged and shipped this week, what's still open and what's at risk, in a short post people can skim.`,
      schedule: { every: "week", minute: 0, hour: 16, weekday: 5 },
      events: [],
      repos: [],
    }),
  },
  {
    match: /\b(support|customers?|tickets?|complaints?|feedback)\b/i,
    routine: (duty) => ({
      name: "Support themes",
      instructions: `Every weekday morning (${trimmed(duty)}): read yesterday's conversations you can see, group questions and complaints into themes, and post the top ones with how often each came up and whether an issue already covers it.`,
      schedule: { every: "weekday", minute: 0, hour: 9, weekday: 1 },
      events: [],
      repos: [],
    }),
  },
];

/**
 * Routines for an agent's responsibilities that it doesn't have yet: one
 * per kind, skipping those whose name it already uses or whose events its
 * routines already run on.
 */
export function suggestRoutines(responsibilities: string[], existing: { name: string; events: RoutineEvent[] }[]): RoutineSuggestion[] {
  const out: RoutineSuggestion[] = [];
  const taken = new Set(existing.map((r) => r.name.toLowerCase()));
  const covered = new Set(existing.flatMap((r) => r.events));
  for (const duty of responsibilities) {
    const rule = RULES.find((r) => r.match.test(duty));
    if (!rule) continue;
    const routine = rule.routine(duty);
    if (taken.has(routine.name.toLowerCase())) continue;
    if (routine.events?.length && routine.events.every((e) => covered.has(e))) continue;
    taken.add(routine.name.toLowerCase());
    out.push({ responsibility: duty, routine });
  }
  return out;
}
