/**
 * `useSessionFollow`: a running hosted session's page following it as it
 * goes. While the session runs and the tab is in view, the page asks
 * `-/chat/sessions/:id/follow` every `FOLLOW_POLL_MS`; the integrations
 * service reads the session from Anthropic at most once every
 * `FOLLOW_EVERY_MS` however many pages ask, and says how far it was read.
 * When that changes, the page's loader runs again and the new entries
 * show. A tab out of view asks nothing, and asks at once when it comes
 * back; a session that ended is asked no more.
 *
 * Why polling and not a push: the session's events are on the workspace's
 * Anthropic account, which g1t only reads, so someone has to read it, and
 * a page that is looking is the right one to say when. The read is claimed
 * per session, so ten viewers cost what one does at the provider; each
 * viewer's ask is a small request to g1t.
 */
import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import type { AgentSessionFollowed } from "@g1t/contracts";

/** How often a page in view asks while the session runs. */
export const FOLLOW_POLL_MS = 2500;

/** How often g1t's card for a session in a conversation asks how it stands, while it runs and is in view. */
const CARD_POLL_MS = 10_000;

/**
 * Where a hosted session g1t's card links to stands now (chat's
 * `g1t_session` card: kind `session`, its id in `ref`, its repository in
 * the Repository field): `Working` or `Done`, asked on the same follow
 * route as its page, every `CARD_POLL_MS` while it runs and the tab is in
 * view. Null for any other card, or until it is known.
 */
export function useHostedSessionState(slug: string, card: { kind: string; ref?: string | null; fields?: { label: string; value: string }[] }): string | null {
  const id = card.kind === "session" && /^ses_[0-9a-z]+$/.test(card.ref ?? "") ? card.ref! : null;
  const repo = card.fields?.find((field) => field.label === "Repository")?.value ?? null;
  const [state, setState] = useState<string | null>(null);
  useEffect(() => {
    if (!id || !repo) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch(`/${slug}/-/chat/sessions/${encodeURIComponent(id)}/follow?repo=${encodeURIComponent(repo)}`, {
            headers: { accept: "application/json" },
          });
          if (response.ok) {
            const followed = (await response.json()) as AgentSessionFollowed;
            setState(followed.running ? "Working" : "Done");
            if (!followed.running) stopped = true;
          }
        } catch {
          // Asked again next time.
        }
      }
      if (!stopped) timer = setTimeout(() => void ask(), CARD_POLL_MS);
    };
    void ask();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [slug, id, repo]);
  return state;
}

export function useSessionFollow({
  url,
  running,
  mark: loaded,
  enabled = true,
}: {
  url: string;
  running: boolean;
  /** How far the page's own data read it (its loader's `follow_agent_session`), when it said. */
  mark: string | null;
  enabled?: boolean;
}) {
  const revalidator = useRevalidator();
  const mark = useRef<string | null>(loaded);
  // Each time the page reads itself, it is as far as its loader read.
  useEffect(() => {
    if (loaded !== null) mark.current = loaded;
  }, [loaded]);
  const busy = useRef(false);
  const state = useRef(revalidator.state);
  state.current = revalidator.state;
  useEffect(() => {
    if (!enabled || !running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      if (stopped || busy.current || document.visibilityState !== "visible") return;
      busy.current = true;
      try {
        const response = await fetch(url, { headers: { accept: "application/json" } });
        if (!response.ok) return;
        const followed = (await response.json()) as AgentSessionFollowed;
        const before = mark.current;
        mark.current = followed.mark;
        // Without a mark of its own, the page's first answer only says how far it is.
        if ((before !== null && before !== followed.mark) || !followed.running) {
          if (state.current === "idle") void revalidator.revalidate();
        }
        if (!followed.running) stopped = true;
      } catch {
        // A blip: the next ask tries again.
      } finally {
        busy.current = false;
      }
    };
    const loop = () => {
      if (stopped) return;
      timer = setTimeout(async () => {
        await ask();
        loop();
      }, FOLLOW_POLL_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void ask();
    };
    void ask();
    loop();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the revalidator changes every render
  }, [url, running, enabled]);
}
