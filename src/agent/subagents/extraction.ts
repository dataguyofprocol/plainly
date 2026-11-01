import * as crypto from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import { toToolResult } from "../tool-execute.ts";
import type { ModelRole } from "../../../config.ts";
import {
	FACTORY_SETTINGS,
	ModelsNotConfiguredError,
	ProviderKeyMissingError,
	ROLE_SLOT,
	type ModelSlotName,
	type ProviderKeyMissing,
} from "../../core/settings.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";
import { withBgLlmSlot } from "./bg-llm-semaphore.ts";
import type {
	AuditVerdicts,
	CallUsage,
	ChatRecord,
	ExtractionRunUsage,
	ExtractionStageUsage,
	SessionFindings,
} from "../../core/contracts.ts";
import { getGraph, mergeFindings, type DerivedGraph, type EmissionStats, type GraphDeps } from "../../core/graph.ts";
import type { GraphStore } from "../../core/ports.ts";
import { emit } from "../../core/events.ts";
import { settleGraphLayout } from "../../core/layout-settle.ts";
import { batchRuns, coverageOf, messageViewLines } from "../../core/coverage.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { auditorGraphTools } from "../tools/graph.ts";
import { runSubmitAgent, healStringifiedArrays } from "./submit-agent.ts";

export function transcriptView(record: ChatRecord): string {
	return proseView(record.messages, record.title);
}

function proseView(messages: ReadonlyArray<LhMessage>, title?: string): string {
	const lines = messages.flatMap((message) => messageViewLines(message, message.id));
	const head = title && title.length > 0 ? `# ${title}\n\n` : "";
	return head + lines.join("\n\n");
}

const propositionProps = {
	id: Type.String({ description: 'Local id: "p1", "p2", … — referenced by chains in this call.' }),
	name: Type.String({
		description:
			"A very short label — established terminology, the term the discipline itself uses, a glossary " +
			"headword a textbook would print ('Will to power', 'Divine command theory'). Not a sentence, " +
			"needn't be unique or self-contained: this becomes the node's global label in the graph.",
	}),
	statement: Type.String({
		description:
			"One true, self-contained, world-facing core idea at full precision. Never about the " +
			'learner, the teacher, or the reading: not "the learner understands X" but "X". A misconception ' +
			"enters as its TRUE correction.",
	}),
	aliases: Type.Optional(
		Type.Array(Type.String(), {
			description: "Verbatim phrasings the source used for the same proposition, if any.",
		}),
	),
};

const endpoint = (role: string) =>
	Type.String({
		description:
			`The id this ${role} — EITHER an existing graph idea id from THE GRAPH SO FAR in the prompt, ` +
			'verbatim ("n_…"), OR the local id of a proposition in this submission ("p1", …).',
	});

const chainSchema = Type.Object({
	premises: Type.Array(endpoint("premise uses"), {
		minItems: 1,
		description:
			"Premise ids used TOGETHER: they jointly entail the conclusion; independent reasons are separate chains.",
	}),
	conclusion: endpoint("conclusion is"),
});

const propositionsDescription =
	"Only the NEW core ideas this stretch contributes — ideas the prompt's THE GRAPH SO FAR already " +
	"holds are referenced by id in chains, never restated here.";
const chainsDescription =
	"Every argument this stretch makes — including arguments that join new ideas to established " +
	"ones; conclusions reusable by id as premises of later chains; bare ideas (no argument) ride " +
	"the propositions list alone; pass [] when none — never omit the field.";

const findingsSchema = Type.Object({
	propositions: Type.Array(Type.Object(propositionProps), {
		description: propositionsDescription,
	}),
	chains: Type.Array(chainSchema, {
		description: chainsDescription,
	}),
});

const sessionPropositionProps = {
	...propositionProps,
	messageId: Type.String({
		description:
			"The message id of the ONE passage in this stretch that most directly states or explains this " +
			'proposition — copy it EXACTLY from that passage\'s "TEACHER [id]" label.',
	}),
};

const sessionFindingsSchema = Type.Object({
	propositions: Type.Array(Type.Object(sessionPropositionProps), {
		description: propositionsDescription,
	}),
	chains: Type.Array(chainSchema, {
		description: chainsDescription,
	}),
});

type FindingsSubmit = Static<typeof findingsSchema>;

type SessionFindingsSubmit = Static<typeof sessionFindingsSchema>;

const auditSchema = Type.Object({
	links: Type.Array(
		Type.Object({
			id: Type.String({ description: 'The proposition id from the findings ("p1", …).' }),
			linkTo: Type.String({
				description:
					"The id of the EXISTING graph node this proposition IS — your identity verdict. EQUIVALENCE BIAS (2026-09-27): paraphrases, rewordings, and compressions of the same claim MERGE; only genuinely distinct propositions stay apart.",
			}),
		}),
		{ description: "Identity verdicts — which findings propositions ARE existing graph nodes. A proposition absent from here = create a new node. Pass [] when none — never omit the field." },
	),
});

