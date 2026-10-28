/**
 * THE POKER SESSION PINS (owner, 2026-10-28): glm-5.3 double-escaped every
 * probe `explanation` — the record holds the two characters `\` + `n` where
 * a paragraph break was meant, so the Why block showed a literal `\n\n`;
 * gpt-5.6-luna copied the pattern later in the same session.
 *
 * The fixes these pins hold:
 *  1. decodeOverescapedNewlines — only strings with no real newline, only
 *     unescaped `\n` outside math and code spans.
 *  2. healProseEscapes — opt-in per field (question-core's prose lists),
 *     never schema-wide.
 *  3. Both seams — the question tools' prepareArguments and the display
 *     parses (the tool-parts law).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeOverescapedNewlines } from "../src/core/math-delims.ts";
import { healProseEscapes } from "../src/core/argument-heal.ts";
import { ASK_PROSE_FIELDS, QUIZ_PROSE_FIELDS } from "../src/core/question-core.ts";
import { parseAskInput, parseExplainInput, parseQuizInput } from "../src/core/tool-parts.ts";
import { askUserQuestionTool, probeQuizTool } from "../src/agent/tools.ts";

/** The session's exact shape (shortened): literal backslash-n, no real newline. */
const POKER = "Calling has exactly one way to win: hit your hand.\\n\\nThe distractors: betting does not change the card.";

describe("decodeOverescapedNewlines", () => {
	it("decodes the poker explanation into a real paragraph break", () => {
		assert.equal(
			decodeOverescapedNewlines(POKER),
			"Calling has exactly one way to win: hit your hand.\n\nThe distractors: betting does not change the card.",
		);
	});

	it("leaves math spans alone — \\nabla, \\neq, \\nu survive", () => {
		const text = "Gradient $\\nabla f$ and \\(a \\neq b\\) and $$\\nu$$\\n\\nNext.";
		assert.equal(decodeOverescapedNewlines(text), "Gradient $\\nabla f$ and \\(a \\neq b\\) and $$\\nu$$\n\nNext.");
	});

	it("leaves code spans and escaped backslashes alone", () => {
		assert.equal(decodeOverescapedNewlines("Use `a\\nb` here\\nthen"), "Use `a\\nb` here\nthen");
		assert.equal(decodeOverescapedNewlines("a literal \\\\n stays"), "a literal \\\\n stays");
	});

	it("a string with a real newline meant its \\n text literally", () => {
		const text = "line one\nprintf(\"\\n\")";
		assert.equal(decodeOverescapedNewlines(text), text);
	});

	it("is idempotent", () => {
		const once = decodeOverescapedNewlines(POKER);
		assert.equal(decodeOverescapedNewlines(once), once);
	});
});

describe("healProseEscapes", () => {
	it("heals only the named fields, nested option fields included", () => {
		const args = {
			question: "Q?\\n\\nMore.",
			options: [{ label: "A", description: "one\\ntwo" }, { label: "B" }],
			code: "x\\ny",
		};
		const healed = healProseEscapes(args, ASK_PROSE_FIELDS) as typeof args;
		assert.equal(healed.question, "Q?\n\nMore.");
		assert.equal(healed.options[0]!.description, "one\ntwo");
		assert.equal(healed.options[1], args.options[1], "untouched items keep their reference");
		assert.equal(healed.code, "x\\ny", "a field off the list is never touched");
		assert.equal(args.question, "Q?\\n\\nMore.", "input is not mutated");
	});

	it("well-formed args pass through as the same reference", () => {
		const args = { question: "Q?", explanation: "Clean.\n\nTwo paragraphs." };
		assert.equal(healProseEscapes(args, QUIZ_PROSE_FIELDS), args);
	});
});

describe("both seams", () => {
	const quiz = {
		question: "Why bet?",
		options: [{ label: "Fold equity" }, { label: "Bigger pot" }],
		correctAnswer: "Fold equity",
		explanation: POKER,
	};

	it("the boundary: probe and ask prepareArguments decode", () => {
		const probe = probeQuizTool.prepareArguments!(quiz) as typeof quiz;
		assert.match(probe.explanation, /hand\.\n\nThe/);
		const ask = askUserQuestionTool.prepareArguments!({ question: "Which game?\\nPick one." }) as { question: string };
		assert.equal(ask.question, "Which game?\nPick one.");
	});

	it("the display: quiz, ask and explain parses decode raw records", () => {
		assert.match(parseQuizInput(quiz)!.explanation, /hand\.\n\nThe/);
		assert.equal(parseAskInput({ question: "Which game?\\nPick one." })!.question, "Which game?\nPick one.");
		const explain = parseExplainInput({ question: "Explain fold equity.", correctAnswer: "Two ways\\n\\nto win." });
		assert.equal(explain!.correctAnswer, "Two ways\n\nto win.");
	});
});
