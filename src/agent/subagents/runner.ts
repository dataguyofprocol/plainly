import type { PiEngine } from "../models.ts";
import type { SearchProvider } from "../../core/search.ts";
import {
	accumulateJobUsage,
	buildSubagentSteer,
	piUsageToStep,
	type DemoResult,
	type DemoToolInput,
	type JobKind,
	type JobRecord,
	type JobUsage,
	type PdfResult,
	type PdfToolInput,
	type ResearchResult,
	type ResearchToolInput,
	type SteerMessage,
	type UsageStepLike,
	type VisualResult,
	type VisualToolInput,
} from "../../core/contracts.ts";
import { registerJobAbort, unregisterJobAbort } from "./aborts.ts";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRole } from "../../../config.ts";
import { ROLE_SLOT, modelsNotConfigured, type ModelSlotName, type ProviderKeyMissing } from "../../core/settings.ts";
import type { ChatStore, JobStore } from "../../core/ports.ts";
import { runDemoBuilder } from "./demo-builder.ts";
import { runPdfReaderAgent } from "./pdf-reader.ts";
import { runResearcherAgent } from "./researcher.ts";
import { runVisualMaker } from "./visual-maker.ts";

export const researchModelOverride: { current?: PiEngine } = {};
export const demoModelOverride: { current?: PiEngine } = {};
export const visualModelOverride: { current?: PiEngine } = {};
export const pdfModelOverride: { current?: PiEngine } = {};

type JobToolInput = ResearchToolInput | DemoToolInput | VisualToolInput | PdfToolInput;

export interface JobRunnerDeps {
	chatStore: ChatStore;
	jobStore: JobStore;
	/**
	 * Hand a finished job's steer to the wake pipeline — resolves when the
	 * steer is delivered (the wake turn completed and the job status
	 * flipped); rejects when delivery fails unrecoverably.
	 */
	deliver: (steer: SteerMessage) => Promise<void>;
	engineFor?: (role: ModelRole) => PiEngine | undefined;
	searchProvider?: () => SearchProvider | null;
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
}

export interface JobRunner {
	/** Run one job's sub-agent loop to completion (background; never throws).
	 *  The tool input rides along from dispatch (the spawn fires mid-stream,
	 *  before the tool part is persisted — only crash-recovery re-spawns
	 *  resolve the input from the transcript). */
	runJob(jobId: string, input?: JobToolInput): Promise<void>;
}

interface LoopContext {
	abortSignal: AbortSignal;
	chatId?: string;
	onUsage: (step: UsageStepLike) => void;
}

