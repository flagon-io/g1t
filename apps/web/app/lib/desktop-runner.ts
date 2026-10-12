/**
 * The runner the desktop app keeps on this computer, from the site's side
 * (apps/desktop/src-tauri/src/runner). The app finds out what to run for,
 * and gets its registration token, through the page:
 *
 * 1. On every page, the page tells the app who is signed in, the
 *    workspaces they own (only owners add runners) and the one they are
 *    in (`offer`). The app answers with the workspace it wants a
 *    registration token for, if any, and asks again later (`onWanted`).
 * 2. For that workspace, the page asks the server for a token
 *    (`POST /-/desktop/runner`, owners only, same origin) and hands it to
 *    the app (`register`), or says why there is none. It is never shown
 *    or kept here.
 * 3. Whenever the runner's state changes, and every few minutes while g1t
 *    is open, the page sends the app's diagnosis to the server
 *    (`report`), so the workspace's Runners page lists every person's
 *    desktop with its state, why and the fix, in the app's own words.
 */
import { useEffect, useState } from "react";

import type { DesktopBackend, DesktopDiagnosis, DesktopReport } from "@g1t/contracts";

/** A fix, as a button: its id is the app's (`runner_control`). */
export type DesktopRunnerAction = { id: string; label: string };

/** What the app says of its runner (`runner::View` in the app). */
export type DesktopRunnerView = {
  diagnosis: DesktopDiagnosis & { actions: DesktopRunnerAction[] };
  closed: DesktopDiagnosis & { actions: DesktopRunnerAction[] };
  running: boolean;
  version: string | null;
  backend: DesktopBackend;
  workspace: string | null;
  workspaces: { slug: string; name: string | null }[];
  enabled: boolean;
  paused: boolean;
  link: string | null;
  machine: string;
  platform: string;
  log: string[];
};

export type DesktopRunnerOffer = { signedIn: boolean; workspaces: { slug: string; name: string | null }[]; current: string | null };

/** `window.g1tDesktop.runner`, from the app's bridge.js. */
export type DesktopRunnerBridge = {
  status(): Promise<DesktopRunnerView>;
  offer(offer: DesktopRunnerOffer): Promise<string | null>;
  register(answer: { workspace: string; token?: string | null; allowed?: boolean; error?: string | null }): Promise<void>;
  act(action: string): Promise<void>;
  onWanted(listener: (workspace: string) => void): () => void;
  onStatus(listener: (view: DesktopRunnerView) => void): () => void;
};

/** The bridge's runner, inside the desktop app (lib/notify-client.ts describes the rest of `window.g1tDesktop`). */
export function desktopRunner(): DesktopRunnerBridge | null {
  if (typeof window === "undefined") return null;
  const runner = window.g1tDesktop?.runner;
  return runner && typeof runner.status === "function" ? runner : null;
}

/** This computer's runner, live, inside the desktop app; null elsewhere. */
export function useDesktopRunner(): DesktopRunnerView | null {
  const [view, setView] = useState<DesktopRunnerView | null>(null);
  useEffect(() => {
    const runner = desktopRunner();
    if (!runner) return;
    let live = true;
    runner
      .status()
      .then((first) => {
        if (live) setView(first);
      })
      .catch(() => {});
    const stop = runner.onStatus((next) => setView(next));
    return () => {
      live = false;
      stop();
    };
  }, []);
  return view;
}

/** How often a desktop says it is still open, with nothing new: within the server's ten minutes. */
export const HEARTBEAT_MS = 4 * 60 * 1000;

/** What goes to the server, without the buttons, which only work on that computer. */
export function reportOf(view: DesktopRunnerView): DesktopReport | null {
  if (!view.workspace) return null;
  const plain = ({ code, tone, title, cause, fix }: DesktopDiagnosis): DesktopDiagnosis => ({ code, tone, title, cause, fix });
  return { workspace: view.workspace, machine: view.machine, backend: view.backend, version: view.version, diagnosis: plain(view.diagnosis), closed: plain(view.closed) };
}

/** Whether a report is due: something the Runners page shows changed, or the heartbeat. */
export function reportDue(last: { key: string; at: number } | null, report: DesktopReport, now: number): boolean {
  if (!last) return true;
  return last.key !== reportKey(report) || now - last.at >= HEARTBEAT_MS;
}

export function reportKey(report: DesktopReport): string {
  const { diagnosis } = report;
  return [report.workspace, report.machine, report.backend, report.version, diagnosis.code, diagnosis.title, diagnosis.cause, diagnosis.fix].join("\u0000");
}

/** A string with something in it, or null. */
export const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

const BACKENDS: DesktopBackend[] = ["sandboxed", "docker", "host"];
const TONES: DesktopDiagnosis["tone"][] = ["ok", "working", "off", "warning", "problem"];

export function backendOf(value: unknown): DesktopBackend | null {
  return BACKENDS.find((backend) => backend === value) ?? null;
}

/** A diagnosis as the app sent it, or null when it is not one. */
export function diagnosisOf(value: unknown): DesktopDiagnosis | null {
  if (!value || typeof value !== "object") return null;
  const given = value as Record<string, unknown>;
  const code = text(given.code);
  const title = text(given.title);
  const tone = TONES.find((t) => t === given.tone);
  if (!code || !title || !tone) return null;
  return { code, tone, title, cause: text(given.cause), fix: text(given.fix) };
}

/** The words for how a desktop runs jobs, as its settings say them. */
export const BACKEND_LABEL: Record<DesktopBackend, string> = {
  sandboxed: "Sandboxed",
  docker: "In Docker (not a sandbox)",
  host: "Directly on the computer (not a sandbox)",
};
