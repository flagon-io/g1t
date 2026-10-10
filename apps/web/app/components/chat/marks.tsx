import type { AgentStatus, MemberProfile } from "@g1t/contracts";

import { AgentAvatar } from "../agent-avatar";
import { WithPresence } from "../presence";

import { cn } from "../../lib/cn";
import { Avatar } from "../ui/avatar";

/**
 * A member's face: a person's avatar, or an agent's picture or bot face
 * with the agent marker (components/ui/avatar.tsx). With `presence`, a
 * person's carries their dot (active, away, notifications paused;
 * components/presence.tsx), cut out of `ring`, the colour behind it, which
 * also rings the agent marker. Agents keep their own status, shown apart.
 */
export function MemberAvatar({
  member,
  size = 20,
  presence = false,
  ring,
}: {
  member: { kind: "user" | "agent"; id?: string; name: string; avatar: string | null; avatar_seed?: string | null; look?: MemberProfile["look"] };
  size?: number;
  presence?: boolean;
  ring?: string;
}) {
  if (member.kind === "agent") return <AgentAvatar agent={member} size={size} ring={ring} />;
  const avatar = <Avatar name={member.name} image={member.avatar} size={size} />;
  if (!presence) return avatar;
  return (
    <WithPresence person={{ id: member.id, username: member.name }} size={size} ring={ring}>
      {avatar}
    </WithPresence>
  );
}

/**
 * A person and an agent together, for a mixed direct message's row: the
 * person's face behind, the agent's in front with its marker, so the pair
 * says at a glance that an agent is in the conversation.
 */
export function PairAvatar({
  person,
  agent,
  size = 20,
  ring = "var(--color-bg)",
}: {
  person: { kind: "user" | "agent"; id?: string; name: string; avatar: string | null };
  agent: { kind: "user" | "agent"; id?: string; name: string; avatar: string | null; avatar_seed?: string | null; look?: MemberProfile["look"] };
  size?: number;
  ring?: string;
}) {
  const each = Math.max(16, Math.round(size * 0.85));
  const width = Math.round(each * 1.55);
  return (
    <span className="relative inline-flex shrink-0" style={{ width, height: size + 2 }} aria-hidden="true">
      <span className="absolute top-0 left-0 inline-flex rounded-full" style={{ boxShadow: `0 0 0 1.5px ${ring}` }}>
        <Avatar name={person.name} image={person.avatar} size={each} />
      </span>
      <span className="absolute inline-flex rounded-md" style={{ left: width - each, top: size + 2 - each, boxShadow: `0 0 0 1.5px ${ring}` }}>
        <AgentAvatar agent={agent} size={each} ring={ring} />
      </span>
    </span>
  );
}

/** AGENT, beside an agent's name wherever it speaks. */
export function AgentPill({ className }: { className?: string }) {
  // The avatar beside it carries the agent marker; this is the word, for where the name stands alone.
  return <AgentWord className={className} />;
}

function AgentWord({ className }: { className?: string }) {
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
