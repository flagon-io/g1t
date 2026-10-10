// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

import { generateApiReference } from './scripts/api-reference.mjs';

// A page per REST operation, written from the OpenAPI document.
const apiGroups = generateApiReference();

export default defineConfig({
	site: 'https://docs.g1t.sh',
	// Pages that moved, so links already shared still arrive.
	redirects: {
		'/guides/g1t-agents/': '/guides/working-with-g1t/',
		'/guides/inbox/': '/guides/notifications/',
	},
	integrations: [
		starlight({
			title: 'g1t docs',
			description: 'Guides and reference for g1t, the workspace where a team and its agents talk, work and ship.',
			components: {
				Footer: './src/components/Footer.astro',
				Head: './src/components/Head.astro',
				Header: './src/components/Header.astro',
				PageTitle: './src/components/PageTitle.astro',
				SiteTitle: './src/components/SiteTitle.astro',
				SocialIcons: './src/components/SocialIcons.astro',
			},
			// Each tab under the header shows its own part of the sidebar.
			routeMiddleware: './src/route-data.ts',
			expressiveCode: {
				// Dark first, as the base; the light one where the page is light.
				// Starlight switches between them by <html data-theme>.
				themes: ['github-dark-default', 'github-light-default'],
				useDarkModeMediaQuery: false,
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
			customCss: [
				'@g1t/theme/fonts.css',
				'@g1t/theme/tokens.css',
				'./src/styles/light.css',
				'./src/styles/g1t.css',
			],
			editLink: {
				baseUrl: 'https://g1t.sh/flagon-io/g1t/blob/main/apps/docs/',
			},
			lastUpdated: true,
			head: [
				{ tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '32x32' } },
				{ tag: 'link', attrs: { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/icon-192.png' } },
				{ tag: 'link', attrs: { rel: 'icon', type: 'image/png', sizes: '512x512', href: '/icon-512.png' } },
				{ tag: 'link', attrs: { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' } },
				{ tag: 'link', attrs: { rel: 'manifest', href: '/site.webmanifest' } },
				// The browser's own bars, in the page's colour for the system's setting.
				{ tag: 'meta', attrs: { name: 'theme-color', content: '#0f0f11', media: '(prefers-color-scheme: dark)' } },
				{ tag: 'meta', attrs: { name: 'theme-color', content: '#fbfbfa', media: '(prefers-color-scheme: light)' } },
			],
			sidebar: [
				{
					label: 'Get started',
					items: [
						{ label: 'Quickstart', slug: 'quickstart' },
						{ label: 'How g1t works', slug: 'concepts/overview' },
						{ label: 'Today', slug: 'guides/today' },
						{ label: 'Notifications', slug: 'guides/notifications' },
						{ label: 'Search and Explore', slug: 'guides/search' },
						{ label: 'Status and incidents', slug: 'guides/status' },
					],
				},
				{
					label: 'Chat and agents',
					items: [
						{ label: 'Chat', slug: 'guides/chat' },
						{ label: 'Agents', slug: 'guides/agents' },
						{ label: 'Sessions', slug: 'guides/agent-sessions' },
						{ label: 'Agent memory', slug: 'guides/agent-memory' },
						{ label: 'Routines', slug: 'guides/agent-routines' },
						{ label: 'Spend', slug: 'guides/spend' },
						{ label: 'Agent budgets and spend', slug: 'guides/agent-budgets' },
						{ label: 'What agents can do for whom', slug: 'guides/agent-access' },
						{ label: 'Artifacts', slug: 'guides/artifacts' },
						{ label: 'Agents in your chat app', slug: 'guides/chat-app', badge: { text: 'Soon', variant: 'default' } },
					],
				},
				{
					label: 'Projects',
					items: [
						{ label: 'Projects', slug: 'guides/projects' },
						{ label: 'Deployments', slug: 'guides/deployments' },
						{ label: 'Deployments API', slug: 'guides/deployments-api' },
						{ label: 'Packages', slug: 'guides/packages' },
						{ label: 'Container images', slug: 'guides/containers' },
						{ label: 'npm', slug: 'guides/npm' },
						{ label: 'Cargo', slug: 'guides/cargo' },
						{ label: 'Composer', slug: 'guides/composer' },
						{ label: 'Maven', slug: 'guides/maven' },
						{ label: 'NuGet', slug: 'guides/nuget' },
						{ label: 'RubyGems', slug: 'guides/rubygems' },
						{ label: 'Go modules', slug: 'guides/go' },
						{ label: 'Secrets and variables', slug: 'guides/secrets-and-variables' },
					],
				},
				{
					label: 'Security',
					items: [
						{ label: 'Security', slug: 'guides/security' },
						{ label: 'Dependency updates', slug: 'guides/dependency-updates' },
						{ label: 'Secret protection', slug: 'guides/security/secret-protection' },
						{ label: 'Code scanning', slug: 'guides/security/code-scanning' },
						{ label: 'Supply chain', slug: 'guides/security/supply-chain' },
						{ label: 'Security overview', slug: 'guides/security/security-overview' },
						{ label: "What's free and what's paid", slug: 'guides/security/pricing' },
					],
				},
				{
					label: 'Agents on code',
					items: [
						{ label: "g1t's agent", slug: 'guides/working-with-g1t' },
						{ label: 'Guardrails', slug: 'guides/guardrails' },
						{ label: 'Outcomes and plans', slug: 'guides/outcomes' },
						{ label: 'Talking to agents', slug: 'guides/talking-to-agents' },
						{ label: 'Agents, sessions and memory', slug: 'guides/agents-and-memory' },
						{ label: 'Context hub', slug: 'guides/context-hub' },
						{ label: 'Bring your own agent', slug: 'guides/bring-your-own-agent' },
					],
				},
				{
					label: 'Connect your tools',
					items: [
						{ label: 'Integrations', slug: 'guides/integrations' },
						{ label: 'Model providers', slug: 'guides/models' },
						{ label: 'AI Gateway', slug: 'guides/ai-gateway' },
						{ label: 'Webhooks', slug: 'guides/webhooks' },
						{ label: 'GitHub Actions', slug: 'guides/actions' },
						{ label: 'Self-hosted runners', slug: 'guides/self-hosted-runners' },
					],
				},
				{
					label: 'Landing changes',
					items: [
						{ label: 'Pull requests and checks', slug: 'guides/pull-requests' },
						{ label: 'Checks', slug: 'guides/checks' },
						{ label: 'Pull requests into other branches', slug: 'guides/base-branches' },
						{ label: 'Labels', slug: 'guides/labels' },
						{ label: 'Milestones', slug: 'guides/milestones' },
						{ label: 'The merge queue', slug: 'guides/merge-queue' },
						{ label: 'Rules', slug: 'guides/rules' },
						{ label: 'CODEOWNERS', slug: 'guides/codeowners' },
						{ label: 'Sessions and why-blame', slug: 'guides/why-blame' },
						{ label: 'Forks and branches', slug: 'concepts/forks' },
					],
				},
				{
					label: 'Workspaces',
					items: [
						{ label: 'Accounts and sign-in', slug: 'guides/authentication' },
						{ label: 'GitHub', slug: 'guides/github' },
						{ label: 'Mirroring', slug: 'guides/mirroring' },
						{ label: 'Workspaces and tokens', slug: 'guides/workspaces' },
						{ label: 'Access and roles', slug: 'guides/access-and-roles' },
						{ label: 'Teams', slug: 'guides/teams' },
						{ label: 'Managing a repository', slug: 'guides/managing-repositories' },
						{ label: 'Releases', slug: 'guides/releases' },
						{ label: 'Transferring a repository', slug: 'guides/transferring-repositories' },
						{ label: 'Audit log', slug: 'guides/audit-log' },
						{ label: 'Usage and billing', slug: 'guides/usage-and-billing' },
						{ label: 'Git', slug: 'guides/git' },
					],
				},
				{
					label: 'Run g1t yourself',
					items: [
						{ label: 'With Docker Compose', slug: 'guides/self-hosting' },
						{ label: 'How a self-hosted g1t runs', slug: 'guides/self-hosting-architecture' },
						{ label: 'Deploy to Cloudflare', slug: 'guides/deploy-to-cloudflare' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'API overview', slug: 'reference/api' },
						{ label: 'MCP tools', slug: 'reference/mcp' },
						{ label: 'Rate limits', slug: 'reference/rate-limits' },
						{ label: 'Try it in the explorer', link: '/api/reference/', attrs: { target: '_self' } },
						{ label: 'OpenAPI document', link: 'https://api.g1t.sh/openapi.json' },
						{ label: 'llms.txt', link: 'https://g1t.sh/llms.txt' },
					],
				},
				{
					label: 'About',
					items: [
						{ label: "What g1t can't do yet", slug: 'about/limitations' },
						{ label: 'An open letter to Cloudflare', slug: 'about/open-letter-to-cloudflare' },
					],
				},
				...apiGroups,
			],
		}),
	],
});
