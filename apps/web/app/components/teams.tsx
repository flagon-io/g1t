/**
 * Pieces of the teams pages: a team in a list, and its badges.
 */
import { EyeOff, UsersRound } from "lucide-react";
import { Link, useOutletContext } from "react-router";

import { type Team, teamHandle } from "@g1t/contracts";

import { teamCounts, teamPath } from "../lib/teams";
import { Badge } from "./ui/badge";

/** What each page of a team gets from the team's layout. */
export type TeamContext = { team: Team };

/** The team whose page this is. */
export function useTeam(): Team {
  return useOutletContext<TeamContext>().team;
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
export function TeamRow({ team, children }: { team: Team; children?: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3 transition-colors hover:bg-surface/60 sm:flex-nowrap">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-raised text-muted ring-1 ring-line">
        <UsersRound size={14} />
      </span>
      <div className="min-w-0 grow basis-48">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to={teamPath(team.workspace, team.slug)} prefetch="intent" className="font-medium hover:underline">
            {team.name}
          </Link>
          <span className="font-mono text-xs text-faint">{teamHandle(team)}</span>
          <TeamBadges team={team} />
        </div>
        {team.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted">{team.description}</p>}
        <p className="mt-1 text-xs text-faint">
          {teamCounts(team)}
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
