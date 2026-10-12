/**
 * When a job's page asks for more of its log (components/actions.tsx,
 * `useJobLog`): about every second while a step is running, every few
 * seconds while the job waits between steps or for a machine, and, when
 * an answer fails (a 429, a 5xx, the network), again after a wait that
 * doubles up to half a minute, or as long as `Retry-After` says. Nothing
 * stops it for good but the job finishing or being gone.
 */

/** While a step is running. */
export const RUNNING_POLL_MS = 1000;
/** While the job is live but no step is running: queued, starting, between steps. */
export const IDLE_POLL_MS = 3000;
/** The first wait after a failure, doubled after each one that follows. */
export const FIRST_RETRY_MS = 2000;
/** The longest wait between tries after failures. */
export const MAX_RETRY_MS = 30_000;
/** A finished job's last fetch is tried this many times before it gives up. */
export const FINISHED_TRIES = 5;

export type PollAnswer =
  /** An answer: whether the job is done, and whether the page was full (more is waiting). */
  | { ok: true; done: boolean; full: boolean }
  /** No answer: its status, if there was one, and its `Retry-After` in milliseconds. */
  | { ok: false; status?: number; retryAfterMs?: number };

export type PollState = {
  /** Failures in a row so far. */
  failures: number;
  /** Whether the page shows the job as still going. */
  live: boolean;
  /** Whether one of its steps is running now. */
  running: boolean;
};

/** How long to wait before the next fetch, or null to stop; and the failures in a row after this answer. */
export function nextPoll(answer: PollAnswer, state: PollState): { delayMs: number | null; failures: number } {
  if (answer.ok) {
    if (answer.full) return { delayMs: 0, failures: 0 };
    if (answer.done || !state.live) return { delayMs: null, failures: 0 };
    return { delayMs: state.running ? RUNNING_POLL_MS : IDLE_POLL_MS, failures: 0 };
  }
  const failures = state.failures + 1;
  // The job is not there (deleted, or the repository is gone): nothing to wait for.
  if (answer.status === 404) return { delayMs: null, failures };
  if (!state.live && failures >= FINISHED_TRIES) return { delayMs: null, failures };
  const backoff = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (failures - 1));
  const asked = answer.retryAfterMs !== undefined ? Math.min(answer.retryAfterMs, 2 * MAX_RETRY_MS) : 0;
  return { delayMs: Math.max(backoff, asked), failures };
}

/** How long a running step may print nothing before its log says how long it has been quiet. */
export const QUIET_AFTER_MS = 10_000;

/** `45s`, `2m 10s`, `1h 5m`, as the run's page counts time. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * What a running step's log says under its last line: that nothing has
 * come yet, and for how long, or, once it has gone quiet for a while
 * (a build that prints nothing as it links, a download), for how long it
 * has printed nothing. Null while output is flowing. Times in ms.
 */
export function quietWords(started: number | null, lastOutput: number | null, now: number): string | null {
  if (lastOutput === null) return started === null ? "Running · no output yet" : `Running · no output yet, ${elapsed(now - started)}`;
  if (now - lastOutput < QUIET_AFTER_MS) return null;
  return `Running · no output for ${elapsed(now - lastOutput)}`;
}

/** `Retry-After` in milliseconds: seconds, or an HTTP date. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}
