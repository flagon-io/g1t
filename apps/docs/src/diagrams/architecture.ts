/**
 * The Architecture section's diagrams (content/docs/architecture). Each one
 * shows code that exists on main: when the code changes, change the
 * diagram in the same pull request, as its page says.
 */
import type { Graph, Sequence, Spec } from './engine.ts';

// ── Overview ───────────────────────────────────────────────────────────────

const CORE_X = [20, 206, 392, 578, 764];
const CORE_Y = [312, 364, 416, 468];
const core = (id: string, title: string, sub: string, col: number, row: number, tone?: 'accent') => ({
	id,
	title,
	sub,
	x: CORE_X[col],
	y: CORE_Y[row],
	w: 172,
	h: 44,
	tone,
});

const platformMap: Graph = {
	kind: 'graph',
	caption: 'g1t at a glance: clients reach four public Workers, which reach the core services through service bindings',
	width: 960,
	height: 664,
	groups: [
		{ x: 4, y: 4, w: 952, h: 92, label: 'Clients', tone: 'default' },
		{ x: 4, y: 140, w: 952, h: 96, label: 'Edge: the public Workers', tone: 'accent' },
		{ id: 'core', x: 4, y: 280, w: 952, h: 244, label: 'Core services: reached through service bindings' },
		{ id: 'platform', x: 4, y: 566, w: 952, h: 94, label: 'Platform: Cloudflare’s primitives, each behind a port' },
	],
	nodes: [
		{ id: 'browser', x: 16, y: 34, w: 168, h: 50, title: 'Browsers and apps', sub: 'site, desktop, phone', tone: 'external' },
		{ id: 'git', x: 206, y: 34, w: 168, h: 50, title: 'git', sub: 'clone, fetch, push', tone: 'external' },
		{ id: 'agents', x: 396, y: 34, w: 168, h: 50, title: 'Coding agents, CLI', sub: 'REST, MCP, OAuth', tone: 'external' },
		{ id: 'runners', x: 586, y: 34, w: 168, h: 50, title: 'Self-hosted runners', sub: 'outbound HTTPS only', tone: 'external' },
		{ id: 'visitors', x: 776, y: 34, w: 168, h: 50, title: 'Visitors to your apps', sub: '*.g1t.page, your domains', tone: 'external' },

		{ id: 'web', x: 111, y: 170, w: 168, h: 50, title: 'Site', sub: 'apps/web · g1t.sh', tone: 'accent' },
		{ id: 'status', x: 301, y: 170, w: 168, h: 50, title: 'Status', sub: 'apps/status', tone: 'accent' },
		{ id: 'api', x: 491, y: 170, w: 168, h: 50, title: 'API and MCP', sub: 'apps/api', tone: 'accent' },
		{ id: 'pages', x: 776, y: 170, w: 168, h: 50, title: 'Pages', sub: 'services/pages', tone: 'accent' },

		core('identity', 'identity', 'Rust', 0, 0),
		core('repos', 'repos', 'Rust', 1, 0),
		core('work', 'work', 'Rust', 2, 0),
		core('events', 'events', 'Rust · the bus', 3, 0, 'accent'),
		core('actions', 'actions', 'Rust', 4, 0),
		core('runner', 'runner', 'TypeScript · sandboxes', 0, 1),
		core('deployments', 'deployments', 'TypeScript', 1, 1),
		core('packages', 'packages', 'Rust', 2, 1),
		core('security', 'security', 'Rust', 3, 1),
		core('search', 'search', 'Rust', 4, 1),
		core('projects', 'projects', 'TypeScript', 0, 2),
		core('chat', 'chat', 'TypeScript', 1, 2),
		core('artifacts', 'artifacts', 'TypeScript', 2, 2),
		core('notify', 'notify', 'TypeScript', 3, 2),
		core('telemetry', 'telemetry', 'TypeScript', 4, 2),
		core('billing', 'billing', 'Rust', 0, 3),
		core('integrations', 'integrations', 'Rust', 1, 3),
		core('webhooks', 'webhooks', 'Rust', 2, 3),
		core('og', 'og', 'TypeScript · cards', 3, 3),

		{ id: 'd1', x: 13, y: 598, w: 144, h: 50, title: 'D1', sub: 'a database each', shape: 'store' },
		{ id: 'do', x: 171, y: 598, w: 144, h: 50, title: 'Durable Objects', sub: 'live rooms' },
		{ id: 'queues', x: 329, y: 598, w: 144, h: 50, title: 'Queues', sub: 'the event bus' },
		{ id: 'blobs', x: 487, y: 598, w: 144, h: 50, title: 'R2 and KV', sub: 'packs, packages, files', shape: 'store' },
		{ id: 'gitstore', x: 645, y: 598, w: 144, h: 50, title: 'Artifacts', sub: 'git repositories', shape: 'store' },
		{ id: 'containers', x: 803, y: 598, w: 144, h: 50, title: 'Containers', sub: 'one sandbox per job' },
	],
	edges: [
		{ from: 'browser', to: 'web', label: 'HTTPS' },
		{ from: 'git', to: 'web', label: 'smart HTTP' },
		{ from: 'agents', to: 'api', label: 'REST, MCP' },
		{ from: 'runners', to: 'api', label: 'long poll' },
		{ from: 'visitors', to: 'pages' },
		{ from: 'web', to: 'core', toAt: (195 - 480) / 952, label: '`POST /rpc/<method>`', tone: 'accent' },
		{ from: 'api', to: 'core', toAt: (575 - 480) / 952, label: '`POST /rpc/<method>`', tone: 'accent' },
		{ from: 'core', to: 'platform', label: 'bindings' },
	],
};

