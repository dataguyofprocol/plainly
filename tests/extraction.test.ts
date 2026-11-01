import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall, type Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { newPlanBlockMessage } from "../src/core/native-messages.ts";
import { projectView as projectNative } from "../src/core/view.ts";
import type {
	AuditVerdicts,
	CoverageEntry,
	ExtractionRunUsage,
	GraphChain,
	GraphNode,

	NotesSource,
	SessionCheckpoint,
	SessionFindings,
} from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import {
	abortExtraction,
	createExtractionPipeline,
	NotesImportError,
	extractionStatuses,
	transcriptView,
	sourceDigest,
	EXTRACTION_CORE,
	SESSION_PREAMBLE,
	SESSION_MESSAGE_ID_RULE,
	NOTES_PREAMBLE,
	EXTRACTOR_INSTRUCTIONS,
	NOTES_EXTRACTOR_INSTRUCTIONS,
} from "../src/agent/subagents/extraction.ts";
import { getGraph, simplifyChains } from "../src/core/graph.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, providerKeyMissing, type ModelSlotName } from "../src/core/settings.ts";
import { coverageOf, coverageSlots, messageViewLines } from "../src/core/coverage.ts";
import { chatStore } from "../src/store/chats.ts";
import { subscribe } from "../src/core/events.ts";
import { PATHS } from "../config.ts";

const createdChats: string[] = [];

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function memoryLedgers() {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const coverage: CoverageEntry[] = [];
	const sources = new Map<string, NotesSource>();
	const positions = new Map<string, { x: number; y: number }>();
		return {
		appendNode: (n: GraphNode) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n })),
		appendChain: (c: GraphChain) => void chains.push(c),
		readChains: () => chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })),
		appendCheckpoint: (c: SessionCheckpoint) => void checkpoints.push(c),
		readCheckpoints: () => checkpoints.map((c) => ({ ...c })),
		appendCoverage: (e) => void coverage.push({ ...e }),
		readCoverage: () => coverage.map((e) => ({ ...e })),
		upsertSource: (s: NotesSource) => {
			const prev = sources.get(s.id);
			sources.set(s.id, { ...s, extractions: [...(prev?.extractions ?? [])] });
		},
		readSources: () => [...sources.values()].map((s) => ({ ...s, extractions: [...(s.extractions ?? [])] })),
		appendSourceUsage: (id: string, entry: ExtractionRunUsage) => {
			const source = sources.get(id);
			if (!source) return;
			if (!source.extractions?.some((r) => r.startedAt === entry.startedAt)) {
				source.extractions = [...(source.extractions ?? []), entry];
			}
		},
		readPositions: () => Object.fromEntries([...positions].map(([id, p]) => [id, { ...p }])),
		writePositions: (next) => {
			positions.clear();
			for (const [id, p] of Object.entries(next)) positions.set(id, { x: p.x, y: p.y });
		},
		rewriteLedgers: (next) => {
			if (next.nodes) nodes.splice(0, nodes.length, ...next.nodes.map((n) => ({ ...n, provenance: [...n.provenance], aliases: [...n.aliases] })));
			if (next.chains) chains.splice(0, chains.length, ...next.chains.map((c) => ({ ...c, premises: [...c.premises], provenance: [...c.provenance] })));
			if (next.coverage) coverage.splice(0, coverage.length, ...next.coverage.map((c) => ({ ...c })));
			if (next.checkpoints) checkpoints.splice(0, checkpoints.length, ...next.checkpoints.map((c) => ({ ...c })));
		},
	} satisfies GraphStore;
}

interface NativeCallDesc {
	name: string;
	toolCallId: string;
	input: Record<string, unknown>;
	output: unknown;
}

function user(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: Date.now() } as never;
}

function assistant(id: string, items: unknown[]): LhMessage[] {
	const content: unknown[] = [];
	const calls: NativeCallDesc[] = [];
	for (const item of items) {
		const it = item as { type?: string; text?: string };
		if (it && it.type === "text") {
			content.push({ type: "text", text: it.text });
		} else {
			const call = item as NativeCallDesc;
			calls.push(call);
			content.push({ type: "toolCall", id: call.toolCallId, name: call.name, arguments: call.input as never });
		}
	}
	const out: LhMessage[] = [
		{
			id,
			role: "assistant",
			content,
			api: "openai-completions",
			provider: "openrouter",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: Date.now(),
		} as never,
	];
	for (const call of calls) {
		out.push({
			id: `r_${call.toolCallId}`,
			role: "toolResult",
			toolCallId: call.toolCallId,
			toolName: call.name,
			content: [{ type: "text", text: "ok" }],
			details: call.output,
			isError: false,
			timestamp: Date.now(),
		} as never);
	}
	return out;
}

function quizPart(toolCallId: string, input: Record<string, unknown>, output: Record<string, unknown>): NativeCallDesc {
	return { name: "quiz", toolCallId, input, output };
}

function planPart(toolCallId: string, name: string, input: Record<string, unknown>, tree: unknown): NativeCallDesc {
	return { name, toolCallId, input, output: { ok: true, tree } };
}

function fixtureChat() {
	const chat = chatStore.createChat("Extraction fixture");
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, [
		user("u1", "teach me the chain rule"),
		...assistant("a1", [
			{ type: "text", text: "The chain rule composes rates of change along a path." },
			quizPart("probe-1", { question: "What is a derivative, roughly?" }, {
				kind: "quiz", questionText: "What is a derivative, roughly?",
				correct: false, dontKnow: false, answeredAt: "2026-08-22T01:00:00.000Z",
			}),
		]),
		user("u2", "go on"),
		...assistant("a2", [
			{ type: "text", text: "The derivative measures how fast a function changes." },
			planPart("p1", "plan_init", { nodes: [], edges: [] }, { nodes: [], edges: [], currentNodeId: null, doneNodeIds: [], version: 1 }),
		]),
		user("u3", "check me"),
		...assistant("a3", [
			quizPart("check-1", { question: "Check" }, {
				kind: "quiz", questionText: "Check", correct: true, dontKnow: false,
				answeredAt: "2026-08-22T02:00:00.000Z",
			}),
		]),
	].flat());
	return { chatId: chat.id, record: chatStore.getChat(chat.id)! };
}

after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(`${PATHS.chats}/${id}.json`);
		} catch {
		}
	}
});

const FINDINGS = {
	propositions: [
		{
			id: "p1",
			name: "Derivative",
			statement: "The derivative measures how fast a function changes",
			aliases: [],
			messageId: "a2",
		},
		{
			id: "p2",
			name: "Chain rule",
			statement: "The chain rule differentiates composed functions by multiplying local rates.",
			aliases: [],
			messageId: "a1",
		},
	],
	chains: [
		{
			premises: ["p1"],
			conclusion: "p2",
		},
	],
};

function submitModel(name: string, input: unknown, onCall?: () => void): PiEngine {
	return fauxEngine([
		(context) => {
			onCall?.();
			void context;
			return fauxAssistantMessage(
				[fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })],
				{ stopReason: "toolUse" },
			);
		},
	]);
}

