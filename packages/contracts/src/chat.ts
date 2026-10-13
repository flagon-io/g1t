/**
 * Chat: channels, direct messages, threads and messages, kept by the chat
 * service (`services/chat`). Members are people; messages from the agents
 * workspaces once had stay readable under the names they had.
 *
 * Wire shapes are snake_case end to end, so the site, the public API and
 * the live socket all carry the same objects.
 */
import type { ServiceBinding } from "./clients";
import type { User } from "./identity";
import type { AskPage } from "./integrations";
import type { Result } from "./result";

/**
 * Who is speaking: a person (by user id), g1t itself (`system:g1t`, the one
 * reserved actor all of g1t's own work shows as), or, on older messages, a
 * former workspace agent (by agent id).
 */
export type Principal = { kind: "user" | "agent" | "system"; id: string };

/**
 * g1t in chat: @g1t, the same reserved `system` actor (id `g1t`) the
 * runner and the feed show g1t's own work as. Every member can talk with
 * it in a direct message, where it answers with the workspace's own AI
 * provider (docs.g1t.sh/guides/ask/). It is never a person: the People
 * directory and member pickers never list it.
 */
export const G1T_PRINCIPAL: Principal = { kind: "system", id: "g1t" };
/** `system:g1t`, as chat keeps members and authors. */
export const G1T_KEY = "system:g1t";

/** Whether a member is g1t itself. */
export function isG1t(member: { kind: string; id?: string } | null | undefined): boolean {
  return member?.kind === "system" && member.id === "g1t";
}

export function principalKey(principal: Principal): string {
  return `${principal.kind}:${principal.id}`;
}

export function parsePrincipalKey(key: string): Principal | null {
  // g1t is the only `system` member there is.
  if (key === G1T_KEY) return { ...G1T_PRINCIPAL };
  const at = key.indexOf(":");
  if (at < 0) return null;
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if ((kind !== "user" && kind !== "agent") || !id) return null;
  return { kind, id };
}

/** How a member shows: resolved by the chat service when it answers. */
export type MemberProfile = Principal & {
  /** `username` for a person (lowercased: what `@` mentions), `handle` for an agent. */
  name: string;
  /**
   * A person's username as they wrote it (`Ana`), when that differs from
   * `name`; absent for an agent. Shown in their card and in autocomplete.
   */
  display_username?: string | null;
  /**
   * What chat shows them as: a person's display name, else their username
   * in its chosen case; an agent's display name. Read it with `memberName`.
   */
  display_name: string;
  /** Uploaded avatar hash for a person, or null for the letter avatar. */
  avatar: string | null;
  /** An agent's one-line role ("Release manager for g1t"). */
  role: string | null;
  /**
   * An agent's title ("QA Engineer"); null for a person. Chat always sets
   * it; optional so profiles a page makes for itself need not.
   */
  title?: string | null;
  /** What an agent's face is drawn from when it chose none; null for a person. Always set by chat. */
  avatar_seed?: string | null;
  /**
   * An archived agent (docs.g1t.sh/guides/chat/, "Archived and deleted
   * agents"): when, and by whom. Its conversations stay readable; it is
   * never woken and never listed to talk to. Null or absent for a live
   * agent and for a person.
   */
  archived_at?: string | null;
  archived_by?: string | null;
  /** An agent deleted for good: its messages stay under the name it had. Absent otherwise. */
  deleted?: boolean;
};

/**
 * A member's handle as it shows (`@Ana`, without the `@`): a person's
 * username in its chosen case, an agent's handle.
 */
export function memberHandle(member: { name: string; display_username?: string | null }): string {
  const display = member.display_username;
  return display && display.toLowerCase() === member.name.toLowerCase() ? display : member.name;
}

/**
 * How a member's name is shown everywhere in chat (messages, the
 * sidebar, direct-message titles, typing, notifications and pushes): their
 * display name, else their handle in its chosen case. One rule, so every
 * surface agrees.
 */
export function memberName(member: { name: string; display_name?: string | null; display_username?: string | null }): string {
  return member.display_name?.trim() || memberHandle(member);
}

export type ChannelKind = "channel" | "dm";

export type Channel = {
  id: string;
  workspace_id: string;
  kind: ChannelKind;
  /** Lowercase, no `#`. Null for a direct message. */
  name: string | null;
  topic: string | null;
  private: boolean;
  created_by: Principal;
  created_at: string;
  archived_at: string | null;
  last_message_at: string | null;
};