// ── Requests ───────────────────────────────────────────────────────────────

const pageRequest: Sequence = {
	kind: 'sequence',
	caption: 'A signed-in page: the viewer is resolved once, then every loader calls its service at the same time',
	actors: [
		{ id: 'browser', title: 'Browser', tone: 'external' },
		{ id: 'web', title: 'Site', sub: 'apps/web', tone: 'accent' },
		{ id: 'identity', title: 'identity', sub: 'services/identity' },
		{ id: 'work', title: 'work', sub: 'services/work' },
		{ id: 'repos', title: 'repos', sub: 'services/repos' },
	],
	steps: [
		{ from: 'browser', to: 'web', label: '`GET /acme/app/pull/12`, `g1t_session`' },
		{ from: 'web', to: 'identity', label: '`user_for_session`' },
		{ from: 'identity', to: 'web', label: 'the user: workspaces, roles, grants', reply: true },
		{ phase: 'Loaders start together' },
		{ from: 'web', to: 'work', label: '`POST /rpc/<method>` with the viewer' },
		{ from: 'web', to: 'repos', label: '`POST /rpc/<method>` with the viewer' },
		{ note: 'each decides with `access::can`, without asking identity', over: ['work', 'repos'] },
		{ from: 'work', to: 'web', label: '`{ ok, value }`, its D1 time', reply: true },
		{ from: 'repos', to: 'web', label: '`{ ok, value }`, its D1 time', reply: true },
		{ from: 'web', to: 'browser', label: 'HTML, with `Server-Timing`', reply: true },
	],
};

const apiRequest: Sequence = {
	kind: 'sequence',
	caption: 'An MCP tool call: the same token check, scopes, and service calls as the REST API',
	actors: [
		{ id: 'agent', title: 'Coding agent', sub: 'MCP client', tone: 'external' },
		{ id: 'api', title: 'API and MCP', sub: 'apps/api', tone: 'accent' },
		{ id: 'identity', title: 'identity', sub: 'services/identity' },
		{ id: 'work', title: 'work', sub: 'services/work' },
	],
	steps: [
		{ from: 'agent', to: 'api', label: '`tools/call` `pull_request`, `Bearer g1t_…`' },
		{ from: 'api', to: 'api', label: 'rate limit by token hash' },
		{ from: 'api', to: 'identity', label: '`user_for_access_token`' },
		{ from: 'identity', to: 'api', label: 'the user, the token’s scopes', reply: true },
		{ from: 'api', to: 'api', label: 'the gate: do the scopes allow it?' },
		{ from: 'api', to: 'work', label: '`POST /rpc/<method>` with the viewer' },
		{ from: 'work', to: 'api', label: '`{ ok, value }` in camelCase', reply: true },
		{ from: 'api', to: 'agent', label: 'JSON-RPC result, in snake_case', reply: true },
	],
};

