import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-dismissal-park-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { applyParkedDismissal, parkDismissal, takeParkedDismissal } = await import(
	"../src/server/dismissal-park.ts"
);
const { beginTurn, endTurn, isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { subscribe } = await import("../src/core/events.ts");
const {
	activeProblemOf,
	answeredCallIds,
	danglingQuestionOf,
	dismissedAnswer,
} = await import("../src/core/index.ts");
const newMessageId = (await import("../src/core/native-messages.ts")).newMessageId;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function chatWithDanglingQuiz(id: string): string {
	const chat = chatStore.createChat("park: dangling quiz");
	chatStore.saveMessages(chat.id, [{
		id: newMessageId(),
		role: "assistant",
		content: [
			{ type: "text", text: "Quick check:" },
			{
				type: "toolCall",
				id: `${id}-q1`,
				name: "quiz",
				arguments: { question: "What is a cyclic group?" },
			},
		],
	} as never]);
	return chat.id;
}

function chatWithActiveProblem(): string {
	const chat = chatStore.createChat("park: active problem");
	const assistant = {
		id: newMessageId(),
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call-prob-1",
				name: "problem",
				arguments: { statement: "Prove |G|=p ⇒ cyclic", mode: "recall" },
			},
		],
	} as never;
	chatStore.saveMessages(chat.id, [assistant]);
	return chat.id;
}

describe("the park registry", () => {
	it("parks and takes (take drains — the second read is null)", () => {
		parkDismissal("chat_x", { type: "dismiss-problem", problemCallId: "p" });
		assert.deepEqual(takeParkedDismissal("chat_x"), { type: "dismiss-problem", problemCallId: "p" });
		assert.equal(takeParkedDismissal("chat_x"), null);
	});

	it("apply with nothing parked is a no-op (no write, no emit)", () => {
		const chat = chatWithDanglingQuiz("noop");
		const before = chatStore.getChat(chat)!.messages.length;
		let emitted = 0;
		const off = subscribe((e) => {
			if (e.type === "record-changed" && e.chatId === chat) emitted++;
		});
		applyParkedDismissal(chatStore, chat);
		off();
		assert.equal(emitted, 0);
		assert.equal(chatStore.getChat(chat)!.messages.length, before);
	});
});

describe("applyParkedDismissal — against real records", () => {
	it("applies a parked question dismissal to the dangling quiz call", () => {
		const chat = chatWithDanglingQuiz("apply-q");
		const pending = danglingQuestionOf(chatStore.getChat(chat)!.messages);
		assert.ok(pending);
		parkDismissal(chat, {
			type: "dismiss",
			toolCallId: pending!.toolCallId,
			answer: dismissedAnswer("quiz", "What is a cyclic group?"),
		});
		let emitted = 0;
		const off = subscribe((e) => {
			if (e.type === "record-changed" && e.chatId === chat) emitted++;
		});
		applyParkedDismissal(chatStore, chat);
		off();
		assert.equal(emitted, 1);
		assert.equal(danglingQuestionOf(chatStore.getChat(chat)!.messages), null);
		assert.ok(answeredCallIds(chatStore.getChat(chat)!.messages).has(pending!.toolCallId));
		assert.equal(takeParkedDismissal(chat), null);
	});

	it("applies a parked problem dismissal to the active problem", () => {
		const chat = chatWithActiveProblem();
		parkDismissal(chat, { type: "dismiss-problem", problemCallId: "call-prob-1" });
		applyParkedDismissal(chatStore, chat);
		assert.equal(activeProblemOf(chatStore.getChat(chat)!.messages), null);
	});

	it("drops a park that targets nothing (never materialized — silence)", () => {
		const chat = chatWithDanglingQuiz("drop");
		const before = chatStore.getChat(chat)!.messages.length;
		parkDismissal(chat, { type: "dismiss-problem", problemCallId: "call-ghost" });
		let emitted = 0;
		const off = subscribe((e) => {
			if (e.type === "record-changed" && e.chatId === chat) emitted++;
		});
		applyParkedDismissal(chatStore, chat);
		off();
		assert.equal(emitted, 0);
		assert.equal(chatStore.getChat(chat)!.messages.length, before);
		assert.equal(takeParkedDismissal(chat), null);
	});
});

describe("the dismiss route — the park contract (202)", () => {
	it("parks (202) while a turn runs; the settle apply lands the dismissal", async () => {
		const chat = chatWithDanglingQuiz("route");
		const pending = danglingQuestionOf(chatStore.getChat(chat)!.messages);
		assert.ok(pending);
		const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");

		assert.ok(!isTurnRunning(chat));
		beginTurn(chat);
		const res = await dismissRoute.POST(
			new Request(`http://test/api/chats/${chat}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					input: {
						type: "dismiss",
						toolCallId: pending!.toolCallId,
						answer: dismissedAnswer("quiz", "What is a cyclic group?"),
					},
				}),
			}),
			{ params: Promise.resolve({ id: chat }) },
		);
		assert.equal(res.status, 202);
		assert.deepEqual(await res.json(), { ok: true, parked: true });
		assert.ok(danglingQuestionOf(chatStore.getChat(chat)!.messages));

		applyParkedDismissal(chatStore, chat);
		endTurn(chat);
		assert.equal(danglingQuestionOf(chatStore.getChat(chat)!.messages), null);
		assert.equal(takeParkedDismissal(chat), null);
	});

	it("still refuses honestly (400) with no turn and nothing dangling", async () => {
		const chat = chatStore.createChat("park: nothing dangling").id;
		const dismissRoute = await import("../app/api/chats/[id]/dismiss/route.ts");
		const res = await dismissRoute.POST(
			new Request(`http://test/api/chats/${chat}/dismiss`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					input: { type: "dismiss", toolCallId: "call-nowhere", answer: dismissedAnswer("quiz", "?") },
				}),
			}),
			{ params: Promise.resolve({ id: chat }) },
		);
		assert.equal(res.status, 400);
	});
});
