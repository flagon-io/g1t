import type { ChatSidebarEntry } from "@g1t/contracts";
import { Stack, router } from "expo-router";
import { Hash, Lock, MessagesSquare, Search, SquarePen } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, TextInput, View } from "react-native";

import { Avatar, Badge, Button, Empty, ErrorView, Loading, Screen, SectionHeader, Text } from "@/components/ui";
import { useChatSidebar } from "@/lib/chat";
import { useFeed } from "@/lib/feed";
import { useSignedIn } from "@/lib/session";
import { ago } from "@/lib/time";
import { radius, space, useColors } from "@/theme";

/**
 * Chat: starred conversations, the channels you are in, and your direct
 * messages, with what is unread. Counts move live with the feed
 * (lib/feed.tsx); pull down to read everything again.
 */
export default function ChatList() {
  const { workspace } = useSignedIn();
  const sidebar = useChatSidebar();
  const colors = useColors();
  const [search, setSearch] = useState("");

  const sections = useMemo(() => {
    const words = search.trim().toLowerCase();
    const entries = (sidebar.data?.entries ?? []).filter(
      (entry) => !entry.channel.archived_at && (!words || `${entry.title} ${entry.channel.name ?? ""}`.toLowerCase().includes(words)),
    );
    const byRecent = (a: ChatSidebarEntry, b: ChatSidebarEntry) => (b.channel.last_message_at ?? "").localeCompare(a.channel.last_message_at ?? "");
    return [
      { title: "Starred", data: entries.filter((entry) => entry.starred).sort(byRecent) },
      { title: "Channels", data: entries.filter((entry) => !entry.starred && entry.channel.kind === "channel").sort((a, b) => (a.channel.name ?? "").localeCompare(b.channel.name ?? "")) },
      { title: "Direct messages", data: entries.filter((entry) => !entry.starred && entry.channel.kind === "dm").sort(byRecent) },
    ].filter((section) => section.data.length > 0);
  }, [sidebar.data, search]);

  const header = (
    <Stack.Screen
      options={{
        title: workspace?.name ?? workspace?.slug ?? "Chat",
        headerRight: () => (
          <Pressable accessibilityLabel="New message" hitSlop={10} onPress={() => router.push("/chat/new")}>
            <SquarePen size={22} color={colors.fg} />
          </Pressable>
        ),
      }}
    />
  );

  if (!workspace) {
    return (
      <Screen>
        {header}
        <Empty icon={MessagesSquare} title="No workspace yet" body="Create or join a workspace on g1t, then come back." />
      </Screen>
    );
  }

  return (
    <Screen>
      {header}
      {sidebar.isPending ? (
        <Loading />
      ) : sidebar.error ? (
        <ErrorView error={sidebar.error} retry={() => sidebar.refetch()} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(entry) => entry.channel.id}
          stickySectionHeadersEnabled={false}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View style={[styles.search, { backgroundColor: colors.raised }]}>
              <Search size={16} color={colors.faint} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Find a conversation"
                placeholderTextColor={colors.faint}
                style={{ flex: 1, color: colors.fg, fontSize: 15, paddingVertical: 8 }}
                autoCorrect={false}
                autoCapitalize="none"
              />
            </View>
          }
          renderSectionHeader={({ section }) => <SectionHeader title={section.title} />}
          renderItem={({ item }) => <Conversation entry={item} />}
          refreshControl={<RefreshControl refreshing={sidebar.isRefetching} onRefresh={() => sidebar.refetch()} tintColor={colors.accent} />}
          ListEmptyComponent={
            search ? (
              <Empty title="Nothing matches" />
            ) : (
              <Empty icon={MessagesSquare} title="No conversations yet" body="Message a person, or join a channel." action={<Button title="New message" onPress={() => router.push("/chat/new")} />} />
            )
          }
          ListFooterComponent={
            sidebar.data && sidebar.data.browsable > 0 && !search ? (
              <Pressable onPress={() => router.push("/chat/browse")} style={styles.browse}>
                <Hash size={16} color={colors.accent} />
                <Text tone="accent" style={{ fontWeight: "600" }}>
                  Browse {sidebar.data.browsable} more {sidebar.data.browsable === 1 ? "channel" : "channels"}
                </Text>
              </Pressable>
            ) : (
              <View style={{ height: space.xl }} />
            )
          }
        />
      )}
    </Screen>
  );
}

function Conversation({ entry }: { entry: ChatSidebarEntry }) {
  const colors = useColors();
  const { server } = useSignedIn();
  const { presence } = useFeed();
  const { channel } = entry;
  const dm = channel.kind === "dm";
  const other = entry.others[0];
  const loud = entry.unread > 0 && !entry.muted;
  const online = dm && other && other.kind === "user" && presence.get(other.id) === "active";
  const title = dm ? entry.title : (channel.name ?? entry.title);

  return (
    <Pressable
      onPress={() => router.push({ pathname: "/chat/[channel]", params: { channel: channel.id } })}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? colors.raised : "transparent" }]}
    >
      <View>
        {dm && other ? (
          <Avatar name={other.display_name} uri={other.avatar ? `${server.site}/avatars/${other.avatar}` : null} agent={other.kind !== "user"} size={40} />
        ) : (
          <View style={[styles.icon, { backgroundColor: colors.raised }]}>
            {channel.private ? <Lock size={18} color={colors.muted} /> : <Hash size={18} color={colors.muted} />}
          </View>
        )}
        {online ? <View style={[styles.online, { backgroundColor: colors.success, borderColor: colors.bg }]} /> : null}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text numberOfLines={1} style={{ flex: 1, fontWeight: loud ? "800" : "500", color: entry.muted ? colors.muted : colors.fg }}>
            {title}
          </Text>
          {channel.last_message_at ? (
            <Text size="small" tone="faint">
              {ago(channel.last_message_at)}
            </Text>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text size="small" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
            {dm ? (other?.kind === "agent" ? "Deleted agent" : `@${other?.name ?? ""}`) : (channel.topic ?? (entry.muted ? "Muted" : " "))}
          </Text>
          {entry.mentions > 0 ? <Badge label={`@ ${entry.mentions}`} tone="accent" /> : loud ? <View style={[styles.dot, { backgroundColor: colors.accent }]} /> : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, marginHorizontal: space.lg, marginTop: space.md, paddingHorizontal: space.md, borderRadius: radius.md },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 10 },
  icon: { width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  online: { position: "absolute", right: -1, bottom: -1, width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  browse: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.lg },
});
