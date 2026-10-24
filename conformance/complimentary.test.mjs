import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// Complimentary enrollment against the complete migrated schema, using the
// production SQL: the allocation that posts usage, and the terms change as
// `admin_set_complimentary` writes it.
const source = (name) => readFileSync(new URL(`../services/billing/src/${name}.rs`, import.meta.url), "utf8");
const sqlFile = (name) => readFileSync(new URL(`../services/billing/src/${name}.sql`, import.meta.url), "utf8");
const constant = (file, name) => {
  const match = source(file).match(new RegExp(`const ${name}: &str =\\s*"([\\s\\S]*?)";`));
  assert.ok(match, `${file}::${name}`);
  return match[1];
};
const prepares = (file, from, to) => {
  const text = source(file).split(from)[1].split(to)[0];
  return [...text.matchAll(/\.prepare\(\s*"([\s\S]*?)"\s*,?\s*\)/g)].map((m) => m[1]);
};
const migrations = new URL("../services/billing/migrations/", import.meta.url);
const names = readdirSync(migrations)
  .filter((n) => n.endsWith(".sql"))
  .sort();
function database(before = null) {
  const db = new DatabaseSync(":memory:");
  for (const name of names.filter((n) => before === null || n < before)) db.exec(readFileSync(new URL(name, migrations), "utf8"));
  return db;
}
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
const at = "2026-10-14T12:00:00.000Z";
function usage(id, reference, workspace, gross, { plan = 10_000_000, trial = 1, given = 0, when = at } = {}) {
  const insert = prepares("storage", "pub(crate) async fn post_usage_with(", "/// Takes `charged`")[0];
  const balance = prepares("storage", "pub(crate) fn balance_if_posted(", "/// Writes down")[0];
  const month = when.slice(0, 7);
  return [
    [insert, [id, workspace, -gross, "Usage", `${workspace}/repo`, "sandbox", gross, reference, when, 0, 0, 0, 0, null]],
    [sqlFile("allocate_usage"), [id, workspace, month, plan, trial, `${workspace}/repo`, 1_000_000, 1_000_000, given]],
    [constant("allocation", "PLAN"), [id, month]],
    [constant("allocation", "GIFT"), [id, month]],
    [constant("allocation", "TRIAL"), [id]],
    [constant("allocation", "OSS_POOL"), [id, month]],
    [constant("allocation", "OSS_REPO"), [id, month, `${workspace}/repo`]],
    [balance, [workspace, when, id]],
  ];
}
const enrolledAt = "2026-10-01T00:00:00.000Z";
function enroll(db, workspace, allowance, { unlimited = 0, overage = "stop" } = {}) {
  db.prepare(
    `INSERT INTO complimentary (workspace, grant_id, status, allowance_micros, unlimited, fee_cents, note, created_by, created_at, created_ms, updated_by, updated_at, subscription_id, overage)
              VALUES (?, ?, 'active', ?, ?, 0, 'partner', 'staff', ?, 0, 'staff', ?, ?, ?)`,
  ).run(workspace, `cmp_${workspace}`, allowance, unlimited, enrolledAt, enrolledAt, `sub_${workspace}`, overage);
  db.prepare(
    `INSERT INTO complimentary_periods (id, workspace, grant_id, starts_at, allowance_micros, unlimited, fee_cents, note, created_by, created_at, overage)
              VALUES (?, ?, ?, ?, ?, ?, 0, 'partner', 'staff', ?, ?)`,
  ).run(`p_${workspace}`, workspace, `cmp_${workspace}`, enrolledAt, allowance, unlimited, enrolledAt, overage);
}
const termsChange = prepares("complimentary", "// One batch: the open period closes", "self.audit(");
function changeTerms(db, workspace, allowance, when, overage = "stop") {
  assert.equal(termsChange.length, 3);
  batch(db, [
    [termsChange[0], [workspace, when]],
    [termsChange[1], [`p_${when}`, workspace, `cmp_${workspace}`, when, allowance, 0, 0, "changed", "staff", overage]],
    [termsChange[2], [workspace, allowance, 0, 0, "changed", "staff", when, JSON.stringify({ op: "terms", period: `p_${when}` }), overage]],
  ]);
}
const line = (db, id) => ({
  ...db.prepare("SELECT amount_micros, credit_micros, gift_micros, trial_micros, oss_micros, given_micros FROM ledger WHERE id=?").get(id),
});
const giftUsed = (db, workspace, month = "2026-10") =>
  db.prepare("SELECT used FROM allowance_use WHERE kind='complimentary' AND scope=? AND month=?").get(workspace, month)?.used ?? 0;

