import { createHash } from "node:crypto";

import type { CoverageEntry } from "./contracts/graph.ts";
import type { LhMessage } from "./native-messages.ts";

export type { CoverageEntry };

function textOf(content: unknown): string[] {
	if (typeof content === "string") return content.trim() ? [content] : [];
	if (!Array.isArray(content)) return [];
	return content
		.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.filter((t) => t.trim().length > 0);
}

/**
 * Only assistant text blocks yield lines. messageFingerprint hashes these, so
 * changing the line format re-opens coverage for every message. `mid` is part
 * of the hash input, so identical prose in two messages is two slots.
 */
export function messageViewLines(message: LhMessage, mid: string): string[] {
	const lines: string[] = [];
	if ((message as { role?: string }).role !== "assistant") return lines;
	for (const text of textOf((message as { content: unknown }).content)) {
		lines.push(`TEACHER [${mid}] ${text.trim()}`);
	}
	return lines;
}

/** Same selection as messageViewLines, without the prefix. */
export function teacherProseBlocks(messages: ReadonlyArray<LhMessage>): string[] {
	const out: string[] = [];
	for (const message of messages) {
		if ((message as { role?: string }).role !== "assistant") continue;
		for (const text of textOf((message as { content: unknown }).content)) out.push(text.trim());
	}
	return out;
}

export function viewTokens(lines: string[]): number {
	return Math.ceil(lines.join("\n").length / 4);
}

export function messageFingerprint(message: LhMessage): string {
	const h = createHash("sha256");
	h.update(JSON.stringify([(message as { role?: string }).role, messageViewLines(message, message.id)]));
	return h.digest("hex");
}

export interface CoverageSlot {
	message: LhMessage;
	fp: string;
	tokens: number;
}

export function coverageSlots(messages: ReadonlyArray<LhMessage>): CoverageSlot[] {
	return messages.map((message) => ({ message, fp: messageFingerprint(message), tokens: viewTokens(messageViewLines(message, message.id)) }));
}

export function coveredSet(entries: ReadonlyArray<CoverageEntry>, chatId: string): Set<string> {
	const out = new Set<string>();
	for (const e of entries) if (e.chatId === chatId) out.add(e.fp);
	return out;
}

/** `uncovered` holds indexes into `slots`. Messages with no view lines are
 *  neither covered nor uncovered. */
export function coverageOf(
	messages: ReadonlyArray<LhMessage>,
	entries: ReadonlyArray<CoverageEntry>,
	chatId: string,
): {
	slots: CoverageSlot[];
	uncovered: number[];
	coveredTokens: number;
	uncoveredTokens: number;
	coveredCount: number;
	uncoveredCount: number;
} {
	const covered = coveredSet(entries, chatId);
	const slots = coverageSlots(messages);
	const uncovered: number[] = [];
	let coveredTokens = 0;
	let uncoveredTokens = 0;
	for (let i = 0; i < slots.length; i++) {
		const slot = slots[i]!;
		if (messageViewLines(slot.message, slot.message.id).length === 0) continue;
		if (covered.has(slot.fp)) coveredTokens += slot.tokens;
		else {
			uncovered.push(i);
			uncoveredTokens += slot.tokens;
		}
	}
	const visibleCount = slots.length - slots.filter(
		(s) => messageViewLines(s.message, s.message.id).length === 0,
	).length;
	return {
		slots,
		uncovered,
		coveredTokens,
		uncoveredTokens,
		coveredCount: visibleCount - uncovered.length,
		uncoveredCount: uncovered.length,
	};
}

/** Greedy fill in order; a message is never split, and an over-budget
 *  message becomes its own run. */
export function batchRuns(slots: ReadonlyArray<CoverageSlot>, uncovered: ReadonlyArray<number>, budget: number): CoverageSlot[][] {
	if (budget <= 0 || uncovered.length === 0) return [];
	const runs: CoverageSlot[][] = [];
	let current: CoverageSlot[] = [];
	let currentTokens = 0;
	const flush = () => {
		if (current.length > 0) runs.push(current);
		current = [];
		currentTokens = 0;
	};
	for (const i of uncovered) {
		const slot = slots[i]!;
		if (current.length > 0 && currentTokens + slot.tokens > budget) flush();
		current.push(slot);
		currentTokens += slot.tokens;
	}
	flush();
	return runs;
}

/** Deterministic over member fingerprints: re-running the same batch
 *  reproduces the same observation refs; a changed message changes the tag. */
export function batchTag(batch: ReadonlyArray<CoverageSlot>): string {
	const h = createHash("sha256");
	for (const slot of batch) h.update(slot.fp);
	return h.digest("hex").slice(0, 12);
}
