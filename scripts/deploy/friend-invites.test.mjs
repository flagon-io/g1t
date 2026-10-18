// node --test "scripts/deploy/*.test.mjs"   (npm run test:deploy)
//
// Invite a friend's statements, run as identity runs them: read out of
// services/identity/src (the constants there are written out in full) and
// run on SQLite, which D1 is, against identity's migrations applied in
// order. Twenty invites each; a revoked one comes back, a used one is
// spent; signing up from the link spends it and records who invited whom.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { ROOT } from "./stack.mjs";

const SRC = join(ROOT, "services", "identity", "src");

/** Every `const NAME: &str = r#"…"#;` in `file`, by name. */
function statements(file) {
  const text = readFileSync(join(SRC, file), "utf8");
  const found = {};
  for (const match of text.matchAll(/const (\w+): &str =\s*r#"([\s\S]*?)"#;/g)) found[match[1]] = match[2];
  return found;
}

const SQL = { ...statements("invites.rs"), ...statements(join("invites", "friends.rs")) };

function migrated() {
  const db = new DatabaseSync(":memory:");
  const dir = join(ROOT, "services", "identity", "migrations");
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(dir, file), "utf8"));
  }
  return db;
}

const LIMIT = 20;
const LATER = "2099-01-01T00:00:00.000Z";
const EARLIER = "2000-01-01T00:00:00.000Z";
let next = 0;

/** Makes an invite to g1t for `inviter` the way `create_invite` does: within the allowance. */
function invite(db, inviter, email, { limit = LIMIT, expiresAt = LATER } = {}) {
  const id = `inv_${++next}`;
  const row = db
    .prepare(SQL.INSERT_WITHIN_ALLOWANCE)
    .get(id, `hash_${id}`, "g1t-abcd", null, email, "account", null, inviter, null, "user", EARLIER, expiresAt, null, null, inviter, limit);
  return row?.id ?? null;
}

const used = (db, inviter) => db.prepare(SQL.USED).get(inviter).n;

test("the statements are all there", () => {
  for (const name of ["INSERT", "INSERT_WITHIN_ALLOWANCE", "USED", "GRANTED", "PENDING_FOR", "REVOKE", "SPEND_CODE", "INSERT_USER_WITH_CODE"]) {
    assert.ok(SQL[name], `${name} not found`);
  }
});

test("twenty invites each: the twenty-first is refused in the statement that writes", () => {
  const db = migrated();
  for (let n = 1; n <= LIMIT; n++) assert.ok(invite(db, "usr_bo", `friend${n}@example.com`), `invite ${n}`);
  assert.equal(used(db, "usr_bo"), LIMIT);
  assert.equal(invite(db, "usr_bo", "one-too-many@example.com"), null);
  // Somebody else's are their own.
  assert.ok(invite(db, "usr_cy", "friend1@example.com"));
  // Invitations into a workspace never count.
  db.prepare(SQL.INSERT).run(
    "inv_ws",
    "hash_ws",
    "g1t-wxyz",
    null,
    "x@example.com",
    "account",
    "wsp_1",
    "usr_bo",
    null,
    "none",
    EARLIER,
    LATER,
    null,
    "member",
  );
  assert.equal(used(db, "usr_bo"), LIMIT);
});

test("revoking an unused invite gives it back; an expired one never counted", () => {
  const db = migrated();
  const ids = [];
  for (let n = 1; n <= LIMIT; n++) ids.push(invite(db, "usr_bo", `friend${n}@example.com`));
  const revoked = db.prepare(SQL.REVOKE).get("usr_bo", ids[0]);
  assert.equal(revoked?.id, ids[0]);
  assert.equal(used(db, "usr_bo"), LIMIT - 1);
  assert.ok(invite(db, "usr_bo", "another@example.com"));
  // Someone else cannot revoke it.
  assert.equal(db.prepare(SQL.REVOKE).get("usr_eve", ids[1]), undefined);
  // An expired, never used invite is not counted.
  const db2 = migrated();
  invite(db2, "usr_bo", "late@example.com", { expiresAt: EARLIER });
  assert.equal(used(db2, "usr_bo"), 0);
});

