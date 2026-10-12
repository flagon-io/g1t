import { ArrowUp, CircleAlert, RotateCcw, Settings2, Square } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useLocation } from "react-router";

import { ASK_MAX_MESSAGE_CHARS, type AskEvent, type AskSetup } from "@g1t/contracts";

import { EMPTY_ASK, type Turn, askPage, askReducer, cutOff, history, readLines } from "../lib/ask";
import { MessageText, type TextContext } from "./chat/text";
import { MarkGlyph } from "./logo";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./ui/sheet";
import { Skeleton } from "./ui/skeleton";

/**
 * Ask g1t: a conversation with g1t about your work, from the top bar. The
 * answers come from the AI provider and model an owner chose for the
 * workspace (Integrations → Your AI providers), on the workspace's own key:
 * g1t hosts no model for it. Each question goes to `-/ask`
 * (routes/workspace/ask.ts) with the page you are on, and the answer
 * streams back.
 *
 * The conversation lives in this browser tab (session storage), so it
 * survives moving between pages and reloading, and goes with the tab.
 * Keeping conversations on the server comes later.
 */

type Setup = AskSetup & { owner: boolean };
type SetupAnswer = { ok: boolean; value?: AskSetup; error?: { message: string }; owner: boolean };

const storageKey = (slug: string) => `g1t:ask:${slug}`;

function load(slug: string) {
  try {
    const kept = sessionStorage.getItem(storageKey(slug));
    return kept ? (JSON.parse(kept) as unknown) : null;
  } catch {
    return null;
  }
}

function save(slug: string, value: unknown) {
  try {
    sessionStorage.setItem(storageKey(slug), JSON.stringify(value));
  } catch {
    // Storage full or blocked: the conversation stays for this page.
  }
}

/**
 * The conversation and what it can do. It belongs to the top bar's button,
 * not the panel, so closing the panel keeps an answer coming.
 */
function useAskConversation(slug: string) {
  const { pathname } = useLocation();
  const [state, dispatch] = useReducer(askReducer, EMPTY_ASK);
  const [draft, setDraft] = useState("");
  const controller = useRef<AbortController | null>(null);
  const restored = useRef(false);

  // The conversation kept in this tab, once; then kept as it changes.
  useEffect(() => {
    if (!restored.current) {
      restored.current = true;
      const kept = load(slug);
      if (kept) dispatch({ type: "restore", state: kept as never });
      return;
    }
    save(slug, state);
  }, [slug, state]);

  // Leaving the workspace stops an answer still coming.
  useEffect(() => () => controller.current?.abort(), []);

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || state.busy) return;
      const messages = history(state.turns, text);
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      dispatch({ type: "ask", question: text, id });
      setDraft("");
      const abort = new AbortController();
      controller.current = abort;
      let ended = false;
      const take = (events: AskEvent[]) => {
        for (const event of events) {
          dispatch({ type: "event", event });
          if (event.type === "done" || event.type === "error") ended = true;
        }
      };
      try {
        const response = await fetch(`/${slug}/-/ask`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/x-ndjson" },
          body: JSON.stringify({ messages, page: askPage(pathname) }),
          signal: abort.signal,
        });
        if (!response.body) throw new Error("no body");
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let rest = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const read = readLines(rest, value);
          rest = read.rest;
          take(read.events);
        }
        take(readLines(rest, "\n").events);
        if (!ended) dispatch({ type: "failed", message: "The answer broke off. Ask again." });
      } catch {
        if (abort.signal.aborted) dispatch({ type: "stop" });
        else dispatch({ type: "failed", message: "Ask could not be reached. Check your connection and ask again." });
      } finally {
        if (controller.current === abort) controller.current = null;
      }
    },
    [pathname, slug, state.busy, state.turns],
  );

  const stop = useCallback(() => {
    controller.current?.abort();
    dispatch({ type: "stop" });
  }, []);

  const fresh = useCallback(() => {
    controller.current?.abort();
    dispatch({ type: "reset" });
    setDraft("");
  }, []);

  return { state, draft, setDraft, ask, stop, fresh };
}

