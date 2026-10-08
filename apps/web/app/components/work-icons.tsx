import { CircleCheck, CircleDot, CircleSlash, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";

import type { Issue, Pull } from "@g1t/contracts";

/*
 * The state icons of issues and pull requests, apart from the rest of
 * work.tsx so that a page listing work does not load the Markdown renderer.
 */

export function IssueIcon({
  issue,
  size = 16,
}: {
  issue: Pick<Issue, "state" | "reason">;
  size?: number;
}) {
  if (issue.state === "open") return <CircleDot size={size} className="shrink-0 text-success" />;
  if (issue.reason === "not_planned") {
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