export type ChannelMember = {
  channel_id: string;
  member: MemberProfile;
  role: "owner" | "member";
  starred: boolean;
  muted: boolean;
  last_read_id: string | null;
  joined_at: string;
};

/** A card g1t or an agent posts: an event, a task, an approval. */
export type MessageCard = {
  /** What it is about, e.g. `pull`, `issue`, `task`, `deploy`, `approval`, `session`, `draft_issue`. */
  kind: string;
  title: string;
  /** A short line under the title: "3/3 checks · +214 −87". */
  detail: string | null;
  /** A status shown on the right: "Needs approval", "Merged". */
  state: string | null;
  /** Where clicking the card goes, relative to the site. */
  href: string | null;
  /** A preview in Markdown under the title: a draft issue's body, a report's first lines. */
  body?: string | null;
  /** Labelled facts shown in two columns: "Repository · acme/web", "Cap · $2.00". */
  fields?: CardField[];
  /**
   * What people can do right here. Pressing one goes to the service that
   * owns the card (`owner`), which checks the person may, does it, and
   * updates the card in place. A card without `owner` has no actions.
   */
  actions?: CardAction[];
  /** The service whose card this was and that answered its actions: `agents`, on older cards only. */
  owner?: "agents" | null;
  /** What the card is about, for its owner: a session id, a draft id. */
  ref?: string | null;
};

export type CardField = { label: string; value: string };

/** A button on a card. */
export type CardAction = {
  /** Unique on the card: `stop`, `approve`, `file`. */
  id: string;
  label: string;
  style?: "primary" | "danger" | "default";
  /** Asked before it runs: "Stop this session and everything under it?". */
  confirm?: string | null;
  /** A value it needs first, asked inline: an amount in dollars, or a line of text. */
  input?: { kind: "money" | "text"; label: string; placeholder?: string | null; initial?: string | null } | null;
  /** A link instead of an action: opens this place in the site. */
  href?: string | null;
};

export type ChatMessage = {
  /** Time-sortable (ULID-like), so ordering by id is ordering by time. */
  id: string;
  channel_id: string;
  author: MemberProfile;
  kind: "text" | "card";
  body: string;
  card: MessageCard | null;
  /** The message this replies under, or null for a top-level message. */
  thread_root: string | null;
  reply_count: number;
  last_reply_at: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  /**
   * Its reactions, one per emoji in the order each was first used. Chat
   * always sets it; optional so messages a page makes for itself need not.
   */
  reactions?: ChatReaction[];
  /**
   * On a message from @g1t that answers someone: how the answer went, who
   * wrote it, and the steps it took. Absent on every other message.
   */
  answer?: ChatAnswer | null;
  /**
   * On a question someone asked @g1t from a page (the top bar's Ask): the
   * page they were on, which g1t is told. Absent otherwise.
   */
  page?: AskPage | null;
  /**
   * A "New conversation" mark in a direct message with @g1t: answers after
   * it read only what was said after it. Absent otherwise.
   */
  reset?: boolean;
};

/**
 * Where an answer from @g1t is: `thinking` until its first words,
 * `streaming` while they come (live as `message.streaming`), then `done`,
 * `stopped` (Stop, or a newer question took over) or `error`.
 */
export type ChatAnswerState = "thinking" | "streaming" | "done" | "stopped" | "error";

export type ChatAnswer = {
  state: ChatAnswerState;
  /** The provider's name and the model, once the provider said. */
  provider_label?: string | null;
  model?: string | null;
  /** `max_tokens`, `length`: cut off at its limit. */
  stop_reason?: string | null;
  /** What went wrong, for `error`. */
  error?: string | null;
  /**
   * Steps the answer took on its way (tool calls and the like), as the
   * integrations service streamed them: each `ask` event other than meta,
   * text, done and error, kept as it came. At most 50.
   */
  steps?: Record<string, unknown>[];
  /** Set when Ask is not set up in the workspace: the answer says where to set it up. */
  setup?: "missing" | null;
};

/**
 * One emoji's reactions on a message. `emoji` is a Unicode emoji or
 * `:name:` for one of the workspace's own (`CustomEmoji`).
 */
