import type { Comment } from "@g1t/contracts";

/**
 * Whether the viewer may edit or delete a comment: its author may, and so
 * may someone with the Maintain role or higher (`canModerate`). Notes of
 * what happened are nobody's to change, and a review's verdict stays, so a
 * review can be edited but not deleted. The work service decides; this
 * only says which buttons to show.
 */
export function mayChangeComment(
  comment: Pick<Comment, "kind" | "verdict"> & { author: { id: string } },
  viewerId: string | null | undefined,
  canModerate: boolean,
): { edit: boolean; delete: boolean } {
  const allowed = comment.kind === "comment" && viewerId != null && (comment.author.id === viewerId || canModerate);
  return { edit: allowed, delete: allowed && comment.verdict == null };
}
