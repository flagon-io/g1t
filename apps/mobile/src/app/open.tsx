import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect } from "react";

import { Loading, Screen } from "@/components/ui";
import { useSession } from "@/lib/session";
import { siteUrl } from "@/lib/server";

/**
 * A link to a page the app has no screen for: it opens on the site, in
 * the system's browser, and the app goes back to where it was.
 */
export default function Open() {
  const { path } = useLocalSearchParams<{ path?: string }>();
  const { state } = useSession();

  useEffect(() => {
    const server = state.server;
    if (!server) return;
    const safe = path && path.startsWith("/") ? path : "/";
    void WebBrowser.openBrowserAsync(siteUrl(server, safe)).finally(() => {
      if (router.canGoBack()) router.back();
      else router.replace("/");
    });
  }, [path, state.server]);

  return (
    <Screen>
      <Loading />
    </Screen>
  );
}
