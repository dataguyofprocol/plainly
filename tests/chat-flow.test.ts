import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { handleChatInput, handleChatRequest } from "../src/server/chat-handler.ts";
import { effectiveSettings } from "../src/server/stores.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { deliverJobResult, setTurnRunner } from "../src/server/jobs.ts";
import { buildSubagentSteer } from "../src/core/contracts.ts";
import { abortTurn, runningTurn, settledTurnResponse } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { buildAnswer, dismissedAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { danglingQuestionOf, endsInDismissal, needsContinuation, newAnswerResult } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");
const steerRoute = await import("../app/api/chats/[id]/steer/route.ts");
import { PATHS } from "../config.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [
		{ label: "Venus" },
		{ label: "Mercury" },
		{ label: "Mars" },
	],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

function scriptedTeacher(steps: (calls: string[][]) => FauxResponseStep[]): {
	engine: PiEngine;
	calls: string[][];
} {
	const calls: string[][] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps(calls));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

function defaultLesson(calls: string[][]): FauxResponseStep[] {
	return [
		(context) => {
			calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage(
				[fauxThinking("Probe the basics first."), fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" })],
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage([fauxText("Right — Mercury it is.")]);
		},
	];
}

function agentFactory(engine: PiEngine): Parameters<typeof handleChatRequest>[1] {
	return (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages });
}

function gradedAnswer(input: typeof QUIZ_INPUT, values: string[]) {
	const options = normalizeOptions(input.options);
	const qd: QuestionData = {
		id: "call-1",
		kind: "quiz",
		question: input.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(input.correctAnswer, options).indices,
		explanation: input.explanation,
		createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values });
}

function eventsOf(body: string): Array<Record<string, any>> {
	const out: Array<Record<string, any>> = [];
	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
		out.push(JSON.parse(line.slice(6)));
	}
	return out;
}

async function drain(res: Response): Promise<string> {
	if (res.status !== 200) {
		assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	}
	return res.text();
}

async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<string> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) {
		assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	}
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (!handle)
		return "";
	return new Response(handle.subscribe()).text();
}

async function drainRunning(chatId: string): Promise<string> {
	const handle = runningTurn(chatId);
	if (!handle) assert.fail(`no running turn to drain: ${chatId}`);
	return new Response(handle.subscribe()).text();
}

function waitFor(cond: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

function gatedTeacher(gate: Promise<void>): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxText("Gated reply.")]);
		},
	]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function abortableTeacher(): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses([
		((_ctx: unknown, opts: { signal?: AbortSignal } | undefined) =>
			new Promise((resolve) => {
				const sig = opts?.signal;
				if (sig?.aborted) return resolve(fauxAssistantMessage("late"));
				sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
			})) as unknown as FauxResponseStep,
	]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

function dismissPost(chatId: string, toolCallId: string, kind: "quiz" | "ask" | "explain" = "quiz"): Promise<Response> {
	return dismissRoute.POST(
		new Request(`http://test/api/chats/${chatId}/dismiss`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				input: { type: "dismiss", toolCallId, answer: dismissedAnswer(kind, kind === "ask" ? "Next topic?" : QUIZ_INPUT.question) },
			}),
		}),
		{ params: Promise.resolve({ id: chatId }) },
	);
}

function createConfiguredChat(title: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveTree(chat.id, {
		nodes: [
			{ id: "planet-order", title: "Planet order" },
			{ id: "genealogy", title: "Genealogy of religion" },
			{ id: "indexicals", title: "Indexical 'actual'" },
			{ id: "modal-realism", title: "Modal realism" },
		],
		edges: [],
		version: 1,
	});
	return chat;
}

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
		}
	}
});

