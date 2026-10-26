/**
 * v4 redesign (2026-10-26): practice hint rungs on the thinking lane, and
 * the four labelled confidence levels (with the legacy stops still valid).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CONFIDENCE_LEVELS,
	CONFIDENCE_STOPS,
	ChatInputError,
	HINT_RUNGS,
	THINKING_LABEL,
	confidenceLabel,
	hintRequestText,
	inputAppends,
	isAcceptedConfidence,
	newThinkingMessage,
	parseChatInput,
	practiceHintsUsed,
	type LhMarkerMessage,
	type LhMessage,
} from "../src/core/index.ts";

/** A practice record with one cleanly-posed, active problem. */
function posed(callId = "call_p1"): LhMessage[] {
	return [
		{
			id: "m1",
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "problem", arguments: { statement: "Find x." } }],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 1,
		} as LhMessage,
		{ id: "m2", role: "toolResult", toolCallId: callId, toolName: "problem", content: [{ type: "text", text: "Problem posed" }], isError: false, timestamp: 2 } as LhMessage,
	];
}

describe("hint rungs", () => {
	it("labels and request lines are single-sourced", () => {
		assert.deepEqual(HINT_RUNGS.map((r) => r.label), ["Nudge", "Bigger hint", "First step"]);
		assert.equal(hintRequestText(2), "[Hint request — rung 2 of 3: a bigger hint]");
		assert.equal(hintRequestText(1), "[Hint request — rung 1 of 3: a nudge]");
		assert.equal(hintRequestText(3), "[Hint request — rung 3 of 3: the first step]");
	});

	it("a plain submission keeps the exact pre-hint marker shape", () => {
		const m = newThinkingMessage("call_p1", "I tried u-sub");
		assert.equal(m.content, `${THINKING_LABEL}:\nI tried u-sub`);
		assert.deepEqual(m.details, { problemCallId: "call_p1", text: "I tried u-sub" });
	});

	it("a hint request leads with the request line and records the rung", () => {
		const m = newThinkingMessage("call_p1", "stuck at step 2", 2);
		assert.equal(m.content, `[Hint request — rung 2 of 3: a bigger hint]\n\n${THINKING_LABEL}:\nstuck at step 2`);
		assert.deepEqual(m.details, { problemCallId: "call_p1", text: "stuck at step 2", hint: 2 });
		const bare = newThinkingMessage("call_p1", "", 1);
		assert.equal(bare.content, "[Hint request — rung 1 of 3: a nudge]", "no working → the request line alone");
	});

	it("parseChatInput accepts 1|2|3, refuses other rungs, allows an empty-text hint request", () => {
		assert.deepEqual(parseChatInput({ type: "thinking", problemCallId: "p", text: "x", hint: 3 }), {
			type: "thinking",
			problemCallId: "p",
			text: "x",
			hint: 3,
		});
		assert.deepEqual(parseChatInput({ type: "thinking", problemCallId: "p", text: "", hint: 1 }), {
			type: "thinking",
			problemCallId: "p",
			text: "",
			hint: 1,
		});
		assert.equal("hint" in parseChatInput({ type: "thinking", problemCallId: "p", text: "x" }), false);
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "p", text: "x", hint: 4 }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "p", text: "x", hint: "2" }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "thinking", problemCallId: "p", text: "  " }), ChatInputError);
	});

	it("the append carries the rung through to the marker", () => {
		const [marker] = inputAppends({ messages: posed(), kind: "practice" }, { type: "thinking", problemCallId: "call_p1", text: "hmm", hint: 2 });
		assert.equal((marker as LhMarkerMessage).customType, "practice-thinking");
		assert.deepEqual((marker as LhMarkerMessage).details, { problemCallId: "call_p1", text: "hmm", hint: 2 });
	});

	it("practiceHintsUsed folds the rungs of ONE problem, in order", () => {
		const messages: LhMessage[] = [
			...posed(),
			{ ...newThinkingMessage("call_p1", "a"), id: "t1" },
			{ ...newThinkingMessage("call_p1", "b", 1), id: "t2" },
			{ ...newThinkingMessage("call_other", "c", 3), id: "t3" },
			{ ...newThinkingMessage("call_p1", "d", 2), id: "t4" },
		];
		assert.deepEqual(practiceHintsUsed(messages, "call_p1"), [1, 2]);
		assert.deepEqual(practiceHintsUsed(messages, "call_other"), [3]);
		assert.deepEqual(practiceHintsUsed(messages, "call_none"), []);
	});
});

describe("confidence levels", () => {
	it("four labelled levels; the legacy stops stay exported", () => {
		assert.deepEqual(CONFIDENCE_LEVELS, [
			{ label: "Guessing", value: 25 },
			{ label: "Unsure", value: 50 },
			{ label: "Fairly sure", value: 75 },
			{ label: "Certain", value: 95 },
		]);
		assert.deepEqual(CONFIDENCE_STOPS, [0, 30, 50, 70, 90, 100]);
		assert.equal(confidenceLabel(75), "Fairly sure");
		assert.equal(confidenceLabel(70), null, "a legacy stop has no level label");
	});

	it("validation accepts the levels AND the old stops, nothing else", () => {
		for (const v of [25, 50, 75, 95, 0, 30, 70, 90, 100]) assert.equal(isAcceptedConfidence(v), true, String(v));
		for (const v of [10, 51, -1, 101, "50", null]) assert.equal(isAcceptedConfidence(v), false, String(v));
	});

	it("the answer input gate refuses an off-grid confidence, keeps absent and legacy", () => {
		const answer = (confidence?: unknown) => ({
			type: "answer",
			toolCallId: "q",
			answer: { kind: "quiz", questionText: "?", dontKnow: false, answers: [], answeredAt: "x", ...(confidence !== undefined ? { confidence } : {}) },
		});
		assert.doesNotThrow(() => parseChatInput(answer(95)));
		assert.doesNotThrow(() => parseChatInput(answer(70)));
		assert.doesNotThrow(() => parseChatInput(answer()));
		assert.throws(() => parseChatInput(answer(42)), ChatInputError);
	});
});
