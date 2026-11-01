import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, questionResult, serverExecute } from "./tool-execute.ts";
import {
	ASK_PROSE_FIELDS,
	EXPLAIN_PROSE_FIELDS,
	QUIZ_PROSE_FIELDS,
	askInputSchema,
	askOptionProblems,
	explainInputBase,
	explainInputObject,
	explainInputProblems,
	parseOptionsIfString,
	probeQuizInputSchema,
	quizInputObject,
	quizInputProblems,
} from "../core/question-core.ts";
import { healProseEscapes } from "../core/argument-heal.ts";
import { filterEnabledTools, type EnabledTools } from "../core/pending.ts";
import type { JobRecord } from "../core/contracts.ts";
import type { JobStore } from "../core/ports.ts";
import { jobTools, type DemoInput, type PdfInput, type ResearchInput, type VisualInput } from "./tools/jobs.ts";
import { planTools, type PlanToolContext } from "./tools/plan.ts";
import { probeDoneTool, type ProbeDoneContext } from "./tools/probe.ts";
import { proberGraphTools } from "./tools/graph.ts";
import { readTool } from "./tools/read.ts";
import { lsTool } from "./tools/ls.ts";
import { findTool } from "./tools/find.ts";
import { grepTool } from "./tools/grep.ts";
import { healToolRecord } from "./tools/heal.ts";
import type { GraphStore } from "../core/ports.ts";

export { jobTools };
export type { ProbeDoneContext } from "./tools/probe.ts";

/** See docs/probe-teach-split.md §1. */

/** pi runs this BEFORE schema validation and persists the tool call with
 *  its RAW arguments — the client coerces again in normalizeOptions
 *  (question-core). */
function prepareQuestionArguments(proseFields: readonly string[]) {
	return <T extends object>(args: unknown): T => {
		if (args && typeof args === "object" && !Array.isArray(args)) {
			let o = args as { options?: unknown };
			if (typeof o.options === "string") {
				const parsed = parseOptionsIfString(o.options);
				if (parsed !== o.options) o = { ...o, options: parsed };
			}
			return healProseEscapes(o, proseFields) as T;
		}
		return args as T;
	};
}

export const askUserQuestionTool: AgentTool<typeof askInputSchema> = {
	name: "ask_user_question",
	label: "ask_user_question",
	description:
		"Ask the learner a single question and pause until they answer. NOT graded — there is no correct answer. " +
		"Use when requirements are ambiguous, preferences are needed, a decision would materially affect the lesson, " +
		"or you need an open-ended response. ONE question per turn: call a single ask_user_question, then end your " +
		"turn — his answer determines the next.",
	parameters: askInputSchema,
	prepareArguments: prepareQuestionArguments(ASK_PROSE_FIELDS),
	executionMode: "sequential",
	execute: async (_toolCallId, input) => {
		const problems = askOptionProblems(input.options ?? []);
		if (problems.length > 0) return invalidInputResult("ask_user_question", problems);
		return questionResult();
	},
};

export const quizExampleBody = {
	question: "A signal is $y=\\sin(2x)$ and $\\frac{dx}{dt}=3$. What is $\\frac{dy}{dt}$?",
	options: [
		{ label: "$6\\cos(2x)$", value: "a" },
		{ label: "$2\\cos(2x)$", value: "b" },
		{ label: "$3\\cos(2x)$", value: "c" },
	],
	explanation:
		"The phase changes twice as fast as $x$; multiply by the sine's slope:\n$$\n\\frac{dy}{dt}=\\cos(2x)\\cdot2\\cdot3=6\\cos(2x)\n$$",
	correctAnswer: "a",
};

