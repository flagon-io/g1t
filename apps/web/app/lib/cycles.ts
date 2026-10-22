/**
 * Work's cycles as the site shows them: where their pages are, how their
 * days read, and the cycle page's figures, all read from a cycle and its
 * work items (`getCycle`): the burn-up, the stage strip, and how much of
 * each person's and each agent's work is done. Pure, so it is tested
 * under Node.
 *
 * While a workspace has cycles on, the plan's Now is the current cycle.
 */
import type { Cycle, CycleDetail, CycleMember, WorkItem } from "@g1t/contracts";

import { type ItemPull, STAGES, type Stage, stageOf } from "./board.ts";
import type { SidebarCycle } from "./cycle-paths.ts";

export { type SidebarCycle, cycleJsonPath, cyclePath, cyclePlanPath, workSettingsPath } from "./cycle-paths.ts";

// --- Days ---------------------------------------------------------------------
// Days are YYYY-MM-DD in UTC, as the work service counts them, and a cycle
// holds its first and its last day.

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The ISO weekday's name: 1 is Monday. */
export function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday - 1] ?? "";
}

/** The days since the Unix epoch of a day (YYYY-MM-DD); NaN for anything else. */
export function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) / 86_400_000);
}

/** The day (YYYY-MM-DD) `number` days after the Unix epoch. */
export function dayOf(number: number): string {
  return new Date(number * 86_400_000).toISOString().slice(0, 10);
}

/** Days left in a cycle on `today`, counting today: 1 on its last day, 0 once over, all of it before it starts. */
export function cycleDaysLeft(cycle: Pick<Cycle, "startsOn" | "endsOn">, today: string): number {
  const start = dayNumber(cycle.startsOn);
  const end = dayNumber(cycle.endsOn);
  const now = dayNumber(today);
  if ([start, end, now].some(Number.isNaN)) return 0;
  return Math.max(0, end - Math.max(now, start) + 1);
}