test("a complimentary allowance pays first and alone, and past it g1t covers rather than charging", () => {
  const db = database();
  enroll(db, "acme", 10_000_000);
  db.prepare("INSERT INTO trial_grants (workspace, month, granted_micros, used_micros, created_at) VALUES ('acme', '2026-10', 5000000, 0, ?)").run(at);
  batch(db, usage("a", "run/a", "acme", 6_000_000));
  assert.deepEqual(line(db, "a"), { amount_micros: 0, credit_micros: 0, gift_micros: 6_000_000, trial_micros: 0, oss_micros: 0, given_micros: 0 });
  // Running work that outlasts the allowance: the rest is g1t's, recorded
  // apart from the allowance, and nothing is owed.
  batch(db, usage("b", "run/b", "acme", 6_000_000));
  assert.deepEqual(line(db, "b"), { amount_micros: 0, credit_micros: 0, gift_micros: 4_000_000, trial_micros: 0, oss_micros: 0, given_micros: 2_000_000 });
  assert.equal(giftUsed(db, "acme"), 10_000_000);
  assert.equal(db.prepare("SELECT balance_micros FROM accounts WHERE workspace='acme'").get().balance_micros, 0);
  // Plan credit, the trial and the pools were never touched.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM allowance_use WHERE kind IN ('plan_credit','oss_pool','oss_repo')").get().n, 0);
  assert.equal(db.prepare("SELECT used_micros FROM trial_grants WHERE workspace='acme'").get().used_micros, 0);
  // A duplicate delivery consumes nothing more.
  batch(db, usage("dup", "run/b", "acme", 6_000_000));
  assert.equal(giftUsed(db, "acme"), 10_000_000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 2);
  db.close();
});

test("changing the amount keeps the month's consumption; lowering it never creates a debt", () => {
  const db = database();
  enroll(db, "acme", 10_000_000);
  batch(db, usage("a", "run/a", "acme", 8_000_000, { when: "2026-10-10T00:00:00.000Z" }));
  changeTerms(db, "acme", 5_000_000, "2026-10-11T00:00:00.000Z");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM complimentary_periods WHERE workspace='acme' AND ends_at IS NULL").get().n, 1);
  assert.equal(db.prepare("SELECT allowance_micros FROM complimentary WHERE workspace='acme'").get().allowance_micros, 5_000_000);
  // Lowered below what was used: nothing more from it, nothing owed.
  batch(db, usage("b", "run/b", "acme", 1_000_000, { when: "2026-10-12T00:00:00.000Z" }));
  assert.deepEqual(line(db, "b"), { amount_micros: 0, credit_micros: 0, gift_micros: 0, trial_micros: 0, oss_micros: 0, given_micros: 1_000_000 });
  assert.equal(giftUsed(db, "acme"), 8_000_000, "the earlier draw is kept, not reset");
  // Raised: only what is over the month's use is left.
  changeTerms(db, "acme", 20_000_000, "2026-10-13T00:00:00.000Z");
  batch(db, usage("c", "run/c", "acme", 15_000_000, { when: "2026-10-14T00:00:00.000Z" }));
  assert.equal(line(db, "c").gift_micros, 12_000_000);
  assert.equal(line(db, "c").given_micros, 3_000_000);
  assert.equal(giftUsed(db, "acme"), 20_000_000);
  // A new month starts the allowance again, with no rollover.
  batch(db, usage("d", "run/d", "acme", 25_000_000, { when: "2026-11-01T00:00:01.000Z" }));
  assert.equal(line(db, "d").gift_micros, 20_000_000);
  assert.equal(giftUsed(db, "acme", "2026-11"), 20_000_000);
  assert.equal(db.prepare("SELECT SUM(amount_micros) n FROM ledger").get().n, 0, "nothing was ever charged");
  db.close();
});