type NotesFindings = SessionFindings;
type NotesAuditResult = AuditVerdicts;

function fillFindings<T extends { propositions: Array<{ aliases?: string[] }>; chains: unknown }>(
	raw: T,
): T {
	return {
		...raw,
		propositions: raw.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] })),
	};
}

function fillNotesFindings(raw: FindingsSubmit): FindingsSubmit {
	return fillFindings({
		...raw,
		propositions: raw.propositions.map((p) => {
			const stripped = { ...p } as typeof p & { messageId?: unknown };
			delete stripped.messageId;
			return stripped;
		}),
	});
}

function validateFindingsChains(value: FindingsSubmit, existingIds: ReadonlySet<string>): string | null {
	const ids = new Set(value.propositions.map((p) => p.id));
	for (const chain of value.chains) {
		if (chain.premises.length === 0) {
			return "chains: premises must name at least one proposition — a proposition with no argument stays in the propositions list alone.";
		}
		const unknown = [...chain.premises, chain.conclusion].find((id) => !ids.has(id) && !existingIds.has(id));
		if (unknown !== undefined) {
			return `chains: "${unknown}" is neither a submitted proposition id nor an existing idea id from THE GRAPH SO FAR — every premise and conclusion must resolve.`;
		}
		if (chain.premises.includes(chain.conclusion)) {
			return "chains: a conclusion cannot be its own premise.";
		}
	}
	return null;
}

function validateSessionAnchors(value: SessionFindingsSubmit, batchIds: ReadonlySet<string>): string | null {
	for (const p of value.propositions) {
		if (p.messageId.trim().length === 0) {
			return `propositions: "${p.id}" is missing its messageId — copy the message id from the brackets of the passage (TEACHER [id]) that most directly states or explains it.`;
		}
		if (!batchIds.has(p.messageId)) {
			return `propositions: "${p.id}" names messageId "${p.messageId}", which is not a passage of THIS stretch — copy the id from the brackets of one of this stretch's own TEACHER [id] passages.`;
		}
	}
	return null;
}

const asSessionFindings = (
	raw: {
		propositions: Array<{ id: string; name: string; statement: string; aliases?: string[]; messageId?: string }>;
		chains: Array<{ premises: string[]; conclusion: string }>;
	},
): SessionFindings => ({
	propositions: raw.propositions.map((p) => ({ ...p, aliases: p.aliases ?? [] })),
	chains: raw.chains,
});

function fillAudit(raw: Static<typeof auditSchema>): AuditVerdicts {
	return {
		links: raw.links,
	};
}

export const SESSION_MESSAGE_ID_RULE =
	"For each new proposition, copy the message ID of the passage that most directly states or explains it into messageId.";

export const SESSION_PREAMBLE =
	"You are the extraction stage of a learning application. You read one stretch of a source — a teaching " +
	"session, rendered as the teacher's prose in reading order — and report what it teaches as findings " +
	"for the learner's global knowledge graph, building on everything already extracted from this source.";

export const NOTES_PREAMBLE =
	"You are the extraction stage of a learning application. You read one stretch of a source — the " +
	"author's personal notes, rendered in reading order — and report what it teaches as findings for the " +
	"learner's global knowledge graph, building on everything already extracted from this source.";

export const EXTRACTION_CORE = `THE GOAL: uncover the source's CORE IDEAS and show how everything derives from the foundations. The
source teaches by arguing — ideas worked out from other ideas, down to a foundation the rest stands on.
Your deliverable is twofold: the core ideas themselves, and the chains of reasoning that derive them.
Each chain is premises that JOINTLY entail a conclusion. Entailment is the only link that earns a
chain — where the real connection is historical or narrative (who argued what, how a debate or
exposition unfolds), there is no chain; keep the pieces as bare ideas or drop them. The direction of
the graph is upward: foundational ideas at the bottom, derived ideas above them, each chain showing
how its conclusion follows from what is more established — do not submit connections that carry no
derivation.

The graph holds TRUE ideas about the world, nothing else — never anything about the learner, the
teacher, or this reading: not "the learner understands X" but X. A misconception enters as its TRUE
correction. Each statement is one self-contained idea at full precision.

Extract the load-bearing ideas of the subject — what a reference on it would teach — not the full run
of the discourse. An idea earns its place only when the source's arguments run through it — examples,
notation glosses, and restatements that no argument needs are not core ideas. Every idea must stand
alone for a reader who never saw this source: names and statements may not lean on the source's own
scaffolding (claim numbering, axiom tags, arc labels); a claim that only matters as part of how this
document is organized is not knowledge — drop it.

When the prompt carries THE GRAPH SO FAR, you are continuing a source already partly extracted: build
on it. Reference an existing idea by its id ("n_…") instead of restating it, and prefer chains that
lean on established conclusions as premises — derive new material from what is already derived. Do
not re-derive a conclusion the graph already holds unless the route is genuinely different.

SUBMIT with one submit_findings call: every NEW core idea with a short name and a precise statement,
and every chain as premises + conclusion. A chain's premises and conclusion may be ids from this
submission OR existing ids from THE GRAPH SO FAR, verbatim. Premises within one chain are used
TOGETHER — independent arguments for the same conclusion are separate chains. A conclusion may
reappear, by id, as a premise of later chains. A bare idea that no argument uses rides the
propositions list alone. Include every field even when empty — "chains": [] when the source makes no
arguments. The tool's field descriptions carry the details.`;

