import { ArrowUp, AtSign, BookMarked, ChevronDown, MessageSquare, Plus, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * Mission control's place to ask g1t for anything: a question, a plan it
 * splits into issues for agents, or work started straight away. Shown so
 * it is clear where this will be, and not usable yet: nothing here sends,
 * and every control says so. Until then the actions under it do the work.
 */
export function AskComposer({ children }: { children?: ReactNode }) {
  return (
    <section aria-label="Agent" className="space-y-3">
      <div aria-disabled="true" className="rounded-xl border border-line bg-surface opacity-80">
        <p className="flex items-center gap-2 px-4 pt-3 text-sm font-medium text-fg">
          <Sparkles size={14} className="text-accent" aria-hidden="true" />
          Agent
          <span className="rounded-full border border-line px-1.5 text-[0.6875rem] font-normal text-muted">Coming later</span>
        </p>
        <label htmlFor="ask-g1t" className="sr-only">
          Ask the agent (coming later)
        </label>
        <textarea
          id="ask-g1t"
          disabled
          rows={2}
          placeholder="Ask anything, plan something out, or describe work to start. Type @ to add context."
          className="block w-full cursor-not-allowed resize-none bg-transparent px-4 pt-3.5 pb-2 text-sm text-fg placeholder:text-muted focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
          <Soon label="Mode">
            <MessageSquare size={14} /> Ask <ChevronDown size={13} className="text-faint" />
          </Soon>
          <Soon label="Scope">
            <BookMarked size={14} /> All repositories <ChevronDown size={13} className="text-faint" />
          </Soon>
          <Soon label="Add context" icon>
            <Plus size={15} />
          </Soon>
          <Soon label="Mention" icon>
            <AtSign size={14} />
          </Soon>
          <span className="ml-auto" />
          <Soon label="Send" icon>
            <ArrowUp size={15} />
          </Soon>
        </div>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </section>
  );
}

/** One of the composer's controls: there, disabled, with a tooltip saying why. */
function Soon({ label, icon, children }: { label: string; icon?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <button
            type="button"
            disabled
            aria-label={`${label} (coming later)`}
            className={`pointer-events-none inline-flex h-8 items-center gap-1.5 rounded-md border border-line text-sm text-muted ${icon ? "w-8 justify-center" : "px-2.5"}`}
          >
            {children}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>Agent is coming later</TooltipContent>
    </Tooltip>
  );
}
