import { Type, type Static } from "typebox";
import { stripModelValueDebris } from "./value-debris.ts";

export interface QuizOption {
	label: string;
	value: string;
	description?: string;
}

// Parameter names mirror the prompt docs exactly; keep them in sync.

/** No `description` field: models used it to leak correctness. */
const quizOptionProps = {
	label: Type.String({ description: "Display label for the answer option — a bare claim, no reasoning" }),
	value: Type.Optional(
		Type.String({
			description: "Optional machine-readable value returned for the option. Defaults to the label.",
		}),
	),
};

const askOptionProps = {
	...quizOptionProps,
	description: Type.Optional(
		Type.String({ description: "Optional extra detail shown below the option" }),
	),
};

/** Some models (GLM) emit `options` as a JSON-encoded string. Returns the
 *  input untouched when it isn't a parseable array. */
export function parseOptionsIfString<T>(options: string | T[] | undefined): unknown {
	if (typeof options !== "string") return options;
	try {
		const parsed: unknown = JSON.parse(options);
		if (Array.isArray(parsed)) return parsed;
	} catch {
	}
	return options;
}

// These rules mirror the grading path exactly, so problem-free ⇔ gradeable.

function optionProblems(
	options: Array<{ label: string; value?: string }>,
): { problems: string[]; keys: string[] } {
	const problems: string[] = [];
	const keys: string[] = [];
	options.forEach((option, i) => {
		const label = option.label.trim();
		if (label.length === 0) {
			problems.push(`options[${i}].label is empty — every option needs a label.`);
			return;
		}
		const key = option.value?.trim() || label;
		if (keys.includes(key)) {
			problems.push(`Two options resolve to the same value "${key}" — options must be distinct.`);
		}
		keys.push(key);
	});
	return { problems, keys };
}

export function askOptionProblems(options: Array<{ label: string; value?: string }>): string[] {
	return optionProblems(options).problems;
}

/** Empty result = a quiz the dock can arm and grade faithfully. */
export function quizInputProblems(input: {
	options: Array<{ label: string; value?: string }>;
	correctAnswer: string | string[];
	multiSelect?: boolean;
}): string[] {
	const { problems, keys } = optionProblems(input.options);

	const entries = coerceCorrectAnswer(input.correctAnswer, keys);
	const unique = [...new Set(entries)];
	if (unique.length === 0 || unique.some((v) => v.length === 0)) {
		problems.push("correctAnswer is required — provide the value (or label) of the correct option(s).");
		return problems;
	}
	for (const v of unique) {
		if (!keys.includes(v)) {
			problems.push(
				`correctAnswer "${v}" does not match any option value. Valid values: ${keys.map((k) => `"${k}"`).join(", ")}. ` +
					"Copy the exact value (or label) of the intended option — never a paraphrase or slug.",
			);
		}
	}
	if (unique.length > 1 && input.multiSelect !== true) {
		problems.push(
				`correctAnswer lists ${unique.length} values but multiSelect is not true — a single-select question with several ` +
					"correct answers can never be answered correctly. Set multiSelect: true, or make exactly one option correct.",
		);
	}
	return problems;
}

// Models emit tool args in schema order, so `explanation` sits before
// `correctAnswer` to make the model reason before committing.
export const quizInputBase = Type.Object({
	question: Type.String({
		description:
			"The single quiz question to ask. ONE question per turn: ask, then end your turn — the answer determines the next question.",
	}),
	options: Type.Array(Type.Object(quizOptionProps), {
		minItems: 2,
		description:
			"REQUIRED. The answer options (2 or more) as a JSON ARRAY of option objects — never a " +
			"JSON-encoded string. Options only — there is no free-text mode. " +
			"Give each option a stable `value`; you reference the correct one by that value in correctAnswer. " +
			"Never add your own 'I don't know' option — that choice is added for you.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set to true when more than one option is correct and the learner must select all of them.",
		}),
	),
	explanation: Type.String({
		description:
			"REQUIRED. Explanation revealed AFTER the learner answers (shown whether they got it right or wrong). " +
			"Use it to reinforce why the correct answer is correct. It is written BEFORE correctAnswer by design: " +
			"reason it out first, then commit the answer the reasoning supports.",
	}),
	correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
		description:
			"REQUIRED. The correct answer as the option value(s) — the `value` field of the option you intend. " +
			'Single-select: a single string (e.g. "mercury"). Multi-select: an array of strings (e.g. ["belize", "niue"]); ' +
			"the learner is only correct if their selection matches this set exactly. " +
			"Always pass the value, not a position number — this is self-checking and prevents miscounting. " +
			"A value that matches no option fails validation and the call is returned to you to fix.",
	}),
	details: Type.Optional(
		Type.String({
			description:
				"Optional helper text shown under the question, written to the learner: one or two short sentences " +
				"that clarify what is being asked. Never restates or previews the options.",
		}),
	),
});

