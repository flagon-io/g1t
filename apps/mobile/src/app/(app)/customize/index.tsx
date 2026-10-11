import { CUSTOMIZE_SECTIONS } from "@g1t/contracts/customize";
import { Stack, router } from "expo-router";
import { Blocks, Plug, Sparkles } from "lucide-react-native";
import { View } from "react-native";

import { Row, Screen, Text } from "@/components/ui";
import { CUSTOMIZE, customizeItems } from "@/lib/customize";
import { useSignedIn } from "@/lib/session";
import { space, useColors } from "@/theme";

const ICONS = { skills: Sparkles, connectors: Plug, plugins: Blocks } as const;

/**
 * Customize: what shapes how this workspace's agents work. Skills are what
 * they know how to do, Connectors what they can reach, Plugins what adds
 * to the workspace. It replaces the Marketplace.
 */
export default function Customize() {
  const { workspace } = useSignedIn();
  const colors = useColors();
  const slug = workspace?.slug ?? "";
  return (
    <Screen>
      <Stack.Screen options={{ title: "Customize" }} />
      <View style={{ padding: space.lg }}>
        <Text tone="muted">Skills, connectors and plugins for {workspace?.name ?? slug}. Owners add them; anyone else asks an owner.</Text>
      </View>
      {CUSTOMIZE_SECTIONS.map((section) => {
        const Icon = ICONS[section];
        const count = customizeItems(section, slug).length;
        return (
          <Row
            key={section}
            leading={<Icon size={22} color={colors.accent} />}
            title={`${CUSTOMIZE[section].title} · ${count}`}
            subtitle={CUSTOMIZE[section].description}
            onPress={() => router.push({ pathname: "/customize/[section]", params: { section } })}
          />
        );
      })}
    </Screen>
  );
}
