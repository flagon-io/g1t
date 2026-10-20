/**
 * Home's summary, on the page: the question goes to the viewer's direct
 * message with @g1t, as Ask's does, and g1t's answer streams into the card
 * over that conversation's live socket. Loaded the first time Summarize is
 * pressed (components/home-ask.tsx), so Home doesn't carry the answer's
 * Markdown and code until then. The answer stays in the direct message, so
 * a follow-up in Ask carries on from it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";

import type { ChatLiveEvent, ChatMessage, Result } from "@g1t/contracts";

import { askPage } from "../lib/ask";
import { answering, applyLive, fromG1t } from "../lib/g1t-chat";
import { type AskedG1t, type SummaryState, summaryAsked, summaryPollMs } from "../lib/home-summary";
import { browserTimeZone } from "../lib/time-zone";
import { useReadWhenShown } from "../lib/use-read-when-shown";
import { G1tAnswer } from "./chat/answer";
import { type LiveState, useChatLive } from "./chat/live";
import { Alert, AlertDescription } from "./ui/alert";
import { Skeleton } from "./ui/skeleton";

/** How long the card waits for an answer before it stops reading. */
const GIVE_UP_MS = 4 * 60_000;

function LiveSocket({
  slug,
  channelId,
  onEvent,
  onReconnect,
  onState,
}: {
  slug: string;
  channelId: string;
  onEvent: (event: ChatLiveEvent) => void;
  onReconnect: () => void;
  onState: (state: LiveState) => void;
}) {
  const { state } = useChatLive(slug, channelId, onEvent, onReconnect);
  useEffect(() => onState(state), [state, onState]);
  return null;
}

/** Asks g1t `question` once, then shows its answer as it streams. `onDone` runs when the answer is finished. */
export default function HomeSummary({ slug, question, onDone }: { slug: string; question: string; onDone?: (channelId: string | null) => void }) {
  const { pathname } = useLocation();
  const [state, setState] = useState<SummaryState>({ step: "asking" });
  const [live, setLive] = useState<LiveState>("connecting");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    // One request: chat checks Ask is set up, opens the direct message with g1t and asks there.
    void (async () => {
      const asked = await fetch(`/${slug}/-/chat/api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "ask_g1t", body: question, page: { ...askPage(pathname), time_zone: browserTimeZone() } }),
      })
        .then((response) => response.json() as Promise<Result<AskedG1t>>)
        .catch(() => null);
      setState(summaryAsked(asked));
    })();
  }, [slug, question, pathname]);

  const channelId = state.step === "answering" ? state.channelId : null;
  const questionId = state.step === "answering" ? state.questionId : null;
  const answer = questionId ? (messages.find((m) => fromG1t(m) && !m.reset && !m.deleted_at && m.id > questionId) ?? null) : null;
  const finished = answer != null && !answering(answer.answer);

  const load = useCallback(async () => {
    if (!channelId) return;
    try {
      const response = await fetch(`/${slug}/-/chat/api?channel=${encodeURIComponent(channelId)}&limit=10`, { headers: { accept: "application/json" } });
      const page = (await response.json()) as Result<{ messages: ChatMessage[] }>;
      if (page.ok) {
        // A frame streamed over the socket is newer than a row still being written: keep the longer body.
        setMessages((now) =>
          page.value.messages.map((m) => {
            const known = now.find((k) => k.id === m.id);
            return known && answering(m.answer) && known.body.length > m.body.length ? known : m;
          }),
        );
      }
    } catch {
      // Read again on the next tick.
    }
  }, [channelId, slug]);

  const onEvent = useCallback(
    (event: ChatLiveEvent) => {
      if (channelId) setMessages((now) => applyLive(now, event, channelId));
    },
    [channelId],
  );

  // Read until the answer is finished: the socket brings it as it streams, this makes sure of it,
  // often while the socket connects, now and then once it is open (and once as it opens).
  const since = useRef<number | null>(null);
  useEffect(() => {
    if (!channelId || finished) return;
    if (since.current == null) since.current = Date.now();
    void load();
    const started = since.current;
    const timer = setInterval(() => {
      if (Date.now() - started > GIVE_UP_MS) clearInterval(timer);
      else void load();
    }, summaryPollMs(live));
    return () => clearInterval(timer);
  }, [channelId, finished, load, live]);

  // Watched here, so read here: the question is the viewer's own, and the
  // answer is marked once it is finished, while the card is in view.
  const card = useRef<HTMLDivElement>(null);
  useReadWhenShown(slug, channelId, finished && answer ? answer.id : null, { target: card });

  const told = useRef(false);
  useEffect(() => {
    if (finished && !told.current) {
      told.current = true;
      onDone?.(channelId);
    }
  }, [finished, channelId, onDone]);

  if (state.step === "problem") {
    return (
      <Alert tone={state.setup ? "info" : "danger"}>
        <AlertDescription>
          {state.message}{" "}
          {state.setup &&
            (state.owner ? (
              <Link to={`/${slug}/-/ai#ask`} className="text-accent hover:underline">
                Connect a provider and choose it for Ask.
              </Link>
            ) : (
              <>Ask an owner of {slug} to connect one.</>
            ))}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div ref={card} aria-live="polite" aria-busy={!finished}>
      {channelId && <LiveSocket slug={slug} channelId={channelId} onEvent={onEvent} onReconnect={() => void load()} onState={setLive} />}
      {answer ? (
        <G1tAnswer message={answer} context={{ slug, repo: null }} />
      ) : (
        <div className="space-y-2.5" aria-label="g1t is reading what happened">
          <p className="text-sm text-muted">Reading what happened…</p>
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3.5 w-5/6" />
        </div>
      )}
    </div>
  );
}
