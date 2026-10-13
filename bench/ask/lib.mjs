// What the Ask bench shares: where the repository is, the credentials it
// reads (never printed, logged or written: every string that leaves this
// process goes through `redact`), g1t's REST API, its MCP server, the site
// as the signed-in user, and one Ask answer read as it streams.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));

/** The checkout the bench runs from: a worktree's own folder. */
export const ROOT = resolve(HERE, "..", "..");

/**
 * The main checkout, where `.credentials/` and `.secrets/` live: a worktree
 * has neither, so they are read from the checkout its git directory belongs to.
 */
export function mainCheckout() {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: ROOT, encoding: "utf8" }).trim();
    const dir = isAbsolute(common) ? common : resolve(ROOT, common);
    return dirname(dir);
  } catch {
    return ROOT;
  }
}

export const SITE = (process.env.G1T_SITE ?? "https://g1t.sh").replace(/\/$/, "");
export const API = (process.env.G1T_API ?? "https://api.g1t.sh").replace(/\/$/, "");
export const MCP = (process.env.G1T_MCP ?? "https://mcp.g1t.sh").replace(/\/$/, "");
const UA = "g1t-ask-bench/1";

// --- credentials ----------------------------------------------------------

const SECRETS = new Set();

function remember(value) {
  if (value && value.length >= 8) SECRETS.add(value);
  return value;
}

function readSecretFile(path) {
  if (!existsSync(path)) return null;
  // Either the bare value or a `token: value` line.
  const text = readFileSync(path, "utf8").trim();
  const value = text.replace(/^\s*token:\s*/i, "").split(/\r?\n/)[0].trim();
  return remember(value) || null;
}

let apiToken;
/** The API token: G1T_TOKEN, or the export in ~/.bashrc. */
export function apiTokenValue() {
  if (apiToken !== undefined) return apiToken;
  let value = process.env.G1T_TOKEN;
  if (!value) {
    const rc = join(homedir(), ".bashrc");
    if (existsSync(rc)) value = readFileSync(rc, "utf8").match(/G1T_TOKEN=["']?([^"'\s]+)/)?.[1];
  }
  apiToken = remember(value) || null;
  return apiToken;
}

let webToken;
/** The site's token, for g1t.sh routes as the user: .credentials/g1t_token.txt (or G1T_WEB_TOKEN_FILE). */
export function webTokenValue() {
  if (webToken !== undefined) return webToken;
  const file = process.env.G1T_WEB_TOKEN_FILE ?? join(mainCheckout(), ".credentials", "g1t_token.txt");
  webToken = readSecretFile(file) ?? apiTokenValue();
  return webToken;
}

let anthropicKey;
/** The judge's key: .secrets/anthropic-key.txt (or ANTHROPIC_KEY_FILE). */
export function anthropicKeyValue() {
  if (anthropicKey !== undefined) return anthropicKey;
  const file = process.env.ANTHROPIC_KEY_FILE ?? join(mainCheckout(), ".secrets", "anthropic-key.txt");
  anthropicKey = readSecretFile(file);
  return anthropicKey;
}

/** Loads every credential, so `redact` knows them all before anything is written. */
export function loadCredentials() {
  return { api: Boolean(apiTokenValue()), web: Boolean(webTokenValue()), anthropic: Boolean(anthropicKeyValue()) };
}

/** Every credential this process read, for the no-secrets check. */
export function knownSecrets() {
  return [...SECRETS];
}

/** Takes every credential this process read, and anything shaped like one, out of text. */
export function redact(text) {
  let out = String(text ?? "");
  for (const secret of SECRETS) out = out.split(secret).join("[REDACTED]");
  return out
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-[REDACTED]")
    .replace(/\bg1t_[A-Za-z0-9_-]{16,}/g, "g1t_[REDACTED]");
}

// --- g1t ------------------------------------------------------------------

async function request(url, token, init = {}) {
  const headers = { "user-agent": UA, accept: "application/json", ...(init.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...init, headers, redirect: init.redirect ?? "manual" });
  return response;
}

/** GET (or more) on api.g1t.sh as the user: `{ status, data }`, data null when not JSON. */
export async function api(path, init = {}) {
  const response = await request(`${API}${path}`, apiTokenValue(), init);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: response.status, data, text };
}

/** A g1t.sh route as the signed-in user (the site's token). */
export async function site(path, init = {}) {
  const url = path.startsWith("http") ? path : `${SITE}${path}`;
  return request(url, webTokenValue(), init);
}

let mcpId = 0;
/** One MCP tool call on mcp.g1t.sh as the user; the tool's text parsed as JSON when it is. */
export async function mcp(tool, args) {
  const response = await request(MCP, apiTokenValue(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpId, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await response.text();
  // A streamable HTTP server may answer as one SSE event.
  const json = text.trimStart().startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "null");
  const message = JSON.parse(json);
  if (message?.error) throw new Error(`mcp ${tool}: ${message.error.message}`);
  const body = message?.result?.content?.map((c) => c.text ?? "").join("") ?? "";
  if (message?.result?.isError) throw new Error(`mcp ${tool}: ${body.slice(0, 300)}`);
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** Every page of a list endpoint that takes per_page and page, up to `max` items. */
export async function apiAll(path, max = 300) {
  const items = [];
  for (let page = 1; items.length < max; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const { status, data } = await api(`${path}${sep}per_page=100&page=${page}`);
    if (status !== 200) break;
    const list = Array.isArray(data) ? data : (data?.items ?? data?.workflow_runs ?? data?.deployments ?? []);
    items.push(...list);
    if (list.length < 100) break;
  }
  return items.slice(0, max);
}

// --- Ask ------------------------------------------------------------------

/** Event types the bench knows. Anything else is recorded as unknown, never dropped. */
const KNOWN = new Set(["meta", "text", "done", "error", "tool", "sources", "proposal"]);

/** Looks like a tool step: `tool`, `tool_call`, `tool_result`, `step`, … */
export const isToolEvent = (event) => /tool|step|action|call/i.test(String(event?.type ?? ""));
/** Looks like a source or citation. */
export const isSourceEvent = (event) => /source|citation|reference|link/i.test(String(event?.type ?? ""));

/** URLs an event names, wherever it keeps them. */
function urlsIn(value, found = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) found.add(match[0]);
    if (/^\/[a-z0-9]/i.test(value) && !value.includes(" ")) found.add(`${SITE}${value}`);
  } else if (Array.isArray(value)) value.forEach((v) => urlsIn(v, found));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => urlsIn(v, found));
  return found;
}

