import { Stack, router, useLocalSearchParams } from "expo-router";
import { GitPullRequest, ListTodo } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, View } from "react-native";

import { Checks, PullIcon } from "@/components/code";
import { Segments } from "@/components/segments";
import { Empty, ErrorView, Loading, Row, Screen, Text } from "@/components/ui";
import { ItemRow } from "@/components/work";
import { type ApiPull, useDescriptions, usePulls } from "@/lib/code";
import { ago } from "@/lib/time";
import { useWorkItems } from "@/lib/work";
import { space, useColors } from "@/theme";

type Tab = "pulls" | "work";
type State = "open" | "closed";

/**
 * A repository: its pull requests, and its Work: the workspace's work
 * items linked to it, in any role.
 */
export default function Repository() {
  const { owner, repo } = useLocalSearchParams<{ owner: string; repo: string }>();
  const [tab, setTab] = useState<Tab>("pulls");
  const [state, setState] = useState<State>("open");
  const description = useDescriptions(owner).data?.[`${owner}/${repo}`.toLowerCase()];
  const pulls = usePulls(owner, repo, state);
  const work = useWorkItems(owner, { state, repo });
  const list = tab === "pulls" ? pulls : work;
  const colors = useColors();

  return (
    <Screen>
      <Stack.Screen options={{ title: repo }} />
      <View style={{ padding: space.lg, gap: space.md }}>
        <Text size="small" tone="muted">
          {owner}/{repo}
          {description ? ` · ${description}` : ""}
        </Text>
        <Segments
          value={tab}
          onChange={setTab}
          options={[
            { value: "pulls", label: "Pull requests" },
            { value: "work", label: "Work" },
          ]}
        />
        <Segments
          value={state}
          onChange={setState}
          options={[
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
          ]}
        />
      </View>
      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <ErrorView error={list.error} retry={() => list.refetch()} />
      ) : tab === "pulls" ? (
        <FlatList
          data={pulls.data}
          keyExtractor={(pull) => pull.id}
          refreshControl={<RefreshControl refreshing={pulls.isRefetching} onRefresh={() => pulls.refetch()} tintColor={colors.accent} />}
          ListEmptyComponent={<Empty icon={GitPullRequest} title={`No ${state} pull requests`} />}
          renderItem={({ item }) => <PullRow pull={item} owner={owner} repo={repo} />}
        />
      ) : (
        <FlatList
          data={work.items}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl refreshing={work.isRefetching && !work.isFetchingNextPage} onRefresh={() => work.refetch()} tintColor={colors.accent} />
          }
          onEndReached={() => work.hasNextPage && !work.isFetchingNextPage && work.fetchNextPage()}
          onEndReachedThreshold={0.5}
          ListFooterComponent={work.isFetchingNextPage ? <ActivityIndicator color={colors.accent} style={{ padding: space.lg }} /> : null}
          ListEmptyComponent={<Empty icon={ListTodo} title={`No ${state} work items`} body={`Work items linked to ${repo} show here.`} />}
          renderItem={({ item }) => (
            <ItemRow
              item={item}
              onPress={() => router.push({ pathname: "/work/[number]", params: { number: String(item.number), workspace: item.workspace } })}
            />
          )}
        />
      )}
    </Screen>
  );
}

function PullRow({ pull, owner, repo }: { pull: ApiPull; owner: string; repo: string }) {
  const by = pull.author.display_username ?? pull.author.username;
  return (
    <Row
      leading={<PullIcon pull={pull} />}
      title={pull.title}
      subtitle={`#${pull.number} · ${by}${pull.agent ? ` with ${pull.agent}` : ""}${pull.item ? ` · for #${pull.item}` : ""} · ${ago(pull.updated_at)}`}
      trailing={<Checks status={pull.check_status} />}
      onPress={() => router.push({ pathname: "/code/[owner]/[repo]/pull/[number]", params: { owner, repo, number: String(pull.number) } })}
    />
  );
}
