import { CircleCheck, CircleDot, CircleSlash, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";

import type { Pull, WorkItem } from "@g1t/contracts";

/*
 * The state icons of work items and pull requests, apart from the rest of
 * work.tsx so that a page listing work does not load the Markdown renderer.
 */

export function ItemIcon({
  item,
  size = 16,
}: {
  item: Pick<WorkItem, "state" | "reason">;
  size?: number;
}) {
  if (item.state === "open") return <CircleDot size={size} className="shrink-0 text-success" />;
  if (item.reason === "not_planned") {
    return <CircleSlash size={size} className="shrink-0 text-faint" />;
  }
  return <CircleCheck size={size} className="shrink-0 text-merged" />;
}

export function PullIcon({ status, size = 16 }: { status: Pull["status"]; size?: number }) {
  if (status === "merged") return <GitMerge size={size} className="shrink-0 text-merged" />;
  if (status === "closed") {
    return <GitPullRequestClosed size={size} className="shrink-0 text-danger" />;
  }
  if (status === "draft") {
    return <GitPullRequestDraft size={size} className="shrink-0 text-faint" />;
  }
  return <GitPullRequest size={size} className="shrink-0 text-success" />;
}
