import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { useColorScheme } from "react-native";

import { ApiError } from "@/lib/client";
import { SessionProvider, useSession } from "@/lib/session";
import { useColors } from "@/theme";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [queries] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            // Signed out, not found and refused are answers, not hiccups.
            retry: (count, error) => !(error instanceof ApiError && error.code !== "offline") && count < 2,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={queries}>
      <SessionProvider>
        <Navigation />
      </SessionProvider>
    </QueryClientProvider>
  );
}

function Navigation() {
  const { state } = useSession();
  const scheme = useColorScheme();
  const colors = useColors();
  const base = scheme === "light" ? DefaultTheme : DarkTheme;
  const theme = {
    ...base,
    colors: { ...base.colors, primary: colors.accent, background: colors.bg, card: colors.surface, text: colors.fg, border: colors.line },
  };

  useEffect(() => {
    if (state.status !== "loading") void SplashScreen.hideAsync();
  }, [state.status]);

  if (state.status === "loading") return null;
  const signedIn = state.status === "signed-in";

  return (
    <ThemeProvider value={theme}>
      <StatusBar style={scheme === "light" ? "dark" : "light"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(app)" />
          <Stack.Screen name="ref" />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
        <Stack.Screen name="oauth/callback" />
        <Stack.Screen name="connect" />
        <Stack.Screen name="open" />
      </Stack>
    </ThemeProvider>
  );
}
