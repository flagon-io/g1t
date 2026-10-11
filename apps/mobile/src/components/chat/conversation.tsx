import type { CardAction, ChatMessage } from "@g1t/contracts";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { router, useFocusEffect } from "expo-router";
import { ArrowDown, Copy, MessageSquareReply, Pencil, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from "react-native";

import { Composer } from "@/components/chat/composer";
import { Message, runsOn } from "@/components/chat/message";
import { PromptSheet, Sheet, SheetAction } from "@/components/chat/sheet";
import { ErrorView, Loading, Text } from "@/components/ui";
import { type Shown, markRead, useChannelLive, useChatActions, useMessages, useSend } from "@/lib/chat";
import { useSignedIn } from "@/lib/session";
import { viewing } from "@/lib/viewing";
import { radius, space, useColors } from "@/theme";

const QUICK = ["👍", "❤️", "😂", "🎉", "👀", "✅"];

type Row = { kind: "message"; message: Shown; head: boolean } | { kind: "day"; key: string; label: string };

/**
 * A conversation, or one thread of it: messages newest at the bottom, live
 * while open, read as they arrive, and a box to write in. Long-press a
 * message to react, reply in a thread, copy, or change or delete your own.
 */
export function Conversation({ channelId, thread, title }: { channelId: string; thread: string | null; title: string }) {
  const colors = useColors();
  const queries = useQueryClient();
  const { client, workspace, me } = useSignedIn();
  const slug = workspace?.slug ?? "";
  const messages = useMessages(channelId, thread);
  const live = useChannelLive(channelId);
  const send = useSend(channelId, thread);
  const actions = useChatActions(channelId);
  const [picked, setPicked] = useState<Shown | null>(null);
  const [editing, setEditing] = useState<Shown | null>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  const list = useRef<FlatList<Row>>(null);
  const focused = useRef(false);

  // While on screen, this conversation's banners and pushes are not shown.
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      viewing.channelId = channelId;
      viewing.threadRoot = thread;
      return () => {
        focused.current = false;
        if (viewing.channelId === channelId) {
          viewing.channelId = null;
          viewing.threadRoot = null;
        }
      };
    }, [channelId, thread]),
  );

  const all = useMemo(() => {
    const pages = messages.data?.pages ?? [];
    // Oldest first: the last page read is the oldest.
    const ordered = [...pages].reverse().flatMap((page) => page.messages as Shown[]);
    // A thread's first page carries the message it is under.
    const root = thread ? (pages[0]?.root ?? null) : null;
    const shown = ordered.filter((message) => !message.deleted_at && message.id !== root?.id);
    return root ? [root as Shown, ...shown] : shown;
  }, [messages.data, thread]);

  // Rows newest first, for a list drawn from the bottom up, with the day between days.
  const rows = useMemo(() => {
    const out: Row[] = [];
    let day = "";
    all.forEach((message, index) => {
      const date = new Date(message.created_at);
      const label = dayLabel(date);
      if (label !== day) {
        out.push({ kind: "day", key: `day-${label}-${index}`, label });
        day = label;
      }
      out.push({ kind: "message", message, head: label !== dayLabel(new Date(all[index - 1]?.created_at ?? 0)) || !runsOn(all[index - 1], message) });
    });
    return out.reverse();
  }, [all]);

  // Read up to the newest while it is on screen.
  const newest = all.filter((message) => !message.local).at(-1)?.id;
  useEffect(() => {
    if (slug && newest && focused.current && !thread) void markRead(client, queries, slug, channelId, newest);
  }, [client, queries, slug, channelId, newest, thread]);

  const onCardAction = useCallback(
    async (message: ChatMessage, action: CardAction, input?: string | null) => {
      const answer = await actions.cardAction.mutateAsync({ message, action: action.id, input });
      if (!answer.ok) throw new Error(answer.message ?? "That didn't work.");
      return answer.message;
    },
    [actions.cardAction],
  );

  const onReact = useCallback((message: ChatMessage, emoji: string, add: boolean) => actions.react.mutate({ message, emoji, add }), [actions.react]);
  const onRetry = useCallback((message: Shown) => send(message.body, message), [send]);

  const mine = picked?.author.kind === "user" && picked.author.id === me.id;
  const typingLine = typingText(live.typing.map((member) => member.display_name));

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 96 : 0}>
      <View style={{ flex: 1 }}>
        {messages.isPending ? (
          <Loading />
        ) : messages.error ? (
          <ErrorView error={messages.error} retry={() => messages.refetch()} />
        ) : (
          <FlatList
            ref={list}
            inverted
            data={rows}
            keyExtractor={(row) => (row.kind === "day" ? row.key : row.message.id)}
            renderItem={({ item }) =>
              item.kind === "day" ? (
                <View style={styles.day}>
                  <View style={[styles.dayLine, { backgroundColor: colors.line }]} />
                  <Text size="small" tone="faint" style={{ fontWeight: "600" }}>
                    {item.label}
                  </Text>
                  <View style={[styles.dayLine, { backgroundColor: colors.line }]} />
                </View>
              ) : (
                <Message
                  message={item.message}
                  head={item.head}
                  inThread={!!thread}
                  onLongPress={setPicked}
                  onReact={onReact}
                  onRetry={onRetry}
                  onCardAction={onCardAction}
                />
              )
            }
            onEndReached={() => messages.hasNextPage && !messages.isFetchingNextPage && messages.fetchNextPage()}
            onEndReachedThreshold={0.6}
            onScroll={(event) => setScrolledUp(event.nativeEvent.contentOffset.y > 600)}
            scrollEventThrottle={100}
            ListHeaderComponent={<View style={{ height: space.sm }} />}
            ListFooterComponent={
              messages.isFetchingNextPage ? (
                <ActivityIndicator style={{ margin: space.lg }} color={colors.accent} />
              ) : !messages.hasNextPage ? (
                <Text size="small" tone="faint" style={{ textAlign: "center", padding: space.xl }}>
                  {thread ? "The start of this thread." : `The start of ${title}.`}
                </Text>
              ) : null
            }
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
          />
        )}
        {scrolledUp ? (
          <Pressable
            accessibilityLabel="Go to newest"
            onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
            style={[styles.jump, { backgroundColor: colors.surface, borderColor: colors.lineStrong }]}
          >
            <ArrowDown size={18} color={colors.fg} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.typing}>
        <Text size="small" tone="faint" numberOfLines={1}>
          {typingLine}
        </Text>
        {live.status !== "live" ? (
          <Text size="small" tone="faint">
            {live.status === "connecting" ? "Connecting…" : "Offline, trying again"}
          </Text>
        ) : null}
      </View>
      <Composer draftKey={`${channelId}:${thread ?? ""}`} placeholder={thread ? "Reply in thread" : `Message ${title}`} onSend={(body) => send(body)} onTyping={live.sayTyping} />

      <Sheet visible={!!picked} onClose={() => setPicked(null)}>
        <View style={styles.quick}>
          {QUICK.map((emoji) => {
            const had = picked?.reactions?.find((one) => one.emoji === emoji)?.me ?? false;
            return (
              <Pressable
                key={emoji}
                onPress={() => {
                  if (picked) onReact(picked, emoji, !had);
                  setPicked(null);
                }}
                style={[styles.quickOne, { backgroundColor: had ? colors.accentLow : colors.raised }]}
              >
                <Text style={{ fontSize: 24, lineHeight: 30 }}>{emoji}</Text>
              </Pressable>
            );
          })}
        </View>
        {!thread ? (
          <SheetAction
            icon={MessageSquareReply}
            label="Reply in thread"
            onPress={() => {
              const message = picked;
              setPicked(null);
              if (message) router.push({ pathname: "/chat/thread", params: { channel: channelId, root: message.id } });
            }}
          />
        ) : null}
        <SheetAction
          icon={Copy}
          label="Copy text"
          onPress={() => {
            if (picked?.body) void Clipboard.setStringAsync(picked.body);
            setPicked(null);
          }}
        />
        {mine && picked?.kind === "text" ? (
          <SheetAction
            icon={Pencil}
            label="Edit"
            onPress={() => {
              setEditing(picked);
              setPicked(null);
            }}
          />
        ) : null}
        {mine ? (
          <SheetAction
            icon={Trash2}
            label="Delete"
            danger
            onPress={() => {
              const message = picked;
              setPicked(null);
              if (!message) return;
              Alert.alert("Delete this message?", "It is gone for everyone in the conversation.", [
                { text: "Cancel", style: "cancel" },
                { text: "Delete", style: "destructive", onPress: () => actions.remove.mutate(message) },
              ]);
            }}
          />
        ) : null}
      </Sheet>

      <PromptSheet
        visible={!!editing}
        title="Edit message"
        initial={editing?.body ?? ""}
        multiline
        confirm="Save"
        onCancel={() => setEditing(null)}
        onDone={(body) => {
          if (editing && body !== editing.body) actions.edit.mutate({ message: editing, body });
          setEditing(null);
        }}
      />
    </KeyboardAvoidingView>
  );
}

function dayLabel(date: Date): string {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

function typingText(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

const styles = StyleSheet.create({
  day: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  dayLine: { flex: 1, height: StyleSheet.hairlineWidth },
  jump: { position: "absolute", right: space.lg, bottom: space.md, width: 40, height: 40, borderRadius: 20, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  typing: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: space.lg, minHeight: 18 },
  quick: { flexDirection: "row", justifyContent: "space-around", paddingHorizontal: space.md, paddingBottom: space.sm },
  quickOne: { width: 48, height: 48, borderRadius: radius.full, alignItems: "center", justifyContent: "center" },
});
