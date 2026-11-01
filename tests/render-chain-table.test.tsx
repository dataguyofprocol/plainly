import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { ChainTableBody, ChainTableOverlay } from "../components/chain-table.tsx";
import type { ChainSort } from "../components/chain-table.tsx";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";

function node(id: string, name: string, statement: string, chatId: string | null): GraphNode {
	return {
		id,
		name,
		statement,
		aliases: [] as string[],
		state: "new",
		createdAt: "2026-09-20T10:00:00.000Z",
		provenance: chatId === null ? [] : [{ chatId, messageId: `m_${id}` }],
	} as unknown as GraphNode;
}

const NODES: GraphNode[] = [
	node("a", "Premise one", "Statement A.", "chat1"),
	node("b", "Premise two", "Statement B.", "chat2"),
	node("c1", "Conclusion", "Statement C.", "chat1"),
	node("d", "Support", "Statement D.", null),
	node("e", "Follow-up", "Statement E with keyword zebra.", "notes1"),
	node("solo", "Standalone", "Statement S.", "chat1"),
	node("orphan", "Orphan", "Statement O.", null),
];

const CHAINS: GraphChain[] = [
	{ id: "c1", premises: ["a", "b"], conclusion: "c1", provenance: [], createdAt: "2026-09-20T10:00:00.000Z" },
	{ id: "e", premises: ["d"], conclusion: "e", provenance: [], createdAt: "2026-09-20T10:00:00.000Z" },
];

const BASE = {
	nodes: NODES,
	chains: CHAINS,
	sessions: { chat1: "Ethics lesson", chat2: "Second chat" },
	fileSources: { notes1: "notes/raw/ethics.md" },
	query: "",
	onQuery: () => {},
	sort: { col: "name", dir: 1 } as ChainSort,
	onSort: () => {},
	selection: new Set<string>(),
	expandedClusters: new Set<string>(),
	expandedChains: new Set<string>(),
	onToggleCluster: () => {},
	onToggleChain: () => {},
	onToggleNodes: () => {},
	onClear: () => {},
	onGenerate: () => {},
	onDelete: () => {},
	onClose: () => {},
};

function render(props: Partial<typeof BASE> = {}) {
	return renderToStaticMarkup(React.createElement(ChainTableBody, { ...BASE, ...props }));
}

describe("ChainTableBody — clusters (the outermost layer)", () => {
	it("collapsed by default: cluster rows render, chain rows do not", () => {
		const html = render();
		assert.ok(html.includes('data-testid="cluster-group-chat1"'), "the chat cluster");
		assert.ok(html.includes('data-testid="cluster-group-notes1"'), "the notes cluster");
		assert.ok(html.includes("Ethics lesson"), "chat label");
		assert.ok(html.includes("notes/raw/ethics.md"), "notes label");
		assert.ok(html.includes("lucide-folder"), "the closed folder icon");
		assert.ok(!html.includes('data-testid="chain-row-c1"'), "no chain row when collapsed");
		assert.ok(!html.includes("Premise one"), "no chips when collapsed");
	});

	it("a premise-only birth never becomes a group — chains live in their CONCLUSION's cluster", () => {
		const html = render();
		assert.ok(!html.includes("cluster-group-chat2"), "chat2 births only a premise");
		assert.ok(!html.includes("Second chat"), "its label never renders");
	});

	it("an unnameable CONCLUSION birth forms one honest muted unlabeled group", () => {
		const html = render();
		assert.ok(html.includes("unlabeled"), "the muted label");
		assert.ok(html.includes('data-testid="chain-row-orphan"') === false, "collapsed, like every group");
	});

	it("cluster rows carry checkbox + counts + newest date; notes kind marked", () => {
		const html = render();
		assert.ok(html.includes('data-testid="cluster-checkbox-chat1"'));
		assert.ok(html.includes(">4</span>"), "chat1's proposition count");
		assert.ok(html.includes("2026-09-20"), "the newest-member date");
		assert.ok(html.includes(">notes</span>"), "the notes kind tag");
	});
});

