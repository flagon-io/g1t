import { data } from "react-router";

import type { Route } from "./+types/memory";
import { page } from "../../lib/meta";
import { AddMemory, MemoryList, memoryAction } from "../../components/memory";
import { agents } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Workspace memory · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const memories = await agents.listMemories(viewer, params.owner);
  return { workspace: unwrap(memories).workspace };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  return memoryAction(agents, user, params.owner, null, await request.formData());
}

export default function WorkspaceMemory({ loaderData, params }: Route.ComponentProps) {
  const { workspace } = loaderData;
  const action = `/${params.owner}/-/memory`;
  return (
    <div className="space-y-8">
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="font-medium">Here: true in every project</p>
          <p className="mt-1 text-muted">
            "We use pnpm everywhere." "Staging lives at staging.example.com." "Every service logs
            JSON to stdout." What an agent in any project should know.
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="font-medium">In a project: true of its code</p>
          <p className="mt-1 text-muted">
            How to build and test it, its conventions and its traps. Each project keeps its own under
            Agents, Memory.
          </p>
        </div>
      </div>

      <AddMemory scope="workspace" action={action} placeholder="We use pnpm everywhere, never npm or yarn." />

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">What the workspace remembers</h2>
          <span className="text-xs text-muted">{workspace.length} kept</span>
        </div>
        <div className="mt-3">
          <MemoryList
            memories={workspace}
            action={action}
            editable
            empty="Nothing yet. Agents add what holds across projects as they learn it, and so can you."
          />
        </div>
      </section>
    </div>
  );
}
