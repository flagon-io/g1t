import { useOutletContext, useParams } from "react-router";

import type { WorkspaceAgent } from "@g1t/contracts";

import { MessageAgent } from "./agent";
import { AgentAvatar } from "../../../components/agent-avatar";
import { isOrchestrator } from "../../../components/orchestrator";

/** An empty desk, in the agent's own voice. */
const EMPTY_DESK: Record<string, string> = {
  crisp: "Nothing on my desk. Send me something and I'll take it from there.",
  friendly: "My desk is all clear! Send me something to work on and I'll get going.",
  socratic: "Nothing here yet. What would you like me to look at first?",
  terse: "Desk empty. Send work.",
};

/**
 * Every task the agent holds, as live cards. Tasks arrive with the desk
 * (docs/WORKSPACE.md, "Tasks"); until then, the way to give it one.
 */
export default function Desk() {
  const agent = useOutletContext<WorkspaceAgent>();
  const { owner = "" } = useParams();
  return (
    <div className="rounded-2xl border border-dashed border-line bg-surface/40 px-6 py-16 text-center">
      <span className="mx-auto flex justify-center">
        <AgentAvatar agent={{ ...agent, builtin: isOrchestrator(agent) }} size={52} />
      </span>
      <h2 className="mt-4 text-base font-semibold">No tasks yet</h2>
      <blockquote className="mx-auto mt-3 max-w-md text-[0.9375rem] text-fg-soft">
        &ldquo;{EMPTY_DESK[agent.personality_preset] ?? EMPTY_DESK.crisp}&rdquo;
        <footer className="mt-1 text-xs text-faint">{agent.display_name}</footer>
      </blockquote>
      <p className="mx-auto mt-4 max-w-md text-sm text-muted">
        DM {agent.display_name} to give it one. Each task shows here with its steps, cost and what it&apos;s waiting on.
      </p>
      <div className="mt-6 flex justify-center">
        <MessageAgent slug={owner} agent={agent} variant="accent" />
      </div>
      <p className="mt-4 text-xs text-faint">
        Works up to {agent.capacity} {agent.capacity === 1 ? "task" : "tasks"} at once; more wait here in line.
      </p>
    </div>
  );
}
