/**
 * An agent's abilities (docs.g1t.sh/guides/agent-abilities/): what it can
 * do, in groups, and for each whether it does it on its own, only when the
 * person asked for it, after asking first, or never.
 *
 * - **g1t's own** (artifacts, chat, code, issues and pull requests, files,
 *   colleagues) are always on, within the access of the person it acts
 *   for. The four that write code and docs keep the agent's `autonomy`
 *   choices, shown here as levels.
 * - **Its computer** (shell, files, browser, web search) is coming.
 * - **Integrations**: every connector the workspace has connected lists
 *   what an agent can do through it, one row per action, from the
 *   connector catalog (./connectors.ts) and what the integrations service
 *   does today. Each row says whose connection it runs on: the
 *   workspace's, or the asking person's own.
 * - **MCP servers** an owner adds: each tool the server lists is a row. A
 *   tool that doesn't say it only reads is treated as a write.
 *
 * Levels default by what a thing does: reading is alone; writing inside
 * g1t is alone when the person asked for it; sending outside g1t asks
 * first; purchases, credentials and permission changes are never, and
 * can't be raised above asking.
 *
 * The agents service enforces these in code when it offers tools and when
 * one is called; the Abilities tab and the agents service both resolve an
 * agent's choices with `resolveAbilities`, handing it the connector catalog
 * (./connectors.ts `CONNECTORS`): no value imports here, so services test
 * it under Node as it is. Wire shapes are snake_case.
 */
import type { Connector } from "./connectors";
import type { AgentAutonomy } from "./workspace-agents";

/** Alone; alone when the asker asked for it; ask first; never. */
export type AbilityLevel = "alone" | "asked" | "ask" | "never";

export const ABILITY_LEVELS: readonly AbilityLevel[] = ["alone", "asked", "ask", "never"];

export const ABILITY_LEVEL_LABELS: Record<AbilityLevel, string> = {
  alone: "Alone",
  asked: "Alone when asked for it",
  ask: "Ask first",
  never: "Never",
};

/** How much a level lets through: a lower number is freer. */
const ORDER: Record<AbilityLevel, number> = { alone: 0, asked: 1, ask: 2, never: 3 };

export type AbilityGroup = "g1t" | "computer" | "integration" | "mcp";

/**
 * What an ability does: `read`, `write` (inside g1t), `send` (something
 * leaves g1t: a comment, a message, a change in another system) or
 * `restricted` (purchases, credentials, permission changes).
 */
export type AbilityKind = "read" | "write" | "send" | "restricted";

/** Whose connection an integration ability runs on. */
export type AbilityCredentials = "workspace" | "asker";

export type AbilityStatus = "ready" | "coming";

/** The level a kind starts at. */
export function defaultLevel(kind: AbilityKind): AbilityLevel {
  switch (kind) {
    case "read":
      return "alone";
    case "write":
      return "asked";
    case "send":
      return "ask";
    case "restricted":
      return "never";
  }
}

/** The freest level a kind may be set to: restricted things never go above asking. */
export function maxLevel(kind: AbilityKind): AbilityLevel {
  return kind === "restricted" ? "ask" : "alone";
}

/** Whether `level` is within `max`: no freer than it. */
export function withinLevel(level: AbilityLevel, max: AbilityLevel): boolean {
  return ORDER[level] >= ORDER[max];
}

/** One ability as the catalog defines it. */
export type AbilityDef = {
  /** `g1t:artifacts`, `integration:linear:read`, `mcp:<server>:<tool>`, `computer:shell`. */
  id: string;
  group: AbilityGroup;
  label: string;
  /** What it does, in a line. */
  about: string;
  kind: AbilityKind;
  /** The agent tools it offers (the agents service's names), for the row's chips. */
  tools: string[];
  status: AbilityStatus;
  /**
   * The agent's `autonomy` field it reads and writes, for g1t's own code
   * and docs abilities, with the levels that field allows.
   */
  autonomy?: { key: keyof AgentAutonomy; levels: AbilityLevel[] } | null;
};

/** What an agent keeps for one ability. Absent fields mean the default. */
export type AbilitySetting = { level?: AbilityLevel | null; credentials?: AbilityCredentials | null };

/** A tool an MCP server lists, as it was found. */
export type McpTool = {
  name: string;
  description: string;
  /** `read` when the server says the tool only reads; `write` otherwise, which is also what an unknown tool is. */
  kind: "read" | "write";
  /** Its arguments, as the server describes them (JSON Schema); what the agent is offered. */
  input_schema: Record<string, unknown>;
};

