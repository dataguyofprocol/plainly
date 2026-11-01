/**
 * Bounded local port of Pi coding-agent 1.4.0 cutoff selection. See
 * docs/compaction-accounting.md for the upstream MIT notice.
 */

import type { PlanTree } from "./contracts/plan.ts";
import { derivePlanStatusesLh, derivedNodeStatus } from "./contracts/plan.ts";
import { COMPACTED_HISTORY_HEADER } from "./contracts/chat.ts";
import type { LhMessage, LhMarkerMessage } from "./native-messages.ts";
import { newMessageId } from "./native-messages.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, SystemMessage } from "@earendil-works/pi-ai";

export const KEEP_RECENT_TOKENS = 20_000;

/** Subtracted from the model's contextWindow when the window, not the
 * user's threshold, binds. */
export const COMPACTION_RESERVE_TOKENS = 16_384;

export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 150_000;

const SUMMARY_TOOL_RESULT_TRUNCATE = 2_000;

/** Mirrors pi's calculateContextTokens. */
export function calculateContextTokens(usage: {
	totalTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}): number {
	return (
		usage.totalTokens ||
		(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
	);
}

/** Pi 1.4.0's estimateTokens heuristic. */
export function estimateMessageTokens(message: LhMessage | AgentMessage): number {
	const content: unknown = (message as { content?: unknown }).content;
	let chars = 0;
	if ((message as { role?: string }).role === "assistant") {
		for (const block of (Array.isArray(content) ? content : []) as Array<{
			type: string;
			text?: string;
			thinking?: string;
			name?: string;
			arguments?: unknown;
		}>) {
			if (block.type === "text") chars += block.text?.length ?? 0;
			else if (block.type === "thinking") chars += block.thinking?.length ?? 0;
			else if (block.type === "toolCall") chars += (block.name?.length ?? 0) + JSON.stringify(block.arguments ?? {}).length;
		}
	} else {
		chars += textCharsOfContent(content);
		if (message.role === "system") {
			const system = message as SystemMessage;
			for (const section of Object.values(system.sections ?? {})) chars += section?.length ?? 0;
			if (system.toolsAdded) chars += JSON.stringify(system.toolsAdded).length;
		}
	}
	return Math.ceil(chars / 4);
}

const ESTIMATED_IMAGE_CHARS = 4_800;
function textCharsOfContent(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content as Array<string | { type?: string; text?: string }>) {
		if (typeof block === "string") chars += block.length;
		else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS;
		else if (block?.type === "text") chars += block.text?.length ?? 0;
	}
	return chars;
}

/** Index of the newest assistant message with nonzero usage that was not
 * aborted or errored. Null when none exists after the newest compaction
 * marker: pre-compaction usage describes the pre-cut context. */
export function lastAssistantUsageIndex(
	messages: readonly (LhMessage | AgentMessage)[],
): number | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if ((m as { role?: string }).role === "custom" && (m as LhMarkerMessage).customType === "compaction") return null;
		if ((m as { role?: string }).role !== "assistant") continue;
		const a = m as AssistantMessage & { stopReason?: string };
		if (a.stopReason === "aborted" || a.stopReason === "error") continue;
		if (calculateContextTokens((a.usage ?? {}) as Parameters<typeof calculateContextTokens>[0]) === 0) continue;
		return i;
	}
	return null;
}

export interface ContextTokenEstimate {
	tokens: number;
	/** 0 when unanchored. */
	usageTokens: number;
	/** chars/4 estimate after the anchor, or of everything when unanchored. */
	trailingTokens: number;
	lastUsageIndex: number | null;
}

