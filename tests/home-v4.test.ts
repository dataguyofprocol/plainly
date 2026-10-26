/**
 * The v4 home's pure layers (redesign, 2026-10-26): the greeting, the
 * Continue model (what is waiting on you first, else the latest), and the
 * knowledge counts line.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { continueModel, greeting, knowledgeCounts } from "../components/home.tsx";
import type { ChatListItem } from "../src/core/index.ts";

function chat(id: string, o: Partial<ChatListItem> = {}): ChatListItem {
	return {
		id,
		title: id,
		kind: "teach",
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		messageCount: 2,
		phase: "teach",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...o,
	};
}

describe("greeting", () => {
	it("follows the reader's clock", () => {
		assert.equal(greeting(new Date(2026, 9, 26, 8)), "Good morning.");
		assert.equal(greeting(new Date(2026, 9, 26, 14)), "Good afternoon.");
		assert.equal(greeting(new Date(2026, 9, 26, 21)), "Good evening.");
		assert.equal(greeting(new Date(2026, 9, 26, 2)), "Good evening.", "late night is still evening");
	});
});

describe("continueModel", () => {
	it("the first waiting session leads; the other waiting ones follow", () => {
		const m = continueModel([chat("latest"), chat("w1", { pendingQuestion: true }), chat("w2", { pendingQuestion: true })]);
		assert.equal(m.hero?.id, "w1");
		assert.deepEqual(m.waiting.map((c) => c.id), ["w2"]);
	});

	it("nothing waiting: the most recent session, no list", () => {
		const m = continueModel([chat("a"), chat("b")]);
		assert.equal(m.hero?.id, "a");
		assert.deepEqual(m.waiting, []);
	});

	it("a running turn is not waiting on you", () => {
		const m = continueModel([chat("a"), chat("busy", { pendingQuestion: true, busy: true })]);
		assert.equal(m.hero?.id, "a");
	});

	it("no sessions: no hero", () => {
		assert.equal(continueModel([]).hero, null);
	});
});

describe("knowledgeCounts", () => {
	it("counts ideas added in the last seven days", () => {
		const now = new Date("2026-10-26T12:00:00.000Z");
		const idea = (createdAt: string) => ({ id: createdAt, name: "", statement: "", createdAt, source: null });
		const c = knowledgeCounts([idea("2026-10-25T00:00:00.000Z"), idea("2026-10-20T00:00:00.000Z"), idea("2026-10-01T00:00:00.000Z")], now);
		assert.deepEqual(c, { total: 3, thisWeek: 2 });
	});
});
