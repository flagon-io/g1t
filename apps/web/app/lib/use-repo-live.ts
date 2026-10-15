/**
 * `useRepoLive`: a repository page that refreshes itself as the
 * repository changes (lib/repo-live.ts says which changes each page
 * cares about, and when it may refresh).
 *
 * Signed in, the tab watches the repository over its live socket: the
 * site checks the person may read it (`/-/notify`, `watch_repo`), then
 * every change there arrives as it happens, and the page's loader runs
 * again a second after the last matching one, at most every two seconds.
 * Never under someone typing on the page or with a dialog open (it waits
 * until they are done), and never for a tab out of view: it catches up
 * once when the tab comes back. Signed out, or while the
 * socket is down, the page refreshes when the tab comes back into view
 * (at most every 30 s) and once a minute while it is in view.
 *
 * `useLive` is the same for a page over several repositories (Home,
 * the workspace's): one `watch_repos` asks for them all.
 *
 * Browser-only work happens in effects; on the server the hook does
 * nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigation, useRevalidator, useRouteLoaderData } from "react-router";

import { onRepoChanges, useFeedConnected } from "./notify-client";
import {
  FALLBACK_FOCUS_MS,
  LIVE_DEBOUNCE_MS,
  REWATCH_MS,
  type GateState,
  type RepoChange,
  type RepoMatch,
  atBottom,
  fallbackDue,
  gate,
  isTyping,
} from "./repo-live";

/** What the project layout's loader gives every page under it (routes/repo/layout.tsx). */
type LayoutData = { repo?: { id: string; namespace: string; name: string }; signedIn?: boolean };

export type RepoLiveOptions = {
  /** Which changes refresh the page. */
  match: RepoMatch;
  /**
   * Changes held back for the reader instead (the Commits page's "N new
   * commits"): `held` lists them, and `show` refreshes. While any are held,
   * other changes wait with them, so nothing moves under the reader.
   */
  hold?: RepoMatch;
  /** A reader at the bottom of the page stays there as new items arrive (a pull request's timeline). */
  followBottom?: boolean;
  /** Off: nothing is heard and nothing refreshes (a page that cannot change). */
  enabled?: boolean;
};

export type RepoLive = {
  /** Whether changes arrive as they happen (signed in, socket up, watching). */
  live: boolean;
  /** Changes held back by `hold`, oldest first. */
  held: RepoChange[];
  /** Shows what was held: the page refreshes now. */
  show: () => void;
};

/** A repository a live page watches: its id, as changes name it, and its `owner/name`, as it is asked for. */
export type WatchedRepo = { id: string; path: string };

export type LiveOptions = RepoLiveOptions & {
  /** The repositories whose changes the page hears. */
  repos: readonly WatchedRepo[];
  /** Whether the viewer is signed in: only then is there a socket to hear on. */
  signedIn: boolean;
  /** However many changes arrive, the page refreshes at most this often (LIVE_MIN_GAP_MS). */
  gap?: number;
};

export type Live = RepoLive & {
  /** Something outside the repositories changed (the inbox, on Home): refresh as a change would. */
  nudge: () => void;
};

// ── Watching ─────────────────────────────────────────────────────────────

/** When each repository was last asked for, by `owner/name`, so pages and reconnects ask once. */
const asked = new Map<string, number>();
/** Asking again sooner than this is the same ask. */
const ASK_AGAIN_MS = 5000;

/** Asks to hear `paths`, one request for them all; true when any is watched. */
async function watchRepos(paths: readonly string[], force: boolean): Promise<boolean> {
  const now = Date.now();
  const due = paths.filter((path) => {
    const last = asked.get(path);
    return force || last == null || now - last >= ASK_AGAIN_MS;
  });
  if (due.length === 0) return true;
  for (const path of due) asked.set(path, now);
  try {
    const answer = await fetch("/-/notify", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(due.length === 1 ? { intent: "watch_repo", repo: due[0] } : { intent: "watch_repos", repos: due }),
    });
    if (!answer.ok) throw new Error(`status ${answer.status}`);
    const body = (await answer.json().catch(() => null)) as { ok?: unknown } | null;
    if (body?.ok !== true) throw new Error("refused");
    return true;
  } catch {
    for (const path of due) asked.delete(path);
    return false;
  }
}

// ── The page ─────────────────────────────────────────────────────────────

/** Someone typing on the page, or a dialog (or a popover) open over it. */
function busyNow(): boolean {
  if (typeof document === "undefined") return false;
  const focused = document.activeElement as (HTMLElement & { type?: string; readOnly?: boolean; disabled?: boolean }) | null;
  if (isTyping(focused && focused !== document.body ? focused : null)) return true;
  return document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') != null;
}