/** An MCP server an owner added to one agent. */
export type McpServer = {
  /** `mcp_…`, stable: ability ids are made from it. */
  id: string;
  /** Lowercase letters, digits and hyphens: the tools are offered as `<name>__<tool>`. */
  name: string;
  /** Its HTTPS address; the host is checked when it is added. */
  url: string;
  tools: McpTool[];
  added_by: string;
  /** RFC 3339. */
  added_at: string;
  /** When its tools were last listed, and what went wrong if they couldn't be. */
  checked_at: string | null;
  problem: string | null;
};

/** What an agent's definition keeps about its abilities. */
export type AgentAbilities = {
  /** By ability id: only what differs from the default is kept. */
  settings: Record<string, AbilitySetting>;
  mcp_servers: McpServer[];
};

export const EMPTY_ABILITIES: AgentAbilities = { settings: {}, mcp_servers: [] };

/** What a change to an agent sends for its abilities: the settings, whole. MCP servers have their own calls. */
export type AgentAbilitiesChange = { settings: Record<string, AbilitySetting> };

/** The most MCP servers one agent has, and the most tools one server lists. */
export const MAX_MCP_SERVERS = 10;
export const MAX_MCP_TOOLS = 40;

/** An ability as one agent has it now. */
export type Ability = AbilityDef & {
  level: AbilityLevel;
  /** The freest level it may be set to. */
  max: AbilityLevel;
  /** The levels it may be set to, freest first. */
  choices: AbilityLevel[];
  /** Whether the level can be changed at all: g1t's own reads are always on. */
  can_change: boolean;
  /** For an integration: whose connection it runs on. Null elsewhere. */
  credentials: AbilityCredentials | null;
  /** Whether the asking person could connect it themselves (the connector has a personal side that is available). */
  personal_available: boolean;
};

/** One source of abilities: a connector, an MCP server, or g1t itself. */
export type AbilitySource = {
  id: string;
  name: string;
  /** For an integration or an MCP server: whether the workspace has it. */
  connected: boolean;
  /** Where it is connected or managed; null when there is nowhere. */
  href: string | null;
  /** A line about it when it has no abilities, or something is wrong with it. */
  note: string | null;
  abilities: Ability[];
};

export type AbilitySection = {
  group: AbilityGroup;
  title: string;
  about: string;
  sources: AbilitySource[];
};

/** What a level means for an agent, in its own words. */
export function levelWords(level: AbilityLevel): string {
  switch (level) {
    case "alone":
      return "on its own";
    case "asked":
      return "only when the person asked for that";
    case "ask":
      return "after asking first";
    case "never":
      return "never";
  }
}

// g1t's own ---------------------------------------------------------------

