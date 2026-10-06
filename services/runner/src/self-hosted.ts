/**
 * g1t's own work on a workspace's self-hosted runners. When a workspace (or
 * one of its repositories) says so under Settings, Runners, an agent's run,
 * checks, a review, a merge check or the merge queue is not started in a
 * sandbox here: the sandbox's Durable Object hands the same environment to
 * the actions service as a task, a runner of the workspace's with the
 * right labels takes it on its next poll, and the actions service tells
 * the Durable Object how it ended (`task_ended`), which then does exactly
 * what it does when a container stops. The model calls still go through
 * g1t's model proxy with the run's own credential, so spend, budgets and
 * the audit log work as they do in a sandbox. Network guardrails cannot be
 * enforced on someone else's machine, and the run says so.
 */

import type { RepoPath, ServiceBinding } from "@g1t/contracts";

/** The actions service's JSON protocol. */
async function call<T>(actions: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await actions.fetch(`https://actions/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
  return (await response.json()) as T;
}

/**
 * The labels g1t's own work in `repo` runs on, when it runs on the
 * workspace's runners; null for g1t's sandboxes. Never throws: when the
 * actions service cannot say, the work runs in a sandbox as before.
 */
export async function selfHostedRoute(actions: ServiceBinding, repo: RepoPath): Promise<string[] | null> {
  try {
    const labels = await call<string[] | null>(actions, "runner_route", { workspace: repo.namespace.toLowerCase(), repo });
    return Array.isArray(labels) && labels.length > 0 ? labels : null;
  } catch (error) {
    console.log("self-hosted route unknown; using a sandbox", repo.namespace, String(error));
    return null;
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: { message: string } };

/** Hands a sandbox's work to the workspace's runners. Returns the task's id. */
export async function enqueueTask(
  actions: ServiceBinding,
  task: {
    sandbox: string;
    repo: RepoPath;
    kind: string;
    title: string;
    labels: string[];
    env: Record<string, string>;
    timeoutMinutes: number;
  },
): Promise<string> {
  const queued = await call<Outcome<string>>(actions, "enqueue_task", { ...task, workspace: task.repo.namespace.toLowerCase() });
  if (!queued.ok) throw new Error(queued.error.message);
  return queued.value;
}

/** Withdraws a sandbox's task: a person stopped it, or its time ran out. Never throws. */
export async function cancelTask(actions: ServiceBinding, sandbox: string, reason: string | null): Promise<void> {
  await call(actions, "cancel_task", { sandbox, reason }).catch((error: unknown) =>
    console.log("self-hosted task not cancelled", sandbox, String(error)),
  );
}

/**
 * The environment a self-hosted runner gets: what the sandbox would have
 * been started with, less what only makes sense in g1t's sandbox (the
 * egress certificate and proxy), with the mining watch off, since the
 * machine and its electricity are the workspace's.
 */
export function taskEnv(vars: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (/^(HTTPS?_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|G1T_EGRESS_CA)$/i.test(name)) continue;
    env[name] = value;
  }
  env.G1T_ABUSE = "off";
  env.G1T_SELF_HOSTED = "1";
  return env;
}

/** What the run's session says when it goes to the workspace's runners. */
export function handedOverStep(labels: string[]): string {
  return `Handed to a self-hosted runner with labels ${labels.join(", ")}. g1t's network guardrails are not enforced on your own machines.`;
}

/** Where the work is: the tracked repository, else the meter's `owner/name`. */
export function taskRepo(track: { repo: RepoPath } | undefined, meter: { repo: string } | undefined, owner: { repo: string | null } | undefined): RepoPath | null {
  if (track) return track.repo;
  const full = meter?.repo ?? owner?.repo ?? null;
  if (!full) return null;
  const [namespace, name] = full.split("/");
  return namespace && name ? { namespace, name } : null;
}
