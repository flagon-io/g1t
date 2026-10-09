import { History } from "lucide-react";
import { Link, useOutletContext, useParams } from "react-router";

import type { WorkspaceAgent } from "@g1t/contracts";

/** Everything the agent did, from the audit log. */
export default function ActivityTab() {
  const agent = useOutletContext<WorkspaceAgent>();
  const { owner = "" } = useParams();
  return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-14 text-center">
      <span className="mx-auto flex size-12 items-center justify-center rounded-xl bg-raised text-muted">
        <History size={22} />
      </span>
      <h2 className="mt-4 text-base font-semibold">Nothing yet</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
        Every reply, task, pull request and approval {agent.display_name} takes part in shows here, with the version of its profile that did it.
      </p>
      <Link to={`/${owner}/-/audit`} className="mt-5 inline-block text-sm text-accent hover:underline">
        Open the workspace&apos;s audit log
      </Link>
    </div>
  );
}
