import { Box, ChevronRight, Code2, Crown, Database, Hash, Network, Settings, Users, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Outlet, data } from "react-router";

import { teamHandle, teamKindLabel } from "@g1t/contracts";

import type { Route } from "./+types/layout";
import { page } from "../../../lib/meta";
import { TeamBadges, type TeamContext } from "../../../components/teams";
import { Coming, TeamKindMark } from "../../../components/people";
import { CopyLine, TabLink } from "../../../components/ui";
import { Hint } from "../../../components/ui/hint";
import { TabStrip } from "../../../components/ui/tab-strip";
import { agentsOn, agentPath, peopleAgent, personPath } from "../../../lib/people";
import { teamPath } from "../../../lib/teams";
import { money } from "../../../lib/usage";
import { identity, workspaceAgents } from "../../../lib/services.server";
import { getViewer, roleIn } from "../../../lib/session.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${loaderData?.team.name ?? params.team} · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const [found, added, listed] = await Promise.all([
    identity.getTeam(viewer, params.owner, params.team),
    identity.teamAgents(viewer, params.owner, params.team).catch(() => null),
    workspaceAgents.list(params.owner, viewer!).catch(() => null),
  ]);
  // A secret team someone is not in looks like no team at all.
  if (!found.ok) throw data(null, { status: 404 });
  const team = found.value;
  const ids = added?.ok ? added.value.map((agent) => agent.agent_id) : [];
  const all = listed?.ok ? listed.value.map(peopleAgent) : [];
  return { team, agents: agentsOn({ slug: team.slug, agent_ids: ids }, all), added: ids };
}

export default function TeamLayout({ loaderData }: Route.ComponentProps) {
  const { team, agents, added } = loaderData;
  const base = teamPath(team.workspace, team.slug);
  const lead =
    team.lead?.kind === "user"
      ? { name: team.lead.name ?? team.lead.username, to: personPath(team.workspace, team.lead.username) }
      : team.lead?.kind === "agent"
        ? (() => {
            const agentId = team.lead.agent_id;
            const agent = agents.find((a) => a.id === agentId);
            return agent ? { name: agent.display_name, to: agentPath(team.workspace, agent.handle) } : null;
          })()
        : null;
  const spent = agents.reduce((sum, agent) => sum + agent.spent_month_micros, 0);
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
          <Fact>
            <TeamKindMark people={team.members_count} agents={agents.length} />
            {teamKindLabel(team.members_count, agents.length)}
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
            <Hint label="Its roles on repositories, given to everyone on it and its child teams. Agents on it work with the access of whoever asks them.">
              <Link to={`${base}/repositories`} className="hover:text-fg">
                Code: {team.repos_count ? `${team.repos_count} ${team.repos_count === 1 ? "repository" : "repositories"}` : "no roles yet"}
              </Link>
            </Hint>
          </Fact>
          <Fact icon={<Database size={12} />}>
            Storage <Coming />
          </Fact>
          <Fact icon={<Wallet size={12} />}>
            {team.budget_micros ? (
              <span className="tabular-nums">
                {money(spent)} of {money(team.budget_micros)} this month
              </span>
            ) : (
              "No team budget"
            )}
          </Fact>
        </ul>
        <div className="mt-3 max-w-xs">
          <CopyLine text={teamHandle(team)} />
        </div>
        <TabStrip label="Team" className="mt-5 gap-1">
          <TabLink to={base} end icon={<Users size={15} />} count={team.members_count + agents.length}>
            People and agents
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
        <Outlet context={{ team, agents, added } satisfies TeamContext} />
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
