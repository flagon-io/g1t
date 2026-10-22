/**
 * Where Work's cycle pages are, apart from lib/cycles.ts so the sidebar
 * (components/shell.tsx) links to them without bringing the cycle page's
 * figures into every page.
 */
import { workPath } from "./work-items.ts";

/** The current cycle's page, or a numbered cycle's. */
export function cyclePath(workspace: string, number?: number): string {
  return number == null ? workPath(workspace, "cycle") : workPath(workspace, `cycles/${number}`);
}

/** Planning the next cycle: Next beside the coming cycle. */
export function cyclePlanPath(workspace: string): string {
  return workPath(workspace, "cycle/plan");
}

/** Where Work's sidebar reads the current cycle. */
export function cycleJsonPath(workspace: string): string {
  return workPath(workspace, "cycle.json");
}

/** Work's settings, where cycles are turned on. */
export function workSettingsPath(workspace: string): string {
  return `/${workspace.toLowerCase()}/-/settings/work`;
}

/** The sidebar's row: the current cycle in a few words (lib/cycles.ts `sidebarCycle`). */
export type SidebarCycle = { number: number; left: string; done: number; scope: number; state: "upcoming" | "running" | "closed" };