describe("teacher chat flow (scripted model)", () => {
	it("quiz tool call persists as a pending part; the answer continues the lesson", async () => {
		const { engine, calls } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: solar system");
		createdChats.push(chat.id);

		await drainTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));

		const saved1 = chatStore.getChat(chat.id)!;
		assert.equal(saved1.messages.length, 2, "user message + assistant response persisted");
		const assistantMsg = saved1.messages[1]!;
		assert.equal(assistantMsg.role, "assistant");

		const thinking = assistantMsg.content.find((b) => b.type === "thinking");
		assert.ok(thinking && thinking.type === "thinking", "thinking block streamed + persisted");
		assert.match((thinking as { thinking?: string }).thinking!, /Probe the basics/);

		const quizCall = assistantMsg.content.find((b) => b.type === "toolCall" && b.name === "quiz");
		assert.ok(quizCall && quizCall.type === "toolCall", "quiz tool call persisted");
		assert.equal((quizCall as { id?: string }).id, "call-1");
		assert.deepEqual((quizCall as { arguments?: unknown }).arguments, QUIZ_INPUT);

		const view1 = projectView(saved1.messages);
		const reasoningPart = view1[1]!.parts.find((p) => p.type === "reasoning");
		assert.ok(reasoningPart && reasoningPart.type === "reasoning", "reasoning part projected");
		const quizPart = view1[1]!.parts.find((p) => p.type === "tool-quiz");
		assert.ok(quizPart && quizPart.type === "tool-quiz", "quiz tool part projected");
		assert.equal((quizPart as { state?: string }).state, "input-available", "unanswered quiz = pending state (resume record)");
		assert.deepEqual((quizPart as { input?: unknown }).input, QUIZ_INPUT);

		const pending = danglingQuestionOf(saved1.messages);
		assert.equal(pending?.toolCallId, "call-1");
		assert.equal(pending?.tool, "quiz");
		assert.deepEqual(pending?.input, QUIZ_INPUT);

		const answer = gradedAnswer(QUIZ_INPUT, ["Mercury"]);
		assert.equal(answer.correct, true);
		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-1", answer }), agentFactory(engine));

		const saved2 = chatStore.getChat(chat.id)!;
		assert.equal(saved2.messages.length, 4, "the answer + reaction append natively");
		assert.equal((saved2.messages[2] as { role?: string }).role, "toolResult", "the graded answer is the call's tool result");
		const view2 = projectView(saved2.messages);
		assert.equal(view2.length, 2, "the reaction continues the same assistant message (one group)");
		const finalParts = view2[1]!.parts;
		const textPart = finalParts.find((p) => p.type === "text");
		assert.ok(textPart && textPart.type === "text", "reaction text appended after the tool part");
		assert.match((textPart as { text?: string }).text!, /Mercury it is/);
		const answeredQuiz = finalParts.find((p) => p.type === "tool-quiz");
		assert.ok(answeredQuiz && answeredQuiz.type === "tool-quiz" && (answeredQuiz as { state?: string }).state === "output-available");
		const out = (answeredQuiz as { output?: { kind?: string; correct?: boolean } }).output!;
		assert.equal(out.kind, "quiz");
		assert.equal(out.correct, true);

		assert.equal(calls.length, 2, "model saw exactly two prompts");
		const toolResultSent = calls[1]!.some((c) => c.includes("toolResult") || c.includes("Mercury"));
		assert.ok(toolResultSent, "continuation prompt carries the tool result to the model");

		assert.equal(danglingQuestionOf(saved2.messages), null);
	});

	it("rejects unknown chats", async () => {
		const res = await handleChatRequest(post("chat_nonexistent", { type: "text", text: "hi" }));
		assert.equal(res.status, 404);
	});

	it("refuses malformed inputs with a clean 400 — no liveness effects, no lockout", async () => {
		const chat = createConfiguredChat("Test: malformed input");
		createdChats.push(chat.id);

		const res = await handleChatRequest(post(chat.id, { type: "text" }), agentFactory(scriptedTeacher(defaultLesson).engine));
		assert.equal(res.status, 400, "malformed input is a clean 400");
		assert.equal(isTurnRunning(chat.id), false, "the refusal never registered a turn");

		const res2 = await handleChatRequest(
			post(chat.id, { type: "answer", toolCallId: "call-none", answer: { correct: true } }),
			agentFactory(scriptedTeacher(defaultLesson).engine),
		);
		assert.equal(res2.status, 400, "an answer with no pending question call is refused");
		assert.equal(isTurnRunning(chat.id), false);

		const ok = await handleChatRequest(
			post(chat.id, { type: "text", text: "teach me" }),
			agentFactory(scriptedTeacher(defaultLesson).engine),
		);
		assert.equal(ok.status, 200);
		await drain(ok);
	});

	it("streams the toolCall partial before tool_execution_start/end (protocol pin for the 'Writing a question…' shimmer)", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: protocol pin");
		createdChats.push(chat.id);
		const body = await drainTurn(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine));
		const events = eventsOf(body);
		const callSeen = events.findIndex(
			(e) => e.type === "message_update" && JSON.stringify(e.message?.content ?? []).includes('"type":"toolCall"'),
		);
		const execStart = events.findIndex((e) => e.type === "tool_execution_start" && e.toolCallId === "call-1");
		const execEnd = events.findIndex((e) => e.type === "tool_execution_end" && e.toolCallId === "call-1");
		assert.ok(callSeen !== -1, "a message_update carries the toolCall block (the shimmer source)");
		assert.ok(execStart !== -1, "tool_execution_start present in the stream");
		assert.ok(execEnd !== -1, "tool_execution_end present in the stream");
		assert.ok(callSeen < execStart && execStart < execEnd, "partial → execution start → execution end");
		assert.equal(events[execEnd]!.isError, false, "the clean end is what mounts the dock");
	});

	it("a pump-fired wake turn never double-appends its steer (Wave B regression of the 2026-09-18 bug)", { timeout: 15000 }, async () => {
		const chat = createConfiguredChat("Test: wake single-copy");
		createdChats.push(chat.id);
		const seed = scriptedTeacher(() => [() => fauxAssistantMessage([fauxText("On it — dispatched the researcher.")])]);
		await drainTurn(post(chat.id, { type: "text", text: "research it" }), agentFactory(seed.engine));

		const wake = scriptedTeacher(() => [() => fauxAssistantMessage([fauxText("Good research — building on it.")])]);
		setTurnRunner(async (chatId, input) => {
			const res = await handleChatInput(chatId, input, agentFactory(wake.engine));
			await res.arrayBuffer().catch(() => undefined);
			return res.status;
		});

		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-1" });
		const steer = buildSubagentSteer(
			job,
			{ brief: "The Mercury answer, with sources.", sources: [{ title: "NASA", url: "https://nasa.gov" }] },
		);
		await deliverJobResult(steer);
		await waitFor(() => {
			const rec = chatStore.getChat(chat.id);
			const at = rec?.messages.findIndex((m) => (m as { id?: string }).id === steer.id) ?? -1;
			return at !== -1 && (rec!.messages[at + 1] as { role?: string } | undefined)?.role === "assistant";
		}, 8000, "the wake turn to persist (marker + response)");

		const record = chatStore.getChat(chat.id)!;
		const copies = record.messages.filter((m) => (m as { id?: string }).id === steer.id);
		assert.equal(copies.length, 1, "exactly ONE copy of the steer marker (the carried filter)");
		const at = record.messages.findIndex((m) => (m as { id?: string }).id === steer.id);
		assert.ok(at !== -1, "the marker is in the record");
		assert.equal((record.messages[at + 1] as { role?: string } | undefined)?.role, "assistant", "the wake response follows the marker");
	});

	it("Wave C steering: a mid-run result injects BETWEEN turn units — never splitting a toolCall from its toolResult", { timeout: 15000 }, async () => {
		const chat = createConfiguredChat("Test: mid-run steering");
		createdChats.push(chat.id);

		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let release2!: () => void;
		const gate2 = new Promise<void>((r) => (release2 = r));
		let jobIdMid = "";
		let jobFlippedMidTurn: string | undefined;
		const seen: string[] = [];
		const faux = createFauxCore({});
		faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage(
					[fauxToolCall("no_such_tool", { note: "x" }, { id: "call-mid" })],
					{ stopReason: "toolUse" },
				);
			},
			async (context) => {
				seen.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)).join("\n"));
				jobFlippedMidTurn = jobStore.getJob(jobIdMid)?.status;
				await gate2;
				return fauxAssistantMessage([fauxText("Folded the marker in.")]);
			},
		]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };

		let wakes = 0;
		setTurnRunner(async () => {
			wakes++;
			return 200;
		});

		const res = handleChatRequest(post(chat.id, { type: "text", text: "teach" }), agentFactory(engine));
		await waitFor(() => isTurnRunning(chat.id), 8000, "the turn is live");

		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-mid" });
		jobIdMid = job.id;
		jobStore.updateJob(job.id, { result: { brief: "Mid-run brief.", sources: [] } });
		const steer = buildSubagentSteer(job, { brief: "Mid-run brief.", sources: [] });
		const delivery = deliverJobResult(steer);
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(wakes, 0, "no wake — the live run owns the delivery");

		release();
		await new Promise((r) => setTimeout(r, 150));
		release2();
		await drain(await res);
		await delivery;
		assert.equal(jobFlippedMidTurn, "done", "the job flipped at the marker's message_end — WHILE the turn still streamed");

		const record = chatStore.getChat(chat.id)!;
		const at = (role: string, pred: (m: LhMessage) => boolean) =>
			record.messages.findIndex((m) => (m as { role?: string }).role === role && pred(m as never));
		const callAt = record.messages.findIndex(
			(m) => (m as { role?: string }).role === "assistant" &&
				JSON.stringify((m as { content?: unknown }).content).includes("call-mid"),
		);
		const resultAt = at("toolResult", (m) => (m as { toolCallId?: string }).toolCallId === "call-mid");
		const steerAt = record.messages.findIndex((m) => (m as { id?: string }).id === steer.id);
		const finalAt = at("assistant", (m) => JSON.stringify((m as { content?: unknown }).content).includes("Folded the marker in."));
		assert.ok(callAt !== -1 && resultAt !== -1 && steerAt !== -1 && finalAt !== -1, `all units present: ${callAt}/${resultAt}/${steerAt}/${finalAt}`);
		assert.ok(callAt < resultAt, "the toolCall precedes its toolResult (bonded pair)");
		assert.equal(steerAt, resultAt + 1, "the marker injected at the turn boundary — immediately after the completed unit");
		assert.ok(steerAt < finalAt, "the run CONTINUED after the injection (same run, no wake)");
		assert.equal(record.messages.filter((m) => (m as { id?: string }).id === steer.id).length, 1, "exactly one marker copy");
		assert.ok(seen[0]!.includes("Mid-run brief."), "the model SAW the marker in its next prompt");
		assert.equal(wakes, 0, "delivery rode the live run end to end");
	});

	it("the view canon HOISTS reasoning above the message text (owner ruling 2026-09-26)", () => {
		const baseMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "openrouter",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			timestamp: 1,
		};
		const trailingThink: LhMessage = {
			...baseMessage,
			id: "a_trail",
			content: [
				{ type: "text", text: "The answer text." },
				{ type: "thinking", thinking: "Checked the map afterwards." },
				{ type: "toolCall", id: "call-tr", name: "quiz", arguments: { question: "q", options: [{ label: "a" }], correctAnswer: "a", explanation: "" } },
			],
			stopReason: "toolUse",
		} as never;
		const view = projectView([{ id: "u0", role: "user", content: "hi", timestamp: 1 } as never, trailingThink]);
		assert.equal(view.length, 2);
		const parts = view[1]!.parts.filter((p) => p.type !== "step-start");
		const order = parts.map((p) => p.type);
		assert.equal(order[0], "reasoning", "reasoning renders FIRST regardless of content order");
		assert.ok(order.indexOf("text") > order.indexOf("reasoning"), "text follows the reasoning");
		assert.equal(order[order.length - 1], "tool-quiz", "the tool call stays last");
		const leadingThink: LhMessage = {
			...baseMessage,
			id: "a_lead",
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "First." }, { type: "text", text: "The answer text." }],
		} as never;
		const view2 = projectView([{ id: "u1", role: "user", content: "hi", timestamp: 1 } as never, leadingThink]);
		assert.deepEqual(view2[1]!.parts.filter((p) => p.type !== "step-start").map((p) => p.type), ["reasoning", "text"], "think-first messages project identically");
	});

	it("an arrived-but-empty STREAMING message projects the thinking row; a settled empty one stays hidden (optimistic round 3)", () => {
		const emptyArrived: LhMessage = {
			id: "a_empty",
			role: "assistant",
			content: [],
			stopReason: "stop",
		} as never;
		const live = {
			executions: new Map(),
			inFlight: true,
			streamingIds: new Set(["a_empty"]),
		} as never;
		const view = projectView([{ id: "u0", role: "user", content: "hi", timestamp: 1 } as never, emptyArrived], live);
		const parts = view[1]!.parts.filter((p) => p.type !== "step-start");
		assert.deepEqual(parts.map((p) => p.type), ["reasoning"], "empty streaming message = the thinking row");
		assert.equal(parts[0]!.text, "", "empty until the first token lands");
		const settled = projectView([{ id: "u0", role: "user", content: "hi", timestamp: 1 } as never, emptyArrived]);
		assert.equal(settled.length, 1, "a settled empty message renders nothing");
	});

	it("a cancelled view NEVER aborts the turn — it runs to completion (owner ruling 2026-09-25)", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const engine = gatedTeacher(gate);
		const chat = createConfiguredChat("Test: view cancel");
		createdChats.push(chat.id);

		const res = await handleChatRequest(post(chat.id, { type: "text", text: "hold my turn" }), agentFactory(engine));
		assert.equal(res.status, 200);
		const view = new Response(runningTurn(chat.id)!.subscribe());
		const reader = view.body!.getReader();
		await reader.read();
		await reader.cancel();
		assert.equal(isTurnRunning(chat.id), true, "cancel detached the view only — the turn runs on");
		assert.ok(runningTurn(chat.id), "the running-turn registry still holds the handle");

		release();
		await waitFor(() => !isTurnRunning(chat.id), 8000, "turn settle after view cancel");
		const saved = chatStore.getChat(chat.id)!;
		assert.equal(saved.messages.length, 2, "complete turn persisted — not a partial");
		assert.equal(runningTurn(chat.id), undefined, "handle unregistered at settle");
	});

	it("an ungradeable quiz is rejected at the call boundary, the error reaches the model, and the model retries", async () => {
		const BAD_QUIZ_INPUT = {
			question: "What is Nietzsche's genealogical claim about religion?",
			type: "check",
			nodeId: "genealogy",
			options: [{ label: "A cultural diagnosis" }, { label: "Atheism as a conclusion" }],
			correctAnswer: "cultural-diagnosis",
			explanation: "Genealogy diagnoses, it does not convert.",
		};

		const steps = (calls: string[][]): FauxResponseStep[] => [
			(context) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage(
					[fauxToolCall("quiz", BAD_QUIZ_INPUT, { id: "call-bad" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage(
					[fauxToolCall("quiz", QUIZ_INPUT, { id: "call-good" })],
					{ stopReason: "toolUse" },
				);
			},
		];
		const { engine, calls } = scriptedTeacher(steps);

		const chat = createConfiguredChat("Test: bad quiz retry");
		createdChats.push(chat.id);
		const body = await drainTurn(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine));

		const events = eventsOf(body);
		const badEnd = events.find((e) => e.type === "tool_execution_end" && e.toolCallId === "call-bad");
		assert.ok(badEnd, "the invalid call's execution end is on the wire");
		assert.equal(badEnd.isError, true, "the invalid call surfaced as an error execution");
		assert.match(String(badEnd.result?.content?.[0]?.text ?? ""), /does not match any option value/);
		const goodEnd = events.find((e) => e.type === "tool_execution_end" && e.toolCallId === "call-good");
		assert.ok(goodEnd, "the valid retry's execution end is on the wire");
		assert.equal(goodEnd.isError, false, "the valid retry's end is CLEAN — the dock mounts on it");

		assert.equal(calls.length, 2, "the invalid call triggered a second model prompt");
		assert.match(
			calls[1]!.join(" "),
			/does not match any option value/,
			"the validation error reached the model",
		);

		const saved = chatStore.getChat(chat.id)!;
		const view = projectView(saved.messages);
		const quizParts = view[1]!.parts.filter((p) => p.type === "tool-quiz");
		const failed = quizParts.find(
			(p) => p.type === "tool-quiz" && (p as { state?: string }).state === "output-error",
		);
		assert.ok(failed, "the invalid call persisted as an error-state part");
		assert.match(
			String((failed as { errorText?: string }).errorText),
			/does not match any option value/,
		);
		const pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "call-good", "the RETRIED quiz is the pending one");
		assert.deepEqual(pending?.input, QUIZ_INPUT);
	});

	it("structurally invalid quiz input (unhealable garbage) never reaches the dock and retries clean", async () => {
		const STRINGY_QUIZ_INPUT = {
			question: "Lewis's indexical analysis of 'actual' — which is it?",
			type: "check",
			nodeId: "indexicals",
			options: "definitely not a JSON array — denim all the way down",
			correctAnswer: "indexical",
			explanation: "Indexical: every world is actual to its own inhabitants.",
		};

		const steps: FauxResponseStep[] = [
			() => fauxAssistantMessage([fauxToolCall("quiz", STRINGY_QUIZ_INPUT, { id: "call-stringy" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("quiz", QUIZ_INPUT, { id: "call-clean" })], { stopReason: "toolUse" }),
		];
		const { engine } = scriptedTeacher(() => steps);

		const chat = createConfiguredChat("Test: string options");
		createdChats.push(chat.id);
		const body = await drainTurn(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine));

		const events = eventsOf(body);
		const stringyEnd = events.find((e) => e.type === "tool_execution_end" && e.toolCallId === "call-stringy");
		assert.ok(stringyEnd, "the invalid quiz's execution end is on the wire");
		assert.equal(stringyEnd.isError, true, "the structural reject surfaced as an error execution");
		assert.match(String(stringyEnd.result?.content?.[0]?.text ?? ""), /options/);

		const saved = chatStore.getChat(chat.id)!;
		const view = projectView(saved.messages);
		const failed = view[1]!.parts.find(
				(p) => (p as { toolCallId?: string }).toolCallId === "call-stringy",
			);
		assert.equal((failed as { state?: string }).state, "output-error", "persisted as an error part");
		assert.match(String((failed as { errorText?: string }).errorText), /options/);
		const pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "call-clean", "the retried quiz is the pending one");
	});

	it("parallel quiz calls are asked, saved, and answered in the model's call order", async () => {
		const QUIZ_A = { ...QUIZ_INPUT, question: "Quiz A: which planet is closest to the sun?" };
		const QUIZ_B = { ...QUIZ_INPUT, question: "Quiz B: which planet is largest?" };

		const { engine } = scriptedTeacher(() => [
			() =>
				fauxAssistantMessage(
					[fauxToolCall("quiz", QUIZ_A, { id: "call-a" }), fauxToolCall("quiz", QUIZ_B, { id: "call-b" })],
					{ stopReason: "toolUse" },
			),
		]);

		const chat = createConfiguredChat("Test: parallel quizzes");
		createdChats.push(chat.id);
		const body = await drainTurn(post(chat.id, { type: "text", text: "quiz me twice" }), agentFactory(engine));

		const events = eventsOf(body);
		const endA = events.findIndex((e) => e.type === "tool_execution_end" && e.toolCallId === "call-a" && e.isError === false);
		const endB = events.findIndex((e) => e.type === "tool_execution_end" && e.toolCallId === "call-b" && e.isError === false);
		assert.ok(endA !== -1 && endB !== -1, "both quizzes' clean ends are on the wire");
		assert.ok(endA < endB, "call A's end precedes call B's (sequential execution)");

		const saved = chatStore.getChat(chat.id)!;
		const quizIds = projectView(saved.messages)[1]!.parts
			.filter((p) => p.type === "tool-quiz")
			.map((p) => (p as { toolCallId: string }).toolCallId);
		assert.deepEqual(quizIds, ["call-a", "call-b"], "parts persisted in call order");

		const pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "call-a", "the FIRST asked question is the dock subject");
		const answered = [...saved.messages, newAnswerResult("call-a", "quiz", gradedAnswer(QUIZ_A, ["Mercury"]))];
		const next = danglingQuestionOf(answered);
		assert.equal(next?.toolCallId, "call-b", "the SECOND question becomes the dock subject only after the first is answered");
	});
});

