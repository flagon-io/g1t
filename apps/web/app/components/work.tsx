import { Bot, CircleCheck, CircleSlash } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Form, Link } from "react-router";

import type { Comment, Issue, Pull, State } from "@g1t/contracts";

import { repoAt } from "../lib/markdown-plugins";
import { Markdown } from "./markdown";
import { IssueIcon, PullIcon } from "./work-icons";
import { MentionTextarea } from "./mention-textarea";
import { Avatar, Button, TimeAgo } from "./ui";
import { CheckboxOption } from "./ui/checkbox";

export { IssueIcon, PullIcon };

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

/** The people an issue is assigned to, as overlapping avatars. */
export function AssigneeStack({ people }: { people: string[] }) {
  if (people.length === 0) return null;
  const shown = people.slice(0, 3);
  return (
    <span
      className="flex shrink-0 items-center"
      title={`Assigned to ${people.join(", ")}`}
    >
      {shown.map((name, index) => (
        <span key={name} className={`rounded-full ring-2 ring-bg ${index > 0 ? "-ml-1.5" : ""}`}>
          <Avatar name={name} size={18} />
        </span>
      ))}
      {people.length > shown.length && (
        <span className="ml-1 text-xs text-faint">+{people.length - shown.length}</span>
      )}
    </span>
  );
}

