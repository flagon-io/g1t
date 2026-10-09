/**
 * Agents' cards in chat that people act on in place (docs/WORKSPACE.md,
 * "Cards"): a session's card (message it, stop it, approve more), and an
 * issue an agent drafted (file it, discard it). Chat checks the person can
 * read the conversation and that the card offers the action; this decides
 * whether they may, acts as them, and updates the card for everyone.
 *
 * The rules, decided here in code:
 * - **Stop, message:** anyone who can read the conversation the session
 *   reports in, as they could from its page.
 * - **Approve more:** the workspace's owners only, to a cap above what it
 *   has spent.
 * - **File issue:** whoever presses it files it as themselves, and only if
 *   they can read the repository; the agent files nothing.
 * - **Discard:** whoever asked for it, or an owner.
 */
import {
  type AgentCardAction,
  type CardActionResult,
  type MessageCard,
  type Result,
  type User,
  chatClient,
  fail,
  newId,
  ok,
  reposClient,
  workClient,
} from "@g1t/contracts";

import { canManage } from "./access.ts";
import { draftCard, parseMoney } from "./card-views.ts";

export { draftCard, parseMoney } from "./card-views.ts";
import { dollars } from "./money.ts";
import { type SessionEnv, approve, sessionRow, steer, stop } from "./sessions.ts";

export type DraftRow = {
  id: string;
  agent_id: string;
  workspace_id: string;
  workspace: string;
  channel_id: string;
  message_id: string | null;
  session_id: string | null;
  repo_id: string;
  repo: string;
  title: string;
  body: string;
  labels: string;
  asked_by: string | null;
  status: string;
  filed_by: string | null;
  number: number | null;
  created_at: string;
  updated_at: string;
};

/** Records a draft and posts its card with `post`. Returns the draft's id. */
export async function postDraft(
  env: SessionEnv,
  input: { agent_id: string; workspace_id: string; workspace: string; channel_id: string; session_id: string | null; repo_id: string; repo: string; title: string; body: string; labels: string[]; asked_by: string | null },
  post: (card: MessageCard) => Promise<string | null>,
): Promise<string | null> {
  const id = newId("drf");
  const now = new Date().toISOString();
  const row: DraftRow = { ...input, id, labels: JSON.stringify(input.labels), message_id: null, status: "draft", filed_by: null, number: null, created_at: now, updated_at: now };
  await env.DB.prepare(
    `INSERT INTO agent_drafts (id, agent_id, workspace_id, workspace, channel_id, session_id, repo_id, repo, title, body, labels, asked_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
  )
    .bind(id, row.agent_id, row.workspace_id, row.workspace, row.channel_id, row.session_id, row.repo_id, row.repo, row.title, row.body, row.labels, row.asked_by, now, now)
    .run();
  const messageId = await post(draftCard(row));
  if (!messageId) return null;
  await env.DB.prepare("UPDATE agent_drafts SET message_id = ? WHERE id = ?").bind(messageId, id).run();
  return id;
}

const done = (message: string | null): Result<CardActionResult> => ok({ ok: true, message });
const no = (message: string): Result<CardActionResult> => ok({ ok: false, message });

/** A person pressed an action on one of agents' cards. */
export async function cardAction(env: SessionEnv, a: AgentCardAction): Promise<Result<CardActionResult>> {
  const viewer = a?.viewer as User | undefined;
  if (!viewer || !a.card?.ref) return fail("invalid", "No such card.");
  if (a.card.kind === "session") return sessionAction(env, a, viewer);
  if (a.card.kind === "draft_issue") return draftAction(env, a, viewer);
  return fail("invalid", "That card has no such action.");
}

async function sessionAction(env: SessionEnv, a: AgentCardAction, viewer: User): Promise<Result<CardActionResult>> {
  const row = await sessionRow(env.DB, a.card.ref!);
  // The card is in the conversation the session reports in; chat checked the person reads it.
  if (!row || row.workspace !== a.workspace.toLowerCase() || row.channel_id !== a.channel_id) return fail("not_found", "No such session.");
  const live = ["queued", "working", "waiting", "needs_approval"].includes(row.status);
  switch (a.action_id) {
    case "stop":
      if (!live) return no("It already ended.");
      await stop(env, row, viewer.username);
      return done("Stopped.");
    case "steer": {
      const body = (a.input ?? "").trim();
      if (!body) return no("Say something to it.");
      await steer(env, row, viewer.username, body);
      return done(live ? "It'll read that at its next step." : "It's picking up again with that.");
    }
    case "approve": {
      if (!canManage(viewer, a.workspace)) return no("Only the workspace's owners can approve more spend.");
      if (row.status !== "needs_approval") return no("It isn't waiting for approval.");
      const cap = parseMoney(a.input);
      if (!cap || cap <= row.charged_micros) return no(`The new cap must be more than the ${dollars(row.charged_micros)} it has spent.`);
      await approve(env, row, viewer.username, cap);
      return done(`Approved up to ${dollars(cap)}. It's going on.`);
    }
    default:
      return fail("invalid", "That card has no such action.");
  }
}