// ── Git ────────────────────────────────────────────────────────────────────

const pushPath: Sequence = {
	kind: 'sequence',
	caption: 'A push: checked before anything is stored, answered as soon as the refs move, announced afterwards',
	width: 900,
	actors: [
		{ id: 'git', title: 'git', sub: 'your machine', tone: 'external' },
		{ id: 'web', title: 'Site', sub: 'g1t.sh', tone: 'accent' },
		{ id: 'repos', title: 'repos', sub: 'services/repos', tone: 'accent' },
		{ id: 'identity', title: 'identity' },
		{ id: 'work', title: 'work' },
		{ id: 'store', title: 'Artifacts', sub: 'the git store', tone: 'store' },
		{ id: 'events', title: 'events' },
	],
	steps: [
		{ from: 'git', to: 'web', label: '`POST …/git-receive-pack`' },
		{ from: 'web', to: 'repos', label: 'passed on whole' },
		{ from: 'repos', to: 'identity', label: '`user_for_git_credentials`' },
		{ from: 'identity', to: 'repos', label: 'the user, or no one', reply: true },
		{ from: 'repos', to: 'work', label: '`ref_rules`' },
		{ phase: 'Checks read the pack once, side by side' },
		{ from: 'repos', to: 'repos', label: 'workflow gate · rules · sizes · push protection' },
		{ from: 'repos', to: 'store', label: 'the pack, with a store credential' },
		{ from: 'store', to: 'repos', label: 'report-status', reply: true },
		{ from: 'repos', to: 'repos', label: 'bump `refs_version`' },
		{ from: 'repos', to: 'git', label: 'the report, with `Server-Timing`', reply: true },
		{ phase: 'After the answer, in waitUntil' },
		{ from: 'repos', to: 'store', label: '`log`: did each ref move?' },
		{ from: 'repos', to: 'events', label: 'publish `git.push`', async: true },
	],
};

const clonePath: Graph = {
	kind: 'graph',
	caption: 'A clone or fetch: answered from the nearest cache that can, and from the git store only when none can',
	width: 930,
	height: 316,
	nodes: [
		{ id: 'git', x: 10, y: 140, w: 130, title: 'git', sub: 'clone, fetch', tone: 'external' },
		{ id: 'web', x: 200, y: 140, w: 130, title: 'Site', sub: 'g1t.sh' },
		{ id: 'repos', x: 390, y: 140, w: 140, title: 'repos', sub: 'upload-pack', tone: 'accent' },
		{ id: 'colo', x: 740, y: 12, w: 180, title: 'Colo cache', sub: 'refs 60 s, objects forever' },
		{ id: 'kv', x: 740, y: 92, w: 180, title: 'KV, sealed', sub: 'refs, store credentials', shape: 'store' },
		{ id: 'packs', x: 740, y: 172, w: 180, title: 'R2 `g1t-git-packs`', sub: 'fresh-clone packs', shape: 'store' },
		{ id: 'store', x: 740, y: 252, w: 180, title: 'Artifacts', sub: 'the git store', shape: 'store' },
	],
	edges: [
		{ from: 'git', to: 'web' },
		{ from: 'web', to: 'repos', label: '`REPOS.fetch`' },
		...([
			['colo', 'ref listing, this colo', 38],
			['kv', 'ref listing, shared', 121],
			['packs', 'a fresh clone', 201],
			['store', 'everything else', 281],
		] as const).map(([to, label, y]) => ({
			from: 'repos',
			to,
			fromSide: 'right' as const,
			toSide: 'left' as const,
			bend: 570,
			label,
			labelAt: [655, y] as [number, number],
			tone: to === 'store' ? ('accent' as const) : undefined,
		})),
	],
};

// ── Events ─────────────────────────────────────────────────────────────────

const SUBSCRIBERS = ['work', 'runner', 'actions', 'webhooks', 'security', 'search', 'deployments', 'projects', 'repos', 'packages', 'billing', 'integrations', 'artifacts'];

