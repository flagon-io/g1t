/**
 * Coding agents and bots that commit to repositories under their own
 * names: Claude Code, Codex, Copilot, Gemini, Cursor and the dependency
 * bots. None of them is an account on g1t, but each writes the same
 * address on every commit (or a GitHub bot's noreply address), so g1t
 * shows them as what they are, with their maker's mark and a card,
 * rather than as an unknown author.
 *
 * Matched by the commit's address only, never by the name: anyone can
 * write "Claude" as their name. An account that owns an address always
 * wins (lib/commit-people.ts in the site, services/repos contributors.rs);
 * these addresses can't be confirmed by anyone, so that never happens.
 *
 * The Rust side (crates/contracts/src/coding_agents.rs) keeps the same
 * ids, addresses and logins; a test there reads this file to keep them
 * equal. No imports, so it runs anywhere.
 */

export type CodingAgentId = "claude" | "codex" | "copilot" | "gemini" | "jules" | "cursor" | "devin" | "aider" | "dependabot" | "renovate" | "github-actions";

/** Whether it writes code for people (`agent`) or keeps dependencies and builds running (`bot`). */
export type CodingAgentKind = "agent" | "bot";

export type CodingAgent = {
  id: CodingAgentId;
  /** What it's called, as its card names it. */
  name: string;
  /** Who makes it. */
  maker: string;
  kind: CodingAgentKind;
  /** One line about it, for its card. */
  about: string;
  /** Its own page. */
  url: string;
  /** Addresses it writes on commits, lowercase. */
  emails: readonly string[];
  /** GitHub logins whose noreply addresses (`123+login@users.noreply.github.com`) are its, lowercase. */
  logins: readonly string[];
  /** Its mark's background, as a hex colour without `#`; null to use the page's own colours. */
  color: string | null;
};

export const CODING_AGENTS: readonly CodingAgent[] = [
  {
    id: "claude",
    name: "Claude",
    maker: "Anthropic",
    kind: "agent",
    about: "Anthropic's coding agent. Commits made with Claude Code carry its address as author or co-author.",
    url: "https://claude.com/product/claude-code",
    emails: ["noreply@anthropic.com"],
    logins: ["claude", "claude[bot]"],
    color: "D97757",
  },
  {
    id: "codex",
    name: "Codex",
    maker: "OpenAI",
    kind: "agent",
    about: "OpenAI's coding agent, committing through its GitHub app.",
    url: "https://openai.com/codex",
    emails: [],
    logins: ["chatgpt-codex-connector[bot]", "codex[bot]"],
    color: null,
  },
  {
    id: "copilot",
    name: "Copilot",
    maker: "GitHub",
    kind: "agent",
    about: "GitHub's coding agent.",
    url: "https://github.com/features/copilot",
    emails: [],
    logins: ["copilot", "copilot-swe-agent[bot]", "copilot-pull-request-reviewer[bot]"],
    color: null,
  },
  {
    id: "gemini",
    name: "Gemini",
    maker: "Google",
    kind: "agent",
    about: "Google's coding assistant, committing through its GitHub app.",
    url: "https://codeassist.google",
    emails: [],
    logins: ["gemini-code-assist[bot]", "gemini-cli[bot]"],
    color: "8E75B2",
  },
  {
    id: "jules",
    name: "Jules",
    maker: "Google",
    kind: "agent",
    about: "Google's asynchronous coding agent.",
    url: "https://jules.google",
    emails: [],
    logins: ["google-labs-jules[bot]"],
    color: "8E75B2",
  },
  {
    id: "cursor",
    name: "Cursor",
    maker: "Anysphere",
    kind: "agent",
    about: "Cursor's background agent.",
    url: "https://cursor.com",
    emails: ["cursoragent@cursor.com"],
    logins: ["cursor[bot]", "cursor-agent[bot]"],
    color: null,
  },
  {
    id: "devin",
    name: "Devin",
    maker: "Cognition",
    kind: "agent",
    about: "Cognition's coding agent.",
    url: "https://devin.ai",
    emails: [],
    logins: ["devin-ai-integration[bot]"],
    color: null,
  },
  {
    id: "aider",
    name: "Aider",
    maker: "Aider",
    kind: "agent",
    about: "An open-source coding agent for the terminal.",
    url: "https://aider.chat",
    emails: ["noreply@aider.chat", "aider@aider.chat"],
    logins: [],
    color: null,
  },
  {
    id: "dependabot",
    name: "Dependabot",
    maker: "GitHub",
    kind: "bot",
    about: "Opens pull requests that update dependencies.",
    url: "https://github.com/dependabot",
    emails: ["support@dependabot.com"],
    logins: ["dependabot[bot]", "dependabot-preview[bot]"],
    color: "025E8C",
  },
  {
    id: "renovate",
    name: "Renovate",
    maker: "Mend",
    kind: "bot",
    about: "Opens pull requests that update dependencies.",
    url: "https://docs.renovatebot.com",
    emails: ["bot@renovateapp.com"],
    logins: ["renovate[bot]"],
    color: "308BE3",
  },
  {
    id: "github-actions",
    name: "GitHub Actions",
    maker: "GitHub",
    kind: "bot",
    about: "Commits made by a workflow on GitHub.",
    url: "https://github.com/features/actions",
    emails: ["action@github.com"],
    logins: ["github-actions[bot]"],
    color: "2088FF",
  },
];

const GITHUB_NOREPLY = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/;

/** The coding agent a commit's address belongs to, or null. */
export function codingAgentFor(email: string | null | undefined): CodingAgent | null {
  const address = (email ?? "").trim().toLowerCase();
  if (!address) return null;
  const login = GITHUB_NOREPLY.exec(address)?.[1] ?? null;
  return CODING_AGENTS.find((agent) => agent.emails.includes(address) || (login !== null && agent.logins.includes(login))) ?? null;
}

/** An agent by id, or null for one this g1t doesn't know (an older or newer list). */
export function codingAgentById(id: string | null | undefined): CodingAgent | null {
  return CODING_AGENTS.find((agent) => agent.id === id) ?? null;
}
