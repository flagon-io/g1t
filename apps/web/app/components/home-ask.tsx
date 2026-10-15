/**
 * Home's way into Ask (components/ask-composer): the box at the top of the
 * page, Summarize on what happened in the span, and Explain on each change
 * that landed. Each hands its question to the top bar's Ask panel
 * (lib/ask.ts askG1t), which asks g1t in the viewer's direct message with
 * it, so the answer streams there and stays in Chat.
 */
import { ArrowUp, Sparkles } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";

import { askG1t } from "../lib/ask";
import { type LandedChange, type Span, explainQuestion, homeStarters, summarizeQuestion } from "../lib/home";
import { Suggestion, Suggestions } from "./ai-elements/suggestion";
import { MarkGlyph } from "./logo";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { Textarea } from "./ui/textarea";

type AskSpan = Pick<Span, "key" | "note" | "words" | "from">;

/** The top of Home: what are we building today, a box that asks g1t, and a few things to ask first. */
export function HomeAsk({ span, tz }: { span: AskSpan; tz: string | null }) {
  const [draft, setDraft] = useState("");
  const send = () => {
    if (!draft.trim()) return;
    askG1t(draft);
    setDraft("");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };
  return (
    <section aria-labelledby="home-ask" className="mx-auto flex w-full max-w-3xl flex-col items-center gap-5 pt-4 pb-2 md:pt-8">
      <h1 id="home-ask" className="text-center text-[1.75rem] leading-tight font-semibold tracking-tight md:text-[2rem]">
        What are we building today?
      </h1>
      <form onSubmit={submit} className="w-full">
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-2 pl-4 shadow-sm transition-shadow focus-within:border-accent-dim focus-within:ring-2 focus-within:ring-accent/25">
          <MarkGlyph className="mb-2.5 h-4 shrink-0" />
          <label htmlFor="home-ask-box" className="sr-only">
            Ask g1t
          </label>
          <Textarea
            id="home-ask-box"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={16_000}
            placeholder="Ask g1t what changed, what's blocked, or what to do next"
            className="field-sizing-content max-h-40 min-h-10 resize-none border-0 bg-transparent px-1 py-2 text-[0.9375rem] shadow-none focus-visible:ring-0"
          />
          <Hint label="Ask (Enter)">
            <Button type="submit" variant="accent" size="icon-sm" disabled={!draft.trim()} aria-label="Ask" className="mb-1">
              <ArrowUp size={15} />
            </Button>
          </Hint>
        </div>
      </form>
      <Suggestions className="justify-center">
        {homeStarters(span, tz).map((starter) => (
          <Suggestion key={starter.label} suggestion={starter.label} onPick={() => askG1t(starter.question)} />
        ))}
      </Suggestions>
    </section>
  );
}

/** Summarize what happened in the span, in plain English. */
export function SummarizeButton({ span, tz }: { span: AskSpan; tz: string | null }) {
  return (
    <Hint label="g1t reads everything that happened in this span and tells you what changed">
      <Button type="button" variant="soft" size="sm" onClick={() => askG1t(summarizeQuestion(span, tz))}>
        <Sparkles size={14} />
        Summarize
      </Button>
    </Hint>
  );
}

/** Explain one change that landed: what it did and why, in plain English. */
export function ExplainButton({ change }: { change: Pick<LandedChange, "kind" | "title" | "to"> }) {
  return (
    <Hint label="Explain this change">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Explain ${change.title}`}
        onClick={() => askG1t(explainQuestion(change))}
        className="shrink-0 text-muted hover:text-fg sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
      >
        <Sparkles size={13} />
      </Button>
    </Hint>
  );
}
