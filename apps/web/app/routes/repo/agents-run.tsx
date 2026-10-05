import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";

import { RUN_KIND_LABEL, isActiveRun } from "@g1t/contracts";

import type { Route } from "./+types/agents-run";
import { page } from "../../lib/meta";
import { RunCard, useLiveRefresh } from "../../components/agents";
import { agents } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const kind = loaderData ? RUN_KIND_LABEL[loaderData.run.kind] : "Run";
  return page(args, { title: `${kind} run · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const run = await agents.getRun(viewer, { namespace: params.owner, name: params.repo }, params.id);
  return { run: unwrap(run), member: roleIn(viewer, params.owner) != null };
}

function clock(at: string): string {
  return new Date(at).toISOString().slice(11, 19);
}

export default function AgentRunPage({ loaderData, params }: Route.ComponentProps) {
  const { run, member } = loaderData;
  const active = isActiveRun(run.status);
  useLiveRefresh(active);
  const base = `/${params.owner}/${params.repo}`;
  // The newest step first while it runs, so what it is doing is at the top.
  const steps = active ? [...run.steps].reverse() : run.steps;
  return (
    <div className="max-w-4xl">
      <Link to={`${base}/agents`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        At work
      </Link>
      <ul className="mt-4">
        <RunCard run={run} member={member} />
      </ul>
      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">Steps</h3>
          <span className="text-xs text-muted">
            {run.stepCount > run.steps.length
              ? `The latest ${run.steps.length} of ${run.stepCount}`
              : `${run.stepCount} ${run.stepCount === 1 ? "step" : "steps"}`}
            {active && ", newest first"}
          </span>
        </div>
        {steps.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            {active ? "The sandbox is starting. Steps appear here as the agent takes them." : "This run reported no steps."}
          </p>
        ) : (
          <ol className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
            {steps.map((step, index) => (
              <li key={`${step.at}-${index}`} className="flex gap-3 px-4 py-2 text-sm">
                <time dateTime={step.at} className="shrink-0 font-mono text-xs leading-5 text-faint" suppressHydrationWarning>
                  {clock(step.at)}
                </time>
                <span className="min-w-0 font-mono text-xs leading-5 break-words text-fg/85">{step.text}</span>
              </li>
            ))}
          </ol>
        )}
        {run.number != null && (
          <p className="mt-4 text-sm text-muted">
            The full record, with every prompt, message, tool call and result, is in{" "}
            <Link to={`${base}/sessions/${run.number}`} className="text-fg underline-offset-2 hover:underline">
              the session of #{run.number}
            </Link>
            .
          </p>
        )}
      </section>
    </div>
  );
}