const eventFanout: Graph = {
	kind: 'graph',
	caption: 'One publish, written once to the log, then copied to a queue for each service that subscribes',
	width: 960,
	height: 500,
	groups: [
		{ x: 4, y: 4, w: 176, h: 400, label: 'Publishers' },
		{ x: 778, y: 4, w: 178, h: 492, label: 'Subscriber queues', tone: 'accent' },
	],
	nodes: [
		{ id: 'p-repos', x: 16, y: 40, w: 152, h: 46, title: 'repos', sub: '`git.push`, `repo.*`' },
		{ id: 'p-work', x: 16, y: 110, w: 152, h: 46, title: 'work', sub: '`pull.*`, `work_item.*`' },
		{ id: 'p-actions', x: 16, y: 180, w: 152, h: 46, title: 'actions', sub: '`workflow.*`' },
		{ id: 'p-identity', x: 16, y: 250, w: 152, h: 46, title: 'identity', sub: '`workspace.*`' },
		{ id: 'p-more', x: 16, y: 320, w: 152, h: 46, title: 'and the rest', sub: 'any service' },
		{ id: 'publish', x: 222, y: 180, w: 150, h: 46, title: 'events', sub: '`publish` → `sendBatch`', tone: 'accent' },
		{ id: 'bus', x: 410, y: 180, w: 150, h: 46, title: 'Queue `g1t-events`', sub: 'batches of 100' },
		{ id: 'deliver', x: 600, y: 180, w: 150, h: 46, title: 'events', sub: '`deliver`', tone: 'accent' },
		{ id: 'log', x: 600, y: 40, w: 150, h: 50, title: 'D1 `g1t-events`', sub: 'the log, by `seq`', shape: 'store' },
		{ id: 'notify', x: 600, y: 320, w: 150, h: 46, title: 'notify', sub: 'live pages, inbox' },
		{ id: 'dlq', x: 410, y: 320, w: 150, h: 46, title: 'Dead letters', sub: '`g1t-events-dlq`', tone: 'warn' },
		...SUBSCRIBERS.map((name, i) => ({ id: `s-${name}`, x: 790, y: 40 + i * 35, w: 154, h: 29, title: name })),
	],
	edges: [
		...['p-repos', 'p-work', 'p-actions', 'p-identity', 'p-more'].map((from) => ({ from, to: 'publish', fromSide: 'right' as const, toSide: 'left' as const, bend: 196 })),
		{ from: 'publish', to: 'bus', async: true },
		{ from: 'bus', to: 'deliver', async: true },
		{ from: 'deliver', to: 'log', label: '`INSERT OR IGNORE`' },
		{ from: 'deliver', to: 'notify', label: '`repo_changed`' },
		{ from: 'bus', to: 'dlq', label: 'after 3 tries', async: true, tone: 'warn' },
		...SUBSCRIBERS.map((name) => ({ from: 'deliver', to: `s-${name}`, fromSide: 'right' as const, toSide: 'left' as const, bend: 770, async: true })),
	],
};

const followEvents: Sequence = {
	kind: 'sequence',
	caption: 'Following a repository’s events: a long poll that resumes from the last event it saw',
	width: 680,
	actors: [
		{ id: 'cli', title: 'g1t CLI', sub: '`work events --follow`', tone: 'external' },
		{ id: 'api', title: 'API', sub: 'apps/api', tone: 'accent' },
		{ id: 'events', title: 'events', sub: 'services/events' },
	],
	steps: [
		{ from: 'cli', to: 'api', label: '`list_events` `after=evt_…`, `wait=25`' },
		{ from: 'api', to: 'events', label: '`list` after the cursor' },
		{ from: 'events', to: 'api', label: 'nothing yet', reply: true },
		{ note: 'asks again about once a second, for up to 25 s', over: ['api', 'events'] },
		{ from: 'api', to: 'events', label: '`list` after the cursor' },
		{ from: 'events', to: 'api', label: 'events, in `seq` order', reply: true },
		{ from: 'api', to: 'cli', label: 'events, oldest first', reply: true },
		{ from: 'cli', to: 'cli', label: 'ask again after the last id' },
	],
};

// ── Work ───────────────────────────────────────────────────────────────────

