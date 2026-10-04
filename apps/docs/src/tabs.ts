/**
 * The tabs under the header. Each shows its own part of the sidebar: the
 * groups whose pages fit its `match`. A page belongs to the tab whose
 * `match` it fits.
 */
export type Tab = { label: string; href: string; match: (slug: string) => boolean };

export const TABS: Tab[] = [
	{
		label: 'Documentation',
		href: '/',
		match: (slug) => !slug.startsWith('reference/'),
	},
	{
		label: 'API reference',
		href: '/reference/api/',
		match: (slug) => slug.startsWith('reference/'),
	},
];

export function tabFor(slug: string): Tab {
	return TABS.find((tab) => tab.match(slug)) ?? TABS[0];
}
