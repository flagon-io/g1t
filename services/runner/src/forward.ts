/**
 * How the outbound handler sends a sandbox's request on to an allowed
 * host. An upstream that resets the connection or fails outright would
 * otherwise throw out of the handler, and the sandbox would see its own
 * connection reset, which tools such as npm count as a failure rather
 * than something to retry. So a request that can be sent again (a GET or
 * HEAD with no body) is tried twice more after a short wait, and what
 * still fails comes back as a `502` saying which host and why, which
 * those tools do retry. It never throws.
 */

import { normalizeHost } from "./egress.ts";

/** The waits before the second and third tries, in milliseconds. */
export const RETRY_WAITS_MS: readonly number[] = [250, 1000];

/** Whether a request can be sent again as it was: no body, nothing changed. */
export function replayable(request: Request): boolean {
  return (request.method === "GET" || request.method === "HEAD") && request.body === null;
}

/** What a request that could not be sent gets back. */
export function upstreamFailed(host: string, error: unknown): Response {
  const why = error instanceof Error ? error.message : String(error);
  return new Response(`g1t egress: ${normalizeHost(host)} could not be reached: ${why}\n`, {
    status: 502,
    headers: { "content-type": "text/plain; charset=utf-8", "x-g1t-egress": "upstream-failed" },
  });
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sends `request` with `send` (`fetch`), trying a replayable one again on
 * a thrown error, and answering `502` when it cannot. Each failure is one
 * line of the Worker's log.
 */
export async function forward(
  request: Request,
  send: (request: Request) => Promise<Response> = fetch,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<Response> {
  const host = new URL(request.url).host;
  const tries = replayable(request) ? RETRY_WAITS_MS.length + 1 : 1;
  let failure: unknown = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (attempt > 1) await sleep(RETRY_WAITS_MS[attempt - 2]);
    try {
      return await send(request);
    } catch (error) {
      failure = error;
      console.log("egress upstream failed", normalizeHost(host), request.method, `try ${attempt} of ${tries}`, String(error));
    }
  }
  return upstreamFailed(host, failure);
}
