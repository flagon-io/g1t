import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';

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
	const body = (page.body ?? '').replace(/^import .*$/gm, '').trim();
	const text = `# ${title}\n\n${description ? `> ${description}\n\n` : ''}${body}\n`;
	return new Response(text, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
};
