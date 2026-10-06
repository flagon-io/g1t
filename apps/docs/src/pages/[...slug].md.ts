import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';

import { AGENTS, AGENTS_WITH_TOKEN, type AgentSetup } from '../data/agents';

/** The agent toggle, as plain Markdown: each agent's snippet under its name. */
function agentsMarkdown(agents: AgentSetup[]): string {
	return agents
		.map((agent) => {
			const where = agent.file ? ` (in \`${agent.file}\`)` : '';
			const then = agent.then ? `\n\n${agent.then}` : '';
			const fence = '```';
			return `**${agent.label}**${where}:\n\n${fence}${agent.lang}\n${agent.code}\n${fence}${then}`;
		})
		.join('\n\n');
}

/**
 * Every page as Markdown, at its path plus `.md`, for "Copy page" and for
 * agents that read the docs: the title, what it is about, then the page.
 */
export const getStaticPaths: GetStaticPaths = async () => {
	const pages = await getCollection('docs');
	return pages.map((page) => ({
		params: { slug: page.id === '' ? 'index' : page.id },
		props: { page },
	}));
};

export const GET: APIRoute = ({ props }) => {
	const { page } = props as { page: Awaited<ReturnType<typeof getCollection<'docs'>>>[number] };
	const { title, description } = page.data;
	// MDX pages keep their markup; strip imports and leave the rest readable.
	const body = (page.body ?? '')
		.replace(/^import .*$/gm, '')
		.replace(/^([ \t]*)<AgentSetup( variant="token")? \/>$/gm, (_match, indent: string, token?: string) =>
			agentsMarkdown(token ? AGENTS_WITH_TOKEN : AGENTS)
				.split('\n')
				.map((line) => (line ? indent + line : line))
				.join('\n'),
		)
		.trim();
	const text = `# ${title}\n\n${description ? `> ${description}\n\n` : ''}${body}\n`;
	return new Response(text, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
};
