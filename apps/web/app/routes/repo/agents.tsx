import { env } from "cloudflare:workers";
import { Bot } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/agents";
import { page } from "../../lib/meta";
import { Idle, RunCard, splitRuns, useLiveRefresh } from "../../components/agents";
import { AgentInstructions } from "../../components/agent-instructions";
import { agents } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Agents at work · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const repo = { namespace: params.owner, name: params.repo };
  const [runs, instructions] = await Promise.all([
    agents.listRuns(viewer, { repo, limit: 60 }),
    // What every run here reads; never holds up the page.
    env.RUNNER.instructions(viewer, repo).catch(() => null),
  ]);
  return {
    runs: unwrap(runs),
    member: roleIn(viewer, params.owner) != null,
    instructions: instructions?.ok ? instructions.value : null,
  };
}

export default function AgentsAtWork({ loaderData, params }: Route.ComponentProps) {
  const { runs, member, instructions } = loaderData;
  const { live, done } = splitRuns(runs);
  useLiveRefresh(live.length > 0);
  const base = `/${params.owner}/${params.repo}`;
  return (
    <div className="max-w-4xl">
      <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <Bot size={19} className="text-merged" />
        At work
      </h2>
      <p className="mt-1.5 max-w-2xl text-sm text-muted">
        Every agent g1t has running on this project, and what each is doing this minute. Each run
        works on one pull request in a sandbox of its own: making the change, revising it, reviewing,
        catching up, answering another agent, or planning. Checks and merge queue sandboxes show here
        too.{member && " Message a run to steer it, or stop it and take over."}
      </p>

      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">Now</h3>
          <span className="text-xs text-muted">
            {live.length === 0 ? "Nothing running" : `${live.length} running`}
          </span>
        </div>
        {live.length === 0 ? (
          <div className="mt-3">
            <Idle>
              No agent is at work here right now. Assign an issue to g1t-agent from the{" "}
              <Link to={`${base}/issues`} className="text-fg underline-offset-2 hover:underline">
                issues
              </Link>{" "}
              to start one.
            </Idle>
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {live.map((run) => (
              <RunCard key={run.id} run={run} member={member} />
            ))}
          </ul>
        )}
      </section>

      {done.length > 0 && (
        <section className="mt-10">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium">Recently finished</h3>
            <Link to={`${base}/sessions`} className="text-xs text-muted hover:text-fg">
              All sessions
            </Link>
          </div>
          <ul className="mt-3 space-y-3">
            {done.slice(0, 20).map((run) => (
              <RunCard key={run.id} run={run} member={member} />
            ))}
          </ul>
        </section>
      )}

      {instructions && <AgentInstructions instructions={instructions} base={base} />}
    </div>
  );
}
