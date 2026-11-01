import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	PlanBlock,
	PlanPopup,
	blockLayout,
	topoFor,
	edgePathD,
	wrapTitle,
	GAP_X,
	NODE_H,
	NODE_W_MIN,
	nodeWidth,
	estimateLineWidth,
	type PopupMessage,
} from "../components/plan-block.tsx";
import type { PlanBlockData, PlanTree } from "../src/core/contracts.ts";

const CHAIN: PlanTree = {
	nodes: [
		{ id: "a", title: "Alpha node" },
		{ id: "b", title: "Beta node" },
		{ id: "c", title: "Gamma node" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
	],
	version: 1,
};

describe("plan block layout (pure)", () => {
	it("layers a chain top-down, one node per depth row", () => {
		const { order, depth } = topoFor(CHAIN.nodes, CHAIN.edges);
		assert.deepEqual(order.map((n) => n.id), ["a", "b", "c"]);
		assert.equal(depth.get("c"), 2);
		const layout = blockLayout(CHAIN.nodes, CHAIN.edges);
		const W = nodeWidth(wrapTitle("Alpha node"));
		assert.equal(W, NODE_W_MIN);
		assert.equal(nodeWidth(wrapTitle("Gamma node")), NODE_W_MIN);
		assert.equal(layout.width, NODE_W_MIN);
		assert.equal(layout.height, 3 * NODE_H + 2 * 48);
		assert.equal(layout.nodeW.get("a"), W);
	});

	it("centers same-depth nodes over the widest row; tolerates dangling edges", () => {
		const nodes = [
			{ id: "r", title: "Root" },
			{ id: "x", title: "Left" },
			{ id: "y", title: "Right" },
		];
		const layout = blockLayout(nodes, [
			{ from: "r", to: "x" },
			{ from: "r", to: "y" },
			{ from: "ghost", to: "r" },
		]);
		const W = nodeWidth(wrapTitle("Root"));
		assert.equal(layout.width, 2 * W + GAP_X);
		assert.equal(layout.x.get("r"), (2 * W + GAP_X - W) / 2);
		assert.ok(layout.x.get("x") === 0 && layout.x.get("y") === W + GAP_X);
	});

	it("edgePathD draws dagre's route through curveBasis — mouth pulled back from the border", () => {
		const d = edgePathD([{ x: 80, y: 44 }, { x: 80, y: 68 }, { x: 80, y: 92 }]);
		assert.ok(d.startsWith("M80,44"), "starts at the source border point");
		assert.ok(d.endsWith("L80,86.974"), "mouth pulled back; tip floats 2.67 off the border");
		const xs = [...d.matchAll(/(?:[MLC]|,)(-?[\d.]+),/g)].map((m) => m[1]);
		assert.ok(xs.length > 0 && xs.every((v) => v === "80"), "collinear route renders on-axis");
		const pd = edgePathD([{ x: 80, y: 44 }, { x: 80, y: 68 }, { x: 80, y: 92 }], { x: 0, y: 92, w: 160, h: 44 });
		assert.equal(pd, d);
	});

	it("edgePathD clamps the entry to ±40° of the face perpendicular (owner, round 14)", () => {
		const box = { x: 20, y: 100, w: 160, h: 44 };
		const clamped = edgePathD([{ x: 70, y: 70 }, { x: 100, y: 100 }], box);
		assert.ok(clamped.endsWith("L98.484,95.526"), "swung to the cone edge");
		const nums = [...clamped.matchAll(/(-?[\d.]+)/g)].map((m) => Number(m[1]));
		const ax = nums[nums.length - 4]!;
		const ay = nums[nums.length - 3]!;
		const bx = nums[nums.length - 2]!;
		const by = nums[nums.length - 1]!;
		assert.ok(Math.abs((bx - ax) / (by - ay) - Math.tan((40 * Math.PI) / 180)) < 0.01, "40° cone edge");
		const tipY = by + 0.766 * 2.359;
		assert.ok(Math.abs(tipY - 97.333) < 0.01, "docking gap along the face normal");
		const free = edgePathD([{ x: 90, y: 40 }, { x: 100, y: 100 }], box);
		assert.ok(free.endsWith("L99.612,95.006"), "unclamped within the cone");
	});

	it("wrapTitle wraps greedily and NEVER drops content (boxes grow instead)", () => {
		assert.deepEqual(wrapTitle("Chain rule intuition"), ["Chain rule intuition"]);
		assert.deepEqual(wrapTitle("Chain rule intuition and fluency"), [
			"Chain rule intuition and",
			"fluency",
		]);
		assert.deepEqual(wrapTitle("supercalifragilisticexpialidocious word"), [
			"supercalifragilisticexpialid",
			"ocious word",
		]);
		assert.deepEqual(wrapTitle("supercalifragilistic"), ["supercalifragilistic"]);
	});

	it("nodeWidth hugs the wrapped text (the box grows WITH its lines)", () => {
		assert.equal(nodeWidth(["supercalifragilistic"]), 117);
		assert.equal(nodeWidth(wrapTitle("Symmetry and orthogonal complements")), 149);
		assert.ok(nodeWidth(["a"]) === NODE_W_MIN);
		assert.ok(Math.abs(estimateLineWidth("The normal-form ladder") - 106.3) < 0.5);
	});
});

describe("plan block render", () => {
	it("full block: borderless, column-filling, statuses AS CARRIED (never re-derived)", () => {
		const data: PlanBlockData = {
			kind: "full",
			at: "2026-09-09T12:00:00Z",
			current: null,
			nodes: [
				{ id: "a", title: "Alpha node", status: "visited" },
				{ id: "b", title: "Beta node", status: "upcoming" },
			],
			edges: [{ from: "a", to: "b" }],
		};
		const html = renderToStaticMarkup(<PlanBlock data={data} onOpen={() => {}} />);
		assert.match(html, /data-testid="plan-block-full"/);
		assert.ok(!/data-testid="plan-block-full"[^>]*border/.test(html), "no wrapping chrome");
		assert.match(html, /<svg[^>]*class="block h-auto w-full mx-auto"/);
		assert.match(html, /<svg[^>]*font-family:var\(--font-prose\)/);
		assert.match(html, /<rect[^>]*stroke-width="1"/);
		assert.match(html, /max-width:143\.36px/);
		assert.match(html, /<text[^>]*x="48"[^>]*text-anchor="middle"/);
		assert.ok(!/x="12"/.test(html), "no left-inset text");
		assert.match(html, /<rect[^>]*class="fill-card stroke-foreground"/);
		assert.match(html, /viewBox="-8 -8 112 152"/);
		assert.match(html, /data-testid="plan-node-a" data-status="visited"/);
		assert.match(html, /data-testid="plan-node-b" data-status="upcoming"/);
		assert.ok(html.includes('aria-label="Open the full plan"'), "the trigger names itself (tooltip copy)");
	});

});

describe("plan popup (live derivation)", () => {
	function messages(): PopupMessage[] {
		return [
			{
				parts: [
					{
						type: "tool-plan_init",
						state: "output-available",
						output: { ok: true, tree: CHAIN },
					},
				],
			},
			{
				parts: [
					{
						type: "tool-quiz",
						state: "output-available",
						input: { nodeId: "a" },
						output: { correct: true },
					},
				],
			},
			{
				parts: [
					{
						type: "tool-quiz",
						state: "input-available",
						input: { nodeId: "b" },
					},
				],
			},
		];
	}

	it("derives statuses at click time: latest tagged call → current, earlier → visited (glowing)", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={messages()} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-popup"/);
		assert.match(html, /data-testid="plan-node-a" data-status="visited"/);
		assert.match(html, /data-testid="plan-node-b" data-status="current"/);
		assert.match(html, /data-testid="plan-node-c" data-status="upcoming"/);
		assert.match(html, /fill-brand\/20/);
		assert.match(html, /feGaussianBlur/);
		assert.doesNotMatch(html, /animate-pulse/);
		assert.match(html, /marker-end="url\(#.*-dim\)"/);
		assert.match(html, /live — statuses derive from your check outcomes/);
		assert.match(html, /opacity: ?0[;,}]/, "diagram hidden until the first fit applies");
	});

	it("dims an arrow when EITHER end is gray — white needs both ends white (owner, 2026-09-26)", () => {
		const tree: PlanTree = {
			nodes: [
				{ id: "x", title: "Gray origin" },
				{ id: "y", title: "Covered middle" },
				{ id: "z", title: "Covered latest" },
			],
			edges: [
				{ from: "x", to: "y" },
				{ from: "y", to: "z" },
			],
			version: 1,
		};
		const msgs: PopupMessage[] = [
			{ parts: [{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree } }] },
			{ parts: [{ type: "tool-quiz", state: "output-available", input: { nodeId: "y" }, output: { correct: true } }] },
			{ parts: [{ type: "tool-quiz", state: "output-available", input: { nodeId: "z" }, output: { correct: true } }] },
		];
		const html = renderToStaticMarkup(<PlanPopup messages={msgs} onClose={() => {}} />);
		assert.match(html, /data-testid="plan-node-x" data-status="upcoming"/);
		assert.match(html, /data-testid="plan-node-y" data-status="visited"/);
		assert.match(html, /data-testid="plan-node-z" data-status="current"/);
		const dimHeads = (html.match(/marker-end="url\(#.*-dim\)"/g) ?? []).length;
		const whiteHeads = (html.match(/marker-end="url\(#(?:R\d+|[a-z0-9-]+)\)"/g) ?? []).length;
		assert.equal(dimHeads, 1, "the gray-origin edge dims");
		assert.equal(whiteHeads, 1, "the both-white edge stays white");
		assert.match(html, /<path[^>]*class="fill-none stroke-border"/);
		assert.match(html, /<path[^>]*class="fill-none stroke-foreground"/);
	});

	it("renders the empty state when the session has no plan", () => {
		const html = renderToStaticMarkup(<PlanPopup messages={[{ parts: [] }]} onClose={() => {}} />);
		assert.match(html, /No plan in this session yet\./);
	});
});