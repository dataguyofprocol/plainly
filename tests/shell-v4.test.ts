/**
 * The v4 shell's pure layers (rebuild, 2026-10-26): the session state and
 * row line the sidebar shows, the grouping, the formatting helpers, the
 * stable topic colours, the chain neighbourhood the Knowledge canvas
 * lights up, the omnibar's result model and the graph index.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ago,
	chainNeighbourhood,
	fmtDuration,
	fmtTokens,
	groupChats,
	sessionLine,
	sessionState,
	topicColor,
	TOPIC_COLORS,
	type V4Chat,
} from "../components/v4/data.ts";
import { paletteResults } from "../components/command-palette.tsx";
import { indexIdeas, type IndexedIdea } from "../components/graph-index.ts";
import type { GraphNode } from "../src/core/index.ts";

const NOW = new Date(2026, 9, 26, 15, 0, 0);
const TODAY = new Date(2026, 9, 26, 9, 0, 0).toISOString();
const YESTERDAY = new Date(2026, 9, 25, 22, 0, 0).toISOString();

function chat(o: Partial<V4Chat>): V4Chat {
	return {
		id: "c",
		title: "Session",
		kind: "teach",
		createdAt: YESTERDAY,
		updatedAt: YESTERDAY,
		messageCount: 2,
		phase: "teach",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...o,
	};
}

describe("sessionState", () => {
	it("the server's state wins when present", () => {
		assert.equal(sessionState(chat({ state: "finished", pendingQuestion: true })), "finished");
	});
	it("falls back from the base fields: working, waiting, paused", () => {
		assert.equal(sessionState(chat({ busy: true, pendingQuestion: true })), "working");
		assert.equal(sessionState(chat({ pendingQuestion: true })), "waiting");
		assert.equal(sessionState(chat({ kind: "practice", pendingProblem: true })), "waiting");
		assert.equal(sessionState(chat({ kind: "teach", pendingProblem: true })), "paused");
		assert.equal(sessionState(chat({})), "paused");
	});
});

describe("sessionLine — the sidebar row's second line (Home4)", () => {
	it("a waiting lesson names its plan step, else the check-in", () => {
		assert.equal(sessionLine(chat({ pendingQuestion: true, plan: { total: 14, visited: 5, current: 6 } }), NOW), "Step 6 of 14");
		assert.equal(sessionLine(chat({ pendingQuestion: true }), NOW), "Check-in");
	});
	it("practice shows its place in the set", () => {
		assert.equal(sessionLine(chat({ kind: "practice", practiceSet: { size: 5, done: 0 } }), NOW), "Practice · 1 of 5");
	});
	it("finished and paused carry how long ago", () => {
		assert.equal(sessionLine(chat({ state: "finished", updatedAt: new Date(NOW.getTime() - 3 * 86_400_000).toISOString() }), NOW), "Finished · 3 days ago");
		assert.equal(sessionLine(chat({ updatedAt: new Date(NOW.getTime() - 5 * 86_400_000).toISOString() }), NOW), "Paused · 5 days ago");
	});
});

describe("groupChats", () => {
	it("waiting first, then today, then earlier — order kept inside each group", () => {
		const groups = groupChats(
			[chat({ id: "a", updatedAt: TODAY }), chat({ id: "b", pendingQuestion: true }), chat({ id: "c" }), chat({ id: "d", pendingQuestion: true, updatedAt: TODAY })],
			NOW,
		);
		assert.deepEqual(
			groups.map((g) => [g.name, g.chats.map((c) => c.id)]),
			[
				["Waiting on you", ["b", "d"]],
				["Today", ["a"]],
				["Earlier", ["c"]],
			],
		);
	});
	it("empty groups are dropped", () => {
		assert.deepEqual(groupChats([], NOW), []);
	});
	it("archived sessions leave the live groups for Archived, last — even when waiting", () => {
		const groups = groupChats(
			[chat({ id: "a", updatedAt: TODAY }), chat({ id: "x", archived: true, pendingQuestion: true }), chat({ id: "c" }), chat({ id: "y", archived: true, updatedAt: TODAY })],
			NOW,
		);
		assert.deepEqual(
			groups.map((g) => [g.name, g.chats.map((c) => c.id)]),
			[
				["Today", ["a"]],
				["Earlier", ["c"]],
				["Archived", ["x", "y"]],
			],
		);
	});
});

describe("formatting", () => {
	it("ago: the design's register", () => {
		assert.equal(ago(new Date(NOW.getTime() - 18 * 60_000).toISOString(), NOW), "18 min ago");
		assert.equal(ago(new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), NOW), "3 h ago");
		assert.equal(ago(new Date(NOW.getTime() - 26 * 3_600_000).toISOString(), NOW), "yesterday");
	});
	it("fmtDuration and fmtTokens", () => {
		assert.equal(fmtDuration(252 * 60), "4h 12m");
		assert.equal(fmtDuration(38 * 60), "38m");
		assert.equal(fmtTokens(1_240_000), "1.24M");
		assert.equal(fmtTokens(212_400), "212k");
		assert.equal(fmtTokens(940), "940");
	});
});

describe("topicColor", () => {
	it("is stable and from the design's palette", () => {
		assert.equal(topicColor("t1"), topicColor("t1"));
		assert.ok((TOPIC_COLORS as readonly string[]).includes(topicColor("anything")));
	});
});

describe("chainNeighbourhood", () => {
	it("two hops up through the implication node, two hops down", () => {
		const edges = [
			{ from: "p1", to: "imp" },
			{ from: "p2", to: "imp" },
			{ from: "imp", to: "x" },
			{ from: "x", to: "y" },
			{ from: "y", to: "z" },
			{ from: "q", to: "p1" },
		];
		assert.deepEqual([...chainNeighbourhood(edges, "x")].sort(), ["imp", "p1", "p2", "x", "y", "z"]);
	});
});

const IDEAS: IndexedIdea[] = [
	{ id: "n1", name: "Unbiased gradient", statement: "A sampled gradient is unbiased", createdAt: TODAY, source: "Gradient descent" },
	{ id: "n2", name: "Disquotation", statement: "“p” is true iff p", createdAt: YESTERDAY, source: null },
];

describe("paletteResults", () => {
	it("empty query: where you left off, then the commands", () => {
		const groups = paletteResults("", "teach", [chat({ id: "w", pendingQuestion: true }), chat({ id: "r" })], IDEAS);
		assert.deepEqual(groups.map((g) => g.name), ["Waiting on you", "Recent", "Commands"]);
	});
	it("a query leads with the chosen mode's start, then the other", () => {
		assert.deepEqual(paletteResults("momentum", "teach", [], [])[0]!.rows.map((r) => r.key), ["start-teach", "start-practice"]);
		assert.deepEqual(paletteResults("momentum", "practice", [], [])[0]!.rows.map((r) => r.key), ["start-practice", "start-teach"]);
	});
	it("finds sessions by title and ideas by name or statement", () => {
		const groups = paletteResults("gradient", "teach", [chat({ id: "g", title: "Gradient descent" })], IDEAS);
		const byName = Object.fromEntries(groups.map((g) => [g.name, g.rows.map((r) => r.key)]));
		assert.deepEqual(byName["Sessions"], ["s-g"]);
		assert.deepEqual(byName["Ideas you hold"], ["i-n1"]);
	});
});

describe("indexIdeas", () => {
	it("newest first, with the first source's label", () => {
		const node = (id: string, createdAt: string, chatId: string): GraphNode => ({ id, name: id, statement: id, aliases: [], createdAt, provenance: [{ chatId, messageId: "m" }] });
		const ideas = indexIdeas({
			propositions: [node("old", YESTERDAY, "c1"), node("new", TODAY, "src_1")],
			sessions: { c1: "Gradient descent" },
			fileSources: { src_1: "notes/hume.md" },
		});
		assert.deepEqual(ideas.map((i) => [i.id, i.source]), [["new", "notes/hume.md"], ["old", "Gradient descent"]]);
	});
});
