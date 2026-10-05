import { Coins } from "lucide-react";
import { Link, data } from "react-router";

import type { AgentRun } from "@g1t/contracts";

import type { Route } from "./+types/agents";
import { page } from "../../lib/meta";
import { Idle, RunCard, formatCost, splitRuns, useLiveRefresh } from "../../components/agents";
import { agents } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Agent fleet · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const runs = await agents.listRuns(viewer, { workspace: params.owner, limit: 150 });
  return { runs: unwrap(runs) };
}

/** What the runs shown cost, by project. */
function byProject(runs: AgentRun[]): { repo: string; runs: number; cost: number }[] {
  const totals = new Map<string, { repo: string; runs: number; cost: number }>();
  for (const run of runs) {
    const repo = `${run.repo.namespace}/${run.repo.name}`;
    const total = totals.get(repo) ?? { repo, runs: 0, cost: 0 };
    total.runs += 1;
    total.cost += run.costUsd ?? 0;
    totals.set(repo, total);
  }
  return [...totals.values()].sort((a, b) => b.cost - a.cost || b.runs - a.runs);
}

export default function Fleet({ loaderData, params }: Route.ComponentProps) {
  const { runs } = loaderData;
  const { live, done } = splitRuns(runs);
  useLiveRefresh(live.length > 0);
  const projects = byProject(runs);
  const failed = done.filter((run) => run.status === "failed").length;
  return (
    <div className="space-y-10">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-xs text-muted">At work now</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{live.length}</p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-xs text-muted">Recent runs</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{runs.length}</p>
          {failed > 0 && <p className="mt-0.5 text-xs text-danger">{failed} failed</p>}
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="flex items-center gap-1 text-xs text-muted">
            <Coins size={12} />
            Their cost, as reported
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {formatCost(runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0)) ?? "$0.00"}
          </p>
          <Link to={`/${params.owner}/-/usage`} className="mt-0.5 block text-xs text-muted hover:text-fg">
            What was charged
          </Link>
        </div>
      </div>

      <section>
        <h2 className="text-sm font-medium">Now</h2>
        {live.length === 0 ? (
          <div className="mt-3">
            <Idle>No agent is at work in any of {params.owner}'s projects right now.</Idle>
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {live.map((run) => (
              <RunCard key={run.id} run={run} member showRepo />
            ))}
          </ul>
        )}
      </section>

      {projects.length > 0 && (
        <section>
          <h2 className="text-sm font-medium">By project</h2>
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
            {projects.map((project) => (
              <li key={project.repo} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <Link to={`/${project.repo}/agents`} className="min-w-0 grow truncate font-mono hover:text-accent">
                  {project.repo}
                </Link>
                <span className="text-xs text-muted">
                  {project.runs} {project.runs === 1 ? "run" : "runs"}
                </span>
                <span className="w-16 text-right font-mono text-xs tabular-nums">{formatCost(project.cost) ?? "—"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {done.length > 0 && (
        <section>
          <h2 className="text-sm font-medium">Recently finished</h2>
          <ul className="mt-3 space-y-3">
            {done.slice(0, 30).map((run) => (
              <RunCard key={run.id} run={run} member showRepo />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
