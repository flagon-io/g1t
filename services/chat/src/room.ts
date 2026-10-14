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

import {
  G1T_KEY,
  aiClient,
  principalKey,
  type AskMessage,
  type AskPage,
  type ChatAnswer,
  type ChatLiveEvent,
  type ChatMessage,
  type MemberProfile,
  type ServiceBinding,
  type User,
} from "@g1t/contracts";

import { runAnswer } from "./answer.ts";
import { G1T_PROFILE, answerAllowed, metaColumn } from "./g1t.ts";
import { PERSON_TYPING_MS, isTypingFrame } from "./messages.ts";
import { notifyMessage } from "./notify.ts";

/** Header the Worker sets on a socket it forwards: who it is, as JSON (`RoomMember`). */
export const ROOM_MEMBER_HEADER = "x-g1t-chat-member";

export type RoomMember = { channel_id: string; member: MemberProfile };

/** The shortest time between two "is typing" events from one socket. */
const TYPING_EVERY_MS = 2_000;
/** How long g1t shows as typing before its first words, at most. */
const G1T_TYPING_MS = 30_000;

type RoomEnv = {
  DB: D1Database;
  /** Ask (services/integrations): where @g1t's answers come from. */
  INTEGRATIONS?: ServiceBinding;
  NOTIFY?: ServiceBinding;
};

/**
 * A question for @g1t to answer, as src/index.ts hands it over: who asked
 * (the person, as their session had them), the conversation, the page, and
 * the message the answer is written into.
 */
export type AnswerJob = {
  slug: string;
  channel: { id: string; kind: "channel" | "dm"; name: string | null };
  actor: User;
  messages: AskMessage[];
  page: AskPage;
  message: ChatMessage;
  /**
   * The person's newest message the answer read. Gone when it is looked
   * for: the conversation was cleared after it was read, and the answer
   * is thrown away (`clear`). Absent on a job handed over before it was.
   */
  question_id?: string;
};

export class ChannelRoom extends DurableObject<RoomEnv> {
  /** When each socket last said it was typing; lost on hibernation, which only lets one more through. */
  private typedAt = new WeakMap<WebSocket, number>();
  /** The answer being written now, to stop; one at a time per room. */
  private running: { id: string; stop: AbortController; superseded: boolean; cleared: boolean } | null = null;

  constructor(ctx: DurableObjectState, env: RoomEnv) {
    super(ctx, env);
    // Keepalives are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (await this.ctx.storage.get("erased")) return new Response("Conversation erased", { status: 410 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade\n", { status: 426 });
    }
    let who: RoomMember;
    try {
      who = JSON.parse(request.headers.get(ROOM_MEMBER_HEADER) ?? "") as RoomMember;
    } catch {
      return new Response("Missing member\n", { status: 400 });
    }
    if (await this.ctx.storage.get(`erased:${principalKey(who.member)}`)) return new Response("Account erased", { status: 410 });
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

  // ── @g1t's answers (src/answer.ts) ──────────────────────────────────────

  /**
   * Answers a question in this direct message with g1t. One answer at a
   * time: a newer question takes over, stopping the one being written
   * (what came of it stays; one that had not started is taken away), and
   * the new answer reads both questions. Run from an alarm, so a long
   * answer is not cut short when the request that asked ends.
   */
  async startAnswer(job: AnswerJob): Promise<void> {
    // Read before a clear that has deleted its question since: thrown away, never asked.
    if (await this.questionGone(job)) {
      await this.discard(job.channel.id, job.message.id);
      return;
    }
    const times = answerAllowed((await this.ctx.storage.get<number[]>("answered")) ?? [], Date.now());
    await this.ctx.storage.put("answered", times.times);
    if (!times.ok) {
      const answer: ChatAnswer = { state: "error", error: "Too many questions in a minute." };
      await this.end(job, "You've asked a lot in the last minute. Wait a moment, then ask again.", answer, false);
      return;
    }
    const pending = await this.ctx.storage.get<AnswerJob>("job");
    if (pending) await this.dropAnswer(pending);
    if (this.running) {
      this.running.superseded = true;
      this.running.stop.abort();
    }
    await this.ctx.storage.put("job", job);
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** Stops the answer being written, or about to be; what came stays. */
  async stopAnswer(): Promise<void> {
    const pending = await this.ctx.storage.get<AnswerJob>("job");
    if (pending) {
      await this.ctx.storage.delete("job");
      await this.end(pending, "_Stopped before answering._", { ...pending.message.answer, state: "stopped" }, false);
    }
    this.running?.stop.abort();
  }

  override async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<AnswerJob>("job");
    if (!job) return;
    await this.ctx.storage.delete("job");
    const run = { id: job.message.id, stop: new AbortController(), superseded: false, cleared: false };
    // Running before it looks again, so a clear from now on finds it and stops it.
    this.running = run;
    if (await this.questionGone(job)) {
      if (this.running === run) this.running = null;
      await this.discard(job.channel.id, job.message.id);
      return;
    }
    const ask = aiClient(this.env.INTEGRATIONS as ServiceBinding);
    try {
      await runAnswer(
        {
          slug: job.slug,
          setup: async () => {
            if (!this.env.INTEGRATIONS) return null;
            const found = await ask.askSettings(job.slug, job.actor);
            return found.ok ? found.value : { provider_id: "unknown", provider_name: null, provider: null, model: null, problem: found.error.message };
          },
          ask: (signal) => ask.ask(job.actor, job.slug, job.messages, job.page, signal),
          typing: () =>
            this.broadcast({ type: "typing", channel_id: job.channel.id, member: G1T_PROFILE, until: new Date(Date.now() + G1T_TYPING_MS).toISOString() }),
          show: (body, answer) => {
            if (!run.cleared) this.broadcast({ type: "message.streaming", channel_id: job.channel.id, id: job.message.id, body, answer });
          },
          save: (body, answer) => (run.cleared ? Promise.resolve() : this.store(job.message.id, body, answer)),
          finish: (body, answer) => (run.cleared ? this.discard(job.channel.id, job.message.id) : this.end(job, body, answer, run.superseded)),
          now: () => Date.now(),
        },
        run.stop.signal,
      );
    } catch (error) {
      console.error("g1t could not answer in", job.channel.id, error);
    } finally {
      if (this.running === run) this.running = null;
    }
  }

