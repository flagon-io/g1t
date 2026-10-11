import { router, useLocalSearchParams } from "expo-router";
import { Server as ServerIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { G1tMark } from "@/components/mark";
import { Button, Loading, Screen, Text } from "@/components/ui";
import { type Found, discover } from "@/lib/discover";
import { isHosted } from "@/lib/server";
import { useSession } from "@/lib/session";
import { space, useColors } from "@/theme";

/**
 * `g1t://connect?server=<site>`: a link (or the QR code on a self-hosted
 * g1t's download page) that points the app at a g1t. It asks first: the
 * app talks to one g1t at a time, and switching signs out of the one
 * before.
 */
export default function Connect() {
  const { server: given } = useLocalSearchParams<{ server?: string }>();
  const { state, changeServer } = useSession();
  const colors = useColors();
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!given) return setError("This link does not say which g1t.");
    discover(given)
      .then(setFound)
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "That g1t did not answer."));
  }, [given]);

  const leave = () => (router.canGoBack() ? router.back() : router.replace("/"));
  const host = found ? new URL(found.server.site).host : "";
  const already = found && state.server && state.server.site === found.server.site;
  const signedInElsewhere = state.status === "signed-in" && !already;

  return (
    <Screen safe>
      <View style={{ flex: 1, padding: space.xl, justifyContent: "center", gap: space.xl }}>
        <G1tMark size={44} />
        {!found && !error ? <Loading /> : null}
        {error ? (
          <View style={{ gap: space.md }}>
            <Text size="title">Can't reach that g1t</Text>
            <Text tone="muted">{error}</Text>
            <Button title="Back" variant="secondary" onPress={leave} />
          </View>
        ) : null}
        {found ? (
          <View style={{ gap: space.md }}>
            <Text size="title">{already ? `Already on ${host}` : `Use ${host}?`}</Text>
            <Text tone="muted">
              {isHosted(found.server)
                ? "g1t.sh, hosted by g1t."
                : `A g1t run by its own people at ${found.server.site}. The app signs in there, and talks to it alone.`}
            </Text>
            {!found.push ? (
              <Text size="small" tone="faint">
                This g1t sends no notifications to phones; Chat still works while the app is open.
              </Text>
            ) : null}
            {signedInElsewhere ? (
              <Text size="small" style={{ color: colors.warn }}>
                You'll be signed out of {state.server ? new URL(state.server.site).host : "the g1t you are on"} first.
              </Text>
            ) : null}
            {already ? (
              <Button title="Continue" onPress={() => router.replace("/")} />
            ) : (
              <Button
                title={`Use ${host}`}
                icon={ServerIcon}
                busy={busy}
                onPress={async () => {
                  setBusy(true);
                  await changeServer(found.server);
                  router.replace("/sign-in");
                }}
              />
            )}
            {!already ? <Button title="Not now" variant="secondary" onPress={leave} /> : null}
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
