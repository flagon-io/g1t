/**
 * `useHomeLive`: Home refreshing itself as the workspace moves
 * (lib/home-live.ts says what it shows), and `useArrived`: which rows of
 * a list on it are new, so they come in rather than appear.
 *
 * Besides its projects' changes, Home refreshes when the inbox moves or a
 * notification for this workspace arrives: Where you're needed reads them.
 */
import { useEffect, useRef } from "react";

import { HOME_GAP_MS, type HomeRepo, type Seen, arrivedOf, homeShows } from "./home-live";
import { useNotifySelector } from "./notify-client";
import { useLive } from "./use-repo-live";

export function useHomeLive(slug: string, repos: readonly HomeRepo[]): boolean {
  const { live, nudge } = useLive({ repos, signedIn: true, match: (change) => homeShows(change, repos), gap: HOME_GAP_MS });

  const inbox = useNotifySelector((s) => s.inbox);
  const newest = useNotifySelector((s) => s.recent.find((n) => n.workspace.toLowerCase() === slug)?.id ?? null);
  const before = useRef<{ inbox: number | null; newest: string | null } | null>(null);
  useEffect(() => {
    const was = before.current;
    before.current = { inbox, newest };
    // The first the feed says is where the page started, not a change.
    if (was && ((was.inbox != null && inbox !== was.inbox) || newest !== was.newest)) nudge();
  }, [inbox, newest, nudge]);

  return live;
}

/**
 * The keys of a list's rows that were not on it when it last drew: none
 * on the first draw, nor right after `scope` (the span) changes. The same
 * keys again give the same answer, so a row keeps its entrance for as
 * long as it plays.
 */
export function useArrived(keys: readonly string[], scope = ""): ReadonlySet<string> {
  const last = useRef<{ seen: Seen | null; id: string; arrived: ReadonlySet<string> }>({ seen: null, id: "", arrived: new Set() });
  const id = `${scope}\n${keys.join("\n")}`;
  if (last.current.seen == null || id !== last.current.id) {
    const next = arrivedOf(last.current.seen, scope, keys);
    last.current = { seen: next.seen, id, arrived: next.arrived };
  }
  return last.current.arrived;
}
