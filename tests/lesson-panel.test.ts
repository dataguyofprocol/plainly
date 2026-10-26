/**
 * The lesson panel's plan list (v4 redesign, 2026-10-26): POSITION, never
 * mastery — statuses come from which node the latest tagged check was
 * about, so the counts read "visited", and the current step is the last
 * tagged call's node.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LESSON_PANEL_MIN, planProgress } from "../components/lesson-panel.tsx";
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

	it("the panel threshold leaves a reading column beside a 380px panel", () => {
		assert.ok(LESSON_PANEL_MIN - 380 >= 600);
	});
});
