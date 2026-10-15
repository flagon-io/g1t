/**
 * Coordinating work, drawn: claims, harness sessions, dependencies,
 * integration failures and decision records, as the issue page, the pull
 * request page, the Work page, a project's overview and the why panel
 * show them. What each says
 * is worked out in lib/coordination.ts.
 */
import {
  Activity,
  ArrowRightLeft,
  Bot,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleX,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Hand,
  Layers,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Play,
  Sparkles,
  Square,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { Form, Link, useFetcher } from "react-router";

import {
  AGENT_MODES,
  type AgentSessionsSetup,
  type Blocker,
  type Claim,
  type Decision,
  type DecisionConfidence,
  type Harness,
  type Pull,
  type SessionState,
  type State,
  type WorkContext,
  type WorkSession,
} from "@g1t/contracts";

import {
  CLAIM_ENDED,
  CONFIDENCE,
  DECISION_KINDS,
  type FeedLine,
  SESSION_STATES,
  type SessionNode,
  checkHref,
  evidenceOf,
  expiresIn,
  harnessName,
  type LiveGroup,
  type LiveIssue,
  awakeAndIdle,
  liveByIssue,
  mayEndSession,
  mergeSessions,
  numberedParts,
  type SessionEnder,
  sessionTitle,
  sessionTree,
} from "../lib/coordination";
import { PLUGIN_INSTALL } from "../lib/agent-setup";
import { CopyLine, EmptyState, Input, SubmitButton, TimeAgo } from "./ui";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Avatar } from "./ui/avatar";
import { Badge, type BadgeTone } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "./ui/field";
import { Hint } from "./ui/hint";
import { Label } from "./ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { RadioGroup, RadioOption } from "./ui/radio-group";
import { Textarea } from "./ui/textarea";
import { Markdown } from "./markdown";
import { PersonLink, TimelineItem } from "./work";
import { repoAt } from "../lib/markdown-plugins";
import { IssueIcon, PullIcon } from "./work-icons";