export const EXTRACTOR_INSTRUCTIONS = `${SESSION_PREAMBLE}\n\n${EXTRACTION_CORE}\n\n${SESSION_MESSAGE_ID_RULE}`;
export const NOTES_EXTRACTOR_INSTRUCTIONS = `${NOTES_PREAMBLE}\n\n${EXTRACTION_CORE}`;

export function sourceDigest(graph: DerivedGraph, sourceId: string): string {
	const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]));
	const ours = graph.nodes.filter((n) => n.provenance.some((pt) => pt.chatId === sourceId));
	const ourChains = graph.chains.filter((c) => c.provenance.some((pt) => pt.chatId === sourceId));
	if (ours.length === 0 && ourChains.length === 0) return "";
	const lines: string[] = [];
	lines.push("THE GRAPH SO FAR — everything already extracted from this source (reference these ids verbatim):");
	for (const n of ours) lines.push(`  ${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, " ")}`);
	if (ourChains.length > 0) {
		lines.push("DERIVATIONS ALREADY RECORDED (build on these; do not re-derive them):");
		for (const c of ourChains) {
			const names = c.premises.map((p) => nameOf.get(p) ?? p).join(" ∧ ");
			lines.push(`  [${c.premises.join(" + ")} ⇒ ${c.conclusion}]  ${names} ⇒ ${nameOf.get(c.conclusion) ?? c.conclusion}`);
		}
	}
	return lines.join("\n");
}

function runExtractor(
	engine: PiEngine | undefined,
	sourceId: string,
	prompt: string,
	existingIds: ReadonlySet<string>,
	batchIds: ReadonlySet<string>,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
): Promise<SessionFindings> {
	return runSubmitAgent<SessionFindingsSubmit>({
		role: "extractor",
		chatId: sourceId,
		toolName: "submit_findings",
		toolDescription: "Submit the session findings.",
		parameters: sessionFindingsSchema,
		fill: fillFindings,
		validate: (value) => validateSessionAnchors(value, batchIds) ?? validateFindingsChains(value, existingIds),
		systemPrompt: EXTRACTOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the extractor never submitted findings",
		prepareArguments: healStringifiedArrays,
	}).then(asSessionFindings);
}

function runNotesExtractor(
	engine: PiEngine | undefined,
	sourceId: string,
	prompt: string,
	existingIds: ReadonlySet<string>,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
): Promise<NotesFindings> {
	return runSubmitAgent<FindingsSubmit>({
		role: "extractor",
		chatId: sourceId,
		toolName: "submit_findings",
		toolDescription: "Submit the notes findings.",
		parameters: findingsSchema,
		fill: fillNotesFindings,
		validate: (value) => validateFindingsChains(value, existingIds),
		systemPrompt: NOTES_EXTRACTOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the extractor never submitted findings",
		prepareArguments: healStringifiedArrays,
	}).then(asSessionFindings);
}

const AUDITOR_INSTRUCTIONS = `You are the linking stage of a learning application's extraction pipeline. An extractor
has read a source (a teaching session, or the author's personal notes) and reported findings: propositions and
their reasoning chains. You NEVER see the source itself — the extractor is fully trusted, and you do not re-check
its work. Your job is IDENTITY: connecting those findings to the CURRENT knowledge graph, preparing the merge.

You explore the graph through your tools: list_sessions, list_propositions, and find (glob over names +
statements + aliases; each hit also says which session it was born in). The graph is SMALL and FINITE — a handful of
sessions — and your job is done as soon as you have SEEN the plausible candidates. FOLLOW THIS PROCEDURE:

1. GROUND yourself first: call list_sessions ONCE. This one call shows the entire space — every session that ever
   contributed propositions, and how many. Now you know the extent of what you are searching; nothing is hidden.
2. READ the plausibly-related sessions: for each session whose topic could overlap these findings, call
   list_propositions — every proposition born there, with full statement text. A few calls and you have read
   every realistic identity candidate in the graph.
3. find is your targeted sweep: use it for phrasings, synonyms, and neighboring ideas the session reads made you
   wonder about — its hits point back at sessions you can read whole.
4. SUBMIT. Once every plausibly-related session has been read (and stray finds come back empty), you are DONE.
   Do not re-search ground you have already seen; more patterns over the same nodes are wasted work.

IDENTITY — links, per proposition:
- For each proposition: does an EXISTING node — one you have now SEEN — already state this same proposition?
- If yes: add { "id": <its proposition id>, "linkTo": <that node's id> } to "links". The session's phrasings join
  its aliases and its provenance; the node keeps its existing name.
- If no: add nothing — a new node is created with the extractor's name as its label.
- EQUIVALENCE BIAS (owner ruling): paraphrases, rewordings, and compressions of the same claim MERGE. When two
  statements are the same claim at different precision or from different angles, LINK them. Only genuinely distinct
  propositions — different claims about the world — stay apart. You are NOT guarding against wrong merges; you are
  hunting for right ones.

Your deliverable is ONLY the identity verdicts: "links". NEVER restate the propositions —
the merger already has them. You NEVER create relations between propositions — they come from the
extractor alone, and the batch connects to the existing graph ONLY through the equivalences you identify. Your
entire deliverable is ONE submit_review call.

Include the "links" field even when empty — "links": [] when nothing links. NEVER omit it because it is empty.`;

