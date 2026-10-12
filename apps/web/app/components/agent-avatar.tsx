import { Avatar } from "./ui/avatar";

/**
 * Who an agent's avatar is drawn for: g1t itself, or the author of an old
 * message from an agent that no longer exists. Extra fields older callers
 * pass (a face, a status) are accepted and not drawn.
 */
export type AgentLike = {
  id?: string;
  /** Its handle, or a member's name. */
  handle?: string;
  name?: string;
  avatar?: string | null;
  avatar_seed?: string | null;
  look?: unknown;
  builtin?: boolean;
  status?: unknown;
};

/**
 * An agent's avatar wherever it appears: the shared Avatar with `agent`
 * set (components/ui/avatar.tsx), so it is g1t's pixel 1, an uploaded
 * picture, or its initial on a tile, always with the agent marker.
 */
export function AgentAvatar({ agent, size = 20, ring }: { agent: AgentLike; size?: number; state?: unknown; ring?: string }) {
  const g1t = agent.builtin || agent.handle === "g1t" || agent.name === "g1t";
  return <Avatar name={agent.handle ?? agent.name ?? "agent"} image={agent.avatar} system={g1t} size={size} ring={ring} agent />;
}
