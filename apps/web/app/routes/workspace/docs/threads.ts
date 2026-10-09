import { data } from "react-router";

import type { DocThreadAction } from "@g1t/contracts";

import type { Route } from "./+types/threads";
import { docs } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";

/**
 * The editor's comment store (BlockNote's `RESTYjsThreadStore`) writes
 * here; it reads threads straight from the page's live document, where
 * the page's room puts what these requests change:
 *
 *   POST   ""                                   start a thread
 *   POST   /<thread>/addToDocument              anchor it to the selected text
 *   POST   /<thread>/comments                   reply
 *   PUT    /<thread>/comments/<comment>         edit a comment
 *   DELETE /<thread>/comments/<comment>?soft=   delete a comment
 *   DELETE /<thread>                            delete a thread
 *   POST   /<thread>/resolve | /unresolve
 *   POST   /<thread>/comments/<comment>/reactions            { emoji }
 *   DELETE /<thread>/comments/<comment>/reactions/<emoji>
 *
 * A comment on the whole page is a thread started with `page_level: true`.
 */
export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const url = new URL(request.url);
  const parts = (params["*"] ?? "").split("/").filter(Boolean).map(decodeURIComponent);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const method = request.method.toUpperCase();
  const [thread, what, comment, sub, emoji] = parts;
  let action: DocThreadAction | null = null;
  if (!thread && method === "POST") {
    const initial = (body.initialComment ?? {}) as { body?: unknown; metadata?: unknown };
    action = { op: "create", body: initial.body ?? body.body, metadata: body.metadata ?? initial.metadata, page_level: body.page_level === true };
  } else if (thread && !what && method === "DELETE") action = { op: "delete_thread", thread_id: thread };
  else if (thread && what === "addToDocument" && method === "POST") {
    const selection = (body.selection ?? {}) as { yjs?: { anchor?: unknown; head?: unknown } };
    if (!selection.yjs) return Response.json({ ok: false, error: { code: "invalid", message: "Select some text to comment on." } }, { status: 422 });
    action = { op: "anchor", thread_id: thread, anchor: selection.yjs.anchor, head: selection.yjs.head };
  } else if (thread && (what === "resolve" || what === "unresolve") && method === "POST") action = { op: what, thread_id: thread };
  else if (thread && what === "comments" && !comment && method === "POST") {
    const c = (body.comment ?? {}) as { body?: unknown; metadata?: unknown };
    action = { op: "comment", thread_id: thread, body: c.body, metadata: c.metadata };
  } else if (thread && what === "comments" && comment && !sub && method === "PUT") {
    const c = (body.comment ?? {}) as { body?: unknown; metadata?: unknown };
    action = { op: "edit_comment", thread_id: thread, comment_id: comment, body: c.body, metadata: c.metadata };
  } else if (thread && what === "comments" && comment && !sub && method === "DELETE") {
    action = { op: "delete_comment", thread_id: thread, comment_id: comment, soft: url.searchParams.get("soft") === "true" };
  } else if (thread && what === "comments" && comment && sub === "reactions" && method === "POST") {
    action = { op: "react", thread_id: thread, comment_id: comment, emoji: String(body.emoji ?? "") };
  } else if (thread && what === "comments" && comment && sub === "reactions" && emoji && method === "DELETE") {
    action = { op: "unreact", thread_id: thread, comment_id: comment, emoji };
  }
  if (!action) return Response.json({ ok: false, error: { code: "invalid", message: "Unknown comment request." } }, { status: 404 });
  try {
    const result = await docs.thread(slug, params.page, viewer, action);
    // The thread store reads the answer's body as the thread or comment.
    if (!result.ok) return Response.json(result, { status: result.error.code === "forbidden" ? 403 : result.error.code === "not_found" ? 404 : 422 });
    return Response.json(result.value ?? {}, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("docs threads:", error);
    return Response.json({ ok: false, error: { code: "conflict", message: "Docs didn't answer." } }, { status: 503 });
  }
}
