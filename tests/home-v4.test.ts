import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { barHeights, continueModel, greeting, homeGreeting, kpiCells, mixPicks } from "../components/home.tsx";
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
	it("archived sessions never surface, waiting or not", () => {
		const m = continueModel([chat("old", { archived: true }), chat("w-arch", { pendingQuestion: true, archived: true }), chat("live")]);
		assert.equal(m.hero?.id, "live");
		assert.deepEqual(m.waiting, []);
		assert.equal(continueModel([chat("only", { archived: true })]).hero, null);
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

describe("homeGreeting", () => {
	const at = (h: number, m = 0, day = 26) => new Date(2026, 9, day, h, m);
	const leads = (h: number, m = 0) => [26, 27].map((d) => homeGreeting(at(h, m, d)).lead);

	it("picks the bucket by local hour, boundaries included", () => {
		assert.ok(leads(4, 59).every((l) => ["Burning the midnight oil?", "Quiet hours."].includes(l)));
		assert.ok(leads(5).every((l) => ["Early start.", "Up with the sun."].includes(l)));
		assert.ok(leads(11, 59).every((l) => ["Good morning.", "Morning."].includes(l)));
		assert.ok(leads(12).every((l) => ["Good afternoon.", "Lunch break?"].includes(l)));
		assert.ok(leads(21, 59).every((l) => ["Good evening.", "Evening."].includes(l)));
		assert.ok(leads(22).every((l) => ["Still up?", "Late one."].includes(l)));
		assert.ok(leads(0, 30).every((l) => ["Still up?", "Late one."].includes(l)), "just past midnight is still late");
	});

	it("holds all day and changes with the date", () => {
		assert.deepEqual(homeGreeting(at(18, 5)), homeGreeting(at(21, 40)));
		assert.notDeepEqual(homeGreeting(at(19, 0, 26)), homeGreeting(at(19, 0, 27)));
	});

	it("practice keeps the lead and swaps in a practice tail", () => {
		const learn = homeGreeting(at(9));
		const practise = homeGreeting(at(9), "practice");
		assert.equal(practise.lead, learn.lead);
		assert.ok(["What shall we sharpen?", "Ready for a few problems?"].includes(practise.tail));
	});

	it("a lead that stands alone gets a practice tail", () => {
		const day = [26, 27].find((d) => homeGreeting(at(2, 0, d)).lead === "Burning the midnight oil?")!;
		assert.equal(homeGreeting(at(2, 0, day)).tail, "");
		assert.notEqual(homeGreeting(at(2, 0, day), "practice").tail, "");
	});
});