const KIND_ROLE: Record<JobKind, ModelRole> = {
	research: "researcher",
	demo: "demoBuilder",
	visual: "visualMaker",
	pdf: "pdfReader",
};

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
	const { chatStore, jobStore, deliver } = deps;

	const usageTotals = new Map<string, JobUsage>();

	function makeLoopContext(jobId: string, engine: PiEngine): LoopContext {
		const chatId = jobStore.getJob(jobId)?.chatId;
		const model = `${engine.model.provider}:${engine.model.id}`;
		const controller = new AbortController();
		registerJobAbort(jobId, controller);
		return {
			abortSignal: controller.signal,
			chatId,
			onUsage: (step) => {
				const next = accumulateJobUsage(usageTotals.get(jobId), model, step);
				usageTotals.set(jobId, next);
				jobStore.updateJob(jobId, { usage: next }); // merge patch — status untouched
			},
		};
	}

	function stillRunning(jobId: string): boolean {
		return jobStore.getJob(jobId)?.status === "running";
	}

	function pickEngine(kind: JobKind): PiEngine | undefined {
		const testOverride: Record<string, { current?: PiEngine } | undefined> = {
			researcher: researchModelOverride,
			demoBuilder: demoModelOverride,
			visualMaker: visualModelOverride,
			pdfReader: pdfModelOverride,
		};
		return testOverride[KIND_ROLE[kind]]?.current ?? deps.engineFor?.(KIND_ROLE[kind]);
	}

	const KIND_RUNNERS: Record<
		JobKind,
		(jobId: string, engine: PiEngine, input: JobToolInput | undefined, loop: LoopContext) => Promise<void>
	> = {
		research: (jobId, engine, input, loop) => runResearchJob(jobId, engine, input, loop),
		demo: (jobId, engine, input, loop) => runDemoJob(jobId, engine, input, loop),
		visual: (jobId, engine, input, loop) => runVisualJob(jobId, engine, input, loop),
		pdf: (jobId, engine, input, loop) => runPdfJob(jobId, engine, input, loop),
	};

	async function runJob(jobId: string, input?: JobToolInput): Promise<void> {
		const job = jobStore.getJob(jobId);
		if (!job) {
			console.error(`[job ${jobId}] not found — nothing to run`);
			return;
		}
		if (job.status !== "running") return;
		const run = KIND_RUNNERS[job.kind];
		if (!run) {
			console.error(`[job ${jobId}] unknown kind: ${job.kind}`);
			jobStore.updateJob(jobId, { status: "error", error: `unknown kind ${job.kind}`, activity: "failed" });
			return;
		}
		const engine = pickEngine(job.kind);
		const refuse = async (reason: string): Promise<void> => {
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			const resolved = resolveInput(job, input) as
				| ResearchToolInput
				| DemoToolInput
				| VisualToolInput
				| PdfToolInput
				| undefined;
			const pdf = resolved as PdfToolInput | undefined;
			const failure: ResearchResult | DemoResult | VisualResult | PdfResult =
				job.kind === "research"
					? { brief: `Research failed: ${reason}`, sources: [] }
					: job.kind === "demo"
						? {
								title: typeof (resolved as DemoToolInput | undefined)?.title === "string" && (resolved as DemoToolInput).title.trim() ? (resolved as DemoToolInput).title : "Interactive demo",
								html: "",
								tested: true,
								notes: `FAILED: ${reason}`,
							}
						: job.kind === "visual"
							? { svg: "", notes: `FAILED: ${reason}` }
							: {
									path: typeof pdf?.path === "string" ? pdf.path : "",
									question: typeof pdf?.question === "string" ? pdf.question : "",
									brief: `PDF failed: ${reason}`,
									pagesRead: [],
									pagesConsulted: [],
								};
			await finishJob(jobId, failure);
		};
		if (!engine) {
			const tier = ROLE_SLOT[KIND_ROLE[job.kind]];
			const envelope = modelsNotConfigured([tier]);
			console.info(`[job ${jobId}] refused — ${JSON.stringify(envelope)}`);
			await refuse(`${envelope.error} (missing: ${tier})`);
			return;
		}
		const keyRefusal =
			deps.providerKeyMissing?.(engine.model.provider, ROLE_SLOT[KIND_ROLE[job.kind]]) ?? null;
		if (keyRefusal) {
			console.info(`[job ${jobId}] refused — ${JSON.stringify(keyRefusal)}`);
			await refuse(keyRefusal.error);
			return;
		}
		try {
			await run(jobId, engine, input, makeLoopContext(jobId, engine));
		} finally {
			unregisterJobAbort(jobId);
			const usage = usageTotals.get(jobId);
			if (usage) jobStore.updateJob(jobId, { usage });
			usageTotals.delete(jobId);
		}
	}

	function resolveInput(
		job: JobRecord,
		input: JobToolInput | undefined,
	): JobToolInput | undefined {
		if (input) return input;
		const chat = chatStore.getChat(job.chatId);
		if (!chat) return undefined;
		for (const m of chat.messages) {
			if ((m as { role?: string }).role !== "assistant") continue;
			const content = (m as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			for (const block of content as Array<{ type?: string; id?: string; arguments?: unknown }>) {
				if (block.type !== "toolCall" || block.id !== job.toolCallId) continue;
				return block.arguments as JobToolInput | undefined;
			}
		}
		return undefined;
	}

	async function finishJob(jobId: string, result: ResearchResult | DemoResult | VisualResult | PdfResult): Promise<void> {
		const job = jobStore.getJob(jobId);
		if (!job) return;
		if (job.status !== "running") return;
		jobStore.updateJob(jobId, { result, activity: "delivering result" });
		const steer = buildSubagentSteer(job, result);
		try {
			await deliver(steer);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(`[job ${jobId}] steer delivery failed:`, err);
			jobStore.updateJob(jobId, { status: "error", error: reason, activity: "delivery failed" });
		}
	}

	function jobContext(jobId: string): { job: JobRecord; chatId: string } | null {
		const job = jobStore.getJob(jobId);
		if (!job || job.status !== "running") return null;
		const chat = chatStore.getChat(job.chatId);
		if (!chat) {
			jobStore.updateJob(jobId, { status: "error", error: `Chat not found: ${job.chatId}`, activity: "failed" });
			return null;
		}
		return { job, chatId: job.chatId };
	}

	async function runResearchJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? resolveInput(job, passedInput)) as ResearchToolInput | undefined;
		const question = typeof input?.question === "string" && input.question.trim() ? input.question : "(no question)";
		const context = typeof input?.context === "string" && input.context.trim() ? input.context : undefined;

		const prompt = [
			`Research question: ${question}`,
			context ? `Context (what this is needed for): ${context}` : null,
			"Produce your final brief in the required format.",
		]
			.filter(Boolean)
			.join("\n\n");

		const fetchedUrls: string[] = [];
		const pdfDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-research-"));

		try {
			jobStore.updateJob(jobId, { activity: "researching" });
			const brief = await runResearcherAgent(prompt, {
				engine: model,
				search: deps.searchProvider,
				pdfDir,
				abortSignal: loop.abortSignal,
				chatId: loop.chatId,
				onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
					onToolStart: (toolName, args) => {
					const input = args as { query?: string; url?: string } | undefined;
					if (typeof input?.url === "string" && (toolName === "web_fetch" || toolName === "web_fetch_pdf")) {
						fetchedUrls.push(input.url);
					}
					jobStore.updateJob(jobId, { activity: activityLine(toolName, input) });
				},
			});
			if (!brief.trim()) throw new Error("the researcher produced no text");
			const research: ResearchResult = { brief: brief.trim(), sources: parseSources(brief.trim(), fetchedUrls) };
			await finishJob(jobId, research);
		} catch (err) {
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			await finishJob(jobId, { brief: `Research failed: ${reason}`, sources: [] });
		} finally {
			await fs.rm(pdfDir, { recursive: true, force: true });
		}
	}

	async function runDemoJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? resolveInput(job, passedInput)) as DemoToolInput | undefined;
		const title = typeof input?.title === "string" && input.title.trim() ? input.title : "Interactive demo";
		const brief = typeof input?.brief === "string" ? input.brief : "";

		try {
			jobStore.updateJob(jobId, { activity: "building demo" });
			const result = await runDemoBuilder(
				{ title, brief },
				{
					engine: model,
					abortSignal: loop.abortSignal,
					chatId: loop.chatId,
					onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
					onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
				},
			);
			if (isDemoFailure(result) && stillRunning(jobId))
				jobStore.updateJob(jobId, { error: result.notes ?? "demo build failed" });
			await finishJob(jobId, result);
		} catch (err) {
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			await finishJob(jobId, { title, html: "", tested: true, notes: `FAILED: ${reason}` });
		}
	}

	async function runVisualJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? resolveInput(job, passedInput)) as VisualToolInput | undefined;
		const brief = typeof input?.brief === "string" ? input.brief : "";

		try {
			jobStore.updateJob(jobId, { activity: "drawing figure" });
			const result = await runVisualMaker(
				{ brief },
				{
					engine: model,
					abortSignal: loop.abortSignal,
					chatId: loop.chatId,
					onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
					onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
				},
			);
			if (isVisualFailure(result) && stillRunning(jobId))
				jobStore.updateJob(jobId, { error: result.notes ?? "visual build failed" });
			await finishJob(jobId, result);
		} catch (err) {
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			await finishJob(jobId, { svg: "", notes: `FAILED: ${reason}` });
		}
	}

	async function runPdfJob(
		jobId: string,
		model: PiEngine | undefined,
		passedInput: JobToolInput | undefined,
		loop: LoopContext,
	): Promise<void> {
		const ctx = jobContext(jobId);
		if (!ctx) return;
		const { job } = ctx;

		const input = (passedInput ?? resolveInput(job, passedInput)) as PdfToolInput | undefined;
		const path = typeof input?.path === "string" && input.path.trim() ? input.path.trim() : "";
		const question = typeof input?.question === "string" ? input.question : "";

		try {
			jobStore.updateJob(jobId, { activity: "reading pdf" });
			const result = await runPdfReaderAgent(
				{ path, question },
			{
				engine: model,
				abortSignal: loop.abortSignal,
				chatId: loop.chatId,
				onUsage: (usage) => loop.onUsage(piUsageToStep(usage)),
				onActivity: (line) => jobStore.updateJob(jobId, { activity: line }),
			},
			);
			if (isPdfFailure(result) && stillRunning(jobId))
				jobStore.updateJob(jobId, { error: result.brief.replace(/^PDF failed:\s*/i, "") });
			await finishJob(jobId, result);
		} catch (err) {
			if (loop.abortSignal.aborted) return;
			const reason = err instanceof Error ? err.message : String(err);
			if (stillRunning(jobId)) jobStore.updateJob(jobId, { error: reason });
			await finishJob(jobId, { path, question, brief: `PDF failed: ${reason}`, pagesRead: [], pagesConsulted: [] });
		}
	}

	return { runJob };
}

