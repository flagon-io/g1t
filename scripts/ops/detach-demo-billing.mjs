// One-time demo cutover. Preview by default; --apply detaches test billing.
// Keep usage history and flagon-io. Stop on data requiring the general service
// workflow (enterprise, purchased grants, debt, or historical month closes).
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getPlatformProxy } from "wrangler";

const apply = process.argv.includes("--apply");
const source = (name) => readFileSync(`services/billing/src/${name}.rs`, "utf8");
const constant = (file, name) => {
  const match = source(file).match(new RegExp(`const ${name}: &str =\\s*"([\\s\\S]*?)";`));
  assert.ok(match, `${file}::${name}`);
  return match[1];
};
const found = constant("detach", "FOUND").replace("{internal}", constant("sales", "INTERNAL_SQL"));
const fixed = [
  ...source("detach")
    .split("const STATEMENTS: &[&str] = &[")[1]
    .split("\n];")[0]
    .matchAll(/"([^"]*)"/g),
].map((m) => m[1]);
// 16 since migration 0064: test-mode complimentary enrollments end too.
assert.equal(fixed.length, 16, "Review changed detach statements before running");
const at = new Date().toISOString();
const month = at.slice(0, 7);
const by = "codex:user-authorized-demo-cutover";
const dir = "target/billing-downgrade";
mkdirSync(dir, { recursive: true });
const configPath = `${dir}/maintenance.json`;
writeFileSync(
  configPath,
  JSON.stringify({
    name: "g1t-demo-cutover",
    account_id: "1e6f2cffa3f445920836e8ebe446bb58",
    compatibility_date: "2026-09-26",
    services: [{ binding: "BILLING", service: "g1t-billing", remote: true }],
    d1_databases: [{ binding: "DB", database_name: "g1t-billing", database_id: "695a6979-fd07-4850-bc97-904a6b4b7a04", remote: true }],
  }),
);
const proxy = await getPlatformProxy({ configPath, persist: false, remoteBindings: true, envFiles: [] });
try {
  const { DB, BILLING } = proxy.env;
  const status = await (await BILLING.fetch("https://billing/rpc/status", { method: "POST", body: "{}" })).json();
  assert.equal(status.live, false, "Refusing to detach live billing");
  assert.equal(status.enabled, true);
  const query = async (sql, args = []) =>
    (
      await DB.prepare(sql)
        .bind(...args)
        .all()
    ).results;
  const snapshot = await query("SELECT * FROM billing_accounts WHERE id='ws_flagon-io'");
  assert.equal(snapshot.length, 1);
  const tables = new Set((await query("SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name));
  const targets = (await query(found, [null, month])).filter((r) => r.workspace !== "flagon-io");
  for (const row of targets) {
    assert.equal(row.comped + row.enterprise + row.ai_grants + row.pending_past, 0, `Manual review required: ${row.workspace}`);
    assert.equal(row.balance - Math.max(0, row.paid), 0, `Unexpected balance: ${row.workspace}`);
  }
  const overrides = await query(
    "SELECT id FROM billing_accounts WHERE id <> 'ws_flagon-io' AND (team_granted <> 0 OR terms_kind <> 'standard' OR discount_percent <> 0)",
  );
  assert.equal(overrides.length, 0, "Additional plan grants need review");
  writeFileSync(`${dir}/demo-${apply ? "apply" : "preview"}.json`, JSON.stringify({ at, status, targets, preserved: snapshot }, null, 2));
  console.log(JSON.stringify({ apply, preserved: "flagon-io", targets }));
  if (apply) {
    const key = readFileSync(".secrets/stripe-test-key.txt", "utf8").trim();
    assert.match(key, /^(sk|rk)_test_/);
    const version = source("stripe").match(/STRIPE_VERSION: &str = "([^"]+)"/)[1];
    const stripe = async (path, method = "GET") => {
      const response = await fetch(`https://api.stripe.com/v1${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Stripe-Version": version } });
      const value = await response.json();
      assert.ok(response.ok, `Stripe ${method}: ${response.status} ${value.error?.code ?? ""}`);
      assert.equal(value.livemode, false, "Expected a test object");
      return value;
    };
    for (const row of targets) {
      const workspace = row.workspace;
      const subscriptions = await query("SELECT subscription_id FROM subscriptions WHERE workspace=? AND status <> 'canceled'", [workspace]);
      const customer = (await query("SELECT customer_id FROM accounts WHERE workspace=?", [workspace]))[0]?.customer_id;
      if (customer) await stripe(`/customers/${customer}`);
      for (const { subscription_id: id } of subscriptions) {
        const subscription = await stripe(`/subscriptions/${id}`);
        assert.equal(subscription.customer, customer, "Subscription/customer mismatch");
        if (subscription.status !== "canceled") {
          assert.equal((await stripe(`/subscriptions/${id}`, "DELETE")).status, "canceled");
        }
      }
      // Refresh after Stripe calls. Each workspace's local changes commit
      // together; interruption is retryable, including canceled subscriptions.
      const current = (await query(found, [workspace, month]))[0];
      assert.equal(current.balance - Math.max(0, current.paid), 0);
      assert.equal(current.ai_grants + current.pending_past + current.enterprise + current.comped, 0);
      const values = [workspace, at, by, month];
      const statements = fixed
        .filter((sql) => tables.has("invoice_attempts") || !sql.includes("invoice_attempts"))
        .map((sql) => {
          const count = Math.max(...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
          return DB.prepare(sql).bind(...values.slice(0, count));
        });
      if (current.paid > 0) {
        statements.push(
          DB.prepare(constant("detach", "LEDGER")).bind(
            `led_${randomUUID()}`,
            workspace,
            -current.paid,
            "Reverse demo payments before live billing",
            `test_detach/${workspace}/${at}`,
            by,
            at,
            null,
          ),
        );
        statements.push(DB.prepare(constant("detach", "BALANCE")).bind(workspace, -current.paid, at));
      }
      statements.push(
        DB.prepare("INSERT INTO admin_actions (id, account, action, detail, by, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
          `adm_${randomUUID()}`,
          `ws_${workspace}`,
          "test_detach",
          "User requested Free plan before live launch; Stripe test subscriptions canceled; demo payments reversed; history retained.",
          by,
          at,
        ),
      );
      await DB.batch(statements);
      console.log(JSON.stringify({ detached: workspace }));
    }
    assert.deepEqual(await query("SELECT * FROM billing_accounts WHERE id='ws_flagon-io'"), snapshot);
    const remaining = (await query(found, [null, month])).filter((r) => r.workspace !== "flagon-io");
    for (const row of remaining) {
      for (const field of ["subscriptions", "customer", "card_cached", "balance", "paid", "plan_unreversed", "plan_credit", "pending_now", "open_disputes"])
        assert.equal(row[field], 0, `${row.workspace}: ${field}`);
    }
    writeFileSync(`${dir}/demo-verified.json`, JSON.stringify({ at: new Date().toISOString(), rows: remaining, flagonPreserved: true }, null, 2));
    console.log("Verified: non-flagon workspaces detached; flagon-io terms preserved.");
  }
} finally {
  await proxy.dispose();
}
