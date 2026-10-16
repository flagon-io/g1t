import { AGENTS as SHARED_AGENTS, AGENT_IDS } from "@g1t/contracts/agent-setup";
import { MCP_URL } from '@g1t/contracts/agent-setup';
export { MCP_URL, PLUGIN_INSTALL } from '@g1t/contracts/agent-setup';

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

export const AGENTS = AGENT_IDS.map((id) => SHARED_AGENTS[id]);

/** The same, with a bearer token instead of signing in through the browser. */
export const AGENTS_WITH_TOKEN: AgentSetup[] = [
	{
		label: 'Claude Code',
		file: null,
		lang: 'sh',
		code: `claude mcp add --transport http g1t ${MCP_URL} \\\n  --header "Authorization: Bearer $G1T_TOKEN"`,
		then: "This adds the server without g1t's plugin. With the plugin installed, which adds it too, disable the plugin's (`plugin:g1t:g1t` in `/mcp`) or skip this, so g1t's tools are not listed twice.",
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
