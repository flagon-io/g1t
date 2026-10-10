/**
 * Chat: channels, direct messages, threads and messages, kept by the chat
 * service (`services/chat`). People and agents are members alike.
 *
 * Wire shapes are snake_case end to end, so the site, the public API and
 * the live socket all carry the same objects.
 */
import type { ServiceBinding } from "./clients";
import type { User } from "./identity";
import type { Result } from "./result";
import type { AgentLook } from "./agent-look";
import type { AskerAccess } from "./workspace-agents";

/** Who is speaking: a person (by user id) or a workspace agent (by agent id). */
export type Principal = { kind: "user" | "agent"; id: string };

export function principalKey(principal: Principal): string {
  return `${principal.kind}:${principal.id}`;
}

export function parsePrincipalKey(key: string): Principal | null {
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
  /** An agent's chosen face (./agent-look.ts); null for a person, or an agent wearing its seed's face. */
  look?: AgentLook | null;
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
  /** The service whose card this is and that answers its actions: `agents`. */
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

/** What pressing a card's action did, as the person who pressed it is told. */
export type CardActionResult = { ok: boolean; message: string | null };

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

export type PostMessage = { body: string; thread_root?: string | null };

/**
 * Who will read what is said in a conversation: a direct message's or
 * private channel's people, or, for a public channel, the whole workspace.
 * An agent answers there only with what every one of them may see.
 */
export type ChatAudience = {
  kind: "dm" | "private" | "public";
  /** The people in it (agents left out). For a public channel, its current members, for reference only. */
  member_user_ids: string[];
  member_count: number;
};

/** A message an agent found by searching, with the conversation it is in. */
export type AgentFoundMessage = {
  channel_id: string;
  /** The channel's name, or null for a direct message. */
  channel: string | null;
  message: ChatMessage;
};

/** The most agent-to-agent hops one person's request may start. */
export const CHAT_MAX_HOPS = 6;

/**
 * What an agent posts. An agent's message never wakes another agent, even
 * when it @mentions one: only a hand-off does (`handOffAsAgent`). Its
 * mentions of anyone who is not a member of the conversation lose their
 * `@`, so they show as plain names and notify nobody. When it answers a
 * delivery, it passes that delivery's `hops`, `asked_by`, `asker` and
 * `chain` back, which a card that waits on the asker uses. Left out: asked
 * by the person who created the agent.
 */
export type AgentPostMessage = PostMessage & {
  card?: MessageCard | null;
  hops?: number;
  asked_by?: string | null;
  /** The delivery's `asker`, handed on to agents this message wakes. Absent: none (they treat the asker as unable to change code). */
  asker?: AskerAccess | null;
  /**
   * The delivery's `chain`: the agents that handled this request before
   * the one posting, oldest first. Chat adds the poster, and never hands
   * the message to the agent that sent the work to it (no ping-pong).
   */
  chain?: string[];
};

/**
 * A conversation as an agent is told about it before every turn: what it
 * is and who is in it, so it knows who reads what it says and who doesn't.
 * Every agent member is listed; people up to `CONVERSATION_PEOPLE_SHOWN`
 * (the person who asked always among them), with the totals beside.
 */
export type ConversationForAgent = {
  channel: Channel;
  /** Agents first, then people. */
  members: MemberProfile[];
  /** How many people and agents are in it, listed or not. */
  people: number;
  agents: number;
};

/** The most people `conversationForAgent` lists; the rest are a count. */
export const CONVERSATION_PEOPLE_SHOWN = 20;

/**
 * An agent handing work to a colleague agent for the person who asked
 * (docs.g1t.sh/guides/agents/, "Hand off"). The fields after `brief`
 * are the delivery the agent is answering, passed back as for a post.
 */
export type AgentHandOff = {
  /** The colleague, by agent id. */
  colleague_id: string;
  /** What they are asked to do, addressed to them. */
  brief: string;
  thread_root?: string | null;
  hops?: number;
  asked_by: string;
  asker?: AskerAccess | null;
  chain?: string[];
};

/**
 * Where a hand-off went. `here`: the colleague is in this channel or group
 * direct message, and the brief was posted here. `group_dm`: the brief was
 * posted in the direct message of the person who asked, the agent and the
 * colleague (`opened` when it was new), and a card linking to it was
 * posted here.
 */
export type HandOffResult = { where: "here" | "group_dm"; channel_id: string; message_id: string; opened: boolean };

/**
 * What the live socket sends. The site opens
 * `wss://<site>/<workspace>/chat/live?channel=<id>`; the site checks the
 * session and forwards the upgrade to the chat service with the viewer.
 */
export type ChatLiveEvent =
  | { type: "message.created"; message: ChatMessage }
  | { type: "message.updated"; message: ChatMessage }
  | { type: "message.deleted"; channel_id: string; id: string }
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
  /** Adds a person or an agent. An invite grants read, never write. */
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
   * Posts as an agent. Only the agents service calls this, for replies and
   * cards; the agent must be a member of the channel.
   */
  postAsAgent(
    workspace: string,
    channelId: string,
    agentId: string,
    message: AgentPostMessage,
  ): Promise<Result<ChatMessage>>;
  /**
   * Changes a message an agent posted: its body, its card, or both. Only
   * the agents service calls this, to keep a session's live card current.
   * Changing a message wakes nobody.
   */
  updateAsAgent(
    workspace: string,
    channelId: string,
    agentId: string,
    id: string,
    change: { body?: string; card?: MessageCard | null },
  ): Promise<Result<ChatMessage>>;
  /**
   * A person presses an action on a card in a conversation they can read.
   * Chat hands it to the card's owner with the person, and the owner
   * decides, acts and updates the card.
   */
  cardAction(
    workspace: string,
    channelId: string,
    viewer: User,
    messageId: string,
    actionId: string,
    input?: string | null,
  ): Promise<Result<CardActionResult>>;
  /** Shows "is typing" for an agent while it works on a reply. */
  agentTyping(workspace: string, channelId: string, agentId: string): Promise<Result<null>>;
  /**
   * What an agent reads before it replies, oldest first: with
   * `thread_root`, that thread (its root, then its replies); without, the
   * channel's or direct message's latest top-level messages. Only the
   * agents service calls this; the agent must be a member of the channel,
   * so it reads only what was said where it was invited. `limit` defaults
   * to 30, at most 100.
   */
  historyForAgent(
    workspace: string,
    channelId: string,
    agentId: string,
    page?: { thread_root?: string | null; limit?: number },
  ): Promise<Result<ChatMessage[]>>;
  /** Internal: who reads a conversation. */
  audience(workspace: string, channelId: string): Promise<Result<ChatAudience>>;
  /**
   * Internal, for an agent about to answer in `channelId`, which it must be
   * a member of: the conversation and its members (`ConversationForAgent`).
   * `askedBy` (a user id) is always among the people listed.
   */
  conversationForAgent(workspace: string, channelId: string, agentId: string, askedBy?: string | null): Promise<Result<ConversationForAgent>>;
  /**
   * Internal: `agentId`, answering in `channelId`, hands work to a
   * colleague agent for the person who asked. If the colleague is in this
   * channel or group direct message, the brief is posted here; otherwise in
   * the group direct message of the person, the agent and the colleague
   * (opened on first use), with a card here linking to it. Either way the
   * brief wakes the colleague, one hop further along the same chain, and
   * nobody else. Refused for an agent that is not of the workspace, the
   * agent itself, @g1t, one already in the chain, past the hop limit, or
   * when the person who asked is not in this conversation.
   */
  handOffAsAgent(workspace: string, channelId: string, agentId: string, handOff: AgentHandOff): Promise<Result<HandOffResult>>;
  /**
   * Internal, for an agent replying in `channelId`: messages matching
   * `query` (newest first, at most 20) from conversations every person in
   * that conversation's audience is in, and from public channels. Never
   * another direct message unless it has exactly the same people. The
   * audience is worked out here from `channelId`, never taken from the
   * caller.
   */
  searchForAgent(workspace: string, channelId: string, query: string, limit?: number): Promise<Result<AgentFoundMessage[]>>;
  /**
   * Internal, for an agent replying in `channelId`: a thread (`id`, its
   * root or any reply) in `targetChannelId`, oldest first, under the same
   * rule. A conversation the audience may not read is not found, exactly
   * as one that does not exist.
   */
  threadForAgent(workspace: string, channelId: string, targetChannelId: string, id: string): Promise<Result<AgentFoundMessage[]>>;
  /**
   * Reacts to a message with `emoji` (one Unicode emoji, or `:name:` for
   * one of the workspace's own). Once per member per emoji; at most 50
   * different emoji on a message. Answers the message's reactions now.
   */
  react(workspace: string, channelId: string, viewer: User, messageId: string, emoji: string): Promise<Result<ChatReaction[]>>;
  unreact(workspace: string, channelId: string, viewer: User, messageId: string, emoji: string): Promise<Result<ChatReaction[]>>;
  /** Internal, for the agents service: an agent reacts (or, with `remove`, takes it back). It must be in the channel. */
  reactAsAgent(
    workspace: string,
    channelId: string,
    agentId: string,
    messageId: string,
    emoji: string,
    remove?: boolean,
  ): Promise<Result<ChatReaction[]>>;
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
};

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
    postAsAgent: (workspace, channelId, agentId, message) =>
      call("post_as_agent", { workspace, channel_id: channelId, agent_id: agentId, message }),
    cardAction: (workspace, channelId, viewer, messageId, actionId, input) =>
      call("card_action", { workspace, channel_id: channelId, viewer, message_id: messageId, action_id: actionId, input: input ?? null }),
    updateAsAgent: (workspace, channelId, agentId, id, change) =>
      call("update_as_agent", { workspace, channel_id: channelId, agent_id: agentId, id, change }),
    agentTyping: (workspace, channelId, agentId) =>
      call("agent_typing", { workspace, channel_id: channelId, agent_id: agentId }),
    audience: (workspace, channelId) => call("audience", { workspace, channel_id: channelId }),
    conversationForAgent: (workspace, channelId, agentId, askedBy) =>
      call("conversation_for_agent", { workspace, channel_id: channelId, agent_id: agentId, asked_by: askedBy ?? null }),
    handOffAsAgent: (workspace, channelId, agentId, handOff) =>
      call("hand_off_as_agent", { workspace, channel_id: channelId, agent_id: agentId, hand_off: handOff }),
    searchForAgent: (workspace, channelId, query, limit) =>
      call("search_for_agent", { workspace, channel_id: channelId, query, limit: limit ?? null }),
    threadForAgent: (workspace, channelId, targetChannelId, id) =>
      call("thread_for_agent", { workspace, channel_id: channelId, target_channel_id: targetChannelId, id }),
    react: (workspace, channelId, viewer, messageId, emoji) =>
      call("react", { workspace, channel_id: channelId, viewer, message_id: messageId, emoji }),
    unreact: (workspace, channelId, viewer, messageId, emoji) =>
      call("unreact", { workspace, channel_id: channelId, viewer, message_id: messageId, emoji }),
    reactAsAgent: (workspace, channelId, agentId, messageId, emoji, remove) =>
      call("react_as_agent", { workspace, channel_id: channelId, agent_id: agentId, message_id: messageId, emoji, remove: remove ?? false }),
    listEmoji: (workspace, viewer) => call("list_emoji", { workspace, viewer }),
    addEmoji: (workspace, viewer, name, file) => call("add_emoji", { workspace, viewer, name, file }),
    aliasEmoji: (workspace, viewer, name, target) => call("alias_emoji", { workspace, viewer, name, target }),
    removeEmoji: (workspace, viewer, name) => call("remove_emoji", { workspace, viewer, name }),
    setEmojiUpload: (workspace, viewer, value) => call("set_emoji_upload", { workspace, viewer, value }),
    historyForAgent: (workspace, channelId, agentId, page) =>
      call("history_for_agent", {
        workspace,
        channel_id: channelId,
        agent_id: agentId,
        thread_root: page?.thread_root ?? null,
        limit: page?.limit ?? null,
      }),
  };
}
