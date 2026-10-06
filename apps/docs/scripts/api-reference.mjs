// @ts-check
/**
 * The REST API reference: a page for every operation in the OpenAPI
 * document, written as Markdown into src/content/docs/reference/api/ so
 * Starlight renders, indexes and searches it like any other page.
 *
 * The document is src/data/openapi.json, the API's own description of
 * itself. It is generated from apps/api, not fetched, so building the docs
 * needs no network. After changing an operation, refresh it with
 * `G1T_WRITE_OPENAPI=1 cargo test -p g1t-api openapi`.
 *
 * astro.config.mjs calls this when it loads, so `astro dev` and
 * `astro build` both see current pages. The pages are not committed.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'src/content/docs/reference/api');
const BASE = 'https://api.g1t.sh';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Values for path parameters an example does not give. */
const DEFAULT_PARAMS = { owner: 'flagon-io', name: 'hello', workspace: 'flagon-io' };

const STATUS = {
	401: ['unauthenticated', 'A token is required, or the one sent is not valid.'],
	402: ['payment_required', 'The workspace cannot start this work: it needs the g1t plan or a card check, or it is at a limit. See [usage and billing](/guides/usage-and-billing/#when-work-is-stopped).'],
	403: ['forbidden', 'The token is valid but not allowed to do this, such as a member-only change or an agent token outside its repository.'],
	404: ['not_found', 'It does not exist, or you cannot see it.'],
	409: ['conflict', 'The request conflicts with the current state.'],
	422: ['invalid', 'The input is not valid. `message` says which field and why.'],
};

/** `create_issue` as a URL segment: `create-issue`. */
const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function loadDocument() {
	return JSON.parse(readFileSync(join(root, 'src/data/openapi.json'), 'utf8'));
}

/** Every operation in the document, in the order the reference lists them. */
export function operations(document = loadDocument()) {
	const tags = document.tags.map((tag) => tag.name);
	const found = [];
	let position = 0;
	for (const [path, methods] of Object.entries(document.paths)) {
		for (const method of METHODS) {
			const operation = methods[method];
			if (!operation) continue;
			const tag = operation.tags?.[0] ?? 'Repositories';
			found.push({
				...operation,
				method: method.toUpperCase(),
				path,
				tag,
				position: position++,
				slug: `reference/api/${slugify(tag)}/${slugify(operation.operationId)}`,
			});
		}
	}
	// By section, then by the section's own reading order (the operation's
	// place in it), then a repository's address before a workspace's.
	const order = new Map(document.tags.flatMap((tag) => (tag['x-tools'] ?? []).map((name, i) => [name, i])));
	return found.sort(
		(a, b) =>
			tags.indexOf(a.tag) - tags.indexOf(b.tag) ||
			(order.get(a['x-operation']) ?? -1) - (order.get(b['x-operation']) ?? -1) ||
			Number(a.operationId.endsWith('_for_workspace')) - Number(b.operationId.endsWith('_for_workspace')) ||
			a.position - b.position,
	);
}

