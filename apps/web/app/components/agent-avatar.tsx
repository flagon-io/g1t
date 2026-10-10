import type { AgentLook, AgentStatus } from "@g1t/contracts";

import { type FaceState, faceStateOf } from "./agent-face";
import { Avatar } from "./ui/avatar";

/** What an agent's face is drawn from. */
export type AgentLike = {
  id?: string;
  /** Its handle, or a member's name. */
  handle?: string;
  name?: string;
  avatar?: string | null;
  avatar_seed?: string | null;
  /** Its chosen face; null or missing, the seed's. */
  look?: AgentLook | null;
  builtin?: boolean;
  /** Its status, when the place it shows should show it on its face. */
  status?: AgentStatus | null;
};

/** The seed an agent's face grows from: its own, else its id, else its handle. */
export function seedOf(agent: AgentLike): string {
  return agent.avatar_seed || agent.id || agent.handle || agent.name || "agent";
}

/**
 * An agent's face wherever it appears: the shared Avatar with `agent` set
 * (components/ui/avatar.tsx), so it is an uploaded picture, g1t's pixel 1,
 * or its bot face, always with the agent marker. `state` says what the
 * face is doing; left out, the agent's status decides, if it is known.
 */
export function AgentAvatar({ agent, size = 20, state, ring }: { agent: AgentLike; size?: number; state?: FaceState; ring?: string }) {
  const g1t = agent.builtin || agent.handle === "g1t" || agent.name === "g1t";
  return (
    <Avatar
      name={agent.handle ?? agent.name ?? "agent"}
      image={agent.avatar}
      system={g1t}
      size={size}
      ring={ring}
      agent={{ look: agent.look ?? null, seed: seedOf(agent), state: state ?? faceStateOf(agent.status) }}
    />
  );
}