const mergeQueue: Graph = {
	kind: 'graph',
	caption: 'The merge queue: each entry is tested on top of the entries ahead of it, all at once, and lands in order',
	width: 920,
	height: 318,
	nodes: [
		{ id: 'main', x: 10, y: 40, w: 140, title: '`main`', sub: 'where it stands', tone: 'store' },
		{ id: 'c1', x: 200, y: 40, w: 160, title: '`g1t-queue/…41`', sub: 'main + #41', tone: 'accent' },
		{ id: 'c2', x: 380, y: 40, w: 160, title: '`g1t-queue/…42`', sub: '+ #41 + #42', tone: 'accent' },
		{ id: 'c3', x: 560, y: 40, w: 160, title: '`g1t-queue/…43`', sub: '+ #41 + #42 + #43', tone: 'accent' },
		{ id: 'c4', x: 740, y: 40, w: 170, title: '`g1t-queue/…44`', sub: '+ #41 + #42 + #44', tone: 'accent' },
		{ id: 'k1', x: 200, y: 150, w: 160, h: 44, title: 'required checks pass', tone: 'success' },
		{ id: 'k2', x: 380, y: 150, w: 160, h: 44, title: 'required checks pass', tone: 'success' },
		{ id: 'k3', x: 560, y: 150, w: 160, h: 44, title: 'a required check fails', tone: 'warn' },
		{ id: 'k4', x: 740, y: 150, w: 170, h: 44, title: 'required checks pass', tone: 'success' },
		{ id: 'l1', x: 200, y: 254, w: 160, h: 44, title: '#41 lands first' },
		{ id: 'l2', x: 380, y: 254, w: 160, h: 44, title: '#42 lands next' },
		{ id: 'l3', x: 560, y: 254, w: 160, h: 44, title: '#43 leaves the queue', tone: 'warn' },
		{ id: 'l4', x: 740, y: 254, w: 170, h: 44, title: '#44 lands third' },
	],
	edges: [
		{ from: 'main', to: 'c1' },
		{ from: 'c1', to: 'c2' },
		{ from: 'c2', to: 'c3' },
		{ from: 'c2', to: 'c4', fromSide: 'top', toSide: 'top', bend: 14, async: true, label: 'retested without #43', labelAt: [640, 14] },
		{ from: 'c1', to: 'k1', label: '`merge_group`' },
		{ from: 'c2', to: 'k2', label: '`merge_group`' },
		{ from: 'c3', to: 'k3', label: '`merge_group`', tone: 'warn' },
		{ from: 'c4', to: 'k4', label: '`merge_group`' },
		{ from: 'k1', to: 'l1', tone: 'success' },
		{ from: 'k2', to: 'l2', tone: 'success' },
		{ from: 'k3', to: 'l3', tone: 'warn' },
		{ from: 'k4', to: 'l4', tone: 'success' },
	],
};

const coordination: Sequence = {
	kind: 'sequence',
	caption: 'Two agents on one repository: sessions and claims are advisory, and each learns of the other from events',
	width: 860,
	actors: [
		{ id: 'a', title: 'Agent A', sub: 'its own harness', tone: 'external' },
		{ id: 'api', title: 'API and MCP', sub: 'apps/api' },
		{ id: 'work', title: 'work', sub: 'services/work', tone: 'accent' },
		{ id: 'events', title: 'events' },
		{ id: 'b', title: 'Agent B', sub: '`--follow`', tone: 'external' },
	],
	steps: [
		{ from: 'a', to: 'api', label: '`session` `start`, `harness_session_id`' },
		{ from: 'api', to: 'work', label: 'start, idempotent on that id' },
		{ from: 'a', to: 'api', label: '`work_item` `work` #12' },
		{ from: 'api', to: 'work', label: 'item, repos, claims, sessions, pulls, blockers' },
		{ from: 'a', to: 'api', label: '`work_item` `claim` #12' },
		{ from: 'api', to: 'work', label: 'claim: 30 min unless renewed' },
		{ from: 'work', to: 'events', label: '`work.claimed`', async: true },
		{ from: 'api', to: 'b', label: 'its `list_events` long poll returns `work.claimed`', reply: true },
		{ note: 'B may still claim #12; it is told about A, and nothing is refused', over: ['work', 'b'] },
		{ phase: 'While A works' },
		{ from: 'a', to: 'api', label: 'heartbeat, entries: renew the claim' },
		{ note: 'quiet for 15 min: idle; for 2 h: ended; noticed on the next read', over: ['api', 'work'] },
	],
};

