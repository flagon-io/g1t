/**
 * How long a page's stream stays open for what its loader defers
 * (entry.server.tsx). Whatever has not settled by then the router rejects
 * with "Server Timeout", which reaches the page as an error: a slow service
 * (one starting up during a deploy, say) would take the whole page down.
 */
export const STREAM_TIMEOUT_MS = 5_000;

/** Settled this long before the stream closes, so its answer still goes out. */
const MARGIN_MS = 750;

/**
 * `promise`, or `fallback` if it has not settled shortly before the stream
 * closes: a section that ran out of time shows as unavailable, as one whose
 * service failed does, and the rest of the page is drawn.
 */
export function inTime<T, F>(promise: Promise<T>, fallback: F, ms = STREAM_TIMEOUT_MS - MARGIN_MS): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}
