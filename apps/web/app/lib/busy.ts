/**
 * A button at work, for a button that asks the desktop app to do
 * something whose effect shows later, in a status the app sends: Retry,
 * Start, Stop, Check for runner updates, Restart now. From the click it is
 * busy (a spinner, pressed no more, `aria-busy`) until the status it waits
 * on changes, the app says it couldn't, or `BUSY_LIMIT` passes with no
 * change, so a press is never seen to do nothing and never leaves a
 * button dead. The app's own pages do the same (apps/desktop launcher/busy.js).
 */
import { useCallback, useEffect, useState } from "react";

/** How long a button waits for the status that follows before it is given back. */
export const BUSY_LIMIT = 20_000;

/** A press: the status as it was when the button was pressed, and when. */
export type Press = { status: string; at: number };

/** Whether a press still waits: the status is as it was, and not for too long. */
export function stillBusy(press: Press | null, status: string, now: number): boolean {
  return press !== null && press.status === status && now - press.at < BUSY_LIMIT;
}

/**
 * A button's busy state, waiting on `status` (any string that changes when
 * what the button asked for shows). `run` does the work: with `waits`, the
 * button stays busy until the status changes; without, until the work is
 * done. A failure gives the button back and goes to `onError`.
 */
export function useBusy(status: string, onError?: (error: unknown) => void) {
  const [press, setPress] = useState<Press | null>(null);
  const [now, setNow] = useState(0);
  // Given back after the limit, with nothing heard.
  useEffect(() => {
    if (!press) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, press.at + BUSY_LIMIT - Date.now()));
    return () => window.clearTimeout(timer);
  }, [press]);
  const busy = stillBusy(press, status, Math.max(now, press?.at ?? 0));
  const run = useCallback(
    (work: () => Promise<unknown> | undefined, waits = true) => {
      const pressed = { status, at: Date.now() };
      setPress(pressed);
      const done = () => setPress((current) => (current === pressed ? null : current));
      Promise.resolve()
        .then(work)
        .then(
          () => {
            if (!waits) done();
          },
          (error: unknown) => {
            done();
            onError?.(error);
          },
        );
    },
    [status, onError],
  );
  return { busy, run };
}
