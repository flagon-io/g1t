import { env } from "cloudflare:workers";

import {
  type RegistrationToken,
  type Runner,
  type RunnerGroup,
  type RunnerSettings,
  type RunnersOwner,
  type User,
  RUNNER_ACTIVITY_LIMIT,
  runnersClient,
} from "@g1t/contracts";

import { instrumented } from "./perf.server";
import { type CloudNow, type CloudPrice, type OwnWaiting, type RunnerCost, cloudNow, cloudPrices, ownWaiting, runnerCost } from "./runners";
import { agents, billing } from "./services.server";

/** Self-hosted runners, kept by the actions service. */
export const runners = runnersClient(instrumented("actions", env.ACTIONS));

export type RunnersData = {
  runners: Runner[];
  /** A workspace's groups; empty for a repository. */
  groups: RunnerGroup[];
  settings: RunnerSettings | null;
  /** The workspace's repositories, for choosing a group's. */
  repositories: string[];
  error: string | null;
};

export async function loadRunners(owner: RunnersOwner, actor: User, repositories: string[] = []): Promise<RunnersData> {
  const [list, groups, settings] = await Promise.all([
    runners.list(actor, owner),
    "workspace" in owner ? runners.groups(actor, owner.workspace) : Promise.resolve(null),
    runners.settings(actor, owner),
  ]);
  return {
    runners: list.ok ? list.value : [],
    groups: groups?.ok ? groups.value : [],
    settings: settings.ok ? settings.value : null,
    repositories,
    error: list.ok ? null : list.error.message,
  };
}

/** The workspace's Runners page: its runners, and g1t's cloud beside them. */
export type RunnersPageData = RunnersData & {
  /** What runs on g1t's cloud now; null when neither the work nor the actions service answered. */
  cloud: CloudNow | null;
  /** What waits for the workspace's own runners; null when the actions service did not answer. */
  waiting: OwnWaiting | null;
  /** This month's machine time; null when billing did not answer. */
  cost: RunnerCost | null;
  /** A minute on g1t's cloud, from the price book; null when it has none. */
  prices: CloudPrice[] | null;
  /** Agent runs at once on g1t's cloud the plan allows; null for no cap, or unknown. */
  agentCap: number | null;
};

/** Active agent runs read: the work service's most in one list. */
const RUN_PAGE = 200;

const warn = (what: string) => (error: unknown) => {
  console.warn(`runners: ${what} failed`, error);
  return null;
};

/**
 * Every read the workspace's Runners page makes, at once. The runners,
 * groups and settings come as on a project's page; what runs on g1t's
 * cloud, what waits, and this month's time each come from their own
 * service, and one that does not answer leaves only its part saying so.
 */
export async function loadRunnersPage(workspace: string, actor: User, repositories: string[] = [], now = new Date()): Promise<RunnersPageData> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const until = now.toISOString().slice(0, 10);
  const [base, activity, runs, report, book, entitlements] = await Promise.all([
    loadRunners({ workspace }, actor, repositories),
    runners
      .activity(actor, workspace)
      .then((result) => (result.ok ? result.value : null))
      .catch(warn("runner activity")),
    agents
      .listRuns(actor, { workspace, active: true, limit: RUN_PAGE })
      .then((result) => (result.ok ? result.value : null))
      .catch(warn("agent runs")),
    billing
      .usageReport(workspace, actor, { from, until })
      .then((result) => (result.ok ? result.value : null))
      .catch(warn("usage report")),
    billing.prices().catch(warn("prices")),
    billing.entitlements(workspace).catch(warn("entitlements")),
  ]);
  return {
    ...base,
    cloud: cloudNow(runs, activity, RUN_PAGE, RUNNER_ACTIVITY_LIMIT),
    waiting: ownWaiting(activity),
    cost: runnerCost(report),
    prices: cloudPrices(book?.prices ?? null),
    agentCap: entitlements && entitlements.maxConcurrentAgents > 0 ? entitlements.maxConcurrentAgents : null,
  };
}

export type RunnersAction = {
  error?: string;
  notice?: string;
  /** A registration token just made: shown once, in the install steps. */
  token?: RegistrationToken;
};

/** Every form on the Runners page. */
export async function actOnRunners(owner: RunnersOwner, actor: User, form: FormData): Promise<RunnersAction> {
  const intent = String(form.get("intent") ?? "");
  const workspace = "workspace" in owner ? owner.workspace : owner.repo.namespace.toLowerCase();
  const list = (name: string) =>
    String(form.get(name) ?? "")
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  switch (intent) {
    case "token": {
      const made = await runners.createToken(actor, owner, String(form.get("group") ?? "") || undefined);
      return made.ok ? { token: made.value } : { error: made.error.message };
    }
    case "remove": {
      const removed = await runners.remove(actor, owner, String(form.get("id") ?? ""));
      return removed.ok ? { notice: `Removed ${String(form.get("name") ?? "the runner")}.` } : { error: removed.error.message };
    }
    case "group": {
      const id = String(form.get("id") ?? "") || undefined;
      const repositories = form.get("reach") === "some" ? form.getAll("repository").map(String) : [];
      if (form.get("reach") === "some" && repositories.length === 0) return { error: "Choose at least one repository, or every repository." };
      const saved = await runners.setGroup(actor, workspace, {
        id,
        name: String(form.get("name") ?? "").trim() || undefined,
        repositories,
      });
      return saved.ok ? { notice: `Saved the group ${saved.value.name}.` } : { error: saved.error.message };
    }
    case "delete-group": {
      const deleted = await runners.deleteGroup(actor, workspace, String(form.get("id") ?? ""));
      return deleted.ok ? { notice: "Deleted the group; its runners joined the default group." } : { error: deleted.error.message };
    }
    case "settings": {
      const saved = await runners.setSettings(actor, owner, {
        agents_on_self_hosted: form.get("agents") === "on",
        agent_labels: list("agentLabels"),
        fork_pull_requests: form.get("forks") === "on",
      });
      return saved.ok ? { notice: "Saved." } : { error: saved.error.message };
    }
    case "inherit": {
      const saved = await runners.setSettings(actor, owner, { inherit: true });
      return saved.ok ? { notice: "This project follows the workspace's runner settings again." } : { error: saved.error.message };
    }
    default:
      return { error: "Nothing to do." };
  }
}
