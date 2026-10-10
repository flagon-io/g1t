import { Bot, Sparkles, Users } from "lucide-react";
import { Form, Link, data, useSearchParams } from "react-router";

import type { TeamRole } from "@g1t/contracts";

import type { Route } from "./+types/members";
import { AgentLink, AgentPersonFace, ToldText } from "../../../components/people";
import { useTeam, useTeamAgents } from "../../../components/teams";
import { Avatar, ErrorText, Field, Input, SubmitButton } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { CheckboxOption } from "../../../components/ui/checkbox";
import { SelectField } from "../../../components/ui/select";
import { Switch } from "../../../components/ui/switch";
import { WithPresence } from "../../../components/presence";
import { agentsOn, leads, peopleAgent, personPath, teamBlock } from "../../../lib/people";
import { teamPath } from "../../../lib/teams";
import { identity, workspaceAgents } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../../lib/session.server";
import { UserCard } from "../../../components/user-card";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const children = new URL(request.url).searchParams.get("children") === "1";
  const [members, team, added, listed] = await Promise.all([
    identity.teamMembers(viewer, params.owner, params.team, children).then(unwrap),
    identity.getTeam(viewer, params.owner, params.team).then(unwrap),
    identity.teamAgents(viewer, params.owner, params.team).catch(() => null),
    workspaceAgents.list(params.owner, viewer!).catch(() => null),
  ]);
  const all = listed?.ok ? listed.value.map(peopleAgent) : [];
  const ids = added?.ok ? added.value.map((agent) => agent.agent_id) : [];
  const onTeam = agentsOn({ slug: team.slug, agent_ids: ids }, all);
  // What the team's first agent is told about it, word for word: every agent on it is told the same about this team.
  const first = onTeam.find((agent) => !agent.builtin);
  const told = first ? await workspaceAgents.teamContext(params.owner, first.handle, viewer!).catch(() => null) : null;
  return {
    members,
    children,
    me: viewer?.username ?? null,
    // The workspace's agents not on the team yet, for adding one.
    addable: all.filter((agent) => !agent.builtin && !onTeam.some((on) => on.id === agent.id)).map(({ id, display_name, title, role }) => ({ id, display_name, title, role })),
    told: first && told?.ok ? { agent: first, text: teamBlock(told.value.text, team.name) } : null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "add-agent" || intent === "remove-agent") {
    const agentId = String(form.get("agent_id") ?? "");
    // Identity knows agents only by id: check it is one of this workspace's.
    const listed = await workspaceAgents.list(params.owner, user).catch(() => null);
    const agent = listed?.ok ? listed.value.find((a) => a.id === agentId) : null;
    if (!agent) return { intent, username: agentId, error: "Choose one of the workspace's agents." };
    const done =
      intent === "add-agent"
        ? await identity.setTeamAgent(user, params.owner, params.team, agent.id)
        : await identity.removeTeamAgent(user, params.owner, params.team, agent.id);
    return done.ok ? { intent, username: agentId, error: null } : { intent, username: agentId, error: done.error.message };
  }
  const username = String(form.get("username") ?? "").trim().replace(/^@/, "");
  if (!username) return { intent, username, error: "Enter a username." };
  if (intent === "remove") {
    const removed = await identity.removeTeamMember(user, params.owner, params.team, username);
    return removed.ok ? { intent, username, error: null } : { intent, username, error: removed.error.message };
  }
  const role: TeamRole = form.get("role") === "maintainer" ? "maintainer" : "member";
  const set = await identity.setTeamMember(user, params.owner, params.team, username, role);
  return set.ok ? { intent, username, error: null } : { intent, username, error: set.error.message };
}