/** Mirrors pi's estimateContextTokens. */
export function estimateContextTokens(
	messages: readonly (LhMessage | AgentMessage)[],
): ContextTokenEstimate {
	const anchor = lastAssistantUsageIndex(messages);
	if (anchor === null) {
		let trailing = 0;
		for (const m of messages) trailing += estimateMessageTokens(m);
		return { tokens: trailing, usageTokens: 0, trailingTokens: trailing, lastUsageIndex: null };
	}
	const anchored = messages[anchor]! as AssistantMessage;
	const usageTokens = calculateContextTokens(anchored.usage as Parameters<typeof calculateContextTokens>[0]);
	let trailing = 0;
	for (let i = anchor + 1; i < messages.length; i++) trailing += estimateMessageTokens(messages[i]!);
	return { tokens: usageTokens + trailing, usageTokens, trailingTokens: trailing, lastUsageIndex: anchor };
}

export function estimateTokens(messages: readonly (LhMessage | AgentMessage)[]): number {
	let total = 0;
	for (const m of messages) total += estimateMessageTokens(m);
	return total;
}

function cutMessage(message: LhMessage): LhMessage | null {
	if (message.role !== "custom") return message;
	if (["compaction", "plan-block", "problem-dismissed"].includes(message.customType)) return null;
	return message;
}

/** Local port of pi-coding-agent 1.4.0 findCutPoint (MIT). Returns the
 * first kept record index; a no-progress cut drops nothing. Keep this and
 * estimateMessageTokens aligned with Pi when upgrading it.
 */
export function compactionCutIndex(messages: readonly LhMessage[], keepRecentTokens = KEEP_RECENT_TOKENS): number {
	const previous = activeCompactionOf(messages);
	const previousKept = previous ? keptIndexFor(messages, previous) : -1;
	const start = Math.max(0, previousKept);
	const points: number[] = [];
	for (let i = start; i < messages.length; i++) {
		const message = cutMessage(messages[i]!);
		if (message && (message.role === "user" || message.role === "assistant" || message.role === "custom")) points.push(i);
	}
	if (!points.length) return start;
	let cut = points[0]!;
	let accumulated = 0;
	for (let i = messages.length - 1; i >= start; i--) {
		const message = cutMessage(messages[i]!);
		const tokens = message ? estimateMessageTokens(message) : 0;
		if (tokens === 0) continue;
		accumulated += tokens;
		if (accumulated >= keepRecentTokens) {
			cut = points.find((candidate) => candidate >= i) ?? points.at(-1)!;
			break;
		}
	}
	while (cut > start) {
		const before = messages[cut - 1]!;
		if ((before.role === "custom" && before.customType === "compaction") || cutMessage(before)) break;
		cut--;
	}
	return cut;
}

/** UI payload, never model-visible. */
export interface CompactionDetails {
	firstKeptMessageId: string;
	tokensBefore: number;
	/** provider:id of the summarizing model. Provenance only. */
	model?: string;
	at: string;
}

export function newCompactionMarker(summary: string, details: CompactionDetails): LhMarkerMessage {
	return {
		id: newMessageId(),
		role: "custom",
		customType: "compaction",
		content: `${COMPACTED_HISTORY_HEADER}\n\n${summary.trim()}`,
		display: true,
		details,
		timestamp: Date.now(),
	};
}

/** The newest compaction marker; older ones are superseded. */
export function activeCompactionOf(messages: readonly LhMessage[]): (LhMarkerMessage & { details: CompactionDetails }) | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if ((m as { role?: string }).role !== "custom") continue;
		const marker = m as LhMarkerMessage;
		if (marker.customType === "compaction") {
			const details = marker.details as Partial<CompactionDetails>;
			if (typeof details.firstKeptMessageId === "string") {
				return marker as LhMarkerMessage & { details: CompactionDetails };
			}
		}
	}
	return null;
}

/** -1 when the marker names an id that no longer exists. */
export function keptIndexFor(messages: readonly LhMessage[], marker: LhMarkerMessage & { details: CompactionDetails }): number {
	const id = marker.details.firstKeptMessageId;
	for (let i = 0; i < messages.length; i++) {
		if (messages[i]!.id === id) return i;
	}
	return -1;
}

