/**
 * Live notifications in the browser: one socket per tab to the person's
 * feed (`/-/live`, services/notify), a small store the page reads (counts
 * for the rail, the Chat sidebar and the tab title; toasts; whether the
 * socket is up), and delivery through a `NotificationSink`: the web's own
 * (toasts and the app badge) or, inside the desktop app, its native
 * bridge. Sounds are apart: every notification goes to
 * lib/sound-events.ts, which decides and plays (lib/chat-sounds.ts,
 * lib/sounds.ts).
 *
 * Nothing here polls. The feed sends counts on connect and after every
 * change; while the socket is down, `connected` is false and the pages
 * that used to poll may fall back to a slow refresh.
 *
 * Presence rides the same socket: the tab says when it goes idle (no input
 * for `IDLE_MS`) or comes back, the feed sends how everyone in the
 * workspace shows (`presence`) and your own (`me`), and `setPresence`
 * changes yours (lib/presence.ts, components/presence.tsx).
 */
import { useSyncExternalStore } from "react";

import type { FeedCounts, FeedEvent, FeedNotification, NotifyPreferences, OwnPresence, PresenceChange, PresenceEntry } from "@g1t/contracts";

import { openLive } from "./live-socket";
import { dndOn, isIdle, mergePeople } from "./presence";
import { notificationArrived } from "./sound-events";

import {
  HEARTBEAT_MS,
  addRecent,
  addToast,
  attentionCount,
  badgesOf,
  dismissToast,
  markReadLocally,
  offerPush,
  heldOpen,
  reconnectDelay,
  titleWith,
  waitingCards,
  type LiveBadges,
  type PushChoice,
  type Toast,
} from "./notify-store";

// ── The desktop bridge ───────────────────────────────────────────────────

/**
 * What the desktop app (an Electron shell loading this web app) exposes
 * from its preload script with
 * `contextBridge.exposeInMainWorld("g1tDesktop", …)`. When it is there,
 * notifications go to it instead of the browser:
 *
 * ```ts
 * window.g1tDesktop = {
 *   version: "1.0.0",
 *   // A native notification. Clicking it brings the window forward and
 *   // navigates to `href` (calling the `onNavigate` listeners).
 *   notify({ id, title, body, href, tag, icon }) {},
 *   // The dock or taskbar badge and the tray's count; 0 clears it.
 *   setBadge(count) {},
 *   // Opens a URL outside the app, in the system browser.
 *   openUrl(url) {},
 *   // g1t:// deep links and notification clicks, as site paths ("/acme/-/chat/dm/chn_1").
 *   onNavigate(listener) { return () => {} },
 * };
 * ```
 */
export type DesktopBridge = {
  version?: string;
  notify(notification: { id: string; title: string; body: string; href: string; tag: string; icon?: string | null }): void;
  setBadge(count: number): void;
  openUrl(url: string): void;
  onNavigate?(listener: (href: string) => void): () => void;
};

declare global {
  interface Window {
    g1tDesktop?: DesktopBridge;
  }
}

export function desktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.g1tDesktop;
  return bridge && typeof bridge.notify === "function" && typeof bridge.setBadge === "function" ? bridge : null;
}

// ── Sinks ────────────────────────────────────────────────────────────────

/** Where a live notification goes once it arrives. */
export interface NotificationSink {
  readonly kind: "web" | "desktop";
  /** A notification arrived; `toast` says the preferences want it shown, `focused` whether this tab is in front. */
  deliver(notification: FeedNotification, options: { toast: boolean; focused: boolean }): void;
  /** What needs the person, for the app icon. */
  setBadge(count: number): void;
  /** Goes to a page on the site. */
  open(href: string): void;
}

let navigator_: ((href: string) => void) | null = null;

/** The router's navigate, so a toast or a notification click moves without a reload. */
export function setNavigator(navigate: ((href: string) => void) | null): void {
  navigator_ = navigate;
}

function openHref(href: string): void {
  if (navigator_) navigator_(href);
  else if (typeof location !== "undefined") location.assign(href);
}

