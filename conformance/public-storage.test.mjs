import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const source = ["public_storage.rs", "storage_holds.rs"]
  .map((file) => readFileSync(new URL(`../services/repos/src/${file}`, import.meta.url), "utf8"))
  .join("\n");
const sql = (name) => source.match(new RegExp(`const ${name}: &str = "([\\s\\S]*?)";`))[1];
/** The lease, grace and legacy window, as public_storage.rs sets them. */
const constant = (name) =>
  source
    .match(new RegExp(`pub const ${name}: u64 = ([^;]+);`))[1]
    .split("*")
    .reduce((product, part) => product * Number(part.trim().replaceAll("_", "")), 1);
const LEASE_MS = constant("LEASE_MS");
const GRACE_MS = constant("GRACE_MS");
const LEGACY_MS = constant("LEGACY_MS");
function database() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../services/repos/migrations/", import.meta.url);
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(new URL(name, dir), "utf8"));
  return db;
}
function repo(db, id, bytes, workspace = "team", privateRepo = 0) {
  db.prepare("INSERT INTO repos(id,namespace,name,owner_id,stored_bytes,is_private,created_at) VALUES (?,?,?,'owner',?,?,'2026-10-14T00:00:00Z')").run(
    id,
    workspace,
    id,
    bytes,
    privateRepo,
  );
}
const reserve = (db, id, bytes, cap = 5_000_000_000) => db.prepare(sql("RESERVE")).get({ 1: id, 2: bytes, 3: cap });

test("overlapping pushes cannot reserve the same final capacity", () => {
  const db = database();
  repo(db, "first", 4_900_000_000);
  repo(db, "second", 0);
  assert.ok(reserve(db, "first", 80_000_000));
  assert.equal(reserve(db, "second", 80_000_000), undefined);
  assert.ok(reserve(db, "second", 20_000_000));
  assert.equal(reserve(db, "first", 1), undefined);
  assert.equal(db.prepare("SELECT SUM(stored_bytes + storage_reserved_bytes) n FROM repos").get().n, 5_000_000_000);
  assert.equal(db.prepare("SELECT SUM(stored_bytes) n FROM repos").get().n, 4_900_000_000, "reservations are not measured storage billed to customers");
  db.close();
});

test("deleted retained data and interrupted write reservations still consume capacity", () => {
  const db = database();
  repo(db, "retained", 4_950_000_000);
  repo(db, "active", 0);
  db.exec("UPDATE repos SET deleted_at = '2026-10-14T00:00:00Z' WHERE id = 'retained'");
  assert.ok(reserve(db, "active", 50_000_000));
  assert.equal(reserve(db, "active", 1), undefined);
  db.exec("DELETE FROM repos WHERE id = 'retained'");
  assert.ok(reserve(db, "active", 1));
  db.close();
});

test("concurrent visibility changes cannot bypass public capacity", () => {
  const db = database();
  repo(db, "public", 4_000_000_000);
  repo(db, "private_a", 750_000_000, "team", 1);
  repo(db, "private_b", 750_000_000, "team", 1);
  assert.ok(db.prepare(sql("MAKE_PUBLIC")).get({ 1: "private_a", 2: 5_000_000_000 }));
  assert.equal(db.prepare(sql("MAKE_PUBLIC")).get({ 1: "private_b", 2: 5_000_000_000 }), undefined);
  assert.ok(reserve(db, "private_b", 100_000_000));
  assert.equal(db.prepare("SELECT is_private FROM repos WHERE id='private_b'").get().is_private, 1);
  db.close();
});

test("transfer admission uses destination capacity at the moment of mutation", () => {
  const db = database();
  repo(db, "existing", 4_500_000_000, "destination");
  repo(db, "moving", 600_000_000);
  assert.equal(db.prepare(sql("TRANSFER")).get({ 1: "moving", 2: "destination", 3: "team", 4: 5_000_000_000 }), undefined);
  assert.equal(db.prepare("SELECT namespace FROM repos WHERE id='moving'").get().namespace, "team");
  db.exec("DELETE FROM repos WHERE id='existing'");
  assert.ok(db.prepare(sql("TRANSFER")).get({ 1: "moving", 2: "destination", 3: "team", 4: 5_000_000_000 }));
  db.close();
});

test("native copy freezes new source writes until its storage snapshot is taken", () => {
  const db = database();
  repo(db, "source", 100);
  repo(db, "fork", 0);
  db.exec("INSERT INTO storage_copy_locks (repo_id, destination_id, created_at) VALUES ('source','fork','2026-10-14T00:00:00Z')");
  assert.equal(reserve(db, "source", 20), undefined);
  assert.ok(reserve(db, "fork", 100));
  db.exec("DELETE FROM storage_copy_locks WHERE repo_id='source'");
  assert.ok(reserve(db, "source", 20));
  db.close();
});

