/**
 * Agent sessions in Recents, Chat's sidebar (components/chat/sidebar.tsx):
 * reading the viewer's (`-/recents.json`) off the layout, the way the
 * sidebar reads itself, and drawing one as a row beside the direct
 * messages: a status dot, its title, and what it runs in.
 */
import { useCallback, useEffect, useRef } from "react";
import { NavLink, useFetcher } from "react-router";

import type { RecentsData } from "../../routes/workspace/recents-json";
import { HarnessMark } from "../sessions";
import { Hint } from "../ui/hint";
import { cn } from "../../lib/cn";
import { harnessName } from "../../lib/coordination";
import { onRepoChanges, useNotifySelector } from "../../lib/notify-client";
import type { RecentSession, RecentStatus } from "../../lib/recents";
import { APPROVAL_ANSWERED_EVENT } from "../../lib/session-approvals";
import { sessionPath } from "../../lib/work-items";

/** Recents' own fetcher, one per workspace, so switching workspaces never shows another's sessions. */
export function recentsFetcher(slug: string): string {
  return `chat-recents:${slug.toLowerCase()}`;
}

/** However many sessions start, stop or move at once, Recents reads again at most this often for them. */
const SESSION_CHANGES_MS = 5_000;

/**
 * The viewer's recent agent sessions in the workspace `slug`, with their
 * status, or null until read (and when they could not be). Read when the
 * sidebar is drawn and again when the window comes back into view, when a
 * notification arrives over the live feed (a call that starts waiting
 * tells its starter), when a session starts, goes on or ends in a
 * repository this tab watches, and once a call is answered here. No
 * polling. `enabled` off (a guest) reads nothing.
 */
export function useRecentSessions(slug: string, enabled: boolean): RecentSession[] | null {
  const fetcher = useFetcher<RecentsData>({ key: recentsFetcher(slug) });
  const load = useCallback(() => {
    if (enabled && document.visibilityState === "visible") fetcher.load(`/${encodeURIComponent(slug)}/-/recents.json`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, enabled]);
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    window.addEventListener(APPROVAL_ANSWERED_EVENT, load);
    return () => {
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
      window.removeEventListener(APPROVAL_ANSWERED_EVENT, load);
    };
  }, [load]);
  // The newest notification the feed has sent: a new one reads again.
  const latest = useNotifySelector((state) => state.recent[0]?.id ?? null);
  const seen = useRef(latest);
  useEffect(() => {
    if (latest === seen.current) return;
    seen.current = latest;
    load();
  }, [latest, load]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = onRepoChanges((changes) => {
      if (timer || !changes.some((change) => change.kind.startsWith("session."))) return;
      timer = setTimeout(() => {
        timer = null;
        load();
      }, SESSION_CHANGES_MS);
    });
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [load]);
  return enabled ? (fetcher.data?.sessions ?? null) : null;
}

const STATUS: Record<RecentStatus, { label: string; dot: string }> = {
  working: { label: "Working", dot: "bg-success" },
  waiting: { label: "Waiting on you", dot: "bg-warn" },
  idle: { label: "Idle", dot: "bg-line-strong" },
  ended: { label: "Ended", dot: "bg-transparent ring-1 ring-inset ring-line-strong" },
};

/** A session's status as a dot: green and breathing while it works, amber while it waits on you, grey when idle, hollow once ended. */
export function RecentDot({ status }: { status: RecentStatus }) {
  const { label, dot } = STATUS[status];
  return (
    <span className="relative flex size-2 shrink-0" role="img" aria-label={label}>
      {status === "working" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-50 motion-reduce:hidden" />}
      <span className={cn("relative inline-flex size-2 rounded-full", dot)} />
    </span>
  );
}

/**
 * One agent session in Recents: what it runs in, its title, and its status
 * dot, opening its page. Waiting on you reads as unread does.
 */
export function RecentSessionRow({ session, slug, pathname, rowClass }: { session: RecentSession; slug: string; pathname: string; rowClass: string }) {
  const to = sessionPath(slug, session.id);
  const current = pathname === to;
  const waiting = session.status === "waiting";
  const runs = harnessName(session.harness) ?? "Agent session";
  return (
    <li>
      <NavLink
        to={to}
        aria-current={current ? "page" : undefined}
        className={`${rowClass} ${
          current
            ? "bg-sidebar-accent text-fg"
            : waiting
              ? "text-fg hover:bg-sidebar-accent/60"
              : session.status === "ended"
                ? "text-faint hover:bg-sidebar-accent/60 hover:text-muted"
                : "text-muted hover:bg-sidebar-accent/60 hover:text-fg"
        }`}
      >
        <Hint label={runs}>
          <span className="flex w-4.5 shrink-0 justify-center">
            <HarnessMark session={session} size={14} />
          </span>
        </Hint>
        <span className={`min-w-0 grow truncate ${waiting ? "font-semibold" : current ? "font-medium" : ""}`}>{session.title}</span>
        <Hint label={STATUS[session.status].label}>
          <span className="flex size-5 shrink-0 items-center justify-center">
            <RecentDot status={session.status} />
          </span>
        </Hint>
      </NavLink>
    </li>
  );
}