export const QUIZ_QUESTION_TYPES = ["predict", "check"] as const;
export type QuizQuestionType = (typeof QUIZ_QUESTION_TYPES)[number];

/** Undefined for absent or unhealable values. */
export function normalizeQuizType(raw: unknown): QuizQuestionType | undefined {
	if (typeof raw !== "string") return undefined;
	const v = stripModelValueDebris(raw);
	return v === "predict" ? "predict" : v === "check" ? "check" : undefined;
}

/** Only teach-phase quiz/explain checks collapse behind the reveal; a
 *  missing `type` counts as a check. */
export function questionNeedsReveal(tool: string, rawInput: unknown, phase: string): boolean {
	if ((tool !== "quiz" && tool !== "explain") || phase !== "teach") return false;
	return normalizeQuizType((rawInput as { type?: unknown } | null)?.type) !== "predict";
}

const predictCheckType = Type.Union([Type.Literal("predict"), Type.Literal("check")], {
	description:
		"REQUIRED — the question's role in the teaching cycle, as a bare word (no quotes): predict = posed BEFORE " +
		"you teach the step (its own turn; the learner answers, then your teaching resolves it — arrives open, never " +
		"collapsed); check = posed AFTER the step's teaching is complete (arrives collapsed behind the Check your " +
		"understanding reveal). ONE question per turn either way.",
});


/** `type` and `nodeId` lead the property order: glm-5.3 dropped them on
 *  long calls when they trailed the content fields. */
export const quizInputObject = Type.Object({
	type: predictCheckType,
	nodeId: Type.String({
		description:
			"REQUIRED plan-tree node id this question is about — must EXACTLY match one of this session's " +
			"plan_init node slugs (validated at call time; a mismatched id is rejected back to you). " +
			"The lesson's position on the map derives from these tags (the node the latest tagged question is about is " +
			"where the map stands; earlier ones count as visited). A node takes as many questions as it deserves: stay on " +
			"one node for as many turns as the understanding needs — one reasoning step at a time, never rush forward. " +
			"For off-map checks use ask_user_question.",
	}),
	...quizInputBase.properties,
});

export const probeQuizInputSchema = quizInputBase;

/** `type` must be declared here or Value.Clean strips it. */
export const quizDisplayInputSchema = Type.Object({
	...quizInputBase.properties,
	type: Type.Optional(Type.String()),
});

export const explainInputBase = Type.Object({
	question: Type.String({
		description:
			"The single question to ask. ONE question per turn: ask, then end your turn — the answer determines the next.",
	}),
	correctAnswer: Type.String({
		description:
			"REQUIRED. The full correct answer in your own words, reasoning included — COMMITTED before the learner " +
			"ever sees the question. The commitment is immutable: when his answer returns, grade it strictly against this " +
			"text — never revise the commitment after seeing his words, and never mark a wrong answer right to be kind. " +
			"It is shown to him on submit; your next reply grades the nuance of what he wrote.",
	}),
	details: Type.Optional(
		Type.String({
			description:
				"Optional helper text shown under the question, written to the learner: one or two short sentences " +
				"that clarify what is being asked.",
		}),
	),
});

export const explainInputObject = Type.Object({
	type: predictCheckType,
	nodeId: Type.String({
		description:
			"REQUIRED plan-tree node id this question is about — must EXACTLY match one of this session's " +
			"plan_init node slugs (validated at call time; a mismatched id is rejected back to you). " +
			"The lesson's position on the map derives from these tags (the node the latest tagged question is about is " +
			"where the map stands; earlier ones count as visited). A node takes as many questions as it deserves: stay on " +
			"one node for as many turns as the understanding needs — one reasoning step at a time, never rush forward. " +
			"For off-map checks use ask_user_question.",
	}),
	...explainInputBase.properties,
});

