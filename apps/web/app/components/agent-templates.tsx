/**
 * Agent templates' pieces (routes/workspace/agents/templates.tsx): a
 * template as a card, and what the viewer can do with it. Owners start an
 * agent from one; everyone else can read what each brings.
 */
import { Plus } from "lucide-react";
import { Link } from "react-router";

import { AgentAvatar } from "./agent-avatar";
import { ButtonLink } from "./ui";
import { buttonVariants } from "./ui/button";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";
import { type TemplateListing, startPath, templatePath } from "../lib/agent-templates";
import { cn } from "../lib/cn";


/** Starting an agent from a template: the new-agent form with it chosen, for owners; a word on who can, for everyone else. */
export function StartAction({ listing, slug, owner, className }: { listing: TemplateListing; slug: string; owner: boolean; className?: string }) {
  if (!owner) {
    return (
      <Hint label="This workspace's owners have turned off personal agents. Ask an owner in chat if you want an agent like this.">
        <span tabIndex={0} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "text-muted hover:border-line hover:bg-transparent hover:text-muted", className)}>
          Owners start agents
        </span>
      </Hint>
    );
  }
  return (
    <ButtonLink to={startPath(slug, listing.template.id)} variant={listing.agents.length > 0 ? "outline" : "default"} size="sm" className={className}>
      <Plus size={14} />
      {listing.agents.length > 0 ? "Start another" : "Start from this"}
    </ButtonLink>
  );
}

/** A template as a card: the face it suggests, its name and title, what it does, and which agents started from it. */
export function TemplateCard({ listing, slug, owner }: { listing: TemplateListing; slug: string; owner: boolean }) {
  const { template, agents } = listing;
  return (
    <Card asChild className="relative flex flex-col p-4 transition-colors hover:border-line-strong">
      <article>
        <div className="flex items-start gap-3">
          <AgentAvatar agent={{ handle: template.handle }} size={44} />
          <div className="min-w-0 grow">
            <h3 className="truncate text-sm font-semibold">
              <Link to={templatePath(slug, template.id)} prefetch="intent" className="outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-accent">
                {template.title}
              </Link>
            </h3>
            <p className="truncate text-xs text-muted">
              Suggests {template.display_name}
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
    </Card>
  );
}
