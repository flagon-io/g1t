/**
 * What a session recorded, step by step: prompts folded, messages in full,
 * tool calls in a line each and their results folded. The pull request's
 * Sessions page and a harness session's page both list them.
 */
import { MessageSquare, Sparkles, StickyNote, Terminal, Wrench } from "lucide-react";

import type { SessionEntry } from "@g1t/contracts";

import { TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";

function Entry({ entry }: { entry: SessionEntry }) {
  const at = (
    <span className="shrink-0 text-xs text-faint">
      <TimeAgo at={entry.at} />
    </span>
  );
  if (entry.kind === "prompt") {
    return (
      <li className="px-4 py-3">
        <details>
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Terminal size={14} className="text-accent" />
            <span className="grow">Prompt</span>
            {at}
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-bg p-3 text-xs whitespace-pre-wrap text-muted">{entry.text}</pre>
        </details>
      </li>
    );
  }
  if (entry.kind === "message") {
    return (
      <li className="flex gap-2.5 px-4 py-3 text-sm">
        <MessageSquare size={14} className="mt-0.5 shrink-0 text-faint" />
        <p className="min-w-0 grow whitespace-pre-wrap wrap-break-word">{entry.text}</p>
        {at}
      </li>
    );
  }
  if (entry.kind === "tool_call") {
    return (
      <li className="flex gap-2.5 px-4 py-2 text-xs">
        <Wrench size={13} className="mt-0.5 shrink-0 text-faint" />
        <span className="shrink-0 font-medium text-muted">{entry.tool}</span>
        <Hint label={entry.text}>
          <code className="min-w-0 grow truncate font-mono text-fg/85">{entry.text}</code>
        </Hint>
      </li>
    );
  }
  if (entry.kind === "tool_result") {
    return (
      <li className="px-4 py-1.5 pl-10">
        <details>
          <summary className="cursor-pointer text-xs text-faint">Result</summary>
          <pre className="mt-1.5 max-h-72 overflow-auto rounded-lg bg-bg p-3 text-xs text-muted">{entry.text}</pre>
        </details>
      </li>
    );
  }
  if (entry.kind === "skill") {
    return (
      <li className="flex items-center gap-2.5 px-4 py-2 text-xs text-muted">
        <Sparkles size={13} className="shrink-0 text-accent" />
        <span className="min-w-0 grow">
          Used skill <Badge shape="tag" className="font-mono">{entry.text}</Badge>
        </span>
        {at}
      </li>
    );
  }
  return (
    <li className="flex gap-2.5 px-4 py-2.5 text-xs text-muted">
      <StickyNote size={13} className="mt-0.5 shrink-0 text-faint" />
      <span className="min-w-0 grow">{entry.text}</span>
      {at}
    </li>
  );
}

/** A session's entries in a card, oldest first. */
export function SessionEntries({ entries }: { entries: SessionEntry[] }) {
  return (
    <Card asChild divided>
      <ol>
        {entries.map((entry) => (
          <Entry key={entry.seq} entry={entry} />
        ))}
      </ol>
    </Card>
  );
}
