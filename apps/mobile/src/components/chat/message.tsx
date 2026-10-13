import type { ChatMessage, MessageCard } from "@g1t/contracts";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { AlertCircle, Clock, MessageSquareReply } from "lucide-react-native";
import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Markdown } from "@/components/chat/markdown";
import { Avatar, Badge, Text } from "@/components/ui";
import type { Shown } from "@/lib/chat";
import { routeFor } from "@/lib/links";
import { siteUrl } from "@/lib/server";
import { useSignedIn } from "@/lib/session";
import { clock } from "@/lib/time";
import { radius, space, useColors } from "@/theme";

type Props = {
  message: Shown;
  /** The first of a run by one author: draws the avatar and name. */
  head: boolean;
  /** In a thread: no "replies" line under it. */
  inThread?: boolean;
  onLongPress: (message: Shown) => void;
  onReact: (message: ChatMessage, emoji: string, add: boolean) => void;
  onRetry: (message: Shown) => void;
};

/**
 * One message in a conversation. Messages by the same author within a few
 * minutes run together under one name, as on the site. A message an agent
 * posted before g1t's own agents were retired still shows, under the name
 * chat gives it, with its marker and a Deleted agent badge.
 */
export const Message = memo(function Message({ message, head, inThread, onLongPress, onReact, onRetry }: Props) {
  const colors = useColors();
  const { server } = useSignedIn();
  const { author } = message;
  const agent = author.kind === "agent";
  // @g1t: its answers, with the agent marker but never a Deleted agent badge.
  const g1t = author.kind === "system";
  const failed = message.local === "failed";

  const openThread = () =>
    router.push({ pathname: "/chat/thread", params: { channel: message.channel_id, root: message.id } });

  return (
    <Pressable
      onLongPress={() => {
        if (message.local) return;
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
        onLongPress(message);
      }}
      onPress={failed ? () => onRetry(message) : undefined}
      delayLongPress={300}
      style={({ pressed }) => [styles.row, { paddingTop: head ? space.md : 2, backgroundColor: pressed ? colors.raised : "transparent" }]}
    >
      <View style={styles.gutter}>
        {head ? (
          <Avatar name={author.display_name} uri={author.avatar ? `${server.site}/avatars/${author.avatar}` : null} agent={agent || g1t} size={36} />
        ) : null}
      </View>
      <View style={{ flex: 1, gap: 4, opacity: message.local === "sending" ? 0.6 : 1 }}>
        {head ? (
          <View style={styles.header}>
            <Text style={{ fontWeight: "700" }} numberOfLines={1}>
              {author.display_name}
            </Text>
            {agent ? <Badge label="Deleted agent" tone="neutral" /> : null}
            <Text size="small" tone="faint">
              {clock(message.created_at)}
            </Text>
          </View>
        ) : null}
        {message.body ? <Markdown text={message.body} /> : g1t && message.answer && (message.answer.state === "thinking" || message.answer.state === "streaming") ? <Text tone="muted">Thinking…</Text> : null}
        {message.edited_at ? (
          <Text size="small" tone="faint">
            (edited)
          </Text>
        ) : null}
        {message.kind === "card" && message.card ? <Card card={message.card} site={server.site} /> : null}
        {message.reactions && message.reactions.length > 0 ? (
          <View style={styles.reactions}>
            {message.reactions.map((reaction) => (
              <Pressable
                key={reaction.emoji}
                accessibilityLabel={`${reaction.emoji} ${reaction.count}${reaction.me ? ", yours" : ""}`}
                onPress={() => {
                  void Haptics.selectionAsync().catch(() => undefined);
                  onReact(message, reaction.emoji, !reaction.me);
                }}
                style={[
                  styles.reaction,
                  { borderColor: reaction.me ? colors.accent : colors.line, backgroundColor: reaction.me ? colors.accentLow : colors.surface },
                ]}
              >
                <Text size="small">{reaction.emoji}</Text>
                <Text size="small" style={{ color: reaction.me ? colors.accent : colors.muted, fontWeight: "600" }}>
                  {reaction.count}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {!inThread && message.reply_count > 0 ? (
          <Pressable onPress={openThread} style={styles.replies} hitSlop={8}>
            <MessageSquareReply size={14} color={colors.accent} />
            <Text size="small" tone="accent" style={{ fontWeight: "600" }}>
              {message.reply_count === 1 ? "1 reply" : `${message.reply_count} replies`}
            </Text>
          </Pressable>
        ) : null}
        {message.local === "sending" ? (
          <View style={styles.status}>
            <Clock size={12} color={colors.faint} />
            <Text size="small" tone="faint">
              Sending
            </Text>
          </View>
        ) : failed ? (
          <View style={styles.status}>
            <AlertCircle size={12} color={colors.danger} />
            <Text size="small" tone="danger">
              Not sent. Tap to try again.
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});

/**
 * A card an agent posted before g1t's own agents were retired: what it was
 * about, its state, and its links. Its other buttons no longer do anything,
 * so they are not drawn.
 */
function Card({ card, site }: { card: MessageCard; site: string }) {
  const colors = useColors();
  const links = (card.actions ?? []).filter((action) => !!action.href);

  const open = (href: string) => {
    const route = href.startsWith("/") ? routeFor(href) : null;
    if (route) router.push(route as never);
    else void WebBrowser.openBrowserAsync(href.startsWith("/") ? siteUrl({ site, api: "" }, href) : href);
  };

  return (
    <View style={[styles.card, { borderColor: colors.lineStrong, backgroundColor: colors.surface }]}>
      <Pressable disabled={!card.href} onPress={() => card.href && open(card.href)} style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
          <Text style={{ flex: 1, fontWeight: "700" }}>{card.title}</Text>
          {card.state ? <Badge label={card.state} tone={/fail|stop|denied|error/i.test(card.state) ? "danger" : /merged|done|approved|passed/i.test(card.state) ? "success" : "accent"} /> : null}
        </View>
        {card.detail ? (
          <Text size="small" tone="muted">
            {card.detail}
          </Text>
        ) : null}
        {card.body ? <Markdown text={card.body} muted /> : null}
        {card.fields?.length ? (
          <View style={styles.fields}>
            {card.fields.map((field) => (
              <View key={field.label} style={{ width: "48%" }}>
                <Text size="small" tone="faint">
                  {field.label}
                </Text>
                <Text size="small" numberOfLines={2}>
                  {field.value}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </Pressable>
      {links.length ? (
        <View style={styles.actions}>
          {links.map((action) => (
            <Pressable
              key={action.id}
              accessibilityRole="link"
              onPress={() => action.href && open(action.href)}
              style={({ pressed }) => [styles.action, { backgroundColor: colors.bg, borderColor: colors.lineStrong, opacity: pressed ? 0.6 : 1 }]}
            >
              <Text size="small" style={{ fontWeight: "700", color: colors.fg }}>
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Whether two messages run together: the same author, within five minutes, neither a card. */
export function runsOn(previous: ChatMessage | undefined, message: ChatMessage): boolean {
  if (!previous || previous.kind === "card" || message.kind === "card") return false;
  if (previous.author.id !== message.author.id || previous.author.kind !== message.author.kind) return false;
  return Date.parse(message.created_at) - Date.parse(previous.created_at) < 5 * 60_000;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: space.md, paddingHorizontal: space.lg, paddingBottom: 2 },
  gutter: { width: 36 },
  header: { flexDirection: "row", alignItems: "center", gap: space.sm },
  reactions: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
  reaction: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 3 },
  replies: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  status: { flexDirection: "row", alignItems: "center", gap: 4 },
  card: { borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.sm, marginTop: 2 },
  fields: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, justifyContent: "space-between" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  action: { minHeight: 36, minWidth: 72, paddingHorizontal: space.md, borderRadius: radius.sm, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
