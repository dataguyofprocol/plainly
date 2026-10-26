/**
 * THE SUGGESTIONS SERVICE (v4 redesign, owner-approved 2026-10-26): GET
 * /api/suggestions never blocks — it answers from the disk cache and, when
 * the cache is stale (core/suggestions.ts suggestionsStale), KICKS one
 * background generation on the CHEAP model slot. No cache yet → [] now,
 * suggestions on a later read.
 *
 * The background-call idioms are the extraction pipeline's: the engine
 * resolves FRESH from the settings record (BYOK — no cheap model, no key,
 * or a subscription that refuses background use → no generation, never a
 * guess), the call runs under the shared background-LLM semaphore
 * (bg-llm-semaphore.ts — total background concurrency stays 3), through
 * the zero-tool one-shot sub-agent seam (pi-run.ts — compaction's
 * summarizer precedent). Spend lands in the cache record's append-only
 * `runs` log (success or failure — money was spent either way) and feeds
 * the stats' token channel via suggestionUsageParts.
 *
 * Single-flight per process (globalThis — the compaction registry's
 * pattern) plus a failure cooldown, so a failing provider is not hit on
 * every home render. Tests inject the generator (createSuggestionService);
 * the production service never generates under NODE_ENV=test.
 */

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

/** A ready generator: the model it bills as + the one-shot call. The call
 *  reports each model step through `onStep` (usage survives a throw). */
export interface SuggestionGenerator {
	model: string;
	run(system: string, prompt: string, onStep: (step: CallUsage) => void): Promise<string>;
}

export interface SuggestionServiceDeps {
	readNodes(): GraphNode[];
	readCache(): SuggestionsCache | null;
	writeCache(cache: SuggestionsCache): void;
	/** The generator, resolved FRESH per kick; null = cannot generate now
	 *  (no cheap model, no key, background refused). */
	generator(): SuggestionGenerator | null;
	now?(): Date;
	/** After a failed attempt, no new kick for this long (ms). */
	cooldownMs?: number;
}

const FAILURE_COOLDOWN_MS = 10 * 60_000;

export interface SuggestionService {
	/** The route's answer: the cache as it stands; kicks a background
	 *  generation when stale. Never awaits the model. */
	get(): SuggestionsResponse;
	/** The in-flight generation, if any (tests await it). */
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
		// Read-modify-write against the CURRENT cache: the run log is
		// append-only; a failure keeps the previous suggestions.
		const current = deps.readCache();
		const at = now().toISOString();
		const runs = [...(current?.runs ?? []), ...(steps.length > 0 ? [{ at, model: gen.model, steps, ok }] : [])];
		if (!ok && steps.length === 0) return; // nothing spent, nothing to record
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

// ─── production wiring ──────────────────────────────────────────────────────

/** The production generator: the CHEAP slot, read fresh; null whenever
 *  the call could not honestly run. */
function cheapGenerator(): SuggestionGenerator | null {
	if (process.env.NODE_ENV === "test") return null; // tests never reach a provider
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
					// The engine override is always present; "researcher" is the
					// cheap-tier role label (ROLE_SLOT) — it resolves nothing here.
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

/** The suggestion runs as priced usage parts (the stats' token channel). */
export function suggestionUsageParts(cache: SuggestionsCache | null = suggestionsStore.readCache()): UsagePart[] {
	return (cache?.runs ?? []).map((run) => ({
		at: run.at,
		tokens: run.steps.reduce((sum, s) => sum + callTokens(s), 0),
		dollars: turnCost({ id: "", messageId: "", at: run.at, model: run.model, steps: run.steps }),
	}));
}
