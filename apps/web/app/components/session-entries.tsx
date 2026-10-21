/**
 * What a session recorded, step by step: the prompt folded, messages as
 * the markdown they are, and the tool calls between them run together, a
 * line each, with what came back folded under each. The pull request's
 * Sessions page and a harness session's page both list them.
 */
import { ChevronRight, FileText, MessageSquare, Plug, Sparkles, StickyNote, Terminal, Wrench } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { SessionEntry } from "@g1t/contracts";

import { MarkGlyph } from "./logo";
import { Markdown } from "./markdown";
import { TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Hint } from "./ui/hint";
import { repoAt } from "../lib/markdown-plugins";
import { askedPart } from "../lib/agent-chat";
import { type ToolCall, type ToolStep, quotedBlocks, readToolCall, transcript } from "../lib/session-entries";

/** Runs of more tool calls than this fold into one line. */
const OPEN_RUN = 3;
/** What a tool was called with, longer than this, has the rest to unfold. */
const LONG_DETAIL = 90;

/** Where an entry is on the page, for a highlight that cites it: `#entry-12`. */
export function entryAnchor(seq: number): string {
  return `entry-${seq}`;
}

/** An entry cited and gone to: clear of the top bars, and lit for a moment. */
const ANCHORED = "scroll-mt-[calc(var(--topbar-h)+1rem)] target:animate-arrive";

function At({ at }: { at: string }) {
  return (
    <span className="shrink-0 text-xs text-faint">
      <TimeAgo at={at} />
    </span>
  );
}

/** A prompt someone else typed: that there was one, not what it said. */
function KeptPrompt({ entry }: { entry: SessionEntry }) {
  return (
    <li id={entryAnchor(entry.seq)} className={`flex items-center gap-2 px-4 py-3 ${ANCHORED}`}>
      <Terminal size={14} className="shrink-0 text-faint" />
      <span className="shrink-0 font-medium text-fg-soft">Prompt</span>
      <span className="min-w-0 grow truncate text-xs text-faint">Shows only to whoever typed it.</span>
      <At at={entry.at} />
    </li>
  );
}

