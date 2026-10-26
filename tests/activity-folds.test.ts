/**
 * The v4 activity folds (core/activity.ts, redesign 2026-10-26): time
 * ledger aggregation, session progress + state, period stats, topics.
 * Dates are built with LOCAL constructors so the suite is time-zone
 * independent (the folds bucket by the process's local zone).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	answerStatsOf,
	beatSecondsByChat,
	beatSecondsIn,
	buildStats,
	callTokens,
	chatProgressOf,
	chatStateOf,
	clampBeatSeconds,
	concludedProblemsOf,
	dailyStats,
	fileTopicName,
	foldUsage,
	graphContextIdsOf,
	localDateKey,
	localMonthKey,
	newGraphContextMessage,
	periodWindow,
	plainText,
	practiceSetOf,
	topicsOf,
	weekStartOf,
	type GraphNode,
	type LhMessage,
	type PlanTree,
	type TimeBeat,
} from "../src/core/index.ts";

// ── record builders ─────────────────────────────────────────────────────────

let seq = 0;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function call(name: string, args: unknown, id = `call_${++seq}`): LhMessage {
	return {
		id: `m_${++seq}`,
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args as Record<string, unknown> }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	} as LhMessage;
}
function result(callId: string, toolName: string, details: unknown, timestamp = 0, isError = false): LhMessage {
	return { id: `m_${++seq}`, role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp } as LhMessage;
}
const quizAnswer = (correct: boolean, o: Record<string, unknown> = {}) => ({ kind: "quiz", questionText: "?", dontKnow: false, answers: [], correct, answeredAt: "x", ...o });

const TREE: PlanTree = {
	nodes: [
		{ id: "a", title: "A" },
		{ id: "b", title: "B" },
		{ id: "c", title: "C" },
	],
	edges: [],
	version: 1,
};

// ── time ledger ─────────────────────────────────────────────────────────────

describe("time ledger folds", () => {
	it("clamps a beat to 0..60", () => {
		assert.equal(clampBeatSeconds(30), 30);
		assert.equal(clampBeatSeconds(600), 60);
		assert.equal(clampBeatSeconds(-5), 0);
		assert.equal(clampBeatSeconds(Number.NaN), 0);
		assert.equal(clampBeatSeconds("30"), 0);
	});

	it("local keys and week/month starts", () => {
		const d = new Date(2026, 9, 28, 15, 30); // Wed 28 Oct 2026
		assert.equal(localDateKey(d), "2026-10-28");
		assert.equal(localMonthKey(d), "2026-10");
		assert.equal(weekStartOf(d).getTime(), new Date(2026, 9, 26).getTime(), "Monday 00:00");
		assert.equal(weekStartOf(new Date(2026, 10, 1, 9)).getTime(), new Date(2026, 9, 26).getTime(), "Sunday belongs to the week before");
	});

	it("the previous equal period spans the same elapsed time", () => {
		const now = new Date(2026, 9, 28, 12); // Wed noon
		const w = periodWindow("week", now);
		assert.equal(w.start.getTime(), new Date(2026, 9, 26).getTime());
		assert.equal(w.prevStart.getTime(), new Date(2026, 9, 19).getTime());
		assert.equal(w.prevEnd.getTime(), new Date(2026, 9, 21, 12).getTime(), "last Wed noon");
		const m = periodWindow("month", new Date(2026, 2, 31, 12)); // 31 Mar
		assert.equal(m.start.getTime(), new Date(2026, 2, 1).getTime());
		assert.equal(m.prevStart.getTime(), new Date(2026, 1, 1).getTime());
		assert.ok(m.prevEnd.getTime() <= m.start.getTime(), "capped at this month's start");
	});

	it("sums beats per window and per chat", () => {
		const beats: TimeBeat[] = [
			{ chatId: "c1", at: new Date(2026, 9, 26, 9).toISOString(), seconds: 30 },
			{ chatId: "c1", at: new Date(2026, 9, 27, 9).toISOString(), seconds: 30 },
			{ chatId: "c2", at: new Date(2026, 9, 20, 9).toISOString(), seconds: 60 },
		];
		assert.equal(beatSecondsIn(beats, new Date(2026, 9, 26), new Date(2026, 9, 28)), 60);
		assert.equal(beatSecondsIn(beats, new Date(2026, 9, 19), new Date(2026, 9, 26)), 60);
		assert.deepEqual([...beatSecondsByChat(beats)], [["c1", 60], ["c2", 60]]);
	});

	it("daily: Mon..Sun, rounded minutes, today flag, future zero, met days", () => {
		const now = new Date(2026, 9, 28, 20); // Wed
		const beats: TimeBeat[] = [];
		const add = (day: number, minutes: number) => {
			for (let i = 0; i < minutes * 2; i++) beats.push({ chatId: "c", at: new Date(2026, 9, day, 10, 0, i * 30).toISOString(), seconds: 30 });
		};
		add(26, 31); // Mon — met
		add(27, 10); // Tue — not met
		add(28, 30); // Wed (today) — met
		beats.push({ chatId: "c", at: new Date(2026, 9, 30, 10).toISOString(), seconds: 60 }); // future (clock skew) — ignored
		const d = dailyStats(beats, now, 30);
		assert.equal(d.goalMinutes, 30);
		assert.deepEqual(d.days.map((x) => x.label), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
		assert.deepEqual(d.days.map((x) => x.minutes), [31, 10, 30, 0, 0, 0, 0]);
		assert.deepEqual(d.days.map((x) => x.today), [false, false, true, false, false, false, false]);
		assert.equal(d.days[0]!.date, "2026-10-26");
		assert.equal(d.metDays, 2);
	});
});

// ── session progress ────────────────────────────────────────────────────────

describe("plainText", () => {
	it("strips markdown, collapses whitespace, caps on a word boundary", () => {
		assert.equal(plainText("**What** is `x`?\n\n> see [the doc](http://x)"), "What is x? see the doc");
		assert.equal(plainText(42), null);
		assert.equal(plainText("   "), null);
		const long = plainText("word ".repeat(60))!;
		assert.ok(long.length <= 140 && long.endsWith("…"));
		const math = plainText(`${"a ".repeat(60)}$x^2 + y^2 = z^2$ tail`, 140)!;
		assert.equal((math.match(/\$/g)?.length ?? 0) % 2, 0, "never an unbalanced math delimiter");
	});
});

describe("chatProgressOf — teach", () => {
	it("no plan: paused, plan null, answers counted", () => {
		const p = chatProgressOf({ messages: [] });
		assert.equal(p.restingState, "paused");
		assert.equal(p.plan, null);
		assert.deepEqual(p.answers, { total: 0, firstTry: 0 });
		assert.equal(p.practiceSet, null);
	});

	it("plan position from tagged quiz CALLS; waiting on a pending question with its text", () => {
		const q1 = call("quiz", { question: "Q1", nodeId: "a" }, "q1");
		const q2 = call("quiz", { question: "**Why** does B hold?", nodeId: "b" }, "q2");
		const messages = [q1, result("q1", "quiz", quizAnswer(true)), q2];
		const p = chatProgressOf({ tree: TREE, messages });
		assert.deepEqual(p.plan, { total: 3, visited: 1, current: 2 });
		assert.equal(p.restingState, "waiting");
		assert.equal(p.pendingQuestionText, "Why does B hold?");
		assert.deepEqual(p.answers, { total: 1, firstTry: 1 });
	});

	it("finished: current is the last plan node and nothing pending", () => {
		const messages = [
			call("quiz", { question: "Q", nodeId: "a" }, "x1"),
			result("x1", "quiz", quizAnswer(false)),
			call("quiz", { question: "Q", nodeId: "c" }, "x2"),
			result("x2", "quiz", quizAnswer(true)),
		];
		const p = chatProgressOf({ tree: TREE, messages });
		assert.equal(p.restingState, "finished");
		assert.deepEqual(p.plan, { total: 3, visited: 1, current: 3 });
	});

	it("finished: every node reached even when the last stay is not the last node", () => {
		const messages = ["c", "b", "a"].flatMap((n, i) => [call("quiz", { question: "Q", nodeId: n }, `y${i}`), result(`y${i}`, "quiz", quizAnswer(true))]);
		assert.equal(chatProgressOf({ tree: TREE, messages }).restingState, "finished");
	});

	it("answers: dismissals and ask/explain never count; dontKnow is a graded miss", () => {
		const messages = [
			result("r1", "quiz", quizAnswer(true)),
			result("r2", "probe", quizAnswer(false, { dontKnow: true })),
			result("r3", "quiz", { kind: "quiz", dismissed: true }),
			result("r4", "ask_user_question", { kind: "ask" }),
			result("r5", "explain", { kind: "explain" }),
			result("r6", "quiz", quizAnswer(true), 0, true),
		];
		assert.deepEqual(answerStatsOf(messages), { total: 2, firstTry: 1 });
	});
});

describe("chatProgressOf — practice", () => {
	function problem(i: number, outcome?: string, at = 1000): LhMessage[] {
		const out = [call("problem", { statement: `Problem ${i}` }, `p${i}`), result(`p${i}`, "problem", undefined)];
		if (outcome) out.push(call("conclude", { outcome }, `c${i}`), result(`c${i}`, "conclude", undefined, at));
		return out;
	}

	it("sets of five: done counts the current set; a closed set reads finished", () => {
		assert.deepEqual(practiceSetOf(0, false), { size: 5, done: 0, complete: false });
		assert.deepEqual(practiceSetOf(3, true), { size: 5, done: 3, complete: false });
		assert.deepEqual(practiceSetOf(5, false), { size: 5, done: 5, complete: true });
		assert.deepEqual(practiceSetOf(5, true), { size: 5, done: 0, complete: false });
		assert.deepEqual(practiceSetOf(7, false), { size: 5, done: 2, complete: false });
	});

	it("active problem → waiting with its statement", () => {
		const messages = [...problem(1, "solved"), ...problem(2)];
		const p = chatProgressOf({ kind: "practice", messages });
		assert.equal(p.restingState, "waiting");
		assert.equal(p.pendingQuestionText, "Problem 2");
		assert.deepEqual(p.practiceSet, { size: 5, done: 1 });
		assert.equal(p.plan, null);
		assert.equal(p.answers, null);
	});

	it("five concluded and nothing active → finished; fewer → paused", () => {
		const five = [1, 2, 3, 4, 5].flatMap((i) => problem(i, "solved"));
		assert.equal(chatProgressOf({ kind: "practice", messages: five }).restingState, "finished");
		assert.equal(chatProgressOf({ kind: "practice", messages: five.slice(0, 16) }).restingState, "paused");
	});

	it("concludes count only through clean results, with their outcome and time", () => {
		const messages = [
			...problem(1, "solved", Date.UTC(2026, 9, 26)),
			call("conclude", { outcome: "movedOn" }, "bad"),
			result("bad", "conclude", undefined, 0, true),
			...problem(2, "dismissed", Date.UTC(2026, 9, 27)),
		];
		assert.deepEqual(concludedProblemsOf(messages), [
			{ outcome: "solved", at: new Date(Date.UTC(2026, 9, 26)).toISOString() },
			{ outcome: "dismissed", at: new Date(Date.UTC(2026, 9, 27)).toISOString() },
		]);
	});

	it("state: busy outranks the resting state", () => {
		assert.equal(chatStateOf({ restingState: "waiting" }, true), "working");
		assert.equal(chatStateOf({ restingState: "finished" }, false), "finished");
	});
});

// ── stats ───────────────────────────────────────────────────────────────────

describe("usage + stats", () => {
	it("tokens = input + output + cache read + cache write", () => {
		assert.equal(callTokens({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1, reasoningTokens: 3 }), 116);
		assert.equal(callTokens({}), 0);
	});

	it("dollars: priced sum; null only when parts exist and none priced; 0 when empty", () => {
		const s = new Date(2026, 9, 26);
		const e = new Date(2026, 9, 28);
		const at = new Date(2026, 9, 27).toISOString();
		assert.deepEqual(foldUsage([{ at, tokens: 10, dollars: 0.5 }, { at, tokens: 5, dollars: null }], s, e), { total: 15, dollars: 0.5 });
		assert.deepEqual(foldUsage([{ at, tokens: 5, dollars: null }], s, e), { total: 5, dollars: null });
		assert.deepEqual(foldUsage([], s, e), { total: 0, dollars: 0 });
		assert.deepEqual(foldUsage([{ at: new Date(2026, 9, 1).toISOString(), tokens: 9, dollars: 1 }], s, e), { total: 0, dollars: 0 });
	});

	it("buildStats folds lessons, ideas, practice, time, tokens over the period", () => {
		const now = new Date(2026, 9, 28, 12);
		const inWeek = new Date(2026, 9, 27).toISOString();
		const before = new Date(2026, 9, 10).toISOString();
		const progress = (restingState: "waiting" | "finished" | "paused") => ({ restingState, pendingQuestionText: null, plan: null, answers: null, practiceSet: null });
		const concludeAt = new Date(2026, 9, 27, 9).getTime();
		const practiceMessages = [
			call("problem", { statement: "P" }, "pp1"),
			result("pp1", "problem", undefined),
			call("conclude", { outcome: "solved" }, "cc1"),
			result("cc1", "conclude", undefined, concludeAt),
			call("problem", { statement: "P" }, "pp2"),
			result("pp2", "problem", undefined),
			call("conclude", { outcome: "solvedWithHints" }, "cc2"),
			result("cc2", "conclude", undefined, concludeAt),
		];
		const node = (id: string, createdAt: string): GraphNode => ({ id, name: id, statement: id, aliases: [], createdAt, provenance: [] });
		const stats = buildStats(
			{
				chats: [
					{ kind: "teach", updatedAt: inWeek, messages: [], progress: progress("waiting") },
					{ kind: "teach", updatedAt: inWeek, messages: [], progress: progress("finished") },
					{ kind: "teach", updatedAt: before, messages: [], progress: progress("paused") },
					{ kind: "practice", updatedAt: inWeek, messages: practiceMessages, progress: progress("paused") },
				],
				nodes: [node("n1", inWeek), node("n1", before), node("n2", before)],
				beats: [
					{ chatId: "c", at: inWeek, seconds: 60 },
					{ chatId: "c", at: new Date(2026, 9, 20).toISOString(), seconds: 30 },
					{ chatId: "c", at: new Date(2026, 9, 22).toISOString(), seconds: 30 }, // after last Wed noon — outside prev window
				],
				usage: [{ at: inWeek, tokens: 1000, dollars: 0.01 }],
			},
			"week",
			now,
		);
		assert.deepEqual(stats, {
			period: "week",
			time: { seconds: 60, prevSeconds: 30 },
			lessons: { active: 1, waiting: 1, finished: 1, allTime: 3 },
			ideas: { added: 1, total: 2 },
			practice: { problems: 2, solid: 1 },
			tokens: { total: 1000, dollars: 0.01 },
		});
	});
});

// ── topics ──────────────────────────────────────────────────────────────────

describe("topics", () => {
	it("graph-context picks are read off the marker", () => {
		const marker = { ...newGraphContextMessage([{ id: "n1", name: "N", statement: "S" }], []), id: "g" } as LhMessage;
		assert.deepEqual(graphContextIdsOf([marker]), ["n1"]);
		assert.deepEqual(graphContextIdsOf([]), []);
	});

	it("file names drop the directory and extension", () => {
		assert.equal(fileTopicName("/notes/Linear Algebra.md"), "Linear Algebra");
		assert.equal(fileTopicName("C:\\notes\\x.txt"), "x");
		assert.equal(fileTopicName(".bashrc"), ".bashrc");
	});

	it("one topic per cluster: names, proposition ids only, last learned/practiced, newest first", () => {
		const node = (id: string, createdAt: string): GraphNode => ({ id, name: id, statement: id, aliases: [], createdAt, provenance: [] });
		const topics = topicsOf({
			clusters: [
				{ id: "chat_a", label: "Calculus", members: ["n1", "n2", "arg_x"] },
				{ id: "src_b", label: "/notes/Physics.md", members: ["n3"] },
				{ id: "chat_gone", label: null, members: ["n4"] },
			],
			propositions: [node("n1", "2026-10-01T00:00:00.000Z"), node("n2", "2026-10-05T00:00:00.000Z"), node("n3", "2026-10-20T00:00:00.000Z"), node("n4", "2026-09-01T00:00:00.000Z"), node("n1", "2026-12-01T00:00:00.000Z")],
			sessions: { chat_a: "Calculus" },
			fileSources: { src_b: "/notes/Physics.md" },
			practice: [
				{ updatedAt: "2026-10-10T00:00:00.000Z", pickedIds: ["n2"] },
				{ updatedAt: "2026-10-12T00:00:00.000Z", pickedIds: ["n1", "zz"] },
				{ updatedAt: "2026-10-30T00:00:00.000Z", pickedIds: ["other"] },
			],
		});
		assert.deepEqual(topics, [
			{ id: "src_b", name: "Physics", ideaIds: ["n3"], lastLearnedAt: "2026-10-20T00:00:00.000Z", lastPracticedAt: null },
			{ id: "chat_a", name: "Calculus", ideaIds: ["n1", "n2"], lastLearnedAt: "2026-10-05T00:00:00.000Z", lastPracticedAt: "2026-10-12T00:00:00.000Z" },
			{ id: "chat_gone", name: "n4", ideaIds: ["n4"], lastLearnedAt: "2026-09-01T00:00:00.000Z", lastPracticedAt: null },
		]);
	});
});

describe("plainText — math reads as its content", () => {
	it("drops TeX delimiters and commands, keeps subscripts", () => {
		assert.equal(
			plainText("After the step the belief stands at \\(p^- = 0.44\\), with \\frac{1}{2} and $p_1 = 0.70$"),
			"After the step the belief stands at p^- = 0.44, with 1/2 and p_1 = 0.70",
		);
	});
	it("still strips Markdown emphasis", () => {
		assert.equal(plainText("**Bold** and _em_ and `code`"), "Bold and em and code");
	});
});
