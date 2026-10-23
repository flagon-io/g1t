import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRun, RunnerActivity, UsageReport } from "@g1t/contracts";

import { cloudNow, cloudPrices, machineTime, ownWaiting, perMinute, runnerCost, sizesLine } from "./runners.ts";

function run(id: string, status: AgentRun["status"], over: Partial<AgentRun> = {}): AgentRun {
  return {
    id,
    repo: { namespace: "acme", name: "web" },
    number: 12,
    title: "Fix the flaky checkout test",
    kind: "checks",
    agent: "g1t",
    model: null,
    status,
    step: null,
    steps: [],
    stepCount: 0,
    startedBy: null,
    error: null,
    costUsd: null,
    turns: null,
    createdAt: "2026-10-10T10:00:00Z",
    startedAt: "2026-10-10T10:01:00Z",
    finishedAt: null,
    updatedAt: "2026-10-10T10:02:00Z",
    ...over,
  };
}

const activity: RunnerActivity = {
  cloud_jobs: [{ id: "job_1", name: "test (ubuntu)", run_id: "wr_1", repo: "acme/web", started_at: "2026-10-10T10:05:00Z" }],
  cloud_jobs_queued: 2,
  handed_over: [
    {
      id: "rtk_1",
      run_id: "run_mine",
      kind: "implement",
      title: "On my runner",
      repo: "acme/web",
      status: "in_progress",
      runner_name: "mac",
      created_at: "2026-10-10T09:00:00Z",
      started_at: null,
    },
    {
      id: "rtk_2",
      run_id: null,
      kind: "checks",
      title: "Waiting",
      repo: "acme/web",
      status: "queued",
      runner_name: null,
      created_at: "2026-10-10T09:00:00Z",
      started_at: null,
    },
  ],
  self_hosted_jobs_queued: 3,
};

test("g1t cloud is the running sandbox runs not handed to the workspace's runners, and the jobs in g1t's sandboxes", () => {
  const now = cloudNow([run("run_a", "running"), run("run_mine", "running"), run("run_q", "queued")], activity, 200, 100)!;
  assert.deepEqual(
    now.running.map((work) => [work.kind, work.id, work.href]),
    [
      ["workflow", "job_1", "/acme/web/actions/runs/wr_1"],
      ["agent", "run_a", "/acme/web/pull/12"],
    ],
  );
  // One queued sandbox run and two queued jobs.
  assert.equal(now.queued, 3);
  assert.equal(now.more, false);
});

test("a service that does not answer leaves only its part out", () => {
  assert.equal(cloudNow(null, null, 200, 100), null);
  assert.equal(cloudNow([run("run_a", "running")], null, 200, 100)!.running.length, 1);
  assert.equal(ownWaiting(null), null);
  assert.deepEqual(ownWaiting(activity), { tasks: 1, jobs: 3 });
  assert.equal(runnerCost(null), null);
});

test("a full list says there may be more", () => {
  assert.equal(cloudNow([run("run_a", "running")], activity, 1, 100)!.more, true);
});

test("this month's time adds agent sandbox and sandbox time for g1t cloud, and self-hosted time for the workspace's own", () => {
  const meter = (key: string, quantity: number, micros: number) => ({
    key,
    label: key,
    product: "x",
    unit: "seconds",
    quantity,
    micros,
    daily: [],
    byProject: [],
  });
  const report = {
    from: "2026-10-01",
    until: "2026-10-10",
    free: false,
    products: [
      { key: "agent", label: "Agent", micros: 0, meters: [meter("agent_sandbox", 600, 1_000_000), meter("agent_models", 9, 5_000_000)] },
      {
        key: "sandboxes",
        label: "Sandboxes",
        micros: 0,
        meters: [meter("runner_2-core", 10, 40_000), meter("runner_4-core", 2, 14_000), meter("sandbox", 120, 200_000), meter("self_hosted", 3600, 0)],
      },
    ],
  } as unknown as UsageReport;
  // Runner minutes count as their minutes; older sandbox time by the second.
  assert.deepEqual(runnerCost(report), {
    from: "2026-10-01",
    until: "2026-10-10",
    cloudSeconds: 720 + 12 * 60,
    cloudMicros: 1_254_000,
    ownSeconds: 3600,
    free: false,
  });
});

test("prices are each machine's rate a minute, from the catalogue", () => {
  assert.deepEqual(
    cloudPrices().map((p) => [p.machine, p.perMinuteMicros, p.title]),
    [
      ["2-core", 4000, "2-core: 2 vCPU, 8 GiB, 16 GB"],
      ["1-core", 3000, "1-core: 1 vCPU, 6 GiB, 12 GB"],
    ],
  );
  assert.equal(perMinute(4000), "$0.004");
});

test("machine time and prices read as people say them", () => {
  assert.equal(machineTime(0), "0 min");
  assert.equal(machineTime(45), "45s");
  assert.equal(machineTime(720), "12 min");
  assert.equal(machineTime(12_240), "3.4 h");
  assert.equal(perMinute(1500), "$0.0015");
  assert.equal(perMinute(870), "$0.00087");
  assert.equal(perMinute(0), "$0");
});

test("a runner's row says the sizes it takes, and what their jobs get beyond them", () => {
  assert.equal(sizesLine(undefined), null, "a runner too old to say");
  assert.equal(sizesLine([]), "Takes none of g1t's sizes");
  assert.equal(sizesLine([{ size: "1-core" }, { size: "2-core" }]), "Takes Small, Standard");
  assert.equal(sizesLine([{ size: "2-core", cpus: 4, memory_mib: 16384 }]), "Takes Standard → 4 vCPU · 16 GB");
});
