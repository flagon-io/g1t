// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
	site: 'https://docs.g1t.sh',
	integrations: [
		starlight({
			title: 'g1t docs',
			description: 'Guides and reference for g1t, the git forge built for AI scale.',
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
						{ label: 'Concepts', slug: 'concepts/overview' },
						{ label: 'Forks and branches', slug: 'concepts/forks' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Accounts and authentication', slug: 'guides/authentication' },
						{ label: 'Git', slug: 'guides/git' },
						{ label: 'g1t agents', slug: 'guides/g1t-agents' },
						{ label: 'Bring your own agent', slug: 'guides/bring-your-own-agent' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'API overview', slug: 'reference/api' },
						{ label: 'API reference', link: '/api/reference/', attrs: { target: '_self' } },
						{ label: 'OpenAPI document', link: 'https://api.g1t.sh/openapi.json' },
						{ label: 'llms.txt', link: 'https://g1t.sh/llms.txt' },
					],
				},
				{
					label: 'g1t',
					items: [
						{ label: 'Back to g1t.sh', link: 'https://g1t.sh/' },
					],
				},
			],
		}),
	],
});