/** A table cell's text: one line, with pipes escaped. */
const cell = (text) => String(text ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|');

/** Markdown text, made safe for a page: no raw HTML from the document. */
const prose = (text) => String(text ?? '').replace(/</g, '&lt;');

/** A schema's type, the way a person says it. */
function typeName(schema = {}) {
	if (schema.$ref) return 'object';
	const types = [schema.type ?? 'any'].flat();
	return types
		.map((type) => {
			if (type === 'array') {
				const items = schema.items ?? {};
				const of = typeName(items);
				return `array of ${of === 'object' ? 'objects' : `${of}s`}`;
			}
			return type;
		})
		.join(' or ');
}

function describe(schema = {}) {
	const parts = [];
	if (schema.description) parts.push(linkTools(prose(schema.description)));
	const values = schema.enum ?? schema.items?.enum;
	if (values && values.length <= 20) parts.push(`One of ${values.map((value) => `\`${value}\``).join(', ')}.`);
	else if (values) parts.push(`One of the ${values.length} [webhook event types](/guides/webhooks/#events).`);
	return parts.join(' ');
}

/** Rows for an object's properties, with nested objects and lists of objects after their parent. */
function propertyRows(schema, prefix = '') {
	const rows = [];
	const required = new Set(schema.required ?? []);
	for (const [name, property] of Object.entries(schema.properties ?? {})) {
		const full = `${prefix}${name}`;
		rows.push([`\`${full}\``, typeName(property), required.has(name) ? 'Yes' : 'No', describe(property)]);
		if (property.type === 'object' && property.properties) rows.push(...propertyRows(property, `${full}.`));
		if (property.type === 'array' && property.items?.properties) rows.push(...propertyRows(property.items, `${full}[].`));
	}
	return rows;
}

function table(head, rows) {
	return [
		`| ${head.join(' | ')} |`,
		`| ${head.map(() => '---').join(' | ')} |`,
		...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
	].join('\n');
}

/** A value for a parameter an example does not give. */
function sample(name, schema = {}) {
	if (schema.enum) return schema.enum[0];
	if (name === 'number') return 12;
	const type = [schema.type].flat()[0];
	if (type === 'integer') return 1;
	if (type === 'boolean') return true;
	return `${name}`;
}

/** A body for the example when the reference has none: the required fields. */
function sampleBody(schema) {
	const body = {};
	for (const name of schema.required ?? []) body[name] = sample(name, schema.properties?.[name]);
	return body;
}

function curl(operation) {
	const params = { ...DEFAULT_PARAMS, ...(operation['x-example-params'] ?? {}) };
	let url = BASE + operation.path.replace(/\{(\w+)\}/g, (_, name) => {
		if (name in params) return encodeURIComponent(String(params[name]));
		if (name === 'number') return operation.path.includes('/pulls/') ? '14' : '12';
		const schema = (operation.parameters ?? []).find((p) => p.name === name)?.schema;
		return encodeURIComponent(String(sample(name, schema)));
	});
	const query = operation['x-example-query'];
	if (query && Object.keys(query).length) {
		url += '?' + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
	}
	const lines = [];
	const quoted = url.includes('?') ? `"${url}"` : url;
	lines.push(operation.method === 'GET' ? `curl ${quoted}` : `curl -X ${operation.method} ${quoted}`);
	const anonymous = Array.isArray(operation.security) && operation.security.length === 0;
	if (!anonymous) lines.push(`-H "Authorization: Bearer $G1T_TOKEN"`);
	const content = operation.requestBody?.content?.['application/json'];
	if (content) {
		const body = content.example ?? sampleBody(content.schema ?? {});
		if (Object.keys(body).length) {
			lines.push('-H "Content-Type: application/json"');
			const json = JSON.stringify(body, null, 2).replace(/'/g, `'\\''`).replace(/\n/g, '\n  ');
			lines.push(`-d '${json}'`);
		}
	}
	return lines.join(' \\\n  ');
}

/** The first sentence, for the page's summary line, and the rest. */
function split(description) {
	const text = String(description ?? '').trim();
	const paragraphs = text.split(/\n\n/);
	const first = paragraphs[0];
	// A sentence ends at ". " followed by a capital letter or a backtick.
	const match = first.match(/^(.+?[.!?])\s+(?=[A-Z`])/s);
	if (!match) return { lead: first, rest: paragraphs.slice(1).join('\n\n') };
	return { lead: match[1], rest: [first.slice(match[0].length), ...paragraphs.slice(1)].join('\n\n') };
}

/** Each operation's page: the first of its addresses, a repository's. */
const pages = new Map();

/** Names of other operations in running text, linked to their pages. */
function linkTools(text, self) {
	return text.replace(/(^|[\s(])([a-z]+(?:_[a-z]+)+)(?=[\s.,;:)]|$)/g, (whole, before, name) => {
		const page = pages.get(name);
		if (!page || name === self) return whole;
		return `${before}[\`${name}\`](/${page}/)`;
	});
}

/** The page for one operation. */
function page(operation, all) {
	const { lead, rest } = split(operation.description);
	const name = operation['x-operation'];
	const tool = operation['x-mcp-tool'];
	const action = operation['x-mcp-action'];
	const scope = operation['x-scope'];
	const security = operation.security ?? [{ token: [] }];
	const auth =
		security.length === 0
			? 'None.'
			: security.some((entry) => Object.keys(entry).length === 0)
				? 'Optional. Public data can be read without a token; send one to see what is private.'
				: 'Required. Send an [access token](/reference/api/#authentication) as `Authorization: Bearer`.';
	const siblings = all.filter((other) => name && other['x-operation'] === name && other !== operation);

	const out = [];
	out.push('---');
	out.push(`title: ${JSON.stringify(operation.summary)}`);
	out.push(`description: ${JSON.stringify(lead.replace(/`/g, ''))}`);
	out.push('editUrl: false');
	out.push('lastUpdated: false');
	out.push('---');
	out.push('');
	out.push(
		`<div class="g1t-endpoint"><span class="g1t-method" data-method="${operation.method.toLowerCase()}">${operation.method}</span><code>${operation.path}</code></div>`,
	);
	out.push('');
	if (rest) {
		out.push(linkTools(prose(rest), name));
		out.push('');
	}
	const facts = [['Authentication', auth]];
	facts.push([
		'MCP tool',
		tool
			? `[\`${tool}\`](/reference/mcp/#${tool}) with \`action\` \`${action}\`, and the same inputs`
			: 'None. Signing in is on the REST API only.',
	]);
	if (tool) {
		facts.push([
			'Scope',
			scope
				? `An access token needs [\`${scope}\`](/guides/authentication/#scopes).`
				: 'None. Any access token may use it.',
		]);
	}
	if (siblings.length) {
		facts.push([
			'Also at',
			siblings.map((other) => `[\`${other.method} ${other.path}\`](/${other.slug}/)`).join(', '),
		]);
	}
	out.push(...facts.map(([name, value]) => `- **${name}:** ${value}`));
	out.push('');

	const path = (operation.parameters ?? []).filter((p) => p.in === 'path');
	const query = (operation.parameters ?? []).filter((p) => p.in === 'query');
	const parameterRows = (list) =>
		list.map((p) => [`\`${p.name}\``, typeName(p.schema), p.required ? 'Yes' : 'No', describe({ ...p.schema, description: p.description })]);
	if (path.length) {
		out.push('## Path parameters', '', table(['Name', 'Type', 'Required', 'Description'], parameterRows(path)), '');
	}
	if (query.length) {
		out.push('## Query parameters', '', table(['Name', 'Type', 'Required', 'Description'], parameterRows(query)), '');
	}
	const body = operation.requestBody?.content?.['application/json']?.schema;
	if (body?.properties && Object.keys(body.properties).length) {
		out.push(
			'## Body parameters',
			'',
			'Send a JSON object. Names are `snake_case`, as in responses; the `camelCase` spelling is accepted too.',
			'',
			table(['Name', 'Type', 'Required', 'Description'], propertyRows(body)),
			'',
		);
	}

	out.push('## Example request', '', '```sh', curl(operation), '```', '');

	const ok = operation.responses?.['200'];
	const example = ok?.content?.['application/json']?.example;
	out.push('## Example response', '');
	if (example !== undefined) {
		out.push(`A successful request answers \`200\` with:`, '', '```json', JSON.stringify(example, null, 2), '```', '');
	} else {
		out.push('A successful request answers `200`.', '');
	}

	const errors = Object.keys(operation.responses ?? {})
		.filter((status) => status in STATUS)
		.map((status) => [status, `\`${STATUS[status][0]}\``, STATUS[status][1]]);
	if (errors.length) {
		out.push(
			'## Errors',
			'',
			'A failed request answers with one of these statuses and a body like `{"error": {"code": "not_found", "message": "Repository not found."}}`. See [errors](/reference/api/#errors).',
			'',
			table(['Status', 'Code', 'When'], errors),
			'',
		);
	}
	return out.join('\n');
}

/**
 * Writes every operation's page and returns the sidebar groups for them,
 * one per section of the API.
 */
export function generateApiReference() {
	const document = loadDocument();
	const all = operations(document);
	pages.clear();
	for (const operation of all) {
		const name = operation['x-operation'];
		// An operation's name links to its first address: the repository's.
		if (name && !pages.has(name)) pages.set(name, operation.slug);
	}

	rmSync(OUT, { recursive: true, force: true });
	for (const operation of all) {
		const file = join(root, 'src/content/docs', `${operation.slug}.md`);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, page(operation, all));
	}

	return document.tags
		.map((tag) => ({
			label: tag.name,
			items: all
				.filter((operation) => operation.tag === tag.name)
				.map((operation) => ({
					label: operation.summary,
					slug: operation.slug,
					badge: { text: operation.method, class: `g1t-method g1t-method-${operation.method.toLowerCase()}` },
				})),
		}))
		.filter((group) => group.items.length);
}
