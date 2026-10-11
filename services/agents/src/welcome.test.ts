import assert from "node:assert/strict";
import { test } from "node:test";

import type { G1tEvent } from "../../../packages/contracts/src/events.ts";
import { welcomeFor, welcomeMessageId } from "./welcome.ts";

const joined = (data: Record<string, unknown>, type = "workspace.member_joined") =>
  ({ type, data }) as unknown as Pick<G1tEvent, "type" | "data">;

const ada = { workspaceId: "wsp_1", workspace: "Acme", userId: "usr_ada", username: "ada", role: "member" };

test("a person who accepted an invitation or used an invite code is welcomed", () => {
  assert.deepEqual(welcomeFor(joined({ ...ada, how: "invitation" })), {
    workspace_id: "wsp_1",
    workspace: "acme",
    user_id: "usr_ada",
    username: "ada",
  });
  assert.deepEqual(welcomeFor(joined({ ...ada, how: "joined", role: "owner" }))?.username, "ada");
});

test("the workspace's creator gets no welcome, and nor does anyone an event leaves unnamed", () => {
  assert.equal(welcomeFor(joined({ ...ada, how: "created", role: "owner" })), null, "they made it");
  assert.equal(welcomeFor(joined({ ...ada })), null, "no door named");
  assert.equal(welcomeFor(joined({ ...ada, how: "added" })), null, "a door this version doesn't know");
  assert.equal(welcomeFor(joined({ ...ada, how: "invitation", userId: "" })), null);
  assert.equal(welcomeFor(joined({ ...ada, how: "invitation", workspace: "  " })), null);
  assert.equal(welcomeFor(joined({ ...ada, how: "invitation", username: undefined })), null);
  assert.equal(welcomeFor(joined({ ...ada, how: "invitation" }, "team.member_added")), null, "a team is not the workspace");
  assert.equal(welcomeFor(joined({ ...ada, how: "invitation" }, "workspace.updated")), null);
  assert.equal(welcomeFor(null), null);
  assert.equal(welcomeFor({ type: "workspace.member_joined", data: undefined } as unknown as Pick<G1tEvent, "type" | "data">), null);
});

test("a welcome is claimed under one id per person per workspace, which names no message in chat", () => {
  assert.equal(welcomeMessageId("wsp_1", "usr_ada"), "welcome:wsp_1:usr_ada");
  // The same event twice, or a second door into the same workspace, is the same claim.
  const first = welcomeFor(joined({ ...ada, how: "invitation" }))!;
  const again = welcomeFor(joined({ ...ada, how: "joined" }))!;
  assert.equal(welcomeMessageId(first.workspace_id, first.user_id), welcomeMessageId(again.workspace_id, again.user_id));
  // Another workspace, or another person, is its own welcome.
  assert.notEqual(welcomeMessageId("wsp_2", "usr_ada"), welcomeMessageId("wsp_1", "usr_ada"));
  assert.notEqual(welcomeMessageId("wsp_1", "usr_bo"), welcomeMessageId("wsp_1", "usr_ada"));
  // The prefix surface.ts reads, so no reaction is tried on a message that does not exist.
  assert.ok(welcomeMessageId("wsp_1", "usr_ada").startsWith("welcome:"));
});
