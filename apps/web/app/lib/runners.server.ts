import { env } from "cloudflare:workers";

import {
  type RegistrationToken,
  type Runner,
  type RunnerGroup,
  type RunnerSettings,
  type RunnersOwner,
  type User,
  runnersClient,
} from "@g1t/contracts";

import { instrumented } from "./perf.server";

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
