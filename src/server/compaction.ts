import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
	activeCompactionOf,
	buildCompactionPrompt,
	compactionCutIndex,
	COMPACTION_RESERVE_TOKENS,
	estimateContextTokens,
	estimateTokens,
	newCompactionMarker,
	planTreeToText,
	serializeForSummary,
	toLlmMessages,
	type CompactionDetails,
	type LhMessage,
	type LhMarkerMessage,
} from "../core/index.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { PiEngine } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";

const SUMMARIZER_SYSTEM_PROMPT =
	"You are the session-compaction summarizer for a tutoring agent. You receive the transcript span to summarize and write exactly the summary the instructions demand — nothing else, no preamble, no meta-commentary.";

export type Summarizer = (prompt: string, engine: PiEngine) => Promise<{ summary: string; usage: Usage }>;

async function subagentSummarizer(prompt: string, engine: PiEngine): Promise<{ summary: string; usage: Usage }> {
	let usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const { text } = await runSubagent([], {
		role: "researcher" as never,
		prompt,
		engine,
		systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
		maxTurns: 1,
		onUsage: (u) => {
			usage = u;
		},
	});
	return { summary: text, usage };
}

export interface CompactionDeps {
	canStart?: () => boolean;
	chatStore: ChatStore;
	engine: PiEngine;
	modelId: string;
	kind: "teach" | "practice" | "probe";
	thresholdTokens: number;
	systemPromptTokens: number;
	summarize?: Summarizer;
}

interface CompactionState {
	inFlight: Map<string, Promise<void>>;
}
const g = globalThis as typeof globalThis & { __lhCompaction?: CompactionState };
function state(): CompactionState {
	return (g.__lhCompaction ??= { inFlight: new Map() });
}

export function compactionInFlight(chatId: string): boolean {
	return state().inFlight.has(chatId);
}

export async function awaitCompaction(chatId: string): Promise<void> {
	const running = state().inFlight.get(chatId);
	if (running) await running;
}

export function effectiveThresholdTokens(settingTokens: number | undefined, contextWindowTokens: number | undefined): number {
	const setting = settingTokens ?? 150_000;
	if (contextWindowTokens === undefined) return setting;
	return Math.min(setting, Math.max(contextWindowTokens - COMPACTION_RESERVE_TOKENS, 1));
}

export function projectedContextTokens(messages: readonly LhMessage[], systemPromptTokens: number): number {
	const est = estimateContextTokens(messages);
	if (est.lastUsageIndex !== null) return est.tokens;
	return estimateTokens(toLlmMessages(messages as readonly AgentMessage[]) as unknown as readonly LhMessage[]) + systemPromptTokens;
}

async function compact(deps: CompactionDeps, chatId: string): Promise<void> {
	const record = deps.chatStore.getChat(chatId);
	if (!record) return;
	const messages = record.messages;
	const tokensBefore = projectedContextTokens(messages, deps.systemPromptTokens);
	if (tokensBefore <= deps.thresholdTokens) return;

	const cut = compactionCutIndex(messages);
	if (cut <= 0 || cut >= messages.length) return;

	const previous = activeCompactionOf(messages);
	const prevKept = previous ? messages.findIndex((m) => m.id === previous.details.firstKeptMessageId) : -1;
	if (previous && prevKept !== -1 && cut <= prevKept) {
		console.info(
			`[chat ${chatId}] compaction skipped — the kept tail alone exceeds the threshold (raise it or shrink the tail)`,
		);
		return;
	}

	let spanStart = 0;
	let priorSummary: string | null = null;
	if (previous && prevKept > 0) {
		spanStart = prevKept;
		priorSummary = previous.content;
	}
	const spanText = serializeForSummary(messages.slice(spanStart, cut));
	const fullSpan = priorSummary ? `[SYSTEM NOTE — prior compaction summary, still authoritative where not superseded]\n${priorSummary}\n\n${spanText}` : spanText;

	const prompt = buildCompactionPrompt({
		spanText: fullSpan,
		planTreeText: planTreeToText(record.tree, messages),
		kind: deps.kind,
	});

	emit("compaction-changed", { chatId, running: true });
	try {
		const summarize = deps.summarize ?? subagentSummarizer;
		const { summary, usage } = await summarize(prompt, deps.engine);
		const trimmed = summary.trim();
		if (!trimmed) return;

		const firstKept = messages[cut]!;
		const details: CompactionDetails = {
			firstKeptMessageId: firstKept.id,
			tokensBefore,
			model: deps.modelId,
			at: new Date().toISOString(),
		};
		const marker = newCompactionMarker(trimmed, details);
		deps.chatStore.saveMessages(chatId, [...messages, marker]);
		deps.chatStore.appendTurnUsage(chatId, {
			id: crypto.randomUUID(),
			messageId: marker.id,
			at: details.at,
			model: deps.modelId,
			steps: [
				{
					inputTokens: usage.input,
					outputTokens: usage.output,
					cacheReadTokens: usage.cacheRead,
					cacheWriteTokens: usage.cacheWrite,
					cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
					reasoningTokens: usage.reasoning ?? 0,
				},
			],
		});
		emit("record-changed", { chatId });
	} catch (err) {
		console.error(`[chat ${chatId}] compaction failed:`, err);
	} finally {
		emit("compaction-changed", { chatId, running: false });
	}
}

export async function ensureCompacted(deps: CompactionDeps, chatId: string): Promise<void> {
	if (process.env.NODE_ENV === "test" && !deps.summarize) return;
	await awaitCompaction(chatId);
	if (deps.canStart?.() === false) return;
	const record = deps.chatStore.getChat(chatId);
	if (!record) return;
	if (projectedContextTokens(record.messages, deps.systemPromptTokens) <= deps.thresholdTokens) return;
	if (state().inFlight.has(chatId)) return;
	const run = compact(deps, chatId);
	state().inFlight.set(chatId, run);
	try {
		await run;
	} finally {
		state().inFlight.delete(chatId);
	}
}

export function kickCompaction(buildDeps: () => CompactionDeps | null, chatId: string): void {
	if (state().inFlight.has(chatId)) return;
	const deps = buildDeps();
	if (!deps || deps.canStart?.() === false) return;
	const record = deps.chatStore.getChat(chatId);
	if (!record) return;
	if (projectedContextTokens(record.messages, deps.systemPromptTokens) <= deps.thresholdTokens) return;
	const run = compact(deps, chatId);
	state().inFlight.set(chatId, run);
	void run.finally(() => state().inFlight.delete(chatId));
}
