import * as Haptics from "expo-haptics";
import { ArrowUp } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Keyboard, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { radius, space, useColors } from "@/theme";

/** What was typed and not sent, per conversation, while the app runs. */
const drafts = new Map<string, string>();

/**
 * The box at the bottom of a conversation. Enter makes a new line, as on
 * a phone; the arrow sends. Typing tells the others (at most every 3 s).
 */
export function Composer({
  draftKey,
  placeholder,
  onSend,
  onTyping,
  onFocus,
}: {
  draftKey: string;
  placeholder: string;
  onSend: (body: string) => void;
  onTyping: () => void;
  /** The box was tapped into: the conversation goes to its newest message. */
  onFocus?: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const ready = text.trim().length > 0;
  // With the keyboard up the box sits on it; the home indicator's room is only for when it is down.
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => setKeyboard(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setKeyboard(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  const send = () => {
    const body = text.trim();
    if (!body) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    onSend(body);
    setText("");
    drafts.delete(draftKey);
  };

  return (
    <View style={[styles.bar, { borderTopColor: colors.line, backgroundColor: colors.surface, paddingBottom: keyboard ? space.sm : Math.max(insets.bottom, space.sm) }]}>
      <TextInput
        value={text}
        onChangeText={(next) => {
          setText(next);
          drafts.set(draftKey, next);
          if (next.length > 0) onTyping();
        }}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        onFocus={onFocus}
        multiline
        style={[styles.input, { color: colors.fg, backgroundColor: colors.bg, borderColor: colors.lineStrong }]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send"
        onPress={send}
        disabled={!ready}
        style={[styles.send, { backgroundColor: ready ? colors.accent : colors.raised }]}
      >
        <ArrowUp size={20} color={ready ? colors.onAccent : colors.faint} strokeWidth={2.5} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 40, maxHeight: 160, borderRadius: radius.lg, borderWidth: 1, paddingHorizontal: space.md, paddingTop: 10, paddingBottom: 10, fontSize: 15 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
});