describe("ChainTableBody — THE shared TopBar + the lines law (owner, round 2)", () => {
	it("the body renders the standardized top bar: h-15, lh-drag, select-none, NO title (serif = session name, always), close X", () => {
		const html = render();
		assert.ok(html.includes("lh-drag"), "the window-drag band");
		assert.ok(html.includes("select-none"), "dragging never highlights the bar");
		assert.ok(html.includes("h-15"), "the standard height");
		assert.ok(!html.includes(">Chains<"), "NO title (owner round 11): the serif register always names a session");
		assert.ok(html.includes("chain"), "the counts remain");
		assert.ok(html.includes('data-testid="chain-table-close"'), "the close X");
		assert.ok(html.includes('data-testid="chain-table-search"'), "the search input");
	});

	it("the table is FRAMED: header rule + rules between groups + rule under the last group; rows stay lineless (owner round 5)", () => {
		const html = render({ expandedClusters: new Set(["chat1"]) });
		const sep = html.split("border-b border-border/60").length - 1;
		assert.ok(sep >= 4, "header + 3 group rules");
		assert.ok(html.includes('class="flex items-center gap-1 py-1 pl-12 pr-3"'), "the chain row: staircase indent, no border");
	});

	it("TREE THREADS: open folders/chains drop a vertical guide from their expander arrow down the children's edge (owner round 5)", () => {
		const collapsed = render();
		assert.ok(!collapsed.includes("cluster-thread-"), "no thread while collapsed");
		const open = render({ expandedClusters: new Set(["chat1"]), expandedChains: new Set(["c1"]) });
		assert.ok(open.includes('data-testid="cluster-thread-chat1"'), "the cluster thread");
		assert.ok(open.includes('data-testid="chain-thread-c1"'), "the chain thread");
		assert.ok(open.includes("left-[37px]"), "thread at the cluster arrow's column");
		assert.ok(open.includes("left-[73px]"), "thread at the chain arrow's column");
		assert.ok(open.includes("bottom-[8px] left-[37px] top-[23px]"), "cluster thread bracketed by checkbox bottoms");
		assert.ok(open.includes("top-[22px]") && open.includes("bottom-[8px]"), "chain thread bracketed by checkbox bottoms");
	});
});

describe("ChainTableBody — chain rows (chips + connectors)", () => {
	it("names render as outlined chips; premises join by ∧, the conclusion by ⟹ — REAL KaTeX glyphs in the foreground", () => {
		const html = render({ expandedClusters: new Set(["chat1"]) });
		assert.ok(html.includes('data-testid="chain-row-c1"'));
		assert.ok(html.includes('data-testid="prop-chip-a"'), "premise chip");
		assert.ok(html.includes('data-testid="prop-chip-c1"'), "conclusion chip");
		assert.ok(html.includes("Premise one"), "chip text");
		assert.ok(html.includes('data-testid="chain-and-c1-1"'), "the land between premises");
		assert.ok(html.includes('data-testid="chain-implies-c1"'), "the implication before the conclusion");
		const and = html.match(/data-testid="chain-and-c1-1"[^>]*>/)?.[0] ?? "";
		assert.match(and, /text-foreground/, "prominent — the theme's white, not dim gray");
		assert.ok(html.includes("katex"), "a REAL KaTeX render, not a unicode arrow");
		assert.doesNotMatch(html, />\s*→\s*</, "no textual arrow connector remains");
		assert.ok(!html.includes("lucide-waypoints"), "no chain icon");
	});

	it("a singleton renders ONE lonely chip, no connector; the annotation survives only for screen readers", () => {
		const html = render({ expandedClusters: new Set(["chat1"]) });
		assert.ok(html.includes('data-testid="chain-row-solo"'));
		assert.ok(html.includes('data-testid="prop-chip-solo"'));
		assert.ok(!html.includes('data-testid="chain-arrow-solo-1"'), "no connector on a singleton");
		assert.equal(html.split("no premises").length - 1, 1, "aria-label only, never visible text");
		assert.ok(html.includes('aria-label="Standalone (no premises)"'));
	});

	it("the row carries the one-line derivation as its aria-label (core formatChainLine)", () => {
		const html = render({ expandedClusters: new Set(["chat1"]) });
		assert.ok(html.includes('aria-label="Premise one, Premise two → Conclusion"'));
	});

	it("expanding a chain reveals member STATEMENTS directly — PLAIN rows, no conclusion marker (owner, round 2)", () => {
		const html = render({
			expandedClusters: new Set(["chat1"]),
			expandedChains: new Set(["c1"]),
		});
		assert.ok(html.includes('data-testid="prop-row-a"'), "premise statement row");
		assert.ok(html.includes("Statement A."), "the statement text, one click deep");
		assert.ok(html.includes("Statement C."), "the conclusion statement");
		assert.ok(!html.includes("prop-conclusion"), "no conclusion marker anywhere");
		assert.ok(html.includes("pl-21"), "statements at the would-be chain-icon column");
		assert.ok(html.includes("pl-12"), "chains aligned with the folder icon");
		assert.ok(html.includes("h-5 w-3.5"), "the expander shares the checkbox's 14px width");
	});
});

