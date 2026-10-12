import { AgentAvatar } from "../agent-avatar";
import { WithPresence } from "../presence";

import { cn } from "../../lib/cn";
import { Avatar } from "../ui/avatar";

/**
 * A member's face: a person's avatar, or, on an old message from an agent
 * that no longer exists (or one from g1t), a plain tile with the agent
 * marker (components/ui/avatar.tsx). With `presence`, a person's carries
 * their dot (active, away, notifications paused; components/presence.tsx),
 * cut out of `ring`, the colour behind it, which also rings the marker.
 */
export function MemberAvatar({
  member,
  size = 20,
  presence = false,
  ring,
}: {
  member: { kind: "user" | "agent"; id?: string; name: string; avatar: string | null };
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
 * AGENT beside the name an old message from an agent was posted under;
 * DELETED AGENT, in the quiet colours, when chat says it was deleted.
 */
export function AgentPill({ className, deleted = false }: { className?: string; deleted?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-[4px] bg-accent/15 px-1 text-[0.5625rem] font-semibold tracking-[0.06em] text-accent uppercase",
        deleted && "bg-raised text-muted",
        className,
      )}
    >
      {deleted ? "Deleted agent" : "Agent"}
    </span>
  );
}
