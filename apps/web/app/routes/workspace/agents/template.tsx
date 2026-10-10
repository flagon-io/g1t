/**
 * One agent template: what an agent started from it is responsible for,
 * the helpers it works with, how it talks, which models it runs on, the
 * instructions it starts from, what you configure when you start one, and
 * the agents in the workspace that started from it.
 */
import { ArrowLeft } from "lucide-react";
import { Link, data } from "react-router";

import type { Route } from "./+types/template";
import { PixelCreature } from "../../../components/agent-avatar";
import { StartAction } from "../../../components/agent-templates";
import { PRESETS } from "../../../lib/agent-form";
import { routingWords, templateListings, templatesPath } from "../../../lib/agent-templates";
import { loadTemplates } from "../../../lib/agent-templates.server";
import { page } from "../../../lib/meta";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  const template = args.loaderData?.templates?.find((t) => t.id === params.template);
  return page(args, { title: `${template ? template.title : "Template"} · Agent templates · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  const loaded = await loadTemplates(slug, viewer);
  if (loaded.templates && !loaded.templates.some((t) => t.id === params.template)) throw data(null, { status: 404 });
  return { slug, owner: role === "owner", ...loaded };
}

export default function AgentTemplate({ loaderData, params }: Route.ComponentProps) {
  const { slug, owner } = loaderData;
  const listing = templateListings(loaderData.templates ?? [], loaderData.agents).find((l) => l.template.id === params.template);
  const back = (
    <Link to={templatesPath(slug)} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft size={14} />
      All templates
    </Link>
  );
  if (!listing) {
    return (
      <div>
        {back}
        <p className="mt-6 text-sm text-muted">Templates can't be shown right now: the agents service didn't answer. Reload in a minute.</p>
      </div>
    );
  }
  const { template, agents } = listing;
  const voice = PRESETS.find((preset) => preset.value === template.personality_preset);
  const names = [template.display_name, ...template.name_ideas.filter((name) => name !== template.display_name)];
  return (
    <div className="pb-4">
      {back}
      <header className="mt-5 flex flex-wrap items-center gap-4">
        <PixelCreature seed={template.handle} size={64} />
        <div className="min-w-0 grow basis-60">
          <h1 className="text-2xl font-semibold tracking-tight">{template.title}</h1>
          <p className="mt-0.5 text-sm text-muted">{template.department ? `${template.department} · ` : ""}A template from g1t</p>
        </div>
        <StartAction listing={listing} slug={slug} owner={owner} className="h-9 px-4 text-sm" />
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-8">
          <section aria-labelledby="duties">
            <h2 id="duties" className="text-sm font-semibold">
              What it's responsible for
            </h2>
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
              <h2 id="helpers" className="text-sm font-semibold">
                Helpers it works with
              </h2>
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
            <h2 id="instructions" className="text-sm font-semibold">
              The instructions it starts from
            </h2>
            <p className="mt-1 text-sm text-muted">Yours to edit when you start the agent, and on its profile after.</p>
            <pre className="mt-3 max-h-96 overflow-auto rounded-xl border border-line bg-surface p-4 font-sans text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-fg-soft">{template.instructions}</pre>
          </section>
        </div>

        <aside className="space-y-6 text-sm">
          <section aria-labelledby="configure" className="rounded-xl border border-line bg-surface p-4">
            <h2 id="configure" className="text-xs text-faint">
              What you configure
            </h2>
            <dl className="mt-3 space-y-4">
              <div>
                <dt className="text-xs text-faint">Name</dt>
                <dd className="mt-0.5">{names.slice(0, 4).join(", ")}, or your own</dd>
              </div>
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
              <div>
                <dt className="text-xs text-faint">Team and access</dt>
                <dd className="mt-0.5">A team you pick. It works with the access of the person asking, never more.</dd>
              </div>
            </dl>
          </section>
          <section aria-labelledby="here" className="rounded-xl border border-line bg-surface p-4">
            <h2 id="here" className="text-xs text-faint">
              In this workspace
            </h2>
            {agents.length === 0 ? (
              <p className="mt-1 text-muted">No agent has started from it yet.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {agents.map((agent) => (
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
