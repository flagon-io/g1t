import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

import { tabFor } from './tabs';

type Entry = { type: string; href?: string; entries?: Entry[] };

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

/**
 * Each page's sidebar holds only its tab's groups: those whose pages
 * belong to the same tab. Groups are told apart by their pages, not their
 * labels, since a guide group and an API group can share a name.
 */
export const onRequest = defineRouteMiddleware((context) => {
	const route = context.locals.starlightRoute;
	const tab = tabFor(route.id);
	route.sidebar = route.sidebar.filter((entry) => {
		if (entry.type !== 'group') return false;
		const slug = firstSlug(entry.entries as Entry[]);
		return slug !== undefined && tabFor(slug) === tab;
	});
});
