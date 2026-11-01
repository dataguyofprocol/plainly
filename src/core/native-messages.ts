/**
 * Pi's session format gives every ENTRY an id, never the message, so every
 * record message carries one extra field, `id`, alongside pi's native shape.
 * toLlmMessages strips it at the wire.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { QUESTION_TOOLS } from "./pending.ts";
import {
	CONCLUDE_ACK_TEXT,
	HANDOFF_TEXT,
	hintRequestText,
	type HintRung,
	NEXT_PROBLEM_TEXT,
	THINKING_LABEL,
} from "./contracts/chat.ts";
import { compactAnswerForModel, type QuestionAnswerData } from "./question-core.ts";
import { activeCompactionOf, keptIndexFor } from "./compaction.ts";

export const INTERRUPTED_TEXT =
	"The question was interrupted — the learner never answered; continue without holding a result for it.";

/** Shaped like pi's own CustomMessage. */
export interface LhMarkerMessage {
	id: string;
	role: "custom";
	customType:
		| "graph-context"
		| "probe-handoff"
		| "subagent-steer"
		| "subagent-abort"
		| "plan-block"
		| "practice-thinking"
		| "practice-next"
		| "problem-dismissed"
		| "compaction";
	/** Model-facing text; "" for UI-only markers. */
	content: string;
	display: boolean;
	/** UI payload, never model-visible. */
	details: unknown;
	timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		lhMarker: LhMarkerMessage;
	}
}

export type LhMessage = (UserMessage | AssistantMessage | ToolResultMessage | LhMarkerMessage) & { id: string };

export function asAgentMessages(messages: readonly LhMessage[]): AgentMessage[] {
	return messages as unknown as AgentMessage[];
}

export function newMessageId(): string {
	return `msg_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function newUserMessage(text: string): LhMessage & UserMessage {
	return {
		id: newMessageId(),
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

/** `id` is the client-minted steer id, so the optimistic indicator and
 *  the settled record share one identity. */
export function newUserSteer(text: string, id: string): LhMessage & UserMessage {
	return { id, role: "user", content: text, timestamp: Date.now() };
}

/** The model sees compactAnswerForModel(answer); `details` keeps the full
 *  QuestionAnswerData for the record and the UI. */
export function newAnswerResult(
	toolCallId: string,
	toolName: string,
	answer: unknown,
): LhMessage & ToolResultMessage {
	return {
		id: newMessageId(),
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: JSON.stringify(compactAnswerForModel(answer as QuestionAnswerData)) }],
		// pi-ai 0.87.1 narrowed details to JsonRepresentation; answers are JSON-safe.
		details: answer as ToolResultMessage["details"],
		isError: false,
		timestamp: Date.now(),
	};
}

export function newHandoffMessage(chatId: string): LhMarkerMessage {
	return {
		id: `steer_probe_${chatId}`,
		role: "custom",
		customType: "probe-handoff",
		content: HANDOFF_TEXT,
		display: true,
		details: { chatId },
		timestamp: Date.now(),
	};
}

/** UI-only. `planCallId` keys idempotent emission. */
export function newPlanBlockMessage(
	planCallId: string,
	block: unknown,
): LhMarkerMessage {
	return {
		id: `pb_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		role: "custom",
		customType: "plan-block",
		content: "",
		display: true,
		details: { planCallId, block },
		timestamp: Date.now(),
	};
}

export const PRACTICE_PROBLEM_TOOL = "problem";
export const PRACTICE_CONCLUDE_TOOL = "conclude";

/** Name and statement as the learner saw them at pick time. */
export interface GraphContextPick {
	id: string;
	name: string;
	statement: string;
}

/** `chains` are pre-formatted formatChainLine lines. */
export function newGraphContextMessage(picks: readonly GraphContextPick[], chains: readonly string[]): LhMarkerMessage {
	const lines = [
		"[Session context] — picked from the learner's knowledge map when starting this session:",
		"",
		"Propositions (id — name: statement; the problem tool's target field uses these ids):",
		...picks.map((p) => `- [${p.id}] ${p.name}: ${p.statement}`),
	];
	if (chains.length > 0) {
		lines.push("", "Reasoning chains among them (premises → conclusion):", ...chains.map((c) => `- ${c}`));
	}
	return {
		id: newMessageId(),
		role: "custom",
		customType: "graph-context",
		content: lines.join("\n"),
		display: true,
		details: { propositions: picks, chains },
		timestamp: Date.now(),
	};
}

