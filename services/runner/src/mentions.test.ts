import assert from "node:assert/strict";
import { test } from "node:test";

import type { LifecycleJob, MentionJob, Result } from "@g1t/contracts";

import { type MentionPorts, buildMentionPrompt, handleMention, planMention } from "./mentions.ts";

const ana = { id: "usr_ana", username: "ana", verified: true, workspaces: [{ slug: "acme", role: "member" as const }] };

function onIssue(intent: MentionJob["intent"], extra: Partial<MentionJob> = {}): MentionJob {
  return {
    commentId: "cmt_1",
    actor: ana,
    repo: { namespace: "acme", name: "site" },
    number: 7,
    body: "@g1t-agent take this",
    intent,
    member: true,
    defaultBranch: "main",
    issueOpen: true,
    workingPull: null,
    pull: null,
    ...extra,
  };
}

function onPull(intent: MentionJob["intent"], pull: Partial<NonNullable<MentionJob["pull"]>> = {}): MentionJob {
  return onIssue(intent, {
    issueOpen: null,
    pull: {
      id: "pr_1",
      status: "open",
      agentAuthored: true,
      source: { namespace: "acme", name: "site-pr-1" },
      inRepo: false,
      branch: null,
      headCommit: "abc",
      files: ["src/a.ts"],
      ...pull,
    },
  });
}

test("on an issue, a request assigns it and a question is answered", () => {
  assert.equal(planMention(onIssue("work")).kind, "assign");
  assert.equal(planMention(onIssue("question")).kind, "answer");
  assert.equal(planMention(onIssue("work", { issueOpen: false })).kind, "closed");
  // Already at work on it: not a second attempt.
  const busy = planMention(onIssue("work", { workingPull: 9 }));
  assert.equal(busy.kind, "closed");
  assert.match(busy.kind === "closed" ? busy.reason : "", /already working on this in #9/);
  assert.equal(planMention(onIssue("question", { workingPull: 9 })).kind, "answer");
});

test("on g1t-agent's pull request, a request sends it back", () => {
  assert.equal(planMention(onPull("work")).kind, "revise");
  assert.equal(planMention(onPull("work", { status: "draft" })).kind, "message");
  assert.equal(planMention(onPull("question")).kind, "answer");
  assert.equal(planMention(onPull("review")).kind, "review");
  assert.equal(planMention(onPull("work", { status: "merged" })).kind, "closed");
});

test("on anyone else's pull request, it reviews or answers", () => {
  assert.equal(planMention(onPull("review", { agentAuthored: false })).kind, "review");
  assert.equal(planMention(onPull("work", { agentAuthored: false })).kind, "answer");
  assert.equal(planMention(onPull("question", { agentAuthored: false, status: "closed" })).kind, "answer");
});

test("someone without Write on the repository is thanked and nothing starts", async () => {
  const { ports, replies, started } = fakePorts();
  const plan = await handleMention(onIssue("work", { member: false }), ports);
  assert.equal(plan.kind, "not_member");
  assert.deepEqual(started, []);
  assert.match(replies[0], /Putting g1t-agent to work needs the Write role on acme\/[^,]+, so I have left this/);
});

test("a workspace that cannot run agents is told why, and the run is recorded", async () => {
  const { ports, replies, started, recorded } = fakePorts({ refusal: "Its free allowance is used up." });
  await handleMention(onIssue("work"), ports);
  assert.deepEqual(started, []);
  assert.deepEqual(recorded, ["Its free allowance is used up."]);
  assert.match(replies[0], /could not start on this: Its free allowance is used up/);
});

test("a request on an issue assigns it and says where the work is", async () => {
  const { ports, replies, started } = fakePorts();
  await handleMention(onIssue("work"), ports);
  assert.deepEqual(started, ["assign"]);
  assert.match(replies[0], /I opened #12/);
});

test("a revision already under way gets the comment as a message", async () => {
  const { ports, replies, started } = fakePorts({ revision: { ok: false, error: { code: "conflict", message: "busy" } } });
  await handleMention(onPull("work"), ports);
  assert.deepEqual(started, ["message"]);
  assert.match(replies[0], /passed your comment on/);
});

test("a revision starts with the comment, credited to whoever asked", async () => {
  const { ports, started } = fakePorts();
  await handleMention(onPull("work"), ports);
  assert.deepEqual(started, ["revise:ana"]);
});

test("an answer is the reply, so nothing else is said", async () => {
  const { ports, replies, started } = fakePorts();
  await handleMention(onIssue("question"), ports);
  assert.deepEqual(started, ["answer"]);
  assert.deepEqual(replies, []);
});

test("the question is in the prompt, and nothing is to change", () => {
  const prompt = buildMentionPrompt(onIssue("question", { body: "@g1t-agent why is this slow?" }), {
    title: "Search is slow",
    body: "It takes 4s.",
    thread: null,
  });
  assert.match(prompt, /issue #7/);
  assert.match(prompt, /why is this slow\?/);
  assert.match(prompt, /Do not change any files/);
});

function fakePorts(options: { refusal?: string; revision?: Result<LifecycleJob> } = {}) {
  const replies: string[] = [];
  const started: string[] = [];
  const recorded: string[] = [];
  const job = { pullId: "pr_1" } as LifecycleJob;
  const ports: MentionPorts = {
    mentions: {
      takeMention: async () => null,
      mentionRevision: async () => options.revision ?? { ok: true, value: job },
      replyMention: async (_id, body) => {
        replies.push(body);
        return true;
      },
      getAgentRules: async () => ({ ok: true, value: { label: null, updatedBy: null, updatedAt: null } }),
      setAgentRules: async () => ({ ok: true, value: { label: null, updatedBy: null, updatedAt: null } }),
    },
    refusal: async () => options.refusal ?? null,
    assign: async () => {
      started.push("assign");
      return { ok: true, value: { number: 12 } as never };
    },
    revise: async (_job, by) => {
      started.push(`revise:${by}`);
    },
    review: async () => {
      started.push("review");
      return { ok: true, value: true };
    },
    answer: async () => {
      started.push("answer");
      return { ok: true, value: true };
    },
    message: async () => {
      started.push("message");
      return { ok: true, value: null };
    },
    record: async (_job, why) => {
      recorded.push(why);
    },
  };
  return { ports, replies, started, recorded };
}
