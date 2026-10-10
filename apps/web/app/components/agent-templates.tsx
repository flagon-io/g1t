/**
 * Agent templates' pieces (routes/workspace/agents/templates.tsx): a
 * template as a card, and what the viewer can do with it. Owners start an
 * agent from one; everyone else can read what each brings.
 */
import { Plus } from "lucide-react";
import { Link } from "react-router";

import { PixelCreature } from "./agent-avatar";
import { Hint } from "./ui/hint";
import { type TemplateListing, startPath, templatePath } from "../lib/agent-templates";
import { cn } from "../lib/cn";

const SMALL = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[0.8125rem] font-medium transition-colors";
const PRIMARY = `${SMALL} bg-fg text-bg hover:bg-fg-hover`;
const QUIET = `${SMALL} border border-line text-fg/85 hover:border-line-strong hover:bg-raised hover:text-fg`;

/** Starting an agent from a template: the new-agent form with it chosen, for owners; a word on who can, for everyone else. */
export function StartAction({ listing, slug, owner, className }: { listing: TemplateListing; slug: string; owner: boolean; className?: string }) {
  if (!owner) {
    return (
      <Hint label="Owners start new agents. Ask one in chat if you want an agent like this.">
        <span tabIndex={0} className={cn(SMALL, "border border-line text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent", className)}>
          Owners start agents
        </span>
      </Hint>
    );
  }
  return (
    <Link to={startPath(slug, listing.template.id)} className={cn(listing.agents.length > 0 ? QUIET : PRIMARY, className)}>
      <Plus size={14} />
      {listing.agents.length > 0 ? "Start another" : "Start from this"}
    </Link>
  );
}

/** A template as a card: the face it suggests, its name and title, what it does, and which agents started from it. */
export function TemplateCard({ listing, slug, owner }: { listing: TemplateListing; slug: string; owner: boolean }) {
  const { template, agents } = listing;
  return (
    <article className="relative flex flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
      <div className="flex items-start gap-3">
        <PixelCreature seed={template.handle} size={44} />
        <div className="min-w-0 grow">
          <h3 className="truncate text-sm font-semibold">
            <Link to={templatePath(slug, template.id)} prefetch="intent" className="outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-accent">
              {template.title}
            </Link>
          </h3>
          <p className="truncate text-xs text-muted">
            {template.department ? `${template.department} · ` : ""}Suggests {template.display_name}
          </p>
        </div>
      </div>
      <ul className="mt-3 grow space-y-1">
        {template.responsibilities.slice(0, 3).map((duty) => (
          <li key={duty} className="flex gap-2 text-[0.8125rem] leading-snug text-muted">
            <span className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-line-strong" aria-hidden="true" />
            <span className="line-clamp-1">{duty}</span>
          </li>
        ))}
      </ul>
      <div className="relative mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
        <span className="min-w-0 truncate text-xs text-faint">
          {agents.length === 0 ? "No agent started from it" : agents.length === 1 ? `@${agents[0]!.handle} started from it` : `${agents.length} agents started from it`}
        </span>
        {/* A member reads on; who may start one is said on the template's page. */}
        {owner && <StartAction listing={listing} slug={slug} owner={owner} />}
      </div>
    </article>
  );
}
