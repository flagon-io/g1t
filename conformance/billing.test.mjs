import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Execute production SQL against the complete migrated schema. These verify
// transaction/retry contracts; Stripe HTTP and Worker execution need staging.
const source = (name) => readFileSync(new URL(`../services/billing/src/${name}.rs`, import.meta.url), "utf8");
const constant = (file, name) => {
  const match = source(file).match(new RegExp(`const ${name}: &str = "([\\s\\S]*?)";`));
  assert.ok(match, `${file}::${name}`);
  return match[1];
};
const prepares = (file, from, to) => {
  const text = source(file).split(from)[1].split(to)[0];
  return [...text.matchAll(/\.prepare\(\s*"([\s\S]*?)"\s*,?\s*\)/g)].map((m) => m[1]);
};
function database() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../services/billing/migrations/", import.meta.url);
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(new URL(name, dir), "utf8"));
  return db;
}
const at = "2026-10-14T12:00:00Z";
test("late enterprise overdue writes cannot reopen terminal invoices or pause paid workspaces", () => {
  const db = database();
  db.prepare("INSERT INTO accounts(workspace,balance_micros,created_at) VALUES ('fixture',0,?)").run(at);
  db.prepare(
    "INSERT INTO enterprise_invoices(invoice_id,account_id,period,amount_micros,status,created_by,created_at) VALUES ('in_fixture','ent_fixture','now',10000000,'open','staff',?)",
  ).run(at);
  const update = db.prepare(constant("webhooks", "ENTERPRISE_STATUS"));
  const stop = db.prepare(constant("webhooks", "ENTERPRISE_OVERDUE_STOP"));
  update.get("overdue", "in_fixture");
  stop.run("fixture", at, "overdue", "in_fixture");
  assert.equal(db.prepare("SELECT autopay_error FROM limits WHERE workspace='fixture'").get().autopay_error, "overdue");
  batch(db, [
    ["UPDATE enterprise_invoices SET status='paid' WHERE invoice_id='in_fixture'", []],
    [constant("lib", "CLEAR_STOP"), ["fixture"]],
  ]);
  assert.equal(update.get("overdue", "in_fixture"), undefined);
  stop.run("fixture", at, "late overdue", "in_fixture");
  assert.equal(db.prepare("SELECT autopay_error FROM limits WHERE workspace='fixture'").get().autopay_error, null);
  db.exec("UPDATE enterprise_invoices SET status='void'");
  assert.equal(update.get("overdue", "in_fixture"), undefined);
  stop.run("fixture", at, "late overdue", "in_fixture");
  assert.equal(db.prepare("SELECT autopay_error FROM limits WHERE workspace='fixture'").get().autopay_error, null);
});
test("enterprise invoice acquisition freezes one payload and rejects stale balances after completion", () => {
  const db = database();
  db.prepare("INSERT INTO accounts(workspace,balance_micros,created_at) VALUES ('fixture',-10000000,?)").run(at);
  db.prepare("INSERT INTO account_members(workspace,account_id,added_by,added_at) VALUES ('fixture','ent_fixture','staff',?)").run(at);
  const snapshots = JSON.stringify([{ workspace: "fixture", balance: -10000000, invoiced: 0 }]);
  const acquire = db.prepare(constant("enterprise_attempt", "INSERT"));
  const payload = JSON.stringify({ lines: [{ workspace: "fixture", amountMicros: 10000000 }] });
  acquire.run("ent_fixture", "first", payload, 1, snapshots);
  acquire.run("ent_fixture", "second", '{"amount":20000000}', 2, snapshots);
  assert.deepEqual({ ...db.prepare("SELECT id,payload FROM enterprise_invoice_attempts").get() }, { id: "first", payload });
  assert.throws(() => db.exec("UPDATE account_members SET account_id='ent_other' WHERE workspace='fixture'"), /pending enterprise invoice/);
  assert.throws(() => db.exec("DELETE FROM account_members WHERE workspace='fixture'"), /pending enterprise invoice/);
  db.prepare(
    "INSERT INTO enterprise_invoices(invoice_id,account_id,period,amount_micros,status,created_by,created_at) VALUES ('in_first','ent_fixture','now',10000000,'open','staff',?)",
  ).run(at);
  db.exec("INSERT INTO enterprise_invoice_lines VALUES ('in_first','fixture',10000000); UPDATE enterprise_invoice_attempts SET completed=1");
  db.prepare(constant("enterprise_attempt", "RETIRE")).run("ent_fixture");
  acquire.run("ent_fixture", "stale", "{}", 3, snapshots);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM enterprise_invoice_attempts").get().n, 0);
  db.exec("UPDATE accounts SET balance_micros=-15000000 WHERE workspace='fixture'");
  const fresh = JSON.stringify([{ workspace: "fixture", balance: -15000000, invoiced: 10000000 }]);
  acquire.run("ent_fixture", "additional", '{"amount":5000000}', 4, fresh);
  assert.equal(db.prepare("SELECT id FROM enterprise_invoice_attempts").get().id, "additional");
});
test("a late enterprise invoice writer cannot recreate old lines after completion and rename", () => {
  const db = database();
  const writes = prepares("webhooks", "async fn finish_enterprise_attempt(", "/// An enterprise invoice paid:").filter((sql) =>
    sql.startsWith("INSERT INTO enterprise_invoice"),
  );
  assert.equal(writes.length, 2);
  db.prepare("INSERT INTO enterprise_invoice_attempts(account_id,id,payload,created_ms) VALUES ('ent_fixture','attempt','{}',1)").run();
  const invoice = ["in_fixture", "ent_fixture", "now", 10000000, null, "staff", at, "attempt"];
  const line = ["in_fixture", "old", 10000000, "attempt"];
  batch(db, [
    [writes[0], invoice],
    [writes[1], line],
  ]);
  db.exec("UPDATE enterprise_invoice_attempts SET completed=1; UPDATE enterprise_invoice_lines SET workspace='renamed'");
  batch(db, [
    [writes[0], invoice],
    [writes[1], line],
  ]);
  assert.deepEqual(
    db
      .prepare("SELECT workspace FROM enterprise_invoice_lines")
      .all()
      .map((r) => r.workspace),
    ["renamed"],
  );
  db.prepare(constant("enterprise_attempt", "RETIRE")).run("ent_fixture");
  batch(db, [
    [writes[0], invoice],
    [writes[1], line],
  ]);
  assert.equal(db.prepare("SELECT SUM(amount_micros) n FROM enterprise_invoice_lines").get().n, 10000000);
});
test("fee waivers refuse subscriptions that may still charge, including delinquent plans", () => {
  const db = database();
  const insert = db.prepare(
    "INSERT INTO subscriptions (workspace, feature, subscription_id, status, started_by, started_at, updated_at) VALUES (?, 'plan', ?, ?, 'staff', ?, ?)",
  );
  for (const status of ["active", "past_due", "incomplete", "unpaid", "canceled"]) {
    insert.run(status, `sub_${status}`, status, at, at);
    const found = db.prepare(constant("accounts", "FEE_WAIVER_SUBSCRIPTIONS")).get(status);
    assert.equal(Boolean(found), status !== "canceled", status);
  }
  assert.equal(db.prepare(constant("accounts", "FEE_WAIVER_SUBSCRIPTIONS")).get("new-workspace"), undefined);
});
test("demo detach finds all sources through bounded compound selects", () => {
  const db = database();
  db.prepare("INSERT INTO accounts (workspace,balance_micros,created_at) VALUES ('demo',8000000,?)").run(at);
  db.prepare("INSERT INTO allowance_use (kind,scope,month,used) VALUES ('plan_credit','allowance-only','2026-10',500)").run();
  const sql = constant("detach", "FOUND").replace("{internal}", constant("sales", "INTERNAL_SQL"));
  const rows = db.prepare(sql).all(null, "2026-10");
  assert.deepEqual(
    rows.map((r) => r.workspace),
    ["allowance-only", "demo"],
  );
  assert.equal(rows[0].plan_credit, 500);
  assert.equal(rows[1].balance, 8000000);
  assert.deepEqual(
    db
      .prepare(sql)
      .all("demo", "2026-10")
      .map((r) => r.workspace),
    ["demo"],
  );
  // D1 rejects the former long UNION. Each candidate CTE stays small.
  for (const cte of sql.split("AS MATERIALIZED (").slice(1)) {
    assert.ok((cte.split(")")[0].match(/UNION/g) ?? []).length <= 3);
  }
});
function batch(db, writes) {
  db.exec("BEGIN");
  try {
    for (const [sql, args] of writes) db.prepare(sql).run(...args);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
const entries = prepares("lib", "pub(crate) fn entry_statements(", "/// What follows an entry");
const stops = prepares("lib", "fn after_entry_statements(", "async fn account(");
const extras = prepares("tax", "pub(crate) fn extras_statements(", "/// A payment's tax and fee");
function payment(reference, amount = 25_000_000) {
  assert.equal(entries.length, 2);
  assert.equal(stops.length, 1);
  assert.equal(extras.length, 1);
  return [
    [entries[0], [reference, "fixture", "top_up", amount, "Paid in advance", null, reference, null, at]],
    [entries[1], ["fixture", amount, "cus_fixture", at]],
    [stops[0], ["fixture", amount]],
    [constant("lib", "CLEAR_STOP"), ["fixture"]],
    [extras[0], [`${reference}/tax`, "fixture", "tax", 2_000_000, reference, "pi_fixture", null, at]],
  ];
}
test("payment, balance, dispute repayment and tax commit once together", () => {
  const db = database();
  db.prepare("INSERT INTO limits (workspace, updated_at, dispute_owed_micros, autopay_failed_at) VALUES (?, ?, ?, ?)").run("fixture", at, 30_000_000, at);
  batch(db, payment("cs_fixture"));
  assert.equal(db.prepare("SELECT balance_micros FROM accounts WHERE workspace='fixture'").get().balance_micros, 25_000_000);
  assert.equal(db.prepare("SELECT dispute_owed_micros FROM limits WHERE workspace='fixture'").get().dispute_owed_micros, 5_000_000);
  assert.throws(() => batch(db, payment("cs_fixture")), /UNIQUE/);
  assert.equal(db.prepare("SELECT dispute_owed_micros FROM limits WHERE workspace='fixture'").get().dispute_owed_micros, 5_000_000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tax_and_fees").get().n, 1);
  batch(db, payment("cs_second", 5_000_000));
  assert.equal(db.prepare("SELECT autopay_failed_at FROM limits WHERE workspace='fixture'").get().autopay_failed_at, null);
  db.close();
});
test("a failure writing tax rolls back the credit and payment-stop updates", () => {
  const db = database();
  db.prepare("INSERT INTO limits (workspace, updated_at, dispute_owed_micros, autopay_failed_at) VALUES (?, ?, ?, ?)").run("fixture", at, 25_000_000, at);
  db.exec("CREATE TRIGGER fail_tax BEFORE INSERT ON tax_and_fees BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => batch(db, payment("cs_fixture")), /injected failure/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM accounts WHERE workspace='fixture'").get().n, 0);
  assert.equal(db.prepare("SELECT dispute_owed_micros FROM limits WHERE workspace='fixture'").get().dispute_owed_micros, 25_000_000);
  db.exec("DROP TRIGGER fail_tax");
  batch(db, payment("cs_fixture"));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tax_and_fees").get().n, 1);
  db.close();
});
test("payment never clears an open dispute", () => {
  const db = database();
  db.prepare("INSERT INTO limits (workspace, updated_at, autopay_failed_at) VALUES (?, ?, ?)").run("fixture", at, at);
  db.prepare("INSERT INTO disputes (dispute_id, workspace, charge_id, status, updated_at) VALUES ('dp_fixture', 'fixture', 'ch_fixture', 'open', ?)").run(at);
  batch(db, payment("cs_fixture"));
  assert.equal(db.prepare("SELECT autopay_failed_at FROM limits WHERE workspace='fixture'").get().autopay_failed_at, at);
  db.close();
});
test("concurrent invoice requests freeze one payload even as usage changes", () => {
  const db = database();
  db.prepare("INSERT INTO accounts (workspace, balance_micros, created_at) VALUES ('fixture', -10000000, ?)").run(at);
  const insert = db.prepare(constant("invoice_attempt", "INSERT"));
  insert.run("attempt_a", "fixture", '{"amount":1000}', 1000, -10_000_000);
  db.exec("UPDATE accounts SET balance_micros=-20000000 WHERE workspace='fixture'");
  insert.run("attempt_b", "fixture", '{"amount":2000}', 2000, -20_000_000);
  assert.deepEqual({ ...db.prepare("SELECT id, payload FROM invoice_attempts").get() }, { id: "attempt_a", payload: '{"amount":1000}' });
  assert.equal(db.prepare(constant("invoice_attempt", "RETIRE")).run("fixture").changes, 0);
  assert.equal(db.prepare(constant("closing", "UNPAID_INVOICES_SQL")).get("fixture").n, 1);
  db.close();
});
test("a stale invoice calculation cannot create an attempt after payment changes the balance", () => {
  const db = database();
  db.prepare("INSERT INTO accounts (workspace, balance_micros, created_at) VALUES ('fixture', 0, ?)").run(at);
  const result = db.prepare(constant("invoice_attempt", "INSERT")).run("attempt_a", "fixture", "{}", 1000, -10_000_000);
  assert.equal(result.changes, 0);
  db.close();
});
test("the migration registry covers every billing migration", () => {
  const dir = new URL("../services/billing/migrations/", import.meta.url);
  const lib = source("lib");
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".sql"))) assert.ok(lib.includes(`include_str!("../migrations/${name}")`), name);
});