describe("chat store", () => {
	it("round-trips and lists chats", async () => {
		const chat = chatStore.createChat("Store test");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "m1", role: "user", content: "hi", timestamp: 1 } as never]);
		const loaded = chatStore.getChat(chat.id)!;
		assert.equal(loaded.messages.length, 1);
		assert.equal(loaded.title, "Store test");
	});

	it("persist the per-chat model settings (replace-whole, no updatedAt churn)", async () => {
		const chat = chatStore.createChat("Settings test");
		createdChats.push(chat.id);
		const before = chatStore.getChat(chat.id)!.updatedAt;
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" });
		const saved = chatStore.getChat(chat.id)!;
		assert.deepEqual(saved.settings, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "high" });
		assert.equal(saved.updatedAt, before, "a picker write is not conversation activity");
		chatStore.saveSettings(chat.id, {});
		assert.deepEqual(chatStore.getChat(chat.id)!.settings, {});
	});
});

describe("mid-turn navigation (turn liveness + write-ahead)", () => {
	it("one turn per chat: a concurrent request is 409'd; the next one after finish is accepted", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: turn guard");
		createdChats.push(chat.id);

		const res1 = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		assert.equal(isTurnRunning(chat.id), true, "turn registered as in flight");
		const view1 = drainRunning(chat.id);

		const res2 = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		assert.equal(res2.status, 409, "concurrent turn rejected — last-writer-wins persist would clobber it");

		await view1;
		assert.equal(isTurnRunning(chat.id), false, "registry cleared at finish");

		const res3 = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		assert.equal(res3.status, 200, "the next turn is accepted after the previous finished");
		await drainRunning(chat.id);
	});

	it("write-ahead: the learner's answer is durable BEFORE the turn finishes", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: write-ahead");
		createdChats.push(chat.id);

		await drainTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));

		const answer = gradedAnswer(QUIZ_INPUT, ["Mercury"]);

		const res = await handleChatRequest(post(chat.id, { type: "answer", toolCallId: "call-1", answer }), agentFactory(engine));
		const midTurn = chatStore.getChat(chat.id)!;		assert.equal(midTurn.messages.length, 3, "write-ahead appended the answer tool result before finish");
		assert.equal((midTurn.messages[2] as { role?: string }).role, "toolResult");
		const midQuiz = projectView(midTurn.messages)[1]!.parts.find((p) => p.type === "tool-quiz");
		assert.ok(midQuiz && midQuiz.type === "tool-quiz");
		assert.equal((midQuiz as { state?: string }).state, "output-available", "write-ahead persisted the answer before finish");

		await drainRunning(chat.id);
		const saved2 = chatStore.getChat(chat.id)!;
		assert.equal(saved2.messages.length, 4, "full turn persisted as usual at finish");
		assert.equal(projectView(saved2.messages).length, 2, "the projection groups the answered quiz + reaction");
		assert.equal(isTurnRunning(chat.id), false, "registry cleared at finish");
	});
});

