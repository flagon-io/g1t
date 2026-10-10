/**
 * What the agent template pages read: the templates and the workspace's
 * agents, to say which started from each. Each part that does not answer
 * comes back null, and the page says so.
 */
import type { AgentTemplate, User } from "@g1t/contracts";

import type { StartedAgent } from "./agent-templates";
import { workspaceAgents } from "./services.server";

export async function loadTemplates(
  slug: string,
  viewer: User,
): Promise<{ templates: AgentTemplate[] | null; agents: StartedAgent[] | null; members_create_agents: boolean }> {
  const [templates, agents, policy] = await Promise.all([
    workspaceAgents.templates().catch(() => null),
    workspaceAgents
      .list(slug, viewer)
      .then((result) => (result.ok ? result.value.map(({ id, handle, display_name, template, archived_at }) => ({ id, handle, display_name, template, archived_at })) : null))
      .catch(() => null),
    workspaceAgents.policy(slug, viewer).catch(() => null),
  ]);
  return { templates, agents, members_create_agents: policy?.ok ? policy.value.members_create_agents : true };
}
