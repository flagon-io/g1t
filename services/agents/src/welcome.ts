/**
 * @g1t welcomes a person who joins its workspace
 * (docs.g1t.sh/guides/agents/, "After that"): the one time an agent
 * speaks first. On `workspace.member_joined` from identity, the
 * workspace's built-in @g1t opens its direct message with the person and
 * says a short welcome there, as a reply billed like any other, once per
 * person per workspace. Never for the workspace's creator (`how` is
 * `created`), never for an agent or a token, and never twice: the desk
 * claims the welcome under one message id, `welcome:<workspace>:<user>`,
 * in `agent_replies`, whose unique index on (agent_id, message_id) lets a
 * repeated event through once.
 */
import type { ServiceBinding, User } from "@g1t/contracts";

// By path, as the tests load this file under Node, which resolves no package index.
import { chatClient } from "../../../packages/contracts/src/chat.ts";
import { identityClient } from "../../../packages/contracts/src/clients.ts";
import type { G1tEvent, MemberJoinedData } from "../../../packages/contracts/src/events.ts";
import { askerAccess } from "../../../packages/contracts/src/workspace-agents.ts";
import { ensureBuiltin } from "./builtin.ts";
import type { Desk } from "./desk.ts";
import { type Row, periods, selectAgents } from "./store.ts";

/** Someone to welcome: the person and the workspace they joined. */
export type Welcome = { workspace_id: string; workspace: string; user_id: string; username: string };

/**
 * The message id a welcome is claimed under: one per person per workspace,
 * however often the event arrives. It names no message in chat, which
 * surface.ts knows by the `welcome:` prefix.
 */
export function welcomeMessageId(workspaceId: string, userId: string): string {
  return `welcome:${workspaceId}:${userId}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Who an event says to welcome, or null: only a person joining a
 * workspace by invitation or with an invite code (`how`), never its
 * creator, and never an event that leaves out who or where.
 */
export function welcomeFor(event: Pick<G1tEvent, "type" | "data"> | null | undefined): Welcome | null {
  if (!event || event.type !== "workspace.member_joined") return null;
  const data = (event.data ?? {}) as Partial<MemberJoinedData>;
  if (data.how !== "invitation" && data.how !== "joined") return null;
  const workspace_id = text(data.workspaceId);
  const workspace = text(data.workspace)?.toLowerCase() ?? null;
  const user_id = text(data.userId);
  const username = text(data.username);
  if (!workspace_id || !workspace || !user_id || !username) return null;
  return { workspace_id, workspace, user_id, username };
}

export type WelcomeEnv = {
  DB: D1Database;
  CHAT: ServiceBinding;
  IDENTITY: ServiceBinding;
  DESKS: DurableObjectNamespace<Desk>;
};

/**
 * Welcomes everyone a batch of events says joined a workspace. Returns
 * how many welcomes were handed to a desk; a failure for one person is
 * logged and the rest go on.
 */
export async function welcome(env: WelcomeEnv, events: G1tEvent[], now = new Date()): Promise<number> {
  let handed = 0;
  for (const event of events) {
    const joined = welcomeFor(event);
    if (!joined) continue;
    try {
      if (await greet(env, joined, now)) handed++;
    } catch (error) {
      console.error("agents: a new member was not welcomed", joined.workspace, joined.username, String(error));
    }
  }
  return handed;
}

/**
 * Opens @g1t's direct message with the person and hands the desk the
 * welcome. False when there is nobody to welcome (no live account, or
 * not a person), no @g1t, or it has welcomed them already.
 */
async function greet(env: WelcomeEnv, joined: Welcome, now: Date): Promise<boolean> {
  const [person] = await identityClient(env.IDENTITY)
    .usersForAudience([joined.user_id])
    .catch(() => [] as User[]);
  if (!person || (person.kind ?? "user") !== "user") return false;
  await ensureBuiltin(env.DB, joined.workspace_id);
  const g1t = await env.DB.prepare(selectAgents("a.workspace_id = ?3 AND a.builtin = 1")).bind(...periods(now), joined.workspace_id).first<Row>();
  if (!g1t || g1t.archived_at) return false;
  // Said once. The desk's claim on this id is what holds; this read spares a repeat the DM and the wake.
  const messageId = welcomeMessageId(joined.workspace_id, joined.user_id);
  const said = await env.DB.prepare("SELECT 1 FROM agent_replies WHERE agent_id = ? AND message_id = ?").bind(g1t.id, messageId).first();
  if (said) return false;
  const dm = await chatClient(env.CHAT).openDm(joined.workspace, person, [{ kind: "agent", id: g1t.id }]);
  if (!dm.ok) throw new Error(dm.error.message);
  const desk = env.DESKS.get(env.DESKS.idFromName(g1t.id));
  await desk.take({
    workspace: joined.workspace,
    workspace_id: joined.workspace_id,
    channel_id: dm.value.id,
    channel_kind: "dm",
    channel_name: null,
    agent_id: g1t.id,
    message_id: messageId,
    thread_root: null,
    asked_by: person.id,
    hops: 0,
    asker: askerAccess(person, joined.workspace),
    welcome: true,
  });
  return true;
}