describe("renameChat (the header's click-to-edit title)", () => {
	it("persists the title and does NOT bump updatedAt — sidebar order must not churn", () => {
		const chat = chatStore.createChat("old title");
		createdChats.push(chat.id);
		const before = chatStore.getChat(chat.id)!.updatedAt;
		const renamed = chatStore.renameChat(chat.id, "  new title  ");
		assert.equal(renamed.title, "new title", "trimmed on the way in");
		assert.equal(chatStore.getChat(chat.id)!.title, "new title");
		assert.equal(
			chatStore.getChat(chat.id)!.updatedAt,
			before,
			"a rename is not conversation activity",
		);
		assert.equal(
			chatStore.listChats().find((c) => c.id === chat.id)!.title,
			"new title",
			"the sidebar list view sees it",
		);
	});

	it("falls back to Untitled session on an all-whitespace title (the honest floor)", () => {
		const chat = chatStore.createChat("keep me");
		createdChats.push(chat.id);
		const renamed = chatStore.renameChat(chat.id, "   ");
		assert.equal(renamed.title, "Untitled session");
	});
});

describe("the BYOK turn gate (no factory floor — owner, 2026-09-22)", () => {
	it("a chat with no model refuses the turn with the 503 envelope — nothing lingers", async () => {
		const chat = chatStore.createChat("Test: unconfigured chat");
		createdChats.push(chat.id);

		const expectRefusal = effectiveSettings().models.strong === null;

		const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(scriptedTeacher(defaultLesson).engine));

		if (expectRefusal) {
			assert.equal(res.status, 503, "the universal turn gate refuses before beginTurn");
			const body = (await res.json()) as { error: string; code: string; missing: string[] };
			assert.equal(body.code, "models_not_configured");
			assert.deepEqual(body.missing, ["strong"]);
			assert.match(body.error, /No model configured/);
		} else {
			assert.equal(res.status, 200, "the record's strong slot satisfies the conversation chain");
			await drainRunning(chat.id);
		}

		if (expectRefusal) {
			assert.equal(isTurnRunning(chat.id), false, "the refusal never registers a live turn");
			const saved = chatStore.getChat(chat.id)!;
			assert.equal(saved.messages.length, 0, "no write-ahead persist before the gate");
		}
	});

	it("a per-chat model alone opens the gate (the setup flow's exact write)", async () => {
		const chat = createConfiguredChat("Test: per-chat pin only");
		createdChats.push(chat.id);
		const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(scriptedTeacher(defaultLesson).engine));
		assert.equal(res.status, 200, "chat.settings.model satisfies the chain without any record slot");
		await drainRunning(chat.id);
	});
});

