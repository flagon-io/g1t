import { Box, ChevronRight, Code2, Crown, Database, Hash, Network, Settings, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Outlet, data } from "react-router";

import { teamHandle } from "@g1t/contracts";

import type { Route } from "./+types/layout";
import { page } from "../../../lib/meta";
import { TeamBadges, type TeamContext } from "../../../components/teams";
import { Coming } from "../../../components/people";
import { CopyLine, TabLink } from "../../../components/ui";
import { Hint } from "../../../components/ui/hint";
import { TabStrip } from "../../../components/ui/tab-strip";
import { personPath } from "../../../lib/people";
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
  // A team is led by a person; an old agent lead (agents no longer exist) is no lead.
  const lead = team.lead?.kind === "user" ? { name: team.lead.name ?? team.lead.username, to: personPath(team.workspace, team.lead.username) } : null;
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
        <ul aria-label="What the team has" className="mt-3 flex flex-wrap gap-1.5">
          <Fact icon={<Users size={12} />}>
            {team.members_count ? `${team.members_count} ${team.members_count === 1 ? "person" : "people"}` : "No one yet"}
          </Fact>
          <Fact icon={<Crown size={12} />}>
            {lead ? (
              <>
                Led by{" "}
                <Link to={lead.to} className="font-medium text-fg hover:text-accent">
                  {lead.name}
                </Link>
              </>
            ) : (
              "No lead"
            )}
          </Fact>
          <Fact icon={<Hash size={12} />}>
            {team.channel ? (
              <Link to={`/${team.workspace}/-/chat/${team.channel.name}`} className="font-medium text-fg hover:text-accent">
                {team.channel.name}
              </Link>
            ) : (
              "No channel"
            )}
          </Fact>
          <Fact icon={<Code2 size={12} />}>
            <Hint label="Its roles on repositories, given to everyone on it and its child teams.">
              <Link to={`${base}/repositories`} className="hover:text-fg">
                Code: {team.repos_count ? `${team.repos_count} ${team.repos_count === 1 ? "repository" : "repositories"}` : "no roles yet"}
              </Link>
            </Hint>
          </Fact>
          <Fact icon={<Database size={12} />}>
            Storage <Coming />
          </Fact>
        </ul>
        <div className="mt-3 max-w-xs">
          <CopyLine text={teamHandle(team)} />
        </div>
        <TabStrip label="Team" className="mt-5 gap-1">
          <TabLink to={base} end icon={<Users size={15} />} count={team.members_count}>
            People
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
        </TabStrip>
      </header>
      <div className="pt-6">
        <Outlet context={{ team } satisfies TeamContext} />
      </div>
    </div>
  );
}

function Fact({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs text-muted">
      {icon && <span className="text-faint">{icon}</span>}
      {children}
    </li>
  );
}
