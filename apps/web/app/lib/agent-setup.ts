/**
 * How each coding agent connects to g1t's MCP server, and which one this
 * browser last chose. Every agent toggle on a page follows the same choice,
 * and it is remembered for the next visit.
 *
 * The commands follow each agent's own documentation for adding a remote
 * MCP server; keep them in step with `apps/docs/src/data/agents.ts`, the
 * docs' copy.
 */

export const MCP_URL = "https://mcp.g1t.sh";

export const AGENT_IDS = ["claude-code", "codex", "opencode", "cursor"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const DEFAULT_AGENT: AgentId = "claude-code";
/** Where the choice is kept in `localStorage`. */
export const AGENT_STORAGE_KEY = "g1t:agent";

export type AgentSetup = {
  id: AgentId;
  label: string;
  /** The file the snippet goes in, or null for a terminal command. */
  file: string | null;
  lang: "sh" | "json";
  code: string;
  /** What to do after, in a sentence or two; `code` in backticks. */
  then: string;
  /** The file it reads a repository's instructions from. */
  instructions: string;
};

const json = (value: unknown) => JSON.stringify(value, null, 2);

export const AGENTS: Record<AgentId, AgentSetup> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    file: null,
    lang: "sh",
    code: `claude mcp add --transport http g1t ${MCP_URL}`,
    then: "Then run `/mcp` in Claude Code and choose g1t to sign in through your browser.",
    instructions: "CLAUDE.md",
  },
  codex: {
    id: "codex",
    label: "Codex",
    file: null,
    lang: "sh",
    code: `codex mcp add g1t --url ${MCP_URL}\ncodex mcp login g1t`,
    then: "The login opens your browser to sign in to g1t.",
    instructions: "AGENTS.md",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    file: "opencode.json",
    lang: "json",
    code: json({
      $schema: "https://opencode.ai/config.json",
      mcp: { g1t: { type: "remote", url: MCP_URL, enabled: true } },
    }),
    then: "OpenCode signs you in through your browser when it first connects; `opencode mcp auth g1t` starts it by hand.",
    instructions: "AGENTS.md",
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    file: ".cursor/mcp.json",
    lang: "json",
    code: json({ mcpServers: { g1t: { url: MCP_URL } } }),
    then: "Use `~/.cursor/mcp.json` for every project. Cursor signs you in through your browser when it first connects.",
    instructions: "AGENTS.md",
  },
};

/** Opens Cursor with g1t ready to add, from Cursor's install-link format. */
export function cursorInstallLink(): string {
  const config = btoa(JSON.stringify({ url: MCP_URL }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=g1t&config=${encodeURIComponent(config)}`;
}

export function parseAgent(value: unknown): AgentId | null {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value) ? (value as AgentId) : null;
}

type Store = Pick<Storage, "getItem" | "setItem">;

/**
 * The remembered choice, or the default. Storage can be missing or throw
 * (private windows, blocked site data); that is the same as no choice.
 */
export function readAgentChoice(storage: () => Store | null | undefined): AgentId {
  try {
    return parseAgent(storage()?.getItem(AGENT_STORAGE_KEY)) ?? DEFAULT_AGENT;
  } catch {
    return DEFAULT_AGENT;
  }
}

/** Remembers the choice; false when it could not be kept. */
export function writeAgentChoice(storage: () => Store | null | undefined, id: AgentId): boolean {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(AGENT_STORAGE_KEY, id);
    return true;
  } catch {
    return false;
  }
}

// --- The page's one choice, which every toggle follows ----------------------

const browserStorage = () => (typeof window === "undefined" ? null : window.localStorage);
let current: AgentId | null = null;
const listeners = new Set<() => void>();

export function subscribeAgentChoice(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== AGENT_STORAGE_KEY) return;
    current = parseAgent(event.newValue) ?? DEFAULT_AGENT;
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function getAgentChoice(): AgentId {
  current ??= readAgentChoice(browserStorage);
  return current;
}

export function setAgentChoice(id: AgentId, storage: () => Store | null | undefined = browserStorage): void {
  current = id;
  writeAgentChoice(storage, id);
  for (const listener of listeners) listener();
}
