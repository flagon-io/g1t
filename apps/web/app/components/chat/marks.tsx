import { Sparkles } from "lucide-react";

import type { AgentStatus } from "@g1t/contracts";

import { AgentAvatar } from "../agent-avatar";
import { WithPresence } from "../presence";

import { cn } from "../../lib/cn";
import { Avatar } from "../ui/avatar";

/**
 * A workspace agent's face when it has no picture: a sparkle on a lavender
 * square, so agents read apart from people (round letters) at a glance.
 */
export function AgentMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex shrink-0 items-center justify-center bg-accent/18 text-accent ring-1 ring-accent/30 ring-inset", className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
    >
      <Sparkles size={Math.max(10, Math.round(size * 0.56))} strokeWidth={2.1} />
    </span>
  );
}

/**
 * A member's face: a person's avatar, or an agent's picture or mark. With
 * `presence`, a person's carries their dot (active, away, notifications
 * paused; components/presence.tsx), cut out of `ring`, the colour behind
 * it. Agents keep their own status, shown apart.
 */
export function MemberAvatar({
  member,
  size = 20,
  presence = false,
  ring,
}: {
  member: { kind: "user" | "agent"; id?: string; name: string; avatar: string | null; avatar_seed?: string | null };
  size?: number;
  presence?: boolean;
  ring?: string;
}) {
  if (member.kind === "agent") return <AgentAvatar agent={member} size={size} />;
  const avatar = <Avatar name={member.name} image={member.avatar} size={size} />;
  if (!presence) return avatar;
  return (
    <WithPresence person={{ id: member.id, username: member.name }} size={size} ring={ring}>
      {avatar}
    </WithPresence>
  );
}

/** AGENT, beside an agent's name wherever it speaks. */
export function AgentPill({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-[4px] bg-accent/15 px-1 text-[0.5625rem] font-semibold tracking-[0.06em] text-accent uppercase",
        className,
      )}
    >
      Agent
    </span>
  );
}

const STATUS: Record<AgentStatus, { label: string; dot: string }> = {
  idle: { label: "Idle", dot: "bg-faint/70" },
  working: { label: "Working", dot: "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-success)_18%,transparent)]" },
  waiting: { label: "Waiting on you", dot: "bg-warn" },
  out_of_budget: { label: "Out of budget", dot: "bg-danger" },
  paused: { label: "Paused", dot: "bg-muted" },
};

export function statusLabel(status: AgentStatus): string {
  return STATUS[status]?.label ?? status;
}

/** An agent's status as a small dot; the label is for screen readers unless shown. */
export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  const known = STATUS[status] ?? STATUS.idle;
  return (
    <span className={cn("inline-block size-2 shrink-0 rounded-full", known.dot, className)}>
      <span className="sr-only">{known.label}</span>
    </span>
  );
}
