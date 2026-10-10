import { Lock, Plus, Search } from "lucide-react";
import { data, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";

import { type Team, mayCreateTeams } from "@g1t/contracts";

import type { Route } from "./+types/teams";
import { page } from "../../lib/meta";
import { TeamRow } from "../../components/teams";
import { ButtonLink, EmptyState, notACredential } from "../../components/ui";
import { filterTeams, splitTeams } from "../../lib/teams";
import { agentIdsOn } from "../../lib/people";
import { identity, workspaceAgents } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Teams · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // A workspace's teams are its members' business.
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const [teams, workspace, directory, agents] = await Promise.all([
    identity.listTeams(viewer, params.owner).then(unwrap),
    identity.getWorkspace(params.owner).catch(() => null),
    // Which agents are on each team: added to it, or their home team.
    identity.peopleDirectory(viewer, params.owner).catch(() => null),
    workspaceAgents.list(params.owner, viewer!).catch(() => null),
  ]);
  const listed = agents?.ok ? agents.value : [];
  const agentCounts = Object.fromEntries(
    (directory?.ok ? directory.value.teams : []).map((team) => [team.slug, agentIdsOn(team, listed).length]),
  );
  // Who may create one is the workspace's to say (its settings).
  return { teams, agentCounts, slug: params.owner.toLowerCase(), canCreate: mayCreateTeams(workspace?.teamCreation, role) };
}

/** Searching changes only the address: the list is already here. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname) return false;
  return defaultShouldRevalidate;
}

export default function WorkspaceTeams({ loaderData }: Route.ComponentProps) {
  const { teams, agentCounts, slug, canCreate } = loaderData;
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const { mine, others } = splitTeams(filterTeams(teams, query));
  const setQuery = (value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set("q", value);
        else next.delete("q");
        return next;
      },
      { replace: true, preventScrollReset: true },
    );

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="relative block sm:w-72">
          <span className="sr-only">Find a team</span>
          <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a team"
            {...notACredential()}
            className="w-full rounded-md border border-line bg-bg py-1.5 pr-3 pl-8 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
          />
        </label>
        {canCreate ? (
          <ButtonLink to={`/${slug}/-/teams/new`}>
            <Plus size={15} />
            New team
          </ButtonLink>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Lock size={13} className="shrink-0 text-faint" />
            Only owners can create teams in this workspace.
          </p>
        )}
      </div>

      {teams.length === 0 ? (
        <EmptyState title="No teams yet">
          A team brings people and agents together: a lead, a channel, roles on repositories and a budget for its agents.
          Mention it as <span className="font-mono text-fg">@{slug}/team</span>, or ask it to review a pull request.
        </EmptyState>
      ) : mine.length + others.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
          No teams match.{" "}
          <button type="button" className="text-accent hover:underline" onClick={() => setQuery("")}>
            Show them all
          </button>
        </p>
      ) : (
        <>
          {mine.length > 0 && <TeamList title="Your teams" teams={mine} agents={agentCounts} />}
          {others.length > 0 && <TeamList title={mine.length > 0 ? "Other teams" : "All teams"} teams={others} agents={agentCounts} />}
        </>
      )}
    </div>
  );
}

function TeamList({ title, teams, agents }: { title: string; teams: Team[]; agents: Record<string, number> }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-3 text-sm font-medium text-muted">
        {title} <span className="text-faint">{teams.length}</span>
      </h2>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {teams.map((team) => (
          <TeamRow key={team.id} team={team} agents={agents[team.slug]} />
        ))}
      </ul>
    </section>
  );
}