// ── Compute ────────────────────────────────────────────────────────────────

const actionsJob: Sequence = {
	kind: 'sequence',
	caption: 'A workflow job on g1t’s runners, from the push that starts it to the status on the commit',
	width: 900,
	actors: [
		{ id: 'events', title: 'events' },
		{ id: 'actions', title: 'actions', sub: 'services/actions', tone: 'accent' },
		{ id: 'runner', title: 'runner', sub: 'services/runner' },
		{ id: 'sandbox', title: 'Sandbox', sub: '`g1t-runner`', tone: 'success' },
		{ id: 'api', title: 'API', sub: 'apps/api' },
		{ id: 'work', title: 'work', sub: 'services/work' },
	],
	steps: [
		{ from: 'events', to: 'actions', label: '`git.push` on `g1t-events-actions`', async: true },
		{ from: 'actions', to: 'actions', label: 'match workflows, plan the jobs' },
		{ from: 'actions', to: 'work', label: '`set_commit_status` pending' },
		{ from: 'actions', to: 'runner', label: '`start_actions_job`' },
		{ from: 'runner', to: 'sandbox', label: 'a Container for this job alone' },
		{ phase: 'The job runs' },
		{ from: 'sandbox', to: 'api', label: '`POST /actions/jobs/{job}`: steps, logs' },
		{ from: 'api', to: 'actions', label: '`job_report`' },
		{ from: 'api', to: 'sandbox', label: 'go on, or cancel', reply: true },
		{ note: 'HTTP(S) leaves only through the runner’s egress handler', over: ['runner', 'sandbox'] },
		{ phase: 'The job ends' },
		{ from: 'actions', to: 'work', label: '`set_commit_status` success or failure' },
		{ from: 'actions', to: 'events', label: '`workflow.completed`', async: true },
	],
};

const sandboxes: Graph = {
	kind: 'graph',
	caption: 'Where a job runs: in a Container on g1t’s runners, or inside three walls on a machine of yours',
	width: 940,
	height: 330,
	groups: [
		{ x: 4, y: 4, w: 452, h: 322, label: 'g1t’s runners: Cloudflare Containers', tone: 'success' },
		{ x: 24, y: 40, w: 230, h: 190, label: 'one sandbox per job' },
		{ x: 474, y: 4, w: 462, h: 322, label: 'Your machine: three walls', tone: 'success' },
		{ x: 490, y: 40, w: 300, h: 274, label: 'VM: WSL2, vfkit or QEMU' },
		{ id: 'sysbox', x: 506, y: 76, w: 268, h: 222, label: 'Sysbox container: `g1t-runner`' },
	],
	nodes: [
		{ id: 'h-runner', x: 44, y: 78, w: 190, title: '`g1t-runner`', sub: 'does one job, exits' },
		{ id: 'h-docker', x: 44, y: 156, w: 190, title: 'its own dockerd', sub: 'when `DOCKER=on`' },
		{ id: 'egress', x: 290, y: 78, w: 150, title: 'egress handler', sub: 'all HTTP(S) leaves here', tone: 'accent' },
		{ id: 'hosts', x: 290, y: 250, w: 150, title: 'allowed hosts', sub: 'registries, your APIs', tone: 'external' },
		{ id: 'job', x: 526, y: 116, w: 228, title: 'job container', sub: 'new for every job' },
		{ id: 'dockerd', x: 526, y: 210, w: 228, title: 'its own dockerd', sub: 'never the host’s `docker.sock`' },
		{ id: 'api', x: 802, y: 160, w: 130, title: 'api.g1t.sh', sub: 'long poll, outbound', tone: 'external' },
	],
	edges: [
		{ from: 'h-runner', to: 'egress' },
		{ from: 'egress', to: 'hosts', label: '`g1tsec_…` → the secret' },
		{ from: 'sysbox', to: 'api', fromSide: 'right', toSide: 'left' },
	],
};

