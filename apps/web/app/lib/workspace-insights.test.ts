import assert from "node:assert/strict";
import test from "node:test";
import { deliveryDays, deliveryTotals, duration, projectCosts, usageKey } from "./workspace-insights.ts";
import type { DeliveryMetrics, UsageReport } from "@g1t/contracts";

test("workspace averages weight samples rather than averaging project averages", () => {
  const empty: DeliveryMetrics = { repoId: "a", opened: 0, merged: 0, active: 0, unreviewed: 0, checking: 0, failed: 0, queued: 0, leadSeconds: 0, reviewSeconds: 0, reviewed: 0 };
  const total = deliveryTotals([{ ...empty, merged: 1, leadSeconds: 100 }, { ...empty, repoId: "b", merged: 9, leadSeconds: 9000 }]);
  assert.equal(total.leadSeconds / total.merged, 910);
  assert.equal(deliveryTotals([]).merged, 0);
});

test("costs combine meters and products without conflating project keys", () => {
  const report = { products: [{ meters: [{ byProject: [{ project: "a/one", micros: 3 }, { project: "a/two", micros: 7 }] }] }, { meters: [{ byProject: [{ project: "a/one", micros: 11 }] }] }] } as UsageReport;
  assert.deepEqual([...projectCosts(report)], [["a/one", 14], ["a/two", 7]]);
  assert.equal(projectCosts(null).size, 0);
});

test("a project's usage is its repository's, not its slug's", () => {
  assert.equal(usageKey({ namespace: "Acme", name: "Web-App" }), "acme/web-app");
});

test("missing duration is distinct from a fast change", () => {
  assert.equal(duration(null), "—");
  assert.equal(duration(0), "<1m");
  assert.equal(duration(7200), "2.0h");
  assert.equal(duration(172800), "2.0d");
});

test("daily series combines batches and retains quiet days across month boundaries", () => {
  assert.deepEqual(deliveryDays("2026-09-30", "2026-10-02", [{ day: "2026-10-01", merged: 2 }, { day: "2026-10-01", merged: 3 }]), [
    { day: "2026-09-30", merged: 0 }, { day: "2026-10-01", merged: 5 }, { day: "2026-10-02", merged: 0 },
  ]);
});
