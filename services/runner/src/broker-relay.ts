/**
 * Brokered secrets for a self-hosted runner's job. That job's traffic
 * never passes `egress`, and a brokered secret's value is never sent to a
 * computer g1t does not run, so the job's harness (crates/runner
 * actions/broker.rs) passes each of its requests to a brokered secret's
 * hosts that carries a stand-in to g1t, `POST /actions/jobs/{job}/broker`,
 * which the API hands here as it is (apps/api broker.rs). This fills the
 * stand-ins in as broker.ts does for g1t's own sandboxes, sends the
 * request without following redirects, and answers with what came back,
 * the values swapped back for their stand-ins in its headers and in any
 * text body, whatever its size.
 *
 * It is not a proxy for anything else: a request that carries none of
 * the job's stand-ins for its host, or is not HTTPS, is refused, and the
 * job's log says so once per secret (or host) and job. The request comes
 * with the job's current token, in `Authorization`, and only a running
 * self-hosted job's token opens its stand-ins (`relayed_secrets`).
 *
 * The request to make: `x-g1t-broker-request`, base64 of
 * `{ method, url, headers: [[name, value], …] }`, and the body. The
 * answer: status 200 with `x-g1t-broker-response`, base64 of
 * `{ status, headers }`, and the upstream body, decoded; or g1t's own
 * refusal, with another status, a JSON `error` and no such header.
 */

import type { BrokeredSecret, ServiceBinding } from "@g1t/contracts";

import { fill, misdirectedNote, newlyMisdirected, scrubHeaders, standInsIn } from "./broker.ts";
import { normalizeHost } from "./egress.ts";

export const REQUEST_HEADER = "x-g1t-broker-request";
export const ANSWER_HEADER = "x-g1t-broker-response";
/** The largest request body relayed: a package or a release asset upload. */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
/** The largest answer relayed. */
export const MAX_ANSWER_BYTES = 1024 * 1024 * 1024;
/** How long one relayed request may take, its answer's body included. */
export const TIME_LIMIT_MS = 10 * 60_000;
/** What may be relayed: no `CONNECT`, `TRACE` or anything unusual. */
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/**
 * Headers about one connection, not the request, which are not passed on
 * either way; `host` comes from the URL, and lengths are worked out again.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** The request a harness asked to have made. */
export type Relayed = { method: string; url: string; headers: [string, string][] };

/** The request in `x-g1t-broker-request`, or null when it is not one. */
export function readRelayed(header: string | null): Relayed | null {
  if (!header) return null;
  try {
    const bytes = Uint8Array.from(atob(header.trim()), (c) => c.charCodeAt(0));
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as Partial<Relayed>;
    if (typeof value.method !== "string" || typeof value.url !== "string" || !Array.isArray(value.headers)) return null;
    const headers = value.headers.filter(
      (pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string",
    );
    if (headers.length !== value.headers.length) return null;
    return { method: value.method.toUpperCase(), url: value.url, headers };
  } catch {
    return null;
  }
}

function encode(value: unknown): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A request's headers as they go on: the connection's own left out. */
export function passedHeaders(pairs: readonly [string, string][]): Headers {
  const headers = new Headers();
  for (const [name, value] of pairs) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.append(name, value);
  }
  return headers;
}

/** An answer's headers as a list, each `set-cookie` on its own. */
export function answerHeaders(headers: Headers): [string, string][] {
  const out: [string, string][] = [];
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    // The body is relayed decoded, so its encoding and length go too.
    if (HOP_BY_HOP.has(lower) || lower === "content-encoding" || lower === "set-cookie") return;
    out.push([name, value]);
  });
  const cookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const cookie of cookies) out.push(["set-cookie", cookie]);
  return out;
}

/** A body read whole, or null when it is longer than `limit`. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  return concat(parts);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** A stream that fails once more than `limit` bytes have passed. */
export function capped(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let passed = 0;
  return new TransformStream({
    transform(chunk, controller) {
      passed += chunk.byteLength;
      if (passed > limit) controller.error(new Error(`the answer is larger than ${limit} bytes`));
      else controller.enqueue(chunk);
    },
  });
}