/** The web's: a toast in the tab, the installed app's badge. */
export const webSink: NotificationSink = {
  kind: "web",
  deliver(notification, { toast }) {
    if (!toast) return;
    showToast(notification);
  },
  setBadge(count) {
    const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { setAppBadge?(n: number): Promise<void>; clearAppBadge?(): Promise<void> }) : null;
    try {
      if (count > 0) void nav?.setAppBadge?.(count)?.catch(() => {});
      else void nav?.clearAppBadge?.()?.catch(() => {});
    } catch {
      // Not installed, or not allowed: the tab title says it anyway.
    }
  },
  open: openHref,
};

/** The desktop app's: toasts while its window is in front, native notifications while it is not. */
export function desktopSink(bridge: DesktopBridge): NotificationSink {
  return {
    kind: "desktop",
    deliver(notification, { toast, focused }) {
      if (!toast) return;
      if (focused) {
        showToast(notification);
        return;
      }
      bridge.notify({
        id: notification.id,
        title: notification.title,
        body: notification.body,
        href: notification.href,
        tag: notification.channel_id ? `chat:${notification.channel_id}` : `${notification.kind}:${notification.id}`,
        icon: null,
      });
    },
    setBadge(count) {
      bridge.setBadge(count);
    },
    open: openHref,
  };
}

/** The desktop bridge's sink when there is one, else the web's. */
export function currentSink(): NotificationSink {
  const bridge = desktopBridge();
  return bridge ? desktopSink(bridge) : webSink;
}

// ── The store ────────────────────────────────────────────────────────────

export type NotifyState = {
  /** Whether the feed socket is up. */
  connected: boolean;
  /** Counts by workspace, as the feed last sent them. */
  counts: Record<string, FeedCounts>;
  /** The inbox's unread, the person's whole inbox. */
  inbox: number | null;
  toasts: Toast[];
  preferences: NotifyPreferences | null;
  vapidKey: string | null;
  /** Whether to show the offer to turn on browser notifications. */
  offer: boolean;
  /** How the people who share a workspace with you show, by user id. */
  people: Record<string, PresenceEntry>;
  /** Your own presence, status and Do Not Disturb, once the feed has said. */
  me: OwnPresence | null;
  /** The latest notifications, newest first: the panel's cards waiting on you come from these. */
  recent: FeedNotification[];
  /** Card notifications acted on (or put away) in this tab, by id. */
  settled: ReadonlySet<string>;
};

let state: NotifyState = {
  connected: false,
  counts: {},
  inbox: null,
  toasts: [],
  preferences: null,
  vapidKey: null,
  offer: false,
  people: {},
  me: null,
  recent: [],
  settled: new Set(),
};
const listeners = new Set<() => void>();
const SERVER_STATE = state;

