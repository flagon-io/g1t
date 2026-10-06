import {
  CircleCheck,
  CircleDot,
  CircleSlash,
  GitMerge,
  GitPullRequest,
  MessageCircleQuestion,
  MessageSquare,
  Play,
  Terminal,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { AgentMessage, G1tEvent } from "@g1t/contracts";

import { Avatar, TimeAgo } from "./ui";

/** Whether an actor is g1t itself: its agent or its machinery. */
const isG1t = (actor: string | null): actor is string => actor === "g1t";

type Line = { icon: ReactNode; tone: string; actor: string | null; text: ReactNode; coordination?: boolean };

/** One event as a sentence, or null for those not worth a line. */
function line(event: G1tEvent, base: string): Line | null {
  const ref = (number: number) => (
    <Link to={`${base}/issues/${number}`} prefetch="intent" className="font-medium text-fg hover:underline">
      #{number}
    </Link>
  );
  const actor = event.actor;
  switch (event.type) {
    case "issue.opened":
      return {
        icon: <CircleDot size={14} />,
        tone: isG1t(actor) ? "text-merged" : "text-muted",
        actor,
        text: isG1t(actor) ? <>filed {ref(event.data.number)} for something it found</> : <>opened {ref(event.data.number)}</>,
        coordination: isG1t(actor),
      };
    case "pull.opened":
      return {
        icon: <Play size={14} />,
        tone: "text-merged",
        actor: event.data.agent,
        text: (
          <>
            started on {event.data.issue != null ? ref(event.data.issue) : "a change"} in {ref(event.data.number)}
          </>
        ),
      };
    case "pull.ready":
      return { icon: <GitPullRequest size={14} />, tone: "text-info", actor, text: <>marked {ref(event.data.number)} ready for review</> };
    case "checks.completed":
      return {
        icon: <Terminal size={14} />,
        tone: event.data.status === "passed" ? "text-accent" : "text-danger",
        actor: null,
        text: (
          <>
            checks {event.data.status} on {ref(event.data.number)}
          </>
        ),
      };
    case "review.completed":
      return {
        icon: event.data.verdict === "approve" ? <CircleCheck size={14} /> : <CircleSlash size={14} />,
        tone: event.data.verdict === "approve" ? "text-accent" : "text-warn",
        actor: "g1t",
        text: (
          <>
            {event.data.verdict === "approve" ? "approved" : "asked for changes on"} {ref(event.data.number)}
          </>
        ),
      };
    case "comment.created":
      if (event.data.verdict) {
        return {
          icon: event.data.verdict === "approve" ? <CircleCheck size={14} /> : <CircleSlash size={14} />,
          tone: event.data.verdict === "approve" ? "text-accent" : "text-warn",
          actor,
          text: (
            <>
              {event.data.verdict === "approve" ? "approved" : "asked for changes on"} {ref(event.data.number)}
            </>
          ),
        };
      }
      return {
        icon: <MessageSquare size={14} />,
        tone: isG1t(actor) ? "text-merged" : "text-muted",
        actor,
        text: <>commented on {ref(event.data.number)}</>,
        coordination: isG1t(actor),
      };
    case "pull.merged":
      return { icon: <GitMerge size={14} />, tone: "text-accent", actor, text: <>landed {ref(event.data.number)} on main</> };
    case "agent.asked":
      return { icon: <MessageCircleQuestion size={14} />, tone: "text-merged", actor, text: <>asked the agent on {ref(event.data.number)}, and g1t woke it to answer</> };
    case "pull.merge_requested":
      return { icon: <GitMerge size={14} />, tone: "text-muted", actor, text: <>is bringing {ref(event.data.number)} up to date</> };
    default:
      return null;
  }
}

/**
 * What happened across an outcome's issues and pull requests, newest
 * first. Agents talking to each other through the forge stand out.
 */
export function Activity({ events, base }: { events: G1tEvent[]; base: string }) {
  const lines = events.map((event) => ({ event, line: line(event, base) })).filter((item) => item.line != null);
  if (lines.length === 0) return null;
  return (
    <ol className="space-y-0.5">
      {lines.map(({ event, line }) => (
        <li
          key={event.id}
          className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm ${
            line!.coordination ? "bg-merged/[0.07] ring-1 ring-merged/25" : ""
          }`}
        >
          <span className={`shrink-0 ${line!.tone}`}>{line!.icon}</span>
          {line!.actor && (
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-fg-soft">
              <Avatar name={line!.actor} size={14} />
              {line!.actor}
            </span>
          )}
          <span className="min-w-0 grow truncate text-muted">{line!.text}</span>
          <span className="shrink-0 text-xs text-faint">
            <TimeAgo at={event.time} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Questions and handoffs between the agents on an outcome's pull requests,
 * each with where it stands: asked, read, answered or declined.
 */
export function Exchanges({ exchanges, base }: { exchanges: AgentMessage[]; base: string }) {
  if (exchanges.length === 0) return null;
  const pull = (number: number) => (
    <Link to={`${base}/pull/${number}`} prefetch="intent" className="font-mono text-fg hover:underline">
      #{number}
    </Link>
  );
  return (
    <ul className="space-y-3">
      {exchanges.map((exchange) => {
        const state = exchange.answer
          ? exchange.declined
            ? { label: "Declined", tone: "text-warn ring-warn/40" }
            : { label: exchange.kind === "handoff" ? "Taken on" : "Answered", tone: "text-accent ring-accent/40" }
          : exchange.deliveredAt
            ? { label: "Read", tone: "text-info ring-info/40" }
            : { label: "Waiting to be read", tone: "text-faint ring-line" };
        return (
          <li key={exchange.id} className="rounded-2xl bg-merged/[0.05] p-4 ring-1 ring-merged/25">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <Avatar name="g1t" size={14} />
              <span>
                The agent on {exchange.fromNumber != null ? pull(exchange.fromNumber) : exchange.author}{" "}
                {exchange.kind === "handoff" ? "handed work to" : "asked"} the agent on {pull(exchange.toNumber)}
              </span>
              <span className={`ml-auto rounded-full px-2 py-0.5 ring-1 ${state.tone}`}>{state.label}</span>
            </p>
            <p className="mt-2 text-sm">{exchange.body}</p>
            {exchange.answer && (
              <p className="mt-2 border-l-2 border-merged/40 pl-3 text-sm text-fg-soft">{exchange.answer}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
