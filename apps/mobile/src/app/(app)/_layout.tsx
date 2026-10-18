import * as Notifications from "expo-notifications";
import { Tabs, router, useGlobalSearchParams, useSegments } from "expo-router";
import { Bell, House, ListTodo, Menu, MessagesSquare } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { type ComponentType, useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";

import { Banner } from "@/components/chat/banner";
import { FeedProvider, useFeed } from "@/lib/feed";
import { routeFor } from "@/lib/links";
import { type PushData, registerForPush } from "@/lib/push";
import { useSignedIn } from "@/lib/session";
import { useColors } from "@/theme";

/**
 * The signed-in app. Its bar is the site's phone bar
 * (apps/web/app/components/mobile.tsx): Home, Work, Chat, Notifications
 * and More. Work and Chat have their screens; Home and Notifications say
 * so and open the site. Sessions are Work's (Items, Board, Sessions at
 * its top, as on the site). More starts with Explore, which opens on the
 * site, then Code, for those who use it, and your account is under it.
 */
export default function AppLayout() {
  return (
    <FeedProvider>
      <PushSetup />
      <AppTabs />
      <Banner />
    </FeedProvider>
  );
}

function AppTabs() {
  const colors = useColors();
  const { workspace, selectWorkspace } = useSignedIn();
  const { unread, mentions } = useFeed();
  // A link names its workspace (`/chat?workspace=acme`, lib/links.ts): switch to it.
  const { workspace: linked } = useGlobalSearchParams<{ workspace?: string }>();
  useEffect(() => {
    if (linked && linked.toLowerCase() !== workspace?.slug.toLowerCase()) void selectWorkspace(linked);
  }, [linked, workspace?.slug, selectWorkspace]);
  // A conversation or a thread takes the whole screen, as on the site: the bar steps aside.
  const segments = useSegments() as string[];
  const inConversation = segments[1] === "chat" && (segments[2] === "[channel]" || segments[2] === "thread");
  const badge = mentions > 0 ? mentions : unread > 0 ? unread : undefined;

  return (
    <Tabs
      initialRouteName="chat"
      screenOptions={{
        headerShown: false,
        // The site's phone bar: flat along the bottom on the rail's colour, the
        // app you are in marked as the rail marks it (apps/web components/mobile.tsx).
        tabBarActiveTintColor: colors.fg,
        tabBarInactiveTintColor: colors.faint,
        tabBarStyle: inConversation
          ? { display: "none" }
          : { backgroundColor: colors.rail, borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, elevation: 0 },
        tabBarHideOnKeyboard: true,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "500" },
        tabBarIconStyle: { width: 44, height: 28 },
      }}
    >
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="home" options={{ title: "Home", tabBarIcon: (props) => <BarIcon icon={House} {...props} /> }} />
      <Tabs.Screen name="work" options={{ title: "Work", tabBarIcon: (props) => <BarIcon icon={ListTodo} {...props} /> }} />
      <Tabs.Screen
        name="chat"
        options={{
          title: "Chat",
          tabBarIcon: (props) => <BarIcon icon={MessagesSquare} {...props} />,
          tabBarBadge: badge,
          tabBarBadgeStyle: {
            backgroundColor: mentions > 0 ? colors.accent : colors.lineStrong,
            color: mentions > 0 ? colors.onAccent : colors.fg,
            fontSize: 11,
          },
        }}
      />
      <Tabs.Screen name="notifications" options={{ title: "Notifications", tabBarIcon: (props) => <BarIcon icon={Bell} {...props} /> }} />
      {/* Code opens from More, so it has no place in the bar. */}
      <Tabs.Screen name="code" options={{ title: "Code", href: null }} />
      <Tabs.Screen name="more" options={{ title: "More", tabBarIcon: (props) => <BarIcon icon={Menu} {...props} /> }} />
    </Tabs>
  );
}

/** A tab's icon: on the rail's accent in a 10px-rounded square when it is the tab you are in. */
function BarIcon({ icon: Icon, focused }: { icon: LucideIcon | ComponentType<{ color: string; size: number }>; focused: boolean }) {
  const colors = useColors();
  return (
    <View
      style={{
        width: 44,
        height: 28,
        borderRadius: 10,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: focused ? colors.railAccent : "transparent",
      }}
    >
      <Icon color={focused ? colors.fg : colors.muted} size={20} />
    </View>
  );
}

/**
 * Registers the phone for notifications once signed in (asking the first
 * time), and opens what a tapped notification is about: the thread or
 * conversation, in its workspace.
 */
function PushSetup() {
  const { client, selectWorkspace } = useSignedIn();
  const handled = useRef<string | null>(null);
  const response = Notifications.useLastNotificationResponse();

  useEffect(() => {
    void registerForPush(client, true).catch((error: unknown) => console.warn("g1t: registering for notifications failed", error));
    // The system can give the app a new push token: register that one too.
    const changed = Notifications.addPushTokenListener(() => {
      void registerForPush(client, false).catch(() => undefined);
    });
    return () => changed.remove();
  }, [client]);

  useEffect(() => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    const data = (response.notification.request.content.data ?? {}) as PushData;
    void (async () => {
      if (data.workspace) await selectWorkspace(data.workspace);
      if (data.channel_id && data.thread_root) {
        router.push({ pathname: "/chat/thread", params: { channel: data.channel_id, root: data.thread_root } });
      } else if (data.channel_id) {
        router.push({ pathname: "/chat/[channel]", params: { channel: data.channel_id } });
      } else if (data.href) {
        const route = routeFor(data.href);
        router.push((route ?? `/open?path=${encodeURIComponent(data.href)}`) as never);
      }
    })();
  }, [response, selectWorkspace]);

  return null;
}
