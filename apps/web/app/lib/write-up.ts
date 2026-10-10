/**
 * "Write this up as an artifact" from chat (docs.g1t.sh/guides/artifacts/,
 * "Write a thread up"): where it goes (a space, Private, or shared with
 * the conversation), the agents that can write it, and the message that
 * asks one to. Nothing is written behind anyone's back: the person posts
 * the ask in the thread, as themselves, and the agent answers it the usual
 * way (a session if it needs one, then `create_artifact`). The kind is a
 * doc until slides and the other kinds ship. Pure, so it is tested on its own;
 * components/chat/write-up.tsx draws the dialog.
 */
import type { DocRole, MemberProfile } from "@g1t/contracts";

/** The orchestrator every workspace has: the default writer, and @-mentioning it brings it in. */
export const ORCHESTRATOR = "g1t";

/** The longest title the ask carries. */
const TITLE_MAX = 120;

/** A thread's link, to cite and to share: the conversation's path (lib/chat.ts `channelPath`) with `?thread=`. */
export function threadLink(origin: string, conversationPath: string, rootId: string): string {
  return `${origin.replace(/\/+$/, "")}${conversationPath}?thread=${encodeURIComponent(rootId)}`;
}

export type WritableSpace = { id: string; name: string; is_default: boolean };

/** The spaces a person can add to, not archived, the workspace's General space first. */
export function writableSpaces(
  spaces: readonly { id: string; name: string; viewer_role: DocRole; archived_at: string | null; is_default?: boolean }[],
): WritableSpace[] {
  return spaces
    .filter((s) => (s.viewer_role === "edit" || s.viewer_role === "manage") && !s.archived_at)
    .sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default))
    .map((s) => ({ id: s.id, name: s.name, is_default: !!s.is_default }));
}

/** Where the artifact goes: a space, the asker's Private, or Private shared with the conversation's people. */
export type WriteUpWhere = { kind: "space"; id: string; name: string } | { kind: "private" } | { kind: "conversation" };

/**
 * Where it goes unless the person says otherwise: shared with the
 * conversation in a DM or a private channel; in a public channel, the
 * General space when they can add to it, else their Private.
 */
export function defaultWhere(shared: boolean, spaces: readonly WritableSpace[]): WriteUpWhere {
  if (shared) return { kind: "conversation" };
  const general = spaces.find((s) => s.is_default);
  return general ? { kind: "space", id: general.id, name: general.name } : { kind: "private" };
}

export type WriteUpAgent = { handle: string; name: string };

/** Who can write it: @g1t first (always there to ask), then the agents in this conversation. */
export function writeUpAgents(members: readonly Pick<MemberProfile, "kind" | "name" | "display_name">[]): WriteUpAgent[] {
  const out: WriteUpAgent[] = [{ handle: ORCHESTRATOR, name: ORCHESTRATOR }];
  const seen = new Set([ORCHESTRATOR]);
  for (const member of members) {
    const handle = member.name.toLowerCase();
    if (member.kind !== "agent" || !handle || seen.has(handle)) continue;
    seen.add(handle);
    out.push({ handle, name: member.display_name.trim() || handle });
  }
  return out;
}

/** A title as the ask quotes it: one line, no double quotes, not too long. */
export function cleanTitle(title: string | null | undefined): string {
  const text = String(title ?? "")
    .replace(/\s+/g, " ")
    .replace(/"/g, "'")
    .trim();
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX).trimEnd() : text;
}

/** Where, in the words the agent maps to `create_artifact`'s `where`. */
export function whereWords(where: WriteUpWhere): string {
  if (where.kind === "space") return `in the ${where.name.replace(/\s+/g, " ").trim()} space`;
  if (where.kind === "private") return "privately (just for me)";
  return "shared with this conversation";
}

/** What the person posts in the thread to ask for the artifact. */
export function writeUpMessage(input: { agent: string; where: WriteUpWhere; title?: string | null; link: string }): string {
  const title = cleanTitle(input.title);
  const handle = input.agent.replace(/^@/, "").toLowerCase() || ORCHESTRATOR;
  return `@${handle} write this thread up as an artifact (a doc) ${whereWords(input.where)}${title ? ` titled "${title}"` : ""}. Link this thread as the source: ${input.link}`;
}
