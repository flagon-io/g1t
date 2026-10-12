/**
 * How long the site waits on a service before it gives up. Nothing on
 * Workers ends a subrequest that stops answering: the page waits as long
 * as the visitor does, so a service stuck on one call holds the page on
 * its loading bar for good. With a deadline it fails instead, as an error
 * the page can draw and the next click can get past.
 */

/** A read: no page should wait longer than this on one service call. */
export const READ_DEADLINE_MS = 15_000;

/** A write: some do real work (an import, a merge), so they get longer. */
export const WRITE_DEADLINE_MS = 60_000;

/** What a call past its deadline throws. */
export class DeadlineExceeded extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${ms}ms`);
    this.name = "DeadlineExceeded";
  }
}

/**
 * `run`'s answer, or a `DeadlineExceeded` after `ms`. `run` is handed a
 * signal that aborts at the deadline, so the call it makes is cancelled
 * too; `outer`, when given, aborts it sooner. Whatever `run` reads must be
 * read inside it: the deadline ends when it returns.
 */
export async function withDeadline<T>(
  what: string,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal | null,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DeadlineExceeded(what, ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  const stop = () => controller.abort(outer?.reason);
  if (outer?.aborted) stop();
  else outer?.addEventListener("abort", stop, { once: true });
  try {
    // Raced as well as aborted: a binding that ignores the signal still lets go.
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  }
}
