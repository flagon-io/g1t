/**
 * Getting started: the setup guide that opens on a workspace's Home for its
 * owners until they finish or dismiss it (components/onboarding.tsx).
 *
 * Whether each step is done is read from the workspace itself, never from
 * clicks: its AI providers and whether one works, what Ask answers with,
 * its projects and GitHub, the person's g1t CLI sign-in and the apps they
 * signed in to (the Claude Code plugin is one), its members and
 * invitations, its runners. Identity keeps only what the person chose
 * (`Onboarding`: dismissed, skipped). Pure, so it is tested on its own
 * (onboarding.test.ts); lib/onboarding.server.ts reads the facts.
 */
import type { AiConnection, AskSetup, Onboarding, OnboardingStep } from "@g1t/contracts";

/** What the guide reads from the workspace, each null when its service did not answer. */
export type OnboardingFacts = {
  /** The workspace's AI providers: how many, and how many passed their last check. */
  providers: { total: number; working: number } | null;
  /** Ask answers with a provider, and it has no problem. */
  askReady: boolean | null;
  /** The provider and model Ask answers with, as the AI page shows them. */
  askWith: string | null;
  /** How many projects the workspace has. */
  projects: number | null;
  /** Whether g1t's GitHub App is installed for it, and whether this g1t offers the app at all. */
  github: { configured: boolean; connected: boolean } | null;
  /** Whether the person signed the g1t CLI in. */
  cli: boolean | null;
  /** Whether the person signed an app in with g1t, as the Claude Code plugin does. */
  harnessApp: boolean | null;
  /** Members besides the person, and invitations waiting for an answer. */
  people: { others: number; pending: number } | null;
  /** Whether workspace invites need the plan first (a free workspace). */
  invitesNeedPlan: boolean;
  /** The workspace's self-hosted runners. */
  runners: number | null;
};

/** One step, as the guide shows it. */
export type OnboardingStepView = {
  key: OnboardingStep;
  title: string;
  /** One line under the title in the rail. */
  summary: string;
  /** Done, from the workspace's state. */
  done: boolean;
  /** Skipped by the person. */
  skipped: boolean;
  /** Whether the person can skip it: everything but the AI provider. */
  optional: boolean;
};

/** Everything the dialog needs. */
export type OnboardingView = {
  slug: string;
  /** The workspace's name, for the dialog's title. */
  name: string;
  state: Onboarding;
  /** Its AI providers, as the AI page lists them; null when integrations did not answer. */
  connections: AiConnection[] | null;
  /** What Ask answers with. */
  ask: AskSetup | null;
  facts: OnboardingFacts;
  steps: OnboardingStepView[];
};

const TITLES: Record<OnboardingStep, { title: string; optional: boolean }> = {
  ai: { title: "Add an AI provider", optional: false },
  ask: { title: "Choose Ask's model", optional: true },
  code: { title: "Bring your code", optional: true },
  harness: { title: "Connect your harness", optional: true },
  people: { title: "Invite your team", optional: true },
  runner: { title: "Add a runner", optional: true },
};

/** The order the steps are shown in. Mirrors `ONBOARDING_STEPS` in the contracts. */
export const STEP_ORDER: OnboardingStep[] = ["ai", "ask", "code", "harness", "people", "runner"];

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Whether a step is done, and its line in the rail. */
function judge(key: OnboardingStep, facts: OnboardingFacts): { done: boolean; summary: string } {
  switch (key) {
    case "ai": {
      const providers = facts.providers;
      if (!providers) return { done: false, summary: "Couldn't check your providers" };
      if (providers.working > 0) return { done: true, summary: `${plural(providers.working, "provider")} working` };
      if (providers.total > 0) return { done: false, summary: "Added, but its check failed" };
      return { done: false, summary: "Your own key, for Ask and @g1t" };
    }
    case "ask":
      if (facts.askReady) return { done: true, summary: facts.askWith ?? "Ask is ready" };
      return { done: false, summary: "Which model answers Ask" };
    case "code": {
      const projects = facts.projects ?? 0;
      if (projects > 0) return { done: true, summary: plural(projects, "repository", "repositories") };
      if (facts.github?.connected) return { done: true, summary: "GitHub connected" };
      return { done: false, summary: "New, or from GitHub" };
    }
    case "harness":
      if (facts.cli && facts.harnessApp) return { done: true, summary: "CLI and AI client signed in" };
      if (facts.cli) return { done: true, summary: "g1t CLI signed in" };
      if (facts.harnessApp) return { done: true, summary: "AI client signed in" };
      return { done: false, summary: "Connect a coding agent or chat app" };
    case "people": {
      const people = facts.people;
      if (people && people.others > 0) return { done: true, summary: `${plural(people.others, "other member")}` };
      if (people && people.pending > 0) return { done: true, summary: `${plural(people.pending, "invitation")} sent` };
      return { done: false, summary: facts.invitesNeedPlan ? "Invites come with the plan" : "Work together in one place" };
    }
    case "runner":
      if ((facts.runners ?? 0) > 0) return { done: true, summary: plural(facts.runners ?? 0, "runner") };
      return { done: false, summary: "Run jobs on your own machine" };
  }
}

/** The steps, in order, each done or not from `facts` and skipped as the person chose. */
export function stepsFrom(facts: OnboardingFacts, state: Onboarding): OnboardingStepView[] {
  return STEP_ORDER.map((key) => {
    const { done, summary } = judge(key, facts);
    const { title, optional } = TITLES[key];
    return { key, title, summary, done, skipped: !done && optional && state.skipped.includes(key), optional };
  });
}

/** How far along: steps done or skipped, of all of them. */
export function progressOf(steps: OnboardingStepView[]): { settled: number; total: number; percent: number } {
  const settled = steps.filter((step) => step.done || step.skipped).length;
  return { settled, total: steps.length, percent: Math.round((settled / Math.max(1, steps.length)) * 100) };
}

/** Whether every step is done or skipped. */
export function finished(steps: OnboardingStepView[]): boolean {
  return steps.every((step) => step.done || step.skipped);
}

/** The step to open on: the first one left, else the first. */
export function firstOpenStep(steps: OnboardingStepView[]): OnboardingStep {
  return (steps.find((step) => !step.done && !step.skipped) ?? steps[0])?.key ?? "ai";
}

/**
 * Whether the guide opens by itself: for an owner who has not dismissed
 * it. A workspace that is all set still opens it once, to say so and be
 * finished; finishing dismisses it. `?setup` opens it whatever was chosen.
 */
export function opensByItself(view: Pick<OnboardingView, "state"> | null, asked: boolean): boolean {
  if (!view) return false;
  return asked || view.state.dismissed_at == null;
}

/** `skipped` with `step` skipped, or not, in the guide's order. */
export function withSkipped(skipped: OnboardingStep[], step: OnboardingStep, skip: boolean): OnboardingStep[] {
  const set = new Set(skipped);
  if (skip) set.add(step);
  else set.delete(step);
  return STEP_ORDER.filter((key) => set.has(key));
}

/** Where Getting started is opened from anywhere: the workspace's Home, asked to open it. */
export function setupPath(slug: string): string {
  return `/${slug}/-/home?setup=1`;
}
