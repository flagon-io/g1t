/**
 * The desktop app's own settings, from the site's side. Inside the app
 * (apps/desktop), the site draws them as a dialog over itself
 * (components/desktop-settings.tsx), and the runner's menu under the title
 * bar's dot (components/desktop-runner-menu.tsx); the app opens either by
 * an event (`onOpen`, `onRunnerMenu`) from its title bar, menu, tray and
 * shortcuts, once the page has said it can (`ready`). Until then, and on
 * any page that isn't the site's, they open in windows of the app's own.
 *
 * The settings are the app's (src/settings.rs `Settings`), in camelCase as
 * it keeps them. A change is saved over the settings as the app has them
 * at that moment (`saveSetting`), so a change made elsewhere at the same
 * time, from the menu's zoom or the Runner window, isn't undone.
 */
import type { DesktopBackend } from "@g1t/contracts";

import type { DesktopRunnerView } from "./desktop-runner";

/** What the app keeps (src/settings.rs `Settings`). */
export type DesktopSettings = {
  startHidden: boolean;
  closeToTray: boolean;
  notifications: boolean;
  flash: boolean;
  badge: boolean;
  systemTitleBar: boolean;
  zoom: number;
  autoUpdate: boolean;
  runner: boolean;
  runnerBackend: DesktopBackend;
  runnerWorkspace: string | null;
  runnerCapabilities: { linux: boolean; windows: boolean; macos: boolean };
};

/** What the settings show: the settings, and what the app and the system know (src/settings.rs `View`). */
export type DesktopSettingsView = DesktopSettings & {
  openAtLogin: boolean;
  version: string;
  platform: string;
  server: string;
  /** A version downloaded and waiting for a restart. */
  updateReady: string | null;
  /** When the app last heard back about updates, in milliseconds since 1970. */
  checkedAt: number | null;
  /** The title bar setting differs from the one the window has: a restart applies it. */
  titleBarChanged: boolean;
  customFrame: boolean;
  runnerView: DesktopRunnerView;
};

/** The app asks for the settings: at a section, and looking for updates as they open. */
export type DesktopSettingsOpening = { section: string | null; check: boolean };

/** The app asks for the runner menu: `toggle` from the title bar's dot, or `open`; `at` is where the dot is across the bar. */
export type DesktopRunnerMenuEvent = { action: "toggle" | "open"; at: number | null };

/** `window.g1tDesktop.settings`, from the app's bridge.js. */
export type DesktopSettingsBridge = {
  /** The page draws the settings and the runner menu (true), or no longer (false). */
  ready(ready?: boolean): Promise<void>;
  get(): Promise<DesktopSettingsView>;
  save(settings: DesktopSettings): Promise<DesktopSettingsView>;
  setOpenAtLogin(on: boolean): Promise<DesktopSettingsView>;
  /** "current", "ready:<version>", or rejects with why. */
  checkForUpdates(): Promise<string>;
  restart(): Promise<void>;
  restartToUpdate(): Promise<void>;
  changeServer(): Promise<void>;
  onOpen(listener: (opening: DesktopSettingsOpening) => void): () => void;
  onRunnerMenu(listener: (menu: DesktopRunnerMenuEvent) => void): () => void;
  onUpdateReady(listener: (version: string) => void): () => void;
  /** Whether the runner menu is open, which the title bar's dot shows. */
  setRunnerMenuOpen(open: boolean): void;
};

/** The bridge's settings, inside a desktop app new enough to have them; null elsewhere. */
export function desktopSettings(): DesktopSettingsBridge | null {
  if (typeof window === "undefined") return null;
  const settings = window.g1tDesktop?.settings;
  return settings && typeof settings.get === "function" && typeof settings.onOpen === "function" ? settings : null;
}

