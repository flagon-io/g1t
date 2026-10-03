/**
 * The tabs under the header. Each shows its own part of the sidebar, as
 * the groups named here; a page belongs to the tab whose `match` it fits.
 */
export type Tab = { label: string; href: string; groups: string[]; match: (slug: string) => boolean };

export const TABS: Tab[] = [
	{
		label: 'Documentation',
		href: '/',
		groups: ['Get started', 'Agents', 'Connect your tools', 'Landing changes', 'Workspaces'],
		match: (slug) => !slug.startsWith('reference/'),
	},
	{
		label: 'API reference',
		href: '/reference/api/',
		groups: ['Reference'],
		match: (slug) => slug.startsWith('reference/'),
	},
];

export function tabFor(slug: string): Tab {
	return TABS.find((tab) => tab.match(slug)) ?? TABS[0];
}
