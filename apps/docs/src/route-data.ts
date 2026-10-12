import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { ogVersion } from '@g1t/contracts/og';

import { TABS, type Tab, tabForGroup } from './tabs';

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

/** What the header and the page's title show: the tabs, and where the page sits. */
export type Nav = {
	tabs: { label: string; href: string; current: boolean }[];
	/** The sidebar group holding the page, or its tab's name, shown above its title. */
	section?: string;
};

/** Each route's Nav, set here for Header.astro and PageTitle.astro. */
export const NAV = new WeakMap<object, Nav>();

/**
 * The tab a top-level sidebar group belongs to. The API's groups are told
 * apart by their pages, not their labels, since an API tag can share a
 * guide group's name.
 */
function tabOf(group: Entry): Tab {
	const slug = firstSlug(group.entries ?? []) ?? '';
	return slug.startsWith('reference/') ? TABS[TABS.length - 1] : tabForGroup(group.label ?? '');
}

/** Whether the current page is in these entries, at any depth. */
function holdsCurrent(entries: Entry[]): boolean {
	return entries.some((entry) => entry.isCurrent || holdsCurrent(entry.entries ?? []));
}

/**
 * Each page's sidebar holds only its tab's groups.
 *
 * Each page also gets its own social card: its title, its section and its
 * description, drawn by the og service.
 */
export const onRequest = defineRouteMiddleware((context) => {
	const route = context.locals.starlightRoute;
	const groups = (route.sidebar as Entry[]).filter((entry) => entry.type === 'group');
	const section = sectionOf(groups);
	// A page in no group, such as the home page, is in the first tab.
	const holder = groups.find((group) => holdsCurrent(group.entries ?? []));
	const tab = holder ? tabOf(holder) : TABS[0];
	// A tab opens on the first page of its first group; the first tab, on the home page.
	const tabs = TABS.map((each) => {
		const group = each === TABS[0] ? undefined : groups.find((entry) => tabOf(entry) === each);
		const slug = group ? firstSlug(group.entries ?? []) : undefined;
		return { label: each.label, href: slug === undefined ? '/' : `/${slug}/`, current: each === tab };
	});
	NAV.set(route, { tabs, section: section ?? (route.id === '' ? undefined : tab.label) });
	route.sidebar = route.sidebar.filter((entry) => entry.type === 'group' && tabOf(entry as Entry) === tab);

	const { title, description } = route.entry.data;
	const card = new URL('/docs', OG);
	card.searchParams.set('title', title);
	if (section) card.searchParams.set('section', section);
	if (description) card.searchParams.set('description', description);
	// The render version, so a new card design is a new address for every cache.
	card.searchParams.set('v', ogVersion());
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
