import { useEffect, useRef } from "react";

import type { DesktopReport } from "@g1t/contracts";

import { type DesktopRunnerOffer, desktopRunner, reportDue, reportKey, reportOf } from "../lib/desktop-runner";

/**
 * Inside the desktop app, on every page: the link between the app's runner
 * and the site (lib/desktop-runner.ts). It tells the app who is signed in
 * and what they own, makes the registration token the app asks for, and
 * keeps the server told how the runner is. It draws nothing.
 */
export function DesktopRunnerLink({ offer }: { offer: DesktopRunnerOffer }) {
  const key = JSON.stringify(offer);
  const last = useRef<{ key: string; at: number } | null>(null);

  // Registering: the token goes straight from the server to the app.
  useEffect(() => {
    const runner = desktopRunner();
    if (!runner) return;
    let asking: string | null = null;
    const signedIn = (JSON.parse(key) as DesktopRunnerOffer).signedIn;
    const register = async (workspace: string) => {
      // Signed out, the app says so itself, from the offer.
      if (!signedIn || asking === workspace) return;
      asking = workspace;
      try {
        const response = await fetch("/-/desktop/runner", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intent: "token", workspace }),
        });
        const answer = (await response.json().catch(() => ({}))) as { token?: string; error?: string; allowed?: boolean };
        await runner.register(
          answer.token ? { workspace, token: answer.token } : { workspace, allowed: answer.allowed !== false, error: answer.error ?? `g1t answered ${response.status}.` },
        );
      } catch {
        // Offline, or the page is leaving: the app asks again in a minute.
      } finally {
        asking = null;
      }
    };
    const stop = runner.onWanted((workspace) => void register(workspace));
    void runner
      .offer(JSON.parse(key) as DesktopRunnerOffer)
      .then((wanted) => {
        if (wanted) void register(wanted);
      })
      .catch(() => {});
    return stop;
  }, [key]);

  // Reporting: what the Runners page shows of this computer, on each change and as a heartbeat.
  useEffect(() => {
    const runner = desktopRunner();
    if (!runner || !offer.signedIn) return;
    const send = (report: DesktopReport | null) => {
      if (!report || !offer.workspaces.some((w) => w.slug === report.workspace)) return;
      const now = Date.now();
      if (!reportDue(last.current, report, now)) return;
      last.current = { key: reportKey(report), at: now };
      void fetch("/-/desktop/runner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "report", ...report }),
      }).catch(() => {
        last.current = null;
      });
    };
    const look = () =>
      void runner
        .status()
        .then((view) => send(reportOf(view)))
        .catch(() => {});
    look();
    const stop = runner.onStatus((view) => send(reportOf(view)));
    const beat = window.setInterval(look, 60_000);
    return () => {
      stop();
      window.clearInterval(beat);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
