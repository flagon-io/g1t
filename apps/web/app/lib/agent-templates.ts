/**
 * Agent templates (routes/workspace/agents/templates.tsx): the starting
 * points g1t provides for an agent, each a role with responsibilities,
 * helpers, a voice, model limits and instructions. A template isn't
 * installed: an owner starts a new agent from one and configures it, and
 * the agent is the workspace's own from then on.
 *
 * No Workers or React imports, so it can be tested under Node.
 */
import type { AgentTemplate, WorkspaceAgent } from "@g1t/contracts";

/** Every template, under Agents. */
export function templatesPath(slug: string): string {
  return `/${slug}/-/agents/templates`;
}

/** One template's page. */
export function templatePath(slug: string, template: string): string {
  return `/${slug}/-/agents/templates/${template}`;
}

/** Where an owner starts an agent from a template: the new-agent form, with the template chosen. */
export function startPath(slug: string, template: string): string {
  return `/${slug}/-/agents/new?template=${encodeURIComponent(template)}`;
}

/** An agent as a template's page needs it: who it is and which template it started from. */
export type StartedAgent = Pick<WorkspaceAgent, "id" | "handle" | "display_name" | "template" | "archived_at">;

/** A template, with the workspace's agents that started from it. */
export type TemplateListing = {
  template: AgentTemplate;
  /** Agents started from it, not archived. */
  agents: Pick<WorkspaceAgent, "id" | "handle" | "display_name">[];
};

/**
 * Every template, in the order the agents service gives them, with the
 * agents started from each. `agents` null: the agents service could not
 * say, so none is counted.
 */
export function templateListings(templates: AgentTemplate[], agents: StartedAgent[] | null): TemplateListing[] {
  return templates.map((template) => ({
    template,
    agents: (agents ?? [])
      .filter((agent) => agent.template === template.id && !agent.archived_at)
      .map(({ id, handle, display_name }) => ({ id, handle, display_name })),
  }));
}

/** Listings by department, in the order the templates come, "Other" for none. */
export function byDepartment(listings: TemplateListing[]): [string, TemplateListing[]][] {
  const departments = new Map<string, TemplateListing[]>();
  for (const listing of listings) {
    const key = listing.template.department || "Other";
    departments.set(key, [...(departments.get(key) ?? []), listing]);
  }
  return [...departments];
}

/** "Software Engineer · Engineering": a role as one line. */
export function roleLine(template: Pick<AgentTemplate, "title" | "department">): string {
  return template.department ? `${template.title} · ${template.department}` : template.title;
}

/** How a routing limit reads: "Any model the work needs", "Large models or better", "Up to large models", "Large to frontier models". */
export function routingWords(routing: Pick<AgentTemplate["routing"], "floor" | "ceiling">): string {
  const name = (tier: string) => tier.charAt(0).toUpperCase() + tier.slice(1);
  if (routing.floor && routing.ceiling) return `${name(routing.floor)} to ${routing.ceiling} models`;
  if (routing.floor) return `${name(routing.floor)} models or better`;
  if (routing.ceiling) return `Up to ${routing.ceiling} models`;
  return "Any model the work needs";
}
