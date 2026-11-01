import type { CallUsage } from "./chat.ts";
import type { LhMessage, LhMarkerMessage } from "../native-messages.ts";
import { newHandoffMessage } from "../native-messages.ts";

export type JobKind = "research" | "demo" | "visual" | "pdf";
export type JobStatus = "running" | "done" | "error";

export interface JobRecord {
	id: string;
	kind: JobKind;
	chatId: string;
	/** The tool part this job fulfills. */
	toolCallId: string;
	status: JobStatus;
	/** Latest human-readable activity line, e.g. `web_search: "sigma.js v3"`. */
	activity: string;
	createdAt: string;
	updatedAt: string;
	result?: unknown;
	error?: string;
	/** Accumulated token usage. Absent on old jobs and before the first
	 * step completes; absent is not zero. */
	usage?: JobUsage;
}

/** A token field no model call reported stays undefined; absent is not zero. */
export interface JobUsage {
	/** Provider-qualified: "provider:id". */
	model: string;
	/** Running totals summed over the run's model calls so far. */
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	cacheReadTokens: number | undefined;
	cacheWriteTokens: number | undefined;
	reasoningTokens: number | undefined;
	cacheWrite1hTokens?: number;
	/** Absent on older jobs; never backfill from cumulative totals. */
	calls?: CallUsage[];
	steps: number;
	/** The most recent model call's usage. Absent until the first call completes. */
	lastStep?: CallUsage;
}

export interface UsageStepLike {
	inputTokens?: number | undefined;
	inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number; cacheWrite1hTokens?: number } | undefined;
	outputTokens?: number | undefined;
	outputTokenDetails?: { reasoningTokens?: number } | undefined;
}

export function piUsageToStep(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
}): UsageStepLike {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		inputTokenDetails: { cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite, cacheWrite1hTokens: usage.cacheWrite1h ?? 0 },
		outputTokenDetails: usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : undefined,
	};
}

/** A field neither the total nor the step reported stays undefined; once
 * reported, later unreported calls contribute 0. `steps` counts every call. */
export function accumulateJobUsage(
	total: JobUsage | undefined,
	model: string,
	step: UsageStepLike,
): JobUsage {
	const add = (a: number | undefined, b: number | undefined): number | undefined =>
		a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
	const call: CallUsage = {
		inputTokens: step.inputTokens,
		outputTokens: step.outputTokens,
		cacheReadTokens: step.inputTokenDetails?.cacheReadTokens,
		cacheWriteTokens: step.inputTokenDetails?.cacheWriteTokens,
		cacheWrite1hTokens: step.inputTokenDetails?.cacheWrite1hTokens,
		reasoningTokens: step.outputTokenDetails?.reasoningTokens,
	};
	return {
		model,
		inputTokens: add(total?.inputTokens, step.inputTokens),
		outputTokens: add(total?.outputTokens, step.outputTokens),
		cacheReadTokens: add(total?.cacheReadTokens, step.inputTokenDetails?.cacheReadTokens),
		cacheWriteTokens: add(total?.cacheWriteTokens, step.inputTokenDetails?.cacheWriteTokens),
		reasoningTokens: add(total?.reasoningTokens, step.outputTokenDetails?.reasoningTokens),
		cacheWrite1hTokens: ((total?.cacheWriteTokens ?? 0) > 0 && total?.cacheWrite1hTokens === undefined) ||
			((call.cacheWriteTokens ?? 0) > 0 && call.cacheWrite1hTokens === undefined)
			? undefined : add(total?.cacheWrite1hTokens, call.cacheWrite1hTokens),
		steps: (total?.steps ?? 0) + 1,
		...(!total || total.calls ? { calls: [...(total?.calls ?? []), call] } : {}),
		lastStep: call,
	};
}

export interface ResearchToolInput {
	question: string;
	context?: string;
}

export interface ResearchResult {
	brief: string;
	sources: { title: string; url: string }[];
}

export interface DemoToolInput {
	title: string;
	brief: string;
}

export interface DemoResult {
	title: string;
	/** Self-contained single-file HTML/JS document. */
	html: string;
	tested: true;
	notes?: string;
}

export interface VisualToolInput {
	brief: string;
}

export interface VisualResult {
	svg: string;
	notes?: string;
}

export interface PdfToolInput {
	path: string;
	question: string;
}

export interface PdfResult {
	path: string;
	question: string;
	/** Failure shape: /^PDF failed:/i. */
	brief: string;
	/** Pages whose extract or render output entered the loop; search-hit
	 *  snippets excluded. */
	pagesRead: number[];
	/** Every page whose content entered the loop, search hits included. */
	pagesConsulted: number[];
}

export interface SubagentResultMeta {
	jobId: string;
	kind: JobKind;
	toolCallId: string;
	/** Present only on an abort steer. */
	aborted?: true;
}

export interface SubagentArtifactData {
	kind: JobKind;
	result: ResearchResult | DemoResult | VisualResult | PdfResult;
	ui?: { inverted?: boolean };
}

export interface SteerDetails extends SubagentResultMeta {
	result: ResearchResult | DemoResult | VisualResult | PdfResult;
	/** View preference only; never enters the model context or exports. */
	ui?: { inverted?: boolean };
}