export function newThinkingMessage(problemCallId: string, text: string, hint?: HintRung): LhMarkerMessage {
	const thinking = text.trim().length > 0 || !hint ? `${THINKING_LABEL}:\n${text}` : "";
	const content = hint ? [hintRequestText(hint), thinking].filter(Boolean).join("\n\n") : thinking;
	return {
		id: newMessageId(),
		role: "custom",
		customType: "practice-thinking",
		content,
		display: true,
		details: hint ? { problemCallId, text, hint } : { problemCallId, text },
		timestamp: Date.now(),
	};
}

/** Requested hint rungs for one problem, in request order. */
export function practiceHintsUsed(messages: readonly LhMessage[], problemCallId: string): HintRung[] {
	const rungs: HintRung[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "custom") continue;
		const marker = m as LhMarkerMessage;
		if (marker.customType !== "practice-thinking") continue;
		const details = marker.details as { problemCallId?: unknown; hint?: unknown } | undefined;
		if (details?.problemCallId !== problemCallId) continue;
		if (details.hint === 1 || details.hint === 2 || details.hint === 3) rungs.push(details.hint);
	}
	return rungs;
}

export function newNextMessage(): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "practice-next",
		content: NEXT_PROBLEM_TEXT,
		display: true,
		details: {},
		timestamp: Date.now(),
	};
}

/** UI-only. The model sees the dismissal later as concludedByDismissalPair. */
export function newProblemDismissedMarker(problemCallId: string): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "problem-dismissed",
		content: "",
		display: true,
		details: { problemCallId },
		timestamp: Date.now(),
	};
}

/** A synthetic conclude call (outcome "dismissed") plus its ack, prepended
 *  to the user's next input. */
export function concludedByDismissalPair(
	problemCallId: string,
): [LhMessage & AssistantMessage, LhMessage & ToolResultMessage] {
	const callId = `call_conc_${problemCallId}`;
	const now = Date.now();
	// pi-ai's history converters read only content blocks, so these stamps
	// never reach the wire.
	const syntheticStamps = {
		api: "faux",
		provider: "synthetic",
		model: "synthetic-conclude",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
	} as const;
	return [
		{
			id: newMessageId(),
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: PRACTICE_CONCLUDE_TOOL, arguments: { outcome: "dismissed" } }],
			timestamp: now,
			...syntheticStamps,
		},
		{
			id: newMessageId(),
			role: "toolResult",
			toolCallId: callId,
			toolName: PRACTICE_CONCLUDE_TOOL,
			content: [{ type: "text", text: CONCLUDE_ACK_TEXT }],
			details: { outcome: "dismissed", problemCallId },
			isError: false,
			timestamp: now,
		},
	];
}

function cleanToolCallIds(messages: readonly LhMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage;
		if (!result.isError) ids.add(result.toolCallId);
	}
	return ids;
}

export function modelSolutionForConclude(
	messages: readonly LhMessage[],
	concludeCallId: string,
): string | undefined {
	const input = problemInputForConclude(messages, concludeCallId);
	return typeof input?.modelSolution === "string" ? input.modelSolution : undefined;
}

/** Arguments of the newest cleanly-acked problem call before this
 *  conclude call. */
export function problemInputForConclude(
	messages: readonly LhMessage[],
	concludeCallId: string,
): { statement?: unknown; mode?: unknown; target?: unknown; modelSolution?: unknown } | undefined {
	let mi = messages.findIndex(
		(m) =>
			(m as { role?: string }).role === "assistant" &&
			(m as AssistantMessage).content.some(
				(b) => b.type === "toolCall" && b.id === concludeCallId,
			),
	);
	if (mi < 0) return undefined;
	const clean = cleanToolCallIds(messages);
	for (; mi >= 0; mi--) {
		const m = messages[mi]!;
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		for (let bi = assistant.content.length - 1; bi >= 0; bi--) {
			const block = assistant.content[bi]!;
			if (block.type !== "toolCall" || block.name !== PRACTICE_PROBLEM_TOOL) continue;
			if (!clean.has(block.id)) continue;
			return (block.arguments ?? undefined) as
				| { statement?: unknown; mode?: unknown; target?: unknown; modelSolution?: unknown }
				| undefined;
		}
	}
	return undefined;
}

export function activeProblemOf(
	messages: readonly LhMessage[],
): { toolCallId: string; input: unknown } | null {
	// Calls count only through clean results; errored and dangling calls are skipped.
	const cleanCallIds = cleanToolCallIds(messages);
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "problem-dismissed") return null;
			continue;
		}
		if (role === "assistant") {
			const assistant = m as AssistantMessage & { id: string };
			for (let bi = assistant.content.length - 1; bi >= 0; bi--) {
				const block = assistant.content[bi]!;
				if (block.type !== "toolCall") continue;
				if (block.name === PRACTICE_CONCLUDE_TOOL) {
					if (cleanCallIds.has(block.id)) return null;
					continue;
				}
				if (block.name !== PRACTICE_PROBLEM_TOOL) continue;
				if (cleanCallIds.has(block.id)) return { toolCallId: block.id, input: block.arguments };
			}
			continue;
		}
	}
	return null;
}

