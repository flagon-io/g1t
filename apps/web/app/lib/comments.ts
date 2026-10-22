import type { Comment } from "@g1t/contracts";

/**
 * Whether the viewer may edit or delete a comment: its author may, and so
 * may someone with the Maintain role or higher (`canModerate`). Notes of
 * what happened are nobody's to change, and a review's verdict stays, so a
 * review can be edited but not deleted. The work service decides; this
 * only says which buttons to show.
 */
export function mayChangeComment(
  comment: Pick<Comment, "kind" | "verdict"> & Partial<Pick<Comment, "advisory">> & { author: { id: string }; actingFor?: { id: string } | null },
  viewerId: string | null | undefined,
  canModerate: boolean,
): { edit: boolean; delete: boolean } {
  // What an agent wrote as itself is answered for by whoever it acted for.
  const answerable = comment.actingFor?.id ?? comment.author.id;
  const allowed = comment.kind === "comment" && viewerId != null && (answerable === viewerId || canModerate);
  return { edit: allowed, delete: allowed && comment.verdict == null && !comment.advisory };
}

/** One entry of a conversation: a comment, or an extra (a session, a claim) drawn between them. */
export type Interleaved<C, X> = { comment: C; extra?: undefined } | { extra: X; comment?: undefined };

/**
 * A conversation in the order things happened, oldest first: its comments
 * as they come (already oldest first), with each extra before the first
 * comment written after it, and those after the last at the end.
 */
export function interleave<C extends { createdAt: string }, X extends { at: string }>(comments: readonly C[], extras: readonly X[]): Interleaved<C, X>[] {
  const later = [...extras].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: Interleaved<C, X>[] = [];
  for (const comment of comments) {
    while (later.length > 0 && Date.parse(later[0]!.at) <= Date.parse(comment.createdAt)) out.push({ extra: later.shift()! });
    out.push({ comment });
  }
  for (const extra of later) out.push({ extra });
  return out;
}