function quizDescription(delta: { name: "quiz" | "probe"; nodeId: boolean; types: boolean }): string {
	const base =
		"Ask the learner a GRADED question with a known correct answer, then instantly grade and give feedback. " +
		"Unlike ask_user_question (which collects preferences/decisions with no right answer), " +
		delta.name +
		" always has a " +
		"correct answer supplied by you, marks the learner's selection right/wrong, reveals the correct answer, and " +
		"can show an explanation. Options-only: single-select or multi-select, plus an automatic 'I don't know' " +
		"choice so the learner can signal a genuine gap instead of guessing. An always-present optional thinking " +
		"field lets the learner attach his reasoning to ANY answer; it reaches you only when non-empty. " +
		"No free-text answers — for non-graded questions use ask_user_question instead. " +
		(delta.types
			? "Every call declares `type` — the question's role in the teaching cycle; the field's own description says when each kind fires. "
			: "") +
		(delta.nodeId
			? "Set `nodeId` (required) to the plan node this question is about — validated at call time against the session's plan map. For off-map checks use ask_user_question. "
			: "") +
		"ONE question per turn: call a single " +
		delta.name +
		", then end your turn — his answer determines the next.";
	const example = delta.nodeId ? { type: "check" as const, nodeId: "chain-rule", ...quizExampleBody } : quizExampleBody;
	return (
		base +
		"\nExample arguments — copy the escaping exactly: inside JSON strings a LaTeX backslash is \\\\ and a newline is \\n.\n```json\n" +
		JSON.stringify(example, null, 2) +
		"\n```" +
		(delta.nodeId ? " The example's nodeId is illustrative — copy an exact id from this session's plan_init." : "")
	);
}

function explainDescription(name: "explain" | "recall", nodeId: boolean): string {
	return (
		"Ask the learner to EXPLAIN something in his own words — a graded check with NO options: he types a free-text " +
		"answer. Unlike ask_user_question (no right answer), " +
		name +
		" always has one. THE COMMITMENT RULE: " +
		"correctAnswer is the FULL correct answer in your own words, reasoning included, COMMITTED before he ever " +
		"sees the question. When his answer returns, grade it strictly against the commitment — never revise it " +
		"after seeing his words. He sees the committed answer on submit. " +
		(nodeId
			? "Set `nodeId` (required) to the plan node this question is about — validated at call time against the session's plan map. "
			: "") +
		"ONE question per turn: call a single " + name + ", then end your turn — his answer determines the next."
	);
}

export const probeQuizTool: AgentTool<typeof probeQuizInputSchema> = {
	name: "probe",
	label: "probe",
	description: quizDescription({ name: "probe", nodeId: false, types: false }),
	parameters: probeQuizInputSchema,
	prepareArguments: prepareQuestionArguments(QUIZ_PROSE_FIELDS),
	executionMode: "sequential",
	execute: async (_toolCallId, input) => {
		const problems = quizInputProblems(input);
		if (problems.length > 0) return invalidInputResult("probe", problems);
		return questionResult();
	},
};

export function teachExplainToolFor(
	ctx: Pick<PlanToolContext, "chatId" | "chatStore">,
): AgentTool<typeof explainInputObject> {
	return {
		name: "explain",
		label: "explain",
		description: explainDescription("explain", true),
		parameters: explainInputObject,
		prepareArguments: prepareQuestionArguments(EXPLAIN_PROSE_FIELDS),
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = [...explainInputProblems(input)];
			const nodeIdProblemText = nodeIdProblem(ctx, input.nodeId);
			if (nodeIdProblemText) problems.push(nodeIdProblemText);
			if (problems.length > 0) return invalidInputResult("explain", problems);
			return questionResult();
		},
	};
}

export const probeExplainTool: AgentTool<typeof explainInputBase> = {
	name: "recall",
	label: "recall",
	description: explainDescription("recall", false),
	parameters: explainInputBase,
	prepareArguments: prepareQuestionArguments(EXPLAIN_PROSE_FIELDS),
	executionMode: "sequential",
	execute: async (_toolCallId, input) => {
		const problems = explainInputProblems(input);
		if (problems.length > 0) return invalidInputResult("recall", problems);
		return questionResult();
	},
};

export interface ProberToolContext extends ProbeDoneContext {
	jobStore: JobStore;
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput | PdfInput) => void;
	searchAvailable?: () => boolean;
	graphStore?: GraphStore;
}