function runAuditor(
	engine: PiEngine | undefined,
	sourceId: string,
	prompt: string,
	signal: AbortSignal | undefined,
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void,
	tools: Record<string, AgentTool<any>>,
): Promise<AuditVerdicts> {
	return runSubmitAgent({
		role: "auditor",
		chatId: sourceId,
		toolName: "submit_review",
		toolDescription: "Submit the identity verdicts ONLY (links) — never the propositions themselves.",
		parameters: auditSchema,
		fill: fillAudit,
		systemPrompt: AUDITOR_INSTRUCTIONS,
		prompt,
		engine,
		signal,
		onStep,
		neverSubmitted: "the auditor never submitted a review",
		extraTools: tools,
		maxTurns: 16,
		prepareArguments: healStringifiedArrays,
	});
}

export type ExtractionPhase = "queued" | "extracting" | "waiting" | "auditing" | "merging";

export interface RunningExtraction {
	chatId: string;
	part?: { i: number; n: number };
	kind: "chat" | "notes";
	label?: string;
	phase: ExtractionPhase;
	startedAt: number;
	usage: {
		extractor?: ExtractionStageUsage;
		auditor?: ExtractionStageUsage;
	};
	controller: AbortController;
}

interface LhExtractionGlobal {
	__lhExtractionRuns?: {
		running: Map<string, RunningExtraction>;
		inFlight: Set<string>;
		lastStartedAt: number;
	};
	__lhAuditLock?: { tail: Promise<void> };
	/** The EXTRACT SEMAPHORE (owner, 2026-09-28): 3 concurrent extractor
	 *  calls process-wide — the provider-facing rate stance (the import
	 *  route's old 3-wide pool doctrine, now global). Per-chunk jobs fan
	 *  out in parallel but queue here. */
}

/** globalThis, not module level: Next dev compiles each route entry as its
 *  own module instance, so a module-level Map is a different object per route. */
function runs(): NonNullable<LhExtractionGlobal["__lhExtractionRuns"]> {
	const g = globalThis as typeof globalThis & LhExtractionGlobal;
	return (g.__lhExtractionRuns ??= { running: new Map(), inFlight: new Set(), lastStartedAt: 0 });
}

