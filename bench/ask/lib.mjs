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
const KNOWN = new Set(["meta", "text", "done", "error"]);

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

/**
 * Asks once, as the user, and reads the whole answer: every event with the
 * time it came, the time to the first text, the total, the tool steps and
 * sources it reported, and the text.
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await site(`/${workspace}/-/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ messages, page: page ?? {} }),
      signal: controller.signal,
    });
    result.status = response.status;
    if (!response.body) throw new Error(`no body (${response.status})`);
    const decoder = new TextDecoder();
    let pending = "";
    const take = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        event = { type: "_unparsed", line: line.slice(0, 500) };
      }
      const ms = at();
      result.first_event_ms ??= ms;
      result.events.push({ ms, event });
      const type = String(event?.type ?? "");
      if (!KNOWN.has(type) && !result.unknown_types.includes(type)) result.unknown_types.push(type);
      if (type === "meta") result.meta = event;
      if (type === "text" && typeof event.text === "string") {
        result.first_text_ms ??= ms;
        result.text += event.text;
      }
      if (type === "done") result.done = event;
      if (type === "error") result.error = event.message ?? "error";
      if (!KNOWN.has(type) && isToolEvent(event)) result.tool_events.push({ ms, event });
      if (!KNOWN.has(type) && isSourceEvent(event)) result.source_events.push({ ms, event });
    };
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(take);
    }
    take(pending);
  } catch (error) {
    result.error = controller.signal.aborted ? `timed out after ${timeoutMs} ms` : String(error?.message ?? error);
  } finally {
    clearTimeout(timer);
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
