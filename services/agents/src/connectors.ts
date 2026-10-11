/**
 * Connectors (docs.g1t.sh/guides/customize/, "Connectors"): MCP servers a
 * workspace connects once, then gives to agents. One comes from the
 * directory (@g1t/contracts connectors.ts, the servers tools publish),
 * from a plugin's `.mcp.json`, or from an address an owner types. It
 * signs in the way the server asks:
 *
 * - `oauth`: the browser. g1t finds the server's authorization server
 *   (RFC 9728, then RFC 8414), registers itself as a client (RFC 7591)
 *   when the server allows it, and sends the person there with PKCE. The
 *   tokens come back here and are refreshed before they expire.
 * - `header`: a key an owner pastes, sent as a header's value.
 * - `none`: the server is open.
 *
 * Secrets (the key, the tokens, the client registration) are sealed with
 * AES-GCM under `CONNECTORS_KEY`, bound to the connector's id, and never
 * returned. Where a connector reaches (`connector_grants`) works like a
 * skill's attachments: every agent, a team's, or one. An agent's turn gets
 * the connectors that reach it in the same shape as its own MCP servers,
 * so levels, Ask-first cards and audit are unchanged (abilities.ts).
 *
 * Pure apart from the sealing key and `fetch`, so it is tested on SQLite
 * with fakes.
 */
import type { FailureCode, Result } from "@g1t/contracts";
import { MAX_MCP_TOOLS, type McpServer, type McpTool, checkMcpName, checkMcpUrl } from "../../../packages/contracts/src/abilities.ts";
import { CONNECTORS, type Connector } from "../../../packages/contracts/src/connectors.ts";
import { MAX_CONNECTORS, type AgentConnector, type ConnectorAuth, type ConnectorFrom, type ConnectorGrant, type ConnectorInput, type ConnectorState, type WorkspaceConnector } from "../../../packages/contracts/src/customize.ts";
import { newId } from "../../../packages/contracts/src/ids.ts";
import type { SkillScope } from "../../../packages/contracts/src/skill-library.ts";
import { type Fetch, listMcpTools } from "./mcp-client.ts";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: FailureCode, message: string): Result<never> => ({ ok: false, error: { code, message } });

export type ConnectorRow = {
  id: string;
  workspace_id: string;
  name: string;
  title: string;
  url: string;
  category: string | null;
  about: string | null;
  auth: string;
  header_name: string | null;
  secrets: string | null;
  signed_in_as: string | null;
  signed_in_at: string | null;
  pending: string | null;
  pending_at: string | null;
  from_json: string;
  tools: string;
  checked_at: string | null;
  problem: string | null;
  added_by: string;
  added_at: string;
  updated_at: string;
  removed_at: string | null;
};

export type GrantRow = { id: string; workspace_id: string; connector_id: string; scope: SkillScope; target: string; granted_by: string; granted_at: string };

/** What a connector keeps sealed. */
type Secrets = {
  header?: string;
  oauth?: {
    client_id: string;
    client_secret?: string;
    access_token: string;
    refresh_token?: string;
    /** Unix seconds. */
    expires_at?: number;
    token_endpoint: string;
    resource?: string;
    scope?: string;
  };
};

/** An OAuth sign-in under way. */
type Pending = {
  state: string;
  verifier: string;
  client_id: string;
  client_secret?: string;
  token_endpoint: string;
  redirect_uri: string;
  resource: string;
  scope?: string;
};

function json<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// ── Sealing ──────────────────────────────────────────────────────────────

/** The sealing key from `CONNECTORS_KEY` (64 hex characters), or null when none is set: then nothing secret can be kept. */
export async function sealingKey(hex: string | undefined): Promise<CryptoKey | null> {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) return null;
  const bytes = new Uint8Array(hex.trim().match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** `value` sealed for `id`: base64 of the nonce and the ciphertext. */
export async function seal(key: CryptoKey, id: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) }, key, data));
  const joined = new Uint8Array(iv.length + out.length);
  joined.set(iv);
  joined.set(out, iv.length);
  return b64(joined);
}