function isDemoFailure(result: DemoResult): boolean {
	return typeof result.html !== "string" || result.html.length === 0;
}

function isVisualFailure(result: VisualResult): boolean {
	return typeof result.svg !== "string" || result.svg.length === 0;
}

function isPdfFailure(result: PdfResult): boolean {
	return /^PDF failed:/i.test(result.brief);
}

function activityLine(toolName: string, input: { query?: string; url?: string } | undefined): string {
	if (toolName === "web_search") return `web_search: "${input?.query ?? ""}"`;
	if (toolName === "web_fetch") return `web_fetch: ${hostOf(input?.url)}`;
	return toolName;
}

function hostOf(url: string | undefined): string {
	if (!url) return "(no url)";
	try {
		return new URL(url).hostname;
	} catch {
		return url.slice(0, 40);
	}
}

function parseSources(brief: string, fetchedUrls: string[]): ResearchResult["sources"] {
	const sources: ResearchResult["sources"] = [];
	const seen = new Set<string>();
	for (const match of brief.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
		const title = (match[1] ?? "").trim();
		const url = match[2]!;
		if (!title || seen.has(url)) continue;
		seen.add(url);
		sources.push({ title, url });
	}
	if (sources.length === 0) {
		for (const url of fetchedUrls) {
			if (seen.has(url)) continue;
			seen.add(url);
			sources.push({ title: hostOf(url), url });
		}
	}
	return sources.slice(0, 10);
}