export function serializeForSummary(messages: readonly LhMessage[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "user") {
			lines.push(`[LEARNER] ${(m as { content: string }).content}`);
		} else if (role === "assistant") {
			const assistant = m as AssistantMessage;
			const blocks: string[] = [];
			for (const b of assistant.content) {
				if (b.type === "text") blocks.push(b.text);
				else if (b.type === "toolCall") blocks.push(`(tool call ${b.name}: ${JSON.stringify(b.arguments)})`);
			}
			if (blocks.length > 0) lines.push(`[TUTOR] ${blocks.join("\n")}`);
		} else if (role === "toolResult") {
			const result = m as ToolResultMessage;
			const text = result.content
				.map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
				.join("\n");
			lines.push(
				`[RESULT for ${result.toolName}${result.isError ? " (error)" : ""}] ${
					text.length > SUMMARY_TOOL_RESULT_TRUNCATE ? `${text.slice(0, SUMMARY_TOOL_RESULT_TRUNCATE)}…[truncated]` : text
				}`,
			);
		} else if (role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "plan-block") continue;
			lines.push(`[SYSTEM NOTE] ${marker.content}`);
		}
	}
	return lines.join("\n\n");
}

/** Null for an absent or empty tree. */
export function planTreeToText(tree: PlanTree | undefined, messages: readonly LhMessage[]): string | null {
	if (!tree || tree.nodes.length === 0) return null;
	const statuses = derivePlanStatusesLh(tree, messages);
	const byId = new Map(tree.nodes.map((n) => [n.id, n]));
	const lines: string[] = [];
	for (const node of tree.nodes) {
		const status = derivedNodeStatus(statuses, node.id);
		const summary = node.summary ? ` — ${node.summary}` : "";
		lines.push(`- [${status}] ${node.title} (${node.id})${summary}`);
	}
	for (const edge of tree.edges) {
		const from = byId.get(edge.from);
		const to = byId.get(edge.to);
		if (from && to) lines.push(`- ${from.title} → ${to.title} (${from.id} → ${to.id})`);
	}
	return lines.join("\n");
}

export function buildCompactionPrompt(input: {
	/** Output of serializeForSummary. */
	spanText: string;
	/** Output of planTreeToText. */
	planTreeText: string | null;
	kind: "teach" | "practice" | "probe";
}): string {
	const planSection =
		input.planTreeText ?? "No plan tree exists in this session (nothing was persisted).";
	return `You are compacting the earlier part of a tutoring session — writing the summary your future self will read INSTEAD of that transcript. Everything before the cut is replaced by what you write; everything after stays verbatim. The learner's transcript below labels the learner as [LEARNER], the tutoring agent as [TUTOR], tool traffic as [RESULT …]/[SYSTEM NOTE].

Write the summary with EXACTLY these sections, in this order:

## The learner's understanding
The most detailed picture you can give of what this learner knows and how that EVOLVED across the session: what they answered and how well (quiz outcomes, correct reasoning, mistakes), their stated or displayed confidence, misconceptions that surfaced, which were corrected and which still stand. This section carries the most weight — future teaching decisions hang on it.

## The teaching arc
How the session progressed: what was covered and in what order, which explanations landed and which didn't, how the learner responded, where the momentum went. Include probe-phase findings if present.

## The plan dependency tree
Reproduce the session's current plan tree verbatim from the structure below — do not drop nodes, edges, or statuses.

${planSection}

## The current moment
What is happening RIGHT NOW at the cut: any question or problem awaiting the learner's answer, any commitment the agent has made that a later turn must honor, and the immediate next step.

Rules: no praise, no filler, no speculation beyond the transcript. Every claim about the learner must be traceable to what they actually said or answered. Keep every identifier (proposition ids, node ids, file paths) exact.

TRANSCRIPT TO SUMMARIZE:

${input.spanText}`;
}
