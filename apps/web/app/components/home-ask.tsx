/**
 * Home's way into Ask (components/ask-composer): the box at the top of the
 * page, What changed (g1t's plain-English summary of the span, streamed
 * onto the page by components/home-summary), and Explain on each change
 * that landed (components/home.tsx). The box and Explain hand their
 * question to the top bar's Ask panel (lib/ask.ts askG1t). Every question
 * goes to the viewer's direct message with @g1t, so the answers stay in
 * Chat and Ask carries on from them.
 */
import { ArrowUp, MessageSquare, RotateCcw, Sparkles } from "lucide-react";
import { type FormEvent, type KeyboardEvent, Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { askG1t, openAsk } from "../lib/ask";
import { HOME_STARTERS, type Span, summarizeQuestion } from "../lib/home";
import { Suggestion, Suggestions } from "./ai-elements/suggestion";
import { MarkGlyph } from "./logo";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { Skeleton } from "./ui/skeleton";
import { Textarea } from "./ui/textarea";

const loadSummary = () => import("./home-summary");
const HomeSummary = lazy(loadSummary);

type AskSpan = Pick<Span, "key" | "note" | "words" | "from" | "now">;

/** The window event Home's box sends to have What changed summarize the span. */
const SUMMARIZE_EVENT = "g1t:home-summarize";

/** What the span is called on a button: "since I was last here", "in the last 24 hours". */
function spanLabel(span: AskSpan): string {
  return span.key === "last" && span.note == null ? "since I was last here" : `${span.words.charAt(0).toLowerCase()}${span.words.slice(1)}`;
}

/** The top of Home: what are we building today, a box that asks g1t, and a few things to ask first. */
export function HomeAsk({ span }: { span: AskSpan }) {
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
          <MarkGlyph className="mb-2.5 h-4 shrink-0 max-sm:hidden" />
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
            className="field-sizing-content max-h-40 min-h-10 resize-none border-0 bg-transparent px-1 py-2 text-base shadow-none focus-visible:ring-0 sm:text-[0.9375rem]"
          />
          <Hint label="Ask (Enter)">
            <Button type="submit" variant="accent" size="icon-sm" disabled={!draft.trim()} aria-label="Ask" className="mb-1">
              <ArrowUp size={15} />
            </Button>
          </Hint>
        </div>
      </form>
      <Suggestions className="justify-center">
        <Suggestion
          suggestion={`Summarize what changed ${spanLabel(span)}`}
          onPick={() => window.dispatchEvent(new CustomEvent(SUMMARIZE_EVENT))}
          onPointerEnter={() => void loadSummary()}
          className="border-accent-dim text-fg"
        />
        {HOME_STARTERS.map((starter) => (
          <Suggestion key={starter.label} suggestion={starter.label} onPick={() => askG1t(starter.question)} />
        ))}
      </Suggestions>
    </section>
  );
}

/**
 * What changed: g1t's summary of the span in plain English, on the page,
 * a strip in the span's card. Asked only when the viewer presses
 * Summarize (each answer is a call to the workspace's own AI provider);
 * asked again for another span.
 */
export function WhatChangedCard({ slug, span, tz }: { slug: string; span: AskSpan; tz: string | null }) {
  // Each ask is its own: Summarize again asks anew.
  const [asked, setAsked] = useState<{ question: string; at: number } | null>(null);
  const [done, setDone] = useState<{ channelId: string | null } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const label = spanLabel(span);

  const summarize = useCallback(() => {
    setDone(null);
    setAsked({ question: summarizeQuestion(span, tz), at: Date.now() });
  }, [span, tz]);

  // Home's box asks for it: bring the card into view and start.
  useEffect(() => {
    const onAsk = () => {
      card.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      summarize();
    };
    window.addEventListener(SUMMARIZE_EVENT, onAsk);
    return () => window.removeEventListener(SUMMARIZE_EVENT, onAsk);
  }, [summarize]);

  const onDone = useCallback((channelId: string | null) => setDone({ channelId }), []);

  return (
    <div ref={card} className="scroll-mt-4 border-t border-line">
        <div className="px-5 py-3.5">
          {!asked ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <p className="grow text-sm text-muted">
                <span className="font-medium text-fg">What changed, in plain English.</span> g1t reads the commits, pull requests, deploys and conversations {label} and
                tells you what changed, why, and what is live.
              </p>
              <Button type="button" variant="accent" size="sm" onClick={summarize} onPointerEnter={() => void loadSummary()} className="shrink-0 self-start sm:self-auto">
                <Sparkles size={14} />
                Summarize
              </Button>
            </div>
          ) : (
            <>
              <Suspense
                fallback={
                  <div className="space-y-2.5">
                    <Skeleton className="h-3.5 w-11/12" />
                    <Skeleton className="h-3.5 w-3/4" />
                  </div>
                }
              >
                <HomeSummary key={asked.at} slug={slug} question={asked.question} onDone={onDone} />
              </Suspense>
              {done && (
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  <Button type="button" variant="soft" size="sm" onClick={openAsk}>
                    <MarkGlyph className="h-3" />
                    Ask a follow-up
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={summarize}>
                    <RotateCcw size={13} />
                    Summarize again
                  </Button>
                  {done.channelId && (
                    <Button asChild variant="ghost" size="sm" className="sm:ml-auto">
                      <Link to={`/${slug}/-/chat/dm/${done.channelId}`}>
                        <MessageSquare size={13} />
                        In your direct message with g1t
                      </Link>
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
    </div>
  );
}
