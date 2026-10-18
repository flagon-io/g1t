import { hasCodeAccess } from "@g1t/contracts";
import { router } from "expo-router";
import { Bot, GitPullRequest, ListTodo, Network, Sparkles, StickyNote, Terminal } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "@/components/ui";
import { Chip, repoName } from "@/components/work";
import { sessionRoute } from "@/lib/links";
import { useSignedIn } from "@/lib/session";
import { type ApiWorkspaceSession, type SessionKind, type SessionState, listTitle, runsIn } from "@/lib/sessions";
import { ago } from "@/lib/time";
import { space, useColors } from "@/theme";

const KIND_ICONS: Record<SessionKind, LucideIcon> = { harness: Terminal, hosted: Sparkles, agent: Bot, recorded: StickyNote };

/** What a session runs in, as an icon. */
export function KindIcon({ kind, size = 14, color }: { kind: SessionKind; size?: number; color?: string }) {
  const colors = useColors();
  const Icon = KIND_ICONS[kind];
  return <Icon size={size} color={color ?? colors.muted} />;
}

const STATE_NAMES: Record<SessionState, string> = { active: "Live", idle: "Idle", ended: "Ended" };

export function stateName(state: SessionState): string {
  return STATE_NAMES[state];
}

/** A session's state as a dot: live, idle, or ended. */
export function StateDot({ state, size = 10 }: { state: SessionState; size?: number }) {
  const colors = useColors();
  const color = state === "active" ? colors.success : state === "idle" ? colors.warn : colors.faint;
  return <View accessibilityLabel={stateName(state)} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

/** Whether the person signed in has Code in the workspace, so a pull request opens in the app. */
export function useCode(): boolean {
  const { workspace } = useSignedIn();
  return !workspace || hasCodeAccess(workspace);
}

export function openItem(workspace: string, number: number) {
  router.push({ pathname: "/work/[number]", params: { number: String(number), workspace } });
}

/** A pull request: its screen in Code, or its page on the site without Code. */
export function openPull(repo: string, number: number, code: boolean, session = false) {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) return;
  if (code) router.push({ pathname: "/code/[owner]/[repo]/pull/[number]", params: { owner, repo: name, number: String(number) } });
  else router.push({ pathname: "/open", params: { path: `/${owner}/${name}/pull/${number}${session ? "/session" : ""}` } });
}

/**
 * One session in a list: what it is, who runs it in what, where, the work
 * item and pull request it is on, and when it was last heard from.
 */
export function SessionCard({ session, workspace }: { session: ApiWorkspaceSession; workspace: string }) {
  const colors = useColors();
  const code = useCode();
  const route = sessionRoute(session, workspace, code);
  const where = [repoName(session.repo, workspace), session.branch].filter(Boolean).join(" · ");
  return (
    <Pressable
      onPress={route ? () => router.push(route as never) : undefined}
      disabled={!route}
      style={({ pressed }) => [styles.card, { borderBottomColor: colors.line, backgroundColor: pressed ? colors.raised : "transparent" }]}
    >
      <View style={{ paddingTop: 6 }}>
        <StateDot state={session.state} />
      </View>
      <View style={{ flex: 1, gap: 6 }}>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Text numberOfLines={2} style={{ fontWeight: "600", flex: 1 }}>
            {listTitle(session)}
          </Text>
          <Text size="small" tone="faint">
            {ago(session.last_activity_at)}
          </Text>
        </View>
        <View style={styles.meta}>
          <KindIcon kind={session.kind} />
          <Text size="small" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
            {runsIn(session)}
            {session.actor ? ` · @${session.actor}` : ""}
            {where ? ` · ${where}` : ""}
          </Text>
        </View>
        {session.step ? (
          <Text size="small" tone="muted" numberOfLines={1}>
            {session.step}
          </Text>
        ) : null}
        {session.item || session.pull || session.subagents ? (
          <View style={styles.meta}>
            {session.item ? (
              <Chip
                label={`#${session.item}${session.item_title ? ` ${session.item_title}` : ""}`}
                leading={<ListTodo size={12} color={colors.muted} />}
                onPress={() => openItem(workspace, session.item!)}
              />
            ) : null}
            {session.pull ? (
              <Chip
                label={`#${session.pull}${session.pull_status ? ` · ${session.pull_status}` : ""}`}
                leading={<GitPullRequest size={12} color={session.pull_status === "merged" ? colors.merged : session.pull_status === "open" ? colors.success : colors.muted} />}
                onPress={() => openPull(session.repo, session.pull!, code)}
              />
            ) : null}
            {session.subagents ? (
              <View style={styles.count}>
                <Network size={13} color={colors.faint} />
                <Text size="small" tone="faint">
                  {session.subagents} {session.subagents === 1 ? "subagent" : "subagents"}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  count: { flexDirection: "row", alignItems: "center", gap: 3 },
});
