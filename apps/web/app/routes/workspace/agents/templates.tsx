/**
 * Agent templates: the starting points g1t provides for a new agent, by
 * department, with the agents in the workspace that started from each. A
 * template isn't installed: an owner starts an agent from one and
 * configures it, and the agent is the workspace's own from then on.
 */
import { ArrowLeft, Plus } from "lucide-react";
import { Link, data } from "react-router";

import type { Route } from "./+types/templates";
import { TemplateCard } from "../../../components/agent-templates";
import { EmptyState } from "../../../components/ui";
import { byDepartment, startPath, templateListings } from "../../../lib/agent-templates";
import { loadTemplates } from "../../../lib/agent-templates.server";
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
  return { slug, owner: role === "owner", ...(await loadTemplates(slug, viewer)) };
}

export default function AgentTemplates({ loaderData }: Route.ComponentProps) {
  const { slug, owner, templates, agents } = loaderData;
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
          {/* One grid in department order: most departments have a single template. */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {byDepartment(listings)
              .flatMap(([, list]) => list)
              .map((listing) => (
                <TemplateCard key={listing.template.id} listing={listing} slug={slug} owner={owner} />
              ))}
          </div>
          {owner && (
            <section aria-label="Your own">
              <h2 className="mb-3 text-xs font-semibold tracking-wide text-faint uppercase">Your own</h2>
              <Link
                to={startPath(slug, "blank")}
                className="flex max-w-md items-center gap-3 rounded-xl border border-dashed border-line-strong p-4 text-sm transition-colors hover:border-fg/40 hover:bg-raised/40"
              >
                <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
                  <Plus size={18} />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">Start from nothing</span>
                  <span className="block text-xs text-muted">Give it a name, a title, a team and what it is responsible for.</span>
                </span>
              </Link>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
