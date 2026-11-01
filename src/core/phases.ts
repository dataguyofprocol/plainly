export type Phase3 = "probe" | "plan" | "teach";

export interface PhaseMessage {
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown }>;
}

function taggedNodeId(input: unknown): boolean {
	return (
		typeof input === "object" &&
		input !== null &&
		typeof (input as { nodeId?: unknown }).nodeId === "string" &&
		(input as { nodeId: string }).nodeId.length > 0
	);
}

/** `upToIndex` is inclusive; defaults to the last message. */
export function phaseAt3(messages: readonly PhaseMessage[], upToIndex?: number): Phase3 {
	let phase: Phase3 = "probe";
	const last = Math.min(upToIndex ?? messages.length - 1, messages.length - 1);
	for (let i = 0; i <= last; i++) {
		phase = advance(phase, messages[i]?.parts);
	}
	return phase;
}

function advance(
	phase: Phase3,
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown }> | undefined,
): Phase3 {
	if (!parts) return phase;
	for (const part of parts) {
		if (phase === "probe" && part.type === "tool-probe_done" && part.state === "output-available") {
			phase = "plan";
		}
		if (
			phase === "plan" &&
			(part.type === "tool-quiz" || part.type === "tool-explain") &&
			taggedNodeId(part.input)
		) {
			phase = "teach";
		}
	}
	return phase;
}

/** The part index of the step-start governing the first tagged
 *  quiz/explain call, or -1 when that call sits in the message's first
 *  step. */
export function teachStepIndex(
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown }>,
): number {
	let stepStarts = 0;
	let latest = -1;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part.type === "step-start") {
			stepStarts++;
			latest = i;
			continue;
		}
		if (
			(part.type === "tool-quiz" || part.type === "tool-explain") &&
			taggedNodeId(part.input)
		) {
			return stepStarts <= 1 ? -1 : latest;
		}
	}
	return -1;
}

/** out[i] === phaseAt3(messages, i) for every i. */
export function phaseTimeline(messages: readonly PhaseMessage[]): Phase3[] {
	const out: Phase3[] = [];
	let phase: Phase3 = "probe";
	for (let i = 0; i < messages.length; i++) {
		phase = advance(phase, messages[i]?.parts);
		out.push(phase);
	}
	return out;
}

import type { LhMessage } from "./native-messages.ts";

/** phaseAt3 over a native record. */
export function phaseAt3Lh(messages: readonly LhMessage[], upToIndex?: number): Phase3 {
	let phase: Phase3 = "probe";
	const last = Math.min(upToIndex ?? messages.length - 1, messages.length - 1);
	for (let i = 0; i <= last; i++) {
		const m = messages[i]!;
		const role = (m as { role?: string }).role;
		if (role === "toolResult") {
			const result = m as { toolName?: string; isError?: boolean };
			if (
				phase === "probe" &&
				result.toolName === "probe_done" &&
				!result.isError
			) {
				phase = "plan";
			}
		} else if (role === "assistant") {
			const content = (m as { content?: ReadonlyArray<{ type?: string; name?: string; arguments?: unknown }> }).content ?? [];
			if (phase === "plan") {
				for (const block of content) {
					if (
						block.type === "toolCall" &&
						(block.name === "quiz" || block.name === "explain") &&
						taggedNodeId(block.arguments)
					) {
						phase = "teach";
						break;
					}
				}
			}
		}
	}
	return phase;
}
