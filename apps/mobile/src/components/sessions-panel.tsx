import { Activity, Check as CheckIcon, X } from "lucide-react-native";
import type { ReactNode } from "react";
import { RefreshControl, ScrollView, SectionList, StyleSheet, View, useWindowDimensions } from "react-native";

import { Sheet } from "@/components/chat/sheet";
import { Segments } from "@/components/segments";
import { SessionCard } from "@/components/sessions";
import { Button, Empty, ErrorView, Loading, Row, SectionHeader, Text } from "@/components/ui";
import { Chip } from "@/components/work";
import { type ApiWorkspaceSession, type SessionsFilter, isLive } from "@/lib/sessions";
import { useWorkspaceSessions } from "@/lib/work";
import { space, useColors } from "@/theme";

type Shown = "all" | "live" | "ended";

/** What a link to Work's sessions may name (`/acme/-/work/sessions?state=live&repo=web`). */
export type SessionsParams = { state?: string; person?: string; repo?: string; item?: string };

/** The filter a link names: every session when it names none. */
export function sessionsFilterOf(params: SessionsParams): SessionsFilter {
  const state = params.state === "live" || params.state === "ended" ? params.state : "recent";
  const item = Number(params.item);
  return { state, person: params.person || undefined, repo: params.repo || undefined, item: Number.isInteger(item) && item > 0 ? item : undefined };
}

const SHOWN: Record<Shown, SessionsFilter["state"]> = { all: "recent", live: "live", ended: "ended" };

/** Whether any filter but which sessions are shown is set: the header's filter button is lit then. */
export function sessionsFiltered(filter: SessionsFilter): boolean {
  return Boolean(filter.person || filter.repo || filter.item);
}

/**
 * Work's Sessions: what is cooking across the workspace. The ones going
 * now first, then those that ended lately, each with who runs it in what,
 * where, and the work item and pull request it is on. Pull down to read
 * again; while one is live it is read again every 15 s. `top` is Work's
 * own segments (Items, Board, Sessions), over this view's.
 */
export function SessionsPanel({
  workspace,
  me,
  filter,
  onChange: setFilter,
  focused,
  filtering,
  onFiltering,
  top,
}: {
  workspace: string;
  me: string;
  filter: SessionsFilter;
  onChange: (filter: SessionsFilter) => void;
  focused: boolean;
  filtering: boolean;
  onFiltering: (open: boolean) => void;
  top: ReactNode;
}) {
  const colors = useColors();
  const sessions = useWorkspaceSessions(workspace, filter, focused);
  const shown: Shown = filter.state === "live" ? "live" : filter.state === "ended" ? "ended" : "all";

  const active = [
    filter.person ? { key: "person", label: filter.person === me ? "Started by me" : `@${filter.person}` } : null,
    filter.repo ? { key: "repo", label: filter.repo } : null,
    filter.item ? { key: "item", label: `#${filter.item}` } : null,
  ].filter((one): one is { key: "person" | "repo" | "item"; label: string } => one !== null);

  const all = sessions.data?.sessions ?? [];
  const sections: { title: string; data: ApiWorkspaceSession[] }[] =
    shown === "all"
      ? [
          { title: "Live now", data: all.filter(isLive) },
          { title: "Recent", data: all.filter((one) => !isLive(one)) },
        ].filter((section) => section.data.length > 0)
      : all.length
        ? [{ title: shown === "live" ? "Live now" : "Recent", data: all }]
        : [];

  return (
    <>
      <View style={[styles.bar, { borderBottomColor: colors.line }]}>
        {top}
        <Segments
          value={shown}
          onChange={(next) => setFilter({ ...filter, state: SHOWN[next] })}
          options={[
            { value: "all", label: "Everything" },
            { value: "live", label: "Live" },
            { value: "ended", label: "Recent" },
          ]}
        />
        {active.length ? (
          <View style={styles.chips}>
            {active.map((one) => (
              <Chip
                key={one.key}
                label={one.label}
                tone="accent"
                leading={<X size={12} color={colors.accent} />}
                onPress={() => setFilter({ ...filter, [one.key]: undefined })}
              />
            ))}
          </View>
        ) : null}
      </View>

      {sessions.isPending ? (
        <Loading />
      ) : sessions.error ? (
        <ErrorView error={sessions.error} retry={() => sessions.refetch()} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(session) => `${session.kind}:${session.id}`}
          stickySectionHeadersEnabled={false}
          refreshControl={<RefreshControl refreshing={sessions.isRefetching} onRefresh={() => sessions.refetch()} tintColor={colors.accent} />}
          contentContainerStyle={{ paddingBottom: space.xl, flexGrow: 1 }}
          renderSectionHeader={({ section }) => <SectionHeader title={section.title} />}
          renderItem={({ item }) => <SessionCard session={item} workspace={workspace} />}
          ListEmptyComponent={
            <Empty
              icon={Activity}
              title={active.length ? "Nothing matches" : shown === "live" ? "Nothing running now" : "No sessions yet"}
              body={
                active.length
                  ? "Try fewer filters."
                  : "A session is one run of an agent on a repository: someone's Claude Code or Codex, or g1t's own on a pull request."
              }
            />
          }
        />
      )}

      <Filters
        visible={filtering}
        filter={filter}
        me={me}
        repos={(sessions.data?.repos ?? []).map((repo) => repo.path.split("/", 2)[1] ?? repo.path)}
        onClose={() => onFiltering(false)}
        onChange={setFilter}
      />
    </>
  );
}

/** The sessions' filters, in a sheet: started by you, and the repository. */
function Filters({
  visible,
  filter,
  me,
  repos,
  onClose,
  onChange,
}: {
  visible: boolean;
  filter: SessionsFilter;
  me: string;
  repos: string[];
  onClose: () => void;
  onChange: (filter: SessionsFilter) => void;
}) {
  const colors = useColors();
  const { height } = useWindowDimensions();
  const mine = filter.person === me;
  return (
    <Sheet visible={visible} onClose={onClose}>
      <ScrollView style={{ maxHeight: height * 0.7 }} contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.lg, paddingBottom: space.md }}>
        <Text size="heading">Filters</Text>
        <View style={{ marginHorizontal: -space.lg }}>
          <Row
            title="Started by me"
            chevron={false}
            trailing={
              <View style={[styles.check, { borderColor: mine ? colors.accent : colors.lineStrong, backgroundColor: mine ? colors.accent : "transparent" }]}>
                {mine ? <CheckIcon size={14} color={colors.onAccent} strokeWidth={3} /> : null}
              </View>
            }
            onPress={() => onChange({ ...filter, person: mine ? undefined : me })}
          />
        </View>
        <View style={{ gap: space.sm }}>
          <Text size="small" tone="muted">
            Repository
          </Text>
          {repos.length ? (
            <View style={styles.chips}>
              {repos.map((name) => (
                <Chip
                  key={name}
                  label={name}
                  tone={filter.repo === name ? "accent" : "neutral"}
                  onPress={() => onChange({ ...filter, repo: filter.repo === name ? undefined : name })}
                />
              ))}
            </View>
          ) : (
            <Text size="small" tone="faint">
              No repositories you can see
            </Text>
          )}
        </View>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button title="Clear" variant="secondary" onPress={() => onChange({ state: filter.state })} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Done" onPress={onClose} />
          </View>
        </View>
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: "center", justifyContent: "center" },
});
