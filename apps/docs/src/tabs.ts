/**
 * The tabs under the header. Each shows its own part of the sidebar: the
 * groups named in its `groups`, in the sidebar's order. A page belongs to
 * the tab holding its group; the home page, in no group, to the first.
 * The API reference tab takes every group not named here, since the
 * operations' groups are named after the API's tags.
 */
export type Tab = { label: string; groups: string[] };

export const TABS: Tab[] = [
	{ label: 'Get started', groups: ['Get started', 'About'] },
	{ label: 'Coding agents', groups: ['Coding agents'] },
	{ label: 'Chat', groups: ['Chat'] },
	{ label: 'Code', groups: ['Landing changes', 'Security'] },
	{ label: 'Projects', groups: ['Projects'] },
	{ label: 'Workspaces', groups: ['Workspaces', 'Connect your tools'] },
	{ label: 'Self-hosting', groups: ['Run g1t yourself'] },
	{ label: 'Architecture', groups: ['Architecture'] },
	{ label: 'API reference', groups: [] },
];

const API = TABS[TABS.length - 1];

/** The tab that holds the sidebar group with this label. */
export function tabForGroup(label: string): Tab {
	return TABS.find((tab) => tab.groups.includes(label)) ?? API;
}
