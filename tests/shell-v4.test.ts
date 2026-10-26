/**
 * The v4 shell's pure layers (redesign, 2026-10-26): the sidebar's session
 * grouping, the session-page rule that picks the rail by default, the
 * omnibar's result model, and the graph index the chrome reads.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupSessions, isSessionPath, isWaitingOnYou } from "../components/sidebar.tsx";
import { paletteResults } from "../components/command-palette.tsx";
import { indexIdeas, type IndexedIdea } from "../components/graph-index.ts";
import type { ChatListItem, GraphNode } from "../src/core/index.ts";

const NOW = new Date(2026, 9, 26, 15, 0, 0);
const TODAY = new Date(2026, 9, 26, 9, 0, 0).toISOString();
const YESTERDAY = new Date(2026, 9, 25, 22, 0, 0).toISOString();

function chat(o: Partial<ChatListItem>): ChatListItem {
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

describe("groupSessions", () => {
	it("waiting first, then today, then earlier — order kept inside each group", () => {
		const groups = groupSessions(
			[
				chat({ id: "a", updatedAt: TODAY }),
				chat({ id: "b", pendingQuestion: true }),
				chat({ id: "c" }),
				chat({ id: "d", pendingQuestion: true, updatedAt: TODAY }),
			],
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

	it("a turn in flight is never waiting on you", () => {
		const [g] = groupSessions([chat({ pendingQuestion: true, busy: true, updatedAt: TODAY })], NOW);
		assert.equal(g!.name, "Today");
	});

	it("a pending practice problem waits; a teach session's stale pendingProblem does not", () => {
		assert.equal(isWaitingOnYou(chat({ kind: "practice", pendingProblem: true })), true);
		assert.equal(isWaitingOnYou(chat({ kind: "teach", pendingProblem: true })), false);
	});

	it("empty groups are dropped", () => {
		assert.deepEqual(groupSessions([], NOW), []);
	});
});

describe("isSessionPath — sessions default to the rail", () => {
	it("chat pages and drafts are session pages; home and knowledge are not", () => {
		assert.equal(isSessionPath("/chat/abc"), true);
		assert.equal(isSessionPath("/chat/new"), true);
		assert.equal(isSessionPath("/"), false);
		assert.equal(isSessionPath("/knowledge"), false);
		assert.equal(isSessionPath(null), false);
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
		assert.equal(groups[0]!.rows[0]!.hint, "waiting on you");
	});

	it("a query leads with the chosen mode's start, then the other", () => {
		const teach = paletteResults("momentum", "teach", [], []);
		assert.deepEqual(teach[0]!.rows.map((r) => r.key), ["start-teach", "start-practice"]);
		assert.deepEqual(teach[0]!.rows[0]!.action, { kind: "start", mode: "teach", text: "momentum" });
		const practice = paletteResults("momentum", "practice", [], []);
		assert.deepEqual(practice[0]!.rows.map((r) => r.key), ["start-practice", "start-teach"]);
	});

	it("finds sessions by title and ideas by name or statement", () => {
		const groups = paletteResults("gradient", "teach", [chat({ id: "g", title: "Gradient descent" }), chat({ id: "x", title: "Lacan" })], IDEAS);
		const byName = Object.fromEntries(groups.map((g) => [g.name, g.rows.map((r) => r.key)]));
		assert.deepEqual(byName["Sessions"], ["s-g"]);
		assert.deepEqual(byName["Ideas you hold"], ["i-n1"]);
		const viaStatement = paletteResults("true iff", "teach", [], IDEAS);
		assert.ok(viaStatement.some((g) => g.rows.some((r) => r.key === "i-n2")));
	});
});

describe("indexIdeas", () => {
	it("newest first, with the first source's label (session title or notes path)", () => {
		const node = (id: string, createdAt: string, chatId: string): GraphNode => ({
			id,
			name: id,
			statement: id,
			aliases: [],
			createdAt,
			provenance: [{ chatId, messageId: "m" }],
		});
		const ideas = indexIdeas({
			propositions: [node("old", YESTERDAY, "c1"), node("new", TODAY, "src_1")],
			sessions: { c1: "Gradient descent" },
			fileSources: { src_1: "notes/hume.md" },
		});
		assert.deepEqual(ideas.map((i) => [i.id, i.source]), [["new", "notes/hume.md"], ["old", "Gradient descent"]]);
	});
});
