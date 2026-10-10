/**
 * A small client for MCP servers over Streamable HTTP
 * (docs.g1t.sh/guides/agent-abilities/, "MCP servers"): lists a server's
 * tools when an owner adds it, and calls one when an agent's ability
 * allows. JSON-RPC, one request per call, a fresh session each time; an
 * answer may come back as JSON or as a server-sent event stream. No
 * sign-in: servers that need a key aren't supported yet, and the docs say
 * so. Pure apart from `fetch`, so it is tested with a fake.
 */
import type { McpTool } from "@g1t/contracts";

import { MAX_MCP_TOOLS } from "../../../packages/contracts/src/abilities.ts";

const PROTOCOL = "2025-06-18";
/** How long one request to a server may take. */
const TIMEOUT_MS = 15_000;
/** The most of a tool's answer an agent is given. */
const MAX_TEXT = 40_000;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

type Rpc = { id?: number | string | null; result?: unknown; error?: { code?: number; message?: string } };

/** One JSON-RPC exchange with the server; the body of the matching answer, or why there is none. */
async function exchange(fetchFn: Fetch, url: string, session: string | null, body: Record<string, unknown>, expectAnswer: boolean): Promise<{ ok: true; answer: Rpc | null; session: string | null } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL,
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    return { ok: false, message: `The server couldn't be reached (${String(error).slice(0, 120)}).` };
  }
  const next = response.headers.get("mcp-session-id") ?? session;
  if (!expectAnswer) return { ok: true, answer: null, session: next };
  if (!response.ok) return { ok: false, message: `The server answered ${response.status}.` };
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, message: "The server's answer couldn't be read." };
  }
  const wanted = body.id;
  const candidates: Rpc[] = [];
  if (type.includes("text/event-stream")) {
    for (const event of text.split(/\n\n+/)) {
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as Rpc | Rpc[];
        candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        // Not JSON: a keep-alive or a comment.
      }
    }
  } else {
    try {
      const parsed = JSON.parse(text) as Rpc | Rpc[];
      candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      return { ok: false, message: "The server didn't answer with JSON-RPC." };
    }
  }
  const answer = candidates.find((c) => c && typeof c === "object" && c.id === wanted) ?? null;
  if (!answer) return { ok: false, message: "The server didn't answer the request." };
  return { ok: true, answer, session: next };
}

/** Opens a session: initialize, then the initialized notification. The session id, if the server gave one. */
async function handshake(fetchFn: Fetch, url: string): Promise<{ ok: true; session: string | null } | { ok: false; message: string }> {
  const opened = await exchange(
    fetchFn,
    url,
    null,
    { id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "g1t-agents", version: "1" } } },
    true,
  );
  if (!opened.ok) return opened;
  if (opened.answer?.error) return { ok: false, message: `The server refused to start: ${opened.answer.error.message ?? "no reason given"}.` };
  const told = await exchange(fetchFn, url, opened.session, { method: "notifications/initialized" }, false);
  return { ok: true, session: told.ok ? told.session : opened.session };
}

/** A tool as the server lists it, as kept: its kind from `readOnlyHint`, a write when the server doesn't say. */
function toolOf(raw: unknown): McpTool | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } };
  if (typeof t.name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(t.name)) return null;
  const schema = t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema) ? (t.inputSchema as Record<string, unknown>) : { type: "object", properties: {} };
  return {
    name: t.name,
    description: typeof t.description === "string" ? t.description.trim().slice(0, 500) : "",
    kind: t.annotations?.readOnlyHint === true ? "read" : "write",
    input_schema: JSON.stringify(schema).length > 20_000 ? { type: "object", properties: {} } : schema,
  };
}

/** The server's tools, at most `MAX_MCP_TOOLS`, or why they couldn't be listed. */
export async function listMcpTools(url: string, fetchFn: Fetch = (u, init) => fetch(u, init)): Promise<{ ok: true; tools: McpTool[] } | { ok: false; message: string }> {
  const opened = await handshake(fetchFn, url);
  if (!opened.ok) return opened;
  const listed = await exchange(fetchFn, url, opened.session, { id: 2, method: "tools/list", params: {} }, true);
  if (!listed.ok) return listed;
  if (listed.answer?.error) return { ok: false, message: `The server couldn't list its tools: ${listed.answer.error.message ?? "no reason given"}.` };
  const raw = (listed.answer?.result as { tools?: unknown } | undefined)?.tools;
  if (!Array.isArray(raw)) return { ok: false, message: "The server listed no tools." };
  const tools = raw.map(toolOf).filter((tool): tool is McpTool => tool !== null);
  const names = new Set<string>();
  return { ok: true, tools: tools.filter((tool) => (names.has(tool.name) ? false : (names.add(tool.name), true))).slice(0, MAX_MCP_TOOLS) };
}

/** Calls one tool; the text it returned (its text parts joined), or why it didn't work. */
export async function callMcpTool(url: string, name: string, args: Record<string, unknown>, fetchFn: Fetch = (u, init) => fetch(u, init)): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const opened = await handshake(fetchFn, url);
  if (!opened.ok) return opened;
  const called = await exchange(fetchFn, url, opened.session, { id: 3, method: "tools/call", params: { name, arguments: args } }, true);
  if (!called.ok) return called;
  if (called.answer?.error) return { ok: false, message: called.answer.error.message ?? "the server refused" };
  const result = called.answer?.result as { content?: unknown; isError?: unknown; structuredContent?: unknown } | undefined;
  const parts = Array.isArray(result?.content) ? (result!.content as { type?: string; text?: string }[]) : [];
  let text = parts
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : part?.type ? `[${part.type} content]` : ""))
    .filter(Boolean)
    .join("\n");
  if (!text && result?.structuredContent !== undefined) text = JSON.stringify(result.structuredContent).slice(0, MAX_TEXT);
  if (result?.isError === true) return { ok: false, message: text.slice(0, 500) || "the tool reported an error" };
  return { ok: true, text: (text || "(no content)").slice(0, MAX_TEXT) };
}
