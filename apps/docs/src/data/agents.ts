/**
 * How each coding agent connects to g1t's MCP server, from each agent's own
 * documentation for adding a remote MCP server. The site's copy is
 * `apps/web/app/lib/agent-setup.ts`; keep the two in step.
 */

export const MCP_URL = 'https://mcp.g1t.sh';

export type AgentSetup = {
	label: string;
	/** The file the snippet goes in, or null for a terminal command. */
	file: string | null;
	lang: 'sh' | 'json' | 'toml';
	code: string;
	/** What to do after; Markdown is not parsed, `code` in backticks is. */
	then: string;
};

const json = (value: unknown) => JSON.stringify(value, null, 2);

export const AGENTS: AgentSetup[] = [
	{
		label: 'Claude Code',
		file: null,
		lang: 'sh',
		code: `claude mcp add --transport http g1t ${MCP_URL}`,
		then: 'Then run `/mcp` in Claude Code and choose g1t to sign in through your browser.',
	},
	{
		label: 'Codex',
		file: null,
		lang: 'sh',
		code: `codex mcp add g1t --url ${MCP_URL}\ncodex mcp login g1t`,
		then: 'The login opens your browser to sign in to g1t.',
	},
	{
		label: 'OpenCode',
		file: 'opencode.json',
		lang: 'json',
		code: json({
			$schema: 'https://opencode.ai/config.json',
			mcp: { g1t: { type: 'remote', url: MCP_URL, enabled: true } },
		}),
		then: 'OpenCode signs you in through your browser when it first connects; `opencode mcp auth g1t` starts it by hand.',
	},
	{
		label: 'Cursor',
		file: '.cursor/mcp.json',
		lang: 'json',
		code: json({ mcpServers: { g1t: { url: MCP_URL } } }),
		then: 'Use `~/.cursor/mcp.json` for every project. Cursor signs you in through your browser when it first connects.',
	},
];

/** The same, with a bearer token instead of signing in through the browser. */
export const AGENTS_WITH_TOKEN: AgentSetup[] = [
	{
		label: 'Claude Code',
		file: null,
		lang: 'sh',
		code: `claude mcp add --transport http g1t ${MCP_URL} \\\n  --header "Authorization: Bearer $G1T_TOKEN"`,
		then: '',
	},
	{
		label: 'Codex',
		file: '~/.codex/config.toml',
		lang: 'toml',
		code: `[mcp_servers.g1t]\nurl = "${MCP_URL}"\nbearer_token_env_var = "G1T_TOKEN"`,
		then: '',
	},
	{
		label: 'OpenCode',
		file: 'opencode.json',
		lang: 'json',
		code: json({
			$schema: 'https://opencode.ai/config.json',
			mcp: {
				g1t: {
					type: 'remote',
					url: MCP_URL,
					oauth: false,
					headers: { Authorization: 'Bearer {env:G1T_TOKEN}' },
				},
			},
		}),
		then: '',
	},
	{
		label: 'Cursor',
		file: '.cursor/mcp.json',
		lang: 'json',
		code: json({ mcpServers: { g1t: { url: MCP_URL, headers: { Authorization: 'Bearer ${env:G1T_TOKEN}' } } } }),
		then: '',
	},
];
