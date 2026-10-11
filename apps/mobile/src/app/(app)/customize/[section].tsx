import { CUSTOMIZE_SECTIONS, type CustomizeSection } from "@g1t/contracts/customize";
import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { ExternalLink } from "lucide-react-native";
import { SectionList, View } from "react-native";

import { Badge, Button, Row, Screen, SectionHeader, Text } from "@/components/ui";
import { CUSTOMIZE, type CustomizeItem, customizeItems, customizePath } from "@/lib/customize";
import { siteUrl } from "@/lib/server";
import { useSignedIn } from "@/lib/session";
import { space } from "@/theme";

/** One part of Customize: its listings, grouped, each opening where it is set up. */
export default function CustomizeSectionScreen() {
  const { section } = useLocalSearchParams<{ section: string }>();
  const { workspace, server } = useSignedIn();
  if (!CUSTOMIZE_SECTIONS.includes(section as CustomizeSection)) return <Redirect href="/customize" />;
  const id = section as CustomizeSection;
  const slug = workspace?.slug ?? "";
  const items = customizeItems(id, slug);
  const groups = [...new Set(items.map((item) => item.group))].map((group) => ({ title: group, data: items.filter((item) => item.group === group) }));
  const open = (path: string) => WebBrowser.openBrowserAsync(siteUrl(server, path));

  return (
    <Screen>
      <Stack.Screen options={{ title: CUSTOMIZE[id].title }} />
      <SectionList
        sections={groups}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={{ padding: space.lg, gap: space.md }}>
            <Text tone="muted">{CUSTOMIZE[id].description}</Text>
            <Button title={`Manage ${CUSTOMIZE[id].title.toLowerCase()} on g1t`} variant="secondary" icon={ExternalLink} onPress={() => open(customizePath(id, slug))} />
          </View>
        }
        renderSectionHeader={({ section: group }) => <SectionHeader title={group.title} />}
        renderItem={({ item }) => <Item item={item} onPress={() => open(item.sitePath)} />}
      />
    </Screen>
  );
}

function Item({ item, onPress }: { item: CustomizeItem; onPress: () => void }) {
  const badge = item.status === "available" ? <Badge label="Available" tone="success" /> : item.status === "soon" ? <Badge label="Soon" /> : <Badge label="Built in" tone="accent" />;
  return <Row title={item.name} subtitle={item.description} trailing={badge} onPress={item.status === "soon" ? undefined : onPress} />;
}
