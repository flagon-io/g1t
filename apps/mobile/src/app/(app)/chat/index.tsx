import type { ChatSidebarEntry } from "@g1t/contracts";
import { Stack, router } from "expo-router";
import { Hash, Lock, MessagesSquare } from "lucide-react-native";
import { RefreshControl, SectionList, View } from "react-native";

import { Avatar, Badge, Empty, ErrorView, Loading, Row, Screen, SectionHeader } from "@/components/ui";
import { useChatSidebar } from "@/lib/chat";
import { useSignedIn } from "@/lib/session";
import { ago } from "@/lib/time";
import { useColors } from "@/theme";

/** Chat: the workspace's channels you are in, then your direct messages. */
export default function ChatList() {
  const { workspace, server } = useSignedIn();
  const sidebar = useChatSidebar();
  const colors = useColors();

  const title = workspace?.name ?? workspace?.slug ?? "Chat";
  if (!workspace) {
    return (
      <Screen>
        <Stack.Screen options={{ title: "Chat" }} />
        <Empty icon={MessagesSquare} title="No workspace yet" body="Create or join a workspace on g1t, then come back." />
      </Screen>
    );
  }

  const entries = sidebar.data?.entries ?? [];
  const sections = [
    { title: "Channels", data: entries.filter((entry) => entry.channel.kind === "channel" && !entry.channel.archived_at) },
    { title: "Direct messages", data: entries.filter((entry) => entry.channel.kind === "dm") },
  ].filter((section) => section.data.length > 0);

  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      {sidebar.isPending ? (
        <Loading />
      ) : sidebar.error ? (
        <ErrorView error={sidebar.error} retry={() => sidebar.refetch()} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(entry) => entry.channel.id}
          renderSectionHeader={({ section }) => <SectionHeader title={section.title} />}
          refreshControl={<RefreshControl refreshing={sidebar.isRefetching} onRefresh={() => sidebar.refetch()} tintColor={colors.accent} />}
          ListEmptyComponent={<Empty icon={MessagesSquare} title="No conversations yet" body="Join a channel or message someone on g1t." />}
          renderItem={({ item }) => <Conversation entry={item} site={server.site} />}
          stickySectionHeadersEnabled={false}
        />
      )}
    </Screen>
  );
}

function Conversation({ entry, site }: { entry: ChatSidebarEntry; site: string }) {
  const colors = useColors();
  const { channel } = entry;
  const dm = channel.kind === "dm";
  const other = entry.others[0];
  const leading = dm && other ? (
    <Avatar name={other.display_name} uri={other.avatar ? `${site}/avatars/${other.avatar}` : null} agent={other.kind === "agent"} />
  ) : (
    <View style={{ width: 32, alignItems: "center" }}>
      {channel.private ? <Lock size={18} color={colors.muted} /> : <Hash size={18} color={colors.muted} />}
    </View>
  );
  const unread = entry.unread > 0 && !entry.muted;
  return (
    <Row
      leading={leading}
      title={dm ? entry.title : channel.name ?? entry.title}
      subtitle={channel.topic ?? (channel.last_message_at ? ago(channel.last_message_at) : undefined)}
      trailing={
        entry.mentions > 0 ? <Badge label={`@${entry.mentions}`} tone="accent" /> : unread ? <Badge label={String(entry.unread)} tone="neutral" /> : null
      }
      chevron={false}
      onPress={() => router.push({ pathname: "/chat/[channel]", params: { channel: channel.id, title: dm ? entry.title : `#${channel.name}` } })}
    />
  );
}
