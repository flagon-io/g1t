/**
 * How the outbound handler sends a sandbox's request on, for a workflow
 * job whose requests pass the Worker, and how a self-hosted job's brokered
 * request is relayed. An upstream that resets the connection or fails outright would
 * otherwise throw out of the handler, and the sandbox would see its own
 * connection reset, which tools such as npm count as a failure rather
 * than something to retry. So a request that can be sent again (a GET or
 * HEAD with no body) is tried twice more after a short wait, and what
 * still fails comes back as a `502` saying which host and why, which
 * those tools do retry. It never throws.
 *
 * An upstream can also break off in the middle of a body, after its
 * headers have been handed on: npm then fails with `ECONNRESET` and
 * `network aborted`, and never retries it. So an answer of known, modest
 * size to such a request is read whole before it is handed on, and tried
 * again when it breaks off (`BUFFERED_MAX_BYTES`). A larger one, such as a
 * 50 MB package tarball, streams as it comes, and when it breaks off the
 * rest is asked for with a `Range` request from where it stopped and
 * joined on, so the sandbox sees one unbroken answer (`resuming`).
 */

import { normalizeHost } from "./egress.ts";

/** The waits before the second and third tries, in milliseconds; also before each resumption of a body. */
export const RETRY_WAITS_MS: readonly number[] = [250, 1000];

/**
 * The largest answer to a replayable request that is read whole before the
 * sandbox is answered. An answer read whole first is tried again like any
 * other failure. Package tarballs and most API answers are well under this;
 * larger ones stream, and resume when they break off (`resuming`).
 */
export const BUFFERED_MAX_BYTES = 8 * 1024 * 1024;

