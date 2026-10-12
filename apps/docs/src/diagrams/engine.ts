/**
 * The docs' diagrams, drawn from data. A diagram is a spec in
 * src/diagrams/*.ts; <Diagram name="..."> (components/Diagram.astro) draws
 * it as an inline SVG coloured by the g1t tokens, so it follows the light
 * and dark themes, and each page's Markdown twin ([...slug].md.ts) writes
 * the same spec out as text. Change the spec, and the picture and the text
 * change together.
 *
 * Two kinds:
 *
 * - a graph: boxes at fixed places, grouped in frames, joined by arrows
 *   routed at right angles between their sides;
 * - a sequence: actors across the top, numbered messages down the page,
 *   which the prose refers to by number.
 *
 * Text in labels may hold `code` in backticks, drawn in the mono face.
 */

/** How a box or an arrow is coloured. */
export type Tone = 'default' | 'accent' | 'store' | 'external' | 'success' | 'warn';

export type Side = 'top' | 'bottom' | 'left' | 'right';

export type GraphNode = {
	id: string;
	x: number;
	y: number;
	w?: number;
	h?: number;
	title: string;
	/** A second line, smaller: usually a path in the repository. */
	sub?: string;
	tone?: Tone;
	/** A database or a bucket, drawn as a cylinder. */
	shape?: 'box' | 'store';
};

export type GraphGroup = {
	/** Set to let arrows start or end on the frame itself. */
	id?: string;
	x: number;
	y: number;
	w: number;
	h: number;
	label: string;
	tone?: Tone;
};

export type GraphEdge = {
	from: string;
	to: string;
	label?: string;
	/** Asynchronous: an event, a queue, a stream. Drawn dashed. */
	async?: boolean;
	tone?: Tone;
	fromSide?: Side;
	toSide?: Side;
	/** Where along the side the arrow leaves or arrives, -0.5 to 0.5 of its length. */
	fromAt?: number;
	toAt?: number;
	/** Where the bend sits, for an arrow that turns twice: an x or a y. */
	bend?: number;
	/** Arrowheads at both ends. */
	both?: boolean;
	/** Where the label's centre goes, when the middle of the longest leg is a bad place. */
	labelAt?: [number, number];
};

export type Graph = {
	kind: 'graph';
	caption: string;
	width: number;
	height: number;
	groups?: GraphGroup[];
	nodes: GraphNode[];
	edges: GraphEdge[];
};

export type SequenceActor = { id: string; title: string; sub?: string; tone?: Tone };

export type SequenceStep =
	/** A message from one actor to another, or to itself. */
	| { from: string; to: string; label: string; reply?: boolean; async?: boolean }
	/** A note across one or more actors. */
	| { note: string; over: string[] }
	/** A line across the whole diagram, naming a phase. */
	| { phase: string };

export type Sequence = {
	kind: 'sequence';
	caption: string;
	actors: SequenceActor[];
	steps: SequenceStep[];
	/** Wider than the default 760 when there are many actors. */
	width?: number;
};

export type Spec = Graph | Sequence;

// ── Text ───────────────────────────────────────────────────────────────────

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Text with `code` spans as tspans in the mono face. */
function rich(text: string): string {
	return text
		.split('`')
		.map((part, i) => (i % 2 ? `<tspan class="d-mono">${esc(part)}</tspan>` : esc(part)))
		.join('');
}

/** About how wide a label is, in user units, at the given size: wide enough for a backing pill. */
export function textWidth(text: string, size: number): number {
	let width = 0;
	text.split('`').forEach((part, i) => {
		width += part.length * size * (i % 2 ? 0.6 : 0.54);
	});
	return width;
}

