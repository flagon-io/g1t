import { Outlet, data, type ShouldRevalidateFunctionArgs, useMatch, useRouteLoaderData } from "react-router";

import { type WorkspaceAgent, hasCodeAccess } from "@g1t/contracts";

import { AgentsSidebar } from "../../../components/agents-mode";

import type { Route } from "./+types/layout";
import { workspaceAgents } from "../../../lib/services.server";
import { getViewer, roleIn } from "../../../lib/session.server";

/** Agents mode: the workspace's agents, for its sidebar; null when the agents service does not answer. */
export type AgentsLayoutData = { slug: string; agents: WorkspaceAgent[] | null };

export async function loader({ params, context }: Route.LoaderArgs): Promise<AgentsLayoutData> {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const listed = await workspaceAgents.list(params.owner.toLowerCase(), viewer!).catch(() => null);
  return {
    slug: params.owner.toLowerCase(),
    agents: listed?.ok ? listed.value.filter((agent) => !agent.archived_at).sort((a, b) => a.display_name.localeCompare(b.display_name)) : null,
  };
}

/** The list changes when an agent is made or changed, not when moving between them. */
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
