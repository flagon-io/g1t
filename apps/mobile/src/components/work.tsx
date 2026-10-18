import { CircleCheck, CircleDot, CircleX, Ellipsis, FolderGit2, MessageSquare, SendHorizontal } from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Text } from "@/components/ui";
import { ago } from "@/lib/time";
import type { ApiItemRepo, ApiWorkItem, LinkRole } from "@/lib/work";
import { radius, space, useColors } from "@/theme";

/** A work item's state, as an icon in its colour: open, done, or closed as not planned. */
export function ItemIcon({ item, size = 20 }: { item: Pick<ApiWorkItem, "state" | "reason">; size?: number }) {
  const colors = useColors();
  if (item.state === "open") return <CircleDot size={size} color={colors.success} accessibilityLabel="Open" />;
  return item.reason === "not_planned" ? (
    <CircleX size={size} color={colors.muted} accessibilityLabel="Closed as not planned" />
  ) : (
    <CircleCheck size={size} color={colors.merged} accessibilityLabel="Closed" />
  );
}

export function stateLabel(item: Pick<ApiWorkItem, "state" | "reason">): string {
  if (item.state === "open") return "Open";
  return item.reason === "not_planned" ? "Not planned" : "Closed";
}

/** A small rounded tag: a label, a repository, a filter. */
export function Chip({ label, tone = "neutral", onPress, leading }: { label: string; tone?: "neutral" | "accent"; onPress?: () => void; leading?: ReactNode }) {
  const colors = useColors();
  const on = tone === "accent";
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: on ? colors.accent : colors.lineStrong, backgroundColor: on ? colors.accentLow : pressed ? colors.raised : "transparent" },
      ]}
    >
      {leading}
      <Text size="small" numberOfLines={1} style={{ color: on ? colors.accent : colors.fgSoft, fontWeight: "500", maxWidth: 180 }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A repository's name in a chip: just the name when it is in the item's workspace. */
export function repoName(path: string, workspace: string): string {
  const [owner, name] = path.split("/", 2);
  return name && owner.toLowerCase() === workspace.toLowerCase() ? name : path;
}

/**
 * The repositories an item is linked to, as chips that fit a phone's row:
 * the first `max`, then "+2" for the rest. Origin and targets come first.
 */
export function RepoChips({ repos, workspace, max = 2 }: { repos: ApiItemRepo[]; workspace: string; max?: number }) {
  const colors = useColors();
  const shown = repos.filter((repo) => repo.role !== "touched").concat(repos.filter((repo) => repo.role === "touched"));
  if (shown.length === 0) return null;
  const rest = shown.length - max;
  return (
    <>
      {shown.slice(0, max).map((repo) => (
        <Chip key={repo.repo_id} label={repoName(repo.path, workspace)} leading={<FolderGit2 size={12} color={colors.muted} />} />
      ))}
      {rest > 0 ? <Chip label={`+${rest}`} /> : null}
    </>
  );
}

/** One work item in a list: its number and title, then state, repositories and labels on a line that wraps. */
export function ItemRow({ item, onPress }: { item: ApiWorkItem; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, { borderBottomColor: colors.line, backgroundColor: pressed ? colors.raised : "transparent" }]}
    >
      <View style={{ paddingTop: 1 }}>
        <ItemIcon item={item} size={18} />
      </View>
      <View style={{ flex: 1, gap: 6 }}>
        <Text numberOfLines={2} style={{ fontWeight: "600" }}>
          {item.title}
        </Text>
        <View style={styles.meta}>
          <Text size="small" tone="muted">
            #{item.number} · {ago(item.updated_at)}
          </Text>
          <RepoChips repos={item.repos} workspace={item.workspace} />
          {item.labels.slice(0, 2).map((label) => (
            <Chip key={label} label={label} />
          ))}
          {item.labels.length > 2 ? <Chip label={`+${item.labels.length - 2}`} /> : null}
          {item.comment_count ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
              <MessageSquare size={13} color={colors.faint} />
              <Text size="small" tone="faint">
                {item.comment_count}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const ROLES: Record<LinkRole, string> = { origin: "Origin", target: "Target", touched: "Touched" };

export function roleLabel(role: LinkRole): string {
  return ROLES[role];
}

/**
 * The bar at the foot of an item: a box to comment in, the arrow to send
 * it, and ⋯ for everything else (close, reopen, link a repository), all
 * where a thumb reaches. What was typed stays until it is sent.
 */
export function CommentBar({ busy, onSend, onMore }: { busy: boolean; onSend: (body: string) => Promise<unknown>; onMore: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => setKeyboard(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setKeyboard(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  const ready = text.trim().length > 0 && !busy;
  const send = () => {
    if (!ready) return;
    void onSend(text.trim()).then(() => setText(""), () => undefined);
  };
  return (
    <View style={[styles.bar, { borderTopColor: colors.line, backgroundColor: colors.surface, paddingBottom: keyboard ? space.sm : Math.max(insets.bottom, space.sm) }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="More actions" onPress={onMore} style={[styles.round, { backgroundColor: colors.raised }]}>
        <Ellipsis size={20} color={colors.fg} />
      </Pressable>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Comment"
        placeholderTextColor={colors.faint}
        multiline
        style={[styles.input, { color: colors.fg, backgroundColor: colors.bg, borderColor: colors.lineStrong }]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Comment"
        onPress={send}
        disabled={!ready}
        style={[styles.round, { backgroundColor: ready ? colors.accent : colors.raised }]}
      >
        {busy ? <ActivityIndicator color={colors.fg} /> : <SendHorizontal size={18} color={ready ? colors.onAccent : colors.faint} />}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderRadius: radius.full, paddingHorizontal: space.sm, paddingVertical: 1 },
  row: { flexDirection: "row", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  bar: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 40, maxHeight: 140, borderRadius: radius.lg, borderWidth: 1, paddingHorizontal: space.md, paddingTop: 10, paddingBottom: 10, fontSize: 15 },
  round: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
});
