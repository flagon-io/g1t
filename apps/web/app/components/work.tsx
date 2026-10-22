import { Bot, CircleCheck, CircleSlash, Pencil, Trash2 } from "lucide-react";
import { type CSSProperties, Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { AgentRef, Comment, Pull, State, WorkItem } from "@g1t/contracts";

import { interleave, mayChangeComment } from "../lib/comments";
import { messageParts } from "../lib/commit-message";
import { chipStyle } from "../lib/labels";
import { repoAt } from "../lib/markdown-plugins";
import type { RefContext } from "../lib/refs";
import { CommitChip, SessionChip } from "./chat/ref-chip";
import { RefLink, repoScope } from "./commit-message";
import { Markdown } from "./markdown";
import { Reactions } from "./reactions";
import { ItemIcon, PullIcon } from "./work-icons";
import { sessionPath } from "../lib/work-items";
import { MentionTextarea } from "./mention-textarea";
import { ErrorText, SubmitButton, TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";
import { Avatar } from "./ui/avatar";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { CheckboxOption } from "./ui/checkbox";
import { Hint } from "./ui/hint";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { UserCard } from "./user-card";

export { ItemIcon, PullIcon };

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

/**
 * A label's chip: in its own color when the page knows it (the
 * repository's labels, by name), else in a hue chosen from its name.
 */
export function Label({ name, color }: { name: string; color?: string | null }) {
  const hue = LABEL_HUES[name] ?? hueFor(name);
  const own = chipStyle(color);
  const style: CSSProperties =
    Object.keys(own).length > 0
      ? own
      : {
          // Light text on a dark page, deep text on a light one (lib/theme.ts).
          color: `light-dark(oklch(0.46 0.13 ${hue}), oklch(0.84 0.11 ${hue}))`,
          borderColor: `light-dark(oklch(0.55 0.13 ${hue} / 0.35), oklch(0.84 0.11 ${hue} / 0.35))`,
          backgroundColor: `light-dark(oklch(0.55 0.13 ${hue} / 0.08), oklch(0.84 0.11 ${hue} / 0.1))`,
        };
  return (
    <span style={style} className="inline-flex shrink-0 items-center rounded-full border px-2 py-px text-xs font-medium">
      {name}
    </span>
  );
}

/** The people a work item is assigned to, as overlapping avatars. */
export function AssigneeStack({ people }: { people: string[] }) {
  if (people.length === 0) return null;
  const shown = people.slice(0, 3);
  return (
    <Hint label={`Assigned to ${people.join(", ")}`}>
      <span className="flex shrink-0 items-center">
        <span className="sr-only">Assigned to {people.join(", ")}</span>
        {shown.map((name, index) => (
          <span key={name} className={`rounded-full ring-2 ring-bg ${index > 0 ? "-ml-1.5" : ""}`} aria-hidden>
            <Avatar name={name} size={18} />
          </span>
        ))}
        {people.length > shown.length && (
          <span className="ml-1 text-xs text-faint" aria-hidden>
            +{people.length - shown.length}
          </span>
        )}
      </span>
    </Hint>
  );
}

/** The agent working on a work item now. */
export function Assignee({ agent }: { agent: string }) {
  return (
    <Hint label={`Assigned to ${agent}`}>
      <Badge tone="accent" className="text-xs">
        <Bot size={12} />
        <span className="sr-only">Assigned to </span>
        {agent}
      </Badge>
    </Hint>
  );
}

const PILL = "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium";

/** The large state badge at the top of a work item. */
export function ItemState({ item }: { item: Pick<WorkItem, "state" | "reason"> }) {
  const style =
    item.state === "open"
      ? "border-success/30 bg-success/10 text-success"
      : item.reason === "not_planned"
        ? "border-line bg-surface text-muted"
        : "border-merged/30 bg-merged/10 text-merged";
  return (
    <span className={`${PILL} ${style}`}>
      <ItemIcon item={item} size={14} />
      {item.state === "open" ? "Open" : item.reason === "not_planned" ? "Closed as not planned" : "Closed"}
    </span>
  );
}

const PULL_STYLES: Record<Pull["status"], string> = {
  draft: "border-line bg-surface text-muted",
  open: "border-success/30 bg-success/10 text-success",
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
  const link = (value: State) => `${to}?${[value === "open" ? "" : "state=closed", query].filter(Boolean).join("&")}`;
  const tab = (value: State, label: string) => (
    <Link
      to={link(value)}
      aria-current={state === value ? "page" : undefined}
      className={
        "inline-flex h-full items-center rounded-[5px] px-2.5 text-sm transition-colors " +
        (state === value ? "bg-raised font-medium text-fg" : "text-muted hover:text-fg")
      }
    >
      {label}
    </Link>
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {/* A filter, the height of the filters beside it: the section's views above it outweigh it. */}
      <Card tone="plain" radius="lg" className="flex h-8 gap-0.5 rounded-md p-0.5">
        {tab("open", "Open")}
        {tab("closed", "Closed")}
      </Card>
      {action}
    </div>
  );
}

const VERDICTS = {
  approve: { label: "approved these changes", style: "text-success" },
  request_changes: { label: "requested changes", style: "text-danger" },
} as const;

/**
 * A person's name (or `children`) linking to their profile at `/u/<name>`.
 * g1t, and names that are not usernames, stay plain text.
 */
export function PersonLink({ name, className, label, children }: { name: string; className?: string; label?: string; children?: ReactNode }) {
  // g1t itself has no profile; its name carries a small label instead, and
  // its card says what it is.
  if (name === "g1t" && !children) {
    return (
      <UserCard username="g1t">
        <span tabIndex={0} className="inline-flex items-baseline gap-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <span className={className}>g1t</span>
          <span className="rounded border border-line px-1 text-[0.625rem] leading-[1.35] font-medium text-muted">bot</span>
        </span>
      </UserCard>
    );
  }
  if (name === "g1t") {
    return (
      <UserCard username="g1t">
        <span className={className}>{children}</span>
      </UserCard>
    );
  }
  // Ghost, a deleted account, has no profile and no card.
  if (name === "ghost" || !/^[a-z0-9-]{1,39}$/i.test(name)) {
    return <span className={className}>{children ?? name}</span>;
  }
  return (
    <UserCard username={name}>
      <Link to={`/u/${name.toLowerCase()}`} className={className} aria-label={label}>
        {children ?? name}
      </Link>
    </UserCard>
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
  id,
  author,
  bot = false,
  agent,
  actingFor = agent?.actingFor,
  action,
  at,
  edited,
  aside,
  children,
}: {
  /** Its anchor, so a link can point at it (`#cmt_…`). */
  id?: string;
  author: string;
  /** g1t, or an agent in someone's harness: drawn as an agent, with no profile to link to. */
  bot?: boolean;
  /**
   * Set when one of the workspace's former agents wrote it, as itself:
   * shown by its name with an Agent badge, and whom it acted for, in place
   * of `author`.
   */
  agent?: { ref: AgentRef; actingFor?: string | null };
  /** Whom g1t acted for, when a session g1t started for someone wrote it. */
  actingFor?: string | null;
  /** What they did, after their name: "commented", "opened this". */
  action: ReactNode;
  at?: string;
  /** When what they wrote was last edited, if it was. */
  edited?: string | null;
  /** Shown at the right of the header. */
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const face = (size: number) => (agent ? <Avatar name={agent.ref.displayName} agent size={size} /> : <Avatar name={author} size={size} agent={bot} />);
  return (
    <div id={id} className="flex scroll-mt-[calc(var(--topbar-h)+1rem)] gap-3">
      <span className="mt-1 hidden shrink-0 sm:block">
        {agent || bot ? (
          face(32)
        ) : (
          <PersonLink name={author} label={`${author}'s profile`}>
            {face(32)}
          </PersonLink>
        )}
      </span>
      <Card asChild className="min-w-0 grow overflow-hidden">
        <article>
          <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-raised/40 px-4 py-2 text-sm text-muted">
            <span className="sm:hidden">{face(18)}</span>
            {agent ? (
              <AgentName agent={agent.ref} />
            ) : bot ? (
              <span className="font-medium text-fg">{author}</span>
            ) : (
              <PersonLink name={author} className="font-medium text-fg hover:underline" />
            )}
            {action}
            {at && <TimeAgo at={at} />}
            {actingFor && (
              <span className="text-xs text-faint">
                on behalf of{" "}
                <PersonLink name={actingFor} className="hover:text-fg hover:underline">
                  @{actingFor}
                </PersonLink>
              </span>
            )}
            {edited && (
              <Hint
                label={
                  <>
                    Edited <TimeAgo at={edited} />
                  </>
                }
              >
                <span tabIndex={0} className="text-xs text-faint">
                  edited
                </span>
              </Hint>
            )}
            {aside && <span className="ml-auto min-w-0">{aside}</span>}
          </header>
          {children && <div className="px-4 py-3">{children}</div>}
        </article>
      </Card>
    </div>
  );
}

/** A former agent's name, with an Agent badge. */
function AgentName({ agent }: { agent: AgentRef }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-medium text-fg">{agent.displayName}</span>
      <Badge tone="accent" className="px-1.5 text-[0.625rem] leading-[1.35]">
        Agent
      </Badge>
    </span>
  );
}

/** That an agent's review is advisory, and why it counts toward nothing. */
function AdvisoryChip() {
  return (
    <Hint label="Agent reviews don't count toward required approvals">
      <span tabIndex={0} className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <Badge tone="neutral">Advisory</Badge>
      </span>
    </Hint>
  );
}

type Review = { changesUrl: string; canJudge: boolean };

/**
 * Text with each `#12` linked to the work item or pull request it names
 * (its card on hover), read in the repository at `base` or else in
 * `workspace`; each full commit hash linked to its commit, and each
 * file named in backticks shown as code, linked to its diff when
 * `filesUrl` says where the changes are. Without a repository, a commit or
 * a session (both a repository's) is shown by its short id, unlinked.
 */
function WithReferences({ text, base, workspace, filesUrl }: { text: string; base?: string; workspace?: string; filesUrl?: string }) {
  if (!base && !workspace) return <>{text}</>;
  const here: RefContext = base ? repoScope(base) : { workspace: workspace! };
  return (
    <>
      {text.split(/(`[^`\n]+`)/).map((chunk, index) =>
        /^`[^`]+`$/.test(chunk) ? (
          filesUrl ? (
            <Link key={index} to={`${filesUrl}#file-${chunk.slice(1, -1)}`} className="font-mono text-xs text-fg hover:underline">
              {chunk.slice(1, -1)}
            </Link>
          ) : (
            <code key={index} className="font-mono text-xs text-fg">
              {chunk.slice(1, -1)}
            </code>
          )
        ) : (
          <Fragment key={index}>
            {messageParts(chunk).map((part, at) =>
              part.kind === "ref" ? (
                <RefLink key={at} scope={part.repo ? repoScope(part.repo) : here} number={part.number} className="font-medium text-fg hover:underline">
                  {part.text}
                </RefLink>
              ) : part.kind === "commit" ? (
                // The commit that closed or merged it, by its short hash.
                base ? (
                  <CommitChip key={at} href={`${base}/commit/${part.sha}`} sha={part.sha} />
                ) : (
                  <code key={at} className="font-mono text-xs text-fg">
                    {part.sha.slice(0, 7)}
                  </code>
                )
              ) : part.kind === "session" ? (
                // The session it was closed in.
                base ? (
                  <SessionChip key={at} href={sessionPath(base.split("/").filter(Boolean)[0] ?? "", part.id)} id={part.id} />
                ) : (
                  <code key={at} className="font-mono text-xs text-fg">
                    {part.text}
                  </code>
                )
              ) : (
                part.text
              ),
            )}
          </Fragment>
        ),
      )}
    </>
  );
}

/**
 * One line on the conversation's rail: a mark on the rail (a dot unless
 * `mark` says otherwise), who, what and when.
 */
function TimelineRow({ comment, mark, children }: { comment: Comment; mark?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-sm text-muted">
      <span className="hidden w-8 shrink-0 justify-center sm:flex">{mark ?? <span className="size-2 rounded-full border border-line-strong bg-bg" />}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {comment.agent ? (
          <>
            <Avatar name={comment.agent.displayName} agent size={16} />
            <AgentName agent={comment.agent} />
          </>
        ) : (
          <>
            <Avatar name={comment.author.username} size={16} />
            <PersonLink name={comment.author.username} className="font-medium text-fg hover:underline" />
          </>
        )}
        {children}
        {comment.actingFor && (
          <span className="text-xs text-faint">
            on behalf of{" "}
            <PersonLink name={comment.actingFor.username} className="hover:text-fg hover:underline">
              @{comment.actingFor.username}
            </PersonLink>
          </span>
        )}
        <span className="text-faint">
          · <TimeAgo at={comment.createdAt} />
        </span>
      </span>
    </div>
  );
}

/** Something that happened, as one line on the conversation's rail. */
function TimelineEvent({ comment, base, workspace, filesUrl }: { comment: Comment; base?: string; workspace?: string; filesUrl?: string }) {
  return (
    <TimelineRow comment={comment}>
      <span>
        <WithReferences text={comment.body} base={base} workspace={workspace} filesUrl={filesUrl} />
      </span>
    </TimelineRow>
  );
}

/** A review's verdict, approved or changes requested, in its own colour. */
function Verdict({ verdict }: { verdict: keyof typeof VERDICTS }) {
  const { label, style } = VERDICTS[verdict];
  return (
    <span className={`flex items-center gap-1 font-medium ${style}`}>
      {verdict === "approve" ? <CircleCheck size={14} /> : <CircleSlash size={14} />}
      {label}
    </span>
  );
}

/**
 * A review that gave a verdict and said nothing else: one line on the rail,
 * not a comment with an empty body. There is nothing to edit, and a
 * verdict is not deleted, so it has no actions.
 */
function TimelineVerdict({ comment, verdict }: { comment: Comment; verdict: keyof typeof VERDICTS }) {
  return (
    <TimelineRow
      comment={comment}
      mark={verdict === "approve" ? <CircleCheck size={16} className="text-success" /> : <CircleSlash size={16} className="text-danger" />}
    >
      <span className={VERDICTS[verdict].style}>{VERDICTS[verdict].label}</span>
      {comment.advisory && <AdvisoryChip />}
    </TimelineRow>
  );
}

/** Edit and Delete, under a comment the viewer may change. */
function CommentActions({ comment, can, error }: { comment: Comment; can: { edit: boolean; delete: boolean }; error?: string | null }) {
  return (
    <div className="mt-3 border-t border-line pt-2 text-sm">
      <div className="flex flex-wrap items-center gap-1">
        {can.edit && (
          <details className="open:order-last open:w-full">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-1 text-xs text-faint hover:text-fg">
              <Pencil size={12} />
              Edit
            </summary>
            <Form method="post" className="mt-2 space-y-2">
              <input type="hidden" name="action" value="edit-comment" />
              <input type="hidden" name="comment" value={comment.id} />
              <MentionTextarea name="body" rows={4} defaultValue={comment.body} />
              <SubmitButton match={{ action: "edit-comment", comment: comment.id }} pending="Saving…">
                Save
              </SubmitButton>
            </Form>
          </details>
        )}
        {can.delete && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="ghost" size="inline" className="gap-1 px-1.5 py-1 text-xs text-faint hover:text-danger font-normal">
                <Trash2 size={12} />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <Form method="post" className="grid gap-4">
                <input type="hidden" name="action" value="delete-comment" />
                <input type="hidden" name="comment" value={comment.id} />
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this comment?</AlertDialogTitle>
                  <AlertDialogDescription>It is removed from the conversation for everyone. This cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction asChild>
                    <button type="submit">
                      <Trash2 size={14} />
                      Delete comment
                    </button>
                  </AlertDialogAction>
                </AlertDialogFooter>
              </Form>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

/** Something else in a conversation, put among its comments by when it happened: a session, say. */
export type TimelineExtra = { id: string; at: string; node: ReactNode };

/**
 * The conversation of a work item or a pull request, oldest first: what
 * people and agents wrote, and between those, what happened, with
 * `extra` (its sessions) where each happened.
 */
export function CommentList({
  comments,
  review,
  base,
  workspace,
  viewerId,
  viewerName = null,
  canModerate = false,
  failed,
  extra = [],
}: {
  comments: Comment[];
  review?: Review;
  /** The repository's path, so that `#12` in an event can be linked. */
  base?: string;
  /** For a work item's conversation, which no repository holds: the workspace `#12` is read in. */
  workspace?: string;
  /** The signed-in viewer, who may edit and delete their own comments. */
  viewerId?: string | null;
  /** Maintain and up: may edit and delete anyone's comments. */
  canModerate?: boolean;
  /** Why editing or deleting a comment was refused, under that comment. */
  failed?: { comment: string; error?: string | null } | null;
  /** The signed-in viewer's username, who may react; none to only show reactions. */
  viewerName?: string | null;
  extra?: TimelineExtra[];
}) {
  // Each extra goes before the first comment written after it.
  return (
    <>
      {interleave(comments, extra).map((one) =>
        one.comment ? <Fragment key={one.comment.id}>{entry(one.comment)}</Fragment> : <Fragment key={one.extra.id}>{one.extra.node}</Fragment>,
      )}
    </>
  );

  function entry(comment: Comment) {
    if (comment.kind === "event") {
      return <TimelineEvent key={comment.id} comment={comment} base={base} workspace={workspace} filesUrl={review?.changesUrl} />;
    }
    const verdict = comment.verdict;
    // A verdict with nothing said and no line it is about is one line, not a card.
    if (verdict && !comment.body.trim() && !comment.path) {
      return <TimelineVerdict key={comment.id} comment={comment} verdict={verdict} />;
    }
    const can = mayChangeComment(comment, viewerId, canModerate);
    return (
      <TimelineItem
        key={comment.id}
        id={comment.id}
        author={comment.author.username}
        bot={comment.author.kind === "agent"}
        agent={
          comment.agent && {
            ref: comment.agent,
            actingFor: comment.actingFor?.username,
          }
        }
        actingFor={comment.actingFor?.username}
        at={comment.createdAt}
        action={
          <>
            {verdict ? <Verdict verdict={verdict} /> : <span>{comment.advisory ? "reviewed" : "commented"}</span>}
            {comment.advisory && <AdvisoryChip />}
          </>
        }
        edited={comment.editedAt}
        aside={
          comment.path &&
          review && (
            <Link to={`${review.changesUrl}#file-${comment.path}`} className="block truncate font-mono text-xs text-faint hover:text-fg">
              {comment.path}
              {comment.line != null && `:${comment.line}`}
            </Link>
          )
        }
      >
        {comment.body && <Markdown source={comment.body} repo={repoAt(base)} workspace={workspace} />}
        <Reactions reactions={comment.reactions} commentId={comment.id} viewer={viewerName} className="mt-3" />
        {(can.edit || can.delete) && <CommentActions comment={comment} can={can} error={failed?.comment === comment.id ? failed.error : null} />}
      </TimelineItem>
    );
  }
}

/** Where a signed-in person writes a comment, or a review. */
export function CommentForm({
  author,
  resetKey,
  review,
  handles,
  hint,
}: {
  /** The viewer's username, or null if they are signed out. */
  author: string | null;
  /** Changes when a comment is added, which clears the box. */
  resetKey: number;
  review?: Review;
  /** Teams the box offers to mention, as `@workspace/team`. */
  handles?: readonly string[];
  /** Beside the buttons, at the right: the key that sends it. */
  hint?: ReactNode;
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
          handles={handles}
          // ⌘ Enter or Ctrl Enter sends it, as Comment does.
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.defaultPrevented) return;
            event.preventDefault();
            const submit = event.currentTarget.form?.querySelector<HTMLButtonElement>('button[type="submit"][value="comment"]');
            if (event.currentTarget.value.trim()) event.currentTarget.form?.requestSubmit(submit ?? undefined);
          }}
          rows={3}
          placeholder={review?.canJudge ? "Leave a comment, or a review. Markdown works." : "Leave a comment. Markdown works."}
        />
        <div className="flex flex-wrap gap-2">
          {/* A plain comment's verdict is none the action knows, so each button tells its own post apart. */}
          <SubmitButton name="verdict" value="comment" match={{ action: "comment" }} pending="Commenting…">
            Comment
          </SubmitButton>
          {review?.canJudge && (
            <>
              <SubmitButton variant="outline" name="verdict" value="approve" match={{ action: "comment" }} pending="Approving…">
                <CircleCheck size={14} className="text-success" />
                Approve
              </SubmitButton>
              <SubmitButton variant="outline" name="verdict" value="request_changes" match={{ action: "comment" }} pending="Requesting changes…">
                <CircleSlash size={14} className="text-danger" />
                Request changes
              </SubmitButton>
            </>
          )}
          {hint && <span className="ml-auto self-center">{hint}</span>}
        </div>
      </Form>
    </div>
  );
}

/**
 * Approving or requesting changes from where the reviewer is (the changes,
 * the merge box), not only under the comments: a button that opens a note
 * and the two verdicts. Approving needs no note; asking for changes does.
 */
export function ReviewButton({ mine, asked }: { mine: "approve" | "request_changes" | null; asked: boolean }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const navigation = useNavigation();
  const sent = useRef(false);
  // Closed once the review it sent has landed and the page has it.
  useEffect(() => {
    if (sent.current && navigation.state === "idle") {
      sent.current = false;
      setOpen(false);
      setNote("");
    }
  }, [navigation.state]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant={asked && !mine ? "accent" : "outline"} className={mine ? "font-normal" : undefined}>
          {mine === "approve" ? (
            <>
              <CircleCheck size={13} className="text-success" /> Approved
            </>
          ) : mine === "request_changes" ? (
            <>
              <CircleSlash size={13} className="text-danger" /> Changes requested
            </>
          ) : (
            "Review"
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={6} aria-label="Review" className="w-80 p-3">
        <Form method="post" className="space-y-2" onSubmit={() => (sent.current = true)}>
          <input type="hidden" name="action" value="comment" />
          <MentionTextarea name="body" rows={3} value={note} onChange={(event) => setNote(event.currentTarget.value)} placeholder="A note (needed to request changes)" />
          <div className="flex flex-wrap gap-2">
            <SubmitButton size="sm" variant="accent" name="verdict" value="approve" match={{ action: "comment" }} pending="Approving…">
              <CircleCheck size={14} />
              Approve
            </SubmitButton>
            <SubmitButton
              size="sm"
              variant="outline"
              name="verdict"
              value="request_changes"
              match={{ action: "comment" }}
              pending="Requesting…"
              disabled={!note.trim()}
            >
              <CircleSlash size={14} className="text-danger" />
              Request changes
            </SubmitButton>
          </div>
        </Form>
      </PopoverContent>
    </Popover>
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
  placeholder = "Other usernames, comma separated",
}: {
  name: string;
  members: string[];
  chosen: string[];
  placeholder?: string;
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
        placeholder={placeholder}
        autoComplete="off"
        data-1p-ignore
        className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
      />
    </>
  );
}

/**
 * Where each reviewer stands: their most recent verdict. An agent's review
 * is advisory and is not one of them.
 */
export function verdicts(comments: Comment[]): { reviewer: string; verdict: NonNullable<Comment["verdict"]> }[] {
  const latest = new Map<string, NonNullable<Comment["verdict"]>>();
  for (const comment of comments) {
    if (comment.verdict && !comment.agent && !comment.advisory) latest.set(comment.author.username, comment.verdict);
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
      <span className="text-success">+{additions}</span>
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