describe("the key-presence turn gate (provider-key interlude, 2026-09-25)", () => {
	it("a pinned provider whose key is gone refuses with 503 provider_key_missing — nothing lingers", async () => {
		const chat = chatStore.createChat("Test: keyless provider");
		createdChats.push(chat.id);
		const saved = process.env.TOGETHER_API_KEY;
		delete process.env.TOGETHER_API_KEY;
		try {
			chatStore.saveSettings(chat.id, { model: { provider: "together", id: "no-such-model" } });
			const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me something" }), agentFactory(scriptedTeacher(defaultLesson).engine));

			assert.equal(res.status, 503, "the key-presence gate refuses before beginTurn");
			const body = (await res.json()) as { error: string; code: string; provider: string; slots: string[] };
			assert.equal(body.code, "provider_key_missing");
			assert.equal(body.provider, "together", "the envelope names whose key is gone");
			assert.deepEqual(body.slots, ["strong"], "the conversation tier is the affected slot");
			assert.equal(body.error, "No Together key is set — add one in Settings → Keys", "the human line names the provider");
			assert.equal(isTurnRunning(chat.id), false, "the refusal never registers a live turn");
			assert.equal(chatStore.getChat(chat.id)!.messages.length, 0, "no write-ahead persist before the gate");
		} finally {
			if (saved !== undefined) process.env.TOGETHER_API_KEY = saved;
		}
	});

	it("an env-present key passes the gate (gate by what would run)", async () => {
		const chat = chatStore.createChat("Test: env-keyed provider");
		createdChats.push(chat.id);
		const saved = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-key-presence-gate";
		try {
			chatStore.saveSettings(chat.id, { model: { provider: "openai", id: "gpt-4" } });
			const res = await handleChatRequest(post(chat.id, { type: "text", text: "teach me something" }), agentFactory(scriptedTeacher(defaultLesson).engine));

			assert.equal(res.status, 200, "the env-shadowed key counts as present — the turn runs");
			await drainRunning(chat.id);
		} finally {
			if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
			else delete process.env.OPENAI_API_KEY;
		}
	});
});

