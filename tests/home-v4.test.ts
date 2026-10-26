/**
 * Home4's pure layers (rebuild, 2026-10-26): the greeting, Continue's
 * model, the learning strip's cells, the minutes chart's bar heights, and
 * the ideas a topic mix practises.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { barHeights, continueModel, greeting, kpiCells, mixPicks } from "../components/home.tsx";
import type { V4Chat, V4Stats } from "../components/v4/data.ts";

function chat(id: string, o: Partial<V4Chat> = {}): V4Chat {
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
		assert.equal(greeting(new Date(2026, 9, 26, 2)), "Good evening.");
	});
});

describe("continueModel", () => {
	it("the first waiting session leads; the other waiting ones follow", () => {
		const m = continueModel([chat("latest"), chat("w1", { pendingQuestion: true }), chat("w2", { pendingQuestion: true })]);
		assert.equal(m.hero?.id, "w1");
		assert.deepEqual(m.waiting.map((c) => c.id), ["w2"]);
	});
	it("nothing waiting: the most recent session", () => {
		assert.equal(continueModel([chat("a"), chat("b")]).hero?.id, "a");
	});
	it("no sessions: no hero", () => {
		assert.equal(continueModel([]).hero, null);
	});
});

describe("kpiCells", () => {
	const stats: V4Stats = {
		period: "week",
		time: { seconds: 252 * 60, prevSeconds: 214 * 60 },
		lessons: { active: 4, waiting: 3, finished: 1, allTime: 14 },
		ideas: { added: 31, total: 186 },
		practice: { problems: 12, solid: 9 },
		tokens: { total: 1_240_000, dollars: 1.94 },
	};
	it("renders Home4's five cells", () => {
		const cells = kpiCells(stats);
		assert.deepEqual(cells.map((c) => [c.label, c.value]), [
			["Time learning", "4h 12m"],
			["Lessons", "4"],
			["Ideas learned", "+31"],
			["Practice", "12"],
			["Tokens", "1.24M"],
		]);
		assert.equal(cells[0]!.delta, "+38m");
		assert.equal(cells[0]!.up, true);
		assert.equal(cells[4]!.sub, "≈ $1.94");
	});
	it("an unpriced period says so, never $0", () => {
		assert.equal(kpiCells({ ...stats, tokens: { total: 10, dollars: null } })[4]!.sub, "cost unknown");
	});
});

describe("barHeights", () => {
	it("scales to the busiest day, never past 100", () => {
		const h = barHeights({
			goalMinutes: 30,
			metDays: 1,
			days: [
				{ date: "a", label: "Mon", minutes: 60, today: false },
				{ date: "b", label: "Tue", minutes: 30, today: true },
				{ date: "c", label: "Wed", minutes: 0, today: false },
			],
		});
		assert.deepEqual(h, [100, 50, 0]);
	});
});

describe("mixPicks", () => {
	it("the picked topics' ideas, newest first, capped", () => {
		const ideas = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, name: `n${i}`, statement: "", createdAt: "", source: null }));
		const topics = [
			{ id: "a", name: "A", ideaIds: ideas.map((i) => i.id), lastLearnedAt: null, lastPracticedAt: null },
			{ id: "b", name: "B", ideaIds: ["zzz"], lastLearnedAt: null, lastPracticedAt: null },
		];
		assert.equal(mixPicks(topics, ["a"], ideas).length, 40);
		assert.deepEqual(mixPicks(topics, [], ideas), []);
	});
});
