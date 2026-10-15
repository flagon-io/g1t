import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// A month-end source's figure reported after its month was charged or
// closed: the production SQL of `late_correction` (src/storage.rs).
const source = name => readFileSync(new URL(`../services/billing/src/${name}.rs`, import.meta.url), "utf8");
const sqlFile = name => readFileSync(new URL(`../services/billing/src/${name}.sql`, import.meta.url), "utf8");
const constant = (file, name) => {
  const match = source(file).match(new RegExp(`const ${name}: &str = "([\\s\\S]*?)";`));
  assert.ok(match, `${file}::${name}`);
  return match[1];
};
function database() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../services/billing/migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter(n => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, dir), "utf8"));
  return db;
}
function batch(db, writes) {
  db.exec("BEGIN");
  try {
    const rows = writes.map(([sql, args]) => db.prepare(sql).all(...args));
    db.exec("COMMIT");
    return rows;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
const now = "2026-11-03T10:00:00.000Z";
// One late report, as `late_correction` sends it: the raise, the guarded
// ledger line, the allocation and the balance, in one batch.
function late(db, id, workspace, newCost, charge, oldRaw, { plan = 0 } = {}) {
  const raise = constant("storage", "LATE_RAISE");
  const ledger = constant("storage", "LATE_LEDGER");
  const balanceSql = source("storage").split("pub(crate) fn balance_if_posted(")[1].match(/\.prepare\(\s*"([\s\S]*?)"\s*,?\s*\)/)[1];
  const reference = `storage/${workspace}/2026-10/late/${newCost}`;
  const rows = batch(db, [
    [raise, [workspace, "storage", "2026-10", newCost, newCost, now, null, oldRaw]],
    [ledger, [id, workspace, -charge, "Late", "storage", newCost - oldRaw, reference, "2026-10-31T23:59:59Z", null, "2026-10", newCost]],
    [sqlFile("allocate_usage"), [id, workspace, "2026-10", plan, 0, "", 0, 0, 0]],
    [constant("allocation", "PLAN"), [id, "2026-10"]],
    [constant("allocation", "GIFT"), [id, "2026-10"]],
    [balanceSql, [workspace, now, id]],
  ]);
  return rows[1].length === 1;
}
function charged(db, workspace, cost) {
  db.prepare("INSERT INTO pending_usage (workspace, source, month, charge_micros, cost_micros, updated_at, charged_at) VALUES (?, 'storage', '2026-10', ?, ?, ?, ?)")
    .run(workspace, cost, cost, now, now);
}
const owed = (db, workspace) => db.prepare("SELECT balance_micros FROM accounts WHERE workspace=?").get(workspace)?.balance_micros ?? 0;

test("a late higher figure charges only what it adds, once", () => {
  const db = database();
  charged(db, "acme", 5_000_000);
  assert.equal(late(db, "a", "acme", 7_000_000, 2_400_000, 5_000_000), true);
  assert.equal(owed(db, "acme"), -2_400_000);
  assert.equal(db.prepare("SELECT cost_micros FROM pending_usage WHERE workspace='acme'").get().cost_micros, 7_000_000);
  // The same report again: worked out from the new figure, nothing changes.
  assert.equal(late(db, "b", "acme", 7_000_000, 2_400_000, 5_000_000), false);
  assert.equal(owed(db, "acme"), -2_400_000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 1);
  db.close();
});

test("of two late reports worked out from the same figure, only one is charged", () => {
  const db = database();
  charged(db, "acme", 5_000_000);
  assert.equal(late(db, "a", "acme", 8_000_000, 3_600_000, 5_000_000), true);
  // A stale writer that read 5,000,000 before the first moved it.
  assert.equal(late(db, "b", "acme", 6_000_000, 1_200_000, 5_000_000), false);
  assert.equal(owed(db, "acme"), -3_600_000);
  assert.equal(db.prepare("SELECT cost_micros FROM pending_usage WHERE workspace='acme'").get().cost_micros, 8_000_000);
  db.close();
});

test("a closed month with no row yet takes the late figure as a charged row", () => {
  const db = database();
  db.prepare("INSERT INTO month_closes (workspace, month, status, amount_micros, closed_at) VALUES ('acme', '2026-10', 'charged', 0, ?)").run(now);
  // The ordinary report is refused for a closed month…
  db.prepare(constant("storage", "SET_PENDING")).run("acme", "storage", "2026-10", 1, 1, now, null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pending_usage").get().n, 0);
  // …and the late one charges it, and marks the row charged.
  assert.equal(late(db, "a", "acme", 4_000_000, 4_800_000, 0), true);
  assert.equal(owed(db, "acme"), -4_800_000);
  assert.ok(db.prepare("SELECT charged_at FROM pending_usage WHERE workspace='acme'").get().charged_at.startsWith("late: "));
  db.close();
});

test("a late correction draws on that month's allowances first", () => {
  const db = database();
  charged(db, "acme", 1_000_000);
  db.prepare("INSERT INTO allowance_use (kind, scope, month, used) VALUES ('plan_credit', 'acme', '2026-10', 9000000)").run();
  assert.equal(late(db, "a", "acme", 3_000_000, 2_400_000, 1_000_000, { plan: 10_000_000 }), true);
  assert.deepEqual({ ...db.prepare("SELECT amount_micros, credit_micros FROM ledger").get() }, { amount_micros: -1_400_000, credit_micros: 1_000_000 });
  assert.equal(db.prepare("SELECT used FROM allowance_use WHERE kind='plan_credit'").get().used, 10_000_000);
  db.close();
});

test("only a raise is charged: a lower late figure changes nothing", () => {
  const src = source("storage");
  assert.match(src, /pub\(crate\) fn late_delta\(charged_net: i64, new_net: i64\) -> i64 \{\s*\(new_net - charged_net\)\.max\(0\)/);
  assert.match(src, /if new_cost < raw_old \{[\s\S]*?return Ok\(true\);/);
});
