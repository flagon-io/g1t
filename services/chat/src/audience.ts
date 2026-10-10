/**
 * Which conversations an agent may read from while it answers in one
 * (docs.g1t.sh/guides/agent-access/, "What an agent can and can't
 * know"). Pure, so the rule is tested apart from the service,
 * adversarially.
 *
 * The audience is everyone who will read the answer: a direct message's or
 * private channel's people; for a public channel, the whole workspace. An
 * agent may quote a conversation only when every one of them could read it
 * themselves:
 * - a public channel: always, since anyone in the workspace can open it;
 * - a private channel: when every person in the audience is in it;
 * - a direct message: only when it has exactly the audience's people, so
 *   an agent never carries one DM into another, even with the same person
 *   and someone more.
 * A public channel's audience, or any of more than `SHARED_OVER` people,
 * is the whole workspace: only public channels are readable to it.
 */

export type AudienceKind = "dm" | "private" | "public";

/** Past this many people, an audience is the whole workspace's. */
export const SHARED_OVER = 50;

export type Conversation = { kind: "channel" | "dm"; private: boolean | number; user_ids: string[] };

export function audienceKind(channel: { kind: "channel" | "dm"; private: boolean | number }): AudienceKind {
  if (channel.kind === "dm") return "dm";
  return channel.private ? "private" : "public";
}

/** Whether the audience is the workspace's as a whole. */
export function isShared(audience: { kind: AudienceKind; user_ids: string[] }): boolean {
  return audience.kind === "public" || audience.user_ids.length > SHARED_OVER;
}

/** Whether everyone in `audience` may read `target`. */
export function readableBy(target: Conversation, audience: { kind: AudienceKind; user_ids: string[] }): boolean {
  if (target.kind === "channel" && !target.private) return true;
  if (isShared(audience) || !audience.user_ids.length) return false;
  const members = new Set(target.user_ids);
  if (target.kind === "dm") {
    const people = new Set(audience.user_ids);
    return members.size === people.size && [...people].every((id) => members.has(id));
  }
  return audience.user_ids.every((id) => members.has(id));
}

/** A search's words as a LIKE pattern, its wildcards escaped with `\`. */
export function likePattern(query: string): string | null {
  const words = String(query ?? "").trim().slice(0, 200);
  if (words.length < 2) return null;
  return `%${words.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