export default function TeamMembers({ loaderData, actionData }: Route.ComponentProps) {
  const team = useTeam();
  const { agents, added } = useTeamAgents();
  const { members, children, me, addable, told } = loaderData;
  const [, setParams] = useSearchParams();
  const manage = team.can_manage;
  const rowError = (username: string) =>
    actionData && actionData.intent !== "add" && actionData.intent !== "add-agent" && actionData.username === username ? actionData.error : null;

  return (
    <div className="max-w-3xl space-y-10">
      <section aria-labelledby="team-people" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="team-people" className="flex items-center gap-2 font-medium">
            <Users size={15} className="text-faint" />
            People <span className="text-sm font-normal text-faint tabular-nums">{team.members_count}</span>
          </h2>
          {team.child_teams_count > 0 && (
            <label className="flex items-center gap-2.5 text-sm text-muted">
              <Switch
                size="sm"
                checked={children}
                onCheckedChange={(on) => setParams(on ? { children: "1" } : {}, { replace: true, preventScrollReset: true })}
              />
              Include the people of child teams
            </label>
          )}
        </div>

        {members.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-6 py-6 text-center text-sm text-muted">
            {agents.length ? `No people on ${team.name}: it's agents only.` : `No one is in ${team.name} yet.`}
            {manage && " Add members of the workspace below."}
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {members.map((member) => {
              const self = member.username === me;
              return (
                <li key={member.username} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <WithPresence person={{ username: member.username }} size={28}>
                      <Avatar name={member.username} image={member.avatar} size={28} />
                    </WithPresence>
                    <div className="min-w-0 grow basis-32 truncate">
                      <UserCard username={member.username}>
                        <Link to={personPath(team.workspace, member.username)} className="text-sm font-medium hover:text-accent">
                          {member.name || member.username}
                        </Link>
                      </UserCard>
                      {member.name && <span className="ml-2 hidden font-mono text-xs text-faint sm:inline">{member.username}</span>}
                    </div>
                    {leads(team.lead, { username: member.username }) && <Badge tone="accent">Lead</Badge>}
                    {member.via ? (
                      <Link to={teamPath(team.workspace, member.via)}>
                        <Badge>via {member.via}</Badge>
                      </Link>
                    ) : member.role === "maintainer" ? (
                      <Badge tone="accent">Maintainer</Badge>
                    ) : (
                      <Badge>Member</Badge>
                    )}
                    {!member.via && (manage || self) && (
                      <span className="flex items-center gap-1">
                        {manage && (
                          <Form method="post">
                            <input type="hidden" name="intent" value="role" />
                            <input type="hidden" name="username" value={member.username} />
                            <input type="hidden" name="role" value={member.role === "maintainer" ? "member" : "maintainer"} />
                            <SubmitButton variant="quiet" match={{ intent: "role", username: member.username }} pending="Saving…">
                              {member.role === "maintainer" ? "Make member" : "Make maintainer"}
                            </SubmitButton>
                          </Form>
                        )}
                        <Form method="post">
                          <input type="hidden" name="intent" value="remove" />
                          <input type="hidden" name="username" value={member.username} />
                          <SubmitButton variant="quiet" match={{ intent: "remove", username: member.username }} pending="Removing…">
                            {self ? "Leave" : "Remove"}
                          </SubmitButton>
                        </Form>
                      </span>
                    )}
                  </div>
                  <ErrorText>{rowError(member.username)}</ErrorText>
                </li>
              );
            })}
          </ul>
        )}

        {manage && (
          <Form method="post" key={members.length} className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <input type="hidden" name="intent" value="add" />
            <div className="grow">
              <Field label="Add a person" hint={`A member of ${team.workspace}, by username. Maintainers manage the team's people, agents and settings.`}>
                <Input name="username" required maxLength={39} placeholder="username" />
              </Field>
            </div>
            <CheckboxOption name="role" value="maintainer" label="Maintainer" className="sm:pt-[2.1rem]" />
            <div className="sm:pt-[1.625rem]">
              <SubmitButton match={{ intent: "add" }} pending="Adding…">
                Add
              </SubmitButton>
            </div>
          </Form>
        )}
        {actionData?.intent === "add" && <ErrorText>{actionData.error}</ErrorText>}
      </section>

      <section aria-labelledby="team-agents" className="space-y-4">
        <h2 id="team-agents" className="flex items-center gap-2 font-medium">
          <Bot size={15} className="text-faint" />
          Agents <span className="text-sm font-normal text-faint tabular-nums">{agents.length}</span>
        </h2>
        {agents.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-6 py-6 text-center text-sm text-muted">
            No agents on {team.name}: it's people only.{manage && addable.length > 0 && " Add one below."}
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {agents.map((agent) => {
              const home = !added.includes(agent.id);
              return (
                <li key={agent.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <AgentPersonFace agent={agent} size={28} />
                    <div className="min-w-0 grow basis-32 truncate text-sm">
                      <AgentLink workspace={team.workspace} agent={agent} className="font-medium" />
                      <span className="ml-2 text-muted">{agent.title || agent.role}</span>
                    </div>
                    {leads(team.lead, { id: agent.id }) && <Badge tone="accent">Lead</Badge>}
                    {home ? (
                      <Badge>Home team</Badge>
                    ) : (
                      manage && (
                        <Form method="post">
                          <input type="hidden" name="intent" value="remove-agent" />
                          <input type="hidden" name="agent_id" value={agent.id} />
                          <SubmitButton variant="quiet" match={{ intent: "remove-agent", agent_id: agent.id }} pending="Removing…">
                            Remove
                          </SubmitButton>
                        </Form>
                      )
                    )}
                  </div>
                  <ErrorText>{rowError(agent.id)}</ErrorText>
                </li>
              );
            })}
          </ul>
        )}
        {manage && addable.length > 0 && (
          <Form method="post" key={`agents:${agents.length}`} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <input type="hidden" name="intent" value="add-agent" />
            <label className="block grow">
              <span className="mb-1.5 block text-sm font-medium text-muted">Add an agent</span>
              <SelectField
                name="agent_id"
                defaultValue={addable[0]!.id}
                className="w-full"
                options={addable.map((agent) => ({ value: agent.id, label: `${agent.display_name} · ${agent.title || agent.role}` }))}
              />
            </label>
            <SubmitButton match={{ intent: "add-agent" }} pending="Adding…">
              Add
            </SubmitButton>
          </Form>
        )}
        {actionData?.intent === "add-agent" && <ErrorText>{actionData.error}</ErrorText>}
      </section>

      {told && (
        <section aria-labelledby="team-told" className="rounded-xl border border-accent/40 bg-surface p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="team-told" className="flex items-center gap-2 text-sm font-medium">
              <Sparkles size={14} className="text-accent" />
              What the agents on {team.name} know about it
            </h2>
            <span className="text-xs text-faint">As {told.agent.display_name} is told it every turn, from this page and who's around now</span>
          </div>
          {told.text ? (
            <ToldText text={told.text} />
          ) : (
            <p className="text-sm text-faint">{team.visibility === "secret" ? "Agents aren't told about secret teams." : "It couldn't be read just now."}</p>
          )}
        </section>
      )}
    </div>
  );
}
