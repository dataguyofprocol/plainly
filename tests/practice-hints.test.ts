/**
 * Opened hints in the practice dock (owner, 2026-10-27): each hint request
 * (a practice-thinking marker carrying a rung) pairs with the tutor's
 * reply — the text of the assistant message(s) that follow it — and the
 * right panel's resize clamp.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampDockWidth } from "../components/chat.tsx";
import { practiceHints } from "../components/lesson-panel.tsx";

const ask = (problemCallId: string, hint?: number) => ({
	role: "user",
	parts: [{ type: "data-practice-thinking", data: { problemCallId, text: "", hint } }],
});
const reply = (...parts: Array<{ type: string; text?: string }>) => ({ role: "assistant", parts });

describe("practiceHints", () => {
	it("pairs each rung with the tutor's reply text, skipping thinking and tools", () => {
		const hints = practiceHints(
			[
				ask("p1", 1),
				reply({ type: "reasoning", text: "private" }, { type: "text", text: "Look at who owns the String." }, { type: "tool-x" }),
				ask("p1", 2),
				reply({ type: "text", text: "It is dropped" }),
				reply({ type: "text", text: "when make() returns." }),
			] as never,
			"p1",
		);
		assert.deepEqual(hints, [
			{ rung: 1, label: "Nudge", text: "Look at who owns the String." },
			{ rung: 2, label: "Bigger hint", text: "It is dropped\n\nwhen make() returns." },
		]);
	});

	it("ignores other problems and plain working (no rung)", () => {
		const hints = practiceHints([ask("p2", 1), reply({ type: "text", text: "other" }), ask("p1"), reply({ type: "text", text: "not a hint" })] as never, "p1");
		assert.deepEqual(hints, []);
	});

	it("a request with no reply yet has null text (still on its way)", () => {
		assert.deepEqual(practiceHints([ask("p1", 1), reply({ type: "reasoning", text: "…" })] as never, "p1"), [{ rung: 1, label: "Nudge", text: null }]);
	});

	it("a reply ends at the learner's next message", () => {
		const hints = practiceHints([ask("p1", 1), reply({ type: "text", text: "hint" }), { role: "user", parts: [{ type: "text", text: "my answer" }] }, reply({ type: "text", text: "feedback" })] as never, "p1");
		assert.equal(hints[0]!.text, "hint");
	});
});

describe("clampDockWidth", () => {
	it("keeps the panel between 340 and 520px", () => {
		assert.equal(clampDockWidth(200), 340);
		assert.equal(clampDockWidth(430.6), 431);
		assert.equal(clampDockWidth(900), 520);
	});
});
