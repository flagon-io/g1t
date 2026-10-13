/**
 * The outbound handler's side of brokered secrets (broker.ts): `egress`
 * (guard.ts) asks `brokered` once for each request a workflow job that may
 * be given brokered secrets makes, before forwarding it itself.
 */
import type { OutboundHandlerContext } from "@cloudflare/containers";

import type { ServiceBinding } from "@g1t/contracts";

import { type BrokeredJob, brokerFor, fill, scrub, scrubHeaders, scrubbable, standInsIn } from "./broker.ts";
import { sandboxNamespace } from "./egress.ts";
import { forward } from "./forward.ts";

/**
 * What the outbound handler is given for brokering: the workflow job,
 * whose stand-ins it fills in.
 */
export type BrokeredParams = { job?: BrokeredJob };

/**
 * Sends a workflow job's request with its brokered secrets filled in: a
 * stand-in becomes the real value on a request to one of its secret's
 * hosts, and the answer has the value swapped back should it echo it.
 * Null when there is nothing to fill in, and `egress` forwards the
 * request as it is. A filled-in request is not followed through
 * redirects here, so the value never goes wherever a redirect points: the
 * job follows it itself, and that request comes through here again. A
 * stand-in sent to a host it is not for goes as it is, and the job's log
 * says so once.
 */
export async function brokered(
  request: Request,
  env: { SANDBOX: DurableObjectNamespace; ACTIONS?: ServiceBinding },
  ctx: OutboundHandlerContext<BrokeredParams>,
): Promise<Response | null> {
  const job = ctx.params?.job;
  if (!job || !env.ACTIONS) return null;
  const wanted = standInsIn(request.url, request.headers);
  if (wanted.length === 0) return null;
  const secrets = await brokerFor(env.ACTIONS, job, wanted);
  const { url, headers, filled, misdirected } = fill(request.url, request.headers, secrets);
  for (const secret of misdirected) {
    try {
      const namespace = sandboxNamespace(env, ctx.className);
      const sandbox = namespace.get(namespace.idFromString(ctx.containerId)) as unknown as {
        noteMisdirected(name: string, host: string): Promise<void>;
      };
      await sandbox.noteMisdirected(secret.name, new URL(request.url).host);
    } catch (error) {
      console.log("misdirected secret not reported", secret.name, String(error));
    }
  }
  if (filled.length === 0) return null;
  const response = await forward(new Request(url, { method: request.method, headers, body: request.body, redirect: "manual" }));
  const answered = scrubHeaders(response.headers, filled);
  const init = { status: response.status, statusText: response.statusText, headers: answered };
  if (!scrubbable(response.headers)) return new Response(response.body, init);
  answered.delete("content-length");
  return new Response(scrub(await response.text(), filled), init);
}
