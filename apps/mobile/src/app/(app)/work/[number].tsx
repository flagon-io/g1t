import * as Clipboard from "expo-clipboard";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import * as WebBrowser from "expo-web-browser";
import { CircleCheck, CircleDot, CircleX, Copy, ExternalLink, FolderGit2, Link2, Plus, Search, Unlink } from "lucide-react-native";
import { useState } from "react";
import { Alert, KeyboardAvoidingView, RefreshControl, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";

import { Sheet, SheetAction } from "@/components/chat/sheet";
import { Body, Checks, PullIcon, Timeline } from "@/components/code";
import { Badge, Button, ErrorView, Loading, Row, Screen, SectionHeader, Text } from "@/components/ui";
import { Chip, CommentBar, ItemIcon, repoName, roleLabel, stateLabel } from "@/components/work";
import { useRepos } from "@/lib/code";
import { siteUrl } from "@/lib/server";
import { useSignedIn } from "@/lib/session";
import { ago } from "@/lib/time";
import { type ApiItemRepo, type ApiWorkPull, type ApiWorkRepo, useItemActions, useWorkContext, useWorkItem } from "@/lib/work";
import { radius, space, useColors } from "@/theme";

/**
 * A work item: what it asks for, the repositories it is linked to (where
 * it came from, where it is meant to land, and what has landed where),
 * each one's pull requests for it, and its conversation. The bar at the
 * foot comments, and its ⋯ closes, reopens and links a repository.
 */
export default function WorkItem() {
  const params = useLocalSearchParams<{ number: string; workspace?: string }>();
  const { server, workspace: current } = useSignedIn();
  const workspace = params.workspace ?? current?.slug ?? "";
  const number = Number(params.number);
  const detail = useWorkItem(workspace, number);
  const context = useWorkContext(workspace, number);
  const actions = useItemActions(workspace, number);
  const headerHeight = useHeaderHeight();
  const colors = useColors();
  const [more, setMore] = useState(false);
  const [linking, setLinking] = useState(false);
  const [picked, setPicked] = useState<ApiItemRepo | null>(null);

  const title = <Stack.Screen options={{ title: `#${number}` }} />;
  if (detail.isPending || detail.error) {
    return (
      <Screen>
        {title}
        {detail.error ? <ErrorView error={detail.error} retry={() => detail.refetch()} /> : <Loading />}
      </Screen>
    );
  }

  const { item, comments } = detail.data;
  const by = item.author.display_username ?? item.author.username;
  const refs = { workspace };
  const sitePath = `/${workspace}/-/work/${number}`;
  // The context has each repository's pull requests; the item alone still has its repositories.
  const repos: ApiWorkRepo[] = context.data?.repos ?? item.repos.map((repo) => ({ ...repo, pulls: [] }));
  const missing = context.data?.missing ?? item.repos.filter((repo) => repo.role === "target" && !repo.landed).map((repo) => repo.path);
  const linked = new Set(repos.map((repo) => repo.path.toLowerCase()));
  const suggested = (context.data?.suggested_targets ?? []).filter((one) => !linked.has(one.path.toLowerCase()));

  const failed = (what: string) => (error: unknown) => Alert.alert(what, error instanceof Error ? error.message : "Something went wrong.");
  const close = (reason: "completed" | "not_planned") => {
    setMore(false);
    actions.close.mutate(reason, { onError: failed("Could not close it") });
  };
  const reopen = () => {
    setMore(false);
    actions.reopen.mutate(undefined, { onError: failed("Could not reopen it") });
  };
  const link = (repo: string) => {
    setLinking(false);
    actions.link.mutate({ repo, role: "target" }, { onError: failed("Could not link it") });
  };
  const openRepo = (path: string) => {
    const [owner, name] = path.split("/", 2);
    router.push({ pathname: "/code/[owner]/[repo]", params: { owner, repo: name } });
  };
  const openPull = (pull: ApiWorkPull) => {
    const [owner, name] = pull.repo.split("/", 2);
    router.push({ pathname: "/code/[owner]/[repo]/pull/[number]", params: { owner, repo: name, number: String(pull.number) } });
  };
  const busy = actions.close.isPending || actions.reopen.isPending;

  return (
    <Screen>
      {title}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={headerHeight}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          refreshControl={
            <RefreshControl refreshing={detail.isRefetching} onRefresh={() => Promise.all([detail.refetch(), context.refetch()])} tintColor={colors.accent} />
          }
        >
          <View style={{ gap: space.sm }}>
            <Text size="heading" selectable>
              {item.title}
            </Text>
            <View style={styles.wrap}>
              <ItemIcon item={item} size={18} />
              <Text size="small" style={{ fontWeight: "600", color: item.state === "open" ? colors.success : colors.muted }}>
                {stateLabel(item)}
              </Text>
              <Text size="small" tone="muted">
                #{item.number} · {by} · {ago(item.created_at)}
              </Text>
            </View>
            {item.labels.length || item.milestone || item.assignees.length ? (
              <View style={styles.wrap}>
                {item.labels.map((label) => (
                  <Chip key={label} label={label} />
                ))}
                {item.milestone ? <Chip label={item.milestone.title} /> : null}
                {item.assignees.map((name) => (
                  <Chip key={name} label={`@${name}`} />
                ))}
              </View>
            ) : null}
          </View>

          <Body text={item.body} refs={refs} />

          <View style={{ marginHorizontal: -space.lg }}>
            <SectionHeader title="Repositories" />
            {repos.length === 0 ? (
              <Text tone="muted" style={{ paddingHorizontal: space.lg }}>
                Not linked to a repository yet. Link the ones where the work is meant to land.
              </Text>
            ) : (
              repos.map((repo) => (
                <View key={repo.repo_id}>
                  <Row
                    leading={<FolderGit2 size={20} color={colors.muted} />}
                    title={repoName(repo.path, workspace)}
                    subtitle={`${roleLabel(repo.role)}${repo.legacy_number ? ` · was #${repo.legacy_number} there` : ""}`}
                    trailing={repo.landed ? <Badge label="Landed" tone="merged" /> : repo.role === "target" ? <Badge label="Not landed" tone="warn" /> : null}
                    // A deleted repository has nothing to open or unlink.
                    onPress={repo.path ? () => setPicked(repo) : undefined}
                  />
                  {repo.pulls.map((pull) => (
                    <View key={`${pull.repo}#${pull.number}`} style={{ paddingLeft: space.xl }}>
                      <Row
                        leading={<PullIcon pull={pull} />}
                        title={pull.title}
                        subtitle={`#${pull.number} · ${pull.status}`}
                        trailing={<Checks status={pull.check_status} />}
                        onPress={() => openPull(pull)}
                      />
                    </View>
                  ))}
                </View>
              ))
            )}
            {missing.length && item.state === "open" ? (
              <Text size="small" tone="muted" style={{ paddingHorizontal: space.lg, paddingTop: space.sm }}>
                Closes once it lands in {missing.map((path) => repoName(path, workspace)).join(", ")}.
              </Text>
            ) : null}
            <View style={{ paddingHorizontal: space.lg, paddingTop: space.md }}>
              <Button title="Link a repository" variant="secondary" icon={Link2} onPress={() => setLinking(true)} />
            </View>
          </View>

          {suggested.length ? (
            <View style={{ marginHorizontal: -space.lg }}>
              <SectionHeader title="Suggested" />
              {suggested.map((one) => (
                <Row
                  key={one.repo_id}
                  leading={<FolderGit2 size={20} color={colors.faint} />}
                  title={repoName(one.path, workspace)}
                  subtitle={one.why}
                  chevron={false}
                  trailing={
                    <Button
                      title="Add as target"
                      variant="secondary"
                      icon={Plus}
                      busy={actions.link.isPending && actions.link.variables?.repo === one.path}
                      onPress={() => link(one.path)}
                    />
                  }
                />
              ))}
            </View>
          ) : null}

          <Timeline comments={comments} refs={refs} />

          {item.state === "open" ? (
            <Button title="Close" variant="secondary" icon={CircleCheck} busy={busy} onPress={() => setMore(true)} />
          ) : (
            <Button title="Reopen" variant="secondary" icon={CircleDot} busy={busy} onPress={reopen} />
          )}
        </ScrollView>
        <CommentBar
          busy={actions.comment.isPending}
          onMore={() => setMore(true)}
          onSend={(body) => actions.comment.mutateAsync(body).catch((error: unknown) => (failed("Could not comment")(error), Promise.reject(error)))}
        />
      </KeyboardAvoidingView>

      <Sheet visible={more} onClose={() => setMore(false)}>
        {item.state === "open" ? (
          <>
            <SheetAction icon={CircleCheck} label="Close as done" onPress={() => close("completed")} />
            <SheetAction icon={CircleX} label="Close as not planned" onPress={() => close("not_planned")} />
          </>
        ) : (
          <SheetAction icon={CircleDot} label="Reopen" onPress={reopen} />
        )}
        <SheetAction
          icon={Link2}
          label="Link a repository"
          onPress={() => {
            setMore(false);
            setLinking(true);
          }}
        />
        <SheetAction
          icon={Copy}
          label="Copy link"
          onPress={() => {
            setMore(false);
            void Clipboard.setStringAsync(siteUrl(server, sitePath));
          }}
        />
        <SheetAction
          icon={ExternalLink}
          label="Open on g1t"
          onPress={() => {
            setMore(false);
            void WebBrowser.openBrowserAsync(siteUrl(server, sitePath));
          }}
        />
      </Sheet>

      <Sheet visible={picked !== null} onClose={() => setPicked(null)}>
        {picked ? (
          <>
            <Text size="heading" style={{ paddingHorizontal: space.lg }}>
              {picked.path}
            </Text>
            <SheetAction
              icon={FolderGit2}
              label="Open the repository"
              onPress={() => {
                setPicked(null);
                openRepo(picked.path);
              }}
            />
            {picked.role !== "origin" ? (
              <SheetAction
                icon={Unlink}
                label="Unlink it"
                danger
                onPress={() => {
                  setPicked(null);
                  actions.unlink.mutate(picked.path, { onError: failed("Could not unlink it") });
                }}
              />
            ) : null}
          </>
        ) : null}
      </Sheet>

      <LinkSheet visible={linking} linked={linked} onClose={() => setLinking(false)} onPick={link} />
    </Screen>
  );
}

/** Picks a repository of the workspace to link as a target. */
function LinkSheet({ visible, linked, onClose, onPick }: { visible: boolean; linked: Set<string>; onClose: () => void; onPick: (path: string) => void }) {
  const colors = useColors();
  const { height } = useWindowDimensions();
  const [search, setSearch] = useState("");
  const repos = useRepos(visible ? search.trim() : "");
  const choices = (repos.data ?? []).filter((repo) => !linked.has(`${repo.namespace}/${repo.name}`.toLowerCase()));
  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
        <Text size="heading">Link a repository</Text>
        <Text size="small" tone="muted">
          As a target: where the work is meant to land. It closes once it has landed in every target.
        </Text>
        <View style={[styles.search, { borderColor: colors.lineStrong, backgroundColor: colors.bg }]}>
          <Search size={16} color={colors.faint} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Find a repository"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            style={{ flex: 1, color: colors.fg, fontSize: 15, paddingVertical: space.sm }}
          />
        </View>
      </View>
      <ScrollView style={{ maxHeight: height * 0.5 }} keyboardShouldPersistTaps="handled">
        {repos.isPending ? (
          <Loading />
        ) : choices.length === 0 ? (
          <Text tone="muted" style={{ padding: space.lg }}>
            {search ? "Nothing matches." : "Every repository you can see is linked already."}
          </Text>
        ) : (
          choices.map((repo) => (
            <Row
              key={repo.id}
              leading={<FolderGit2 size={20} color={colors.muted} />}
              title={repo.name}
              subtitle={`${repo.namespace}/${repo.name}`}
              chevron={false}
              trailing={<Plus size={18} color={colors.accent} />}
              onPress={() => onPick(`${repo.namespace}/${repo.name}`)}
            />
          ))
        )}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg, paddingBottom: space.xl },
  wrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md },
});
