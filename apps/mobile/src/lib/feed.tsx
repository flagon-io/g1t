import type { ChatSidebar, FeedEvent, FeedNotification, Presence } from "@g1t/contracts";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import { usePathname } from "expo-router";
import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { chatKeys } from "./chat";
import { openSocket } from "./live";
import { useSignedIn } from "./session";
import { viewing } from "./viewing";

/**
 * The person's feed, while the app is in front: the same socket every tab
 * of the site keeps open (`/-/live?workspace=<slug>`, services/notify).
 * It brings unread counts as they move, notifications as they happen (a
 * banner unless the conversation is open), and who is online. The app
 * says it is focused, so g1t pushes nothing to the phone while it is in
 * use; in the background the socket closes and pushes take over.
 */

type FeedState = {
  /** Unread in Chat, leaving out muted conversations; mentions apart. */
  unread: number;
  mentions: number;
  /** A notification to show as a banner, until it is dismissed. */
  banner: FeedNotification | null;
  dismiss: () => void;
  presence: Map<string, Presence>;
};

const FeedContext = createContext<FeedState>({ unread: 0, mentions: 0, banner: null, dismiss: () => {}, presence: new Map() });

export function FeedProvider({ children }: { children: ReactNode }) {
  const { client, workspace } = useSignedIn();
  const queries = useQueryClient();
  const slug = workspace?.slug ?? "";
  const path = usePathname();
  const [active, setActive] = useState(AppState.currentState === "active");
  const [counts, setCounts] = useState({ unread: 0, mentions: 0 });
  const [banner, setBanner] = useState<FeedNotification | null>(null);
  const [presence, setPresence] = useState<Map<string, Presence>>(new Map());
  const sendRef = useRef<((frame: unknown) => void) | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      // Say so before the socket closes: a phone can freeze it rather than close
      // it, and g1t pushes nothing while a socket says it is in front (for up to
      // 70 s after it last spoke).
      if (state !== "active") sendRef.current?.({ type: "state", focused: false, path: pathRef.current });
      setActive(state === "active");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!active || !slug) return;
    const socket = openSocket(client, "/-/live", { workspace: slug }, {
      onOpen: (send) => {
        sendRef.current = send;
        send({ type: "state", focused: true, path: pathRef.current });
      },
      onReconnect: () => void queries.invalidateQueries({ queryKey: chatKeys.all(slug) }),
      onMessage: (data) => {
        const event = data as FeedEvent;
        if (event.type === "counts" && event.workspace === slug) {
          setCounts({ unread: event.chat_unread, mentions: event.chat_mentions });
          void Notifications.setBadgeCountAsync(event.chat_unread + event.chat_mentions).catch(() => undefined);
          const per = new Map(event.per_channel.map((row) => [row.channel_id, row]));
          queries.setQueryData<ChatSidebar>(chatKeys.sidebar(slug), (sidebar) => {
            if (!sidebar) return sidebar;
            const known = new Set(sidebar.entries.map((entry) => entry.channel.id));
            // A conversation the app has not seen yet: read the sidebar again.
            if ([...per.keys()].some((id) => !known.has(id))) void queries.invalidateQueries({ queryKey: chatKeys.sidebar(slug) });
            return {
              ...sidebar,
              entries: sidebar.entries.map((entry) => {
                const row = per.get(entry.channel.id);
                if (row) return { ...entry, unread: row.unread, mentions: row.mentions };
                return event.complete ? { ...entry, unread: 0, mentions: 0 } : entry;
              }),
            };
          });
        } else if (event.type === "notification" && event.toast) {
          const note = event.notification;
          if (note.workspace !== slug || (note.channel_id && note.channel_id === viewing.channelId)) return;
          setBanner(note);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        } else if (event.type === "presence" && event.workspace === slug) {
          setPresence((before) => {
            const next = event.full ? new Map<string, Presence>() : new Map(before);
            for (const person of event.people) next.set(person.user_id, person.presence);
            return next;
          });
        }
      },
    });
    return () => {
      sendRef.current = null;
      socket.close();
    };
  }, [active, client, queries, slug]);

  // Where the app is, as a tab says where it is.
  useEffect(() => {
    sendRef.current?.({ type: "state", focused: true, path });
  }, [path]);

  // A banner goes by itself.
  useEffect(() => {
    if (!banner) return;
    const timer = setTimeout(() => setBanner(null), 5000);
    return () => clearTimeout(timer);
  }, [banner]);

  return (
    <FeedContext.Provider value={{ ...counts, banner, dismiss: () => setBanner(null), presence }}>{children}</FeedContext.Provider>
  );
}

export function useFeed(): FeedState {
  return useContext(FeedContext);
}
