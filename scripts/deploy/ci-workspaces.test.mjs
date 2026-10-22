import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { order, pool, report } from "./ci-workspaces.mjs";

const SCRIPT = fileURLToPath(new URL("./ci-workspaces.mjs", import.meta.url));

test("the apps start first, the longest checks", () => {
  assert.deepEqual(order(["@g1t/contracts", "@g1t/runner", "@g1t/web", "@g1t/og", "@g1t/sudo"]), [
    "@g1t/web",
    "@g1t/sudo",
    "@g1t/contracts",
    "@g1t/runner",
    "@g1t/og",
  ]);
});

test("the pool runs at most its limit at once, and keeps the results in order", async () => {
  let running = 0;
  let most = 0;
  const results = await pool([30, 10, 20, 5, 15], 2, async (ms) => {
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    return ms * 2;
  });
  assert.equal(most, 2);
  assert.deepEqual(results, [60, 20, 40, 10, 30]);
  assert.deepEqual(await pool([], 4, async () => 1), []);
});

test("a passing workspace's output is folded, a failing one's shown with an error", () => {
  const passed = report("test", { workspace: "@g1t/web", code: 0, output: "ok 1\n", seconds: 2.25 });
  assert.match(passed, /^::group::@g1t\/web: test passed in 2\.3s\nok 1\n::endgroup::\n$/);
  const failed = report("typecheck", { workspace: "@g1t/og", code: 2, output: "src/a.ts: error TS2322\n", seconds: 1 });
  assert.doesNotMatch(failed, /::group::/);
  assert.match(failed, /@g1t\/og: typecheck failed \(exit 2\) in 1\.0s\nsrc\/a\.ts: error TS2322\n::error title=@g1t\/og::typecheck failed\n/);
});

test("no workspace to run passes, and no script fails", () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT, "typecheck"]).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT]).status, 1);
});