/** The problem call id of a dismissal still awaiting its conclude pair. */
export function pendingProblemDismissalOf(messages: readonly LhMessage[]): string | null {
	const cleanCallIds = cleanToolCallIds(messages);
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "problem-dismissed") {
				return (marker.details as { problemCallId?: unknown }).problemCallId as string;
			}
			continue;
		}
		if (role === "assistant") {
			const assistant = m as AssistantMessage;
			for (let bi = assistant.content.length - 1; bi >= 0; bi--) {
				const block = assistant.content[bi]!;
				if (block.type !== "toolCall" && block.type !== "text") continue;
				if (block.type === "toolCall" && block.name === PRACTICE_CONCLUDE_TOOL) {
					if (cleanCallIds.has(block.id)) return null;
					continue;
				}
				if (block.type === "toolCall" && block.name === PRACTICE_PROBLEM_TOOL) {
					if (cleanCallIds.has(block.id)) return null;
					continue;
				}
			}
			continue;
		}
	}
	return null;
}

function resultIdsFrom(messages: readonly AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult") {
			ids.add((m as ToolResultMessage).toolCallId);
		}
	}
	return ids;
}

/**
 * The agent's convertToLlm. pi-agent-core requires it never throw: unknown
 * shapes pass through untouched. Dangling tool calls get a synthesized
 * result because providers reject a tool call without one.
 */
export function toLlmMessages(messages: readonly AgentMessage[]): Message[] {
	const lhMessages = messages as readonly LhMessage[];
	const active = activeCompactionOf(lhMessages);
	let start = 0;
	let head: Message | null = null;
	if (active) {
		const kept = keptIndexFor(lhMessages, active);
		if (kept > 0) {
			start = kept;
			head = {
				role: "user",
				content: [{ type: "text", text: active.content }],
				timestamp: active.timestamp,
			};
		}
	}
	// pi-agent-core's Agent seeds a SystemMessage carrying the system prompt
	// and tool declarations at messages[0]. It is not in the record, so it
	// must survive the compaction cut ahead of the compaction head.
	const leading =
		(messages[0] as { role?: string } | undefined)?.role === "system" ? (messages[0] as Message) : null;
	const out: Message[] = [];
	if (leading) out.push(leading);
	if (head) out.push(head);
	for (let i = leading ? Math.max(start, 1) : start; i < messages.length; i++) {
		const m = messages[i]!;
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "plan-block" || marker.customType === "problem-dismissed") continue;
			if (marker.customType === "compaction" && head !== null && marker.id === active!.id) continue;
			out.push({
				role: "user",
				content: [{ type: "text", text: marker.content }],
			timestamp: marker.timestamp,
			});
			continue;
		}
		const { id: _id, ...native } = m as LhMessage;
		out.push(native as Message);
		if (role === "assistant") {
			const assistant = m as AssistantMessage;
			const calls = assistant.content.filter((b) => b.type === "toolCall");
			if (calls.length === 0) continue;
			const answered = resultIdsFrom(messages.slice(i + 1));
			for (const call of calls) {
				if (answered.has(call.id)) continue;
				out.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: INTERRUPTED_TEXT }],
					isError: false,
					timestamp: assistant.timestamp,
				});
			}
		}
	}
	return out;
}

/** The newest assistant message's first unanswered question-tool call. */
export function danglingQuestionOf(
	messages: readonly LhMessage[],
): { toolCallId: string; tool: string; input: unknown } | null {
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]!;
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage & { id: string };
		const answered = resultIdsFrom(messages.slice(mi + 1));
		for (const block of assistant.content) {
			if (block.type !== "toolCall") continue;
			if (!(QUESTION_TOOLS as readonly string[]).includes(block.name)) continue;
			if (answered.has(block.id)) continue;
			return { toolCallId: block.id, tool: block.name, input: block.arguments };
		}
		return null;
	}
	return null;
}

export function hasProbeDone(messages: readonly LhMessage[]): boolean {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		if (assistant.content.some((b) => b.type === "toolCall" && b.name === "probe_done")) return true;
	}
	return false;
}

export function answeredCallIds(messages: readonly LhMessage[]): Set<string> {
	return resultIdsFrom(messages);
}

function isDismissedResult(m: LhMessage): boolean {
	if ((m as { role?: string }).role !== "toolResult") return false;
	const details = (m as { details?: unknown }).details as { dismissed?: unknown } | undefined;
	return details?.dismissed === true;
}

