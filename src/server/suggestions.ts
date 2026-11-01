import type { Usage } from "@earendil-works/pi-ai";
import type { CallUsage, GraphNode, SuggestionsResponse } from "../core/contracts.ts";
import { callTokens, type UsagePart } from "../core/activity.ts";
import {
	SUGGESTIONS_SYSTEM_PROMPT,
	buildSuggestionsPrompt,
	newestPropositions,
	parseSuggestions,
	suggestionsStale,
	type SuggestionsCache,
} from "../core/suggestions.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";
import { withBgLlmSlot } from "../agent/subagents/bg-llm-semaphore.ts";
import { callUsage } from "../agent/subagents/extraction.ts";
import { connectionBackgroundAllowed } from "../agent/subscription-connections.ts";
import { suggestionsStore } from "../store/suggestions.ts";
import { providerKeyPresent } from "./keys.ts";
import { turnCost } from "./pricing.ts";
import { effectiveSettings, stores } from "./stores.ts";

export interface SuggestionGenerator {
	model: string;
	run(system: string, prompt: string, onStep: (step: CallUsage) => void): Promise<string>;
}

export interface SuggestionServiceDeps {
	readNodes(): GraphNode[];
	readCache(): SuggestionsCache | null;
	writeCache(cache: SuggestionsCache): void;
	generator(): SuggestionGenerator | null;
	now?(): Date;
	cooldownMs?: number;
}

const FAILURE_COOLDOWN_MS = 10 * 60_000;

export interface SuggestionService {
	get(): SuggestionsResponse;
	pending(): Promise<void> | null;
}

export function createSuggestionService(deps: SuggestionServiceDeps): SuggestionService {
	const now = () => deps.now?.() ?? new Date();
	let inFlight: Promise<void> | null = null;
	let lastFailureAt = Number.NEGATIVE_INFINITY;

	async function generate(gen: SuggestionGenerator, nodes: GraphNode[]): Promise<void> {
		const steps: CallUsage[] = [];
		let suggestions: SuggestionsCache["suggestions"] = [];
		try {
			const text = await gen.run(SUGGESTIONS_SYSTEM_PROMPT, buildSuggestionsPrompt(newestPropositions(nodes)), (s) => steps.push(s));
			suggestions = parseSuggestions(text);
		} catch (err) {
			console.info(`[suggestions] generation failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		const ok = suggestions.length > 0;
		if (!ok) lastFailureAt = now().getTime();
		const current = deps.readCache();
		const at = now().toISOString();
		const runs = [...(current?.runs ?? []), ...(steps.length > 0 ? [{ at, model: gen.model, steps, ok }] : [])];
		if (!ok && steps.length === 0) return;
		deps.writeCache({
			version: 1,
			generatedAt: ok ? at : (current?.generatedAt ?? null),
			suggestions: ok ? suggestions : (current?.suggestions ?? []),
			runs,
		});
	}

	return {
		get() {
			const cache = deps.readCache();
			const t = now();
			if (
				!inFlight &&
				t.getTime() - lastFailureAt >= (deps.cooldownMs ?? FAILURE_COOLDOWN_MS)
			) {
				const nodes = deps.readNodes();
				if (suggestionsStale(cache, nodes, t)) {
					const gen = deps.generator();
					if (gen) {
						inFlight = generate(gen, nodes)
							.catch((err) => console.error("[suggestions] cache write failed:", err))
							.finally(() => {
								inFlight = null;
							});
					}
				}
			}
			return { suggestions: cache?.suggestions ?? [], generatedAt: cache?.generatedAt ?? null };
		},
		pending: () => inFlight,
	};
}

function cheapGenerator(): SuggestionGenerator | null {
	if (process.env.NODE_ENV === "test") return null;
	const cheap = effectiveSettings().models.cheap;
	if (!cheap) return null;
	if (!providerKeyPresent(cheap.provider) || !connectionBackgroundAllowed(cheap.provider)) return null;
	let engine: ReturnType<typeof piEngineForSpec>;
	try {
		engine = piEngineForSpec(cheap, true);
	} catch {
		return null; // the catalog lost the model — honest skip
	}
	return {
		model: `${engine.model.provider}:${engine.model.id}`,
		run: (system, prompt, onStep) =>
			withBgLlmSlot(undefined, async () => {
				const { text } = await runSubagent([], {
					role: "researcher",
					engine,
					systemPrompt: system,
					prompt,
					maxTurns: 1,
					onUsage: (u: Usage) => onStep(callUsage(u)),
				});
				return text;
			}),
	};
}

/** The process's one service (globalThis — one in-flight guard across
 *  Next's per-route module instances). */
export function suggestionService(): SuggestionService {
	const g = globalThis as typeof globalThis & { __lhSuggestions?: SuggestionService };
	return (g.__lhSuggestions ??= createSuggestionService({
		readNodes: () => stores.graphStore.readNodes(),
		readCache: suggestionsStore.readCache,
		writeCache: suggestionsStore.writeCache,
		generator: cheapGenerator,
	}));
}

export function suggestionUsageParts(cache: SuggestionsCache | null = suggestionsStore.readCache()): UsagePart[] {
	return (cache?.runs ?? []).map((run) => ({
		at: run.at,
		tokens: run.steps.reduce((sum, s) => sum + callTokens(s), 0),
		dollars: turnCost({ id: "", messageId: "", at: run.at, model: run.model, steps: run.steps }),
	}));
}
