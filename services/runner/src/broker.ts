/**
 * Brokered secrets, as the runner Worker fills them in. A workflow job is
 * given a stand-in (`g1tsec_…`) in place of a brokered secret's value
 * (services/actions broker.rs), and every HTTP and HTTPS request its
 * sandbox makes passes through `egress` (guard.ts). There, a request to one
 * of the secret's hosts has the stand-in replaced by the value; a request
 * anywhere else goes as it is, stand-in and all, which is useless to
 * whoever receives it, and the job's log says so once.
 *
 * Where a stand-in is filled in: every request header, as it is, and
 * inside `Authorization: Basic` (decoded, swapped, encoded again), and the
 * URL's query string. Never the path or the body. An answer that echoes the
 * value back has it swapped for the stand-in again in its headers, and in
 * its body when that is small, plain text.
 *
 * Pure, so it can be tested on its own, but for `brokerFor`, which asks
 * the actions service and keeps the answer a minute per job.
 */

import type { BrokeredSecret, ServiceBinding } from "@g1t/contracts";

import { allows, normalizeHost } from "./egress.ts";

export type { BrokeredSecret };

/**
 * A stand-in, wherever it is: `STAND_IN_PREFIX` (the actions contracts)
 * and 48 hex characters.
 */
const STAND_IN = /g1tsec_[0-9a-f]{48}/g;

/** The job a sandbox runs, for the outbound handler: who to ask for stand-ins. */
export type BrokeredJob = { id: string; token: string };

/** Base64 to text, or null when it is not base64 of UTF-8. */
function fromBase64(text: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A header's value as a stand-in may sit in it: Basic credentials decoded. */
function readable(value: string): string {
  const basic = /^basic\s+(.+)$/i.exec(value.trim());
  return (basic && fromBase64(basic[1])) || value;
}

/** The stand-ins in a request: in its URL, its headers, or its Basic credentials. */
export function standInsIn(url: string, headers: Headers): string[] {
  const found = new Set<string>();
  const look = (text: string) => {
    for (const match of text.matchAll(STAND_IN)) found.add(match[0]);
  };
  look(url);
  headers.forEach((value) => look(readable(value)));
  return [...found];
}

/** What filling in a request came to. */
export type Filled = {
  url: string;
  headers: Headers;
  /** The secrets filled in, whose values are kept out of the answer. */
  filled: BrokeredSecret[];
  /** The secrets whose stand-ins went to a host they are not for, left as they were. */
  misdirected: BrokeredSecret[];
};

function swap(text: string, secrets: readonly BrokeredSecret[], encode: (value: string) => string = (v) => v): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret.standIn).join(encode(secret.value));
  return out;
}

/**
 * Fills in the stand-ins of `secrets` that a request to `url` carries, for
 * those whose hosts include its host. A stand-in the job was not given is
 * left alone; one for another host is left as it is and reported.
 */
export function fill(url: string, headers: Headers, secrets: readonly BrokeredSecret[]): Filled {
  const present = new Set(standInsIn(url, headers));
  const carried = secrets.filter((secret) => present.has(secret.standIn));
  const parsed = new URL(url);
  const host = normalizeHost(parsed.host);
  // Only over HTTPS: a value filled into plain HTTP would cross the
  // internet readable by anyone on the way, its host or not. Such a
  // request goes with the stand-in, and is reported as misdirected.
  const secure = parsed.protocol === "https:";
  const filled = carried.filter((secret) => secure && allows(secret.hosts, host));
  const misdirected = carried.filter((secret) => !filled.includes(secret));
  if (filled.length === 0) return { url, headers, filled, misdirected };

  const out = new Headers();
  headers.forEach((value, name) => {
    const basic = /^(basic\s+)(.+)$/i.exec(value.trim());
    const decoded = basic ? fromBase64(basic[2]) : null;
    if (basic && decoded != null && filled.some((secret) => decoded.includes(secret.standIn))) {
      out.append(name, `${basic[1]}${toBase64(swap(decoded, filled))}`);
    } else {
      out.append(name, swap(value, filled));
    }
  });
  // Only the query string: a value in a path is rare, and is left as the
  // job wrote it.
  if (parsed.search) parsed.search = swap(parsed.search, filled, encodeURIComponent);
  return { url: parsed.toString(), headers: out, filled, misdirected };
}

