import { ArrowUpRight, Bot, ChevronRight, KeyRound, MessageSquare, Sparkles, UsersRound } from "lucide-react";
import type { ReactNode } from "react";
import { Link, data } from "react-router";

import type { Route } from "./+types/agent";
import { AgentLink, AgentPersonFace, AgentTag, Coming, PersonFace, PersonLink, TeamKindMark, ToldText } from "../../../components/people";
import { statusLabel } from "../../../components/chat/marks";
import { ButtonLink } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { page } from "../../../lib/meta";
import { agentsOn, leads, peopleAgent, teamsOfAgent } from "../../../lib/people";
import { teamPath } from "../../../lib/teams";
import { money } from "../../../lib/money";
import { identity, workspaceAgents } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../../lib/session.server";
import { agentTeamsFor, changeAgentTeam } from "../../../lib/agent-teams.server";
import { AgentTeamsEditor } from "../../../components/teams";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${loaderData?.agent.display_name ?? params.handle} · People · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const [found, directory, listed, told] = await Promise.all([
    workspaceAgents.get(params.owner, params.handle, viewer!),
    identity.peopleDirectory(viewer, params.owner).then(unwrap),
    workspaceAgents.list(params.owner, viewer!).catch(() => null),
    workspaceAgents.teamContext(params.owner, params.handle, viewer!).catch(() => null),
  ]);
  if (!found.ok) throw data(null, { status: 404 });
  const agent = found.value;
  const agents = listed?.ok ? listed.value.map(peopleAgent) : [peopleAgent(agent)];
  const teams = teamsOfAgent(directory.teams, agent);
  // Its teams to change here, as a person's are changed on the team: Remove where the viewer manages one, and Add.
  const editable = agent.scope === "personal" ? null : await agentTeamsFor(viewer!, params.owner.toLowerCase(), agent.id, directory);
  // Everyone on its teams, each once, leads first.
  const names = new Set(teams.flatMap((team) => team.people.map((p) => p.username)));
  const leadNames = new Set(teams.flatMap((team) => (team.lead?.kind === "user" ? [team.lead.username] : [])));
  const teammates = directory.people
    .filter((person) => names.has(person.username))
    .sort((a, b) => Number(leadNames.has(b.username)) - Number(leadNames.has(a.username)))
    .map(({ user_id, username, display_username, name, avatar, title, owns }) => ({ user_id, username, display_username, name, avatar, title, owns, lead: leadNames.has(username) }));
  return {
    slug: params.owner.toLowerCase(),
    agent: { ...peopleAgent(agent), monthly_micros: agent.budget.monthly_micros },
    personal: agent.scope === "personal",
    editable,
    teams,
    teammates,
    agents,
    told: told?.ok ? told.value.text : null,
  };
}

/** Adding the agent to a team, or taking it off one. */
export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const changed = await changeAgentTeam(await request.formData(), viewer, params.owner.toLowerCase(), params.handle.toLowerCase());
  return changed ?? { intent: "join-team" as const, team: "", error: "Unknown request." };
}

