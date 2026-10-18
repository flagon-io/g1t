import { KeyRound, LogIn } from "lucide-react-native";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, View } from "react-native";

import { G1tMark } from "@/components/mark";
import { Button, Field, Screen, Text } from "@/components/ui";
import { discover } from "@/lib/discover";
import { SignInCancelled } from "@/lib/oauth";
import { HOSTED, isHosted } from "@/lib/server";
import { useSession } from "@/lib/session";
import { space } from "@/theme";

/**
 * Signing in. On g1t.sh there is one thing to do: **Sign in with g1t**,
 * which opens the site in the system's browser to approve the app
 * (lib/oauth.ts). Everything else stays out of the way: a personal access
 * token, and pointing the app at a g1t of your own, which a quiet line at
 * the foot offers, or a `g1t://connect` link does for you (app/connect.tsx).
 * Pointed at your own g1t, its address is shown, so you know where you sign in.
 */
export default function SignIn() {
  const { state, signIn, signInWithToken, changeServer } = useSession();
  const server = state.server ?? HOSTED;
  const hosted = isHosted(server);
  const host = new URL(server.site).host;
  const [mode, setMode] = useState<"oauth" | "token" | "server">("oauth");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [site, setSite] = useState(hosted ? "" : server.site);
  const [api, setApi] = useState("");
  const [apiShown, setApiShown] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      if (!(failure instanceof SignInCancelled)) setError(failure instanceof Error ? failure.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen safe>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <View style={{ flex: 1, padding: space.xl, justifyContent: "center", gap: space.xl }}>
          <View style={{ gap: space.md }}>
            <G1tMark size={44} />
            <Text size="title">{hosted ? "Sign in to g1t" : `Sign in to ${host}`}</Text>
            <Text tone="muted">Chat with your team, and review and merge what you and your coding agents make.</Text>
          </View>

          {mode === "oauth" ? (
            <View style={{ gap: space.md }}>
              <Button title="Sign in with g1t" icon={LogIn} busy={busy} onPress={() => run(signIn)} />
              <Text size="small" tone="faint">
                {host} opens in your browser to approve the app. Your password never reaches it.
              </Text>
              <Button title="Use an access token" variant="secondary" icon={KeyRound} onPress={() => setMode("token")} />
            </View>
          ) : null}

          {mode === "token" ? (
            <View style={{ gap: space.md }}>
              <Field
                label="Access token"
                placeholder="g1t_…"
                value={token}
                onChangeText={setToken}
                secureTextEntry
                hint={`Make one on ${host} in Settings → Access tokens, with Chat and Notifications, or “Use the website as you”.`}
              />
              <Button title="Sign in" busy={busy} disabled={!token.trim()} onPress={() => run(() => signInWithToken(token))} />
              <Button title="Back" variant="secondary" onPress={() => setMode("oauth")} />
            </View>
          ) : null}

          {mode === "server" ? (
            <View style={{ gap: space.md }}>
              <Field
                label="Your g1t's address"
                placeholder="g1t.example.com"
                value={site}
                onChangeText={setSite}
                keyboardType="url"
                autoFocus
                hint="The address you open g1t at in a browser. The app finds the rest."
              />
              {apiShown ? (
                <Field
                  label="Its API's address"
                  placeholder="api.g1t.example.com"
                  value={api}
                  onChangeText={setApi}
                  keyboardType="url"
                  hint="Only for a g1t too old to say where its API is."
                />
              ) : null}
              <Button
                title="Continue"
                busy={busy}
                disabled={!site.trim()}
                onPress={() =>
                  run(async () => {
                    const found = await discover(site, apiShown ? api : undefined);
                    await changeServer(found.server);
                    setMode("oauth");
                  })
                }
              />
              <Button title="Back" variant="secondary" onPress={() => setMode("oauth")} />
              {!apiShown ? (
                <Pressable onPress={() => setApiShown(true)} hitSlop={8}>
                  <Text size="small" tone="faint" style={{ textAlign: "center" }}>
                    Its API is at another address
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {error ? <Text tone="danger">{error}</Text> : null}
        </View>

        {mode === "oauth" ? (
          <View style={{ padding: space.xl, paddingTop: 0, alignItems: "center", gap: space.xs }}>
            {hosted ? (
              <Pressable onPress={() => setMode("server")} hitSlop={10}>
                <Text size="small" tone="faint">
                  Using your own g1t?{" "}
                  <Text size="small" tone="accent">
                    Sign in there
                  </Text>
                </Text>
              </Pressable>
            ) : (
              <Text size="small" tone="faint">
                Signing in to {host} ·{" "}
                <Text size="small" tone="accent" onPress={() => setMode("server")}>
                  Change
                </Text>{" "}
                ·{" "}
                <Text size="small" tone="accent" onPress={() => void run(() => changeServer(HOSTED))}>
                  Use g1t.sh
                </Text>
              </Text>
            )}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}
