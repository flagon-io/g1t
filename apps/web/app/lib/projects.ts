/**
 * Work's projects as the site shows them: where their pages are, how their
 * state, health and dates read, how their open work items sit on the hill,
 * and what a project's form posts. Pure, so it is tested under Node.
 *
 * A project here is Work's home for a body of work (`WorkProject` in the
 * contracts). What Code calls a project is a repository.
 */
import type { Appetite, Hill, Progress, ProjectChange, ProjectHealth, ProjectState, WorkItem, WorkProject } from "@g1t/contracts";

import { HILL_STEPS } from "./plan.ts";
import { workPath } from "./work-items.ts";

/** What a project's forms post back: which form, the project's slug after, and what went wrong. */
export type ProjectResult = { intent: string; slug?: string; error?: string };

/** The workspace's projects. */
export function projectsPath(workspace: string, query = ""): string {
  return `${workPath(workspace, "projects")}${query ? `?${query}` : ""}`;
}

/** A project's home, or one of its tabs (`items`). */
export function projectPath(workspace: string, slug: string, tab?: "items"): string {
  return `${workPath(workspace, "projects")}/${encodeURIComponent(slug)}${tab ? `/${tab}` : ""}`;
}

/** Where the sidebar reads the workspace's live projects. */
export function projectsJsonPath(workspace: string): string {
  return `${workPath(workspace, "projects.json")}`;
}

export const STATE_LABELS: Record<ProjectState, string> = {
  shaping: "Shaping",
  active: "Active",
  paused: "Paused",
  done: "Done",
  dropped: "Dropped",
};

/** What each state means, for its menu. */
export const STATE_HINTS: Record<ProjectState, string> = {
  shaping: "The work is being shaped: its brief is not settled yet",
  active: "Being worked on",
  paused: "On hold, to come back to",
  done: "Its outcome was reached",
  dropped: "Let go without reaching it",
};

export const PROJECT_STATE_ORDER: readonly ProjectState[] = ["active", "shaping", "paused", "done", "dropped"];

export const HEALTH_LABELS: Record<ProjectHealth, string> = { on_track: "On track", at_risk: "At risk", off_track: "Off track" };

export const HEALTHS: readonly ProjectHealth[] = ["on_track", "at_risk", "off_track"];

/** The badge tone each health and state is drawn in. */
export function healthTone(health: ProjectHealth | null): "success" | "warn" | "danger" | "neutral" {
  return health === "on_track" ? "success" : health === "at_risk" ? "warn" : health === "off_track" ? "danger" : "neutral";
}

export function stateTone(state: ProjectState): "accent" | "info" | "neutral" | "success" {
  return state === "active" ? "accent" : state === "shaping" ? "info" : state === "done" ? "success" : "neutral";
}

/** Whether a project is still under way: shaping, active or paused, and not archived. */
export function isLive(project: Pick<WorkProject, "state" | "archivedAt">): boolean {
  return project.archivedAt == null && (project.state === "shaping" || project.state === "active" || project.state === "paused");
}

/**
 * The projects the sidebar lists: live ones, active first, then shaping,
 * then paused, each by name; at most `max`.
 */
export function sidebarProjects<P extends Pick<WorkProject, "state" | "archivedAt" | "name">>(projects: readonly P[], max = 12): P[] {
  const rank = (state: ProjectState) => PROJECT_STATE_ORDER.indexOf(state);
  return projects
    .filter(isLive)
    .sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name))
    .slice(0, max);
}

/** The projects page's groups: live ones, then done and dropped. Archived ones are their own list. */
export function projectGroups<P extends Pick<WorkProject, "state" | "archivedAt" | "name">>(projects: readonly P[]): { live: P[]; finished: P[] } {
  const byName = (a: P, b: P) => a.name.localeCompare(b.name);
  const rank = (state: ProjectState) => PROJECT_STATE_ORDER.indexOf(state);
  return {
    live: projects.filter(isLive).sort((a, b) => rank(a.state) - rank(b.state) || byName(a, b)),
    finished: projects.filter((project) => !isLive(project)).sort(byName),
  };
}

/** How far along a project is, from 0 to 100: closed work items over all of them. */
export function percentDone(project: Pick<WorkProject, "openItems" | "closedItems">): number {
  const total = project.openItems + project.closedItems;
  return total === 0 ? 0 : Math.floor((project.closedItems * 100) / total);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A day (`YYYY-MM-DD`) as people read it: "Oct 20", with the year when it is not `thisYear`. */
export function dayText(day: string, thisYear?: number): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  const short = `${MONTHS[month - 1]} ${date}`;
  return thisYear != null && year !== thisYear ? `${short}, ${year}` : short;
}

/** A project's dates as one phrase: "Oct 20 → Dec 12", "Due Dec 12", "From Oct 20"; null for none. */
export function datesText(project: Pick<WorkProject, "startOn" | "targetOn">, today: Date): string | null {
  const year = today.getUTCFullYear();
  if (project.startOn && project.targetOn) return `${dayText(project.startOn, year)} → ${dayText(project.targetOn, year)}`;
  if (project.targetOn) return `Due ${dayText(project.targetOn, year)}`;
  if (project.startOn) return `From ${dayText(project.startOn, year)}`;
  return null;
}

const DAY_MS = 86_400_000;

/** Whole days from `today` to `day` (negative once it has passed), counted in UTC days. */
export function daysUntil(day: string, today: Date): number | null {
  const time = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(time)) return null;
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((time - start) / DAY_MS);
}

/**
 * How long is left before a live project's target, in words: "12 days
 * left", "Due today", "3 days late"; null without a target or once it is
 * done or dropped.
 */
