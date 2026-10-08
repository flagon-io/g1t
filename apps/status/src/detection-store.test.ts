/**
 * Detection through the database, as the cron runs it: streaks saved and
 * read back each round, deploy windows, and recovered drafts dismissed.
 * D1 here is SQLite (node:sqlite) behind the few D1 calls the store makes,
 * with the real migrations applied.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { type Streak, autoDismissText, deployChange, detect, settleDrafts, staleDrafts, staleText } from "./detect.ts";
import { stamp } from "./postmortem.ts";
import {
  CHECK_HISTORY_DAYS,
  autoDismiss,
  checkHistory,
  createIncident,
  historySpan,
  incidentDetail,
  loadDeploy,
  loadStreaks,
  openRefs,
  record,
  saveDeploy,
  saveHealthy,
  saveReminders,
  saveStreaks,
  watchedDrafts,
} from "./store.ts";

type Params = (string | number | null)[];

/** Just enough of D1 over SQLite for the store. */
function d1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  class Statement {
    constructor(
      readonly sql: string,
      readonly params: Params = [],
    ) {}
    bind(...params: Params) {
      return new Statement(this.sql, params);
    }
    async all() {
      return { results: db.prepare(this.sql).all(...this.params), success: true, meta: {} };
    }
    async first() {
      return db.prepare(this.sql).get(...this.params) ?? null;
    }
    async run() {
      const r = db.prepare(this.sql).run(...this.params);
      return { results: [], success: true, meta: { changes: Number(r.changes) } };
    }
  }
  return {
    prepare: (sql: string) => new Statement(sql),
    batch: async (list: Statement[]) => {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(/^\s*SELECT/i.test(s.sql) ? await s.all() : await s.run());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

const at = (h: number, m: number) => new Date(Date.UTC(2026, 9, 6, h, m, 32));

/** One cron round's detection against the database; returns what it found. */
async function round(db: D1Database, now: Date, git: "up" | "degraded" | "down", quiet = false) {
  const found = detect(await loadStreaks(db), [{ component: "git", state: git }, { component: "api", state: "up" }], await openRefs(db), new Set(), now, { quiet });
  await saveStreaks(db, found.streaks);
  return found;
}

test("the 6 Oct draft: a slow run at 03:13 that recovered does not leak into the one at 07:25", async () => {
  const db = d1();
  // 03:13 and 03:14 slow, then fine: never four of five.
  assert.equal((await round(db, at(3, 13), "degraded")).draft.length, 0);
  assert.equal((await round(db, at(3, 14), "degraded")).draft.length, 0);
  await round(db, at(3, 15), "up");
  assert.equal((await loadStreaks(db)).size, 1, "one good check does not end a run");
  await round(db, at(3, 16), "up");
  await round(db, at(3, 17), "up");
  assert.equal((await loadStreaks(db)).size, 0, "three good checks in a row, with nothing else failing, leave no run behind");
  // 07:25 slow: the first check of a new run, not the third of the old one.
  const first = await round(db, at(7, 25), "degraded");
  assert.equal(first.draft.length, 0);
  assert.deepEqual([...(await loadStreaks(db)).values()], [{ component: "git", state: "degraded", count: 1, checks: 1, recent: "s", since: at(7, 25).toISOString(), alerted: false }]);
  await round(db, at(7, 26), "degraded");
  await round(db, at(7, 27), "degraded");
  const fourth = await round(db, at(7, 28), "degraded");
  assert.deepEqual(fourth.draft, [{ key: "git", state: "degraded", since: at(7, 25).toISOString(), checks: 4, of: 4 }]);
});

test("a run kept before N of M (no checks, no recent) is read as all bad, and still ends", async () => {
  const db = d1();
  await db.prepare(`INSERT INTO streak (component, state, count, since, alerted) VALUES ('git', 'degraded', 180, ?1, 1)`).bind(at(4, 0).toISOString()).run();
  assert.deepEqual((await loadStreaks(db)).get("git"), { component: "git", state: "degraded", count: 180, checks: 180, recent: "sssss", since: at(4, 0).toISOString(), alerted: true });
  await round(db, at(7, 0), "up");
  await round(db, at(7, 1), "up");
  assert.equal((await loadStreaks(db)).size, 1);
  await round(db, at(7, 2), "up");
  assert.equal((await loadStreaks(db)).size, 0);
});

test("a run is kept while it lasts, and only the parts still failing keep one", async () => {
  const db = d1();
  const streak = (component: string): Streak => ({ component, state: "down", count: 2, checks: 3, recent: "x.x", since: at(1, 0).toISOString(), alerted: false });
  await saveStreaks(db, [streak("git"), streak("api")]);
  await saveStreaks(db, [streak("api")]);
  assert.deepEqual([...(await loadStreaks(db)).keys()], ["api"]);
  assert.deepEqual((await loadStreaks(db)).get("api"), streak("api"));
  await saveStreaks(db, []);
  assert.equal((await loadStreaks(db)).size, 0);
});

test("the deploy window is kept between rounds", async () => {
  const db = d1();
  assert.equal(await loadDeploy(db), null);
  await saveDeploy(db, deployChange(null, "started", "run-1", at(7, 20)));
  await saveDeploy(db, deployChange(await loadDeploy(db), "finished", null, at(7, 24)));
  assert.deepEqual(await loadDeploy(db), { id: "run-1", started_at: at(7, 20).toISOString(), finished_at: at(7, 24).toISOString(), running: 0, last_started_at: at(7, 20).toISOString() });
  // A window kept before deploys were counted reads as one deploy.
  await db.prepare(`UPDATE meta SET value = ?1 WHERE key = 'deploy'`).bind(JSON.stringify({ id: "old", started_at: at(8, 0).toISOString(), finished_at: null })).run();
  assert.deepEqual(await loadDeploy(db), { id: "old", started_at: at(8, 0).toISOString(), finished_at: null, running: 1, last_started_at: at(8, 0).toISOString() });
});

test("every check is kept for 7 days, with where it ran from, and an incident's page reads its parts' checks", async () => {
  const db = d1();
  const minute = (m: number) => new Date(at(7, 0).getTime() + m * 60_000);
  for (let m = 0; m < 5; m++) {
    await record(
      db,
      [
        { component: "speed", state: m < 3 ? "degraded" : "up", detail: "", latency_ms: m < 3 ? 1900 : 300, colo: "IAD", first_ms: m < 3 ? 2400 : null },
        { component: "api", state: "up", detail: "", latency_ms: 90, colo: "IAD" },
        { component: "sandboxes", state: "unmonitored", detail: "", latency_ms: null },
      ],
      minute(m),
    );
  }
  const kept = await checkHistory(db, ["speed"], minute(0), minute(4));
  assert.equal(kept.length, 5);
  assert.deepEqual(kept[0], { component: "speed", at: minute(0).toISOString(), ms: 1900, outcome: "degraded", colo: "IAD", first_ms: 2400 });
  assert.deepEqual(kept[4], { component: "speed", at: minute(4).toISOString(), ms: 300, outcome: "up", colo: "IAD", first_ms: null });
  assert.equal((await checkHistory(db, ["sandboxes"], minute(0), minute(4))).length, 0, "a part with no check keeps no history");
  // A round 7 days later prunes everything older.
  await record(db, [{ component: "api", state: "up", detail: "", latency_ms: 80, colo: "SJC" }], new Date(minute(2).getTime() + CHECK_HISTORY_DAYS * 86_400_000));
  const left = await checkHistory(db, ["speed", "api"], minute(0), new Date(minute(0).getTime() + 8 * 86_400_000));
  assert.deepEqual(left.map((c) => `${c.component}@${c.colo}`), ["api@IAD", "speed@IAD", "api@IAD", "speed@IAD", "api@IAD", "speed@IAD", "api@SJC"], "the two oldest rounds are gone");

  // The incident page: its parts' checks around it, with the slow line.
  const id = await createIncident(
    db,
    {
      title: "Detected: Page speed slow",
      severity: "sev3",
      status: "investigating",
      visibility: "draft",
      source: "detected",
      components: [{ key: "speed", impact: "degraded" }],
      started_at: minute(0).toISOString(),
      acknowledged_at: null,
      commander: null,
      communications: null,
      by: "status",
    },
    [{ kind: "detected", public: false, status: null, text: "Detected." }],
    minute(4),
    null,
  );
  const detail = (await incidentDetail(db, id, "https://status.g1t.sh", new Map(), { limits: new Map([["speed", 800]]), now: minute(5) }))!;
  assert.equal(detail.checks.length, 1);
  assert.deepEqual([detail.checks[0]!.key, detail.checks[0]!.slow_ms, detail.checks[0]!.samples.length], ["speed", 800, 3]);
  assert.deepEqual(historySpan(minute(0).toISOString(), null, minute(5)), { from: minute(-30), to: minute(5) });
  assert.deepEqual(historySpan(minute(0).toISOString(), minute(10).toISOString(), minute(500)), { from: minute(-30), to: minute(40) });
  // A long one shows its last day.
  assert.deepEqual(historySpan(minute(0).toISOString(), minute(3000).toISOString(), minute(4000)), { from: minute(3030 - 1440), to: minute(3030) });
});

test("a draft left waiting is raised again, with a line on its timeline, and forgotten once it is not waiting", async () => {
  const db = d1();
  const id = await createIncident(
    db,
    {
      title: "Detected: Page speed slow",
      severity: "sev3",
      status: "investigating",
      visibility: "draft",
      source: "detected",
      components: [{ key: "speed", impact: "degraded" }],
      started_at: at(7, 0).toISOString(),
      acknowledged_at: null,
      commander: null,
      communications: null,
      by: "status",
    },
    [{ kind: "detected", public: false, status: null, text: "Detected." }],
    at(7, 4),
    null,
  );
  const tick = async (now: Date) => {
    const waiting = await watchedDrafts(db);
    const due = staleDrafts(waiting, now);
    await saveReminders(db, waiting.map((d) => d.id), due.map((d) => ({ id: d.id, text: staleText(d.waiting_ms, true) })), now);
    return due.map((d) => d.id);
  };
  assert.deepEqual(await tick(at(7, 48)), []);
  assert.deepEqual(await tick(at(7, 49)), [id], "45 minutes after the draft was made");
  assert.equal((await watchedDrafts(db))[0]!.reminded_at, at(7, 49).toISOString());
  assert.deepEqual(await tick(at(7, 50)), [], "once");
  assert.deepEqual(await tick(at(13, 48)), []);
  assert.deepEqual(await tick(at(13, 49)), [id], "then every 6 hours");
  const detail = (await incidentDetail(db, id, "https://status.g1t.sh", new Map()))!;
  assert.deepEqual(detail.timeline.filter((e) => e.kind === "note").map((e) => [e.by, e.text]), [
    ["status", "Unacknowledged for 45 minutes. The alert address was emailed again."],
    ["status", "Unacknowledged for 6h 45m. The alert address was emailed again."],
  ]);
  assert.equal(detail.acknowledged_at, null, "a reminder is not an acknowledgement");
  // Picked up: no longer watched, and its bookkeeping goes.
  await db.prepare(`UPDATE incident SET acknowledged_at = ?1 WHERE id = ?2`).bind(at(14, 0).toISOString(), id).run();
  assert.deepEqual(await tick(at(20, 0)), []);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'draft_reminded:%'`).first<{ n: number }>())!.n, 0);
});

test("a detected draft that recovered is dismissed after ten healthy minutes; one staff picked up is left alone", async () => {
  const db = d1();
  const draft = (title: string, acknowledged: string | null) =>
    createIncident(
      db,
      {
        title,
        severity: "sev3",
        status: "investigating",
        visibility: "draft",
        source: "detected",
        components: [{ key: "git", impact: "degraded" }],
        started_at: at(7, 25).toISOString(),
        acknowledged_at: acknowledged,
        commander: null,
        communications: null,
        by: "status",
      },
      [{ kind: "detected", public: false, status: null, text: "Detected." }],
      at(7, 27),
      null,
    );
  const id = await draft("Detected: Git and repositories slow", null);
  const picked = await draft("Detected: Git and repositories slow (picked up)", at(7, 28).toISOString());

  const tick = async (now: Date, troubled: string[]) => {
    const settled = settleDrafts(await watchedDrafts(db), new Set(troubled), now);
    await saveHealthy(db, settled.healthy);
    const dismissed: string[] = [];
    for (const d of settled.dismiss) if (await autoDismiss(db, d.id, d.recovered_at, autoDismissText(d.lasted_ms, stamp(d.recovered_at)), now)) dismissed.push(d.id);
    return dismissed;
  };
  assert.deepEqual((await watchedDrafts(db)).map((d) => d.id), [id], "only untouched drafts are watched");
  await tick(at(7, 28), ["git"]);
  assert.deepEqual(await tick(at(7, 29), []), []);
  assert.deepEqual(await tick(at(7, 38), []), []);
  assert.deepEqual(await tick(at(7, 39), []), [id]);

  const detail = (await incidentDetail(db, id, "https://status.g1t.sh", new Map([["git", "Git and repositories"]])))!;
  assert.equal(detail.visibility, "dismissed");
  assert.equal(detail.status, "resolved");
  assert.equal(detail.resolved_at, at(7, 29).toISOString(), "resolved when it recovered, not when it was dismissed");
  assert.equal(detail.durations.to_resolve, 4 * 60);
  assert.equal(
    detail.timeline.at(-1)!.text,
    "Recovered after 4 minutes, at 6 Oct 07:29 UTC, and stayed healthy for 10 minutes; dismissed automatically. It never appeared on the status page.",
  );
  assert.equal(detail.timeline.at(-1)!.by, "status");
  assert.equal((await incidentDetail(db, picked, "https://status.g1t.sh", new Map()))!.visibility, "draft");
  // Nothing is left to watch, and the bookkeeping is gone with it.
  assert.deepEqual(await watchedDrafts(db), []);
  assert.equal(await autoDismiss(db, id, at(7, 29).toISOString(), "again", at(7, 40)), false, "dismissing twice changes nothing");
});