function set(next: Partial<NotifyState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNotifyState(): NotifyState {
  return useSyncExternalStore(subscribeStore, () => state, () => SERVER_STATE);
}

/** The rail's numbers for a workspace from the feed, or null while it cannot say. */
export function useLiveBadges(workspace: string | null | undefined): Partial<LiveBadges> | null {
  const s = useNotifyState();
  return badgesOf(workspace ? s.counts[workspace.toLowerCase()] : null, s.inbox);
}

/** A workspace's counts from the feed, for the Chat sidebar. */
export function useLiveCounts(workspace: string | null | undefined): FeedCounts | null {
  const s = useNotifyState();
  return workspace ? (s.counts[workspace.toLowerCase()] ?? null) : null;
}

/** A card's notification was acted on, or put away: its toast goes, and the panel stops waiting on it. */
export function settle(id: string): void {
  if (state.settled.has(id)) return;
  set({ settled: new Set(state.settled).add(id), toasts: dismissToast(state.toasts, id) });
}

/** The chat cards waiting on the person, newest first, for the panel. */
export function useWaitingCards(workspace?: string | null): FeedNotification[] {
  const s = useNotifyState();
  return waitingCards(s.recent, s.settled, Date.now(), workspace);
}

/** People's presence by user id, with an index by username (lowercased). */
let peopleIndex: { from: Record<string, PresenceEntry>; byName: Map<string, PresenceEntry> } = { from: {}, byName: new Map() };

function byName(people: Record<string, PresenceEntry>): Map<string, PresenceEntry> {
  if (peopleIndex.from !== people) {
    peopleIndex = { from: people, byName: new Map(Object.values(people).map((entry) => [entry.username.toLowerCase(), entry])) };
  }
  return peopleIndex.byName;
}

/**
 * How a person shows, by id or username, or null while the feed has not
 * said (they share no workspace with you, or the socket is not up yet).
 * Your own comes from `me`, so it moves the moment you change it.
 */
export function usePresenceOf(person: { id?: string | null; username?: string | null } | null | undefined): PresenceEntry | null {
  const s = useNotifyState();
  if (!person) return null;
  const mine = s.me && ((person.id && person.id === s.me.user_id) || (person.username && person.username.toLowerCase() === s.me.username.toLowerCase()));
  if (mine) return s.me;
  if (person.id && s.people[person.id]) return s.people[person.id]!;
  return person.username ? (byName(s.people).get(person.username.toLowerCase()) ?? null) : null;
}

export function useOwnPresence(): OwnPresence | null {
  return useNotifyState().me;
}

/** Whether you are not to be disturbed right now, for code outside React (the sound rules). */
export function dndNow(): boolean {
  return dndOn(state.me, Date.now());
}

/** Every notification, however it is shown, goes to the sound rules and the desktop toast (lib/sound-events.ts). */
function heard(notification: FeedNotification, toast: boolean): void {
  notificationArrived(notification, { toast, dnd: dndNow(), permission: permission(), pushOn: pushChoice() === "on", open: openHref });
}

/** Whether the feed is up: pages fall back to a slow refresh only while it is not. */
export function feedConnected(): boolean {
  return state.connected;
}

export function useFeedConnected(): boolean {
  return useNotifyState().connected;
}

let viewing: { path: string; channel_id?: string | null } = { path: "" };

/** The page the person is on, so its own conversation does not toast. */
export function setViewing(next: { path: string; channel_id?: string | null }): void {
  viewing = next;
  sendState();
}

function showToast(notification: FeedNotification): void {
  const toasts = addToast(state.toasts, notification, viewing, Date.now());
  if (toasts === state.toasts) return;
  const offer =
    state.offer ||
    offerPush({
      kind: notification.kind,
      supported: pushSupported(),
      permission: permission(),
      choice: pushChoice(),
      hasKey: !!state.vapidKey,
      desktop: !!desktopBridge(),
    });
  set({ toasts, offer });
}

export function dismiss(id: string): void {
  set({ toasts: dismissToast(state.toasts, id) });
}

export function closeOffer(): void {
  set({ offer: false });
}

/** For the settings page's test, and the harness: a notification shown as if it arrived. */
export function showLocally(notification: FeedNotification): void {
  currentSink().deliver(notification, { toast: true, focused: true });
  heard(notification, true);
}

// ── The socket ───────────────────────────────────────────────────────────

let socket: WebSocket | null = null;
let workspace: string | null = null;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let beat: ReturnType<typeof setInterval> | null = null;
let running = false;
let sink: NotificationSink = webSink;

function focused(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

// ── Idle ─────────────────────────────────────────────────────────────────

let lastInput = Date.now();
let idle = false;

/** Input in this tab: back from idle at once, if it was. */
function onInput(): void {
  lastInput = Date.now();
  if (idle) {
    idle = false;
    sendState();
  }
}

/** Every heartbeat: gone idle since the last one? */
function checkIdle(): void {
  if (!idle && isIdle(lastInput, Date.now())) {
    idle = true;
    sendState();
  }
}

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

function sendState(): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify({ type: "state", focused: focused(), path: viewing.path, idle }));
  } catch {
    // Closing; it comes back.
  }
}

/** The inbox count a page just read, so every tab shows it. */
export function reportInbox(unread: number): void {
  if (state.inbox === unread) return;
  set({ inbox: unread });
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "inbox", unread }));
}

function onEvent(event: FeedEvent): void {
  switch (event.type) {
    case "hello":
      set({ preferences: event.preferences, vapidKey: event.vapid_public_key, recent: addRecent(state.recent, event.notifications ?? []) });
      break;
    case "counts": {
      const { type: _, ...counts } = event;
      set({ counts: { ...state.counts, [counts.workspace]: counts }, inbox: counts.inbox_unread });
      break;
    }
    case "notification":
      set({ recent: addRecent(state.recent, [event.notification]) });
      sink.deliver(event.notification, { toast: event.toast, focused: focused() });
      heard(event.notification, event.toast);
      break;
    case "preferences":
      set({ preferences: event.preferences });
      break;
    case "inbox":
      set({ inbox: event.unread });
      break;
    case "presence": {
      const people = mergePeople(state.people, event.people, event.full);
      if (people !== state.people) set({ people });
      break;
    }
    case "me":
      set({ me: event.me });
      break;
  }
}

