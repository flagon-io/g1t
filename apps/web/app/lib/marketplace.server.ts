/**
 * What the Marketplace's pages read: the agent catalog's roles with the
 * workspace's agents, and what the workspace has connected. Each part that
 * does not answer comes back null, and the page says so.
 */
import type { AgentTemplate, User, WorkspaceAgent } from "@g1t/contracts";

import type { ConnectedState } from "./connectors";
import { connectedStates } from "./connected.server";
import { workspaceAgents } from "./services.server";

/** An agent as the Marketplace needs it: who it is and which role it was hired into. */
export type HiredAgent = Pick<WorkspaceAgent, "id" | "handle" | "display_name" | "template" | "archived_at">;

export async function loadCatalog(slug: string, viewer: User): Promise<{ templates: AgentTemplate[] | null; agents: HiredAgent[] | null }> {
  const [templates, agents] = await Promise.all([
    workspaceAgents.templates().catch(() => null),
    workspaceAgents
      .list(slug, viewer)
      .then((result) => (result.ok ? result.value.map(({ id, handle, display_name, template, archived_at }) => ({ id, handle, display_name, template, archived_at })) : null))
      .catch(() => null),
  ]);
  return { templates, agents };
}

export async function loadConnected(slug: string, viewer: User): Promise<Record<string, ConnectedState>> {
  return connectedStates(slug, viewer);
}
