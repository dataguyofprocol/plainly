import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, questionResult } from "./tool-execute.ts";
import { providerEventObserver } from "./provider-events.ts";
import type { Usage } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { APP_IDENTITY, piEngineFor, type PiEngine } from "./models.ts";
import { effectivePromptSegments } from "./prompt-segments.ts";
import {
	askUserQuestionTool,
	createProberTools,
	createTeacherTools,
	type ProbeDoneContext,
	type ProberToolContext,
	type TeacherToolContext,
} from "./tools.ts";
import { practiceTools, type PracticeToolContext } from "./tools/practice.ts";
import { healToolRecord } from "./tools/heal.ts";
import { quizInputObject, quizInputProblems } from "../core/question-core.ts";
import { QUESTION_TOOLS, type EnabledTools } from "../core/pending.ts";
import { toLlmMessages, nativeInputCause } from "../core/native-messages.ts";
import type { ChatGPTRequestCycle } from "./chatgpt-request-cycle.ts";
import { usageWasAdmitted } from "./subscription-request-cycle.ts";

/** See docs/probe-teach-split.md and docs/pi-engine-swap.md §2. */

export type AgentKind = "prober" | "teacher" | "practice";

export function composeInstructions(kind: AgentKind, switches?: Record<string, boolean>): string {
	const segments = effectivePromptSegments(kind, switches ?? {});
	return segments
		.map((s) => (s.enabled ? s.overrideText! : s.sourceText))
		.map((t) => t.trim())
		.filter(Boolean)
		.join("\n\n---\n\n");
}

const composedInstructions: Record<AgentKind, string> = {
	prober: composeInstructions("prober"),
	teacher: composeInstructions("teacher"),
	practice: composeInstructions("practice"),
};

export type StepUsageCollector = (usage: Usage) => void;

export interface AgentBuildOptions {
	engine?: PiEngine;
	callPurpose?: { background: boolean };
	requestCycle?: ChatGPTRequestCycle;
	messages?: AgentMessage[];
	onUsage?: StepUsageCollector;
	tools?: Record<string, AgentTool<any>>;
	toolToggles?: EnabledTools;
	promptSwitches?: Record<string, boolean>;
	chatId?: string;
}

/** See docs/pi-engine-swap.md §2. */
function makeQuestionStopper() {
	return (context: {
		message: { content: Array<{ type: string; id?: string; name?: string }> };
		toolResults: Array<{ toolCallId: string; isError?: boolean }>;
	}): boolean => {
		const called = new Set(
			context.message.content
				.filter((c) => c.type === "toolCall" && c.name !== undefined && (QUESTION_TOOLS as readonly string[]).includes(c.name!))
				.map((c) => c.id!),
		);
		if (called.size === 0) return false;
		for (const result of context.toolResults) {
			if (called.has(result.toolCallId) && result.isError) return false;
		}
		return true;
	};
}

function baseAgentOptions(kind: AgentKind, opts: AgentBuildOptions, tools: AgentTool<any, any>[]) {
	const engine = opts.engine ?? piEngineFor(kind as "prober" | "teacher");
	const stopper = makeQuestionStopper();
	const systemPrompt = opts.promptSwitches
		? composeInstructions(kind, opts.promptSwitches)
		: composedInstructions[kind]!;
	const providerEvents = opts.chatId ? providerEventObserver(opts.chatId, kind) : undefined;
	const seenInputs = new Set((opts.messages ?? []).map((m) => (m as { id?: string }).id).filter(Boolean));
	const agent = new Agent({
		identity: APP_IDENTITY,
		sessionId: opts.chatId,
		initialState: {
			systemPrompt,
			model: engine.model,
			thinkingLevel: engine.level,
			tools,
			messages: opts.messages ?? [],
		},
		streamFn: engine.streamFn,
		...(providerEvents ? { onProviderStreamEvent: providerEvents } : {}),
		finishTurn: (turn) => (stopper(turn) ? { action: "end" } : undefined),
		steeringMode: "all",
		// must never throw (pi's convertToLlm contract).
		convertToLlm: toLlmMessages,
		prepareRequest: (request) => {
			if (opts.callPurpose) {
				let learner = false, automatic = false;
				const messages = request.context.messages;
				for (const message of messages) {
					const id = (message as { id?: string }).id;
					const cause = nativeInputCause(message, messages.slice(0, messages.indexOf(message)));
					if (cause === "neutral") continue;
					if (id && seenInputs.has(id)) continue;
					if (id) seenInputs.add(id);
					if (cause === "learner" && id) learner = true;
					else automatic = true; // missing/unrecognized identity never grants foreground
				}
				if (automatic) opts.callPurpose.background = true;
				else if (learner) opts.callPurpose.background = false;
			}
			opts.requestCycle?.prepare(request);
		},
	});
	if (opts.onUsage) {
		agent.subscribe((event: AgentEvent) => {
			if (event.type === "message_end" && event.message.role === "assistant" && "usage" in event.message) {
				if (event.message.stopReason === "aborted" || !usageWasAdmitted(event.message.usage) || (opts.requestCycle && !opts.requestCycle.acceptsUsage(event.message))) return;
				opts.onUsage!(event.message.usage);
			}
		});
	}
	return agent;
}

export function createProberAgent(ctx: ProberToolContext, opts: AgentBuildOptions = {}) {
	return baseAgentOptions("prober", opts, Object.values(createProberTools(ctx, opts.toolToggles)));
}

export function createTeacherAgent(
	ctx?: TeacherToolContext,
	opts: AgentBuildOptions = {},
) {
	const tools = opts.tools ?? (ctx ? createTeacherTools(ctx, opts.toolToggles) : bareQuestionTools());
	return baseAgentOptions("teacher", opts, Object.values(tools));
}

export function bareQuestionTools(): Record<string, AgentTool<any>> {
	const quiz: AgentTool<typeof quizInputObject> = {
		name: "quiz",
		label: "quiz",
		description: "Ask the learner a graded question.",
		parameters: quizInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const problems = quizInputProblems(input);
			if (problems.length > 0) return invalidInputResult("quiz", problems);
			return questionResult();
		},
	};
	return healToolRecord({
		quiz,
		ask_user_question: askUserQuestionTool,
	});
}

export function createPracticeAgent(ctx: PracticeToolContext, opts: AgentBuildOptions = {}) {
	const tools = opts.tools ?? practiceTools(ctx);
	return baseAgentOptions("practice", opts, Object.values(tools));
}

export type ProberAgent = ReturnType<typeof createProberAgent>;
export type TeacherAgent = ReturnType<typeof createTeacherAgent>;
export type PracticeAgent = ReturnType<typeof createPracticeAgent>;
export type TeachingAgent = ProberAgent | TeacherAgent | PracticeAgent;

