import assert from "node:assert/strict";
import { test } from "node:test";

import { askPage, askWhere, foldAnswer, proposalTitle } from "./ask.ts";

test("the page says which repository, work item or pull request the person is on", () => {
  assert.deepEqual(askPage("/Acme/-/work/12"), { path: "/Acme/-/work/12", workspace: "acme", item: 12 });
  assert.deepEqual(askPage("/acme/-/work"), { path: "/acme/-/work" });
  assert.deepEqual(askPage("/acme/web/pull/3/files"), { path: "/acme/web/pull/3/files", repo: { namespace: "acme", name: "web" }, pull: 3 });
  assert.deepEqual(askPage("/acme/web/tree/main"), { path: "/acme/web/tree/main", repo: { namespace: "acme", name: "web" } });
  // A workspace's own pages, and g1t's, name no repository.
  assert.deepEqual(askPage("/acme/-/chat/general"), { path: "/acme/-/chat/general" });
  assert.deepEqual(askPage("/settings/profile"), { path: "/settings/profile" });
  assert.deepEqual(askPage("/acme"), { path: "/acme" });
  assert.deepEqual(askPage(""), { path: "/" });
});

test("the composer says where the question is asked from", () => {
  assert.equal(askWhere(askPage("/acme/-/work/12")), "On work item #12");
  assert.equal(askWhere(askPage("/acme/web/pull/3")), "On pull request #3");
  assert.equal(askWhere(askPage("/acme/web")), "In web");
  assert.equal(askWhere(askPage("/acme/-/chat")), null);
});

test("an answer's kept lines fold into its steps, each as it last was, and its sources", () => {
  const started = {
    type: "tool" as const,
    id: "step_0_0",
    name: "workspace",
    action: "activity",
    label: "Read activity in acme since 2026-10-12",
    status: "running" as const,
    summary: null,
    link: "https://g1t.sh/acme",
  };
  const folded = foldAnswer([
    started,
    { ...started, id: "step_0_1", name: "repository", action: "list", label: "Listed repositories" },
    { ...started, status: "done", summary: "12 results" },
    { type: "text", text: "ignored" },
    null,
    { type: "sources", sources: [{ title: "#7 Fix login", url: "https://g1t.sh/acme/web/pull/7", cited: true }, { url: 3 }] },
  ]);
  assert.deepEqual(
    folded.steps.map((step) => [step.id, step.status, step.summary]),
    [
      ["step_0_0", "done", "12 results"],
      ["step_0_1", "running", null],
    ],
  );
  assert.equal(folded.sources.length, 1);
  assert.equal(folded.sources[0]!.url, "https://g1t.sh/acme/web/pull/7");
  assert.deepEqual(foldAnswer("junk"), { steps: [], sources: [], proposals: [], kept: {} });
  const kept = foldAnswer([{ type: "proposal", id: "p", repo: "a/b", item: null, title: "x", body: null, mode: "implement", instruction: null }, { type: "proposal_state", id: "p", started: true, session_url: "/s" }]).kept;
  assert.deepEqual(kept, { p: { id: "p", started: true, session_url: "/s" } }, "what a card did comes back with its answer");
});

test("a proposed session is kept once and says what it will do", () => {
  const proposal = { type: "proposal" as const, id: "proposal_0_0", repo: "acme/web", item: 12, title: null, body: null, mode: "implement" as const, instruction: null };
  const folded = foldAnswer([proposal, proposal, { ...proposal, id: "proposal_0_1", item: null, title: "Add a route", mode: "plan" }, { type: "proposal", id: "x", repo: "acme/web" }]);
  assert.deepEqual(folded.proposals.map(proposalTitle), ["Implement #12 in acme/web", "Plan “Add a route” in acme/web"]);
});
