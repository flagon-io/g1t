import Constants from "expo-constants";
import { Stack } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Check, ExternalLink, LogOut } from "lucide-react-native";
import { View } from "react-native";

import { Avatar, Button, Row, Screen, SectionHeader, Text } from "@/components/ui";
import { isHosted, siteUrl } from "@/lib/server";
import { useSignedIn } from "@/lib/session";
import { space, useColors } from "@/theme";

/** You: who is signed in, the workspace the app shows, and signing out. */
export default function You() {
  const { me, workspace, server, client, selectWorkspace, signOut } = useSignedIn();
  const colors = useColors();
  const name = me.display_username ?? me.username;
  const oauth = client.credentials.kind === "oauth";

  return (
    <Screen scroll style={{ paddingHorizontal: 0 }}>
      <Stack.Screen options={{ title: "You" }} />
      <View style={{ flexDirection: "row", gap: space.md, alignItems: "center", paddingHorizontal: space.lg }}>
        <Avatar name={name} uri={me.avatar ? `${server.site}/avatars/${me.avatar}` : null} size={48} />
        <View style={{ flex: 1 }}>
          <Text size="heading">{name}</Text>
          <Text size="small" tone="muted">
            {isHosted(server) ? "g1t.sh" : new URL(server.site).host}
          </Text>
        </View>
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
          subtitle={
            oauth
              ? "End or narrow the app's access in Settings → Connected applications."
              : "The token you pasted. Delete it in Settings → Access tokens to end it."
          }
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