export type ChatReaction = {
  emoji: string;
  /** Everyone who reacted with it, people and agents alike. */
  count: number;
  /**
   * Whether the viewer did. In live `message.*` events, which everyone in
   * the room gets, it is always false: keep your own from what you know.
   */
  me: boolean;
  /** The first ten who reacted with it, for the hover list. */
  by: MemberProfile[];
};

/** Who may add a workspace's emoji: every member (the default), or only its owners. */
export type EmojiUpload = "members" | "admins";

/**
 * One of a workspace's own emoji, used as `:name:`. Its image is served
 * from the usercontent origin at `/emoji/<file>` (never from the site).
 */
export type CustomEmoji = {
  name: string;
  /** For an alias, the emoji it is another name for; it shows that one's image. */
  alias_of: string | null;
  /** The SHA-256 of the image's bytes. */
  file: string;
  content_type: "image/png" | "image/gif" | "image/webp";
  bytes: number;
  created_by: MemberProfile;
  created_at: string;
};

export type EmojiList = {
  emoji: CustomEmoji[];
  emoji_upload: EmojiUpload;
  /** Whether the viewer may add emoji and aliases. */
  can_upload: boolean;
  /** Whether the viewer is an owner: may remove any emoji and change `emoji_upload`. */
  can_manage: boolean;
};

/** Who may do something in a workspace's chat: every member, or only its owners. */
export type ChatAllowed = "members" | "owners";

/**
 * Who may rename and archive a channel: its owners (whoever made it) and
 * the workspace's owners (the default), or the workspace's owners only.
 */
export type ChannelManagers = "channel_owners" | "owners";

/**
 * A workspace's chat settings, which its owners choose (Workspace,
 * Settings, Chat). The chat service enforces each one; the page only
 * hides what the viewer may not do.
 */
export type ChatSettings = {
  /** Who may create public channels. */
  public_channels: ChatAllowed;
  /** Who may create private channels. */
  private_channels: ChatAllowed;
  /** Who may rename, archive and unarchive channels. */
  manage_channels: ChannelManagers;
  /** Who may add custom emoji (`admins` is the workspace's owners). */
  emoji_upload: EmojiUpload;
  /**
   * The public channels someone new is put in the first time they open
   * Chat, by id. #general unless the owners chose otherwise.
   */
  default_channels: string[];
};

/** What the viewer may do in a workspace's chat, from its settings and their role. */
export type ChatPermissions = {
  create_public_channels: boolean;
  create_private_channels: boolean;
  add_emoji: boolean;
  /** Whether they may change the workspace's chat settings: owners only. */
  manage_settings: boolean;
};

/** The chat settings page: the settings, what the viewer may do, and the public channels to choose defaults from. */
export type ChatSettingsView = {
  settings: ChatSettings;
  can: ChatPermissions;
  channels: Channel[];
};

/** A change to a channel: its name, its topic, or whether it is archived. Anything left out stays. */
export type ChannelChange = { name?: string; topic?: string | null; archived?: boolean };

/** An image for a new emoji, as base64. Its type is read from its bytes, never taken from here. */
export type EmojiFile = { data: string };

/** The largest custom emoji image, in bytes, and the widest or tallest, in pixels. */
export const MAX_EMOJI_BYTES = 256 * 1024;
export const MAX_EMOJI_SIDE = 512;

/** One row of the Chat sidebar. */
export type ChatSidebarEntry = {
  channel: Channel;
  /** "g1t-core", or the other members' names for a direct message. */
  title: string;
  /** For a direct message: who else is in it (up to four). */
  others: MemberProfile[];
  starred: boolean;
  muted: boolean;
  unread: number;
  mentions: number;
};

export type ChatSidebar = {
  entries: ChatSidebarEntry[];
  /** Public channels in the workspace the viewer has not joined. */
  browsable: number;
  /** What the viewer may do, from the workspace's chat settings: the page hides what they may not. */
  can: ChatPermissions;
};

/**
 * `activity`: what was said over a span, in the conversations the viewer
 * can read (every public channel, and the private channels and direct
 * messages they are in). Messages are text messages and thread replies
 * that were not deleted; cards agents post are not messages. Home reads it
 * for what people and agents said since you were last there.
 */
export type ChatActivity = {
  /** RFC 3339: `[from, until)`. */
  from: string;
  until: string;
  messages: number;
  /** Conversations with at least one message. */
  channels: number;
  /** Who said how much: member keys (`user:<id>`, `agent:<id>`), most first. */
  authors: { key: string; messages: number }[];
};

