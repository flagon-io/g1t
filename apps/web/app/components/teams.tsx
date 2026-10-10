/**
 * Pieces of the teams pages: a team in a list, and its badges.
 */
import { EyeOff, UsersRound } from "lucide-react";
import { Form, Link, useOutletContext } from "react-router";

import { type Team, teamHandle } from "@g1t/contracts";

import type { AgentTeams, PeopleAgent, TeamChange } from "../lib/people";
import { teamCounts, teamPath } from "../lib/teams";
import { ErrorText, SubmitButton } from "./ui";
import { Badge } from "./ui/badge";
import { SelectField } from "./ui/select";
import { TeamKindMark } from "./people";

/**
 * What each page of a team gets from the team's layout: the team and the
 * agents on it, members as its people are.
 */
export type TeamContext = { team: Team; agents: PeopleAgent[] };

/** The team whose page this is. */
export function useTeam(): Team {
  return useOutletContext<TeamContext>().team;
}

/** The agents on the team whose page this is. */
export function useTeamAgents(): { agents: PeopleAgent[] } {
  const { agents } = useOutletContext<TeamContext>();
  return { agents };
}

/** Secret, and the viewer's place in the team. */
export function TeamBadges({ team }: { team: Pick<Team, "visibility" | "viewer_role"> }) {
  return (
    <>
      {team.visibility === "secret" && (
        <Badge>
          <EyeOff size={10} />
          Secret
        </Badge>
      )}
      {team.viewer_role === "maintainer" && <Badge tone="accent">Maintainer</Badge>}
      {team.viewer_role === "member" && <Badge>Member</Badge>}
    </>
  );
}

/** One team in a list: its name, handle, what it is for, and how big it is. */
export function TeamRow({ team, agents, children }: { team: Team; agents?: number; children?: React.ReactNode }) {
  const agentsHere = agents ?? team.agents_count ?? 0;
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3 transition-colors hover:bg-surface/60 sm:flex-nowrap">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-raised text-muted ring-1 ring-line">
        <UsersRound size={14} />
      </span>
      <div className="min-w-0 grow basis-48">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <TeamKindMark people={team.members_count} agents={agentsHere} />
          <Link to={teamPath(team.workspace, team.slug)} prefetch="intent" className="font-medium hover:underline">
            {team.name}
          </Link>
          <span className="font-mono text-xs text-faint">{teamHandle(team)}</span>
          <TeamBadges team={team} />
        </div>
        {team.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted">{team.description}</p>}
        <p className="mt-1 text-xs text-faint">
          {teamCounts(team, agentsHere)}
          {team.parent && (
            <>
              {" · in "}
              <Link to={teamPath(team.workspace, team.parent.slug)} className="hover:text-fg hover:underline">
                {team.parent.name}
              </Link>
            </>
          )}
        </p>
      </div>
      {children}
    </li>
  );
}

/**
 * An agent's teams on its profile, as a person's are: each team it is on,
 * with Remove where the viewer manages the team, and Add to a team. Posts
 * `join-team` and `leave-team` to the page's action (lib/agent-teams.server.ts).
 */
export function AgentTeamsEditor({
  slug,
  name,
  teams,
  personal = false,
  change,
}: {
  slug: string;
  /** The agent's name, for the empty line. */
  name: string;
  /** Null when its teams couldn't be read. */
  teams: AgentTeams | null;
  /** A personal agent is on no team. */
  personal?: boolean;
  /** The last change's answer, for its error. */
  change?: TeamChange | null;
}) {
  if (personal) return <p className="text-sm text-faint">A personal agent is on no team. Once an owner promotes it, add it to teams like anyone.</p>;
  if (!teams) return <p className="text-sm text-faint">Its teams couldn&apos;t be read just now.</p>;
  const error = (team: string) => (change?.team === team && change.intent === "leave-team" ? change.error : null);
  return (
    <div className="space-y-3">
      {teams.on.length ? (
        <ul className="space-y-1 text-sm">
          {teams.on.map((team) => (
            <li key={team.slug}>
              <div className="flex min-h-9 flex-wrap items-center gap-2">
                <TeamKindMark people={team.people} agents={team.agents} />
                <Link to={teamPath(slug, team.slug)} className="min-w-0 truncate font-medium hover:text-accent">
                  {team.name}
                </Link>
                {team.lead && <Badge tone="accent">Lead</Badge>}
                {team.can_manage && (
                  <Form method="post" className="ml-auto">
                    <input type="hidden" name="intent" value="leave-team" />
                    <input type="hidden" name="team" value={team.slug} />
                    <SubmitButton variant="outline" match={{ intent: "leave-team", team: team.slug }} pending="Removing…">
                      Remove
                    </SubmitButton>
                  </Form>
                )}
              </div>
              <ErrorText>{error(team.slug)}</ErrorText>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-faint">{name} isn&apos;t on a team yet.</p>
      )}
      {teams.addable.length > 0 && (
        <Form method="post" key={`teams:${teams.on.length}`} className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input type="hidden" name="intent" value="join-team" />
          <SelectField
            name="team"
            aria-label="Add to a team"
            defaultValue={teams.addable[0]!.slug}
            className="w-full sm:w-56"
            options={teams.addable.map((team) => ({ value: team.slug, label: team.name }))}
          />
          <SubmitButton variant="outline" match={{ intent: "join-team" }} pending="Adding…">
            Add to team
          </SubmitButton>
        </Form>
      )}
      {change?.intent === "join-team" && <ErrorText>{change.error}</ErrorText>}
    </div>
  );
}
