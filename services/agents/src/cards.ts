/**
 * Agents' cards in chat that people act on in place
 * (docs.g1t.sh/guides/chat/, "Cards you can act on"): a session's card
 * (message it, stop it, approve more), and an issue an agent drafted (file
 * it, discard it). Chat checks the person can read the conversation and
 * that the card offers the action; this decides whether they may, acts as
 * them, and updates the card for everyone.
 *
 * The rules, decided here in code:
 * - **Stop, message:** anyone who can read the conversation the session
 *   reports in, as they could from its page.
 * - **Approve more:** the workspace's owners only, to a cap above what it
 *   has spent.
 * - **File issue:** whoever presses it files it as themselves, and only if
 *   they can read the repository; the agent files nothing.
 * - **Discard:** whoever asked for it, or an owner.
 * - **Allow, deny** (an Ask-first card, abilities.ts): whoever the agent
 *   acts for, or an owner. Allowing runs the call as the person who
 *   pressed it, and the agent hears the result; a session goes on.
 * - **Ask the owners** (a Request card): anyone; an integration becomes a
 *   Marketplace install request, an ability a notification to the owners.
 */
import {
  type AgentCardAction,
  type CardActionResult,
  type MessageCard,
  type Result,
  type User,
  chatClient,
  fail,
  identityClient,
  newId,
  ok,
  reposClient,
  workClient,
} from "@g1t/contracts";

import { type AbilityRequestRow, abilitiesPath, recordDecision, runAllowed, tellOwnersOfRequest } from "./abilities.ts";
import { canManage } from "./access.ts";
import { abilityCard, draftCard, parseMoney, requestCard } from "./card-views.ts";
import { findAbility, resolveAbilities } from "../../../packages/contracts/src/abilities.ts";
import { CONNECTORS } from "../../../packages/contracts/src/connectors.ts";
import { findListing, openRequest } from "./installs.ts";
import { type Row, definitionOf, isPersonal, periods, selectAgents } from "./store.ts";

export { draftCard, parseMoney } from "./card-views.ts";
import { dollars } from "./money.ts";
import { type SessionEnv, approve, pushInbox, resumeAfterDecision, sessionRow, steer, stop } from "./sessions.ts";

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
  if (a.card.kind === "ability") return abilityAction(env, a, viewer);
  if (a.card.kind === "request") return requestAction(env, a, viewer);
  return fail("invalid", "That card has no such action.");
}

/** The agent a card belongs to, by id. */
async function agentById(db: D1Database, id: string): Promise<Row | null> {
  return db
    .prepare(selectAgents("a.id = ?3"))
    .bind(...periods(new Date()), id)
    .first<Row>();
}