export type MessagePage = {
  messages: ChatMessage[];
  /** Pass as `before` to read further back; null at the beginning. */
  older: string | null;
  /**
   * For a thread's first page: the message the thread is under, however
   * many replies it has, so a thread panel always shows it (a session's
   * live card, say) at its top.
   */
  root?: ChatMessage | null;
  /**
   * Set when the page was read with `after`: pass it as `after` again for
   * the next messages, or null when this page reached the newest.
   */
  newer?: string | null;
};

export type NewChannel = { name: string; topic?: string | null; private?: boolean };

export type PostMessage = {
  body: string;
  thread_root?: string | null;
  /** In a direct message with @g1t: the page the person asks from, which g1t is told. Ignored elsewhere. */
  page?: AskPage | null;
};

/**
 * What the live socket sends. The site opens
 * `wss://<site>/<workspace>/chat/live?channel=<id>`; the site checks the
 * session and forwards the upgrade to the chat service with the viewer.
 */
export type ChatLiveEvent =
  | { type: "message.created"; message: ChatMessage }
  | { type: "message.updated"; message: ChatMessage }
  | { type: "message.deleted"; channel_id: string; id: string }
  /**
   * An answer from @g1t as it is written: the whole text so far (not a
   * delta, so a late or dropped frame never garbles it) and where it is.
   * The stored message catches up with a `message.updated` at the end.
   */
  | { type: "message.streaming"; channel_id: string; id: string; body: string; answer: ChatAnswer }
  | { type: "typing"; channel_id: string; member: MemberProfile; until: string }
  | { type: "read"; channel_id: string; principal: Principal; last_read_id: string }
  | { type: "channel.updated"; channel: Channel }
  | { type: "reaction.added" | "reaction.removed"; channel_id: string; message_id: string; emoji: string; member: MemberProfile };

/**
 * Header the site sets on a forwarded live socket: the viewer, as JSON.
 * The site forwards the upgrade to the chat service's
 * `GET /live?workspace=<slug>&channel=<id>` (`workspace` may be left out,
 * at the cost of looking up each of the viewer's workspaces).
 */
export const CHAT_VIEWER_HEADER = "x-g1t-chat-viewer";

/** A channel with its members, and whether the viewer may rename or archive it. */
export type ChannelDetail = { channel: Channel; members: ChannelMember[]; can_manage: boolean };

