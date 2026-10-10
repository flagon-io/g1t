/**
 * Comment threads, kept in the page's Yjs document (the `threads` map) in
 * the shape BlockNote's Yjs thread stores read, so every open editor shows
 * a new comment the moment it is made. Writes come here, never from the
 * editor itself: the room applies them after checking who is asking.
 * Pure (yjs only).
 *
 * A thread's metadata carries `page_level: true` for a comment on the
 * whole page (no anchor in the text) and `quote`, the text it was on.
 * Comment authors are member keys (`user:<id>`, `agent:<id>`).
 */
import type { DocRole, DocThread, DocThreadAction } from "@g1t/contracts";
import * as Y from "yjs";

import { atLeast } from "./access.ts";

export type ThreadResult = { ok: true; value: unknown; mentions?: string[]; text?: string; thread_id?: string } | { ok: false; code: "not_found" | "forbidden" | "invalid"; message: string };

const MAX_BODY_BYTES = 64 * 1024;

function newId(): string {
  return crypto.randomUUID();
}

function commentMap(id: string, author: string, body: unknown, metadata: unknown, now: number): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", id);
  m.set("userId", author);
  m.set("createdAt", now);
  m.set("updatedAt", now);
  m.set("body", body);
  m.set("reactionsByUser", new Y.Map());
  m.set("metadata", metadata ?? null);
  return m;
}

function indexOf(comments: Y.Array<Y.Map<unknown>>, id: string): number {
  for (let i = 0; i < comments.length; i++) if (comments.get(i).get("id") === id) return i;
  return -1;
}

/** A comment body's text: BlockNote blocks' inline text, joined. */
export function bodyText(body: unknown): string {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (v.type === "text" && typeof v.text === "string") out.push(v.text);
      else if (v.type === "mention" && v.props && typeof v.props === "object") out.push(`@${(v.props as Record<string, string>).name ?? ""}`);
      else {
        if (v.content) walk(v.content);
        if (v.children) walk(v.children);
      }
    } else if (typeof value === "string") out.push(value);
  };
  walk(body);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** Member keys a comment body mentions (inline `mention` content). */
export function bodyMentions(body: unknown): string[] {
  const out = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (v.type === "mention" && v.props && typeof v.props === "object") {
        const p = v.props as Record<string, string>;
        if ((p.kind === "user" || p.kind === "agent") && p.id) out.add(`${p.kind}:${p.id}`);
      }
      if (v.content) walk(v.content);
      if (v.children) walk(v.children);
    }
  };
  walk(body);
  return [...out];
}

function tooBig(body: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(body ?? null)).length > MAX_BODY_BYTES;
}

/**
 * Applies one comment operation for `actor` (a member key) whose role in
 * the space is `role`. Anyone who can comment may start threads, reply,
 * resolve and react; only a comment's author edits it; its author or an
 * editor deletes it; only editors delete whole threads. `anchor` is done
 * by the room (edits.ts `anchorThread`), not here.
 */
