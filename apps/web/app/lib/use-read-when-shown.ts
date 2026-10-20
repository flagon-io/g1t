import { type RefObject, useEffect, useRef, useState } from "react";

import { readNow, showConversation } from "./read-when-shown";

/**
 * Marks a conversation read up to `newestId` once its messages were seen
 * here: the page visible, the messages on screen (`target` in view, when
 * given; `active` false while the surface is closed), each newest id once.
 * It sends chat's `read`, which moves the read mark for every tab and
 * device, and fires `g1t:chat-read` so this tab's counts drop at once.
 * While on screen the conversation counts as shown, so its toasts, sounds
 * and system notifications stay quiet (lib/read-when-shown.ts).
 */
export function useReadWhenShown(
  slug: string,
  channelId: string | null,
  newestId: string | null,
  options: { target?: RefObject<Element | null>; active?: boolean } = {},
): void {
  const { target, active = true } = options;
  const [inView, setInView] = useState(!target);

  useEffect(() => {
    const element = target?.current;
    if (!target || !element) return;
    if (typeof IntersectionObserver === "undefined") return setInView(true);
    const observer = new IntersectionObserver(([entry]) => setInView(!!entry?.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  }, [target, active, channelId]);

  const onScreen = active && inView;

  // Shown while on screen: what arrives for it here is not news.
  useEffect(() => {
    if (!channelId || !onScreen) return;
    return showConversation(channelId);
  }, [channelId, onScreen]);

  const lastRead = useRef<{ channel: string | null; id: string | null }>({ channel: null, id: null });
  useEffect(() => {
    if (!channelId || !onScreen) return;
    if (lastRead.current.channel !== channelId) lastRead.current = { channel: channelId, id: null };
    const markRead = () => {
      const id = readNow({ visible: document.visibilityState === "visible", onScreen, newestId, lastRead: lastRead.current.id });
      if (!id) return;
      lastRead.current.id = id;
      void fetch(`/${slug}/-/chat/api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "read", channel_id: channelId, id }),
      }).catch(() => {
        // Not marked: the next time it is shown tries again.
        if (lastRead.current.id === id) lastRead.current.id = null;
      });
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
  }, [slug, channelId, newestId, onScreen]);
}
