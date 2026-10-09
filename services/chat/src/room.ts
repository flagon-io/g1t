/**
 * One channel's live room, as a Durable Object named by the channel id.
 *
 * Why an object per channel: everyone looking at a channel must see the
 * same messages in the same order the moment they are written, and one
 * object per channel sees every socket open on it. It holds the sockets
 * with the WebSocket Hibernation API, so a quiet channel with people
 * looking at it costs nothing between messages: the object is evicted
 * from memory and the sockets stay open at the edge. Each socket carries
 * who is behind it (`serializeAttachment`), which survives hibernation.
 *
 * The room authorizes nothing. The Worker checks a viewer may read the
 * channel before forwarding their socket here (src/index.ts, `live`), and
 * tells the room to drop someone's sockets when they leave a private one.
 */
import { DurableObject } from "cloudflare:workers";

import { principalKey, type ChatLiveEvent, type MemberProfile } from "@g1t/contracts";

import { PERSON_TYPING_MS, isTypingFrame } from "./messages.ts";

/** Header the Worker sets on a socket it forwards: who it is, as JSON (`RoomMember`). */
export const ROOM_MEMBER_HEADER = "x-g1t-chat-member";

export type RoomMember = { channel_id: string; member: MemberProfile };

/** The shortest time between two "is typing" events from one socket. */
const TYPING_EVERY_MS = 2_000;

export class ChannelRoom extends DurableObject<object> {
  /** When each socket last said it was typing; lost on hibernation, which only lets one more through. */
  private typedAt = new WeakMap<WebSocket, number>();

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    // Keepalives are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade\n", { status: 426 });
    }
    let who: RoomMember;
    try {
      who = JSON.parse(request.headers.get(ROOM_MEMBER_HEADER) ?? "") as RoomMember;
    } catch {
      return new Response("Missing member\n", { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    // Tagged with the member's key, so their sockets can be found to drop.
    this.ctx.acceptWebSocket(server, [principalKey(who.member)]);
    server.serializeAttachment(who);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Sends `event` to every socket in the room, except those of `except` (a principal key). */
  broadcast(event: ChatLiveEvent, except: string | null = null): void {
    const text = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      if (except && this.ctx.getTags(socket).includes(except)) continue;
      try {
        socket.send(text);
      } catch {
        // Closing already; webSocketClose tidies up.
      }
    }
  }

  /** Closes a member's sockets: they left a private channel and may no longer read it. */
  drop(principal: string): void {
    for (const socket of this.ctx.getWebSockets(principal)) {
      try {
        socket.close(4403, "No longer a member");
      } catch {
        // Already closed.
      }
    }
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const who = socket.deserializeAttachment() as RoomMember | null;
    if (!who) return;
    // The only thing a client says over the socket: it is typing
    // (`{"type":"typing","channel_id":"<id>"}`, at most every 3 s).
    // Everything else (posting, reading) goes through the site, which
    // checks it.
    if (!isTypingFrame(message, who.channel_id)) return;
    const now = Date.now();
    if (now - (this.typedAt.get(socket) ?? 0) < TYPING_EVERY_MS) return;
    this.typedAt.set(socket, now);
    this.broadcast(
      {
        type: "typing",
        channel_id: who.channel_id,
        member: who.member,
        until: new Date(now + PERSON_TYPING_MS).toISOString(),
      },
      principalKey(who.member),
    );
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(): Promise<void> {
    // Nothing to keep: the socket is gone, and getWebSockets no longer lists it.
  }
}
