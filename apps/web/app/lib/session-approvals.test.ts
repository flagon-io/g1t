import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentApproval, InboxItem } from "@g1t/contracts";

import {
  approvalKey,
  approvalOfItem,
  approvalWhat,
  attentionEntries,
  attentionKey,
  readAnswer,
  readApprovalTarget,
  readMessage,
  refusedForGood,
  timeLeft,
  toolName,
} from "./session-approvals.ts";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const approval = (toolUseId: string, askedAt: string, over: Partial<AgentApproval> = {}): AgentApproval => ({
  sessionId: "ses_1",
  repo: "acme/web",
  item: 4,
  toolUseId,
  tool: "bash",
  summary: "bash: npm install",
  status: "waiting",
  startedBy: "ada",
  answeredBy: null,
  askedAt,
  expiresAt: new Date(Date.parse(askedAt) + 600_000).toISOString(),
  ...over,
});

const item = (id: string, updatedAt: string) => ({ id, updatedAt }) as InboxItem;

test("an answer names its call and says allow or deny; only a denial keeps why", () => {
  assert.deepEqual(readAnswer(form({ toolUseId: " sevt_3 ", answer: "allow", note: "ignored" })), { toolUseId: "sevt_3", answer: "allow" });
  assert.deepEqual(readAnswer(form({ toolUseId: "sevt_3", answer: "deny", note: " Use staging. " })), {
    toolUseId: "sevt_3",
    answer: "deny",
    note: "Use staging.",
  });
  assert.deepEqual(readAnswer(form({ toolUseId: "sevt_3", answer: "deny" })), { toolUseId: "sevt_3", answer: "deny" });
  assert.ok("error" in readAnswer(form({ answer: "allow" })));
  assert.ok("error" in readAnswer(form({ toolUseId: "sevt_3", answer: "maybe" })));
});

test("a message is trimmed, and neither empty nor too long", () => {
  assert.deepEqual(readMessage(form({ text: "  Also update the docs.\n" })), { text: "Also update the docs." });
  assert.deepEqual(readMessage(form({ text: "   " })), { error: "Write a message to send." });
  assert.ok("error" in readMessage(form({ text: "x".repeat(4001) })));
  assert.deepEqual(readMessage(form({ text: "x".repeat(4000) })), { text: "x".repeat(4000) });
});

test("a call says how long it has left before g1t declines it", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  assert.equal(timeLeft("2026-10-21T12:09:30Z", now), "10 min left");
  assert.equal(timeLeft("2026-10-21T12:01:00Z", now), "1 min left");
  assert.equal(timeLeft("2026-10-21T12:00:20Z", now), "under a minute left");
  assert.equal(timeLeft("2026-10-21T11:59:00Z", now), "declining now");
  assert.equal(timeLeft("whenever", now), "declining now");
});

test("a call reads as its tool and what it wants to do", () => {
  assert.equal(toolName("bash"), "bash");
  assert.equal(toolName("g1t:work_item"), "work_item (g1t)");
  assert.equal(approvalWhat({ tool: "bash", summary: "bash: npm install" }), "npm install");
  assert.equal(approvalWhat({ tool: "web_fetch", summary: "web_fetch" }), "web_fetch");
});

test("Needs attention holds notifications and waiting calls, newest first, without calls past their time", () => {
  const now = Date.parse("2026-10-21T12:05:00Z");
  const entries = attentionEntries(
    [item("thr_old", "2026-10-21T11:00:00Z"), item("thr_new", "2026-10-21T12:04:00Z")],
    [
      approval("sevt_1", "2026-10-21T12:02:00Z"),
      approval("sevt_late", "2026-10-21T11:50:00Z"),
      approval("sevt_done", "2026-10-21T12:03:00Z", { status: "allowed" }),
    ],
    now,
  );
  assert.deepEqual(entries.map(attentionKey), ["thr_new", "approval:ses_1:sevt_1", "thr_old"]);
});

test("a notification about a waiting call gives way to the call, and one about a call no longer waiting is left out", () => {
  const now = Date.parse("2026-10-21T12:05:00Z");
  const told = (id: string, call: string, updatedAt: string) =>
    ({ id, updatedAt, event: "agent_session.approval_requested", url: `/acme/-/chat/sessions/ses_1#approval-${call}` }) as InboxItem;
  assert.deepEqual(approvalOfItem(told("thr_1", "sevt_1", "2026-10-21T12:02:00Z")), { sessionId: "ses_1", toolUseId: "sevt_1" });
  assert.equal(approvalOfItem({ event: "pull.stalled", url: "/acme/web/pull/1" }), null);
  const items = [told("thr_1", "sevt_1", "2026-10-21T12:02:00Z"), told("thr_2", "sevt_gone", "2026-10-21T12:01:00Z"), item("thr_pr", "2026-10-21T12:00:00Z")];
  // The calls read: the waiting one shows once, as the call; the answered one's notification is left out.
  assert.deepEqual(attentionEntries(items, [approval("sevt_1", "2026-10-21T12:02:00Z")], now).map(attentionKey), ["approval:ses_1:sevt_1", "thr_pr"]);
  // The calls not read (yet, or at all): the notifications show, as links.
  assert.deepEqual(attentionEntries(items, null, now).map(attentionKey), ["thr_1", "thr_2", "thr_pr"]);
  // A call answered here leaves at once, as a call and as a notification.
  const gone = new Set([approvalKey({ sessionId: "ses_1", toolUseId: "sevt_1" })]);
  assert.deepEqual(attentionEntries(items, [approval("sevt_1", "2026-10-21T12:02:00Z")], now, gone).map(attentionKey), ["thr_pr"]);
  assert.deepEqual(attentionEntries(items, null, now, gone).map(attentionKey), ["thr_2", "thr_pr"]);
});

test("an answer from Needs attention names its session's repository and session; a refusal for good drops the card", () => {
  assert.deepEqual(readApprovalTarget(form({ repo: " acme/web ", sessionId: "ses_1" })), { repo: { namespace: "acme", name: "web" }, sessionId: "ses_1" });
  assert.ok("error" in readApprovalTarget(form({ repo: "acme", sessionId: "ses_1" })));
  assert.ok("error" in readApprovalTarget(form({ repo: "acme/web/x", sessionId: "ses_1" })));
  assert.ok("error" in readApprovalTarget(form({ repo: "acme/web" })));
  for (const code of ["conflict", "not_found", "forbidden"]) assert.equal(refusedForGood(code), true, code);
  for (const code of ["unavailable", "invalid", "rate_limited"]) assert.equal(refusedForGood(code), false, code);
});