export function timeLeft(project: Pick<WorkProject, "targetOn" | "state">, today: Date): { text: string; late: boolean } | null {
  if (!project.targetOn || project.state === "done" || project.state === "dropped") return null;
  const days = daysUntil(project.targetOn, today);
  if (days == null) return null;
  if (days === 0) return { text: "Due today", late: false };
  const count = Math.abs(days);
  const span = count >= 14 ? `${Math.round(count / 7)} weeks` : count === 1 ? "1 day" : `${count} days`;
  return days > 0 ? { text: `${span} left`, late: false } : { text: `${span} late`, late: true };
}

/** How far through its dates a project is today, from 0 to 100; null without both. */
export function timeElapsed(project: Pick<WorkProject, "startOn" | "targetOn">, today: Date): number | null {
  if (!project.startOn || !project.targetOn) return null;
  const start = Date.parse(`${project.startOn}T00:00:00Z`);
  const end = Date.parse(`${project.targetOn}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return Math.max(0, Math.min(100, Math.round(((today.getTime() - start) / (end - start)) * 100)));
}

/** One work item on a project's hill, where it is drawn: `x` and `y` in a 320 by 120 box. */
export type HillDot = { item: WorkItem; hill: Hill; x: number; y: number };

/** The hill's curve in that box: a sine from (12, 104) up to (160, 16) and down to (308, 104). */
export function hillY(x: number): number {
  const along = Math.min(1, Math.max(0, (x - 12) / 296));
  return 104 - Math.sin(along * Math.PI) * 88;
}

/**
 * Where each open work item sits on a project's hill: its stage (read from
 * its record, never set by hand) places it in that quarter of the curve,
 * and several in one stage spread out along it, so none hides another.
 * Items with no progress read as figuring it out.
 */
export function hillDots(open: readonly WorkItem[], progress: readonly Pick<Progress, "number" | "hill">[]): HillDot[] {
  const hillOf = new Map(progress.map((one) => [one.number, one.hill]));
  const byStage = HILL_STEPS.map((stage) => open.filter((item) => (hillOf.get(item.number) ?? "figuring_out") === stage));
  return byStage.flatMap((items, step) => {
    const from = 12 + (step * 296) / HILL_STEPS.length;
    const width = 296 / HILL_STEPS.length;
    return items.map((item, index) => {
      // Evenly across its quarter, a little in from each edge.
      const x = from + (width * (index + 1)) / (items.length + 1);
      return { item, hill: HILL_STEPS[step]!, x: Math.round(x * 10) / 10, y: Math.round(hillY(x) * 10) / 10 };
    });
  });
}

/** How many open work items are at each stage of the hill. */
export function hillCounts(dots: readonly HillDot[]): Record<Hill, number> {
  const counts = Object.fromEntries(HILL_STEPS.map((stage) => [stage, 0])) as Record<Hill, number>;
  for (const dot of dots) counts[dot.hill] += 1;
  return counts;
}

/** A project's open work items in Now, in the plan's order (the work service gives them so). */
export function nowItems(open: readonly WorkItem[]): WorkItem[] {
  return open.filter((item) => item.horizon === "now");
}

/** "3 people", "1 person". */
export function peopleText(count: number): string {
  return count === 1 ? "1 person" : `${count.toLocaleString("en-US")} people`;
}

function appetiteOf(value: string): Appetite | null | undefined {
  if (value === "") return null;
  return value === "small" || value === "medium" || value === "large" ? value : undefined;
}

function healthOf(value: string): ProjectHealth | null | undefined {
  if (value === "") return null;
  return HEALTHS.find((health) => health === value);
}

/**
 * What a project's form posts, as a change: only the fields the form has
 * (`name`, `slug`, `summary`, `brief`, `lead`, `state`, `appetite`,
 * `startOn`, `targetOn`, `health`, `icon`, `color`), or what is wrong.
 * An empty appetite or health clears it.
 */
export function projectChangeOf(form: { has(name: string): boolean; get(name: string): FormDataEntryValue | null }): ProjectChange | string {
  const text = (key: string) => (form.has(key) ? String(form.get(key) ?? "").trim() : undefined);
  const change: ProjectChange = {};
  const name = text("name");
  if (name !== undefined) {
    if (!name) return "A project needs a name.";
    change.name = name;
  }
  for (const key of ["slug", "summary", "lead", "icon", "color", "startOn", "targetOn"] as const) {
    const value = text(key);
    if (value !== undefined) change[key] = value;
  }
  if (form.has("brief")) change.brief = String(form.get("brief") ?? "");
  if (form.has("instructions")) change.instructions = String(form.get("instructions") ?? "");
  const state = text("state");
  if (state) {
    if (!PROJECT_STATE_ORDER.includes(state as ProjectState)) return "Choose a state: shaping, active, paused, done or dropped.";
    change.state = state as ProjectState;
  }
  const appetite = text("appetite");
  if (appetite !== undefined) {
    const value = appetiteOf(appetite);
    if (value === undefined) return "Choose an appetite: small, medium or large.";
    change.appetite = value;
  }
  const health = text("health");
  if (health !== undefined) {
    const value = healthOf(health);
    if (value === undefined) return "Choose a health: on track, at risk or off track.";
    change.health = value;
  }
  if (change.startOn && change.targetOn && change.targetOn < change.startOn) return "The target date can't be before the start date.";
  return change;
}

/** The colors a new project can take, as six hex digits (the label palette's stronger half). */
export const PROJECT_COLORS: readonly string[] = ["5319e7", "1d76db", "0e8a16", "d93f0b", "b60205", "fbca04", "006b75", "e99695"];
