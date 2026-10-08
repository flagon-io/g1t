import { Brain } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/memory";
import { page } from "../../lib/meta";
import { AddMemory, MemoryList, memoryAction } from "../../components/memory";
import { ReviewQueue, reviewAction } from "../../components/context";
import { agents, memoryReview } from "../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn, unwrap } from "../../lib/session.server";
import { requireRepo } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Memory · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  // The project's memory is for anyone who can read the repository; the
  // workspace's (and what waits for review) for its members only.
  const { viewer, access } = await requireRepo(context, params, "read");
  const member = !!roleIn(viewer, params.owner);
  const path = { namespace: params.owner, name: params.repo };
  const [memories, candidates] = await Promise.all([
    agents.listMemories(viewer, params.owner, path),
    // Candidates waiting for review (the context hub); none if the service is not there yet.
    member ? memoryReview.listCandidates(viewer, params.owner, path).catch(() => null) : null,
  ]);
  return {
    ...unwrap(memories),
    candidates: candidates?.ok ? candidates.value : [],
    member,
    // Adding to, editing and forgetting the project's memory: Write and up.
    editable: access.can.push,
  };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  return (
    (await reviewAction(memoryReview, user, params.owner, form)) ??
    memoryAction(agents, user, params.owner, { namespace: params.owner, name: params.repo }, form)
  );
}

export default function ProjectMemory({ loaderData, params }: Route.ComponentProps) {
  const { project, workspace, candidates, member, editable } = loaderData;
  const action = `/${params.owner}/${params.repo}/memory`;
  return (
    <div className="max-w-4xl">
      <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <Brain size={19} className="text-accent" />
        Memory
      </h2>
      <p className="mt-1.5 max-w-2xl text-sm text-muted">
        What agents and people have learned about this project that the next agent should know: how
        to build and test it, its conventions, decisions and why, and its traps. Every run of g1t
        here is given it, pinned first{member ? ", together with the workspace's memory" : ""}. Agents add to it with
        the remember tool as they work{editable ? "; keep it true by editing or forgetting what no longer holds" : ""}.
      </p>
      {!editable && (
        <p className="mt-2 text-xs text-muted">
          You can read this project's memory. Adding to it and changing it needs the Write role.
        </p>
      )}

      {editable && (
        <div className="mt-6">
          <AddMemory scope="project" action={action} placeholder="The tests need TZ=UTC or the date tests fail." />
        </div>
      )}

      {candidates.length > 0 && (
        <section className="mt-8">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium">Review</h3>
            <span className="text-xs text-muted">{candidates.length} waiting</span>
          </div>
          <p className="mt-1 text-xs text-muted">
            Learned by agents, from reviews and merges, and from this project's docs. No agent is given one until it is kept.
          </p>
          <div className="mt-3">
            <ReviewQueue candidates={candidates} action={action} empty="" />
          </div>
        </section>
      )}

      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">This project</h3>
          <span className="text-xs text-muted">{project.length} kept</span>
        </div>
        <div className="mt-3">
          <MemoryList
            memories={project}
            action={action}
            editable={editable}
            empty={editable ? "Nothing yet. Agents add what they learn here as they work, and so can you." : "Nothing yet."}
          />
        </div>
      </section>

      {member && (
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
      )}
    </div>
  );
}
