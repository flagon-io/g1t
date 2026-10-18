import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { ExternalLink, FileCode, GitPullRequest, ListTodo, MessageSquareText, Sparkles, StickyNote, Terminal, User, Wrench } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";

import { StateDot, openItem, openPull, stateName, useCode } from "@/components/sessions";
import { Badge, Button, ErrorView, Loading, Row, Screen, SectionHeader, Text } from "@/components/ui";
import { Chip, repoName } from "@/components/work";
import { siteUrl } from "@/lib/server";
import { useSignedIn } from "@/lib/session";
import { type ApiSessionEntry, type ApiSessionLink, type EntryKind, harnessName, sessionTitle, subagentTree, touchedFiles } from "@/lib/sessions";
import { ago, clock } from "@/lib/time";
import { useWorkspaceSession } from "@/lib/work";
import { radius, space, useColors } from "@/theme";

/** How many files show before "Show all". */
const FILES = 20;

/**
 * One session: who runs it in what, where, and its state; the work item
 * and pull request it is on; its subagents as a tree; the files it
 * touched; and what it recorded, step by step. While it is live it is
 * read again every 15 s.
 */
export default function SessionScreen() {
  const params = useLocalSearchParams<{ id: string; workspace?: string }>();
  const { server, workspace: current } = useSignedIn();
  const workspace = params.workspace ?? current?.slug ?? "";
  const colors = useColors();
  const code = useCode();
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const query = useWorkspaceSession(workspace, params.id, focused);
  const [allFiles, setAllFiles] = useState(false);
  const sitePath = `/${workspace}/-/work/sessions/${params.id}`;

  const title = (
    <Stack.Screen
      options={{
        title: "Session",
        headerRight: () => (
          <Pressable accessibilityLabel="Open on g1t" hitSlop={10} onPress={() => void WebBrowser.openBrowserAsync(siteUrl(server, sitePath))}>
            <ExternalLink size={20} color={colors.fg} />
          </Pressable>
        ),
      }}
    />
  );
  if (query.isPending || query.error || !query.detail) {
    return (
      <Screen>
        {title}
        {query.error ? <ErrorView error={query.error} retry={() => query.refetch()} /> : <Loading />}
      </Screen>
    );
  }

  const { session, repo, children = [], touched, skills = [], root, limited } = query.detail;
  const links: ApiSessionLink[] = query.detail.links?.length
    ? query.detail.links
    : [
        ...(session.item ? [{ kind: "item" as const, number: session.item, title: "", state: "", via: ["attached"], session_ids: [session.id] }] : []),
        ...(session.pull ? [{ kind: "pull" as const, number: session.pull, title: "", state: "", via: ["attached"], session_ids: [session.id] }] : []),
      ];
  const tree = subagentTree(session.id, children);
  const files = touchedFiles(touched);
  const facts = [harnessName(session.harness), `@${session.actor.username}`, session.model].filter(Boolean).join(" · ");
  const openSession = (id: string) => router.push({ pathname: "/work/sessions/[id]", params: { id, workspace } });

  return (
    <Screen>
      {title}
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => query.refetch()} tintColor={colors.accent} />}
      >
        <View style={{ gap: space.sm }}>
          <Text size="heading" selectable>
            {sessionTitle(session)}
          </Text>
          <View style={styles.wrap}>
            <StateDot state={session.state} />
            <Text size="small" style={{ fontWeight: "600", color: session.state === "active" ? colors.success : session.state === "idle" ? colors.warn : colors.muted }}>
              {stateName(session.state)}
            </Text>
            <Text size="small" tone="muted">
              {facts}
            </Text>
          </View>
          <Text size="small" tone="muted">
            {repoName(repo, workspace)}
            {session.branch ? ` · ${session.branch}` : ""}
          </Text>
          <Text size="small" tone="muted">
            Started {ago(session.started_at)} · last heard from {ago(session.last_seen_at)}
            {session.ended_at ? ` · ended ${ago(session.ended_at)}${session.end_reason ? ` (${session.end_reason.replace(/_/g, " ")})` : ""}` : ""}
          </Text>
          {session.agent_type || session.task ? (
            <Text size="small" tone="muted">
              {[session.agent_type, session.task].filter(Boolean).join(": ")}
            </Text>
          ) : null}
          {root && root.id !== session.id ? (
            <View style={styles.wrap}>
              <Text size="small" tone="muted">
                A subagent of
              </Text>
              <Chip label={sessionTitle(root)} onPress={() => openSession(root.id)} />
            </View>
          ) : null}
          {skills.length ? (
            <View style={styles.wrap}>
              {skills.map((skill) => (
                <Chip key={`${skill.session_id}:${skill.name}`} label={skill.uses > 1 ? `${skill.name} ×${skill.uses}` : skill.name} leading={<Sparkles size={12} color={colors.muted} />} />
              ))}
            </View>
          ) : null}
          {limited ? (
            <Text size="small" tone="faint">
              You are not a member of this workspace: you see that it runs, who runs it and what it is tied to, nothing more.
            </Text>
          ) : null}
        </View>

        {links.length ? (
          <View style={{ marginHorizontal: -space.lg }}>
            <SectionHeader title="Working on" />
            {links.map((link) => (
              <Row
                key={`${link.kind}:${link.number}`}
                leading={link.kind === "item" ? <ListTodo size={20} color={colors.muted} /> : <GitPullRequest size={20} color={colors.muted} />}
                title={`#${link.number}${link.title ? ` ${link.title}` : ""}`}
                subtitle={[link.kind === "item" ? "Work item" : "Pull request", link.state, link.via.join(", ")].filter(Boolean).join(" · ")}
                onPress={() => (link.kind === "item" ? openItem(workspace, link.number) : openPull(repo, link.number, code))}
              />
            ))}
          </View>
        ) : null}

        {tree.length ? (
          <View style={{ marginHorizontal: -space.lg }}>
            <SectionHeader title={`Subagents · ${tree.length}`} />
            {tree.map(({ session: child, depth }) => (
              <View key={child.id} style={{ paddingLeft: (depth - 1) * space.lg }}>
                <Row
                  leading={<StateDot state={child.state} />}
                  title={sessionTitle(child)}
                  subtitle={[child.agent_type, child.state === "ended" ? `ended ${ago(child.ended_at ?? child.last_seen_at)}` : `heard from ${ago(child.last_seen_at)}`].filter(Boolean).join(" · ")}
                  onPress={() => openSession(child.id)}
                />
              </View>
            ))}
          </View>
        ) : null}

        {files.length ? (
          <View style={{ gap: space.xs }}>
            <View style={{ marginHorizontal: -space.lg }}>
              <SectionHeader title={`Touched · ${files.length}`} />
            </View>
            {(allFiles ? files : files.slice(0, FILES)).map((path) => (
              <View key={path} style={styles.file}>
                <FileCode size={14} color={colors.faint} />
                <Text size="mono" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
                  {path}
                </Text>
              </View>
            ))}
            {files.length > FILES && !allFiles ? (
              <Pressable onPress={() => setAllFiles(true)} hitSlop={8}>
                <Text size="small" tone="accent">
                  Show all {files.length}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={{ gap: space.sm }}>
          <View style={{ marginHorizontal: -space.lg }}>
            <SectionHeader title="Timeline" />
          </View>
          {query.entries.length === 0 ? (
            <Text tone="muted">{limited ? "Its steps are not shown to you." : "Nothing recorded yet."}</Text>
          ) : (
            query.entries.map((entry) => <Entry key={entry.seq} entry={entry} />)
          )}
          {query.hasNextPage ? (
            <Button title="Show later steps" variant="secondary" busy={query.isFetchingNextPage} onPress={() => void query.fetchNextPage()} />
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

const ENTRY_KINDS: Record<EntryKind, { label: string; icon: LucideIcon }> = {
  prompt: { label: "Prompt", icon: User },
  message: { label: "Message", icon: MessageSquareText },
  tool_call: { label: "Tool", icon: Wrench },
  tool_result: { label: "Result", icon: Terminal },
  note: { label: "Note", icon: StickyNote },
  skill: { label: "Skill", icon: Sparkles },
};

/** One recorded step: its kind, tool and time, then its text, a few lines until tapped. */
function Entry({ entry }: { entry: ApiSessionEntry }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const kind = ENTRY_KINDS[entry.kind] ?? { label: entry.kind, icon: StickyNote };
  const Icon = kind.icon;
  const result = entry.kind === "tool_result" || entry.kind === "tool_call";
  return (
    <Pressable onPress={() => setOpen(!open)} style={[styles.entry, { borderColor: colors.line, backgroundColor: entry.kind === "prompt" ? colors.raised : colors.surface }]}>
      <View style={styles.wrap}>
        <Icon size={13} color={entry.kind === "prompt" ? colors.accent : colors.muted} />
        <Text size="small" style={{ fontWeight: "600", color: colors.fgSoft }}>
          {kind.label}
        </Text>
        {entry.tool ? <Badge label={entry.tool} /> : null}
        <Text size="small" tone="faint" style={{ marginLeft: "auto" }}>
          {clock(entry.at)}
        </Text>
      </View>
      {entry.withheld ? (
        <Text size="small" tone="faint" style={{ fontStyle: "italic" }}>
          Not shown to you.
        </Text>
      ) : entry.text ? (
        <Text size={result ? "mono" : "small"} tone={result ? "muted" : "default"} numberOfLines={open ? undefined : 4} selectable={open}>
          {entry.text}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg, paddingBottom: space.xl },
  wrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  file: { flexDirection: "row", alignItems: "center", gap: space.sm },
  entry: { borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.xs },
});
