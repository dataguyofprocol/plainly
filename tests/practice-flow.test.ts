import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseFactory,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createPracticeAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { activeProblemOf, needsContinuation } from "../src/core/index.ts";
import { PATHS } from "../config.ts";
import { CONCLUDE_ACK_TEXT } from "../src/core/contracts/chat.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const POSE = {
	statement: "Prove that every finite group of prime order is cyclic.",
	mode: "recall",
	target: ["group-order"],
	modelSolution: "Let |G| = p. Any x ≠ e generates a subgroup whose order divides p…",
} as const;

const CONCLUDE = {
	outcome: "solved",
	verdict: "The subgroup-order argument is credited in full.",
	rung: null,
	missClass: null,
	retest: false,
} as const;

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
		}
	}
});

function createPracticeChat(title: string) {
	const chat = chatStore.createChat(title, "practice");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	createdChats.push(chat.id);
	return chat;
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
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
	if (!handle) return "";
	return new Response(handle.subscribe()).text();
}

function practiceFactory(chatId: string, engine: PiEngine): Parameters<typeof handleChatRequest>[1] {
	return (opts) => createPracticeAgent({ chatId, chatStore }, { engine, messages: opts.messages });
}

function scripted(steps: FauxResponseStep[]): { engine: PiEngine; calls: string[] } {
	const calls: string[] = [];
	const faux = createFauxCore({});
	const wrap = (step: FauxResponseStep) =>
		async (context: TranscriptContext): Promise<AssistantMessage> => {
			calls.push(
				context.messages.map((m) => JSON.stringify((m as { content?: unknown }).content)).join("\n"),
			);
			return typeof step === "function"
				? await (step as FauxResponseFactory)(context, undefined, undefined as never, undefined as never)
				: step;
		};
	faux.setResponses(steps.map(wrap));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

const lastSaw = (calls: string[], needle: string) => calls[calls.length - 1]!.includes(needle);

describe("practice flow (scripted model)", () => {
	it("pose → thinking commit → conclude + reveal; the pose ack persists and owes nothing", async () => {
		const chat = createPracticeChat("Test: practice groups");
		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-p1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("conclude", CONCLUDE, { id: "call-c1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Clean proof. Ready for the next one?")]),
		]);
		const factory = practiceFactory(chat.id, engine);

		await drainTurn(post(chat.id, { type: "text", text: "practice group theory" }), factory);
		const afterPose = chatStore.getChat(chat.id)!.messages;
		const ack = afterPose[afterPose.length - 1] as LhMessage & ToolResultMessage;
		assert.equal(ack.role, "toolResult");
		assert.equal(ack.toolName, "problem");
		assert.equal(ack.isError, false);
		assert.equal(needsContinuation(afterPose), false);
		assert.equal(activeProblemOf(afterPose)?.toolCallId, "call-p1");

		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-p1", text: "|G|=p; ⟨x⟩ has order dividing p" }), factory);
		assert.ok(lastSaw(calls, "Your thinking:"), "the conclude turn's prompt carries the thinking");
		const afterConclude = chatStore.getChat(chat.id)!.messages;
		const concludeAck = afterConclude.find(
			(m) => (m as ToolResultMessage).role === "toolResult" && (m as ToolResultMessage).toolName === "conclude",
		) as LhMessage & ToolResultMessage;
		assert.ok(concludeAck, "the conclude ack persisted");
		assert.ok((concludeAck.content[0] as { text: string }).text.includes("END YOUR TURN"));
		assert.ok(afterConclude.some((m) => (m as { role?: string }).role === "assistant" && JSON.stringify((m as { content?: unknown }).content).includes("Clean proof.")));
		assert.equal(activeProblemOf(afterConclude), null);
	});

	it("a working-trace submission keeps the problem active", async () => {
		const chat = createPracticeChat("Test: practice nudge");
		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-p2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("R0: reread the subgroup constraint.")]),
		]);
		const factory = practiceFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-p2", text: "stuck at the second step" }), factory);
		assert.ok(lastSaw(calls, "Your thinking:"), "the turn's prompt carries the thinking");
		assert.equal(activeProblemOf(chatStore.getChat(chat.id)!.messages)?.toolCallId, "call-p2");
	});

	it("Esc dismissal marks silently; the next input rides the synthesized conclude pair", async () => {
		const chat = createPracticeChat("Test: practice dismiss");
		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-p3" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Dropped. Something else, then.")]),
		]);
		const factory = practiceFactory(chat.id, engine);
		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);

		const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");
		const dismissRes = await dismissRoute.POST(
			new Request(`http://test/api/chats/${chat.id}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input: { type: "dismiss-problem", problemCallId: "call-p3" } }),
			}),
			{ params: Promise.resolve({ id: chat.id }) },
		);
		assert.equal(dismissRes.status, 200);
		const marked = chatStore.getChat(chat.id)!.messages;
		assert.equal(activeProblemOf(marked), null, "the marker deactivates at Esc time");

		await drainTurn(post(chat.id, { type: "text", text: "something easier" }), factory);
		const msgs = chatStore.getChat(chat.id)!.messages;
		const synth = msgs.find(
			(m) => (m as ToolResultMessage).role === "toolResult" && (m as ToolResultMessage).toolName === "conclude",
		) as (LhMessage & ToolResultMessage) | undefined;
		assert.ok(synth, "the synthesized conclude result persisted");
		assert.ok(
			(synth.content[0] as { text: string }).text.includes(CONCLUDE_ACK_TEXT),
			"the pair carries the shared conclude ack text",
		);
		assert.ok(lastSaw(calls, "dismissed"), "the model saw the dismissed outcome");
	});
});
