/**
 * Guardrails, as the runner applies them to a sandbox: what it may reach,
 * what its harness refuses, and how long and how much a run may take.
 *
 * - The network list is enforced here, outside the sandbox: a guarded
 *   sandbox starts with no internet, and every HTTP(S) request it makes
 *   comes to `egress` below, which forwards it or refuses it.
 * - Command rules and the cost cap are handed to the harness inside the
 *   sandbox as `GUARDRAILS`, which applies them to the agent.
 * - The time cap is enforced twice: by the harness, and by the sandbox's
 *   own alarm here, which stops the whole sandbox a little after.
 */
import type { OutboundHandlerContext } from "@cloudflare/containers";

import { type RepoPath, type RunKind, type ServiceBinding, guardrailsClient } from "@g1t/contracts";

import {
  ABUSE_HOST,
  type ModelHosts,
  type RunGuard,
  type WorkflowJob,
  allows,
  buildHosts,
  jobHosts,
  refusal,
  sandboxHosts,
  sandboxNamespace,
} from "./egress";

export {
  ABUSE_EXIT_CODE,
  ABUSE_HOST,
  ABUSE_MESSAGE,
  SANDBOX_BINDINGS,
  dockerFor,
  harnessEnv,
  jobHosts,
  newlyBlocked,
  sandboxNamespace,
  timeCapMessage,
  withPlanLimits,
} from "./egress";
export type { PlanLimits, RunGuard, WorkflowJob } from "./egress";

/** What the outbound handler is given: the hosts this sandbox may reach. */
export type EgressParams = { hosts: string[] };


/** The stop by the sandbox's alarm comes this long after the harness's own. */
export const ALARM_GRACE_SECONDS = 3 * 60;

/**
 * The guardrails of a run in `repo`. Throws when they cannot be read: a
 * sandbox is not started without them.
 */
export async function guardFor(work: ServiceBinding, repo: RepoPath, kind: RunKind): Promise<RunGuard> {
  const found = await guardrailsClient(work).runGuardrails(repo);
  if (!found.ok) throw new Error(`g1t could not read this project's guardrails: ${found.error.message}`);
  const policy = found.value;
  return { policy, minutes: policy.minutes[kind] ?? 60 };
}

/**
 * The guardrails of a workflow job, deploy build or security update in
 * `repo`: its project's network list, plus what builds need (`buildHosts`), and the
 * time cap it was given. `repo` is the project, not a pull request's
 * working copy; `repoId`, when known, finds it however it has moved.
 * A workflow job of a trusted run also gets the workflow-only domains
 * that name its workflow and environment (`jobHosts`); nothing else
 * ever does. Throws when they cannot be read: no build starts without them.
 */
export async function buildGuardFor(
  work: ServiceBinding,
  repo: RepoPath,
  kind: "actions" | "deploy" | "bump",
  minutes: number,
  repoId?: string | null,
  job?: WorkflowJob | null,
  extra: readonly string[] = [],
): Promise<RunGuard> {
  const found = await guardrailsClient(work).runGuardrails(repo, repoId);
  if (!found.ok) throw new Error(`g1t could not read this project's guardrails: ${found.error.message}`);
  const policy = found.value;
  const hosts = [...policy.hosts, ...buildHosts(kind), ...jobHosts(policy, kind, job), ...extra];
  return { policy: { ...policy, hosts: [...new Set(hosts)] }, minutes };
}


/** Every host the sandbox may reach, for the outbound handler. */
export function egressHosts(guard: RunGuard, env: ModelHosts, sandboxEnv: Record<string, string>): string[] {
  return sandboxHosts(guard.policy.hosts, env, sandboxEnv);
}

/**
 * The outbound handler of a guarded sandbox: every HTTP and HTTPS request
 * it makes. An allowed host is fetched as asked; any other is refused, and
 * the sandbox told so it can say so on the run.
 */
export async function egress(
  request: Request,
  env: { SANDBOX: DurableObjectNamespace },
  ctx: OutboundHandlerContext<EgressParams>,
): Promise<Response> {
  const host = new URL(request.url).host;
  // A sandbox reporting that it stopped itself for mining.
  if (host === ABUSE_HOST) return abuse(request, env, ctx);
  if (allows(ctx.params?.hosts ?? [], host)) return fetch(request);
  try {
    const namespace = sandboxNamespace(env, ctx.className);
    const sandbox = namespace.get(namespace.idFromString(ctx.containerId)) as unknown as {
      noteBlocked(host: string): Promise<void>;
    };
    await sandbox.noteBlocked(host);
  } catch (error) {
    console.log("blocked host not reported", host, String(error));
  }
  return refusal(host);
}

/**
 * A sandbox's report that it stopped itself for mining (crates/runner
 * abuse.rs), handed to its Durable Object. Reached through `egress` for a
 * guarded sandbox and as the handler for `ABUSE_HOST` for any other.
 */
export async function abuse(
  request: Request,
  env: { SANDBOX: DurableObjectNamespace },
  ctx: OutboundHandlerContext<unknown>,
): Promise<Response> {
  let verdict: unknown = null;
  try {
    verdict = ((await request.json()) as { verdict?: unknown }).verdict ?? null;
  } catch {
    // A report without its metrics still stops the run.
  }
  try {
    const namespace = sandboxNamespace(env, ctx.className);
    const sandbox = namespace.get(namespace.idFromString(ctx.containerId)) as unknown as {
      flagAbuse(verdict: unknown): Promise<void>;
    };
    await sandbox.flagAbuse(verdict);
  } catch (error) {
    console.log("abuse report not handled", String(error));
  }
  return new Response("noted\n");
}

/** Adds a step to a run, with its token. Never fails the caller. */
export async function reportRun(
  work: ServiceBinding,
  tracked: { runId: string; token: string },
  report: { steps?: string[]; halt?: "budget" | "time" | "abuse"; error?: string },
): Promise<void> {
  await work
    .fetch("https://service/rpc/report_run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: tracked.runId, token: tracked.token, ...report }),
    })
    .catch((error: unknown) => console.log("run report failed", tracked.runId, String(error)));
}

