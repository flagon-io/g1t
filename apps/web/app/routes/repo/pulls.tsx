import { Bot } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/pulls";
import { EmptyState, TimeAgo } from "../../components/ui";
import { PullIcon, StateTabs } from "../../components/work";
import { work } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Pull requests · ${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  const state =
    new URL(request.url).searchParams.get("state") === "closed" ? "closed" : "open";
  return {
    pulls: unwrap(await work.listPulls(path, getViewer(context), state)),
    state,
  } as const;
}

export default function Pulls({ loaderData, params }: Route.ComponentProps) {
  const { pulls, state } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  return (
    <div>
      <StateTabs to={`${base}/pulls`} state={state} />
      <div className="mt-4">
        {pulls.length === 0 ? (
          <EmptyState
            title={state === "open" ? "No open pull requests" : "No closed pull requests"}
          >
            A pull request is a change proposed from its own fork. Open one
            from an issue, or have an agent do it.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {pulls.map((pull) => (
              <li key={pull.id}>
                <Link
                  to={`${base}/pull/${pull.number}`}
                  className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface"
                >
                  <span className="mt-0.5">
                    <PullIcon status={pull.status} />
                  </span>
                  <span className="min-w-0 grow">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{pull.title}</span>
                      {pull.status === "draft" && (
                        <span className="shrink-0 rounded-full border border-line px-1.5 py-px text-[0.6875rem] text-faint">
                          draft
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-faint">
                      #{pull.number} opened <TimeAgo at={pull.createdAt} /> by{" "}
                      {pull.author.username}
                      {pull.issue != null && <> · for #{pull.issue}</>}
                      {pull.supersededBy != null && <> · superseded by #{pull.supersededBy}</>}
                    </span>
                  </span>
                  <span className="mt-0.5 flex shrink-0 items-center gap-1 font-mono text-xs text-muted">
                    <Bot size={13} />
                    {pull.agent}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