  /**
   * The conversation was just cleared (src/index.ts `g1tClear`, after its
   * rows were deleted): an answer waiting to start is dropped, one being
   * written is stopped and thrown away, not saved, so nothing it read
   * comes back; and every tab looking empties. What it had already sent
   * the workspace's AI provider has gone to that provider.
   */
  async clear(channelId: string): Promise<void> {
    const pending = await this.ctx.storage.get<AnswerJob>("job");
    await this.ctx.storage.delete("job");
    const ids = new Set<string>();
    if (pending) ids.add(pending.message.id);
    if (this.running) {
      this.running.cleared = true;
      this.running.stop.abort();
      ids.add(this.running.id);
    }
    // Written after the rows went, an answer's own message would outlive the clear.
    for (const id of ids) await this.env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
    this.broadcast({ type: "channel.cleared", channel_id: channelId });
  }

  /**
   * An erasure (src/erasure.ts). With a member, only that person is shut
   * out: everyone else's view and answers carry on, and nothing is cleared
   * for them. Without one, the whole conversation is going: its answer
   * job stops and every socket closes.
   */
  async erase(channelId: string, principal: string | null): Promise<void> {
    if (principal) {
      await this.ctx.storage.put(`erased:${principal}`, true);
      this.drop(principal);
      return;
    }
    await this.ctx.storage.put("erased", true);
    await this.clear(channelId);
    await this.ctx.storage.deleteAlarm();
    for (const socket of this.ctx.getWebSockets()) { try { socket.close(4403, "Conversation erased"); } catch {} }
  }

  /** Whether the question a job answers has been deleted by a clear. */
  private async questionGone(job: AnswerJob): Promise<boolean> {
    if (await this.ctx.storage.get("erased") || await this.ctx.storage.get(`erased:user:${job.actor.id}`)) return true;
    if (!job.question_id) return false;
    const row = await this.env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(job.question_id).first<{ id: string }>();
    return !row;
  }

  /** An answer to a cleared conversation: its message goes for good, and tabs drop it. */
  private async discard(channelId: string, id: string): Promise<void> {
    await this.env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
    this.broadcast({ type: "message.deleted", channel_id: channelId, id });
  }

  /** Saves an answer as it is now. */
  private async store(id: string, body: string, answer: ChatAnswer): Promise<void> {
    await this.env.DB.prepare("UPDATE messages SET body = ?, meta = ? WHERE id = ? AND deleted_at IS NULL")
      .bind(body, metaColumn({ answer }), id)
      .run();
  }

  /** A question taken over before its answer started: its empty message goes. */
  private async dropAnswer(job: AnswerJob): Promise<void> {
    await this.ctx.storage.delete("job");
    await this.env.DB.prepare("UPDATE messages SET deleted_at = ?, body = '' WHERE id = ?").bind(new Date().toISOString(), job.message.id).run();
    this.broadcast({ type: "message.deleted", channel_id: job.channel.id, id: job.message.id });
  }

  /**
   * Ends an answer: stored as a normal message, sent to the room, and the
   * person notified (their direct message notifies them, as any would).
   * One taken over by a newer question before a word of it came is taken
   * away instead.
   */
  private async end(job: AnswerJob, body: string, answer: ChatAnswer, superseded: boolean): Promise<void> {
    const { message, channel } = job;
    if (superseded && answer.state === "stopped" && !message.body && body.startsWith("_Stopped")) {
      await this.dropAnswer(job);
      return;
    }
    const at = new Date().toISOString();
    const [saved] = await this.env.DB.batch([
      this.env.DB.prepare("UPDATE messages SET body = ?, meta = ? WHERE id = ?").bind(body, metaColumn({ answer }), message.id),
      this.env.DB.prepare("UPDATE channels SET last_message_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ?)").bind(at, channel.id, message.id),
    ]);
    // Its message is gone: the conversation was cleared meanwhile. Nobody is shown or told it.
    if (saved && saved.meta && saved.meta.changes === 0) return;
    this.broadcast({ type: "message.updated", message: { ...message, body, answer } });
    if (answer.state === "stopped") return;
    await notifyMessage(
      this.env.DB,
      this.env.NOTIFY,
      // The person's name only matters for mentions, which g1t's answers do not notify by.
      async (keys) => new Map(keys.map((key) => [key, key === G1T_KEY ? G1T_PROFILE : ({ kind: "user", id: key.slice(5), name: "", display_name: "", avatar: null, role: null } as MemberProfile)])),
      { slug: job.slug, channel, row: { id: message.id, author: G1T_KEY, body, thread_root: null, created_at: message.created_at }, handles: [] },
    ).catch((error) => console.error("chat could not notify about", message.id, error));
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const who = socket.deserializeAttachment() as RoomMember | null;
    if (!who || await this.ctx.storage.get("erased") || await this.ctx.storage.get(`erased:${principalKey(who.member)}`)) return;
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
