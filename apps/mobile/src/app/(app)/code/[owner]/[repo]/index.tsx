import { Stack, router, useLocalSearchParams } from "expo-router";
import { CircleDot, GitPullRequest } from "lucide-react-native";
import { useState } from "react";
import { FlatList, RefreshControl, View } from "react-native";

import { Checks, IssueIcon, PullIcon } from "@/components/code";
import { Segments } from "@/components/segments";
import { Empty, ErrorView, Loading, Row, Screen, Text } from "@/components/ui";
import { type ApiIssue, type ApiPull, useDescriptions, useIssues, usePulls } from "@/lib/code";
import { ago } from "@/lib/time";
import { space, useColors } from "@/theme";

type Tab = "pulls" | "issues";
type State = "open" | "closed";

/** A repository: its pull requests and issues. */
export default function Repository() {
  const { owner, repo } = useLocalSearchParams<{ owner: string; repo: string }>();
  const [tab, setTab] = useState<Tab>("pulls");
  const [state, setState] = useState<State>("open");
  const description = useDescriptions(owner).data?.[`${owner}/${repo}`.toLowerCase()];
  const pulls = usePulls(owner, repo, state);
  const issues = useIssues(owner, repo, state);
  const list = tab === "pulls" ? pulls : issues;
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
            { value: "issues", label: "Issues" },
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
          data={issues.data}
          keyExtractor={(issue) => issue.id}
          refreshControl={<RefreshControl refreshing={issues.isRefetching} onRefresh={() => issues.refetch()} tintColor={colors.accent} />}
          ListEmptyComponent={<Empty icon={CircleDot} title={`No ${state} issues`} />}
          renderItem={({ item }) => <IssueRow issue={item} owner={owner} repo={repo} />}
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
      subtitle={`#${pull.number} · ${by}${pull.agent ? ` with ${pull.agent}` : ""} · ${ago(pull.updated_at)}`}
      trailing={<Checks status={pull.check_status} />}
      onPress={() => router.push({ pathname: "/code/[owner]/[repo]/pull/[number]", params: { owner, repo, number: String(pull.number) } })}
    />
  );
}

function IssueRow({ issue, owner, repo }: { issue: ApiIssue; owner: string; repo: string }) {
  const by = issue.author.display_username ?? issue.author.username;
  return (
    <Row
      leading={<IssueIcon issue={issue} />}
      title={issue.title}
      subtitle={`#${issue.number} · ${by} · ${ago(issue.updated_at)}${issue.comment_count ? ` · ${issue.comment_count} comments` : ""}`}
      onPress={() => router.push({ pathname: "/code/[owner]/[repo]/issues/[number]", params: { owner, repo, number: String(issue.number) } })}
    />
  );
}
