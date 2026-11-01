import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { healEncodedArguments } from "../src/core/argument-heal.ts";
import { stripModelValueDebris } from "../src/core/value-debris.ts";
import {
	coerceCorrectAnswer,
	normalizeQuizType,
	quizInputObject,
	quizInputProblems,
} from "../src/core/question-core.ts";
import { parseQuizInput } from "../src/core/tool-parts.ts";
import { resolveTargetId } from "../src/core/chains.ts";
import { bareQuestionTools } from "../src/agent/teacher-agent.ts";
import { probeQuizTool } from "../src/agent/tools.ts";

function QUOTED(value: string): string {
	return `"${value}"`;
}

function whiteheadQuiz(type: unknown, correctAnswer: unknown) {
	return {
		question: "What was Parmenides' claim?",
		options: [
			{ label: "Being is changeless and complete", value: "parmenides" },
			{ label: "Becoming is fundamental", value: "heraclitus" },
			{ label: "Split world", value: "split" },
			{ label: "Both unreal", value: "both-illusion" },
		],
		explanation: "What truly *is* cannot come to be or pass away — the flux is appearance.",
		correctAnswer,
		type,
		nodeId: "experience-first",
	};
}

describe("the death-loop shape — quiz type with quotes baked in", () => {
	it("heals the quote-encoded literal (the ten-retry loop)", () => {
		const healed = healEncodedArguments({ type: QUOTED("predict") }, quizInputObject) as {
			type: unknown;
		};
		assert.equal(healed.type, "predict");
	});

	it("END-TO-END: the healed args pass pi-ai validation where the raw threw", () => {
		const raw = whiteheadQuiz(QUOTED("predict"), ["parmenides"]);
		assert.throws(() => {
			validateToolArguments({ name: "quiz", parameters: quizInputObject } as never, {
				id: "call_x",
				type: "toolCall",
				name: "quiz",
				arguments: raw,
			} as never);
		});
		const validated = validateToolArguments(
			{ name: "quiz", parameters: quizInputObject } as never,
			{
				id: "call_x",
				type: "toolCall",
				name: "quiz",
				arguments: healEncodedArguments(raw, quizInputObject),
			} as never,
		);
		assert.equal((validated as { type: unknown }).type, "predict");
	});

	it("WIRING: bareQuestionTools (the registry with NO prepareArguments) now heals", () => {
		const tools = bareQuestionTools();
		const quiz = tools.quiz;
		assert.ok(quiz, "the bare quiz must exist");
		assert.ok(quiz.prepareArguments, "the bare quiz must carry the standard heal");
		const healed = quiz.prepareArguments!(
			whiteheadQuiz(QUOTED("predict"), ["parmenides"]),
		) as { type: unknown };
		assert.equal(healed.type, "predict");
	});

	it("WIRING: the 2026-09-26 string-options shape heals through the bare quiz too", () => {
		const quiz = bareQuestionTools().quiz;
		assert.ok(quiz?.prepareArguments, "the bare quiz must carry the standard heal");
		const input = whiteheadQuiz("predict", ["parmenides"]);
		const stringified = { ...input, options: JSON.stringify(input.options) };
		const healed = quiz.prepareArguments!(stringified) as { options: unknown };
		assert.ok(Array.isArray(healed.options), "the JSON string heals to the array");
		assert.equal(
				(healed.options as Array<{ value?: string }>)[0]?.value,
			"parmenides",
		);
	});
});

describe("the colon shape — correctAnswer with copy-syntax debris", () => {
	it("stripModelValueDebris: the observed shapes heal, interiors stay", () => {
		assert.equal(stripModelValueDebris(":parmenides"), "parmenides");
		assert.equal(stripModelValueDebris(QUOTED("predict")), "predict");
		assert.equal(stripModelValueDebris(`: "primary-external" `), "primary-external");
		assert.equal(stripModelValueDebris("`value`"), "value");
		assert.equal(stripModelValueDebris("a:b"), "a:b");
		assert.equal(stripModelValueDebris('["x"]'), '["x"]');
	});

	it("coerceCorrectAnswer cleans non-matching entries (boundary check + grading seam)", () => {
		assert.deepEqual(coerceCorrectAnswer([":parmenides"], ["parmenides"]), ["parmenides"]);
		assert.deepEqual(coerceCorrectAnswer(QUOTED("primary-external"), ["primary-external"]), ["primary-external"]);
	});

	it("the incident's exact call passes the semantic boundary (quizInputProblems)", () => {
		const input = whiteheadQuiz("predict", [":parmenides"]) as Parameters<
			typeof quizInputProblems
		>[0];
		assert.deepEqual(quizInputProblems(input), []);
	});

	it("normalizeQuizType heals a persisted wobbled record", () => {
		assert.equal(normalizeQuizType(QUOTED("predict")), "predict");
		assert.equal(normalizeQuizType('"check"'), "check");
		assert.equal(normalizeQuizType(undefined), undefined);
		assert.equal(normalizeQuizType("bogus"), undefined);
	});

	it("resolveTargetId heals copy-syntax on targets", () => {
		const nodes = [{ id: "experience-first", name: "Experience first" }];
		assert.equal(resolveTargetId(":experience-first", nodes), "experience-first");
		assert.equal(resolveTargetId('"Experience first"', nodes), "experience-first");
		assert.equal(resolveTargetId("nope", nodes), null);
	});
});

describe("the calculus retry loop — an exact answer was incorrectly stripped", () => {
	it("the real probe tool accepts a label with its sentence-final period", async () => {
		const input = {
			question: "Which claim?",
			options: [{ label: "The claim holds." }, { label: "The claim need not hold." }],
			explanation: "The premise does not imply the claim.",
			correctAnswer: "The claim need not hold.",
		};
		const validated = validateToolArguments(probeQuizTool, {
			type: "toolCall",
			id: "calculus-period",
			name: "probe",
			arguments: probeQuizTool.prepareArguments!(input),
		});
		assert.equal(validated.correctAnswer, input.correctAnswer);
		const result = await probeQuizTool.execute("calculus-period", validated);
		assert.notEqual(result.isError, true, "an already-exact answer must not trigger a retry");
		assert.equal(result.terminate, true, "the valid question is posed normally");
	});
});

describe("the display mirror — raw records heal on read", () => {
	it("parseQuizInput renders the incident's persisted raw record (no invisible quiz)", () => {
		const raw = whiteheadQuiz(QUOTED("predict"), [":parmenides"]);
		const parsed = parseQuizInput(raw);
		assert.ok(parsed, "the wobbled record must parse — else the quiz is invisible");
		assert.equal(normalizeQuizType(parsed?.type), "predict");
		assert.deepEqual(parsed ? coerceCorrectAnswer(parsed.correctAnswer, parsed.options.map((o) => o.value ?? o.label)) : [], ["parmenides"]);
	});
});
