/**
 * Putting an agent on something in one step (`RunnerService.delegate`):
 * what is said about the agent once its issue is open, whatever became of
 * it. Pure, so it is tested on its own.
 */
import type { AgentStart, Delegated, Issue, Pull } from "@g1t/contracts";

const SITE = "https://g1t.sh";

/** What the workspace's agents have no model is said as. */
export function noModelMessage(workspace: string): string {
  return `The ${workspace} workspace has no model for its agents: its free allowance on g1t's models is used up or over. An owner can connect the workspace's own model provider under Integrations, and its agents start at once.`;
}

/**
 * Where the fix for a refusal is: the workspace's billing page (its limit
 * and per-issue caps have anchors there), its model settings, or support,
 * which has no page to fix it on.
 */
export function fixUrlFor(code: string, workspace: string): string | null {
  const slug = workspace.toLowerCase();
  switch (code) {
    case "not_paid":
    case "trial_used":
    case "oss_pool_empty":
      return `${SITE}/${slug}/-/billing`;
    case "limit":
      return `${SITE}/${slug}/-/billing#limit`;
    case "issue_cap":
      return `${SITE}/${slug}/-/billing#caps`;
    case "no_model":
      return `${SITE}/${slug}/-/integrations`;
    default:
      return null;
  }
}

/** The agent at work on `pull`. */
export function started(issue: Issue, pull: Pull): Delegated {
  return { issue, pull, agent: { status: "started", code: null, message: null, fixUrl: null } };
}

/** Every agent slot is busy: it starts by itself when one frees up. */
export function queued(issue: Issue, message: string): Delegated {
  return { issue, pull: null, agent: { status: "queued", code: "waiting", message, fixUrl: null } };
}

/** It did not start: why, and where to fix it. */
export function notStarted(issue: Issue, code: string, message: string, workspace: string): Delegated {
  const agent: AgentStart = { status: "not_started", code, message, fixUrl: fixUrlFor(code, workspace) };
  return { issue, pull: null, agent };
}

/** The issue's title and body, tidied, and the checks with blank ones left out. */
export function delegateInput(input: { title?: unknown; body?: unknown; checks?: unknown; labels?: unknown }): {
  title: string;
  body: string;
  checks: string[];
  labels: string[];
} {
  const list = (value: unknown) =>
    (Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : [])
      .map((item) => String(item).trim())
      .filter(Boolean);
  return {
    title: typeof input.title === "string" ? input.title.trim() : "",
    body: typeof input.body === "string" ? input.body.trim() : "",
    checks: list(input.checks),
    labels: list(input.labels),
  };
}