/** The largest answer whose body is searched for an echoed value. */
export const MAX_SCRUBBED_BYTES = 256 * 1024;

/** Whether an answer's body is small, plain text the Worker may rewrite. */
export function scrubbable(headers: Headers): boolean {
  const type = (headers.get("content-type") ?? "").toLowerCase();
  const textual = /^(text\/|application\/(json|xml|x-www-form-urlencoded|[a-z0-9.+-]+\+(json|xml)))/.test(type);
  const encoding = (headers.get("content-encoding") ?? "identity").toLowerCase();
  const length = Number(headers.get("content-length") ?? NaN);
  return textual && encoding === "identity" && Number.isFinite(length) && length <= MAX_SCRUBBED_BYTES;
}

/** Text with each filled-in value swapped back for its stand-in. */
export function scrub(text: string, filled: readonly BrokeredSecret[]): string {
  let out = text;
  for (const secret of filled) {
    if (secret.value) out = out.split(secret.value).join(secret.standIn);
  }
  return out;
}

/** An answer's headers, with any filled-in value swapped back for its stand-in. */
export function scrubHeaders(headers: Headers, filled: readonly BrokeredSecret[]): Headers {
  const out = new Headers();
  headers.forEach((value, name) => out.append(name, scrub(value, filled)));
  return out;
}

/**
 * The line a job's log gets when a brokered secret's stand-in went to a
 * host it is not for, or over plain HTTP.
 */
export function misdirectedNote(name: string, host: string): string {
  return `##[warning]${name} was sent to ${normalizeHost(host)}, which it is not for or not over HTTPS, so g1t did not fill it in.`;
}

/** The most misdirected secrets noted in one job's log. */
const MAX_MISDIRECTED_NOTED = 25;

/** Notes a misdirected secret once per secret and host. `seen` is what was noted. */
export function newlyMisdirected(seen: readonly string[], name: string, host: string): { note: string; seen: string[] } | null {
  const key = `${name} ${normalizeHost(host)}`;
  if (seen.includes(key) || seen.length >= MAX_MISDIRECTED_NOTED) return null;
  return { note: misdirectedNote(name, host), seen: [...seen, key] };
}

type Cached = { at: number; secrets: BrokeredSecret[] };
/** Each job's stand-ins, in this isolate, for a minute: requests come in bursts. */
const CACHE = new Map<string, Cached>();
const CACHE_MS = 60_000;
/** A stand-in not in the cache is asked about again, but not more often than this. */
const RECHECK_MS = 5_000;
const CACHE_JOBS = 500;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: { message: string } };

/**
 * A running job's stand-ins and what they stand for, from the actions
 * service with the job's token. Kept a minute; asked again sooner when the
 * request carries a stand-in the kept answer lacks. Empty when the service
 * cannot say: the stand-ins then go as they are.
 */
export async function brokerFor(actions: ServiceBinding, job: BrokeredJob, wanted: readonly string[], now = Date.now()): Promise<BrokeredSecret[]> {
  const kept = CACHE.get(job.id);
  const fresh = kept && now - kept.at < CACHE_MS;
  const complete = kept && wanted.every((standIn) => kept.secrets.some((secret) => secret.standIn === standIn));
  if (kept && fresh && (complete || now - kept.at < RECHECK_MS)) return kept.secrets;
  try {
    const response = await actions.fetch("https://actions/rpc/brokered_secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job: job.id, token: job.token }),
    });
    if (!response.ok) throw new Error(`brokered_secrets failed with status ${response.status}`);
    const answer = (await response.json()) as Outcome<BrokeredSecret[]>;
    const secrets = answer.ok ? answer.value : [];
    if (CACHE.size >= CACHE_JOBS) CACHE.delete(CACHE.keys().next().value as string);
    CACHE.set(job.id, { at: now, secrets });
    return secrets;
  } catch (error) {
    // Never the value: only that it could not be had.
    console.log("brokered secrets not read", job.id, String(error));
    return kept?.secrets ?? [];
  }
}