type Pair = { from: Uint8Array; to: Uint8Array };

function matchesAt(buffer: Uint8Array, at: number, pattern: Uint8Array): boolean {
  if (at + pattern.length > buffer.length) return false;
  for (let i = 0; i < pattern.length; i++) if (buffer[at + i] !== pattern[i]) return false;
  return true;
}

/**
 * Swaps each pair's `from` for its `to` in `buffer`. Not `final`, the
 * last bytes that could still begin a value are kept back as `rest`, to
 * be read again with the next chunk, so a value split between two chunks
 * is found too.
 */
export function replaceBytes(buffer: Uint8Array, pairs: readonly Pair[], final: boolean): { out: Uint8Array; rest: Uint8Array } {
  const longest = pairs.reduce((most, pair) => Math.max(most, pair.from.length), 0);
  const stop = final ? buffer.length : buffer.length - longest + 1;
  const parts: Uint8Array[] = [];
  let start = 0;
  let i = 0;
  while (i < stop) {
    const pair = pairs.find((p) => p.from.length > 0 && buffer[i] === p.from[0] && matchesAt(buffer, i, p.from));
    if (pair) {
      parts.push(buffer.subarray(start, i), pair.to);
      i += pair.from.length;
      start = i;
    } else {
      i++;
    }
  }
  i = Math.max(i, start);
  parts.push(buffer.subarray(start, Math.min(i, buffer.length)));
  return { out: concat(parts), rest: buffer.slice(Math.min(i, buffer.length)) };
}

/** A stream with each filled-in value swapped back for its stand-in. */
export function scrubStream(filled: readonly BrokeredSecret[]): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const pairs: Pair[] = filled
    .filter((secret) => secret.value)
    .map((secret) => ({ from: encoder.encode(secret.value), to: encoder.encode(secret.standIn) }))
    .sort((a, b) => b.from.length - a.from.length);
  let rest: Uint8Array = new Uint8Array(0);
  return new TransformStream({
    transform(chunk, controller) {
      const swapped = replaceBytes(concat([rest, chunk]), pairs, false);
      rest = swapped.rest;
      if (swapped.out.byteLength) controller.enqueue(swapped.out);
    },
    flush(controller) {
      const swapped = replaceBytes(rest, pairs, true);
      if (swapped.out.byteLength) controller.enqueue(swapped.out);
    },
  });
}

/**
 * Whether an answer's body is scrubbed: text of any kind (JSON, XML, HTML,
 * forms), and one that does not say. Archives, images and other binary
 * bodies stream as they are.
 */
export function scrubbedType(headers: Headers): boolean {
  const type = (headers.get("content-type") ?? "").toLowerCase().trim();
  return type === "" || /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|[a-z0-9.+-]+\+(json|xml)))/.test(type);
}

/** What the relay needs from around it: the job's stand-ins, its log, and the internet. */
export type RelayDeps = {
  /** A running self-hosted job's stand-ins, or null when the token does not open it. */
  secrets(job: string, token: string): Promise<BrokeredSecret[] | null>;
  /** A line for the job's log. */
  note(job: string, token: string, text: string): Promise<void>;
  /** Sends a request upstream (forward.ts). */
  send(request: Request): Promise<Response>;
};