/** Between asking for a socket ticket and opening the socket (lib/live-socket.ts). */
let opening = false;

function connect(): void {
  if (!running || opening) return;
  timer = null;
  opening = true;
  openLive(
    "/-/live",
    // Read when the socket opens: the workspace may change meanwhile.
    () => ({ workspace }),
    (address) => {
      opening = false;
      open(address);
    },
    () => {
      if (running) return false;
      opening = false;
      return true;
    },
  );
}

function open(address: string): void {
  let ws: WebSocket;
  try {
    ws = new WebSocket(address);
  } catch {
    schedule();
    return;
  }
  socket = ws;
  let openedAt: number | null = null;
  ws.onopen = () => {
    openedAt = Date.now();
    set({ connected: true });
    sendState();
  };
  ws.onmessage = (message) => {
    if (message.data === "pong") return;
    try {
      onEvent(JSON.parse(String(message.data)) as FeedEvent);
    } catch {
      // Not an event this page knows.
    }
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    // Only a connection that held starts the backoff over.
    if (heldOpen(openedAt)) attempt = 0;
    set({ connected: false });
    schedule();
  };
  ws.onerror = () => ws.close();
}

function schedule(): void {
  if (!running || timer) return;
  timer = setTimeout(connect, reconnectDelay(attempt++));
}

/** Back now: the tab is shown, or the network returned. */
function now(): void {
  sendState();
  if (!running || opening || socket || document.visibilityState !== "visible") return;
  if (timer) clearTimeout(timer);
  timer = null;
  attempt = 0;
  connect();
}

function onRead(event: Event): void {
  const channel = String((event as CustomEvent).detail ?? "");
  if (!channel || !workspace || !state.counts[workspace]) return;
  set({ counts: { ...state.counts, [workspace]: markReadLocally(state.counts[workspace], channel) } });
}

/**
 * Opens the feed for the signed-in person (once per tab; calling again
 * with another workspace reconnects, so the feed reads that workspace's
 * counts). Returns how to close it.
 */
export function startFeed(forWorkspace: string | null): () => void {
  const next = forWorkspace?.toLowerCase() ?? null;
  if (running && next === workspace) return stopFeed;
  workspace = next;
  sink = currentSink();
  if (running) {
    // Another workspace: its counts are read on connect.
    socket?.close(1000, "workspace");
    return stopFeed;
  }
  running = true;
  connect();
  beat = setInterval(() => {
    checkIdle();
    if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
  }, HEARTBEAT_MS);
  lastInput = Date.now();
  idle = false;
  for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { passive: true, capture: true });
  document.addEventListener("visibilitychange", now);
  window.addEventListener("focus", now);
  window.addEventListener("blur", sendState);
  window.addEventListener("online", now);
  window.addEventListener("g1t:chat-read", onRead);
  const bridge = desktopBridge();
  const off = bridge?.onNavigate?.((href) => openHref(href));
  unbridge = off ?? null;
  return stopFeed;
}

let unbridge: (() => void) | null = null;

export function stopFeed(): void {
  running = false;
  if (timer) clearTimeout(timer);
  if (beat) clearInterval(beat);
  timer = beat = null;
  socket?.close(1000, "bye");
  socket = null;
  document.removeEventListener("visibilitychange", now);
  window.removeEventListener("focus", now);
  window.removeEventListener("blur", sendState);
  window.removeEventListener("online", now);
  window.removeEventListener("g1t:chat-read", onRead);
  for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput, { capture: true });
  unbridge?.();
  unbridge = null;
  set({ connected: false });
}

/** Keeps the tab title's count and the app badge in step with `count`. */
export function applyAttention(badges: Partial<LiveBadges> | null): number {
  const count = attentionCount(badges);
  if (typeof document !== "undefined") {
    const next = titleWith(document.title, count);
    if (next !== document.title) document.title = next;
  }
  sink.setBadge(count);
  return count;
}

// ── Browser push ─────────────────────────────────────────────────────────

const PUSH_KEY = "g1t:notify:push";

export function pushChoice(): PushChoice {
  try {
    const value = localStorage.getItem(PUSH_KEY);
    return value === "declined" || value === "off" || value === "on" ? value : null;
  } catch {
    return null;
  }
}

