#!/usr/bin/env node
// Runs the services' cron triggers in a self-hosted g1t. `wrangler dev`
// (workerd) never fires a Worker's `scheduled` handler on its own, so this
// does: once a minute it asks Wrangler's local API to run the handler of
// each service whose cron matches the time (UTC), the same handler hosted
// g1t's Cron Triggers run.
//
// Which services, and their crons, are in schedules.json, written by
// configs.mjs from each service's wrangler.jsonc (`triggers.crons`), for
// the services whose crons are safe to run here (SELF_HOST_CRONS there).
// Wrangler's local API answers only requests addressed to localhost, so
// this runs inside the g1t container, beside it (start.sh).
//
// Usage: node scheduler.mjs <schedules.json> [base URL, default http://127.0.0.1:8787]

import { readFileSync } from "node:fs";

const FIELDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of the month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of the week, 0 and 7 both Sunday
];

/** The values one cron field allows, or null when it is malformed. */
export function fieldValues(text, { min, max }) {
  const values = new Set();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let from;
    let to;
    if (range === "*") {
      [from, to] = [min, max];
    } else if (range.includes("-")) {
      [from, to] = range.split("-").map(Number);
    } else {
      from = Number(range);
      to = stepText === undefined ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/** Whether a five-field cron expression matches `date` (UTC, to the minute). */
export function matches(cron, date) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const sets = fields.map((field, i) => fieldValues(field, FIELDS[i]));
  if (sets.some((set) => set === null)) return false;
  const [minutes, hours, days, months, weekdays] = sets;
  const weekday = date.getUTCDay();
  const dayMatches = days.has(date.getUTCDate());
  const weekdayMatches = weekdays.has(weekday) || (weekday === 0 && weekdays.has(7));
  // As cron does: when both day fields are restricted, either may match.
  const day =
    fields[2] !== "*" && fields[4] !== "*" ? dayMatches || weekdayMatches : dayMatches && weekdayMatches;
  return minutes.has(date.getUTCMinutes()) && hours.has(date.getUTCHours()) && months.has(date.getUTCMonth() + 1) && day;
}

/** The handlers due at `date`: `{ worker, cron }` for each cron that matches. */
export function due(schedules, date) {
  return schedules.flatMap(({ worker, crons }) => crons.filter((cron) => matches(cron, date)).map((cron) => ({ worker, cron })));
}

async function run(base, { worker, cron }) {
  try {
    const answer = await fetch(`${base}/cdn-cgi/local/explorer/api/local/scheduled?worker=${encodeURIComponent(worker)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cron }),
    });
    const body = await answer.json().catch(() => ({}));
    if (!answer.ok || !body.success || body.result?.outcome !== "ok") {
      console.error(`scheduler: ${worker} (${cron}): ${answer.status} ${JSON.stringify(body.errors ?? body.result ?? body)}`);
    }
  } catch (error) {
    console.error(`scheduler: ${worker} (${cron}) could not be run: ${error.message}`);
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("deploy/self-host/scheduler.mjs")) {
  const schedules = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const base = (process.argv[3] ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  console.log(`scheduler: ${schedules.map((s) => `${s.worker} ${s.crons.join(", ")}`).join("; ")}`);
  const tick = () => {
    const now = new Date();
    for (const job of due(schedules, now)) run(base, job);
    // The next whole minute, a second in.
    setTimeout(tick, 60_000 - (now.getTime() % 60_000) + 1_000);
  };
  setTimeout(tick, 60_000 - (Date.now() % 60_000) + 1_000);
}
