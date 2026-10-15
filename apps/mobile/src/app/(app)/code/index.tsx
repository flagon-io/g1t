import { hasCodeAccess } from "@g1t/contracts";
import { Stack, router } from "expo-router";
import { BookLock, BookMarked, Code2 } from "lucide-react-native";
import { useState } from "react";
import { FlatList, RefreshControl, View } from "react-native";

import { Badge, Empty, ErrorView, Field, Loading, Row, Screen } from "@/components/ui";
import { useDescriptions, useRepos } from "@/lib/code";
import { useSignedIn } from "@/lib/session";
import { ago } from "@/lib/time";
import { space, useColors } from "@/theme";

/** Code: the workspace's repositories you can see, newest first. */
export default function Repos() {
  const { workspace } = useSignedIn();
  const [search, setSearch] = useState("");
  const repos = useRepos(search.trim());
  const descriptions = useDescriptions(workspace?.slug);
  const colors = useColors();

  if (workspace && !hasCodeAccess(workspace)) {
    return (
      <Screen>
        <Stack.Screen options={{ title: "Code" }} />
        <Empty icon={Code2} title="Code is not on for you here" body={`${workspace.name ?? workspace.slug} gives you Chat and Docs. Ask an owner for Code.`} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: "Code" }} />
      <View style={{ padding: space.lg, paddingBottom: space.sm }}>
        <Field label="Find a repository" placeholder="Name" value={search} onChangeText={setSearch} returnKeyType="search" />
      </View>
      {repos.isPending ? (
        <Loading />
      ) : repos.error ? (
        <ErrorView error={repos.error} retry={() => repos.refetch()} />
      ) : (
        <FlatList
          data={repos.data}
          keyExtractor={(repo) => repo.id}
          refreshControl={<RefreshControl refreshing={repos.isRefetching} onRefresh={() => repos.refetch()} tintColor={colors.accent} />}
          ListEmptyComponent={<Empty icon={BookMarked} title={search ? "Nothing matches" : "No repositories yet"} />}
          renderItem={({ item }) => (
            <Row
              leading={item.is_private ? <BookLock size={20} color={colors.muted} /> : <BookMarked size={20} color={colors.muted} />}
              title={`${item.namespace}/${item.name}`}
              subtitle={descriptions.data?.[`${item.namespace}/${item.name}`.toLowerCase()] ?? `Created ${ago(item.created_at)}`}
              trailing={item.archived_at ? <Badge label="Archived" tone="warn" /> : null}
              onPress={() => router.push({ pathname: "/code/[owner]/[repo]", params: { owner: item.namespace, repo: item.name } })}
            />
          )}
        />
      )}
    </Screen>
  );
}