/** g1t's own abilities: always on, within the asker's access; the four autonomy ones keep their choices. */
export const G1T_ABILITIES: AbilityDef[] = [
  {
    id: "g1t:artifacts",
    group: "g1t",
    label: "Artifacts",
    about: "Search, read, write, edit and share the workspace's artifacts, where the person it acts for can.",
    kind: "read",
    tools: ["search_artifacts", "read_artifact", "list_spaces", "stale_artifacts", "create_artifact", "edit_artifact", "share_artifact"],
    status: "ready",
  },
  {
    id: "g1t:chat",
    group: "g1t",
    label: "Chat",
    about: "Search messages and read threads everyone in the conversation can read, and the roster.",
    kind: "read",
    tools: ["search_messages", "read_thread", "workspace_roster"],
    status: "ready",
  },
  {
    id: "g1t:code",
    group: "g1t",
    label: "Code",
    about: "Read files and search code in repositories everyone in the conversation can read.",
    kind: "read",
    tools: ["list_repositories", "search_code", "read_file"],
    status: "ready",
  },
  {
    id: "g1t:issues",
    group: "g1t",
    label: "Issues and pull requests",
    about: "Read issues and pull requests, draft issues as cards, and comment or review on behalf of the person who asked.",
    kind: "read",
    tools: ["list_issues", "get_issue", "get_pull", "recent_activity", "draft_issue", "comment", "review_pull"],
    status: "ready",
  },
  {
    id: "g1t:pulls",
    group: "g1t",
    label: "Open pull requests",
    about: "Open pull requests from its sessions. Rules, protected branches and required checks still apply.",
    kind: "write",
    tools: [],
    status: "ready",
    autonomy: { key: "open_pull_requests", levels: ["alone", "ask"] },
  },
  {
    id: "g1t:merge",
    group: "g1t",
    label: "Merge",
    about: "Merge pull requests that have what the branch requires.",
    kind: "write",
    tools: [],
    status: "ready",
    autonomy: { key: "merge", levels: ["alone", "ask", "never"] },
  },
  {
    id: "g1t:deploy",
    group: "g1t",
    label: "Deploy to production",
    about: "Deploy a project's production environment.",
    kind: "restricted",
    tools: [],
    status: "ready",
    autonomy: { key: "deploy_production", levels: ["ask", "never"] },
  },
  {
    id: "g1t:docs",
    group: "g1t",
    label: "Edit docs",
    about: "Change docs directly, or leave each change as a suggestion someone accepts.",
    kind: "write",
    tools: ["edit_artifact"],
    status: "ready",
    autonomy: { key: "edit_docs", levels: ["alone", "ask"] },
  },
  {
    id: "g1t:files",
    group: "g1t",
    label: "Make files",
    about: "Make PDFs, Word documents, spreadsheets, CSVs and Markdown files, kept with a doc the person can open.",
    kind: "write",
    tools: ["make_file"],
    status: "ready",
  },
  {
    id: "g1t:colleagues",
    group: "g1t",
    label: "Colleagues and memory",
    about: "Ask a colleague, hand work off, bring one into a session, use its subagents, start sessions, and remember facts.",
    kind: "write",
    tools: ["ask_colleague", "hand_off", "bring_in", "use_subagent", "start_session", "post_update", "remember", "forget", "use_skill"],
    status: "ready",
  },
];

/** `autonomy` values as levels, and back. */
export function levelOfAutonomy(value: string): AbilityLevel {
  switch (value) {
    case "alone":
      return "alone";
    case "never":
      return "never";
    default:
      // `approval` and `suggest` both mean a person acts first.
      return "ask";
  }
}

export function autonomyOfLevel(key: keyof AgentAutonomy, level: AbilityLevel): string {
  if (level === "alone") return "alone";
  if (level === "never") return "never";
  return key === "edit_docs" ? "suggest" : "approval";
}

// Its computer -----------------------------------------------------------

export const COMPUTER_ABILITIES: AbilityDef[] = [
  { id: "computer:shell", group: "computer", label: "Shell", about: "Run commands on its own computer, with a persistent home.", kind: "write", tools: [], status: "coming" },
  { id: "computer:files", group: "computer", label: "Files", about: "Read and write files on its computer.", kind: "write", tools: [], status: "coming" },
  { id: "computer:browser", group: "computer", label: "Browser", about: "Open sites in a browser of its own, signed in where you let it be.", kind: "send", tools: [], status: "coming" },
  { id: "computer:web", group: "computer", label: "Web search", about: "Search and read the open web, as its team's web access allows.", kind: "read", tools: [], status: "coming" },
];

// Integrations -----------------------------------------------------------

/**
 * What an agent can do through each connector today, as the integrations
 * service does it: look an item up by its key or address, open an issue in
 * g1t from it, comment on it there, and (Sentry) mark it resolved. A
 * connector not named here has nothing an agent calls: Datadog and the
 * alerts webhook open issues by themselves; GitHub imports and mirrors
 * repositories; model providers run models.
 */
