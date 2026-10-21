// Explicit sandbox-only integration checks against a locally running billing
// Worker and isolated D1. Never accepts a live Stripe key or a remote Worker.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";

const dir = resolve("target/billing-audit");
mkdirSync(dir, { recursive: true });
const key = readFileSync(".secrets/stripe-test-key.txt", "utf8").trim();
assert.ok(/^(sk|rk)_test_/.test(key), "Expected a test API key");
const version = readFileSync("services/billing/src/stripe.rs", "utf8").match(/STRIPE_VERSION: &str = "([^"]+)"/)[1];
const endpoint = "http://127.0.0.1:8797";
const secret = "whsec_local_billing_audit_only";
const fixturePath = resolve(dir, "fixture.json");
const phase = process.argv[2];
assert.ok(
  ["seed", "run", "lifecycle", "enterprise", "protocol", "complimentary", "prepay", "cleanup"].includes(phase),
  "Use seed, run, lifecycle, enterprise, protocol, complimentary, prepay, or cleanup",
);
// A local Worker is not enough isolation: production replays all events in
// its Stripe account. The test and live keys below were verified to share
// this account during the audit. Never seed or run fixtures there again.
const productionStripeAccount = "acct_1UMzU3CgDtq6trU5";
const auditAccount = await stripe("/account");
assert.match(auditAccount.id, /^acct_/);
if (phase !== "cleanup") {
  assert.notEqual(
    auditAccount.id,
    productionStripeAccount,
    "Use a separate Stripe Sandbox: this account is connected to production event replay. No test objects were created.",
  );
}
async function stripe(path, fields, method = fields ? "POST" : "GET", apiVersion = version) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": apiVersion, ...(fields ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: fields ? new URLSearchParams(fields) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw Error(`Stripe ${method} ${path}: ${response.status} ${result.error?.code ?? result.error?.type ?? "error"}`);
  assert.notEqual(result.livemode, true, "Sandbox returned a live object");
  return result;
}
async function rpc(method, args) {
  const response = await fetch(`${endpoint}/rpc/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
  if (!response.ok) throw Error(`Local billing ${method}: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}
function localSQL(sql) {
  const file = resolve(dir, "fixture.sql");
  writeFileSync(file, sql);
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "d1",
      "execute",
      "billing-audit",
      "--local",
      "--config",
      "target/billing-audit/wrangler.json",
      "--persist-to",
      "target/billing-audit/state",
      "--file",
      file,
      "--json",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw Error(`Local fixture SQL failed: ${result.stderr.slice(0, 500)}`);
}
function localRows(sql) {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "d1",
      "execute",
      "billing-audit",
      "--local",
      "--config",
      "target/billing-audit/wrangler.json",
      "--persist-to",
      "target/billing-audit/state",
      "--command",
      sql,
      "--json",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw Error(`Local query failed: ${result.stderr.slice(0, 500)}`);
  return JSON.parse(result.stdout)[0].results;
}
function signed(event) {
  const payload = JSON.stringify(event),
    time = Math.floor(Date.now() / 1000);
  return { payload, signature: `t=${time},v1=${createHmac("sha256", secret).update(`${time}.${payload}`).digest("hex")}` };
}
if (phase === "protocol") {
  assert.equal((await rpc("status", {})).live, false);
  const event = { id: `evt_audit_mode_${Date.now()}`, type: "audit.mode_check", livemode: true, data: { object: {} } };
  const deliver = () => {
    const payload = JSON.stringify(event),
      time = Math.floor(Date.now() / 1000);
    const signature = `t=${time},v1=${createHmac("sha256", secret).update(`${time}.${payload}`).digest("hex")}`;
    return rpc("stripe_webhook", { payload, signature });
  };
  await assert.rejects(deliver(), /HTTP 500/);
  event.livemode = false;
  assert.deepEqual(await deliver(), { ok: true, value: true });
  assert.deepEqual(await deliver(), { ok: true, value: false });
  console.log("PASS wrong-mode delivery remains unclaimed and can be processed once after mode correction");
} else if (phase === "seed") {
  const workspace = `audit-${Date.now()}`;
  const customer = await stripe("/customers", {
    name: "Disposable g1t billing audit",
    "metadata[g1t_audit]": workspace,
    payment_method: "pm_card_visa",
    "invoice_settings[default_payment_method]": "pm_card_visa",
    "address[country]": "US",
    "address[state]": "CO",
    "address[postal_code]": "80202",
    "address[line1]": "123 Test Street",
    "address[city]": "Denver",
  });
  assert.match(customer.id, /^cus_[a-zA-Z0-9]+$/);
  writeFileSync(fixturePath, JSON.stringify({ workspace, customer: customer.id, stripeAccount: auditAccount.id }));
  localSQL(`INSERT INTO accounts (workspace,balance_micros,customer_id,created_at) VALUES ('${workspace}',0,'${customer.id}','${new Date().toISOString()}');`);
  console.log(JSON.stringify({ seeded: workspace, mode: "sandbox", database: "local" }));
} else if (phase === "run") {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  assert.equal(fixture.stripeAccount, auditAccount.id, "Fixture belongs to a different Stripe account; seed an isolated fixture");
  const { workspace, customer } = fixture;
  const actor = { id: "usr_audit", username: "audit-owner", verified: true, workspaces: [{ slug: workspace, role: "owner" }] };
  const checks = [];
  const passed = (name) => {
    checks.push(name);
    console.log(`PASS ${name}`);
  };
  assert.equal((await rpc("status", {})).live, false);
  const started = await rpc("subscribe", { workspace, actor, feature: "plan", returnUrl: `${endpoint}/return` });
  assert.equal(started.ok, true, JSON.stringify(started));
  const features = await rpc("features", { workspace, viewer: actor });
  assert.ok(features.ok && features.value.some((f) => f.plan.feature === "plan" && f.on), JSON.stringify(features));
  passed("saved-card subscription activates through the real billing Worker");
  const subscriptions = await stripe(`/subscriptions?customer=${customer}&status=all`);
  assert.equal(subscriptions.data.length, 1);
  fixture.subscription = subscriptions.data[0].id;
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const again = await rpc("subscribe", { workspace, actor, feature: "plan", returnUrl: `${endpoint}/return` });
  assert.equal(again.ok, false);
  assert.equal((await stripe(`/subscriptions?customer=${customer}&status=all`)).data.length, 1);
  passed("repeat subscribe cannot create a second active plan");
  for (const resume of [false, true]) {
    const changed = await rpc("cancel_subscription", { workspace, actor, feature: "plan", resume });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.equal((await stripe(`/subscriptions/${fixture.subscription}`)).cancel_at_period_end, !resume);
  }
  passed("period-end cancellation and resumption reach Stripe");
  const charge = { workspace, feature: "deployments", costMicros: 15_000_000, description: "Sandbox audit usage", repo: null, reference: `audit/${workspace}` };
  const posts = await Promise.all([rpc("charge_feature", charge), rpc("charge_feature", charge)]);
  assert.equal(posts.filter((p) => p.ok && p.value).length, 1);
  const account = await rpc("account", { workspace, viewer: actor });
  assert.equal(account.value.balanceMicros, -8_000_000, JSON.stringify(account));
  passed("concurrent usage delivery consumes included credit and posts excess once");
  const closed = await rpc("close_workspace", { workspace, actor, dryRun: false });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const invoices = await rpc("invoices", { workspace, viewer: actor });
  assert.ok(invoices.ok && invoices.value.some((i) => i.status === "paid"), JSON.stringify(invoices));
  assert.equal((await rpc("account", { workspace, viewer: actor })).value.balanceMicros, 0);
  const usageInvoice = (await stripe(`/invoices?customer=${customer}&limit=20`)).data.find((i) => i.metadata?.g1t_workspace === workspace);
  assert.ok(usageInvoice?.charge);
  passed("closing collects exactly the excess usage on a paid Stripe invoice");
  await stripe("/refunds", { charge: usageInvoice.charge, amount: "400" });
  const chargeObject = await stripe(`/charges/${usageInvoice.charge}`);
  const event = { id: `evt_local_audit_${workspace}`, type: "charge.refunded", livemode: false, data: { object: chargeObject } };
  const payload = JSON.stringify(event),
    time = Math.floor(Date.now() / 1000);
  const signature = `t=${time},v1=${createHmac("sha256", secret).update(`${time}.${payload}`).digest("hex")}`;
  assert.equal((await rpc("stripe_webhook", { payload, signature })).ok, true);
  assert.equal((await rpc("stripe_webhook", { payload, signature })).ok, true);
  assert.equal((await rpc("account", { workspace, viewer: actor })).value.balanceMicros, -4_000_000);
  passed("real sandbox refund and locally signed duplicate delivery reverse credit once");
  const bad = await rpc("stripe_webhook", { payload, signature: "t=1,v1=00" });
  assert.equal(bad.ok, false);
  passed("invalid webhook signatures are rejected");
  writeFileSync(
    resolve(dir, "sandbox-results.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        mode: "sandbox",
        worker: "local",
        checks,
        limitations: ["No public webhook delivery", "No browser Checkout or 3DS", "No renewal test clock", "No production deployment"],
      },
      null,
      2,
    ),
  );
} else if (phase === "lifecycle") {
  assert.equal((await rpc("status", {})).live, false);
  const workspace = `audit-cycle-${Date.now()}`;
  const actor = { id: "usr_audit", username: "audit-owner", verified: true, workspaces: [{ slug: workspace, role: "owner" }] };
  const checks = [];
  const passed = (message) => {
    checks.push(message);
    console.log(`PASS ${message}`);
  };
  const clock = await stripe("/test_helpers/test_clocks", { frozen_time: String(Math.floor(Date.now() / 1000)), name: workspace });
  const evidence = { workspace, clock: clock.id, stripeAccount: auditAccount.id, checks };
  const save = () => writeFileSync(resolve(dir, "lifecycle-results.json"), JSON.stringify({ ...evidence, checkedAt: new Date().toISOString() }, null, 2));
  save();
  const customer = await stripe("/customers", {
    name: workspace,
    test_clock: clock.id,
    payment_method: "pm_card_visa",
    "invoice_settings[default_payment_method]": "pm_card_visa",
    "metadata[workspace]": workspace,
    "address[country]": "US",
    "address[state]": "CO",
    "address[postal_code]": "80202",
    "address[line1]": "123 Test Street",
    "address[city]": "Denver",
  });
  evidence.customer = customer.id;
  save();
  localSQL(`INSERT INTO accounts (workspace,balance_micros,customer_id,created_at) VALUES ('${workspace}',0,'${customer.id}','${new Date().toISOString()}');`);
  const started = await rpc("subscribe", { workspace, actor, feature: "plan", returnUrl: `${endpoint}/return` });
  assert.equal(started.ok, true, JSON.stringify(started));
  const subscription = (await stripe(`/subscriptions?customer=${customer.id}&status=all`)).data[0];
  assert.equal(subscription.status, "active");
  evidence.subscription = subscription.id;
  save();
  const end = (sub) => sub.current_period_end ?? sub.items.data[0].current_period_end;
  const advance = async (frozenTime) => {
    await stripe(`/test_helpers/test_clocks/${clock.id}/advance`, { frozen_time: String(frozenTime) });
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = await stripe(`/test_helpers/test_clocks/${clock.id}`);
      if (current.status === "ready") return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw Error("Stripe clock did not become ready within 30 polls");
  };
  // Exercise the actual subscription handler and signed delivery protocol.
  // These locally signed events deliberately fetch Stripe's current object;
  // public webhook transport is a separate test, not claimed here.
  const deliver = async (type, object, suffix) => {
    // Read real objects in the production destination's schema while the
    // Worker keeps using its independently pinned request API version.
    const webhookVersion = "2026-08-26.dahlia";
    const resource = type.startsWith("invoice.") ? "invoices" : "subscriptions";
    object = await stripe(`/${resource}/${object.id}`, undefined, "GET", webhookVersion);
    if (resource === "invoices") {
      assert.equal(object.subscription, undefined);
      assert.equal(object.parent?.subscription_details?.subscription, subscription.id);
    }
    const payload = JSON.stringify({ id: `evt_audit_${workspace}_${suffix}`, api_version: webhookVersion, type, livemode: false, data: { object } });
    const time = Math.floor(Date.now() / 1000);
    const signature = `t=${time},v1=${createHmac("sha256", secret).update(`${time}.${payload}`).digest("hex")}`;
    const result = await rpc("stripe_webhook", { payload, signature });
    assert.equal(result.ok, true, JSON.stringify(result));
  };
  const plan = async () => (await rpc("features", { workspace, viewer: actor })).value.find((f) => f.plan.feature === "plan");
  try {
    const waiver = await rpc("admin_set_allowances", {
      id: `ws_${workspace}`,
      allowances: { plan: true },
      note: "Audit: must not silently waive an active Stripe plan",
      by: "audit",
    });
    assert.equal(waiver.ok, false);
    assert.match(waiver.error.message, /subscription/i);
    assert.equal((await stripe(`/subscriptions/${subscription.id}`)).status, "active");
    passed("staff fee waiver refuses a still-billable Stripe subscription");
    await advance(end(subscription) + 7200);
    let renewed = await stripe(`/subscriptions/${subscription.id}`);
    let renewalInvoice = await stripe(`/invoices/${renewed.latest_invoice}`);
    // Stripe can leave the renewal draft until the next simulation advance.
    if (renewalInvoice.status === "draft") {
      await stripe(`/invoices/${renewalInvoice.id}/finalize`, {});
      renewalInvoice = await stripe(`/invoices/${renewalInvoice.id}`);
    }
    if (renewalInvoice.status === "open") renewalInvoice = await stripe(`/invoices/${renewalInvoice.id}/pay`, {});
    assert.equal(renewalInvoice.status, "paid");
    assert.notEqual(renewalInvoice.id, subscription.latest_invoice);
    await deliver("invoice.paid", renewalInvoice, "renewed");
    await deliver("invoice.paid", renewalInvoice, "renewed");
    assert.equal((await plan()).on, true);
    passed("test-clock renewal collects and duplicate delivery retains paid access");
    save();
    // Attach succeeds, subsequent charge fails: Stripe's documented test PM.
    const declined = await stripe("/payment_methods/pm_card_chargeCustomerFail/attach", { customer: customer.id });
    await stripe(`/subscriptions/${subscription.id}`, { default_payment_method: declined.id });
    renewed = await stripe(`/subscriptions/${subscription.id}`);
    await advance(end(renewed) + 7200);
    let failedSub = await stripe(`/subscriptions/${subscription.id}`);
    let failedInvoice = await stripe(`/invoices/${failedSub.latest_invoice}`);
    if (failedInvoice.status === "draft") {
      await stripe(`/invoices/${failedInvoice.id}/finalize`, {});
      failedInvoice = await stripe(`/invoices/${failedInvoice.id}`);
    }
    if (!failedInvoice.attempted) {
      await assert.rejects(stripe(`/invoices/${failedInvoice.id}/pay`, {}), /Stripe/);
    }
    failedSub = await stripe(`/subscriptions/${subscription.id}`);
    assert.equal(failedSub.status, "past_due");
    await deliver("invoice.payment_failed", failedInvoice, "declined");
    assert.equal((await plan()).on, false);
    passed("declined renewal removes paid access after reconciliation");
    save();
    await stripe(`/subscriptions/${subscription.id}`, { default_payment_method: customer.invoice_settings.default_payment_method });
    const recovered = await stripe(`/invoices/${failedInvoice.id}/pay`, {});
    assert.equal(recovered.status, "paid");
    await deliver("invoice.paid", recovered, "recovered");
    await deliver("invoice.payment_failed", failedInvoice, "late-decline");
    assert.equal((await plan()).on, true);
    passed("payment recovery restores access and stale decline cannot undo it");
    save();
    const cancel = await rpc("cancel_subscription", { workspace, actor, feature: "plan", resume: false });
    assert.equal(cancel.ok, true, JSON.stringify(cancel));
    assert.equal((await plan()).on, true);
    const beforeEnd = await stripe(`/subscriptions/${subscription.id}`);
    await advance(end(beforeEnd) + 60);
    const ended = await stripe(`/subscriptions/${subscription.id}`);
    assert.equal(ended.status, "canceled");
    await deliver("customer.subscription.deleted", ended, "ended");
    assert.equal((await plan()).on, false);
    passed("period-end cancellation retains access until expiry and then removes it");
    evidence.webhookObjectVersion = "2026-08-26.dahlia";
    evidence.transport = "Locally signed RPC delivery; not public Stripe delivery";
    evidence.complete = true;
    save();
  } finally {
    await stripe(`/test_helpers/test_clocks/${clock.id}`, undefined, "DELETE");
    evidence.cleaned = true;
    save();
  }
} else if (phase === "enterprise") {
  const workspace = `audit-enterprise-${Date.now()}`;
  const enterprise = `ent_${workspace}`;
  const customer = await stripe("/customers", {
    name: workspace,
    email: "billing-audit@example.com",
    "address[country]": "US",
    "address[state]": "CO",
    "address[postal_code]": "80202",
    "address[line1]": "123 Test Street",
    "address[city]": "Denver",
  });
  const now = new Date().toISOString();
  localSQL(`INSERT INTO billing_accounts (id,kind,name,customer_id,created_by,created_at) VALUES ('${enterprise}','enterprise','Audit enterprise','${customer.id}','audit','${now}');
    INSERT INTO account_members VALUES ('${workspace}','${enterprise}','audit','${now}');
    INSERT INTO accounts (workspace,balance_micros,created_at) VALUES ('${workspace}',-10000001,'${now}');`);
  const checks = [];
  try {
    // Wait for both requests before cleanup, even when Stripe returns its
    // transient idempotency_key_in_use response to one concurrent caller.
    const outcomes = await Promise.allSettled([
      rpc("admin_invoice_enterprise", { id: enterprise, by: "audit" }),
      rpc("admin_invoice_enterprise", { id: enterprise, by: "audit" }),
    ]);
    const requests = outcomes.filter((r) => r.status === "fulfilled").map((r) => r.value);
    for (const result of outcomes) assert.equal(result.status, "fulfilled", result.reason?.message);
    assert.ok(
      requests.some((r) => r.ok),
      JSON.stringify(requests),
    );
    const invoices = (await stripe(`/invoices?customer=${customer.id}`)).data;
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].subtotal, 1001);
    for (const result of requests.filter((r) => r.ok)) assert.equal(result.value.lines[0].amountMicros, 10010000);
    checks.push("concurrent enterprise requests create one invoice with exact cent-rounded line accounting");
    console.log(`PASS ${checks.at(-1)}`);
    const again = await rpc("admin_invoice_enterprise", { id: enterprise, by: "audit" });
    assert.equal(again.ok, false);
    assert.equal((await stripe(`/invoices?customer=${customer.id}`)).data.length, 1);
    checks.push("already-invoiced debt cannot be invoiced twice");
    console.log(`PASS ${checks.at(-1)}`);
    localSQL(`UPDATE accounts SET balance_micros=balance_micros-5000000 WHERE workspace='${workspace}';`);
    const more = await rpc("admin_invoice_enterprise", { id: enterprise, by: "audit" });
    assert.equal(more.ok, true, JSON.stringify(more));
    const all = (await stripe(`/invoices?customer=${customer.id}`)).data;
    assert.equal(all.length, 2);
    assert.equal(
      all.reduce((sum, i) => sum + i.subtotal, 0),
      1501,
    );
    checks.push("subsequent usage invoices only debt not covered by the first invoice");
    console.log(`PASS ${checks.at(-1)}`);
    writeFileSync(
      resolve(dir, "enterprise-results.json"),
      JSON.stringify({ checkedAt: new Date().toISOString(), stripeAccount: auditAccount.id, workspace, checks }, null, 2),
    );
  } finally {
    await stripe(`/customers/${customer.id}`, undefined, "DELETE");
  }
} else if (phase === "complimentary") {
  // Staff enrollment, terms changes, admission, conversion (paid, 3DS,
  // declined, no card, repeated) and revocation, through the real Worker
  // against real sandbox subscriptions. Webhooks are not delivered: each
  // step's synchronous path is what is exercised.
  assert.equal((await rpc("status", {})).live, false);
  const stamp = Date.now();
  const checks = [];
  const made = [];
  const passed = (message) => {
    checks.push(message);
    console.log(`PASS ${message}`);
  };
  const actorOf = (workspace) => ({ id: "usr_audit", username: "audit-owner", verified: true, workspaces: [{ slug: workspace, role: "owner" }] });
  const enroll = (workspace, allowance, fee = 0) =>
    rpc("admin_set_complimentary", { workspace, allowance_micros: allowance, unlimited: false, fee_cents: fee, note: "sandbox audit", by: "audit" });
  const standing = (workspace) => rpc("admin_complimentary", { workspace });
  const reserve = (workspace, estimate) =>
    rpc("reserve", { workspace, repo: { namespace: workspace, name: "app" }, public: false, kind: "workflow", estimateMicros: estimate });
  const card = async (customer, method) => {
    const pm = await stripe(`/payment_methods/${method}/attach`, { customer });
    await stripe(`/customers/${customer}`, { "invoice_settings[default_payment_method]": pm.id });
  };
  const convert = (workspace) => rpc("convert_to_paid", { actor: actorOf(workspace), workspace, returnUrl: `${endpoint}/return` });
  try {
    // Enrollment: a real customer and subscription, then visible.
    const a = `cmp-a-${stamp}`;
    const enrolled = await enroll(a, 100_000_000);
    assert.equal(enrolled.ok, true, JSON.stringify(enrolled));
    made.push(enrolled.value.customerId);
    assert.equal(enrolled.value.status, "active", JSON.stringify(enrolled.value));
    const sub = await stripe(`/subscriptions/${enrolled.value.subscriptionId}`);
    assert.equal(sub.status, "active");
    assert.equal(sub.metadata.g1t_grant, enrolled.value.grantId);
    assert.equal(sub.metadata.g1t_allowance_micros, "100000000");
    assert.equal(sub.items.data[0].price.unit_amount, 0);
    const ent = await rpc("entitlements", { workspace: a });
    assert.equal(ent.plan, "complimentary");
    assert.equal(ent.complimentary.allowanceMicros, 100_000_000);
    assert.equal(ent.complimentary.remainingMicros, 100_000_000);
    assert.equal(ent.hasPlan, true);
    passed("staff enrollment creates a real $0 subscription with the grant in its metadata, then the workspace sees it");
    const again = await enroll(a, 100_000_000);
    assert.equal(again.value.subscriptionId, enrolled.value.subscriptionId);
    assert.equal((await stripe(`/subscriptions?customer=${enrolled.value.customerId}&status=all`)).data.length, 1);
    passed("changing terms keeps one subscription");
    // Admission: the allowance bounds new work, card or not; no on demand.
    await card(enrolled.value.customerId, "pm_card_visa");
    const big = await reserve(a, 200_000_000);
    assert.equal(big.ok, false, JSON.stringify(big));
    assert.match(big.error.message, /complimentary allowance/);
    const small = await reserve(a, 10_000_000);
    assert.equal(small.ok, true, JSON.stringify(small));
    const held = await rpc("entitlements", { workspace: a });
    assert.ok(held.complimentary.remainingMicros < 100_000_000 && held.complimentary.heldMicros > 0, JSON.stringify(held.complimentary));
    passed("admission counts running work against the allowance and refuses past it even with a saved card");
    // A custom fee is its own price on the same subscription.
    const fee = await enroll(a, 50_000_000, 2_500);
    assert.equal(fee.ok, true, JSON.stringify(fee));
    const feeSub = await stripe(`/subscriptions/${enrolled.value.subscriptionId}`);
    assert.equal(feeSub.items.data[0].price.unit_amount, 2_500);
    assert.equal(feeSub.metadata.g1t_fee_cents, "2500");
    assert.equal(feeSub.collection_method, "send_invoice");
    assert.equal((await standing(a)).periods.length, 3);
    passed("a custom monthly fee changes the subscription price apart from the allowance, each term kept as a period");
    assert.equal((await enroll(a, 50_000_000, 0)).ok, true);
    // Conversion with a card that pays: the same subscription becomes the plan.
    const converted = await convert(a);
    assert.equal(converted.ok, true, JSON.stringify(converted));
    assert.equal(converted.value.status, "converted", JSON.stringify(converted.value));
    const paid = await stripe(`/subscriptions/${enrolled.value.subscriptionId}`);
    assert.equal(paid.items.data[0].price.unit_amount, 2_100);
    assert.equal((await stripe(`/subscriptions?customer=${enrolled.value.customerId}&status=all`)).data.length, 1);
    assert.equal((await rpc("entitlements", { workspace: a })).plan, "paid");
    const ended = await standing(a);
    assert.equal(ended.status, "ended");
    assert.equal(ended.endedReason, "converted");
    assert.ok(ended.moneyReceivedMicros >= 21_000_000, JSON.stringify(ended));
    passed("conversion with a paying card turns the same subscription into the plan and records its payment as money received");

    // 3DS: nothing changes until the bank is answered; asking again is the same invoice.
    const b = `cmp-b-${stamp}`;
    const bEnrolled = await enroll(b, 100_000_000);
    made.push(bEnrolled.value.customerId);
    await card(bEnrolled.value.customerId, "pm_card_authenticationRequired");
    const needs = await convert(b);
    assert.equal(needs.value?.status, "needs_action", JSON.stringify(needs));
    assert.match(needs.value.url, /^https:\/\/invoice\.stripe\.com\//);
    const invoicesBefore = (await stripe(`/invoices?subscription=${bEnrolled.value.subscriptionId}`)).data.length;
    const twice = await convert(b);
    assert.equal(twice.value?.status, "needs_action", JSON.stringify(twice));
    // Hosted invoice links are re-signed on each read: the invoice count below is the check.
    assert.equal((await stripe(`/invoices?subscription=${bEnrolled.value.subscriptionId}`)).data.length, invoicesBefore);
    assert.equal((await rpc("entitlements", { workspace: b })).plan, "complimentary");
    assert.equal((await stripe(`/subscriptions/${bEnrolled.value.subscriptionId}`)).items.data[0].price.unit_amount, 0);
    assert.equal((await standing(b)).status, "active");
    passed("3DS leaves the enrollment as it was, and asking again returns the same invoice rather than a new one");

    // Declined: the enrollment stands, one subscription.
    const c = `cmp-c-${stamp}`;
    const cEnrolled = await enroll(c, 100_000_000);
    made.push(cEnrolled.value.customerId);
    await card(cEnrolled.value.customerId, "pm_card_chargeCustomerFail");
    const declined = await convert(c);
    assert.equal(declined.value?.status, "declined", JSON.stringify(declined));
    assert.equal((await rpc("entitlements", { workspace: c })).plan, "complimentary");
    assert.equal((await stripe(`/subscriptions?customer=${cEnrolled.value.customerId}&status=all`)).data.length, 1);
    passed("a declined card leaves the enrollment and its one subscription unchanged");

    // No card at all: a card check page, nothing charged.
    const d = `cmp-d-${stamp}`;
    const dEnrolled = await enroll(d, 100_000_000);
    made.push(dEnrolled.value.customerId);
    const needsCard = await convert(d);
    assert.equal(needsCard.value?.status, "needs_card", JSON.stringify(needsCard));
    assert.match(needsCard.value.url, /^https:\/\/checkout\.stripe\.com\//);
    passed("without a saved card, conversion sends the owner to a card check first");
    const member = { id: "usr_member", username: "member", verified: true, workspaces: [{ slug: d, role: "member" }] };
    assert.equal((await rpc("convert_to_paid", { actor: member, workspace: d, returnUrl: `${endpoint}/return` })).ok, false);
    passed("a member who does not manage billing cannot convert");

    // Charged past the allowance (employees, friends): refused without a
    // card, then admitted under the workspace's limits once it has one.
    const e = `cmp-e-${stamp}`;
    const eEnrolled = await rpc("admin_set_complimentary", {
      workspace: e,
      allowance_micros: 5_000_000,
      unlimited: false,
      fee_cents: 0,
      charge_past_allowance: true,
      note: "sandbox audit",
      by: "audit",
    });
    assert.equal(eEnrolled.ok, true, JSON.stringify(eEnrolled));
    made.push(eEnrolled.value.customerId);
    assert.equal(eEnrolled.value.chargePastAllowance, true);
    assert.equal((await stripe(`/subscriptions/${eEnrolled.value.subscriptionId}`)).metadata.g1t_past_allowance, "charge");
    const noCard = await reserve(e, 20_000_000);
    assert.equal(noCard.ok, false, JSON.stringify(noCard));
    assert.match(noCard.error.message, /Add a card/);
    const eEnt = await rpc("entitlements", { workspace: e });
    assert.equal(eEnt.complimentary.chargePastAllowance, true);
    assert.equal(eEnt.complimentary.hasCard, false);
    passed("charged past the allowance, without a card: work past it is refused and the owner is told to add one");
    await card(eEnrolled.value.customerId, "pm_card_visa");
    localSQL(`UPDATE accounts SET card_last4 = '4242' WHERE workspace = '${e}';`);
    const withCard = await reserve(e, 20_000_000);
    assert.equal(withCard.ok, true, JSON.stringify(withCard));
    const eAfter = await rpc("entitlements", { workspace: e });
    assert.equal(eAfter.hasPlan, true);
    assert.ok(eAfter.ceilingMicros > 0, JSON.stringify(eAfter));
    passed("charged past the allowance, with a card: work past it is admitted under the workspace's own limits");

    // Revocation: back to Free now, subscription canceled.
    const revoked = await rpc("admin_end_complimentary", { workspace: d, note: "sandbox audit", by: "audit" });
    assert.equal(revoked.ok, true, JSON.stringify(revoked));
    assert.equal(revoked.value.status, "ended");
    assert.equal((await stripe(`/subscriptions/${dEnrolled.value.subscriptionId}`)).status, "canceled");
    assert.equal((await rpc("entitlements", { workspace: d })).plan, "free");
    passed("ending an enrollment cancels its subscription and returns the workspace to Free");
    writeFileSync(
      resolve(dir, "complimentary-results.json"),
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          stripeAccount: auditAccount.id,
          mode: "sandbox",
          worker: "local",
          checks,
          limitations: ["Webhooks not delivered publicly", "3DS not completed in a browser here", "No test clock renewal of an enrollment"],
        },
        null,
        2,
      ),
    );
  } finally {
    for (const customer of made.filter(Boolean)) {
      try {
        await stripe(`/customers/${customer}`, undefined, "DELETE");
      } catch (error) {
        console.error(`cleanup ${customer}: ${error.message}`);
      }
    }
  }
} else if (phase === "prepay") {
  // A card prepayment end to end: the real Checkout page (3DS is always
  // asked for), then the ledger and tax_and_fees reconciled to the cent
  // against Stripe's charge and balance transaction, before and after a
  // partial refund. The page is paid in a browser while this waits
  // (billing-sandbox-pay.mjs, given the URL it prints and writes to
  // prepay.json); `prepay resume` picks that page up again. Needs Stripe
  // Tax on in the sandbox, with a Washington registration.
  const resume = process.argv[3] === "resume" ? JSON.parse(readFileSync(resolve(dir, "prepay.json"), "utf8")) : null;
  const workspace = resume?.workspace ?? `prepay-${Date.now()}`;
  const actor = { id: "usr_audit", username: "audit-owner", verified: true, workspaces: [{ slug: workspace, role: "owner" }] };
  const checks = [];
  const passed = (name) => {
    checks.push(name);
    console.log(`PASS ${name}`);
  };
  assert.equal((await rpc("status", {})).live, false);
  const amountCents = 2_500;
  let customer, sessionId;
  if (resume) {
    customer = { id: resume.customer };
    sessionId = resume.session;
  } else {
    customer = await stripe("/customers", {
      name: "Disposable g1t prepay audit",
      email: "prepay-audit@example.com",
      "metadata[g1t_audit]": workspace,
      "address[country]": "US",
      "address[state]": "WA",
      "address[postal_code]": "98101",
      "address[line1]": "1301 2nd Ave",
      "address[city]": "Seattle",
    });
    localSQL(
      `INSERT INTO accounts (workspace,balance_micros,customer_id,created_at) VALUES ('${workspace}',0,'${customer.id}','${new Date().toISOString()}');`,
    );
    const started = await rpc("checkout", { workspace, actor, amountCents, returnUrl: `${endpoint}/return` });
    assert.equal(started.ok, true, JSON.stringify(started));
    const url = started.value.url;
    sessionId = url.match(/cs_test_[A-Za-z0-9]+/)[0];
    writeFileSync(resolve(dir, "prepay.json"), JSON.stringify({ workspace, customer: customer.id, session: sessionId, url }));
    console.log(`PAY ${url}`);
  }
  let session;
  for (const deadline = Date.now() + 10 * 60_000; ; ) {
    session = await stripe(`/checkout/sessions/${sessionId}`);
    if (session.payment_status === "paid") break;
    assert.ok(Date.now() < deadline, "The prepay page was not paid within 10 minutes");
    await new Promise((r) => setTimeout(r, 3_000));
  }
  assert.equal(session.amount_subtotal, amountCents);
  const taxCents = session.total_details.amount_tax;
  assert.ok(taxCents > 0, "No tax: turn on Stripe Tax in the sandbox, with a Washington registration (Colorado exempts this product)");
  passed("Checkout page paid in the browser, through its 3DS challenge");
  const completed = signed({ id: `evt_local_prepay_${workspace}`, type: "checkout.session.completed", livemode: false, data: { object: session } });
  assert.equal((await rpc("stripe_webhook", completed)).ok, true);
  assert.equal((await rpc("stripe_webhook", completed)).ok, true);
  const account = () => rpc("account", { workspace, viewer: actor }).then((a) => a.value.balanceMicros);
  assert.equal(await account(), amountCents * 10_000);
  passed("prepayment credited once, at the amount before tax");
  // The balance transaction can trail the charge by a few seconds.
  let charge, txn;
  for (let tries = 0; !txn; tries++) {
    assert.ok(tries < 20, "Stripe made no balance transaction for the charge");
    if (tries) await new Promise((r) => setTimeout(r, 2_000));
    charge = (await stripe(`/payment_intents/${session.payment_intent}?expand[]=latest_charge.balance_transaction`)).latest_charge;
    txn = charge.balance_transaction;
  }
  const ledger = (kind) => localRows(`SELECT COALESCE(SUM(amount_micros),0) AS m FROM ledger WHERE workspace='${workspace}' AND kind='${kind}'`)[0].m;
  const extras = (kind) => localRows(`SELECT COALESCE(SUM(amount_micros),0) AS m FROM tax_and_fees WHERE workspace='${workspace}' AND kind='${kind}'`)[0].m;
  assert.equal(ledger("top_up"), amountCents * 10_000);
  assert.equal(extras("tax"), taxCents * 10_000);
  assert.equal(extras("card_fee"), 0, "No card fee line since the fee was folded into prices");
  assert.equal(txn.amount, charge.amount);
  assert.equal(ledger("top_up") + extras("tax"), txn.amount * 10_000);
  passed(
    `ledger top_up ($${amountCents / 100}) + tax ($${taxCents / 100}) = Stripe balance transaction ($${txn.amount / 100}); Stripe's fee $${txn.fee / 100} recorded nowhere`,
  );
  const refundCents = 1_000;
  await stripe("/refunds", { charge: charge.id, amount: String(refundCents) });
  const refundedCharge = await stripe(`/charges/${charge.id}`);
  const refunded = signed({ id: `evt_local_prepay_refund_${workspace}`, type: "charge.refunded", livemode: false, data: { object: refundedCharge } });
  assert.equal((await rpc("stripe_webhook", refunded)).ok, true);
  assert.equal((await rpc("stripe_webhook", refunded)).ok, true);
  const taxBack = Math.floor((refundCents * taxCents) / charge.amount);
  assert.equal(await account(), (amountCents - (refundCents - taxBack)) * 10_000);
  assert.equal(extras("tax"), (taxCents - taxBack) * 10_000);
  assert.equal(ledger("top_up") + extras("tax"), (refundedCharge.amount - refundedCharge.amount_refunded) * 10_000);
  passed(`partial refund ($${refundCents / 100}, $${taxBack / 100} of it tax) reversed once and in proportion; ledger + tax = what Stripe kept`);
  await stripe(`/customers/${customer.id}`, undefined, "DELETE");
  writeFileSync(
    resolve(dir, "prepay-results.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        mode: "sandbox",
        worker: "local",
        workspace,
        session: sessionId,
        charge: charge.id,
        amounts: { prepaidCents: amountCents, taxCents, chargedCents: charge.amount, stripeFeeCents: txn.fee, refundCents, refundTaxCents: taxBack },
        checks,
        limitations: ["Locally signed delivery, not public webhook transport", "No production deployment"],
      },
      null,
      2,
    ),
  );
} else if (phase === "cleanup") {
  const { customer } = JSON.parse(readFileSync(fixturePath, "utf8"));
  await stripe(`/customers/${customer}`, undefined, "DELETE");
  console.log("Disposable sandbox customer removed; live account untouched.");
} else throw Error("Use seed, run or cleanup");