/** What was sealed for `id`, or null when it can't be opened (another key, another id, damaged). */
export async function open<T>(key: CryptoKey, id: string, sealed: string | null): Promise<T | null> {
  if (!sealed) return null;
  try {
    const bytes = unb64(sealed);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: new TextEncoder().encode(id) }, key, bytes.subarray(12));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
}

// ── Rows ─────────────────────────────────────────────────────────────────

export type Deps = {
  key: CryptoKey | null;
  fetchFn?: Fetch;
  /** The site's address, for the OAuth redirect and the client's name. */
  site: string;
  now?: Date;
};

const at = (deps: Deps) => (deps.now ?? new Date()).toISOString();

export async function listConnectors(db: D1Database, workspaceId: string): Promise<ConnectorRow[]> {
  const { results } = await db.prepare("SELECT * FROM connectors WHERE workspace_id = ? AND removed_at IS NULL ORDER BY title COLLATE NOCASE").bind(workspaceId).all<ConnectorRow>();
  return results;
}

export async function connectorById(db: D1Database, workspaceId: string, id: string): Promise<ConnectorRow | null> {
  return db.prepare("SELECT * FROM connectors WHERE workspace_id = ? AND id = ? AND removed_at IS NULL").bind(workspaceId, id).first<ConnectorRow>();
}

async function grantsOf(db: D1Database, connectorIds: string[]): Promise<GrantRow[]> {
  if (!connectorIds.length) return [];
  const { results } = await db.prepare("SELECT * FROM connector_grants WHERE connector_id IN (SELECT value FROM json_each(?)) ORDER BY CASE scope WHEN 'workspace' THEN 0 WHEN 'team' THEN 1 ELSE 2 END, granted_at").bind(JSON.stringify(connectorIds)).all<GrantRow>();
  return results;
}

/** Whether the connector can be used now. */
export function stateOf(row: ConnectorRow): ConnectorState {
  if (row.auth === "oauth" && !row.signed_in_at) return "needs_sign_in";
  if (row.auth === "header" && !row.secrets) return "needs_key";
  if (row.problem) return "problem";
  return "connected";
}

type Labels = { agents: Map<string, { handle: string; display_name: string }>; teams: Map<string, string> };

function grantOut(g: GrantRow, labels: Labels): ConnectorGrant {
  const agent = g.scope === "agent" ? labels.agents.get(g.target) : null;
  const target = g.scope === "agent" ? (agent?.handle ?? null) : g.scope === "team" ? g.target : null;
  const label = g.scope === "workspace" ? "Every agent" : g.scope === "agent" ? (agent ? `@${agent.handle}` : "An archived agent") : (labels.teams.get(g.target) ?? g.target);
  return { id: g.id, scope: g.scope, target, label, granted_by: g.granted_by, granted_at: g.granted_at };
}

export function connectorOut(row: ConnectorRow, grants: GrantRow[], labels: Labels): WorkspaceConnector {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    url: row.url,
    category: (row.category as WorkspaceConnector["category"]) ?? null,
    about: row.about,
    auth: row.auth as ConnectorAuth,
    state: stateOf(row),
    problem: row.problem,
    from: json<ConnectorFrom>(row.from_json, { kind: "address" }),
    tools: json<McpTool[]>(row.tools, []),
    checked_at: row.checked_at,
    header_name: row.header_name,
    signed_in_as: row.signed_in_as,
    signed_in_at: row.signed_in_at,
    grants: grants.map((g) => grantOut(g, labels)),
    added_by: row.added_by,
    added_at: row.added_at,
  };
}

/** Every connector as the page lists them. */
export async function connectorsOut(db: D1Database, workspaceId: string, labels: Labels): Promise<WorkspaceConnector[]> {
  const rows = await listConnectors(db, workspaceId);
  const grants = await grantsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => connectorOut(row, grants.filter((g) => g.connector_id === row.id), labels));
}

// ── Headers and tools ────────────────────────────────────────────────────

