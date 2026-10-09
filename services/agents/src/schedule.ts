/**
 * When routines run, and what a routine must have: pure, so it is tested
 * on its own (routines.ts runs them).
 */
import type { NewRoutine, RoutineEvent, RoutineSchedule } from "@g1t/contracts";

import { EVENT_KEYS } from "./suggest.ts";

const EVERY = ["hour", "day", "weekday", "week"] as const;

/** A schedule as given, checked; a message when it isn't one. */
export function checkSchedule(input: unknown): { ok: true; value: RoutineSchedule } | { ok: false; message: string } {
  if (!input || typeof input !== "object") return { ok: false, message: "Say when it runs." };
  const s = input as Record<string, unknown>;
  const every = EVERY.find((e) => e === s.every);
  if (!every) return { ok: false, message: "A routine runs every hour, day, weekday or week." };
  const int = (value: unknown, min: number, max: number) => (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null);
  const minute = int(s.minute ?? 0, 0, 59);
  const hour = int(s.hour ?? 9, 0, 23);
  const weekday = int(s.weekday ?? 1, 0, 6);
  if (minute === null || hour === null || weekday === null) return { ok: false, message: "The minute is 0 to 59, the hour 0 to 23 and the day 0 (Sunday) to 6." };
  return { ok: true, value: { every, minute, hour, weekday } };
}

/** When a routine next runs after `after`, in UTC. */
export function nextRun(schedule: RoutineSchedule, after: Date): Date {
  const next = new Date(after.getTime());
  next.setUTCSeconds(0, 0);
  if (schedule.every === "hour") {
    next.setUTCMinutes(schedule.minute);
    if (next <= after) next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }
  next.setUTCHours(schedule.hour, schedule.minute);
  if (next <= after) next.setUTCDate(next.getUTCDate() + 1);
  for (let i = 0; i < 8; i++) {
    const day = next.getUTCDay();
    const fits = schedule.every === "day" || (schedule.every === "weekday" ? day >= 1 && day <= 5 : day === schedule.weekday);
    if (fits) return next;
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

/** A schedule in words: "Every weekday at 09:00 UTC". */
export function describeSchedule(schedule: RoutineSchedule): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const at = `${pad(schedule.hour)}:${pad(schedule.minute)} UTC`;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  switch (schedule.every) {
    case "hour":
      return `Every hour at :${pad(schedule.minute)}`;
    case "day":
      return `Every day at ${at}`;
    case "weekday":
      return `Every weekday at ${at}`;
    case "week":
      return `Every ${days[schedule.weekday]} at ${at}`;
  }
}

export type CheckedRoutine = NewRoutine & { schedule: RoutineSchedule | null; events: RoutineEvent[]; repos: string[] };

/** A routine as given, checked: a name, instructions, and a schedule, events, or both. */
export function checkRoutine(input: NewRoutine): { ok: true; value: CheckedRoutine } | { ok: false; message: string } {
  const name = typeof input?.name === "string" ? input.name.trim().slice(0, 80) : "";
  const instructions = typeof input?.instructions === "string" ? input.instructions.trim().slice(0, 8000) : "";
  if (!name) return { ok: false, message: "Give the routine a name." };
  if (instructions.length < 10) return { ok: false, message: "Say what the routine does, in a sentence or more." };
  if (typeof input.channel_id !== "string" || !input.channel_id) return { ok: false, message: "Choose the channel it posts in." };
  const given = Array.isArray(input.events) ? input.events : [];
  if (given.some((e) => !EVENT_KEYS.includes(e))) return { ok: false, message: "That isn't something a routine can run on." };
  const events = [...new Set(given)];
  const repos = [...new Set((Array.isArray(input.repos) ? input.repos : []).filter((r): r is string => typeof r === "string").map((r) => r.trim().toLowerCase()).filter(Boolean))];
  if (repos.some((r) => !/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(r))) return { ok: false, message: "Name repositories as workspace/name." };
  if (repos.length > 20) return { ok: false, message: "A routine follows at most 20 repositories; leave it empty for all of them." };
  let schedule: RoutineSchedule | null = null;
  if (input.schedule) {
    const checked = checkSchedule(input.schedule);
    if (!checked.ok) return checked;
    schedule = checked.value;
  }
  if (!schedule && !events.length) return { ok: false, message: "A routine runs on a schedule, when something happens, or both." };
  return { ok: true, value: { ...input, name, instructions, schedule, events, repos, enabled: input.enabled !== false } };
}
