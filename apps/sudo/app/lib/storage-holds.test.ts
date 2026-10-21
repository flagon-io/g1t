import assert from "node:assert/strict";
import { test } from "node:test";

import type { AdminLogEntry, Result, StorageHold, StorageHoldKind, StorageRecovery } from "@g1t/contracts";

import {
  MAX_REASON,
  RELEASE_ACTION,
  SLOW_COPY_SECONDS,
  blockedSources,
  blockedSummary,
  formatAge,
  formatBytes,
  holdKey,
  operationLabel,
  parseHoldKey,
  parseRelease,
  parseSample,
  releaseAuditEntry,
  releaseHold,
  releasedNotice,
} from "./storage-holds.ts";

test("bytes are shown in the decimal units the storage limits use", () => {
  assert.equal(formatBytes(5_000_000_000), "5 GB");
  assert.equal(formatBytes(1_500_000_000), "1.5 GB");
  assert.equal(formatBytes(100_000_000), "100 MB");
  assert.equal(formatBytes(12_345), "12.3 kB");
  assert.equal(formatBytes(1), "1 byte");
  assert.equal(formatBytes(0), "0 bytes");
  assert.equal(formatBytes(-2_000_000), "-2 MB", "drift can be below zero");
});

test("an age is short, and unledgered bytes have none", () => {
  assert.equal(formatAge(42), "42 s");
  assert.equal(formatAge(3_600 * 5), "5 h");
  assert.equal(formatAge(86_400 * 3), "3 d");
  assert.equal(formatAge(null), "before the ledger");
});

test("a hold's key goes to its link and back", () => {
  assert.deepEqual(parseHoldKey(holdKey("reservation", "srv_01abc")), { kind: "reservation", id: "srv_01abc" });
  assert.deepEqual(parseHoldKey("copy_lock:rep_1"), { kind: "copy_lock", id: "rep_1" });
  for (const bad of [null, "", "srv_1", "nope:srv_1", "reservation:", "reservation:a b", "reservation:x'--"]) {
    assert.equal(parseHoldKey(bad), null, String(bad));
  }
});

test("releasing needs a hold and a reason for the audit row", () => {
  assert.deepEqual(parseRelease("unledgered:rep_9", "  Interrupted push before the ledger, checked upstream "), {
    ok: true,
    value: { kind: "unledgered", id: "rep_9", reason: "Interrupted push before the ledger, checked upstream" },
  });
  assert.equal(parseRelease("unledgered:rep_9", " ").ok, false);
  assert.equal(parseRelease("unledgered:rep_9", "x".repeat(MAX_REASON + 1)).ok, false);
  assert.equal(parseRelease("bogus", "why").ok, false);
});

test("each kind of hold says what wrote it", () => {
  assert.equal(operationLabel("push", "reservation"), "a push over git");
  assert.equal(operationLabel(null, "unledgered"), "writes from before the ledger began");
  assert.equal(operationLabel("fork", "copy_lock"), "a fork copying its source");
  assert.equal(operationLabel("later", "reservation"), "later");
});

test("a drift sample is 1 to 20 repositories", () => {
  assert.equal(parseSample("7"), 7);
  assert.equal(parseSample("0"), 1);
  assert.equal(parseSample("500"), 20);
  assert.equal(parseSample(""), 5);
});

function recovery(path: string | null, kind: StorageHoldKind = "reservation"): StorageRecovery {
  const hold: StorageHold = {
    kind,
    id: "srv_1",
    repo: { id: "rep_1", path, private: false, deleted: false },
    target: null,
    operation: "push",
    actor: "ana",
    state: "ended",
    bytes: 320_000_000,
    since: "2026-10-21T10:00:00Z",
    ageSeconds: 7200,
    leaseUntil: null,
    outcome: null,
    abandoned: true,
    why: "The push recorded that it stopped.",
    releasableAt: null,
  };
  return {
    id: "src_9",
    kind,
    repoId: "rep_1",
    targetId: null,
    reservationId: kind === "reservation" ? "srv_1" : null,
    operation: "push",
    actor: "ana",
    bytes: 320_000_000,
    heldSince: hold.since,
    evidence: { hold, upstream: [], releasable: true, refusal: null },
    staff: "staff@g1t.sh",
    reason: "The push ended with a 500.",
    releasedAt: "2026-10-21T12:00:00Z",
  };
}

const hold = { kind: "reservation" as const, id: "srv_1", reason: "The push ended with a 500." };

/** A release that answers `released`, and an audit log that answers `logged`, each recording its calls. */
function fakes(released: () => Promise<Result<StorageRecovery>>, logged: () => Promise<boolean>) {
  const calls: { release: unknown[][]; log: [AdminLogEntry, string][]; reported: string[] } = { release: [], log: [], reported: [] };
  return {
    calls,
    deps: {
      release: (...args: unknown[]) => {
        calls.release.push(args);
        return released();
      },
      log: (entry: AdminLogEntry, by: string) => {
        calls.log.push([entry, by]);
        return logged();
      },
    },
    report: (message: string) => void calls.reported.push(message),
  };
}

