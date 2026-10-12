/**
 * Coordinating work, drawn: claims, harness sessions, dependencies,
 * integration failures and decision records, as the issue page, the pull
 * request page, the Work page and the why panel show them. What each says
 * is worked out in lib/coordination.ts.
 */
import {
  Activity,
  ArrowRightLeft,
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
  Pencil,
  Play,
  Square,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Form, Link } from "react-router";

import type {
  Blocker,
  Claim,
  Decision,
  DecisionConfidence,
  Harness,
  SessionState,
  State,
  WorkContext,
  WorkSession,
} from "@g1t/contracts";

import {
  CLAIM_ENDED,
  CONFIDENCE,
  DECISION_KINDS,
  type FeedLine,
  SESSION_STATES,
  checkHref,
  evidenceOf,
  expiresIn,
  harnessName,
  numberedParts,
} from "../lib/coordination";
import { Input, SubmitButton, TimeAgo } from "./ui";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Avatar } from "./ui/avatar";
import { Badge, type BadgeTone } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";
import { Label } from "./ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { PersonLink } from "./work";
import { IssueIcon } from "./work-icons";

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

/** One harness session: who, which harness, where it stands, when it was last heard from, linked to its page. */
export function SessionLine({
  session,
  base,
  showWhere = true,
  showBranch = true,
}: {
  session: WorkSession;
  base: string;
  /** Its pull request and branch; not where they are already said. */
  showWhere?: boolean;
  /** Its branch; not in a narrow sidebar. */
  showBranch?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Actor username={session.actor.username} harness={session.harness} />
      <div className="min-w-0 grow">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
          <Link to={`${base}/work/sessions/${session.id}`} prefetch="intent" className="font-medium hover:text-accent">
            {session.title ?? `${session.actor.username}'s session`}
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
    </div>
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
}: {
  work: WorkContext;
  /** Claims on it that ended lately, shown muted. */
  ended: Claim[];
  base: string;
  now: number;
  canEdit: boolean;
  error?: string | null;
}) {
  const open = work.issue.state === "open";
  const sessions = work.sessions.slice(0, 5);
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

        {sessions.length > 0 && (
          <PanelPart title="Sessions">
            <ul className="space-y-3">
              {sessions.map((session) => (
                <li key={session.id}>
                  <SessionLine session={session} base={base} showBranch={false} />
                </li>
              ))}
            </ul>
            {work.sessions.length > sessions.length && (
              <Link to={`${base}/work`} className="mt-2 inline-block text-xs text-muted hover:text-fg">
                {work.sessions.length - sessions.length} more on the Work page
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
