import type { ChatMessage } from "@g1t/contracts";
import { Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { SendHorizontal } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Avatar, Badge, ErrorView, Loading, Screen, Text } from "@/components/ui";
import { markRead, useChannelLive, useChatSidebar, useMessages, usePostMessage } from "@/lib/chat";
import { siteUrl } from "@/lib/server";
import { useSignedIn } from "@/lib/session";
import { clock } from "@/lib/time";
import { radius, space, useColors } from "@/theme";

/**
 * A conversation: its messages, newest at the bottom, live while open, and
 * a box to write in. `channel` is a channel's id, or a channel's name when
 * a link named it (`/acme/-/chat/general`).
 */
export default function Conversation() {
  const params = useLocalSearchParams<{ channel: string; title?: string }>();
  const { client, workspace, server } = useSignedIn();
  const sidebar = useChatSidebar();
  const entry = sidebar.data?.entries.find((one) => one.channel.id === params.channel || one.channel.name === params.channel);
  // A link by name waits for the sidebar to say which channel it is.
  const channelId = entry?.channel.id ?? (params.channel.includes("_") ? params.channel : "");
  const title = params.title ?? (entry ? (entry.channel.kind === "dm" ? entry.title : `#${entry.channel.name}`) : "Chat");

  const messages = useMessages(channelId);
  const live = useChannelLive(channelId);
  const post = usePostMessage(channelId);
  const [draft, setDraft] = useState("");
  const colors = useColors();
  const insets = useSafeAreaInsets();

  // Newest first, for a list drawn from the bottom up.
  const newestFirst = useMemo(
    () => (messages.data?.pages ?? []).flatMap((page) => [...page.messages].reverse()).filter((message) => !message.deleted_at),
    [messages.data],
  );
  const newest = newestFirst[0]?.id;
  useEffect(() => {
    if (workspace && channelId && newest) void markRead(client, workspace.slug, channelId, newest);
  }, [client, workspace, channelId, newest]);

  const send = () => {
    const body = draft.trim();
    if (!body || post.isPending) return;
    post.mutate(body, { onSuccess: () => setDraft("") });
  };

  return (
    <Screen>
      <Stack.Screen options={{ title, headerRight: () => <LiveDot status={live} /> }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
        {!channelId && sidebar.isPending ? (
          <Loading />
        ) : messages.isPending ? (
          <Loading />
        ) : messages.error ? (
          <ErrorView error={messages.error} retry={() => messages.refetch()} />
        ) : (
          <FlatList
            inverted
            data={newestFirst}
            keyExtractor={(message) => message.id}
            renderItem={({ item }) => <Message message={item} site={server.site} />}
            onEndReached={() => messages.hasNextPage && !messages.isFetchingNextPage && messages.fetchNextPage()}
            onEndReachedThreshold={0.5}
            ListFooterComponent={messages.isFetchingNextPage ? <ActivityIndicator style={{ margin: space.lg }} color={colors.accent} /> : null}
            contentContainerStyle={{ paddingVertical: space.md }}
          />
        )}
        <View style={[styles.composer, { borderTopColor: colors.line, backgroundColor: colors.surface, paddingBottom: Math.max(insets.bottom, space.sm) }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Message ${title}`}
            placeholderTextColor={colors.faint}
            multiline
            style={[styles.input, { color: colors.fg, backgroundColor: colors.bg, borderColor: colors.lineStrong }]}
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Send" onPress={send} disabled={!draft.trim() || post.isPending} style={styles.send}>
            {post.isPending ? <ActivityIndicator color={colors.accent} /> : <SendHorizontal color={draft.trim() ? colors.accent : colors.faint} size={22} />}
          </Pressable>
        </View>
        {post.error ? (
          <Text tone="danger" size="small" style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
            {post.error.message}
          </Text>
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Message({ message, site }: { message: ChatMessage; site: string }) {
  const colors = useColors();
  const { author } = message;
  const card = message.kind === "card" ? message.card : null;
  return (
    <View style={styles.message}>
      <Avatar name={author.display_name} uri={author.avatar ? `${site}/avatars/${author.avatar}` : null} agent={author.kind === "agent"} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "baseline" }}>
          <Text style={{ fontWeight: "600" }}>{author.display_name}</Text>
          <Text size="small" tone="faint">
            {clock(message.created_at)}
            {message.edited_at ? " · edited" : ""}
          </Text>
        </View>
        {message.body ? <Text selectable>{message.body}</Text> : null}
        {card ? (
          <Pressable
            disabled={!card.href}
            onPress={() => card.href && WebBrowser.openBrowserAsync(siteUrl({ site, api: "" }, card.href))}
            style={[styles.card, { borderColor: colors.lineStrong, backgroundColor: colors.surface }]}
          >
            <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
              <Text style={{ flex: 1, fontWeight: "600" }}>{card.title}</Text>
              {card.state ? <Badge label={card.state} /> : null}
            </View>
            {card.detail ? (
              <Text size="small" tone="muted">
                {card.detail}
              </Text>
            ) : null}
            {card.body ? (
              <Text size="small" numberOfLines={6}>
                {card.body}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
        {message.reply_count > 0 ? (
          <Text size="small" tone="accent">
            {message.reply_count === 1 ? "1 reply" : `${message.reply_count} replies`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function LiveDot({ status }: { status: "connecting" | "live" | "offline" }) {
  const colors = useColors();
  const color = status === "live" ? colors.success : status === "connecting" ? colors.warn : colors.faint;
  return <View accessibilityLabel={status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Offline"} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

const styles = StyleSheet.create({
  message: { flexDirection: "row", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  card: { borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.xs, marginTop: space.xs },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 40, maxHeight: 140, borderRadius: radius.lg, borderWidth: 1, paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: 15 },
  send: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
});
