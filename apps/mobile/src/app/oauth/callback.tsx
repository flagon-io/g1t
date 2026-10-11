import { Redirect } from "expo-router";

import { Loading, Screen } from "@/components/ui";
import { useSession } from "@/lib/session";

/**
 * Where the site sends the person back after they approve the app
 * (`g1t://oauth/callback`). The sign-in screen's browser session reads
 * the code from the address itself (lib/oauth.ts); this screen is only
 * what shows if the link opens the app on its own, and it moves on.
 */
export default function OAuthCallback() {
  const { state } = useSession();
  if (state.status === "loading") {
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  }
  return <Redirect href={state.status === "signed-in" ? "/chat" : "/sign-in"} />;
}