test("late usage draws on the period it happened in, not the one it is posted in", () => {
  const db = database();
  enroll(db, "acme", 10_000_000);
  // Converted to the plan on the 15th.
  db.exec("UPDATE complimentary_periods SET ends_at='2026-10-15T00:00:00.000Z'; UPDATE complimentary SET status='ended', ended_reason='converted'");
  batch(db, usage("before", "run/before", "acme", 3_000_000, { when: "2026-10-14T23:00:00.000Z" }));
  assert.equal(line(db, "before").gift_micros, 3_000_000, "gifted usage is never repriced after conversion");
  assert.equal(line(db, "before").amount_micros, 0);
  batch(db, usage("after", "run/after", "acme", 3_000_000, { when: "2026-10-15T01:00:00.000Z" }));
  assert.deepEqual(line(db, "after"), { amount_micros: 0, credit_micros: 3_000_000, gift_micros: 0, trial_micros: 0, oss_micros: 0, given_micros: 0 });
  db.close();
});

test("charged past the allowance: g1t pays the allowance, the workspace's own card the rest", () => {
  const db = database();
  enroll(db, "friend", 10_000_000, { overage: "charge" });
  // No card yet: past the allowance it is g1t's, never a debt.
  batch(db, usage("z", "run/z", "friend", 12_000_000, { when: "2026-11-02T00:00:00.000Z" }));
  assert.deepEqual(line(db, "z"), { amount_micros: 0, credit_micros: 0, gift_micros: 10_000_000, trial_micros: 0, oss_micros: 0, given_micros: 2_000_000 });
  db.prepare("INSERT INTO card_checks (workspace, setup_intent, payment_method, checked_by, checked_at) VALUES ('friend', 'seti_1', 'pm_1', 'owner', ?)").run(
    at,
  );
  batch(db, usage("a", "run/a", "friend", 6_000_000));
  batch(db, usage("b", "run/b", "friend", 7_000_000));
  // 4 of 7 from the allowance, 3 charged; nothing covered by g1t.
  assert.deepEqual(line(db, "b"), { amount_micros: -3_000_000, credit_micros: 0, gift_micros: 4_000_000, trial_micros: 0, oss_micros: 0, given_micros: 0 });
  assert.equal(db.prepare("SELECT balance_micros FROM accounts WHERE workspace='friend'").get().balance_micros, -3_000_000);
  // Switched to stop mid-month: from then, past the allowance is g1t's.
  changeTerms(db, "friend", 10_000_000, "2026-10-15T00:00:00.000Z", "stop");
  batch(db, usage("c", "run/c", "friend", 1_000_000, { when: "2026-10-16T00:00:00.000Z" }));
  assert.deepEqual(line(db, "c"), { amount_micros: 0, credit_micros: 0, gift_micros: 0, trial_micros: 0, oss_micros: 0, given_micros: 1_000_000 });
  // Usage from before the switch, posted late, keeps the period it happened in.
  batch(db, usage("d", "run/d", "friend", 2_000_000, { when: "2026-10-14T00:00:00.000Z" }));
  assert.equal(line(db, "d").amount_micros, -2_000_000);
  db.close();
});

test("an enrollment's fee paid while enrolled is not evidence of the plan", () => {
  const db = database();
  enroll(db, "acme", 10_000_000);
  db.exec("UPDATE complimentary_periods SET ends_at='2026-10-15T00:00:00.000Z'");
  const evidence = db.prepare(constant("storage", "PLAN_EVIDENCE"));
  db.exec("UPDATE complimentary_periods SET fee_cents = 2500");
  db.prepare("INSERT INTO plan_payments (invoice_id, workspace, amount_micros, paid_at) VALUES ('in_fee', 'acme', 25000000, '2026-10-02T00:00:00.000Z')").run();
  assert.equal(evidence.get("acme", "2026-10-01", "2026-11-01", "2026-10").had, 0);
  // The conversion's first plan payment, made while the period is still open, is the plan.
  db.prepare(
    "INSERT INTO plan_payments (invoice_id, workspace, amount_micros, paid_at) VALUES ('in_plan', 'acme', 21000000, '2026-10-14T23:59:00.000Z')",
  ).run();
  assert.equal(evidence.get("acme", "2026-10-01", "2026-11-01", "2026-10").had, 1);
  db.close();
});

