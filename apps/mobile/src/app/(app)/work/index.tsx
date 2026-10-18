import { Stack, router, useLocalSearchParams, useNavigation } from "expo-router";
import { Check as CheckIcon, ListTodo, Plus, SlidersHorizontal, X } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";

import { Sheet } from "@/components/chat/sheet";
import { Segments } from "@/components/segments";
import { Button, Empty, ErrorView, Loading, Row, Screen, Text } from "@/components/ui";
import { Chip, ItemRow, roleLabel } from "@/components/work";
import { useRepos } from "@/lib/code";
import { useSignedIn } from "@/lib/session";
import { type LinkRole, type WorkFilter, useLabels, useMilestones, useWorkItems } from "@/lib/work";
import { radius, space, useColors } from "@/theme";

type Params = { workspace?: string; state?: string; label?: string; milestone?: string; assignee?: string; repo?: string; role?: string };

/** The filter a link to the list names (`/acme/-/work?repo=web&label=bug`), open items when it names none. */
function filterOf(params: Params): WorkFilter {
  const state = params.state === "closed" || params.state === "all" ? params.state : "open";
  const role = params.role === "origin" || params.role === "target" || params.role === "touched" ? params.role : undefined;
  const milestone = Number(params.milestone);
  return {
    state,
    label: params.label || undefined,
    milestone: Number.isInteger(milestone) && milestone > 0 ? milestone : undefined,
    assignee: params.assignee || undefined,
    repo: params.repo || undefined,
    role,
  };
}

/**
 * Work: the workspace's work items, newest first, for every member,
 * Code or not. Filters are in a sheet (the ⚙ in the header, the chips
 * above the list, or Work in the bar again); pull down to read again,
 * and the list loads more as it nears its end.
 */
export default function WorkList() {
  const params = useLocalSearchParams<Params>();
  const { workspace, me } = useSignedIn();
  const slug = params.workspace ?? workspace?.slug;
  const colors = useColors();
  const linked = useMemo(() => filterOf(params), [params.state, params.label, params.milestone, params.assignee, params.repo, params.role]);
  const [filter, setFilter] = useState<WorkFilter>(linked);
  useEffect(() => setFilter(linked), [linked]);
  const [filtering, setFiltering] = useState(false);
  const items = useWorkItems(slug, filter);
  const milestones = useMilestones(filter.milestone ? slug : undefined);

  // Work in the bar again, on the list itself, opens its filters, as the site's bar opens Work's menu.
  const navigation = useNavigation();
  useEffect(() => {
    const tabs = navigation.getParent();
    if (!tabs) return;
    return tabs.addListener("tabPress" as never, () => {
      if (navigation.isFocused()) setFiltering(true);
    });
  }, [navigation]);

  const active = [
    filter.assignee ? { key: "assignee", label: filter.assignee === me.username ? "Assigned to me" : `@${filter.assignee}` } : null,
    filter.label ? { key: "label", label: filter.label } : null,
    filter.milestone ? { key: "milestone", label: milestones.data?.find((one) => one.number === filter.milestone)?.title ?? `Milestone ${filter.milestone}` } : null,
    filter.repo ? { key: "repo", label: filter.role ? `${filter.repo} · ${roleLabel(filter.role)}` : filter.repo } : null,
  ].filter((one): one is { key: keyof WorkFilter; label: string } => one !== null);

  const header = (
    <Stack.Screen
      options={{
        title: "Work",
        headerRight: () => (
          <Pressable accessibilityLabel="Filters" hitSlop={10} onPress={() => setFiltering(true)}>
            <SlidersHorizontal size={22} color={active.length ? colors.accent : colors.fg} />
          </Pressable>
        ),
      }}
    />
  );

  if (!slug) {
    return (
      <Screen>
        {header}
        <Empty icon={ListTodo} title="No workspace yet" body="Create or join a workspace on g1t, then come back." />
      </Screen>
    );
  }

  return (
    <Screen>
      {header}
      <View style={[styles.bar, { borderBottomColor: colors.line }]}>
        <Segments
          value={filter.state}
          onChange={(state) => setFilter({ ...filter, state })}
          options={[
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
            { value: "all", label: "All" },
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
                onPress={() => setFilter({ ...filter, [one.key]: undefined, ...(one.key === "repo" ? { role: undefined } : {}) })}
              />
            ))}
          </View>
        ) : null}
      </View>

      {items.isPending ? (
        <Loading />
      ) : items.error ? (
        <ErrorView error={items.error} retry={() => items.refetch()} />
      ) : (
        <FlatList
          data={items.items}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={items.isRefetching && !items.isFetchingNextPage} onRefresh={() => items.refetch()} tintColor={colors.accent} />}
          onEndReached={() => items.hasNextPage && !items.isFetchingNextPage && items.fetchNextPage()}
          onEndReachedThreshold={0.5}
          contentContainerStyle={{ paddingBottom: 96, flexGrow: 1 }}
          ListFooterComponent={items.isFetchingNextPage ? <ActivityIndicator color={colors.accent} style={{ padding: space.lg }} /> : null}
          ListEmptyComponent={
            <Empty
              icon={ListTodo}
              title={active.length ? "Nothing matches" : filter.state === "closed" ? "Nothing closed yet" : "No open work items"}
              body={active.length ? "Try fewer filters." : "Work items are any tracked work: a feature, a bug, a chore."}
            />
          }
          renderItem={({ item }) => (
            <ItemRow item={item} onPress={() => router.push({ pathname: "/work/[number]", params: { number: String(item.number), workspace: item.workspace } })} />
          )}
        />
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New work item"
        onPress={() => router.push({ pathname: "/work/new", params: { workspace: slug } })}
        style={({ pressed }) => [styles.fab, { backgroundColor: colors.accent, opacity: pressed ? 0.85 : 1 }]}
      >
        <Plus size={20} color={colors.onAccent} strokeWidth={2.5} />
        <Text style={{ color: colors.onAccent, fontWeight: "600" }}>New</Text>
      </Pressable>

      <Filters visible={filtering} workspace={slug} filter={filter} me={me.username} onClose={() => setFiltering(false)} onChange={setFilter} />
    </Screen>
  );
}