export function applyThreadAction(doc: Y.Doc, actor: string, role: DocRole, action: DocThreadAction, now = Date.now()): ThreadResult {
  if (!atLeast(role, "comment")) return { ok: false, code: "forbidden", message: "You can read this page but not comment on it." };
  const threads = doc.getMap<Y.Map<unknown>>("threads");
  let result: ThreadResult = { ok: false, code: "invalid", message: "Unknown comment operation." };
  doc.transact(() => {
    switch (action.op) {
      case "create": {
        if (tooBig(action.body)) {
          result = { ok: false, code: "invalid", message: "That comment is too long." };
          return;
        }
        const id = newId();
        const thread = new Y.Map<unknown>();
        thread.set("id", id);
        thread.set("createdAt", now);
        thread.set("updatedAt", now);
        const comments = new Y.Array<Y.Map<unknown>>();
        const comment = commentMap(newId(), actor, action.body, action.metadata, now);
        comments.push([comment]);
        thread.set("comments", comments);
        thread.set("resolved", false);
        const metadata = { ...((action.metadata as object | null) ?? {}), ...(action.page_level ? { page_level: true } : {}) };
        thread.set("metadata", metadata);
        threads.set(id, thread);
        result = { ok: true, value: snapshot(thread), mentions: bodyMentions(action.body), text: bodyText(action.body), thread_id: id };
        return;
      }
      case "comment": {
        const thread = threads.get(action.thread_id);
        if (!thread) {
          result = { ok: false, code: "not_found", message: "That thread is gone." };
          return;
        }
        if (tooBig(action.body)) {
          result = { ok: false, code: "invalid", message: "That comment is too long." };
          return;
        }
        const comment = commentMap(newId(), actor, action.body, action.metadata, now);
        (thread.get("comments") as Y.Array<Y.Map<unknown>>).push([comment]);
        thread.set("updatedAt", now);
        result = { ok: true, value: commentSnapshot(comment), mentions: bodyMentions(action.body), text: bodyText(action.body), thread_id: action.thread_id };
        return;
      }
      case "edit_comment": {
        const found = findComment(threads, action.thread_id, action.comment_id);
        if (!found) {
          result = { ok: false, code: "not_found", message: "That comment is gone." };
          return;
        }
        if (found.comment.get("userId") !== actor) {
          result = { ok: false, code: "forbidden", message: "Only its author can edit a comment." };
          return;
        }
        found.comment.set("body", action.body);
        found.comment.set("updatedAt", now);
        found.comment.set("metadata", action.metadata ?? found.comment.get("metadata") ?? null);
        result = { ok: true, value: null };
        return;
      }
      case "delete_comment": {
        const found = findComment(threads, action.thread_id, action.comment_id);
        if (!found) {
          result = { ok: false, code: "not_found", message: "That comment is gone." };
          return;
        }
        if (found.comment.get("userId") !== actor && !atLeast(role, "edit")) {
          result = { ok: false, code: "forbidden", message: "Only its author or an editor can delete a comment." };
          return;
        }
        const comments = found.thread.get("comments") as Y.Array<Y.Map<unknown>>;
        if (action.soft) {
          found.comment.set("deletedAt", now);
          found.comment.set("body", undefined);
        } else comments.delete(found.index, 1);
        const left = comments.toArray().filter((c) => !c.get("deletedAt"));
        if (!left.length) {
          if (action.soft) found.thread.set("deletedAt", now);
          else threads.delete(action.thread_id);
        }
        found.thread.set("updatedAt", now);
        result = { ok: true, value: null };
        return;
      }
      case "delete_thread": {
        if (!threads.get(action.thread_id)) {
          result = { ok: false, code: "not_found", message: "That thread is gone." };
          return;
        }
        if (!atLeast(role, "edit")) {
          result = { ok: false, code: "forbidden", message: "Only editors can delete a thread." };
          return;
        }
        threads.delete(action.thread_id);
        result = { ok: true, value: null };
        return;
      }
      case "resolve":
      case "unresolve": {
        const thread = threads.get(action.thread_id);
        if (!thread) {
          result = { ok: false, code: "not_found", message: "That thread is gone." };
          return;
        }
        thread.set("resolved", action.op === "resolve");
        thread.set("resolvedUpdatedAt", now);
        if (action.op === "resolve") thread.set("resolvedBy", actor);
        result = { ok: true, value: null };
        return;
      }
      case "react":
      case "unreact": {
        const found = findComment(threads, action.thread_id, action.comment_id);
        if (!found) {
          result = { ok: false, code: "not_found", message: "That comment is gone." };
          return;
        }
        const emoji = String(action.emoji ?? "").slice(0, 64);
        if (!emoji) {
          result = { ok: false, code: "invalid", message: "Choose an emoji." };
          return;
        }
        const reactions = found.comment.get("reactionsByUser") as Y.Map<Y.Map<unknown>>;
        const key = `${actor}-${emoji}`;
        if (action.op === "react" && !reactions.has(key)) {
          const r = new Y.Map<unknown>();
          r.set("emoji", emoji);
          r.set("createdAt", now);
          r.set("userId", actor);
          reactions.set(key, r);
        }
        if (action.op === "unreact") reactions.delete(key);
        result = { ok: true, value: null };
        return;
      }
      default:
        return;
    }
  });
  return result;
}

function findComment(threads: Y.Map<Y.Map<unknown>>, threadId: string, commentId: string) {
  const thread = threads.get(threadId);
  if (!thread) return null;
  const comments = thread.get("comments") as Y.Array<Y.Map<unknown>> | undefined;
  if (!comments) return null;
  const index = indexOf(comments, commentId);
  if (index < 0) return null;
  return { thread, comment: comments.get(index), index };
}

function commentSnapshot(c: Y.Map<unknown>) {
  return {
    type: "comment",
    id: c.get("id"),
    userId: c.get("userId"),
    createdAt: c.get("createdAt"),
    updatedAt: c.get("updatedAt"),
    body: c.get("body"),
    reactions: [],
    metadata: c.get("metadata"),
  };
}

function snapshot(t: Y.Map<unknown>) {
  return {
    type: "thread",
    id: t.get("id"),
    createdAt: t.get("createdAt"),
    updatedAt: t.get("updatedAt"),
    comments: ((t.get("comments") as Y.Array<Y.Map<unknown>>)?.toArray() ?? []).map(commentSnapshot),
    resolved: t.get("resolved"),
    metadata: t.get("metadata"),
  };
}

/** Sets a thread's quote (the text it is on), once anchored. */
export function setQuote(doc: Y.Doc, threadId: string, quote: string): void {
  const thread = doc.getMap<Y.Map<unknown>>("threads").get(threadId);
  if (!thread) return;
  doc.transact(() => thread.set("metadata", { ...((thread.get("metadata") as object | null) ?? {}), quote: quote.slice(0, 500) }));
}

/** Threads as agents and lists read them; authors as member keys, resolved later. */
export function listThreads(doc: Y.Doc): (Omit<DocThread, "comments"> & { comments: { id: string; author: string; text: string; created_at: string }[] })[] {
  const out: (Omit<DocThread, "comments"> & { comments: { id: string; author: string; text: string; created_at: string }[] })[] = [];
  doc.getMap<Y.Map<unknown>>("threads").forEach((t, id) => {
    if (!(t instanceof Y.Map) || t.get("deletedAt")) return;
    const meta = (t.get("metadata") as { quote?: string; page_level?: boolean } | null) ?? {};
    out.push({
      id,
      quote: meta.page_level ? null : (meta.quote ?? null),
      resolved: !!t.get("resolved"),
      comments: ((t.get("comments") as Y.Array<Y.Map<unknown>>)?.toArray() ?? [])
        .filter((c) => !c.get("deletedAt"))
        .map((c) => ({
          id: String(c.get("id")),
          author: String(c.get("userId")),
          text: bodyText(c.get("body")),
          created_at: new Date(Number(c.get("createdAt")) || 0).toISOString(),
        })),
    });
  });
  return out.sort((a, b) => (a.comments[0]?.created_at ?? "").localeCompare(b.comments[0]?.created_at ?? ""));
}
