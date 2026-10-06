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

import { type Streak, autoDismissText, deployChange, detect, settleDrafts } from "./detect.ts";
import { stamp } from "./postmortem.ts";
import {
  autoDismiss,
  createIncident,
  incidentDetail,
  loadDeploy,
  loadStreaks,
  openRefs,
  saveDeploy,
  saveHealthy,
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
  // 03:13 and 03:14 slow, then fine: never three in a row.
  assert.equal((await round(db, at(3, 13), "degraded")).draft.length, 0);
  assert.equal((await round(db, at(3, 14), "degraded")).draft.length, 0);
  await round(db, at(3, 15), "up");
  assert.equal((await loadStreaks(db)).size, 0, "a recovery with nothing else failing leaves no run behind");
  // 07:25 slow: the first check of a new run, not the third of the old one.
  const first = await round(db, at(7, 25), "degraded");
  assert.equal(first.draft.length, 0);
  assert.deepEqual([...(await loadStreaks(db)).values()], [{ component: "git", state: "degraded", count: 1, since: at(7, 25).toISOString(), alerted: false }]);
  await round(db, at(7, 26), "degraded");
  const third = await round(db, at(7, 27), "degraded");
  assert.deepEqual(third.draft, [{ key: "git", state: "degraded", since: at(7, 25).toISOString(), checks: 3 }]);
});

test("a run is kept while it lasts, and only the parts still failing keep one", async () => {
  const db = d1();
  const streak = (component: string): Streak => ({ component, state: "down", count: 2, since: at(1, 0).toISOString(), alerted: false });
  await saveStreaks(db, [streak("git"), streak("api")]);
  await saveStreaks(db, [streak("api")]);
  assert.deepEqual([...(await loadStreaks(db)).keys()], ["api"]);
  await saveStreaks(db, []);
  assert.equal((await loadStreaks(db)).size, 0);
});

test("the deploy window is kept between rounds", async () => {
  const db = d1();
  assert.equal(await loadDeploy(db), null);
  await saveDeploy(db, deployChange(null, "started", "run-1", at(7, 20)));
  await saveDeploy(db, deployChange(await loadDeploy(db), "finished", null, at(7, 24)));
  assert.deepEqual(await loadDeploy(db), { id: "run-1", started_at: at(7, 20).toISOString(), finished_at: at(7, 24).toISOString() });
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
