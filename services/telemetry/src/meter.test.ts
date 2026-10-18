/**
 * A workspace's meter on Node's SQLite standing in for the Durable
 * Object's: its projects share one day's share, and on the plan the
 * month's total is reported to billing until billing takes it.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { NOTE_AFTER_MS, NOTE_RETRY_MS, WorkspaceMeter, noteAt } from "./meter.ts";

function state() {
  const db = new DatabaseSync(":memory:");
  const box = { alarm: null as number | null };
  const sql = {
    exec(query: string, ...args: unknown[]) {
      if (
        !args.length &&
        query
          .trim()
          .split(";")
          .filter((q) => q.trim()).length > 1
      ) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const rows = db.prepare(query).all(...(args as never[]));
      return { toArray: () => rows };
    },
  };
  const s = {
    storage: {
      sql,
      getAlarm: async () => box.alarm,
      setAlarm: async (t: number) => void (box.alarm = t),
    },
  } as unknown as DurableObjectState;
  return { s, box };
}

const NOW = Date.UTC(2026, 9, 13, 12);

test("a free workspace's projects share one day's share, and a new day starts over", async () => {
  const { s, box } = state();
  const meter = new WorkspaceMeter(s);
  await meter.add("acme", 60, NOW);
  await meter.add("acme", 30, NOW);
  assert.equal(meter.todayBytes(NOW), 90);
  assert.equal(meter.over(10, 100, NOW), false);
  assert.equal(meter.over(11, 100, NOW), true);
  assert.equal(meter.over(1e9, null, NOW), false);
  assert.equal(meter.over(0, 100, NOW + 24 * 3600_000), false);
  // Free: nothing is reported, so no alarm.
  assert.equal(box.alarm, null);
});

test("the plan last said holds; never said, it is unknown", () => {
  const meter = new WorkspaceMeter(state().s);
  assert.equal(meter.standing(), null);
  meter.setStanding("paid");
  assert.equal(meter.standing(), "paid");
  meter.setStanding("held");
  assert.equal(meter.standing(), "held");
});

test("on the plan, the month's total is reported, again when billing did not take it, and once it has, not again", async () => {
  const { s, box } = state();
  const meter = new WorkspaceMeter(s);
  meter.setStanding("paid");
  await meter.add("acme", 500, NOW);
  assert.equal(box.alarm, NOW + NOTE_AFTER_MS);
  const sent: [string, string, number][] = [];
  let up = false;
  const send = async (workspace: string, month: string, bytes: number) => {
    sent.push([workspace, month, bytes]);
    if (!up) throw new Error("billing answered 503");
    return true;
  };
  box.alarm = null;
  await meter.note(send, NOW);
  assert.equal(box.alarm, NOW + NOTE_RETRY_MS, "tried again later");
  up = true;
  box.alarm = null;
  await meter.note(send, NOW);
  await meter.note(send, NOW);
  assert.deepEqual(sent, [
    ["acme", "2026-10", 500],
    ["acme", "2026-10", 500],
  ]);
  assert.equal(box.alarm, null);
  // More arrives: the new total.
  await meter.add("acme", 100, NOW);
  await meter.note(send, NOW);
  assert.deepEqual(sent.at(-1), ["acme", "2026-10", 600]);
});

test("the last report of a month goes before it ends", () => {
  const end = Date.UTC(2026, 10, 1);
  assert.equal(noteAt(end - 2 * 60_000), end - 60_000);
  assert.equal(noteAt(NOW), NOW + NOTE_AFTER_MS);
});

test("a month's last bytes are reported under that month after it ends; older months are not", async () => {
  const { s, box } = state();
  const meter = new WorkspaceMeter(s);
  meter.setStanding("paid");
  const end = Date.UTC(2026, 10, 1);
  await meter.add("acme", 800, Date.UTC(2026, 8, 20));
  await meter.add("acme", 700, end - 30_000);
  const sent: [string, string, number][] = [];
  const send = async (workspace: string, month: string, bytes: number) => {
    sent.push([workspace, month, bytes]);
    return true;
  };
  box.alarm = null;
  // The alarm fires after the month is over: October's total goes as
  // October's, September's (two months back) is left as it was.
  await meter.note(send, end + 60_000);
  assert.deepEqual(sent, [["acme", "2026-10", 700]]);
  await meter.add("acme", 5, end + 120_000);
  await meter.note(send, end + 180_000);
  assert.deepEqual(sent.at(-1), ["acme", "2026-11", 5]);
  assert.equal(sent.length, 2);
});
