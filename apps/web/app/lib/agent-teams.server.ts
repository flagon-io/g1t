/**
 * An agent's teams on its profiles: the teams it is on and the ones the
 * viewer may add it to, and adding or taking it off one. An agent is on
 * teams the way a person is, through team membership in identity, so this
 * is the team's own add and remove, from the agent's side.
 */
import type { PeopleDirectory, Team, User } from "@g1t/contracts";

import type { AgentTeams, TeamChange } from "./people";
import { identity, workspaceAgents } from "./services.server";

/** The teams `agentId` is on and the teams the viewer may add it to; null when identity didn't answer. */
export async function agentTeamsFor(viewer: User, slug: string, agentId: string, directory?: PeopleDirectory | null): Promise<AgentTeams | null> {
  const [listed, people] = await Promise.all([
    identity.listTeams(viewer, slug).catch(() => null),
    directory ? Promise.resolve(directory) : identity.peopleDirectory(viewer, slug).then((found) => (found.ok ? found.value : null), () => null),
  ]);
  if (!listed?.ok || !people) return null;
  const manage = new Map<string, Team>(listed.value.map((team) => [team.slug, team]));
  const on = people.teams
    .filter((team) => team.agent_ids.includes(agentId))
    .map((team) => ({
      slug: team.slug,
      name: team.name,
      people: team.people.length,
      agents: new Set(team.agent_ids).size,
      lead: team.lead?.kind === "agent" && team.lead.agent_id === agentId,
      can_manage: manage.get(team.slug)?.can_manage ?? false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const addable = listed.value
    .filter((team) => team.can_manage && !on.some((row) => row.slug === team.slug))
    .map((team) => ({ slug: team.slug, name: team.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { on, addable };
}

/**
 * `join-team` or `leave-team` from an agent's profile: the agent must be
 * one of the workspace's (identity knows agents only by id), and a
 * personal agent joins no team. Null for any other intent.
 */
export async function changeAgentTeam(form: FormData, viewer: User, slug: string, handle: string): Promise<TeamChange | null> {
  const intent = String(form.get("intent") ?? "");
  if (intent !== "join-team" && intent !== "leave-team") return null;
  const team = String(form.get("team") ?? "").trim().toLowerCase();
  if (!team) return { intent, team, error: "Choose a team." };
  const found = await workspaceAgents.get(slug, handle, viewer).catch(() => null);
  if (!found?.ok) return { intent, team, error: "That agent couldn't be found." };
  if (intent === "join-team" && found.value.scope === "personal") return { intent, team, error: "A personal agent is on no team." };
  const done =
    intent === "join-team"
      ? await identity.setTeamAgent(viewer, slug, team, found.value.id).catch(() => null)
      : await identity.removeTeamAgent(viewer, slug, team, found.value.id).catch(() => null);
  if (!done) return { intent, team, error: "Teams didn't answer. Try again in a moment." };
  return done.ok ? { intent, team, error: null } : { intent, team, error: done.error.message };
}
