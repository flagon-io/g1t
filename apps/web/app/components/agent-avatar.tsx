import { useMemo } from "react";

import { G1tMark } from "./orchestrator";
import { Avatar } from "./ui";
import { COLUMNS, ROWS, creature } from "../lib/pixel-creature";

/** What an agent's face is drawn from. */
export type AgentLike = {
  id?: string;
  /** Its handle, or a member's name. */
  handle?: string;
  name?: string;
  avatar?: string | null;
  avatar_seed?: string | null;
  builtin?: boolean;
};

/** The seed an agent's creature grows from: its own, else its id, else its handle. */
export function seedOf(agent: AgentLike): string {
  return agent.avatar_seed || agent.id || agent.handle || agent.name || "agent";
}

/** The pixel creature for a seed, on its own ground; wiggles a little on hover. */
export function PixelCreature({ seed, size = 20, className = "" }: { seed: string; size?: number; className?: string }) {
  const { cells, colour } = useMemo(() => creature(seed), [seed]);
  // Cells of 10, the 5×7 sprite centred in a 90×90 square.
  const x0 = (90 - COLUMNS * 10) / 2;
  const y0 = (90 - ROWS * 10) / 2;
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center hover:animate-wiggle motion-reduce:animate-none ${className}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), background: colour.ground, boxShadow: `inset 0 0 0 1px ${colour.fg}33` }}
    >
      <svg viewBox="0 0 90 90" width={size} height={size} shapeRendering="crispEdges">
        {cells.map((row, r) =>
          row.map((cell, c) =>
            cell === 0 ? null : (
              <rect key={`${r}:${c}`} x={x0 + c * 10} y={y0 + r * 10} width={10} height={10} fill={cell === 2 ? colour.ground : colour.fg} />
            ),
          ),
        )}
      </svg>
    </span>
  );
}

/**
 * An agent's face wherever it appears: an uploaded picture, g1t's pixel 1,
 * or its own creature.
 */
export function AgentAvatar({ agent, size = 20 }: { agent: AgentLike; size?: number }) {
  if (agent.builtin || agent.handle === "g1t" || agent.name === "g1t") return <G1tMark size={size} />;
  if (agent.avatar) return <Avatar name={agent.handle ?? agent.name ?? "agent"} image={agent.avatar} size={size} square />;
  return <PixelCreature seed={seedOf(agent)} size={size} />;
}
