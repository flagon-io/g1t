import { Outlet, data, type ShouldRevalidateFunctionArgs, useMatch, useRouteLoaderData } from "react-router";

import { type WorkspaceAgent, hasCodeAccess } from "@g1t/contracts";

import { AgentsSidebar } from "../../../components/agents-mode";

import type { Route } from "./+types/layout";
import { type AgentTeamRef, teamsByAgent } from "../../../lib/people";
import { identity, workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

/**
 * Agents mode: the workspace's agents, for its sidebar, and how many live
 * sessions each has (by agent id); null when the agents service does not answer.
 */
export type AgentsLayoutData = {
  slug: string;
  agents: WorkspaceAgent[] | null;
  live: Record<string, number>;
  /** The viewer's id, to tell their own personal agents from members' (which owners see). */
  viewer_id: string;
  /** Whether the viewer may create an agent: owners always, members unless owners turned personal agents off. */
  may_create: boolean;
  /** The visible teams each agent is on, by agent id (team memberships); null when they couldn't be read. */
  teams: Record<string, AgentTeamRef[]> | null;
};

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<AgentsLayoutData> {
  // Signed out, sign in first (as Chat and Docs do), rather than a 404.
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const owner = roleIn(viewer, slug) === "owner";
  const [listed, live, policy, index] = await Promise.all([
    // Personal agents too: the viewer's own, and every member's for an owner.
    workspaceAgents.list(slug, viewer!, { personal: "all" }).catch(() => null),
    // Every live session counts, private ones too: a count says nothing about what it is.
    workspaceAgents.sessions(slug, viewer!, { status: "live", limit: 200 }).catch(() => null),
    owner ? Promise.resolve(null) : workspaceAgents.policy(slug, viewer!).catch(() => null),
    identity.teamAgentIndex(slug).catch(() => null),
  ]);
  const counts: Record<string, number> = {};
  for (const session of live?.ok ? live.value : []) counts[session.agent_id] = (counts[session.agent_id] ?? 0) + 1;
  return {
    slug,
    viewer_id: viewer.id,
    may_create: owner || (policy?.ok ? policy.value.members_create_agents : true),
    live: counts,
    teams: index ? teamsByAgent(index) : null,
    agents: listed?.ok ? listed.value.filter((agent) => !agent.archived_at).sort((a, b) => a.display_name.localeCompare(b.display_name)) : null,
  };
}

/** The list changes when an agent is made or changed, or work is stopped or started; not when moving between them. */
export function shouldRevalidate({ currentParams, nextParams, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  return currentParams.owner !== nextParams.owner;
}

export default function AgentsLayout({ loaderData }: Route.ComponentProps) {
  const root = useRouteLoaderData("root") as { user?: { workspaces?: { slug: string; role: string; code_access?: boolean }[] } | null } | undefined;
  const membership = root?.user?.workspaces?.find((m) => m.slug === loaderData.slug) ?? null;
  // A phone: the agents first, as a list; the fleet's numbers under it.
  const index = useMatch("/:owner/-/agents");
  return (
    <>
      {index && (
        <div className="-mx-4 -mt-6 mb-8 md:hidden">
          <AgentsSidebar slug={loaderData.slug} shellAgents={null} code={hasCodeAccess(membership)} owner={membership?.role === "owner"} phone />
        </div>
      )}
      <Outlet />
    </>
  );
}
