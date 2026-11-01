import { CONFIDENCE_LEVELS, CONFIDENCE_STOPS, isAcceptedConfidence, type QuestionAnswerData } from "./question-core.ts";
import type { LhMessage } from "./native-messages.ts";
import {
	activeProblemOf,
	concludedByDismissalPair,
	danglingQuestionOf,
	newAnswerResult,
	newNextMessage,
	newProblemDismissedMarker,
	newThinkingMessage,
	newUserMessage,
	pendingProblemDismissalOf,
} from "./native-messages.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "./pending.ts";
import { isHintRung, type HintRung } from "./contracts/chat.ts";

export type ChatInput =
	| { type: "text"; text: string }
	| { type: "answer"; toolCallId: string; answer: QuestionAnswerData }
	| { type: "continue" }
	/** Targets the ACTIVE problem; each submission is its own turn. */
	| { type: "thinking"; problemCallId: string; text: string; hint?: HintRung }
	/** Practice sessions only, with no active problem. */
	| { type: "next" };

/** Server-originated: the idle wake's queued steer markers. */
export type SteerInput = { type: "steers"; steers: LhMessage[] };

export type TurnInput = ChatInput | SteerInput;

/** Never composes a turn. `answer` must be a dismissal. */
export type DismissInput =
	| { type: "dismiss"; toolCallId: string; answer: QuestionAnswerData }
	/** The conclude pair is appended with the user's NEXT input. */
	| { type: "dismiss-problem"; problemCallId: string };

export function parseDismissInput(input: unknown): DismissInput {
	if (typeof input !== "object" || input === null) throw new ChatInputError("input must be an object");
	const i = input as Record<string, unknown>;
	if (i.type === "dismiss-problem") {
		if (typeof i.problemCallId !== "string" || i.problemCallId.length === 0) {
			throw new ChatInputError("dismiss-problem input requires problemCallId");
		}
		return { type: "dismiss-problem", problemCallId: i.problemCallId };
	}
	if (i.type !== "dismiss") throw new ChatInputError(`unknown input type: ${String(i.type)}`);
	if (typeof i.toolCallId !== "string" || i.toolCallId.length === 0) {
		throw new ChatInputError("dismiss input requires toolCallId");
	}
	const answer = i.answer as QuestionAnswerData | undefined;
	if (typeof answer !== "object" || answer === null) {
		throw new ChatInputError("dismiss input requires the dismissal answer object");
	}
	if (answer.dismissed !== true) {
		throw new ChatInputError("dismiss input's answer must be a dismissal (dismissed: true)");
	}
	return { type: "dismiss", toolCallId: i.toolCallId, answer };
}

/** A message for a RUNNING turn, queued on pi's agent.steer; never
 *  composes a turn of its own. `id` is client-minted (steer_<localid>) and
 *  becomes the drained message's id. */
export type UserSteerInput = { type: "steer"; id: string; text: string };

export function parseUserSteerInput(input: unknown): UserSteerInput {
	if (typeof input !== "object" || input === null) throw new ChatInputError("input must be an object");
	const i = input as Record<string, unknown>;
	if (i.type !== "steer") throw new ChatInputError(`unknown input type: ${String(i.type)}`);
	if (typeof i.id !== "string" || i.id.length === 0) {
		throw new ChatInputError("steer input requires a client-minted id");
	}
	if (typeof i.text !== "string" || i.text.trim().length === 0) {
		throw new ChatInputError("steer input requires non-empty text");
	}
	return { type: "steer", id: i.id, text: i.text };
}

/** Throws ChatInputError unless the target is the dangling question call
 *  or the active problem. */
export function dismissAppends(record: { messages: LhMessage[] }, input: DismissInput): LhMessage[] {
	if (input.type === "dismiss-problem") {
		const active = activeProblemOf(record.messages);
		if (!active || active.toolCallId !== input.problemCallId) {
			throw new ChatInputError("dismiss-problem input targets no active problem");
		}
		return [newProblemDismissedMarker(input.problemCallId)];
	}
	const pending = danglingQuestionOf(record.messages);
	if (!pending || pending.toolCallId !== input.toolCallId) {
		throw new ChatInputError("dismiss input targets no pending question call");
	}
	if (input.answer.kind !== toolQuestionKind(pending.tool)) {
		throw new ChatInputError("dismiss input's answer kind does not match the question");
	}
	return [newAnswerResult(input.toolCallId, pending.tool, input.answer)];
}