const sqlFile = (name) => readFileSync(new URL(`../services/billing/src/${name}.sql`, import.meta.url), "utf8");
function refund(db, cents, tax, plan = false) {
  const reference = `refund/ch_fixture/${cents + tax}`;
  const writes = [[sqlFile(plan ? "refund_plan" : "refund_ledger"), [reference, "fixture", cents * 10_000, reference, at, "refund/ch_fixture/%"]]];
  if (!plan) writes.push([constant("webhooks", "REFUND_BALANCE"), [reference, "fixture"]]);
  writes.push([sqlFile("refund_extras"), [`${reference}/tax`, "fixture", "tax", tax * 10_000, reference, "pi_fixture", at, "refund/ch_fixture/%"]]);
  batch(db, writes);
}
test("partial refunds, duplicate deliveries and reversed ordering debit only the cumulative total", () => {
  for (const order of [
    [1000, 2500, 2500],
    [2500, 1000, 2500],
  ]) {
    const db = database();
    batch(db, payment("cs_fixture"));
    for (const cents of order) refund(db, cents, cents * 0.08);
    assert.equal(db.prepare("SELECT balance_micros FROM accounts WHERE workspace='fixture'").get().balance_micros, 0);
    assert.equal(db.prepare("SELECT SUM(amount_micros) n FROM tax_and_fees WHERE workspace='fixture'").get().n, 0);
    db.close();
  }
});
test("refund tax failure rolls back the reversal and retries without a second debit", () => {
  const db = database();
  batch(db, payment("cs_fixture"));
  db.exec("CREATE TRIGGER fail_refund_tax BEFORE INSERT ON tax_and_fees WHEN NEW.amount_micros < 0 BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => refund(db, 2500, 200), /injected failure/);
  assert.equal(db.prepare("SELECT balance_micros FROM accounts WHERE workspace='fixture'").get().balance_micros, 25_000_000);
  db.exec("DROP TRIGGER fail_refund_tax");
  refund(db, 2500, 200);
  refund(db, 2500, 200);
  assert.equal(db.prepare("SELECT balance_micros FROM accounts WHERE workspace='fixture'").get().balance_micros, 0);
  db.close();
});
test("plan refunds reduce revenue without debiting prepaid usage credit", () => {
  const db = database();
  batch(db, payment("cs_fixture"));
  refund(db, 1000, 80, true);
  refund(db, 2500, 200, true);
  refund(db, 1000, 80, true);
  assert.equal(db.prepare("SELECT SUM(amount_micros) n FROM plan_payments WHERE workspace='fixture'").get().n, -25_000_000);
  assert.equal(db.prepare("SELECT balance_micros FROM accounts WHERE workspace='fixture'").get().balance_micros, 25_000_000);
  db.close();
});

test("one card cannot fund concurrent trials or another trial after being replaced", () => {
  const db = database();
  const grantSql = prepares("credits", "pub(crate) async fn ensure_grant(", "/// Takes up to")[0];
  const card = db.prepare(
    "INSERT INTO card_checks (workspace, setup_intent, payment_method, fingerprint, funding, checked_by, checked_at) VALUES (?, ?, ?, ?, 'credit', 'fixture', ?)",
  );
  card.run("trial_a", "seti_a", "pm_a", "same_card", at);
  card.run("trial_b", "seti_b", "pm_b", "same_card", at);
  const grant = db.prepare(grantSql);
  grant.run("trial_a", "2026-10", 5_000_000, at, 100_000_000);
  grant.run("trial_b", "2026-10", 5_000_000, at, 100_000_000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM trial_grants WHERE workspace IN ('trial_a','trial_b')").get().n, 1);
  db.exec("UPDATE card_checks SET fingerprint='replacement_card' WHERE workspace='trial_a'");
  grant.run("trial_b", "2026-10", 5_000_000, at, 100_000_000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM trial_grants WHERE workspace='trial_b'").get().n, 0);
  db.close();
});

function usage(id, reference, workspace, gross, { plan = 10_000_000, trial = 1, pool = 1_000_000, repo = 1_000_000, given = 0, when = at } = {}) {
  const insert = prepares("storage", "pub(crate) async fn post_usage_with(", "/// Takes `charged`")[0];
  const balance = prepares("storage", "pub(crate) fn balance_if_posted(", "/// Writes down")[0];
  const month = when.slice(0, 7);
  return [
    [insert, [id, workspace, -gross, "Usage", `${workspace}/repo`, "sandbox", gross, reference, when, 0, 0, 0, 0, null]],
    [sqlFile("allocate_usage"), [id, workspace, month, plan, trial, `${workspace}/repo`, pool, repo, given]],
    [constant("allocation", "PLAN"), [id, month]],
    [constant("allocation", "GIFT"), [id, month]],
    [constant("allocation", "TRIAL"), [id]],
    [constant("allocation", "OSS_POOL"), [id, month]],
    [constant("allocation", "OSS_REPO"), [id, month, `${workspace}/repo`]],
    [balance, [workspace, at, id]],
  ];
}
test("usage allocation, source debits and ledger posting conserve credit across retries", () => {
  const db = database();
  db.prepare("INSERT INTO trial_grants (workspace, month, granted_micros, used_micros, created_at) VALUES ('fixture', '2026-10', 1000000, 0, ?)").run(at);
  batch(db, usage("usage_a", "run/a", "fixture", 12_000_000));
  const read = () => ({ ...db.prepare("SELECT amount_micros, credit_micros, trial_micros, oss_micros FROM ledger WHERE id='usage_a'").get() });
  assert.deepEqual(read(), { amount_micros: 0, credit_micros: 10_000_000, trial_micros: 1_000_000, oss_micros: 1_000_000 });
  batch(db, usage("duplicate", "run/a", "fixture", 12_000_000));
  assert.equal(db.prepare("SELECT SUM(used) n FROM allowance_use WHERE kind='plan_credit'").get().n, 10_000_000);
  batch(db, usage("usage_b", "run/b", "fixture", 2_000_000));
  assert.equal(db.prepare("SELECT balance_micros FROM accounts WHERE workspace='fixture'").get().balance_micros, -2_000_000);
  db.close();
});
test("an interrupted usage transaction consumes no allowance and a retry posts once", () => {
  const db = database();
  db.exec("CREATE TRIGGER fail_usage_balance BEFORE INSERT ON accounts WHEN NEW.workspace='fixture' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => batch(db, usage("usage_a", "run/a", "fixture", 5_000_000)), /injected failure/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger WHERE id='usage_a'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM allowance_use WHERE scope='fixture'").get().n, 0);
  db.exec("DROP TRIGGER fail_usage_balance");
  batch(db, usage("usage_b", "run/a", "fixture", 5_000_000));
  assert.equal(db.prepare("SELECT used FROM allowance_use WHERE scope='fixture' AND kind='plan_credit'").get().used, 5_000_000);
  db.close();
});
test("different workspaces share one bounded OSS pool and free overruns remain explicit", () => {
  const db = database();
  batch(db, usage("a", "run/a", "a", 800_000, { plan: 0, trial: 0 }));
  batch(db, usage("b", "run/b", "b", 800_000, { plan: 0, trial: 0, given: 1 }));
  assert.equal(db.prepare("SELECT used FROM allowance_use WHERE kind='oss_pool'").get().used, 1_000_000);
  assert.deepEqual(
    { ...db.prepare("SELECT amount_micros, oss_micros, given_micros FROM ledger WHERE id='b'").get() },
    { amount_micros: 0, oss_micros: 200_000, given_micros: 600_000 },
  );
  db.close();
});

test("a keyed admin_log line is written once however often it is sent", () => {
  const db = database();
  const once = db.prepare(constant("accounts", "ADMIN_LOG_ONCE"));
  const send = (detail) => once.run("admk_srr_1", "ws_acme", "storage_released", detail, "staff@g1t.sh", at);
  send("Reservation srv_1 on acme/site (rep_1), 320 MB: a test · storage_recoveries srr_1");
  // Its answer was lost, so the repos service sends it again.
  send("Reservation srv_1 on acme/site (rep_1), 320 MB: a test · storage_recoveries srr_1");
  const rows = db.prepare("SELECT id, account, action, detail, by FROM admin_actions WHERE id = 'admk_srr_1'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account, "ws_acme");
  assert.equal(rows[0].by, "staff@g1t.sh");
  db.close();
});

test("a key that already holds another kind of change is refused, and its line is left as it was", () => {
  const db = database();
  const once = db.prepare(constant("accounts", "ADMIN_LOG_ONCE"));
  const kept = db.prepare(constant("accounts", "ADMIN_LOG_KEPT"));
  once.run("admk_srr_2", "ws_acme", "storage_released", "the release", "staff@g1t.sh", at);
  assert.ok(kept.get("admk_srr_2", "storage_released"), "the same kind of change: written, or already there");
  once.run("admk_srr_2", "ws_acme", "workspace_restored", "another change", "staff@g1t.sh", at);
  assert.equal(kept.get("admk_srr_2", "workspace_restored"), undefined, "audit_once refuses it");
  assert.deepEqual(
    db
      .prepare("SELECT action, detail FROM admin_actions WHERE id = 'admk_srr_2'")
      .all()
      .map((row) => [row.action, row.detail]),
    [["storage_released", "the release"]],
  );
  db.close();
});
