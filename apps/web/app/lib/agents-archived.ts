/**
 * The Archived section of the Agents page (docs.g1t.sh/guides/agents/,
 * "Archive, restore and delete"): what each archived agent's row says
 * about what deleting it would take. Pure, so it is tested on its own.
 */
import type { ArchivedAgent } from "@g1t/contracts";

const COUNTED: [keyof ArchivedAgent["counts"], string, string][] = [
  ["sessions", "session", "sessions"],
  ["replies", "reply", "replies"],
  ["memories", "memory", "memories"],
  ["routines", "routine", "routines"],
];

/** "14 sessions · 231 replies · 3 memories": what is kept about the agent, zeros left out. */
export function countsLine(counts: ArchivedAgent["counts"]): string {
  const parts = COUNTED.filter(([key]) => counts[key] > 0).map(([key, one, many]) => `${counts[key].toLocaleString("en-US")} ${counts[key] === 1 ? one : many}`);
  return parts.length ? parts.join(" · ") : "Nothing recorded";
}

/** Whether what was typed confirms deleting the agent: its handle, with or without the @, in any case. */
export function confirmsHandle(typed: string, handle: string): boolean {
  return typed.trim().replace(/^@/, "").toLowerCase() === handle.toLowerCase();
}
