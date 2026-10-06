/**
 * The steps that take a project to production, each worked out from what
 * the project has done, with where to do the ones it has not. Shown on the
 * project's overview to its members until they are all done or it is
 * dismissed.
 */

export type ChecklistFacts = {
  /** The project's address, `/<workspace>/<project>`. */
  base: string;
  /** Its default branch has a commit, or its source is a mirror. */
  hasCode: boolean;
  /** Deployments are switched on for it. */
  deploysEnabled: boolean;
  /** A production build has gone live, now or before. */
  productionDeployed: boolean;
  /** Custom domains it has; null when they could not be read. */
  domains: number | null;
  /** A preview has been built for a branch or pull request. */
  previewOpened: boolean;
  /** An AGENTS.md or CLAUDE.md at the root of its default branch; null when unknown. */
  instructions: boolean | null;
  /** g1t has been given an issue here. */
  agentAssigned: boolean;
};

export type ChecklistItem = {
  key: "code" | "deploy" | "domain" | "preview" | "instructions" | "agent";
  title: string;
  detail: string;
  done: boolean;
  to: string;
  action: string;
};

export function productionChecklist(facts: ChecklistFacts): ChecklistItem[] {
  const { base } = facts;
  return [
    {
      key: "code",
      title: "Connect a source or push code",
      detail: "Push an existing project, or have your coding agent start one.",
      done: facts.hasCode,
      to: `${base}/code`,
      action: "Push code",
    },
    {
      key: "deploy",
      title: "Deploy to production",
      detail: facts.deploysEnabled
        ? "Production builds from the default branch on every push."
        : "Deployments are off until you turn them on. Then production builds from the default branch on every push.",
      done: facts.productionDeployed,
      to: facts.deploysEnabled ? `${base}/deployments` : `${base}/settings/deployments`,
      action: facts.deploysEnabled ? "Deployments" : "Turn on",
    },
    {
      key: "domain",
      title: "Add a custom domain",
      detail: "Serve production from a domain of your own.",
      done: (facts.domains ?? 0) > 0,
      to: `${base}/settings/domains`,
      action: "Add",
    },
    {
      key: "preview",
      title: "Open a preview",
      detail: "Every pull request gets a live preview of its branch.",
      done: facts.previewOpened,
      to: `${base}/pulls/new`,
      action: "New pull request",
    },
    {
      key: "instructions",
      title: "Set up repository instructions",
      detail: "Commit an AGENTS.md with how to build and test; every agent run reads it.",
      done: facts.instructions === true,
      to: `${base}/agents#instructions`,
      action: "How",
    },
    {
      key: "agent",
      title: "Assign a first issue to g1t",
      detail: "It opens a pull request, makes the change and sees it through checks and review.",
      done: facts.agentAssigned,
      to: `${base}/issues/new`,
      action: "New issue",
    },
  ];
}

/** `3/6`, for the card's heading. */
export function progress(items: ChecklistItem[]): { done: number; total: number; complete: boolean } {
  const done = items.filter((item) => item.done).length;
  return { done, total: items.length, complete: done === items.length };
}

/** A repository's root lists instructions for agents. */
export function hasInstructions(names: string[]): boolean {
  return names.some((name) => /^(agents|claude)\.md$/i.test(name));
}

/** Whether g1t has worked here, from its runs, pull requests or issues. */
export function agentWasAssigned(input: {
  runAgents: string[];
  pullAgents: string[];
  issues: { assignees: string[]; agent: string | null }[];
}): boolean {
  const isAgent = (name: string | null) => name?.toLowerCase() === "g1t";
  return (
    input.runAgents.some(isAgent) ||
    input.pullAgents.some(isAgent) ||
    input.issues.some((issue) => isAgent(issue.agent) || issue.assignees.some(isAgent))
  );
}

// --- Dismissing it, per project, in this browser -----------------------------

type Store = Pick<Storage, "getItem" | "setItem">;

export function dismissKey(base: string): string {
  return `g1t:checklist-dismissed:${base.toLowerCase()}`;
}

export function isDismissed(storage: () => Store | null | undefined, base: string): boolean {
  try {
    return storage()?.getItem(dismissKey(base)) === "1";
  } catch {
    return false;
  }
}

export function dismiss(storage: () => Store | null | undefined, base: string): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(dismissKey(base), "1");
    return true;
  } catch {
    return false;
  }
}
