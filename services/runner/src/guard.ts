/**
 * Guardrails, as the runner applies them to a sandbox: how long a run may
 * take, and the outbound handlers its requests may pass.
 *
 * - The time cap is enforced twice: by the harness, and by the sandbox's
 *   own alarm here, which stops the whole sandbox a little after.
 * - Every sandbox reaches the internet directly. A workflow job that may
 *   be given brokered secrets sends its HTTP and HTTPS through `egress`
 *   below, which fills them in and sends everything on, to any host.
 * - A sandbox's report that it stopped itself for mining comes to `abuse`.
 * - A workflow job's HTTPS to g1t.sh comes to `git` (or `egress`), which
 *   hands its fetches to the repos service over its binding
 *   (internal-git.ts) and sends the rest on.
 */
import type { OutboundHandlerContext } from "@cloudflare/containers";

import { type RepoPath, type RunKind, type ServiceBinding, guardrailsClient } from "@g1t/contracts";

import { ABUSE_HOST, type RunGuard, sandboxNamespace } from "./egress";
import { standInsIn } from "./broker.ts";
import { type BrokeredParams, brokered } from "./broker-egress.ts";
import { forward } from "./forward.ts";
import { isGitHost, viaRepos } from "./internal-git.ts";

export {
  ABUSE_EXIT_CODE,
  ABUSE_HOST,
  ABUSE_MESSAGE,
  SANDBOX_BINDINGS,
  dockerFor,
  harnessEnv,
  sandboxNamespace,
  throughWorker,
  timeCapMessage,
  withPlanLimits,
} from "./egress";
export type { PlanLimits, RunGuard } from "./egress";

/** What the outbound handler is given: what brokered secrets need (broker-egress.ts). */
export type EgressParams = BrokeredParams;

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
 * The guardrails of a workflow job, deploy build or update: the time cap it
 * was given, which is all a build's guardrails are.
 */
export function buildGuard(minutes: number): RunGuard {
  return { policy: { minutes: {} }, minutes };
}

/**
 * The outbound handler of a sandbox whose HTTP and HTTPS pass the Worker
 * (a workflow job that may be given brokered secrets): every request it
 * makes, to any host. Its brokered secrets are filled in first, if it has
 * any, and the request is sent on with `forward`'s retries. Its fetches
 * from g1t.sh go to the repos service, as `git` sends them, unless they
 * carry a stand-in to fill in.
 */
export async function egress(
  request: Request,
  env: { SANDBOX: DurableObjectNamespace; ACTIONS?: ServiceBinding; REPOS?: object },
  ctx: OutboundHandlerContext<EgressParams>,
): Promise<Response> {
  const host = new URL(request.url).host;
  // A sandbox reporting that it stopped itself for mining.
  if (host === ABUSE_HOST) return abuse(request, env, ctx);
  const onward = async (sent: Request) => (await brokered(sent, env, ctx)) ?? forward(sent);
  if (isGitHost(host) && standInsIn(request.url, request.headers).length === 0) return viaRepos(request, env, onward);
  return onward(request);
}

/**
 * The outbound handler for g1t.sh on a workflow job whose other requests
 * go straight out: its fetches go to the repos service; the rest, and a
 * fetch the repos service could not answer, go straight out as they would
 * have without this handler (the containers library's own `fetch`).
 */
export async function git(request: Request, env: { REPOS?: object }): Promise<Response> {
  return viaRepos(request, env, (sent) => fetch(sent));
}

/**
 * A sandbox's report that it stopped itself for mining (crates/runner
 * abuse.rs), handed to its Durable Object. The handler for `ABUSE_HOST`
 * on every sandbox, and reached through `egress` for one whose requests
 * pass the Worker.
 */
export async function abuse(request: Request, env: { SANDBOX: DurableObjectNamespace }, ctx: OutboundHandlerContext<unknown>): Promise<Response> {
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
