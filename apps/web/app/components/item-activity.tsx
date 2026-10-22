/**
 * A work item's conversation: its decisions, folded, above one Activity
 * stream of what people wrote and what happened (its sessions, claims and
 * handoffs, and the notes the service writes), oldest first, with a filter
 * for All, Comments or Events, and the comment box at the bottom.
 */
import { ArrowRightLeft, ChevronRight, Hand, Link2, Timer, TriangleAlert } from "lucide-react";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";

import type { Comment, Decision, WorkSession } from "@g1t/contracts";

import { type FeedLine, type PullHref, harnessName } from "../lib/coordination";
import { modKeyLabel } from "../lib/shortcut";
import { ACTIVITY_FILTERS, type ActivityFilter, activityCounts, activityParts } from "../lib/work-item-page";
import { sessionPath } from "../lib/work-items";
import { Unavailable } from "./boundary";
import { DecisionList, NumberedText, TimelineSession } from "./coordination";
import { TimeAgo } from "./ui";
import { Avatar } from "./ui/avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Kbd } from "./ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { CommentForm, CommentList, PersonLink } from "./work";

const never = () => () => {};

/** ⌘ Enter on a Mac, Ctrl Enter elsewhere: what sends a comment. Never shown to a finger. */
export function SendKey() {
  const label = useSyncExternalStore(
    never,
    () => modKeyLabel(navigator.platform, "Enter"),
    () => "⌘Enter",
  );
  return <Kbd className="text-xs text-faint pointer-coarse:hidden">{label}</Kbd>;
}

/** Decisions, folded under a line that says how many: why the work is the way it is. */
export function DecisionsFold({ decisions, failed, base, pullHref }: { decisions: Decision[]; failed: boolean; base: string; pullHref: PullHref }) {
  const [open, setOpen] = useState(false);
  if (!failed && decisions.length === 0) return null;
  return (
    <section aria-label="Decisions" className="mt-10">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <CollapsibleTrigger className="font-semibold tracking-tight text-fg">
            <ChevronRight size={15} className="text-faint" />
            Decisions
            {!failed && <span className="font-normal text-faint">{decisions.length}</span>}
          </CollapsibleTrigger>
          <p className="text-sm text-muted">Why the work is the way it is, and how sure that is</p>
        </div>
        <CollapsibleContent className="mt-3">
          {failed ? <Unavailable what="Its decisions" /> : <DecisionList decisions={decisions} base={base} pullHref={pullHref} />}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

const LINE_ICON: Partial<Record<FeedLine["type"], ReactNode>> = {
  "work.claimed": <Hand size={13} />,
  "work.released": <Hand size={13} />,
  "work.claim_expired": <Timer size={13} />,
  "work.handoff_requested": <ArrowRightLeft size={13} />,
  "dependency.changed": <Link2 size={13} />,
  "overlap.detected": <TriangleAlert size={13} className="text-warn" />,
};

/** The coordination events Activity shows: sessions show as their own cards, and decisions above it. */
export function activityLine(line: FeedLine): boolean {
  return line.type in LINE_ICON;
}

/** A coordination event on the conversation's rail: who, what and when. */
function FeedRow({ line, workspace }: { line: FeedLine; workspace: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-muted">
      <span className="hidden w-8 shrink-0 justify-center text-faint sm:flex">{LINE_ICON[line.type]}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <Avatar name={line.who ?? "g1t"} size={16} agent={line.who == null || line.harness != null} />
        <PersonLink name={line.who ?? "g1t"} className="font-medium text-fg hover:underline" />
        {line.harness && <span className="text-faint">via {harnessName(line.harness)}</span>}
        <span className="min-w-0 wrap-break-word">
          <NumberedText text={line.text} base={`/${workspace}/-/work`} />
        </span>
        {line.session && (
          <Link to={sessionPath(workspace, line.session)} className="text-fg hover:text-accent">
            the session
          </Link>
        )}
        <span className="text-faint">
          · <TimeAgo at={line.time} />
        </span>
      </span>
    </div>
  );
}

export function ActivityStream({
  workspace,
  comments,
  sessions,
  sessionsFailed,
  lines,
  sessionBase,
  viewer,
  canModerate,
  failed,
  handles,
}: {
  workspace: string;
  comments: Comment[];
  /** Its sessions at the top of their trees, as cards where each started. */
  sessions: WorkSession[];
  sessionsFailed: boolean;
  /** Its claims, handoffs and the like. */
  lines: FeedLine[];
  sessionBase: (session: WorkSession) => string;
  viewer: { id: string; username: string } | null;
  canModerate: boolean;
  failed: { comment: string; error?: string | null } | null;
  handles: string[];
}) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const extras = [
    ...sessions.map((session) => ({ id: session.id, at: session.startedAt, node: <TimelineSession session={session} base={sessionBase(session)} /> })),
    ...lines.map((line) => ({ id: line.id, at: line.time, node: <FeedRow line={line} workspace={workspace} /> })),
  ];
  const counts = activityCounts(comments, extras.length);
  const shown = activityParts(comments, extras, filter);
  const empty = shown.comments.length === 0 && shown.extras.length === 0;
  return (
    <section aria-labelledby="activity" className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="activity" className="font-semibold tracking-tight">
          Activity
        </h2>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label="Show"
          value={filter}
          onValueChange={(value) => value && setFilter(value as ActivityFilter)}
        >
          {ACTIVITY_FILTERS.map((one) => (
            <ToggleGroupItem key={one.value} value={one.value} className="gap-1.5 px-2.5 text-xs">
              {one.label}
              <span className="tabular-nums text-faint">{counts[one.value]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="mt-4 space-y-4">
        {sessionsFailed && filter !== "comments" && <Unavailable what="Its sessions" compact />}
        {empty && (
          <p className="text-sm text-muted">
            {filter === "comments" ? "Nobody has commented yet." : filter === "events" ? "Nothing has happened to it yet." : "Nothing here yet."}
          </p>
        )}
        <CommentList
          comments={shown.comments}
          workspace={workspace}
          viewerId={viewer?.id ?? null}
          viewerName={viewer?.username ?? null}
          extra={shown.extras}
          canModerate={canModerate}
          failed={failed}
        />
        <div id="comment" className="scroll-mt-[calc(var(--topbar-h)+1rem)]">
          <CommentForm author={viewer?.username ?? null} resetKey={comments.length} handles={handles} hint={<SendKey />} />
        </div>
      </div>
    </section>
  );
}