/** Allow or deny an Ask-first call (abilities.ts): whoever the agent acts for, or an owner. */
async function abilityAction(env: SessionEnv, a: AgentCardAction, viewer: User): Promise<Result<CardActionResult>> {
  const db = env.DB;
  const request = await db.prepare("SELECT * FROM agent_ability_requests WHERE id = ?").bind(a.card.ref).first<AbilityRequestRow>();
  if (!request || request.workspace !== a.workspace.toLowerCase() || request.channel_id !== a.channel_id) return fail("not_found", "No such request.");
  if (a.action_id !== "allow" && a.action_id !== "deny") return fail("invalid", "That card has no such action.");
  if (request.status !== "pending") return no(request.status === "denied" ? "It was denied." : "It was already answered.");
  if (request.asked_by !== viewer.id && !canManage(viewer, a.workspace)) return no("Only whoever the agent is working for, or an owner, can answer this.");
  const agent = await agentById(db, request.agent_id);
  if (!agent) return fail("not_found", "The agent is gone.");
  const definition = definitionOf(agent);
  const sections = resolveAbilities({ connectors: CONNECTORS, abilities: definition.abilities, autonomy: definition.autonomy, connected: [request.ability.split(":")[1] ?? ""], personal: isPersonal(agent) });
  const found = findAbility(sections, request.ability);
  const about = {
    agent: agent.display_name,
    asker: await usernameOf(env, request.asked_by),
    rule: found ? `${found.source.name}: ${found.ability.label}` : request.ability,
    level: found?.ability.level ?? ("ask" as const),
    note: null,
    body: bodyOf(request.input),
  };
  const now = new Date().toISOString();
  const update = async (row: AbilityRequestRow) => {
    if (!row.message_id) return;
    await chatClient(env.CHAT)
      .updateAsAgent(row.workspace, row.channel_id, row.agent_id, row.message_id, { card: abilityCard(row, about) })
      .catch((error: unknown) => console.error("agents: an ability card was not updated", row.id, String(error)));
  };
  // Claimed first, so two presses never run it twice.
  const claimed = await db.prepare("UPDATE agent_ability_requests SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(a.action_id === "allow" ? "running" : "denied", viewer.username, now, now, request.id).run();
  if (!claimed.meta.changes) return no("Someone got there first.");
  recordDecision(env, { by: viewer, agent, workspace: a.workspace, request, allowed: a.action_id === "allow" });
  if (a.action_id === "deny") {
    const denied = { ...request, status: "denied", decided_by: viewer.username, decided_at: now };
    await update(denied);
    await resumeAfterDecision(env, request, `@${viewer.username} denied: ${request.summary}. Don't try another way; say so.`);
    return done("Denied. It won't be done.");
  }
  const ran = await runAllowed(env, request, agent, definition, viewer);
  const status = ran.ok ? "allowed" : "failed";
  await db.prepare("UPDATE agent_ability_requests SET status = ?, result = ?, updated_at = ? WHERE id = ?").bind(status, ran.message.slice(0, 20_000), new Date().toISOString(), request.id).run();
  const fresh = { ...request, status, decided_by: viewer.username, decided_at: now, result: ran.message.slice(0, 300) };
  await update(fresh);
  await resumeAfterDecision(env, request, ran.ok ? `@${viewer.username} allowed "${request.summary}", and it ran:\n${ran.message}` : `@${viewer.username} allowed "${request.summary}", but it didn't work: ${ran.message}`);
  return ran.ok ? done(`Allowed. ${ran.message.slice(0, 200)}`) : no(`Allowed, but it didn't work: ${ran.message.slice(0, 300)}`);
}

/** The text a call would write, for the card. */
function bodyOf(input: string): string | null {
  try {
    const args = JSON.parse(input) as { text?: unknown };
    return typeof args.text === "string" && args.text.trim() ? args.text.trim().slice(0, 900) : null;
  } catch {
    return null;
  }
}

async function usernameOf(env: SessionEnv, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [user] = await identityClient(env.IDENTITY)
    .usersForAudience([id])
    .catch(() => [] as User[]);
  return user?.username ?? null;
}

/**
 * Ask the owners, from a Request card: an integration becomes a Marketplace
 * install request (the same one the Marketplace opens); an ability, a
 * notification to the owners with a link to the agent's Abilities tab.
 */
async function requestAction(env: SessionEnv, a: AgentCardAction, viewer: User): Promise<Result<CardActionResult>> {
  if (a.action_id !== "ask") return fail("invalid", "That card has no such action.");
  const ref = a.card.ref ?? "";
  const [kind, agentId, ...rest] = ref.split(":");
  const agent = agentId ? await agentById(env.DB, agentId) : null;
  if (!agent) return fail("not_found", "No such card.");
  const slug = a.workspace.toLowerCase();
  const update = async (card: MessageCard) => {
    await chatClient(env.CHAT)
      .updateAsAgent(slug, a.channel_id, agent.id, a.message_id, { card })
      .catch((error: unknown) => console.error("agents: a request card was not updated", a.message_id, String(error)));
  };
  const who = { id: agent.id, handle: agent.handle, display_name: agent.display_name };
  if (kind === "connector") {
    const connector = CONNECTORS.find((c) => c.id === rest[0]);
    if (!connector) return fail("not_found", "No such integration.");
    if (canManage(viewer, slug)) return no(`You're an owner: connect ${connector.name} from the Marketplace.`);
    const listing = findListing(`integration:${connector.id}`);
    if (!listing) return no(`${connector.name} can't be connected to a workspace yet.`);
    const why = `${agent.display_name} needs it for @${viewer.username}.`;
    const opened = await openRequest(env.DB, agent.workspace_id, newId("ins"), listing, viewer, why);
    if (!opened.ok && opened.error.code !== "conflict") return no(opened.error.message);
    if (opened.ok) {
      await tellOwnersOfRequest(env, { workspace: slug, by: viewer, title: `@${viewer.username} asks you to add ${connector.name}`, body: why, href: `/${slug}/-/marketplace/requests`, id: opened.value.id });
    }
    await update(requestCard({ agent: who, workspace: slug, connector: { id: connector.id, name: connector.name, available: true }, ability: null, why, status: "asked", by: viewer.username }));
    return done(opened.ok ? "Asked. The owners have your request." : "You'd already asked; the owners have it.");
  }
  if (kind === "ability") {
    const abilityId = rest.join(":");
    const definition = definitionOf(agent);
    const sections = resolveAbilities({ connectors: CONNECTORS, abilities: definition.abilities, autonomy: definition.autonomy, connected: CONNECTORS.map((c) => c.id), personal: isPersonal(agent) });
    const found = findAbility(sections, abilityId);
    const label = found ? `${found.source.name}: ${found.ability.label}` : abilityId;
    if (canManage(viewer, slug)) return no(`You're an owner: allow it on ${agent.display_name}'s Abilities tab.`);
    const why = `${agent.display_name} needs it for @${viewer.username}.`;
    await tellOwnersOfRequest(env, { workspace: slug, by: viewer, title: `@${viewer.username} asks you to let ${agent.display_name} ${found ? found.ability.label.toLowerCase() : "do more"}`, body: `${label}. ${why}`, href: abilitiesPath(slug, agent.handle), id: `${agent.id}:${abilityId}:${viewer.id}` });
    await update(requestCard({ agent: who, workspace: slug, connector: null, ability: { id: abilityId, label }, why, status: "asked", by: viewer.username }));
    return done("Asked. The owners have been told.");
  }
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
