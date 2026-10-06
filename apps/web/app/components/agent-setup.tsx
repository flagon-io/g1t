import { Check, Copy, ExternalLink } from "lucide-react";
import { type KeyboardEvent, useId, useState, useSyncExternalStore } from "react";

import {
  AGENTS,
  AGENT_IDS,
  type AgentId,
  DEFAULT_AGENT,
  cursorInstallLink,
  getAgentChoice,
  setAgentChoice,
  subscribeAgentChoice,
} from "../lib/agent-setup";
import { cn } from "../lib/cn";

/** The agent this browser chose last; every toggle on the page shares it. */
export function useAgentChoice(): [AgentId, (id: AgentId) => void] {
  const id = useSyncExternalStore(subscribeAgentChoice, getAgentChoice, () => DEFAULT_AGENT);
  return [id, setAgentChoice];
}

/**
 * How to connect g1t to a coding agent: a tab per agent, the command or
 * config for the one chosen, and a copy button. Choosing an agent switches
 * every block on the page and is remembered.
 */
export function AgentSetup({ hint = true, className }: { hint?: boolean; className?: string }) {
  const [chosen, choose] = useAgentChoice();
  const [copied, setCopied] = useState(false);
  const base = useId();
  const agent = AGENTS[chosen];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = AGENT_IDS[(AGENT_IDS.indexOf(chosen) + step + AGENT_IDS.length) % AGENT_IDS.length];
    choose(next);
    document.getElementById(`${base}-${next}`)?.focus();
  };

  const copy = () => {
    void navigator.clipboard?.writeText(agent.code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  return (
    <div className={className}>
      <div className="@container overflow-hidden rounded-lg border border-line bg-surface">
        <div
          role="tablist"
          aria-label="Coding agent"
          onKeyDown={onKeyDown}
          className="flex flex-wrap items-center gap-0.5 border-b border-line bg-bg/40 px-1.5 py-1.5"
        >
          {AGENT_IDS.map((id) => {
            const on = id === chosen;
            return (
              <button
                key={id}
                id={`${base}-${id}`}
                type="button"
                role="tab"
                aria-selected={on}
                aria-controls={`${base}-panel`}
                tabIndex={on ? 0 : -1}
                onClick={() => choose(id)}
                className={cn(
                  "shrink-0 rounded-md px-1.5 py-1 text-xs @sm:px-2.5 font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                  on ? "bg-raised text-fg" : "text-muted hover:text-fg",
                )}
              >
                {AGENTS[id].label}
              </button>
            );
          })}
        </div>
        <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-${chosen}`} className="relative">
          {agent.file && (
            <p className="px-3.5 pt-2.5 font-mono text-[0.6875rem] text-faint">{agent.file}</p>
          )}
          <pre className="overflow-x-auto py-2.5 pr-11 pl-3.5 font-mono text-[0.8125rem] leading-relaxed">
            <code>
              {agent.lang === "sh"
                ? agent.code.split("\n").map((line, index) => (
                    <span key={index} className="block whitespace-pre-wrap [overflow-wrap:anywhere]">
                      <span className="mr-2 text-faint select-none">$</span>
                      {line}
                    </span>
                  ))
                : agent.code}
            </code>
          </pre>
          <button
            type="button"
            aria-label={copied ? "Copied" : `Copy the ${agent.label} ${agent.file ? "config" : "command"}`}
            onClick={copy}
            className="absolute top-1.5 right-1.5 rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-fg"
          >
            {copied ? <Check size={14} className="text-accent" /> : <Copy size={14} />}
          </button>
        </div>
      </div>
      {hint && (
        <p className="mt-2 text-xs leading-5 text-muted">
          {agent.then.split("`").map((part, index) =>
            index % 2 ? (
              <code key={index} className="font-mono text-fg-soft">
                {part}
              </code>
            ) : (
              part
            ),
          )}
          {chosen === "cursor" && (
            <>
              {" "}
              <a href={cursorInstallLink()} className="inline-flex items-center gap-1 text-fg underline underline-offset-4">
                Add to Cursor <ExternalLink size={11} />
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
