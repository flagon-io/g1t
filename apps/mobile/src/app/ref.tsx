import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { ExternalLink, SearchX } from "lucide-react-native";
import { useEffect } from "react";

import { Button, Empty, Loading, Screen } from "@/components/ui";
import { ApiError } from "@/lib/client";
import { type RefContext, refSitePath, targetRoute } from "@/lib/links";
import { siteUrl } from "@/lib/server";
import { useSignedIn } from "@/lib/session";
import { useRefTarget } from "@/lib/work";

/**
 * `#N` read in a repository or a workspace: g1t says what it names (a
 * work item, or a pull request), and that opens in its place. Old links
 * to a repository's issues come here too, since an old issue's number
 * still names the work item it became.
 */
export default function Ref() {
  const params = useLocalSearchParams<{ repo?: string; workspace?: string; number: string }>();
  const { server } = useSignedIn();
  const number = Number(params.number);
  const context: RefContext | null = params.repo ? { repo: params.repo } : params.workspace ? { workspace: params.workspace } : null;
  const target = useRefTarget(context, number);
  const route = target.data ? targetRoute(target.data) : null;

  const leave = () => (router.canGoBack() ? router.back() : router.replace("/"));
  const onSite = () => {
    if (!context) return leave();
    void WebBrowser.openBrowserAsync(siteUrl(server, refSitePath(context, number))).finally(leave);
  };

  useEffect(() => {
    if (route) router.replace(route as never);
  }, [route]);

  // A g1t that cannot say (or a repository the app cannot read): the site reads the link itself.
  const unanswered = target.error instanceof ApiError && (target.error.code === "not_found" || target.error.code === "forbidden");
  useEffect(() => {
    if (unanswered) onSite();
  }, [unanswered]);

  if (!context || !Number.isInteger(number)) {
    return (
      <Screen safe>
        <Empty icon={SearchX} title="Not a reference" action={<Button title="Back" variant="secondary" onPress={leave} />} />
      </Screen>
    );
  }
  if (target.data && !route) {
    const where = "repo" in context ? context.repo : context.workspace;
    return (
      <Screen safe>
        <Empty
          icon={SearchX}
          title={`Nothing is #${number} in ${where}`}
          body="It may have been deleted, or be somewhere you cannot see."
          action={<Button title="Back" variant="secondary" onPress={leave} />}
        />
      </Screen>
    );
  }
  if (target.error && !unanswered) {
    return (
      <Screen safe>
        <Empty
          icon={SearchX}
          title={`Could not find #${number}`}
          body={target.error.message}
          action={<Button title="Open on g1t" variant="secondary" icon={ExternalLink} onPress={onSite} />}
        />
      </Screen>
    );
  }
  return (
    <Screen safe>
      <Loading />
    </Screen>
  );
}
