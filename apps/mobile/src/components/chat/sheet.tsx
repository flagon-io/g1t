import type { LucideIcon } from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, Text } from "@/components/ui";
import { radius, space, useColors } from "@/theme";

/** A panel from the bottom over a dimmed screen, closed by tapping outside it. */
export function Sheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.line, paddingBottom: insets.bottom + space.md }]}>
          <View style={[styles.grabber, { backgroundColor: colors.lineStrong }]} />
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A row in a sheet: an icon and what it does. */
export function SheetAction({ icon: Icon, label, danger, onPress }: { icon: LucideIcon; label: string; danger?: boolean; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.action, { backgroundColor: pressed ? colors.raised : "transparent" }]}>
      <Icon size={20} color={danger ? colors.danger : colors.fg} />
      <Text style={{ color: danger ? colors.danger : colors.fg }}>{label}</Text>
    </Pressable>
  );
}

/** Asks for one value in a sheet: a card's amount, a new message text. */
export function PromptSheet({
  visible,
  title,
  label,
  placeholder,
  initial = "",
  numeric,
  multiline,
  confirm,
  onCancel,
  onDone,
}: {
  visible: boolean;
  title: string;
  label?: string;
  placeholder?: string;
  initial?: string;
  numeric?: boolean;
  multiline?: boolean;
  confirm: string;
  onCancel: () => void;
  onDone: (value: string) => void;
}) {
  const colors = useColors();
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (visible) setValue(initial);
  }, [visible, initial]);
  return (
    <Sheet visible={visible} onClose={onCancel}>
      <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
        <Text size="heading">{title}</Text>
        {label ? (
          <Text size="small" tone="muted">
            {label}
          </Text>
        ) : null}
        <TextInput
          autoFocus
          value={value}
          onChangeText={setValue}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          keyboardType={numeric ? "decimal-pad" : "default"}
          multiline={multiline}
          style={[styles.input, { color: colors.fg, backgroundColor: colors.bg, borderColor: colors.lineStrong, minHeight: multiline ? 96 : 46 }]}
        />
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button title="Cancel" variant="secondary" onPress={onCancel} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title={confirm} disabled={!value.trim()} onPress={() => onDone(value.trim())} />
          </View>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, paddingTop: space.sm, gap: space.sm },
  grabber: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginBottom: space.xs },
  action: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, fontSize: 15, textAlignVertical: "top" },
});
