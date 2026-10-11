import { Stack } from "expo-router";

import { useColors } from "@/theme";

/** A tab's stack of screens, with g1t's header. */
export function TabStack() {
  const colors = useColors();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.fg,
        headerTitleStyle: { color: colors.fg },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    />
  );
}
