import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentApproval, ChatSidebarEntry, WorkspaceSession } from "@g1t/contracts";

import { type RecentRow, filterSessions, recentRows, recentSessions, shortRecents } from "./recents.ts";

const session = (id: string, at: string, over: Partial<WorkspaceSession> = {}): WorkspaceSession => ({
  kind: "hosted",
  id,
  repo: "acme/web",
  repoId: "rep_1",
  title: `Session ${id}`,
  actor: "ada",
  harness: "claude_managed_agents",
  agent: null,
  branch: null,
  item: null,
  itemTitle: null,
  pull: null,
  pullTitle: null,
  pullStatus: null,
  state: "active",
  startedAt: at,
  lastActivityAt: at,
  subagents: 0,
  step: null,
  session: null,
  ...over,
});

const waitingOn = (sessionId: string) => ({ sessionId, status: "waiting" }) as AgentApproval;

const dm = (id: string, at: string): ChatSidebarEntry =>
  ({
    channel: { id, kind: "dm", last_message_at: at, created_at: at },
    title: id,
    others: [],
    starred: false,
    muted: false,
    unread: 0,
    mentions: 0,
  }) as unknown as ChatSidebarEntry;

const key = (row: RecentRow) => (row.kind === "dm" ? row.entry.channel.id : row.session.id);

test("Recents' sessions are the viewer's, those on their work items and those waiting on them, each once, newest first", () => {
  const sessions = recentSessions({
    me: "Ada",
    mine: [session("ses_mine", "2026-10-21T12:00:00Z", { state: "ended" }), session("ses_both", "2026-10-21T12:03:00Z")],
    live: [
      session("ses_both", "2026-10-21T12:03:00Z"),
      session("ses_item", "2026-10-21T12:02:00Z", { actor: "bea", item: 4, state: "idle" }),
      session("ses_asks", "2026-10-21T12:01:00Z", { actor: "bea" }),
      session("ses_other", "2026-10-21T12:04:00Z", { actor: "bea", item: 5 }),
      session("run_1", "2026-10-21T12:05:00Z", { kind: "agent", actor: "ada" }),
    ],
    items: [4],
    approvals: [waitingOn("ses_asks")],
  });
  assert.deepEqual(
    sessions.map((s) => [s.id, s.status]),
    [
      ["ses_both", "working"],
      ["ses_item", "idle"],
      ["ses_asks", "waiting"],
      ["ses_mine", "ended"],
    ],
  );
  // The calls could not be read: no session reads as waiting, and one only waiting on the viewer is not listed.
  const unread = recentSessions({ me: "ada", mine: [], live: [session("ses_asks", "2026-10-21T12:01:00Z", { actor: "bea" })], items: [], approvals: null });
  assert.deepEqual(unread, []);
});

test("direct messages and sessions interleave by their latest activity, @g1t's first", () => {
  const sessions = recentSessions({ me: "ada", mine: [session("ses_1", "2026-10-21T12:02:00Z")], live: [], items: [], approvals: null });
  const rows = recentRows(
    [dm("dm_old", "2026-10-21T11:00:00Z"), dm("dm_new", "2026-10-21T12:03:00Z"), dm("dm_g1t", "2026-10-20T09:00:00Z")],
    sessions,
    (entry) => entry.channel.id === "dm_g1t",
  );
  assert.deepEqual(rows.map(key), ["dm_g1t", "dm_new", "ses_1", "dm_old"]);
});

test("Recents is short, but what must stay in view stays; the filter and search reach sessions", () => {
  const rows = recentRows(
    ["a", "b", "c", "d"].map((id, i) => dm(id, `2026-10-21T12:0${9 - i}:00Z`)),
    [],
  );
  const { shown, more } = shortRecents(rows, 2, (row) => key(row) === "d");
  assert.deepEqual(shown.map(key), ["a", "b", "d"]);
  assert.equal(more, 1);
  const sessions = recentSessions({
    me: "ada",
    mine: [session("ses_1", "2026-10-21T12:00:00Z", { title: "Fix login" }), session("ses_2", "2026-10-21T12:01:00Z", { title: "Docs" })],
    live: [],
    items: [],
    approvals: [waitingOn("ses_2")],
  });
  assert.deepEqual(filterSessions(sessions, "all", "").length, 2);
  assert.deepEqual(
    filterSessions(sessions, "unread", "").map((s) => s.id),
    ["ses_2"],
  );
  assert.deepEqual(filterSessions(sessions, "mentions", ""), []);
  assert.deepEqual(
    filterSessions(sessions, "all", "LOGIN").map((s) => s.id),
    ["ses_1"],
  );
});