describe("background-turn runner (owner ruling 2026-09-25: every turn is a server-side process, clients are views)", () => {
	it("CONNECTION DIET B (owner, 2026-10-10): the POST acks and closes — the response never holds the turn's stream", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const engine = gatedTeacher(gate);
		const chat = createConfiguredChat("Test: ack-and-close");
		createdChats.push(chat.id);

		const res = await handleChatRequest(post(chat.id, { type: "text", text: "hold it" }), agentFactory(engine));
		assert.equal(res.status, 200);
		const body = JSON.parse(await res.text());
		assert.deepEqual(body, { ok: true }, "the ack is a tiny JSON envelope");
		assert.equal(isTurnRunning(chat.id), true, "the turn runs on with its response closed");

		release();
		await waitFor(() => !isTurnRunning(chat.id), 8000, "turn settle");
	});

	it("subscribe mid-turn: a second view gets the FULL replay, then live, same dialect", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const engine = gatedTeacher(gate);
		const chat = createConfiguredChat("Test: reattach replay");
		createdChats.push(chat.id);

		const ack = await handleChatRequest(post(chat.id, { type: "text", text: "hold my turn" }), agentFactory(engine));
		assert.equal(ack.status, 200);
		const firstHandle = runningTurn(chat.id)!;
		const firstView = new Response(firstHandle.subscribe());
		const reader = firstView.body!.getReader();
		await reader.read();

		const handle = runningTurn(chat.id)!;
		assert.ok(handle, "the registry resolves the live turn");
		const secondText = new Response(handle.subscribe()).text();

		release();
		const text = await secondText;
		const replay = eventsOf(text);
		assert.equal(replay[0]!.type, "agent_start", "replay starts from the very first event");
		assert.ok(text.includes("Gated reply."), "replay carries the full streamed content");
		assert.ok(text.endsWith("data: [DONE]\n\n"), "live tail ends with the SSE terminal, same dialect as POST");
		assert.ok(!text.includes('"type":"error"'), "a clean turn never emits an error event");
		assert.ok(replay.some((e) => e.type === "message_end" && e.message?.stopReason === "stop"), "message_end carries the stop reason");
		const decoder = new TextDecoder();
		let firstTail = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			firstTail += decoder.decode(value, { stream: true });
		}
		assert.ok(firstTail.endsWith("data: [DONE]\n\n"), "first view closes cleanly at settle, unaffected by the reattach");
	});

	it("COMPACTION LAW (owner 2026-10-09): the log stores state, not chunks — a chunk burst coalesces to ONE update, slim wire, full content", async () => {
		const long = "quadratic blowup ".repeat(40);
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText(long)])]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const chat = createConfiguredChat("Test: compaction law");
		createdChats.push(chat.id);
		const body = await drainTurn(post(chat.id, { type: "text", text: "go" }), agentFactory(engine));
		const events = eventsOf(body);
		const updates = events.filter((e) => e.type === "message_update");
		assert.equal(updates.length, 1, "a burst of chunks coalesces to exactly one update on the wire");
		assert.ok(
			JSON.stringify(updates[0]!.message?.content ?? []).includes(long),
			"the one update is the LATEST snapshot — the full streamed text",
		);
		assert.ok(!body.includes("assistantMessageEvent"), "WIRE DIET: the duplicate partial never crosses the boundary");
		const end = events.find((e) => e.type === "message_end" && (e as { message?: { role?: string } }).message?.role === "assistant");
		assert.ok(end, "message_end present");
		assert.ok(JSON.stringify((end as { message?: { content?: unknown[] } }).message?.content ?? []).includes(long), "message_end carries the full final message (authoritative, lossless)");
		const record = chatStore.getChat(chat.id)!;
		assert.ok(JSON.stringify(record.messages).includes(long), "persistTurn wrote the settled message in full");
	});

	it("remote abort: any client can stop a running turn; the partial persists; subscribers close cleanly", async () => {
		const engine = abortableTeacher();
		const chat = createConfiguredChat("Test: remote abort");
		createdChats.push(chat.id);

		const res = await handleChatRequest(post(chat.id, { type: "text", text: "wait forever" }), agentFactory(engine));
		assert.equal(res.status, 200);
		assert.ok(runningTurn(chat.id), "turn registered while in flight");
		const viewText = new Response(runningTurn(chat.id)!.subscribe()).text();

		const outcome = abortTurn(chat.id);
		assert.deepEqual(outcome, { ok: true }, "abort resolves ok on a live turn");

		const text = await viewText;
		assert.ok(text.endsWith("data: [DONE]\n\n"), "subscriber closes cleanly at the aborted settle");

		await waitFor(() => !isTurnRunning(chat.id), 8000, "aborted turn settle");
		const saved = chatStore.getChat(chat.id)!;
		assert.ok(saved.messages.length >= 2, "the partial transcript persisted via the usual settle path");
		assert.equal(runningTurn(chat.id), undefined, "handle unregistered after the aborted settle");

		assert.deepEqual(abortTurn(chat.id), { ok: false, reason: "not_running" }, "second abort is not_running");
	});

	it("subscribe after settle: the cheap terminal tells the client the record is current", async () => {
		const { engine } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: settled terminal");
		createdChats.push(chat.id);

		const term = settledTurnResponse();
		assert.equal(await term.text(), 'data: {"type":"turn-settled"}\n\ndata: [DONE]\n\n', "terminal is one event + [DONE]");
		assert.equal(runningTurn(chat.id), undefined);

		await drainTurn(post(chat.id, { type: "text", text: "quiz me" }), agentFactory(engine));
		assert.equal(runningTurn(chat.id), undefined, "no handle survives settle");
	});

	it("concurrent two-chat reattach: two turns in flight, two views, both settle independently", async () => {
		const releaseFns: Array<() => void> = [];
		const chats = [1, 2].map((n) => {
			const gate = new Promise<void>((r) => (releaseFns.push(r)));
			const engine = gatedTeacher(gate);
			const chat = createConfiguredChat(`Test: two-chat ${n}`);
			createdChats.push(chat.id);
			return { n, engine, chat };
		});

		const views = new Map<string, Promise<string>>();
		for (const { chat, engine } of chats) {
			const res = await handleChatRequest(post(chat.id, { type: "text", text: "hold my turn" }), agentFactory(engine));
			assert.equal(res.status, 200);
			const handle = runningTurn(chat.id)!;
			assert.ok(handle, `chat ${chat.id} has its own handle`);
			views.set(chat.id, new Response(handle.subscribe()).text());
			const others = chats.filter((c) => c.chat.id !== chat.id).map((c) => runningTurn(c.chat.id));
			assert.ok(!others.includes(handle), "per-chat handles are distinct objects");
		}

		for (const release of releaseFns) release();
		for (const { chat } of chats) {
			const text = await views.get(chat.id)!;
			assert.ok(text.includes("Gated reply."), `chat ${chat.id} view replayed its own turn`);
			assert.ok(text.endsWith("data: [DONE]\n\n"), `chat ${chat.id} view closed at settle`);
			await waitFor(() => !isTurnRunning(chat.id), 8000, `chat ${chat.id} settle`);
			assert.equal(chatStore.getChat(chat.id)!.messages.length, 2, `chat ${chat.id} persisted its full turn`);
		}
	});
});

it("explain tool call persists as a pending part; the free-text answer reveals the commitment and reaches the model", async () => {
	const EXPLAIN_INPUT = {
		question: "Explain why Mercury is hard to observe.",
		correctAnswer: "Its small angular separation from the Sun — it never strays far from the Sun in our sky.",
		nodeId: "planet-order",
		type: "check",
	};
	const { engine, calls } = scriptedTeacher((cs) => [
		(context) => {
			cs.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage(
				[fauxThinking("Free recall this time."), fauxToolCall("explain", EXPLAIN_INPUT, { id: "call-1" })],
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			cs.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
			return fauxAssistantMessage([fauxText("Right — it hugs the Sun.")]);
		},
	]);
	const chat = createConfiguredChat("Test: explain mechanic");
	createdChats.push(chat.id);

	const tools = createTeacherTools(
		{ chatId: chat.id, chatStore, jobStore, spawn: () => {} },
		{ explain: true },
	);
	assert.ok(tools.explain && !tools.quiz, "explain armed, quiz dropped — one quizzing tool");

	const factory: Parameters<typeof handleChatRequest>[1] = (opts) =>
		createTeacherAgent(undefined, { engine, messages: opts.messages, tools });
	await drainTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), factory);

	const saved1 = chatStore.getChat(chat.id)!;
	const savedContent1 = (saved1.messages[1] as { content: unknown }).content as Array<{ type: string; name?: string }>;
	const call = savedContent1.find((b) => b.type === "toolCall" && b.name === "explain");
	assert.ok(call, "explain tool call persisted");

	const pending = danglingQuestionOf(saved1.messages);
	assert.equal(pending?.tool, "explain");
	assert.deepEqual(pending?.input, EXPLAIN_INPUT);

	const view1 = projectView(saved1.messages);
	assert.ok(view1[1]!.parts.some((p) => p.type === "tool-explain"), "tool-explain part projected — the dock arms");

	const qd: QuestionData = {
		id: "call-1",
		kind: "explain",
		question: EXPLAIN_INPUT.question,
		mode: "text",
		options: [],
		committedAnswer: EXPLAIN_INPUT.correctAnswer,
		createdAt: new Date().toISOString(),
	};
	const answer = buildAnswer(qd, { text: "It stays near the Sun." });
	assert.equal(answer.correct, undefined, "no client grading — the model grades");

	await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-1", answer }), factory);

	const saved2 = chatStore.getChat(chat.id)!;
	const view2 = projectView(saved2.messages);
	const part = view2[1]!.parts.find((p) => p.type === "tool-explain");
	assert.equal((part as { state?: string }).state, "output-available");
	const out = (part as { output?: { committed?: string; explanation?: string } }).output!;
	assert.equal(out.committed, EXPLAIN_INPUT.correctAnswer, "the commitment snapshots into the answer record");
	assert.equal(out.explanation, undefined, "no explanation remnant — one committed field (owner 2026-09-27)");

	const seen = calls[1]!.join("\n");
	assert.match(seen, /It stays near the Sun\./);
	assert.match(seen, /committed/);
	assert.match(seen, /small angular separation/);
	assert.ok(!/"explanation"/.test(seen), "the answer record carries no explanation field");
	assert.equal(danglingQuestionOf(saved2.messages), null, "no pending question remains");
});