export type ChatApi = {
  sidebar(workspace: string, viewer: User): Promise<Result<ChatSidebar>>;
  /** What was said in `[from, until)` (RFC 3339) where the viewer can read, counted. */
  activity(workspace: string, viewer: User, span: { from: string; until: string }): Promise<Result<ChatActivity>>;
  channel(
    workspace: string,
    channelId: string,
    viewer: User,
  ): Promise<Result<ChannelDetail>>;
  /** The same, found by its name in the workspace (`#general` or `general`), as the site's URLs name channels. */
  channelByName(
    workspace: string,
    name: string,
    viewer: User,
  ): Promise<Result<ChannelDetail>>;
  /**
   * Browse channels: every public channel, and the private ones the viewer
   * is in. With `archived`, the archived ones instead.
   */
  browse(workspace: string, viewer: User, options?: { archived?: boolean }): Promise<Result<Channel[]>>;
  /** Makes a channel. Who may make a public or a private one is the workspace's setting. */
  createChannel(workspace: string, viewer: User, input: NewChannel): Promise<Result<Channel>>;
  /**
   * Renames, archives or unarchives a channel (the workspace's
   * `manage_channels` setting says who may), or changes its topic (any
   * member). #general is never renamed or archived. Everyone looking at it
   * gets `channel.updated`.
   */
  updateChannel(workspace: string, channelId: string, viewer: User, change: ChannelChange): Promise<Result<Channel>>;
  /** The workspace's chat settings, for any member; only owners may change them. */
  chatSettings(workspace: string, viewer: User): Promise<Result<ChatSettingsView>>;
  /** Owners only: changes some of the workspace's chat settings, and answers all of them. */
  setChatSettings(workspace: string, viewer: User, change: Partial<ChatSettings>): Promise<Result<ChatSettings>>;
  /**
   * The direct message between the viewer and these members, created on
   * first use. The same set of members always gets the same channel.
   */
  openDm(workspace: string, viewer: User, members: Principal[]): Promise<Result<Channel>>;
  join(workspace: string, channelId: string, viewer: User): Promise<Result<null>>;
  leave(workspace: string, channelId: string, viewer: User): Promise<Result<null>>;
  /** Adds a person. An invite grants read, never write. */
  invite(workspace: string, channelId: string, viewer: User, member: Principal): Promise<Result<null>>;
  /**
   * Newest first. Without `thread_root`, the channel's top-level messages;
   * with it, that thread's replies, plus the message they reply to as the
   * oldest once the page reaches the start of the thread (`older` null).
   * With `after` (catching up after a reconnect): the messages after that
   * id instead, oldest first, deleted ones included so the client can
   * drop them; `newer` says whether there are more.
   * Limit 50 by default, 200 at most.
   */
  messages(
    workspace: string,
    channelId: string,
    viewer: User,
    page?: { before?: string | null; after?: string | null; limit?: number; thread_root?: string | null },
  ): Promise<Result<MessagePage>>;
  post(workspace: string, channelId: string, viewer: User, message: PostMessage): Promise<Result<ChatMessage>>;
  edit(workspace: string, channelId: string, viewer: User, id: string, body: string): Promise<Result<ChatMessage>>;
  remove(workspace: string, channelId: string, viewer: User, id: string): Promise<Result<null>>;
  markRead(workspace: string, channelId: string, viewer: User, id: string): Promise<Result<null>>;
  setPreferences(
    workspace: string,
    channelId: string,
    viewer: User,
    prefs: { starred?: boolean; muted?: boolean },
  ): Promise<Result<null>>;
  /**
   * Reacts to a message with `emoji` (one Unicode emoji, or `:name:` for
   * one of the workspace's own). Once per member per emoji; at most 50
   * different emoji on a message. Answers the message's reactions now.
   */
  react(workspace: string, channelId: string, viewer: User, messageId: string, emoji: string): Promise<Result<ChatReaction[]>>;
  unreact(workspace: string, channelId: string, viewer: User, messageId: string, emoji: string): Promise<Result<ChatReaction[]>>;
  /** The workspace's own emoji, by name, and who may add them. */
  listEmoji(workspace: string, viewer: User): Promise<Result<EmojiList>>;
  /** Adds an emoji: a PNG, GIF or WebP of at most 256 KB and 512×512. */
  addEmoji(workspace: string, viewer: User, name: string, file: EmojiFile): Promise<Result<CustomEmoji>>;
  /** Gives an existing emoji (`target`) another name. */
  aliasEmoji(workspace: string, viewer: User, name: string, target: string): Promise<Result<CustomEmoji>>;
  /** Removes an emoji, and its aliases with it. Its creator or an owner may. */
  removeEmoji(workspace: string, viewer: User, name: string): Promise<Result<null>>;
  /** Owners only: who may add emoji. */
  setEmojiUpload(workspace: string, viewer: User, value: EmojiUpload): Promise<Result<EmojiUpload>>;
  /** The viewer's direct message with @g1t, created on first use. */
  g1tDm(workspace: string, viewer: User): Promise<Result<Channel>>;
  /**
   * Starts a new conversation in the viewer's direct message with @g1t: a
   * mark after which answers read only what comes next. Stops an answer
   * still coming.
   */
  g1tReset(workspace: string, channelId: string, viewer: User): Promise<Result<ChatMessage>>;
  /** Has @g1t answer the latest question again, in place of its last answer. */
  g1tRetry(workspace: string, channelId: string, viewer: User): Promise<Result<null>>;
  /** Stops @g1t's answer still coming; what came stays. */
  g1tStop(workspace: string, channelId: string, viewer: User): Promise<Result<null>>;
};

/**
 * For g1t's own services only, never the site on a person's behalf: posts
 * and edits messages as @g1t in a direct message with it. The chat service
 * answers these at `POST /internal/<method>`, which no route from the site
 * reaches, and refuses anything that came in from the internet.
 */
export type ChatInternalApi = {
  /** Posts `body` as @g1t in a direct message with it, in the workspace with this slug. */
  g1tPost(workspace: string, channelId: string, body: string): Promise<Result<ChatMessage>>;
  /** Changes the text of one of @g1t's messages there. */
  g1tEdit(workspace: string, channelId: string, id: string, body: string): Promise<Result<ChatMessage>>;
};