export function extractionStatuses(): RunningExtraction[] {
	return [...runs().running.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** True cancellation of the in-flight run for a chat (the dock's abort
 *  button): the pending model call receives the signal — the provider
 *  cancels the request, spend stops — and the run ends like a failure:
 *  nothing merged, nothing checkpointed, partial usage still persisted.
 *  Returns false when no run is in flight (idempotent no-op). */
export function abortExtraction(chatId: string): boolean {
	let found = false;
	for (const run of runs().running.values()) {
		if (run.chatId !== chatId) continue;
		run.controller.abort();
		found = true;
	}
	return found;
}

export interface ExtractionModels {
	extractor?: PiEngine;
	auditor?: PiEngine;
	engineFor?: (role: ModelRole) => PiEngine | undefined;
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
}

export interface ExtractionPipelineDeps extends GraphDeps, ExtractionModels {
	getChunkTokens?: () => number;
}

export interface NotesImportInput {
	filePath: string;
	text: string;
}

export class NotesImportError extends Error {
	constructor(
		public readonly outcome: "failed" | "partial" | "aborted" | "busy",
		public readonly partialStats: EmissionStats,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "NotesImportError";
	}
}

export interface ExtractionPipeline {
	runExtraction(chatId: string): Promise<EmissionStats>;
	importNotes(input: NotesImportInput): Promise<EmissionStats>;
}

export function callUsage(usage: Usage): CallUsage {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
		// Optional in pi's Usage (providers that never emit reasoning
		// tokens leave it unset) — persisted as 0, never dropped.
		reasoningTokens: usage.reasoning ?? 0,
	};
}

export function createExtractionPipeline(deps: ExtractionPipelineDeps): ExtractionPipeline {
	const { chatStore, graphStore } = deps;
	const stageEngine = (role: ModelRole, override?: PiEngine): PiEngine | undefined =>
		override ?? deps.engineFor?.(role);
	function refuseIfStagesUnready(): void {
		const stages: readonly [ModelRole, PiEngine | undefined][] = [
			["extractor", stageEngine("extractor", deps.extractor)],
			["auditor", stageEngine("auditor", deps.auditor)],
		];
		const missing = new Set<ModelSlotName>();
		for (const [role, engine] of stages) if (!engine) missing.add(ROLE_SLOT[role]);
		if (missing.size > 0) {
			console.info(`[extraction] refused — no model configured for: ${[...missing].join(", ")}`);
			throw new ModelsNotConfiguredError([...missing]);
		}
		for (const [role, engine] of stages) {
			const refusal = deps.providerKeyMissing?.(engine!.model.provider, ROLE_SLOT[role]);
			if (refusal) {
				console.info(`[extraction] refused — ${JSON.stringify(refusal)}`);
				throw new ProviderKeyMissingError(refusal.provider, refusal.slots);
			}
		}
	}
	const runningExtractions = runs().running;
	const inFlight = runs().inFlight;

	function setPhase(
		jobKey: string,
		phase: ExtractionPhase,
		kind: "chat" | "notes",
		label?: string,
		part?: { i: number; n: number },
	): void {
		const R = runs();
		const prev = runningExtractions.get(jobKey);
		if (!prev) R.lastStartedAt = Math.max(Date.now(), R.lastStartedAt + 1);
		runningExtractions.set(jobKey, {
			chatId: prev?.chatId ?? jobKey.split("#")[0]!,
			part: prev?.part ?? part,
			kind,
			label: prev?.label ?? label,
			phase,
			startedAt: prev?.startedAt ?? R.lastStartedAt,
			usage: prev?.usage ?? {},
			controller: prev?.controller ?? new AbortController(),
		});
		emit("activity-changed", {});
	}

	function finishExtraction(jobKey: string): void {
		runningExtractions.delete(jobKey);
		emit("activity-changed", {});
	}

	function recordStep(jobKey: string, stage: "extractor" | "auditor", usage: CallUsage, model: string): void {
		const run = runningExtractions.get(jobKey);
		if (!run) return;
		run.usage[stage] ??= { model, steps: [] };
		run.usage[stage]!.steps.push(usage);
	}

	async function withAuditLock<T>(jobKey: string, kind: "chat" | "notes", label: string | undefined, critical: () => Promise<T>): Promise<T> {
		setPhase(jobKey, "waiting", kind, label);
		const g = globalThis as typeof globalThis & LhExtractionGlobal;
		const lock = (g.__lhAuditLock ??= { tail: Promise.resolve() });
		const prev = lock.tail;
		let release!: () => void;
		lock.tail = new Promise<void>((resolve) => (release = resolve));
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			if (!signal) return;
			onAbort = () => {
				const err = new Error("extraction aborted while waiting for the audit gate");
				err.name = "AbortError";
				reject(err);
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			await Promise.race([prev, aborted]);
			signal?.throwIfAborted();
			return await critical();
		} finally {
			if (onAbort && signal && !signal.aborted) signal.removeEventListener("abort", onAbort);
			release();
		}
	}

	async function extract(
		jobKey: string,
		sourceId: string,
		view: string,
		batchIds: ReadonlySet<string>,
	): Promise<SessionFindings> {
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		signal?.throwIfAborted();
		const graph = getGraph(graphStore);
		const digest = sourceDigest(graph, sourceId);
		const prompt = digest === "" ? view : `${digest}\n\n${view}`;
		console.info(
			`[extraction ${jobKey}] extractor starting (${view.split("\n").length} markdown lines` +
				`${digest === "" ? "" : `, digest ${digest.split("\n").length} lines`})`,
		);
		const t0 = performance.now();

		const findings = await runExtractor(
			stageEngine("extractor", deps.extractor),
			sourceId,
			prompt,
			new Set(graph.nodes.map((n) => n.id)),
			batchIds,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(jobKey, "extractor", callUsage(usage), model);
				console.info(`[extraction] extractor step ${step}: ${finishReason}, tools: ${tools}`);
			},
		);
		console.info(`[extraction ${jobKey}] extractor done in ${Math.round(performance.now() - t0)}ms`);
		return findings;
	}

	async function audit(jobKey: string, sourceId: string, findings: SessionFindings): Promise<AuditVerdicts> {
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		signal?.throwIfAborted();
		const graph = getGraph(graphStore);
		console.info(
			`[extraction ${jobKey}] auditor starting (${findings.propositions.length} propositions, ` +
				`${graph.nodes.length} graph nodes)`,
		);
		const t0 = performance.now();

		const auditResult = await runAuditor(
			stageEngine("auditor", deps.auditor),
			sourceId,
			`Proposed findings from the extractor (the source itself is not available to you — the extractor is fully trusted; the propositions only — the reasoning chains are the merger's business, owner 2026-09-30):\n\n` +
				`${JSON.stringify(
					{
						propositions: findings.propositions.map((p) => ({
							id: p.id,
							name: p.name,
							statement: p.statement,
							aliases: p.aliases,
						})),
					},
					null,
					2,
				)}\n\n` +
				`The current knowledge graph has ${graph.nodes.length} node(s). Explore it with your tools and link what links.`,
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(jobKey, "auditor", callUsage(usage), model);
				console.info(`[extraction] auditor step ${step}: ${finishReason}, tools: ${tools}`);
			},
			auditorGraphTools({ chatStore, graphStore }),
		);
		console.info(
			`[extraction ${jobKey}] audit: ${findings.propositions.length} propositions through, ` +
				`${auditResult.links.length} linked to existing nodes`,
		);
		console.info(`[extraction ${jobKey}] auditor done in ${Math.round(performance.now() - t0)}ms`);
		return auditResult;
	}

	async function withExtractSlot<T>(jobKey: string, critical: () => Promise<T>): Promise<T> {
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		return withBgLlmSlot(signal, critical);
	}

	function persistRunUsage(jobKey: string, durationMs: number, stats: EmissionStats | undefined): void {
		const run = runningExtractions.get(jobKey);
		if (!run) return;
		if (run.kind === "chat" && !chatStore.getChat(run.chatId)) return;
		const entry: ExtractionRunUsage = {
			startedAt: run.startedAt,
			at: new Date().toISOString(),
			durationMs,
			stats,
			stages: {
				extractor: run.usage.extractor ?? { model: "unknown", steps: [] },
				auditor: run.usage.auditor ?? { model: "unknown", steps: [] },
			},
		};
		if (run.kind === "notes") graphStore.appendSourceUsage(run.chatId, entry);
		else chatStore.appendExtractionUsage(run.chatId, entry);
	}

	async function runJob(
		source: { id: string; kind: "chat" | "notes"; label?: string; part?: { i: number; n: number } },
		body: (jobKey: string) => Promise<EmissionStats>,
	): Promise<EmissionStats> {
		const jobKey = source.part ? `${source.id}#${source.part.i}` : source.id;
		const t0 = performance.now();
		try {
			const stats = await body(jobKey);
			persistRunUsage(jobKey, Math.round(performance.now() - t0), stats);
			return stats;
		} catch (err) {
			persistRunUsage(jobKey, Math.round(performance.now() - t0), undefined);
			throw err;
		} finally {
			finishExtraction(jobKey);
		}
	}

	function aggregateJobs(sourceId: string, settled: PromiseSettledResult<EmissionStats>[]): EmissionStats {
		const stats: EmissionStats = { nodes: 0, chains: 0 };
		let aborted = false;
		let failed = 0;
		for (const result of settled) {
			if (result.status === "fulfilled") {
				stats.nodes += result.value.nodes;
				stats.chains! += result.value.chains ?? 0;
				if (result.value.droppedChains)
					stats.droppedChains = (stats.droppedChains ?? 0) + result.value.droppedChains;
				continue;
			}
			const err = result.reason;
			if (err instanceof Error && err.name === "AbortError") aborted = true;
			else {
				failed++;
				console.error(`[extraction ${sourceId}] job failed (isolated):`, err);
			}
		}
		if (aborted)
			console.info(
				`[extraction ${sourceId}] aborted — merged chunks keep their coverage, the rest stay uncovered for the next run`,
			);
		if (failed > 0)
			console.error(`[extraction ${sourceId}] ${failed} job(s) failed; successful jobs still merged`);
		return stats;
	}

	async function runExtraction(chatId: string): Promise<EmissionStats> {
		if (inFlight.has(chatId)) return { nodes: 0, chains: 0 };
		inFlight.add(chatId);
		const t0 = performance.now();
		try {
			const record = chatStore.getChat(chatId);
			if (!record) throw new Error(`Chat not found: ${chatId}`);
			refuseIfStagesUnready();
			const covered = coverageOf(record.messages, graphStore.readCoverage(), chatId);
			if (covered.uncovered.length === 0) {
				console.info(`[extraction ${chatId}] nothing uncovered — no-op`);
				return { nodes: 0, chains: 0 };
			}
			const chunkTokens = deps.getChunkTokens?.() ?? FACTORY_SETTINGS.graph.extractionChunkTokens;
			const batches = batchRuns(covered.slots, covered.uncovered, chunkTokens);
			console.info(
				`[extraction ${chatId}] pipeline start — ${covered.uncoveredTokens} uncovered tok, ` +
					`${covered.uncoveredCount} messages, ${batches.length} batch(es) of ≤${chunkTokens} tok`,
			);
			const settled: PromiseSettledResult<EmissionStats>[] = [];
			for (const [batchIndex, batch] of batches.entries()) {
				const part = batches.length > 1 ? { i: batchIndex + 1, n: batches.length } : undefined;
				try {
					settled.push({
						status: "fulfilled",
						value: await runJob({ id: chatId, kind: "chat", part }, async (jobKey) => {
							const messages = batch.map((slot) => slot.message);
							const view = proseView(messages, record.title);
							const batchIds = new Set(
								messages.filter((m) => messageViewLines(m, m.id).length > 0).map((m) => m.id),
							);
							setPhase(jobKey, "queued", "chat", undefined, part);
							const findings = await withExtractSlot(jobKey, async () => {
								setPhase(jobKey, "extracting", "chat", undefined, part);
								return extract(jobKey, chatId, view, batchIds);
							});
							return withAuditLock(jobKey, "chat", undefined, async () => {
								setPhase(jobKey, "auditing", "chat", undefined, part);
								const auditResult = await audit(jobKey, chatId, findings);
								setPhase(jobKey, "merging", "chat", undefined, part);
								if (!chatStore.getChat(chatId)) {
									const gone = new Error(`chat deleted mid-run: ${chatId}`);
									gone.name = "AbortError";
									throw gone;
								}
								const foldedAt = new Date().toISOString();
								const batchStats = mergeFindings(chatId, findings, auditResult, { chatStore, graphStore }, {
									foldedAt,
									coverage: batch
										.filter((slot) => messageViewLines(slot.message, slot.message.id).length > 0)
										.map((slot) => ({ chatId, fp: slot.fp, tokens: slot.tokens, foldedAt })),
								});
								settleGraphLayout(graphStore);
								console.info(
									`[extraction ${jobKey}] merged: ${batchStats.nodes} nodes, ${batchStats.chains ?? 0} chains`,
								);
								return batchStats;
							});
						}),
					});
				} catch (err) {
					settled.push({ status: "rejected", reason: err });
					if (err instanceof Error && err.name === "AbortError") break;
				}
			}
			const stats = aggregateJobs(chatId, settled);
			console.info(
				`[extraction ${chatId}] merged: ${stats.nodes} nodes, ${stats.chains ?? 0} chains ` +
					`(${Math.round(performance.now() - t0)}ms total, ${batches.length} batch job(s))`,
			);
			return stats;
		} catch (err) {
			console.error(`[extraction ${chatId}] pipeline failed (${Math.round(performance.now() - t0)}ms):`, err);
			throw err;
		} finally {
			inFlight.delete(chatId);
			finishExtraction(chatId); // done or failed — no longer running
		}
	}

	function notesView(input: { filePath: string; text: string; part?: { i: number; n: number } }): string {
		const part = input.part && input.part.n > 1 ? ` (part ${input.part.i}/${input.part.n})` : "";
		return `SOURCE (the author's personal notes): ${input.filePath}${part}\n\n${input.text}`;
	}

	function chunkNotes(text: string, budget: number): string[] {
		if (text.trim().length === 0) return [];
		const out: string[] = [];
		let current = "";
		for (const line of text.split("\n")) {
			const candidate = current.length === 0 ? line : current + "\n" + line;
			if (current.length > 0 && Math.ceil(candidate.length / 4) > budget) {
				out.push(current);
				current = line;
			} else {
				current = candidate;
			}
		}
		if (current.trim().length > 0) out.push(current);
		return out;
	}

	async function notesExtract(
		jobKey: string,
		input: { id: string; filePath: string; text: string; part?: { i: number; n: number } },
	): Promise<NotesFindings> {
		const signal = runningExtractions.get(jobKey)?.controller.signal;
		signal?.throwIfAborted();
		const view = notesView(input);
		const graph = getGraph(graphStore);
		const digest = sourceDigest(graph, input.id);
		const prompt = digest === "" ? view : `${digest}\n\n${view}`;
		console.info(
			`[extraction ${jobKey}] notes extractor starting (${view.split("\n").length} source lines` +
				`${digest === "" ? "" : `, digest ${digest.split("\n").length} lines`})`,
		);
		const t0 = performance.now();
		const findings = await runNotesExtractor(
			stageEngine("extractor", deps.extractor),
			input.id,
			prompt,
			new Set(graph.nodes.map((n) => n.id)),
			signal,
			(usage, model, step, finishReason, tools) => {
				recordStep(jobKey, "extractor", callUsage(usage), model);
				console.info(`[extraction] extractor step ${step}: ${finishReason}, tools: ${tools}`);
			},
		);
		console.info(`[extraction ${jobKey}] notes extractor done in ${Math.round(performance.now() - t0)}ms`);
		return findings;
	}

	async function runNotesExtraction(input: { id: string; filePath: string; text: string; importedAt: string }): Promise<EmissionStats> {
		const { id } = input;
		const t0 = performance.now();
		const mergedStats: EmissionStats = { nodes: 0, chains: 0 };
		try {
			refuseIfStagesUnready();
			const chunkTokens = deps.getChunkTokens?.() ?? FACTORY_SETTINGS.graph.extractionChunkTokens;
			const chunks = chunkNotes(input.text, chunkTokens);
			console.info(
				`[extraction ${id}] notes pipeline start (${input.filePath}) — ${chunks.length} chunk(s) of ≤${chunkTokens} tok`,
			);
			const settled: PromiseSettledResult<EmissionStats>[] = [];
			for (const [chunkIndex, chunk] of chunks.entries()) {
				const part = chunks.length > 1 ? { i: chunkIndex + 1, n: chunks.length } : undefined;
				let chunkSignal: AbortSignal | undefined;
				try {
					settled.push({
						status: "fulfilled",
						value: await runJob({ id, kind: "notes", label: input.filePath, part }, async (jobKey) => {
							setPhase(jobKey, "queued", "notes", input.filePath, part);
							chunkSignal = runningExtractions.get(jobKey)?.controller.signal;
							const findings = await withExtractSlot(jobKey, async () => {
								setPhase(jobKey, "extracting", "notes", input.filePath, part);
								return notesExtract(jobKey, { ...input, text: chunk, part });
							});
							return withAuditLock(jobKey, "notes", input.filePath, async () => {
								setPhase(jobKey, "auditing", "notes", input.filePath, part);
								const auditResult = await audit(jobKey, input.id, findings);
								setPhase(jobKey, "merging", "notes", input.filePath, part);
								const merged = mergeFindings(
									id,
									findings,
									auditResult,
									{ chatStore, graphStore },
									{ foldedAt: input.importedAt },
								);
								mergedStats.nodes += merged.nodes;
								mergedStats.chains! += merged.chains ?? 0;
								if (merged.droppedChains)
									mergedStats.droppedChains = (mergedStats.droppedChains ?? 0) + merged.droppedChains;
								settleGraphLayout(graphStore);
								console.info(`[extraction ${jobKey}] merged: ${merged.nodes} nodes, ${merged.chains ?? 0} chains`);
								return merged;
							});
						}),
					});
				} catch (err) {
					let failure = err;
					if (chunkSignal?.aborted && !(err instanceof Error && err.name === "AbortError")) {
						const aborted = new Error(`Notes import aborted; job cleanup failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
						aborted.name = "AbortError";
						failure = aborted;
					}
					settled.push({ status: "rejected", reason: failure });
					if (failure instanceof Error && failure.name === "AbortError") break;
				}
			}
			const stats = aggregateJobs(id, settled);
			const rejected = settled.filter((r) => r.status === "rejected");
			if (rejected.length > 0 || settled.length !== chunks.length) {
				const aborted = rejected.some((r) => r.reason instanceof Error && r.reason.name === "AbortError");
				const outcome = aborted ? "aborted" : settled.some((r) => r.status === "fulfilled") ? "partial" : "failed";
				const details = rejected.map((r) => r.reason instanceof Error ? r.reason.message : String(r.reason)).join("; ");
				throw new NotesImportError(outcome, mergedStats, details || "Notes import did not complete");
			}
			console.info(
				`[extraction ${id}] merged: ${stats.nodes} nodes, ${stats.chains ?? 0} chains ` +
					`(${Math.round(performance.now() - t0)}ms total, ${chunks.length} chunk job(s))`,
			);
			return stats;
		} catch (err) {
			console.error(`[extraction ${id}] notes pipeline failed (${Math.round(performance.now() - t0)}ms):`, err);
			if (err instanceof NotesImportError || err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) throw err;
			throw new NotesImportError(err instanceof Error && err.name === "AbortError" ? "aborted" : "failed", mergedStats,
				err instanceof Error ? err.message : String(err), { cause: err });
		} finally {
			finishExtraction(id); // done or failed — no longer running
		}
	}

	async function importNotes(input: NotesImportInput): Promise<EmissionStats> {
		const id = `src_${crypto.createHash("sha256").update(input.filePath).digest("hex").slice(0, 12)}`;
		if (inFlight.has(id)) throw new NotesImportError("busy", { nodes: 0, chains: 0 }, "This file is already being imported. Try again when it finishes.");
		inFlight.add(id);
		try {
			const importedAt = new Date().toISOString();
			graphStore.upsertSource({ id, filePath: input.filePath, importedAt });
			return await runNotesExtraction({ id, ...input, importedAt });
		} catch (err) {
			if (err instanceof NotesImportError || err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) throw err;
			throw new NotesImportError("failed", { nodes: 0, chains: 0 }, err instanceof Error ? err.message : String(err), { cause: err });
		} finally {
			inFlight.delete(id);
		}
	}

	return { runExtraction, importNotes };
}

