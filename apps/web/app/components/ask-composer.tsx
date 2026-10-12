import { ArrowUp, AtSign, Plus, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { MarkGlyph } from "./logo";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/**
 * The place to ask AI for something and hand the work to one of the
 * workspace's AI providers (Workspace settings → Integrations → Your AI
 * providers). Shown so it is clear where this will be, and not usable yet:
 * nothing here sends, and every control says so.
 */
export function AskComposer({ slug, children }: { slug: string; children?: ReactNode }) {
  return (
    <section aria-label="Ask AI" className="space-y-3">
      <Card aria-disabled="true" className="opacity-80">
        <p className="flex items-center gap-2 px-4 pt-3 text-sm font-medium text-fg">
          <Sparkles size={14} className="text-accent" aria-hidden="true" />
          Ask AI
          <Badge className="px-1.5 py-0 font-normal">Coming soon</Badge>
        </p>
        <label htmlFor="ask-ai" className="sr-only">
          Ask AI (coming soon)
        </label>
        <textarea
          id="ask-ai"
          disabled
          rows={2}
          placeholder="Ask anything, or describe work to hand to your AI provider."
          className="block w-full cursor-not-allowed resize-none bg-transparent px-4 pt-3.5 pb-2 text-sm text-fg placeholder:text-muted focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
          <Soon label="Add context">
            <Plus size={15} />
          </Soon>
          <Soon label="Mention">
            <AtSign size={14} />
          </Soon>
          <span className="ml-auto" />
          <Soon label="Send">
            <ArrowUp size={15} />
          </Soon>
        </div>
      </Card>
      <p className="text-xs text-muted">
        It will hand off to{" "}
        <Link to={`/${slug}/-/integrations/models`} className="text-accent hover:underline">
          your AI providers
        </Link>
        .
      </p>
      {children}
    </section>
  );
}

/** One of the composer's controls: there, disabled, with a hint saying why. */
function Soon({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Hint label="Coming soon" disabled>
      <Button type="button" variant="outline" size="icon-sm" disabled aria-label={`${label} (coming soon)`}>
        {children}
      </Button>
    </Hint>
  );
}

/**
 * The top bar's Ask AI: the lavender pixel 1 beside its words, on a wash of
 * the accent. Not on yet: it opens the composer, which says so.
 */
export function AskButton({ slug }: { slug: string }) {
  return (
    <Popover>
      <Hint label="Ask AI · coming soon">
        <PopoverTrigger asChild>
          <Button variant="soft" size="bar" aria-label="Ask AI (coming soon)" className="gap-2 max-md:ring-0 lg:px-3">
            <MarkGlyph className="h-3.5" />
            <span className="max-lg:hidden">Ask AI</span>
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" className="w-[26rem] p-3">
        <AskComposer slug={slug} />
      </PopoverContent>
    </Popover>
  );
}
