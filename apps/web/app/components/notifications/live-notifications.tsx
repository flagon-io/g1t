import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";

import { applyAttention, refreshPush, reportInbox, setNavigator, setViewing, startFeed, useLiveBadges } from "../../lib/notify-client";
import { Toaster } from "./toaster";

/**
 * Live notifications for the signed-in person, on every page: the feed
 * socket (lib/notify-client.ts), the toasts, the count in the tab's title
 * and on the app icon. Mounted once, in root.tsx.
 *
 * `workspace` is the one the page is in, whose counts the feed reads on
 * connect; `inbox` the inbox count the page's data last read, handed to
 * the feed so every tab shows it.
 */
export function LiveNotifications({ workspace, inbox }: { workspace: string | null; inbox: number | null }) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const badges = useLiveBadges(workspace);

  useEffect(() => {
    setNavigator((href) => navigate(href));
    return () => setNavigator(null);
  }, [navigate]);

  useEffect(() => startFeed(workspace), [workspace]);

  useEffect(() => setViewing({ path: pathname + search }), [pathname, search]);

  // The inbox as the page just read it (after marking items, say).
  useEffect(() => {
    if (inbox != null) reportInbox(inbox);
  }, [inbox]);

  // "(3) Chat · g1t": kept on whatever title each page sets.
  useEffect(() => {
    applyAttention(badges);
    const head = document.querySelector("head");
    if (!head) return;
    const observer = new MutationObserver(() => applyAttention(badges));
    observer.observe(head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [badges?.chat, badges?.mentions, badges?.inbox]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pushes keep arriving for someone who turned them on; a click on one
  // with g1t open moves the tab there.
  useEffect(() => {
    const idle = window.setTimeout(() => void refreshPush().catch(() => {}), 3_000);
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "g1t:navigate" && typeof event.data.href === "string" && event.data.href.startsWith("/")) navigate(event.data.href);
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      window.clearTimeout(idle);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [navigate]);

  return <Toaster />;
}