// --- The ledger (migration 0023) and staff recovery (storage_holds.rs) ---

const CAP = 5_000_000_000;
const HOUR = 3_600_000;
/** A D1 batch: one transaction, every statement or none. */
function batch(db, steps) {
  db.exec("BEGIN");
  try {
    const out = steps.map(([name, args, how = "run"]) => db.prepare(sql(name))[how](...args));
    db.exec("COMMIT");
    return out;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
let grants = 0;
/** public_storage.rs `grant`: a row made or grown, and the sum with it. */
function hold(db, { root, id, bytes, now = 0, target = root, operation = "push", lease = now + LEASE_MS, cap = CAP }) {
  const grant = `grt_${++grants}`;
  const [made] = batch(db, [
    ["HOLD", [root, bytes, cap, id, target, operation, null, grant, new Date(now).toISOString(), now, lease], "get"],
    ["HOLD_SUM", [root, bytes, id, grant]],
  ]);
  return made !== undefined;
}
/**
 * public_storage.rs `grant` with `refusal`: the row, the sum, and whether
 * a copy lock holds the root, in one batch; why it was refused, if it was.
 */
function grant(db, { root, id, bytes, now = 0, lease = now + LEASE_MS, cap = CAP }) {
  const made = `grt_${++grants}`;
  const [held, , locked] = batch(db, [
    ["HOLD", [root, bytes, cap, id, root, "push", null, made, new Date(now).toISOString(), now, lease], "get"],
    ["HOLD_SUM", [root, bytes, id, made]],
    ["COPY_LOCKED", [root], "get"],
  ]);
  if (held !== undefined) return "granted";
  if (locked.locked) return "locked";
  return now > lease ? "overdue" : "full";
}
/** public_storage.rs `settle`. */
const settle = (db, root, id, measured) =>
  batch(db, [
    ["SETTLE_RELEASED", [root, id, measured]],
    ["SETTLE", [root, id, measured]],
    ["SETTLE_ROW", [id]],
  ]);
const end = (db, id, now, refs = []) => db.prepare(sql("END")).run(id, now, "The store answered the push with 500.", JSON.stringify(refs));
const sums = (db, id) => ({
  ...db
    .prepare(
      "SELECT stored_bytes stored, storage_reserved_bytes reserved, (SELECT COALESCE(SUM(bytes), 0) FROM storage_reservations WHERE root_id = ?1) ledger FROM repos WHERE id = ?1",
    )
    .get(id),
});
const recoveries = (db) => db.prepare("SELECT * FROM storage_recoveries ORDER BY released_at, id").all();
function releaseReservation(db, { audit, id, bytes, now }) {
  const root = db.prepare("SELECT root_id FROM storage_reservations WHERE id = ?").get(id)?.root_id ?? "";
  const [written] = batch(db, [
    ["RELEASE_RESERVATION", [audit, id, bytes, "{}", "staff@g1t.sh", "a test", new Date(now).toISOString(), GRACE_MS, now], "get"],
    ["RELEASE_RESERVATION_SUM", [audit, root, bytes]],
    ["RELEASE_RESERVATION_ROW", [audit, id]],
  ]);
  return written !== undefined;
}
function releaseUnledgered(db, { audit, root, bytes, now }) {
  const [written] = batch(db, [
    ["RELEASE_UNLEDGERED", [audit, root, bytes, "{}", "staff@g1t.sh", "a test", new Date(now).toISOString(), LEGACY_MS, now], "get"],
    ["RELEASE_UNLEDGERED_SUM", [audit, root, bytes]],
  ]);
  return written !== undefined;
}
function releaseLock(db, { audit, source, destination, now, legacyDeadline = Number.MAX_SAFE_INTEGER }) {
  const [written] = batch(db, [
    [
      "RELEASE_LOCK",
      [audit, source, destination, "{}", "staff@g1t.sh", "a test", new Date(now).toISOString(), legacyDeadline, GRACE_MS, now, LEGACY_MS],
      "get",
    ],
    ["RELEASE_LOCK_ROW", [audit, source, destination]],
  ]);
  return written !== undefined;
}
const unledgered = (db, root) => db.prepare(sql("UNLEDGERED")).get(10, root)?.bytes ?? 0;
const setEpoch = (db, ms) => db.prepare("UPDATE storage_ledger_epoch SET started_ms = ?, started_at = ?").run(ms, new Date(ms).toISOString());

test("ledger rows admit exactly what the one-statement reservation admitted", () => {
  const db = database();
  repo(db, "first", 4_900_000_000);
  repo(db, "second", 0);
  assert.ok(hold(db, { root: "first", id: "srv_a", bytes: 80_000_000 }));
  assert.equal(hold(db, { root: "second", id: "srv_b", bytes: 80_000_000 }), false);
  assert.ok(hold(db, { root: "second", id: "srv_c", bytes: 20_000_000 }));
  assert.equal(hold(db, { root: "first", id: "srv_d", bytes: 1 }), false);
  assert.equal(reserve(db, "first", 1), undefined, "and the old statement agrees");
  assert.equal(db.prepare("SELECT SUM(stored_bytes + storage_reserved_bytes) n FROM repos").get().n, CAP);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM storage_reservations").get().n, 2, "a refused grant leaves no row");
  assert.equal(unledgered(db, "first"), 0, "the sum is the rows");
  db.close();
});

test("a streamed copy grows one row, and only while its lease lasts", () => {
  const db = database();
  repo(db, "fork", 0);
  assert.ok(hold(db, { root: "fork", id: "srv_copy", bytes: 10, now: 0, operation: "fork" }));
  assert.ok(hold(db, { root: "fork", id: "srv_copy", bytes: 15, now: HOUR, lease: LEASE_MS }));
  assert.equal(hold(db, { root: "fork", id: "srv_copy", bytes: 5, now: LEASE_MS + 1, lease: LEASE_MS }), false, "past its lease");
  assert.deepEqual(sums(db, "fork"), { stored: 0, reserved: 25, ledger: 25 });
  end(db, "srv_copy", HOUR);
  assert.equal(hold(db, { root: "fork", id: "srv_copy", bytes: 5, now: HOUR, lease: LEASE_MS }), false, "an ended write takes no more");
  assert.deepEqual(sums(db, "fork"), { stored: 0, reserved: 25, ledger: 25 });
  db.close();
});

test("a write to a repository being copied into a fork is refused for the lock, and one with no room for the cap", () => {
  const db = database();
  repo(db, "private", 100, "team", 1);
  repo(db, "public", 100);
  repo(db, "fork", 0);
  repo(db, "elsewhere", 4_999_999_000, "full");
  for (const source of ["private", "public"]) db.prepare(sql("LOCK_COPY")).get(source, "fork", "2026-10-21T00:00:00Z", 0, LEASE_MS);
  // A push or a commit from the site, to a private repository or a public
  // one with room: refused, and the lock says why.
  assert.equal(grant(db, { root: "private", id: "srv_private", bytes: 10 }), "locked");
  assert.equal(grant(db, { root: "public", id: "srv_public", bytes: 10 }), "locked");
  // To a public one whose workspace is really full: the cap.
  assert.equal(grant(db, { root: "elsewhere", id: "srv_full", bytes: 10_000 }), "full");
  assert.equal(grant(db, { root: "elsewhere", id: "srv_fits", bytes: 1_000 }), "granted");
  // A streamed copy past its lease, with no lock: neither.
  assert.equal(grant(db, { root: "fork", id: "srv_late", bytes: 1, now: LEASE_MS + 1, lease: LEASE_MS }), "overdue");
  assert.deepEqual(sums(db, "private"), { stored: 100, reserved: 0, ledger: 0 }, "a refusal reserves nothing");
  assert.deepEqual(sums(db, "public"), { stored: 100, reserved: 0, ledger: 0 });
  // Once the copy ends, both take writes again.
  db.exec("DELETE FROM storage_copy_locks");
  assert.equal(grant(db, { root: "private", id: "srv_private", bytes: 10 }), "granted");
  assert.equal(grant(db, { root: "public", id: "srv_public", bytes: 10 }), "granted");
  db.close();
});

test("settling replaces the whole reservation with what was measured", () => {
  const db = database();
  repo(db, "fork", 0);
  repo(db, "other", 0);
  assert.ok(hold(db, { root: "other", id: "srv_other", bytes: 40 }));
  // A native fork reserves its source's measured and in-flight bytes, and
  // stores the measured: the in-flight share goes with the reservation.
  assert.ok(hold(db, { root: "fork", id: "srv_fork", bytes: 100 + 30, operation: "fork" }));
  settle(db, "fork", "srv_fork", 100);
  assert.deepEqual(sums(db, "fork"), { stored: 100, reserved: 0, ledger: 0 });
  assert.deepEqual(sums(db, "other"), { stored: 0, reserved: 40, ledger: 40 }, "another write's reservation is untouched");
  db.close();
});

test("a write the store refused gives its reservation back and counts nothing, public or private", () => {
  const db = database();
  repo(db, "public", 1_000);
  repo(db, "private", 2_000, "team", 1);
  for (const root of ["public", "private"]) {
    // A merge tried three times, its branch moved each time: each attempt
    // reserves its pack and is released with nothing measured.
    for (const attempt of [1, 2, 3]) {
      assert.ok(hold(db, { root, id: `srv_${root}_${attempt}`, bytes: 400, operation: "merge" }));
      settle(db, root, `srv_${root}_${attempt}`, 0);
    }
    // And the store took the fourth.
    assert.ok(hold(db, { root, id: `srv_${root}_4`, bytes: 400, operation: "merge" }));
    settle(db, root, `srv_${root}_4`, 400);
  }
  assert.deepEqual(sums(db, "public"), { stored: 1_400, reserved: 0, ledger: 0 });
  assert.deepEqual(sums(db, "private"), { stored: 2_400, reserved: 0, ledger: 0 }, "private storage is billed from stored_bytes");
  db.close();
});

test("a write settling after staff released its reservation counts its bytes once and takes nothing else's", () => {
  const db = database();
  repo(db, "public", 0);
  assert.ok(hold(db, { root: "public", id: "srv_slow", bytes: 50, now: 0 }));
  assert.ok(releaseReservation(db, { audit: "srr_1", id: "srv_slow", bytes: 50, now: LEASE_MS + GRACE_MS }));
  assert.ok(hold(db, { root: "public", id: "srv_next", bytes: 70, now: LEASE_MS + GRACE_MS }));
  settle(db, "public", "srv_slow", 50);
  assert.deepEqual(sums(db, "public"), { stored: 50, reserved: 70, ledger: 70 });
  db.close();
});

test("a reservation is released only once its write is provably abandoned, with an audit row", () => {
  const db = database();
  repo(db, "public", 1_000);
  assert.ok(hold(db, { root: "public", id: "srv_held", bytes: 300, now: 0 }));
  assert.ok(hold(db, { root: "public", id: "srv_ended", bytes: 200, now: 0 }));
  // Within its lease, and within the grace after it: never.
  for (const now of [0, HOUR, LEASE_MS, LEASE_MS + GRACE_MS - 1])
    assert.equal(releaseReservation(db, { audit: `srr_${now}`, id: "srv_held", bytes: 300, now }), false, `at ${now}`);
  assert.equal(recoveries(db).length, 0, "a refused release writes nothing");
  // A write that recorded its end may go at once.
  end(db, "srv_ended", 1_000, [["refs/heads/main", "abc"]]);
  assert.ok(releaseReservation(db, { audit: "srr_ended", id: "srv_ended", bytes: 200, now: 2_000 }));
  // One that grew since it was inspected is not the one inspected.
  assert.equal(releaseReservation(db, { audit: "srr_stale", id: "srv_held", bytes: 299, now: LEASE_MS + GRACE_MS }), false);
  assert.ok(releaseReservation(db, { audit: "srr_held", id: "srv_held", bytes: 300, now: LEASE_MS + GRACE_MS }));
  assert.equal(releaseReservation(db, { audit: "srr_again", id: "srv_held", bytes: 300, now: LEASE_MS + GRACE_MS }), false, "once");
  assert.deepEqual(sums(db, "public"), { stored: 1_000, reserved: 0, ledger: 0 }, "stored_bytes, which is billed, is never touched");
  assert.deepEqual(
    recoveries(db).map((row) => [row.id, row.kind, row.reservation_id, row.operation, row.bytes, row.staff]),
    [
      ["srr_ended", "reservation", "srv_ended", "push", 200, "staff@g1t.sh"],
      ["srr_held", "reservation", "srv_held", "push", 300, "staff@g1t.sh"],
    ],
  );
  db.close();
});

test("bytes older code reserved without a row are released only after it can no longer run", () => {
  const db = database();
  repo(db, "public", 0);
  setEpoch(db, 10 * HOUR);
  assert.ok(reserve(db, "public", 500), "older code reserves without a row");
  assert.ok(hold(db, { root: "public", id: "srv_new", bytes: 100, now: 10 * HOUR }));
  assert.equal(unledgered(db, "public"), 500);
  assert.equal(releaseUnledgered(db, { audit: "srr_early", root: "public", bytes: 500, now: 10 * HOUR + LEGACY_MS - 1 }), false);
  assert.equal(releaseUnledgered(db, { audit: "srr_greedy", root: "public", bytes: 600, now: 10 * HOUR + LEGACY_MS }), false, "never a row's bytes");
  assert.ok(releaseUnledgered(db, { audit: "srr_old", root: "public", bytes: 500, now: 10 * HOUR + LEGACY_MS }));
  assert.deepEqual(sums(db, "public"), { stored: 0, reserved: 100, ledger: 100 });
  assert.equal(unledgered(db, "public"), 0);
  db.close();
});

test("a copy lock is released only after its copy can no longer run, and the source takes writes again", () => {
  const db = database();
  repo(db, "source", 100);
  repo(db, "fork", 0);
  db.prepare(sql("LOCK_COPY")).get("source", "fork", "2026-10-14T00:00:00Z", 0, LEASE_MS);
  assert.equal(reserve(db, "source", 20), undefined);
  assert.equal(hold(db, { root: "source", id: "srv_src", bytes: 20 }), false, "the lock holds for ledger rows too");
  assert.equal(releaseLock(db, { audit: "srr_early", source: "source", destination: "fork", now: LEASE_MS + GRACE_MS - 1 }), false);
  assert.ok(releaseLock(db, { audit: "srr_lock", source: "source", destination: "fork", now: LEASE_MS + GRACE_MS }));
  assert.ok(hold(db, { root: "source", id: "srv_src", bytes: 20, now: LEASE_MS + GRACE_MS, lease: 10 * LEASE_MS }));
  assert.equal(recoveries(db)[0].kind, "copy_lock");
  db.close();
});

test("a copy lock older code took, without a lease, waits for the legacy window", () => {
  const db = database();
  repo(db, "source", 100);
  repo(db, "fork", 0);
  setEpoch(db, 100 * HOUR);
  db.exec("INSERT INTO storage_copy_locks (repo_id, destination_id, created_at) VALUES ('source', 'fork', '2026-10-14T00:00:00Z')");
  const deadline = 100 * HOUR + LEGACY_MS;
  assert.equal(
    releaseLock(db, { audit: "srr_1", source: "source", destination: "fork", now: deadline - 1, legacyDeadline: 0 }),
    false,
    "the SQL holds the window itself",
  );
  assert.equal(releaseLock(db, { audit: "srr_2", source: "source", destination: "fork", now: deadline, legacyDeadline: deadline + 1 }), false);
  assert.ok(releaseLock(db, { audit: "srr_3", source: "source", destination: "fork", now: deadline, legacyDeadline: deadline }));
  db.close();
});

test("code running before the migration keeps working against the new schema", () => {
  const db = database();
  repo(db, "public", 0);
  // What 0021's code runs: reserve, finish, release and lock.
  assert.ok(reserve(db, "public", 100));
  db.prepare(
    "UPDATE repos SET stored_bytes = stored_bytes + ?3, storage_reserved_bytes = storage_reserved_bytes - ?2 WHERE id = ?1 AND storage_reserved_bytes >= ?2",
  ).run("public", 100, 60);
  assert.ok(reserve(db, "public", 10));
  db.prepare("UPDATE repos SET storage_reserved_bytes = MAX(0, storage_reserved_bytes - ?2) WHERE id = ?1").run("public", 10);
  const lock = db.prepare("INSERT INTO storage_copy_locks (repo_id, destination_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING RETURNING repo_id");
  assert.ok(lock.get("public", "fork", "2026-10-21T00:00:00Z"));
  db.prepare("DELETE FROM storage_copy_locks WHERE repo_id = ?1 AND destination_id = ?2").run("public", "fork");
  assert.deepEqual(sums(db, "public"), { stored: 60, reserved: 0, ledger: 0 });
  db.close();
});

test("the staff listing finds every kind of hold", () => {
  const db = database();
  repo(db, "public", 0);
  repo(db, "fork", 0);
  assert.ok(reserve(db, "public", 7));
  assert.ok(hold(db, { root: "public", id: "srv_1", bytes: 3 }));
  db.prepare(sql("LOCK_COPY")).get("public", "fork", "2026-10-21T00:00:00Z", 0, LEASE_MS);
  assert.deepEqual(
    db
      .prepare(sql("UNLEDGERED"))
      .all(10, null)
      .map((row) => [row.root_id, row.bytes]),
    [["public", 7]],
  );
  assert.equal(db.prepare(sql("LOCKS")).all(10, null).length, 1);
  assert.equal(db.prepare(sql("RESERVATIONS")).all(10)[0].id, "srv_1");
  assert.equal(db.prepare(sql("SUMS")).get("public").ledger_bytes, 3);
  assert.ok(db.prepare(sql("EPOCH")).get().started_ms > 0, "the migration starts the ledger");
  db.close();
});
