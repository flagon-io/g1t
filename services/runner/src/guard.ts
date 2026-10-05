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

import { type ModelHosts, type RunGuard, allows, refusal, sandboxHosts } from "./egress";

export { harnessEnv, newlyBlocked, timeCapMessage } from "./egress";
export type { RunGuard } from "./egress";

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
  if (allows(ctx.params?.hosts ?? [], host)) return fetch(request);
  try {
    const sandbox = env.SANDBOX.get(env.SANDBOX.idFromString(ctx.containerId)) as unknown as {
      noteBlocked(host: string): Promise<void>;
    };
    await sandbox.noteBlocked(host);
  } catch (error) {
    console.log("blocked host not reported", host, String(error));
  }
  return refusal(host);
}

/** Adds a step to a run, with its token. Never fails the caller. */
export async function reportRun(
  work: ServiceBinding,
  tracked: { runId: string; token: string },
  report: { steps?: string[]; halt?: "budget" | "time"; error?: string },
): Promise<void> {
  await work
    .fetch("https://service/rpc/report_run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: tracked.runId, token: tracked.token, ...report }),
    })
    .catch((error: unknown) => console.log("run report failed", tracked.runId, String(error)));
}

