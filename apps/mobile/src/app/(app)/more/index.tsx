import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import { Stack } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Bell, BellRing, Check, ExternalLink, LogOut } from "lucide-react-native";
import { Linking, View } from "react-native";

import { Avatar, Badge, Button, Row, Screen, SectionHeader, Text } from "@/components/ui";
import { pushState, registerForPush, sendTestPush } from "@/lib/push";
import { isHosted, siteUrl } from "@/lib/server";
import { useSignedIn } from "@/lib/session";
import { space, useColors } from "@/theme";

/** More: your workspaces, notifications on this phone, how you signed in, and signing out. */
export default function More() {
  const { me, workspace, server, client, selectWorkspace, signOut } = useSignedIn();
  const colors = useColors();
  const queries = useQueryClient();
  const name = me.display_username ?? me.username;
  const oauth = client.credentials.kind === "oauth";
  const push = useQuery({ queryKey: ["push-state", server.site], queryFn: () => pushState(server) });
  const test = useMutation({ mutationFn: () => sendTestPush(client) });

  const pushRow = {
    unsupported: { label: "Not here", detail: "Notifications need a build of the app on a phone: not Expo Go on Android, nor a simulator." },
    off: { label: "Off", detail: `${new URL(server.site).host} sends no notifications to phones. Chat still updates while the app is open.` },
    denied: { label: "Off", detail: "Turned off for g1t in your phone's settings. Tap to open them." },
    undetermined: { label: "Off", detail: "Tap to get notified of messages to you, mentions and replies." },
    granted: { label: "On", detail: "Messages to you, mentions and replies, when you're not at g1t elsewhere." },
  }[push.data ?? "undetermined"];

  return (
    <Screen scroll style={{ paddingHorizontal: 0 }}>
      <Stack.Screen options={{ title: "More" }} />
      <View style={{ flexDirection: "row", gap: space.md, alignItems: "center", paddingHorizontal: space.lg }}>
        <Avatar name={name} uri={me.avatar ? `${server.site}/avatars/${me.avatar}` : null} size={48} />
        <View style={{ flex: 1 }}>
          <Text size="heading">{name}</Text>
          <Text size="small" tone="muted">
            @{me.username} · {isHosted(server) ? "g1t.sh" : new URL(server.site).host}
          </Text>
        </View>
      </View>

      <View>
        <Row
          leading={<Bell size={22} color={colors.accent} />}
          title="Notifications on this phone"
          subtitle={pushRow.detail}
          trailing={<Badge label={pushRow.label} tone={push.data === "granted" ? "success" : "neutral"} />}
          chevron={false}
          onPress={
            push.data === "denied"
              ? () => void Linking.openSettings()
              : push.data === "undetermined"
                ? () => void registerForPush(client, true).finally(() => queries.invalidateQueries({ queryKey: ["push-state", server.site] }))
                : undefined
          }
        />
        {push.data === "granted" ? (
          <Row
            leading={<BellRing size={22} color={colors.accent} />}
            title="Send a test notification"
            subtitle={
              test.isPending
                ? "Sending…"
                : test.error
                  ? test.error.message
                  : test.data !== undefined
                    ? test.data > 0
                      ? `Sent to ${test.data} ${test.data === 1 ? "place" : "places"}: this phone, and any browser with notifications on.`
                      : "Nothing was sent: g1t has no phone or browser for you. Sign out and in again to register this phone."
                    : "To check this phone gets them. It arrives in a few seconds, even with the app open; if it never does, see the setup guide's troubleshooting."
            }
            chevron={false}
            onPress={test.isPending ? undefined : () => test.mutate()}
          />
        ) : null}
      </View>

      <View>
        <SectionHeader title="Workspaces" />
        {(me.workspaces ?? []).map((one) => (
          <Row
            key={one.slug}
            leading={<Avatar name={one.name ?? one.slug} uri={one.avatar ? `${server.site}/avatars/${one.avatar}` : null} />}
            title={one.name ?? one.slug}
            subtitle={`${one.slug} · ${one.role}`}
            trailing={one.slug === workspace?.slug ? <Check size={18} color={colors.accent} /> : null}
            chevron={false}
            onPress={() => selectWorkspace(one.slug)}
          />
        ))}
      </View>

      <View>
        <SectionHeader title="Signed in" />
        <Row
          title={oauth ? "With g1t" : "With an access token"}
          subtitle={oauth ? "End or narrow the app's access in Settings → Connected applications." : "The token you pasted. Delete it in Settings → Access tokens to end it."}
          trailing={<ExternalLink size={16} color={colors.faint} />}
          chevron={false}
          onPress={() => WebBrowser.openBrowserAsync(siteUrl(server, oauth ? "/settings/applications" : "/settings/tokens"))}
        />
      </View>

      <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
        <Button title="Sign out" variant="danger" icon={LogOut} onPress={signOut} />
        <Text size="small" tone="faint" style={{ textAlign: "center" }}>
          g1t {Constants.expoConfig?.version ?? ""}
        </Text>
      </View>
    </Screen>
  );
}