export default function AgentProfile({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, agent, teams, teammates, agents, told, editable, personal } = loaderData;
  const otherAgents = teams
    .flatMap((team) => agentsOn(team, agents))
    .filter((other, index, all) => other.id !== agent.id && all.findIndex((a) => a.id === other.id) === index);

  return (
    <div className="space-y-8">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-muted">
        <Link to={`/${slug}/-/people?kind=agents`} className="hover:text-fg">
          People
        </Link>
        <ChevronRight size={13} className="text-faint" />
        <span className="truncate text-fg">{agent.display_name}</span>
      </nav>

      <header className="flex flex-col gap-5 border-b border-line pb-6 sm:flex-row sm:items-start">
        <div className="self-start">
          <AgentPersonFace agent={agent} size={72} />
        </div>
        <div className="min-w-0 grow space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{agent.display_name}</h1>
            <AgentTag />
          </div>
          <p className="text-sm text-muted">{[agent.title || agent.role, `@${agent.handle}`].join(" · ")}</p>
          <p className="text-sm text-muted">{statusLabel(agent.status)}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <ButtonLink to={`/${slug}/-/chat?agent=${agent.handle}`}>
            <MessageSquare size={15} />
            Message
          </ButtonLink>
          <ButtonLink to={`/${slug}/-/agents/${agent.handle}`} variant="outline">
            Sessions and settings
            <ArrowUpRight size={14} />
          </ButtonLink>
        </div>
      </header>

      {agent.responsibilities.length > 0 && (
        <section className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-sm text-muted">Responsible for</span>
          {agent.responsibilities.map((duty) => (
            <Badge key={duty} tone="info">
              {duty}
            </Badge>
          ))}
        </section>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card icon={<UsersRound size={14} />} title="Teams">
          {editable || personal ? (
            <AgentTeamsEditor slug={slug} name={agent.display_name} teams={editable} personal={personal} change={actionData} />
          ) : teams.length ? (
            <ul className="space-y-2">
              {teams.map((team) => (
                <li key={team.slug} className="flex flex-wrap items-center gap-2">
                  <TeamKindMark people={team.people.length} agents={agentsOn(team, agents).length} />
                  <Link to={teamPath(slug, team.slug)} className="font-medium hover:text-accent">
                    {team.name}
                  </Link>
                  {leads(team.lead, { id: agent.id }) && <Badge tone="accent">Lead</Badge>}
                </li>
              ))}
            </ul>
          ) : (
            <Quiet>Not on a team yet.</Quiet>
          )}
        </Card>

        <Card icon={<Sparkles size={14} />} title="Who it works with">
          {teammates.length ? (
            <ul className="space-y-2">
              {teammates.map((person) => (
                <li key={person.username} className="flex min-w-0 items-center gap-2.5 text-sm">
                  <PersonFace person={person} size={24} ring="var(--color-surface)" />
                  <span className="min-w-0 grow truncate">
                    <PersonLink workspace={slug} person={person} className="font-medium" />
                    {person.title && <span className="text-muted"> · {person.title}</span>}
                  </span>
                  {person.lead && <Badge tone="accent">Lead</Badge>}
                </li>
              ))}
            </ul>
          ) : (
            <Quiet>{teams.length ? "Its teams are agents only." : "No people yet."}</Quiet>
          )}
        </Card>

        <Card icon={<Bot size={14} />} title="Agents on its teams">
          {otherAgents.length ? (
            <ul className="space-y-2">
              {otherAgents.map((other) => (
                <li key={other.id} className="flex min-w-0 items-center gap-2.5 text-sm">
                  <AgentPersonFace agent={other} size={24} ring="var(--color-surface)" />
                  <span className="min-w-0 truncate">
                    <AgentLink workspace={slug} agent={other} className="font-medium" />
                    <span className="text-muted"> · {other.title || other.role}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Quiet>No other agents on its teams.</Quiet>
          )}
        </Card>

        <Card icon={<KeyRound size={14} />} title="Access">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs text-faint">Code</dt>
              <dd className="mt-0.5">What the person who asks it can read, and only what everyone in the conversation can see</dd>
            </div>
            <div>
              <dt className="flex items-center gap-2 text-xs text-faint">
                Storage <Coming />
              </dt>
              <dd className="mt-0.5 text-muted">Which of the workspace's files it may read and write comes with Storage.</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Spent this month</dt>
              <dd className="mt-0.5 tabular-nums">
                {money(agent.spent_month_micros)}
                {agent.monthly_micros != null && <span className="text-muted"> of {money(agent.monthly_micros)}</span>}
              </dd>
            </div>
          </dl>
        </Card>
      </div>

      <section className="rounded-xl border border-accent/40 bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Sparkles size={14} className="text-accent" />
            What {agent.display_name} knows about its teams
          </h2>
          <span className="text-xs text-faint">Told every turn, from the team pages and who's around now</span>
        </div>
        {told ? <ToldText text={told} /> : <Quiet>Nothing yet: it's on no visible team. Once it is, it's told who leads, who owns what and who to page.</Quiet>}
      </section>
    </div>
  );
}

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-muted">
        <span className="text-faint">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-sm text-faint">{children}</p>;
}