export function createProberTools(
	ctx: ProberToolContext,
	enabled?: EnabledTools,
): Record<string, AgentTool<any>> {
	const done = probeDoneTool(ctx);
	const jobs = jobTools({
		chatId: ctx.chatId,
		jobStore: ctx.jobStore,
		spawn: ctx.spawn,
		searchAvailable: ctx.searchAvailable,
	});
	const mechanics = quizMechanics(enabled);
	const quizzing: Record<string, AgentTool<any>> =
		mechanics === "free" ? { recall: probeExplainTool } : { probe: probeQuizTool };
	return healToolRecord({
		...filterEnabledTools(
			{
				...quizzing,
				ask_user_question: askUserQuestionTool,
				read: readTool,
				ls: lsTool,
				find: findTool,
				grep: grepTool,
				...(jobs.research ? { research: jobs.research } : {}),
				pdf: jobs.pdf!,
				...(ctx.graphStore
					? proberGraphTools({ chatStore: ctx.chatStore, graphStore: ctx.graphStore })
					: {}),
				...done,
			},
				withoutMechanics(enabled),
			),
			...done,
		});
}

function nodeIdProblem(ctx: Pick<PlanToolContext, "chatId" | "chatStore">, nodeId: string): string | null {
	const record = ctx.chatStore.getChat(ctx.chatId);
	const known = record?.tree?.nodes.map((n) => n.id) ?? [];
	if (!known.includes(nodeId)) {
		return (
			`nodeId "${nodeId}" matches no node in this session's plan map. ` +
			(known.length > 0
				? `Copy one of your plan_init slugs exactly (${known.slice(0, 5).join(", ")}${known.length > 5 ? ", …" : ""}).`
				: "No plan map exists yet — call plan_init before posing quizzes.")
		);
	}
	return null;
}

export function teachQuizToolFor(ctx: Pick<PlanToolContext, "chatId" | "chatStore">): AgentTool<typeof quizInputObject> {
	return {
		name: "quiz",
		label: "quiz",
		description: quizDescription({ name: "quiz", nodeId: true, types: true }),
		parameters: quizInputObject,
		prepareArguments: prepareQuestionArguments(QUIZ_PROSE_FIELDS),
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = [...quizInputProblems(input)];
			const nodeIdProblemText = nodeIdProblem(ctx, input.nodeId);
			if (nodeIdProblemText) problems.push(nodeIdProblemText);
			if (problems.length > 0) return invalidInputResult("quiz", problems);
			return questionResult();
		},
	};
}

export interface TeacherToolContext extends PlanToolContext {
	jobStore: JobStore;
	spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput | PdfInput) => void;
	searchAvailable?: () => boolean;
}

export function quizMechanics(enabled?: EnabledTools): "choice" | "free" {
	return enabled?.explain === true ? "free" : "choice";
}

function withoutMechanics(enabled?: EnabledTools): EnabledTools | undefined {
	if (!enabled) return undefined;
	const { explain: _e, quiz: _q, ...rest } = enabled;
	return rest;
}

export function createTeacherTools(
	ctx: TeacherToolContext,
	enabled?: EnabledTools,
): Record<string, AgentTool<any>> {
	const mechanics = quizMechanics(enabled);
	const quizzing: Record<string, AgentTool<any>> =
		mechanics === "free" ? { explain: teachExplainToolFor(ctx) } : { quiz: teachQuizToolFor(ctx) };
	return healToolRecord(
		filterEnabledTools(
			{
			...quizzing,
			ask_user_question: askUserQuestionTool,
			read: readTool,
			ls: lsTool,
			find: findTool,
			grep: grepTool,
			...planTools(ctx),
			...jobTools({ chatId: ctx.chatId, jobStore: ctx.jobStore, spawn: ctx.spawn, searchAvailable: ctx.searchAvailable }),
		},
		withoutMechanics(enabled),
		),
	);
}
