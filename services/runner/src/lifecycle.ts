/**
 * How a sandbox's Durable Object handles the end of its container without
 * failing the invocation it happens in. The containers library calls
 * `onStop` from the object's alarm: a stop hook that throws fails that
 * alarm, which Cloudflare retries and counts as an error each time, and
 * which runs the whole hook again. So the hook's calls to other services
 * go through `tellStopped`, which tries twice and logs at error level, and
 * never throws. Pure, so it is tested on its own.
 */

/**
 * The sandbox of one start of a workflow job. Each start gets its own: a
 * job that never reported, or lost its machine, goes back in the queue and
 * its sandbox is stopped, and that stop finishes later, in the sandbox's
 * alarm. When every start shared `actions:<job>`, a job started again
 * within those seconds (by another job's finish, not the sweep) was in the
 * same sandbox, and the stop meant for the lost start killed it
 * (flagon-io#426: rust-7 of Self-host, 2026-10-23 07:22:49 → 07:23:05).
 * Without a start (an actions service from before), the job's one sandbox.
 */
export function actionsSandboxName(job: string, start?: string | null): string {
  return start ? `actions:${job}@${start}` : `actions:${job}`;
}

/**
 * The sandboxes a stop of a job's start reaches: that start's, and the
 * job's one sandbox from before starts had their own, which a job started
 * since never uses.
 */
export function actionsSandboxesToStop(job: string, start?: string | null): string[] {
  return start ? [actionsSandboxName(job, start), actionsSandboxName(job)] : [actionsSandboxName(job)];
}

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
export function withinTimeCap(started: number | null | undefined, capMinutes: number | null | undefined, now: number, graceSeconds: number): boolean {
  if (typeof started !== "number" || typeof capMinutes !== "number" || capMinutes <= 0) return false;
  return now < started + (capMinutes * 60 + graceSeconds) * 1000;
}

/**
 * Whether the run a sandbox holds now has used its whole time cap, so a
 * `timeUp` alarm may stop it. A sandbox's Durable Object is named for its
 * work (`actions:{job}` and the like), and a re-run of that work starts in
 * the same object; an alarm an earlier attempt left must not stop the
 * attempt running now, which started later and has its own alarm.
 */
export function capReached(started: number | null | undefined, capMinutes: number | null | undefined, now: number): boolean {
  if (typeof started !== "number" || typeof capMinutes !== "number" || capMinutes <= 0) return false;
  return now >= started + capMinutes * 60 * 1000;
}

/**
 * Whether a sandbox's stop ends its work as a failure. A sandbox g1t
 * stopped (at its time cap, say) can come back with exit code 0, since the
 * container library reports a destroyed container as a clean exit; the
 * reason g1t stopped it, not the exit code, says how it ended.
 */
export function stoppedShort(exitCode: number, why: string | null): boolean {
  return exitCode !== 0 || why !== null;
}

/**
 * Whether a sandbox could not start because Cloudflare had no container to
 * give it: every instance of its class is taken, or a rollout is replacing
 * them. It passes; the work waits for a machine rather than failing.
 */
export function noMachine(error: unknown): boolean {
  return /no container instance/i.test(describeError(error));
}

/**
 * Whether a start failed on Cloudflare's side in a way that says nothing
 * about the work: an internal error (with Cloudflare's reference), a lost
 * connection, or the object reset under the call by a deploy. Each start
 * has a sandbox of its own (`actionsSandboxName`), so the work waits for a
 * machine and starts again in a fresh one, as for `noMachine`, rather than
 * failing: on 2026-10-23 two deploys failed on "internal error; reference
 * = …" when a job's start was refused (#426).
 */
export function transientStart(error: unknown): boolean {
  return /internal error; reference =|network connection lost|durable object reset|no longer active|code (was|has been) updated/i.test(describeError(error));
}

/**
 * How often a start asks Cloudflare for a container. The containers
 * library asks every 300 ms; every ask Cloudflare refuses (`noMachine`)
 * is logged at error level from the object's alarm, so one sandbox in a
 * burst of starts logged 30 to 85 refusals before it got a container
 * (2026-10-21, #293). Asked once a second, a refused start logs about a
 * third as many, and a start that is given one is no slower: the library
 * waits between asks only when an ask failed.
 */
export const START_POLL_MS = 1000;

/** A sandbox's start asks for this long, as the library's does (8 s); then the job waits for a machine. */
export const START_WAIT = { waitInterval: START_POLL_MS, retries: 8 } as const;

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

/**
 * Sandbox time billing has not confirmed yet, kept in the sandbox's
 * storage until it does. `usage` is fixed when the sandbox stopped, so a
 * later try records the same seconds under the same reference, which
 * billing records once whatever it is sent (`record_sandbox`).
 */
export type Owed<U extends { reference: string }> = {
  usage: U;
  /** Tries so far that billing did not confirm. */
  attempts: number;
  /** When the sandbox stopped, in ms. */
  since: number;
};

/** The longest wait between tries: an hour. */
export const OWED_MAX_DELAY_SECONDS = 60 * 60;
/** How long sandbox time is tried for before it is logged as lost: a week. */
export const OWED_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;

/** The wait before the next try, after `attempts` failed ones: 30 seconds, doubling, at most an hour. */
export function owedDelaySeconds(attempts: number): number {
  return Math.min(OWED_MAX_DELAY_SECONDS, 30 * 2 ** Math.min(16, Math.max(0, attempts - 1)));
}

/**
 * Tries to record each owed usage once. Returns what billing confirmed
 * (to forget), what to keep for another try (with its attempts counted),
 * what has been tried for too long (to log and forget), and the wait before
 * the next try, or null when nothing is kept. `record` resolves true only
 * when billing confirmed it; a throw is a failure like any other.
 */
export async function recordOwed<U extends { reference: string }>(
  owed: Owed<U>[],
  record: (usage: U) => Promise<boolean>,
  now: number,
): Promise<{ recorded: Owed<U>[]; kept: Owed<U>[]; lost: Owed<U>[]; retryInSeconds: number | null }> {
  const recorded: Owed<U>[] = [];
  const kept: Owed<U>[] = [];
  const lost: Owed<U>[] = [];
  for (const entry of owed) {
    const ok = await record(entry.usage).catch(() => false);
    if (ok) {
      recorded.push(entry);
      continue;
    }
    const next = { ...entry, attempts: entry.attempts + 1 };
    if (now - entry.since >= OWED_GIVE_UP_MS) lost.push(next);
    else kept.push(next);
  }
  const retryInSeconds = kept.length ? Math.min(...kept.map((entry) => owedDelaySeconds(entry.attempts))) : null;
  return { recorded, kept, lost, retryInSeconds };
}
