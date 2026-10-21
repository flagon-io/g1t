import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_REASON, formatAge, formatBytes, holdKey, operationLabel, parseHoldKey, parseRelease, parseSample } from "./storage-holds.ts";

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
