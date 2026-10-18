import { router } from "expo-router";
import { ListTodo, Users } from "lucide-react-native";
import { useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, View } from "react-native";

import { Empty, ErrorView, Loading, SectionHeader, Text } from "@/components/ui";
import { Chip, ItemIcon, RepoChips } from "@/components/work";
import { type Card, STAGES, type Stage, stageName } from "@/lib/board";
import { harnessName } from "@/lib/sessions";
import { ago } from "@/lib/time";
import { type ApiWorkItem, useBoard } from "@/lib/work";
import { space, useColors } from "@/theme";

/**
 * Work's board on a phone: the work as it moves, a stage under the next
 * (Backlog, In progress, In review, Landing, Done), and chips above to
 * show one stage alone. Pull down to read again; while a session is live
 * and the board is in view, who is on what is read again every 15 s.
 */
export function Board({ workspace, focused }: { workspace: string; focused: boolean }) {
  const colors = useColors();
  const board = useBoard(workspace, focused);
  const [stage, setStage] = useState<Stage | null>(null);

  if (board.isPending) return <Loading />;
  if (board.error) return <ErrorView error={board.error} retry={() => void board.refetch()} />;

  const total = STAGES.reduce((sum, one) => sum + board.board[one].length, 0);
  const sections = (stage ? [stage] : STAGES)
    .map((one) => ({ stage: one, title: `${stageName(one)} · ${board.board[one].length}`, data: board.board[one] }))
    .filter((section) => stage !== null || section.data.length > 0);

  return (
    <SectionList
      sections={sections}
      keyExtractor={(card) => card.item.id}
      stickySectionHeadersEnabled={false}
      refreshControl={<RefreshControl refreshing={board.isRefetching} onRefresh={() => void board.refetch()} tintColor={colors.accent} />}
      contentContainerStyle={{ paddingBottom: 96, flexGrow: 1 }}
      ListHeaderComponent={
        <View style={[styles.stages, { borderBottomColor: colors.line }]}>
          <Chip label={`All ${total}`} tone={stage === null ? "accent" : "neutral"} onPress={() => setStage(null)} />
          {STAGES.map((one) => (
            <Chip
              key={one}
              label={`${stageName(one)} ${board.board[one].length}`}
              tone={stage === one ? "accent" : "neutral"}
              onPress={() => setStage(stage === one ? null : one)}
            />
          ))}
        </View>
      }
      renderSectionHeader={({ section }) => <SectionHeader title={section.title} />}
      renderSectionFooter={({ section }) =>
        section.data.length === 0 ? (
          <Text size="small" tone="faint" style={{ paddingHorizontal: space.lg }}>
            {section.stage === "done" ? "Nothing closed in the last two weeks." : "Nothing here."}
          </Text>
        ) : null
      }
      renderItem={({ item }) => <BoardCard card={item} />}
      ListEmptyComponent={<Empty icon={ListTodo} title="No work yet" body="Work items are any tracked work: a feature, a bug, a chore." />}
    />
  );
}

/** A work item on the board: its number and title, who is on it, and its repositories. */
function BoardCard({ card }: { card: Card<ApiWorkItem> }) {
  const colors = useColors();
  const { item, people } = card;
  const who = people.map((one) => (one.harness ? `@${one.name} (${harnessName(one.harness)})` : `@${one.name}`)).join(", ");
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/work/[number]", params: { number: String(item.number), workspace: item.workspace } })}
      style={({ pressed }) => [styles.row, { borderBottomColor: colors.line, backgroundColor: pressed ? colors.raised : "transparent" }]}
    >
      <View style={{ paddingTop: 1 }}>
        <ItemIcon item={item} size={18} />
      </View>
      <View style={{ flex: 1, gap: 6 }}>
        <Text numberOfLines={2} style={{ fontWeight: "600" }}>
          {item.title}
        </Text>
        {who ? (
          <View style={styles.meta}>
            <Users size={13} color={colors.faint} />
            <Text size="small" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
              {who}
            </Text>
          </View>
        ) : null}
        <View style={styles.meta}>
          <Text size="small" tone="muted">
            #{item.number} · {ago(item.closed_at ?? item.updated_at)}
          </Text>
          <RepoChips repos={item.repos} workspace={item.workspace} />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stages: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
});
