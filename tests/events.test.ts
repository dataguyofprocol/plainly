import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emit, subscribe, type ServerEvent } from "../src/core/events.ts";
import { eventsResponse } from "../src/server/events-stream.ts";

describe("event bus", () => {
	it("delivers typed events with their payload to every subscriber", () => {
		const got: ServerEvent[] = [];
		const off = subscribe((e) => got.push(e));
		emit("turn-started", { chatId: "chat_a" });
		emit("jobs-changed", { chatId: "chat_a" });
		emit("activity-changed", {});
		off();
		assert.deepEqual(got, [
			{ type: "turn-started", chatId: "chat_a" },
			{ type: "jobs-changed", chatId: "chat_a" },
			{ type: "activity-changed" },
		]);
	});

	it("unsubscribe stops delivery, exactly once", () => {
		let calls = 0;
		const off = subscribe(() => calls++);
		emit("chats-changed", {});
		off();
		emit("chats-changed", {});
		assert.equal(calls, 1);
	});

	it("one listener throwing NEVER breaks the others (error isolation)", () => {
		const got: string[] = [];
		subscribe(() => {
			throw new Error("listener bug");
		});
		const off = subscribe((e) => got.push(e.type));
		emit("turn-settled", { chatId: "chat_b" });
		off();
		assert.deepEqual(got, ["turn-settled"]);
	});

	it("emit with zero subscribers is a silent no-op", () => {
		assert.doesNotThrow(() => emit("chats-changed", {}));
	});

	it("the registry is globalThis-backed — the Next multi-entry law (turn-liveness discipline)", () => {
		const g = globalThis as { __lhEventBus?: unknown };
		assert.ok(g.__lhEventBus instanceof Set, "the bus lives on globalThis");
	});

	it("an unsubscribe DURING emit is safe (snapshot iteration)", () => {
		const got: string[] = [];
		let off2: () => void = () => {};
		const off1 = subscribe(() => off2());
		off2 = subscribe((e) => got.push(e.type));
		emit("chats-changed", {});
		off1();
		off2();
		assert.deepEqual(got, ["chats-changed"], "listener 2 still got THIS event (snapshot), no crash");
	});
});

function decode(chunk: Uint8Array): string {
	return new TextDecoder().decode(chunk);
}

describe("eventsResponse (the SSE seam)", () => {
	it("holds an SSE response: event frames as they are emitted", async () => {
		const res = eventsResponse();
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("Content-Type"), "text/event-stream");
		assert.equal(res.headers.get("Cache-Control"), "no-cache, no-transform");
		assert.equal(res.headers.get("X-Accel-Buffering"), "no");
		const reader = res.body!.getReader();
		emit("turn-started", { chatId: "chat_x" });
		const { value, done } = await reader.read();
		assert.equal(done, false);
		assert.equal(
			decode(value!),
			'event: turn-started\ndata: {"chatId":"chat_x"}\n\n',
			"one parseable SSE frame: type on the event line, payload on the data line",
		);
		await reader.cancel();
	});

	it("cancel() unsubscribes — later emits reach OTHER windows only", async () => {
		const first = eventsResponse();
		const second = eventsResponse();
		const r1 = first.body!.getReader();
		const r2 = second.body!.getReader();
		await r1.cancel();
		emit("turn-settled", { chatId: "chat_y" });
		const { value } = await r2.read();
		assert.match(decode(value!), /event: turn-settled/);
		const after = await r1.read();
		assert.equal(after.done, true, "the cancelled connection carries nothing further");
		await r2.cancel();
	});

	it("the connection ends WITHOUT a [DONE] sentinel — the client owns the lifetime", async () => {
		const res = eventsResponse();
		const reader = res.body!.getReader();
		emit("turn-settled", { chatId: "chat_z" });
		await reader.read();
		emit("chats-changed", {});
		const { value, done } = await reader.read();
		assert.equal(done, false, "the channel survives every event");
		assert.match(decode(value!), /event: chats-changed/);
		await reader.cancel();
	});
});
