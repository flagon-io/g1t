import assert from "node:assert/strict";
import { test } from "node:test";

import { draftCard, parseMoney, sessionActions } from "./card-views.ts";

test("money is read the way people type it", () => {
  assert.equal(parseMoney("5"), 5_000_000);
  assert.equal(parseMoney("$12.50"), 12_500_000);
  assert.equal(parseMoney("1,200"), 1_200_000_000);
  assert.equal(parseMoney("0"), null);
  assert.equal(parseMoney("-3"), null);
  assert.equal(parseMoney("5.123"), null);
  assert.equal(parseMoney("lots"), null);
  assert.equal(parseMoney(null), null);
});

test("a draft issue's card offers File and Discard, then shows what happened", () => {
  const draft = { id: "drf_1", repo: "acme/web", title: "CSV export times out", body: "Over 100k rows.", labels: '["bug"]', status: "draft", filed_by: null, number: null };
  const open = draftCard(draft);
  assert.deepEqual(open.actions?.map((a) => a.id), ["file", "discard"]);
  assert.equal(open.owner, "agents");
  assert.equal(open.ref, "drf_1");
  assert.deepEqual(open.fields, [{ label: "Repository", value: "acme/web" }, { label: "Labels", value: "bug" }]);
  const filed = draftCard({ ...draft, status: "filed", filed_by: "dana", number: 42 });
  assert.equal(filed.state, "Filed");
  assert.equal(filed.href, "/acme/web/issues/42");
  assert.deepEqual(filed.actions, [{ id: "open", label: "Open issue", href: "/acme/web/issues/42" }]);
  assert.equal(draftCard({ ...draft, status: "discarded" }).actions, undefined);
});

test("a session's card offers what fits its state", () => {
  const href = "/acme/-/agents/margo/sessions/asn_1";
  assert.deepEqual(sessionActions("working", 2_000_000, 500_000, href).map((a) => a.id), ["steer", "stop", "open"]);
  const approval = sessionActions("needs_approval", 2_000_000, 2_000_000, href);
  assert.deepEqual(approval.map((a) => a.id), ["approve", "stop", "open"]);
  assert.equal(approval[0].input?.kind, "money");
  assert.equal(approval[0].input?.initial, "4.00", "suggests double the cap");
  assert.deepEqual(sessionActions("done", 2_000_000, 1_000_000, href).map((a) => a.id), ["steer", "open"]);
  assert.ok(sessionActions("working", null, 0, href).find((a) => a.id === "stop")?.confirm);
});