type Conversation = ReturnType<typeof useAskConversation>;

/** The top bar's Ask: the lavender pixel 1 beside its words. Opens the conversation beside the page. */
export function AskButton({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const conversation = useAskConversation(slug);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Hint label="Ask g1t about your work">
        <SheetTrigger asChild>
          <Button variant="soft" size="bar" aria-label="Ask g1t" className="gap-2 max-md:ring-0 lg:px-3">
            <MarkGlyph className="h-3.5" />
            <span className="max-lg:hidden">Ask</span>
          </Button>
        </SheetTrigger>
      </Hint>
      <SheetContent side="right" className="sm:max-w-lg">
        <AskPanel slug={slug} open={open} conversation={conversation} />
      </SheetContent>
    </Sheet>
  );
}

function AskPanel({ slug, open, conversation }: { slug: string; open: boolean; conversation: Conversation }) {
  const { pathname } = useLocation();
  const { state, draft, setDraft, ask, stop } = conversation;
  const [setup, setSetup] = useState<Setup | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // What Ask answers with, each time it opens: an owner may have changed it.
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch(`/${slug}/-/ask`, { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? (response.json() as Promise<SetupAnswer>) : Promise.reject(new Error(String(response.status)))))
      .then((answer) => {
        if (!live) return;
        if (answer.ok && answer.value) {
          setSetup({ ...answer.value, owner: answer.owner });
          setSetupError(null);
        } else setSetupError(answer.error?.message ?? "Ask could not be loaded.");
      })
      .catch(() => live && setSetupError("Ask could not be loaded. Try again in a moment."));
    return () => {
      live = false;
    };
  }, [open, slug]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  // Keep the newest words in view as they come.
  const last = state.turns.at(-1);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [state.turns.length, last?.content.length]);

  const fresh = () => {
    conversation.fresh();
    input.current?.focus();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask(draft);
    }
  };

  const ready = setup != null && setup.problem == null;
  const context: TextContext = useMemo(() => ({ slug, me: null, channels: new Set(), project: null }), [slug]);
  const where = askPage(pathname);

  return (
    <>
      <SheetHeader className="gap-1">
        <SheetTitle className="flex items-center gap-2">
          <MarkGlyph className="h-3.5" />
          Ask g1t
        </SheetTitle>
        <SheetDescription className="sr-only">A conversation with g1t about your work in {slug}.</SheetDescription>
        <div className="flex min-h-6 flex-wrap items-center gap-2 text-xs text-muted">
          {setup == null && !setupError ? (
            <Skeleton className="h-4 w-40" />
          ) : ready ? (
            <span className="truncate">
              Answers with {setup.connection_name} · <span className="font-mono">{setup.model}</span>
            </span>
          ) : (
            <span>Not set up yet</span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {setup?.owner && (
              <Hint label="Choose the provider and model">
                <Button asChild variant="ghost" size="icon-xs" aria-label="Choose the provider and model">
                  <Link to={`/${slug}/-/integrations/models#ask`}>
                    <Settings2 size={14} />
                  </Link>
                </Button>
              </Hint>
            )}
            <Button variant="ghost" size="xs" onClick={fresh} disabled={state.turns.length === 0}>
              <RotateCcw size={13} />
              New conversation
            </Button>
          </span>
        </div>
      </SheetHeader>

      <div className="min-h-0 grow overflow-y-auto px-5 py-4" aria-live="polite" aria-busy={state.busy}>
        {setupError && (
          <Alert tone="danger">
            <AlertDescription className="text-danger">{setupError}</AlertDescription>
          </Alert>
        )}
        {setup && setup.problem && <NotSetUp slug={slug} setup={setup} />}
        {state.turns.length === 0 && ready && <Welcome where={where.repo ? `${where.repo.namespace}/${where.repo.name}` : null} />}
        <ol className="space-y-5">
          {state.turns.map((turn) => (
            <li key={turn.id}>{turn.role === "user" ? <Question turn={turn} /> : <Answer turn={turn} context={context} />}</li>
          ))}
        </ol>
        <div ref={end} />
      </div>

      <form onSubmit={submit} className="border-t border-line px-4 py-3">
        <div className="rounded-lg border border-line bg-bg focus-within:border-accent-dim focus-within:ring-2 focus-within:ring-accent/25">
          <label htmlFor="ask-g1t" className="sr-only">
            Ask g1t
          </label>
          <textarea
            id="ask-g1t"
            ref={input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            maxLength={ASK_MAX_MESSAGE_CHARS}
            disabled={!ready}
            placeholder={ready ? "Ask about this page, a repository, or your work" : "Ask is not set up yet"}
            className="block max-h-48 min-h-14 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm text-fg placeholder:text-faint focus:outline-none disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            <span className="truncate pl-1 text-xs text-faint">
              {where.issue ? `On issue #${where.issue}` : where.pull ? `On pull request #${where.pull}` : where.repo ? `In ${where.repo.name}` : null}
            </span>
            <span className="ml-auto" />
            {state.busy ? (
              <Hint label="Stop the answer">
                <Button type="button" variant="outline" size="icon-sm" onClick={stop} aria-label="Stop">
                  <Square size={12} className="fill-current" />
                </Button>
              </Hint>
            ) : (
              <Hint label="Send (Enter)">
                <Button type="submit" variant="accent" size="icon-sm" disabled={!ready || !draft.trim()} aria-label="Send">
                  <ArrowUp size={15} />
                </Button>
              </Hint>
            )}
          </div>
        </div>
        <p className="mt-2 px-1 text-[0.6875rem] text-faint">
          Answers come from your workspace's own AI provider and can be wrong. Kept in this tab only.
        </p>
      </form>
    </>
  );
}

function NotSetUp({ slug, setup }: { slug: string; setup: Setup }) {
  return (
    <Alert tone="info" className="mb-4">
      <AlertTitle>Ask needs one of your workspace's AI providers</AlertTitle>
      <AlertDescription>
        <p>{setup.problem}</p>
        <p className="mt-2">
          Ask answers with an AI provider your workspace connects, on its own key: g1t hosts no model for it.{" "}
          {setup.owner ? (
            <Link to={`/${slug}/-/integrations/models#ask`} className="text-accent hover:underline">
              Connect a provider and choose it for Ask
            </Link>
          ) : (
            <>Ask an owner of {slug} to connect one and choose it for Ask.</>
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}

function Welcome({ where }: { where: string | null }) {
  return (
    <div className="mb-4 rounded-lg border border-dashed border-line px-4 py-5 text-sm text-muted">
      <p className="font-medium text-fg">Ask about your work</p>
      <p className="mt-1">
        g1t tells the model which page you are on{where ? `, here ${where}` : ""}, and the issue or pull request you are looking at, so you can ask
        about it directly.
      </p>
    </div>
  );
}

function Question({ turn }: { turn: Turn }) {
  return (
    <div className="ml-auto w-fit max-w-[85%] rounded-lg bg-raised px-3 py-2 text-[0.9375rem] leading-[1.55] wrap-break-word whitespace-pre-wrap text-fg">
      {turn.content}
    </div>
  );
}

function Answer({ turn, context }: { turn: Turn; context: TextContext }) {
  const waiting = turn.status === "streaming" && !turn.content;
  return (
    <div className="space-y-2">
      {waiting ? (
        <div className="flex items-center gap-2 text-sm text-muted" role="status">
          <MarkGlyph className="h-3 animate-pulse motion-reduce:animate-none" />
          Thinking…
        </div>
      ) : (
        turn.content && <MessageText body={turn.content} context={context} />
      )}
      {turn.status === "error" && (
        <Alert tone="danger" className="flex items-start gap-2">
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          <span>{turn.error}</span>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-faint">
        {turn.provider && (
          <Badge className="px-1.5 py-0 font-normal">
            {turn.provider} · <span className="font-mono">{turn.model}</span>
          </Badge>
        )}
        {turn.status === "stopped" && <span>Stopped</span>}
        {turn.status === "done" && cutOff(turn) && <span>Cut off at the length limit</span>}
      </div>
    </div>
  );
}