const deploymentPath: Graph = {
	kind: 'graph',
	caption: 'Deployments: built in a sandbox, uploaded to a dispatch namespace, served by one Worker that looks up the app by hostname',
	width: 940,
	height: 330,
	nodes: [
		{ id: 'repos', x: 10, y: 30, w: 160, title: 'repos', sub: 'a push to a branch' },
		{ id: 'deployments', x: 260, y: 30, w: 170, title: 'deployments', sub: 'services/deployments', tone: 'accent' },
		{ id: 'build', x: 520, y: 30, w: 180, title: 'build sandbox', sub: '`g1t-runner`, `MODE=deploy`', tone: 'success' },
		{ id: 'kv', x: 260, y: 150, w: 170, title: 'KV `g1t-domains`', sub: 'hostname → app', shape: 'store' },
		{ id: 'wfp', x: 520, y: 150, w: 180, title: 'dispatch namespace', sub: '`g1t-deployments`', tone: 'accent' },
		{ id: 'telemetry', x: 760, y: 150, w: 170, title: 'telemetry', sub: 'tail events, per project' },
		{ id: 'visitors', x: 10, y: 268, w: 160, title: 'Visitors', sub: '`*.g1t.page`, your domain', tone: 'external' },
		{ id: 'pages', x: 260, y: 268, w: 170, title: 'pages', sub: 'services/pages', tone: 'accent' },
		{ id: 'otel', x: 760, y: 268, w: 170, title: 'Your software', sub: 'OTLP to otel.g1t.sh', tone: 'external' },
	],
	edges: [
		{ from: 'repos', to: 'deployments', label: '`git.push`', async: true },
		{ from: 'deployments', to: 'build', label: '`start_deploy`' },
		{ from: 'deployments', to: 'wfp', fromSide: 'bottom', toSide: 'top', fromAt: 0.4, toAt: -0.4, bend: 116, label: 'the built Worker' },
		{ from: 'deployments', to: 'kv', fromAt: -0.2, toAt: -0.2, label: 'domains' },
		{ from: 'visitors', to: 'pages' },
		{ from: 'pages', to: 'kv', label: 'which app?' },
		{ from: 'pages', to: 'wfp', fromSide: 'right', toSide: 'bottom', label: '`APPS.get(app)`' },
		{ from: 'wfp', to: 'telemetry', async: true },
		{ from: 'otel', to: 'telemetry', label: 'OTLP' },
	],
};

// ── Data and access ────────────────────────────────────────────────────────

/** Each port: its adapter on g1t.sh, the port, and its adapter when self-hosted, each with a second line. */
const PORT_ROWS: [string, string, string, string, string, string][] = [
	['Cloudflare Artifacts', 'namespaces, sharded', '`GitStore`', 'services/repos', 'gitstore', 'bare repositories, `git http-backend`'],
	['R2', 'a bucket per use', '`BlobStore`', 'crates/blobstore', 'S3', 'RustFS, MinIO, Ceph, AWS'],
	['Email Sending', 'from g1t.sh', '`EMAIL`', 'a `send_email` binding', 'the mail Worker', 'Mailpit, then your SMTP'],
	['Containers', 'services/runner', '`RUNNER`', 'a service binding', 'the off Worker', 'answers that it is off'],
	['D1, KV, Queues, DOs', 'Cloudflare’s', 'Workers bindings', 'unchanged code', 'workerd', 'SQLite files on a volume'],
];

const portsAndAdapters: Graph = {
	kind: 'graph',
	caption: 'Ports and adapters: the same service code, with a Cloudflare adapter on g1t.sh and an open one when you run it yourself',
	width: 940,
	height: 400,
	groups: [
		{ x: 6, y: 4, w: 262, h: 392, label: 'On g1t.sh' },
		{ x: 662, y: 4, w: 272, h: 392, label: 'Self-hosted, in Docker Compose', tone: 'success' },
	],
	nodes: PORT_ROWS.flatMap(([hosted, hostedSub, port, portSub, self, selfSub], i) => {
		const y = 40 + i * 72;
		return [
			{ id: `h${i}`, x: 22, y, w: 230, h: 50, title: hosted, sub: hostedSub },
			{ id: `p${i}`, x: 352, y, w: 230, h: 50, title: port, sub: portSub, tone: 'accent' as const },
			{ id: `s${i}`, x: 678, y, w: 240, h: 50, title: self, sub: selfSub, tone: 'success' as const },
		];
	}),
	edges: PORT_ROWS.flatMap((_, i) => [
		{ from: `p${i}`, to: `h${i}` },
		{ from: `p${i}`, to: `s${i}` },
	]),
};

