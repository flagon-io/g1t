import { Bot, ExternalLink, User } from "lucide-react";
import type { ReactElement } from "react";
import { siClaude, siCursor, siDependabot, siGithubactions, siGithubcopilot, siGooglegemini, siRenovate } from "simple-icons";

import { type CodingAgent, type CodingAgentId, codingAgentById } from "@g1t/contracts/coding-agents";

import { cn } from "../lib/cn";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";

/** Each agent's mark (from Simple Icons) where its maker publishes one there; the rest show a bot. */
const MARKS: Partial<Record<CodingAgentId, string>> = {
  claude: siClaude.path,
  copilot: siGithubcopilot.path,
  gemini: siGooglegemini.path,
  jules: siGooglegemini.path,
  cursor: siCursor.path,
  dependabot: siDependabot.path,
  renovate: siRenovate.path,
  "github-actions": siGithubactions.path,
};

/**
 * A coding agent's avatar: its maker's mark on its colour, or on the
 * page's own (light on dark, dark on light) when its mark is black or
 * it has none.
 */
export function AgentMark({ agent, size = 20, className }: { agent: CodingAgent; size?: number; className?: string }) {
  const path = MARKS[agent.id];
  const glyph = Math.round(size * 0.58);
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full", agent.color ? "text-white" : "bg-fg text-bg", className)}
      style={{ width: size, height: size, ...(agent.color ? { backgroundColor: `#${agent.color}` } : {}) }}
    >
      {path ? (
        <svg viewBox="0 0 24 24" fill="currentColor" width={glyph} height={glyph}>
          <path d={path} />
        </svg>
      ) : (
        <Bot size={glyph} strokeWidth={2.25} />
      )}
    </span>
  );
}

/** "agent" or "bot", beside an agent's name. */
export function AgentBadge({ agent }: { agent: CodingAgent }) {
  return <span className="rounded border border-line px-1 text-[0.625rem] leading-[1.35] font-medium text-muted">{agent.kind}</span>;
}

/**
 * A coding agent's card, over its name or avatar (`children`, one element
 * that takes a ref): what it is, who makes it, and that g1t knows it by
 * the address on its commits rather than as an account.
 */
export function AgentCard({ agentId, children }: { agentId: string | null | undefined; children: ReactElement }) {
  const agent = codingAgentById(agentId);
  if (!agent) return children;
  return (
    <HoverCard>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent aria-label={`About ${agent.name}`}>
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <AgentMark agent={agent} size={48} />
            <div className="min-w-0 pt-0.5">
              <p className="flex items-baseline gap-1.5 leading-tight">
                <span className="font-semibold">{agent.name}</span>
                <AgentBadge agent={agent} />
              </p>
              <p className="mt-0.5 text-xs text-faint">by {agent.maker}</p>
            </div>
          </div>
          <p className="leading-relaxed text-fg/90">{agent.about}</p>
          <p className="text-[0.8125rem] text-muted">Not an account on g1t: known by the address on its commits.</p>
          <a href={agent.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[0.8125rem] font-medium text-accent hover:underline">
            About {agent.name}
            <ExternalLink size={12} />
          </a>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The card of an author nobody on g1t owns: the name on their commits, and
 * how to have them shown as you when they are yours.
 */
export function AuthorCard({ name, children }: { name: string; children: ReactElement }) {
  return (
    <HoverCard>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent aria-label={`About ${name}`}>
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-line text-faint">
              <User size={28} strokeWidth={2.25} />
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="leading-tight font-semibold wrap-anywhere">{name}</p>
              <p className="mt-0.5 text-xs text-faint">Not on g1t</p>
            </div>
          </div>
          <p className="text-[0.8125rem] leading-relaxed text-muted">
            The name on these commits. Their address isn&apos;t one any account has confirmed. If they&apos;re yours, add that address under{" "}
            <a href="/settings/emails" className="font-medium text-fg hover:underline">
              Settings → Emails
            </a>{" "}
            and they&apos;ll show as you.
          </p>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