/** Text without its backticks, for the Markdown twin and the accessible description. */
const plain = (text: string) => text.replace(/`/g, '');

// ── Graph ──────────────────────────────────────────────────────────────────

const NODE_W = 150;
const NODE_H = 52;

type Box = { x: number; y: number; w: number; h: number };

function box(node: GraphNode): Box {
	return { x: node.x, y: node.y, w: node.w ?? NODE_W, h: node.h ?? NODE_H };
}

function anchor(b: Box, side: Side, at = 0): [number, number] {
	switch (side) {
		case 'top':
			return [b.x + b.w / 2 + at * b.w, b.y];
		case 'bottom':
			return [b.x + b.w / 2 + at * b.w, b.y + b.h];
		case 'left':
			return [b.x, b.y + b.h / 2 + at * b.h];
		case 'right':
			return [b.x + b.w, b.y + b.h / 2 + at * b.h];
	}
}

/** The sides an arrow leaves and enters by, when the spec does not say. */
function sides(a: Box, b: Box): [Side, Side] {
	if (b.y >= a.y + a.h) return ['bottom', 'top'];
	if (b.y + b.h <= a.y) return ['top', 'bottom'];
	return b.x >= a.x ? ['right', 'left'] : ['left', 'right'];
}

const vertical = (side: Side) => side === 'top' || side === 'bottom';

/** The corners an arrow passes through, at right angles. */
export function route(edge: GraphEdge, a: Box, b: Box): [number, number][] {
	const [auto1, auto2] = sides(a, b);
	const s1 = edge.fromSide ?? auto1;
	const s2 = edge.toSide ?? auto2;
	const [x1, y1] = anchor(a, s1, edge.fromAt);
	const [x2, y2] = anchor(b, s2, edge.toAt);
	if (vertical(s1) && vertical(s2)) {
		if (Math.abs(x1 - x2) < 0.5) return [[x1, y1], [x2, y2]];
		const ym = edge.bend ?? (y1 + y2) / 2;
		return [[x1, y1], [x1, ym], [x2, ym], [x2, y2]];
	}
	if (!vertical(s1) && !vertical(s2)) {
		if (Math.abs(y1 - y2) < 0.5) return [[x1, y1], [x2, y2]];
		const xm = edge.bend ?? (x1 + x2) / 2;
		return [[x1, y1], [xm, y1], [xm, y2], [x2, y2]];
	}
	// One of each: a single turn.
	return vertical(s1) ? [[x1, y1], [x1, y2], [x2, y2]] : [[x1, y1], [x2, y1], [x2, y2]];
}

/** A path through the points with its corners rounded. */
function rounded(points: [number, number][], radius = 7): string {
	let d = `M${points[0][0]},${points[0][1]}`;
	for (let i = 1; i < points.length - 1; i++) {
		const [px, py] = points[i - 1];
		const [cx, cy] = points[i];
		const [nx, ny] = points[i + 1];
		const inLen = Math.hypot(cx - px, cy - py);
		const outLen = Math.hypot(nx - cx, ny - cy);
		const r = Math.min(radius, inLen / 2, outLen / 2);
		const ax = cx - ((cx - px) / inLen) * r;
		const ay = cy - ((cy - py) / inLen) * r;
		const bx = cx + ((nx - cx) / outLen) * r;
		const by = cy + ((ny - cy) / outLen) * r;
		d += ` L${ax},${ay} Q${cx},${cy} ${bx},${by}`;
	}
	const [lx, ly] = points[points.length - 1];
	return `${d} L${lx},${ly}`;
}

/** The middle of the arrow's longest leg. */
function labelPoint(points: [number, number][]): [number, number] {
	let best = 0;
	let at: [number, number] = points[0];
	for (let i = 1; i < points.length; i++) {
		const [ax, ay] = points[i - 1];
		const [bx, by] = points[i];
		const len = Math.hypot(bx - ax, by - ay);
		if (len > best) {
			best = len;
			at = [(ax + bx) / 2, (ay + by) / 2];
		}
	}
	return at;
}

function pill(x: number, y: number, text: string, size: number, cls: string): string {
	const w = textWidth(text, size) + 12;
	const h = size + 8;
	return (
		`<rect class="${cls}-bg" x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2}"/>` +
		`<text class="${cls}" x="${x}" y="${y}" font-size="${size}" text-anchor="middle" dominant-baseline="central">${rich(text)}</text>`
	);
}