/** The list's filters, in a sheet: state, assigned to you, label, milestone, repository and its role. */
function Filters({
  visible,
  workspace,
  filter,
  me,
  onClose,
  onChange,
}: {
  visible: boolean;
  workspace: string;
  filter: WorkFilter;
  me: string;
  onClose: () => void;
  onChange: (filter: WorkFilter) => void;
}) {
  const colors = useColors();
  const { height } = useWindowDimensions();
  const labels = useLabels(visible ? workspace : undefined);
  const milestones = useMilestones(visible ? workspace : undefined);
  const repos = useRepos("");
  const set = (change: Partial<WorkFilter>) => onChange({ ...filter, ...change });
  const toggle = <K extends keyof WorkFilter>(key: K, value: WorkFilter[K]) => set({ [key]: filter[key] === value ? undefined : value } as Partial<WorkFilter>);

  return (
    <Sheet visible={visible} onClose={onClose}>
      <ScrollView style={{ maxHeight: height * 0.7 }} contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.lg, paddingBottom: space.md }}>
        <Text size="heading">Filters</Text>
        <Segments
          value={filter.state}
          onChange={(state) => set({ state })}
          options={[
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
            { value: "all", label: "All" },
          ]}
        />
        <View style={{ marginHorizontal: -space.lg }}>
          <Row
            title="Assigned to me"
            chevron={false}
            trailing={<Check on={filter.assignee === me} />}
            onPress={() => toggle("assignee", me)}
          />
        </View>
        <Group title="Label" empty={labels.isPending ? "…" : "No labels yet"}>
          {(labels.data ?? []).map((label) => (
            <Chip
              key={label.name}
              label={label.name}
              tone={filter.label === label.name ? "accent" : "neutral"}
              leading={<View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: `#${label.color}` }} />}
              onPress={() => toggle("label", label.name)}
            />
          ))}
        </Group>
        <Group title="Milestone" empty={milestones.isPending ? "…" : "No open milestones"}>
          {(milestones.data ?? []).map((milestone) => (
            <Chip
              key={milestone.number}
              label={milestone.title}
              tone={filter.milestone === milestone.number ? "accent" : "neutral"}
              onPress={() => toggle("milestone", milestone.number)}
            />
          ))}
        </Group>
        <Group title="Repository" empty={repos.isPending ? "…" : "No repositories you can see"}>
          {(repos.data ?? []).map((repo) => (
            <Chip
              key={repo.id}
              label={repo.name}
              tone={filter.repo === repo.name ? "accent" : "neutral"}
              onPress={() => set({ repo: filter.repo === repo.name ? undefined : repo.name, role: undefined })}
            />
          ))}
        </Group>
        {filter.repo ? (
          <View style={{ gap: space.sm }}>
            <Text size="small" tone="muted">
              Linked to {filter.repo} as
            </Text>
            <Segments
              value={filter.role ?? "any"}
              onChange={(role) => set({ role: role === "any" ? undefined : (role as LinkRole) })}
              options={[
                { value: "any", label: "Any" },
                { value: "origin", label: "Origin" },
                { value: "target", label: "Target" },
                { value: "touched", label: "Touched" },
              ]}
            />
          </View>
        ) : null}
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button title="Clear" variant="secondary" onPress={() => onChange({ state: "open" })} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Done" onPress={onClose} />
          </View>
        </View>
      </ScrollView>
    </Sheet>
  );
}

function Group({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <View style={{ gap: space.sm }}>
      <Text size="small" tone="muted">
        {title}
      </Text>
      {children.length ? (
        <View style={styles.chips}>{children}</View>
      ) : (
        <Text size="small" tone="faint">
          {empty}
        </Text>
      )}
    </View>
  );
}

function Check({ on }: { on: boolean }) {
  const colors = useColors();
  return (
    <View style={[styles.check, { borderColor: on ? colors.accent : colors.lineStrong, backgroundColor: on ? colors.accent : "transparent" }]}>
      {on ? <CheckIcon size={14} color={colors.onAccent} strokeWidth={3} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  fab: {
    position: "absolute",
    right: space.lg,
    bottom: space.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.lg,
    height: 48,
    borderRadius: radius.full,
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: "center", justifyContent: "center" },
});