function visibleNow(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function pageAtBottom(): boolean {
  const root = document.documentElement;
  return atBottom({ top: window.scrollY, height: root.scrollHeight, viewport: window.innerHeight });
}

export function useRepoLive(options: RepoLiveOptions): RepoLive {
  const layout = useRouteLoaderData("routes/repo/layout") as LayoutData | undefined;
  const repo = layout?.repo ?? null;
  const repos = repo ? [{ id: repo.id, path: `${repo.namespace}/${repo.name}` }] : [];
  const { live, held, show } = useLive({ ...options, enabled: options.enabled !== false && !!repo, repos, signedIn: layout?.signedIn === true });
  return { live, held, show };
}

/**
 * A page that refreshes itself as any of `repos` changes (Home watches
 * the workspace's): `useRepoLive` for a page with no repository layout.
 */
export function useLive(options: LiveOptions): Live {
  const { repos, signedIn } = options;
  // With no repositories there is nothing to hear: the page refreshes as it would without the socket.
  const enabled = options.enabled !== false;
  // One string for the effects: the same repositories are the same watch.
  const paths = repos.map((repo) => repo.path).join(" ");
  const ids = repos.map((repo) => repo.id).join(" ");

  const connected = useFeedConnected();
  const [watching, setWatching] = useState(false);
  const live = enabled && signedIn && connected && watching;

  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const { pathname, search } = useLocation();
  const [held, setHeld] = useState<RepoChange[]>([]);

  // What the timers read: always the latest, without starting them again.
  const latest = useRef({ options, revalidator, navigating: false, live });
  latest.current = { options, revalidator, navigating: navigation.state !== "idle" || revalidator.state !== "idle", live };
  const state = useRef<GateState>({ pendingSince: null, lastChangeAt: null, lastRunAt: null });
  const heldCount = useRef(0);
  heldCount.current = held.length;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const follow = useRef(false);

  const run = useCallback(() => {
    const now = Date.now();
    state.current = { pendingSince: null, lastChangeAt: null, lastRunAt: now };
    follow.current = !!latest.current.options.followBottom && pageAtBottom();
    latest.current.revalidator.revalidate();
  }, []);

  /** Refreshes when the rules allow, or looks again when they say. */
  const check = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const decision = gate(state.current, { now: Date.now(), visible: visibleNow(), busy: busyNow(), navigating: latest.current.navigating, gap: latest.current.options.gap });
    if (decision.action === "run") run();
    else if (decision.action === "wait") timer.current = setTimeout(check, decision.ms);
    // "hold": out of view; coming back into view (`back` below) asks again.
  }, [run]);

  /** Something to refresh for: `now` skips the second's wait for more. */
  const queue = useCallback(
    (now = false) => {
      const at = Date.now();
      const s = state.current;
      state.current = { ...s, pendingSince: s.pendingSince ?? at, lastChangeAt: now ? at - LIVE_DEBOUNCE_MS : at };
      check();
    },
    [check],
  );

  // Watching the repositories: on opening the page, whenever the socket
  // (re)connects, and before the watch runs out.
  useEffect(() => {
    if (!enabled || !signedIn || !connected || !paths) {
      setWatching(false);
      return;
    }
    let cancelled = false;
    const ask = (force: boolean) =>
      void watchRepos(paths.split(" "), force).then((ok) => {
        if (!cancelled) setWatching(ok);
      });
    ask(true);
    const renew = setInterval(() => ask(true), REWATCH_MS);
    return () => {
      cancelled = true;
      clearInterval(renew);
    };
  }, [enabled, signedIn, connected, paths]);

  // Changes as they arrive.
  useEffect(() => {
    if (!enabled || !ids) return;
    const watched = new Set(ids.split(" "));
    return onRepoChanges((changes) => {
      const { match, hold } = latest.current.options;
      const mine = changes.filter((change) => watched.has(change.repo_id));
      const holding = hold ? mine.filter((change) => hold(change)) : [];
      const matched = mine.filter((change) => !holding.includes(change) && match(change));
      if (holding.length) setHeld((before) => [...before, ...holding]);
      // While something is held, the rest waits with it: shown together.
      if (matched.length && !holding.length && heldCount.current === 0) queue();
    });
  }, [enabled, ids, queue]);

  // Another branch or page: what was held is no longer about it.
  useEffect(() => {
    setHeld([]);
  }, [pathname, search]);

  // Back into view: whatever waited goes now; without the socket, the page
  // refreshes itself (at most every 30 s), and once a minute while in view.
  useEffect(() => {
    if (!enabled) return;
    const fallback = (reason: "focus" | "poll") => {
      if (fallbackDue({ live: latest.current.live, visible: visibleNow(), now: Date.now(), lastRunAt: state.current.lastRunAt ?? null, reason })) queue(true);
    };
    const back = () => {
      if (!visibleNow()) return;
      if (state.current.pendingSince != null) check();
      fallback("focus");
    };
    // Starts counting from the page's own load.
    if (state.current.lastRunAt == null) state.current = { ...state.current, lastRunAt: Date.now() };
    const poll = setInterval(() => fallback("poll"), FALLBACK_FOCUS_MS / 2);
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    // Someone stopped typing, or closed a dialog: what waited goes.
    const settled = () => {
      if (state.current.pendingSince != null) setTimeout(check, 0);
    };
    document.addEventListener("focusout", settled);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
      document.removeEventListener("focusout", settled);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [enabled, check, queue]);

  // A reader who was at the bottom follows what was added there.
  useEffect(() => {
    if (revalidator.state !== "idle" || !follow.current) return;
    follow.current = false;
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }));
  }, [revalidator.state]);

  const show = useCallback(() => {
    setHeld([]);
    run();
  }, [run]);

  const nudge = useCallback(() => {
    if (enabled && heldCount.current === 0) queue();
  }, [enabled, queue]);

  return { live, held, show, nudge };
}