test("a used invite is spent: revoking it does nothing and it still counts", () => {
  const db = migrated();
  const id = invite(db, "usr_bo", "ada@example.com");
  db.prepare(SQL.SPEND_CODE).run("usr_ada", id);
  db.prepare("UPDATE invites SET applied_at = ? WHERE id = ?").run(EARLIER, id);
  assert.equal(db.prepare(SQL.REVOKE).get("usr_bo", id), undefined);
  assert.equal(used(db, "usr_bo"), 1);
  // Revoked while its account was still confirming: stopped, and still spent.
  const waiting = invite(db, "usr_bo", "cy@example.com");
  db.prepare(SQL.SPEND_CODE).run("usr_cy", waiting);
  assert.equal(db.prepare(SQL.REVOKE).get("usr_bo", waiting)?.id, waiting);
  assert.equal(used(db, "usr_bo"), 2);
});

test("a pending invite for the same address is found; a revoked one is not", () => {
  const db = migrated();
  const id = invite(db, "usr_bo", "ada@example.com");
  assert.equal(db.prepare(SQL.PENDING_FOR).get("usr_bo", "ada@example.com").n, 1);
  assert.equal(db.prepare(SQL.PENDING_FOR).get("usr_cy", "ada@example.com").n, 0);
  db.prepare(SQL.REVOKE).get("usr_bo", id);
  assert.equal(db.prepare(SQL.PENDING_FOR).get("usr_bo", "ada@example.com").n, 0);
});

test("staff grants add to the twenty and can take some back", () => {
  const db = migrated();
  const grant = db.prepare("INSERT INTO invite_grants (id, target_kind, target_id, amount, note, granted_by, created_at) VALUES (?, 'user', ?, ?, ?, ?, ?)");
  grant.run("igr_1", "usr_bo", 10, "launch partner", "staff@example.com", EARLIER);
  grant.run("igr_2", "usr_bo", -3, null, "staff@example.com", EARLIER);
  grant.run("igr_3", "usr_cy", 50, null, "staff@example.com", EARLIER);
  assert.equal(db.prepare(SQL.GRANTED).get("usr_bo").n, 7);
  assert.equal(db.prepare(SQL.GRANTED).get("usr_dee").n, 0);
});

test("signing up from the link spends the invite once and records who invited whom", () => {
  const db = migrated();
  const id = invite(db, "usr_bo", "ada@example.com");
  db.prepare(SQL.SPEND_CODE).run("usr_ada", id);
  db.prepare(SQL.INSERT_USER_WITH_CODE).run("usr_ada", "ada", "ada@example.com", "hash", 1, id);
  const user = db.prepare("SELECT username, email_verified_at FROM users WHERE id = 'usr_ada'").get();
  assert.equal(user.username, "ada");
  // From the email's own link: the address starts confirmed.
  assert.ok(user.email_verified_at);
  const row = db.prepare("SELECT inviter_id, redeemed_by, redeemed_at, sealed_code FROM invites WHERE id = ?").get(id);
  assert.equal(row.inviter_id, "usr_bo");
  assert.equal(row.redeemed_by, "usr_ada");
  assert.ok(row.redeemed_at);
  // A second sign-up with the same code spends nothing and makes no account.
  db.prepare(SQL.SPEND_CODE).run("usr_eve", id);
  db.prepare(SQL.INSERT_USER_WITH_CODE).run("usr_eve", "eve", "eve@example.com", "hash", 0, id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM users WHERE id = 'usr_eve'").get().n, 0);
  assert.equal(db.prepare("SELECT redeemed_by FROM invites WHERE id = ?").get(id).redeemed_by, "usr_ada");
  // Without the proof the address waits to be confirmed like any other.
  const other = invite(db, "usr_bo", "dee@example.com");
  db.prepare(SQL.SPEND_CODE).run("usr_dee", other);
  db.prepare(SQL.INSERT_USER_WITH_CODE).run("usr_dee", "dee", "dee@example.com", "hash", 0, other);
  assert.equal(db.prepare("SELECT email_verified_at FROM users WHERE id = 'usr_dee'").get().email_verified_at, null);
});
