import { Stack, router } from "expo-router";
import { Hash } from "lucide-react-native";
import { FlatList, RefreshControl } from "react-native";

import { Badge, Button, Empty, ErrorView, Loading, Row, Screen } from "@/components/ui";
import { useBrowseChannels, useChatSidebar, useStartConversation } from "@/lib/chat";
import { useColors } from "@/theme";

/** The workspace's public channels: open one you are in, or join one you are not. */
export default function Browse() {
  const channels = useBrowseChannels();
  const sidebar = useChatSidebar();
  const { join } = useStartConversation();
  const colors = useColors();
  const mine = new Set((sidebar.data?.entries ?? []).map((entry) => entry.channel.id));

  return (
    <Screen>
      <Stack.Screen options={{ title: "Browse channels" }} />
      {channels.isPending ? (
        <Loading />
      ) : channels.error ? (
        <ErrorView error={channels.error} retry={() => channels.refetch()} />
      ) : (
        <FlatList
          data={channels.data}
          keyExtractor={(channel) => channel.id}
          refreshControl={<RefreshControl refreshing={channels.isRefetching} onRefresh={() => channels.refetch()} tintColor={colors.accent} />}
          ListEmptyComponent={<Empty icon={Hash} title="No other channels" />}
          renderItem={({ item }) => {
            const joined = mine.has(item.id);
            const open = () => router.replace({ pathname: "/chat/[channel]", params: { channel: item.id } });
            return (
              <Row
                leading={<Hash size={20} color={colors.muted} />}
                title={item.name ?? ""}
                subtitle={item.topic ?? undefined}
                chevron={false}
                onPress={joined ? open : undefined}
                trailing={
                  joined ? (
                    <Badge label="Joined" />
                  ) : (
                    <Button
                      title="Join"
                      variant="secondary"
                      busy={join.isPending && join.variables === item.id}
                      onPress={() => join.mutate(item.id, { onSuccess: open })}
                    />
                  )
                }
              />
            );
          }}
        />
      )}
    </Screen>
  );
}