/** The agent working on an issue now. */
export function Assignee({ agent }: { agent: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/35 bg-accent/10 px-2 py-px text-xs font-medium text-accent"
      title={`Assigned to ${agent}`}
    >
      <Bot size={12} />
      {agent}
    </span>
  );
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

const VERDICTS = {
  approve: { label: "approved these changes", style: "text-accent" },
  request_changes: { label: "requested changes", style: "text-danger" },
} as const;

/** How g1t's own agents are named; they have no profile to link to. */
const AGENTS = new Set(["g1t-agent", "g1t agent", "g1t"]);

/**
 * A person's name (or `children`) linking to their profile at `/u/<name>`.
 * g1t's agents, and names that are not usernames, stay plain text.
 */
export function PersonLink({
  name,
  className,
  label,
  children,
}: {
  name: string;
  className?: string;
  label?: string;
  children?: ReactNode;
}) {
  // g1t itself has no profile; its name carries a small label instead.
  if (name === "g1t" && !children) {
    return (
      <span className="inline-flex items-baseline gap-1">
        <span className={className}>g1t</span>
        <span className="rounded border border-line px-1 text-[0.625rem] leading-[1.35] font-medium text-muted">bot</span>
      </span>
    );
  }
  if (AGENTS.has(name) || !/^[a-z0-9-]{1,39}$/i.test(name)) {
    return <span className={className}>{children ?? name}</span>;
  }
  return (
    <Link to={`/u/${name.toLowerCase()}`} className={className} aria-label={label}>
      {children ?? name}
    </Link>
  );
}

/**
 * Comments in order, then the box to add one. On a pull request, `review`
 * says where its changes are shown and whether the viewer may give a
 * verdict.
 */
/**
 * One entry in a conversation: who, what they did and when, then what they
 * wrote. The author's avatar sits beside it, as on any forge.
 */
export function TimelineItem({
  author,
  action,
  at,
  aside,
  children,
}: {
  author: string;
  /** What they did, after their name: "commented", "opened this". */
  action: ReactNode;
  at?: string;
  /** Shown at the right of the header. */
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-1 hidden shrink-0 sm:block">
        <PersonLink name={author} label={`${author}'s profile`}>
          <Avatar name={author} size={32} />
        </PersonLink>
      </span>
      <article className="min-w-0 grow overflow-hidden rounded-xl border border-line bg-surface">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-raised/40 px-4 py-2 text-sm text-muted">
          <span className="sm:hidden">
            <Avatar name={author} size={18} />
          </span>
          <PersonLink name={author} className="font-medium text-fg hover:underline" />
          {action}
          {at && <TimeAgo at={at} />}
          {aside && <span className="ml-auto min-w-0">{aside}</span>}
        </header>
        {children && <div className="px-4 py-3">{children}</div>}
      </article>
    </div>
  );
}

type Review = { changesUrl: string; canJudge: boolean };

/**
 * Text with each `#12` linked to the issue or pull request of that number,
 * and each file named in backticks shown as code, linked to its diff when
 * `filesUrl` says where the changes are.
 */
function WithReferences({ text, base, filesUrl }: { text: string; base?: string; filesUrl?: string }) {
  if (!base) return <>{text}</>;
  return (
    <>
      {text.split(/(#\d+|`[^`\n]+`)/).map((part, index) =>
        /^`[^`]+`$/.test(part) ? (
          filesUrl ? (
            <Link
              key={index}
              to={`${filesUrl}#file-${part.slice(1, -1)}`}
              className="font-mono text-xs text-fg hover:underline"
            >
              {part.slice(1, -1)}
            </Link>
          ) : (
            <code key={index} className="font-mono text-xs text-fg">
              {part.slice(1, -1)}
            </code>
          )
        ) : /^#\d+$/.test(part) ? (
          // Issues and pull requests share numbers; the issue page forwards.
          <Link
            key={index}
            to={`${base}/issues/${part.slice(1)}`}
            className="font-medium text-fg hover:underline"
          >
            {part}
          </Link>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Something that happened, as one line on the conversation's rail. */
function TimelineEvent({ comment, base, filesUrl }: { comment: Comment; base?: string; filesUrl?: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-muted">
      <span className="hidden w-8 shrink-0 justify-center sm:flex">
        <span className="size-2 rounded-full border border-line-strong bg-bg" />
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <Avatar name={comment.author.username} size={16} />
        <PersonLink name={comment.author.username} className="font-medium text-fg hover:underline" />
        <span>
          <WithReferences text={comment.body} base={base} filesUrl={filesUrl} />
        </span>
        <span className="text-faint">
          · <TimeAgo at={comment.createdAt} />
        </span>
      </span>
    </div>
  );
}

/**
 * The conversation of an issue or a pull request, oldest first: what
 * people and agents wrote, and between those, what happened.
 */
export function CommentList({
  comments,
  review,
  base,
}: {
  comments: Comment[];
  review?: Review;
  /** The repository's path, so that `#12` in an event can be linked. */
  base?: string;
}) {
  return (
    <>
      {comments.map((comment) => {
        if (comment.kind === "event") {
          return <TimelineEvent key={comment.id} comment={comment} base={base} filesUrl={review?.changesUrl} />;
        }
        const verdict = comment.verdict && VERDICTS[comment.verdict];
        return (
          <TimelineItem
            key={comment.id}
            author={comment.author.username}
            at={comment.createdAt}
            action={
              verdict ? (
                <span className={`flex items-center gap-1 font-medium ${verdict.style}`}>
                  {comment.verdict === "approve" ? (
                    <CircleCheck size={14} />
                  ) : (
                    <CircleSlash size={14} />
                  )}
                  {verdict.label}
                </span>
              ) : (
                <span>commented</span>
              )
            }
            aside={
              comment.path &&
              review && (
                <Link
                  to={`${review.changesUrl}#file-${comment.path}`}
                  className="block truncate font-mono text-xs text-faint hover:text-fg"
                >
                  {comment.path}
                  {comment.line != null && `:${comment.line}`}
                </Link>
              )
            }
          >
            {comment.body && <Markdown source={comment.body} repo={repoAt(base)} />}
          </TimelineItem>
        );
      })}
    </>
  );
}

/** Where a signed-in person writes a comment, or a review. */
export function CommentForm({
  author,
  resetKey,
  review,
}: {
  /** The viewer's username, or null if they are signed out. */
  author: string | null;
  /** Changes when a comment is added, which clears the box. */
  resetKey: number;
  review?: Review;
}) {
  if (!author) {
    return (
      <p className="text-sm text-muted">
        <Link to="/login" className="text-fg underline underline-offset-4">
          Sign in
        </Link>{" "}
        to comment.
      </p>
    );
  }
  return (
    <div className="flex gap-3">
      <span className="mt-1 hidden shrink-0 sm:block">
        <Avatar name={author} size={32} />
      </span>
      <Form method="post" className="min-w-0 grow space-y-2" key={resetKey}>
        <input type="hidden" name="action" value="comment" />
        <MentionTextarea
          name="body"
          rows={3}
          placeholder={
            review?.canJudge
              ? "Leave a comment, or a review. Markdown works."
              : "Leave a comment. Markdown works."
          }
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Comment</Button>
          {review?.canJudge && (
            <>
              <Button variant="quiet" type="submit" name="verdict" value="approve">
                <CircleCheck size={14} className="text-accent" />
                Approve
              </Button>
              <Button variant="quiet" type="submit" name="verdict" value="request_changes">
                <CircleSlash size={14} className="text-danger" />
                Request changes
              </Button>
            </>
          )}
        </div>
      </Form>
    </div>
  );
}

/**
 * Checkboxes for choosing people: the workspace's members, anyone already
 * chosen, and a box for other usernames. Posts `name` for each ticked and
 * `others` for the rest.
 */
export function PeoplePicker({
  name,
  members,
  chosen,
}: {
  name: string;
  members: string[];
  chosen: string[];
}) {
  const people = [...new Set([...members, ...chosen])];
  return (
    <>
      {people.length > 0 && (
        <div className="space-y-1.5">
          {people.map((person) => (
            <CheckboxOption
              key={person}
              name={name}
              value={person}
              defaultChecked={chosen.includes(person)}
              className="items-center"
              labelClassName="flex items-center gap-2"
              label={
                <>
                  <Avatar name={person} size={18} />
                  <span className="font-mono text-xs">{person}</span>
                </>
              }
            />
          ))}
        </div>
      )}
      <input
        name="others"
        placeholder="Other usernames, comma separated"
        autoComplete="off"
        data-1p-ignore
        className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
      />
    </>
  );
}

/** Where each reviewer stands: their most recent verdict. */
export function verdicts(comments: Comment[]): { reviewer: string; verdict: NonNullable<Comment["verdict"]> }[] {
  const latest = new Map<string, NonNullable<Comment["verdict"]>>();
  for (const comment of comments) {
    if (comment.verdict) latest.set(comment.author.username, comment.verdict);
  }
  return [...latest].map(([reviewer, verdict]) => ({ reviewer, verdict }));
}

/** `2 files  +12 −3`: the size of a pull request's change. */
export function ChangeSize({ files }: { files: Pull["files"] }) {
  if (files.length === 0) return null;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-faint">
      <span>
        {files.length} {files.length === 1 ? "file" : "files"}
      </span>
      <span className="text-accent">+{additions}</span>
      <span className="text-danger">−{deletions}</span>
    </span>
  );
}

/** The words of a Markdown text, without its markup, for a one-line preview. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