function refused(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** The line a job's log gets for a request that carried none of its stand-ins for its host. */
export function refusedNote(host: string): string {
  return `##[warning]A request to ${normalizeHost(host)} was passed to g1t's broker without a stand-in for that host, so g1t refused it.`;
}

/** What each job's log was told, in this isolate: each thing once. */
const NOTED = new Map<string, string[]>();
const NOTED_JOBS = 500;

async function noteOnce(deps: RelayDeps, job: string, token: string, name: string, host: string, text: string): Promise<void> {
  const noted = newlyMisdirected(NOTED.get(job) ?? [], name, host);
  if (!noted) return;
  if (NOTED.size >= NOTED_JOBS && !NOTED.has(job)) NOTED.delete(NOTED.keys().next().value as string);
  NOTED.set(job, noted.seen);
  try {
    await deps.note(job, token, text);
  } catch (error) {
    console.log("broker note not kept", job, String(error));
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: { message: string } };

/** The relay's needs, met by the actions service and `forward`. */
export function relayDeps(actions: ServiceBinding, send: (request: Request) => Promise<Response>): RelayDeps {
  const call = (method: string, body: unknown) =>
    actions.fetch(`https://actions/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    async secrets(job, token) {
      const response = await call("relayed_secrets", { job, token });
      if (!response.ok) throw new Error(`relayed_secrets answered ${response.status}`);
      const answer = (await response.json()) as Outcome<BrokeredSecret[]>;
      return answer.ok ? answer.value : null;
    },
    async note(job, token, text) {
      const response = await call("job_report", { job, token, report: { kind: "note", text } });
      if (!response.ok) throw new Error(`job_report answered ${response.status}`);
    },
    send,
  };
}

/** Relays one broker request (the module's comment). Never throws for what a job sent. */
export async function relay(request: Request, deps: RelayDeps): Promise<Response> {
  const job = request.headers.get("x-g1t-broker-job") ?? "";
  const token = /^bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!job || !token) return refused(401, "unauthenticated", "A job and its token are required.");
  const relayed = readRelayed(request.headers.get(REQUEST_HEADER));
  if (!relayed || !METHODS.has(relayed.method)) return refused(400, "invalid", "The request to relay does not read.");
  let target: URL;
  try {
    target = new URL(relayed.url);
  } catch {
    return refused(400, "invalid", "The request to relay has no URL.");
  }
  const secrets = await deps.secrets(job, token);
  if (!secrets) return refused(401, "unauthenticated", "That job is not running on a self-hosted runner, or the token is not its.");

  const headers = passedHeaders(relayed.headers);
  const carried = new Set(standInsIn(target.toString(), headers));
  const { url, headers: filledHeaders, filled, misdirected } = fill(target.toString(), headers, secrets);
  for (const secret of misdirected) {
    await noteOnce(deps, job, token, secret.name, target.host, misdirectedNote(secret.name, target.host));
  }
  if (filled.length === 0) {
    if (misdirected.length === 0) await noteOnce(deps, job, token, "", target.host, refusedNote(target.host));
    const why = carried.size === 0 ? "it carries none of this job's stand-ins" : "its stand-ins are not for this host, or it is not HTTPS";
    return refused(403, "forbidden", `g1t relays only a request with a brokered secret's stand-in, over HTTPS, to that secret's hosts: ${why}.`);
  }

  const body = relayed.method === "GET" || relayed.method === "HEAD" ? null : await readCapped(request.body, MAX_REQUEST_BYTES);
  if (body === null && relayed.method !== "GET" && relayed.method !== "HEAD") {
    return refused(413, "too_large", `A relayed request's body is ${MAX_REQUEST_BYTES / 1024 / 1024} MB at most.`);
  }
  const upstream = await deps.send(
    new Request(url, {
      method: relayed.method,
      headers: filledHeaders,
      body: body && body.byteLength > 0 ? body : null,
      redirect: "manual",
      signal: AbortSignal.timeout(TIME_LIMIT_MS),
    }),
  );
  const length = Number(upstream.headers.get("content-length") ?? NaN);
  if (Number.isFinite(length) && length > MAX_ANSWER_BYTES) {
    await upstream.body?.cancel().catch(() => undefined);
    return refused(502, "too_large", `The answer is larger than g1t relays (${MAX_ANSWER_BYTES / 1024 / 1024} MB).`);
  }
  const answer = encode({ status: upstream.status, headers: answerHeaders(scrubHeaders(upstream.headers, filled)) });
  let stream = upstream.body?.pipeThrough(capped(MAX_ANSWER_BYTES)) ?? null;
  if (stream && scrubbedType(upstream.headers)) stream = stream.pipeThrough(scrubStream(filled));
  return new Response(stream, {
    status: 200,
    headers: { [ANSWER_HEADER]: answer, "content-type": "application/octet-stream", "cache-control": "no-store" },
  });
}
