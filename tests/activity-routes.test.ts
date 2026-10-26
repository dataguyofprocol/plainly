/**
 * The v4 activity routes end-to-end over a real (temp) data dir (redesign,
 * 2026-10-26): POST /api/activity/time, GET /api/chats (progress fields),
 * GET /api/stats, GET /api/stats/daily, GET /api/suggestions, GET
 * /api/topics. The LH_DATA_DIR seam is set BEFORE any config-loading
 * import, so every app-module import is dynamic. No network: under
 * NODE_ENV=test the suggestions service never resolves a generator.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-activity-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { stores } = await import("../src/server/stores.ts");
const { newGraphContextMessage } = await import("../src/core/native-messages.ts");
const timeRoute = await import("../app/api/activity/time/route.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
const statsRoute = await import("../app/api/stats/route.ts");
const dailyRoute = await import("../app/api/stats/daily/route.ts");
const suggestionsRoute = await import("../app/api/suggestions/route.ts");
const topicsRoute = await import("../app/api/topics/route.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const call = (id: string, name: string, args: unknown): LhMessage =>
	({ id: `m_${id}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], api: "faux", provider: "faux", model: "faux", usage, stopReason: "toolUse", timestamp: Date.now() }) as LhMessage;
const result = (id: string, toolName: string, details?: unknown): LhMessage =>
	({ id: `r_${id}`, role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text: "ok" }], details, isError: false, timestamp: Date.now() }) as LhMessage;

const post = (body: unknown) =>
	timeRoute.POST(new Request("http://localhost/api/activity/time", { method: "POST", body: JSON.stringify(body) }));

let teachId = "";
let practiceId = "";

before(() => {
	const teach = stores.chatStore.createChat("Calculus");
	teachId = teach.id;
	stores.chatStore.saveTree(teachId, {
		nodes: [
			{ id: "a", title: "A" },
			{ id: "b", title: "B" },
		],
		edges: [],
		version: 1,
	});
	stores.chatStore.saveMessages(teachId, [
		call("q1", "quiz", { question: "First?", nodeId: "a" }),
		result("q1", "quiz", { kind: "quiz", questionText: "First?", dontKnow: false, answers: [], correct: true, answeredAt: "x" }),
		call("q2", "quiz", { question: "What is **B**?", nodeId: "b" }),
	]);
	// the graph: three propositions born in the teach session (a cluster)
	for (const [i, id] of ["n_1", "n_2", "n_3"].entries()) {
		stores.graphStore.appendNode({
			id,
			name: `Idea ${i}`,
			statement: `Statement ${i}`,
			aliases: [],
			createdAt: new Date(Date.now() - i * 1000).toISOString(),
			provenance: [{ chatId: teachId, messageId: "m_q1" }],
		});
	}
	const practice = stores.chatStore.createChat("Practice", "practice");
	practiceId = practice.id;
	stores.chatStore.saveMessages(practiceId, [
		{ ...newGraphContextMessage([{ id: "n_2", name: "Idea 1", statement: "Statement 1" }], []), id: "g1" } as LhMessage,
		call("p1", "problem", { statement: "Show that $x>0$." }),
		result("p1", "problem"),
	]);
});

describe("POST /api/activity/time", () => {
	it("appends a clamped beat for a known chat; 204", async () => {
		const res = await post({ chatId: teachId, seconds: 600 });
		assert.equal(res.status, 204);
		const files = fs.readdirSync(path.join(TMP_DATA, "time"));
		assert.equal(files.length, 1);
		assert.match(files[0]!, /^\d{4}-\d{2}\.jsonl$/);
		const lines = fs.readFileSync(path.join(TMP_DATA, "time", files[0]!), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(lines.length, 1);
		assert.equal(lines[0].chatId, teachId);
		assert.equal(lines[0].seconds, 60, "clamped to 60");
		assert.ok(Number.isFinite(Date.parse(lines[0].at)));
	});

	it("unknown chat and zero credit: 204, nothing appended", async () => {
		const before = fs.readFileSync(path.join(TMP_DATA, "time", fs.readdirSync(path.join(TMP_DATA, "time"))[0]!), "utf-8");
		assert.equal((await post({ chatId: "chat_nope_x", seconds: 30 })).status, 204);
		assert.equal((await post({ chatId: "../../etc", seconds: 30 })).status, 204);
		assert.equal((await post({ chatId: teachId, seconds: -3 })).status, 204);
		const afterText = fs.readFileSync(path.join(TMP_DATA, "time", fs.readdirSync(path.join(TMP_DATA, "time"))[0]!), "utf-8");
		assert.equal(afterText, before);
	});

	it("malformed body: 400", async () => {
		assert.equal((await post({ chatId: teachId })).status, 400);
		assert.equal((await post({ chatId: 3, seconds: 3 })).status, 400);
		const raw = await timeRoute.POST(new Request("http://localhost/api/activity/time", { method: "POST", body: "{" }));
		assert.equal(raw.status, 400);
	});
});

describe("GET /api/chats — v4 progress fields", () => {
	it("teach + practice rows carry state, pending text, plan, minutes, answers, set", async () => {
		const { chats } = (await (await chatsRoute.GET()).json()) as { chats: Array<Record<string, unknown>> };
		const teach = chats.find((c) => c.id === teachId)!;
		assert.equal(teach.state, "waiting");
		assert.equal(teach.pendingQuestionText, "What is B?");
		assert.deepEqual(teach.plan, { total: 2, visited: 1, current: 2 });
		assert.equal(teach.minutes, 1);
		assert.deepEqual(teach.answers, { total: 1, firstTry: 1 });
		assert.equal(teach.practiceSet, null);
		assert.equal("progress" in teach, false, "the nested fold never ships");
		assert.equal(teach.busy, false);

		const practice = chats.find((c) => c.id === practiceId)!;
		assert.equal(practice.state, "waiting");
		assert.equal(practice.pendingProblem, true);
		assert.equal(practice.pendingQuestionText, "Show that $x>0$.");
		assert.deepEqual(practice.practiceSet, { size: 5, done: 0 });
		assert.equal(practice.plan, null);
		assert.equal(practice.answers, null);
		assert.equal(practice.minutes, 0);
	});
});

describe("GET /api/stats", () => {
	it("week shape over the data dir", async () => {
		const res = await statsRoute.GET(new Request("http://localhost/api/stats?period=week"));
		assert.equal(res.status, 200);
		const s = await res.json();
		assert.equal(s.period, "week");
		assert.equal(s.time.seconds, 60);
		assert.equal(s.time.prevSeconds, 0);
		assert.deepEqual(s.lessons, { active: 1, waiting: 1, finished: 0, allTime: 1 });
		assert.deepEqual(s.ideas, { added: 3, total: 3 });
		assert.deepEqual(s.practice, { problems: 0, solid: 0 });
		assert.deepEqual(s.tokens, { total: 0, dollars: 0 });
	});

	it("month is accepted; absent defaults to week; junk is a 400", async () => {
		assert.equal((await (await statsRoute.GET(new Request("http://localhost/api/stats?period=month"))).json()).period, "month");
		assert.equal((await (await statsRoute.GET(new Request("http://localhost/api/stats"))).json()).period, "week");
		assert.equal((await statsRoute.GET(new Request("http://localhost/api/stats?period=year"))).status, 400);
	});
});

describe("GET /api/stats/daily", () => {
	it("the current week against the factory goal", async () => {
		const d = await (await dailyRoute.GET()).json();
		assert.equal(d.goalMinutes, 30);
		assert.equal(d.days.length, 7);
		assert.equal(d.days[0].label, "Mon");
		const today = d.days.find((x: { today: boolean }) => x.today);
		assert.equal(today.minutes, 1);
		assert.equal(d.metDays, 0);
	});
});

describe("GET /api/suggestions", () => {
	it("no cache, no generator under test: [] immediately, never blocks", async () => {
		assert.deepEqual(await (await suggestionsRoute.GET()).json(), { suggestions: [], generatedAt: null });
		assert.equal(fs.existsSync(path.join(TMP_DATA, "suggestions.json")), false);
	});
});

describe("GET /api/topics", () => {
	it("one topic per cluster, named by the birth session, last practiced via graph-context", async () => {
		const { topics } = await (await topicsRoute.GET()).json();
		assert.equal(topics.length, 1);
		const t = topics[0];
		assert.equal(t.id, teachId);
		assert.equal(t.name, "Calculus");
		assert.deepEqual([...t.ideaIds].sort(), ["n_1", "n_2", "n_3"]);
		assert.ok(t.lastLearnedAt);
		assert.equal(t.lastPracticedAt, stores.chatStore.getChat(practiceId)!.updatedAt);
	});
});