const INTEGRATION_ACTIONS: Record<string, { action: string; label: string; about: string; kind: AbilityKind; tool: string }[]> = {
  linear: [
    { action: "read", label: "Read issues", about: "Look up an issue by its key (ENG-42) or address: its title, status and description.", kind: "read", tool: "lookup_outside" },
    { action: "import", label: "Import issues", about: "Open an issue in a repository here from a Linear issue, linked back to it.", kind: "write", tool: "import_outside" },
    { action: "comment", label: "Comment", about: "Comment on an issue in Linear, as the workspace's connection, naming the person it acts for.", kind: "send", tool: "act_outside" },
  ],
  jira: [
    { action: "read", label: "Read tickets", about: "Look up a ticket by its key (TECH-1234) or address: its summary, status and description.", kind: "read", tool: "lookup_outside" },
    { action: "import", label: "Import tickets", about: "Open an issue in a repository here from a Jira ticket, linked back to it.", kind: "write", tool: "import_outside" },
    { action: "comment", label: "Comment", about: "Comment on a ticket in Jira, as the workspace's connection, naming the person it acts for.", kind: "send", tool: "act_outside" },
  ],
  sentry: [
    { action: "read", label: "Read issues", about: "Look up a Sentry issue by its address: its title, status and latest stack trace.", kind: "read", tool: "lookup_outside" },
    { action: "import", label: "Import issues", about: "Open an issue in a repository here from a Sentry issue, linked back to it.", kind: "write", tool: "import_outside" },
    { action: "comment", label: "Comment", about: "Leave a note on a Sentry issue, as the workspace's connection.", kind: "send", tool: "act_outside" },
    { action: "resolve", label: "Resolve issues", about: "Mark a Sentry issue resolved, with a note.", kind: "send", tool: "act_outside" },
  ],
};

/** What a connected connector with nothing for an agent to call says. */
function nothingToCall(connector: Connector): string {
  switch (connector.category) {
    case "monitoring":
      return "Opens issues by itself when something fires. Nothing for an agent to call.";
    case "ai":
      return "Runs models. Which ones an agent uses is set under Models on its profile.";
    case "code":
      return "Imports and mirrors repositories. Agents read the repositories themselves.";
    default:
      return "Nothing for an agent to call yet.";
  }
}

/** The abilities one connector gives an agent; empty when it has none. */
export function integrationAbilities(connectorId: string): AbilityDef[] {
  return (INTEGRATION_ACTIONS[connectorId] ?? []).map((row) => ({
    id: `integration:${connectorId}:${row.action}`,
    group: "integration",
    label: row.label,
    about: row.about,
    kind: row.kind,
    tools: [row.tool],
    status: "ready",
  }));
}

/** The connectors among `connectors` that give agents abilities, in catalog order. */
export function connectorsWithAbilities(connectors: Connector[]): Connector[] {
  return connectors.filter((connector) => (INTEGRATION_ACTIONS[connector.id] ?? []).length > 0);
}

// MCP servers ------------------------------------------------------------

/** An MCP tool as an ability of its server. */
export function mcpAbility(server: Pick<McpServer, "id" | "name">, tool: McpTool): AbilityDef {
  return {
    id: `mcp:${server.id}:${tool.name}`,
    group: "mcp",
    label: tool.name,
    about: tool.description || (tool.kind === "read" ? "Reads, as the server says." : "The server doesn't say it only reads, so it counts as a write."),
    // Anything an MCP server changes happens outside g1t.
    kind: tool.kind === "read" ? "read" : "send",
    tools: [mcpToolName(server.name, tool.name)],
    status: "ready",
  };
}

/** The tool name an agent calls an MCP tool by: `<server>__<tool>`, in the characters the model API allows. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return `${clean(server)}__${clean(tool)}`.slice(0, 64);
}

/** An MCP server's name as kept: lowercase letters, digits and hyphens, 2 to 32. */
export function checkMcpName(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,31}$/.test(name)) return { ok: false, message: "A server's name is 2 to 32 lowercase letters, digits and single hyphens." };
  return { ok: true, value: name };
}

/**
 * An MCP server's address, checked: HTTPS, a public host name (not an
 * address, not local, not g1t's own), no sign-in in the address.
 */
export function checkMcpUrl(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 500) return { ok: false, message: "Give the server's HTTPS address." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: "That isn't an address." };
  }
  if (url.protocol !== "https:") return { ok: false, message: "An MCP server is reached over HTTPS." };
  if (url.username || url.password) return { ok: false, message: "Don't put a sign-in in the address." };
  const host = url.hostname.toLowerCase();
  const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":");
  const local = host === "localhost" || /\.(local|localhost|internal|lan|home|arpa)$/.test(host) || !host.includes(".");
  if (ip || local) return { ok: false, message: "Name the server by a public host name, not an address or a local name." };
  if (/(^|\.)(g1t\.sh|g1tusercontent\.com)$/.test(host)) return { ok: false, message: "g1t's own addresses aren't MCP servers to add here." };
  url.hash = "";
  return { ok: true, value: url.toString() };
}

// Resolving --------------------------------------------------------------

