/**
 * Ask g1t (components/ask-composer): `GET -/ask` says what Ask answers with
 * in the workspace, or why it cannot yet; `POST -/ask` with
 * `{ messages, page }` streams one answer back as newline-delimited JSON
 * (`AskEvent`s), from the integrations service, which calls the AI provider
 * an owner chose with the workspace's own key. The key never reaches the
 * browser.
 */
import { env } from "cloudflare:workers";
import { data } from "react-router";

import {
  ASK_MAX_MESSAGES,
  ASK_MAX_TOTAL_CHARS,
  type AskEvent,
  type AskMessage,
  type AskPage,
  checkLimit,
  integrationsClient,
} from "@g1t/contracts";

import type { Route } from "./+types/ask";
import { integrations } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

/** The most a request may carry: the conversation's cap, with room for JSON. */
const MAX_BODY_BYTES = ASK_MAX_TOTAL_CHARS * 4 + 16_384;

const NDJSON = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" };

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const setup = await integrations.askSettings(params.owner.toLowerCase(), viewer);
  return Response.json({ ...setup, owner: role === "owner" }, { headers: { "cache-control": "no-store" } });
}

/** An answer that never started: one `error` line, with the status that says why. */
function refuse(message: string, status: number, headers: Record<string, string> = {}): Response {
  const event: AskEvent = { type: "error", message };
  return new Response(`${JSON.stringify(event)}\n`, { status, headers: { ...NDJSON, ...headers } });
}

function isMessage(value: unknown): value is AskMessage {
  if (!value || typeof value !== "object") return false;
  const { role, content } = value as AskMessage;
  return (role === "user" || role === "assistant") && typeof content === "string";
}

/** The page as sent, with only what Ask reads, of the shapes it reads. */
function pageFrom(value: unknown): AskPage {
  if (!value || typeof value !== "object") return {};
  const sent = value as Record<string, unknown>;
  const number = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null);
  const repo = sent.repo as { namespace?: unknown; name?: unknown } | null | undefined;
  return {
    path: typeof sent.path === "string" ? sent.path.slice(0, 500) : null,
    repo:
      repo && typeof repo.namespace === "string" && typeof repo.name === "string" && repo.namespace && repo.name
        ? { namespace: repo.namespace.slice(0, 100), name: repo.name.slice(0, 100) }
        : null,
    issue: number(sent.issue),
    pull: number(sent.pull),
  };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  if (request.method !== "POST") throw data(null, { status: 405 });
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  // Each question spends the workspace's own provider and key: a few a
  // minute per person is plenty for a conversation.
  if ((await checkLimit(env.WEB_ASK_LIMIT, `ask:${viewer.id}`)) === "limited") {
    return refuse("You have asked a lot in the last minute. Wait a moment, then ask again.", 429, { "retry-after": "60" });
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return refuse("The conversation is too long. Start a new one.", 413);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return refuse("The conversation is too long. Start a new one.", 413);
  let sent: { messages?: unknown; page?: unknown };
  try {
    sent = JSON.parse(text) as typeof sent;
  } catch {
    return refuse("The question did not arrive whole. Ask again.", 400);
  }
  const messages = Array.isArray(sent.messages) ? sent.messages.filter(isMessage).slice(-ASK_MAX_MESSAGES) : [];
  if (messages.length === 0) return refuse("Write a question to ask.", 400);
  // The binding itself: the timed one (lib/perf.server.ts) reads the whole
  // answer before handing it on, and this one streams. The person closing
  // the tab or pressing Stop ends the provider's answer too.
  const answer = await integrationsClient(env.INTEGRATIONS)
    .ask(viewer, slug, messages, pageFrom(sent.page), request.signal)
    .catch(() => null);
  if (!answer) return refuse("Ask could not reach g1t's integrations. Try again in a moment.", 502);
  if (!answer.ok || !answer.body) return refuse("Ask could not reach g1t's integrations. Try again in a moment.", 502);
  return new Response(answer.body, { headers: NDJSON });
}
