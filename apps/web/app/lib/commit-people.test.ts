import assert from "node:assert/strict";
import { test } from "node:test";

import type { Commit, EmailOwner } from "@g1t/contracts";

import { addressesToMatch, coAuthorsOf, contributorPerson, personFor, profileHref, showCommit, shownName } from "./commit-people.ts";

const syntaqx: EmailOwner = { id: "usr_01hx", username: "syntaqx", avatar: "f00d" };

/**
 * What `email_owners` answers (services/identity/src/emails.rs): confirmed
 * addresses and noreply addresses only, so an unconfirmed address, or a
 * noreply address whose id does not match, is simply missing.
 */
const owners: Record<string, EmailOwner> = {
  "syntaqx@gmail.com": syntaqx,
  "01hx0000+syntaqx@users.noreply.g1t.sh": syntaqx,
  "1234abcd+gone@users.noreply.g1t.sh": { id: "usr_ghost", username: "ghost", avatar: null },
};

function commit(name: string, email: string, message = "Change something"): Commit {
  return { hash: "a".repeat(40), treeHash: "b".repeat(40), message, author: { name, email }, parents: [], authoredAt: "2026-10-08T12:00:00Z" };
}

test("a confirmed address is the account, whatever name the commit carries", () => {
  const person = personFor("Chase Pierce", "Syntaqx@Gmail.com ", owners);
  assert.deepEqual(person, { kind: "user", name: "Chase Pierce", username: "syntaqx", avatar: "f00d" });
  assert.equal(shownName(person), "syntaqx");
  assert.equal(profileHref(person), "/u/syntaqx");
});

test("an unconfirmed address matches nobody: the name on the commit, no link", () => {
  // email_owners leaves unconfirmed addresses out of its answer.
  const person = personFor("Chase Pierce", "unconfirmed@example.com", owners);
  assert.deepEqual(person, { kind: "author", name: "Chase Pierce", username: null, avatar: null });
  assert.equal(shownName(person), "Chase Pierce");
  assert.equal(profileHref(person), null);
});

test("the noreply address is the account", () => {
  assert.equal(personFor("syntaqx", "01hx0000+syntaqx@users.noreply.g1t.sh", owners).username, "syntaqx");
});

test("a deleted account's commits are ghost's, with no profile", () => {
  const person = personFor("Gone", "1234abcd+gone@users.noreply.g1t.sh", owners);
  assert.equal(person.kind, "ghost");
  assert.equal(shownName(person), "ghost");
  assert.equal(profileHref(person), null);
});

test("g1t's commits, now and as its agents and queue made them before, are g1t", () => {
  for (const [name, email] of [
    ["g1t", "g1t@users.noreply.g1t.sh"],
    ["g1t agent", "agent@g1t.sh"],
    ["g1t merge queue", "queue@g1t.sh"],
    ["g1t", "mergecheck@g1t.sh"],
  ]) {
    const person = personFor(name, email, {});
    assert.equal(person.kind, "g1t", email);
    assert.equal(shownName(person), "g1t");
    assert.equal(profileHref(person), null);
  }
  // Only g1t's own addresses: a name alone is not enough.
  assert.equal(personFor("g1t agent", "someone@example.com", {}).kind, "author");
});

test("a commit sent to the page carries no address at all", () => {
  const shown = showCommit(
    commit("Chase Pierce", "syntaqx@gmail.com", "Fix it\n\nCo-authored-by: Ada <ada@private.example>\nCo-authored-by: Sam <syntaqx@gmail.com>"),
    owners,
  );
  const sent = JSON.stringify(shown.author) + JSON.stringify(shown.coAuthors);
  assert.ok(!sent.includes("@"), sent);
  assert.equal("email" in shown.author, false);
  assert.deepEqual(
    shown.coAuthors.map((person) => [person.kind, shownName(person)]),
    [
      ["author", "Ada"],
      ["user", "syntaqx"],
    ],
  );
});

test("one question per page: every distinct address, g1t's left out", () => {
  const asked = addressesToMatch([
    commit("A", "Ada@Example.com"),
    commit("A", "ada@example.com", "x\n\nCo-Authored-By: Grace <grace@example.com>"),
    commit("g1t", "g1t@users.noreply.g1t.sh"),
    commit("g1t agent", "agent@g1t.sh"),
    commit("Nobody", ""),
  ]);
  assert.deepEqual(asked.sort(), ["ada@example.com", "grace@example.com"]);
});

test("co-authors are read from the trailers only", () => {
  assert.deepEqual(coAuthorsOf("Subject\n\nCo-authored-by: Ada <ada@x.io>\n"), [{ name: "Ada", email: "ada@x.io" }]);
  assert.deepEqual(coAuthorsOf("Subject\n\nCo-authored-by: Ada <ada@x.io> said hi\n\nThe end."), []);
});

test("contributors and commits show one person the same way", () => {
  const base = { name: "syntaqx", commits: 361, firstAt: "", lastAt: "", weeks: [] };
  const fromTally = contributorPerson({ ...base, kind: "user", username: "syntaqx", avatar: "f00d" });
  const fromCommit = personFor("Chase Pierce", "syntaqx@gmail.com", owners);
  assert.equal(shownName(fromTally), shownName(fromCommit));
  assert.equal(fromTally.avatar, fromCommit.avatar);
  assert.equal(profileHref(fromTally), profileHref(fromCommit));
  assert.equal(contributorPerson({ ...base, kind: "g1t", name: "g1t" }).kind, "g1t");
  assert.equal(contributorPerson({ ...base, kind: "user", username: "ghost" }).kind, "ghost");
  assert.deepEqual(contributorPerson({ ...base, kind: "author", name: "Sam" }), { kind: "author", name: "Sam", username: null, avatar: null });
});