export type ResolveInput = {
  /** The connector catalog (./connectors.ts `CONNECTORS`). */
  connectors: Connector[];
  abilities: AgentAbilities | null | undefined;
  autonomy: AgentAutonomy;
  /** Connector ids the workspace has connected. */
  connected: string[];
  /** Where a connector is set up or managed, by id; absent: nowhere to link. */
  hrefs?: Record<string, string | null>;
  /** Whether the agent is a member's personal one: then the workspace's connection isn't its to use unless an owner chose it. */
  personal?: boolean;
};

function settingOf(input: ResolveInput, id: string): AbilitySetting {
  return input.abilities?.settings?.[id] ?? {};
}

/** A definition as one agent has it: its level, within what the kind allows. */
export function resolveOne(def: AbilityDef, input: ResolveInput, connected = true): Ability {
  const setting = settingOf(input, def.id);
  const max = maxLevel(def.kind);
  let level: AbilityLevel;
  let choices: AbilityLevel[];
  let canChange: boolean;
  if (def.autonomy) {
    level = levelOfAutonomy(input.autonomy[def.autonomy.key]);
    choices = def.autonomy.levels;
    canChange = true;
  } else if (def.group === "g1t") {
    level = "alone";
    choices = ["alone"];
    canChange = false;
  } else if (def.status === "coming") {
    level = defaultLevel(def.kind);
    choices = [];
    canChange = false;
  } else {
    const wanted = setting.level ?? defaultLevel(def.kind);
    level = withinLevel(wanted, max) ? wanted : max;
    choices = ABILITY_LEVELS.filter((l) => withinLevel(l, max));
    canChange = true;
  }
  const integration = def.group === "integration";
  const connectorId = integration ? def.id.split(":")[1]! : null;
  const connector = connectorId ? input.connectors.find((c) => c.id === connectorId) : null;
  const personalAvailable = !!connector && connector.scopes.includes("personal") && (connector.personal?.status ?? connector.status) === "available";
  return {
    ...def,
    level,
    max,
    choices,
    can_change: canChange && (def.group !== "integration" || connected),
    credentials: integration ? (setting.credentials ?? (input.personal ? "asker" : "workspace")) : null,
    personal_available: personalAvailable,
  };
}

/** The abilities an agent has, in sections, as the tab shows them and the service enforces them. */
export function resolveAbilities(input: ResolveInput): AbilitySection[] {
  const connected = new Set(input.connected.map((id) => id.toLowerCase()));
  const hrefs = input.hrefs ?? {};
  const sections: AbilitySection[] = [
    {
      group: "g1t",
      title: "g1t",
      about: "Always on, within the access of the person it acts for. Code and docs keep the choices below.",
      sources: [{ id: "g1t", name: "g1t", connected: true, href: null, note: null, abilities: G1T_ABILITIES.map((def) => resolveOne(def, input)) }],
    },
    {
      group: "computer",
      title: "Its computer",
      about: "A computer of its own, with a shell, files, a browser and web search. Coming.",
      sources: [{ id: "computer", name: "Computer", connected: false, href: null, note: null, abilities: COMPUTER_ABILITIES.map((def) => resolveOne(def, input, false)) }],
    },
  ];
  // Every connected connector, then the ones with abilities that aren't connected yet.
  const sources: AbilitySource[] = [];
  for (const connector of input.connectors) {
    if (connector.status !== "available" || !connector.scopes.includes("workspace")) continue;
    const is = connected.has(connector.id);
    const defs = integrationAbilities(connector.id);
    if (!is && !defs.length) continue;
    // Nothing an agent calls: not worth a row unless it is connected.
    if (!defs.length && (connector.id === "webhooks" || connector.id === "ai-gateway")) continue;
    sources.push({
      id: connector.id,
      name: connector.name,
      connected: is,
      href: hrefs[connector.id] ?? null,
      note: defs.length ? null : nothingToCall(connector),
      abilities: defs.map((def) => resolveOne(def, input, is)),
    });
  }
  sources.sort((a, b) => Number(b.connected) - Number(a.connected));
  sections.push({ group: "integration", title: "Integrations", about: "What it can do through what the workspace has connected, one row per action, and whose connection each runs on.", sources });
  const servers = input.abilities?.mcp_servers ?? [];
  sections.push({
    group: "mcp",
    title: "MCP servers",
    about: "Servers an owner adds. Each tool the server lists is a row; a tool that doesn't say it only reads counts as a write.",
    sources: servers.map((server) => ({
      id: server.id,
      name: server.name,
      connected: true,
      href: server.url,
      note: server.problem ?? (server.tools.length ? null : "It listed no tools."),
      abilities: server.tools.slice(0, MAX_MCP_TOOLS).map((tool) => resolveOne(mcpAbility(server, tool), input)),
    })),
  });
  return sections;
}