describe("the silent dismissal (A2)", () => {
	it("writes the toolResult with NO wake — the next plain message carries it to the model", async () => {
		const { engine, calls } = scriptedTeacher(defaultLesson);
		const chat = createConfiguredChat("Test: silent dismissal");
		createdChats.push(chat.id);

		await drainTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		assert.ok(danglingQuestionOf(chatStore.getChat(chat.id)!.messages), "the quiz is pending");

		const res = await dismissPost(chat.id, "call-1");
		assert.equal(res.status, 200);
		const saved = chatStore.getChat(chat.id)!;
		assert.equal(danglingQuestionOf(saved.messages), null, "the call is answered by the dismissal");
		const tail = saved.messages[saved.messages.length - 1]! as { role?: string; details?: { dismissed?: boolean } };
		assert.equal(tail.role, "toolResult");
		assert.equal(tail.details?.dismissed, true, "the record's dismissal is the details payload");
		assert.equal(calls.length, 1, "NO second engine call — the dismissal woke nothing");
		assert.equal(isTurnRunning(chat.id), false);
		assert.equal(endsInDismissal(saved.messages), true, "the session sits dismissal-paused");

		await drainTurn(post(chat.id, { type: "text", text: "skip that — tell me about Mars" }), agentFactory(engine));
		assert.equal(calls.length, 2, "exactly one wake: the user's message");
		assert.match(calls[1]!.join("\n"), /dismissed/, "the dismissed result rode the wake's context");
		assert.equal(endsInDismissal(chatStore.getChat(chat.id)!.messages), false, "the pause lifted with the send");
	});

	it("rejects honestly: unknown chat 404, no dangling question 400", async () => {
		assert.equal((await dismissPost("chat_nonexistent", "call-x")).status, 404);
		const chat = createConfiguredChat("Test: dismiss no question");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "hi", timestamp: 1 } as never]);
		assert.equal((await dismissPost(chat.id, "call-x")).status, 400);
	});

	it("parallel quizzes dismiss call-by-call — the composer returns only when nothing dangles", async () => {
		const chat = createConfiguredChat("Test: parallel dismiss");
		createdChats.push(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "u1", role: "user", content: "hello", timestamp: 1 } as never,
			{
				id: "a1",
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-a", name: "quiz", arguments: { question: "A?" } as never },
					{ type: "toolCall", id: "call-b", name: "quiz", arguments: { question: "B?" } as never },
				],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
		]);

		assert.equal((await dismissPost(chat.id, "call-a")).status, 200);
		const pending = danglingQuestionOf(chatStore.getChat(chat.id)!.messages);
		assert.equal(pending?.toolCallId, "call-b", "the dock advances to the next question");
		assert.equal(endsInDismissal(chatStore.getChat(chat.id)!.messages), true);

		assert.equal((await dismissPost(chat.id, "call-b")).status, 200);
		assert.equal(danglingQuestionOf(chatStore.getChat(chat.id)!.messages), null, "the composer may return");
		assert.equal(endsInDismissal(chatStore.getChat(chat.id)!.messages), true, "paused until the user speaks");
	});
});