const identityFlow: Graph = {
	kind: 'graph',
	caption: 'Every credential becomes the same viewer, resolved once per request; each service decides for itself',
	width: 940,
	height: 340,
	groups: [{ x: 4, y: 4, w: 226, h: 332, label: 'Credentials' }],
	nodes: [
		{ id: 'cookie', x: 18, y: 32, w: 198, h: 50, title: 'Session cookie', sub: '`g1t_session`, the site', tone: 'external' },
		{ id: 'pat', x: 18, y: 92, w: 198, h: 50, title: 'Access token', sub: '`g1t_…`, scoped', tone: 'external' },
		{ id: 'oauth', x: 18, y: 152, w: 198, h: 50, title: 'OAuth token', sub: 'MCP clients, apps', tone: 'external' },
		{ id: 'job', x: 18, y: 212, w: 198, h: 50, title: 'Job or run token', sub: 'one workflow job', tone: 'external' },
		{ id: 'gitpw', x: 18, y: 272, w: 198, h: 50, title: 'git password', sub: 'refused with 2FA on', tone: 'external' },
		{ id: 'identity', x: 286, y: 146, w: 160, h: 62, title: 'identity', sub: '`user_for_…`', tone: 'accent' },
		{ id: 'viewer', x: 556, y: 146, w: 170, h: 62, title: 'the viewer', sub: 'kind, workspaces, grants' },
		{ id: 'services', x: 836, y: 146, w: 98, h: 62, title: 'services', sub: '`access::can`', tone: 'accent' },
	],
	edges: [
		...['cookie', 'pat', 'oauth', 'job', 'gitpw'].map((from) => ({ from, to: 'identity', fromSide: 'right' as const, toSide: 'left' as const, bend: 256 })),
		{ from: 'identity', to: 'viewer', label: 'once per request' },
		{ from: 'viewer', to: 'services', label: 'in every RPC body' },
	],
};

// ── Shipping ───────────────────────────────────────────────────────────────

const STAGES: [string, string, string][] = [
	['push', 'a push to `main`', ''],
	['check', 'check, plan', 'manifest, tests'],
	['migrate', 'migrations', 'every pending one'],
	['core', 'core', 'the services'],
	['edge', 'edge', 'api, pages, status'],
	['front', 'front', 'site, sudo, docs'],
	['smoke', 'smoke', 'sign-in works'],
];

const deployStages: Graph = {
	kind: 'graph',
	caption: 'How g1t ships itself: each stage starts only when the one before it succeeded',
	width: 940,
	height: 140,
	groups: [{ x: 140, y: 4, w: 796, h: 132, label: '`.g1t/workflows/deploy.yml`, on g1t Actions', tone: 'accent' }],
	nodes: STAGES.map(([id, title, sub], i) => ({
		id,
		x: 10 + i * 133,
		y: 56,
		w: 118,
		h: 50,
		title,
		sub: sub || undefined,
		tone: id === 'push' ? ('external' as const) : id === 'smoke' ? ('success' as const) : undefined,
	})),
	edges: STAGES.slice(1).map(([id], i) => ({ from: STAGES[i][0], to: id })),
};

export const ARCHITECTURE: Record<string, Spec> = {
	'platform-map': platformMap,
	'page-request': pageRequest,
	'api-request': apiRequest,
	'push-path': pushPath,
	'clone-path': clonePath,
	'event-fanout': eventFanout,
	'follow-events': followEvents,
	'merge-queue': mergeQueue,
	coordination,
	'actions-job': actionsJob,
	sandboxes,
	'deployment-path': deploymentPath,
	'ports-and-adapters': portsAndAdapters,
	'identity-flow': identityFlow,
	'deploy-stages': deployStages,
};
