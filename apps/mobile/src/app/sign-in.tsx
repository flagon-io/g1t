import { KeyRound, LogIn, Server as ServerIcon } from "lucide-react-native";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, View } from "react-native";

import { Button, Field, Screen, Text } from "@/components/ui";
import { G1tMark } from "@/components/mark";
import { SignInCancelled } from "@/lib/oauth";
import { HOSTED, isHosted, parseServer } from "@/lib/server";
import { useSession } from "@/lib/session";
import { space } from "@/theme";

/**
 * Signing in. The usual way is **Sign in with g1t**: the site opens in the
 * system's browser, the person approves the app, and it comes back signed
 * in (lib/oauth.ts). **Use an access token** takes a personal token
 * instead. **Server** points the app at a self-hosted g1t.
 */
export default function SignIn() {
  const { state, signIn, signInWithToken, changeServer } = useSession();
  const server = state.server ?? HOSTED;
  const [mode, setMode] = useState<"oauth" | "token" | "server">("oauth");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [site, setSite] = useState(server.site);
  const [api, setApi] = useState(isHosted(server) ? "" : server.api);

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
            <Text size="title">Sign in to g1t</Text>
            <Text tone="muted">Chat with your team and its agents, and review and merge what they make.</Text>
          </View>

          {mode === "oauth" ? (
            <View style={{ gap: space.md }}>
              <Button title="Sign in with g1t" icon={LogIn} busy={busy} onPress={() => run(signIn)} />
              <Text size="small" tone="faint">
                {new URL(server.site).host} opens in your browser to approve the app. Your password never reaches it.
              </Text>
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
                hint="Make one in Settings → Access tokens. For Chat, turn on “Use the website as you”."
              />
              <Button title="Sign in" busy={busy} disabled={!token.trim()} onPress={() => run(() => signInWithToken(token))} />
            </View>
          ) : null}

          {mode === "server" ? (
            <View style={{ gap: space.md }}>
              <Field label="Site" placeholder="g1t.example.com" value={site} onChangeText={setSite} keyboardType="url" />
              <Field
                label="API (optional)"
                placeholder={`api.${site ? site.replace(/^https?:\/\//, "") : "g1t.example.com"}`}
                value={api}
                onChangeText={setApi}
                keyboardType="url"
                hint="Left empty, the API is api. in front of the site's address."
              />
              <Button
                title="Use this server"
                busy={busy}
                onPress={() =>
                  run(async () => {
                    const next = parseServer(site, api);
                    if (!next) throw new Error("That is not a web address. It looks like https://g1t.example.com.");
                    await changeServer(next);
                    setMode("oauth");
                  })
                }
              />
              <Button
                title="Use g1t.sh"
                variant="secondary"
                onPress={() => {
                  setSite(HOSTED.site);
                  setApi("");
                  void run(async () => {
                    await changeServer(HOSTED);
                    setMode("oauth");
                  });
                }}
              />
            </View>
          ) : null}

          {error ? <Text tone="danger">{error}</Text> : null}

          <View style={{ gap: space.sm }}>
            {mode !== "oauth" ? <Button title="Sign in with g1t instead" variant="secondary" icon={LogIn} onPress={() => setMode("oauth")} /> : null}
            {mode !== "token" ? <Button title="Use an access token" variant="secondary" icon={KeyRound} onPress={() => setMode("token")} /> : null}
            {mode !== "server" ? (
              <Button title={isHosted(server) ? "Server: g1t.sh" : `Server: ${new URL(server.site).host}`} variant="secondary" icon={ServerIcon} onPress={() => setMode("server")} />
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
