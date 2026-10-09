/**
 * A workspace's chat settings (migrations/0003_chat_controls.sql) and who
 * they let do what. Pure, so they are tested apart from the service, which
 * enforces every one of them (src/index.ts).
 */
import type { ChannelManagers, ChatAllowed, ChatPermissions, ChatSettings, EmojiUpload } from "@g1t/contracts";

import { mayUpload } from "./emoji.ts";

/** A `chat_settings` row as kept; no row is the defaults. */
export type SettingsRow = {
  emoji_upload: string | null;
  public_channels: string | null;
  private_channels: string | null;
  manage_channels: string | null;
  default_channels: string | null;
};

/** A workspace role, or null for someone not in it. */
export type Role = "owner" | "member" | null;

/** The most channels someone new is put in. */
export const MAX_DEFAULT_CHANNELS = 20;

function allowed(value: unknown): ChatAllowed {
  return value === "owners" ? "owners" : "members";
}

/**
 * The settings a row keeps, with the defaults for anything it does not.
 * Default channels never chosen are #general (`generalId`, when it exists).
 */
export function settingsOf(row: SettingsRow | null, generalId: string | null = null): ChatSettings {
  let defaults: string[] = row?.default_channels == null && generalId ? [generalId] : [];
  try {
    const parsed = row?.default_channels != null ? (JSON.parse(row.default_channels) as unknown) : null;
    if (Array.isArray(parsed)) defaults = parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_DEFAULT_CHANNELS);
  } catch {
    defaults = [];
  }
  return {
    public_channels: allowed(row?.public_channels),
    private_channels: allowed(row?.private_channels),
    manage_channels: row?.manage_channels === "owners" ? "owners" : "channel_owners",
    emoji_upload: row?.emoji_upload === "admins" ? "admins" : "members",
    default_channels: defaults,
  };
}

/** Whether a role may make a public or a private channel. */
export function mayCreateChannel(settings: ChatSettings, role: Role, isPrivate: boolean): boolean {
  if (!role) return false;
  const who = isPrivate ? settings.private_channels : settings.public_channels;
  return who === "members" || role === "owner";
}

/**
 * Whether someone may rename, archive or unarchive a channel: a workspace
 * owner always; its own owner (whoever made it) unless the workspace keeps
 * that to its owners.
 */
export function mayManageChannel(settings: ChatSettings, role: Role, channelRole: "owner" | "member" | null): boolean {
  if (role === "owner") return true;
  if (!role) return false;
  return settings.manage_channels === "channel_owners" && channelRole === "owner";
}

/** What a role may do, for the page to show or hide. */
export function permissionsFor(settings: ChatSettings, role: Role): ChatPermissions {
  return {
    create_public_channels: mayCreateChannel(settings, role, false),
    create_private_channels: mayCreateChannel(settings, role, true),
    add_emoji: mayUpload(settings.emoji_upload, role),
    manage_settings: role === "owner",
  };
}

/**
 * A change to the settings, checked: each field left out stays, each one
 * given must be a value the setting takes. Default channels are checked
 * against the workspace's channels by the service.
 */
export function settingsChange(
  input: unknown,
): { ok: true; change: Partial<ChatSettings> } | { ok: false; message: string } {
  if (!input || typeof input !== "object") return { ok: false, message: "Nothing to change." };
  const c = input as Record<string, unknown>;
  const change: Partial<ChatSettings> = {};
  const who = (key: "public_channels" | "private_channels") => {
    if (c[key] === undefined) return true;
    if (c[key] !== "members" && c[key] !== "owners") return false;
    change[key] = c[key] as ChatAllowed;
    return true;
  };
  if (!who("public_channels") || !who("private_channels")) return { ok: false, message: "Choose members or owners." };
  if (c.manage_channels !== undefined) {
    if (c.manage_channels !== "channel_owners" && c.manage_channels !== "owners") {
      return { ok: false, message: "Choose channel owners or workspace owners." };
    }
    change.manage_channels = c.manage_channels as ChannelManagers;
  }
  if (c.emoji_upload !== undefined) {
    if (c.emoji_upload !== "members" && c.emoji_upload !== "admins") return { ok: false, message: "Choose members or owners." };
    change.emoji_upload = c.emoji_upload as EmojiUpload;
  }
  if (c.default_channels !== undefined) {
    if (!Array.isArray(c.default_channels) || !c.default_channels.every((id) => typeof id === "string")) {
      return { ok: false, message: "Default channels are a list of channels." };
    }
    const ids = [...new Set(c.default_channels as string[])];
    if (ids.length > MAX_DEFAULT_CHANNELS) return { ok: false, message: `Choose at most ${MAX_DEFAULT_CHANNELS} default channels.` };
    change.default_channels = ids;
  }
  return { ok: true, change };
}

/** The settings once a change is made, as a row's columns. */
export function rowFor(settings: ChatSettings): Omit<SettingsRow, "default_channels"> & { default_channels: string } {
  return {
    emoji_upload: settings.emoji_upload,
    public_channels: settings.public_channels,
    private_channels: settings.private_channels,
    manage_channels: settings.manage_channels,
    default_channels: JSON.stringify(settings.default_channels),
  };
}
