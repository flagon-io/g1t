/**
 * How a sandbox's Durable Object handles the end of its container without
 * failing the invocation it happens in. The containers library calls
 * `onStop` from the object's alarm: a stop hook that throws fails that
 * alarm, which Cloudflare retries and counts as an error each time, and
 * which runs the whole hook again. So the hook's calls to other services
 * go through `tellStopped`, which tries twice and logs at error level, and
 * never throws. Pure, so it is tested on its own.
 */

/** How long `tellStopped` waits before its second try. */
export const RETRY_AFTER_MS = 500;

/**
 * Tells another service that a sandbox stopped: `step` runs, and once more
 * if it throws. Never throws: a step that fails twice is logged with
 * `log` as `sandbox stop not reported`, with what and why, so it shows in
 * the runner's logs at error level and the five-minute sweep picks the
 * work up instead. Returns whether it got through.
 */
export async function tellStopped(
  what: string,
  step: () => Promise<unknown>,
  options: { log?: (...data: unknown[]) => void; attempts?: number; waitMs?: number } = {},
): Promise<boolean> {
  const log = options.log ?? console.error;
  const attempts = Math.max(1, options.attempts ?? 2);
  let last: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await step();
      return true;
    } catch (error) {
      last = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, options.waitMs ?? RETRY_AFTER_MS));
    }
  }
  log("sandbox stop not reported", what, describeError(last));
  return false;
}

/**
 * A service binding's answer as a step's outcome: a 5xx (or 429) throws, so
 * `tellStopped` tries again and logs it. A refusal is not a failure: the
 * work already reported its end, and services say so with `ok: false` or a
 * 4xx (the deployments service answers 404 for a build that has finished).
 */
export async function answered(what: string, response: Response): Promise<void> {
  if (response.status < 500 && response.status !== 429) return;
  const body = await response.text().catch(() => "");
  throw new Error(`${what} answered ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
}

/**
 * Whether a sandbox whose `sleepAfter` has passed is still inside its run's
 * time cap, and so keeps running: the cap, not inactivity, ends a run (the
 * runner never fetches the container, so to the library every sandbox looks
 * idle). Without a cap or a start time, `sleepAfter` applies.
 */
export function withinTimeCap(
  started: number | null | undefined,
  capMinutes: number | null | undefined,
  now: number,
  graceSeconds: number,
): boolean {
  if (typeof started !== "number" || typeof capMinutes !== "number" || capMinutes <= 0) return false;
  return now < started + (capMinutes * 60 + graceSeconds) * 1000;
}

/** An error as one line, for a log: its message, or what was thrown. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (error === undefined) return "no reason given";
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
