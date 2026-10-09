import { Inbox } from "lucide-react";
import { useOutletContext, useParams } from "react-router";

import type { WorkspaceAgent } from "@g1t/contracts";

import { MessageAgent } from "./agent";

/**
 * Every task the agent holds, as live cards. Tasks arrive with the desk
 * (docs/WORKSPACE.md, "Tasks"); until then, the way to give it one.
 */
export default function Desk() {
  const agent = useOutletContext<WorkspaceAgent>();
  const { owner = "" } = useParams();
  return (
    <div className="rounded-2xl border border-dashed border-line bg-surface/40 px-6 py-16 text-center">
      <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-raised text-muted">
        <Inbox size={22} />
      </span>
      <h2 className="mt-4 text-base font-semibold">No tasks yet</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
        DM {agent.display_name} to give it one. It answers questions in the conversation and opens a task when the work needs one; each task
        shows here with its steps, cost and what it&apos;s waiting on.
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
