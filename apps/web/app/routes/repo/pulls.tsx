import { Bot, GitBranch, Plus } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/pulls";
import { page } from "../../lib/meta";
import { ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { CheckBadge } from "../../components/checks";
import { ChangeSize, PullIcon, StateTabs } from "../../components/work";
import { AgentBadge, useActiveRuns } from "../../components/agents";
import { work } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Pull requests · ${params.owner}/${params.repo} · g1t` });
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
  // Which pull requests an agent is working on this minute, and at what.
  const working = useActiveRuns(params.owner, params.repo);
  return (
    <div>
      <StateTabs
        to={`${base}/pulls`}
        state={state}
        action={
          <ButtonLink to={`${base}/pulls/new`}>
            <Plus size={15} />
            New pull request
          </ButtonLink>
        }
      />
      <div className="mt-4">
        {pulls.length === 0 ? (
          <EmptyState
            title={state === "open" ? "No open pull requests" : "No closed pull requests"}
          >
            A pull request proposes a change. Assign agents to an issue and
            each opens one in its own fork, or push a branch and open one
            yourself.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {pulls.map((pull) => (
              <li key={pull.id}>
                <Link
                  prefetch="intent"
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
                      <AgentBadge run={working.get(pull.number)} />
                    </span>
                    <span className="mt-0.5 block text-xs text-faint">
                      #{pull.number} opened <TimeAgo at={pull.createdAt} /> by{" "}
                      {pull.author.username}
                      {pull.issue != null && <> · for #{pull.issue}</>}
                      {pull.supersededBy != null && <> · superseded by #{pull.supersededBy}</>}
                    </span>
                  </span>
                  <span className="mt-0.5 hidden sm:block">
                    <ChangeSize files={pull.files} />
                  </span>
                  <span className="mt-0.5">
                    <CheckBadge status={pull.checkStatus} />
                  </span>
                  <span className="mt-0.5 flex shrink-0 items-center gap-1 font-mono text-xs text-muted">
                    {pull.branch ? <GitBranch size={13} /> : <Bot size={13} />}
                    {pull.branch ?? pull.agent}
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