/** True while the record ends in a user dismissal: nothing auto-wakes. */
export function endsInDismissal(messages: readonly LhMessage[]): boolean {
	const last = messages[messages.length - 1];
	return last !== undefined && isDismissedResult(last);
}

export type RequestCause = "foreground" | "background";
export type ReconstructedCause = RequestCause | "ambiguous";
export type NativeInputCause = "learner" | "automatic" | "neutral" | "unrecognizable";
/** Native causes only: flattened user roles, IDs' prefixes and prose confer no permission. */
export function nativeInputCause(message: AgentMessage, history: readonly AgentMessage[]): NativeInputCause {
	if (message.role === "user") return "learner";
	if (message.role === "system" || message.role === "assistant") return "neutral";
	if (message.role === "custom") {
		if (["probe-handoff", "subagent-steer", "subagent-abort"].includes(message.customType)) return "automatic";
		if (["practice-thinking", "practice-next"].includes(message.customType)) return "learner";
		return ["graph-context", "plan-block", "problem-dismissed", "compaction"].includes(message.customType) ? "neutral" : "unrecognizable";
	}
	if (message.role === "toolResult") {
		if (!(QUESTION_TOOLS as readonly string[]).includes(message.toolName) || message.isError || message.details == null || (message.details as { dismissed?: boolean }).dismissed) return "neutral";
		const details = message.details as Partial<QuestionAnswerData>;
		if (!["quiz", "ask", "explain"].includes(details.kind ?? "") || typeof details.questionText !== "string" || typeof details.dontKnow !== "boolean" || !Array.isArray(details.answers) || typeof details.answeredAt !== "string") return "unrecognizable";
		const calls = history.flatMap((m) => m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall" && b.id === message.toolCallId) : []);
		return calls.length === 1 && calls[0]?.type === "toolCall" && calls[0].name === message.toolName ? "learner" : "unrecognizable";
	}
	return "unrecognizable";
}
/** Full persisted native record, including pre-compaction causes. Never guessed foreground. */
export function reconstructRequestCause(messages: readonly LhMessage[]): ReconstructedCause {
	let inherited: ReconstructedCause = "ambiguous";
	let triggers: NativeInputCause[] = [];
	const seen = new Map<string, string>();
	const history: AgentMessage[] = [];
	const resolve = (): ReconstructedCause => {
		if (triggers.includes("unrecognizable")) return "ambiguous";
		const lastLearner = triggers.lastIndexOf("learner"), lastAutomatic = triggers.lastIndexOf("automatic");
		if (lastLearner < 0 && lastAutomatic < 0) return inherited;
		if (lastAutomatic < 0) return "foreground";
		if (lastLearner < lastAutomatic) return "background";
		return "ambiguous";
	};
	for (const message of messages) {
		const cause = nativeInputCause(message, history);
		const id = (message as { id?: string }).id;
		if (id) {
			const value = JSON.stringify(message);
			if (seen.has(id)) { if (seen.get(id) !== value) triggers.push("unrecognizable"); continue; }
			seen.set(id, value);
		} else if (cause !== "neutral") triggers.push("unrecognizable");
		if (message.role === "assistant" && !(message.provider === "synthetic" && message.api === "faux" && message.model === "synthetic-conclude" && message.content.some((b) => b.type === "toolCall" && b.name === "conclude" && b.arguments?.outcome === "dismissed"))) {
			inherited = resolve(); triggers = [];
		} else if (cause !== "neutral") triggers.push(cause);
		history.push(message);
	}
	return resolve();
}

/** True when the record ends on a tool-result batch whose owning assistant
 *  message has at least one call, all answered, and the batch neither ends
 *  in a dismissal nor acks a problem pose. */
export function needsContinuation(messages: readonly LhMessage[]): boolean {
	const last = messages[messages.length - 1];
	if (!last || (last as { role?: string }).role !== "toolResult") return false;
	let start = messages.length - 1;
	while (
		start > 0 &&
		(messages[start - 1] as { role?: string } | undefined)?.role === "toolResult"
	) {
		start--;
	}
	if (isDismissedResult(messages[messages.length - 1]!)) {
		return false;
	}
	const owner = messages[start - 1];
	if (!owner || (owner as { role?: string }).role !== "assistant") return false;
	const content = (owner as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	const results = messages.slice(start) as ToolResultMessage[];
	const posedProblem = results.some(
		(m) => m.toolName === PRACTICE_PROBLEM_TOOL && !m.isError && m.details == null,
	);
	if (posedProblem) return false;
	const answered = new Set(results.map((m) => m.toolCallId));
	const calls = (content as Array<{ type?: string; id?: string }>).filter(
		(b) => b.type === "toolCall" && typeof b.id === "string",
	);
	return calls.length > 0 && calls.every((b) => answered.has(b.id!));
}
