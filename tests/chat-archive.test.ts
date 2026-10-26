/**
 * ARCHIVE (owner, 2026-10-26: one uniform flow — old sessions stay for
 * resumption, the learner archives what they're done with). Pins the
 * store's flag (round-trip, unarchive deletes the field, updatedAt never
 * moves, chats-changed announces), the list summary carrying it, and the
 * PUT route's body rules. Runs under an isolated LH_DATA_DIR (the seam is
 * set before any config-loading import, so app imports are dynamic).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-archive-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { subscribe } = await import("../src/core/events.ts");
const route = await import("../app/api/chats/[id]/route.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const put = (id: string, body: unknown) =>
	route.PUT(
		new Request(`http://localhost/api/chats/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		{ params: Promise.resolve({ id }) },
	);

describe("chatStore.setArchived", () => {
	it("archives and restores; unarchive deletes the field; updatedAt never moves", () => {
		const chat = chatStore.createChat("Archive fixture");
		const before = chatStore.getChat(chat.id)!.updatedAt;

		assert.equal(chatStore.setArchived(chat.id, true).archived, true);
		assert.equal(chatStore.getChat(chat.id)!.archived, true);
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, before, "archiving is not activity");

		chatStore.setArchived(chat.id, false);
		const restored = chatStore.getChat(chat.id)!;
		assert.ok(!("archived" in restored), "unarchive removes the field, never writes false");
		assert.equal(restored.updatedAt, before);
	});

	it("announces chats-changed (a list-shape write)", () => {
		const chat = chatStore.createChat("Archive event fixture");
		let announces = 0;
		const off = subscribe((e) => {
			if (e.type === "chats-changed") announces++;
		});
		chatStore.setArchived(chat.id, true);
		off();
		assert.equal(announces, 1);
	});

	it("the list summary carries the flag", () => {
		const chat = chatStore.createChat("Archive summary fixture");
		chatStore.setArchived(chat.id, true);
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id)?.archived, true);
	});

	it("an unknown id throws", () => {
		assert.throws(() => chatStore.setArchived("chat_never_existed", true));
	});
});

describe("PUT /api/chats/[id] — archive", () => {
	it("archives and restores", async () => {
		const chat = chatStore.createChat("Route archive fixture");
		const res = await put(chat.id, { archived: true });
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { title: "Route archive fixture", archived: true });
		const back = await put(chat.id, { archived: false });
		assert.deepEqual(await back.json(), { title: "Route archive fixture", archived: false });
	});

	it("a rename alone still works and leaves the flag alone", async () => {
		const chat = chatStore.createChat("Route rename fixture");
		chatStore.setArchived(chat.id, true);
		const res = await put(chat.id, { title: "  Renamed  " });
		assert.deepEqual(await res.json(), { title: "Renamed", archived: true });
	});

	it("rejects a body with neither field, a non-boolean archived, or an empty title", async () => {
		const chat = chatStore.createChat("Route validation fixture");
		assert.equal((await put(chat.id, {})).status, 400);
		assert.equal((await put(chat.id, { archived: "yes" })).status, 400);
		assert.equal((await put(chat.id, { title: "   " })).status, 400);
		assert.equal((await put(chat.id, { title: "", archived: true })).status, 400, "an invalid title fails the whole write");
		assert.ok(!("archived" in chatStore.getChat(chat.id)!), "nothing was written on a 400");
	});

	it("404 for an unknown session", async () => {
		assert.equal((await put("chat_never_existed", { archived: true })).status, 404);
	});
});