/** The headers that sign a call in, refreshing an OAuth token first when it is about to expire. Null when the connector can't be used. */
export async function headersFor(db: D1Database, deps: Deps, row: ConnectorRow): Promise<Record<string, string> | null> {
  if (row.auth === "none") return {};
  if (!deps.key) return null;
  const secrets = await open<Secrets>(deps.key, row.id, row.secrets);
  if (!secrets) return null;
  if (row.auth === "header") return secrets.header && row.header_name ? { [row.header_name]: secrets.header } : null;
  const oauth = secrets.oauth;
  if (!oauth) return null;
  const now = Math.floor((deps.now ?? new Date()).getTime() / 1000);
  if (oauth.expires_at && oauth.expires_at - 60 < now) {
    if (!oauth.refresh_token) return null;
    const refreshed = await tokenRequest(deps.fetchFn ?? ((u, i) => fetch(u, i)), oauth.token_endpoint, {
      grant_type: "refresh_token",
      refresh_token: oauth.refresh_token,
      client_id: oauth.client_id,
      ...(oauth.client_secret ? { client_secret: oauth.client_secret } : {}),
      ...(oauth.resource ? { resource: oauth.resource } : {}),
    });
    if (!refreshed.ok) {
      await db.prepare("UPDATE connectors SET problem = ?, updated_at = ? WHERE id = ?").bind(`Its sign-in couldn't be renewed: ${refreshed.message} Sign in again.`, at(deps), row.id).run();
      return null;
    }
    const fresh: Secrets = { ...secrets, oauth: { ...oauth, access_token: refreshed.access_token, refresh_token: refreshed.refresh_token ?? oauth.refresh_token, expires_at: refreshed.expires_in ? now + refreshed.expires_in : undefined } };
    await db.prepare("UPDATE connectors SET secrets = ?, updated_at = ? WHERE id = ?").bind(await seal(deps.key, row.id, fresh), at(deps), row.id).run();
    return { Authorization: `Bearer ${fresh.oauth!.access_token}` };
  }
  return { Authorization: `Bearer ${oauth.access_token}` };
}

/** Lists the server's tools with its headers and keeps them; the problem, if any, is kept too. */
export async function refreshTools(db: D1Database, deps: Deps, row: ConnectorRow): Promise<ConnectorRow> {
  const headers = await headersFor(db, deps, row);
  const when = at(deps);
  if (headers === null) {
    const problem = row.auth === "oauth" ? (row.signed_in_at ? "Its sign-in can't be used. Sign in again." : null) : row.auth === "header" ? null : "Its secrets can't be opened (is CONNECTORS_KEY set?).";
    await db.prepare("UPDATE connectors SET problem = ?, checked_at = ?, updated_at = ? WHERE id = ?").bind(problem, when, when, row.id).run();
    return { ...row, problem, checked_at: when, updated_at: when };
  }
  const listed = await listMcpTools(row.url, deps.fetchFn, headers);
  const tools = listed.ok ? JSON.stringify(listed.tools) : row.tools;
  const problem = listed.ok ? null : listed.message;
  await db.prepare("UPDATE connectors SET tools = ?, checked_at = ?, problem = ?, updated_at = ? WHERE id = ?").bind(tools, when, problem, when, row.id).run();
  return { ...row, tools, checked_at: when, problem, updated_at: when };
}

// ── Adding and removing ──────────────────────────────────────────────────

/** A name for a connector from a title: lowercase, hyphens, 2 to 32. */
function nameFrom(text: string): string {
  const name = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return name.length >= 2 ? name : `${name}x`.slice(0, 2);
}