/** The prompt, folded under its first line. */
function Prompt({ entry, base }: { entry: SessionEntry; base?: string }) {
  const [open, setOpen] = useState(false);
  const first = entry.text.split("\n").find((line) => line.trim()) ?? "";
  return (
    <li id={entryAnchor(entry.seq)} className={`px-4 py-3 ${ANCHORED}`}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2">
          <Terminal size={14} className="shrink-0 text-accent" />
          <CollapsibleTrigger className="min-w-0 grow text-left">
            <span className="shrink-0 font-medium text-fg">Prompt</span>
            {!open && <span className="min-w-0 truncate text-xs text-faint">{first}</span>}
            <ChevronRight size={13} className="shrink-0" />
          </CollapsibleTrigger>
          <At at={entry.at} />
        </div>
        <CollapsibleContent>
          <Card tone="bg" radius="lg" className="mt-2 max-h-128 overflow-auto p-4 text-sm">
            <Markdown source={quotedBlocks(entry.text)} repo={repoAt(base)} />
          </Card>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/** What a tool was called on: g1t's tools by resource and action, a command as code, a file by its path. */
function ToolLabel({ call }: { call: ToolCall }) {
  if (call.server) {
    return (
      <span className="flex min-w-0 items-baseline gap-1.5">
        {call.server !== "g1t" && <span className="shrink-0 text-faint">{call.server}</span>}
        <span className="shrink-0 font-medium text-fg-soft">{call.name}</span>
        {call.detail && (
          <>
            <span className="text-faint">·</span>
            <span className="min-w-0 truncate text-muted">{call.detail}</span>
          </>
        )}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Badge shape="tag" className="font-mono font-normal">
        {call.name.toLowerCase()}
      </Badge>
      {call.detail && <code className="min-w-0 truncate font-mono text-fg/85">{call.detail}</code>}
    </span>
  );
}

function ToolIcon({ call }: { call: ToolCall }) {
  if (call.server === "g1t") return <MarkGlyph className="h-3" />;
  const Icon = call.server ? Plug : call.sort === "shell" ? Terminal : call.sort === "file" ? FileText : Wrench;
  return <Icon size={13} className="text-faint" />;
}

/** A block of text a tool was called with or gave back. */
function Block({ children }: { children: ReactNode }) {
  return (
    <Card asChild tone="bg" radius="lg" className="mt-1.5 max-h-72 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all text-muted">
      <pre>{children}</pre>
    </Card>
  );
}

/** One tool call in a line; a long one, and what came back, unfold under it. */
function ToolRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false);
  const call = step.call ? readToolCall(step.call) : null;
  const long = Boolean(call && call.detail.length > LONG_DETAIL);
  const label = call ? <ToolLabel call={call} /> : <span className="text-muted">Result</span>;
  return (
    <li className="flex gap-2 py-0.5 text-xs">
      <span className="flex h-4.5 w-4 shrink-0 items-center justify-center">
        {call ? <ToolIcon call={call} /> : <Wrench size={13} className="text-faint" />}
      </span>
      {long || step.results.length > 0 ? (
        <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 grow">
          <CollapsibleTrigger className="flex w-full min-w-0 text-left text-xs">
            {label}
            <span className="ml-auto flex shrink-0 items-center gap-1 text-faint">
              {call && step.results.length > 0 && (step.results.length === 1 ? "result" : `${step.results.length} results`)}
              <ChevronRight size={12} />
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {long && call && <Block>{call.detail}</Block>}
            {step.results.map((result) =>
              result.withheld ? (
                <p key={result.seq} className="text-xs text-faint">
                  Its output shows only to whoever ran it.
                </p>
              ) : (
                <Block key={result.seq}>{result.text}</Block>
              ),
            )}
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <Hint label={call && call.detail.length > 40 ? call.detail : null}>
          <span className="flex min-w-0 grow">{label}</span>
        </Hint>
      )}
    </li>
  );
}

/** The tools of a run, each once, for its folded line. */
function toolNames(steps: ToolStep[]): string {
  const names = new Set<string>();
  for (const step of steps) {
    if (!step.call) continue;
    const call = readToolCall(step.call);
    names.add(call.server && call.server !== "g1t" ? call.server : call.name.toLowerCase());
  }
  return [...names].join(", ");
}

/** Tool calls one after another: a few in a tight list, more folded into one line that opens to it. */
function ToolRun({ steps }: { steps: ToolStep[] }) {
  const first = steps[0]!;
  const id = entryAnchor(first.call?.seq ?? first.results[0]?.seq ?? 0);
  const [open, setOpen] = useState(false);
  const calls = steps.filter((step) => step.call).length;
  const list = (
    <ol className="space-y-0.5">
      {steps.map((step) => (
        <ToolRow key={(step.call ?? step.results[0]).seq} step={step} />
      ))}
    </ol>
  );
  if (steps.length <= OPEN_RUN)
    return (
      <li id={id} className={`px-4 py-2 ${ANCHORED}`}>
        {list}
      </li>
    );
  return (
    <li id={id} className={`px-4 py-2 ${ANCHORED}`}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2 text-xs">
          <span className="flex w-4 shrink-0 justify-center">
            <Wrench size={13} className="text-faint" />
          </span>
          <CollapsibleTrigger className="min-w-0 text-left text-xs">
            <span className="shrink-0 font-medium text-fg-soft">{calls === 1 ? "1 tool call" : `${calls} tool calls`}</span>
            {!open && <span className="min-w-0 truncate text-faint">{toolNames(steps)}</span>}
            <ChevronRight size={12} className="shrink-0" />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="mt-1">{list}</CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function Entry({ entry, base }: { entry: SessionEntry; base?: string }) {
  if (entry.kind === "prompt") return entry.withheld ? <KeptPrompt entry={entry} /> : <Prompt entry={entry} base={base} />;
  if (entry.kind === "message") {
    return (
      <li id={entryAnchor(entry.seq)} className={`flex gap-2.5 px-4 py-3 text-sm ${ANCHORED}`}>
        <MessageSquare size={14} className="mt-1 shrink-0 text-faint" />
        <div className="min-w-0 grow">
          <Markdown source={entry.text} repo={repoAt(base)} />
        </div>
        <At at={entry.at} />
      </li>
    );
  }
  if (entry.kind === "skill") {
    return (
      <li id={entryAnchor(entry.seq)} className={`flex items-center gap-2.5 px-4 py-2 text-xs text-muted ${ANCHORED}`}>
        <Sparkles size={13} className="shrink-0 text-accent" />
        <span className="min-w-0 grow">
          Used skill{" "}
          <Badge shape="tag" className="font-mono">
            {entry.text}
          </Badge>
        </span>
        <At at={entry.at} />
      </li>
    );
  }
  return (
    <li id={entryAnchor(entry.seq)} className={`flex gap-2.5 px-4 py-2.5 text-xs text-muted ${ANCHORED}`}>
      <StickyNote size={13} className="mt-0.5 shrink-0 text-faint" />
      <span className="min-w-0 grow">{entry.text}</span>
      <At at={entry.at} />
    </li>
  );
}

/**
 * What someone sent the session, as a chat shows it: their words in a
 * bubble on the right. The first message's own part (where it works, how
 * to set up, which g1t added: `ASKED_SEPARATOR`) folds under it.
 */
function ChatPrompt({ entry, base }: { entry: SessionEntry; base?: string }) {
  const [open, setOpen] = useState(false);
  if (entry.withheld) {
    return (
      <li id={entryAnchor(entry.seq)} className={`flex justify-end ${ANCHORED}`}>
        <span className="rounded-2xl bg-raised px-4 py-2.5 text-xs text-faint">A prompt that shows only to whoever typed it.</span>
      </li>
    );
  }
  const { asked, added } = askedPart(entry.text);
  return (
    <li id={entryAnchor(entry.seq)} className={`flex flex-col items-end gap-1 ${ANCHORED}`}>
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-[0.9375rem] wrap-break-word">
        <Markdown source={quotedBlocks(asked)} repo={repoAt(base)} />
      </div>
      {added && (
        <Collapsible open={open} onOpenChange={setOpen} className="flex max-w-[85%] flex-col items-end">
          <CollapsibleTrigger className="text-xs text-faint">
            {open ? "Hide what g1t added" : "What g1t added"}
            <ChevronRight size={12} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Card tone="bg" radius="lg" className="mt-1.5 max-h-96 overflow-auto p-3 text-xs">
              <Markdown source={quotedBlocks(added)} repo={repoAt(base)} />
            </Card>
          </CollapsibleContent>
        </Collapsible>
      )}
    </li>
  );
}

/** One entry as a chat shows it: prompts on the right, what the agent wrote as plain text, the rest quiet. */
function ChatEntry({ entry, base }: { entry: SessionEntry; base?: string }) {
  if (entry.kind === "prompt") return <ChatPrompt entry={entry} base={base} />;
  if (entry.kind === "message") {
    return (
      <li id={entryAnchor(entry.seq)} className={`text-[0.9375rem] leading-relaxed ${ANCHORED}`}>
        <Markdown source={entry.text} repo={repoAt(base)} />
      </li>
    );
  }
  const skill = entry.kind === "skill";
  return (
    <li id={entryAnchor(entry.seq)} className={`flex items-start gap-2 text-xs text-muted ${ANCHORED}`}>
      {skill ? <Sparkles size={13} className="mt-0.5 shrink-0 text-accent" /> : <StickyNote size={13} className="mt-0.5 shrink-0 text-faint" />}
      <span className="min-w-0 grow">
        {skill ? (
          <>
            Used skill{" "}
            <Badge shape="tag" className="font-mono">
              {entry.text}
            </Badge>
          </>
        ) : (
          entry.text
        )}
      </span>
      <At at={entry.at} />
    </li>
  );
}

/**
 * A session's entries, oldest first. `base`, the repository's path
 * (`/acme/web`), links `#12` and the like in what it wrote. `card` (the
 * default) lists them in a card, as a transcript; `chat` draws them as a
 * conversation, for a hosted session someone is talking to on its page:
 * what was sent on the right, what it wrote as text, its tool calls in
 * quiet runs between.
 */
export function SessionEntries({ entries, base, variant = "card" }: { entries: SessionEntry[]; base?: string; variant?: "card" | "chat" }) {
  if (variant === "chat") {
    return (
      <ol className="space-y-5">
        {transcript(entries).map((item) =>
          item.kind === "tools" ? (
            <li key={item.first.seq}>
              <Card asChild tone="plain" radius="lg" className="-mx-1 border-dashed">
                <ol>
                  <ToolRun steps={item.steps} />
                </ol>
              </Card>
            </li>
          ) : (
            <ChatEntry key={item.entry.seq} entry={item.entry} base={base} />
          ),
        )}
      </ol>
    );
  }
  return (
    <Card asChild divided>
      <ol>
        {transcript(entries).map((item) =>
          item.kind === "tools" ? <ToolRun key={item.first.seq} steps={item.steps} /> : <Entry key={item.entry.seq} entry={item.entry} base={base} />,
        )}
      </ol>
    </Card>
  );
}