/** "Oct 19 – Nov 1", with the years when the two days are in different ones. */
export function cycleDays(cycle: Pick<Cycle, "startsOn" | "endsOn">): string {
  const day = (text: string, year: boolean) =>
    new Date(`${text}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
  const years = cycle.startsOn.slice(0, 4) !== cycle.endsOn.slice(0, 4);
  return `${day(cycle.startsOn, years)} – ${day(cycle.endsOn, years)}`;
}

// --- Pages ------------------------------------------------------------------------

/** "Cycle 14". */
export function cycleName(cycle: Pick<Cycle, "number">): string {
  return `Cycle ${cycle.number}`;
}

/** A day as "Nov 2". */
export function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A day as "Mon, Nov 2". */
export function dayText(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Where a cycle is, in a few words: "4 days left", "Last day", "Starts Mon, Nov 2", "Ended Sun, Nov 1". */
export function daysLeftText(cycle: Pick<Cycle, "startsOn" | "endsOn" | "state">, today: string): string {
  if (cycle.state === "closed" || today > cycle.endsOn) return `Ended ${dayText(cycle.endsOn)}`;
  if (today < cycle.startsOn) return `Starts ${dayText(cycle.startsOn)}`;
  const left = cycleDaysLeft(cycle, today);
  return left === 1 ? "Last day" : `${left} days left`;
}

/** "9/14": done of scope. */
export function doneOfScope(cycle: Pick<Cycle, "done" | "scope">): string {
  return `${cycle.done}/${cycle.scope}`;
}

/** Whether a work item counts in a cycle's scope: one closed as not planned does not. */
function counts(item: WorkItem): boolean {
  return !(item.state === "closed" && item.reason === "not_planned");
}

/** Whether it was finished in this cycle: closed as completed while in it. */
export function finishedIn(item: WorkItem, cycle: Pick<Cycle, "number">): boolean {
  return item.state === "closed" && item.reason !== "not_planned" && item.cycle === cycle.number;
}

/** One day of the burn-up: how much the cycle had taken on, and how much of it was done, by the end of `day`. */
export type BurnPoint = { day: string; scope: number; done: number };

/**
 * The burn-up: for each day of the cycle so far (all of it once closed),
 * how many work items it had taken on by then and how many of them were
 * done. A work item counts from the day it joined (one carried in or
 * planned, from the first day), and as done from the day it closed.
 * Nothing before the cycle starts.
 */
export function burnUp(detail: Pick<CycleDetail, "cycle" | "items" | "members">, today: string): BurnPoint[] {
  const { cycle } = detail;
  const start = dayNumber(cycle.startsOn);
  const end = Math.min(dayNumber(cycle.endsOn), cycle.state === "closed" ? Infinity : dayNumber(today));
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
  const facts = detail.items.filter(counts).map((item) => {
    const member = detail.members.find((one) => one.number === item.number);
    const joined = member?.addedAt ? Math.max(start, dayNumber(member.addedAt)) : start;
    const finished = finishedIn(item, cycle) && item.closedAt ? Math.max(start, dayNumber(item.closedAt)) : null;
    return { joined: Number.isNaN(joined) ? start : joined, finished };
  });
  const points: BurnPoint[] = [];
  for (let day = start; day <= end; day++) {
    points.push({
      day: dayOf(day),
      scope: facts.filter((one) => one.joined <= day).length,
      done: facts.filter((one) => one.finished != null && one.finished <= day).length,
    });
  }
  return points;
}

/** The board's facts for a work item, from what the cycle says of it. */
function boardFacts(member: CycleMember | undefined): { pulls: ItemPull[]; claimed: boolean; live: boolean } {
  if (!member) return { pulls: [], claimed: false, live: false };
  const pulls: ItemPull[] = [];
  const add = (count: number, status: ItemPull["status"]) => {
    for (let i = 0; i < count; i++) pulls.push({ key: `${status}-${i}`, status, part: false });
  };
  add(member.draftPulls, "draft");
  add(member.openPulls, "open");
  add(member.mergedPulls, "merged");
  return { pulls, claimed: member.claimed, live: member.live };
}

/**
 * Where a work item of the cycle stands on the board (lib/board.ts): Done
 * once finished in the cycle however long ago; none for one closed as not
 * planned, or no longer in the cycle (carried out of it).
 */
export function cycleStageOf(item: WorkItem, member: CycleMember | undefined, cycle: Pick<Cycle, "number">, now: number): Stage | null {
  if (item.cycle !== cycle.number || !counts(item)) return null;
  if (item.state === "closed") return "done";
  return stageOf(item, boardFacts(member), now);
}

/** How many of the cycle's work items stand at each stage, Up next to Done. */
export function stageCounts(detail: Pick<CycleDetail, "cycle" | "items" | "members">, now: number): Record<Stage, number> {
  const tally = Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<Stage, number>;
  for (const item of detail.items) {
    const stage = cycleStageOf(
      item,
      detail.members.find((one) => one.number === item.number),
      detail.cycle,
      now,
    );
    if (stage) tally[stage] += 1;
  }
  return tally;
}

/** Someone's or something's share of the cycle: how many of theirs are done, of how many. */
export type Tally = { name: string; done: number; total: number };

/** Most work first, then by name; `last` (the unassigned) at the end. */
function sorted(tallies: Map<string, Tally>, last?: string): Tally[] {
  return [...tallies.values()].sort((a, b) => Number(a.name === last) - Number(b.name === last) || b.total - a.total || a.name.localeCompare(b.name));
}

/** The work items a cycle took on and still holds: carried-out ones are the next cycle's now. */
function held(detail: Pick<CycleDetail, "cycle" | "items">): WorkItem[] {
  return detail.items.filter((item) => counts(item) && item.cycle === detail.cycle.number);
}

/** Each assignee's share of the cycle, and the unassigned work as "Unassigned". */
export function byPerson(detail: Pick<CycleDetail, "cycle" | "items">): Tally[] {
  const tallies = new Map<string, Tally>();
  const count = (name: string, item: WorkItem) => {
    const tally = tallies.get(name) ?? { name, done: 0, total: 0 };
    tally.total += 1;
    if (item.state === "closed") tally.done += 1;
    tallies.set(name, tally);
  };
  for (const item of held(detail)) {
    if (item.assignees.length === 0) count(UNASSIGNED, item);
    for (const name of item.assignees) count(name, item);
  }
  return sorted(tallies, UNASSIGNED);
}

export const UNASSIGNED = "Unassigned";

/** Each agent's share of the cycle: the work items whose newest pull request it made. */
export function byAgent(detail: Pick<CycleDetail, "cycle" | "items" | "members">): Tally[] {
  const tallies = new Map<string, Tally>();
  for (const item of held(detail)) {
    const agent = detail.members.find((one) => one.number === item.number)?.agent;
    if (!agent) continue;
    const tally = tallies.get(agent) ?? { name: agent, done: 0, total: 0 };
    tally.total += 1;
    if (item.state === "closed") tally.done += 1;
    tallies.set(agent, tally);
  }
  return sorted(tallies);
}

/** A cycle's report, its work items in groups: finished in it, carried out of it, still open in it, and those added after it started. */
export type CycleReport = { finished: WorkItem[]; carried: WorkItem[]; open: WorkItem[]; added: WorkItem[] };

export function cycleReport(detail: Pick<CycleDetail, "cycle" | "items" | "members">): CycleReport {
  const member = (item: WorkItem) => detail.members.find((one) => one.number === item.number);
  const items = detail.items.filter(counts);
  return {
    finished: items.filter((item) => finishedIn(item, detail.cycle)),
    carried: items.filter((item) => member(item)?.carriedOut),
    open: items.filter((item) => item.state === "open" && item.cycle === detail.cycle.number && !member(item)?.carriedOut),
    added: items.filter((item) => member(item)?.added),
  };
}

/** The sidebar's row: the current cycle in a few words, or null while cycles are off. */
export function sidebarCycle(cycle: Cycle | null | undefined, today: string): SidebarCycle | null {
  if (!cycle) return null;
  return { number: cycle.number, left: daysLeftText(cycle, today), done: cycle.done, scope: cycle.scope, state: cycle.state };
}

/** Today in UTC, as cycles count their days. */
export function utcToday(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The days of a workspace's first cycle if it turned cycles on `today`:
 * from the latest `weekday` on or before today, for `length` days, as the
 * work service opens it.
 */
export function firstCycle(today: string, weekday: number, length: number): { startsOn: string; endsOn: string } {
  const now = dayNumber(today);
  // The epoch was a Thursday, ISO day 4.
  const isoDay = ((((now + 3) % 7) + 7) % 7) + 1;
  const start = now - ((((isoDay - weekday) % 7) + 7) % 7);
  return { startsOn: dayOf(start), endsOn: dayOf(start + length - 1) };
}