function setPushChoice(choice: PushChoice): void {
  try {
    if (choice) localStorage.setItem(PUSH_KEY, choice);
    else localStorage.removeItem(PUSH_KEY);
  } catch {
    // Asked again next time; nothing worse.
  }
}

/** The person closed the offer or said no: never offered again. */
export function declinePush(): void {
  setPushChoice("declined");
  set({ offer: false });
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function permission(): "default" | "granted" | "denied" {
  return typeof window !== "undefined" && "Notification" in window ? Notification.permission : "denied";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  return existing ?? navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

async function api(body: object): Promise<Response> {
  return fetch("/-/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** The public key browsers subscribe with, from the feed or asked for. */
async function vapidKey(): Promise<string | null> {
  if (state.vapidKey) return state.vapidKey;
  const status = await notifyStatus().catch(() => null);
  return status?.vapid_public_key ?? null;
}

export type PushResult = "on" | "denied" | "unsupported" | "unavailable" | "failed";

/**
 * Asks the browser, then subscribes it: only ever from a click. A no is
 * kept, so g1t never asks again.
 */
export async function enablePush(): Promise<PushResult> {
  if (!pushSupported()) return "unsupported";
  const key = await vapidKey();
  if (!key) return "unavailable";
  const answer = permission() === "granted" ? "granted" : await Notification.requestPermission();
  if (answer !== "granted") {
    setPushChoice("declined");
    set({ offer: false });
    return "denied";
  }
  try {
    const reg = await registration();
    await navigator.serviceWorker.ready;
    const subscription = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
    const response = await api({ intent: "subscribe", subscription: subscription.toJSON() });
    if (!response.ok) return "failed";
    setPushChoice("on");
    set({ offer: false });
    return "on";
  } catch (error) {
    console.error("notify: could not subscribe", error);
    return "failed";
  }
}

/** Stops pushes to this browser; kept as the person's choice. */
export async function disablePush(): Promise<void> {
  setPushChoice("off");
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) return;
  await api({ intent: "unsubscribe", endpoint: subscription.endpoint }).catch(() => null);
  await subscription.unsubscribe().catch(() => false);
}

/** This browser's push endpoint, if subscribed. */
export async function currentEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
}

export async function notifyStatus(): Promise<import("@g1t/contracts").NotifyStatus | null> {
  const endpoint = await currentEndpoint().catch(() => null);
  const response = await fetch(`/-/notify${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ""}`, { headers: { accept: "application/json" } });
  return response.ok ? response.json() : null;
}

/**
 * On each visit, for someone who turned pushes on: the service worker is
 * registered, and the subscription is handed over again (browsers renew
 * them), so pushes keep arriving. Asks nothing.
 */
export async function refreshPush(): Promise<void> {
  if (!pushSupported() || desktopBridge()) return;
  if (permission() !== "granted" || pushChoice() === "off") return;
  const key = await vapidKey();
  if (!key) return;
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let subscription = await reg.pushManager.getSubscription();
  subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await api({ intent: "subscribe", subscription: subscription.toJSON() });
}

export async function savePreferences(preferences: import("@g1t/contracts").NotifyPreferencesChange): Promise<NotifyPreferences | null> {
  const response = await api({ intent: "preferences", preferences });
  if (!response.ok) return null;
  const saved = (await response.json()) as NotifyPreferences;
  set({ preferences: saved });
  return saved;
}

/**
 * Changes your own presence: a status, being away, Do Not Disturb. Shown
 * at once, and put back if the feed refuses; every tab and everyone who
 * shares a workspace with you hear of it over the socket.
 */
export async function setPresence(change: PresenceChange, optimistic?: Partial<OwnPresence>): Promise<OwnPresence | null> {
  const before = state.me;
  if (before && optimistic) set({ me: { ...before, ...optimistic } });
  try {
    const response = await api({ intent: "presence", change });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const me = (await response.json()) as OwnPresence;
    set({ me });
    return me;
  } catch (error) {
    console.error("notify: could not change presence", error);
    if (optimistic) set({ me: before });
    return null;
  }
}

export async function sendTest(): Promise<{ ok: boolean; pushed: number } | null> {
  const response = await api({ intent: "test" });
  return response.ok ? response.json() : null;
}

/** Test seams: the store's state as given, for the harness. */
export function setStateForTest(next: Partial<NotifyState>): void {
  set(next);
}