/** Text with each `#N` linked to that issue or pull request (the issue's address leads to a pull request too). */
export function NumberedText({ text, base }: { text: string; base: string }) {
  return (
    <>
      {numberedParts(text).map((part, index) =>
        typeof part === "number" ? (
          <Link key={index} to={`${base}/issues/${part}`} className="font-medium text-fg hover:text-accent">
            #{part}
          </Link>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** The harness a session or claim came from. */
export function HarnessBadge({ harness }: { harness: Harness | null | undefined }) {
  const name = harnessName(harness);
  if (!name) return null;
  return <Badge>{name}</Badge>;
}

/** Who did it: an agent's avatar when it came through a harness (a person's token, the harness declared), else theirs. */
export function Actor({ username, harness, size = 20 }: { username: string; harness?: Harness | null; size?: number }) {
  return <Avatar name={username} size={size} agent={harness != null} />;
}

const SESSION_TONE: Record<SessionState, BadgeTone> = { active: "success", idle: "warn", ended: "neutral" };

export function SessionStateBadge({ state }: { state: SessionState }) {
  const { label, hint } = SESSION_STATES[state];
  return (
    <Hint label={hint}>
      <Badge tone={SESSION_TONE[state]}>{label}</Badge>
    </Hint>
  );
}

/** How sure a decision is: claimed, tested and approved read apart at a glance. */
export function ConfidenceBadge({ confidence }: { confidence: DecisionConfidence }) {
  const { label, hint, tone } = CONFIDENCE[confidence];
  const Icon = confidence === "approved" ? CircleCheck : confidence === "tested" ? Layers : MessageSquare;
  return (
    <Hint label={hint}>
      <Badge tone={tone}>
        <Icon size={11} />
        {label}
      </Badge>
    </Hint>
  );
}

/** One claim: who, from which harness, since when, and when it lapses; one no longer active is muted. */
export function ClaimLine({ claim, now, showIssue, base }: { claim: Claim; now: number; showIssue?: boolean; base: string }) {
  const active = claim.state === "active";
  const left = expiresIn(claim, now);
  return (
    <div className={active ? "flex items-start gap-2.5" : "flex items-start gap-2.5 opacity-60"}>
      <Actor username={claim.actor.username} harness={claim.harness} />
      <div className="min-w-0 grow">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
          <PersonLink name={claim.actor.username} className="font-medium hover:underline" />
          {showIssue ? (
            <span className="text-muted">
              claimed{" "}
              <Link to={`${base}/issues/${claim.issue}`} className="font-medium text-fg hover:text-accent">
                #{claim.issue}
              </Link>
            </span>
          ) : null}
          <HarnessBadge harness={claim.harness} />
          {!active && <Badge>{CLAIM_ENDED[claim.state as Exclude<Claim["state"], "active">]}</Badge>}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
          <span>
            since <TimeAgo at={claim.createdAt} />
          </span>
          {left && (
            <span className="inline-flex items-center gap-1" suppressHydrationWarning>
              · <Timer size={11} />
              {left}
            </span>
          )}
          {!active && claim.state === "handed_off" && <span>· to {claim.handoffTo ?? "anyone"}</span>}
        </p>
        {claim.note && <p className="mt-1 text-xs text-fg-soft">{claim.note}</p>}
      </div>
    </div>
  );
}

/**
 * Asking before a session is ended by hand, for one its harness left
 * behind (killed, or never told to end): posts `end` to the session's
 * page, and closes once it has ended, with the page read again.
 */
export function EndSessionDialog({
  session,
  base,
  open,
  onOpenChange,
}: {
  session: WorkSession;
  base: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fetcher = useFetcher<{ error?: string; ended?: boolean } | null>();
  const busy = fetcher.state !== "idle";
  const error = !busy ? fetcher.data?.error : undefined;
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ended) onOpenChange(false);
  }, [fetcher.state, fetcher.data, onOpenChange]);
  const subagents = session.subagents ?? 0;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <fetcher.Form method="post" action={`${base}/work/sessions/${session.id}`} className="grid gap-5">
          <input type="hidden" name="action" value="end" />
          <AlertDialogHeader>
            <AlertDialogTitle>End {sessionTitle(session)}?</AlertDialogTitle>
            <AlertDialogDescription>
              For a session its harness left behind: killed, or never told to end. It shows as ended by hand by you
              {subagents > 0 ? `, and its ${subagents === 1 ? "subagent" : "subagents"} still going end with it` : ""}. Its claims stay until they are
              released or expire. If its harness is still running, the session comes back the next time it is heard from.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <Alert tone="danger">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <SubmitButton variant="destructive" fetcher={fetcher} pending="Ending…">
              End session
            </SubmitButton>
          </AlertDialogFooter>
        </fetcher.Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A session's ⋯ menu in a list, for whoever may end it: End session. */
function SessionMenu({ session, base }: { session: WorkSession; base: string }) {
  const [ending, setEnding] = useState(false);
  return (
    <>
      <DropdownMenu>
        <Hint label="More">
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`More for ${sessionTitle(session)}`}>
              <MoreHorizontal size={15} />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onSelect={() => setEnding(true)}>
            <Square />
            End session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <EndSessionDialog session={session} base={base} open={ending} onOpenChange={setEnding} />
    </>
  );
}

/** One harness session: who, which harness, where it stands, when it was last heard from, linked to its page. */
export function SessionLine({
  session,
  base,
  showWhere = true,
  showBranch = true,
  ender,
}: {
  session: WorkSession;
  base: string;
  /** Its pull request and branch; not where they are already said. */
  showWhere?: boolean;
  /** Its branch; not in a narrow sidebar. */
  showBranch?: boolean;
  /** Who is looking, for a menu to end it when they may. */
  ender?: SessionEnder;
}) {
  const endable = ender != null && mayEndSession(session, ender.viewerId, ender.canPush);
  return (
    <div className="flex items-start gap-2.5">
      <Actor username={session.actor.username} harness={session.harness} />
      <div className="min-w-0 grow">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
          <Link to={`${base}/work/sessions/${session.id}`} prefetch="intent" className="font-medium hover:text-accent">
            {sessionTitle(session)}
          </Link>
          <HarnessBadge harness={session.harness} />
          <SessionStateBadge state={session.state} />
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
          <PersonLink name={session.actor.username} className="hover:text-fg" />
          <span>
            · {session.state === "ended" ? "ended" : "last seen"} <TimeAgo at={session.endedAt ?? session.lastSeenAt} />
          </span>
          {showWhere && session.pull != null && (
            <span>
              · on{" "}
              <Link to={`${base}/pull/${session.pull}`} className="text-fg hover:text-accent">
                #{session.pull}
              </Link>
            </span>
          )}
          {showWhere && showBranch && session.branch && (
            <span className="inline-flex min-w-0 items-center gap-1 font-mono">
              · <GitBranch size={11} />
              <span className="truncate">{session.branch}</span>
            </span>
          )}
        </p>
      </div>
      {endable && (
        <span className="-my-0.5 shrink-0">
          <SessionMenu session={session} base={base} />
        </span>
      )}
    </div>
  );
}

/**
 * A session in an issue's or pull request's conversation, where it
 * started, as a card like a comment or a review: g1t working for someone
 * (a session g1t started on the workspace's Claude, when it was assigned
 * the issue or asked in the thread), or someone working in their own
 * harness. What it is about, where it stands now, its branch, and what it
 * reported once it ended, linked to its page.
 */
export function TimelineSession({ session, base }: { session: WorkSession; base: string }) {
  const g1t = session.harness === "claude_managed_agents";
  const ended = session.state === "ended";
  return (
    <TimelineItem
      id={session.id}
      author={g1t ? "g1t" : session.actor.username}
      bot={g1t}
      at={session.startedAt}
      action={
        <>
          {g1t ? (
            <span>
              {ended ? "worked on this for" : "is working on this for"}{" "}
              <PersonLink name={session.actor.username} className="font-medium text-fg hover:underline">
                @{session.actor.username}
              </PersonLink>
            </span>
          ) : (
            <span>{ended ? "worked on this in a session" : "is working on this in a session"}</span>
          )}
          <HarnessBadge harness={session.harness} />
          <SessionStateBadge state={session.state} />
        </>
      }
      aside={
        <Link
          to={`${base}/work/sessions/${session.id}`}
          prefetch="intent"
          className="inline-flex items-center gap-1 text-xs text-faint hover:text-fg"
        >
          <Activity size={12} />
          View session
        </Link>
      }
    >
      <Link to={`${base}/work/sessions/${session.id}`} prefetch="intent" className="font-medium hover:text-accent">
        {sessionTitle(session)}
      </Link>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
        {ended ? (
          <span>
            Ended <TimeAgo at={session.endedAt ?? session.lastSeenAt} />
          </span>
        ) : (
          <span>
            Last heard from <TimeAgo at={session.lastSeenAt} />
          </span>
        )}
        {session.branch && (
          <span className="inline-flex min-w-0 items-center gap-1 font-mono">
            · <GitBranch size={11} />
            <span className="truncate">{session.branch}</span>
          </span>
        )}
        {session.pull != null && (
          <span>
            · on{" "}
            <Link to={`${base}/pull/${session.pull}`} className="text-fg hover:text-accent">
              #{session.pull}
            </Link>
          </span>
        )}
        {(session.subagents ?? 0) > 0 && (
          <span>
            · {session.subagents} {session.subagents === 1 ? "subagent" : "subagents"}
          </span>
        )}
      </p>
      {ended && session.result && (
        <div className="mt-3 border-t border-line pt-3 text-sm">
          <Markdown source={session.result} repo={repoAt(base)} />
        </div>
      )}
    </TimelineItem>
  );
}

/** A subagent in a line: its kind, its task, where it stands, linked to its page. */
export function SubagentLine({ session, base }: { session: WorkSession; base: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      <Bot size={12} className="shrink-0 text-faint" />
      <Link to={`${base}/work/sessions/${session.id}`} prefetch="intent" className="shrink-0 font-medium text-fg hover:text-accent">
        {session.agentType ?? "Subagent"}
      </Link>
      {session.task && (
        <Hint label={session.task}>
          <span className="min-w-0 truncate text-muted">{session.task}</span>
        </Hint>
      )}
      <SessionStateBadge state={session.state} />
    </div>
  );
}

/** Subagents under a session, and theirs under them, indented on a rule. */
function SubagentBranch({ nodes, base }: { nodes: SessionNode[]; base: string }) {
  return (
    <ul className="mt-1.5 space-y-1.5 border-l border-line pl-3">
      {nodes.map((node) => (
        <li key={node.session.id}>
          <SubagentLine session={node.session} base={base} />
          {node.children.length > 0 && <SubagentBranch nodes={node.children} base={base} />}
        </li>
      ))}
    </ul>
  );
}

/** Sessions as trees: each one's line, with its subagents in a compact list under it. */
export function SessionTreeList({
  nodes,
  base,
  showWhere,
  showBranch,
  className,
  ender,
}: {
  nodes: SessionNode[];
  base: string;
  showWhere?: boolean;
  showBranch?: boolean;
  className?: string;
  ender?: SessionEnder;
}) {
  return (
    <ul className={className ?? "space-y-3"}>
      {nodes.map((node) => (
        <li key={node.session.id}>
          <SessionLine session={node.session} base={base} showWhere={showWhere} showBranch={showBranch} ender={ender} />
          {node.children.length > 0 && (
            <div className="pl-7.5">
              <SubagentBranch nodes={node.children} base={base} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Starting a session on the issue on the workspace's Anthropic account: a
 * button opening a dialog that asks what kind of work and for anything to
 * add, posting `start-session` to the issue's action.
 */
export function StartSessionDialog({ setup, error }: { setup: AgentSessionsSetup; error?: string | null }) {
  const [open, setOpen] = useState(Boolean(error));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="xs">
          <Sparkles size={12} />
          Start a session
        </Button>
      </DialogTrigger>
      <DialogContent>
        <Form method="post" className="grid gap-5">
          <input type="hidden" name="action" value="start-session" />
          <DialogHeader>
            <DialogTitle>Start a session on this issue</DialogTitle>
            <DialogDescription>
              Claude works on it on {setup.connectionName ? `the ${setup.connectionName} connection` : "your workspace's Anthropic account"}
              {setup.model ? `, with ${setup.model}` : ""}. It shows on this issue as it goes, with its subagents.
            </DialogDescription>
          </DialogHeader>
          <FieldSet>
            <FieldLegend className="mb-0">What to do</FieldLegend>
            <RadioGroup name="mode" defaultValue="implement">
              {AGENT_MODES.map((mode) => (
                <RadioOption key={mode.mode} value={mode.mode} label={mode.label} description={mode.hint} />
              ))}
            </RadioGroup>
          </FieldSet>
          <Field>
            <FieldLabel htmlFor="start-session-instruction">Anything to add</FieldLabel>
            <Textarea id="start-session-instruction" name="instruction" rows={3} maxLength={4000} placeholder="Optional: what to keep in mind" />
            <FieldError>{error}</FieldError>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <SubmitButton match={{ action: "start-session" }} pending="Starting…">
              Start
            </SubmitButton>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

const KIND_ICON: Record<Decision["kind"], ReactNode> = {
  proposal: <MessageSquare size={14} />,
  claim: <MessageSquare size={14} />,
  integration_failure: <CircleX size={14} className="text-danger" />,
  integration_passed: <Layers size={14} className="text-success" />,
  fix: <Link2 size={14} className="text-accent" />,
  approval: <CircleCheck size={14} className="text-success" />,
  merge: <GitMerge size={14} className="text-merged" />,
  note: <MessageSquare size={14} />,
};

/** The pull requests tested together, in queue order: `#41 + #44`. */
export function Combination({ numbers, base, culprit }: { numbers: number[]; base: string; culprit?: number | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {numbers.map((number, index) => (
        <Fragment key={number}>
          {index > 0 && <span className="text-faint">+</span>}
          <Link to={`${base}/pull/${number}`}>
            <Badge shape="tag" tone={number === culprit ? "danger" : "neutral"} className="font-mono hover:border-line-strong">
              #{number}
            </Badge>
          </Link>
        </Fragment>
      ))}
    </span>
  );
}

/** The check a decision rests on, linked where it can be seen. */
function CheckLink({ check }: { check: { name: string; conclusion: string; url: string | null } }) {
  const href = checkHref(check.url);
  const text = (
    <>
      <span className="font-mono">{check.name}</span> {check.conclusion}
    </>
  );
  if (!href) return <span>{text}</span>;
  return href.startsWith("/") ? (
    <Link to={href} className="text-fg underline-offset-2 hover:underline">
      {text}
    </Link>
  ) : (
    <a href={href} className="text-fg underline-offset-2 hover:underline" rel="noreferrer" target="_blank">
      {text}
    </a>
  );
}

/** One decision record: its kind, how sure it is, the sentence, who and when, and what it rests on. */
export function DecisionLine({ decision, base }: { decision: Decision; base: string }) {
  const evidence = evidenceOf(decision);
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 text-faint">{KIND_ICON[decision.kind]}</span>
      <div className="min-w-0 grow">
        <p className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-medium text-fg">{DECISION_KINDS[decision.kind]}</span>
          <ConfidenceBadge confidence={decision.confidence} />
          {decision.pull != null && (
            <Link to={`${base}/pull/${decision.pull}`} className="text-muted hover:text-fg">
              #{decision.pull}
            </Link>
          )}
        </p>
        <p className="mt-1 text-sm wrap-break-word">
          <NumberedText text={decision.summary} base={base} />
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
          <span>{decision.actor ?? "g1t"}</span>
          <span>
            · <TimeAgo at={decision.createdAt} />
          </span>
          {evidence.combination.length > 1 && (
            <span className="inline-flex items-center gap-1.5">
              · tested as <Combination numbers={evidence.combination} base={base} culprit={decision.kind === "integration_failure" ? decision.pull : null} />
            </span>
          )}
          {evidence.check && decision.kind === "integration_failure" && (
            <span>
              · <CheckLink check={evidence.check} />
            </span>
          )}
          {evidence.commit && (
            <span className="inline-flex items-center gap-1 font-mono">
              · <GitCommitHorizontal size={11} />
              {evidence.commit.slice(0, 7)}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

/** Decision records, as a list in a card. */
export function DecisionList({ decisions, base }: { decisions: Decision[]; base: string }) {
  return (
    <Card asChild divided>
      <ol>
        {decisions.map((decision) => (
          <li key={decision.id} className="px-4 py-3">
            <DecisionLine decision={decision} base={base} />
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * A combination that failed in the merge queue: which pull requests were
 * tested together, the check that failed, which ones it fails with, and
 * whether it has been answered since.
 */
export function IntegrationFailure({
  failure,
  base,
  fixed,
  branch = "main",
  className,
}: {
  failure: Decision;
  base: string;
  /** The branch the combination was built on. */
  branch?: string;
  /** A fix or a passing combination since, when there is one. */
  fixed?: Decision | null;
  className?: string;
}) {
  const evidence = evidenceOf(failure);
  return (
    <Alert tone={fixed ? "info" : "danger"} className={className}>
      <AlertTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg">
        {failure.pull != null ? (
          <span>
            <TriangleAlert size={15} className={`mr-2 inline align-[-3px] ${fixed ? "text-info" : "text-danger"}`} />
            <Link to={`${base}/pull/${failure.pull}`} className="hover:underline">
              #{failure.pull}
            </Link>{" "}
            failed in the merge queue {evidence.combination.length > 1 ? "together with others" : "on its own"}
          </span>
        ) : (
          <span>A combination failed in the merge queue</span>
        )}
        <ConfidenceBadge confidence={failure.confidence} />
        <span className="text-xs font-normal text-muted">
          <TimeAgo at={failure.createdAt} />
        </span>
      </AlertTitle>
      <AlertDescription className="space-y-1.5">
        {evidence.combination.length > 0 && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs">
            Tested as <span className="font-mono text-fg">{branch}</span> <span className="text-faint">+</span>
            <Combination numbers={evidence.combination} base={base} culprit={failure.pull} />
          </p>
        )}
        {evidence.check && (
          <p className="text-xs">
            Failing check: <CheckLink check={evidence.check} />
          </p>
        )}
        <p className="text-xs">
          {evidence.suspects.length > 0 ? (
            <>
              Fails with{" "}
              <NumberedText text={evidence.suspects.map((n) => `#${n}`).join(", ")} base={base} />
              {evidence.bisected ? ", narrowed down by building smaller combinations." : "."}
            </>
          ) : (
            "It fails by itself: the change is the cause."
          )}
        </p>
        {fixed && (
          <p className="text-xs text-fg">
            <CircleCheck size={13} className="mr-1.5 inline align-[-2px] text-success" />
            {fixed.kind === "integration_passed" ? "Passed together since" : "Fixed since"}:{" "}
            <span className="text-muted">
              <NumberedText text={fixed.summary} base={base} />
            </span>
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

const FEED_ICON: Record<FeedLine["type"], ReactNode> = {
  "work.claimed": <Hand size={14} />,
  "work.released": <Hand size={14} />,
  "work.claim_expired": <Timer size={14} />,
  "work.handoff_requested": <ArrowRightLeft size={14} />,
  "session.started": <Play size={14} />,
  "session.ended": <Square size={14} />,
  "dependency.changed": <Link2 size={14} />,
  "overlap.detected": <TriangleAlert size={14} />,
  "integration.failed": <CircleX size={14} />,
  "integration.passed": <Layers size={14} />,
  "decision.recorded": <CircleDot size={14} />,
};

const FEED_TONE: Record<FeedLine["tone"], string> = {
  neutral: "text-faint",
  accent: "text-accent",
  success: "text-success",
  warn: "text-warn",
  danger: "text-danger",
  info: "text-info",
};

/** Recent coordination events, newest first, one line each. */
export function CoordinationFeed({ lines, base }: { lines: FeedLine[]; base: string }) {
  return (
    <Card asChild divided>
      <ol>
        {lines.map((line) => (
          <li key={line.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
            <span className={`mt-0.5 shrink-0 ${FEED_TONE[line.tone]}`}>{FEED_ICON[line.type]}</span>
            <p className="min-w-0 grow wrap-break-word text-muted">
              <PersonLink name={line.who ?? "g1t"} className="font-medium text-fg hover:underline" />
              {line.harness && <span className="text-faint"> via {harnessName(line.harness)}</span>}{" "}
              <NumberedText text={line.text} base={base} />
              {line.session && (
                <>
                  {" · "}
                  <Link to={`${base}/work/sessions/${line.session}`} className="text-fg hover:text-accent">
                    the session
                  </Link>
                </>
              )}
            </p>
            <span className="shrink-0 text-xs text-faint">
              <TimeAgo at={line.time} />
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** An issue's place among others: one it waits on, or one waiting on it. */
function DependencyLine({ base, number, title, state, detail }: { base: string; number: number; title: string; state: State; detail?: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5">
        <IssueIcon issue={{ state, reason: null }} size={14} />
      </span>
      <span className="min-w-0 grow">
        <Link to={`${base}/issues/${number}`} className="block truncate text-sm hover:text-accent">
          {title} <span className="text-faint">#{number}</span>
        </Link>
        {detail && <span className="block text-xs text-muted">{detail}</span>}
      </span>
    </li>
  );
}

/** Where a blocker stands, in a few words: landed, being worked on, or waiting. */
export function blockerDetail(blocker: Blocker): string {
  if (blocker.pulls.some((pull) => pull.status === "merged")) return "Merged";
  if (blocker.state === "closed") return "Closed";
  const open = blocker.pulls.filter((pull) => pull.status === "open" || pull.status === "draft");
  const who = blocker.claims.map((claim) => claim.actor.username);
  return [
    who.length > 0 ? `Claimed by ${who.join(", ")}` : "Not claimed",
    open.length > 0 ? `${open.length} pull ${open.length === 1 ? "request" : "requests"} open` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A part of the Work panel, under a rule. */
function PanelPart({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-t border-line pt-3">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted">{title}</p>
        {action}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/**
 * The Work panel of an issue's sidebar: who has claimed it, the sessions on
 * it, what it waits on and what waits on it, and for those who may, the
 * blockers to change.
 */
export function IssueWorkPanel({
  work,
  ended,
  base,
  now,
  canEdit,
  error,
  sessions: all,
  start,
}: {
  work: WorkContext;
  /** Claims on it that ended lately, shown muted. */
  ended: Claim[];
  base: string;
  now: number;
  canEdit: boolean;
  error?: string | null;
  /** The sessions tied to it with their subagents, when they could be read; else its own sessions. */
  sessions?: WorkSession[] | null;
  /** Starting a session on it, for those who may. */
  start?: ReactNode;
}) {
  const open = work.issue.state === "open";
  const trees = sessionTree(mergeSessions(work.sessions, all));
  const sessions = trees.slice(0, 5);
  const waiting = work.blockedBy.filter((blocker) => blocker.state === "open").length;
  return (
    <Card asChild className="space-y-4 p-4">
      <section aria-label="Work">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Activity size={14} className="text-accent" />
          Work
        </h3>

        <div className="space-y-3">
          {work.claims.length === 0 && ended.length === 0 ? (
            <p className="text-xs text-muted">
              {open ? (
                <>
                  Nobody has claimed it. Claim it from your harness, or with <code className="font-mono text-fg-soft">g1t work claim {work.issue.number}</code>.
                </>
              ) : (
                "Nobody is working on it."
              )}
            </p>
          ) : (
            [...work.claims, ...ended.slice(0, 3)].map((claim) => <ClaimLine key={claim.id} claim={claim} now={now} base={base} />)
          )}
          {work.claims.length > 1 && (
            <Alert tone="warn" className="flex items-start gap-1.5 px-2.5 py-1.5 text-xs">
              <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warn" />
              {work.claims.length} claims stand on it: they may be doing the same work.
            </Alert>
          )}
        </div>

        {(sessions.length > 0 || start) && (
          <PanelPart title="Sessions" action={start}>
            {sessions.length === 0 ? (
              <p className="text-xs text-faint">None yet.</p>
            ) : (
              <SessionTreeList nodes={sessions} base={base} showBranch={false} />
            )}
            {trees.length > sessions.length && (
              <Link to={`${base}/work`} className="mt-2 inline-block text-xs text-muted hover:text-fg">
                {trees.length - sessions.length} more on the Work page
              </Link>
            )}
          </PanelPart>
        )}

        <PanelPart
          title={
            <>
              Blocked by
              {waiting > 0 && <span className="text-warn"> · {waiting} open</span>}
            </>
          }
          action={canEdit ? <BlockedByEditor current={work.issue.blockedBy} /> : undefined}
        >
          {work.blockedBy.length === 0 ? (
            <p className="text-xs text-faint">Nothing. It can start now.</p>
          ) : (
            <ul className="space-y-2">
              {work.blockedBy.map((blocker) => (
                <DependencyLine key={blocker.number} base={base} number={blocker.number} title={blocker.title} state={blocker.state} detail={blockerDetail(blocker)} />
              ))}
            </ul>
          )}
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        </PanelPart>

        {work.blocks.length > 0 && (
          <PanelPart title="Blocks">
            <ul className="space-y-2">
              {work.blocks.map((issue) => (
                <DependencyLine key={issue.number} base={base} number={issue.number} title={issue.title} state={issue.state} />
              ))}
            </ul>
          </PanelPart>
        )}
      </section>
    </Card>
  );
}

/** Changing what an issue waits on: the whole list, as numbers. */
function BlockedByEditor({ current }: { current: number[] }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs">
          <Pencil size={12} />
          Edit
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <Form method="post" className="space-y-2.5">
          <input type="hidden" name="action" value="blocked-by" />
          <Label htmlFor="blocked-by">Blocked by</Label>
          <Input id="blocked-by" name="blocked_by" defaultValue={current.map((n) => `#${n}`).join(", ")} placeholder="#12, #14" autoComplete="off" />
          <p className="text-xs text-muted">Issues of this repository that have to land first. Leave it empty for none.</p>
          <SubmitButton size="sm" match={{ action: "blocked-by" }} pending="Saving…">
            Save
          </SubmitButton>
        </Form>
      </PopoverContent>
    </Popover>
  );
}

/** One issue being worked on: its title, then each claim and session on it. */
export function LiveIssueCard({
  group,
  title,
  base,
  now,
  ender,
}: {
  group: LiveIssue;
  title: string | undefined;
  base: string;
  now: number;
  ender?: SessionEnder;
}) {
  return (
    <Card asChild divided>
      <li>
        <div className="flex items-start gap-2.5 px-4 py-3">
          <span className="mt-1">
            <IssueIcon issue={{ state: "open", reason: null }} />
          </span>
          <Link to={`${base}/issues/${group.issue}`} prefetch="intent" className="min-w-0 grow font-medium hover:text-accent">
            {title ?? `Issue #${group.issue}`} <span className="font-normal text-faint">#{group.issue}</span>
          </Link>
          {group.claims.length > 1 && <Badge tone="warn">{group.claims.length} claims</Badge>}
        </div>
        {group.claims.map((claim) => (
          <div key={claim.id} className="px-4 py-3">
            <ClaimLine claim={claim} now={now} base={base} />
          </div>
        ))}
        {group.sessions.map((session) => (
          <div key={session.id} className="px-4 py-3">
            <SessionLine session={session} base={base} ender={ender} />
          </div>
        ))}
      </li>
    </Card>
  );
}

/** A pull request a session is on, as Live now names it. */
export type LivePull = { title: string; status: Pull["status"] };

/** What a group of sessions on no issue is on, as its card's heading: the pull request, the branch, or neither. */
function LiveGroupHeading({
  group,
  pulls,
  base,
  defaultBranch,
}: {
  group: LiveGroup;
  pulls: Record<number, LivePull>;
  base: string;
  defaultBranch?: string | null;
}) {
  if (group.kind === "pull") {
    const pull = pulls[group.pull];
    return (
      <div className="flex items-start gap-2.5 px-4 py-3">
        <span className="mt-1">
          <PullIcon status={pull?.status ?? "open"} />
        </span>
        <Link to={`${base}/pull/${group.pull}`} prefetch="intent" className="min-w-0 grow font-medium hover:text-accent">
          {pull?.title ?? `Pull request #${group.pull}`} <span className="font-normal text-faint">#{group.pull}</span>
        </Link>
        <span className="mt-0.5 shrink-0 text-xs text-faint">No issue yet</span>
      </div>
    );
  }
  if (group.kind === "branch") {
    return (
      <div className="flex items-center gap-2.5 px-4 py-3">
        <GitBranch size={16} className="shrink-0 text-muted" />
        <Link to={`${base}/tree/${encodeURIComponent(group.branch)}`} prefetch="intent" className="min-w-0 truncate font-mono text-sm font-medium hover:text-accent">
          {group.branch}
        </Link>
        <span className="ml-auto shrink-0 text-xs text-faint">No issue yet</span>
      </div>
    );
  }
  // Working on the default branch itself, or somewhere git has not said yet.
  const onDefault = defaultBranch != null && group.sessions.some((session) => session.branch === defaultBranch);
  return (
    <div className="flex items-center gap-2.5 px-4 py-3">
      {onDefault ? <GitBranch size={16} className="shrink-0 text-faint" /> : <Activity size={16} className="shrink-0 text-faint" />}
      <Hint label="Sessions on no issue, pull request or branch of their own, each titled with what it is for. One opens or claims an issue when its work becomes a change.">
        <span className="text-sm text-muted">
          {onDefault ? (
            <>
              On <span className="font-mono">{defaultBranch}</span>
            </>
          ) : (
            "No branch yet"
          )}
        </span>
      </Hint>
    </div>
  );
}

/** Sessions on no issue yet that share a pull request or a branch, or share neither: a heading, then each session. */
export function LiveGroupCard({
  group,
  pulls,
  base,
  defaultBranch,
  ender,
}: {
  group: LiveGroup;
  pulls: Record<number, LivePull>;
  base: string;
  defaultBranch?: string | null;
  ender?: SessionEnder;
}) {
  return (
    <Card asChild divided>
      <li>
        <LiveGroupHeading group={group} pulls={pulls} base={base} defaultBranch={defaultBranch} />
        {group.sessions.map((session) => (
          <div key={session.id} className="px-4 py-3">
            {/* Its pull request and branch are the heading's, unless it has neither of its own. */}
            <SessionLine
              session={session}
              base={base}
              showWhere={group.kind === "none"}
              showBranch={group.kind === "none" && session.branch !== defaultBranch}
              ender={ender}
            />
          </div>
        ))}
      </li>
    </Card>
  );
}

/**
 * Who is working right now: each issue with its claims and sessions, the
 * most recently active first, then sessions on no issue yet, by pull
 * request, then by branch, then those on neither. `limit` caps the issues
 * shown, for a page that links to the rest.
 */
export function LiveNowList({
  claims,
  sessions,
  titles,
  pulls = {},
  defaultBranch,
  base,
  now,
  limit,
  ender,
}: {
  claims: Claim[];
  sessions: WorkSession[];
  titles: Record<number, string>;
  /** The open pull requests' titles and states, for the sessions on one with no issue. */
  pulls?: Record<number, LivePull>;
  /** Sessions on it have no branch of their own. */
  defaultBranch?: string | null;
  base: string;
  now: number;
  limit?: number;
  /** Who is looking: each session they may end has a menu to end it by hand. */
  ender?: SessionEnder;
}) {
  const { awake, idle } = awakeAndIdle(sessions);
  const live = liveByIssue(claims, awake, defaultBranch);
  const issues = limit == null ? live.issues : live.issues.slice(0, limit);
  return (
    <ol className="space-y-3">
      {issues.map((group) => (
        <LiveIssueCard key={group.issue} group={group} title={titles[group.issue]} base={base} now={now} ender={ender} />
      ))}
      {live.groups.map((group) => (
        <LiveGroupCard
          key={group.kind === "pull" ? `pull:${group.pull}` : group.kind === "branch" ? `branch:${group.branch}` : "none"}
          group={group}
          pulls={pulls}
          base={base}
          defaultBranch={defaultBranch}
          ender={ender}
        />
      ))}
      {idle.length > 0 && <IdleSessions sessions={idle} base={base} ender={ender} />}
    </ol>
  );
}

/**
 * Sessions not heard from for 15 minutes, folded under Live now: usually
 * an open tab, not work going on. Each moves back up when it is heard from,
 * and drops off when it times out.
 */
function IdleSessions({ sessions, base, ender }: { sessions: WorkSession[]; base: string; ender?: SessionEnder }) {
  return (
    <Card asChild divided>
      <li>
        <Collapsible>
          <CollapsibleTrigger className="w-full px-4 py-2.5">
            <ChevronRight size={14} className="shrink-0" />
            {sessions.length === 1 ? "1 idle session" : `${sessions.length} idle sessions`}
            <span className="ml-auto text-xs text-faint">
              last seen <TimeAgo at={sessions[0].lastSeenAt} />
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="divide-y divide-line border-t border-line">
            {sessions.map((session) => (
              <div key={session.id} className="px-4 py-3">
                <SessionLine session={session} base={base} ender={ender} />
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      </li>
    </Card>
  );
}

/** What to do when nobody is working on a project: bring your own harness. */
export function StartHere({ title }: { title: string }) {
  return (
    <EmptyState title={title}>
      <div className="mx-auto mt-3 max-w-lg space-y-3 text-left">
        <p>Install the g1t plugin in Claude Code, and each session shows here as it works:</p>
        {PLUGIN_INSTALL.split("\n").map((line) => (
          <CopyLine key={line} text={line} prompt />
        ))}
        <p>From any other harness, or by hand, claim an issue with the g1t CLI:</p>
        <CopyLine text="g1t work claim 12" prompt />
        <p>
          <a href="https://docs.g1t.sh/guides/bring-your-own-agent/" className="text-fg underline underline-offset-4">
            Connect a coding agent
          </a>{" "}
          sets up Codex, Cursor and any MCP client;{" "}
          <a href="https://docs.g1t.sh/guides/sessions/" className="text-fg underline underline-offset-4">
            Sessions, claims and dependencies
          </a>{" "}
          says how it works.
        </p>
      </div>
    </EmptyState>
  );
}
