import type { WorkspaceAgent } from "@g1t/contracts";

import { Mark } from "./logo";

/**
 * Whether an agent is `@g1t`, the orchestrator every workspace has: built
 * in, first in the agents service's list. Its handle is never another agent's.
 */
export function isOrchestrator(agent: Pick<WorkspaceAgent, "handle"> & { builtin?: boolean | null }): boolean {
  return agent.builtin === true || agent.handle === "g1t";
}

/** g1t's face: the pixel 1 of the logo on a dark square, where agents wear the sparkle. */
export function G1tMark({ size = 20 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center bg-[#0b0b0d] text-fg ring-1 ring-line-strong ring-inset scheme-dark"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.26) }}
    >
      <Mark className="size-full" />
    </span>
  );
}
