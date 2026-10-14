import type { Comment, CommitComment } from "@g1t/contracts";

/**
 * Commit comments in the shape the conversation and the diff show comments
 * in. A commit comment names its author by username, which stands in for the
 * id: compare it with the viewer's username to tell their own.
 */
export function asComments(comments: CommitComment[]): Comment[] {
  return comments.map((comment) => ({
    id: comment.id,
    kind: "comment",
    author: { id: comment.author, username: comment.author },
    body: comment.body,
    path: comment.path,
    line: comment.line,
    verdict: null,
    createdAt: comment.createdAt,
    ...(comment.updatedAt && comment.updatedAt !== comment.createdAt ? { editedAt: comment.updatedAt } : {}),
  }));
}

/** How many comments each commit has, from a list of a repository's comments. */
export function countByCommit(comments: Pick<CommitComment, "commit">[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const comment of comments) counts[comment.commit] = (counts[comment.commit] ?? 0) + 1;
  return counts;
}
