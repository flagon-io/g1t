import { type ChatSidebar, type Principal, type User, shownUsername } from "@g1t/contracts";

import type { Mentionable } from "./chat";
import { chat, identity } from "./services.server";

/**
 * Who can be talked to in a workspace: its people, for mentions and for
 * starting a direct message. Empty, not an error, when identity does not
 * answer.
 */
export async function workspacePeople(slug: string, viewer: User): Promise<Mentionable[]> {
  const members = await identity.listMembers(slug, viewer).catch(() => null);
  return members?.ok
    ? members.value.map((member) => ({
        kind: "user" as const,
        name: member.username,
        display_username: member.display_username ?? null,
        // As chat names them (`memberName`): display name, else the username as they wrote it.
        display_name: member.name?.trim() || shownUsername(member),
        avatar: member.avatar ?? null,
      }))
    : [];
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
 * Members as a form sends them, `user:<username>`, as the chat service
 * names them: a person by their account id. Anyone who is not a member of
 * the workspace is left out, and so is anything that is not a person.
 */
export async function principalsFrom(slug: string, viewer: User, fields: string[]): Promise<Principal[]> {
  const usernames = fields.filter((f) => f.startsWith("user:")).map((f) => f.slice(5).toLowerCase());
  const members = usernames.length > 0 ? await identity.listMembers(slug, viewer).catch(() => null) : null;
  const known = new Set(members?.ok ? members.value.map((m) => m.username.toLowerCase()) : []);
  const people = await Promise.all(
    usernames.filter((name) => known.has(name) && name !== viewer.username.toLowerCase()).map((name) => identity.userByUsername(name).catch(() => null)),
  );
  return people.filter((user): user is User => user != null).map((user) => ({ kind: "user" as const, id: user.id }));
}

/**
 * A person anywhere on g1t, by `user:<username>` (or a bare username), as
 * the chat service names them: by their account id. Null for no one, and
 * for anything that is not a person's account.
 */
export async function personFrom(field: string): Promise<Principal | null> {
  const name = field
    .replace(/^user:/, "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
  if (!name || name.startsWith("usr_")) return null;
  const user = await identity.userByUsername(name).catch(() => null);
  return user && (user.kind ?? "user") === "user" ? { kind: "user", id: user.id } : null;
}

/** The cookie that remembers the last conversation open, so Chat opens there again. */
export const LAST_CHAT_COOKIE = "g1t_chat";

export function rememberChat(path: string, secure: boolean): string {
  return `${LAST_CHAT_COOKIE}=${encodeURIComponent(path)}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`;
}
