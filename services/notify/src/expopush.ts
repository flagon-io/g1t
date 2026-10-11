/**
 * Push to the phone app, through Expo's push service, which hands each
 * message to FCM on Android and APNs on iOS. The app registers the token
 * Expo gave it (`ExponentPushToken[…]`); the feed keeps it as a device.
 *
 * Expo answers a batch of up to 100 messages with one ticket each, in the
 * same order. A ticket saying `DeviceNotRegistered` means the app is gone
 * from that phone (uninstalled, or its notifications turned off for good):
 * the caller drops the device. Receipts, which say whether FCM or APNs took
 * the message, are not fetched: a device that stops working shows up in a
 * later ticket the same way.
 *
 * Pure but for `sendExpo`'s request, so the shapes are tested apart from
 * the feed.
 */
import type { FeedNotification } from "@g1t/contracts";

import type { PushPayload } from "./prefs.ts";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** The most messages Expo takes in one request. */
export const EXPO_BATCH = 100;

/** The Android notification channel the app makes for messages (apps/mobile). */
export const ANDROID_CHANNEL = "messages";

/** The longest token taken; Expo's are about 40 characters. */
const MAX_TOKEN = 200;
const MAX_NAME = 100;

const TOKEN = /^Expo(nent)?PushToken\[[^\s[\]]+\]$/;

/** A phone the app runs on, as the feed keeps it. */
export type Device = { token: string; platform: "android" | "ios"; name: string | null };

/** A device as the app sent it, checked; null when it is not one. The name is trimmed to 100 characters. */
export function cleanDevice(value: unknown): Device | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  const token = typeof d.token === "string" ? d.token.trim() : "";
  if (!token || token.length > MAX_TOKEN || !TOKEN.test(token)) return null;
  if (d.platform !== "android" && d.platform !== "ios") return null;
  const name = typeof d.name === "string" ? d.name.trim().slice(0, MAX_NAME) : "";
  return { token, platform: d.platform, name: name || null };
}

/** One message as Expo takes it. */
export type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  sound: "default";
  priority: "high" | "normal";
  /** Seconds Expo and the platforms keep trying, the same as a browser push. */
  ttl: number;
  /** Android: the channel it shows under. */
  channelId: string;
  /** iOS: the notifications of one conversation group together. */
  threadId: string;
  /** What the app opens when it is pressed. */
  data: {
    href: string;
    workspace: string;
    kind: PushPayload["kind"];
    tag: string;
    channel_id: string | null;
    thread_root: string | null;
    card: PushPayload["card"];
  };
};

/** The message for each token: what a browser push says, with where it is in chat for the app. */
export function expoMessages(
  tokens: string[],
  payload: PushPayload,
  notification: Pick<FeedNotification, "channel_id" | "thread_root">,
): ExpoMessage[] {
  return tokens.map((to) => ({
    to,
    title: payload.title,
    body: payload.body,
    sound: "default",
    priority: payload.urgent ? "high" : "normal",
    ttl: 12 * 3600,
    channelId: ANDROID_CHANNEL,
    threadId: payload.tag,
    data: {
      href: payload.href,
      workspace: payload.workspace,
      kind: payload.kind,
      tag: payload.tag,
      channel_id: notification.channel_id ?? null,
      thread_root: notification.thread_root ?? null,
      card: payload.card,
    },
  }));
}

/** What a batch came to: how many Expo took, the tokens that are gone, and what went wrong otherwise. */
export type ExpoResult = { sent: number; gone: string[]; errors: string[] };

/** Expo's answer to a batch, read against the tokens it was for (tickets come in the same order). */
export function readTickets(tokens: string[], answer: unknown): ExpoResult {
  const result: ExpoResult = { sent: 0, gone: [], errors: [] };
  const body = (answer && typeof answer === "object" ? answer : {}) as { data?: unknown; errors?: unknown };
  if (!Array.isArray(body.data)) {
    result.errors.push(`no tickets: ${JSON.stringify(body.errors ?? answer).slice(0, 300)}`);
    return result;
  }
  tokens.forEach((token, i) => {
    const ticket = (body.data as unknown[])[i] as { status?: unknown; message?: unknown; details?: { error?: unknown } } | undefined;
    if (ticket?.status === "ok") result.sent++;
    else if (ticket?.details?.error === "DeviceNotRegistered") result.gone.push(token);
    else result.errors.push(String(ticket?.details?.error ?? ticket?.message ?? "no ticket").slice(0, 300));
  });
  return result;
}

/**
 * Sends one notification to every token, 100 to a request, the requests at
 * once. A request that fails counts nothing and is reported in `errors`;
 * the others still count.
 */
export async function sendExpo(
  tokens: string[],
  payload: PushPayload,
  notification: Pick<FeedNotification, "channel_id" | "thread_root">,
  options: { accessToken?: string | null } = {},
  fetcher: typeof fetch = fetch,
): Promise<ExpoResult> {
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  // Needed only when the Expo project turns on enhanced push security.
  if (options.accessToken) headers.authorization = `Bearer ${options.accessToken}`;
  const batches: string[][] = [];
  for (let i = 0; i < tokens.length; i += EXPO_BATCH) batches.push(tokens.slice(i, i + EXPO_BATCH));
  const results = await Promise.allSettled(
    batches.map(async (batch) => {
      const response = await fetcher(EXPO_PUSH_URL, { method: "POST", headers, body: JSON.stringify(expoMessages(batch, payload, notification)) });
      const answer = await response.json().catch(() => null);
      if (!response.ok) return { sent: 0, gone: [], errors: [`Expo answered ${response.status}: ${JSON.stringify(answer).slice(0, 300)}`] };
      return readTickets(batch, answer);
    }),
  );
  const total: ExpoResult = { sent: 0, gone: [], errors: [] };
  for (const result of results) {
    if (result.status === "rejected") {
      total.errors.push(String(result.reason).slice(0, 300));
      continue;
    }
    total.sent += result.value.sent;
    total.gone.push(...result.value.gone);
    total.errors.push(...result.value.errors);
  }
  return total;
}
