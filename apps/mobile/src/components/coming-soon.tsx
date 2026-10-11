import { Stack } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import type { LucideIcon } from "lucide-react-native";
import { ExternalLink } from "lucide-react-native";

import { Button, Empty, Screen } from "@/components/ui";
import { siteUrl } from "@/lib/server";
import { useSignedIn } from "@/lib/session";

/**
 * A part of g1t the app has no screens for yet: what it is, and the way
 * to it on the site meanwhile.
 */
export function ComingSoon({ title, icon, body, path }: { title: string; icon: LucideIcon; body: string; path: (workspace: string) => string }) {
  const { server, workspace } = useSignedIn();
  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      <Empty
        icon={icon}
        title={`${title} is coming to the app`}
        body={body}
        action={
          <Button
            title="Open on g1t"
            variant="secondary"
            icon={ExternalLink}
            onPress={() => WebBrowser.openBrowserAsync(siteUrl(server, path(workspace?.slug ?? "")))}
          />
        }
      />
    </Screen>
  );
}
