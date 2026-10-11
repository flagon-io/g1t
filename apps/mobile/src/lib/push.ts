import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { Client } from "./client";
import { IN_EXPO_GO } from "./oauth";
import { viewing } from "./viewing";

/**
 * Notifications on the phone. g1t's notify service sends them through
 * Expo's push service (FCM on Android, APNs on iOS) under the same rules
 * as browser push: what the person chose, never in Do Not Disturb, never
 * for a muted conversation, and not while a g1t tab or this app is in
 * front of them. The app registers its push token with the site's
 * `/-/notify` (`register_device`) once allowed, and takes it back on
 * signing out (`unregister_device`).
 *
 * Each push carries in `data` where it goes (`href`, a site path), its
 * `workspace`, and the `channel_id` and `thread_root` it is about.
 */

/** Android's channel for messages: what people turn on or off in the system's settings. */
export const MESSAGES_CHANNEL = "messages";

const TOKEN_KEY = "g1t.push-token";

export type PushData = {
  href?: string;
  workspace?: string;
  kind?: string;
  channel_id?: string | null;
  thread_root?: string | null;
};

// A push that arrives while the app is open shows, unless it is about
// the conversation on screen.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = (notification.request.content.data ?? {}) as PushData;
    const here = !!data.channel_id && data.channel_id === viewing.channelId;
    return { shouldShowBanner: !here, shouldShowList: !here, shouldPlaySound: !here, shouldSetBadge: true };
  },
});

export type PushState = "unsupported" | "off" | "denied" | "undetermined" | "granted";

/** Whether pushes can work here: a real phone, in a build of the app (Expo Go on Android has no push). */
export function pushSupported(): boolean {
  return Device.isDevice && !(IN_EXPO_GO && Platform.OS === "android");
}

export async function pushState(server?: { push?: boolean }): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (server?.push === false) return "off";
  const { status } = await Notifications.getPermissionsAsync();
  return status === "granted" ? "granted" : status === "denied" ? "denied" : "undetermined";
}

/**
 * Asks to notify (once; after a no, the system's settings decide), and
 * registers the phone with g1t. Safe to call on every launch: the token is
 * registered again, which keeps it fresh.
 */
export async function registerForPush(client: Client, ask: boolean): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  // A g1t that sends phones nothing (PHONE_PUSH=off): no asking, nothing to register.
  if (client.server.push === false) return "off";
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL, {
      name: "Messages",
      description: "Messages to you, mentions, replies, and agents waiting on you.",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 120, 80, 120],
      lightColor: "#b6a8ff",
      showBadge: true,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted" && ask) status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return status === "denied" ? "denied" : "undetermined";

  const projectId = (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId ?? Constants.easConfig?.projectId;
  const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  const answer = await client.siteRaw<{ ok: boolean; off?: boolean }>("/-/notify", {
    method: "POST",
    body: JSON.stringify({
      intent: "register_device",
      device: { token, platform: Platform.OS === "ios" ? "ios" : "android", name: Device.deviceName ?? Device.modelName ?? null },
    }),
  });
  if (answer.off) return "off";
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  return "granted";
}

/** Takes the phone off the person's notifications, on signing out. */
export async function unregisterPush(client: Client): Promise<void> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
  if (!token) return;
  await client
    .siteRaw("/-/notify", { method: "POST", body: JSON.stringify({ intent: "unregister_device", token }) })
    .catch(() => undefined);
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined);
  await Notifications.setBadgeCountAsync(0).catch(() => undefined);
}

/**
 * Sends a test notification to this person's phones and browsers
 * (`POST /-/notify` `test`), whatever is in front of them: the way to see
 * that a build gets pushes. Answers how many it reached.
 */
export async function sendTestPush(client: Client): Promise<number> {
  const answer = await client.siteRaw<{ ok: boolean; pushed: number }>("/-/notify", { method: "POST", body: JSON.stringify({ intent: "test" }) });
  return answer.pushed ?? 0;
}