export const explainDisplayInputSchema = Type.Object({
	...explainInputBase.properties,
	type: Type.Optional(Type.String()),
});

export function explainInputProblems(input: { correctAnswer: string }): string[] {
	if (input.correctAnswer.trim().length === 0) {
		return ["correctAnswer is required — commit to the full correct answer BEFORE posing the question."];
	}
	return [];
}

export const QUIZ_TOOL_NAMES = ["quiz", "explain"] as const;

export const quizInputSchema = quizInputObject;

export const askInputSchema = Type.Object({
	question: Type.String({
		description:
			"The single question to ask the learner. ONE question per turn: ask, then end your turn — the answer determines the next question.",
	}),
	details: Type.Optional(
		Type.String({
			description:
				"Optional helper text shown under the question, written to the learner: one or two short sentences " +
				"that clarify what is being asked. Never restates or previews the options.",
		}),
	),
	options: Type.Optional(
		Type.Array(Type.Object(askOptionProps), {
			minItems: 2,
			description:
				"Optional multiple-choice options. Omit for free-form text input. " +
				"The learner can always choose 'Other' and type a custom answer when options are provided.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set to true to allow multiple answers to the same question." }),
	),
});

/** Fields healProseEscapes may rewrite. Quiz option labels stay out: they
 *  are membership-compared against `correctAnswer`. */
export const QUIZ_PROSE_FIELDS = ["question", "details", "explanation"] as const;
export const EXPLAIN_PROSE_FIELDS = ["question", "details", "correctAnswer"] as const;
export const ASK_PROSE_FIELDS = ["question", "details", "options[].label", "options[].description"] as const;

export type QuizToolInput = Static<typeof quizInputObject>;
export type AskToolInput = Static<typeof askInputSchema>;
export type ExplainToolInput = Static<typeof explainInputObject>;
export type ProbeExplainToolInput = Static<typeof explainInputBase>;


export interface OptionAnswer {
	label: string;
	value: string;
	/** 1-based display index. */
	index: number;
}

export type QuestionKind = "quiz" | "ask" | "explain";
export type SelectMode = "single-select" | "multi-select";
export type QuestionMode = SelectMode | "text";

export interface QuestionData {
	id: string;
	kind: QuestionKind;
	/** Teach-phase quiz only; absent means check. */
	questionType?: QuizQuestionType;
	question: string;
	context?: string;
	mode: QuestionMode;
	/** Display order (post-shuffle). */
	options: QuizOption[];
	/** Quiz only. Never send to the client before answering. */
	correctIndices?: number[];
	/** Explain only. Never send to the client before answering. */
	committedAnswer?: string;
	/** Quiz only. Never send to the client before answering. */
	explanation?: string;
	createdAt: string;
}

export interface QuestionAnswerData {
	kind: QuestionKind;
	/** The persisted call's tool name. Absent on older records. */
	tool?: string;
	/** Teach-phase quiz only. */
	questionType?: QuizQuestionType;
	questionText: string;
	options?: { index: number; label: string }[];
	dontKnow: boolean;
	answers: OptionAnswer[];
	/** Ask: "Other" free text. */
	other?: string;
	/** Ask/explain text-mode answer. */
	text?: string;
	/** The learner's reasoning on the question. */
	thinking?: string;
	/** @deprecated never written; read via `thinking ?? note`. */
	note?: string;
	/** The learner's thinking while reading the teaching prose. Absent when empty. */
	readingThinking?: string;
	/** Quiz only: stated probability (0-100) that the selection is correct.
	 *  Never set on "I don't know". */
	confidence?: number;
	correct?: boolean;
	correctIndices?: number[];
	/** Explain only: the model's committed answer. */
	committed?: string;
	explanation?: string;
	dismissed?: boolean;
	answeredAt: string;
}

/** Deliberately omits the answer. */
export interface ClientQuestion {
	id: string;
	kind: QuestionKind;
	question: string;
	context?: string;
	mode: QuestionMode;
	options: QuizOption[];
}

export interface AnswerRequest {
	dontKnow?: boolean;
	/** Option values. */
	values?: string[];
	other?: string;
	text?: string;
	thinking?: string;
	readingThinking?: string;
	/** Quiz only: 0-100. */
	confidence?: number;
}