/** The `content-length` of an answer sent as it is (no `content-encoding`), or null. */
function plainLength(response: Response): number | null {
  const encoding = (response.headers.get("content-encoding") ?? "identity").toLowerCase();
  if (encoding !== "identity") return null;
  const header = response.headers.get("content-length");
  const length = header === null ? NaN : Number(header);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

/** Whether an answer is to be read whole: a known length within the limit, sent as it is. */
export function bufferable(response: Response): boolean {
  if (response.body === null) return false;
  const length = plainLength(response);
  return length !== null && length <= BUFFERED_MAX_BYTES;
}

/** An answer whose body is read whole; throws when the body breaks off. */
async function whole(response: Response): Promise<Response> {
  const body = await response.arrayBuffer();
  const expected = Number(response.headers.get("content-length"));
  if (body.byteLength !== expected) throw new Error(`the answer broke off after ${body.byteLength} of ${expected} bytes`);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Whether a request can be sent again as it was: no body, nothing changed. */
export function replayable(request: Request): boolean {
  return (request.method === "GET" || request.method === "HEAD") && request.body === null;
}

/**
 * What a broken-off body can be resumed against: the validator that makes
 * sure the rest comes from the same file (a strong `ETag`, else
 * `Last-Modified`), and its whole length. Null when it cannot be: only a
 * whole `200` to a GET that asked for no range, of known length, sent as it
 * is, from a host that takes byte ranges.
 */
export function resumeFrom(request: Request, response: Response): { validator: string; length: number } | null {
  if (request.method !== "GET" || request.headers.has("range") || response.status !== 200 || response.body === null) return null;
  if (
    !(response.headers.get("accept-ranges") ?? "")
      .toLowerCase()
      .split(/[,\s]+/)
      .includes("bytes")
  )
    return null;
  const length = plainLength(response);
  if (length === null || length === 0) return null;
  const etag = response.headers.get("etag");
  const validator = etag && !etag.startsWith("W/") ? etag : response.headers.get("last-modified");
  return validator ? { validator, length } : null;
}

/** Whether a `206` carries exactly the rest of the file from `offset`. */
function restFrom(response: Response, offset: number, length: number): boolean {
  // The rest is joined on byte for byte, so it must come as it is, like the start did.
  const encoding = (response.headers.get("content-encoding") ?? "identity").toLowerCase();
  if (response.status !== 206 || response.body === null || encoding !== "identity") return false;
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec((response.headers.get("content-range") ?? "").trim());
  return range !== null && Number(range[1]) === offset && Number(range[2]) === length - 1 && Number(range[3]) === length;
}

/**
 * `response`'s body, joined across breaks: when it breaks off (an error, or
 * an end short of its length), the rest is asked for with
 * `Range: bytes=<received>-` and `If-Range`, after the waits of
 * `RETRY_WAITS_MS`, and read on from there. When the rest cannot be had
 * (no `206` for exactly that range, or every try failed), the body errors
 * as it would have. Each break is one line of the Worker's log.
 */
export function resuming(
  request: Request,
  response: Response,
  from: { validator: string; length: number },
  send: (request: Request) => Promise<Response>,
  sleep: (ms: number) => Promise<void>,
): Response {
  const host = normalizeHost(new URL(request.url).host);
  const { validator, length } = from;
  let reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let received = 0;
  let resumes = 0;

  /** A reader for the rest from `received`, or the reason there is none. */
  const reopen = async (broke: unknown): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
    let failure = broke;
    while (resumes < RETRY_WAITS_MS.length) {
      const wait = RETRY_WAITS_MS[resumes++];
      console.log("egress body broke off", host, `${received} of ${length} bytes`, `resuming, try ${resumes} of ${RETRY_WAITS_MS.length}`, String(failure));
      await sleep(wait);
      const headers = new Headers(request.headers);
      headers.set("range", `bytes=${received}-`);
      headers.set("if-range", validator);
      let rest: Response;
      try {
        rest = await send(new Request(request.url, { method: "GET", headers, redirect: request.redirect }));
      } catch (error) {
        failure = error;
        continue;
      }
      if (restFrom(rest, received, length)) return (rest.body as ReadableStream<Uint8Array>).getReader();
      await rest.body?.cancel().catch(() => {});
      // The file changed, or the host would not send that range: there is no rest to join on.
      const why = `the rest could not be had (${rest.status} ${rest.headers.get("content-range") ?? "without a range"})`;
      console.log("egress body not resumed", host, `${received} of ${length} bytes`, why);
      throw new Error(`the answer broke off after ${received} of ${length} bytes, and ${why}`);
    }
    console.log("egress body not resumed", host, `${received} of ${length} bytes`, String(failure));
    throw failure instanceof Error ? failure : new Error(String(failure));
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
          if (chunk.done && received < length) throw new Error(`the answer ended after ${received} of ${length} bytes`);
        } catch (error) {
          try {
            reader = await reopen(error);
          } catch (final) {
            controller.error(final);
            return;
          }
          continue;
        }
        if (chunk.done) {
          controller.close();
          return;
        }
        if (received + chunk.value.byteLength > length) {
          controller.error(new Error(`the answer ran past its ${length} bytes`));
          return;
        }
        received += chunk.value.byteLength;
        controller.enqueue(chunk.value);
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  // In the Worker, a stream of fixed length keeps the answer's
  // `content-length`, so the sandbox can tell a whole answer from a short one.
  const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  const sent = Fixed ? body.pipeThrough(new Fixed(length)) : body;
  return new Response(sent, { status: response.status, statusText: response.statusText, headers: response.headers });
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
      const response = await send(request);
      if (tries === 1) return response;
      // Read whole first when it can be sent again, so a body that breaks off is retried too.
      if (bufferable(response)) return await whole(response);
      // Too large to hold: streamed, and resumed where it breaks off.
      const from = resumeFrom(request, response);
      return from ? resuming(request, response, from, send, sleep) : response;
    } catch (error) {
      failure = error;
      console.log("egress upstream failed", normalizeHost(host), request.method, `try ${attempt} of ${tries}`, String(error));
    }
  }
  return upstreamFailed(host, failure);
}
