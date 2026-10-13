import { Ban, Check, ChevronRight, CircleAlert, Copy, ExternalLink, LoaderCircle, Play, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";

import type { AskSource } from "@g1t/contracts";

import { type Proposal, type Step, foldAnswer, proposalTitle } from "../lib/ask";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Hint } from "./ui/hint";

/**
 * What an Ask answer did to answer (lib/ask.ts `Step`): each of g1t's tools
 * it ran as the person asking, one compact row each, with what it found and
 * a link to the page it read. Open while the answer is being written, folded
 * into one line once it is done. Each row is one tool call, as a chat's
 * tool-call part is, so the same steps can be drawn there.
 */
export function AskSteps({ steps, working }: { steps: Step[]; working: boolean }) {
  const [open, setOpen] = useState(working);
  // Open while it works, folded when it is done; the person can open it again.
  useEffect(() => setOpen(working), [working]);
  if (steps.length === 0) return null;
  const failed = steps.filter((step) => step.status === "failed" || step.status === "refused").length;
  const running = steps.some((step) => step.status === "running");
  const title = running
    ? (steps.findLast((step) => step.status === "running")?.label ?? "Reading g1t")
    : `Read g1t in ${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="max-w-full text-xs">
        <ChevronRight size={12} aria-hidden="true" className="shrink-0" />
        {running && <LoaderCircle size={12} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />}
        <span className="truncate">{title}</span>
        {failed > 0 && !running && (
          <Badge tone="warn" className="ml-1">
            {failed} not read
          </Badge>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-1.5 space-y-1 border-l border-line pl-3" aria-label="Steps">
          {steps.map((step) => (
            <li key={step.id}>
              <StepRow step={step} />
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

const STATUS_LABEL: Record<Step["status"], string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  refused: "Not run",
};

function StatusIcon({ status }: { status: Step["status"] }) {
  const label = STATUS_LABEL[status];
  switch (status) {
    case "running":
      return <LoaderCircle size={12} aria-label={label} className="mt-0.5 shrink-0 animate-spin text-muted motion-reduce:animate-none" />;
    case "done":
      return <Check size={12} aria-label={label} className="mt-0.5 shrink-0 text-success" />;
    case "failed":
      return <CircleAlert size={12} aria-label={label} className="mt-0.5 shrink-0 text-danger" />;
    case "refused":
      return <Ban size={12} aria-label={label} className="mt-0.5 shrink-0 text-faint" />;
  }
}

function StepRow({ step }: { step: Step }) {
  const tool = step.action ? `${step.name} ${step.action}` : step.name;
  return (
    <div className="flex min-w-0 items-start gap-1.5 text-xs leading-5">
      <StatusIcon status={step.status} />
      <div className="min-w-0 flex-1">
        <Hint label={<span className="font-mono">{tool}</span>} side="left">
          <span className="text-muted">{step.label}</span>
        </Hint>
        {step.summary && <span className={step.status === "done" ? "text-faint" : "text-warn"}> · {step.summary}</span>}
      </div>
      {step.link && (
        <a
          href={step.link}
          className="mt-0.5 shrink-0 text-faint hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label={`Open ${step.label}`}
        >
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

/**
 * An answer's steps and sources from the raw `tool` and `sources` lines kept
 * with it (a chat message's `meta.answer.steps`): steps above the answer's
 * text, sources below. Mount each half where it goes with `part`.
 */
export function AskTrail({ events, working, part, slug }: { events: unknown; working: boolean; part: "steps" | "sources" | "proposals"; slug?: string }) {
  const { steps, sources, proposals } = foldAnswer(events);
  if (part === "steps") return <AskSteps steps={steps} working={working} />;
  if (part === "sources") return <AskSources sources={sources} />;
  if (!slug || proposals.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {proposals.map((proposal) => (
        <SessionProposal key={proposal.id} proposal={proposal} slug={slug} />
      ))}
    </div>
  );
}

type Started = { session_url: string | null; provider_session_url: string | null; handoff: boolean; command: string | null; prompt: string };

/**
 * Work g1t proposed to hand to a session in the person's own harness. Ask
 * never starts it: Start runs it on the workspace's Anthropic account (when
 * one is connected), Copy command gives the Claude Code command to run it
 * with the g1t plugin. Either way the session is tied to the issue.
 */
export function SessionProposal({ proposal, slug }: { proposal: Proposal; slug: string }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"start" | "copy" | null>(null);
  const [started, setStarted] = useState<Started | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/${slug}/-/ask?sessions`, { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? (response.json() as Promise<{ available?: boolean }>) : null))
      .then((setup) => live && setAvailable(Boolean(setup?.available)))
      .catch(() => live && setAvailable(false));
    return () => {
      live = false;
    };
  }, [slug]);

  const go = async (handoff: boolean) => {
    setBusy(handoff ? "copy" : "start");
    setError(null);
    try {
      const response = await fetch(`/${slug}/-/ask`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ...proposal, handoff }),
      });
      const body = (await response.json().catch(() => null)) as (Started & { error?: string }) | null;
      if (!response.ok || !body) throw new Error(body?.error ?? "The session could not be started.");
      setStarted(body);
      if (handoff && body.command) {
        await navigator.clipboard?.writeText(body.command);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(null);
    }
  };

  const running = started && !started.handoff;
  return (
    <Card className="flex flex-col gap-2.5 px-3.5 py-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <SquareTerminal size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-fg">{proposalTitle(proposal)}</span>
            <Badge className="px-1.5 py-0 font-normal">Session</Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {proposal.issue ? "Runs in your own harness, with your skills, tied to the issue." : "Opens the issue, then runs in your own harness, tied to it."}
          </p>
          {proposal.instruction && <p className="mt-1 line-clamp-2 text-xs text-faint">{proposal.instruction}</p>}
        </div>
      </div>
      {running ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Check size={13} aria-hidden="true" className="text-success" />
          <span className="text-muted">Started</span>
          {started.session_url && (
            <Button asChild variant="link" size="inline" className="text-xs">
              <a href={started.session_url}>Follow it on g1t</a>
            </Button>
          )}
          {started.provider_session_url && (
            <Button asChild variant="link" size="inline" className="text-xs">
              <a href={started.provider_session_url} target="_blank" rel="noreferrer">
                In Anthropic&rsquo;s console <ExternalLink size={11} aria-hidden="true" />
              </a>
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {available && (
            <Button size="xs" variant="accent" busy={busy === "start"} disabled={busy !== null} onClick={() => void go(false)}>
              <Play size={12} aria-hidden="true" />
              Start session
            </Button>
          )}
          <Button size="xs" variant="outline" busy={busy === "copy"} disabled={busy !== null} onClick={() => void go(true)}>
            {copied ? <Check size={12} aria-hidden="true" className="text-success" /> : <Copy size={12} aria-hidden="true" />}
            {copied ? "Copied" : "Copy Claude Code command"}
          </Button>
          {available === false && <span className="text-xs text-faint">Or connect Anthropic to start it here.</span>}
        </div>
      )}
      {started?.handoff && started.command && (
        <pre className="overflow-x-auto rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-xs text-fg-soft scrollbar-thin">{started.command}</pre>
      )}
      {error && (
        <p className="flex items-start gap-1.5 text-xs text-danger" role="alert">
          <CircleAlert size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
    </Card>
  );
}

/** The pages on g1t an answer drew on: the ones it links to first. */
export function AskSources({ sources }: { sources: AskSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="text-xs">
      <div className="mb-1 text-faint">Sources</div>
      <ul className="flex flex-wrap gap-1.5" aria-label="Sources">
        {sources.map((source) => (
          <li key={source.url} className="min-w-0">
            <Hint label={source.url}>
              <a href={source.url} className="group inline-flex max-w-64 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <Badge size="md" className="max-w-full group-hover:border-accent/40 group-hover:text-fg">
                  <span className="truncate">{source.title}</span>
                </Badge>
              </a>
            </Hint>
          </li>
        ))}
      </ul>
    </div>
  );
}
