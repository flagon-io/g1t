import { Stack, router, useLocalSearchParams } from "expo-router";
import { BellOff, Bell, LogOut, MoreHorizontal, Star, StarOff } from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { Conversation } from "@/components/chat/conversation";
import { Sheet, SheetAction } from "@/components/chat/sheet";
import { Empty, Loading, Screen, Text } from "@/components/ui";
import { useChatActions, useChatSidebar } from "@/lib/chat";
import { space, useColors } from "@/theme";

/**
 * A conversation. `channel` is a channel's id, or a channel's name when a
 * link named it (`/acme/-/chat/general`). The ⋯ button stars, mutes or
 * leaves it.
 */
export default function ConversationScreen() {
  const params = useLocalSearchParams<{ channel: string }>();
  const sidebar = useChatSidebar();
  const colors = useColors();
  const [menu, setMenu] = useState(false);
  const entry = sidebar.data?.entries.find((one) => one.channel.id === params.channel || one.channel.name === params.channel);
  // A link by name waits for the sidebar to say which channel it is.
  const channelId = entry?.channel.id ?? (/^[a-z]+_/.test(params.channel) ? params.channel : "");
  const actions = useChatActions(channelId);
  const dm = entry?.channel.kind === "dm";
  const title = entry ? (dm ? entry.title : `#${entry.channel.name}`) : "";

  if (!channelId) {
    return (
      <Screen>
        <Stack.Screen options={{ title: "" }} />
        {sidebar.isPending ? <Loading /> : <Empty title="Not in this conversation" body="It may be private, or you may need to join it first." />}
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View>
              <Text style={{ fontWeight: "700" }} numberOfLines={1}>
                {title}
              </Text>
              {entry?.channel.topic ? (
                <Text size="small" tone="muted" numberOfLines={1}>
                  {entry.channel.topic}
                </Text>
              ) : null}
            </View>
          ),
          headerRight: () =>
            entry ? (
              <Pressable accessibilityLabel="Conversation options" hitSlop={10} onPress={() => setMenu(true)}>
                <MoreHorizontal size={22} color={colors.fg} />
              </Pressable>
            ) : null,
        }}
      />
      <Conversation channelId={channelId} thread={null} title={title || "this conversation"} />
      <Sheet visible={menu} onClose={() => setMenu(false)}>
        <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
          <Text size="heading">{title}</Text>
        </View>
        <SheetAction
          icon={entry?.starred ? StarOff : Star}
          label={entry?.starred ? "Unstar" : "Star"}
          onPress={() => {
            setMenu(false);
            actions.preferences.mutate({ starred: !entry?.starred });
          }}
        />
        <SheetAction
          icon={entry?.muted ? Bell : BellOff}
          label={entry?.muted ? "Unmute" : "Mute"}
          onPress={() => {
            setMenu(false);
            actions.preferences.mutate({ muted: !entry?.muted });
          }}
        />
        {!dm ? (
          <SheetAction
            icon={LogOut}
            label="Leave channel"
            danger
            onPress={() => {
              setMenu(false);
              Alert.alert(`Leave ${title}?`, "You can join it again from Browse.", [
                { text: "Cancel", style: "cancel" },
                { text: "Leave", style: "destructive", onPress: () => actions.leave.mutate(undefined, { onSuccess: () => router.back() }) },
              ]);
            }}
          />
        ) : null}
      </Sheet>
    </Screen>
  );
}