test("an unlimited enrollment pays everything and still records what it used", () => {
  const db = database();
  enroll(db, "flagon-io", 0, { unlimited: 1 });
  batch(db, usage("a", "run/a", "flagon-io", 900_000_000));
  assert.equal(line(db, "a").gift_micros, 900_000_000);
  assert.equal(line(db, "a").given_micros, 0);
  assert.equal(giftUsed(db, "flagon-io"), 900_000_000);
  db.close();
});

test("an interrupted posting consumes no complimentary allowance", () => {
  const db = database();
  enroll(db, "acme", 10_000_000);
  db.exec("CREATE TRIGGER fail_balance BEFORE INSERT ON accounts WHEN NEW.workspace='acme' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => batch(db, usage("a", "run/a", "acme", 4_000_000)), /injected failure/);
  assert.equal(giftUsed(db, "acme"), 0);
  db.exec("DROP TRIGGER fail_balance");
  batch(db, usage("b", "run/a", "acme", 4_000_000));
  assert.equal(giftUsed(db, "acme"), 4_000_000);
  db.close();
});

test("one open period per workspace", () => {
  const db = database();
  enroll(db, "acme", 1);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO complimentary_periods (id, workspace, grant_id, starts_at, allowance_micros, note, created_by, created_at)
     VALUES ('second', 'acme', 'cmp_acme', ?, 1, 'x', 'staff', ?)`,
        )
        .run(at, at),
    /UNIQUE/,
  );
  db.close();
});

test("migration 0065 returns every workspace but flagon-io to Free, with an audit entry", () => {
  const db = database("0065");
  const account = db.prepare(
    "INSERT INTO billing_accounts (id, kind, name, terms_kind, discount_percent, team_granted, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'staff', ?)",
  );
  account.run("ws_flagon-io-x", "workspace", "flagon-io-x", "comped", 100, 0, at);
  db.prepare("UPDATE billing_accounts SET terms_kind='custom' WHERE id='ws_flagon-io'").run();
  account.run("ws_partner", "workspace", "partner", "comped", 100, 0, at);
  account.run("ws_given", "workspace", "given", "standard", 0, 1, at);
  account.run("ws_plain", "workspace", "plain", "standard", 0, 0, at);
  db.prepare("INSERT INTO account_members (workspace, account_id, added_by, added_at) VALUES ('member', 'ent_x', 'staff', ?)").run(at);
  // One on an enterprise invoice still being made: kept, not a failed deploy.
  db.prepare("INSERT INTO account_members (workspace, account_id, added_by, added_at) VALUES ('invoicing', 'ent_y', 'staff', ?)").run(at);
  db.prepare("INSERT INTO enterprise_invoice_attempts (account_id, id, payload, created_ms) VALUES ('ent_y', 'att', ?, 1)").run(
    JSON.stringify({ lines: [{ workspace: "invoicing", amountMicros: 1 }] }),
  );
  const flagonBefore = db.prepare("SELECT * FROM billing_accounts WHERE id='ws_flagon-io'").get();
  db.exec(
    readFileSync(
      new URL(
        names.find((n) => n.startsWith("0065")),
        migrations,
      ),
      "utf8",
    ),
  );
  const terms = Object.fromEntries(
    db
      .prepare("SELECT id, terms_kind, discount_percent, team_granted FROM billing_accounts")
      .all()
      .map((r) => [r.id, [r.terms_kind, r.discount_percent, r.team_granted]]),
  );
  assert.deepEqual({ ...db.prepare("SELECT * FROM billing_accounts WHERE id='ws_flagon-io'").get() }, { ...flagonBefore }, "flagon-io is untouched");
  assert.deepEqual(terms["ws_flagon-io-x"], ["standard", 0, 0], "only flagon-io itself is kept");
  assert.deepEqual(terms.ws_partner, ["standard", 0, 0]);
  assert.deepEqual(terms.ws_given, ["standard", 0, 0]);
  assert.deepEqual(terms.ws_plain, ["standard", 0, 0]);
  assert.deepEqual(
    db
      .prepare("SELECT workspace FROM account_members")
      .all()
      .map((r) => r.workspace),
    ["invoicing"],
  );
  const audited = db
    .prepare("SELECT account FROM admin_actions WHERE by='billing' ORDER BY account")
    .all()
    .map((r) => r.account);
  assert.deepEqual(audited, ["ent_x", "ws_flagon-io-x", "ws_given", "ws_partner"]);
  db.close();
});
