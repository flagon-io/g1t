import assert from "node:assert/strict";
import { test } from "node:test";

import type { BackupClaim } from "@g1t/contracts";

import { backupEnv, backupPace, backupSandboxName } from "./backup.ts";

const claim: BackupClaim = {
  jobId: "bkp_01",
  token: "secret-token",
  repoId: "repo_1",
  path: { namespace: "acme", name: "rocket" },
};

test("the sandbox gets its job and token, and no git credential", () => {
  const env = backupEnv(claim, "https://api.g1t.sh");
  assert.deepEqual(env, {
    MODE: "backup",
    G1T_API: "https://api.g1t.sh",
    BACKUP_JOB: "bkp_01",
    BACKUP_TOKEN: "secret-token",
  });
  assert.ok(!("G1T_TOKEN" in env) && !("GIT_REMOTE" in env));
});

test("one sandbox per job", () => {
  assert.equal(backupSandboxName(claim), "backup-bkp_01");
  assert.notEqual(backupSandboxName({ ...claim, jobId: "bkp_02" }), backupSandboxName(claim));
});

test("the pace comes from the variables, and 0 turns backups off", () => {
  assert.deepEqual(backupPace(undefined, undefined), { perSweep: 4, running: 6 });
  assert.deepEqual(backupPace("2", "3"), { perSweep: 2, running: 3 });
  assert.deepEqual(backupPace("0", "6"), { perSweep: 0, running: 6 });
  assert.deepEqual(backupPace("many", "-1"), { perSweep: 4, running: 6 });
});
