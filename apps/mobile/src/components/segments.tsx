import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "@/components/ui";
import { radius, space, useColors } from "@/theme";

/** A row of choices, one picked: the site's tabs, on a phone. */
export function Segments<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  const colors = useColors();
  return (
    <View style={[styles.row, { backgroundColor: colors.raised }]}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(option.value)}
            style={[styles.option, on && { backgroundColor: colors.surface, borderColor: colors.lineStrong }]}
          >
            <Text size="small" style={{ fontWeight: "600", color: on ? colors.fg : colors.muted }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", borderRadius: radius.md, padding: 3, gap: 3 },
  option: { flex: 1, alignItems: "center", paddingVertical: space.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: "transparent" },
});
