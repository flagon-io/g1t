/**
 * Agent templates: the roles g1t provides to start a new agent from, by
 * title, with the agents in the workspace that started from each; and the
 * subagents the plugins the workspace installed bring, hireable the same
 * way. A template isn't installed: an owner starts an agent from one (a
 * member, a personal agent) and configures it, and the agent is its own
 * from then on.
 */
import { ArrowLeft, Bot, Plus, UserPlus } from "lucide-react";
import { Link, data } from "react-router";

import type { PluginAgentTemplate } from "@g1t/contracts";
import { customizePath } from "@g1t/contracts/customize";

import type { Route } from "./+types/templates";
import { TemplateCard } from "../../../components/agent-templates";
import { readOrNull } from "../../../components/agents/actions.server";
import { ButtonLink, EmptyState } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { Card } from "../../../components/ui/card";
import { templateListings } from "../../../lib/agent-templates";
import { loadTemplates } from "../../../lib/agent-templates.server";
import { pluginPath } from "../../../lib/customize";
import { workspaceAgents } from "../../../lib/services.server";
import { page } from "../../../lib/meta";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Agent templates · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  const [loaded, fromPlugins] = await Promise.all([loadTemplates(slug, viewer), readOrNull(workspaceAgents.pluginAgents(slug, viewer))]);
  // Owners start agents; members start personal ones, unless owners turned that off.
  return { slug, owner: role === "owner" || loaded.members_create_agents, fromPlugins, ...loaded };
}

export default function AgentTemplates({ loaderData }: Route.ComponentProps) {
  const { slug, owner, templates, agents, fromPlugins } = loaderData;
  const listings = templateListings(templates ?? [], agents);
  return (
    <div className="pb-4">
      <Link to={`/${slug}/-/agents`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Agents
      </Link>
      <header className="mt-4 mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 grow basis-lg">
          <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            Starting points for a new agent, each a role with responsibilities, helpers, a voice, model limits and instructions. Start an agent from one and make it yours: its name, instructions, voice, models and budget are all
            yours to change, then and later. A template is never updated under an agent started from it.
          </p>
        </div>
        {owner && (
          <Link to={`/${slug}/-/agents/new`} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-fg px-4 text-sm font-medium text-bg hover:bg-fg-hover">
            <Plus size={15} />
            New agent
          </Link>
        )}
      </header>
      {templates == null ? (
        <EmptyState title="Templates can't be shown right now">The agents service didn't answer. Reload in a minute.</EmptyState>
      ) : (
        <div className="space-y-10">
          {/* One grid, in the order g1t lists the roles: a template names a role, never a team. */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {listings.map((listing) => (
              <TemplateCard key={listing.template.id} listing={listing} slug={slug} owner={owner} />
            ))}
          </div>
          <section aria-labelledby="from-plugins">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="from-plugins" className="text-xs font-semibold tracking-wide text-faint uppercase">
                From plugins {fromPlugins && fromPlugins.length > 0 && <span className="font-normal">{fromPlugins.length}</span>}
              </h2>
              <Link to={`${customizePath("plugins", slug)}?view=discover`} className="text-xs text-muted hover:text-fg">
                Find plugins in Customize
              </Link>
            </div>
            {fromPlugins == null ? (
              <EmptyState title="Plugin agents can't be shown right now">The agents service didn't answer. Reload in a minute.</EmptyState>
            ) : fromPlugins.length === 0 ? (
              <Card asChild tone="plain" className="border-dashed px-4 py-6 text-center text-sm text-muted">
                <p>Subagents the plugins you install bring show here, to hire as a starting point like any role.</p>
              </Card>
            ) : (
              <Card asChild divided className="overflow-hidden">
                <ul>
                  {fromPlugins.map((agent) => (
                    <PluginAgentRow key={agent.ref} agent={agent} slug={slug} owner={owner} />
                  ))}
                </ul>
              </Card>
            )}
          </section>
          {owner && (
            <section aria-label="Your own">
              <h2 className="mb-3 text-xs font-semibold tracking-wide text-faint uppercase">Your own</h2>
              <Link
                to={`/${slug}/-/agents/new`}
                className="flex max-w-md items-center gap-3 rounded-xl border border-dashed border-line-strong p-4 text-sm transition-colors hover:border-fg/40 hover:bg-raised/40"
              >
                <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
                  <Plus size={18} />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">Describe it</span>
                  <span className="block text-xs text-muted">Say what it should do, and g1t drafts the rest for you to change and try.</span>
                </span>
              </Link>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** A subagent an installed plugin brings: its name, what it does, the model it names, and Hire, which opens the new-agent form filled from it. */
function PluginAgentRow({ agent, slug, owner }: { agent: PluginAgentTemplate; slug: string; owner: boolean }) {
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5">
      <Bot size={16} className="mt-0.5 shrink-0 text-faint" aria-hidden />
      <div className="min-w-0 grow">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-medium">{agent.name}</span>
          <Link to={pluginPath(slug, `${agent.plugin}@${agent.marketplace}`)} className="inline-flex" prefetch="intent">
            <Badge tone="accent">{agent.plugin}</Badge>
          </Link>
          {agent.model && <Badge>{agent.model}</Badge>}
        </p>
        {agent.description && <p className="mt-0.5 text-sm text-muted">{agent.description}</p>}
      </div>
      {owner && (
        <ButtonLink to={`/${slug}/-/agents/new?plugin=${encodeURIComponent(`${agent.plugin}@${agent.marketplace}`)}&agent=${encodeURIComponent(agent.name)}`} variant="outline" size="sm">
          <UserPlus size={14} />
          Hire
        </ButtonLink>
      )}
    </li>
  );
}
