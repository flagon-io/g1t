/**
 * The steps that take a project to production, or for a library to its
 * first release, each worked out from what the project has done, with
 * where to do the ones it has not. Shown on the project's overview to its
 * members until they are all done or it is dismissed.
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
  key: "code" | "deploy" | "domain" | "preview" | "checks" | "release" | "production" | "where" | "links" | "instructions" | "agent";
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

export type ReleaseFacts = Pick<ChecklistFacts, "base" | "hasCode" | "instructions" | "agentAssigned"> & {
  /** It has a workflow, whose runs are its pull requests' checks; null when unknown. */
  hasWorkflow: boolean | null;
  /** A package its repository publishes has a version. */
  released: boolean;
  /** Where publishing a first version is explained: its package's page or its registry's guide. */
  releaseTo: string;
};

/**
 * The steps for a library or a tool, which ships as releases rather than
 * deploying: the same first and last steps as production, with checks and
 * a first version in between.
 */
export function releaseChecklist(facts: ReleaseFacts): ChecklistItem[] {
  const shared = productionChecklist({ ...facts, deploysEnabled: false, productionDeployed: false, domains: null, previewOpened: false });
  const step = (key: ChecklistItem["key"]) => shared.find((item) => item.key === key)!;
  return [
    step("code"),
    {
      key: "checks",
      title: "Add checks on pull requests",
      detail: "A workflow that builds and tests it. Its runs are every pull request's checks.",
      done: facts.hasWorkflow === true,
      to: `${facts.base}/actions`,
      action: "Add CI",
    },
    {
      key: "release",
      title: "Tag a release or publish a package",
      detail: "Publish a first version to the workspace's registry for others to install.",
      done: facts.released,
      to: facts.releaseTo,
      action: "How",
    },
    step("instructions"),
    step("agent"),
  ];
}

export type StartFacts = Pick<ChecklistFacts, "base" | "hasCode" | "instructions" | "agentAssigned"> & {
  /** It has a workflow, whose runs are its pull requests' checks; null when unknown. */
  hasWorkflow: boolean | null;
  /** Production's address, for an app deployed elsewhere. */
  productionUrl: string | null;
  /** Its homepage, docs or any other link is set. */
  hasLinks: boolean;
  /** Its docs address is set, or its homepage. */
  hasDocsLink: boolean;
};

/** Where a project's own settings are, for the steps that are done there. */
const settingsAt = (base: string, anchor: string) => `${base}/settings#${anchor}`;

/**
 * The steps for a project g1t does not deploy, by what it is. Every step
 * applies to it and each is done from its own fact: nothing about turning
 * on Deployments, domains or previews.
 *
 * - An app deployed elsewhere: its production address, then checks.
 * - An app nobody has said where it runs: saying so, then checks.
 * - Docs: where they are read.
 * - Anything else: its links.
 */
export function startChecklist(kind: "elsewhere" | "unknown" | "docs" | "other", facts: StartFacts): ChecklistItem[] {
  const shared = productionChecklist({ ...facts, deploysEnabled: false, productionDeployed: false, domains: null, previewOpened: false });
  const step = (key: ChecklistItem["key"]) => shared.find((item) => item.key === key)!;
  const checks: ChecklistItem = {
    key: "checks",
    title: "Add checks on pull requests",
    detail: "A workflow that builds and tests it. Its runs are every pull request's checks.",
    done: facts.hasWorkflow === true,
    to: `${facts.base}/actions`,
    action: "Add CI",
  };
  const middle: ChecklistItem[] =
    kind === "elsewhere"
      ? [
          {
            key: "production",
            title: "Add production's address",
            detail: "Where your own pipeline deploys it, so its overview links to production.",
            done: facts.productionUrl != null,
            to: settingsAt(facts.base, "kind"),
            action: "Add",
          },
          checks,
        ]
      : kind === "unknown"
        ? [
            {
              key: "where",
              title: "Say where it runs",
              detail: "Deployed on g1t, deployed elsewhere, or not deployed at all, such as a library.",
              done: false,
              to: settingsAt(facts.base, "kind"),
              action: "Choose",
            },
            checks,
          ]
        : kind === "docs"
          ? [
              {
                key: "links",
                title: "Add where its docs are read",
                detail: "A docs or homepage address, shown on its overview and wherever the project is listed.",
                done: facts.hasDocsLink,
                to: settingsAt(facts.base, "links"),
                action: "Add",
              },
            ]
          : [
              {
                key: "links",
                title: "Add its links",
                detail: "A homepage, docs, or any other address people go to for it.",
                done: facts.hasLinks,
                to: settingsAt(facts.base, "links"),
                action: "Add",
              },
            ];
  return [step("code"), ...middle, step("instructions"), step("agent")];
}

export type ChecklistPlan = "production" | "release" | "elsewhere" | "unknown" | "docs" | "other";

/**
 * Which steps a project gets, and their heading, from what it is and where
 * it runs. Only what g1t deploys gets production's steps.
 */
export function checklistPlan(project: {
  kind: "app" | "library" | "tool" | "docs" | "other";
  runs: "g1t" | "elsewhere" | null;
}): { plan: ChecklistPlan; title: string } {
  if (project.runs === "g1t") return { plan: "production", title: "Get to production" };
  if (project.kind === "library" || project.kind === "tool") return { plan: "release", title: "Ship a release" };
  if (project.kind === "app") return { plan: project.runs === "elsewhere" ? "elsewhere" : "unknown", title: "Get started" };
  return { plan: project.kind, title: "Get started" };
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