test("a release's audit line is filed under the repository's workspace and names the recovery row", () => {
  const entry = releaseAuditEntry(hold, recovery("acme/site"));
  assert.equal(entry.workspace, "acme");
  assert.equal(entry.account, undefined);
  assert.equal(entry.action, RELEASE_ACTION);
  assert.equal(entry.detail, "Reservation srv_1 on acme/site (rep_1), 320 MB: The push ended with a 500. · storage_recoveries src_9");
  // A copy lock holds no bytes of its own.
  const lock = releaseAuditEntry({ kind: "copy_lock", id: "rep_1" }, recovery("acme/site", "copy_lock"));
  assert.equal(lock.detail, "Copy lock rep_1 on acme/site (rep_1): The push ended with a 500. · storage_recoveries src_9");
});

test("a release names the repository written when it is another, as a fork in another workspace is", () => {
  const forked = recovery("acme/site", "copy_lock");
  forked.targetId = "rep_2";
  forked.evidence!.hold.target = { id: "rep_2", path: "bob/site", private: true, deleted: false };
  const entry = releaseAuditEntry({ kind: "copy_lock", id: "rep_1" }, forked);
  assert.equal(entry.workspace, "acme");
  assert.equal(entry.detail, "Copy lock rep_1 on acme/site (rep_1) → bob/site (rep_2): The push ended with a 500. · storage_recoveries src_9");
  // Without the inspection, the recovery row's own target is named; once gone, it says so.
  const bare = { ...forked, evidence: null };
  assert.match(releaseAuditEntry({ kind: "copy_lock", id: "rep_1" }, bare).detail, /→ repository rep_2 \(gone\)/);
  // A write to the charged repository itself names it once.
  const own = recovery("acme/site");
  own.evidence!.hold.target = own.evidence!.hold.repo;
  assert.doesNotMatch(releaseAuditEntry(hold, own).detail, /→/);
});

test("a release on a repository whose row is gone is filed under storage, not a guessed workspace", () => {
  const entry = releaseAuditEntry(hold, recovery(null));
  assert.equal(entry.account, "storage");
  assert.equal(entry.workspace, undefined);
  assert.match(entry.detail, /repository rep_1 \(gone\)/);
});

test("a release is recorded in the audit log after the repos service released it, naming the staff member", async () => {
  const { calls, deps, report } = fakes(
    async () => ({ ok: true, value: recovery("acme/site") }),
    async () => true,
  );
  const outcome = await releaseHold(deps, hold, "staff@g1t.sh", report);
  assert.equal(outcome.ok && outcome.audited, true);
  assert.deepEqual(calls.release, [["reservation", "srv_1", "staff@g1t.sh", "The push ended with a 500."]]);
  assert.equal(calls.log.length, 1);
  assert.equal(calls.log[0][1], "staff@g1t.sh");
  assert.equal(calls.log[0][0].workspace, "acme");
  assert.deepEqual(calls.reported, []);
});

test("a refused or unanswered release writes no audit line", async () => {
  const refused = fakes(
    async () => ({ ok: false, error: { code: "conflict", message: "It may still be in flight." } }) as Result<StorageRecovery>,
    async () => true,
  );
  assert.deepEqual(await releaseHold(refused.deps, hold, "staff@g1t.sh", refused.report), { ok: false, status: 422, error: "It may still be in flight." });
  assert.equal(refused.calls.log.length, 0);

  const down = fakes(
    () => Promise.reject(new Error("admin_release_storage_hold failed with status 500")),
    async () => true,
  );
  const outcome = await releaseHold(down.deps, hold, "staff@g1t.sh", down.report);
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.status, 502);
  assert.equal(down.calls.log.length, 0);
});

test("a release stands when the audit log fails afterwards: it is reported and logged, never a failure", async () => {
  for (const logged of [() => Promise.reject(new Error("admin_log failed with status 500")), async () => false]) {
    const { calls, deps, report } = fakes(async () => ({ ok: true, value: recovery("acme/site") }), logged);
    const outcome = await releaseHold(deps, hold, "staff@g1t.sh", report);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.audited, false);
    assert.equal(outcome.ok && outcome.recovery.id, "src_9");
    assert.equal(calls.log.length, 1, "written once, never retried");
    assert.equal(calls.reported.length, 1);
    assert.match(calls.reported[0], /reservation:srv_1 released by staff@g1t\.sh \(storage_recoveries src_9\) but not in the audit log/);
  }
});