/** Legacy slider stops, kept to validate and render old answers. */
export const CONFIDENCE_STOPS: readonly number[] = [0, 30, 50, 70, 90, 100];
export const DEFAULT_CONFIDENCE_INDEX = 2;

/** New answers carry one of these values. */
export const CONFIDENCE_LEVELS: ReadonlyArray<{ label: string; value: number }> = [
	{ label: "Guessing", value: 25 },
	{ label: "Unsure", value: 50 },
	{ label: "Fairly sure", value: 75 },
	{ label: "Certain", value: 95 },
];

/** Accepts the levels and the legacy stops. */
export function isAcceptedConfidence(value: unknown): value is number {
	return (
		typeof value === "number" &&
		(CONFIDENCE_LEVELS.some((l) => l.value === value) || CONFIDENCE_STOPS.includes(value))
	);
}

/** Null for values off the level grid. */
export function confidenceLabel(value: number): string | null {
	return CONFIDENCE_LEVELS.find((l) => l.value === value)?.label ?? null;
}

/** 0-based indices in display order. */
export interface DockSelection {
	selected: Set<number>;
	otherSelected: boolean;
	dontKnow: boolean;
}

export const emptyDockSelection = (): DockSelection => ({ selected: new Set(), otherSelected: false, dontKnow: false });

/** Single-select: the option displaces "Other". Multi-select: options and
 *  "Other" toggle independently. */
export function toggleOption(mode: SelectMode, sel: DockSelection, idx: number): DockSelection {
	if (mode === "multi-select") {
		const selected = new Set(sel.selected);
		if (selected.has(idx)) selected.delete(idx);
		else selected.add(idx);
		return { selected, otherSelected: sel.otherSelected, dontKnow: false };
	}
	return { selected: new Set([idx]), otherSelected: false, dontKnow: false };
}

/** Single-select: displaces the listed options. Multi-select: clears nothing. */
export function toggleOther(mode: SelectMode, sel: DockSelection): DockSelection {
	if (mode === "multi-select") return { ...sel, otherSelected: !sel.otherSelected, dontKnow: false };
	return { selected: new Set(), otherSelected: true, dontKnow: false };
}

export function normalizeOptions(
	options: string | Array<{ label: string; value?: string; description?: string }> | undefined,
): QuizOption[] {
	const seen = new Set<string>();
	const coerced = parseOptionsIfString(options);
	const list = Array.isArray(coerced)
		? (coerced as Array<{ label: string; value?: string; description?: string }>)
		: [];
	return list
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => {
			if (option.label.length === 0) return false;
			if (seen.has(option.value)) throw new Error(`duplicate option value "${option.value}"`);
			seen.add(option.value);
			return true;
		});
}

/** mulberry32 seeded by a string. */
export function seededRandom(seed: string): () => number {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	let a = h >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Pass `seededRandom(toolCallId)` in rendered components: Math.random()
 *  shuffles differently on server vs client and breaks hydration (React #418). */
export function shuffleOptions(options: QuizOption[], rand: () => number = Math.random): QuizOption[] {
	const out = [...options];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		const a = out[i]!;
		const b = out[j]!;
		out[i] = b;
		out[j] = a;
	}
	return out;
}

/** An exact option key is kept verbatim (its punctuation can be content);
 *  only non-matches get copy-syntax debris stripped. A JSON-stringified
 *  array is parsed as multi-select. */
export function coerceCorrectAnswer(
	correctAnswer: string | string[],
	optionValues: readonly string[],
): string[] {
	const clean = (value: string): string => {
		const trimmed = value.trim();
		return optionValues.includes(trimmed) ? trimmed : stripModelValueDebris(value);
	};
	if (Array.isArray(correctAnswer)) return correctAnswer.map(clean);
	const trimmed = correctAnswer.trim();
	if (optionValues.includes(trimmed)) return [trimmed];
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed.map((v) => clean(String(v)));
		} catch {
		}
	}
	return [clean(correctAnswer)];
}