async function draftAction(env: SessionEnv, a: AgentCardAction, viewer: User): Promise<Result<CardActionResult>> {
  const db = env.DB;
  const draft = await db.prepare("SELECT * FROM agent_drafts WHERE id = ?").bind(a.card.ref).first<DraftRow>();
  if (!draft || draft.workspace !== a.workspace.toLowerCase() || draft.channel_id !== a.channel_id) return fail("not_found", "No such draft.");
  const update = async (row: DraftRow) => {
    if (!row.message_id) return;
    await chatClient(env.CHAT)
      .updateAsAgent(row.workspace, row.channel_id, row.agent_id, row.message_id, { card: draftCard(row) })
      .catch((error: unknown) => console.error("agents: a draft's card was not updated", row.id, String(error)));
  };
  if (draft.status !== "draft") return no(draft.status === "filed" ? `It's already filed as #${draft.number}.` : "It was discarded.");
  const now = new Date().toISOString();
  if (a.action_id === "discard") {
    if (draft.asked_by !== viewer.id && !canManage(viewer, a.workspace)) return no("Only whoever asked for it, or an owner, can discard it.");
    const claimed = await db.prepare("UPDATE agent_drafts SET status = 'discarded', updated_at = ? WHERE id = ? AND status = 'draft'").bind(now, draft.id).run();
    if (!claimed.meta.changes) return no("Someone got there first.");
    await update({ ...draft, status: "discarded" });
    return done("Discarded.");
  }
  if (a.action_id !== "file") return fail("invalid", "That card has no such action.");
  // Filed as the person who pressed it, only where they can read.
  const [repo] = await reposClient(env.REPOS)
    .readable([draft.repo_id], viewer)
    .catch(() => []);
  if (!repo) return no("You can't file in that repository.");
  // Claimed first, so two presses never file it twice.
  const claimed = await db.prepare("UPDATE agent_drafts SET status = 'filing', updated_at = ? WHERE id = ? AND status = 'draft'").bind(now, draft.id).run();
  if (!claimed.meta.changes) return no("Someone got there first.");
  const agent = await db.prepare("SELECT handle, display_name FROM agents WHERE id = ?").bind(draft.agent_id).first<{ handle: string; display_name: string }>();
  const footer = agent ? `\n\n---\n_Drafted by ${agent.display_name} (@${agent.handle}), filed by @${viewer.username}._` : "";
  let labels: string[] = [];
  try {
    labels = JSON.parse(draft.labels || "[]");
  } catch {
    labels = [];
  }
  const opened = await workClient(env.WORK).openIssue(viewer, { namespace: repo.namespace, name: repo.name }, { title: draft.title, body: `${draft.body}${footer}`, labels });
  if (!opened.ok) {
    await db.prepare("UPDATE agent_drafts SET status = 'draft', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), draft.id).run();
    return no(`It couldn't be filed: ${opened.error.message}`);
  }
  const filed: DraftRow = { ...draft, status: "filed", filed_by: viewer.username, number: opened.value.number };
  await db.prepare("UPDATE agent_drafts SET status = 'filed', filed_by = ?, number = ?, updated_at = ? WHERE id = ?").bind(viewer.username, filed.number, new Date().toISOString(), draft.id).run();
  if (draft.session_id) {
    const row = await sessionRow(db, draft.session_id);
    if (row) {
      const outputs = (() => {
        try {
          return JSON.parse(row.outputs || "[]") as unknown[];
        } catch {
          return [];
        }
      })();
      outputs.push({ kind: "issue", repo: draft.repo, number: filed.number, title: draft.title });
      await db.prepare("UPDATE agent_sessions SET outputs = ? WHERE id = ?").bind(JSON.stringify(outputs.slice(-50)), row.id).run();
    }
  }
  await update(filed);
  return done(`Filed ${draft.repo}#${filed.number}.`);
}
