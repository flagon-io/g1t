import { ArrowLeft, Bot, GitBranch, Milestone as MilestoneIcon, Plus, Tag } from "lucide-react";
import { Link, useLocation } from "react-router";

import type { Route } from "./+types/pulls";
import { page } from "../../lib/meta";
import { openedBy } from "../../lib/opened-by";
import { ButtonLink, EmptyState, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { Hint } from "../../components/ui/hint";
import { CheckBadge } from "../../components/checks";
import { ChangeSize, PullIcon, StateTabs } from "../../components/work";
import { AgentBadge, useActiveRuns } from "../../components/agents";
import { FilterMenu, LabelChip, Swatch } from "../../components/labels";
import { colorsOf, listFilters, withFilter } from "../../lib/labels";
import { accessTo, repoFor } from "../../lib/access.server";
import { agents, work } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Pull requests · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  const viewer = getViewer(context);
  // `?label=bug&milestone=3&base=release`, or the same written in `q`.
  const { state, label, milestone, base } = listFilters(new URL(request.url).searchParams);
  // Which an agent is working on, beside the list, so its badges come with it.
  const [pulls, active, { can }, labels, milestones, repo] = await Promise.all([
    work.listPulls(path, viewer, state, {
      label: label || undefined,
      milestone: milestone ?? undefined,
      base: base || undefined,
    }),
    agents.listRuns(viewer, { repo: path, active: true, limit: 100 }).catch(() => null),
    accessTo(context, params),
    work.listLabels(path, viewer),
    work.listMilestones(path, viewer, "open"),
    // The layout looks it up in this request too.
    repoFor(context, params),
  ]);
  return {
    pulls: unwrap(pulls),
    state,
    label,
    milestone,
    base,
    labels: labels.ok ? labels.value : [],
    milestones: milestones.ok ? milestones.value : [],
    defaultBranch: repo.ok ? repo.value.defaultBranch : null,
    // As the project's agents.json has them; left out, the list fetches them.
    active: active?.ok ? { runs: active.value, member: can.run } : undefined,
  } as const;
}

export default function Pulls({ loaderData, params }: Route.ComponentProps) {
  const { pulls, state, active, labels, milestones, label, milestone, defaultBranch } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const list = `${base}/pulls`;
  // Which pull requests an agent is working on this minute, and at what.
  const working = useActiveRuns(params.owner, params.repo, active);
  const current = new URLSearchParams(useLocation().search);
  const colors = colorsOf(labels);
  const milestoneTitle = milestones.find((m) => m.number === milestone)?.title ?? (milestone ? `#${milestone}` : null);
  const filtered = [label, milestone, loaderData.base].some(Boolean);
  const kept = new URLSearchParams(current);
  kept.delete("state");
  kept.delete("q");
  return (
    <div>
      <StateTabs
        to={list}
        state={state}
        query={kept.toString()}
        action={
          <ButtonLink to={`${base}/pulls/new`}>
            <Plus size={15} />
            New pull request
          </ButtonLink>
        }
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <FilterMenu
          label="Label"
          active={label || undefined}
          clearTo={label ? withFilter(list, current, "label", null) : undefined}
          searchPlaceholder="Filter labels"
          emptyText="No label matches."
          options={labels.map((each) => ({
            key: each.name,
            to: withFilter(list, current, "label", each.name),
            keywords: `${each.name} ${each.description}`,
            selected: each.name === label,
            label: (
              <>
                <Swatch color={each.color} />
                <span className="truncate">{each.name}</span>
              </>
            ),
          }))}
        />
        <FilterMenu
          label="Milestone"
          active={milestoneTitle ?? undefined}
          clearTo={milestone ? withFilter(list, current, "milestone", null) : undefined}
          searchPlaceholder="Filter milestones"
          emptyText="No open milestone matches."
          options={milestones.map((each) => ({
            key: String(each.number),
            to: withFilter(list, current, "milestone", String(each.number)),
            keywords: `${each.title} ${each.number}`,
            selected: each.number === milestone,
            label: <span className="truncate">{each.title}</span>,
          }))}
        />
        {loaderData.base && (
          <Hint label="Show pull requests into every branch">
            <Link
              to={withFilter(list, current, "base", null)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent/40 bg-accent/5 px-2.5 text-sm"
            >
              Into <span className="font-mono">{loaderData.base}</span>
              <span className="sr-only">: show pull requests into every branch</span>
            </Link>
          </Hint>
        )}
        {filtered && (
          <Link to={state === "closed" ? `${list}?state=closed` : list} className="text-xs text-muted hover:text-fg">
            Clear filters
          </Link>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Link
            to={`${base}/labels`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            <Tag size={14} />
            Labels
          </Link>
          <Link
            to={`${base}/milestones`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            <MilestoneIcon size={14} />
            Milestones
          </Link>
        </span>
      </div>
      <div className="mt-4">
        {pulls.length === 0 ? (
          <EmptyState
            title={
              filtered
                ? `No ${state} pull requests match these filters`
                : state === "open"
                  ? "No open pull requests"
                  : "No closed pull requests"
            }
          >
            A pull request proposes a change. Assign agents to an issue and
            each opens one in its own fork, or push a branch and open one
            yourself.
          </EmptyState>
        ) : (
          <Card asChild tone="plain" divided className="overflow-hidden">
            <ul>
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
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="min-w-0 truncate font-medium">{pull.title}</span>
                        {pull.status === "draft" && (
                          <Badge className="px-1.5 font-normal text-faint">
                            draft
                          </Badge>
                        )}
                        {(pull.labels ?? []).map((name) => (
                          <LabelChip key={name} name={name} color={colors[name]} />
                        ))}
                        <AgentBadge run={working.get(pull.number)} />
                      </span>
                      <span className="mt-0.5 block text-xs text-faint">
                        #{pull.number} opened <TimeAgo at={pull.createdAt} /> by{" "}
                        {openedBy(pull).name}
                        {pull.requestedBy && <> for {pull.requestedBy.username}</>}
                        {pull.issue != null && <> · for #{pull.issue}</>}
                        {pull.supersededBy != null && <> · superseded by #{pull.supersededBy}</>}
                        {pull.milestone && (
                          <>
                            {" "}
                            · <MilestoneIcon size={11} className="inline" /> {pull.milestone.title}
                          </>
                        )}
                        {/* Into a branch other than the default one: said. */}
                        {pull.base && defaultBranch && pull.base !== defaultBranch && (
                          <>
                            {" "}
                            · <ArrowLeft size={11} className="inline" /> into{" "}
                            <span className="font-mono">{pull.base}</span>
                          </>
                        )}
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
          </Card>
        )}
      </div>
    </div>
  );
}