/** Returns a new array; the message is unchanged when it is not a demo or
 *  visual steer. */
export function setSteerUiInverted(
	messages: readonly LhMessage[],
	messageId: string,
	inverted: boolean,
): LhMessage[] {
	return messages.map((m) => {
		if (m.id !== messageId) return m;
		const d = (m as LhMarkerMessage).details as Partial<SteerDetails> | undefined;
		if (!d || (d.kind !== "demo" && d.kind !== "visual")) return m;
		return { ...m, details: { ...d, ui: { ...d.ui, inverted } } } as LhMessage;
	});
}

export type SteerMessage = LhMarkerMessage;

export function isSubagentFailure(
	kind: JobKind,
	result: ResearchResult | DemoResult | VisualResult | PdfResult,
): boolean {
	if (kind === "research") {
		const r = result as ResearchResult;
		return r.sources.length === 0 && /^Research failed:/i.test(r.brief);
	}
	if (kind === "demo") {
		const r = result as DemoResult;
		return typeof r.html !== "string" || r.html.length === 0;
	}
	if (kind === "pdf") {
		const r = result as PdfResult;
		return /^PDF failed:/i.test(r.brief);
	}
	const r = result as VisualResult;
	return typeof r.svg !== "string" || r.svg.length === 0;
}

function steerText(kind: JobKind, result: ResearchResult | DemoResult | VisualResult | PdfResult): string {
	if (isSubagentFailure(kind, result)) {
		if (kind === "research")
			return `${(result as ResearchResult).brief}\n\nContinue with what you can establish and flag the uncertainty to the learner.`;
		if (kind === "demo")
			return `The demo "${(result as DemoResult).title}" could not be built: ${
				(result as DemoResult).notes ?? "unknown reason"
			}. Fall back to explaining in prose; if the brief was the problem, re-call demo with a tighter one.`;
		if (kind === "pdf")
			return `${(result as PdfResult).brief}\n\nContinue with what you can establish from the session and flag the gap to the learner.`;
		return `The figure could not be made: ${(result as VisualResult).notes ?? "unknown reason"}. Fall back to prose or mermaid, or re-call visual with a tighter brief.`;
	}
	if (kind === "research")
		return `Research complete — the researcher's full brief follows. Weave it into the lesson and cite its sources when you use its findings:\n\n${(result as ResearchResult).brief}`;
	if (kind === "pdf")
		return `PDF reading complete — the reader's brief on "${(result as PdfResult).path}" follows, with page citations. Weave it into the lesson and cite pages when you use it:\n\n${(result as PdfResult).brief}`;
	if (kind === "demo")
		return `The demo "${(result as DemoResult).title}" is built, headlessly tested, and rendered in the lesson. Builder notes: ${
			(result as DemoResult).notes ?? "(none)"
		}.\nTeach with it — reference its controls by name and point the learner at what to try.`;
	return `The figure is drawn, verified by inspection, and rendered in the lesson. Maker notes: ${
		(result as VisualResult).notes ?? "(none)"
	}.\nReference its elements as you teach.`;
}

/** The id `steer_<jobId>` is the idempotency key for delivery. */
export function buildSubagentSteer(
	job: Pick<JobRecord, "id" | "kind" | "toolCallId">,
	result: ResearchResult | DemoResult | VisualResult | PdfResult,
): SteerMessage {
	return {
		id: `steer_${job.id}`,
		role: "custom",
		customType: "subagent-steer",
		content: steerText(job.kind, result),
		display: true,
		details: {
			jobId: job.id,
			kind: job.kind,
			toolCallId: job.toolCallId,
			result,
		},
		timestamp: Date.now(),
	};
}

/** Shares the result steer's id, so exactly one of the two delivers. */
export function buildAbortSteer(
	job: Pick<JobRecord, "id" | "kind" | "toolCallId">,
): SteerMessage {
	const meta = { jobId: job.id, kind: job.kind, toolCallId: job.toolCallId, aborted: true } as const;
	return {
		id: `steer_${job.id}`,
		role: "custom",
		customType: "subagent-abort",
		content: abortText(job.kind),
		display: true,
		details: meta,
		timestamp: Date.now(),
	};
}

function abortText(kind: JobKind): string {
	if (kind === "research")
		return "Research aborted — the learner aborted the research job, so no brief is coming. Acknowledge it in one line and continue teaching without it (or offer to re-dispatch it).";
	if (kind === "demo")
		return "The demo job was aborted by the learner — no demo is coming. Acknowledge it in one line and teach the topic in prose instead (a re-dispatch is fine if the learner wants it).";
	if (kind === "pdf")
		return "The PDF reading job was aborted by the learner — no brief is coming. Acknowledge it in one line and continue without it (a re-dispatch is fine if the learner wants it).";
	return "The figure job was aborted by the learner — no figure is coming. Acknowledge it in one line and teach without it (a re-dispatch is fine if the learner wants it).";
}

export function buildProbeHandoffSteer(chatId: string): SteerMessage {
	return newHandoffMessage(chatId);
}

export function steerDelivered(messages: LhMessage[], steerId: string): boolean {
	return messages.some((m) => m.id === steerId);
}