function gatedSubmitModel(name: string, input: unknown, gate: Promise<void>, onCall?: () => void): PiEngine {
	return fauxEngine([
		async () => {
			onCall?.();
			await gate;
			return fauxAssistantMessage(
				[fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-call` })],
				{ stopReason: "toolUse" },
			);
		},
	]);
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
	for (const t0 = Date.now(); !cond(); ) {
		if (Date.now() - t0 > ms) throw new Error("condition never became true in time");
		await new Promise((r) => setTimeout(r, 2));
	}
}

function hangingModel(): PiEngine {
	return fauxEngine([
		(_context, options) =>
			new Promise((resolve) => {
				const sig = options?.signal;
				if (sig?.aborted) {
					resolve(fauxAssistantMessage("late"));
					return;
				}
				sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
			}),
	]);
}

function silentModel(): PiEngine {
	return fauxEngine([fauxAssistantMessage("I refuse to use tools"), fauxAssistantMessage("…")]);
}

describe("transcriptView (pure — teacher prose only, owner 2026-09-28)", () => {
	it("renders ONLY the teacher's prose — no learner, no checks, no tool notes", () => {
		const { record } = fixtureChat();
		const view = transcriptView(record);

		assert.match(view, /^# Extraction fixture$/m);
		assert.match(view, /^TEACHER \[a1\] The chain rule composes rates of change along a path\.$/m);
		assert.match(view, /^TEACHER \[a2\] The derivative measures how fast a function changes\.$/m);

		assert.doesNotMatch(view, /TEACHER \[a3\]/);
		assert.doesNotMatch(view, /TEACHER \[u1\]/);
		assert.equal(
			view.slice(view.indexOf("TEACHER")),
			record.messages.flatMap((m) => messageViewLines(m, m.id)).join("\n\n"),
			"the view body IS the messageViewLines of the transcript — one shared seam",
		);

		assert.doesNotMatch(view, /teach me the chain rule/);
		assert.doesNotMatch(view, /go on/);
		assert.doesNotMatch(view, /check me/);
		assert.doesNotMatch(view, /### /);
		assert.doesNotMatch(view, /Quiz/);
		assert.doesNotMatch(view, /plan_init/);
	});

	it("job tool results and empty text vanish — only prose paragraphs remain", () => {
		const chat = chatStore.createChat("View noise fixture");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [
			user("u1", "go"),
			...assistant("a1", [
				{
					name: "research",
					toolCallId: "r1",
					input: { question: "q" },
					output: { brief: "long brief", sources: [] },
				},
				{ type: "text", text: "   " },
				{ type: "text", text: "Prose survives." },
			]),
		].flat());
		const view = transcriptView(chatStore.getChat(chat.id)!);
		assert.match(view, /^TEACHER \[a1\] Prose survives\.$/m, "the surviving passage is labeled with its real id");
		assert.doesNotMatch(view, /research/);
		assert.doesNotMatch(view, /long brief/);
		assert.doesNotMatch(view, /### /);
	});
});

describe("the extraction pipeline (extractor → auditor → merger)", () => {
	it("push S5: every registry mutation announces activity-changed; reads stay silent", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const verdict: AuditVerdicts = { links: [] };
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
		});

		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "activity-changed") announces++;
		});
		extractionStatuses();
		assert.equal(announces, 0);

		await pipeline.runExtraction(chatId);
		assert.ok(announces >= 2, `phases + finish announced (got ${announces})`);
		const afterSettle = announces;
		extractionStatuses();
		assert.equal(announces, afterSettle, "reads stay silent");
		off();
	});

	it("stringified-payload heal (owner, 2026-09-28): propositions arriving as ONE JSON string still validate and merge", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const verdict: AuditVerdicts = { links: [] };

		const extractor = submitModel("submit_findings", {
			propositions: JSON.stringify(FINDINGS.propositions),
			chains: FINDINGS.chains,
		});

		const pipeline = createExtractionPipeline({ chatStore, graphStore: ledgers, extractor, auditor: submitModel("submit_review", verdict) });
		const stats = await pipeline.runExtraction(chatId);
		assert.deepEqual(stats, { nodes: 2, chains: 1 });
	});

	it("stringified-payload heal: the CHAINS array arriving as ONE JSON string still validates (redesign, 2026-09-30)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = submitModel("submit_findings", {
			propositions: FINDINGS.propositions,
			chains: JSON.stringify(FINDINGS.chains),
		});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 1 });
	});

	it("runs end to end: findings → audit verdict (identity) → deterministic merge + checkpoint", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		const existingId = "n_existing";
		ledgers.appendNode({
			id: existingId,
			name: "Derivative",
			statement: "Derivatives measure rates of change",
			aliases: [],
			createdAt: "2026-08-01T00:00:00.000Z",
			provenance: [],
		});
		const verdict: AuditVerdicts = {
			links: [{ id: FINDINGS.propositions[0]!.id, linkTo: existingId }],
		};

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
		});
		const stats = await pipeline.runExtraction(chatId);

		assert.deepEqual(stats, { nodes: 1, chains: 1 });

		assert.equal(ledgers.readNodes().length, 3);
		const linkedLines = ledgers.readNodes().filter((n) => n.id === existingId);
		assert.ok(
			linkedLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId)),
			"the link-append unions provenance",
		);
		assert.ok(
			linkedLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId && pt.messageId === "a2")),
			"the link-append line carries p1's passage id",
		);
		const created = ledgers.readNodes().find((n) => n.name === "Chain rule")!;
		assert.deepEqual(created.provenance, [{ chatId, messageId: "a1" }], "the created node anchors to p2's passage");

		const record = chatStore.getChat(chatId)!;
		const covered = ledgers.readCoverage();
		const visible = record.messages.filter(
			(m) => messageViewLines(m, m.id).length > 0,
		).length;
		assert.equal(covered.length, visible);
		assert.ok(covered.every((c) => c.chatId === chatId && c.fp.length === 64 && c.tokens > 0));
		assert.equal(ledgers.readCheckpoints().length, 0, "the chat path writes coverage, not the legacy checkpoint");

		assert.equal(
			coverageOf(record.messages, covered, chatId).uncoveredCount,
			0,
			"every message is now covered",
		);
	});

	it("BYOK refusal: no stage engines anywhere → the run throws honestly before any stage (owner, 2026-09-22)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({ chatStore, graphStore: ledgers });
		await assert.rejects(pipeline.runExtraction(chatId), (err: unknown) => {
			assert.ok(err instanceof ModelsNotConfiguredError);
			assert.deepEqual(err.envelope.missing, ["cheap"]);
			assert.equal(err.envelope.code, "models_not_configured");
			return true;
		});
		assert.equal(ledgers.readCoverage().length, 0);
	});

	it("key-presence refusal: a stage engine whose provider key is gone throws before any batch (provider-key interlude, 2026-09-25)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = fauxEngine([]);
		const auditor = fauxEngine([]);
		const seen: Array<[string, ModelSlotName]> = [];
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor,
			providerKeyMissing: (provider, tier) => {
				seen.push([provider, tier]);
				return providerKeyMissing(provider, [tier]);
			},
		});
		await assert.rejects(pipeline.runExtraction(chatId), (err: unknown) => {
			assert.ok(err instanceof ProviderKeyMissingError);
			assert.equal(err.envelope.code, "provider_key_missing");
			assert.equal(err.envelope.provider, extractor.model.provider, "the provider of the keyless engine");
			assert.deepEqual(err.envelope.slots, ["cheap"], "extractor + auditor are the cheap tier");
			return true;
		});
		assert.deepEqual(seen, [[extractor.model.provider, "cheap"]]);
		assert.equal(ledgers.readCoverage().length, 0);
	});

	it("key-presence pass-through: null from the check lets a stage through — the NEXT keyless stage surfaces (first-offender discipline)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		let calls = 0;
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: fauxEngine([]),
			auditor: fauxEngine([]),
			providerKeyMissing: (provider, tier) => (calls++ < 1 ? null : providerKeyMissing(provider, [tier])),
		});
		await assert.rejects(pipeline.runExtraction(chatId), (err: unknown) => {
			assert.ok(err instanceof ProviderKeyMissingError, "the auditor's refusal surfaces after the extractor passed");
			return true;
		});
		assert.equal(calls, 2, "both stages were checked, in order");
		assert.equal(ledgers.readCoverage().length, 0);
	});

	it("the LLM cluster-namer is DEAD (wave 7): a merge mints no naming runs — labels are session names now", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const verdict: AuditVerdicts = { links: [] };
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.deepEqual(stats, { nodes: 2, chains: 1 });
	});



	it("engineFor fills the stages (model slots wave): the chain replaces config pins", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const verdict: AuditVerdicts = { links: [] };
		const consulted: string[] = [];
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			engineFor: (role) => {
				consulted.push(role);
				if (role === "extractor") return submitModel("submit_findings", FINDINGS);
				if (role === "auditor") return submitModel("submit_review", verdict);
				return submitModel("submit_labels", { labels: [] });
			},
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.equal(stats.nodes, 2, "the chain-fed pipeline ran end to end — both propositions merged");
		assert.deepEqual(consulted.slice(0, 2), ["extractor", "auditor"]);
	});

	it("direct test values still WIN over engineFor (the priority pin)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const verdict: AuditVerdicts = { links: [] };
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", verdict),
			engineFor: (role) => {
				throw new Error(`engineFor should not be consulted for ${role} when a direct value is set`);
			},
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.equal(stats.nodes, 2, "the direct-value seams ran, untouched by engineFor");
	});

	it("a failing stage is ISOLATED (per-chunk jobs, owner 2026-09-28): the job fails, nothing merges — and a sibling batch still merges", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: silentModel(),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 0, chains: 0 });
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readCheckpoints().length, 0, "no checkpoint — the next trigger re-runs");
		assert.equal(ledgers.readCoverage().length, 0);

		const failingExtractor = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: silentModel(),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await failingExtractor.runExtraction(chatId), { nodes: 0, chains: 0 });
		assert.equal(ledgers.readCheckpoints().length, 0);

		const { chatId: chunkyId, record } = chunkyChat();
		let invocations = 0;
		const findings = findingsStep();
		const refuse = fauxAssistantMessage("I refuse to use tools");
		const countingStep: FauxResponseStep = (context, options, state, model) => {
			invocations++;
			const step = invocations === 1 ? findings : refuse;
			return typeof step === "function" ? step(context, options, state, model) : step;
		};
		const mixed = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			getChunkTokens: () => 4096,
			engineFor: (role) =>
				role === "extractor"
					? fauxEngine([countingStep])
						: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await mixed.runExtraction(chunkyId), { nodes: 2, chains: 1 }, "batch 1's merge survives batch 2's failure");
		assert.equal(invocations, 2);
		assert.equal(ledgers.readCoverage().length, 3, "batch 1 checkpointed its three messages");
		assert.equal(
			coverageOf(record.messages, ledgers.readCoverage(), chunkyId).uncoveredCount,
			2,
			"batch 2's messages stay uncovered for the next run",
		);
	});

	it("reports its phase through the status registry while running, and clears it when done", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const existingId = "n_existing";
		ledgers.appendNode({
			id: existingId,
			name: "Derivative",
			statement: "Derivatives measure rates of change",
			aliases: [],
			createdAt: "2026-08-01T00:00:00.000Z",
			provenance: [],
		});
		const seen: (string | undefined)[] = [];
		const phaseOf = () => extractionStatuses().find((r) => r.chatId === chatId)?.phase;
		const verdict: AuditVerdicts = {
			links: [{ id: FINDINGS.propositions[0]!.id, linkTo: existingId }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS, () => seen.push(phaseOf())),
			auditor: submitModel("submit_review", verdict, () => seen.push(phaseOf())),
		});
		await pipeline.runExtraction(chatId);
		assert.deepEqual(seen, ["extracting", "auditing"]);
		assert.equal(extractionStatuses().length, 0, "the registry clears when the run ends");
	});

	it("serialized audit (owner 2026-09-28): a second run QUEUES at the gate; its auditor explores the graph only AFTER the first run's merge", async () => {
		const a = fixtureChat();
		const b = fixtureChat();
		const ledgers = memoryLedgers();

		const single = (id: string, name: string, statement: string) => ({
			propositions: [{ id, name, statement, aliases: [], messageId: "a1" }],
			chains: [],
		});
		const findingsA = single("pa", "Alpha claim", "Alpha statement, full precision");
		const findingsB = single("pb", "Beta claim", "Beta statement, full precision");

		let gateOpen!: () => void;
		const gate = new Promise<void>((resolve) => (gateOpen = resolve));
		let aAuditing = false;
		const pipelineA = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", findingsA),
			auditor: gatedSubmitModel("submit_review", { links: [] }, gate, () => {
				aAuditing = true;
			}),
		});
		const runA = pipelineA.runExtraction(a.chatId);
		await until(() => extractionStatuses().some((r) => r.chatId === a.chatId && r.phase === "auditing"));
		assert.ok(aAuditing, "run A holds the gate — its audit model call is in flight");

		let bAuditorCalled = false;
		let bSawAlphasMerge = false;
		const pipelineB = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", findingsB),
			auditor: submitModel("submit_review", { links: [] }, () => {
				bAuditorCalled = true;
				bSawAlphasMerge = ledgers.readNodes().some((n) => n.name === "Alpha claim");
			}),
		});
		const runB = pipelineB.runExtraction(b.chatId);

		await until(() => extractionStatuses().some((r) => r.chatId === b.chatId && r.phase === "waiting"));
		assert.ok(!bAuditorCalled, "B's auditor has not been invoked — it queues behind A");
		assert.equal(ledgers.readNodes().filter((n) => n.name === "Beta claim").length, 0, "nothing of B merged yet");
		assert.equal(extractionStatuses().find((r) => r.chatId === a.chatId)?.phase, "auditing", "A still audits while B waits");

		gateOpen();
		assert.deepEqual(await runA, { nodes: 1, chains: 0 });
		assert.deepEqual(await runB, { nodes: 1, chains: 0 });
		assert.ok(bAuditorCalled);
		assert.ok(bSawAlphasMerge, "B's auditor saw A's merged node — audit serialized after merge");
		assert.equal(extractionStatuses().length, 0, "both runs left the registry");
	});

	it("serialized audit: a run ABORTED while waiting never audits — and the queue chain stays healthy for successors", async () => {
		const a = fixtureChat();
		const b = fixtureChat();
		const c = fixtureChat();
		const ledgers = memoryLedgers();

		const single = (id: string, name: string, statement: string) => ({
			propositions: [{ id, name, statement, aliases: [], messageId: "a1" }],
			chains: [],
		});

		let gateOpen!: () => void;
		const gate = new Promise<void>((resolve) => (gateOpen = resolve));
		const pipelineA = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", single("pa", "Alpha claim", "Alpha statement")),
			auditor: gatedSubmitModel("submit_review", { links: [] }, gate),
		});
		const runA = pipelineA.runExtraction(a.chatId);
		await until(() => extractionStatuses().some((r) => r.chatId === a.chatId && r.phase === "auditing"));

		let bAuditorCalled = false;
		const pipelineB = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", single("pb", "Beta claim", "Beta statement")),
			auditor: submitModel("submit_review", { links: [] }, () => {
				bAuditorCalled = true;
			}),
		});
		const runB = pipelineB.runExtraction(b.chatId);
		await until(() => extractionStatuses().some((r) => r.chatId === b.chatId && r.phase === "waiting"));

		assert.equal(abortExtraction(b.chatId), true);
		assert.deepEqual(await runB, { nodes: 0, chains: 0 }, "aborted before auditing — zero emissions");
		assert.ok(!bAuditorCalled, "B's auditor was never invoked");
		assert.ok(!extractionStatuses().some((r) => r.chatId === b.chatId), "B left the registry");
		assert.equal(ledgers.readCoverage().some((row) => row.chatId === b.chatId), false, "B checkpointed nothing");

		gateOpen();
		assert.deepEqual(await runA, { nodes: 1, chains: 0 });
		const pipelineC = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", single("pc", "Gamma claim", "Gamma statement")),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipelineC.runExtraction(c.chatId), { nodes: 1, chains: 0 });
	});

	it("captures per-stage usage live, persists the run's usage into the chat record", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const existingId = "n_existing";
		ledgers.appendNode({
			id: existingId,
			name: "Derivative",
			statement: "Derivatives measure rates of change",
			aliases: [],
			createdAt: "2026-08-01T00:00:00.000Z",
			provenance: [],
		});
		const usageSeen: (number | undefined)[] = [];
		const verdict: AuditVerdicts = {
			links: [{ id: FINDINGS.propositions[0]!.id, linkTo: existingId }],
		};
		const nativeUsage: Record<"extractor" | "auditor", Usage[]> = { extractor: [], auditor: [] };
		const recordUsage = (stage: "extractor" | "auditor", engine: PiEngine): PiEngine => ({
			...engine,
			streamFn: (model, context, options) => {
				const stream = engine.streamFn(model, context, options);
				void stream.result().then((message) => nativeUsage[stage].push(message.usage));
				return stream;
			},
		});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: recordUsage("extractor", submitModel("submit_findings", FINDINGS)),
			auditor: recordUsage("auditor", submitModel("submit_review", verdict, () =>
				usageSeen.push(extractionStatuses().find((r) => r.chatId === chatId)?.usage.extractor?.steps.at(-1)?.inputTokens),
			)),
		});
		await pipeline.runExtraction(chatId);

		assert.equal(usageSeen.length, 1);
		assert.ok(typeof usageSeen[0] === "number" && usageSeen[0]! > 0, "the extractor's step billed input tokens");

		const record = chatStore.getChat(chatId)!;
		assert.equal(record.extractions?.length, 1);
		const run = record.extractions![0]!;
		assert.equal(run.stats?.nodes, 1);
		assert.equal(run.stages.extractor.model, "faux:faux-1");
		assert.equal(run.stages.extractor.steps.length, 1);
		const step = run.stages.extractor.steps[0]!;
		assert.ok(step.inputTokens! > 0 && step.outputTokens! > 0, "estimated usage captured");
		assert.equal(step.cacheReadTokens, 0);
		assert.equal(nativeUsage.extractor.length, 1);
		assert.ok(nativeUsage.extractor[0]!.cacheWrite > 0, "fresh native conversation writes its cached prefix");
		assert.equal(step.cacheReadTokens, nativeUsage.extractor[0]!.cacheRead);
		assert.equal(step.cacheWriteTokens, nativeUsage.extractor[0]!.cacheWrite);
		assert.equal(step.reasoningTokens, 0);
		assert.equal(nativeUsage.auditor.length, 1);
		assert.equal(run.stages.auditor.steps[0]!.cacheReadTokens, 0, "auditor owns a fresh conversation too");
		assert.ok(nativeUsage.auditor[0]!.cacheWrite > 0);
		assert.equal(run.stages.auditor.steps[0]!.cacheReadTokens, nativeUsage.auditor[0]!.cacheRead);
		assert.equal(run.stages.auditor.steps[0]!.cacheWriteTokens, nativeUsage.auditor[0]!.cacheWrite);
		assert.equal(run.stages.auditor.steps.length, 1);
		assert.ok(!Number.isNaN(Date.parse(run.at)));
	});

	it("aborts mid-run: cancels the model call, persists partial usage, checkpoints nothing", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: hangingModel(),
			auditor: submitModel("submit_review", { links: [] }),
		});
		const runPromise = pipeline.runExtraction(chatId);

		assert.equal(abortExtraction(chatId), true);
		const stats = await runPromise;

		assert.deepEqual(stats, { nodes: 0, chains: 0 });
		assert.equal(extractionStatuses().length, 0, "the registry clears");
		assert.equal(ledgers.readNodes().length, 0, "nothing merged");
		assert.equal(ledgers.readCheckpoints().length, 0, "nothing checkpointed — the next trigger re-runs");

		const record = chatStore.getChat(chatId)!;
		assert.equal(record.extractions?.length, 1);
		const run = record.extractions![0]!;
		assert.equal(run.stats, undefined);
		assert.equal(run.stages.extractor.steps.length, 0);
		assert.equal(run.stages.auditor.steps.length, 0);

		assert.equal(abortExtraction(chatId), false);
	});

	it("is single-flight per chat — a concurrent second run is a no-op", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const gatedExtractor = fauxEngine([
			async () => {
				calls++;
				if (calls === 1) await gate;
				return fauxAssistantMessage("…");
			},
		]);

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: gatedExtractor,
			auditor: silentModel(),
		});

		const first = pipeline.runExtraction(chatId);
		const second = await pipeline.runExtraction(chatId);
		assert.deepEqual(second, { nodes: 0, chains: 0 });

		release();
		assert.deepEqual(await first, { nodes: 0, chains: 0 });
	});

	it("registers runs on the process-wide registry (route-instance safety): a second pipeline instance sees the same single-flight state", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const gatedExtractor = fauxEngine([
			async () => {
				calls++;
				if (calls === 1) await gate;
				return fauxAssistantMessage("…");
			},
		]);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: gatedExtractor,
			auditor: silentModel(),
		});
		const observer = createExtractionPipeline({
			chatStore,
			graphStore: memoryLedgers(),
			extractor: silentModel(),
			auditor: silentModel(),
		});

		const first = pipeline.runExtraction(chatId);
		assert.ok(
			extractionStatuses().some((run) => run.chatId === chatId && run.phase === "extracting"),
			"the run is registered at start",
		);
		const g = globalThis as { __lhExtractionRuns?: { running: Map<string, unknown> } };
		assert.ok(g.__lhExtractionRuns?.running.has(chatId), "the registry lives on globalThis — no module-instance split can hide runs");
		assert.deepEqual(await observer.runExtraction(chatId), { nodes: 0, chains: 0 }, "single-flight spans pipeline instances");

		release();
		assert.deepEqual(await first, { nodes: 0, chains: 0 }, "isolated job failure — the run resolves zeros");
		assert.ok(!extractionStatuses().some((run) => run.chatId === chatId), "the registry entry clears when the run ends (however it ends)");
		assert.ok(!g.__lhExtractionRuns?.running.has(chatId), "nothing leaks into the global registry");
	});

	it("throws for unknown chats", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: silentModel(),
			auditor: silentModel(),
		});
		await assert.rejects(pipeline.runExtraction("chat_does_not_exist"), /Chat not found/);
	});
});

describe("message anchors (session propositions carry their passage's id)", () => {
	const anchored = (messageId: string) => ({
		propositions: [
			{ id: "p1", name: "Anchor claim", statement: "Anchor claim, full precision.", aliases: [], messageId },
		],
		chains: [],
	});

	const submitStep = (payload: unknown): FauxResponseStep => () =>
		fauxAssistantMessage(
			[fauxToolCall("submit_findings", payload as ToolCall["arguments"], { id: "anchor-call" })],
			{ stopReason: "toolUse" },
		);

	it("a submit MISSING messageId never passes: the schema rejects every turn — nothing merges, nothing checkpoints", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const bare = () =>
			fauxEngine(
				Array.from({ length: 4 }, () =>
					submitStep({
						propositions: [{ id: "p1", name: "Anchor claim", statement: "Anchor claim, full precision.", aliases: [] }],
						chains: [],
					}),
				),
			);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			engineFor: (role) => (role === "extractor" ? bare() : submitModel("submit_review", { links: [] })),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 0, chains: 0 });
		assert.equal(ledgers.readNodes().length, 0, "nothing merged");
		assert.equal(ledgers.readCoverage().length, 0, "nothing checkpointed — the batch stays re-runnable");
	});

	it("an EMPTY or UNKNOWN anchor rides the error-back channel: refused, the model re-anchors clean, then merges", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = fauxEngine([
			submitStep(anchored("")),
			submitStep(anchored("u1")),
			submitStep(anchored("made_up")),
			submitStep(anchored("a2")),
		]);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 1, chains: 0 }, "the retry anchored and merged");
		const node = ledgers.readNodes()[0]!;
		assert.deepEqual(node.provenance, [{ chatId, messageId: "a2" }], "the node anchors to its passage");
	});

	it("the boundary is the CURRENT BATCH: a real teacher message id from another batch is refused, the in-batch retry merges", async () => {
		const { chatId } = chunkyChat();
		const ledgers = memoryLedgers();
		const extractor = fauxEngine([
			submitStep(anchored("a5")),
			submitStep(anchored("a2")),
			submitStep(anchored("a4")),
		]);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			getChunkTokens: () => 4096,
			extractor,
			auditor: fauxEngine([passThroughAuditStep(), passThroughAuditStep()]),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 0 });
		const anchors = ledgers.readNodes().map((n) => n.provenance[0]!.messageId).sort();
		assert.deepEqual(anchors, ["a2", "a4"], "each job's node anchors INSIDE its own batch — never a5");
		assert.equal(ledgers.readCoverage().length, 5, "both batches checkpointed");
	});

	it("a LINK-APPEND carries its proposition's anchor into the existing node's provenance", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const existingId = "n_anchor_existing";
		ledgers.appendNode({
			id: existingId,
			name: "Derivative",
			statement: "Derivatives measure rates of change",
			aliases: [],
			createdAt: "2026-08-01T00:00:00.000Z",
			provenance: [],
		});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", anchored("a2")),
			auditor: submitModel("submit_review", { links: [{ id: "p1", linkTo: existingId }] }),
		});
		await pipeline.runExtraction(chatId);
		const appended = ledgers
			.readNodes()
			.filter((n) => n.id === existingId)
			.find((line) => line.provenance.some((pt) => pt.chatId === chatId))!;
		assert.deepEqual(appended.provenance, [{ chatId, messageId: "a2" }]);
		const merged = getGraph(ledgers).nodes.find((n) => n.id === existingId)!;
		assert.ok(merged.provenance.some((pt) => pt.chatId === chatId && pt.messageId === "a2"));
	});

	it("the notes door stays anchor-free: no messageId required — and a stray one never reaches provenance", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", NOTES_FINDINGS),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.importNotes({ filePath: "/vault/anchor-free.md", text: NOTES_TEXT }), { nodes: 1, chains: 0 });
		assert.deepEqual(
			ledgers.readNodes()[0]!.provenance,
			[{ chatId: ledgers.readSources()[0]!.id, messageId: "" }],
			"notes provenance stays chat-level — the file is the anchor",
		);

		const stray = {
			propositions: [{ ...NOTES_FINDINGS.propositions[0], messageId: "made_up" }],
			chains: [],
		};
		const second = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", stray),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await second.importNotes({ filePath: "/vault/stray-anchor.md", text: NOTES_TEXT }), { nodes: 1, chains: 0 });
		const secondSource = ledgers.readSources()[1]!;
		const strayNode = ledgers.readNodes().find((n) => n.provenance.some((pt) => pt.chatId === secondSource.id))!;
		assert.deepEqual(strayNode.provenance, [{ chatId: secondSource.id, messageId: "" }], "the stray anchor was stripped before the merger");
	});

	it("coverage fingerprints are UNCHANGED by the anchors: the stored fps equal the plain coverage-slot hashes", async () => {
		const { chatId, record } = chunkyChat();
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			getChunkTokens: () => 4096,
			extractor: fauxEngine([findingsStep(), findingsStep()]),
			auditor: fauxEngine([passThroughAuditStep(), passThroughAuditStep()]),
		});
		await pipeline.runExtraction(chatId);
		assert.deepEqual(
			ledgers.readCoverage().map((c) => c.fp).sort(),
			coverageSlots(record.messages).map((slot) => slot.fp).sort(),
		);
		assert.equal(coverageOf(record.messages, ledgers.readCoverage(), chatId).uncoveredCount, 0);
	});
});

const NOTES_TEXT = `> [!quote] YOU
> teach me vim

> [!abstract] PI
> Vim always starts in Normal mode — keys are commands, not text.`;

const NOTES_FINDINGS = {
	propositions: [
		{
			id: "p1",
			name: "Vim normal mode",
			statement: "Vim starts in Normal mode, where keys are commands.",
			aliases: [],
		},
	],
	chains: [],
} as const;

const NOTES_VERDICT = {
	links: [],
	edges: [],
} as const;

describe("the extractor redesign (owner, 2026-09-30): chains are the deliverable", () => {
	function retryEngine(bad: unknown, good: unknown): PiEngine {
		return fauxEngine([
			() =>
				fauxAssistantMessage([fauxToolCall("submit_findings", bad as ToolCall["arguments"], { id: "findings-bad" })], {
					stopReason: "toolUse",
				}),
			() =>
				fauxAssistantMessage([fauxToolCall("submit_findings", good as ToolCall["arguments"], { id: "findings-good" })], {
					stopReason: "toolUse",
				}),
		]);
	}

	it("co-premises ride as ONE stored argument — the fan-out to arrows is the derived view, not the store", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = submitModel("submit_findings", {
			propositions: [
				{ id: "p1", name: "A", statement: "A holds.", aliases: [], messageId: "a1" },
				{ id: "p2", name: "B", statement: "B holds.", aliases: [], messageId: "a2" },
				{ id: "p3", name: "C", statement: "A and B together entail C.", aliases: [], messageId: "a1" },
			],
			chains: [{ premises: ["p1", "p2"], conclusion: "p3" }],
		});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 3, chains: 1 });
		const byName = new Map(ledgers.readNodes().map((n) => [n.name, n.id]));
		const conclusion = byName.get("C")!;
		const chains = ledgers.readChains();
		assert.ok(chains.every((c) => c.conclusion === conclusion), "chains point INTO the conclusion");
		assert.deepEqual(
			chains.flatMap((c) => c.premises).sort(),
			[byName.get("A")!, byName.get("B")!].sort(),
		);
	});

	it("two chains sharing a conclusion union their premises; a bare proposition stays an edge-less node", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = submitModel("submit_findings", {
			propositions: [
				{ id: "p1", name: "A", statement: "A holds.", aliases: [], messageId: "a1" },
				{ id: "p2", name: "B", statement: "B holds.", aliases: [], messageId: "a2" },
				{ id: "p3", name: "C", statement: "C follows.", aliases: [], messageId: "a1" },
				{ id: "p4", name: "Lonely", statement: "A bare proposition no argument uses.", aliases: [], messageId: "a2" },
			],
			chains: [
				{ premises: ["p1"], conclusion: "p3" },
				{ premises: ["p2"], conclusion: "p3" },
			],
		});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 4, chains: 2 });
		const lonely = ledgers.readNodes().find((n) => n.name === "Lonely")!;
		assert.ok(ledgers.readChains().every((c) => !c.premises.includes(lonely.id) && c.conclusion !== lonely.id));
	});

	it("identical chains dedupe SILENTLY at the expansion — restating an argument is a no-op, not an error", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const extractor = submitModel("submit_findings", {
			...FINDINGS,
			chains: [FINDINGS.chains[0]!, FINDINGS.chains[0]!],
		});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 1 });
	});

	it("the OLD wire shape (an edges array, no chains) is dead: validation fails every turn — nothing merges", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const oldShape = () =>
			fauxEngine(
				Array.from({ length: 4 }, () => () =>
					fauxAssistantMessage(
						[
							fauxToolCall(
								"submit_findings",
								{
									propositions: FINDINGS.propositions,
									edges: [{ from: "p1", to: "p2", type: "follows" }],
								} as unknown as ToolCall["arguments"],
							),
						],
						{ stopReason: "toolUse" },
					),
				),
			);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			engineFor: (role) => (role === "extractor" ? oldShape() : submitModel("submit_review", { links: [] })),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 0, chains: 0 });
	});

	it("validate error-back: a chain referencing an UNKNOWN id is rejected, the model re-submits clean", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const bad = {
			...FINDINGS,
			chains: [{ premises: ["p1", "p9"], conclusion: "p2" }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: retryEngine(bad, FINDINGS),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 1 });
	});

	it("validate error-back: a conclusion in its OWN premises is rejected, the model re-submits clean", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const bad = {
			...FINDINGS,
			chains: [{ premises: ["p1", "p2"], conclusion: "p2" }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: retryEngine(bad, FINDINGS),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 1 });
	});

	it("empty premises never pass: the schema's minItems rejects, the model re-submits clean", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const bad = {
			...FINDINGS,
			chains: [{ premises: [], conclusion: "p2" }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: retryEngine(bad, FINDINGS),
			auditor: submitModel("submit_review", { links: [] }),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 2, chains: 1 });
	});

	it("the system prompt is goal-first: ONE shared core, both preambles assembled onto it", () => {
		assert.match(EXTRACTION_CORE, /JOINTLY entail a conclusion/);
		assert.match(EXTRACTION_CORE, /for the same conclusion are separate chains/);
		assert.match(EXTRACTION_CORE, /Entailment is the only link that earns a\s+chain/);
		assert.match(EXTRACTION_CORE, /what a reference on it would teach/);
		assert.match(EXTRACTION_CORE, /stand\s+alone for a reader who never saw this source/);
		assert.match(EXTRACTION_CORE, /may not lean on the source's own\s+scaffolding/);
		assert.match(EXTRACTION_CORE, /SUBMIT with one submit_findings call/);
		assert.match(EXTRACTION_CORE, /"chains": \[\] when the source makes no\s+arguments/);
		assert.match(EXTRACTION_CORE, /THE GOAL: uncover the source's CORE IDEAS/);
		assert.match(EXTRACTION_CORE, /everything derives from the foundations/);
		assert.match(EXTRACTION_CORE, /build\s+on it\./);

		assert.ok(EXTRACTOR_INSTRUCTIONS.startsWith(SESSION_PREAMBLE));
		assert.ok(EXTRACTOR_INSTRUCTIONS.includes(EXTRACTION_CORE));
		assert.ok(NOTES_EXTRACTOR_INSTRUCTIONS.startsWith(NOTES_PREAMBLE));
		assert.ok(NOTES_EXTRACTOR_INSTRUCTIONS.includes(EXTRACTION_CORE), "the notes extractor shares the core by construction");

		assert.equal(
			SESSION_MESSAGE_ID_RULE,
			"For each new proposition, copy the message ID of the passage that most directly states or explains it into messageId.",
		);
		assert.ok(EXTRACTOR_INSTRUCTIONS.includes(SESSION_MESSAGE_ID_RULE), "the session instructions carry the rule");
		assert.ok(!NOTES_EXTRACTOR_INSTRUCTIONS.includes("messageId"), "the notes prompt never mentions message ids");

		assert.notEqual(SESSION_PREAMBLE, NOTES_PREAMBLE);
		assert.match(SESSION_PREAMBLE, /a teaching\s+session, rendered as the teacher's prose in reading order/);
		assert.match(NOTES_PREAMBLE, /the\s+author's personal notes, rendered in reading order/);

		for (const prompt of [EXTRACTOR_INSTRUCTIONS, NOTES_EXTRACTOR_INSTRUCTIONS]) {
			assert.doesNotMatch(prompt, /DROP:/);
			assert.doesNotMatch(prompt, /MERGE YOUR OWN OUTPUT/);
			assert.doesNotMatch(prompt, /WHEN IN DOUBT, OMIT/);
			assert.doesNotMatch(prompt, /Faithfulness:/);
			assert.doesNotMatch(prompt, /follows\/supports/);
		}
	});
});

describe("the notes front door (importNotes — format-agnostic)", () => {
	it("imports raw notes end to end: source record, file-scoped provenance", async () => {
		const ledgers = memoryLedgers();
		const seen: { kind?: string; label?: string }[] = [];
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", NOTES_FINDINGS),
			auditor: submitModel("submit_review", NOTES_VERDICT, () => {
				const run = extractionStatuses().find((r) => r.chatId.startsWith("src_"));
				seen.push({ kind: run?.kind, label: run?.label });
			}),
		});
		const stats = await pipeline.importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });

		assert.deepEqual(stats, { nodes: 1, chains: 0 });
		assert.deepEqual(seen, [{ kind: "notes", label: "/vault/learn vim.md" }]);
		assert.equal(extractionStatuses().length, 0, "the registry clears when the run ends");

		const source = ledgers.readSources()[0]!;
		assert.match(source.id, /^src_/);
		assert.equal(source.filePath, "/vault/learn vim.md");
		assert.ok(Date.parse(source.importedAt));
		assert.equal(source.extractions?.length, 1, "the run's usage persisted into the source record");
		assert.equal(source.extractions![0]!.stats?.nodes, 1);
		assert.ok(source.extractions![0]!.stages.extractor.steps.length > 0, "faux usage captured");

		const node = ledgers.readNodes()[0]!;
		assert.equal(node.statement, "Vim starts in Normal mode, where keys are commands.");
		assert.deepEqual(node.provenance, [{ chatId: source.id, messageId: "" }]);
		assert.equal(ledgers.readCheckpoints()[0]!.chatId, source.id);
	});

	it("chunks a large file: one extract→audit→merge per chunk, part headers in each view (owner, 2026-09-28)", async () => {
		const ledgers = memoryLedgers();
		const views: string[] = [];
		let calls = 0;
		const extractorStep = () =>
			fauxEngine([
				(context) => {
					calls++;
					views.push(capturedView(context));
					return fauxAssistantMessage(
						[
							fauxToolCall("submit_findings", NOTES_FINDINGS as unknown as ToolCall["arguments"], {
								id: `findings-${calls}`,
							}),
						],
						{ stopReason: "toolUse" },
					);
				},
			]);
		const text = Array.from({ length: 8 }, (_, i) => `note line ${i}: ${"x".repeat(30)}`).join("\n");
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			engineFor: (role) =>
				role === "extractor"
					? extractorStep()
						: submitModel("submit_review", { links: [] }),
			getChunkTokens: () => 20,
		});
		const stats = await pipeline.importNotes({ filePath: "/vault/big.md", text });

		assert.ok(calls >= 2, `expected ≥2 extractor calls, got ${calls}`);
		assert.match(views[0]!, new RegExp(`part 1/${calls}`));
		assert.match(views.at(-1)!, new RegExp(`part ${calls}/${calls}`));
		assert.deepEqual(stats, { nodes: calls, chains: 0 });
		assert.equal(ledgers.readNodes().length, calls);
	});

	it("required top-level fields (owner, 2026-09-28; chains since 2026-09-30): a findings submit MISSING chains fails validation — no silent structure-less merge", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const noEdges = () =>
			fauxEngine(
				Array.from({ length: 4 }, () => (context) => {
					void context;
					return fauxAssistantMessage(
						[fauxToolCall("submit_findings", { propositions: FINDINGS.propositions } as unknown as ToolCall["arguments"])],
						{ stopReason: "toolUse" },
					);
				}),
			);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			engineFor: (role) => (role === "extractor" ? noEdges() : submitModel("submit_review", { links: [] })),
		});
		assert.deepEqual(await pipeline.runExtraction(chatId), { nodes: 0, chains: 0 });
		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readCoverage().length, 0, "nothing checkpointed — the messages stay re-runnable");
	});

	it("every explicit import runs the whole file, even identical text and legacy fingerprints", async () => {
		const ledgers = memoryLedgers();
		const mk = () =>
			createExtractionPipeline({
				chatStore,
				graphStore: ledgers,
					extractor: submitModel("submit_findings", NOTES_FINDINGS),
				auditor: submitModel("submit_review", NOTES_VERDICT),
			});
		const first = await mk().importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });
		assert.deepEqual(first, { nodes: 1, chains: 0 });

		ledgers.upsertSource({ ...ledgers.readSources()[0]!, contentFp: createHash("sha256").update(NOTES_TEXT).digest("hex").slice(0, 16) });
		const second = await mk().importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });
		assert.deepEqual(second, { nodes: 1, chains: 0 }, "identical content re-extracts");
		assert.equal(ledgers.readSources()[0]!.contentFp, undefined, "new imports write no fingerprint");

		assert.equal(ledgers.readSources().length, 1, "one source identity — the path hashes to the same id");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2, "both runs bill usage");
		assert.equal(ledgers.readNodes().length, 2, "the auditor, not a content skip, owns identity");

		const third = await mk().importNotes({ filePath: "/vault/learn vim.md", text: `${NOTES_TEXT}\nA new closing line.` });
		assert.deepEqual(third, { nodes: 1, chains: 0 }, "changed content re-extracts");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 3, "the re-run bills its usage");
		assert.equal(ledgers.readNodes().length, 3);
	});

	it("aborts like a chat run: true cancellation, nothing merged, partial usage in the source record", async () => {
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: hangingModel(),
			auditor: submitModel("submit_review", NOTES_VERDICT),
		});
		const runPromise = pipeline.importNotes({ filePath: "/vault/learn vim.md", text: NOTES_TEXT });

		const srcId = extractionStatuses().find((r) => r.chatId.startsWith("src_"))!.chatId;
		assert.equal(abortExtraction(srcId), true);
		await assert.rejects(runPromise, (error) => error instanceof NotesImportError && error.outcome === "aborted" && error.partialStats.nodes === 0);
		assert.equal(ledgers.readNodes().length, 0, "nothing merged");
		assert.equal(ledgers.readCheckpoints().length, 0, "nothing checkpointed");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 1, "partial usage still persisted");
		assert.equal(ledgers.readSources()[0]!.extractions![0]!.stats, undefined, "never merged → no stats");
	});
});

function capturedView(context: unknown): string {
	const messages = (context as { messages?: { role: string; content: string }[] }).messages ?? [];
	const last = [...messages].reverse().find((m) => m.role === "user");
	return typeof last?.content === "string" ? last.content : "";
}

function findingsStep(capture?: (view: string) => void): FauxResponseStep {
	return (context) => {
		const view = capturedView(context);
		capture?.(view);
		const anchor = /TEACHER \[([^\]]+)\]/.exec(view)?.[1] ?? "a1";
		const submit = {
			...FINDINGS,
			propositions: FINDINGS.propositions.map((p) => ({ ...p, messageId: anchor })),
		};
		return fauxAssistantMessage(
			[fauxToolCall("submit_findings", submit as unknown as ToolCall["arguments"], { id: "findings-call" })],
			{ stopReason: "toolUse" },
		);
	};
}

function passThroughAuditStep(): FauxResponseStep {
	return () =>
		fauxAssistantMessage(
			[
				fauxToolCall(
					"submit_review",
					{
						links: [],
						edges: [],
					} as unknown as ToolCall["arguments"],
					{ id: "review-call" },
				),
			],
			{ stopReason: "toolUse" },
		);
}

function chunkyChat() {
	const chat = chatStore.createChat("Chunky coverage fixture");
	createdChats.push(chat.id);
	chatStore.saveMessages(
		chat.id,
		[1, 2, 3, 4, 5].flatMap((n) => assistant(`a${n}`, [{ type: "text", text: `topic ${n}: ${"detail ".repeat(700)}${n}` }])),
	);
	return { chatId: chat.id, record: chatStore.getChat(chat.id)! };
}

describe("the chunked pipeline (extraction coverage)", () => {
	it("extracts uncovered messages in token-budgeted batches, checkpoints coverage per batch, and no-ops once covered", async () => {
		const { chatId, record } = chunkyChat();
		const ledgers = memoryLedgers();
		const views: string[] = [];

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			getChunkTokens: () => 4096,
			extractor: fauxEngine([findingsStep((v) => views.push(v)), findingsStep((v) => views.push(v))]),
			auditor: fauxEngine([passThroughAuditStep(), passThroughAuditStep()]),
		});
		const stats = await pipeline.runExtraction(chatId);

		assert.equal(views.length, 2, "one extractor call per batch");
		assert.ok(views[0]!.includes("topic 1:") && views[0]!.includes("topic 3:"), "teacher prose only, first three");
		assert.ok(!views[0]!.includes("topic 4:"), "the batch stops at the token budget");
		assert.ok(views[1]!.includes("topic 4:") && views[1]!.includes("topic 5:"));
		assert.ok(!views[1]!.includes("topic 3:"));
		assert.doesNotMatch(views[0]!, /### /, "no speaker headers — passages are TEACHER [id] lines");
		assert.ok(views[0]!.startsWith("# Chunky coverage fixture"));
		assert.match(views[0]!, /^TEACHER \[a1\] topic 1:/m);
		assert.match(views[0]!, /^TEACHER \[a3\] topic 3:/m);
		assert.doesNotMatch(views[0]!, /TEACHER \[a4\]/);
		assert.match(views[1]!, /^TEACHER \[a4\] topic 4:/m);
		assert.match(views[1]!, /^TEACHER \[a5\] topic 5:/m);

		assert.deepEqual(stats, { nodes: 4, chains: 2 });

		const coverage = ledgers.readCoverage();
		assert.equal(coverage.length, record.messages.length);
		assert.equal(ledgers.readCheckpoints().length, 0);
		assert.equal(coverageOf(record.messages, coverage, chatId).uncoveredCount, 0);

		const before = views.length;
		const again = await pipeline.runExtraction(chatId);
		assert.deepEqual(again, { nodes: 0, chains: 0 });
		assert.equal(views.length, before);
		assert.equal(chatStore.getChat(chatId)!.extractions?.length, 2, "one usage record per batch job; the no-op run persists none");
	});

	it("aborting after a merged batch keeps it covered; the re-run extracts only the remainder", async () => {
		const { chatId, record } = chunkyChat();
		const ledgers = memoryLedgers();
		const views: string[] = [];

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			getChunkTokens: () => 4096,
			extractor: fauxEngine([
				findingsStep((v) => views.push(v)),
				(_context, options) =>
					new Promise((resolve) => {
						const sig = options?.signal;
						if (sig?.aborted) {
							resolve(fauxAssistantMessage("late"));
							return;
						}
						sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
					}),
			]),
			auditor: fauxEngine([passThroughAuditStep()]),
		});
		const runPromise = pipeline.runExtraction(chatId);
		await new Promise<void>((resolve) => {
			const check = setInterval(() => {
				if (ledgers.readCoverage().length > 0) {
					clearInterval(check);
					resolve();
				}
			}, 5);
		});
		assert.equal(abortExtraction(chatId), true);
		const stats = await runPromise;

		assert.deepEqual(stats, { nodes: 2, chains: 1 });
		assert.equal(ledgers.readCoverage().length, 3, "batch 1 checkpointed its three messages");
		const cov = coverageOf(record.messages, ledgers.readCoverage(), chatId);
		assert.equal(cov.uncoveredCount, 2, "the in-flight batch's messages stay uncovered");

		const reRunViews: string[] = [];
		const finisher = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: fauxEngine([findingsStep((v) => reRunViews.push(v))]),
			auditor: fauxEngine([passThroughAuditStep()]),
		});
		await finisher.runExtraction(chatId);
		assert.equal(reRunViews.length, 1);
		assert.ok(reRunViews[0]!.includes("topic 4:") && reRunViews[0]!.includes("topic 5:"));
		assert.ok(!reRunViews[0]!.includes("topic 1:"), "the covered remainder never re-enters the prompt");
		assert.equal(ledgers.readCoverage().length, 5, "the re-run closed the gap");
	});

	it("a re-opened message re-extracts alone; a data-part attach never re-opens it", async () => {
		const chat = chatStore.createChat("Re-open fixture");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [
			...assistant("s1", [{ type: "text", text: "short topic one" }]),
			...assistant("s2", [{ type: "text", text: "short topic two" }]),
		].flat());
		const chatId = chat.id;
		const ledgers = memoryLedgers();
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: fauxEngine([findingsStep()]),
			auditor: fauxEngine([passThroughAuditStep()]),
		});
		await pipeline.runExtraction(chatId);
		const record = () => chatStore.getChat(chatId)!.messages;
		const messages = () => record();
		assert.equal(coverageOf(messages(), ledgers.readCoverage(), chatId).uncoveredCount, 0);

		chatStore.saveMessages(chatId, [
			...record(),
			newPlanBlockMessage("call_s2", { kind: "full", at: "2026-09-26T00:00:00.000Z", current: null, nodes: [], edges: [] }),
		]);
		const afterAttach = coverageOf(messages(), ledgers.readCoverage(), chatId);
		assert.equal(afterAttach.uncoveredCount, 0, "data parts don't change the fingerprint");

		const mutated = record().map((m) =>
			(m as { id?: string }).id === "s1"
				? ({ ...m, content: [...(m as { content: unknown[] }).content, { type: "text", text: "the answer merged in late" }] } as never)
				: m,
		);
		chatStore.saveMessages(chatId, mutated);
		const afterMerge = coverageOf(messages(), ledgers.readCoverage(), chatId);
		assert.equal(afterMerge.uncoveredCount, 1, "only the mutated message re-opens");

		const reRunViews: string[] = [];
		const reOpener = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: fauxEngine([findingsStep((v) => reRunViews.push(v))]),
			auditor: fauxEngine([passThroughAuditStep()]),
		});
		await reOpener.runExtraction(chatId);
		assert.equal(reRunViews.length, 1, "one batch: the single re-opened message");
		assert.ok(reRunViews[0]!.includes("the answer merged in late") && !reRunViews[0]!.includes("short topic two"));
		assert.ok(reRunViews[0]!.includes("short topic one"), "the re-opened message renders its full prose");
		assert.equal(coverageOf(messages(), ledgers.readCoverage(), chatId).uncoveredCount, 0, "re-covered");
	});
});

describe("per-chunk parallel jobs (owner, 2026-09-28)", () => {
	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

	const wideText = () =>
		Array.from({ length: 8 }, (_, i) => `note ${i}: ${"x".repeat(90)}`).join("\n");

	it("one job per chunk, SERIALIZED per source: the registry shows one live row at a time, and a source-wide abort ends the run", async () => {
		const ledgers = memoryLedgers();
		const abortingStep: FauxResponseStep = (_context, options) =>
			new Promise((_resolve, reject) => {
				const sig = options?.signal;
				const die = () => {
					const err = new Error("aborted");
					err.name = "AbortError";
					reject(err);
				};
				if (sig?.aborted) die();
				else sig?.addEventListener("abort", die, { once: true });
			});
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			engineFor: (role) =>
				role === "extractor" ? fauxEngine([abortingStep]) : submitModel("submit_review", { links: [] }),
			getChunkTokens: () => 20,
		});
		const runPromise = pipeline.importNotes({ filePath: "/vault/parallel.md", text: wideText() });

		const srcId = extractionStatuses().find((r) => r.chatId.startsWith("src_"))!.chatId;
		await until(() => extractionStatuses().some((r) => r.chatId === srcId && r.phase === "extracting"), 500);
		const rows = extractionStatuses().filter((r) => r.chatId === srcId);
		assert.equal(rows.length, 1, "one live row — the source's chunks run strictly in order");
		assert.equal(rows[0]!.phase, "extracting");
		assert.deepEqual(rows[0]!.part, { i: 1, n: 8 }, "the row carries its part");

		assert.equal(abortExtraction(srcId), true);
		await assert.rejects(runPromise, (error) => error instanceof NotesImportError && error.outcome === "aborted");
		assert.equal(extractionStatuses().filter((r) => r.chatId === srcId).length, 0, "all rows leave the registry");
		assert.equal(ledgers.readNodes().length, 0, "nothing merged");
		const source = ledgers.readSources().find((src) => src.id === srcId)!;
		assert.equal(source.extractions?.length, 1, "only the aborted job bills — later chunks never ran");
		assert.ok(source.extractions!.every((entry) => entry.stats === undefined), "no job merged — no stats");
	});

	it("parallel extracts, serialized audits: extractor concurrency peaks at the cap, the auditor NEVER overlaps", async () => {
		const ledgers = memoryLedgers();
		let extractInFlight = 0;
		let extractPeak = 0;
		let auditInFlight = 0;
		let auditPeak = 0;
		const findingsMessage = fauxAssistantMessage(
			[fauxToolCall("submit_findings", FINDINGS as unknown as ToolCall["arguments"], { id: "findings-call" })],
			{ stopReason: "toolUse" },
		);
		const reviewMessage = fauxAssistantMessage(
			[fauxToolCall("submit_review", { links: [] } as unknown as ToolCall["arguments"], { id: "review-call" })],
			{ stopReason: "toolUse" },
		);
		const slowExtract: FauxResponseStep = async () => {
			extractInFlight++;
			extractPeak = Math.max(extractPeak, extractInFlight);
			await sleep(5);
			extractInFlight--;
			return findingsMessage;
		};
		const slowAudit: FauxResponseStep = async () => {
			auditInFlight++;
			auditPeak = Math.max(auditPeak, auditInFlight);
			await sleep(5);
			auditInFlight--;
			return reviewMessage;
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			engineFor: (role) =>
				role === "extractor" ? fauxEngine([slowExtract]) : fauxEngine([slowAudit]),
			getChunkTokens: () => 20,
		});
		const stats = await pipeline.importNotes({ filePath: "/vault/parallel-2.md", text: wideText() });

		assert.equal(extractPeak, 1, "one source, one extract at a time — strict order");
		assert.equal(auditPeak, 1, "audits serialize behind the gate — never two at once");
		assert.deepEqual(stats, { nodes: 16, chains: 8 });
		assert.equal(ledgers.readNodes().length, 16);
	});
});

describe("the session-deletion guard (chat deleted mid-run)", () => {
	it("a run whose chat dies mid-extraction aborts at the merge with nothing merged, checkpointed, or billed", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();

		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", FINDINGS),
			auditor: submitModel("submit_review", { links: [] }, () => chatStore.deleteChat(chatId)),
		});
		const stats = await pipeline.runExtraction(chatId);

		assert.ok(stats);
		assert.equal(stats.nodes, 0);
		assert.equal(stats.chains, 0);

		assert.equal(ledgers.readNodes().length, 0);
		assert.equal(ledgers.readChains().length, 0);
		assert.equal(ledgers.readCoverage().length, 0);
		assert.equal(ledgers.readCheckpoints().length, 0);

		assert.equal(extractionStatuses().some((run) => run.chatId === chatId), false);
		assert.equal(chatStore.getChat(chatId), null);
	});
});

describe("digest-aware serialized extraction (the extractor is the assembler)", () => {
	it("the system prompt is goal-first: core ideas, foundations direction, build-on-the-digest doctrine", () => {
		assert.match(EXTRACTION_CORE, /THE GOAL: uncover the source's CORE IDEAS and show how everything derives from the foundations/);
		assert.match(EXTRACTION_CORE, /JOINTLY entail a conclusion/);
		assert.match(EXTRACTION_CORE, /[Ee]ntailment is the\s+only link that earns a\s+chain/);
		assert.match(EXTRACTION_CORE, /examples,\s+notation glosses, and restatements that no argument needs are not core ideas/);
		assert.match(EXTRACTION_CORE, /build\s+on it\. Reference an existing idea by its id/);
		assert.match(EXTRACTION_CORE, /OR existing ids from THE GRAPH SO FAR, verbatim/);
		assert.ok(EXTRACTOR_INSTRUCTIONS.includes(EXTRACTION_CORE));
		assert.ok(NOTES_EXTRACTOR_INSTRUCTIONS.includes(EXTRACTION_CORE));
		assert.match(SESSION_PREAMBLE, /building on everything already extracted from this source/);
		assert.match(NOTES_PREAMBLE, /building on everything already extracted from this source/);
	});

	it("sourceDigest renders the same-source truth (ids verbatim) and stays empty for a barren source", () => {
		const seed = (id: string, name: string, chatId: string): GraphNode => ({
			id,
			name,
			statement: `statement of ${name}`,
			aliases: [],
			createdAt: "2026-09-30T00:00:00.000Z",
			provenance: [{ chatId, messageId: "" }],
		});
		const chain = (id: string, premises: string[], conclusion: string, chatId: string): GraphChain => ({
			id,
			premises,
			conclusion,
			createdAt: "2026-09-30T00:00:01.000Z",
			provenance: [{ chatId, messageId: "" }],
		});
		const graph = {
			nodes: [seed("n_a", "Self-ownership", "src_1"), seed("n_x", "Foreign key", "src_2")],
			chains: [chain("arg_1", ["n_a"], "n_x", "src_2")],
			sessions: {},
			sources: {},
		} as unknown as Parameters<typeof sourceDigest>[0];
		assert.equal(sourceDigest(graph, "src_9"), "", "a source owning nothing runs bare — no digest block");
		const digest = sourceDigest(graph, "src_1");
		assert.match(digest, /THE GRAPH SO FAR/);
		assert.match(digest, /n_a \| Self-ownership \| statement of Self-ownership/);
		assert.doesNotMatch(digest, /Foreign key/, "other sources' material never leaks into the digest");
		assert.doesNotMatch(digest, /DERIVATIONS ALREADY RECORDED/, "no same-source chains → no chain block");
	});

	it("a seeded digest rides the extractor's view: mixed-namespace chains reference existing ids VERBATIM", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const seed = (id: string, name: string): GraphNode => ({
			id,
			name,
			statement: `statement of ${name}`,
			aliases: [],
			createdAt: "2026-09-30T00:00:00.000Z",
			provenance: [{ chatId, messageId: "m0" }],
		});
		ledgers.appendNode(seed("n_a", "Self-ownership"));
		const FINDINGS_B: SessionFindings = {
			propositions: [{ id: "p1", name: "Appropriation axiom", statement: "c", aliases: [], messageId: "a1" }],
			chains: [{ premises: ["n_a", "p1"], conclusion: "p1", }].slice(0, 0),
		};
		const views: string[] = [];
		const extractor = fauxEngine([
			(context) => {
				views.push(capturedView(context));
				const submit = {
					propositions: FINDINGS_B.propositions,
					chains: [{ premises: ["n_a", "p1"], conclusion: "p1b" }],
				};
				submit.propositions.push({ id: "p1b", name: "Property rights", statement: "d", aliases: [], messageId: "a2" });
				return fauxAssistantMessage([fauxToolCall("submit_findings", submit as unknown as ToolCall["arguments"], { id: "f1" })], { stopReason: "toolUse" });
			},
		]);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor: submitModel("submit_review", { links: [] }),
		});
		const stats = await pipeline.runExtraction(chatId);

		assert.match(views[0]!, /THE GRAPH SO FAR/);
		assert.match(views[0]!, /n_a \| Self-ownership/);

		assert.deepEqual(stats, { nodes: 2, chains: 1 });
		const stored = ledgers.readChains();
		assert.equal(stored.length, 1);
		const byName = new Map(ledgers.readNodes().map((n) => [n.name, n.id]));
		assert.deepEqual(stored[0]!.premises, ["n_a", byName.get("Appropriation axiom")]);
		assert.equal(stored[0]!.conclusion, byName.get("Property rights"));
	});

	it("a chain endpoint that resolves NOWHERE is refused with the problem and the retry merges (error-back)", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const badThenGood = fauxEngine([
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall(
							"submit_findings",
							{ propositions: [], chains: [{ premises: ["n_nope"], conclusion: "also_nope" }] } as unknown as ToolCall["arguments"],
							{ id: "bad" },
						),
					],
					{ stopReason: "toolUse" },
				),
			() =>
				fauxAssistantMessage(
					[
						fauxToolCall(
							"submit_findings",
							{
								propositions: [{ id: "p1", name: "Axiom", statement: "s", aliases: [], messageId: "a1" }],
								chains: [],
							} as unknown as ToolCall["arguments"],
							{ id: "good" },
						),
					],
					{ stopReason: "toolUse" },
				),
		]);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: badThenGood,
			auditor: submitModel("submit_review", { links: [] }),
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.deepEqual(stats, { nodes: 1, chains: 0 }, "the refused attempt left nothing; the retry merged");
	});

	it("batches serialize: chunk 2's extractor starts only after chunk 1's audit ran (digest order, owner 2026-09-30 evening)", async () => {
		const { chatId } = chunkyChat();
		const ledgers = memoryLedgers();
		const events: string[] = [];
		let extractCalls = 0;
		let auditCalls = 0;
		const extractStep = (): FauxResponseStep => (context) => {
			extractCalls++;
			events.push(`extract${extractCalls}`);
			const anchor = /TEACHER \[([^\]]+)\]/.exec(capturedView(context))?.[1] ?? "a1";
			const submit = {
				...FINDINGS,
				propositions: FINDINGS.propositions.map((p) => ({ ...p, messageId: anchor })),
			};
			return fauxAssistantMessage(
				[fauxToolCall("submit_findings", submit as unknown as ToolCall["arguments"], { id: `f${extractCalls}` })],
				{ stopReason: "toolUse" },
			);
		};
		const auditStep = (): FauxResponseStep => () => {
			auditCalls++;
			events.push(`audit${auditCalls}`);
			return fauxAssistantMessage(
				[fauxToolCall("submit_review", { links: [] } as unknown as ToolCall["arguments"], { id: `r${auditCalls}` })],
				{ stopReason: "toolUse" },
			);
		};
		const extractor = fauxEngine([extractStep(), extractStep()]);
		const auditor = fauxEngine([auditStep(), auditStep()]);
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor,
			auditor,
			getChunkTokens: () => 4096,
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.deepEqual(events, ["extract1", "audit1", "extract2", "audit2"], "strict per-source order: extract → audit → merge → NEXT extract");
		assert.equal(stats.nodes, 4, "both batches merged (2 propositions each)");
	});
});

describe("chain simplification (the merger's maintenance pass, owner 2026-09-30 evening)", () => {
	const chain = (id: string, premises: string[], conclusion: string, createdAt: string): GraphChain => ({
		id,
		premises,
		conclusion,
		createdAt,
		provenance: [{ chatId: "src_1", messageId: "" }],
	});

	it("the owner example: [A,B]⇒X + [X,C]⇒Y make [A,B,C]⇒Y redundant (ancestry-cover)", () => {
		const kept = simplifyChains([
			chain("arg_3", ["n_a", "n_b", "n_c"], "n_y", "2026-09-30T03:00:00.000Z"),
			chain("arg_1", ["n_a", "n_b"], "n_x", "2026-09-30T01:00:00.000Z"),
			chain("arg_2", ["n_x", "n_c"], "n_y", "2026-09-30T02:00:00.000Z"),
		]);
		assert.deepEqual(kept.map((c) => c.id).sort(), ["arg_1", "arg_2"]);
	});

	it("prefer-fewest-premises: a strict premise-superset of a kept chain drops", () => {
		const kept = simplifyChains([
			chain("arg_1", ["n_a"], "n_z", "2026-09-30T01:00:00.000Z"),
			chain("arg_2", ["n_a", "n_b"], "n_z", "2026-09-30T02:00:00.000Z"),
		]);
		assert.deepEqual(kept.map((c) => c.id), ["arg_1"]);
	});

	it("genuinely different routes to one conclusion stand; a superset route yields to the lean one", () => {
		const kept = simplifyChains([
			chain("arg_1", ["n_a"], "n_y", "2026-09-30T01:00:00.000Z"),
			chain("arg_2", ["n_b"], "n_y", "2026-09-30T02:00:00.000Z"),
			chain("arg_3", ["n_c", "n_d"], "n_y", "2026-09-30T03:00:00.000Z"),
			chain("arg_4", ["n_a", "n_c"], "n_y", "2026-09-30T04:00:00.000Z"),
		]);
		assert.deepEqual(kept.map((c) => c.id).sort(), ["arg_1", "arg_2", "arg_3"]);
	});

	it("ancestry reaches transitively: [W]⇒A chains through [A,B]⇒X", () => {
		const kept = simplifyChains([
			chain("arg_1", ["n_w"], "n_a", "2026-09-30T01:00:00.000Z"),
			chain("arg_2", ["n_a", "n_b"], "n_x", "2026-09-30T02:00:00.000Z"),
			chain("arg_3", ["n_x", "n_c"], "n_y", "2026-09-30T03:00:00.000Z"),
			chain("arg_4", ["n_w", "n_b", "n_c"], "n_y", "2026-09-30T04:00:00.000Z"),
		]);
		assert.deepEqual(kept.map((c) => c.id).sort(), ["arg_1", "arg_2", "arg_3"]);
	});

	it("same-key provenance lines drop TOGETHER (a key is kept or dropped as a whole)", () => {
		const kept = simplifyChains([
			chain("arg_1", ["n_a"], "n_z", "2026-09-30T01:00:00.000Z"),
			{ ...chain("arg_1", ["n_a"], "n_z", "2026-09-30T01:00:00.000Z"), provenance: [{ chatId: "src_2", messageId: "" }] },
			chain("arg_2", ["n_a", "n_b"], "n_z", "2026-09-30T02:00:00.000Z"),
			{ ...chain("arg_2", ["n_a", "n_b"], "n_z", "2026-09-30T02:00:00.000Z"), provenance: [{ chatId: "src_2", messageId: "" }] },
		]);
		assert.deepEqual(kept.map((c) => c.id), ["arg_1", "arg_1"], "the superset key's every line went, the kept key's every line stayed");
	});

	it("the merge applies it live: a redundant arrival is skipped silently, stats count appends and drops", async () => {
		const { chatId } = fixtureChat();
		const ledgers = memoryLedgers();
		const seedNode = (id: string, name: string): GraphNode => ({
			id,
			name,
			statement: `statement of ${name}`,
			aliases: [],
			createdAt: "2026-09-30T00:00:00.000Z",
			provenance: [{ chatId, messageId: "m0" }],
		});
		for (const [id, name] of [
			["n_a", "A"],
			["n_b", "B"],
			["n_c", "C"],
			["n_x", "X"],
			["n_y", "Y"],
		] as const)
			ledgers.appendNode(seedNode(id, name));
		ledgers.appendChain(chain("arg_1", ["n_a", "n_b"], "n_x", "2026-09-30T01:00:00.000Z"));
		ledgers.appendChain(chain("arg_2", ["n_x", "n_c"], "n_y", "2026-09-30T02:00:00.000Z"));

		const redundant: SessionFindings = {
			propositions: [],
			chains: [{ premises: ["n_a", "n_b", "n_c"], conclusion: "n_y" }],
		};
		const pipeline = createExtractionPipeline({
			chatStore,
			graphStore: ledgers,
			extractor: submitModel("submit_findings", redundant),
			auditor: submitModel("submit_review", { links: [] }),
		});
		const stats = await pipeline.runExtraction(chatId);
		assert.equal(stats.chains, 1, "the append happened (stats count activity)");
		assert.equal(stats.droppedChains, 1, "the simplification pass then removed it (maintenance)");
		const stored = ledgers.readChains();
		assert.equal(stored.length, 2, "the ledger is back to the two lean chains");
	});
});


describe("notes import completion and retry reliability", () => {
	const input = { filePath: "reliability.md", text: NOTES_TEXT };
	const make = (graphStore: GraphStore, extractor = submitModel("submit_findings", NOTES_FINDINGS)) =>
		createExtractionPipeline({ chatStore, graphStore, extractor, auditor: submitModel("submit_review", NOTES_VERDICT) });
	const incomplete = (outcome: NotesImportError["outcome"], nodes: number) => (error: unknown) => {
		assert.ok(error instanceof NotesImportError);
		assert.equal(error.outcome, outcome);
		assert.equal(error.partialStats.nodes, nodes);
		return true;
	};

	it("failure followed by an unchanged retry really extracts and preserves both usage records", async () => {
		const ledgers = memoryLedgers();
		await assert.rejects(make(ledgers, silentModel()).importNotes(input), incomplete("failed", 0));
		assert.deepEqual(await make(ledgers).importNotes(input), { nodes: 1, chains: 0 });
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	it("zero new nodes and an empty file are successful, but the readiness gate still applies", async () => {
		const ledgers = memoryLedgers();
		assert.deepEqual(await make(ledgers, submitModel("submit_findings", { propositions: [], chains: [] })).importNotes(input), { nodes: 0, chains: 0 });
		assert.deepEqual(await make(ledgers).importNotes({ ...input, text: " \n" }), { nodes: 0, chains: 0 });
		await assert.rejects(createExtractionPipeline({ chatStore, graphStore: ledgers }).importNotes({ ...input, text: "" }), ModelsNotConfiguredError);
		await assert.rejects(createExtractionPipeline({ chatStore, graphStore: ledgers, extractor: submitModel("submit_findings", NOTES_FINDINGS), auditor: submitModel("submit_review", NOTES_VERDICT), providerKeyMissing: () => providerKeyMissing("openai", ["cheap"]) }).importNotes(input), ProviderKeyMissingError);
	});

	it("isolates an ordinary failed chunk, reports partial, and keeps earlier/later merges and usage", async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers, getChunkTokens: () => 1,
			engineFor: (role) => role === "auditor" ? submitModel("submit_review", NOTES_VERDICT) : fauxEngine([() => {
				calls++;
				if (calls === 2) throw new Error("synthetic failed chunk");
				return fauxAssistantMessage([fauxToolCall("submit_findings", NOTES_FINDINGS as unknown as ToolCall["arguments"])], { stopReason: "toolUse" });
			}]),
		});
		await assert.rejects(pipeline.importNotes({ ...input, text: "first chunk\nsecond chunk\nthird chunk" }), incomplete("partial", 2));
		assert.equal(calls, 3);
		assert.equal(ledgers.readNodes().length, 2);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 3);
	});

	it("an abort after an earlier merge stops later chunks without losing graph or billed usage", async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers, getChunkTokens: () => 1,
			engineFor: (role) => role === "auditor" ? submitModel("submit_review", NOTES_VERDICT) : submitModel("submit_findings", NOTES_FINDINGS, () => {
				calls++;
				if (calls === 2) abortExtraction(ledgers.readSources()[0]!.id);
			}),
		});
		await assert.rejects(pipeline.importNotes({ ...input, text: "first chunk\nsecond chunk\nthird chunk" }), incomplete("aborted", 1));
		assert.equal(calls, 2);
		assert.equal(ledgers.readNodes().length, 1);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	for (const abortAt of [1, 2]) it(`abort in chunk ${abortAt} survives a usage-persistence error and stops later chunks`, async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		let cancelled = false;
		let usageFailures = 0;
		const graphStore: GraphStore = { ...ledgers, appendSourceUsage: (id, entry) => {
			if (cancelled) { usageFailures++; throw new Error("synthetic usage persistence failure during abort"); }
			ledgers.appendSourceUsage(id, entry);
		} };
		const pipeline = createExtractionPipeline({
			chatStore, graphStore, getChunkTokens: () => 1,
			engineFor: (role) => role === "auditor" ? submitModel("submit_review", NOTES_VERDICT) : submitModel("submit_findings", NOTES_FINDINGS, () => {
				calls++;
				if (calls === abortAt) {
					cancelled = true;
					assert.equal(abortExtraction(ledgers.readSources()[0]!.id), true);
				}
			}),
		});
		const wholeFile = { ...input, text: "first chunk\nsecond chunk\nthird chunk" };
		await assert.rejects(pipeline.importNotes(wholeFile), (error) => {
			incomplete("aborted", abortAt - 1)(error);
			assert.match((error as NotesImportError).message, /synthetic usage persistence failure during abort/);
			return true;
		});
		assert.equal(calls, abortAt, "no later extractor runs with a fresh controller after cancellation");
		assert.equal(usageFailures, 1, "the aborted chunk attempted to persist usage and surfaced its failure");
		assert.equal(ledgers.readNodes().length, abortAt - 1, "earlier graph merges retained");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, abortAt - 1, "earlier usage retained");
		assert.equal(extractionStatuses().length, 0, "cancelled job row removed");
		assert.deepEqual(await make(ledgers).importNotes(wholeFile), { nodes: 1, chains: 0 }, "source exclusion released for an explicit unchanged whole-file retry");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, abortAt);
	});

	it("a usage-persistence error without an aborted signal remains an isolated failure and later chunks run", async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		const graphStore: GraphStore = { ...ledgers, appendSourceUsage: (id, entry) => {
			if (calls === 1) throw new Error("synthetic isolated usage failure");
			ledgers.appendSourceUsage(id, entry);
		} };
		const pipeline = createExtractionPipeline({
			chatStore, graphStore, getChunkTokens: () => 1,
			engineFor: (role) => role === "auditor" ? submitModel("submit_review", NOTES_VERDICT) : submitModel("submit_findings", NOTES_FINDINGS, () => { calls++; }),
		});
		await assert.rejects(pipeline.importNotes({ ...input, text: "first chunk\nsecond chunk\nthird chunk" }), (error) => {
			incomplete("partial", 3)(error);
			assert.match((error as NotesImportError).message, /synthetic isolated usage failure/);
			return true;
		});
		assert.equal(calls, 3, "ordinary cleanup failure does not imply cancellation");
		assert.equal(ledgers.readNodes().length, 3);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	it("overlapping identical or different contents are busy BEFORE source metadata changes, across pipeline instances", async () => {
		const ledgers = memoryLedgers();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let upserts = 0;
		const tracked = { ...ledgers, upsertSource: (source: NotesSource) => { upserts++; ledgers.upsertSource(source); } };
		const first = make(tracked, gatedSubmitModel("submit_findings", NOTES_FINDINGS, gate)).importNotes(input);
		const sourceBefore = structuredClone(ledgers.readSources());
		try {
			await assert.rejects(make(tracked).importNotes(input), incomplete("busy", 0));
			await assert.rejects(make(tracked).importNotes({ ...input, text: "changed" }), incomplete("busy", 0));
			assert.equal(upserts, 1, "busy calls cannot even attempt source metadata writes");
			assert.deepEqual(ledgers.readSources(), sourceBefore);
		} finally { release(); }
		await first;
		assert.deepEqual(await make(ledgers).importNotes(input), { nodes: 1, chains: 0 }, "lock released after lifecycle");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	it("a fulfilled zero-node chunk plus a failed chunk is partial, not failed or completed", async () => {
		const ledgers = memoryLedgers();
		let calls = 0;
		const pipeline = createExtractionPipeline({
			chatStore, graphStore: ledgers, getChunkTokens: () => 1,
			engineFor: (role) => role === "auditor" ? submitModel("submit_review", NOTES_VERDICT) : fauxEngine([() => {
				if (++calls === 2) throw new Error("synthetic failed chunk");
				return fauxAssistantMessage([fauxToolCall("submit_findings", { propositions: [], chains: [] })], { stopReason: "toolUse" });
			}]),
		});
		await assert.rejects(pipeline.importNotes({ ...input, text: "first chunk\nsecond chunk" }), incomplete("partial", 0));
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
	});

	it("a merger failure after a node append is incomplete without rolling back that write", async () => {
		const ledgers = memoryLedgers();
		const broken = { ...ledgers, appendCheckpoint: () => { throw new Error("synthetic checkpoint failure after node append"); } };
		await assert.rejects(make(broken).importNotes(input), incomplete("failed", 0));
		assert.equal(ledgers.readNodes().length, 1, "already appended graph write retained even though merge never returned stats");
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 1);
	});

	for (const seam of ["layout", "usage"] as const) it(`a post-merge ${seam} failure is not false success and reports committed stats`, async () => {
		const ledgers = memoryLedgers();
		const originalUsage = ledgers.appendSourceUsage;
		let failed = false;
		const broken: GraphStore = { ...ledgers,
			...(seam === "layout" ? { writePositions: () => { throw new Error("synthetic layout failure"); } } : {
				appendSourceUsage: (id, entry) => { if (!failed) { failed = true; throw new Error("synthetic usage failure"); } originalUsage(id, entry); },
			}),
		};
		await assert.rejects(make(broken).importNotes(input), incomplete("failed", 1));
		assert.equal(ledgers.readNodes().length, 1);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 1);
		await make(ledgers).importNotes(input);
	});

	it("source-upsert failure is typed and releases exclusion for retry", async () => {
		const ledgers = memoryLedgers();
		await assert.rejects(make({ ...ledgers, upsertSource: () => { throw new Error("synthetic metadata failure"); } }).importNotes(input), incomplete("failed", 0));
		await make(ledgers).importNotes(input);
	});

	for (const filePath of ["1.md", "1.1.md", "1 notes.md", "1.1 notes.md"]) it(`imports and repeats identical text for ${filePath}`, async () => {
		const ledgers = memoryLedgers();
		await make(ledgers).importNotes({ ...input, filePath });
		await make(ledgers).importNotes({ ...input, filePath });
		assert.equal(ledgers.readSources().length, 1);
		assert.equal(ledgers.readSources()[0]!.extractions?.length, 2);
		assert.equal(ledgers.readNodes().length, 2);
	});
});
