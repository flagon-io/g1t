/**
 * Putting an agent on something in one step, from a form: the issue new
 * page with "Assign g1t-agent now", and Mission control's composer. Pure,
 * so it is tested on its own; the routes call `env.RUNNER.delegate`.
 */
import type { AgentStart, DelegateInput, RepoPath } from "@g1t/contracts";

/** What a form asks for, read the way both forms name their fields. */
export function delegateForm(form: FormData): DelegateInput {
  const text = (name: string) => String(form.get(name) ?? "");
  return {
    title: text("title").trim(),
    body: text("body").trim(),
    labels: [...form.getAll("label").map(String), ...text("labels").split(",")].map((label) => label.trim()).filter(Boolean),
  };
}

/** The project a composer chose, written `owner/name`, if it is one of `repos`. */
export function chosenRepo(value: FormDataEntryValue | null, repos: RepoPath[]): RepoPath | null {
  const [namespace, name, extra] = String(value ?? "").split("/");
  if (!namespace || !name || extra != null) return null;
  return repos.find((repo) => repo.namespace.toLowerCase() === namespace.toLowerCase() && repo.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/** Where to land once the issue is open: on it, while the agent works or waits. */
export function issuePath(repo: RepoPath, number: number): string {
  return `/${repo.namespace}/${repo.name}/issues/${number}`;
}

/** What a form says when the issue was opened but the agent did not start. */
export type NotStarted = {
  /** The issue that was opened. */
  to: string;
  number: number;
  message: string;
  fix: { label: string; to: string } | null;
};

const FIX_LABEL: Record<string, string> = {
  not_paid: "Start the plan or the trial",
  trial_used: "Start the plan",
  limit: "Raise the limit",
  issue_cap: "Raise the cap per issue",
  no_model: "Connect a model",
};

/**
 * The agent's start, for a form: null when it started or is queued, so the
 * form goes on to the issue; otherwise what to say and where to fix it.
 */
export function notStarted(agent: AgentStart, repo: RepoPath, number: number): NotStarted | null {
  if (agent.status !== "not_started") return null;
  // The fix is on g1t.sh itself: followed within the site.
  const fixTo = agent.fixUrl?.replace(/^https:\/\/g1t\.sh(?=\/)/, "") ?? null;
  return {
    to: issuePath(repo, number),
    number,
    // The fix is offered as a link of its own, so the address the message ends with is left off.
    message: fixTo
      ? (agent.message ?? "g1t-agent did not start.").replace(/:\s*(?:https:\/\/g1t\.sh)?\/[\w./#-]+\s*$/, ".")
      : (agent.message ?? "g1t-agent did not start."),
    fix: fixTo ? { label: FIX_LABEL[agent.code ?? ""] ?? "Fix it", to: fixTo } : null,
  };
}