/** Resolves value(s) to 1-based display indices. Must run after shuffling. */
export function resolveCorrect(
	correctAnswer: string | string[] | undefined,
	options: QuizOption[],
): { indices: number[]; error?: string } {
	if (correctAnswer === undefined) return { indices: [], error: "correctAnswer is required" };
	const arr = coerceCorrectAnswer(correctAnswer, options.map((o) => o.value));
	if (arr.length === 0) return { indices: [], error: "correctAnswer is required" };
	const byValue = new Map(options.map((o, i) => [o.value, i + 1]));
	const indices: number[] = [];
	for (const raw of arr) {
		const v = typeof raw === "string" ? raw.trim() : raw;
		const idx = byValue.get(v);
		if (idx === undefined) {
			const known = options.map((o) => `"${o.value}"`).join(", ");
			return { indices: [], error: `correctAnswer "${v}" does not match any option value (${known})` };
		}
		indices.push(idx);
	}
	return { indices: Array.from(new Set(indices)).sort((a, b) => a - b) };
}

export function isCorrect(selectedIndices: number[], correctIndices: number[]): boolean {
	if (selectedIndices.length !== correctIndices.length) return false;
	const a = [...selectedIndices].sort((x, y) => x - y);
	const b = [...correctIndices].sort((x, y) => x - y);
	return a.every((v, i) => v === b[i]);
}

export function toClientQuestion(qd: QuestionData): ClientQuestion {
	return {
		id: qd.id,
		kind: qd.kind,
		question: qd.question,
		context: qd.context,
		mode: qd.mode,
		options: qd.options,
	};
}

function formatOptionRef(options: QuizOption[], index: number): string {
	const opt = options.find((o, i) => i + 1 === index);
	return `${index}. ${opt ? opt.label : "(unknown)"}`;
}

/** Grades quiz answers; ask and explain answers are not graded. Unknown
 *  option values are ignored. */
export function buildAnswer(qd: QuestionData, req: AnswerRequest, tool?: string): QuestionAnswerData {
	const base: QuestionAnswerData = {
		kind: qd.kind,
		...(tool ? { tool } : {}),
		questionType: qd.questionType,
		questionText: qd.question,
		options: qd.options.map((o, i) => ({ index: i + 1, label: o.label })),
		dontKnow: req.dontKnow === true,
		answers: [],
		thinking: req.thinking?.trim() || undefined,
		readingThinking: req.readingThinking?.trim() || undefined,
		answeredAt: new Date().toISOString(),
	};
	if (req.values && req.values.length > 0) {
		const byValue = new Map(qd.options.map((o, i) => [o.value, { ...o, index: i + 1 }]));
		for (const v of req.values) {
			const opt = byValue.get(v);
			if (!opt) continue;
			base.answers.push({ label: opt.label, value: opt.value, index: opt.index });
		}
		base.answers.sort((a, b) => a.index - b.index);
	}
	if (req.other?.trim()) base.other = req.other.trim();
	if (req.text?.trim()) base.text = req.text.trim();

	if (qd.kind === "quiz") {
		base.correctIndices = qd.correctIndices ?? [];
		base.explanation = qd.explanation;
		base.correct = base.dontKnow ? false : isCorrect(base.answers.map((a) => a.index), qd.correctIndices ?? []);
		if (!base.dontKnow && req.confidence !== undefined) {
			base.confidence = Math.max(0, Math.min(100, Math.round(req.confidence)));
		}
	}
	if (qd.kind === "explain") {
		base.committed = qd.committedAnswer;
	}
	return base;
}

export function dismissedAnswer(kind: QuestionKind, questionText: string): QuestionAnswerData {
	return {
		kind,
		questionText,
		dontKnow: false,
		answers: [],
		dismissed: true,
		answeredAt: new Date().toISOString(),
	};
}

/** The model-visible answer: only what the learner added, since the tool
 *  call already carries everything the model authored. */
export function compactAnswerForModel(ad: QuestionAnswerData): Record<string, unknown> {
	if (ad.dismissed) return { kind: ad.kind, dismissed: true };
	const out: Record<string, unknown> = { kind: ad.kind };
	if (ad.dontKnow) out.dontKnow = true;
	if (Array.isArray(ad.answers) && ad.answers.length > 0)
		out.answers = ad.answers.map((a) => ({ index: a.index, label: a.label }));
	if (ad.text) out.text = ad.text;
	if (ad.other) out.other = ad.other;
	if (ad.correct !== undefined && !ad.dontKnow) out.correct = ad.correct;
	if (ad.confidence !== undefined) out.confidence = ad.confidence;
	const thinking = ad.thinking ?? ad.note;
	if (thinking) out.thinking = thinking;
	if (ad.readingThinking) out.thinkingWhileReading = ad.readingThinking;
	return out;
}
