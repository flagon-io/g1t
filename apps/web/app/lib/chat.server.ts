import { type ChatSidebar, type Principal, type User, type WorkspaceAgent, shownUsername } from "@g1t/contracts";

import type { Mentionable } from "./chat";
import { chat, identity, workspaceAgents } from "./services.server";

/**
 * Who can be talked to in a workspace: its people and its agents, for
 * mentions and for starting a direct message. Each list is empty, not an
 * error, when its service does not answer: chat and agents may arrive a
 * little after the site does.
 */
export async function workspacePeople(slug: string, viewer: User): Promise<{ people: Mentionable[]; agents: WorkspaceAgent[] }> {
  const [members, agents] = await Promise.all([
    identity.listMembers(slug, viewer).catch(() => null),
    workspaceAgents.list(slug, viewer).catch(() => null),
  ]);
  const people: Mentionable[] = members?.ok
    ? members.value.map((member) => ({
        kind: "user" as const,
        name: member.username,
        display_username: member.display_username ?? null,
        // As chat names them (`memberName`): display name, else the username as they wrote it.
        display_name: member.name?.trim() || shownUsername(member),
        avatar: member.avatar ?? null,
      }))
    : [];
  return { people, agents: agents?.ok ? agents.value.filter((agent) => !agent.archived_at) : [] };
}

/** An agent as a mention: by its handle, with its role beside it. */
export function agentMentionable(agent: WorkspaceAgent): Mentionable {
  return { kind: "agent", name: agent.handle, display_name: agent.display_name, avatar: agent.avatar, role: agent.role };
}

/** The sidebar, or null when chat does not answer. */
export async function sidebarOrNull(slug: string, viewer: User): Promise<ChatSidebar | null> {
  try {
    const result = await chat.sidebar(slug, viewer);
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}

/**
 * Members as a form sends them, `user:<username>` or `agent:<id>`, as the
 * chat service names them: a person by their account id. Anyone who is not
 * a member of the workspace is left out.
 */
export async function principalsFrom(slug: string, viewer: User, fields: string[]): Promise<Principal[]> {
  const usernames = fields.filter((f) => f.startsWith("user:")).map((f) => f.slice(5).toLowerCase());
  const agentIds = fields.filter((f) => f.startsWith("agent:")).map((f) => f.slice(6)).filter(Boolean);
  const members = usernames.length > 0 ? await identity.listMembers(slug, viewer).catch(() => null) : null;
  const known = new Set(members?.ok ? members.value.map((m) => m.username.toLowerCase()) : []);
  const people = await Promise.all(
    usernames
      .filter((name) => known.has(name) && name !== viewer.username.toLowerCase())
      .map((name) => identity.userByUsername(name).catch(() => null)),
  );
  return [
    ...people.filter((user): user is User => user != null).map((user) => ({ kind: "user" as const, id: user.id })),
    ...agentIds.map((id) => ({ kind: "agent" as const, id })),
  ];
}

/** The cookie that remembers the last conversation open, so Chat opens there again. */
export const LAST_CHAT_COOKIE = "g1t_chat";

export function rememberChat(path: string, secure: boolean): string {
  return `${LAST_CHAT_COOKIE}=${encodeURIComponent(path)}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`;
}
