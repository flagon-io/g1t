import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

import { tabFor } from './tabs';

type Entry = { type: string; label?: string; href?: string; isCurrent?: boolean; entries?: Entry[] };

/** The social cards' service; see services/og. */
const OG = 'https://og.g1t.sh';

/** The slug of a group's first page on this site, such as `reference/api`. */
function firstSlug(entries: Entry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type === 'group') {
			const slug = firstSlug(entry.entries ?? []);
			if (slug !== undefined) return slug;
		} else if (entry.href?.startsWith('/') && !entry.href.startsWith('//')) {
			return entry.href.replace(/^\/|\/$/g, '');
		}
	}
	return undefined;
}

/** The label of the sidebar group holding the current page, the innermost if they nest. */
function sectionOf(entries: Entry[], group?: string): string | undefined {
	for (const entry of entries) {
		if (entry.type === 'group') {
			const found = sectionOf(entry.entries ?? [], entry.label);
			if (found !== undefined) return found;
		} else if (entry.isCurrent) {
			return group;
		}
	}
	return undefined;
}

/**
 * Each page's sidebar holds only its tab's groups: those whose pages
 * belong to the same tab. Groups are told apart by their pages, not their
 * labels, since a guide group and an API group can share a name.
 *
 * Each page also gets its own social card: its title, its section and its
 * description, drawn by the og service.
 */
export const onRequest = defineRouteMiddleware((context) => {
	const route = context.locals.starlightRoute;
	const section = sectionOf(route.sidebar as Entry[]);
	const tab = tabFor(route.id);
	route.sidebar = route.sidebar.filter((entry) => {
		if (entry.type !== 'group') return false;
		const slug = firstSlug(entry.entries as Entry[]);
		return slug !== undefined && tabFor(slug) === tab;
	});

	const { title, description } = route.entry.data;
	const card = new URL('/docs', OG);
	card.searchParams.set('title', title);
	if (section) card.searchParams.set('section', section);
	if (description) card.searchParams.set('description', description);
	const image = card.toString();
	const alt = `${title} · g1t docs`;
	const meta = (key: 'property' | 'name', name: string, content: string) => ({
		tag: 'meta' as const,
		attrs: { [key]: name, content },
	});
	// Starlight already writes og:title, og:description, og:url and
	// twitter:card; these finish the card.
	route.head.push(
		meta('property', 'og:image', image),
		meta('property', 'og:image:type', 'image/png'),
		meta('property', 'og:image:width', '1200'),
		meta('property', 'og:image:height', '630'),
		meta('property', 'og:image:alt', alt),
		meta('name', 'twitter:title', title),
		meta('name', 'twitter:image', image),
		meta('name', 'twitter:image:alt', alt),
	);
	if (description) route.head.push(meta('name', 'twitter:description', description));
});