function markers(id: string): string {
	const tones: Tone[] = ['default', 'accent', 'success', 'warn'];
	return (
		'<defs>' +
		tones
			.map(
				(tone) =>
					`<marker id="${id}-arrow-${tone}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
					`<path d="M1,1 L9,5 L1,9 z" class="d-head d-tone-${tone}"/></marker>`,
			)
			.join('') +
		'</defs>'
	);
}

function renderNode(node: GraphNode): string {
	const b = box(node);
	const tone = node.tone ?? (node.shape === 'store' ? 'store' : 'default');
	let shape: string;
	if (node.shape === 'store') {
		// A cylinder: the body, then the rim of its top.
		const ry = 6;
		shape =
			`<path class="d-node d-tone-${tone}" d="M${b.x},${b.y + ry} A${b.w / 2},${ry} 0 0 1 ${b.x + b.w},${b.y + ry} V${b.y + b.h - ry} A${b.w / 2},${ry} 0 0 1 ${b.x},${b.y + b.h - ry} Z"/>` +
			`<path class="d-rim d-tone-${tone}" d="M${b.x},${b.y + ry} A${b.w / 2},${ry} 0 0 0 ${b.x + b.w},${b.y + ry}"/>`;
	} else {
		shape = `<rect class="d-node d-tone-${tone}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="9"/>`;
	}
	const cx = b.x + b.w / 2;
	const top = node.shape === 'store' ? 6 : 0;
	const cy = b.y + top / 2 + b.h / 2;
	const text = node.sub
		? `<text class="d-title" x="${cx}" y="${cy - 8}" text-anchor="middle" dominant-baseline="central">${rich(node.title)}</text>` +
			`<text class="d-sub" x="${cx}" y="${cy + 9}" text-anchor="middle" dominant-baseline="central">${rich(node.sub)}</text>`
		: `<text class="d-title" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central">${rich(node.title)}</text>`;
	return `<g class="d-box">${shape}${text}</g>`;
}

export function renderGraph(id: string, graph: Graph): string {
	const boxes = new Map<string, Box>(graph.nodes.map((node) => [node.id, box(node)]));
	for (const g of graph.groups ?? []) if (g.id) boxes.set(g.id, g);
	const groups = (graph.groups ?? [])
		.map(
			(g) =>
				`<rect class="d-group d-tone-${g.tone ?? 'default'}" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="14"/>` +
				`<text class="d-group-label d-tone-${g.tone ?? 'default'}" x="${g.x + 14}" y="${g.y + 18}" dominant-baseline="central">${rich(g.label)}</text>`,
		)
		.join('');
	const edges: string[] = [];
	const labels: string[] = [];
	for (const edge of graph.edges) {
		const from = boxes.get(edge.from);
		const to = boxes.get(edge.to);
		if (!from || !to) throw new Error(`Diagram ${id}: an arrow joins ${edge.from} to ${edge.to}, and one of them is not a box.`);
		const points = route(edge, from, to);
		const tone = edge.tone ?? 'default';
		const marker = `url(#${id}-arrow-${tone})`;
		edges.push(
			`<path class="d-edge d-tone-${tone}${edge.async ? ' d-async' : ''}" d="${rounded(points)}" marker-end="${marker}"${edge.both ? ` marker-start="${marker}"` : ''}/>`,
		);
		if (edge.label) {
			const [lx, ly] = edge.labelAt ?? labelPoint(points);
			labels.push(pill(lx, ly, edge.label, 10.5, 'd-label'));
		}
	}
	return (
		`<svg viewBox="0 0 ${graph.width} ${graph.height}" width="${graph.width}" height="${graph.height}" role="img" aria-labelledby="${id}-title ${id}-desc" class="d-svg">` +
		`<title id="${id}-title">${esc(graph.caption)}</title>` +
		`<desc id="${id}-desc">${esc(describe(graph))}</desc>` +
		markers(id) +
		groups +
		edges.join('') +
		graph.nodes.map(renderNode).join('') +
		labels.join('') +
		'</svg>'
	);
}

// ── Sequence ───────────────────────────────────────────────────────────────

const SEQ_HEAD = 50;
const SEQ_ROW = 42;

export function renderSequence(id: string, seq: Sequence): string {
	const width = seq.width ?? 760;
	const margin = 16;
	const col = (width - margin * 2) / seq.actors.length;
	const xs = new Map(seq.actors.map((actor, i) => [actor.id, margin + col * (i + 0.5)]));
	const at = (actor: string) => {
		const x = xs.get(actor);
		if (x === undefined) throw new Error(`Diagram ${id}: no actor named ${actor}.`);
		return x;
	};
	const headW = Math.min(col - 14, 168);

	const body: string[] = [];
	let y = SEQ_HEAD + 26;
	let n = 0;
	for (const step of seq.steps) {
		if ('phase' in step) {
			y += 4;
			body.push(`<line class="d-phase" x1="${margin}" y1="${y}" x2="${width - margin}" y2="${y}"/>`);
			body.push(pill(width / 2, y, step.phase, 10.5, 'd-phase-label'));
			y += 30;
			continue;
		}
		if ('note' in step) {
			const sx = step.over.map(at);
			const left = Math.max(margin, Math.min(...sx) - Math.min(col / 2 - 8, 92));
			const right = Math.min(width - margin, Math.max(...sx) + Math.min(col / 2 - 8, 92));
			body.push(`<rect class="d-note" x="${left}" y="${y - 12}" width="${right - left}" height="26" rx="6"/>`);
			body.push(`<text class="d-note-text" x="${(left + right) / 2}" y="${y + 1}" text-anchor="middle" dominant-baseline="central">${rich(step.note)}</text>`);
			y += 38;
			continue;
		}
		n++;
		const x1 = at(step.from);
		const x2 = at(step.to);
		const cls = `d-msg${step.reply || step.async ? ' d-async' : ''}${step.reply ? ' d-reply' : ''}`;
		const marker = `url(#${id}-arrow-${step.reply ? 'default' : 'accent'})`;
		if (x1 === x2) {
			// To itself: a loop out to the right and back.
			const loop = 30;
			body.push(`<path class="${cls}" d="M${x1},${y} H${x1 + loop} V${y + 16} H${x1 + 3}" marker-end="${marker}"/>`);
			body.push(badge(x1 - 14, y + 8, n));
			body.push(`<text class="d-msg-label" x="${x1 + loop + 8}" y="${y + 8}" dominant-baseline="central">${rich(step.label)}</text>`);
			y += SEQ_ROW + 10;
			continue;
		}
		const dir = x2 > x1 ? 1 : -1;
		body.push(`<line class="${cls}" x1="${x1}" y1="${y}" x2="${x2 - dir * 3}" y2="${y}" marker-end="${marker}"/>`);
		body.push(`<text class="d-msg-label" x="${(x1 + x2) / 2}" y="${y - 9}" text-anchor="middle">${rich(step.label)}</text>`);
		body.push(badge(x1 - dir * 13, y, n));
		y += SEQ_ROW;
	}
	const height = y + 4;

	const heads = seq.actors
		.map((actor) => {
			const x = at(actor.id);
			const tone = actor.tone ?? 'default';
			const title = actor.sub
				? `<text class="d-title" x="${x}" y="${SEQ_HEAD / 2 - 8}" text-anchor="middle" dominant-baseline="central">${rich(actor.title)}</text>` +
					`<text class="d-sub" x="${x}" y="${SEQ_HEAD / 2 + 9}" text-anchor="middle" dominant-baseline="central">${rich(actor.sub)}</text>`
				: `<text class="d-title" x="${x}" y="${SEQ_HEAD / 2}" text-anchor="middle" dominant-baseline="central">${rich(actor.title)}</text>`;
			return (
				`<line class="d-lifeline" x1="${x}" y1="${SEQ_HEAD}" x2="${x}" y2="${height}"/>` +
				`<rect class="d-node d-tone-${tone}" x="${x - headW / 2}" y="1" width="${headW}" height="${SEQ_HEAD - 2}" rx="9"/>` +
				title
			);
		})
		.join('');

	return (
		`<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="${id}-title ${id}-desc" class="d-svg">` +
		`<title id="${id}-title">${esc(seq.caption)}</title>` +
		`<desc id="${id}-desc">${esc(describe(seq))}</desc>` +
		markers(id) +
		heads +
		body.join('') +
		'</svg>'
	);
}

function badge(x: number, y: number, n: number): string {
	return (
		`<circle class="d-badge" cx="${x}" cy="${y}" r="8"/>` +
		`<text class="d-badge-text" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central">${n}</text>`
	);
}

// ── As text ────────────────────────────────────────────────────────────────

/**
 * The diagram as Markdown: for the page's Markdown twin, which agents and
 * "Copy page" read. A graph lists its boxes by frame, then its arrows; a
 * sequence lists its messages with the numbers the picture shows.
 */
export function toMarkdown(spec: Spec): string {
	const lines = [`**Diagram: ${spec.caption}**`, ''];
	if (spec.kind === 'sequence') {
		const name = new Map(spec.actors.map((a) => [a.id, plain(a.title)]));
		let n = 0;
		for (const step of spec.steps) {
			if ('phase' in step) lines.push('', `*${plain(step.phase)}*`, '');
			else if ('note' in step) lines.push(`   - Note (${step.over.map((id) => name.get(id)).join(', ')}): ${step.note}`);
			else {
				n++;
				const arrow = step.reply ? '⇠' : step.async ? '⇢' : '→';
				lines.push(`${n}. ${name.get(step.from)} ${arrow} ${name.get(step.to)}: ${step.label}`);
			}
		}
		return lines.join('\n');
	}
	const inGroup = (node: GraphNode, g: GraphGroup) =>
		node.x >= g.x && node.y >= g.y && node.x + (node.w ?? NODE_W) <= g.x + g.w && node.y + (node.h ?? NODE_H) <= g.y + g.h;
	const named = (node: GraphNode) => `${node.title}${node.sub ? ` (${node.sub})` : ''}`;
	const placed = new Set<string>();
	for (const g of spec.groups ?? []) {
		const members = spec.nodes.filter((node) => !placed.has(node.id) && inGroup(node, g));
		if (!members.length) continue;
		members.forEach((node) => placed.add(node.id));
		lines.push(`- ${g.label}: ${members.map(named).join('; ')}`);
	}
	const loose = spec.nodes.filter((node) => !placed.has(node.id));
	if (loose.length) lines.push(`- ${loose.map(named).join('; ')}`);
	lines.push('', 'Arrows:', '');
	const title = new Map(spec.nodes.map((node) => [node.id, plain(node.title)]));
	for (const g of spec.groups ?? []) if (g.id) title.set(g.id, plain(g.label));
	for (const edge of spec.edges) {
		const arrow = edge.both ? '↔' : edge.async ? '⇢' : '→';
		lines.push(`- ${title.get(edge.from)} ${arrow} ${title.get(edge.to)}${edge.label ? `: ${edge.label}` : ''}${edge.async ? ' (asynchronous)' : ''}`);
	}
	return lines.join('\n');
}

/** One paragraph for the SVG's <desc>: the text twin without its Markdown. */
function describe(spec: Spec): string {
	return plain(toMarkdown(spec).replace(/\*\*/g, '').replace(/\*/g, ''))
		.split('\n')
		.filter(Boolean)
		.join(' ');
}

export function render(id: string, spec: Spec): string {
	return spec.kind === 'graph' ? renderGraph(id, spec) : renderSequence(id, spec);
}
