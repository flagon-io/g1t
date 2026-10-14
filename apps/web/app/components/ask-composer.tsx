import { ArrowUp, Ellipsis, MessageSquare, RotateCcw, Settings2, Square, Trash2 } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router";

import { type AskSetup, type ChatLiveEvent, type ChatMessage, type Result } from "@g1t/contracts";

import { askPage, askWhere } from "../lib/ask";
import { modelLabel } from "../lib/ask-model";
import { browserTimeZone } from "../lib/time-zone";
import { anyAnswering, applyLive, fromG1t, isClearCommand, suggestions } from "../lib/g1t-chat";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "./ai-elements/conversation";
import { Message, MessageContent } from "./ai-elements/message";
import type { ResponseContext } from "./ai-elements/response";
import { Suggestion, Suggestions } from "./ai-elements/suggestion";
import { AskedFrom, G1tAnswer } from "./chat/answer";
import { ClearG1tDialog } from "./chat/clear-g1t";
import { useChatLive } from "./chat/live";
import { MarkGlyph } from "./logo";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Hint } from "./ui/hint";
import { Kbd } from "./ui/kbd";
import { SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";
import { Skeleton } from "./ui/skeleton";
import { Textarea } from "./ui/textarea";

/**
 * Ask g1t: a conversation with g1t about your work, from the top bar. It
 * is your direct message with @g1t in Chat: the same messages, the same
 * answers, whichever you write in. The answers come from the AI provider
 * and model an owner chose for the workspace (Integrations → Your AI
 * providers → Ask g1t), on the workspace's own key: g1t hosts no model.
 *
 * Each question carries the page you are on, which g1t is told. The chat
 * service has g1t answer, and the answer streams into the direct message
 * over its live socket, so it shows here and in Chat at once. The panel
 * shows the current conversation, since the latest "New conversation";
 * everything before it stays in Chat. Clear conversation (the menu, or
 * `/clear`) deletes all of it, here and in Chat, for good.
 */

type Setup = AskSetup & { owner: boolean };
type SetupAnswer = { ok: boolean; value?: AskSetup; error?: { message: string }; owner: boolean };
type Shown = ChatMessage & { pending?: boolean; failed?: boolean };

const channelKey = (slug: string) => `g1t:ask-dm:${slug}`;

function rememberedChannel(slug: string): string | null {
  try {
    return sessionStorage.getItem(channelKey(slug));
  } catch {
    return null;
  }
}

function rememberChannel(slug: string, id: string) {
  try {
    sessionStorage.setItem(channelKey(slug), id);
  } catch {
    // Not kept: it is asked for again next time.
  }
}

async function chatApi<T>(slug: string, body: Record<string, unknown>): Promise<Result<T>> {
  try {
    const response = await fetch(`/${slug}/-/chat/api`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await response.json()) as Result<T>;
  } catch {
    return { ok: false, error: { code: "conflict", message: "g1t could not be reached. Check your connection and try again." } };
  }
}

/** Oldest first, the newest message from each id. */
function byId(list: Shown[]): Shown[] {
  return [...new Map(list.map((m) => [m.id, m])).values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The viewer's direct message with @g1t, as the panel shows it. It belongs
 * to the top bar's button, not the panel, so what was said stays while the
 * panel is closed; the answer itself is kept by chat either way.
 */
function useG1tConversation(slug: string, open: boolean) {
  const [channelId, setChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Shown[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const opening = useRef<Promise<string | null> | null>(null);

  const channel = useCallback(async (): Promise<string | null> => {
    if (channelId) return channelId;
    opening.current ??= (async () => {
      const remembered = rememberedChannel(slug);
      if (remembered) return remembered;
      const opened = await chatApi<{ channel: { id: string } }>(slug, { intent: "g1t_dm" });
      if (!opened.ok) {
        setProblem(opened.error.message);
        return null;
      }
      rememberChannel(slug, opened.value.channel.id);
      return opened.value.channel.id;
    })().finally(() => {
      opening.current = null;
    });
    const id = await opening.current;
    if (id) setChannelId(id);
    return id;
  }, [channelId, slug]);

  const load = useCallback(async () => {
    const id = await channel();
    if (!id) return;
    try {
      const response = await fetch(`/${slug}/-/chat/api?channel=${encodeURIComponent(id)}&limit=60`, { headers: { accept: "application/json" } });
      const page = (await response.json()) as Result<{ messages: ChatMessage[] }>;
      if (page.ok) {
        setMessages((now) => byId([...now.filter((m) => m.pending), ...page.value.messages.filter((m) => !m.deleted_at && !m.thread_root)]));
        setProblem(null);
      } else if (page.error.code === "not_found") {
        // Kept from another session that no longer has it: open it again.
        try {
          sessionStorage.removeItem(channelKey(slug));
        } catch {
          // Nothing kept.
        }
        setChannelId(null);
      } else setProblem(page.error.message);
    } catch {
      setProblem("g1t could not be reached. Check your connection and try again.");
    }
    setLoaded(true);
  }, [channel, slug]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const onEvent = useCallback((event: ChatLiveEvent) => {
    if (!channelId) return;
    setMessages((now) => applyLive(now, event, channelId) as Shown[]);
  }, [channelId]);

  // Read up to the newest message while the panel is open and in view, as
  // the conversation in Chat does: it is the same direct message, so what
  // was read here is not left unread there.
  const lastRead = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !channelId) return;
    const markRead = () => {
      if (document.visibilityState !== "visible") return;
      const newest = [...messages].reverse().find((m) => !m.pending);
      if (!newest || newest.id === lastRead.current) return;
      lastRead.current = newest.id;
      void chatApi(slug, { intent: "read", channel_id: channelId, id: newest.id });
      window.dispatchEvent(new CustomEvent("g1t:chat-read", { detail: channelId }));
    };
    const timer = setTimeout(markRead, 400);
    document.addEventListener("visibilitychange", markRead);
    window.addEventListener("focus", markRead);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", markRead);
      window.removeEventListener("focus", markRead);
    };
  }, [open, channelId, messages, slug]);

  const ask = useCallback(
    async (text: string, pathname: string) => {
      const body = text.trim();
      if (!body) return;
      const id = await channel();
      if (!id) return;
      const pendingId = `~pending-${Date.now().toString(36)}`;
      const pending: Shown = {
        id: pendingId,
        channel_id: id,
        author: { kind: "user", id: "", name: "", display_name: "", avatar: null, role: null },
        kind: "text",
        body,
        card: null,
        thread_root: null,
        reply_count: 0,
        last_reply_at: null,
        created_at: new Date().toISOString(),
        edited_at: null,
        deleted_at: null,
        pending: true,
      };
      setMessages((now) => [...now, pending]);
      const saved = await chatApi<ChatMessage>(slug, { intent: "post", channel_id: id, body, page: { ...askPage(pathname), time_zone: browserTimeZone() } });
      setMessages((now) => (saved.ok ? byId([...now.filter((m) => m.id !== pendingId), saved.value]) : now.map((m) => (m.id === pendingId ? { ...m, failed: true } : m))));
      // The answer arrives over the socket; should it have opened late, ask once more.
      if (saved.ok) setTimeout(() => void load(), 1_500);
    },
    [channel, slug, load],
  );

  const act = useCallback(
    async (intent: "g1t_stop" | "g1t_reset" | "g1t_retry") => {
      const id = await channel();
      if (!id) return;
      const done = await chatApi<ChatMessage | null>(slug, { intent, channel_id: id });
      if (!done.ok) setProblem(done.error.message);
      else if (intent === "g1t_reset" && done.value) setMessages((now) => byId([...now, done.value as ChatMessage]));
    },
    [channel, slug],
  );

  /** Deletes the whole conversation for good (the chat service's `g1t_clear`): null when done, else why not. */
  const clear = useCallback(async (): Promise<string | null> => {
    const id = await channel();
    if (!id) return "g1t could not be reached. Check your connection and try again.";
    const done = await chatApi<{ cleared: number }>(slug, { intent: "g1t_clear", channel_id: id });
    if (!done.ok) return done.error.message;
    setMessages([]);
    setProblem(null);
    return null;
  }, [channel, slug]);

  return { channelId, messages, loaded, problem, ask, act, clear, load, onEvent };
}

type G1tConversation = ReturnType<typeof useG1tConversation>;

/**
 * The Ask panel's sheet (components/ask-button.tsx loads it the first time
 * the top bar's Ask opens, so pages don't carry it until then): the
 * conversation, kept while the panel is closed.
 */
export function AskSheet({ slug, open }: { slug: string; open: boolean }) {
  const conversation = useG1tConversation(slug, open);
  const busy = anyAnswering(conversation.messages);
  return (
    <SheetContent
      side="right"
      className="sm:max-w-xl"
      // Esc stops an answer still coming first; pressed again, it closes the panel.
      onEscapeKeyDown={(event) => {
        if (!busy) return;
        event.preventDefault();
        void conversation.act("g1t_stop");
      }}
    >
      <AskPanel slug={slug} open={open} conversation={conversation} />
    </SheetContent>
  );
}

/** The live socket of the direct message, while the panel is open. */
function LiveSocket({ slug, channelId, onEvent, onReconnect }: { slug: string; channelId: string; onEvent: (event: ChatLiveEvent) => void; onReconnect: () => void }) {
  useChatLive(slug, channelId, onEvent, onReconnect);
  return null;
}

function AskPanel({ slug, open, conversation }: { slug: string; open: boolean; conversation: G1tConversation }) {
  const { pathname } = useLocation();
  const { channelId, messages, loaded, problem, ask, act, clear, load, onEvent } = conversation;
  const [clearing, setClearing] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
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

  // ⌘K or Ctrl+K, while the panel is open, goes to its box rather than the command palette.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopImmediatePropagation();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open]);

  // The current conversation: what came after the latest "New conversation".
  const shown = useMemo(() => {
    let start = 0;
    messages.forEach((m, index) => {
      if (m.reset && fromG1t(m)) start = index + 1;
    });
    return messages.slice(start);
  }, [messages]);
  const earlier = shown.length < messages.length;
  const busy = anyAnswering(messages);
  const ready = setup != null && setup.problem == null;
  const where = askPage(pathname);
  const lastAnswer = [...shown].reverse().find((m) => !m.pending);
  const context = useMemo<ResponseContext>(() => ({ slug, repo: where.repo ?? null }), [slug, where.repo?.namespace, where.repo?.name]);

  const send = (text: string) => {
    // `/clear` asks to clear the conversation; it is never sent to g1t.
    if (isClearCommand(text)) {
      setDraft("");
      setClearing(true);
      return;
    }
    if (!ready || busy || !text.trim()) return;
    setDraft("");
    void ask(text, pathname);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(draft);
    }
  };
  const fresh = () => {
    void act("g1t_reset");
    input.current?.focus();
  };

  return (
    <>
      {open && channelId && <LiveSocket slug={slug} channelId={channelId} onEvent={onEvent} onReconnect={() => void load()} />}
      <SheetHeader className="gap-1 border-b border-line pb-3">
        <SheetTitle className="flex items-center gap-2">
          <MarkGlyph className="h-3.5" />
          Ask g1t
        </SheetTitle>
        <SheetDescription className="sr-only">A conversation with g1t about your work in {slug}. It is your direct message with g1t in Chat.</SheetDescription>
        <div className="flex min-h-7 flex-wrap items-center gap-2 text-xs text-muted">
          {setup == null && !setupError ? (
            <Skeleton className="h-4 w-40" />
          ) : ready ? (
            <span className="min-w-0 truncate">
              Answers with {setup.provider_name} · <span className="font-mono">{modelLabel(setup)}</span>
            </span>
          ) : (
            <span>Not set up yet</span>
          )}
          <span className="ml-auto flex items-center gap-0.5">
            {setup?.owner && (
              <Hint label="Choose the provider and model">
                <Button asChild variant="ghost" size="icon-xs" aria-label="Choose the provider and model">
                  <Link to={`/${slug}/-/ai#ask`}>
                    <Settings2 size={14} />
                  </Link>
                </Button>
              </Hint>
            )}
            {channelId && (
              <Hint label="Open this conversation in Chat">
                <Button asChild variant="ghost" size="icon-xs" aria-label="Open in Chat">
                  <Link to={`/${slug}/-/chat/dm/${channelId}`}>
                    <MessageSquare size={14} />
                  </Link>
                </Button>
              </Hint>
            )}
            <Hint label="New conversation: g1t reads only what comes next">
              <Button variant="ghost" size="xs" onClick={fresh} disabled={shown.length === 0}>
                <RotateCcw size={13} />
                New conversation
              </Button>
            </Hint>
            <DropdownMenu>
              <Hint label="More">
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label="More">
                    <Ellipsis size={14} />
                  </Button>
                </DropdownMenuTrigger>
              </Hint>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" disabled={messages.length === 0} onSelect={() => setClearing(true)}>
                  <Trash2 />
                  Clear conversation…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      </SheetHeader>

      <Conversation aria-busy={busy}>
        <ConversationContent>
          {setupError && (
            <Alert tone="danger">
              <AlertDescription className="text-danger">{setupError}</AlertDescription>
            </Alert>
          )}
          {problem && (
            <Alert tone="danger">
              <AlertDescription className="text-danger">{problem}</AlertDescription>
            </Alert>
          )}
          {setup && setup.problem && <NotSetUp slug={slug} setup={setup} />}
          {earlier && channelId && (
            <p className="text-center text-xs text-faint">
              Earlier conversations are in{" "}
              <Link to={`/${slug}/-/chat/dm/${channelId}`} className="text-accent hover:underline">
                your direct message with g1t
              </Link>
              .
            </p>
          )}
          {!loaded && open ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="ml-auto h-9 w-2/3 rounded-2xl" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : shown.length === 0 && ready ? (
            <ConversationEmptyState className="pt-16">
              <MarkGlyph className="h-7" />
              <div className="space-y-1">
                <h3 className="text-base font-semibold text-fg">Ask about your work</h3>
                <p className="max-w-sm text-sm text-muted">
                  {where.repo
                    ? `g1t is told you're in ${where.repo.namespace}/${where.repo.name}${where.issue ? `, on issue #${where.issue}` : where.pull ? `, on pull request #${where.pull}` : ""}.`
                    : "g1t is told which page you're on, and reads the issue or pull request in front of you."}
                </p>
              </div>
              <Suggestions className="mt-3 max-w-md justify-center">
                {suggestions(where).map((text) => (
                  <Suggestion key={text} suggestion={text} onPick={send} />
                ))}
              </Suggestions>
            </ConversationEmptyState>
          ) : (
            shown.map((m) =>
              fromG1t(m) ? (
                m.reset ? null : (
                  <Message key={m.id} from="assistant">
                    <G1tAnswer message={m} context={context} onRetry={!busy && lastAnswer?.id === m.id ? () => void act("g1t_retry") : undefined} />
                  </Message>
                )
              ) : (
                <Message key={m.id} from="user">
                  <MessageContent className={m.pending && !m.failed ? "opacity-70" : undefined}>{m.body}</MessageContent>
                  <AskedFrom page={m.page} />
                  {m.failed && <span className="text-xs text-danger">Not sent. Ask again.</span>}
                </Message>
              ),
            )
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <form onSubmit={submit} className="border-t border-line px-4 pt-3 pb-3">
        <div className="rounded-xl border border-line bg-bg transition-shadow focus-within:border-accent-dim focus-within:ring-2 focus-within:ring-accent/25">
          <label htmlFor="ask-g1t" className="sr-only">
            Ask g1t
          </label>
          <Textarea
            id="ask-g1t"
            ref={input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            maxLength={16_000}
            disabled={!ready}
            placeholder={ready ? "Ask about this page, a repository, or your work" : "Ask is not set up yet"}
            className="max-h-48 min-h-14 resize-none border-0 bg-transparent px-3 pt-2.5 pb-1 shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            <span className="truncate pl-1 text-xs text-faint">{askWhere(where)}</span>
            <span className="ml-auto" />
            {busy ? (
              <Hint label="Stop the answer (Esc)">
                <Button type="button" variant="outline" size="icon-sm" onClick={() => void act("g1t_stop")} aria-label="Stop">
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
        <p className="mt-2 px-1 text-[0.6875rem] leading-relaxed text-faint">
          Answers come from your workspace&apos;s own AI provider and can be wrong. Kept in your direct message with g1t until you clear it.{" "}
          <span className="whitespace-nowrap max-sm:hidden">
            <Kbd>Shift</Kbd> <Kbd>Enter</Kbd> for a new line.
          </span>
        </p>
      </form>
      <ClearG1tDialog
        open={clearing}
        onOpenChange={(next) => {
          setClearing(next);
          if (!next) requestAnimationFrame(() => input.current?.focus());
        }}
        onClear={clear}
      />
    </>
  );
}

function NotSetUp({ slug, setup }: { slug: string; setup: Setup }) {
  return (
    <Alert tone="info">
      <AlertTitle>Ask needs one of your workspace&apos;s AI providers</AlertTitle>
      <AlertDescription>
        <p>{setup.problem}</p>
        <p className="mt-2">
          Ask answers with an AI provider your workspace connects, on its own key: g1t hosts no model for it.{" "}
          {setup.owner ? (
            // Following it closes the panel, so the page it opens is not behind it.
            <SheetClose asChild>
              <Link to={`/${slug}/-/ai#ask`} className="text-accent hover:underline">
                Connect a provider and choose it for Ask
              </Link>
            </SheetClose>
          ) : (
            <>Ask an owner of {slug} to connect one and choose it for Ask.</>
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}
