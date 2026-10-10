import { Info } from "lucide-react";
import { Link, data } from "react-router";

import type { Route } from "./+types/org-chart";
import { AgentPersonFace, PersonFace, TeamKindMark } from "../../components/people";
import { Card } from "../../components/ui/card";
import { Hint } from "../../components/ui/hint";
import { page } from "../../lib/meta";
import { type OrgNode, agentPath, orgChart, peopleAgent, personName, personPath } from "../../lib/people";
import { teamPath } from "../../lib/teams";
import { identity, workspaceAgents } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Org chart · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const [directory, agents] = await Promise.all([
    identity.peopleDirectory(viewer, params.owner).then(unwrap),
    workspaceAgents.list(params.owner, viewer!).catch(() => null),
  ]);
  return { slug: params.owner.toLowerCase(), directory, agents: agents?.ok ? agents.value.map(peopleAgent) : [] };
}

export default function OrgChartPage({ loaderData }: Route.ComponentProps) {
  const { slug, directory, agents } = loaderData;
  const chart = orgChart(directory, agents);
  const lines = directory.people.some((person) => person.manager);

  return (
    <div className="space-y-6">
      {!lines && (
        <Card asChild radius="lg" className="flex items-start gap-2 px-3 py-2.5 text-sm text-muted">
          <p>
            <Info size={15} className="mt-0.5 shrink-0 text-faint" />
            {directory.can_manage
              ? "No one reports to anyone yet. Set who each person reports to under Edit profile on their profile."
              : "No reporting lines yet. An owner sets who each person reports to on their profile."}
          </p>
        </Card>
      )}
      <Card asChild className="overflow-x-auto p-4 sm:p-5">
        <section aria-label="Reporting lines">
          <ul className="space-y-1">
            {chart.roots.map((root) => (
              <Branch key={root.person.username} slug={slug} node={root} />
            ))}
          </ul>
          <p className="mt-4 text-xs text-faint">The agents on a team appear beside the person who leads it, as its members; each opens the agent's page in Agents.</p>
        </section>
      </Card>

      {chart.unled.length > 0 && (
        <section aria-labelledby="unled" className="space-y-3">
          <h2 id="unled" className="text-sm font-medium text-muted">
            Teams no person leads
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {chart.unled.map(({ team, agents: teamAgents }) => (
              <Card asChild key={team.slug} className="p-4">
                <li>
                  <div className="flex items-center gap-2">
                    <TeamKindMark people={team.people.length} agents={teamAgents.length} />
                    <Link to={teamPath(slug, team.slug)} className="font-medium hover:text-accent">
                      {team.name}
                    </Link>
                    {team.lead?.kind === "agent" && (
                      <span className="text-xs text-faint">led by {teamAgents.find((a) => a.id === (team.lead as { agent_id: string }).agent_id)?.display_name ?? "an agent"}</span>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {teamAgents.map((agent) => (
                      <Link key={agent.id} to={agentPath(slug, agent.handle)} className="inline-flex items-center gap-1.5 rounded-full border border-line py-0.5 pr-2.5 pl-0.5 text-xs hover:border-line-strong">
                        <AgentPersonFace agent={agent} size={20} ring="var(--color-surface)" />
                        {agent.display_name}
                      </Link>
                    ))}
                  </div>
                </li>
              </Card>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One person, the agents of the teams they lead, and everyone who reports to them below. */
function Branch({ slug, node }: { slug: string; node: OrgNode }) {
  const { person } = node;
  return (
    <li>
      <div className="flex flex-wrap items-center gap-2 py-1">
        <Link
          to={personPath(slug, person.username)}
          prefetch="intent"
          className="inline-flex min-w-0 items-center gap-2.5 rounded-lg border border-line bg-bg py-1.5 pr-3 pl-1.5 transition-colors hover:border-accent/60"
        >
          <PersonFace person={person} size={28} />
          <span className="grid min-w-0 text-left">
            <span className="truncate text-sm font-medium">{personName(person)}</span>
            <span className="truncate text-xs text-muted">{person.title ?? `@${person.username}`}</span>
          </span>
        </Link>
        {node.agents.length > 0 && (
          <span className="inline-flex items-center gap-2">
            <span className="flex">
              {node.agents.slice(0, 6).map((agent, index) => (
                <Hint key={agent.id} label={`${agent.display_name} · ${agent.title || agent.role} · agent`}>
                  <Link to={agentPath(slug, agent.handle)} className={index ? "-ml-1.5" : undefined} aria-label={agent.display_name}>
                    <AgentPersonFace agent={agent} size={22} ring="var(--color-surface)" />
                  </Link>
                </Hint>
              ))}
            </span>
            <span className="text-xs text-faint">
              {node.agents.length > 6 ? `+${node.agents.length - 6} · ` : ""}
              {node.leads.map((team) => team.name).join(", ")}
            </span>
          </span>
        )}
      </div>
      {node.reports.length > 0 && (
        <ul className="ml-[17px] space-y-1 border-l border-dashed border-line-strong pl-5 sm:pl-7">
          {node.reports.map((report) => (
            <Branch key={report.person.username} slug={slug} node={report} />
          ))}
        </ul>
      )}
    </li>
  );
}
