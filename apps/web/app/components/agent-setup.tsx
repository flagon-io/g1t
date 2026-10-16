import { Check, Copy, ExternalLink } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useRouteLoaderData } from "react-router";

import type { loader as rootLoader } from "../root";

import {
  AGENT_IDS,
  type AgentId,
  DEFAULT_AGENT,
  agentsFor,
  cursorInstallLink,
  getAgentChoice,
  setAgentChoice,
  subscribeAgentChoice,
} from "../lib/agent-setup";
import { useAddresses } from "../lib/addresses";
import { SelectField } from "./ui/select";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

/** The agent this browser chose last; every toggle on the page shares it. */
export function useAgentChoice(): [AgentId, (id: AgentId) => void] {
  const root = useRouteLoaderData<typeof rootLoader>("root");
  const fallback = root?.agentDefault ?? DEFAULT_AGENT;
  const id = useSyncExternalStore(subscribeAgentChoice, () => getAgentChoice(fallback), () => root?.agentChoice ?? fallback);
  return [id, setAgentChoice];
}

/**
 * How to connect g1t to a coding agent: a client picker, the command or
 * config for the one chosen, and a copy button. Choosing an agent switches
 * every block on the page and is remembered.
 */
export function AgentSetup({ hint = true, className }: { hint?: boolean; className?: string }) {
  const [chosen, choose] = useAgentChoice();
  const [copied, setCopied] = useState(false);
  const { mcp } = useAddresses();
  const agents = useMemo(() => agentsFor(mcp), [mcp]);
  const agent = agents[chosen];

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
      <Card radius="lg" className="@container overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-2">
          <span className="text-xs text-muted">Connect with</span>
          <SelectField
            aria-label="AI client"
            value={chosen}
            onValueChange={(id) => { setCopied(false); choose(id as AgentId); }}
            options={AGENT_IDS.map((id) => ({ value: id, label: agents[id].label }))}
            size="sm"
            className="w-44"
          />
        </div>
        <div className="relative" role="region" aria-label={`${agent.label} setup`}>
          {agent.file && (
            <p className="px-3.5 pt-2.5 font-mono text-[0.6875rem] text-faint">{agent.file}</p>
          )}
          <pre className="overflow-x-auto py-2.5 pr-11 pl-3.5 font-mono text-[0.8125rem] leading-relaxed">
            <code>
              {agent.lang === "sh"
                ? agent.code.split("\n").map((line, index) => (
                    <span key={index} className="block whitespace-pre-wrap wrap-anywhere">
                      <span className="mr-2 text-faint select-none">$</span>
                      {line}
                    </span>
                  ))
                : agent.code}
            </code>
          </pre>
          <Button
            type="button"
            aria-label={copied ? "Copied" : `Copy the ${agent.label} ${agent.file ? "config" : agent.lang === "text" ? "URL" : "command"}`}
            onClick={copy}
            variant="ghost"
            size="inline"
            className="absolute top-1.5 right-1.5 p-1.5 text-faint"
          >
            {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          </Button>
        </div>
      </Card>
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
          {chosen === "codex" && mcp === "https://mcp.g1t.sh" && (
            <> {" "}<a href="https://docs.g1t.sh/guides/bring-your-own-agent/#codex-marketplace" className="text-fg underline underline-offset-4">Install the Codex plugin</a> for issue and session workflows.</>
          )}
          {chosen === "cursor" && (
            <>
              {" "}
              <a href={cursorInstallLink(mcp)} className="inline-flex items-center gap-1 text-fg underline underline-offset-4">
                Add to Cursor <ExternalLink size={11} />
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