/** Adds a connector; a plugin's or an address's needs an owner to sign in or paste a key next, unless the server is open. */
export async function addConnector(
  db: D1Database,
  deps: Deps,
  workspaceId: string,
  input: ConnectorInput,
  by: string,
  pluginServer?: { title: string; url: string } | null,
): Promise<Result<ConnectorRow>> {
  const count = await db.prepare("SELECT COUNT(*) AS n FROM connectors WHERE workspace_id = ? AND removed_at IS NULL").bind(workspaceId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_CONNECTORS) return fail("limit", `A workspace keeps at most ${MAX_CONNECTORS} connectors.`);
  let title: string;
  let url: string;
  let name: string;
  let category: string | null = null;
  let about: string | null = null;
  let auth: ConnectorAuth = input.auth;
  let headerName: string | null = input.header?.name?.trim() || null;
  const from = input.from;
  if (from.kind === "directory") {
    const entry: Connector | undefined = CONNECTORS.find((c) => c.id === from.id && c.mcp);
    if (!entry?.mcp) return fail("not_found", "There is no such connector in the directory.");
    title = entry.name;
    url = entry.mcp.url;
    name = nameFrom(entry.id.replace(/-mcp$/, ""));
    category = entry.category;
    about = entry.description;
    auth = entry.mcp.auth;
    if (auth === "header") headerName = headerName ?? entry.mcp.header ?? "Authorization";
  } else if (from.kind === "plugin") {
    if (!pluginServer) return fail("not_found", "That plugin names no such server.");
    title = pluginServer.title;
    url = pluginServer.url;
    name = nameFrom(from.server);
    about = `From the ${from.ref} plugin.`;
  } else {
    const checkedName = checkMcpName(from.name);
    if (!checkedName.ok) return fail("invalid", checkedName.message);
    title = from.name.trim();
    url = from.url;
    name = checkedName.value;
  }
  const checkedUrl = checkMcpUrl(url);
  if (!checkedUrl.ok) return fail("invalid", checkedUrl.message);
  if (auth === "header" && !headerName) headerName = "Authorization";
  if (auth === "header" && input.header?.value && !deps.key) return fail("invalid", "Keys can't be kept here: CONNECTORS_KEY isn't set on the agents service.");
  const now = at(deps);
  const id = newId("con", (deps.now ?? new Date()).getTime());
  const secrets = auth === "header" && input.header?.value && deps.key ? await seal(deps.key, id, { header: input.header.value.trim() } satisfies Secrets) : null;
  const row: ConnectorRow = {
    id,
    workspace_id: workspaceId,
    name,
    title,
    url: checkedUrl.value,
    category,
    about,
    auth,
    header_name: auth === "header" ? headerName : null,
    secrets,
    signed_in_as: null,
    signed_in_at: null,
    pending: null,
    pending_at: null,
    from_json: JSON.stringify(from),
    tools: "[]",
    checked_at: null,
    problem: null,
    added_by: by,
    added_at: now,
    updated_at: now,
    removed_at: null,
  };
  // Two connectors with the same name: the second gets a number.
  for (let n = 2; n < 50; n++) {
    try {
      await db
        .prepare(
          `INSERT INTO connectors (id, workspace_id, name, title, url, category, about, auth, header_name, secrets, from_json, tools, added_by, added_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
        )
        .bind(row.id, row.workspace_id, row.name, row.title, row.url, row.category, row.about, row.auth, row.header_name, row.secrets, row.from_json, row.added_by, row.added_at, row.updated_at)
        .run();
      break;
    } catch (error) {
      if (!String(error).includes("UNIQUE")) throw error;
      row.name = `${name.slice(0, 29)}-${n}`;
      if (n === 49) return fail("conflict", `The workspace already has a connector called ${name}.`);
    }
  }
  // An open server, or one with its key: its tools can be listed now.
  if (auth === "none" || (auth === "header" && secrets)) return ok(await refreshTools(db, deps, row));
  return ok(row);
}

/** Puts a key on a header connector (or replaces it), then lists its tools. */
export async function setKey(db: D1Database, deps: Deps, row: ConnectorRow, headerName: string | null, value: string): Promise<Result<ConnectorRow>> {
  if (row.auth !== "header") return fail("invalid", "This connector doesn't take a key.");
  if (!deps.key) return fail("invalid", "Keys can't be kept here: CONNECTORS_KEY isn't set on the agents service.");
  const key = value.trim();
  if (!key || key.length > 4000) return fail("invalid", "Paste the key.");
  const header = headerName?.trim() || row.header_name || "Authorization";
  if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) return fail("invalid", "A header's name is letters, digits and hyphens.");
  const sealed = await seal(deps.key, row.id, { header: key } satisfies Secrets);
  const when = at(deps);
  await db.prepare("UPDATE connectors SET secrets = ?, header_name = ?, problem = NULL, updated_at = ? WHERE id = ?").bind(sealed, header, when, row.id).run();
  return ok(await refreshTools(db, deps, { ...row, secrets: sealed, header_name: header, problem: null }));
}

/** Removes a connector and its grants; the row is kept. */
export async function removeConnector(db: D1Database, deps: Deps, workspaceId: string, id: string): Promise<Result<null>> {
  const row = await connectorById(db, workspaceId, id);
  if (!row) return fail("not_found", "There is no such connector.");
  const when = at(deps);
  await db.batch([
    db.prepare("UPDATE connectors SET removed_at = ?, secrets = NULL, pending = NULL, updated_at = ? WHERE id = ?").bind(when, when, id),
    db.prepare("DELETE FROM connector_grants WHERE connector_id = ?").bind(id),
  ]);
  return ok(null);
}

/** Removes every connector a plugin brought. */
export async function removePluginConnectors(db: D1Database, deps: Deps, workspaceId: string, pluginRef: string): Promise<number> {
  const rows = await listConnectors(db, workspaceId);
  let n = 0;
  for (const row of rows) {
    const from = json<ConnectorFrom>(row.from_json, { kind: "address" });
    if (from.kind === "plugin" && from.ref === pluginRef) {
      await removeConnector(db, deps, workspaceId, row.id);
      n++;
    }
  }
  return n;
}

// ── OAuth ────────────────────────────────────────────────────────────────

type Metadata = { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string; scopes_supported?: string[]; code_challenge_methods_supported?: string[] };

async function getJson(fetchFn: Fetch, url: string): Promise<{ status: number; json: Record<string, unknown> | null; headers: Headers }> {
  try {
    const response = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const text = await response.text().catch(() => "");
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, json: parsed, headers: response.headers };
  } catch {
    return { status: 0, json: null, headers: new Headers() };
  }
}

/**
 * The authorization server for an MCP server: from the 401's
 * `WWW-Authenticate` resource metadata, from the protected-resource
 * document at the server's host, or the host itself; then its metadata.
 */
export async function discover(fetchFn: Fetch, url: string): Promise<{ ok: true; metadata: Metadata; issuer: string } | { ok: false; message: string }> {
  const server = new URL(url);
  const candidates: string[] = [];
  // 1. The server itself says where (RFC 9728).
  try {
    const probe = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }), signal: AbortSignal.timeout(15_000) });
    const challenge = probe.headers.get("www-authenticate") ?? "";
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    if (metadataUrl) candidates.push(metadataUrl);
  } catch {
    // The probe is a hint, not a requirement.
  }
  const path = server.pathname.replace(/\/$/, "");
  candidates.push(`${server.origin}/.well-known/oauth-protected-resource${path}`, `${server.origin}/.well-known/oauth-protected-resource`);
  let issuers: string[] = [];
  for (const candidate of candidates) {
    const read = await getJson(fetchFn, candidate);
    const servers = read.json?.authorization_servers;
    if (read.status === 200 && Array.isArray(servers) && servers.length) {
      issuers = servers.filter((s): s is string => typeof s === "string");
      break;
    }
  }
  if (!issuers.length) issuers = [server.origin];
  // 2. The authorization server's metadata (RFC 8414, then OpenID).
  for (const issuer of issuers) {
    const base = new URL(issuer);
    const issuerPath = base.pathname.replace(/\/$/, "");
    for (const candidate of [`${base.origin}/.well-known/oauth-authorization-server${issuerPath}`, `${base.origin}${issuerPath}/.well-known/oauth-authorization-server`, `${base.origin}/.well-known/openid-configuration${issuerPath}`, `${base.origin}${issuerPath}/.well-known/openid-configuration`]) {
      const read = await getJson(fetchFn, candidate);
      const m = read.json;
      if (read.status === 200 && m && typeof m.authorization_endpoint === "string" && typeof m.token_endpoint === "string") {
        return {
          ok: true,
          issuer,
          metadata: {
            authorization_endpoint: m.authorization_endpoint,
            token_endpoint: m.token_endpoint,
            ...(typeof m.registration_endpoint === "string" ? { registration_endpoint: m.registration_endpoint } : {}),
            ...(Array.isArray(m.scopes_supported) ? { scopes_supported: m.scopes_supported.filter((s): s is string => typeof s === "string") } : {}),
            ...(Array.isArray(m.code_challenge_methods_supported) ? { code_challenge_methods_supported: m.code_challenge_methods_supported.filter((s): s is string => typeof s === "string") } : {}),
          },
        };
      }
    }
  }
  return { ok: false, message: "The server doesn't say how to sign in (no OAuth metadata was found). If it takes a key instead, add it with a key." };
}

/** Registers g1t as a client (RFC 7591), when the server allows it. */
async function register(fetchFn: Fetch, endpoint: string, redirectUri: string, site: string): Promise<{ ok: true; client_id: string; client_secret?: string } | { ok: false; message: string }> {
  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_name: "g1t", client_uri: site, redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as { client_id?: string; client_secret?: string; error_description?: string; error?: string } | null;
    if (!response.ok || !body?.client_id) return { ok: false, message: `The server refused to register g1t as a client${body?.error_description ? ` (${body.error_description})` : body?.error ? ` (${body.error})` : ""}.` };
    return { ok: true, client_id: body.client_id, ...(body.client_secret ? { client_secret: body.client_secret } : {}) };
  } catch {
    return { ok: false, message: "The server's client registration couldn't be reached." };
  }
}

async function tokenRequest(fetchFn: Fetch, endpoint: string, form: Record<string, string>): Promise<{ ok: true; access_token: string; refresh_token?: string; expires_in?: number; scope?: string } | { ok: false; message: string }> {
  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string } | null;
    if (!response.ok || !body?.access_token) return { ok: false, message: `${body?.error_description ?? body?.error ?? `the server answered ${response.status}`}.` };
    return { ok: true, access_token: body.access_token, ...(body.refresh_token ? { refresh_token: body.refresh_token } : {}), ...(typeof body.expires_in === "number" ? { expires_in: body.expires_in } : {}), ...(body.scope ? { scope: body.scope } : {}) };
  } catch {
    return { ok: false, message: "the server couldn't be reached." };
  }
}

const random = (bytes: number): string =>
  b64(crypto.getRandomValues(new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return b64(digest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Where the browser goes to sign a connector in; the sign-in's state is kept sealed on the row until it completes. */
export async function startSignIn(db: D1Database, deps: Deps, row: ConnectorRow, redirectUri: string): Promise<Result<{ url: string }>> {
  if (row.auth !== "oauth") return fail("invalid", "This connector doesn't sign in with a browser.");
  if (!deps.key) return fail("invalid", "Sign-ins can't be kept here: CONNECTORS_KEY isn't set on the agents service.");
  const fetchFn = deps.fetchFn ?? ((u, i) => fetch(u, i));
  const found = await discover(fetchFn, row.url);
  if (!found.ok) return fail("invalid", found.message);
  if (found.metadata.code_challenge_methods_supported && !found.metadata.code_challenge_methods_supported.includes("S256")) return fail("invalid", "The server doesn't support PKCE (S256), which g1t requires.");
  if (!found.metadata.registration_endpoint) return fail("invalid", "The server doesn't register clients on its own, and g1t has no client registered with it. If it takes a key instead, add it with a key.");
  const client = await register(fetchFn, found.metadata.registration_endpoint, redirectUri, deps.site);
  if (!client.ok) return fail("invalid", client.message);
  const verifier = random(48);
  const state = `${row.id}.${random(24)}`;
  const scope = found.metadata.scopes_supported?.length ? found.metadata.scopes_supported.join(" ") : undefined;
  const pending: Pending = { state, verifier, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}), token_endpoint: found.metadata.token_endpoint, redirect_uri: redirectUri, resource: row.url, ...(scope ? { scope } : {}) };
  await db.prepare("UPDATE connectors SET pending = ?, pending_at = ?, updated_at = ? WHERE id = ?").bind(await seal(deps.key, row.id, pending), at(deps), at(deps), row.id).run();
  const url = new URL(found.metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", row.url);
  if (scope) url.searchParams.set("scope", scope);
  return ok({ url: url.toString() });
}

/** The connector a returning sign-in belongs to: the state's first part is its id. */
export function connectorOfState(state: string): string | null {
  const id = state.split(".")[0] ?? "";
  return /^con_[a-z0-9]+$/.test(id) ? id : null;
}

/** Completes a sign-in with the code the browser brought back, keeps the tokens, and lists the server's tools. */
export async function finishSignIn(db: D1Database, deps: Deps, row: ConnectorRow, state: string, code: string, by: string): Promise<Result<ConnectorRow>> {
  if (!deps.key) return fail("invalid", "CONNECTORS_KEY isn't set on the agents service.");
  const pending = await open<Pending>(deps.key, row.id, row.pending);
  if (!pending || pending.state !== state) return fail("invalid", "This sign-in isn't the one that was started. Start it again.");
  if (row.pending_at && (deps.now ?? new Date()).getTime() - Date.parse(row.pending_at) > 15 * 60 * 1000) return fail("invalid", "This sign-in took too long. Start it again.");
  const fetchFn = deps.fetchFn ?? ((u, i) => fetch(u, i));
  const token = await tokenRequest(fetchFn, pending.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirect_uri,
    client_id: pending.client_id,
    code_verifier: pending.verifier,
    resource: pending.resource,
    ...(pending.client_secret ? { client_secret: pending.client_secret } : {}),
  });
  if (!token.ok) return fail("invalid", `The server didn't give g1t a token: ${token.message}`);
  const now = Math.floor((deps.now ?? new Date()).getTime() / 1000);
  const secrets: Secrets = {
    oauth: {
      client_id: pending.client_id,
      ...(pending.client_secret ? { client_secret: pending.client_secret } : {}),
      access_token: token.access_token,
      ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
      ...(token.expires_in ? { expires_at: now + token.expires_in } : {}),
      token_endpoint: pending.token_endpoint,
      resource: pending.resource,
      ...(token.scope ?? pending.scope ? { scope: token.scope ?? pending.scope } : {}),
    },
  };
  const when = at(deps);
  const sealed = await seal(deps.key, row.id, secrets);
  await db.prepare("UPDATE connectors SET secrets = ?, pending = NULL, pending_at = NULL, signed_in_as = ?, signed_in_at = ?, problem = NULL, updated_at = ? WHERE id = ?").bind(sealed, by, when, when, row.id).run();
  return ok(await refreshTools(db, deps, { ...row, secrets: sealed, pending: null, pending_at: null, signed_in_as: by, signed_in_at: when, problem: null }));
}

/** Forgets a sign-in: the tokens go, and the connector needs a sign-in again. */
export async function signOut(db: D1Database, deps: Deps, row: ConnectorRow): Promise<Result<ConnectorRow>> {
  if (row.auth !== "oauth") return fail("invalid", "This connector doesn't sign in with a browser.");
  const when = at(deps);
  await db.prepare("UPDATE connectors SET secrets = NULL, pending = NULL, pending_at = NULL, signed_in_as = NULL, signed_in_at = NULL, problem = NULL, updated_at = ? WHERE id = ?").bind(when, row.id).run();
  return ok({ ...row, secrets: null, pending: null, pending_at: null, signed_in_as: null, signed_in_at: null, problem: null, updated_at: when });
}

// ── Grants ───────────────────────────────────────────────────────────────

/** Gives a connector to every agent, a team's, or one. The same grant twice is one. */
export async function grant(db: D1Database, deps: Deps, workspaceId: string, connectorId: string, scope: SkillScope, target: string, by: string): Promise<Result<GrantRow>> {
  if (!["workspace", "team", "agent"].includes(scope)) return fail("invalid", "Give it to every agent, a team, or one agent.");
  if (scope !== "workspace" && !target) return fail("invalid", "Say which team or agent.");
  const row: GrantRow = { id: newId("cgr", (deps.now ?? new Date()).getTime()), workspace_id: workspaceId, connector_id: connectorId, scope, target: scope === "workspace" ? "" : target, granted_by: by, granted_at: at(deps) };
  const inserted = await db
    .prepare("INSERT INTO connector_grants (id, workspace_id, connector_id, scope, target, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id")
    .bind(row.id, row.workspace_id, row.connector_id, row.scope, row.target, row.granted_by, row.granted_at)
    .first<{ id: string }>();
  if (!inserted) {
    const existing = await db.prepare("SELECT * FROM connector_grants WHERE connector_id = ? AND scope = ? AND target = ?").bind(connectorId, scope, row.target).first<GrantRow>();
    return existing ? ok(existing) : fail("conflict", "It is already given there.");
  }
  return ok(row);
}

export async function revoke(db: D1Database, workspaceId: string, grantId: string): Promise<Result<null>> {
  const done = await db.prepare("DELETE FROM connector_grants WHERE id = ? AND workspace_id = ?").bind(grantId, workspaceId).run();
  return done.meta.changes ? ok(null) : fail("not_found", "There is no such grant.");
}

/** The connectors that reach one agent, with how each reaches it (the closest grant wins), connected or not. */
export async function reaching(db: D1Database, workspaceId: string, agentId: string, teams: readonly string[]): Promise<{ row: ConnectorRow; via: SkillScope }[]> {
  const { results } = await db
    .prepare(
      `SELECT c.*, g.scope AS via FROM connector_grants g
       JOIN connectors c ON c.id = g.connector_id AND c.removed_at IS NULL
       WHERE g.workspace_id = ?1
         AND (g.scope = 'workspace' OR (g.scope = 'agent' AND g.target = ?2) OR (g.scope = 'team' AND g.target IN (SELECT value FROM json_each(?3))))
       ORDER BY c.title COLLATE NOCASE LIMIT 200`,
    )
    .bind(workspaceId, agentId, JSON.stringify(teams))
    .all<ConnectorRow & { via: SkillScope }>();
  const order: Record<SkillScope, number> = { agent: 0, team: 1, workspace: 2 };
  const best = new Map<string, { row: ConnectorRow; via: SkillScope }>();
  for (const found of results) {
    const { via, ...row } = found;
    const have = best.get(row.id);
    if (!have || order[via] < order[have.via]) best.set(row.id, { row, via });
  }
  return [...best.values()];
}

/** A connector as an agent's turn gets it: the same shape as its own MCP servers, with the connector's id. */
export function asServer(row: ConnectorRow): McpServer {
  return { id: row.id, name: row.name, url: row.url, tools: json<McpTool[]>(row.tools, []).slice(0, MAX_MCP_TOOLS), added_by: row.added_by, added_at: row.added_at, checked_at: row.checked_at, problem: row.problem };
}

/** What an agent's Abilities tab lists for connectors: those that reach it, and its own servers. */
export function agentConnectorsOut(reach: { row: ConnectorRow; via: SkillScope }[], own: McpServer[], labels: { teamName: (slug: string) => string }): AgentConnector[] {
  const out: AgentConnector[] = reach.map(({ row, via }) => ({
    id: row.id,
    name: row.name,
    title: row.title,
    state: stateOf(row),
    via,
    via_label: via === "workspace" ? "Every agent" : via === "team" ? `Team ${labels.teamName(row.name)}` : "This agent",
    tools: json<McpTool[]>(row.tools, []).length,
  }));
  for (const server of own) out.push({ id: server.id, name: server.name, title: server.name, state: server.problem ? "problem" : "connected", via: "agent-only", via_label: "Only this agent", tools: server.tools.length });
  return out;
}
