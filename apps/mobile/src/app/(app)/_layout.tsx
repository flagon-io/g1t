import { Tabs, useGlobalSearchParams } from "expo-router";
import { Blocks, CircleUser, Code2, MessagesSquare } from "lucide-react-native";
import { useEffect } from "react";

import { useSignedIn } from "@/lib/session";
import { useColors } from "@/theme";

/**
 * The signed-in app: Chat, Code, Customize and You, as the site's phone
 * layout has its bottom bar (apps/web/app/components/mobile.tsx). Home,
 * Notifications, Agents and Artifacts join as they get screens.
 */
export default function AppLayout() {
  const colors = useColors();
  const { workspace, selectWorkspace } = useSignedIn();
  // A link names its workspace (`/chat?workspace=acme`, lib/links.ts): switch to it.
  const { workspace: linked } = useGlobalSearchParams<{ workspace?: string }>();
  useEffect(() => {
    if (linked && linked.toLowerCase() !== workspace?.slug.toLowerCase()) void selectWorkspace(linked);
  }, [linked, workspace?.slug, selectWorkspace]);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.line },
      }}
    >
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen name="chat" options={{ title: "Chat", tabBarIcon: ({ color, size }) => <MessagesSquare color={color} size={size} /> }} />
      <Tabs.Screen name="code" options={{ title: "Code", tabBarIcon: ({ color, size }) => <Code2 color={color} size={size} /> }} />
      <Tabs.Screen name="customize" options={{ title: "Customize", tabBarIcon: ({ color, size }) => <Blocks color={color} size={size} /> }} />
      <Tabs.Screen name="you" options={{ title: "You", tabBarIcon: ({ color, size }) => <CircleUser color={color} size={size} /> }} />
    </Tabs>
  );
}