export class ChatInputError extends Error {}

export function parseChatInput(input: unknown): ChatInput {
	if (typeof input !== "object" || input === null) throw new ChatInputError("input must be an object");
	const i = input as Record<string, unknown>;
	switch (i.type) {
		case "text":
			if (typeof i.text !== "string" || (i.text as string).trim().length === 0) {
				throw new ChatInputError("text input requires non-empty text");
			}
			return { type: "text", text: i.text };
		case "answer":
			if (typeof i.toolCallId !== "string" || i.toolCallId.length === 0) {
				throw new ChatInputError("answer input requires toolCallId");
			}
			if (typeof i.answer !== "object" || i.answer === null) {
				throw new ChatInputError("answer input requires the graded answer object");
			}
			{
				const confidence = (i.answer as { confidence?: unknown }).confidence;
				if (confidence !== undefined && !isAcceptedConfidence(confidence)) {
					throw new ChatInputError(
						`answer confidence must be one of ${[...CONFIDENCE_LEVELS.map((l) => l.value), ...CONFIDENCE_STOPS].join(", ")}`,
					);
				}
			}
			return { type: "answer", toolCallId: i.toolCallId, answer: i.answer as QuestionAnswerData };
		case "continue":
			return { type: "continue" };
		case "thinking":
			if (typeof i.problemCallId !== "string" || i.problemCallId.length === 0) {
				throw new ChatInputError("thinking input requires problemCallId");
			}
			if (i.hint !== undefined && !isHintRung(i.hint)) {
				throw new ChatInputError("thinking input's hint must be 1, 2, or 3");
			}
			if (typeof i.text !== "string" || (i.text.trim().length === 0 && i.hint === undefined)) {
				throw new ChatInputError("thinking input requires non-empty text");
			}
			return {
				type: "thinking",
				problemCallId: i.problemCallId,
				text: i.text,
				...(i.hint !== undefined ? { hint: i.hint as HintRung } : {}),
			};
		case "next":
			return { type: "next" };
		default:
			throw new ChatInputError(`unknown input type: ${String(i.type)}`);
	}
}

/** Pure; the caller persists the result. Throws ChatInputError when the
 *  input targets no pending question or active problem. */
export function inputAppends(
	record: { messages: LhMessage[]; kind?: string },
	input: ChatInput,
): LhMessage[] {
	switch (input.type) {
		case "text":
			return [...dismissalConclusion(record), newUserMessage(input.text)];
		case "answer": {
			const pending = danglingQuestionOf(record.messages);
			if (!pending || pending.toolCallId !== input.toolCallId) {
				throw new ChatInputError("answer input targets no pending question call");
			}
			return [newAnswerResult(input.toolCallId, pending.tool, input.answer)];
		}
		case "continue":
			return dismissalConclusion(record);
		case "thinking": {
			const active = activeProblemOf(record.messages);
			if (!active || active.toolCallId !== input.problemCallId) {
				throw new ChatInputError("thinking input targets no active problem");
			}
			return [...dismissalConclusion(record), newThinkingMessage(input.problemCallId, input.text, input.hint)];
		}
		case "next": {
			if (record.kind !== "practice") {
				throw new ChatInputError("next input is a practice-session affordance");
			}
			if (activeProblemOf(record.messages)) {
				throw new ChatInputError("next input requires no active problem");
			}
			return [...dismissalConclusion(record), newNextMessage()];
		}
	}
}

function dismissalConclusion(record: { messages: LhMessage[] }): LhMessage[] {
	const problemCallId = pendingProblemDismissalOf(record.messages);
	return problemCallId ? concludedByDismissalPair(problemCallId) : [];
}

export function isQuestionTool(name: string): boolean {
	return (QUESTION_TOOLS as readonly string[]).includes(name);
}
