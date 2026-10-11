import * as Notifications from "expo-notifications";
import { Tabs, router, useGlobalSearchParams } from "expo-router";
import { Bell, Bot, Code2, House, Menu, MessagesSquare } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { type ComponentType, useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";

import { Banner } from "@/components/chat/banner";
import { FeedProvider, useFeed } from "@/lib/feed";
import { routeFor } from "@/lib/links";
import { type PushData, registerForPush } from "@/lib/push";
import { useSignedIn } from "@/lib/session";
import { hasCodeAccess } from "@g1t/contracts";
import { useColors } from "@/theme";

/**
 * The signed-in app. Its bar is the site's phone bar
 * (apps/web/app/components/mobile.tsx): Home, Chat, Notifications, Agents,
 * Code, and More. Chat and Code have their screens; the others say so and
 * open the site. Customize and your account are under More.
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
  const code = !workspace || hasCodeAccess(workspace);
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
        tabBarStyle: { backgroundColor: colors.rail, borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, elevation: 0 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "500" },
        tabBarIconStyle: { width: 44, height: 28 },
      }}
    >
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="home" options={{ title: "Home", tabBarIcon: (props) => <BarIcon icon={House} {...props} /> }} />
      <Tabs.Screen
        name="chat"
        options={{
          title: "Chat",
          tabBarIcon: (props) => <BarIcon icon={MessagesSquare} {...props} />,
          tabBarBadge: badge,
          tabBarBadgeStyle: { backgroundColor: mentions > 0 ? colors.accent : colors.lineStrong, color: mentions > 0 ? colors.onAccent : colors.fg, fontSize: 11 },
        }}
      />
      <Tabs.Screen name="notifications" options={{ title: "Notifications", tabBarIcon: (props) => <BarIcon icon={Bell} {...props} /> }} />
      <Tabs.Screen name="agents" options={{ title: "Agents", tabBarIcon: (props) => <BarIcon icon={Bot} {...props} /> }} />
      <Tabs.Screen name="code" options={{ title: "Code", href: code ? undefined : null, tabBarIcon: (props) => <BarIcon icon={Code2} {...props} /> }} />
      <Tabs.Screen name="customize" options={{ href: null }} />
      <Tabs.Screen name="more" options={{ title: "More", tabBarIcon: (props) => <BarIcon icon={Menu} {...props} /> }} />
    </Tabs>
  );
}

/** A tab's icon: on the rail's accent in a 10px-rounded square when it is the tab you are in. */
function BarIcon({ icon: Icon, focused }: { icon: LucideIcon | ComponentType<{ color: string; size: number }>; focused: boolean }) {
  const colors = useColors();
  return (
    <View style={{ width: 44, height: 28, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: focused ? colors.railAccent : "transparent" }}>
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