export function chatInternalClient(service: ServiceBinding): ChatInternalApi {
  const call = async <T>(method: string, args: object): Promise<T> => {
    const response = await service.fetch(`https://service/internal/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`${method} failed with status ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    g1tPost: (workspace, channelId, body) => call("g1t_post", { workspace, channel_id: channelId, body }),
    g1tEdit: (workspace, channelId, id, body) => call("g1t_edit", { workspace, channel_id: channelId, id, body }),
  };
}

async function rpc<T>(service: ServiceBinding, method: string, args: object): Promise<T> {
  const response = await service.fetch(`https://service/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    throw new Error(`${method} failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export function chatClient(service: ServiceBinding): ChatApi {
  const call = <T>(method: string, args: object) => rpc<T>(service, method, args);
  return {
    sidebar: (workspace, viewer) => call("sidebar", { workspace, viewer }),
    activity: (workspace, viewer, span) => call("activity", { workspace, viewer, from: span.from, until: span.until }),
    channel: (workspace, channelId, viewer) => call("channel", { workspace, channel_id: channelId, viewer }),
    channelByName: (workspace, name, viewer) => call("channel_by_name", { workspace, name, viewer }),
    browse: (workspace, viewer, options) => call("browse", { workspace, viewer, archived: options?.archived ?? false }),
    createChannel: (workspace, viewer, input) => call("create_channel", { workspace, viewer, input }),
    updateChannel: (workspace, channelId, viewer, change) => call("update_channel", { workspace, channel_id: channelId, viewer, change }),
    chatSettings: (workspace, viewer) => call("chat_settings", { workspace, viewer }),
    setChatSettings: (workspace, viewer, change) => call("set_chat_settings", { workspace, viewer, change }),
    openDm: (workspace, viewer, members) => call("open_dm", { workspace, viewer, members }),
    join: (workspace, channelId, viewer) => call("join", { workspace, channel_id: channelId, viewer }),
    leave: (workspace, channelId, viewer) => call("leave", { workspace, channel_id: channelId, viewer }),
    invite: (workspace, channelId, viewer, member) =>
      call("invite", { workspace, channel_id: channelId, viewer, member }),
    messages: (workspace, channelId, viewer, page) =>
      call("messages", {
        workspace,
        channel_id: channelId,
        viewer,
        before: page?.before ?? null,
        after: page?.after ?? null,
        limit: page?.limit ?? null,
        thread_root: page?.thread_root ?? null,
      }),
    post: (workspace, channelId, viewer, message) => call("post", { workspace, channel_id: channelId, viewer, message }),
    edit: (workspace, channelId, viewer, id, body) => call("edit", { workspace, channel_id: channelId, viewer, id, body }),
    remove: (workspace, channelId, viewer, id) => call("remove", { workspace, channel_id: channelId, viewer, id }),
    markRead: (workspace, channelId, viewer, id) => call("mark_read", { workspace, channel_id: channelId, viewer, id }),
    setPreferences: (workspace, channelId, viewer, prefs) =>
      call("set_preferences", { workspace, channel_id: channelId, viewer, prefs }),
    react: (workspace, channelId, viewer, messageId, emoji) =>
      call("react", { workspace, channel_id: channelId, viewer, message_id: messageId, emoji }),
    unreact: (workspace, channelId, viewer, messageId, emoji) =>
      call("unreact", { workspace, channel_id: channelId, viewer, message_id: messageId, emoji }),
    listEmoji: (workspace, viewer) => call("list_emoji", { workspace, viewer }),
    addEmoji: (workspace, viewer, name, file) => call("add_emoji", { workspace, viewer, name, file }),
    aliasEmoji: (workspace, viewer, name, target) => call("alias_emoji", { workspace, viewer, name, target }),
    removeEmoji: (workspace, viewer, name) => call("remove_emoji", { workspace, viewer, name }),
    setEmojiUpload: (workspace, viewer, value) => call("set_emoji_upload", { workspace, viewer, value }),
    g1tDm: (workspace, viewer) => call("g1t_dm", { workspace, viewer }),
    g1tReset: (workspace, channelId, viewer) => call("g1t_reset", { workspace, channel_id: channelId, viewer }),
    g1tRetry: (workspace, channelId, viewer) => call("g1t_retry", { workspace, channel_id: channelId, viewer }),
    g1tStop: (workspace, channelId, viewer) => call("g1t_stop", { workspace, channel_id: channelId, viewer }),
  };
}
