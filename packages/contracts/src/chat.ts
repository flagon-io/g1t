/**
 * Chat: channels, direct messages, threads and messages, kept by the chat
 * service (`services/chat`). People and agents are members alike. Plan:
 * docs/WORKSPACE.md.
 *
 * Wire shapes are snake_case end to end, so the site, the public API and
 * the live socket all carry the same objects.
 */
import type { ServiceBinding } from "./clients";
import type { User } from "./identity";
import type { Result } from "./result";
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
  /** `username` for a person, `handle` for an agent. */
  name: string;
  display_name: string;
  /** Uploaded avatar hash for a person, or null for the letter avatar. */
  avatar: string | null;
  /** An agent's one-line role ("Release manager for g1t"). */
  role: string | null;
};

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
  /** What it is about, e.g. `pull`, `issue`, `task`, `deploy`, `approval`. */
  kind: string;
  title: string;
  /** A short line under the title: "3/3 checks · +214 −87". */
  detail: string | null;
  /** A status shown on the right: "Needs approval", "Merged". */
  state: string | null;
  /** Where clicking the card goes, relative to the site. */
  href: string | null;
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
};

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
};

export type MessagePage = {
  messages: ChatMessage[];
  /** Pass as `before` to read further back; null at the beginning. */
  older: string | null;
  /**
   * Set when the page was read with `after`: pass it as `after` again for
   * the next messages, or null when this page reached the newest.
   */
  newer?: string | null;
};

export type NewChannel = { name: string; topic?: string | null; private?: boolean };

export type PostMessage = { body: string; thread_root?: string | null };

/** The most agent-to-agent hops one person's request may start (docs/WORKSPACE.md, "Hop limit"). */
export const CHAT_MAX_HOPS = 6;

/**
 * What an agent posts. When it answers a delivery, it passes that
 * delivery's `hops`, `asked_by` and `asker` back, so another agent it @mentions is
 * handed the message one hop further along the same person's request, and
 * the chain stops at `CHAT_MAX_HOPS`. Left out: a new chain (hops 0) asked
 * by the person who created the agent.
 */
export type AgentPostMessage = PostMessage & {
  card?: MessageCard | null;
  hops?: number;
  asked_by?: string | null;
  /** The delivery's `asker`, handed on to agents this message wakes. Absent: none (they treat the asker as unable to change code). */
  asker?: AskerAccess | null;
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
  | { type: "typing"; channel_id: string; member: MemberProfile; until: string }
  | { type: "read"; channel_id: string; principal: Principal; last_read_id: string };

/**
 * Header the site sets on a forwarded live socket: the viewer, as JSON.
 * The site forwards the upgrade to the chat service's
 * `GET /live?workspace=<slug>&channel=<id>` (`workspace` may be left out,
 * at the cost of looking up each of the viewer's workspaces).
 */
export const CHAT_VIEWER_HEADER = "x-g1t-chat-viewer";

export type ChatApi = {
  sidebar(workspace: string, viewer: User): Promise<Result<ChatSidebar>>;
  channel(
    workspace: string,
    channelId: string,
    viewer: User,
  ): Promise<Result<{ channel: Channel; members: ChannelMember[] }>>;
  /** The same, found by its name in the workspace (`#general` or `general`), as the site's URLs name channels. */
  channelByName(
    workspace: string,
    name: string,
    viewer: User,
  ): Promise<Result<{ channel: Channel; members: ChannelMember[] }>>;
  /** Public channels, for Browse channels. */
  browse(workspace: string, viewer: User): Promise<Result<Channel[]>>;
  createChannel(workspace: string, viewer: User, input: NewChannel): Promise<Result<Channel>>;
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
    channel: (workspace, channelId, viewer) => call("channel", { workspace, channel_id: channelId, viewer }),
    channelByName: (workspace, name, viewer) => call("channel_by_name", { workspace, name, viewer }),
    browse: (workspace, viewer) => call("browse", { workspace, viewer }),
    createChannel: (workspace, viewer, input) => call("create_channel", { workspace, viewer, input }),
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
    agentTyping: (workspace, channelId, agentId) =>
      call("agent_typing", { workspace, channel_id: channelId, agent_id: agentId }),
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