/** Every ability in the sections, flat. */
export function allAbilities(sections: AbilitySection[]): Ability[] {
  return sections.flatMap((section) => section.sources.flatMap((source) => source.abilities));
}

/** The ability by id, among the sections; null when there is none. */
export function findAbility(sections: AbilitySection[], id: string): { ability: Ability; source: AbilitySource } | null {
  for (const section of sections) {
    for (const source of section.sources) {
      const ability = source.abilities.find((a) => a.id === id);
      if (ability) return { ability, source };
    }
  }
  return null;
}

/**
 * Whether what the person said asked for this: the item's key (ENG-42), or
 * the ability's own name, appears in it. For a level of `asked`.
 */
export function askedFor(said: string, keys: string[]): boolean {
  const text = said.toLowerCase();
  if (!text.trim()) return false;
  return keys.some((key) => {
    const needle = key.trim().toLowerCase();
    return needle.length >= 2 && text.includes(needle);
  });
}

/** A list in words: "a", "a and b", "a, b and c". */
function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * The agent's abilities in a sentence or two: "Can read Linear issues and
 * open pull requests on its own; imports Linear issues when asked for it;
 * asks before commenting in Linear and merging; never deploys to
 * production." Only what is connected and ready counts.
 */
export function abilitiesSummary(sections: AbilitySection[]): string {
  const by: Record<AbilityLevel, string[]> = { alone: [], asked: [], ask: [], never: [] };
  for (const section of sections) {
    if (section.group === "computer") continue;
    for (const source of section.sources) {
      if (!source.connected) continue;
      for (const ability of source.abilities) {
        if (ability.status !== "ready") continue;
        // g1t's always-on reads go without saying; its choices and everything outside are the point.
        if (section.group === "g1t" && !ability.autonomy) continue;
        const what = section.group === "g1t" ? lower(ability.label) : section.group === "mcp" ? `call ${ability.label} on ${source.name}` : `${lower(ability.label)} in ${source.name}`;
        by[ability.level].push(what);
      }
    }
  }
  const parts: string[] = [];
  if (by.alone.length) parts.push(`can ${list(by.alone)} on its own`);
  if (by.asked.length) parts.push(`${list(by.asked.map(verb))} when asked for it`);
  if (by.ask.length) parts.push(`asks before ${list(by.ask.map(gerund))}`);
  if (by.never.length) parts.push(`never ${list(by.never.map(verb))}`);
  if (!parts.length) return "Reads code, chat, issues and artifacts within the asker's access; nothing outside g1t yet.";
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** "read issues in Linear" → "reads issues in Linear". */
function verb(what: string): string {
  const [first, ...rest] = what.split(" ");
  if (!first) return what;
  const third = first.endsWith("s") ? first : first.endsWith("y") && !/[aeiou]y$/.test(first) ? `${first.slice(0, -1)}ies` : `${first}s`;
  return [third, ...rest].join(" ");
}

/** "comment in Linear" → "commenting in Linear". */
function gerund(what: string): string {
  const [first, ...rest] = what.split(" ");
  if (!first) return what;
  const ing = first.endsWith("e") && first !== "be" ? `${first.slice(0, -1)}ing` : first.endsWith("ing") ? first : `${first}ing`;
  return [ing, ...rest].join(" ");
}

/** The settings with one ability's level or credentials changed, keeping only what differs from the default. */
export function withSetting(abilities: AgentAbilities | null | undefined, id: string, change: AbilitySetting): AgentAbilities {
  const base = abilities ?? EMPTY_ABILITIES;
  const current = { ...(base.settings[id] ?? {}) };
  if (change.level !== undefined) current.level = change.level;
  if (change.credentials !== undefined) current.credentials = change.credentials;
  const next = { ...base.settings };
  const kept: AbilitySetting = {};
  if (current.level) kept.level = current.level;
  if (current.credentials) kept.credentials = current.credentials;
  if (Object.keys(kept).length) next[id] = kept;
  else delete next[id];
  return { settings: next, mcp_servers: base.mcp_servers ?? [] };
}
