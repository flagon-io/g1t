import { Brain } from "lucide-react";
import { Link, data } from "react-router";

import type { Route } from "./+types/memory";
import { page } from "../../lib/meta";
import { AddMemory, MemoryList, memoryAction } from "../../components/memory";
import { agents } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Memory · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Memory can hold what a workspace keeps to itself: members only.
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const memories = await agents.listMemories(viewer, params.owner, { namespace: params.owner, name: params.repo });
  return unwrap(memories);
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  return memoryAction(agents, user, params.owner, { namespace: params.owner, name: params.repo }, await request.formData());
}

export default function ProjectMemory({ loaderData, params }: Route.ComponentProps) {
  const { project, workspace } = loaderData;
  const action = `/${params.owner}/${params.repo}/memory`;
  return (
    <div className="max-w-4xl">
      <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <Brain size={19} className="text-merged" />
        Memory
      </h2>
      <p className="mt-1.5 max-w-2xl text-sm text-muted">
        What agents and people have learned about this project that the next agent should know: how
        to build and test it, its conventions, decisions and why, and its traps. Every g1t agent run
        here is given it, pinned first, together with the workspace's memory. Agents add to it with
        the remember tool as they work; keep it true by editing or forgetting what no longer holds.
      </p>

      <div className="mt-6">
        <AddMemory scope="project" action={action} placeholder="The tests need TZ=UTC or the date tests fail." />
      </div>

      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">This project</h3>
          <span className="text-xs text-muted">{project.length} kept</span>
        </div>
        <div className="mt-3">
          <MemoryList
            memories={project}
            action={action}
            editable
            empty="Nothing yet. Agents add what they learn here as they work, and so can you."
          />
        </div>
      </section>

      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">From the workspace</h3>
          <Link to={`/${params.owner}/-/memory`} className="text-xs text-muted hover:text-fg">
            Manage workspace memory
          </Link>
        </div>
        <p className="mt-1 text-xs text-muted">
          True across all of {params.owner}'s projects, and given to agents here too.
        </p>
        <div className="mt-3">
          <MemoryList
            memories={workspace}
            action={`/${params.owner}/-/memory`}
            editable={false}
            empty="The workspace remembers nothing yet."
          />
        </div>
      </section>
    </div>
  );
}
