import { Box, ChevronRight, Network, Settings, Users } from "lucide-react";
import { Link, Outlet, data } from "react-router";

import { teamHandle } from "@g1t/contracts";

import type { Route } from "./+types/layout";
import { page } from "../../../lib/meta";
import { TeamBadges, type TeamContext } from "../../../components/teams";
import { CopyLine, TabLink } from "../../../components/ui";
import { teamPath } from "../../../lib/teams";
import { identity } from "../../../lib/services.server";
import { getViewer, roleIn } from "../../../lib/session.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${loaderData?.team.name ?? params.team} · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const found = await identity.getTeam(viewer, params.owner, params.team);
  // A secret team someone is not in looks like no team at all.
  if (!found.ok) throw data(null, { status: 404 });
  return { team: found.value };
}

export default function TeamLayout({ loaderData }: Route.ComponentProps) {
  const { team } = loaderData;
  const base = teamPath(team.workspace, team.slug);
  return (
    <div>
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-muted">
        <Link to={`/${team.workspace}/-/teams`} className="hover:text-fg">
          Teams
        </Link>
        {team.parent && (
          <>
            <ChevronRight size={13} className="text-faint" />
            <Link to={teamPath(team.workspace, team.parent.slug)} className="hover:text-fg">
              {team.parent.name}
            </Link>
          </>
        )}
        <ChevronRight size={13} className="text-faint" />
        <span className="text-fg">{team.name}</span>
      </nav>
      <header className="mt-4 border-b border-line">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1>
          <TeamBadges team={team} />
        </div>
        {team.description && <p className="mt-1.5 text-sm text-muted">{team.description}</p>}
        <div className="mt-3 max-w-xs">
          <CopyLine text={teamHandle(team)} />
        </div>
        <nav aria-label="Team" className="mt-5 flex gap-1 overflow-x-auto">
          <TabLink to={base} end icon={<Users size={15} />} count={team.members_count}>
            Members
          </TabLink>
          <TabLink to={`${base}/teams`} icon={<Network size={15} />} count={team.child_teams_count}>
            Child teams
          </TabLink>
          <TabLink to={`${base}/repositories`} icon={<Box size={15} />} count={team.repos_count}>
            Repositories
          </TabLink>
          {team.can_manage && (
            <TabLink to={`${base}/settings`} icon={<Settings size={15} />}>
              Settings
            </TabLink>
          )}
        </nav>
      </header>
      <div className="pt-6">
        <Outlet context={{ team } satisfies TeamContext} />
      </div>
    </div>
  );
}
