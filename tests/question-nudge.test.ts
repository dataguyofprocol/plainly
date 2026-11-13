import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { rejectBareCheck } from "../src/agent/teacher-agent.ts";
import { bareCheckRejectionText, QUESTION_NUDGE_TEXT } from "../src/core/contracts/chat.ts";
import {
	bareStopReply,
	newAnswerResult,
	newQuestionNudge,
	nativeInputCause,
	questionNudgeStale,
	teacherTextSinceLearner,
	type LhMessage,
} from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";

const CHECK = {
	type: "check",
	nodeId: "event-routing",
	question: "Who receives the release event?",
	options: [{ label: "Both", value: "both" }, { label: "Only testing", value: "testing" }],
	correctAnswer: "both",
	explanation: "Delivery follows the Thread's subscriptions.",
};

let n = 0;
function assistant(content: Parameters<typeof fauxAssistantMessage>[0], stopReason: "stop" | "toolUse" = "stop"): AssistantMessage & { id: string } {
	return { ...fauxAssistantMessage(content, { stopReason }), id: `a${++n}` };
}
function user(text: string): LhMessage {
	return { id: `u${++n}`, role: "user", content: text, timestamp: n };
}
function answered(toolCallId: string): LhMessage {
	return newAnswerResult(toolCallId, "quiz", {
		kind: "quiz",
		questionText: "q",
		answers: [{ index: 1, label: "Both" }],
		dontKnow: false,
		answeredAt: new Date().toISOString(),
		correct: false,
	});
}
function guard(messages: LhMessage[], current: AssistantMessage, args: unknown = CHECK, tool = "quiz") {
	const toolCall = current.content.find((b) => b.type === "toolCall")!;
	return rejectBareCheck({
		assistantMessage: current,
		toolCall: { ...toolCall, name: tool } as BeforeToolCallContext["toolCall"],
		args,
		context: { messages: [...messages, current] as unknown as AgentMessage[] },
	});
}

describe("bare check rejection (backlog item 12)", () => {
	// Shape of chat_mvzeum7r_cd4ad8f1 messages 59–61: a repair in prose,
	// the learner's "got it!", then a check with no text.
	const repair = assistant([fauxText("The Router does not need to choose one subscriber.")]);
	const history: LhMessage[] = [repair, user("got it!")];

	it("rejects a check posed with no text since the learner's message", async () => {
		const bare = assistant([fauxThinking("next check"), fauxToolCall("quiz", CHECK, { id: "c61" })], "toolUse");
		assert.deepEqual(await guard(history, bare), { block: true, reason: bareCheckRejectionText("quiz") });
		assert.match(bareCheckRejectionText("quiz"), /call quiz again\.$/);
	});

	it("names explain in the rejection for an explain check", async () => {
		const bare = assistant([fauxToolCall("explain", CHECK, { id: "e1" })], "toolUse");
		assert.deepEqual(await guard(history, bare, CHECK, "explain"), { block: true, reason: bareCheckRejectionText("explain") });
		assert.match(bareCheckRejectionText("explain"), /call explain again\.$/);
	});

	it("passes a check led by text in the same message (message 53's shape)", async () => {
		const led = assistant([fauxText("The boundary matters when…"), fauxToolCall("quiz", CHECK, { id: "c53" })], "toolUse");
		assert.equal(await guard(history, led), undefined);
	});

	it("passes a check whose text came earlier in the same turn, before another tool", async () => {
		const taught = assistant([fauxText("Here is the step."), fauxToolCall("pdf", { path: "x.pdf" }, { id: "t1" })], "toolUse");
		const toolResult = { id: "r1", role: "toolResult", toolCallId: "t1", toolName: "pdf", content: [{ type: "text", text: "queued" }], isError: false, timestamp: 1 } as LhMessage;
		const bare = assistant([fauxToolCall("quiz", CHECK, { id: "c2" })], "toolUse");
		assert.equal(await guard([...history, taught, toolResult], bare), undefined);
	});

	it("stops at a graded answer: text before the learner's answer does not count", async () => {
		const asked = assistant([fauxText("Teaching."), fauxToolCall("quiz", CHECK, { id: "c58" })], "toolUse");
		const bare = assistant([fauxToolCall("quiz", CHECK, { id: "c59" })], "toolUse");
		assert.equal((await guard([asked, answered("c58")], bare))?.block, true);
	});

	it("never rejects a predict, or a non-question tool", async () => {
		const predict = assistant([fauxToolCall("quiz", { ...CHECK, type: "predict" }, { id: "p1" })], "toolUse");
		assert.equal(await guard(history, predict, { ...CHECK, type: "predict" }), undefined);
		const other = assistant([fauxToolCall("pdf", { path: "x.pdf" }, { id: "x1" })], "toolUse");
		assert.equal(await guard(history, other, { path: "x.pdf" }, "pdf"), undefined);
	});

	it("treats a missing type as a check", async () => {
		const { type: _type, ...untyped } = CHECK;
		const bare = assistant([fauxToolCall("quiz", untyped, { id: "c3" })], "toolUse");
		assert.equal((await guard(history, bare, untyped))?.block, true);
	});

	it("teacherTextSinceLearner ignores whitespace-only text", () => {
		const blank = assistant([fauxText("  \n"), fauxToolCall("quiz", CHECK, { id: "c4" })], "toolUse");
		assert.equal(teacherTextSinceLearner([user("go")] as unknown as AgentMessage[], blank), false);
	});
});

describe("question nudge (backlog item 10)", () => {
	it("bareStopReply flags a prose-only teaching reply", () => {
		const reply = assistant([fauxText("A subscription records a delivery relationship.")]);
		const messages = [user("go"), reply];
		assert.equal(bareStopReply(messages, [reply])?.id, reply.id);
	});

	it("bareStopReply ignores a turn that ends on a question", () => {
		const asked = assistant([fauxText("Teaching."), fauxToolCall("quiz", CHECK, { id: "q1" })], "toolUse");
		assert.equal(bareStopReply([user("go"), asked], [asked]), null);
	});

	it("bareStopReply ignores the plan-presenting turn", () => {
		const plan = assistant([fauxToolCall("plan_init", { mermaid: "graph TD" }, { id: "pl1" })], "toolUse");
		const planResult = { id: "pr1", role: "toolResult", toolCallId: "pl1", toolName: "plan_init", content: [{ type: "text", text: "{}" }], isError: false, timestamp: 1 } as LhMessage;
		const present = assistant([fauxText("Here is the plan.")]);
		assert.equal(bareStopReply([user("go"), plan, planResult, present], [plan, planResult, present]), null);
	});

	it("bareStopReply ignores errored and length-cut replies", () => {
		const cut = { ...assistant([fauxText("half")]), stopReason: "length" as const };
		assert.equal(bareStopReply([user("go"), cut], [cut]), null);
	});

	it("the nudge is one per bare stop, model-only, automatic, and goes stale once anything follows", () => {
		const reply = assistant([fauxText("Prose only.")]);
		const nudge = newQuestionNudge("chat_x", reply.id);
		assert.equal(nudge.id, `nudge_${reply.id}`);
		assert.equal(nudge.content, QUESTION_NUDGE_TEXT);
		assert.equal(nativeInputCause(nudge as unknown as AgentMessage, []), "automatic");
		assert.equal(questionNudgeStale(nudge, [user("go"), reply]), false);
		assert.equal(questionNudgeStale(nudge, [user("go"), reply, user("got it!")]), true);
		assert.deepEqual(projectView([user("go"), reply, nudge]).map((m) => m.role), ["user", "assistant"], "renders nothing");
	});
});
