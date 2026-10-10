/**
 * One role in the agent catalog: what an agent hired into it is
 * responsible for, the helpers it works with, how it talks, which models
 * it runs on, the instructions it starts from, and who in the workspace
 * already has the job.
 */
import { ArrowLeft } from "lucide-react";
import { Link, data } from "react-router";

import type { Route } from "./+types/agent";
import { PixelCreature } from "../../../components/agent-avatar";
import { AgentAction, TierBadge } from "../../../components/marketplace";
import { PRESETS } from "../../../lib/agent-form";
import { agentListings, marketplacePath, roleLine, routingWords } from "../../../lib/marketplace";
import { loadCatalog } from "../../../lib/marketplace.server";
import { page } from "../../../lib/meta";
import { requireUser, roleIn } from "../../../lib/session.server";
import { useMarketplace } from "./layout";

export function meta({ params, ...args }: Route.MetaArgs) {
  const template = args.loaderData?.templates?.find((t) => t.id === params.template);
  return page(args, { title: `${template ? template.title : "Agent"} · Marketplace · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const catalog = await loadCatalog(slug, viewer);
  if (catalog.templates && !catalog.templates.some((t) => t.id === params.template)) throw data(null, { status: 404 });
  return catalog;
}

export default function CatalogAgent({ loaderData, params }: Route.ComponentProps) {
  const { slug, owner, username, requests } = useMarketplace();
  const listing = agentListings(loaderData.templates ?? [], loaderData.agents, requests?.requests ?? [], username).find((l) => l.template.id === params.template);
  const back = (
    <Link to={marketplacePath(slug, "agents")} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft size={14} />
      All roles
    </Link>
  );
  if (!listing) {
    return (
      <div>
        {back}
        <p className="mt-6 text-sm text-muted">The agent catalog can't be shown right now: the agents service didn't answer. Reload in a minute.</p>
      </div>
    );
  }
  const { template, hired } = listing;
  const voice = PRESETS.find((preset) => preset.value === template.personality_preset);
  const others = template.name_ideas.filter((name) => name !== template.display_name);
  return (
    <div>
      {back}
      <header className="mt-5 flex flex-wrap items-center gap-4">
        <PixelCreature seed={template.handle} size={64} />
        <div className="min-w-0 grow basis-60">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {template.display_name}
            <TierBadge tier="official" />
          </h2>
          <p className="mt-0.5 text-sm text-muted">{roleLine(template)}</p>
        </div>
        <AgentAction listing={listing} slug={slug} owner={owner} className="h-9 px-4 text-sm" />
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-8">
          <section aria-labelledby="duties">
            <h3 id="duties" className="text-sm font-semibold">
              What it's responsible for
            </h3>
            <ul className="mt-3 space-y-2">
              {template.responsibilities.map((duty) => (
                <li key={duty} className="flex gap-2.5 text-sm text-fg-soft">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                  {duty}
                </li>
              ))}
            </ul>
          </section>

          {template.subagents.length > 0 && (
            <section aria-labelledby="helpers">
              <h3 id="helpers" className="text-sm font-semibold">
                Helpers it works with
              </h3>
              <p className="mt-1 text-sm text-muted">Smaller agents it starts for one piece of its work, paid from its own budget.</p>
              <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {template.subagents.map((helper) => (
                  <li key={helper.name} className="px-4 py-3">
                    <p className="font-mono text-[0.8125rem]">{helper.name}</p>
                    <p className="mt-0.5 text-sm text-muted">{helper.description}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="instructions">
            <h3 id="instructions" className="text-sm font-semibold">
              The instructions it starts from
            </h3>
            <p className="mt-1 text-sm text-muted">Yours to change once it is added, on its profile.</p>
            <pre className="mt-3 max-h-96 overflow-auto rounded-xl border border-line bg-surface p-4 font-sans text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-fg-soft">{template.instructions}</pre>
          </section>
        </div>

        <aside className="space-y-6 text-sm">
          <dl className="space-y-4 rounded-xl border border-line bg-surface p-4">
            <div>
              <dt className="text-xs text-faint">Voice</dt>
              <dd className="mt-0.5">{voice ? voice.label : template.personality_preset}</dd>
              {voice && <dd className="text-xs text-muted">{voice.about}</dd>}
            </div>
            <div>
              <dt className="text-xs text-faint">Models</dt>
              <dd className="mt-0.5">{routingWords(template.routing)}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Budget</dt>
              <dd className="mt-0.5">The workspace's default for a new agent, billed at what it costs</dd>
            </div>
            {others.length > 0 && (
              <div>
                <dt className="text-xs text-faint">Other names it suits</dt>
                <dd className="mt-0.5 text-muted">{others.slice(0, 5).join(", ")}</dd>
              </div>
            )}
          </dl>
          <section aria-labelledby="here" className="rounded-xl border border-line bg-surface p-4">
            <h3 id="here" className="text-xs text-faint">
              In this workspace
            </h3>
            {hired.length === 0 ? (
              <p className="mt-1 text-muted">Nobody has this job yet.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {hired.map((agent) => (
                  <li key={agent.id} className="flex items-center gap-2">
                    <PixelCreature seed={agent.handle} size={20} />
                    <Link to={`/${slug}/-/agents/${agent.handle}`} className="truncate hover:underline">
                      {agent.display_name} <span className="text-faint">@{agent.handle}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
