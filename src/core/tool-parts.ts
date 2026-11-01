import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { quizDisplayInputSchema, askInputSchema, askOptionProblems, quizInputProblems, explainInputProblems, explainDisplayInputSchema, ASK_PROSE_FIELDS, EXPLAIN_PROSE_FIELDS, QUIZ_PROSE_FIELDS, type AskToolInput, type QuizToolInput, type ExplainToolInput } from "./question-core.ts";
import { repairMathForDisplay } from "./math-delims.ts";
import { healEncodedArguments, healProseEscapes } from "./argument-heal.ts";
import { probeDoneInputSchema, type ProbeDoneInput } from "./contracts/probe.ts";

/** Mirrors pi-ai's validateToolArguments, which runs Value.Convert before
 *  Value.Check: records keep the RAW arguments, so skipping Convert here
 *  would reject input the boundary accepted. Convert mutates, hence the
 *  clone. */
function boundaryParse<T>(schema: TSchema, input: unknown): T | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const converted = structuredClone(input);
	Value.Convert(schema, converted);
	if (!Value.Check(schema, converted)) return undefined;
	return Value.Clean(schema, converted) as T;
}

function restoreMathEscapesDeep(value: unknown): unknown {
	if (typeof value === "string") return repairMathForDisplay(value);
	if (Array.isArray(value)) return value.map(restoreMathEscapesDeep);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = restoreMathEscapesDeep(v);
		return out;
	}
	return value;
}

export function parseQuizInput(input: unknown): QuizToolInput | undefined {
	const healedInput = healProseEscapes(
		healEncodedArguments(restoreMathEscapesDeep(input), quizDisplayInputSchema),
		QUIZ_PROSE_FIELDS,
	);
	const cleaned = boundaryParse<QuizToolInput>(quizDisplayInputSchema, healedInput);
	if (!cleaned) return undefined;
	if (quizInputProblems(cleaned).length > 0) return undefined;
	return cleaned;
}

export function parseAskInput(input: unknown): AskToolInput | undefined {
	const cleaned = boundaryParse<AskToolInput>(askInputSchema, healProseEscapes(restoreMathEscapesDeep(input), ASK_PROSE_FIELDS));
	if (!cleaned) return undefined;
	if (askOptionProblems(cleaned.options ?? []).length > 0) return undefined;
	return cleaned;
}

export function parseExplainInput(input: unknown): ExplainToolInput | undefined {
	const cleaned = boundaryParse<ExplainToolInput>(
		explainDisplayInputSchema,
		healProseEscapes(restoreMathEscapesDeep(input), EXPLAIN_PROSE_FIELDS),
	);
	if (!cleaned) return undefined;
	if (explainInputProblems(cleaned).length > 0) return undefined;
	return cleaned;
}

export function parseProbeDoneInput(input: unknown): ProbeDoneInput | undefined {
	return boundaryParse<ProbeDoneInput>(probeDoneInputSchema, input);
}