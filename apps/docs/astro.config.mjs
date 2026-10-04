// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
	site: 'https://docs.g1t.sh',
	integrations: [
		starlight({
			title: 'g1t docs',
			description: 'Guides and reference for g1t, the git forge for teams of agents.',
			components: {
				Header: './src/components/Header.astro',
				PageTitle: './src/components/PageTitle.astro',
				SiteTitle: './src/components/SiteTitle.astro',
				SocialIcons: './src/components/SocialIcons.astro',
			},
			// Each tab under the header shows its own part of the sidebar.
			routeMiddleware: './src/route-data.ts',
			expressiveCode: {
				themes: ['github-dark-default'],
				// Plain panels with a copy button, without window chrome.
				defaultProps: { frame: 'none' },
				styleOverrides: {
					borderRadius: '0.75rem',
					borderColor: 'var(--g1t-line)',
					codeBackground: 'var(--g1t-surface)',
					codeFontSize: '0.8125rem',
					frames: {
						editorBackground: 'var(--g1t-surface)',
						terminalBackground: 'var(--g1t-surface)',
						terminalTitlebarBackground: 'var(--g1t-raised)',
						terminalTitlebarBorderBottomColor: 'var(--g1t-line)',
						editorTabBarBackground: 'var(--g1t-raised)',
						shadowColor: 'transparent',
					},
				},
			},
			logo: { src: '@g1t/theme/mark.svg', alt: '' },
			favicon: '/favicon.svg',
			customCss: ['@g1t/theme/tokens.css', './src/styles/g1t.css'],
			social: [
				{ icon: 'seti:git', label: 'Source on g1t', href: 'https://g1t.sh/syntaqx/g1t' },
				{ icon: 'github', label: 'Source on GitHub', href: 'https://github.com/syntaqx/g1t' },
			],
			editLink: {
				baseUrl: 'https://github.com/syntaqx/g1t/edit/main/apps/docs/',
			},
			lastUpdated: true,
			head: [
				{ tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
				{
					tag: 'link',
					attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true },
				},
				{
					tag: 'link',
					attrs: {
						rel: 'stylesheet',
						href: 'https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&family=JetBrains+Mono:wght@400;500;600&display=swap',
					},
				},
			],
			sidebar: [
				{
					label: 'Get started',
					items: [
						{ label: 'Quickstart', slug: 'quickstart' },
						{ label: 'How g1t works', slug: 'concepts/overview' },
					],
				},
				{
					label: 'Agents',
					items: [
						{ label: 'g1t agents', slug: 'guides/g1t-agents' },
						{ label: 'Outcomes and plans', slug: 'guides/outcomes' },
						{ label: 'Talking to agents', slug: 'guides/talking-to-agents' },
						{ label: 'Bring your own agent', slug: 'guides/bring-your-own-agent' },
					],
				},
				{
					label: 'Connect your tools',
					items: [
						{ label: 'Integrations', slug: 'guides/integrations' },
						{ label: 'Model providers', slug: 'guides/models' },
						{ label: 'Webhooks', slug: 'guides/webhooks' },
						{ label: 'GitHub Actions', slug: 'guides/actions' },
					],
				},
				{
					label: 'Landing changes',
					items: [
						{ label: 'The merge queue', slug: 'guides/merge-queue' },
						{ label: 'Deployments', slug: 'guides/deployments' },
						{ label: 'Sessions and why-blame', slug: 'guides/why-blame' },
						{ label: 'Forks and branches', slug: 'concepts/forks' },
					],
				},
				{
					label: 'Workspaces',
					items: [
						{ label: 'Accounts and sign-in', slug: 'guides/authentication' },
						{ label: 'Workspaces and tokens', slug: 'guides/workspaces' },
						{ label: 'Usage and billing', slug: 'guides/usage-and-billing' },
						{ label: 'Git', slug: 'guides/git' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'API overview', slug: 'reference/api' },
						{ label: 'API explorer', link: '/api/reference/', attrs: { target: '_self' } },
						{ label: 'MCP tools', slug: 'reference/mcp' },
						{ label: 'OpenAPI document', link: 'https://api.g1t.sh/openapi.json' },
						{ label: 'llms.txt', link: 'https://g1t.sh/llms.txt' },
					],
				},
			],
		}),
	],
});
