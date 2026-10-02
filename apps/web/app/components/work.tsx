import {
  CircleCheck,
  CircleDot,
  CircleSlash,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Form, Link } from "react-router";

import type { Comment, Issue, Pull, State } from "@g1t/contracts";

import { Markdown } from "./markdown";
import { Avatar, Button, Textarea, TimeAgo } from "./ui";

/** Hues for the labels every repository starts with. */
const LABEL_HUES: Record<string, number> = {
  bug: 25,
  feature: 150,
  docs: 240,
  chore: 80,
  question: 310,
};

/** A stable hue for any other label, from its name. */
function hueFor(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

export function Label({ name }: { name: string }) {
  const hue = LABEL_HUES[name] ?? hueFor(name);
  const style: CSSProperties = {
    color: `oklch(0.84 0.11 ${hue})`,
    borderColor: `oklch(0.84 0.11 ${hue} / 0.35)`,
    backgroundColor: `oklch(0.84 0.11 ${hue} / 0.1)`,
  };
  return (
    <span
      style={style}
      className="inline-flex shrink-0 items-center rounded-full border px-2 py-px text-xs font-medium"
    >
      {name}
    </span>
  );
}

export function IssueIcon({
  issue,
  size = 16,
}: {
  issue: Pick<Issue, "state" | "reason">;
  size?: number;
}) {
  if (issue.state === "open") return <CircleDot size={size} className="shrink-0 text-accent" />;
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
  return <GitPullRequest size={size} className="shrink-0 text-accent" />;
}

const PILL = "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium";

/** The large state badge at the top of an issue. */
export function IssueState({ issue }: { issue: Pick<Issue, "state" | "reason"> }) {
  const style =
    issue.state === "open"
      ? "border-accent/30 bg-accent/10 text-accent"
      : issue.reason === "not_planned"
        ? "border-line bg-surface text-muted"
        : "border-merged/30 bg-merged/10 text-merged";
  return (
    <span className={`${PILL} ${style}`}>
      <IssueIcon issue={issue} size={14} />
      {issue.state === "open"
        ? "Open"
        : issue.reason === "not_planned"
          ? "Closed as not planned"
          : "Closed"}
    </span>
  );
}

const PULL_STYLES: Record<Pull["status"], string> = {
  draft: "border-line bg-surface text-muted",
  open: "border-accent/30 bg-accent/10 text-accent",
  merged: "border-merged/30 bg-merged/10 text-merged",
  closed: "border-danger/30 bg-danger/10 text-danger",
};

const PULL_NAMES: Record<Pull["status"], string> = {
  draft: "Draft",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

export function PullState({ status }: { status: Pull["status"] }) {
  return (
    <span className={`${PILL} ${PULL_STYLES[status]}`}>
      <PullIcon status={status} size={14} />
      {PULL_NAMES[status]}
    </span>
  );
}

/** The open and closed switch above a list. `to` is the list's own path. */
export function StateTabs({
  to,
  state,
  query = "",
  action,
}: {
  to: string;
  state: State;
  /** Other query parameters to keep, e.g. `label=bug`. */
  query?: string;
  action?: ReactNode;
}) {
  const link = (value: State) =>
    `${to}?${[value === "open" ? "" : "state=closed", query].filter(Boolean).join("&")}`;
  const tab = (value: State, label: string) => (
    <Link
      to={link(value)}
      className={
        "rounded-md px-3 py-1.5 text-sm transition-colors " +
        (state === value ? "bg-raised font-medium text-fg" : "text-muted hover:text-fg")
      }
    >
      {label}
    </Link>
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex gap-1 rounded-lg border border-line p-1">
        {tab("open", "Open")}
        {tab("closed", "Closed")}
      </div>
      {action}
    </div>
  );
}

/** Comments in order, then the box to add one. */
export function Comments({
  comments,
  canComment,
}: {
  comments: Comment[];
  canComment: boolean;
}) {
  return (
    <div className="space-y-4">
      {comments.map((comment) => (
        <article key={comment.id} className="rounded-xl border border-line bg-surface">
          <header className="flex items-center gap-2 border-b border-line px-4 py-2 text-sm text-muted">
            <Avatar name={comment.author.username} size={18} />
            <span className="font-medium text-fg">{comment.author.username}</span>
            <span>
              commented <TimeAgo at={comment.createdAt} />
            </span>
          </header>
          <div className="px-4 py-3">
            <Markdown source={comment.body} />
          </div>
        </article>
      ))}
      {canComment ? (
        <Form method="post" className="space-y-2" key={comments.length}>
          <input type="hidden" name="action" value="comment" />
          <Textarea name="body" rows={3} required placeholder="Leave a comment. Markdown works." />
          <Button type="submit">Comment</Button>
        </Form>
      ) : (
        <p className="text-sm text-muted">
          <Link to="/login" className="text-fg underline underline-offset-4">
            Sign in
          </Link>{" "}
          to comment.
        </p>
      )}
    </div>
  );
}
