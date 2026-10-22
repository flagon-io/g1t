import assert from "node:assert/strict";
import { test } from "node:test";

import { APPROVAL_WAIT_MS, agentSessionsClient } from "./agent-sessions.ts";
import type { User } from "./identity.ts";

/** A service binding that keeps what it was asked and answers `{ ok: true }`. */
function recording() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const service = {
    async fetch(input: string, init?: RequestInit) {
      calls.push({ method: input.split("/rpc/")[1] ?? "", body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true, value: null }), { headers: { "content-type": "application/json" } });
    },
  };
  return { calls, client: agentSessionsClient(service) };
}

const ada = { id: "usr_a", username: "ada" } as User;
const repo = { namespace: "acme", name: "web" };

test("answers, messages and approvals reach the integrations service as its Rust args read them", async () => {
  const { calls, client } = recording();
  await client.answer(ada, repo, "ses_1", "sevt_3", "deny", "Use staging.");
  await client.answer(ada, repo, "ses_1", "sevt_4", "allow");
  await client.message(ada, repo, "ses_1", "Also update the docs.");
  await client.approvals(ada, "acme");
  await client.approvals(ada, "acme", "ses_1");
  assert.deepEqual(calls, [
    { method: "answer_agent_session", body: { actor: ada, repo, id: "ses_1", tool_use_id: "sevt_3", answer: "deny", note: "Use staging." } },
    { method: "answer_agent_session", body: { actor: ada, repo, id: "ses_1", tool_use_id: "sevt_4", answer: "allow", note: null } },
    { method: "message_agent_session", body: { actor: ada, repo, id: "ses_1", text: "Also update the docs." } },
    { method: "agent_session_approvals", body: { viewer: ada, workspace: "acme", session: null } },
    { method: "agent_session_approvals", body: { viewer: ada, workspace: "acme", session: "ses_1" } },
  ]);
});

test("a request from Chat and a page following a session reach the service as its Rust args read them", async () => {
  const { calls, client } = recording();
  await client.start(ada, repo, { prompt: "Why is CI slow?" });
  await client.follow(repo, "ses_1", ada);
  await client.follow(repo, "ses_1", ada, true);
  assert.deepEqual(calls, [
    {
      method: "start_agent_session",
      body: { actor: ada, repo, item: null, title: null, body: null, instruction: null, prompt: "Why is CI slow?", mode: null, handoff: null },
    },
    { method: "follow_agent_session", body: { repo, id: "ses_1", viewer: ada, waiting: false } },
    { method: "follow_agent_session", body: { repo, id: "ses_1", viewer: ada, waiting: true } },
  ]);
});

test("a call waits ten minutes for an answer, as the service does", () => {
  assert.equal(APPROVAL_WAIT_MS, 600_000);
});
