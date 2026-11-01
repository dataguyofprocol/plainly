import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planProgress, practiceSet, stepFold } from "../components/lesson-panel.tsx";
import type { PlanTree } from "../src/core/index.ts";

const tree: PlanTree = {
	nodes: [
		{ id: "a", title: "A" },
		{ id: "b", title: "B" },
		{ id: "c", title: "C" },
	],
	edges: [],
	version: 1,
};

const quiz = (nodeId: string) => ({ parts: [{ type: "tool-quiz", state: "output-available", input: { nodeId } }] });

describe("planProgress", () => {
	it("no tree → null (the panel shows its empty copy)", () => {
		assert.equal(planProgress(null, []), null);
		assert.equal(planProgress({ nodes: [], edges: [], version: 1 }, []), null);
	});

	it("before any tagged check: all upcoming, no current step", () => {
		const p = planProgress(tree, [])!;
		assert.deepEqual(p.steps.map((s) => s.status), ["upcoming", "upcoming", "upcoming"]);
		assert.equal(p.currentIndex, null);
		assert.equal(p.visited, 0);
	});

	it("the latest tagged call is current; earlier stays are visited", () => {
		const p = planProgress(tree, [quiz("a"), quiz("c")])!;
		assert.deepEqual(p.steps.map((s) => s.status), ["visited", "upcoming", "current"]);
		assert.equal(p.currentIndex, 3, "1-based position in the list");
		assert.equal(p.visited, 1);
		assert.equal(p.total, 3);
	});

	it("untagged or unknown nodes move nothing", () => {
		const p = planProgress(tree, [quiz("zzz"), { parts: [{ type: "tool-quiz", input: {} }] }])!;
		assert.equal(p.currentIndex, null);
	});

});

describe("practiceSet", () => {
	const part = (type: string, state: string, extra: Record<string, unknown> = {}) => ({ parts: [{ type, state, ...extra }] });

	it("settled problems open entries; acked concludes close the latest open one", () => {
		const set = practiceSet([
			part("tool-problem", "input-available", { toolCallId: "p1" }),
			part("tool-conclude", "output-available", { input: { outcome: "solved" } }),
			part("tool-problem", "input-available", { toolCallId: "p2" }),
		]);
		assert.deepEqual(set, [
			{ id: "p1", outcome: "solved" },
			{ id: "p2", outcome: null },
		]);
	});

	it("errored and still-streaming poses count for nothing", () => {
		const set = practiceSet([
			part("tool-problem", "input-streaming", { toolCallId: "p1" }),
			part("tool-problem", "output-error", { toolCallId: "p2" }),
		]);
		assert.deepEqual(set, []);
	});

	it("a conclude without a recognised outcome reads as moved on", () => {
		const set = practiceSet([
			part("tool-problem", "input-available", { toolCallId: "p1" }),
			part("tool-conclude", "output-available", { input: {} }),
		]);
		assert.equal(set[0]!.outcome, "movedOn");
	});
});

describe("stepFold — Lesson4's reading mode", () => {
	const answer = (correct: boolean) => ({ parts: [{ type: "tool-quiz", state: "output-available", input: {}, output: { correct } }] });
	const text = { parts: [{ type: "text" }] };

	it("no plan position yet: nothing folds (the check-in reads in full)", () => {
		assert.equal(stepFold([quiz("a")], planProgress(tree, [])), null);
	});

	it("the current step starts after the last check about another node", () => {
		const messages = [quiz("a"), answer(true), quiz("b"), answer(false), text, quiz("c")];
		const fold = stepFold(messages, planProgress(tree, messages))!;
		assert.equal(fold.startIndex, 3, "after the message holding the check on b");
		assert.equal(fold.startPart, 0);
		assert.deepEqual(fold.heading, { number: 3, title: "C" });
		assert.equal(fold.steps, 2);
		assert.deepEqual(fold.answers, { total: 1, firstTry: 1 }, "graded answers before the step");
	});

	it("still on the first node: nothing above to fold", () => {
		const messages = [text, quiz("a")];
		const fold = stepFold(messages, planProgress(tree, messages))!;
		assert.equal(fold.startIndex, 0);
		assert.equal(fold.steps, 0);
	});

	const check = (nodeId: string, correct: boolean) => ({ type: "tool-quiz", state: "output-available", input: { nodeId }, output: { correct } });

	it("the step changes inside one group: it starts at the part after the last check on another node", () => {
		const group = {
			parts: [{ type: "step-start" }, check("a", true), { type: "step-start" }, { type: "reasoning" }, check("b", true), check("b", false), { type: "text" }],
		};
		const messages = [text, group];
		const fold = stepFold(messages, planProgress(tree, messages))!;
		assert.equal(fold.startIndex, 1, "inside the group, not past it (the empty-page bug)");
		assert.equal(fold.startPart, 2, "right after the check on a");
		assert.deepEqual(fold.heading, { number: 2, title: "B" });
		assert.deepEqual(fold.answers, { total: 1, firstTry: 1 }, "only the check before the cut counts");
	});

	it("a check that closes its group: the step starts at the next message", () => {
		const messages = [{ parts: [{ type: "step-start" }, check("a", true)] }, text, { parts: [check("b", true)] }];
		const fold = stepFold(messages, planProgress(tree, messages))!;
		assert.equal(fold.startIndex, 1);
		assert.equal(fold.startPart, 0);
	});
});
