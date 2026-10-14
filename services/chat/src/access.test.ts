import { test } from "node:test";
import assert from "node:assert/strict";

import type { User } from "@g1t/contracts";

import { MAX_REQUEST_NOTE, mayAdmit, mayInviteGuests, mayJoin, mayRead, mayVisit, requestNote, visibilityOf } from "./access.ts";

const person = (over: Partial<User> = {}): User => ({ id: "usr_1", username: "ana", verified: true, ...over });

test("a channel is private, kept to the workspace, or public; a direct message is always private", () => {
  assert.equal(visibilityOf({ kind: "channel", private: 1, public: 0 }), "private");
  assert.equal(visibilityOf({ kind: "channel", private: 0, public: 0 }), "workspace");
  assert.equal(visibilityOf({ kind: "channel", private: 0, public: 1 }), "public");
  // Private wins: a private channel is never open to anyone.
  assert.equal(visibilityOf({ kind: "channel", private: 1, public: 1 }), "private");
  assert.equal(visibilityOf({ kind: "dm", private: 1, public: 1 }), "private");
});

test("who may read: anyone in it; members for a workspace channel; anyone for a public one", () => {
  for (const role of ["owner", "member", null] as const) {
    assert.equal(mayRead("private", role, true), true);
    assert.equal(mayRead("private", role, false), false);
    assert.equal(mayRead("public", role, false), true);
  }
  assert.equal(mayRead("workspace", "member", false), true);
  assert.equal(mayRead("workspace", null, false), false);
  // A guest asked into a workspace channel reads it.
  assert.equal(mayRead("workspace", null, true), true);
});

test("someone outside the workspace taken out of a public channel can't join it again on their own", () => {
  assert.equal(mayJoin("public", null, false, false), true);
  assert.equal(mayJoin("public", null, true, false), false);
  // Members are never kept out this way; leaving or being taken out is not a ban for them.
  assert.equal(mayJoin("public", "member", true, false), true);
  assert.equal(mayJoin("workspace", null, false, false), false);
  assert.equal(mayJoin("private", "owner", false, false), false);
  assert.equal(mayJoin("workspace", "member", false, true), false);
});

test("owners always invite guests; members while the workspace lets them", () => {
  const owner = person({ workspaces: [{ slug: "flagon-io", role: "owner" }] });
  assert.equal(mayInviteGuests(owner, "Flagon-IO"), true);
  const member = (allowed?: boolean) =>
    person({
      workspaces: [
        {
          slug: "flagon-io",
          role: "member",
          ...(allowed === undefined ? {} : { privileges: { members_can_invite_outside_collaborators: allowed } as never }),
        },
      ],
    });
  assert.equal(mayInviteGuests(member(), "flagon-io"), true);
  assert.equal(mayInviteGuests(member(true), "flagon-io"), true);
  assert.equal(mayInviteGuests(member(false), "flagon-io"), false);
  assert.equal(mayInviteGuests(person(), "flagon-io"), false);
  assert.equal(mayInviteGuests(null, "flagon-io"), false);
});

test("only signed-in people with a confirmed address come in as guests", () => {
  assert.equal(mayVisit(person()), null);
  assert.match(mayVisit(null) ?? "", /Sign in/);
  assert.match(mayVisit(person({ verified: false })) ?? "", /Confirm your email/);
  assert.match(mayVisit(person({ kind: "workspace" })) ?? "", /Only people/);
});

test("letting someone in: anyone in the channel for a member; those who invite guests for anyone else", () => {
  assert.equal(mayAdmit(true, true, false), true);
  assert.equal(mayAdmit(false, true, false), false);
  assert.equal(mayAdmit(false, true, true), true);
  assert.equal(mayAdmit(true, false, true), false);
});

test("a request's note is trimmed, cut to length, and null when empty", () => {
  assert.equal(requestNote("  hi  "), "hi");
  assert.equal(requestNote("   "), null);
  assert.equal(requestNote(42), null);
  assert.equal(requestNote("x".repeat(MAX_REQUEST_NOTE + 10))?.length, MAX_REQUEST_NOTE);
});