test("after a release the page says whether the audit log has it", () => {
  assert.equal(releasedNotice(new URLSearchParams("hold=reservation:srv_1")), null);
  const audited = releasedNotice(new URLSearchParams({ done: "released", what: "reservation of 320 MB on srv_1" }));
  assert.equal(audited?.auditMissed, null);
  assert.match(audited?.done ?? "", /^Released reservation of 320 MB on srv_1\. It is in the audit log/);
  const missed = releasedNotice(new URLSearchParams({ done: "released", what: "x", unaudited: "src_9" }));
  assert.equal(missed?.done, "Released x.");
  assert.match(missed?.auditMissed ?? "", /The release is done, but billing did not record it in the audit log.*storage_recoveries src_9/);
  // A row id that is not one is not shown.
  assert.doesNotMatch(releasedNotice(new URLSearchParams({ done: "released", unaudited: "<b>" }))?.auditMissed ?? "", /<b>/);
});

/** A hold as the repos service lists it. */
function listed(over: Partial<StorageHold>): StorageHold {
  return {
    kind: "copy_lock",
    id: "rep_src",
    repo: { id: "rep_src", path: "acme/site", private: true, deleted: false },
    target: { id: "rep_fork", path: "bob/site", private: true, deleted: false },
    operation: "fork",
    actor: null,
    state: null,
    bytes: 0,
    since: "2026-10-21T10:00:00Z",
    ageSeconds: 60,
    leaseUntil: "2026-10-21T11:00:00Z",
    outcome: null,
    abandoned: false,
    why: "The copy may still be running.",
    releasableAt: "2026-10-21T11:15:00Z",
    ...over,
  };
}

test("a copy lock still copying blocks its source's writes, but needs no look until it is slow", () => {
  const now = "2026-10-21T10:01:00Z";
  const fork = listed({
    kind: "reservation",
    id: "srv_fork",
    repo: { id: "rep_fork", path: "bob/site", private: true, deleted: false },
    target: null,
    state: "held",
    bytes: 100,
  });
  const [copying] = blockedSources([listed({}), fork], now);
  assert.equal(copying!.fork?.id, "srv_fork", "its fork's reservation is found by the fork's id");
  assert.equal(copying!.stalled, false);
  assert.equal(copying!.attention, false);
  assert.equal(blockedSummary(blockedSources([listed({})], now)), null);
  const slow = blockedSources([listed({ ageSeconds: SLOW_COPY_SECONDS })], now);
  assert.deepEqual([slow[0]!.stalled, slow[0]!.attention], [false, true]);
  assert.equal(blockedSummary(slow), "A repository takes no writes: its copy into a fork is taking longer than a copy ordinarily does.");
});

test("a copy lock kept after its fork's call failed, or past its lease, stands out", () => {
  const now = "2026-10-21T10:05:00Z";
  // The fork's call failed in a way that may still be copying: its
  // reservation ended, and the lock stays (network.rs).
  const ended = listed({
    kind: "reservation",
    id: "srv_fork",
    repo: { id: "rep_fork", path: "bob/site", private: true, deleted: false },
    target: { id: "rep_fork", path: "bob/site", private: true, deleted: false },
    state: "ended",
    outcome: "fork for acme--site failed: INTERNAL_ERROR",
  });
  const [kept] = blockedSources([listed({ ageSeconds: 300 }), ended], now);
  assert.deepEqual([kept!.stalled, kept!.attention, kept!.fork?.outcome], [true, true, "fork for acme--site failed: INTERNAL_ERROR"]);
  // Another fork's ended reservation is not this lock's.
  const other = { ...ended, repo: { ...ended.repo, id: "rep_other" } };
  assert.equal(blockedSources([listed({ ageSeconds: 300 }), other], now)[0]!.stalled, false);
  // Past its lease, or older code's lock without one.
  assert.equal(blockedSources([listed({ leaseUntil: "2026-10-21T10:00:00Z" })], now)[0]!.stalled, true);
  assert.equal(blockedSources([listed({ leaseUntil: null, ageSeconds: null })], now)[0]!.stalled, true);
  // Oldest first, and reservations are not sources.
  const fork = (id: string) => ({ ...ended, id: `srv_${id}`, repo: { ...ended.repo, id } });
  const two = blockedSources(
    [listed({ id: "rep_a", ageSeconds: 100 }), listed({ id: "rep_b", ageSeconds: 9000, leaseUntil: "2026-10-21T09:00:00Z" }), fork("rep_elsewhere")],
    now,
  );
  assert.deepEqual(
    two.map((source) => source.lock.id),
    ["rep_b", "rep_a"],
  );
  assert.equal(
    blockedSummary(blockedSources([listed({ ageSeconds: 300 }), ended], now)),
    "A repository takes no writes: its copy into a fork did not finish cleanly. A copy that did not finish cleanly keeps its lock until it is released here, once it is provably abandoned.",
  );
  assert.match(blockedSummary(two)!, /^A repository takes no writes/, "only the one past its lease needs a look");
});