describe("parallel question calls: the answer defers its wake while a sibling dangles", () => {
	const ASK_INPUT = {
		question: "Which topic should this test session cover next?",
		options: [{ label: "Chemistry" }, { label: "History" }],
	};

	function parallelLesson(calls: string[][]): FauxResponseStep[] {
		return [
			(context) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage(
					[
						fauxThinking("Batch a graded and a non-graded check."),
						fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" }),
						fauxToolCall("ask_user_question", ASK_INPUT, { id: "call-2" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage([fauxText("Both answered — good.")]);
			},
		];
	}

	it("the sibling answer wakes NOTHING; the last answer fires the one turn with both results adjacent", async () => {
		const { engine, calls } = scriptedTeacher(parallelLesson);
		const chat = createConfiguredChat("Test: parallel questions");
		createdChats.push(chat.id);

		await drainTurn(post(chat.id, { type: "text", text: "ask me two questions in parallel" }), agentFactory(engine));
		let saved = chatStore.getChat(chat.id)!;
		let pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "call-1", "the dock holds the quiz first");

		const quizAns = gradedAnswer(QUIZ_INPUT, ["Mercury"]);
		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-1", answer: quizAns }), agentFactory(engine));
		assert.equal(calls.length, 1, "the sibling answer woke NOTHING (the gate deferred)");
		saved = chatStore.getChat(chat.id)!;
		assert.equal((saved.messages[2] as { toolCallId?: string }).toolCallId, "call-1", "quiz result adjacent to the batch");
		pending = danglingQuestionOf(saved.messages);
		assert.equal(pending?.toolCallId, "call-2", "the dock advances to the ask immediately — no turn ran");

		const askAns = {
			kind: "ask",
			questionText: ASK_INPUT.question,
			dontKnow: false,
			answers: [],
			text: "History",
			answeredAt: new Date().toISOString(),
		};
		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-2", answer: askAns }), agentFactory(engine));
		assert.equal(calls.length, 2, "exactly one wake: the last answer's turn");
		saved = chatStore.getChat(chat.id)!;
		assert.equal(danglingQuestionOf(saved.messages), null, "nothing dangles anymore");
		const prompt2 = calls[1]!.join("\n");
		assert.match(prompt2, /Mercury/, "the quiz result rode the wake's context");
		assert.match(prompt2, /History/, "the ask answer rode the wake's context");
		const roles = saved.messages.map((m) => (m as { role?: string }).role);
		assert.deepEqual(roles.slice(1, 5), ["assistant", "toolResult", "toolResult", "assistant"], "batch → both results → reaction");
	});
});

describe("parallel rounds: the LAST resolution decides the wake (owner ruling 2026-10-03)", () => {
	function batchLesson(calls: string[][]): FauxResponseStep[] {
		return [
			(context) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage(
					[
						fauxThinking("Batch again."),
						fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" }),
						fauxToolCall("ask_user_question", { question: "Next topic?", options: [{ label: "Chemistry" }, { label: "History" }] }, { id: "call-2" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage([fauxText("Round done.")]);
			},
		];
	}

	it("round 1 — answer then dismiss: NO wake at all (ending on a dismissal pauses)", async () => {
		const { engine, calls } = scriptedTeacher(batchLesson);
		const chat = createConfiguredChat("Test: round 1");
		createdChats.push(chat.id);
		await drainTurn(post(chat.id, { type: "text", text: "two questions please" }), agentFactory(engine));

		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-1", answer: gradedAnswer(QUIZ_INPUT, ["Mercury"]) }), agentFactory(engine));
		assert.equal(calls.length, 1, "the sibling answer deferred");

		assert.equal((await dismissPost(chat.id, "call-2", "ask")).status, 200);
		const saved = chatStore.getChat(chat.id)!;
		assert.equal(danglingQuestionOf(saved.messages), null);
		assert.equal(needsContinuation(saved.messages), false, "ending on a dismissal owes nothing");
		assert.equal(endsInDismissal(saved.messages), true, "the session sits paused");
		assert.equal(calls.length, 1, "NO wake — the agent never ran a second turn");
	});

	it("round 2 — dismiss then answer: exactly one wake carrying both results", async () => {
		const { engine, calls } = scriptedTeacher(batchLesson);
		const chat = createConfiguredChat("Test: round 2");
		createdChats.push(chat.id);
		await drainTurn(post(chat.id, { type: "text", text: "two questions please" }), agentFactory(engine));

		assert.equal((await dismissPost(chat.id, "call-1")).status, 200);
		assert.equal(calls.length, 1, "the dismissal woke nothing");

		await drainTurn(post(chat.id, { type: "answer", toolCallId: "call-2", answer: { kind: "ask", questionText: "Next topic?", dontKnow: false, answers: [], text: "Chemistry", answeredAt: new Date().toISOString() } }), agentFactory(engine));
		assert.equal(calls.length, 2, "the trailing answer fired the one wake");
		const prompt2 = calls[1]!.join("\n");
		assert.match(prompt2, /Chemistry/, "the answer rode the wake");
		assert.match(prompt2, /dismissed/, "the dismissal rode the wake too");
	});
});

describe("composer steering: POST /api/chats/[id]/steer", () => {
	const steerPost = (chatId: string, body: unknown): Promise<Response> =>
		steerRoute.POST(
			new Request(`http://test/api/chats/${chatId}/steer`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
			{ params: Promise.resolve({ id: chatId }) },
		);

	it("honest rejections: 404 unknown chat, 400 bad input, 409 when no turn is live", async () => {
		const chat = createConfiguredChat("Test: steer rejections");
		createdChats.push(chat.id);
		assert.equal((await steerPost("chat_nope", { input: { type: "steer", id: "steer_1", text: "hi" } })).status, 404);
		assert.equal((await steerPost(chat.id, { input: { type: "steer", id: "", text: "hi" } })).status, 400);
		assert.equal((await steerPost(chat.id, { input: { type: "text", text: "hi" } })).status, 400);
		assert.equal((await steerPost(chat.id, { input: { type: "steer", id: "steer_1", text: "  " } })).status, 400);
		assert.equal((await steerPost(chat.id, { input: { type: "steer", id: "steer_1", text: "hi" } })).status, 409);
	});

	it("200 + the live steering queue when a turn runs; the drain lands the card and the model sees it", async () => {
		const calls: string[][] = [];
		let release!: () => void;
		const gate = new Promise<void>((res) => {
			release = res;
		});
		const faux = createFauxCore({});
		faux.setResponses([
			async (context: { messages: unknown[] }) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				await gate;
				return fauxAssistantMessage([fauxText("Teaching the solar system…")]);
			},
			(context: { messages: unknown[] }) => {
				calls.push(context.messages.map((m) => JSON.stringify((m as { content: unknown }).content)));
				return fauxAssistantMessage([fauxText("Steered — covering Venus too.")]);
			},
		]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple };

		const chat = createConfiguredChat("Test: steer live");
		createdChats.push(chat.id);

		const turnRes = await handleChatRequest(post(chat.id, { type: "text", text: "teach me" }), agentFactory(engine as never));
		await waitFor(() => calls.length === 1, 8000, "first model call started");

		const res = await steerPost(chat.id, { input: { type: "steer", id: "steer_live1", text: "also cover Venus" } });
		assert.equal(res.status, 200);
		assert.equal((await res.json() as { ok: boolean }).ok, true);

		const viewText = drainRunning(chat.id);
		release();
		const body = await viewText;
		assert.match(body, /also cover Venus/, "the drained steer rode the live stream verbatim");

		assert.equal(calls.length, 2, "still one run — the steer continued it, not a new turn");
		assert.match(calls[1]!.join("\n"), /also cover Venus/, "the model saw the steer in its context");

		const saved = chatStore.getChat(chat.id)!;
		const roles = saved.messages.map((m) => (m as { role?: string }).role);
		assert.deepEqual(roles, ["user", "assistant", "user", "assistant"], "text → teaching → STEER → steered reply");
		const steerMsg = saved.messages[2] as { id?: string; content?: unknown };
		assert.equal(steerMsg.id, "steer_live1", "the client-minted id survived to the record");
		assert.equal(steerMsg.content, "also cover Venus");
	});
});

describe("duplicate provider tool-call ids (the Lacan fix)", () => {
	it("every `call_0` turn keeps its identity: ask answered as ask, quiz as quiz, ids unique in the record", async () => {
		const ASK = { question: "What do you want from Lacan?" };
		const QUIZ2 = { ...QUIZ_INPUT, type: "check" };
		const { engine } = scriptedTeacher(() => [
			(context) => {
				void context;
				return fauxAssistantMessage(
					[fauxText("First — a question about your goal."), fauxToolCall("ask_user_question", ASK, { id: "call_0" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				void context;
				return fauxAssistantMessage(
					[fauxText("The unconscious, then."), fauxToolCall("quiz", QUIZ2, { id: "call_0" })],
					{ stopReason: "toolUse" },
				);
			},
			() => fauxAssistantMessage([fauxText("Right — and that is where Lacan begins.")]),
		]);

		const chat = createConfiguredChat("Lacan: duplicate call_0 turns");
		createdChats.push(chat.id);
		await drainTurn(post(chat.id, { type: "text", text: "teach me Lacan" }), agentFactory(engine));
		let saved = chatStore.getChat(chat.id)!;
		let pending = danglingQuestionOf(saved.messages)!;
		assert.equal(pending.tool, "ask_user_question");
		const askId = pending.toolCallId;
		await drainTurn(post(chat.id, { type: "answer", toolCallId: askId, answer: { kind: "ask", questionText: ASK.question, dontKnow: false, answers: [], text: "The theory core", answeredAt: new Date().toISOString() }, }), agentFactory(engine));

		saved = chatStore.getChat(chat.id)!;
		pending = danglingQuestionOf(saved.messages)!;
		assert.equal(pending.tool, "quiz");
		const quizId = pending.toolCallId;
		assert.notEqual(quizId, askId, "the uniquifier reminted the colliding id at the wire boundary");
		assert.match(quizId, /^call_0~\d+$/, "mint scheme: orig~n");
		await drainTurn(post(chat.id, { type: "answer", toolCallId: quizId, answer: gradedAnswer(QUIZ2, ["Mercury"]) }), agentFactory(engine));

		saved = chatStore.getChat(chat.id)!;
		const callIds = saved.messages.flatMap(
			(m) =>
				m.role === "assistant"
					? (m.content ?? []).filter((c) => c.type === "toolCall").map((c) => c.id)
					: [],
		);
		assert.equal(new Set(callIds).size, callIds.length, "no duplicate tool-call ids persist");
		assert.deepEqual(callIds, ["call_0", "call_0~2"], "the provider's two call_0s became distinct ids");

		const view = projectView(saved.messages);
		const parts = view.flatMap((v) => v.parts).filter((p) => p.type.startsWith("tool-"));
		const askPart = parts.find((p) => (p as { toolCallId?: string }).toolCallId === askId) as { state?: string; output?: { kind?: string } };
		const quizPart = parts.find((p) => (p as { toolCallId?: string }).toolCallId === quizId) as { state?: string; output?: { kind?: string } };
		assert.equal(askPart?.state, "output-available");
		assert.equal(askPart?.output?.kind, "ask", "the ask card keeps its own answer");
		assert.equal(quizPart?.state, "output-available");
		assert.equal(quizPart?.output?.kind, "quiz", "the quiz card got ITS answer (the pre-fix bug: it landed on the ask card)");
	});
});