/** What every question the bench posts starts with. */
export const TEST_PREFIX = "[TEST] ";

/** A chat API call on the site as the user: the `{ ok, value | error }` it answers. */
async function chatApi(workspace, body) {
  const response = await site(`/${workspace}/-/chat/api`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SITE },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { message: `chat api ${response.status}: ${text.slice(0, 200)}` } };
  }
}

async function chatMessages(workspace, channel) {
  const response = await site(`/${workspace}/-/chat/api?channel=${encodeURIComponent(channel)}&limit=60`);
  const data = await response.json().catch(() => null);
  return data?.value?.messages ?? [];
}

/**
 * Asks once, as the user, the way Ask and Chat both do: in the user's
 * direct message with @g1t, after a New conversation mark, posting each of
 * the conversation's questions in turn and following g1t's answer to each
 * as it streams (polled). The last answer is the one graded: its text, the
 * time to its first words and to its end, and the steps and sources it kept,
 * as events in the order the stream gave them.
 */
export async function ask(workspace, { messages, page }, { timeoutMs = 180_000 } = {}) {
  const started = performance.now();
  const at = () => Math.round(performance.now() - started);
  const result = {
    status: null,
    events: [],
    unknown_types: [],
    text: "",
    first_event_ms: null,
    first_text_ms: null,
    total_ms: null,
    meta: null,
    done: null,
    error: null,
    tool_events: [],
    source_events: [],
    source_urls: [],
  };
  try {
    const dm = await chatApi(workspace, { intent: "g1t_dm" });
    if (!dm.ok) throw new Error(dm.error?.message ?? "could not open the direct message with g1t");
    const channel = dm.value.channel.id;
    await chatApi(workspace, { intent: "g1t_reset", channel_id: channel });
    const questions = messages.filter((m) => m.role === "user");
    let answer = null;
    for (const [index, question] of questions.entries()) {
      const last = index === questions.length - 1;
      const asked = performance.now();
      // Marked, so the person whose direct message it is can tell the bench's questions from their own.
      const posted = await chatApi(workspace, { intent: "post", channel_id: channel, body: `${TEST_PREFIX}${question.content}`, page: last ? (page ?? null) : null });
      result.status = posted.ok ? 200 : 400;
      if (!posted.ok) throw new Error(posted.error?.message ?? "could not post");
      const mine = posted.value.id;
      answer = null;
      while (performance.now() - asked < timeoutMs) {
        await sleep(700);
        const list = await chatMessages(workspace, channel);
        answer = list.find((m) => m.id > mine && m.author?.kind === "system" && m.answer) ?? null;
        if (last && answer?.body && result.first_text_ms === null) result.first_text_ms = at();
        if (last && answer && result.first_event_ms === null) result.first_event_ms = at();
        if (answer && ["done", "error", "stopped"].includes(answer.answer.state)) break;
      }
      if (!answer || !["done", "error", "stopped"].includes(answer.answer?.state)) throw new Error(`timed out after ${timeoutMs} ms`);
    }
    const kept = answer.answer;
    result.meta = { type: "meta", provider_label: kept.provider_label, model: kept.model };
    result.events.push({ ms: 0, event: result.meta });
    for (const step of kept.steps ?? []) {
      const type = String(step?.type ?? "");
      result.events.push({ ms: null, event: step });
      if (!KNOWN.has(type) && !result.unknown_types.includes(type)) result.unknown_types.push(type);
      if (isToolEvent(step)) result.tool_events.push({ ms: null, event: step });
      if (isSourceEvent(step)) result.source_events.push({ ms: null, event: step });
    }
    result.text = answer.body ?? "";
    result.events.push({ ms: at(), event: { type: "text", text: result.text } });
    if (kept.state === "done") result.done = { type: "done", stop_reason: kept.stop_reason ?? null };
    else result.error = kept.error ?? kept.state;
  } catch (error) {
    result.error = String(error?.message ?? error);
  } finally {
    result.total_ms = at();
  }
  const urls = new Set();
  for (const { event } of result.source_events) urlsIn(event, urls);
  result.source_urls = [...urls];
  return result;
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** `--flag value` and `--flag` into an object; the first bare word is the command. */
export function parseArgs(argv) {
  const flags = {};
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) flags[name] = inline;
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) flags[name] = true;
    else flags[name] = argv[++i];
  }
  return { command: words[0], words, flags };
}