/** Every setting the app keeps, which a save sends whole. */
export const KEPT = [
  "startHidden",
  "closeToTray",
  "notifications",
  "flash",
  "badge",
  "systemTitleBar",
  "zoom",
  "autoUpdate",
  "runner",
  "runnerBackend",
  "runnerWorkspace",
  "runnerCapabilities",
] as const satisfies readonly (keyof DesktopSettings)[];

/** The settings as the app has them now, with one change made. */
export function settingsOf(fresh: DesktopSettingsView, change: Partial<DesktopSettings>): DesktopSettings {
  const settings = {} as Record<string, unknown>;
  for (const key of KEPT) settings[key] = fresh[key];
  return { ...(settings as DesktopSettings), ...change };
}

/** Saves one change over the settings as the app has them at that moment. */
export async function saveSetting(change: Partial<DesktopSettings>): Promise<DesktopSettingsView> {
  const bridge = desktopSettings();
  if (!bridge) throw new Error("This is the desktop app's.");
  const fresh = await bridge.get();
  return bridge.save(settingsOf(fresh, change));
}

/** The dialog's sections, in their order down its side. */
export const SECTIONS = [
  { id: "general", label: "Starting and closing" },
  { id: "runner", label: "Runner" },
  { id: "notifications", label: "Notifications" },
  { id: "window", label: "Window" },
  { id: "updates", label: "Updates" },
  { id: "server", label: "Server" },
  { id: "about", label: "About" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

/** The section the app asked for, or the first. */
export function sectionOf(value: unknown): SectionId {
  return SECTIONS.find((section) => section.id === value)?.id ?? "general";
}

/** The zoom levels the app offers (src/settings.rs ZOOMS). */
export const ZOOMS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/** The words that change between Windows, macOS and Linux. */
export function platformWords(platform: string) {
  const mac = platform === "macos";
  return {
    flash: mac ? "Bounce the dock icon" : platform === "windows" ? "Flash the taskbar icon" : "Ask for attention",
    systemTitleBar: mac ? "In place of g1t's own, which sits under the window's buttons." : "In place of g1t's own, with the menu bar under it.",
    zoom: mac ? "The View menu changes it too: ⌘+, ⌘− and ⌘0." : "The View menu changes it too: Ctrl+=, Ctrl+− and Ctrl+0.",
  };
}

/** What each way of running jobs can reach, said plainly (src/runner/backend.rs). */
export const BACKEND_NOTE: Record<DesktopBackend, { text: string; warn: boolean }> = {
  sandboxed: { text: "The runner and every job run in a sandbox of their own. Nothing a job does reaches this computer.", warn: false },
  docker: {
    text: "Each job runs in a container of its own, but the runner controls this computer's Docker, which can reach your files. Not a sandbox.",
    warn: true,
  },
  host: {
    text: "Jobs run directly on this computer, as you: they can read, change and delete anything your account can. For jobs that need this system itself, such as building a Windows installer.",
    warn: true,
  },
};

/** When, in a few words: "today at 9:41 AM", "Oct 3 at 9:41 AM". */
export function when(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date(now).toDateString() === date.toDateString();
  return today ? `today at ${time}` : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

/** Where this copy of the app stands with updates, in a line. */
export function updateLine(view: Pick<DesktopSettingsView, "updateReady" | "checkedAt" | "autoUpdate">, now = Date.now()): string {
  if (view.updateReady) return `Version ${view.updateReady} is downloaded and installs when g1t restarts.`;
  if (view.checkedAt) return `Up to date. Last checked ${when(view.checkedAt, now)}.`;
  return view.autoUpdate ? "Not checked yet since g1t started; it checks on its own shortly." : "Checking on its own is off.";
}

/** Why a check for updates didn't answer, in a line. */
export function checkFailed(error: unknown): string {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return !text || /sending request|connect|dns|timed out/i.test(text) ? "Could not reach g1t.sh to check. Check your connection and try again." : `Could not check: ${text}`;
}

/** The server, as its host: "g1t.sh". */
export function hostOf(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}