describe("ChainTableBody — the sortable table headers", () => {
	it("ALL THREE columns are sort controls with aria-sort (owner: consistency is key)", () => {
		const html = render();
		assert.ok(html.includes('data-testid="sort-name"'));
		assert.ok(html.includes('data-testid="sort-props"'));
		assert.ok(html.includes('data-testid="sort-created"'));
		assert.ok(html.includes('aria-sort="ascending"'), "default name A→Z");
		assert.ok(html.includes('lucide-chevron-up size-3'), "small up chevron on active name");
		assert.ok(html.includes('lucide-chevron-down') === false, "no down chevron while ascending");
	});

	it("descending state shows on the active header only", () => {
		const html = render({ sort: { col: "created", dir: -1 } });
		assert.ok(html.includes('data-testid="sort-created"'));
		assert.ok(html.includes('aria-sort="descending"'));
		assert.ok(html.includes('aria-sort="none"'), "the inactive column");
		assert.ok(html.includes('lucide-chevron-down size-3'), "small down chevron");
	});

	it("Props sort orders cluster rows AND chains within (largest-first by default)", () => {
		const html = render({ sort: { col: "props", dir: 1 }, expandedClusters: new Set(["chat1"]) });
		const unlabeled = html.indexOf("cluster-group-\0unlabeled");
		const notes = html.indexOf('data-testid="cluster-group-notes1"');
		const chat = html.indexOf('data-testid="cluster-group-chat1"');
		assert.ok(unlabeled > 0 && notes > 0 && chat > 0, "all three groups render");
		assert.ok(unlabeled < notes && notes < chat, "1 < 2 < 4 member ids ascending");
		const soloRow = html.indexOf('data-testid="chain-row-solo"');
		const c1Row = html.indexOf('data-testid="chain-row-c1"');
		assert.ok(soloRow > 0 && c1Row > 0 && soloRow < c1Row, "chain sizes ascending within the cluster");
	});
});

