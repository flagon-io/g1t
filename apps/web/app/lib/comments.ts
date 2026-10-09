import type { Comment } from "@g1t/contracts";

/**
 * Whether the viewer may edit or delete a comment: its author may, and so
 * may someone with the Maintain role or higher (`canModerate`). Notes of
 * what happened are nobody's to change, and a review's verdict stays, so a
 * review can be edited but not deleted. The work service decides; this
 * only says which buttons to show.
 */
export function mayChangeComment(
  comment: Pick<Comment, "kind" | "verdict"> &
    Partial<Pick<Comment, "advisory">> & { author: { id: string }; actingFor?: { id: string } | null },
  viewerId: string | null | undefined,
  canModerate: boolean,
): { edit: boolean; delete: boolean } {
  // What an agent wrote as itself is answered for by whoever it acted for.
  const answerable = comment.actingFor?.id ?? comment.author.id;
  const allowed = comment.kind === "comment" && viewerId != null && (answerable === viewerId || canModerate);
  return { edit: allowed, delete: allowed && comment.verdict == null && !comment.advisory };
}
