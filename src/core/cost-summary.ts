import type { CallUsage, EmissionStats, ExtractionRunUsage } from "./contracts.ts";
import { sumSteps, isSubscriptionModel, subscriptionLabels, type CallPricer } from "./prices.ts";

export interface StageCost {
	/** Excluded from dollars and unpricedRuns. */
	subscriptionRuns?: number;
	subscriptionProviders?: string[];
	/** USD over priced runs only; partial when unpricedRuns > 0. */
	dollars: number;
	/** Runs whose model has no price; render "—", never zero. */
	unpricedRuns: number;
	runs: number;
	tokens: CallUsage;
}

export interface RecentRun {
	subscriptionRuns?: number;
	subscriptionProviders?: string[];
	startedAt: number;
	at: string;
	durationMs: number;
	kind: "extraction";
	/** Chat title or source file path. */
	title: string;
	/** Null only when every stage is unpriced. */
	dollars: number | null;
	tokens: CallUsage;
	/** Absent on failed runs. */
	merged?: EmissionStats;
}

export interface GraphCostSummary {
	subscriptionRuns?: number;
	subscriptionProviders?: string[];
	totalDollars: number;
	/** Runs with no priced API stage and at least one unknown stage. */
	unpricedRuns: number;
	stages: {
		extraction: StageCost;
		audit: StageCost;
	};
	/** Newest first, capped at `recentCap` (default 10). */
	runs: RecentRun[];
}

export interface CostSummaryInput {
	chats: { title: string; extractions: ExtractionRunUsage[] }[];
	sources: { filePath: string; extractions: ExtractionRunUsage[] }[];
	recentCap?: number;
}

const ZERO_TOKENS: CallUsage = {
	inputTokens: undefined,
	outputTokens: undefined,
	cacheReadTokens: undefined,
	cacheWriteTokens: undefined,
	reasoningTokens: undefined,
};

const emptyStage = (): StageCost => ({ dollars: 0, unpricedRuns: 0, runs: 0, tokens: { ...ZERO_TOKENS } });

function stageDollars(model: string, steps: readonly CallUsage[], price: CallPricer): number | null {
	if (isSubscriptionModel(model) || steps.length === 0) return null;
	let total = 0;
	for (const step of steps) {
		const c = price(step, model);
		if (c === null) return null;
		total += c;
	}
	return total;
}

function mergeTokens(into: CallUsage, steps: readonly CallUsage[]): void {
	const summed = sumSteps(steps);
	into.cacheWrite1hTokens = sumSteps([into, summed]).cacheWrite1hTokens;
	into.inputTokens = (into.inputTokens ?? 0) + (summed.inputTokens ?? 0);
	into.outputTokens = (into.outputTokens ?? 0) + (summed.outputTokens ?? 0);
	into.cacheReadTokens = (into.cacheReadTokens ?? 0) + (summed.cacheReadTokens ?? 0);
	into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + (summed.cacheWriteTokens ?? 0);
	into.reasoningTokens = (into.reasoningTokens ?? 0) + (summed.reasoningTokens ?? 0);
}

export function graphCostSummary(input: CostSummaryInput, price: CallPricer): GraphCostSummary {
	const extraction = emptyStage();
	const audit = emptyStage();
	const runs: RecentRun[] = [];

	const foldExtractionRun = (run: ExtractionRunUsage, title: string) => {
		const stages = run.stages ?? { extractor: { model: "unknown", steps: [] }, auditor: { model: "unknown", steps: [] } };
		extraction.runs++;
		mergeTokens(extraction.tokens, stages.extractor.steps);
		const extDollars = stageDollars(stages.extractor.model, stages.extractor.steps, price);
		if (isSubscriptionModel(stages.extractor.model)) {
			extraction.subscriptionRuns = (extraction.subscriptionRuns ?? 0) + 1;
			extraction.subscriptionProviders = [...new Set([...(extraction.subscriptionProviders ?? []), ...subscriptionLabels([stages.extractor.model])])];
		}
		else if (extDollars === null) extraction.unpricedRuns++;
		else extraction.dollars += extDollars;

		audit.runs++;
		mergeTokens(audit.tokens, stages.auditor.steps);
		const audDollars = stageDollars(stages.auditor.model, stages.auditor.steps, price);
		if (isSubscriptionModel(stages.auditor.model)) {
			audit.subscriptionRuns = (audit.subscriptionRuns ?? 0) + 1;
			audit.subscriptionProviders = [...new Set([...(audit.subscriptionProviders ?? []), ...subscriptionLabels([stages.auditor.model])])];
		}
		else if (audDollars === null) audit.unpricedRuns++;
		else audit.dollars += audDollars;

		const allStages: Array<number | null> = [extDollars, audDollars];
		const runDollars = allStages.every((d) => d === null)
			? null
			: allStages.reduce<number>((a, d) => a + (d ?? 0), 0);
		const subscriptionRuns = [stages.extractor, stages.auditor].filter((stage) => isSubscriptionModel(stage.model)).length;
		const allSteps = [...stages.extractor.steps, ...stages.auditor.steps];
		runs.push({
			...(subscriptionRuns ? { subscriptionRuns, subscriptionProviders: subscriptionLabels([stages.extractor.model, stages.auditor.model]) } : {}),
			startedAt: run.startedAt,
			at: run.at,
			durationMs: run.durationMs,
			kind: "extraction",
			title,
			dollars: runDollars,
			tokens: sumSteps(allSteps),
			...(run.stats ? { merged: run.stats } : {}),
		});
	};

	for (const chat of input.chats) {
		for (const run of chat.extractions) foldExtractionRun(run, chat.title);
	}
	for (const source of input.sources) {
		for (const run of source.extractions) foldExtractionRun(run, source.filePath);
	}

	runs.sort((a, b) => b.startedAt - a.startedAt);
	const capped = runs.slice(0, input.recentCap ?? 10);

	const unpricedRuns = runs.filter((r) => r.dollars === null && (r.subscriptionRuns ?? 0) < 2).length;
	const subscriptionRuns = (extraction.subscriptionRuns ?? 0) + (audit.subscriptionRuns ?? 0);
	return {
		...(subscriptionRuns ? { subscriptionRuns, subscriptionProviders: [...new Set([...(extraction.subscriptionProviders ?? []), ...(audit.subscriptionProviders ?? [])])] } : {}),
		totalDollars: extraction.dollars + audit.dollars,
		unpricedRuns,
		stages: { extraction, audit },
		runs: capped,
	};
}