describe("ChainTableBody — the floating selection bar (never shifts layout)", () => {
	it("absent when nothing is selected", () => {
		const html = render({ expandedClusters: new Set(["chat1"]) });
		assert.ok(!html.includes('data-testid="chain-selection-bar"'));
	});

	it("appears with the derived N nodes → M chains + Clear + the FENCED Delete", () => {
		const html = render({ selection: new Set(["a", "b", "c1"]) });
		assert.ok(html.includes('data-testid="chain-selection-bar"'));
		assert.ok(html.includes('data-testid="chain-selected-summary"'));
		assert.ok(html.includes("3 nodes → 1 chain"));
		assert.ok(html.includes('data-testid="chain-clear"'));
		assert.ok(html.includes('data-testid="chain-danger-divider"'));
		const del = html.match(/<button[^>]*data-testid="chain-delete"[^>]*>/)?.[0] ?? "";
		assert.match(del, /border-destructive\/50/);
		assert.match(del, /aria-label="Delete 3 selected nodes"/);
		assert.ok(html.includes("lucide-trash-2"), "the trash icon");
		assert.ok(html.indexOf('chain-danger-divider"') < html.indexOf('chain-delete"'));
	});

	it("the Delete rides ONLY with a selection — no bar, no kill switch", () => {
		const html = render({ expandedClusters: new Set(["chat1"]) });
		assert.ok(!html.includes('data-testid="chain-delete"'));
		assert.ok(!html.includes('data-testid="chain-danger-divider"'));
	});

	it("a premise WITHOUT its conclusion derives as the singleton it becomes", () => {
		const html = render({ selection: new Set(["a", "d"]) });
		assert.ok(html.includes("2 nodes → 2 chains"), "no follows-edge survives inside the selection");
	});
});

describe("ChainTableBody — the fuzzy search (grouped + auto-expand)", () => {
	it("matching clusters auto-expand to reveal their chains; others hide; the bar is unaffected", () => {
		const aliased = NODES.map((n) => (n.id === "b" ? { ...n, aliases: ["zebra alias"] } : n));
		const html = render({
			nodes: aliased,
			query: "zebra",
			selection: new Set(["a", "b", "c1"]),
		});
		assert.ok(html.includes('data-testid="chain-row-c1"'), "auto-expanded cluster reveals the chain");
		assert.ok(html.includes('data-testid="chain-row-e"'), "statement match");
		assert.ok(!html.includes('data-testid="chain-row-solo"'), "non-matching chain hidden");
		assert.ok(!html.includes("cluster-group-notes1") === false, "notes1 still renders (it has a match)");
		assert.ok(!html.includes("Ethics lesson") === false, "chat1 still renders (it has a match)");
		assert.ok(html.includes("3 nodes → 1 chain"));
	});

	it("no matches: the honest empty line", () => {
		const html = render({ query: "qqqq" });
		assert.ok(html.includes('data-testid="chain-table-nomatch"'));
		assert.ok(html.includes("No matching chains."));
	});
});

describe("ChainTableOverlay — the lifted practice pick (owner vision, 2026-10-04)", () => {
	function overlay(extra: Record<string, unknown> = {}) {
		return renderToStaticMarkup(
			React.createElement(ChainTableOverlay, {
				open: true,
				nodes: NODES,
				chains: CHAINS,
				sessions: { chat1: "Ethics lesson", chat2: "Follow-up", notes1: "Notes" },
				fileSources: {},
				onClose: () => {},
				...extra,
			} as never),
		);
	}

	it("CONTROLLED selection renders the caller's set — the bar counts it live", () => {
		const html = overlay({ controlledSelection: new Set(["a", "b", "c1"]) });
		assert.ok(html.includes("3 nodes → 1 chain"), "the bar reflects the lifted set, not internal state");
	});

	it("select mode: Done replaces the delete fence — no way to delete while picking", () => {
		const html = overlay({
			selectMode: true,
			controlledSelection: new Set(["a", "b"]),
		});
		assert.ok(html.includes('data-testid="chain-practice-done"'));
		assert.ok(html.includes("Done"));
		assert.ok(!html.includes('data-testid="chain-delete"'), "no delete while picking");
		assert.ok(!html.includes('data-testid="chain-danger-divider"'));
	});

	it("browse mode unchanged: the fenced Delete remains", () => {
		const html = overlay({ controlledSelection: new Set(["a"]) });
		assert.ok(html.includes('data-testid="chain-delete"'));
		assert.ok(!html.includes('data-testid="chain-practice-done"'));
	});
});
