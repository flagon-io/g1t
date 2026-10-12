// node --test src/diagrams/*.test.ts   (in apps/docs)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Graph, type GraphNode, render, textWidth, toMarkdown } from './engine.ts';
import { DIAGRAMS } from './index.ts';

const graphs = Object.entries(DIAGRAMS).filter((entry): entry is [string, Graph] => entry[1].kind === 'graph');
const size = (node: GraphNode) => ({ w: node.w ?? 150, h: node.h ?? 52 });

test('every diagram draws, and reads as text', () => {
	for (const [name, spec] of Object.entries(DIAGRAMS)) {
		const svg = render(`d-${name}`, spec);
		assert.match(svg, /^<svg /, name);
		assert.ok(toMarkdown(spec).startsWith(`**Diagram: ${spec.caption}**`), name);
	}
});

test("every box is inside its diagram, and no two boxes overlap", () => {
	for (const [name, graph] of graphs) {
		const ids = new Set<string>();
		for (const node of graph.nodes) {
			assert.ok(!ids.has(node.id), `${name}: two boxes are called ${node.id}`);
			ids.add(node.id);
			const { w, h } = size(node);
			assert.ok(node.x >= 0 && node.y >= 0 && node.x + w <= graph.width && node.y + h <= graph.height, `${name}: ${node.id} is outside the diagram`);
		}
		for (const [i, a] of graph.nodes.entries()) {
			for (const b of graph.nodes.slice(i + 1)) {
				const sa = size(a);
				const sb = size(b);
				const apart = a.x + sa.w <= b.x || b.x + sb.w <= a.x || a.y + sa.h <= b.y || b.y + sb.h <= a.y;
				assert.ok(apart, `${name}: ${a.id} and ${b.id} overlap`);
			}
		}
	}
});

test("every box's text fits inside it", () => {
	for (const [name, graph] of graphs) {
		for (const node of graph.nodes) {
			const { w } = size(node);
			assert.ok(textWidth(node.title, 12.5) <= w - 8, `${name}: the title of ${node.id} is wider than its box`);
			// The second line is set in the mono face.
			if (node.sub) assert.ok(textWidth(`\`${node.sub.replace(/`/g, '')}\``, 10) <= w - 8, `${name}: the second line of ${node.id} is wider than its box`);
		}
	}
});

test('an arrow to a box that does not exist is an error, not a missing line', () => {
	const broken: Graph = { kind: 'graph', caption: 'x', width: 100, height: 100, nodes: [], edges: [{ from: 'a', to: 'b' }] };
	assert.throws(() => render('d-broken', broken), /not a box/);
});
