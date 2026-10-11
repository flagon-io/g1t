import { router } from "expo-router";
import { X } from "lucide-react-native";
import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Avatar, Text } from "@/components/ui";
import { useFeed } from "@/lib/feed";
import { routeFor } from "@/lib/links";
import { useSignedIn } from "@/lib/session";
import { radius, space, useColors } from "@/theme";

/**
 * A notification while the app is open, as the site's toast: who, what,
 * and a tap to go there. Not shown for the conversation on screen.
 */
export function Banner() {
  const { banner, dismiss } = useFeed();
  const { server } = useSignedIn();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const offset = useRef(new Animated.Value(-160)).current;

  useEffect(() => {
    Animated.spring(offset, { toValue: banner ? 0 : -160, useNativeDriver: true, speed: 18, bounciness: 6 }).start();
  }, [banner, offset]);

  if (!banner) return null;
  const go = () => {
    dismiss();
    if (banner.channel_id && banner.thread_root) router.push({ pathname: "/chat/thread", params: { channel: banner.channel_id, root: banner.thread_root } });
    else if (banner.channel_id) router.push({ pathname: "/chat/[channel]", params: { channel: banner.channel_id } });
    else {
      const route = routeFor(banner.href);
      router.push((route ?? `/open?path=${encodeURIComponent(banner.href)}`) as never);
    }
  };

  return (
    <Animated.View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + space.sm, transform: [{ translateY: offset }] }]}>
      <Pressable onPress={go} style={[styles.banner, { backgroundColor: colors.raised, borderColor: colors.lineStrong }]}>
        <Avatar
          name={banner.actor.name}
          uri={banner.actor.avatar ? `${server.site}/avatars/${banner.actor.avatar}` : null}
          agent={banner.actor.kind === "agent"}
          size={36}
        />
        <View style={{ flex: 1 }}>
          <Text style={{ fontWeight: "700" }} numberOfLines={1}>
            {banner.title}
          </Text>
          {banner.body ? (
            <Text size="small" tone="muted" numberOfLines={2}>
              {banner.body}
            </Text>
          ) : null}
        </View>
        <Pressable accessibilityLabel="Dismiss" hitSlop={10} onPress={dismiss}>
          <X size={18} color={colors.faint} />
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: space.md, right: space.md },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
});
