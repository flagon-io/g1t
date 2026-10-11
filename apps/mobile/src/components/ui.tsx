import { Image } from "expo-image";
import type { LucideIcon } from "lucide-react-native";
import { ChevronRight } from "lucide-react-native";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  type TextProps,
  TextInput,
  type TextInputProps,
  View,
  type ViewProps,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ApiError } from "@/lib/client";
import { fonts, radius, space, useColors } from "@/theme";

/**
 * The app's building blocks, themed with g1t's tokens. As on the site
 * (apps/web/app/components/ui), a screen is built from these, and a look
 * changes through a component's variant, not a style at the call site.
 */

type Tone = "default" | "muted" | "faint" | "accent" | "danger" | "success";
type Size = "title" | "heading" | "body" | "small" | "mono";

const SIZES: Record<Size, { fontSize: number; lineHeight: number; fontWeight?: "600" | "700" }> = {
  title: { fontSize: 26, lineHeight: 32, fontWeight: "700" },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  mono: { fontSize: 12, lineHeight: 17 },
};

export function Text({ size = "body", tone = "default", style, ...props }: TextProps & { size?: Size; tone?: Tone }) {
  const colors = useColors();
  const color = { default: colors.fg, muted: colors.muted, faint: colors.faint, accent: colors.accent, danger: colors.danger, success: colors.success }[tone];
  return <NativeText style={[SIZES[size], size === "mono" && { fontFamily: fonts.mono }, { color }, style]} {...props} />;
}

/** A screen's background, inside the safe area when it has no header above it. */
export function Screen({ children, scroll, safe, style, ...props }: ViewProps & { scroll?: boolean; safe?: boolean }) {
  const colors = useColors();
  const body = scroll ? (
    <ScrollView contentContainerStyle={[styles.padded, style]} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1 }, style]} {...props}>
      {children}
    </View>
  );
  return safe ? (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>{body}</SafeAreaView>
  ) : (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>{body}</View>
  );
}

export function Button({
  title,
  variant = "primary",
  busy,
  disabled,
  icon: Icon,
  ...props
}: PressableProps & { title: string; variant?: "primary" | "secondary" | "danger"; busy?: boolean; icon?: LucideIcon }) {
  const colors = useColors();
  const look = {
    primary: { bg: colors.accent, fg: colors.onAccent, border: colors.accent },
    secondary: { bg: colors.surface, fg: colors.fg, border: colors.lineStrong },
    danger: { bg: colors.surface, fg: colors.danger, border: colors.lineStrong },
  }[variant];
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={off}
      style={({ pressed }) => [styles.button, { backgroundColor: look.bg, borderColor: look.border, opacity: off ? 0.55 : pressed ? 0.8 : 1 }]}
      {...props}
    >
      {busy ? <ActivityIndicator color={look.fg} /> : Icon ? <Icon size={18} color={look.fg} /> : null}
      <Text style={{ color: look.fg, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  const colors = useColors();
  return (
    <View style={{ gap: space.xs }}>
      <Text size="small" tone="muted">
        {label}
      </Text>
      <TextInput
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: colors.fg, backgroundColor: colors.surface, borderColor: colors.lineStrong }]}
        {...props}
      />
      {hint ? (
        <Text size="small" tone="faint">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** A row in a list: what it is, a line under it, and what is at its end. */
export function Row({
  title,
  subtitle,
  leading,
  trailing,
  chevron = true,
  onPress,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  onPress?: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.row, { borderBottomColor: colors.line, backgroundColor: pressed ? colors.raised : "transparent" }]}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        {typeof title === "string" ? (
          <Text numberOfLines={1} style={{ fontWeight: "600" }}>
            {title}
          </Text>
        ) : (
          title
        )}
        {typeof subtitle === "string" ? (
          <Text size="small" tone="muted" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : (
          subtitle
        )}
      </View>
      {trailing}
      {onPress && chevron ? <ChevronRight size={18} color={colors.faint} /> : null}
    </Pressable>
  );
}

export function SectionHeader({ title }: { title: string }) {
  const colors = useColors();
  return (
    <View style={[styles.sectionHeader, { backgroundColor: colors.bg }]}>
      <Text size="small" tone="muted" style={{ fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6 }}>
        {title}
      </Text>
    </View>
  );
}

type BadgeTone = "neutral" | "accent" | "success" | "danger" | "merged" | "warn";

export function Badge({ label, tone = "neutral" }: { label: string; tone?: BadgeTone }) {
  const colors = useColors();
  const fg = { neutral: colors.muted, accent: colors.accent, success: colors.success, danger: colors.danger, merged: colors.merged, warn: colors.warn }[tone];
  return (
    <View style={[styles.badge, { borderColor: fg }]}>
      <Text size="small" style={{ color: fg, fontWeight: "600" }}>
        {label}
      </Text>
    </View>
  );
}

/**
 * A person's or an agent's picture: the uploaded one when there is one,
 * else their initial. Agents carry a marker, as everywhere on g1t. The
 * site draws an agent's own bot face (components/agent-face.tsx); bringing
 * that here is to come.
 */
export function Avatar({ name, uri, agent, size = 32 }: { name: string; uri?: string | null; agent?: boolean; size?: number }) {
  const colors = useColors();
  const corner = agent ? radius.sm : size / 2;
  return (
    <View accessibilityLabel={agent ? `${name}, agent` : name} style={{ width: size, height: size }}>
      {uri ? (
        <Image source={{ uri }} style={{ width: size, height: size, borderRadius: corner }} />
      ) : (
        <View style={{ width: size, height: size, borderRadius: corner, backgroundColor: colors.accentLow, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: colors.accent, fontWeight: "700", fontSize: size * 0.42, lineHeight: size * 0.5 }}>{name.slice(0, 1).toUpperCase()}</Text>
        </View>
      )}
      {agent ? <View style={[styles.agentMarker, { backgroundColor: colors.accent, borderColor: colors.bg }]} /> : null}
    </View>
  );
}

export function Loading() {
  const colors = useColors();
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}

export function Empty({ icon: Icon, title, body, action }: { icon?: LucideIcon; title: string; body?: string; action?: ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.center, { gap: space.sm, padding: space.xl }]}>
      {Icon ? <Icon size={28} color={colors.faint} /> : null}
      <Text size="heading" style={{ textAlign: "center" }}>
        {title}
      </Text>
      {body ? (
        <Text tone="muted" style={{ textAlign: "center" }}>
          {body}
        </Text>
      ) : null}
      {action}
    </View>
  );
}

/** What went wrong, in words, with a way to try again. */
export function ErrorView({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const title = error instanceof ApiError && error.code === "website_refused" ? "Chat needs another sign-in" : "Could not load this";
  return <Empty title={title} body={message} action={retry ? <Button title="Try again" variant="secondary" onPress={retry} /> : null} />;
}

const styles = StyleSheet.create({
  padded: { padding: space.lg, gap: space.lg },
  button: {
    minHeight: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  input: { minHeight: 46, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space.md, fontSize: 15 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionHeader: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm },
  badge: { borderWidth: 1, borderRadius: radius.full, paddingHorizontal: space.sm, paddingVertical: 1 },
  agentMarker: { position: "absolute", right: -2, bottom: -2, width: 10, height: 10, borderRadius: 3, borderWidth: 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
